-- ============================================================
-- SHELF — Supabase PostgreSQL Schema
-- Run this in your Supabase SQL editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── Users ────────────────────────────────────────────────────────────────────
create table public.users (
  id            uuid primary key default uuid_generate_v4(),
  username      text unique not null check (length(username) >= 2 and length(username) <= 30),
  email         text unique not null,
  password_hash text not null,
  display_name  text,
  avatar_url    text,
  bio           text,
  is_private    boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─── Libraries ────────────────────────────────────────────────────────────────
-- One per type per user — enforced by unique constraint
create table public.libraries (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.users(id) on delete cascade,
  type       text not null check (type in ('books', 'films', 'music', 'games')),
  is_public  boolean default true,
  created_at timestamptz default now(),

  -- Core rule: max 1 library per type per user
  unique (user_id, type)
);

create index idx_libraries_user_id on public.libraries(user_id);

-- ─── Library Items ────────────────────────────────────────────────────────────
create table public.library_items (
  id           uuid primary key default uuid_generate_v4(),
  library_id   uuid not null references public.libraries(id) on delete cascade,
  title        text not null,
  subtitle     text,                          -- artist / author / studio
  year         int,
  cover_color  text,                          -- hex accent for placeholder cover
  cover_url    text,                          -- optional uploaded/fetched image
  rating       numeric(3,1) check (rating >= 0 and rating <= 10),
  status       text default 'collected'       -- collected | in_progress | wishlist
               check (status in ('collected', 'in_progress', 'wishlist')),
  metadata     jsonb default '{}',            -- flexible: platform, genre, label…
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index idx_items_library_id on public.library_items(library_id);
create index idx_items_title      on public.library_items using gin(to_tsvector('english', title));

-- ─── Follows ──────────────────────────────────────────────────────────────────
create table public.follows (
  follower_id  uuid not null references public.users(id) on delete cascade,
  following_id uuid not null references public.users(id) on delete cascade,
  created_at   timestamptz default now(),
  primary key (follower_id, following_id)
);

create index idx_follows_following on public.follows(following_id);

-- ─── Likes (items) ────────────────────────────────────────────────────────────
create table public.item_likes (
  user_id    uuid not null references public.users(id) on delete cascade,
  item_id    uuid not null references public.library_items(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, item_id)
);

-- ─── Activity Feed View ───────────────────────────────────────────────────────
-- Denormalised view for feed queries — items added by followed users
create view public.activity_feed as
  select
    li.id,
    li.title,
    li.subtitle,
    li.year,
    li.cover_color,
    li.created_at,
    l.type   as library_type,
    u.id     as actor_id,
    u.username,
    u.avatar_url,
    f.follower_id as viewer_id
  from public.library_items li
  join public.libraries l on l.id = li.library_id
  join public.users u     on u.id = l.user_id
  join public.follows f   on f.following_id = u.id
  where l.is_public = true
  order by li.created_at desc;

-- ─── Stats View ───────────────────────────────────────────────────────────────
create view public.user_stats as
  select
    u.id,
    u.username,
    count(distinct l.id)  as library_count,
    count(distinct li.id) as item_count,
    count(distinct f1.follower_id) as followers,
    count(distinct f2.following_id) as following
  from public.users u
  left join public.libraries l      on l.user_id = u.id
  left join public.library_items li on li.library_id = l.id
  left join public.follows f1       on f1.following_id = u.id
  left join public.follows f2       on f2.follower_id = u.id
  group by u.id, u.username;

-- ─── Auto-update updated_at ───────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_users_updated_at
  before update on public.users
  for each row execute procedure public.set_updated_at();

create trigger trg_items_updated_at
  before update on public.library_items
  for each row execute procedure public.set_updated_at();

-- ─── Row-Level Security ───────────────────────────────────────────────────────
alter table public.users         enable row level security;
alter table public.libraries     enable row level security;
alter table public.library_items enable row level security;
alter table public.follows       enable row level security;
alter table public.item_likes    enable row level security;

-- Users: readable by all, writable by self
create policy "users_select" on public.users for select using (true);
create policy "users_update" on public.users for update using (auth.uid() = id);

-- Libraries: public ones readable by all; owner can do everything
create policy "libs_select_public" on public.libraries
  for select using (is_public = true or auth.uid() = user_id);
create policy "libs_insert" on public.libraries
  for insert with check (auth.uid() = user_id);
create policy "libs_update" on public.libraries
  for update using (auth.uid() = user_id);
create policy "libs_delete" on public.libraries
  for delete using (auth.uid() = user_id);

-- Library items: inherit from parent library visibility
create policy "items_select" on public.library_items
  for select using (
    exists (
      select 1 from public.libraries l
      where l.id = library_id and (l.is_public = true or l.user_id = auth.uid())
    )
  );
create policy "items_insert" on public.library_items
  for insert with check (
    exists (select 1 from public.libraries l where l.id = library_id and l.user_id = auth.uid())
  );
create policy "items_update" on public.library_items
  for update using (
    exists (select 1 from public.libraries l where l.id = library_id and l.user_id = auth.uid())
  );
create policy "items_delete" on public.library_items
  for delete using (
    exists (select 1 from public.libraries l where l.id = library_id and l.user_id = auth.uid())
  );

-- Follows
create policy "follows_select" on public.follows for select using (true);
create policy "follows_insert" on public.follows for insert with check (auth.uid() = follower_id);
create policy "follows_delete" on public.follows for delete using (auth.uid() = follower_id);

-- ─── Seed: demo user ─────────────────────────────────────────────────────────
-- (optional — remove before production)
insert into public.users (username, email, password_hash, display_name)
values ('demo', 'demo@shelf.app', 'not-a-real-hash', 'Demo User')
on conflict do nothing;

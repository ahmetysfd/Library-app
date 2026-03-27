-- ============================================================
-- SHELF — Supabase PostgreSQL Schema (v2)
-- Run this in your Supabase SQL editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── Users ────────────────────────────────────────────────────────────────────
create table if not exists public.users (
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

create index if not exists idx_users_username on public.users(username);
create index if not exists idx_users_email    on public.users(email);

-- Legacy cached_albums (Last.fm) removed — use Spotify artist discography only.
-- drop table if exists public.cached_albums cascade;

-- ─── Cached Artists (Spotify data — top 2000 worldwide) ─────────────────────
-- Seeded from Spotify API: 100 seed artists → "Related Artists" expansion → 2000+
-- Each row: ~300 bytes. 2000 artists = ~600KB. Tiny.
create table if not exists public.cached_artists (
  id            text primary key,                    -- Spotify artist ID
  name          text not null,
  followers     integer default 0,                   -- Spotify follower count
  popularity    smallint default 0,                  -- Spotify 0-100 score
  genres        text[] default '{}',                 -- Genre array from Spotify
  primary_genre text default 'other',                -- Mapped to our genre categories
  image_url     text,                                -- Spotify CDN photo (~120 bytes)
  fetched_at    timestamptz default now()
);

create index if not exists idx_artists_pop on public.cached_artists(popularity desc);
create index if not exists idx_artists_followers on public.cached_artists(followers desc);
create index if not exists idx_artists_genre on public.cached_artists(primary_genre);
create index if not exists idx_artists_genre_pop on public.cached_artists(primary_genre, followers desc);

-- ─── Libraries ────────────────────────────────────────────────────────────────
-- One per type per user — enforced by unique constraint
create table if not exists public.libraries (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.users(id) on delete cascade,
  type       text not null check (type in ('books', 'films', 'music', 'games')),
  is_public  boolean default true,
  created_at timestamptz default now(),

  unique (user_id, type)
);

create index if not exists idx_libraries_user_id on public.libraries(user_id);

-- ─── Library Items ────────────────────────────────────────────────────────────
create table if not exists public.library_items (
  id           uuid primary key default uuid_generate_v4(),
  library_id   uuid not null references public.libraries(id) on delete cascade,
  ext_id       text,                              -- external API id (TMDB, IGDB, etc.)
  title        text not null,
  subtitle     text,                              -- artist / author / studio / year
  year         int,
  cover_url    text,
  cover_color  text,                              -- hex accent for placeholder cover
  rating       numeric(3,1) check (rating >= 0 and rating <= 10),
  status       text default 'collected'
               check (status in ('collected', 'in_progress', 'wishlist')),
  metadata     jsonb default '{}',                -- flexible: platform, genre, vote_average…
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists idx_items_library_id on public.library_items(library_id);
create index if not exists idx_items_ext_id     on public.library_items(ext_id);
create index if not exists idx_items_status     on public.library_items(status);
create index if not exists idx_items_title      on public.library_items using gin(to_tsvector('english', title));

-- ─── Friend Requests ─────────────────────────────────────────────────────────
-- Bidirectional friendship via requests (pending → accepted → friends)
create table if not exists public.friend_requests (
  id           uuid primary key default uuid_generate_v4(),
  sender_id    uuid not null references public.users(id) on delete cascade,
  receiver_id  uuid not null references public.users(id) on delete cascade,
  status       text default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  
  unique (sender_id, receiver_id)
);

create index if not exists idx_fr_sender   on public.friend_requests(sender_id);
create index if not exists idx_fr_receiver on public.friend_requests(receiver_id);

-- ─── Follows (one-directional, for activity feed) ────────────────────────────
create table if not exists public.follows (
  follower_id  uuid not null references public.users(id) on delete cascade,
  following_id uuid not null references public.users(id) on delete cascade,
  created_at   timestamptz default now(),
  primary key (follower_id, following_id)
);

create index if not exists idx_follows_following on public.follows(following_id);

-- ─── Likes (items) ───────────────────────────────────────────────────────────
create table if not exists public.item_likes (
  user_id    uuid not null references public.users(id) on delete cascade,
  item_id    uuid not null references public.library_items(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, item_id)
);

-- ─── Friends View ────────────────────────────────────────────────────────────
-- Returns accepted friendships for a user (both directions)
create or replace view public.user_friends as
  select 
    fr.sender_id as user_id,
    fr.receiver_id as friend_id,
    u.username as friend_username,
    u.avatar_url as friend_avatar,
    u.display_name as friend_display_name,
    fr.created_at
  from public.friend_requests fr
  join public.users u on u.id = fr.receiver_id
  where fr.status = 'accepted'
  union all
  select 
    fr.receiver_id as user_id,
    fr.sender_id as friend_id,
    u.username as friend_username,
    u.avatar_url as friend_avatar,
    u.display_name as friend_display_name,
    fr.created_at
  from public.friend_requests fr
  join public.users u on u.id = fr.sender_id
  where fr.status = 'accepted';

-- ─── Activity Feed View ──────────────────────────────────────────────────────
-- Items added by friends (via accepted friend requests)
create or replace view public.activity_feed as
  select
    li.id,
    li.title,
    li.subtitle,
    li.year,
    li.cover_url,
    li.cover_color,
    li.status as item_status,
    li.created_at,
    l.type   as library_type,
    u.id     as actor_id,
    u.username,
    u.avatar_url,
    uf.user_id as viewer_id
  from public.library_items li
  join public.libraries l on l.id = li.library_id
  join public.users u     on u.id = l.user_id
  join public.user_friends uf on uf.friend_id = u.id
  where l.is_public = true
  order by li.created_at desc;

-- ─── Stats View ──────────────────────────────────────────────────────────────
create or replace view public.user_stats as
  select
    u.id,
    u.username,
    count(distinct l.id)  as library_count,
    count(distinct li.id) as item_count,
    (select count(*) from public.user_friends uf where uf.user_id = u.id) as friend_count
  from public.users u
  left join public.libraries l      on l.user_id = u.id
  left join public.library_items li on li.library_id = l.id
  group by u.id, u.username;

-- ─── Auto-update updated_at ─────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_users_updated_at
  before update on public.users
  for each row execute procedure public.set_updated_at();

create trigger trg_items_updated_at
  before update on public.library_items
  for each row execute procedure public.set_updated_at();

create trigger trg_fr_updated_at
  before update on public.friend_requests
  for each row execute procedure public.set_updated_at();

-- ─── Row-Level Security ─────────────────────────────────────────────────────
alter table public.users           enable row level security;
alter table public.libraries       enable row level security;
alter table public.library_items   enable row level security;
alter table public.follows         enable row level security;
alter table public.item_likes      enable row level security;
alter table public.friend_requests enable row level security;

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

-- Friend requests: involved parties can read; sender can create/delete
create policy "fr_select" on public.friend_requests
  for select using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "fr_insert" on public.friend_requests
  for insert with check (auth.uid() = sender_id);
create policy "fr_update" on public.friend_requests
  for update using (auth.uid() = receiver_id); -- only receiver can accept/reject
create policy "fr_delete" on public.friend_requests
  for delete using (auth.uid() = sender_id or auth.uid() = receiver_id);

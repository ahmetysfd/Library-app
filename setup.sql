-- ============================================================
-- SHELF — Complete Supabase Setup (safe to run multiple times)
-- Copy-paste this ENTIRE file into Supabase SQL Editor → Run
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── 1. Users ────────────────────────────────────────────────────────────────
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

-- ─── 2. Legacy album cache removed (browse was Last.fm). Albums → Spotify artist API only.
--     Run once in SQL Editor if you still have the old table:
--     drop table if exists public.cached_albums cascade;

-- ─── 2b. Cached Artists (Spotify data — top 2000 worldwide) ──────────────────
create table if not exists public.cached_artists (
  id            text primary key,
  name          text not null,
  followers     integer default 0,
  popularity    smallint default 0,
  genres        text[] default '{}',
  primary_genre text default 'other',
  image_url     text,
  fetched_at    timestamptz default now()
);

create index if not exists idx_artists_pop on public.cached_artists(popularity desc);
create index if not exists idx_artists_followers on public.cached_artists(followers desc);
create index if not exists idx_artists_genre on public.cached_artists(primary_genre);
create index if not exists idx_artists_genre_pop on public.cached_artists(primary_genre, followers desc);

-- ─── 2c. Cached Games (SteamSpy data — top games worldwide) ─────────────────
create table if not exists public.cached_games (
  id              text primary key,
  appid           integer not null,
  title           text not null,
  cover_url       text,
  header_url      text,
  genres          text[] default '{}',
  owners          integer default 0,
  positive_ratio  smallint default 0,
  total_reviews   integer default 0,
  price           numeric(6,2) default 0,
  fetched_at      timestamptz default now()
);

-- Upgrades for older cached_games (must run BEFORE indexes on these columns)
alter table public.cached_games add column if not exists header_url text;
alter table public.cached_games add column if not exists positive_ratio smallint default 0;
alter table public.cached_games add column if not exists total_reviews integer default 0;
alter table public.cached_games add column if not exists price numeric(6,2) default 0;

-- Legacy schema used "score" for review % — copy into positive_ratio (dynamic SQL so missing "score" never errors)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cached_games' and column_name = 'score'
  ) then
    execute $mig$
      update public.cached_games g
      set positive_ratio = coalesce(nullif(g.positive_ratio, 0)::integer, g.score::integer)::smallint
      where g.score is not null and (g.positive_ratio is null or g.positive_ratio = 0)
    $mig$;
  end if;
end $$;

drop index if exists idx_games_rating;

create index if not exists idx_games_owners on public.cached_games(owners desc);
create index if not exists idx_games_rating on public.cached_games(positive_ratio desc);
create index if not exists idx_games_genres on public.cached_games using gin(genres);

-- ─── 2d. Cached Spotify albums (Top 500 — scored from track popularity + artist) ─
create table if not exists public.cached_spotify_albums (
  id                text primary key,
  title             text not null,
  artist_id         text not null,
  artist_name       text not null,
  artist_popularity smallint default 0,
  release_date      text,
  cover_url         text,
  genres            text[] default '{}',
  primary_genre     text default 'other',
  popularity_score  smallint default 0,
  track_pop_avg     smallint default 0,
  track_sample_n    integer default 0,
  spotify_url       text,
  fetched_at        timestamptz default now()
);

create index if not exists idx_spotify_albums_score on public.cached_spotify_albums(popularity_score desc);
create index if not exists idx_spotify_albums_genre on public.cached_spotify_albums(primary_genre);
create index if not exists idx_spotify_albums_date on public.cached_spotify_albums(release_date desc);

-- PostgREST / service_role must be able to read-write this cache (avoid 42501 permission denied)
grant select on table public.cached_spotify_albums to anon, authenticated, service_role;
grant insert, update, delete on table public.cached_spotify_albums to service_role;
alter table public.cached_spotify_albums disable row level security;

-- ─── 3. Libraries ────────────────────────────────────────────────────────────
create table if not exists public.libraries (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.users(id) on delete cascade,
  type       text not null check (type in ('books', 'films', 'music', 'games')),
  is_public  boolean default true,
  created_at timestamptz default now(),
  unique (user_id, type)
);

create index if not exists idx_libraries_user_id on public.libraries(user_id);

-- ─── 4. Library Items ────────────────────────────────────────────────────────
create table if not exists public.library_items (
  id           uuid primary key default uuid_generate_v4(),
  library_id   uuid not null references public.libraries(id) on delete cascade,
  ext_id       text,
  title        text not null,
  subtitle     text,
  year         int,
  cover_url    text,
  cover_color  text,
  rating       numeric(3,1) check (rating >= 0 and rating <= 10),
  status       text default 'collected' check (status in ('collected', 'in_progress', 'wishlist')),
  metadata     jsonb default '{}',
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists idx_items_library_id on public.library_items(library_id);
create index if not exists idx_items_ext_id     on public.library_items(ext_id);
create index if not exists idx_items_status     on public.library_items(status);
create index if not exists idx_items_title      on public.library_items using gin(to_tsvector('english', title));

-- ─── 5. Friend Requests ─────────────────────────────────────────────────────
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

-- ─── 6. Follows ─────────────────────────────────────────────────────────────
create table if not exists public.follows (
  follower_id  uuid not null references public.users(id) on delete cascade,
  following_id uuid not null references public.users(id) on delete cascade,
  created_at   timestamptz default now(),
  primary key (follower_id, following_id)
);

create index if not exists idx_follows_following on public.follows(following_id);

-- ─── 7. Item Likes ──────────────────────────────────────────────────────────
create table if not exists public.item_likes (
  user_id    uuid not null references public.users(id) on delete cascade,
  item_id    uuid not null references public.library_items(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, item_id)
);

-- ─── 8. Views ───────────────────────────────────────────────────────────────
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

-- ─── 9. Auto-update triggers ────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- Drop and recreate triggers safely
drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
  before update on public.users
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_items_updated_at on public.library_items;
create trigger trg_items_updated_at
  before update on public.library_items
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_fr_updated_at on public.friend_requests;
create trigger trg_fr_updated_at
  before update on public.friend_requests
  for each row execute procedure public.set_updated_at();

-- ─── 10. Row-Level Security ─────────────────────────────────────────────────
alter table public.users           enable row level security;
alter table public.libraries       enable row level security;
alter table public.library_items   enable row level security;
alter table public.follows         enable row level security;
alter table public.item_likes      enable row level security;
alter table public.friend_requests enable row level security;
-- Drop existing policies first (safe if they don't exist)
drop policy if exists "users_select" on public.users;
drop policy if exists "users_update" on public.users;
drop policy if exists "libs_select_public" on public.libraries;
drop policy if exists "libs_insert" on public.libraries;
drop policy if exists "libs_update" on public.libraries;
drop policy if exists "libs_delete" on public.libraries;
drop policy if exists "items_select" on public.library_items;
drop policy if exists "items_insert" on public.library_items;
drop policy if exists "items_update" on public.library_items;
drop policy if exists "items_delete" on public.library_items;
drop policy if exists "follows_select" on public.follows;
drop policy if exists "follows_insert" on public.follows;
drop policy if exists "follows_delete" on public.follows;
drop policy if exists "fr_select" on public.friend_requests;
drop policy if exists "fr_insert" on public.friend_requests;
drop policy if exists "fr_update" on public.friend_requests;
drop policy if exists "fr_delete" on public.friend_requests;

-- Recreate policies
create policy "users_select" on public.users for select using (true);
create policy "users_update" on public.users for update using (auth.uid() = id);

create policy "libs_select_public" on public.libraries
  for select using (is_public = true or auth.uid() = user_id);
create policy "libs_insert" on public.libraries
  for insert with check (auth.uid() = user_id);
create policy "libs_update" on public.libraries
  for update using (auth.uid() = user_id);
create policy "libs_delete" on public.libraries
  for delete using (auth.uid() = user_id);

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

create policy "follows_select" on public.follows for select using (true);
create policy "follows_insert" on public.follows for insert with check (auth.uid() = follower_id);
create policy "follows_delete" on public.follows for delete using (auth.uid() = follower_id);

create policy "fr_select" on public.friend_requests
  for select using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "fr_insert" on public.friend_requests
  for insert with check (auth.uid() = sender_id);
create policy "fr_update" on public.friend_requests
  for update using (auth.uid() = receiver_id);
create policy "fr_delete" on public.friend_requests
  for delete using (auth.uid() = sender_id or auth.uid() = receiver_id);

-- ─── Drop legacy Last.fm album cache (no longer used) ───────────────────────
drop table if exists public.cached_albums cascade;

-- ============================================================
-- DONE! You should see "Success. No rows returned."
-- 
-- Tables: users, cached_artists, cached_games, libraries, library_items,
--         friend_requests, follows, item_likes
--
-- Views: user_friends, activity_feed, user_stats
--
-- Next: add TMDB + Spotify + Supabase keys to .env, run node server.js,
--       seed artists POST /api/artists/seed, then albums POST /api/albums/top/seed,
--       seed games POST /api/games/seed for Browse / Top Games.
-- ============================================================

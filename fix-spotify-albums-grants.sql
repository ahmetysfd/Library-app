-- Run once in Supabase SQL Editor if /api/albums/top/browse returns 403/500/503 or
-- "permission denied for table cached_spotify_albums" (Postgres 42501).

grant select on table public.cached_spotify_albums to anon, authenticated, service_role;
grant insert, update, delete on table public.cached_spotify_albums to service_role;
-- Broader grant; safe for a server-side cache table only your backend should write to.
grant all privileges on table public.cached_spotify_albums to service_role;

alter table public.cached_spotify_albums disable row level security;

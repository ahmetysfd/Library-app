-- Run once in Supabase SQL Editor if /api/albums/top/browse returns 403 or "permission denied for table cached_spotify_albums"

grant select on table public.cached_spotify_albums to anon, authenticated, service_role;
grant insert, update, delete on table public.cached_spotify_albums to service_role;
alter table public.cached_spotify_albums disable row level security;

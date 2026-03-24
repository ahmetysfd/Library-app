-- Run once in Supabase SQL Editor if seed returns: permission denied for table cached_artists
-- Fixes privileges for PostgREST (service_role used by server.js).

grant usage on schema public to service_role;
grant all on table public.cached_artists to service_role;
grant all on table public.cached_artists to postgres;

-- Optional: allow read from browser/anon later (not required for Node server)
grant select on table public.cached_artists to anon, authenticated;

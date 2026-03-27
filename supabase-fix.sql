-- Optional one-time helpers for Supabase.
-- Legacy: album_genre_counts() referenced removed cached_albums — drop if present.
drop function if exists public.album_genre_counts();

grant usage on schema public to service_role;

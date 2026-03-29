-- One-time cleanup: Top 500 Albums feature removed from the app.
-- Run in Supabase SQL Editor if you previously created cached_top_albums.

drop table if exists public.cached_top_albums;

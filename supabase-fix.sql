-- Run this once in Supabase SQL Editor.
-- It fixes write permissions for cached_albums and ensures stats RPC exists.

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.cached_albums to service_role;

create or replace function public.album_genre_counts()
returns table(genre text, total bigint)
language sql
security definer
set search_path = public
as $$
  select genre, count(*)::bigint as total
  from public.cached_albums
  group by genre
  order by total desc;
$$;

grant execute on function public.album_genre_counts() to anon, authenticated, service_role;

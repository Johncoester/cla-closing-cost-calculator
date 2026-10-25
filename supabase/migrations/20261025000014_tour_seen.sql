-- =====================================================================
-- CLA Quote Portal: GUIDED TOUR "seen" flag
-- Migration 14 (new file; migrations 1-13 untouched). Safe to run twice. Plain transaction.
--
-- WHAT
--   profiles.tour_seen_at timestamptz (nullable): when this person finished or skipped the first-time guided tour.
--   NULL = has not seen it yet, so the portal starts the tour automatically (once they have finished setting up their profile).
--   The only way to set it is public.mark_tour_seen(), for the CURRENT user only. It is NOT in the profile update column
--   grants (the API cannot write it directly, for yourself or anybody else), and it plays no part in profiles.is_complete.
--
-- EXISTING USERS
--   Everybody who exists when this migration first runs gets tour_seen_at = now(): nobody is forced through the tour
--   (it stays available from the "Take the tour" link). Only profiles created afterwards start with NULL and see it once.
--   The backfill runs ONLY in the run that adds the column, so running the file again never hides the tour from a new user.
-- =====================================================================

-- ---------- 1. the column (+ one-time backfill for existing profiles) ----------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'tour_seen_at') then
    alter table public.profiles add column tour_seen_at timestamptz;
    update public.profiles set tour_seen_at = now();
  end if;
end $$;
comment on column public.profiles.tour_seen_at is
  'When the person finished or skipped the first-time guided tour. NULL = not yet (the portal then starts it). Set only by public.mark_tour_seen().';

-- ---------- 2. mark_tour_seen(): the current user, once ----------
-- Idempotent: the first time wins (a replay of the tour never moves the date). A disabled or unknown user is refused.
create or replace function public.mark_tour_seen()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_active() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.profiles set tour_seen_at = coalesce(tour_seen_at, now()) where id = auth.uid();
end $$;
revoke execute on function public.mark_tour_seen() from public, anon;
grant  execute on function public.mark_tour_seen() to authenticated;

-- ---------- 3. profile column grants ----------
-- Deliberately unchanged: tour_seen_at is not in "grant update (first_name, ...)" from migrations 2 and 5,
-- and a column added later gets no grant, so the API can read it (select) but never write it.

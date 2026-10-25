-- =====================================================================
-- CLA Quote Portal: 30 day auto-delete (scheduled purge job)
-- Migration 4 of 4.   [SUPABASE] pg_cron
--
-- Rule: a quote is deleted 30 days after creation (quotes.expires_at,
-- set by trigger private.quotes_set_expiry()). Two layers:
--   1. RLS hides any quote whose expires_at has passed, immediately.
--   2. This job physically deletes expired rows every night.
--
-- pg_cron on Supabase: enable under Database > Extensions (or the SQL below).
-- The job runs inside the database as the postgres role. Job history is in
-- cron.job_run_details. To change the time, re-run cron.schedule with the same
-- job name (it updates in place). To pause: select cron.unschedule('purge-expired-quotes');
--
-- Platform-neutral alternative (RDS Postgres): pg_cron is available on RDS too;
-- otherwise call  select private.purge_expired_quotes();  from EventBridge +
-- Lambda or any cron.
-- =====================================================================

create or replace function private.purge_expired_quotes() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with gone as (delete from public.quotes where expires_at <= now() returning 1)
  select count(*) into n from gone;
  if n > 0 then
    insert into public.audit_log (actor_id, action, target_type, details)
    values (null, 'quotes_purged', 'quote', jsonb_build_object('count', n, 'rule', 'expires_at <= now() (30 days after creation)'));
  end if;
  return n;
end $$;
-- only the job (postgres) and service_role may call it directly
revoke execute on function private.purge_expired_quotes() from public, anon, authenticated;
grant  execute on function private.purge_expired_quotes() to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- 03:15 UTC daily (11:15 PM Eastern in summer, 10:15 PM in winter)
    perform cron.schedule('purge-expired-quotes', '15 3 * * *', $job$select private.purge_expired_quotes()$job$);
  else
    raise notice 'pg_cron is not available here. Quotes are still hidden by RLS after 30 days; schedule select private.purge_expired_quotes() with another scheduler.';
  end if;
end $$;

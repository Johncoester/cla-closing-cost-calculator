-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-21 applied, with the seed data) gets migration 22
-- (Upload CLA fees) on top, as one plain transaction, and again. Nothing existing changes, the calculator
-- still gets an empty overlay (= the fee sheet for every state), and an upload -> approve round trip works.
-- Loaded by run-tests.sh into a fresh database after migrations 1-21 and seed.sql.
-- =====================================================================
\set ON_ERROR_STOP on
create schema if not exists tests;
create table tests.r (n serial, name text, ok boolean, got text);
create or replace function tests.is(name text, got text, want text) returns void language plpgsql as $$
begin
  insert into tests.r (name, ok, got) values (name, got = want, got);
  if got = want then raise notice 'PASS  %', name; else raise warning 'FAIL  % (got %, wanted %)', name, got, want; end if;
end $$;
create or replace function tests.id(k text) returns uuid language sql as $$ select ('00000000-0000-4000-8000-0000000000' || k)::uuid $$;
create or replace function tests.v(uid uuid, sql text) returns text language plpgsql as $$
declare res text;
begin
  if uid is null then perform set_config('request.jwt.claims', '', true); perform set_config('role', 'anon', true);
  else perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
       perform set_config('role', 'authenticated', true); end if;
  begin execute sql into res; exception when others then res := 'ERR:' || sqlstate; end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return coalesce(res, 'null');
end $$;

create table tests.before as
  select (select count(*) from public.audit_log) audits, (select count(*) from public.profiles) profiles,
         (select count(*) from public.invitations) invitations, (select count(*) from public.pricing_table_fees) pricing;
select tests.is('before: no fee upload tables', (select count(*)::text from information_schema.tables where table_schema = 'public' and table_name like 'cla_fee%'), '0');
\i :migration22
\i :migration22
select tests.is('after (twice): audit rows, profiles, invitations and rep pricing unchanged; three new tables',
  (select (audits = (select count(*) from public.audit_log) and profiles = (select count(*) from public.profiles)
    and invitations = (select count(*) from public.invitations) and pricing = (select count(*) from public.pricing_table_fees))::text from tests.before) || '/' ||
  (select count(*)::text from information_schema.tables where table_schema = 'public' and table_name like 'cla_fee%'), 'true/3');
select tests.is('after: the public calculator gets an empty overlay (every state stays on the fee sheet)',
  tests.v(null, 'select public.get_cla_fees()::text'), '{"rows": [], "states": []}');
select tests.is('after: an existing audit action still validates (constraint kept every old action)',
  (select count(*)::text from public.audit_log where action not in ('invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed', 'export_run', 'profile_created', 'rep_flag_changed',
  'feedback_submitted', 'feedback_decided', 'pricing_table_changed', 'feedback_shipped', 'user_deleted', 'invite_resent', 'cla_fees_changed')), '0');
select tests.is('after: admin uploads PA, super admin approves, the calculator sees PA',
  tests.v(tests.id('a2'), $q$select (public.admin_submit_cla_fee_batch('pa.csv', '[{"state":"PA","fee_name":"Settlement Fee to CLA Title & Escrow","transaction":"Purchase","amount":"995","paid_by":"Buyer"}]'::jsonb) is not null)::text$q$) || '/' ||
  tests.v(tests.id('a1'), $q$select public.super_admin_approve_cla_fee_batch((select id from public.cla_fee_batches where status = 'pending'))::text$q$), 'true/');
select tests.is('...PA is live', tests.v(null, $q$select public.get_cla_fees()->'rows'->0->>'amount'$q$), '995.00');
do $$ declare f int; t int; begin
  select count(*) filter (where not ok), count(*) into f, t from tests.r;
  raise notice '% upgrade checks, % failed', t, f;
  if f > 0 then raise exception '% upgrade check(s) failed', f; end if;
end $$;

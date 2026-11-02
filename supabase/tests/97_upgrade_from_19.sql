-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-19 applied, with the seed data and its audit history) gets migration 20
-- (resend an invite) on top, as one plain transaction, and again. Nothing existing changes; then a resend works on the migrated data.
-- Loaded by run-tests.sh into a fresh database after migrations 1-19 and seed.sql.
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
-- first value of a query / result of a statement, run as a user ('ERR:<sqlstate>' on error)
create or replace function tests.v(uid uuid, sql text, aal text default 'aal1') returns text language plpgsql as $$
declare res text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
  perform set_config('role', 'authenticated', true);
  begin execute sql into res; exception when others then res := 'ERR:' || sqlstate; end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return coalesce(res, 'null');
end $$;
create or replace function tests.sq(q text) returns text language plpgsql as $$ declare r text; begin execute q into r; return coalesce(r, 'null'); end $$;
create or replace function tests.rpc(uid uuid, call text) returns text language sql as $$ select tests.v(uid, 'select ' || call || '::text') $$;
create or replace function tests.p(sql text) returns text language plpgsql as $$
begin execute sql; return 'ok'; exception when others then return 'ERR:' || sqlstate; end $$;

create table tests.before as select (select count(*) from public.audit_log) audits, (select count(*) from public.profiles) profiles,
  (select count(*) from public.invitations) invitations, (select string_agg(action, ',' order by action) from (select distinct action from public.audit_log) a) actions;
select tests.is('before: no resend function yet', (select count(*)::text from pg_proc where proname = 'admin_resend_invite'), '0');
\i :migration20
\i :migration20
select tests.is('after (twice): audit rows, profiles and invitations unchanged',
  (select (audits = (select count(*) from public.audit_log) and profiles = (select count(*) from public.profiles) and invitations = (select count(*) from public.invitations)
    and actions = (select string_agg(action, ',' order by action) from (select distinct action from public.audit_log) a))::text from tests.before), 'true');
select tests.is('after: no resend rows yet; every old audit action is still allowed', (select count(*)::text from private.invite_resends) || '/' ||
  tests.p($$insert into public.audit_log (actor_id, action, target_type) values (null, 'user_deleted', 'profile')$$) || '/' ||
  tests.p($$insert into public.audit_log (actor_id, action, target_type) values (null, 'invite_resent', 'profile')$$), '0/ok/ok');
select tests.is('after: the super admin can resend to a seeded person who never signed in; the status list works',
  tests.rpc(tests.id('a1'), $$public.admin_resend_invite('$$ || tests.id('c1') || $$') ->> 'resend_count'$$) || '/' ||
  tests.v(tests.id('a1'), 'select count(*)::text from public.list_invite_status()'), '1/' || (select count(*)::text from public.profiles));
do $$ declare f int; t int; begin
  select count(*) filter (where not ok), count(*) into f, t from tests.r;
  raise notice '% upgrade checks, % failed', t, f;
  if f > 0 then raise exception '% upgrade check(s) failed', f; end if;
end $$;

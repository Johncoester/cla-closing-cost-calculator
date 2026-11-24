-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-20 applied, with the seed data) gets migration 21
-- (bulk client invites + invitation name fields) on top, as one plain transaction, and again.
-- Nothing existing changes; then a named invitation and a preview work on the migrated data.
-- Loaded by run-tests.sh into a fresh database after migrations 1-20 and seed.sql.
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
create or replace function tests.rpc(uid uuid, call text) returns text language sql as $$ select tests.v(uid, 'select ' || call || '::text') $$;
create or replace function tests.p(sql text) returns text language plpgsql as $$
begin execute sql; return 'ok'; exception when others then return 'ERR:' || sqlstate; end $$;

create table tests.before as
  select (select count(*) from public.audit_log) audits, (select count(*) from public.profiles) profiles,
         (select count(*) from public.invitations) invitations,
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'invitations' and column_name = 'first_name') named;
select tests.is('before: no invitation first_name yet, no preview function', (select named::text from tests.before) || '/' ||
  (select count(*)::text from pg_proc where proname = 'admin_preview_bulk_clients'), '0/0');
\i :migration21
\i :migration21
select tests.is('after (twice): audit rows, profiles and invitations unchanged; first_name column exists',
  (select (audits = (select count(*) from public.audit_log) and profiles = (select count(*) from public.profiles) and invitations = (select count(*) from public.invitations)
    and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'invitations' and column_name = 'first_name') = 1)::text from tests.before), 'true');
select tests.is('after: one create_invitation; preview and remaining are granted to authenticated',
  (select count(*)::text from pg_proc where proname = 'create_invitation' and pronamespace = 'public'::regnamespace) || '/' ||
  tests.rpc(tests.id('a1'), 'public.admin_bulk_invite_remaining()'), '1/50');
select tests.is('after: an admin can preview a new client against a seeded rep',
  tests.v(tests.id('a1'), $$select public.admin_preview_bulk_clients('[{"email":"upgrade.client@example.com","rep_email":"sample.rep.jane@clatitle.com","first_name":"Up"}]'::jsonb) -> 0 ->> 'status'$$), 'invite');
do $$ declare f int; t int; begin
  select count(*) filter (where not ok), count(*) into f, t from tests.r;
  raise notice '% upgrade checks, % failed', t, f;
  if f > 0 then raise exception '% upgrade check(s) failed', f; end if;
end $$;

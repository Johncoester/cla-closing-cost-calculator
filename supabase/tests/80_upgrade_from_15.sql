-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-15 applied, with data: a super admin who also reps, an admin, a rep with
-- a client, a client, feedback, audit history) gets migration 16 (per-rep special settlement fee) on top, as one plain transaction, and again.
-- Nothing existing changes; the new table starts empty (= standard fees for everyone); a repeat run changes nothing.
-- Loaded by run-tests.sh into a fresh database after migrations 1-15.
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
create or replace function tests.p(sql text) returns text language plpgsql as $$
begin execute sql; return 'ok'; exception when others then return 'ERR:' || sqlstate; end $$;

-- BEFORE (migration 15 state): super admin a1 (also a rep), admin a2, rep b1 (1 client), client c1, one feedback row
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('robin.admin@clatitle.com', 'admin', false), ('old.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false);
insert into auth.users (id, email) values (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('b1'), 'old.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', tests.id('b1'));
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote');
insert into public.feedback (user_id, role_at_submit, category, message) values (tests.id('b1'), 'rep', 'bug', 'before migration 16');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l, (select count(*) from public.feedback) f,
  (select string_agg(id::text || is_complete::text, ',' order by id) from public.profiles) comp;
select tests.is('before: no rep_fee_overrides table yet', (to_regclass('public.rep_fee_overrides') is null)::text, 'true');

-- the upgrade, as Supabase runs it: one transaction
begin;
\i :migration16
commit;
select tests.is('the table exists, is empty (= standard fees for everyone), and has RLS on',
  (select count(*)::text from public.rep_fee_overrides) || '/' || (select relrowsecurity::text from pg_class where oid = 'public.rep_fee_overrides'::regclass), '0/true');
select tests.is('nothing lost or changed: profiles, quotes, assignments, invitations, feedback, audit rows, is_complete',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments)
       and i = (select count(*) from public.invitations) and l = (select count(*) from public.audit_log) and f = (select count(*) from public.feedback)
       and comp = (select string_agg(id::text || is_complete::text, ',' order by id) from public.profiles))::text from before_counts), 'true');
select tests.is('nobody has an override: the old rep, the old rep''s client and the admin all get no rows (standard fees)',
  tests.v(tests.id('b1'), 'select count(*)::text from public.get_my_fee_overrides()') || '/' || tests.v(tests.id('c1'), 'select count(*)::text from public.get_my_fee_overrides()') || '/' ||
  tests.v(tests.id('a2'), 'select count(*)::text from public.get_my_fee_overrides()'), '0/0/0');

-- it works on the migrated database
select tests.is('a super admin sets a fee for the old rep; the old rep and the rep''s client both see it; the admin who is not a rep does not',
  tests.v(tests.id('a1'), $$select public.admin_set_rep_fee_override('$$ || tests.id('b1') || $$', '*', 'purchase', 'buyer', 950)::text$$) || '/' ||
  tests.v(tests.id('b1'), 'select amount::text from public.get_my_fee_overrides()') || '/' || tests.v(tests.id('c1'), 'select amount::text from public.get_my_fee_overrides()') || '/' ||
  tests.v(tests.id('a2'), 'select count(*)::text from public.get_my_fee_overrides()'), '/950.00/950.00/0');

-- the file run again (safe to repeat): data kept, nothing duplicated
begin;
\i :migration16
commit;
select tests.is('a repeat run keeps the row and the audit entry, and adds nothing',
  (select count(*)::text from public.rep_fee_overrides) || '/' || (select count(*)::text from public.audit_log where action = 'rep_fee_changed'), '1/1');
select tests.is('the audit action list still accepts the older actions and the new one',
  tests.p($$insert into public.audit_log (action, target_type) values ('feedback_submitted', 'x')$$) || '/' || tests.p($$insert into public.audit_log (action, target_type) values ('rep_fee_changed', 'x')$$) || '/' ||
  tests.p($$insert into public.audit_log (action, target_type) values ('something_else', 'x')$$), 'ok/ok/ERR:23514');
select tests.is('earlier behaviour intact: staff send feedback, a client cannot',
  (case when tests.v(tests.id('b1'), $$select public.submit_feedback('bug', 'still works')::text$$) ~ '^[0-9a-f-]{36}$' then 'ok' else 'bad' end) || '/' ||
  tests.v(tests.id('c1'), $$select public.submit_feedback('bug', 'x')::text$$), 'ok/ERR:42501');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

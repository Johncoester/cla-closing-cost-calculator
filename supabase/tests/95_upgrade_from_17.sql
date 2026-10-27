-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-17 applied, with data: a super admin, an admin, reps, clients, quotes, assignments, feedback,
-- audit history) gets migration 18 (delete a user) on top, as one plain transaction, and again. Nothing existing changes; then deleting works on the migrated data.
-- Loaded by run-tests.sh into a fresh database after migrations 1-17.
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

-- BEFORE (migration 17 state): super admin a1, admin a2, reps b1 and b2 (b1 is demoted later in the story), clients c1 (Jane) and c2 (Marcus)
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('robin.admin@clatitle.com', 'admin', false), ('old.rep@clatitle.com', 'rep', true), ('second.rep@clatitle.com', 'rep', true),
  ('old.client@example.com', 'client', false), ('other.client@example.com', 'client', false);
insert into auth.users (id, email) values (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('b1'), 'old.rep@clatitle.com'),
  (tests.id('b2'), 'second.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com'), (tests.id('c2'), 'other.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id, assigned_by) values ('old.client@example.com', tests.id('b1'), tests.id('a2')), ('other.client@example.com', tests.id('b2'), tests.id('a2'));
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote'), (tests.id('c2'), 'buyer', 'other quote'), (tests.id('b1'), 'buyer', 'rep quote');
insert into public.feedback (user_id, role_at_submit, category, message) values (tests.id('b1'), 'rep', 'bug', 'old note');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l, (select count(*) from public.feedback) f;
select tests.is('before: no user_deleted action allowed yet', tests.p($$insert into public.audit_log (action, target_type) values ('user_deleted', 'x')$$), 'ERR:23514');
select tests.is('before: no delete function yet', (select count(*)::text from pg_proc where proname = 'admin_delete_user'), '0');

-- the upgrade, as Supabase runs it: one transaction
begin;
\i :migration18
commit;
select tests.is('the function exists (anon cannot run it, authenticated can); nothing lost or changed (profiles, quotes, assignments, invitations, audit rows, feedback)',
  (select count(*)::text from pg_proc where proname = 'admin_delete_user') || '/' ||
  (not has_function_privilege('anon', 'public.admin_delete_user(uuid, text, uuid)', 'execute') and has_function_privilege('authenticated', 'public.admin_delete_user(uuid, text, uuid)', 'execute'))::text || '/' ||
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments)
       and i = (select count(*) from public.invitations) and l = (select count(*) from public.audit_log) and f = (select count(*) from public.feedback))::text from before_counts), '1/true/true');
select tests.is('the audit action list takes the new action and still takes the older ones, and still refuses unknown ones',
  tests.p($$insert into public.audit_log (action, target_type) values ('user_deleted', 'x')$$) || '/' || tests.p($$insert into public.audit_log (action, target_type) values ('feedback_submitted', 'x')$$) || '/' ||
  tests.p($$insert into public.audit_log (action, target_type) values ('pricing_table_changed', 'x')$$) || '/' || tests.p($$insert into public.audit_log (action, target_type) values ('something_else', 'x')$$), 'ok/ok/ok/ERR:23514');

-- story: Jane (b1) is disabled and then turned into a client WITHOUT going through the safe path (old history row stays rep-less): the assignment row of a1's making must still not block
-- deleting the admin who made it. First delete the disabled admin a2: his assigned_by on two rows is cleared; the rows stay.
select tests.rpc(tests.id('a1'), $$public.admin_set_status('$$ || tests.id('a2') || $$', 'disabled')$$);
select tests.is('an ADMIN who made assignments can be deleted (by the super admin) once disabled; the two assignments stay with nobody as the maker, still only the 2 audit rows from when they were made',
  tests.rpc(tests.id('a1'), $$(public.admin_delete_user('$$ || tests.id('a2') || $$', 'robin.admin@clatitle.com') ->> 'role')$$) || '/' ||
  tests.sq($q$select count(*)::text from public.assignments where assigned_by is null$q$) || '/' ||
  tests.sq($q$select count(*)::text from public.audit_log where action = 'assignment_changed'$q$), 'admin/2/2');
-- a rep with a client is disabled and deleted with Marcus as successor: the client moves, the rep's own quote goes, the client's quote loses its rep id (not a dangling one)
select tests.rpc(tests.id('a1'), $$public.admin_set_status('$$ || tests.id('b1') || $$', 'disabled')$$);
select tests.is('a rep is deleted with a successor: client moved to Marcus, the rep''s own quote gone, the client''s quote has rep_id null (nothing dangling), feedback kept without a person',
  tests.rpc(tests.id('a1'), $$(public.admin_delete_user('$$ || tests.id('b1') || $$', 'old.rep@clatitle.com', '$$ || tests.id('b2') || $$') ->> 'clients_moved')$$) || '/' ||
  tests.sq($q$select count(*)::text from public.assignments where client_email = 'old.client@example.com' and active and rep_id = '$q$ || tests.id('b2') || $q$'$q$) || '/' ||
  tests.sq($q$select count(*)::text from public.quotes where label = 'rep quote'$q$) || '/' ||
  tests.sq($q$select (rep_id is null)::text from public.quotes where label = 'old quote'$q$) || '/' ||
  tests.sq($q$select count(*)::text from public.quotes q where rep_id is not null and not exists (select 1 from public.profiles p where p.id = q.rep_id)$q$) || '/' ||
  tests.sq($q$select count(*)::text from public.feedback where message = 'old note' and user_id is null$q$), '1/1/0/true/0/1');
select tests.is('the unrelated client and their quote and rep are untouched; two real user_deleted audit rows (+1 test row inserted above)',
  tests.sq($q$select count(*)::text from public.quotes where label = 'other quote' and rep_id = '$q$ || tests.id('b2') || $q$'$q$) || '/' ||
  tests.sq($q$select count(*)::text from public.audit_log where action = 'user_deleted'$q$), '1/3');

-- the file run again (safe to repeat): nothing changes
begin;
\i :migration18
commit;
select tests.is('a repeat run changes nothing (people, quotes, user_deleted rows)',
  (select count(*)::text from public.profiles) || '/' || (select count(*)::text from public.quotes) || '/' || (select count(*)::text from public.audit_log where action = 'user_deleted'), '4/2/3');
select tests.is('earlier behaviour intact: the last active super admin cannot be disabled, an admin still cannot disable a super admin',
  tests.rpc(tests.id('a1'), $$public.admin_set_status('$$ || tests.id('a1') || $$', 'disabled')$$) || '/' ||
  tests.rpc(tests.id('a1'), $$public.admin_delete_user('$$ || tests.id('c2') || $$', 'other.client@example.com')$$), 'ERR:42501/ERR:55000');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

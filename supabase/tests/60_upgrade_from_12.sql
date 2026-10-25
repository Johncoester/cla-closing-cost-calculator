-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-12 applied, with data: a super admin who also reps, an admin, a rep with
-- a client, a client, audit history) gets migration 13 (staff feedback) on top, as one plain transaction, and again (safe to repeat).
-- Nothing may be lost or change; staff can then send feedback, clients and guests cannot, and the older audit actions still work.
-- Loaded by run-tests.sh into a fresh database after migrations 1-12.
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




-- BEFORE (migration 12 state): super admin a1 (also a rep), admin a2, rep b1 (1 client), client c1
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('robin.admin@clatitle.com', 'admin', false), ('old.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false);
insert into auth.users (id, email) values (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('b1'), 'old.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', tests.id('b1'));
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l;
select tests.is('before: no feedback table yet', (to_regclass('public.feedback') is null)::text, 'true');

-- the upgrade, as Supabase runs it: one transaction; then again (safe to repeat)
begin;
\i :migration13
commit;
begin;
\i :migration13
commit;

select tests.is('nothing lost or changed: profiles, quotes, assignments, invitations, audit rows',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments)
       and i = (select count(*) from public.invitations) and l = (select count(*) from public.audit_log))::text from before_counts), 'true');
select tests.is('roles unchanged', (select string_agg(role::text, ',' order by id) from public.profiles), 'super_admin,admin,rep,client');
select tests.is('the feedback table exists, is empty, has RLS, and only SELECT is granted to the API',
  (to_regclass('public.feedback') is not null)::text || '/' || (select count(*)::text from public.feedback) || '/' || (select relrowsecurity::text from pg_class where oid = 'public.feedback'::regclass) || '/' ||
  (has_table_privilege('authenticated', 'public.feedback', 'select') and not has_table_privilege('authenticated', 'public.feedback', 'insert') and not has_table_privilege('authenticated', 'public.feedback', 'update')
   and not has_table_privilege('authenticated', 'public.feedback', 'delete') and not has_table_privilege('anon', 'public.feedback', 'select'))::text, 'true/0/true/true');
select tests.is('one submit_feedback and one admin_set_feedback_status (no overloads); earlier RPCs untouched (one admin_set_role, 3 args)',
  (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and proname in ('submit_feedback', 'admin_set_feedback_status')) || '/' ||
  (select string_agg(pronargs::text, ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_set_role'), '2/3');
select tests.is('the older audit actions still work (role change by the old super admin) and the new ones are allowed',
  tests.v(tests.id('a1'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'client')::text$$) || '/' ||
  tests.v(tests.id('a1'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'rep')::text$$), 'ERR:55006/');   -- b1 has a client: the migration 12 rule, still in force

-- staff can send; clients and guests cannot
insert into public.feedback (user_id, role_at_submit, category, message) values (null, 'rep', 'bug', 'pre-existing row');   -- server side, e.g. imported
select tests.is('rep, admin and the old super admin send feedback',
  (case when tests.v(tests.id('b1'), $$select public.submit_feedback('bug', 'rep says hi', '/portal/rep.html?x=1')::text$$) ~ '^[0-9a-f-]{36}$' then 'ok' else 'bad' end) || '/' ||
  (case when tests.v(tests.id('a2'), $$select public.submit_feedback('idea', 'admin idea')::text$$) ~ '^[0-9a-f-]{36}$' then 'ok' else 'bad' end) || '/' ||
  (case when tests.v(tests.id('a1'), $$select public.submit_feedback('question', 'super admin question')::text$$) ~ '^[0-9a-f-]{36}$' then 'ok' else 'bad' end), 'ok/ok/ok');
select tests.is('a client and a session with no user cannot send, and read nothing (the anon role itself has no SELECT: checked above)',
  tests.v(tests.id('c1'), $$select public.submit_feedback('bug', 'x')::text$$) || '/' || tests.v(null, $$select public.submit_feedback('bug', 'x')::text$$) || '/' ||
  tests.v(tests.id('c1'), 'select count(*)::text from public.feedback') || '/' || tests.v(null, 'select count(*)::text from public.feedback'), 'ERR:42501/ERR:42501/0/0');
select tests.is('rep reads own only (1), admin and super admin read all (4)',
  tests.v(tests.id('b1'), 'select count(*)::text from public.feedback') || '/' || tests.v(tests.id('a2'), 'select count(*)::text from public.feedback') || '/' || tests.v(tests.id('a1'), 'select count(*)::text from public.feedback'), '1/4/4');
select tests.is('the page was stored as a path only', (select page_path from public.feedback where message = 'rep says hi'), '/portal/rep.html');
select tests.is('only the super admin decides', tests.v(tests.id('a2'), $$select public.admin_set_feedback_status('$$ || (select id from public.feedback where message = 'rep says hi') || $$', 'approved')::text$$) || '/' ||
  tests.v(tests.id('a1'), $$select public.admin_set_feedback_status('$$ || (select id from public.feedback where message = 'rep says hi') || $$', 'approved', 'thanks')::text$$), 'ERR:42501/');
select tests.is('...approved with the note, audited', (select status || '/' || decided_note from public.feedback where message = 'rep says hi') || '/' || (select count(*)::text from public.audit_log where action = 'feedback_decided'), 'approved/thanks/1');
select tests.is('direct writes are refused (insert / update / delete) for staff',
  tests.v(tests.id('b1'), $$with i as (insert into public.feedback (user_id, role_at_submit, category, message) values (auth.uid(), 'rep', 'bug', 'forged') returning 1) select count(*)::text from i$$) || '/' ||
  tests.v(tests.id('a1'), $$with u as (update public.feedback set status = 'approved' returning 1) select count(*)::text from u$$) || '/' ||
  tests.v(tests.id('a1'), $$with d as (delete from public.feedback returning 1) select count(*)::text from d$$), 'ERR:42501/ERR:42501/ERR:42501');
select tests.is('ten per hour: the 11th is refused', (select count(*)::text from (select tests.v(tests.id('b1'), 'select public.submit_feedback(''other'', ''n' || g || ''')::text') from generate_series(1, 9) g) t) || '/' ||
  tests.v(tests.id('b1'), $$select public.submit_feedback('other', 'eleven')::text$$), '9/ERR:54000');
select tests.is('the guard from migration 10 and the reassign rule from migration 12 still hold (only active super admin cannot be disabled)',
  tests.p('update public.profiles set status = ''disabled'' where id = ''' || tests.id('a1') || ''''), 'ERR:55000');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

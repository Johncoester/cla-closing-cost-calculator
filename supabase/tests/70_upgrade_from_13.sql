-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-13 applied, with data: a super admin who also reps, an admin, a rep with
-- a client, a client, feedback, audit history) gets migration 14 (guided tour flag) on top, as one plain transaction, and again.
-- Everybody who exists is marked as having seen the tour (nobody is forced through it); people created AFTERWARDS start unmarked,
-- also after a repeat run of the file. Nothing else changes.
-- Loaded by run-tests.sh into a fresh database after migrations 1-13.
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

-- BEFORE (migration 13 state): super admin a1 (also a rep), admin a2, rep b1 (1 client), client c1, one feedback row
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('robin.admin@clatitle.com', 'admin', false), ('old.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false);
insert into auth.users (id, email) values (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('b1'), 'old.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', tests.id('b1'));
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote');
insert into public.feedback (user_id, role_at_submit, category, message) values (tests.id('b1'), 'rep', 'bug', 'before the tour');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l, (select count(*) from public.feedback) f,
  (select string_agg(id::text || is_complete::text, ',' order by id) from public.profiles) comp;
select tests.is('before: no tour column yet', (not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'tour_seen_at'))::text, 'true');

-- the upgrade, as Supabase runs it: one transaction
begin;
\i :migration14
commit;
select tests.is('everybody who existed is marked as having seen the tour (4 of 4): nobody is forced through it',
  (select count(*) filter (where tour_seen_at is not null)::text || '/' || count(*)::text from public.profiles), '4/4');
select tests.is('nothing lost or changed by the migration: profiles, quotes, assignments, invitations, feedback, audit rows, is_complete',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments)
       and i = (select count(*) from public.invitations) and l = (select count(*) from public.audit_log) and f = (select count(*) from public.feedback)
       and comp = (select string_agg(id::text || is_complete::text, ',' order by id) from public.profiles))::text from before_counts), 'true');
create temp table seen_at as select id, tour_seen_at from public.profiles;

-- a person who joins AFTER the migration starts unmarked
insert into public.invitations (email, role, is_rep) values ('new.client@example.com', 'client', false), ('new.rep@clatitle.com', 'rep', true);
insert into auth.users (id, email) values (tests.id('c2'), 'new.client@example.com'), (tests.id('b2'), 'new.rep@clatitle.com');
select tests.is('people created after the migration start with NULL (the tour will start for them)',
  (select count(*) filter (where tour_seen_at is null)::text || '/' || count(*)::text from public.profiles), '2/6');

-- the file run again (safe to repeat): the backfill must NOT run a second time
begin;
\i :migration14
commit;
select tests.is('a repeat run does not mark the new people, and keeps the old dates',
  (select count(*) filter (where tour_seen_at is null)::text from public.profiles) || '/' ||
  (select count(*)::text from public.profiles p join seen_at s using (id) where p.tour_seen_at is distinct from s.tour_seen_at), '2/0');

select tests.is('roles unchanged', (select string_agg(role::text, ',' order by id) from public.profiles where tour_seen_at is not null), 'super_admin,admin,rep,client');

-- the RPC and the grants
select tests.is('one mark_tour_seen; anon cannot run it, authenticated can; the column is readable but not writable by the API',
  (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and proname = 'mark_tour_seen') || '/' ||
  (not has_function_privilege('anon', 'public.mark_tour_seen()', 'execute') and has_function_privilege('authenticated', 'public.mark_tour_seen()', 'execute')
   and has_column_privilege('authenticated', 'public.profiles', 'tour_seen_at', 'select') and not has_column_privilege('authenticated', 'public.profiles', 'tour_seen_at', 'update'))::text, '1/true');
select tests.is('a new person marks the tour seen', tests.v(tests.id('c2'), 'select public.mark_tour_seen()::text'), '');
select tests.is('...only their own row changed (c2 marked, the new rep b2 still unmarked)',
  (select string_agg(id::text, ',') from public.profiles where tour_seen_at is null), tests.id('b2')::text);
create temp table c2_date as select tour_seen_at from public.profiles where id = tests.id('c2');
select tests.is('...and a replay does not move it', tests.v(tests.id('c2'), 'select public.mark_tour_seen()::text'), '');
select tests.is('...the date is the same as before the replay', (select (p.tour_seen_at = d.tour_seen_at)::text from public.profiles p, c2_date d where p.id = tests.id('c2')), 'true');
select tests.is('direct writes to the column are refused (self and admin)',
  tests.v(tests.id('b2'), $$update public.profiles set tour_seen_at = now() where id = '$$ || tests.id('b2') || $$'$$) || '/' ||
  tests.v(tests.id('a2'), $$update public.profiles set tour_seen_at = null where id = '$$ || tests.id('b2') || $$'$$), 'ERR:42501/ERR:42501');
select tests.is('a session with no user is refused (the RPC takes no id, so nobody can mark someone else)',
  tests.v(null, 'select public.mark_tour_seen()::text'), 'ERR:42501');
select tests.is('migrations 10 and 13 behaviour is intact: staff send feedback, a client cannot',
  (case when tests.v(tests.id('b1'), $$select public.submit_feedback('bug', 'still works')::text$$) ~ '^[0-9a-f-]{36}$' then 'ok' else 'bad' end) || '/' ||
  tests.v(tests.id('c1'), $$select public.submit_feedback('bug', 'x')::text$$), 'ok/ERR:42501');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

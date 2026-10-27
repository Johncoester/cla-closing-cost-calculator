-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-16 applied, with data: a super admin, an admin, reps, a client, feedback in every
-- status, audit history) gets migration 17 (feedback status updates for the sender) on top, as one plain transaction, and again.
-- Nothing existing changes; decided rows count as seen; a repeat run changes nothing.
-- Loaded by run-tests.sh into a fresh database after migrations 1-16.
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
create or replace function tests.p(sql text) returns text language plpgsql as $$
begin execute sql; return 'ok'; exception when others then return 'ERR:' || sqlstate; end $$;

-- BEFORE (migration 16 state): super admin a1, admin a2, reps b1 and b2, client c1; four feedback rows, one in each old status
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('robin.admin@clatitle.com', 'admin', false), ('old.rep@clatitle.com', 'rep', true), ('second.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false);
insert into auth.users (id, email) values (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('b1'), 'old.rep@clatitle.com'), (tests.id('b2'), 'second.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', tests.id('b1'));
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote');
insert into public.feedback (id, user_id, role_at_submit, category, message, status, decided_at, decided_note) values
  (tests.id('d1'), tests.id('b1'), 'rep', 'bug',  'old new one', 'new', null, null),
  (tests.id('d2'), tests.id('b1'), 'rep', 'idea', 'old notified one', 'notified', null, null),
  (tests.id('d3'), tests.id('b1'), 'rep', 'idea', 'old approved one', 'approved', now(), 'Planned.'),
  (tests.id('d4'), tests.id('b2'), 'rep', 'other', 'old dismissed one', 'dismissed', now(), 'No.');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l, (select count(*) from public.feedback) f,
  (select string_agg(id::text || status || coalesce(decided_note, ''), ',' order by id) from public.feedback) fb;
select tests.is('before: no shipped / seen columns yet', (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'feedback' and column_name in ('shipped_at', 'shipped_note', 'sender_seen_status')), '0');

-- the upgrade, as Supabase runs it: one transaction
begin;
\i :migration17
commit;
select tests.is('the three columns exist; nothing lost or changed (profiles, quotes, assignments, invitations, audit rows; feedback rows, statuses and notes identical)',
  (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'feedback' and column_name in ('shipped_at', 'shipped_note', 'sender_seen_status')) || '/' ||
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments)
       and i = (select count(*) from public.invitations) and l = (select count(*) from public.audit_log) and f = (select count(*) from public.feedback)
       and fb = (select string_agg(id::text || status || coalesce(decided_note, ''), ',' order by id) from public.feedback))::text from before_counts), '3/true');
select tests.is('rows that were already decided count as seen (no surprise dot); new / notified rows have no seen marker; nothing is shipped',
  (select string_agg(coalesce(sender_seen_status, '-'), ',' order by id) from public.feedback) || '/' || (select count(*)::text from public.feedback where shipped_at is not null or shipped_note is not null),
  '-,-,approved,dismissed/0');
select tests.is('so nobody has unread items right after the upgrade',
  tests.v(tests.id('b1'), $q$select count(*)::text from public.feedback where status in ('approved', 'shipped', 'dismissed') and sender_seen_status is distinct from status$q$) || '/' ||
  tests.v(tests.id('b2'), $q$select count(*)::text from public.feedback where status in ('approved', 'shipped', 'dismissed') and sender_seen_status is distinct from status$q$), '0/0');

-- it works on the migrated database
select tests.is('the super admin ships the old approved item with a note; the old rep sees it unread, marks all seen (3 rows: new, notified, shipped), and cannot change it',
  tests.v(tests.id('a1'), $$select public.admin_mark_feedback_shipped('$$ || tests.id('d3') || $$', 'It is live.')::text$$) || '/' ||
  tests.v(tests.id('b1'), $q$select count(*)::text from public.feedback where status = 'shipped' and sender_seen_status is distinct from status$q$) || '/' ||
  tests.v(tests.id('b1'), $$select public.mark_my_feedback_seen()::text$$) || '/' ||
  tests.v(tests.id('b1'), $$update public.feedback set status = 'new'$$) || '/' ||
  tests.sq($q$select status || '|' || shipped_note from public.feedback where id = tests.id('d3')$q$), '/1/3/ERR:42501/shipped|It is live.');
select tests.is('an old NEW item cannot be shipped; an admin who is not a super admin cannot ship; the other rep cannot see or mark the first rep''s items',
  tests.v(tests.id('a1'), $$select public.admin_mark_feedback_shipped('$$ || tests.id('d1') || $$', 'x')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_mark_feedback_shipped('$$ || tests.id('d3') || $$', 'x')::text$$) || '/' ||
  tests.v(tests.id('b2'), $$select count(*)::text from public.feedback where user_id = '$$ || tests.id('b1') || $$'$$) || '/' ||
  tests.v(tests.id('b2'), $$select public.mark_my_feedback_seen('$$ || tests.id('d1') || $$')::text$$), 'ERR:22023/ERR:42501/0/0');

-- the file run again (safe to repeat): data kept, nothing duplicated, seen markers kept
begin;
\i :migration17
commit;
select tests.is('a repeat run changes no statuses or seen markers (the first rep marking all as seen earlier copied new / notified too; shipped stays shipped and seen)',
  (select string_agg(status || ':' || coalesce(sender_seen_status, '-'), ',' order by id) from public.feedback), 'new:new,notified:notified,shipped:shipped,dismissed:dismissed');
select tests.is('the audit action list accepts the older actions and the new one, and still refuses unknown ones',
  tests.p($$insert into public.audit_log (action, target_type) values ('feedback_submitted', 'x')$$) || '/' || tests.p($$insert into public.audit_log (action, target_type) values ('pricing_table_changed', 'x')$$) || '/' ||
  tests.p($$insert into public.audit_log (action, target_type) values ('feedback_shipped', 'x')$$) || '/' || tests.p($$insert into public.audit_log (action, target_type) values ('something_else', 'x')$$), 'ok/ok/ok/ERR:23514');
select tests.is('earlier behaviour intact: staff send feedback, a client cannot, a rep cannot approve',
  (case when tests.v(tests.id('b1'), $$select public.submit_feedback('bug', 'still works')::text$$) ~ '^[0-9a-f-]{36}$' then 'ok' else 'bad' end) || '/' ||
  tests.v(tests.id('c1'), $$select public.submit_feedback('bug', 'x')::text$$) || '/' ||
  tests.v(tests.id('b1'), $$select public.admin_set_feedback_status('$$ || tests.id('d1') || $$', 'approved')::text$$), 'ok/ERR:42501/ERR:42501');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

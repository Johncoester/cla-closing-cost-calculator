-- =====================================================================
-- Upgrade check: a database with migrations 1-11 applied and data (a super admin who also reps, two admins, two reps with
-- active clients and history) gets migration 12 (a demoted rep's clients move to a successor) on top, as one plain
-- transaction, and again (safe to repeat). Nothing may be lost; before it a rep with clients can be demoted and strands
-- them, after it the call is refused without a successor and moves everything with one. Permissions are unchanged.
-- Loaded by run-tests.sh into a fresh database after migrations 1-11.
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



-- BEFORE (migration 11 state): super admin a1 (also a rep, 1 client), a9 second super admin, admins a2 Robin + a3 Ada (rep flag, 1 client),
-- reps b1 (2 clients + 1 old inactive row) + b2 (no clients), client c1 (+ quote)
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('second.admin@clatitle.com', 'super_admin', false),
  ('robin.admin@clatitle.com', 'admin', false), ('ada.admin@clatitle.com', 'admin', true),
  ('old.rep@clatitle.com', 'rep', true), ('other.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false);
insert into auth.users (id, email) values
  (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a9'), 'second.admin@clatitle.com'),
  (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('a3'), 'ada.admin@clatitle.com'),
  (tests.id('b1'), 'old.rep@clatitle.com'), (tests.id('b2'), 'other.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id, active) values
  ('old.client@example.com', tests.id('b1'), true), ('b1.second@example.com', tests.id('b1'), true), ('b1.history@example.com', tests.id('b1'), false),
  ('alex.client@example.com', tests.id('a1'), true), ('ada.client@example.com', tests.id('a3'), true);
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l;
select tests.is('before: the old two-argument admin_set_role / admin_set_is_rep exist',
  (select string_agg(pronargs::text, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_set_role', 'admin_set_is_rep')), '2,2');

-- the upgrade, as Supabase runs it: one transaction; then again (safe to repeat)
begin;
\i :migration12
commit;
begin;
\i :migration12
commit;

select tests.is('rows kept (profiles, quotes, assignments, invitations)',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments) and i = (select count(*) from public.invitations))::text from before_counts), 'true');
select tests.is('nobody changed role, status or rep flag', (select string_agg(role::text || '/' || status::text || '/' || is_rep::text, ',' order by id) from public.profiles),
  'super_admin/active/true,admin/active/false,admin/active/true,super_admin/active/false,rep/active/true,rep/active/true,client/active/false');
select tests.is('now one admin_set_role and one admin_set_is_rep, each with the extra optional argument (no overloads)',
  (select string_agg(pronargs::text || '/' || pronargdefaults::text, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_set_role', 'admin_set_is_rep')), '3/1,3/1');
select tests.is('the helpers exist and users cannot call them; users can call the RPCs; anon cannot',
  (has_function_privilege('authenticated', 'public.admin_set_role(uuid, public.user_role, uuid)', 'execute') and has_function_privilege('authenticated', 'public.admin_set_is_rep(uuid, boolean, uuid)', 'execute')
   and not has_function_privilege('anon', 'public.admin_set_role(uuid, public.user_role, uuid)', 'execute') and not has_function_privilege('anon', 'public.admin_set_is_rep(uuid, boolean, uuid)', 'execute')
   and not has_function_privilege('authenticated', 'private.move_rep_clients(uuid, uuid)', 'execute'))::text, 'true');

-- old callers keep working: two arguments, positional or by name
select tests.is('old call shape works by name (rep without clients is demoted)', tests.v(tests.id('a2'), $$select public.admin_set_role(p_user := '$$ || tests.id('b2') || $$', p_role := 'client')::text$$), '');
select tests.is('...and positional', tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b2') || $$', 'rep')::text$$), '');
select tests.is('old call shape: the super admin rep-flag switch with two arguments (switching ON, no clients involved)', tests.v(tests.id('a1'), $$select public.admin_set_is_rep('$$ || tests.id('a9') || $$', true)::text$$), '');

-- the new rule
select tests.is('a rep with 2 active clients cannot be demoted to client without a successor (55006)',
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'client')::text$$), 'ERR:55006');
select tests.is('...invalid successors refused: self, a client, a disabled rep, a plain admin',
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'client', '$$ || tests.id('b1') || $$')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'client', '$$ || tests.id('c1') || $$')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'client', '$$ || tests.id('a2') || $$')::text$$), 'ERR:23514/ERR:23514/ERR:23514');
select tests.is('...nothing moved', (select count(*)::text from public.assignments where rep_id = tests.id('b1') and active), '2');
select tests.is('an admin cannot do it to a super admin (Alex), clients stay',
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a1') || $$', 'client', '$$ || tests.id('b2') || $$')::text$$) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('a1') and active), 'ERR:42501/1');
select tests.is('a rep with clients is demoted with a successor (Robin hands b1''s clients to rep b2)',
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'client', '$$ || tests.id('b2') || $$')::text$$), '');
select tests.is('...b1 is a client with no active clients; b2 has both; old history row untouched',
  (select role::text from public.profiles where id = tests.id('b1')) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('b1') and active) || '/' ||
  (select count(*)::text from public.assignments where rep_id = tests.id('b2') and active) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('b1') and not active), 'client/0/2/3');
select tests.is('...the moved client sees the new rep (rep_of)', (private.rep_of(tests.id('c1')))::text, tests.id('b2')::text);
select tests.is('...audited', (select count(*)::text from public.audit_log where action = 'assignment_changed' and details ->> 'rep_id' = tests.id('b2')::text and (details ->> 'active')::boolean), '2');
-- admin who also reps: the rep switch
select tests.is('Ada (admin + rep, 1 client): rep switch off needs a successor (super admin only)',
  tests.v(tests.id('a1'), $$select public.admin_set_is_rep('$$ || tests.id('a3') || $$', false)::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_is_rep('$$ || tests.id('a3') || $$', false, '$$ || tests.id('b2') || $$')::text$$), 'ERR:55006/ERR:42501');
select tests.is('...with a successor it moves her client', tests.v(tests.id('a1'), $$select public.admin_set_is_rep('$$ || tests.id('a3') || $$', false, '$$ || tests.id('b2') || $$')::text$$), '');
select tests.is('...Ada has none left; b2 has 3', (select is_rep::text from public.profiles where id = tests.id('a3')) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('a3') and active) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('b2') and active), 'false/0/3');
select tests.is('a rep -> admin keeps rep capability: no successor needed, clients stay',
  tests.v(tests.id('a1'), $$select public.admin_set_role('$$ || tests.id('b2') || $$', 'admin')::text$$) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('b2') and active), '/3');
-- the other guards are untouched
select tests.is('migration 11 rules intact: an admin disables another admin, cannot promote, cannot invite an admin',
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a3') || $$', 'disabled')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a3') || $$', 'super_admin')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select (public.create_invitation('x.admin@clatitle.com', 'admin')).role::text$$), '/ERR:42501/ERR:42501');
update public.profiles set status = 'disabled' where id = tests.id('a9');
select tests.is('guard: the only active super admin cannot be disabled or demoted',
  tests.p('update public.profiles set status = ''disabled'' where id = ''' || tests.id('a1') || '''') || '/' || tests.v(tests.id('a1'), $$select public.admin_set_role('$$ || tests.id('a1') || $$', 'admin')::text$$), 'ERR:55000/ERR:42501');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

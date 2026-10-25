-- =====================================================================
-- Upgrade check: a database that already has migrations 1-6 and real-looking data (a super admin who also reps,
-- a rep with a client and quotes, a second pending super-admin invitation: the state before the admin role)
-- gets migration 9 (the enum value) and then migration 10 (the rules), each as its OWN transaction, exactly the way
-- Supabase applies them. Nothing may be lost, and every existing person keeps exactly the access they had.
-- Loaded by run-tests.sh into a fresh database after migrations 1-6.
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

-- BEFORE (migration 6 state): a1 old super admin + rep, a9 a second super admin, b1 rep, c1 client
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('second.admin@clatitle.com', 'super_admin', false),
  ('old.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false),
  ('john@clatitle.com', 'super_admin', true);                        -- never signs up until later: stays pending, like the live one
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'old.admin@clatitle.com'), ('00000000-0000-4000-8000-0000000000a9', 'second.admin@clatitle.com'),
  ('00000000-0000-4000-8000-0000000000b1', 'old.rep@clatitle.com'), ('00000000-0000-4000-8000-0000000000c1', 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', '00000000-0000-4000-8000-0000000000b1'),
  ('own.client@example.com', '00000000-0000-4000-8000-0000000000a1');
insert into public.quotes (owner_id, quote_type, label) values ('00000000-0000-4000-8000-0000000000c1', 'buyer', 'old quote'),
  ('00000000-0000-4000-8000-0000000000b1', 'buyer', 'old rep quote'), ('00000000-0000-4000-8000-0000000000a1', 'buyer', 'old admin quote');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l,
  (select count(*) from public.profiles where is_complete) c, (select count(*) from public.profiles where is_rep) r;
select tests.is('before: no "admin" value yet (the migration really adds it)',
  (select count(*)::text from pg_enum where enumtypid = 'public.user_role'::regtype and enumlabel = 'admin'), '0');

-- the upgrade, as Supabase runs it: one transaction per file
begin;
\i :migration9
commit;
begin;
\i :migration10
commit;

select tests.is('enum now has admin', (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum where enumtypid = 'public.user_role'::regtype), 'super_admin,admin,rep,client');
select tests.is('rows kept (profiles, quotes, assignments, invitations)',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes)
       and a = (select count(*) from public.assignments) and i = (select count(*) from public.invitations))::text from before_counts), 'true');
select tests.is('audit log rows kept', (select (l = (select count(*) from public.audit_log))::text from before_counts), 'true');
select tests.is('is_complete and is_rep values unchanged',
  (select (c = (select count(*) from public.profiles where is_complete) and r = (select count(*) from public.profiles where is_rep))::text from before_counts), 'true');
select tests.is('nobody was turned into an admin: roles unchanged',
  (select string_agg(role::text, ',' order by id) from public.profiles), 'super_admin,super_admin,rep,client');
select tests.is('the old super admin kept is_rep and her clients',
  (select is_rep::text from public.profiles where id = tests.id('a1')) || '/' || (select count(*)::text from public.assignments where rep_id = tests.id('a1') and active), 'true/1');

-- every existing person keeps exactly the access they had
select tests.is('old super admin: is_admin and is_super_admin both true',
  tests.v(tests.id('a1'), 'select private.is_admin()::text') || '/' || tests.v(tests.id('a1'), 'select private.is_super_admin()::text'), 'true/true');
select tests.is('old super admin still sees every profile and every quote',
  tests.v(tests.id('a1'), 'select count(*)::text from public.profiles') || '/' || tests.v(tests.id('a1'), 'select count(*)::text from public.quotes'), '4/3');
select tests.is('old rep: not an admin, sees self + client, own + client quotes',
  tests.v(tests.id('b1'), 'select private.is_admin()::text') || '/' || tests.v(tests.id('b1'), 'select count(*)::text from public.profiles') || '/' || tests.v(tests.id('b1'), 'select count(*)::text from public.quotes'), 'false/2/2');
select tests.is('old client: not an admin, sees only self', tests.v(tests.id('c1'), 'select private.is_admin()::text') || '/' || tests.v(tests.id('c1'), 'select count(*)::text from public.profiles'), 'false/1');
select tests.is('rep/client pairing still works (rep_of)', (select private.rep_of(tests.id('c1'))::text), tests.id('b1')::text);
select tests.is('rep access of the old super admin still works (is_rep)', tests.v(tests.id('a1'), 'select private.is_rep()::text'), 'true');
select tests.is('one create_invitation (no overloads)', (select count(*)::text from pg_proc where proname = 'create_invitation' and pronamespace = 'public'::regnamespace), '1');
select tests.is('the profile-edit policy now goes through can_manage_user',
  (select (qual like '%can_manage_user%')::text from pg_policies where tablename = 'profiles' and policyname = 'profiles_update_admin'), 'true');

-- the old super admin can use the new powers right away
select tests.is('old super admin invites an admin',
  tests.v(tests.id('a1'), $$select (public.create_invitation('upgrade.admin@clatitle.com', 'admin')).role::text$$), 'admin');
insert into auth.users (id, email) values (tests.id('a2'), 'upgrade.admin@clatitle.com');
select tests.is('...who signs up as an admin', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a2')), 'admin/false');
select tests.is('the new admin sees everything and may disable the client, not the super admin',
  tests.v(tests.id('a2'), 'select count(*)::text from public.profiles') || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('c1') || $$', 'disabled')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a1') || $$', 'disabled')::text$$), '5//ERR:42501');

-- John's flow still works: his pending super-admin invitation (with the rep flag) becomes a profile
insert into auth.users (id, email) values (tests.id('d1'), 'john@clatitle.com');
select tests.is('John signs up: super_admin + is_rep', (select role::text || '/' || is_rep::text from public.profiles where email = 'john@clatitle.com'), 'super_admin/true');

-- the guard is live on the upgraded database
update public.profiles set status = 'disabled' where id in (tests.id('a9'), tests.id('d1'));       -- allowed: Old Person (a1) stays active
select tests.is('guard: the only active super admin cannot be disabled or demoted by any path',
  tests.p('update public.profiles set status = ''disabled'' where id = ''' || tests.id('a1') || '''') || '/' ||
  tests.p('update public.profiles set role = ''admin'' where id = ''' || tests.id('a1') || ''''), 'ERR:55000/ERR:55000');
select tests.is('guard: ...nor her login', tests.p('delete from auth.users where id = ''' || tests.id('a1') || ''''), 'ERR:55000');
update public.profiles set status = 'active' where id = tests.id('d1');
select tests.is('with two active super admins one may be demoted', tests.v(tests.id('d1'), $$select public.admin_set_role('$$ || tests.id('a1') || $$', 'admin')::text$$), '');
select tests.is('...and then John is the last: nobody can remove him', tests.p('update public.profiles set status = ''disabled'' where id = ''' || tests.id('d1') || ''''), 'ERR:55000');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

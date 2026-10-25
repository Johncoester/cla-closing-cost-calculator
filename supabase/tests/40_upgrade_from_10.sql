-- =====================================================================
-- Upgrade check: a database in the LIVE state (migrations 1-10 applied, with data: two super admins, two admins,
-- a rep with a client and quotes, a photo) gets migration 11 (an admin may also manage other admins) on top, as one
-- plain transaction. Nothing may be lost; before it an admin cannot touch another admin, after it an admin can
-- (disable / re-enable / demote / edit / photo) but still not a super admin, still cannot promote or invite.
-- Loaded by run-tests.sh into a fresh database after migrations 1-10.
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


-- BEFORE (migration 10 state): super admins a1 (also a rep) + a9, admins a2 Robin + a3 Ada, rep b1, client c1
insert into public.invitations (email, role, is_rep) values
  ('old.admin@clatitle.com', 'super_admin', true), ('second.admin@clatitle.com', 'super_admin', false),
  ('robin.admin@clatitle.com', 'admin', false), ('ada.admin@clatitle.com', 'admin', true),
  ('old.rep@clatitle.com', 'rep', true), ('old.client@example.com', 'client', false);
insert into auth.users (id, email) values
  (tests.id('a1'), 'old.admin@clatitle.com'), (tests.id('a9'), 'second.admin@clatitle.com'),
  (tests.id('a2'), 'robin.admin@clatitle.com'), (tests.id('a3'), 'ada.admin@clatitle.com'),
  (tests.id('b1'), 'old.rep@clatitle.com'), (tests.id('c1'), 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', tests.id('b1')), ('ada.client@example.com', tests.id('a3'));
insert into public.quotes (owner_id, quote_type, label) values (tests.id('c1'), 'buyer', 'old quote'), (tests.id('a3'), 'buyer', 'ada quote');
insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (tests.id('a3'), tests.id('a3') || '/avatar', 'image/png', 1000);
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l, (select count(*) from public.photos) ph,
  (select count(*) from public.profiles where is_rep) r;
select tests.is('before: roles as in production (2 super admins, 2 admins, rep, client)',
  (select string_agg(role::text, ',' order by id) from public.profiles), 'super_admin,admin,admin,super_admin,rep,client');
-- the OLD rule (migration 10): an admin cannot act on another admin
select tests.is('before: Robin cannot disable, demote or edit Ada, nor remove her photo',
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a3') || $$', 'disabled')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a3') || $$', 'client')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$with u as (update public.profiles set first_name = 'X' where id = '$$ || tests.id('a3') || $$' returning 1) select count(*)::text from u$$) || '/' ||
  tests.v(tests.id('a2'), $$with d as (delete from public.photos where owner_id = '$$ || tests.id('a3') || $$' returning 1) select count(*)::text from d$$), 'ERR:42501/ERR:42501/0/0');
select tests.is('before: can_manage_user(Ada) is false for Robin', tests.v(tests.id('a2'), $$select private.can_manage_user('$$ || tests.id('a3') || $$')::text$$), 'false');

-- the upgrade, as Supabase runs it: one transaction
begin;
\i :migration11
commit;
-- idempotent: a second run changes nothing and fails nothing
begin;
\i :migration11
commit;

select tests.is('rows kept (profiles, quotes, assignments, invitations, photos, audit log)',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes) and a = (select count(*) from public.assignments)
       and i = (select count(*) from public.invitations) and ph = (select count(*) from public.photos) and l = (select count(*) from public.audit_log))::text from before_counts), 'true');
select tests.is('nobody changed role, status or rep flag', (select string_agg(role::text || '/' || status::text || '/' || is_rep::text, ',' order by id) from public.profiles),
  'super_admin/active/true,admin/active/false,admin/active/true,super_admin/active/false,rep/active/true,client/active/false');
select tests.is('enum, one create_invitation, one of each RPC (no overloads)',
  (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum where enumtypid = 'public.user_role'::regtype) || '/' ||
  (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and proname in ('create_invitation', 'admin_set_role', 'admin_set_status', 'admin_set_is_rep')), 'super_admin,admin,rep,client/4');
select tests.is('privileges as before: authenticated can run the RPCs and can_manage_user, anon cannot',
  (has_function_privilege('authenticated', 'public.admin_set_role(uuid, public.user_role)', 'execute')
   and has_function_privilege('authenticated', 'public.admin_set_status(uuid, public.user_status)', 'execute')
   and has_function_privilege('authenticated', 'private.can_manage_user(uuid)', 'execute')
   and not has_function_privilege('anon', 'public.admin_set_role(uuid, public.user_role)', 'execute')
   and not has_function_privilege('anon', 'private.can_manage_user(uuid)', 'execute'))::text, 'true');

-- the NEW rule: an admin manages another admin ...
select tests.is('after: can_manage_user(Ada) is true for Robin, can_manage_user(super admin) is false',
  tests.v(tests.id('a2'), $$select private.can_manage_user('$$ || tests.id('a3') || $$')::text$$) || '/' || tests.v(tests.id('a2'), $$select private.can_manage_user('$$ || tests.id('a1') || $$')::text$$), 'true/false');
select tests.is('after: Robin disables Ada', tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a3') || $$', 'disabled')::text$$), '');
select tests.is('...she is disabled and locked out of the dashboard', (select status::text from public.profiles where id = tests.id('a3')) || '/' || tests.v(tests.id('a3'), 'select private.is_admin()::text'), 'disabled/false');
select tests.is('...Robin re-enables her', tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a3') || $$', 'active')::text$$), '');
select tests.is('...she is active again', (select status::text from public.profiles where id = tests.id('a3')), 'active');
select tests.is('after: Robin edits Ada''s profile and removes her photo',
  tests.v(tests.id('a2'), $$with u as (update public.profiles set first_name = 'Adaline' where id = '$$ || tests.id('a3') || $$' returning 1) select count(*)::text from u$$) || '/' ||
  tests.v(tests.id('a2'), $$with d as (delete from public.photos where owner_id = '$$ || tests.id('a3') || $$' returning 1) select count(*)::text from d$$), '1/1');
select tests.is('after: Robin demotes Ada (also a rep, with a client) to rep', tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a3') || $$', 'rep')::text$$), '');
select tests.is('...she stays a rep and keeps her client', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a3')) || '/' ||
  (select count(*)::text from public.assignments where rep_id = tests.id('a3') and active), 'rep/true/1');
update public.profiles set role = 'admin' where id = tests.id('a3');    -- put her back (server side) for the rest

-- ... but still not a super admin, not promote, not invite, not is_rep
select tests.is('after: Robin still cannot touch a super admin (status, role, profile, photo)',
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a9') || $$', 'disabled')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a9') || $$', 'client')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$with u as (update public.profiles set first_name = 'X' where id = '$$ || tests.id('a9') || $$' returning 1) select count(*)::text from u$$), 'ERR:42501/ERR:42501/0');
select tests.is('after: Robin still cannot promote (rep -> admin, admin -> super admin) or invite an admin / super admin',
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('b1') || $$', 'admin')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a3') || $$', 'super_admin')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select (public.create_invitation('new.admin@clatitle.com', 'admin')).role::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select (public.create_invitation('new.sa@clatitle.com', 'super_admin')).role::text$$), 'ERR:42501/ERR:42501/ERR:42501/ERR:42501');
select tests.is('after: Robin still cannot switch the rep flag, or disable / demote himself',
  tests.v(tests.id('a2'), $$select public.admin_set_is_rep('$$ || tests.id('a3') || $$', false)::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a2') || $$', 'disabled')::text$$) || '/' ||
  tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a2') || $$', 'client')::text$$), 'ERR:42501/ERR:42501/ERR:42501');
select tests.is('after: a super admin keeps every power (promote an admin, demote a super admin, switch rep flag)',
  tests.v(tests.id('a1'), $$select public.admin_set_role('$$ || tests.id('a3') || $$', 'super_admin')::text$$) || '/' ||
  tests.v(tests.id('a1'), $$select public.admin_set_role('$$ || tests.id('a3') || $$', 'admin')::text$$) || '/' ||
  tests.v(tests.id('a1'), $$select public.admin_set_is_rep('$$ || tests.id('a2') || $$', true)::text$$) || '/' ||
  tests.v(tests.id('a1'), $$select (public.create_invitation('new.admin@clatitle.com', 'admin')).role::text$$), '///admin');
select tests.is('after: old rep and client unaffected (rep sees self + client; client only self; neither manages anyone)',
  tests.v(tests.id('b1'), 'select count(*)::text from public.profiles') || '/' || tests.v(tests.id('c1'), 'select count(*)::text from public.profiles') || '/' ||
  tests.v(tests.id('b1'), $$select public.admin_set_status('$$ || tests.id('a2') || $$', 'disabled')::text$$), '2/1/ERR:42501');
-- the last-active-super-admin guard is untouched
update public.profiles set status = 'disabled' where id = tests.id('a9');
select tests.is('guard: the only active super admin cannot be disabled or demoted (RPC by herself, SQL, login)',
  tests.v(tests.id('a1'), $$select public.admin_set_status('$$ || tests.id('a1') || $$', 'disabled')::text$$) || '/' ||
  tests.p('update public.profiles set status = ''disabled'' where id = ''' || tests.id('a1') || '''') || '/' ||
  tests.p('update public.profiles set role = ''admin'' where id = ''' || tests.id('a1') || '''') || '/' ||
  tests.p('delete from auth.users where id = ''' || tests.id('a1') || ''''), 'ERR:42501/ERR:55000/ERR:55000/ERR:55000');
select tests.is('guard: an admin cannot remove her either (permission refused first)',
  tests.v(tests.id('a2'), $$select public.admin_set_status('$$ || tests.id('a1') || $$', 'disabled')::text$$) || '/' || tests.v(tests.id('a2'), $$select public.admin_set_role('$$ || tests.id('a1') || $$', 'client')::text$$), 'ERR:42501/ERR:42501');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

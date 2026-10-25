-- =====================================================================
-- Upgrade check: a database that already has migrations 1-5 and real-looking data
-- (a rep with a client and quotes, an admin, a pending super-admin invitation, no flag column yet)
-- gets migration 6 applied on top. Nothing may be lost or change meaning.
-- Loaded by run-tests.sh into a SEPARATE database (cla_upgrade) after migrations 1-5 and the "before" data below.
-- =====================================================================
\set ON_ERROR_STOP on
create schema if not exists tests;
create table tests.r (n serial, name text, ok boolean, got text);
create or replace function tests.is(name text, got text, want text) returns void language plpgsql as $$
begin
  insert into tests.r (name, ok, got) values (name, got = want, got);
  if got = want then raise notice 'PASS  %', name; else raise warning 'FAIL  % (got %, wanted %)', name, got, want; end if;
end $$;

-- BEFORE (migration 5 state)
insert into public.invitations (email, role) values
  ('old.admin@clatitle.com', 'super_admin'), ('old.rep@clatitle.com', 'rep'), ('old.client@example.com', 'client'),
  ('john@clatitle.com', 'super_admin');                              -- never signs up: stays pending, like the live one
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'old.admin@clatitle.com'), ('00000000-0000-4000-8000-0000000000b1', 'old.rep@clatitle.com'),
  ('00000000-0000-4000-8000-0000000000c1', 'old.client@example.com');
update public.profiles set first_name = 'Old', last_name = 'Person', phone = '301-555-0100';
insert into public.assignments (client_email, rep_id) values ('old.client@example.com', '00000000-0000-4000-8000-0000000000b1');
insert into public.quotes (owner_id, quote_type, label) values ('00000000-0000-4000-8000-0000000000c1', 'buyer', 'old quote'),
  ('00000000-0000-4000-8000-0000000000b1', 'buyer', 'old rep quote');
create temp table before_counts as select
  (select count(*) from public.profiles) p, (select count(*) from public.quotes) q, (select count(*) from public.assignments) a,
  (select count(*) from public.invitations) i, (select count(*) from public.audit_log) l,
  (select count(*) from public.profiles where is_complete) c;

\i :migration6

select tests.is('rows kept (profiles, quotes, assignments, invitations)',
  (select (p = (select count(*) from public.profiles) and q = (select count(*) from public.quotes)
       and a = (select count(*) from public.assignments) and i = (select count(*) from public.invitations))::text from before_counts), 'true');
select tests.is('audit log rows kept', (select (l = (select count(*) from public.audit_log))::text from before_counts), 'true');
select tests.is('existing rep backfilled to is_rep = true', (select is_rep::text from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'), 'true');
select tests.is('existing admin is NOT a rep (nothing changes unless switched on)', (select is_rep::text from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'), 'false');
select tests.is('existing client is not a rep', (select is_rep::text from public.profiles where id = '00000000-0000-4000-8000-0000000000c1'), 'false');
select tests.is('pending super-admin invitation survives with is_rep = false', (select is_rep::text from public.invitations where email = 'john@clatitle.com' and accepted_at is null), 'false');
select tests.is('is_complete values unchanged by the column rebuild', (select (c = (select count(*) from public.profiles where is_complete))::text from before_counts), 'true');
select tests.is('rep/client pairing still works (rep_of)', (select private.rep_of('00000000-0000-4000-8000-0000000000c1')::text), '00000000-0000-4000-8000-0000000000b1');
select tests.is('old quote keeps its rep_id', (select rep_id::text from public.quotes where label = 'old quote'), '00000000-0000-4000-8000-0000000000b1');

-- John's flow: flag the pending invitation (the one-line live update), then he signs up
update public.invitations set is_rep = true where email = 'john@clatitle.com' and accepted_at is null;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000d1', 'john@clatitle.com');
select tests.is('John signs up: super_admin + is_rep', (select role::text || '/' || is_rep::text from public.profiles where email = 'john@clatitle.com'), 'super_admin/true');
insert into public.assignments (client_email, rep_id) values ('john.client@example.com', '00000000-0000-4000-8000-0000000000d1');
select tests.is('John can now be assigned a client', (select count(*)::text from public.assignments where rep_id = '00000000-0000-4000-8000-0000000000d1'), '1');

do $$ declare n int; begin select count(*) into n from tests.r where not ok;
  raise notice '% upgrade checks, % failed', (select count(*) from tests.r), n;
  if n > 0 then raise exception '% upgrade check(s) failed', n; end if; end $$;

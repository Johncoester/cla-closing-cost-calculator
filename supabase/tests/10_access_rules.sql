-- =====================================================================
-- Access-rule tests. Run after: shim (test only), migrations, seed.
-- Each check impersonates a user the way Supabase does: role authenticated
-- plus request.jwt.claims. Any failed check makes psql exit non-zero.
-- =====================================================================
\set ON_ERROR_STOP on
create schema tests;
create table tests.results (n serial, name text, ok boolean, got text);
grant usage on schema tests to public;

-- run sql as a user; returns count(*) of the select, or 'ERR:<sqlstate>'
create function tests.q(uid uuid, sql text, aal text default 'aal1') returns text language plpgsql as $$
declare n bigint; res text;
begin
  perform set_config('request.jwt.claims',
    case when uid is null then '' else json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text end, true);
  perform set_config('role', case when uid is null then 'anon' else 'authenticated' end, true);
  begin
    execute 'select count(*) from (' || sql || ') t' into n;
    res := n::text;
  exception when others then res := 'ERR:' || sqlstate;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;

-- run a DML statement as a user; returns 'ok:<rows>' or 'ERR:<sqlstate>'
create function tests.x(uid uuid, sql text, aal text default 'aal1') returns text language plpgsql as $$
declare n bigint; res text;
begin
  perform set_config('request.jwt.claims',
    case when uid is null then '' else json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text end, true);
  perform set_config('role', case when uid is null then 'anon' else 'authenticated' end, true);
  begin
    execute sql;
    get diagnostics n = row_count;
    res := 'ok:' || n;
  exception when others then res := 'ERR:' || sqlstate;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;

create function tests.is(name text, got text, want text) returns void language plpgsql as $$
begin
  insert into tests.results (name, ok, got) values (name, got = want, got);
  if got = want then raise notice 'PASS  %', name;
  else raise warning 'FAIL  % (got %, wanted %)', name, got, want; end if;
end $$;

-- ids
create function tests.id(k text) returns uuid language sql as $$
  select ('00000000-0000-4000-8000-0000000000' || k)::uuid $$;
-- admin a1 | reps b1 jane, b2 marcus | clients c1 sam, c2 lee, c3 pat (unassigned), c4 dee (disabled, marcus), c5 omar (marcus)

-- ---------------- sanity: seed shape ----------------
select tests.is('seed: 9 quotes inserted',   (select count(*)::text from public.quotes), '9');
select tests.is('seed: expires_at = created_at + 30 days on every quote',
  (select count(*)::text from public.quotes where expires_at = created_at + interval '30 days'), '9');
select tests.is('seed: client_user_id linked for existing clients',
  (select count(*)::text from public.assignments where client_user_id is not null), '4');
select tests.is('seed: pre-signup assignment has no user yet',
  (select count(*)::text from public.assignments where client_email = 'nina.newagent@example.com' and client_user_id is null), '1');
select tests.is('seed: avatar_path synced by photos trigger',
  (select avatar_path from public.profiles where id = tests.id('b1')), tests.id('b1')::text || '/avatar');

-- ---------------- invite-only sign-up ----------------
do $$ begin
  begin
    insert into auth.users (id, email) values (gen_random_uuid(), 'stranger@example.com');
    perform tests.is('signup without invitation is rejected', 'allowed', 'rejected');
  exception when insufficient_privilege then
    perform tests.is('signup without invitation is rejected', 'rejected', 'rejected');
  end;
end $$;
do $$ declare u uuid := gen_random_uuid(); begin
  insert into public.invitations (email, role) values ('Brand.New@Example.com'::text, 'client') ;
exception when check_violation then
  perform tests.is('invitation email must be lowercase (check)', 'rejected', 'rejected');
end $$;
do $$ declare u uuid := gen_random_uuid(); begin
  insert into public.invitations (email, role) values ('brand.new@example.com', 'client');
  insert into auth.users (id, email) values (u, 'Brand.New@Example.com');
  perform tests.is('invited email can sign up (case-insensitive)',
    (select role::text || '/' || status::text from public.profiles where id = u), 'client/active');
  perform tests.is('invitation marked accepted',
    (select (accepted_user_id = u)::text from public.invitations where email = 'brand.new@example.com'), 'true');
end $$;
-- role cannot come from metadata
do $$ declare u uuid := gen_random_uuid(); begin
  insert into public.invitations (email, role) values ('meta.try@example.com', 'client');
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
    values (u, 'meta.try@example.com', '{"role":"super_admin"}', '{"role":"super_admin"}');
  perform tests.is('role in user/app metadata is ignored (invitation decides)',
    (select role::text from public.profiles where id = u), 'client');
end $$;
-- rep must be CLA
do $$ begin
  begin
    insert into public.invitations (email, role) values ('rep@gmail.com', 'rep');
    perform tests.is('rep invitation needs @clatitle.com', 'allowed', 'rejected');
  exception when check_violation then
    perform tests.is('rep invitation needs @clatitle.com', 'rejected', 'rejected');
  end;
end $$;

-- ---------------- profiles ----------------
select tests.is('anon reads no profiles',            tests.q(null, 'select * from public.profiles'), 'ERR:42501');
select tests.is('client sees only self',              tests.q(tests.id('c1'), 'select * from public.profiles'), '1');
select tests.is('rep Jane sees self + her 2 clients', tests.q(tests.id('b1'), 'select * from public.profiles'), '3');
select tests.is('rep Marcus sees self + omar (dee is disabled but still his client)', tests.q(tests.id('b2'), 'select * from public.profiles'), '3');
select tests.is('rep cannot see another rep''s client',
  tests.q(tests.id('b1'), 'select * from public.profiles where id = ''' || tests.id('c5') || ''''), '0');
select tests.is('admin sees all 10 profiles (8 seeded + 2 signed up earlier in this test)',
  tests.q(tests.id('a1'), 'select * from public.profiles'), '10');
select tests.is('disabled client reads nothing', tests.q(tests.id('c4'), 'select * from public.profiles'), '0');
select tests.is('client updates own phone',
  tests.x(tests.id('c1'), 'update public.profiles set phone = ''240-555-9999'' where id = ''' || tests.id('c1') || ''''), 'ok:1');
select tests.is('client cannot update another profile',
  tests.x(tests.id('c1'), 'update public.profiles set phone = ''1'' where id = ''' || tests.id('c2') || ''''), 'ok:0');
select tests.is('client cannot promote self (role column)',
  tests.x(tests.id('c1'), 'update public.profiles set role = ''super_admin'' where id = ''' || tests.id('c1') || ''''), 'ERR:42501');
select tests.is('client cannot change status',
  tests.x(tests.id('c1'), 'update public.profiles set status = ''active'' where id = ''' || tests.id('c1') || ''''), 'ERR:42501');
select tests.is('client cannot change email (match key)',
  tests.x(tests.id('c1'), 'update public.profiles set email = ''x@example.com'' where id = ''' || tests.id('c1') || ''''), 'ERR:42501');
select tests.is('client cannot set avatar_path directly',
  tests.x(tests.id('c1'), 'update public.profiles set avatar_path = ''x'' where id = ''' || tests.id('c1') || ''''), 'ERR:42501');
select tests.is('rep cannot edit a client profile',
  tests.x(tests.id('b1'), 'update public.profiles set phone = ''1'' where id = ''' || tests.id('c1') || ''''), 'ok:0');
select tests.is('admin can edit a client''s company name',
  tests.x(tests.id('a1'), 'update public.profiles set company_name = ''Acme Realty LLC'' where id = ''' || tests.id('c1') || ''''), 'ok:1');
select tests.is('nobody deletes profiles via API (admin)',
  tests.x(tests.id('a1'), 'delete from public.profiles where id = ''' || tests.id('c3') || ''''), 'ERR:42501');
select tests.is('nobody inserts profiles via API',
  tests.x(tests.id('c3'), 'insert into public.profiles (id, role, email) values (gen_random_uuid(), ''super_admin'', ''z@example.com'')'), 'ERR:42501');

-- ---------------- get_my_rep ----------------
do $$ declare r text; begin
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id('c1'), 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select first_name || '/' || coalesce(phone, '') || '/' || coalesce(avatar_path, '-') into r from public.get_my_rep();
  perform set_config('role', 'postgres', true);
  perform tests.is('client Sam gets rep Jane: name, phone, photo path', r, 'Jane/301-555-0111/' || tests.id('b1') || '/avatar');
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id('c3'), 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*)::text into r from public.get_my_rep();
  perform set_config('role', 'postgres', true);
  perform tests.is('unassigned client Pat has no rep', r, '0');
  perform set_config('request.jwt.claims', '', true);
end $$;
select tests.is('get_my_rep returns only name, phone, email, photo path (no company/license)',
  pg_get_function_result('public.get_my_rep'::regproc), 'TABLE(id uuid, first_name text, last_name text, phone text, email text, avatar_path text)');
select tests.is('anon cannot call get_my_rep', tests.q(null, 'select * from public.get_my_rep()'), 'ERR:42501');

-- ---------------- quotes ----------------
select tests.is('Sam sees own non-deleted, non-expired quotes (3)', tests.q(tests.id('c1'), 'select * from public.quotes'), '3');
select tests.is('expired quote hidden from owner immediately',
  tests.q(tests.id('c1'), 'select * from public.quotes where id = ''00000000-0000-4000-8000-00000000f004'''), '0');
select tests.is('soft-deleted quote hidden from owner',
  tests.q(tests.id('c1'), 'select * from public.quotes where id = ''00000000-0000-4000-8000-00000000f009'''), '0');
select tests.is('Lee sees only her quote', tests.q(tests.id('c2'), 'select * from public.quotes'), '1');
select tests.is('Pat (unassigned) sees only her quote', tests.q(tests.id('c3'), 'select * from public.quotes'), '1');
select tests.is('rep Jane sees her clients'' 4 quotes (Sam 3 + Lee 1) + her own 1', tests.q(tests.id('b1'), 'select * from public.quotes'), '5');
select tests.is('rep Jane cannot see Omar''s quote (other rep)',
  tests.q(tests.id('b1'), 'select * from public.quotes where owner_id = ''' || tests.id('c5') || ''''), '0');
select tests.is('rep Marcus sees Omar''s quote; Dee (disabled) has none', tests.q(tests.id('b2'), 'select * from public.quotes'), '1');
select tests.is('rep does not see unassigned Pat''s quote',
  tests.q(tests.id('b1'), 'select * from public.quotes where owner_id = ''' || tests.id('c3') || ''''), '0');
select tests.is('admin sees all non-expired quotes incl. soft-deleted (8)', tests.q(tests.id('a1'), 'select * from public.quotes'), '8');
select tests.is('anon sees no quotes', tests.q(null, 'select * from public.quotes'), 'ERR:42501');
select tests.is('disabled client sees no quotes', tests.q(tests.id('c4'), 'select * from public.quotes'), '0');

select tests.is('client saves a quote',
  tests.x(tests.id('c2'), 'insert into public.quotes (quote_type, label, state, price, inputs, results) values (''buyer'', ''new'', ''DC'', 100000, ''{}'', ''{}'')'), 'ok:1');
select tests.is('new quote: owner set to caller, rep set from assignment, expiry 30 days',
  (select (owner_id = tests.id('c2') and rep_id = tests.id('b1') and expires_at = created_at + interval '30 days')::text
     from public.quotes where label = 'new'), 'true');
select tests.is('client cannot save a quote as someone else',
  tests.x(tests.id('c2'), 'insert into public.quotes (owner_id, quote_type) values (''' || tests.id('c1') || ''', ''buyer'')'), 'ERR:42501');
select tests.is('client cannot back-date or set expiry on insert (columns not granted)',
  tests.x(tests.id('c2'), 'insert into public.quotes (quote_type, expires_at) values (''buyer'', now() + interval ''400 days'')'), 'ERR:42501');
select tests.is('client cannot extend expiry',
  tests.x(tests.id('c2'), 'update public.quotes set expires_at = now() + interval ''400 days'' where label = ''new'''), 'ERR:42501');
select tests.is('client cannot reassign quote rep',
  tests.x(tests.id('c2'), 'update public.quotes set rep_id = null where label = ''new'''), 'ERR:42501');
select tests.is('client edits own quote label',
  tests.x(tests.id('c2'), 'update public.quotes set label = ''renamed'' where label = ''new'''), 'ok:1');
select tests.is('expiry unchanged by edit (still created_at + 30 days)',
  (select (expires_at = created_at + interval '30 days')::text from public.quotes where label = 'renamed'), 'true');
select tests.is('client cannot edit another client''s quote',
  tests.x(tests.id('c2'), 'update public.quotes set label = ''hack'' where owner_id = ''' || tests.id('c1') || ''''), 'ok:0');
select tests.is('rep cannot edit a client''s quote',
  tests.x(tests.id('b1'), 'update public.quotes set label = ''hack'' where owner_id = ''' || tests.id('c1') || ''''), 'ok:0');
select tests.is('client cannot hard-delete (no policy matches)',
  tests.x(tests.id('c2'), 'delete from public.quotes where label = ''renamed'''), 'ok:0');
select tests.is('client cannot soft-delete by direct UPDATE (column not granted)',
  tests.x(tests.id('c2'), 'update public.quotes set deleted_at = now() where label = ''renamed'''), 'ERR:42501');
select tests.is('client cannot delete another client''s quote through the RPC',
  tests.x(tests.id('c2'), 'select public.delete_my_quote(''00000000-0000-4000-8000-00000000f001'')'), 'ERR:P0002');
select tests.is('client soft-deletes own quote through the RPC',
  tests.x(tests.id('c2'), 'select public.delete_my_quote((select id from public.quotes where label = ''renamed''))'), 'ok:1');
select tests.is('soft-deleted quote hidden from the rep too',
  tests.q(tests.id('b1'), 'select * from public.quotes where label = ''renamed'''), '0');
select tests.is('soft delete is audited',
  (select count(*)::text from public.audit_log where action = 'quote_deleted'), '1');
select tests.is('soft-deleted quote still kept for admin until purge',
  tests.q(tests.id('a1'), 'select * from public.quotes where label = ''renamed'''), '1');
select tests.is('admin can hard-delete a quote',
  tests.x(tests.id('a1'), 'delete from public.quotes where label = ''renamed'''), 'ok:1');
select tests.is('rep saves own quote, rep_id = self',
  tests.x(tests.id('b2'), 'insert into public.quotes (quote_type, label) values (''buyer'', ''marcus own'')'), 'ok:1');
select tests.is('rep own quote rep_id is self',
  (select (rep_id = tests.id('b2'))::text from public.quotes where label = 'marcus own'), 'true');
select tests.is('Pat (no rep) quote has rep_id null',
  (select (rep_id is null)::text from public.quotes where owner_id = tests.id('c3')), 'true');

-- ---------------- 30 day purge ----------------
select tests.is('purge removes only the expired quote (1)', (select private.purge_expired_quotes())::text, '1');
select tests.is('expired quote physically gone',
  (select count(*)::text from public.quotes where id = '00000000-0000-4000-8000-00000000f004'), '0');
select tests.is('29 day old quote survives purge',
  (select count(*)::text from public.quotes where id = '00000000-0000-4000-8000-00000000f003'), '1');
select tests.is('purge audited', (select (details ->> 'count') from public.audit_log where action = 'quotes_purged'), '1');
select tests.is('regular users cannot run purge', tests.q(tests.id('a1'), 'select private.purge_expired_quotes()'), 'ERR:42501');
-- a quote that ages past 30 days vanishes even before the job runs
-- (server-side only: the trigger normally freezes created_at, so pause it to age this row)
alter table public.quotes disable trigger quotes_expiry;
update public.quotes set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
 where id = '00000000-0000-4000-8000-00000000f001';
alter table public.quotes enable trigger quotes_expiry;
select tests.is('aged-out quote hidden by RLS before purge runs',
  tests.q(tests.id('c1'), 'select * from public.quotes where id = ''00000000-0000-4000-8000-00000000f001'''), '0');
select tests.is('aged-out quote hidden even from admin',
  tests.q(tests.id('a1'), 'select * from public.quotes where id = ''00000000-0000-4000-8000-00000000f001'''), '0');
select tests.is('purge job then removes the aged-out quote', (select private.purge_expired_quotes())::text, '1');

-- ---------------- assignments ----------------
select tests.is('client sees own assignment row only', tests.q(tests.id('c1'), 'select * from public.assignments'), '1');
select tests.is('rep Jane sees her 2 assignment rows', tests.q(tests.id('b1'), 'select * from public.assignments'), '2');
select tests.is('admin sees all 5 assignments', tests.q(tests.id('a1'), 'select * from public.assignments'), '5');
select tests.is('client cannot assign themselves',
  tests.x(tests.id('c3'), 'insert into public.assignments (client_email, rep_id) values (''pat.homes@example.com'', ''' || tests.id('b1') || ''')'), 'ERR:42501');
select tests.is('rep adds own unassigned client by email (Pat)',
  tests.x(tests.id('b1'), 'insert into public.assignments (client_email, rep_id) values (''pat.homes@example.com'', ''' || tests.id('b1') || ''')'), 'ok:1');
select tests.is('pre-existing account auto-linked on assignment',
  (select (client_user_id = tests.id('c3'))::text from public.assignments where client_email = 'pat.homes@example.com' and active), 'true');
select tests.is('rep Jane now sees Pat''s quote',
  tests.q(tests.id('b1'), 'select * from public.quotes where owner_id = ''' || tests.id('c3') || ''''), '1');
select tests.is('rep cannot grab another rep''s client (one active rep per client)',
  tests.x(tests.id('b1'), 'insert into public.assignments (client_email, rep_id) values (''omar.broker@example.com'', ''' || tests.id('b1') || ''')'), 'ERR:23505');
select tests.is('rep cannot assign a client to a different rep',
  tests.x(tests.id('b1'), 'insert into public.assignments (client_email, rep_id) values (''new.person@example.com'', ''' || tests.id('b2') || ''')'), 'ERR:42501');
select tests.is('rep cannot update assignments',
  tests.x(tests.id('b1'), 'update public.assignments set active = false'), 'ok:0');
select tests.is('admin reassigns Pat to Marcus via RPC (history kept)',
  tests.x(tests.id('a1'), 'select public.admin_reassign_client(''pat.homes@example.com'', ''' || tests.id('b2') || ''')'), 'ok:1');
select tests.is('old assignment kept inactive, new one active',
  (select count(*)::text from public.assignments where client_email = 'pat.homes@example.com'), '2');
select tests.is('Jane no longer sees Pat''s quote after reassign',
  tests.q(tests.id('b1'), 'select * from public.quotes where owner_id = ''' || tests.id('c3') || ''''), '0');
select tests.is('Marcus now sees Pat''s quote',
  tests.q(tests.id('b2'), 'select * from public.quotes where owner_id = ''' || tests.id('c3') || ''''), '1');
select tests.is('client cannot call admin_reassign_client',
  tests.x(tests.id('c1'), 'select public.admin_reassign_client(''sam.agent@example.com'', ''' || tests.id('b2') || ''')'), 'ERR:42501');
do $$ begin
  begin
    insert into public.assignments (client_email, rep_id) values ('x@example.com', tests.id('c1'));
    perform tests.is('assignment rep must be a rep profile', 'allowed', 'rejected');
  exception when check_violation then
    perform tests.is('assignment rep must be a rep profile', 'rejected', 'rejected');
  end;
end $$;
-- assignment made before the account exists links on sign-up
do $$ declare u uuid := gen_random_uuid(); begin
  -- (her invitation, with a cell number, comes from the seed)
  insert into auth.users (id, email) values (u, 'nina.newagent@example.com');
  perform tests.is('assignment by email links when the client signs up',
    (select (client_user_id = u)::text from public.assignments where client_email = 'nina.newagent@example.com' and active), 'true');
end $$;

-- ---------------- invitations via RPC ----------------
select tests.is('rep invites a client (assigned to self)',
  tests.x(tests.id('b1'), 'select public.create_invitation(''fresh.client@example.com'', ''client'')'), 'ok:1');
select tests.is('invited client is assigned to inviting rep',
  (select (rep_id = tests.id('b1'))::text from public.assignments where client_email = 'fresh.client@example.com' and active), 'true');
select tests.is('rep cannot invite a rep',
  tests.x(tests.id('b1'), 'select public.create_invitation(''new.rep@clatitle.com'', ''rep'')'), 'ERR:42501');
select tests.is('rep cannot invite an admin',
  tests.x(tests.id('b1'), 'select public.create_invitation(''new.admin@clatitle.com'', ''super_admin'')'), 'ERR:42501');
select tests.is('rep cannot invite a client who belongs to another rep',
  tests.x(tests.id('b1'), 'select public.create_invitation(''omar.broker@example.com'', ''client'')'), 'ERR:23505');
select tests.is('client cannot invite',
  tests.x(tests.id('c1'), 'select public.create_invitation(''friend@example.com'', ''client'')'), 'ERR:42501');
select tests.is('admin invites a rep',
  tests.x(tests.id('a1'), 'select public.create_invitation(''new.rep@clatitle.com'', ''rep'')'), 'ok:1');
select tests.is('admin cannot invite a rep with a non-CLA email',
  tests.x(tests.id('a1'), 'select public.create_invitation(''new.rep@gmail.com'', ''rep'')'), 'ERR:22023');
select tests.is('cannot invite an email that already has an account',
  tests.x(tests.id('a1'), 'select public.create_invitation(''sam.agent@example.com'', ''client'')'), 'ERR:23505');
select tests.is('invitations are audited', (select (count(*) >= 2)::text from public.audit_log where action = 'invite_sent'), 'true');
select tests.is('rep sees only own invitations', tests.q(tests.id('b1'), 'select * from public.invitations where invited_by <> ''' || tests.id('b1') || ''''), '0');
select tests.is('client sees no invitations (no policy matches)', tests.q(tests.id('c1'), 'select * from public.invitations'), '0');
select tests.is('nobody can write invitations directly',
  tests.x(tests.id('a1'), 'insert into public.invitations (email, role) values (''direct@example.com'', ''client'')'), 'ERR:42501');

-- ---------------- cell phone (migration 5) ----------------
-- normalizer: formats in, E.164 out; anything not a US 10-digit number is NULL
select tests.is('normalize: (240) 555-0142',      coalesce(private.normalize_us_phone('(240) 555-0142'), 'NULL'), '+12405550142');
select tests.is('normalize: 240.555.0142',        coalesce(private.normalize_us_phone('240.555.0142'), 'NULL'), '+12405550142');
select tests.is('normalize: 1 240 555 0142',      coalesce(private.normalize_us_phone('1 240 555 0142'), 'NULL'), '+12405550142');
select tests.is('normalize: +1 (240) 555-0142',   coalesce(private.normalize_us_phone('+1 (240) 555-0142'), 'NULL'), '+12405550142');
select tests.is('normalize: already E.164',       coalesce(private.normalize_us_phone('+12405550142'), 'NULL'), '+12405550142');
select tests.is('normalize rejects 7 digits',     coalesce(private.normalize_us_phone('555-0142'), 'NULL'), 'NULL');
select tests.is('normalize rejects area code 0xx',coalesce(private.normalize_us_phone('040-555-0142'), 'NULL'), 'NULL');
select tests.is('normalize rejects area code 1xx',coalesce(private.normalize_us_phone('140-555-0142'), 'NULL'), 'NULL');
select tests.is('normalize rejects exchange 1xx', coalesce(private.normalize_us_phone('240-155-0142'), 'NULL'), 'NULL');
select tests.is('normalize rejects extensions',   coalesce(private.normalize_us_phone('240-555-0142 x5'), 'NULL'), 'NULL');
select tests.is('normalize rejects letters',      coalesce(private.normalize_us_phone('call 2405550142'), 'NULL'), 'NULL');
select tests.is('normalize rejects non-US +44',   coalesce(private.normalize_us_phone('+44 20 7946 0958'), 'NULL'), 'NULL');
select tests.is('normalize rejects 12 digits',    coalesce(private.normalize_us_phone('1 1240 555 0142'), 'NULL'), 'NULL');

select tests.is('seed: cell numbers are all E.164 (or null)',
  (select count(*)::text from public.profiles where cell_phone is not null and cell_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'), '0');
select tests.is('seed: Pat has no cell (optional for clients)',
  (select (cell_phone is null)::text from public.profiles where id = tests.id('c3')), 'true');
select tests.is('invitation cell copied to the profile at sign-up (Omar, typed with dashes)',
  (select cell_phone from public.profiles where id = tests.id('c5')), '+17035550172');
select tests.is('invitation cell copied to the profile at sign-up (Nina)',
  (select cell_phone from public.profiles where email = 'nina.newagent@example.com'), '+17035550181');

-- owner edits
select tests.is('client sets own cell typed as (240) 555-0199',
  tests.x(tests.id('c1'), 'update public.profiles set cell_phone = ''(240) 555-0199'' where id = ''' || tests.id('c1') || ''''), 'ok:1');
select tests.is('...and it is stored as +12405550199',
  (select cell_phone from public.profiles where id = tests.id('c1')), '+12405550199');
select tests.is('client cell with letters is rejected (22023)',
  tests.x(tests.id('c1'), 'update public.profiles set cell_phone = ''abc'' where id = ''' || tests.id('c1') || ''''), 'ERR:22023');
select tests.is('client cell with 9 digits is rejected (22023)',
  tests.x(tests.id('c1'), 'update public.profiles set cell_phone = ''240-555-019'' where id = ''' || tests.id('c1') || ''''), 'ERR:22023');
select tests.is('rejected edit left the old value',
  (select cell_phone from public.profiles where id = tests.id('c1')), '+12405550199');
select tests.is('client clears cell with an empty string (stored NULL)',
  tests.x(tests.id('c3'), 'update public.profiles set cell_phone = ''  '' where id = ''' || tests.id('c3') || ''''), 'ok:1');
select tests.is('...NULL',
  (select (cell_phone is null)::text from public.profiles where id = tests.id('c3')), 'true');
select tests.is('client cannot edit another person''s cell',
  tests.x(tests.id('c1'), 'update public.profiles set cell_phone = ''2025550100'' where id = ''' || tests.id('c2') || ''''), 'ok:0');
select tests.is('rep cannot edit a client''s cell',
  tests.x(tests.id('b1'), 'update public.profiles set cell_phone = ''2025550100'' where id = ''' || tests.id('c1') || ''''), 'ok:0');
select tests.is('rep edits own cell',
  tests.x(tests.id('b1'), 'update public.profiles set cell_phone = ''301.555.0112'' where id = ''' || tests.id('b1') || ''''), 'ok:1');
select tests.is('admin can edit a client''s cell (existing admin policy)',
  tests.x(tests.id('a1'), 'update public.profiles set cell_phone = ''2405550132'' where id = ''' || tests.id('c1') || ''''), 'ok:1');
select tests.is('authenticated holds an UPDATE grant on cell_phone only through the column list',
  (select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
    where table_name = 'profiles' and grantee = 'authenticated' and privilege_type = 'UPDATE'
      and column_name in ('cell_phone', 'role', 'email', 'status')), 'cell_phone');
-- CHECK constraint is the backstop if the trigger were ever bypassed
do $$ begin
  alter table public.profiles disable trigger profiles_normalize_cell;
  begin
    update public.profiles set cell_phone = '240-555-0142' where id = tests.id('c2');
    perform tests.is('check constraint rejects a non-E.164 value when the trigger is off', 'allowed', 'rejected');
  exception when check_violation then
    perform tests.is('check constraint rejects a non-E.164 value when the trigger is off', 'rejected', 'rejected');
  end;
  alter table public.profiles enable trigger profiles_normalize_cell;
end $$;

-- visibility follows the existing profile rules
select tests.is('client sees only own cell (1 row with a cell)',
  tests.q(tests.id('c1'), 'select * from public.profiles where cell_phone is not null'), '1');
select tests.is('rep Jane sees cells of self + her clients Sam and Lee (3)',
  tests.q(tests.id('b1'), 'select * from public.profiles where cell_phone is not null'), '3');
select tests.is('rep Jane cannot read Omar''s cell (other rep''s client)',
  tests.q(tests.id('b1'), 'select cell_phone from public.profiles where id = ''' || tests.id('c5') || ''''), '0');
select tests.is('rep Marcus sees cells of self + Dee + Omar + Nina (4)',
  tests.q(tests.id('b2'), 'select * from public.profiles where cell_phone is not null'), '4');
select tests.is('admin sees every cell on file',
  tests.q(tests.id('a1'), 'select * from public.profiles where cell_phone is not null'),
  (select count(*)::text from public.profiles where cell_phone is not null));
select tests.is('anon reads no cell numbers', tests.q(null, 'select cell_phone from public.profiles'), 'ERR:42501');
do $$ declare r text; begin
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id('c1'), 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select first_name || '/' || coalesce(cell_phone, '-') || '/' || coalesce(phone, '-') into r from public.get_my_rep_contact();
  perform set_config('role', 'postgres', true);
  perform tests.is('client Sam gets rep Jane with her cell', r, 'Jane/+13015550112/301-555-0111');
  perform set_config('request.jwt.claims', '', true);
end $$;
do $$ declare r text; u uuid := gen_random_uuid(); begin
  insert into public.invitations (email, role) values ('norep.client@example.com', 'client');
  insert into auth.users (id, email) values (u, 'norep.client@example.com');
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*)::text into r from public.get_my_rep_contact();
  perform set_config('role', 'postgres', true);
  perform tests.is('a client with no rep gets no rep contact', r, '0');
  perform set_config('request.jwt.claims', '', true);
end $$;
select tests.is('get_my_rep_contact returns only name, phones, email, photo path (no company/license)',
  pg_get_function_result('public.get_my_rep_contact'::regproc),
  'TABLE(id uuid, first_name text, last_name text, phone text, cell_phone text, email text, avatar_path text)');
select tests.is('anon cannot call get_my_rep_contact', tests.q(null, 'select * from public.get_my_rep_contact()'), 'ERR:42501');

-- invitations carry an optional cell
select tests.is('rep invites a client with a cell typed (301) 555-0150',
  tests.x(tests.id('b1'), 'select public.create_invitation(''cell.client@example.com'', ''client'', null, ''(301) 555-0150'')'), 'ok:1');
select tests.is('...invitation stores +13015550150',
  (select cell_phone from public.invitations where email = 'cell.client@example.com'), '+13015550150');
select tests.is('rep invite without a cell is fine (NULL)',
  tests.x(tests.id('b1'), 'select public.create_invitation(''nocell.client@example.com'', ''client'')'), 'ok:1');
select tests.is('...NULL',
  (select (cell_phone is null)::text from public.invitations where email = 'nocell.client@example.com'), 'true');
select tests.is('blank cell on an invite is treated as none',
  tests.x(tests.id('b1'), 'select public.create_invitation(''blank.client@example.com'', ''client'', null, ''   '')'), 'ok:1');
select tests.is('invalid cell on an invite is rejected (22023)',
  tests.x(tests.id('b1'), 'select public.create_invitation(''bad.cell@example.com'', ''client'', null, ''12345'')'), 'ERR:22023');
select tests.is('...and no invitation or assignment was left behind',
  (select (select count(*) from public.invitations where email = 'bad.cell@example.com')::text || '/' ||
          (select count(*) from public.assignments where client_email = 'bad.cell@example.com')::text), '0/0');
select tests.is('admin invites a rep with a cell',
  tests.x(tests.id('a1'), 'select public.create_invitation(''cell.rep@clatitle.com'', ''rep'', null, ''703 555 0155'')'), 'ok:1');
select tests.is('re-inviting replaces the pending invitation and its cell',
  tests.x(tests.id('a1'), 'select public.create_invitation(''cell.rep@clatitle.com'', ''rep'', null, ''703 555 0156'')'), 'ok:1');
select tests.is('...one pending invitation, new cell',
  (select count(*)::text || '/' || max(cell_phone) from public.invitations where email = 'cell.rep@clatitle.com' and accepted_at is null), '1/+17035550156');
select tests.is('rep reads own invitation cell (for pending clients)',
  tests.q(tests.id('b1'), 'select * from public.invitations where email = ''cell.client@example.com'' and cell_phone is not null'), '1');
select tests.is('other rep cannot read that invitation',
  tests.q(tests.id('b2'), 'select * from public.invitations where email = ''cell.client@example.com'''), '0');
select tests.is('client cannot read invitations',
  tests.q(tests.id('c1'), 'select cell_phone from public.invitations'), '0');
select tests.is('admin invites a client for Jane with a cell',
  tests.x(tests.id('a1'), 'select public.create_invitation(''admin.sent@example.com'', ''client'', ''' || tests.id('b1') || ''', ''202-555-0188'')'), 'ok:1');
select tests.is('Jane reads the pending invitation of her assigned client although an admin sent it',
  tests.q(tests.id('b1'), 'select * from public.invitations where email = ''admin.sent@example.com'' and cell_phone = ''+12025550188'''), '1');
select tests.is('Marcus does not see it (client is not his)',
  tests.q(tests.id('b2'), 'select * from public.invitations where email = ''admin.sent@example.com'''), '0');
select tests.is('a client cannot read it',
  tests.q(tests.id('c1'), 'select * from public.invitations where email = ''admin.sent@example.com'''), '0');
select tests.is('only one create_invitation overload exists (no ambiguity for PostgREST)',
  (select count(*)::text from pg_proc where proname = 'create_invitation' and pronamespace = 'public'::regnamespace), '1');
do $$ declare u uuid := gen_random_uuid(); begin
  insert into auth.users (id, email) values (u, 'cell.client@example.com');
  perform tests.is('invited client signs up and the profile carries the invited cell',
    (select cell_phone from public.profiles where id = u), '+13015550150');
end $$;

-- ---------------- admin RPCs ----------------
select tests.is('client cannot change roles',
  tests.x(tests.id('c1'), 'select public.admin_set_role(''' || tests.id('c1') || ''', ''super_admin'')'), 'ERR:42501');
select tests.is('rep cannot change roles',
  tests.x(tests.id('b1'), 'select public.admin_set_role(''' || tests.id('c1') || ''', ''super_admin'')'), 'ERR:42501');
select tests.is('admin cannot change own role',
  tests.x(tests.id('a1'), 'select public.admin_set_role(''' || tests.id('a1') || ''', ''client'')'), 'ERR:42501');
select tests.is('admin disables Sam',
  tests.x(tests.id('a1'), 'select public.admin_set_status(''' || tests.id('c1') || ''', ''disabled'')'), 'ok:1');
select tests.is('disabled Sam reads no quotes', tests.q(tests.id('c1'), 'select * from public.quotes'), '0');
select tests.is('disabled Sam cannot save a quote',
  tests.x(tests.id('c1'), 'insert into public.quotes (quote_type) values (''buyer'')'), 'ERR:42501');
select tests.is('rep still sees a disabled client''s quotes (assignment unchanged)',
  tests.q(tests.id('b1'), 'select * from public.quotes where owner_id = ''' || tests.id('c1') || ''''), '2');
select tests.is('admin re-enables Sam',
  tests.x(tests.id('a1'), 'select public.admin_set_status(''' || tests.id('c1') || ''', ''active'')'), 'ok:1');
select tests.is('role + status changes audited',
  (select count(*)::text from public.audit_log where action in ('user_disabled', 'user_enabled')), '2');
select tests.is('admin changes a role (Pat -> rep fails: not CLA email)',
  tests.x(tests.id('a1'), 'select public.admin_set_role(''' || tests.id('c3') || ''', ''rep'')'), 'ERR:23514');
select tests.is('admin disables rep Marcus', tests.x(tests.id('a1'), 'select public.admin_set_status(''' || tests.id('b2') || ''', ''disabled'')'), 'ok:1');
select tests.is('disabled rep sees no clients/quotes', tests.q(tests.id('b2'), 'select * from public.quotes'), '0');
select tests.x(tests.id('a1'), 'select public.admin_set_status(''' || tests.id('b2') || ''', ''active'')');
select tests.is('admin logs a quote view',
  tests.x(tests.id('a1'), 'select public.admin_log_quote_view(''00000000-0000-4000-8000-00000000f005'')'), 'ok:1');
select tests.is('rep cannot log admin quote views',
  tests.x(tests.id('b1'), 'select public.admin_log_quote_view(''00000000-0000-4000-8000-00000000f005'')'), 'ERR:42501');

-- ---------------- audit log ----------------
select tests.is('admin reads audit log', (select (tests.q(tests.id('a1'), 'select * from public.audit_log')::int > 5)::text), 'true');
select tests.is('rep cannot read audit log', tests.q(tests.id('b1'), 'select * from public.audit_log'), '0');
select tests.is('client cannot read audit log', tests.q(tests.id('c1'), 'select * from public.audit_log'), '0');
select tests.is('admin cannot insert audit rows',
  tests.x(tests.id('a1'), 'insert into public.audit_log (action) values (''export_run'')'), 'ERR:42501');
select tests.is('admin cannot update audit rows',
  tests.x(tests.id('a1'), 'update public.audit_log set action = ''export_run'''), 'ERR:42501');
do $$ begin
  begin delete from public.audit_log; perform tests.is('audit_log delete blocked by trigger', 'allowed', 'blocked');
  exception when insufficient_privilege then perform tests.is('audit_log delete blocked by trigger', 'blocked', 'blocked'); end;
end $$;

-- ---------------- admin MFA switch ----------------
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
select tests.is('MFA required: admin at aal1 sees only self-level (none of others'' quotes)', tests.q(tests.id('a1'), 'select * from public.quotes where owner_id <> ''' || tests.id('a1') || ''''), '0');
select tests.is('MFA required: admin at aal2 sees quotes', (tests.q(tests.id('a1'), 'select * from public.quotes', 'aal2')::int > 0)::text, 'true');
select tests.is('MFA required: admin at aal1 cannot call admin RPC',
  tests.x(tests.id('a1'), 'select public.admin_set_status(''' || tests.id('c3') || ''', ''disabled'')', 'aal1'), 'ERR:42501');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';

-- ---------------- photos metadata ----------------
select tests.is('client uploads own photo row',
  tests.x(tests.id('c2'), 'insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (''' || tests.id('c2') || ''', ''' || tests.id('c2') || '/avatar'', ''image/jpeg'', 100000)'), 'ok:1');
select tests.is('photo trigger sets profile avatar_path',
  (select avatar_path from public.profiles where id = tests.id('c2')), tests.id('c2')::text || '/avatar');
select tests.is('photo row rejects GIF',
  tests.x(tests.id('c3'), 'insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (''' || tests.id('c3') || ''', ''' || tests.id('c3') || '/avatar'', ''image/gif'', 1000)'), 'ERR:23514');
select tests.is('photo row rejects 3 MB',
  tests.x(tests.id('c3'), 'insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (''' || tests.id('c3') || ''', ''' || tests.id('c3') || '/avatar'', ''image/png'', 3145728)'), 'ERR:23514');
select tests.is('cannot add a photo row for someone else',
  tests.x(tests.id('c3'), 'insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (''' || tests.id('c1') || ''', ''' || tests.id('c1') || '/avatar'', ''image/png'', 1000)'), 'ERR:42501');
select tests.is('photo path must be <uid>/avatar',
  tests.x(tests.id('c3'), 'insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (''' || tests.id('c3') || ''', ''elsewhere/x.png'', ''image/png'', 1000)'), 'ERR:23514');
select tests.is('Lee''s rep Jane can read Lee''s photo row', tests.q(tests.id('b1'), 'select * from public.photos where owner_id = ''' || tests.id('c2') || ''''), '1');
select tests.is('Marcus (not her rep) cannot read Lee''s photo row', tests.q(tests.id('b2'), 'select * from public.photos where owner_id = ''' || tests.id('c2') || ''''), '0');
select tests.is('Lee can read her rep Jane''s photo row', tests.q(tests.id('c2'), 'select * from public.photos where owner_id = ''' || tests.id('b1') || ''''), '1');
select tests.is('Pat cannot read Jane''s photo row (not her rep)', tests.q(tests.id('c3'), 'select * from public.photos where owner_id = ''' || tests.id('b1') || ''''), '0');
select tests.is('admin removes any photo',
  tests.x(tests.id('a1'), 'delete from public.photos where owner_id = ''' || tests.id('c2') || ''''), 'ok:1');
select tests.is('avatar_path cleared when photo removed', (select coalesce(avatar_path, 'null') from public.profiles where id = tests.id('c2')), 'null');

-- ---------------- storage policies ----------------
select tests.is('bucket is private, 2 MB, jpeg/png only',
  (select (not public)::text || '/' || file_size_limit || '/' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'avatars'),
  'true/2097152/image/jpeg,image/png');
insert into storage.objects (bucket_id, name) values
  ('avatars', tests.id('b1') || '/avatar'), ('avatars', tests.id('c1') || '/avatar'), ('avatars', tests.id('c3') || '/avatar');
select tests.is('owner reads own photo object', tests.q(tests.id('c3'), 'select * from storage.objects'), '1');
select tests.is('Sam reads own + her rep Jane''s object (2)', tests.q(tests.id('c1'), 'select * from storage.objects'), '2');
select tests.is('Jane reads own + Sam''s object (Lee has none; Pat is Marcus''s) (2)', tests.q(tests.id('b1'), 'select * from storage.objects'), '2');
select tests.is('Marcus reads only own folder + his clients (Pat/Omar/Nina): Pat''s object (1)', tests.q(tests.id('b2'), 'select * from storage.objects'), '1');
select tests.is('admin reads all objects', tests.q(tests.id('a1'), 'select * from storage.objects'), '3');
select tests.is('anon reads no objects', tests.q(null, 'select * from storage.objects'), 'ERR:42501');
select tests.is('upload into own folder at <uid>/avatar',
  tests.x(tests.id('c2'), 'insert into storage.objects (bucket_id, name) values (''avatars'', ''' || tests.id('c2') || '/avatar'')'), 'ok:1');
select tests.is('upload into someone else''s folder blocked',
  tests.x(tests.id('c2'), 'insert into storage.objects (bucket_id, name) values (''avatars'', ''' || tests.id('c1') || '/avatar'')'), 'ERR:42501');
select tests.is('upload with other file name blocked',
  tests.x(tests.id('c2'), 'insert into storage.objects (bucket_id, name) values (''avatars'', ''' || tests.id('c2') || '/resume.pdf'')'), 'ERR:42501');
select tests.is('upload to another bucket path blocked (policy is avatars-only)',
  tests.x(tests.id('c2'), 'insert into storage.objects (bucket_id, name) values (''documents'', ''x/y'')'), 'ERR:42501');
select tests.is('owner cannot overwrite someone else''s object',
  tests.x(tests.id('c2'), 'update storage.objects set metadata = ''{}'' where name = ''' || tests.id('c1') || '/avatar'''), 'ok:0');
select tests.is('owner deletes own object',
  tests.x(tests.id('c2'), 'delete from storage.objects where name = ''' || tests.id('c2') || '/avatar'''), 'ok:1');
select tests.is('rep cannot delete a client''s object',
  tests.x(tests.id('b1'), 'delete from storage.objects where name = ''' || tests.id('c1') || '/avatar'''), 'ok:0');
select tests.is('admin deletes any object',
  tests.x(tests.id('a1'), 'delete from storage.objects where name = ''' || tests.id('c3') || '/avatar'''), 'ok:1');

-- ---------------- app_settings / privileges ----------------
select tests.is('app_settings not readable by users', tests.q(tests.id('a1'), 'select * from public.app_settings'), 'ERR:42501');
select tests.is('private helpers not callable by anon', tests.q(null, 'select private.is_admin()'), 'ERR:42501');
select tests.is('private.audit not callable by users', tests.q(tests.id('a1'), 'select private.audit(''export_run'', ''x'', null)'), 'ERR:42501');
select tests.is('every public table has RLS enabled',
  (select count(*)::text from pg_tables where schemaname = 'public' and not rowsecurity), '0');

-- ---------------- cron ----------------
select tests.is('pg_cron job scheduled (or pg_cron absent in this environment)',
  (select case when exists (select 1 from pg_extension where extname = 'pg_cron')
     then (select count(*)::text from cron.job where jobname = 'purge-expired-quotes' and command like '%purge_expired_quotes%')
     else '1' end), '1');

-- ---------------- summary ----------------
do $$ declare f int; t int; begin
  select count(*) filter (where not ok), count(*) into f, t from tests.results;
  raise notice '% checks, % failed', t, f;
  if f > 0 then raise exception '% access-rule check(s) failed', f; end if;
end $$;

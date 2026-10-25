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
-- super admin a1 (ALSO a rep, is_rep; clients c6 quinn + pending rae) | admin a2 Robin (plain admin, migration 10) | reps b1 jane, b2 marcus | clients c1 sam, c2 lee, c3 pat (unassigned), c4 dee (disabled, marcus), c5 omar (marcus)

-- ---------------- sanity: seed shape ----------------
select tests.is('seed: 11 quotes inserted',   (select count(*)::text from public.quotes), '11');
select tests.is('seed: expires_at = created_at + 30 days on every quote',
  (select count(*)::text from public.quotes where expires_at = created_at + interval '30 days'), '11');
select tests.is('seed: client_user_id linked for existing clients',
  (select count(*)::text from public.assignments where client_user_id is not null), '5');
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
select tests.is('admin sees all 12 profiles (10 seeded + 2 signed up earlier in this test)',
  tests.q(tests.id('a1'), 'select * from public.profiles'), '12');
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
select tests.is('admin sees all non-expired quotes incl. soft-deleted (10)', tests.q(tests.id('a1'), 'select * from public.quotes'), '10');
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
select tests.is('admin sees all 7 assignments', tests.q(tests.id('a1'), 'select * from public.assignments'), '7');
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
-- the sample admin is also a rep: at aal1 the admin policies are off, but the REP policies still apply, so exactly her own client Quinn's quote (1) is visible, nothing else
select tests.is('MFA required: admin+rep at aal1 sees only rep-level quotes (own client Quinn, 1), none of the others''', tests.q(tests.id('a1'), 'select * from public.quotes where owner_id <> ''' || tests.id('a1') || ''''), '1');
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


-- =====================================================================
-- Admin who ALSO works as a rep (migration 6): profiles.is_rep
-- =====================================================================
-- first value of a query, run as a user ('ERR:<sqlstate>' on error)
create function tests.v(uid uuid, sql text, aal text default 'aal1') returns text language plpgsql as $$
declare res text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
  perform set_config('role', 'authenticated', true);
  begin execute sql into res; exception when others then res := 'ERR:' || sqlstate; end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return coalesce(res, 'null');
end $$;

-- run a DML/RPC statement as a user, THEN read a value (fresh snapshot): 'ok:<rows>/<value>'
create function tests.xv(uid uuid, dml text, readsql text) returns text language plpgsql as $$
declare r text; v text;
begin
  r := tests.x(uid, dml);
  execute readsql into v;
  return r || '/' || coalesce(v, 'null');
end $$;

-- ---------------- the flag and its guards ----------------
select tests.is('seed: admin Alex is a super admin with is_rep',
  (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a1')), 'super_admin/true');
select tests.is('every role=rep profile has is_rep (backfill + trigger)',
  (select count(*)::text from public.profiles where role = 'rep' and not is_rep), '0');
select tests.is('no client has is_rep', (select count(*)::text from public.profiles where role = 'client' and is_rep), '0');
select tests.is('invitation carried is_rep to the profile (Alex signed up via a flagged invitation)',
  (select is_rep::text from public.invitations where email = 'sample.admin@clatitle.com'), 'true');
select tests.is('Alex is_complete (has a phone)', (select is_complete::text from public.profiles where id = tests.id('a1')), 'true');
-- a client can never be a rep: the trigger forces false ...
update public.profiles set is_rep = true where id = tests.id('c3');
select tests.is('trigger forces is_rep=false for a client', (select is_rep::text from public.profiles where id = tests.id('c3')), 'false');
-- ... and the CHECK constraint is the backstop if the trigger were ever bypassed
alter table public.profiles disable trigger profiles_rep_flag_trg;
do $$ begin
  begin update public.profiles set is_rep = true where id = tests.id('c3');
    perform tests.is('CHECK: a client cannot be a rep (trigger bypassed)', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('CHECK: a client cannot be a rep (trigger bypassed)', 'rejected', 'rejected'); end;
  begin update public.profiles set is_rep = false where id = tests.id('b1');
    perform tests.is('CHECK: a rep cannot lose is_rep (trigger bypassed)', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('CHECK: a rep cannot lose is_rep (trigger bypassed)', 'rejected', 'rejected'); end;
end $$;
alter table public.profiles enable trigger profiles_rep_flag_trg;
do $$ begin
  begin insert into public.invitations (email, role, is_rep) values ('client.rep@example.com', 'client', true);
    perform tests.is('invitation: a client cannot be flagged rep', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('invitation: a client cannot be flagged rep', 'rejected', 'rejected'); end;
  begin insert into public.invitations (email, role, is_rep) values ('not.cla@example.com', 'super_admin', true);
    perform tests.is('invitation: flagged rep needs @clatitle.com', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('invitation: flagged rep needs @clatitle.com', 'rejected', 'rejected'); end;
end $$;
select tests.is('nobody flips is_rep through the API (column not granted): Alex herself',
  tests.x(tests.id('a1'), 'update public.profiles set is_rep = false where id = ''' || tests.id('a1') || ''''), 'ERR:42501');
select tests.is('a rep cannot flip is_rep through the API',
  tests.x(tests.id('b1'), 'update public.profiles set is_rep = true where id = ''' || tests.id('b1') || ''''), 'ERR:42501');
select tests.is('a client cannot flip is_rep through the API',
  tests.x(tests.id('c1'), 'update public.profiles set is_rep = true where id = ''' || tests.id('c1') || ''''), 'ERR:42501');

-- more people sign up the normal way: a plain super admin (d1), an admin flagged on the invitation (d2), a non-CLA admin (d3)
insert into public.invitations (email, role, is_rep) values
  ('plain.admin@clatitle.com', 'super_admin', false), ('flag.admin@clatitle.com', 'super_admin', true), ('outside.admin@example.com', 'super_admin', false);
insert into auth.users (id, email) values
  (tests.id('d1'), 'plain.admin@clatitle.com'), (tests.id('d2'), 'flag.admin@clatitle.com'), (tests.id('d3'), 'outside.admin@example.com');
update public.profiles set first_name = 'Pia', last_name = 'Plain', phone = '301-555-0199' where id = tests.id('d1');
update public.profiles set first_name = 'Flo', last_name = 'Flag' where id = tests.id('d2');
update public.profiles set first_name = 'Otto', last_name = 'Outside', phone = '301-555-0198' where id = tests.id('d3');
select tests.is('plain super admin: not a rep', (select is_rep::text from public.profiles where id = tests.id('d1')), 'false');
select tests.is('flagged invitation: new super admin is a rep from day one', (select is_rep::text from public.profiles where id = tests.id('d2')), 'true');
select tests.is('sign-up audit row records is_rep',
  (select details ->> 'is_rep' from public.audit_log where action = 'profile_created' and target_id = tests.id('d2')), 'true');
select tests.is('is_complete: admin+rep without a phone is NOT complete', (select is_complete::text from public.profiles where id = tests.id('d2')), 'false');
update public.profiles set phone = null where id = tests.id('d1');
select tests.is('is_complete: a plain admin does not need a phone', (select is_complete::text from public.profiles where id = tests.id('d1')), 'true');

-- ---------------- who is "a rep" ----------------
select tests.is('private.is_rep(): Alex (admin+rep) yes', tests.v(tests.id('a1'), 'select private.is_rep()::text'), 'true');
select tests.is('private.is_rep(): plain admin no',      tests.v(tests.id('d1'), 'select private.is_rep()::text'), 'false');
select tests.is('private.is_rep(): rep Jane yes',        tests.v(tests.id('b1'), 'select private.is_rep()::text'), 'true');
select tests.is('private.is_rep(): client no',           tests.v(tests.id('c1'), 'select private.is_rep()::text'), 'false');
select tests.is('private.is_admin(): Alex is still an admin', tests.v(tests.id('a1'), 'select private.is_admin()::text'), 'true');

-- ---------------- admin_set_is_rep ----------------
select tests.is('rep cannot call admin_set_is_rep', tests.x(tests.id('b1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)'), 'ERR:42501');
select tests.is('client cannot call admin_set_is_rep', tests.x(tests.id('c1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)'), 'ERR:42501');
select tests.is('anon cannot call admin_set_is_rep', tests.x(null, 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)'), 'ERR:42501');
select tests.is('only super admins can be switched: a rep', tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('b1') || ''', false)'), 'ERR:23514');
select tests.is('only super admins can be switched: a client', tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('c1') || ''', true)'), 'ERR:23514');
select tests.is('rep access needs a CLA email', tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('d3') || ''', true)'), 'ERR:23514');
select tests.is('unknown user', tests.x(tests.id('a1'), 'select public.admin_set_is_rep(gen_random_uuid(), true)'), 'ERR:P0002');
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
select tests.is('MFA required: admin+rep at aal1 cannot call admin_set_is_rep (rep access is not admin access)',
  tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)', 'aal1'), 'ERR:42501');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';
select tests.is('admin switches plain admin Pia on', tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)'), 'ok:1');
select tests.is('...she is now a rep', (select is_rep::text from public.profiles where id = tests.id('d1')), 'true');
select tests.is('...and the change is audited (before > after)',
  (select (details ->> 'before') || '>' || (details ->> 'after') from public.audit_log where action = 'rep_flag_changed' and target_id = tests.id('d1')), 'false>true');
select tests.is('switching to the same value is a harmless no-op (no second audit row)',
  tests.xv(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)', $q$select count(*)::text from public.audit_log where action = 'rep_flag_changed' and target_id = tests.id('d1')$q$), 'ok:1/1');
update public.profiles set is_rep = false where id = tests.id('d1');   -- back to a plain admin for the rest

-- ---------------- Alex acting as a rep (MFA on, aal1 = admin policies off, rep policies only) ----------------
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
select tests.is('rep-only view: Alex sees herself + client Quinn (2 profiles)', tests.q(tests.id('a1'), 'select * from public.profiles'), '2');
select tests.is('rep-only view: Alex sees her 2 assignments (Quinn, pending Rae)', tests.q(tests.id('a1'), 'select * from public.assignments'), '2');
select tests.is('rep-only view: Alex sees own quote + Quinn''s (2)', tests.q(tests.id('a1'), 'select * from public.quotes'), '2');
select tests.is('rep-only view: Alex cannot see Sam (Jane''s client)',
  tests.q(tests.id('a1'), 'select * from public.quotes where owner_id = ''' || tests.id('c1') || ''''), '0');
select tests.is('rep-only view: Alex reads Rae''s pending invitation (cell), not Nina''s (Marcus''s client)',
  tests.q(tests.id('a1'), 'select * from public.invitations where email = ''rae.pending@example.com''') || '/' ||
  tests.q(tests.id('a1'), 'select * from public.invitations where email = ''nina.newagent@example.com'''), '1/0');
select tests.is('rep-only view: Alex cannot read the audit log', tests.q(tests.id('a1'), 'select * from public.audit_log'), '0');
select tests.is('rep-only view: Alex cannot use the admin reassign RPC',
  tests.x(tests.id('a1'), 'select public.admin_reassign_client(''pat.homes@example.com'', ''' || tests.id('a1') || ''')'), 'ERR:42501');
select tests.is('rep-only view: Alex adds her own client by email', tests.x(tests.id('a1'),
  'insert into public.assignments (client_email, rep_id) values (''self.added@example.com'', ''' || tests.id('a1') || ''')'), 'ok:1');
select tests.is('rep-only view: Alex cannot assign a client to Jane',
  tests.x(tests.id('a1'), 'insert into public.assignments (client_email, rep_id) values (''for.jane@example.com'', ''' || tests.id('b1') || ''')'), 'ERR:42501');
-- a plain admin (not a rep) at aal1 under MFA has NO rep powers at all
select tests.is('MFA on, plain admin at aal1: sees only herself', tests.q(tests.id('d1'), 'select * from public.profiles'), '1');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';
delete from public.assignments where client_email = 'self.added@example.com';
select tests.is('admin view: Alex still sees everything (all profiles)', (tests.q(tests.id('a1'), 'select * from public.profiles')::int >= 14)::text, 'true');

-- ---------------- the client's side: Quinn's rep is Alex ----------------
do $$ declare r text; begin
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id('c6'), 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select first_name || '/' || coalesce(phone, '') || '/' || coalesce(cell_phone, '') || '/' || coalesce(avatar_path, '-') into r from public.get_my_rep_contact();
  perform set_config('role', 'postgres', true);
  perform tests.is('client Quinn: get_my_rep_contact returns Alex (name, office phone, cell, photo path)', r,
    'Alex/301-555-0100/+13015550101/' || tests.id('a1') || '/avatar');
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id('c6'), 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select first_name into r from public.get_my_rep();
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform tests.is('client Quinn: get_my_rep returns Alex too', r, 'Alex');
end $$;
select tests.is('Quinn can read Alex''s photo row (paired as rep/client)', tests.q(tests.id('c6'), 'select * from public.photos where owner_id = ''' || tests.id('a1') || ''''), '1');
select tests.is('Pat cannot read Alex''s photo row', tests.q(tests.id('c3'), 'select * from public.photos where owner_id = ''' || tests.id('a1') || ''''), '0');
insert into storage.objects (bucket_id, name) values ('avatars', tests.id('a1') || '/avatar');
select tests.is('Quinn can read Alex''s photo object (storage policy)', tests.q(tests.id('c6'), 'select * from storage.objects where name = ''' || tests.id('a1') || '/avatar'''), '1');
select tests.is('Pat cannot read Alex''s photo object', tests.q(tests.id('c3'), 'select * from storage.objects where name = ''' || tests.id('a1') || '/avatar'''), '0');

-- ---------------- quotes: rep_id ----------------
select tests.is('seed: Quinn''s quote carries Alex as rep (co-branding)',
  (select rep_id::text from public.quotes where id = '00000000-0000-4000-8000-00000000f00a'), tests.id('a1')::text);
select tests.is('seed: Alex''s own quote has rep_id = Alex (like a rep)',
  (select rep_id::text from public.quotes where id = '00000000-0000-4000-8000-00000000f00b'), tests.id('a1')::text);
select tests.is('Quinn saves a quote through the API', tests.x(tests.id('c6'), 'insert into public.quotes (quote_type, label) values (''buyer'', ''quinn api'')'), 'ok:1');
select tests.is('...rep_id = Alex', (select rep_id::text from public.quotes where label = 'quinn api'), tests.id('a1')::text);
select tests.is('Alex saves her own quote through the API', tests.x(tests.id('a1'), 'insert into public.quotes (quote_type, label) values (''buyer'', ''alex api'')'), 'ok:1');
select tests.is('...rep_id = Alex', (select rep_id::text from public.quotes where label = 'alex api'), tests.id('a1')::text);
select tests.is('a plain admin''s own quote has no rep_id',
  tests.xv(tests.id('d1'), 'insert into public.quotes (quote_type, label) values (''buyer'', ''plain admin'')', $q$select coalesce(rep_id::text, 'null') from public.quotes where label = 'plain admin'$q$), 'ok:1/null');

-- ---------------- assignments: who can be a rep ----------------
select tests.is('admin assigns a client to Alex', tests.x(tests.id('a1'), 'select public.admin_reassign_client(''pat.homes@example.com'', ''' || tests.id('a1') || ''')'), 'ok:1');
select tests.is('...Pat''s rep is now Alex', (select rep_id::text from public.assignments where client_email = 'pat.homes@example.com' and active), tests.id('a1')::text);
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
select tests.is('...rep-only Alex now sees Pat''s quote', tests.q(tests.id('a1'), 'select * from public.quotes where owner_id = ''' || tests.id('c3') || ''''), '1');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';
select tests.is('a super admin who is NOT a rep cannot be assigned clients (RPC)',
  tests.x(tests.id('a1'), 'select public.admin_reassign_client(''pat.homes@example.com'', ''' || tests.id('d1') || ''')'), 'ERR:23514');
select tests.is('...and Pat is still Alex''s',
  (select rep_id::text from public.assignments where client_email = 'pat.homes@example.com' and active), tests.id('a1')::text);
do $$ begin
  begin insert into public.assignments (client_email, rep_id) values ('x.direct@example.com', tests.id('d1'));
    perform tests.is('trigger: assignments.rep_id must be rep-capable (plain admin)', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('trigger: assignments.rep_id must be rep-capable (plain admin)', 'rejected', 'rejected'); end;
  begin insert into public.assignments (client_email, rep_id) values ('x.direct@example.com', tests.id('c1'));
    perform tests.is('trigger: assignments.rep_id must be rep-capable (client)', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('trigger: assignments.rep_id must be rep-capable (client)', 'rejected', 'rejected'); end;
end $$;
select tests.is('switching rep access OFF with active clients is refused (Alex)',
  tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('a1') || ''', false)'), 'ERR:55006');
select tests.is('...Alex is still a rep', (select is_rep::text from public.profiles where id = tests.id('a1')), 'true');

-- ---------------- inviting ----------------
select tests.is('Alex invites a client from the rep dashboard (as_rep): assigned to herself',
  tests.xv(tests.id('a1'), 'select public.create_invitation(''as.rep.client@example.com'', ''client'', null, ''703-555-0140'', false, true)', $q$select rep_id::text from public.assignments where client_email = 'as.rep.client@example.com' and active$q$), 'ok:1/' || tests.id('a1'));
select tests.is('...with the cell stored as E.164', (select cell_phone from public.invitations where email = 'as.rep.client@example.com'), '+17035550140');
select tests.x(tests.id('b2'), 'select public.create_invitation(''marcus.owned@example.com'', ''client'')');
select tests.is('as_rep: Alex cannot take over another rep''s client',
  tests.x(tests.id('a1'), 'select public.create_invitation(''marcus.owned@example.com'', ''client'', null, null, false, true)'), 'ERR:23505');
select tests.is('as_rep: Alex cannot invite a rep', tests.x(tests.id('a1'), 'select public.create_invitation(''new.rep@clatitle.com'', ''rep'', null, null, false, true)'), 'ERR:42501');
select tests.is('as_rep: Alex cannot invite an admin', tests.x(tests.id('a1'), 'select public.create_invitation(''new.admin@clatitle.com'', ''super_admin'', null, null, false, true)'), 'ERR:42501');
select tests.is('as_rep needs the caller to be a rep (plain admin Otto)', tests.x(tests.id('d3'), 'select public.create_invitation(''o.client@example.com'', ''client'', null, null, false, true)'), 'ERR:42501');
select tests.is('a client cannot use as_rep', tests.x(tests.id('c1'), 'select public.create_invitation(''o.client@example.com'', ''client'', null, null, false, true)'), 'ERR:42501');
select tests.is('Alex acting as admin (no as_rep) may reassign: explicit rep takes over the pending client',
  tests.xv(tests.id('a1'), 'select public.create_invitation(''marcus.owned@example.com'', ''client'', ''' || tests.id('a1') || ''')', $q$select rep_id::text from public.assignments where client_email = 'marcus.owned@example.com' and active$q$), 'ok:1/' || tests.id('a1'));
select tests.is('admin invites a super admin who also works as a rep',
  tests.xv(tests.id('a1'), 'select public.create_invitation(''new.admin.rep@clatitle.com'', ''super_admin'', null, null, true)', $q$select is_rep::text from public.invitations where email = 'new.admin.rep@clatitle.com'$q$), 'ok:1/true');
select tests.is('p_is_rep with a non-CLA email is refused', tests.x(tests.id('a1'), 'select public.create_invitation(''new.admin@example.com'', ''super_admin'', null, null, true)'), 'ERR:22023');
select tests.is('p_is_rep with the client role is refused', tests.x(tests.id('a1'), 'select public.create_invitation(''c.flag@example.com'', ''client'', null, null, true)'), 'ERR:42501');
select tests.is('a rep cannot invite flagged admins', tests.x(tests.id('b1'), 'select public.create_invitation(''new.admin2@clatitle.com'', ''super_admin'', null, null, true)'), 'ERR:42501');
select tests.is('a rep invitation is stored with is_rep = true',
  tests.xv(tests.id('a1'), 'select public.create_invitation(''new.rep2@clatitle.com'', ''rep'')', $q$select is_rep::text from public.invitations where email = 'new.rep2@clatitle.com'$q$), 'ok:1/true');
select tests.is('a plain admin invitation is is_rep = false',
  tests.xv(tests.id('a1'), 'select public.create_invitation(''new.plain@clatitle.com'', ''super_admin'')', $q$select is_rep::text from public.invitations where email = 'new.plain@clatitle.com'$q$), 'ok:1/false');
select tests.is('there is exactly one create_invitation (no stale overloads)',
  (select count(*)::text from pg_proc where proname = 'create_invitation' and pronamespace = 'public'::regnamespace), '1');

-- ---------------- role changes keep the flag consistent ----------------
select tests.is('admin demotes flagged admin Flo to client: is_rep forced false',
  tests.xv(tests.id('a1'), 'select public.admin_set_role(''' || tests.id('d2') || ''', ''client'')', $q$select is_rep::text from public.profiles where id = tests.id('d2')$q$), 'ok:1/false');
select tests.is('...back to super admin: stays false (switch it on again on purpose)',
  tests.xv(tests.id('a1'), 'select public.admin_set_role(''' || tests.id('d2') || ''', ''super_admin'')', $q$select is_rep::text from public.profiles where id = tests.id('d2')$q$), 'ok:1/false');
select tests.is('promoting a CLA super admin to rep sets is_rep',
  tests.xv(tests.id('a1'), 'select public.admin_set_role(''' || tests.id('d2') || ''', ''rep'')', $q$select is_rep::text from public.profiles where id = tests.id('d2')$q$), 'ok:1/true');
select tests.is('a rep promoted to super admin keeps rep access (their clients stay theirs)',
  tests.xv(tests.id('a1'), 'select public.admin_set_role(''' || tests.id('d2') || ''', ''super_admin'')', $q$select is_rep::text from public.profiles where id = tests.id('d2')$q$), 'ok:1/true');

-- ---------------- disabled admin+rep ----------------
select tests.is('admin disables Alex', tests.x(tests.id('d2'), 'select public.admin_set_status(''' || tests.id('a1') || ''', ''disabled'')'), 'ok:1');
select tests.is('disabled Alex has no rep and no admin powers',
  tests.v(tests.id('a1'), 'select private.is_rep()::text') || '/' || tests.q(tests.id('a1'), 'select * from public.quotes'), 'false/0');
select tests.is('a disabled rep is not shown as the client''s rep', tests.q(tests.id('c6'), 'select * from public.get_my_rep()'), '0');
select tests.is('admin re-enables Alex', tests.x(tests.id('d2'), 'select public.admin_set_status(''' || tests.id('a1') || ''', ''active'')'), 'ok:1');
select tests.is('...Quinn has her rep back', tests.q(tests.id('c6'), 'select * from public.get_my_rep()'), '1');

-- ---------------- switching off once the clients are moved ----------------
select tests.is('Pia can be switched on and off while she has no clients',
  tests.x(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', true)') || '/' ||
  tests.xv(tests.id('a1'), 'select public.admin_set_is_rep(''' || tests.id('d1') || ''', false)', $q$select is_rep::text from public.profiles where id = tests.id('d1')$q$), 'ok:1/ok:1/false');
update public.assignments set active = false where rep_id = tests.id('a1') and active;
select tests.is('after Alex''s clients are moved away she can switch rep access off',
  tests.xv(tests.id('d2'), 'select public.admin_set_is_rep(''' || tests.id('a1') || ''', false)', $q$select is_rep::text from public.profiles where id = tests.id('a1')$q$), 'ok:1/false');
select tests.is('...and Alex is an admin only again: private.is_rep() false', tests.v(tests.id('a1'), 'select private.is_rep()::text'), 'false');
select tests.is('...her old quote keeps its rep_id (immutable history)', (select rep_id::text from public.quotes where id = '00000000-0000-4000-8000-00000000f00b'), tests.id('a1')::text);
select tests.is('function privileges: new RPCs are not callable by anon, are by authenticated',
  (select (not has_function_privilege('anon', 'public.admin_set_is_rep(uuid, boolean, uuid)', 'execute')
       and not has_function_privilege('anon', 'public.create_invitation(text, public.user_role, uuid, text, boolean, boolean)', 'execute')
       and has_function_privilege('authenticated', 'public.admin_set_is_rep(uuid, boolean, uuid)', 'execute'))::text), 'true');


-- =====================================================================
-- The "admin" role (migrations 9 + 10): full dashboard, over reps and clients (migration 11 adds: and other admins, below)
-- Cast: admin a2 Robin (seeded) | admin a3 Ada (signs up here) | super admins a1 Alex, d1 Pia, d2 Flo, d3 Otto
--       rep b1 Jane | clients c1 Sam, c3 Pat | e1 a client with a CLA address (so a role change to rep is possible)
-- =====================================================================
-- run a statement as the current (server-side) session; 'ok' or 'ERR:<sqlstate>'
create function tests.p(sql text) returns text language plpgsql as $$
begin execute sql; return 'ok'; exception when others then return 'ERR:' || sqlstate; end $$;
-- quoted uuid literal for building statements
create function tests.u(k text) returns text language sql as $$ select '''' || tests.id(k)::text || '''' $$;

-- ---------------- the enum, the seed, sign-up ----------------
select tests.is('enum user_role = super_admin, admin, rep, client',
  (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum where enumtypid = 'public.user_role'::regtype), 'super_admin,admin,rep,client');
select tests.is('seed: Robin is an admin and not a rep', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a2')), 'admin/false');
insert into public.invitations (email, role) values ('ada.admin@clatitle.com', 'admin'), ('cla.client@clatitle.com', 'client');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (tests.id('a3'), 'ada.admin@clatitle.com', '{"role":"super_admin"}', '{"role":"super_admin"}'),
         (tests.id('e1'), 'cla.client@clatitle.com', '{}', '{}');
update public.profiles set first_name = 'Ada', last_name = 'Admin' where id = tests.id('a3');
update public.profiles set first_name = 'Cleo', last_name = 'Client' where id = tests.id('e1');
select tests.is('an admin invitation signs up as an admin (role from the invitation; metadata saying super_admin is ignored)',
  (select role::text from public.profiles where id = tests.id('a3')), 'admin');
select tests.is('a CLA address can be an admin without being a rep', (select is_rep::text from public.profiles where id = tests.id('a3')), 'false');
select tests.is('sign-up audit row records the admin role', (select details ->> 'role' from public.audit_log where action = 'profile_created' and target_id = tests.id('a3')), 'admin');
select tests.is('is_complete: an admin needs no phone', (select is_complete::text from public.profiles where id = tests.id('a3')), 'true');
do $$ begin
  begin insert into public.invitations (email, role, is_rep) values ('x.admin@example.com', 'admin', true);
    perform tests.is('invitation: an admin flagged rep needs @clatitle.com', 'allowed', 'rejected');
  exception when check_violation then perform tests.is('invitation: an admin flagged rep needs @clatitle.com', 'rejected', 'rejected'); end;
  begin insert into public.invitations (email, role) values ('plain.admin.ok@example.com', 'admin');
    perform tests.is('invitation: an admin without the rep flag may use any email', 'allowed', 'allowed');
  exception when check_violation then perform tests.is('invitation: an admin without the rep flag may use any email', 'rejected', 'allowed'); end;
  delete from public.invitations where email = 'plain.admin.ok@example.com';
end $$;

-- ---------------- who is what ----------------
select tests.is('is_admin(): super admin yes / admin yes / rep no / client no',
  tests.v(tests.id('a1'), 'select private.is_admin()::text') || '/' || tests.v(tests.id('a2'), 'select private.is_admin()::text') || '/' ||
  tests.v(tests.id('b1'), 'select private.is_admin()::text') || '/' || tests.v(tests.id('c1'), 'select private.is_admin()::text'), 'true/true/false/false');
select tests.is('is_super_admin(): super admin yes / admin NO / rep no / client no',
  tests.v(tests.id('a1'), 'select private.is_super_admin()::text') || '/' || tests.v(tests.id('a2'), 'select private.is_super_admin()::text') || '/' ||
  tests.v(tests.id('b1'), 'select private.is_super_admin()::text') || '/' || tests.v(tests.id('c1'), 'select private.is_super_admin()::text'), 'true/false/false/false');
select tests.is('anon cannot call is_super_admin / can_manage_user', tests.q(null, 'select private.is_super_admin()') || '/' || tests.q(null, 'select private.can_manage_user(gen_random_uuid())'), 'ERR:42501/ERR:42501');
select tests.is('private.is_rep(): a plain admin is not a rep', tests.v(tests.id('a2'), 'select private.is_rep()::text'), 'false');
select tests.is('can_manage_user: admin Robin may manage rep, client and another admin (Ada); not a super admin',
  tests.v(tests.id('a2'), 'select private.can_manage_user(' || tests.u('b1') || ')::text') || '/' || tests.v(tests.id('a2'), 'select private.can_manage_user(' || tests.u('c1') || ')::text') || '/' ||
  tests.v(tests.id('a2'), 'select private.can_manage_user(' || tests.u('a1') || ')::text') || '/' || tests.v(tests.id('a2'), 'select private.can_manage_user(' || tests.u('a3') || ')::text'),
  'true/true/false/true');
select tests.is('can_manage_user: super admin may manage everyone',
  tests.v(tests.id('a1'), 'select private.can_manage_user(' || tests.u('a2') || ')::text') || '/' || tests.v(tests.id('a1'), 'select private.can_manage_user(' || tests.u('d1') || ')::text'), 'true/true');

-- ---------------- an admin sees everything an admin dashboard shows ----------------
select tests.is('admin sees every profile', tests.q(tests.id('a2'), 'select * from public.profiles'), (select count(*)::text from public.profiles));
select tests.is('admin sees every quote (same as a super admin)', tests.q(tests.id('a2'), 'select * from public.quotes'), tests.q(tests.id('a1'), 'select * from public.quotes'));
select tests.is('admin sees every assignment', tests.q(tests.id('a2'), 'select * from public.assignments'), (select count(*)::text from public.assignments));
select tests.is('admin sees every invitation', tests.q(tests.id('a2'), 'select * from public.invitations'), (select count(*)::text from public.invitations));
select tests.is('admin reads the audit log', (tests.q(tests.id('a2'), 'select * from public.audit_log')::int > 5)::text, 'true');
select tests.is('admin reads every photo row', tests.q(tests.id('a2'), 'select * from public.photos'), (select count(*)::text from public.photos));
select tests.is('admin reads every storage object', tests.q(tests.id('a2'), 'select * from storage.objects'), (select count(*)::text from storage.objects));
select tests.is('admin cannot read app_settings (nobody can through the API)', tests.q(tests.id('a2'), 'select * from public.app_settings'), 'ERR:42501');
select tests.is('admin logs a quote view and an export', tests.x(tests.id('a2'), 'select public.admin_log_quote_view(''00000000-0000-4000-8000-00000000f005'')') || '/' ||
  tests.x(tests.id('a2'), 'select public.admin_log_export(''{}'')'), 'ok:1/ok:1');
select tests.is('admin hard-deletes a quote', tests.x(tests.id('a2'), 'delete from public.quotes where id = ''00000000-0000-4000-8000-00000000f008'''), 'ok:1');

-- ---------------- an admin manages reps and clients ----------------
select tests.is('admin disables client Sam', tests.xv(tests.id('a2'), 'select public.admin_set_status(' || tests.u('c1') || ', ''disabled'')', $q$select status::text from public.profiles where id = tests.id('c1')$q$), 'ok:1/disabled');
select tests.is('admin re-enables client Sam', tests.xv(tests.id('a2'), 'select public.admin_set_status(' || tests.u('c1') || ', ''active'')', $q$select status::text from public.profiles where id = tests.id('c1')$q$), 'ok:1/active');
select tests.is('admin disables rep Jane', tests.xv(tests.id('a2'), 'select public.admin_set_status(' || tests.u('b1') || ', ''disabled'')', $q$select status::text from public.profiles where id = tests.id('b1')$q$), 'ok:1/disabled');
select tests.is('admin re-enables rep Jane', tests.xv(tests.id('a2'), 'select public.admin_set_status(' || tests.u('b1') || ', ''active'')', $q$select status::text from public.profiles where id = tests.id('b1')$q$), 'ok:1/active');
select tests.is('admin changes a client with a CLA address to a rep (is_rep follows)',
  tests.xv(tests.id('a2'), 'select public.admin_set_role(' || tests.u('e1') || ', ''rep'')', $q$select role::text || '/' || is_rep::text from public.profiles where id = tests.id('e1')$q$), 'ok:1/rep/true');
select tests.is('admin changes that rep back to a client (is_rep cleared)',
  tests.xv(tests.id('a2'), 'select public.admin_set_role(' || tests.u('e1') || ', ''client'')', $q$select role::text || '/' || is_rep::text from public.profiles where id = tests.id('e1')$q$), 'ok:1/client/false');
select tests.is('admin reassigns client Pat to rep Jane', tests.xv(tests.id('a2'), 'select public.admin_reassign_client(''pat.homes@example.com'', ' || tests.u('b1') || ')', $q$select rep_id::text from public.assignments where client_email = 'pat.homes@example.com' and active$q$), 'ok:1/' || tests.id('b1'));
select tests.is('admin edits a client''s and a rep''s profile fields',
  tests.x(tests.id('a2'), 'update public.profiles set company_name = ''Edited by admin'' where id = ' || tests.u('c1')) || '/' ||
  tests.x(tests.id('a2'), 'update public.profiles set company_phone = ''301-555-0100'' where id = ' || tests.u('b1')), 'ok:1/ok:1');
select tests.is('admin edits their own profile', tests.x(tests.id('a2'), 'update public.profiles set phone = ''301-555-0106'' where id = ' || tests.u('a2')), 'ok:1');
select tests.is('admin invites a rep (CLA email) and a client assigned to Jane',
  tests.x(tests.id('a2'), 'select public.create_invitation(''admin.sent.rep@clatitle.com'', ''rep'')') || '/' ||
  tests.xv(tests.id('a2'), 'select public.create_invitation(''admin.sent.client@example.com'', ''client'', ' || tests.u('b1') || ')', $q$select rep_id::text from public.assignments where client_email = 'admin.sent.client@example.com' and active$q$), 'ok:1/ok:1/' || tests.id('b1'));
select tests.is('admin cannot invite a rep without a CLA email', tests.x(tests.id('a2'), 'select public.create_invitation(''admin.sent.rep@gmail.com'', ''rep'')'), 'ERR:22023');

-- ---------------- an admin can NOT create admins or super admins ----------------
select tests.is('admin cannot invite a super admin', tests.x(tests.id('a2'), 'select public.create_invitation(''no.sa@clatitle.com'', ''super_admin'')'), 'ERR:42501');
select tests.is('admin cannot invite an admin', tests.x(tests.id('a2'), 'select public.create_invitation(''no.admin@clatitle.com'', ''admin'')'), 'ERR:42501');
select tests.is('admin cannot invite an admin who also reps', tests.x(tests.id('a2'), 'select public.create_invitation(''no.admin@clatitle.com'', ''admin'', null, null, true)'), 'ERR:42501');
select tests.is('admin cannot invite a super admin who also reps', tests.x(tests.id('a2'), 'select public.create_invitation(''no.sa@clatitle.com'', ''super_admin'', null, null, true)'), 'ERR:42501');
select tests.is('admin cannot flag a rep invitation as p_is_rep', tests.x(tests.id('a2'), 'select public.create_invitation(''no.rep@clatitle.com'', ''rep'', null, null, true)'), 'ERR:42501');
select tests.is('...nothing was left behind by the refused invitations',
  (select count(*)::text from public.invitations where email in ('no.sa@clatitle.com', 'no.admin@clatitle.com', 'no.rep@clatitle.com')), '0');
select tests.is('admin cannot promote a client to admin or super admin',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('c3') || ', ''admin'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('c3') || ', ''super_admin'')'), 'ERR:42501/ERR:42501');
select tests.is('admin cannot promote a rep to admin either', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('b1') || ', ''admin'')'), 'ERR:42501');
select tests.is('...Pat and Jane kept their roles', (select string_agg(role::text, ',' order by role) from public.profiles where id in (tests.id('c3'), tests.id('b1'))), 'rep,client');

-- ---------------- an admin can NOT touch a super admin or another admin ----------------
select tests.is('admin cannot disable a super admin', tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a1') || ', ''disabled'')'), 'ERR:42501');
select tests.is('admin cannot disable themselves', tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a2') || ', ''disabled'')'), 'ERR:42501');
select tests.is('admin cannot demote a super admin', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('d1') || ', ''client'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('d1') || ', ''admin'')'), 'ERR:42501/ERR:42501');
select tests.is('admin cannot promote another admin to super admin, or "promote" an admin to admin', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a3') || ', ''super_admin'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a3') || ', ''admin'')'), 'ERR:42501/ERR:42501');
select tests.is('admin cannot demote themselves', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a2') || ', ''client'')'), 'ERR:42501');
select tests.is('...nobody changed: roles and statuses of a1, a2, a3, d1',
  (select string_agg(role::text || '/' || status::text, ',' order by id) from public.profiles where id in (tests.id('a1'), tests.id('d1'), tests.id('a2'), tests.id('a3'))), 'super_admin/active,admin/active,admin/active,super_admin/active');
select tests.is('admin cannot toggle is_rep on a super admin, another admin or themselves (super admin only: unchanged in migration 11)',
  tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a1') || ', false)') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a3') || ', true)') || '/' ||
  tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a2') || ', true)'), 'ERR:42501/ERR:42501/ERR:42501');
select tests.is('admin cannot edit a super admin''s profile (the update matches no row)',
  tests.x(tests.id('a2'), 'update public.profiles set first_name = ''Hacked'' where id = ' || tests.u('a1')), 'ok:0');
select tests.is('...and nothing was written', (select count(*)::text from public.profiles where first_name = 'Hacked'), '0');
select tests.is('admin cannot write role/status/is_rep through the API (columns not granted)',
  tests.x(tests.id('a2'), 'update public.profiles set role = ''super_admin'' where id = ' || tests.u('a2')) || '/' ||
  tests.x(tests.id('a2'), 'update public.profiles set status = ''disabled'' where id = ' || tests.u('c3')) || '/' ||
  tests.x(tests.id('a2'), 'update public.profiles set is_rep = true where id = ' || tests.u('a2')), 'ERR:42501/ERR:42501/ERR:42501');
select tests.is('admin cannot insert or delete profiles',
  tests.x(tests.id('a2'), 'delete from public.profiles where id = ' || tests.u('c3')) || '/' ||
  tests.x(tests.id('a2'), 'insert into public.profiles (id, role, email) values (gen_random_uuid(), ''admin'', ''z2@example.com'')'), 'ERR:42501/ERR:42501');
-- photos: moderating a client or rep is fine; a super admin's or admin's photo is not an admin's to remove
select tests.is('admin cannot remove a super admin''s photo (row or storage object)',
  tests.x(tests.id('a2'), 'delete from public.photos where owner_id = ' || tests.u('a1')) || '/' ||
  tests.x(tests.id('a2'), 'delete from storage.objects where name = ''' || tests.id('a1') || '/avatar'''), 'ok:0/ok:0');
select tests.is('...they are still there', (select count(*)::text from public.photos where owner_id = tests.id('a1')) || '/' || (select count(*)::text from storage.objects where name = tests.id('a1') || '/avatar'), '1/1');
select tests.is('admin removes a client''s photo (row and storage object)',
  tests.x(tests.id('a2'), 'delete from public.photos where owner_id = ' || tests.u('c1')) || '/' ||
  tests.x(tests.id('a2'), 'delete from storage.objects where name = ''' || tests.id('c1') || '/avatar'''), 'ok:1/ok:1');
-- a disabled super admin cannot be re-enabled by an admin (a disabled admin can: migration 11)
update public.profiles set status = 'disabled' where id in (tests.id('d3'), tests.id('a3'));   -- server side; other super admins are active
select tests.is('...they stay disabled; a disabled admin has no admin powers', (select string_agg(status::text, ',') from public.profiles where id in (tests.id('d3'), tests.id('a3'))) || '/' ||
  tests.q(tests.id('a3'), 'select * from public.profiles'), 'disabled,disabled/0');
select tests.is('admin cannot re-enable a disabled super admin; can re-enable a disabled admin',
  tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('d3') || ', ''active'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a3') || ', ''active'')'), 'ERR:42501/ok:1');
select tests.is('a super admin re-enables the super admin', tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('d3') || ', ''active'')'), 'ok:1');

-- ---------------- a super admin can still do everything ----------------
select tests.is('super admin invites an admin', tests.xv(tests.id('d1'), 'select public.create_invitation(''new.admin3@clatitle.com'', ''admin'')', $q$select role::text || '/' || is_rep::text from public.invitations where email = 'new.admin3@clatitle.com'$q$), 'ok:1/admin/false');
select tests.is('super admin invites an admin who also reps', tests.xv(tests.id('d1'), 'select public.create_invitation(''new.admin4@clatitle.com'', ''admin'', null, null, true)', $q$select role::text || '/' || is_rep::text from public.invitations where email = 'new.admin4@clatitle.com'$q$), 'ok:1/admin/true');
select tests.is('super admin invites a super admin', tests.x(tests.id('d1'), 'select public.create_invitation(''new.sa5@clatitle.com'', ''super_admin'')'), 'ok:1');
select tests.is('p_is_rep with a non-CLA email is refused for an admin invitation', tests.x(tests.id('d1'), 'select public.create_invitation(''outside.admin@example.com'', ''admin'', null, null, true)'), 'ERR:22023');
select tests.is('one create_invitation overload only', (select count(*)::text from pg_proc where proname = 'create_invitation' and pronamespace = 'public'::regnamespace), '1');
select tests.is('super admin changes an admin to a rep (is_rep forced true), then back to an admin (flag kept)',
  tests.xv(tests.id('d1'), 'select public.admin_set_role(' || tests.u('a3') || ', ''rep'')', $q$select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a3')$q$) || ' ' ||
  tests.xv(tests.id('d1'), 'select public.admin_set_role(' || tests.u('a3') || ', ''admin'')', $q$select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a3')$q$), 'ok:1/rep/true ok:1/admin/true');
select tests.is('...and switches rep access off again (no clients)', tests.xv(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a3') || ', false)', $q$select is_rep::text from public.profiles where id = tests.id('a3')$q$), 'ok:1/false');
select tests.is('super admin promotes a client to admin, then to super admin, then demotes back to client',
  tests.xv(tests.id('d1'), 'select public.admin_set_role(' || tests.u('e1') || ', ''admin'')', $q$select role::text from public.profiles where id = tests.id('e1')$q$) || ' ' ||
  tests.xv(tests.id('d1'), 'select public.admin_set_role(' || tests.u('e1') || ', ''super_admin'')', $q$select role::text from public.profiles where id = tests.id('e1')$q$) || ' ' ||
  tests.xv(tests.id('d1'), 'select public.admin_set_role(' || tests.u('e1') || ', ''client'')', $q$select role::text from public.profiles where id = tests.id('e1')$q$), 'ok:1/admin ok:1/super_admin ok:1/client');
select tests.is('super admin demotes a super admin to admin and back (others are active)',
  tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('d2') || ', ''admin'')') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('d2') || ', ''super_admin'')'), 'ok:1/ok:1');
select tests.is('super admin disables and re-enables an admin and a super admin',
  tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('a3') || ', ''disabled'')') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('d3') || ', ''disabled'')') || '/' ||
  tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('a3') || ', ''active'')') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('d3') || ', ''active'')'), 'ok:1/ok:1/ok:1/ok:1');
select tests.is('super admin cannot change their own role or disable themselves',
  tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('d1') || ', ''admin'')') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('d1') || ', ''disabled'')'), 'ERR:42501/ERR:42501');
select tests.is('super admin switches is_rep on an admin and on a super admin',
  tests.xv(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a2') || ', true)', $q$select is_rep::text from public.profiles where id = tests.id('a2')$q$) || ' ' ||
  tests.xv(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('d1') || ', true)', $q$select is_rep::text from public.profiles where id = tests.id('d1')$q$), 'ok:1/true ok:1/true');
select tests.is('is_rep switch: not for a rep or a client (23514)',
  tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('b1') || ', false)') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('c1') || ', true)'), 'ERR:23514/ERR:23514');
select tests.is('audit rows carry the admin role changes', (select count(*)::text from public.audit_log where action = 'role_changed' and details ->> 'after' = 'admin'), '3');
update public.profiles set is_rep = false where id = tests.id('d1');   -- Pia back to a plain super admin

-- ---------------- an admin who ALSO works as a rep (Robin, switched on by a super admin above) ----------------
select tests.is('Robin is now a rep and still an admin', tests.v(tests.id('a2'), 'select private.is_rep()::text || ''/'' || private.is_admin()::text'), 'true/true');
select tests.is('an admin still cannot switch their own rep flag off', tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a2') || ', false)'), 'ERR:42501');
select tests.is('an admin who is a rep can be assigned clients (by another admin)', tests.xv(tests.id('a3'), 'select public.admin_reassign_client(''pat.homes@example.com'', ' || tests.u('a2') || ')', $q$select rep_id::text from public.assignments where client_email = 'pat.homes@example.com' and active$q$), 'ok:1/' || tests.id('a2'));
select tests.is('a plain admin cannot be assigned clients (not rep-capable)', tests.x(tests.id('a2'), 'select public.admin_reassign_client(''pat.homes@example.com'', ' || tests.u('a3') || ')'), 'ERR:23514');
select tests.is('...and Pat is still Robin''s', (select rep_id::text from public.assignments where client_email = 'pat.homes@example.com' and active), tests.id('a2')::text);
select tests.is('Robin invites a client from the rep dashboard (p_as_rep): rep rules, assigned to himself',
  tests.xv(tests.id('a2'), 'select public.create_invitation(''robin.client@example.com'', ''client'', null, null, false, true)', $q$select rep_id::text from public.assignments where client_email = 'robin.client@example.com' and active$q$), 'ok:1/' || tests.id('a2'));
select tests.is('...and as_rep can never invite an admin', tests.x(tests.id('a2'), 'select public.create_invitation(''as.rep.admin@clatitle.com'', ''admin'', null, null, false, true)'), 'ERR:42501');
select tests.is('a plain admin cannot use as_rep (not a rep)', tests.x(tests.id('a3'), 'select public.create_invitation(''as.rep.client2@example.com'', ''client'', null, null, false, true)'), 'ERR:42501');
select tests.is('switching Robin''s rep access off is refused while he has clients (55006)', tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a2') || ', false)'), 'ERR:55006');
select tests.is('a quote saved by Robin carries himself as rep (like a rep)',
  tests.xv(tests.id('a2'), 'insert into public.quotes (quote_type, label) values (''buyer'', ''robin own'')', $q$select rep_id::text from public.quotes where label = 'robin own'$q$), 'ok:1/' || tests.id('a2'));
select tests.is('Pat''s rep (rep_of) is Robin', (select (private.rep_of(tests.id('c3')) = tests.id('a2'))::text), 'true');
update public.assignments set active = false where rep_id = tests.id('a2') and active;
select tests.is('after his clients are moved, a super admin switches Robin back to admin only', tests.xv(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a2') || ', false)', $q$select is_rep::text from public.profiles where id = tests.id('a2')$q$), 'ok:1/false');

-- =====================================================================
-- Migration 11: an admin may now ALSO manage OTHER ADMINS (never a super admin; never promote; never invite)
-- Cast: admins a2 Robin, a3 Ada | NEW admins a4 Bo, a5 Cy (invited by a super admin) | super admins a1, d1 | rep b1 | client c3
-- =====================================================================
insert into public.invitations (email, role, is_rep) values ('bo.admin@clatitle.com', 'admin', false), ('cy.admin@clatitle.com', 'admin', true);
insert into auth.users (id, email) values (tests.id('a4'), 'bo.admin@clatitle.com'), (tests.id('a5'), 'cy.admin@clatitle.com');
update public.profiles set first_name = 'Bo', last_name = 'Admin' where id = tests.id('a4');
update public.profiles set first_name = 'Cy', last_name = 'Admin', phone = '301-555-0177' where id = tests.id('a5');
insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values (tests.id('a4'), tests.id('a4') || '/avatar', 'image/png', 1000);
insert into storage.objects (bucket_id, name) values ('avatars', tests.id('a4') || '/avatar');
select tests.is('new admins signed up: Bo (plain), Cy (also a rep)',
  (select string_agg(role::text || '/' || is_rep::text, ',' order by id) from public.profiles where id in (tests.id('a4'), tests.id('a5'))), 'admin/false,admin/true');

-- ----- what an admin CAN now do to another admin -----
select tests.is('can_manage_user: an admin may manage another admin; still not a super admin',
  tests.v(tests.id('a2'), 'select private.can_manage_user(' || tests.u('a4') || ')::text') || '/' || tests.v(tests.id('a2'), 'select private.can_manage_user(' || tests.u('a1') || ')::text'), 'true/false');
select tests.is('admin disables another admin (Bo)', tests.xv(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a4') || ', ''disabled'')', $q$select status::text from public.profiles where id = tests.id('a4')$q$), 'ok:1/disabled');
select tests.is('...a disabled admin has no powers', tests.q(tests.id('a4'), 'select * from public.profiles') || '/' || tests.x(tests.id('a4'), 'select public.admin_set_status(' || tests.u('c3') || ', ''disabled'')'), '0/ERR:42501');
select tests.is('admin re-enables the other admin (Bo)', tests.xv(tests.id('a3'), 'select public.admin_set_status(' || tests.u('a4') || ', ''active'')', $q$select status::text from public.profiles where id = tests.id('a4')$q$), 'ok:1/active');
select tests.is('both disable / re-enable are in the audit log, by the acting admin',
  (select count(*)::text from public.audit_log where target_id = tests.id('a4') and actor_id = tests.id('a2') and action = 'user_disabled')
  || '/' || (select count(*)::text from public.audit_log where target_id = tests.id('a4') and actor_id = tests.id('a3') and action = 'user_enabled'), '1/1');
select tests.is('admin edits another admin''s profile (name, phone)',
  tests.x(tests.id('a2'), 'update public.profiles set first_name = ''Bobby'', phone = ''301-555-0188'' where id = ' || tests.u('a4')), 'ok:1');
select tests.is('...and it was written', (select first_name || ',' || coalesce(phone, '-') from public.profiles where id = tests.id('a4')), 'Bobby,301-555-0188');
update public.profiles set first_name = 'Bo' where id = tests.id('a4');
select tests.is('admin removes another admin''s photo (row and storage object)',
  tests.x(tests.id('a2'), 'delete from public.photos where owner_id = ' || tests.u('a4')) || '/' ||
  tests.x(tests.id('a2'), 'delete from storage.objects where name = ''' || tests.id('a4') || '/avatar'''), 'ok:1/ok:1');
select tests.is('admin demotes another admin to client (is_rep cleared by the trigger)',
  tests.xv(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a4') || ', ''client'')', $q$select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a4')$q$), 'ok:1/client/false');
select tests.is('...audited, with the acting admin', (select count(*)::text from public.audit_log where target_id = tests.id('a4') and action = 'role_changed' and actor_id = tests.id('a2')), '1');
select tests.is('...and Bo, now a client, has lost the admin dashboard', tests.q(tests.id('a4'), 'select * from public.profiles') || '/' || tests.v(tests.id('a4'), 'select private.is_admin()::text'), '1/false');
select tests.is('an admin demotes another admin (who also reps) to rep: stays a rep, CLA email ok',
  tests.xv(tests.id('a3'), 'select public.admin_set_role(' || tests.u('a5') || ', ''rep'')', $q$select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a5')$q$), 'ok:1/rep/true');
select tests.is('...Cy is no longer an admin (no is_admin, still a rep)', tests.v(tests.id('a5'), 'select private.is_admin()::text || ''/'' || private.is_rep()::text'), 'false/true');
select tests.is('a super admin can still promote them back (Bo, Cy to admin)',
  tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('a4') || ', ''admin'')') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('a5') || ', ''admin'')'), 'ok:1/ok:1');

-- ----- what an admin still can NOT do (every path) -----
select tests.is('admin cannot promote another admin (or anybody) to admin or super admin',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a4') || ', ''super_admin'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a4') || ', ''admin'')') || '/' ||
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('c3') || ', ''admin'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('b1') || ', ''super_admin'')'), 'ERR:42501/ERR:42501/ERR:42501/ERR:42501');
select tests.is('admin cannot touch a super admin at all: status, role, profile, photo, is_rep',
  tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('d1') || ', ''disabled'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('d1') || ', ''rep'')') || '/' ||
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('d1') || ', ''super_admin'')') || '/' ||
  tests.x(tests.id('a2'), 'update public.profiles set first_name = ''Hacked'' where id = ' || tests.u('d1')) || '/' ||
  tests.x(tests.id('a2'), 'delete from public.photos where owner_id = ' || tests.u('a1')) || '/' ||
  tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('d1') || ', true)'), 'ERR:42501/ERR:42501/ERR:42501/ok:0/ok:0/ERR:42501');
select tests.is('admin cannot toggle is_rep on another admin (super admin only)',
  tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a4') || ', true)') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false)'), 'ERR:42501/ERR:42501');
select tests.is('admin cannot invite an admin or super admin (migration 10 rule unchanged)',
  tests.x(tests.id('a2'), 'select public.create_invitation(''m11.admin@clatitle.com'', ''admin'')') || '/' || tests.x(tests.id('a2'), 'select public.create_invitation(''m11.sa@clatitle.com'', ''super_admin'')'), 'ERR:42501/ERR:42501');
select tests.is('admin cannot disable or demote themselves',
  tests.x(tests.id('a4'), 'select public.admin_set_status(' || tests.u('a4') || ', ''disabled'')') || '/' || tests.x(tests.id('a4'), 'select public.admin_set_role(' || tests.u('a4') || ', ''client'')'), 'ERR:42501/ERR:42501');
select tests.is('admin cannot write role / status / is_rep through the API on another admin (columns not granted)',
  tests.x(tests.id('a2'), 'update public.profiles set role = ''client'' where id = ' || tests.u('a4')) || '/' || tests.x(tests.id('a2'), 'update public.profiles set status = ''disabled'' where id = ' || tests.u('a4')), 'ERR:42501/ERR:42501');
select tests.is('...nothing changed: Robin, Ada, Bo, Cy are active admins; Alex and Pia super admins',
  (select string_agg(role::text || '/' || status::text, ',' order by id) from public.profiles where id in (tests.id('a1'), tests.id('d1'), tests.id('a2'), tests.id('a3'), tests.id('a4'), tests.id('a5'))),
  'super_admin/active,admin/active,admin/active,admin/active,admin/active,super_admin/active');
select tests.is('a rep and a client still cannot manage anyone',
  tests.x(tests.id('b1'), 'select public.admin_set_status(' || tests.u('a4') || ', ''disabled'')') || '/' || tests.x(tests.id('c3'), 'select public.admin_set_role(' || tests.u('a4') || ', ''client'')'), 'ERR:42501/ERR:42501');
-- two admins acting on each other, and on the same person
select tests.is('two admins can disable each other in turn; the second is refused because the first is now disabled',
  tests.x(tests.id('a4'), 'select public.admin_set_status(' || tests.u('a5') || ', ''disabled'')') || '/' || tests.x(tests.id('a5'), 'select public.admin_set_status(' || tests.u('a4') || ', ''disabled'')'), 'ok:1/ERR:42501');
select tests.is('...a super admin repairs it (re-enables Cy)', tests.x(tests.id('d1'), 'select public.admin_set_status(' || tests.u('a5') || ', ''active'')'), 'ok:1');
-- MFA still gates it
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
select tests.is('MFA on: an admin at aal1 cannot manage another admin, at aal2 can',
  tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a4') || ', ''disabled'')', 'aal1') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a4') || ', ''disabled'')', 'aal2'), 'ERR:42501/ok:1');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';
update public.profiles set status = 'active' where id in (tests.id('a4'), tests.id('a5'));
-- put the cast back: Bo and Cy leave the picture (they are plain admins, no clients, nothing else uses them)
select tests.is('policies still go through can_manage_user (nothing was left on the old rule)',
  (select count(*)::text from pg_policies where policyname in ('profiles_update_admin', 'photos_delete', 'avatars_delete') and (qual || coalesce(with_check, '')) like '%can_manage_user%'), '3');

-- =====================================================================
-- Migration 12: a rep-capable person with ACTIVE clients cannot lose rep capability without handing the clients to a successor
-- Cast: reps a6 Rae (3 active clients + 1 old inactive row), a7 Ren (the successor), a8 Sol (no clients), a9 Dee (rep, disabled)
--       admins a2 Robin, a5 Cy (also a rep) | super admins a1 Alex (rep, has Quinn), d1 Pia | client c3 Pat
-- =====================================================================
insert into public.invitations (email, role, is_rep) values ('rae.rep@clatitle.com', 'rep', true), ('ren.rep@clatitle.com', 'rep', true), ('sol.rep@clatitle.com', 'rep', true), ('dee.rep@clatitle.com', 'rep', true);
insert into auth.users (id, email) values (tests.id('a6'), 'rae.rep@clatitle.com'), (tests.id('a7'), 'ren.rep@clatitle.com'), (tests.id('a8'), 'sol.rep@clatitle.com'), (tests.id('a9'), 'dee.rep@clatitle.com');
update public.profiles set first_name = 'Rae', last_name = 'Rep', phone = '301-555-0161' where id = tests.id('a6');
update public.profiles set first_name = 'Ren', last_name = 'Rep', phone = '301-555-0162' where id = tests.id('a7');
update public.profiles set first_name = 'Sol', last_name = 'Rep', phone = '301-555-0163' where id = tests.id('a8');
update public.profiles set first_name = 'Dee', last_name = 'Rep', phone = '301-555-0164', status = 'disabled' where id = tests.id('a9');
insert into public.assignments (client_email, rep_id, active) values
  ('m12.one@example.com', tests.id('a6'), true), ('m12.two@example.com', tests.id('a6'), true), ('m12.three@example.com', tests.id('a6'), true), ('m12.old@example.com', tests.id('a6'), false);
select tests.is('migration 12: one admin_set_role and one admin_set_is_rep (the old signatures are gone, no overloads)',
  (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_set_role', 'admin_set_is_rep')), '2');
select tests.is('Rae has 3 active clients', private.active_client_count(tests.id('a6'))::text, '3');

-- ----- refused without a successor (every role path that removes rep capability) -----
select tests.is('admin demoting a rep with active clients to client: refused (55006) without p_reassign_to', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'')'), 'ERR:55006');
select tests.is('...also when p_reassign_to is passed as null explicitly', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', null)'), 'ERR:55006');
select tests.is('...nothing changed: Rae is still a rep with her 3 active clients', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a6')) || '/' || private.active_client_count(tests.id('a6')), 'rep/true/3');
-- ----- invalid successors -----
select tests.is('successor = the same person: refused',   tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a6') || ')'), 'ERR:23514');
select tests.is('successor is a client: refused',         tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('c3') || ')'), 'ERR:23514');
select tests.is('successor is a disabled rep: refused',   tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a9') || ')'), 'ERR:23514');
select tests.is('successor is an admin who is not a rep: refused', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a3') || ')'), 'ERR:23514');
select tests.is('successor does not exist: refused',      tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', gen_random_uuid())'), 'ERR:23514');
select tests.is('...still nothing changed after every refusal (atomic): role, clients, no stray rows',
  (select role::text from public.profiles where id = tests.id('a6')) || '/' || private.active_client_count(tests.id('a6')) || '/' ||
  (select count(*)::text from public.assignments where rep_id = tests.id('a6')), 'rep/3/4');
-- ----- permissions still respected -----
update public.profiles set is_rep = true where id = tests.id('a1');
insert into public.assignments (client_email, rep_id) values ('m12.alex@example.com', tests.id('a1'));
select tests.is('admin cannot do it to a super admin (Alex has a client): refused for permission, clients stay',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a1') || ', ''client'', ' || tests.u('a6') || ')') || '/' || private.active_client_count(tests.id('a1')), 'ERR:42501/1');
select tests.is('admin cannot promote the rep to admin while "handing over" clients either (promotion stays super-admin only)',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''admin'', ' || tests.u('a7') || ')') || '/' || private.active_client_count(tests.id('a6')), 'ERR:42501/3');
select tests.is('a rep and a client cannot use it', tests.x(tests.id('a8'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a7') || ')') || '/' || tests.x(tests.id('c3'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a7') || ')'), 'ERR:42501/ERR:42501');
select tests.is('nobody can use it on themselves', tests.x(tests.id('a6'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a7') || ')'), 'ERR:42501');
-- ----- success: everything moves, with history and audit -----
select tests.is('admin demotes Rae to client and hands her clients to Ren: ok', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a6') || ', ''client'', ' || tests.u('a7') || ')'), 'ok:1');
select tests.is('...Rae is a client now, not a rep, with no active clients', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a6')) || '/' || private.active_client_count(tests.id('a6')), 'client/false/0');
select tests.is('...Ren has all 3 (and only one active rep per client)', private.active_client_count(tests.id('a7'))::text || '/' ||
  (select count(distinct client_email)::text from public.assignments where active and client_email like 'm12.%'), '3/4');
select tests.is('...history: Rae''s rows are all inactive (3 moved + the old one), Ren''s new rows were assigned_by the acting admin',
  (select count(*)::text from public.assignments where rep_id = tests.id('a6') and not active) || '/' ||
  (select count(*)::text from public.assignments where rep_id = tests.id('a7') and active and assigned_by = tests.id('a2')), '4/3');
select tests.is('...audit: 3 assignment_changed rows for the new assignments + 3 for the deactivations',
  (select count(*)::text from public.audit_log where action = 'assignment_changed' and details ->> 'client_email' like 'm12.%' and details ->> 'rep_id' = tests.id('a7')::text and (details ->> 'active')::boolean) || '/' ||
  (select count(*)::text from public.audit_log where action = 'assignment_changed' and details ->> 'client_email' like 'm12.%' and details ->> 'rep_id' = tests.id('a6')::text and not (details ->> 'active')::boolean and details -> 'previous' ->> 'active' = 'true'), '3/3');
select tests.is('...audit: role_changed records who took over and how many moved',
  (select details ->> 'clients_moved' || '/' || (details ->> 'moved_to' = tests.id('a7')::text)::text from public.audit_log where action = 'role_changed' and target_id = tests.id('a6') order by at desc limit 1), '3/true');
select tests.is('...Rae (now a client) is no longer anyone''s rep: she cannot be picked as a successor',
  tests.x(tests.id('a2'), 'select public.admin_reassign_client(''m12.one@example.com'', ' || tests.u('a6') || ')'), 'ERR:23514');
select tests.is('Ren sees her new clients (rep access follows the assignment)', tests.q(tests.id('a7'), 'select * from public.assignments where active'), '3');
-- ----- unaffected: no clients, or capability kept -----
select tests.is('a rep with NO active clients is demoted without any p_reassign_to (nothing to move)', tests.xv(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a8') || ', ''client'')', $q$select role::text from public.profiles where id = tests.id('a8')$q$), 'ok:1/client');
select tests.is('...a pointless p_reassign_to is ignored (even an invalid one): Sol back to rep, then to client again',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a8') || ', ''rep'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a8') || ', ''client'', ' || tests.u('c3') || ')'), 'ok:1/ok:1');
select tests.is('a super admin makes Ren (3 clients) an admin: ok, no successor needed', tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('a7') || ', ''admin'')'), 'ok:1');
select tests.is('...she keeps is_rep, so her clients stay with her', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a7')) || '/' || private.active_client_count(tests.id('a7')), 'admin/true/3');
select tests.is('...and back to rep: still 3 clients', tests.x(tests.id('d1'), 'select public.admin_set_role(' || tests.u('a7') || ', ''rep'')') || '/' || private.active_client_count(tests.id('a7')), 'ok:1/3');
select tests.is('a client who is demoted... nothing to do: changing a client to rep is unaffected', tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('e1') || ', ''rep'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('e1') || ', ''client'')'), 'ok:1/ok:1');
-- ----- the is_rep switch (super admin only) -----
insert into public.assignments (client_email, rep_id) values ('m12.cy1@example.com', tests.id('a5')), ('m12.cy2@example.com', tests.id('a5'));
select tests.is('Cy (admin + rep, 2 clients): switching rep access off without a successor is still refused (55006)', tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false)'), 'ERR:55006');
select tests.is('...an admin still cannot switch it at all (super admin only), even with a successor', tests.x(tests.id('a2'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false, ' || tests.u('a7') || ')'), 'ERR:42501');
select tests.is('...invalid successors are refused (self, client, disabled rep)',
  tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false, ' || tests.u('a5') || ')') || '/' || tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false, ' || tests.u('c3') || ')') || '/' ||
  tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false, ' || tests.u('a9') || ')'), 'ERR:23514/ERR:23514/ERR:23514');
select tests.is('...nothing changed', (select is_rep::text from public.profiles where id = tests.id('a5')) || '/' || private.active_client_count(tests.id('a5')), 'true/2');
select tests.is('a super admin switches it off with Ren as successor: ok', tests.x(tests.id('d1'), 'select public.admin_set_is_rep(' || tests.u('a5') || ', false, ' || tests.u('a7') || ')'), 'ok:1');
select tests.is('...Cy is a plain admin with no clients, Ren has 5, history and audit kept',
  (select is_rep::text from public.profiles where id = tests.id('a5')) || '/' || private.active_client_count(tests.id('a5')) || '/' || private.active_client_count(tests.id('a7')) || '/' ||
  (select count(*)::text from public.assignments where rep_id = tests.id('a5') and not active) || '/' ||
  (select details ->> 'clients_moved' from public.audit_log where action = 'rep_flag_changed' and target_id = tests.id('a5') order by at desc limit 1), 'false/0/5/2/2');
-- ----- demoting an admin who also reps (the admin-manages-admin path of migration 11) -----
update public.profiles set is_rep = true where id = tests.id('a5');
insert into public.assignments (client_email, rep_id) values ('m12.cy3@example.com', tests.id('a5'));
select tests.is('admin demotes another admin who also reps (1 client) to client: refused without a successor, ok with one',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a5') || ', ''client'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a5') || ', ''client'', ' || tests.u('a7') || ')'), 'ERR:55006/ok:1');
select tests.is('...Cy is a client with no clients; Ren has 6', (select role::text || '/' || is_rep::text from public.profiles where id = tests.id('a5')) || '/' || private.active_client_count(tests.id('a5')) || '/' || private.active_client_count(tests.id('a7')), 'client/false/0/6');
-- ----- MFA still gates the new parameter -----
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
update public.profiles set role = 'rep' where id = tests.id('a8');
insert into public.assignments (client_email, rep_id) values ('m12.mfa@example.com', tests.id('a8'));
select tests.is('MFA on: at aal1 refused, at aal2 the move works',
  tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a8') || ', ''client'', ' || tests.u('a7') || ')', 'aal1') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a8') || ', ''client'', ' || tests.u('a7') || ')', 'aal2'), 'ERR:42501/ok:1');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';
select tests.is('function privileges: users can run the RPCs but not the helpers',
  (has_function_privilege('authenticated', 'public.admin_set_role(uuid, public.user_role, uuid)', 'execute') and has_function_privilege('authenticated', 'public.admin_set_is_rep(uuid, boolean, uuid)', 'execute')
   and not has_function_privilege('anon', 'public.admin_set_role(uuid, public.user_role, uuid)', 'execute')
   and not has_function_privilege('authenticated', 'private.move_rep_clients(uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'private.active_client_count(uuid)', 'execute'))::text, 'true');

-- ---------------- MFA switch covers the admin role as well ----------------
update public.app_settings set value = 'true' where key = 'require_admin_mfa';
select tests.is('MFA on: an admin at aal1 has no admin powers (sees only themselves, RPC refused)',
  tests.q(tests.id('a2'), 'select * from public.profiles') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('c3') || ', ''disabled'')', 'aal1'), '1/ERR:42501');
select tests.is('MFA on: an admin at aal2 can manage a client but still not a super admin',
  tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('c3') || ', ''disabled'')', 'aal2') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a1') || ', ''disabled'')', 'aal2'), 'ok:1/ERR:42501');
select tests.is('MFA on: a super admin at aal1 cannot use super-admin-only RPCs, at aal2 can',
  tests.x(tests.id('d1'), 'select public.create_invitation(''mfa.admin@clatitle.com'', ''admin'')', 'aal1') || '/' || tests.x(tests.id('d1'), 'select public.create_invitation(''mfa.admin@clatitle.com'', ''admin'')', 'aal2'), 'ERR:42501/ok:1');
select tests.is('MFA on: is_super_admin follows the same switch', tests.v(tests.id('d1'), 'select private.is_super_admin()::text', 'aal1') || '/' || tests.v(tests.id('d1'), 'select private.is_super_admin()::text', 'aal2'), 'false/true');
update public.app_settings set value = 'false' where key = 'require_admin_mfa';
select tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('c3') || ', ''active'')');

-- ---------------- the last active super admin ----------------
select tests.is('guard trigger exists', (select count(*)::text from pg_trigger where tgname = 'profiles_last_super_admin_trg' and not tgisinternal), '1');
update public.profiles set status = 'disabled' where id in (tests.id('d1'), tests.id('d2'), tests.id('d3'));   -- a1 (Alex) is now the only ACTIVE super admin
select tests.is('exactly one active super admin left', (select count(*)::text from public.profiles where role = 'super_admin' and status = 'active'), '1');
select tests.is('...other_active_super_admin(Alex) is false, (Pia) is true', (select private.other_active_super_admin(tests.id('a1'))::text || '/' || private.other_active_super_admin(tests.id('d1'))::text), 'false/true');
select tests.is('Alex cannot disable or demote herself (existing rule, RPC)', tests.x(tests.id('a1'), 'select public.admin_set_status(' || tests.u('a1') || ', ''disabled'')') || '/' || tests.x(tests.id('a1'), 'select public.admin_set_role(' || tests.u('a1') || ', ''admin'')'), 'ERR:42501/ERR:42501');
select tests.is('an admin cannot disable or demote the last super admin (permission)', tests.x(tests.id('a2'), 'select public.admin_set_status(' || tests.u('a1') || ', ''disabled'')') || '/' || tests.x(tests.id('a2'), 'select public.admin_set_role(' || tests.u('a1') || ', ''client'')'), 'ERR:42501/ERR:42501');
select tests.is('guard: disabling the last active super admin is refused on any path (direct SQL)', tests.p('update public.profiles set status = ''disabled'' where id = ' || tests.u('a1')), 'ERR:55000');
select tests.is('guard: demoting the last active super admin is refused', tests.p('update public.profiles set role = ''admin'' where id = ' || tests.u('a1')), 'ERR:55000');
select tests.is('guard: deleting the last active super admin''s profile is refused', tests.p('delete from public.profiles where id = ' || tests.u('a1')), 'ERR:55000');
select tests.is('guard: deleting the last active super admin''s login (cascade) is refused', tests.p('delete from auth.users where id = ' || tests.u('a1')), 'ERR:55000');
select tests.is('guard: disabled super admins do not count (Pia, Flo, Otto exist but are disabled)', tests.p('update public.profiles set status = ''disabled'', role = ''admin'' where id = ' || tests.u('a1')), 'ERR:55000');
select tests.is('...Alex is untouched', (select role::text || '/' || status::text from public.profiles where id = tests.id('a1')), 'super_admin/active');
select tests.is('a disabled super admin can still be demoted (does not change the active count)', tests.p('update public.profiles set role = ''admin'' where id = ' || tests.u('d3')) || '/' || tests.p('update public.profiles set role = ''super_admin'' where id = ' || tests.u('d3')), 'ok/ok');
select tests.is('re-enabling is never blocked', tests.x(tests.id('a1'), 'select public.admin_set_status(' || tests.u('d1') || ', ''active'')') || '/' || tests.x(tests.id('a1'), 'select public.admin_set_status(' || tests.u('d2') || ', ''active'')'), 'ok:1/ok:1');
select tests.is('now three are active (Alex, Pia, Flo)', (select count(*)::text from public.profiles where role = 'super_admin' and status = 'active'), '3');
select tests.is('guard: one statement that would disable ALL active super admins fails as a whole (and nobody is disabled)',
  tests.p('update public.profiles set status = ''disabled'' where role = ''super_admin''') || '/' || (select count(*)::text from public.profiles where role = 'super_admin' and status = 'active'), 'ERR:55000/3');
select tests.is('guard: one statement that demotes all of them fails as a whole',
  tests.p('update public.profiles set role = ''admin'' where role = ''super_admin''') || '/' || (select count(*)::text from public.profiles where role = 'super_admin' and status = 'active'), 'ERR:55000/3');
select tests.is('three active: one may be disabled (Alex disables Pia)', tests.x(tests.id('a1'), 'select public.admin_set_status(' || tests.u('d1') || ', ''disabled'')'), 'ok:1');
select tests.is('...two left (Alex, Flo): disabling both in one statement is refused', tests.p('update public.profiles set status = ''disabled'' where id in (' || tests.u('a1') || ', ' || tests.u('d2') || ')'), 'ERR:55000');
select tests.is('a super admin can demote another while a third is active (Alex demotes Flo to admin)', tests.x(tests.id('a1'), 'select public.admin_set_role(' || tests.u('d2') || ', ''admin'')'), 'ok:1');
select tests.is('...now Alex is the last again: Flo (an admin now) cannot touch her', tests.x(tests.id('d2'), 'select public.admin_set_status(' || tests.u('a1') || ', ''disabled'')'), 'ERR:42501');
select tests.is('the guard function and its helper are not callable by users',
  (not has_function_privilege('authenticated', 'private.guard_last_super_admin()', 'execute')
   and not has_function_privilege('authenticated', 'private.other_active_super_admin(uuid)', 'execute'))::text, 'true');
-- put the cast back for tidiness
update public.profiles set role = 'super_admin' where id = tests.id('d2');
update public.profiles set status = 'active' where role = 'super_admin';

-- ---------------- privileges ----------------
select tests.is('function privileges: anon cannot run the admin RPCs, authenticated can',
  (select (not has_function_privilege('anon', 'public.admin_set_role(uuid, public.user_role, uuid)', 'execute')
       and not has_function_privilege('anon', 'public.admin_set_status(uuid, public.user_status)', 'execute')
       and not has_function_privilege('anon', 'public.admin_set_is_rep(uuid, boolean, uuid)', 'execute')
       and has_function_privilege('authenticated', 'public.admin_set_role(uuid, public.user_role, uuid)', 'execute')
       and has_function_privilege('authenticated', 'private.is_super_admin()', 'execute')
       and not has_function_privilege('anon', 'private.is_super_admin()', 'execute'))::text), 'true');
select tests.is('every public table still has RLS enabled', (select count(*)::text from pg_tables where schemaname = 'public' and not rowsecurity), '0');

-- ---------------- summary ----------------
do $$ declare f int; t int; begin
  select count(*) filter (where not ok), count(*) into f, t from tests.results;
  raise notice '% checks, % failed', t, f;
  if f > 0 then raise exception '% access-rule check(s) failed', f; end if;
end $$;

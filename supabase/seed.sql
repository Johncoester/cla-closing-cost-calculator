-- =====================================================================
-- LOCAL / TEST SEED DATA ONLY. Never run against a real project.
-- (Supabase CLI runs this file on `supabase db reset` for the local stack only.)
-- All people are fictional. No passwords are set: these auth.users rows
-- have no encrypted_password, so they cannot sign in with a password. For
-- the local Supabase stack, use Studio > Authentication > "Send password
-- recovery" (Inbucket shows the mail) to set one yourself.
-- Rep emails must end @clatitle.com (database rule), so they use obvious
-- "sample." local parts.
-- =====================================================================

-- 1. invitations first: the auth.users trigger refuses emails without one
-- Omar's cell is entered on his invitation (typed with dashes on purpose: the trigger stores +1XXXXXXXXXX
-- and sign-up copies it to his profile). Nina has no account yet: her invitation carries her cell so the
-- rep can see it, and it lands on her profile when she signs up (the test suite signs her up).
insert into public.invitations (email, role, cell_phone) values
  ('sample.admin@clatitle.com',      'super_admin', null),
  ('sample.rep.jane@clatitle.com',   'rep',         null),
  ('sample.rep.marcus@clatitle.com', 'rep',         null),
  ('sam.agent@example.com',          'client',      null),
  ('lee.lender@example.com',         'client',      null),
  ('pat.homes@example.com',          'client',      null),
  ('dee.disabled@example.com',       'client',      null),
  ('omar.broker@example.com',        'client',      '703-555-0172'),
  ('nina.newagent@example.com',      'client',      '703-555-0181');

-- 2. auth users (fixed ids so tests and the mock adapter line up)
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token,
                        email_change, email_change_token_new, email_change_token_current)
select v.id::uuid, 'authenticated', 'authenticated', v.email, now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '', ''
from (values
  ('00000000-0000-4000-8000-0000000000a1', 'sample.admin@clatitle.com'),
  ('00000000-0000-4000-8000-0000000000b1', 'sample.rep.jane@clatitle.com'),
  ('00000000-0000-4000-8000-0000000000b2', 'sample.rep.marcus@clatitle.com'),
  ('00000000-0000-4000-8000-0000000000c1', 'sam.agent@example.com'),
  ('00000000-0000-4000-8000-0000000000c2', 'lee.lender@example.com'),
  ('00000000-0000-4000-8000-0000000000c3', 'pat.homes@example.com'),
  ('00000000-0000-4000-8000-0000000000c4', 'dee.disabled@example.com'),
  ('00000000-0000-4000-8000-0000000000c5', 'omar.broker@example.com')
) as v(id, email);

-- 3. profile details (this seed runs as a superuser, so column grants do not apply)
-- cell_phone: fictional 555-01xx numbers; Pat deliberately has none (cell is optional for clients);
-- Omar's came from his invitation (null here keeps it).
update public.profiles p set first_name = v.f, last_name = v.l, phone = v.ph, cell_phone = coalesce(v.cell, p.cell_phone), company_name = v.co,
       company_phone = v.cph, company_address = v.ca, license_or_nmls_number = v.lic,
       terms_accepted_at = now()
from (values
  ('00000000-0000-4000-8000-0000000000a1', 'Alex',   'Admin',    '301-555-0100', '+13015550101', 'C.L.A. Title & Escrow', null, null, null),
  ('00000000-0000-4000-8000-0000000000b1', 'Jane',   'Rep',      '301-555-0111', '+13015550112', 'C.L.A. Title & Escrow', '301-555-0100', 'Rockville, MD', null),
  ('00000000-0000-4000-8000-0000000000b2', 'Marcus', 'Rep',      '703-555-0122', '+17035550123', 'C.L.A. Title & Escrow', '703-555-0100', 'Arlington, VA', null),
  ('00000000-0000-4000-8000-0000000000c1', 'Sam',    'Agent',    '240-555-0131', '+12405550132', 'Acme Realty',           '240-555-0130', '12 Elm St, Bethesda, MD', 'MD-SAMPLE-1001'),
  ('00000000-0000-4000-8000-0000000000c2', 'Lee',    'Lender',   '202-555-0141', '+12025550142', 'Capital Home Loans',    '202-555-0140', '500 K St NW, Washington, DC', 'NMLS-SAMPLE-2002'),
  ('00000000-0000-4000-8000-0000000000c3', 'Pat',    'Homes',    '757-555-0151', null, 'Homes by Pat',          null,           null, null),
  ('00000000-0000-4000-8000-0000000000c4', 'Dee',    'Disabled', '703-555-0161', '+17035550162', 'Old Dominion Realty',   null,           null, null),
  ('00000000-0000-4000-8000-0000000000c5', 'Omar',   'Broker',   '703-555-0171', null, 'Potomac Brokers',       '703-555-0170', '9 Main St, Alexandria, VA', null)
) as v(id, f, l, ph, cell, co, cph, ca, lic)
where p.id = v.id::uuid;
update public.profiles set status = 'disabled' where id = '00000000-0000-4000-8000-0000000000c4';

-- 4. assignments by email (nina.newagent has no account yet: works before sign-up)
insert into public.assignments (client_email, rep_id) values
  ('sam.agent@example.com',      '00000000-0000-4000-8000-0000000000b1'),
  ('lee.lender@example.com',     '00000000-0000-4000-8000-0000000000b1'),
  ('dee.disabled@example.com',   '00000000-0000-4000-8000-0000000000b2'),
  ('omar.broker@example.com',    '00000000-0000-4000-8000-0000000000b2'),
  ('nina.newagent@example.com',  '00000000-0000-4000-8000-0000000000b2');

-- 5. photo metadata (no storage objects are created by SQL seed; upload through the app)
insert into public.photos (owner_id, storage_path, mime_type, size_bytes) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b1/avatar', 'image/jpeg', 48211),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1/avatar', 'image/png',  52114);

-- 6. quotes; created_at is back-dated (allowed for server-side sessions only)
insert into public.quotes (id, owner_id, quote_type, label, state, county, property_address, price, inputs, results, fee_version, created_at, deleted_at) values
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-0000000000c1', 'buyer',      'Buyer, 123 Main St',       'MD', 'Montgomery', '123 Main St, Bethesda, MD',  525000, '{"type":"purchase"}', '{"headline":{"label":"Buyer total","value":14250.55}}', '20261023d', now() - interval '2 days',  null),
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-0000000000c1', 'seller_net', 'Seller net, 9 Oak Ave',    'MD', 'Montgomery', '9 Oak Ave, Silver Spring, MD', 610000, '{}',                  '{"headline":{"label":"Net proceeds","value":541200}}',    '20261023d', now() - interval '10 days', null),
  ('00000000-0000-4000-8000-00000000f003', '00000000-0000-4000-8000-0000000000c1', 'buyer',      'Buyer, 77 Pine Rd (29 days old)', 'MD', 'Howard', '77 Pine Rd, Columbia, MD', 430000, '{}',                  '{"headline":{"label":"Buyer total","value":11800}}',      '20261023d', now() - interval '29 days', null),
  ('00000000-0000-4000-8000-00000000f004', '00000000-0000-4000-8000-0000000000c1', 'buyer',      'Buyer, 5 Old Ln (31 days old, EXPIRED)', 'MD', 'Howard', '5 Old Ln, Columbia, MD', 300000, '{}',            '{"headline":{"label":"Buyer total","value":9000}}',       '20261023d', now() - interval '31 days', null),
  ('00000000-0000-4000-8000-00000000f005', '00000000-0000-4000-8000-0000000000c2', 'buyer',      'Buyer, 800 K St',          'DC', 'District of Columbia', '800 K St NW, Washington, DC', 750000, '{}', '{"headline":{"label":"Buyer total","value":31000}}',  '20261023d', now() - interval '1 day',   null),
  ('00000000-0000-4000-8000-00000000f006', '00000000-0000-4000-8000-0000000000c5', 'buyer',      'Buyer, 41 River Rd',       'VA', 'Fairfax',    '41 River Rd, Fairfax, VA',   680000, '{}',                  '{"headline":{"label":"Buyer total","value":17400}}',      '20261023d', now() - interval '3 days',  null),
  ('00000000-0000-4000-8000-00000000f007', '00000000-0000-4000-8000-0000000000c3', 'buyer',      'Buyer, 2 Unassigned Way',  'VA', 'Norfolk',    '2 Unassigned Way, Norfolk, VA', 350000, '{}',               '{"headline":{"label":"Buyer total","value":8200}}',       '20261023d', now() - interval '5 days',  null),
  ('00000000-0000-4000-8000-00000000f008', '00000000-0000-4000-8000-0000000000b1', 'buyer',      'Jane test quote',          'MD', 'Montgomery', '1 Rep Test Ct, Rockville, MD', 500000, '{}',                '{"headline":{"label":"Buyer total","value":13000}}',      '20261023d', now() - interval '4 days',  null),
  ('00000000-0000-4000-8000-00000000f009', '00000000-0000-4000-8000-0000000000c1', 'buyer',      'Buyer, 300 Hidden St (deleted by client)', 'MD', 'Montgomery', '300 Hidden St, Bethesda, MD', 400000, '{}', '{"headline":{"label":"Buyer total","value":10100}}',  '20261023d', now() - interval '6 days',  now() - interval '5 days');

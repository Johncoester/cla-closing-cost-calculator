# CLA Quote Portal: foundation (branch `portal-foundation`)

Status: **local only.** Nothing is pushed, deployed, or signed up for. Target platform: **Supabase** (John's choice).
Everything runs today in **demo (mock) mode** with sample data; the Supabase pieces are written and the
database part is tested, but no Supabase project exists yet.

## What exists

```
index.html                      calculator; +1 script tag and a read-only window.CLA_QUOTE_API (no calc logic changed)
portal/
  login.html  forgot.html  set-password.html     sign in, reset request, accept invite / choose password
  rep.html    client.html  admin.html            dashboards (rep: my clients + their quotes; client: my quotes + my rep photo; admin: users, quotes, assignments, audit log, invite)
  profile.html                                   profile + photo upload (JPEG/PNG, 2 MB, client-side check)
  quote.html  quote-saved.html                   saved-quote viewer with co-branded header (client + rep photos, prints); "quote saved" confirmation
  portal.css                                     same clean, bright look as the calculator
  js/auth-adapter.js                             THE seam: adapter contract (documented at top), photo rules, adapter loader
  js/mock-adapter.js + mock-data.js              demo back end (localStorage), mirrors the DB access rules
  js/supabase-adapter.js                         real back end: supabase-js from CDN (pinned 2.118.0), RLS-reliant
  js/portal-ui.js  js/portal-hook.js             shared helpers; calculator hook (auto-save, co-brand header, Log in / Save buttons)
  config.example.js  (config.js is gitignored)   { mode: "mock" } or { mode: "supabase", url, anonKey }
  test-portal.js                                 50 adapter checks, no browser:  node portal/test-portal.js
  tools/screenshots.py                           regenerates /workspace/portal-preview/*.png
supabase/
  migrations/20261024000001_schema.sql           tables, constraints, triggers, helper functions, invite gate
  migrations/20261024000002_rls_and_rpc.sql      RLS policies, per-column grants, RPC functions
  migrations/20261024000003_storage_photos.sql   private 'avatars' bucket + storage policies
  migrations/20261024000004_purge_job.sql        30-day purge function + pg_cron schedule
  functions/invite-user, functions/set-user-status   Edge Functions (service-role key stays server side; untested)
  seed.sql                                       fictional local test data (never for a real project)
  tests/run-tests.sh                             throwaway local Postgres + 158 access-rule checks
```

## Run it

* Demo: copy `portal/config.example.js` to `portal/config.js` (already present locally), serve the repo folder
  (`python3 -m http.server`) and open `/portal/login.html`. Demo accounts are listed on the login page. Any password works in
  demo mode; the mock never stores or checks passwords. Open `/index.html` while signed in to see auto-save.
* Calculator tests: `node test.js` (still ALL PASS).
* Adapter tests: `node portal/test-portal.js`.
* Database tests: `bash supabase/tests/run-tests.sh` (needs `postgresql` + `postgresql-17-cron` packages; prints SKIPPED if Postgres is absent).
  It starts a temporary cluster, loads a small Supabase stand-in (`tests/00_supabase_shim.sql`: auth.uid(), auth.users, storage tables, roles),
  runs the four migrations twice (re-runnable), seeds, and impersonates each role the way PostgREST does.

## John's decisions as built

| Decision | Where |
|---|---|
| Email + password login, invite only | Supabase Auth; `private.handle_new_user()` rejects any email without a pending invitation, even if the dashboard sign-up toggle is left on |
| Quotes auto-save to the client's account | `portal-hook.js`: first change in the calculator creates the quote, later changes update it (3 s debounce, never on page load); "Save as new quote" starts another |
| Auto-delete 30 days after creation | `quotes.expires_at` = `created_at + 30 days` set by trigger (clients can't set or extend it); RLS hides expired rows instantly; nightly pg_cron job `purge-expired-quotes` (03:15 UTC) deletes them and writes an audit row |
| Photos only, JPEG/PNG, 2 MB | UI check (type, size, magic bytes) + `photos` table checks + bucket `allowed_mime_types`/`file_size_limit`; browser also crops to 512 px and re-encodes (drops GPS EXIF) |
| Roles: super admin / rep / client | `profiles.role`; changed only by `admin_set_role()`; role is never read from user metadata |
| Rep: invited, CLA email, phone, assigned agents and clients | rep rows require `@clatitle.com` (DB check); phone required by the profile screen; assignments by email, one active rep per client email |
| Clients/agents: matched to reps by email, name + company info | `assignments.client_email` works before the client has an account; links on sign-up |
| Guest quoting undecided | The calculator is unchanged for guests. Without `portal/config.js` the hook does nothing at all. With config, guests only see a "Log in to save" button |
| Headshots on quotes and logins | co-branded header in the calculator and `quote.html` (client + rep); avatar chip in every signed-in header and on dashboards |

Access rules in one table (details and comments in migration 2):

| | Self | Rep | Admin |
|---|---|---|---|
| profiles | read/update own (not role/status/email/photo path) | read assigned clients | read all, edit non-sensitive fields; role/status via RPC |
| quotes | read/insert/edit own live quotes | read assigned clients' live quotes | read all, delete |
| photos + files | own | assigned clients' | all, can remove |
| audit log | no | no | read only; append-only trigger |
| client reads rep | `get_my_rep()` returns name, phone, email, photo path only | | |

## What is mocked, what is real

| Piece | State |
|---|---|
| Screens, adapter contract, calculator hook | Real, working in the browser against the mock |
| Mock adapter | Fake: localStorage, no email, no passwords |
| Postgres schema, RLS, storage policies, purge job, RPCs | Real SQL; tested on local Postgres 17 + pg_cron with a Supabase stand-in. **Not yet run on actual Supabase** |
| Supabase adapter | Written to documented supabase-js v2 APIs and unit-tested against a fake client. **Not run against a live project** |
| Edge Functions (invite, disable+ban) | Written, never deployed or run |
| Invite email, password-reset email | Needs the Supabase project + custom SMTP (not done) |
| Terms/privacy text | Placeholder alert; counsel text needed |
| Admin MFA | DB support exists (`app_settings.require_admin_mfa`, default `false`); **no MFA enrollment screen yet** |
| HEIC (iPhone) photos | Refused with a message; browser conversion not built |

## Next steps: Supabase (recommended path)

John creates and owns the account (CLA email, a second owner); then, in order:
1. Create the project (Pro plan before real data). Database > Extensions: enable `pg_cron`.
2. Apply the migrations: `supabase link` + `supabase db push`, or paste the four files into the SQL editor in order. **Do not** run `seed.sql` or `tests/00_supabase_shim.sql` there.
3. Auth settings: turn **off** "Allow new users to sign up"; password minimum length 12 and required character types; enable leaked-password protection (Pro) and CAPTCHA; add a custom SMTP sender (e.g. Resend on `auth.clatitle.com`; the built-in mailer only reaches team members); set Site URL and add the allowed redirect `…/portal/set-password.html*`; edit the invite and recovery email templates.
4. Deploy the Edge Functions (`supabase functions deploy invite-user set-user-status`) and set `PORTAL_ORIGIN` to the site's origin.
5. Bootstrap the first admin from the SQL editor (no one can invite before one exists):
   `insert into public.invitations (email, role) values ('john@clatitle.com', 'super_admin');` then Auth > Users > "Invite user" with that email.
6. Copy the project URL and **anon/publishable** key into `portal/config.js` (`mode: "supabase"`). Never the service-role key.
7. Build the admin MFA enrollment screen (Supabase `auth.mfa.enroll/challenge/verify`), enroll admins, then `update public.app_settings set value='true' where key='require_admin_mfa';`.
8. Run the access tests on a staging project with real Auth users (the seed users have no password; use "Send password recovery"), try cross-user reads by hand, restore-test a backup.
9. Counsel review (privacy notice, RESPA co-branding, 30-day rule vs. record-keeping duties) before any real client data.

## If AWS is chosen instead (RDS Postgres + Cognito + S3)

Reusable as is: the screens, `auth-adapter.js` contract, `mock-adapter.js`, tables/constraints/triggers (migration 1 minus the `auth.users` hooks), policy logic (migration 2), purge function (migration 4; `pg_cron` exists on RDS, or schedule via EventBridge).
Must be written: (a) an **API layer** (API Gateway + Lambda), because browsers cannot talk to RDS; it verifies the Cognito JWT, then runs each request in a transaction with `set local app.user_id = '<sub>'` and `set local role authenticated`, with `auth.uid()` redefined to read that setting, so the same RLS applies; (b) a Cognito user pool: invite-only (`AdminCreateUser`), password policy, email via SES, admin MFA, plus a post-confirmation Lambda replacing `handle_new_user`; (c) S3 private bucket with presigned upload/download URLs issued by the API, 2 MB + type limits in the presign conditions, and the "paired rep/client" rule re-implemented in the API (storage policies do not carry over); (d) `aws-adapter.js` implementing the contract; (e) VPC, secrets, backups, and monitoring that Supabase gives out of the box. Expect noticeably more build time and a higher monthly floor than Supabase Pro.

## Things to know / open questions

* **Gitignored config vs GitHub Pages:** GitHub Pages only serves committed files, so a gitignored `portal/config.js` would never reach the live site and the portal would stay off. The anon key is public by design, so committing `config.js` is acceptable; alternatively generate it in a deploy step. Decide before go-live. Until then the live calculator is unaffected.
* `supabase/` and `portal/tools/` would also be published by Pages if pushed. The SQL contains no secrets but exposes the schema; consider a separate private repo for `supabase/`.
* supabase-js is loaded from jsDelivr, version-pinned, without an SRI hash (jsDelivr serves a generated file and advises against SRI for it). Self-hosting a copy under `portal/vendor/` removes the third-party dependency; one-line change in `auth-adapter.js`.
* 30 days is shorter than the plan's 2-year placeholder and means admins also lose quotes at 30 days (no longer "kept until retention ends"). Implemented as told; counsel/record-keeping should confirm. To change it: `private.quotes_set_expiry()` and the retention note in `app_settings`.
* A rep can still see a client's live quotes if the client is disabled (the assignment is unchanged). Reassigning the client moves access immediately.
* Rep invites of a client who belongs to another rep fail with a message that reveals the client already has a rep. Acceptable inside CLA; tighten if reps should not learn that.
* Seed reps use `sample.rep.*@clatitle.com` because the database insists on CLA addresses; no email is ever sent from seed data.

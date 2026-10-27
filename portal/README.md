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
  test-portal.js                                 119 adapter checks, no browser:  node portal/test-portal.js
  tools/screenshots.py                           regenerates /workspace/portal-preview/*.png
supabase/
  migrations/20261024000001_schema.sql           tables, constraints, triggers, helper functions, invite gate
  migrations/20261024000002_rls_and_rpc.sql      RLS policies, per-column grants, RPC functions
  migrations/20261024000003_storage_photos.sql   private 'avatars' bucket + storage policies
  migrations/20261024000004_purge_job.sql        30-day purge function + pg_cron schedule
  migrations/20261025000005_cell_phone.sql       cell_phone on profiles + invitations (E.164 check), get_my_rep_contact(), create_invitation(+cell)
  migrations/20261026000015_admin_last_sign_in.sql  admin_list_last_sign_ins(): auth.users.last_sign_in_at per profile (admin/super admin only) for the Users table badge
  migrations/20261025000006_admin_also_rep.sql   profiles.is_rep: a super admin who ALSO works as a rep; admin_set_is_rep(); create_invitation(+is_rep, +as_rep)
  functions/invite-user, functions/set-user-status   Edge Functions (service-role key stays server side; untested)
  seed.sql                                       fictional local test data (never for a real project)
  tests/run-tests.sh                             throwaway local Postgres + 314 access-rule checks + an upgrade check (migrations 1-5 with data, then 6)
```

## Run it

* Demo: copy `portal/config.example.js` to `portal/config.js` (already present locally), serve the repo folder
  (`python3 -m http.server`) and open `/portal/login.html`. Demo accounts are listed on the login page. Any password works in
  demo mode; the mock never stores or checks passwords. Open `/index.html` while signed in to see auto-save.
* Calculator tests: `node test.js` (still ALL PASS).
* Adapter tests: `node portal/test-portal.js`.
* Database tests: `bash supabase/tests/run-tests.sh` (needs `postgresql` + `postgresql-17-cron` packages; prints SKIPPED if Postgres is absent).
  It starts a temporary cluster, loads a small Supabase stand-in (`tests/00_supabase_shim.sql`: auth.uid(), auth.users, storage tables, roles),
  runs all six migrations twice (re-runnable), seeds, and impersonates each role the way PostgREST does.

## John's decisions as built

| Decision | Where |
|---|---|
| Email + password login, invite only | Supabase Auth; `private.handle_new_user()` rejects any email without a pending invitation, even if the dashboard sign-up toggle is left on |
| Quotes auto-save to the client's account | `portal-hook.js`: first change in the calculator creates the quote, later changes update it (3 s debounce, never on page load); "Save as new quote" starts another |
| Auto-delete 30 days after creation | `quotes.expires_at` = `created_at + 30 days` set by trigger (clients can't set or extend it); RLS hides expired rows instantly; nightly pg_cron job `purge-expired-quotes` (03:15 UTC) deletes them and writes an audit row |
| Photos only, JPEG/PNG, 2 MB | UI check (type, size, magic bytes) + `photos` table checks + bucket `allowed_mime_types`/`file_size_limit`; browser also crops to 512 px and re-encodes (drops GPS EXIF) |
| Roles: super admin / rep / client | `profiles.role`; changed only by `admin_set_role()`; role is never read from user metadata. A super admin can ALSO work as a rep: `profiles.is_rep` (migration 6, below) |
| Cell phone for everyone (reps, clients/agents, admins); optional | `profiles.cell_phone` (migration 5): US only, stored `+1XXXXXXXXXX` (trigger normalizes, CHECK backstops); the person edits their own; the assigned rep/client and admins see it; can be entered when inviting |
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
| client reads rep | `get_my_rep_contact()` returns name, phone, cell, email, photo path only (`get_my_rep()` is kept, without the cell) | | |

### Cell phone number (migration 5)

* **Columns:** `profiles.cell_phone` (nullable) and `invitations.cell_phone` (nullable). The older `profiles.phone` (main/office line, required for reps) is unchanged.
* **Format:** US only. Anything typed ("(240) 555-0142", "240.555.0142", "1 240 555 0142", "+12405550142") is stored as `+12405550142`. Blank = none. A BEFORE trigger raises a readable error (SQLSTATE 22023) for bad input, and a CHECK constraint (`^\+1[2-9]\d{2}[2-9]\d{6}$`) is the backstop. The browser applies the same rule (`CLA.normalizePhone`) and formats as you type (`CLA.formatPhoneInput`).
* **Who can edit:** the existing UPDATE policies and per-column grants, with `cell_phone` added to the grant list: the owner edits their own row, a rep cannot edit a client's, admins can (as for all non-sensitive profile fields).
* **Who can see:** unchanged profile rules (self, admin, assigned rep). A client reads their rep's cell through the new `get_my_rep_contact()`. A rep also reads the *pending* invitation of a client assigned to them (new policy `invitations_select_rep_assigned`) so an invited-but-not-signed-up client's cell shows on the dashboard.
* **Invitations:** `create_invitation(p_email, p_role, p_rep_id, p_cell_phone)` (the 3-argument version is dropped); the invite-user Edge Function passes `cellPhone` through; the number is copied to the new profile at sign-up (`private.handle_new_user`).
* **Why a new `get_my_rep_contact()` instead of changing `get_my_rep()`:** a function's return type cannot change with `create or replace`, and migrations here are re-run in order; editing migration 2 was avoided. Before the first real deploy, `get_my_rep()` can be dropped and the adapter pointed at one function.
* **Screens:** profile (edit, formats as typed, inline validation), invite forms (rep and admin), rep dashboard (client Cell column with `tel:` links, own cell in the header), client dashboard (rep's cell as a `tel:` link, own cell), admin users table, co-branded quote header/print (rep's cell, falling back to the office phone).

### A super admin who also works as a rep (migration 6)

John (super admin) also sells: he is assigned clients, invites clients, sees his own clients' quotes, appears on co-branded quotes
with his photo, cell and office phone, and shows up in rep pickers, all with ONE login.

* **Design (least risky): `role` is untouched; one new boolean `profiles.is_rep`.** "Is a rep" means `role = 'rep' OR (role = 'super_admin' AND is_rep)`.
  It is defined once, in `private.is_rep()`, which every rep RLS policy and helper already called, so those policies did not change.
  Added/changed: `rep_of()` (so `get_my_rep()` / `get_my_rep_contact()` find him), `assignments_before()` (who can be assigned clients),
  `quotes_set_expiry()` (his own quotes carry `rep_id` = him, like a rep), `handle_new_user()`, `is_complete` (phone required for anyone who is a rep),
  the `@clatitle.com` checks, `create_invitation()`.
* **Guards:** `role='rep'` => `is_rep` is forced true; `role='client'` => forced false (trigger, plus CHECK `profiles_is_rep_role` as backstop), so a client can never be a rep.
  The column is **not** in the per-column UPDATE grant, so nobody can flip it through the API. Only `public.admin_set_is_rep(user, bool)` (super admin only; target must
  be a super admin with an `@clatitle.com` email; switching OFF is refused while the person still has active clients; audited as `rep_flag_changed`) or an invitation can set it.
* **He keeps everything:** the admin policies are unchanged, so he still sees and does everything. Where he acts *as a rep* the app asks the database for rep rules:
  `create_invitation(..., p_as_rep := true)` (from the rep dashboard: the client is assigned to him and he can never take over another rep's client; the admin form,
  with an explicit rep, may reassign). His own-client list filters `assignments.rep_id = me` (an admin can read every assignment, so RLS alone would list everyone).
* **MFA:** if `require_admin_mfa` is on and he is at aal1, `is_admin()` is false but `is_rep()` is still true: that session gets exactly rep-level access (his clients only), never more.
* **Role changes:** rep promoted to super admin keeps `is_rep` (his clients stay his); super admin promoted to rep sets it; any move to client clears it. Turning it off later does not rewrite history (old quotes keep their `rep_id`).
* **Screens:** admin Users table has an "Also works as a rep" checkbox on every super admin row (own row included); the admin invite form has the same option for a new super admin;
  assignment pickers (Assign tab, invite form) list admin+rep accounts as "Name (admin + rep)"; the header shows **Rep dashboard** next to **Admin dashboard** for admin+rep accounts
  (portal pages and the calculator header); the rep dashboard works for them and says it only shows *their* clients; the calculator header/quote viewer show his photo, cell and office phone like a rep.
* **Adapters:** `Profile.isRep` (see `auth-adapter.js`), `adminSetIsRep(userId, on)`, `adminInvite({..., isRep})`; `inviteClient` always sends `repId` = me and `asRep`.
* **Edge function `invite-user`:** passes `isRep` / `asRep` to `create_invitation()`. It is backwards compatible with the previous deploy (the new parameters have defaults), so the order does not matter, but apply the SQL first.
* **Applying it to a live project:** run `20261025000006_admin_also_rep.sql` in the SQL editor (idempotent). To make a not-yet-signed-up admin an admin+rep from day one:
  `update public.invitations set is_rep = true where email = 'jcoester@clatitle.com' and accepted_at is null;` Otherwise just tick "Also works as a rep" on the Users tab after signing in.
  Do not re-run migration 5 on its own after this one (it would re-create the old 4-argument `create_invitation`; drop it again if that ever happens).

### Roles and who can do what (migrations 9, 10 and 11: the `admin` role)

Four roles: **super_admin**, **admin**, **rep**, **client**. An **admin** gets the full admin dashboard (all users, quotes, assignments, invitations, audit log)
and can manage **reps, clients and other admins** (disable / re-enable, demote to rep or client, edit profile / photo, reassign clients). An admin can **never touch a super admin,
never promote anyone to admin or super admin, and never invite an admin or super admin**: those are super-admin-only. (Migration 10 shipped admins who could manage only reps and clients; migration 11 added "and other admins".)

| Action | Super admin | Admin | Rep | Client |
|---|---|---|---|---|
| See all users, quotes, assignments, invitations, audit log, photos | yes | yes | own clients only | self |
| Invite a rep or client | yes | yes | clients only (assigned to them) | no |
| Invite an admin or super admin (with or without "also a rep") | yes | **no** | no | no |
| Disable / re-enable a rep, client or **another admin** | yes | **yes** | no | no |
| Disable / re-enable a super admin | yes (never themselves, never the last active super admin) | **no** | no | no |
| Change role rep <-> client; **demote another admin to rep or client** | yes | **yes** | no | no |
| Promote to admin / super admin (any role change whose NEW role is admin or super_admin) | yes | **no** | no | no |
| Change or demote a super admin | yes (never themselves, never the last active super admin) | **no** | no | no |
| Toggle "also works as a rep" on an admin or super admin (CLA email; off is refused while they have active clients) | yes | **no** (not even their own) | no | no |
| Reassign clients to reps | yes | yes | no | no |
| Edit profile fields / delete the photo of a rep, client or **another admin** | yes | **yes** | no | no |
| Edit profile / photo of a super admin | yes | **no** | no | no |
| Disable or demote themselves | no | no | no | no |
| Hard-delete quotes | yes | yes | no | no |
| App settings (`require_admin_mfa` ...) | SQL editor / dashboard only (no API grants) | none | none | none |

* **One rule everywhere.** `private.is_admin()` = super admin **or** admin (and aal2 when `require_admin_mfa` is on), so every existing "admin sees everything" policy and RPC works for both.
  `private.is_super_admin()` is the stricter check. `private.can_manage_user(target)` is the single "may the caller act on this person" rule: a super admin can act on anyone,
  an admin on a rep, client or admin (never a super admin). `admin_set_role`, `admin_set_status`, `admin_set_is_rep`, `create_invitation`, the `profiles_update_admin` policy and the photo/storage delete policies all use these helpers.
  Promotion is a separate rule inside `admin_set_role` (non-super-admins may only set rep / client), and invites / the rep switch are super-admin-only RPC checks.
* **Last-super-admin guard.** A trigger (`profiles_last_super_admin_trg`) refuses any change that would leave zero active super admins (demote, disable, delete, including the cascade from deleting an auth user,
  the SQL editor and the service role). It serialises concurrent attempts with an advisory lock. A super admin also cannot disable or demote themselves (the older rule).
* **"Also works as a rep" for an admin** follows the same rule as for a super admin (CLA email only, `is_rep` flag, `private.is_rep()` is the one definition), but only a super admin may flip it.
  Consequence worth knowing: when an admin demotes another admin to **rep**, that person becomes a rep (reps always are, CLA email required); to **client** clears the flag.
* **A rep's clients are never left without a rep (migration 12).** If a change would stop someone who works as a rep (role rep, or admin / super admin with the rep switch on) from being a rep while they still have
  **active clients** (their role is changed to Client, or a super admin switches "also works as a rep" off), the database refuses it (55006) unless the call names the successor:
  `admin_set_role(p_user, p_role, p_reassign_to)` / `admin_set_is_rep(p_user, p_is_rep, p_reassign_to)`. The successor must be an **active, rep-capable** user and not the same person (23514 otherwise).
  Then **all** their active assignments move in the same transaction: old rows go inactive, new rows are created for the successor (each one audited as `assignment_changed`), and the `role_changed` /
  `rep_flag_changed` audit row records `clients_moved` and `moved_to`. Nothing moves (and `p_reassign_to` is ignored) when there are no active clients, or the change keeps rep capability
  (rep <-> admin / super admin keeps the flag). Who may call these is unchanged: an admin still cannot promote anybody or touch a super admin; the rep switch is still super-admin-only.
  In admin.html, picking such a change opens **"Move N realtors to…"** (a list of the other eligible reps with their current client counts; Cancel / Escape changes nothing and the dropdown snaps back;
  with no other eligible rep it says so and offers only Cancel). Adapters: `adminSetRole(id, role, reassignTo?)`, `adminSetIsRep(id, on, reassignTo?)`. The new parameter changes the function signatures, so
  migration 12 **drops** the old two-argument versions (old callers, positional or by name, resolve to the new ones).
* **UI.** The role dropdown (admin.html) shows all four roles to a super admin; an admin sees Rep / Client for reps and clients and Admin / Rep / Client for another admin (no way up).
  Super admin rows show a static badge, a greyed-out Disable button and a tooltip explaining why (hover or keyboard focus). The invite form offers Admin / Super admin only to a super admin.
  Route guards (`boot(["super_admin","admin"])`), the header links and `CLA.roleLabel()` ("Admin", "Admin + rep") know the new role.
  The database is the authority: the buttons are a courtesy, a forced call is still refused with a readable message.
* **Why migrations 9 and 10 are two files.** Postgres will not let a new enum value be *used* in the transaction that adds it (`unsafe use of new value`), and Supabase runs each migration file as one transaction.
  `20261025000009_admin_role_enum.sql` only adds the value; `20261025000010_admin_role.sql` uses it. They are live. **Migrations 11 (`20261025000011_admin_manage_admins.sql`) and 12 (`20261025000012_reassign_on_demote.sql`) are plain forward-only files** (no enum change). Apply 11, then 12, each as its own run. Migration 11:
  it replaces `private.can_manage_user`, `admin_set_role` and `admin_set_status` (same signatures, safe to run twice); the three policies that call `can_manage_user` follow automatically.
  Existing data is untouched: nobody changes role or status.
* **Tests.** `bash supabase/tests/run-tests.sh` (throwaway local Postgres; includes upgrade stages: 1-5 then 6; 1-6 then 9+10, which proves 9+10 in a single transaction fail and in two succeed;
  1-10 with data then 11, which proves the old rule before and the new rule after, idempotently; 1-11 with data then 12, which proves a demoted rep's clients can no longer be stranded), `node portal/test-portal.js` (mock adapter, supabase adapter against a fake client, jsdom render of admin.html as Admin vs Super admin), `node test.js`.
  Screenshots (demo mode): `portal/tools/screenshots_admin_role.py`.
* **Not covered here:** the Edge Functions `invite-user` / `set-user-status` only forward to the DB RPCs (comments updated for migration 11; nothing to redeploy for behaviour). The `?v=` cache-bust in `index.html` should be bumped with the release.

## Staff feedback (migration 13)

A small **Feedback** button in the header (portal pages and the calculator) for **staff only**: super admin, admin and rep. Clients / realtors and signed-out visitors never see it (the file is not even downloaded for them, and the database refuses them anyway).

- **Dialog:** John's greeting at the top ("Hey! I am John Coester here to help you. Give me some feedback."), a category (Bug / Idea / Question / Other), a message (required, 2000 characters at most, live counter). The page is captured automatically, **path only** (no query string, no `#` part). No urgency field. After sending: "Thanks, John will review it." The dialog also lists the person's own submissions with their status ("Received", "John has been told", "Approved", "Closed") and John's note, if any.
- **Where it lives:** `js/feedback-widget.js` + `feedback-widget.css`, loaded on demand by `CLA.startFeedback` (`portal-ui.js`, called from `CLA.boot`) and by `portal-hook.js` on the calculator. It sits in the header, not in the bottom-right corner, so it will not collide with a future chat launcher. It does not depend on the `chatbot` branch.
- **Admin tab "Feedback"** (`admin.html`): admin and super admin see everything (filter by status, category, text). **Only a super admin** can Approve / Dismiss, with an optional note; an admin sees it read only.
- **Database (`20261025000013_staff_feedback.sql`, forward-only):** table `public.feedback` (id, created_at, user_id, role_at_submit, category, message, page_path, status, notified_at, decided_at, decided_note, user_agent). RLS on; the API roles can only SELECT (staff their own rows, admin / super admin all). Rows are written ONLY by `submit_feedback(category, message, page)` (active staff only; trims and validates; **10 per hour, 40 per day** per person; stamps the role and user agent server-side, so none of that can be forged) and decided ONLY by `admin_set_feedback_status(id, status, note)` (super admin only; `approved` or `dismissed`). Both are audited (`feedback_submitted` with the category only, never the message; `feedback_decided` with before/after). `user_id` is `on delete set null`, so deleting a user keeps the feedback.
- **Statuses:** `new` (just sent) -> `notified` (the assistant told John; set from SQL only) -> `approved` / `dismissed` (super admin in the app, or SQL).
- **Messages are untrusted text:** shown with `textContent` / `esc()` everywhere.
- **Apply live (when approved):** run `20261025000013_staff_feedback.sql` once in the Supabase SQL editor (nothing else: no Edge Function change), then deploy the site (the `?v=20261025g` cache-bust in `index.html` makes browsers fetch the new calculator hook). Until the migration is applied, the button works only in demo mode; on live it would show an error when sending.
- **For an assistant / routine (service role or SQL editor; the API cannot do these):**

```sql
-- read-only: new, not yet notified
select id, created_at, role_at_submit, category, message, page_path, user_id,
       (select email from public.profiles p where p.id = f.user_id) as email
  from public.feedback f where status = 'new' order by created_at;
-- after telling John
update public.feedback set status = 'notified', notified_at = now() where id in ('<id>') and status = 'new';
-- when John decides
update public.feedback set status = 'approved',  decided_at = now(), decided_note = '<optional note>' where id = '<id>';
update public.feedback set status = 'dismissed', decided_at = now(), decided_note = '<optional note>' where id = '<id>';
```

Screenshots: `portal/tools/screenshots_staff_feedback.py` (demo mode).

## Guided tour (migration 14)

A short click-through for NEW people, in John's voice ("Here's where you'll..."), 6-7 steps per role. It starts by itself the first time someone opens their dashboard after finishing their profile, and anyone can replay it from **Take the tour** in the header (it sits next to the Feedback button for staff: Feedback, Take the tour, profile, Sign out).

- **Who sees what:** super admin / admin (users and roles, who can invite whom, the invite form, "also works as a rep" for super admins, assignments, the Feedback tab: admins read, super admins approve / dismiss; the reassign-clients note is part of the roles step), rep (dashboard, clients, invite a client, quotes, profile and cell phone, the calculator; an admin who also reps gets a step about the two dashboards), client / realtor (new quote and sign-in, auto-save and the 30 day clean-up, saved quotes, the profile with its photo placeholder, "talk to my rep", the estimates-only note).
- **Where it lives:** `portal/js/tour.js` + `portal/tour.css`, plain JavaScript, no libraries and no CDN. It is loaded only when someone is about to see it (`CLA.initTour` / `CLA.takeTour` in `portal-ui.js`). Targets are `data-tour="..."` attributes on existing elements. The step text is in `CLA.tourSteps()` in `tour.js`.
- **One page per tour (the simple, robust choice):** each tour stays on the person's own dashboard (`admin.html`, `rep.html`, `client.html`), so no step navigates and there is no progress to carry between pages. Steps that need a tab or the invite form open it first and put it back when you move on; Done / Skip / Esc restore the first tab. The "Take the tour" link on any other page (profile, quote pages) goes to your dashboard with `?tour=1`, which starts the tour and then removes `?tour=1` from the address.
- **A missing or hidden target is skipped** (for example the "also works as a rep" switch for an Admin), and "Step n of N" counts only the steps shown.
- **Controls and accessibility:** Back / Next / Skip tour; Right and Left arrows move, Esc skips; Tab stays inside the box; the box is a labelled dialog (`aria-modal`, title and text are announced) that takes focus on every step, and focus returns to the "Take the tour" link at the end. The spotlight and box reposition on resize and scroll; the target is scrolled into view; on screens up to 640 px wide the box is a sheet at the bottom. Nothing animates when the person asks for reduced motion (`prefers-reduced-motion`).
- **Seen, kept on the server:** `profiles.tour_seen_at` (nullable). NULL = not yet. Done, Skip and Esc all call `markTourSeen()` -> the RPC `public.mark_tour_seen()`, which sets it for the current user only (first time wins; a replay never moves the date). The API cannot write the column directly (it is not in the profile update grants), and it plays no part in `is_complete`.
- **Existing people are not forced through it:** migration 14 sets `tour_seen_at = now()` for every profile that exists when it first runs (John, Matt, the admins, everyone). Only profiles created afterwards start with NULL. The backfill runs only in the run that adds the column, so running the file again never hides the tour from a new person.
- **Safe to deploy first:** if the site is deployed before the migration, the profile has no `tour_seen_at`; the portal reads that as "unknown" and never starts the tour by itself (the link still works). The tour also never starts twice in one browser tab, even if saving "seen" fails.
- **Demo mode:** the sample people have seen it; **Nia Newcomer** (client, `sample.new.client@example.com`) and **Riley Rookie** (rep, `sample.new.rep@clatitle.com`) have not, so signing in as them starts it. (Reset sample data to see it again.) Any other role: use "Take the tour".
- **Apply live (when approved):** run `20261025000014_tour_seen.sql` once in the Supabase SQL editor (no Edge Function change), then deploy the site. Either order is safe; migration first is cleanest.

Screenshots: `portal/tools/screenshots_guided_tour.py` (demo mode, desktop and mobile).

### Calculator tour (the main `index.html`; no database change)

The same engine also runs on the public calculator, for **anyone** (guest or signed in, no login needed): `Take the tour` in the calculator header, plus a small first-visit chip ("New here? Take a 1-minute tour") in the tab bar. Nothing opens by itself and no modal covers the calculator.

- **Where it lives:** the steps are `CLA.tourSteps("calculator", { signedIn })` in `portal/js/tour.js`; targets are `data-tour="k-..."` attributes added to existing elements of `index.html` (no behaviour or number changes). `index.html` has a tiny inline loader that downloads `portal/js/tour.js` + `portal/tour.css` only when the tour starts, so the calculator works exactly as before without it (and without the portal config).
- **Steps (13 for a guest, 14 with the portal's save button, 15 for staff with the feedback bubble):** welcome, Buyer Quote / Seller Net Sheet, Purchase / Cash / Refinance, ZIP (fills state and county), price and loan amount, title policy choices, CLA fees / endorsements / documents, the estimate total, the section breakdown (lender's and owner's title policies, settlement and CLA fees, recording fees and taxes), Copy quote / Print, the Seller Net Sheet, Save (auto-save when signed in, "Log in to save" for guests), the staff feedback bubble, "Take the tour any time", and the estimates-only disclaimer. Steps whose element is missing or hidden are skipped (the save and feedback steps only exist with the portal and a session) and the counter only counts what is shown.
- **Tabs:** the Seller Net Sheet step opens that tab and puts the person's own tab back afterwards (also if they skip or press Esc). The tour never clicks Purchase / Cash / Refinance, because switching those rebuilds the documents and endorsements and would discard edits; it only points at them. No fee or number is changed.
- **The chip:** shown only to someone who has not dismissed it. The x, starting the tour from the chip or from the header link all store `cla_calc_tour_chip = "1"` in `localStorage`, so it never comes back. If browser storage is blocked the chip is not shown at all. It does not print.
- **Phones:** the box is a bottom sheet (also for the centred welcome note); on desktop a tall target (the breakdown) gets the box beside it instead of on top of it.
- **Cache-bust:** `?v=20261027c` on `zip-county.js`, `fee-snapshot.js`, `portal-hook.js` and the tour loader, and `CLA.TOUR_V` in `portal-ui.js` (the feedback widget keeps `20261025g`).
- **Tests:** the "calculator tour" block in `portal/test-portal.js` (link, step counts, targets, skipping, tab restore, chip persistence, phone sheet, versions). Screenshots: `portal/tools/screenshots_calculator_tour.py`.

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
2. Apply the migrations: `supabase link` + `supabase db push`, or paste the six files into the SQL editor in order. **Do not** run `seed.sql` or `tests/00_supabase_shim.sql` there.
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

## "Invited, never signed in" badge (migration 15, local branch `invited-badge`, not applied live)
- **Problem:** a profile is `status = 'active'` from the moment of the invite, so the admin Users table showed "Active" for people who never opened their invite. `profiles.last_seen_at` cannot tell: no code writes it (it is NULL for everybody, including people who sign in daily).
- **Source of truth:** `auth.users.last_sign_in_at` (NULL until the first sign-in, which includes accepting the invite link). The browser cannot read the auth schema, so `20261026000015_admin_last_sign_in.sql` adds `public.admin_list_last_sign_ins()` (admin / super admin only, read-only, returns only `user_id` + `last_sign_in_at`). `adminListUsers()` merges it into `Profile.lastSignInAt` (ISO = signed in, `null` = never, `undefined` = unknown).
- **Badges (admin.html, Status column):** Disabled (unchanged) / **Invited, never signed in** (warn style, like "Invited, not signed up" in rep.html; tooltip with the invite date) / **Active** (tooltip: last signed in). If the migration is not applied yet the value is unknown and the page shows plain "Active" (never a wrong "Invited" label), so deploying the site before the migration is safe.
- **Apply live (when approved):** run `20261026000015_admin_last_sign_in.sql` once in the Supabase SQL editor (idempotent, no table/policy changes), then deploy. Either order is safe; migration first shows the badge immediately.
- **Edge:** someone who clicked the invite link but never finished setting a password has a sign-in time and shows "Active".

## Rep pricing tables: settlement fee only (migration 16, local branch `rep-pricing`, not applied live)
Named **pricing tables** (e.g. "Marvin's Pricing") hold lower **settlement fees** (`Settlement Fee to CLA Title & Escrow` only; premiums and recording fees can never change); admins and super admins add a rep's or an individual client's **email** to a table on the admin page's **Rep pricing** tab. One email, one table.
Design, the one rule for whose fee a person gets (own email's table first, else the assigned rep's table, else standard), tests, and how to apply: see [`REP-PRICING.md`](REP-PRICING.md). Cache-bust `?v=20261027c`.

# CLA Quote Portal: foundation (branch `portal-foundation`)

Status: **live** at https://quotes.clatitle.com/ (Supabase project, GitHub Pages). Branches are merged to `main` after John approves; each section below says which migration is applied. Target platform: **Supabase** (John's choice).
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
| Client contact details on printed / PDF quotes | the client side of the co-branded header (calculator screen + print, seller net sheet, `quote.html`) shows photo, name, company, phone, cell, company phone, company address, website and license / NMLS, only the ones filled in. One shared helper, `CLA.clientContactLines` (escapes every value; `CLA.safeWebsite` allows only absolute http/https, shown as text). Print / PDF: a 0.95 in photo, name 14 pt and short 10 pt lines (name, company, phone / cell, company phone, address, website, license). The rep block matches and now also shows the rep's email as plain text (`CLA.repContactLines`; the email already comes from `get_my_rep_contact()`, no migration) |

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

### Feedback status updates (migration 17: `20261027000017_feedback_status_updates.sql`)

The sender sees what happened to their note, inside the portal. **No e-mail or message is sent by anything** (John's rule: no outbound sends without his approval).

- **Statuses:** `new` -> `notified` (set by the assistant routine, shown to the sender as "Received") -> `approved` ("Approved · on the list") -> `shipped` ("Shipped" + what changed), or `dismissed` ("Not planned", the decision note only when there is one).
- **Database:** new columns `shipped_at`, `shipped_note` (<= 500), `sender_seen_status`; status `shipped` allowed; audit action `feedback_shipped`; `admin_mark_feedback_shipped(id, note)` (SUPER ADMIN only, approved items only, same permission as approve); `mark_my_feedback_seen(id default null)` (the sender marks their OWN notes seen: the only thing a sender can write); `admin_set_feedback_status()` now refuses a shipped item and resets the sender's seen marker when the status or the note changes. Already-decided rows are backfilled as seen. RLS is unchanged: a sender reads only their own rows and cannot change status.
- **Unread** = status in (approved, shipped, dismissed) and `sender_seen_status` is not the current status (`CLA.feedbackUnread`). The feedback bubble shows a red number dot; opening the panel marks everything seen (the "Updated" tags stay until the panel closes). "My suggestions" is the list in the panel (newest first, up to 10).
- **Admin Feedback tab:** approved items get a "What changed" box and **Mark shipped**; shipped items show the note; admins who are not super admins see it read-only. Filter has a Shipped status.
- **Adapters:** `adminMarkFeedbackShipped(id, note)` and `markMyFeedbackSeen(id?)` (supabase + mock). Mock seed: version 11 with a note in every status (Jane has 2 unread, Marcus 1, Robin 1).
- **Live:** migration 17 was applied on 2026-10-27 and the site deployed. The older site keeps working before the migration, but the new panel needs the new columns, so apply the migration first. Rollback of the site is `git revert`; the migration is additive (new columns and functions; the status constraint only gains `shipped`).
- **Screens:** `portal/tools/screenshots_feedback_status.py`.

## Delete a disabled user (migration 18) and the Users-tab filters

**Status: live since 2026-10-27 (commit `4fe0050`).**

- **Who:** super admins and admins, with the same reach as Disable (`private.can_manage_user`): never yourself, never the last active super admin, and an admin never a super admin (an admin may delete another admin). The person must be **disabled** first.
- **RPC** `admin_delete_user(p_user, p_confirm_email, p_reassign_to default null)` (security definer; admins only). Refusals in order: not admin 42501, no target 22023, yourself 42501, unknown P0002, admin vs super admin 42501, not disabled 55000, email mismatch 22023 (case / spaces ignored), last active super admin 55000, active clients and no successor 23514 (successor via `private.move_rep_clients`).
- **Deleted:** the profile (cascades: quotes they own, photo row), their assignments (as rep or as client), invitations and pricing-table membership for their email. The Edge Function `delete-user` then removes `avatars/<id>/avatar` and the auth user (so the email can be invited again).
- **Kept:** the audit log, plus a `user_deleted` row (email, role, name, was_rep, deleted_by_email, counts, successor, pricing table); feedback (author cleared); other people's quotes where this person was the rep (`rep_id` cleared, name removed); `assigned_by` / `invited_by` references cleared.
- **Triggers touched:** `quotes_set_expiry` (rep_id may go to null only when that rep no longer exists), `assignments_before` / `assignments_after` (clearing only `assigned_by` is not re-validated or audited). `audit_action_known` gains `user_deleted` (and `feedback_shipped`, missing from the list before).
- **Edge Function** `supabase/functions/delete-user`: runs the RPC as the caller first (so a refused request never touches auth), then storage + auth user (retried once); finishes a half-done delete if the typed email matches a banned leftover auth user.
- **UI (admin Users tab):** a **Delete...** button only on disabled rows (greyed with a tooltip when the actor may not manage that person; none on your own row). The dialog lists deleted / moved / kept, asks for a successor rep when needed, and enables **Delete permanently** only when the exact email is typed.
- **Filters (Users tab):** Role (All, Super admin, Admin, Rep, Client), Status (All, Active (not disabled), Disabled, Invited never signed in) and a search (name, email, company), combined, with "Showing N of M" and Clear filters. **Rep includes admins / super admins who also work as a rep** (`CLA.isRep`); a note appears under the filters. They keep their Admin label in the table.
- **Tests:** `10_access_rules.sql` (delete section), `95_upgrade_from_17.sql` (upgrade check 9), `test-portal.js` (mock + supabase adapter + admin screen + filters). Screens: `portal/tools/screenshots_delete_user.py`.
- **Live:** migration 18 applied, the `delete-user` function deployed (`verify_jwt` on) and the site published on 2026-10-27 (commit `4fe0050`). Before the migration the Delete button errors harmlessly (the function is missing).

## First-time homebuyer no longer moves the payer (local branch `fthb-split-default`; calculator only, no database change)
- **Before:** ticking First-time homebuyer used the sheet's `FTHB Paid By` column (Seller on every Maryland row), so all three Maryland taxes went 100% to the seller, and every tax line (any state) was labelled "(first-time buyer)".
- **Now:** the default payer is always the sheet's `Paid By` (Maryland: Split) whether the box is ticked or not. `FTHB Paid By` is only reported (`taxes[].fthbPayer`) and shown as a one-line note under the Who pays buttons ("the fee sheet lists the seller as the usual payer ... does not change who pays here"). The amount logic from the sheet is untouched: `FTHB Rate` (MD state transfer 0.25%; Cecil county transfer 0.25%), `FTHB Exempt ($)` (Caroline county transfer, extra $75,000), `FTHB Max Price` and DC's reduced recordation rate still apply.
- **Label:** "(first-time buyer)" now appears only on a tax whose amount the first-time rate / exemption really changed. VA and FL are unaffected by the box; DC's transfer tax is not labelled.
- **Seller net sheet:** the checkbox hint no longer says it can shift the tax to the seller.
- **Tests:** `test.js` (FTHB block in the tax-payer section, the MD/DC/VA/FL cases and the page test). Numbers before/after: `/workspace/fthb-fix-test/`.

## Florida title options (local branch `fl-title-1029`; calculator only, no database or sheet change)
- **What:** in Florida, "Owner's policy paid by" becomes **Who chose title** with the Florida Realtors / Florida Bar AS IS contract 9(c) options: Seller chose title (i), Buyer chose title (ii), Miami-Dade/Broward custom (iii). Values: `Seller`, `Buyer`, `MDB`, blank = local custom; old saved quotes keep their meaning.
- **What moves:** the owner's policy (seller only under (i)) and the sheet row "Title Search and Abstract" ($200): seller under (i), buyer under (ii), seller up to $200 under (iii) (excess to the buyer). Lender's policy, endorsements and settlement fees are unchanged. No lien search / tax search row exists on the sheet; none added.
- **Local custom:** Miami-Dade, Broward -> (iii); Collier, Sarasota (sheet Owner Policy Paid By = Buyer) -> (ii); all other counties -> (i). A note under the list explains the choice; the summary and copied text say "Title: ...".
- **Seller net sheet:** the "Seller pays the owner's title policy" box stays; ticked = (i), unticked = (iii) in Miami-Dade / Broward, otherwise (ii). The title search row is added to the seller's costs when the seller pays it.
- **Tests:** `test.js` (Florida title options block before the toggles section, DOM checks after the Florida FTHB checks; Q7 and SN FL Orange expectations moved: title search now seller-paid in Orange). Cache-bust 20261029b.

## Caroline Kim feedback 10/29 (local branch `caroline-1029`; calculator only, no database or sheet change)
- **VA assessed value:** optional Assessed value field (VA purchase / cash and VA seller net sheet only). Deed-based taxes (state + local grantee recordation, grantor, regional congestion relief, WMATA) use max(price, assessed) per Va. Code 58.1-801(A), 58.1-802(A), 58.1-802.3, 58.1-802.4; those lines say "(on assessed value)". Deed-of-trust taxes stay on the loan. DC is not included (DC 42-1103(a)(1)(A) taxes the consideration). Stored in `inputs.assessed` of a saved quote, shown in the summary, copied text, PDF and the saved quote header.
- **VA rounding:** per $100 or fraction (recordation, congestion / WMATA) and per $500 or fraction (grantor) were already in place; the odd cents came from the sheet's 0.0833 local rate, now applied as exactly one-third of the state rate (58.1-3800). Fairfax $450,000 / $360,000: state $1,125, local $375, DOT state $900, local $300.
- **MD first-time buyer:** the buyer's half of the state transfer tax is exempt and the seller pays the normal 0.25% (Tax-Property 13-203(b)(3); Real Property 14-104(c)(2)). The line is fixed to the seller (no payer buttons; Buyer pays seller's tax does not move it). County taxes keep their payer buttons and 50/50 start; Cecil / Caroline / DC reductions unchanged. First-time buyer now needs Owner-occupied principal residence ticked (warning otherwise).
- **Florida:** the First-time homebuyer box is hidden for Florida (separate commit); a ticked box is ignored there.
- **Tests:** `test.js` (VA block before the toggles section, MD FTHB block, DOM assessed value + FTHB), `test-portal.js` (saved quote header). Cache-bust 20261029a.

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
- **Cache-bust:** `?v=20261029b` on `zip-county.js`, `fee-snapshot.js`, `portal-hook.js` and the tour loader, and `CLA.TOUR_V` in `portal-ui.js` (the feedback widget keeps `20261025g`).
- **Tests:** the "calculator tour" block in `portal/test-portal.js` (link, step counts, targets, skipping, tab restore, chip persistence, phone sheet, versions). Screenshots: `portal/tools/screenshots_calculator_tour.py`.

## Who pays each transfer / recordation tax (live since 2026-10-28; calculator only, no database change)
- Each deed-based tax line (basis = sale price: MD state/county transfer and county recordation, DC, VA grantor/grantee and regional, FL deed stamps) has a Seller / Split / Buyer control in the calculator inputs (quote tab and seller net sheet). Taxes on the loan (note stamps, mortgage or DOT recordation, intangible) are not adjustable; a refinance has no control.
- **Defaults are unchanged:** every line starts with the payer in the `Transfer_Taxes` tab (MD: Split, with or without the First-time homebuyer box; DC recordation: Buyer, transfer: Seller; VA and FL as in the sheet). The old "Buyer pays seller's transfer / deed tax" box still works; a per-line choice beats it.
- **Split** = half each in whole cents (an odd cent goes to the seller), so buyer + seller always equals the tax. Lines are labelled "(split 50/50)", "(paid by buyer)" or "(paid by seller)".
- **Saved quotes:** the lines the person clicked are stored in the snapshot's `inputs.taxPayers` (`{ "County transfer tax": "split" }`), next to the lines and the copied text, which carry the labels. No migration is needed (`inputs` is free-form JSON). Choices reset when the state or county changes.
- Tests: "TS", "SN" and "DOM tax payer" checks in `test.js`; "tax payer choice (mock)" in `portal/test-portal.js`. Picture: `portal/help/client/calc-tax-payer.png`.

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

## "Invited, never signed in" badge (migration 15, applied live)
- **Problem:** a profile is `status = 'active'` from the moment of the invite, so the admin Users table showed "Active" for people who never opened their invite. `profiles.last_seen_at` cannot tell: no code writes it (it is NULL for everybody, including people who sign in daily).
- **Source of truth:** `auth.users.last_sign_in_at` (NULL until the first sign-in, which includes accepting the invite link). The browser cannot read the auth schema, so `20261026000015_admin_last_sign_in.sql` adds `public.admin_list_last_sign_ins()` (admin / super admin only, read-only, returns only `user_id` + `last_sign_in_at`). `adminListUsers()` merges it into `Profile.lastSignInAt` (ISO = signed in, `null` = never, `undefined` = unknown).
- **Badges (admin.html, Status column):** Disabled (unchanged) / **Invited, never signed in** (warn style, like "Invited, not signed up" in rep.html; tooltip with the invite date) / **Active** (tooltip: last signed in). If the migration is not applied yet the value is unknown and the page shows plain "Active" (never a wrong "Invited" label), so deploying the site before the migration is safe.
- **Apply live (when approved):** run `20261026000015_admin_last_sign_in.sql` once in the Supabase SQL editor (idempotent, no table/policy changes), then deploy. Either order is safe; migration first shows the badge immediately.
- **Edge:** someone who clicked the invite link but never finished setting a password has a sign-in time and shows "Active".

## Rep pricing tables: settlement fee only (migration 16, applied live)
Named **pricing tables** (e.g. "Marvin's Pricing") hold lower **settlement fees**, as **fee sets** that cover any selection of states (MD+VA, FL, all states...) (`Settlement Fee to CLA Title & Escrow` only; premiums and recording fees can never change); admins and super admins add a rep's or an individual client's **email** to a table on the admin page's **Rep pricing** tab. One email, one table.
Design, the one rule for whose fee a person gets (own email's table first, else the assigned rep's table, else standard), tests, and how to apply: see [`REP-PRICING.md`](REP-PRICING.md). Cache-bust `?v=20261029b`.

## In-portal Help: client guide and staff manual (local branch `help-manual`, not pushed)
Two pages, both **generated** by `node portal/tools/build-help.js` (do not edit the HTML by hand):
- `portal/help.html` = the **client guide** (realtors and lenders). Text in `portal/tools/client-content.js`; it is generic how-to-use-the-system text: nothing about staff tools, rates, fee amounts, special or standard pricing, discounts or dollar figures (and no percentages), and the test suite checks that. Dollar figures in its pictures are replaced with zeros by the screenshot script. Pictures only from `portal/help/client/`.
- `portal/staff-help.html` = the **staff manual** (Everyone, Reps and Admins sections, plus the admins-only "Needs confirming" list). Text in `portal/tools/help-content.js`; extra styles in `portal/help/staff.css`. It links to the client guide ("See what clients see"). Staff-only pictures live in `portal/help/staff/`.
- **Header Help link** (`CLA.helpHref` in `portal-ui.js`; the calculator header link in `portal-hook.js` uses the same function): clients go to `help.html`, reps, admins and super admins to `staff-help.html`. Signed-in users only.
- **Guards:** both pages use `CLA.boot(null)` (signed-out visitors go to `login.html?next=...`) and stay hidden until then. `staff-help.html` sends a client to `help.html`. **Be honest about what that is:** static pages can be fetched by anyone who knows the URL; the guard decides what a signed-in person sees on screen, it is not access control. Neither page has a key, a secret or customer data (the pictures use made-up sample people).
- **Pictures:** `python3 portal/tools/screenshots_help.py` (serves this repo on a local port with the mock config forced, hides the demo banner), then `python3 portal/tools/optimize_help_images.py`, which sorts them into `help/client/` (used by the client guide) and `help/staff/` (everything else the staff manual uses) and removes anything unused.
- Cache-bust letter: `20261029b` (see above).

/* =====================================================================
 * auth-adapter.js: the ONE seam between the screens and the back end.
 *
 * Every screen talks to `await CLA.getAdapter()` and nothing else. Two
 * implementations ship with the same method names:
 *   mock-adapter.js      local sample data in localStorage (no network, no passwords kept)
 *   supabase-adapter.js  real Supabase (Auth + Postgres RLS + Storage + Edge Functions)
 * A third (AWS: Cognito + API Gateway/Lambda + RDS Postgres + S3) would implement
 * the same contract; nothing in the HTML pages would change.
 *
 * Which one loads is decided by portal/config.js (gitignored, per environment):
 *     window.CLA_PORTAL_CONFIG = { mode: "mock" };
 *     window.CLA_PORTAL_CONFIG = { mode: "supabase", url: "https://xxxx.supabase.co", anonKey: "..." };
 * No config.js at all => mock mode on the portal pages, and NO portal UI in the calculator.
 *
 * ---------------- adapter contract (all methods async; they throw Error with a
 * ---------------- human-readable message) ----------------
 *  mode                                   "mock" | "supabase"
 *  Auth
 *   getSession()                          -> {userId, email} | null
 *   signIn(email, password)               -> {userId, email}
 *   signOut()
 *   requestPasswordReset(email, redirectTo)
 *   hasRecoverySession()                  -> boolean   (opened from an invite / reset email link)
 *   updatePassword(newPassword)
 *  Profile and photo
 *   getMyProfile()                        -> Profile
 *   updateMyProfile(patch)                -> Profile   (camelCase fields; role/status/email not editable;
 *                                                       cellPhone: any US format in, +1XXXXXXXXXX out; "" clears it; invalid throws)
 *   acceptTerms()
 *   uploadAvatar(file)                    -> Profile   (validates JPEG/PNG, 2 MB; resizes to 512 px)
 *   removeAvatar()                        -> Profile
 *   getAvatarUrl(profileLike)             -> url | null   ({id, avatarPath, firstName, lastName})
 *   getMyRep()                            -> {id, firstName, lastName, phone, cellPhone, email, avatarPath} | null
 *  Quotes
 *   saveQuote(snapshot)                   -> Quote        snapshot from window.CLA_QUOTE_API
 *   updateQuote(id, snapshot)             -> Quote
 *   listMyQuotes()                        -> Quote[]
 *   getQuote(id)                          -> Quote | null
 *   deleteQuote(id)                       (client "delete": hides it; purge removes it for real)
 *  Rep   (real reps AND admins / super admins who also work as a rep: profile.isRep; see CLA.isRep(profile))
 *   listMyClients()                       -> [{email, profile|null, pending, cellPhone|null, quoteCount, lastQuoteAt}]
 *                                            ONLY the caller's own clients, also for an admin / super admin (who can otherwise read every assignment)
 *                                            cellPhone = the client's profile cell, or (before sign-up) the cell on the invitation
 *   listQuotesForClient(clientUserId)     -> Quote[]
 *   inviteClient(email, {cellPhone}?)     (cellPhone optional: any US format; stored as +1XXXXXXXXXX; throws on an invalid number)
 *                                            always assigned to the caller, with the REP rules even for an admin+rep (never takes over another rep's client)
 *  Admin   (roles super_admin and admin may call the read/assign methods; the "super admin only" ones are marked.
 *           An ADMIN may act on reps, clients and other admins (disable, demote to rep/client, edit); the database refuses anything on a super admin and any promotion to admin / super admin, see the README "Roles")
 *   adminListUsers()                      -> Profile[]   each also carries lastSignInAt (migration 15, auth.users.last_sign_in_at): ISO time, null = invited but NEVER signed in, undefined = unknown
 *                                            (migration not applied). profiles.status 'active' only means 'not disabled'; the Users table shows 'Invited, never signed in' for null.
 *   adminListAssignments()                -> Assignment[]
 *   adminListQuotes()                     -> Quote[]
 *   adminInvite({email, role, repId, cellPhone, isRep})   role: "rep" | "client" for an admin; also "admin" | "super_admin" for a SUPER ADMIN only.
 *                                            (repId, cellPhone, isRep optional; isRep only with role "admin" / "super_admin": the new admin also works as a rep, CLA email required)
 *                                            repId may be any rep OR an admin who also works as a rep
 *   adminSetStatus(userId, "active"|"disabled")   admin: reps and clients only. super admin: anyone but themselves.
 *                                            Never leaves zero ACTIVE super admins (rejected by the database)
 *   adminSetRole(userId, role, reassignTo?)  admin: rep / client for reps, clients and other admins. super admin: any role for anyone but themselves.
 *                                            (role "rep" sets isRep, "client" clears it; admin / super_admin keep whatever they had)
 *                                            reassignTo: REQUIRED when the change leaves someone with ACTIVE clients unable to be a rep (that is: to "client");
 *                                            the user id of an active rep (or admin / super admin who also reps), not the same person. All their active clients
 *                                            move to it in the same step (history kept). Ignored when nothing needs moving.
 *   adminSetIsRep(userId, on, reassignTo?)  SUPER ADMIN ONLY. "Also works as a rep" switch for an admin or super admin target (reps always are, clients never);
 *                                            on needs an @clatitle.com email; off needs reassignTo while they still have active clients (same rule as above)
 *   adminReassign(clientEmail, repId)
 *   adminAuditLog(limit)                  -> AuditRow[]
 *  Guided tour (migration 14).  Profile.tourSeenAt: ISO time the person finished or skipped the first-time tour, null = not yet (the portal starts it once),
 *   undefined = not known (database without migration 14: never auto-start).
 *   markTourSeen()                        the CURRENT user only; the first time wins (a replay never moves the date). Throws if signed out / disabled.
 *  Staff feedback (migration 13). STAFF = admin, super_admin or rep (by role, active). Clients and guests: every call below refuses (or returns nothing).
 *   submitFeedback({category, message, page})   -> {id}      category: bug|idea|question|other; message 1-2000 chars (trimmed); page = PATH ONLY
 *                                                 (query / hash are cut off). At most 10 per hour and 40 per day per person (throws a readable message).
 *   listMyFeedback()                      -> Feedback[]  the caller's own submissions, newest first (the "Your feedback" list; shows status and John's note)
 *   adminListFeedback()                   -> Feedback[]  ADMIN or SUPER ADMIN: everything, newest first
 *   adminSetFeedbackStatus(id, status, note?)   SUPER ADMIN ONLY. status: approved|dismissed; note optional (<= 1000 chars). 'new' and 'notified' are set by the assistant, not here.
 *   Feedback = {id, createdAt, userId, roleAtSubmit, category, message, pagePath, status: new|notified|approved|dismissed, notifiedAt, decidedAt, decidedNote}
 *   The message is USER CONTENT: put it on the page with textContent / CLA.esc(), never as raw HTML.
 *  Named PRICING TABLES for the CLA settlement fee (migration 16: pricing_tables, pricing_table_fees, pricing_table_members).
 *   ONLY CLA's "Settlement Fee to CLA Title & Escrow" line; premiums / recording fees can never be stored. A table has a unique name ("Marvin's Pricing"),
 *   settlement fees, and a member list of EMAILS (lower-case, ANY domain: a rep's or an individual client's; one email in at most ONE table; may be added before the person has an account).
 *   Fee = {id, tableId, state: "*"|"MD"|"VA"|"DC"|"FL" ("*" = every state; a state row beats it), transaction: "purchase"|"refi", paidBy: "buyer"|"seller" (a refi borrower is "buyer"; no refi/seller), amount, updatedAt, updatedBy}
 *   getMyFeeOverrides()                   -> [{state, transaction, paidBy, amount}]  what the CALCULATOR applies for the current user. Precedence: 1) their OWN email is in a table (rep, admin who also reps, or client),
 *                                            2) else the table their active assigned rep is in (a rep is their own rep), 3) else []  = standard fees  (private.pricing_table_for() / pricing_rep_for() in the database)
 *   adminListPricingTables()              -> {tables: [{id, name, createdAt, updatedAt}], fees: Fee[], members: [{id, tableId, email, addedAt}]}   ADMIN or SUPER ADMIN
 *   adminCreatePricingTable(name)         -> {id}   name 1-80 chars, unique ignoring case (throws a readable message)
 *   adminRenamePricingTable(id, name)
 *   adminDeletePricingTable(id)           deletes the table's fees and member list: those people are back on standard fees (the screen asks first)
 *   adminSetPricingFee({tableId, state, transaction, paidBy, amount})   upsert; amount 0..99999.99 (0 = waived), rounded to the cent
 *   adminClearPricingFee({tableId, state, transaction, paidBy})        back to the standard fee for that line; a missing row is a quiet no-op
 *   adminAddPricingMember(tableId, email, {move}?) -> "added" | "moved" | "already"   an email already in ANOTHER table throws 'x@clatitle.com is already in pricing table "Name".'
 *                                            unless {move: true}; any valid email (rep or client), no account needed yet
 *   adminRemovePricingMember(tableId, email)   quiet no-op if the email is not in that table
 *   Every change is audited as pricing_table_changed (details.op: create | rename | delete | fee_set | fee_clear | member_add | member_move | member_remove).
 *   adminLogQuoteView(quoteId)
 *
 * Profile : {id, role, isRep, status, email, firstName, lastName, phone, cellPhone, companyName, companyPhone,
 *            companyAddress, companyWebsite, licenseOrNmls, avatarPath, termsAcceptedAt, isComplete, createdAt}
 * role    : "super_admin" | "admin" | "rep" | "client"
 * isRep   : boolean, "works as a rep": true for role "rep", false for "client", and for an "admin" or "super_admin" true only when a super admin
 *            switched it on (profiles.is_rep). Every rep feature (assignments, own-client list, co-branded quotes, rep pickers,
 *            phone required) keys off this, never off role alone. An admin / super admin keeps all admin access either way.
 * cellPhone : string|null, always E.164 US ("+12405550142") or null. Optional for everyone; `phone` (the main/office
 *            line, required for reps) is unchanged. Visible to the person, admins, and the assigned rep/client (the same
 *            rules as the rest of the profile; a client gets their rep's through getMyRep()).
 * Quote   : {id, ownerId, repId, quoteType: "buyer"|"seller_net", label, state, county, propertyAddress,
 *            price, inputs, results, feeVersion, createdAt, expiresAt}
 * ===================================================================== */
(function () {
  const CLA = (window.CLA = window.CLA || {});

  // ---- cell phone rules (US only, stored as E.164 +1XXXXXXXXXX). The database trigger + CHECK enforce the same. ----
  CLA.PHONE_MSG = "Enter a valid 10-digit US cell number, like (240) 555-0142.";
  // "" for blank input, "+1XXXXXXXXXX" for a valid US number, null when invalid.
  CLA.normalizePhone = function (v) {
    const t = String(v == null ? "" : v).trim();
    if (!t) return "";
    if (!/^[0-9()+.\s-]+$/.test(t)) return null;               // digits and common separators only
    let d = t.replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? "+1" + d : null;
  };
  // Live formatting while typing: "2405550142" -> "(240) 555-0142". A leading 1 / +1 is dropped.
  CLA.formatPhoneInput = function (v) {
    let d = String(v == null ? "" : v).replace(/\D/g, "");
    if (d[0] === "1") d = d.slice(1);
    d = d.slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return "(" + d.slice(0, 3) + ") " + d.slice(3);
    return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  };
  // Display form of a stored number; anything that is not E.164 US (legacy free text) is shown as is.
  CLA.displayPhone = function (v) { return /^\+1\d{10}$/.test(v || "") ? CLA.formatPhoneInput(v) : v || ""; };
  CLA.telHref = function (v) { const n = CLA.normalizePhone(v); return n ? "tel:" + n : null; };

  // ---- photo rules (JPEG/PNG only, 2 MB). The database and the storage bucket enforce the same. ----
  CLA.PHOTO = { maxBytes: 2 * 1024 * 1024, types: ["image/jpeg", "image/png"], size: 512 };

  // Sniff the first bytes so a renamed file (e.g. .exe -> .jpg) is refused, not just the extension.
  async function sniff(file) {
    const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    return null;
  }

  // Returns "" when OK, otherwise a message for the user.
  CLA.validatePhoto = async function (file) {
    if (!file) return "Choose a photo first.";
    if (!CLA.PHOTO.types.includes(file.type)) return "Photos must be JPEG or PNG. (iPhone HEIC photos: export as JPEG first.)";
    if (file.size > CLA.PHOTO.maxBytes) return "That photo is " + (file.size / 1048576).toFixed(2) + " MB. The limit is 2 MB.";
    if (file.size < 100) return "That file looks empty.";
    const real = await sniff(file);
    if (real !== file.type) return "That file is not really a " + (file.type === "image/png" ? "PNG" : "JPEG") + " image.";
    return "";
  };

  // Center-crop to a 512 px square and re-encode in the same format. Re-encoding drops EXIF
  // (GPS location etc.). Falls back to the original file if the browser cannot decode it.
  CLA.prepareAvatar = async function (file) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(img.naturalWidth, img.naturalHeight), out = Math.min(CLA.PHOTO.size, s);
      const c = document.createElement("canvas"); c.width = c.height = out;
      c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, out, out);
      URL.revokeObjectURL(url);
      const blob = await new Promise((res) => c.toBlob(res, file.type, 0.9));
      return blob && blob.size <= CLA.PHOTO.maxBytes ? blob : file;
    } catch (e) { return file; }
  };

  CLA.config = function () { return window.CLA_PORTAL_CONFIG || { mode: "mock" }; };
  CLA.hasConfig = function () { return !!window.CLA_PORTAL_CONFIG; };

  // Supabase JS from CDN, pinned. (jsDelivr serves this file on the fly, so it advises against SRI hashes.
  // To remove the CDN dependency entirely, copy the file into portal/vendor/ and change SUPABASE_JS.)
  CLA.SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.min.js";
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  let pending = null;
  CLA.getAdapter = function () {
    if (pending) return pending;
    pending = (async () => {
      const cfg = CLA.config();
      if (cfg.mode === "supabase") {
        if (!cfg.url || !cfg.anonKey || /YOUR-|xxxx/i.test(cfg.url + cfg.anonKey)) throw new Error("portal/config.js still has placeholder Supabase values.");
        if (!window.supabase) await loadScript(CLA.SUPABASE_JS);
        return CLA.createSupabaseAdapter(cfg, window.supabase);
      }
      return CLA.createMockAdapter(cfg);
    })();
    return pending;
  };
})();

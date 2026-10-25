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
 *  Rep
 *   listMyClients()                       -> [{email, profile|null, pending, cellPhone|null, quoteCount, lastQuoteAt}]
 *                                            cellPhone = the client's profile cell, or (before sign-up) the cell on the invitation
 *   listQuotesForClient(clientUserId)     -> Quote[]
 *   inviteClient(email, {cellPhone}?)     (cellPhone optional: any US format; stored as +1XXXXXXXXXX; throws on an invalid number)
 *  Admin
 *   adminListUsers()                      -> Profile[]
 *   adminListAssignments()                -> Assignment[]
 *   adminListQuotes()                     -> Quote[]
 *   adminInvite({email, role, repId, cellPhone})   (repId, cellPhone optional)
 *   adminSetStatus(userId, "active"|"disabled")
 *   adminSetRole(userId, role)
 *   adminReassign(clientEmail, repId)
 *   adminAuditLog(limit)                  -> AuditRow[]
 *   adminLogQuoteView(quoteId)
 *
 * Profile : {id, role, status, email, firstName, lastName, phone, cellPhone, companyName, companyPhone,
 *            companyAddress, companyWebsite, licenseOrNmls, avatarPath, termsAcceptedAt, isComplete, createdAt}
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

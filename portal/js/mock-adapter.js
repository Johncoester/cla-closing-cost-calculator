/* Mock implementation of the adapter contract (see auth-adapter.js). Local sample data in
 * localStorage; no network. It mirrors the database access rules so the screens behave like the real thing:
 * reps see only their assigned clients, clients see only themselves and their rep, quotes expire after 30 days.
 *
 * PASSWORDS: the mock never stores or checks one. Any non-empty password signs in a sample account.
 * Only the signed-in user id is kept (localStorage "cla_portal_mock_session"). */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  const KEY = "cla_portal_mock_v1", SKEY = "cla_portal_mock_session", DAY = 86400000;

  CLA.createMockAdapter = function () {
    const load = () => {
      try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.version === 3) return s; } catch (e) {}
      const s = CLA.MOCK_SEED(); localStorage.setItem(KEY, JSON.stringify(s)); return s;
    };
    const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
    const uid = () => ((crypto.randomUUID && crypto.randomUUID()) || "m" + Date.now() + Math.random().toString(16).slice(2));
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const err = (m) => { throw new Error(m); };
    const lc = (e) => String(e || "").trim().toLowerCase();
    const live = (q) => new Date(q.expiresAt).getTime() > Date.now();       // RLS: expired rows invisible at once
    const isAdminRole = (u) => !!u && (u.role === "super_admin" || u.role === "admin");   // private.is_admin(): may use the admin dashboard
    const isSuper = (u) => !!u && u.role === "super_admin";                                // private.is_super_admin()
    const isRep = (u) => !!u && (u.role === "rep" || (isAdminRole(u) && !!u.isRep));      // same rule as private.is_rep() / profiles.is_rep
    // the same checks the RPCs make (migration 10): an admin may only act on reps and clients; a super admin on anyone
    const needAdmin = (s) => { const u = need(s); if (!isAdminRole(u)) err("Admins only."); return u; };
    const needSuper = (s) => { const u = needAdmin(s); if (!isSuper(u)) err("Only a super admin can do that."); return u; };
    const lastSuper = (s, t) => t.role === "super_admin" && t.status === "active" && !s.users.some((x) => x.id !== t.id && x.role === "super_admin" && x.status === "active");
    const LAST = "There must always be at least one active super admin."; 
    const complete = (p) => !!(p.firstName && p.lastName && (!isRep(p) || p.phone));

    function me(s) {
      const id = localStorage.getItem(SKEY); const p = id && s.users.find((u) => u.id === id);
      return p && p.status === "active" ? p : null;
    }
    function need(s) { return me(s) || err("Please sign in."); }
    const log = (s, actor, action, targetType, targetId, details) =>
      s.audit.unshift({ id: uid(), at: new Date().toISOString(), actorId: actor, action, targetType, targetId, details: details || {} });
    const repOf = (s, clientId) => { const a = s.assignments.find((x) => x.active && x.clientUserId === clientId); const r = a && s.users.find((u) => u.id === a.repId && u.status === "active" && isRep(u)); return r || null; };
    const myClientIds = (s, repId) => s.assignments.filter((a) => a.active && a.repId === repId && a.clientUserId).map((a) => a.clientUserId);
    const dto = (p) => { const o = clone(p); o.cellPhone = o.cellPhone || null; o.isRep = isRep(p); o.isComplete = complete(p); return o; };
    // same rule as the database trigger: blank -> null, valid US -> +1XXXXXXXXXX, anything else -> error
    const cellOrNull = (v) => { const n = CLA.normalizePhone(v); if (n === null) err(CLA.PHONE_MSG); return n || null; };

    // quotes visible to `u` (same rules as the quotes RLS policies)
    function visibleQuotes(s, u) {
      const mine = myClientIds(s, u.id);
      return s.quotes.filter((q) => live(q) && (
        isAdminRole(u) ? true :
        (q.ownerId === u.id && !q.deletedAt) || (isRep(u) && mine.includes(q.ownerId) && !q.deletedAt)));   // an admin sees everything; a rep (or admin acting as a rep) their clients
    }
    const qdto = (q) => { const o = clone(q); delete o.deletedAt; return o; };
    function snapToQuote(s, u, snap, base) {
      const q = Object.assign(base || {}, {
        quoteType: snap.quoteType, label: snap.label || null, state: snap.state || null, county: snap.county || null,
        propertyAddress: snap.propertyAddress || null, price: snap.price == null ? null : +snap.price,
        inputs: clone(snap.inputs || {}), results: clone(snap.results || {}), feeVersion: snap.feeVersion || null });
      if (!base) {
        const now = Date.now(); const rep = isRep(u) ? u : repOf(s, u.id);
        Object.assign(q, { id: uid(), ownerId: u.id, repId: rep ? rep.id : null, createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 30 * DAY).toISOString(), deletedAt: null });
      }
      return q;
    }

    const A = {
      mode: "mock",
      async getSession() { const u = me(load()); return u ? { userId: u.id, email: u.email } : null; },
      async signIn(email, password) {
        const s = load(); const u = s.users.find((x) => x.email === lc(email));
        if (!password) err("Enter your password.");
        if (!u || u.status !== "active") err("Invalid email or password.");   // same message for unknown and disabled
        localStorage.setItem(SKEY, u.id); return { userId: u.id, email: u.email };
      },
      async signOut() { localStorage.removeItem(SKEY); },
      async requestPasswordReset(email) { /* always "succeeds" so the screen never reveals which emails exist */ return true; },
      async hasRecoverySession() { return true; },
      async updatePassword(pw) { if (!pw || pw.length < 12) err("Password is too short."); return true; },   // nothing is stored

      async getMyProfile() { const s = load(); return dto(need(s)); },
      async updateMyProfile(patch) {
        const s = load(), u = need(s);
        for (const k of ["firstName", "lastName", "phone", "companyName", "companyPhone", "companyAddress", "companyWebsite", "licenseOrNmls"]) {
          if (k in patch) u[k] = patch[k] == null || patch[k] === "" ? (k === "firstName" || k === "lastName" ? "" : null) : String(patch[k]).slice(0, 300);
        }
        if ("cellPhone" in patch) u.cellPhone = cellOrNull(patch.cellPhone);   // owner edits own cell only (u = signed-in user)
        save(s); return dto(u);
      },
      async acceptTerms() { const s = load(), u = need(s); u.termsAcceptedAt = new Date().toISOString(); save(s); },
      async uploadAvatar(file) {
        const bad = await CLA.validatePhoto(file); if (bad) err(bad);
        const blob = await CLA.prepareAvatar(file);
        const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
        const s = load(), u = need(s); s.photos[u.id] = url; u.avatarPath = u.id + "/avatar";
        log(s, u.id, "photo_changed", "photo", null, { mime_type: file.type, size_bytes: blob.size }); save(s); return dto(u);
      },
      async removeAvatar() { const s = load(), u = need(s); delete s.photos[u.id]; u.avatarPath = null; log(s, u.id, "photo_removed", "photo", null, {}); save(s); return dto(u); },
      async getAvatarUrl(p) {
        if (!p || !p.avatarPath) return null; const s = load(), u = me(s);
        if (!u) return null;
        const ok = u.id === p.id || isAdminRole(u) || (repOf(s, p.id) || {}).id === u.id || (repOf(s, u.id) || {}).id === p.id;
        return ok ? s.photos[p.id] || null : null;
      },
      async getMyRep() {
        const s = load(), u = need(s), r = repOf(s, u.id); if (!r) return null;
        return { id: r.id, firstName: r.firstName, lastName: r.lastName, phone: r.phone, cellPhone: r.cellPhone || null, email: r.email, avatarPath: r.avatarPath };
      },

      async saveQuote(snap) { const s = load(), u = need(s); const q = snapToQuote(s, u, snap); s.quotes.unshift(q); save(s); return qdto(q); },
      async updateQuote(id, snap) {
        const s = load(), u = need(s); const q = s.quotes.find((x) => x.id === id && x.ownerId === u.id && !x.deletedAt && live(x));
        if (!q) err("That quote is no longer available."); snapToQuote(s, u, snap, q); save(s); return qdto(q);   // expiry is NOT extended
      },
      async listMyQuotes() { const s = load(), u = need(s); return visibleQuotes(s, u).filter((q) => q.ownerId === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(qdto); },
      async getQuote(id) { const s = load(), u = need(s); const q = visibleQuotes(s, u).find((x) => x.id === id); return q ? qdto(q) : null; },
      async deleteQuote(id) {
        const s = load(), u = need(s); const q = s.quotes.find((x) => x.id === id && x.ownerId === u.id && !x.deletedAt && live(x));
        if (!q) err("No such quote."); q.deletedAt = new Date().toISOString(); log(s, u.id, "quote_deleted", "quote", id, { owner_id: u.id }); save(s);
      },

      async listMyClients() {
        const s = load(), u = need(s); if (!isRep(u)) err("Reps only.");
        return s.assignments.filter((a) => a.active && a.repId === u.id).map((a) => {
          const p = a.clientUserId && s.users.find((x) => x.id === a.clientUserId);
          const qs = p ? visibleQuotes(s, u).filter((q) => q.ownerId === p.id) : [];
          const inv = !p && s.invitations.find((i) => i.email === a.clientEmail);   // RLS: a rep reads pending invitations of clients assigned to them
          return { email: a.clientEmail, profile: p ? dto(p) : null, pending: !p, cellPhone: p ? p.cellPhone || null : (inv && inv.cellPhone) || null, quoteCount: qs.length,
            lastQuoteAt: qs.length ? qs.map((q) => q.createdAt).sort().pop() : null };
        });
      },
      async listQuotesForClient(clientId) { const s = load(), u = need(s); return visibleQuotes(s, u).filter((q) => q.ownerId === clientId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(qdto); },
      async inviteClient(email, opts) {
        const s = load(), u = need(s); if (!isRep(u)) err("Reps only.");
        return invite(s, u, { email, role: "client", repId: u.id, cellPhone: opts && opts.cellPhone }, true);   // asRep: rep rules even for an admin+rep (never takes over another rep's client)
      },

      async adminListUsers() { const s = load(); needAdmin(s); return s.users.map(dto); },
      async adminListAssignments() { const s = load(); needAdmin(s); return clone(s.assignments); },
      async adminListQuotes() { const s = load(), u = needAdmin(s); return visibleQuotes(s, u).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((q) => Object.assign(qdto(q), { deleted: !!q.deletedAt })); },
      async adminInvite(o) { const s = load(), u = needAdmin(s); return invite(s, u, o); },
      async adminSetIsRep(id, on) {
        const s = load(), u = needSuper(s);   // super admin only, for admins and super admins (an admin cannot switch anyone, not even themselves)
        const t = s.users.find((x) => x.id === id) || err("No such user.");
        if (!isAdminRole(t)) err("Only an admin or super admin can be switched: reps are always reps and clients never are.");
        if (on && !t.email.endsWith("@clatitle.com")) err("Reps must use an @clatitle.com email.");
        if (!!t.isRep === !!on) return;
        const n = s.assignments.filter((a) => a.repId === id && a.active).length;
        if (!on && n) err("Reassign this person's " + n + " active client(s) before switching rep access off.");
        t.isRep = !!on; log(s, u.id, "rep_flag_changed", "profile", id, { before: !on, after: !!on }); save(s);
      },
      async adminSetStatus(id, status) {
        const s = load(), u = needAdmin(s); if (id === u.id) err("You cannot disable yourself.");
        const t = s.users.find((x) => x.id === id) || err("No such user.");
        if (!isSuper(u) && !(t.role === "rep" || t.role === "client")) err("Only a super admin can disable or re-enable an admin or super admin.");
        if (status === "disabled" && lastSuper(s, t)) err(LAST);
        const before = t.status; t.status = status;
        log(s, u.id, status === "disabled" ? "user_disabled" : "user_enabled", "profile", id, { before, after: status }); save(s);
      },
      async adminSetRole(id, role) {
        const s = load(), u = needAdmin(s); if (id === u.id) err("You cannot change your own role.");
        const t = s.users.find((x) => x.id === id) || err("No such user.");
        if (!isSuper(u)) {
          if (!(t.role === "rep" || t.role === "client")) err("Only a super admin can change the role of an admin or super admin.");
          if (!(role === "rep" || role === "client")) err("Only a super admin can make someone an admin or super admin.");
        }
        if (role !== "super_admin" && lastSuper(s, t)) err(LAST);
        if (role === "rep" && !t.email.endsWith("@clatitle.com")) err("Reps must use an @clatitle.com email.");
        const before = t.role; t.role = role; if (role === "rep") t.isRep = true; else if (role === "client") t.isRep = false;   // same as the database trigger
        log(s, u.id, "role_changed", "profile", id, { before, after: role }); save(s);
      },
      async adminReassign(email, repId) {
        const s = load(), u = needAdmin(s); const e = lc(email);
        const rep = s.users.find((x) => x.id === repId && isRep(x)) || err("Pick a rep.");
        s.assignments.filter((a) => a.clientEmail === e && a.active).forEach((a) => (a.active = false));
        const p = s.users.find((x) => x.email === e);
        s.assignments.push({ id: uid(), clientEmail: e, clientUserId: p ? p.id : null, repId: rep.id, active: true, createdAt: new Date().toISOString() });
        log(s, u.id, "assignment_changed", "assignment", null, { client_email: e, rep_id: rep.id }); save(s);
      },
      async adminAuditLog(limit) { const s = load(); needAdmin(s); return clone(s.audit.slice(0, limit || 100)); },
      async adminLogQuoteView(id) { const s = load(), u = need(s); if (!isAdminRole(u)) return; log(s, u.id, "quote_viewed_by_admin", "quote", id, {}); save(s); },

      // test/demo helper (mock only): put the sample data back
      async _reset() { localStorage.removeItem(KEY); localStorage.removeItem(SKEY); },
    };

    function invite(s, actor, o, asRep) {
      const e = lc(o.email), role = o.role, adminRules = isAdminRole(actor) && !asRep, adminRole = role === "super_admin" || role === "admin";
      if (adminRules && adminRole && !isSuper(actor)) err("Only a super admin can invite an admin or super admin.");
      const flagged = role === "rep" || (adminRole && !!o.isRep);
      if (o.isRep && (!adminRules || !adminRole)) err("Only a super admin can invite an admin or super admin who also works as a rep.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) err("Enter a valid email address.");
      if (flagged && !e.endsWith("@clatitle.com")) err("Reps must use an @clatitle.com email.");
      if (s.users.some((x) => x.email === e)) err("That email already has an account.");
      const cell = cellOrNull(o.cellPhone);
      const existing = s.assignments.find((a) => a.clientEmail === e && a.active);
      if (role === "client" && existing && !adminRules && existing.repId !== actor.id) err("That client already belongs to another rep.");
      s.invitations = s.invitations.filter((i) => i.email !== e);
      s.invitations.push({ email: e, role, isRep: flagged, invitedBy: actor.id, cellPhone: cell, createdAt: new Date().toISOString() });
      if (role === "client" && o.repId) {
        if (!s.users.some((x) => x.id === o.repId && isRep(x))) err("Pick a rep.");
        s.assignments.filter((a) => a.clientEmail === e && a.active && a.repId !== o.repId).forEach((a) => (a.active = false));
        if (!s.assignments.some((a) => a.clientEmail === e && a.active))
          s.assignments.push({ id: uid(), clientEmail: e, clientUserId: null, repId: o.repId, active: true, createdAt: new Date().toISOString() });
      }
      log(s, actor.id, "invite_sent", "invitation", null, { email: e, role, rep_id: o.repId || null, is_rep: flagged }); save(s);
      return { ok: true, mockNote: "Demo mode: no email is sent." };
    }
    return A;
  };
})();

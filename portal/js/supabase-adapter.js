/* Supabase implementation of the adapter contract (see auth-adapter.js).
 * Written against the documented supabase-js v2 API; NOT yet run against a live project (none exists yet).
 * Only the project URL and the public "anon" key go in portal/config.js. The service-role key never
 * appears in the browser: invites and disabling users go through the Edge Functions in supabase/functions/.
 * Every read here relies on Row Level Security (supabase/migrations/*_rls_and_rpc.sql); this file does
 * no access checking of its own. */
(function () {
  const CLA = (window.CLA = window.CLA || {});

  CLA.createSupabaseAdapter = function (cfg, supabaseLib) {
    const sb = supabaseLib.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
    });
    const must = ({ data, error }) => { if (error) throw new Error(friendly(error)); return data; };
    // the database's own refusals (migrations 6 and 10) are written for people: show them, capitalized
    const ownRefusal = (m) => /^(only a super admin|only an admin|you cannot|there must always|reps can only|this person has|reassign this person|choose a different rep|the rep who takes over|you have sent a lot|category must|message is|status must|note is too)/i.test(m) ? m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? "" : ".") : null;
    function friendly(e) {
      const m = e.message || String(e);
      if (/Invalid login credentials/i.test(m)) return "Invalid email or password.";
      if (/Email not confirmed/i.test(m)) return "Check your email for the invitation link first.";
      if (/rate limit|too many/i.test(m)) return "Too many attempts. Wait a minute and try again.";
      const own = ownRefusal(m); if (own) return own;
      if (e.code === "42501" || /row-level security|permission denied/i.test(m)) return "You do not have access to that.";
      return m;
    }
    const iso = (x) => x || null;

    // ---- row <-> DTO mappers ----
    const FB_COLS = "id, created_at, user_id, role_at_submit, category, message, page_path, status, notified_at, decided_at, decided_note";
    const toFeedback = (r) => ({ id: r.id, createdAt: r.created_at, userId: r.user_id, roleAtSubmit: r.role_at_submit, category: r.category, message: r.message, pagePath: r.page_path, status: r.status, notifiedAt: r.notified_at, decidedAt: r.decided_at, decidedNote: r.decided_note });
    const toProfile = (r) => r && ({
      id: r.id, role: r.role, status: r.status, email: r.email, firstName: r.first_name || "", lastName: r.last_name || "",
      phone: r.phone, cellPhone: r.cell_phone || null, companyName: r.company_name, companyPhone: r.company_phone, companyAddress: r.company_address,
      companyWebsite: r.company_website, licenseOrNmls: r.license_or_nmls_number, avatarPath: r.avatar_path,
      isRep: r.role === "rep" || ((r.role === "super_admin" || r.role === "admin") && !!r.is_rep),   // "works as a rep": real reps, or an admin / super admin with profiles.is_rep
      termsAcceptedAt: iso(r.terms_accepted_at), isComplete: !!r.is_complete, createdAt: r.created_at,
      tourSeenAt: r.tour_seen_at === undefined ? undefined : r.tour_seen_at });   // undefined = the column is not there yet (migration 14 not applied): the tour never auto-starts
    const toQuote = (r) => r && ({
      id: r.id, ownerId: r.owner_id, repId: r.rep_id, quoteType: r.quote_type, label: r.label, state: r.state, county: r.county,
      propertyAddress: r.property_address, price: r.price == null ? null : +r.price, inputs: r.inputs, results: r.results,
      feeVersion: r.fee_version, createdAt: r.created_at, expiresAt: r.expires_at, deleted: !!r.deleted_at });
    const toFeeOverride = (r) => ({ id: r.id, repId: r.rep_id, state: r.state, transaction: r.transaction, paidBy: r.paid_by, amount: Number(r.amount), updatedAt: r.updated_at, updatedBy: r.updated_by });
    const toAssignment = (r) => ({ id: r.id, clientEmail: r.client_email, clientUserId: r.client_user_id, repId: r.rep_id, active: r.active, createdAt: r.created_at });
    const snapToRow = (s) => ({
      quote_type: s.quoteType, label: s.label || null, state: s.state || null, county: s.county || null,
      property_address: s.propertyAddress || null, price: s.price == null ? null : +s.price,
      inputs: s.inputs || {}, results: s.results || {}, fee_version: s.feeVersion || null });

    async function uid() {
      const { data } = await sb.auth.getSession();
      if (!data.session) throw new Error("Please sign in.");
      return data.session.user.id;
    }
    // Edge Function errors carry the JSON body in error.context
    async function fn(name, body) {
      const { data, error } = await sb.functions.invoke(name, { body });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(ownRefusal(msg) || msg);
      }
      if (data && data.error) throw new Error(ownRefusal(data.error) || data.error);
      return data;
    }
    // optional cell on an invitation: friendly message here, normalized (and re-validated) by the database
    async function invitedCell(v) { const n = CLA.normalizePhone(v); if (n === null) throw new Error(CLA.PHONE_MSG); return n || null; }
    const redirectBase = () => new URL("set-password.html", location.href.replace(/[?#].*$/, "")).href;

    // signed photo URLs are cached for 50 minutes of their 60
    const urlCache = new Map();
    const PROFILE_COLS = "*";

    return {
      mode: "supabase",
      async getSession() {
        const { data } = await sb.auth.getSession();
        return data.session ? { userId: data.session.user.id, email: data.session.user.email } : null;
      },
      async signIn(email, password) {
        const d = must(await sb.auth.signInWithPassword({ email: String(email).trim(), password }));
        return { userId: d.user.id, email: d.user.email };
      },
      async signOut() { urlCache.clear(); await sb.auth.signOut(); },
      async requestPasswordReset(email, redirectTo) {
        // Supabase answers the same whether or not the email exists.
        must(await sb.auth.resetPasswordForEmail(String(email).trim(), { redirectTo: redirectTo || redirectBase() }));
        return true;
      },
      async hasRecoverySession() { const { data } = await sb.auth.getSession(); return !!data.session; },
      async updatePassword(pw) { must(await sb.auth.updateUser({ password: pw })); return true; },

      async getMyProfile() {
        const id = await uid();
        const r = must(await sb.from("profiles").select(PROFILE_COLS).eq("id", id).maybeSingle());
        if (!r) throw new Error("Your account is disabled or not set up. Contact CLA.");
        return toProfile(r);
      },
      async updateMyProfile(p) {
        const id = await uid(), m = { firstName: "first_name", lastName: "last_name", phone: "phone", cellPhone: "cell_phone", companyName: "company_name",
          companyPhone: "company_phone", companyAddress: "company_address", companyWebsite: "company_website", licenseOrNmls: "license_or_nmls_number" };
        const row = {}; for (const k in m) if (k in p) row[m[k]] = p[k] === "" ? (k === "firstName" || k === "lastName" ? "" : null) : p[k];
        if ("cellPhone" in p) {   // check here for a friendly message; the database trigger + CHECK enforce it again and store +1XXXXXXXXXX
          const n = CLA.normalizePhone(p.cellPhone); if (n === null) throw new Error(CLA.PHONE_MSG);
          row.cell_phone = n || null;
        }
        const r = must(await sb.from("profiles").update(row).eq("id", id).select(PROFILE_COLS).single());
        return toProfile(r);
      },
      async acceptTerms() { const id = await uid(); must(await sb.from("profiles").update({ terms_accepted_at: new Date().toISOString() }).eq("id", id)); },
      async uploadAvatar(file) {
        const bad = await CLA.validatePhoto(file); if (bad) throw new Error(bad);
        const id = await uid(), path = id + "/avatar", blob = await CLA.prepareAvatar(file);
        must(await sb.storage.from("avatars").upload(path, blob, { upsert: true, contentType: file.type, cacheControl: "3600" }));
        const have = must(await sb.from("photos").select("id").eq("owner_id", id).maybeSingle());
        const meta = { storage_path: path, mime_type: file.type, size_bytes: blob.size };
        if (have) must(await sb.from("photos").update(meta).eq("owner_id", id));
        else must(await sb.from("photos").insert(Object.assign({ owner_id: id }, meta)));
        urlCache.delete(id);
        return this.getMyProfile();
      },
      async removeAvatar() {
        const id = await uid();
        await sb.storage.from("avatars").remove([id + "/avatar"]);
        must(await sb.from("photos").delete().eq("owner_id", id));
        urlCache.delete(id);
        return this.getMyProfile();
      },
      async getAvatarUrl(p) {
        if (!p || !p.avatarPath) return null;
        const hit = urlCache.get(p.id); if (hit && hit.exp > Date.now()) return hit.url;
        const { data, error } = await sb.storage.from("avatars").createSignedUrl(p.avatarPath, 3600);
        if (error || !data) return null;
        urlCache.set(p.id, { url: data.signedUrl, exp: Date.now() + 50 * 60000 });
        return data.signedUrl;
      },
      async getMyRep() {
        const rows = must(await sb.rpc("get_my_rep_contact"));   // get_my_rep() (no cell) still exists; this one adds cell_phone
        const r = Array.isArray(rows) ? rows[0] : rows; if (!r) return null;
        return { id: r.id, firstName: r.first_name, lastName: r.last_name, phone: r.phone, cellPhone: r.cell_phone || null, email: r.email, avatarPath: r.avatar_path };
      },

      async saveQuote(snap) {
        const id = await uid();
        return toQuote(must(await sb.from("quotes").insert(Object.assign({ owner_id: id }, snapToRow(snap))).select().single()));
      },
      async updateQuote(qid, snap) {
        const row = snapToRow(snap);                       // expires_at is not updatable: no expiry extension
        return toQuote(must(await sb.from("quotes").update(row).eq("id", qid).select().single()));
      },
      async listMyQuotes() {
        const id = await uid();
        return must(await sb.from("quotes").select("*").eq("owner_id", id).order("created_at", { ascending: false })).map(toQuote);
      },
      async getQuote(qid) { return toQuote(must(await sb.from("quotes").select("*").eq("id", qid).maybeSingle())); },
      async deleteQuote(qid) { must(await sb.rpc("delete_my_quote", { p_quote: qid })); },

      async listMyClients() {
        const me = await uid();
        // RLS already limits a rep to their own rows; the explicit rep_id filter matters for a super admin who also works as a rep,
        // because admins can read EVERY assignment and this screen must show only their own clients.
        const asg = must(await sb.from("assignments").select("*").eq("active", true).eq("rep_id", me)).map(toAssignment);
        const ids = asg.map((a) => a.clientUserId).filter(Boolean);
        const profs = ids.length ? must(await sb.from("profiles").select("*").in("id", ids)).map(toProfile) : [];
        const qs = ids.length ? must(await sb.from("quotes").select("id, owner_id, created_at").in("owner_id", ids)) : [];
        // clients who have not signed up yet: the cell number lives on the pending invitation (RLS lets the assigned rep read it)
        const waiting = asg.filter((a) => !a.clientUserId).map((a) => a.clientEmail);
        const invs = waiting.length ? must(await sb.from("invitations").select("email, cell_phone").in("email", waiting).is("accepted_at", null)) : [];
        return asg.map((a) => {
          const p = profs.find((x) => x.id === a.clientUserId) || null, mine = qs.filter((q) => q.owner_id === a.clientUserId);
          const inv = !p && invs.find((i) => i.email === a.clientEmail);
          return { email: a.clientEmail, profile: p, pending: !p, cellPhone: p ? p.cellPhone : (inv && inv.cell_phone) || null, quoteCount: mine.length,
            lastQuoteAt: mine.length ? mine.map((q) => q.created_at).sort().pop() : null };
        });
      },
      async listQuotesForClient(cid) {
        return must(await sb.from("quotes").select("*").eq("owner_id", cid).order("created_at", { ascending: false })).map(toQuote);
      },
      async inviteClient(email, opts) {
        // asRep: the database applies the REP rules (assigned to the caller, never takes over another rep's client) even when the caller is a super admin
        return fn("invite-user", { email, role: "client", repId: await uid(), asRep: true, cellPhone: await invitedCell(opts && opts.cellPhone), redirectTo: redirectBase() + "?invite=1" });
      },

      async adminListUsers() {
        const rows = must(await sb.from("profiles").select("*").order("created_at")).map(toProfile);
        // lastSignInAt (migration 15): ISO time of the person's first/last sign-in, null = has NEVER signed in (invited only), undefined = unknown
        // (migration 15 not applied yet, or the call failed) so the page never guesses. profiles.last_seen_at is NOT used: nothing writes it.
        let r = { error: true }; try { r = await sb.rpc("admin_list_last_sign_ins"); } catch (e) { /* unknown stays unknown */ }
        if (!r.error && Array.isArray(r.data)) { const m = {}; r.data.forEach((x) => { m[x.user_id] = x.last_sign_in_at ? iso(x.last_sign_in_at) : null; }); rows.forEach((u) => { if (u.id in m) u.lastSignInAt = m[u.id]; }); }
        return rows;
      },
      async adminListAssignments() { return must(await sb.from("assignments").select("*").order("created_at", { ascending: false })).map(toAssignment); },
      async adminListQuotes() { return must(await sb.from("quotes").select("*").order("created_at", { ascending: false })).map(toQuote); },
      async adminInvite(o) { return fn("invite-user", { email: o.email, role: o.role, repId: o.repId || null, isRep: (o.role === "super_admin" || o.role === "admin") && !!o.isRep, cellPhone: await invitedCell(o.cellPhone), redirectTo: redirectBase() + "?invite=1" }); },
      async adminSetStatus(id, status) { return fn("set-user-status", { userId: id, status }); },
      // reassignTo: when the change stops someone who has active clients from being a rep, the rep who takes those clients over (migration 12)
      async adminSetRole(id, role, reassignTo) { must(await sb.rpc("admin_set_role", Object.assign({ p_user: id, p_role: role }, reassignTo ? { p_reassign_to: reassignTo } : {}))); },
      // ---- staff feedback (migration 13): writes only through the RPCs; reads through RLS (own rows; admin and super admin all) ----
      // ---- guided tour (migration 14): the only write is the RPC (the API cannot update tour_seen_at directly) ----
      async markTourSeen() { must(await sb.rpc("mark_tour_seen")); },
      async submitFeedback(o) { const id = must(await sb.rpc("submit_feedback", { p_category: o.category, p_message: o.message, p_page: o.page || null })); return { id }; },
      async listMyFeedback() { const me = await this.getMyProfile(); return must(await sb.from("feedback").select(FB_COLS).eq("user_id", me.id).order("created_at", { ascending: false }).limit(20)).map(toFeedback); },
      async adminListFeedback() { return must(await sb.from("feedback").select(FB_COLS).order("created_at", { ascending: false }).limit(500)).map(toFeedback); },
      async adminSetFeedbackStatus(id, status, note) { must(await sb.rpc("admin_set_feedback_status", { p_id: id, p_status: status, p_note: note || null })); },   // super admin only
      async adminSetIsRep(id, on, reassignTo) { must(await sb.rpc("admin_set_is_rep", Object.assign({ p_user: id, p_is_rep: !!on }, reassignTo ? { p_reassign_to: reassignTo } : {}))); },   // super admins only; targets: admin or super admin ("Also works as a rep")
      async adminReassign(email, repId) { must(await sb.rpc("admin_reassign_client", { p_client_email: email, p_rep_id: repId })); },
      // ---- rep special SETTLEMENT fee (migration 16): reads through RLS / the RPC, writes only through the two admin RPCs ----
      async getMyFeeOverrides() { return (must(await sb.rpc("get_my_fee_overrides")) || []).map(toFeeOverride); },   // what the calculator applies for the current user (a rep: own; a client: their rep's)
      async adminListRepFeeOverrides() { return must(await sb.from("rep_fee_overrides").select("*").order("created_at")).map(toFeeOverride); },
      async adminSetRepFeeOverride(o) { must(await sb.rpc("admin_set_rep_fee_override", { p_rep: o.repId, p_state: o.state || "*", p_transaction: o.transaction, p_paid_by: o.paidBy, p_amount: o.amount })); },
      async adminClearRepFeeOverride(o) { must(await sb.rpc("admin_clear_rep_fee_override", { p_rep: o.repId, p_state: o.state || "*", p_transaction: o.transaction, p_paid_by: o.paidBy })); },
      async adminAuditLog(limit) {
        return must(await sb.from("audit_log").select("*").order("at", { ascending: false }).limit(limit || 100))
          .map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, action: r.action, targetType: r.target_type, targetId: r.target_id, details: r.details }));
      },
      async adminLogQuoteView(qid) { must(await sb.rpc("admin_log_quote_view", { p_quote: qid })); },
    };
  };
})();

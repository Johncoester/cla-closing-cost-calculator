/* Calculator <-> portal hook. Loaded (deferred) by index.html.
 *
 * With no portal/config.js this file does nothing at all, so the public calculator behaves exactly as before
 * (guest quoting stays untouched). With a config it adds, without touching the calculator logic:
 *   - a "Log in" / "My account" link in the header
 *   - for signed-in users: quotes AUTO-SAVE to their account (one quote per tab per visit, updated as they
 *     change inputs; the 30 day delete clock starts at first save and is never extended), plus a
 *     "Save as new quote" button and a co-branded header (client photo + rep photo) that also prints
 *   - for guests: a "Log in to save" button that parks the quote in sessionStorage and returns after login
 *     to portal/quote-saved.html, which saves it and confirms.
 * It reads the quote through window.CLA_QUOTE_API (defined in index.html). */
(function () {
  const here = document.currentScript && document.currentScript.src;
  if (!here) return;
  const base = here.replace(/js\/portal-hook\.js.*$/, "");
  const load = (src) => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.async = false; s.onload = res; s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s); });

  (async () => {
    try {
      if (!window.CLA_PORTAL_CONFIG) await load(base + "config.js");            // 404 => portal not configured => stop quietly
    } catch (e) { return; }
    if (!window.CLA_PORTAL_CONFIG || !window.CLA_QUOTE_API) return;
    try { for (const f of ["mock-data", "mock-adapter", "supabase-adapter", "auth-adapter", "portal-ui"]) await load(base + "js/" + f + ".js"); } catch (e) { return; }

    const CLA = window.CLA, esc = CLA.esc, $ = (id) => document.getElementById(id);
    let A, session = null, me = null, rep = null;
    try { A = await CLA.getAdapter(); session = await A.getSession(); if (session) me = await A.getMyProfile(); } catch (e) { me = null; session = null; }
    if (!A) return;

    const css = document.createElement("style");
    css.textContent =
      ".claBrand{background:#fff;border-bottom:1px solid var(--line)}.claBrand .wrap{display:flex;gap:22px;align-items:center;flex-wrap:wrap;padding-top:12px;padding-bottom:12px}" +
      ".claBrand .party{display:flex;align-items:center;gap:12px;min-width:0}.claBrand .party b{display:block;font-size:14px}.claBrand .party span{display:block;color:var(--mut);font-size:12.5px}" +
      ".claBrand img{width:52px;height:52px;border-radius:50%;object-fit:cover;border:2px solid #fff;box-shadow:0 0 0 2px var(--g);flex:none}.claBrand .dv{width:1px;align-self:stretch;background:var(--line)}" +
      ".claBrand .claTag{margin-left:auto;font-size:12px;color:var(--mut)}" +
      ".claHdr{display:inline-flex;align-items:center;gap:9px;color:#fff;text-decoration:none;font-size:13px}.claHdr img{width:30px;height:30px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 2px var(--g)}" +
      ".claSaveNote{flex:0 0 100%;margin:-4px 0 0;font-size:13px;color:var(--mut)}.claSaveNote a{color:var(--gdd);font-weight:600}.claSaveNote.err{color:#b3261e}" +
      "@media print{.claBrand{border:0;border-bottom:1px solid #bbb}.claBrand .claTag{display:none}}";
    document.head.appendChild(css);

    // ---- header link ----
    const hr = document.querySelector("header .hr");
    if (hr) {
      if (me) {
        const url = await A.getAvatarUrl(me);
        hr.insertAdjacentHTML("afterbegin", '<a class="claHdr" href="' + base + CLA.homeFor(me.role) + '">' + (url ? '<img src="' + esc(url) + '" alt="">' : "") + "<span>" + esc(CLA.fullName(me)) + " · My account</span></a>" +
          (CLA.isAdmin(me) && me.isRep ? '<a class="claHdr" id="claRepLink" href="' + base + 'rep.html"><span>Rep dashboard</span></a>' : "") +   // admin who also works as a rep
          '<a class="claHdr" id="claHelpLink" href="' + base + CLA.helpHref(me) + '"><span>Help</span></a>');   // clients: client guide, staff: staff manual (signed-in people only)
      } else {
        hr.insertAdjacentHTML("afterbegin", '<a class="btn sec" href="' + base + 'login.html?next=quote-saved.html">Log in</a>');
      }
    }

    // ---- staff feedback button (admin, super admin, rep only; clients and guests never load it) ----
    // (loads its own file, so it works even if a cached portal-ui.js predates CLA.startFeedback; the widget re-checks the role itself)
    if (me && ["super_admin", "admin", "rep"].includes(me.role) && me.status !== "disabled") {
      const fv = (CLA.FEEDBACK_V || "20261025g");
      (CLA.mountFeedback ? Promise.resolve() : load(base + "js/feedback-widget.js?v=" + fv)).then(() => CLA.mountFeedback({ A, me, base, ver: fv })).catch(() => {});   // optional: never break the calculator over it
    }

    // ---- co-branded header (client photo + rep photo); shows on screen and in print ----
    // (a plain admin / super admin has no co-brand; one who also works as a rep brands their own quotes like a rep)
    if (me && (!CLA.isAdmin(me) || me.isRep)) {
      try { rep = me.role === "client" ? await A.getMyRep() : me; } catch (e) {}
      const party = async (p, line2, line3) => '<div class="party">' + ((await A.getAvatarUrl(p)) ? '<img src="' + esc(await A.getAvatarUrl(p)) + '" alt="Photo of ' + esc(CLA.fullName(p)) + '">' : '<img src="' + esc(CLA.silhouette("#e4e9da", "#9aa38a")) + '" alt="">') + "<div><b>" + esc(CLA.fullName(p)) + "</b><span>" + esc(line2 || "") + "</span><span>" + esc(line3 || "") + "</span></div></div>";
      const left = me.role === "client" ? await party(me, me.companyName, me.phone) : "";
      const right = rep ? await party(rep, "C.L.A. Title & Escrow", rep.cellPhone ? "Cell " + CLA.displayPhone(rep.cellPhone) : rep.phone) : "";
      const html = left + (left && right ? '<div class="dv"></div>' : "") + right;
      const bar = document.querySelector(".modebar") || document.querySelector("header");
      if (html) bar.insertAdjacentHTML("afterend", '<div class="claBrand" id="claBrand"><div class="wrap">' + html + '<span class="claTag">Prepared with C.L.A. Title &amp; Escrow</span></div></div>');
    }

    // ---- special settlement fee (migration 16) ----
    // A rep whose email is in a pricing table gets that table's CLA settlement fees, a client (realtor) their rep's table (the database decides: get_my_fee_overrides()).
    // Only that one fee line changes; premiums and recording fees are never touched. Anything wrong (migration not applied yet, network)
    // = standard fees, silently: never break the calculator over it.
    if (me && A.getMyFeeOverrides && window.CLA_QUOTE_API.setFeeOverrides) {
      try { const ov = await A.getMyFeeOverrides(); if (ov && ov.length) window.CLA_QUOTE_API.setFeeOverrides(ov); } catch (e) { /* standard fees */ }
    }

    // ---- save controls ----
    const ids = { quote: null, seller: null };
    const slots = [[document.getElementById("copy"), "quote"], [document.getElementById("sCopy"), "seller"]];
    const notes = {};
    for (const [copyBtn, m] of slots) {
      if (!copyBtn) continue;
      const foot = copyBtn.parentElement;
      const b = document.createElement("button"); b.type = "button"; b.className = "btn o"; b.id = "claSave_" + m;
      b.textContent = me ? "Save as new quote" : "Log in to save";
      const note = document.createElement("span"); note.className = "claSaveNote"; note.setAttribute("role", "status"); note.id = "claNote_" + m;
      foot.insertBefore(b, foot.querySelector("[id$=rint]") || null); foot.appendChild(note);
      if (!me) note.textContent = "Guest quotes are not saved. Log in to save quotes to your account and print them with your photo and your CLA rep's.";
      notes[m] = note;
      b.onclick = async () => {
        const snap = window.CLA_QUOTE_API.snapshot();
        if (!me) { sessionStorage.setItem("cla_pending_quote", JSON.stringify(snap)); location.href = base + "login.html?next=quote-saved.html"; return; }
        ids[m] = null; await persist(m, true);
      };
    }

    function noteOk(m, q) {
      notes[m].className = "claSaveNote";
      notes[m].innerHTML = "Saved to your account · " + (CLA.daysLeft(q.expiresAt) ? "deletes itself " + CLA.date(q.expiresAt) + " (30 days after it was created)" : "expires today") + ' · <a href="' + base + "quote.html?id=" + encodeURIComponent(q.id) + '">View with photos</a> · <a href="' + base + CLA.quotesHome(me) + '">My quotes</a>';
    }
    let busy = false;
    async function persist(m, manual) {
      if (!me || busy) return; busy = true;
      try {
        const snap = window.CLA_QUOTE_API.snapshot();
        const q = ids[m] ? await A.updateQuote(ids[m], snap) : await A.saveQuote(snap);
        ids[m] = q.id; noteOk(m, q);
        if (manual) CLA.toast("Quote saved to your account");
      } catch (ex) { notes[m].className = "claSaveNote err"; notes[m].textContent = "Could not save to your account: " + ex.message; ids[m] = null; }
      busy = false;
    }

    // auto-save: only after the person has actually changed something (never on page load), debounced
    if (me) {
      let timer = null;
      const kick = (e) => {
        if (e && e.isTrusted === false) return;
        const t = e && e.target; if (t && t.closest && t.closest(".foot,.claBrand,header")) return;
        const m = window.CLA_QUOTE_API.mode() === "seller" ? "seller" : "quote";
        if (notes[m]) { notes[m].className = "claSaveNote"; notes[m].textContent = "Saving to your account…"; }
        clearTimeout(timer); timer = setTimeout(() => persist(m, false), 2500);
      };
      for (const id of ["mainQ", "mainS"]) { const el = $(id); if (el) { el.addEventListener("input", kick); el.addEventListener("change", kick); } }
    }
  })();
})();

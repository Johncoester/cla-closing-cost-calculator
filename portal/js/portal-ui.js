/* Shared screen helpers: escaping, formatting, header, sign-in guard, avatars, toasts. */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  const $ = (id) => document.getElementById(id);
  CLA.$ = $;

  CLA.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  CLA.money = (n) => (n == null || isNaN(n) ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  CLA.money0 = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(+n).toLocaleString("en-US"));
  CLA.date = (d) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
  CLA.fullName = (p) => (p ? [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email || "(no name yet)" : "");
  CLA.silhouette = function (bg, fg) {   // neutral head-and-shoulders placeholder (also used for mock sample photos)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="' + bg + '"/><circle cx="64" cy="50" r="22" fill="' + fg + '"/><path d="M20 128c2-30 20-46 44-46s42 16 44 46z" fill="' + fg + '"/></svg>';
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  };
  // tappable phone number: <a href="tel:+12405550142">(240) 555-0142</a>; empty string when there is none
  CLA.telLink = (v) => { const h = CLA.telHref(v); return h ? '<a class="tel" href="' + CLA.esc(h) + '">' + CLA.esc(CLA.displayPhone(CLA.normalizePhone(v))) + "</a>" : ""; };
  // attach live formatting + a validation message to a phone <input>; `errEl` shows CLA.PHONE_MSG when invalid
  CLA.bindPhoneInput = function (input, errEl) {
    const check = () => { const bad = CLA.normalizePhone(input.value) === null; input.setAttribute("aria-invalid", bad ? "true" : "false"); if (errEl) errEl.textContent = bad ? CLA.PHONE_MSG : ""; return !bad; };
    input.addEventListener("input", () => { input.value = CLA.formatPhoneInput(input.value); if (input.getAttribute("aria-invalid") === "true") check(); });
    input.addEventListener("blur", check);
    input.check = check;
  };
  CLA.daysLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
  CLA.expiryHtml = (q) => { const d = CLA.daysLeft(q.expiresAt); return '<span class="expiry' + (d <= 5 ? " soon" : "") + '">Auto-deletes ' + CLA.date(q.expiresAt) + " (" + d + " day" + (d === 1 ? "" : "s") + " left)</span>"; };
  // "Is a rep" = role rep, OR a super admin with the also-a-rep switch on (profile.isRep, from profiles.is_rep). Pass a profile.
  CLA.isRep = (p) => !!p && (p.role === "rep" || (p.role === "super_admin" && !!p.isRep));
  CLA.roleLabel = (r, p) => (r === "super_admin" && p && p.isRep ? "Super admin + rep" : { super_admin: "Super admin", rep: "CLA rep", client: "Client / agent" }[r] || r);
  CLA.homeFor = (role) => (role === "super_admin" ? "admin.html" : role === "rep" ? "rep.html" : "client.html");
  // where "my quotes / my clients" live: reps and admin+rep accounts use the rep dashboard
  CLA.quotesHome = (p) => (CLA.isRep(p) ? "rep.html" : CLA.homeFor(p && p.role));
  CLA.q = (name) => new URLSearchParams(location.search).get(name);
  CLA.safeNext = (n) => (n && /^[\w./-]+\.html(\?[\w=&%.-]*)?$/.test(n) && !/^\/\//.test(n) ? n : null);   // same-folder pages only

  CLA.toast = function (msg) {
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  };

  // headshot <img>; falls back to a neutral silhouette when there is no photo (or the viewer may not see it)
  CLA.avatarImg = function (url, p, cls) {
    const src = url || CLA.silhouette("#e4e9da", "#9aa38a");
    return '<img class="av ' + (cls || "") + '" src="' + CLA.esc(src) + '" alt="' + (url ? "Photo of " + CLA.esc(CLA.fullName(p)) : "") + '">';
  };

  // page header. `profile` may be null on public pages (login etc.)
  CLA.renderHeader = async function (A, profile) {
    const demo = A.mode === "mock"
      ? '<div class="demo"><div class="wrap"><b>Demo mode.</b> Sample data stored only in this browser; no real accounts, email or server. Any password signs in a sample user. <a href="login.html#reset" id="demoReset">Reset sample data</a></div></div>' : "";
    let right = '<a class="navlink" href="../index.html">Calculator (guest)</a>';
    if (profile) {
      const url = await A.getAvatarUrl(profile);
      right = '<a class="navlink" href="../index.html">Calculator</a><a class="navlink" href="' + CLA.homeFor(profile.role) + '">' + (profile.role === "super_admin" && profile.isRep ? "Admin dashboard" : "Dashboard") + "</a>" +
        (profile.role === "super_admin" && profile.isRep ? '<a class="navlink" id="repLink" href="rep.html">Rep dashboard</a>' : "") +
        '<a class="chip" href="profile.html">' + CLA.avatarImg(url, profile, "sm") + '<span>' + CLA.esc(CLA.fullName(profile)) + '<small>' + CLA.roleLabel(profile.role, profile) + "</small></span></a>" +
        '<button class="btn sec" id="signOut" type="button">Sign out</button>';
    }
    document.body.insertAdjacentHTML("afterbegin",
      '<header class="top"><div class="wrap hwrap"><a class="logo" href="' + (profile ? CLA.homeFor(profile.role) : "login.html") + '" aria-label="CLA home">CLA</a>' +
      '<h1 class="ht">C.L.A. Title &amp; Escrow <span>—</span> Quote Portal</h1><div class="hr">' + right + "</div></div></header>" + demo);
    const so = $("signOut"); if (so) so.onclick = async () => { await A.signOut(); location.href = "login.html"; };
    const dr = $("demoReset"); if (dr) dr.onclick = async (e) => { e.preventDefault(); await A._reset(); location.href = "login.html"; };
  };

  // Load adapter + session + profile; redirect to login if signed out or wrong role. Returns {A, me}.
  CLA.boot = async function (roles) {
    let A;
    try { A = await CLA.getAdapter(); } catch (e) { document.body.innerHTML = '<main class="pg narrow"><div class="msg err">' + CLA.esc(e.message) + "</div></main>"; throw e; }
    if (roles === false) { await CLA.renderHeader(A, null); return { A, me: null }; }
    const s = await A.getSession();
    const toLogin = () => { location.replace("login.html?next=" + encodeURIComponent(location.pathname.split("/").pop() + location.search)); };
    if (!s) { toLogin(); throw new Error("redirect"); }
    let me;
    try { me = await A.getMyProfile(); } catch (e) { await A.signOut(); toLogin(); throw e; }
    // "rep" admits real reps AND super admins who also work as a rep; every other entry is an exact role
    if (roles && !roles.some((r) => (r === "rep" ? CLA.isRep(me) : r === me.role))) { location.replace(CLA.homeFor(me.role)); throw new Error("redirect"); }
    await CLA.renderHeader(A, me);
    return { A, me };
  };

  // fill every <img data-avatar-for> after rendering lists: [{el, profile}]
  CLA.fillAvatars = async function (A, root) {
    const items = (root || document).querySelectorAll("[data-av]");
    await Promise.all([...items].map(async (el) => {
      const p = JSON.parse(el.getAttribute("data-av"));
      const url = await A.getAvatarUrl(p); if (url) el.src = url;
    }));
  };
  CLA.avImg = function (p, cls) {
    return '<img class="av ' + (cls || "") + '" data-av="' + CLA.esc(JSON.stringify({ id: p.id, avatarPath: p.avatarPath })) + '" src="' + CLA.esc(CLA.silhouette("#e4e9da", "#9aa38a")) + '" alt="">';
  };

  CLA.passwordProblems = function (pw) {   // same rules as the plan: 12+ chars, mixed
    const out = [];
    if (pw.length < 12) out.push("At least 12 characters");
    if (!(/[a-z]/.test(pw) && /[A-Z]/.test(pw))) out.push("Upper and lower case letters");
    if (!/\d/.test(pw)) out.push("A number");
    return out;
  };

  CLA.tabs = function (el, names, onChange) {
    el.innerHTML = names.map((n, i) => '<button type="button" data-i="' + i + '" class="' + (i ? "" : "on") + '">' + CLA.esc(n) + "</button>").join("");
    el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; [...el.children].forEach((c) => c.classList.toggle("on", c === b)); onChange(+b.dataset.i); };
  };
})();

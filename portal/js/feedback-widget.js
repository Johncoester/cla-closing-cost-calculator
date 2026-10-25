/* Staff feedback widget (portal/js/feedback-widget.js). A floating round chat bubble (bottom-right) opens a panel above it (a bottom sheet on a phone).
 * STAFF ONLY: role admin, super_admin or rep (CLA.isStaff). Clients / realtors and guests never get it: CLA.startFeedback()
 * (portal-ui.js) does not even download this file for them, and mountFeedback() checks again.
 * Talks to the adapter seam only: A.submitFeedback({category, message, page}) and A.listMyFeedback(). See auth-adapter.js.
 * Everything that came from a user (our own messages, notes) is put on the page with textContent, never innerHTML.
 * The bubble is fixed bottom-right with safe-area padding; if the AI-assistant launcher (.claChat) is also on the page, the CSS lifts this bubble above it. */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  CLA.FEEDBACK_GREETING = "Hey! I am John Coester here to help you. Give me some feedback.";
  CLA.FEEDBACK_THANKS = "Thanks, I read every note.";
  const MAX = 2000;
  const CATS = [["bug", "Bug: something is broken"], ["idea", "Idea: something that would help"], ["question", "Question"], ["other", "Other"]];
  const CAT_NAME = { bug: "Bug", idea: "Idea", question: "Question", other: "Other" };
  const STATUS_NAME = { new: "Received", notified: "John has been told", approved: "Approved", dismissed: "Closed" };
  // path only: no query, no hash (the database cuts them off as well)
  CLA.feedbackPage = (loc) => { const l = loc || window.location; return String((l && l.pathname) || "").split("?")[0].split("#")[0].slice(0, 200); };

  CLA.mountFeedback = async function (o) {
    const A = o && o.A, me = o && o.me;
    if (!A || !me || !(CLA.isStaff ? CLA.isStaff(me) : ["super_admin", "admin", "rep"].includes(me.role))) return null;   // not staff: nothing
    if (document.getElementById("claFeedbackLink")) return null;
    try { if (!(await A.getSession())) return null; } catch (e) { return null; }                                      // no session, no widget
    const base = o.base || "", ver = o.ver ? "?v=" + o.ver : "";
    if (!document.getElementById("claFbCss")) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.id = "claFbCss"; l.href = base + "feedback-widget.css" + ver; document.head.appendChild(l);
    }
    const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

    // ---- the floating launcher: a round chat bubble, bottom-right (not in the header any more) ----
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = (cls, paths, vb) => { const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", vb || "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false"); if (cls) s.setAttribute("class", cls);
      paths.forEach(([tag, attrs]) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); s.appendChild(n); }); return s; };
    const link = el("button", "claFbFab"); link.type = "button"; link.id = "claFeedbackLink";
    link.setAttribute("aria-haspopup", "dialog"); link.setAttribute("aria-expanded", "false"); link.setAttribute("aria-label", "Send feedback"); link.setAttribute("data-tip", "Feedback"); link.title = "Send feedback to John";
    link.appendChild(svg("claFbIcoChat", [["path", { d: "M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-6.2l-4.3 3.4c-.6.5-1.5.1-1.5-.7V18H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z", fill: "currentColor" }], ["circle", { cx: "8.5", cy: "11", r: "1.3", fill: "#8dc63f" }], ["circle", { cx: "12.5", cy: "11", r: "1.3", fill: "#8dc63f" }], ["circle", { cx: "16.5", cy: "11", r: "1.3", fill: "#8dc63f" }]]));
    link.appendChild(svg("claFbIcoX", [["path", { d: "M6 6l12 12M18 6L6 18", fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round" }]]));
    document.body.appendChild(link);

    // ---- the panel (built once, shown on demand; it opens above the bubble, or as a bottom sheet on a phone) ----
    const ovl = el("div", "claFbOvl"); ovl.id = "claFb"; ovl.hidden = true;
    const dlg = el("div", "claFbDlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "claFbTitle");
    const xBtn = el("button", "claFbX"); xBtn.type = "button"; xBtn.id = "claFbX"; xBtn.setAttribute("aria-label", "Close feedback"); xBtn.appendChild(svg("", [["path", { d: "M6 6l12 12M18 6L6 18", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round" }]]));
    const body = el("div", "claFbBody");
    const hi = el("p", "claFbHi", CLA.FEEDBACK_GREETING); hi.id = "claFbHi";   // styled as the gradient header; the "JC" avatar is a CSS ::before (not text)
    const title = el("h2", "", "Send feedback"); title.id = "claFbTitle";
    // form view
    const form = el("form"); form.id = "claFbForm"; form.noValidate = true;
    const lc = el("div", "claFbLbl", "What kind of feedback?"); lc.id = "claFbCatLbl";
    const cat = el("select", "claFbSel"); cat.id = "claFbCat"; cat.tabIndex = -1; cat.setAttribute("aria-hidden", "true"); CATS.forEach(([v, t]) => { const op = el("option", "", t); op.value = v; cat.appendChild(op); });   // the source of truth; the chips drive it
    const chips = el("div", "claFbChips"); chips.setAttribute("role", "radiogroup"); chips.setAttribute("aria-labelledby", "claFbCatLbl");
    const radios = CATS.map(([v, t]) => { const lab = el("label", "claFbChip"), inp = el("input"); inp.type = "radio"; inp.name = "claFbKind"; inp.value = v; inp.id = "claFbKind_" + v; inp.checked = v === "bug";
      const tx = el("span", "", CAT_NAME[v]); lab.title = t; lab.appendChild(inp); lab.appendChild(tx); chips.appendChild(lab); inp.addEventListener("change", () => { if (inp.checked) cat.value = v; }); return inp; });
    const syncChips = () => radios.forEach((r) => { r.checked = r.value === cat.value; });
    const lm = el("label", "claFbLbl", "Your message"); lm.setAttribute("for", "claFbMsg");
    const msg = el("textarea"); msg.id = "claFbMsg"; msg.maxLength = MAX; msg.placeholder = "What happened, or what would help?"; msg.setAttribute("aria-describedby", "claFbCount claFbErr");
    const meta = el("div", "claFbMeta"), page = el("span"), count = el("span", "", "0 / " + MAX); page.id = "claFbPage"; count.id = "claFbCount";
    meta.appendChild(page); meta.appendChild(count);
    const err = el("div", "claFbErr"); err.id = "claFbErr"; err.setAttribute("role", "alert");
    const row = el("div", "claFbRow"), cancel = el("button", "claFbBtn o", "Cancel"), send = el("button", "claFbBtn"); send.appendChild(el("span", "claFbSpin")); send.appendChild(el("span", "claFbSendTx", "Send feedback"));
    cancel.type = "button"; cancel.id = "claFbCancel"; send.type = "submit"; send.id = "claFbSend"; row.appendChild(cancel); row.appendChild(send);
    [lc, cat, chips, lm, msg, meta, err, row].forEach((x) => form.appendChild(x));
    // confirmation view
    const done = el("div"); done.id = "claFbDone"; done.hidden = true;
    const okMark = el("div", "claFbOk"); okMark.appendChild(svg("", [["circle", { class: "c", cx: "26", cy: "26", r: "23", fill: "none" }], ["path", { class: "t", d: "M15.5 27l7.5 7.5L37 19.5", fill: "none" }]], "0 0 52 52"));
    const thanks = el("p", "claFbThanks", CLA.FEEDBACK_THANKS); thanks.setAttribute("role", "status");
    const row2 = el("div", "claFbRow"), again = el("button", "claFbBtn o", "Send another"), closeB = el("button", "claFbBtn", "Close");
    again.type = "button"; again.id = "claFbAgain"; closeB.type = "button"; closeB.id = "claFbClose"; row2.appendChild(again); row2.appendChild(closeB);
    done.appendChild(okMark); done.appendChild(thanks); done.appendChild(row2);
    // my feedback
    const mine = el("div", "claFbMine"); mine.id = "claFbMine"; mine.appendChild(el("h3", "", "Your feedback"));
    const ul = el("ul"); ul.setAttribute("aria-live", "polite"); mine.appendChild(ul);
    [hi, title, form, done, mine].forEach((x) => body.appendChild(x)); dlg.appendChild(xBtn); dlg.appendChild(body); ovl.appendChild(dlg); document.body.appendChild(ovl);

    const short = (t) => (t.length > 160 ? t.slice(0, 160) + "…" : t);
    async function paintMine() {
      let rows = [];
      try { rows = (await A.listMyFeedback()) || []; } catch (e) { rows = []; }
      ul.textContent = "";
      if (!rows.length) { ul.appendChild(el("li", "none", "Nothing sent yet.")); return; }
      rows.slice(0, 8).forEach((f) => {
        const li = el("li"), b = el("b", "", CAT_NAME[f.category] || f.category), st = el("span", "st " + f.status, STATUS_NAME[f.status] || f.status);
        li.appendChild(b); li.appendChild(st); li.appendChild(document.createTextNode(" · " + new Date(f.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + short(String(f.message || ""))));
        if (f.decidedNote) li.appendChild(el("span", "note", "John: " + f.decidedNote));
        ul.appendChild(li);
      });
    }
    function show(view) { form.hidden = view !== "form"; done.hidden = view !== "done"; title.hidden = view !== "form"; if (view === "done") { okMark.classList.remove("go"); void okMark.offsetWidth; okMark.classList.add("go"); } }
    const setBusy = (b) => { send.disabled = b; send.classList.toggle("busy", b); if (b) send.setAttribute("aria-busy", "true"); else send.removeAttribute("aria-busy"); send.querySelector(".claFbSendTx").textContent = b ? "Sending…" : "Send feedback"; };
    const setCount = () => { count.textContent = msg.value.length + " / " + MAX; count.classList.toggle("warn", msg.value.length > MAX * 0.9); };
    let closing = null, isOpen = false;
    const open = () => {
      if (closing) { clearTimeout(closing); closing = null; ovl.classList.remove("out"); }
      if (isOpen) return; isOpen = true;
      err.textContent = ""; msg.value = ""; setCount(); cat.value = "bug"; syncChips(); setBusy(false);
      page.textContent = "Page: " + (CLA.feedbackPage() || "/"); show("form"); ovl.hidden = false; link.classList.add("open"); link.setAttribute("aria-expanded", "true"); paintMine(); msg.focus();
      document.addEventListener("keydown", onKey);
    };
    const finish = () => { closing = null; ovl.hidden = true; ovl.classList.remove("out"); };
    const close = () => {
      if (!isOpen) return; isOpen = false;
      document.removeEventListener("keydown", onKey); link.classList.remove("open"); link.setAttribute("aria-expanded", "false"); link.focus();
      let anim = ""; try { anim = window.getComputedStyle(dlg).animationName; } catch (e) { anim = ""; }
      if (anim && anim !== "none") { ovl.classList.add("out"); closing = setTimeout(finish, 170); } else finish();   // animate out only where CSS animation runs (not with prefers-reduced-motion)
    };
    const onKey = (e) => {
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Tab") return;
      const f = [...dlg.querySelectorAll("button,textarea,input")].filter((x) => !x.disabled && !x.closest("[hidden]") && x.tabIndex >= 0); if (!f.length) return;
      const first = f[0], last = f[f.length - 1], ae = document.activeElement;
      if (e.shiftKey && (ae === first || !dlg.contains(ae))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && (ae === last || !dlg.contains(ae))) { e.preventDefault(); first.focus(); }
    };
    link.onclick = () => (isOpen ? close() : open()); cancel.onclick = close; closeB.onclick = close; xBtn.onclick = close;
    again.onclick = () => { err.textContent = ""; msg.value = ""; setCount(); show("form"); msg.focus(); };
    ovl.onclick = (e) => { if (e.target === ovl) close(); };
    msg.addEventListener("input", setCount);
    form.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = "";
      const text = msg.value.trim();
      if (!text) { err.textContent = "Please write a message first."; msg.focus(); return; }
      if (text.length > MAX) { err.textContent = "That is too long (" + MAX + " characters at most)."; return; }
      setBusy(true);
      try { await A.submitFeedback({ category: cat.value, message: text, page: CLA.feedbackPage() }); setBusy(false); show("done"); closeB.focus(); paintMine(); }
      catch (ex) { err.textContent = (ex && ex.message) || "Could not send. Please try again."; setBusy(false); }
    };
    return { link, open, close, root: ovl };
  };
})();

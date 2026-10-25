/* Staff feedback dialog (portal/js/feedback-widget.js). A "Feedback" button in the page header opens a small dialog.
 * STAFF ONLY: role admin, super_admin or rep (CLA.isStaff). Clients / realtors and guests never get it: CLA.startFeedback()
 * (portal-ui.js) does not even download this file for them, and mountFeedback() checks again.
 * Talks to the adapter seam only: A.submitFeedback({category, message, page}) and A.listMyFeedback(). See auth-adapter.js.
 * Everything that came from a user (our own messages, notes) is put on the page with textContent, never innerHTML.
 * The button goes into `header .hr` (portal pages and the calculator), NOT the bottom-right corner (a chat launcher may live there). */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  CLA.FEEDBACK_GREETING = "Hey! I am John Coester here to help you. Give me some feedback.";
  CLA.FEEDBACK_THANKS = "Thanks, John will review it.";
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

    // ---- the header button ----
    const link = el("button", "claFbLink", "Feedback"); link.type = "button"; link.id = "claFeedbackLink";
    link.setAttribute("aria-haspopup", "dialog"); link.title = "Send feedback to John";
    const hr = document.querySelector("header .hr") || document.querySelector("header");
    if (hr) {
      const anchors = hr.querySelectorAll(".navlink,.claHdr"), last = anchors[anchors.length - 1];
      if (last) last.insertAdjacentElement("afterend", link); else hr.insertBefore(link, hr.firstChild);
    } else return null;

    // ---- the dialog (built once, shown on demand) ----
    const ovl = el("div", "claFbOvl"); ovl.id = "claFb"; ovl.hidden = true;
    const dlg = el("div", "claFbDlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "claFbTitle");
    const body = el("div", "claFbBody");
    const hi = el("p", "claFbHi", CLA.FEEDBACK_GREETING); hi.id = "claFbHi";
    const title = el("h2", "", "Send feedback"); title.id = "claFbTitle";
    // form view
    const form = el("form"); form.id = "claFbForm"; form.noValidate = true;
    const lc = el("label", "", "What kind of feedback?"); lc.setAttribute("for", "claFbCat");
    const cat = el("select"); cat.id = "claFbCat"; CATS.forEach(([v, t]) => { const op = el("option", "", t); op.value = v; cat.appendChild(op); });
    const lm = el("label", "", "Your message"); lm.setAttribute("for", "claFbMsg");
    const msg = el("textarea"); msg.id = "claFbMsg"; msg.maxLength = MAX; msg.placeholder = "What happened, or what would help?"; msg.setAttribute("aria-describedby", "claFbCount claFbErr");
    const meta = el("div", "claFbMeta"), page = el("span"), count = el("span", "", "0 / " + MAX); page.id = "claFbPage"; count.id = "claFbCount";
    meta.appendChild(page); meta.appendChild(count);
    const err = el("div", "claFbErr"); err.id = "claFbErr"; err.setAttribute("role", "alert");
    const row = el("div", "claFbRow"), cancel = el("button", "claFbBtn o", "Cancel"), send = el("button", "claFbBtn", "Send feedback");
    cancel.type = "button"; cancel.id = "claFbCancel"; send.type = "submit"; send.id = "claFbSend"; row.appendChild(cancel); row.appendChild(send);
    [lc, cat, lm, msg, meta, err, row].forEach((x) => form.appendChild(x));
    // confirmation view
    const done = el("div"); done.id = "claFbDone"; done.hidden = true;
    const thanks = el("p", "claFbThanks", CLA.FEEDBACK_THANKS); thanks.setAttribute("role", "status");
    const row2 = el("div", "claFbRow"), again = el("button", "claFbBtn o", "Send another"), closeB = el("button", "claFbBtn", "Close");
    again.type = "button"; again.id = "claFbAgain"; closeB.type = "button"; closeB.id = "claFbClose"; row2.appendChild(again); row2.appendChild(closeB);
    done.appendChild(thanks); done.appendChild(row2);
    // my feedback
    const mine = el("div", "claFbMine"); mine.id = "claFbMine"; mine.appendChild(el("h3", "", "Your feedback"));
    const ul = el("ul"); ul.setAttribute("aria-live", "polite"); mine.appendChild(ul);
    [hi, title, form, done, mine].forEach((x) => body.appendChild(x)); dlg.appendChild(body); ovl.appendChild(dlg); document.body.appendChild(ovl);

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
    function show(view) { form.hidden = view !== "form"; done.hidden = view !== "done"; title.hidden = view !== "form"; }
    const open = () => {
      err.textContent = ""; msg.value = ""; count.textContent = "0 / " + MAX; cat.value = "bug"; send.disabled = false;
      page.textContent = "Page: " + (CLA.feedbackPage() || "/"); show("form"); ovl.hidden = false; paintMine(); msg.focus();
      document.addEventListener("keydown", onKey);
    };
    const close = () => { ovl.hidden = true; document.removeEventListener("keydown", onKey); link.focus(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    link.onclick = open; cancel.onclick = close; closeB.onclick = close; again.onclick = () => { err.textContent = ""; msg.value = ""; count.textContent = "0 / " + MAX; show("form"); msg.focus(); };
    ovl.onclick = (e) => { if (e.target === ovl) close(); };
    msg.addEventListener("input", () => { count.textContent = msg.value.length + " / " + MAX; });
    form.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = "";
      const text = msg.value.trim();
      if (!text) { err.textContent = "Please write a message first."; msg.focus(); return; }
      if (text.length > MAX) { err.textContent = "That is too long (" + MAX + " characters at most)."; return; }
      send.disabled = true;
      try { await A.submitFeedback({ category: cat.value, message: text, page: CLA.feedbackPage() }); show("done"); closeB.focus(); paintMine(); }
      catch (ex) { err.textContent = (ex && ex.message) || "Could not send. Please try again."; send.disabled = false; }
    };
    return { link, open, close, root: ovl };
  };
})();

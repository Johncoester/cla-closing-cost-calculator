/* Guided tour ("Take the tour"): a click-through walkthrough for new people. Dependency-free; no libraries, no CDN.
 * Loaded on demand by CLA.initTour / CLA.takeTour (portal-ui.js), only for someone who is about to see it. Styles: portal/tour.css.
 *
 * SIMPLE AND ROBUST: every tour lives on ONE page, the person's own dashboard (admin.html, rep.html, client.html).
 * No step ever navigates, so there is no progress to carry between pages. Steps that need a tab or a form opened
 * (admin: Assignments, Feedback, Invite) open it first (`show`) and put it back when you leave (`leave` / `cleanup`).
 * Targets are plain data-tour="..." attributes on existing elements. A target that is missing or hidden for this role
 * (e.g. the "also works as a rep" switch for an admin) is skipped, and the step counter only counts the steps that are shown.
 *
 * Keyboard: Right arrow = Next, Left arrow = Back, Esc = Skip. Tab stays inside the box. Focus goes to the box on every step
 * (a dialog with a title and the text, so a screen reader reads them) and back to where you were when it ends.
 * Motion: the overlay never animates for people who ask for reduced motion (prefers-reduced-motion, see tour.css).
 * Seen: when the tour ends (Done, Skip or Esc) opts.onClose is called; the portal then calls A.markTourSeen() (profiles.tour_seen_at).
 *
 * Text is fixed in this file (never user content), but is still put on the page with textContent.
 *
 * CALCULATOR TOUR (kind "calculator"): the same engine also runs on the public calculator (index.html), for anyone, signed in or not.
 * index.html loads this file and tour.css on demand (from the "Take the tour" link or the first-visit chip). Its steps are plain
 * data-tour="k-..." attributes on existing elements, plus a few elements that only exist when signed in (#claSave_quote, #claFeedbackLink),
 * which are simply skipped when absent. Steps that need the Seller Net Sheet (or the Buyer Quote) open it first (`show`) and put the person's
 * own tab back afterwards (`leave`, and the cleanup when the tour ends). It never clicks Purchase / Cash / Refinance, because switching
 * those rebuilds the documents and endorsements and would throw away edits. It never changes a number.
 */
(function () {
  const CLA = (window.CLA = window.CLA || {});
  const $ = (s, r) => (r || document).querySelector(s);

  // ---------- the tours ----------
  // step: { target: css selector (omit = centred note), show: css selector to CLICK first (a tab / button), leave: selector to click when leaving, title, text }
  // `show`, when given, is what must exist for the step to be offered; otherwise `target` must exist and be visible.
  CLA.tourSteps = function (kind, me) {
    const isSuper = !!me && me.role === "super_admin";
    const T = (target, title, text, more) => Object.assign({ target, title, text }, more || {});
    if (kind === "admin") return [
      T('[data-tour="a-welcome"]', "Welcome to the admin dashboard", "Hi, I'm John. Here's where you'll look after people, assignments and feedback. This takes about a minute, and you can skip any time."),
      T('[data-tour="a-users"]', "Everyone with an account", "Every rep, client and admin is listed here with their role and status. Narrow the list with the Role, Status and search boxes. Use Disable to stop someone signing in (their data stays), and Re-enable to bring them back. A disabled person can also be deleted for good."),
      T('[data-tour="u-role"]', "Change a role", (isSuper ? "As a super admin you can set anyone's role. " : "You can move reps, clients and other admins up or down, but only a super admin can promote an admin or touch a super admin. ") +
        "If you move a rep who has clients, you'll pick who takes them over, so nobody is left without a rep."),
      T('[data-tour="u-also"]', "Also works as a rep", "Switch this on for an admin who also looks after clients (they need an @clatitle.com email). Then they get a Rep dashboard as well."),
      T('[data-tour="a-invite"]', "Invite someone", (isSuper ? "Pick a role and send the invite: reps (CLA email required), clients, admins or super admins. " : "Pick a role and send the invite: reps (CLA email required) or clients. Only a super admin can invite admins. ") +
        "They get an email to set a password.", { show: '[data-tour="a-invite-btn"]', leave: "#invCancel" }),
      T('[data-tour="a-assign"]', "Assignments", "Match a client to a rep by email, even before the client has an account. Reassigning keeps the history.", { show: '#tabs button[data-i="2"]', leave: '#tabs button[data-i="0"]' }),
      T('[data-tour="a-feedback"]', "Staff feedback", isSuper ? "Feedback from staff lands here. You can read it all, and approve or dismiss each item with a note that the sender sees."
        : "Feedback from staff lands here and you can read all of it. Only a super admin can approve or dismiss an item.", { show: '#tabs button[data-i="4"]', leave: '#tabs button[data-i="0"]' }),
    ].filter((s) => s.target !== '[data-tour="u-also"]' || isSuper);
    if (kind === "rep") return [
      T('[data-tour="r-welcome"]', "Welcome to your dashboard", "Hi, I'm John. Here's where you'll see your clients and their quotes. This takes about a minute, and you can skip any time."),
      T('[data-tour="r-clients"]', "Your clients", "Everyone assigned to you is here, with their cell number and saved quotes. Click a client to see their quotes."),
      T('[data-tour="r-invite"]', "Invite a client", "Type their email and send. They get a link to set a password and they're matched to you, so the quotes they save show up here."),
      T('[data-tour="r-quotes"]', "All quotes in one place", "This tab lists your clients' quotes and your own. They delete themselves 30 days after they were created.", { show: '#tabs button[data-i="1"]', leave: '#tabs button[data-i="0"]' }),
      T('[data-tour="h-profile"]', "Your profile and cell phone", "Add your cell phone and a headshot here. Your clients see your cell number so they can call or text you."),
      T('[data-tour="r-calc"]', "The calculator", "Open the calculator to run a quote. While you're signed in, it saves automatically and carries your photo and your details."),
      me && CLA.isAdmin && CLA.isAdmin(me) ? T('[data-tour="h-admin"]', "You are also an admin", "You also work as a rep, so you have both dashboards. Use these header links to switch between them.") : null,
    ].filter(Boolean);
    if (kind === "client") return [
      T('[data-tour="c-welcome"]', "Welcome to your quotes", "Hi, I'm John. Here's where you'll find the quotes you've run. This takes about a minute, and you can skip any time."),
      T('[data-tour="c-new"]', "Run a new quote", "Open the calculator and sign in first. Then every quote you run is saved to your account."),
      T('[data-tour="c-autosave"]', "Saved for you, then cleared", "Quotes save on their own while you're signed in, and delete themselves 30 days after they were created. Print or copy anything you want to keep."),
      T('[data-tour="c-quotes"]', "Your saved quotes", "Open a quote to see it again, or delete one you don't need. The little note shows how long it has left."),
      T('[data-tour="c-profile"]', "Your profile", "Your name, company and contact details go on the quotes you share. A photo is optional: until you add one, a plain placeholder shows. You can add it from your profile any time."),
      T('[data-tour="c-rep"]', "Talk to your rep", "This is your CLA rep. Call or text their cell with any question about a quote. If you haven't been matched yet, CLA will connect you by email."),
      T(null, "One last thing", "Quotes are estimates only, not a Loan Estimate or Closing Disclosure. For a binding quote, ask your CLA rep. You can replay this tour any time from \"Take the tour\" at the top."),
    ];
    if (kind === "calculator") {
      const signedIn = !!(me && me.signedIn);
      const cur = document.querySelector('#modes button.on'), orig = (cur && cur.dataset && cur.dataset.mode) === "seller" ? "seller" : "quote";
      const mode = (m) => ({ show: '#modes button[data-mode="' + m + '"]', leave: () => click('#modes button[data-mode="' + orig + '"]') });   // open a mode, then put the person's own back
      const list = [
        T(null, "Welcome to the closing cost estimator", "Hi, I'm John. Here's a quick look around the calculator. It takes about a minute, you can skip any time, and you don't need to sign in to use any of it."),
        T('[data-tour="k-modes"]', "Buyer quote or seller net sheet", "Buyer Quote shows what a buyer pays at closing. Seller Net Sheet shows what a seller walks away with. The property details you've typed carry across when you switch."),
        T('[data-tour="k-types"]', "Purchase, cash or refinance", "Purchase is a financed sale, Cash has no loan, and Refinance swaps the price for a payoff and a new loan amount. Pick the one that matches the deal.", mode("quote")),
        T('[data-tour="k-zip"]', "Start with the ZIP", "Type the property's ZIP and I'll fill in the state and county, since county taxes depend on it. You can also pick them yourself just below. The address and city are optional and show on the quote.", mode("quote")),
        T('[data-tour="k-amounts"]', "Price and loan amount", "Enter the sale price and the loan amount. On a refinance you'll see the payoff and the new loan amount instead. The estimate updates as you type.", mode("quote")),
        T('[data-tour="k-policy"]', "Title policy choices", "Choose the owner's policy (Enhanced or Standard) and the basic or reissue rate. Just below, pick who pays for it and whether to show fees the Loan Estimate way or as the actual split.", mode("quote")),
        T('[data-tour="k-fees"]', "CLA fees, endorsements, documents", "Our standard fees are listed here, locked, straight from the team fee sheet. Above them you can tick endorsements and set how many documents we record.", mode("quote")),
        T('[data-tour="k-total"]', "Your estimate", "Here's the buyer's total (the borrower's on a refinance), with the seller's total and all parties underneath. It updates with every change you make.", mode("quote")),
        T('[data-tour="k-ledger"]', "Where every dollar comes from", "Each section lists the lender's and owner's title policies, settlement and CLA fees, recording fees and transfer taxes, with a buyer column, a seller column and a total for each section.", mode("quote")),
        T('[data-tour="k-actions"]', "Copy or print your quote", "Copy quote puts a plain-text version on your clipboard to paste into an email. Print / Save PDF makes a clean printable copy.", mode("quote")),
        T('[data-tour="k-seller"]', "Seller net sheet", "Here the seller's costs come off the price: commissions, payoffs, property taxes, credits and CLA's fees. What's left is the net proceeds. I'll put you back where you were when we're done.", mode("seller")),
        T('#claSave_quote', signedIn ? "Saved to your account" : "Saving a quote", signedIn
          ? "Your quotes save on their own while you're signed in, and delete themselves 30 days after they were created. Save as new quote keeps a separate copy."
          : "Guest quotes aren't saved. Log in if you'd like to keep them in your account and print them with your CLA rep's photo and details. Signing in is optional.", mode("quote")),
        T('#claFeedbackLink', "Tell me what to fix", "This round bubble sends feedback straight to me. Tell me about a bug or an idea."),
        T('[data-tour="k-tourlink"]', "Take the tour any time", "You can replay this tour from here whenever you like."),
        T('[data-tour="k-disclaimer"]', "Estimates only", "These are estimates, not a Loan Estimate or Closing Disclosure, and actual charges may vary. For a binding quote, contact C.L.A. Title & Escrow."),
      ];
      list.restore = () => click('#modes button[data-mode="' + orig + '"]');   // safety net when the tour ends
      return list;
    }
    return [];
  };

  // ---------- helpers ----------
  const shown = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (n.hidden) return false; if (window.getComputedStyle(n).display === "none") return false; } return !!el; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => { if (typeof sel === "function") { try { sel(); } catch (e) {} return true; } const e = sel && $(sel); if (e && shown(e)) e.click(); return !!e; };   // a selector to click, or a function to run
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  // The steps that can be shown right now (a hidden or missing target is skipped, a centred note always shows)
  CLA.tourAvailable = function (steps) {
    // a step with `show` needs that button, and its target must exist (it may be hidden until `show` opens it); otherwise the target must be visible now
    return steps.filter((s) => (s.show ? !!$(s.show) && shown($(s.show)) && (!s.target || !!$(s.target)) : !s.target || shown($(s.target))));
  };

  // ---------- the engine ----------
  // CLA.runTour(steps, { onClose(reason), cleanup: [selectors to click at the end], returnFocus })  ->  { close, next, back, root, steps }
  CLA.runTour = function (allSteps, opts) {
    opts = opts || {};
    const steps = CLA.tourAvailable(allSteps || []);
    if (!steps.length || document.getElementById("claTour")) return null;
    const back = opts.returnFocus || document.activeElement;
    const root = el("div", "claTour"); root.id = "claTour";
    const shade = el("div", "claTourShade"), spot = el("div", "claTourSpot"); spot.hidden = true;
    const pop = el("div", "claTourPop"); pop.setAttribute("role", "dialog"); pop.setAttribute("aria-modal", "true"); pop.tabIndex = -1;
    pop.setAttribute("aria-labelledby", "claTourTitle"); pop.setAttribute("aria-describedby", "claTourText");
    const count = el("div", "claTourCount"); count.id = "claTourCount";
    const title = el("h2", "claTourTitle"); title.id = "claTourTitle";
    const text = el("p", "claTourText"); text.id = "claTourText";
    const bar = el("div", "claTourBar"), skip = el("button", "claTourBtn link", "Skip tour"), prev = el("button", "claTourBtn o", "Back"), next = el("button", "claTourBtn", "Next");
    [skip, prev, next].forEach((b) => (b.type = "button")); skip.id = "claTourSkip"; prev.id = "claTourBack"; next.id = "claTourNext";
    const nav = el("div", "claTourNav"); nav.appendChild(prev); nav.appendChild(next); bar.appendChild(skip); bar.appendChild(nav);
    [count, title, text, bar].forEach((x) => pop.appendChild(x)); [shade, spot, pop].forEach((x) => root.appendChild(x)); document.body.appendChild(root);

    let i = -1, tok = 0, target = null, closed = false;
    const mobile = () => window.innerWidth <= 640;
    function place() {
      if (closed) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      if (!target) { spot.hidden = true; shade.classList.add("dim"); pop.classList.add("mid"); pop.classList.toggle("sheet", mobile()); pop.style.cssText = ""; return; }   // a centred note (a bottom sheet on a phone)
      shade.classList.remove("dim"); pop.classList.remove("mid");
      const r = target.getBoundingClientRect(), pad = 6;
      const top = Math.max(r.top - pad, 4), left = Math.max(r.left - pad, 4), bottom = Math.min(r.bottom + pad, vh - 4), right = Math.min(r.right + pad, vw - 4);
      spot.hidden = false; spot.style.cssText = "top:" + top + "px;left:" + left + "px;width:" + Math.max(right - left, 8) + "px;height:" + Math.max(bottom - top, 8) + "px";
      if (mobile()) { pop.classList.add("sheet"); pop.style.cssText = ""; return; }   // a sheet at the bottom of the screen
      pop.classList.remove("sheet");
      const pw = Math.min(pop.offsetWidth || 340, vw - 24), ph = pop.offsetHeight || 190, gap = 14;
      let t = bottom + gap; if (t + ph > vh - 8) t = top - gap - ph;   // below, else above
      let l = Math.min(Math.max(left + (right - left) / 2 - pw / 2, 12), vw - pw - 12);
      if (t < 8) {   // a tall target (no room above or below): beside it when there is room, else centred
        t = Math.max(8, Math.min(vh - ph - 8, (top + bottom) / 2 - ph / 2));
        if (left >= pw + 24) l = left - pw - 12; else if (vw - right >= pw + 24) l = right + 12;
      }
      pop.style.cssText = "top:" + t + "px;left:" + l + "px";
    }
    function reveal() {   // bring the target into view (instant: no animation to wait for or to bother anyone)
      if (!target || !target.getBoundingClientRect) return;
      try {
        const r = target.getBoundingClientRect(), vh = window.innerHeight, want = mobile() ? 70 : 90;
        const fits = r.top >= want - 20 && r.bottom <= (mobile() ? vh * 0.58 : vh - 80);
        if (!fits) window.scrollBy(0, r.height > vh * 0.55 ? r.top - want : r.top - (mobile() ? want : (vh - r.height) / 2));
      } catch (e) {}
    }
    async function go(n) {
      const my = ++tok;
      const old = steps[i]; if (old && old.leave && n !== i && !(steps[n].show && steps[n].show === old.show)) click(old.leave);   // (the next step opening the same tab: stay there)
      i = n; const s = steps[i];
      if (s.show) { click(s.show); await wait(80); if (my !== tok) return; }
      target = s.target ? $(s.target) : null; if (target && !shown(target)) target = null;
      count.textContent = "Step " + (i + 1) + " of " + steps.length; title.textContent = s.title; text.textContent = s.text;
      prev.hidden = i === 0; next.textContent = i === steps.length - 1 ? "Done" : "Next";
      reveal(); place(); pop.focus({ preventScroll: true });
      setTimeout(() => { if (my === tok) { reveal(); place(); } }, 160);   // a late-rendering panel may change size
    }
    function close(reason) {
      if (closed) return; closed = true; tok++;
      const cur = steps[i]; if (cur && cur.leave) click(cur.leave);
      (opts.cleanup || []).forEach(click);
      document.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      root.remove(); try { back && back.focus && back.focus({ preventScroll: true }); } catch (e) {}
      if (opts.onClose) { try { opts.onClose(reason); } catch (e) {} }
    }
    const doNext = () => (i >= steps.length - 1 ? close("done") : go(i + 1)), doBack = () => { if (i > 0) go(i - 1); };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close("esc"); }
      else if (e.key === "ArrowRight") { e.preventDefault(); doNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); doBack(); }
      else if (e.key === "Tab") {   // keep focus inside the box
        const f = [skip, prev, next].filter((b) => !b.hidden), a = document.activeElement, first = f[0], last = f[f.length - 1];
        if (!root.contains(a) || a === pop) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      }
    }
    skip.onclick = () => close("skip"); next.onclick = doNext; prev.onclick = doBack;
    document.addEventListener("keydown", onKey, true); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    go(0);
    return { close, next: doNext, back: doBack, root, steps, ready: () => wait(0) };
  };

  // ---------- the entry point the portal calls ----------
  // CLA.startTour({A, me, kind, base, ver, auto}) -> the running tour (or null when there is nothing to show)
  CLA.startTour = function (o) {
    const css = document.getElementById("claTourCss");
    if (!css) { const l = document.createElement("link"); l.rel = "stylesheet"; l.id = "claTourCss"; l.href = (o.base || "") + "tour.css" + (o.ver ? "?v=" + o.ver : ""); document.head.appendChild(l); }
    const steps = CLA.tourSteps(o.kind, o.me);
    return CLA.runTour(steps, {
      returnFocus: o.returnFocus || document.getElementById("claTourLink") || document.activeElement,
      cleanup: o.kind === "admin" ? ['#tabs button[data-i="0"]'] : o.kind === "rep" ? ['#tabs button[data-i="0"]'] : o.kind === "calculator" ? [steps.restore || (() => {})] : [],
      onClose: async (reason) => {
        if (o.me && o.me.tourSeenAt === null && o.A && o.A.markTourSeen) {
          try { await o.A.markTourSeen(); o.me.tourSeenAt = new Date().toISOString(); } catch (e) {}   // not fatal: replay is always available
        }
      },
    });
  };
})();

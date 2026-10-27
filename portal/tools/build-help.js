// Builds the two Help pages from their content files and the pictures in portal/help/client and portal/help/staff:
//   portal/help.html        the CLIENT guide  (tools/client-content.js)  - for realtors and lenders; clients only ever get this one
//   portal/staff-help.html  the STAFF manual  (tools/help-content.js)    - everyone + reps + admins sections; clients are sent to help.html
// usage: node portal/tools/build-help.js        (then commit both pages). Pictures: screenshots_help.py + optimize_help_images.py (mock data only).
// Pictures: help/client/ holds ONLY client-appropriate pictures (taken as a guest or a client); help/staff/ holds the staff-only ones.
// The client page may only use help/client/ (the build stops otherwise); the staff manual may use both.
// HONEST NOTE: these are static files, so anyone who knows the URL can fetch them. The sign-in guard in each page decides what a signed-in person sees
// on screen; it is not access control. Neither page contains a key, a secret or customer data (the pictures use made-up sample people).
const fs = require("fs"), path = require("path");
const staff = require("./help-content.js"), client = require("./client-content.js");
const ROOT = path.join(__dirname, ".."), CDIR = path.join(ROOT, "help", "client"), SDIR = path.join(ROOT, "help", "staff");
const V = "20261027h", UPDATED = "Oct 27, 2026";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const AUD = { E: "Everyone", R: "Reps", A: "Admins" };
const dims = (file) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const usedClient = new Set(), usedStaff = new Set();

function blocks(bl, clientOnly) {
  let o = "";
  for (const b of bl) {
    if (b.t === "p") o += `<p>${inline(b.x)}</p>\n`;
    else if (b.t === "h3") o += `<h3>${inline(b.x)}</h3>\n`;
    else if (b.t === "note") o += `<div class="msg ${b.tone === "warning" ? "info" : "ok"} helpnote" role="note">${inline(b.x)}</div>\n`;
    else if (b.t === "ul") o += `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>\n`;
    else if (b.t === "ol") o += `<ol class="steps">${b.items.map(([t, d]) => `<li><b>${inline(t)}</b>${d ? `<span>${inline(d)}</span>` : ""}</li>`).join("")}</ol>\n`;
    else if (b.t === "table") o += `<div class="tablewrap"><table><thead><tr>${b.cols.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<${i ? "td" : "th scope=\"row\""}>${inline(c)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</tbody></table></div>\n`;
    else if (b.t === "img") {
      let dir = "client";   // a picture in help/client is client-safe; the staff manual may also use help/staff
      if (!fs.existsSync(path.join(CDIR, b.f))) { if (clientOnly) throw new Error("client guide uses a picture that is not in help/client: " + b.f); dir = "staff"; }
      const file = path.join(dir === "client" ? CDIR : SDIR, b.f); if (!fs.existsSync(file)) throw new Error("missing picture " + dir + "/" + b.f);
      (dir === "client" ? usedClient : usedStaff).add(b.f); const [w, h] = dims(file);
      o += `<figure class="shot"><img src="help/${dir}/${b.f}" alt="${esc(b.alt)}" width="${w}" height="${h}" loading="lazy"><figcaption>${inline(b.cap)}</figcaption></figure>\n`;
    }
  }
  return o;
}
const head = (title, extraCss) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — C.L.A. Quote Portal</title>
<meta name="theme-color" content="#000000"><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="portal.css">
<link rel="stylesheet" href="help/help.css?v=${V}">${extraCss ? `\n<link rel="stylesheet" href="${extraCss}?v=${V}">` : ""}
<script src="config.js"></script>
<script src="js/mock-data.js"></script><script src="js/mock-adapter.js"></script><script src="js/supabase-adapter.js"></script><script src="js/auth-adapter.js"></script><script src="js/portal-ui.js"></script>
</head><body>
`;
const foot = `<footer class="disc"><p>Estimates only, not a Loan Estimate, Closing Disclosure, or commitment to insure. Contact C.L.A. Title &amp; Escrow for a binding quote.</p></footer>\n`;

// ---------------- client guide ----------------
function clientPage() {
  const toc = client.S.map((s) => `<li><a href="#${s.id}">${s.n}. ${esc(s.title)}</a></li>`).join("\n");
  const body = client.S.map((s) => `<section class="card help-sec" id="${s.id}" aria-labelledby="${s.id}-h">
<div class="hsh"><h2 id="${s.id}-h"><span class="num">${s.n}</span>${esc(s.title)}</h2></div>
<p class="lead">${inline(s.intro)}</p>
${blocks(s.blocks, true)}<p class="totop noprint"><a href="#top">Back to top</a></p>
</section>`).join("\n");
  return head("Help", "") + `<main class="pg help" id="top" hidden>
<!-- GENERATED by portal/tools/build-help.js from portal/tools/client-content.js. Edit that file, not this one. -->
<h1 class="pt">Help for realtors and lenders</h1>
<p class="sub">How to use the CLA closing cost calculator and your saved quotes. Last updated ${UPDATED}. Use your browser's Find (Ctrl+F or Cmd+F) to search this page.</p>
<nav class="card toc" aria-label="Contents"><h2>Contents</h2><ol id="tocList">
${toc}
</ol></nav>
${body}
</main>
${foot}<script>
(async () => { await CLA.boot(null); document.getElementById("top").hidden = false; })();   // signed-in guard: signed-out visitors go to the sign-in page and come back here
</script></body></html>
`;
}

// ---------------- staff manual ----------------
function staffPage() {
  const all = staff.S.concat([{ id: "needs", n: "", title: "Needs confirming", aud: "A", intro: "Open questions for John Coester. Until they are answered, treat the related statements above with care.", blocks: [{ t: "ul", items: staff.NEEDS }] }]);
  const toc = all.map((s) => `<li data-aud="${s.aud}"><a href="#${s.id}">${s.n ? s.n + ". " : ""}${esc(s.title)}</a> <span class="badge aud${s.aud}">${AUD[s.aud]}</span></li>`).join("\n");
  const body = all.map((s) => `<section class="card help-sec" id="${s.id}" data-aud="${s.aud}" aria-labelledby="${s.id}-h">
<div class="hsh"><h2 id="${s.id}-h">${s.n ? `<span class="num">${s.n}</span>` : ""}${esc(s.title)}</h2><span class="badge aud${s.aud}">For ${s.aud === "E" ? "everyone" : s.aud === "R" ? "reps" : "admins"}</span></div>
<p class="lead">${inline(s.intro)}</p>
${blocks(s.blocks, false)}<p class="totop noprint"><a href="#top">Back to top</a></p>
</section>`).join("\n");
  return head("Staff manual", "help/staff.css") + `<main class="pg help" id="top" hidden>
<!-- GENERATED by portal/tools/build-help.js from portal/tools/help-content.js. Edit that file, not this one. -->
<!-- Static pages can be fetched by anyone who knows the URL. The guard below decides what a signed-in person sees on screen (clients are sent to the client guide); it is not access control. This manual holds no keys, secrets or customer data. -->
<h1 class="pt">Staff manual</h1>
<p class="sub">CLA Quote Portal &amp; Calculator, for reps and admins. Last updated ${UPDATED}. Use your browser's Find (Ctrl+F or Cmd+F) to search this page. The pictures use made-up sample data.</p>
<p class="clientlink noprint"><a class="btn o sm" id="clientGuideLink" href="help.html">See what clients see: the client guide</a></p>
<div class="seg noprint" id="audSeg" role="group" aria-label="Show sections for" hidden></div>
<nav class="card toc" aria-label="Contents"><h2>Contents</h2><ol id="tocList">
${toc}
</ol></nav>
${body}
</main>
${foot}<script>
(async () => {
  const { $ } = CLA; const { me } = await CLA.boot(null);   // signed-in guard: signed-out visitors go to the sign-in page and come back here
  // Staff only: a client who opens this page is sent to the client guide (the page stays hidden until then).
  if (!CLA.isStaff(me)) { location.replace("help.html"); return; }
  // Who sees which sections: reps (and admins who also work as a rep) read Everyone + Reps; admins and super admins read everything.
  const allowed = CLA.isAdmin(me) ? ["E", "R", "A"] : ["E", "R"];
  const names = { E: "Everyone", R: "Reps", A: "Admins" };
  const secs = [...document.querySelectorAll(".help-sec")], toc = [...document.querySelectorAll("#tocList li")];
  let view = "mine";
  function apply() {
    const show = (a) => (view === "all" ? true : view === "mine" ? allowed.includes(a) : a === view);
    secs.concat(toc).forEach((el) => { el.hidden = !(allowed.includes(el.dataset.aud) ? show(el.dataset.aud) : false); });
    document.querySelectorAll("#audSeg button").forEach((b) => { b.classList.toggle("on", b.dataset.v === view); b.setAttribute("aria-pressed", b.dataset.v === view); });
  }
  const seg = $("audSeg"); seg.hidden = false;
  seg.innerHTML = [["mine", "My sections"]].concat(allowed.map((a) => [a, names[a]])).map((x) => '<button type="button" data-v="' + x[0] + '">' + x[1] + "</button>").join("");
  seg.onclick = (e) => { const b = e.target.closest("button"); if (b) { view = b.dataset.v; apply(); } };
  apply(); document.getElementById("top").hidden = false;
  // a link to a section that is currently filtered out still works: show it
  const reveal = () => { const id = decodeURIComponent(location.hash.slice(1)), t = id && document.getElementById(id); if (t && t.hidden && allowed.includes(t.dataset.aud)) { view = "all"; apply(); t.scrollIntoView(); } };
  window.addEventListener("hashchange", reveal); reveal();
})();
</script></body></html>
`;
}

const c = clientPage(), s = staffPage();
fs.writeFileSync(path.join(ROOT, "help.html"), c); fs.writeFileSync(path.join(ROOT, "staff-help.html"), s);
const list = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".png"));
const strayC = list(CDIR).filter((f) => !usedClient.has(f) && !usedStaff.has(f)), strayS = list(SDIR).filter((f) => !usedStaff.has(f));
console.log("help.html", c.length, "bytes (", usedClient.size, "client pictures );", "staff-help.html", s.length, "bytes (", usedStaff.size, "staff-only +", [...usedClient].length, "shared );", strayC.concat(strayS).length ? "UNUSED: " + strayC.concat(strayS).join(", ") : "no unused pictures");

"""Screenshots of the CALCULATOR guided tour (index.html; demo / mock mode). Usage:
  /workspace/design-preview/.venv/bin/python portal/tools/screenshots_calculator_tour.py [outdir]
Serves the repo on a local port, always in MOCK mode (no Supabase), and drives Chrome with Playwright. Nothing leaves the machine: requests to other
hosts are blocked, and the team fee sheet (Google Sheets) is answered from the built-in snapshot (fee-snapshot.js), so the preview shows normal numbers."""
import http.server, socketserver, threading, sys, os, functools, json, subprocess, csv, io, re
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/portal-preview/calculator-tour"
os.makedirs(OUT, exist_ok=True)
PORT = 8767
SNAP = json.loads(subprocess.check_output(["node", "-e", 'global.window=global;eval(require("fs").readFileSync("fee-snapshot.js","utf8")+";console.log(JSON.stringify(CLA_FEES_SNAPSHOT))")'], cwd=ROOT))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):   # always MOCK mode, whatever portal/config.js says
        if self.path.split("?")[0].endswith("/portal/config.js"):
            body = b'window.CLA_PORTAL_CONFIG = { mode: "mock" };'
            self.send_response(200); self.send_header("Content-Type", "application/javascript"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}/"
errors = []

def route(r):
    u = r.request.url
    if u.startswith(B): return r.continue_()
    m = re.search(r"docs.google.com/.*sheet=([^&]+)", u)
    if m:
        from urllib.parse import unquote
        rows = SNAP.get(unquote(m.group(1)))
        if rows:
            buf = io.StringIO(); csv.writer(buf).writerows(rows)
            return r.fulfill(status=200, content_type="text/csv", body=buf.getvalue())
    return r.abort()

def snap(page, name, full=False, clip=None):
    page.wait_for_timeout(450); page.screenshot(path=f"{OUT}/{name}.png", full_page=full, clip=clip); print("saved", name)

def walk(page, prefix, picks):
    """press Next through the tour; save the steps listed in `picks` (1-based). Prints each step's counter + title. Returns the step count."""
    total = int(page.text_content("#claTourCount").split(" of ")[1])
    for n in range(1, total + 1):
        page.wait_for_timeout(300)
        print(prefix, page.text_content("#claTourCount"), "|", page.inner_text("#claTourTitle"), "| mode:", page.eval_on_selector("#modes button.on", "b=>b.dataset.mode"))
        if n in picks: snap(page, f"{prefix}-step{n:02d}")
        if n < total: page.click("#claTourNext")
    return total

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=800):
        ctx = br.new_context(viewport={"width": w, "height": h}); ctx.route("**/*", route); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "ERR_FAILED" not in m.text and "Failed to load resource" not in m.text and errors.append("console " + m.text))
        return ctx, pg
    def open_calc(pg):
        pg.goto(B + "index.html"); pg.wait_for_function("document.getElementById('srcPill').textContent.indexOf('Loading')<0"); pg.wait_for_timeout(500)
        # the built-in snapshot only has active title rates for FL and DC, so use a Miami ZIP to get a full, realistic estimate on screen
        pg.fill("#addr", "123 Main St"); pg.fill("#city", "Miami"); pg.fill("#zip", "33101"); pg.wait_for_timeout(300)
    def login(pg, email):
        pg.goto(B + "portal/login.html"); pg.wait_for_selector("#email"); pg.fill("#email", email); pg.fill("#pw", "demo-password"); pg.click("#go"); pg.wait_for_url("**/*.html*", timeout=5000); pg.wait_for_load_state("networkidle")

    for label, w, h in (("desktop", 1280, 860), ("mobile", 390, 800)):
        # ---- GUEST, first visit: the chip, the header link, then the tour from the chip ----
        ctx, pg = newpage(w, h); open_calc(pg)
        print(label, "chip visible:", pg.is_visible("#claTourChip"))
        snap(pg, f"guest-{label}-chip")
        snap(pg, f"guest-{label}-header-take-the-tour-link", clip={"x": 0, "y": 0, "width": w, "height": 150 if w > 600 else 250})
        pg.click("#claTourChipGo"); pg.wait_for_selector("#claTour")
        print(label, "chip after start:", pg.is_visible("#claTourChip"))
        picks = {1, 2, 4, 6, 9, 11} if label == "desktop" else {1, 4, 8, 9, 11}
        total = walk(pg, f"guest-{label}", picks); pg.click("#claTourNext"); pg.wait_for_timeout(300)
        print(label, "tour gone after Done:", pg.locator("#claTour").count() == 0, "| mode restored:", pg.eval_on_selector("#modes button.on", "b=>b.dataset.mode"))
        pg.reload(); pg.wait_for_selector("#claTourChip", state="attached"); print(label, "chip after reload (should be hidden):", pg.is_visible("#claTourChip")); ctx.close()

    # ---- GUEST who started on the Seller Net Sheet: their tab comes back ----
    ctx, pg = newpage(1280, 860); open_calc(pg); pg.click('#modes button[data-mode="seller"]'); pg.click("#claCalcTourLink"); pg.wait_for_selector("#claTour")
    total = int(pg.text_content("#claTourCount").split(" of ")[1])
    for _ in range(total - 1): pg.click("#claTourNext"); pg.wait_for_timeout(120)
    pg.click("#claTourNext"); pg.wait_for_timeout(300); print("started on seller; mode after tour:", pg.eval_on_selector("#modes button.on", "b=>b.dataset.mode")); ctx.close()

    # ---- SIGNED IN staff (rep Jane): save + feedback bubble steps ----
    ctx, pg = newpage(1280, 860); login(pg, "sample.rep.jane@clatitle.com"); open_calc(pg); pg.wait_for_selector("#claFeedbackLink"); pg.wait_for_selector("#claSave_quote")
    snap(pg, "signed-in-staff-desktop-header-take-the-tour-link", clip={"x": 0, "y": 0, "width": 1280, "height": 220})
    pg.click("#claCalcTourLink"); pg.wait_for_selector("#claTour")
    total = walk(pg, "signed-in-staff-desktop", {12, 13}); print("signed-in total steps:", total); ctx.close()
    # ---- SIGNED IN client (no feedback bubble) ----
    ctx, pg = newpage(1280, 860); login(pg, "sam.agent@example.com"); open_calc(pg); pg.wait_for_selector("#claSave_quote"); pg.click("#claCalcTourLink"); pg.wait_for_selector("#claTour")
    print("client total steps:", walk(pg, "signed-in-client-desktop", set())); ctx.close()
    br.close()
print("script/console errors:", errors or "none"); srv.shutdown()

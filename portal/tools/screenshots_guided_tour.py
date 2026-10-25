"""Screenshots of the guided tour for each role (demo / mock mode; migration 14). Usage:
  /workspace/design-preview/.venv/bin/python portal/tools/screenshots_guided_tour.py [outdir]
Serves the repo on a local port (no network), always in MOCK mode, and drives Chrome with Playwright."""
import http.server, socketserver, threading, sys, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/portal-preview/guided-tour"
os.makedirs(OUT, exist_ok=True)
PORT = 8766
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
B = f"http://127.0.0.1:{PORT}/portal/"
errors = []

def login(page, email):
    page.goto(B + "login.html"); page.wait_for_selector("#email")
    page.fill("#email", email); page.fill("#pw", "demo-password"); page.click("#go"); page.wait_for_url("**/*.html*", timeout=5000)
    page.wait_for_load_state("networkidle")

def shot(page, name, full=True):
    page.wait_for_timeout(400); page.screenshot(path=f"{OUT}/{name}.png", full_page=full); print("saved", name)



def snap(page, name):
    page.wait_for_timeout(450); page.screenshot(path=f"{OUT}/{name}.png"); print("saved", name)

def walk(page, prefix, picks, total):
    """press Next through the tour; save the steps listed in `picks` (1-based). Prints each step's counter + title."""
    for n in range(1, total + 1):
        page.wait_for_timeout(250)
        print(prefix, page.inner_text("#claTourCount"), "|", page.inner_text("#claTourTitle"))
        if n in picks: snap(page, f"{prefix}-step{n:02d}")
        if n < total: page.click("#claTourNext")

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=800):
        ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
        return ctx, pg

    # ---- CLIENT (brand-new Nia): starts by itself ----
    ctx, pg = newpage(); login(pg, "sample.new.client@example.com"); pg.wait_for_selector("#claTour")
    walk(pg, "client-desktop", {1, 3, 5, 7}, 7); pg.click("#claTourNext"); pg.wait_for_timeout(300); print("seen after Done; tour gone:", pg.locator("#claTour").count() == 0)
    snap(pg, "client-desktop-after-done-take-the-tour-link"); ctx.close()
    ctx, pg = newpage(390, 800); login(pg, "sample.new.client@example.com"); pg.wait_for_selector("#claTour")
    walk(pg, "client-mobile", {1, 3, 5}, 7); ctx.close()

    # ---- REP (brand-new Riley) ----
    ctx, pg = newpage(); login(pg, "sample.new.rep@clatitle.com"); pg.wait_for_selector("#claTour")
    walk(pg, "rep-desktop", {1, 2, 3, 4, 5}, 6); ctx.close()
    ctx, pg = newpage(390, 800); login(pg, "sample.new.rep@clatitle.com"); pg.wait_for_selector("#claTour")
    walk(pg, "rep-mobile", {2, 4}, 6); ctx.close()

    # ---- SUPER ADMIN (Alex, replay via the header link) ----
    ctx, pg = newpage(1280, 860); login(pg, "sample.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.wait_for_timeout(300)
    snap(pg, "admin-header-take-the-tour-link"); pg.click("#claTourLink"); pg.wait_for_selector("#claTour")
    walk(pg, "super-admin-desktop", {1, 3, 5, 6, 7}, 7); ctx.close()
    # ---- ADMIN (Robin): feedback step reads 'only a super admin can approve' ----
    ctx, pg = newpage(1280, 860); login(pg, "sample.robin.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.click("#claTourLink"); pg.wait_for_selector("#claTour")
    walk(pg, "admin-desktop", {5, 6}, 6); ctx.close()
    ctx, pg = newpage(390, 800); login(pg, "sample.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.click("#claTourLink"); pg.wait_for_selector("#claTour")
    walk(pg, "super-admin-mobile", {2, 5}, 7); ctx.close()
    # ---- replay link from another page (profile) lands on the dashboard with the tour ----
    ctx, pg = newpage(); login(pg, "sam.agent@example.com"); pg.goto(B + "profile.html"); pg.wait_for_selector("#claTourLink"); pg.click("#claTourLink"); pg.wait_for_selector("#claTour", timeout=8000)
    print("from profile -> url:", pg.url.split("/")[-1], "| step:", pg.inner_text("#claTourCount")); ctx.close()
    br.close()
print("script/console errors:", errors or "none"); srv.shutdown()

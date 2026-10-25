"""Screenshots of the staff Feedback button, dialog and admin panel (demo / mock mode; migration 13). Usage:
  /workspace/design-preview/.venv/bin/python portal/tools/screenshots_staff_feedback.py [outdir]
Serves the repo on a local port (no network), always in MOCK mode, and drives Chrome with Playwright."""
import http.server, socketserver, threading, sys, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/portal-preview/staff-feedback"
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


CALC = f"http://127.0.0.1:{PORT}/index.html"
def clip(page, name, h=620):
    page.wait_for_timeout(350); page.screenshot(path=f"{OUT}/{name}.png", clip={"x": 0, "y": 0, "width": 1280, "height": h}); print("saved", name)

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=900):
        ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
        return ctx, pg

    # ---- as a REP (Jane): the header button, the dialog with John's greeting, the confirmation, her own list ----
    ctx, pg = newpage(); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#claFeedbackLink")
    clip(pg, "01-rep-header-feedback-button", 260)
    pg.click("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible"); pg.select_option("#claFbCat", "idea")
    pg.fill("#claFbMsg", "It would help to see the client's phone number on the quote list, so I can call them without opening each quote."); pg.wait_for_timeout(300)
    print("greeting:", pg.inner_text("#claFbHi"))
    pg.screenshot(path=f"{OUT}/02-rep-dialog-with-greeting.png"); print("saved 02")
    pg.click("#claFbSend"); pg.wait_for_selector("#claFbDone", state="visible"); pg.wait_for_timeout(400)
    pg.screenshot(path=f"{OUT}/03-rep-confirmation.png"); print("saved 03")
    # also a view as the rep: "Your feedback" with status
    pg.click("#claFbClose"); pg.click("#claFeedbackLink"); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{OUT}/04-view-as-rep-own-feedback-and-status.png"); print("saved 04")
    pg.click("#claFbCancel"); ctx.close()

    # ---- the calculator (index.html) for a rep ----
    ctx, pg = newpage(); login(pg, "sample.rep.jane@clatitle.com"); pg.goto(CALC); pg.wait_for_selector("#claFeedbackLink", timeout=8000); pg.wait_for_timeout(500)
    clip(pg, "05-calculator-header-feedback-button", 300); ctx.close()

    # ---- a CLIENT: no button ----
    ctx, pg = newpage(); login(pg, "sam.agent@example.com"); pg.wait_for_timeout(500)
    print("client sees feedback button:", pg.locator("#claFeedbackLink").count()); clip(pg, "06-client-no-feedback-button", 260); ctx.close()

    # ---- super admin: the Feedback panel with approve / dismiss ----
    ctx, pg = newpage(); login(pg, "sample.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.click("#tabs button:nth-child(5)"); pg.wait_for_selector("#fbRows tr"); pg.wait_for_timeout(300)
    shot(pg, "07-admin-panel-as-super-admin")
    pg.fill('#fbRows input[data-note="fb1"]', "Thanks! Fixed in the next release."); pg.click('#fbRows button[data-fb="fb1"][data-to="approved"]'); pg.wait_for_timeout(500)
    shot(pg, "08-admin-panel-after-approving"); ctx.close()

    # ---- an Admin: sees everything, read only ----
    ctx, pg = newpage(); login(pg, "sample.robin.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.click("#tabs button:nth-child(5)"); pg.wait_for_selector("#fbRows tr"); pg.wait_for_timeout(300)
    shot(pg, "09-admin-panel-as-admin-read-only"); ctx.close()
    # ---- narrow screen dialog ----
    ctx, pg = newpage(390, 800); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#claFeedbackLink"); pg.click("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/10-dialog-on-a-phone.png"); print("saved 10"); ctx.close()
    br.close()
print("script/console errors:", errors or "none"); srv.shutdown()

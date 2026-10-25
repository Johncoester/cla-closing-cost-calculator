"""Screenshots of the admin dashboard for the 'admin' role (demo / mock mode; migration 11: an Admin also manages other Admins). Usage:
  /workspace/design-preview/.venv/bin/python portal/tools/screenshots_admin_role.py [outdir]
Serves the repo on a local port (no network), always in MOCK mode, and drives Chrome with Playwright."""
import http.server, socketserver, threading, sys, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/portal-preview/admin-manage-admins"
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

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=900):
        ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
        return ctx, pg

    # ---- signed in as the demo ADMIN (Robin) ----
    ctx, pg = newpage(); login(pg, "sample.robin.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.wait_for_timeout(300)
    shot(pg, "01-as-admin-users")
    print("admin: role options in the invite form ->", end=" "); pg.click("#showInv"); print(pg.eval_on_selector_all("#iRole option", "o => o.map(x => x.value)"))
    pg.fill("#iEmail", "new.rep@clatitle.com"); shot(pg, "02-as-admin-invite-form-rep-and-client-only"); pg.click("#invCancel")
    # hover the greyed-out Disable button on the super admin's row: tooltip says why
    alex = pg.locator("#users tr", has_text="Alex Admin")
    alex.locator(".tip").last.hover(); pg.wait_for_timeout(250)
    pg.screenshot(path=f"{OUT}/03a-as-admin-super-admin-locked-tooltip.png", clip={"x": 0, "y": 0, "width": 1280, "height": 600}); print("saved 03")
    pg.mouse.move(5, 5); alex.locator("label.tip").hover(); pg.wait_for_timeout(250)
    pg.screenshot(path=f"{OUT}/04-as-admin-rep-switch-locked-tooltip.png", clip={"x": 0, "y": 0, "width": 1280, "height": 600}); print("saved 04")
    pg.mouse.move(5, 5)
    # migration 11: an Admin manages ANOTHER Admin (Casey): her Disable button is live, her role list is Admin / CLA rep / Client only (no way up)
    casey = pg.locator("#users tr", has_text="Casey Admin")
    print("admin viewing admin Casey: role options ->", casey.locator("select[data-role] option").evaluate_all("o => o.map(x => x.value)"), "| disable disabled:", casey.locator("button[data-st]").is_disabled())
    casey.locator("button[data-st]").click(); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{OUT}/03b-as-admin-disabled-another-admin.png", clip={"x": 0, "y": 0, "width": 1280, "height": 760}); print("saved 03b")
    pg.locator("#users tr", has_text="Casey Admin").locator("button[data-st]").click(); pg.wait_for_timeout(400)
    pg.click("#tabs button:nth-child(3)"); pg.wait_for_selector("#asgRows tr"); shot(pg, "05-as-admin-assignments")
    ctx.close()

    # ---- migration 12: "Move N realtors to..." when a rep who has clients is made a client ----
    ctx, pg = newpage(); login(pg, "sample.robin.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.wait_for_timeout(300)
    marcus = lambda: pg.locator("#users tr", has_text="sample.rep.marcus@clatitle.com")
    marcus().locator("select[data-role]").select_option("client"); pg.wait_for_selector(".dlg"); pg.wait_for_timeout(300)
    shot(pg, "06-picker-move-realtors-to", False)
    pg.click("#dlgNo"); pg.wait_for_timeout(300); print("cancel -> Marcus role is still:", marcus().locator("select[data-role]").input_value())
    shot(pg, "07-picker-cancelled-nothing-changed", False)
    marcus().locator("select[data-role]").select_option("client"); pg.wait_for_selector(".dlg"); pg.select_option("#dlgRep", label=pg.eval_on_selector_all("#dlgRep option", "o => o.map(x => x.textContent)")[-1]); pg.click("#dlgOk"); pg.wait_for_timeout(700)
    shot(pg, "08-picker-confirmed-marcus-is-a-client", False)
    pg.click("#tabs button:nth-child(3)"); pg.wait_for_selector("#asgRows tr"); shot(pg, "09-assignments-after-move-history-kept")
    ctx.close()
    # no other eligible rep: say so
    ctx, pg = newpage(); login(pg, "sample.admin@clatitle.com"); pg.wait_for_selector("#users tr")
    pg.evaluate("""async () => { const A = await CLA.getAdapter(); const j = (await A.adminListUsers()).find(u => u.email.includes('rep.jane')); const a = (await A.adminListUsers()).find(u => u.email === 'sample.admin@clatitle.com');
      await A.adminSetIsRep(a.id, false, j.id); await A.adminSetStatus(j.id, 'disabled'); await A.signOut(); }""")
    pg.goto(B + "login.html"); pg.wait_for_selector("#email"); pg.fill("#email", "sample.robin.admin@clatitle.com"); pg.fill("#pw", "x"); pg.click("#go"); pg.wait_for_selector("#users tr"); pg.wait_for_timeout(300)
    pg.locator("#users tr", has_text="sample.rep.marcus@clatitle.com").locator("select[data-role]").select_option("client"); pg.wait_for_selector(".dlg"); pg.wait_for_timeout(300)
    shot(pg, "08b-picker-no-other-eligible-rep", False)
    ctx.close()

    # ---- signed in as the SUPER ADMIN (Alex) ----
    ctx, pg = newpage(); login(pg, "sample.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.wait_for_timeout(300)
    shot(pg, "10-as-super-admin-users")
    print("super admin: role options in the invite form ->", end=" "); pg.click("#showInv"); print(pg.eval_on_selector_all("#iRole option", "o => o.map(x => x.value)"))
    pg.select_option("#iRole", "admin"); pg.check("#iAlso"); pg.fill("#iEmail", "new.admin@clatitle.com"); shot(pg, "11-as-super-admin-invite-admin-form")
    pg.click("#inv button[type=submit]"); pg.wait_for_timeout(300); shot(pg, "12-as-super-admin-invite-admin-sent", False)
    ctx.close()
    # ---- a refused action, end to end: the admin tries nothing forbidden through the UI, but the engine refuses if forced ----
    ctx, pg = newpage(); login(pg, "sample.robin.admin@clatitle.com"); pg.wait_for_selector("#users tr")
    msg = pg.evaluate("""async () => { const A = await CLA.getAdapter(); try { await A.adminSetStatus('00000000-0000-4000-8000-0000000000a1', 'disabled'); return 'allowed?!'; } catch (e) { return e.message; } }""")
    print("forced call as admin ->", msg)
    ctx.close()
    br.close()
srv.shutdown()
print("ERRORS:", errors if errors else "none")

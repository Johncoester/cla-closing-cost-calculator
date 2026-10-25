"""Takes the portal preview screenshots (mock mode). Usage:
  /workspace/design-preview/.venv/bin/python portal/tools/screenshots.py [outdir]
Serves the repo on a local port (no network) and drives Chrome with Playwright."""
import http.server, socketserver, threading, sys, os, functools, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/portal-preview"
os.makedirs(OUT, exist_ok=True)
PORT = 8765
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
handler = functools.partial(Q, directory=ROOT)
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), handler)
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
    def newpage(w=1280, h=900, scale=1):
        ctx = br.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
        return ctx, pg

    # --- public screens ---
    ctx, pg = newpage()
    pg.goto(B + "login.html"); pg.wait_for_selector("#demos button"); pg.click("#demos button:nth-child(4)"); shot(pg, "01-login")
    pg.fill("#pw", ""); pg.click("#go"); pg.wait_for_timeout(200); shot(pg, "01b-login-error", False)
    pg.goto(B + "forgot.html"); pg.fill("#email", "sam.agent@example.com"); pg.click("#go"); shot(pg, "02-forgot-password")
    pg.goto(B + "set-password.html?invite=1"); pg.fill("#pw", "Longenough1Pass"); shot(pg, "03-accept-invite-set-password")
    ctx.close()
    ctx, pg = newpage(390, 800, 2); pg.goto(B + "login.html"); shot(pg, "01m-login-mobile"); ctx.close()

    # --- rep ---
    ctx, pg = newpage(); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#clients tr")
    pg.wait_for_timeout(300); shot(pg, "10-rep-dashboard")
    # invite form with a cell number typed (shows live formatting), then a bad one (validation message)
    pg.fill("#iEmail", "new.agent@brokerage.com"); pg.type("#iCell", "2405550177"); pg.locator("#inv").scroll_into_view_if_needed(); shot(pg, "13-rep-invite-form")
    pg.fill("#iCell", ""); pg.type("#iCell", "24055"); pg.locator("#iEmail").focus(); pg.wait_for_timeout(200); shot(pg, "13b-rep-invite-form-invalid-cell")
    pg.fill("#iCell", ""); pg.fill("#iEmail", ""); pg.locator("#iCell").blur(); pg.evaluate("window.scrollTo(0,0)")
    pg.click("#clients tr[data-i='0'] b"); pg.wait_for_selector("#dRows tr"); shot(pg, "11-rep-client-quotes")
    pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(600)   # the detail panel scrolls smoothly; let it finish
    pg.click("#tabs button:nth-child(2)"); pg.wait_for_selector("#qRows tr"); shot(pg, "12-rep-all-quotes")
    ctx.close()
    ctx, pg = newpage(390, 800, 2); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#clients tr"); shot(pg, "10m-rep-dashboard-mobile"); ctx.close()

    # --- client ---
    ctx, pg = newpage(); login(pg, "sam.agent@example.com"); pg.wait_for_selector("#rows tr"); pg.wait_for_timeout(300); shot(pg, "20-client-dashboard")
    pg.goto(B + "profile.html?welcome=1"); pg.wait_for_selector("#firstName"); shot(pg, "21-profile")
    # cell field: formats as typed; a bad number shows the validation message and blocks saving
    pg.fill("#cellPhone", ""); pg.type("#cellPhone", "24055"); pg.click("#firstName"); pg.wait_for_timeout(200); shot(pg, "21b-profile-cell-invalid")
    pg.click("#save"); pg.wait_for_timeout(200); print("bad cell save ->", pg.inner_text("#err"))
    pg.fill("#cellPhone", ""); pg.type("#cellPhone", "2405550199"); print("typed cell ->", pg.input_value("#cellPhone"))
    pg.click("#save"); pg.wait_for_selector("#ok:not(:empty)"); shot(pg, "21c-profile-cell-saved")
    pg.fill("#cellPhone", ""); pg.type("#cellPhone", "2405550132"); pg.click("#save"); pg.wait_for_timeout(200)
    # photo checks: bad type, too big, good
    d = tempfile.mkdtemp()
    open(d + "/x.gif", "wb").write(b"GIF89a" + b"0" * 2000)
    open(d + "/big.jpg", "wb").write(b"\xff\xd8\xff" + b"0" * (2 * 1024 * 1024 + 10))
    open(d + "/fake.jpg", "wb").write(b"MZ" + b"0" * 2000)
    pg.set_input_files("#file", d + "/x.gif"); pg.wait_for_timeout(300); print("gif ->", pg.inner_text("#pErr"))
    pg.set_input_files("#file", d + "/big.jpg"); pg.wait_for_timeout(300); print("big ->", pg.inner_text("#pErr"))
    pg.set_input_files("#file", d + "/fake.jpg"); pg.wait_for_timeout(300); print("fake ->", pg.inner_text("#pErr"))
    shot(pg, "22-profile-photo-rejected", False)
    # real small jpeg made by the browser itself
    data = pg.evaluate("""async()=>{const c=document.createElement('canvas');c.width=c.height=300;const x=c.getContext('2d');x.fillStyle='#8dc63f';x.fillRect(0,0,300,300);x.fillStyle='#222';x.beginPath();x.arc(150,120,60,0,7);x.fill();x.fillRect(60,200,180,100);
      return c.toDataURL('image/jpeg',0.9).split(',')[1]}""")
    import base64; open(d + "/ok.jpg", "wb").write(base64.b64decode(data))
    pg.set_input_files("#file", d + "/ok.jpg"); pg.wait_for_selector("#upload:not([hidden])"); shot(pg, "23-profile-photo-ready", False)
    pg.click("#upload"); pg.wait_for_selector("#pOk:not(:empty)"); shot(pg, "24-profile-photo-saved", False)
    ctx.close()

    # --- admin ---
    ctx, pg = newpage(); login(pg, "sample.admin@clatitle.com"); pg.wait_for_selector("#users tr"); pg.wait_for_timeout(300); shot(pg, "30-admin-users")
    pg.click("#showInv"); pg.select_option("#iRole", "client"); pg.fill("#iEmail", "new.agent@brokerage.com"); pg.type("#iCell", "7035550166"); shot(pg, "31-admin-invite")
    pg.click("#inv button[type=submit]"); pg.wait_for_timeout(300); shot(pg, "31b-admin-invite-sent", False)
    pg.click("#tabs button:nth-child(2)"); pg.wait_for_selector("#quotes tr"); shot(pg, "32-admin-quotes")
    pg.click("#tabs button:nth-child(3)"); pg.wait_for_selector("#asgRows tr"); shot(pg, "33-admin-assignments")
    pg.click("#tabs button:nth-child(4)"); pg.wait_for_selector("#auditRows tr"); shot(pg, "34-admin-audit-log")
    ctx.close()

    # --- calculator + saved-quote flow ---
    # guest first
    ctx, pg = newpage(1280, 900)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_selector("#claSave_quote"); pg.wait_for_timeout(500); shot(pg, "40-calculator-guest")
    pg.click("#claSave_quote"); pg.wait_for_url("**/login.html*"); print("guest save ->", pg.url)
    pg.fill("#email", "sam.agent@example.com"); pg.fill("#pw", "demo-password"); pg.click("#go"); pg.wait_for_url("**/quote-saved.html"); pg.wait_for_selector("#card:not([hidden])")
    shot(pg, "41-quote-saved-confirmation", False)
    # now signed in: calculator autosave + cobrand
    pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_selector("#claSave_quote"); pg.wait_for_selector("#claBrand")
    pg.fill("#price", "612500"); pg.fill("#addr", "88 Maple Ct"); pg.wait_for_selector("#claNote_quote:has-text('Saved to your account')", timeout=8000)
    pg.wait_for_timeout(400); shot(pg, "42-calculator-signed-in-autosaved")
    # saved quote viewer
    href = pg.get_attribute("#claNote_quote a", "href"); pg.goto(href); pg.wait_for_selector("#body:not([hidden])"); shot(pg, "43-saved-quote-cobranded")
    pg.pdf(path=f"{OUT}/43b-saved-quote-print.pdf", format="Letter", print_background=True)
    ctx.close()
    ctx, pg = newpage(390, 800, 2); login(pg, "sam.agent@example.com"); pg.goto(B + "client.html"); pg.wait_for_selector("#rows tr"); shot(pg, "20m-client-dashboard-mobile"); ctx.close()
    br.close()
srv.shutdown()
print("ERRORS:", errors if errors else "none")

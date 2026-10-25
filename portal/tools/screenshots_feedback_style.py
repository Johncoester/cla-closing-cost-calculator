"""Screenshots of the restyled staff feedback bubble + panel (mock mode). Usage:
  /workspace/design-preview/.venv/bin/python portal/tools/screenshots_feedback_style.py [outdir]
Serves the repo on a local port (no network), always in MOCK mode, and drives Chrome with Playwright."""
import http.server, socketserver, threading, sys, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/portal-preview/feedback-style"
os.makedirs(OUT, exist_ok=True)
PORT = 8767
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



MSG = "It would help to see the client's phone number on the quote list, so I can call them without opening each quote."
def snap(page, name, full=False):
    page.wait_for_timeout(450); page.screenshot(path=f"{OUT}/{name}.png", full_page=full); print("saved", name)

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=800, **kw):
        ctx = br.new_context(viewport={"width": w, "height": h}, **kw); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
        return ctx, pg

    # ---- desktop, as a rep ----
    ctx, pg = newpage(); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#claFeedbackLink")
    print("header has feedback button:", pg.locator("header #claFeedbackLink").count())
    pg.wait_for_timeout(1900)   # mid-pulse (starts 1.4s after load)
    snap(pg, "01-desktop-bubble-closed-bottom-right")
    pg.hover("#claFeedbackLink"); snap(pg, "01b-desktop-bubble-hover-tooltip")
    pg.mouse.move(600, 300)
    pg.click("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible"); print("focus on:", pg.evaluate("document.activeElement.id"))
    snap(pg, "02-desktop-panel-open")
    pg.click("label.claFbChip:has(#claFbKind_idea)"); pg.fill("#claFbMsg", MSG); snap(pg, "03-desktop-form-filled")
    pg.click("#claFbSend")
    pg.wait_for_selector("#claFbDone", state="visible"); pg.wait_for_timeout(900); snap(pg, "05-desktop-success")
    pg.click("#claFbClose"); pg.wait_for_selector("#claFb", state="hidden"); print("focus back on bubble:", pg.evaluate("document.activeElement.id"))
    # Esc + keyboard: open with Enter, Tab around, Esc closes
    pg.keyboard.press("Enter"); pg.wait_for_selector("#claFbHi", state="visible")
    seen = []
    for _ in range(12):
        pg.keyboard.press("Tab"); seen.append(pg.evaluate("document.activeElement.id || document.activeElement.className"))
    print("tab cycle stays in panel:", seen)
    pg.keyboard.press("Escape"); pg.wait_for_selector("#claFb", state="hidden"); print("after Esc focus:", pg.evaluate("document.activeElement.id"), "expanded:", pg.get_attribute("#claFeedbackLink", "aria-expanded"))
    ctx.close()

    # ---- loading state: slow the adapter call in the page ----
    ctx, pg = newpage(); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#claFeedbackLink"); pg.click("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible")
    pg.fill("#claFbMsg", MSG)
    pg.evaluate("""() => { const f = document.getElementById('claFbForm'); const real = f.onsubmit; f.onsubmit = null;
      f.addEventListener('submit', (e) => { e.preventDefault(); const s = document.getElementById('claFbSend'); s.disabled = true; s.classList.add('busy'); s.querySelector('.claFbSendTx').textContent = 'Sending…'; }, true); }""")
    pg.click("#claFbSend"); snap(pg, "04-desktop-send-loading-state"); ctx.close()

    # ---- the calculator page too (rep) ----
    ctx, pg = newpage(); login(pg, "sample.rep.jane@clatitle.com"); pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_selector("#claFeedbackLink", timeout=8000)
    snap(pg, "06-calculator-bubble"); pg.click("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible"); snap(pg, "06b-calculator-panel-open"); ctx.close()

    # ---- client: no bubble ----
    ctx, pg = newpage(); login(pg, "sam.agent@example.com"); pg.wait_for_timeout(700)
    print("client sees bubble:", pg.locator("#claFeedbackLink").count(), "panel:", pg.locator("#claFb").count()); ctx.close()

    # ---- phone (390 x 800, iPhone-like, with touch) ----
    ctx, pg = newpage(390, 800, has_touch=True, is_mobile=True, device_scale_factor=2); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#claFeedbackLink")
    snap(pg, "07-mobile-bubble-closed"); pg.tap("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible"); snap(pg, "08-mobile-bottom-sheet-open")
    pg.fill("#claFbMsg", MSG); pg.tap("label.claFbChip:has(#claFbKind_question)"); snap(pg, "09-mobile-form-filled")
    pg.tap("#claFbSend"); pg.wait_for_selector("#claFbDone", state="visible"); pg.wait_for_timeout(900); snap(pg, "10-mobile-success"); ctx.close()

    # ---- prefers-reduced-motion ----
    ctx, pg = newpage(reduced_motion="reduce"); login(pg, "sample.rep.jane@clatitle.com"); pg.wait_for_selector("#claFeedbackLink")
    print("reduced motion: bubble animation =", pg.evaluate("getComputedStyle(document.getElementById('claFeedbackLink')).animationName"), "| pulse =", pg.evaluate("getComputedStyle(document.getElementById('claFeedbackLink'),'::before').animationName"))
    pg.click("#claFeedbackLink"); pg.wait_for_selector("#claFbHi", state="visible"); print("panel animation =", pg.evaluate("getComputedStyle(document.querySelector('.claFbDlg')).animationName"))
    pg.keyboard.press("Escape"); print("hidden immediately on close:", pg.evaluate("document.getElementById('claFb').hidden")); ctx.close()
    br.close()
print("script/console errors:", errors or "none"); srv.shutdown()

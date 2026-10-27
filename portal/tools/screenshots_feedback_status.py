"""Screenshots of the feedback status updates (migration 17): the dot on the bubble, My suggestions in every status, and Mark shipped in the admin tab.
Usage: python3 portal/tools/screenshots_feedback_status.py [outdir]     (default /workspace/feedback-status-screens; needs Playwright + Chrome)
Serves THIS repo on a local port and ALWAYS answers portal/config.js with MOCK mode: fake demo people only, never the live site or Supabase."""
import http.server, threading, sys, os, functools
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/feedback-status-screens"
os.makedirs(OUT, exist_ok=True); PORT = 8853
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.split("?")[0].endswith("/portal/config.js"):
            b = b'window.CLA_PORTAL_CONFIG = { mode: "mock" };'; self.send_response(200); self.send_header("Content-Type", "application/javascript"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        return super().do_GET()
http.server.ThreadingHTTPServer.allow_reuse_address = True
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}/"; errs = []
def login(pg, email):
    pg.goto(B + "portal/login.html"); pg.wait_for_selector("#email"); pg.fill("#email", email); pg.fill("#pw", "demo-password"); pg.click("#go"); pg.wait_for_url("**/*.html*", timeout=5000); pg.wait_for_load_state("networkidle")
def dlg_clip(pg, pad=16):
    return pg.evaluate("p=>{const r=document.querySelector('.claFbDlg').getBoundingClientRect();return {x:Math.max(0,r.x-p),y:Math.max(0,r.y-p),width:r.width+2*p,height:r.height+2*p}}", pad)
with sync_playwright() as p:
    try: br = p.chromium.launch()
    except Exception: br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=900):
        ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); return ctx, pg
    # ---- the sender (Jane, a rep): dot -> panel -> dot cleared ----
    ctx, pg = newpage(1280, 1000); login(pg, "sample.rep.jane@clatitle.com"); pg.goto(B + "portal/rep.html"); pg.wait_for_selector("#claFbDot:not([hidden])"); pg.wait_for_timeout(900)
    if pg.locator("#claTour").count(): pg.keyboard.press("Escape")
    pg.screenshot(path=f"{OUT}/1-bubble-with-dot.png", clip={"x": 880, "y": 820, "width": 400, "height": 180}); print("saved 1")
    pg.click("#claFeedbackLink"); pg.wait_for_timeout(900)
    pg.screenshot(path=f"{OUT}/2-my-suggestions-panel.png", clip=dlg_clip(pg)); print("saved 2")
    pg.evaluate("()=>{const u=document.querySelector('#claFbMine ul');u.style.maxHeight='none';u.style.overflow='visible'}"); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('.claFbBody').scrollTop = 99999"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/3-my-suggestions-every-status.png", clip=dlg_clip(pg)); print("saved 3")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{OUT}/4-bubble-after-opening-dot-cleared.png", clip={"x": 880, "y": 820, "width": 400, "height": 180}); print("saved 4")
    ctx.close()
    # ---- another sender (Marcus): a shipped item, unread ----
    ctx, pg = newpage(1280, 1000); login(pg, "sample.rep.marcus@clatitle.com"); pg.goto(B + "portal/rep.html"); pg.wait_for_selector("#claFbDot:not([hidden])"); pg.wait_for_timeout(700)
    pg.click("#claFeedbackLink"); pg.wait_for_timeout(900); pg.evaluate("document.querySelector('.claFbBody').scrollTop = 99999"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/5-my-suggestions-marcus-shipped.png", clip=dlg_clip(pg)); print("saved 5")
    ctx.close()
    # ---- the super admin: Mark shipped on an approved item ----
    ctx, pg = newpage(1280, 900); login(pg, "sample.admin@clatitle.com"); pg.goto(B + "portal/admin.html"); pg.wait_for_selector("#users tr"); pg.wait_for_load_state("networkidle")
    if pg.locator("#claTour").count(): pg.keyboard.press("Escape")
    pg.click('#tabs button[data-i="4"]'); pg.wait_for_selector("#fbRows tr"); pg.wait_for_timeout(700)
    pg.fill('[data-ship-note="fb4"]', "Save as PDF is now a button in the calculator.")
    row = pg.locator("#fbRows tr", has=pg.locator('[data-ship-note="fb4"]')); row.scroll_into_view_if_needed(); pg.wait_for_timeout(300)
    main = pg.evaluate("()=>{const e=document.querySelector('#pFeedback');e.scrollIntoView();const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,420)}}"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/6-admin-feedback-tab.png", clip=main); print("saved 6")
    row.screenshot(path=f"{OUT}/7-admin-mark-shipped-before.png"); print("saved 7 (an approved item with What changed typed in)")
    row.locator('[data-to="shipped"]').click(); pg.wait_for_timeout(900)
    pg.locator("#fbRows tr", has_text="save a quote as a PDF").screenshot(path=f"{OUT}/8-admin-mark-shipped-after.png"); print("saved 8 (the same item after Mark shipped)")
    pg.select_option("#fStatus", "shipped"); pg.wait_for_timeout(500)
    main2 = pg.evaluate("()=>{const e=document.querySelector('#pFeedback');e.scrollIntoView();const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,520)}}")
    pg.screenshot(path=f"{OUT}/9-admin-filter-shipped.png", clip=main2); print("saved 9")
    ctx.close()
    br.close()
print("page errors:", errs or "none")

"""Screenshots for the delete-user feature and the Users-tab filters (admin Users tab, mock data only). Usage:
  python3 portal/tools/screenshots_delete_user.py [outdir]      (needs: pip install playwright; Google Chrome)
Serves THIS repo on a local port and ALWAYS answers portal/config.js with MOCK mode, so every picture is drawn from the fake demo data
(sample.* / example.com people). It never touches the live site or Supabase. Output: raw PNGs; run portal/tools/optimize_help_images.py after."""
import http.server, socketserver, threading, sys, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/delete-user-screens"
os.makedirs(OUT, exist_ok=True)
PORT = 8861
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):   # always MOCK mode, whatever portal/config.js says
        if self.path.split("?")[0].endswith("/portal/config.js"):
            body = b'window.CLA_PORTAL_CONFIG = { mode: "mock" };'
            self.send_response(200); self.send_header("Content-Type", "application/javascript"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()
http.server.ThreadingHTTPServer.allow_reuse_address = True
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}/"
errors = []

def login(pg, email):
    pg.goto(B + "portal/login.html"); pg.wait_for_selector("#email"); pg.fill("#email", email); pg.fill("#pw", "demo-password"); pg.click("#go")
    pg.wait_for_url("**/*.html*", timeout=5000); pg.wait_for_load_state("networkidle")

def doc_box(pg, sel):
    """bounding box of the first match in DOCUMENT coordinates (viewport box + scroll offset)"""
    return pg.evaluate("s=>{const e=document.querySelector(s);e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}}", sel)


def snap(pg, name, clip=None, fixed=False):
    pg.wait_for_timeout(450); path = f"{OUT}/{name}.png"
    if fixed: pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(200); pg.screenshot(path=path, clip=clip)
    else: pg.screenshot(path=path, full_page=True, clip=clip)
    print("saved", name)

def mainclip(pg, h=900):
    b = pg.evaluate("()=>{const r=document.querySelector('main.pg').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}}"); pg.evaluate("window.scrollTo(0,0)")
    return {"x": max(0, b["x"] - 14), "y": max(0, b["y"]), "width": b["width"] + 28, "height": min(b["height"], h)}

def dlgclip(pg):
    return pg.evaluate("()=>{const r=document.querySelector('.dlg').getBoundingClientRect();return {x:Math.max(0,r.x-24),y:Math.max(0,r.y-24),width:r.width+48,height:r.height+48}}")

def disable(pg, uid):
    pg.once("dialog", lambda d: d.accept()); pg.click(f'[data-st="{uid}"]'); pg.wait_for_timeout(500)
    if pg.locator(".dlg").count() and pg.locator("#dlgNo").count(): pg.click("#dlgNo")

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    ctx = br.new_context(viewport={"width": 1440, "height": 1300}); ctx.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='.demo,.toast{display:none!important}';document.head.appendChild(s)})")
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    login(pg, "sample.admin@clatitle.com")
    if pg.locator("#claTour").count(): pg.keyboard.press("Escape")
    pg.wait_for_selector("#users tr"); pg.wait_for_timeout(400); pg.add_style_tag(content="main.pg{max-width:1400px!important}")
    snap(pg, "admin-users", clip=mainclip(pg, 1250))                      # all users, filters visible, nothing filtered
    uid = lambda k: "00000000-0000-4000-8000-0000000000" + k
    pg.evaluate("document.getElementById('uStatus').value='';")
    disable(pg, uid("b3"))                                                  # Riley (new rep) disabled too, so there are two Delete buttons
    snap(pg, "01-users-tab-delete-buttons", clip=mainclip(pg, 1250))
    # confirm dialog for a client (Dee), half typed
    pg.click(f'[data-del="{uid("c4")}"]'); pg.wait_for_selector("#delDlg"); pg.fill("#delConfirm", "dee.disabled@exa")
    snap(pg, "02-delete-dialog-client", clip=dlgclip(pg), fixed=True)
    pg.fill("#delConfirm", "dee.disabled@example.com"); snap(pg, "02b-delete-dialog-ready", clip=dlgclip(pg), fixed=True); pg.click("#delNo")
    # a disabled rep who still has clients: choose the successor
    disable(pg, uid("b2")); pg.click(f'[data-del="{uid("b2")}"]'); pg.wait_for_selector("#delDlg"); pg.fill("#delConfirm", "sample.rep.marcus@clatitle.com")
    snap(pg, "03-delete-dialog-rep-successor", clip=dlgclip(pg), fixed=True); pg.click("#delNo")
    # filters
    pg.select_option("#uRole", "rep"); snap(pg, "04-filter-role-rep", clip=mainclip(pg, 900))
    pg.select_option("#uRole", ""); pg.select_option("#uStatus", "disabled"); snap(pg, "05-filter-status-disabled", clip=mainclip(pg, 700))
    pg.select_option("#uStatus", ""); pg.select_option("#uRole", "client"); pg.fill("#uSearch", "realty"); snap(pg, "06-filter-role-and-search", clip=mainclip(pg, 700))
    pg.fill("#uSearch", "zzzz"); snap(pg, "07-filter-no-match", clip=mainclip(pg, 500))
    ctx.close(); br.close()
print("page errors:", errors or "none")

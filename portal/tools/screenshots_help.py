"""Screenshots for portal/help.html (the in-portal user manual). Usage:
  python3 portal/tools/screenshots_help.py [outdir]      (needs: pip install playwright; Google Chrome)
Serves THIS repo on a local port and ALWAYS answers portal/config.js with MOCK mode, so every picture is drawn from the fake demo data
(sample.* / example.com people). It never touches the live site or Supabase. Output: raw PNGs; run portal/tools/optimize_help_images.py after."""
import http.server, socketserver, threading, sys, os, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/help-shots-raw"
os.makedirs(OUT, exist_ok=True)
PORT = 8847
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

MASK = False
MASK_JS = """()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const t=n.nodeValue;if(/\\$\\s?\\d/.test(t))n.nodeValue=t.replace(/\\$\\s?[\\d,]+(\\.\\d+)?/g,m=>m.replace(/\\d/g,"0"))}}"""
def snap(pg, name, sel=None, pad=12, clip=None, fixed=False):
    """clip = document coordinates (full-page shot). fixed=True: the picture is of something fixed on the screen (bubble, dialog, tour); the page is scrolled to the top and clip is in viewport coordinates."""
    pg.wait_for_timeout(450)
    if MASK: pg.evaluate(MASK_JS)   # client / guest pictures: every dollar figure becomes zeros (no amounts in the client guide)
    path = f"{OUT}/{name}.png"
    if sel:
        b = doc_box(pg, sel); clip = {"x": max(0, b["x"] - pad), "y": max(0, b["y"] - pad), "width": min(b["width"] + 2 * pad, 1440), "height": b["height"] + 2 * pad}
    if fixed:
        pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(200); pg.screenshot(path=path, clip=clip)
    elif clip: pg.screenshot(path=path, full_page=True, clip=clip)
    else: pg.screenshot(path=path, full_page=True)
    print("saved", name)

def union(pg, sels, pad=12):
    bs = [doc_box(pg, s) for s in sels]
    x0 = min(b["x"] for b in bs); y0 = min(b["y"] for b in bs); x1 = max(b["x"] + b["width"] for b in bs); y1 = max(b["y"] + b["height"] for b in bs)
    return {"x": max(0, x0 - pad), "y": max(0, y0 - pad), "width": min(x1 - x0 + 2 * pad, 1400), "height": y1 - y0 + 2 * pad}

def mainclip(pg, h=900, top=0):
    """clip over the page's content column (main.pg), from `top` px above/below its top edge, at most h tall; the nav header is included when top=-hdr"""
    b = doc_box(pg, "main.pg"); pg.evaluate("window.scrollTo(0,0)")
    return {"x": max(0, b["x"] - 14), "y": max(0, b["y"] + top), "width": b["width"] + 28, "height": min(b["height"] - top, h)}

def hdrclip(pg, h=130):
    """the black header bar and the demo banner under it, full width"""
    w = pg.evaluate("document.documentElement.clientWidth"); return {"x": 0, "y": 0, "width": w, "height": h}

def calc(pg, zip_="20850", addr="123 Main St", city="Rockville"):
    pg.goto(B + "index.html"); pg.wait_for_function("document.getElementById('srcPill').textContent.indexOf('Loading')<0"); pg.wait_for_timeout(600)
    pg.fill("#addr", addr); pg.fill("#city", city); pg.fill("#zip", zip_); pg.wait_for_timeout(500)

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
    def newpage(w=1280, h=900):
        ctx = br.new_context(viewport={"width": w, "height": h}); ctx.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='.demo{display:none!important}';document.head.appendChild(s)})"); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        return ctx, pg

    # ---- sign-in page (guest) ----
    ctx, pg = newpage(1100, 800); pg.goto(B + "portal/login.html"); pg.wait_for_selector("#email")
    pg.fill("#email", "agent@example.com"); snap(pg, "login", clip={"x": 0, "y": 0, "width": 1100, "height": 560}); 
    pg.goto(B + "portal/forgot.html"); pg.wait_for_selector("#email"); pg.fill("#email", "agent@example.com"); pg.click("#go"); pg.wait_for_timeout(400)
    snap(pg, "forgot", clip={"x": 0, "y": 0, "width": 1100, "height": 480}); ctx.close()

    # ---- calculator as a guest: inputs, results, seller net sheet ----
    MASK = True
    ctx, pg = newpage(1280, 900); calc(pg)
    snap(pg, "calc-inputs", clip={"x": 0, "y": 0, "width": 1280, "height": 820}, fixed=True)
    snap(pg, "calc-results", clip=union(pg, [".hero", "#ledger", ".foot"]))
    snap(pg, "calc-top", clip={"x": 0, "y": 0, "width": 1280, "height": 330}, fixed=True)
    pg.click('#modes button[data-mode="seller"]'); pg.wait_for_timeout(500)
    snap(pg, "calc-seller", clip=union(pg, ["#mainS .col.in", "#mainS .col.out"]))
    ctx.close()

    # ---- rep with special pricing (Jane: MD+VA 900 / 500): staff picture only, never masked ----
    MASK = False
    ctx, pg = newpage(1280, 900); login(pg, "sample.rep.jane@clatitle.com"); calc(pg)
    pg.wait_for_selector("#claSave_quote"); pg.wait_for_selector("[data-special]")
    fb = doc_box(pg, "#fees"); snap(pg, "rep-calc-special-fees", clip={"x": max(0, fb["x"] - 16), "y": max(0, fb["y"] - 56), "width": fb["width"] + 32, "height": 560})
    # change something so the quote auto-saves, then show the saved note
    pg.fill("#price", "525000"); pg.wait_for_timeout(3600)
    snap(pg, "rep-calc-saved", clip=union(pg, [".foot"], pad=20))
    snap(pg, "rep-calc-cobrand", clip={"x": 0, "y": 0, "width": 1280, "height": 270}, fixed=True)
    # feedback bubble: closed and open
    pg.evaluate("window.scrollTo(0,0)"); snap(pg, "feedback-bubble", clip={"x": 780, "y": 540, "width": 500, "height": 360}, fixed=True)
    pg.click("#claFeedbackLink"); pg.wait_for_timeout(700); pg.fill("#claFbMsg", "Example: the print view cuts off the footer on my laptop."); 
    snap(pg, "feedback-open", clip={"x": 820, "y": 90, "width": 460, "height": 810}, fixed=True)
    pg.keyboard.press("Escape")
    # rep dashboard
    pg.goto(B + "portal/rep.html"); pg.wait_for_selector("#clients tr"); pg.wait_for_load_state("networkidle")
    if pg.locator("#claTour").count(): pg.keyboard.press("Escape")
    snap(pg, "rep-dashboard", clip=mainclip(pg, 1000))
    pg.click('#tabs button[data-i="1"]'); pg.wait_for_timeout(600)
    snap(pg, "rep-quotes", sel="#pQuotes")
    pg.click('#tabs button[data-i="0"]'); pg.fill("#iEmail", "new.agent@example.com"); pg.fill("#iCell", "2405550142")
    snap(pg, "rep-invite", sel="#pClients section[data-tour='r-invite']")
    ctx.close()

    MASK = True
    # ---- client (Sam, Jane's client): header, dashboard, calculator while signed in, quote view, profile ----
    ctx, pg = newpage(1280, 900); login(pg, "sam.agent@example.com")
    if pg.locator("#claTour").count(): pg.keyboard.press("Escape")
    hb = pg.evaluate("document.querySelector('header.top').getBoundingClientRect().bottom")
    snap(pg, "client-header", clip={"x": 70, "y": 0, "width": 1140, "height": hb + 2}, fixed=True)
    snap(pg, "client-dashboard", clip=mainclip(pg, 640))
    calc(pg); pg.wait_for_selector("#claSave_quote")
    pg.fill("#price", "525000"); pg.wait_for_timeout(3600)
    snap(pg, "calc-saved", clip=union(pg, [".foot"], pad=20))
    snap(pg, "calc-cobrand", clip={"x": 0, "y": 0, "width": 1280, "height": 270}, fixed=True)
    pg.goto(B + "portal/quote.html?id=00000000-0000-4000-8000-0000000000f01"); pg.wait_for_selector("#body:not([hidden])"); pg.wait_for_timeout(500)
    snap(pg, "quote-view", clip=mainclip(pg, 900))
    pg.goto(B + "portal/profile.html"); pg.wait_for_selector("#firstName"); pg.wait_for_timeout(500)
    snap(pg, "profile", sel="section.card", pad=14)
    h3 = doc_box(pg, "section.card:nth-of-type(2) h3"); cd = doc_box(pg, "section.card:nth-of-type(2)")   # the Company part only: the hints above it are for staff eyes too
    snap(pg, "profile-company", clip={"x": cd["x"], "y": h3["y"] - 14, "width": cd["width"], "height": cd["y"] + cd["height"] - (h3["y"] - 14)})
    ctx.close()

    # ---- guided tour (new client Nia: starts by itself) ----
    ctx, pg = newpage(1280, 900); login(pg, "sample.new.client@example.com"); pg.wait_for_selector("#claTour"); pg.wait_for_timeout(500)
    snap(pg, "tour-client-step1", clip={"x": 0, "y": 0, "width": 1280, "height": 760}, fixed=True)
    pg.click("#claTourNext"); pg.click("#claTourNext"); pg.wait_for_timeout(500)
    snap(pg, "tour-client-step3", clip={"x": 0, "y": 0, "width": 1280, "height": 760}, fixed=True)
    for _ in range(3): pg.click("#claTourNext")
    pg.wait_for_timeout(500); snap(pg, "tour-client-rep", clip={"x": 0, "y": 0, "width": 1280, "height": 760}, fixed=True); pg.keyboard.press("Escape"); ctx.close()
    ctx, pg = newpage(1280, 900); calc(pg); pg.click("#claCalcTourLink"); pg.wait_for_selector("#claTour"); pg.click("#claTourNext"); pg.click("#claTourNext"); pg.click("#claTourNext"); pg.wait_for_timeout(500)
    snap(pg, "tour-calculator", clip={"x": 0, "y": 0, "width": 1280, "height": 800}, fixed=True); ctx.close()

    MASK = False
    # ---- admin (Alex, super admin who also reps) ----
    ctx, pg = newpage(1440, 1300); login(pg, "sample.admin@clatitle.com")
    if pg.locator("#claTour").count(): pg.keyboard.press("Escape")
    pg.wait_for_selector("#users tr"); pg.wait_for_timeout(500)
    pg.add_style_tag(content="main.pg{max-width:1400px!important}"); pg.wait_for_timeout(300); snap(pg, "portal-header", clip=hdrclip(pg, 70), fixed=True); snap(pg, "admin-users", clip=mainclip(pg, 1150))
    pg.click("#showInv"); pg.fill("#iEmail", "new.rep@clatitle.com"); pg.select_option("#iRole", "rep"); pg.fill("#iCell", "2405550142")
    snap(pg, "admin-invite", sel="#invCard")
    # the same form for a client who belongs to a specific rep (role Client + rep picker)
    pg.select_option("#iRole", "client"); pg.fill("#iEmail", "new.agent@example.com"); pg.fill("#iCell", "2405550177")
    pg.evaluate("()=>{const s=document.getElementById('iRep');const o=[...s.options].find(x=>x.text.startsWith('Jane Rep'));s.value=o.value;s.dispatchEvent(new Event('change'))}"); pg.wait_for_timeout(200)
    snap(pg, "admin-invite-client", sel="#invCard"); pg.click("#invCancel")
    # role change that needs a successor (Marcus has clients)
    pg.once("dialog", lambda d: d.accept())
    pg.select_option('select[data-role="00000000-0000-4000-8000-0000000000b2"]', "client"); pg.wait_for_selector(".dlg"); pg.wait_for_timeout(400)
    dg = pg.evaluate("()=>{const e=document.querySelector('.dlg');const r=e.getBoundingClientRect();return {x:r.x-24,y:r.y-24,width:r.width+48,height:r.height+48}}"); snap(pg, "admin-reassign-dialog", clip=dg, fixed=True); pg.click("#dlgNo")
    pg.click('#tabs button[data-i="2"]'); pg.wait_for_timeout(600); snap(pg, "admin-assignments", clip=mainclip(pg, 1000))
    pg.click('#tabs button[data-i="1"]'); pg.wait_for_timeout(600); snap(pg, "admin-quotes", clip=mainclip(pg, 1000))
    pg.click('#tabs button[data-i="3"]'); pg.wait_for_timeout(600); snap(pg, "admin-audit", clip=mainclip(pg, 560))
    pg.click('#tabs button[data-i="4"]'); pg.wait_for_timeout(600); snap(pg, "admin-feedback", clip=mainclip(pg, 720))
    # pricing
    pg.click('#tabs button[data-i="5"]'); pg.wait_for_selector("#ptRows tr"); pg.wait_for_timeout(600)
    snap(pg, "pricing-tables", clip=mainclip(pg, 820))
    pg.locator("#ptRows tr", has_text="Jane's Pricing").locator("button, a").first.click(); pg.wait_for_selector("#ptDetailView:not([hidden])"); pg.wait_for_timeout(600)
    snap(pg, "pricing-table-detail", clip=union(pg, ["#ptDetailView"]))
    pg.click("#fsAdd"); pg.wait_for_timeout(300); pg.check("#fsStates input[data-st='DC']")
    snap(pg, "pricing-fee-set-editor", sel="#fsEditor", pad=16)
    pg.click("#fsCancel"); pg.fill("#mEmail", "new.agent@example.com")
    snap(pg, "pricing-add-member", sel="#mForm", pad=40, clip=union(pg, ["#mForm", "#mRows"], pad=16))
    ctx.close()
    br.close()
print("script errors:", errors or "none"); srv.shutdown()

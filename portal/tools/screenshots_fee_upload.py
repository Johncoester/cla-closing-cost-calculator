"""Screenshots for Upload CLA fees (admin page + calculator, MOCK data only). Usage:
  python3 portal/tools/screenshots_fee_upload.py [outdir]
Serves THIS repo on a local port and ALWAYS answers portal/config.js with MOCK mode.
Never touches Supabase. Reads the public fee sheet (read-only) for the "current fees" baseline, like the calculator does.
The demo file changes are made up for the pictures; nothing is uploaded anywhere."""
import http.server, threading, sys, os, functools, tempfile, csv, io, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/fee-upload-1125"
os.makedirs(OUT, exist_ok=True)
PORT = 8878

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.split("?")[0].endswith("/portal/config.js"):
            body = b'window.CLA_PORTAL_CONFIG = { mode: "mock" };'
            self.send_response(200); self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()

http.server.ThreadingHTTPServer.allow_reuse_address = True
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}/"
errors = []
H = ["Active", "State", "Fee Name", "Transaction", "Amount", "Paid By", "LE Section", "Default On", "Notes"]

def md_rows():
    url = "https://docs.google.com/spreadsheets/d/1kVBo3hchS-B5-g8NHn5ZSAdAZxXxOjuaHTv6SuXamOM/gviz/tq?tqx=out:csv&headers=1&sheet=CLA_Fees"
    rows = list(csv.DictReader(io.StringIO(urllib.request.urlopen(url, timeout=20).read().decode("utf-8"))))
    return [r for r in rows if r["State"] == "MD"]

def demo_csv(with_error):
    out = io.StringIO(); w = csv.writer(out); w.writerow(H)
    for r in md_rows():
        if r["Fee Name"].startswith("Shipping Fee"): continue                       # demo: removed
        if r["Fee Name"].startswith("Settlement Fee") and r["Transaction"] == "Purchase" and r["Paid By"] == "Buyer": r["Amount"] = "1095"   # demo: changed
        w.writerow([r[h] for h in H])
    w.writerow(["Y", "MD", "Courier Fee to CLA Title & Escrow", "Purchase", "25", "Buyer", "C", "Y", "demo"])    # demo: new
    if with_error: w.writerow(["Y", "MD", "Wire Fee", "Purchase", "twenty", "Buyer", "C", "Y", ""])
    w.writerow(["Y", "NJ", "Settlement Fee to CLA Title & Escrow", "Purchase", "950", "Buyer", "C", "Y", "demo"])
    return out.getvalue()

def login(pg, email):
    pg.goto(B + "portal/login.html"); pg.wait_for_selector("#email")
    pg.fill("#email", email); pg.fill("#pw", "demo-password"); pg.click("#go")
    pg.wait_for_url("**/*.html*", timeout=8000); pg.wait_for_load_state("networkidle")

def fees_tab(pg):
    pg.wait_for_selector("#users tr")
    pg.locator("#tabs button", has_text="CLA fees").click()
    pg.wait_for_selector("#feSrcRows tr"); pg.wait_for_timeout(300)

def shot(pg, sel, name):
    pg.wait_for_timeout(300)
    pg.locator(sel).screenshot(path=os.path.join(OUT, name + ".png")); print("saved", name)

def main():
    tmp = tempfile.mkdtemp()
    bad = os.path.join(tmp, "md-nj-fees.csv"); open(bad, "w").write(demo_csv(True))
    good = os.path.join(tmp, "md-nj-fees-fixed.csv"); open(good, "w").write(demo_csv(False))
    with sync_playwright() as p:
        br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
        ctx = br.new_context(viewport={"width": 1280, "height": 900})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
        pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
        pg.on("dialog", lambda d: d.accept())

        login(pg, "sample.robin.admin@clatitle.com"); fees_tab(pg)
        shot(pg, "#feUpCard", "01-upload-card")
        pg.set_input_files("#feFile", bad); pg.wait_for_selector("#fePreview:not([hidden])")
        shot(pg, "#feUpCard", "02-preview-diff-and-error")
        pg.set_input_files("#feFile", good); pg.wait_for_selector("#fePreview:not([hidden])"); pg.wait_for_timeout(200)
        pg.fill("#feNote", "Demo: new 2027 MD settlement fee + NJ start")
        pg.click("#feSubmit"); pg.wait_for_selector("#fePend [data-ferev]")
        shot(pg, "#pFees", "03-sent-for-approval-admin-view")

        pg.evaluate("localStorage.removeItem('cla_portal_mock_session')")
        login(pg, "sample.admin@clatitle.com"); fees_tab(pg)
        pg.click("#fePend [data-ferev]"); pg.wait_for_selector("#feApprove")
        shot(pg, "#fePendCard", "04-pending-approval-super-admin")
        pg.fill("#feDecNote", "OK for Jan 1 (demo)")
        pg.click("#feApprove"); pg.wait_for_function("document.getElementById('feOk').textContent.length > 0")
        shot(pg, "#pFees", "05-approved-live")

        pg.goto(B + "index.html"); pg.wait_for_load_state("networkidle")
        pg.fill("#zip", "21704"); pg.wait_for_timeout(1200)
        pg.wait_for_function("/come from the portal/.test(document.getElementById('status').textContent)", timeout=8000)
        pg.screenshot(path=os.path.join(OUT, "06-calculator-uses-approved-fees.png"), full_page=True); print("saved 06-calculator-uses-approved-fees")
        ctx.close(); br.close()
    print("WARN page errors:", errors) if errors else print("no page errors")

if __name__ == "__main__":
    main()

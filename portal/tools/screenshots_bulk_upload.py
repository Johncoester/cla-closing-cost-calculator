"""Screenshots for Upload clients (admin page, mock data only). Usage:
  python3 portal/tools/screenshots_bulk_upload.py [outdir]
Serves THIS repo on a local port and ALWAYS answers portal/config.js with MOCK mode.
Never touches the live site or Supabase. No invites are sent."""
import http.server, socketserver, threading, sys, os, functools, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/bulk-upload-1117"
os.makedirs(OUT, exist_ok=True)
PORT = 8877

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

CSV = "\n".join([
    "first_name,last_name,email,cell_phone,company,rep_email",
    "Maya,Chen,maya.chen@example.com,(240) 555-0142,Chen Realty,sample.rep.jane@clatitle.com",
    "Sam,Agent,sam.agent@example.com,,Acme Realty,sample.rep.jane@clatitle.com",
    "No,Rep,norep@example.com,," + ",",
    "Bad,Mail,not-an-email,,Somewhere,sample.rep.jane@clatitle.com",
]) + "\n"

def login(pg, email):
    pg.goto(B + "portal/login.html"); pg.wait_for_selector("#email")
    pg.fill("#email", email); pg.fill("#pw", "demo-password"); pg.click("#go")
    pg.wait_for_url("**/*.html*", timeout=8000); pg.wait_for_load_state("networkidle")

def snap(pg, name, full=True):
    pg.wait_for_timeout(400)
    pg.screenshot(path=os.path.join(OUT, name + ".png"), full_page=full)
    print("saved", name)

def main():
    csv_path = os.path.join(tempfile.mkdtemp(), "clients.csv")
    open(csv_path, "w").write(CSV)
    with sync_playwright() as p:
        br = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
        def newpage(w=1280, h=900, scale=1):
            ctx = br.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
            pg.on("console", lambda m: m.type == "error" and "config.js" not in m.text and "fonts.g" not in m.text and "404" not in m.text and errors.append("console " + m.text))
            return ctx, pg

        # desktop
        ctx, pg = newpage()
        login(pg, "sample.admin@clatitle.com")
        pg.wait_for_selector("#users tr")
        pg.click("#showUp")
        pg.wait_for_selector("#upCard:not([hidden])")
        pg.locator("#upCard").scroll_into_view_if_needed()
        snap(pg, "01-upload-card-desktop")

        pg.set_input_files("#upFile", csv_path)
        pg.wait_for_selector("#upPreview:not([hidden])")
        pg.wait_for_timeout(200)
        pg.locator("#upCard").scroll_into_view_if_needed()
        snap(pg, "02-upload-preview-desktop")

        pg.click("#upSend")
        pg.wait_for_selector("#upResults:not([hidden])")
        pg.wait_for_timeout(300)
        pg.locator("#upCard").scroll_into_view_if_needed()
        snap(pg, "03-upload-results-desktop")
        ctx.close()

        # phone width
        ctx, pg = newpage(390, 844, 2)
        login(pg, "sample.admin@clatitle.com")
        pg.wait_for_selector("#users tr")
        pg.click("#showUp")
        pg.wait_for_selector("#upCard:not([hidden])")
        pg.locator("#upCard").scroll_into_view_if_needed()
        snap(pg, "01m-upload-card-phone")

        pg.set_input_files("#upFile", csv_path)
        pg.wait_for_selector("#upPreview:not([hidden])")
        pg.wait_for_timeout(200)
        pg.locator("#upCard").scroll_into_view_if_needed()
        snap(pg, "02m-upload-preview-phone")

        pg.click("#upSend")
        pg.wait_for_selector("#upResults:not([hidden])")
        pg.wait_for_timeout(300)
        pg.locator("#upCard").scroll_into_view_if_needed()
        snap(pg, "03m-upload-results-phone")
        ctx.close()
        br.close()

    if errors:
        print("WARN page errors:", errors)
    else:
        print("no page errors")

if __name__ == "__main__":
    main()

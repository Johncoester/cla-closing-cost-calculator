"""Turns the raw screenshots (portal/tools/screenshots_help.py -> /workspace/help-shots-raw) into the small PNGs the Help pages use.
usage: python3 portal/tools/optimize_help_images.py [raw_dir]      needs Pillow
Max 1200px wide, 256-colour palette (flat UI pictures), optimised PNG.
Sorting: pictures used by the CLIENT guide (client-content.js) go to portal/help/client/ (client-safe only); every other picture the staff manual
(help-content.js) uses goes to portal/help/staff/. Nothing else is kept, so the client guide can never ship a staff picture."""
import os, re, shutil, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); RAW = sys.argv[1] if len(sys.argv) > 1 else "/workspace/help-shots-raw"
HELP = os.path.join(HERE, "..", "help")
names = lambda f: set(re.findall(r'f: "([a-z0-9-]+\.png)"', open(os.path.join(HERE, f)).read()))
client, staff = names("client-content.js"), names("help-content.js") - names("client-content.js")
assert not (client & staff)
for sub, files in (("client", client), ("staff", staff)):
    out = os.path.join(HELP, sub); shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
    for f in sorted(files):
        im = Image.open(os.path.join(RAW, f)).convert("RGB")
        if im.width > 1200: im = im.resize((1200, round(im.height * 1200 / im.width)), Image.LANCZOS)
        im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(out, f), optimize=True)
    print(sub, len(files), "pictures,", round(sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)) / 1024), "KB")
shutil.rmtree(os.path.join(HELP, "img"), ignore_errors=True)

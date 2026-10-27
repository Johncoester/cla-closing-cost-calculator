"""Turns the raw screenshots (portal/tools/screenshots_help.py -> /workspace/help-shots-raw) into the small PNGs the Help page uses.
usage: python3 portal/tools/optimize_help_images.py [raw_dir]      needs Pillow
Max 1200px wide, 256-colour palette (these are flat UI pictures), optimised PNG. Only the pictures help-content.js uses are kept."""
import os, re, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); RAW = sys.argv[1] if len(sys.argv) > 1 else "/workspace/help-shots-raw"
OUT = os.path.join(HERE, "..", "help", "img"); os.makedirs(OUT, exist_ok=True)
used = set(re.findall(r'f: "([a-z0-9-]+\.png)"', open(os.path.join(HERE, "help-content.js")).read()))
for f in sorted(used):
    im = Image.open(os.path.join(RAW, f)).convert("RGB")
    if im.width > 1200: im = im.resize((1200, round(im.height * 1200 / im.width)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    im.save(os.path.join(OUT, f), optimize=True)
for f in os.listdir(OUT):
    if f.endswith(".png") and f not in used: os.remove(os.path.join(OUT, f))
tot = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(len(used), "pictures,", round(tot / 1024), "KB total")

"""Find the dominant 'brand' color of each book cover and write covers-colors.json.

Filters out near-white and near-black so spines aren't all beige/black.
"""

import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent
COVERS_DIR = ROOT / "covers"
OUT = ROOT / "covers-colors.json"


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def dominant_color(path: Path) -> str:
    img = Image.open(path).convert("RGB").resize((100, 100))
    # Reduce to 6 buckets so we don't pick a noisy near-color of white/black
    quantized = img.quantize(colors=6).convert("RGB")
    pixels = list(quantized.getdata())
    counts = {}
    for px in pixels:
        counts[px] = counts.get(px, 0) + 1
    # rank colors by frequency, but skip ones too close to pure white/black
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    for color, _ in ranked:
        l = luminance(color)
        if 25 < l < 235:  # not too dark, not too light
            return "#%02x%02x%02x" % color
    # fall back to most common color regardless
    return "#%02x%02x%02x" % ranked[0][0]


covers = sorted(COVERS_DIR.glob("*.jpg"))
out = {}
for p in covers:
    color = dominant_color(p)
    out[p.stem] = color
    print(f"  {p.stem:55s}  {color}")

OUT.write_text(json.dumps(out, indent=2))
print(f"\nWrote {OUT.name} ({len(out)} entries)")

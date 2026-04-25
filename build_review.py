"""Generate covers-review.html: a grid of all covers + titles for spot-check."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOOKS_HTML = (ROOT / "books.html").read_text()
COVERS_DIR = ROOT / "covers"


def extract_books(html: str):
    pattern = re.compile(
        r'<div class="book-entry">\s*'
        r'(?:<span class="book-number">([^<]*)</span>\s*)?'
        r'<div class="book-info">\s*'
        r'<span class="book-title">([^<]+)</span>\s*'
        r'(?:<span class="book-author">([^<]+)</span>)?',
        re.DOTALL,
    )
    out = []
    for i, m in enumerate(pattern.finditer(html), 1):
        out.append((i, m.group(2).strip(), (m.group(3) or "").strip()))
    return out


def slugify(text, max_len=50):
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:max_len] or "book"


books = extract_books(BOOKS_HTML)

cards = []
for i, title, author in books:
    fname = f"{i:02d}-{slugify(title)}.jpg"
    exists = (COVERS_DIR / fname).exists()
    src = f"covers/{fname}" if exists else ""
    placeholder = "" if exists else "<div class='missing'>no cover</div>"
    inner = f'<img src="{src}" alt="">' if exists else placeholder
    cards.append(
        f"<figure class='card'>"
        f"  <div class='cover'>{inner}</div>"
        f"  <figcaption><b>{i:02d}.</b> {title}<br><span>{author}</span></figcaption>"
        f"</figure>"
    )

html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Covers review</title>
<style>
body {{ font-family: -apple-system, sans-serif; background: #f7f5ee; padding: 24px; }}
h1 {{ font-weight: 400; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 24px; }}
.card {{ margin: 0; }}
.cover {{ aspect-ratio: 2/3; background:#ddd; display:flex; align-items:center; justify-content:center; box-shadow: 0 2px 8px rgba(0,0,0,.12); border-radius:3px; overflow:hidden; }}
.cover img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
.missing {{ color:#a33; font-size: 12px; }}
figcaption {{ font-size: 13px; line-height: 1.35; margin-top: 10px; color:#222; }}
figcaption span {{ color:#888; font-size: 12px; }}
</style></head>
<body>
<h1>Cover review — {len(books)} books</h1>
<p>Look for: wrong book, wrong edition with bad art, missing cover, anything weird.</p>
<div class="grid">
{chr(10).join(cards)}
</div>
</body></html>
"""

(ROOT / "covers-review.html").write_text(html)
print(f"Wrote covers-review.html with {len(books)} cards")

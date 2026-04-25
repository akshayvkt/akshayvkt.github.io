"""Generate bookshelf.html from books.html + covers-colors.json."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOOKS_HTML = (ROOT / "books.html").read_text()
COLORS = json.loads((ROOT / "covers-colors.json").read_text())
BOOKS_PER_SHELF = 14


def extract_books(html):
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


def text_color_for(bg_hex):
    """Pick white or dark text based on bg luminance."""
    r = int(bg_hex[1:3], 16)
    g = int(bg_hex[3:5], 16)
    b = int(bg_hex[5:7], 16)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return "#1a1a1a" if lum > 165 else "#f5f1e6"


def html_escape(s):
    return (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace('"', "&quot;")
    )


books = extract_books(BOOKS_HTML)

# Build book elements. Slight width variation per book (32-44px) based on title length
# to feel more like a real shelf.
spines = []
for i, title, author in books:
    slug = slugify(title)
    fname = f"covers/{i:02d}-{slug}.jpg"
    color_key = f"{i:02d}-{slug}"
    bg = COLORS.get(color_key, "#666666")
    fg = text_color_for(bg)
    # width: longer titles => slightly thicker spines; clamp 32-44px
    title_len = len(title)
    width = max(32, min(44, 32 + title_len // 5))
    spines.append({
        "i": i,
        "title": title,
        "author": author,
        "cover": fname,
        "bg": bg,
        "fg": fg,
        "width": width,
    })

# Group into shelves
shelves = [spines[i:i + BOOKS_PER_SHELF] for i in range(0, len(spines), BOOKS_PER_SHELF)]

shelf_html_parts = []
for shelf_idx, shelf in enumerate(shelves):
    items = []
    for s in shelf:
        title_e = html_escape(s["title"])
        author_e = html_escape(s["author"])
        items.append(
            f'<button class="book" '
            f'style="--bg:{s["bg"]};--fg:{s["fg"]};--w:{s["width"]}px" '
            f'data-cover="{s["cover"]}" '
            f'data-title="{title_e}" data-author="{author_e}" '
            f'aria-label="{title_e} by {author_e}">'
            f'<span class="spine-text">'
            f'<span class="t">{title_e}</span>'
            f'<span class="a">{author_e}</span>'
            f'</span>'
            f'</button>'
        )
    shelf_html_parts.append(
        '<div class="shelf-row">\n  <div class="books">\n    '
        + "\n    ".join(items)
        + '\n  </div>\n  <div class="shelf-plank"></div>\n</div>'
    )

shelves_html = "\n\n".join(shelf_html_parts)

page = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bookshelf | Akshay Chintalapati</title>
  <link href="css/style.css" rel="stylesheet">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    .bookshelf-page {{
      max-width: 900px;
      margin: 0 auto;
      padding: 0 8px;
    }}
    .bookshelf-intro {{
      font-style: italic;
      color: #888;
      margin-bottom: 38px;
      font-size: 1.05em;
      letter-spacing: 0.02em;
    }}
    .shelf-row {{
      margin-bottom: 28px;
    }}
    .books {{
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      gap: 1px;
      padding-left: 6px;
      min-height: 248px;
    }}
    .shelf-plank {{
      height: 12px;
      background: linear-gradient(180deg, #6b4a2b 0%, #4a3217 60%, #2c1d0c 100%);
      border-radius: 2px;
      box-shadow: 0 4px 10px rgba(0,0,0,0.18);
      margin-top: -2px;
    }}
    .book {{
      all: unset;
      cursor: pointer;
      width: var(--w, 38px);
      height: 240px;
      background: var(--bg);
      color: var(--fg);
      position: relative;
      border-radius: 2px 2px 1px 1px;
      box-shadow:
        inset 1px 0 0 rgba(255,255,255,0.08),
        inset -1px 0 0 rgba(0,0,0,0.18),
        0 2px 5px rgba(0,0,0,0.25);
      transition: transform 0.18s ease, box-shadow 0.18s ease;
      flex: 0 0 auto;
      overflow: hidden;
    }}
    .book:hover, .book:focus-visible {{
      transform: translateY(-10px);
      box-shadow:
        inset 1px 0 0 rgba(255,255,255,0.12),
        inset -1px 0 0 rgba(0,0,0,0.22),
        0 8px 14px rgba(0,0,0,0.28);
      z-index: 2;
    }}
    .book::before {{
      /* subtle vertical gloss line */
      content: "";
      position: absolute;
      top: 0; bottom: 0; left: 4px; width: 1px;
      background: rgba(255,255,255,0.12);
    }}
    .spine-text {{
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-90deg);
      transform-origin: center;
      width: 220px;
      display: flex;
      flex-direction: row;
      align-items: baseline;
      gap: 10px;
      white-space: nowrap;
      font-family: 'Cormorant Garamond', serif;
      pointer-events: none;
    }}
    .spine-text .t {{
      font-weight: 600;
      font-size: 0.95rem;
      letter-spacing: 0.02em;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 165px;
    }}
    .spine-text .a {{
      font-weight: 400;
      font-size: 0.7rem;
      opacity: 0.75;
      font-style: italic;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 90px;
    }}

    /* Modal overlay when a book is clicked */
    .book-modal {{
      position: fixed;
      inset: 0;
      background: rgba(20, 18, 14, 0.78);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      opacity: 0;
      transition: opacity 0.25s ease;
      padding: 20px;
    }}
    .book-modal.open {{
      display: flex;
      opacity: 1;
    }}
    .book-modal-card {{
      max-width: 380px;
      transform: scale(0.85);
      transition: transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      text-align: center;
    }}
    .book-modal.open .book-modal-card {{
      transform: scale(1);
    }}
    .book-modal-card img {{
      width: 100%;
      height: auto;
      max-height: 70vh;
      object-fit: contain;
      border-radius: 4px;
      box-shadow: 0 18px 40px rgba(0,0,0,0.45);
      display: block;
      margin: 0 auto;
    }}
    .book-modal-card .meta {{
      color: #f3eee2;
      margin-top: 18px;
      font-family: 'Cormorant Garamond', serif;
    }}
    .book-modal-card .meta .title {{
      font-size: 1.3rem;
      font-weight: 500;
      font-style: italic;
    }}
    .book-modal-card .meta .author {{
      font-size: 0.9rem;
      opacity: 0.75;
      margin-top: 4px;
    }}
    .book-modal-close {{
      position: absolute;
      top: 18px;
      right: 22px;
      background: transparent;
      border: 0;
      color: #fff;
      font-size: 28px;
      cursor: pointer;
      opacity: 0.7;
    }}
    .book-modal-close:hover {{
      opacity: 1;
    }}

    @media (max-width: 600px) {{
      .book {{ height: 180px; width: calc(var(--w, 38px) - 6px); }}
      .spine-text {{ width: 165px; }}
      .spine-text .t {{ font-size: 0.78rem; max-width: 120px; }}
      .spine-text .a {{ display: none; }}
      .books {{ min-height: 188px; }}
    }}
  </style>
</head>
<body>
  <div class="bookshelf-page">
    <a href="index.html" class="back-link">&larr; Back</a>
    <p class="bookshelf-intro">A bookshelf of what I've read. Click any spine.</p>

    {shelves_html}

  </div>

  <div class="book-modal" id="book-modal" role="dialog" aria-modal="true" aria-label="Book cover">
    <button class="book-modal-close" id="book-modal-close" aria-label="Close">&times;</button>
    <div class="book-modal-card">
      <img id="book-modal-img" src="" alt="">
      <div class="meta">
        <div class="title" id="book-modal-title"></div>
        <div class="author" id="book-modal-author"></div>
      </div>
    </div>
  </div>

  <script>
    const modal = document.getElementById('book-modal');
    const modalImg = document.getElementById('book-modal-img');
    const modalTitle = document.getElementById('book-modal-title');
    const modalAuthor = document.getElementById('book-modal-author');
    const modalClose = document.getElementById('book-modal-close');

    function openBook(btn) {{
      modalImg.src = btn.dataset.cover;
      modalImg.alt = btn.dataset.title;
      modalTitle.textContent = btn.dataset.title;
      modalAuthor.textContent = btn.dataset.author;
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }}

    function closeBook() {{
      modal.classList.remove('open');
      document.body.style.overflow = '';
    }}

    document.querySelectorAll('.book').forEach(btn => {{
      btn.addEventListener('click', () => openBook(btn));
    }});
    modal.addEventListener('click', e => {{
      if (e.target === modal) closeBook();
    }});
    modalClose.addEventListener('click', closeBook);
    document.addEventListener('keydown', e => {{
      if (e.key === 'Escape' && modal.classList.contains('open')) closeBook();
    }});
  </script>
</body>
</html>
"""

(ROOT / "bookshelf.html").write_text(page)
print(f"Wrote bookshelf.html with {len(books)} books across {len(shelves)} shelves")

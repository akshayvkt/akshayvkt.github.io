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
        '<div class="shelf-row">\n'
        '  <div class="shelf-frame">\n'
        '    <div class="books">\n      '
        + "\n      ".join(items)
        + '\n    </div>\n'
        '  </div>\n'
        '</div>'
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
      display: flex;
      justify-content: center;
      margin-bottom: 32px;
    }}
    .shelf-frame {{
      display: inline-flex;
      flex-direction: column;
      max-width: 100%;
      background: linear-gradient(180deg, #1c1208 0%, #0f0a04 100%);
      border-top: 10px solid;
      border-left: 12px solid;
      border-right: 12px solid;
      border-image: linear-gradient(180deg, #6b4a2b 0%, #4a3217 70%, #382412 100%) 1;
      border-radius: 4px 4px 0 0;
      padding: 4px 4px 0;
      box-shadow:
        inset 0 6px 14px rgba(0,0,0,0.55),
        inset 0 -2px 0 rgba(0,0,0,0.4),
        0 6px 16px rgba(0,0,0,0.22);
      position: relative;
    }}
    .shelf-frame::after {{
      content: "";
      display: block;
      height: 14px;
      margin: 0 -4px;
      background: linear-gradient(180deg, #6b4a2b 0%, #4a3217 55%, #2c1d0c 100%);
      border-radius: 0 0 3px 3px;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.08),
        0 4px 10px rgba(0,0,0,0.28);
    }}
    .books {{
      display: flex;
      align-items: flex-end;
      gap: 1px;
      min-height: 248px;
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

    /* Modal overlay (3D flip) when a book is clicked */
    .book-modal {{
      position: fixed;
      inset: 0;
      background: rgba(20, 18, 14, 0.0);
      backdrop-filter: blur(0px);
      -webkit-backdrop-filter: blur(0px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      perspective: 1600px;
      transition: background 0.4s ease, backdrop-filter 0.4s ease;
      padding: 20px;
    }}
    .book-modal.visible {{
      display: flex;
    }}
    .book-modal.open {{
      background: rgba(20, 18, 14, 0.78);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }}
    .book-card {{
      position: relative;
      width: 320px;
      height: 480px;
      transform-style: preserve-3d;
      transform: scale(0.55) rotateY(0deg);
      opacity: 0;
      transition:
        transform 0.85s cubic-bezier(0.22, 0.85, 0.3, 1.05),
        opacity 0.4s ease;
    }}
    .book-modal.open .book-card {{
      transform: scale(1) rotateY(-180deg);
      opacity: 1;
    }}
    .book-card-face {{
      position: absolute;
      inset: 0;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
      border-radius: 4px;
      box-shadow: 0 22px 48px rgba(0,0,0,0.55);
    }}
    .book-card-spine {{
      background: var(--card-bg, #444);
      color: var(--card-fg, #f5f1e6);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }}
    .book-card-spine::before {{
      /* spine gloss */
      content: "";
      position: absolute;
      top: 0; bottom: 0; left: 12px; width: 2px;
      background: rgba(255,255,255,0.15);
    }}
    .book-card-spine::after {{
      content: "";
      position: absolute;
      top: 0; bottom: 0; right: 0; width: 14px;
      background: linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 100%);
    }}
    .book-card-spine-text {{
      transform: rotate(-90deg);
      transform-origin: center;
      white-space: nowrap;
      font-family: 'Cormorant Garamond', serif;
      display: flex;
      align-items: baseline;
      gap: 16px;
    }}
    .book-card-spine-text .t {{
      font-weight: 600;
      font-size: 1.4rem;
      letter-spacing: 0.02em;
    }}
    .book-card-spine-text .a {{
      font-weight: 400;
      font-size: 0.9rem;
      opacity: 0.78;
      font-style: italic;
    }}
    .book-card-cover {{
      transform: rotateY(180deg);
      background: #111;
      overflow: hidden;
    }}
    .book-card-cover img {{
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }}
    .book-card-meta {{
      position: absolute;
      left: 50%;
      bottom: -72px;
      transform: translateX(-50%) rotateY(180deg);
      color: #f3eee2;
      font-family: 'Cormorant Garamond', serif;
      text-align: center;
      width: 360px;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
      opacity: 0;
      transition: opacity 0.3s ease 0.5s;
    }}
    .book-modal.open .book-card-meta {{
      opacity: 1;
    }}
    .book-card-meta .title {{
      font-size: 1.25rem;
      font-style: italic;
      font-weight: 500;
    }}
    .book-card-meta .author {{
      font-size: 0.9rem;
      opacity: 0.75;
      margin-top: 2px;
    }}
    .book-modal-close {{
      position: absolute;
      top: 18px;
      right: 22px;
      background: transparent;
      border: 0;
      color: #fff;
      font-size: 30px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.3s ease 0.4s;
      z-index: 2;
    }}
    .book-modal.open .book-modal-close {{
      opacity: 0.7;
    }}
    .book-modal-close:hover {{
      opacity: 1 !important;
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
    <div class="book-card" id="book-card">
      <div class="book-card-face book-card-spine">
        <div class="book-card-spine-text">
          <span class="t" id="book-card-spine-title"></span>
          <span class="a" id="book-card-spine-author"></span>
        </div>
      </div>
      <div class="book-card-face book-card-cover">
        <img id="book-card-img" src="" alt="">
      </div>
      <div class="book-card-meta">
        <div class="title" id="book-card-meta-title"></div>
        <div class="author" id="book-card-meta-author"></div>
      </div>
    </div>
  </div>

  <script>
    const modal = document.getElementById('book-modal');
    const card = document.getElementById('book-card');
    const cardImg = document.getElementById('book-card-img');
    const spineTitle = document.getElementById('book-card-spine-title');
    const spineAuthor = document.getElementById('book-card-spine-author');
    const metaTitle = document.getElementById('book-card-meta-title');
    const metaAuthor = document.getElementById('book-card-meta-author');
    const modalClose = document.getElementById('book-modal-close');

    let openLockUntil = 0;

    function openBook(btn) {{
      const styles = getComputedStyle(btn);
      const bg = styles.getPropertyValue('--bg').trim() || '#444';
      const fg = styles.getPropertyValue('--fg').trim() || '#f5f1e6';
      card.style.setProperty('--card-bg', bg);
      card.style.setProperty('--card-fg', fg);

      spineTitle.textContent = btn.dataset.title;
      spineAuthor.textContent = btn.dataset.author;
      cardImg.src = btn.dataset.cover;
      cardImg.alt = btn.dataset.title;
      metaTitle.textContent = btn.dataset.title;
      metaAuthor.textContent = btn.dataset.author;

      modal.classList.add('visible');
      document.body.style.overflow = 'hidden';
      void modal.offsetHeight;
      requestAnimationFrame(() => modal.classList.add('open'));

      // Ignore stray backdrop clicks for the duration of the open animation
      openLockUntil = Date.now() + 900;
    }}

    function closeBook() {{
      if (!modal.classList.contains('open')) return;
      modal.classList.remove('open');
      document.body.style.overflow = '';
      setTimeout(() => modal.classList.remove('visible'), 850);
    }}

    document.querySelectorAll('.book').forEach(btn => {{
      btn.addEventListener('click', (e) => {{
        e.stopPropagation();
        openBook(btn);
      }});
    }});
    modal.addEventListener('click', e => {{
      if (Date.now() < openLockUntil) return;
      if (e.target === modal) closeBook();
    }});
    modalClose.addEventListener('click', (e) => {{
      e.stopPropagation();
      closeBook();
    }});
    document.addEventListener('keydown', e => {{
      if (e.key === 'Escape' && modal.classList.contains('open')) closeBook();
    }});
  </script>
</body>
</html>
"""

(ROOT / "bookshelf.html").write_text(page)
print(f"Wrote bookshelf.html with {len(books)} books across {len(shelves)} shelves")

"""Generate study/index.html — The Study room scene.

Pulls book data + colors from existing files. Quotes baked in here (from content card).
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOOKS_HTML = (ROOT / "books" / "list" / "index.html").read_text()
COLORS = json.loads((ROOT / "covers-colors.json").read_text())


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


def html_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


# ── Build the 18 quotes (curated for corkboard rotation) ──
QUOTES = [
    ("Attention shapes the self, and is in turn shaped by it.", "Mihaly Csikszentmihalyi, Flow"),
    ("The mind is a wonderful servant but a terrible master.", ""),
    ("You have the right to work, never to its fruits.", "Bhagavad Gita"),
    ("The generality of mankind cannot accompany us one short hour unless the path is strewn with flowers.", "Michael Faraday"),
    ("What do you care what other people think?", "Richard Feynman"),
    ("No problem is too small or too trivial if we can really do something about it.", "Richard Feynman"),
    ("You can control what you think, and you can control how you think, therefore you can control who you are.", "Eileen Gu"),
    ("If your goal doesn't have a schedule, it is a dream.", "Kevin Kelly, Excellent Advice for Living"),
    ("One day you will wake up and there won't be any more time to do the things you've always wanted. Do it now.", "Paulo Coelho"),
    ("Often, the key to succeeding at something big is to break it into its tiniest pieces and focus on how to succeed at just one piece.", "Tim Urban"),
    ("Getting cheated occasionally is the small price for trusting the best of everyone, because when you trust the best in others, they generally treat you best.", "Kevin Kelly, Excellent Advice for Living"),
    ("It's possible that a not-so-smart person who can communicate well can do much better than a super-smart person who can't communicate well.", "Kevin Kelly, Excellent Advice for Living"),
    ("I'm an ape trying to put two sticks together. Once in a while the sticks go together and I reach the banana.", "Richard Feynman"),
    ("I was an ordinary person who studied hard.", "Richard Feynman"),
    ("Life can be much broader once you discover one simple fact: everything around you was made up by people no smarter than you.", "Steve Jobs"),
    ("You've got to act, and you've got to be willing to fail.", "Steve Jobs"),
    ("You are always to some degree wrong, and the goal is to be less wrong.", "Elon Musk"),
    ("Many lives per life.", "Zach Weinersmith, SMBC"),
]

# 4 video IDs from content card
VIDEOS = [
    {"id": "KkLN6bUGfZY", "title": "Feynman — two sticks together", "subtitle": "on confusion"},
    {"id": "X1-Gz5Bv3W8", "title": "Feynman — ordinary person", "subtitle": "on being ordinary"},
    {"id": "kYfNvmF0Bqw", "title": "Steve Jobs — change everything", "subtitle": "on agency"},
    {"id": "zkTf0LmDqKI", "title": "Steve Jobs — willing to fail", "subtitle": "on action"},
]

# 4 social postcards
SOCIALS = [
    {"label": "X",  "url": "https://x.com/akshayvkt"},
    {"label": "GH", "url": "https://github.com/akshayvkt"},
    {"label": "@",  "url": "mailto:venkatakshay98@gmail.com"},
    {"label": "RSS", "url": "https://akshaychintalapati.substack.com/"},
]

# ── Build book spine colors per shelf ──
# Use 3 shelves; books distributed evenly. Last 2 are "currently reading" — tilted.
books = extract_books(BOOKS_HTML)
spine_colors = []
for i, title, author in books:
    slug = slugify(title)
    color = COLORS.get(f"{i:02d}-{slug}", "#666666")
    is_currently_reading = i >= 53  # last 2 books (Selfish Gene, Poor Charlie's)
    spine_colors.append({"i": i, "color": color, "tilted": is_currently_reading})

# Distribute across 3 shelves: 18, 18, 18
shelves = [spine_colors[i:i + 18] for i in range(0, 54, 18)]


# ── Build HTML ──

def spine_html(s):
    cls = "spine tilted" if s["tilted"] else "spine"
    return f'<span class="{cls}" style="background:{s["color"]}"></span>'

def shelf_html(shelf):
    spines = "".join(spine_html(s) for s in shelf)
    return f'<div class="bookshelf-shelf">{spines}</div>'

shelves_inner = "\n          ".join(shelf_html(s) for s in shelves)


def card_html(idx, q, src):
    src_html = f'<div class="src">— {html_escape(src)}</div>' if src else ""
    return (
        f'<button class="index-card" data-idx="{idx}" '
        f'aria-label="Quote {idx + 1}">'
        f'<div class="q">{html_escape(q)}</div>'
        f'{src_html}'
        f'</button>'
    )


# Show 6 quotes on corkboard at once (rotated by JS later)
INITIAL_QUOTE_INDICES = [0, 4, 7, 11, 14, 16]
cards_html = "\n            ".join(
    card_html(i, QUOTES[i][0], QUOTES[i][1]) for i in INITIAL_QUOTE_INDICES
)

postcards_html = "\n          ".join(
    f'<a class="postcard" href="{s["url"]}" target="_blank" rel="noopener" '
    f'aria-label="{s["label"]}">{s["label"]}</a>'
    for s in SOCIALS
)

quotes_json = json.dumps([{"q": q, "src": s} for q, s in QUOTES])
videos_json = json.dumps(VIDEOS)


PAGE = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Akshay Chintalapati — The Study</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="study.css">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-61SVW4TL71"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){{dataLayer.push(arguments);}}
    gtag('js', new Date());
    gtag('config', 'G-61SVW4TL71');
  </script>
</head>
<body>

  <header class="study-header">
    <h1>Akshay Chintalapati</h1>
    <p class="tagline">Always learning</p>
    <div class="nav">
      <a href="/books/">Books</a>
      <a href="/quotes.html">Quotes</a>
      <a href="https://akshaychintalapati.substack.com/" target="_blank" rel="noopener">Writing</a>
    </div>
  </header>

  <div class="stage-wrap">
    <div class="stage" id="stage">

      <!-- Room shell: walls, floor, corner shadow -->
      <svg class="room-shell" viewBox="0 0 1116 640" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="leftWallGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"  stop-color="#e8d4a4" />
            <stop offset="100%" stop-color="#d2b985" />
          </linearGradient>
          <linearGradient id="backWallGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"  stop-color="#d2b985" />
            <stop offset="100%" stop-color="#c8ad7a" />
          </linearGradient>
          <linearGradient id="floorGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stop-color="#9b6f43" />
            <stop offset="100%" stop-color="#5b4632" />
          </linearGradient>
        </defs>
        <!-- Left wall (LIBRARY) -->
        <path d="M 30 30 L 540 90 L 540 470 L 30 540 Z" fill="url(#leftWallGrad)" />
        <!-- Back wall (STUDY) -->
        <path d="M 540 90 L 1086 90 L 1086 470 L 540 470 Z" fill="url(#backWallGrad)" />
        <!-- Floor -->
        <path d="M 30 540 L 540 470 L 1086 470 L 1086 600 L 30 600 Z" fill="url(#floorGrad)" />
        <!-- Floor planks (subtle perspective lines) -->
        <line x1="540" y1="470" x2="540" y2="600" stroke="rgba(0,0,0,0.12)" stroke-width="1" />
        <line x1="780" y1="470" x2="800" y2="600" stroke="rgba(0,0,0,0.10)" stroke-width="1" />
        <line x1="300" y1="510" x2="240" y2="600" stroke="rgba(0,0,0,0.10)" stroke-width="1" />
        <!-- Corner shadow (the seam between zones) -->
        <line x1="540" y1="90" x2="540" y2="470" stroke="rgba(43,38,32,0.45)" stroke-width="14" stroke-linecap="round" opacity="0.35" />
        <line x1="540" y1="90" x2="540" y2="470" stroke="rgba(43,38,32,0.55)" stroke-width="2" />
      </svg>

      <div class="props">

        <!-- LIBRARY ZONE: bookshelf, plant, chair -->
        <button class="bookshelf" aria-label="Open the bookshelf — 54 books">
          {shelves_inner}
          <span class="bookshelf-label">view 54 books →</span>
        </button>

        <div class="plant" aria-hidden="true">
          <div class="plant-leaves"><span></span></div>
          <div class="plant-pot"></div>
        </div>

        <div class="chair" aria-hidden="true">
          <div class="chair-back"></div>
          <div class="chair-seat"></div>
          <div class="chair-leg left"></div>
          <div class="chair-leg right"></div>
        </div>

        <!-- STUDY ZONE: window, clock, corkboard, postcard string, TV -->
        <div class="window" aria-label="Window — sky shifts with the time of day">
          <div class="window-sun"></div>
        </div>

        <div class="clock" aria-label="Local time">
          <div class="clock-hand hour"   id="hand-hour"></div>
          <div class="clock-hand minute" id="hand-minute"></div>
          <div class="clock-hand second" id="hand-second"></div>
          <div class="clock-pivot"></div>
        </div>

        <div class="corkboard" id="corkboard">
          <span class="corkboard-label">corkboard — quotes</span>
          <div class="corkboard-cards" id="corkboard-cards">
            {cards_html}
          </div>
        </div>

        <div class="postcard-string" aria-label="Social links">
          <div class="string-line"></div>
          {postcards_html}
        </div>

        <button class="tv" id="tv" aria-label="Play a video on the TV">
          <div class="tv-screen" id="tv-screen">
            <div class="scanlines"></div>
            <div class="play-icon"></div>
          </div>
          <div class="tv-controls">
            <span class="tv-dial" id="tv-dial" title="Change channel"></span>
            <span class="tv-info" id="tv-info">{html_escape(VIDEOS[0]["title"])}</span>
          </div>
          <span class="tv-label">click to play</span>
        </button>

        <!-- DESK ZONE: desk, typewriter, lamp, coffee -->
        <div class="desk" aria-hidden="true"></div>

        <button class="typewriter" id="typewriter" aria-label="Open writing — typewriter rolls a fresh page">
          <div class="typewriter-paper">Now writing…</div>
          <div class="typewriter-body">
            <div class="typewriter-keys"></div>
          </div>
          <span class="typewriter-label">read the writing →</span>
        </button>

        <button class="lamp" id="lamp" aria-label="Toggle night mode">
          <div class="lamp-glow"></div>
          <div class="lamp-shade"></div>
          <div class="lamp-pole"></div>
          <div class="lamp-base"></div>
          <span class="lamp-label">pull the chain</span>
        </button>

        <div class="coffee" aria-hidden="true">
          <div class="coffee-steam"><span></span><span></span><span></span></div>
          <div class="coffee-mug"></div>
        </div>

        <div class="rug" aria-hidden="true"></div>

      </div>
    </div>
  </div>

  <section class="study-bio">
    <p>Curiosity drives me. AI and clean energy are two things that live rent-free in my head, and my life's goal is to make lasting contributions towards a future that's both exciting and sustainable.</p>
    <p>Currently I'm a founder, building a product with the objective of helping people live better lives.</p>
    <p>Previously I worked in clean energy, building software products for installing and maintaining residential solar and storage systems at <em>Generac, SunPower, and Tesla</em>. Before that, a Master's in chemical engineering from Cornell and a bachelor's from Osmania University in India.</p>
    <p>I sometimes write <a href="https://akshaychintalapati.substack.com/" target="_blank" rel="noopener">here</a>.</p>
  </section>

  <!-- Quote modal -->
  <div class="modal-backdrop" id="quote-modal" role="dialog" aria-modal="true" aria-label="Quote">
    <div class="modal-card">
      <button class="modal-close" id="quote-modal-close" aria-label="Close">&times;</button>
      <div class="quote" id="quote-modal-text"></div>
      <div class="source" id="quote-modal-source"></div>
    </div>
  </div>

  <script>
    window.QUOTES = {quotes_json};
    window.VIDEOS = {videos_json};
  </script>
  <script src="study.js"></script>
</body>
</html>
'''

(ROOT / "study" / "index.html").write_text(PAGE)
print(f"Wrote study/index.html with {len(books)} books, {len(QUOTES)} quotes, {len(VIDEOS)} videos")

"""Fetch book covers from Open Library for every book in books.html.

Re-runnable: deletes nothing; only writes new files into covers/.
"""

import os
import re
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOOKS_HTML = ROOT / "books.html"
COVERS_DIR = ROOT / "covers"
COVERS_DIR.mkdir(exist_ok=True)

UA = "akshayvkt.github.io cover-fetcher (contact: venkatakshay98@gmail.com)"


def extract_books(html: str):
    """Return list of (idx, title, author) tuples in document order."""
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
        number_label = (m.group(1) or "").strip()
        title = m.group(2).strip()
        author = (m.group(3) or "").strip()
        out.append((i, number_label, title, author))
    return out


def slugify(text: str, max_len: int = 50) -> str:
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:max_len] or "book"


def query_openlibrary(title: str, author: str):
    """Return (cover_id, matched_title, matched_author) or None."""
    params = {"title": title, "limit": "3"}
    if author:
        params["author"] = author
    url = "https://openlibrary.org/search.json?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as e:
        return None, str(e)
    for doc in data.get("docs", []):
        cover_i = doc.get("cover_i")
        if cover_i:
            return cover_i, (doc.get("title", ""), ", ".join(doc.get("author_name", [])))
    return None, None


def download_cover(cover_id: int, dest: Path) -> bool:
    url = f"https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
        # Open Library returns a tiny placeholder (a few hundred bytes) when the cover doesn't exist.
        if len(data) < 3000:
            return False
        dest.write_bytes(data)
        return True
    except Exception:
        return False


def main():
    html = BOOKS_HTML.read_text()
    books = extract_books(html)
    print(f"Found {len(books)} books in books.html\n")

    results = []
    for i, number_label, title, author in books:
        slug = slugify(title)
        # use a 2-digit prefix so the folder sorts in book order
        filename = f"{i:02d}-{slug}.jpg"
        dest = COVERS_DIR / filename

        if dest.exists():
            results.append((i, title, author, "skip-exists", filename))
            print(f"  {i:02d}. SKIP (already have)  {title}")
            continue

        cover_id, matched = query_openlibrary(title, author)
        time.sleep(0.6)  # be polite to Open Library

        if not cover_id:
            results.append((i, title, author, "no-match", None))
            print(f"  {i:02d}. NO MATCH             {title}  ({author})")
            continue

        ok = download_cover(cover_id, dest)
        if ok:
            results.append((i, title, author, "ok", filename))
            matched_title, matched_author = matched
            note = ""
            if matched_title and matched_title.lower() != title.lower():
                note = f"   [matched: {matched_title!r}]"
            print(f"  {i:02d}. ok                   {title}{note}")
        else:
            results.append((i, title, author, "download-failed", None))
            print(f"  {i:02d}. DOWNLOAD FAILED      {title}")

    # summary
    print("\n--- Summary ---")
    by_status = {}
    for r in results:
        by_status.setdefault(r[3], []).append(r)
    for status, items in by_status.items():
        print(f"  {status}: {len(items)}")

    misses = [r for r in results if r[3] not in ("ok", "skip-exists")]
    if misses:
        print("\nMisses to review:")
        for i, title, author, status, _ in misses:
            print(f"  {i:02d}. [{status}] {title} — {author}")


if __name__ == "__main__":
    main()

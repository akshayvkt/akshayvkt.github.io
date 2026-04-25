"""Fill in the gaps left by fetch_covers.py using Google Books as fallback,
and re-fetch the two known-wrong matches with targeted queries.
"""

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COVERS_DIR = ROOT / "covers"

UA = "akshayvkt.github.io cover-fetcher (contact: venkatakshay98@gmail.com)"

# (book index, expected slug filename, search query)
MISSES = [
    (7,  "07-the-founders.jpg",                            "The Founders Jimmy Soni PayPal"),
    (10, "10-the-thinking-machine.jpg",                    "The Thinking Machine Jensen Huang Stephen Witt"),
    (32, "32-how-the-internet-happened.jpg",               "How the Internet Happened Brian McCullough"),
    (42, "42-why-greatness-cannot-be-planned.jpg",         "Why Greatness Cannot Be Planned Stanley Lehman"),
    (44, "44-persuasive-technology.jpg",                   "Persuasive Technology BJ Fogg"),
    (45, "45-the-man-who-remade-india.jpg",                "The Man Who Remade India Vinay Sitapati"),
    (50, "50-boom-bubbles-and-the-end-of-stagnation.jpg",  "Boom Bubbles End Stagnation Byrne Hobart"),
    (54, "54-poor-charlie-s-almanack.jpg",                 "Poor Charlie's Almanack Charlie Munger"),
]

# Re-fetch wrong matches with explicit ISBN-style targeting via Google Books
REPLACE = [
    (1, "01-man-s-search-for-meaning.jpg",  "Man's Search for Meaning Viktor Frankl"),
    (2, "02-the-three-body-problem.jpg",    "The Three-Body Problem Liu Cixin first book"),
]


def google_books_cover_url(query: str):
    url = (
        "https://www.googleapis.com/books/v1/volumes?q="
        + urllib.parse.quote(query)
        + "&maxResults=3"
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as e:
        print(f"   query failed: {e}")
        return None, None
    for item in data.get("items", []):
        info = item.get("volumeInfo", {})
        links = info.get("imageLinks", {})
        # prefer larger sizes if available
        for key in ("extraLarge", "large", "medium", "thumbnail", "smallThumbnail"):
            if key in links:
                # Google sometimes returns http; force https. Strip ?edge=curl etc.
                cover = links[key].replace("http://", "https://")
                cover = re.sub(r"&edge=curl", "", cover)
                # bump zoom for thumbnail-only results
                cover = re.sub(r"zoom=\d+", "zoom=1", cover)
                return cover, info.get("title")
    return None, None


def download(url: str, dest: Path) -> bool:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
        if len(data) < 2000:
            return False
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"   download failed: {e}")
        return False


def run(jobs, label):
    print(f"\n=== {label} ===")
    for idx, filename, query in jobs:
        dest = COVERS_DIR / filename
        cover_url, matched = google_books_cover_url(query)
        time.sleep(0.5)
        if not cover_url:
            print(f"  {idx:02d}. NO MATCH    {query}")
            continue
        ok = download(cover_url, dest)
        marker = "ok" if ok else "DOWNLOAD FAILED"
        print(f"  {idx:02d}. {marker}   {query}   [matched: {matched!r}]")


if __name__ == "__main__":
    run(MISSES, "MISSES via Google Books")
    run(REPLACE, "REPLACEMENTS via Google Books")

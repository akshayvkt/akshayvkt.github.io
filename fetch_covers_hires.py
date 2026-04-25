"""Re-fetch specific low-res covers from Apple iTunes (high quality)."""

import json
import urllib.parse
import urllib.request
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COVERS_DIR = ROOT / "covers"
UA = "akshayvkt.github.io cover-fetcher (contact: venkatakshay98@gmail.com)"

# (idx, filename, search term)
TARGETS = [
    (1,  "01-man-s-search-for-meaning.jpg",  "Man's Search for Meaning Frankl"),
    (2,  "02-the-three-body-problem.jpg",    "The Three-Body Problem Liu Cixin"),
    (7,  "07-the-founders.jpg",              "The Founders Jimmy Soni PayPal"),
    (12, "12-consider-phlebas.jpg",          "Consider Phlebas Iain Banks"),
    (44, "44-persuasive-technology.jpg",     "Persuasive Technology BJ Fogg"),
]


def itunes_cover(term: str):
    url = (
        "https://itunes.apple.com/search?"
        + urllib.parse.urlencode({"term": term, "entity": "ebook", "limit": 3})
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    for r in data.get("results", []):
        artwork = r.get("artworkUrl100")
        if artwork:
            # iTunes lets you ask for any size by replacing the 100x100bb token
            return artwork.replace("100x100bb", "1500x1500bb"), r.get("trackName")
    return None, None


def download(url: str, dest: Path) -> bool:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    if len(data) < 5000:
        return False
    dest.write_bytes(data)
    return True


for idx, fname, term in TARGETS:
    cover_url, matched = itunes_cover(term)
    time.sleep(0.4)
    dest = COVERS_DIR / fname
    if not cover_url:
        print(f"  {idx:02d}. NO MATCH on iTunes  '{term}'")
        continue
    ok = download(cover_url, dest)
    print(f"  {idx:02d}. {'ok' if ok else 'FAIL'}  {term}   -> {matched!r}")

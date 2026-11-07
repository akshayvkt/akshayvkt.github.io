// The pages of the room: which camera each shows, how it lays that view out on the first screen, and the
// points of the room it lines up with the desk view, so the homepage's zoom lands each object exactly where
// the page will draw it (shared/transition.js). The pages mount their views with these same options.
//
//   import { PAGES, pageFor, heroBox } from "/shared/pages.js";
//   mountRoom(el, "books", PAGES.books.opts);
import { bbox, cssCorners } from "./room.js";

// The first screen of every page (and of the homepage): the room fills it, the masthead sits at its bottom.
// Same as the homepage's .scene: 100svh, at least 520px.
let probe = null;
export function heroBox() {
  if (!probe) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;left:0;top:0;width:1px;height:100svh;visibility:hidden;pointer-events:none";
    document.documentElement.append(probe);
  }
  return { w: document.documentElement.clientWidth || innerWidth, h: Math.max(520, probe.offsetHeight || innerHeight) };
}

// Room the masthead takes at the bottom of the first screen (it is the same on every page).
export function mastheadHeight() {
  const m = document.querySelector(".masthead");
  const h = m ? m.getBoundingClientRect().height : 0;
  return Math.round(h || 96);
}

const isBook = ([k]) => k.startsWith("book:");
const centre = (poly) => { const b = bbox(poly); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
const allBooks = (v) => Object.entries(v.hotspots || {}).filter(isBook).flatMap(([, p]) => p);
const inside = (poly) => poly.every(([x, y]) => x > 0.002 && x < 0.998 && y > 0.002 && y < 0.998);
const corners = (q) => { const c = cssCorners(q); return { tl: c[0], tr: c[1], br: c[2], bl: c[3] }; };
const wide = (box) => box.w > 760 && box.w / box.h > 1.1;   // the same test as the pages' "wide" media queries

// The book card column on wide screens (books/index.html .reader), so the shelf stays clear of it.
export const cardColumn = (box) => Math.min(560, Math.max(340, box.w * 0.36));

// DYS-29 mock (?shelfmock=a|b|c): prototype layouts of the Books shelf for Akshay to pick from (books/page.js; the live
// camera's framing in shared/router.js). The live room keeps the switch on <html data-shelfmock> from its first address,
// as the address loses its query when the camera glides to the shelf (/books/). Without the switch: null, nothing changes.
// DYS-29 (Akshay 28 Oct): he picked (a), and it is the shelf now (no switch): the names below keep the mock's.
export function shelfMock() {
  return "a";
}

// DYS-200 (Akshay 31 Oct: "the selection thing moves with the book - shouldnt it stay at the same place?"): the book card
// has one place (books/index.html .shelfmock .held, the same numbers; router.js shelfCardReserve, a copy). Pure, so the
// tests can hold it: { w, h } the screen (CSS px), mh the masthead's height; the box { x, y, w, h } on the first screen
// (max(520, h) tall, world.css --hero-h):
//   - wide screens: a 420 x 240 panel at the left (the reader's own left margin), vertically centred over the masthead;
//   - phones and tall screens: a strip along the bottom, 8 px over the masthead, at most 560 px wide, 236 px tall.
// (DYS-229: each book's one line under the author made the panel 420 x 240, was 360 x 184, the size the longest book
// needs at full title size, measured per book in Chrome; the strip is one height for every book, 236 px, so it doesn't
// move on next / previous: the most a 375 px phone's longest line needs (233), measured in WebKit)
// (The masthead's box carries the home bar's inset itself, world.css; safeBottom is for a first screen without it.)
export function cardSpot({ w, h, mh = 96, safeBottom = 0 }) {
  const hero = Math.max(520, h);
  if (wide({ w, h })) return { x: Math.min(84, Math.max(28, w * 0.044)), y: (hero - mh) / 2 - 120, w: 420, h: 240 };
  const cw = Math.min(w - 24, 560);
  return { x: (w - cw) / 2, y: hero - mh - 8 - safeBottom - 236, w: cw, h: 236 };
}
// The part of the first screen the shelf is framed clear of (shared/room.js layoutView reserve; the live room's framing
// keeps clear of the same, router.js reserveFor): right of the panel, 32 px on; above the strip, 8 px on.
export function shelfCardReserve(box, mh = mastheadHeight()) {
  const c = cardSpot({ w: box.w, h: box.h, mh });
  return wide(box) ? { left: c.x + c.w + 32, bottom: mh + 8 } : { bottom: Math.max(520, box.h) - c.y + 8 };
}
// The book the shelf opens at without one in the address: the one standing face-out, in the row at eye height (since
// v3/book-gita, The Bhagavad Gita; router.js SHELF_FIRST)
export const SHELF_FIRST = "30-bhagavad-gita";

export const PAGES = {
  books: {
    path: "/books/",
    view: "books",
    hotspot: "books",
    opts: {
      // every book on the shelf in sight, clear of the masthead and (wide screens) of the book card
      keep: (v) => { const all = allBooks(v); return all.length ? bbox(all) : null; },
      focus: (v) => { const all = allBooks(v); return all.length ? centre(all) : null; },
      keepMargin: 0.03,
      // (DYS-29 mock: no column kept for the card, the shelf has the whole view; DYS-200: clear of the card's one place)
      reserve: (v, box) => (shelfMock() ? shelfCardReserve(box) : { bottom: mastheadHeight() + 8, left: wide(box) ? cardColumn(box) : 0 }),
    },
    // the books seen whole from both the desk and the shelf
    anchors: (v) => Object.fromEntries(Object.entries(v.hotspots || {}).filter(isBook).filter(([, p]) => p.length > 2 && inside(p)).map(([k, p]) => [k, centre(p)])),
  },
  quotes: {
    path: "/quotes.html",
    view: "quotes",
    hotspot: "quote",
    opts: {
      // the whole frame, from its top rail to its foot, clear of the masthead; the bridge comes with it
      keep: (v) => {
        const q = v.quads && v.quads.print;
        if (!q) return null;
        const p = bbox(q), f = v.hotspots && v.hotspots.quote && v.hotspots.quote.length > 2 ? bbox(v.hotspots.quote) : null;
        return f ? [Math.min(p[0], f[0]), Math.min(p[1], f[1]), Math.max(p[2], f[2]), Math.max(p[3], f[3])] : [p[0], p[1] - (p[3] - p[1]) * 0.18, p[2], p[3] + (p[3] - p[1]) * 0.12];
      },
      keepMargin: (v, box) => (wide(box) ? 0.06 : 0.1),
      focus: (v) => (v.quads && v.quads.print ? centre(v.quads.print) : null),
      reserve: () => ({ bottom: mastheadHeight() + 8 }),
    },
    anchors: (v) => (v.quads && v.quads.print ? corners(v.quads.print) : {}),
    // the zoom's picture of this page carries the quote on the print too, as the page will
    decorate: async (layer, v, geo) => {
      const q = v.quads && v.quads.print;
      if (!q) return;
      const { mountPrint, dailyQuote } = await import("./print.js");
      const P = cssCorners(q).map(([x, y]) => [geo.left + x * geo.w, geo.top + y * geo.h]);
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const print = mountPrint(layer);
      print.place(P, (d(P[0], P[1]) + d(P[3], P[2])) / 2, (d(P[0], P[3]) + d(P[1], P[2])) / 2);
      print.set(await dailyQuote(), { animate: false });
    },
  },
  projects: {
    path: "/projects/",
    view: "projects",
    hotspot: "laptop",
    opts: {
      // the screen a touch above the middle, clear of the masthead
      keep: (v) => (v.quads && v.quads.screen ? bbox(v.quads.screen) : null),
      focus: (v) => (v.quads && v.quads.screen ? centre(v.quads.screen) : null),
      keepMargin: (v, box) => (wide(box) ? 0.08 : 0.04),
      reserve: () => ({ bottom: mastheadHeight() + 8 }),
    },
    anchors: (v) => (v.quads && v.quads.screen ? corners(v.quads.screen) : {}),
  },
};

const norm = (p) => (p.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/");
export function pageFor(path) {
  const n = norm(new URL(path, location.href).pathname);
  return Object.values(PAGES).find((p) => norm(p.path) === n) || null;
}

// Left-to-right order of where you look from the chair: the shelf, the laptop, the window, the print.
// Header links between pages turn the head this way (shared/transition.js).
export const BEARING = { "/books": -2, "/projects": -1, "/": 0, "/quotes.html": 1 };
export function bearingOf(path) {
  const n = norm(new URL(path, location.href).pathname);
  return n in BEARING ? BEARING[n] : null;
}

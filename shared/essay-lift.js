// The essay page lifts out of the notebook (brief essay-lift.md; a prototype for Akshay's try on v3/essay-lift, nothing
// here merges). A title tapped in the notebook's list:
//   (a) the pages turn to the essay's page: two quick turns of the real 3D page turn (pageturn.js), the list's next leaf
//       and then the essay's own page, laid out as the reading page is, in miniature (the same measure, the same breaks);
//   (b) that page lifts off the notebook and comes toward you, straightening as it comes, until it faces you flat and
//       fills the view: a real sheet of paper (DOM) placed every frame on a quad that moves in the room, from the
//       notebook's right page to a plane in front of the eye whose picture is exactly the reading column; it starts
//       with the room's own light on it (read from the engine's frame of that page), which fades to even paper as it
//       comes; the room dims a little behind it (no blur);
//   (c) at the end of the move it IS the reading view (the same element, its last placement the column itself: no swap).
// Reading: flat, even, today's reader's size or a little larger (22 px / 19.5 px phones), a 64-72 character measure,
// a cool off-white paper with a barely-there grain; "< Back to the notebook" (a chevron, Akshay 25 Oct) at the top, always reachable; Esc and the
// back gesture close too.
// Close: the reverse (the page scrolls back to its top as it floats down and tilts into the notebook, the room's light
// comes back on it); the notebook is already on the spread that lists the essay, and the page's words give way to the
// list's (DYS-160: no turns back).
//
//   loaded by the router at the first tap on a notebook title: this.essayLift = (await import("/shared/essay-lift.js")).install(router)
//   lift.open(slug) / lift.close(); lift.state: closed | riffle | lifting | open | closing | settling
import { project, ray, basis } from "/shared/rig.js";
import { quadToQuad, cssMatrix } from "/shared/overlays.js";

const LIFT_MS = 850, RIFFLE_MS = 380, SCROLL_BACK = 0.4;
// (DYS-160) the landed page's words into the list's: a cross-fade, a little longer than the page turn's hand-over
// (pageturn.js INK_FADE_MS 120)
const SETTLE_MS = 200;
const SERIF = '"Cormorant Garamond", "Cormorant", Garamond, serif';
const SANS = '"Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
const INK = "#1f1b17";
// white, the About + Projects page's own (its :root and body background #fff, at every hour: projects/screen.js
// setScheme), with no grain (DYS-28, Akshay 28 Oct: 'white background like our homepage, not whatever the cream stuff is')
const PAPER = { day: "#fff", night: "#fff" };
const DIM = { day: "rgba(12, 14, 18, 0.30)", night: "rgba(2, 3, 5, 0.44)" };
// the reading page's proportions (the essay's page in the notebook takes the same, in miniature): type and padding
// as fractions of the page's width
export const LAYOUT = {
  // (DYS-35, Akshay: 'the essay body is larger than it needs to be'. 22 > 20 px and 19.5 > 19 px, weight 500 > 400: by
  // the same paragraph rendered in the real faces, Cormorant 20 / 400 breaks its lines as Georgia 18 does, the usual
  // long-form body on a laptop, and 19 / 400 as Georgia 17 on a phone; renders/essay-size/body-sizes.png)
  // (DYS-34, Akshay: the column centred on the page, its title, subtitle and date centred above it; the body stays
  // flush left; "< Back to the notebook" stays where it was: back, the old left margin)
  desk: { maxW: 780, fs: 20 / 780, pad: [0.135, 0.105, 0.12, 0.105], back: 0.12 },   // top right bottom left: a 616 px measure
  phone: { fs: 19 / 390, pad: [0.2, 0.07, 0.16, 0.07], back: 0.075 },              // the whole screen: a 335 px measure
};

const CSS = `
.el-root { position: fixed; inset: 0; z-index: 60; pointer-events: auto; }
.el-root[hidden] { display: none; }
.el-scrim { position: absolute; inset: 0; opacity: 0; }
.el-sheet { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; box-sizing: border-box;
  background-color: var(--el-paper);
  box-shadow: inset 0 0 0 1px rgba(40, 44, 48, 0.05), 0 0 22px rgba(0, 0, 0, 0.10); will-change: transform; }
.el-lit { position: absolute; left: 0; top: 0; width: 100%; pointer-events: none; }
.el-scroll { position: absolute; inset: 0; overflow: hidden; overscroll-behavior: contain; outline: none; }
.el-root[data-state="open"] .el-scroll { overflow-y: auto; -webkit-overflow-scrolling: touch; }
.el-bar { position: sticky; top: 0; z-index: 2; height: 0; }
/* the bar's paper: a full-width strip behind the button once the page has scrolled (E2: the words ran beside it) */
.el-bar::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 60px; background: var(--el-paper);
  box-shadow: 0 1px 0 rgba(31, 27, 23, 0.08); opacity: 0; transition: opacity 0.18s ease; pointer-events: none; }
.el-root[data-scrolled] .el-bar::before { opacity: 1; }
@media (max-width: 640px) { .el-bar::before { height: calc(64px + env(safe-area-inset-top)); } }
.el-back { position: absolute; left: var(--el-padl); top: 14px; display: inline-flex; align-items: center; gap: 0.5em;
  padding: 9px 14px 9px 10px; margin-left: -10px; border: 0; border-radius: 2px; background: var(--el-paper); color: ${INK};
  font: 500 14px/1 ${SANS}; letter-spacing: 0.01em; cursor: pointer; opacity: 0; transition: opacity 0.22s ease;
  -webkit-tap-highlight-color: transparent; }
.el-back:hover span, .el-back:focus-visible span { text-decoration: underline; text-underline-offset: 0.22em; text-decoration-thickness: 1px; }
.el-back:focus-visible { outline: 1.5px solid rgba(31, 27, 23, 0.5); outline-offset: 2px; }
.el-root[data-state="open"] .el-back { opacity: 1; }
@media (max-width: 640px) { .el-back { top: max(10px, env(safe-area-inset-top)); padding: 13px 16px 13px 12px; font-size: 15px; } }

/* the essay: one layout for the reading page and its miniature on the notebook's leaf (all in em and % of the width) */
.el-sheet .el-art { mix-blend-mode: multiply; }   /* the ink on the paper (and its light), as the notebook's ink is */
:is(.el-sheet, .sfw-nb .el-leaf) .el-art { box-sizing: border-box; width: 100%; padding: var(--el-pad); font-family: ${SERIF};
  font-size: var(--el-fs); font-style: normal; font-weight: 400; line-height: 1.6; color: ${INK}; letter-spacing: 0;
  font-kerning: normal; hanging-punctuation: first; overflow-wrap: break-word; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art > * { display: block; margin: 0 0 1em; padding: 0; font-size: 1em; font-weight: 400;
  font-style: normal; line-height: 1.6; color: ${INK}; letter-spacing: 0; font-variant-numeric: oldstyle-nums; text-wrap: pretty; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art > .el-h1 { text-align: center; font-weight: 500; font-size: 2.05em; font-style: italic; line-height: 1.08; margin: 0 0 0.32em; text-wrap: balance; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art > .el-sub { text-align: center; font-size: 1.08em; line-height: 1.35; color: #5d5852; margin: 0 0 0.5em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art > .el-date { text-align: center; font-size: 0.64em; letter-spacing: 0.06em; text-transform: uppercase; color: #6c6760;
  font-variant-numeric: lining-nums; margin: 0 0 2.4em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art > h2, :is(.el-sheet, .sfw-nb .el-leaf) .el-art > h3 { font-weight: 600; font-size: 1.3em; line-height: 1.25; margin: 1.6em 0 0.6em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art > blockquote { padding-left: 1.1em; border-left: 1px solid rgba(31, 27, 23, 0.25); font-style: italic; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art em { font-style: italic; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art a { color: inherit; text-decoration: underline; text-decoration-thickness: 0.06em; text-underline-offset: 0.18em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art img, :is(.el-sheet, .sfw-nb .el-leaf) .el-art video { display: block; max-width: 100%; height: auto; margin: 0 auto; }
/* (DYS-103) photos side by side and a quoted post's card, as the reading sheet lays them out (reader.css .rd-row and
   .rd-card; reader.js decorate() marks the figures and gives each photo its share of the column, liftPhotos below),
   across this page's column: the sheet's px over its 20 px body (19 px on phones) in em, so the leaf's miniature is the
   same layout. A row stays side by side on phones, as it does in the sheet; its photos at one height (top-aligned: a
   photo the naturalWidth cap holds back is never stretched) */
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.3em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-row > img { min-width: 0; width: 0; flex-basis: 0; height: auto; margin: 0; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-row > figcaption { flex: 1 0 100%; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3em;
  padding: 0.9em 1em 0.8em; border: 1px solid rgba(31, 27, 23, 0.12); border-radius: 0.6em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > blockquote { grid-column: 1 / -1; margin: 0 0 0.5em; padding: 0; border: 0;
  font: 400 0.75em/1.55 ${SANS}; color: ${INK}; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > blockquote p { margin: 0 0 0.92em; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > blockquote p:last-child { margin-bottom: 0; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 0.3em; margin: 0; }
:is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > figcaption { grid-column: 1 / -1; margin-top: 0.4em; text-align: left;
  font: 400 0.625em/1.5 ${SANS}; color: #6c6760; }
@media (max-width: 640px) {
  :is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-row { gap: 0.21em; }
  :is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card { padding: 0.74em 0.74em 0.63em; border-radius: 0.63em; }
  :is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > blockquote { font-size: 0.79em; }
  :is(.el-sheet, .sfw-nb .el-leaf) .el-art figure.rd-card > figcaption { font-size: 0.66em; }
}
.el-sheet .el-end { margin-top: 2.6em; font: 400 13px/1.5 ${SANS}; color: #6c6760; }
.el-sheet .el-orig { display: inline-flex; padding: 8px; margin-left: -8px; color: #6c6760; }
.el-sheet .el-orig:hover, .el-sheet .el-orig:focus-visible { color: ${INK}; }
.sfw-nb .el-leaf { padding: 0; overflow: hidden; }
`;

const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return (1 - Math.cos(Math.PI * x)) / 2; };   // in-out (a sine: it starts moving at once), no overshoot
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]), norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};
// rotations as quaternions [x, y, z, w]: from a frame's columns, slerp, and the frame back
function quatOf(X, Y, Z) {
  const m00 = X[0], m11 = Y[1], m22 = Z[2], tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(Y[2] - Z[1]) / s, (Z[0] - X[2]) / s, (X[1] - Y[0]) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (Y[0] + X[1]) / s, (Z[0] + X[2]) / s, (Y[2] - Z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(Y[0] + X[1]) / s, 0.25 * s, (Z[1] + Y[2]) / s, (Z[0] - X[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(Z[0] + X[2]) / s, (Z[1] + Y[2]) / s, 0.25 * s, (X[1] - Y[0]) / s]; }
  const l = Math.hypot(...q); return q.map((v) => v / l);
}
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; }
  if (d > 0.9995) { const q = a.map((v, i) => v + (b[i] - v) * t); const l = Math.hypot(...q); return q.map((v) => v / l); }
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((v, i) => (v * Math.sin((1 - t) * th) + b[i] * Math.sin(t * th)) / s);
}
function rotate(q, v) {
  const [x, y, z, w] = q, u = [x, y, z];
  const t = V.mul(V.cross(u, v), 2);
  return V.add(V.add(v, V.mul(t, w)), V.cross(u, t));
}
const frames = (n) => new Promise((r) => { const f = () => (n-- <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const night = () => document.documentElement.dataset.scheme === "dark";

// ---------------------------------------------------------------- the lift's geometry (pure: scripts/live/essay_lift_sim.mjs tests it)
// The notebook's right page (room metres), the target column on screen, the eye: everything the lift's frames need.
// boxAspect: the notebook's text box's height over its width (its layout box: the page as seen on screen, foreshortened);
// the sheet starts at that shape, so its first frame lays the words where the notebook's leaf has them
export function liftGeometry({ room, pose, w, h, phone, boxAspect = null }) {
  const B = basis(pose.yaw, pose.pitch);
  const q = room.objects.notebook_page.quad;
  // (DYS-28, Akshay 28 Oct, option b: the paper lifts from the notebook and widens to the whole window, laptops and
  // phones; on a laptop the text keeps the 780 px sheet's centred column and type: install's column)
  const Wt = w, Ht = h, left = 0;
  const X0 = V.norm(V.sub(q[1], q[0]));
  let Y0 = V.sub(q[3], q[0]); Y0 = V.norm(V.sub(Y0, V.mul(X0, V.dot(Y0, X0))));
  const Z0 = V.cross(X0, Y0);
  const pw = V.len(V.sub(q[1], q[0])), ph = V.len(V.sub(q[3], q[0]));
  const C0 = V.mul(q.reduce((s, p) => V.add(s, p), [0, 0, 0]), 0.25);
  // the target: a plane square to the eye's look, nearer than the page, whose picture is the column [left, left + Wt] x [0, h]
  const D = 0.62 * V.dot(V.sub(C0, pose.eye), B.f);
  const at = (x, y) => { const r = ray(pose, x, y, w, h); return V.add(pose.eye, V.mul(r.d, D / V.dot(r.d, B.f))); };
  const T = [at(left, 0), at(left + Wt, 0), at(left + Wt, Ht), at(left, Ht)];
  const X1 = V.norm(V.sub(T[1], T[0])), Y1 = V.norm(V.sub(T[3], T[0])), Z1 = V.cross(X1, Y1);
  const C1 = V.mul(T.reduce((s, p) => V.add(s, p), [0, 0, 0]), 0.25);
  const up = V.dot(Z0, V.sub(pose.eye, C0)) > 0 ? Z0 : V.mul(Z0, -1);   // the page's face toward the eye
  const Hs = Wt * (boxAspect || ph / pw);
  return { w, h, pose, q, Wt, Ht, left, Hs, s0: pw / Wt, sy0: ph / Hs, s1: V.len(V.sub(T[1], T[0])) / Wt,
    C0, C1, R0: quatOf(X0, Y0, Z0), R1: quatOf(X1, Y1, Z1), up };
}
// The sheet at e (0: on the notebook, 1: the column): its box's height and its corners, in the room and on screen.
export function liftCorners(G, e) {
  const er = smooth((e - 0.06) / 0.86);                        // it lifts first, then turns square to the eye
  const R = slerp(G.R0, G.R1, er);
  const s = G.s0 * Math.pow(G.s1 / G.s0, e);                    // metres a box pixel, across
  const sy = (G.sy0 ?? G.s0) * Math.pow(G.s1 / (G.sy0 ?? G.s0), e); // and down (from the notebook box's shape to the page's own)
  const hb = G.Hs + (G.Ht - G.Hs) * smooth((e - 0.15) / 0.85); // the page grows to the view's height as it comes
  const C = V.add(V.lerp(G.C0, G.C1, e), V.mul(G.up, 0.035 * Math.sin(Math.PI * Math.min(1, e * 1.25))));
  const X = rotate(R, [1, 0, 0]), Y = rotate(R, [0, 1, 0]);
  const hx = V.mul(X, (G.Wt * s) / 2), hy = V.mul(Y, (hb * sy) / 2);
  // (the centre at the start is the page's middle with the box at the page's own height; as the box grows, the top
  // edge moves with the page, so the centre moves down by the growth's half)
  const grow = V.mul(Y, ((hb - (G.Hs + (G.Ht - G.Hs) * e)) * sy) / 2);
  const Cc = V.add(C, grow);
  const W4 = [V.sub(V.sub(Cc, hx), hy), V.sub(V.add(Cc, hx), hy), V.add(V.add(Cc, hx), hy), V.add(V.sub(Cc, hx), hy)];
  const S = W4.map((p) => project(G.pose, p, G.w, G.h));
  return { hb, W4, S: S.some((p) => !p) ? null : S };
}

// ---------------------------------------------------------------- the page's article (DOM, no layout: scripts/live/essay_rows_sim.mjs tests it)
// (DYS-151 memory) Media taken out of the page let go of what they hold now: a <video> its player and buffers, an <img>
// its decoded picture. Out of the page they keep them until a full garbage collection, which with the JIT (any https
// page) can be many essays away (MH1/DM, WebKit as an iPhone 13 over https: every essay's video stayed alive).
function unload(media) {
  for (const m of media) {
    if (m.localName === "video") { m.pause(); m.removeAttribute("src"); m.load(); }
    else { m.removeAttribute("srcset"); m.removeAttribute("src"); }
  }
}

// The reader's rendered essay (reader.js render(): its header and .rd-body) as this page's article: the title, subtitle
// and date, the body's blocks moved over as they are (decorate()'s figure.rd-row / figure.rd-card and their photos' sizes
// with them), the photos fitted (liftPhotos).
export function liftArticle(ra, post) {
  const a = document.createElement("article"); a.className = "el-art";
  const h1 = document.createElement("h1"); h1.className = "el-h1"; h1.textContent = post.title; a.append(h1);
  if (post.subtitle) { const s = document.createElement("p"); s.className = "el-sub"; s.textContent = post.subtitle; a.append(s); }
  if (post.date) { const d = ra.querySelector(".rd-date"); const t = document.createElement("p"); t.className = "el-date"; t.textContent = d ? d.textContent : post.date; a.append(t); }
  const body = ra.querySelector(".rd-body");
  if (body) a.append(...body.childNodes);
  liftPhotos(a);
  return a;
}
// The column's sizes: a photo laid out alone spans the page's column (616 px on a laptop, 0.86 of a phone's width: a
// little under these, so the copy the browser picks is never too small)
export const COLUMN_SIZES = "(max-width: 640px) 100vw, 684px";
// a photo of a row of photos or of a quoted post's card (decorate(): the figure's own <img>s), laid out side by side by
// the CSS above (DYS-103)
export const sideBySide = (im) => !!im.parentElement?.matches("figure.rd-row, figure.rd-card");
export function liftPhotos(a) {
  // (DYS-77 / DYS-103: decorate() gives a photo in a row or a card the sizes of its share of the column (165, 520,
  // 342 px), and it keeps them, as this page lays it out at that share; a photo laid out alone asks for the column's
  // copy. Either way its naturalWidth, which the cap below reads, is what its sizes ask for: never less than the width
  // it is laid out at)
  for (const im of a.querySelectorAll("img[srcset]")) if (!sideBySide(im)) im.sizes = COLUMN_SIZES;
  // (a photo smaller than its place, one without a srcset, is never stretched past its own pixels; the smoke's
  // reader.media)
  for (const im of a.querySelectorAll("img")) {
    const cap = () => { if (im.naturalWidth) im.style.maxWidth = `min(100%, ${im.naturalWidth}px)`; };
    if (im.complete) cap(); else im.addEventListener("load", cap, { once: true });
  }
}

export function install(nav) {
  if (!document.getElementById("el-css")) { const s = document.createElement("style"); s.id = "el-css"; s.textContent = CSS; document.head.appendChild(s); }
  const L = {
    state: "closed", slug: null, log: [],
    open: (slug) => open(slug).catch((e) => { console.error("[essay-lift]", e); restore(); }),
    close: (o) => close(o).catch((e) => { console.error("[essay-lift]", e); restore(); }),
    // (DYS-26) a refresh on an essay: the page already open, before the room is up; dismiss: gone at once (no room came)
    show: (slug) => show(slug).catch((e) => { console.error("[essay-lift]", e); restore(); throw e; }),
    dismiss: () => { if (L.shown) { L.shown = false; restore(); if (L.title) document.title = L.title; } },
    // (DYS-149) the page's DOM made ahead (hidden), once the room has landed at the notebook (the router's liftWarm)
    warm: () => buildRoot(),
  };
  let root, scrim, sheet, lit, scroller, art, back, pushed = false, run = null;
  const ix = () => nav.nbIndex, reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = () => nav.size()[0] <= 640;
  // (before the room starts the router has no size(): the hero's, else the window's)
  const viewSize = () => (nav.size ? nav.size() : [nav.hero?.clientWidth || innerWidth, nav.hero?.clientHeight || innerHeight]);
  const viewRect = () => (nav.live?.canvas || nav.hero)?.getBoundingClientRect() || { left: 0, top: 0 };
  const mark = (what) => L.log.push({ what, t: +performance.now().toFixed(1) });

  function buildRoot() {
    if (root) return;
    root = document.createElement("div"); root.className = "el-root"; root.hidden = true; root.dataset.state = "closed";
    scrim = document.createElement("div"); scrim.className = "el-scrim";
    sheet = document.createElement("div"); sheet.className = "el-sheet";
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    lit = document.createElement("div"); lit.className = "el-lit";
    scroller = document.createElement("div"); scroller.className = "el-scroll"; scroller.tabIndex = -1;
    const bar = document.createElement("div"); bar.className = "el-bar";
    back = document.createElement("button"); back.type = "button"; back.className = "el-back";
    back.innerHTML = '<svg viewBox="0 0 8 14" style="width:0.55em;height:0.95em;flex:none" aria-hidden="true"><path d="M6.5 1.5 1.5 7l5 5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Back to the notebook</span>';
    back.addEventListener("click", () => L.close());
    bar.append(back);
    scroller.append(bar);
    scroller.addEventListener("scroll", () => { if (scroller.scrollTop > 8) root.dataset.scrolled = ""; else delete root.dataset.scrolled; }, { passive: true });
    sheet.append(lit, scroller);
    root.append(scrim, sheet);
    document.body.append(root);
    // nothing here reaches the room behind (its drags, wheel zoom, taps)
    for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu",
      "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "keydown", "keyup"]) root.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    scrim.addEventListener("click", () => { if (L.state === "open") L.close(); });
    // Escape: closes the open page; while the page moves (the riffle, the lift, the close) it is swallowed, so the room's
    // own Escape (back to the desk) can't pull the camera away mid-move
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || L.state === "closed") return;
      // (DYS-149 review: pressed while the essay is still coming, the cover not up and nothing moved yet: the open is let
      // go and the room's own Escape goes on as at the notebook; swallowed, a stalled fetch held the page with no way out)
      if (L.fetching) { drop(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      if (L.state === "open") L.close();
      // (pressed while the page still turns or lifts: kept, and the page closes the moment it is open; dropped, a reopened
      // essay's Escape that came a little early was lost: D's deploy-1 walk)
      else if (L.state === "riffle" || L.state === "lifting") L.escWanted = true;
    }, true);
    addEventListener("popstate", (e) => { if (L.state === "open" && !(e.state && e.state.essayLift)) { pushed = false; L.close({ fromPop: true }); } });
  }

  // the essay, as the reader lays it out (its own sanitised HTML), in this prototype's page styles
  async function article(slug) {
    const reader = ix()?.reader || (await nav.startReader());   // (DYS-26: at a refresh the notebook isn't built yet)
    const { art: ra, post } = await reader.render(slug);
    return { a: liftArticle(ra, post), post };
  }

  const geometry = () => { const b = ix()?.surface?.box; return liftGeometry({ room: nav.room, pose: nav.rig.pose, w: nav.size()[0], h: nav.size()[1], phone: phone(), boxAspect: b && b[0] ? b[1] / b[0] : null }); };
  function place(G, e) {
    const { hb, S } = liftCorners(G, e);
    const cr = nav.live.canvas.getBoundingClientRect();
    if (!S) return false;
    sheet.style.height = `${hb.toFixed(2)}px`;
    if (e >= 1) sheet.style.transform = `translate(${(cr.left + G.left).toFixed(3)}px, ${cr.top.toFixed(3)}px)`;
    else {
      const H = quadToQuad([[0, 0], [G.Wt, 0], [G.Wt, hb], [0, hb]], S.map((p) => [p[0] + cr.left, p[1] + cr.top]));
      if (H) sheet.style.transform = cssMatrix(H);
    }
    lit.style.opacity = String(1 - smooth(e / 0.62));
    // (the page's edge and its soft shadow come with the lift: the notebook's page has neither; and go again as the paper
    // reaches the whole window: the open page is the page's own white, edge to edge)
    const k = smooth(e / 0.5) * (1 - smooth((e - 0.7) / 0.3));
    sheet.style.boxShadow = `inset 0 0 0 1px rgba(40, 44, 48, ${(0.05 * k).toFixed(4)}), 0 0 22px rgba(0, 0, 0, ${(0.1 * k).toFixed(4)})`;
    scrim.style.opacity = String(smooth(e));
    return true;
  }

  // the room's own light on the notebook's page, as the sheet's start: the page's picture as the visitor sees it (the
  // canvas, copied right after a frame is drawn, in the same task, so its buffer is still there), sampled on a 36 x 50
  // grid over the page. If the canvas can't be read, or the reading comes back black (E2: the engine's own capture on a
  // phone did), the sheet starts on its own paper. (No gl/qa.js: the published site leaves the QA hooks out, DP6.)
  async function litFrom(G) {
    const GX = 36, GY = 50;
    // the view's own veil over the page (style.css .veil: the bottom third darkens toward rgba(8, 6, 4, 0.55) so the
    // masthead reads; it lies over the notebook's page, under the sheet): laid into the light, so the sheet's first
    // frame is as dark at the page's foot as the page was (DP2: the foot brightened at the handover); it goes with the light
    const veilEl = nav.hero?.querySelector?.(".veil") || document.querySelector(".veil");
    const vb = veilEl && getComputedStyle(veilEl).visibility !== "hidden" && getComputedStyle(veilEl).display !== "none" ? veilEl.getBoundingClientRect() : null;
    const vo = vb ? +getComputedStyle(veilEl).opacity : 0;
    const cr0 = nav.live.canvas.getBoundingClientRect();
    const veil = (x, y) => { if (!vb || vb.height < 1 || !(vo > 0)) return 0; const f = (cr0.top + y - vb.top) / vb.height; return Math.max(0, Math.min(1, (f - 0.68) / 0.32)) * 0.55 * vo; };
    const grid = (read) => {
      const c = document.createElement("canvas"); c.width = GX; c.height = GY;
      const g = c.getContext("2d"), im = g.createImageData(GX, GY);
      let hi = 0;
      for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
        const u = (i + 0.5) / GX, v = (j + 0.5) / GY, q = G.q;
        const top = V.lerp(q[0], q[1], u), bot = V.lerp(q[3], q[2], u), s = project(G.pose, V.lerp(top, bot, v), G.w, G.h);
        let px = s ? read(s[0], s[1]) : null;
        const o = (j * GX + i) * 4;
        if (px) { const va = veil(s[0], s[1]); px = [px[0] * (1 - va) + 8 * va, px[1] * (1 - va) + 6 * va, px[2] * (1 - va) + 4 * va]; }
        im.data[o] = px ? px[0] : 230; im.data[o + 1] = px ? px[1] : 230; im.data[o + 2] = px ? px[2] : 230; im.data[o + 3] = 255;
        if (px) hi = Math.max(hi, px[0], px[1], px[2]);
      }
      g.putImageData(im, 0, 0);
      return { c, hi };
    };
    const avg = (data, W, H, X, Y, r) => {
      let a = 0, b = 0, cc = 0, n = 0;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        const xx = Math.round(X) + x, yy = Math.round(Y) + y;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const o = (yy * W + xx) * 4; a += data[o]; b += data[o + 1]; cc += data[o + 2]; n++;
      }
      return n ? [a / n, b / n, cc / n] : null;
    };
    let out = null, how = null;
    try {
      // the canvas as drawn: one frame now, copied at once (at a quarter of its CSS size: the grid needs no more)
      const cv = nav.live.canvas, W = Math.max(64, Math.round(G.w / 4)), H = Math.max(36, Math.round(G.h / 4));
      nav.engine._frame(performance.now());
      const k = document.createElement("canvas"); k.width = W; k.height = H;
      const kg = k.getContext("2d", { willReadFrequently: true });
      kg.drawImage(cv, 0, 0, W, H);
      const d = kg.getImageData(0, 0, W, H).data;
      out = grid((x, y) => avg(d, W, H, (x * W) / G.w, (y * H) / G.h, 1)); how = "canvas";
    } catch (e) { console.warn("[essay-lift] light (canvas)", e); }
    L.litHow = out && out.hi >= 12 ? how : "none (paper)";
    if (!out || out.hi < 12) { lit.style.background = "none"; return false; }
    lit.style.height = `${G.Hs}px`;
    lit.style.background = `url(${out.c.toDataURL()}) 0 0 / 100% 100% no-repeat`;
    return true;
  }

  // the notebook's leaves for the riffle: the list up to this leaf, the next list leaf (or a blank one), the essay's page
  // (two notebooks: v3/live's, one leaf at a time in nb.leaves; and page-turn2's book on the stage, its right-hand pages
  // in nb.sides, nb.leaf the spread, nb.show() putting a spread on the page)
  const pagesOf = (nb) => (nb.sides ? nb.sides : nb.leaves);
  function riffleLeaves(a) {
    const nb = ix(), c = nb.leaf, box = nb.surface.box[0], book = !!nb.sides;
    const list = pagesOf(nb);
    const keep = list.slice(0, c + 1);
    const filler = list[c + 1] || (() => { const l = document.createElement("div"); l.className = "nb-leaf"; l.appendChild(document.createElement("ol")); nb.el.appendChild(l); return l; })();
    for (const l of list.slice(c + 2)) l.remove();
    const leaf = document.createElement("div"); leaf.className = "nb-leaf el-leaf"; leaf.hidden = true;
    const lay = phone() ? LAYOUT.phone : LAYOUT.desk;
    leaf.style.setProperty("--el-fs", `${(box * lay.fs).toFixed(3)}px`);
    leaf.style.setProperty("--el-pad", lay.pad.map((p) => `${(box * p).toFixed(2)}px`).join(" "));
    const mini = a.cloneNode(true);
    // (DYS-151 memory: the leaf's copy of a video is never shown (its media go below, after the layout is read): without
    // its src it is not fetched a second time and gets no player of its own)
    for (const v of mini.querySelectorAll("video")) v.removeAttribute("src");
    const media = mini.querySelectorAll("img, video");
    leaf.append(mini);
    nb.el.appendChild(leaf);
    // the page's words for the 3D turn: the blocks on the page (the ones below its foot left out)
    leaf.hidden = false;
    const hgt = nb.el.offsetHeight;
    for (const b of [...mini.children]) { if (b.offsetTop > hgt) b.remove(); else b.classList.add(b.classList.contains("el-h1") ? "nb-tt" : "nb-d"); }
    for (const m of mini.querySelectorAll("img, video, figure")) m.remove();
    unload(media);   // (DYS-151 memory: and its photos let go of theirs, the ones below the page's foot too)
    leaf.hidden = true;
    if (book) { nb.sides = [...keep, filler, leaf]; nb.inkFor = null; nb.show(); }
    else { nb.leaves = [...keep, filler, leaf]; nb.leaves.forEach((l, i) => { l.hidden = i !== c; }); nb.inkFor = null; }
    // (DYS-149: their words go into the turn's ink, nb.ensureInk, a frame later: open())
    return c;
  }
  // the book's words fade in after a turn lands (page-turn2's cross-fade, --nb-dom): the sheet takes over once they are in
  const inkIn = async (nb) => {
    for (let k = 0; k < 60; k++) { const v = getComputedStyle(nb.el).getPropertyValue("--nb-dom").trim(); if (!v || +v >= 0.999) return k; await frames(1); }
    return 60;
  };
  const turned = async (nb) => { for (let k = 0; k < 240 && nb.turning; k++) await frames(1); };

  // the essay into the sheet, with the original's mark at its end
  function mount(a, post) {
    sheet.setAttribute("aria-label", post.title);
    if (art) { art.remove(); unload(art.querySelectorAll("img, video")); }   // (DYS-151 memory: the last essay's media)
    art = a;
    const end = document.createElement("p"); end.className = "el-end";
    // the original, as the reading sheet links it: Substack's mark, its name for screen readers (no new visible words)
    if (post.url) {
      const o = document.createElement("a"); o.href = post.url; o.target = "_blank"; o.rel = "noopener"; o.className = "el-orig"; o.setAttribute("aria-label", "Substack");
      o.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>';
      end.append(o);
    }
    scroller.append(art); art.append(end);
  }

  // (DYS-26, Akshay 28 Oct: a refresh on an essay landed on the old flat sheet and never came back into the notebook)
  // The page as the lift leaves it, at once: the reading column (the lift's end, liftGeometry: the view's own width and
  // height, no room needed), the scrim behind it over whatever the room shows yet (its photograph, its loading, the room
  // itself). The address stays the essay's (this entry is now the essay's: no push). Its close settles it into the
  // notebook once the room is there, as a lifted page does; before that, it goes and the notebook's list is the address.
  async function show(slug) {
    if (L.state !== "closed") return;
    buildRoot();
    const my = (run = {});
    L.state = "lifting"; L.slug = slug; L.log = []; L.escWanted = false; L.shown = true; L.from = undefined; L.vis = undefined; mark("show");
    const N = night();
    root.style.setProperty("--el-paper", N ? PAPER.night : PAPER.day);
    scrim.style.background = N ? DIM.night : DIM.day;
    const [w, h] = viewSize(), ph = w <= 640, lay = ph ? LAYOUT.phone : LAYOUT.desk;
    // (DYS-28: the whole window, as the lift leaves it; on a laptop the 780 px sheet's centred column and type and the
    // back link where a tapped essay has them, as open() lays them)
    const Wt = w, left = 0, C = ph ? Wt : Math.min(LAYOUT.desk.maxW, w - 48), side = (Wt - C) / 2;
    sheet.style.width = `${Wt}px`;
    sheet.style.setProperty("--el-fs", `${(C * lay.fs).toFixed(3)}px`);
    sheet.style.setProperty("--el-pad", lay.pad.map((p, i) => `${(C * p + (i % 2 ? side : 0)).toFixed(2)}px`).join(" "));
    sheet.style.setProperty("--el-padl", `${(C * lay.back + side).toFixed(2)}px`);
    const [{ a, post }] = await Promise.all([article(slug), document.fonts?.ready]);
    if (run !== my) return;
    mount(a, post);
    const cr = viewRect();
    sheet.style.height = `${h}px`;
    sheet.style.transform = `translate(${(cr.left + left).toFixed(3)}px, ${cr.top.toFixed(3)}px)`;
    lit.style.opacity = "0";
    sheet.style.boxShadow = "none";   // (the open page: white edge to edge, as the lift ends)
    scrim.style.opacity = "1";
    sheet.style.visibility = "";
    scroller.scrollTop = 0;
    root.hidden = false;
    document.documentElement.classList.add("rd-lock");
    history.replaceState({ ...(history.state || {}), essayLift: slug }, "", location.pathname + location.search + location.hash);
    pushed = false;
    L.title = document.title;
    document.title = `${post.title} · ${L.title}`;
    L.state = "open"; root.dataset.state = "open"; mark("open");
    scroller.focus({ preventScroll: true });
    if (L.escWanted) { L.escWanted = false; mark("escape kept"); L.close(); }
  }

  // the notebook's room is there to settle into: live, landed at the notebook, its list built, the camera still
  const roomAtNotebook = () => nav.mode === "live" && nav.spot === "notebook" && !!ix() && nav.rig?.spot === "notebook" && !nav.rig?.glide;

  async function open(slug) {
    // (DYS-149 review: another title tapped while the last tap's essay is still coming takes over from it: nothing of that
    // one is shown yet; the same title again is the same open, left to go on)
    if (L.fetching && slug !== L.slug) drop();
    if (L.state !== "closed" || !ix() || nav.spot !== "notebook") return;
    buildRoot();
    const nb = ix(), my = (run = {});
    L.state = "riffle"; L.slug = slug; L.log = []; L.escWanted = false; mark("tap");
    const N = night();
    root.style.setProperty("--el-paper", N ? PAPER.night : PAPER.day);
    scrim.style.background = N ? DIM.night : DIM.day;
    const G = geometry();
    const lay = phone() ? LAYOUT.phone : LAYOUT.desk;
    sheet.style.width = `${G.Wt}px`;
    // (on a laptop the type and the column as on the 780 px sheet, centred in the window's width)
    const C = phone() ? G.Wt : Math.min(LAYOUT.desk.maxW, G.w - 48), side = (G.Wt - C) / 2;
    sheet.style.setProperty("--el-fs", `${(C * lay.fs).toFixed(3)}px`);
    sheet.style.setProperty("--el-pad", lay.pad.map((p, i) => `${(C * p + (i % 2 ? side : 0)).toFixed(2)}px`).join(" "));
    sheet.style.setProperty("--el-padl", `${(C * lay.back + side).toFixed(2)}px`);
    // (DYS-149: the tap's work a frame at a time, the room drawn between: the page's light first, read from the canvas
    // as drawn now and before the essay is in the page (no layout of it forced here); the essay into the sheet a frame
    // later (laid out by that frame); the riffle's leaves the next; their words into the turn's ink and the first turn the
    // next. All in the tap's own task, WebKit's baseline (30 Oct) froze 0.2-0.6 s there, 1.8 s once on the phone profile)
    const lightP = litFrom(G);
    // (DYS-149 review, 30 Oct: the page's cover goes up once the essay is in hand, as on Deploy 9. Raised at the tap, a
    // slow or stalled fetch (a cold 3G phone, the warm-up skipped there) left every tap ignored and Escape swallowed until
    // it failed. While the essay comes, a tap on the notebook or the masthead reaches them, another title takes over and
    // Escape lets the open go: drop())
    L.fetching = true;
    await frames(0);
    if (run !== my) return;
    const [{ a, post }] = await Promise.all([article(slug), document.fonts?.ready]);
    if (run !== my) return;
    L.fetching = false;
    // (DYS-149 review: the room went on meanwhile, the masthead or a spot's link: the open is let go)
    if (nav.spot !== "notebook" || ix() !== nb) { drop(); return; }
    // (from here on the page's cover is up, still clear: no second tap or corner drag reaches the notebook mid-riffle)
    sheet.style.visibility = "hidden"; scrim.style.opacity = "0"; root.hidden = false; root.dataset.state = "riffle";
    mount(a, post);
    await frames(0);
    if (run !== my) return;
    // (a) the riffle: two turns of the real page, quick
    const c = riffleLeaves(a);
    L.from = c;
    await frames(0);
    if (run !== my) return;
    nb.ensureInk();
    if (!reduced() && nb.pages) {
      nb.pages.autoMs = RIFFLE_MS;
      for (let k = 0; k < 2; k++) { mark(`turn ${k + 1}`); if (!nb.turn(1)) break; await turned(nb); if (run !== my) return; }
      nb.pages.autoMs = null;
    } else if (nb.sides) { nb.leaf = nb.sides.length - 1; nb.show(); nb.pages?.setLeaf(nb.leaf, { reduced: true }); }
    else { nb.leaves.forEach((l, i) => { l.hidden = i !== nb.leaves.length - 1; }); nb.leaf = nb.leaves.length - 1; nb.pages?.setLeaf(nb.leaf); }
    L.inkWait = await inkIn(nb);
    await lightP;
    // (b) the lift: the sheet over the page, the notebook's ink of that page hands over to it in the same frame
    L.state = "lifting"; mark("lift");
    root.dataset.state = "lifting";
    document.documentElement.classList.add("rd-lock");
    scroller.scrollTop = 0;
    place(G, 0);
    sheet.style.visibility = "";
    await frames(1);
    L.vis = nb.el.style.visibility;
    nb.el.style.visibility = "hidden";
    // the essay's own address and the tab's title while it is open, as the reading sheet has them (shareable; Back closes);
    // the router and the reading sheet leave this entry alone (the notebook's spot; no reader state)
    if (history.state?.essayLift !== slug) { history.pushState({ ...(history.state || {}), essayLift: slug }, "", `/writing/${slug}`); pushed = true; }
    L.title = document.title;
    document.title = `${post.title} · ${L.title}`;
    const t0 = performance.now(), ms = reduced() ? 1 : LIFT_MS;
    await new Promise((res) => {
      const f = (t) => { if (run !== my) return res(); const x = Math.min(1, (t - t0) / ms); place(G, ease(x)); if (x < 1) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f);
    });
    if (run !== my) return;
    place(G, 1);
    // (c) it is the reading view
    L.state = "open"; root.dataset.state = "open"; mark("open");
    scroller.focus({ preventScroll: true });
    L.G = G;
    if (L.escWanted) { L.escWanted = false; mark("escape kept"); L.close(); }
  }

  async function close({ fromPop = false } = {}) {
    if (L.state !== "open") return;
    if (L.shown) {
      // (DYS-26) a page shown at a refresh: its entry becomes the notebook's list (no entry under it to go back to;
      // the Back gesture has already left it)
      L.shown = false;
      if (!fromPop) { const st = { ...(history.state || {}), sfw: 1, spot: "notebook" }; delete st.essayLift; history.replaceState(st, "", `/writing/${location.search}`); }
      if (!roomAtNotebook()) {
        // no room to settle into yet: the page fades, the room comes on to the notebook's list
        const my = (run = {});
        L.state = "closing"; root.dataset.state = "closing"; mark("close (no room)");
        root.style.transition = "opacity 0.22s ease"; root.style.opacity = "0";
        await new Promise((r) => setTimeout(r, reduced() ? 0 : 240));
        root.style.transition = ""; root.style.opacity = "";
        if (run !== my) return;
        restore();
        if (L.title) document.title = L.title;
        mark("closed");
        return;
      }
      // the notebook on the spread holding the essay's title, as a tap on it would have been (the notebook's own leaf is
      // wherever it was built at, the coordinator 28 Oct saw Back land on a later spread), its words hidden under the
      // page as a lifted page leaves them; then the usual close
      const nb = ix();
      nb.showSlug?.(L.slug);
      L.from = nb.leaf;
      L.vis = nb.el.style.visibility;
      nb.el.style.visibility = "hidden";
    }
    const nb = ix(), my = (run = {});
    L.state = "closing"; root.dataset.state = "closing"; mark("close");
    if (pushed) { pushed = false; history.back(); }
    // (DYS-160, Akshay's phone 29 Oct: the page landed on the essay's own leaf, then the pages turned back twice, through
    // the list's next spread, to the one listing it; the left page went from the turned leaves to the cover's inside on
    // the way) the notebook is on the spread that lists the essay before the page comes down: the page fills the view
    // now, so nothing shows the change, and it settles onto that spread's right-hand page
    toList(nb);
    const G = geometry();
    const s0 = scroller.scrollTop, t0 = performance.now(), ms = reduced() ? 1 : LIFT_MS;
    await new Promise((res) => {
      const f = (t) => {
        if (run !== my) return res();
        const x = Math.min(1, (t - t0) / ms);
        scroller.scrollTop = s0 * (1 - smooth(x / SCROLL_BACK));     // back to the page's top as it starts down
        place(G, ease(1 - x));
        if (x < 1) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    if (run !== my) return;
    // the page lies on the list's right-hand page: the notebook's own ink comes back under it and the page's words give
    // way to the list's (the page's light is the room's there: only the words change)
    L.state = "settling"; mark("settle");
    nb.el.style.visibility = L.vis ?? "visible";
    const f0 = performance.now(), fms = reduced() ? 1 : SETTLE_MS;
    await new Promise((res) => {
      const f = (t) => { if (run !== my) return res(); const x = Math.min(1, Math.max(0, (t - f0) / fms)); sheet.style.opacity = String(1 - smooth(x)); if (x < 1) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f);
    });
    if (run !== my) return;
    root.hidden = true; root.dataset.state = "closed";
    sheet.style.opacity = "";
    document.documentElement.classList.remove("rd-lock");
    restore();
    if (L.title) document.title = L.title;
    // the focus back on the essay's title in the notebook (as the reading sheet returns it)
    nb.linkFor?.(L.slug)?.focus({ preventScroll: true });
    mark("closed");
  }

  // (DYS-160 follow-up, the coordinator 30 Oct) the spread whose list holds the essay's title, as the notebook is laid out
  // now (notebook.js showSlug's mapping; the essay's own riffle leaf left out): a rotation changes the page's box, the
  // notebook re-paginates and keeps its leaf NUMBER, so the spread the essay was opened from (L.from) can then list other
  // titles; -1 when the title isn't in the list
  const leafOf = (nb, slug) => {
    if (!/^[a-z0-9-]+$/.test(slug || "")) return -1;
    const i = pagesOf(nb).findIndex((p) => !p.classList.contains("el-leaf") && p.querySelector(`a[data-slug="${slug}"]`));
    return i < 0 ? -1 : nb.sides && nb.both ? Math.ceil(i / 2) : i;
  };
  const listLeaf = (nb) => { const at = leafOf(nb, L.slug); return Math.max(0, Math.min(at >= 0 ? at : L.from ?? nb.leaf, pagesOf(nb).length - 1)); };
  // the notebook on spread s at once: its pages, the leaves turned onto the cover's inside and its hints
  const onSpread = (nb, s) => {
    nb.leaf = s;
    if (nb.sides) nb.show(); else nb.leaves.forEach((l, i) => { l.hidden = i !== s; });
    nb.pages?.setLeaf(s, { reduced: true });
  };

  // (DYS-160) the notebook at rest on the list's spread that lists the essay (the one it was opened from), at once (the
  // riffle's leaves stay in it until restore() rebuilds the list: no new ink is drawn while the page comes down)
  function toList(nb) {
    onSpread(nb, listLeaf(nb));
  }

  // (DYS-149 review) an open let go while its essay was still coming: nothing of it on screen (the cover not up, the
  // notebook untouched), so nothing to rebuild: closed
  function drop() {
    run = null; L.fetching = false; L.state = "closed";
    if (root) { root.hidden = true; root.dataset.state = "closed"; }
    mark("dropped");
  }

  // the list as it was (the notebook's own build keeps the leaf it is on)
  function restore() {
    const nb = ix();
    run = null; L.fetching = false;
    if (sheet) sheet.style.opacity = "";
    if (nb) {
      if (nb.pages) nb.pages.autoMs = null;
      if (L.vis !== undefined) nb.el.style.visibility = L.vis;
      nb.leaf = listLeaf(nb);
      nb.build();
      // (a build that re-paginates, the first since a rotation, can move the title to another spread)
      const now = leafOf(nb, L.slug);
      if (now >= 0 && now !== nb.leaf) onSpread(nb, now);
    }
    if (root) { root.hidden = true; root.dataset.state = "closed"; }
    document.documentElement.classList.remove("rd-lock");
    L.state = "closed";
  }

  window.__essayLift = L;
  return L;
}

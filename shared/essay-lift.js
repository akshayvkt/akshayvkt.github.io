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
// comes back on it) onto the essay's own page, then the pages turn back twice to the spread that lists it, at the
// riffle's pace (DYS-211, Akshay 1 Nov: the open played backwards; DYS-160's close, the notebook already on the list's
// spread under the page and its words giving way to the list's, is kept for reduced motion).
//
//   loaded by the router at the first tap on a notebook title: this.essayLift = (await import("/shared/essay-lift.js")).install(router)
//   lift.open(slug) / lift.close(); lift.state: closed | riffle | lifting | open | closing | settling
import { project, ray, basis } from "/shared/rig.js";
import { quadToQuad, cssMatrix } from "/shared/overlays.js";

const LIFT_MS = 850, RIFFLE_MS = 380, SCROLL_BACK = 0.4;
// (DYS-160) the landed page's words into the list's: a cross-fade, a little longer than the page turn's hand-over
// (pageturn.js INK_FADE_MS 120)
const SETTLE_MS = 200;
// (DYS-211) Back: the landed page off the notebook's own ink of the essay's page (the same words): the page turn's
// hand-over (INK_FADE_MS 120), before the turns back
const HAND_MS = 120;
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
// (DYS-149: the open's first frames, Akshay's phone 31 Oct: 23 fps in an essay open's first 0.3 s. GS2's traces, Chrome's
// mid phone: the open's first four frames were 25-80 ms, all this file's open(): an extra room frame drawn in the tap's
// task and the canvas read back in it (21-63 ms), the whole essay laid out in the sheet in one frame (23-65 ms), the
// riffle's leaf laid out from the whole essay with a layout a block (21-35 ms), the turn's ink in one task (20-79 ms))
// ?essaylift=0: that work as before; ?essaylift=check: as now, and the page's light also read the old way from the same
// frame, the two compared (the console's "essaylift check", window.__essayLiftCheck)
const ESSAY_LIFT = (() => { try { return new URLSearchParams(location.search).get("essaylift") ?? "1"; } catch { return "1"; } })();
const STEPS = ESSAY_LIFT !== "0";
// (DYS-149, EO1 31 Oct) the light's read: a GPU buffer read back later in Blink (Chrome's mid phone: the copy read back
// at once was 15-19 ms); the canvas copied at once in WebKit, whose first read into a GPU buffer took 209 ms (iPhone 13,
// the first open; 1 ms after). ?essaylift=buffer / canvas: that one everywhere (pageturn.js's Blink test)
const BLINK = (() => { try { const ua = navigator.userAgent || ""; return /Chrome\/|Chromium\//.test(ua) && !/iP(hone|ad|od)/.test(ua) && !(/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); } catch { return false; } })();
const LIGHT = ESSAY_LIFT === "buffer" || ESSAY_LIFT === "canvas" ? ESSAY_LIFT : BLINK ? "buffer" : "canvas";
// (the notebook's ?inksplit=0: its ink in one task, as before; the open's too)
const INK_ONE = (() => { try { return new URLSearchParams(location.search).get("inksplit") === "0"; } catch { return false; } })();
// (DYS-205 page-edge, Akshay's iPhone 31 Oct: a brownish band down the right of the page as it lifted and as it came back,
// dark blurred notches at even steps in it) the light's grid reads the paper only (lightGrid). ?pageedge=0: as before
const PAGE_EDGE = (() => { try { return new URLSearchParams(location.search).get("pageedge") !== "0"; } catch { return true; } })();
// (DYS-149, EO3 31 Oct) the essay's videos into the sheet with their poster only: no source (so no player made, no
// metadata fetched) and no controls, until the page is open (dress). EO3's Chrome mid phone traces: the tap's style
// recalc in riffleLeaves made the sheet's video's controls for the first time, 5 of their pictures (SVG documents)
// 6-9 ms of a 11-18 ms recalc on the first open; EO1, WebKit: a video's player made as it went into the page was a 62 ms
// frame. Their box is the same without either (width and height attributes). ?videolate=0: as before
const VIDEO_LATE = STEPS && (() => { try { return new URLSearchParams(location.search).get("videolate") !== "0"; } catch { return true; } })();
// (DYS-149) the essay's blocks into the sheet at the tap (the rest a few a frame while the pages turn: MOUNT_STEP), and
// the riffle's leaf's copy of the essay: its first blocks (MINI_FIRST, more while the last one still starts on the page)
const MOUNT_FIRST = 6, MOUNT_STEP = 6, MINI_FIRST = 14, MINI_MORE = 8;
// (DYS-149, EO1) the turn's ink steps after a frame: as many as fit in this many ms (one a frame held WebKit's first turn
// 7 frames, 110-130 ms, for steps of a ms or two)
const INK_MS = 6;
// (DYS-149) a task of its own just after the next frame is drawn (a message posted from inside the frame, notebook.js's
// afterFrame): an open step there leaves its layout to the next frame, not added to the one the room is drawing
const afterFrame = () => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); }));
// (DYS-149, EO3) a task when the page is idle (no rIC, WebKit: one just after a frame)
const idleTask = (f) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => f(), { timeout: 400 }) : afterFrame().then(f));
// (DYS-149, EO3 31 Oct) warmType's sample of an essay's page: each kind of block the page's styles lay out (the title,
// subtitle and date; paragraphs with italics, bold and a link; headings, a quotation, lists, a quoted post's card, a
// caption), in words with the faces' common letters, figures and marks; and a video as the reader gives it (reader.js
// decorate(): its controls), with no source (nothing fetched, no player)
const SAMPLE_WORDS = "The quick brown fox jumps over the lazy dog; sphinx of black quartz, judge my vow! Pack my box with five dozen liquor jugs (1234567890): “offices”, ‘affluent’ — 72% of 10–20… $40? Yes & no.";
const SAMPLE_TEXT = ((w) => `<h1 class="el-h1">How Vexingly Quick Daft Zebras Jump</h1><p class="el-sub">${w}</p><p class="el-date">Oct 31, 2026</p>` +
  `<p>${w} <em>${w}</em> <strong>${w}</strong> <a>${w}</a></p><h2>${w}</h2><h3>${w}</h3><blockquote><p>${w}</p></blockquote>` +
  `<ol><li>${w}</li></ol><ul><li>${w}</li></ul><figure class="rd-card"><blockquote><p>${w}</p></blockquote><figcaption>${w}</figcaption></figure>` +
  `<figure><figcaption>${w}</figcaption></figure>`)(SAMPLE_WORDS);
const SAMPLE_VIDEO = `<figure><video controls playsinline preload="none" width="1200" height="676" controlslist="nodownload noremoteplayback"></video><figcaption>${SAMPLE_WORDS}</figcaption></figure>`;
// a square of an image's pixels, its mean (data: RGBA rows of W): the light's grid reads the canvas's copy so
const avg = (data, W, H, X, Y, r) => {
  let a = 0, b = 0, cc = 0, n = 0;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    const xx = Math.round(X) + x, yy = Math.round(Y) + y;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const o = (yy * W + xx) * 4; a += data[o]; b += data[o + 1]; cc += data[o + 2]; n++;
  }
  return n ? [a / n, b / n, cc / n] : null;
};
// (DYS-149 / DYS-151 memory) the photos and videos in a list of nodes (and the nodes themselves)
const mediaIn = (nodes) => nodes.flatMap((n) => (n.nodeType !== 1 ? [] : [...(n.matches("img, video") ? [n] : []), ...n.querySelectorAll("img, video")]));

// ---------------------------------------------------------------- the lift's geometry (pure: scripts/live/essay_lift_sim.mjs tests it)
// The notebook's right page (room metres), the target column on screen, the eye: everything the lift's frames need.
// boxAspect: the notebook's text box's height over its width (its layout box: the page as seen on screen, foreshortened);
// the sheet starts at that shape, so its first frame lays the words where the notebook's leaf has them
// col: the reading column's width in the sheet (its type and breaks the leaf's, in proportion: riffleLeaves lays the
// leaf out at the page box's width with LAYOUT's fractions); on a laptop the 780 px column, centred (install's sheetType)
export function liftGeometry({ room, pose, w, h, phone, boxAspect = null, col = null }) {
  const B = basis(pose.yaw, pose.pitch);
  const q = room.objects.notebook_page.quad;
  // (DYS-28, Akshay 28 Oct, option b: the paper lifts from the notebook and widens to the whole window, laptops and
  // phones; on a laptop the text keeps the 780 px sheet's centred column and type: install's column)
  const Wt = w, Ht = h, left = 0;
  // (DYS-211, the laptop's hand-over: the whole sheet on the page drew the column a strip down its middle in small type,
  // the leaf's words the page's width, so the type jumped as the page lifted off and as it came back) the column is what
  // lies on the page at the start, the paper beside it hidden (side: liftCorners' m, place()'s clip) and opening as the
  // page comes; phones (the column the whole sheet): as before
  const Cw = Math.min(col || Wt, Wt), side = (Wt - Cw) / 2;
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
  const Hs = Cw * (boxAspect || ph / pw);
  return { w, h, pose, q, Wt, Ht, left, Hs, col: Cw, side, s0: pw / Cw, sy0: ph / Hs, s1: V.len(V.sub(T[1], T[0])) / Wt,
    C0, C1, R0: quatOf(X0, Y0, Z0), R1: quatOf(X1, Y1, Z1), up };
}
// The sheet at e (0: on the notebook, 1: the column): its box's height and its corners, in the room and on screen; m: the
// paper hidden at each side (sheet px, DYS-211: the column's margins, opening as the page grows) and Sv the shown part's
// corners on screen (S where nothing is hidden)
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
  const m = (G.side || 0) * (1 - smooth((e - 0.15) / 0.85));
  const hv = V.mul(X, ((G.Wt - 2 * m) * s) / 2);
  const Sv = m > 0 ? [V.sub(V.sub(Cc, hv), hy), V.sub(V.add(Cc, hv), hy), V.add(V.add(Cc, hv), hy), V.add(V.sub(Cc, hv), hy)].map((p) => project(G.pose, p, G.w, G.h)) : S;
  return { hb, W4, m, S: S.some((p) => !p) ? null : S, Sv: Sv.some((p) => !p) ? null : Sv };
}

// ---------------------------------------------------------------- the page's light: its grid (pure: scripts/live/essay_lift_edge_test.mjs tests it)
// A grid point's square on the canvas (CSS px, [x0, y0, x1, y1]): the quarter-size pixels X - 1 .. X + 1 around the point,
// which the canvas copy's mean (avg, r 1) and the GPU buffer's (bufferRead) both take; W x H: the copy's size
export const lightSquare = (G, W, H, x, y) => {
  const X = Math.round((x * W) / G.w), Y = Math.round((y * H) / G.h);
  return [(Math.max(0, X - 1) * G.w) / W, (Math.max(0, Y - 1) * G.h) / H, (Math.min(W, X + 2) * G.w) / W, (Math.min(H, Y + 2) * G.h) / H];
};
// The light's grid on the canvas (CSS px): GX x GY points over the page G.q, row by row, each its cell's middle.
// (DYS-205 page-edge, edge: Akshay's recording, 31 Oct, 22.65 s on, the open's first frame of the sheet: its outer ~4 CSS
// px 48 luma darker than the page just before it at the fore edge, 38 at the foot, 27 at the head, none at the spine; the
// same on the way back, 25.3-25.8 s. The outer points' squares, ~12 CSS px a side on a phone and rounded to the copy's
// pixels, reached past the page onto the desk and the elastic beside the fore edge and the cover's edge at the head and
// the foot: that grey on the sheet's edges, stepping with the rounding down the slanted fore edge every ~7 rows, the
// notches) The points stay in a box of the page, [u0, u1] x [v0, v1], where no square can reach past the page on screen:
// a point outside it goes to its nearest place in it (the outer points take the paper's light just inside the edge, as
// far in as a square needs), the same points for both reads; every point inside it as before. A point's reach: wherever
// the copy's pixels round it to, its square lies in [x - 1.5 a, x + 2.5 a] (a: a copy's pixel, ~4 CSS px), likewise
// down; with a CSS px and half a copy's pixel more all round (the copy's own smoothing). The page is flat, so its picture
// is a perspective of it and each edge's limit a straight line in (u, v): the box's sides are each limit's nearest at the
// page's two ends. (Each moved point is checked; one that still reaches past (a page that is not flat) goes on toward the
// middle until it does not)
export function lightGrid(G, W, H, { GX = 36, GY = 50, edge = true } = {}) {
  const q = G.q, B = basis(G.pose.yaw, G.pose.pitch);
  const at = (u, v) => project(G.pose, V.lerp(V.lerp(q[0], q[1], u), V.lerp(q[3], q[2], u), v), G.w, G.h, B);
  const pts = [];
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) pts.push(at((i + 0.5) / GX, (j + 0.5) / GY));
  const c = q.map((p) => project(G.pose, p, G.w, G.h, B));
  if (!edge || c.some((p) => !p)) return pts;
  // the page's four edges on screen (the head, the fore edge, the foot, the spine), each as n . p >= k inside
  const mx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, my = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
  const E = c.map((a, i) => {
    const b = c[(i + 1) % 4];
    let n = [a[1] - b[1], b[0] - a[0]];
    if (n[0] * (mx - a[0]) + n[1] * (my - a[1]) < 0) n = [-n[0], -n[1]];
    return { n, k: n[0] * a[0] + n[1] * a[1] };
  });
  const ax = G.w / W, ay = G.h / H, L = 2 * ax + 1, R = 3 * ax + 1, T = 2 * ay + 1, D = 3 * ay + 1;
  // the point at (u, v) with its reach inside these edges
  const clear = (u, v, es) => {
    const p = at(u, v);
    if (!p) return false;
    const x0 = p[0] - L, y0 = p[1] - T, x1 = p[0] + R, y1 = p[1] + D;
    return es.every(({ n, k }) => n[0] * (n[0] > 0 ? x0 : x1) + n[1] * (n[1] > 0 ? y0 : y1) >= k);
  };
  // from k 0 to 1, the first k where ok holds (0 when it already does, 1 when only that end might)
  const first = (ok) => {
    if (ok(0)) return 0;
    if (!ok(1)) return 1;
    let a = 0, b = 1;
    for (let n = 0; n < 16; n++) { const m = (a + b) / 2; if (ok(m)) b = m; else a = m; }
    return b;
  };
  // each edge's limit at the page's two ends, found from the edge in toward the middle
  const u1 = Math.min(...[0, 1].map((v) => 1 - 0.5 * first((k) => clear(1 - 0.5 * k, v, [E[1]]))));
  const u0 = Math.max(...[0, 1].map((v) => 0.5 * first((k) => clear(0.5 * k, v, [E[3]]))));
  const v0 = Math.max(...[0, 1].map((u) => 0.5 * first((k) => clear(u, 0.5 * k, [E[0]]))));
  const v1 = Math.min(...[0, 1].map((u) => 1 - 0.5 * first((k) => clear(u, 1 - 0.5 * k, [E[2]]))));
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const u = (i + 0.5) / GX, v = (j + 0.5) / GY;
    let cu = Math.min(u1, Math.max(u0, u)), cv = Math.min(v1, Math.max(v0, v));
    if (cu === u && cv === v) continue;
    if (!clear(cu, cv, E)) { const a = cu, b = cv, k = first((t) => clear(a + (0.5 - a) * t, b + (0.5 - b) * t, E)); cu = a + (0.5 - a) * k; cv = b + (0.5 - b) * k; }
    pts[j * GX + i] = at(cu, cv);
  }
  return pts;
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
    // (EO3: and the essay's type laid out ahead, warmType)
    warm: () => { buildRoot(); warmLight(); warmType(); },
  };
  let root, scrim, sheet, lit, scroller, art, back, pushed = false, run = null;
  // (DYS-149) the essay's blocks not in the sheet yet, and its end mark: { a, rest, end } (mount, mountMore)
  let held = null;
  // (DYS-149 VIDEO_LATE) the open essay's videos waiting for their source and controls: [{ v, src }] (posterOnly, dress)
  let late = null;
  const ix = () => nav.nbIndex, reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = () => nav.size()[0] <= 640;
  // (before the room starts the router has no size(): the hero's, else the window's)
  const viewSize = () => (nav.size ? nav.size() : [nav.hero?.clientWidth || innerWidth, nav.hero?.clientHeight || innerHeight]);
  const viewRect = () => (nav.live?.canvas || nav.hero)?.getBoundingClientRect() || { left: 0, top: 0 };
  const mark = (what) => L.log.push({ what, t: +performance.now().toFixed(1) });
  // (DYS-149, EO3) the essay's type and margins as the page's custom properties: the sheet's for a view w px wide (its
  // column on a laptop the 780 px sheet's, centred: open()) and the riffle leaf's (the notebook page's box: riffleLeaves);
  // warmType lays its sample out with the same. A key: the sizes
  const sheetType = (w) => {
    const lay = w <= 640 ? LAYOUT.phone : LAYOUT.desk, C = w <= 640 ? w : Math.min(LAYOUT.desk.maxW, w - 48), side = (w - C) / 2;
    return { "--el-fs": `${(C * lay.fs).toFixed(3)}px`, "--el-pad": lay.pad.map((p, i) => `${(C * p + (i % 2 ? side : 0)).toFixed(2)}px`).join(" "),
      "--el-padl": `${(C * lay.back + side).toFixed(2)}px` };
  };
  const leafType = (nb) => {
    const box = nb.surface.box[0], lay = phone() ? LAYOUT.phone : LAYOUT.desk;
    return { "--el-fs": `${(box * lay.fs).toFixed(3)}px`, "--el-pad": lay.pad.map((p) => `${(box * p).toFixed(2)}px`).join(" ") };
  };
  const setVars = (el, v) => { for (const k in v) el.style.setProperty(k, v[k]); };
  const keyOf = (v) => Object.values(v).join(" ");

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

  const colOf = (w) => (w <= 640 ? w : Math.min(LAYOUT.desk.maxW, w - 48));   // (sheetType's column)
  const geometry = () => { const b = ix()?.surface?.box, [w, h] = nav.size(); return liftGeometry({ room: nav.room, pose: nav.rig.pose, w, h, phone: phone(), boxAspect: b && b[0] ? b[1] / b[0] : null, col: colOf(w) }); };
  function place(G, e) {
    const { hb, S, m } = liftCorners(G, e);
    const cr = nav.live.canvas.getBoundingClientRect();
    if (!S) return false;
    sheet.style.height = `${hb.toFixed(2)}px`;
    // (DYS-211) the paper beside the column hidden while it opens (paint only: the essay's layout is the same at every e;
    // the top and bottom edges' shadow kept)
    sheet.style.clipPath = e < 1 && m > 0.25 ? `inset(-48px ${m.toFixed(2)}px -48px ${m.toFixed(2)}px)` : "";
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
  // (DYS-149: in three parts, lightSetup / gridOf / litApply, for litAfter below; the same numbers)
  function lightSetup(G) {
    const GX = 36, GY = 50;
    // the view's own veil over the page (style.css .veil: the bottom third darkens toward rgba(8, 6, 4, 0.55) so the
    // masthead reads; it lies over the notebook's page, under the sheet): laid into the light, so the sheet's first
    // frame is as dark at the page's foot as the page was (DP2: the foot brightened at the handover); it goes with the light
    const veilEl = nav.hero?.querySelector?.(".veil") || document.querySelector(".veil");
    const vb = veilEl && getComputedStyle(veilEl).visibility !== "hidden" && getComputedStyle(veilEl).display !== "none" ? veilEl.getBoundingClientRect() : null;
    const vo = vb ? +getComputedStyle(veilEl).opacity : 0;
    const cr0 = nav.live.canvas.getBoundingClientRect();
    const veil = (x, y) => { if (!vb || vb.height < 1 || !(vo > 0)) return 0; const f = (cr0.top + y - vb.top) / vb.height; return Math.max(0, Math.min(1, (f - 0.68) / 0.32)) * 0.55 * vo; };
    // the copy's size: a quarter of the canvas's (the grid needs no more), and the grid's points on the canvas (CSS px)
    // (DYS-205 page-edge: each point's square inside the page, lightGrid; ?pageedge=0: as before)
    const W = Math.max(64, Math.round(G.w / 4)), H = Math.max(36, Math.round(G.h / 4));
    const pts = lightGrid(G, W, H, { GX, GY, edge: PAGE_EDGE });
    return { G, GX, GY, veil, pts, W, H };
  }
  const gridOf = (S, read) => {
    const { GX, GY, veil, pts } = S;
    const c = document.createElement("canvas"); c.width = GX; c.height = GY;
    const g = c.getContext("2d"), im = g.createImageData(GX, GY);
    let hi = 0;
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const s = pts[j * GX + i];
      let px = s ? read(s[0], s[1]) : null;
      const o = (j * GX + i) * 4;
      if (px) { const va = veil(s[0], s[1]); px = [px[0] * (1 - va) + 8 * va, px[1] * (1 - va) + 6 * va, px[2] * (1 - va) + 4 * va]; }
      im.data[o] = px ? px[0] : 230; im.data[o + 1] = px ? px[1] : 230; im.data[o + 2] = px ? px[2] : 230; im.data[o + 3] = 255;
      if (px) hi = Math.max(hi, px[0], px[1], px[2]);
    }
    g.putImageData(im, 0, 0);
    return { c, hi, px: im.data };
  };
  // the canvas as drawn (the frame just drawn, in this task), copied at a quarter of its CSS size and read back
  const canvasRead = (S) => {
    const { G, W, H } = S;
    const k = document.createElement("canvas"); k.width = W; k.height = H;
    const kg = k.getContext("2d", { willReadFrequently: true });
    kg.drawImage(nav.live.canvas, 0, 0, W, H);
    const d = kg.getImageData(0, 0, W, H).data;
    return (x, y) => avg(d, W, H, (x * W) / G.w, (y * H) / G.h, 1);
  };
  const litApply = (out, how, G) => {
    L.litHow = out && out.hi >= 12 ? how : "none (paper)";
    if (!out || out.hi < 12) { lit.style.background = "none"; return false; }
    lit.style.height = `${G.Hs}px`;
    // (DYS-211) over the column, the part on the page at the start (the whole sheet on a phone)
    lit.style.left = `${G.side || 0}px`; lit.style.width = `${G.col || G.Wt}px`;
    lit.style.background = `url(${out.c.toDataURL()}) 0 0 / 100% 100% no-repeat`;
    return true;
  };
  // (?essaylift=0) one frame drawn now, in the tap's task, and copied at once (my: litAfter's, the open it is for)
  async function litFrom(G, my = null) {
    const S = lightSetup(G);
    let out = null;
    try {
      nav.engine._frame(performance.now());
      out = gridOf(S, canvasRead(S));
      if (LIGHT === "canvas") warmed = true;   // (DYS-149, EO3: the first read done: nothing left to warm)
    } catch (e) { console.warn("[essay-lift] light (canvas)", e); }
    return my && run !== my ? false : litApply(out, "canvas", G);
  }

  // (DYS-149) The light from the room's own next frame, not from one more drawn in the tap's task: right after the engine
  // has drawn it (its "frame" event, in the same task, so the canvas's buffer is still there) the page's part of the
  // canvas goes into a buffer on the GPU (WebGL 2: readPixels into a PIXEL_PACK_BUFFER, a fence behind it), read a frame
  // or more later once the fence has passed: nothing waits on the GPU for it (GS2, Chrome's mid phone: the extra frame
  // and the copy read back were 21-63 ms of the tap's task). Each point of the grid is then the mean of the canvas's own
  // pixels over the square the old copy's 3 x 3 quarter-size pixels covered (that copy's scaling was the browser's: a
  // few levels apart at most, ?essaylift=check measures it). No WebGL 2, or the buffer refused: the old copy, in that
  // same frame. The frame is asked for (at rest the room draws only now and then); none in 600 ms: the old way.
  // (EO1, 31 Oct: WebKit's first read into a GPU buffer took 209 ms, so there the canvas is copied at once, in that frame
  // (LIGHT); either way the read was done once ahead, warmLight. The fence is looked at, and the buffer read, in a task
  // just after a frame, not inside one: Chrome's mid phone's read and grid were a 37 ms task in a frame)
  // { copied: the copy is taken (the riffle may change the page from then on), done: litApply's answer }. An open let go
  // meanwhile (my: its run) leaves the sheet's light to the next one
  function litAfter(G, my) {
    const S = lightSetup(G), eng = nav.engine;
    let copied, done;
    const P = { copied: new Promise((r) => { copied = r; }), done: new Promise((r) => { done = r; }) };
    let off = null, over = false;
    const end = (out, how) => {
      if (over) return;
      over = true; copied();
      let ok = false;
      try { ok = run === my ? litApply(out, how, G) : false; } catch (e) { console.warn("[essay-lift] light", e); }
      done(ok);
    };
    const t = setTimeout(() => {
      if (!off) return;
      off(); off = null;
      if (run !== my) { over = true; copied(); done(false); return; }   // (review: the open was let go meanwhile: no extra frame)
      litFrom(G, my).then((ok) => { if (run === my) L.litHow = `${L.litHow} (no frame came)`; return ok; }, () => false)
        .then((ok) => { over = true; copied(); done(ok); });
    }, 600);
    // (whatever goes wrong, the open never waits on the light for long: 2 s after the frame, the sheet's own paper)
    let job = null, old = null;
    const lastly = () => setTimeout(() => { if (over) return; job?.drop(); end(old, old ? "canvas (its frame)" : "none (timed out)"); }, 2000);
    off = eng.on("frame", () => {
      off?.(); off = null; clearTimeout(t);
      if (run !== my) { end(null, "-"); return; }
      lastly();
      let ms = null;
      const t0 = performance.now();
      try { job = LIGHT === "buffer" || ESSAY_LIFT === "check" ? bufferRead(S) : null; } catch (e) { console.warn("[essay-lift] light (buffer)", e); job = null; }
      const t1 = performance.now();
      if (!job || ESSAY_LIFT === "check") {
        try { old = gridOf(S, canvasRead(S)); } catch (e) { console.warn("[essay-lift] light (canvas)", e); }
        ms = +(performance.now() - t1).toFixed(1);
      }
      // (DYS-149, EO3) an open's own read, the way warmLight reads (LIGHT), is the first one done: no warm-up after it
      if (job || (LIGHT === "canvas" && old)) warmed = true;
      mark("light copied");
      if (!job) { end(old, "canvas (its frame)"); return; }
      L.litCopyMs = +(t1 - t0).toFixed(1);
      copied();
      let k = 0;
      const poll = () => {
        if (over) return;
        let out = null;
        try {
          if (!job.ready() && ++k < 30) { afterFrame().then(poll); return; }
          out = job.read();
        } catch (e) { console.warn("[essay-lift] light (buffer read)", e); job.drop(); }
        if (ESSAY_LIFT === "check" && out && old) {
          let sum = 0, mx = 0, n = 0;
          const d = [];
          for (let i = 0; i < out.px.length; i += 4) for (let c = 0; c < 3; c++) { const x = Math.abs(out.px[i + c] - old.px[i + c]); sum += x; mx = Math.max(mx, x); d.push(x); n++; }
          d.sort((p, q) => p - q);
          const r = { mean: +(sum / n).toFixed(2), p95: d[Math.floor(n * 0.95)], max: mx, frames: k, bufferMs: L.litCopyMs, canvasMs: ms };
          if (run === my) window.__essayLiftCheck = { ...(window.__essayLiftCheck || {}), light: r };
          console.info(`[essay-lift] DYS-149 essaylift check ${JSON.stringify(r)}`);
        }
        if (run === my) mark("light");   // (review: a dropped open's late read leaves the next open's log alone)
        end(out || old, out ? "buffer" : "canvas (its frame)");
      };
      afterFrame().then(poll);
    });
    eng.requestFrame?.();
    return P;
  }
  // (DYS-149) the page's part of the canvas just drawn into a GPU buffer (readPixels from the canvas's own framebuffer,
  // the read binding and the pack buffer put back as they were: three.js keeps its own record of the framebuffer), a
  // fence behind it: { ready(): the fence has passed, read(): gridOf's answer from it, drop() }. null: no WebGL 2
  function bufferRead(S) {
    const gl = nav.engine?.renderer?.getContext?.();
    if (!gl || typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext) || gl.isContextLost()) return null;
    const { G, W, H, pts } = S, bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight, kx = bw / G.w, ky = bh / G.h;
    // each point's square (CSS px): the quarter-size pixels X - 1 .. X + 1 the old copy's mean took (avg, r 1)
    // (DYS-205: lightSquare, the one lightGrid keeps inside the page)
    const sq = (x, y) => lightSquare(G, W, H, x, y);
    let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
    for (const s of pts) { if (!s) continue; const q = sq(s[0], s[1]); a0 = Math.min(a0, q[0]); b0 = Math.min(b0, q[1]); a1 = Math.max(a1, q[2]); b1 = Math.max(b1, q[3]); }
    // the region in the buffer's pixels, rows counted down from the top
    const x0 = Math.max(0, Math.floor(a0 * kx)), x1 = Math.min(bw, Math.ceil(a1 * kx)), y0 = Math.max(0, Math.floor(b0 * ky)), y1 = Math.min(bh, Math.ceil(b1 * ky));
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 0 && h > 0)) return null;
    const buf = gl.createBuffer(), pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING), readFb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    let sync = null;
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
      gl.readPixels(x0, bh - y1, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb);
    }
    if (!sync) { gl.deleteBuffer(buf); return null; }
    const drop = () => { try { gl.deleteSync(sync); gl.deleteBuffer(buf); } catch { /* (a lost context) */ } };
    // a point's mean over its square (about 4 x 4 of the buffer's pixels, spread over it: the old copy's mean took 3 x 3
    // of its scaled pixels)
    const mean = (data) => (x, y) => {
      const q = sq(x, y);
      const p0 = Math.max(x0, Math.floor(q[0] * kx)), p1 = Math.min(x1, Math.ceil(q[2] * kx)), r0 = Math.max(y0, Math.floor(q[1] * ky)), r1 = Math.min(y1, Math.ceil(q[3] * ky));
      const sx = Math.max(1, Math.floor((p1 - p0) / 4)), sy = Math.max(1, Math.floor((r1 - r0) / 4));
      let a = 0, b = 0, c = 0, n = 0;
      for (let r = r0; r < r1; r += sy) {
        const row = (y1 - 1 - r) * w;   // (the buffer's rows from the bottom)
        for (let p = p0; p < p1; p += sx) { const o = (row + p - x0) * 4; a += data[o]; b += data[o + 1]; c += data[o + 2]; n++; }
      }
      return n ? [a / n, b / n, c / n] : null;
    };
    return {
      ready: () => gl.isContextLost() || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED,
      read: () => {
        if (gl.isContextLost()) return null;
        const data = new Uint8Array(w * h * 4), was = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        try {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, was); drop(); }
        return gridOf(S, mean(data));
      },
      drop,
    };
  }

  // (DYS-149, EO1 31 Oct: an open's first read of the canvas cost more than every later one, WebKit iPhone 13: main's copy
  // in the tap's task made the first open's first frame 107 ms, the GPU buffer's first read 213 ms; 1-3 ms after) The
  // light's read done once ahead, as an open does it (LIGHT), its picture let go: in the room's next frame once the
  // notebook lies open and still (the cover open, no turn, the room settled, no open under way) and no input has come for
  // 0.7 s; looked for every 250 ms (an open before that reads as it would have)
  // (DYS-149, EO3 31 Oct: EO2's looked for 10 s at most and was armed again only at the next landing at the notebook: a
  // visitor turning its pages for longer paid the cold read at his first open (WebKit 107 ms, as main). Now every 250 ms
  // for 10 s, then every 500 ms for as long as the notebook is the room's spot, armed again after a close (restore());
  // an open's own read counts as the first (litAfter, litFrom): no warm-up after it)
  let warmed = false, lastIn = 0, warming = false;
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => { lastIn = performance.now(); }, { capture: true, passive: true });
  // the notebook open and still, nothing under way, no input for 0.7 s (the warm-ups' moment)
  const calm = () => {
    const nb = ix();
    return L.state === "closed" && nav.mode === "live" && nav.spot === "notebook" && nav.rig?.spot === "notebook" && !nav.rig?.glide && !!nb && !nb.turning &&
      !nb.pages?.busy && (!nb.pages || nb.pages.coverOpen !== false) && nav.engine?.state === "settled" && performance.now() - lastIn > 700;
  };
  // (DYS-149, EO3) a warm-up's next look (its timer; null: stopped): every 250 ms for its first 40, then every 500 ms, while
  // the notebook is the room's spot; gone from it, it stops (the router's liftWarm arms it again at the next landing)
  const lookAgain = (tries, go, stop) => {
    if (nav.spot !== "notebook" || nav.mode !== "live") { stop(); return null; }
    return setTimeout(go, tries <= 40 ? 250 : 500);
  };
  function warmLight() {
    if (!STEPS || warmed || warming || !nav.engine?.on) return;
    warming = true;
    let tries = 0;
    const stop = () => { warming = false; };
    const later = () => { if (warmed) stop(); else lookAgain(++tries, go, stop); };
    const go = () => {
      if (warmed) { stop(); return; }
      if (!calm()) { later(); return; }
      // (EO3: the frame asked for waited on 1 s at most: a room drawing none (a hidden tab) leaves it to the next look)
      let off = null;
      const none = setTimeout(() => { off?.(); off = null; later(); }, 1000);
      off = nav.engine.on("frame", () => {
        off?.(); off = null; clearTimeout(none);
        if (warmed || !calm()) { later(); return; }
        warmed = true; stop();
        typeKick?.();   // (EO3: the type's warm-up next, if it waits: the next idle moment, not its next look)
        const t0 = performance.now();
        // (L.warmed: how, the read's ms in this frame, when; for a buffer, the ms of its read back later)
        const done = (how) => { L.warmed = { how, ms: +(performance.now() - t0).toFixed(1), at: +t0.toFixed(1) }; };
        try {
          const S = lightSetup(geometry());
          const job = LIGHT === "buffer" ? bufferRead(S) : null;
          if (!job) { canvasRead(S); done("canvas"); return; }
          done("buffer");
          let k = 0;
          const f = () => {
            const t1 = performance.now();
            try { if (!job.ready() && ++k < 30) { afterFrame().then(f); return; } job.read(); } catch { job.drop(); }
            L.warmed.readMs = +(performance.now() - t1).toFixed(1);
          };
          afterFrame().then(f);
        } catch (e) { console.warn("[essay-lift] light (warm)", e); done("failed"); }
      });
      nav.engine.requestFrame?.();
    };
    setTimeout(go, 300);
  }

  // (DYS-149, EO3 31 Oct: the first open in a page laid the essay out for the first time. Chrome's mid phone, EO1/EO2's
  // traces: the first layout with the essay in it was 18 ms where a second open's was 1-6 ms, its style recalc 13-16 ms
  // where 2 ms: the browser's own controls of the essay's video made for the first time (their stylesheet parsed, their
  // pictures: 8-10 ms of it; in EO1 the riffle leaf's copy's, the 44 ms riffleLeaves task, in EO2 the sheet's first
  // frame, 36 ms), and the faces at the page's two sizes for the first time (EO2's riffle: its layout 7.3 ms, a second
  // open's 1.8)) The essay's type laid out once ahead: a sample of the page at the riffle leaf's size in the notebook, a
  // video with its controls in a sheet, the sample at the sheet's size; each in an idle task of its own once the notebook
  // lies still (calm, as the light's, which hands on to it), put in, laid out and taken out again in that same task
  // (never drawn). Looked for as the light's is (lookAgain). Once a size: again only for new ones (a rotation); an open's
  // own layout counts (open(), riffleLeaves). L.typeWarm: each part's ms and when
  let typed = { leaf: "", sheet: "", video: false }, typing = false, typeKick = null, typeOff = false;
  const sheetKey = (w) => `${w} ${keyOf(sheetType(w))}`;
  // the next part not laid out yet at today's sizes: [its name, the work], or null
  function typePart() {
    const nb = ix();
    if (!nb?.el || !(nb.surface?.box?.[0] > 0) || !nav.size) return null;
    const lv = leafType(nb), lk = keyOf(lv), [w, h] = nav.size();
    if (typed.leaf !== lk) return ["leaf", () => { layLeaf(nb, lv); typed.leaf = lk; }];
    if (!typed.video) return ["video", () => { laySheet(w, h, SAMPLE_VIDEO); typed.video = true; }];
    const sk = sheetKey(w);
    if (typed.sheet !== sk) return ["sheet", () => { laySheet(w, h, SAMPLE_TEXT, true); typed.sheet = sk; }];
    return null;
  }
  // the sample in the notebook as riffleLeaves lays its leaf (the words' classes after, as the turn's ink reads them);
  // the notebook's DOM is hidden (only its ink shows)
  function layLeaf(nb, lv) {
    const leaf = document.createElement("div"); leaf.className = "nb-leaf el-leaf";
    setVars(leaf, lv);
    const a = document.createElement("article"); a.className = "el-art"; a.innerHTML = SAMPLE_TEXT;
    leaf.append(a);
    nb.el.appendChild(leaf);
    try {
      void leaf.offsetHeight;
      for (const b of a.children) b.classList.add(b.classList.contains("el-h1") ? "nb-tt" : "nb-d");
      void leaf.offsetHeight;
    } finally { leaf.remove(); }
  }
  // a sheet of its own (the page's own is in the hidden root) as an open's (its back link and end mark with the text), at
  // the view's size, hidden, nothing reaching it
  function laySheet(w, h, html, bar = false) {
    const s = document.createElement("div"); s.className = "el-sheet";
    s.style.cssText = `position: fixed; left: 0; top: 0; width: ${w}px; height: ${h}px; visibility: hidden; pointer-events: none; will-change: auto; contain: strict; z-index: -1`;
    setVars(s, sheetType(w));
    const sc = document.createElement("div"); sc.className = "el-scroll";
    if (bar) sc.innerHTML = '<div class="el-bar"><button type="button" class="el-back" tabindex="-1"><span>Back to the notebook</span></button></div>';
    const a = document.createElement("article"); a.className = "el-art"; a.innerHTML = html;
    if (bar) { const e = document.createElement("p"); e.className = "el-end"; e.textContent = "Substack"; a.append(e); }
    sc.append(a); s.append(sc);
    document.body.append(s);
    try { void s.offsetHeight; } finally { s.remove(); }
  }
  function warmType() {
    if (!STEPS || typing || typeOff) return;
    typing = true;
    let tries = 0, t = null;
    const stop = () => { typing = false; typeKick = null; clearTimeout(t); };
    const later = () => { typeKick = go; t = lookAgain(++tries, go, stop); };
    const go = () => {
      clearTimeout(t); typeKick = null;
      if (!typePart()) { stop(); return; }
      if (!calm()) { later(); return; }
      idleTask(() => {
        const p = calm() ? typePart() : null;
        if (!p) { if (typePart()) later(); else stop(); return; }
        const t0 = performance.now();
        try { p[1](); } catch (e) { console.warn("[essay-lift] type (warm)", e); typeOff = true; stop(); return; }   // (not again: the open lays it out)
        (L.typeWarm ||= {})[p[0]] = { ms: +(performance.now() - t0).toFixed(1), at: +t0.toFixed(1) };
        go();   // (the next part in the next idle moment)
      });
    };
    t = setTimeout(go, 300);
  }

  // the notebook's leaves for the riffle: the list up to this leaf, the next list leaf (or a blank one), the essay's page
  // (two notebooks: v3/live's, one leaf at a time in nb.leaves; and page-turn2's book on the stage, its right-hand pages
  // in nb.sides, nb.leaf the spread, nb.show() putting a spread on the page)
  const pagesOf = (nb) => (nb.sides ? nb.sides : nb.leaves);
  function riffleLeaves(a) {
    const nb = ix(), c = nb.leaf, book = !!nb.sides;
    const list = pagesOf(nb);
    const keep = list.slice(0, c + 1);
    const filler = list[c + 1] || (() => { const l = document.createElement("div"); l.className = "nb-leaf"; l.appendChild(document.createElement("ol")); nb.el.appendChild(l); return l; })();
    for (const l of list.slice(c + 2)) l.remove();
    const leaf = document.createElement("div"); leaf.className = "nb-leaf el-leaf"; leaf.hidden = true;
    const lv = leafType(nb);   // (the page's box times LAYOUT's fs and pad)
    setVars(leaf, lv);
    // (DYS-151 memory: the leaf's copy of a video is never shown (its media go below, after the layout is read): without
    // its src it is not fetched a second time and gets no player of its own)
    // (DYS-149, EO3 31 Oct: nor its controls: they lie over its picture, its box is the same without them. With them each
    // open built the browser's controls in the leaf's layout, and the first open in a page their stylesheet and pictures:
    // EO1's 44 ms riffleLeaves task on Chrome's mid phone, 34 ms of it its style recalc and layout)
    const bare = (v) => { v.removeAttribute("src"); if (STEPS) { v.removeAttribute("controls"); v.removeAttribute("autoplay"); } };
    const noSrc = (n) => { if (n.nodeType !== 1) return; if (n.localName === "video") bare(n); for (const v of n.querySelectorAll("video")) bare(v); };
    let mini, hgt;
    if (STEPS) {
      // (DYS-149) the essay's first blocks (the sheet's held-back ones and its end mark count, as in the whole copy), more
      // only while the last one in still starts on the page: the blocks after it start lower and are left out below
      // anyway, and the ones before it are laid out as in the whole essay. GS2: the whole essay's copy laid out at once
      // was 3-14 ms, and its reads and writes in turn a style recalc or a layout each block (21-35 ms in all)
      mini = a.cloneNode(false);
      const src = [...a.childNodes, ...(held && held.a === a ? [...held.rest, held.end] : [])];
      let i = 0;
      const more = (n) => {
        const f = document.createDocumentFragment();
        for (let e = 0; i < src.length && e < n; i++) { const x = src[i].cloneNode(true); noSrc(x); if (x.nodeType === 1) e++; f.append(x); }
        mini.append(f);
      };
      more(MINI_FIRST);
      leaf.append(mini);
      nb.el.appendChild(leaf);
      leaf.hidden = false;
      hgt = nb.el.offsetHeight;
      while (i < src.length && !(mini.lastElementChild?.offsetTop > hgt)) more(MINI_MORE);
      L.miniBlocks = mini.children.length;
    } else {
      mini = a.cloneNode(true);
      noSrc(mini);
      leaf.append(mini);
      nb.el.appendChild(leaf);
      leaf.hidden = false;
    }
    const media = mini.querySelectorAll("img, video");
    // the page's words for the 3D turn: the blocks on the page (the ones below its foot left out)
    if (STEPS) {
      // (DYS-149) every block's top read in the one layout, then the changes
      const blocks = [...mini.children], tops = blocks.map((b) => b.offsetTop);
      blocks.forEach((b, k) => { if (tops[k] > hgt) b.remove(); else b.classList.add(b.classList.contains("el-h1") ? "nb-tt" : "nb-d"); });
    } else {
      hgt = nb.el.offsetHeight;
      for (const b of [...mini.children]) { if (b.offsetTop > hgt) b.remove(); else b.classList.add(b.classList.contains("el-h1") ? "nb-tt" : "nb-d"); }
    }
    for (const m of mini.querySelectorAll("img, video, figure")) m.remove();
    unload(media);   // (DYS-151 memory: and its photos let go of theirs, the ones below the page's foot too)
    leaf.hidden = true;
    if (STEPS) typed.leaf = keyOf(lv);   // (DYS-149, EO3: the leaf's type laid out at this size: warmType need not)
    if (book) { nb.sides = [...keep, filler, leaf]; nb.inkFor = null; nb.show(); }
    else { nb.leaves = [...keep, filler, leaf]; nb.leaves.forEach((l, i) => { l.hidden = i !== c; }); nb.inkFor = null; }
    // (DYS-149: their words go into the turn's ink, nb.ensureInk, a frame later: open())
    return c;
  }
  // the book's words fade in after a turn lands (page-turn2's cross-fade, --nb-dom): the sheet takes over once they are in
  // (DYS-149 TF1: the share as the notebook last set it, nb.domShare: its roots' opacity, not a --nb-dom to read back)
  const inkIn = async (nb) => {
    for (let k = 0; k < 60; k++) {
      const v = nb.domShare ? nb.domShare() : +(getComputedStyle(nb.el).getPropertyValue("--nb-dom").trim() || 1);
      if (v >= 0.999) return k;
      await frames(1);
    }
    return 60;
  };
  const turned = async (nb) => { for (let k = 0; k < 240 && nb.turning; k++) await frames(1); };

  // the essay into the sheet, with the original's mark at its end
  // (DYS-149: `first` blocks of it now (the h1, subtitle and date count), the rest held back and put in a few at a time
  // while the pages turn (mountMore), all before the lift (mountRest), the mark after the last: GS2, the whole essay laid
  // out in the sheet in the frame after the tap was 9-22 ms of layout in a 23-65 ms frame on Chrome's mid phone)
  function mount(a, post, first = Infinity) {
    sheet.setAttribute("aria-label", post.title);
    if (art) { art.remove(); unload(art.querySelectorAll("img, video")); }   // (DYS-151 memory: the last essay's media)
    if (held) { unload(mediaIn(held.rest)); held = null; }                   // (and its blocks never put in)
    art = a;
    const end = document.createElement("p"); end.className = "el-end";
    // the original, as the reading sheet links it: Substack's mark, its name for screen readers (no new visible words)
    if (post.url) {
      const o = document.createElement("a"); o.href = post.url; o.target = "_blank"; o.rel = "noopener"; o.className = "el-orig"; o.setAttribute("aria-label", "Substack");
      o.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>';
      end.append(o);
    }
    // (EO1, WebKit: the first open's first turn had a 62 ms frame as the held-back blocks' first few, a video's among them,
    // went in: a video's player is made as it goes into the page) at once, all up to the last block holding a video
    if (first < a.childElementCount) {
      [...a.children].forEach((b, i) => { if (b.matches("video, audio, iframe") || b.querySelector("video, audio, iframe")) first = Math.max(first, i + 1); });
    }
    if (first < a.childElementCount) {
      const nodes = [...a.childNodes];
      let k = 0, e = 0;
      for (; k < nodes.length && e < first; k++) if (nodes[k].nodeType === 1) e++;
      const rest = nodes.slice(k);
      for (const n of rest) n.remove();
      held = { a, rest, end };
      scroller.append(art);
      return;
    }
    scroller.append(art); art.append(end);
  }
  // (DYS-149 VIDEO_LATE) the essay's videos without their source and controls (poster only), kept to put back (dress)
  function posterOnly(a) {
    const vs = [...a.querySelectorAll("video[src]")];
    if (!vs.length) return null;
    return vs.map((v) => { const src = v.getAttribute("src"); v.removeAttribute("src"); v.controls = false; return { v, src }; });
  }
  // and back, in an idle moment once the page is open (the open's own frames done): reader.js's controls and source
  // (essay-cover: in two idle tasks a video, its source then its controls with their style and layout read in that task:
  // EO4's Chrome mid phone, both in one task was 37 ms and the next frame's style and layout 30 ms more)
  function dress(my) {
    if (!late) return;
    const vs = late, t0 = performance.now();
    let k = 0, ms = 0, most = 0;
    const step = () => idleTask(() => {
      if (run !== my || late !== vs || L.state !== "open") return;
      const a = performance.now(), { v, src } = vs[k >> 1];
      if (k % 2 === 0) v.setAttribute("src", src);
      else { v.controls = true; void v.offsetHeight; }
      const d = performance.now() - a;
      ms += d; most = Math.max(most, d);
      if (++k < 2 * vs.length) { step(); return; }
      late = null;
      typed.video = true;
      L.videoLate = { n: vs.length, ms: +ms.toFixed(1), most: +most.toFixed(1), at: +t0.toFixed(1), done: +(performance.now() - t0).toFixed(1) };
    });
    step();
  }
  // (DYS-149) n more of the held-back blocks into the sheet (the text between them goes along), the end mark after the last
  function mountMore(n) {
    if (!held) return;
    const f = document.createDocumentFragment();
    for (let e = 0; held.rest.length && e < n;) { const x = held.rest.shift(); if (x.nodeType === 1) e++; f.append(x); }
    if (!held.rest.length) f.append(held.end);
    held.a.append(f);
    if (!held.rest.length) { held = null; mark("mounted"); }
  }
  // (DYS-149) the rest after each frame while the pages turn, from a turn's fourth frame (a turn's first frames are its
  // slowest: Akshay's phone 31 Oct)
  async function mountSteps(my) {
    await frames(2);
    while (held && run === my) { await afterFrame(); if (run !== my || !held) return; mountMore(MOUNT_STEP); L.mountSteps = (L.mountSteps || 0) + 1; }
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
    sheet.style.width = `${G.Wt}px`;
    // (on a laptop the type and the column as on the 780 px sheet, centred in the window's width: sheetType)
    setVars(sheet, sheetType(G.w));
    // (DYS-149: the tap's work a frame at a time, the room drawn between: the page's light first, read from the canvas
    // as drawn now and before the essay is in the page (no layout of it forced here); the essay into the sheet a frame
    // later (laid out by that frame); the riffle's leaves the next; their words into the turn's ink and the first turn the
    // next. All in the tap's own task, WebKit's baseline (30 Oct) froze 0.2-0.6 s there, 1.8 s once on the phone profile)
    // (DYS-149, 31 Oct: each step in a task of its own after a frame (afterFrame), and lighter: the light from the room's
    // own next frame, read back without a wait (litAfter); the essay into the sheet a few blocks at a time (mount, the
    // rest while the pages turn: mountSteps); the riffle's leaf from the essay's first blocks in one layout
    // (riffleLeaves); the turn's ink a page a task after frames, before the first turn (the notebook's inkSteps), not in
    // one. ?essaylift=0: as before)
    L.how = { essaylift: ESSAY_LIFT };
    L.miniBlocks = L.mountSteps = L.litCopyMs = undefined;
    const light = STEPS ? litAfter(G, my) : null;
    const lightP = light ? light.done : litFrom(G);
    const step = () => (STEPS ? afterFrame() : frames(0));
    // (DYS-149 review, 30 Oct: the page's cover goes up once the essay is in hand, as on Deploy 9. Raised at the tap, a
    // slow or stalled fetch (a cold 3G phone, the warm-up skipped there) left every tap ignored and Escape swallowed until
    // it failed. While the essay comes, a tap on the notebook or the masthead reaches them, another title takes over and
    // Escape lets the open go: drop())
    L.fetching = true;
    await step();
    if (run !== my) return;
    const [{ a, post }] = await Promise.all([article(slug), document.fonts?.ready]);
    if (run !== my) return;
    L.fetching = false;
    // (DYS-149 review: the room went on meanwhile, the masthead or a spot's link: the open is let go)
    if (nav.spot !== "notebook" || ix() !== nb) { drop(); return; }
    // (from here on the page's cover is up, still clear: no second tap or corner drag reaches the notebook mid-riffle)
    sheet.style.visibility = "hidden"; scrim.style.opacity = "0"; root.hidden = false; root.dataset.state = "riffle";
    late = VIDEO_LATE ? posterOnly(a) : null;
    mount(a, post, STEPS ? MOUNT_FIRST : Infinity);
    mark("article");
    await step();
    if (run !== my) return;
    // (a) the riffle: two turns of the real page, quick
    const c = riffleLeaves(a);
    L.from = c;
    mark("leaves");
    // (DYS-149, EO3: the sheet laid out at its size in the frame before this, with the essay's video if it has one (mount
    // puts all up to it in at once): warmType need not)
    // (VIDEO_LATE: its controls not yet: dress)
    if (STEPS) { typed.sheet = sheetKey(G.w); if (!late && art?.querySelector("video")) typed.video = true; }
    await step();
    if (run !== my) return;
    if (STEPS && !INK_ONE && nb.inkWork && nb.sides && !reduced() && nb.pages) {
      // (DYS-149) the turn's ink (every leaf as it is now: the list's, the next one, the essay's) in the notebook's steps
      // (inkWork: a leaf measured, a page's words drawn, the upload), as many as fit in INK_MS after each frame (EO1: one
      // a frame held WebKit's first turn 7 frames for steps of a ms or two), the first turn once it is all in. GS2: in one
      // task (ensureInk) it was 20-79 ms on Chrome's mid phone (leafWords' forced layouts, the atlas's words played and
      // uploaded). A step that fails ("moved": a font came in) or 40 frames: the turn's ensureInk does the rest at once
      const job = nb.inkWork();
      nb.inkJob = job; nb.inkHow = "steps (an essay's open)";
      let k = 0, end = false;
      for (;;) {
        const t0 = performance.now();
        end = false;
        try { do end = !!job.it.next().done; while (!end && performance.now() - t0 < INK_MS); }
        catch (err) { end = true; if (err?.message !== "moved") console.warn("[essay-lift] ink", err); }
        if (end || ++k >= 40) break;
        await afterFrame();
        if (run !== my) return;
        if (nb.inkJob !== job) break;   // (a new layout: its own steps; the turn's ensureInk does what is left)
      }
      // (review: a job stopped at the frame cap is kept, so the turn's ensureInk does what is left, not all of it again)
      if (nb.inkJob === job && end) nb.inkJob = null;
      L.how.ink = `steps (${k} frames)`;
      mark("ink");
    } else { nb.ensureInk(); L.how.ink = "one task"; }
    // (DYS-149: the page's light is copied before a leaf moves on it)
    if (light) { await light.copied; if (run !== my) return; }
    if (!reduced() && nb.pages) {
      nb.pages.autoMs = RIFFLE_MS;
      for (let k = 0; k < 2; k++) {
        mark(`turn ${k + 1}`);
        if (!nb.turn(1)) break;
        if (STEPS && k === 0) mountSteps(my).catch((e) => console.warn("[essay-lift] mount", e));
        await turned(nb);
        if (run !== my) return;
      }
      nb.pages.autoMs = null;
    } else if (nb.sides) { nb.leaf = nb.sides.length - 1; nb.show(); nb.pages?.setLeaf(nb.leaf, { reduced: true }); }
    else { nb.leaves.forEach((l, i) => { l.hidden = i !== nb.leaves.length - 1; }); nb.leaf = nb.leaves.length - 1; nb.pages?.setLeaf(nb.leaf); }
    L.inkWait = await inkIn(nb);
    if (run !== my) return;
    // (DYS-149: what the turns left of the essay into the sheet now, before it shows)
    if (held) { L.how.mountRest = held.rest.filter((n) => n.nodeType === 1).length; mountMore(Infinity); }
    await lightP;
    if (run !== my) return;
    // (review, already on main: Back during the riffle sent the room to the desk while the open lifted the page and pushed
    // /writing/<slug>: an open whose notebook is no longer the one in view stops here; the riffle already changed the
    // leaves, so restore() rebuilds them (drop() is for an open that showed nothing yet)
    if (nav.spot !== "notebook" || ix() !== nb) { restore(); return; }
    L.how.lit = L.litHow;
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
    // (DYS-149 essay-cover: the page covers the whole window now (the lift's end: the view's width and height, its paper
    // opaque): the room under it not drawn until the close (close(), restore()). Not for a page shown at a refresh (show()):
    // the room may still be starting under it)
    nav.engine?.cover?.(true);
    dress(my);
    if (L.escWanted) { L.escWanted = false; mark("escape kept"); L.close(); }
  }

  async function close({ fromPop = false } = {}) {
    if (L.state !== "open") return;
    nav.engine?.cover?.(false);   // (DYS-149 essay-cover: the room drawn again, for the close and what follows)
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
    // (DYS-211, Akshay 1 Nov: Back plays the open backwards) the page comes down onto the essay's own page in the notebook
    // (backLeaves), the notebook's ink takes it back there, and the pages turn back twice, through the list's next leaf,
    // to the spread that lists it: the open's moves and timing reversed (turnBack). Reduced motion, a notebook without the
    // 3D turn, or the essay not in the list: as DYS-160 (Akshay's phone 29 Oct), the notebook on the spread that lists
    // the essay before the page comes down (the page fills the view now, so nothing shows the change) and the page settles
    // onto that spread's right-hand page
    const back = !reduced() && !!nb.pages && backLeaves(nb);
    L.back = { leaves: back || "list", ink: null, turns: 0 };
    if (!back) toList(nb);
    // (the turn's ink for these leaves: the open's, unless the leaves were made again; then in the notebook's own steps
    // after each frame while the page comes down, and a turn's ensureInk does what is left)
    else if (nb.inkFor !== nb.sides) { L.back.ink = "steps"; nb.inkSteps?.(); }
    else L.back.ink = "ready";
    // (the room drawn whole once now, under the page that still fills the view: nothing in it changes while the page comes
    // down, so the first whole frame since the open would be turn 1's first, and it was the heavy one (B's helper's J8,
    // 9a3d2612: 22-91 ms of GPU there on the laptop and the phone profile; DYS-160's close had its toList change here)
    if (back) nav.engine?.invalidate?.("essay close");
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
    if (back) { await turnBack(nb, my); return; }
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

  // (DYS-211) the notebook on the essay's own page, as the open left it: the riffle's leaves (the list up to the spread it
  // was opened from, the list's next leaf, the essay's page), the notebook on the last. A page shown at a refresh, or a
  // notebook laid out again meanwhile (a rotation re-paginates it: the list's leaves only), gets the same leaves made
  // again from the spread that lists the essay now, as a tap on its title makes them, the page still filling the view.
  // "kept" | "made"; false when the essay isn't in the list
  function backLeaves(nb) {
    const P = pagesOf(nb), at = P.findIndex((p) => p.classList.contains("el-leaf"));
    if (at >= 2 && at === P.length - 1 && nb.leaf === at) { L.from = at - 2; return "kept"; }
    const s = leafOf(nb, L.slug);
    if (s < 0 || !art) return false;
    onSpread(nb, s);
    L.from = riffleLeaves(art);
    onSpread(nb, pagesOf(nb).length - 1);
    return "made";
  }

  // (DYS-211) the page has come down onto the essay's page: the notebook's ink comes back under it (the same words, laid
  // out as the page's), the page fades off it (HAND_MS: a little light it brought from the open's moment gives way to the
  // room's now), then the two turns back at the riffle's pace, then the list as it was. The page's cover stays up, clear,
  // through the turns (as through the riffle: no tap or corner drag reaches the notebook mid-turn)
  async function turnBack(nb, my) {
    L.state = "settling"; mark("settle");
    nb.el.style.visibility = L.vis ?? "visible";
    await frames(1);
    if (run !== my) return;
    const f0 = performance.now();
    await new Promise((res) => {
      const f = (t) => { if (run !== my) return res(); const x = Math.min(1, Math.max(0, (t - f0) / HAND_MS)); sheet.style.opacity = String(1 - smooth(x)); if (x < 1) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f);
    });
    if (run !== my) return;
    // (the page stays at opacity 0, not hidden, until the turns are done: its layer let go at the end, the notebook at
    // rest, as DYS-160's close does, not in a turn's frame)
    sheet.style.opacity = "0";
    nb.pages.autoMs = RIFFLE_MS;
    for (let k = 0; k < 2; k++) {
      mark(`back ${k + 1}`);
      if (!nb.turn(-1)) break;
      L.back.turns++;
      await turned(nb);
      if (run !== my) return;
    }
    nb.pages.autoMs = null;
    // (the last turn's words fade in on the page before the list is laid out again: restore()'s build)
    L.back.inkWait = await inkIn(nb);
    if (run !== my) return;
    root.hidden = true; root.dataset.state = "closed";
    document.documentElement.classList.remove("rd-lock");
    restore();
    if (L.title) document.title = L.title;
    // the focus back on the essay's title in the notebook (as the reading sheet returns it)
    nb.linkFor?.(L.slug)?.focus({ preventScroll: true });
    mark("closed");
  }

  // (DYS-149 review) an open let go while its essay was still coming: nothing of it on screen (the cover not up, the
  // notebook untouched), so nothing to rebuild: closed
  function drop() {
    run = null; L.fetching = false; L.state = "closed";
    nav.engine?.cover?.(false);
    if (root) { root.hidden = true; root.dataset.state = "closed"; }
    mark("dropped");
  }

  // the list as it was (the notebook's own build keeps the leaf it is on)
  function restore() {
    const nb = ix();
    run = null; L.fetching = false;
    if (held) { unload(mediaIn(held.rest)); held = null; }   // (DYS-149: an open let go before its essay was all in)
    late = null;
    nav.engine?.cover?.(false);
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
    // (DYS-149, EO3: the warm-ups armed again, still at the notebook: what is not warm yet (an open let go before its
    // light was read, a rotation's new sizes); nothing when it all is)
    if (nav.spot === "notebook") { warmLight(); warmType(); }
  }

  window.__essayLift = L;
  return L;
}

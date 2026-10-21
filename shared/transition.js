// Page changes that feel like moving through the room.
//
//   import { zoomTo, arrive, prefetch } from "/shared/transition.js";
//   zoomTo(polygon, "/books/", { stage })   // homepage: lean into the shelf, then go (polygon: unused, kept for app.js)
//   arrive({ stage })                       // homepage: coming back from a page plays the zoom in reverse
//   arrive({ ready: room.ready })           // a page: drop the arrival picture once its room is up
//
// zoomTo works out where the destination page will draw its view of the room (shared/pages.js, the same
// layout the page itself uses), fits the desk view onto it through points both views share (the books on the
// shelf, the corners of the print or of the laptop screen), and moves the desk photograph there in one ease
// (~0.48 s) while the page's own photograph, already fetched, dissolves in over the second half. The page then
// shows that same photograph from its first paint (shared/arrive.js), so the click is one continuous move:
// no paper flash, no second zoom. Header links between rooms are view transitions (shared/arrive.js).
// Reduced motion: plain navigation, no animation.
import { loadScene, imageFormat, url } from "./sky.js";
import { getMoment } from "./masthead.js";

// The layout code is fetched when first needed, so the homepage never waits on it (or breaks without it).
let mods = null;
const deps = () => (mods ??= Promise.all([import("./room.js"), import("./pages.js")]).then(([room, pages]) => ({ ...room, ...pages })));

const KEY = "sky-zoom";
const DURATION = 480;
const BACK = 520;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(0.5, 0, 0.18, 1)";   // most of the move early, a long settle while the page's picture dissolves in
let last = null;   // the zoom this page played, kept for a back-forward cache restore

// The masthead is the same element on every page: name it, so a page change leaves it still.
for (const m of document.querySelectorAll(".masthead")) m.style.viewTransitionName = "masthead";

const norm = (p) => p.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/";
function read() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; }
}
function write(v) {
  try { v ? sessionStorage.setItem(KEY, JSON.stringify(v)) : sessionStorage.removeItem(KEY); } catch { /* fine */ }
}

// Where the page at href will draw its view right now, and the photograph it will show.
async function destination(href) {
  const { pageFor, heroBox, layoutView, imagePath, frameForView } = await deps();
  const page = pageFor(href);
  if (!page) return null;
  const [scene, fmt] = await Promise.all([loadScene(), imageFormat()]);
  const view = scene.views[page.view];
  if (!view) return null;
  const m = getMoment();
  const frame = frameForView(scene.frames, (m.frame && scene.frames.find((f) => f.id === m.frame.id)) || scene.frames[0], page.view);
  const box = heroBox();
  const geo = layoutView(view, box, page.opts);
  const path = imagePath(frame, page.view, geo);
  return path ? { page, view, frame, box, geo, src: url(path, fmt) } : null;
}

const images = new Map();
function load(src) {
  if (!images.has(src)) {
    const im = new Image();
    im.decoding = "async";
    im.src = src;
    images.set(src, { im, ready: im.decode().then(() => true, () => false) });
  }
  return images.get(src);
}

// Fetch the page's photograph ahead of a likely click (hover, focus, touch).
export function prefetch(href) {
  if (reduced()) return;
  destination(href).then((d) => d && load(d.src)).catch(() => {});
}

// Least-squares scale and shift (no rotation) taking points a onto points b.
function similarity(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const [a, b] of pairs) { ax += a[0]; ay += a[1]; bx += b[0]; by += b[1]; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let num = 0, den = 0;
  for (const [a, b] of pairs) {
    const dx = a[0] - ax, dy = a[1] - ay;
    num += dx * (b[0] - bx) + dy * (b[1] - by);
    den += dx * dx + dy * dy;
  }
  if (den < 1e-6) return null;
  const k = num / den;
  return { k, tx: bx - k * ax, ty: by - k * ay };
}

// The move that puts the desk view's points (homepage) where the page will draw them.
function fitMove(d, homeView, toViewport) {
  const A = d.page.anchors(homeView), B = d.page.anchors(d.view);
  const pairs = [];
  for (const key of Object.keys(A)) {
    if (!B[key]) continue;
    const g = d.geo;
    pairs.push([toViewport(A[key]), [g.left + B[key][0] * g.w, g.top + B[key][1] * g.h]]);
  }
  const m = similarity(pairs);
  if (!m || !(m.k > 0.5 && m.k < 6)) return null;
  return m;
}

// A fixed layer with the page's photograph exactly where the page will draw it, under the masthead,
// with the same darkening at the bottom that the pages put behind the masthead.
async function overlay(d, src) {
  const o = document.createElement("div");
  o.setAttribute("aria-hidden", "true");
  Object.assign(o.style, { position: "fixed", left: "0", top: "0", width: `${d.box.w}px`, height: `${d.box.h}px`, zIndex: "2", pointerEvents: "none", overflow: "hidden", opacity: "0" });
  const im = document.createElement("img");
  im.alt = "";
  im.src = src;
  Object.assign(im.style, { position: "absolute", left: `${d.geo.ix}px`, top: `${d.geo.top}px`, width: `${d.geo.iw}px`, height: `${d.geo.h}px`, maxWidth: "none" });
  const veil = document.createElement("div");
  Object.assign(veil.style, { position: "absolute", inset: "0", background: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 68%, rgba(8,6,4,0.55) 100%)" });
  o.append(im);
  document.body.append(o);
  if (d.page.decorate) await d.page.decorate(o, d.view, d.geo);
  o.append(veil);
  return o;
}

function stageMove(stage, m) {
  const r = stage.getBoundingClientRect();
  // with the origin at the stage's corner, translate(t) scale(k) sends viewport point p to k·p + (m.t)
  return `translate(${m.tx + (m.k - 1) * r.left}px, ${m.ty + (m.k - 1) * r.top}px) scale(${m.k})`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The homepage's view of the room is whichever home view has the stage's shape; its normalised
// coordinates map onto the stage as drawn right now.
async function homeOf(stage) {
  const scene = await loadScene();
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const views = ["home_l", "home_p"].map((k) => scene.views[k]).filter(Boolean);
  const view = views.reduce((a, b) => (Math.abs(b.width / b.height - r.width / r.height) < Math.abs(a.width / a.height - r.width / r.height) ? b : a), views[0]);
  return view ? { view, toViewport: ([x, y]) => [r.left + x * r.width, r.top + y * r.height] } : null;
}

// Homepage: lean into the object, then go.
export async function zoomTo(polygon, href, { stage, duration = DURATION } = {}) {
  const to = new URL(href, location.href);
  const go = () => { location.href = to.href; };
  if (reduced() || !stage || !stage.animate) { go(); return; }
  let d = null, m = null;
  try {
    const [dest, home] = await Promise.all([destination(to.href), homeOf(stage)]);
    d = dest;
    m = d && home && fitMove(d, home.view, home.toViewport);
  } catch { /* go anyway */ }
  if (!m) { go(); return; }
  const pic = load(d.src);
  if (last) settle(last);
  stage.style.transformOrigin = "0 0";
  const end = stageMove(stage, m);
  const t0 = performance.now();
  const a = stage.animate([{ transform: "none" }, { transform: end }], { duration, easing: EASE, fill: "forwards" });
  const o = await overlay(d, d.src);
  last = { stage, anims: [a], overlay: o, end };
  write({ from: location.pathname, to: to.pathname, t: Date.now(), src: d.src, box: d.box, geo: { ix: d.geo.ix, top: d.geo.top, iw: d.geo.iw, h: d.geo.h } });
  // the page's photograph dissolves in over the second half of the move (later, if it is still decoding)
  const ok = await Promise.race([pic.ready, wait(duration + 350).then(() => false)]);
  if (ok) {
    const at = performance.now() - t0, from = Math.max(at, duration * 0.52);
    const fade = o.animate([{ opacity: 0 }, { opacity: 1 }], { delay: from - at, duration: Math.max(140, duration - from), easing: "ease-in-out", fill: "forwards" });
    last.anims.push(fade);
    await Promise.all([a.finished, fade.finished]).catch(() => {});
  } else {
    await a.finished.catch(() => {});
  }
  write({ ...read(), t: Date.now() });
  go();
}

function settle(run) {
  for (const a of run.anims) a.cancel();
  if (run.overlay) run.overlay.remove();
  run.stage.style.transformOrigin = "";
}

// After the page shows its own photograph: drop the arrival picture (shared/arrive.js).
function release() {
  document.documentElement.classList.remove("zoom-in", "has-arrive");
}

// A page: call once its room is up (or with ready: room.ready). The homepage: call with its stage once
// laid out; coming back from a page it zoomed into, the zoom plays in reverse.
export function arrive({ stage, ready } = {}) {
  const rec = read();
  const here = norm(location.pathname);
  if (rec && !rec.arrived && norm(rec.to) === here && Date.now() - rec.t < 5000) {
    write({ ...rec, arrived: true });
    Promise.resolve(ready).catch(() => {}).then(() => requestAnimationFrame(release));
    return;
  }
  release();
  if (!rec || reduced() || !stage) return;
  let ref = null;
  try { ref = document.referrer ? norm(new URL(document.referrer).pathname) : null; } catch { /* ignore */ }
  const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  const back = (nav && nav.type === "back_forward") || (ref && ref === norm(rec.to));
  if (norm(rec.from) !== here || !back || Date.now() - rec.t > 30 * 60000) return;
  write(null);
  unzoom(rec, stage);
}

async function unzoom(rec, stage) {
  let d = null, m = null;
  try {
    const [dest, home] = await Promise.all([destination(rec.to), homeOf(stage)]);
    d = dest;
    m = d && home && fitMove(d, home.view, home.toViewport);
  } catch { return; }
  if (!m) return;
  const pic = load(d.src);
  const ok = await Promise.race([pic.ready, wait(250).then(() => false)]);
  stage.style.transformOrigin = "0 0";
  const start = stageMove(stage, m);
  const o = ok ? await overlay(d, d.src) : null;
  const run = { stage, anims: [], overlay: o };
  run.anims.push(stage.animate([{ transform: start }, { transform: "none" }], { duration: BACK, easing: "cubic-bezier(0.2, 0.7, 0.25, 1)", fill: "backwards" }));
  if (o) run.anims.push(o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: BACK * 0.5, easing: "ease-out", fill: "forwards" }));
  run.anims[0].finished.then(() => settle(run), () => settle(run));
}

// Back button with the homepage restored from the back-forward cache: unwind the zoom it played.
addEventListener("pageshow", (e) => {
  if (!e.persisted || !last) return;
  const run = last;
  last = null;
  write(null);
  if (reduced()) { settle(run); return; }
  const a = run.stage.animate([{ transform: run.end }, { transform: "none" }], { duration: BACK, easing: "cubic-bezier(0.2, 0.7, 0.25, 1)", fill: "forwards" });
  for (const x of run.anims) x.cancel();
  run.stage.style.transformOrigin = "0 0";
  if (run.overlay) { run.overlay.style.opacity = "1"; run.anims = [a, run.overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: BACK * 0.5, easing: "ease-out", fill: "forwards" })]; }
  else run.anims = [a];
  a.finished.then(() => settle(run), () => settle(run));
});

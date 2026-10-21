// A desk on Russian Hill. The view follows the real sun over San Francisco.
//
// Layers, bottom to top, all inside #stage (the room layer's size, cover-cropped around view.focus):
//   ext    the view outside (overscanned so it can drift with the mouse); <img>s, then the WebGL canvas.
//          A moment whose clouds and fog are separate layers (docs/v3/LAYERS.md) shows its "still" in the <img>s
//          (those layers composited at rest), so the sky is never empty before the living layer takes over or
//          without it (no WebGL, reduced motion); the living layer draws them itself over the bare exterior
//   glass  the lit room reflected in the window (dark moments), screen-blended, drifts 30% as much
//   room   the room itself (transparent window); snaps to the nearest moment, 2.5 s crossfade
//   halo   halation from the brightest parts of the view, screen-blended over the room, moves with ext
//   lqip   32 px preview of this moment, blurred, on top until the room and its view are both decoded;
//          then they appear together underneath it, fully opaque, and it dissolves (the window is never
//          see-through)
import * as sky from "/shared/sky.js";
import { initMasthead, getMoment, onMoment } from "/shared/masthead.js";
import { zoomTo, arrive, prefetch } from "/shared/transition.js";

// scripts run: the menu's About and Social blocks stay out of the page (style.css), even on /#about and /#social
document.documentElement.classList.add("sfw-js");

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const reducedQ = matchMedia("(prefers-reduced-motion: reduce)");
const fineQ = matchMedia("(pointer: fine)");
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const PORTRAIT_BELOW = 0.8;   // viewport aspect (w/h) under which the portrait view is used
const ROOM_FADE = 2500;       // ms, room crossfade when the nearest moment changes
const HALO = 0.45;            // halation strength (desaturated toward warm white in style.css)
const GLASS_DRIFT = 0.3;      // the reflection is a virtual image a few metres out: it drifts 30% as much

const VIEW_FADE = 900;        // ms, the view's crossfade as the sun moves between two rendered moments
const EASE = "cubic-bezier(0.42, 0, 0.58, 1)";   // every crossfade; js/live.js eases the living view the same way
// widest pictures before the first paint: the room sharp (it is near), the view a size down (the living
// layer takes it over), so the first paint stays near 320 KB on a desktop and 200 KB on a phone
const FIRST_PAINT = { home_l: { room: 2560, ext: 1600 }, home_p: { room: 1080, ext: 720 } };

let scene, frames, fmt;
let viewKey = null, view = null;
let sel = null;                     // { a, b, t } from sky.pickFrames
let geo = null;
let revealed = false;               // first full paint done
let dayLoaded = false;
let live = null, liveState = "off"; // off | starting | on

// ---------- images ----------
// One record per (moment, layer), at a width picked for this screen. Records are reused across updates;
// a sharper copy replaces the element in place after a resize.
const pics = new Map();

function chooseSize(sizes, pixels) {
  const path = sky.pickSize(sizes, pixels);
  const w = +Object.keys(sizes).find((k) => sizes[k] === path);
  return { w, path };
}

// Not every moment has every view: fall back to the nearest moment (in list order) that has it.
function withView(frame) {
  if (frame.images?.[viewKey]) return frame;
  const i = frames.indexOf(frame);
  let best = null, d = Infinity;
  frames.forEach((f, j) => { if (f.images?.[viewKey] && Math.abs(j - i) < d) { d = Math.abs(j - i); best = f; } });
  return best || frame;
}

function makeImg(path, high) {
  const el = new Image();
  el.decoding = "async";
  el.alt = "";
  el.draggable = false;
  el.className = "pic";
  if (high) el.fetchPriority = "high";
  el.src = sky.url(path, fmt);
  const loaded = () => new Promise((res) => {
    if (el.complete) return res();
    el.addEventListener("load", res, { once: true });
    el.addEventListener("error", res, { once: true });
  });
  const ready = (el.decode ? el.decode().catch(loaded) : loaded()).then(() => el.naturalWidth > 0);
  return { el, ready };
}

// Stopgap until the room pictures are re-rendered without it (docs/diagnosis/reports/diagnose_motion.md): in
// the foggy moments the fog volume also rendered into the room pass, as an opaque white band across the glass
// that hides the view's own fog and does not move with it. Find that band in the picture's alpha (a run of
// covered rows across the glass, with clear glass above and below it) and mask it out of the glass only, so
// the mullions keep theirs. A picture without the band is left alone.
// The reading happens in a worker (decoding and reading back a 4K picture on the page blocks it for 40-200 ms).
let bandWorker = null;
const bandJobs = new Map();
function bandWork(msg) {
  if (!bandWorker) {
    const src = `onmessage = async (e) => {
      const { id, url, hz, v0, v1, xs, nw, nh } = e.data;
      try {
        const blob = await (await fetch(url, { cache: "force-cache" })).blob();
        const W = Math.min(2048, nw), h = Math.max(8, Math.round(((v1 - v0) * nh * W) / nw)), H = h / (v1 - v0);
        const part = await createImageBitmap(blob, 0, Math.round(v0 * nh), nw, Math.round((v1 - v0) * nh), { resizeWidth: W, resizeHeight: h, resizeQuality: "medium", premultiplyAlpha: "none" });
        const c = new OffscreenCanvas(W, h), ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(part, 0, 0); part.close();
        const d = ctx.getImageData(0, 0, W, h).data;
        const A = (x, y) => d[(y * W + x) * 4 + 3] / 255;
        const ry = (v) => Math.min(h - 1, Math.max(0, Math.round((v - v0) * H)));
        const x0 = Math.max(0, Math.floor(xs[0] * W)), x1 = Math.min(W, Math.ceil(xs[1] * W));
        const g0 = ry(hz - 0.12), g1 = ry(hz - 0.035), glass = [];
        for (let x = x0; x < x1; x++) { let n = 0; for (let y = g0; y < g1; y++) if (A(x, y) < 0.05) n++; if (n > (g1 - g0) * 0.7) glass.push(x); }
        if (glass.length < (x1 - x0) * 0.2) return postMessage({ id });
        const row = (y) => glass.reduce((s, x) => s + A(x, y), 0) / glass.length;
        let r0 = -1, r1 = -1;
        for (let y = ry(hz - 0.03); y < ry(hz + 0.1); y++) {
          const m = row(y);
          if (r0 < 0) { if (m > 0.05) { if (y > ry(hz + 0.012)) return postMessage({ id }); r0 = y; } continue; }
          if (m < 0.015) { r1 = y; break; }
        }
        if (r0 < 0 || r1 < 0) return postMessage({ id });
        r0 = Math.max(1, r0 - 3); r1 = Math.min(h - 1, r1 + 3);
        const keep = new Float32Array(W).fill(1);
        for (let x = x0; x < x1; x++) {
          const ref = A(x, r0 - 1);
          let peak = ref;
          for (let y = r0; y <= r1; y++) peak = Math.max(peak, A(x, y));
          keep[x] = peak > 0.01 ? Math.min(1, ref / peak) : 1;
        }
        const s = new OffscreenCanvas(W, 1), sc = s.getContext("2d"), px = sc.createImageData(W, 1);
        for (let x = 0; x < W; x++) px.data[x * 4 + 3] = Math.round(Math.max(keep[x], keep[Math.max(0, x - 1)], keep[Math.min(W - 1, x + 1)]) * 255);
        sc.putImageData(px, 0, 0);
        const png = await s.convertToBlob({ type: "image/png" });
        postMessage({ id, png, b0: (v0 + r0 / H) * 100, b1: (v0 + (r1 + 1) / H) * 100 });
      } catch (err) { postMessage({ id }); }
    };`;
    bandWorker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    bandWorker.onmessage = (e) => { bandJobs.get(e.data.id)?.(e.data); bandJobs.delete(e.data.id); };
  }
  const id = Math.random();
  return new Promise((res) => { bandJobs.set(id, res); bandWorker.postMessage({ ...msg, id }); setTimeout(() => { if (bandJobs.delete(id)) res({}); }, 4000); });
}
async function clearGlassBand(img, frame) {
  const poly = view?.window;
  if (!poly || !img.naturalWidth || !((frame?.fog ?? 0) > 0.05) || !window.OffscreenCanvas) return;   // only foggy moments have it
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  // where to look: the band lies along the horizon, just above the bridge deck
  const deck = view.lights?.deck;
  const hz = deck?.length ? deck.reduce((s, p) => s + p[1], 0) / deck.length : (Math.min(...ys) + Math.max(...ys)) / 2;
  const r = await bandWork({ url: img.currentSrc || img.src, hz, v0: Math.max(0, hz - 0.13), v1: Math.min(1, hz + 0.11),
    xs: [Math.min(...xs), Math.max(...xs)], nw: img.naturalWidth, nh: img.naturalHeight });
  if (!r.png) return;
  const { b0, b1 } = r, bh = b1 - b0;
  // the opaque layer stops a little inside the strip's rows, so no row between the two is left uncovered
  const e0 = b0 + bh * 0.04, e1 = b1 - bh * 0.04;
  const gap = `linear-gradient(to bottom, #000 ${e0.toFixed(3)}%, transparent ${e0.toFixed(3)}%, transparent ${e1.toFixed(3)}%, #000 ${e1.toFixed(3)}%)`;
  const at = bh < 100 ? (b0 / (100 - bh)) * 100 : 0;
  const set = (k, v) => { img.style[k] = v; img.style["webkit" + k[0].toUpperCase() + k.slice(1)] = v; };
  set("maskImage", `url("${URL.createObjectURL(r.png)}"), ${gap}`);
  set("maskSize", `100% ${bh.toFixed(3)}%, 100% 100%`);
  set("maskPosition", `0 ${at.toFixed(3)}%, 0 0`);
  set("maskRepeat", "no-repeat, no-repeat");
}

// The pictures an <img> layer shows: the view outside is the still when there is one (see the top of this file).
const sizesOf = (imgs, layer) => (layer === "ext" ? imgs?.still || imgs?.ext : imgs?.[layer]);

// The bare exterior for the living layer, at the width the <img> shows (it composites the clouds and fog itself).
// Without a still the <img> is the bare exterior already.
function bareExt(frame) {
  const r = pic(frame, "ext");
  if (!r) return Promise.resolve(null);
  const imgs = withView(frame).images?.[viewKey];
  return r.ready.then((ok) => {
    if (!ok) return null;
    if (!imgs?.still || !imgs.ext) return r.el;
    const { el, ready } = makeImg(imgs.ext[String(r.w)] || sky.pickSize(imgs.ext, r.w));
    return ready.then((ok2) => (ok2 ? el : null));
  });
}

function pic(frame, layer, opt = {}) {
  const src = withView(frame);
  const sizes = sizesOf(src.images?.[viewKey], layer);
  if (!sizes) return null;
  const key = `${frame.id}/${layer}`;
  let rec = pics.get(key);
  if (opt.peek) return rec || null;
  // the first paint stays light (about 320 KB on a desktop, 200 KB on a phone): at most the middle size, and
  // the sharp copy follows straight after (pic() swaps it in once decoded)
  let px = geo ? geo.w * DPR() : innerWidth * DPR();
  if (!revealed) px = Math.min(px, FIRST_PAINT[viewKey]?.[layer] ?? px);
  const want = chooseSize(sizes, px);
  if (!rec) {
    const { el, ready } = makeImg(want.path, opt.high);
    rec = { key, frame, layer, w: want.w, el, ok: false, op: 0, ready: null, upgrading: 0 };
    rec.ready = ready.then(async (ok) => {
      if (ok && layer === "room") await clearGlassBand(el, src).catch(() => {});
      rec.ok = ok;
      rec.done = true;
      if (ok) refresh();
      return ok;
    });
    $(layer).appendChild(el);
    pics.set(key, rec);
  } else if (want.w > rec.w && want.w > rec.upgrading && rec.ok) {
    rec.upgrading = want.w;
    const { el, ready } = makeImg(want.path);
    ready.then((ok) => {
      if (!ok || !rec.el.isConnected) return;
      el.style.cssText = rec.el.style.cssText;
      rec.el.replaceWith(el);
      rec.el = el;
      rec.w = want.w;
      if (layer === "ext") live?.imageChanged(frame);
    });
  }
  return rec;
}

// ---------- what is on screen ----------
let roomTop = null, roomZ = 1, roomTimer = 0, extTimer = 0, slowUntil = 0;

// Fade one picture to an opacity. rec.op remembers the target, so repeated calls don't restart anything.
function show(rec, op, dur) {
  if (rec.op === op) return;
  rec.op = op;
  rec.el.style.transition = dur ? `opacity ${dur}ms ${EASE}` : "none";
  rec.el.style.opacity = String(op);
  // an instant change is committed now (polish-r2): a fade asked for later in the same frame then starts from it. At
  // first paint the crossfade's partner can decode inside the reveal's frame; the view's fade to t then started from
  // the opacity the browser last drew (0), so the other moment's view showed at full for most of a second
  if (!dur) void rec.el.offsetWidth;
}

// The room and its view arrive together, fully opaque, under the preview; then the preview dissolves.
function reveal(room, ext) {
  revealed = true;
  performance.mark?.("sky:reveal");
  show(room, 1, 0);
  show(ext, 1, 0);
  room.el.style.zIndex = String(++roomZ);
  ext.el.style.zIndex = "3";   // the room's own moment's view, above any other until the crossfade has both (refresh)
  roomTop = room;
  // two frames, so the photographs are on screen before the preview starts to go
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!revealed) return;
    lqip(false);
    afterFirstPaint();
  }));
}

function refresh() {
  if (!sel || behind) return;
  const near = sky.nearest(sel);
  const { a, b } = sel;
  const t = a === b ? 0 : sel.t;
  const load = (f, layer) => revealed || (f === near && (layer === "room" || layer === "ext"));
  const get = (f, layer) => pic(f, layer, load(f, layer) ? { high: !revealed } : { peek: true });

  // first paint: wait until the room and its view are both decoded, so the window is never empty
  if (!revealed) {
    const r = get(near, "room"), e = get(near, "ext");
    if (!(r?.ok && e?.ok)) return;
    reveal(r, e);
  }
  const reduced = reducedQ.matches;

  // the room snaps to the nearest moment; a change crossfades over 2.5 s
  const room = get(near, "room");
  if (room?.ok && room !== roomTop) {
    roomTop = room;
    const fade = reduced ? 0 : ROOM_FADE;
    slowUntil = performance.now() + fade;
    live?.roomFade(performance.now(), fade);   // the living view keeps in step with the room
    if (room.op === 1) {
      // back to a room still opaque underneath (the dial went back and forth): fade out what is over it
      const z = +room.el.style.zIndex;
      for (const rec of pics.values()) if (rec.layer === "room" && rec !== room && +rec.el.style.zIndex > z) show(rec, 0, fade);
    } else {
      room.el.style.zIndex = String(++roomZ);
      room.op = 0; room.el.style.transition = "none"; room.el.style.opacity = "0"; void room.el.offsetWidth;
      show(room, 1, fade);
    }
    clearTimeout(roomTimer);
    roomTimer = setTimeout(() => {
      for (const rec of pics.values()) if (rec.layer === "room" && rec !== roomTop) show(rec, 0, 0);
    }, fade + 100);
  }

  // While the room changes, the view and the screen layers change with it over the same 2.5 s.
  const dur = reduced ? 0 : performance.now() < slowUntil ? ROOM_FADE : VIEW_FADE;

  // the view crossfades a -> b by t: A opaque, B over it at t, and whatever was showing before stays
  // underneath until they are in (two layers fading independently would show the room's backdrop through).
  // Only once both are decoded: until then the room's own moment's view (the nearer, the one first paint revealed)
  // stays on top at full and the other waits unseen; starting with A alone put the other moment's view at full over
  // the room's for a moment whenever B, the nearer, was the one still loading (polish-r2: a blue sky over the golden
  // room at first paint)
  const ea = get(a, "ext"), eb = a === b ? null : get(b, "ext");
  const en = near === a ? ea : eb;
  if (ea?.ok && eb && !eb.ok && !eb.done) {
    if (en?.ok) { en.el.style.zIndex = "3"; show(en, 1, dur); }
  } else if (ea?.ok) {
    for (const rec of pics.values()) if (rec.layer === "ext" && rec !== ea && rec !== eb && rec.op > 0) rec.el.style.zIndex = "1";
    ea.el.style.zIndex = "2";
    show(ea, 1, dur);
    if (eb?.ok) { eb.el.style.zIndex = "3"; show(eb, t, dur); }
    clearTimeout(extTimer);
    extTimer = setTimeout(() => {
      for (const rec of pics.values()) if (rec.layer === "ext" && rec !== ea && rec !== eb) show(rec, 0, 0);
    }, dur + 100);
  }

  // screen layers: each moment's at its own weight
  for (const [layer, k] of [["glass", 1], ["halo", HALO]]) {
    const ga = get(a, layer), gb = a === b ? null : get(b, layer);
    for (const rec of pics.values()) if (rec.layer === layer && rec !== ga && rec !== gb) show(rec, 0, dur);
    if (ga?.ok) show(ga, (1 - t) * k, dur);
    if (gb?.ok) show(gb, t * k, dur);
  }
}

function afterFirstPaint() {
  // the crossfade partner and the screen layers, then the rest only when needed
  for (const f of [sel.a, sel.b]) for (const l of ["ext", "room", "glass", "halo"]) pic(f, l);
  refresh();
  // the router (and with it the 3D) starts now, right after first paint (handover-r1): the photograph's own requests
  // above are already asked for, so they stay first. It used to wait for the page's load event (every picture,
  // these included) and an idle moment, seconds on a phone network. The 2D living layer still waits for them.
  setTimeout(startNav, 0);
  const start = () => (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => { startLive(); }, { timeout: 1500 });
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}

function loadDay() {
  if (dayLoaded || !revealed || roomOnTop()) return;
  dayLoaded = true;
  for (const f of frames) for (const l of ["ext", "room", "glass", "halo"]) pic(f, l);
}

// ---------- layout: cover the viewport, centred on view.focus ----------
function chooseView() {
  const key = innerWidth / innerHeight < PORTRAIT_BELOW && scene.views.home_p ? "home_p" : "home_l";
  if (key === viewKey) return false;
  viewKey = key;
  view = scene.views[key];
  return true;
}

function layout() {
  const box = $("scene").getBoundingClientRect();
  const W = view.width, H = view.height, f = view.overscan || 1;
  const s = Math.max(box.width / W, box.height / H);
  const w = W * s, h = H * s;
  const fx = view.focus?.[0] ?? 0.5, fy = view.focus?.[1] ?? 0.5;
  const left = keepShelf(clamp(box.width / 2 - fx * w, box.width - w, 0), box, w);   // pages stream
  const top = clamp(box.height / 2 - fy * h, box.height - h, 0);
  const stage = $("stage");
  Object.assign(stage.style, { width: `${w}px`, height: `${h}px`, left: `${left}px`, top: `${top}px` });
  for (const id of ["ext", "halo"]) {
    const el = $(id);
    el.style.width = `${w * f}px`;
    el.style.height = `${h * f}px`;
  }
  geo = { w, h, f, left, top, base: { x: -((f - 1) / 2) * w, y: -((f - 1) / 2) * h }, maxShift: ((f - 1) / 2) * w * 0.85 };
  applyParallax(true);
  live?.resize(geo);
  placePrint();   // pages stream
}

// The halation only spills from what is visible through the window: feather it to the window opening.
function haloMask() {
  const el = $("halo-mask");
  const poly = view.window;
  if (!poly) { el.style.maskImage = el.style.webkitMaskImage = ""; return; }
  const pts = poly.map((p) => p.join(",")).join(" ");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1' preserveAspectRatio='none'><filter id='b' x='-.2' y='-.2' width='1.4' height='1.4'><feGaussianBlur stdDeviation='.012'/></filter><polygon points='${pts}' fill='#000' filter='url(#b)'/></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  for (const p of ["maskImage", "webkitMaskImage"]) el.style[p] = url;
  for (const p of ["maskSize", "webkitMaskSize"]) el.style[p] = "100% 100%";
  for (const p of ["maskRepeat", "webkitMaskRepeat"]) el.style[p] = "no-repeat";
}

// ---------- parallax: the view drifts with the mouse; phones drift slowly on their own ----------
const target = { x: 0, y: 0 }, pos = { x: 0, y: 0 }, drawn = { x: NaN, y: NaN };
// handover-r1: before the 3D takes over (it starts at the photograph's rest camera), the parallax eases back to rest,
// so neither the room nor the view outside jumps at the crossfade; it stays at rest under the 3D (resumed if the 3D
// falls back to the photographs). { res, until } while settling, true once at rest
let parallaxHeld = null;
function holdParallax(on) {
  if (!on) { parallaxHeld = null; return Promise.resolve(); }
  if (parallaxHeld === true) return Promise.resolve();
  if (parallaxHeld) return parallaxHeld.p;
  let res;
  const p = new Promise((r) => { res = r; });
  parallaxHeld = { p, res, until: performance.now() + 900 };
  return p;
}
addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse" || parallaxHeld) return;
  target.x = (e.clientX / innerWidth) * 2 - 1;
  target.y = (e.clientY / innerHeight) * 2 - 1;
}, { passive: true });

function applyParallax(force) {
  if (!geo) return;
  if (!force && Math.abs(pos.x - drawn.x) < 1e-4 && Math.abs(pos.y - drawn.y) < 1e-4) return;
  drawn.x = pos.x; drawn.y = pos.y;
  const dx = -pos.x * geo.maxShift, dy = -pos.y * geo.maxShift * 0.45;
  const ext = `translate3d(${geo.base.x + dx}px, ${geo.base.y + dy}px, 0)`;
  $("ext").style.transform = ext;
  $("halo").style.transform = ext;
  $("glass").style.transform = `translate3d(${dx * GLASS_DRIFT}px, ${dy * GLASS_DRIFT}px, 0)`;
  const room = `translate3d(${pos.x * 3}px, ${pos.y * 2}px, 0)`;
  $("room").style.transform = room;
  $("hotspots").style.transform = room;
}

let lastTick = 0, sceneOnScreen = true;
function tick(now) {
  const dt = Math.min(100, now - (lastTick || now));
  lastTick = now;
  if (parallaxHeld && typeof parallaxHeld === "object") {
    // settling: a quicker ease to rest (about half a second), then exactly at rest
    const k = 1 - Math.exp(-dt / 120);
    pos.x -= pos.x * k; pos.y -= pos.y * k;
    if ((Math.abs(pos.x) < 0.002 && Math.abs(pos.y) < 0.002) || now > parallaxHeld.until) {
      pos.x = pos.y = 0; target.x = target.y = 0;
      const { res } = parallaxHeld;
      parallaxHeld = true;
      res();
    }
    applyParallax(false);
  } else if (geo && !reducedQ.matches && !parallaxHeld) {
    if (!fineQ.matches) { target.x = Math.sin(now / 9000) * 0.5; target.y = Math.sin(now / 13000) * 0.25; }
    const k = 1 - Math.exp(-dt / 360);
    pos.x += (target.x - pos.x) * k;
    pos.y += (target.y - pos.y) * k;
    applyParallax(false);
  }
  if (live && sceneOnScreen) live.frame(now);
  requestAnimationFrame(tick);
}

// ---------- hotspots ----------
const LABELS = {
  window: { text: "Try another time", action: "dial" },
  books: { text: "Books", href: "/books/" },
  laptop: { text: "Projects", href: "/projects/" },
  quote: { text: "Quotes", href: "/quotes.html" },
  // the notebook is his writing (interactions B): its name is an accessible name only, never painted
  notebook: { text: "Writing", href: "/writing/", notip: true },
};

function navigate(name, meta, poly) {
  // the window is a spot of its own (a history entry, the dial docked); the notebook leans in in the live room, and
  // without it opens the essays' own page (shared/router.js)
  if (meta.action === "dial") {
    if (nav?.room) { nav.enterWindow(); return; }
    if ($("dial").hidden) $("now").click(); $("dial-range").focus({ preventScroll: true }); return;
  }
  if (name === "notebook" && nav?.room) { nav.go("notebook"); return; }
  if (meta.href.startsWith("#")) {
    document.querySelector(meta.href).scrollIntoView({ behavior: reducedQ.matches ? "auto" : "smooth" }); return;
  }
  // lean into the object, then go (shared/transition.js); the polygon in viewport pixels
  const r = $("stage").getBoundingClientRect();
  zoomTo(poly.map(([x, y]) => [r.left + x * r.width, r.top + y * r.height]), meta.href, { stage: $("stage") });
}

const SVG = "http://www.w3.org/2000/svg";
function buildHotspots() {
  const svg = $("hotspots"), tip = $("tip");
  svg.replaceChildren();
  const list = [];
  if (view.window) list.push(["window", view.window]);
  for (const name of ["books", "laptop", "quote", "notebook"]) if (view.hotspots?.[name]) list.push([name, view.hotspots[name]]);
  const hideTip = () => { tip.hidden = true; tip.classList.remove("at-focus"); };
  for (const [name, poly] of list) {
    const meta = LABELS[name];
    if (!meta || poly.length < 3) continue;
    const points = poly.map((q) => q.join(",")).join(" ");
    const p = document.createElementNS(SVG, "polygon");
    p.setAttribute("class", "hit");
    p.setAttribute("points", points);
    p.setAttribute("tabindex", "0");
    p.setAttribute("role", meta.action ? "button" : "link");
    p.setAttribute("aria-label", meta.text);
    // no outline over the objects and no words at the pointer (Akshay, 2026-10-15; spec v2): the cursor changes, the
    // name stays for screen readers, and keyboard focus shows it at the object's middle (never the window's)
    const tipped = !meta.action && !meta.notip;
    const go = () => { hideTip(); navigate(name, meta, poly); };
    p.addEventListener("click", go);
    p.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    // keyboard focus says where it leads, at the middle of the object (kept on screen)
    p.addEventListener("focus", () => {
      if (!p.matches(":focus-visible") || !tipped) return;
      const r = p.getBoundingClientRect();
      tip.textContent = meta.text;
      tip.classList.add("at-focus");
      tip.style.left = `${clamp(r.left + r.width / 2, 70, innerWidth - 70)}px`;
      tip.style.top = `${clamp(r.top + r.height / 2, 24, innerHeight - 24)}px`;
      tip.hidden = false;
    });
    p.addEventListener("blur", hideTip);
    svg.append(p);
  }
}

// ---------- the clock ----------
// shared/masthead.js owns the minute (?time=, a dial choice, or now), the caption, the dial and the palette.
// The homepage picks its own pair of moments from the full scene so the view can crossfade between them.
const minutesOf = () => getMoment().minutes ?? sky.minutesNowSF();

// tod-mobile (20 Oct): on a phone, while the live 3D room covers the photographs, nobody sees them or their living
// layer, yet every time of day added its room, view, glass and halo pictures (~26 MB decoded each on a 3x phone) and
// its view's textures, and opening the dial asked for all 14 moments' at once: with the 3D's own light maps that was
// more than iOS lets a page keep, so Safari reloaded it on the second change. Now they wait while the 3D is on top
// (the pictures of other moments are let go) and catch up as soon as the photograph is shown again (the 3D's fallback,
// a lost context). Desktops and tablets keep everything as before. (The engine's tier rule: shared/gl/engine.js.)
const PHONE = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
const roomOnTop = () => PHONE && revealed && root.classList.contains("sfw-live-mode") && !root.classList.contains("sfw-3d-off") &&
  !!document.querySelector(".sfw-canvas.is-on");
let behind = false;   // the photographs skipped a moment under the 3D
function letGo() {
  // every picture not on screen (under the 3D: the moment the photograph last showed stays, for a fallback)
  for (const [k, rec] of [...pics]) if (rec.op === 0 && rec !== roomTop) { rec.el.remove(); pics.delete(k); }
}

function update() {
  const date = sky.sfDate(getMoment().minutes);
  sel = sky.pickFrames(frames, sky.sunPosition(date));
  if (!revealed) setLqip(sky.nearest(sel));
  if (roomOnTop()) { behind = true; letGo(); return; }
  behind = false;
  refresh();
  live?.setMoment(sel, minutesOf());
}

// The preview: the head may already have set it (index.html, when shared/frames-lite.js carries it);
// otherwise it comes with scene.json and fades in over the flat colours.
function setLqip(frame) {
  const src = withView(frame).lqip?.[viewKey];
  if (!src) return;
  const v = `url("${src}")`;
  const had = root.style.getPropertyValue("--lqip");
  if (had === v) return;
  root.style.setProperty("--lqip", v);
  if (!had && !reducedQ.matches) {
    const el = $("lqip");
    el.style.transition = "none";
    el.style.opacity = "0";
    void el.offsetWidth;
    el.style.transition = "opacity .35s ease";
    el.style.opacity = "1";
  }
}

// show (instantly) or dissolve the preview
function lqip(on) {
  const el = $("lqip");
  el.style.transition = on || reducedQ.matches ? "none" : "";
  el.style.opacity = on ? "1" : "0";
}

// ---------- the living layer (js/live.js): WebGL2 view, traffic, boats, steam, dust ----------
async function startLive() {
  if (liveState !== "off" || reducedQ.matches || !revealed) return;
  liveState = "starting";
  try {
    const mod = await import("/js/live.js");
    const made = await mod.createLive({
      view, geo, fade: ROOM_FADE, viewKey,
      asset: (sizes, pixels) => sky.url(sky.pickSize(sizes, pixels), fmt),
      ext: $("ext"), room: $("room"),
      image: bareExt,
      roomImage: (frame) => { const r = pic(frame, "room", { peek: true }); return r?.ok ? r.el : null; },
    });
    if (liveState !== "starting" || !made) { made?.destroy(); if (liveState === "starting") liveState = "off"; return; }
    live = made;
    liveState = "on";
    // ?debug: a read-only look at the living layer's state, for checking alignment and crossfades
    if (new URLSearchParams(location.search).has("debug")) Object.defineProperty(window, "__live", { configurable: true, get: () => live?.info ?? null });
    live.setMoment(sel, minutesOf());
  } catch (err) {
    liveState = "off";
    live = null;
    console.warn("living layer unavailable:", err && err.message);
  }
}

function stopLive() {
  live?.destroy();
  live = null;
  liveState = "off";
}

// ---------- a different view (portrait <-> landscape) ----------
function resetView() {
  stopLive();
  for (const rec of pics.values()) rec.el.remove();
  pics.clear();
  roomTop = null; revealed = false; dayLoaded = false; slowUntil = 0;
  clearTimeout(roomTimer); clearTimeout(extTimer);
  lqip(true);   // the other view's preview until this one's is set (update, next frame)
  haloMask();
  buildHotspots();
}

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (chooseView()) { resetView(); requestAnimationFrame(() => { layout(); update(); }); return; }
    layout();
    if (revealed) for (const rec of [...pics.values()]) if (rec.op > 0) pic(rec.frame, rec.layer);
  }, 150);
}

async function main() {
  initMasthead($("masthead"));
  const fmtP = sky.imageFormat();
  scene = await sky.loadScene();
  frames = scene.frames;
  chooseView();
  layout();
  setLqip(sky.nearest(sky.pickFrames(frames, sky.sunPosition(sky.sfDate(getMoment().minutes)))));
  fmt = await fmtP;
  haloMask();
  buildHotspots();
  update();
  arrive({ stage: $("stage") });
  onMoment(() => update());
  // (tod-mobile) the photograph is shown again: it catches up with the time of day
  if (PHONE) new MutationObserver(() => { if (behind && !roomOnTop()) update(); }).observe(root, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("sky:dial", (e) => { if (e.detail?.open) loadDay(); });
  addEventListener("resize", onResize);
  setInterval(update, 60000);
  new IntersectionObserver(([e]) => { sceneOnScreen = e.isIntersecting; }).observe($("scene"));
  reducedQ.addEventListener?.("change", () => { if (reducedQ.matches) { stopLive(); pos.x = pos.y = 0; applyParallax(true); } else startLive(); });
  requestAnimationFrame(tick);
}
main();

// ===== pages stream: the shelf in the crop, and the print on the desk =====
// The crop keeps the shelf in sight on windows about 1.3:1 and wider: from x = 0.10 of the frame (its nearest
// books) at 1.3:1, more of it on wider windows, as long as the print (right edge x = 0.94) stays in view too.
// Narrower windows keep the plain crop around the bridge. The Books hotspot is clickable wherever it shows.
const SHELF_FROM = 1.28;
function keepShelf(left, box, w) {
  if (viewKey !== "home_l" || box.width / box.height < SHELF_FROM) return left;
  const x0 = clamp(0.94 - box.width / w, 0.04, 0.10);
  return clamp(Math.max(left, -x0 * w), box.width - w, 0);
}

// The print on the desk is rendered blank: shared/print.js sets the day's quote on it (one a day, the same for
// everyone), in perspective, the quote the Quotes page opens on. It sits in the room layer, so it moves with the room.
// (print.js is fetched after the scene is up, so the homepage never waits on it or breaks without it)
// Only over renders whose paper is blank (scene.json views.<view>.print, from build_web.py): the v2 renders still
// carry the Frankl quote, and the typeset quote would sit on top of it.
let print = null, printMod = null;
const blankPrint = () => (view?.print === "blank" ? view.quads?.print : null);
function placePrint() {
  if (print?.liveAnchored) return;   // the live room keeps it on the 3D print (shared/router.js)
  const q = blankPrint();
  if (!q || !geo) { print?.hide(true); return; }
  if (!printMod) {
    printMod = Promise.all([import("/shared/print.js"), import("/shared/room.js")]).catch(() => null);
    printMod.then((m) => m && placePrint());
    return;
  }
  printMod.then((m) => {
    if (!m || !blankPrint() || !geo) return;
    const [{ mountPrint, currentQuote, dailyQuote }, { cssCorners }] = m;
    if (!print) { print = mountPrint($("room")); print.el.style.zIndex = "100000"; print.current = currentQuote; print.daily = dailyQuote; }   // above the room's photographs
    print.hide(false);
    const P = cssCorners(view.quads.print).map(([x, y]) => [x * geo.w, y * geo.h]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    print.place(P, (d(P[0], P[1]) + d(P[3], P[2])) / 2, (d(P[0], P[3]) + d(P[1], P[2])) / 2);
    // (the paper stays blank until the day's quote is known: it never shows one quote, then another)
    dailyQuote().then((q) => print.set(q, { animate: false }));
  });
}
// back from the Quotes page (or a new day): the day's quote again
addEventListener("pageshow", () => { print?.daily?.().then((q) => print.set(q)); });
// fetch a page's photograph while the pointer is on its object, so the zoom can dissolve straight into it
$("hotspots").addEventListener("pointerover", (e) => {
  const meta = LABELS[Object.keys(LABELS).find((k) => LABELS[k].text === e.target.getAttribute?.("aria-label"))];
  if (meta?.href && meta.href.startsWith("/")) prefetch(meta.href);
});


// The menu's About and Social before the router is here (it loads right after first paint): the tap starts it at once
// on the address it asked for, and the router's own fresh /#about and /#social paths open the bio or go to the phone. Once the router runs, its own click handler takes these links.
document.addEventListener("click", (e) => {
  if (nav || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href="/#about"], a[href="/#social"]');
  if (!a) return;
  e.preventDefault();
  if (navAsked) return;   // already loading: the address it boots on was set by the first tap
  history.replaceState(history.state, "", location.pathname + location.search + a.getAttribute("href").slice(1));
  startNav();
}, true);

// How it's made (/how-its-made/) is a plain page, outside the cross-document dissolve: leaving for it, the transition this
// page opted into is skipped here, so none is handed to a page that would only abort it (an uncaught InvalidStateError
// in the smoke's console); the skip's own rejections are caught (shared/arrive.js does the same on the page documents)
addEventListener("pageswap", (e) => {
  const vt = e.viewTransition, to = e.activation?.entry?.url;
  if (!vt || !to || !/^\/how-its-made(\/|$)/.test(new URL(to).pathname)) return;
  for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p?.catch?.(() => {});
  vt.skipTransition();
});

// ===== navigation stream: the persistent room (shared/router.js) =====
// Fetched after first paint. It adds the window spot, the About card, and (once the 3D room is ready) glides
// between the room's spots with real addresses; until then, and without it, everything above works as it is.
let nav = null, navAsked = false;
function startNav() {
  if (nav || navAsked) return;
  navAsked = true;
  // a module whose fetch failed is remembered as failed for this page: a retry has to ask under another name
  import("/shared/router.js").catch(() => new Promise((r) => setTimeout(r, 800)).then(() => import("/shared/router.js?retry=1"))).then(({ startRouter }) => {
    nav = startRouter({
      doc: "home",
      hero: $("scene"),
      stage: $("stage"),
      tip: $("tip"),
      print: () => print,
      // the photograph on screen: its view, render size and layout (the 3D starts exactly on it)
      photo: () => (view && geo ? { view: viewKey, size: [view.width, view.height], geo: { w: geo.w, h: geo.h, left: geo.left, top: geo.top } } : null),
      windowPolygon: () => view?.window || null,
      // the exterior pictures on screen (moments a and b, b over a at t): the live view outside starts on these pixels
      exterior: () => {
        if (!sel) return null;
        const ea = pics.get(`${sel.a.id}/ext`), eb = sel.a === sel.b ? null : pics.get(`${sel.b.id}/ext`);
        if (!ea?.ok) return null;
        const src = (r) => r.el.currentSrc || r.el.src;
        return { a: src(ea), b: eb?.ok ? src(eb) : null, t: eb?.ok ? sel.t : 0, ids: [sel.a.id, sel.b.id] };
      },
      relayout: () => layout(),
      // the photograph's parallax to rest before the 3D hands over (false: resume it), resolves at rest
      parallax: (on) => holdParallax(!on),
      windowLink: () => $("hotspots").querySelector('[aria-label="Try another time"]'),
      // today's zoom into an object, in viewport pixels, for the never-wait fallback
      hotspotPolygon: (spot) => {
        const key = { shelf: "books", laptop: "laptop", print: "quote", notebook: "notebook" }[spot];
        const poly = key && view?.hotspots?.[key];
        if (!poly) return null;
        const r = $("stage").getBoundingClientRect();
        return poly.map(([x, y]) => [r.left + x * r.width, r.top + y * r.height]);
      },
    });
  }).catch((e) => console.warn("navigation unavailable:", e && e.message));
}

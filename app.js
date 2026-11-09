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
import { phoneNow } from "/shared/device.js";

// scripts run: the menu's About and Social blocks stay out of the page (style.css), even on /#about and /#social
document.documentElement.classList.add("sfw-js");

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const reducedQ = matchMedia("(prefers-reduced-motion: reduce)");
const fineQ = matchMedia("(pointer: fine)");
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// v3/firstvisit-a2 (?firstvisit=a2, a first visit only; Akshay's pick 27 Oct, docs/v3/briefs/first-visit-a2.md): the
// visit opens close on the laptop, the photograph's own crop (the 3D starts on the same crop: a crop of the photograph
// is a narrower lens from the same camera, router.js bootPose), its screen dark with his name, a thin bar and the
// boot's share (shared/firstvisit-a2.js fills it). The masthead and the room's input wait until the room has pulled
// back. Off on a second visit or with reduced motion: today's homepage.
// (DYS-12, Akshay 28 Oct 'yes switch it on': every first visit to the bare homepage, no longer behind ?firstvisit=a2.
// Not for a page read inside the homepage on a refresh, ?page= or ?writing= (B, DYS-21: an essay's refresh opened on the
// laptop), any other path or #, ?firstvisit=0 (tests, and a way out), nor where the room won't run: the head's own
// verdict, html.sfw-room-menu (shared/sky-head.js: reduced motion, ?3d=0, Save-Data, a 2G line, a small device, a visit
// whose room did not start))
const FV2 = (() => {
  const q = new URLSearchParams(location.search), f = q.get("firstvisit");
  if (f === "0" || f === "a" || f === "b" || reducedQ.matches || !root.classList.contains("sfw-room-menu")) return false;
  if (location.pathname !== "/" || location.hash || q.has("page") || q.has("writing")) return false;
  if (q.get("intro") === "again") return true;
  try { return localStorage.getItem("sfw-intro") !== "1"; } catch { return false; }
})();
// (DYS-212, index.html @sfw-load-head: a later visit's still takes no input until the router has the room in,
// html.sfw-loading; the head decides by this same rule, so a first visit never has it: here too, whatever it said)
const loadingStill = () => root.classList.contains("sfw-loading");
if (FV2) root.classList.remove("sfw-loading");
// (DYS-21: 0.45 > 0.36. The largest photograph is 3840 px; at 0.45 of a 1440 px window it is stretched ~2x on a
// DPR 2 screen, Akshay: 'the laptop looks pixelated'; at 0.36, ~1.6x)
const FV_FILL = 0.36, FV_FILL_P = 0.82, FV_Y = 0.46;   // the screen's width of the window's (portrait: of its width), its centre's height
const FV_BLEED = 3;                                    // px into the bezel all round: no rim of the photograph's own screen
// (DYS-12, the coordinator 23:0x 28 Oct: a first visit within 1.5 MB of v3/live's, as sharp; opened close every layer had
// asked for its 3840 px picture, +8.3 MB) while close only the room's picture (small) is sized for the magnified view;
// the others for the uncropped one, and the window layer gets a crop of just what the close view shows, cut from its
// largest picture (scripts/live/fv_crops.py: frames/fvcrop/<moment>-<view>-ext; these boxes in the layer's own [0,1]:
// layout()'s close framing over a spread of screens, the parallax's reach and a margin), gone at the pull back
const FV_CROP = { home_l: [0.2662, 0.4461, 0.6744, 0.95], home_p: [0.0977, 0.6113, 0.4468, 0.8868], home_m: [0.0926, 0.3604, 0.4407, 0.7276] };
let fvZoom = FV2 ? 1 : 0, fvScreen = null, liveDeferred = false;
// (G, DYS-230 round 2c) fvZoomK: the close opening's zoom on the photograph (layout()); fvPull: the tap's one move's
// rest for the room's 3D pull back ({ end, ease }: firstVisit.pull)
let fvZoomK = 1, fvPull = null;
// (DYS-216, C) ?bootlate=1: what the first view doesn't need waits until the room is shown (the 2D living layer here;
// router.js the desk's screens and layers). Off by default until Akshay's before / after
const BOOT_LATE = new URLSearchParams(location.search).get("bootlate") === "1", LIVE_LATE_MAX = 20000;
// (DYS-212, Akshay 1 Nov: 'so the laptop is level') a phone's close opening is turned so the laptop's screen is level
// (sky.fvLevelFor: ~3.3 deg on home_m). Every one of the room's layers in the hero is turned alike (the photograph's
// stage, the 3D canvas, the loading screen, the laptop's live page, the links, ...: all but FV_LEVEL_KEEP, the hero's
// own chrome, hidden while close anyway), by rotate + scale about the hero's centre, so the 3D matches the photograph
// by construction (no camera roll). The individual properties (rotate, scale, translate), so each layer's own transform
// (the loading screen's and the live page's homographies) stays as it is; translate moves each one's own transform
// origin to the hero's centre (sky.turnAbout). The pull back straightens it with the rig's own ease (fvUnlevel, from
// router.js bootEase); fvUnzoom (fv.settled, fv.bootFailed) clears whatever is left
const FV_LEVEL_KEEP = ".masthead, .veil, .tip, .sfw-close, .sfw-about, .sfw-edges, .quiet-corner, .fv-labels, .egg";
let fvLevel = null;        // { deg, s, w, h }: the turn while close, and the hero's size
let fvLevelEase = null;    // { raf }: the pull back straightening it
let fvLevelGone = false;   // the pull back has begun (or the zoom is gone): never turned again
let fvLevelMO = null;      // (layers the router adds while close are turned as they come)
let fvCam = null;          // (G, DYS-230 round 2) { z, F }: the first visit's camera on the room, z about F (hero px): fvCamSet
const fvLevelEls = new Set(), fvLevelAt = new WeakMap();   // the layers turned; each one's transform origin (hero px)
// (@sfw-fv-head, index.html) the head decided the same by the same rule; where this says otherwise, nothing stays hidden
if (!FV2) root.classList.remove("sfw-fv-close", "sfw-fv-boot");
// (DYS-212, call 2) the menu hidden while loading (index.html @sfw-chrome-head): a first visit hides it here too, in case
// the head did not; where neither a first visit nor a later visit's loading holds it, it shows now
if (FV2) root.classList.add("sfw-chrome-hide");
else if (!root.classList.contains("sfw-loading")) globalThis.sfwChromeIn?.(0);
const fvMod = FV2 ? import("/shared/overlays.js").catch(() => null) : null;
// (DYS-221, Akshay's pick A, 1 Nov) the loading screen on the laptop is the Mac's lock screen (shared/lockscreen.js): dark
// until the photograph is up, then it wakes (his view of SF at this moment as its wallpaper), the fingerprint ring fills
// with the boot's share, 'Touch to unlock', and the tap unlocks onto the laptop's About page before the pull back
// (shared/firstvisit-a2.js). ?lock=0: C's dark screen with his name and the bar, as before
const LOCK = FV2 && new URLSearchParams(location.search).get("lock") !== "0";
const lockMod = LOCK ? import("/shared/lockscreen.js").catch(() => null) : null;
let fvLock = null, fvWoke = false;
// (DYS-230, Akshay's pick 2 Nov; the default since his OK, 3 Nov; ?lock=a today's lock A) the first visit's lock screen fills the viewport (fvFull, its
// own lock in full mode) over everything, black until it wakes; on the tap it shrinks onto the laptop's screen, where the
// lock in its box (fvLock) takes over, unlocks onto the About page, and the pull back goes on
const LOCK_FULL = LOCK && new URLSearchParams(location.search).get("lock") !== "a";   // (FLIP 3 Nov: the default; ?lock=a lock A)
// (the head sets html.sfw-fv-full on a first visit; where there is no full lock here (no opening: reduced motion, a
// small device ...; or ?lock=a / 0) it goes, so its first-paint wallpaper never stays over the page)
if (!LOCK_FULL) root.classList.remove("sfw-fv-full");
let fvFull = null, fvFullLock = null, fvWallUrl = null, fvSoft = null;
const shrinkMod = LOCK_FULL ? import("/shared/fvshrink.js").catch(() => null) : null;   // (G: the shrink, fvShrink)
if (FV2) {
  root.classList.add("sfw-fv-close");
  if (LOCK_FULL) queueMicrotask(mountFvFull);   // (DYS-230: once the FV2 style below is in)
  const st = document.createElement("style");
  st.textContent = `
html.sfw-fv-close .quiet-corner { opacity: 0; pointer-events: none; }
html.sfw-chrome-hide .masthead, html.sfw-chrome-hide .sfw-edges { opacity: 0; visibility: hidden; pointer-events: none; }
html.sfw-fv-in .masthead, html.sfw-fv-in .sfw-edges, html.sfw-fv-in .quiet-corner { transition: opacity 0.6s ease; }
html.sfw-fv-close #scene { pointer-events: none; }
/* (DYS-221, G's B1 / S1) the room's link outlines, the photograph's hotspots and the Quiet link: no tap and no focus while close
   (the links' own pointer-events: auto beat #scene's none; a tap on the lock's ring fell through to the laptop) */
html.sfw-fv-close .sfw-links, html.sfw-fv-close #hotspots, html.sfw-fv-close .quiet-corner { visibility: hidden; }
.fv-screen { position: absolute; left: 0; top: 0; transform-origin: 0 0; z-index: 3; background: #0c0c0d; color: #f4f2ee;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.9em; pointer-events: none;
  transition: opacity 0.3s ease; }
.fv-screen .fv-name { font-weight: 500; letter-spacing: -0.01em; }
.fv-screen .fv-row { display: flex; align-items: center; gap: 0.7em; font-size: 0.42em; color: rgba(244, 242, 238, 0.72);
  font-variant-numeric: tabular-nums; }
.fv-screen .fv-bar { position: relative; width: 11em; height: 2px; border-radius: 1px; background: rgba(244, 242, 238, 0.18); overflow: hidden; }
.fv-screen .fv-bar i { position: absolute; inset: 0; background: #f4f2ee; transform-origin: 0 50%; transform: scaleX(0); }   /* (eased in firstvisit-a2.js with its number) */
.fv-screen .fv-pct { min-width: 2.6em; text-align: right; }
/* (DYS-212, Akshay 1 Nov) once the room is live under it: 'Enter' in the bar's place, the whole screen the tap target */
.fv-screen.is-enter { pointer-events: auto; cursor: pointer; }
.fv-screen .fv-row { transition: opacity 0.2s ease; }
.fv-screen .fv-row.is-off { opacity: 0; }
.fv-screen .fv-enter { font: inherit; font-size: 0.46em; color: #f4f2ee; background: transparent; border: 1px solid rgba(244, 242, 238, 0.55);
  border-radius: 999px; padding: 0.4em 1.5em; letter-spacing: 0.04em; cursor: pointer; opacity: 0;
  transition: opacity 0.3s ease, background-color 0.2s ease; -webkit-tap-highlight-color: transparent; }
.fv-screen .fv-enter.is-on { opacity: 1; }
.fv-screen .fv-enter:hover, .fv-screen .fv-enter:focus-visible { background: rgba(244, 242, 238, 0.12); outline: none; }
/* (DYS-221) the lock screen: the box black (the Mac asleep) under it; on the tap its black goes with the unlock, onto
   the laptop's live page under it; its key (Enter / Space) a button no one sees */
.fv-screen.is-lock { display: block; background: #000; overflow: hidden; }
.fv-screen.is-lock:has(.is-unlock) { background: transparent; }   /* (round 2b: the unlock dissolves onto the About page, no black) */
.fv-screen.is-lock.is-unlocking { transition: opacity 0.3s ease; }
/* (DYS-221, the coordinator's review of recording 4) no tap highlight: the whole screen is the tap target, and a phone's
   default highlight washed the laptop's screen blue for ~0.2 s at the tap (C's 'Enter' button had its own) */
.fv-screen.is-enter, .fv-screen .fv-key { -webkit-tap-highlight-color: transparent; }
/* (DYS-230) the full-viewport lock screen: over everything, black until it wakes; takes every tap while it's up */
.fv-full { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; height: 100dvh; z-index: 2147483000;
  background: #1b1d22 var(--lk-soft, none) 50% 50% / cover no-repeat;   /* (round 2b: the head's inline wallpaper, never black) */
  overflow: hidden; transform-origin: 0 0; -webkit-tap-highlight-color: transparent; }
/* (G, merging round 2b: no 58 % on portrait. The full lock is the middle of the laptop's screen (fvFullPlace), its
   wallpaper centred there, so the head's paint, this layer and the lock show the same pixels on a phone) */
.fv-full.is-enter { cursor: pointer; }
.fv-full .fv-key { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; -webkit-tap-highlight-color: transparent; }
.fv-screen .fv-key { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; }`;
  document.head.appendChild(st);
}

// (which photograph a screen shows: shared/sky.js homeViewFor, portrait under 0.8; phones at most 500 px wide get home_m)
const ROOM_FADE = 2500;       // ms, room crossfade when the nearest moment changes
const HALO = 0.45;            // halation strength (desaturated toward warm white in style.css)
const GLASS_DRIFT = 0.3;      // the reflection is a virtual image a few metres out: it drifts 30% as much

const VIEW_FADE = 900;        // ms, the view's crossfade as the sun moves between two rendered moments
const EASE = "cubic-bezier(0.42, 0, 0.58, 1)";   // every crossfade; js/live.js eases the living view the same way
// widest pictures before the first paint: the room sharp (it is near), the view a size down (the living
// layer takes it over), so the first paint stays near 320 KB on a desktop and 200 KB on a phone
const FIRST_PAINT = { home_l: { room: 2560, ext: 1600 }, home_p: { room: 1080, ext: 720 }, home_m: { room: 1080, ext: 720 } };
// (DYS-203 first view first) Where the live room is expected (the head's verdict, html.sfw-room-menu: shared/sky-head.js;
// motion allowed), the other moment's room picture is not asked for at the reveal: the room layer shows only the nearest
// moment, so it is wanted only once that changes (refresh() then asks for it, as for any moment), and the live room
// reads no room picture (the view's pictures, which it starts on, are asked for as before: exterior()). Its line goes to
// the room's own files (DYS-203 J1 traces: 2.5 MB of second photographs at the reveal on the laptop, sharing the line
// with router.js and three). If the room does not start after all (the router takes the class away) it is asked for
// then, as before. Everything in sight is as before. ?firstview=0: as before.
const FIRST_VIEW = new URLSearchParams(location.search).get("firstview") !== "0";
const roomExpected = () => FIRST_VIEW && root.classList.contains("sfw-room-menu") && !reducedQ.matches;
let partnerHeld = false;

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
  // (firstvisit-a2, DYS-21 / DYS-12: opened close, the room's picture is sized for the magnified view at once, no
  // lighter first step; every other layer for the uncropped view, the window sharp through its crop, fvCrop)
  const zoomed = fvZoom && layer === "room";
  let px = (geo ? (fvZoom && !zoomed ? geo.cw : geo.w) : innerWidth) * DPR();
  if (!revealed && !zoomed) px = Math.min(px, FIRST_PAINT[viewKey]?.[layer] ?? px);
  const want = chooseSize(sizes, px);
  if (!rec) {
    const { el, ready } = makeImg(want.path, opt.high);
    rec = { key, frame, layer, w: want.w, el, ok: false, op: 0, ready: null, upgrading: 0 };
    rec.crop = fvZoom && layer === "ext" ? fvCrop(src, el, opt.high) : null;
    rec.ready = Promise.all([ready, rec.crop ? rec.crop.ready : true]).then(async ([ok]) => {
      if (ok && layer === "room") await clearGlassBand(el, src).catch(() => {});
      rec.ok = ok;
      rec.done = true;
      // (DYS-151 review: a picture that finishes decoding once the 3D already covers the photographs (asked for under
      // it: the other view's after a rotation, a moment's that arrived late) is let go as the rest, photosCovered()
      // only stashed the ones decoded at that moment; it is in #stage, so the photographs' return puts its src back)
      if (ok && photosOff) { stashPic(el); stashPic(rec.crop?.el); }
      if (ok) refresh();
      return ok;
    });
    $(layer).appendChild(el);
    if (rec.crop) $(layer).appendChild(rec.crop.el);   // (just above its picture)
    pics.set(key, rec);
  } else if (want.w > rec.w && want.w > rec.upgrading && rec.ok) {
    rec.upgrading = want.w;
    const { el, ready } = makeImg(want.path);
    rec.upP = ready.then((ok) => {   // (DYS-203: kept, extSettled)
      if (!ok || !rec.el.isConnected) { el.removeAttribute("src"); return; }   // (DYS-151 memory: never shown, as unload())
      el.style.cssText = rec.el.style.cssText;
      rec.el.replaceWith(el);
      rec.el = el;
      rec.crop?.watch(el);
      rec.w = want.w;
      if (photosOff) stashPic(el);   // (DYS-161 memory: a sharper copy arriving under the 3D, let go as the rest)
      if (layer === "ext") live?.imageChanged(frame);
    });
  }
  return rec;
}

// (DYS-12) the window layer's crop while close: over its picture at FV_CROP's box, its fade and stacking copied from it
// (a style observer, moved to a sharper copy when one replaces it); the reveal waits for it, so it never pops in
function fvCrop(src, under, high) {
  const b = FV_CROP[viewKey];
  if (!b) return null;
  const { el, ready } = makeImg(`frames/fvcrop/${src.id}-${viewKey}-ext`, high);
  Object.assign(el.style, { left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${(b[2] - b[0]) * 100}%`, height: `${(b[3] - b[1]) * 100}%`, right: "auto", bottom: "auto" });
  let mo = null;
  const copy = (from) => { el.style.opacity = from.style.opacity; el.style.transition = from.style.transition; el.style.zIndex = from.style.zIndex; };
  const watch = (from) => { mo?.disconnect(); copy(from); mo = new MutationObserver(() => copy(from)); mo.observe(from, { attributes: true, attributeFilter: ["style"] }); };
  watch(under);
  // (DYS-151 memory: a crop is gone for good when it is dropped (the pull back, or its picture let go of): its decoded
  // picture goes with it, as unload())
  return { el, ready, watch, drop: () => { mo?.disconnect(); el.remove(); el.removeAttribute("src"); } };
}
// (DYS-151 memory) A picture let go of for good (out of the page, its record gone: nothing shows it again, a new record is
// made if its moment comes back) drops its src, and with it its decoded picture, and its crop goes with it: out of the
// page an <img> keeps its pixels until a full garbage collection, which with the JIT (any https page) can be a long way
// off (DM1, WebKit as an iPhone 13 over https: the room's 1620 x 2880 picture, 17.8 MB, let go of under the 3D, and the
// close opening's two window crops, 2.65 MB each, stayed alive the whole visit). Only ever after it has left the page.
function unload(rec) {
  rec.el.remove();
  rec.el.removeAttribute("src");
  rec.crop?.drop();
}
// the pull back is the room's: the photograph's own crop under it, the crops gone, the pictures at the uncropped view's
// sizes, and the 2D living layer (held while close: it would draw the window from the uncropped picture)
function fvUnzoom() {
  fvZoom = 0;
  fvLock?.dispose();   // (DYS-221: its clock stops; the box is hidden from here, placeFvScreen)
  fvLock = null;
  if (fvCamPrepped?.length) setTimeout(fvCamUnprep, 1500);   // (G, round 2c: the room's layers let go of, once settled)
  if (fvFull) {   // (G, DYS-230: no tap came, the safety timer or a failed boot: the full layer fades out, never left up)
    const f = fvFull, L = fvFullLock;
    fvFull = null; fvFullLock = null;
    Object.assign(f.style, { pointerEvents: "none", transition: "opacity 0.3s ease", opacity: "0" });
    setTimeout(() => { f.remove(); L?.dispose(); }, 320);
  }
  fvCam = null; fvPreCam = null; clearTimeout(fvPreT);   // (G, round 2c: no camera zoom left on the room)
  if (fvPre3D && nav?.rig) { nav.rig.easeTo(structuredClone(fvPre3D.P0), 0); fvPre3D = null; }   // (nor the 3D start view)
  fvLevelGone = true;
  if (!fvLevelEase) levelClear();   // (DYS-212: nothing stays turned; a straightening under way ends at none by itself)
  root.classList.remove("sfw-fv-boot");   // (@sfw-fv-head: never left dark past the pull back)
  for (const rec of pics.values()) if (rec.crop) { rec.crop.drop(); rec.crop = null; }
  layout();
  refresh();
  if (liveDeferred) { liveDeferred = false; startLive(); }
}

// (DYS-212) the turn (deg, s) on each of the room's layers in the hero now (see fvLevel)
// (G's N2: every read first, then every write. A layer not measured yet was read (getComputedStyle) after the layers
// before it had been written: a forced style recalc for each, in the boot's tasks as the router adds its layers, and in
// every frame of the pull back for the hero's children that are not turned (not absolute, or hidden), read each time)
function levelApply(deg, s) {
  const c = fvLevel ? [fvLevel.w / 2, fvLevel.h / 2] : [0, 0], todo = [];
  for (const el of $("scene").children) {
    if (el.matches(FV_LEVEL_KEEP)) continue;
    if (!fvLevelEls.has(el) && (el.style.translate || el.style.rotate || el.style.scale)) continue;   // (another's)
    let o = fvLevelAt.get(el);
    if (!o) {
      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" || cs.display === "none") continue;
      const [ox, oy] = cs.transformOrigin.split(" ").map(parseFloat);
      o = [(parseFloat(cs.left) || 0) + ox, (parseFloat(cs.top) || 0) + oy];
      fvLevelAt.set(el, o);
    }
    todo.push([el, o]);
  }
  const rot = `${deg.toFixed(4)}deg`, sc = (s * (fvCam ? fvCam.z : 1)).toFixed(5);
  for (const [el, o] of todo) {
    let [tx, ty] = sky.turnAbout(o, c, deg, s);
    if (fvCam) {   // (G, DYS-230 round 2) the camera's zoom on top of the turn: each layer's origin, turned, then z about F
      const { z, F } = fvCam;
      tx = F[0] + z * (o[0] + tx - F[0]) - o[0]; ty = F[1] + z * (o[1] + ty - F[1]) - o[1];
    }
    el.style.translate = `${tx.toFixed(2)}px ${ty.toFixed(2)}px`;
    el.style.rotate = rot;
    el.style.scale = sc;
    fvLevelEls.add(el);
  }
}
// layout()'s: the turn while close (lv: sky.fvLevelFor, or null), on the hero's box
function levelSet(lv, box) {
  fvLevelAt.delete($("stage"));   // (its box moves with each layout)
  if (fvLevelEase) { fvLevel.w = box.width; fvLevel.h = box.height; return; }   // (straightening: it goes on)
  if (!lv || fvLevelGone) { levelClear(); return; }
  fvLevel = { ...lv, w: box.width, h: box.height };
  levelApply(lv.deg, lv.s);
  if (!fvLevelMO) {
    fvLevelMO = new MutationObserver(() => { if (fvLevel && !fvLevelEase) levelApply(fvLevel.deg, fvLevel.s); });
    fvLevelMO.observe($("scene"), { childList: true });
  }
}
// the pull back (router.js bootEase, as it starts the rig's easeTo): the turn eases to none over the same ms on the
// rig's own curve (rig.js ease, passed in; this default is the same sine), the cover scale following the angle
function fvUnlevel(ms = 1400, ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1))) {
  fvLevelGone = true;
  if (!fvLevel || fvLevelEase) return;
  fvLevelMO?.disconnect(); fvLevelMO = null;
  const deg0 = fvLevel.deg, t0 = performance.now();
  const step = () => {
    const u = (performance.now() - t0) / ms;
    if (u >= 1 || !fvLevel) { levelClear(); return; }
    const d = deg0 * (1 - ease(u));
    levelApply(d, sky.coverScale(d, fvLevel.w, fvLevel.h));
    fvLevelEase.raf = requestAnimationFrame(step);
  };
  fvLevelEase = { raf: requestAnimationFrame(step) };
}
// (G, DYS-230 round 2: 'a real camera zoom-out') the first visit's camera: every layer of the room in the hero (the
// photograph, the 3D canvas, the laptop's box, ...: levelApply's) zoomed z about F (hero px) on top of the phone's level
// turn, so the room picture and the lock layer move as one scene; null: the turn alone again (or none, a laptop's)
function fvCamSet(cam) {
  fvCam = cam;
  if (fvLevel) levelApply(fvLevel.deg, fvLevel.s);
  else if (cam) levelApply(0, 1);
  else levelClear();
}
// (G, DYS-230 round 2c: the laptop's 0.7 s freeze at the move's start, then a jump. A Chrome trace of the tap: the
// room's big pictures decoded on the raster threads at +176 ms (75-107 ms each) and again as the zoom changed, the main
// thread waiting on the compositor's commit 79 / 51 / 274 / 85 ms: under the opaque full lock nothing of the room was
// drawn or decoded, and each new zoom asked for the pictures at a new size.) While 'Tap to enter' waits: every layer
// the camera zooms is its own compositing layer (will-change), so the zoom only scales what the GPU already holds (no
// new raster, no new decode at each size), and the full lock is not an occluder (opacity 0.999: no visible change),
// so the room under it is drawn and its pictures decoded now, not at the tap. Undone after the move (fvCamUnprep)
let fvCamPrepped = null;
// (I's runs: the room is ready 2.9-4.3 s before 'Tap to enter', and a quick tap met all of this unfinished when it began
// at 'Tap to enter'. So it runs at the router's reveal (mountFvFull's watch); at 'Tap to enter' again only for what
// came since: the late work's new layers made layers too and zoomed with the rest)
function fvCamPrep() {
  if (!fvFull) return;
  if (fvUse3D()) { fvPre3DSet(); return; }   // (the 3D move scales nothing: the camera at its start view, the warm-up from there)
  if (fvCamPrepped) {
    for (const el of $("scene").children) {
      if (fvCamPrepped.includes(el) || el.matches(FV_LEVEL_KEEP) || el.style.willChange) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" || cs.display === "none") continue;
      el.style.willChange = "transform";
      fvCamPrepped.push(el);
    }
    if (fvCam) fvCamSet(fvCam);
    return;
  }
  fvCamPrepped = [];
  for (const el of $("scene").children) {
    if (el.matches(FV_LEVEL_KEEP) || el.style.willChange) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "absolute" || cs.display === "none") continue;
    el.style.willChange = "transform";
    fvCamPrepped.push(el);
  }
  fvFull.style.opacity = "0.999";
  fvPullWarm();
  if (FV_PREZOOM) fvPreZoom();
}
// (A/B switches for the WebKit laptop takes: &fvprezoom=0 no camera zoom before the tap, &fvwarm=0 no 3D warm-up)
const FV_PREZOOM = new URLSearchParams(location.search).get("fvprezoom") !== "0", FV_WARM = new URLSearchParams(location.search).get("fvwarm") !== "0";
// (round 2c, the coordinator's 21:5x ruling: the laptop's move as the room's own 3D camera, no page layer scaled: fvMove3D.
// The phone, with its level turn, keeps the approved 2D zoom. &fv3d=0: the 2D zoom on the laptop too)
const FV_3D = new URLSearchParams(location.search).get("fv3d") !== "0";
const fvUse3D = () => FV_3D && !fvLevel && !!nav?.rig?.restPose && !!nav?.room && !!nav?.live?.revealed;
// (WebKit's laptop, I's 10 runs on f675553d: one 57-72 ms frame gap 0.17-0.22 s after the tap, the move's first frame,
// where the room's layers went from x1 to the camera's ~2.8x: WebKit draws a layer again at a larger scale on screen.)
// The camera's first frame applied now, hidden under the full lock: the room zoomed z0 about F as the move begins, so
// that redraw happens while 'Tap to enter' waits and the tap's first frame changes nothing (fvShrink: cam0). A resize
// takes it off and puts it back for the new layout; no tap (the safety timer, a failed boot): fvUnzoom takes it off
let fvPreCam = null, fvPreT = 0;
function fvPreZoom() {
  shrinkMod?.then((S) => {
    if (!S?.cameraFor || !fvFull || !fvFullLock || !fvScreen || fvCam || !fvZoom) return;
    const R = fvFullPlace(), Q0 = S.boxQuad(fvScreen);
    const c = R && Q0 ? S.cameraFor(Q0, R, "height") : null;
    if (!c) return;
    const hr = $("scene").getBoundingClientRect();
    fvPreCam = { Q0, z0: c.z0, F: c.F };
    fvCamSet({ z: c.z0, F: [c.F[0] - hr.left, c.F[1] - hr.top] });
  });
}
// (the 2D -> 3D join: a 167 ms frame where the room's 3D pull back begins, its first moving frame after sitting still,
// the outside's city worked out for a new camera.) The same work done now, hidden under the full lock: the room's
// camera eased 40 % of the way out along the pull back and back to where it was, over 0.5 s; a tap meanwhile puts it
// back at once (fvPullWarmStop), so the move always starts from the close framing
// (I's WebKit runs on 3452f854: a tap 0.3-0.4 s after 'Tap to enter' landed in the warm-up and cost 57-445 ms gaps in 9
// of 10 runs, the room re-refining at full size under the 2D part. So it runs as soon as the router shows the 3D room
// under the cover (its reveal: mountFvFull's watch), ahead of the late work and 'Tap to enter'; at 'ready' only if it
// couldn't run then. Once)
let fvWarmFrom = null, fvWarmDone = false;
function fvPullWarm() {
  const rig = nav?.rig;
  if (!FV_WARM || fvWarmDone || !rig?.spot || rig.moving || fvWarmFrom || !rig.restPose) return;
  fvWarmDone = true;
  fvWarmFrom = structuredClone(rig.pose);
  rig.easeTo(rig.restPose(rig.spot), 500, (u) => 0.4 * Math.sin(Math.PI * u));   // (0.5 s: over before most taps; a tap mid-way costs a frame)
  setTimeout(() => { if (fvWarmFrom && !rig.ease) rig.easeTo(fvWarmFrom, 0); fvWarmFrom = null; }, 600);   // (exactly where it was)
}
function fvPullWarmStop() {
  const rig = nav?.rig;
  if (fvWarmFrom && rig) rig.easeTo(fvWarmFrom, 0);
  fvWarmFrom = null;
}
function fvCamUnprep() {
  for (const el of fvCamPrepped || []) el.style.willChange = "";
  fvCamPrepped = [];
}
// nothing turned: each layer's three properties back to none
function levelClear() {
  if (fvLevelEase) cancelAnimationFrame(fvLevelEase.raf);
  fvLevelEase = null; fvLevel = null;
  fvLevelMO?.disconnect(); fvLevelMO = null;
  for (const el of fvLevelEls) el.style.translate = el.style.rotate = el.style.scale = "";
  fvLevelEls.clear();
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
  root.classList.remove("sfw-fv-boot");   // (@sfw-fv-head, index.html: the close photograph is up; the dark under it can go)
  if (LOCK) fvWake();   // (DYS-221: the laptop wakes with the photograph up)
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
  partners();
  refresh();
  // the router (and with it the 3D) starts now, right after first paint (handover-r1): the photograph's own requests
  // above are already asked for, so they stay first. It used to wait for the page's load event (every picture,
  // these included) and an idle moment, seconds on a phone network. The 2D living layer still waits for them.
  setTimeout(startNav, 0);
  const start = () => (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => { startLive(); }, { timeout: 1500 });
  // (DYS-216, C, ?bootlate=1: where the live room is expected, the 2D living layer is not built during its boot (TB1,
  // Chrome phone CPU 6x: js/live.js + roomfx.js ~310 ms of a return visit's main thread, a second WebGL context, thrown
  // away when the room covers it); it starts only if the room doesn't come (router.js: sfw:noroom), or by LIVE_LATE_MAX
  // if no room has come by then. A first visit's is deferred already (fvZoom))
  if (BOOT_LATE && roomBoots()) {
    let started = false;
    const late = () => { if (started) return; started = true; if (document.readyState === "complete") start(); else addEventListener("load", start, { once: true }); };
    addEventListener("sfw:noroom", late, { once: true });
    setTimeout(() => { if (!root.classList.contains("sfw-live-mode")) late(); }, LIVE_LATE_MAX);
    return;
  }
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}

// (DYS-203 first view first: the other moment's room picture not while the room is expected, FIRST_VIEW above)
function partners() {
  const near = sky.nearest(sel);
  for (const f of [sel.a, sel.b]) for (const l of ["ext", "room", "glass", "halo"]) {
    if (l === "room" && f !== near && roomExpected() && !pics.has(`${f.id}/room`)) { partnerHeld = true; continue; }
    pic(f, l);
  }
}
// ... and asked for if the room does not start after all (the router's plainMenu takes the class away)
if (FIRST_VIEW) new MutationObserver(() => {
  if (partnerHeld && revealed && sel && !roomExpected()) { partnerHeld = false; partners(); refresh(); }
}).observe(root, { attributes: true, attributeFilter: ["class"] });
// (DYS-203 start sooner) the view's pictures exterior() hands over, settled: each decoded and no sharper copy of it still
// on its way (pic()'s upgrade, asked for at the reveal). The boot now reaches the live view's start sooner, on a slow line
// often before those are in; the router waits for this (at most a moment: router.js EXT_WAIT) so the live window starts
// on the same pixels as when the boot came later (the sharper copy). Resolves at once when nothing is on its way.
function extSettled() {
  if (!sel) return Promise.resolve();
  const recs = [sel.a, sel.b].map((f) => pics.get(`${f.id}/ext`)).filter(Boolean);
  return Promise.all(recs.map((r) => Promise.resolve(r.ready).then(() => r.upP))).then(() => {});
}

function loadDay() {
  if (dayLoaded || !revealed || roomOnTop()) return;
  dayLoaded = true;
  for (const f of frames) for (const l of ["ext", "room", "glass", "halo"]) pic(f, l);
}

// ---------- layout: cover the viewport, centred on view.focus ----------
function chooseView() {
  const key = sky.homeViewFor(innerWidth, innerHeight, scene.views);
  if (key === viewKey) return false;
  viewKey = key;
  view = scene.views[key];
  return true;
}

function layout() {
  const box = $("scene").getBoundingClientRect();
  const W = view.width, H = view.height, f = view.overscan || 1;
  const s = Math.max(box.width / W, box.height / H);
  let w = W * s, h = H * s, left, top;
  const cw = w;   // (the uncropped view's width: DYS-12's picture sizes while close)
  const fx = view.focus?.[0] ?? 0.5, fy = view.focus?.[1] ?? 0.5;
  const sq = fvZoom && view.quads?.screen;
  // (DYS-212: a phone's close opening turned level, its scale and the level screen's narrower span taken off the fill,
  // so the laptop is as wide on screen)
  const lv = sq && !fvLevelGone ? sky.fvLevelFor(viewKey, view, box.width, box.height) : null;
  if (sq) {
    // (firstvisit-a2: close on the laptop, its screen centred, FV_FILL of the width)
    const xs = sq.map((p) => p[0]), ys = sq.map((p) => p[1]);
    const k = Math.max(1, (box.width * (box.width >= box.height ? FV_FILL : FV_FILL_P / (lv ? lv.s * lv.span : 1))) / ((Math.max(...xs) - Math.min(...xs)) * w));
    w *= k; h *= k;
    fvZoomK = k;
    left = clamp(box.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * w, box.width - w, 0);
    top = clamp(box.height * FV_Y - ((Math.min(...ys) + Math.max(...ys)) / 2) * h, box.height - h, 0);
  } else {
    left = keepShelf(clamp(box.width / 2 - fx * w, box.width - w, 0), box, w);   // pages stream
    top = clamp(box.height / 2 - fy * h, box.height - h, 0);
  }
  const stage = $("stage");
  Object.assign(stage.style, { width: `${w}px`, height: `${h}px`, left: `${left}px`, top: `${top}px` });
  if (FV2) levelSet(lv, box);
  for (const id of ["ext", "halo"]) {
    const el = $(id);
    el.style.width = `${w * f}px`;
    el.style.height = `${h * f}px`;
  }
  geo = { w, h, cw, f, left, top, base: { x: -((f - 1) / 2) * w, y: -((f - 1) / 2) * h }, maxShift: ((f - 1) / 2) * w * 0.85 };
  applyParallax(true);
  live?.resize(geo);
  placePrint();   // pages stream
  placeFvScreen();
}

// firstvisit-a2: the loading screen on the photograph's own screen (scene.json views.<view>.quads.screen), a box laid
// out at about its size on screen and mapped onto the quad grown FV_BLEED px into the bezel (it stays crisp: the map
// is nearly a translation). In the hero above the room's canvas and its live laptop page (z 3: canvas 0, page 1,
// links 2), not in the photograph's layer: there the room's crossfade showed the 3D screen's About page through it
// (DYS-21, Akshay); the 3D starts on the same crop, so it lines up. Its content: shared/firstvisit-a2.js.
function placeFvScreen() {
  const q = fvZoom && geo && view?.quads?.screen;
  if (!q) { if (fvScreen) fvScreen.style.display = "none"; return; }
  fvMod?.then((m) => {
    if (!m || !geo || !fvZoom) return;
    const P = sortQuad(q.map(([x, y]) => [geo.left + x * geo.w, geo.top + y * geo.h]));   // (the hero's px)
    const c = P.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const bw = (d(P[0], P[1]) + d(P[3], P[2])) / 2, bh = (d(P[0], P[3]) + d(P[1], P[2])) / 2;
    const G = P.map((p) => [p[0] + ((p[0] - c[0]) / (bw / 2)) * FV_BLEED, p[1] + ((p[1] - c[1]) / (bh / 2)) * FV_BLEED]);
    const W0 = Math.round(bw + 2 * FV_BLEED), H0 = Math.round(bh + 2 * FV_BLEED);
    const hm = m.quadToQuad([[0, 0], [W0, 0], [W0, H0], [0, H0]], G);
    if (!hm) return;
    if (!fvScreen) {
      fvScreen = document.createElement("div");
      fvScreen.className = LOCK ? "fv-screen is-lock" : "fv-screen";
      fvScreen.setAttribute("aria-hidden", "true");
      if (!LOCK) fvScreen.innerHTML = FV_BAR;
      $("scene").appendChild(fvScreen);
      if (LOCK) mountFvLock();
    }
    Object.assign(fvScreen.style, { display: "", width: `${W0}px`, height: `${H0}px`, fontSize: `${(W0 * 0.052).toFixed(2)}px`, transform: m.cssMatrix(hm) });
    fvLock?.resize(W0, H0);
  });
}
// C's loading screen's content: ?lock=0, or the lock screen's module didn't come
const FV_BAR = `<span class="fv-name">Akshay Chintalapati</span><span class="fv-row"><span class="fv-bar"><i></i></span><span class="fv-pct">0%</span></span>`;
// (DYS-221) the lock screen in the loading screen's box, laid out at its size as the box is (placeFvScreen: resize)
function mountFvLock() {
  lockMod.then((L) => {
    const box = fvScreen;
    if (!box || fvLock || box.classList.contains("is-enter")) return;   // ('Enter' already up on C's screen: it stays)
    const bar = () => { box.classList.remove("is-lock"); box.innerHTML = FV_BAR; };
    if (!L?.mountLock) { bar(); return; }
    try { fvLock = L.mountLock(box, {}); } catch (e) { console.warn("[lockscreen]", e?.message || e); fvLock = null; bar(); return; }
    const W0 = parseFloat(box.style.width), H0 = parseFloat(box.style.height);
    if (W0 && H0) fvLock.resize(W0, H0);
    if (fvWoke) { if (fvSoft) fvLock.setSoft(fvSoft); if (fvWallUrl) fvLock.setWall(fvWallUrl); fvLock.wake(); }   // (DYS-230: the full one woke first)
    else if (revealed) fvWake();   // (the photograph came first)
  });
}
// Its wallpaper: his view of SF at this moment, the window's (the landscape photograph's view outside, its still: the
// clouds in it), at its smallest size (1600 px, ~75 KB as AVIF: the laptop's screen is ~1000 px across on any device),
// the same moment the photograph shows
// the moment's frame with the landscape view's pictures (else the nearest one that has them)
function lockFrame() {
  if (!sel || !frames) return null;
  const near = sky.nearest(sel), i = frames.indexOf(near);
  if (near?.images?.home_l) return near;
  return frames.filter((x) => x.images?.home_l).sort((x, y) => Math.abs(frames.indexOf(x) - i) - Math.abs(frames.indexOf(y) - i))[0];
}
function lockWall(px = 1100) {
  if (!fmt) return null;
  const f = lockFrame();
  const imgs = f?.images?.home_l, sizes = imgs?.still || imgs?.ext;
  return sizes ? sky.url(sky.pickSize(sizes, px), fmt) : null;
}
// (DYS-221, Akshay: 'like a Mac waking from sleep') the screen dark until the photograph is up (reveal), then the Mac
// wakes once its wallpaper is decoded: 1.2 s at most, else it wakes on its dark grey and the picture comes in after
function fvWake() {
  if ((!fvLock && !fvFullLock) || fvWoke) return;
  fvWoke = true;
  // (DYS-230 rounds 2 and 2b, Akshay: no grey, one wallpaper always) full: the golden view inline in the head (index.html
  // @sfw-lock-wall) from the first paint, the lock woken at once on it; a laptop's larger copy, the one the head asked
  // for first of all images, fades in over it unseen. Else a picture as sharp as the viewport. The box's lock: the same
  fvSoft = (fvFullLock && self.__sfwLockSoft) || null;
  const head = fvSoft ? self.__sfwLockWall || null : null;
  const url = fvWallUrl = fvSoft ? head : lockWall(fvFullLock ? Math.round(Math.max(innerWidth, innerHeight * 1.6) * Math.min(2, devicePixelRatio || 1)) : 1100);
  if (fvSoft) { fvLock?.setSoft(fvSoft); fvFullLock?.setSoft(fvSoft); }
  if (!url) { fvLock?.wake(); fvFullLock?.wake(); return; }
  let woke = false;
  const wake = () => { if (!woke) { woke = true; fvLock?.wake(); fvFullLock?.wake(); } };
  const load = (url) => {
    const img = new Image();
    img.decoding = "async";
    img.fetchPriority = url === head ? "high" : "low";
    img.src = url;
    // (the head's AVIF where there's none: the WebP)
    img.decode().then(() => { fvWallUrl = url; fvLock?.setWall(url); fvFullLock?.setWall(url); wake(); }, () => { wake(); if (url === head) load(url.replace(/\.avif$/, ".webp")); });
  };
  load(url);
  setTimeout(wake, fvSoft ? 0 : 1200);
}
// (DYS-230) the full-viewport lock screen: the layer now (black: the Mac asleep), its lock when the module comes
function mountFvFull() {
  if (!LOCK_FULL || fvFull) return;
  // (round 2b) index.html's first frame: this layer, the lock's own markup in it, laid out as fvFullPlace lays it out
  // (scripts/live/lock_first_frame.py): taken over as it is; lockscreen.js takes over its markup
  fvFull = document.querySelector(".fv-full.fv-first");
  if (fvFull) fvFull.classList.remove("fv-first");
  else {
    fvFull = document.createElement("div");
    fvFull.className = "fv-full";
    fvFull.setAttribute("aria-hidden", "true");
    document.body.appendChild(fvFull);
  }
  root.classList.remove("sfw-fv-full");   // (round 2: the layer carries the head's wallpaper from here)
  lockMod.then((L) => {
    if (!fvFull || fvFullLock) return;
    if (!L?.mountLock) { fvFull.remove(); fvFull = null; return; }   // (no module: the lock in its box, or C's bar)
    try { fvFullLock = L.mountLock(fvFull, { mode: "full", touch: matchMedia("(pointer: coarse)").matches }); }
    catch (e) { console.warn("[lockscreen full]", e?.message || e); fvFull.remove(); fvFull = null; fvFullLock = null; return; }
    fvFullPlace();
    // (G, round 2c: the camera's prep and the room's 3D warm-up the moment the 3D room is shown under the cover: fvCamPrep)
    const wr = setInterval(() => { if (!fvFull) clearInterval(wr); else if (nav?.live?.revealed) { clearInterval(wr); fvCamPrep(); } }, 100);   // (the prep and the warm-up at the reveal)
    addEventListener("resize", () => {   // (G: in the move, its own)
      if (!fvFull) return;
      fvFullPlace();
      if (fvPreCam) { fvPreCam = null; fvCamSet(null); clearTimeout(fvPreT); fvPreT = setTimeout(fvPreZoom, 400); }   // (the layout's own, then again)
    });
    if (fvWoke) { if (fvSoft) fvFullLock.setSoft(fvSoft); if (fvWallUrl) fvFullLock.setWall(fvWallUrl); fvFullLock.wake(); }
    else if (revealed || self.__sfwLockSoft) fvWake();   // (round 2: at once, not with the room's photograph)
  });
}
// (G, DYS-230 round 2b, Akshay: 'like a camera starting from the full screen's recording of the lock screen, zooming out
// to show the laptop and then the room') The full lock is the laptop's screen seen from up close: laid out once at the
// size of the screen-shaped frame that fills the viewport (shared/fvshrink.js fullFrame: a portrait phone sees the
// middle of it, a laptop all of it), the lock's own layout for that size (at least 12 px text), only moved into place.
// The tap's move then never lays it out again: the camera pulls back from it (fvShrink). Its corners (client px)
const FV_FULL_A = 1.6;   // (the laptop's screen in the picture: 1.59-1.60 on a phone, upright or on its side, and a laptop)
function fvFullPlace(el = fvFull, lock = fvFullLock) {
  if (!el || !lock) return null;
  const vw = innerWidth, vh = innerHeight, h = Math.min(Math.max(vh, vw / FV_FULL_A), vh * 1.06), w = h * FV_FULL_A;
  const R = [[(vw - w) / 2, (vh - h) / 2], [(vw + w) / 2, (vh - h) / 2], [(vw + w) / 2, (vh + h) / 2], [(vw - w) / 2, (vh + h) / 2]];
  Object.assign(el.style, { width: `${w.toFixed(2)}px`, height: `${h.toFixed(2)}px`, transformOrigin: "0 0", transform: `matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,${R[0][0].toFixed(2)},${R[0][1].toFixed(2)},0,1)` });   // (a 3D matrix already, as the move's: WebKit redrew the layer when its transform changed kind at the tap)
  lock.resize(w, h);
  return R;
}
// the two locks as one for the first visit's module (firstvisit-a2.js: lock())
const FV_LOCKS = {
  setProgress(f) { fvLock?.setProgress(f); fvFullLock?.setProgress(f); },
  // (G) the layer its own layer from 'ready', not at the tap: the tap's frame doesn't raster the whole screen (50 ms on a phone)
  ready() { fvLock?.ready(); fvFullLock?.ready(); if (fvFull) { fvFull.style.willChange = "transform"; fvCamPrep(); } },
  wake() { fvLock?.wake(); fvFullLock?.wake(); },
  unlock: () => fvShrink(),
  // (G) firstvisit-a2.js's cap on the unlock: the press 150 + the shrink 900 + the unlock 800 ms, and some slack
  unlockMax: /[?&]shrinkhold=/.test(location.search) ? 12600 : 2600,   // (?shrinkhold: a proof take's paused frame)
  aboutHold: 0,   // (round 2c: no beat on About; the one move goes on into the pull back)
};
// (G, DYS-230 steps 4-5, rounds 2, 2b, 2c) The tap: the fingerprint fills (the lock's press(), 150 ms), then ONE camera
// move of MOVE_MS (shared/fvshrink.js oneMove; Akshay 2c: 'one continuous camera pull-back'): frame 1 is the full lock as
// it is (fvFullPlace's frame), the room zoomed so the screen fills it (fvCamSet); the camera pulls back (the 2D part, the
// lock riding the screen, never laid out again), and where the room is back at its close framing the room's 3D pull
// back takes the move on with the same curve to the room (firstVisit.pull -> router.js bootEase). D's unlock (the words
// fade, one dissolve onto the About page drawn under it) plays in the move, a third of the way in, over before the 3D
// part; then the layer goes. No hold, no second move. Reduced motion, no module, or nothing to land on (the box hidden:
// a failed boot mid-way): the layer fades (FADE_MS) onto the box's own lock, which unlocks.
const FADE_MS = 300;
// (G, DYS-230 round 2c, laptop: the 3D camera version; the coordinator's 21:5x ruling, I's WebKit runs: the 2D zoom's
// scaled page layers redrawn as they shrank) The whole move is the room's own 3D camera: frame 1 the close view
// magnified so the laptop's screen fills the full lock's frame (the rig's narrower view, tanV / z0, and its lens
// shifted onto the screen's centre: the rig's camera, rig.js toEngineCamera), then one rig ease to the room's framing on
// MOVE_EASE over MOVE_MS: no page layer is scaled. The full lock rides the screen: placed on its projected corners in
// the router's own per-frame placement of the laptop's page (laptop.place, so never a frame behind), the frame's
// offset from them at the start fading to none; D's unlock a third of the way in. Then the router's pull back has
// nothing left (firstVisit.pull: 1 ms)
// the move's start view: the close view (P0) magnified so the screen (the box's quad Q) fills the frame R: the rig's
// narrower view (tanV / z0) and its lens shifted onto the screen's centre (rig.js toEngineCamera's shiftTan, in tan)
function fv3DStart(S, box, R) {
  const rig = nav.rig, cv = nav.live?.canvas, Q = S.boxQuad(box), cr = cv?.getBoundingClientRect(), [w, h] = nav.size ? nav.size() : [cr?.width, cr?.height];
  if (!rig?.pose || !R || !Q || !cr || !(w > 0 && h > 0)) return null;
  const xs = Q.map((p) => p[0]), ys = Q.map((p) => p[1]);
  const z0 = (R[3][1] - R[0][1]) / (Math.max(...ys) - Math.min(...ys));
  const px = (((Math.max(...xs) + Math.min(...xs)) / 2 - cr.left) / w) * 2 - 1, py = 1 - (((Math.max(...ys) + Math.min(...ys)) / 2 - cr.top) / h) * 2;
  const P0 = structuredClone(rig.pose), a = w / h;
  const Pm = { ...P0, eye: P0.eye.slice(), tanV: P0.tanV / z0, shiftTan: [P0.shiftTan[0] + px * P0.tanV * a, P0.shiftTan[1] + py * P0.tanV] };
  return { P0, Pm, cr, w, h };
}
// (the 133 ms frame at the 3D move's start in Chrome: the camera's jump to that view, its first frame cold.) While 'Tap
// to enter' waits, the room's camera already at that view under the full lock (hidden): drawn and refined before the
// tap, the warm-up from there, the tap's move starting without a jump. A resize (the router's re-frame) puts the camera
// back; fvMove3D then works it out again
let fvPre3D = null;
function fvPre3DSet() {
  shrinkMod?.then((S) => {
    if (!S?.boxQuad || !fvFull || !fvFullLock || !fvScreen || fvPre3D || !fvUse3D()) return;
    const st = fv3DStart(S, fvScreen, fvFullPlace());
    if (!st) return;
    fvPre3D = st;
    nav.rig.easeTo(structuredClone(st.Pm), 0);
    fvPullWarm();
  });
}
async function fvMove3D(S, full, L, box, fade) {
  const rig = nav.rig, room = nav.room, lap = nav.laptop;
  const sc = (await import("/shared/laptop.js").catch(() => null))?.screenCorners;
  const R = fvFullPlace(full, L), lw = parseFloat(full.style.width), lh = parseFloat(full.style.height);
  if (fvWarmFrom) fvPullWarmStop();   // (its warm-up cut short: back at the start view first)
  const pre = fvPre3D && Math.abs(rig.pose.tanV - fvPre3D.Pm.tanV) < 1e-6 * fvPre3D.Pm.tanV ? fvPre3D : null;   // (still there)
  fvPre3D = null;
  const st = pre || fv3DStart(S, box, R);
  if (!sc || !lap || !st) return fade();
  const { P0, Pm, cr, w, h } = st, P1 = rig.restPose(rig.spot);
  const at = (pose) => { const P = sc(room, pose, w, h); return P && P.map((p) => [p[0] + cr.left, p[1] + cr.top]); };
  const Sm = at(Pm);
  if (!Sm) return fade();
  const off = R.map((p, i) => [p[0] - Sm[i][0], p[1] - Sm[i][1]]);
  const TLU = (await lockMod)?.TL?.unlock || 520, T = S.MOVE_MS, E = S.MOVE_EASE, tu = T / 3;
  const stage = L.el.querySelector(".lk-s");
  let t0 = null, unlocked = false, done = false;
  const unlock = () => {   // (D's: the words fade in place; the dissolve the full layer's opacity, as the 2D move's)
    if (unlocked) return;
    unlocked = true;
    if (stage) stage.style.transition = "none";
    L.el.classList.add("is-unlock");
    if (stage) stage.style.opacity = "1";
    full.style.transition = "opacity .35s ease .16s";
    full.style.opacity = "0";
  };
  box.style.visibility = "hidden";
  full.style.background = "none";
  const place = lap.place;
  const ride = (pose) => {
    if (done || t0 === null) return;
    const u = Math.min(1, (performance.now() - t0) / T), k = E(u), S2 = at(pose);
    if (!S2) return;
    const C = S2.map((p, i) => [p[0] + (1 - k) * off[i][0], p[1] + (1 - k) * off[i][1]]);
    const H = S.rectToQuad(lw, lh, C);
    if (H) full.style.transform = S.cssMatrix(H);
    if (u * T >= tu) unlock();
  };
  lap.place = function (pose, ...rest) { const r = place.call(this, pose, ...rest); ride(pose); return r; };
  fvPullWarmStop();
  t0 = performance.now();
  rig.easeTo(structuredClone(Pm), 0);
  rig.easeTo(structuredClone(P1), T, (u) => E(u));
  fvPull = { end: performance.now(), ease: () => 1 };   // (the router's pull back: nothing left to do)
  await new Promise((r) => setTimeout(r, T + 60));
  done = true;
  lap.place = place;
  unlock();
  setTimeout(() => { full.remove(); L.dispose(); if (fvFullLock === L) fvFullLock = null; }, Math.max(0, tu + TLU - T) + 200);
}
function fvShrink() {
  const full = fvFull, L = fvFullLock, box = fvScreen;
  fvFull = null;   // (screen() and lock() are the box's from here; the resize listener leaves the layer to the shrink)
  if (!full || !L || !box) { full?.remove(); L?.dispose(); fvFullLock = null; return Promise.resolve(fvLock?.unlock()); }
  full.style.pointerEvents = "none";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fade = () => {
    if (fvCam) fvCamSet(null);
    if (fvLock?.el) fvLock.el.style.visibility = "";
    full.style.transition = `opacity ${FADE_MS}ms ease`;
    full.style.opacity = "0";
    return wait(FADE_MS).then(() => { full.remove(); L.dispose(); if (fvFullLock === L) fvFullLock = null; return fvLock?.unlock(); }).catch(() => {});
  };
  return Promise.resolve(shrinkMod).then(async (S) => {
    if (!S || !L.el || reducedQ.matches) return fade();
    full.style.willChange = "transform";   // (its own layer since 'ready', FV_LOCKS; here if it never came)
    full.style.contain = "content";
    fvPullWarmStop();   // (round 2c: the room's camera back at the close framing if its warm-up was still going)
    if (typeof L.press === "function") await L.press();
    if (fvLock?.el) fvLock.el.style.visibility = "hidden";   // (lock A under it: never seen at an edge)
    if (fvUse3D()) return fvMove3D(S, full, L, box, fade);
    const hr = $("scene").getBoundingClientRect();
    const R = fvFullPlace(full, L);   // (its frame now: a rotation since the last resize)
    const lw = parseFloat(full.style.width), lh = parseFloat(full.style.height);
    // (round 2c, Akshay: one continuous camera pull-back) one move of MOVE_MS on one curve (fvshrink.js oneMove): this 2D
    // zoom takes its share of the camera's log-scale, the room's 3D pull back the rest from where it ends (firstVisit.pull:
    // router.js bootEase), no hold between. D's unlock plays in it: a third of the way in, over before the 3D part
    const TLU = (await lockMod)?.TL?.unlock || 520;
    const pre = fvPreCam;   // (the camera's first frame, already applied under the lock: fvPreZoom)
    fvPreCam = null; clearTimeout(fvPreT);
    const c0 = pre || S.cameraFor(S.boxQuad(box) || R, R, "height"), mv = S.oneMove(c0 ? c0.z0 : 1, fvZoomK);
    const tu = Math.max(0, Math.min(mv.T / 3, mv.ts - TLU - 40));
    full.style.background = "none";   // (under the lock, which covers it: the dissolve shows the About page, not the head's picture)
    box.style.visibility = "hidden";  // (the lock's box: the About page drawn under it shows as the lock dissolves)
    let t0 = null, unlocked = false;
    // (D's unlock: the words fade in place, then one dissolve. The dissolve is the full layer's opacity, a layer the GPU
    // already holds, not D's screen-sized stage fading: WebKit made a new screen-sized layer for that mid-move, a 60-86 ms
    // gap on the laptop; the same picture, the stage being the whole lock)
    const stage = L.el.querySelector(".lk-s");
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      if (stage) stage.style.transition = "none";
      L.el.classList.add("is-unlock");
      if (stage) stage.style.opacity = "1";
      full.style.transition = "opacity .35s ease .16s";
      full.style.opacity = "0";
    };
    const landed = await S.shrink(full, {
      quad: () => S.boxQuad(box),
      to: () => [parseFloat(box.style.width), parseFloat(box.style.height)],
      from: R, lay: () => [lw, lh],   // (round 2b: laid out once; the camera does the rest)
      ms: mv.ts, ease: mv.ease2d,
      onFrame: ({ u }) => { if (t0 === null) t0 = performance.now(); if (u * mv.ts >= tu) unlock(); },
      hold: parseFloat(new URLSearchParams(location.search).get("shrinkhold")) || null,   // (I's proof takes: a paused frame)
      // (round 2) the room picture zoomed with it: the laptop's screen fills the viewport at the tap, then back to its framing
      camera: (z, F) => fvCamSet(z > 1 ? { z, F: [F[0] - hr.left, F[1] - hr.top] } : null), camFit: "height", cam0: pre,
    });
    if (!landed || !box.isConnected || !fvZoom) { box.style.visibility = ""; return fade(); }
    unlock();
    // the 3D pull back goes on from here on the same curve, to MOVE_MS after the move began; the layer (dissolved) goes
    const start = t0 ?? performance.now();
    fvPull = { end: start + mv.T, ease: () => mv.ease3d(performance.now() - start) };
    // (dissolved, it goes after the move's end, not where the 3D part begins: its big layer let go of in that frame was a
    // 133 ms frame mid-move in Chrome)
    const gone = () => { full.remove(); L.dispose(); if (fvFullLock === L) fvFullLock = null; };
    setTimeout(gone, Math.max(start + tu + TLU, start + mv.T + 150) - performance.now());
  });
}
// a quad's corners in screen order: top-left, top-right, bottom-right, bottom-left
function sortQuad(P) {
  const c = P.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  const a = P.slice().sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
  const i = a.reduce((b, p, k) => (p[0] + p[1] < a[b][0] + a[b][1] ? k : b), 0);
  return [0, 1, 2, 3].map((k) => a[(i + k) % 4]);
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
let parallaxHeld = FV2 ? true : null;   // (firstvisit-a2: at rest while close)
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
  if (e.pointerType !== "mouse" || parallaxHeld || loadingStill()) return;   // (DYS-212: no input while loading)
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
  // (DYS-81) the live room over the photograph, which is out of the compositor meanwhile (shared/router.js
  // photoLayers): its parallax and its living layer wait, unseen (the living layer's WebGL drew 30 times a second
  // under the room); they go on from where they were as soon as it is back
  const covered = root.classList.contains("sfw-photo-off");
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
  } else if (geo && !reducedQ.matches && !parallaxHeld && !covered && !loadingStill()) {
    // (DYS-212: a later visit's still stays at rest while the room loads, so the room comes in on exactly its view)
    if (!fineQ.matches) { target.x = Math.sin(now / 9000) * 0.5; target.y = Math.sin(now / 13000) * 0.25; }
    const k = 1 - Math.exp(-dt / 360);
    pos.x += (target.x - pos.x) * k;
    pos.y += (target.y - pos.y) * k;
    applyParallax(false);
  }
  if (live && sceneOnScreen && !covered) live.frame(now);
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
  if (loadingStill()) return;   // (DYS-212: the still's objects wait for the room; its keyboard too)
  if (root.classList.contains("sfw-fv-close")) return;   // (G's S1: and while a first visit is close, until open())
  // the window is a spot of its own (a history entry, the dial docked); the notebook leans in in the live room, and
  // without it opens the essays' own page (shared/router.js)
  if (meta.action === "dial") {
    if (nav?.room) { nav.enterWindow(); return; }
    if ($("dial").hidden) $("now").click(); $("dial-range").focus({ preventScroll: true }); return;
  }
  if (name === "notebook" && nav?.room) { nav.go("notebook"); return; }
  // (v3/qa-nav) while the live room is starting, the move stays in this document (the router brings the page in over
  // its own photograph, or opens it in the reading sheet): the room, the city and the sound go on
  const spot = { books: "shelf", laptop: "laptop", quote: "print" }[name];
  if (spot && nav?.room && nav.mode === "booting") { nav.go(spot); return; }
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
const PHONE = phoneNow();   // (DYS-171: shared/device.js, the one rule)
const roomOnTop = () => PHONE && revealed && root.classList.contains("sfw-live-mode") && !root.classList.contains("sfw-3d-off") &&
  !!document.querySelector(".sfw-canvas.is-on");
let behind = false;   // the photographs skipped a moment under the 3D
function letGo() {
  // every picture not on screen (under the 3D: the moment the photograph last showed stays, for a fallback)
  for (const [k, rec] of [...pics]) if (rec.op === 0 && rec !== roomTop) { unload(rec); pics.delete(k); }   // (DYS-151 memory)
}

// (DYS-161 memory: on a phone, while the live 3D room covers the photographs (sfw-photo-off, shared/router.js
// photoLayers: out of the compositor, nobody sees them), what only they use is let go: the 2D living layer (js/live.js:
// a WebGL context of its own, the view's moments with their mipmaps, its mask and depth, its drawing buffers; tick()
// only held it there, unseen) and the decoded pictures of the moment the photograph still shows (their src kept in
// data-sfw-src: hidden, an <img> still holds its decoded bitmap, ~8 MB for a phone's 1080 px room or view). The
// photographs back (a lost context, the engine's fallback, reduced motion: the router removes the class), both come
// back in the same task, before the next paint: the pictures decoded as they are painted ("sync"), the living layer
// started again as at first paint. ?stillmem=0: kept as before.)
const STILL_MEM = PHONE && new URLSearchParams(location.search).get("stillmem") !== "0";
let photosOff = false, liveLetGo = false;
function stashPic(el) {
  if (!el || el.dataset.sfwSrc !== undefined || !el.complete || !el.naturalWidth) return;
  const src = el.getAttribute("src");
  if (!src || src.startsWith("data:")) return;
  el.dataset.sfwSrc = src;
  el.removeAttribute("src");
}
function photosCovered() {
  if (!STILL_MEM) return;
  const off = root.classList.contains("sfw-photo-off");
  if (off === photosOff) return;
  photosOff = off;
  if (off) {
    if (liveState !== "off") { stopLive(); liveLetGo = true; }
    for (const rec of pics.values()) { stashPic(rec.el); stashPic(rec.crop?.el); }
    return;
  }
  for (const el of document.querySelectorAll("#stage img[data-sfw-src]")) {
    el.decoding = "sync";
    el.setAttribute("src", el.dataset.sfwSrc);
    delete el.dataset.sfwSrc;
  }
  if (liveLetGo) { liveLetGo = false; startLive(); }
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
  if (fvZoom) { liveDeferred = true; return; }   // (DYS-12: after the pull back, fvUnzoom)
  if (photosOff) { liveLetGo = true; return; }   // (DYS-161 memory: under the 3D on a phone: once the photographs are back)
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
  for (const rec of pics.values()) unload(rec);   // (DYS-151 memory: the other view's pictures, every one)
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
    // (G's S3: and the room waiting under the loading screen framed on the photograph as laid out now, router.js holdCrop)
    if (chooseView()) { resetView(); requestAnimationFrame(() => { layout(); update(); nav?.holdCrop?.(); }); return; }
    layout();
    nav?.holdCrop?.();
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
  // (DYS-161 memory: photosCovered first: the pictures back before update() shows them)
  if (PHONE) new MutationObserver(() => { photosCovered(); if (behind && !roomOnTop()) update(); }).observe(root, { attributes: true, attributeFilter: ["class"] });
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
// (DYS-203 start sooner) the boot's modules, index.html's #sfw-boot-modules, asked for together as router.js is: the
// router's own, the first visit's opening (FV2), and where the room is expected (the head's verdict, motion allowed, no
// ?3d= switch) the engine's, the outside's and the desk's. ?bootpreload=0: none (each module a round trip deeper, as before)
const BOOT_PRELOAD = new URLSearchParams(location.search).get("bootpreload") !== "0";
// (where the room is expected: the head's verdict, motion allowed, no ?3d= switch for this visit)
function roomBoots() {
  let d3 = new URLSearchParams(location.search).get("3d");
  try { d3 ||= sessionStorage.getItem("sfw-3d"); } catch { /* storage blocked */ }
  return root.classList.contains("sfw-room-menu") && !reducedQ.matches && !d3;
}
function bootModules() {
  const t = BOOT_PRELOAD && document.getElementById("sfw-boot-modules");
  if (!t?.content) return;
  const room = roomBoots();
  for (const l of t.content.querySelectorAll("link")) {
    if ((l.hasAttribute("data-room") && !room) || (l.hasAttribute("data-firstvisit") && !FV2)) continue;
    const c = document.createElement("link");
    c.rel = "modulepreload";
    c.href = l.getAttribute("href");
    document.head.appendChild(c);
  }
  t.remove();   // (once)
}
// (DYS-203 fewer steps) the room's own files from the reveal, not once router.js and its imports have come in and run
// (~0.15 MB of the boot's ~0.75 MB of modules, sharing the line with the rest: a second or more on a slow line, then a
// round trip for bake.json, then one for the model): shared/spots.js's loadSpots (room3d.json, the head's hint; the same
// promise the router awaits after) and shared/gl/early.js's earlyRoom on its bake and tex, exactly as router.js bootLive
// asks for them (the same files, one request each); the router's own earlyRoom then finds them asked for, adds this
// moment's light maps and, live or not, ends them (earlyDone: a room it refuses stops what nothing read). Only on the bare
// homepage where the room is expected (roomBoots), with a bake and a view outside to boot (bootLive's own test), not with
// Save-Data. ?earlyboot=0: the router asks, as before
const EARLY_BOOT = new URLSearchParams(location.search).get("earlyboot") !== "0";
function earlyBoot() {
  const q = new URLSearchParams(location.search);
  if (!EARLY_BOOT || !roomBoots() || location.pathname !== "/" || q.has("page") || q.has("writing") || q.has("room3d") || navigator.connection?.saveData) return null;
  return Promise.all([import("/shared/spots.js"), import("/shared/gl/early.js")]).then(([S, E]) => S.loadSpots().then((r) => {
    const d = r?.data || {};
    const bake = q.get("bake") || d.bake || null, pano = q.get("pano") || d.pano || null;
    const tex = q.get("tex") === "0" ? null : q.get("tex") || d.tex || null;
    return bake && pano ? E.earlyRoom({ bake, tex }) : null;
  })).catch(() => null);
}
function startNav() {
  if (nav || navAsked) return;
  navAsked = true;
  bootModules();
  const early = earlyBoot();
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
      exteriorSettled: () => extSettled(),   // (DYS-203: see extSettled)
      relayout: () => layout(),
      // firstvisit-a2: the close opening (its loading screen; unzoom: the photograph back to today's crop, under the room)
      // (DYS-212: unlevel, the phone's level turn straightened with the pull back; level, its state for QA)
      // (DYS-221: lock, the lock screen on it, null with ?lock=0 or before its module is in)
      firstVisit: FV2 ? { pull: () => (fvPull ? { ms: Math.max(1, fvPull.end - performance.now()), ease: fvPull.ease } : null), screen: () => fvFull || fvScreen, lock: () => (fvFull ? (fvFullLock || fvLock ? FV_LOCKS : null) : fvLock), unzoom: fvUnzoom, unlevel: fvUnlevel,
        level: () => (fvLevel ? { deg: fvLevel.deg, s: fvLevel.s, easing: !!fvLevelEase, layers: fvLevelEls.size } : null) } : null,
      // the photograph's parallax: false eases it to rest before the 3D hands over (resolves at rest), true resumes it
      // (a lost context, the fallback to the photographs: shared/router.js contextLost, DYS-108)
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
  }).catch((e) => {
    console.warn("navigation unavailable:", e && e.message);
    // (DYS-203 fewer steps: no router to read or end the room's early files: stopped here)
    if (early) import("/shared/gl/early.js").then((E) => E.earlyDone()).catch(() => {});
    document.documentElement.classList.remove("sfw-room-menu", "sfw-loading");
    globalThis.sfwChromeIn?.(0);   // (DYS-212: no router, no room: the menu at once)   // (no live room: the menu's plain links, masthead-r2; DYS-212: the still takes taps)
    // (DYS-212, C's helper's find: a first visit's close opening ends too: the whole photograph, its hotspots back)
    if (root.classList.contains("sfw-fv-close")) { try { fvUnzoom(); } catch (err) { console.warn("[fv]", err); } root.classList.remove("sfw-fv-close"); }
    window.__sfwSimpleMenu?.();   // (DYS-31: which lead to the simple website)
  });
}

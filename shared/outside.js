// The view outside the window, drawn by the room engine's one WebGL2 context (stream X1; plan v2 sections 3, 6, 8).
//
//   import { createOutside } from "/shared/outside.js";
//   const outside = await createOutside(engine, { pano: "/pano/<set>/pano.json", viewKey: "home_l" });
//   await outside.ready;            // the first outside frame can be drawn (first-paint images or tiles in)
//
// It registers three passes with the engine (docs/v3/engine-api.md section 4):
//   "outside"       stage outside, raw: uploads streamed tiles, draws the panorama through the live camera with its
//                   effects and light layers, then the city's events (points, sky dots, hull sprites), then the halo's
//                   bright pass from what it just drew;
//   "outside-halo"  stage overlay, raw: the halo, screen-blended over the room, masked by the window's outline;
//   "outside-debug" stage post (only with { outsideOnly: true } or ?outside=only): the outside alone on the canvas.
//
// Stages (plan 3.1): stage 1 draws the page's own first-paint exterior images (moments a and b, blended as the page
// does) through the same projection, so the canvas fades in over identical pixels; the panorama tiles take over in a
// 300 ms fade at rest, or at once when the camera first moves. Under reduced motion the city is drawn once, as it is
// this second, and nothing animates.
import * as THREE from "three";
import { loadPano, PanoStore, viewRange, throughWindow, columnsFor, MAX_MOMENTS, REST_UPLOAD_BYTES, NEAR_DEPTH, EXTRA, hasExtra, tileUrl, WEBKIT, letGo } from "./pano.js";
import * as G from "./gl/outside.glsl.js";
import { createEvents, POINT_FLOATS, HULL_FLOATS, MAX_WAKES, CAR3D_FLOATS, BRIDGE_CAR_Q } from "./outside-events.js";
import { createShipDetail, DETAIL_JSON } from "./city/ship-detail.js";
import { createCity, STREETS_ON } from "./city/city.js";
import { createClock, clockAt } from "./city/clock.js";
import { LAMPS, windowsExtraDial, WINDOWS_EXTRA_GAIN } from "./city/tables.js";
import { pickFrames, sunPosition, getOverride, imageFormat, pickSize } from "./sky.js";
import { statsRunner } from "./outside-stats.js";
import { BAND_BYTES, bandRows, nextMessage, texRows } from "./gl/context.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const smooth = (a, b, x) => smooth01((x - a) / (b - a));
const GLASS_Z = -1.40;                 // the window glass (engine z): the pivot of the mouse sway's head move
const TILE_FADE_MS = 300;              // plan 3.1: the panorama takes over in a deliberate 300 ms fade at rest
const GATE_FADE_MS = 3000;             // the light layers ease from "as baked" to the city clock's own windows
const FX_FADE_MS = 1500;               // the living effects and the city's events ease in after the canvas's first frame
const DIAL_MOVING_MS = 400;            // v3/dial-smooth: the dial counts as moving this long after the wanted moment changed
const DIAL_FADE_MS = 300;              // a change of moment while the dial moves fades this fast
const DIAL_REST_FADE_MS = 600;         // ... and a change the dial asked for at rest (the clock's own: 450-2500 ms)
const HOLD_MAX_MS = 12000;             // v3/zoom-sharp: a magnified change held this long for its sharp tiles (a stalled connection) goes ahead
const TANDEM_MIN_S = 60;               // DYS-251: a time chosen this far (s) from the one on screen waits for the picture (below)
const TANDEM_OWN_MS = 600;             // ... its own dissolve when the picture has none to share (the same moments, or gone ahead)
const TANDEM_PAIR_MS = 3000;           // ... the picture waits this long for the dial's second moment, then goes to its nearer alone
const WARM_BYTES = { T1: 3e6, T2: 8e6, T3: 8e6 };   // v3/zoom-sharp: the neighbouring moments' tiles warmed in the browser's cache, a visit
const EXT_DEG_WIDTH = 2 * Math.atan(0.648) / DEG;   // the home exterior's horizontal field (cloud_motion is in its widths)
const HALO = 0.45;                     // the page's halation strength (app.js)
const FIRST_PAINT_EXT = { home_l: 1600, home_p: 720, home_m: 720 };   // app.js FIRST_PAINT: the exterior widths the page paints first
const PRIME_MS = 1000, PRIME_S = 2;    // (DYS-149 warm-frame) a primed city state is taken within this many ms and city s of it

// texture units, the same in every program
// (no program samples more than 14 of them: WebGL2 guarantees 16 per fragment shader, 32 in all)
// (the backdrop samples 16 with the near layer's two, uN0 and uNB: park round 2; the ships' night pass uNgt has its own
// unit, 19, so no program sees a 2D and an array sampler on one unit)
// the occluders: ground within OCCL_GROUND_M of a vehicle's road is its own road, not something in front of it (the
// rendered ground vs the lanes' heights); nearer than OCCL_NEAR_M the near layer's parallaxed test decides; the L3
// squares' atlas: OCCL_SLOTS slots, OCCL_SPR a row
const OCCL_GROUND_M = 0.5, OCCL_NEAR_M = 350, OCCL_SLOTS = 72, OCCL_SPR = 12;
const UNITS = { uL0c: 0, uL1c: 1, uL1s: 2, uL2c: 3, uL2s: 4, uLights: 5, uClouds: 6, uMask: 7, uDepth: 8, uRoom: 9, uExtA: 10, uExtB: 11, uAlb: 12, uNrm: 13, uSrc: 14, uHalo: 14, uF1: 15, uF2: 16, uN0: 17, uNB: 18, uNgt: 19, uOcc0: 20, uOcc3: 21, uInst: 22 };   // (uInst: the vehicles' instance records, DYS-149)
const ARRAYS = { uL0c: "L0c", uL1c: "L1c", uL1s: "L1s", uL2c: "L2c", uL2s: "L2s", uLights: "lights", uClouds: "clouds", uF1: "F1", uF2: "F2", uN0: "N0", uNB: "NB" };

// ------------------------------------------------------------------------------------------------ GL helpers
function makeProgram(gl, vs, fs, parallel) {
  const p = gl.createProgram();
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s); return s; };
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  gl.linkProgram(p);
  const prog = { p, u: null, ok: false, failed: false };
  prog.check = () => {
    if (prog.ok || prog.failed) return prog.ok;
    if (parallel && !gl.getProgramParameter(p, parallel.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("[outside] shader:", gl.getShaderInfoLog(f) || gl.getShaderInfoLog(v) || gl.getProgramInfoLog(p));
      prog.failed = true;
      return false;
    }
    prog.u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      prog.u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
    }
    gl.useProgram(p);
    for (const [name, unit] of Object.entries(UNITS)) if (prog.u[name]) gl.uniform1i(prog.u[name], unit);
    prog.ok = true;
    return true;
  };
  return prog;
}

// (DYS-216 #4, ?shadermerge: on unless =0) the halo's bright and blur passes as one program: BRIGHT_FS's declarations,
// BLUR_FS's own (uStep), a uPass switch, and each pass's main() body word for word in its branch (0 bright, 1 blur).
// Both draw the empty VAO through FULL_VS into the RGBA8 h8 targets with the same state, so a phone compiles one
// program and builds one pipeline for the two, before the room is shown. The same pixels: the branch is on a uniform,
// uSrc keeps unit 14, every source has one level. ?shadermerge=0: BRIGHT_FS and BLUR_FS as two programs, as before
// (scripts/live/shader_merge_fs_test.mjs)
const mainOf = (fs) => fs.slice(fs.indexOf("{", fs.indexOf("void main()")) + 1, fs.lastIndexOf("}"));
const headOf = (fs) => fs.slice(0, fs.indexOf("void main()"));
export const HALOPREP_FS = (() => {
  const head = headOf(G.BRIGHT_FS), own = head.split("\n"), at = head.indexOf("out vec4 o;");
  const blurOnly = headOf(G.BLUR_FS).split("\n").filter((l) => l.trim() && !own.includes(l));
  return head.slice(0, at) + blurOnly.map((l) => `${l}\n`).join("") + "uniform float uPass;       // 0: the bright pass, 1: the blur\n" +
    head.slice(at) + `void main() {\n  if (uPass < 0.5) {${mainOf(G.BRIGHT_FS)}  } else {${mainOf(G.BLUR_FS)}  }\n}`;
})();

function tex2d(gl, src, { mips = false, filter = gl.LINEAR, rg = false } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  // rg: two channels kept (half the memory of RGBA8)
  if (src) gl.texImage2D(gl.TEXTURE_2D, 0, rg ? gl.RG8 : gl.RGBA8, rg ? gl.RG : gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// (DYS-149 fix 1b) tex2d's texture as immutable storage with no pixels yet, for spread() to fill by bands: the same
// format, the same levels (the whole chain when mipmapped, as generateMipmap makes it), filtering and wrap. Made between
// frames, so it leaves the binding it found
function texStorage(gl, w, h, { mips = false, filter = gl.LINEAR, rg = false } = {}) {
  const was = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1, rg ? gl.RG8 : gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, was);
  return t;
}

// (it leaves the bindings it found: made in the middle of a frame, its texture left on the active unit and its
// framebuffer left bound had every vehicle's draw refused as a feedback loop for that frame, the traffic blink,
// docs/v3/bugs/2026-10-26-traffic-blink.md)
function target(gl, w, h, depth = false) {
  const was = { tex: gl.getParameter(gl.TEXTURE_BINDING_2D), draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), rb: gl.getParameter(gl.RENDERBUFFER_BINDING) };
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, Math.max(1, w), Math.max(1, h));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let rb = null;
  if (depth) {   // (the vehicles' layer: their faces and the parked cars' erasers sorted by depth, not by draw order)
    rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, Math.max(1, w), Math.max(1, h));
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  gl.bindTexture(gl.TEXTURE_2D, was.tex);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, was.draw);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, was.read);
  gl.bindRenderbuffer(gl.RENDERBUFFER, was.rb);
  return { tex, fb, rb, w: Math.max(1, w), h: Math.max(1, h) };
}
const freeTarget = (gl, t) => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); if (t.rb) gl.deleteRenderbuffer(t.rb); } };

// (DYS-216, E: bytes-up) ?bytesup=1: the outside's pictures (the first-paint stills, the ships' and cars' atlases, the
// occluders) decoded in the room's decode workers, not on the page, and handed back as their bytes (gl/loader.js
// decodePicture, fit-worker.js asBytes), so WebKit copies them instead of converting a bitmap as it uploads it, and can
// take them by bands (spread) like Blink. A picture with alpha still comes as a bitmap. loader.js only with the flag.
// (DYS-216 first ship: "auto" without ?bytesup, as gl/loader.js and pano.js; ?bytesup=0 or =room: off here)
const BYTES_UP = (() => { try { const v = new URLSearchParams(location.search).get("bytesup") ?? "auto"; return v === "1" || (v === "auto" && WEBKIT); } catch { return false; } })();
const isBytes = (s) => typeof ImageData !== "undefined" && s instanceof ImageData;
async function bitmapFrom(src) {
  if (src instanceof ImageBitmap) return src;
  const url = typeof src === "string" ? src : src.currentSrc || src.src;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob(), opts = { colorSpaceConversion: "none", premultiplyAlpha: "none" };
  if (BYTES_UP) { try { return await (await import("./gl/loader.js")).decodePicture(blob, opts); } catch { /* the page's decode, as before */ } }
  return createImageBitmap(blob, opts);
}

// two copies of a cloud layer slide along and take turns (js/live.js): each lives for `range` of travel and they
// crossfade over `f` of the cycle; at travel 0 the first copy sits where the renderer put the clouds, at full weight
function copies(travel, range, f, sign) {
  const P = range / (0.5 + f);
  const start = clamp(0.5 * (0.5 + f), f, 0.5);
  const ph0 = (((travel / P + start) % 1) + 1) % 1, ph1 = (ph0 + 0.5) % 1;
  const w = (ph) => smooth(0, f, ph) * (1 - smooth(0.5, 0.5 + f, ph));
  const off = (ph) => sign * (Math.min(ph, 0.5 + f) / (0.5 + f) - 0.5) * range;
  return [off(ph0), off(ph1), w(ph0), w(ph1)];
}

// DYS-199: how much of the panorama's air the moving cars take at golden, lowsun and sunset (CAR_HAZE's shares x this):
// the strength this deploy ships, Akshay's pick, and the only number to change for it: 1 full, 0.5 half, 0 off (today's
// cars: the vehicles' shader built without CARHAZE, the same source as before once preprocessed). ?carhaze=<s> overrides
// it for one visit (QA, 0-3). 0.5: Akshay's pick, 31 Oct 16:5x ("i want to see how half does and then decide on full"),
// from the off / half / full stills of his 17:45 view; ?carhaze=1 and ?carhaze=0 show him the other two on the live site
export const CAR_HAZE_K = 0.5;
// DYS-240 (G): the street vehicles' dark end and shadows in the photograph's day colour (CAR3D_FS dayTone), with the sun
// up: 1 on, 0 off (the vehicles' shader built without CARDAY, its source as before once preprocessed). ?carday=<s>
// overrides it for one visit (QA, 0-2)
export const CAR_DAY_K = 1;

// ------------------------------------------------------------------------------------------------ the outside
export async function createOutside(engine, opts = {}) {
  const gl = engine.gl;
  const webRoot = opts.webRoot || new URL("../", import.meta.url).href;
  // (v3/street-traffic, zoom.net decision (a), 26 Oct: the street vehicles' 3D meshes load lazily, when the magnifier
  // attaches (setZoom: at the window's warm-up or the first magnification), as its L3 tiles do; a first visit pays
  // nothing for them, and the sprite atlas only for the QA comparison ?carmesh=0)
  const carmeshOff = new URLSearchParams(location.search).get("carmesh") === "0";
  const [meta, scene, routes, atlasMeta, carMeta] = await Promise.all([
    loadPano(opts.pano),
    opts.scene || fetch(webRoot + "scene.json").then((r) => r.json()),
    opts.routes || fetch(new URL("./city/routes.json", import.meta.url)).then((r) => r.json()),
    fetch(webRoot + "live/sprites/boats.json").then((r) => r.json()).catch(() => null),
    // v3/street-traffic: the street vehicles' sprite atlas, only for QA ?carmesh=0 (the before, to compare)
    carmeshOff && STREETS_ON ? fetch(webRoot + "live/sprites/cars.json").then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
  ]);
  let meshMeta = null;
  const viewKey = opts.viewKey || "home_l";
  const frames = scene.frames;
  const byId = new Map(frames.map((f) => [f.id, f]));
  // the city in the panorama's frame: its eye height and room axis (pano.json), not routes.json's v2 constants
  const city = createCity(routes, { eyeAsl: meta.eye.asl_m, axisDeg: meta.axis_bearing_deg });
  // DYS-134: the street lamps (and the bridge's floodlights) switch at the set's own sun altitude when its light layers
  // carry one (lights.lamps_on_alt: the renders' switch, build.py lights_on, -1.5), so the 1x lamps are lit whenever the
  // 4x squares and the near layer show them lit (dusk and dawn, -3.6 and -3.5); a set without it: LAMPS.alt, as before
  const LAMP_ALT = Object.values(meta.moments).map((m) => m?.lights?.lamps_on_alt).find(Number.isFinite);
  // the street traffic's module comes as a dynamic import (city.js, started at boot): its cars fade in over
  // STREETS_FADE_MS from the moment it arrives (wall time, not the first frame drawn after it: the fade is over before
  // the first-visit loader ends)
  // ... and only once the occluders are in too (scripts/city_clock/occl_depth.py: the city's 16-bit depth over the lanes,
  // live/occl/): a car is never drawn against the coarser test first and then cut differently
  let streetsSince = null;
  // (DYS-149 fix 1b: the outside's big pictures go to the GPU between frames, a band of rows per task, never inside a
  // frame. The first-paint stills (3840 wide, ~33 MB each: 23-39 ms each in one texImage2D on desk1440), the
  // occluders' L0 (3600 x 3072) and the sprite atlases went up inside the frame that first needed them: the warm-up's
  // hidden frame carried two stills, the ships' albedo and the occluders, 70 ms of uploads in one 102 ms task (J4,
  // after fix 1). One picture at a time, in arrival order; each texture is handed to the pass (ext, alb / nrm / ngt,
  // carAlb / carNrm, occl.l0) only once all its rows and its mipmaps are in, so nothing is drawn half-uploaded, with
  // tex2d's format, levels, filtering and pixels. The engine's hidden frames wait for what is under way (the pass's
  // uploads()). A restored context or dispose() starts a new generation: older uploads stop.)
  // (DYS-149, Deploy 10: on the slow laptop (barely-sufficient, J4) that hidden frame was one 390 ms task: the still
  // 145 ms, the ships' albedo 16 ms, the occluders' L0 67 ms, inside a 451 ms gap the judge counts as a freeze (two
  // commits waited 42-55 ms to be shown). Not the window's tiles: those go up by rows in store.pump, pano.js)
  // (DYS-149: by bands only in Blink (Chrome, Edge, Android). WebKit converts the whole picture on every sub-rectangle
  // upload from it (hitex.js: the 6144 walnut, ~44 ms a strip), so there, as in any browser not measured, each picture
  // goes up whole, still in its own task between frames: the same conversions as before, none inside a frame. iPhones
  // and iPads are WebKit in every browser; iPadOS calls itself a Mac with touch)
  const ua = navigator.userAgent;
  const whole = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || !/Chrome\/|Chromium\//.test(ua);
  // (DYS-149 TU2: the uploads wait for the engine's warm-up (uploads(), its first call) or the first frame drawn, whichever
  // comes first, then go in arrival order. Started on decode (TU1) they ran inside the boot's long hidden gap, the room
  // built behind the photograph, where no frame is shown between tasks: that gap only grew (1.3-1.4 -> 1.6-2.4 s). At
  // the warm-up they go after the room's maps, one task each, where frames are shown between tasks)
  // (DYS-203 HS1, handoff-smooth) the hand-off's visible part: from the crossfade's start (the router, handTail(true)) to
  // the room at rest with the live view dissolved in (handTail(false), the router's handCalm; CALM_MAX at the latest).
  // Meanwhile the pictures not yet on the GPU wait between their bands (spread), and where pictures go up whole (WebKit,
  // iPhone UAs) the window's tiles one whole tile a frame (render: store.pump):
  // DY1 (dy1-2325), WebKit iPhone 13: frames of 51-87 ms 0.1-0.45 s after the crossfade on the branch, none on main,
  // when handoff-tiles' late tiles and occluders came in (REST_UPLOAD_BYTES, 9 MB a frame; the occluders' L0, 21 MB,
  // whole there). ?htcalm=0: no such gate, as handoff-tiles
  const hsQ = new URLSearchParams(location.search);
  const HT_CALM = hsQ.get("htcalm") !== "0", CALM_MAX = 8000;
  let handBusy = false, calmOpen = null, calmIn = null, calmT = 0;
  function handTail(on) {
    if (!HT_CALM) return;
    if (on && !handBusy) {
      handBusy = true;
      calmIn = new Promise((r) => { calmOpen = r; });
      calmT = setTimeout(() => handTail(false), CALM_MAX);
    } else if (!on && handBusy) {
      handBusy = false;
      clearTimeout(calmT);
      calmOpen();
      engine.requestFrame();
    }
  }
  let upGen = 0, upGo = null;
  let upChain = new Promise((r) => { upGo = r; });
  function spread(src, { mips = false, filter = gl.LINEAR, rg = false } = {}) {
    const gen = upGen;
    const run = upChain.then(async () => {
      // (DYS-216 bytes-up: a picture held as bytes goes by bands in WebKit too: only a bitmap is converted whole per band)
      const w = src.width, h = src.height, rows = whole && !isBytes(src) ? h : bandRows(w, BAND_BYTES[engine.settings.tier] || BAND_BYTES.T2);
      let t = null;
      for (let y = 0; y < h; y += rows) {
        if (handBusy) await calmIn;   // (HS1: not in the hand-off's visible frames, handTail)
        await nextMessage();
        if (gen !== upGen || gl.isContextLost() || !src.width) { if (t) gl.deleteTexture(t); return null; }
        if (!t) t = texStorage(gl, w, h, { mips, filter, rg });
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        const n = Math.min(rows, h - y);
        texRows(gl, t, src, y, n, { format: rg ? gl.RG : gl.RGBA, mips: mips && y + n >= h });
      }
      return t;
    });
    upChain = run.catch(() => null);
    return run;
  }
  // (DYS-203 HT1, handoff-tiles) opts.netAfter (the router's: the room's own boot files in, gl/early.js earlyIn): the
  // window's aux maps and the ships' atlas are asked for only then, not alongside the room's files (with the occluders
  // below, ~1.4 MB on a laptop, ~1 MB on a phone shared the line with the room's ~6 MB). Both are drawn over stage 1
  // (its water, sky mask, ships): the router's hand-off waits for them (lookIn). Without it (dev pages, ?outnet=0): at
  // once, as before
  const netAfter = opts.netAfter ? Promise.resolve(opts.netAfter).catch(() => {}) : null;
  const afterNet = (fn) => (netAfter ? netAfter.then(fn) : fn());
  let atlasOut = !atlasMeta;   // the ships' atlas on the GPU, or failed, or none (lookIn)
  let auxOut = false;          // the aux maps in, or failed once (pano.js asks again later: not waited for again)
  // (DYS-203 HT1, handoff-tiles) opts.tilesAfter (the router's, with holdFirstPaint): the window's panorama tiles are not
  // asked for until tilesGo(ms) (the router: once the hand-off's crossfade is over, or at once when the 3D is shown by
  // a move) or release(). Stage 1 is held through the hand-off and needs none of them; asked for from the warm-up on,
  // as before, they came in, decoded and went up (up to REST_UPLOAD_BYTES a frame) while the room refined under the
  // photograph, the frames the hand-off waits on. The light layers' gate (the clock's own windows over the photograph's,
  // GATE_FADE_MS) then starts with them, as it started with the first frame that asked for them before (ltAt)
  let tilesHeld = !!opts.tilesAfter && !!opts.holdFirstPaint, tilesT = 0, tilesAt = Infinity;
  let ltAt = tilesHeld ? undefined : null;   // (the gate's start: null, gateStart as before; undefined, not yet)
  let tilesOpen;
  const tilesIn = new Promise((r) => { tilesOpen = r; });
  if (!tilesHeld) tilesOpen();
  function tilesGo(ms = 0) {
    if (!tilesHeld) return;
    const at = performance.now() + Math.max(0, ms);
    if (at >= tilesAt) return;
    tilesAt = at;
    clearTimeout(tilesT);
    tilesT = setTimeout(() => { tilesHeld = false; tilesOpen(); engine.requestFrame(); }, Math.max(0, ms));
  }
  // (HT1) ... and the street cars' occluders (0.3 MB) after both: the cars come only after the hand-off (carsHeld), and
  // their fade starts once these are in (streetsSince), as it did
  const afterTiles = (fn) => (netAfter || opts.tilesAfter ? afterNet(() => tilesIn).then(fn) : fn());
  // (DYS-203 HS1, handoff-smooth) ... where the tiles are held (tilesAfter), the occluders are asked for once stage 1's
  // look is in instead (the aux maps and the ships' atlas, lookIn's two; OCCL_LOOK_MAX at most): the line is free then
  // (the room's files in, the tiles held), so on a fast line they are in and on the GPU under the photograph, as on main,
  // not in the frames after the crossfade (DY1, WebKit; Chrome's phone on fast 4G: in at +1.1-1.3 s, its pull back's
  // 50-83 ms frames). One that comes later waits for the hand-off's end (handTail). ?occlearly=0: after the tiles, as
  // handoff-tiles. (The first poll a task later: store is made below)
  const OCCL_EARLY = hsQ.get("occlearly") !== "0", OCCL_LOOK_MAX = 4000;
  const lookReady = () => new Promise((res) => {
    const t0 = performance.now();
    const look = () => {
      auxOut ||= store.auxState === "ready" || store.auxState === "failed";
      if ((auxOut && atlasOut) || performance.now() - t0 >= OCCL_LOOK_MAX) res(); else setTimeout(look, 50);
    };
    setTimeout(look, 0);
  });
  const afterOccl = (fn) => (OCCL_EARLY && tilesHeld ? afterNet(lookReady).then(fn) : afterTiles(fn));
  const occl = { meta: null, l0: null, atlas: null, slots: new Map(), lru: [], want: new Set(), failed: false, gen: 0 };
  // (DYS-161 memory: the two-channel files, occl.json's "rg" (occl_depth.py rg): the L0 picture and the L3 squares'
  // atlas kept as RG8, 2 bytes a texel in place of RGBA8's 4: L0 3600 x 3072 42.2 -> 21.1 MB, the atlas 3120 x 3120
  // 37.1 -> 18.6 MB, on every tier. The same values: the trees blocks' G and B were 0, the solid's B (the leaves'
  // coverage) moved to the trees' G; occTexel reads it there)
  const occlL0 = (m) => webRoot + "live/occl/" + m.rg.l0;
  // (fix 1b: the L0 by bands. DYS-149 TU2: occlIn, and so the street cars' fade-in clock, is the decode again, as on main
  // (its wall time: the fade is over before the loader ends), not the upload, which now waits for the warm-up; the cars
  // are drawn only once the L0 is on the GPU (streetsW), as the first frame after the decode uploaded it before drawing.
  // An upload that fails counts as the occluders failing: the cars without them, as for a failed load)
  // (as RG8, DYS-161; the bitmap let go once uploaded)
  const occlUp = (b) => spread(b, { filter: gl.NEAREST, rg: true }).then((t) => { letGo(b); if (t) { occl.l0 = t; engine.requestFrame(); } },
    (e) => { letGo(b); occl.failed = true; console.warn("[outside] occluders:", e.message); });
  const occlIn = afterOccl(() => fetch(webRoot + "live/occl/occl.json")).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((m) => (m.rg ? m : Promise.reject(new Error("no two-channel files (occl.json rg)"))))
    .then((m) => bitmapFrom(occlL0(m)).then((b) => { if (m.l3) m.l3.have = new Set(m.l3.tiles.map(([i, j]) => i * 1000 + j)); occl.meta = m; occlUp(b); }))
    .catch((e) => { occl.failed = true; console.warn("[outside] occluders:", e.message); });
  Promise.all([city.loadStreets(), occlIn]).then(() => { streetsSince = performance.now(); engine.requestFrame(); }).catch((e) => console.warn("[outside] streets:", e.message));
  const clock = opts.clock || createClock({ search: location.search, override: getOverride() });
  const reduced = () => (opts.reducedMotion ?? engine.settings.reducedMotion);
  const T0 = clock.T();
  // the camera of the first-paint exterior pictures: R2 cuts them from the panorama and names their cameras in pano.json
  // ("cuts"); today's pictures are the v2 renders (routes.json's presets, checked against the renderer to 1 px)
  const extCamMeta = meta.cuts?.[viewKey] || routes.cameras?.[`${viewKey}_v2`] || routes.cameras?.home_l_v2;
  const AXIS = meta.axis_bearing_deg;
  const E0 = meta.eye.room_engine;
  const EYE_H = meta.eye.asl_m;
  const urlQ = new URLSearchParams(location.search);
  // QA ?trafficlog=1 (the blink hunt, docs/v3/bugs/2026-10-26-traffic-blink.md): a row a frame in globalThis.__trafficLog
  // (the last 60000): [ms since the log began, the engine's state, why the outside drew nothing ("" = it drew), the
  // city's second, street cars from the sim, of them new since the last frame, sprites, meshes, street points, the
  // GPU's answer whether any street-car pixel was drawn (1 / 0; -1 not drawn, null pending), meshW, streetsW, evW, the
  // magnification, panorama tiles loading, close-up tiles loading, a moment cross-fade, the pass's ms]; and the
  // engine's state changes and the meshes' uploads as events in globalThis.__trafficEvents
  const tlog = urlQ.get("trafficlog") === "1" ? { rows: (globalThis.__trafficLog = []), evs: (globalThis.__trafficEvents = []), t0: performance.now(), ids: new Set(), q: [] } : null;
  const tev = (kind, x) => { if (tlog) tlog.evs.push([Math.round(performance.now() - tlog.t0), kind, x ?? null]); };
  if (tlog) engine.on("statechange", (e) => tev("state", `${e.from}>${e.to}`));
  let debug = opts.debug ?? +(urlQ.get("odebug") || 0);
  const outsideOnly = opts.outsideOnly ?? urlQ.get("outside") === "only";   // QA: the outside alone on the canvas
  const repeat = Math.max(0, Math.min(50, +(opts.repeat ?? urlQ.get("orepeat") ?? 0) || 0));   // QA: GPU cost by the slope
  let noNear = opts.noNear ?? urlQ.get("near") === "0";   // QA: without the rendered near layer (park round 2), to compare
  // (DYS-149 warm-frame: ?warmsplit=0 has the warm-up's hidden frame work everything out itself, as before: no warm steps
  // (pass.warmSteps), the fixed uniforms set at every draw, the stats' picture copies made in the frame that asked)
  const warmSplit = urlQ.get("warmsplit") !== "0";
  // (DYS-161 memory, VG1: what the street vehicles' 3D draws cost the GPU process (GS1: its 'IOAccelerator' grew
  // ~335-360 MB while they drew, none of it a WebGL allocation; ?carmesh=0 ~0). QA switches, all off by default, on
  // every tier: ?caralign=1 every LOD's indices start on a 4-byte boundary (ANGLE's Metal backend converts index
  // offsets that are not); ?carlod=N every vehicle at LOD N; ?carhalf=1 every other vehicle drawn; ?caruni=1 a
  // vehicle's uniforms set only when they changed since they were last set; ?carflat=1 the vehicles' class a flat
  // varying again, as before (ANGLE's Metal backend rewrites the indices of every draw of a program with a flat
  // varying: the GL's provoking vertex is a triangle's last, Metal's its first). VG1 (SE, the three zooms): +327 MB
  // unexplained as before; caralign +306, carlod=2 +261, carhalf +130, caruni +216; the class smooth -7 (no vehicles
  // -2): so the class is smooth by default now (outside.glsl.js CAR3D_VS))
  const carAlign = urlQ.get("caralign") === "1";
  const carLod = urlQ.has("carlod") ? Math.max(0, Math.round(+urlQ.get("carlod")) || 0) : -1;
  const carHalf = urlQ.get("carhalf") === "1";
  const carUni = urlQ.get("caruni") === "1";
  // (DYS-149: ?flatvary=1 every smooth varying that was a flat one flat again, to compare: the vehicles' class (as
  // ?carflat=1), the hull sprites' cell rectangles (outside.glsl.js HULL_VS), the room's ids (gl/material.js smoothIds),
  // the 2D living layer's boats (js/shaders.js BOAT_VS))
  const flatVary = urlQ.get("flatvary") === "1";
  const carFlat = urlQ.get("carflat") === "1" || flatVary;
  const clsFlat = (s, q) => (carFlat ? s.replace(`${q} float vClsF;`, `flat ${q} float vClsF;`) : s);   // (?carflat=1)
  const rectFlat = (s, q) => (flatVary ? s.replace(`${q} vec4 vR0, vR1;`, `flat ${q} vec4 vR0, vR1;`) : s);   // (?flatvary=1)
  // (?caruni=1: the vehicles' loop sets its uniforms through ug, a cache that drops a call with the values last set for
  // that location (each group starts a new one); otherwise ug is the context itself)
  let ug = gl;
  const uniSkip = () => {
    const last = new Map();
    const same = (l, v) => {
      const o = last.get(l);
      if (o && o.length === v.length) { let k = 0; while (k < v.length && o[k] === v[k]) k++; if (k === v.length) return true; }
      last.set(l, Array.from(v));
      return false;
    };
    const U = {};
    for (const f of ["uniform1f", "uniform2i", "uniform3f", "uniform4f", "uniform4i"]) U[f] = (l, ...v) => { if (!same(l, v)) gl[f](l, ...v); };
    for (const f of ["uniformMatrix3fv", "uniformMatrix4fv"]) U[f] = (l, t, v) => { if (!same(l, v)) gl[f](l, t, v); };
    return U;
  };
  // (DYS-149 smooth: the street vehicles instanced. VG1's counters at full zoom, Lombard: ~170 drawElements (a body
  // each) and ~330 drawArrays (their shadow quads) a frame with ~3,700 uniform calls, and each call a fixed cost on the
  // CPU through ANGLE's Metal backend (every iPhone). Now a draw for each run of one kind (shadow quads, one model at
  // one LOD, the parked erasers) that nothing drawn between it overlaps on the screen, so every pixel sees its draws in
  // the same order as before (drawCarGroup); what the uniforms carried per vehicle is a record each in a float texture,
  // uploaded once per group. ?carinst=0: a draw per vehicle as before (and always with ?fleet=v1's meshes); QA at run
  // time: globalThis.__carInst = 0 / 1 picks the path from the next frame, the other program made when first asked for)
  const carInstQ = urlQ.get("carinst") !== "0";
  // (DYS-216 F, lane 4: ?compilelean=1) the programs the first view doesn't draw are made after it is shown: the street
  // vehicles' (car3d, carLayer: held until room-shown and a calm spell anyway, carsHeld) LEAN_CARS_MS after the
  // "sfw:room-shown" mark, and the debug copy only with the outside-only page. A phone compiles every shader cold after a
  // deploy, one at a time in the GPU process in send order, and car3d is the page's biggest (56k characters), sent first:
  // every answer the boot waits for came after it (compile_probe CP1, 1 Nov). Without KHR_parallel_shader_compile a
  // program made late is not asked about until LEAN_CHECK_MS after (its link done by then: no wait in a frame)
  // (DYS-216 first ship: on by default on the phone tier (T1), as the engine's; ?compilelean=1 on any tier, as before;
  // ?compilelean=0 off)
  const compileLean = ((v) => v === "1" || (v !== "0" && engine.settings.tier === "T1"))(urlQ.get("compilelean"));
  const LEAN_CARS_MS = 1000, LEAN_CHECK_MS = 1500;
  // (DYS-216 #4) ?shadermerge=0: the halo's bright and blur as two programs again (HALOPREP_FS), today's texts exactly
  const shaderMerge = urlQ.get("shadermerge") !== "0";
  const notYet = () => ({ p: null, u: null, ok: false, failed: false, later: true, check: () => false });
  let leanShown = null;
  // (DYS-134, B's 13:10 review item 5: QA ?carlamp=0, on a set whose lights carry lamps_na, the moving vehicles without
  // the lamp pools' light: they take the set light as before lamps_na, instanced or not (drawCarGroup: uLampNa.w 0 on
  // their program, no L3 weight). The backdrop's lamps and the vehicles' grade stay as they are (?cargrade=1: the grade
  // kept too). Without lamps_na nothing changes)
  const carLampQ = urlQ.get("carlamp") !== "0";
  // (DYS-149 window-cost: magnified past 1.8x (zoom.js EYE_MAG) the outside's eye offset is 0 exactly (eyeK 0), and the
  // panorama's parallax steps (the far layer's 3, the near layer's 3, the rendered near layer's 4: each step 1-4 texture
  // reads, an atan, an asin and a pow) only find the pixel's own ray again: from the panorama's own eye it is its own
  // picture. A pinch and a pan over the city are drawn there, the backdrop on the whole screen, and the vehicles', ships'
  // and points' hiding tests take the same steps per fragment (occluderDist). With EYE_FAST the shaders return the ray
  // at the first step there (outside.glsl.js eyeZero), and the backdrop reads the near layer's far colour once, not twice:
  // the same direction. Anywhere else (1x, the hand-off at the photograph's eye, a pinch under 1.8x) draws as before
  // (uEyeFast 0: panoValues). ?eyefast=0: the shaders' sources as before; QA at run time: globalThis.__eyeFast = 0, the
  // steps from the next frame)
  const EYE_FAST = urlQ.get("eyefast") !== "0";
  const eyeSrc = (s) => (EYE_FAST ? s.replace("#version 300 es\n", "#version 300 es\n#define EYE_FAST 1\n") : s);
  const instSrc = (s) => s.replace("#version 300 es\n", "#version 300 es\n#define INST 1\n")
    .replace("uniform ivec4 uOcc3S;", "ivec4 uOcc3S;").replace("uniform ivec2 uOcc3T;", "ivec2 uOcc3T;");
  // (DYS-199: the panorama's air in front of the moving cars at golden, lowsun and sunset, CAR3D_FS CARHAZE, by moment:
  // CAR_HAZE. ?carhaze=0: the vehicles' shader without it, as before (its source as before once preprocessed: no uniform,
  // the same floats); ?carhaze=<s>: its share x s (QA, 0-3; without it CAR_HAZE_K, the deploy's pick, above).
  // ?carhazesoft=<px>: the sharp layer's blur widened by up to that much (window px, at 2 km and beyond, by the air's
  // weight), 0 (off) by default: the 4x stills had the moving cars' edges no crisper than the photographed parked cars' (notes))
  const carHazeQ = (() => { const v = urlQ.get("carhaze"); return v === null || v === "" || !Number.isFinite(+v) ? CAR_HAZE_K : Math.max(0, Math.min(3, +v)); })();
  const carHazeSoft = carHazeQ > 0 ? Math.max(0, Math.min(3, +urlQ.get("carhazesoft") || 0)) : 0;
  const hazeSrc = (s) => (carHazeQ > 0 ? s.replace("#version 300 es\n", "#version 300 es\n#define CARHAZE 1\n") : s);
  const brCarQ = BRIDGE_CAR_Q;   // (DYS-240 bridge cars: outside-events.js, which sizes them too)
  const brSrc = (s) => (brCarQ ? s.replace("#version 300 es\n", "#version 300 es\n#define BRIDGECAR 1\n") : s);
  // (DYS-240 day tone: ?carday=0 the vehicles' shader without it, as before; ?carday=<s> its strength x s, QA 0-2)
  const carDayQ = (() => { const v = urlQ.get("carday"); return v === null || v === "" || !Number.isFinite(+v) ? CAR_DAY_K : Math.max(0, Math.min(2, +v)); })();
  const daySrc = (s) => (carDayQ > 0 ? s.replace("#version 300 es\n", "#version 300 es\n#define CARDAY 1\n") : s);
  const car3dProgram = (inst, parallel) => makeProgram(gl, clsFlat(inst ? instSrc(G.CAR3D_VS) : G.CAR3D_VS, "out"),
    clsFlat(eyeSrc(hazeSrc(daySrc(brSrc(inst ? instSrc(G.CAR3D_FS) : G.CAR3D_FS)))), "in"), parallel);
  // windows_extra (city/tables.js WINDOWS_EXTRA): its dial per moment and SF hour; ?wx=<dial> or setExtra(v) holds every
  // moment's at v (QA); null = the table
  let wxHold = opts.windowsExtra ?? (urlQ.has("wx") && Number.isFinite(+urlQ.get("wx")) ? +urlQ.get("wx") : null);
  let wxDials = [0, 0, 0, 0];             // per shader slot, this frame
  const wxSeen = { lights: false, near: false };   // asked for at least once (reported)
  const wxGain = (id) => Math.max(0, WINDOWS_EXTRA_GAIN[id] ?? 1);   // dial 1 = the target look at every moment
  const tier = engine.settings.tier;
  // routes.json's positions are metres around its own eye (eye_scene, scene x/y); the panorama names its eye's scene
  // x/y in eye.world_m (R2's set; the stand-in was made from routes.json's eye)
  const panoEyeXY = meta.eye.world_m, cityEyeXY = routes.frame?.eye_scene;
  const eyeShift = panoEyeXY && cityEyeXY ? [cityEyeXY[0] - panoEyeXY[0], cityEyeXY[1] - panoEyeXY[1]] : [0, 0];
  const events = createEvents({ axisDeg: AXIS, eye: E0, atlas: atlasMeta, carAtlas: carMeta, eyeH: EYE_H, shift: eyeShift });

  // the moments' look, read from the panorama's L2 (white walls, haze, water, high sky) once each arrives, and the
  // bridge deck's darkness (below): read in a worker (perf #2; outside-stats.js runs the same code here where a worker
  // can't), merged here as before
  const stats = new Map();
  let maskSmall = null, maskAsked = false, maskDone = false;
  const statsGeo = { gutter: meta.gutter, yaw: meta.yaw, column_deg: meta.column_deg, bands: { city: { el: meta.bands.city.el }, sky: { el: meta.bands.sky.el } } };
  const statsRun = statsRunner(() => engine.requestFrame());
  function onBand(key, st0) {
    const m = key.split("|")[0];
    stats.set(m, Object.assign(stats.get(m) || {}, st0));
  }
  // The bridge's deck as the panorama shows it: how dark its silhouette is against what lies just above it (sky or the
  // hills behind), per moment, from the city tiles that hold it (the median along the deck; its towers and anything
  // nearer in front of it left out). Backlit, a car on the deck is drawn no plainer than the deck itself
  // (outside-events.js): at golden the render's deck is a faint line, past the north tower lost in the haze.
  const deckLine = [], deckCols = new Set();
  {
    const B = routes.bridge, br = city.bridge;
    const ye = (p) => { const r = events.frame.rel(p[0], p[1], p[2]), d = Math.hypot(r[0], r[1], r[2]); return [Math.atan2(r[0], -r[2]) / DEG, Math.asin(r[1] / d) / DEG]; };
    if (B && br) for (let s = B.s_south_end + 20; s <= B.s_north_end - 20; s += 40) {
      if (Math.abs(Math.abs(s) - B.s_tower) < 60) continue;
      const lo = ye(br.point(s, 0, br.deckBottom(s))), hi = ye(br.point(s, 0, br.deckBottom(s) + B.truss + B.road));
      const col = Math.floor((lo[0] - meta.yaw[0]) / meta.column_deg);
      deckLine.push({ s, yaw: lo[0], elLo: lo[1], elHi: hi[1], col });
      deckCols.add(col);
    }
  }
  function onDeck(key, pairs) {
    const m = key.split("|")[0];
    const st = stats.get(m) || {}, got = st.deckAt || (st.deckAt = {});
    for (const [ds, v] of pairs) got[ds] = v;
    const v = Object.values(got).filter((q) => q < 0.8).sort((a, b) => a - b);   // > 0.8: a tree or a roof in front
    if (v.length >= 8) st.deck = v[v.length >> 1];
    stats.set(m, st);
  }
  const store = new PanoStore(gl, meta, { tier, wake: () => engine.requestFrame() });
  const SLOTS0 = { ...store.slotsOf };     // the tier's own slots (windows_extra's room is added on top of these)
  const pumpOrig = store.pump.bind(store);
  // a read of each L2 (and of each L1 city tile the deck crosses) before it goes to the GPU: the tile waits in the
  // queue (hold) until its numbers are in, so it never shows without them; the city band's needs the mask first
  // (DYS-149 warm-frame: asked a message later, so the worker's copy of the picture (statsRunner: createImageBitmap, on
  // the main thread) is a task of its own, not the asking frame's: asked inside a frame, the copy ran in that frame's
  // microtasks, the warm-up's hidden frame's on every bt1-1521 trace: 6-27 ms on the barely-sufficient laptop, 8-11 on
  // desk1440. The tile waits for its numbers either way (hold): one message later at most)
  const ask = (j, bmp, q, done) => {
    j.hold = true;
    const go = () => statsRun.ask(bmp, q, (r) => { try { done(r); } finally { j.hold = false; } });
    if (warmSplit) nextMessage().then(go); else go();
  };
  // (DYS-203 HS1, B's review: and the hand-off's tile cap, maxTiles, passed on: dropped here, the hand-off's
  // store.pump(now, Infinity, 1) on WebKit sent every decoded tile up in one frame)
  store.pump = (now, budget, maxTiles) => {
    for (const j of store.ready) {
      if (j.kind !== "aux" || maskAsked) continue;
      const w = 560, h = Math.max(8, Math.round((560 * j.bmp.mask.height) / j.bmp.mask.width));
      maskAsked = true;
      ask(j, j.bmp.mask, { op: "mask", w, h }, (d) => { maskDone = true; if (d) maskSmall = { w, h, d }; });
    }
    for (const j of store.ready) {
      if (j.peeked || j.kind === "aux") continue;
      if (j.kind === "L2s" || (j.kind === "L2c" && maskSmall)) {
        j.peeked = true;
        const W = 448, H = Math.max(8, Math.round((448 * j.bmp.height) / j.bmp.width));
        ask(j, j.bmp, { op: "band", kind: j.kind, W, H, meta: statsGeo, mask: j.kind === "L2c" ? maskSmall : null }, (st) => { if (st) onBand(j.key, st); });
      } else if (j.kind === "L2c") j.hold = maskAsked && !maskDone;    // its numbers need the mask, on its way
      else if (j.kind === "L1c" && deckCols.has(+j.key.split("|")[2])) {
        const c = +j.key.split("|")[2], pts = deckLine.filter((d) => d.col === c);
        j.peeked = true;
        if (pts.length) ask(j, j.bmp, { op: "deck", c, meta: statsGeo, pts }, (pairs) => { if (pairs) onDeck(j.key, pairs); });
      }
    }
    return pumpOrig(now, budget, maxTiles);
  };
  afterNet(() => { if (store.auxState === "none") store.loadAux(); });   // (HT1: see netAfter)

  // ---------------------------------------------------------------- stage 1: the first-paint exterior images
  const fmt = await imageFormat().catch(() => "webp");
  const extUrl = (f) => {
    const sizes = f.images?.[viewKey]?.ext;
    if (!sizes) return null;
    return webRoot + pickSize(sizes, FIRST_PAINT_EXT[viewKey] || 1600) + "." + fmt;
  };
  // the page may hand over the pictures it shows ({ a, b, t, ids }); else the ones its first paint would pick
  const sel0 = opts.moment ? resolveSel(opts.moment) : pickFrames(frames, sunPosition(new Date(T0 * 1000)));
  const fp = !opts.firstPaint && opts.firstPaint !== undefined ? null
    : (opts.firstPaint || { a: extUrl(sel0.a), b: extUrl(sel0.b), t: sel0.t, ids: [sel0.a.id, sel0.b.id] });
  let ext = null;            // { a: tex, b: tex, t, ids: [a, b] } once uploaded
  let extJob = null;         // decoded bitmaps waiting for the pass
  let stage1Failed = !fp || !fp.a;
  // (DYS-203 HT1) the pictures' URLs stage 1 draws (extSrc) and the ones on their way to it (extWant): the router compares
  // them with the photograph's (app.js exterior()) before its hand-off, and has a sharper copy that replaced the one on
  // screen taken again (retake)
  const srcOf = (f) => (f ? [f.a || null, f.b && f.b !== f.a && f.t > 0 ? f.b : null] : [null, null]);
  let extSrc = null, extWant = srcOf(fp);
  const extPromise = !stage1Failed ? Promise.all([bitmapFrom(fp.a), fp.b && fp.b !== fp.a && fp.t > 0 ? bitmapFrom(fp.b) : null])
    .then(([a, b]) => { upExt(extJob = { a, b, t: b ? fp.t : 0, ids: fp.ids || [sel0.a.id, sel0.b.id], src: srcOf(fp) }); })
    .catch((e) => { console.warn("[outside] first-paint images:", e.message); stage1Failed = true; }) : Promise.resolve();
  // (HT1) stage 1 from other pictures of the same view (the photograph's sharper copies, app.js pic()'s upgrade), while
  // it is still what the window shows: the ones drawn now stay until the new ones are on the GPU, then go. One at a time
  // (the latest asked for wins); a failure keeps what is drawn
  function retake(f) {
    const src = srcOf(f);
    if (!f?.a || !ext || tileW >= 1 || (extWant && src[0] === extWant[0] && src[1] === extWant[1])) return false;
    extWant = src;
    Promise.all([bitmapFrom(src[0]), src[1] ? bitmapFrom(src[1]) : null]).then(([a, b]) => {
      if (extWant !== src || tileW >= 1 || !ext) { letGo(a); letGo(b); return; }
      upExt(extJob = { a, b, t: b ? f.t : 0, ids: f.ids || ext.ids, src, again: true });
    }).catch((e) => { console.warn("[outside] first-paint images again:", e.message); if (extWant === src) extWant = extSrc; });
    return true;
  }

  // (DYS-149 fix 1b) the first-paint stills by bands (spread). extJob stays set until both are in, as it stayed until the
  // frame that uploaded them: stage 1 is not skipped for the tiles meanwhile, and stage / held (the router's hand-off)
  // wait for ext as they did
  function upExt(j) {
    Promise.allSettled([spread(j.a, { mips: true }), j.b ? spread(j.b, { mips: true }) : null]).then((rs) => {
      const [a, b] = rs.map((r) => r.value || null);
      letGo(j.a); letGo(j.b);
      if (extJob !== j || !a || (j.b && !b)) {
        for (const t of [a, b]) if (t) gl.deleteTexture(t);
        const bad = rs.find((r) => r.status === "rejected");
        // (HT1: a picture taken again that fails keeps the one drawn)
        if (bad && extJob === j && j.again) { console.warn("[outside] first-paint images again:", bad.reason?.message); extJob = null; extWant = extSrc; }
        else if (bad && extJob === j) { console.warn("[outside] first-paint images:", bad.reason?.message); extJob = null; stage1Failed = true; engine.requestFrame(); }
        return;
      }
      if (ext) { gl.deleteTexture(ext.a); if (ext.b) gl.deleteTexture(ext.b); }   // (HT1: the pictures it replaces)
      ext = { a, b, t: j.t, ids: j.ids };
      extSrc = j.src || null;
      extJob = null;
      engine.requestFrame();
    });
  }

  function resolveSel(m) {
    const a = byId.get(m.a || m), b = byId.get(m.b || m.a || m);
    return { a, b, t: m.t ?? 0 };
  }

  // ---------------------------------------------------------------- state
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  let drawnOnce = false;
  let tileW = stage1Failed ? 1 : 0, tileFade = null;   // stage 1 -> tiles
  // handover-r1: opts.holdFirstPaint keeps stage 1 (the photograph's own exterior pixels) on until release(ms): the
  // 3D's handover shows the photograph's window exactly, then the live view dissolves in over ms. A camera move lets
  // it go as before (stage 1 can't follow the camera)
  let hold = !!opts.holdFirstPaint, fadeMs = TILE_FADE_MS;
  const released = [];
  let firstPose = null, moved = false;
  // (v3/loading, ?firstvisit: a camera move during the window's dissolve finishes it over moveFade ms instead of at once,
  // so the boot's framing ease can run with the dissolve; 0, the default: at once, as before)
  let moveFade = 0, movedAt = null, movedFrom = 0;
  let gateStart = null;
  let simT = 0, lastT = null, travel = 0;
  let pair = null;           // what is drawn: { a, b, t }
  let prev = null;           // a pair fading out after a jump: { a, b, t, start, dur }
  let slotIds = [null, null, null, null], weights = [0, 0, 0, 0];
  let env = null, cityState = null, camInfo = null, lastFrame = null, want0 = null, frameDt = 0;
  let primed = null;         // (DYS-149 warm-frame) the city's state primeCity worked out for the next frame: { T, state, at }
  let visible = { yaw: [-30, 20], el: [-8, 18] }, cols = [];
  let holdT = opts.holdT ?? (reduced() ? T0 : null);   // reduced motion: the city exactly as it was when it began
  let fxW = 0;                           // the living effects' weight (0 on the first frame: the canvas matches the page)
  let evW = 0;                           // the city's events' weight (eases in with the effects; stays under reduced motion)
  // DYS-227 (gullreal): the gulls as the 3D western gull (shared/gl/gulls.js, shared/city/gull-model.js), its code
  // fetched GULL_AFTER_MS after the room is shown (or GULL_LATE_MS after the outside's first frame without the router),
  // never on the boot's path; until its programs have linked, and with ?gull3d=0 (QA: the before), the flapping V
  const GULL3D = urlQ.get("gull3d") !== "0", GULL_AFTER_MS = 1500, GULL_LATE_MS = 8000;
  let gullMod = null, gullR = null, gullAsked = false, gullFirst = null, gullN = 0;
  let renderedAt = -1;                   // the frame index the outside last drew (the halo skips frames it didn't)
  let stillDue = false;                  // reduced motion was switched on: draw the still frame once
  let lastReduced = reduced();
  let followed = getOverride();          // the masthead's minutes the clock follows (null = now)
  // DYS-251 (Akshay 5 Nov: 'the vehicles and the signals load up even before the view has changed ... shouldn't they
  // change in tandem?'): a time chosen on the dial moved the city (its cars and their lights, the signals, the beacons,
  // the boats, the lamps and the windows: everything run by the city's clock) at once, while the picture kept the old
  // time until its moments were in (and, magnified, sharp) and then dissolved: the city was ahead by the tiles' wait
  // plus the fade. Now the city keeps the time on screen (tand.off: s from the clock) until the picture's own dissolve
  // to the new time begins, and goes with it: its events out with the old picture over the dissolve's first half, the
  // new time at its middle, in with the new one over the second (their weight |1 - 2p|, p the picture's own eased
  // share); the light layers' lamps and windows run from the old time to the new along the same p. ?tandem=0: as
  // before. { off, since, k0: the events' weight it began from, fade: the picture's fade it goes with (null: waiting),
  // drag: the dial dragged (times within DIAL_MOVING_MS of each other), whose picture steps on through the moments in
  // nearest as before; a single tap's keeps the old picture from its first frame }
  const TANDEM = urlQ.get("tandem") !== "0";
  let tand = null, lastFollow = -Infinity;
  let tk = { off: 0, k: 1, p: 1 };       // this frame's: the city's offset (s), its events' weight, the dissolve's share
  let lightsAt = null, lightsT = 0;      // during a tandem dissolve: the light layers' windows and lamps, at their time
  function tandemAt(now) {
    if (!tand) return { off: 0, k: 1, p: 1 };
    if (!tand.fade) return { off: tand.off, k: tand.k0 + (1 - tand.k0) * smooth01((now - tand.since) / 300), p: 0 };
    const f = tand.fade, p = f.dur > 0 ? smooth01((now - f.start) / f.dur) : 1;
    return p < 0.5 ? { off: tand.off, k: (1 - 2 * p) * Math.min(1, tand.k0 + (1 - tand.k0) * smooth01((now - tand.since) / 300)), p } : { off: 0, k: 2 * p - 1, p };
  }
  const perf = { cpuMs: 0, updateMs: 0, frames: 0 };
  // v3/zoom: the window's magnifier (shared/zoom.js) hooks in here once someone magnifies; null until then (and the
  // outside is then exactly what it was)
  let zoom = null;
  let backL3 = false;                    // (DYS-134) the backdrop drew with zoom's L3 variant this frame (drawCarGroup)

  const distPair = (p, q) => {
    const w = (x) => { const m = new Map([[x.a.id, 1 - x.t]]); m.set(x.b.id, (m.get(x.b.id) || 0) + x.t); return m; };
    const a = w(p), b = w(q);
    let d = 0;
    for (const id of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(id) || 0) - (b.get(id) || 0));
    return d / 2;
  };
  // v3/dial-smooth: what the window can show for the pair the dial wants (null: keep what is shown). See update().
  let lastWantKey = null, wantMovedAt = -Infinity, dialDir = 0, lastWantAz = null;
  // v3/zoom-sharp: magnified, the change waited for ({ ids, since }: the dial's moments not on screen yet), its new
  // dominant moment (whose panorama tiles for this view prepare() checks: baseOk) and the neighbours' URLs warmed
  let holdFor = null, incoming = [], incomingDom = null;
  const baseOk = new Map();
  const warmed = new Set();
  let warmBytes = 0, warming = false, lastNeeds = null;
  // a time someone chose (the dial's minutes the clock follows, or a moment handed over), not the clock's own: its
  // changes fade fast; the clock's own passing keeps its slow 0.45-2.5 s dissolves
  const chosen = () => !!opts.moment || followed !== null;
  // the moments in day order (the sun's azimuth rises through the day), for the ones ahead of a moving dial
  const dayOrder = frames.slice().sort((p, q) => (p.az ?? 0) - (q.az ?? 0));
  const ahead = (f, dir, n) => {
    const i = dayOrder.indexOf(f), out = [];
    for (let k = 1; k <= n && i >= 0 && dir; k++) out.push(dayOrder[(i + dir * k + dayOrder.length * 4) % dayOrder.length]);
    return out;
  };
  const azGap = (f, g) => { const d = Math.abs((f.az ?? 0) - (g.az ?? 0)) % 360; return Math.min(d, 360 - d); };
  const fewSlots = () => Math.min(store.slotsOf.L2c || 0, store.slotsOf.L2s || 0) < 4;
  // (ok: whether a moment can be shown; v3/zoom-sharp: magnified, only once it is sharp for the view)
  function drawable(want, moving, ok = momentReady) {
    const near = want.t < 0.5 ? want.a : want.b;
    const exact = ok(want.a.id) && (want.t === 0 || ok(want.b.id));
    const single = (f) => ({ a: f, b: f, t: 0 });
    // the dial's pair, when in; on a phone a moving dial gets single moments, unless the pair on screen is already
    // the dial's two moments (then only the blend between them changes, continuously: no fade, no collapse)
    const samePair = (want.a === pair.a && want.b === pair.b) || (want.a === pair.b && want.b === pair.a);
    if (exact && (samePair || !(moving && fewSlots() && want.a !== want.b))) return { a: want.a, b: want.b, t: want.t };
    if (ok(near.id)) return single(near);
    // the moment in nearest the dial's, if nearer than the one shown
    const shown = pair.t < 0.5 ? pair.a : pair.b;
    let best = null;
    for (const f of frames) if (ok(f.id) && (!best || azGap(f, near) < azGap(best, near))) best = f;
    if (best && azGap(best, near) < azGap(shown, near) - 1e-6) return single(best);
    // nothing nearer is in: with few slots, a blend on screen gives way to its nearer moment (a slot for the dial's)
    if (fewSlots() && pair.a !== pair.b && pair.t > 0) return single(shown);
    return null;
  }
  // DYS-251: what a chosen time waiting with the city (tand) shows: the dial's pair once in, its nearer moment alone
  // after TANDEM_PAIR_MS; with few whole-band slots (phones: 3) a blend on screen gives way to its nearer moment, still
  // the old time, so the dial's moments get a slot to load into (prepare() keeps every moment on screen first: kept,
  // the blend left them none, and the picture waited out HOLD_MAX_MS); else nothing new (null: the old picture stays)
  function tandemTarget(want, ok, now) {
    if (ok(want.a.id) && (want.t === 0 || ok(want.b.id))) return drawable(want, false, ok);
    const near = want.t < 0.5 ? want.a : want.b;
    if (now - tand.since > TANDEM_PAIR_MS && ok(near.id)) return { a: near, b: near, t: 0 };
    if (fewSlots() && pair.a !== pair.b && pair.t > 0) { const shown = pair.t < 0.5 ? pair.a : pair.b; return { a: shown, b: shown, t: 0 }; }
    return null;
  }
  // the sky's L1 tiles only for a moment whose clouds are baked into it: with the clouds on their own layer the sky
  // is a smooth gradient, and L2 (16 px/deg) draws it the same (?skyl1=1 to compare)
  const skyL1 = (id) => !meta.moments[id]?.clouds || urlQ.get("skyl1") === "1";
  const TWO = !!meta.geo.size.F2;          // a two-layer panorama (plan v2 6): the far layer's L2 is always resident with its moment
  const momentReady = (id) => store.has(id, "L2c") && store.has(id, "L2s") && (!meta.moments[id]?.clouds || store.has(id, "clouds")) && (!TWO || store.has(id, "F2"));
  // v3/zoom-sharp: a neighbouring moment's panorama tiles for this view (its whole-band tiles, then the view's columns
  // as the dominant moment draws them) fetched into the browser's cache, not decoded: no GPU memory; one at a time, at
  // low priority, within WARM_BYTES a visit. The magnifier asks while it idles magnified; true while one is under way.
  function warm(id) {
    if (warming) return true;
    if (!lastNeeds || !meta.moments[id] || warmBytes >= (WARM_BYTES[tier] || WARM_BYTES.T2)) return false;
    const n = lastNeeds, kinds = [["L2c", 0], ["L2s", 0], ["clouds", 0], ...(TWO ? [["F2", 0]] : [])];
    for (const c of n.cols) {
      if (n.needCity) kinds.push(["L1c", c]);
      if (n.needSky && skyL1(id) && store.slotsOf.L1s) kinds.push(["L1s", c]);
      if (n.needFar && store.slotsOf.F1) kinds.push(["F1", c]);
      if ((byId.get(id)?.night || 0) > 0) kinds.push(["lights", c]);
      if (n.near2) kinds.push(["NB", c]);
    }
    for (const [k, c] of kinds) {
      if (!store.slotsOf[k] || !meta.geo.size[k] || (k === "clouds" && !meta.moments[id].clouds) || (k === "lights" && !meta.moments[id].lights)) continue;
      if (k === "NB" && !meta.moments[id].near2) continue;
      if (store.has(id, k, c)) continue;
      const url = tileUrl(meta, id, k, c);
      if (warmed.has(url)) continue;
      warmed.add(url);
      warming = true;
      fetch(url, { priority: "low" }).then((r) => (r.ok ? r.blob() : null)).then((b) => { warmBytes += b?.size || 0; })
        .catch(() => {}).finally(() => { warming = false; });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- camera
  const tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(), rot = new THREE.Matrix4(), inv = new THREE.Matrix4();
  const ry = new THREE.Matrix4(), rx = new THREE.Matrix4(), view = new THREE.Matrix4(), vp = new THREE.Matrix4();
  function cameraFor(frame) {
    // (v3/zoom-r3: zoomed, the outside has a camera of its own, magnified; the room's stays at 1x)
    const c = frame.outside || frame.camera;
    const [syaw, spitch] = c.sway || [0, 0];
    tmpQ.fromArray(c.quaternion);
    rot.makeRotationFromQuaternion(tmpQ);
    // the sway turns the outside (yaw right, pitch up) as a head moved the other way would see it, pivoting on the glass
    ry.makeRotationY(-syaw);
    rx.makeRotationX(spitch);
    const R = new THREE.Matrix4().multiplyMatrices(ry, rot).multiply(rx);
    const pos = new THREE.Vector3().fromArray(c.position);
    const L = Math.max(0.3, pos.z - GLASS_Z);
    const right = new THREE.Vector3(1, 0, 0).applyMatrix4(R), up = new THREE.Vector3(0, 1, 0).applyMatrix4(R);
    const eye = pos.clone().addScaledVector(right, -L * syaw).addScaledVector(up, -L * spitch);
    inv.copy(c.projectionNoJitter).invert();
    const rayM = new THREE.Matrix4().multiplyMatrices(R, inv);
    view.copy(R).setPosition(eye).invert();
    vp.multiplyMatrices(c.projectionNoJitter, view);
    const e = c.projectionNoJitter.elements;
    const pxPerRad = (e[5] * frame.height) / 2;       // device px per radian at the centre
    // (DYS-183 mv-outside: the same at the full-size frame's density: a moving frame drawn smaller (the room's moving
    // scale, or the outside's while a zoom gesture moves it) keeps the decisions that must not flip mid-move and back at
    // rest (outside-events.js: a vehicle 3D or a speck, a ship's cabin lights); sizes on the screen stay pxPerRad's)
    const pxPerRadRest = pxPerRad * (engine.height / Math.max(1, frame.height));
    return {
      rayM: rayM.elements.slice(), vp: Float64Array.from(vp.elements), eye: [eye.x - E0[0], eye.y - E0[1], eye.z - E0[2]],
      eyeWorld: eye.toArray(), width: frame.width, height: frame.height, pxPerRad, pxPerRadRest, css: frame.dpr,
      phone: tier === "T1", zoom: zoom ? zoom.mag() : 1, rayAt(x, y) {
        const v = new THREE.Vector4(x, y, 1, 1).applyMatrix4(rayM);
        const d = new THREE.Vector3(v.x / v.w, v.y / v.w, v.z / v.w).normalize();
        return [d.x, d.y, d.z];
      },
    };
  }

  // ---------------------------------------------------------------- the moment's conditions (live.js env)
  const windOf = (f) => (typeof f.wind === "object" && f.wind ? f.wind.speed ?? 0.5 : f.wind ?? 0.5);
  const windFromOf = (f) => (typeof f.wind === "object" && f.wind?.dir_deg != null ? f.wind.dir_deg : 260);
  const cloudDxOf = (f) => f.cloud_motion?.dx ?? 0.06;
  const cloudDyOf = (f) => f.cloud_motion?.dy ?? null;
  function environment() {
    const ws = slotIds.map((id, i) => [id ? byId.get(id) : null, weights[i]]).filter(([f, w]) => f && w > 0);
    const of = (fn) => ws.reduce((s, [f, w]) => s + fn(f) * w, 0);
    const st = (k, d) => {
      let acc = [0, 0, 0], tw = 0;
      for (const [f, w] of ws) { const v = stats.get(f.id)?.[k]; if (v) { acc = acc.map((x, i) => x + v[i] * w); tw += w; } }
      return tw > 0 ? acc.map((x) => x / tw) : d;
    };
    const alt = of((f) => f.alt), az = of((f) => f.az), night = of((f) => f.night || 0);
    const from = of(windFromOf), rel = (from + 180 - AXIS) * DEG;
    const white = st("white", [0.9, 0.88, 0.84]);
    let deck = 0, deckW = 0;
    for (const [f, w] of ws) { const v = stats.get(f.id)?.deck; if (v !== undefined) { deck += v * w; deckW += w; } }
    return {
      deck: deckW > 0.5 ? deck / deckW : null,
      night, alt, az, fog: of((f) => f.fog || 0), wind: of(windOf), windTo: [Math.sin(rel), Math.cos(rel)],
      cloudDx: of(cloudDxOf), cloudDy: ws.some(([f]) => cloudDyOf(f) !== null) ? of((f) => cloudDyOf(f) ?? 0) : null,
      white, air: st("air", white.map((x) => x * 0.8)), water: st("water", [0.2, 0.3, 0.4]), high: st("high", [0.45, 0.6, 0.8]),
    };
  }
  const sunTint = (alt) => { const k = smooth(-1, 22, alt); return [1.0, lerp(0.55, 0.96, k), lerp(0.3, 0.9, k)]; };

  // ---------------------------------------------------------------- GL objects
  let P = null;              // programs
  let vaoEmpty, vaoPts, vboPts, vaoHull, vboHull, ptsCap = 0, hullCap = 0, vaoCar, vboCar, carCap = 0;
  let vaoHullHi, vboHullHi, hullHiCap = 0;   // (DYS-232: the big ships' sharp instances, drawSprites)
  const HULL_ATTRS = [4, 4, 4, 4, 4, 4, 3, 4, 4, 4];   // (their floats per attribute 0..9: HULL_FLOATS 39)
  let dummy2d, dummyArr, alb = null, nrm = null, ngt = null, atlasJob = null;
  let carAlb = null, carNrm = null, carJob = null;
  // the street vehicles' meshes: the file (kept for a restored context), their buffers, the offscreen layer
  let meshData = null, meshGL = null, vaoQuad = null, meshReadyAt = null;
  const MESH_FADE_MS = 500;   // the 3D vehicles fade in over the specks once their meshes arrive (never a pop at rest)
  const STREETS_FADE_MS = 1500;   // (the street cars' fade in: streetsSince, by the city, above)
  // DYS-204: the traffic signals at night (outside-events.js SIGNAL_LOOK). Their heads (city/signals.json, 2 KB) are
  // asked for only once a night-light moment shows (a visit by day asks for nothing new) and the street simulation is
  // in; they fade in over SIGNALS_FADE_MS from their arrival. ?signals=0: never asked for, never drawn
  const SIGNALS_ON = STREETS_ON && urlQ.get("signals") !== "0";
  const SIGNALS_FADE_MS = 800;
  let sigAsked = false, sigAt = null, sigGone = false;
  // (DYS-149 SL2, ?streetsplit=0 off: the street cars' first appearance waits for the boot's still -> live hand-off to
  // end for the page's main thread: the room shown (sfw:room-shown), its frames at 60 fps again, CALM_N in a row each
  // within CALM_MS (the frames before room-shown count), and a step of the street cheap here (streets.js stepMs, its
  // fewest ms a step: at most STEP_FAST_MS); else CARS_CAP_MS after room-shown. The router's own marks are timers, the
  // same on every tier (SL3: handoffEnd +0.55 s, the window live +2.1-3.3 s); desk1440's frames are at 60 fps from
  // before room-shown (the cars come with the room, as on main); the slow laptop has runs of 60 fps frames too (SL3:
  // 20 in a row by +0.5-1.9 s), so what tells it apart is what the street costs it, ~2 ms a step against desk1440's
  // tenths: there the cars come at the cap, after the hand-off's busy seconds (main's ~+10 s). Meanwhile the city's
  // simulations keep up with the clock (the worker, then the page's slices) and nothing of them is placed or drawn
  // (city.js state: streetsHold); their fade starts at the end. SL1-SL3, barely-sufficient: once drawn the cars cost
  // the page 5-12 ms in its long frames. Only under the router (it names holdFirstPaint); once let go, never again)
  const CARS_CAP_MS = 5500, CALM_MS = 20, CALM_N = 20, STEP_FAST_MS = 0.8;
  // (review: under reduced motion no frames come after the still, so the release would never be seen: none held then)
  let carsGo = urlQ.get("streetsplit") === "0" || opts.holdFirstPaint === undefined || reduced() ? 0 : null, shownAt = null, calmN = 0, calmF = null;
  function carsHeld(now, f) {
    if (carsGo !== null) return false;
    if (reduced()) { carsGo = now; return false; }
    if (f != null) { if (calmF !== null) calmN = f - calmF <= CALM_MS ? calmN + 1 : 0; calmF = f; }
    if (shownAt === null) shownAt = performance.getEntriesByName?.("sfw:room-shown")?.[0]?.startTime ?? null;
    if (shownAt === null) return true;
    if ((calmN >= CALM_N && (city.streets?.stepMs ?? Infinity) <= STEP_FAST_MS) || now - shownAt >= CARS_CAP_MS) { carsGo = now; tev("cars go", Math.round(now - shownAt)); return false; }
    return true;
  }
  const carLayers = [null, null];   // the sharp and the soft vehicles' offscreen layers
  let halo = null;           // { h2, h4, h8a, h8b }
  let haloSpare = null;      // the other size's set: moving frames draw smaller (engine perf-r2), kept, not remade each glide
  let copyT = null;          // outside-only debug copy
  const atlasBase = webRoot + "live/sprites/";
  // the sprite atlas: phones (T1) draw the ships at about half the size and take the half-size set (a quarter of the
  // bytes and of the memory); the old atlas had one set
  const atlasSet = atlasMeta?.sets ? (tier === "T1" && atlasMeta.sets.half ? atlasMeta.sets.half : atlasMeta.sets.full)
    : { albedo: "boats-albedo.webp", normal: "boats-normal.webp" };
  const loadAtlas = () => Promise.all([bitmapFrom(atlasBase + atlasSet.albedo), bitmapFrom(atlasBase + atlasSet.normal),
    atlasSet.night ? bitmapFrom(atlasBase + atlasSet.night) : null]);
  if (atlasMeta) afterNet(loadAtlas).then(([a, n, g]) => { upAtlas(atlasJob = { a, n, g }); }).catch((e) => { atlasOut = true; console.warn("[outside] sprite atlas:", e.message); });
  // (DYS-149 fix 1b) the ships' atlas by bands (spread), not one texture a frame inside the frame; the three handed over
  // together, as the sprites waited for all three (drawSprites: alb && nrm && !atlasJob)
  function upAtlas(j) {
    Promise.allSettled([spread(j.a, { mips: true }), spread(j.b || j.n, { mips: true }), j.g ? spread(j.g, { mips: true, rg: true }) : null]).then((rs) => {
      const [a, n, g] = rs.map((r) => r.value || null);
      letGo(j.a); letGo(j.n); letGo(j.g);
      if (atlasJob !== j || !a || !n || (j.g && !g)) {
        for (const t of [a, n, g]) if (t) gl.deleteTexture(t);
        const bad = rs.find((r) => r.status === "rejected");
        if (bad && atlasJob === j) { console.warn("[outside] sprite atlas:", bad.reason?.message); atlasJob = null; atlasOut = true; }
        return;
      }
      alb = a; nrm = n; ngt = g; atlasJob = null; atlasOut = true;
      engine.requestFrame();
    });
  }
  // (DYS-232) the big ships' sharp pictures for the zoom (city/ship-detail.js): nothing of them is fetched until a
  // visitor first magnifies past DETAIL_ZOOM (update: zoom.mag()); then the json and, a cell at a time, only what the
  // ships on screen show and are turning toward, copied into a pool of a few cells (three textures: albedo and night
  // at a cell's px, the normal at half; phones the half set, each at half that), the least recently drawn let go.
  // ?shipshi=0 (or ?shipsfx=0, the ships as before DYS-232): never (the 1x atlas at every zoom, as before)
  let hiPool = null, hiZero = null;          // { alb, nrm, ngt, size } on the GPU; a slot's worth of zeros
  const shipDetail = atlasMeta && urlQ.get("shipshi") !== "0" && urlQ.get("shipsfx") !== "0" ? createShipDetail({ phone: tier === "T1",
    fetchJson: () => fetch(atlasBase + DETAIL_JSON).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetchCell: (urls, slot, layout) => Promise.all([bitmapFrom(atlasBase + urls.albedo), bitmapFrom(atlasBase + urls.normal), bitmapFrom(atlasBase + urls.night)])
      .then(([a, n, g]) => upCell(a, n, g, layout.at[slot], layout)),
    onReady: () => engine.requestFrame(), now: () => performance.now() }) : null;
  if (shipDetail) events.setShipDetail(shipDetail);
  // a cell's three pictures into the pool at its slot (full-set px `at`; phones' textures at half), the slot cleared
  // first (a smaller cell over a bigger one's leaves nothing at its edges for the filtering), the mipmaps made again
  function upCell(a, n, g, at, layout) {
    try {
      if (gl.isContextLost()) throw new Error("context lost");
      const k = tier === "T1" ? 2 : 1, [W, H] = layout.size, [sw, sh] = layout.slot;
      if (!hiPool || hiPool.size !== layout.size) {
        hiPool = { size: layout.size, alb: texStorage(gl, W / k, H / k, { mips: true }), nrm: texStorage(gl, W / k / 2, H / k / 2, { mips: true }),
          ngt: texStorage(gl, W / k, H / k, { mips: true, rg: true }) };
      }
      if (!hiZero) hiZero = new Uint8Array((sw / k) * (sh / k) * 4);
      const was = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      for (const [t, src, d, fmt] of [[hiPool.alb, a, k, gl.RGBA], [hiPool.nrm, n, 2 * k, gl.RGBA], [hiPool.ngt, g, k, gl.RG]]) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, at[0] / d, at[1] / d, sw / d, sh / d, fmt, gl.UNSIGNED_BYTE, hiZero);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, at[0] / d, at[1] / d, src.width, src.height, fmt, gl.UNSIGNED_BYTE, src);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      gl.bindTexture(gl.TEXTURE_2D, was);
    } finally { letGo(a); letGo(n); letGo(g); }
  }
  // the street vehicles' atlas: phones (T1) take the half-size set
  const carSet = carMeta ? (tier === "T1" && carMeta.sets.half ? carMeta.sets.half : carMeta.sets.full) : null;
  const loadCars = () => Promise.all([bitmapFrom(atlasBase + carSet.albedo), bitmapFrom(atlasBase + carSet.normal)]);
  if (carSet) loadCars().then(([a, n]) => { upCars(carJob = { a, n }); }).catch((e) => console.warn("[outside] cars atlas:", e.message));
  // (DYS-149 fix 1b) the street vehicles' atlas (QA ?carmesh=0) the same way; drawn once both are in, as before
  function upCars(j) {
    Promise.allSettled([spread(j.a, { mips: true }), spread(j.n, { mips: true })]).then((rs) => {
      const [a, n] = rs.map((r) => r.value || null);
      letGo(j.a); letGo(j.n);
      if (carJob !== j || !a || !n) {
        for (const t of [a, n]) if (t) gl.deleteTexture(t);
        const bad = rs.find((r) => r.status === "rejected");
        if (bad && carJob === j) { console.warn("[outside] cars atlas:", bad.reason?.message); carJob = null; }
        return;
      }
      carAlb = a; carNrm = n; carJob = null;
      engine.requestFrame();
    });
  }
  // the meshes, once (setZoom starts it): the index, then the file; the events learn of them only once both are in
  let meshLoad = null;
  // the panorama's baked parked cars beside the paths (cars-baked.json, scripts/city_clock/baked_cars.py), in the room
  // frame: [t (3), right (3), forward (3), length, width, height, distance], on a 20 m grid (x, z) for finding them
  let baked = null;
  // (gc-diet: a 20 m cell's number, one for each pair of whole numbers within +-2^20 cells: exact, < 2^42)
  const cellKey = (cx, cz) => (cx + 1048576) * 2097152 + (cz + 1048576);
  function bakedRoom(bk) {
    if (!bk?.cars?.length) return null;
    const F = events.frame, cells = new Map(), list = [], cellsN = new Map();
    const A = AXIS * DEG, sA = Math.sin(A), cA = Math.cos(A), toRoom = (x, y, z) => [x * cA - y * sA, z, -(x * sA + y * cA)];
    for (const [x, y, h, hd, L, W, H] of bk.cars) {
      const t = F.rel(x, y, city.frame.z(x, y, h)), r = hd * DEG;
      const rec = { t, right: toRoom(Math.cos(r), -Math.sin(r), 0), fwd: toRoom(Math.sin(r), Math.cos(r), 0), L, W, H, d: Math.hypot(...t) };
      const k = `${Math.floor(t[0] / 20)},${Math.floor(t[2] / 20)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(rec); list.push(rec);
      // (DYS-149 gc-diet: the same lists by a number, cellKey: drawCarGroup looks up 9 cells a vehicle a frame)
      const kn = cellKey(Math.floor(t[0] / 20), Math.floor(t[2] / 20));
      if (!cellsN.has(kn)) cellsN.set(kn, cells.get(k));
    }
    return { cells, list, cellsN };
  }
  function loadMeshes() {
    if (meshLoad || carmeshOff || !STREETS_ON) return;   // (no street traffic: nothing of theirs fetched)
    // (the fleet, v3/traffic-assets: format v2, three LODs a model, no presorted views; QA ?fleet=v1: the earlier file)
    const fleet = urlQ.get("fleet") === "v1" ? "cars-lod" : "cars-lod-v2";
    meshLoad = fetch(webRoot + `live/meshes/${fleet}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => Promise.all([fetch(webRoot + `live/meshes/${fleet}.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        fetch(webRoot + "live/meshes/cars-baked.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)])
        .then(([b, bk]) => { meshMeta = j; meshData = b; baked = bakedRoom(bk); events.setCarMeshes(j); engine.requestFrame(); }))
      .catch((e) => console.warn("[outside] car meshes:", e.message));
  }
  // the meshes onto the GPU: one vertex buffer (the file), one index buffer with every model's view lists (each view's
  // faces far to near), a vertex array per model; v2: a range and a vertex array per LOD (its indices local to it)
  function uploadMeshes() {
    const vbo = gl.createBuffer(), ebo = gl.createBuffer();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, meshData, gl.STATIC_DRAW);
    const lists = [], ranges = {}, vaos = {}, boxes = {};
    let at = 0;
    // (DYS-149 smooth: v2, each LOD's own bounds, the 8 corners' x, y, z in model metres: the instanced draws' overlap
    // test, carsInstanced)
    const boxOf = ([o, n]) => {
      const v = new Int16Array(meshData, o, n * 8), b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let k = 0; k < n * 8; k += 8) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], v[k + a]); b[a + 3] = Math.max(b[a + 3], v[k + a]); }
      const c = [];
      for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) c.push(x * 0.001, y * 0.001, z * 0.001);
      return c;
    };
    const vaoAt = (o) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.SHORT, false, 16, o);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.BYTE, true, 16, o + 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 16, o + 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      return vao;
    };
    // (DYS-161 memory, QA ?caralign=1: one unused index before a range that would start 2 bytes off a 4-byte boundary)
    const align = () => { if (carAlign && at & 1) { lists.push(new Uint16Array(1)); at++; } };
    for (const [name, m] of Object.entries(meshMeta.models)) {
      if (meshMeta.version === 2) {
        ranges[name] = m.lods.map((l) => { align(); lists.push(new Uint16Array(meshData, l.triangles_at, l.triangles * 3)); const r = [at * 2, l.triangles * 3]; at += l.triangles * 3; return r; });
        vaos[name] = m.lods.map((l) => vaoAt(l.vertices[0]));
        boxes[name] = m.lods.map((l) => boxOf(l.vertices));
        continue;
      }
      const tri = new Uint16Array(meshData, m.triangles_at, m.triangles * 3);
      ranges[name] = m.views.map(([off, n]) => {
        const order = new Uint16Array(meshData, off, n), ib = new Uint16Array(n * 3);
        for (let i = 0; i < n; i++) { const t = order[i] * 3; ib[i * 3] = tri[t]; ib[i * 3 + 1] = tri[t + 1]; ib[i * 3 + 2] = tri[t + 2]; }
        align();
        lists.push(ib);
        const r = [at * 2, n * 3];
        at += n * 3;
        return r;
      });
      vaos[name] = vaoAt(m.vertices[0]);
    }
    const all = new Uint16Array(at);
    let k = 0;
    for (const ib of lists) { all.set(ib, k); k += ib.length; }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, all, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    meshGL = { vbo, ebo, vaos, ranges, boxes };
    tev("meshes", meshMeta.version || 1);
    meshMeta.ready = true;
    meshReadyAt = null;   // (the fade in starts at the first frame drawn with them)
  }

  function initGL() {
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    let prep;   // (DYS-216 #4, ?shadermerge: P.bright and P.blur one program, HALOPREP_FS; uPass set before each draw)
    P = {
      back: makeProgram(gl, G.FULL_VS, eyeSrc(G.BACKDROP_FS), parallel),   // (DYS-149 window-cost: eyeSrc, here and below)
      pts: makeProgram(gl, G.POINTS_VS, eyeSrc(G.POINTS_FS), parallel),
      hull: makeProgram(gl, rectFlat(G.HULL_VS, "out"), rectFlat(eyeSrc(G.HULL_FS), "in"), parallel),
      bright: (prep = makeProgram(gl, G.FULL_VS, shaderMerge ? HALOPREP_FS : G.BRIGHT_FS, parallel)),
      blur: shaderMerge ? prep : makeProgram(gl, G.FULL_VS, G.BLUR_FS, parallel),
      halo: makeProgram(gl, G.HALO_VS, G.HALO_FS, parallel),
      copy: compileLean && !outsideOnly ? notYet() : makeProgram(gl, G.FULL_VS, G.COPY_FS, parallel),
      car3d: compileLean ? notYet() : car3dProgram(carInstQ, parallel),   // (DYS-149 smooth: instanced unless ?carinst=0; the other, P.car3dAlt, when asked for)
      carLayer: compileLean ? notYet() : makeProgram(gl, G.CARLAYER_VS, G.CARLAYER_FS, parallel),
    };
    vaoEmpty = gl.createVertexArray();
    vaoPts = gl.createVertexArray();
    vboPts = gl.createBuffer();
    gl.bindVertexArray(vaoPts);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPts);
    const sp = POINT_FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, sp, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, sp, 16);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, sp, 32);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, sp, 48);
    vaoHull = gl.createVertexArray();
    vboHull = gl.createBuffer();
    gl.bindVertexArray(vaoHull);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboHull);
    const sh = HULL_FLOATS * 4;
    [[0, 4, 0], [1, 4, 16], [2, 4, 32], [3, 4, 48], [4, 4, 64], [5, 4, 80], [6, 3, 96], [7, 4, 108], [8, 4, 124], [9, 4, 140]].forEach(([i, n, off]) => {
      gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, sh, off); gl.vertexAttribDivisor(i, 1);
    });
    // (DYS-232) the big ships' sharp instances: the hull program's layout (HULL_ATTRS: the table above, each attribute's
    // floats, the offsets their running sum) over their own buffer
    vaoHullHi = gl.createVertexArray();
    vboHullHi = gl.createBuffer();
    gl.bindVertexArray(vaoHullHi);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboHullHi);
    HULL_ATTRS.reduce((off, n, i) => {
      gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, sh, off); gl.vertexAttribDivisor(i, 1);
      return off + n * 4;
    }, 0);
    // the street vehicles: the hull program's layout over their own buffer
    vaoCar = gl.createVertexArray();
    vboCar = gl.createBuffer();
    gl.bindVertexArray(vaoCar);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboCar);
    [[0, 4, 0], [1, 4, 16], [2, 4, 32], [3, 4, 48], [4, 4, 64], [5, 4, 80], [6, 3, 96], [7, 4, 108], [8, 4, 124], [9, 4, 140]].forEach(([i, n, off]) => {
      gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, sh, off); gl.vertexAttribDivisor(i, 1);
    });
    // the shadow quad under a 3D vehicle: corners +-1000 (the mesh's mm), a strip
    vaoQuad = gl.createVertexArray();
    gl.bindVertexArray(vaoQuad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1000, -1000, 0, 1, 1000, -1000, 0, 1, -1000, 1000, 0, 1, 1000, 1000, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);
    ptsCap = 0; hullCap = 0; carCap = 0; hullHiCap = 0;
    dummy2d = tex2d(gl, null);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    dummyArr = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, dummyArr);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function sizeTargets(w, h) {
    if (halo && halo.w === w && halo.h === h) return;
    if (haloSpare && haloSpare.w === w && haloSpare.h === h && !outsideOnly) { [halo, haloSpare] = [haloSpare, halo]; return; }
    if (haloSpare) for (const k of ["h2", "h4", "h8a", "h8b"]) freeTarget(gl, haloSpare[k]);
    haloSpare = halo;
    const d = (n) => Math.max(1, Math.round(w / n)), e = (n) => Math.max(1, Math.round(h / n));
    halo = { w, h, h2: target(gl, d(2), e(2)), h4: target(gl, d(4), e(4)), h8a: target(gl, d(8), e(8)), h8b: target(gl, d(8), e(8)) };
    if (outsideOnly) { freeTarget(gl, copyT); copyT = target(gl, w, h); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function roomTexture(frame) {
    const t = frame.textures?.roomAlpha;
    const p = t ? engine.renderer.properties.get(t) : null;
    return p?.__webglTexture || null;
  }

  // ---------------------------------------------------------------- per frame, CPU
  // update() does what doesn't depend on the camera (the clock, the moments, the city's state); everything that
  // does (the projection, the visible columns, the stage switch, the events on screen) runs at the start of render(),
  // so it uses the camera the room is drawn with in that same frame (docs/v3/nav.md, E1 ask 1).
  function update(frame) {
    const t0 = performance.now();
    const now = frame.time;
    // reduced motion, switched on or off at any time: the city holds still at the second it was switched on
    if (reduced()) { if (holdT === null) { holdT = clock.T(); stillDue = true; } } else if (holdT !== null && !opts.holdT) holdT = null;
    const T = holdT ?? clock.T();
    const dt = lastT === null ? 0 : Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (!reduced()) simT += dt;
    frameDt = dt;

    // ---- which moments, and which of them are drawable
    const want = opts.moment ? resolveSel(opts.moment) : pickFrames(frames, sunPosition(new Date(T * 1000)));
    if (!pair) pair = { a: want.a, b: want.b, t: want.t };
    // v3/dial-smooth (stage-qa F1): the window follows the time dial by fades only, and never shows a moment far from
    // it. A change of moment waits for the running fade to end (a second switch inside a fade used to drop the pair in
    // between in one frame); while the dial moves the fades are short. What is shown is the dial's pair when it is in,
    // else its nearer moment alone, else the moment in nearest the dial's (by the sun's azimuth, which rises through the
    // day). With few whole-band slots (phones: 3) a moving dial shows single moments, so a fade never needs more
    // moments than there are slots, and a blend on screen gives way to its nearer moment to free one for the dial's.
    const wantKey = `${want.a.id}|${want.b.id}|${want.t.toFixed(3)}`;
    if (wantKey !== lastWantKey) {
      lastWantKey = wantKey; wantMovedAt = now;
      // which way the dial goes through the day (+1 later, -1 earlier), from its nearer moment's azimuth
      const az = (want.t < 0.5 ? want.a : want.b).az ?? 0;
      if (lastWantAz !== null && az !== lastWantAz) { let d = az - lastWantAz; if (d > 180) d -= 360; if (d < -180) d += 360; dialDir = Math.sign(d); }
      lastWantAz = az;
    }
    const moving = now - wantMovedAt < DIAL_MOVING_MS;
    // a long fade still running when the dial moves again: retimed to end within DIAL_FADE_MS, from the blend it has
    // reached (no jump), so the next change isn't held back
    if (prev && moving && chosen()) {
      const p = clamp((now - prev.start) / prev.dur, 0, 1), left = prev.dur * (1 - p);
      if (p < 1 && left > DIAL_FADE_MS) { const D = DIAL_FADE_MS / (1 - p); prev.start = now - p * D; prev.dur = D; }
    }
    // v3/zoom-sharp (docs/v3/bugs/2026-10-26-zoom-blur.md): magnified past what L0 holds (the magnifier's sharp mode),
    // a change of moments waits, the pair on screen kept sharp (the magnifier draws L3 for every slot), until each new
    // moment of the dial's pair is sharp for the view (the magnifier's share of the view's L3 cells; for the new
    // dominant one also the panorama tiles it is drawn from beside them), then crossfades as the room does (up to
    // 2.5 s; 300 ms while the dial still moves). A moment already on screen needs nothing new. After HOLD_MAX_MS (a
    // stalled connection) it goes ahead on the whole-band tiles alone, as before.
    // With few slots (phones: the magnifier's share of them too) a change goes to the dial's nearer moment alone first,
    // then to its pair, so no more than three moments need the sharp tiles at once.
    const sharp = !!zoom?.sharp();
    const onScreen = (id) => slotIds.some((s, i) => s === id && weights[i] > 0);
    const nearW = want.t < 0.5 ? want.a : want.b;
    const goal = sharp && fewSlots() && !onScreen(nearW.id) ? { a: nearW, b: nearW, t: 0 } : want;
    incoming = sharp ? [goal.a, ...(goal.t > 0 && goal.b !== goal.a ? [goal.b] : [])].map((f) => f.id).filter((id) => !onScreen(id)) : [];
    incomingDom = incoming.includes(nearW.id) ? nearW.id : null;
    const holdKey = incoming.join("|");
    if (!holdKey) holdFor = null;
    else if (holdFor?.ids !== holdKey) holdFor = { ids: holdKey, since: now };
    const stalled = !!holdFor && now - holdFor.since > HOLD_MAX_MS;
    const sharpOk = (id) => momentReady(id) && (!sharp || stalled || onScreen(id) ||
      (incoming.includes(id) && zoom.ready(id) && (id !== incomingDom || baseOk.get(id) === true)));
    if (want.a.id !== pair.a.id || want.b.id !== pair.b.id || Math.abs(want.t - pair.t) > 1e-6) {
      if (tileW < 1) {
        // stage 1 (the photograph's exterior): as before, the pair follows at once
        if ((momentReady(want.a.id) && (want.t === 0 || momentReady(want.b.id))) || !ext) pair = { a: want.a, b: want.b, t: want.t };
      } else if (!prev) {
        // (DYS-251: a chosen time waiting with the city keeps the old picture too, until the dial's moments are in, then
        // one dissolve: not by the moment in nearest the dial's first, a third time of day on screen with the city at
        // neither. Its nearer moment alone once TANDEM_PAIR_MS have passed without its partner. A dragged dial as before:
        // not 'moving', which a single tap is too for DIAL_MOVING_MS)
        const target = tand && !tand.fade && !tand.drag ? tandemTarget(goal, sharpOk, now) : drawable(goal, moving, sharpOk);
        if (target) {
          const d = distPair(pair, target);
          const slow = Math.min(2500, Math.max(450, d * 2500 * 1.4));
          if (d > 0.03) prev = { ...pair, start: now, dur: reduced() ? 150 : moving ? DIAL_FADE_MS : sharp ? slow : chosen() ? Math.min(DIAL_REST_FADE_MS, slow) : slow };
          pair = target;
        }
      }
    }
    // DYS-251: a chosen time waits for the picture: it goes with the first fade that brings the dial's nearer moment on
    // screen; with none to go with (the moments on screen already the dial's, a change too small to fade, the first
    // paint's stage) it dissolves on its own over TANDEM_OWN_MS, as it does when the picture has waited past the
    // magnifier's own limit
    if (tand && !tand.fade) {
      if (pair.a === nearW || pair.b === nearW) tand.fade = prev && prev.start >= tand.since ? prev : { start: now, dur: TANDEM_OWN_MS };
      else if (now - tand.since > HOLD_MAX_MS + 2000) tand.fade = { start: now, dur: TANDEM_OWN_MS };
    }
    tk = tandemAt(now);
    if (tand?.fade && tk.p >= 1) { tand = null; tk = tandemAt(now); }
    const out = prev ? 1 - smooth01((now - prev.start) / prev.dur) : 0;
    if (prev && out <= 0) prev = null;
    // shader slots: the pair's nearer moment first (it gets L0), then its partner, then a pair fading out
    const dom = pair.t < 0.5 ? pair.a : pair.b, oth = pair.t < 0.5 ? pair.b : pair.a;
    const wDom = pair.a === pair.b ? 1 : (pair.t < 0.5 ? 1 - pair.t : pair.t);
    const ids = [dom.id, oth.id !== dom.id ? oth.id : null, null, null];
    const ws = [wDom * (1 - out), ids[1] ? (1 - wDom) * (1 - out) : 0, 0, 0];
    if (prev) {
      const pd = prev.t < 0.5 ? prev.a : prev.b, po = prev.t < 0.5 ? prev.b : prev.a;
      const pw = prev.a === prev.b ? 1 : (prev.t < 0.5 ? 1 - prev.t : prev.t);
      const put = (id, w) => { const i = ids.indexOf(id); if (i >= 0) ws[i] += w; else { const j = ids.indexOf(null, 1); if (j >= 0) { ids[j] = id; ws[j] = w; } } };
      put(pd.id, pw * out);
      if (po.id !== pd.id) put(po.id, (1 - pw) * out);
    }
    slotIds = ids; weights = ws;
    want0 = want;

    // ---- the moment's conditions, the city
    env = environment();
    // (DYS-149 warm-frame: the first frame after primeCity, the warm-up's hidden one, takes the state it worked out a task
    // before, when within PRIME_MS and PRIME_S of it (a clock set between them, or a slow page, has it work its own out):
    // the city some 0.1 s earlier, in a frame never shown. Every other frame works its own out, as before)
    const pc = primed;
    primed = null;
    const sHold = carsHeld(performance.now(), now);   // (DYS-149 SL2: every frame, the primed one's too: its gap counts)
    const Tc = T + tk.off;   // (DYS-251: the city's time: the one on screen while a chosen one waits for the picture)
    cityState = pc && performance.now() - pc.at < PRIME_MS && Math.abs(Tc - pc.T) < PRIME_S ? pc.state : city.state(Tc, { sessionStart: T0, streetsHold: sHold, lampAlt: LAMP_ALT });
    // (DYS-251: in a tandem dissolve the light layers' lamps and windows at their own time, from the old to the new by
    // the picture's share; each shown moment's windows_extra at its own: the old moments' at the old time, the new's at
    // the new)
    lightsAt = null;
    let hrOld = null, hrNew = null;
    if (tand?.fade) {
      lightsT = lerp(T + tand.off, T, tk.p);
      lightsAt = city.windows.at(lightsT, clockAt(lightsT, cityState.clock.fog), LAMP_ALT);
      hrOld = clockAt(T + tand.off).hour; hrNew = clockAt(T).hour;
    }
    // windows_extra: each shown moment's dial x its gain (0 for a moment without the group: nothing of it fetched or
    // drawn)
    const hr = cityState.clock?.hour ?? 0;
    const hrOf = (id) => (hrNew === null ? hr : id === pair.a.id || id === pair.b.id ? hrNew : hrOld);
    wxDials = slotIds.map((id) => (id && (hasExtra(meta, id, "lights") || hasExtra(meta, id, "NB"))
      ? (wxHold !== null ? Math.max(0, wxHold) : windowsExtraDial(id, hrOf(id))) * wxGain(id) : 0));
    if (drawnOnce && gateStart === null) gateStart = now;
    const ramp = gateStart === null ? 0 : smooth01((now - gateStart) / FX_FADE_MS);
    // the living effects: off on the canvas's first frame (it matches the page), then easing in; off under reduced
    // motion (synthesize plan 2.2). The city's events ease in the same way, and stay (still) under reduced motion.
    fxW = opts.fx === 0 || reduced() ? 0 : ramp;
    evW = (opts.fx === 0 ? 0 : reduced() ? 1 : ramp) * tk.k;   // (DYS-251: through the tandem dissolve, out and in)
    lastFrame = frame;
    perf.updateMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- the warm-up's own steps (DYS-149 warm-frame)
  // pass.warmSteps(): the engine's warm-up runs each in a task of its own just before its hidden frame (engine.js warmUp),
  // so that frame only draws. warmPrograms: every program's link asked after (with KHR_parallel_shader_compile a program
  // still linking is not waited for: the frame asks again, as before) and, once linked, its uniforms looked up and its
  // fixed ones set (panoFixed): the bt1-1521 hidden frames spent 4-6 ms in prog.check (GL queries answered by the GPU
  // process: getProgramParameter, getActiveUniform, getUniformLocation) and 2-4 ms in panoUniforms. It leaves a program
  // bound: the engine resets three.js's state after a raw pass's step
  function warmPrograms() {
    for (const p of Object.values(P)) p.check();
    for (const p of [P.back, P.pts, P.hull, P.car3d]) if (p.ok && !p.fixed) { gl.useProgram(p.p); panoFixed(p); }
  }
  // primeCity: the city's state for the hidden frame, which update() takes (pure computation, city.js state(): its first
  // call 76-99 ms of that frame on the barely-sufficient laptop, its code and tables cold; a later frame's 5-13 ms)
  function primeCity() {
    const T = holdT ?? clock.T();
    primed = { T, state: city.state(T, { sessionStart: T0, streetsHold: carsHeld(performance.now()), lampAlt: LAMP_ALT }), at: performance.now() };
  }

  // ---------------------------------------------------------------- per frame, the camera's part (inside render)
  function prepare(frame) {
    const t0 = performance.now();
    const now = frame.time, dt = frameDt;
    camInfo = cameraFor(frame);
    // (the pose as text only until the camera first moves: "moved" never goes back; perf #13)
    const fcam = frame.outside || frame.camera;
    const pose = moved ? null : JSON.stringify([fcam.position, fcam.quaternion, fcam.fovY]);
    if (!firstPose) firstPose = pose;
    const want = want0;
    const dom = pair.t < 0.5 ? pair.a : pair.b, oth = pair.t < 0.5 ? pair.b : pair.a;
    const ws = weights;

    // ---- what the camera sees through the window
    const rect = frame.window.rect;
    if (rect[2] > 0 && rect[3] > 0) {
      // the directions seen through the glass (rays that meet the wall around it don't count), from the room camera's
      // eye; the sway's few centimetres are inside the margin (v3/zoom-r3: with the room fading, every ray on the screen)
      const through = (frame.roomW ?? 1) < 1 ? null : throughWindow(frame.camera.position, frame.window.corners);
      const vr = viewRange(camInfo.rayAt, rect, frame.width, frame.height, 12, through);
      const o = Math.hypot(...camInfo.eye);
      const margin = clamp(o / 20 / DEG + 1.5, 2, 7);
      if (vr) { visible = vr; cols = columnsFor(meta, vr.yaw, margin); visible.margin = margin; }
      else { visible = { yaw: [0, 0], el: [0, 0], none: true }; cols = []; }
    }
    const needSky = visible.el[1] > meta.bands.city.el[1] - 1.5, needCity = visible.el[0] < meta.bands.city.el[1] + 1.5;
    const farEl = meta.layers?.far?.el;
    const needFar = TWO && farEl && visible.el[0] < farEl[1] + 1.5;
    const wantL0 = (frame.dpr >= 1.5 || !!zoom?.wantL0()) && (store.slotsOf.L0c || 0) > 0 && !opts.noL0;
    const list = [];
    const drawn = [dom.id, oth.id];
    const nextIds = [want.a.id, want.b.id].filter((id) => !drawn.includes(id));
    // the whole-band tiles (L2, clouds, the far layer's L2) of at most as many moments as each kind has slots: the
    // incoming pair first (it must be able to load, or the outside could never switch to it), then the pair on screen,
    // then a pair fading out. A moment left out is drawn by the dominant one until it is back (panoUniforms).
    const wDom = want.t < 0.5 ? want.a : want.b, wOth = want.t < 0.5 ? want.b : want.a;
    // v3/dial-smooth: every moment on screen keeps its slots first (the heavier first), then the dial's: a moment still
    // fading never loses its whole-band tiles mid-fade (its share used to jump to the dominant one: a cut), and update()
    // only switches once the screen is down to what leaves the dial's moment a slot
    const onScreen = slotIds.map((id, i) => [id, weights[i]]).filter(([id, w]) => id && w > 0).sort((p, q) => q[1] - p[1]).map(([id]) => id);
    // ... and while the dial moves, the next moments in its direction take any slot left (fetched before it gets there)
    const next = chosen() && now - wantMovedAt < 2 * DIAL_MOVING_MS ? ahead(wDom, dialDir, 2).map((f) => f.id) : [];
    const order = [...new Set([...onScreen, dom.id, wDom.id, ...(want.t > 0 ? [wOth.id] : []), ...next])];
    for (const k of ["L2c", "L2s", "clouds", "F2"]) for (const id of order.slice(0, store.slotsOf[k] || 0)) list.push([id, k, 0]);
    // phones (T1): the blend partner and any pair fading out draw from L2 alone (plan 8.2)
    for (const id of [...new Set(tier === "T1" ? [dom.id] : drawn)]) {
      for (const c of cols) {
        if (needCity) list.push([id, "L1c", c]);
        if (needSky && skyL1(id)) list.push([id, "L1s", c]);
        if (needFar) list.push([id, "F1", c]);
        if (env?.night > 0.02 || (byId.get(id)?.night || 0) > 0) list.push([id, "lights", c]);
      }
    }
    if (wantL0 && needCity) for (const c of cols) list.push([dom.id, "L0c", c]);
    // windows_extra: only for a shown moment whose dial is above 0 (at 0 none of its tiles is asked for); the lights
    // array makes room for them the first time (no tile of the base group gives up its slot)
    const wxOf = (id) => wxDials[slotIds.indexOf(id)] || 0;
    const wxIds = [...new Set(tier === "T1" ? [dom.id] : drawn)].filter((id) => wxOf(id) > 0);
    const lx = wxIds.filter((id) => hasExtra(meta, id, "lights") && (env?.night > 0.02 || (byId.get(id)?.night || 0) > 0));
    if (needCity && lx.length) {
      store.reserve("lights", (SLOTS0.lights || 0) + (EXTRA.slots[store.tier]?.lights || 0));
      wxSeen.lights = true;
      for (const id of lx) for (const c of cols) list.push([id, "lights", EXTRA.lightsCol + c]);
    }
    if (tier !== "T1") for (const id of nextIds) for (const c of cols) { if (needCity) list.push([id, "L1c", c]); if (needSky && skyL1(id)) list.push([id, "L1s", c]); }
    // the rendered near layer (park round 2, layers.near2), where the window sees below its top: its depth first (one
    // set for every moment), the dominant moment's front (L1; L0 on a dense screen as the city's), its back layer, then
    // the partner's front. Never part of the stage-1 readiness: the panorama's own pixels show until they are in.
    const near2 = meta.layers?.near2;
    if (near2 && meta.geo.size.NB && !noNear && visible.el[0] < near2.el[1] + 1.5) {
      for (const c of cols) list.push([NEAR_DEPTH, "NB", 14 + c]);
      for (const c of cols) list.push([dom.id, "NB", c]);
      if (wantL0 && (store.slotsOf.N0 || 0) > 0) for (const c of cols) list.push([dom.id, "N0", c]);
      if (tier !== "T1") {
        for (const c of cols) list.push([dom.id, "NB", 7 + c]);
        if (ws[1] > 0) for (const c of cols) list.push([oth.id, "NB", c]);
      }
      // windows_extra over the front (dominant moment; its partner too off phones), only while its dial is above 0
      const nx = [dom.id, ...(tier !== "T1" && ws[1] > 0 ? [oth.id] : [])].filter((id) => wxOf(id) > 0 && hasExtra(meta, id, "NB"));
      if (nx.length) {
        store.reserve("NB", (SLOTS0.NB || 0) + (EXTRA.slots[store.tier]?.NB || 0));
        wxSeen.near = true;
        for (const id of nx) for (const c of cols) list.push([id, "NB", EXTRA.nearCol + c]);
      }
    }
    // v3/zoom-sharp: the new dominant moment a magnified change waits for: its panorama tiles for this view as the
    // dominant moment draws them, after everything on screen (its whole-band tiles are in the list already: the dial's
    // moment); L0 (and the near layer's L0) only where the array holds both moments' columns. Whether they are all in
    // (or given up) is its baseOk.
    if (incomingDom) {
      const inc = incomingDom, incList = [];
      for (const c of cols) {
        if (needCity) incList.push([inc, "L1c", c]);
        if (needSky && skyL1(inc)) incList.push([inc, "L1s", c]);
        if (needFar) incList.push([inc, "F1", c]);
        if ((byId.get(inc)?.night || 0) > 0) incList.push([inc, "lights", c]);
      }
      if (wantL0 && needCity && (store.slotsOf.L0c || 0) >= 2 * cols.length) for (const c of cols) incList.push([inc, "L0c", c]);
      if (near2 && meta.geo.size.NB && !noNear && visible.el[0] < near2.el[1] + 1.5) {
        for (const c of cols) incList.push([inc, "NB", c]);
        if (wantL0 && (store.slotsOf.N0 || 0) >= 2 * cols.length) for (const c of cols) incList.push([inc, "N0", c]);
      }
      list.push(...incList);
      baseOk.clear();
      baseOk.set(inc, incList.every((t) => store.allResident([t]) || store.failed.has(store.key(...t))));
    }
    if (tilesHeld && (stage1Failed || tileW >= 1)) { tilesHeld = false; tilesOpen(); }   // (HT1: no stage 1 to hold: tiles now)
    if (!tilesHeld) store.want(list, now);   // (HT1: none asked for while held, tilesGo)
    if (!tilesHeld && ltAt === undefined) ltAt = now;
    // ... and, at rest, the shown moment's neighbours in the day (the magnifier prefetches their cells of the view and
    // asks warm() for their panorama tiles)
    const fw = ahead(dom, 1, 2), bw = ahead(dom, -1, 2);   // (in the order +1, -1, +2, -2)
    const nbrs = zoom?.sharp() ? [fw[0], bw[0], fw[1], bw[1]].filter(Boolean).map((f) => f.id).filter((id, i, a) => a.indexOf(id) === i && !incoming.includes(id) && !drawn.includes(id)) : [];
    lastNeeds = { cols, needCity, needSky, needFar, near2: !!(near2 && meta.geo.size.NB && !noNear && visible.el[0] < near2.el[1] + 1.5), wantL0 };
    zoom?.want(frame, { visible, dom: dom.id, weights: ws, cam: camInfo, needCity, slots: slotIds, pair: [pair.a.id, pair.b.id], incoming, next: nbrs });

    // ---- stage 1 -> tiles
    const tileList = list.filter(([id, k, c]) => k !== "N0" && k !== "NB" && (drawn.includes(id) && (k !== "L0c" || wantL0) && k !== "lights" || (k === "lights" && c < EXTRA.lightsCol && drawn.includes(id))));
    const tilesReady = store.auxState === "ready" && momentReady(dom.id) && (!ws[1] || momentReady(oth.id)) && store.allResident(tileList);
    if (pose !== firstPose) moved = true;
    if (tileW < 1 && !opts.holdStage1 && !(hold && !moved)) {
      if (stage1Failed || (!ext && !extJob && tilesReady)) tileW = tilesReady ? 1 : 0;
      else if (tilesReady && moved && moveFade && !hold) {
        if (movedAt === null) { movedAt = now; movedFrom = tileW; }
        tileW = reduced() ? 1 : Math.max(tileW, movedFrom + (1 - movedFrom) * smooth01((now - movedAt) / moveFade));
      }
      else if (tilesReady && moved) tileW = 1;
      else if (tilesReady && !tileFade) tileFade = now;
      if (tileFade !== null && tileW < 1 && movedAt === null) tileW = reduced() ? 1 : smooth01((now - tileFade) / fadeMs);
    }
    if (tileW >= 1 && released.length) for (const r of released.splice(0)) r();

    // ---- the clouds' travel, the city's events on screen
    const cssPerDeg = camInfo.pxPerRad * DEG / frame.dpr;
    const speed = Math.max((Math.abs(env.cloudDx) * EXT_DEG_WIDTH) / 60, 0.9 / Math.max(cssPerDeg, 1));
    if (tileW >= 1 && !reduced()) travel += speed * dt;
    // (the 3D vehicles' weight: 0 until their meshes are on the GPU, then up over MESH_FADE_MS)
    if (meshGL && meshReadyAt === null) meshReadyAt = now;
    const meshW = meshGL ? (reduced() ? 1 : smooth01((now - meshReadyAt) / MESH_FADE_MS)) : 0;
    // (DYS-149 TU2: none until the occluders' L0 is on the GPU, or they failed: a car is never cut by the coarser test)
    const streetsW = streetsSince === null || (!occl.l0 && !occl.failed) || carsGo === null ? 0 : reduced() ? 1 : smooth01((performance.now() - Math.max(streetsSince, carsGo)) / STREETS_FADE_MS);
    // (DYS-204: the signals' heads, asked for the first time a night-light moment shows with the streets in)
    if (SIGNALS_ON && !sigAsked && city.streets && (cityState.moment?.mode?.lights ?? cityState.lighting?.night ?? 0) > 0) {
      sigAsked = true;
      fetch(new URL("./city/signals.json", import.meta.url)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => { if (sigGone) return; events.setSignals(d, city.streets, city.frame, { lift: routes.streets?.lift_m ?? 0.9, haze: city.lighting?.haze || null }); sigAt = performance.now(); engine.requestFrame(); })
        .catch((e) => console.warn("[outside] signals:", e.message));
    }
    const signalsW = sigAt === null ? 0 : reduced() ? 1 : smooth01((performance.now() - sigAt) / SIGNALS_FADE_MS);
    shipDetail?.update(zoom ? zoom.mag() : 1);   // (DYS-232: the first magnification past ~2x asks for the sharp ships)
    events.fill(cityState, { cam: camInfo, stats: env, meshW, streetsW, signalsW, gull3d: !!gullR?.ready() });
    if (tlog) tlog.w = [meshW, streetsW];
    perf.cpuMs = perf.cpuMs * 0.9 + (perf.updateMs + performance.now() - t0) * 0.1;
  }

  // ---------------------------------------------------------------- per frame, GPU
  const ARRAY_LIST = Object.entries(ARRAYS);   // (gc-diet: made once)
  const bind2 = (name, t) => { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t || dummy2d); };
  function bindAll(frame) {
    if (GC_DIET) {
      // (DYS-149 gc-diet: the same binds in the same order, with no object or entries made)
      for (let i = 0; i < ARRAY_LIST.length; i++) {
        const name = ARRAY_LIST[i][0], kind = ARRAY_LIST[i][1];
        gl.activeTexture(gl.TEXTURE0 + UNITS[name]);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, store.arrays[kind]?.tex || dummyArr);
      }
      bind2("uMask", store.aux?.mask); bind2("uDepth", store.aux?.depth); bind2("uRoom", roomTexture(frame)); bind2("uExtA", ext?.a);
      bind2("uExtB", ext?.b || ext?.a); bind2("uAlb", alb); bind2("uNrm", nrm); bind2("uNgt", ngt); bind2("uOcc0", occl.l0); bind2("uOcc3", occl.atlas?.tex);
      return;
    }
    for (const [name, kind] of Object.entries(ARRAYS)) {
      gl.activeTexture(gl.TEXTURE0 + UNITS[name]);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, store.arrays[kind]?.tex || dummyArr);
    }
    const two = { uMask: store.aux?.mask, uDepth: store.aux?.depth, uRoom: roomTexture(frame), uExtA: ext?.a, uExtB: ext?.b || ext?.a, uAlb: alb, uNrm: nrm, uNgt: ngt, uOcc0: occl.l0, uOcc3: occl.atlas?.tex };
    for (const [name, t] of Object.entries(two)) { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t || dummy2d); }
  }

  // (DYS-149 warm-frame: a program's uniforms that never change, the panorama's geometry, its layers' sizes and levels,
  // the eye's height, the far and near layers' bands, set once (warmPrograms, else its first draw), not at every draw: a
  // program keeps its uniforms' values. The program in use. ?warmsplit=0: at every draw, as before)
  function panoFixed(prog) {
    const u = prog.u, S = meta.geo.size;
    const set4 = (k, a) => u[k] && gl.uniform4f(u[k], a[0], a[1], a[2], a[3]);
    set4("uPano", [meta.yaw[0], meta.column_deg, meta.columns, meta.gutter]);
    set4("uBand", [meta.bands.city.el[0], meta.bands.city.el[1], meta.bands.sky.el[1], meta.aux.ppd]);
    if (u.uPpd) gl.uniform3f(u.uPpd, meta.bands.city.levels.L0 || 64, meta.bands.city.levels.L1, meta.bands.city.levels.L2);
    set4("uSizeL0", [...(S.L0c || [1, 1]), 1, 1]);
    set4("uSizeL1", [...S.L1c, ...S.L1s]);
    set4("uSizeL2", [...S.L2c, ...S.L2s]);
    set4("uSizeX", [...(S.lights || [1, 1]), ...(S.clouds || [1, 1])]);
    if (u.uEyeH) gl.uniform1f(u.uEyeH, EYE_H);
    const far = meta.layers?.far;
    if (far && u.uFarEl) {
      gl.uniform2f(u.uFarEl, far.el[0], far.el[1]);
      gl.uniform2f(u.uFarPpd, far.levels.L1 || far.levels.L2, far.levels.L2);
      gl.uniform4f(u.uSizeF, ...(S.F1 || S.F2), ...S.F2);
    }
    const near2 = meta.layers?.near2;
    if (near2 && S.NB && u.uNearEl) {
      gl.uniform2f(u.uNearEl, near2.el[0], near2.el[1]);
      gl.uniform2f(u.uNearPpd, near2.levels.L0 || near2.levels.L1, near2.levels.L1);
      gl.uniform4f(u.uSizeN, ...(S.N0 || [1, 1]), ...S.NB);
      const dm = near2.depth?.depth_m || [2, 2000];
      gl.uniform2f(u.uNearDepth, dm[0], dm[1]);
    }
    prog.fixed = warmSplit;
  }

  // (DYS-149 mt-diet) The panorama's per-frame uniforms, worked out once a frame (panoValues: the slot tables, 4 x 28 +
  // 3 x 8 ints from the tile store, the weights, the camera, the occluders, kept with the frame's camera, camInfo, which
  // prepare() makes anew each frame; the tile store and the camera don't change between the frame's draws), not at each
  // of the ~6 programs' uses (the backdrop, the hulls twice, the vehicles' layers, the points); and each program sent
  // only the values that differ from what it was last sent (prog.panoSent: a program keeps its uniforms' values, and
  // only this function sets these), so a settled store and a still camera send none of the ~45 calls a use made.
  // uOcc3S / uOcc3T are sent at every use as before (the vehicles' draws set them per vehicle, occl3For). ?mtdiet=0:
  // all worked out and sent at every use, as before
  const PANO_DIET = urlQ.get("mtdiet") !== "0";
  // (DYS-149 gc-diet: the per-frame garbage of the draws taken out where it is made for every vehicle or every frame:
  // the 3D vehicles' corners, boxes and instance records written through arrays kept for it (drawCars3d, offWindow,
  // carsInstanced), the erasers' cells by a number not a string, the halo's corners, the texture binds. The same numbers
  // and the same GL calls. ?gcdiet=0: as before)
  const GC_DIET = urlQ.get("gcdiet") !== "0";
  let panoPack = null;
  function panoValues() {
    if (PANO_DIET && panoPack && panoPack.cam === camInfo) return panoPack;
    const S = meta.geo.size, v = { cam: camInfo };
    const slot = (id, kind, c) => (id ? store.slot(id, kind, c) : -1);
    v.uAuxSize = store.aux?.size || [1, 1];
    v.uAuxOn = [store.aux ? 1 : 0];
    const l0 = new Int32Array(8).fill(-1);
    for (let c = 0; c < meta.columns; c++) l0[c] = slot(slotIds[0], "L0c", c);
    v.uSlotL0 = l0;
    for (const [name, kind] of [["uSlotL1c", "L1c"], ["uSlotL1s", "L1s"], ["uSlotLt", "lights"], ["uSlotF1", "F1"]]) {
      const a = new Int32Array(28).fill(-1);
      for (let c = 0; c < meta.columns; c++) for (let m = 0; m < MAX_MOMENTS; m++) a[c * 4 + m] = slot(slotIds[m], kind, c);
      v[name] = a;
    }
    for (const [name, kind] of [["uSlotL2c", "L2c"], ["uSlotL2s", "L2s"], ["uSlotCl", "clouds"], ["uSlotF2", "F2"]]) v[name] = slotIds.map((id) => slot(id, kind, 0));
    // a moment whose whole-band tiles aren't resident can't be drawn: its share goes to the dominant moment
    const w = weights.slice();
    for (let m = 1; m < 4; m++) if (w[m] > 0 && !(slotIds[m] && momentReady(slotIds[m]))) { w[0] += w[m]; w[m] = 0; }
    v.uW = w;
    // the live camera, for every program (the sprites look along their own pixels' rays to find what hides them)
    v.uViewport = [0, 0, camInfo.width, camInfo.height];
    // the street traffic's occluders (L0 here; L3 per vehicle, drawCarGroup)
    const m = occl.meta, on = m && occl.l0 && !(urlQ.get("occl") === "0");
    // (worked out for every program now, so read with ?. where only a program with uOccH read it)
    v.uOccG = [m?.l0?.yaw0 || 0, m?.l0?.el_top || 0, m?.l0?.ppd || 64, m?.l0?.block?.[0] || 1];
    v.uOccH = [m?.l0?.block?.[1] || 1, on ? 1 : 0, OCCL_GROUND_M, OCCL_NEAR_M];
    v.uOcc3G = [m?.l3?.yaw0 || 0, m?.l3?.el_top || 0, m?.l3?.tile_px || 256, OCCL_SPR];
    v.uRayM = camInfo.rayM;
    // (v3/zoom: magnified, the parallax eases off, eyeK -> 0: the magnified view is the panorama's own pixels)
    const k = zoom ? zoom.eyeK() : 1;
    v.uEye = [camInfo.eye[0] * k, camInfo.eye[1] * k, camInfo.eye[2] * k];
    // (DYS-149 window-cost: on only where the magnifier took the parallax off (k 0), so a camera at the panorama's own
    // eye at 1x (the photograph's pose, the hand-off) draws as before; QA's run-time switch; EYE_FAST's programs only)
    v.uEyeFast = [k === 0 && globalThis.__eyeFast !== 0 ? 1 : 0];
    // the two-layer panorama
    const far = meta.layers?.far;
    v.uTwo = [TWO && far && store.aux ? 1 : 0];
    // (its bands and sizes: panoFixed)
    // the rendered near layer (park round 2): N0 for the dominant moment, NB's front / back per moment, its depth
    const near2 = meta.layers?.near2;
    v.near = !!(near2 && S.NB);
    v.uNear2 = [near2 && S.NB && !noNear ? 1 : 0];
    if (v.near) {
      // (its band, levels, sizes and depth range: panoFixed)
      const n0 = new Int32Array(8).fill(-1), nd = new Int32Array(8).fill(-1);
      for (let c = 0; c < meta.columns; c++) { n0[c] = slot(slotIds[0], "N0", c); nd[c] = store.slot(NEAR_DEPTH, "NB", 14 + c); }
      v.uSlotN0 = n0; v.uSlotND = nd;
      for (const [name, off] of [["uSlotNF", 0], ["uSlotNK", 7]]) {
        const a = new Int32Array(28).fill(-1);
        for (let c = 0; c < meta.columns; c++) for (let mm = 0; mm < MAX_MOMENTS; mm++) a[c * 4 + mm] = slot(slotIds[mm], "NB", off + c);
        v[name] = a;
      }
    }
    panoPack = v;
    return v;
  }
  // one uniform of the program in use: sent unless the program was last sent these very values (Object.is: -0 and NaN
  // as they are); its copy kept in place
  function panoSet(prog, name, v, send) {
    const loc = prog.u[name];
    if (!loc) return;
    if (PANO_DIET) {
      if (prog.panoFor !== prog.p) { prog.panoFor = prog.p; prog.panoSent = {}; }   // (a program linked anew: none held)
      let was = prog.panoSent[name];
      if (was && was.length === v.length) {
        let i = 0;
        while (i < v.length && Object.is(was[i], v[i])) i++;
        if (i === v.length) return;
      } else was = prog.panoSent[name] = new Float64Array(v.length);
      for (let i = 0; i < v.length; i++) was[i] = v[i];
    }
    send(loc, v);
  }
  const f1 = (l, a) => gl.uniform1f(l, a[0]), f2 = (l, a) => gl.uniform2f(l, a[0], a[1]), f3 = (l, a) => gl.uniform3f(l, a[0], a[1], a[2]);
  const f4 = (l, a) => gl.uniform4f(l, a[0], a[1], a[2], a[3]), i4 = (l, a) => gl.uniform4i(l, a[0], a[1], a[2], a[3]);
  const i4v = (l, a) => gl.uniform4iv(l, a), m4 = (l, a) => gl.uniformMatrix4fv(l, false, a);

  function panoUniforms(prog) {
    const u = prog.u;
    if (!prog.fixed) panoFixed(prog);
    const v = panoValues();
    panoSet(prog, "uAuxSize", v.uAuxSize, f2);
    panoSet(prog, "uAuxOn", v.uAuxOn, f1);
    panoSet(prog, "uSlotL0", v.uSlotL0, i4v);
    for (const name of ["uSlotL1c", "uSlotL1s", "uSlotLt", "uSlotF1"]) panoSet(prog, name, v[name], i4v);
    for (const name of ["uSlotL2c", "uSlotL2s", "uSlotCl", "uSlotF2"]) panoSet(prog, name, v[name], i4);
    panoSet(prog, "uW", v.uW, f4);
    panoSet(prog, "uViewport", v.uViewport, f4);
    if (u.uOccH) {
      panoSet(prog, "uOccG", v.uOccG, f4);
      panoSet(prog, "uOccH", v.uOccH, f4);
      panoSet(prog, "uOcc3G", v.uOcc3G, f4);
      if (u.uOcc3S) gl.uniform4i(u.uOcc3S, -1, -1, -1, -1);
      if (u.uOcc3T) gl.uniform2i(u.uOcc3T, 0, 0);
    }
    panoSet(prog, "uRayM", v.uRayM, m4);
    panoSet(prog, "uEye", v.uEye, f3);
    panoSet(prog, "uEyeFast", v.uEyeFast, f1);
    panoSet(prog, "uTwo", v.uTwo, f1);
    panoSet(prog, "uNear2", v.uNear2, f1);
    if (v.near && u.uNearEl) {
      panoSet(prog, "uSlotN0", v.uSlotN0, i4v);
      panoSet(prog, "uSlotND", v.uSlotND, i4v);
      panoSet(prog, "uSlotNF", v.uSlotNF, i4v);
      panoSet(prog, "uSlotNK", v.uSlotNK, i4v);
    }
  }

  // the street lamps of the light layers (outside.glsl.js LAMPS_GLSL), for the backdrop and the street vehicles (DYS-134:
  // their lamp light is the lamp layer on the road under them, read as the backdrop reads it): the gate (uLtOn.w: 0 as
  // baked, 1 by the clock), the lamps' clock, their tints. Returns the shown moment's lights entry and its tints (and
  // uLtOn as sent, its lamps_na entry: drawCarGroup's gates).
  function lampUniforms(u, frame) {
    const Lm = lightsAt ? lightsAt.lamps : cityState.lamps, T = lightsAt ? lightsT : cityState.T;   // (DYS-251: update())
    const lt = meta.moments[slotIds[0]]?.lights || meta.moments[slotIds[1]]?.lights;
    const g0 = ltAt === null ? gateStart : ltAt ?? null;   // (HT1: from the tiles' go, tilesGo)
    const gmix = opts.gateHold ? 0 : reduced() || opts.gateNow ? 1 : g0 === null ? 0 : smooth01((frame.time - g0) / GATE_FADE_MS);
    const ltOn = [1, Lm.share, Lm.flood, gmix];
    gl.uniform4f(u.uLtOn, ...ltOn);
    gl.uniform4f(u.uLamp, Lm.on - Lm.fog - T, Lm.off + Lm.fog - T, Lm.spread, LAMPS.fade);
    const tints = lt?.tints || { windows: [1, 0.85, 0.6], lamps: [1.3, 0.9, 0.5], flood: [1, 0.45, 0.3] };
    // DYS-134: a set whose lights carry lamps_na has the sodium lamps' part of G in its tiles' alpha (255 - A): G less it
    // takes the LEDs' tint, it its own (uLampNa.w 1); without lamps_na (w 0) G takes tints.lamps and the alpha is not read
    const na = lt?.lamps_na;
    gl.uniform3f(u.uTintL, ...(na?.tint_led || tints.lamps));
    if (u.uLampNa) gl.uniform4f(u.uLampNa, ...(na?.tint || [0, 0, 0]), na ? 1 : 0);
    return { lt, tints, ltOn, na };
  }

  function drawBackdrop(frame) {
    const prog = (zoom && tileW >= 1 && zoom.program(frame)) || P.back, u = prog.u, e = env;
    backL3 = prog !== P.back;
    gl.useProgram(prog.p);
    panoUniforms(prog);
    // (v3/zoom-r3: while the room fades the outside is drawn under all of it: the shader skips no pixel the room covers;
    // its coverage over a count this large reads as none)
    if (u.uRoomCount) gl.uniform1f(u.uRoomCount, (frame.roomW ?? 1) < 1 ? 1e9 : roomTexture(frame) ? Math.max(1, frame.room.count) : 0);
    gl.uniform1f(u.uLevelBias, opts.levelBias ?? 0);
    gl.uniform1f(u.uTime, reduced() ? 0 : simT);
    gl.uniform1f(u.uCss, frame.dpr);
    // stage 1
    gl.uniform1f(u.uTileW, ext ? tileW : 1);
    if (ext) gl.uniform2f(u.uExtMix, 1 - ext.t, ext.t);
    if (u.uExtCam && extCamMeta) gl.uniform4f(u.uExtCam, extCamMeta.heading - AXIS, extCamMeta.pitch, extCamMeta.focal_w, extCamMeta.ext_size[0] / extCamMeta.ext_size[1]);
    // clouds
    const C = meta.clouds;
    if (C && u.uCloud) {
      gl.uniform4f(u.uCloud, C.yaw[0], C.yaw[1], C.el[0], C.el[1]);
      gl.uniform4f(u.uCloudFmt, C.ppd, C.gutter ?? meta.gutter, C.wrap === "none" ? 0 : 1, 0);
      const sign = (e.cloudDx || 1) < 0 ? -1 : 1;
      const cp = copies(travel, opts.cloudRange ?? 40, 0.22, sign);
      gl.uniform4f(u.uCloudOff, cp[0], cp[1], cp[2], cp[3]);
      const rise = e.cloudDy !== null ? clamp(-e.cloudDy / Math.max(Math.abs(e.cloudDx), 1e-3), -0.2, 0.2) : 0.04;
      gl.uniform2f(u.uCloudRise, clamp(cp[0] * rise, -0.75, 0.75), clamp(cp[1] * rise, -0.75, 0.75));
    }
    // the moment
    const sunOn = smooth(-0.8, 0.6, e.alt) * (1 - e.night) * (1 - 0.7 * e.fog);
    gl.uniform4f(u.uMoment, e.night, e.fog, e.wind, sunOn);
    const rel = (e.az - AXIS) * DEG, ca = Math.cos(e.alt * DEG);
    gl.uniform4f(u.uSun, Math.sin(rel) * ca, Math.cos(rel) * ca, Math.sin(e.alt * DEG), smooth(-0.8, 0.6, e.alt) * (1 - e.night));
    gl.uniform3f(u.uSunCol, ...sunTint(e.alt));
    const U = 1.5 + 9 * e.wind;
    gl.uniform4f(u.uWind, e.windTo[0], e.windTo[1], U, 0.003 + 0.00512 * U);
    const cssPerDeg = camInfo.pxPerRad * DEG / frame.dpr;
    gl.uniform4f(u.uFogFlow, Math.max(0.06, 1.1 / Math.max(cssPerDeg, 1)), 9, 0.2, 0.42);
    gl.uniform2f(u.uGate, meta.gate?.[0] ?? -0.3, meta.gate?.[1] ?? -0.4);
    const nw = events.counts.wakes;
    gl.uniform1i(u.uBoats, nw);
    if (nw) { gl.uniform4fv(u.uBoatP, events.wakeP); gl.uniform4fv(u.uBoatQ, events.wakeQ); if (u.uBoatR) gl.uniform4fv(u.uBoatR, events.wakeR); }
    // (DYS-232 WATER: a boat's past path and odometer; not in the program with ?boatsfx=0)
    if (nw && u.uBoatS) { gl.uniform4fv(u.uBoatS, events.wakeS); gl.uniform4fv(u.uBoatT, events.wakeT); }
    gl.uniform3f(u.uFoam, e.white[0] * 0.92, e.white[1] * 0.92, e.white[2] * 0.92);
    if (u.uFoamSky) gl.uniform3f(u.uFoamSky, e.high[0] * 0.9, e.high[1] * 0.9, e.high[2] * 0.9);   // (DYS-232 ships, W1: wkShipFoamC)
    // light layers: the city clock's windows, lamps and floodlights
    const s = cityState, W = lightsAt ? lightsAt.windows : s.windows, T = lightsAt ? lightsT : s.T;   // (DYS-251: update())
    const { lt, tints } = lampUniforms(u, frame);
    const share = lt?.baked_share ?? 1;
    if (u.uWinE) {
      gl.uniform1f(u.uWinE, Math.min(1, W.E / share)); gl.uniform1f(u.uWinM, Math.min(1, W.M / share));
      gl.uniform1f(u.uWinFadeE, Math.max(1e-9, W.fadeE / share)); gl.uniform1f(u.uWinFadeM, Math.max(1e-9, W.fadeM / share));
      gl.uniform1f(u.uWinTvOn, W.tvOn); gl.uniform1f(u.uWinHn, W.hn); gl.uniform1f(u.uTvTick, Math.floor(T * 5) % 16777216);
      gl.uniform1ui(u.uWinNight, W.night >>> 0);
    }
    gl.uniform3f(u.uTintW, ...tints.windows); gl.uniform3f(u.uTintF, ...tints.flood);
    // windows_extra: off (uXOn 0, the shader as before) unless a shown moment's dial is above 0
    const xOn = wxDials.some((d, m) => d > 0 && weights[m] > 0);
    if (u.uXOn) gl.uniform1f(u.uXOn, xOn ? 1 : 0);
    if (xOn && u.uXDial) {
      gl.uniform4f(u.uXDial, ...wxDials);
      const lx = new Int32Array(28).fill(-1), nx = new Int32Array(28).fill(-1);
      for (let c = 0; c < meta.columns; c++) for (let m = 0; m < MAX_MOMENTS; m++) {
        const id = slotIds[m];
        if (!id || !(wxDials[m] > 0)) continue;
        lx[c * 4 + m] = store.slot(id, "lights", EXTRA.lightsCol + c);
        nx[c * 4 + m] = store.slot(id, "NB", EXTRA.nearCol + c);
      }
      if (u.uSlotLx) gl.uniform4iv(u.uSlotLx, lx);
      if (u.uSlotNX) gl.uniform4iv(u.uSlotNX, nx);
      const xl = meta.moments[slotIds[0]]?.lights?.extra || meta.moments[slotIds[1]]?.lights?.extra;
      if (u.uTintX) gl.uniform3f(u.uTintX, ...(xl?.tint || tints.windows));
    }
    gl.uniform1i(u.uDebug, debug);
    gl.uniform1f(u.uFx, fxW);
    // v3/zoom-sharp: magnified, the coarser levels through a cubic spline (0 at 1x: the picture as always)
    if (u.uSmooth) gl.uniform1f(u.uSmooth, zoom ? zoom.smooth() : 0);
    if (prog !== P.back) zoom.uniforms(prog, frame);
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- the street vehicles in 3D (v3/street-traffic rebuild): each mesh in the live camera, on its road, far to near,
  // into an offscreen layer over just their box (at up to 2x: CAR_LAYER_PX the most it holds), then averaged down
  // onto the window. Magnified, the camera's eye eases to the panorama's (eyeK) as the backdrop's does, so the road
  // under them is where the photograph has it.
  const CAR_LAYER_PX = tier === "T1" ? 1.2e6 : 4e6;
  const CAR_SOFT = 0.35;          // device px: the least blur of the layer onto the window
  // the photograph's own blur, in its px: its parked cars' edges are ~4.1 px wide in the L3 tiles at the median (2.4 at
  // the quarter), a Gaussian's sigma of ~1.5 (renders/stage-qa-d/look/measure_parked.py); ours is matched to it at the
  // picture's density on the screen (1.1, the lower range, left Greenwich at 2.5x crisper than its street)
  const PIC_SIGMA = 1.3;   // (B2 on round 1: Lombard's cars at the crisp end of real, Greenwich's already softer than any: between)
  const PANO_L0_PPD = 64;
  const CAR_SOFT_AT = 0.8;
  const CAR_LOD_PX = [48, 16];    // device px of a vehicle's box at or over which it takes LOD 0, LOD 1 (else LOD 2)        // the picture's density / the screen's below which a vehicle goes to the soft layer
  const CAR_CULL = urlQ.get("carcull") !== "0";   // DYS-111: a 3D vehicle wholly off the window is skipped (QA ?carcull=0: all drawn, as before)
  let lastLayer = null, carDebugInfo = null;
  // (DYS-149 gc-diet: kept for the draws below; each read at once, before the next use)
  const NONE = [], MM = new Float64Array(16), M16 = new Float64Array(16), ROT = [0, 0, 0, 0, 0, 0, 0, 0, 0], CAR = [0, 0, 0, 0], DIR = [0, 0, 0], LK = [0, 0, 0, 0];
  // (DYS-266 zoom-gc, ?gcdiet=0: as before) drawCars3d's vehicle records (each its model -> clip C and box) kept by number,
  // listed in kept sharp and soft lists; drawCarGroup's items and erasers kept the same way (groupItems); glintCar into a
  // kept pair; offWindow2's cast shadow into a kept record; occlSlot's least-recently-used list moved along in place (no
  // splice's new list). The same numbers in the same order
  const V3R = [], V3S = [], V3W = [], GIT = [], GER = [], GIL = [], GLK = [0, 0], CSW = { Ls: 0, ux: 0, uy: 0, eu: 0, ew: 0 };
  let giStamp = 0;
  const v3Rec = (k) => V3R[k] || (V3R[k] = { i: 0, C: new Float64Array(16), mir: 1, box: [0, 0, 0, 0], f: 0, ppd: 0 });
  const glintCar = (h1, h2) => {
    const o = GC_DIET ? GLK : [0, 0];
    o[0] = h1 < 0.15 ? 0.1 + (0.2 * h1) / 0.15 : h1 < 0.85 ? 0.6 + (0.35 * (h1 - 0.15)) / 0.7 : 1 + (0.15 * (h1 - 0.85)) / 0.15;
    o[1] = 0.5 + 0.4 * h2;
    return o;
  };
  // (key to the newest end of lru, from its place k: as lru.splice(k, 1) then lru.push(key))
  const lruTouch = (lru, k, key) => { const e = lru.length - 1; for (let q = k; q < e; q++) lru[q] = lru[q + 1]; lru[e] = key; };
  const SHA = [0, 0, 0, 0], SHC = [0, 0, 0, 0], QA = [0, 0, 0, 0], QB = [0, 0, 0, 0], shapes = new Map();
  const mul4 = (a, b, o = new Float64Array(16)) => {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  };
  const lin1 = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lin3 = (c) => c.map(lin1);
  const mvp32 = new Float32Array(16), rot32 = new Float32Array(9);
  // each kind of vehicle's shadow shape, from its length and beam: the cabin's half width (x the footprint's) and half
  // length (x its length), the cabin's centre (x its length, + forward), the body tier's share of its height, the
  // half wheelbase (x its length); the footprint is the body without its mirrors
  const SHADOW_SHAPES = [
    [/muni|bus|npr|box/, [1, 0.5, 0, 0.95, 0.3]],
    [/transit|van/, [0.95, 0.4, -0.05, 0.6, 0.31]],
    [/tacoma|pickup/, [0.88, 0.17, 0.05, 0.55, 0.3]],
    [/lyft|bike|moto|mt07/, [0.6, 0.25, 0, 0.55, 0.33]],
    [/modely|crv|suv/, [0.88, 0.32, -0.04, 0.55, 0.31]],
    [/./, [0.85, 0.27, -0.03, 0.5, 0.31]],
  ];
  const shadowShape = (name, kind) => SHADOW_SHAPES.find(([re]) => re.test(`${name} ${kind || ""}`))[1];
  // (DYS-149 gc-diet: by model, its kind with it: the same row, not up to 6 strings and tests a vehicle a frame)
  const shapeOf = (name, kind) => { let e = shapes.get(name); if (!e || e.kind !== kind) shapes.set(name, (e = { kind, s: shadowShape(name, kind) })); return e.s; };
  // DYS-104 (worker B 29 Oct): the moving cars' exposure and tint per moment, [gain, r, g, b] in linear light (the rgb
  // taken to luma 1, so the gain holds all the exposure). Measured on the judged candidate's 4x stills against the
  // photographed parked cars, as a change from midday's balance (the look passed there; renders/dys104-110321):
  // lowsun 17:48 too bright (0.47-0.68), blue 18:59 and night 21:37 too blue (b 0.68-0.84), their gains held (the
  // sources disagree). golden, sunset, dusk unmeasured: from their neighbours. Every other moment [1, 1, 1, 1].
  // ?cargrade=0: none (the before)
  // DYS-147 (worker B 30 Oct): night re-measured like-for-like, with the traffic judge's own capture rig (RM1,
  // renders/dys147/rm1-020238): the moving cars still ~2x too bright against the parked ones (gain 0.46, 68% 0.34-0.60)
  // and still a little blue (tint b 0.66). RM2 (renders/dys147/rm2-050502): a 0.5 gain moved the gain only 0.46 -> 0.51
  // (the grade reaches the bodies, not the lamp lenses and glow points, which carry about half the cars' light at
  // night), the blue cut b 0.66 -> 0.81. So the tint only (the coordinator's (2)): night [1, 1.02, 1, 0.76] ->
  // [1, 1.02, 1, 0.6]; night's brightness goes to the lamps (DYS-134). Only for a set whose lights carry no lamps_na:
  // with lamps_na (DYS-134, v3/lamps-carlight) a car at night takes the lamp pool it sits in, so that set's night keeps
  // the old grade (CAR_GRADE_NA) for DYS-134 to calibrate, and the two fixes don't stack. Which set: the shown moment's
  // lights, as the backdrop reads them.
  const CAR_GRADE = { golden: [0.78, 0.98, 1.01, 1.02], lowsun: [0.55, 0.95, 1.02, 1.04], sunset: [0.55, 0.95, 1.02, 1.04],
    dusk: [1, 0.93, 1.05, 0.8], blue: [1, 0.93, 1.05, 0.8], night: [1, 1.02, 1, 0.6] };
  const CAR_GRADE_NA = { ...CAR_GRADE, night: [1, 1.02, 1, 0.76] };
  // (DYS-134: with lamps_na the car at night takes the lamp pool's own light and colour (drawCarGroup, CAR3D_FS
  // lampsRoad), what night's tint stood in for; on round 4's stand-in the night grade on top took the moving cars' b / g
  // to ~0.40 against the photographed parked cars' 0.49 (0.52 without it), and on the real night lamp tiles (30 Oct,
  // carcal) to 0.43-0.46 against 0.50-0.53 without it. So with lamps_na night takes no tint; ?cargrade=1 takes
  // CAR_GRADE_NA's night (B's kept value, DYS-147) for the A/B. na: the caller's (drawCarGroup reads the set's lights);
  // else the shown moment's, as above.)
  // (... and blue and dusk the same (B's 13:10 review on DYS-134, item 2): with lamps_na the lamps are on at both (the
  // switch at -1.5 deg; dusk -3.6, blue -8.4) and the car takes the pool's light there too (their night 0.3 and 0.6,
  // over drawCarGroup's 0.02), so their blue cut (b 0.8) stacked on it as night's did. With lamps_na they take no tint
  // either; ?cargrade=1 takes CAR_GRADE_NA's blue and dusk (CAR_GRADE's) back. A set without lamps_na: as before)
  const NA_UNTINTED = new Set(["dusk", "blue", "night"]);
  const carGrade = (M, na) => {
    if (!M || urlQ.get("cargrade") === "0") return [1, 1, 1, 1];
    if (na === undefined) { const lt = meta.moments[slotIds[0]]?.lights || meta.moments[slotIds[1]]?.lights; na = !!lt?.lamps_na; }
    const one = [1, 1, 1, 1], G = na ? CAR_GRADE_NA : CAR_GRADE, keep = !na || urlQ.get("cargrade") === "1";
    const pick = (m) => (!keep && NA_UNTINTED.has(m) ? one : G[m] || one);
    const A = pick(M.a), B = pick(M.b);
    const g = A.map((x, i) => lerp(x, B[i], M.t)), y = 0.2126 * g[1] + 0.7152 * g[2] + 0.0722 * g[3];
    return [g[1] / y, g[2] / y, g[3] / y, g[0]];
  };
  // DYS-199 (F's helper, 31 Oct): the panorama's air in front of the moving cars, per moment: [its share far out, its
  // colour over the picture behind the car (linear)] (CAR3D_FS CARHAZE), eased in over CAR_AIR_M from the eye. Measured
  // on 4x stills against the photographed parked cars and the road around each car (docs/v3/briefs/golden-haze-notes.md):
  // lowsun (17:52 Greenwich and Akshay's 17:45 Lombard screenshot) ours 0.73-0.88 of the road, the parked 1.00-1.07: 0.30
  // of an air 1.5x the picture behind (applied to the stills' car pixels offline: 17:52 1.01 / 0.98 at 1-1.5 / 1.5-2.5
  // km, his view 1.11 / 1.02); sunset (18:18) ours 1.29-1.44, the parked 1.05: 0.65 of an air 0.85x (offline 1.09 /
  // 1.15; the rest is the grade's, CAR3D_FS's lowSun is ~0 at sunset). golden: no still yet, between the two (F's take
  // measures it). Every other moment 0: no change (the uniform 0 skips it)
  const CAR_HAZE = { golden: [0.25, 1.35], lowsun: [0.3, 1.5], sunset: [0.65, 0.85] };
  const CAR_AIR_M = 600;
  const carHaze = (M) => {
    if (!M || !(carHazeQ > 0)) return [0, 1, CAR_AIR_M, 0];
    const A = CAR_HAZE[M.a], B = CAR_HAZE[M.b];
    if (!A && !B) return [0, 1, CAR_AIR_M, 0];
    // (a moment without the air blends in at 0, at its neighbour's colour)
    const a = A || [0, B[1]], b = B || [0, A[1]];
    return [lerp(a[0], b[0], M.t) * carHazeQ, lerp(a[1], b[1], M.t), CAR_AIR_M, 0];
  };
  // DYS-111: a 3D vehicle's length, beam and height (m) as outside-events.js writes them (25-27, next to CAR3D_FLOATS);
  // the off-window cull reads them here only (until DYS-109 merges, the box and the shadows below read 27-29)
  const carSize = (D, b) => [D[b + 25], D[b + 26], D[b + 27]];
  // the sun on the 3D vehicles: its direction (room frame) and how much it shines (drawCarGroup's light, DYS-111's cull)
  function carSun(e) {
    const sunOn = smooth(-0.8, 0.6, e.alt) * (1 - e.night) * (1 - 0.7 * e.fog);
    const yawS = (e.az - AXIS) * DEG, ca = Math.cos(e.alt * DEG);
    return { sunOn, sun: [Math.sin(yawS) * ca, Math.sin(e.alt * DEG), -Math.cos(yawS) * ca] };
  }
  // the shadow vehicle b (length L, beam B, height Ht, m) casts on the road in the sun, in its own axes (x right, y
  // forward): its direction (ux, uy), its length Ls (at most 25 m) and its quad's half sizes along it (eu) and across
  // (ew); null when it casts none (drawCarGroup draws it, DYS-111's cull reaches for it)
  function castShadow(D, b, sun, sunOn, L, B, Ht, into) {
    const sx = sun[0] * D[b + 3] + sun[1] * D[b + 4] + sun[2] * D[b + 5], sy = sun[0] * D[b + 6] + sun[1] * D[b + 7] + sun[2] * D[b + 8];
    const sz = sun[0] * D[b + 9] + sun[1] * D[b + 10] + sun[2] * D[b + 11], sh = Math.hypot(sx, sy);
    if (!(sunOn > 0.05 && sz > 0.05 && sh > 1e-3)) return null;
    const Ls = Math.min(25, (Ht * sh) / sz), ux = -sx / sh, uy = -sy / sh;
    const eu = Math.abs(ux) * B / 2 + Math.abs(uy) * L / 2, ew = Math.abs(uy) * B / 2 + Math.abs(ux) * L / 2;
    if (into) { into.Ls = Ls; into.ux = ux; into.uy = uy; into.eu = eu; into.ew = ew; return into; }   // (DYS-265 zoom-gc: a kept record)
    return { Ls, ux, uy, eu, ew };
  }
  // DYS-111: whether vehicle b (model -> clip C, mirrored mir) lies wholly off the window's rectangle (rect: x, y, w, h,
  // device px, y up, in a W x H frame): its body at full size (+0.6 m for the mirrors, +0.2 m over the roof), the contact
  // shadow under it (inside that box) and, in the sun (s: carSun), the shadow it casts, up to 25 m along the road. The
  // cars' layer stops at the window (drawCarGroup clips its box there), so such a vehicle adds no pixel to it; a corner
  // behind the eye keeps it (its box can't be told)
  function offWindow(C, D, b, mir, rect, W, H, s) {
    const [len, beam, ht] = carSize(D, b), kl = Math.hypot(D[b + 6], D[b + 7], D[b + 8]) || 1;
    // (in the model's own metres: its forward axis carries the length's trim, kl, outside-events.js)
    const L = len / kl / 2 + 0.6, B = beam / 2 + 0.6, Ht = ht + 0.2;
    const pts = [[-B, -L, 0], [B, -L, 0], [-B, L, 0], [B, L, 0], [-B, -L, Ht], [B, -L, Ht], [-B, L, Ht], [B, L, Ht]];
    const cs = s && castShadow(D, b, s.sun, s.sunOn, len, beam, ht);
    if (cs) {
      // (its quad's corners as drawCarGroup draws it: the centre, then its axes along and across)
      const { Ls, ux, uy, eu, ew } = cs, cx = (ux * Ls / 2) * mir, cy = uy * Ls / 2;
      const ax = ux * (eu + Ls / 2) * mir, ay = uy * (eu + Ls / 2), bx = -uy * ew * mir, by = ux * ew;
      for (const [p, q] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push([cx + p * ax + q * bx, cy + p * ay + q * by, 0.02]);
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py, pz] of pts) {
      const cw = C[3] * px + C[7] * py + C[11] * pz + C[15];
      if (cw <= 1e-6) return false;
      const sx = ((C[0] * px + C[4] * py + C[8] * pz + C[12]) / cw * 0.5 + 0.5) * W, sy = ((C[1] * px + C[5] * py + C[9] * pz + C[13]) / cw * 0.5 + 0.5) * H;
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    const m = 2;   // (px: the layer's edge texels)
    return x1 < rect[0] - m || x0 > rect[0] + rect[2] + m || y1 < rect[1] - m || y0 > rect[1] + rect[3] + m;
  }
  // (DYS-149 gc-diet) offWindow with no array made: its corners by number in the same order (the body's 8, then the cast
  // shadow's 4), the same sums
  function offWindow2(C, D, b, mir, rect, W, H, s) {
    const len = D[b + 25], beam = D[b + 26], ht = D[b + 27], kl = Math.hypot(D[b + 6], D[b + 7], D[b + 8]) || 1;
    const L = len / kl / 2 + 0.6, B = beam / 2 + 0.6, Ht = ht + 0.2;
    const cs = s && castShadow(D, b, s.sun, s.sunOn, len, beam, ht, CSW);   // (DYS-266: into a kept record, read at once)
    let cx = 0, cy = 0, ax = 0, ay = 0, bx = 0, by = 0;
    if (cs) {
      const { Ls, ux, uy, eu, ew } = cs;
      cx = (ux * Ls / 2) * mir; cy = uy * Ls / 2;
      ax = ux * (eu + Ls / 2) * mir; ay = uy * (eu + Ls / 2); bx = -uy * ew * mir; by = ux * ew;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let q = 0, n = cs ? 12 : 8; q < n; q++) {
      let px, py, pz;
      if (q < 8) { px = q & 1 ? B : -B; py = q & 2 ? L : -L; pz = q & 4 ? Ht : 0; }
      else { const p = q & 1 ? 1 : -1, r = q & 2 ? 1 : -1; px = cx + p * ax + r * bx; py = cy + p * ay + r * by; pz = 0.02; }
      const cw = C[3] * px + C[7] * py + C[11] * pz + C[15];
      if (cw <= 1e-6) return false;
      const sx = ((C[0] * px + C[4] * py + C[8] * pz + C[12]) / cw * 0.5 + 0.5) * W, sy = ((C[1] * px + C[5] * py + C[9] * pz + C[13]) / cw * 0.5 + 0.5) * H;
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    const m = 2;
    return x1 < rect[0] - m || x0 > rect[0] + rect[2] + m || y1 < rect[1] - m || y0 > rect[1] + rect[3] + m;
  }
  // (gc-diet: drawCars3d's model -> room matrix into o, as its array)
  function modelInto(o, D, b, mir) {
    o[0] = D[b + 3] * mir; o[1] = D[b + 4] * mir; o[2] = D[b + 5] * mir; o[3] = 0; o[4] = D[b + 6]; o[5] = D[b + 7]; o[6] = D[b + 8]; o[7] = 0;
    o[8] = D[b + 9]; o[9] = D[b + 10]; o[10] = D[b + 11]; o[11] = 0; o[12] = D[b]; o[13] = D[b + 1]; o[14] = D[b + 2]; o[15] = 1;
    return o;
  }
  // (DYS-216 F, ?compilelean=1 on T1) the first view's outside programs drawn once each, into one pixel, as soon as each
  // has linked: long before the warm-up's hidden frame. Cold, Metal builds a pipeline at a program's first draw with each
  // new target format / blend / primitive / vertex layout, synchronously on the GPU process's one thread (WebKit /
  // ANGLE source); CP7 (?warmsync=1): the warm frame's outside stage 0.78 s, all of it these first draws. Drawn here
  // with the states the shown frames use (a phone draws canvas-direct: the canvas, no depth; the halo's bright and blur
  // into RGBA8 targets), the GPU thread builds them while the main thread loads the room; nothing waits for them (a
  // draw asks nothing back). check() is the only question (its COMPLETION_STATUS first: no wait for a link under way)
  // and sets the samplers' units, so the draws are valid. The canvas is hidden until the reveal and cleared every frame
  // When (?warmearly=, off without it): 1, at init (CP10: +0.18 s WebKit, +0.36 Chrome 6x: the draws went in just before
  // the room's programs were sent, which then waited 0.8 s behind them on that one thread); 2, between (pass.warmBetween:
  // the engine's warm-up once the room's programs are sent and its maps up, while the browser compiles them), each
  // program drawn if it has linked by then, none waited for
  const WARM_EARLY = compileLean && tier === "T1" ? urlQ.get("warmearly") : null;
  let warmLeft = null;
  function warmEarly(between = false) {
    // (B's 382fe99a: the room build's own GPU question, three's getMaxAnisotropy (hitex.js), asked now, before these
    // draws, not behind their pipelines (812 ms on Chrome, 0.23-0.32 s WebKit); three keeps the answer)
    engine.renderer.capabilities.getMaxAnisotropy();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Math.max(POINT_FLOATS, HULL_FLOATS) * 4), gl.STATIC_DRAW);
    const vaoP = gl.createVertexArray();   // (vaoPts' layout over a buffer that holds one point)
    gl.bindVertexArray(vaoP);
    const sp = POINT_FLOATS * 4;
    [[0, 4, 0], [1, 4, 16], [2, 4, 32], [3, 3, 48]].forEach(([i, n, off]) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, sp, off); });
    const vaoH = gl.createVertexArray();   // (vaoHull's: one instance)
    gl.bindVertexArray(vaoH);
    const sh = HULL_FLOATS * 4;
    [[0, 4, 0], [1, 4, 16], [2, 4, 32], [3, 4, 48], [4, 4, 64], [5, 4, 80], [6, 3, 96], [7, 4, 108], [8, 4, 124], [9, 4, 140]].forEach(([i, n, off]) => {
      gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, sh, off); gl.vertexAttribDivisor(i, 1);
    });
    gl.bindVertexArray(null);
    const small = target(gl, 4, 4);        // (the halo's bright / blur targets: RGBA8, no depth)
    const OVER = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    const tri = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    warmLeft = [
      { p: "back", fb: null, blend: null, vao: vaoEmpty, draw: tri },
      { p: "pts", fb: null, blend: OVER, vao: vaoP, draw: () => gl.drawArrays(gl.POINTS, 0, 1) },
      { p: "hull", fb: null, blend: OVER, vao: vaoH, draw: () => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1) },
      { p: "bright", fb: small.fb, blend: null, vao: vaoEmpty, draw: tri, pass: 0 },
      // (DYS-216 #4, ?shadermerge: the blur is the bright's program and pipeline, drawn once)
      ...(shaderMerge ? [] : [{ p: "blur", fb: small.fb, blend: null, vao: vaoEmpty, draw: tri }]),
      { p: "halo", fb: null, blend: [gl.ONE, gl.ONE_MINUS_SRC_COLOR], vao: vaoEmpty, draw: tri },
    ];
    const t0 = performance.now(), done = [];
    // (all six linked first, then all six drawn in one go: a question asked after a draw waits behind the pipeline that
    // draw queued (CP9b: polling between draws held the main thread 0.63 s))
    const tick = () => {
      if (!warmLeft) return;
      for (const j of [...warmLeft]) if (!P[j.p].ok && !P[j.p].check() && P[j.p].failed) warmLeft.splice(warmLeft.indexOf(j), 1);
      if (!between && warmLeft.some((j) => !P[j.p].ok) && performance.now() - t0 < 20000) { setTimeout(tick, 50); return; }
      for (const j of [...warmLeft]) {
        const prog = P[j.p];
        if (!prog.ok) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, j.fb);
        gl.viewport(0, 0, 1, 1);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 1, 1);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
        if (j.blend) { gl.enable(gl.BLEND); gl.blendFunc(j.blend[0], j.blend[1]); } else gl.disable(gl.BLEND);
        gl.useProgram(prog.p);
        if (shaderMerge && j.pass !== undefined) gl.uniform1f(prog.u.uPass, j.pass);   // (DYS-216 #4: HALOPREP_FS's switch)
        gl.bindVertexArray(j.vao);
        j.draw();
        warmLeft.splice(warmLeft.indexOf(j), 1);
        done.push(j.p);
      }
      gl.bindVertexArray(null); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      engine.renderer.resetState();   // (three.js's cached GL state: everything above went round it)
      warmLeft = null;
      tev("warm early", done.join(" "));
      engine.timings.outsideWarmEarly = { done, at: Math.round(t0), ms: Math.round(performance.now() - t0), between };
      gl.deleteVertexArray(vaoP); gl.deleteVertexArray(vaoH); gl.deleteBuffer(buf); freeTarget(gl, small);
    };
    if (between) tick(); else setTimeout(tick, 0);
  }
  // (DYS-216 F, ?compilelean=1) the vehicles' programs, LEAN_CARS_MS after the room is shown (checked every 30th frame
  // until then); without the parallel-compile extension each is asked about only LEAN_CHECK_MS after it was sent
  let leanN = 0;
  function leanCars() {
    if (leanShown === null) {
      if (leanN++ % 30) return;
      leanShown = performance.getEntriesByName?.("sfw:room-shown")?.[0]?.startTime ?? null;
      if (leanShown === null) return;
    }
    const now = performance.now();
    if (now - leanShown < LEAN_CARS_MS) return;
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    const late = (prog) => {
      if (parallel) return prog;
      const check = prog.check;
      prog.check = () => (performance.now() - now < LEAN_CHECK_MS ? false : check());
      return prog;
    };
    P.car3d = late(car3dProgram(carInstQ, parallel));
    P.carLayer = late(makeProgram(gl, G.CARLAYER_VS, G.CARLAYER_FS, parallel));
    tev("lean cars", Math.round(now - leanShown));
  }
  // DYS-227: the gulls' module and programs, late (above); checked every 30th frame until asked for. Without the
  // parallel-compile extension a program is not asked about until LEAN_CHECK_MS after it was sent (as leanCars)
  function gullsLate() {
    if (!GULL3D || gullAsked || gullN++ % 30) return;
    const now = performance.now();
    if (gullFirst === null) gullFirst = now;
    const shown = performance.getEntriesByName?.("sfw:room-shown")?.[0]?.startTime ?? null;
    if (!(shown !== null ? now - shown >= GULL_AFTER_MS : now - gullFirst >= GULL_LATE_MS)) return;
    gullAsked = true;
    import("./gl/gulls.js").then((m) => { gullMod = m; gullR = newGullR(); engine.requestFrame(); tev("gulls", "3d"); })
      .catch((e) => console.warn("[outside] gulls:", e.message));
  }
  // a gull's blur onto the window: the photograph's own around it, as measured (round 2, tell 1; gullreal's notes: the
  // bridge's edges against the gull's outline at 1x-4x, laptop and phone): a laptop's picture is denser than its screen
  // when magnified (its edges ~0.75 screen px at 1.84x and 4x, ~0.9 at 1x): max(0.55, 45 / ppd) device px; a phone's is
  // not (no L0 tiles at 1x, coarser squares magnified) and softens as it is magnified: 0.23 + 0.0133 px per device px a
  // degree (zoom.density reads a phone's picture as sharper than it shows). ppd: device px a degree at the view's middle
  function gullSoft() {
    const ppd = camInfo.pxPerRad * DEG;
    return tier === "T1" ? Math.min(2.5, 0.23 + 0.0133 * ppd) : Math.max(0.55, 45 / ppd);
  }
  function newGullR() {
    const parallel = gl.getExtension("KHR_parallel_shader_compile"), t0 = performance.now();
    return (globalThis.__gulls3d = gullMod.createGullRenderer(gl, {   // (QA: __gulls3d.ready(), __gulls3d.stats)
      program: (vs, fs) => {
        const prog = makeProgram(gl, vs, eyeSrc(fs), parallel);
        if (!parallel) { const check = prog.check; prog.check = () => (performance.now() - t0 < LEAN_CHECK_MS ? false : check()); }
        return prog;
      },
      target: (w, h, depth) => target(gl, w, h, depth), freeTarget: (t) => freeTarget(gl, t), panoUniforms, unitSrc: UNITS.uSrc,
      phone: tier === "T1",
    }));
  }
  // (DYS-149 smooth) the vehicles' program this frame and whether it is the instanced one: carInstQ, or QA's
  // globalThis.__carInst at run time (v2 meshes only); the one the page did not start with, P.car3dAlt, is made when
  // first asked for (no program until it has linked)
  function carProgram() {
    const g = globalThis.__carInst;
    const inst = (g === undefined || g === null ? carInstQ : !!+g) && meshMeta?.version === 2;
    if (inst === carInstQ) return { prog: P.car3d, inst };
    if (!P.car3dAlt) P.car3dAlt = car3dProgram(!carInstQ, gl.getExtension("KHR_parallel_shader_compile"));
    return { prog: P.car3dAlt.check() ? P.car3dAlt : null, inst };
  }
  function drawCars3d(frame) {
    const n = events.counts.cars3d || 0;
    lastLayer = null;
    const cp = n && meshGL ? carProgram() : null;
    if (!n || !meshGL || !cp.prog?.ok || !P.carLayer.ok) return;
    const D = events.cars3d, F = CAR3D_FLOATS, W = frame.width, H = frame.height;
    // the camera from the eased eye, then the panorama's eye as the origin: model metres around it
    const k = zoom ? zoom.eyeK() : 1, ce = camInfo.eye;
    const tr = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
    const VP = mul4(camInfo.vp, tr(E0[0] + (1 - k) * ce[0], E0[1] + (1 - k) * ce[1], E0[2] + (1 - k) * ce[2]));
    // the screen's density (device px/deg) against the picture's behind each vehicle: magnified past what the panorama
    // holds there (L0's 64 px/deg outside L3's regions), a vehicle is drawn no sharper than the picture around it
    const screenPpd = camInfo.pxPerRad * DEG;
    // (DYS-111: the window's rectangle and the sun, for the off-window cull below)
    const rect = frame.window.rect, sunNow = env ? carSun(env) : null;
    // each vehicle's model -> clip, its box on the screen and how sharp it may be (the picture's density / the screen's)
    const sharp = GC_DIET ? V3S : [], soft = GC_DIET ? V3W : [];
    let nR = 0, nS3 = 0, nW3 = 0;
    for (const i of events.order3) {
      if (carHalf && i & 1) continue;   // (DYS-161 memory, QA ?carhalf=1: the vehicles in even slots only)
      const b = i * F, view = D[b + 18], mir = meshMeta.version !== 2 && view > 4 ? -1 : 1;
      // (DYS-149 gc-diet: the model matrix into MM, and the corners below by number, not 9 new arrays and their
      // destructuring; the same numbers in the same order)
      const Mm = GC_DIET ? modelInto(MM, D, b, mir) : [D[b + 3] * mir, D[b + 4] * mir, D[b + 5] * mir, 0, D[b + 6], D[b + 7], D[b + 8], 0, D[b + 9], D[b + 10], D[b + 11], 0, D[b], D[b + 1], D[b + 2], 1];
      const R3 = GC_DIET ? v3Rec(nR) : null, C = GC_DIET ? mul4(VP, Mm, R3.C) : mul4(VP, Mm);
      const L = D[b + 25] / 2 + 0.6, B = D[b + 26] / 2 + 0.6, Ht = D[b + 27] + 0.2;   // (DYS-109: where outside-events.js writes them; was 27-29)
      const box = GC_DIET ? R3.box : [Infinity, Infinity, -Infinity, -Infinity];
      if (GC_DIET) { box[0] = Infinity; box[1] = Infinity; box[2] = -Infinity; box[3] = -Infinity; }
      if (GC_DIET) {
        for (let q = 0; q < 8; q++) {
          const px = q & 1 ? B : -B, py = q & 2 ? L : -L, pz = q & 4 ? Ht : 0;
          const cw = C[3] * px + C[7] * py + C[11] * pz + C[15];
          if (cw <= 1e-6) continue;
          const sx = ((C[0] * px + C[4] * py + C[8] * pz + C[12]) / cw * 0.5 + 0.5) * W, sy = ((C[1] * px + C[5] * py + C[9] * pz + C[13]) / cw * 0.5 + 0.5) * H;
          box[0] = Math.min(box[0], sx); box[1] = Math.min(box[1], sy); box[2] = Math.max(box[2], sx); box[3] = Math.max(box[3], sy);
        }
      } else for (const [px, py, pz] of [[-B, -L, 0], [B, -L, 0], [-B, L, 0], [B, L, 0], [-B, -L, Ht], [B, -L, Ht], [-B, L, Ht], [B, L, Ht]]) {
        const cw = C[3] * px + C[7] * py + C[11] * pz + C[15];
        if (cw <= 1e-6) continue;
        const sx = ((C[0] * px + C[4] * py + C[8] * pz + C[12]) / cw * 0.5 + 0.5) * W, sy = ((C[1] * px + C[5] * py + C[9] * pz + C[13]) / cw * 0.5 + 0.5) * H;
        box[0] = Math.min(box[0], sx); box[1] = Math.min(box[1], sy); box[2] = Math.max(box[2], sx); box[3] = Math.max(box[3], sy);
      }
      if (box[0] > box[2]) continue;
      // DYS-111: wholly off the window (shadows included), it is not drawn: nor does it widen its group's box (the layer's
      // size, so its resolution) or move its blur (fMid, fSoft below); a vehicle partly on the window is drawn as before
      if (CAR_CULL && (GC_DIET ? offWindow2 : offWindow)(C, D, b, mir, rect, W, H, sunNow)) continue;
      const dx = D[b + 22], dy = D[b + 23], dz = D[b + 24];
      let ppd = zoom?.density ? zoom.density(Math.atan2(dx, -dz) / DEG, Math.asin(Math.max(-1, Math.min(1, dy))) / DEG) : Infinity;
      // (density() is the sharpest the spot can show; L3 is drawn only from ~69 screen px/deg (zoom.js LF3_DRAW 1.9 below
      // its 256), so short of that the screen shows L0's 64 enlarged and the cars match that, eased as L3 fades in)
      if (Number.isFinite(ppd) && ppd > PANO_L0_PPD) {
        const lf3 = Math.log2(256 / Math.max(1e-3, screenPpd)), w = smooth(1.5, 1.9, lf3);
        ppd = Math.exp((1 - w) * Math.log(ppd) + w * Math.log(PANO_L0_PPD));
      }
      const f = ppd / screenPpd;
      if (GC_DIET) {
        nR++; R3.i = i; R3.mir = mir; R3.f = f; R3.ppd = Number.isFinite(ppd) ? ppd : 64;
        if (f >= CAR_SOFT_AT) sharp[nS3++] = R3; else soft[nW3++] = R3;
      } else (f >= CAR_SOFT_AT ? sharp : soft).push({ i, C, mir, box, f, ppd: Number.isFinite(ppd) ? ppd : 64 });
    }
    if (GC_DIET) { sharp.length = nS3; soft.length = nW3; }
    const layers = [];
    // (the blur: the picture's sigma at its density here, window px per picture px = 1 / f, less what the layer already
    // has: ~0.45 window px from the 2x layer averaged down, ~0.4 of a texel enlarged bilinearly)
    const fMid = (g) => g.map((c) => c.f).sort((a, b) => a - b)[g.length >> 1];
    let softS = sharp.length ? Math.max(CAR_SOFT, Math.sqrt(Math.max(0, (PIC_SIGMA / fMid(sharp)) ** 2 - 0.2))) : 0;
    // (DYS-199, QA ?carhazesoft=<px>: at the air's moments, the sharp layer's blur widened by up to that many window px, by
    // the group's median distance (full at 2 km) and the air's weight there; off by default)
    if (carHazeSoft > 0 && sharp.length) {
      const hw = Math.min(1, carHaze(cityState.moment)[0] / 0.3), dm = sharp.map((c) => D[c.i * F + 12]).sort((a, b) => a - b)[sharp.length >> 1];
      softS = Math.hypot(softS, carHazeSoft * hw * Math.min(1, dm / 2000));
    }
    if (sharp.length) layers.push(drawCarGroup(frame, sharp, 0, 2, softS, VP, cp));
    // (the soft ones at the picture's own density: their layer that small, enlarged bilinearly as the picture is)
    const fSoft = Math.max(0.12, Math.min(1, soft.reduce((a, c) => a + c.f, 0) / Math.max(1, soft.length)));
    if (soft.length) layers.push(drawCarGroup(frame, soft, 1, fSoft, Math.sqrt(PIC_SIGMA ** 2 - 0.16) / fSoft, VP, cp));
    lastLayer = layers.filter(Boolean);
  }

  // the L3 occluder squares around a vehicle (the 2 x 2 nearest its centre) into the atlas: resident ones go to the
  // shader now, missing ones are fetched (that vehicle uses L0 until they land); least recently used slots are reused
  function occl3For(u, dx, dy, dz) {
    const o = occl3Of(dx, dy, dz);
    ug.uniform4i(u.uOcc3S, o[0], o[1], o[2], o[3]);
    if (o[4] !== null) ug.uniform2i(u.uOcc3T, o[4], o[5]);
  }
  // (DYS-149 smooth: occl3For's values, [the four slots, i0, j0]; i0, j0 null when there are none (the per-vehicle path
  // leaves uOcc3T as it was then: not read with every slot -1); the instanced path writes them into the record)
  // (DYS-149 gc-diet: into OC (or OC_NONE), which both callers read at once; the slots asked for in the same order)
  const OC = [-1, -1, -1, -1, null, null], OC_NONE = [-1, -1, -1, -1, null, null];
  function occl3Of(dx, dy, dz) {
    const m = occl.meta?.l3;
    if (!m || !occl.l0) return GC_DIET ? OC_NONE : [-1, -1, -1, -1, null, null];
    const yaw = Math.atan2(dx, -dz) / DEG, el = Math.asin(Math.max(-1, Math.min(1, dy))) / DEG;
    const gx = yaw - m.yaw0, gy = m.el_top - el, i0 = Math.round(gx) - 1, j0 = Math.round(gy) - 1;
    // (DYS-161 memory, OP1: a phone's zoom on its way out past the 4x squares (zoom.js wayOut) asks for none: the ones in
    // the atlas still go to the shader, a missing one is L0, as while it is on its way)
    const held = !!zoom?.outbound?.();
    if (GC_DIET) {
      OC[0] = occlSlot(i0 + 0, j0 + 0, held); OC[1] = occlSlot(i0 + 1, j0 + 0, held); OC[2] = occlSlot(i0 + 0, j0 + 1, held); OC[3] = occlSlot(i0 + 1, j0 + 1, held);
      OC[4] = i0; OC[5] = j0;
      return OC;
    }
    const sl = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => occlSlot(i0 + a, j0 + b, held));
    return [...sl, i0, j0];
  }
  function occlSlot(i, j, held = false) {
    const key = i * 1000 + j, m = occl.meta.l3;
    if (!m.have.has(key)) return -1;
    const s = occl.slots.get(key);
    if (s && s.ready) {
      const k = occl.lru.indexOf(key);
      if (GC_DIET && k >= 0) lruTouch(occl.lru, k, key);
      else { if (k >= 0) occl.lru.splice(k, 1); occl.lru.push(key); }
      return s.slot;
    }
    if (s || occl.want.size >= 4 || held) return -1;
    if (!occl.atlas) {
      const W = OCCL_SPR * (m.tile_px + 4), H = Math.ceil(OCCL_SLOTS / OCCL_SPR) * 2 * (m.tile_px + 4), t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + UNITS.uOcc3);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG8, W, H);   // (DYS-161 memory: RG8, the two-channel squares)
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      occl.atlas = { tex: t, free: Array.from({ length: OCCL_SLOTS }, (_, k) => k) };
    }
    const rec = { slot: -1, ready: false }, gen = occl.gen;
    occl.slots.set(key, rec);
    occl.want.add(key);
    // (the square's bitmap waits for the next frame's occlPump: no GL call between frames, where the room's renderer
    // keeps its own record of what is bound)
    // (DYS-161 memory: one that lands after its atlas went (occlFree: gen) is let go)
    bitmapFrom(webRoot + "live/occl/" + occl.meta.rg.l3.replace("{i}", i).replace("{j}", j)).then((b) => {
      if (gen !== occl.gen) { letGo(b); return; }
      (occl.up || (occl.up = [])).push({ key, rec, b });
      engine.requestFrame();
    }).catch((e) => { console.warn("[outside] occluder square:", e.message); if (gen === occl.gen) occl.slots.delete(key); })
      .finally(() => { if (gen === occl.gen) occl.want.delete(key); });
    return -1;
  }

  // the occluder squares that have arrived into the atlas, two a frame (inside the pass, before anything is drawn)
  function occlPump() {
    const m = occl.meta?.l3;
    if (!m || !occl.atlas || !occl.up?.length) return;
    const sw = m.tile_px + 4;
    gl.activeTexture(gl.TEXTURE0 + UNITS.uOcc3);
    gl.bindTexture(gl.TEXTURE_2D, occl.atlas.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    for (const { key, rec, b } of occl.up.splice(0, 2)) {
      let slot = occl.atlas.free.pop();
      if (slot === undefined) { const old = occl.lru.shift(); slot = occl.slots.get(old).slot; occl.slots.delete(old); }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot % OCCL_SPR) * sw, Math.floor(slot / OCCL_SPR) * 2 * sw, gl.RG, gl.UNSIGNED_BYTE, b);
      letGo(b);
      rec.slot = slot; rec.ready = true; occl.lru.push(key);
    }
    if (occl.up.length) engine.requestFrame();
  }

  // (DYS-266 zoom-gc) drawCarGroup's items with the switch on: each vehicle's {c, d} and each baked parked car near the
  // group's vehicles as an eraser {p, C, C0, d}, kept records in a kept list (GIL), the erasers' model matrices kept with
  // them; the same items in the same order, sorted far to near as there
  function groupItems(group, D, F, VPg) {
    if (!GC_DIET) {
      const items = group.map((c) => ({ c, d: D[c.i * F + 12] }));
      if (baked && meshGL.vaos.prius) {
        const seen = new Set(), pm = meshMeta.models.prius;
        for (const c of group) {
          const b = c.i * F, cx = Math.floor(D[b] / 20), cz = Math.floor(D[b + 2] / 20);
          for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
            for (const p of (GC_DIET ? baked.cellsN.get(cellKey(cx + gx, cz + gz)) : baked.cells.get(`${cx + gx},${cz + gz}`)) || (GC_DIET ? NONE : [])) {
              if (seen.has(p) || Math.hypot(p.t[0] - D[b], p.t[2] - D[b + 2]) > 30) continue;
              seen.add(p);
              const k = 0.97, sx = (p.W / pm.beam) * k, sy = (p.L / pm.length) * k, sz = (p.H / pm.height) * k;
              const Mm = [p.right[0] * sx, p.right[1] * sx, p.right[2] * sx, 0, p.fwd[0] * sy, p.fwd[1] * sy, p.fwd[2] * sy, 0, 0, sz, 0, 0, p.t[0], p.t[1], p.t[2], 1];
              items.push({ p, C: mul4(VPg, Mm), C0: Mm, d: p.d });
            }
          }
        }
        items.sort((a, b2) => b2.d - a.d);
      }
      return items;
    }
    const items = GIL;
    let n = 0, ne = 0;
    for (let q = 0; q < group.length; q++) {
      const c = group[q], it = GIT[q] || (GIT[q] = { c: null, d: 0 });
      it.c = c; it.d = D[c.i * F + 12];
      items[n++] = it;
    }
    if (baked && meshGL.vaos.prius) {
      // (seen: a parked car taken once a call, marked with this call's number, not a new Set)
      const st = ++giStamp, pm = meshMeta.models.prius;
      for (const c of group) {
        const b = c.i * F, cx = Math.floor(D[b] / 20), cz = Math.floor(D[b + 2] / 20);
        for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
          for (const p of baked.cellsN.get(cellKey(cx + gx, cz + gz)) || NONE) {
            if (p._gi === st || Math.hypot(p.t[0] - D[b], p.t[2] - D[b + 2]) > 30) continue;
            p._gi = st;
            const k = 0.97, sx = (p.W / pm.beam) * k, sy = (p.L / pm.length) * k, sz = (p.H / pm.height) * k;
            const e = GER[ne] || (GER[ne] = { p: null, C: new Float64Array(16), C0: new Array(16).fill(0), d: 0 }), Mm = e.C0;
            ne++;
            Mm[0] = p.right[0] * sx; Mm[1] = p.right[1] * sx; Mm[2] = p.right[2] * sx; Mm[3] = 0; Mm[4] = p.fwd[0] * sy; Mm[5] = p.fwd[1] * sy; Mm[6] = p.fwd[2] * sy; Mm[7] = 0;
            Mm[8] = 0; Mm[9] = sz; Mm[10] = 0; Mm[11] = 0; Mm[12] = p.t[0]; Mm[13] = p.t[1]; Mm[14] = p.t[2]; Mm[15] = 1;
            e.p = p; mul4(VPg, Mm, e.C); e.d = p.d;
            items[n++] = e;
          }
        }
      }
      items.length = n;
      items.sort((a, b2) => b2.d - a.d);
    } else items.length = n;
    return items;
  }
  // one group of vehicles into its offscreen layer (slot 0 sharp, 1 soft) at up to `cap` layer px per window px, then
  // onto the window (cp: carProgram's, DYS-149)
  function drawCarGroup(frame, group, slot, cap, soften, VPg, cp) {
    const e = env, M = cityState.moment, D = events.cars3d, F = CAR3D_FLOATS, W = frame.width, H = frame.height;
    const models = Object.keys(meshMeta.models);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of group) { x0 = Math.min(x0, c.box[0]); y0 = Math.min(y0, c.box[1]); x1 = Math.max(x1, c.box[2]); y1 = Math.max(y1, c.box[3]); }
    const rect = frame.window.rect;
    const pad = Math.ceil(2 + 2.5 * soften);   // (room for the blur's spread)
    x0 = Math.max(Math.floor(x0) - pad, rect[0], 0); y0 = Math.max(Math.floor(y0) - pad, rect[1], 0);
    x1 = Math.min(Math.ceil(x1) + pad, rect[0] + rect[2], W); y1 = Math.min(Math.ceil(y1) + pad, rect[1] + rect[3], H);
    if (x1 <= x0 || y1 <= y0) return null;
    // (DYS-149 mv-lite: on a phone's moving frame (a pinch, a zoomed pan: frame.outsideMoving; or the room's camera) the
    // sharp layer holds half the texels: at most sqrt 2 layer px per window px each way, not 2, within half of
    // CAR_LAYER_PX. Its blur onto the window (soften: 0.35-1.6 window px for the sharp ones) is as before; the soft layer
    // is at the picture's own density already. The next frame after the move has them whole (the outside draws every
    // frame). The layer's texture is kept (never shrunk), so nothing is made. ?mvlite=-cars: as before)
    const lite = slot === 0 && mvLite("cars", frame);
    const bw = x1 - x0, bh = y1 - y0, s = Math.min(lite ? Math.min(cap, Math.SQRT2) : cap, Math.sqrt((lite ? CAR_LAYER_PX / 2 : CAR_LAYER_PX) / (bw * bh)));
    const lw = Math.max(1, Math.ceil(bw * s)), lh = Math.max(1, Math.ceil(bh * s));
    const drawFb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);   // (the window's: read before any target is made)
    let T = carLayers[slot];
    if (!T || T.w < lw || T.h < lh) {
      // (grown, never shrunk in either direction: a box turning from wide to tall would otherwise remake it back and forth)
      // (up to 1.6x the layer's budget: past it, the size it needs now)
      let nw = Math.max(T?.w || 0, Math.ceil(lw / 256) * 256), nh = Math.max(T?.h || 0, Math.ceil(lh / 256) * 256);
      if (nw * nh > 1.6 * CAR_LAYER_PX) { nw = Math.ceil(lw / 256) * 256; nh = Math.ceil(lh / 256) * 256; }
      freeTarget(gl, T);
      T = carLayers[slot] = target(gl, nw, nh, true);
      tev("layer", `${slot ? "soft" : "sharp"} ${T.w}x${T.h}`);
    }
    // screen clip -> the layer's clip
    const ax = (W * s) / lw, ay = (H * s) / lh;
    const Lm = [ax, 0, 0, 0, 0, ay, 0, 0, 0, 0, 1, 0, ax - (2 * x0 * s) / lw - 1, ay - (2 * y0 * s) / lh - 1, 0, 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
    gl.viewport(0, 0, lw, lh);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const u = cp.prog.u;
    gl.useProgram(cp.prog.p);
    panoUniforms(cp.prog);
    // (DYS-134: with lamps_na, a vehicle at night takes the lamp layer's light on the road under it, the light layers'
    // array on UNITS.uLights as bindAll left it, switched by the same clock and gate as the backdrop's)
    const lamp = lampUniforms(u, frame), { lt } = lamp;
    // (... at night only, as the backdrop adds its light layers only then (night over 0.02, outside.glsl.js): before it
    // uLampNa.w 0, the vehicles' set light; and so with QA's ?carlamp=0 (carLampQ) at any hour, both paths below reading
    // this program's uniform)
    const carLamp = lamp.na && carLampQ;
    if (lamp.na && u.uLampNa && !(carLamp && e.night > 0.02)) gl.uniform4f(u.uLampNa, 0, 0, 0, 0);
    // (... and magnified over L3, whose tiles have the lamps baked in (all on) and no light layers over them (zoom.js
    // variantSource), a vehicle's lamps are as baked by L3's weight under it (zoom.js l3At; the backdrop drew with the
    // variant this frame): during the lamps' spread at dusk and dawn it was dark in a pool L3 shows lit). That weight
    // per vehicle, from its direction: CAR3D_FS's uL3K (instanced: its record's texel 7 w, carsInstanced; else the
    // uniform, set per vehicle; 0 without the gate)
    const l3Gate = carLamp && e.night > 0.02 && backL3 && zoom?.l3At ? zoom.l3At : null;
    const l3K = l3Gate ? (x, y, z) => l3Gate(Math.atan2(x, -z) / DEG, Math.asin(Math.max(-1, Math.min(1, y))) / DEG, frame.time) : null;
    gl.uniform4f(u.uLayer, x0, y0, 1 / s, 0);
    const carDebug = +(globalThis.__carDebug ?? urlQ.get("cardebug") ?? 0);
    const grainK = +(urlQ.get("grain") ?? 1);   // (QA ?grain=0: the vehicles without the picture's grain)
    const sunGate = urlQ.get("sungate") === "0" ? 0 : 1;   // (QA ?sungate=0: every vehicle in the sun, as before)
    const v2 = meshMeta.version === 2;
    gl.uniform1f(u.uAo, v2 ? 1 : 0);   // (QA: ?cardebug=, or __carDebug set at run time)
    if (u.uCarDebug) gl.uniform1f(u.uCarDebug, carDebug);
    // the moment's light, from the panorama's own colours: its white walls in sun, its high sky, its air
    const Wl = lin3(e.white), Hl = lin3(e.high), Al = lin3(e.air);
    const { sunOn, sun } = carSun(e);
    const sunRGB = M ? M.sunRGB : [1, 1, 1], nk = 1 - 0.9 * e.night;
    gl.uniform3f(u.uSunDir, ...sun);
    gl.uniform3f(u.uWall, ...Wl);
    // (seen from 2-5 degrees above, a vehicle is mostly its sides: a shaded white side lit by the open sky and the bright
    // street comes out near the panorama's shaded white facades, ~0.68 sRGB at midday; a sunlit top near its white walls;
    // measured against the panorama in 4x captures, renders/stage-qa-d/measure_cars.py: highlights ~1.0 x its white walls)
    // (by day x1.35 linear: look1, latemorning-midday, had ours at p50 0.45-0.56 and p90 0.62-0.73 against its parked
    // cars' ~0.76 and ~0.84; part of that is their paint, mostly white, so not all of it)
    const dayK = 1 + 0.35 * sunOn;
    gl.uniform3f(u.uSunLin, ...Wl.map((x, i) => x * sunRGB[i] * 0.92 * sunOn * dayK));
    // (the sky's light as bright as the mix of the high sky and the white walls it was calibrated on, but in the sky's own
    // colour: a backlit car's shaded side at golden hour is blue in the photograph, r/g ~1.0 against our warm 1.18, look4)
    const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const skyY = lumOf(Hl.map((x, i) => 0.5 * x + 0.5 * Wl[i])), hY = Math.max(lumOf(Hl), 1e-6);
    // (half the sky's colour, half neutral: in the sky's own colour the shaded sides read blue at noon, where the
    // panorama's own shaded facades are neutral with the street's bounce in them; look7b's box trucks, B2's Greenwich
    // dr_g -0.17)
    gl.uniform3f(u.uSkyLin, ...Hl.map((x) => (0.5 * x + 0.5 * hY) * (skyY / hY) * 0.83 * nk * dayK));
    gl.uniform3f(u.uGndLin, ...Al.map((x) => x * 0.46 * nk));
    gl.uniform4f(u.uCarGrade, ...carGrade(M, !!lt?.lamps_na));
    if (u.uCarHaze) gl.uniform4f(u.uCarHaze, ...carHaze(M));   // (DYS-199: only compiled in without ?carhaze=0)
    if (u.uBrCar) gl.uniform3f(u.uBrCar, brCarQ[0], brCarQ[1], brCarQ[2]);
    if (u.uBrSpeck) gl.uniform2f(u.uBrSpeck, brCarQ[3], brCarQ[4]);   // (DYS-240 bridge cars: only compiled in without ?bridgecar=0)
    if (u.uCarDay) gl.uniform1f(u.uCarDay, carDayQ);           // (DYS-240 day tone: only compiled in without ?carday=0)
    if (u.uCastLow) gl.uniform1f(u.uCastLow, urlQ.get("castlow") === "0" ? 0 : 1);   // (DYS-109: ?castlow=0, the long golden shadows as before)
    // (DYS-157: the paint mirrors the panorama's sky at grazing angles; ?roofglint=0 turns it off. Gone from sunset to dusk
    // (night 0 -> 0.3): measured at golden, lowsun and sunset only, DYS-155)
    // (Deploy 10, coordinator 30 Oct: held off by default, as round 1's moving roofs read as a row of identical bright white
    // blobs. Round 3 (the roof proper only, per car, capped at 0.9x the mirrored sky) passed the coordinator's eye 30 Oct
    // 13:1x: on by default again)
    if (u.uRoofGlint) gl.uniform1f(u.uRoofGlint, urlQ.get("roofglint") === "0" ? 0 : 1 - smooth(0, 0.3, e.night));
    // (DYS-157 round 2: each car its own clearcoat and roof, from its two fixed numbers (outside-events.js 28-29). The
    // coordinator's look, 30 Oct 13:20Z: round 1 made every moving roof the same near-white blob. x, the clearcoat: a
    // share matte or dirty (15 %: 0.1-0.3), most mid (70 %: 0.6-0.95), a few glossy (15 %: 1-1.15); y, how far its
    // roof's normal is eased toward level for the mirror (0.5-0.9): roofs that curve more fore and aft catch less of the
    // low sky)
    // (glintCar: createOutside's, DYS-266)
    gl.uniform3f(u.uSkyRef, ...Hl.map((x) => x * 0.9 * nk));
    gl.uniform3f(u.uHorRef, ...Al.map((x) => x * 0.9 * nk));
    // the cast shadows' darkness as the panorama's own: its road in a parked car's shadow against the open road beside
    // it, ~0.2 at midday and ~0.5 at golden (sRGB luma, the L3 tiles: renders/stage-qa-d/look/measure_parked.py)
    const shadeA = 0.82 * sunOn * Math.max(0, sun[1]) ** 0.25;
    // (the contact shadow's ring outside the body: the open sky's share of the road's light, ~0.2 in midday sun)
    const ambShare = 1 - 0.8 * sunOn * Math.max(0, sun[1]) ** 0.25;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // the baked parked cars near this group's vehicles, as erasers in the far-to-near order: a moving car behind one is
    // hidden where the photograph's parked car stands in front of it (the depth map can't tell metres at this range)
    const items = groupItems(group, D, F, VPg);
    // (DYS-149 smooth: instanced, carsInstanced draws the items; the loop below is the per-vehicle path, ?carinst=0)
    const nDraws = cp.inst ? carsInstanced({ items, slot, Lm, u, W, H, D, F, models, fog: e.fog, look: [grainK, sunGate, Math.max(0, sun[1])],
      sun, sunOn, shadeA, ambShare, glintCar, l3K }) : null;
    ug = carUni ? uniSkip() : gl;   // (DYS-161 memory, QA ?caruni=1)
    for (const it of cp.inst ? [] : items) {
      if (it.p) {
        // (an eraser: the parked car's silhouette clears what lies behind it in the layer)
        if (GC_DIET) mvp32.set(mul4(Lm, it.C, M16)); else mul4(Lm, it.C).forEach((x, j) => { mvp32[j] = x; });
        ug.uniformMatrix4fv(u.uMVP, false, mvp32);
        rot32.set([it.C0[0], it.C0[1], it.C0[2], it.C0[4], it.C0[5], it.C0[6], it.C0[8], it.C0[9], it.C0[10]]);
        ug.uniformMatrix3fv(u.uRot, false, rot32);
        ug.uniform3f(u.uDir, it.p.t[0] / it.d, it.p.t[1] / it.d, it.p.t[2] / it.d);
        occl3For(u, it.p.t[0] / it.d, it.p.t[1] / it.d, it.p.t[2] / it.d);
        ug.uniform4f(u.uCar, it.d, 1, 0, 0);
        ug.uniform1f(u.uShadow, 0);
        ug.uniform1f(u.uErase, 1);
        gl.disable(gl.CULL_FACE);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        if (v2) {   // (v2: the closed body, L1)
          gl.bindVertexArray(meshGL.vaos.prius[1]);
          gl.drawElements(gl.TRIANGLES, meshGL.ranges.prius[1][1], gl.UNSIGNED_SHORT, meshGL.ranges.prius[1][0]);
        } else {
          gl.bindVertexArray(meshGL.vaos.prius);
          for (const vw of [0, 2, 4]) {   // (front, side, back: together every face, the whole silhouette from any side)
            const [off, cnt] = meshGL.ranges.prius[vw];
            gl.drawElements(gl.TRIANGLES, cnt, gl.UNSIGNED_SHORT, off);
          }
        }
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        ug.uniform1f(u.uErase, 0);
        continue;
      }
      const { i, C, mir } = it.c;
      const b = i * F, model = models[D[b + 17]], view = D[b + 18], kk = view > 4 ? 8 - view : view;
      if (GC_DIET) mvp32.set(mul4(Lm, C, M16)); else mul4(Lm, C).forEach((x, j) => { mvp32[j] = x; });
      ug.uniformMatrix4fv(u.uMVP, false, mvp32);
      rot32.set([D[b + 3] * mir, D[b + 4] * mir, D[b + 5] * mir, D[b + 6], D[b + 7], D[b + 8], D[b + 9], D[b + 10], D[b + 11]]);
      ug.uniformMatrix3fv(u.uRot, false, rot32);
      ug.uniform4f(u.uCar, D[b + 12], D[b + 13], D[b + 14], D[b + 15]);
      ug.uniform3f(u.uDir, D[b + 22], D[b + 23], D[b + 24]);
      if (u.uL3K) ug.uniform1f(u.uL3K, l3K ? l3K(D[b + 22], D[b + 23], D[b + 24]) : 0);
      occl3For(u, D[b + 22], D[b + 23], D[b + 24]);
      ug.uniform3f(u.uPaint, D[b + 19], D[b + 20], D[b + 21]);
      if (u.uGlintCar) ug.uniform3f(u.uGlintCar, ...glintCar(D[b + 28], D[b + 29]), D[b + 27]);   // (z: its height, m: round 3's roof cut)
      ug.uniform4f(u.uLook, (D[b + 12] * DEG) / it.c.ppd, grainK, sunGate, Math.max(0, sun[1]));
      // its shadows first: the contact shadow under the body, then (in sun) the one it casts, both on the road
      const L = D[b + 25], B = D[b + 26], Ht = D[b + 27];   // (DYS-109: was 27-29: length = height, beam and height 0, so no shadows)
      const [cw, cl, cy, tier, wb] = shadowShape(model, meshMeta.models[model].kind), fx = /lyft|bike|moto|mt07/.test(model) ? 0.2 : 0.43 * B;
      ug.uniform4f(u.uShA, fx, L / 2, fx * cw, L * cl);
      ug.uniform4f(u.uShC, ambShare, Math.max(0.05, fx - 0.12), L * wb, 0);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);   // (the shadows on the road: hidden behind a body, never hiding one)
      ug.uniform1f(u.uShadow, 1);
      gl.bindVertexArray(vaoQuad);
      ug.uniform4f(u.uCar2, D[b + 16], e.fog, 1, evW);
      ug.uniform4f(u.uQuadA, 0, 0, (fx + 0.6) * mir, 0);
      ug.uniform4f(u.uQuadB, 0, L / 2 + 0.6, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // (the sun in the vehicle's own axes, x right, y forward, z up: castShadow)
      const cs = castShadow(D, b, sun, sunOn, L, B, Ht);
      if (cs) {
        const { Ls, ux, uy, eu, ew } = cs;
        ug.uniform1f(u.uShadow, 2);
        ug.uniform4f(u.uShB, ux * Ls * mir, uy * Ls, tier, L * cy);
        ug.uniform4f(u.uCar2, D[b + 16], e.fog, shadeA, evW);
        ug.uniform4f(u.uQuadA, ux * Ls / 2 * mir, uy * Ls / 2, ux * (eu + Ls / 2) * mir, uy * (eu + Ls / 2));
        ug.uniform4f(u.uQuadB, -uy * ew * mir, ux * ew, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.depthMask(true);
      ug.uniform1f(u.uShadow, 0);
      ug.uniform4f(u.uCar2, D[b + 16], e.fog, 0, evW);
      if (v2) {
        // v2: every face of the LOD its size on the screen calls for, sorted by the depth buffer (both sides: the
        // parts are open shells)
        const lenPx = Math.max(it.c.box[2] - it.c.box[0], it.c.box[3] - it.c.box[1]);
        const lod = carLod >= 0 ? Math.min(carLod, meshGL.ranges[model].length - 1) : lenPx >= CAR_LOD_PX[0] ? 0 : lenPx >= CAR_LOD_PX[1] ? 1 : 2;   // (DYS-161 memory, QA ?carlod=N)
        gl.bindVertexArray(meshGL.vaos[model][lod]);
        const [off, cnt] = meshGL.ranges[model][lod];
        gl.drawElements(gl.TRIANGLES, cnt, gl.UNSIGNED_SHORT, off);
        continue;
      }
      // the body: the faces for the view it is seen from (mirrored for the left-hand views: their winding turns)
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(mir < 0 ? gl.CW : gl.CCW);
      gl.bindVertexArray(meshGL.vaos[model]);
      const [off, cnt] = meshGL.ranges[model][kk];
      gl.drawElements(gl.TRIANGLES, cnt, gl.UNSIGNED_SHORT, off);
    }
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.frontFace(gl.CCW);
    // (QA ?cardebug: every 60th frame, how many of the layer's texels were drawn)
    if (carDebug && frame.index % 60 === 0) {
      const px = new Uint8Array(lw * lh * 4);
      gl.readPixels(0, 0, lw, lh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let cov = 0;
      for (let j = 3; j < px.length; j += 4) if (px[j] > 0) cov++;
      carDebugInfo = { ...(carDebugInfo?.frame === frame.index ? carDebugInfo : {}), frame: frame.index, [slot ? "soft" : "sharp"]: { layer: [lw, lh], covered: cov, cars: group.length } };
      carDebugInfo.covered = (carDebugInfo.sharp?.covered || 0) + (carDebugInfo.soft?.covered || 0);
    }
    // (DYS-149 mv-lite: nothing reads the layer's depth after its own draws (each frame clears it first): on a phone's
    // moving frame it is let go, not stored (S10). ?mvlite=-depth: stored as before)
    if (mvLite("depth", frame)) gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
    // the layer onto the window
    gl.bindFramebuffer(gl.FRAMEBUFFER, drawFb);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect[0], rect[1], rect[2], rect[3]);
    const v = P.carLayer.u;
    gl.useProgram(P.carLayer.p);
    gl.activeTexture(gl.TEXTURE0 + UNITS.uSrc);
    gl.bindTexture(gl.TEXTURE_2D, T.tex);
    gl.uniform4f(v.uRect, x0, y0, bw, bh);
    gl.uniform2f(v.uSize, W, H);
    gl.uniform4f(v.uMap, s, T.w, T.h, soften);
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { slot: slot ? "soft" : "sharp", box: [x0, y0, bw, bh], scale: +s.toFixed(3), blur: +soften.toFixed(2), cars: group.length, inst: cp.inst ? 1 : 0, draws: nDraws };
  }

  // (DYS-149 smooth) the vehicles instanced: drawCarGroup's items (far to near, the parked erasers among them) into its
  // layer (clip Lm), lit as it set up. A unit for each draw the per-vehicle loop makes (a vehicle's shadow quads, its
  // body; a parked car's eraser), its records the uniforms that loop sets for it (CAR3D_VS's layout), made in the same
  // order (occl3Of's requests and its squares' recency as before). Then each unit joins the latest batch of its kind
  // (the quads; one model at one LOD; the erasers) unless a batch after that one holds a unit whose outline on the
  // window overlaps its own (px, 2 px apart at least; the convex hull of its corners through its own model -> clip:
  // the mesh LOD's bounds, each quad; one corner behind the eye: everything): moved ahead only of draws that touch none
  // of its pixels, every pixel takes the same fragments in the same order (the blending and the depth test give the
  // same bits: the layer read back is the same). The records go up in the batches' order, one texSubImage2D; each
  // batch is one drawArraysInstanced (the quads) or drawElementsInstanced, uInstBase its first record. The state as the
  // loop sets it: no culling; the quads without depth writes, an eraser's blend ZERO, ONE_MINUS_SRC_ALPHA. A cast
  // shadow the fragment shader makes wholly clear (uCastLow at a low sun, 3-10 degrees: alpha 0 exactly, blended ONE,
  // ONE_MINUS_SRC_ALPHA, no depth write) changes no pixel and is left out. Returns the draws made.
  const INST_TEXELS = 20, INST_WALK = 64, INST_GAP = 2;   // (a record's RGBA32F texels; batches a unit looks back; px)
  const instT = [null, null];               // the records' texture per layer slot (each written once a frame) and its rows
  let instStage = new Float32Array(0), instOut = new Float32Array(0), instMax = 0;
  // (model points x, y, z through C (model -> clip) to window px [x, y, ...]; null when one is behind the eye)
  const toPx = (C, pts, W, H) => {
    const o = [];
    for (let k = 0; k < pts.length; k += 3) {
      const px = pts[k], py = pts[k + 1], pz = pts[k + 2], cw = C[3] * px + C[7] * py + C[11] * pz + C[15];
      if (!(cw > 1e-6)) return null;
      o.push(((C[0] * px + C[4] * py + C[8] * pz + C[12]) / cw * 0.5 + 0.5) * W, ((C[1] * px + C[5] * py + C[9] * pz + C[13]) / cw * 0.5 + 0.5) * H);
    }
    return o;
  };
  // (their convex hull, in order: Andrew's monotone chain)
  const hull2 = (p) => {
    const ix = Array.from({ length: p.length >> 1 }, (_, k) => k).sort((a, b) => p[2 * a] - p[2 * b] || p[2 * a + 1] - p[2 * b + 1]);
    const cr = (o, a, b) => (p[2 * a] - p[2 * o]) * (p[2 * b + 1] - p[2 * o + 1]) - (p[2 * a + 1] - p[2 * o + 1]) * (p[2 * b] - p[2 * o]);
    const lo = [], up = [];
    for (const i of ix) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], i) <= 0) lo.pop(); lo.push(i); }
    for (let k = ix.length - 1; k >= 0; k--) { const i = ix[k]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], i) <= 0) up.pop(); up.push(i); }
    lo.pop(); up.pop();
    const o = [];
    for (const i of lo.concat(up)) o.push(p[2 * i], p[2 * i + 1]);
    return o.length ? o : p.slice(0, 2);
  };
  // (a unit's footprint: its outlines and their box; null outlines = everything)
  const ALL = { polys: null, box: [-Infinity, -Infinity, Infinity, Infinity] };
  const footprint = (C, ptsList, W, H) => {
    const polys = [], box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const pts of ptsList) {
      const q = toPx(C, pts, W, H);
      if (!q) return ALL;
      const h = hull2(q);
      for (let k = 0; k < h.length; k += 2) { box[0] = Math.min(box[0], h[k]); box[1] = Math.min(box[1], h[k + 1]); box[2] = Math.max(box[2], h[k]); box[3] = Math.max(box[3], h[k + 1]); }
      polys.push(h);
    }
    return { polys, box };
  };
  const boxHit = (a, b) => a[0] <= b[2] + INST_GAP && b[0] <= a[2] + INST_GAP && a[1] <= b[3] + INST_GAP && b[1] <= a[3] + INST_GAP;
  // (an edge of A's that keeps B more than INST_GAP px away: then they don't overlap, separating axes)
  const sepBy = (A, B) => {
    for (let i = 0, n = A.length >> 1; i < n; i++) {
      const j = (i + 1) % n, ex = A[2 * j] - A[2 * i], ey = A[2 * j + 1] - A[2 * i + 1], len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      const nx = -ey / len, ny = ex / len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let k = 0; k < A.length; k += 2) { const d = A[k] * nx + A[k + 1] * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (let k = 0; k < B.length; k += 2) { const d = B[k] * nx + B[k + 1] * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 + INST_GAP < b0 || b1 + INST_GAP < a0) return true;
    }
    return false;
  };
  const unitHit = (a, b) => {
    if (!boxHit(a.box, b.box)) return false;
    if (!a.polys || !b.polys) return true;
    for (const p of a.polys) for (const q of b.polys) if (!sepBy(p, q) && !sepBy(q, p)) return true;
    return false;
  };
  // (DYS-265 zoom-gc: the footprints above without a new array a vehicle: at full zoom they were ~25 MB/s of the page's
  // ~104 MB/s of garbage (V8's sampling heap profiler), which WebKit at times let pile up to +1.1 GB before collecting.
  // A chunk's hulls go into FPV (x, y pairs), each unit's outlines as [start, length] in FPI; units and batches come
  // from pools. The same projections, hulls (an insertion sort is stable, as Array.sort), boxes, overlap tests and
  // batches, in the same order: scripts/city_clock/gcdiet_gl_same.mjs checks every call and float)
  let FPV = new Float64Array(8192), FPI = new Int32Array(2048), fpvN = 0, fpiN = 0, TPX = new Float64Array(64);
  const HIX = new Int32Array(32), HLO = new Int32Array(32), HUP = new Int32Array(32), UNIT_POOL = [], BATCH_POOL = [], UNITS_A = [], BATCHES_A = [];
  let nU = 0, nB = 0;
  const unitOf = (key, r0, n) => { const u = UNIT_POOL[nU] || (UNIT_POOL[nU] = { key: 0, r0: 0, n: 0, all: false, p0: 0, np: 0, box: [0, 0, 0, 0] }); nU++; u.key = key; u.r0 = r0; u.n = n; return u; };
  const batchOf = (key) => { const t = BATCH_POOL[nB] || (BATCH_POOL[nB] = { key: 0, units: [], nu: 0, box: [0, 0, 0, 0], first: 0, n: 0 }); nB++; t.key = key; t.nu = 0; t.box[0] = t.box[1] = Infinity; t.box[2] = t.box[3] = -Infinity; t.first = t.n = 0; return t; };
  const anyHit = (list, un, n = list.length) => { for (let k = 0; k < n; k++) if (unitHitK(list[k], un)) return true; return false; };
  // (toPx into TPX: its point count, or -1 when one is behind the eye)
  const toPxK = (C, pts, W, H) => {
    if (TPX.length < (pts.length / 3) * 2) TPX = new Float64Array(TPX.length * 2 + pts.length);
    let n = 0;
    for (let k = 0; k < pts.length; k += 3) {
      const px = pts[k], py = pts[k + 1], pz = pts[k + 2], cw = C[3] * px + C[7] * py + C[11] * pz + C[15];
      if (!(cw > 1e-6)) return -1;
      TPX[2 * n] = ((C[0] * px + C[4] * py + C[8] * pz + C[12]) / cw * 0.5 + 0.5) * W; TPX[2 * n + 1] = ((C[1] * px + C[5] * py + C[9] * pz + C[13]) / cw * 0.5 + 0.5) * H;
      n++;
    }
    return n;
  };
  // (hull2 of TPX's n points, appended to FPV: its length in floats)
  const hullK = (n) => {
    const p = TPX, ix = n <= HIX.length ? HIX : new Int32Array(n), lo = n <= HLO.length ? HLO : new Int32Array(n), up = n <= HUP.length ? HUP : new Int32Array(n);
    for (let k = 0; k < n; k++) ix[k] = k;
    for (let k = 1; k < n; k++) for (let j = k; j > 0; j--) {
      const a = ix[j - 1], b = ix[j];
      if (!((p[2 * a] - p[2 * b] || p[2 * a + 1] - p[2 * b + 1]) > 0)) break;
      ix[j - 1] = b; ix[j] = a;
    }
    const cr = (o, a, b) => (p[2 * a] - p[2 * o]) * (p[2 * b + 1] - p[2 * o + 1]) - (p[2 * a + 1] - p[2 * o + 1]) * (p[2 * b] - p[2 * o]);
    let nl = 0, nu = 0;
    for (let k = 0; k < n; k++) { const i = ix[k]; while (nl >= 2 && cr(lo[nl - 2], lo[nl - 1], i) <= 0) nl--; lo[nl++] = i; }
    for (let k = n - 1; k >= 0; k--) { const i = ix[k]; while (nu >= 2 && cr(up[nu - 2], up[nu - 1], i) <= 0) nu--; up[nu++] = i; }
    nl = Math.max(0, nl - 1); nu = Math.max(0, nu - 1);
    const len = nl + nu ? 2 * (nl + nu) : 2;
    if (FPV.length < fpvN + len) { const g = new Float64Array(Math.max(FPV.length * 2, fpvN + len)); g.set(FPV.subarray(0, fpvN)); FPV = g; }
    let o = fpvN;
    if (nl + nu) { for (let k = 0; k < nl; k++) { FPV[o++] = p[2 * lo[k]]; FPV[o++] = p[2 * lo[k] + 1]; } for (let k = 0; k < nu; k++) { FPV[o++] = p[2 * up[k]]; FPV[o++] = p[2 * up[k] + 1]; } }
    else { FPV[o++] = p[0]; FPV[o++] = p[1]; }
    fpvN = o;
    return len;
  };
  // (footprint of one or two point lists into unit u: u.all (ALL), else its outlines FPI[u.p0..] and box)
  const footprintK = (C, a, b, W, H, u) => {
    const box = u.box;
    box[0] = Infinity; box[1] = Infinity; box[2] = -Infinity; box[3] = -Infinity;
    u.all = false; u.p0 = fpiN; u.np = 0;
    for (let m = 0; m < 2; m++) {
      const pts = m ? b : a;
      if (!pts) continue;
      const n = toPxK(C, pts, W, H);
      if (n < 0) { u.all = true; fpiN = u.p0; u.np = 0; box[0] = -Infinity; box[1] = -Infinity; box[2] = Infinity; box[3] = Infinity; return u; }
      const s = fpvN, len = hullK(n);
      for (let k = s; k < s + len; k += 2) { box[0] = Math.min(box[0], FPV[k]); box[1] = Math.min(box[1], FPV[k + 1]); box[2] = Math.max(box[2], FPV[k]); box[3] = Math.max(box[3], FPV[k + 1]); }
      if (FPI.length < fpiN + 2) { const g = new Int32Array(FPI.length * 2); g.set(FPI); FPI = g; }
      FPI[fpiN++] = s; FPI[fpiN++] = len; u.np++;
    }
    return u;
  };
  // (sepBy on FPV's outlines A (a0, an floats) and B)
  const sepByK = (a0, an, b0, bn) => {
    const A = FPV;
    for (let i = 0, n = an >> 1; i < n; i++) {
      const j = (i + 1) % n, ex = A[a0 + 2 * j] - A[a0 + 2 * i], ey = A[a0 + 2 * j + 1] - A[a0 + 2 * i + 1], len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      const nx = -ey / len, ny = ex / len;
      let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (let k = a0; k < a0 + an; k += 2) { const d = A[k] * nx + A[k + 1] * ny; p0 = Math.min(p0, d); p1 = Math.max(p1, d); }
      for (let k = b0; k < b0 + bn; k += 2) { const d = A[k] * nx + A[k + 1] * ny; q0 = Math.min(q0, d); q1 = Math.max(q1, d); }
      if (p1 + INST_GAP < q0 || q1 + INST_GAP < p0) return true;
    }
    return false;
  };
  const unitHitK = (a, b) => {
    if (!boxHit(a.box, b.box)) return false;
    if (a.all || b.all) return true;
    for (let x = 0; x < a.np; x++) for (let y = 0; y < b.np; y++) {
      const p0 = FPI[a.p0 + 2 * x], pn = FPI[a.p0 + 2 * x + 1], q0 = FPI[b.p0 + 2 * y], qn = FPI[b.p0 + 2 * y + 1];
      if (!sepByK(p0, pn, q0, qn) && !sepByK(q0, qn, p0, pn)) return true;
    }
    return false;
  };
  const QP = [new Array(12).fill(0), new Array(12).fill(0)], CS = { Ls: 0, ux: 0, uy: 0, eu: 0, ew: 0 };
  // (a shadow quad's corners as CAR3D_VS makes them: the centre qa.xy, axes qa.zw and qb.xy, 2 cm over the road)
  const quadPts = (qa, qb, into) => {
    const pts = into || [];
    // (DYS-149 gc-diet: the corners by number, in the same order)
    if (GC_DIET) { for (let k = 0; k < 4; k++) { const p = k & 1 ? 1 : -1, q = k & 2 ? 1 : -1; pts[3 * k] = qa[0] + p * qa[2] + q * qb[0]; pts[3 * k + 1] = qa[1] + p * qa[3] + q * qb[1]; pts[3 * k + 2] = 0.02; } return pts; }
    for (const [p, q] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push(qa[0] + p * qa[2] + q * qb[0], qa[1] + p * qa[3] + q * qb[1], 0.02);
    return pts;
  };
  function carsInstanced(g) {
    const { items, slot, Lm, u, W, H, D, F, models, fog, look, sun, sunOn, shadeA, ambShare, glintCar, l3K } = g;
    const R = INST_TEXELS * 4, KEY_QUADS = -1, KEY_ERASE = -2;
    // (review since 13:45, 1: on a context lost before the engine hears of it, getParameter gives null: instMax 0 made
    // the batches' chunk 0 and the loop below never ended; that frame's vehicles are skipped instead)
    if (!instMax) { const m = gl.getParameter(gl.MAX_TEXTURE_SIZE); if (!m) return 0; instMax = Math.min(m, 8192); }
    // (the cast shadows wholly clear: CAR3D_FS's low-sun factor 1 - (1 - smoothstep(0.17, 0.5, w)) * smoothstep(0, 0.05,
    // w) is 0 exactly for w (uLook.w) in [0.05, 0.17]; kept off its edges)
    const castClear = urlQ.get("castlow") !== "0" && look[2] >= 0.0505 && look[2] <= 0.1695;
    const chunk = Math.floor(instMax / 3);   // (at most 3 records an item: past it (never yet), in turns, in order)
    let draws = 0;
    gl.disable(gl.CULL_FACE);
    for (let c0 = 0; c0 < items.length; c0 += chunk) {
      const its = items.length <= chunk ? items : items.slice(c0, c0 + chunk);
      const need = its.length * 3 * R;
      if (instStage.length < need) { instStage = new Float32Array(need * 2); instOut = new Float32Array(need * 2); }
      // (DYS-266 zoom-gc: units and batches by count, written by number: a list's length cut to 0 lets V8 drop its store,
      // made again by the next pushes; each batch's units the same, bt.nu of them)
      const S = instStage, units = GC_DIET ? UNITS_A : [];
      let nUn = 0;
      if (GC_DIET) fpvN = fpiN = nU = nB = 0;   // (DYS-265 zoom-gc: this chunk's outlines, units and batches)
      let nr = 0;
      const put = (o, a) => { for (let k = 0; k < a.length; k++) S[o + k] = a[k]; };
      // (a record: the model -> layer clip (0-15), the model -> room rotation (16-26, 19 the kind: 0 body, 1 the contact
      // shadow, 2 the cast one; 23 an eraser), the direction (28; 31: DYS-134's uL3K), uCar (32), uLook (40), the L3
      // squares (72-77))
      const rec = (kind, erase, mvp, rot, dir, car, lk, oc) => {
        const o = nr++ * R;
        S.fill(0, o, o + R);
        S.set(mvp, o);
        if (GC_DIET) {   // (DYS-149 gc-diet: the same floats, written straight in)
          S[o + 16] = rot[0]; S[o + 17] = rot[1]; S[o + 18] = rot[2]; S[o + 19] = kind; S[o + 20] = rot[3]; S[o + 21] = rot[4]; S[o + 22] = rot[5];
          S[o + 23] = erase; S[o + 24] = rot[6]; S[o + 25] = rot[7]; S[o + 26] = rot[8]; S[o + 27] = 0;
          put(o + 28, dir); put(o + 32, car);
          if (lk) put(o + 40, lk);
          S[o + 72] = oc[0]; S[o + 73] = oc[1]; S[o + 74] = oc[2]; S[o + 75] = oc[3]; S[o + 76] = oc[4] ?? 0; S[o + 77] = oc[5] ?? 0;
          return o;
        }
        put(o + 16, [rot[0], rot[1], rot[2], kind, rot[3], rot[4], rot[5], erase, rot[6], rot[7], rot[8], 0]);
        put(o + 28, dir); put(o + 32, car);
        if (lk) put(o + 40, lk);
        put(o + 72, [oc[0], oc[1], oc[2], oc[3], oc[4] ?? 0, oc[5] ?? 0]);
        return o;
      };
      for (const it of its) {
        if (GC_DIET) { instItem(it); continue; }
        if (it.p) {
          // (an eraser: the parked car's silhouette, prius L1)
          const t = it.p.t, d = it.d, C0 = it.C0, dir = [t[0] / d, t[1] / d, t[2] / d];
          const oc = occl3Of(dir[0], dir[1], dir[2]);
          const o = rec(0, 1, mul4(Lm, it.C), [C0[0], C0[1], C0[2], C0[4], C0[5], C0[6], C0[8], C0[9], C0[10]], dir, [d, 1, 0, 0], null, oc);
          units.push({ key: KEY_ERASE, r0: o / R, n: 1, ...footprint(it.C, [meshGL.boxes.prius[1]], W, H) });
          continue;
        }
        const { i, C, mir } = it.c;
        const b = i * F, model = models[D[b + 17]];
        const mvp = mul4(Lm, C), rot = [D[b + 3] * mir, D[b + 4] * mir, D[b + 5] * mir, D[b + 6], D[b + 7], D[b + 8], D[b + 9], D[b + 10], D[b + 11]];
        const car = [D[b + 12], D[b + 13], D[b + 14], D[b + 15]], dir = [D[b + 22], D[b + 23], D[b + 24]];
        const oc = occl3Of(dir[0], dir[1], dir[2]), dirK = l3K ? [...dir, l3K(dir[0], dir[1], dir[2])] : dir;
        const lk = [(D[b + 12] * DEG) / it.c.ppd, look[0], look[1], look[2]];
        // its shadows first: the contact shadow, then (in sun) the cast one; one unit
        const L = D[b + 25], B = D[b + 26], Ht = D[b + 27];
        const [cw, cl, cy, tier, wb] = shadowShape(model, meshMeta.models[model].kind), fx = /lyft|bike|moto|mt07/.test(model) ? 0.2 : 0.43 * B;
        const shA = [fx, L / 2, fx * cw, L * cl], shC = [ambShare, Math.max(0.05, fx - 0.12), L * wb, 0];
        let qa = [0, 0, (fx + 0.6) * mir, 0], qb = [0, L / 2 + 0.6, 0, 0];
        let o = rec(1, 0, mvp, rot, dirK, car, lk, oc);
        put(o + 36, [D[b + 16], fog, 1, evW]); put(o + 52, shA); put(o + 60, shC); put(o + 64, qa); put(o + 68, qb);
        const r0 = o / R, quads = [quadPts(qa, qb)];
        const cs = castClear ? null : castShadow(D, b, sun, sunOn, L, B, Ht);
        if (cs) {
          const { Ls, ux, uy, eu, ew } = cs;
          qa = [ux * Ls / 2 * mir, uy * Ls / 2, ux * (eu + Ls / 2) * mir, uy * (eu + Ls / 2)]; qb = [-uy * ew * mir, ux * ew, 0, 0];
          o = rec(2, 0, mvp, rot, dirK, car, lk, oc);
          put(o + 36, [D[b + 16], fog, shadeA, evW]); put(o + 52, shA); put(o + 56, [ux * Ls * mir, uy * Ls, tier, L * cy]); put(o + 60, shC);
          put(o + 64, qa); put(o + 68, qb);
          quads.push(quadPts(qa, qb));
        }
        units.push({ key: KEY_QUADS, r0, n: cs ? 2 : 1, ...footprint(C, quads, W, H) });
        // then the body, at the LOD its size on the screen calls for (as the loop)
        const lenPx = Math.max(it.c.box[2] - it.c.box[0], it.c.box[3] - it.c.box[1]);
        const lod = carLod >= 0 ? Math.min(carLod, meshGL.ranges[model].length - 1) : lenPx >= CAR_LOD_PX[0] ? 0 : lenPx >= CAR_LOD_PX[1] ? 1 : 2;
        o = rec(0, 0, mvp, rot, dirK, car, lk, oc);
        put(o + 36, [D[b + 16], fog, 0, evW]); put(o + 44, [D[b + 19], D[b + 20], D[b + 21]]); put(o + 48, [...glintCar(D[b + 28], D[b + 29]), D[b + 27]]);
        units.push({ key: D[b + 17] * 8 + lod, r0: o / R, n: 1, ...footprint(C, [meshGL.boxes[model][lod]], W, H) });
      }
      // (DYS-149 gc-diet) one item's records and units as the loop below makes them, through the arrays kept for it (MVP
      // M16, ROT, DIR, CAR, LK, SHA, SHC, QA, QB, the shadow's shape by model, OC): the same floats and units in the same
      // order. quadPts copies qa and qb before the cast shadow's overwrite them, as before
      function instItem(it) {
        if (it.p) {
          const t = it.p.t, d = it.d, C0 = it.C0, dir = DIR, rot = ROT, car = CAR;
          dir[0] = t[0] / d; dir[1] = t[1] / d; dir[2] = t[2] / d;
          const oc = occl3Of(dir[0], dir[1], dir[2]);
          rot[0] = C0[0]; rot[1] = C0[1]; rot[2] = C0[2]; rot[3] = C0[4]; rot[4] = C0[5]; rot[5] = C0[6]; rot[6] = C0[8]; rot[7] = C0[9]; rot[8] = C0[10];
          car[0] = d; car[1] = 1; car[2] = 0; car[3] = 0;
          const o = rec(0, 1, mul4(Lm, it.C, M16), rot, dir, car, null, oc);
          units[nUn++] = footprintK(it.C, meshGL.boxes.prius[1], null, W, H, unitOf(KEY_ERASE, o / R, 1));   // (DYS-265 zoom-gc)
          return;
        }
        const { i, C, mir } = it.c;
        const b = i * F, model = models[D[b + 17]];
        const mvp = mul4(Lm, C, M16), rot = ROT, car = CAR, dir = DIR, lk = LK;
        rot[0] = D[b + 3] * mir; rot[1] = D[b + 4] * mir; rot[2] = D[b + 5] * mir; rot[3] = D[b + 6]; rot[4] = D[b + 7]; rot[5] = D[b + 8];
        rot[6] = D[b + 9]; rot[7] = D[b + 10]; rot[8] = D[b + 11];
        car[0] = D[b + 12]; car[1] = D[b + 13]; car[2] = D[b + 14]; car[3] = D[b + 15];
        dir[0] = D[b + 22]; dir[1] = D[b + 23]; dir[2] = D[b + 24];
        const oc = occl3Of(dir[0], dir[1], dir[2]);
        lk[0] = (D[b + 12] * DEG) / it.c.ppd; lk[1] = look[0]; lk[2] = look[1]; lk[3] = look[2];
        const L = D[b + 25], B = D[b + 26], Ht = D[b + 27];
        const sh = shapeOf(model, meshMeta.models[model].kind), cw = sh[0], cl = sh[1], cy = sh[2], tier = sh[3], wb = sh[4];
        const fx = /lyft|bike|moto|mt07/.test(model) ? 0.2 : 0.43 * B;
        const shA = SHA, shC = SHC, qa = QA, qb = QB;
        shA[0] = fx; shA[1] = L / 2; shA[2] = fx * cw; shA[3] = L * cl;
        shC[0] = ambShare; shC[1] = Math.max(0.05, fx - 0.12); shC[2] = L * wb; shC[3] = 0;
        qa[0] = 0; qa[1] = 0; qa[2] = (fx + 0.6) * mir; qa[3] = 0; qb[0] = 0; qb[1] = L / 2 + 0.6; qb[2] = 0; qb[3] = 0;
        let o = rec(1, 0, mvp, rot, dir, car, lk, oc);
        S[o + 36] = D[b + 16]; S[o + 37] = fog; S[o + 38] = 1; S[o + 39] = evW;
        put(o + 52, shA); put(o + 60, shC); put(o + 64, qa); put(o + 68, qb);
        // (DYS-265 zoom-gc: the quads' corners in QP, the cast shadow in CS, the units from the pool)
        const r0 = o / R, q0 = quadPts(qa, qb, QP[0]);
        let q1 = null;
        const cs = castClear ? null : castShadow(D, b, sun, sunOn, L, B, Ht, CS);
        if (cs) {
          const { Ls, ux, uy, eu, ew } = cs;
          qa[0] = ux * Ls / 2 * mir; qa[1] = uy * Ls / 2; qa[2] = ux * (eu + Ls / 2) * mir; qa[3] = uy * (eu + Ls / 2);
          qb[0] = -uy * ew * mir; qb[1] = ux * ew; qb[2] = 0; qb[3] = 0;
          o = rec(2, 0, mvp, rot, dir, car, lk, oc);
          S[o + 36] = D[b + 16]; S[o + 37] = fog; S[o + 38] = shadeA; S[o + 39] = evW; put(o + 52, shA);
          S[o + 56] = ux * Ls * mir; S[o + 57] = uy * Ls; S[o + 58] = tier; S[o + 59] = L * cy; put(o + 60, shC);
          put(o + 64, qa); put(o + 68, qb);
          q1 = quadPts(qa, qb, QP[1]);
        }
        units[nUn++] = footprintK(C, q0, q1, W, H, unitOf(KEY_QUADS, r0, cs ? 2 : 1));
        const lenPx = Math.max(it.c.box[2] - it.c.box[0], it.c.box[3] - it.c.box[1]);
        const lod = carLod >= 0 ? Math.min(carLod, meshGL.ranges[model].length - 1) : lenPx >= CAR_LOD_PX[0] ? 0 : lenPx >= CAR_LOD_PX[1] ? 1 : 2;
        o = rec(0, 0, mvp, rot, dir, car, lk, oc);
        S[o + 36] = D[b + 16]; S[o + 37] = fog; S[o + 38] = 0; S[o + 39] = evW; S[o + 44] = D[b + 19]; S[o + 45] = D[b + 20]; S[o + 46] = D[b + 21];
        const gk = glintCar(D[b + 28], D[b + 29]);
        S[o + 48] = gk[0]; S[o + 49] = gk[1]; S[o + 50] = D[b + 27];
        units[nUn++] = footprintK(C, meshGL.boxes[model][lod], null, W, H, unitOf(D[b + 17] * 8 + lod, o / R, 1));
      }
      // the batches: a unit goes back past batches none of whose units it overlaps, to the latest of its kind
      // (DYS-265 zoom-gc: with the switch on, the batches from the pool and the outlines in FPV, the same tests in order)
      const batches = GC_DIET ? BATCHES_A : [];
      if (GC_DIET) {
        let nBt = 0;
        for (let q = 0; q < nUn; q++) {
          const un = units[q];
          let t = null;
          for (let k = nBt - 1, k0 = Math.max(0, nBt - INST_WALK); k >= k0; k--) {
            const bt = batches[k];
            if (bt.key === un.key) { t = bt; break; }
            if (boxHit(bt.box, un.box) && anyHit(bt.units, un, bt.nu)) break;
          }
          if (!t) batches[nBt++] = (t = batchOf(un.key));
          t.units[t.nu++] = un;
          const x = t.box, y = un.box;
          x[0] = Math.min(x[0], y[0]); x[1] = Math.min(x[1], y[1]); x[2] = Math.max(x[2], y[2]); x[3] = Math.max(x[3], y[3]);
        }
        batches.length = nBt;
      }
      for (const un of GC_DIET ? NONE : units) {
        let t = null;
        for (let k = batches.length - 1, k0 = Math.max(0, batches.length - INST_WALK); k >= k0; k--) {
          const bt = batches[k];
          if (bt.key === un.key) { t = bt; break; }
          if (boxHit(bt.box, un.box) && (GC_DIET ? anyHit(bt.units, un) : bt.units.some((v) => unitHit(v, un)))) break;
        }
        if (!t) batches.push((t = GC_DIET ? batchOf(un.key) : { key: un.key, units: [], box: [Infinity, Infinity, -Infinity, -Infinity], first: 0, n: 0 }));
        t.units.push(un);
        const x = t.box, y = un.box;
        x[0] = Math.min(x[0], y[0]); x[1] = Math.min(x[1], y[1]); x[2] = Math.max(x[2], y[2]); x[3] = Math.max(x[3], y[3]);
      }
      // the records in the batches' order, up in one call
      const O = instOut;
      let at = 0;
      for (const bt of batches) {
        bt.first = at;
        if (GC_DIET) {
          for (let q = 0; q < bt.nu; q++) { const un = bt.units[q], a = un.r0 * R, e = (un.r0 + un.n) * R, d = at * R - a; for (let k = a; k < e; k++) O[k + d] = S[k]; at += un.n; }   // (no view a unit)
        } else for (const un of bt.units) {
          O.set(S.subarray(un.r0 * R, (un.r0 + un.n) * R), at * R);
          at += un.n;
        }
        bt.n = at - bt.first;
      }
      let T = instT[slot];
      gl.activeTexture(gl.TEXTURE0 + UNITS.uInst);
      if (!T || T.rows < at) {
        if (T) gl.deleteTexture(T.tex);
        const rows = Math.min(instMax, Math.max(256, 2 ** Math.ceil(Math.log2(at))));
        T = instT[slot] = { tex: gl.createTexture(), rows };
        gl.bindTexture(gl.TEXTURE_2D, T.tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, INST_TEXELS, rows);
        // (nearest: a float texture filtered without OES_texture_float_linear is incomplete, and texelFetch reads zeros)
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
        tev("inst", `${slot ? "soft" : "sharp"} ${rows}`);
      } else gl.bindTexture(gl.TEXTURE_2D, T.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, INST_TEXELS, at, gl.RGBA, gl.FLOAT, O);
      // the draws
      let kind = -1, vao = null;
      for (const bt of batches) {
        const k = bt.key === KEY_QUADS ? 1 : bt.key === KEY_ERASE ? 2 : 0;
        if (k !== kind) { gl.depthMask(k !== 1); gl.blendFunc(k === 2 ? gl.ZERO : gl.ONE, gl.ONE_MINUS_SRC_ALPHA); kind = k; }
        gl.uniform1i(u.uInstBase, bt.first);
        if (k === 1) {
          if (vao !== vaoQuad) gl.bindVertexArray((vao = vaoQuad));
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bt.n);
        } else {
          const m = k === 2 ? "prius" : models[bt.key >> 3], lod = k === 2 ? 1 : bt.key & 7, [off, cnt] = meshGL.ranges[m][lod];
          if (vao !== meshGL.vaos[m][lod]) gl.bindVertexArray((vao = meshGL.vaos[m][lod]));
          gl.drawElementsInstanced(gl.TRIANGLES, cnt, gl.UNSIGNED_SHORT, off, bt.n);
        }
        draws++;
      }
    }
    gl.depthMask(true);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return draws;
  }

  function drawSprites(frame) {
    const e = env, M = cityState.moment;
    // hulls
    const nh = events.counts.hulls, nhh = hiPool ? events.counts.hullsHi || 0 : 0;
    if ((nh || nhh) && alb && nrm && !atlasJob && P.hull.ok) {
      const u = P.hull.u;
      gl.useProgram(P.hull.p);
      panoUniforms(P.hull);
      gl.uniform2f(u.uSize, frame.width, frame.height);
      gl.uniform2f(u.uAtlas, atlasMeta.size[0], atlasMeta.size[1]);
      gl.uniform1f(u.uTime, reduced() ? 0 : simT);
      gl.uniform1f(u.uFog, e.fog);
      gl.uniform1f(u.uNight, e.night);
      gl.uniform1f(u.uFx, evW);
      const wh = e.white;
      const sunI = M ? M.sunI : 0.6, sunRGB = M ? M.sunRGB : [1, 1, 1];
      gl.uniform3f(u.uSunCol, ...wh.map((x, i) => x * sunRGB[i] * Math.min(1, sunI * 1.4) * 0.75));
      // sky ambient from the panorama itself (X2's open issue 6), dimmed at night
      const amb = lerp(0.38, 0.12, e.night), nk = 1 - 0.9 * e.night;
      gl.uniform3f(u.uSkyCol, ...e.high.map((x, i) => (x * 0.45 + wh[i] * 0.55) * amb * nk));
      gl.uniform3f(u.uLowCol, ...e.water.map((x) => x * 0.5 * nk));
      gl.uniform3f(u.uGlow, 1.0, 0.72, 0.42);
      // the ships' own light (ships-r1): lit windows show as the light outside falls (a little from sunset, fully in
      // the lights-only moments); the floodlights are switched on with the navigation lights at sunset
      const Lc = cityState.lighting, modeL = M ? M.mode.lights : e.night;
      if (u.uWinK) gl.uniform1f(u.uWinK, clamp(Math.max(modeL, 0.12 * Lc.lights, e.night), 0, 1));
      if (u.uFloodK) gl.uniform1f(u.uFloodK, Lc.lights * (0.35 + 0.65 * modeL));
      if (u.uLiveryBase) gl.uniform1f(u.uLiveryBase, atlasMeta.livery_base || 0.702);
      // (DYS-232 WATER: how much the swell breaks the boats' reflections; only in the program with boatsfx on)
      if (u.uSwell) gl.uniform1f(u.uSwell, e.wind);
      if (u.uDay) gl.uniform1f(u.uDay, Lc.day ?? 0);
      if (u.uWhite) gl.uniform3f(u.uWhite, wh[0], wh[1], wh[2]);   // (DYS-232 WATER: the sails' white)
      // the reflection: the hull's short and dark; at night the lights' columns run longer down the water
      if (u.uReflStretch) gl.uniform1f(u.uReflStretch, 0.7 + 0.9 * modeL);
      if (u.uRowK) gl.uniform1f(u.uRowK, 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // (DYS-232) the big ships' sharp pictures first, from the pool (their cells in its px), the 1x atlas's over them
      // (a ship moving to its sharp pictures: outside-events.js sharpShare); then the atlas back on its units
      if (nhh) {
        for (const [name, t] of [["uAlb", hiPool.alb], ["uNrm", hiPool.nrm], ["uNgt", hiPool.ngt]]) { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t); }
        gl.uniform2f(u.uAtlas, hiPool.size[0], hiPool.size[1]);
        // (the boats' reflection, a ship's with ?shipwake=1 and E's side of it, scratch/D/ships/ship-wakes.patch: its
        // bands so many atlas rows high; the sharp pictures' rows are finer, by their px a metre against the 1x set's)
        if (u.uRowK) gl.uniform1f(u.uRowK, (shipDetail.meta.types.container?.px_per_m || 4) / (atlasMeta.types.container?.px_per_m || 1.4));
        gl.bindVertexArray(vaoHullHi);
        gl.bindBuffer(gl.ARRAY_BUFFER, vboHullHi);
        const hd = events.hullsHi;
        if (hd.byteLength > hullHiCap) { hullHiCap = hd.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, hullHiCap, gl.DYNAMIC_DRAW); }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, hd);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nhh);
        for (const [name, t] of [["uAlb", alb], ["uNrm", nrm], ["uNgt", ngt]]) { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t || dummy2d); }
        gl.uniform2f(u.uAtlas, atlasMeta.size[0], atlasMeta.size[1]);
        if (u.uRowK) gl.uniform1f(u.uRowK, 1);
      }
      if (nh) {
        gl.bindVertexArray(vaoHull);
        gl.bindBuffer(gl.ARRAY_BUFFER, vboHull);
        const data = events.hulls;
        if (data.byteLength > hullCap) { hullCap = data.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, hullCap, gl.DYNAMIC_DRAW); }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nh);
      }
    }
    // the street vehicles (v3/street-traffic): the hull program again, from the cars atlas (no window light: its
    // night pass is the empty texture); lit, hazed and hidden per pixel as the ships are
    const nc = events.counts.cars || 0;
    const q = tlog && (nc || events.counts.cars3d) ? gl.createQuery() : null;
    if (q) gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q);
    if (nc && carAlb && carNrm && !carJob && P.hull.ok) {
      const u = P.hull.u;
      gl.useProgram(P.hull.p);
      panoUniforms(P.hull);
      for (const [name, t] of [["uAlb", carAlb], ["uNrm", carNrm], ["uNgt", dummy2d]]) { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t); }
      gl.uniform2f(u.uSize, frame.width, frame.height);
      gl.uniform2f(u.uAtlas, carMeta.size[0], carMeta.size[1]);
      gl.uniform1f(u.uTime, reduced() ? 0 : simT);
      gl.uniform1f(u.uFog, e.fog);
      gl.uniform1f(u.uNight, e.night);
      gl.uniform1f(u.uFx, evW);
      const wh = e.white;
      const sunI = M ? M.sunI : 0.6, sunRGB = M ? M.sunRGB : [1, 1, 1];
      gl.uniform3f(u.uSunCol, ...wh.map((x, i) => x * sunRGB[i] * Math.min(1, sunI * 1.4) * 0.75));
      const amb = lerp(0.38, 0.12, e.night), nk = 1 - 0.9 * e.night;
      gl.uniform3f(u.uSkyCol, ...e.high.map((x, i) => (x * 0.45 + wh[i] * 0.55) * amb * nk));
      gl.uniform3f(u.uLowCol, ...e.water.map((x) => x * 0.5 * nk));
      gl.uniform3f(u.uGlow, 1.0, 0.72, 0.42);
      if (u.uWinK) gl.uniform1f(u.uWinK, 0);
      if (u.uFloodK) gl.uniform1f(u.uFloodK, 0);
      if (u.uLiveryBase) gl.uniform1f(u.uLiveryBase, carMeta.livery_base || 0.702);
      gl.bindVertexArray(vaoCar);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboCar);
      const data = events.cars;
      if (data.byteLength > carCap) { carCap = data.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, carCap, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nc);
      // (the ships' atlas back on its units for anything later in the frame)
      for (const [name, t] of [["uAlb", alb], ["uNrm", nrm], ["uNgt", ngt]]) { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t || dummy2d); }
    }
    drawCars3d(frame);
    if (q) { gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE); tlog.q.push([q, tlog.rows.length + (tlog.cut || 0)]); }
    else if (tlog) tlog.pendingNone = true;
    // points and sky dots
    const np = events.counts.points;
    if (np && P.pts.ok) {
      const u = P.pts.u;
      gl.useProgram(P.pts.p);
      panoUniforms(P.pts);
      gl.uniform2f(u.uSize, frame.width, frame.height);
      if (u.uTime) gl.uniform1f(u.uTime, reduced() ? 0 : simT);
      if (u.uFog) gl.uniform1f(u.uFog, e.fog);
      if (u.uFx) gl.uniform1f(u.uFx, evW);
      gl.bindVertexArray(vaoPts);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboPts);
      const data = events.points;
      if (data.byteLength > ptsCap) { ptsCap = data.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, ptsCap, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, np);
    }
    // DYS-227: the gulls, the nearest of the city's events (30-150 m), over everything else outside
    if (gullR && (events.gullCount || gullR.busy)) {
      gullR.draw(events.gulls3d, events.gullCount, { W: frame.width, H: frame.height, vp: camInfo.vp, eye: camInfo.eyeWorld, origin: E0,
        rect: frame.window.rect, light: gullMod.gullLight(e, M, AXIS), fog: e.fog, fx: evW, vaoEmpty, now: performance.now(), soft: gullSoft,
        ppr: camInfo.pxPerRad });
    }
    gl.disable(gl.BLEND);
  }

  // the halo: the outside as just drawn, halved twice by the GPU's own filter, bright-passed and blurred at 1/8
  function haloPrep(frame) {
    // (DYS-149: not at full zoom (roomW 0): its targets' one reader, the halo pass below, returns at roomW <= 0, and at
    // any roomW above 0 reads them only when this frame's render drew them (renderedAt), so this prep then. 2 blits and
    // 5 draws over 7 small targets a zoomed frame saved. Not in the outside-only debug view (its copy is made here).
    // ?zoomcaps=0: as before)
    if (engine.zoomSkip && (frame.roomW ?? 1) <= 0 && !outsideOnly) return;
    // (the framebuffer the outside was just drawn into: the engine's display target, or the canvas itself (null) on a
    // frame drawn straight into it, DYS-149 S9 canvas-direct. Read before sizeTargets, which leaves the canvas bound when
    // it makes the targets: a frame at a new size (a resize, a new moving scale) read the canvas, not the display target)
    const src = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    sizeTargets(frame.width, frame.height);
    gl.disable(gl.SCISSOR_TEST);
    const blit = (from, fw, fh, to, filter = gl.LINEAR) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fb);
      gl.blitFramebuffer(0, 0, fw, fh, 0, 0, to.w, to.h, gl.COLOR_BUFFER_BIT, filter);
    };
    if (copyT) blit(src, frame.width, frame.height, copyT, gl.NEAREST);
    if (!P.bright.ok || !P.blur.ok || opts.halo === false) return;
    // (DYS-149 mv-lite: a phone's moving frame (the room's camera, or zoomed the outside's: frame.outsideMoving) takes a
    // cheaper way to the same 1/8 picture. The frame is clear outside the window's box here (the outside is drawn only
    // inside it; the room is laid over it later), so only that box, out to 8 px, is halved into h2 (cleared first: the
    // rest of h2 is the zeros a whole blit gives); and the bright pass reads h2 itself, 4 bilinear taps 2 texels apart,
    // each the mean of 2 x 2: the 4 x 4 box h4 and its own 2 x 2 taps make (only h4's rounding to 8 bits is gone). One
    // blit and its pass fewer, and at the desk ~half the frame's pixels read (the window ~45 % of them). At rest, and at
    // an odd size, as before. ?mvlite=-halo: as before)
    const lite = mvLite("halo", frame) && !copyT && !(frame.width & 1) && !(frame.height & 1);
    if (lite) {
      const r = frame.window.rect, W = frame.width, H = frame.height;
      const x0 = Math.max(0, Math.floor(r[0] / 8) * 8), y0 = Math.max(0, Math.floor(r[1] / 8) * 8);
      const x1 = Math.min(W, Math.ceil((r[0] + r[2]) / 8) * 8), y1 = Math.min(H, Math.ceil((r[1] + r[3]) / 8) * 8);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, halo.h2.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (x1 > x0 && y1 > y0) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
        gl.blitFramebuffer(x0, y0, x1, y1, x0 / 2, y0 / 2, x1 / 2, y1 / 2, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      }
    } else {
      blit(src, frame.width, frame.height, halo.h2);
      blit(halo.h2.fb, halo.h2.w, halo.h2.h, halo.h4);
    }
    const hs = lite ? halo.h2 : halo.h4;
    gl.bindFramebuffer(gl.FRAMEBUFFER, halo.h8a.fb);
    gl.viewport(0, 0, halo.h8a.w, halo.h8a.h);
    gl.useProgram(P.bright.p);
    if (shaderMerge) gl.uniform1f(P.bright.u.uPass, 0);   // (DYS-216 #4, HALOPREP_FS: the bright pass's branch)
    gl.activeTexture(gl.TEXTURE0 + UNITS.uSrc);
    gl.bindTexture(gl.TEXTURE_2D, hs.tex);
    gl.uniform2f(P.bright.u.uTexel, 1 / hs.w, 1 / hs.h);
    gl.uniform1f(P.bright.u.uSpan, lite ? 2 : 1);
    gl.uniform1f(P.bright.u.uThreshold, opts.haloThreshold ?? 0.8);
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(P.blur.p);
    if (shaderMerge) gl.uniform1f(P.blur.u.uPass, 1);     // (... and the blur's)
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, halo.h8b.fb);
      gl.bindTexture(gl.TEXTURE_2D, halo.h8a.tex);
      gl.uniform2f(P.blur.u.uStep, 1 / halo.h8a.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, halo.h8a.fb);
      gl.bindTexture(gl.TEXTURE_2D, halo.h8b.tex);
      gl.uniform2f(P.blur.u.uStep, 0, 1 / halo.h8a.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // (DYS-149 mv-lite) this cheaper pass is on (engine.mvLite: phones, ?mvlite) and this is a moving frame: the room's
  // camera moved, or a zoom gesture moved the outside's (frame.outsideMoving, held 100 ms past its last change)
  function mvLite(k, frame) { return !!engine.mvLite?.[k] && (frame.state === "moving" || !!frame.outsideMoving); }

  // (DYS-149 mv-lite) the screen box [x, y, w, h] (GL px) outside which HALO_FS's mask is 0: its quad (the corners, in
  // either winding, as the shader takes them) grown by the feather F along each edge's inward normal, so its corners
  // mitred (m > 0 only where every edge's signed distance is over -F), 2 px more each way; null: the whole screen (a
  // quad not convex, which a window in front of the eye never is: the mitred box would not hold its mask)
  function haloBox(c, F, W, H) {
    let s = 0, pos = 0, neg = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4, k = (i + 2) % 4;
      s += (c[2 * j] - c[2 * i]) * (c[2 * j + 1] + c[2 * i + 1]);
      const cr = (c[2 * j] - c[2 * i]) * (c[2 * k + 1] - c[2 * j + 1]) - (c[2 * j + 1] - c[2 * i + 1]) * (c[2 * k] - c[2 * j]);
      if (cr > 0) pos++; else if (cr < 0) neg++;
    }
    if (pos && neg) return null;
    const sg = s > 0 ? -1 : 1, n = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4, ex = c[2 * j] - c[2 * i], ey = c[2 * j + 1] - c[2 * i + 1], l = Math.hypot(ex, ey);
      if (!(l > 1e-6)) return null;
      n.push([(-sg * ey) / l, (sg * ex) / l]);
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      // (corner i: where the edges before and after it, each moved out by F, meet)
      const a = n[(i + 3) % 4], b = n[i], det = a[0] * b[1] - a[1] * b[0];
      if (!(Math.abs(det) > 1e-3)) return null;
      const x = c[2 * i] - (F * (b[1] - a[1])) / det, y = c[2 * i + 1] - (F * (a[0] - b[0])) / det;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const bx0 = Math.max(0, Math.floor(x0) - 2), by0 = Math.max(0, Math.floor(y0) - 2);
    const bx1 = Math.min(W, Math.ceil(x1) + 2), by1 = Math.min(H, Math.ceil(y1) + 2);
    return [bx0, by0, bx1 - bx0, by1 - by0];
  }

  // (DYS-149 gc-diet: windowCorners's matrix, point and answer kept from frame to frame: the halo pass reads the answer
  // at once. The same numbers)
  const WC_M = new THREE.Matrix4(), WC_V = new THREE.Vector4(), WC_OUT = [0, 0, 0, 0, 0, 0, 0, 0];
  function windowCorners(frame) {
    if (GC_DIET && frame.window.corners.length === 4) {
      const m = WC_M.multiplyMatrices(frame.camera.projectionNoJitter, frame.camera.view), cs = frame.window.corners;
      for (let i = 0; i < 4; i++) {
        const c = cs[i], v = WC_V.set(c[0], c[1], c[2], 1).applyMatrix4(m);
        if (v.w <= 1e-4) return null;
        WC_OUT[2 * i] = (v.x / v.w * 0.5 + 0.5) * frame.width; WC_OUT[2 * i + 1] = (v.y / v.w * 0.5 + 0.5) * frame.height;
      }
      return WC_OUT;
    }
    // the opening's corners on screen through the room's own camera (the halo belongs to the glass, not the view)
    const m = new THREE.Matrix4().multiplyMatrices(frame.camera.projectionNoJitter, frame.camera.view);
    const out = [];
    for (const c of frame.window.corners) {
      const v = new THREE.Vector4(c[0], c[1], c[2], 1).applyMatrix4(m);
      if (v.w <= 1e-4) return null;
      out.push((v.x / v.w * 0.5 + 0.5) * frame.width, (v.y / v.w * 0.5 + 0.5) * frame.height);
    }
    return out;
  }

  // (QA ?trafficlog=1: the frame's row; the GPU's earlier answers filled in as they come)
  function logRow(frame, skip, t0) {
    if (!tlog) return;
    const c = events.counts, cars = cityState?.cars || [], ids = new Set(cars.map((v) => v.id));
    let fresh = 0;
    for (const id of ids) if (!tlog.ids.has(id)) fresh++;
    tlog.ids = ids;
    const r = tlog.rows;
    while (tlog.q.length && gl.getQueryParameter(tlog.q[0][0], gl.QUERY_RESULT_AVAILABLE)) {
      const [q, k] = tlog.q.shift(), row = r[k - (tlog.cut || 0)];
      if (row) row[9] = gl.getQueryParameter(q, gl.QUERY_RESULT) ? 1 : 0;
      gl.deleteQuery(q);
    }
    const pend = tlog.pendingNone; tlog.pendingNone = false;
    r.push([Math.round(performance.now() - tlog.t0), frame.state, skip, cityState ? +(cityState.T % 1e5).toFixed(2) : null, cars.length, fresh,
      c.cars || 0, c.cars3d || 0, c.streetPts || 0, skip ? -1 : pend ? -1 : null, +(tlog.w?.[0] ?? 0).toFixed(3), +(tlog.w?.[1] ?? 0).toFixed(3), +evW.toFixed(3),
      zoom ? +zoom.mag().toFixed(2) : 1, store.busy ? 1 : 0, zoom?.busy() ? 1 : 0, prev ? 1 : 0, +(performance.now() - t0).toFixed(1)]);
    if (r.length > 60000) { r.splice(0, 10000); tlog.cut = (tlog.cut || 0) + 10000; }
  }

  // ---------------------------------------------------------------- the passes
  const pass = {
    name: "outside", stage: "outside", order: 0, raw: true,
    init() {
      // a second call is a restored context: every GL object made before is gone, so the tiles, the aux maps, the
      // sprite atlas and the halo's targets are made again (stage 1's pictures are not: tiles at once)
      if (P) {
        store.lost();
        zoom?.lost();
        store.loadAux();
        ext = null; extJob = null; stage1Failed = true; tileW = 1;
        alb = nrm = ngt = null; halo = null; haloSpare = null; copyT = null; carAlb = carNrm = null;
        hiPool = null; shipDetail?.reset();   // (DYS-232: the sharp ships' cells asked for again as they are drawn)
        meshGL = null; carLayers[0] = carLayers[1] = null; if (meshMeta) meshMeta.ready = false;
        instT[0] = instT[1] = null;   // (DYS-149 smooth: the vehicles' instance records, made again at their next frame)
        occl.l0 = null; occl.atlas = null; occl.slots.clear(); occl.lru.length = 0; occl.up = []; occl.want.clear(); occl.gen++;
        upGen++;   // (DYS-149 fix 1b: the lost context's uploads under way stop; these go up by bands again)
        // (C's merges review 4: a reload that fails marks the occluders failed, as the first load does, so the street
        // traffic is drawn uncut (streetsW) rather than hidden for the rest of the visit)
        if (occl.meta) bitmapFrom(occlL0(occl.meta)).then(occlUp).catch((e) => { occl.failed = true; console.warn("[outside] occluders:", e.message); });
        if (atlasMeta) loadAtlas().then(([a, n, g]) => { upAtlas(atlasJob = { a, n, g }); }).catch(() => {});
        if (carSet) loadCars().then(([a, n]) => { upCars(carJob = { a, n }); }).catch(() => {});
      }
      initGL();
      if (gullMod) gullR = newGullR();   // (DYS-227: a restored context's gulls made again; the lost ones' objects went with it)
      if (WARM_EARLY === "1") warmEarly();   // (DYS-216 F: the first view's pipelines at init, ?warmearly=1)
    },
    // (DYS-216 F, ?warmearly=2) the engine's warm-up, once the room's programs are sent and its maps up: the outside's
    // first draws then, while the browser compiles the room's (warmEarly)
    warmBetween() { if (WARM_EARLY === "2" && !engine.timings.outsideWarmEarly) warmEarly(true); },
    update,
    // (DYS-149 fix 1b) resolves once the pictures under way to the GPU are in (the engine's hidden frames wait for it)
    // (DYS-149 TU2: and starts them: the warm-up's first call)
    uploads() { upGo(); return upChain; },
    // (DYS-149 warm-frame) the engine's warm-up runs these each in a task of its own just before its hidden frame: the
    // programs' links and fixed uniforms, then the city's first state, which that frame takes (warmPrograms, primeCity)
    warmSteps() { return warmSplit ? [warmPrograms, primeCity] : []; },
    // (DYS-149 traffic-resume: the engine's frames not drawn (covered by an open essay, out of view): the street traffic
    // kept with the clock, so the first frame after has no seconds of it to catch up in one task (city.js keepStreets))
    unseen() { city.keepStreets?.(holdT ?? clock.T() + tandemAt(performance.now()).off); },
    animating(frame) {
      if (zoom?.busy()) return true;
      // (v3/zoom-sharp: a held change looks again every frame until its sharp tiles are in: under reduced motion the
      // window otherwise stops drawing once the last tile is up, and the change would wait for the next frame forever)
      if (holdFor) return true;
      if (store.busy || extJob || atlasJob || (tileW > 0 && tileW < 1) || tileFade === null && !stage1Failed && tileW < 1) return true;
      if (reduced() !== lastReduced) { lastReduced = reduced(); stillDue = true; return true; }   // switched: draw the change once
      if (reduced()) return !drawnOnce || !!prev || stillDue;
      return true;    // clouds, water, traffic: the window is alive
    },
    render(ctx, frame) {
      const t0 = performance.now();
      upGo();   // (DYS-149 TU2: a page with no warm-up starts the uploads at its first frame)
      const now = frame.time;
      if (!pair || !env) { logRow(frame, "env", t0); return; }
      prepare(frame);
      // uploads first (three.js state is reset after this pass): capped per frame while the camera moves (perf #1)
      // (one budget with the close-up tier: what its step uploaded this frame comes off the panorama's share, perf-r2)
      // (DYS-149: and while a zoom gesture moves the outside's own camera (frame.outsideMoving, phones), not the room's)
      // (DYS-203 HS1: and through the hand-off's visible part, handTail, where pictures go up whole (WebKit, iPhone UAs: no
      // timed strips, pano.js BANDS): one whole tile a frame, not REST_UPLOAD_BYTES' several and a part of one more, each
      // part converting the whole picture there. Blink's strips are timed at UPLOAD_MS a frame already: as before)
      if (frame.state === "moving" || frame.outsideMoving) store.pump(now, Math.max(0, store.budget - (engine.hiTier?.spent || 0)));
      else if (handBusy && whole) store.pump(now, Infinity, 1);
      else store.pump(now, REST_UPLOAD_BYTES);
      zoom?.pump(now, frame);
      // (DYS-149 fix 1b: the first-paint stills, the sprite atlases and the occluders' L0 are no longer uploaded here:
      // spread() takes them to the GPU between frames, upExt / upAtlas / upCars / occlUp)
      if (meshData && !meshGL) uploadMeshes();
      occlPump();
      if (tileW >= 1 && ext) {     // stage 1 is over: free the first-paint images
        gl.deleteTexture(ext.a); if (ext.b) gl.deleteTexture(ext.b); ext = null;
      }
      if (P.car3d.later) leanCars();   // (DYS-216 F, ?compilelean=1: made after the room is shown)
      gullsLate();   // (DYS-227: the gulls' module, after the room is shown)
      P.car3d.check(); P.carLayer.check();   // (the street vehicles' 3D pass: drawn once both are linked)
      if (!P.back.check() | !P.pts.check() | !P.hull.check() | !P.bright.check() | !P.blur.check() | !P.halo.check() | !P.copy.check()) {
        if (!P.back.ok) { logRow(frame, "prog", t0); return; }
      }
      const haveSource = (ext && tileW < 1) || tileW >= 1 && momentReady(slotIds[0]) && store.aux;
      if (!haveSource) { logRow(frame, "source", t0); return; }
      const rect = frame.window.rect;
      const drawFb = repeat ? gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) : null;
      gl.viewport(0, 0, frame.width, frame.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(rect[0], rect[1], rect[2], rect[3]);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      bindAll(frame);
      drawBackdrop(frame);
      if (debug !== 2 && debug !== 3) drawSprites(frame);
      haloPrep(frame);
      // QA (?orepeat=K): draw the outside K more times, so a bench can take the GPU's share from the slope
      for (let k = 0; k < repeat; k++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, drawFb);
        gl.viewport(0, 0, frame.width, frame.height);
        gl.enable(gl.SCISSOR_TEST);
        bindAll(frame); drawBackdrop(frame); drawSprites(frame); haloPrep(frame);
      }
      renderedAt = frame.index;
      stillDue = false;
      if (!drawnOnce) { drawnOnce = true; readyResolve(); }
      perf.gpuSubmitMs = performance.now() - t0;
      perf.frames++;
      logRow(frame, "", t0);
    },
    resize() {},
    dispose() {
      clearTimeout(tilesT);   // (HT1)
      if (handBusy) { handBusy = false; clearTimeout(calmT); calmOpen(); }   // (HS1: what waits on it sees upGen and stops)
      upGen++; upGo();   // (DYS-149 fix 1b: uploads under way stop, their textures deleted; TU2: ones not started yet let their pictures go)
      zoom?.dispose();
      store.dispose();
      statsRun.dispose();
      city.dispose?.();   // (DYS-149 SL review: the streets' worker)
      sigGone = true;     // (DYS-204: signals.json arriving later is let go)
      for (const p of new Set(Object.values(P || {}))) gl.deleteProgram(p.p);   // (DYS-216 #4: a merged program once)
      for (const set of [halo, haloSpare]) if (set) for (const k of ["h2", "h4", "h8a", "h8b"]) freeTarget(gl, set[k]);
      freeTarget(gl, copyT);
      for (const t of [dummy2d, alb, nrm, ngt, ext?.a, ext?.b, instT[0]?.tex, instT[1]?.tex]) if (t) gl.deleteTexture(t);
      gl.deleteTexture(dummyArr);
    },
  };
  const haloPass = {
    name: "outside-halo", stage: "overlay", order: 0, raw: true,
    render(ctx, frame) {
      if (!drawnOnce || !halo || !P.halo.ok || opts.halo === false || renderedAt !== frame.index || (frame.roomW ?? 1) <= 0) return;
      const corners = windowCorners(frame);
      if (!corners) return;
      const u = P.halo.u;
      gl.viewport(0, 0, frame.width, frame.height);
      gl.disable(gl.SCISSOR_TEST);
      // (DYS-149 mv-lite: on a phone's moving frame drawn only where its mask can be above 0 (haloBox), not over the
      // whole screen: outside that this pass adds 0 to the colours; it only set the display's alpha to 1 there, which
      // nothing reads (the canvas has none). ?mvlite=-halo: the whole screen)
      // (DYS-149 box-only: so on every frame, at rest and in the zoom's fades too (engine.boxOnly; window-cost 31 Oct,
      // lever 2: a full-screen pass every 30 Hz rest frame for colours it leaves as they are). The same pixels: outside
      // the box m is 0, so the shader gives (0, 0, 0, 1) and ONE, ONE_MINUS_SRC_COLOR leaves the colours bit for bit; only
      // the display's alpha there is no longer set to 1, and nothing after takes it (engine.js boxOnly). ?boxonly=0: the
      // whole screen but on a phone's moving frames, as before)
      if (engine.boxOnly || mvLite("halo", frame)) {
        const b = haloBox(corners, 0.012 * frame.width, frame.width, frame.height);
        if (b && (b[2] <= 0 || b[3] <= 0)) return;
        if (b) { gl.enable(gl.SCISSOR_TEST); gl.scissor(b[0], b[1], b[2], b[3]); }
      }
      gl.useProgram(P.halo.p);
      gl.activeTexture(gl.TEXTURE0 + UNITS.uHalo);
      gl.bindTexture(gl.TEXTURE_2D, halo.h8a.tex);
      gl.uniform2f(u.uSize, frame.width, frame.height);
      gl.uniform2fv(u.uCorners, corners);
      gl.uniform1f(u.uFeather, 0.012 * frame.width);
      gl.uniform1f(u.uStrength, (opts.haloStrength ?? HALO) * (frame.roomW ?? 1));   // (v3/zoom-r3: the glass's halo fades with the room)
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
    },
  };
  const debugPass = {
    name: "outside-debug", stage: "post", order: 100, raw: true,
    render(ctx, frame) {
      if (!copyT || !P.copy.ok) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, frame.width, frame.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(P.copy.p);
      gl.activeTexture(gl.TEXTURE0 + UNITS.uSrc);
      gl.bindTexture(gl.TEXTURE_2D, copyT.tex);
      gl.uniform2f(P.copy.u.uSize, frame.width, frame.height);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
  const handles = [engine.addPass(pass), engine.addPass(haloPass)];
  if (outsideOnly) handles.push(engine.addPass(debugPass));
  await extPromise;

  return {
    ready,
    store, meta, events, city, clock,
    sessionStart: T0,   // (DYS-239) the T this visitor's living layer started at: the welcome gull's, for the sound too
    get stage() { return tileW >= 1 ? "tiles" : ext ? "first-paint" : "loading"; },
    get tileW() { return tileW; },
    get info() {
      return {
        stage: this.stage, tileW: +tileW.toFixed(3), slots: slotIds, weights: weights.map((w) => +w.toFixed(3)),
        cars: { drawn: (events.counts.cars || 0) + (events.counts.cars3d || 0), sprites: events.counts.cars || 0, meshes: events.counts.cars3d || 0,
          occl: { rg: !!occl.meta?.rg, l0: !!occl.l0, l3: occl.slots.size, pending: occl.want.size + (occl.up?.length || 0), atlas: !!occl.atlas },   // (DYS-161 memory: QA)
          atlas: !!(carAlb && carNrm), meshReady: !!meshGL, meshLoading: !!meshLoad && !meshGL, meshW: meshGL && meshReadyAt !== null ? +smooth01((lastFrame.time - meshReadyAt) / MESH_FADE_MS).toFixed(2) : 0, layer: lastLayer, debug: carDebugInfo },   // (v3/street-traffic: the street vehicles drawn this frame)
        visible: { yaw: visible.yaw.map((x) => +x.toFixed(2)), el: visible.el.map((x) => +x.toFixed(2)), margin: visible.margin }, cols,
        store: store.stats(), events: events.counts, cpuMs: +perf.cpuMs.toFixed(2), travel: +travel.toFixed(3), simT: +simT.toFixed(2),
        eye: camInfo?.eye.map((x) => +x.toFixed(3)), stats: Object.fromEntries(stats), moment: cityState?.moment && { a: cityState.moment.a, b: cityState.moment.b, t: +cityState.moment.t.toFixed(3) },
        T: cityState?.T, clock: cityState?.clock && { date: cityState.clock.date, hour: +cityState.clock.hour.toFixed(3), dayType: cityState.clock.dayType },
        // the panorama's frame (and, for a merged panorama, which set each shown moment's tiles come from)
        pano: { axis: AXIS, eyeAsl: EYE_H, eyeShift: eyeShift.map((x) => +x.toFixed(3)), cityAxisShift: +city.axisShift.toFixed(4),
          source: meta.source || meta.fake || null, sets: slotIds.map((id) => (id ? meta.moments[id]?.set || "pano" : null)) },
        zoom: zoom ? zoom.info() : null,
        shipsHi: shipDetail ? shipDetail.info() : null,   // (DYS-232 QA: the sharp ships' pool)
        // v3/zoom-sharp: a magnified change waiting for its sharp tiles (the moment, for how long), the warmed bytes
        hold: holdFor && { id: holdFor.ids, ms: Math.round((lastFrame?.time ?? performance.now()) - holdFor.since), base: incomingDom ? baseOk.get(incomingDom) ?? null : null, l3: zoom ? incoming.map((id) => zoom.ready(id)) : null },
        warmKB: Math.round(warmBytes / 1024),
        // DYS-251: a chosen time on its way (pending: waiting for the picture), the city's offset (s), its events' weight
        // and the dissolve's share this frame
        tandem: tand ? { pending: !tand.fade, off: Math.round(tand.off), k: +tk.k.toFixed(3), p: +tk.p.toFixed(3) } : null,
      };
    },
    /** v3/zoom: the magnifier's hooks (shared/zoom.js), and a backdrop program made the outside's way from a source. */
    setZoom(z) { zoom = z; loadMeshes(); engine.requestFrame(); },
    /** (DYS-161 memory) The street traffic's L3 occluder atlas (3120 x 3120 RG8: 18.6 MB) given back: zoom.js, a phone
     * back at 1x for 8 s, as its 4x squares go (called inside a frame). The vehicles test against L0 until a magnified
     * view asks for its squares again (occlSlot makes the atlas again; the files come from the browser's cache).
     * Squares still on their way are let go as they land. True when there was one. */
    occlFree() {
      if (!occl.atlas) return false;
      gl.deleteTexture(occl.atlas.tex);
      for (const u of occl.up || []) letGo(u.b);
      occl.gen++;
      occl.atlas = null; occl.slots.clear(); occl.lru.length = 0; occl.up = []; occl.want.clear();
      engine.requestFrame();
      return true;
    },
    /** (DYS-161 memory) The L3 occluder atlas is on the GPU. */
    occlHeld: () => !!occl.atlas,
    /** v3/zoom-sharp: a neighbouring moment's panorama tiles for this view into the browser's cache (the magnifier's
     * idle prefetch); true while a fetch is under way. */
    warm,
    backdropProgram(fs) { return makeProgram(gl, G.FULL_VS, eyeSrc(fs), gl.getExtension("KHR_parallel_shader_compile")); },   // (DYS-149 window-cost: the magnifier's variant too)
    /** handover-r1: let a held stage 1 go (opts.holdFirstPaint), the live view dissolving in over ms once its tiles
     * are in; resolves when it is fully in. */
    release(ms = TILE_FADE_MS) {
      hold = false;
      tilesGo(0);   // (HT1: the live view wants its tiles now)
      fadeMs = Math.max(1, ms);
      engine.requestFrame();
      return tileW >= 1 ? Promise.resolve() : new Promise((r) => released.push(r));
    },
    get held() { return hold && tileW < 1; },
    /** (DYS-203 HT1) the router: ask for the window's tiles in ms (opts.tilesAfter); a later, sooner call wins */
    tilesGo,
    /** (DYS-203 HT1) what stage 1 draws over the photograph's pixels is in: the aux maps (water, sky mask) and the ships'
     * atlas, or failed (opts.netAfter asked for them late); true without netAfter, as before */
    get lookIn() { auxOut ||= store.auxState === "ready" || store.auxState === "failed"; return !netAfter || (auxOut && atlasOut); },
    /** (DYS-203 HT1) stage 1's pictures: { drawn: [a, b] URLs on the GPU, want: the ones on their way (or drawn) } */
    get firstPaintSrc() { return { drawn: extSrc, want: extWant }; },
    /** (DYS-203 HT1) stage 1 from these pictures ({ a, b, t, ids }, app.js exterior()) while it shows; false if not taken */
    retake,
    /** (QA, HT1) the tiles still held (tilesGo) */
    get tilesHeld() { return tilesHeld; },
    /** (DYS-203 HS1) the router: the hand-off's visible part begins (true: the crossfade) / is over (false) */
    handTail,
    /** (QA, HS1) the hand-off's gate shut (handTail) */
    get handBusy() { return handBusy; },
    /** v3/loading (?firstvisit): a camera move during the window's dissolve finishes it over ms (0: at once, as before) */
    set moveFade(ms) { moveFade = Math.max(0, +ms || 0); },
    /** the photograph's window -> the live view, 0..1 (1: the live view alone; QA, v3/loading's recordings) */
    get tileWeight() { return tileW; },
    /** handover-r1: count camera moves from the next frame on (the router calls it once it has placed the photograph's
     * camera; the warm-up's frames drew from the engine's default one) */
    rebase() { if (tileW < 1) { firstPose = null; moved = false; } },
    /** Tell the outside which moment pair to show ({ a, b, t } ids), or null for the clock's own. */
    setMoment(m) { opts.moment = m; engine.requestFrame(); },
    /** QA (park round 2): the rendered near layer on or off, and the debug view (2 = smear / tear), without a reload. */
    setNear(on) { noNear = !on; engine.requestFrame(); },
    setDebug(n) { debug = +n || 0; engine.requestFrame(); },
    /** windows_extra's dial x gain per shader slot this frame (slot 0: the dominant moment; v3/zoom's L3 reads it). */
    get wxDials() { return wxDials; },
    /** QA (windows_extra): hold every moment's dial at v (0 = off: nothing fetched), or null for the table's. */
    setExtra(v) { wxHold = v === null || v === undefined ? null : Math.max(0, +v || 0); engine.requestFrame(); },
    /** windows_extra's state: the dials per shown slot, which shown moments carry it, its tiles resident and failed,
     * whether it was ever asked for, and the two arrays' slots (they grow only when it is). */
    get extra() {
      const keys = [...store.where.keys()].filter((k) => { const [, kk, c] = k.split("|"); return (kk === "lights" && +c >= EXTRA.lightsCol) || (kk === "NB" && +c >= EXTRA.nearCol); });
      return { hold: wxHold, dials: wxDials.map((d) => +d.toFixed(3)), gains: slotIds.map((id) => (id ? wxGain(id) : null)), slots: slotIds,
        carries: slotIds.map((id) => (id ? { lights: hasExtra(meta, id, "lights"), near: hasExtra(meta, id, "NB") } : null)),
        lights: keys.filter((k) => k.includes("|lights|")).length, near: keys.filter((k) => k.includes("|NB|")).length, asked: { ...wxSeen },
        failed: [...store.failed].filter((k) => { const [, kk, c] = k.split("|"); return (kk === "lights" && +c >= EXTRA.lightsCol) || (kk === "NB" && +c >= EXTRA.nearCol); }),
        arrays: { lights: store.arrays.lights?.n ?? null, NB: store.arrays.NB?.n ?? null }, grown: store.grown || 0 };
    },
    /** The rendered near layer's state: on, its tiles resident (depth, front, back, L0), failed tiles. */
    get near2() {
      const n = meta.layers?.near2;
      if (!n) return { on: false, linked: false };
      const keys = [...store.where.keys()].filter((k) => /\|(N0|NB)\|/.test(k));
      const nb = keys.filter((k) => k.includes("|NB|")).map((k) => +k.split("|")[2]);
      return { on: !noNear && !!meta.geo.size.NB, linked: true, moments: n.moments?.length ?? null,
        depth: nb.filter((c) => c >= 14).length, front: nb.filter((c) => c < 7).length, back: nb.filter((c) => c >= 7 && c < 14).length,
        l0: keys.filter((k) => k.includes("|N0|")).length, failed: [...store.failed].filter((k) => /\|(N0|NB)\|/.test(k)) };
    },
    /** Follow the masthead's time (its onMoment detail): the dial's minutes, or null for now. */
    follow(d) {
      const m = d && Number.isFinite(d.minutes) ? d.minutes : null;
      if (m === followed) return;
      // (DYS-251: the time on screen, the city's, kept until the picture goes: see tand. Not under reduced motion, whose
      // still frame moves to the new time at once, nor before the outside's first frame)
      const now = performance.now(), cur = TANDEM && holdT === null && lastFrame ? tandemAt(now) : null, shown = cur ? clock.T() + cur.off : null;
      const drag = now - lastFollow < DIAL_MOVING_MS;
      lastFollow = now;
      followed = m;
      clock.set(m);
      if (cur) { const off = shown - clock.T(); tand = Math.abs(off) > TANDEM_MIN_S ? { off, since: now, k0: cur.k, fade: null, drag } : null; }
      if (holdT !== null && !opts.holdT) holdT = clock.T();   // reduced motion: the still frame moves to that time
      stillDue = true;
      engine.requestFrame();
    },
    passes: handles,
    dispose() { for (const h of handles) h.remove(); },
  };
}

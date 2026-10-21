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
import { loadPano, PanoStore, viewRange, throughWindow, columnsFor, MAX_MOMENTS, REST_UPLOAD_BYTES, NEAR_DEPTH, EXTRA, hasExtra } from "./pano.js";
import * as G from "./gl/outside.glsl.js";
import { createEvents, POINT_FLOATS, HULL_FLOATS, MAX_WAKES } from "./outside-events.js";
import { createCity } from "./city/city.js";
import { createClock } from "./city/clock.js";
import { LAMPS, windowsExtraDial, WINDOWS_EXTRA_GAIN } from "./city/tables.js";
import { pickFrames, sunPosition, getOverride, imageFormat, pickSize } from "./sky.js";
import { statsRunner } from "./outside-stats.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const smooth = (a, b, x) => smooth01((x - a) / (b - a));
const GLASS_Z = -1.40;                 // the window glass (engine z): the pivot of the mouse sway's head move
const TILE_FADE_MS = 300;              // plan 3.1: the panorama takes over in a deliberate 300 ms fade at rest
const GATE_FADE_MS = 3000;             // the light layers ease from "as baked" to the city clock's own windows
const FX_FADE_MS = 1500;               // the living effects and the city's events ease in after the canvas's first frame
const EXT_DEG_WIDTH = 2 * Math.atan(0.648) / DEG;   // the home exterior's horizontal field (cloud_motion is in its widths)
const HALO = 0.45;                     // the page's halation strength (app.js)
const FIRST_PAINT_EXT = { home_l: 1600, home_p: 720 };   // app.js FIRST_PAINT: the exterior widths the page paints first

// texture units, the same in every program
// (no program samples more than 14 of them: WebGL2 guarantees 16 per fragment shader, 32 in all)
// (the backdrop samples 16 with the near layer's two, uN0 and uNB: park round 2; the ships' night pass uNgt has its own
// unit, 19, so no program sees a 2D and an array sampler on one unit)
const UNITS = { uL0c: 0, uL1c: 1, uL1s: 2, uL2c: 3, uL2s: 4, uLights: 5, uClouds: 6, uMask: 7, uDepth: 8, uRoom: 9, uExtA: 10, uExtB: 11, uAlb: 12, uNrm: 13, uSrc: 14, uHalo: 14, uF1: 15, uF2: 16, uN0: 17, uNB: 18, uNgt: 19 };
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

function target(gl, w, h) {
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
  return { tex, fb, w: Math.max(1, w), h: Math.max(1, h) };
}
const freeTarget = (gl, t) => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } };

async function bitmapFrom(src) {
  if (src instanceof ImageBitmap) return src;
  const url = typeof src === "string" ? src : src.currentSrc || src.src;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
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

// ------------------------------------------------------------------------------------------------ the outside
export async function createOutside(engine, opts = {}) {
  const gl = engine.gl;
  const webRoot = opts.webRoot || new URL("../", import.meta.url).href;
  const [meta, scene, routes, atlasMeta] = await Promise.all([
    loadPano(opts.pano),
    opts.scene || fetch(webRoot + "scene.json").then((r) => r.json()),
    opts.routes || fetch(new URL("./city/routes.json", import.meta.url)).then((r) => r.json()),
    fetch(webRoot + "live/sprites/boats.json").then((r) => r.json()).catch(() => null),
  ]);
  const viewKey = opts.viewKey || "home_l";
  const frames = scene.frames;
  const byId = new Map(frames.map((f) => [f.id, f]));
  // the city in the panorama's frame: its eye height and room axis (pano.json), not routes.json's v2 constants
  const city = createCity(routes, { eyeAsl: meta.eye.asl_m, axisDeg: meta.axis_bearing_deg });
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
  let debug = opts.debug ?? +(urlQ.get("odebug") || 0);
  const outsideOnly = opts.outsideOnly ?? urlQ.get("outside") === "only";   // QA: the outside alone on the canvas
  const repeat = Math.max(0, Math.min(50, +(opts.repeat ?? urlQ.get("orepeat") ?? 0) || 0));   // QA: GPU cost by the slope
  let noNear = opts.noNear ?? urlQ.get("near") === "0";   // QA: without the rendered near layer (park round 2), to compare
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
  const events = createEvents({ axisDeg: AXIS, eye: E0, atlas: atlasMeta, eyeH: EYE_H, shift: eyeShift });

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
  const ask = (j, bmp, q, done) => { j.hold = true; statsRun.ask(bmp, q, (r) => { try { done(r); } finally { j.hold = false; } }); };
  store.pump = (now, budget) => {
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
    return pumpOrig(now, budget);
  };
  store.loadAux();

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
  const extPromise = !stage1Failed ? Promise.all([bitmapFrom(fp.a), fp.b && fp.b !== fp.a && fp.t > 0 ? bitmapFrom(fp.b) : null])
    .then(([a, b]) => { extJob = { a, b, t: b ? fp.t : 0, ids: fp.ids || [sel0.a.id, sel0.b.id] }; engine.requestFrame(); })
    .catch((e) => { console.warn("[outside] first-paint images:", e.message); stage1Failed = true; }) : Promise.resolve();

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
  let gateStart = null;
  let simT = 0, lastT = null, travel = 0;
  let pair = null;           // what is drawn: { a, b, t }
  let prev = null;           // a pair fading out after a jump: { a, b, t, start, dur }
  let slotIds = [null, null, null, null], weights = [0, 0, 0, 0];
  let env = null, cityState = null, camInfo = null, lastFrame = null, want0 = null, frameDt = 0;
  let visible = { yaw: [-30, 20], el: [-8, 18] }, cols = [];
  let holdT = opts.holdT ?? (reduced() ? T0 : null);   // reduced motion: the city exactly as it was when it began
  let fxW = 0;                           // the living effects' weight (0 on the first frame: the canvas matches the page)
  let evW = 0;                           // the city's events' weight (eases in with the effects; stays under reduced motion)
  let renderedAt = -1;                   // the frame index the outside last drew (the halo skips frames it didn't)
  let stillDue = false;                  // reduced motion was switched on: draw the still frame once
  let lastReduced = reduced();
  let followed = getOverride();          // the masthead's minutes the clock follows (null = now)
  const perf = { cpuMs: 0, updateMs: 0, frames: 0 };
  // v3/zoom: the window's magnifier (shared/zoom.js) hooks in here once someone magnifies; null until then (and the
  // outside is then exactly what it was)
  let zoom = null;

  const distPair = (p, q) => {
    const w = (x) => { const m = new Map([[x.a.id, 1 - x.t]]); m.set(x.b.id, (m.get(x.b.id) || 0) + x.t); return m; };
    const a = w(p), b = w(q);
    let d = 0;
    for (const id of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(id) || 0) - (b.get(id) || 0));
    return d / 2;
  };
  // the sky's L1 tiles only for a moment whose clouds are baked into it: with the clouds on their own layer the sky
  // is a smooth gradient, and L2 (16 px/deg) draws it the same (?skyl1=1 to compare)
  const skyL1 = (id) => !meta.moments[id]?.clouds || urlQ.get("skyl1") === "1";
  const TWO = !!meta.geo.size.F2;          // a two-layer panorama (plan v2 6): the far layer's L2 is always resident with its moment
  const momentReady = (id) => store.has(id, "L2c") && store.has(id, "L2s") && (!meta.moments[id]?.clouds || store.has(id, "clouds")) && (!TWO || store.has(id, "F2"));

  // ---------------------------------------------------------------- camera
  const tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(), rot = new THREE.Matrix4(), inv = new THREE.Matrix4();
  const ry = new THREE.Matrix4(), rx = new THREE.Matrix4(), view = new THREE.Matrix4(), vp = new THREE.Matrix4();
  function cameraFor(frame) {
    const c = frame.camera;
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
    return {
      rayM: rayM.elements.slice(), vp: Float64Array.from(vp.elements), eye: [eye.x - E0[0], eye.y - E0[1], eye.z - E0[2]],
      eyeWorld: eye.toArray(), width: frame.width, height: frame.height, pxPerRad, css: frame.dpr,
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
  let vaoEmpty, vaoPts, vboPts, vaoHull, vboHull, ptsCap = 0, hullCap = 0;
  let dummy2d, dummyArr, alb = null, nrm = null, ngt = null, atlasJob = null;
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
  if (atlasMeta) loadAtlas().then(([a, n, g]) => { atlasJob = { a, n, g }; }).catch((e) => console.warn("[outside] sprite atlas:", e.message));

  function initGL() {
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    P = {
      back: makeProgram(gl, G.FULL_VS, G.BACKDROP_FS, parallel),
      pts: makeProgram(gl, G.POINTS_VS, G.POINTS_FS, parallel),
      hull: makeProgram(gl, G.HULL_VS, G.HULL_FS, parallel),
      bright: makeProgram(gl, G.FULL_VS, G.BRIGHT_FS, parallel),
      blur: makeProgram(gl, G.FULL_VS, G.BLUR_FS, parallel),
      halo: makeProgram(gl, G.HALO_VS, G.HALO_FS, parallel),
      copy: makeProgram(gl, G.FULL_VS, G.COPY_FS, parallel),
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
    [[0, 4, 0], [1, 4, 16], [2, 4, 32], [3, 4, 48], [4, 4, 64], [5, 4, 80], [6, 3, 96], [7, 4, 108], [8, 4, 124]].forEach(([i, n, off]) => {
      gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, sh, off); gl.vertexAttribDivisor(i, 1);
    });
    gl.bindVertexArray(null);
    ptsCap = 0; hullCap = 0;
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
    if (want.a.id !== pair.a.id || want.b.id !== pair.b.id || Math.abs(want.t - pair.t) > 1e-6) {
      if (momentReady(want.a.id) && (want.t === 0 || momentReady(want.b.id))) {
        const d = distPair(pair, want);
        if (d > 0.03 && tileW >= 1) {
          if (!prev || (now - prev.start) / prev.dur > 0.5) prev = { ...pair, start: now, dur: reduced() ? 150 : Math.min(2500, Math.max(450, d * 2500 * 1.4)) };
        }
        pair = { a: want.a, b: want.b, t: want.t };
      } else if (tileW < 1 && !ext) {
        pair = { a: want.a, b: want.b, t: want.t };
      }
    }
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
    cityState = city.state(T, { sessionStart: T0 });
    // windows_extra: each shown moment's dial x its gain (0 for a moment without the group: nothing of it fetched or
    // drawn)
    const hr = cityState.clock?.hour ?? 0;
    wxDials = slotIds.map((id) => (id && (hasExtra(meta, id, "lights") || hasExtra(meta, id, "NB"))
      ? (wxHold !== null ? Math.max(0, wxHold) : windowsExtraDial(id, hr)) * wxGain(id) : 0));
    if (drawnOnce && gateStart === null) gateStart = now;
    const ramp = gateStart === null ? 0 : smooth01((now - gateStart) / FX_FADE_MS);
    // the living effects: off on the canvas's first frame (it matches the page), then easing in; off under reduced
    // motion (synthesize plan 2.2). The city's events ease in the same way, and stay (still) under reduced motion.
    fxW = opts.fx === 0 || reduced() ? 0 : ramp;
    evW = opts.fx === 0 ? 0 : reduced() ? 1 : ramp;
    lastFrame = frame;
    perf.updateMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- per frame, the camera's part (inside render)
  function prepare(frame) {
    const t0 = performance.now();
    const now = frame.time, dt = frameDt;
    camInfo = cameraFor(frame);
    // (the pose as text only until the camera first moves: "moved" never goes back; perf #13)
    const pose = moved ? null : JSON.stringify([frame.camera.position, frame.camera.quaternion, frame.camera.fovY]);
    if (!firstPose) firstPose = pose;
    const want = want0;
    const dom = pair.t < 0.5 ? pair.a : pair.b, oth = pair.t < 0.5 ? pair.b : pair.a;
    const ws = weights;

    // ---- what the camera sees through the window
    const rect = frame.window.rect;
    if (rect[2] > 0 && rect[3] > 0) {
      // the directions seen through the glass (rays that meet the wall around it don't count), from the room camera's
      // eye; the sway's few centimetres are inside the margin
      const through = throughWindow(frame.camera.position, frame.window.corners);
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
    const fading = slotIds.filter((id, i) => id && weights[i] > 0 && !drawn.includes(id));
    const order = [...new Set([wDom.id, ...(want.t > 0 ? [wOth.id] : []), dom.id, ...(ws[1] > 0 ? [oth.id] : []), ...fading])];
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
    store.want(list, now);
    zoom?.want(frame, { visible, dom: dom.id, weights: ws, cam: camInfo, needCity });

    // ---- stage 1 -> tiles
    const tileList = list.filter(([id, k, c]) => k !== "N0" && k !== "NB" && (drawn.includes(id) && (k !== "L0c" || wantL0) && k !== "lights" || (k === "lights" && c < EXTRA.lightsCol && drawn.includes(id))));
    const tilesReady = store.auxState === "ready" && momentReady(dom.id) && (!ws[1] || momentReady(oth.id)) && store.allResident(tileList);
    if (pose !== firstPose) moved = true;
    if (tileW < 1 && !opts.holdStage1 && !(hold && !moved)) {
      if (stage1Failed || (!ext && !extJob && tilesReady)) tileW = tilesReady ? 1 : 0;
      else if (tilesReady && moved) tileW = 1;
      else if (tilesReady && !tileFade) tileFade = now;
      if (tileFade !== null && tileW < 1) tileW = reduced() ? 1 : smooth01((now - tileFade) / fadeMs);
    }
    if (tileW >= 1 && released.length) for (const r of released.splice(0)) r();

    // ---- the clouds' travel, the city's events on screen
    const cssPerDeg = camInfo.pxPerRad * DEG / frame.dpr;
    const speed = Math.max((Math.abs(env.cloudDx) * EXT_DEG_WIDTH) / 60, 0.9 / Math.max(cssPerDeg, 1));
    if (tileW >= 1 && !reduced()) travel += speed * dt;
    events.fill(cityState, { cam: camInfo, stats: env });
    perf.cpuMs = perf.cpuMs * 0.9 + (perf.updateMs + performance.now() - t0) * 0.1;
  }

  // ---------------------------------------------------------------- per frame, GPU
  function bindAll(frame) {
    for (const [name, kind] of Object.entries(ARRAYS)) {
      gl.activeTexture(gl.TEXTURE0 + UNITS[name]);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, store.arrays[kind]?.tex || dummyArr);
    }
    const two = { uMask: store.aux?.mask, uDepth: store.aux?.depth, uRoom: roomTexture(frame), uExtA: ext?.a, uExtB: ext?.b || ext?.a, uAlb: alb, uNrm: nrm, uNgt: ngt };
    for (const [name, t] of Object.entries(two)) { gl.activeTexture(gl.TEXTURE0 + UNITS[name]); gl.bindTexture(gl.TEXTURE_2D, t || dummy2d); }
  }

  function panoUniforms(prog) {
    const u = prog.u, S = meta.geo.size;
    const set4 = (k, a) => u[k] && gl.uniform4f(u[k], a[0], a[1], a[2], a[3]);
    set4("uPano", [meta.yaw[0], meta.column_deg, meta.columns, meta.gutter]);
    set4("uBand", [meta.bands.city.el[0], meta.bands.city.el[1], meta.bands.sky.el[1], meta.aux.ppd]);
    if (u.uPpd) gl.uniform3f(u.uPpd, meta.bands.city.levels.L0 || 64, meta.bands.city.levels.L1, meta.bands.city.levels.L2);
    set4("uSizeL0", [...(S.L0c || [1, 1]), 1, 1]);
    set4("uSizeL1", [...S.L1c, ...S.L1s]);
    set4("uSizeL2", [...S.L2c, ...S.L2s]);
    set4("uSizeX", [...(S.lights || [1, 1]), ...(S.clouds || [1, 1])]);
    if (u.uAuxSize) gl.uniform2f(u.uAuxSize, ...(store.aux?.size || [1, 1]));
    if (u.uAuxOn) gl.uniform1f(u.uAuxOn, store.aux ? 1 : 0);
    if (u.uEyeH) gl.uniform1f(u.uEyeH, EYE_H);
    const slot = (id, kind, c) => (id ? store.slot(id, kind, c) : -1);
    const l0 = new Int32Array(8).fill(-1);
    for (let c = 0; c < meta.columns; c++) l0[c] = slot(slotIds[0], "L0c", c);
    if (u.uSlotL0) gl.uniform4iv(u.uSlotL0, l0);
    for (const [name, kind] of [["uSlotL1c", "L1c"], ["uSlotL1s", "L1s"], ["uSlotLt", "lights"], ["uSlotF1", "F1"]]) {
      if (!u[name]) continue;
      const a = new Int32Array(28).fill(-1);
      for (let c = 0; c < meta.columns; c++) for (let m = 0; m < MAX_MOMENTS; m++) a[c * 4 + m] = slot(slotIds[m], kind, c);
      gl.uniform4iv(u[name], a);
    }
    for (const [name, kind] of [["uSlotL2c", "L2c"], ["uSlotL2s", "L2s"], ["uSlotCl", "clouds"], ["uSlotF2", "F2"]]) {
      if (u[name]) gl.uniform4i(u[name], ...slotIds.map((id) => slot(id, kind, 0)));
    }
    // a moment whose whole-band tiles aren't resident can't be drawn: its share goes to the dominant moment
    if (u.uW) {
      const w = weights.slice();
      for (let m = 1; m < 4; m++) if (w[m] > 0 && !(slotIds[m] && momentReady(slotIds[m]))) { w[0] += w[m]; w[m] = 0; }
      gl.uniform4f(u.uW, ...w);
    }
    // the live camera, for every program (the sprites look along their own pixels' rays to find what hides them)
    if (u.uViewport) gl.uniform4f(u.uViewport, 0, 0, camInfo.width, camInfo.height);
    if (u.uRayM) gl.uniformMatrix4fv(u.uRayM, false, camInfo.rayM);
    // (v3/zoom: magnified, the parallax eases off, eyeK -> 0: the magnified view is the panorama's own pixels)
    if (u.uEye) { const k = zoom ? zoom.eyeK() : 1; gl.uniform3f(u.uEye, camInfo.eye[0] * k, camInfo.eye[1] * k, camInfo.eye[2] * k); }
    // the two-layer panorama
    const far = meta.layers?.far;
    if (u.uTwo) gl.uniform1f(u.uTwo, TWO && far && store.aux ? 1 : 0);
    if (far && u.uFarEl) {
      gl.uniform2f(u.uFarEl, far.el[0], far.el[1]);
      gl.uniform2f(u.uFarPpd, far.levels.L1 || far.levels.L2, far.levels.L2);
      gl.uniform4f(u.uSizeF, ...(S.F1 || S.F2), ...S.F2);
    }
    // the rendered near layer (park round 2): N0 for the dominant moment, NB's front / back per moment, its depth
    const near2 = meta.layers?.near2;
    if (u.uNear2) gl.uniform1f(u.uNear2, near2 && S.NB && !noNear ? 1 : 0);
    if (near2 && S.NB && u.uNearEl) {
      gl.uniform2f(u.uNearEl, near2.el[0], near2.el[1]);
      gl.uniform2f(u.uNearPpd, near2.levels.L0 || near2.levels.L1, near2.levels.L1);
      gl.uniform4f(u.uSizeN, ...(S.N0 || [1, 1]), ...S.NB);
      const dm = near2.depth?.depth_m || [2, 2000];
      gl.uniform2f(u.uNearDepth, dm[0], dm[1]);
      const n0 = new Int32Array(8).fill(-1), nd = new Int32Array(8).fill(-1);
      for (let c = 0; c < meta.columns; c++) { n0[c] = slot(slotIds[0], "N0", c); nd[c] = store.slot(NEAR_DEPTH, "NB", 14 + c); }
      if (u.uSlotN0) gl.uniform4iv(u.uSlotN0, n0);
      if (u.uSlotND) gl.uniform4iv(u.uSlotND, nd);
      for (const [name, off] of [["uSlotNF", 0], ["uSlotNK", 7]]) {
        if (!u[name]) continue;
        const a = new Int32Array(28).fill(-1);
        for (let c = 0; c < meta.columns; c++) for (let m = 0; m < MAX_MOMENTS; m++) a[c * 4 + m] = slot(slotIds[m], "NB", off + c);
        gl.uniform4iv(u[name], a);
      }
    }
  }

  function drawBackdrop(frame) {
    const prog = (zoom && tileW >= 1 && zoom.program(frame)) || P.back, u = prog.u, e = env;
    gl.useProgram(prog.p);
    panoUniforms(prog);
    if (u.uRoomCount) gl.uniform1f(u.uRoomCount, roomTexture(frame) ? Math.max(1, frame.room.count) : 0);
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
    gl.uniform3f(u.uFoam, e.white[0] * 0.92, e.white[1] * 0.92, e.white[2] * 0.92);
    // light layers: the city clock's windows, lamps and floodlights
    const s = cityState, W = s.windows, Lm = s.lamps, T = s.T;
    const lt = meta.moments[slotIds[0]]?.lights || meta.moments[slotIds[1]]?.lights;
    const share = lt?.baked_share ?? 1;
    const gmix = opts.gateHold ? 0 : reduced() || opts.gateNow ? 1 : gateStart === null ? 0 : smooth01((frame.time - gateStart) / GATE_FADE_MS);
    if (u.uWinE) {
      gl.uniform1f(u.uWinE, Math.min(1, W.E / share)); gl.uniform1f(u.uWinM, Math.min(1, W.M / share));
      gl.uniform1f(u.uWinFadeE, Math.max(1e-9, W.fadeE / share)); gl.uniform1f(u.uWinFadeM, Math.max(1e-9, W.fadeM / share));
      gl.uniform1f(u.uWinTvOn, W.tvOn); gl.uniform1f(u.uWinHn, W.hn); gl.uniform1f(u.uTvTick, Math.floor(T * 5) % 16777216);
      gl.uniform1ui(u.uWinNight, W.night >>> 0);
    }
    gl.uniform4f(u.uLtOn, 1, Lm.share, Lm.flood, gmix);
    gl.uniform4f(u.uLamp, Lm.on - Lm.fog - T, Lm.off + Lm.fog - T, Lm.spread, LAMPS.fade);
    const tints = lt?.tints || { windows: [1, 0.85, 0.6], lamps: [1.3, 0.9, 0.5], flood: [1, 0.45, 0.3] };
    gl.uniform3f(u.uTintW, ...tints.windows); gl.uniform3f(u.uTintL, ...tints.lamps); gl.uniform3f(u.uTintF, ...tints.flood);
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
    if (prog !== P.back) zoom.uniforms(prog, frame);
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawSprites(frame) {
    const e = env, M = cityState.moment;
    // hulls
    const nh = events.counts.hulls;
    if (nh && alb && nrm && !atlasJob && P.hull.ok) {
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
      // the reflection: the hull's short and dark; at night the lights' columns run longer down the water
      if (u.uReflStretch) gl.uniform1f(u.uReflStretch, 0.7 + 0.9 * modeL);
      gl.bindVertexArray(vaoHull);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboHull);
      const data = events.hulls;
      if (data.byteLength > hullCap) { hullCap = data.byteLength * 2; gl.bufferData(gl.ARRAY_BUFFER, hullCap, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nh);
    }
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
    gl.disable(gl.BLEND);
  }

  // the halo: the outside as just drawn, halved twice by the GPU's own filter, bright-passed and blurred at 1/8
  function haloPrep(frame) {
    sizeTargets(frame.width, frame.height);
    const src = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    gl.disable(gl.SCISSOR_TEST);
    const blit = (from, fw, fh, to, filter = gl.LINEAR) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fb);
      gl.blitFramebuffer(0, 0, fw, fh, 0, 0, to.w, to.h, gl.COLOR_BUFFER_BIT, filter);
    };
    if (copyT) blit(src, frame.width, frame.height, copyT, gl.NEAREST);
    if (!P.bright.ok || !P.blur.ok || opts.halo === false) return;
    blit(src, frame.width, frame.height, halo.h2);
    blit(halo.h2.fb, halo.h2.w, halo.h2.h, halo.h4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, halo.h8a.fb);
    gl.viewport(0, 0, halo.h8a.w, halo.h8a.h);
    gl.useProgram(P.bright.p);
    gl.activeTexture(gl.TEXTURE0 + UNITS.uSrc);
    gl.bindTexture(gl.TEXTURE_2D, halo.h4.tex);
    gl.uniform2f(P.bright.u.uTexel, 1 / halo.h4.w, 1 / halo.h4.h);
    gl.uniform1f(P.bright.u.uThreshold, opts.haloThreshold ?? 0.8);
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(P.blur.p);
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

  function windowCorners(frame) {
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
        alb = nrm = ngt = null; halo = null; haloSpare = null; copyT = null;
        if (atlasMeta) loadAtlas().then(([a, n, g]) => { atlasJob = { a, n, g }; engine.requestFrame(); }).catch(() => {});
      }
      initGL();
    },
    update,
    animating(frame) {
      if (zoom?.busy()) return true;
      if (store.busy || extJob || atlasJob || (tileW > 0 && tileW < 1) || tileFade === null && !stage1Failed && tileW < 1) return true;
      if (reduced() !== lastReduced) { lastReduced = reduced(); stillDue = true; return true; }   // switched: draw the change once
      if (reduced()) return !drawnOnce || !!prev || stillDue;
      return true;    // clouds, water, traffic: the window is alive
    },
    render(ctx, frame) {
      const t0 = performance.now();
      const now = frame.time;
      if (!pair || !env) return;
      prepare(frame);
      // uploads first (three.js state is reset after this pass): capped per frame while the camera moves (perf #1)
      // (one budget with the close-up tier: what its step uploaded this frame comes off the panorama's share, perf-r2)
      store.pump(now, frame.state === "moving" ? Math.max(0, store.budget - (engine.hiTier?.spent || 0)) : REST_UPLOAD_BYTES);
      zoom?.pump(now, frame);
      if (extJob) {
        const j = extJob; extJob = null;
        ext = { a: tex2d(gl, j.a, { mips: true }), b: j.b ? tex2d(gl, j.b, { mips: true }) : null, t: j.t, ids: j.ids };
        j.a.close?.(); j.b?.close?.();
      }
      if (atlasJob) {
        // one texture a frame (the ships' atlas is 3x the old one's pixels: no upload and mipmap pass of all three in
        // one frame)
        const j = atlasJob;
        if (!alb) { alb = tex2d(gl, j.a, { mips: true }); j.a.close?.(); }
        else if (!nrm) { nrm = tex2d(gl, j.b || j.n, { mips: true }); j.n?.close?.(); }
        else { ngt = j.g ? tex2d(gl, j.g, { mips: true, rg: true }) : null; j.g?.close?.(); atlasJob = null; }
      }
      if (tileW >= 1 && ext) {     // stage 1 is over: free the first-paint images
        gl.deleteTexture(ext.a); if (ext.b) gl.deleteTexture(ext.b); ext = null;
      }
      if (!P.back.check() | !P.pts.check() | !P.hull.check() | !P.bright.check() | !P.blur.check() | !P.halo.check() | !P.copy.check()) {
        if (!P.back.ok) return;
      }
      const haveSource = (ext && tileW < 1) || tileW >= 1 && momentReady(slotIds[0]) && store.aux;
      if (!haveSource) return;
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
    },
    resize() {},
    dispose() {
      zoom?.dispose();
      store.dispose();
      statsRun.dispose();
      for (const p of Object.values(P || {})) gl.deleteProgram(p.p);
      for (const set of [halo, haloSpare]) if (set) for (const k of ["h2", "h4", "h8a", "h8b"]) freeTarget(gl, set[k]);
      freeTarget(gl, copyT);
      for (const t of [dummy2d, alb, nrm, ngt, ext?.a, ext?.b]) if (t) gl.deleteTexture(t);
      gl.deleteTexture(dummyArr);
    },
  };
  const haloPass = {
    name: "outside-halo", stage: "overlay", order: 0, raw: true,
    render(ctx, frame) {
      if (!drawnOnce || !halo || !P.halo.ok || opts.halo === false || renderedAt !== frame.index) return;
      const corners = windowCorners(frame);
      if (!corners) return;
      const u = P.halo.u;
      gl.viewport(0, 0, frame.width, frame.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(P.halo.p);
      gl.activeTexture(gl.TEXTURE0 + UNITS.uHalo);
      gl.bindTexture(gl.TEXTURE_2D, halo.h8a.tex);
      gl.uniform2f(u.uSize, frame.width, frame.height);
      gl.uniform2fv(u.uCorners, corners);
      gl.uniform1f(u.uFeather, 0.012 * frame.width);
      gl.uniform1f(u.uStrength, (opts.haloStrength ?? HALO));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
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
    get stage() { return tileW >= 1 ? "tiles" : ext ? "first-paint" : "loading"; },
    get tileW() { return tileW; },
    get info() {
      return {
        stage: this.stage, tileW: +tileW.toFixed(3), slots: slotIds, weights: weights.map((w) => +w.toFixed(3)),
        visible: { yaw: visible.yaw.map((x) => +x.toFixed(2)), el: visible.el.map((x) => +x.toFixed(2)), margin: visible.margin }, cols,
        store: store.stats(), events: events.counts, cpuMs: +perf.cpuMs.toFixed(2), travel: +travel.toFixed(3), simT: +simT.toFixed(2),
        eye: camInfo?.eye.map((x) => +x.toFixed(3)), stats: Object.fromEntries(stats), moment: cityState?.moment && { a: cityState.moment.a, b: cityState.moment.b, t: +cityState.moment.t.toFixed(3) },
        T: cityState?.T, clock: cityState?.clock && { date: cityState.clock.date, hour: +cityState.clock.hour.toFixed(3), dayType: cityState.clock.dayType },
        // the panorama's frame (and, for a merged panorama, which set each shown moment's tiles come from)
        pano: { axis: AXIS, eyeAsl: EYE_H, eyeShift: eyeShift.map((x) => +x.toFixed(3)), cityAxisShift: +city.axisShift.toFixed(4),
          source: meta.source || meta.fake || null, sets: slotIds.map((id) => (id ? meta.moments[id]?.set || "pano" : null)) },
        zoom: zoom ? zoom.info() : null,
      };
    },
    /** v3/zoom: the magnifier's hooks (shared/zoom.js), and a backdrop program made the outside's way from a source. */
    setZoom(z) { zoom = z; engine.requestFrame(); },
    backdropProgram(fs) { return makeProgram(gl, G.FULL_VS, fs, gl.getExtension("KHR_parallel_shader_compile")); },
    /** handover-r1: let a held stage 1 go (opts.holdFirstPaint), the live view dissolving in over ms once its tiles
     * are in; resolves when it is fully in. */
    release(ms = TILE_FADE_MS) {
      hold = false;
      fadeMs = Math.max(1, ms);
      engine.requestFrame();
      return tileW >= 1 ? Promise.resolve() : new Promise((r) => released.push(r));
    },
    get held() { return hold && tileW < 1; },
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
      followed = m;
      clock.set(m);
      if (holdT !== null && !opts.holdT) holdT = clock.T();   // reduced motion: the still frame moves to that time
      stillDue = true;
      engine.requestFrame();
    },
    passes: handles,
    dispose() { for (const h of handles) h.remove(); },
  };
}

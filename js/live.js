// The living window: a hand-written WebGL2 compositor for the view outside (no libraries).
//
// Inputs are the two rendered moments around now (A, B, t), the renderer's mask (R sky, G water, B fog
// opacity) and log depth (0 = 10 m ... 1 = 60 km or sky), and, when the renderer provides them, each moment's
// cloud and fog layers (docs/v3/LAYERS.md). The shader keeps every pixel of the render and only changes what
// would change from 120 m up: the cloud layer slides across the sky (1-3 CSS px a second at 1440 wide, two
// copies taking turns over many minutes, so it never visibly resets), the bay's light moves (wind patches
// drifting downwind, streaks, sun glitter toward a low sun, single glints), fog billows drift through the fog
// bank and its edges come and go, distant lights shimmer at night. Boats (js/boats.js) are lit sprites with
// wakes; cars and beacons are point lights (js/traffic.js). Steam and dust live in the room (js/roomfx.js).
// 30 fps at most; nothing runs while the tab is hidden or the view is scrolled away.
import { createTraffic, FLOATS } from "./traffic.js";
import { createBoats, fitCamera, BOAT_FLOATS, MAX_WAKES } from "./boats.js";
import { createRoomFx } from "./roomfx.js";
import { FULL_VS, RT_VS, DETAIL_FS, VIEW_FS, PTS_VS, PTS_FS, BOAT_VS, BOAT_FS } from "./shaders.js";
import { analyse, smallOf, statsOf, statsSize } from "./live-ana.js";

const MAX_FPS = 30;
const MAX_PIXELS = 9.5e6;   // canvas cap (device pixels); the texture's own size caps it too
const KEEP = 4;             // moments kept on the GPU
const HEADING = 285.25;     // compass heading of the home camera (measured from the sun and towers in the renders)
const CLOUD_SPEED = 0.06;   // default cloud drift, exterior widths a minute (about 1.7 CSS px/s at 1440 wide)
const FOG_SPEED = 0.0009;   // fog billow drift, exterior widths a second (about 1.6 CSS px/s at 1440 wide)

const DEBUG = new URLSearchParams(location.search).get("debug");
// (DYS-149) the reads of the pictures (live-ana.js) in a worker; ?liveana=0: on the main thread, as before;
// ?liveana=check: in the worker, then the main thread's own too, compared (the console's "liveana check")
const LIVE_ANA = new URLSearchParams(location.search).get("liveana") ?? "1";
// ?debug: how long each setup step held the main thread (ms), to keep every one well under 50
const timings = [];
const timed = (name, fn) => { const t = performance.now(); const r = fn(); if (DEBUG !== null) timings.push([name, Math.round((performance.now() - t) * 10) / 10]); return r; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const smooth = (a, b, x) => smooth01((x - a) / (b - a));
// CSS cubic-bezier(0.42, 0, 0.58, 1) (ease-in-out), solved for x by bisection
function easeInOut(x) {
  x = clamp(x, 0, 1);
  const bz = (t, p1, p2) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (bz(m, 0.42, 0.58) < x) lo = m; else hi = m; }
  return bz((lo + hi) / 2, 0, 1);
}
const DEG = Math.PI / 180;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}
async function program(gl, vs, fs, parallel) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (parallel) while (!gl.getProgramParameter(p, parallel.COMPLETION_STATUS_KHR)) await nextFrame();
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getShaderInfoLog(f) || gl.getShaderInfoLog(v) || gl.getProgramInfoLog(p);
    throw new Error(`shader: ${log}`);
  }
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

// An <img> already on the page, as an ImageBitmap decoded off the main thread: its bytes come back from the
// cache (createImageBitmap(img) itself snapshots the picture on the main thread, ~40 ms for a 4K one).
async function decodeOff(img) {
  try {
    const res = await fetch(img.currentSrc || img.src, { cache: "force-cache" });
    if (res.ok) return await createImageBitmap(await res.blob());
  } catch { /* fall back */ }
  return createImageBitmap(img);
}

// fetch, with one retry: a dropped request should not leave the window still for the whole visit
async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return res;
    } catch (e) {
      if (i > 0) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}
async function bitmap(url, opts) {
  return createImageBitmap(await (await get(url)).blob(), opts);
}

// A moment's own light, read from its exterior (live-ana.js statsOf), on the main thread
async function pictureStats(img, cpu, horizon) {
  const [w, h] = statsSize(img.naturalWidth, img.naturalHeight);
  // shrink off the main thread first (drawing the 4K picture small on a canvas blocks for ~40 ms)
  const full = await decodeOff(img);
  return statsOf(full, w, h, cpu, horizon);
}

// (DYS-149) The reads of the pictures (live-ana.js) in a worker: ask(op, msg, here) answers with the worker's numbers,
// or here()'s (the main thread's own) where the worker can't start, broke or failed that read. stop(): the reads
// still out answer null. (?liveana=check: which way each read went, and why, in window.__sfwLiveAnaCheck.paths)
function anaRunner() {
  let worker = null, seq = 0, gone = null;
  const asks = new Map();   // id -> { op, resolve, here }
  const went = (op, path, why = null) => { if (LIVE_ANA === "check") { anaCheck.paths.push(why ? `${op}: ${path} (${why})` : `${op}: ${path}`); window.__sfwLiveAnaCheck = anaCheck; } };
  const here = (a, why) => { went(a.op, "main thread", why); a.resolve(Promise.resolve().then(a.here)); };
  try {
    worker = new Worker(new URL("./live-ana-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const a = asks.get(data.id);
      if (!a) return;
      asks.delete(data.id);
      if (data.error) { console.warn("[live] read in the worker:", data.error); here(a, `the worker's read failed: ${data.error}`); } else { went(a.op, "worker"); a.resolve(data.r); }
    };
    // (it could not start or broke: everything still asked is read here, and so is everything after)
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker?.terminate();
      worker = null;
      gone = `the worker broke: ${e.message || "error event"}`;
      for (const [id, a] of [...asks]) { asks.delete(id); here(a, gone); }
    };
  } catch (e) {
    worker = null;
    gone = `no worker: ${e?.message || e}`;
  }
  if (LIVE_ANA === "check") window.__sfwLiveAnaCheck = anaCheck;
  return {
    ask(op, msg, here_) {
      if (!worker) { went(op, "main thread", gone); return Promise.resolve().then(here_); }
      return new Promise((resolve) => {
        const id = ++seq, a = { op, resolve, here: here_ };
        asks.set(id, a);
        try { worker.postMessage({ ...msg, id, op }); } catch (e) { asks.delete(id); here(a, `post failed: ${e?.message || e}`); }
      });
    },
    stop() {
      worker?.terminate();
      worker = null;
      for (const a of asks.values()) a.resolve(null);
      asks.clear();
    },
  };
}
// (DYS-149, ?liveana=check) the worker's numbers against the main thread's, exactly (the console's "liveana check")
const anaCheck = { analyse: null, stats: [], paths: [] };
function sameAna(a, b) {
  if (!a || !b) return false;
  const arr = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (a.cpu) return JSON.stringify(a.flat) === JSON.stringify(b.flat) && a.cpu.w === b.cpu.w && a.cpu.h === b.cpu.h && arr(a.cpu.water, b.cpu.water) && arr(a.cpu.depth, b.cpu.depth) && arr(a.cpu.sky, b.cpu.sky);
  return JSON.stringify(a) === JSON.stringify(b);
}
const anaReport = (what, same, extra = "") => {
  if (what === "analyse") anaCheck.analyse = same; else anaCheck.stats.push(same);
  window.__sfwLiveAnaCheck = anaCheck;
  console.info(`[live] DYS-149 liveana check ${what}: ${same ? "same" : "DIFFERENT"}${extra}`);
};

// fog and wind per moment: scene.json frames carry them; the contract (docs/v3/LAYERS.md) may make wind an object
const fogOf = (f) => f.fog ?? (f.side === "am" ? clamp((24 - f.alt) / 18, 0, 1) : 0);
const windOf = (f) => (typeof f.wind === "object" && f.wind ? f.wind.speed ?? 0.5 : f.wind ?? (f.side === "pm" ? 0.75 : 0.35));
const windFromOf = (f) => (typeof f.wind === "object" && f.wind?.dir_deg != null ? f.wind.dir_deg : 260);
const cloudDxOf = (f) => f.cloud_motion?.dx ?? CLOUD_SPEED;

// (review since 13:45, 3: a layer that fails to start (a shader, the mask/depth/paths files failing twice) had left its
// pictures' worker running and its GL context held for the rest of the visit, the caller getting no destroy(): both
// let go here before the failure goes on to app.js)
export async function createLive(o) {
  const held = { ana: null, gl: null };
  try {
    return await buildLive(o, held);
  } catch (e) {
    held.ana?.stop();
    held.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    throw e;
  }
}

async function buildLive(o, held) {
  const { view, ext, room } = o;
  const spec = view.live;
  if (!spec) return null;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.zIndex = "5";
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!gl) return null;
  held.gl = gl;
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  let dead = false;
  // (DYS-149: the reads of the pictures in a worker, started now so it is up when the files are in)
  const ana = LIVE_ANA === "0" ? null : anaRunner();
  held.ana = ana;

  const url = (p) => `/${p}`;
  const raw = { colorSpaceConversion: "none", premultiplyAlpha: "none" };
  const straight = { premultiplyAlpha: "none" };
  // the mask and depth decoded twice off the main thread: full size for the GPU, small for reading here
  // (DYS-149: with the worker, the small one is made there, from the same file the same way: smallOf)
  const pair2 = async (u) => {
    const blob = await (await get(u)).blob();
    const big = await createImageBitmap(blob, raw);
    const h = Math.max(8, Math.round((512 * big.height) / big.width));
    const small = ana ? null : await smallOf(blob, h);
    return [big, small, blob, h];
  };
  const data = Promise.all([pair2(url(spec.mask)), pair2(url(spec.depth)), get(url(spec.paths)).then((r) => r.json())]);
  // the boats atlas: narrow screens draw the boats at about half the size and take the half-size set (ships-r1)
  const half = matchMedia("(max-width: 700px)").matches ? "-half" : "";
  const spriteData = Promise.all([
    get("/live/sprites/boats.json").then((r) => r.json()),
    bitmap(`/live/sprites/boats-albedo${half}.webp`, { premultiplyAlpha: "none", colorSpaceConversion: "none" }),
    bitmap(`/live/sprites/boats-normal${half}.webp`, raw),
    bitmap(`/live/sprites/boats-night${half}.webp`, raw).catch(() => null),
  ]).catch(() => null);
  await nextFrame();
  const viewProg = await program(gl, FULL_VS, VIEW_FS, parallel);
  await nextFrame();
  const detailProg = await program(gl, RT_VS, DETAIL_FS, parallel);
  await nextFrame();
  const ptsProg = await program(gl, PTS_VS, PTS_FS, parallel);
  await nextFrame();
  const boatProg = await program(gl, BOAT_VS, BOAT_FS, parallel);
  const [[maskBmp, maskSmall, maskBlob, maskH], [depthBmp, depthSmall, depthBlob, depthH], paths] = await data;
  await nextFrame();
  const overscan = view.overscan || 1;
  // (DYS-149: on the main thread as before (?liveana=0, or where the worker can't); else in the worker, the main thread
  // free meanwhile: on the slow laptop this was one 64-74 ms task after the room is shown)
  const anaHere = async () => {
    const m = maskSmall || await smallOf(maskBlob, maskH), d = depthSmall || await smallOf(depthBlob, depthH);
    const r = timed("analyse", () => analyse(m, d, paths));
    m.close(); d.close();
    return r;
  };
  const anaData = { width: paths.width, height: paths.height, focal: paths.focal };
  const t0Ana = performance.now();
  const ar = ana ? await ana.ask("analyse", { mask: maskBlob, maskH, depth: depthBlob, depthH, data: anaData }, anaHere) : await anaHere();
  if (ana && DEBUG !== null) timings.push(["analyse (worker)", Math.round(performance.now() - t0Ana)]);
  if (!ar) return null;
  if (ana && LIVE_ANA === "check") anaHere().then((h) => anaReport("analyse", sameAna(ar, h), ` (${ar.cpu.w}x${ar.cpu.h}, flat ${JSON.stringify(ar.flat)})`));
  const { flat, cpu } = ar;
  const cam = fitCamera(paths, flat);
  const horizon = cam?.horizon ?? flat?.horizon ?? 0.5;
  await nextFrame();

  // ---------- textures ----------
  function texture(unit, src, { mips = false, wrapS = gl.CLAMP_TO_EDGE } = {}) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const maskTex = texture(2, maskBmp); maskBmp.close();
  await nextFrame();
  const depthTex = texture(3, depthBmp); depthBmp.close();
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  const blank = gl.createTexture();
  gl.activeTexture(gl.TEXTURE15);
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 0]));
  await nextFrame();

  // Big images upload in strips over several frames, so no single frame stalls on a 4K texture.
  let queue = Promise.resolve(), stripsOk = null;
  function upload(src, { mips = true, wrapS = gl.CLAMP_TO_EDGE } = {}) {
    const job = queue.then(async () => {
      if (dead) return null;
      const bmp = src instanceof ImageBitmap ? src : await decodeOff(src);
      await nextFrame();
      if (dead) { bmp.close(); return null; }
      const w = bmp.width, h = bmp.height;
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, mips ? 1 + Math.floor(Math.log2(Math.max(w, h))) : 1, gl.RGBA8, w, h);
      const rows = Math.max(64, Math.ceil(1.2e6 / w));
      // strips need UNPACK_SKIP_ROWS to work on an ImageBitmap: probed once (gl.getError() makes the page
      // wait for the GPU, so it is not called per strip)
      if (stripsOk === null) {
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, Math.min(rows, h), gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        stripsOk = gl.getError() === gl.NO_ERROR;
      }
      if (!stripsOk) timed("upload", () => gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp));
      else for (let y = 0; y < h; y += rows) {
        const hh = Math.min(rows, h - y);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
        timed("strip", () => gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, bmp));
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        if (y + rows < h) await nextFrame();
        if (dead) { bmp.close(); gl.deleteTexture(tex); return null; }
      }
      await nextFrame();
      if (dead) { bmp.close(); gl.deleteTexture(tex); return null; }
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (mips) timed("mipmap", () => gl.generateMipmap(gl.TEXTURE_2D));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bmp.close();
      return { tex, w, h };
    });
    queue = job.catch(() => null);
    return job;
  }

  // ---------- the window: where effects are drawn (exterior uv, with the parallax margin) ----------
  const win = (() => {
    const poly = view.window;
    if (!poly) return [0, 0, 1, 1];
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const tx = (x) => (x - 0.5) / overscan + 0.5;
    const mx = ((overscan - 1) / 2 / overscan) * 0.9 + 0.01, my = mx * 0.6;
    return [clamp(tx(Math.min(...xs)) - mx, 0, 1), clamp(tx(Math.min(...ys)) - my, 0, 1), clamp(tx(Math.max(...xs)) + mx, 0, 1), clamp(tx(Math.max(...ys)) + my, 0, 1)];
  })();

  // the bridge in exterior uv, from its tower tops down to the deck and between its ends (its cables cross
  // the sky but must not drift with the clouds)
  const bridgeBox = (() => {
    const L = view.lights || {}, pts = [...(L.aircraft || []), ...(L.deck || [])];
    if (!pts.length) return [-1, -1, -1, -1];
    const tx = (p) => [(p[0] - 0.5) / overscan + 0.5, (p[1] - 0.5) / overscan + 0.5];
    const q = pts.map(tx), us = q.map((p) => p[0]), vs = q.map((p) => p[1]);
    return [Math.min(...us) - 0.02, Math.min(...vs) - 0.012, Math.max(...us) + 0.02, Math.max(...vs) + 0.01];
  })();

  // ---------- per moment: exterior, clouds, fog ----------
  // A moment whose renders keep clouds or fog in separate layers is only shown once those layers are in.
  const vk = o.viewKey;
  const recs = new Map();   // frame id -> { ext, clouds, fog, stats, ok, used }
  const sunUv = (f) => {
    const rel = (f.az - HEADING) * DEG;
    if (Math.cos(rel) < 0.2 || !cam) return [-9, -9, 0.01];
    return [0.5 + (cam.focal * Math.tan(rel)), horizon - (cam.focal * Math.tan(f.alt * DEG)) * cam.aspect, 0.035];
  };
  function detailFor(rec, frame) {
    // baked clouds: split the sky's detail off once (half size), on the GPU
    const w = Math.max(16, rec.ext.w >> 1), h = Math.max(16, rec.ext.h >> 1);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(detailProg.p);
    gl.bindVertexArray(emptyVao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rec.ext.tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(detailProg.u.uE, 0); gl.uniform1i(detailProg.u.uMask, 2);
    gl.uniform3f(detailProg.u.uSunUv, ...sunUv(frame));
    gl.uniform1f(detailProg.u.uAspect, cam?.aspect ?? paths.width / paths.height);
    gl.uniform4f(detailProg.u.uKeep, ...bridgeBox);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return { tex, mode: 2, span: 1, w, h };
  }
  // (DYS-149) A moment's light (pictureStats), in the worker when there is one, once per picture (the same file at the
  // same size reads the same: cpu and horizon are this layer's, fixed). On the slow laptop the main thread's took
  // 50-60 ms after the room is shown: the 4K picture's resize, the GC after it, the sort.
  const statsKept = new Map();
  function statsFor(img) {
    if (!ana) return pictureStats(img, cpu, horizon);
    const [w, h] = statsSize(img.naturalWidth, img.naturalHeight), url = img.currentSrc || img.src, key = `${w}x${h} ${url}`;
    let p = statsKept.get(key);
    if (!p) {
      const msg = { url: new URL(url, location.href).href, w, h, horizon, cpu: { w: cpu.w, h: cpu.h, sky: cpu.sky, water: cpu.water } };
      p = ana.ask("stats", msg, () => pictureStats(img, cpu, horizon));
      if (LIVE_ANA === "check") p = p.then(async (r) => { const m = await pictureStats(img, cpu, horizon); anaReport("stats", sameAna(r, m), ` ${url.split("/").pop()}`); return r; });
      if (statsKept.size >= 32) statsKept.delete(statsKept.keys().next().value);
      statsKept.set(key, p);
      p.then((r) => { if (!r) statsKept.delete(key); }, () => statsKept.delete(key));
    }
    return p;
  }
  function layerImage(frame, kind, factor) {
    const sizes = frame.images?.[vk]?.[kind];
    if (!sizes) return null;
    return o.asset(sizes, (geo ? geo.w * geo.f : innerWidth) * Math.min(2, devicePixelRatio || 1) * factor);
  }
  function recFor(frame) {
    let r = recs.get(frame.id);
    if (!r) {
      const wantsClouds = !!(frame.layers?.clouds_separate && frame.images?.[vk]?.clouds);
      const wantsFog = !!(frame.layers?.fog_separate && frame.images?.[vk]?.fog);
      r = { ok: false, used: 0, ext: null, clouds: null, fog: null, stats: null, born: 0, wantsClouds, wantsFog };
      recs.set(frame.id, r);
      const extJob = o.image(frame).then(async (img) => {
        if (!img || dead) { handed(img); return null; }
        try {
          const t0 = performance.now();
          r.stats = await statsFor(img);
          if (DEBUG !== null) timings.push(["stats (async)", Math.round(performance.now() - t0)]);
          return await upload(img);
        } finally { handed(img); }
      });
      const span = view.cloud_span || 2;
      const cloudJob = wantsClouds
        ? bitmap(layerImage(frame, "clouds", span), straight).then((b) => upload(b, { mips: true })).then((t) => t && { ...t, mode: 1, span })
        : extJob.then((t) => (t && !dead ? (r.ext = t, timed("detail", () => detailFor(r, frame))) : null));
      const fogJob = wantsFog ? bitmap(layerImage(frame, "fog", 1), straight).then((b) => upload(b, { mips: false })) : Promise.resolve(null);
      r.promise = Promise.all([extJob, cloudJob, fogJob]).then(([e, c, f]) => {
        if (!e || dead) { recs.delete(frame.id); return; }
        Object.assign(r, { ext: e, clouds: c, fog: f, ok: true, born: performance.now() });
        promote(); sizeCanvas();
      }).catch((err) => { console.warn("live layer:", err && err.message); recs.delete(frame.id); });
    }
    r.used = performance.now();
    evict();
    return r;
  }
  // (DYS-151 memory) The exterior app.js handed over (o.image), once it is a texture or no longer wanted: a copy made for
  // this layer alone (out of the page: the bare exterior under a moment's still) drops its src, and with it its decoded
  // picture, which out of the page it keeps until a full garbage collection, with the JIT (any https page) a long way
  // off (DM1, WebKit as an iPhone 13 over https: the two moments' bare exteriors, 9.2 MB each, stayed alive the whole
  // visit). A photograph in the page (a moment with no still hands over its own <img>, on screen) keeps its picture.
  const handed = (img) => { if (img && !img.isConnected) img.removeAttribute("src"); };
  function freeRec(r) {
    for (const k of ["ext", "clouds", "fog"]) if (r[k]?.tex) gl.deleteTexture(r[k].tex);
  }
  function evict() {
    if (recs.size <= KEEP) return;
    const keep = new Set([want?.a.id, want?.b.id, pair?.a.id, pair?.b.id, prev?.a.id, prev?.b.id]);
    const old = [...recs.entries()].filter(([id, r]) => !keep.has(id) && r.ok).sort((x, y) => x[1].used - y[1].used);
    while (recs.size > KEEP && old.length) {
      const [id, r] = old.shift();
      freeRec(r);
      recs.delete(id);
    }
  }

  // ---------- the moment ----------
  // A step of the dial eases the view over a moment; a jump (another time on the dial, back to now) fades
  // the whole view over the same time as the room, so the two always change together.
  let want = null, minutes = 0;
  let pair = null;      // what is drawn: { a, b, A, B, t }
  let prev = null;      // what is fading out: { a, b, A, B, t, start, dur }
  const FADE = o.fade || 2500;
  const weights = (p) => {
    const w = new Map([[p.a.id, 1 - p.t]]);
    w.set(p.b.id, (w.get(p.b.id) || 0) + p.t);
    return w;
  };
  function distance(p, q) {
    const wp = weights(p), wq = weights(q);
    let d = 0;
    for (const id of new Set([...wp.keys(), ...wq.keys()])) d += Math.abs((wp.get(id) || 0) - (wq.get(id) || 0));
    return d / 2;
  }
  // in step with the room's crossfade (app.js): the same start, length and curve (CSS ease-in-out)
  let roomFade = null;
  const outgoing = (now) => (prev ? 1 - easeInOut((now - prev.start) / prev.dur) : 0);
  function promote() {
    if (!want) return;
    const A = recs.get(want.a.id), B = recs.get(want.b.id);
    if (!(A?.ok && B?.ok)) return;
    const next = { a: want.a, b: want.b, A, B, t: want.a === want.b ? 0 : want.t };
    if (pair) {
      const d = distance(pair, next);
      if (d > 0.03) {
        const now = performance.now();
        // keep whichever picture is showing more as the one that fades out; a jump that came with a change of
        // room starts when the room's did (catching up if the pictures arrived late)
        const withRoom = roomFade && now - roomFade.start < roomFade.dur * 0.8 && d > 0.5;
        const start = withRoom ? roomFade.start : now, dur = withRoom ? roomFade.dur : Math.min(FADE, Math.max(450, d * FADE * 1.4));
        if (!prev || outgoing(now) < 0.5) prev = { ...pair, start, dur };
      }
    }
    pair = next;
  }

  // ---------- canvas size ----------
  let geo = o.geo, quality = 1;
  // from the layout alone (not the pictures' sizes), so it is set once: resizing a WebGL canvas reallocates
  // its buffers and stalls the page
  function sizeCanvas() {
    if (!geo) return;
    const cssW = geo.w * geo.f, cssH = geo.h * geo.f;
    let w = Math.min(cssW * Math.min(2, window.devicePixelRatio || 1), 4148) * quality;
    let h = (w * cssH) / cssW;
    if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); w *= s; h *= s; }
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // ---------- sprites: lights (points) and boats (instanced quads) ----------
  const traffic = createTraffic(paths, view, overscan);
  const emptyVao = gl.createVertexArray();
  const ptsVao = gl.createVertexArray();
  const ptsVbo = gl.createBuffer();
  gl.bindVertexArray(ptsVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, ptsVbo);
  const stride = FLOATS * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
  gl.bufferData(gl.ARRAY_BUFFER, FLOATS * 4 * 64, gl.DYNAMIC_DRAW);
  let ptsSize = FLOATS * 4 * 64;
  gl.bindVertexArray(null);

  let boats = null, boatVao = null, boatVbo = null, albTex = null, nrmTex = null, ngtTex = null, atlasSize = [1, 1];
  const boatBuf = new Float32Array(BOAT_FLOATS * 128);
  const wakeP = new Float32Array(MAX_WAKES * 4), wakeQ = new Float32Array(MAX_WAKES * 4);
  spriteData.then(async (sd) => {
    if (!sd || dead || !cam) return;
    const [atlas, alb, nrm, ngt] = sd;
    await nextFrame();
    if (dead) return;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    albTex = timed("atlas", () => texture(4, alb, { mips: true })); alb.close();
    await nextFrame();
    nrmTex = timed("atlas", () => texture(4, nrm, { mips: true })); nrm.close();
    if (ngt) { await nextFrame(); ngtTex = timed("atlas", () => texture(4, ngt, { mips: true })); ngt.close(); }
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    atlasSize = atlas.size;
    boatVao = gl.createVertexArray();
    boatVbo = gl.createBuffer();
    gl.bindVertexArray(boatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, boatVbo);
    gl.bufferData(gl.ARRAY_BUFFER, boatBuf.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < BOAT_FLOATS / 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, BOAT_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    boats = createBoats({ data: paths, cam, cpu, atlas, heading: HEADING });
  });

  await nextFrame();
  const fx = createRoomFx({ layer: room, view, roomImage: o.roomImage });

  // ---------- the moment's conditions ----------
  let simT = Math.random() * 1000, lastNow = 0, lastDraw = 0, shown = false, slow = 0, frameNo = 0;
  let tau0 = null;          // the boats' clock: seconds of the San Francisco day at simT = 0
  let tauMinutes = null;    // the minute it was set at (a jump of the dial resets it)
  let travel = 0;           // how far the clouds have drifted (exterior widths)
  function env(out) {
    // the moment on screen, including a picture still fading out
    const of = (fn) => {
      const v = lerp(fn(pair.a), fn(pair.b), pair.t);
      return prev && out > 0 ? lerp(v, lerp(fn(prev.a), fn(prev.b), prev.t), out) : v;
    };
    const stat = (k) => {
      const mixv = (p) => { const a = p.A.stats?.[k], b = p.B.stats?.[k]; return a && b ? a.map((x, i) => lerp(x, b[i], p.t)) : a || b || [0.5, 0.5, 0.5]; };
      const v = mixv(pair);
      return prev && out > 0 ? v.map((x, i) => lerp(x, mixv(prev)[i], out)) : v;
    };
    const night = of((f) => f.night || 0);
    const alt = of((f) => f.alt), az = of((f) => f.az);
    const wind = of(windOf), from = of(windFromOf);
    const rel = (from + 180 - HEADING) * DEG;
    return {
      night, alt, az, wind, minutes,
      fog: of(fogOf),
      windTo: [Math.sin(rel), Math.cos(rel)],
      cloudDx: of(cloudDxOf), cloudDy: of((f) => f.cloud_motion?.dy ?? 0),
      white: stat("white"), air: stat("air"), water: stat("water"), high: stat("high"),
    };
  }
  const sunTint = (alt) => {
    const k = smooth(-1, 22, alt);
    return [1.0, lerp(0.55, 0.96, k), lerp(0.3, 0.9, k)];
  };

  // two copies of a cloud layer slide along and take turns: each lives for `range` of travel, and they
  // crossfade over `f` of the cycle (minutes), so the sky never visibly resets
  // (at travel 0 the first copy sits where the renderer put the clouds, at full weight)
  function copies(range, centre, f, sign) {
    const P = range / (0.5 + f);
    const start = clamp((0.5 - (sign * centre) / range) * (0.5 + f), f, 0.5);
    const ph0 = (((travel / P + start) % 1) + 1) % 1, ph1 = (ph0 + 0.5) % 1;
    const w = (ph) => smooth(0, f, ph) * (1 - smooth(0.5, 0.5 + f, ph));
    const off = (ph) => centre + sign * (Math.min(ph, 0.5 + f) / (0.5 + f) - 0.5) * range;
    return [off(ph0), off(ph1), w(ph0), w(ph1)];
  }

  function draw(now, dt) {
    let out = outgoing(now);
    if (prev && out <= 0) { prev = null; out = 0; }
    const e = env(out);
    const W = canvas.width, H = canvas.height;
    const css = W / (geo.w * geo.f);
    frameNo++;

    // ---- clouds and fog ----
    // exterior widths a second; on a small screen (a phone) at least ~0.9 CSS px a second, so it still reads
    const cssW = geo.w * geo.f;
    const speed = Math.sign(e.cloudDx || 1) * Math.max(Math.abs(e.cloudDx) / 60, 0.9 / cssW);
    travel += Math.abs(speed) * dt;
    const sign = speed < 0 ? -1 : 1;
    const span = Math.min(...[pair.A, pair.B].map((r) => (r.clouds?.mode === 1 ? r.clouds.span : 9)));
    // the window stays inside the layer's middle 60% (its outer parts are stretched by the projection)
    const lo = win[0], hi = win[2];
    const oMin = hi - 0.5 - 0.3 * span, oMax = lo - 0.5 + 0.3 * span;
    const layer = span < 9 && oMax > oMin ? copies(oMax - oMin, (oMax + oMin) / 2, 0.22, sign) : [0, 0, 1, 0];
    const detail = copies(0.16, 0, 0.3, sign);
    // a slight rise (or fall) along with the drift, kept small: the layer has no sky above the picture
    const rise = clamp(e.cloudDy / Math.max(Math.abs(e.cloudDx), 1e-3), -0.2, 0.2);
    const modeOf = (r) => (r?.clouds ? r.clouds.mode : 0);
    const spanOf = (r) => (r?.clouds ? r.clouds.span : 1);
    const fogMode = (r) => (r?.fog ? 1 : 0);

    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(win[0] * W), Math.floor((1 - win[3]) * H), Math.ceil((win[2] - win[0]) * W) + 1, Math.ceil((win[3] - win[1]) * H) + 1);
    gl.disable(gl.BLEND);
    gl.useProgram(viewProg.p);
    gl.bindVertexArray(emptyVao);
    const u = viewProg.u;
    const C = prev || pair;
    const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex || blank); };
    bind(0, pair.A.ext.tex); bind(1, pair.B.ext.tex); bind(2, maskTex); bind(3, depthTex);
    bind(5, C.A.ext.tex); bind(6, C.B.ext.tex);
    bind(7, pair.A.clouds?.tex); bind(8, pair.B.clouds?.tex); bind(9, C.A.clouds?.tex); bind(10, C.B.clouds?.tex);
    bind(11, pair.A.fog?.tex); bind(12, pair.B.fog?.tex); bind(13, C.A.fog?.tex); bind(14, C.B.fog?.tex);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uB, 1); gl.uniform1i(u.uMask, 2); gl.uniform1i(u.uDepth, 3);
    gl.uniform1i(u.uC, 5); gl.uniform1i(u.uD, 6);
    gl.uniform1i(u.uCA, 7); gl.uniform1i(u.uCB, 8); gl.uniform1i(u.uCC, 9); gl.uniform1i(u.uCD, 10);
    gl.uniform1i(u.uFA, 11); gl.uniform1i(u.uFB, 12); gl.uniform1i(u.uFC, 13); gl.uniform1i(u.uFD, 14);
    gl.uniform1f(u.uMix, pair.t);
    gl.uniform1f(u.uMixPrev, prev ? prev.t : 0);
    gl.uniform1f(u.uOut, out);
    gl.uniform1f(u.uTime, simT);
    gl.uniform2f(u.uTex, pair.A.ext.w, pair.A.ext.h);
    gl.uniform2f(u.uCanvas, W, H);
    gl.uniform1f(u.uCss, css);
    const sunOn = smooth(-0.8, 0.6, e.alt) * (1 - e.night) * (1 - 0.7 * e.fog);
    gl.uniform4f(u.uMoment, e.night, e.fog, e.wind, sunOn);
    gl.uniform4f(u.uCam, horizon, cam ? cam.eye : 0, paths.focal, paths.width / paths.height);
    const rel = (e.az - HEADING) * DEG, ca = Math.cos(e.alt * DEG);
    const glitter = smooth(-0.8, 0.6, e.alt) * (1 - e.night);
    gl.uniform4f(u.uSun, Math.sin(rel) * ca, Math.cos(rel) * ca, Math.sin(e.alt * DEG), glitter);
    const tint = sunTint(e.alt);
    gl.uniform3f(u.uSunCol, tint[0], tint[1], tint[2]);
    const U = 1.5 + 9 * e.wind;
    gl.uniform4f(u.uWind, e.windTo[0], e.windTo[1], U, 0.003 + 0.00512 * U);
    gl.uniform4f(u.uModeC, modeOf(pair.A), modeOf(pair.B), modeOf(C.A), modeOf(C.B));
    gl.uniform4f(u.uSpanC, spanOf(pair.A), spanOf(pair.B), spanOf(C.A), spanOf(C.B));
    gl.uniform4f(u.uModeF, fogMode(pair.A), fogMode(pair.B), fogMode(C.A), fogMode(C.B));
    gl.uniform4f(u.uOffL, layer[0], layer[1], layer[2], layer[3]);
    gl.uniform2f(u.uRiseL, clamp((layer[0] - (oMax + oMin) / 2) * rise * (paths.width / paths.height), -0.02, 0.02), clamp((layer[1] - (oMax + oMin) / 2) * rise * (paths.width / paths.height), -0.02, 0.02));
    gl.uniform4f(u.uOffD, detail[0], detail[1], detail[2], detail[3]);
    gl.uniform4f(u.uFogFlow, Math.max(FOG_SPEED, 1.1 / cssW), 9, 0.003, 0.42);
    gl.uniform2f(u.uGate, (bridgeBox[0] + bridgeBox[2]) / 2, horizon);
    gl.uniform4f(u.uWin, win[0], win[1], win[2], win[3]);
    const nb = boats ? boats.wakes(wakeP, wakeQ) : 0;
    gl.uniform1i(u.uBoats, nb);
    if (nb) { gl.uniform4fv(u.uBoatP, wakeP); gl.uniform4fv(u.uBoatQ, wakeQ); }
    const wh = e.white;
    gl.uniform3f(u.uFoam, wh[0] * 0.92, wh[1] * 0.92, wh[2] * 0.92);
    gl.uniform1i(u.uDebug, DEBUG === "clouds" ? 1 : DEBUG === "water" ? 2 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- boats ----
    if (boats) {
      if (tauMinutes === null || Math.abs(minutes - tauMinutes) > 2) tau0 = minutes * 60 + 30 - simT;
      tauMinutes = minutes;
      const day = new Date().getDay();
      boats.update({ tau: tau0 + simT, minutes, night: e.night, wind: e.wind, windTo: e.windTo, alt: e.alt, weekend: day === 0 || day === 6, dt, frame: frameNo });
      const n = boats.sprites(boatBuf, { canvasW: W, windTo: e.windTo });
      if (n) {
        gl.useProgram(boatProg.p);
        const bu = boatProg.u;
        gl.bindVertexArray(boatVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, boatVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, boatBuf, 0, n * BOAT_FLOATS);
        bind(0, albTex); bind(1, nrmTex); bind(4, ngtTex);     // (unit 4: the uploads' unit, free while drawing)
        gl.uniform1i(bu.uAlb, 0); gl.uniform1i(bu.uNrm, 1); gl.uniform1i(bu.uMask, 2); gl.uniform1i(bu.uDepth, 3);
        if (bu.uNgt) gl.uniform1i(bu.uNgt, 4);
        gl.uniform1i(bu.uFA, 11); gl.uniform1i(bu.uFB, 12);
        gl.uniform2f(bu.uCanvas, W, H);
        gl.uniform2f(bu.uAtlas, atlasSize[0], atlasSize[1]);
        gl.uniform1f(bu.uMix, pair.t);
        gl.uniform1f(bu.uTime, simT);
        gl.uniform4f(bu.uFogMode, fogMode(pair.A) * fogMode(pair.B), 0, e.fog, 0);
        gl.uniform3f(bu.uSunCam, Math.sin(rel) * ca, Math.sin(e.alt * DEG), -Math.cos(rel) * ca);
        const sun = sunOn * 0.62, amb = lerp(0.38, 0.12, e.night);
        const nightK = 1 - 0.9 * e.night;
        gl.uniform3f(bu.uSunCol, wh[0] * sun * tint[0], wh[1] * sun * tint[1], wh[2] * sun * tint[2]);
        gl.uniform3f(bu.uSkyCol, ...e.high.map((x, i) => (x * 0.45 + wh[i] * 0.55) * amb * nightK));
        gl.uniform3f(bu.uLowCol, ...e.water.map((x) => x * 0.5 * nightK));
        gl.uniform3f(bu.uAir, ...e.air);
        gl.uniform3f(bu.uGlow, 1.0, 0.72, 0.42);
        gl.uniform1f(bu.uHaze, 1 / (11000 * (1 - 0.6 * e.fog)));
        gl.uniform1f(bu.uNight, e.night);
        // the ships' own light (ships-r1): windows as the light outside falls, floods with the navigation lights
        gl.uniform1f(bu.uWinK, clamp(Math.max(e.night, 0.12 * smooth(2, -3, e.alt)), 0, 1));
        gl.uniform1f(bu.uFloodK, smooth(2, -3, e.alt) * (0.35 + 0.65 * e.night));
        gl.uniform1f(bu.uLiveryBase, boats.liveryBase);
        gl.uniform1f(bu.uReflStretch, 0.7 + 0.9 * e.night);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        gl.disable(gl.BLEND);
      }
    }

    // ---- cars, beacons and navigation lights ----
    const count = traffic.fill(simT, {
      ...e, px: css, width: W, specks: true,
      boatLights: boats ? (light, streak) => boats.lights(light, streak, { night: e.night, px: css, canvasW: W }) : null,
    });
    if (count) {
      gl.useProgram(ptsProg.p);
      gl.uniform1f(ptsProg.u.uTime, simT);
      gl.bindVertexArray(ptsVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ptsVbo);
      const d = traffic.buffer.subarray(0, count * FLOATS);
      if (d.byteLength > ptsSize) { ptsSize = traffic.buffer.byteLength; gl.bufferData(gl.ARRAY_BUFFER, ptsSize, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);

    if (!shown) {
      shown = true;
      ext.appendChild(canvas);
      // the first drawn frame matches the <img>s exactly; fade the canvas in, then retire them
      requestAnimationFrame(() => {
        ext.classList.add("live-on");
        setTimeout(() => { if (!dead) ext.classList.add("live-settled"); }, 800);
      });
    }
  }

  function frame(now) {
    if (dead) return;
    const dt = Math.min(0.1, (now - (lastNow || now)) / 1000);
    lastNow = now;
    simT += dt;
    if (now - lastDraw < 1000 / MAX_FPS - 3) return;
    const gap = now - (lastDraw || now);
    lastDraw = now;
    // if the machine can't keep up, draw fewer pixels
    if (shown && gap > 55) { if (++slow > 45 && quality > 0.55) { quality *= 0.8; slow = 0; sizeCanvas(); } }
    else slow = Math.max(0, slow - 1);
    if (!pair) return;
    const step = Math.min(0.1, gap / 1000);
    if (DEBUG !== null && frameNo < 3) timed("draw", () => draw(now, step)); else draw(now, step);
    fx.frame(simT, Math.max(dt, step));
  }

  function fail(e) {
    if (e) e.preventDefault?.();
    destroy();
  }
  canvas.addEventListener("webglcontextlost", fail);

  function destroy() {
    if (dead) return;
    dead = true;
    ana?.stop();
    ext.classList.remove("live-on", "live-settled");
    canvas.remove();
    fx.destroy();
    const lose = () => {
      for (const r of recs.values()) freeRec(r);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(lose, { timeout: 2000 });
  }

  // warm-up: one tiny draw of each program, so the GPU builds its pipelines now rather than on the first
  // visible frame
  gl.viewport(0, 0, 1, 1);
  gl.useProgram(viewProg.p);
  gl.bindVertexArray(emptyVao);
  for (let i = 0; i < 15; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, i === 3 ? depthTex : i === 2 ? maskTex : blank); }
  for (const k of ["uA", "uB", "uMask", "uDepth", "uC", "uD", "uCA", "uCB", "uCC", "uCD", "uFA", "uFB", "uFC", "uFD"]) {
    gl.uniform1i(viewProg.u[k], { uA: 0, uB: 1, uMask: 2, uDepth: 3, uC: 5, uD: 6, uCA: 7, uCB: 8, uCC: 9, uCD: 10, uFA: 11, uFB: 12, uFC: 13, uFD: 14 }[k]);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.useProgram(ptsProg.p);
  gl.bindVertexArray(ptsVao);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.POINTS, 0, 1);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  await nextFrame();

  sizeCanvas();
  fx.resize(geo);

  return {
    setMoment(sel, min) {
      want = sel;
      minutes = min;
      recFor(sel.a);
      if (sel.b !== sel.a) recFor(sel.b);
      promote();
      fx.setMoment(sel, sel.t < 0.5 ? sel.a : sel.b);
    },
    resize(g) { geo = g; sizeCanvas(); fx.resize(g); },
    roomFade(start, dur) { roomFade = dur > 0 ? { start, dur } : null; },
    imageChanged(frame) {
      // a sharper exterior arrived after a resize: upload it and swap when ready
      const r = recs.get(frame.id);
      if (!r?.ok) return;
      o.image(frame).then((img) => (img && !dead ? upload(img).finally(() => handed(img)) : (handed(img), null))).then((t) => {
        if (!t || dead) return;
        const old = r.ext.tex;
        r.ext = t;
        gl.deleteTexture(old);
        if (r.clouds?.mode === 2) { gl.deleteTexture(r.clouds.tex); r.clouds = detailFor(r, frame); }
        sizeCanvas();
      });
    },
    frame,
    destroy,
    get info() {
      return {
        cam, horizon, quality, canvas: [canvas.width, canvas.height], win,
        pair: pair && [pair.a.id, pair.b.id, pair.t], prev: prev && [prev.a.id, prev.b.id, prev.t, +outgoing(performance.now()).toFixed(3)],
        moments: [...recs.entries()].map(([id, r]) => [id, r.ok, r.clouds?.mode ?? 0, r.clouds ? [r.clouds.w, r.clouds.h] : null, r.fog ? 1 : 0]),
        travel, simT, timings: timings.slice(-60), boats: boats ? boats.list.map((b) => [b.id, +b.u.toFixed(4), +b.v.toFixed(4), Math.round(b.Z), +b.alpha.toFixed(2)]) : null,
      };
    },
  };
}

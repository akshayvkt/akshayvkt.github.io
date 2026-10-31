// The room engine (stream E1): one WebGL2 context, one render loop, the room drawn with baked light and refined
// at rest, the colour path, passes for the other streams, picking and the QA hook.
// The contract is docs/v3/engine-api.md; read that rather than this file.
import * as THREE from "three";
import { createContext, engineSupport, EngineFallback, Fullscreen, gpuIdle, nextMessage, nextTask, pixelRatioFor, Targets } from "./context.js";
import { Emitter, jitter, lensSample, Passes, Scheduler } from "./loop.js";
import { closeSource, loadModel, lightTextures, phoneMemory, refetchSource, trimPool, within } from "./loader.js";
import { objectName, OBJECTS, REGIONS, Room, useIdTables } from "./room.js";
import { DEFAULT_TEXTURES, makeDFG, sharedUniforms } from "./material.js";
import { Probes } from "./probes.js";
import { Colour } from "./colour.js";
import { DeskMirror } from "./mirror.js";
import { Beams } from "./beams.js";
import { GlassMirror } from "./glass.js";
import { applyAnisotropy, HiTier } from "./hitex.js";
import { phoneNow } from "../device.js";   // (DYS-171: what a phone is, the router's and the beacon's rule too)

export { engineSupport, EngineFallback };
export const ENGINE_VERSION = "e1-v1.11";
const T_MODULE = performance.now();     // when the engine's modules (three.js included) finished evaluating

const params = new URLSearchParams(location.search);
const DEG = Math.PI / 180;
// the dark moments with the photographs' glass layer (frames.json `glass`), unless bake.json or room3d.json say
const GLASS_MOMENTS = new Set(["night", "predawn", "dawn", "dusk", "blue"]);
const V3 = (a) => new THREE.Vector3(...a);

/** room.py's cameras in engine coordinates (placeholders until N's spots.js registers the real ones). */
function blenderDir(yawLeftDeg, pitchDeg) {
  const y = yawLeftDeg * DEG, p = pitchDeg * DEG;
  return [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];   // aim() in engine axes
}
const hfov = (lens) => 2 * Math.atan(18 / lens) / DEG;
export const PLACEHOLDER_SPOTS = {
  // home_l: lens 30, pitch -1, yaw 7 (render_frames.py), from the chair eye
  desk: { position: [0, 1.17, 1.05], direction: blenderDir(7, -1), hfov: hfov(30) },
  // room.py VIEWS (3:2 page photos); Blender's shift_y 0.075 sensor widths = 0.1125 frame heights at 3:2
  shelf: { position: [-0.22, 1.24, 0.84], direction: blenderDir(41, 4), hfov: hfov(24), shift: [0, 0.1125] },
  laptop: { position: [-0.25, 1.05, -0.36], target: [-0.322, 0.870, -0.941], hfov: hfov(35), focus: { fStop: 4 } },
  print: { position: [0.40, 1.10, 0.52], direction: blenderDir(-4, -5), hfov: hfov(70), focus: { fStop: 5.6, target: [0.665, 0.909, -1.050] } },
  // not in room.py yet: rough placeholders
  notebook: { position: [-0.62, 1.30, -0.22], target: [-0.62, 0.76, -0.66], hfov: hfov(35) },
  window: { position: [0, 1.25, -0.45], direction: [0, -0.05, -1], hfov: hfov(24) },
};

/**
 * A spot from room3d.json (R1's export: eye, target, lens, sensor_mm, fit, Blender shift, fstop, focus) in the
 * engine's spot form. The lens and shift are kept as Blender gives them and converted for the frame's aspect when
 * the spot is used (a horizontal-fit lens keeps its horizontal field on every screen shape).
 */
export function spotFromRoom3d(s) {
  return {
    position: s.eye, target: s.target, lens: s.lens, sensorMM: s.sensor_mm || 36, fit: s.fit || "horizontal",
    shiftBlender: s.shift || [0, 0],
    focus: s.fstop && s.focus ? { fStop: s.fstop, distance: s.focus, focalMM: s.lens } : null,
  };
}

const copyInto = (a, b) => { a.length = b.length; for (let i = 0; i < b.length; i++) a[i] = b[i]; };   // perf #13: an array refilled in place
// perf-r2: moving frames (the camera gliding, dragging, leaning in) draw at a lower render scale on the desktop tiers,
// chosen from the measured GPU time of moving frames (EXT_disjoint_timer_query_webgl2) between MV_FLOOR and 1, in
// MV_STEP steps, changed only at a landing; at rest the room refines at full scale as before, the first full frame
// crossfaded in from the last moving one over MV_LANDING_MS
const MV_START = 0.75, MV_FLOOR = 0.6, MV_STEP = 0.05, MV_LANDING_MS = 220, MV_BUDGET = 0.7;
// DYS-37: the scale a GPU learned is kept for its next visit (localStorage, per GPU and pixel ratio)
const MV_KEY = "sfw-mvscale";
// a slow drag has frames without a move between its moves: the moving scale holds through MV_HOLD such frames (each
// redrawn at the moving scale) before the landing, so the picture doesn't switch scale back and forth
const MV_HOLD = 2;
// (DYS-149: a zoom gesture's frames without a change of the outside's camera between its moves (a pinch's fingers, a slow
// pan) stay moving this long, so a gesture never gets a frame at the resting caps mid-way)
const OUT_HOLD_MS = 100;
// v3/shimmer: the room's material maps softer on moving frames by a LOD bias (?mvbias=<n> to try one): off by default,
// it measured no gain (D's SH1-SH4, 28 Oct); the sill's crawl was its edges, which the present pass's FXAA takes
const MV_BIAS = params.has("mvbias") ? Math.max(0, parseFloat(params.get("mvbias")) || 0) : 0;
// (DYS-149 mv-lite) a phone's moving frame: the night glass's mirror at this share of its size each way (glass.js
// _targetFor: a quarter of its pixels), the sunbeams' air with this share of its march steps (T1's 8 -> 4)
const MV_GLASS_K = 0.5, MV_AIR_K = 0.5;
// (DYS-161 memory) restoreRoom: rounds before a room whose textures don't come back ends, and the wait between
const RESTORE_TRIES = 3, RESTORE_RETRY_MS = 2000;
// (DYS-161 memory, RD3) restoreRoom: the decode workers its pictures may use (loader.js's pool: the boot's 2, the rest
// started for the restore and let go after it), its lanes one more; ?restorepool=<n> to try another
const RESTORE_POOL = 3;

class Engine {
  constructor(canvas, opts, ctx) {
    this.canvas = canvas;
    this.opts = opts;
    this.renderer = ctx.renderer;
    this.gl = ctx.gl;
    this.caps = ctx.caps;
    this.THREE = THREE;
    this.qa = opts.qa || null;
    const rm = opts.reducedMotion === "auto" || opts.reducedMotion === undefined
      ? (params.get("motion") === "reduce" ? true : params.get("motion") === "full" ? false : matchMedia("(prefers-reduced-motion: reduce)").matches)
      : !!opts.reducedMotion;
    const tier = params.get("tier") || (opts.tier && opts.tier !== "auto" ? opts.tier : (phoneNow() ? "T1" : "T2"));
    this.settings = { reducedMotion: rm, tier, samples: tier === "T1" ? 12 : 32, accum: params.get("accum") === "32" ? 32 : 16 };
    // (DYS-151) phones: the light maps and material maps at 1024 at most, each decoded picture let go once uploaded,
    // and no close-up tier (loader.js phoneMemory). ?phonemem=0 turns it off for the visit (before/after checks);
    // ?phonemem=release lets pictures go on any phone (tests of the iPhone path in another browser).
    let pm = params.get("phonemem");
    try { if (pm !== null) sessionStorage.setItem("sfw-phonemem", pm); else pm = sessionStorage.getItem("sfw-phonemem"); } catch { /* storage blocked */ }
    this.phoneMemory = tier === "T1" && pm !== "0";
    // (DYS-151 review finding 3: pictures are let go only on iPhones and iPads, whose browsers are all WebKit and where a
    // tab is killed for memory; elsewhere they are kept, so a lost GPU context is restored to the live room, not ended in
    // the photographs. iPadOS calls itself a Mac with touch.)
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (this.phoneMemory) { phoneMemory.maxSize = 1024; phoneMemory.release = ios || pm === "release"; }
    // (DYS-151 review 2: on phones a time-of-day change lets the old moment's light maps go before the new moment's
    // upload, behind the frozen frame, so the two sets are never on the GPU together (_bindLight); ?t1drop=0: the
    // desktops' order, the new maps uploaded while the old are still bound)
    this.t1Drop = tier === "T1" && params.get("t1drop") !== "0";
    // (DYS-161 memory: on phones the room's textures can go from the GPU while the window is zoomed with the room wholly
    // out and held so (router.js roomFade), and come back from the HTTP cache as a zoom out begins: dropRoom, restoreRoom.
    // Off by default, ?roomdrop=1 turns it on: RD1 (WebKit as an iPhone SE / 12 mini, 30 Oct) measured -214 MB of WebGL
    // and -220 to -260 MB in the GPU process held zoomed, never a frame of the room without its textures, but the 46
    // textures took 3.1-3.6 s to come back from the zoom out's start, so the room's fade in waited 0.75-1.1 s at 1x
    // (the outside alone) that main does not: not invisible yet)
    // (DYS-161 memory, RD3: ?roomdrop=1 now lets only the model's material maps go (29, ~146 MB): the light maps and the
    // detail map stay (17, ~68 MB, a third of the restore's time); they come back over up to RESTORE_POOL decode workers,
    // from their files kept as Blobs (loader.js phoneMemory.keepFiles, ~3.2 MB: nothing fetched again). ?roomdrop=all
    // lets the light maps go too (RD1's set, ~214 MB). RD3 (WebKit as an iPhone SE / 12 mini, 30 Oct, before the Blobs):
    // -146 MB of WebGL and -150 MB in the GPU process held zoomed, no frame of the room without its textures, a re-zoom
    // within 8 s as sharp as main's; the pinch back to 1x hides the restore (done 1.2-1.6 s from its start, 1x at
    // 2.3-2.8 s: the fade in waits no longer than main's), but a double tap's reset (450 ms to 1x) waited 1.0-1.8 s at
    // 1x for it (fetch ~55-210 ms, the worker's decode ~40-48 ms, upload ~5 ms a picture; four lanes). RD3b (the Blobs
    // kept, the same phones, 30 Oct): nothing fetched, yet the restore still took 1.1-1.3 s (the worker's decode 80-90 ms
    // a picture with the Mac busier; four workers no faster): the pinch back still hides it, but the double tap's reset
    // waited 0.67-0.78 s at 1x beyond main's and the close button's glide away began with the outside alone for
    // 0.83-0.90 s. So it stays off by default: the restore is its decoding now, ~3x too slow for those two ways back)
    const rd = params.get("roomdrop");
    this.roomDrop = tier === "T1" && (rd === "1" || rd === "all");
    this.roomDropAll = rd === "all";
    this.restorePool = Math.min(6, Math.max(1, parseInt(params.get("restorepool"), 10) || RESTORE_POOL));
    if (this.roomDrop) phoneMemory.keepFiles = true;   // (before the model loads: loader.js fitWhileLoading keeps them)
    this._drop = null;           // { texs, p, at }: the room's textures let go (the room not drawn) until restoreRoom's p
    this._lightBusy = 0;         // setLight calls running (no drop meanwhile)
    this.roomDrops = { drops: 0, restores: 0, last: null, tex: null };
    // (DYS-149 review 4: on phones the sunbeams' air can be left out of moving frames and drawn at rest as before (_frame),
    // with ?airmove=0. Desktops and tablets always draw it) (DYS-149 review: the comment said ?airmove=1 kept it; the switch
    // is ?airmove=0)
    // (worker C, 30 Oct: off by default until a real iPhone shows the gain: no gain measurable on the Mac (TL2), and the
    // air visibly drops out during a glide; ?airmove=0 turns the skip on for that measurement)
    this.airMove = tier !== "T1" || params.get("airmove") !== "0";
    this._airLeft = false;       // the last live frame was drawn without the air (a phone's moving frame)
    // (DYS-149: a zoom gesture (a pinch, a pan of the zoomed view) moves only the outside's camera; the room's stays put,
    // so this.state stayed "settled" and the outside's and the zoom's uploads ran at their resting caps through it: 77-124
    // MB in a first zoom's 3-5 s, up to 10.6 MB a gesture frame on a phone (phone-frame-budget 30 Oct, S7). On phones a
    // change of the outside's camera now counts as moving for those caps (frame.outsideMoving, held OUT_HOLD_MS after the
    // last change); the room's own refining and state are as before, and at rest the resting caps fill the view as
    // before. And at full zoom (roomW 0) the room's composite and the halo's prep, which draw nothing then, are skipped
    // (S4, S5), on every tier: their pixels are the same either way (_frame, outside.js haloPrep). ?zoomcaps=0: as before)
    const zc = params.get("zoomcaps") !== "0";
    this.zoomCaps = tier === "T1" && zc;
    this.zoomSkip = zc;
    this.outsideMoving = false;  // the outside's camera moved this frame or within OUT_HOLD_MS (phones; frame.outsideMoving)
    this._outNums = null;        // the outside camera's numbers last frame (_outChanged)
    this._outMovedAt = -Infinity;
    // (DYS-149 mv-lite: on phones (T1) a moving frame draws some passes cheaper, none of them at rest (phone-frame-budget
    // 30 Oct, section 6; the moving render scale itself, S1, is Akshay's call, DYS-183): the sunbeams' air with half its
    // march steps (air), the night glass's mirror at half its size each way (glass), the halo's chain from the window's
    // box and without its quarter-size step (halo, outside.js haloPrep), the sharp vehicles' layer at half its texels
    // (cars, outside.js drawCarGroup), and the room's and the vehicles' depth not stored once drawn (depth). A room
    // drawn so is drawn whole again at the first still frame (_liteLeft), as _airLeft does, so the picture at rest adds
    // up as before; the outside draws every frame, so its first still frame is whole anyway. ?mvlite=0: none of them;
    // ?mvlite=-air,-glass (any of air, glass, halo, cars, depth): those as before)
    const mvl = params.get("mvlite"), mvOff = new Set((mvl || "").split(",").map((s) => s.trim()).filter((s) => s[0] === "-").map((s) => s.slice(1)));
    const mvOn = tier === "T1" && mvl !== "0" && !this.qa;
    this.mvLite = Object.fromEntries(["air", "glass", "halo", "cars", "depth"].map((k) => [k, mvOn && !mvOff.has(k)]));
    this._liteLeft = false;      // the last live frame drew the room or the glass cheaper (a phone's moving frame)
    if (this.qa && this.qa.frames) this.settings.samples = this.qa.frames;
    this.layers = { ambient: true, sun: true, lamp: true, screen: true, detail: true, probes: true, coat: true, highlights: true,
      specocc: true, energy: true, bspline: tier !== "T1", mirror: true, dof: true, beams: true, glass: true, screenmask: true,
      lampprobe: true, mirrorfar: true, lut: true, grade: true, matrix: true, dither: !this.qa, mvscale: tier !== "T1" };
    for (const tok of (params.get("layers") || "").split(",")) {
      const m = /^([+-])(\w+)$/.exec(tok.trim());
      if (m && m[2] in this.layers) this.layers[m[2]] = m[1] === "+";
    }
    this.events = new Emitter();
    this.passes = new Passes();
    this.targets = new Targets();
    this.fs = new Fullscreen();
    this.shared = sharedUniforms();
    this.colour = new Colour();
    this.shared.uHaze = this.colour.uniforms.uHaze;   // reachable by ?tune= (calibration only)
    this.probes = new Probes(this.renderer, this.fs, this.settings.tier === "T1" ? 256 : 512);
    this.probes.keepScreen = !this.layers.screenmask;
    this.room = null;
    this.bake = null;
    this.bakeUrl = null;
    this.timings = { module: Math.round(T_MODULE) };
    this.spots = { ...PLACEHOLDER_SPOTS };
    this.light = { moment: null, lamp: 0, screen: 1 };
    // v3/zoom-r3 (outside only when zoomed): the room's weight in the picture (1: as always; 0: the outside alone, on the
    // whole screen) and the outside's own camera while zoomed (null: the room's; the room's camera never narrows, only
    // the outside's view does: camera.setOutside)
    this.roomW = 1;
    this.outsideCam = null;
    this._incoming = new Map();   // moments a setLight is still switching to (tod-mobile: their maps are kept)
    this.matrices = new Map();

    // camera state (section 3)
    this.cam = { position: V3([0, 1.17, 1.05]), quaternion: new THREE.Quaternion(), fovY: 37.3, near: 0.03, far: 200,
      shift: [0, 0], focus: null, sway: [0, 0] };
    this.camera3 = new THREE.PerspectiveCamera(37.3, 16 / 9, 0.03, 200);
    this.projNoJitter = new THREE.Matrix4();
    this.jit = [0, 0];
    this.camKey = "";
    this.camNums = null;         // the numbers camKey was made from (_camSame)
    // perf-r2: the moving scale (?mvscale=0.8 pins one), its targets and what it has learned; the GPU timer
    const mvq = parseFloat(params.get("mvscale"));
    const pinned = mvq > 0 && mvq <= 1;
    // (DYS-37: where this GPU and pixel ratio left it on an earlier visit, else MV_START)
    this.mvGpu = (() => { try { return `${this.gl.getParameter(this.gl.RENDERER)}|${devicePixelRatio}`; } catch { return ""; } })();
    const kept = (() => { try { const k = JSON.parse(localStorage.getItem(MV_KEY) || "null"); return k && k.gpu === this.mvGpu && k.scale >= MV_FLOOR && k.scale <= 1 ? k.scale : null; } catch { return null; } })();
    this.mv = { scale: pinned ? mvq : kept ?? MV_START, pinned, next: null, active: false, room: null, display: null,
      landing: null, vsync: 16.7, lastTick: 0, delta: 0, moving: false, still: 0, win: { n: 0, late: 0, gpu: [] }, clean: 0, last: null };
    const tq = this.caps.timerQuery ? this.gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    this.gpuTimer = tq ? { ext: tq, q: null, pend: [] } : null;
    this.gpuTiming = !!this.gpuTimer;    // each drawn frame timed on the GPU: "gputime" events (perf.mjs reads them)

    // refining state (section 6)
    this.state = "moving";
    this.count = 0;              // samples in the room buffer
    this.stillFrames = 0;
    this.invalid = true;
    this.hold = false;
    this.fade = null;            // { start, ms }
    this._mapsOut = false;       // (DYS-149 review) a phone's hold with the old moment's maps gone, the new not yet bound
    this._resizeHeld = false;    // a resize that came in that hold, applied at the bind (_bindLight)
    this.frameIndex = 0;
    this.lastDraw = 0;
    this.lastFrame = null;
    this.ctxApi = {
      gl: this.gl, renderer: this.renderer, THREE, engine: this, targets: this.targets,
      bindTarget: (t) => this.renderer.setRenderTarget(t),
      fullscreen: (m) => this.fs.draw(this.renderer, m),
    };
    this.camera = {
      set: (s) => this._setCamera(s),
      get: () => this._getCamera(),
      setSway: (yaw, pitch) => { this.cam.sway = [yaw, pitch]; },
      // v3/zoom-r3: the outside's own camera (as set() takes: position, target, up, fovY, shift), or null for the room's
      setOutside: (s) => this._setOutside(s),
      fovFromLens: (lens, { sensorMM = 36, fit = "horizontal", aspect = this.aspect() } = {}) => {
        const half = Math.atan(sensorMM / 2 / lens);
        return (fit === "horizontal" ? 2 * Math.atan(Math.tan(half) / aspect) : 2 * half) / DEG;
      },
      three: this.camera3,
    };

    this.scheduler = new Scheduler(canvas, (t) => this._tick(t));
    this.resizeObs = new ResizeObserver(() => this._resize());
    this.resizeObs.observe(canvas);
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this._lost(); });
    canvas.addEventListener("webglcontextrestored", () => this._restored());
    // (DYS-151) a page that is really going (not into the back-forward cache) gives its GPU memory back at once, so a
    // reload's new room never stacks on the old one's (WebKit, as an iPhone: a reload peaked 2.9 GB in its GPU process)
    addEventListener("pagehide", (e) => { if (!e.persisted) try { this.gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* gone */ } });
    if (!this.qa) {
      matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", (e) => {
        if (params.get("motion")) return;
        this.settings.reducedMotion = e.matches;
        this.events.emit("settingschange", { reducedMotion: e.matches, tier: this.settings.tier });
      });
    }
    this._resize(true);
    this._applySwitches();
  }

  // ------------------------------------------------------------------ public API
  on(name, fn) { return this.events.on(name, fn); }
  get version() { return ENGINE_VERSION; }
  get ids() {
    const regions = {}; REGIONS.forEach((n, i) => { regions[i] = n; });
    const objects = {}; for (const [k, v] of Object.entries(OBJECTS)) objects[v] = k;
    return { regions, objects, books: "256 + n" };
  }
  aspect() { return this.width / Math.max(1, this.height); }
  /** room.py's room-local axes (Blender, Z up, +Y to the window) to the engine's (glTF, Y up, -Z to the window). */
  fromBlender([bx, by, bz]) { return [bx, bz, -by]; }

  addPass(def) {
    const entry = this.passes.add(def);
    entry.pass = def;
    if (def.init) def.init(this.ctxApi);
    if (def.resize) def.resize(this.ctxApi, this._frameInfo());
    this.requestFrame();
    return {
      remove: () => { this.passes.remove(entry); def.dispose?.(this.ctxApi); this.requestFrame(); },
      get enabled() { return entry.enabled; },
      set enabled(v) { entry.enabled = !!v; },
    };
  }

  /** Restart refining without a camera change (an object moved). */
  invalidate(reason = "") { this.invalid = true; this.invalidReason = reason; this.requestFrame(); }

  // v3/laptop-phone (the coordinator's call 4, 23 Oct): the laptop screen's own picture (the page in r1/tex/screen_base.jpg)
  // at the photographs' screen white for the moment: its surface scaled by a gain per channel (room3d.json
  // laptop_screen.texture, measured on the room by renders/laptop-phone/tools/screen_gain_calib.mjs against the
  // photographs' white, laptop_screen.desk), so where the room's picture of the screen shows (handover-r2's hold through
  // the photo-to-3D crossfade, a frame cutting the screen) it is the photographs' screen, not a paper-white one at night.
  // Not its glow on the room (the photographs' too). null: a gain of 1 (the screen as baked).
  setScreenGain(rgb) {
    const u = this.shared?.uScreenEmit;
    if (!u) return;
    const g = Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => Number.isFinite(v) && v >= 0) ? rgb : [1, 1, 1];
    if (u.value.x === g[0] && u.value.y === g[1] && u.value.z === g[2]) return;
    u.value.set(g[0], g[1], g[2]);
    this.invalidate("screen gain");
  }
  requestFrame() { this.needsFrame = true; }

  setLayer(name, on) {
    if (!(name in this.layers)) throw new Error(`unknown layer ${name}`);
    this.layers[name] = !!on;
    this._applySwitches();
    this.probes.keepScreen = !this.layers.screenmask;
    if ((name === "lamp" || name === "screenmask") && this.probeSet) {
      this.probes.build(this.probeSet, this.layers.lamp ? this.light.lamp : 0, this.shared).then(() => {
        this._buildLampProbe();
        this.invalidate("probes rebuilt");
      });
    } else this._buildLampProbe();
    this.invalidate(`layer ${name}`);
  }

  registerSpots(spots) { Object.assign(this.spots, spots); }

  /** Put the camera at a spot from the registry (placeholder spots until N registers its own). */
  goToSpot(name) {
    const s = this.spots[name];
    if (!s) throw new Error(`unknown spot ${name}`);
    const pos = V3(s.position);
    const target = s.target ? V3(s.target) : pos.clone().add(V3(s.direction));
    const aspect = this.aspect();
    const fovY = s.fovY ?? (s.lens ? this.camera.fovFromLens(s.lens, { sensorMM: s.sensorMM || 36, fit: s.fit || "horizontal", aspect })
      : this.camera.fovFromLens(18 / Math.tan((s.hfov * DEG) / 2), { aspect }));
    // Blender's shift (horizontal fit): x in frame widths, y in sensor widths = frame heights x aspect
    const shift = s.shiftBlender ? [s.shiftBlender[0], s.shiftBlender[1] * aspect] : (s.shift || [0, 0]);
    let focus = null;
    if (s.focus) {
      const ft = s.focus.target ? V3(s.focus.target) : null;
      focus = { fStop: s.focus.fStop, distance: s.focus.distance ?? (ft || target).distanceTo(pos), ...(s.focus.focalMM ? { focalMM: s.focus.focalMM } : {}) };
    }
    this._setCamera({ position: s.position, target: target.toArray(), fovY, shift, focus });
  }

  objectBounds(name) { return this.room ? this.room.objectBounds(name) : null; }

  async loadRoom(opts = {}) {
    try {
      return await this._loadRoom(opts);
    } catch (e) {
      this._fail("load-failed");
      throw new EngineFallback("load-failed", e && e.message);
    }
  }

  async _loadRoom({ bake, room3d, onProgress, onItems, tex = null } = {}) {
    const t0 = performance.now();
    if (!this.shared.uDFG.value) this.shared.uDFG.value = makeDFG();
    this.bakeUrl = new URL(bake, location.href).href;
    // room3d.json (R1's export: spots, ids, lamp defaults, beams) sits next to bake.json; optional
    const r3url = room3d === null ? null : new URL(room3d || "room3d.json", this.bakeUrl).href;
    const [bk, r3] = await Promise.all([
      fetch(this.bakeUrl).then((r) => { if (!r.ok) throw new Error(`${bake}: HTTP ${r.status}`); return r.json(); }),
      r3url ? fetch(r3url).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
    ]);
    this.bake = bk;
    this.room3d = r3;
    if (r3) this._useRoom3d(r3);
    this.timings.bakeJson = Math.round(performance.now() - t0);
    const t1 = performance.now();
    // the lighter texture copies (light-load: the same pictures as AVIF), when tex names a manifest made for this model;
    // should the model not load with them, it loads once more with its own files
    const modelUrl = within(this.bakeUrl, this.bake.model);
    const texMap = tex ? await lightTextures(new URL(tex, location.href).href, modelUrl, this.bake.model_hash) : null;
    this.texLight = texMap ? texMap.size : 0;
    const model = texMap
      ? loadModel(modelUrl, this.renderer, { onProgress, onItems, tex: texMap }).catch((e) => {
        console.warn("[engine] the light textures failed, loading the originals:", e && e.message);
        this.texLight = 0;
        return loadModel(modelUrl, this.renderer, { onProgress, onItems });
      })
      : loadModel(modelUrl, this.renderer, { onProgress, onItems });
    const [gltf] = await Promise.all([model, this.colour.load()]);
    this.timings.modelAndLut = Math.round(performance.now() - t1);
    const t2 = performance.now();
    const probeW = this.settings.tier === "T1" ? 256 : 512;
    this.cubeUV = Probes.defines(probeW);
    // (DYS-149: the room's build in pieces of about room.js PIECE_MS, a task each (Room.buildSplit), not the slow laptop's
    // one ~190 ms task behind the still photo; the same room. What follows here in a task of its own, not added to the
    // last piece (anisotropy, the close-up tier, the mirrors, the beams: much of the ~34 ms of that task that was not the
    // build). ?roomsplit=0: all in one task, as before; ?roomsplit=<ms>: that budget)
    const room = new Room(this.renderer, this.shared), split = params.get("roomsplit"), budget = parseFloat(split);
    if (split === "0") this.room = room.build(gltf, this.bake, this.cubeUV);
    else {
      await room.buildSplit(gltf, this.bake, this.cubeUV, budget > 0 ? { budget } : {});
      await nextMessage();
      this.room = room;
      Object.assign(this.timings, { roomPieces: room.pieces.pieces, roomLongest: Math.round(room.pieces.longest), roomWork: Math.round(room.pieces.work) });
    }
    // anisotropic filtering on the material maps (before their first upload), and the close-up tier (hitex.js)
    applyAnisotropy(this);
    this.hiTier = new HiTier(this);
    this.hiTier.setManifest(this.phoneMemory ? null : this.room3d?.hi, within(this.bakeUrl, this.bake.model));   // (DYS-151: none on phones)
    if (this.bake.box) { this.shared.uBoxMin.value.fromArray(this.bake.box[0]); this.shared.uBoxMax.value.fromArray(this.bake.box[1]); }
    const sr = this.room.screenRect;
    if (sr) {
      this.shared.uScrC.value.fromArray(sr.centre); this.shared.uScrU.value.fromArray(sr.u); this.shared.uScrV.value.fromArray(sr.v);
      this.shared.uScrN.value.fromArray(sr.normal); this.shared.uScrL.value.fromArray(sr.radiance);
      this.shared.uLid.value.fromArray(sr.lid || [0, 0, 0, 0]);   // (e1-v1.11) the lid around it, when the model has one
    }
    const inner = this.room3d?.room?.inner;           // the window wall's inner face: the probes' parallax stops there
    if (inner) this.shared.uWallZ.value = inner[0][2];
    const wq = this.room3d?.objects?.window?.quad;   // the window opening (room3d.json), for the probes' parallax
    if (wq) {
      const xs = wq.map((p) => p[0]), ys = wq.map((p) => p[1]);
      this.shared.uWindowRect.value.set(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
    }
    const L = this.bake.lamp;
    if (L) {
      this.shared.uLampPos.value.fromArray(L.position);
      this.shared.uLampDir.value.fromArray(L.direction).normalize();
      const k = L.intensity ?? 1;
      this.shared.uLampColor.value.set(L.colour[0] * k, L.colour[1] * k, L.colour[2] * k);
      if (L.cone_deg) this.shared.uLampCone.value.set(Math.cos(L.cone_deg * DEG), Math.cos(30 * DEG));
    }
    // the desk mirror: the desk box's top face (room3d.json objects.desk), not on phones
    const deskBox = this.room3d?.objects?.desk?.box;
    if (deskBox && this.settings.tier !== "T1") {
      this.mirror = new DeskMirror(this.renderer, this.shared, this.cubeUV, {
        plane: { y: deskBox[1][1], min: [deskBox[0][0], deskBox[0][2]], max: [deskBox[1][0], deskBox[1][2]] },
        scale: 0.5,
      });
      this.mirror.resize(this.width, this.height);
    }
    // the sunbeams (plan 2.6): the room's air, added in the room's own fragments for each room sample in the moments
    // with room air (DYS-151), and drawn over the window opening
    this.beams = new Beams(this.renderer, this.room, this.shared, this.cubeUV,
      { box: this.room3d?.room?.inner, steps: this.settings.tier === "T1" ? 8 : 16 });
    // the night glass (plan 2.4): the room reflected in the pane, screen-blended over the window in the dark moments
    const wr = this.shared.uWindowRect.value;
    this.glass = new GlassMirror(this.renderer, this.shared, this.colour, this.fs, { rect: [wr.x, wr.y, wr.z, wr.w], ...(this.settings.tier === "T1" ? { lens: 0.5 } : {}) });
    this.glass.resize(this.width, this.height);
    // (DYS-156) the smooth light-map sampling at each atlas's own texel: the first atlas's (the shell, 1024) blurred the
    // desk's and furniture's 2048 maps twice as wide. Phones halve the maps to phoneMemory.maxSize as they decode
    for (const [name, u] of this.room.atlases) {
      const size = Math.min(this.bake.atlases?.[name]?.size || 1024, phoneMemory.maxSize || Infinity);
      u.uAtlasTexel.value.set(1 / size, size);
    }
    this.timings.build = Math.round(performance.now() - t2);
    const t3 = performance.now();
    const layers = this.bake.layers || {};
    const detail = layers.detail;
    await Promise.all([
      this._loadLayerSet("lamp", layers.lamp).then((apply) => apply()),
      this._loadLayerSet("screen", layers.screen).then((apply) => apply()),
      detail ? this.room.layerTexture(within(this.bakeUrl, detail.file)).then((t) => {
        this.shared.uDetail.value = t;
        this.shared.uDetailUV2.value = detail.uv === 2 ? 1 : 0;
      }) : null,
    ]);
    this.timings.staticLayers = Math.round(performance.now() - t3);
    this._applyTune(params.get("tune"));
    return this;
  }

  /** The moments this asset set has light for (bake.json's moments), in the set's order. */
  get moments() { return this.bake ? Object.keys(this.bake.moments) : []; }

  /** ?tune=uName:1,2,3;uOther:4 (calibration and QA only): set shared shader uniforms by name. */
  _applyTune(spec) {
    if (!spec) return;
    for (const part of spec.split(";")) {
      const [name, vals] = part.split(":");
      const u = this.shared[name];
      if (!u || vals === undefined) continue;
      const v = vals.split(",").map(Number);
      if (typeof u.value === "number") u.value = v[0];
      else if (u.value && u.value.fromArray) u.value.fromArray(v);
    }
  }

  _useRoom3d(r3) {
    useIdTables(r3);
    if (r3.spots) {
      const spots = {};
      for (const [name, s] of Object.entries(r3.spots)) if (s.eye && s.target && s.lens) spots[name] = spotFromRoom3d(s);
      this.registerSpots(spots);
    }
    for (const [id, m] of Object.entries(this.bake.moments)) {
      if (m.lamp_default === undefined && r3.lamp_default && id in r3.lamp_default) m.lamp_default = r3.lamp_default[id];
      if (m.beams === undefined && r3.beams && id in r3.beams) m.beams = r3.beams[id];
    }
  }

  /**
   * Every texture the room's materials hold that the GPU doesn't have yet, uploaded one per task (renderer.initTexture),
   * so no single task carries them all. DYS-149: a moment's light maps all uploading inside one hidden frame froze the
   * page for ~200 ms at the hand-off (J1 cold load: 206 ms in texSubImage2D on the main thread). Textures already on the
   * GPU at their current version are skipped. Returns { n, longest } (ms of the slowest single upload). `only`: these
   * textures (a moment's maps before they are bound), not the materials'.
   */
  async _uploadPending(only = null) {
    const texs = new Set();
    const add = (v) => { if (v && v.isTexture && !v.isRenderTargetTexture && v.image) texs.add(v); };
    if (only) only.forEach(add);
    else this.room?.scene?.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) add(v);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) { const v = u?.value; if (Array.isArray(v)) v.forEach(add); else add(v); }
      }
    });
    const props = this.renderer.properties;
    let n = 0, longest = 0;
    for (const t of texs) {
      if (props.get(t).__version === t.version) continue;
      await nextMessage();
      const a = performance.now();
      this.renderer.initTexture(t);
      longest = Math.max(longest, performance.now() - a);
      n++;
    }
    return { n, longest: Math.round(longest) };
  }

  /**
   * (DYS-149: the passes' own pictures on their way to the GPU: the outside's first-paint stills, sprite atlases and
   * occluders go up between frames, outside.js uploads(); a hidden frame waits for them, so it draws what it drew when
   * they were uploaded inside it)
   */
  async _passUploads() {
    await Promise.all(this.passes.list.map((p) => (p.enabled && p.pass.uploads ? p.pass.uploads() : null)));
  }

  /** Compile every room shader (in parallel where the browser can) and draw one hidden frame. */
  async warmUp() {
    // Every program compiles in parallel where the browser can (KHR_parallel_shader_compile), then each kind of draw
    // runs once in its own task: the first draw of a program with a new render state can still stall (ANGLE builds
    // the Metal pipeline then), and spreading them keeps each main-thread task short.
    const t0 = performance.now();
    this._updateCamera();
    await this.renderer.compileAsync(this.room.scene, this.camera3);
    // (DYS-151: the sunbeams' air is in the room's own programs now; no second program over the room to compile)
    const tc = performance.now();
    for (const m of [this.colour.composite, this.colour.snapshot, this.colour.copy, this.colour.present, this.probes.decode, this.probes.sum, this.probes.skyMat, ...(this.mirror ? [this.mirror.fill] : []), this.glass.material]) {
      this.fs.mesh.material = m;
      await this.renderer.compileAsync(this.fs.scene, this.fs.camera);
    }
    this.timings.compileRoom = Math.round(tc - t0);
    this.timings.compileAll = Math.round(performance.now() - t0);
    this.timings.uploadWarm = await this._uploadPending();   // (DYS-149: the material maps, one per task, before the first draw)
    await this._passUploads();   // (DYS-149: the outside's pictures under way, before its first draw below)
    const t1 = performance.now();
    const r = this.renderer;
    // (DYS-149 warm-frame: a pass's own warm-up, pass.warmSteps(ctx) (functions), each in a task of its own just before
    // the hidden frame, so the frame only draws. The outside's: its programs' links checked (and their fixed uniforms
    // set), then its city's first state worked out, which that frame takes: on the barely-sufficient laptop the frame
    // was one 150-222 ms task, the city's first state 76-99 ms of it, outside.js prog.check 4-6 (bt1-1521). A raw
    // pass's GL calls leave three.js's state reset after them, as after its render (_run). ?warmsplit=0: none, as before)
    const passSteps = params.get("warmsplit") === "0" ? [] : this.passes.list.filter((p) => p.enabled && p.pass.warmSteps)
      .flatMap((p) => (p.pass.warmSteps(this.ctxApi) || []).map((fn) => () => {
        try { fn(); } catch (e) { console.warn(`[engine] pass ${p.name} warm-up`, e); }
        if (p.raw) r.resetState();
      }));
    const steps = [
      () => { r.setRenderTarget(this.accum); r.clear(true, true, false); this.room.setMode("live"); this.room.draw(this.camera3); },
      () => { r.setRenderTarget(this.accum); r.clear(false, true, false); this.room.setMode("prepass"); this.room.draw(this.camera3); },
      () => { r.setRenderTarget(this.accum); this.room.setMode("add"); this.room.draw(this.camera3); this.room.setMode("live"); },
      () => { this.count = 1; this._snapshot(); },
      ...passSteps,
      () => { this._frame(performance.now(), { present: false }); },
      // perf-r2: the moving frames' targets made (and drawn into once) here, not at the first glide
      () => {
        if (!this.layers.mvscale || this.mv.scale >= 1) return;
        this._mvTargets();
        r.setRenderTarget(this.mv.room); r.clear(true, true, false); this.room.setMode("live"); this.room.draw(this.camera3);
        r.setRenderTarget(this.mv.display); r.clear(true, false, false);
      },
      () => { this.probes.pmrem.compileEquirectangularShader(); },
      () => { this.probes.pmrem.compileCubemapShader(); },
    ];
    let longest = 0;
    for (const step of steps) {
      await nextTask();
      const a = performance.now();
      step();
      longest = Math.max(longest, performance.now() - a);
    }
    await gpuIdle(this.gl);
    this.count = 0;
    this.invalidate("warm-up");
    this.timings.warmFrames = Math.round(performance.now() - t1);
    this.timings.warmLongestStep = Math.round(longest);
    this.timings.programs = this.renderer.info.programs.length;
    this.events.emit("ready", { timings: { ...this.timings } });
  }

  /**
   * perf-r2 (perf-prep #5): one hidden frame with the current moment's light, in its own task, after the first
   * setLight and before start(): the moment's own passes (the sunbeams, the night glass) and light maps draw for the
   * first time here, not in the first frames on screen. Then the room starts again from a live frame, as after warmUp.
   */
  async warmLight() {
    if (!this.room || this.failed) return;
    this.timings.uploadLight = await this._uploadPending();   // (DYS-149: the moment's light maps, one per task, not all in this frame)
    await this._passUploads();   // (DYS-149: and the outside's pictures under way)
    await nextTask();
    const a = performance.now();
    this._frame(performance.now(), { present: false });
    await gpuIdle(this.gl);
    this.count = 0;
    this.invalidate("warm-light");
    this.timings.warmLight = Math.round(performance.now() - a);
  }

  /** Switch the room's light (section 7). Resolves when the new light is loaded and applied. */
  async setLight(next, opts = {}) {
    // (tod-mobile) a moment being switched to is wanted until its switch is done: _dropOtherMoments keeps its maps
    const moment = next.moment ?? this.light.moment;
    const incoming = moment !== this.light.moment && !!this.bake?.moments?.[moment];
    if (incoming) this._incoming.set(moment, (this._incoming.get(moment) || 0) + 1);
    this._lightBusy++;
    try { return await this._setLight(next, opts); }
    finally {
      this._lightBusy--;
      if (incoming) { const k = this._incoming.get(moment) - 1; if (k > 0) this._incoming.set(moment, k); else this._incoming.delete(moment); }
    }
  }

  async _setLight(next, { fade, waitStill = 0 } = {}) {
    const want = next.moment ?? this.light.moment;
    if (!this.bake.moments[want]) throw new Error(`unknown moment ${want}`);
    const loading = want !== this.light.moment, lampBefore = this.light.lamp;
    let applyAmb = null, applySun = null, prepared = null;
    if (loading) {
      const lm = this.bake.moments[want];
      [applyAmb, applySun, prepared] = await Promise.all([
        this._loadLayerSet("ambient", lm.ambient),
        this._loadLayerSet("sun", lm.sun || null),
        this.probes.prepare(this.bakeUrl, lm),
      ]);
    }
    if (waitStill > 0) await this._waitStill(waitStill);
    // (DYS-149: the new moment's maps uploaded one per task now, while the old light still shows and before the held
    // frame, so binding them below and the rest of the switch run in one task)
    // (DYS-151 review 2: on phones they upload in the bind's turn instead, after the old moment's maps have gone)
    const maps = loading ? [...applyAmb.textures, ...applySun.textures] : null, late = loading && this.t1Drop;
    if (loading && !late) this.timings.uploadMoment = await this._uploadPending(maps);
    // (DYS-149 review: changes load side by side but bind one at a time, each from the light shown when its turn comes:
    // a lamp click that lands while a moment loads binds first and is kept, not undone by the moment's default lamp, and
    // none lands inside another's switch)
    // (DYS-161 memory: a change that comes while the room's textures are out (a phone zoomed) has them back first: its
    // bind draws the room into the probes and the lamp's probe. No drop while it runs: _lightBusy)
    if (this._drop) await this.restoreRoom();
    const turn = this._lightTurn;
    let done;
    this._lightTurn = new Promise((r) => { done = r; });
    await turn;
    try { await this._bindLight(next, fade, loading ? want : this.light.moment, lampBefore, applyAmb, applySun, prepared, late ? maps : null); }
    finally { done(); }
  }

  async _bindLight(next, fade, moment, lampBefore, applyAmb, applySun, prepared, upload = null) {
    const m = this.bake.moments[moment];
    const momentChanged = moment !== this.light.moment && !!applyAmb;
    if (!momentChanged) prepared = this.probeSet || [];
    const lamp = next.lamp ?? (momentChanged && this.light.lamp === lampBefore ? (m.lamp_default ?? this.light.lamp) : this.light.lamp);
    const scr = next.screen ?? this.light.screen;
    const lampChanged = lamp !== this.light.lamp;
    const ms = fade ?? (momentChanged ? 2500 : 200);
    const doFade = this.count > 0 && ms > 0;
    if (doFade) {
      this._snapshot();
      // hold the frozen frame fully while the new light is bound (the probe rebuild spans two tasks)
      this.fade = { start: Infinity, ms: this.settings.reducedMotion ? Math.min(ms, 150) : ms };
    }
    // (DYS-151 review 2: phones: with the old frame frozen on screen, the old moment's maps go first (unbound, then
    // disposed: _dropOtherMoments with the moment coming), then the new moment's upload one per task, then they are
    // bound below: the two sets never on the GPU together (+12-18 MB for 0.1-0.3 s on an iPhone 13 before). Without a
    // frozen frame (no fade: the first light, a restore) nothing is dropped early, as on the desktops)
    // (DYS-149 review 3: whatever throws in the hold (the upload, the probes) ends it in the finally below: before, the
    // fade's start stayed at Infinity and the frozen frame stayed on screen until a resize)
    let bound = false;
    try {
      if (upload) {
        // (DYS-149 review 2: from here to the bind the room has no maps of either moment (black): a resize in that time
        // (an iPhone rotated) is held (_resize), so the frozen frame stays on screen instead of a dark room)
        if (doFade && momentChanged) { this._mapsOut = true; this._dropOtherMoments(moment); }
        this.timings.uploadMoment = await this._uploadPending(upload);
      }
      if (momentChanged || lampChanged) {
        this.probeSet = prepared;
        await this.probes.build(prepared, this.layers.lamp ? lamp : 0, this.shared);
      }
      if (momentChanged) {
        applyAmb(); applySun();
        const sl = m.sun_light;
        if (sl && m.sun) {
          // the shaders take the sun as E/pi (the bake's units: a white matte card facing the sun shows it); R1's export
          // gives a unit colour and the Cycles lamp's strength in W/m2 apart, so scale by strength / pi when it is there
          const k = sl.strength !== undefined ? sl.strength / Math.PI : 1;
          this.shared.uSunDir.value.fromArray(sl.direction).normalize();
          this.shared.uSunColor.value.set(sl.colour[0] * k, sl.colour[1] * k, sl.colour[2] * k);
        }
        else this.shared.uSunColor.value.set(0, 0, 0);
        this.beams?.setMoment(m);
        this.glass?.setMoment(m.glass ?? this.room3d?.glass?.[moment] ?? GLASS_MOMENTS.has(moment));
        this.colour.setMoment({ exposure: m.exposure ?? 0, grade: m.grade, matrix: this.matrices.get(moment) || m.matrix });
        this.hasSun = !!m.sun;
      }
      this.light = { moment, lamp, screen: scr };
      this.colour.setAdaptation({ white: this.bake.lamp?.colour, share: this._lampShare(m, lamp) });   // (DYS-11)
      this.shared?.uScreenCat?.value.copy(this.colour.uniforms.uCat.value).invert();   // (the screen's page left out of it)
      this._applySwitches();
      this._buildLampProbe();
      if (momentChanged) this._dropOtherMoments();
      bound = true;
    } finally {
      this._mapsOut = false;
      // (DYS-149 review 2: a resize held in the hold, now: the new light bound, it ends the fade (the frozen frame is the
      // old size), so the room comes on in the new light at once, as a resize during any fade does)
      if (this._resizeHeld) { this._resizeHeld = false; this._resize(); }
      // (DYS-149 review 3: the hold ended by a throw: the frozen frame goes, the room is live again)
      if (!bound && this.fade && this.fade.start === Infinity) { this.fade = null; this.invalidate("light"); }
    }
    // (DYS-151 review 2: a resize while the frame is frozen ends the fade (_resize), more likely now the phones' hold
    // spans the upload: the switch then ends without one, not in a TypeError)
    const faded = doFade && !!this.fade;
    if (faded) this.fade.start = performance.now();
    this.invalidate("light");
    this.events.emit("lightchange", { light: { ...this.light }, fadeMs: faded ? this.fade.ms : 0 });
  }

  /** (DYS-161 memory) Every texture the room's materials hold now (their maps and uniforms: _uploadPending's walk). */
  _roomTextures() {
    const texs = new Set();
    const add = (v) => { if (v && v.isTexture && !v.isRenderTargetTexture) texs.add(v); };
    this.room?.scene?.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) add(v);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) { const v = u?.value; if (Array.isArray(v)) v.forEach(add); else add(v); }
      }
    });
    return texs;
  }

  /** (DYS-161 memory) The room's textures are out: the room is not drawn until restoreRoom has them back. */
  get roomOut() { return !!this._drop; }

  /**
   * (DYS-161 memory) Phones: a window zoomed past the room's fade (router.js roomFade: the room wholly out, held so 8 s)
   * draws none of the room, yet kept its textures on the GPU: the model's maps and the light maps bound now (~214 MB of
   * WebGL textures of the ~557 at 8.37x, WebKit as an iPhone SE, 30 Oct; iOS reloads the tab near 1.5 GB in its GPU
   * process). They go now (three's dispose: the GL texture deleted, the Texture kept on its material, its picture
   * already closed after its upload on iPhones: loader.js releaseAfterUpload), and nothing of the room is drawn until
   * restoreRoom has made them again (_frame; a light change waits for them: _setLight). Only textures on the GPU whose
   * picture can be made again from its file (loader.js noteSource), none held for a CPU read; refused while a light
   * change runs or a crossfade shows. Returns how many went. Only with ?roomdrop=1 (off by default: the constructor).
   * (RD3: only the model's material maps go (loader.js marks them: src.map), the light maps and the detail map stay;
   * ?roomdrop=all: those too, as before)
   */
  dropRoom() {
    if (!this.roomDrop || this._drop || !this.room || this.failed || this._lightBusy || this._mapsOut || this.fade) return 0;
    const props = this.renderer.properties, texs = [];
    for (const t of this._roomTextures()) {
      const src = t.userData.src;
      if (!src || !(src.map || this.roomDropAll) || phoneMemory.held.has(t) || !props.get(t).__webglTexture) continue;
      t.dispose();
      texs.push(t);
    }
    if (!texs.length) return 0;
    this._drop = { texs, p: null, at: performance.now() };
    this.roomDrops.drops++;
    this.events.emit("roomdrop", { n: texs.length });
    return texs.length;
  }

  /**
   * (DYS-161 memory) The textures dropRoom let go, made again: each picture fetched (the HTTP cache) and decoded (the fit
   * worker, as at load: loader.js refetchSource) a few at a time (RD3, below), then uploaded one per task (as
   * _uploadPending), its picture let go again after its upload. The room is drawn again (invalidated) once all are
   * back. A round with a file that fails twice is tried again 2 s later, the room kept out meanwhile (signal lost a
   * moment: the outside stays), the ones already back kept; a third failed round ends the room as a lost context does
   * (the photographs). Resolves true once the room is whole (false: failed).
   * (RD3: decoded over up to restorePool workers (loader.js's pool; the ones over the boot's 2 let go after: trimPool),
   * with a lane more than workers, so none waits while a lane uploads; the model's maps from their files kept as Blobs
   * (src.blob: no fetch). RD1's restore was one worker decoding the 46 pictures one after another; in RD3 (29, three
   * workers) half of a lane's time was the file's fetch from the cache. What each picture cost is kept for the checks:
   * roomDrops.last.cost (the sums, ms) and roomDrops.tex (per picture: [file, w, h, KB, fetch, decode (asked to
   * answered), the worker's own, upload, start, end], ms from the restore's start))
   */
  restoreRoom() {
    const d = this._drop;
    if (!d) return Promise.resolve(true);
    if (d.p) return d.p;
    const t0 = performance.now(), back = new Set(), pool = this.restorePool, rows = [];
    const cost = { fetch: 0, decode: 0, work: 0, upload: 0 };
    let fetched = 0, longest = 0;
    const one = async (t) => {
      const im = t.image, c = {}, s0 = performance.now() - t0;
      if (!im || (typeof ImageBitmap !== "undefined" && im instanceof ImageBitmap && !im.width)) {   // (closed after its upload)
        t.image = await refetchSource(t.userData.src, { pool, cost: c }).catch(() => refetchSource(t.userData.src, { pool, cost: c }));
        fetched++;
      }
      t.needsUpdate = true;
      await nextMessage();
      const a = performance.now();
      this.renderer.initTexture(t);
      const up = performance.now() - a;
      longest = Math.max(longest, up);
      cost.fetch += c.fetch || 0; cost.decode += c.decode || 0; cost.work += c.work || 0; cost.upload += up;
      const r = (v) => (v == null ? null : Math.round(v));
      rows.push([t.userData.src.url.split("/").pop(), ...(c.size || [0, 0]), r(c.kb), r(c.fetch), r(c.decode), r(c.work), r(up), r(s0), r(performance.now() - t0)]);
      back.add(t);
    };
    const round = () => {
      const queue = d.texs.filter((t) => !back.has(t));
      const lane = async () => { for (let t; (t = queue.shift());) await one(t); };
      return Promise.all(Array.from({ length: pool + 1 }, lane));
    };
    d.p = (async () => {
      // (C's merges review 2: a failed round, e.g. the signal lost while zoomed with the files gone from the cache, is
      // tried again rather than ending the room at once)
      try {
        for (let tries = 1; ; tries++) {
          try { await round(); break; }
          catch (e) {
            if (tries >= RESTORE_TRIES) {
              console.warn("[engine] the room's textures did not come back:", e && e.message);
              this._fail("room-restore");
              return false;
            }
            console.warn(`[engine] the room's textures did not come back (round ${tries}), again in ${RESTORE_RETRY_MS} ms:`, e && e.message);
            await new Promise((r) => setTimeout(r, RESTORE_RETRY_MS));
          }
        }
      } finally { trimPool(); }
      if (this._drop === d) this._drop = null;
      this.roomDrops.restores++;
      const r = (v) => Math.round(v);
      this.roomDrops.last = { n: d.texs.length, fetched, ms: r(performance.now() - t0), longest: r(longest), outMs: r(t0 - d.at), pool, all: this.roomDropAll,
        cost: { fetch: r(cost.fetch), decode: r(cost.decode), work: r(cost.work), upload: r(cost.upload) } };
      this.roomDrops.tex = rows;
      this.invalidate("room back");
      this.events.emit("roomback", this.roomDrops.last);
      return true;
    })();
    return d.p;
  }

  async prefetchMoment(id) {
    const m = this.bake.moments[id];
    if (!m) return;
    const urls = [];
    for (const spec of [m.ambient, m.sun]) if (spec) for (const e of Object.values(spec)) urls.push(within(this.bakeUrl, e.file));
    await Promise.all([...urls.map((u) => this.room.layerTexture(u)), this.probes.prepare(this.bakeUrl, m)]);
  }

  setColourMatrix(moment, m) {
    this.matrices.set(moment, m);
    if (moment === this.light.moment) { this.colour.setMatrix(m); this.requestFrame(); }
  }

  start() { if (this.failed) return; this.scheduler.start(); this.requestFrame(); }

  /**
   * The room can't go on (its model didn't load, or its GPU context was lost and couldn't come back): "fallback" (the
   * router shows the photographs), and failed stays set. DYS-151 review, finding 1: a loss and restore DURING boot
   * fired "fallback" before the router listened for it, and on phones (bitmaps released after upload) the restore then
   * drew a black room for the whole visit; now the router checks failed before start(), and start()/warmLight() refuse.
   */
  _fail(reason) {
    this.failed = true;
    this.events.emit("fallback", { reason });
  }
  stop() { this.scheduler.stop(); }

  /** Draw frames now, without waiting for the browser (QA, tests): until settled or `max` frames. */
  renderSteps(max = 64) {
    let n = 0;
    do { this._frame(performance.now()); n++; } while (n < max && (this.state !== "settled" || this.fade));
    return n;
  }

  async pick(cssX, cssY) {
    if (!this.room || this._drop) return null;   // (DYS-161 memory: its textures out, the room is not there to pick)
    const dpr = this.dpr;
    const x = cssX * dpr, y = this.height - cssY * dpr;     // GL pixel, bottom-left origin
    const W = this.width, H = this.height;
    const cx = ((Math.floor(x) + 0.5) / W) * 2 - 1, cy = ((Math.floor(y) + 0.5) / H) * 2 - 1;
    const M = new THREE.Matrix4().set(W, 0, 0, -cx * W, 0, H, 0, -cy * H, 0, 0, 1, 0, 0, 0, 0, 1);
    const cam = this.pickCam || (this.pickCam = new THREE.PerspectiveCamera());
    cam.matrixWorld.copy(this.camera3.matrixWorld);
    cam.matrixWorldInverse.copy(this.camera3.matrixWorldInverse);
    cam.matrixAutoUpdate = false;
    cam.matrixWorldAutoUpdate = false;
    cam.projectionMatrix.multiplyMatrices(M, this.projNoJitter);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    const rt = this.pickRT || (this.pickRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, type: THREE.UnsignedByteType }));
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.room.setMode("live");
    this.room.drawIds(cam);
    const buf = new Uint8Array(4);
    await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, 1, 1, buf);
    if (buf[3] === 0) return null;
    const objectId = buf[1] + (buf[2] << 8);
    return { regionId: buf[0], region: REGIONS[buf[0]] || null, objectId, object: objectName(objectId) };
  }

  dispose() {
    this.scheduler.dispose();
    this.resizeObs.disconnect();
    for (const p of this.passes.list) p.pass.dispose?.(this.ctxApi);
    this.hiTier?.dispose();
    this.room?.dispose();
    this.beams?.dispose();
    this.glass?.dispose();
    this.probes.dispose();
    this.targets.dispose();
    this.mv.room?.dispose();
    this.mv.display?.dispose();
    for (const p of this.gpuTimer?.pend || []) this.gl.deleteQuery(p.q);
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ internals
  async _loadLayerSet(which, spec) {
    // load every atlas's texture first; return a function that binds them all at once (no half-switched frames)
    const loaded = [];
    // (DYS-151 review finding 4: the first ambient maps' pixels are read once on the CPU (settleInlays, in the apply
    // below): on phones their pictures are kept past their upload until then, then let go)
    const hold = which === "ambient" && !!this.room.inlayChecks?.length;
    for (const [name] of this.room.atlases) {
      const e = spec ? spec[name] : null;
      loaded.push(e ? this.room.layerTexture(within(this.bakeUrl, e.file)).then((t) => { if (hold) phoneMemory.held.add(t); return [name, t, e.scale]; }) : Promise.resolve([name, null, null]));
    }
    const done = await Promise.all(loaded);
    const keys = { ambient: ["uAmbient", "uAmbientScale"], sun: ["uSun", "uSunScale"], lamp: ["uLamp", "uLampScale"], screen: ["uScreen", "uScreenScale"] }[which];
    const apply = () => {
      for (const [name, t, scale] of done) {
        const u = this.room.atlases.get(name);
        if (t) { u[keys[0]].value = t; u[keys[1]].value.fromArray(scale); }
        else { u[keys[0]].value = DEFAULT_TEXTURES.black; u[keys[1]].value.set(0, 0, 0); }   // (scale 0: the same look; no old map left bound)
      }
      // (once, at the first ambient maps: the inlays the bake shows were on top come forward; room.js yieldCoplanar)
      if (which === "ambient" && this.room.inlayChecks?.length) this.room.settleInlays();
      if (hold) for (const [, t] of done) if (t && phoneMemory.held.delete(t) && t.userData.releasePending) closeSource(t);
    };
    apply.textures = done.map(([, t]) => t).filter(Boolean);   // (for _setLight to upload before binding)
    return apply;
  }

  /**
   * tod-mobile (20 Oct): a moment's light maps (ambient + sun, 4 atlases: ~84 MB of textures plus their decoded
   * bitmaps) and its probes stay in the caches after the room has moved on to another moment, so every time of day
   * visited added its set and a phone's page was killed for memory on the second change. Once a new moment is bound
   * (the crossfade runs from a snapshot of the old frame, not from its textures), every other moment's maps and probes
   * are let go: GPU textures disposed, bitmaps closed, cache entries removed. Kept: the moment shown, any moment a change
   * is still loading, the moment-independent layers (lamp, screen, detail), and on desktops and tablets (T2/T3) also the
   * moment shown before, so the dial goes back and forth without a fetch. A moment visited again is fetched again (the
   * browser's HTTP cache usually has its files).
   * (DYS-151 review 2) `coming`: on phones, the moment about to be bound, before its maps upload: kept are only it and
   * the moments still loading, so the shown moment's maps go too (unbound first: the frozen frame is on screen until
   * the bind); the probes and the shown list are left to the call after the bind.
   */
  _dropOtherMoments(coming = null) {
    const ms = this.bake?.moments;
    if (!ms || !this.room) return;
    const urlsOf = (id) => {
      const m = ms[id], out = [];
      if (!m) return out;
      for (const spec of [m.ambient, m.sun]) if (spec) for (const e of Object.values(spec)) out.push(within(this.bakeUrl, e.file));
      return out;
    };
    const probeUrlsOf = (id) => (ms[id]?.probes || []).slice(0, 2).flatMap((p) => [p, p.lamp].filter(Boolean).map((e) => within(this.bakeUrl, e.file)));
    const keep = new Set(), keepProbes = new Set();
    if (!coming) this._shown = [this.light.moment, ...(this._shown || []).filter((id) => id !== this.light.moment)].slice(0, this.settings.tier === "T1" ? 1 : 2);
    for (const id of [...(coming ? [coming] : this._shown), ...this._incoming.keys()]) { for (const u of urlsOf(id)) keep.add(u); for (const u of probeUrlsOf(id)) keepProbes.add(u); }
    const momentUrls = new Set(Object.keys(ms).flatMap(urlsOf));
    // (DYS-151 review 2: a map dropped before the bind may still be bound: black in its place first, so no frame of
    // the hold draws, or uploads again, a disposed map whose picture is closed)
    const unbind = (t) => {
      for (const u of this.room.atlases.values()) for (const [k, s] of [["uAmbient", "uAmbientScale"], ["uSun", "uSunScale"]]) {
        if (u[k].value === t) { u[k].value = DEFAULT_TEXTURES.black; u[s].value.set(0, 0, 0); }
      }
    };
    let dropped = 0;
    for (const [url, p] of [...this.room.layerCache]) {
      if (!momentUrls.has(url) || keep.has(url)) continue;
      this.room.layerCache.delete(url);
      dropped++;
      p.then((t) => { if (coming) unbind(t); t.dispose(); t.image?.close?.(); }).catch(() => {});
    }
    if (!coming) this.probes.evict(keepProbes);
    if (dropped) this.timings.droppedMaps = (this.timings.droppedMaps || 0) + dropped;
  }

  /** The lamp's probe (probes.js buildLamp), from the room as it is lit now; the lamp's parts read it. */
  _buildLampProbe() {
    const b = this.room?.boundsById.get(OBJECTS.lamp);
    if (!b || !this.probeSet?.length) return;
    this.shared.uLampProbe.value.y = OBJECTS.lamp;
    this.lampProbe = this.probes.buildLamp(this.room, this.shared, b.getCenter(new THREE.Vector3()));
    this._applySwitches();
  }

  /**
   * DYS-11: how lamp-lit a moment is, 0..1: the lamp layer's light against the window's and the sun's, by the shell
   * atlas's map scales (each layer's brightest texel; on this bake: night, blue, predawn 0.99, dusk 0.97, dawn 0.98,
   * sunset 0.55, sunrise 0.66; 0 whenever the lamp is off, so every day moment). The night white balance follows it.
   */
  _lampShare(m, lamp) {
    const lum = (s) => (s ? 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2] : 0);
    const l = (this.layers.lamp ? lamp : 0) * lum(this.bake.layers?.lamp?.shell?.scale);
    const a = lum(m?.ambient?.shell?.scale) + (m?.sun ? lum(m.sun.shell?.scale) : 0);
    return l > 0 ? l / (l + a) : 0;
  }

  _applySwitches() {
    const L = this.layers, s = this.shared;
    s.uLayerW.value.set(L.ambient ? 1 : 0, L.sun && this.hasSun ? 1 : 0, L.lamp ? this.light.lamp : 0, L.screen ? this.light.screen : 0);
    s.uSwitch.value.set(L.probes ? 1 : 0, L.coat ? 1 : 0, L.specocc ? 1 : 0, L.energy ? 1 : 0);
    s.uSwitch2.value.set(L.detail ? 1 : 0, L.highlights ? 1 : 0, L.bspline ? 1 : 0, L.mirrorfar ? 1 : 0);
    s.uLampProbe.value.x = L.lampprobe && this.lampProbe ? 1 : 0;
    this.colour.uniforms.uSwitch.value.set(L.lut ? 1 : 0, L.grade ? 1 : 0, L.matrix ? 1 : 0, L.dither ? 1 : 0);
    this.colour.uniforms.uHaze.value.w = L.beams && this.beams?.active ? 1 : 0;
  }

  _setCamera(s) {
    const c = this.cam;
    if (s.position) c.position.fromArray(s.position);
    if (s.quaternion) c.quaternion.fromArray(s.quaternion);
    else if (s.target) {
      const m = new THREE.Matrix4().lookAt(c.position, V3(s.target), V3(s.up || [0, 1, 0]));
      c.quaternion.setFromRotationMatrix(m);
    }
    if (s.fovY !== undefined) c.fovY = s.fovY;
    if (s.near !== undefined) c.near = s.near;
    if (s.far !== undefined) c.far = s.far;
    if (s.shift) c.shift = [s.shift[0], s.shift[1]];
    if (s.focus !== undefined) c.focus = s.focus;
    this.requestFrame();
  }

  _setOutside(s) {
    if (!s) { if (this.outsideCam) { this.outsideCam = null; this.requestFrame(); } return; }
    const o = this.outsideCam || (this.outsideCam = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fovY: 50, shift: [0, 0],
      three: new THREE.PerspectiveCamera(), proj: new THREE.Matrix4() });
    o.position.fromArray(s.position);
    if (s.quaternion) o.quaternion.fromArray(s.quaternion);
    else o.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(o.position, V3(s.target), V3(s.up || [0, 1, 0])));
    o.fovY = s.fovY; o.shift = s.shift ? [s.shift[0], s.shift[1]] : [0, 0];
    this.requestFrame();
  }

  // The outside's camera for this frame (as the room's: its view and its projection with the lens shift, no jitter).
  _outsideFrame(f) {
    const o = this.outsideCam, c = this.cam, cam = o.three;
    cam.position.copy(o.position); cam.quaternion.copy(o.quaternion);
    cam.fov = o.fovY; cam.aspect = this.aspect(); cam.near = c.near; cam.far = c.far;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    o.proj.copy(cam.projectionMatrix);
    o.proj.elements[8] += 2 * o.shift[0]; o.proj.elements[9] += 2 * o.shift[1];
    const out = f.outside || (f.outside = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], sway: [0, 0] });
    o.position.toArray(out.position); o.quaternion.toArray(out.quaternion);
    out.fovY = o.fovY; out.aspect = cam.aspect; out.near = c.near; out.far = c.far; out.shift = o.shift;
    out.view = cam.matrixWorldInverse; out.projectionNoJitter = o.proj; out.projection = o.proj; out.three = cam;
    copyInto(out.sway, c.sway);
    return out;
  }

  _getCamera() {
    const c = this.cam;
    return { position: c.position.toArray(), quaternion: c.quaternion.toArray(), fovY: c.fovY, aspect: this.aspect(), near: c.near, far: c.far,
      shift: [...c.shift], focus: c.focus ? { ...c.focus } : null, jitter: [...this.jit], sway: [...c.sway],
      view: this.camera3.matrixWorldInverse.clone(), projection: this.camera3.projectionMatrix.clone(), projectionNoJitter: this.projNoJitter.clone() };
  }

  _updateCamera() {
    const c = this.cam, cam = this.camera3;
    cam.position.copy(c.position);
    cam.quaternion.copy(c.quaternion);
    cam.fov = c.fovY; cam.aspect = this.aspect(); cam.near = c.near; cam.far = c.far;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const e = cam.projectionMatrix.elements;
    e[8] += 2 * c.shift[0];
    e[9] += 2 * c.shift[1];
    this.projNoJitter.copy(cam.projectionMatrix);
    if (this._camSame()) return false;        // the numbers the key was made from: the same key
    const key = this._camKey();
    const changed = key !== this.camKey;
    this.camKey = key;
    this._camStore();
    return changed;
  }

  // The camera key (its numbers to 6 decimals): a change restarts the refining.
  _camKey() {
    const c = this.cam;
    return [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w,
      c.fovY, c.near, c.far, c.shift[0], c.shift[1], c.focus ? c.focus.distance + "/" + c.focus.fStop : "", this.width, this.height]
      .map((v) => (typeof v === "number" ? v.toFixed(6) : v)).join(",");
  }

  // perf #13: the numbers the last key was made from. An unchanged camera is told from them without building the key
  // (equal numbers give the equal key); any difference builds the key and compares it as before.
  _camSame() {
    const n = this.camNums, c = this.cam, p = c.position, q = c.quaternion, f = c.focus;
    return n !== null && n[0] === p.x && n[1] === p.y && n[2] === p.z && n[3] === q.x && n[4] === q.y && n[5] === q.z &&
      n[6] === q.w && n[7] === c.fovY && n[8] === c.near && n[9] === c.far && n[10] === c.shift[0] && n[11] === c.shift[1] &&
      n[12] === !!f && (!f || (n[13] === f.distance && n[14] === f.fStop)) && n[15] === this.width && n[16] === this.height;
  }

  _camStore() {
    const n = this.camNums || (this.camNums = new Array(17)), c = this.cam, p = c.position, q = c.quaternion, f = c.focus;
    n[0] = p.x; n[1] = p.y; n[2] = p.z; n[3] = q.x; n[4] = q.y; n[5] = q.z; n[6] = q.w;
    n[7] = c.fovY; n[8] = c.near; n[9] = c.far; n[10] = c.shift[0]; n[11] = c.shift[1];
    n[12] = !!f; n[13] = f ? f.distance : 0; n[14] = f ? f.fStop : 0; n[15] = this.width; n[16] = this.height;
  }

  /**
   * Sub-pixel jitter and, while refining with a focus set (and the dof layer on), a point on the lens: the eye moves
   * across the aperture (radius = focal length / (2 f-stop), as Cycles) and the frustum shears so the focus plane
   * stays put. `lens` is [u, v] on the unit disc, or null.
   */
  _applyJitter(j, lens = null) {
    this.jit = j;
    const cam = this.camera3;
    cam.projectionMatrix.copy(this.projNoJitter);
    const e = cam.projectionMatrix.elements;
    e[8] += (2 * j[0]) / this.width;
    e[9] += (2 * j[1]) / this.height;
    const f = this.cam.focus;
    this.lensOffset = null;
    if (lens && f && f.fStop > 0 && f.distance > 0) {
      const tanH = Math.tan((this.cam.fovY * DEG) / 2) * this.aspect();
      const focal = f.focalMM ? f.focalMM / 1000 : 0.018 / tanH;      // horizontal-fit 36 mm sensor unless given
      const R = focal / (2 * f.fStop);
      const ox = lens[0] * R, oy = lens[1] * R;
      cam.position.copy(this.cam.position)
        .add(new THREE.Vector3(1, 0, 0).applyQuaternion(this.cam.quaternion).multiplyScalar(ox))
        .add(new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quaternion).multiplyScalar(oy));
      cam.updateMatrixWorld(true);
      e[8] -= (e[0] * ox) / f.distance;
      e[9] -= (e[5] * oy) / f.distance;
      this.lensOffset = [ox, oy];
    } else if (cam.position.distanceToSquared(this.cam.position) > 0) {
      cam.position.copy(this.cam.position);
      cam.updateMatrixWorld(true);
    }
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  _resize(first = false) {
    // (DYS-149 review 2: phones, the hold with the old moment's maps gone (_bindLight): the drawing buffer keeps its size
    // and the frozen frame (the canvas's CSS box scales it) until the bind applies this resize; cleared here, the room
    // drew dark until the bind, then jumped)
    if (!first && this._mapsOut) { this._resizeHeld = true; return; }
    const q = this.qa;
    const cssW = q && q.width ? q.width : this.canvas.clientWidth || innerWidth;
    const cssH = q && q.height ? q.height : this.canvas.clientHeight || innerHeight;
    const dpr = pixelRatioFor(cssW, cssH, { tier: this.settings.tier, override: q && q.dpr ? q.dpr : null });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    const w = this.renderer.domElement.width, h = this.renderer.domElement.height;
    if (!first && w === this.width && h === this.height) return;
    this.width = w; this.height = h; this.dpr = dpr; this.cssWidth = cssW; this.cssHeight = cssH;
    this.targets.resize(w, h);
    const type = this.settings.accum === 32 && this.caps.floatBlend ? THREE.FloatType : THREE.HalfFloatType;
    this.accum = this.targets.get("room", { type, depth: true, filter: THREE.NearestFilter });
    this.mirror?.resize(w, h);
    this.glass?.resize(w, h);
    this.display = this.targets.get("display", { filter: THREE.NearestFilter });
    this.frozen = this.targets.get("frozen", { filter: THREE.NearestFilter });
    this.count = 0;
    this.fade = null;
    this.hold = false;
    this.mv.landing = null;      // (the moving targets follow the new size at the next moving frame)
    this.invalidate("resize");
    if (!first) {
      const f = this._frameInfo();
      for (const p of this.passes.list) p.pass.resize?.(this.ctxApi, f);
      this.events.emit("resize", { width: w, height: h, dpr });
    }
  }

  _waitStill(ms) {
    return new Promise((res) => {
      const t0 = { t: performance.now() };
      const off = this.on("frame", () => {
        if (this.state === "moving") t0.t = performance.now();
        else if (performance.now() - t0.t >= ms) { off(); res(); }
      });
      if (!this.scheduler.running) { off(); res(); }
    });
  }

  /** The finished room layer (tone mapped, premultiplied, no outside) into the frozen target. */
  _snapshot() {
    if (!this.count) return;
    const u = this.colour.uniforms;
    u.uAccum.value = this.accum.texture;
    u.uCount.value = this.count;
    u.uMode.value = 1;
    u.uFrozenW.value = this.fade ? this._fadeWeight(performance.now()) : (this.hold ? 1 : 0);
    // never leave the target being written bound as a texture (a feedback loop fails the draw in WebGL)
    u.uFrozen.value = u.uFrozenW.value > 0 ? this.frozen.texture : DEFAULT_TEXTURES.black;
    if (u.uFrozenW.value > 0) {
      // a change during a fade: bake the current mix into a copy first, so the old frozen frame isn't read and written at once
      const tmp = this.targets.get("frozen2", { filter: THREE.NearestFilter });
      this.renderer.setRenderTarget(tmp);
      this.fs.draw(this.renderer, this.colour.snapshot);
      this.colour.copyUniforms.uSrc.value = tmp.texture;
      this.renderer.setRenderTarget(this.frozen);
      this.fs.draw(this.renderer, this.colour.copy);
    } else {
      this.renderer.setRenderTarget(this.frozen);
      this.fs.draw(this.renderer, this.colour.snapshot);
    }
    u.uMode.value = 0;
    this.hold = false;
  }

  _fadeWeight(t) {
    if (!this.fade) return 0;
    const x = Math.min(1, Math.max(0, (t - this.fade.start) / this.fade.ms));
    const e = x * x * (3 - 2 * x);         // starts slowly: the first unrefined frames carry little weight
    return 1 - e;
  }

  _frameInfo() {
    return { width: this.width, height: this.height, dpr: this.dpr, cssWidth: this.cssWidth, cssHeight: this.cssHeight,
      state: this.state, reducedMotion: this.settings.reducedMotion, tier: this.settings.tier, qa: this.qa };
  }

  _tick(t) {
    // the display's refresh interval (the shortest gap between animation frames lately; it drifts back up slowly)
    const m = this.mv, d = t - m.lastTick;
    m.lastTick = t;
    m.delta = d;
    if (d > 4 && d < 50) m.vsync = d < m.vsync ? Math.max(d, 6) : Math.min(16.7, m.vsync + 0.01);
    const camChanged = this.room ? this._peekCamera() : false;
    const busy = camChanged || this.invalid || this.state !== "settled" || !!this.fade || this.needsFrame || !!this.hiTier?.busy || !!m.landing;
    const f = this.lastFrame;
    const animating = f ? this.passes.any((p) => p.pass.animating && p.pass.animating(f)) : false;
    if (!busy && !animating) return;
    if (!busy) {
      const minGap = (this.scheduler.idleMinutes() > 10 ? 1000 / 15 : 1000 / 30) - 4;
      if (t - this.lastDraw < minGap) return;
    }
    this._frame(t);
  }

  _peekCamera() {
    return !this._camSame() && this._camKey() !== this.camKey;
  }

  // (DYS-149) Did the outside's own camera change since the last frame (set, moved, or let go)? Its numbers as
  // _outsideFrame reads them; the aspect follows the canvas (a resize is not a gesture).
  _outChanged() {
    const o = this.outsideCam, n = this._outNums || (this._outNums = new Float64Array(11));
    if (!o) { const was = n[0] === 1; n[0] = 0; return was; }
    const p = o.position, q = o.quaternion, s = o.shift;
    const changed = n[0] !== 1 || n[1] !== p.x || n[2] !== p.y || n[3] !== p.z || n[4] !== q.x || n[5] !== q.y || n[6] !== q.z ||
      n[7] !== q.w || n[8] !== o.fovY || n[9] !== s[0] || n[10] !== s[1];
    n[0] = 1; n[1] = p.x; n[2] = p.y; n[3] = p.z; n[4] = q.x; n[5] = q.y; n[6] = q.z; n[7] = q.w; n[8] = o.fovY; n[9] = s[0]; n[10] = s[1];
    return changed;
  }

  _frame(t, { present = true } = {}) {
    if (!this.room) return;
    const r = this.renderer;
    const prevState = this.state;
    const dt = this.lastDraw ? t - this.lastDraw : 16.7;
    this.lastDraw = t;
    this.needsFrame = false;
    this._gpuBegin();
    this.hiTier?.step();     // the close-up tier: one upload step a frame, or its swap at rest (hitex.js)
    // every pass's update() runs first, so a camera set there (N's rig) is the camera this frame is drawn with;
    // the frame object is then refreshed in place with the applied camera, state and window
    const frame = this._buildFrame(t, dt, "none");
    this.events.emit("beforeframe", frame);
    for (const p of this.passes.list) if (p.enabled && p.pass.update) p.pass.update(frame);
    const camChanged = this._updateCamera();
    // (DYS-149: the outside's camera, set in the same update()s (router applyPose): moved now or within OUT_HOLD_MS)
    if (this.zoomCaps) {
      if (this._outChanged()) this._outMovedAt = t;
      this.outsideMoving = t - this._outMovedAt < OUT_HOLD_MS;
    }
    const target = this.settings.samples;
    // perf-r2: a moving frame on a desktop tier draws at the moving scale; the first still frame after moving ones is a
    // live frame at full scale (invalid), crossfaded in from the last moving one (landing)
    const hold = !camChanged && this.mv.active && this.mv.still < MV_HOLD;
    const mvNow = (camChanged || hold) && this._mvAllowed();
    this.mv.still = camChanged ? 0 : this.mv.still + 1;
    if (hold && mvNow) this.invalid = true;                      // (redrawn at the moving scale: a live frame)
    const landed = this.mv.active && !mvNow;
    if (landed) {
      this.invalid = true;
      this.mv.landing = present && !camChanged ? { start: t } : null;
    }
    // a glide ended (at its landing, or its first still frame at full scale): its pacing sets the next one's scale
    if (landed || (!this.mv.active && this.mv.moving && !camChanged)) this._mvApplyNext();
    if (mvNow) { this._mvTargets(); this.mv.landing = null; }
    // this glide's pacing: a moving frame after a moving frame is late when its animation-frame gap was over 1.5 intervals
    if (camChanged && this.mv.moving) { this.mv.win.n++; if (this.mv.delta > 1.5 * this.mv.vsync) this.mv.win.late++; }
    this.mv.active = mvNow;
    this.mv.moving = camChanged;
    this.shared.uMoveBias.value = camChanged || mvNow ? MV_BIAS : 0;
    const R = mvNow ? this.mv.room : this.accum, D = mvNow ? this.mv.display : this.display;
    // (DYS-149 review 4: the last moving frame went without the air: the first still frame is drawn live again, with it,
    // the same frame a moving frame would have left as the sum's first sample, so the picture at rest adds up as before)
    if (this._airLeft && !camChanged) this.invalid = true;
    // (DYS-149 mv-lite: so too after a phone's moving frame drawn cheaper: the first still frame is a whole live frame)
    if (this._liteLeft && !camChanged) this.invalid = true;
    let liteLeft = false;

    // what the room does this frame
    let action = "none";
    // (DYS-161 memory: a phone's room with its textures out (dropRoom: the window zoomed, the room wholly out) is not
    // drawn: its sum stays as it was; a camera change meanwhile draws it again once restoreRoom has them all back)
    // (C's merges review 1: its state as a frame of the room's own would leave it, so a pan of the zoomed view uploads at
    // the moving rate (outside.js, zoom.js read engine.state), not the resting one)
    if (this._drop) { if (camChanged) this.invalid = true; this.state = camChanged ? "moving" : "settled"; }
    else if (camChanged || this.invalid || this.count === 0) {
      action = "live";
      this.sampleK = 0;
      this.stillFrames = 0;
      this.invalid = false;
      this.state = camChanged ? "moving" : "refining";
    } else {
      this.stillFrames++;
      if (this.stillFrames >= 2 && this.count < target) action = "sample";
      else if (this.count >= target) this.state = "settled";
    }
    const lensOn = !!(this.cam.focus && this.layers.dof);
    if (action === "sample") {
      this.state = "refining";
      // with depth of field the live (pinhole) frame leaves the sum: refining restarts from the first lens sample
      if (lensOn && this.sampleK === 0) this.restartSum = true;
      const k = ++this.sampleK;
      this._applyJitter(jitter(k), lensOn ? lensSample(k) : null);
    } else this._applyJitter([0, 0]);
    if (this.fade && t - this.fade.start >= this.fade.ms) this.fade = null;

    this._refreshFrame(frame, t, dt, action);

    this._stage("prepare", frame, null);

    // ---- the desk mirror, redrawn with the live frame (camera or light changed), reused while refining
    if (action === "live" && this.mirror) {
      if (this.layers.mirror && this.layers.probes) this.mirror.render(this.room, this.camera3, this.projNoJitter, this.shared.uProbeA.value, mvNow ? this.mv.scale : 1);
      else this.mirror.off();
    }
    // (DYS-149 mv-lite: a phone's moving frame draws the glass's mirror at MV_GLASS_K of its size each way, into its
    // moving target (perf-r2's: glass.js _targetFor); its first still frame draws it whole again, and only that one
    // refines (glass.js sample))
    if (action === "live" && this.glass?.on && this.layers.glass) {
      const gLite = camChanged && this.mvLite.glass;
      this.glass.render(this.room, this.camera3, this.projNoJitter, (mvNow ? this.mv.scale : 1) * (gLite ? MV_GLASS_K : 1));
      liteLeft ||= gLite;
    }

    // ---- the room into the room buffer (linear light)
    if (action !== "none") {
      // DYS-151: the room's air (beams.js) is added by the room's own fragments: its shadow map first (it binds its own
      // target, so before the room buffer is bound), on only around the room's colour draws below
      const air = !!this.beams?.active && this.layers.beams;
      if (air) this.beams.prepare(0, false);
      r.setRenderTarget(R);
      if (action === "live") {
        // stream I fix: a live frame shows itself; a hold left from the last refine's first samples would otherwise
        // show that frozen frame through a whole camera move or book slide, then pop
        this.hold = false;
        r.setClearColor(0x000000, 0);
        r.clear(true, true, false);
        this.room.setMode("live");
        // (DYS-149 review 4: a phone's moving frame goes without the air, in the room's fragments (an 8-step shadow
        // march and 2 cube taps each) and on the window opening's quad alike, so no seam at the frame; at rest it is
        // drawn as always. Only with ?airmove=0 (phones); by default, and on every desktop, moving frames keep it)
        // (DYS-149 review: the comment said ?airmove=1; the switch is ?airmove=0)
        const airNow = air && (this.airMove || !camChanged);
        this._airLeft = air && !airNow;
        // (DYS-149 mv-lite: a phone's moving frame marches the air in MV_AIR_K of its steps (T1's 8 -> 4), in the room's
        // fragments and on the opening's quad alike (the one shared uBeam), so no seam at the frame; the steps as they
        // were for every other draw, and the first still frame draws it whole again)
        const beam = this.shared.uBeam.value, steps = beam.z, airLite = airNow && camChanged && this.mvLite.air;
        if (airLite) { beam.z = Math.max(2, Math.round(steps * MV_AIR_K)); liteLeft = true; }
        if (airNow) this.beams.prepare(0);
        this.room.draw(this.camera3);
        if (airNow) { this.beams.done(); this.beams.drawOpening(R, this.camera3); }
        beam.z = steps;
        this.count = 1;
      } else {
        if (this.count === 1 && !this.fade) {
          // the first refining sample: hold the live frame until 4 samples are in, so edges don't sizzle
          this._snapshot();
          this.hold = true;
          r.setRenderTarget(this.accum);
        }
        if (this.restartSum) {
          r.setClearColor(0x000000, 0);
          r.clear(true, false, false);
          this.count = 0;
          this.restartSum = false;
        }
        r.clear(false, true, false);
        this.room.setMode("prepass");
        this.room.draw(this.camera3);
        this.room.setMode("add");
        if (air) this.beams.prepare(this.count);
        this.room.draw(this.camera3);
        if (air) { this.beams.done(); this.beams.drawOpening(this.accum, this.camera3); }
        // the night glass refines with the room: its mirror takes this sample's jitter and lens point (glass.js)
        if (this.glass?.on && this.layers.glass) this.glass.sample(this.room, this.sampleK, this.lensOffset, this.cam.focus?.distance);
        this.count++;
      }
      frame.room.sample = this.count - 1;
      frame.room.count = this.count;
      this._stage("room", frame, R);
      // (DYS-149 mv-lite: once a live frame's room (and the room stage) is drawn, nothing reads the room buffer's depth:
      // the next frame clears it before it draws. A phone's moving frame lets it go rather than store it, ~5 MB a frame
      // at 1.3 MP that a tiled GPU otherwise writes out (S10))
      if (action === "live" && camChanged && this.mvLite.depth) {
        r.setRenderTarget(R);
        this.gl.invalidateFramebuffer(this.gl.FRAMEBUFFER, [this.gl.DEPTH_ATTACHMENT]);
      }
      if (action === "live") this._liteLeft = liteLeft;
      if (this.count >= target) {
        this.state = "settled";
        this.hold = false;
      }
      if (this.count >= 4) this.hold = false;
    }

    // ---- the display picture: outside, then the room over it, then overlays
    r.setRenderTarget(D);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    const rect = frame.window.rect;
    if (rect[2] > 0 && rect[3] > 0 && this.passes.stage("outside").length) {
      this._stage("outside", frame, D, rect);
    }
    const u = this.colour.uniforms;
    u.uAccum.value = R.texture;
    u.uCount.value = this.count;
    u.uMode.value = 0;
    u.uFrozen.value = this.frozen.texture;
    u.uFrozenW.value = this.fade ? this._fadeWeight(t) : this.hold ? 1 : 0;
    frame.light.fade = u.uFrozenW.value;
    r.setRenderTarget(D);
    // (v3/zoom-r3: the room laid over the outside as much as it is in the picture; the snapshot keeps the whole room)
    // (DYS-149: not drawn at full zoom (roomW 0; it is 0 exactly there, 1 - ease(1)): it writes room x 0 = (0, 0, 0, 0)
    // through ONE, ONE_MINUS_SRC_ALPHA, no depth, so D stays as the outside drew it, bit for bit. Any roomW above 0
    // (the fade's frames) draws as before. ?zoomcaps=0: drawn)
    if (!(this.zoomSkip && this.roomW <= 0)) {
      u.uRoomW.value = this.roomW;
      this.fs.draw(r, this.colour.composite);
      u.uRoomW.value = 1;
    }
    if (this.glass && this.layers.glass) this.glass.overlay(R, this.count, frame.width, frame.height, this.roomW);
    this._stage("overlay", frame, D);

    // ---- post chain to the canvas
    if (present) {
      const post = this.passes.stage("post");
      if (!post.length && (mvNow || this.mv.landing)) {
        // a moving frame scaled up to the canvas, or a landing: the full frame crossfaded in from the last moving one
        let w = 1;
        if (!mvNow) {
          const x = Math.min(1, Math.max(0, (t - this.mv.landing.start) / MV_LANDING_MS));
          w = 1 - x * x * (3 - 2 * x);
          if (x >= 1) this.mv.landing = null;
        }
        const pu = this.colour.presentUniforms;
        pu.uSrc.value = this.display.texture;
        pu.uPrev.value = this.mv.display.texture;
        pu.uPrevW.value = w;
        r.setRenderTarget(null);
        this.fs.draw(r, this.colour.present);
      } else if (!post.length) {
        this.colour.copyUniforms.uSrc.value = this.display.texture;
        r.setRenderTarget(null);
        this.fs.draw(r, this.colour.copy);
      } else {
        let input = this.display.texture;
        post.forEach((p, i) => {
          const last = i === post.length - 1;
          const out = last ? null : this.targets.get(i % 2 ? "postB" : "postA");
          frame.post = { input, output: out };
          r.setRenderTarget(out);
          this._run(p, frame);
          if (out) input = out.texture;
        });
      }
    }
    this._gpuEnd(t, camChanged, mvNow ? this.mv.scale : 1);
    this.frameIndex++;
    this.lastFrame = frame;
    if (prevState !== this.state) this.events.emit("statechange", { from: prevState, to: this.state });
    if (action === "sample" && this.state === "settled") this.events.emit("refined", frame);
    this.events.emit("frame", frame);
  }

  // perf #13: the frame object refreshed in place once the passes' update() and the camera have run: the values
  // _buildFrame(t, dt, action) gives, written into the objects and arrays this draw's frame already has (each draw
  // still gets a frame of its own).
  _refreshFrame(f, t, dt, action) {
    const c = this.cam, fc = f.camera, r = f.room, w = f.window, x = f.textures;
    // perf-r2: a moving frame's size is its targets' (the moving scale); the CSS size stays the canvas's
    const mv = this.mv.active ? this.mv : null;
    const W = mv ? mv.room.width : this.width, H = mv ? mv.room.height : this.height;
    const accum = mv ? mv.room : this.accum, display = mv ? mv.display : this.display;
    f.index = this.frameIndex; f.time = t; f.dt = dt;
    f.width = W; f.height = H; f.dpr = mv ? (this.dpr * W) / this.width : this.dpr; f.cssWidth = this.cssWidth; f.cssHeight = this.cssHeight;
    f.state = this.state;
    c.position.toArray(fc.position); c.quaternion.toArray(fc.quaternion);
    fc.fovY = c.fovY; fc.aspect = this.aspect(); fc.near = c.near; fc.far = c.far;
    copyInto(fc.shift, c.shift); copyInto(fc.jitter, this.jit);
    fc.view = this.camera3.matrixWorldInverse; fc.projection = this.camera3.projectionMatrix;
    fc.projectionNoJitter = this.projNoJitter; fc.three = this.camera3; copyInto(fc.sway, c.sway); fc.focus = c.focus;
    r.drawn = action !== "none"; r.sample = Math.max(0, this.count - 1); r.count = this.count; r.target = accum;
    f.light = { ...this.light, exposure: Math.log2(this.colour.uniforms.uExposure.value), sun: this.hasSun, fade: 0 };
    // (v3/zoom-r3: while the room fades, the outside fills the whole screen behind it, through its own camera if zoomed)
    f.roomW = this.roomW;
    f.outside = this.outsideCam ? this._outsideFrame(f) : null;
    f.outsideMoving = this.outsideMoving;   // (DYS-149: a zoom gesture: the uploads at their moving caps, phones)
    if (this.roomW < 1) w.rect = [0, 0, W, H];
    else w.rect = this.room.windowRect({ matrixWorldInverse: this.camera3.matrixWorldInverse, projectionMatrix: this.projNoJitter, near: this.cam.near }, W, H);
    const wc = this.room.window.corners;
    if (w.corners.length !== wc.length) w.corners = wc.map((v) => v.toArray());
    else for (let i = 0; i < wc.length; i++) wc[i].toArray(w.corners[i]);
    x.room = accum.texture; x.roomAlpha = accum.texture; x.display = display.texture;
    f.post = null;
    f.reducedMotion = this.settings.reducedMotion; f.tier = this.settings.tier; f.qa = this.qa;
  }

  // ---- perf-r2: the moving scale
  _mvAllowed() {
    // (v3/zoom-r3: not while the room fades or is out: the outside alone is drawn at full size, and the room's one camera
    // move at the end of a zoom never softens the picture)
    return this.layers.mvscale && this.mv.scale < 1 && !this.qa && !this.fade && !this.passes.stage("post").length && this.roomW >= 1;
  }

  /** The moving frames' room and display targets at the current scale (made, or resized, only when that changes). */
  _mvTargets() {
    const m = this.mv, w = Math.max(16, Math.round(this.width * m.scale)), h = Math.max(16, Math.round(this.height * m.scale));
    if (!m.room) {
      const type = this.settings.accum === 32 && this.caps.floatBlend ? THREE.FloatType : THREE.HalfFloatType;
      const opts = (t, filter, depth) => ({ type: t, format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false, minFilter: filter,
        magFilter: filter, generateMipmaps: false, colorSpace: THREE.NoColorSpace });
      m.room = new THREE.WebGLRenderTarget(w, h, opts(type, THREE.NearestFilter, true));
      m.room.texture.name = "room-moving";
      // the canvas reads it scaled up: linear filtering
      m.display = new THREE.WebGLRenderTarget(w, h, opts(THREE.UnsignedByteType, THREE.LinearFilter, false));
      m.display.texture.name = "display-moving";
    } else if (m.room.width !== w || m.room.height !== h) {
      m.room.setSize(w, h);
      m.display.setSize(w, h);
    }
  }

  /** A moving frame's GPU time at `scale` (a few frames late), kept for this glide's decision. */
  _mvLearn(ms, scale) {
    const g = this.mv.win.gpu;
    if (scale === this.mv.scale) { g.push(ms); if (g.length > 240) g.shift(); }
  }

  /**
   * At a landing: one step down when over 2 % of the glide's moving frames came late; one step up only after 3 clean
   * glides in a row (none late, 30 or more moving frames each) when the measured GPU time, scaled to the next step's
   * pixels, still fits MV_BUDGET of the refresh interval (ANGLE's Metal timer reads high, queue waits included, so it
   * only ever holds a step up back). Quick down, slow up: a light glide doesn't buy a step a heavy one then pays for.
   */
  _mvApplyNext() {
    const m = this.mv, w = m.win;
    m.win = { n: 0, late: 0, gpu: [] };
    if (m.pinned || !this.layers.mvscale || w.n < 10) return;
    const gpu = w.gpu.length ? [...w.gpu].sort((a, b) => a - b)[w.gpu.length >> 1] : null;
    const up = Math.min(1, +(m.scale + MV_STEP).toFixed(2));
    let next = m.scale;
    if (gpu !== null && w.gpu.length >= 10) {
      // DYS-37: with the GPU timer, a clean glide (frames on time, the GPU within budget) goes straight up to the largest
      // step its time says fits, not 0.05 per three clean glides (a visit sat at 0.75-0.85 on a GPU that fits 1); the
      // pixel rule over-states a step up's cost, so a step up doesn't come straight back down
      const budget = MV_BUDGET * m.vsync, fits = +(Math.floor((m.scale * Math.sqrt(budget / gpu)) / MV_STEP + 1e-6) * MV_STEP).toFixed(2);
      const late = w.late / w.n > 0.02;
      // (D's re-run at normal priority, 29 Oct, rule 11: the GPU's time grows through a visit with what the view has
      // loaded, 5 -> 14-17 ms at a fixed 0.85, and hardly follows the pixels: stepped down on time alone, 1 -> 0.65 in four
      // glides for nothing, while 13-17 ms still made every frame. So down only when frames were really late and the GPU
      // was over budget, one step; and not again when the last step down didn't take a tenth off the GPU's time)
      if (late && gpu > budget) {
        if (!m.down || gpu < m.down * 0.9) { next = Math.max(MV_FLOOR, +(m.scale - MV_STEP).toFixed(2)); m.down = gpu; }
      } else if (!late && gpu <= budget) { next = Math.max(m.scale, Math.min(1, fits)); if (next > m.scale) m.down = 0; }
    } else if (w.late / w.n > 0.02) { next = Math.max(MV_FLOOR, +(m.scale - MV_STEP).toFixed(2)); m.clean = 0; }
    else if (!w.late && w.n >= 30) {
      // (no GPU timer, e.g. Safari: the frames' pacing as before)
      if (++m.clean >= 3 && gpu !== null && gpu * (up / m.scale) ** 2 < MV_BUDGET * m.vsync) { next = up; m.clean = 0; }
    } else if (w.late) m.clean = 0;
    m.last = { frames: w.n, late: w.late, gpuMs: gpu === null ? null : +gpu.toFixed(2), from: m.scale, to: next };
    if (next !== m.scale) { try { localStorage.setItem(MV_KEY, JSON.stringify({ gpu: this.mvGpu, scale: next })); } catch { /* storage blocked */ } }
    m.scale = next;
  }

  /** The moving scale now: { scale, pinned, on, vsyncMs, last: the last glide's { frames, late, gpuMs, from, to } }. */
  get movingScale() {
    const m = this.mv;
    return { scale: m.scale, pinned: m.pinned, on: !!this.layers.mvscale && m.scale < 1, vsyncMs: +m.vsync.toFixed(2), last: m.last };
  }

  // ---- perf-r2: each drawn frame timed on the GPU ("gputime" events; the moving scale learns from the moving ones)
  _gpuBegin() {
    const g = this.gpuTimer;
    if (!g || g.q || g.pend.length > 8) return;
    try { g.q = this.gl.createQuery(); this.gl.beginQuery(g.ext.TIME_ELAPSED_EXT, g.q); } catch (e) { g.q = null; }
  }

  _gpuEnd(t, moving, scale) {
    const g = this.gpuTimer;
    if (!g) return;
    const gl = this.gl;
    if (g.q) { gl.endQuery(g.ext.TIME_ELAPSED_EXT); g.pend.push({ q: g.q, t, moving, scale }); g.q = null; }
    while (g.pend.length && gl.getQueryParameter(g.pend[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const p = g.pend.shift();
      const ms = gl.getParameter(g.ext.GPU_DISJOINT_EXT) ? null : gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(p.q);
      if (ms === null) continue;
      if (p.moving) this._mvLearn(ms, p.scale);
      this.events.emit("gputime", { time: p.t, ms, moving: p.moving, scale: p.scale });
    }
  }

  _buildFrame(t, dt, action) {
    const c = this.cam;
    return {
      index: this.frameIndex, time: t, dt,
      width: this.width, height: this.height, dpr: this.dpr, cssWidth: this.cssWidth, cssHeight: this.cssHeight,
      state: this.state,
      camera: {
        position: c.position.toArray(), quaternion: c.quaternion.toArray(), fovY: c.fovY, aspect: this.aspect(), near: c.near, far: c.far,
        shift: [...c.shift], jitter: [...this.jit], view: this.camera3.matrixWorldInverse, projection: this.camera3.projectionMatrix,
        projectionNoJitter: this.projNoJitter, three: this.camera3, sway: [...c.sway], focus: c.focus,
      },
      room: { drawn: action !== "none", sample: Math.max(0, this.count - 1), count: this.count, target: this.accum },
      light: { ...this.light, exposure: Math.log2(this.colour.uniforms.uExposure.value), sun: this.hasSun, fade: 0 },
      window: { rect: this.room.windowRect({ matrixWorldInverse: this.camera3.matrixWorldInverse, projectionMatrix: this.projNoJitter, near: this.cam.near }, this.width, this.height),
        corners: this.room.window.corners.map((v) => v.toArray()) },
      textures: { room: this.accum.texture, roomAlpha: this.accum.texture, display: this.display.texture },
      post: null,
      reducedMotion: this.settings.reducedMotion, tier: this.settings.tier, qa: this.qa,
      roomW: this.roomW, outside: null, outsideMoving: this.outsideMoving,
    };
  }

  _stage(name, frame, target, scissor = null) {
    const list = this.passes.stage(name);
    if (!list.length) return;
    for (const p of list) {
      if (p.pass.needsRender && !p.pass.needsRender(frame)) continue;
      // render targets carry their own scissor in three.js (in target pixels)
      if (target && scissor) { target.scissor.set(scissor[0], scissor[1], scissor[2], scissor[3]); target.scissorTest = true; }
      this.renderer.setRenderTarget(target);
      this._run(p, frame);
      if (target && scissor) { target.scissorTest = false; this.renderer.setRenderTarget(target); }
    }
  }

  _run(p, frame) {
    try {
      p.pass.render?.(this.ctxApi, frame);
    } catch (e) {
      console.error(`[engine] pass ${p.name}`, e);
      p.enabled = false;
    }
    if (p.raw) this.renderer.resetState();
  }

  _lost() {
    this.scheduler.stop();
    this.hiTier?.lost();
    this.events.emit("contextlost", {});
    this.lostTimer = setTimeout(() => this._fail("context-lost"), 4000);
  }

  async _restored() {
    clearTimeout(this.lostTimer);
    // (DYS-151) released pictures cannot be uploaded again: the photographs, as when a restore fails
    if (phoneMemory.released) { this._fail("context-lost"); return; }
    try {
      // render targets and reflection maps lost their contents: rebuild the probes, restart refining
      this.probes.dispose();
      this.probes = new Probes(this.renderer, this.fs, this.settings.tier === "T1" ? 256 : 512);
      this.probes.keepScreen = !this.layers.screenmask;
      this.lampProbe = false;
      this._applySwitches();
      if (this.gpuTimer) { this.gpuTimer.q = null; this.gpuTimer.pend = []; }   // the lost context's queries are gone
      this.mv.active = false;
      this.mv.landing = null;
      const m = this.light.moment;
      this.light.moment = null;
      for (const p of this.passes.list) p.pass.init?.(this.ctxApi);
      if (m) await this.setLight({ moment: m }, { fade: 0 });
      this.count = 0;
      this.invalidate("context restored");
      this.events.emit("contextrestored", {});
      this.scheduler.start();
      this.hiTier?.restored();
    } catch (e) {
      this._fail("context-lost");
    }
  }
}

/** Create the engine on a canvas (docs/v3/engine-api.md section 1). Rejects with an EngineFallback. */
export async function createEngine(opts) {
  const support = engineSupport({ probeGL: false });
  if (!support.ok && !(opts.qa && support.reason === "save-data")) throw new EngineFallback(support.reason);
  const ctx = createContext(opts.canvas, opts);
  await nextTask();                       // making the context is one main-thread task; the rest is another
  return new Engine(opts.canvas, opts, ctx);
}

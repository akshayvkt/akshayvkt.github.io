// The room engine (stream E1): one WebGL2 context, one render loop, the room drawn with baked light and refined
// at rest, the colour path, passes for the other streams, picking and the QA hook.
// The contract is docs/v3/engine-api.md; read that rather than this file.
import * as THREE from "three";
import { createContext, engineSupport, EngineFallback, Fullscreen, gpuIdle, nextTask, pixelRatioFor, Targets } from "./context.js";
import { Emitter, jitter, lensSample, Passes, Scheduler } from "./loop.js";
import { loadModel, within } from "./loader.js";
import { objectName, OBJECTS, REGIONS, Room, useIdTables } from "./room.js";
import { DEFAULT_TEXTURES, makeDFG, sharedUniforms } from "./material.js";
import { Probes } from "./probes.js";
import { Colour } from "./colour.js";
import { DeskMirror } from "./mirror.js";
import { Beams } from "./beams.js";
import { GlassMirror } from "./glass.js";
import { applyAnisotropy, HiTier } from "./hitex.js";

export { engineSupport, EngineFallback };
export const ENGINE_VERSION = "e1-v1.10";
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
// a slow drag has frames without a move between its moves: the moving scale holds through MV_HOLD such frames (each
// redrawn at the moving scale) before the landing, so the picture doesn't switch scale back and forth
const MV_HOLD = 2;

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
    const tier = params.get("tier") || (opts.tier && opts.tier !== "auto" ? opts.tier : (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600 ? "T1" : "T2"));
    this.settings = { reducedMotion: rm, tier, samples: tier === "T1" ? 12 : 32, accum: params.get("accum") === "32" ? 32 : 16 };
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
    this.mv = { scale: pinned ? mvq : MV_START, pinned, next: null, active: false, room: null, display: null,
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
      this.events.emit("fallback", { reason: "load-failed" });
      throw new EngineFallback("load-failed", e && e.message);
    }
  }

  async _loadRoom({ bake, room3d, onProgress } = {}) {
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
    const [gltf] = await Promise.all([
      loadModel(within(this.bakeUrl, this.bake.model), this.renderer, { onProgress }),
      this.colour.load(),
    ]);
    this.timings.modelAndLut = Math.round(performance.now() - t1);
    const t2 = performance.now();
    const probeW = this.settings.tier === "T1" ? 256 : 512;
    this.cubeUV = Probes.defines(probeW);
    this.room = new Room(this.renderer, this.shared).build(gltf, this.bake, this.cubeUV);
    // anisotropic filtering on the material maps (before their first upload), and the close-up tier (hitex.js)
    applyAnisotropy(this);
    this.hiTier = new HiTier(this);
    this.hiTier.setManifest(this.room3d?.hi, within(this.bakeUrl, this.bake.model));
    if (this.bake.box) { this.shared.uBoxMin.value.fromArray(this.bake.box[0]); this.shared.uBoxMax.value.fromArray(this.bake.box[1]); }
    const sr = this.room.screenRect;
    if (sr) {
      this.shared.uScrC.value.fromArray(sr.centre); this.shared.uScrU.value.fromArray(sr.u); this.shared.uScrV.value.fromArray(sr.v);
      this.shared.uScrN.value.fromArray(sr.normal); this.shared.uScrL.value.fromArray(sr.radiance);
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
    // the sunbeams (plan 2.6): drawn over the room after each room sample in the moments with room air
    this.beams = new Beams(this.renderer, this.room, this.shared, this.cubeUV,
      { box: this.room3d?.room?.inner, steps: this.settings.tier === "T1" ? 8 : 16 });
    // the night glass (plan 2.4): the room reflected in the pane, screen-blended over the window in the dark moments
    const wr = this.shared.uWindowRect.value;
    this.glass = new GlassMirror(this.renderer, this.shared, this.colour, this.fs, { rect: [wr.x, wr.y, wr.z, wr.w], ...(this.settings.tier === "T1" ? { lens: 0.5 } : {}) });
    this.glass.resize(this.width, this.height);
    const atlasSize = Object.values(this.bake.atlases || { room: { size: 1024 } })[0].size;
    this.shared.uAtlasTexel.value.set(1 / atlasSize, atlasSize);
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

  /** Compile every room shader (in parallel where the browser can) and draw one hidden frame. */
  async warmUp() {
    // Every program compiles in parallel where the browser can (KHR_parallel_shader_compile), then each kind of draw
    // runs once in its own task: the first draw of a program with a new render state can still stall (ANGLE builds
    // the Metal pipeline then), and spreading them keeps each main-thread task short.
    const t0 = performance.now();
    this._updateCamera();
    await this.renderer.compileAsync(this.room.scene, this.camera3);
    if (this.beams) {
      this.room.scene.overrideMaterial = this.beams.beamMat;
      await this.renderer.compileAsync(this.room.scene, this.camera3);
      this.room.scene.overrideMaterial = null;
    }
    const tc = performance.now();
    for (const m of [this.colour.composite, this.colour.snapshot, this.colour.copy, this.colour.present, this.probes.decode, this.probes.sum, this.probes.skyMat, ...(this.mirror ? [this.mirror.fill] : []), this.glass.material]) {
      this.fs.mesh.material = m;
      await this.renderer.compileAsync(this.fs.scene, this.fs.camera);
    }
    this.timings.compileRoom = Math.round(tc - t0);
    this.timings.compileAll = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const r = this.renderer, steps = [
      () => { r.setRenderTarget(this.accum); r.clear(true, true, false); this.room.setMode("live"); this.room.draw(this.camera3); },
      () => { r.setRenderTarget(this.accum); r.clear(false, true, false); this.room.setMode("prepass"); this.room.draw(this.camera3); },
      () => { r.setRenderTarget(this.accum); this.room.setMode("add"); this.room.draw(this.camera3); this.room.setMode("live"); },
      () => { this.count = 1; this._snapshot(); },
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
    if (!this.room) return;
    await nextTask();
    const a = performance.now();
    this._frame(performance.now(), { present: false });
    await gpuIdle(this.gl);
    this.count = 0;
    this.invalidate("warm-light");
    this.timings.warmLight = Math.round(performance.now() - a);
  }

  /** Switch the room's light (section 7). Resolves when the new light is loaded and applied. */
  async setLight(next, { fade, waitStill = 0 } = {}) {
    const moment = next.moment ?? this.light.moment;
    const m = this.bake.moments[moment];
    if (!m) throw new Error(`unknown moment ${moment}`);
    const lamp = next.lamp ?? (moment !== this.light.moment && next.lamp === undefined ? (m.lamp_default ?? this.light.lamp) : this.light.lamp);
    const scr = next.screen ?? this.light.screen;
    const momentChanged = moment !== this.light.moment;
    const lampChanged = lamp !== this.light.lamp;
    let applyAmb = null, applySun = null, prepared = this.probeSet || [];
    if (momentChanged) {
      [applyAmb, applySun, prepared] = await Promise.all([
        this._loadLayerSet("ambient", m.ambient),
        this._loadLayerSet("sun", m.sun || null),
        this.probes.prepare(this.bakeUrl, m),
      ]);
    }
    if (waitStill > 0) await this._waitStill(waitStill);
    const ms = fade ?? (momentChanged ? 2500 : 200);
    const doFade = this.count > 0 && ms > 0;
    if (doFade) {
      this._snapshot();
      // hold the frozen frame fully while the new light is bound (the probe rebuild spans two tasks)
      this.fade = { start: Infinity, ms: this.settings.reducedMotion ? Math.min(ms, 150) : ms };
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
    this._applySwitches();
    this._buildLampProbe();
    if (doFade) this.fade.start = performance.now();
    this.invalidate("light");
    this.events.emit("lightchange", { light: { ...this.light }, fadeMs: doFade ? this.fade.ms : 0 });
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

  start() { this.scheduler.start(); this.requestFrame(); }
  stop() { this.scheduler.stop(); }

  /** Draw frames now, without waiting for the browser (QA, tests): until settled or `max` frames. */
  renderSteps(max = 64) {
    let n = 0;
    do { this._frame(performance.now()); n++; } while (n < max && (this.state !== "settled" || this.fade));
    return n;
  }

  async pick(cssX, cssY) {
    if (!this.room) return null;
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
    for (const [name] of this.room.atlases) {
      const e = spec ? spec[name] : null;
      loaded.push(e ? this.room.layerTexture(within(this.bakeUrl, e.file)).then((t) => [name, t, e.scale]) : Promise.resolve([name, null, null]));
    }
    const done = await Promise.all(loaded);
    const keys = { ambient: ["uAmbient", "uAmbientScale"], sun: ["uSun", "uSunScale"], lamp: ["uLamp", "uLampScale"], screen: ["uScreen", "uScreenScale"] }[which];
    return () => {
      for (const [name, t, scale] of done) {
        const u = this.room.atlases.get(name);
        if (t) { u[keys[0]].value = t; u[keys[1]].value.fromArray(scale); }
        else u[keys[1]].value.set(0, 0, 0);
      }
    };
  }

  /** The lamp's probe (probes.js buildLamp), from the room as it is lit now; the lamp's parts read it. */
  _buildLampProbe() {
    const b = this.room?.boundsById.get(OBJECTS.lamp);
    if (!b || !this.probeSet?.length) return;
    this.shared.uLampProbe.value.y = OBJECTS.lamp;
    this.lampProbe = this.probes.buildLamp(this.room, this.shared, b.getCenter(new THREE.Vector3()));
    this._applySwitches();
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
    const R = mvNow ? this.mv.room : this.accum, D = mvNow ? this.mv.display : this.display;

    // what the room does this frame
    let action = "none";
    if (camChanged || this.invalid || this.count === 0) {
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
    if (action === "live" && this.glass?.on && this.layers.glass) this.glass.render(this.room, this.camera3, this.projNoJitter, mvNow ? this.mv.scale : 1);

    // ---- the room into the room buffer (linear light)
    if (action !== "none") {
      r.setRenderTarget(R);
      if (action === "live") {
        // stream I fix: a live frame shows itself; a hold left from the last refine's first samples would otherwise
        // show that frozen frame through a whole camera move or book slide, then pop
        this.hold = false;
        r.setClearColor(0x000000, 0);
        r.clear(true, true, false);
        this.room.setMode("live");
        this.room.draw(this.camera3);
        this.count = 1;
        if (this.beams?.active && this.layers.beams) this.beams.draw(R, this.camera3, 0);
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
        this.room.draw(this.camera3);
        if (this.beams?.active && this.layers.beams) this.beams.draw(this.accum, this.camera3, this.count);
        // the night glass refines with the room: its mirror takes this sample's jitter and lens point (glass.js)
        if (this.glass?.on && this.layers.glass) this.glass.sample(this.room, this.sampleK, this.lensOffset, this.cam.focus?.distance);
        this.count++;
      }
      frame.room.sample = this.count - 1;
      frame.room.count = this.count;
      this._stage("room", frame, R);
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
    this.fs.draw(r, this.colour.composite);
    if (this.glass && this.layers.glass) this.glass.overlay(R, this.count, frame.width, frame.height);
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
    w.rect = this.room.windowRect({ matrixWorldInverse: this.camera3.matrixWorldInverse, projectionMatrix: this.projNoJitter, near: this.cam.near }, W, H);
    const wc = this.room.window.corners;
    if (w.corners.length !== wc.length) w.corners = wc.map((v) => v.toArray());
    else for (let i = 0; i < wc.length; i++) wc[i].toArray(w.corners[i]);
    x.room = accum.texture; x.roomAlpha = accum.texture; x.display = display.texture;
    f.post = null;
    f.reducedMotion = this.settings.reducedMotion; f.tier = this.settings.tier; f.qa = this.qa;
  }

  // ---- perf-r2: the moving scale
  _mvAllowed() {
    return this.layers.mvscale && this.mv.scale < 1 && !this.qa && !this.fade && !this.passes.stage("post").length;
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
    if (w.late / w.n > 0.02) { next = Math.max(MV_FLOOR, +(m.scale - MV_STEP).toFixed(2)); m.clean = 0; }
    else if (!w.late && w.n >= 30) {
      if (++m.clean >= 3 && gpu !== null && gpu * (up / m.scale) ** 2 < MV_BUDGET * m.vsync) { next = up; m.clean = 0; }
    } else if (w.late) m.clean = 0;
    m.last = { frames: w.n, late: w.late, gpuMs: gpu === null ? null : +gpu.toFixed(2), from: m.scale, to: next };
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
    this.lostTimer = setTimeout(() => this.events.emit("fallback", { reason: "context-lost" }), 4000);
  }

  async _restored() {
    clearTimeout(this.lostTimer);
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
      this.events.emit("fallback", { reason: "context-lost" });
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

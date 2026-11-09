// The room engine (stream E1): one WebGL2 context, one render loop, the room drawn with baked light and refined
// at rest, the colour path, passes for the other streams, picking and the QA hook.
// The contract is docs/v3/engine-api.md; read that rather than this file.
import * as THREE from "three";
import { createContext, engineSupport, EngineFallback, Fullscreen, gpuIdle, nextMessage, nextTask, pixelRatioFor, Targets } from "./context.js";
import { Emitter, jitter, lensSample, Passes, Scheduler } from "./loop.js";
import { closeSource, loadModel, lightTextures, phoneMemory, phoneTextures, refetchSource, trimPool, warmPool, within } from "./loader.js";
import { earlyFetch, takeEarly } from "./early.js";   // (DYS-203 start sooner: bake.json, the set's room3d.json, the model)
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
// (DYS-203 start sooner) the model's file asked for alongside light-tex.json (and the AVIF test), not after it: its
// bytes do not depend on the manifest, only its textures' names do (loadModel's URL modifier). The same file, read the
// same way (asked through early.js, whose bytes loader.js fetchBytes takes, the first visit's progress included); a model
// that fails to load with the light textures is read again for the originals, as before. ?modelpar=0: one after the
// other, as before.
const MODEL_PAR = params.get("modelpar") !== "0";
// (DYS-203 fewer steps) the first decode worker started as the room starts loading (loader.js warmPool), its script asked
// for beside bake.json rather than a round trip after the first picture to decode. ?poolwarm=0: by that picture, as before
const POOL_WARM = params.get("poolwarm") !== "0";
const MV_BIAS = params.has("mvbias") ? Math.max(0, parseFloat(params.get("mvbias")) || 0) : 0;
// (DYS-149 mv-lite) a phone's moving frame: the night glass's mirror at this share of its size each way (glass.js
// _targetFor: a quarter of its pixels), the sunbeams' air with this share of its march steps (T1's 8 -> 4)
const MV_GLASS_K = 0.5, MV_AIR_K = 0.5;
// (DYS-161 memory) restoreRoom: rounds before a room whose textures don't come back ends, and the wait between
const RESTORE_TRIES = 3, RESTORE_RETRY_MS = 2000;
// (DYS-161 memory, RD3) restoreRoom: the decode workers its pictures may use (loader.js's pool: the boot's 2, the rest
// started for the restore and let go after it), its lanes one more; ?restorepool=<n> to try another
const RESTORE_POOL = 3;
// (DYS-161 roomdrop-tap) dropRoom: each material map's mip levels from this one down are kept on the GPU (copied there,
// nothing decoded: _standIns) and drawn in its place while it is out, so the room can come back before restoreRoom has
// them all: 1, a half-size copy (a quarter of its memory: ~36 of the 146 MB stay); ?roomdropmip=2: a quarter-size one
// (~9 MB); ?roomdropmip=0: none (RD3's way: the room waits, unseen, for all of them)
const ROOM_STAND_MIP = 1;
// (DYS-203 boot-device BD-a: the warm-up's programs all asked for first (the room's and the nine full-screen ones), the
// room's maps uploaded while the browser compiles them, then one wait for them all: they were one compileAsync after
// another, each its own 10 ms poll (WebKit has no KHR_parallel_shader_compile: a bare 10 ms wait each), and the uploads
// only after the last. The same programs and the same uploads, so the same pixels. rs3-0135 J1 traces: the compiles
// 94-99 ms of the warm-up on the laptop and the mid phone, the uploads after them 260-280 ms. ?compilepar=0: as before)
// (named apart from v3/boot-first's ?bootpar, its room3d.json before the first visit's module)
const COMPILE_PAR = params.get("compilepar") !== "0";
// (DYS-203 HS1, handoff-smooth) ... but not on the phone tier (T1) unless ?compilepar=1: DY1 (dy1-2325), the phone on fast 4G
// (CPU 4x) waited 0.29 s longer with it than with ?compilepar=0 (the branch's runs 0.02 s apart), and WebKit (every
// iPhone) has no KHR_parallel_shader_compile for it to overlap. The desktop tiers keep it
const COMPILE_PAR_T1 = params.get("compilepar") === "1";
// (DYS-216 F, lane 4: ?compilelean=1, on T1 only; off by default until Akshay's before/after) a first visit compiles every
// shader cold on a phone (an iPhone after a deploy: no Metal cache for our MSL yet). The browser's GPU process compiles
// one program at a time, in send order, and any GL answer about a program waits behind every compile sent before it:
// compile_probe CP1 (WebKit iPhone 13, cold) 1.84 -> 5.16 s to room-shown, 3.1 s of the main thread blocked, warmFrames
// 0.06 -> 1.95 s. With it: the phone takes the send-all-then-wait path above (COMPILE_PAR: CP1 cold, WebKit -0.44 s,
// Chrome CPU 6x -0.7 s; DY1's +0.29 s that kept it off T1 was warm shaders), and the full-screen programs the first view
// does not draw (copy: a change mid-fade; present: the outside's moving frames, landings; the glass at a moment without
// it) are not in the warm-up: compileLater() sends them after the room is shown, one an idle slice (router.js reveal)
// (DYS-216 first ship, the coordinator's yes 1 Nov 18:2x: on by default, on T1 only (warmUp's lean); ?compilelean=0 off, as before)
const COMPILE_LEAN = params.get("compilelean") !== "0";
// (DYS-216, Deploy 13c's bar: leaving copy / present / the off-moment glass out of the warm-up cost a first-use frame at
// the first essay open, their Metal pipelines built at that draw (H, WebKit iPhone 13: J8's longest 21 -> 61 ms, the full
// pass 66 -> 135 ms), and bought nothing measurable (F's CP2: ?compilepar=1, the same send-all-then-wait without it, WebKit
// 4.28 vs 4.36 s): they stay in the warm-up. ?compilelean=defer: left out and sent after the room is shown, for measuring)
const LEAN_DEFER = params.get("compilelean") === "defer";
const LATER_MS = 1000;   // after the room is shown (the hand-off's crossfade done) before the first of them
// (DYS-216 F, CP3) ... and the order the warm-up sends them in: WebKit answers KHR_parallel_shader_compile's completion
// at once, so the real wait is each program's first use, and its GPU process compiles one at a time in send order. CP3
// (cold): the snapshot step's first composite draw waited ~0.7 s behind the room's leaves cut-out and page-turn
// variants (~40k characters each, sent before it, drawn by neither warm step), and the PMREM's two were sent last,
// inside the GPU idle wait. With ?compilelean=1 the first view's first: the full-screen ones, the room's own material,
// the PMREM's two, then the leaves and the page turn; ?compileorder=0: the room scene first, as before
// (Deploy 13d, I: opt-in, so 13d without flags is 13c + enginelite only; CP4: no gain on the Mac)
const COMPILE_ORDER = params.get("compileorder") === "1";
// (DYS-216 F, measurement only: ?warmsync=1) the warm-up waits for the GPU to go idle after each of its steps, so each
// step's own GPU work (cold: the Metal pipelines its first draws build) is booked to it in timings.warmSteps. CP4: the
// order of the sends left the snapshot step's 0.73 s and the idle wait's 0.78 s as they were. Not for visitors
const WARM_SYNC = params.get("warmsync") === "1";
// (DYS-216 F, in ?compilelean=1 on T1; &warmdirect=0: off) the warm-up's hidden frame and warmLight's draw the way a
// phone's shown frames do, straight into the canvas (canvas-direct), not into the display target: Metal builds a
// pipeline per target format, the canvas is BGRA8 and the display RGBA8, so the warm frames built the backdrop's,
// composite's, the halo's, the hull's and points' (and the night glass's) pipelines for a target T1 never shows, and the
// canvas's were built in the hidden frames after start(), before the reveal (CP5 cold: the warm frame 0.75 s). The
// canvas is hidden until the reveal and cleared every frame: nothing seen changes
// (Deploy 13d, I: opt-in, a flag for his iPhone's A/B (?warmdirect=1); CP6: no gain on the Mac)
const WARM_DIRECT = params.get("warmdirect") === "1";
// (DYS-216 F, in ?compilelean=1 on T1) first draws queued while the browser compiles the room's programs (_warmBetween),
// not in the warm-up's steps and setLight after them (CP7 cold: 0.57 s and 0.34 s of Metal pipelines, on the GPU
// process's one thread): ?prewarm=1 the snapshot's composite; ?prewarm=2 the PMREM's too (CP11: Chrome 6x's warmLight
// 105 -> 303 ms with it)
const PRE_WARM = params.get("prewarm");
// (DYS-216 B, F's compile lever 3) the room's programs sent as soon as bake.json names the model, from its pin, and their
// pipelines built while it downloads (gl/room-early.js, fetched only with it on): the warm-up then finds them linked and
// built. The same programs (the same text), so the same pixels; loadRoom's shaderCode (the router's) gives it the books'
// and the notebook's shader code. Not boot-first's ?earlyroom
// (?roomearly=auto, the default (I's defaults rule per engine, 2 Nov, as ?bytesup=auto): on in WebKit alone, by
// loader.js's engine token (every iOS browser, Safari, the iPad's desktop-class Safari), where AB4 measured it -0.68 s at
// Wi-Fi pace with no stall after shown; Blink and Gecko off (a tie, and a stall after shown in Chrome). ?roomearly=1 on
// anywhere, =0 off)
const UA_ = typeof navigator !== "undefined" ? navigator.userAgent : "";
const WEBKIT_ = /AppleWebKit\//.test(UA_) && !(/Chrome\/|Chromium\//.test(UA_) && !/iP(hone|ad|od)/.test(UA_) && !(/Macintosh/.test(UA_) && navigator.maxTouchPoints > 1));
const ROOM_EARLY = ((v) => v === "1" || (v === "auto" && WEBKIT_))(params.get("roomearly") ?? "auto");
const roomEarlyMod = ROOM_EARLY ? import("./room-early.js") : null;
roomEarlyMod?.catch(() => {});
const idle = (f) => (globalThis.requestIdleCallback ? requestIdleCallback(f, { timeout: 500 }) : setTimeout(f, 50));
// (DYS-203 BD-b: the router's boot (loadRoom's buildFirst) goes on once the room is built: the light layers (lamp, screen,
// detail: asked only after the build, ~0.66 MB) download and decode meanwhile, and the material maps go to the GPU
// meanwhile, a task each, as warmUp sent them; warmUp waits for both before its first draw. rs3-0135: the mid phone (4G)
// waited 0.98 s for those layers with the main thread idle, then did the interactions, the compiles and the uploads
// (~0.5 s) one after the other. Nothing drawn differs. ?buildfirst=0: loadRoom resolves after the layers, as before)
// (with v3/boot-first, DYS-203's network side: its early.js asks for these same light layers (and the moment's maps) as
// soon as room3d.json is in, and layerTexture's fetchBitmap takes those bytes, so combined the layers are mostly in by
// the build's end and the 0.98 s wait above shrinks to their decode; what this then still moves off the line is the
// interactions, the compiles and the uploads not waiting on loadRoom's tail. The two do not fetch anything twice: this
// only changes when loadRoom resolves, not who fetches. Its option is buildFirst, not early: boot-first's _loadRoom has
// a const early of its own. ?earlyroom is boot-first's switch, not this one)
const BUILD_FIRST = params.get("buildfirst") !== "0";
// (DYS-203 BD-c: the boot's refine, while the canvas is still hidden under the photograph (the router's bootRefine, up
// to its hand-off), adds a second sample to a frame that came on time and has room for it (_bootSamples), on the desktop
// tiers: 32 samples at one a frame were 0.65-0.73 s of the laptop's hand-off (rs3-0135 desk1440 J1). The samples, their
// order, their jitter and the sum are the ones one a frame adds, so the picture at rest is the same; phones (T1, 12
// samples) keep one a frame. ?refine2=0: one a frame, as before)
const REFINE2 = params.get("refine2") !== "0";
const MIPMAPPED = new Set([THREE.NearestMipmapNearestFilter, THREE.LinearMipmapNearestFilter, THREE.NearestMipmapLinearFilter, THREE.LinearMipmapLinearFilter]);

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
    // (roomdrop-tap: so the room no longer waits for it: half-size stand-ins of the maps stay on the GPU meanwhile,
    // dropRoom, ?roomdropmip; and a tap while zoomed, a double tap's first, starts it: router.js onTap)
    // (DYS-161, the coordinator 31 Oct after RT1: ON by default on phones (T1), at the half-size stand-ins: WebKit SE /
    // 12 mini, a double tap, a pinch back and a glide away all within 50 ms of main with no bare-room frame, 518 -> 408 MB
    // of WebGL held zoomed; the cost, near surfaces a little soft for under half a second after a double tap or a glide
    // away. ?roomdrop=0: off; =1: on (any phone); =all: the light maps too)
    const rd = params.get("roomdrop");
    this.roomDrop = tier === "T1" && rd !== "0" && (rd === null || rd === "1" || rd === "all");
    // (DYS-198 slow-line review, MEDIUM 1 + LOW 5: on by default only where it can't strand the room: dropRoom lets the
    // maps go only when every one kept its file (a restore that needs no network: Safari 17+'s decode path keeps them;
    // iPhone Chrome / Firefox / Edge and older Safari don't, and a lost signal at the restore left the photographs for
    // the visit) and its stand-ins were made (else every way back waited). ?roomdrop=1 / =all: as asked, regardless)
    this.roomDropAsked = rd === "1" || rd === "all";
    this.roomDropAll = rd === "all";
    this.restorePool = Math.min(6, Math.max(1, parseInt(params.get("restorepool"), 10) || RESTORE_POOL));
    // (roomdrop-tap: the drop's stand-in maps, ROOM_STAND_MIP; ?roomdropmip=<0-3>)
    const sm = params.get("roomdropmip");
    this.roomDropMip = sm === null ? ROOM_STAND_MIP : Math.max(0, Math.min(3, parseInt(sm, 10) || 0));
    if (this.roomDrop) phoneMemory.keepFiles = true;   // (before the model loads: loader.js fitWhileLoading keeps them)
    this._drop = null;           // { texs, p, at }: the room's textures let go (the room not drawn) until restoreRoom's p
    this._lightBusy = 0;         // setLight calls running (no drop meanwhile)
    this.roomDrops = { drops: 0, restores: 0, last: null, tex: null, stand: null };
    this.qaRestoreHold = null;   // (QA, roomdrop-tap's check: a promise restoreRoom waits for, so the stand-ins can be seen alone)
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
    // (DYS-149 zoom-norefine: and there, the room's own work waits too: no live frame, no refining sample, no desk mirror
    // or night glass redraw, into a buffer nothing shows then (window-cost 31 Oct, lever 3: up to 12 full room draws hidden
    // behind a first zoom in that starts as the room refines after its landing, a live frame and 11 samples more for a
    // relight while zoomed). What it would have drawn is drawn at its first frame with roomW above 0: live when something
    // changed meanwhile (invalid), else its sum refined on from where it stopped (_frame). Every tier; with ?zoomcaps=0
    // off too (the composite then reads the buffer at roomW 0). ?zoomidle=0: as before)
    this.zoomIdle = zc && params.get("zoomidle") !== "0";
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
    // (DYS-149 S9 canvas-direct: a frame that has no post pass and is neither drawn at the moving scale, nor the outside's
    // moving frame, nor a landing draws its display picture (the outside, the room laid over it, the overlays) straight
    // into the canvas, not into the display target then copied to the canvas: one full-screen pass a frame fewer and, on
    // a tiled GPU, the display target's store (phone-frame-budget 30 Oct, S9). On a phone (no moving scale) every frame;
    // on a desktop the still and refining ones. The same pixels: the canvas is 8 bits a channel as the display target is,
    // and no blend in those stages reads the destination's alpha (the canvas has none; the copy's alpha was never shown).
    // Not in QA (capture "display" reads the display target) nor for a frame not shown (the warm-ups). ?candirect=0: as
    // before. A check may set engine.canDirect at run time; frame.direct says how a frame was drawn)
    this.canDirect = params.get("candirect") !== "0" && !this.qa;
    // (DYS-149 box-only: the halo (outside.js haloPass) and the night glass's overlay (_glassOverlay) drawn on every frame
    // only over the box their pictures can be other than nothing in, not over the whole screen (window-cost 31 Oct, lever
    // 2: ~0.3-0.6 ms each a 30 Hz rest frame on a phone: heat, the clocks the next drag starts on). The same pixels: outside
    // its box the glass discards every fragment, and the halo adds 0 to the colours; it set the display's alpha to 1
    // there, which nothing takes: no blend after it reads the destination's alpha (steam, sheen, the page's ink), the
    // copy and the present take it only to the canvas, which has none (alpha: false), and essay-lift's light read and
    // the snapshot read colours or the room's own buffer. Not in QA (capture "display" reads the display target, its
    // alpha too). ?boxonly=0: both over the whole screen, as before (the halo boxed on a phone's moving frames, mv-lite)
    this.boxOnly = params.get("boxonly") !== "0" && !this.qa;
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
    // (DYS-216) the boot's steps as they start, [ms from the navigation's start, step], for ?hud=1's boot record (which
    // step each long stall on a phone sits in: the performance box's record); a push per step, ~40, none after start()
    this.bootSteps = [];
    this.stepsOn = true;
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
      landing: null, vsync: 16.7, lastTick: 0, delta: 0, moving: false, still: 0, win: { n: 0, late: 0, gpu: [] }, clean: 0, last: null,
      out: false, outAt: -Infinity, outD: null };
    // (DYS-183 mv-outside: the outside's moving scale. While a zoom gesture moves the outside (a pinch, a pan of the
    // zoomed view, the zoomed view's own ease: its camera changed within OUT_HOLD_MS), or the room's camera moves with the
    // room out of the picture, a frame of the outside alone (roomW 0) is drawn at this scale into its own moving display
    // target (_mvOutTarget) and scaled up to the canvas (_frame); at rest it is whole again from the first still frame.
    // Off by default on every tier. ?mvoutside=0.8: on at 0.8 (any 0 < s < 1), on any tier. DYS-183's links
    // (?layers=%2Bmvscale&mvscale=0.8, the room's moving scale on a phone) turn it on too on phones (T1), at the room's
    // moving scale, so one link tries both and Akshay judges one softer-while-moving look; on a desktop, whose room has
    // its moving scale anyway, such a link leaves the outside as it was. ?mvoutside=0 keeps it off with them. "room":
    // the room's scale, read each frame (_mvOutScale); 0: off)
    const mvo = params.get("mvoutside"), mvoq = parseFloat(mvo);
    const plusMv = tier === "T1" && (params.get("layers") || "").split(",").some((s) => s.trim() === "+mvscale");
    this.mvOut = mvo !== null ? (mvoq > 0 && mvoq < 1 ? mvoq : 0) : plusMv ? "room" : 0;
    const tq = this.caps.timerQuery ? this.gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    this.gpuTimer = tq ? { ext: tq, q: null, pend: [] } : null;
    this.gpuTiming = !!this.gpuTimer;    // each drawn frame timed on the GPU: "gputime" events (perf.mjs reads them)

    // refining state (section 6)
    this.state = "moving";
    this.count = 0;              // samples in the room buffer
    this.stillFrames = 0;
    this.invalid = true;
    this.hold = false;
    this.bootRefine = false;     // (DYS-203 BD-c) the router's: the canvas still hidden under the photograph at boot
    this.bootExtra = 0;          // (DYS-203 BD-c) samples added to boot frames; bootStrike: a late frame after one, none more
    this.bootStrike = false;
    this.layersReady = null;     // (DYS-203 BD-b) loadRoom buildFirst: the light layers on their way (warmUp waits for them)
    this._upEarly = null;        // (DYS-203 BD-b) and the material maps' uploads started after the build
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
    // (DYS-149 traffic-resume, ?trafficresume=0 off: in a frame not drawn (covered, out of view) each pass's unseen():
    // the outside's keeps its street traffic with the clock; TL1/EO5: the first frame after an essay closed stepped all
    // the seconds it was open in one task, 34-45 ms on Chrome's mid phone)
    if (params.get("trafficresume") !== "0") this.scheduler.unseen = (t) => { for (const p of this.passes.list) if (p.enabled && p.pass.unseen) p.pass.unseen(t); };
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

  async _loadRoom({ bake, room3d, onProgress, onItems, tex = null, buildFirst = false, shaderCode = null } = {}) {
    this._step("bake.json");
    const t0 = performance.now();
    if (POOL_WARM) warmPool();
    if (!this.shared.uDFG.value) this.shared.uDFG.value = makeDFG();
    this.bakeUrl = new URL(bake, location.href).href;
    // room3d.json (R1's export: spots, ids, lamp defaults, beams) sits next to bake.json; optional
    const r3url = room3d === null ? null : new URL(room3d || "room3d.json", this.bakeUrl).href;
    // (DYS-203: either one the router asked for early, early.js, when it came in whole; else fetched here as before)
    const early = (u) => takeEarly(u).then((b) => (b ? b.text().then((t) => JSON.parse(t)) : null), () => null);
    const [bk, r3] = await Promise.all([
      early(this.bakeUrl).then((j) => j || fetch(this.bakeUrl).then((r) => { if (!r.ok) throw new Error(`${bake}: HTTP ${r.status}`); return r.json(); })),
      r3url ? early(r3url).then((j) => j || fetch(r3url).then((r) => (r.ok ? r.json() : null))).catch(() => null) : null,
    ]);
    this.bake = bk;
    this.room3d = r3;
    if (r3) this._useRoom3d(r3);
    this.timings.bakeJson = Math.round(performance.now() - t0);
    // (the probes' defines: the tier's alone; here, before the build, for roomearly's programs too)
    const probeW = this.settings.tier === "T1" ? 256 : 512;
    this.cubeUV = Probes.defines(probeW);
    if (roomEarlyMod && shaderCode) this._roomEarly = roomEarlyMod.then((m) => m.startRoomEarly(this, bk, shaderCode), () => null);
    this._step("model");
    const t1 = performance.now();
    // the lighter texture copies (light-load: the same pictures as AVIF), when tex names a manifest made for this model;
    // should the model not load with them, it loads once more with its own files
    const modelUrl = within(this.bakeUrl, this.bake.model);
    // (DYS-203, MODEL_PAR: the model's file asked for now, beside the manifest (one request: the router's early one if it
    // asked already); loadModel's fetchBytes takes it, or reads it itself if that failed)
    if (MODEL_PAR) earlyFetch(modelUrl, { progress: true });   // (DYS-216 ?jslean=1: the one early file read in chunks, for its progress)
    // (DYS-203, phone bytes) on a phone whose maps are kept at phoneMemory.maxSize (unless ?phonetex=0): the maps it would halve
    // as it decodes them fetched as their copies at that size (loader.js phoneTextures; room3d/r1t1/t1.json beside the
    // set, scripts/live/phone_tex.py; only there: no parameter names another). Each copy only while its source is the map
    // the site serves (room3d/r1t1-src.json, assemble.py). A small look change, not the same pixels: a lossy AVIF of a
    // 2 x 2 mean in place of the browser's own halving (take-phonetex.sh measures it); ~1 MB less to download before the
    // room shows. On by default since Akshay's yes to (b) (1 Nov; ?phonetex=0: the originals); the manifests read beside light-tex.json's, not after it, and asked for early by the
    // router in place of the originals (gl/early.js phoneCopies: each map downloaded once).
    // ?phonetex=rough: also rough.json's lower-quality roughness maps (phone_tex.py --rough; to be measured on screen)
    const ptv = params.get("phonetex"), ptOn = ptv !== "0" && !!phoneMemory.maxSize;
    const [texMap, phoneMap] = await Promise.all([
      tex ? lightTextures(new URL(tex, location.href).href, modelUrl, this.bake.model_hash) : null,
      ptOn ? phoneTextures(this.bakeUrl, this.bake.model_hash, phoneMemory.maxSize, ptv === "rough") : null,
    ]);
    this.texLight = texMap ? texMap.size : 0;
    this.phoneTex = phoneMap ? phoneMap.size : 0;
    // (a copy that fails is that map's alone: loadModel fetches what it stood in for; should the model still not load,
    // once more with the light textures alone (the review's LOW 5), then with its own files)
    const load = (o) => loadModel(modelUrl, this.renderer, { onProgress, onItems, ...o });
    let model = load({ tex: texMap, phone: phoneMap });
    if (phoneMap) model = model.catch((e) => {
      console.warn("[engine] the model failed with the phone's copies, loading it without them:", e && e.message);
      this.phoneTex = 0;
      return load({ tex: texMap });
    });
    if (texMap) model = model.catch((e) => {
      console.warn("[engine] the light textures failed, loading the originals:", e && e.message);
      this.texLight = 0;
      return load({});
    });
    const [gltf] = await Promise.all([model, this.colour.load()]);
    this.timings.modelAndLut = Math.round(performance.now() - t1);
    this._step("build");
    const t2 = performance.now();
    // (DYS-149: the room's build in pieces of about room.js PIECE_MS, a task each (Room.buildSplit), not the slow laptop's
    // one ~190 ms task behind the still photo; the same room. What follows here in a task of its own, not added to the
    // last piece (anisotropy, the close-up tier, the mirrors, the beams: much of the ~34 ms of that task that was not the
    // build). ?roomsplit=0: all in one task, as before; ?roomsplit=<ms>: that budget)
    const room = new Room(this.renderer, this.shared), split = params.get("roomsplit"), budget = parseFloat(split);
    room.phoneTex = phoneMap;   // (DYS-203: its light maps from the phone's copies too, room.js layerTexture)
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
    this._step("layers");
    const t3 = performance.now();
    const layers = this.bake.layers || {};
    const detail = layers.detail;
    const layersP = Promise.all([
      this._loadLayerSet("lamp", layers.lamp).then((apply) => apply()),
      this._loadLayerSet("screen", layers.screen).then((apply) => apply()),
      detail ? this.room.layerTexture(within(this.bakeUrl, detail.file)).then((t) => {
        this.shared.uDetail.value = t;
        this.shared.uDetailUV2.value = detail.uv === 2 ? 1 : 0;
      }) : null,
    ]).then(() => {
      this.timings.staticLayers = Math.round(performance.now() - t3);
      this._applyTune(params.get("tune"));
    });
    // (DYS-203 BD-b: the router's boot goes on now; the layers come in, and the material maps go up a task each, meanwhile.
    // A layer that fails is met in warmUp (_layersIn), as a load failure)
    if (buildFirst && BUILD_FIRST) {
      this.layersReady = layersP;
      layersP.catch(() => {});
      this._upEarly = this._uploadPending().then((u) => { this.timings.uploadEarly = u; }, () => {});
      return this;
    }
    await layersP;
    return this;
  }

  /** (DYS-203 BD-b) loadRoom buildFirst: its light layers in (a failure is the load's: the fallback, as loadRoom's own). */
  async _layersIn() {
    const p = this.layersReady;
    if (!p) return;
    try {
      await p;
    } catch (e) {
      this._fail("load-failed");
      throw new EngineFallback("load-failed", e && e.message);
    } finally {
      if (this.layersReady === p) this.layersReady = null;
    }
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
    this._step("warmUp");
    const t0 = performance.now();
    this._roomEarly?.then((h) => h?.stop());   // (roomearly on: no question or draw of its own from here; the warm-up asks)
    this._updateCamera();
    let fsMats = [this.colour.composite, this.colour.snapshot, this.colour.copy, this.colour.present, this.probes.decode, this.probes.sum, this.probes.skyMat, ...(this.mirror ? [this.mirror.fill] : []), this.glass.material];
    const lean = COMPILE_LEAN && this.settings.tier === "T1";
    if (lean) {   // (DYS-216 F: what the first view draws now; the rest after it is shown, compileLater)
      const later = new Set(LEAN_DEFER ? [this.colour.copy, this.colour.present, ...(this._glassAt(this._bootMoment) ? [] : [this.glass.material])] : []);
      this._later = fsMats.filter((m) => later.has(m));
      fsMats = fsMats.filter((m) => !later.has(m));
      // the first moment's sunbeams (beams.js: a moment with sun and beams): sent with the rest, not linked at their first
      // draw in warmLight's frame (CP1: 102 + 33 ms waited there). Raw shaders: the same program on the full-screen quad
      const bm = this.bake?.moments?.[this._bootMoment];
      if (this.beams && bm?.sun && bm?.beams) fsMats.push(this.beams.shadowMat, this.beams.openingMat);
    }
    if (COMPILE_PAR && (COMPILE_PAR_T1 || lean || this.settings.tier !== "T1")) {
      // (DYS-203 BD-a: every program asked for now, in the order compileAsync asked (renderer.compile: the shaders
      // compiled and linked as the browser can, nothing waited for); then the maps, a task each, while the browser
      // compiles (the early uploads (loadRoom buildFirst) and the light layers first, so no map is sent twice); then the
      // waits for the programs, all at once (compileAsync on programs already made: no second compile, only the
      // readiness checks). Not the checks between the uploads: each is a GL query the browser answers only once the
      // uploads before it are through, so the main thread would wait out each upload's GPU side)
      // (each full-screen one in a task of its own, a message apart, as the awaits kept them: no longer task)
      this._step("compile");
      if (lean && COMPILE_ORDER) await this._compileFirstViewFirst(fsMats);
      else {
        this.renderer.compile(this.room.scene, this.camera3);
        for (const m of fsMats) {
          await nextMessage();
          this.fs.mesh.material = m;
          this.renderer.compile(this.fs.scene, this.fs.camera);
        }
      }
      this._step("wait early uploads");
      if (this._upEarly) await this._upEarly;
      this._step("wait layers");
      await this._layersIn();
      this._step("uploads");
      this.timings.uploadWarm = await this._uploadPending();   // (DYS-149: the material maps, one per task, before the first draw)
      if (lean) this._warmBetween();
      this._step("wait programs");
      let tc = 0;
      const jobs = [this.renderer.compileAsync(this.room.scene, this.camera3).then(() => { tc = performance.now(); })];
      for (const m of fsMats) {
        this.fs.mesh.material = m;
        jobs.push(this.renderer.compileAsync(this.fs.scene, this.fs.camera));
      }
      await Promise.all(jobs);
      this.timings.compileRoom = Math.round(tc - t0);
      this.timings.compileAll = Math.round(performance.now() - t0);
    } else {
      this._step("compile");
      await this.renderer.compileAsync(this.room.scene, this.camera3);
      // (DYS-151: the sunbeams' air is in the room's own programs now; no second program over the room to compile)
      const tc = performance.now();
      for (const m of fsMats) {
        this.fs.mesh.material = m;
        await this.renderer.compileAsync(this.fs.scene, this.fs.camera);
      }
      this.timings.compileRoom = Math.round(tc - t0);
      this.timings.compileAll = Math.round(performance.now() - t0);
      this._step("wait early uploads");
      if (this._upEarly) await this._upEarly;   // (DYS-203 BD-b: loadRoom buildFirst, ?compilepar=0)
      this._step("wait layers");
      await this._layersIn();
      this._step("uploads");
      this.timings.uploadWarm = await this._uploadPending();   // (DYS-149: the material maps, one per task, before the first draw)
    }
    this._upEarly = null;
    this.timings.warmMaps = Math.round(performance.now() - t0);   // (DYS-203: the programs and the maps in)
    await this._passUploads();   // (DYS-149: the outside's pictures under way, before its first draw below)
    const t1 = performance.now();
    const r = this.renderer;
    // (DYS-149 warm-frame: a pass's own warm-up, pass.warmSteps(ctx) (functions), each in a task of its own just before
    // the hidden frame, so the frame only draws. The outside's: its programs' links checked (and their fixed uniforms
    // set), then its city's first state worked out, which that frame takes: on the barely-sufficient laptop the frame
    // was one 150-222 ms task, the city's first state 76-99 ms of it, outside.js prog.check 4-6 (bt1-1521). A raw
    // pass's GL calls leave three.js's state reset after them, as after its render (_run). ?warmsplit=0: none, as before)
    const passSteps = params.get("warmsplit") === "0" ? [] : this.passes.list.filter((p) => p.enabled && p.pass.warmSteps)
      .flatMap((p) => (p.pass.warmSteps(this.ctxApi) || []).map((fn, i) => Object.assign(() => {
        try { fn(); } catch (e) { console.warn(`[engine] pass ${p.name} warm-up`, e); }
        if (p.raw) r.resetState();
      }, { passName: `${p.name}${i}` })));
    const steps = [
      () => { r.setRenderTarget(this.accum); r.clear(true, true, false); this.room.setMode("live"); this.room.draw(this.camera3); },
      () => { r.setRenderTarget(this.accum); r.clear(false, true, false); this.room.setMode("prepass"); this.room.draw(this.camera3); },
      () => { r.setRenderTarget(this.accum); this.room.setMode("add"); this.room.draw(this.camera3); this.room.setMode("live"); },
      () => { this.count = 1; this._snapshot(); },
      ...passSteps,
      () => {
        this._frameSync = WARM_SYNC ? (this.timings.warmFrameParts = {}) : null;
        try { this._frame(performance.now(), { present: false, warmDirect: this._warmDirect() }); } finally { this._frameSync = null; }
      },
      // perf-r2: the moving frames' targets made (and drawn into once) here, not at the first glide
      () => {
        if (!this.layers.mvscale || this.mv.scale >= 1) return;
        this._mvTargets();
        r.setRenderTarget(this.mv.room); r.clear(true, true, false); this.room.setMode("live"); this.room.draw(this.camera3);
        r.setRenderTarget(this.mv.display); r.clear(true, false, false);
      },
      // (DYS-183 mv-outside: with it on, the outside's moving display target made here too, not at the first zoom gesture)
      ...(this.mvOut ? [() => {
        const s = this._mvOutScale();
        if (s >= 1) return;
        r.setRenderTarget(this._mvOutTarget(s)); r.clear(true, false, false);
      }] : []),
      () => { this.probes.pmrem.compileEquirectangularShader(); },
      () => { this.probes.pmrem.compileCubemapShader(); },
    ];
    // (DYS-216 F: each step's ms and the GPU's idle wait after them, by name: cold, these hold the first draws' Metal
    // pipelines; CP2: warmFrames 1.85 s cold against 0.06 s warm)
    const names = ["live", "prepass", "add", "snapshot", ...passSteps.map((f) => f.passName), "frame", "mv", ...(this.mvOut ? ["mvout"] : []), "pmremEq", "pmremCube"];
    const each = this.timings.warmSteps = {};
    let longest = 0;
    for (let k = 0; k < steps.length; k++) {
      await nextTask();
      this._step(`warm ${names[k] ?? k}`);
      const a = performance.now();
      steps[k]();
      if (WARM_SYNC) await gpuIdle(this.gl);
      const d = performance.now() - a;
      longest = Math.max(longest, d);
      each[names[k] ?? `s${k}`] = Math.round((each[names[k] ?? `s${k}`] || 0) + d);
    }
    this._step("warm gpu idle");
    const ai = performance.now();
    await gpuIdle(this.gl);
    this.timings.warmIdle = Math.round(performance.now() - ai);
    this._step("warm done");
    this.count = 0;
    this.invalidate("warm-up");
    this.timings.warmFrames = Math.round(performance.now() - t1);
    this.timings.warmLongestStep = Math.round(longest);
    this.timings.programs = this.renderer.info.programs.length;
    if (this._roomEarly) {   // (roomearly on: what the room took, then the stand-ins let go)
      const h = await this._roomEarly;
      this._roomEarly = null;
      if (h) { try { this.timings.roomEarly = h.settle(); } catch (e) { this.timings.roomEarly = { error: String(e?.message || e) }; } }   // (never holds 'ready' back)
    }
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
    this._step("warm light");
    const a = performance.now();
    this._frameSync = WARM_SYNC ? (this.timings.warmLightParts = {}) : null;
    try { this._frame(performance.now(), { present: false, warmDirect: this._warmDirect() }); } finally { this._frameSync = null; }
    this._step("warm light gpu idle");
    await gpuIdle(this.gl);
    this._step("warm light done");
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
    this._step("light");
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
        this._step("probes");
        await this.probes.build(prepared, this.layers.lamp ? lamp : 0, this.shared);
        this._step("probes done");
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
        this.glass?.setMoment(this._glassAt(moment));
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
  /** (roomdrop-tap) ... unless their stand-ins are bound in their place (dropRoom): then it can be drawn at any time. */
  get roomStandIn() { return !!this._drop?.stand; }

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
   * (roomdrop-tap: RD3b's double tap reached 1x 0.47 s after it began and the close button's glide began after 0.3 s,
   * but the restore is ~1.2 s of decoding, so the room waited 0.7-0.9 s (the outside alone). Now, before they go, each
   * one's smaller mip levels are copied on the GPU (_standIns: ROOM_STAND_MIP, half size, ~36 MB of the 146) and bound
   * where three.js binds the texture, so the room can be drawn while they come back: the router's fade no longer
   * waits (roomStandIn). The restore's order: the largest on the screen at the room's camera first (_byArea). Where a
   * stand-in can't be made (a compressed or unmipmapped map, a GL error, ?roomdropmip=0), none are, and the room
   * waits for them as before)
   */
  dropRoom() {
    if (!this.roomDrop || this._drop || !this.room || this.failed || this._lightBusy || this._mapsOut || this.fade) return 0;
    const props = this.renderer.properties, texs = [];
    for (const t of this._roomTextures()) {
      const src = t.userData.src;
      if (!src || !(src.map || this.roomDropAll) || phoneMemory.held.has(t) || !props.get(t).__webglTexture) continue;
      texs.push(t);
    }
    if (!texs.length) return 0;
    // (DYS-198 slow-line review: by default, not when a map's restore would need the network (its file not kept))
    if (!this.roomDropAsked && texs.some((t) => !t.userData.src.blob)) { this.roomDrops.skipped = "files not kept"; return 0; }
    // (roomdrop-tap: the stand-ins made while every map is still on the GPU, then the maps let go (three deletes each GL
    // texture and forgets it), then each stand-in bound in its texture's place at its texture's version: three binds it
    // as the texture's own and uploads nothing until restoreRoom's needsUpdate)
    const stand = this._standIns(texs), order = this._byArea(texs);
    // (DYS-198 slow-line review: by default, not without stand-ins: every way back would wait for the restore)
    if (!stand && this.roomDropMip > 0 && !this.roomDropAsked) { this.roomDrops.skipped = "no stand-ins"; return 0; }
    for (const t of order) t.dispose();
    if (stand) for (const t of order) { const q = props.get(t); q.__webglTexture = stand.get(t).tex; q.__version = t.version; }
    this._drop = { texs: order, p: null, at: performance.now(), stand };
    this.roomDrops.drops++;
    this.roomDrops.stand = stand ? { k: this.roomDropMip, n: new Set(stand.values()).size, mb: Math.round([...new Set(stand.values())].reduce((a, s) => a + s.mb, 0) * 10) / 10 } : null;
    this.events.emit("roomdrop", { n: texs.length, stand: !!stand });
    return texs.length;
  }

  /**
   * (roomdrop-tap) Stand-ins for the maps dropRoom lets go: for each GL texture, a smaller one holding its mip levels
   * from roomDropMip down, copied level by level on the GPU (its level attached to a framebuffer, copyTexSubImage2D:
   * nothing decoded, nothing read back), in its internal format, with its sampler's wrap, filters and anisotropy. Where
   * the full texture's LOD is roomDropMip or more (a texel of the full map under half a screen pixel, at 1), a frame
   * drawn with a stand-in is the same; nearer, softer. Returns Map texture -> { tex, n: textures on it, mb }, or null
   * if any one can't be made (not WebGL2, a compressed, data or unmipmapped map, an unknown size, a GL error): then none
   * are, and the room waits for its maps as before. The GL bindings it changes are put back as they were, so three.js's
   * own record of them stays true.
   */
  _standIns(texs) {
    const k = this.roomDropMip, r = this.renderer, props = r.properties;
    if (!k || !r.capabilities?.isWebGL2) return null;
    const plan = [];
    for (const t of texs) {
      const src = props.get(t).__webglTexture, im = t.image;
      // (the picture's size: an iPhone's closed its bitmap after the upload, loader.js closeSource kept it)
      const [w, h] = im?.width ? [im.width, im.height] : t.userData.size || [0, 0];
      const levels = w && h ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 0;   // (three's getMipLevels, as GL truncates it)
      if (!src || levels <= k || t.isCompressedTexture || t.isDataTexture || t.mipmaps?.length || t.internalFormat
        || t.format !== THREE.RGBAFormat || t.type !== THREE.UnsignedByteType || !t.generateMipmaps || !MIPMAPPED.has(t.minFilter)) return null;
      plan.push({ t, src, w, h, levels });
    }
    const gl = r.getContext(), byGL = new Map(), out = new Map();
    const wrap = { [THREE.RepeatWrapping]: gl.REPEAT, [THREE.ClampToEdgeWrapping]: gl.CLAMP_TO_EDGE, [THREE.MirroredRepeatWrapping]: gl.MIRRORED_REPEAT };
    const filter = { [THREE.NearestFilter]: gl.NEAREST, [THREE.LinearFilter]: gl.LINEAR, [THREE.NearestMipmapNearestFilter]: gl.NEAREST_MIPMAP_NEAREST,
      [THREE.LinearMipmapNearestFilter]: gl.LINEAR_MIPMAP_NEAREST, [THREE.NearestMipmapLinearFilter]: gl.NEAREST_MIPMAP_LINEAR, [THREE.LinearMipmapLinearFilter]: gl.LINEAR_MIPMAP_LINEAR };
    const aniso = r.extensions.has("EXT_texture_filter_anisotropic") ? r.extensions.get("EXT_texture_filter_anisotropic") : null;
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++);   // (an older error is not this one's)
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D), prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    for (const { t, src, w, h, levels } of plan) {
      let s = byGL.get(src);
      if (!s) {
        const tex = gl.createTexture(), n = levels - k, fmt = THREE.ColorManagement.getTransfer(t.colorSpace) === THREE.SRGBTransfer ? gl.SRGB8_ALPHA8 : gl.RGBA8;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, n, fmt, Math.max(1, w >> k), Math.max(1, h >> k));
        let mb = 0;
        for (let j = 0; j < n; j++) {
          const lw = Math.max(1, w >> (k + j)), lh = Math.max(1, h >> (k + j));
          gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, k + j);
          gl.copyTexSubImage2D(gl.TEXTURE_2D, j, 0, 0, 0, 0, lw, lh);
          mb += (lw * lh * 4) / 1048576;
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap[t.wrapS] ?? gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap[t.wrapT] ?? gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter[t.magFilter] ?? gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter[t.minFilter]);
        // (three's setTextureParameters: anisotropy only on a linear-mip-linear or nearest-mip-linear, unless magnified nearest)
        if (aniso && t.anisotropy > 1 && t.magFilter !== THREE.NearestFilter && (t.minFilter === THREE.LinearMipmapLinearFilter || t.minFilter === THREE.NearestMipmapLinearFilter)) {
          gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(t.anisotropy, r.capabilities.getMaxAnisotropy()));
        }
        byGL.set(src, (s = { tex, n: 0, mb }));
      }
      s.n++;
      out.set(t, s);
    }
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.deleteFramebuffer(fb);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      for (const s of byGL.values()) gl.deleteTexture(s.tex);
      console.warn(`[engine] the room's stand-in maps were not made (GL error 0x${err.toString(16)}): the room waits for its maps`);
      return null;
    }
    return out;
  }

  /**
   * (roomdrop-tap) The textures in the order restoreRoom makes them again: the most screen first at the room's camera
   * now (zoomed, the pose the zoom out comes back to): for each mesh drawn, its bounding box's extent on the screen
   * (clipped to it; a box with a corner behind the eye, the floor or a wall the camera stands by, counts as the whole
   * screen; one wholly behind, nothing) added to every one of these its materials hold. No occlusion: a rough order,
   * so what a visitor sees most of is sharp first. Ties keep the materials' order.
   */
  _byArea(texs) {
    const area = new Map(texs.map((t) => [t, 0])), cam = this.camera3;
    if (!cam || !this.room?.scene) return texs;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), box = new THREE.Box3(), v = new THREE.Vector4();
    this.room.scene.traverseVisible((o) => {
      if (!o.isMesh || !o.geometry) return;
      const hit = new Set(), add = (x) => { if (area.has(x)) hit.add(x); };
      for (const mt of [].concat(o.material || [])) {
        for (const x of Object.values(mt)) add(x);
        if (mt.uniforms) for (const u of Object.values(mt.uniforms)) { const x = u?.value; if (Array.isArray(x)) x.forEach(add); else add(x); }
      }
      if (!hit.size) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = 0;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1).applyMatrix4(m);
        if (v.w <= 1e-6) { behind++; continue; }
        x0 = Math.min(x0, v.x / v.w); x1 = Math.max(x1, v.x / v.w); y0 = Math.min(y0, v.y / v.w); y1 = Math.max(y1, v.y / v.w);
      }
      const a = behind === 8 ? 0 : behind ? 4 : Math.max(0, Math.min(1, x1) - Math.max(-1, x0)) * Math.max(0, Math.min(1, y1) - Math.max(-1, y0));
      for (const t of hit) area.set(t, area.get(t) + a);
    });
    return texs.map((t, i) => [t, i]).sort((a, b) => area.get(b[0]) - area.get(a[0]) || a[1] - b[1]).map((x) => x[0]);
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
   * (roomdrop-tap: in dropRoom's order, the most screen first; each stand-in deleted once the last texture on it is
   * back on its own, so the two are on the GPU together one picture at a time, not all; the room may be drawn all the
   * while (roomStandIn), and its sum starts again once all are back (the invalidate below))
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
      this._standOff(d, t);
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
      if (this.qaRestoreHold) await this.qaRestoreHold;   // (QA only: the stand-ins alone, for a check's still)
      // (C's merges review 2: a failed round, e.g. the signal lost while zoomed with the files gone from the cache, is
      // tried again rather than ending the room at once)
      try {
        for (let tries = 1; ; tries++) {
          try { await round(); break; }
          catch (e) {
            if (tries >= RESTORE_TRIES) {
              console.warn("[engine] the room's textures did not come back:", e && e.message);
              for (const t of d.texs) this._standOff(d, t, true);
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
      // (roomdrop-tap: with stand-ins, only if a frame was drawn with one; else the sum kept from before the zoom is
      // still the room's (the same pictures again), so the fade in shows it as it would without the drop)
      this.roomDrops.last.drawn = !!d.drawn;
      if (!d.stand || d.drawn) this.invalidate("room back");
      else this.requestFrame();
      this.events.emit("roomback", this.roomDrops.last);
      return true;
    })();
    return d.p;
  }

  /**
   * (roomdrop-tap) Texture t's stand-in let go, once three binds t's own GL texture again (its upload done) and no
   * other texture still out is on it (all: the room ended, every one let go).
   */
  _standOff(d, t, all = false) {
    const s = d.stand?.get(t);
    if (!s) return;
    if (!all && this.renderer.properties.get(t).__webglTexture === s.tex) return;   // (not uploaded: the stand-in stays bound)
    d.stand.delete(t);
    s.n--;
    if ((s.n <= 0 || all) && !s.gone) { s.gone = true; this.renderer.getContext().deleteTexture(s.tex); }
  }

  async prefetchMoment(id) {
    this._bootMoment ??= id;   // (DYS-216 F: the router's first moment, before warmUp: whether the glass is drawn at once)
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

  start() { if (this.failed) return; this._step("start"); this.stepsOn = false; this.scheduler.start(); this.requestFrame(); }
  /** (DYS-216) a boot step's start, for ?hud=1's record (this.bootSteps); nothing after start() */
  _step(name) { if (this.stepsOn && this.bootSteps.length < 200) this.bootSteps.push([Math.round(performance.now()), name]); }

  /**
   * (DYS-216 F, ?compilelean=1 on T1, COMPILE_ORDER) the warm-up's programs sent first view first: the full-screen ones
   * (fsMats: the snapshot's composite, the probes'), the room's own materials, the PMREM's two (setLight's), then the
   * room's leaves cut-out (ALPHA_CUT) and the page turn's, then the room scene as a whole (anything else in it; a program
   * already made is not made again). Raw shaders: a material's program is the same on the full-screen quad as on its
   * own mesh. Only sends: nothing here waits for a compile.
   */
  async _compileFirstViewFirst(fsMats) {
    const fs = this.fs, keep = fs.mesh.material, r = this.renderer;
    const on = (m) => { fs.mesh.material = m; try { r.compile(fs.scene, fs.camera); } finally { fs.mesh.material = keep; } };
    const room = new Set();
    this.room.scene.traverse((o) => { for (const m of [o.material].flat()) if (m && m.isRawShaderMaterial) room.add(m); });
    const lateRoom = (m) => "ALPHA_CUT" in (m.defines || {}) || /pageturn/i.test(m.name || "");
    for (const m of fsMats) { await nextMessage(); on(m); }
    await nextMessage();
    for (const m of room) if (!lateRoom(m)) on(m);
    await nextMessage();
    this.probes.pmrem?.compileEquirectangularShader?.();
    this.probes.pmrem?.compileCubemapShader?.();
    await nextMessage();
    for (const m of room) if (lateRoom(m)) on(m);
    r.compile(this.room.scene, this.camera3);
  }

  /**
   * (DYS-216 F, ?compilelean=1 on T1) first draws queued once the room's programs are sent and its maps up, while the
   * browser compiles the room's (the main thread would only wait for them next): the passes' own (outside.js,
   * ?warmearly=2), then ?prewarm=1 the snapshot's composite (as the warm-up's snapshot step draws it), =2 and the PMREM's
   * (probes.warmPmrem). Cold, Metal builds each program's pipeline at its first draw, on the GPU process's one thread
   */
  _warmBetween() {
    const t = performance.now();
    for (const p of this.passes.list) {
      if (!p.enabled || !p.pass.warmBetween) continue;
      try { p.pass.warmBetween(this.ctxApi); } catch (e) { console.warn(`[engine] pass ${p.name} warmBetween`, e); }
    }
    if (PRE_WARM === "1" || PRE_WARM === "2") {
      this.count = 1;
      this._snapshot();
      this.count = 0;
      if (PRE_WARM === "2") this.probes.warmPmrem?.();
      this.renderer.setRenderTarget(null);
    }
    this.timings.warmBetween = Math.round(performance.now() - t);
  }

  /** (DYS-216 F) the warm frames drawn canvas-direct: ?compilelean=1 on T1 (WARM_DIRECT) */
  _warmDirect() { return COMPILE_LEAN && WARM_DIRECT && this.settings.tier === "T1"; }

  /** whether a moment draws the photographs' glass layer (setLight); no moment known yet: yes (drawn, as before) */
  _glassAt(moment) {
    if (!moment) return true;
    return this.bake?.moments?.[moment]?.glass ?? this.room3d?.glass?.[moment] ?? GLASS_MOMENTS.has(moment);
  }

  /**
   * (DYS-216 F, ?compilelean=1 on T1) the full-screen programs the warm-up left out (warmUp: _later), compiled after
   * the room is shown (router.js reveal), LATER_MS on, one an idle slice: each only sent (renderer.compile asks nothing
   * back, so nothing waits here); its first draw finds it linked. A no-op without them.
   */
  compileLater() {
    const later = this._later;
    this._later = null;
    if (!later?.length || this.failed) return;
    const fs = this.fs;
    let i = 0;
    const next = () => {
      if (this.failed || i >= later.length) return;
      const keep = fs.mesh.material;
      fs.mesh.material = later[i++];
      try { this.renderer.compile(fs.scene, fs.camera); } finally { fs.mesh.material = keep; }
      this.timings.compiledLater = i;
      idle(next);
    };
    setTimeout(() => idle(next), LATER_MS);
  }

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
  /**
   * (DYS-149 essay-cover) A page covers the whole canvas (essay-lift.js: an open essay, edge to edge): no frames are drawn
   * under it, as for a hidden tab; uncovered, the next frame comes at once. EO4's Chrome mid phone traces: the room drew
   * a 6-10 ms frame every 33 ms all the while an essay was open, unseen. ?cover=0: drawn as before
   */
  cover(on) {
    if (params.get("cover") === "0") return;
    this.scheduler.covered = !!on;
    if (!on) this.requestFrame();
  }

  /** Draw frames now, without waiting for the browser (QA, tests): until settled or `max` frames. */
  renderSteps(max = 64) {
    let n = 0;
    do { this._frame(performance.now()); n++; } while (n < max && (this.state !== "settled" || this.fade));
    return n;
  }

  /**
   * (DYS-216 F, the router's late path under ?predraw=1) a first draw of each of `objects` in the room's `mode` (live,
   * prepass, add; "id": their id materials, into the pick target; "use": no draw, below) into a one-pixel target of the
   * room's own format (the accumulation's type, a depth buffer; the pick's RGBA8 + depth). Cold, Metal builds a program's
   * pipeline at its first draw with each new target format / blend / write mask, on the GPU process's one thread (WebKit
   * / ANGLE): drawn here, in a still moment the caller picks, one mode a call, the room's next frame (or the first tap's
   * pick) finds it built instead of building them all in one frame. Nothing shown is drawn into; objects the caller keeps
   * hidden are drawn here all the same
   */
  predrawRoom(objects, mode) {
    const r = this.renderer, room = this.room;
    if (!room || this.failed || !this.accum || !objects?.length) return;
    const t = performance.now(), prevTarget = r.getRenderTarget(), prevMode = room.mode;
    if (mode === "use") {
      // ("use": three.js's first use of each one's room program, its checks: on WebKit they wait here for the compile
      // (its parallel compile reports done at once), in a step with no draw, so the first draw's step has only its pipeline)
      for (const o of objects) r.properties.get(o.userData.roomMaterial || o.material).currentProgram?.getUniforms?.();
      (this.timings.predraw ||= []).push([mode, Math.round(performance.now() - t)]);
      return;
    }
    const shown = objects.map((o) => o.visible);
    for (const o of objects) o.visible = true;
    const rt = mode === "id" ? this.pickRT || (this.pickRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, type: THREE.UnsignedByteType }))
      : this._predrawRT || (this._predrawRT = new THREE.WebGLRenderTarget(1, 1, { type: this.accum.texture.type, format: THREE.RGBAFormat,
        depthBuffer: true, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false }));
    r.setRenderTarget(rt);
    room.setMode(mode === "id" ? "live" : mode);
    if (mode === "id") for (const o of objects) if (o.userData.idMaterial) o.material = o.userData.idMaterial;
    try { for (const o of objects) r.render(o, this.camera3); }
    finally {
      if (mode === "id") for (const o of objects) if (o.userData.roomMaterial) o.material = o.userData.roomMaterial;
      objects.forEach((o, k) => { o.visible = shown[k]; });
      room.setMode(prevMode || "live");
      r.setRenderTarget(prevTarget);
    }
    (this.timings.predraw ||= []).push([mode, Math.round(performance.now() - t)]);
  }

  /**
   * (DYS-216 F, ?predraw=1) the pass `name`'s own render, once, in the next still frame drawn (no camera or outside move,
   * no moving-scale frame or landing: _frame keeps it queued till then), into that frame's picture target (the canvas
   * itself on a direct frame) just before the picture is cleared: its first draws build the pipelines its first real
   * frame (the sheen's first hover or glint, the page turn's ink) would, and the clear covers them. The pass sees
   * frame.predraw (sheen.js: its own draw only, no id target made for it). Resolves true once drawn, false with no such
   * pass or a failed engine (C's helper: the router lets the pass's owner in then)
   */
  predrawPass(name) {
    if (this.failed) return Promise.resolve(false);
    return new Promise((done) => {
      (this._predraws ||= []).push({ name, done });
      this.requestFrame();
    });
  }

  _runPredraws(frame, T) {
    const list = this._predraws;
    this._predraws = null;
    const f = { ...frame, predraw: true };
    for (const { name, done } of list) {
      const p = this.failed ? null : this.passes.list.find((x) => x.name === name && x.enabled);
      if (!p) { done(false); continue; }
      const t = performance.now();
      this.renderer.setRenderTarget(T);
      this._run(p, f);
      (this.timings.predraw ||= []).push([name, Math.round(performance.now() - t)]);
      done(true);
    }
  }

  async pick(cssX, cssY) {
    // (DYS-161 memory: its textures out, the room is not there to pick; roomdrop-tap: unless drawn from their stand-ins)
    if (!this.room || (this._drop && !this._drop.stand)) return null;
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
    this._roomEarly?.then((h) => h?.settle());
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
    this.mv.outD?.dispose();   // (DYS-183 mv-outside)
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
    // (DYS-149 zoom-norefine: at full zoom (the last frame's roomW 0) a redraw the room waits on (invalid, kept by _frame)
    // is no reason for a frame: it is drawn at the first frame the room shows again, which the zoom out's own frames bring
    // (the router's fade asks for each))
    const idle = this.zoomIdle && this.roomW <= 0 && !this._drop;
    // (review since 89e71ad6, 3: the outside's camera moved lately: one more frame after its hold ends, drawn whole, so a
    // pinch that ends with nothing loading doesn't leave the last moving (mv-lite) frame on screen under reduced motion)
    // (DYS-183 mv-outside: and while the last frame was the outside's moving frame, so the frame after its hold, drawn
    // whole, always comes, on any tier the switch is on: the room is settled through a zoom gesture)
    const busy = camChanged || (this.invalid && !idle) || this.state !== "settled" || !!this.fade || this.needsFrame || !!this.hiTier?.busy || !!m.landing
      || this.outsideMoving || m.out;
    const f = this.lastFrame;
    const animating = f ? this.passes.any((p) => p.pass.animating && p.pass.animating(f)) : false;
    if (!busy && !animating) return;
    if (!busy) {
      const minGap = (this.scheduler.idleMinutes() > 10 ? 1000 / 15 : 1000 / 30) - 4;
      if (t - this.lastDraw < minGap) return;
    }
    this._frame(t);
  }

  /**
   * (DYS-203 BD-c) Samples a refining frame may add after its own: one while the router's boot keeps the canvas hidden
   * under the photograph (bootRefine), on a desktop tier, outside QA and a light's fade, with no room-stage pass (each
   * sample would run it), when the frame came on time (its interval within 1.25 refresh intervals) and its main thread,
   * one more sample's cost (`cost`, the one just drawn) included, stays within 3/4 of an interval from the frame's
   * start; else none. The page around the hidden canvas still moves on the main thread then (the first visit's bar, the
   * photograph's parallax easing to rest, the streets' catch-up in the frame's spare time): a frame that comes late once
   * a sample was added ends the added samples for this boot (bootStrike), so no run of late frames.
   */
  _bootSamples(t, target, cost) {
    if (!REFINE2 || !this.bootRefine || this.bootStrike || this.settings.tier === "T1" || this.qa || this.fade || this.count >= target) return 0;
    if (this.passes.stage("room").length) return 0;
    const m = this.mv;
    if (!(m.delta > 0)) return 0;
    if (m.delta > 1.25 * m.vsync) { if (this.bootExtra) this.bootStrike = true; return 0; }
    return performance.now() - t + cost < 0.75 * m.vsync ? 1 : 0;
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

  _frame(t, { present = true, warmDirect = false } = {}) {
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
    // (DYS-183 mv-outside: read for the outside's moving scale too, on any tier it is on)
    const outCh = this.zoomCaps || this.mvOut ? this._outChanged() : false;
    if (this.zoomCaps) {
      if (outCh) this._outMovedAt = t;
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
    // (DYS-183 mv-outside: a frame of the outside alone (the room wholly out, roomW 0) while it moves: the outside's camera
    // changed within OUT_HOLD_MS, as frame.outsideMoving's caps (so a pinch's frames between its fingers' moves never get
    // a whole frame mid-way), or the room's camera moved with the room out (a glide while zoomed). It is drawn at the
    // outside's moving scale into its own moving display target and scaled up to the canvas; the frame after the hold is
    // drawn whole, as every frame of the outside is drawn anew (no landing crossfade: the outside is alive, and one from
    // the last moving frame would hold its cars and water still for a beat). The room's buffer stays its own (R): at
    // roomW 0 nothing reads it but the outside's cover test, which roomW < 1 turns off, and the room's composite, skipped
    // there (zoomSkip; else drawn x 0). While the room fades (0 < roomW < 1) frames stay whole as before: the composite
    // and the cover test read the room's buffer pixel for pixel, so a smaller frame would need the room drawn smaller too,
    // a room draw that a still room otherwise doesn't have)
    let outNow = false;
    if (this.mvOut) {
      if (outCh || (camChanged && this.roomW < 1)) this.mv.outAt = t;
      const s = this._mvOutScale();
      outNow = !mvNow && s < 1 && this.roomW <= 0 && t - this.mv.outAt < OUT_HOLD_MS && !this.qa && !this.passes.stage("post").length;
      if (outNow) { this._mvOutTarget(s); this.mv.landing = null; }
    }
    this.mv.out = outNow;
    const R = mvNow ? this.mv.room : this.accum, D = mvNow ? this.mv.display : outNow ? this.mv.outD : this.display;
    // (DYS-149 S9 canvas-direct: this frame's display picture drawn into the canvas itself (T null), or into D as before;
    // the landing is final here (set above, ended only by the present below), so the present's choice is this one)
    const direct = (present || warmDirect) && this.canDirect && !mvNow && !outNow && !this.mv.landing && !this.passes.stage("post").length;
    const T = direct ? null : D;
    // (DYS-216 F, ?warmsync=1 only: a warm frame's parts, each with the GPU work it queued (a getError round trip waits for
    // the GPU process's queue): timings.warmFrameParts / warmLightParts)
    const sync = this._frameSync;
    let ts = sync ? performance.now() : 0;
    const part = sync ? (name) => { this.gl.getError(); const n = performance.now(); sync[name] = Math.round((sync[name] || 0) + n - ts); ts = n; } : null;
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
    // (roomdrop-tap: drawn as ever from their stand-ins once the room shows again (roomW above 0), as the fade in begins)
    if (this._drop && !(this._drop.stand && this.roomW > 0)) { if (camChanged) this.invalid = true; this.state = camChanged ? "moving" : "settled"; }
    // (DYS-149 zoom-norefine: at full zoom (roomW 0 this frame: the router's fade ran in the updates above) the room is not
    // drawn: nothing shows its buffer then (the composite and the glass's overlay skip it, the outside's cover test is off
    // below roomW 1), so neither are the desk mirror and the glass, which come with its live frame and its samples. A
    // camera change meanwhile is kept as invalid, as an invalidate (a relight, a resize, a close-up texture) keeps itself;
    // an unfinished sum keeps its count and its next sample. Its state is the one the _drop path above gives (the zoom's
    // and the outside's uploads read it): "moving" on a frame its camera moved, else "settled", never "refining" while it
    // waits, and no "refined" until it has. The fade in's first frame (roomW above 0) is then a live frame when invalid
    // (or the sum is empty), else the sum's next sample at once (it has been still all along), and it refines on from
    // there as after any landing. ?zoomidle=0: drawn as before)
    else if (this.zoomIdle && this.roomW <= 0) {
      if (camChanged) this.invalid = true;
      this.state = camChanged ? "moving" : "settled";
      if (this.stillFrames < 1) this.stillFrames = 1;
    }
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
    // (roomdrop-tap: a frame of the room drawn with a stand-in bound: its sum is made again once the maps are back)
    if (action !== "none" && this._drop?.stand) this._drop.drawn = true;
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
    // (DYS-149 S9 canvas-direct: drawn into the canvas, the display target is not this frame's picture: no texture of it)
    frame.direct = direct;
    if (direct) frame.textures.display = null;

    this._stage("prepare", frame, null);
    part?.("prepare");

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
        const s0 = performance.now();   // (DYS-203 BD-c: what a sample costs this frame's main thread)
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
        // (DYS-203 BD-c: the boot's hidden refine, the next sample in this frame as the next frame would draw it: its
        // jitter and lens point, the air's uniforms as a frame starts them (prepare(0, false)), the room's two draws, the
        // air, the glass; never past the target)
        for (let n = this._bootSamples(t, target, performance.now() - s0); n > 0 && this.count < target; n--) {
          const k = ++this.sampleK;
          this._applyJitter(jitter(k), lensOn ? lensSample(k) : null);
          if (air) this.beams.prepare(0, false);
          r.setRenderTarget(R);
          r.clear(false, true, false);
          this.room.setMode("prepass");
          this.room.draw(this.camera3);
          this.room.setMode("add");
          if (air) this.beams.prepare(this.count);
          this.room.draw(this.camera3);
          if (air) { this.beams.done(); this.beams.drawOpening(this.accum, this.camera3); }
          if (this.glass?.on && this.layers.glass) this.glass.sample(this.room, this.sampleK, this.lensOffset, this.cam.focus?.distance);
          this.count++;
          this.bootExtra++;
        }
      }
      frame.room.sample = this.count - 1;
      frame.room.count = this.count;
      this._stage("room", frame, R);
      part?.("room");
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
    // (DYS-149 S9 canvas-direct: into T, the canvas itself on a direct frame, else D)
    // (?predraw=1: on a still frame only; a moving one keeps them queued for the next)
    if (this._predraws && present) {
      if (!camChanged && !mvNow && !this.mv.landing && !outCh) this._runPredraws(frame, T);
      else this.requestFrame();
    }
    r.setRenderTarget(T);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    const rect = frame.window.rect;
    if (rect[2] > 0 && rect[3] > 0 && this.passes.stage("outside").length) {
      this._stage("outside", frame, T, rect);
    }
    part?.("outside");
    const u = this.colour.uniforms;
    u.uAccum.value = R.texture;
    u.uCount.value = this.count;
    u.uMode.value = 0;
    u.uFrozen.value = this.frozen.texture;
    u.uFrozenW.value = this.fade ? this._fadeWeight(t) : this.hold ? 1 : 0;
    frame.light.fade = u.uFrozenW.value;
    r.setRenderTarget(T);
    // (v3/zoom-r3: the room laid over the outside as much as it is in the picture; the snapshot keeps the whole room)
    // (DYS-149: not drawn at full zoom (roomW 0; it is 0 exactly there, 1 - ease(1)): it writes room x 0 = (0, 0, 0, 0)
    // through ONE, ONE_MINUS_SRC_ALPHA, no depth, so D stays as the outside drew it, bit for bit. Any roomW above 0
    // (the fade's frames) draws as before. ?zoomcaps=0: drawn)
    if (!(this.zoomSkip && this.roomW <= 0)) {
      u.uRoomW.value = this.roomW;
      this.fs.draw(r, this.colour.composite);
      u.uRoomW.value = 1;
    }
    part?.("composite");
    if (this.glass && this.layers.glass) this._glassOverlay(R, frame, T);
    part?.("glass");
    this._stage("overlay", frame, T);
    part?.("overlay");

    // ---- post chain to the canvas
    // (DYS-149 S9 canvas-direct: a direct frame is on the canvas already: no copy)
    if (present && !direct) {
      const post = this.passes.stage("post");
      if (!post.length && (mvNow || outNow || this.mv.landing)) {
        // a moving frame scaled up to the canvas, or a landing: the full frame crossfaded in from the last moving one
        let w = 1;
        if (!mvNow && !outNow) {
          const x = Math.min(1, Math.max(0, (t - this.mv.landing.start) / MV_LANDING_MS));
          w = 1 - x * x * (3 - 2 * x);
          if (x >= 1) this.mv.landing = null;
        }
        const pu = this.colour.presentUniforms, fxaa = pu.uFxaa.value;
        pu.uSrc.value = this.display.texture;
        pu.uPrev.value = (outNow ? this.mv.outD : this.mv.display).texture;
        pu.uPrevW.value = w;
        // (DYS-183 mv-outside: the outside's moving frame scaled up without FXAA: its pictures are filtered already (the
        // room's hard edges are what FXAA is for), FXAA would smear the city's lights, and it is one tap a pixel, not 9)
        if (outNow) pu.uFxaa.value = 0;
        r.setRenderTarget(null);
        this.fs.draw(r, this.colour.present);
        pu.uFxaa.value = fxaa;
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
    // (DYS-183 mv-outside: the outside's moving frames timed at their own scale, and marked: the room's scale doesn't learn
    // from them)
    this._gpuEnd(t, camChanged, mvNow ? this.mv.scale : outNow ? this._mvOutScale() : 1, outNow, direct);
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
    // (DYS-183 mv-outside: the outside's moving frame's too, its own display target's; the room's buffer is its own then)
    const mv = this.mv.active ? this.mv : null, mo = this.mv.out ? this.mv.outD : null;
    const W = mv ? mv.room.width : mo ? mo.width : this.width, H = mv ? mv.room.height : mo ? mo.height : this.height;
    const accum = mv ? mv.room : this.accum, display = mv ? mv.display : mo || this.display;
    f.index = this.frameIndex; f.time = t; f.dt = dt;
    f.width = W; f.height = H; f.dpr = mv || mo ? (this.dpr * W) / this.width : this.dpr; f.cssWidth = this.cssWidth; f.cssHeight = this.cssHeight;
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

  /** (DYS-183 mv-outside) The outside's moving scale now: ?mvoutside's, or with DYS-183's links the room's; 1: none. */
  _mvOutScale() {
    const s = this.mvOut;
    return s === "room" ? (this.layers.mvscale ? this.mv.scale : 1) : s > 0 && s < 1 ? s : 1;
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

  /**
   * (DYS-183 mv-outside) The outside's moving display target at scale s (made, or resized, only when that changes): its
   * own, so the room's moving targets (a half-float room with depth) are never resized for a gesture at another scale,
   * and the room's last moving frame stays for its landing. Linear filtering: the canvas reads it scaled up.
   */
  _mvOutTarget(s) {
    const m = this.mv, w = Math.max(16, Math.round(this.width * s)), h = Math.max(16, Math.round(this.height * s));
    if (!m.outD) {
      m.outD = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, colorSpace: THREE.NoColorSpace });
      m.outD.texture.name = "display-outside-moving";
    } else if (m.outD.width !== w || m.outD.height !== h) m.outD.setSize(w, h);
    return m.outD;
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

  /**
   * The moving scale now: { scale, pinned, on, vsyncMs, last: the last glide's { frames, late, gpuMs, from, to },
   * outside: (DYS-183 mv-outside) the outside's { scale, active: the last frame was its moving frame } with its switch on
   * (and a scale under 1), else null }.
   */
  get movingScale() {
    const m = this.mv;
    return { scale: m.scale, pinned: m.pinned, on: !!this.layers.mvscale && m.scale < 1, vsyncMs: +m.vsync.toFixed(2), last: m.last,
      outside: this.mvOut && this._mvOutScale() < 1 ? { scale: this._mvOutScale(), active: m.out } : null };
  }

  // ---- perf-r2: each drawn frame timed on the GPU ("gputime" events; the moving scale learns from the moving ones)
  _gpuBegin() {
    const g = this.gpuTimer;
    if (!g || g.q || g.pend.length > 8) return;
    try { g.q = this.gl.createQuery(); this.gl.beginQuery(g.ext.TIME_ELAPSED_EXT, g.q); } catch (e) { g.q = null; }
  }

  _gpuEnd(t, moving, scale, out = false, direct = false) {
    const g = this.gpuTimer;
    if (!g) return;
    const gl = this.gl;
    if (g.q) { gl.endQuery(g.ext.TIME_ELAPSED_EXT); g.pend.push({ q: g.q, t, moving, scale, out, direct }); g.q = null; }
    while (g.pend.length && gl.getQueryParameter(g.pend[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const p = g.pend.shift();
      const ms = gl.getParameter(g.ext.GPU_DISJOINT_EXT) ? null : gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(p.q);
      if (ms === null) continue;
      if (p.moving && !p.out) this._mvLearn(ms, p.scale);
      const ev = { time: p.t, ms, moving: p.moving, scale: p.scale };
      if (p.out) ev.outside = true;   // (DYS-183 mv-outside: the outside's moving frame, at its scale)
      if (p.direct) ev.direct = true;   // (DYS-149 S9 canvas-direct: drawn straight into the canvas)
      this.events.emit("gputime", ev);
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
      roomW: this.roomW, outside: null, outsideMoving: this.outsideMoving, direct: false,
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
      // (DYS-149 S9 canvas-direct: the canvas (target null) the same scissor, in its own pixels, on three.js's state: the
      // renderer's own scissor is in CSS pixels; its setRenderTarget(null) after puts the canvas's back, none)
      if (!target && scissor) {
        const st = this.renderer.state, v = this._canScissor || (this._canScissor = new THREE.Vector4());
        st.scissor(v.set(scissor[0], scissor[1], scissor[2], scissor[3]));
        st.setScissorTest(true);
      }
      this._run(p, frame);
      if (target && scissor) { target.scissorTest = false; this.renderer.setRenderTarget(target); }
      else if (scissor) this.renderer.setRenderTarget(null);
    }
  }

  // (DYS-149 box-only) the night glass screen-blended into T (the display target, or the canvas itself: null), with the
  // scissor of the box outside which it discards every fragment (glass.box) as _stage sets one: a render target's own
  // (target px), the canvas's on three.js's state; none at all when that box is empty. ?boxonly=0: the whole screen
  _glassOverlay(R, frame, T) {
    const g = this.glass, b = this.boxOnly ? g.box(frame.width, frame.height) : null;
    if (b && (b[2] <= 0 || b[3] <= 0)) return;
    if (b && T) { T.scissor.set(b[0], b[1], b[2], b[3]); T.scissorTest = true; this.renderer.setRenderTarget(T); }
    else if (b) {
      const st = this.renderer.state, v = this._canScissor || (this._canScissor = new THREE.Vector4());
      st.scissor(v.set(b[0], b[1], b[2], b[3]));
      st.setScissorTest(true);
    }
    g.overlay(R, this.count, frame.width, frame.height, this.roomW);
    if (b) { if (T) T.scissorTest = false; this.renderer.setRenderTarget(T); }
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
      this.mv.out = false;   // (DYS-183 mv-outside)
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

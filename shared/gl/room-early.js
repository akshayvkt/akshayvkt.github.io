// (DYS-216 B, F's compile lever 3; on in WebKit by default (?roomearly=auto), ?roomearly=1 anywhere, =0 off; not boot-first's
// ?earlyroom; engine.js imports this
// module only with it on) The room's programs sent at page start, and their pipelines built while the model downloads. Cold (a phone's first visit after a deploy: no Metal
// cache for our shaders), WebKit links a program on a worker thread, then builds a Metal pipeline at its first draw with
// each new target format / blend / write mask / vertex layout, synchronously on the GPU process's one thread (F's WebKit
// findings, scratch/F/compile). Without this, the room's programs are sent in the warm-up, after the model, the build,
// the interactions and the notebook, and their three pipelines (live, prepass, add) built at the warm-up's first draws
// (AB2's ship1, cold, WebKit: 'wait programs' 0.38-0.66 s, 'warm live' 0.28-0.32 s, the prepass's and the add's in the
// warm-up's GPU wait).
//
// Here, as soon as bake.json names the model: two stand-in materials made as the room makes its own (material.js
// roomMaterial, then the books' and the notebook's shader code by the same functions, interact.js bookShaderText and
// notebook.js notebookShaderText), named as the room's first plain and first cut-out material: three.js writes the name of
// the material that makes a program into its text (#define SHADER_NAME), so with the same name it is the same text, the
// warm-up's materials take these very programs (three's program cache), and a returning visitor's GPU cache holds them
// with or without this. Their programs are sent (compiled and linked as the browser can; nothing asked back). Once all
// have linked, three's first-use questions (the uniforms' and attributes' locations) are asked of them back to back, then
// each is drawn once in each of the room's three render states (room.js modeState) into a private 1 x 1 target of the
// room target's formats, over a stand-in triangle with the model's vertex layout: the GPU thread builds those pipelines
// while the page still loads. Nothing waits for the draws (a draw asks nothing back), and no question follows them (F's
// 5eaef202: a question after a draw waits behind the pipeline it queued). Nothing on screen changes: the target is
// private and the programs are the room's own. The warm-up's start stops whatever is still to come (engine.js warmUp).
//
// What a model's programs depend on is pinned below per model (bake.json's model_hash); a model without a pin is skipped
// (the room compiles as before). scripts/live/room_early_test.mjs checks the pins against the model's file and the
// stand-ins' text against the room's materials'; after the warm-up, timings.roomEarly says whether the room's materials
// took these programs (took) and whether every room mesh has the pinned layout (layout).
import * as THREE from "three";
import { atlasUniforms, roomMaterial, SHADER_MERGE, sharedUniforms } from "./material.js";
import { modeState } from "./room.js";
import { Targets } from "./context.js";

// model_hash -> plain / cut: the names of the first plain and the first cut-out room material in the scene's order (the
// glTF scene's nodes, depth first; cut-out: MASK or BLEND with a base colour map, material.js alphaCut; "room:" + the
// glTF material's name, room.js); chart: the notebook cover's light-map chart is found (notebook.js), so its shader code
// joins the room's at home; layout: the meshes' vertex layout (LAYOUTS)
export const ROOM_PINS = {
  // (DYS-216 F, #4: with the shader bundle the leaves draw with the opaque program: no cut-out stand-in)
  a38ca2f07fbd5d79: { plain: "room:sfw_print", cut: SHADER_MERGE ? null : "room:sfw_leaves", chart: true, layout: "q16" },   // room3d/r1 room.glb (Deploy 13)
};

// name -> [array type, item size, normalized, interleaved stride in elements (0: its own buffer)], as three's GLTFLoader
// makes them from the model's accessors (KHR_mesh_quantization; an accessor whose byteStride is not its element's size is
// interleaved)
export const LAYOUTS = {
  q16: {
    position: [Uint16Array, 3, false, 4], normal: [Int8Array, 3, true, 4], color: [Uint8Array, 4, true, 0],
    uv: [Float32Array, 2, false, 0], uv1: [Float32Array, 2, false, 0], uv2: [Float32Array, 2, false, 0],
  },
};

const POLL_MS = 50;
const GIVE_UP_MS = 15000;
const MODES = ["live", "prepass", "add"];

/** A geometry's vertex layout as three binds it (attribute, array type, size, normalized, interleaved stride + offset). */
export function layoutKey(g) {
  return Object.keys(g.attributes).sort().map((k) => {
    const a = g.attributes[k], arr = a.isInterleavedBufferAttribute ? a.data.array : a.array;
    return `${k}:${arr.constructor.name}x${a.itemSize}${a.normalized ? "n" : ""}${a.isInterleavedBufferAttribute ? `/${a.data.stride}+${a.offset}` : ""}`;
  }).join(" ");
}

/** One triangle with this layout (its values never seen: it is drawn into the private target only). */
export function standInGeometry(spec) {
  const g = new THREE.BufferGeometry();
  for (const [k, [T, n, norm, stride]] of Object.entries(spec)) {
    g.setAttribute(k, stride ? new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new T(3 * stride), stride), n, 0, norm)
      : new THREE.BufferAttribute(new T(3 * n), n, norm));
  }
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return g;
}

/**
 * The stand-in materials: the room's own (roomMaterial), its shader code added as the room's is (code.book: interact.js
 * bookShaderText; code.notebook: notebook.js notebookShaderText, at home, when the model's pin has the chart), named as
 * the pin says. Their uniforms are their own (nothing of the engine's is read or uploaded).
 */
export function standInMaterials(pin, cubeUV, code) {
  const make = (name, cut) => {
    const src = cut ? { map: new THREE.Texture(), alphaTest: 0.5 } : {};
    const m = roomMaterial(src, sharedUniforms(), atlasUniforms(), { lightmapped: true, cubeUV });
    m.name = name;
    if (cut) m.userData.cutMap = src.map;
    if (code.book) code.book(m, true);
    if (code.notebook && pin.chart) code.notebook(m);
    return m;
  };
  return [make(pin.plain, false), ...(pin.cut ? [make(pin.cut, true)] : [])];
}

/**
 * Start at bake.json (engine.js _loadRoom). `code(bake)` (the router's) resolves the shader code's functions once their
 * modules are in: { book, notebook } (notebook null away from home). Returns { stats, stop(), settle() }: stop() at the
 * warm-up's start; settle() after it (what the room took, then the stand-ins let go), its stats for timings.roomEarly.
 */
export function startRoomEarly(engine, bake, code) {
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
  const st = { model: bake?.model_hash || null };
  let stopped = false, mats = [], geo = null, targets = null, progs = [];
  const h = {
    stats: st,
    programs: () => progs.slice(),
    stop() { if (!stopped) { stopped = true; if (!st.drawn) st.stoppedAt = ms(); } },
    settle() {
      h.stop();
      const r = engine.renderer;
      if (progs.length && engine.room) {
        const took = progs.map(() => 0);
        for (const m of engine.room.materials) {
          const i = progs.indexOf(r.properties.get(m).currentProgram);
          if (i >= 0) took[i]++;
        }
        st.took = took;   // per stand-in program (plain, cut): how many room materials draw with it (0: the text differed)
        // (of the meshes drawn with these programs, how many have the pinned layout: the page turn's sheets have their own)
        const key = geo ? layoutKey(geo) : "", mine = (engine.room.meshes || []).filter((o) => progs.includes(r.properties.get(o.material).currentProgram));
        st.layout = `${mine.filter((o) => layoutKey(o.geometry) === key).length}/${mine.length}`;
      }
      for (const m of mats) { m.dispose(); m.userData.cutMap?.dispose(); }
      geo?.dispose();
      targets?.dispose();
      mats = []; geo = null; targets = null; progs = [];
      return st;
    },
  };
  const pin = ROOM_PINS[st.model];
  if (!pin || !LAYOUTS[pin.layout]) { st.skip = "no pin"; return h; }
  (async () => {
    const fns = await code(bake);
    if (stopped) { st.skip = "late"; return; }
    const r = engine.renderer;
    mats = standInMaterials(pin, engine.cubeUV, fns || {});
    geo = standInGeometry(LAYOUTS[pin.layout]);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
    for (const m of mats) { const o = new THREE.Mesh(geo, m); o.frustumCulled = false; scene.add(o); }
    r.compile(scene, cam);   // (sent: compiled and linked as the browser can, nothing asked back)
    progs = mats.map((m) => r.properties.get(m).currentProgram).filter(Boolean);
    st.sent = ms();
    st.programs = progs.length;
    if (progs.length !== mats.length) { st.skip = "not sent"; return; }
    // without KHR_parallel_shader_compile a first question waits for the link itself: sent only
    if (!engine.caps?.parallelCompile) { st.skip = "no parallel compile (sent only)"; return; }
    // every link first (COMPLETION_STATUS: no wait for a link under way), then the questions, then the draws
    while (!stopped && !progs.every((p) => p.isReady())) {
      if (ms() > GIVE_UP_MS) { st.skip = "links slow"; return; }
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    if (stopped) return;
    st.linked = ms();
    for (const p of progs) { p.getUniforms(); p.getAttributes(); }
    if (progs.some((p) => p.diagnostics && p.diagnostics.runnable === false)) { st.skip = "shader error"; return; }
    // the room's build asks the GPU process one question of its own (hitex.js applyAnisotropy: three's getMaxAnisotropy, a
    // getParameter, kept by three after it is first asked): asked here, before the draws, it never waits behind the
    // pipelines they queue (re-diag1, Chrome CPU 6x: 812 ms in the build; WebKit: 0.23-0.32 s in RE-AB1)
    r.capabilities?.getMaxAnisotropy?.();
    st.asked = ms();
    targets = new Targets();
    const target = targets.get("room", { type: engine.accum?.texture.type ?? THREE.HalfFloatType, depth: true, filter: THREE.NearestFilter });
    const prev = r.getRenderTarget();
    r.setRenderTarget(target);
    r.clear(true, true, false);
    for (const mode of MODES) {
      for (const m of mats) modeState(m, mode);
      r.render(scene, cam);
    }
    // (three's own record of the GL state left as after any pass of ours that went round it: the outside's init, which
    // can run before the warm-up, binds on the unit these draws left active; commands only, no question)
    r.resetState();
    r.setRenderTarget(prev);
    st.drawn = ms();
  })().catch((e) => { st.error = String(e?.message || e); });
  return h;
}

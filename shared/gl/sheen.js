// Light that answers the visitor (docs/v3/EXPERIENCE-SPEC.md, the craft rules: "objects answer the pointer with a
// subtle highlight and a slight lift of exposure, never an outline"), and the first visit's glint (a single soft band of
// light crossing the desk, like a reflection).
//
// An overlay pass over the engine's display picture. The room's ID pass (drawn at half size, again only when the camera
// has moved while an effect is on) says which pixels belong to which object; those pixels are lifted by multiplying
// them (blend: display x (1 + gain)), so the room's refining (anti-aliasing, depth of field) never restarts.
//
//   const sheen = createSheen(engine);
//   sheen.hover(["laptop", "screen"], k)     // the lift eases in on these objects over 150 ms, the last ones out; null: none
//                                            // (k: a strength, 1 by default; the window's whole view takes less)
//   await sheen.glint(["laptop", "print"])   // one band of light across these objects, in screen order, in 1.2 s
//   sheen.onFrame((st) => {})                // every frame an effect is on (a DOM face over the canvas follows it)
//   sheen.state                              // what is lit now (QA)
//
// Names are the engine's objects (engine.ids), plus "books" (every spine) and "opening" (the window opening: no room
// surface there, the view outside).

const HOVER_MS = 150;
const HOVER_GAIN = 0.16;      // the lift at full hover: about a quarter of a stop, highlights brightest in absolute terms
const GLINT_GAIN = 0.55;      // the band's lift at its centre
const GLINT_MS = 1200;
const GLINT_TILT = 24;        // degrees: the band leans like a streak of reflected light
const BOOK_BASE = 256;

const FS = /* glsl */ `
precision highp float;
uniform sampler2D uIds;
uniform vec2 uTexel;
uniform vec4 uSetA[3];     // per set (hover now, hover before, glint): four object ids (-1: none)
uniform vec4 uSetB[3];     // x..y an id range (x > y: none), z 1 when the window opening counts, w the amount (0..1)
uniform vec4 uBand;        // the glint: xy its axis (unit, device px), z its centre along it, w its half width
uniform vec2 uGain;        // x the hover lift, y the band's
uniform vec2 uSize;        // the display (device px)
in vec2 vUv;
out vec4 outColor;
float member(vec4 c, vec4 a, vec4 b) {
  if (c.a < 0.5) return b.z;
  float id = floor(c.g * 255.0 + 0.5) + 256.0 * floor(c.b * 255.0 + 0.5);
  float m = step(abs(id - a.x), 0.5) + step(abs(id - a.y), 0.5) + step(abs(id - a.z), 0.5) + step(abs(id - a.w), 0.5);
  m += step(b.x, id) * step(id, b.y);
  return min(m, 1.0);
}
// a soft edge: the share of five taps (the ID pass is one sample, the room is refined)
float cover(vec4 a, vec4 b) {
  vec2 d = uTexel * 1.25;
  return (member(texture(uIds, vUv), a, b) * 2.0 + member(texture(uIds, vUv + vec2(d.x, 0.0)), a, b) + member(texture(uIds, vUv - vec2(d.x, 0.0)), a, b)
        + member(texture(uIds, vUv + vec2(0.0, d.y)), a, b) + member(texture(uIds, vUv - vec2(0.0, d.y)), a, b)) / 6.0;
}
void main() {
  float g = 0.0;
  if (uSetB[0].w > 0.0) g += uGain.x * uSetB[0].w * cover(uSetA[0], uSetB[0]);
  if (uSetB[1].w > 0.0) g += uGain.x * uSetB[1].w * cover(uSetA[1], uSetB[1]);
  if (uSetB[2].w > 0.0) {
    float s = dot(gl_FragCoord.xy, uBand.xy) - uBand.z;
    float band = exp(-(s * s) / (uBand.w * uBand.w));
    if (band > 0.002) g += uGain.y * uSetB[2].w * band * cover(uSetA[2], uSetB[2]);
  }
  outColor = vec4(vec3(g), 0.0);
}`;

const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

export function createSheen(engine) {
  const { THREE } = engine;
  const renderer = engine.renderer;
  const VS = /* glsl */ `in vec2 position; out vec2 vUv; void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;
  const uniforms = {
    uIds: { value: null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uSetA: { value: [0, 1, 2].map(() => new THREE.Vector4(-1, -1, -1, -1)) },
    uSetB: { value: [0, 1, 2].map(() => new THREE.Vector4(1, 0, 0, 0)) },
    uBand: { value: new THREE.Vector4(1, 0, -1e6, 40) },
    uGain: { value: new THREE.Vector2(HOVER_GAIN, GLINT_GAIN) },
    uSize: { value: new THREE.Vector2(1, 1) },
  };
  const mat = new THREE.RawShaderMaterial({
    name: "sheen", glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms,
    depthTest: false, depthWrite: false, transparent: true,
    // display x (1 + gain): src x dst + dst; the display's alpha is kept
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const quad = new THREE.Mesh(geo, mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  let idRT = null, idKey = "";

  const idsOf = () => engine.ids?.objects || {};
  // an object's name -> its set (four ids, a range, the opening)
  const setOf = (names) => {
    const ids = [], s = { a: [-1, -1, -1, -1], range: [1, 0], opening: 0 };
    const byName = Object.fromEntries(Object.entries(idsOf()).map(([id, n]) => [n, +id]));
    for (const n of names || []) {
      if (n === "books") s.range = [BOOK_BASE, BOOK_BASE + 1023];
      else if (n === "opening") s.opening = 1;
      else if (/^book:\d+$/.test(n)) ids.push(BOOK_BASE + +n.slice(5));
      else if (n in byName) ids.push(byName[n]);
    }
    ids.slice(0, 4).forEach((v, i) => { s.a[i] = v; });
    return s;
  };
  const writeSet = (i, names, amount) => {
    const s = setOf(names);
    uniforms.uSetA.value[i].set(...s.a);
    uniforms.uSetB.value[i].set(s.range[0], s.range[1], s.opening, amount);
  };

  // ---- the hover: two slots, the one coming in and the one going out
  const slots = [{ names: null, from: 0, to: 0, t0: 0, amount: 0, k: 1 }, { names: null, from: 0, to: 0, t0: 0, amount: 0, k: 1 }];
  const same = (a, b) => (a || []).join(",") === (b || []).join(",");
  const now = () => performance.now();
  const reduced = () => !!engine.settings.reducedMotion;
  function hover(names, k = 1) {
    names = names && names.length ? names.slice() : null;
    const [cur, prev] = slots;
    if (same(names, cur.names) && (names ? cur.to === 1 : true)) return;
    if (names && same(names, prev.names)) { slots.reverse(); }   // back onto the one fading out: it fades in again
    else if (cur.names) { Object.assign(prev, { names: cur.names, from: cur.amount, to: 0, t0: now(), k: cur.k }); Object.assign(cur, { names: null, amount: 0, from: 0, to: 0 }); }
    const c = slots[0];
    if (names) Object.assign(c, { names, from: c.names ? c.amount : 0, to: 1, t0: now(), k });
    if (slots[1].names) Object.assign(slots[1], { from: slots[1].amount, to: 0, t0: now() });
    engine.requestFrame();
  }

  // ---- the glint: one band across the objects, left to right on screen
  let glint = null;                 // { names, x0, x1, t0, ms, resolve, half }
  const listeners = new Set();
  let runs = 0;
  // the objects' extent along the band's axis on screen (device px, GL origin), from their world bounds
  const extent = (names, axis) => {
    const v = new THREE.Vector3();
    let lo = Infinity, hi = -Infinity;
    const per = [];
    for (const n of names) {
      const b = engine.objectBounds?.(n);
      if (!b) continue;
      let a = Infinity, z = -Infinity;
      for (let k = 0; k < 8; k++) {
        v.set(k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]).project(engine.camera.three);
        if (v.z > 1) continue;
        const x = (v.x * 0.5 + 0.5) * engine.width, y = (v.y * 0.5 + 0.5) * engine.height;
        const s = x * axis[0] + y * axis[1];
        a = Math.min(a, s); z = Math.max(z, s);
      }
      if (a < z) { per.push({ name: n, lo: a, hi: z, at: (a + z) / 2 }); lo = Math.min(lo, a); hi = Math.max(hi, z); }
    }
    return { lo, hi, per };
  };
  function glintRun(names, { ms = GLINT_MS } = {}) {
    if (glint) glint.resolve(false);
    const th = (GLINT_TILT * Math.PI) / 180;
    const axis = [Math.cos(th), -Math.sin(th)];          // GL y is up: the band's lines lean to the right going up
    const ex = extent(names, axis);
    if (!Number.isFinite(ex.lo)) return Promise.resolve(false);
    const half = Math.max(18, engine.width * 0.026);
    runs++;
    return new Promise((resolve) => {
      glint = { names: names.slice(), axis, x0: ex.lo - 2.2 * half, x1: ex.hi + 2.2 * half, per: ex.per, t0: null, ms, half, resolve, log: [] };
      engine.requestFrame();
    });
  }

  const ensureTarget = (w, h) => {
    const W = Math.max(1, Math.round(w / 2)), H = Math.max(1, Math.round(h / 2));
    if (idRT && idRT.width === W && idRT.height === H) return;
    idRT?.dispose();
    idRT = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    idKey = "";
  };
  const active = () => slots.some((s) => s.names && (s.amount > 0.001 || s.to > 0)) || !!glint;
  let state = { hover: null, glint: null };

  const pass = engine.addPass({
    name: "sheen", stage: "overlay", order: 10,
    update(frame) {
      const t = now();
      for (const s of slots) {
        if (!s.names) continue;
        const ms = reduced() ? 0 : HOVER_MS;
        const x = ms ? (t - s.t0) / ms : 1;
        s.amount = s.from + (s.to - s.from) * ease(x);
        if (x >= 1 && s.to === 0) { s.names = null; s.amount = 0; }
      }
      if (glint) {
        if (glint.t0 === null) glint.t0 = t;
        const x = (t - glint.t0) / glint.ms;
        glint.s = glint.x0 + (glint.x1 - glint.x0) * ease(x);
        for (const p of glint.per) if (!glint.log.some((l) => l.name === p.name) && glint.s >= p.at) glint.log.push({ name: p.name, ms: Math.round(t - glint.t0) });
        if (x >= 1) { const g = glint; glint = null; state.lastGlint = { names: g.names, ms: Math.round(t - g.t0), crossed: g.log }; g.resolve(true); }
      }
      state = { ...state, hover: slots.filter((s) => s.names).map((s) => ({ names: s.names, amount: +s.amount.toFixed(3), to: s.to, k: s.k })),
        glint: glint ? { names: glint.names, s: glint.s, x0: glint.x0, x1: glint.x1, half: glint.half, axis: glint.axis, phase: glint.t0 === null ? 0 : +((t - glint.t0) / glint.ms).toFixed(3) } : null, runs };
      if (active() || state.wasActive) {
        state.wasActive = active();
        for (const fn of listeners) { try { fn(state, frame); } catch (e) { console.error(e); } }
      }
      if (active()) engine.requestFrame();
    },
    animating() { return active(); },
    needsRender() { return active(); },
    render(ctx, frame) {
      ensureTarget(frame.width, frame.height);
      const c = frame.camera;
      const key = c.position.join(",") + c.quaternion.join(",") + c.projectionNoJitter.elements.join(",") + frame.width + "x" + frame.height;
      const target = renderer.getRenderTarget();
      if (key !== idKey) {
        idKey = key;
        cam.position.fromArray(c.position);
        cam.quaternion.fromArray(c.quaternion);
        cam.matrixWorld.compose(cam.position, cam.quaternion, new THREE.Vector3(1, 1, 1));
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        cam.projectionMatrix.copy(c.projectionNoJitter);
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
        renderer.setRenderTarget(idRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        engine.room.setMode("live");
        engine.room.drawIds(cam);
        renderer.setRenderTarget(target);
      }
      writeSet(0, slots[0].names, slots[0].names ? slots[0].amount * slots[0].k : 0);
      writeSet(1, slots[1].names, slots[1].names ? slots[1].amount * slots[1].k : 0);
      if (glint && glint.s !== undefined) {
        writeSet(2, glint.names, 1);
        uniforms.uBand.value.set(glint.axis[0], glint.axis[1], glint.s, glint.half);
      } else uniforms.uSetB.value[2].w = 0;
      uniforms.uIds.value = idRT.texture;
      uniforms.uTexel.value.set(1 / idRT.width, 1 / idRT.height);
      uniforms.uSize.value.set(frame.width, frame.height);
      renderer.render(scene, ortho);
    },
  });

  return {
    hover,
    glint: glintRun,
    onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get state() { return state; },
    get gains() { return { hover: HOVER_GAIN, glint: GLINT_GAIN, hoverMs: HOVER_MS, glintMs: GLINT_MS }; },
    compile() { return renderer.compileAsync(scene, ortho); },
    dispose() { pass.remove(); geo.dispose(); mat.dispose(); idRT?.dispose(); listeners.clear(); },
  };
}

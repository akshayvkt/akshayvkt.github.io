// The notebook on the desk: Akshay's writing (docs/v3/EXPERIENCE-SPEC.md v2; interactions B).
//
//   import { createNotebook, NotebookIndex } from "/shared/notebook.js";
//   const nb = createNotebook(engine, room);     // after engine.loadRoom(), before engine.warmUp() (it adds shader code)
//   nb.open() / nb.close()                       // the elastic slips aside, then the cover swings open (and back)
//   nb.state                                     // { open, elastic, cover, angle (deg), moving }
//   nb.coverCorners()                            // the cover's eight corners now (room metres): what it hides of the page
//   nb.onChange((state) => {})                   // every frame it moves
//   const ix = new NotebookIndex({ parent, room, reader, onTitle });   // the index of essays on the first page
//
// The cover and the elastic are their own nodes in the live model (desk-r1: part_notebook_cover, its origin on the
// hinge, room3d.json objects.notebook_cover { pivot, axis, open_deg }; part_notebook_elastic). The cover turns about
// the spine by the right-hand rule; the export's open_deg is -180, flat at the hinge's height, which would sit half a
// millimetre over the laptop's keys (the open cover reaches the laptop's front right corner): it opens to OPEN_DEG
// instead, a stiff new cover resting a few degrees short of flat. Under the closed cover the first page and the
// cover's inside were baked in the dark; a few lines of shader (the way gl/interact.js lights a pulled book's sides)
// give them the light the closed cover's top had at the same place (the inside of the cover: mirrored across the
// spine), leaving out the shadow of the elastic's band, with a soft gutter by the spine and a soft contact shadow
// under the open cover. Reduced motion: no motion, the cover is open or closed at once.
import { project, ray } from "./rig.js";
import { Surface } from "./surface.js";
import { createPageTurn, LEAF, measureLeaves, turnFrames, turnUniforms, TURN_FS } from "./pageturn.js";

export const OPEN_DEG = -174;
const ELASTIC_MS = 340, COVER_MS = 800;
const SLIP = 0.026;                      // m: the elastic slips off the fore edge (the band is 22 mm in from it)
const PAGE = { x0: 0.0015, x1: 0.21, y: 0.142 };
const COVER = { w: 0.2131, y: 0.145, t: 0.0024 };
const BAND = [0.1855, 0.1965];           // the elastic's 6 mm band on the closed cover, with its contact shadow (hinge frame)

// cubic-bezier(x1, y1, x2, y2) as a function of time
export function bezier(x1, y1, x2, y2) {
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 10; i++) {
      const x = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s - t;
      const dx = 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
      if (Math.abs(x) < 1e-6 || Math.abs(dx) < 1e-6) break;
      s = Math.min(1, Math.max(0, s - x / dx));
    }
    return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  };
}
export const SOFT = bezier(0.45, 0, 0.25, 1);   // the site's soft ease (router.js SOFT)

const FS_BLOCK = /* glsl */ `
${TURN_FS}
// ---- interactions B (notebook.js): the notebook's first page and the inside of its cover, lit as the cover opens
uniform vec4 uNbPivot;   // xyz the hinge (room m), w the cover's turn about uNbAxis (radians; 0: closed)
uniform vec4 uNbAxis;    // xyz the spine toward the head (unit), w 1 when on
uniform vec4 uNbX;       // xyz across the cover toward the fore edge (unit), w the cover's width
uniform vec4 uNbUV0;     // the closed cover top's light-map chart: uv = uNbUV0.xy + uNbUV1.xy * x + uNbUV1.zw * y
uniform vec4 uNbUV1;
uniform vec4 uNbUVBox;   // its uv bounds
uniform vec4 uNbPage;    // the page: x0, x1, half height (hinge frame), its height (room y)
uniform vec4 uNbMisc;    // x, y: the elastic's band on the cover (hinge frame); z: how open (0-1); w: the cover's thickness
vec3 nbRot(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
void nbAt(vec2 h, out vec3 L, out vec3 sun, out vec3 lamp) {
  vec2 uv = clamp(uNbUV0.xy + uNbUV1.xy * h.x + uNbUV1.zw * h.y, uNbUVBox.xy, uNbUVBox.zw);
  vec3 amb = layer(uAmbient, uv, uAmbientScale);
  sun = layer(uSun, uv, uSunScale);
  lamp = layer(uLamp, uv, uLampScale);
  vec3 scr = layer(uScreen, uv, uScreenScale);
  L = uLayerW.x * amb + uLayerW.y * sun + uLayerW.z * lamp + uLayerW.w * scr;
}
void nbLight(vec2 h, out vec3 L, out vec3 sun, out vec3 lamp) {
  if (h.x > uNbMisc.x && h.x < uNbMisc.y) {
    vec3 L1, s1, l1, L2, s2, l2;
    float t = (h.x - uNbMisc.x) / (uNbMisc.y - uNbMisc.x);
    nbAt(vec2(uNbMisc.x, h.y), L1, s1, l1);
    nbAt(vec2(uNbMisc.y, h.y), L2, s2, l2);
    L = mix(L1, L2, t); sun = mix(s1, s2, t); lamp = mix(l1, l2, t);
    return;
  }
  nbAt(h, L, sun, lamp);
}
void sfwNotebook(inout vec3 Lb, inout vec3 sunL, inout vec3 lampL, vec3 P, vec3 Ng) {
  if (uNbAxis.w < 0.5) return;
  vec3 d = P - uNbPivot.xyz;
  vec2 h = vec2(dot(d, uNbX.xyz), dot(d, uNbAxis.xyz));
  float op = uNbMisc.z;
  if (Ng.y > 0.9 && abs(P.y - uNbPage.w) < 0.0008 && h.x > uNbPage.x - 0.002 && h.x < uNbPage.y + 0.002 && abs(h.y) < uNbPage.z + 0.002) {
    nbLight(h, Lb, sunL, lampL);
    Lb *= 1.0 - 0.14 * op * (1.0 - smoothstep(0.0, 0.022, h.x));
    float pt = ptShade(P, Ng);   // (a turning leaf's shadow: 1 at rest)
    Lb *= pt; sunL *= pt; lampL *= pt;
    return;
  }
  vec3 dc = nbRot(d, uNbAxis.xyz, -uNbPivot.w), nc = nbRot(Ng, uNbAxis.xyz, -uNbPivot.w);
  vec2 hc = vec2(dot(dc, uNbX.xyz), dot(dc, uNbAxis.xyz));
  if (nc.y < -0.9 && abs(dc.y) < 0.0008 && hc.x > -0.002 && hc.x < uNbX.w + 0.002 && abs(hc.y) < uNbPage.z + 0.006) {
    nbLight(vec2(clamp(hc.x, uNbPage.x, uNbPage.y), clamp(hc.y, -uNbPage.z, uNbPage.z)), Lb, sunL, lampL);
    Lb *= 0.9;
    float pt = ptShade(P, Ng);
    Lb *= pt; sunL *= pt; lampL *= pt;
    return;
  }
  if (op > 0.001 && Ng.y > 0.3) {
    float s = -h.x, elev = 3.14159265 + uNbPivot.w;
    if (s > -0.004 && s < uNbX.w + 0.014 && abs(h.y) < uNbPage.z + 0.016) {
      float gap = uNbPivot.y + s * sin(elev) - uNbMisc.w * cos(elev) - P.y;
      if (gap > -0.002) {
        float edge = smoothstep(-0.004, 0.008, s) * (1.0 - smoothstep(uNbX.w - 0.01, uNbX.w + 0.014, s)) * (1.0 - smoothstep(uNbPage.z - 0.008, uNbPage.z + 0.016, abs(h.y)));
        float k = op * edge * 0.5 * exp(-max(gap, 0.0) / 0.03);
        Lb *= 1.0 - k; sunL *= 1.0 - k; lampL *= 1.0 - k;
      }
    }
  }
}
`;

function insertBefore(src, anchor, text) {
  const i = src.lastIndexOf(anchor);
  return i < 0 ? null : src.slice(0, i) + text + src.slice(i);
}

// least squares: the affine map rows [1, x, y] -> value
function fit3(rows, vals) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  rows.forEach((r, i) => { for (let a = 0; a < 3; a++) { b[a] += r[a] * vals[i]; for (let c = 0; c < 3; c++) M[a][c] += r[a] * r[c]; } });
  // Cramer's rule
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map((k) => det(M.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
}

export function createNotebook(engine, room) {
  const { THREE } = engine;
  const data = room.objects.notebook_cover;
  const cover = engine.room?.scene.getObjectByName(data?.node || "part_notebook_cover");
  const elastic = engine.room?.scene.getObjectByName("part_notebook_elastic");
  if (!data?.pivot || !cover) return null;
  const P = new THREE.Vector3(...data.pivot), Y = new THREE.Vector3(...data.axis).normalize();
  const X = new THREE.Vector3().crossVectors(Y, new THREE.Vector3(0, 1, 0)).normalize();
  const openRad = (OPEN_DEG * Math.PI) / 180;
  const q0 = cover.quaternion.clone(), e0 = elastic ? elastic.position.clone() : null;
  const hingeOf = (v) => { const d = v.clone().sub(P); return [d.dot(X), d.dot(Y), v.y - P.y]; };

  // ---- the closed cover top's light-map chart (an affine map from the hinge frame), and the page's height
  let chart = null, pageY = P.y;
  {
    const meshes = []; cover.traverse((m) => { if (m.isMesh) meshes.push(m); });
    const rows = [], us = [], vs = [], uvs = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      const g = m.geometry, pos = g.attributes.position, nrm = g.attributes.normal, uv1 = g.attributes.uv1;
      if (!pos || !nrm || !uv1) continue;
      const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
      let top = -Infinity;
      for (let i = 0; i < pos.count; i++) top = Math.max(top, v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).y);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        if (n.y < 0.9999 || v.y < top - 0.0002) continue;
        const h = hingeOf(v);
        rows.push([1, h[0], h[1]]); us.push(uv1.getX(i)); vs.push(uv1.getY(i)); uvs.push([uv1.getX(i), uv1.getY(i)]);
      }
    }
    const fu = rows.length >= 3 ? fit3(rows, us) : null, fv = rows.length >= 3 ? fit3(rows, vs) : null;
    if (fu && fv) {
      let resid = 0;
      rows.forEach((r, i) => { resid = Math.max(resid, Math.hypot(fu[0] + fu[1] * r[1] + fu[2] * r[2] - us[i], fv[0] + fv[1] * r[1] + fv[2] * r[2] - vs[i])); });
      const texel = 1 / (engine.bake?.atlases?.desk?.size || 2048);
      const box = [Math.min(...uvs.map((u) => u[0])) + 1.5 * texel, Math.min(...uvs.map((u) => u[1])) + 1.5 * texel, Math.max(...uvs.map((u) => u[0])) - 1.5 * texel, Math.max(...uvs.map((u) => u[1])) - 1.5 * texel];
      if (resid < 4 * texel) chart = { fu, fv, box, resid, n: rows.length };
    }
    // the page block's top (the first leaf): the notebook's highest upward faces inside the page, in the desk's mesh
    const id = engine.ids ? +Object.entries(engine.ids.objects).find(([, nm]) => nm === "notebook")?.[0] : 5;
    let best = -Infinity;
    for (const m of engine.room.meshes) {
      const g = m.geometry, col = g.attributes.color, pos = g.attributes.position, nrm = g.attributes.normal;
      if (!col || !nrm || cover.getObjectById(m.id)) continue;
      m.updateWorldMatrix(true, false);
      const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
      for (let i = 0; i < col.count; i++) {
        if (Math.round(col.getX(i) * 255) + 256 * Math.round(col.getY(i) * 255) !== id) continue;
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const h = hingeOf(v);
        if (h[0] < PAGE.x0 + 0.004 || h[0] > PAGE.x1 - 0.004 || Math.abs(h[1]) > PAGE.y - 0.004) continue;
        if (n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize().y < 0.99) continue;
        best = Math.max(best, v.y);
      }
    }
    if (Number.isFinite(best) && Math.abs(best - P.y) < 0.003) pageY = best;
  }

  // ---- the shader code, added to every room material (after gl/interact.js's, which declares the vertex ids)
  const U = {
    uNbPivot: { value: new THREE.Vector4(P.x, P.y, P.z, 0) },
    uNbAxis: { value: new THREE.Vector4(Y.x, Y.y, Y.z, chart ? 1 : 0) },
    uNbX: { value: new THREE.Vector4(X.x, X.y, X.z, COVER.w) },
    uNbUV0: { value: new THREE.Vector4(chart ? chart.fu[0] : 0, chart ? chart.fv[0] : 0, 0, 0) },
    uNbUV1: { value: new THREE.Vector4(chart ? chart.fu[1] : 0, chart ? chart.fv[1] : 0, chart ? chart.fu[2] : 0, chart ? chart.fv[2] : 0) },
    uNbUVBox: { value: new THREE.Vector4(...(chart ? chart.box : [0, 0, 1, 1])) },
    uNbPage: { value: new THREE.Vector4(PAGE.x0, PAGE.x1, PAGE.y, pageY) },
    uNbMisc: { value: new THREE.Vector4(BAND[0], BAND[1], 0, COVER.t) },
  };
  const UT = turnUniforms(THREE);   // the page turn's (pageturn.js): its shadow on the page and the cover's inside
  Object.assign(U, UT);
  const patched = { room: 0, missing: [] };
  if (chart) {
    for (const m of engine.room.materials) {
      if (m.userData.sfwNotebook) continue;
      const fs = insertBefore(m.fragmentShader, "void main()", FS_BLOCK);
      const call = "Lb = sfwBook(Lb, P, Ng);   // stream I";
      const anchor = fs && fs.includes(call) ? call : "Lb *= detail;";
      if (!fs || !fs.includes(anchor)) { patched.missing.push(m.name); continue; }
      m.fragmentShader = fs.replace(anchor, `${anchor}\n    sfwNotebook(Lb, sunL, lampL, P, Ng);   // interactions B`);
      Object.assign(m.uniforms, U);
      m.userData.sfwNotebook = true;
      m.needsUpdate = true;
      patched.room++;
    }
    if (patched.missing.length) console.warn("[notebook] shader anchors missing:", patched.missing);
  }
  // the page turn: its two sheets join the room now, so the warm-up compiles and draws them (pageturn.js)
  let pages = null;
  if (chart && patched.room) {
    try { pages = createPageTurn(engine, { pivot: P.toArray(), axis: Y.toArray(), uniforms: UT, openRad, skip: [cover, elastic] }); }
    catch (err) { console.warn("[pageturn]", err); pages = null; }
  }

  // ---- the motion: the elastic (0-1), then the cover (0-1); closing in the other order
  const listeners = new Set();
  const st = { target: false, e: 0, c: 0, seg: null };
  const reduced = () => !!engine.settings.reducedMotion;
  const apply = () => {
    const a = openRad * st.c;
    cover.quaternion.copy(q0).premultiply(new THREE.Quaternion().setFromAxisAngle(Y, a));
    cover.updateMatrixWorld(true);
    if (elastic) { elastic.position.copy(e0).addScaledVector(X, SLIP * st.e); elastic.updateMatrixWorld(true); }
    U.uNbPivot.value.w = a;
    U.uNbMisc.value.z = Math.min(1, Math.max(0, ((-a * 180) / Math.PI - 100) / 70));
    pages?.setCover(a);   // (the turned leaves lie on the cover's inside: they go with it)
    engine.invalidate("notebook");
    for (const fn of listeners) { try { fn(state()); } catch (err) { console.error(err); } }
  };
  const state = () => ({ open: st.target, elastic: +st.e.toFixed(4), cover: +st.c.toFixed(4), angle: +((OPEN_DEG * st.c)).toFixed(2), moving: moving() });
  const want = () => (st.target ? 1 : 0);
  const moving = () => st.e !== want() || st.c !== want();
  const step = (now) => {
    const w = want();
    for (const k of st.target ? ["e", "c"] : ["c", "e"]) {
      if (st[k] === w) continue;
      const ms = k === "e" ? ELASTIC_MS : COVER_MS;
      if (!st.seg || st.seg.k !== k || st.seg.to !== w) st.seg = { k, from: st[k], to: w, t0: now, ms: ms * Math.max(0.35, Math.abs(w - st[k])) };
      const x = Math.min(1, (now - st.seg.t0) / st.seg.ms);
      st[k] = x >= 1 ? w : st.seg.from + (w - st.seg.from) * SOFT(x);
      if (x >= 1) st.seg = null;
      return true;
    }
    return false;
  };
  const pass = engine.addPass({
    name: "notebook", stage: "prepare", order: -9,
    update(frame) { if (moving()) { step(frame.time ?? performance.now()); apply(); } },
    animating: () => moving(),
    render() {}, needsRender: () => false,
  });
  const go = (open) => {
    st.target = open;
    st.seg = null;
    if (reduced()) { st.e = st.c = open ? 1 : 0; apply(); return; }
    engine.requestFrame();
  };

  return {
    chart, patched, pageY, pages,
    open: () => go(true),
    close: () => go(false),
    jump(open) { st.target = open; st.e = st.c = open ? 1 : 0; st.seg = null; apply(); },
    get state() { return state(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // the cover's eight corners as it is now (room metres)
    coverCorners() {
      const q = new THREE.Quaternion().setFromAxisAngle(Y, openRad * st.c), out = [];
      for (const x of [0, COVER.w]) for (const y of [-COVER.y, COVER.y]) for (const z of [0, COVER.t]) {
        const v = new THREE.Vector3().addScaledVector(X, x).addScaledVector(Y, y).add(new THREE.Vector3(0, z, 0)).applyQuaternion(q).add(P);
        out.push(v.toArray());
      }
      return out;
    },
    dispose() { pass.remove(); listeners.clear(); st.e = st.c = 0; apply(); pages?.dispose(); },
  };
}

// ------------------------------------------------------------------ the index on the first page
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const CSS = `
.sfw-nb { position: absolute; left: 0; top: 0; z-index: 1; transform-origin: 0 0; pointer-events: none; visibility: hidden; opacity: 0;
  mix-blend-mode: multiply; color: #2a221c; font-family: "Cormorant Garamond", "Cormorant", Garamond, serif; font-style: italic;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; contain: layout style; }
.sfw-nb .nb-leaf { position: absolute; inset: 0; box-sizing: border-box; padding: 10% 9% 9% 12%; transform-origin: 0 50%; }
.sfw-nb .nb-leaf[hidden] { display: none; }
.sfw-nb ol { list-style: none; margin: 0; padding: 0; }
.sfw-nb li { margin: 0 0 0.6em; }
.sfw-nb a { display: block; color: inherit; text-decoration: none; outline: none; -webkit-tap-highlight-color: transparent; }
.sfw-nb .nb-tt { font-weight: 500; line-height: 1.12; letter-spacing: 0.004em; text-wrap: balance; text-decoration: underline 0.05em transparent; text-underline-offset: 0.16em;
  transition: text-decoration-color 0.2s ease; }
.sfw-nb .nb-d { display: block; margin-top: 0.2em; font-size: 0.62em; font-weight: 500; letter-spacing: 0.03em; color: #74675b; font-variant-numeric: oldstyle-nums; }
.sfw-nb.is-on a, .sfw-nb.is-on .nb-turn { pointer-events: auto; cursor: pointer; }
.sfw-nb a:hover .nb-tt, .sfw-nb a:focus-visible .nb-tt { text-decoration-color: rgba(42, 34, 28, 0.42); }
/* a page corner, curled up: the way to the next leaf (and back). Drawn in the ink's multiply, so it can only shade the
   lit paper: the curled flap's back a little in shade, its crisp fold, and the soft shadow it casts on the page. Under
   the pointer it lifts a little more; the first time the notebook opens in a visit it lifts once by itself (a quiet
   cue that there is a next page; live room 2: Akshay didn't find the second leaf behind the old, fainter corner). */
.sfw-nb .nb-turn { position: absolute; bottom: 0; width: 12.5%; aspect-ratio: 1; padding: 0; border: 0; background: none; outline: none;
  -webkit-tap-highlight-color: transparent; transition: transform 0.32s cubic-bezier(0.45, 0, 0.25, 1); }
.sfw-nb .nb-turn.next { right: 0; transform-origin: 100% 100%;
  background: linear-gradient(315deg, rgba(118, 98, 78, 0.2) 0 44%, rgba(58, 42, 28, 0.5) 45.6%, rgba(84, 64, 46, 0.24) 49%, rgba(84, 64, 46, 0.09) 58%, transparent 72%); }
.sfw-nb .nb-turn.prev { left: 0; transform-origin: 0 100%;
  background: linear-gradient(45deg, rgba(118, 98, 78, 0.2) 0 44%, rgba(58, 42, 28, 0.5) 45.6%, rgba(84, 64, 46, 0.24) 49%, rgba(84, 64, 46, 0.09) 58%, transparent 72%); }
.sfw-nb.is-on .nb-turn:hover, .sfw-nb.is-on .nb-turn:focus-visible { transform: scale(1.32); }
.sfw-nb .nb-turn.peek { animation: nb-peek 1.25s cubic-bezier(0.45, 0, 0.25, 1) 1; }
@keyframes nb-peek { 0% { transform: none; } 38% { transform: scale(1.62); } 56% { transform: scale(1.62); } 100% { transform: none; } }
.sfw-nb .nb-turn:focus-visible { box-shadow: inset 0 0 0 0.12em rgba(42, 34, 28, 0.35); border-radius: 0.2em; }
/* the page turn (pageturn.js): a drag on a corner never scrolls or zooms the page; while a leaf turns its ink is drawn
   in the 3D (the DOM's own words, bending with the paper), so the DOM's goes (opacity, not display: the corner keeps the
   pointer and the focus); with the cover's inside on screen, the way back is its own corner (the turned leaf's) */
.sfw-nb .nb-turn { touch-action: none; }
.sfw-nb.is-turning .nb-leaf { opacity: 0; }
.sfw-nb.is-turning a { pointer-events: none; }
.sfw-nb.has-left .nb-leaf .nb-turn.prev { display: none; }
`;

export class NotebookIndex {
  constructor({ parent, room, reader, onTitle = null, reduced = () => false, pages = null }) {
    this.room = room;
    this.reader = reader;
    this.reduced = reduced;
    this.onTitle = onTitle;
    this.pages = pages;          // the 3D page turn (pageturn.js, from createNotebook), or null: the DOM's own turn
    this.inkLevel = 0;
    if (!document.querySelector("style[data-sfw-nb]")) {
      const s = document.createElement("style");
      s.setAttribute("data-sfw-nb", "");
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.className = "sfw-nb";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", room.spots.notebook?.label || "");
    this.el.inert = true;
    parent.appendChild(this.el);
    this.surface = new Surface(this.el, () => room.objects.notebook_page?.quad, { oversample: 2 });
    this.leaf = 0;
    this.leaves = [];
    this.posts = [];
    this.shown = false;
    this.ready = (async () => {
      this.posts = await reader.index();
      await Promise.race([Promise.all(['italic 500 20px "Cormorant Garamond"'].map((f) => document.fonts?.load(f))), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
      return this;
    })();
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("pointerover", (e) => { const a = e.target.closest?.("a[data-slug]"); if (a) reader.prefetch(a.dataset.slug); });
    this.el.addEventListener("focusin", (e) => { const a = e.target.closest?.("a[data-slug]"); if (a) reader.prefetch(a.dataset.slug); });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") { if (this.turn(1)) e.preventDefault(); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { if (this.turn(-1)) e.preventDefault(); }
    });
    if (this.pages) {
      // a corner pressed: the leaf's corner follows the pointer (pageturn.js); the DOM's ink hands over in the 3D's frame
      this.el.addEventListener("pointerdown", (e) => this.press(e));
      this.pages.onDom((e) => this.turnDom(e));
      // the way back on the cover's side: the turned leaf's own corner, over the turned stack (landscape, where the
      // cover's inside is on screen; otherwise the page's own corner by the spine, as before)
      const cv = room.objects.notebook_cover;
      if (cv?.pivot && cv.axis) {
        const L = turnFrames({ pivot: cv.pivot, axis: cv.axis, cover: (OPEN_DEG * Math.PI) / 180 }).left;
        const at = (u, v) => [0, 1, 2].map((i) => L.O[i] + u * L.X[i] + v * L.Y[i]);
        this.leftQuad = [at(LEAF.x1, LEAF.h), at(LEAF.x0, LEAF.h), at(LEAF.x0, -LEAF.h), at(LEAF.x1, -LEAF.h)];
        this.left = document.createElement("div");
        this.left.className = "sfw-nb sfw-nb-left";
        this.left.inert = true;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "nb-turn prev";
        b.setAttribute("aria-label", "Previous page");
        b.addEventListener("click", (e) => { e.stopPropagation(); if (!this.swallowClick()) this.turn(-1); });
        this.left.appendChild(b);
        parent.appendChild(this.left);
        this.left.addEventListener("pointerdown", (e) => this.press(e));
        this.leftSurface = new Surface(this.left, () => this.leftQuad, { oversample: 2 });
      }
    }
  }

  // The layout box: the page's size on screen at the notebook's rest pose (x 2: drawn through a perspective, it stays
  // crisp); the type follows the page's width; the essays flow onto as many leaves as they need.
  layout(pose, w, h) {
    const before = this.surface.box.join("x");
    const [bw] = this.surface.layout(pose, w, h);
    if (this.left) {
      // the cover's side: its own box, right after the page's in the tab order; used where it is on screen
      this.leftSurface.layout(pose, w, h);
      if (this.left.previousElementSibling !== this.el && this.el.parentNode) this.el.after(this.left);
      const q = this.leftQuad.map((p) => project(pose, p, w, h));
      this.hasLeft = q.every((p) => p && p[0] >= -2 && p[0] <= w + 2 && p[1] >= -2 && p[1] <= h + 2);
      this.el.classList.toggle("has-left", this.hasLeft);
      this.updateLeft();
    }
    if (!bw || (this.builtFor === this.posts.length && this.surface.box.join("x") === before)) return;
    this.builtFor = this.posts.length;
    // (about 22 px a title at 1440 x 900; never under 14.5 px on screen: the box is drawn at half its size)
    this.el.style.fontSize = `${Math.max(bw * 0.041, 29).toFixed(2)}px`;
    this.build();
  }

  build() {
    const keep = this.leaf;
    this.el.replaceChildren();
    this.leaves = [];
    const mk = () => {
      const leaf = document.createElement("div");
      leaf.className = "nb-leaf";
      const ol = document.createElement("ol");
      leaf.appendChild(ol);
      this.el.appendChild(leaf);
      this.leaves.push(leaf);
      return ol;
    };
    let ol = mk();
    const room = () => ol.parentElement.clientHeight - parseFloat(getComputedStyle(ol.parentElement).paddingBottom);
    const items = this.posts.map((p) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `/writing/${p.slug}`;
      a.dataset.slug = p.slug;
      const t = document.createElement("span");
      t.className = "nb-tt";
      t.textContent = p.title;
      const d = document.createElement("time");
      d.className = "nb-d";
      d.dateTime = p.date;
      d.textContent = DATE.format(new Date(p.date + "T12:00:00Z"));
      a.append(t, d);
      li.appendChild(a);
      return li;
    });
    // a leaf at a time: the titles still to place go in together and are measured in one layout (a title's place
    // does not depend on the ones after it); the first after the leaf's first that ends past 93 % of the leaf starts
    // the next leaf (perf #11: one forced layout per leaf, not one per essay)
    for (let i = 0; i < items.length;) {
      ol.append(...items.slice(i));
      const limit = room() * 0.93;
      let j = i + 1;
      while (j < items.length && !(items[j].offsetTop + items[j].offsetHeight > limit)) j++;
      if (j >= items.length) break;
      ol = mk();
      i = j;
    }
    // balanced leaves (never one essay alone on the last): the same number of leaves, the essays shared out evenly
    if (this.leaves.length > 1) {
      const per = Math.ceil(this.posts.length / this.leaves.length), items = this.leaves.flatMap((l) => [...l.querySelectorAll("li")]);
      this.leaves.forEach((l, i) => l.querySelector("ol").replaceChildren(...items.slice(i * per, (i + 1) * per)));
    }
    // the corners: the next leaf (and back)
    this.leaves.forEach((leaf, i) => {
      for (const [dir, cls, label] of [[1, "next", "Next page"], [-1, "prev", "Previous page"]]) {
        if (!this.leaves[i + dir]) continue;
        const b = document.createElement("button");
        b.type = "button";
        b.className = `nb-turn ${cls}`;
        b.setAttribute("aria-label", label);
        b.addEventListener("click", (e) => { e.stopPropagation(); if (!this.swallowClick()) this.turn(dir); });
        leaf.appendChild(b);
      }
    });
    this.leaf = Math.min(keep, this.leaves.length - 1);
    this.leaves.forEach((l, i) => { l.hidden = i !== this.leaf; });
    // the 3D turn's ink: the words as laid out now, drawn into its atlas while the page is idle (not in a turn's frame)
    if (this.pages) {
      this.pages.setLeaf(this.leaf, { reduced: this.reduced() });
      this.inkFor = null;
      clearTimeout(this.inkT);
      const draw = () => { this.inkT = null; this.ensureInk(); };
      this.inkT = setTimeout(() => (typeof requestIdleCallback === "function" ? requestIdleCallback(draw, { timeout: 1500 }) : draw()), 120);
    }
  }

  // ---------------------------------------------------------------- the 3D page turn (pageturn.js)
  // The words of every leaf, where the DOM puts them, in the turn's ink atlas (once per layout).
  ensureInk() {
    if (!this.pages || !this.leaves.length) return false;
    if (this.inkFor !== this.leaves) {
      try { this.pages.setAtlas(measureLeaves(this.el, this.leaves)); this.inkFor = this.leaves; } catch (err) { console.warn("[pageturn] ink", err); return false; }
    }
    return this.pages.ready;
  }
  // a click right after a drag or a tap the pointer already turned with is the same gesture: swallowed
  swallowClick() {
    if (!this.swallowUntil || performance.now() > this.swallowUntil) return false;
    this.swallowUntil = 0;
    return true;
  }
  // a corner pressed: the leaf's corner follows the pointer until it is let go
  press(e) {
    const b = e.target.closest?.(".nb-turn");
    if (!b || !this.pages || this.turning || this.reduced() || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || !this.lastPose) return;
    const dir = b.classList.contains("next") ? 1 : -1;
    if (!this.leaves[this.leaf + dir] || !this.ensureInk()) return;
    if (!this.pages.start(dir, { leaf: this.leaf, leaves: this.leaves.length, drag: true })) return;
    e.preventDefault();
    this.turning = true;
    const d = (this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false, el: b, dir });
    try { b.setPointerCapture(e.pointerId); } catch { /* the window's listeners below still see it */ }
    d.move = (ev) => { if (ev.pointerId !== d.id) return; if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) d.moved = true; this.dragTo(ev); };
    d.up = (ev) => { if (ev.pointerId !== d.id) return; this.letGo(ev.type === "pointercancel"); };
    addEventListener("pointermove", d.move, true);
    addEventListener("pointerup", d.up, true);
    addEventListener("pointercancel", d.up, true);
    this.dragTo(e);
  }
  dragTo(e) {
    const r = this.el.parentElement?.getBoundingClientRect();
    if (!r || !this.lastPose) return;
    this.pages.dragTo(ray(this.lastPose, e.clientX - r.left, e.clientY - r.top, this.lastW, this.lastH));
  }
  letGo(cancel = false) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    removeEventListener("pointermove", d.move, true);
    removeEventListener("pointerup", d.up, true);
    removeEventListener("pointercancel", d.up, true);
    try { d.el.releasePointerCapture(d.id); } catch { /* released */ }
    // a tap (no drag, quick) lets it turn by itself; a cancelled pointer falls back
    const tap = !cancel && !d.moved && performance.now() - d.t < 600;
    this.lastRelease = { tap, cancel, complete: !!this.pages.release({ tap, back: cancel }) };
    this.swallowUntil = performance.now() + 400;
  }
  // the DOM's ink hands over to the 3D's (and back) in the frame the 3D's starts (or stops)
  turnDom(e) {
    if (e.type === "start") {
      this.focusIn = !!(this.el.contains(document.activeElement) || this.left?.contains(document.activeElement));
      this.el.classList.add("is-turning");
      this.updateLeft();
      return;
    }
    this.leaf = e.leaf;
    this.leaves.forEach((l, i) => { l.hidden = i !== this.leaf; });
    this.el.classList.remove("is-turning");
    this.turning = false;
    this.updateLeft();
    if (this.focusIn && !this.drag) this.leaves[this.leaf]?.querySelector("a[data-slug]")?.focus({ preventScroll: true });
  }
  // the cover's side's corner: shown with a turned leaf under it, the cover open and the page's ink
  updateLeft() {
    if (!this.left) return;
    const on = !!(this.hasLeft && this.shown && this.leaf > 0 && !this.reduced() && this.pages?.coverOpen);
    this.left.style.visibility = on ? "visible" : "hidden";
    this.left.style.opacity = String(this.turning ? 0 : this.inkLevel);   // (during a turn: the corner keeps the pointer)
  }

  // A turn (the arrow keys, a click, Enter on a corner): the 3D leaf turns by itself (pageturn.js); reduced motion: a
  // crossfade; without the 3D turn, the DOM's own soft page lift (the leaf's ink lifts away from the spine and fades as
  // the next one settles in).
  turn(dir) {
    const to = this.leaf + dir;
    if (!this.leaves[to] || this.turning) return false;
    if (this.pages && !this.reduced() && this.ensureInk()) {
      if (!this.pages.start(dir, { leaf: this.leaf, leaves: this.leaves.length })) return false;
      this.turning = true;
      this.leaf = to;        // (it lands there: turnDom shows it then)
      return true;
    }
    const a = this.leaves[this.leaf], b = this.leaves[to];
    this.leaf = to;
    b.hidden = false;
    const quick = this.reduced();
    const lift = [{ transform: "perspective(70em) rotateY(0deg)", opacity: 1 }, { transform: "perspective(70em) rotateY(-34deg)", opacity: 0 }];
    // (the leaf going lifts away first; the one coming settles in as it clears: never two lines of ink over each other)
    const out = quick ? a.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: "forwards" })
      : a.animate(dir > 0 ? [lift[0], { ...lift[1], opacity: 0, offset: 0.8 }, lift[1]] : [{ opacity: 1 }, { opacity: 0 }], { duration: dir > 0 ? 440 : 260, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: "forwards" });
    const into = quick ? b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })
      : b.animate(dir > 0 ? [{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }] : [{ ...lift[1] }, { ...lift[1], offset: 0.3 }, lift[0]], { duration: dir > 0 ? 720 : 620, easing: "cubic-bezier(0.45, 0, 0.25, 1)" });
    this.turning = true;
    Promise.all([out.finished, into.finished]).catch(() => {}).then(() => {
      out.cancel();
      a.hidden = this.leaves.indexOf(a) !== this.leaf;
      this.turning = false;
      this.pages?.setLeaf(this.leaf, { reduced: quick });   // (no turned stack in the 3D for a fade)
      this.updateLeft();
      const f = b.querySelector("a[data-slug]");
      if (this.el.contains(document.activeElement) && f) f.focus({ preventScroll: true });
    });
    return true;
  }

  onClick(e) {
    const a = e.target.closest?.("a[data-slug]");
    if (!a || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    this.onTitle?.(a.dataset.slug, a);
  }

  place(pose, w, h, opts = {}) {
    this.lastPose = pose; this.lastW = w; this.lastH = h;   // (a drag's pointer is read through this pose: rig.js ray)
    if (this.left) { this.leftSurface.place(pose, w, h, { still: opts.still }); this.updateLeft(); }
    return this.surface.place(pose, w, h, opts);
  }
  rect(pose, w, h) { return this.surface.rect(pose, w, h); }

  // shown: on the page (visibility); ink: its opacity (it comes as the cover clears the page, goes as a page lifts out)
  setShown(on) { this.shown = on; this.el.style.visibility = on ? "visible" : "hidden"; this.updateLeft(); }
  setInk(v, ms = 0) {
    this.el.style.transition = ms ? `opacity ${ms}ms ease` : "none";
    this.el.style.opacity = String(v);
    this.inkLevel = v;
    this.pages?.setInk(v);
    if (this.left) { this.left.style.transition = this.el.style.transition; this.updateLeft(); }
    if (v >= 0.999 && this.el.classList.contains("is-on")) this.hint();
  }
  // The first time the notebook lies open in a visit (and there is a next leaf), its corner lifts once by itself.
  hint() {
    if (this.hinted || this.reduced() || this.leaf !== 0 || this.leaves.length < 2) return;
    this.hinted = true;
    try { if (sessionStorage.getItem("sfw-nb-peek")) return; sessionStorage.setItem("sfw-nb-peek", "1"); } catch { /* storage blocked: once per page */ }
    clearTimeout(this.hintT);
    this.hintT = setTimeout(() => {
      const b = this.leaves[this.leaf]?.querySelector(".nb-turn.next");
      if (!b || this.turning || !this.el.classList.contains("is-on")) return;
      b.classList.add("peek");
      b.addEventListener("animationend", () => b.classList.remove("peek"), { once: true });
    }, 650);
  }
  setActive(on) {
    this.el.inert = !on;
    this.el.classList.toggle("is-on", on);
    if (this.left) { this.left.inert = !on; this.left.classList.toggle("is-on", on); }
    // leaving mid-turn: the leaf lands (or falls back) at once
    if (!on && this.turning && this.pages?.busy) { if (this.drag) this.letGo(true); this.pages.finishNow(); }
  }
  first() { return this.leaves[this.leaf]?.querySelector("a[data-slug]") || null; }
  linkFor(slug) { return /^[a-z0-9-]+$/.test(slug) ? this.el.querySelector(`a[data-slug="${slug}"]`) : null; }
  showSlug(slug) {
    const i = this.leaves.findIndex((l) => l.querySelector(`a[data-slug="${slug}"]`));
    if (i >= 0 && i !== this.leaf && !this.turning) {
      this.leaves[this.leaf].hidden = true; this.leaf = i; this.leaves[i].hidden = false;
      this.pages?.setLeaf(i, { reduced: this.reduced() });
      this.updateLeft();
    }
  }
}

// the page's four corners projected (for a reader's lift: its bounding box)
export function pageCorners(room, pose, w, h) {
  const q = room.objects.notebook_page?.quad;
  if (!q) return null;
  const P = q.map((p) => project(pose, p, w, h));
  return P.some((p) => !p) ? null : P;
}

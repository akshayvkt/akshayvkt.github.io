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
import { createPageTurn, drawAtlas, GRAB_ZONE, LEAF, measureLeafSteps, measureLeaves, pageTriangles, TAP_ZONE, turnUniforms, TURN_FS } from "./pageturn.js";
import { withoutRepeatedFaces, RESTYLE } from "./faces.js";

export const OPEN_DEG = -174;
const ELASTIC_MS = 340, COVER_MS = 800;
const SLIP = 0.026;                      // m: the elastic slips off the fore edge (the band is 22 mm in from it)
const PAGE = { x0: 0.0015, x1: 0.21, y: 0.142 };
const COVER = { w: 0.2131, y: 0.145, t: 0.0024 };
// the elastic's 6 mm band on the closed cover with its shadows (hinge frame), bridged over for the page: from its start
// (every light's shadow begins past 186.5 mm) to past the golden and late-afternoon sun's cast shadow (to 197.5 mm), each
// end a further 3.5 mm out, past the reach of the desktop's B-spline light-map filter (2 texels, ~3.3 mm), and past a
// small notch in the lamp's map at 201 mm;
// the laptop screen's light (a broad soft source to the left) is darkened by it all the way to the fore edge, so that
// layer keeps the band's start's light to the edge (page-turn2, 21 Oct: Akshay's "light blue line" at blue hour: the
// page's light ramped down to ~30 % across the band, stepped back up and stayed at ~80 % to the edge)
const BAND = [0.182, 0.204];

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
// (DYS-160, Akshay's phone at night: pink blotches on the left page) the lamp's and the screen's layers are each one
// light's, baked in its own colour (the map's scale; the texels near grey): any other hue in a texel is the map's
// encoding (AVIF's chroma in blocks over 8-bit cube roots), which the cover's dark top and the walnut hide and the white
// paper shows. On the paper those two are their brightness alone, in their light's colour.
vec3 nbOne(vec3 c, vec3 s) { return s * (lum(c) / max(lum(s), 1e-9)); }
// the closed cover top's light at h, by layer
void nbAt(vec2 h, out vec3 amb, out vec3 sun, out vec3 lamp, out vec3 scr) {
  vec2 uv = clamp(uNbUV0.xy + uNbUV1.xy * h.x + uNbUV1.zw * h.y, uNbUVBox.xy, uNbUVBox.zw);
  amb = layer(uAmbient, uv, uAmbientScale);
  sun = layer(uSun, uv, uSunScale);
  lamp = nbOne(layer(uLamp, uv, uLampScale), uLampScale);
  scr = nbOne(layer(uScreen, uv, uScreenScale), uScreenScale);
}
// the page's light: the closed cover's, without the elastic's shadows (the band bridged from its start to its end; the
// screen's light, which the elastic darkens to the fore edge and the cover's rounded edge brightens, kept at the band's
// start's to the edge: a broad soft source, it changes little over those 25 mm)
void nbLight(vec2 h, out vec3 L, out vec3 sun, out vec3 lamp) {
  vec3 amb, scr;
  nbAt(h, amb, sun, lamp, scr);
  if (h.x > uNbMisc.x) {
    vec3 a1, s1, l1, c1;
    nbAt(vec2(uNbMisc.x, h.y), a1, s1, l1, c1);
    scr = c1;
    if (h.x < uNbMisc.y) {
      vec3 a2, s2, l2, c2;
      nbAt(vec2(uNbMisc.y, h.y), a2, s2, l2, c2);
      float t = (h.x - uNbMisc.x) / (uNbMisc.y - uNbMisc.x);
      amb = mix(a1, a2, t); sun = mix(s1, s2, t); lamp = mix(l1, l2, t);
    }
  }
  L = uLayerW.x * amb + uLayerW.y * sun + uLayerW.z * lamp + uLayerW.w * scr;
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

export function createNotebook(engine, room, opt = {}) {
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
  // (DYS-149: opt.pagesLater, the router's boot: not here but in addPages() below, the next tasks, still before the
  // warm-up: the notebook and its page turn were one 90 ms task on a slow laptop. The same sheets, made the same way)
  let pages = null, nb = null;
  const turnArgs = chart && patched.room ? { pivot: P.toArray(), axis: Y.toArray(), uniforms: UT, openRad, skip: [cover, elastic] } : null;
  const makePages = (page = null) => {
    if (!turnArgs) return null;
    try { pages = createPageTurn(engine, { ...turnArgs, page }); }
    catch (err) { console.warn("[pageturn]", err); pages = null; }
    if (nb) nb.pages = pages;
    return pages;
  };
  if (!opt.pagesLater) makePages();

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

  nb = {
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
  // (DYS-149, opt.pagesLater: the page's triangles in this task, the sheets after `pause` (a message), so neither is a
  // long task; once only, before the warm-up. Resolves to the page turn, or null as createPageTurn's)
  if (opt.pagesLater) {
    let added = null;
    nb.addPages = (pause) => added || (added = (async () => {
      if (!turnArgs) return null;
      let page;
      try { page = pageTriangles(engine, turnArgs); } catch (err) { console.warn("[pageturn]", err); return null; }
      await pause?.();
      return makePages(page);
    })());
  }
  return nb;
}

// ------------------------------------------------------------------ the index: a book's pages across the spread
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const PER_PAGE = 4;   // essays on a page (Akshay, 20 Oct: "just show 4 writings at a time")
// Each essay's entry 20 % bigger (Akshay, 21 Oct: the titles and dates, and the space between entries, so the four fill
// more of the page): one factor on the type, which every size and space of an entry follows (em); the page's margins stay.
// Where the type is at its floor (phones), it stays there: the floor is the size it may not go under, not this factor's.
const ENTRY = 1.2;
// The writing on the right-hand pages only (Akshay, 20 Oct: "i want content only on one side of the book pages - the right
// side"): a leaf's back, the left page once it is turned, is blank paper (its front's ink faintly through it). false: the
// list runs across both pages of a spread, as a printed book's.
const BOTH_SIDES = false;
// ?nb4 (for trying it on a phone): four a page on any screen, the type as small as that needs (below its 14.5 px floor)
const FORCE4 = (() => { try { return new URLSearchParams(location.search).has("nb4"); } catch { return false; } })();
// (DYS-149) The 3D turn's ink a page a task (inkSteps), not in one: on the slow laptop it was one 64-100 ms task after the
// room is shown. ?inksplit=0: in one task, as before; ?inksplit=check: a page a task, then both ways compared (the
// console's "inksplit check", window.__sfwInkCheck)
const INK_SPLIT = (() => { try { return new URLSearchParams(location.search).get("inksplit") ?? "1"; } catch { return "1"; } })();
// (DYS-149: the hand-over restyle) the roman face below only where the document has not declared it already (reader.css,
// put in by the router at the boot, has the same rule: two FontFaces for one file loaded it twice and laid the whole
// document out again as each load ended; shared/faces.js). ?restyle=0: always, as before (RESTYLE: faces.js's)
// (DYS-149) web fonts done loading so far: ink steps that measured across one start again
let fontGen = 0;
try { document.fonts?.addEventListener?.("loadingdone", () => { fontGen++; }); } catch { /* (no document) */ }
// (DYS-149) fn in a task of its own just after the next frame is drawn (a message posted from inside the frame)
const afterFrame = (fn) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); fn(); }; c.port2.postMessage(0); });
const CSS = `
/* (DYS-32, Akshay: the list's titles and dates upright. The homepage loads no roman Cormorant of its own (style.css
   is Geist; print.js brings only the italic; reader.css only once the sheet opens), so the notebook brings it) */
@font-face { font-family: "Cormorant Garamond"; src: url("/fonts/cormorant-garamond-latin.woff2") format("woff2"); font-weight: 300 600; font-style: normal; font-display: swap; }
.sfw-nb { position: absolute; left: 0; top: 0; z-index: 1; transform-origin: 0 0; pointer-events: none; visibility: hidden; opacity: 0;
  mix-blend-mode: multiply; color: #2a221c; font-family: "Cormorant Garamond", "Cormorant", Garamond, serif; font-style: normal;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; contain: layout style; -webkit-user-select: none; user-select: none; }
.sfw-nb-left { -webkit-backface-visibility: hidden; backface-visibility: hidden; }
.sfw-nb .nb-leaf { position: absolute; inset: 0; box-sizing: border-box; padding: 10% 9% 9% 12%; transform-origin: 0 50%; }
/* a left-hand page (the back of a turned leaf): its gutter margin by the spine, on its right */
.sfw-nb .nb-leaf.verso { padding: 10% 12% 9% 9%; }
.sfw-nb .nb-leaf[hidden] { display: none; }
.sfw-nb ol { list-style: none; margin: 0; padding: 0; }
.sfw-nb li { margin: 0 0 0.6em; }
/* (four to a page where they only fit a little closer: the space between two essays a little less) */
.sfw-nb.nb-tight li { margin-bottom: 0.45em; }
/* a title is only as wide as its words: a tap on the paper beside a short title is the page's, not the title's */
.sfw-nb a { display: block; width: fit-content; max-width: 100%; color: inherit; text-decoration: none; outline: none; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
.sfw-nb .nb-tt { font-weight: 500; line-height: 1.12; letter-spacing: 0.004em; text-wrap: balance; text-decoration: underline 0.05em transparent; text-underline-offset: 0.16em;
  transition: text-decoration-color 0.2s ease; }
.sfw-nb .nb-d { display: block; margin-top: 0.2em; font-size: 0.62em; font-weight: 500; letter-spacing: 0.03em; color: #74675b; font-variant-numeric: oldstyle-nums; }
.sfw-nb.is-on a, .sfw-nb.is-on .nb-turn { pointer-events: auto; cursor: pointer; }
.sfw-nb a:hover .nb-tt, .sfw-nb a:focus-visible .nb-tt { text-decoration-color: rgba(42, 34, 28, 0.42); }
/* the outer part of a page that can turn (page-turn2, Apple Books): a press anywhere there and a drag toward the spine
   takes the leaf by its outer edge; a tap near the outer edge turns it by itself */
.sfw-nb .nb-grab { position: absolute; top: 0; bottom: 0; right: 0; width: 60%; -webkit-tap-highlight-color: transparent; }
.sfw-nb.sfw-nb-left .nb-grab { right: auto; left: 0; }
.sfw-nb.is-on .nb-grab { pointer-events: auto; cursor: grab; }
.sfw-nb .nb-grab[hidden], .sfw-nb .nb-turn[hidden] { display: none; }
.sfw-nb.is-dragging, .sfw-nb.is-dragging .nb-grab, .sfw-nb.is-dragging a { cursor: grabbing; }
/* the hint: a page corner a little lifted, only on a page that can turn and only at its OUTER bottom corner (the right
   page's bottom right, the left page's bottom left). Drawn in the ink's multiply, so it can only shade the lit paper: the
   curled flap's back a little in shade, its fold, and the soft shadow it casts. Under the pointer (the corner or the
   page's outer part) it lifts a little more; the first time the notebook opens in a visit it lifts once by itself. */
.sfw-nb .nb-turn { position: absolute; bottom: 0; width: 11%; aspect-ratio: 1; padding: 0; border: 0; background: none; outline: none;
  -webkit-tap-highlight-color: transparent; transition: transform 0.32s cubic-bezier(0.45, 0, 0.25, 1); }
.sfw-nb .nb-turn.next { right: 0; transform-origin: 100% 100%;
  background: linear-gradient(315deg, rgba(118, 98, 78, 0.15) 0 44%, rgba(58, 42, 28, 0.38) 45.6%, rgba(84, 64, 46, 0.18) 49%, rgba(84, 64, 46, 0.07) 58%, transparent 72%); }
.sfw-nb .nb-turn.prev { left: 0; transform-origin: 0 100%;
  background: linear-gradient(45deg, rgba(118, 98, 78, 0.15) 0 44%, rgba(58, 42, 28, 0.38) 45.6%, rgba(84, 64, 46, 0.18) 49%, rgba(84, 64, 46, 0.07) 58%, transparent 72%); }
.sfw-nb.is-on .nb-turn:hover, .sfw-nb.is-on .nb-turn:focus-visible, .sfw-nb.is-on .nb-grab:hover ~ .nb-turn { transform: scale(1.32); }
.sfw-nb .nb-turn.peek { animation: nb-peek 1.25s cubic-bezier(0.45, 0, 0.25, 1) 1; }
@keyframes nb-peek { 0% { transform: none; } 38% { transform: scale(1.62); } 56% { transform: scale(1.62); } 100% { transform: none; } }
.sfw-nb .nb-turn:focus-visible { box-shadow: inset 0 0 0 0.12em rgba(42, 34, 28, 0.35); border-radius: 0.2em; }
/* the page turn (pageturn.js): a press on a page never scrolls or zooms the page; while a leaf turns the writing of both
   pages is drawn in the 3D (the DOM's own words, bending with the paper), so the DOM's goes (opacity, not display: the
   gesture keeps its pointer and the focus stays): it cross-fades with the 3D's ink as a turn begins and as it lands, its
   opacity set in the engine's own frame (--nb-dom, page-turn2 21 Oct: switched in one frame, the titles stepped) */
.sfw-nb .nb-turn, .sfw-nb .nb-grab, .sfw-nb.is-on a { touch-action: none; }
.sfw-nb .nb-leaf, .sfw-nb .nb-turn { opacity: var(--nb-dom, 1); }
.sfw-nb.is-turning a { pointer-events: none; }
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
      s.textContent = RESTYLE ? withoutRepeatedFaces(CSS) : CSS;
      document.head.appendChild(s);
    }
    // the right-hand page (the first page, and the front of each leaf after it)
    this.el = document.createElement("div");
    this.el.className = "sfw-nb";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", room.spots.notebook?.label || "");
    this.el.inert = true;
    parent.appendChild(this.el);
    this.surface = new Surface(this.el, () => room.objects.notebook_page?.quad, { oversample: 2 });
    // A book's spread (page-turn2): with the 3D turn, the notebook is two pages: the right page's leaf turns over onto
    // the left, the left page's back. The writing is on the right-hand pages only (BOTH_SIDES false): page 1 on the
    // right; turned, its leaf's blank back on the left and page 2 on the right. The left-hand page is its own layer on
    // the turned leaves, over the cover's inside, as the cover lies (it follows it as it moves): the way back (its outer
    // part and its corner), and with BOTH_SIDES the list's even pages. Without the 3D turn (no page in the model), one
    // page at a time on the right, as before.
    this.spreadMode = !!(pages && room.objects.notebook_cover?.pivot);
    this.both = this.spreadMode && BOTH_SIDES;
    if (this.spreadMode) pages.recto = !this.both;
    this.leaf = 0;               // the spread: how many leaves lie turned on the left
    this.sides = [];             // the pages of writing, in order: even ones a leaf's front (right), odd ones its back (left)
    this.posts = [];
    this.shown = false;
    this.ready = (async () => {
      this.posts = await reader.index();
      await Promise.race([Promise.all(['500 20px "Cormorant Garamond"'].map((f) => document.fonts?.load(f))), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
      return this;
    })();
    if (this.spreadMode) {
      this.left = document.createElement("div");
      this.left.className = "sfw-nb sfw-nb-left";
      this.left.setAttribute("role", "group");
      this.left.setAttribute("aria-label", room.spots.notebook?.label || "");
      this.left.inert = true;
      parent.appendChild(this.left);
      this.leftQuad = null;
      this.leftSurface = new Surface(this.left, () => this.leftQuad, { oversample: 2 });
      this.pages.onDom((e) => this.turnDom(e));
    }
    for (const root of this.roots()) {
      root.addEventListener("click", (e) => this.onClick(e));
      root.addEventListener("pointerover", (e) => { const a = e.target.closest?.("a[data-slug]"); if (a) reader.prefetch(a.dataset.slug); });
      root.addEventListener("focusin", (e) => { const a = e.target.closest?.("a[data-slug]"); if (a) reader.prefetch(a.dataset.slug); });
      root.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "PageDown") { if (this.turn(1)) e.preventDefault(); }
        if (e.key === "ArrowLeft" || e.key === "PageUp") { if (this.turn(-1)) e.preventDefault(); }
      });
      if (this.spreadMode) root.addEventListener("pointerdown", (e) => this.onDown(e));
    }
  }

  roots() { return this.left ? [this.left, this.el] : [this.el]; }

  // The layout box: the page's size on screen at the notebook's rest pose (x 2: drawn through a perspective, it stays
  // crisp); the type follows the page's width; the essays flow onto as many pages as they need. The left-hand page has
  // the very same box (its words laid out exactly as they were measured).
  layout(pose, w, h) {
    const before = this.surface.box.join("x");
    const [bw, bh] = this.surface.layout(pose, w, h);
    if (this.left) {
      this.leftSurface.box = [bw, bh];
      this.left.style.width = `${bw}px`;
      this.left.style.height = `${bh}px`;
      // (the left-hand page first in the tab order: a book reads left, then right)
      if (this.el.previousElementSibling !== this.left && this.el.parentNode) this.el.before(this.left);
      this.updateLeftQuad();
      const q = this.leftQuad?.map((p) => project(pose, p, w, h));
      this.hasLeft = !!q && q.every((p) => p && p[0] >= -2 && p[0] <= w + 2 && p[1] >= -2 && p[1] <= h + 2);
    }
    if (!bw || (this.builtFor === this.posts.length && this.surface.box.join("x") === before)) return;
    this.builtFor = this.posts.length;
    // (about 26 px a title at 1440 x 900, 22 before the entries were made 20 % bigger; never under 14.5 px on screen:
    // the box is drawn at half its size)
    const fs = `${Math.max(bw * 0.041 * ENTRY, 29).toFixed(2)}px`;
    for (const r of this.roots()) r.style.fontSize = fs;
    this.build();
  }

  build() {
    const keep = this.leaf;
    for (const r of this.roots()) r.replaceChildren();
    this.sides = [];
    const grab = (root) => { const g = document.createElement("div"); g.className = "nb-grab"; g.setAttribute("aria-hidden", "true"); root.appendChild(g); return g; };
    this.grabR = grab(this.el);
    this.grabL = this.left ? grab(this.left) : null;
    const mk = () => {
      const side = document.createElement("div");
      side.className = "nb-leaf";
      const ol = document.createElement("ol");
      side.appendChild(ol);
      this.el.appendChild(side);
      this.sides.push(side);
      return ol;
    };
    const items = this.posts.map((p) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `/writing/${p.slug}`;
      a.dataset.slug = p.slug;
      a.draggable = false;   // (a mouse drag from a title turns the page, never drags its address)
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
    const room = (side) => side.clientHeight - parseFloat(getComputedStyle(side).paddingBottom);
    const reset = () => { for (const sd of this.sides) sd.remove(); this.sides = []; };
    // Four essays to a page (Akshay, 20 Oct: "just show 4 writings at a time"; 11 essays: 4 + 4 + 3), when four fit on
    // a page at this type size (their titles end before 93 % of its room)
    const fourUp = () => { reset(); for (let i = 0; i < items.length; i += PER_PAGE) mk().append(...items.slice(i, i + PER_PAGE)); };
    const fits = () => this.sides.every((sd) => { const li = sd.querySelector("ol").lastElementChild; return !li || li.offsetTop + li.offsetHeight <= room(sd) * 0.93; });
    // (where they do not, the space between essays a little less; where still not, the type stays at its size and the
    // pages hold as many as fit, and fit.need records the size four would need: the coordinator's call)
    const tight = (on) => { for (const r of this.roots()) r.classList.toggle("nb-tight", on); };
    tight(false);
    fourUp();
    let ok = fits();
    if (!ok) { tight(true); fourUp(); ok = fits(); }
    const fs0 = parseFloat(this.el.style.fontSize) || parseFloat(getComputedStyle(this.el).fontSize);
    this.fit = { per: PER_PAGE, fits: ok, tight: ok && this.el.classList.contains("nb-tight"), font: +(fs0 / 2).toFixed(2), need: null };
    if (!ok) {
      // the type size four would need (screen px at the rest pose: the box is drawn at half its size), with the closer
      // spacing
      let lo = 8, hi = fs0;
      for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; this.el.style.fontSize = `${mid}px`; fourUp(); if (fits()) lo = mid; else hi = mid; }
      this.fit.need = +(lo / 2).toFixed(2);
      if (FORCE4) {
        for (const r of this.roots()) r.style.fontSize = `${lo.toFixed(2)}px`;
        fourUp();
        Object.assign(this.fit, { forced: true, tight: true, font: this.fit.need });
      }
    }
    if (!ok && !FORCE4) {
      tight(false);
      this.el.style.fontSize = `${fs0}px`;
      // at this size, as many as fit: a page at a time, the titles still to place go in together and are measured in
      // one layout; the first after the page's first that ends past 93 % of the page starts the next page (perf #11)
      reset();
      let ol = mk();
      for (let i = 0; i < items.length;) {
        ol.append(...items.slice(i));
        const limit = room(ol.parentElement) * 0.93;
        let j = i + 1;
        while (j < items.length && !(items[j].offsetTop + items[j].offsetHeight > limit)) j++;
        if (j >= items.length) break;
        ol = mk();
        i = j;
      }
      // balanced pages (never one essay alone on the last): the same number of pages, the essays shared out evenly
      if (this.sides.length > 1) {
        const per = Math.ceil(this.posts.length / this.sides.length), all = this.sides.flatMap((l) => [...l.querySelectorAll("li")]);
        this.sides.forEach((l, i) => l.querySelector("ol").replaceChildren(...all.slice(i * per, (i + 1) * per)));
        // (shared out evenly, the last pages may be left with nothing: a book has no empty page of its list)
        while (this.sides.length > 1 && !this.sides[this.sides.length - 1].querySelector("li")) this.sides.pop().remove();
      }
      this.fit.per = Math.max(...this.sides.map((sd) => sd.querySelectorAll("li").length));
    }
    // a leaf's back goes to the left-hand page, its gutter margin mirrored (the same width: the lines break the same)
    if (this.both) this.sides.forEach((side, i) => { if (i % 2) { side.classList.add("verso"); this.left.appendChild(side); } });
    // the hints: the right page's outer corner (next), the left page's (back); without the 3D turn both on the right
    const corner = (root, dir) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `nb-turn ${dir > 0 ? "next" : "prev"}`;
      b.setAttribute("aria-label", dir > 0 ? "Next page" : "Previous page");
      // (a pointer's press is the page's gesture, onDown; this is the keyboard's Enter or Space, or the DOM's turn)
      b.addEventListener("click", (e) => { e.stopPropagation(); if (this.spreadMode && e.detail !== 0) return; if (!this.swallowClick()) this.turn(dir); });
      root.appendChild(b);
      return b;
    };
    this.nextCorner = corner(this.el, 1);
    this.prevCorner = corner(this.left || this.el, -1);
    this.leaf = Math.max(0, Math.min(keep, this.spreads() - 1));
    this.show();
    // the 3D turn's ink: the words as laid out now, drawn into its atlas while the page is idle (not in a turn's frame)
    if (this.pages) {
      this.pages.setLeaf(this.leaf, { reduced: this.reduced() });
      this.inkFor = null;
      this.inkJob = null;   // (DYS-149: steps under way were for the layout before)
      clearTimeout(this.inkT);
      const draw = () => { this.inkT = null; if (INK_SPLIT === "0") this.ensureInk(); else this.inkSteps(); };
      this.inkT = setTimeout(() => (typeof requestIdleCallback === "function" ? requestIdleCallback(draw, { timeout: 1500 }) : draw()), 120);
    }
  }

  // how many spreads (resting places) the pages make: 1 + the turns forward from the first
  spreads() { const n = this.sides.length; return this.both ? Math.max(1, Math.ceil((n + 1) / 2)) : Math.max(1, n); }
  // can the leaf turn that way from here? forward: when there is a page to read on its back; back: when one lies turned
  canTurn(dir) {
    const s = this.leaf, n = this.sides.length;
    return dir > 0 ? (this.both ? 2 * s + 1 < n : s + 1 < n) : s >= 1;
  }
  // the pages on show at spread s: [left, right] (either null)
  sidesAt(s = this.leaf) {
    return this.both ? [this.sides[2 * s - 1] || null, this.sides[2 * s] || null] : [null, this.sides[s] || null];
  }
  // the spread on the page: its two pages, its hints and the outer parts that turn
  show() {
    const on = new Set(this.sidesAt().filter(Boolean));
    this.sides.forEach((el) => { el.hidden = !on.has(el); });
    const next = this.canTurn(1), prev = this.canTurn(-1);
    if (this.nextCorner) this.nextCorner.hidden = !next;
    if (this.prevCorner) this.prevCorner.hidden = !prev;
    if (this.grabR) this.grabR.hidden = !(this.spreadMode && next);
    if (this.grabL) this.grabL.hidden = !prev;
    this.updateLeft();
  }

  // ---------------------------------------------------------------- the 3D page turn (pageturn.js)
  // The words of every page, where the DOM puts them (each in its own page's box), in the turn's ink atlas (once per
  // layout): slot i is page i.
  ensureInk() {
    if (!this.pages || !this.sides.length) return false;
    if (this.inkFor !== this.sides) {
      try {
        if (INK_SPLIT !== "0") {
          // (DYS-149: the ink needed now, a turn: the steps still to go for this layout, or all of them, in this task;
          // in one task the layout cannot change between two of them)
          const job = this.inkJob?.sides === this.sides ? this.inkJob : this.inkWork();
          this.inkHow = job === this.inkJob ? "steps, the rest in one task (needed at once)" : this.inkHow === "moving" ? "one task (still moving)" : "one task (needed at once)";
          this.inkJob = null;
          try { while (!job.it.next().done); } catch (err) {
            if (err?.message !== "moved") throw err;
            const again = this.inkWork();
            while (!again.it.next().done);
          }
        } else {
          const R = measureLeaves(this.el, this.sides.filter((_, i) => !(this.both && i % 2)));
          const L = this.both ? measureLeaves(this.left, this.sides.filter((_, i) => i % 2)) : null;
          const leaves = this.sides.map((_, i) => (L && i % 2 ? L.leaves[(i - 1) / 2] : R.leaves[L ? i / 2 : i]));
          this.pages.setAtlas({ w: R.w, h: R.h, leaves });
          this.inkFor = this.sides;
        }
      } catch (err) { console.warn("[pageturn] ink", err); return false; }
    }
    return this.pages.ready;
  }
  // (DYS-149) ensureInk's work as steps, { sides, it } (a generator): each leaf measured in a step of its own
  // (measureLeafSteps), then each page's words drawn into the atlas and handed to the GPU process, a page a step, then
  // the upload (atlasSteps). The same numbers and the same atlas as ensureInk's one task. A web font done loading while
  // it measured throws "moved", as a box that moved does (measure again)
  inkWork() {
    const nb = this, sides = this.sides, both = this.both, f0 = fontGen;
    function* work() {
      const R = yield* measureLeafSteps(nb.el, sides.filter((_, i) => !(both && i % 2)));
      const L = both ? yield* measureLeafSteps(nb.left, sides.filter((_, i) => i % 2)) : null;
      if (fontGen !== f0) throw new Error("moved");
      const leaves = sides.map((_, i) => (L && i % 2 ? L.leaves[(i - 1) / 2] : R.leaves[L ? i / 2 : i]));
      const measured = { w: R.w, h: R.h, leaves };
      yield* nb.pages.atlasSteps(measured);
      nb.inkFor = sides;
      if (INK_SPLIT === "check") nb.inkCheck(measured);
    }
    return { sides, it: work() };
  }
  // (DYS-149) The ink while the page is idle, a step a task, each just after a frame is drawn (a page measured, a page's
  // words drawn: a few ms each where the whole was one 64-100 ms task on the slow laptop: 48 forced layouts, then every
  // page's words played into the canvas inside the texture's upload). A new layout drops the steps (its own come); a
  // turn meanwhile does the rest in its task (ensureInk); a box that moved between two steps starts them again (three
  // times; then in one task)
  inkSteps(tries = 0) {
    if (!this.pages || !this.sides.length || this.inkFor === this.sides || this.inkJob?.sides === this.sides) return;
    const job = (this.inkJob = this.inkWork());
    this.inkHow = "steps";
    const step = () => {
      if (this.inkJob !== job) return;
      try {
        if (job.it.next().done) { this.inkJob = null; return; }
      } catch (err) {
        this.inkJob = null;
        if (err?.message !== "moved") console.warn("[pageturn] ink", err);
        else if (tries < 3) afterFrame(() => this.inkSteps(tries + 1));
        else { this.inkHow = "moving"; this.ensureInk(); }   // (still moving: in one task, as before)
        return;
      }
      afterFrame(step);
    };
    step();
  }
  // (DYS-149, ?inksplit=check) The steps' ink against ensureInk's one-task way on this same layout: the words (measureLeaves)
  // and the atlas's pixels (drawAtlas on a canvas of its own). The console's "inksplit check" and window.__sfwInkCheck
  inkCheck(measured) {
    try {
      const R = measureLeaves(this.el, this.sides.filter((_, i) => !(this.both && i % 2)));
      const L = this.both ? measureLeaves(this.left, this.sides.filter((_, i) => i % 2)) : null;
      const leaves = this.sides.map((_, i) => (L && i % 2 ? L.leaves[(i - 1) / 2] : R.leaves[L ? i / 2 : i]));
      const words = JSON.stringify({ w: R.w, h: R.h, leaves }) === JSON.stringify(measured);
      const ref = document.createElement("canvas");
      drawAtlas(ref, { w: R.w, h: R.h, leaves });
      const ink = this.pages.inkCanvas;
      const px = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const a = px(ink), b = px(ref);
      let differ = a.length === b.length ? 0 : -1;
      if (!differ) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
      const r = { words, perPage: measured.leaves.map((l) => l.length), size: `${ink.width}x${ink.height}`, ref: `${ref.width}x${ref.height}`, bytesDiffer: differ, how: this.inkHow, flush: this.pages.inkFlush };
      window.__sfwInkCheck = r;
      console.info(`[notebook] DYS-149 inksplit check ${JSON.stringify(r)}`);
    } catch (err) { console.warn("[notebook] inksplit check", err); }
  }
  // a click right after a drag (or a tap the gesture already turned with) is the same gesture: swallowed
  swallowClick() {
    if (!this.swallowUntil || performance.now() > this.swallowUntil) return false;
    this.swallowUntil = 0;
    return true;
  }
  // where a pointer is on the spread: { side: 1 the right page, -1 the left, u, v, frac (0 the spine, 1 the outer edge) }
  pickAt(x, y) {
    const r = this.el.parentElement?.getBoundingClientRect();
    if (!r || !this.lastPose || !this.pages) return null;
    const rr = ray(this.lastPose, x - r.left, y - r.top, this.lastW, this.lastH), hit = this.pages.pick(rr);
    return hit && { ...hit, ray: rr };
  }
  // A press on a page (Apple Books): on its outer part (or its corner) it may become a drag that turns the leaf, a tap
  // that turns it (near the outer edge) or a tap on a title (the title's own click). Moving 5 px (mouse) or 10 px (a
  // finger) toward the spine starts the drag; another way first, nothing (the click after it is swallowed).
  onDown(e) {
    if (!this.pages || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || !this.lastPose) return;
    if (!this.el.classList.contains("is-on")) return;
    const corner = e.target.closest?.(".nb-turn"), grab = e.target.closest?.(".nb-grab"), link = e.target.closest?.("a[data-slug]");
    if (!corner && !grab && !link) return;
    // (a press on a page while a leaf turns, or a second finger: the page's, never the room's look-around)
    if (this.turning || this.gest) { if (corner || grab) { e.stopPropagation(); e.preventDefault(); } return; }
    const hit = this.pickAt(e.clientX, e.clientY);
    if (!hit) return;
    const dir = hit.side;
    // (a title on the inner part of a page is a title only; the room's own drag and tap stay as they were there)
    if (!corner && hit.frac < GRAB_ZONE) return;
    if (!this.canTurn(dir)) return;
    e.stopPropagation();
    if (!link) e.preventDefault();
    const g = (this.gest = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, t: performance.now(), dir, hit, link, corner, mode: "pending" });
    g.move = (ev) => this.onMove(ev);
    g.up = (ev) => this.onUp(ev);
    addEventListener("pointermove", g.move, true);
    addEventListener("pointerup", g.up, true);
    addEventListener("pointercancel", g.up, true);
  }
  onMove(ev) {
    const g = this.gest;
    if (!g || ev.pointerId !== g.id) return;
    if (g.mode === "drag") { this.dragTo(ev); return; }
    if (g.mode !== "pending") return;
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y, slop = g.type === "mouse" ? 5 : 10;
    if (Math.hypot(dx, dy) < slop) return;
    const toward = -g.dir * dx;   // px toward the spine (the right page's is to its left)
    if (!(toward >= 0.75 * slop && toward >= 0.5 * Math.abs(dy)) || !this.canTurn(g.dir)) { g.mode = "dead"; return; }
    if (this.reduced() || !this.ensureInk()) { g.mode = "dead"; this.turn(g.dir); return; }   // (reduced motion: its fade)
    if (!this.pages.start(g.dir, { leaf: this.leaf, sides: this.sides.length, drag: true, grab: [g.hit.u, g.hit.v], ray: g.hit.ray, t0: g.t })) { g.mode = "dead"; return; }
    g.mode = "drag";
    this.turning = true;
    this.drag = g;
    for (const r of this.roots()) r.classList.add("is-dragging");
    try { (g.dir > 0 ? this.grabR : this.grabL)?.setPointerCapture(g.id); } catch { /* the window's listeners still see it */ }
    this.dragTo(ev);
  }
  onUp(ev) {
    const g = this.gest;
    if (!g || ev.pointerId !== g.id) return;
    this.gest = null;
    removeEventListener("pointermove", g.move, true);
    removeEventListener("pointerup", g.up, true);
    removeEventListener("pointercancel", g.up, true);
    if (g.mode === "drag") { this.letGo(ev.type === "pointercancel"); return; }
    const now = performance.now();
    if (g.mode === "dead" || ev.type === "pointercancel") { this.swallowUntil = now + 400; return; }
    // a tap: a title opens (its own click follows, held long or not); near the outer edge, or on the corner, a quick tap
    // turns the leaf by itself
    if (g.link || now - g.t > 500) return;
    if (g.corner || g.hit.frac >= TAP_ZONE) { this.swallowUntil = now + 400; this.lastRelease = { tap: true, cancel: false, complete: this.turn(g.dir) }; }
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
    for (const r of this.roots()) r.classList.remove("is-dragging");
    this.lastRelease = { tap: false, cancel, complete: !!this.pages.release({ back: cancel }) };
    this.swallowUntil = performance.now() + 400;
  }
  // a gesture still pending or dragging is dropped (leaving the notebook)
  dropGesture() {
    const g = this.gest;
    if (!g) return;
    this.gest = null;
    removeEventListener("pointermove", g.move, true);
    removeEventListener("pointerup", g.up, true);
    removeEventListener("pointercancel", g.up, true);
    if (g.mode === "drag") this.letGo(true);
  }
  // the DOM's ink hands over to the 3D's (and back) in a short cross-fade, set in the engine's own frame: "start" (the DOM's
  // words then fade out), "end" (the next spread, its words fading in from nothing), "fade" (their opacity now)
  turnDom(e) {
    if (e.type === "fade") { for (const r of this.roots()) r.style.setProperty("--nb-dom", String(e.o)); return; }
    if (e.type === "start") {
      this.focusIn = this.roots().some((r) => r.contains(document.activeElement));
      for (const r of this.roots()) r.classList.add("is-turning");
      this.turning = true;
      return;
    }
    this.leaf = e.leaf;
    if (e.fade) for (const r of this.roots()) r.style.setProperty("--nb-dom", "0");
    for (const r of this.roots()) r.classList.remove("is-turning");
    this.turning = false;
    this.show();
    if (this.focusIn && !this.drag) this.first()?.focus({ preventScroll: true });
  }
  // the left-hand page lies on the turned leaves, over the cover's inside as it lies now
  updateLeftQuad() {
    if (!this.left || !this.pages) return;
    const L = this.pages.frames().left, at = (u, v) => [0, 1, 2].map((i) => L.O[i] + u * L.X[i] + v * L.Y[i]);
    this.leftQuad = [at(LEAF.x1, LEAF.h), at(LEAF.x0, LEAF.h), at(LEAF.x0, -LEAF.h), at(LEAF.x1, -LEAF.h)];
  }
  // the left-hand page: shown with a leaf turned (or while one fades away), with the page's ink
  updateLeft() {
    if (!this.left) return;
    const on = !!(this.shown && (this.leaf > 0 || this.fadingLeft));
    this.left.style.visibility = on ? "visible" : "hidden";
    this.left.style.opacity = String(this.inkLevel);
  }

  // A turn (the arrow keys, a tap near the outer edge, Enter on a corner): the 3D leaf turns by itself (pageturn.js);
  // reduced motion (or no 3D turn): the spread cross-fades to the next one in 150 ms.
  turn(dir) {
    if (!this.canTurn(dir) || this.turning) return false;
    if (this.pages && !this.reduced() && this.ensureInk()) {
      if (!this.pages.start(dir, { leaf: this.leaf, sides: this.sides.length })) return false;
      this.turning = true;   // (turnDom shows the next spread when it lands)
      return true;
    }
    const before = this.sidesAt().filter(Boolean), had = this.leaf > 0;
    this.leaf += dir;
    const after = this.sidesAt().filter(Boolean);
    const ms = this.reduced() ? 150 : 220;
    this.turning = true;
    this.fadingLeft = had;
    // (the turned leaves lie on the cover's inside at once: the left page's words come in on paper)
    this.pages?.setLeaf(this.leaf, { reduced: true });
    const outs = before.filter((x) => !after.includes(x)).map((x) => x.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: "forwards" }));
    const ins = after.filter((x) => !before.includes(x)).map((x) => { x.hidden = false; return x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms }); });
    this.updateLeft();
    const focusIn = this.roots().some((r) => r.contains(document.activeElement));
    Promise.all([...outs, ...ins].map((a) => a.finished)).catch(() => {}).then(() => {
      for (const a of outs) a.cancel();
      this.turning = false;
      this.fadingLeft = false;
      this.show();
      if (focusIn) this.first()?.focus({ preventScroll: true });
    });
    return true;
  }

  onClick(e) {
    const a = e.target.closest?.("a[data-slug]");
    if (!a || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.swallowClick() || this.turning) return;
    this.lastSide = this.left?.contains(a) ? -1 : 1;
    this.onTitle?.(a.dataset.slug, a);
  }

  place(pose, w, h, opts = {}) {
    this.lastPose = pose; this.lastW = w; this.lastH = h;   // (a drag's pointer is read through this pose: rig.js ray)
    if (this.left) { this.updateLeftQuad(); this.leftSurface.place(pose, w, h, { still: opts.still }); this.updateLeft(); }
    return this.surface.place(pose, w, h, opts);
  }
  // the page a title was opened from (the reading sheet rises from it and returns into it)
  rect(pose, w, h) { return (this.lastSide === -1 && this.left && this.leaf > 0 ? this.leftSurface : this.surface).rect(pose, w, h); }

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
  // The first time the notebook lies open in a visit (and there is a next page), its corner lifts once by itself.
  hint() {
    if (this.hinted || this.reduced() || this.leaf !== 0 || !this.canTurn(1)) return;
    this.hinted = true;
    try { if (sessionStorage.getItem("sfw-nb-peek")) return; sessionStorage.setItem("sfw-nb-peek", "1"); } catch { /* storage blocked: once per page */ }
    clearTimeout(this.hintT);
    this.hintT = setTimeout(() => {
      const b = this.nextCorner;
      if (!b || b.hidden || this.turning || !this.el.classList.contains("is-on")) return;
      b.classList.add("peek");
      b.addEventListener("animationend", () => b.classList.remove("peek"), { once: true });
    }, 650);
  }
  setActive(on) {
    for (const r of this.roots()) { r.inert = !on; r.classList.toggle("is-on", on); }
    // leaving mid-turn: the leaf lands (or falls back) at once
    if (!on) this.dropGesture();
    if (!on && this.turning && this.pages?.busy) this.pages.finishNow();
  }
  // the first title of the spread, as a book reads (the left-hand page first)
  first() {
    for (const s of this.sidesAt()) { const a = s?.querySelector("a[data-slug]"); if (a) return a; }
    return null;
  }
  linkFor(slug) { return /^[a-z0-9-]+$/.test(slug) ? this.roots().map((r) => r.querySelector(`a[data-slug="${slug}"]`)).find(Boolean) || null : null; }
  // the spread that shows an essay (a deep link's sheet returns into its page)
  showSlug(slug) {
    const i = this.sides.findIndex((l) => l.querySelector(`a[data-slug="${slug}"]`));
    if (i < 0 || this.turning) return;
    const s = this.both ? Math.ceil(i / 2) : i;
    this.lastSide = this.both && i % 2 ? -1 : 1;
    if (s === this.leaf) return;
    this.leaf = s;
    this.show();
    this.pages?.setLeaf(s, { reduced: this.reduced() });
  }
}

// the page's four corners projected (for a reader's lift: its bounding box)
export function pageCorners(room, pose, w, h) {
  const q = room.objects.notebook_page?.quad;
  if (!q) return null;
  const P = q.map((p) => project(pose, p, w, h));
  return P.some((p) => !p) ? null : P;
}

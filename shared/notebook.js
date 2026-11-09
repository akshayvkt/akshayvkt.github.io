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
import { createPageTurn, drainSteps, drawAtlas, GRAB_ZONE, LEAF, leafReads, measureLeafSteps, measureLeaves, pageTriangles, pageTriangleSteps, sheetGridSteps, TAP_ZONE, turnUniforms, TURN_FS } from "./pageturn.js";
import { withoutRepeatedFaces, RESTYLE } from "./faces.js";
import { JSLEAN, leanText } from "./sky.js";

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
// (DYS-205 elastic-edge, Akshay's iPhone 31 Oct, the open notebook at rest: the elastic's edge beside the right page a
// dashed dark line) The elastic (part_notebook_elastic) is a 6 x 1 mm band in a loop round the closed notebook; open, it
// has slipped SLIP and lies 3.9 mm past the page's fore edge and 2.7-3.7 mm above it, over the desk (the strip of desk
// between the two is the model's own gap). Its inner side (toward the spine), 0.66-1 mm high, faces the camera: on a
// phone's room buffer (2 px a CSS px) a sliver ~0.5-0.9 px across, baked darker than the band's top (its light-map
// chart a texel across, the top's 4). Refining (loop.js jitter: Cycles' 1.5 px Blackman-Harris, ~0.2 px sd) keeps a
// line that thin where it crosses a pixel's middle and loses it between: dashes, one every ~7 rows (the band's slant on
// screen), however many samples. Once the elastic moves, the side takes the light, the detail and the normal of the
// band's outer face at its edge (elasticSides): the band one colour to its edge, an edge like the page's (closed, on
// the cover, as before). ?elasticaa=0: as before
const ELASTIC_AA = (() => { try { return new URLSearchParams(location.search).get("elasticaa") !== "0"; } catch { return true; } })();

// The elastic's inner side, vertex by vertex, with the vertex of the band's outer face whose light it takes: the nearest
// across the band's loop (the hinge frame's spine-and-up plane) at the same edge (within 1 mm across the band). p(i),
// n(i): a vertex's room position [x, y, z] (m) and unit normal; X across the cover toward the fore edge, Y the spine
// toward the head ([x, y, z], unit). Returns [[side, source], ...] (pure: scripts/live/nb_elastic_edge_test.mjs tests it)
export function elasticSides(count, p, n, X, Y) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const v = [];
  let y0 = Infinity, y1 = -Infinity, u0 = Infinity, u1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const P = p(i), N = n(i);
    const o = { x: dot(P, X), y: dot(P, Y), u: P[1], nx: dot(N, X), ny: dot(N, Y), nu: N[1] };
    v.push(o);
    y0 = Math.min(y0, o.y); y1 = Math.max(y1, o.y); u0 = Math.min(u0, o.u); u1 = Math.max(u1, o.u);
  }
  // the loop's middle; the outer face: across the band's loop (not its sides), facing away from that middle
  const cy = (y0 + y1) / 2, cu = (u0 + u1) / 2;
  const outer = [];
  v.forEach((o, i) => { if (Math.abs(o.nx) < 0.5 && o.ny * (o.y - cy) + o.nu * (o.u - cu) > 0) outer.push(i); });
  const pairs = [];
  v.forEach((o, i) => {
    if (o.nx > -0.9) return;
    let best = -1, d = 0.002 * 0.002;
    for (const j of outer) {
      const q = v[j];
      if (Math.abs(q.x - o.x) > 0.001) continue;
      const dj = (q.y - o.y) * (q.y - o.y) + (q.u - o.u) * (q.u - o.u);
      if (dj < d) { d = dj; best = j; }
    }
    if (best >= 0) pairs.push([i, best]);
  });
  return pairs;
}

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

/**
 * The notebook's shader code added to one room material's fragment text (after gl/interact.js's). False (the material
 * left as it is) where its anchor is missing. (DYS-216, ?roomearly=1: gl/room-early.js adds it to its stand-ins with this
 * same function, so their programs' text is the room's own)
 */
export function notebookShaderText(m) {
  const fs = insertBefore(m.fragmentShader, "void main()", FS_BLOCK);
  const call = "Lb = sfwBook(Lb, P, Ng);   // stream I";
  const anchor = fs && fs.includes(call) ? call : "Lb *= detail;";
  if (!fs || !fs.includes(anchor)) return false;
  m.fragmentShader = fs.replace(anchor, `${anchor}\n    sfwNotebook(Lb, sunL, lampL, P, Ng);   // interactions B`);
  return true;
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

  // ---- the elastic's inner side lit as the band's outer face once the elastic has moved (DYS-205 elastic-edge:
  // ELASTIC_AA, elasticSides): on the closed cover, dark on dark, it stays as the model has it; from the elastic's first
  // move on (st.e above 0, apply) the side's vertices take their sources' normal, light uv and detail uv, the values as
  // stored, and theirs again once it is back closed. Its shape, and every other vertex, as they were
  const sides = { elastic: 0, lit: false, set: null };
  if (elastic && ELASTIC_AA) {
    const v = new THREE.Vector3(), n = new THREE.Vector3(), swaps = [];
    // (an attribute's own array, its stride and offset: the values as stored, interleaved or not)
    const raw = (a) => (a.isInterleavedBufferAttribute ? [a.data.array, a.data.stride, a.offset] : [a.array, a.itemSize, 0]);
    elastic.traverse((m) => {
      const g = m.isMesh ? m.geometry : null, pos = g?.attributes.position, nrm = g?.attributes.normal;
      if (!pos || !nrm) return;
      m.updateWorldMatrix(true, false);
      const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
      const pairs = elasticSides(pos.count, (i) => v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).toArray(),
        (i) => n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize().toArray(), X.toArray(), Y.toArray());
      if (!pairs.length) return;
      for (const name of ["normal", "uv1", "uv2"]) {
        const a = g.attributes[name];
        if (!a) continue;
        const [arr, s, o] = raw(a), was = [], to = [];
        for (const [i, j] of pairs) for (let k = 0; k < a.itemSize; k++) { was.push(arr[i * s + o + k]); to.push(arr[j * s + o + k]); }
        swaps.push({ a, pairs, was, to });
      }
      sides.elastic += pairs.length;
    });
    sides.set = (on) => {
      for (const { a, pairs, was, to } of swaps) {
        const [arr, s, o] = raw(a), src = on ? to : was;
        let q = 0;
        for (const [i] of pairs) for (let k = 0; k < a.itemSize; k++) arr[i * s + o + k] = src[q++];
        a.needsUpdate = true;
      }
      sides.lit = on;
    };
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
      if (!notebookShaderText(m)) { patched.missing.push(m.name); continue; }
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
  const makePages = (page = null, grid = null) => {
    if (!turnArgs) return null;
    try { pages = createPageTurn(engine, { ...turnArgs, page, grid }); }
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
    if (sides.set && (st.e > 0) !== sides.lit) sides.set(st.e > 0);   // (DYS-205 elastic-edge)
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
    chart, patched, pageY, pages, sides,
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
    // (DYS-216 late-chunk, the router's runLate: `budget` ms: the triangles and then the sheets' grid in steps of that much
    // work, `pause` between them (pageturn.js drainSteps; BL2, Chrome CPU 6x: tasks of 25-35 and 47-52 ms); without it
    // two tasks as before)
    nb.addPages = (pause, { budget = 0 } = {}) => added || (added = (async () => {
      if (!turnArgs) return null;
      let page, grid = null;
      try { page = budget > 0 ? await drainSteps(pageTriangleSteps(engine, turnArgs), pause, budget) : pageTriangles(engine, turnArgs); } catch (err) { console.warn("[pageturn]", err); return null; }
      await pause?.();
      if (budget > 0 && page.tris.length) {
        try { grid = await drainSteps(sheetGridSteps({ ...turnArgs, page }), pause, budget); } catch (err) { console.warn("[pageturn] grid", err); grid = null; }
        await pause?.();
      }
      return makePages(page, grid);
    })());
  }
  return nb;
}

// ------------------------------------------------------------------ the index: a book's pages across the spread
// (DYS-216 D, ?jslean=1: made at its first use, and an essay's date from sky.js leanText while its rule holds, so the index
// built with the room calls no Intl; without it, made here as before)
const DATE_FMT = () => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
let DATE = JSLEAN ? null : DATE_FMT();
export const essayDate = (at) => leanText("date", at) ?? (DATE ??= DATE_FMT()).format(at);   // "Oct 21, 2026"
const PER_PAGE = 4;   // essays on a page (Akshay, 20 Oct: "just show 4 writings at a time")
// Each essay's entry 20 % bigger (Akshay, 21 Oct: the titles and dates, and the space between entries, so the four fill
// more of the page): one factor on the type, which every size and space of an entry follows (em); the page's margins stay.
// Where the type is at its floor (phones), it stays there: the floor is the size it may not go under, not this factor's.
const ENTRY = 1.2;
// The writing on the right-hand pages only (Akshay, 20 Oct: "i want content only on one side of the book pages - the right
// side"): a leaf's back, the left page once it is turned, is blank paper (its front's ink faintly through it). false: the
// list runs across both pages of a spread, as a printed book's.
const BOTH_SIDES = false;
// The type's floor, box px (14.5 px on screen: the box is drawn at half its size): a page this small is a phone's.
const FLOOR = 29;
// (DYS-197, Akshay 31 Oct, his iPhone upright: the third entry's date hung below the page's bottom edge; "if we can ensure
// the 3 items with their dates always fit in the page that'd be nice!") Where the type is at its floor (a phone's page,
// either way up) or four don't fit: three a page, every page of three inside its room (the build's own 93 % rule). Where
// a page of three doesn't fit at the type's size: the titles' lines as close as their style asks (nb-snug), then the space
// between entries a little less (nb-tight), then the type a little smaller, never under THREE_MIN (box px; 12.5 px).
const PER_PHONE = 3;
const THREE_MIN = 25;
// ?nb4 (for trying it on a phone): four a page on any screen, the type as small as that needs (below its 14.5 px floor)
const FORCE4 = (() => { try { return new URLSearchParams(location.search).has("nb4"); } catch { return false; } })();
// (DYS-149) The 3D turn's ink a page a task (inkSteps), not in one: on the slow laptop it was one 64-100 ms task after the
// room is shown. ?inksplit=0: in one task, as before; ?inksplit=check: a page a task, then both ways compared (the
// console's "inksplit check", window.__sfwInkCheck)
const INK_SPLIT = (() => { try { return new URLSearchParams(location.search).get("inksplit") ?? "1"; } catch { return "1"; } })();
// (DYS-149 TF1, the phone's first frames of a turn) the hand-over's cross-fade as each page root's own opacity (the ink's
// level times the DOM's share): the root is a composited layer already (its matrix3d), so a fade frame is one element's
// opacity, no restyle of the words and no repaint, and while the leaf turns (the DOM's share 0) the root is not drawn at
// all. The leaves' --nb-dom before: every word inherits it (each fade frame restyled the spread, ~20 elements), and an
// opacity on a leaf inside the root is painted into it (WebKit: both pages repainted each frame of the fade, the first 2-3
// of the turn on the iPhone). ?domfade=leaf: the leaves' --nb-dom, as before
const DOM_FADE_ROOT = (() => { try { return new URLSearchParams(location.search).get("domfade") !== "leaf"; } catch { return true; } })();
// (DYS-149 close-fits: Chrome phone-mid J8's close-essay, restore()'s nb.build() as the page lands: 31 style/layouts,
// 16-58 ms in one task, fits() over trial pages: four a page, tighter, the size four would need in 9 halvings, three a
// page, snug, tight) a build whose measurement can only come out as one before it (the same page box, starting type
// size, root classes, essays and the notebook's face loaded: fitKey) puts the essays on the pages that one chose, its
// type size and spacing, with no layout read. ?nbmemo=0: measured every time, as before; ?nbmemo=check: measured every
// time and compared with the remembered pages (nb.memoCheck, the console's "nbmemo check")
const NB_MEMO = (() => { try { return new URLSearchParams(location.search).get("nbmemo") ?? "1"; } catch { return "1"; } })();
// (DYS-170, B 31 Oct) the right-hand page anchored at rest: in a host (.sfw-nb-host) that carries its corner as a 2D
// move, its matrix3d only the tilt from there (surface.js anchored): where a 3D transform is drawn without its
// perspective (Playwright's WebKit as an iPhone 13, the phone on its side) the list's lines started further left each
// until a date was cut off; they now start straight down the page. The same picture elsewhere. ?nbanchor=0: no host,
// as before
const NB_ANCHOR = (() => { try { return new URLSearchParams(location.search).get("nbanchor") !== "0"; } catch { return true; } })();
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
/* (DYS-170) the right-hand page's host: its corner at rest (surface.js anchored); the page's place among the room's
   layers and its multiply are the host's (a blend inside a moved host would only blend with the host) */
.sfw-nb-host { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 1; pointer-events: none; mix-blend-mode: multiply; }
.sfw-nb-host > .sfw-nb { mix-blend-mode: normal; }
.sfw-nb .nb-leaf { position: absolute; inset: 0; box-sizing: border-box; padding: 10% 9% 9% 12%; transform-origin: 0 50%; }
/* a left-hand page (the back of a turned leaf): its gutter margin by the spine, on its right */
.sfw-nb .nb-leaf.verso { padding: 10% 12% 9% 9%; }
.sfw-nb .nb-leaf[hidden] { display: none; }
.sfw-nb ol { list-style: none; margin: 0; padding: 0; }
.sfw-nb li { margin: 0 0 0.6em; }
/* (four to a page where they only fit a little closer: the space between two essays a little less; DYS-197: the list's
   own entries only, not the lists of an essay's page on its leaf, essay-lift.js) */
.sfw-nb.nb-tight .nb-leaf:not(.el-leaf) > ol > li { margin-bottom: 0.45em; }
/* a title is only as wide as its words: a tap on the paper beside a short title is the page's, not the title's */
.sfw-nb a { display: block; width: fit-content; max-width: 100%; color: inherit; text-decoration: none; outline: none; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
.sfw-nb .nb-tt { font-weight: 500; line-height: 1.12; letter-spacing: 0.004em; text-wrap: balance; text-decoration: underline 0.05em transparent; text-underline-offset: 0.16em;
  transition: text-decoration-color 0.2s ease; }
/* (DYS-197) a title's lines 1.12 em apart, as above: on the inline title the line-height can't go under its block's (the
   page's 1.65, style.css), so they stood 1.65 em apart. Only where three a page need it (phones), the desktop's look kept */
.sfw-nb.nb-snug .nb-tt { display: block; }
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
    this.domO = 1;               // (DYS-149 TF1) the DOM's words' share in a turn's hand-over (pageturn.js "fade"; 1 at rest)
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
    this.host = NB_ANCHOR ? document.createElement("div") : null;   // (DYS-170) the page's corner at rest, NB_ANCHOR
    if (this.host) { this.host.className = "sfw-nb-host"; this.host.appendChild(this.el); }
    parent.appendChild(this.outer());
    this.surface = new Surface(this.el, () => room.objects.notebook_page?.quad, { oversample: 2, host: this.host });
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
  // the right-hand page as the room's layers hold it: its host (DYS-170), or the page itself
  outer() { return this.host || this.el; }

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
      const o = this.outer();
      if (o.previousElementSibling !== this.left && o.parentNode) o.before(this.left);
      this.updateLeftQuad();
      const q = this.leftQuad?.map((p) => project(pose, p, w, h));
      this.hasLeft = !!q && q.every((p) => p && p[0] >= -2 && p[0] <= w + 2 && p[1] >= -2 && p[1] <= h + 2);
    }
    if (!bw || (this.builtFor === this.posts.length && this.surface.box.join("x") === before)) return;
    this.builtFor = this.posts.length;
    // (about 26 px a title at 1440 x 900, 22 before the entries were made 20 % bigger; never under 14.5 px on screen:
    // the box is drawn at half its size)
    const fs = `${Math.max(bw * 0.041 * ENTRY, FLOOR).toFixed(2)}px`;
    for (const r of this.roots()) r.style.fontSize = fs;
    this.build();
  }

  // (DYS-149 close-fits) what a build's measurement depends on: the page box and each root's size and own type size as
  // the build starts, as numbers (layout() sets "29.00px", size() "29px"; a three-a-page fit at a smaller type leaves
  // it for the next build to start from), the roots' classes but the spacing ones the build sets itself and the
  // pointer's (is-on, is-turning, is-dragging: pointer-events and cursors only), the notebook's face loaded or not
  // (every rule for it is the one file: here, world.css, reader.css), the essays as listed, the switches; null before a
  // first layout
  fitKey() {
    const rs = this.roots();
    if (!this.surface.box[0] || rs.some((r) => !r.style.fontSize)) return null;
    let face = "none";
    try { if (document.fonts?.check) face = String(document.fonts.check('500 20px "Cormorant Garamond"')); } catch { face = "?"; }
    const cls = (r) => [...r.classList].filter((c) => !/^(nb-tight|nb-snug|is-on|is-turning|is-dragging)$/.test(c)).join(" ");
    return [this.surface.box.join("x"), ...rs.map((r) => `${parseFloat(r.style.width)}x${parseFloat(r.style.height)}/${parseFloat(r.style.fontSize)}/${cls(r)}`), face, this.both, FORCE4,
      this.posts.map((p) => `${p.slug}\u0001${p.title}\u0001${p.date}`).join("\u0002")].join("|");
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
      d.textContent = essayDate(new Date(p.date + "T12:00:00Z"));
      a.append(t, d);
      li.appendChild(a);
      return li;
    });
    let seen = 0;   // (close-fits: the tallest page box read, 0 with the notebook not laid out)
    const room = (side) => { const h = side.clientHeight; if (h > seen) seen = h; return h - parseFloat(getComputedStyle(side).paddingBottom); };
    const reset = () => { for (const sd of this.sides) sd.remove(); this.sides = []; };
    // Four essays to a page (Akshay, 20 Oct: "just show 4 writings at a time"; 11 essays: 4 + 4 + 3), when four fit on
    // a page at this type size (their titles end before 93 % of its room)
    const fourUp = () => { reset(); for (let i = 0; i < items.length; i += PER_PAGE) mk().append(...items.slice(i, i + PER_PAGE)); };
    const fits = () => this.sides.every((sd) => { const li = sd.querySelector("ol").lastElementChild; return !li || li.offsetTop + li.offsetHeight <= room(sd) * 0.93; });
    // (where they do not, the space between essays a little less; where still not, three a page (DYS-197, below), and
    // fit.need records the size four would need: the coordinator's call; where not even three fit, at the type's size
    // the pages hold as many as fit)
    const tight = (on) => { for (const r of this.roots()) r.classList.toggle("nb-tight", on); };
    const snug = (on) => { for (const r of this.roots()) r.classList.toggle("nb-snug", on); };
    const size = (px) => { for (const r of this.roots()) r.style.fontSize = `${px}px`; };
    // (DYS-149 close-fits) the pages as a build before this one with the same fitKey measured them (NB_MEMO, above):
    // contiguous runs of the essays in order, each run a page; the roots' type size and spacing classes as it left them
    const key = NB_MEMO === "0" ? null : this.fitKey();
    const memo = key ? this.fitMemo?.get(key) : null;
    if (memo && NB_MEMO !== "check") {
      reset();
      this.roots().forEach((r, i) => { r.style.fontSize = memo.fs[i]; r.classList.toggle("nb-tight", memo.tight[i]); r.classList.toggle("nb-snug", memo.snug[i]); });
      let at = 0;
      for (const n of memo.groups) { mk().append(...items.slice(at, at + n)); at += n; }
      this.fit = { ...memo.fit };
      this.fitHow = "remembered";
    } else {
      tight(false);
      snug(false);
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
      // (DYS-197) three a page on a phone's page (the type at its floor) or wherever four don't fit, fitted step by step
      let three = false;
      if (!FORCE4 && (!ok || this.surface.box[0] * 0.041 * ENTRY <= FLOOR)) {
        const threeUp = () => { reset(); for (let i = 0; i < items.length; i += PER_PHONE) mk().append(...items.slice(i, i + PER_PHONE)); };
        tight(false);
        size(fs0);
        threeUp();
        let fs3 = fs0;
        three = fits();
        for (const step of [() => snug(true), () => tight(true)]) { if (three) break; step(); three = fits(); }
        if (!three) {
          size(THREE_MIN);
          if ((three = fits())) {
            let lo = THREE_MIN, hi = fs0;
            for (let k = 0; k < 8; k++) { const mid = (lo + hi) / 2; size(mid); if (fits()) lo = mid; else hi = mid; }
            fs3 = Math.floor(lo * 100) / 100;
            size(fs3);
          }
        }
        if (three) {
          Object.assign(this.fit, { per: PER_PHONE, fits: true, tight: this.el.classList.contains("nb-tight"), snug: this.el.classList.contains("nb-snug"), font: +(fs3 / 2).toFixed(2) });
        } else { snug(false); size(fs0); if (ok) { tight(this.fit.tight); fourUp(); } }
      }
      if (!ok && !FORCE4 && !three) {
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
          const greedy = this.sides.map((l) => [...l.querySelectorAll("li")]);
          const per = Math.ceil(this.posts.length / this.sides.length), all = greedy.flat();
          this.sides.forEach((l, i) => l.querySelector("ol").replaceChildren(...all.slice(i * per, (i + 1) * per)));
          // (DYS-197: shared out evenly, a page can get more than fit on it (11 at 390 x 844: four pages, 3 + 3 + 3 + 2, the
          // second page's third date past the page's edge): then the pages as filled)
          if (!fits()) this.sides.forEach((l, i) => l.querySelector("ol").replaceChildren(...greedy[i]));
          // (shared out evenly, the last pages may be left with nothing: a book has no empty page of its list)
          while (this.sides.length > 1 && !this.sides[this.sides.length - 1].querySelector("li")) this.sides.pop().remove();
        }
        this.fit.per = Math.max(...this.sides.map((sd) => sd.querySelectorAll("li").length));
      }
      // (close-fits) what this measurement chose, kept by its key (a few: a rotation and back); with ?nbmemo=check, compared
      // with what was remembered for it
      const got = { fs: this.roots().map((r) => r.style.fontSize), tight: this.roots().map((r) => r.classList.contains("nb-tight")),
        snug: this.roots().map((r) => r.classList.contains("nb-snug")), groups: this.sides.map((sd) => sd.querySelectorAll("li").length), fit: { ...this.fit } };
      if (memo) {
        const same = JSON.stringify(got) === JSON.stringify(memo), c = (this.memoCheck ||= { n: 0, same: 0, diff: [] });
        c.n++; if (same) c.same++; else if (c.diff.length < 4) c.diff.push({ key, remembered: memo, measured: got });
        console.info(`nbmemo check: ${same ? "the same pages" : "DIFFERENT pages"} (${c.same}/${c.n})`);
      }
      if (key && seen > 0) {
        const m = (this.fitMemo ||= new Map());
        m.delete(key); m.set(key, got);
        while (m.size > 4) m.delete(m.keys().next().value);
      }
      this.fitHow = memo ? "measured, checked" : "measured";
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
      // (DYS-149 turn-layout: reads, the leaves measured so far with their probes in at once and a probe at a time)
      const r = { words, perPage: measured.leaves.map((l) => l.length), size: `${ink.width}x${ink.height}`, ref: `${ref.width}x${ref.height}`, bytesDiffer: differ, how: this.inkHow, flush: this.pages.inkFlush, reads: { ...leafReads } };
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
    const r = this.outer().parentElement?.getBoundingClientRect();
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
    const r = this.outer().parentElement?.getBoundingClientRect();
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
    if (e.type === "fade") { this.domFade(e.o); return; }
    if (e.type === "start") {
      this.focusIn = this.roots().some((r) => r.contains(document.activeElement));
      for (const r of this.roots()) r.classList.add("is-turning");
      this.turning = true;
      return;
    }
    this.leaf = e.leaf;
    if (e.fade) this.domFade(0);
    for (const r of this.roots()) r.classList.remove("is-turning");
    this.turning = false;
    this.show();
    if (this.focusIn && !this.drag) this.first()?.focus({ preventScroll: true });
  }
  // (DYS-149 TF1) the DOM's share now: the roots' own opacity, set at once (no transition left from the ink's: setInk's
  // would ease every fade frame), or with ?domfade=leaf the leaves' --nb-dom
  domFade(o) {
    this.domO = o;
    if (!DOM_FADE_ROOT) { for (const r of this.roots()) r.style.setProperty("--nb-dom", String(o)); return; }
    for (const r of this.roots()) if (r.style.transition !== "none") r.style.transition = "none";
    this.el.style.opacity = String(this.inkLevel * o);
    this.updateLeft();
  }
  // (DYS-149 TF1: essay-lift.js's inkIn waits for 1) the DOM's share as last set; ?domfade=leaf: from the style, as before
  domShare() {
    if (DOM_FADE_ROOT) return this.domO;
    const v = getComputedStyle(this.el).getPropertyValue("--nb-dom").trim();
    return v ? +v : 1;
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
    this.left.style.opacity = String(DOM_FADE_ROOT ? this.inkLevel * this.domO : this.inkLevel);
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
    this.el.style.opacity = String(DOM_FADE_ROOT ? v * this.domO : v);   // (DYS-149 TF1: times the DOM's share in a hand-over)
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

// The notebook's page turn (docs/v3/briefs/page-turn.md; Akshay, 18 Oct: "can we not add true page turning animation
// like Apple Books has"): the leaf is a sheet of paper in the 3D room. It lifts from the corner, curls over, shows its
// back and lands on the left, lit by the room's light like the rest of the desk; the writing is printed on it and
// bends with it; the mouse or a finger drags the corner and the fold follows, a tap or a click lets it turn by itself.
//
//   (notebook.js makes it, before the engine's warm-up: createNotebook(engine, room).pages; NotebookIndex drives it)
//   pages.setLeaf(leaf, { reduced })        // at rest: the leaves before `leaf` lie turned on the cover's inside
//   pages.start(dir, { leaf, leaves, ray }) // a turn begins: the next leaf (dir 1) from the right, or back (-1) from the left
//   pages.dragTo(ray) / pages.release()     // the pointer's ray (room metres): the corner follows it; past the middle, or
//                                           // flicked, it completes on release, otherwise it falls back
//   pages.auto()                            // the turn goes on by itself (a tap, a click, the arrow keys): about 0.7 s
//   pages.onDom(fn)                         // fn({ type: "start" | "end", ... }), inside the engine's frame: the DOM text's
//                                           // handover happens in the very frame the 3D ink starts or stops
//   pages.setAtlas(measured)                // the writing of every leaf (measureLeaves), drawn into the ink atlas
//
// The sheet. The standard page curl: a fold line crosses the leaf; past it the paper wraps round a cylinder of radius R
// up to the angle th and then goes on straight. That surface is developable: the paper bends and never stretches.
// While the corner is dragged, the fold is placed so the corner lies under the pointer (on the plane at the corner's
// own height), and the spine's two corners never pass the fold (the leaf is bound). A turn ends with the fold at the
// spine and the paper folded to the cover's angle, nudged onto the turned leaves' place over the cover's inside. Two
// sheets share one mesh: the leaf turning (0) and the stack of turned leaves on the cover's inside (1), both drawn with
// the page's own material (its albedo, roughness and light-map coordinates), so a flat sheet looks exactly like the
// page it lies on. A turn back runs the same curl from the left, in the cover's plane.
//
// The light. A sheet's light is the page's at the same point of the leaf (notebook.js nbLight: the closed cover's own
// light, as the first page and the cover's inside are lit), turned with the paper: the room above and the page below
// (a hemisphere: up the page's light, down the paper under it, half in the curl's shade), the sun and the lamp by their
// directions; the inside of the curl a little in its own shade. The turning leaf shades the page under it, the cover's
// inside and the stack (soft, from the curl's nearest point, by distance and facing). Its back shows the writing through.
//
// The writing. The DOM text (NotebookIndex's .nb-leaf, multiplied over the canvas) cannot bend. During a turn it hides,
// and the same words, drawn into an ink atlas at the DOM's own positions (measureLeaves), are multiplied over the
// display picture by an overlay pass: display x ink, which is the DOM's mix-blend-mode multiply exactly. They lie on
// the turning leaf's front and on the page beneath where the leaf has lifted; every ink fragment is tested against the
// curled sheet between it and the eye (the curl is a few planes and a cylinder: an exact ray test). When the leaf lands
// the DOM text takes over in the same frame.

export const LEAF = { x0: 0.0015, x1: 0.21, h: 0.142, r: 0.005 };   // the first page, from the cover's hinge (notebook.js
// PAGE), its corners rounded as the page's are (5 mm at all four: the live model's page top, a38ca2f07fbd5d79)
export const LIFT = 0.00015;     // m: the top leaf over the page block
export const GAP = 0.0003;       // m: a turned leaf over the cover's inside
export const INSIDE = 0.00006;   // m: the cover's inside face over its hinge (the live model, a38ca2f07fbd5d79)
const NU = 64, NV = 88;          // the sheet's grid: 3.3 x 3.2 mm cells
export const R_LIFT = 0.008, R_MID = 0.016, R_END = 0.0002;
export const TH_SWEEP = Math.PI - 0.21;   // while it travels the turned part rises 12 degrees off the page
export const AUTO_MS = 720;      // a turn by itself (brief: 0.6-0.8 s)
const BULGE = 0.07;              // m: a turn by itself carries the corner this far toward the head on its way
const FLICK = 0.35;              // m/s along the page: a quick flick completes (or throws it back)
const SHOW = 0.10;               // the back: how much of the front's writing shows through (0.16 read too clearly at night)

// ------------------------------------------------------------------ small vector maths (room metres, arrays)
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// v turned by `ang` about the unit axis k (right-hand rule, as three's setFromAxisAngle and notebook.js nbRot)
const rot = (v, k, ang) => { const c = Math.cos(ang), s = Math.sin(ang); return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c))); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// cubic-bezier(0.45, 0, 0.25, 1): the site's soft ease (router.js SOFT, notebook.js)
function bezier(x1, y1, x2, y2) {
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
const SOFT = bezier(0.45, 0, 0.25, 1);
const OUT = bezier(0.2, 0.6, 0.35, 1);     // a release: it goes on at the speed it had, then settles

// ------------------------------------------------------------------ the curl (the GLSL below mirrors these)
/**
 * The two planes a leaf lies in: the page (right) and the cover's inside (left, the cover at `cover` radians about
 * the spine, notebook.js's turn). Each is an origin and three axes: X across the leaf from the spine, Y the spine
 * toward the head, Z the side the paper lifts to; `front` says which side the writing is on (+1: Z).
 */
export function turnFrames({ pivot, axis, pageDy = 0, cover }) {
  const Y = norm(axis), X = norm(cross(Y, [0, 1, 0])), U = [0, 1, 0];
  const right = { O: add(pivot, mul(U, pageDy + LIFT)), X, Y, Z: U, front: 1 };
  const ZL = rot(mul(U, -1), Y, cover);
  const left = { O: add(add(pivot, rot(mul(U, INSIDE), Y, cover)), mul(ZL, GAP)), X: rot(X, Y, cover), Y, Z: ZL, front: -1 };
  return { right, left, X, Y };
}

/** A sheet lying flat in its plane (the fold far past every corner). */
export const flatCurl = (n = [1, 0]) => { const l = Math.hypot(n[0], n[1]) || 1; return { n: [n[0] / l, n[1] / l], F: 10, R: R_LIFT, th: TH_SWEEP, k: 0, L: [0, 0, 0] }; };

/**
 * The leaf's point (u, v) (metres from the spine and along it) under a curl, in the plane `fr`: its position, the
 * normal of the side the writing is on, how far past the fold it is (d), along the fold (m) and its height (z).
 */
export function curlAt(fr, c, u, v) {
  const [nx, ny] = c.n, tx = -ny, ty = nx;
  const d = u * nx + v * ny - c.F, m = u * tx + v * ty, R = Math.max(c.R, 1e-5), th = c.th;
  let a, z, ang;
  if (d <= 0) { a = d; z = 0; ang = 0; }
  else if (d < R * th) { ang = d / R; a = R * Math.sin(ang); z = R * (1 - Math.cos(ang)); }
  else { ang = th; a = R * Math.sin(th) + (d - R * th) * Math.cos(th); z = R * (1 - Math.cos(th)) + (d - R * th) * Math.sin(th); }
  const qa = (c.F + a) * nx + m * tx, qb = (c.F + a) * ny + m * ty;
  const w = d > 0 ? c.k * Math.min(1, d / Math.max(R * th, 1e-4)) : 0;
  const p = [0, 1, 2].map((i) => fr.O[i] + qa * fr.X[i] + qb * fr.Y[i] + z * fr.Z[i] + w * c.L[i]);
  const s = Math.sin(ang), co = Math.cos(ang);
  const n = [0, 1, 2].map((i) => fr.front * (-s * (nx * fr.X[i] + ny * fr.Y[i]) + co * fr.Z[i]));
  return { p, n, d, m, z };
}

/**
 * The landed state of a turn from plane A to plane B: the fold on the hinge's line (the leaf turns about its binding,
 * as the cover does), the paper folded by the angle between the planes, and the nudge (a constant shift of a fraction
 * of a millimetre, the two being the same rotation about parallel axes) that puts it exactly where a leaf in B lies.
 */
export function landedCurl(A, B) {
  const th = Math.acos(clamp(-dot(A.Z, B.Z), -1, 1));
  const c = { n: [1, 0], F: 0, R: R_END, th, k: 0, L: [0, 0, 0] };
  const got = curlAt(A, c, LEAF.x1, 0).p;
  const want = add(B.O, mul(B.X, LEAF.x1));
  return { ...c, k: 1, L: sub(want, got) };
}

/** The least fold offset along n that keeps the spine's two corners on the flat side. */
const foldMin = (n) => Math.max(LEAF.x0 * n[0] + LEAF.h * n[1], LEAF.x0 * n[0] - LEAF.h * n[1]);

/**
 * The curl that puts the leaf's bottom outer corner C over the point T of its plane (base x, y), the paper wrapping a
 * cylinder of radius R up to th: the fold is the corner's mirror line, moved so the paper's arc is paid for, and held
 * where the spine would come off.
 */
export function dragCurl(T, { R = R_MID, th = TH_SWEEP, C = [LEAF.x1, -LEAF.h] } = {}) {
  const ta = Math.min(T[0], C[0] - 1e-4), tb = clamp(T[1], -LEAF.h - 0.06, LEAF.h + 0.02);
  const dx = C[0] - ta, dy = C[1] - tb, D = Math.hypot(dx, dy);
  const n = [dx / D, dy / D];
  // the corner's way past the fold, x: on the cylinder (x - R sin(x/R) = D) or past it
  let x;
  if (D <= R * th - R * Math.sin(th)) {
    let lo = 0, hi = R * th;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (mid - R * Math.sin(mid / R) < D) lo = mid; else hi = mid; }
    x = (lo + hi) / 2;
  } else x = (D + R * Math.sin(th) - R * th * Math.cos(th)) / (1 - Math.cos(th));
  const F = Math.max(C[0] * n[0] + C[1] * n[1] - x, foldMin(n));
  return { n, F, R, th, k: 0, L: [0, 0, 0] };
}

/** The radius for a corner taken D metres: a small curl at the corner, rounder as the leaf comes over. */
export const radiusFor = (D) => R_LIFT + (R_MID - R_LIFT) * smooth(0, 0.12, D);

/** Between two curls (the fold's direction by its angle); the spine held down (as far as the two ends hold it). */
export function mixCurl(a, b, t) {
  const fa = Math.atan2(a.n[1], a.n[0]), fb = Math.atan2(b.n[1], b.n[0]);
  const f = fa + (fb - fa) * t, n = [Math.cos(f), Math.sin(f)];
  const lerp = (x, y) => x + (y - x) * t;
  const F = Math.max(lerp(Math.min(a.F, 1), Math.min(b.F, 1)), Math.min(foldMin(n), a.F, b.F));
  return { n, F, R: lerp(a.R, b.R), th: lerp(a.th, b.th), k: lerp(a.k, b.k), L: [0, 1, 2].map((i) => lerp(a.L[i], b.L[i])) };
}

/**
 * The leaf going on by itself at p (0-1), its corner from T0 (where it is now) to the other side with a lift toward
 * the head on the way, then landed (complete); or back to its own corner, where it lies flat again (not complete).
 */
export function goCurl(p, { T0 = [LEAF.x1, -LEAF.h], complete = true, land = null, n0 = [0.88, -0.47] } = {}) {
  const C = [LEAF.x1, -LEAF.h], E = complete ? [-LEAF.x1, -LEAF.h] : C;
  // (from rest the whole lift; going on from a drag, which chose its own line, a little of it)
  const fromRest = Math.hypot(T0[0] - C[0], T0[1] - C[1]) < 0.01;
  const lift = complete ? BULGE * Math.sin(Math.PI * p) * (fromRest ? 1 : 0.3) : 0;
  const T = [T0[0] + (E[0] - T0[0]) * p, T0[1] + (E[1] - T0[1]) * p + lift];
  const D = Math.hypot(C[0] - T[0], C[1] - T[1]);
  const c = D < 1e-5 ? flatCurl(n0) : dragCurl(T, { R: radiusFor(D) });
  const w = complete && land ? smooth(0.72, 1, p) : 0;
  return { curl: w > 0 ? mixCurl(c, land, w) : c, T };
}

/** Where a ray (o, d) crosses the plane `fr` raised by h: the point in the plane's (x, y), or null. */
export function onPlane(fr, ray, h = 0) {
  const den = dot(ray.d, fr.Z);
  if (Math.abs(den) < 1e-6) return null;
  const t = (dot(sub(fr.O, ray.o), fr.Z) + h) / den;
  if (!(t > 0)) return null;
  const r = sub(add(ray.o, mul(ray.d, t)), fr.O);
  return [dot(r, fr.X), dot(r, fr.Y)];
}

/** How far the leaf's point (u, v) lies outside its outline, the page's (corners rounded): GLSL ptOut. */
export function leafOut(u, v) {
  const R = LEAF.r, cu = clamp(u, LEAF.x0 + R, LEAF.x1 - R), cv = clamp(v, -LEAF.h + R, LEAF.h - R);
  return Math.hypot(u - cu, v - cv) - R;
}

/**
 * Does the curled sheet lie between the point Q and the eye E? (The ink overlay's ptHidden, line for line; its own
 * neighbourhood of (d0, m0) left out when `self`.) For node checks of the GLSL's maths.
 */
export function sheetHides(fr, c, Q, E, { d0 = 0, m0 = 0, self = false } = {}) {
  const Lk = mul(c.L, c.k);
  const r0 = sub(sub(Q, fr.O), Lk), r1 = sub(sub(E, fr.O), Lk);
  const q0 = [dot(r0, fr.X), dot(r0, fr.Y), dot(r0, fr.Z)], q1 = [dot(r1, fr.X), dot(r1, fr.Y), dot(r1, fr.Z)];
  const [nx, ny] = c.n, tx = -ny, ty = nx, F = c.F, R = Math.max(c.R, 1e-5), th = c.th;
  const f0 = [q0[0] * nx + q0[1] * ny - F, q0[0] * tx + q0[1] * ty, q0[2]], f1 = [q1[0] * nx + q1[1] * ny - F, q1[0] * tx + q1[1] * ty, q1[2]];
  const dv = sub(f1, f0);
  const on = (d, m) => {
    if (self && Math.abs(d - d0) < 0.004 && Math.abs(m - m0) < 0.004) return false;
    return leafOut((F + d) * nx + m * tx, (F + d) * ny + m * ty) < 0;
  };
  if (Math.abs(dv[2]) > 1e-9) {
    const s = -f0[2] / dv[2], h = add(f0, mul(dv, s));
    if (s > 1e-5 && s < 1 && h[0] <= 0 && on(h[0], h[1])) return true;
  }
  const A = dv[0] * dv[0] + dv[2] * dv[2], B = 2 * (f0[0] * dv[0] + (f0[2] - R) * dv[2]);
  const Cc = f0[0] * f0[0] + (f0[2] - R) * (f0[2] - R) - R * R, disc = B * B - 4 * A * Cc;
  if (A > 1e-12 && disc >= 0) {
    for (const sg of [-1, 1]) {
      const s = (-B + sg * Math.sqrt(disc)) / (2 * A);
      if (s <= 1e-5 || s >= 1) continue;
      const h = add(f0, mul(dv, s)), ang = Math.atan2(h[0], R - h[2]);
      if (ang >= 0 && ang <= th && on(R * ang, h[1])) return true;
    }
  }
  const S = [R * Math.sin(th), R * (1 - Math.cos(th))], e = [Math.cos(th), Math.sin(th)];
  const det = e[0] * dv[2] - dv[0] * e[1];
  if (Math.abs(det) > 1e-12) {
    const rhs = [S[0] - f0[0], S[1] - f0[2]];
    const s = (e[0] * rhs[1] - rhs[0] * e[1]) / det, lam = (dv[0] * rhs[1] - dv[2] * rhs[0]) / det;
    const h = add(f0, mul(dv, s));
    if (s > 1e-5 && s < 1 && lam >= 0 && on(R * th + lam, h[1])) return true;
  }
  return false;
}

// ------------------------------------------------------------------ GLSL
const PT_UNIFORMS = /* glsl */ `
uniform vec4 uPtO[2];     // per sheet (0: the leaf turning, 1: the turned stack): its plane's origin (room m); w: +1 when the writing faces the lift side
uniform vec4 uPtX[2];     // the plane's x (across the leaf from the spine); w: shown
uniform vec4 uPtY[2];     // the plane's y (the spine, toward the head)
uniform vec4 uPtZ[2];     // the plane's z (the side the paper lifts to)
uniform vec4 uPtC[2];     // the fold: its normal (plane x, y), its offset along it, the curl's radius
uniform vec4 uPtD[2];     // x: how far the paper wraps (radians); y: the landing nudge's weight
uniform vec4 uPtL[2];     // the landing nudge (room m)
uniform vec4 uPtRect;     // the leaf: x0, x1 (from the spine), its half height; w: the notebook's object id
uniform vec4 uPtMisc;     // x: the turning leaf's shadow (0-1: gone as it lands); y: the back's show-through; z, w: the ink slot of sheet 0, 1 (-1: none)
uniform vec4 uPtAtlas;    // the ink atlas: slots per row, a slot's width and height (0-1); w: 1 once drawn
uniform vec4 uPtSide;     // xyz: the cover's inside, its normal (the lift side); w: the cover's angle (radians, positive)
`;

const PT_CURL = /* glsl */ `
vec3 ptCurl(int s, vec2 uv, out vec3 N, out float d) {
  vec4 C = uPtC[s];
  vec2 n = C.xy, t = vec2(-n.y, n.x);
  float F = C.z, R = max(C.w, 1e-5), th = uPtD[s].x;
  d = dot(uv, n) - F;
  float m = dot(uv, t), a, z, ang;
  if (d <= 0.0) { a = d; z = 0.0; ang = 0.0; }
  else if (d < R * th) { ang = d / R; a = R * sin(ang); z = R * (1.0 - cos(ang)); }
  else { ang = th; a = R * sin(th) + (d - R * th) * cos(th); z = R * (1.0 - cos(th)) + (d - R * th) * sin(th); }
  vec2 q = (F + a) * n + m * t;
  float w = d > 0.0 ? uPtD[s].y * min(1.0, d / max(R * th, 1e-4)) : 0.0;
  vec3 p = uPtO[s].xyz + q.x * uPtX[s].xyz + q.y * uPtY[s].xyz + z * uPtZ[s].xyz + w * uPtL[s].xyz;
  vec2 nb = -sin(ang) * n;
  N = uPtO[s].w * normalize(nb.x * uPtX[s].xyz + nb.y * uPtY[s].xyz + cos(ang) * uPtZ[s].xyz);
  return p;
}
`;

const PT_EDGE = /* glsl */ `
// how far a point of the leaf (metres from the spine and along it) lies outside its outline (the page's, corners rounded)
float ptOut(vec2 uv) {
  const float RC = ${LEAF.r.toFixed(4)};
  vec2 c = clamp(uv, vec2(uPtRect.x + RC, -uPtRect.z + RC), vec2(uPtRect.y - RC, uPtRect.z - RC));
  return length(uv - c) - RC;
}
`;

const PT_INKUV = /* glsl */ `
// a point of the leaf (metres from the spine and along it) in its slot of the ink atlas (the canvas's top row first)
vec2 ptInkUV(float slot, vec2 uv) {
  float col = mod(slot, uPtAtlas.x), row = floor(slot / uPtAtlas.x);
  vec2 s = vec2((uv.x - uPtRect.x) / (uPtRect.y - uPtRect.x), (uPtRect.z - uv.y) / (2.0 * uPtRect.z));
  return (vec2(col, row) + clamp(s, 0.0, 1.0)) * uPtAtlas.yz;
}
`;

/** Added to every room material (notebook.js FS_BLOCK): the turning leaf's soft shadow on what lies under it. */
export const TURN_FS = /* glsl */ `
// ---- the page turn (pageturn.js): the turning leaf's soft shadow
${PT_UNIFORMS}
float ptOcc(vec3 v, vec3 nf, float d, float m) {
  float dist = length(v);
  vec2 n = uPtC[0].xy, t = vec2(-n.y, n.x);
  vec2 q = (uPtC[0].z + d) * n + m * t;
  float e = min(min(q.x - uPtRect.x, uPtRect.y - q.x), uPtRect.z - abs(q.y));
  float c = dist > 1e-5 ? clamp(dot(nf, v / dist), 0.0, 1.0) : 1.0;
  return smoothstep(-0.004, 0.004, e) * sqrt(c) * exp(-dist / 0.02);
}
float ptShade(vec3 Q, vec3 Nq) {
  if (uPtMisc.x <= 0.0 || uPtX[0].w < 0.5) return 1.0;
  vec3 r = Q - uPtO[0].xyz - uPtD[0].y * uPtL[0].xyz;
  vec3 q = vec3(dot(r, uPtX[0].xyz), dot(r, uPtY[0].xyz), dot(r, uPtZ[0].xyz));
  vec3 nq = vec3(dot(Nq, uPtX[0].xyz), dot(Nq, uPtY[0].xyz), dot(Nq, uPtZ[0].xyz));
  vec2 n = uPtC[0].xy, t = vec2(-n.y, n.x);
  float F = uPtC[0].z, R = max(uPtC[0].w, 1e-4), th = uPtD[0].x;
  float a = dot(q.xy, n) - F, m = dot(q.xy, t), z = q.z;
  vec3 nf = vec3(dot(nq.xy, n), dot(nq.xy, t), nq.z);
  // the nearest point of the cylinder, then of the straight part past it (in fold coordinates: across, along, up)
  float ang = clamp(atan(a, R - z), 0.0, th);
  float o = ptOcc(vec3(R * sin(ang) - a, 0.0, R * (1.0 - cos(ang)) - z), nf, R * ang, m);
  vec2 s0 = vec2(R * sin(th), R * (1.0 - cos(th))), e = vec2(cos(th), sin(th));
  float lam = max(dot(vec2(a, z) - s0, e), 0.0);
  vec2 pf = s0 + lam * e;
  o = max(o, ptOcc(vec3(pf.x - a, 0.0, pf.y - z), nf, R * th + lam, m));
  return 1.0 - 0.5 * o * uPtMisc.x;
}
`;

// the sheets in the room: the room's own vertex outputs, the curl in place of the model's position
const SHEET_VS = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 uUvXform;
in vec3 position;          // the sheet at rest (room m): only the passes that draw the room with a material of their own read it
in vec3 sheet;             // u, v (the leaf's metres: across from the spine, along it), which sheet (0: turning, 1: the stack)
in vec2 uv;
in vec2 uv1;
in vec2 uv2;
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec2 vUv1;
out vec2 vUv2;
flat out float vObj;
out vec3 vSfwBook;
out vec4 vPt;              // u, v, the sheet, how far past the fold (m)
${PT_UNIFORMS}
${PT_CURL}
void main() {
  int s = int(sheet.z + 0.5);
  vec3 N;
  float d;
  vec3 p = ptCurl(s, sheet.xy, N, d);
  vWorldPos = p;
  vNormal = N;
  vUv = (uUvXform * vec3(uv, 1.0)).xy;
  vUv1 = uv1;
  vUv2 = uv2;
  vObj = uPtRect.w;
  vSfwBook = vec3(0.0, 0.0, -1.0);
  vPt = vec4(sheet.xy, sheet.z, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (uPtX[s].w < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

// the sheets' own part of the room's fragment shader: the light, the shadow, the writing showing through
const SHEET_FS = /* glsl */ `
// ---- the page turn (pageturn.js): a sheet's light
in vec4 vPt;
uniform sampler2D uPtInk;
${PT_EDGE}
${PT_INKUV}
void sfwSheet(inout vec3 Lb, inout vec3 sunL, inout vec3 lampL, vec3 P, vec3 Ng, inout vec3 albedo) {
  vec2 h = vPt.xy;
  if (ptOut(h) > 0.0) discard;   // (the page's rounded corners)
  int s = int(vPt.z + 0.5);
  vec3 L, sun, lamp;
  nbLight(h, L, sun, lamp);
  vec3 sky = L - uLayerW.y * sun - uLayerW.z * lamp;
  // which side of the spine: 0 on the page, 1 on the cover's inside (the angle about the hinge)
  vec3 r = P - uNbPivot.xyz;
  float rx = dot(r, uNbX.xyz);
  float side = smoothstep(0.1, 0.9, atan(r.y, rx) / max(uPtSide.w, 1e-3));
  vec3 ref = normalize(mix(vec3(0.0, 1.0, 0.0), uPtSide.xyz, side));
  float c = dot(Ng, ref);
  bool lifted = s == 0 && vPt.w > 0.0;
  // the room above and the paper below (half in the curl's shade), the sun and the lamp by their directions
  float hemi = 0.5 * (1.0 + c) + 0.5 * (1.0 - c) * (lifted ? 0.42 : 0.8);
  // (exactly 1 when the sheet faces as the page it was lit as: a flat sheet is the page)
  float sunK = clamp((max(dot(Ng, uSunDir), 0.0) + 0.05) / (max(dot(ref, uSunDir), 0.0) + 0.05), 0.0, 3.0);
  vec3 toL = normalize(uLampPos - P);
  float lampK = clamp((max(dot(Ng, toL), 0.0) + 0.05) / (max(dot(ref, toL), 0.0) + 0.05), 0.0, 3.0);
  // the inside of the curl (the side that lifted) is in the curl's own shade
  float inner = lifted && (gl_FrontFacing == (uPtO[0].w > 0.0)) ? 1.0 - 0.3 * smoothstep(0.0, 1.5 * uPtC[0].w + 1e-4, vPt.w) : 1.0;
  sun *= sunK * inner;
  lamp *= lampK * inner;
  // the gutter on the baked light (as notebook.js's page), the cover's side a little darker (its 0.9), the turning
  // leaf's shadow
  float gutter = 1.0 - 0.14 * uNbMisc.z * (1.0 - smoothstep(0.0, 0.022, length(vec2(rx, r.y))));
  float k = mix(1.0, 0.9, side);
  if (!lifted) k *= ptShade(P, Ng);
  Lb = (sky * hemi * inner + uLayerW.y * sun + uLayerW.z * lamp) * k * gutter;
  sunL = sun * k;
  lampL = lamp * k;
  // the back: the writing of its front shows through, softly
  float slot = s == 0 ? uPtMisc.z : uPtMisc.w;
  if (!gl_FrontFacing && slot >= 0.0 && uPtAtlas.w > 0.5) {
    vec3 ink = textureLod(uPtInk, ptInkUV(slot, h), 2.5).rgb;
    albedo *= mix(vec3(1.0), ink * ink, uPtMisc.y);
  }
}
`;

const SHEET_ID_VS = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec3 sheet;
out vec2 vLeaf;
${PT_UNIFORMS}
${PT_CURL}
void main() {
  int s = int(sheet.z + 0.5);
  vec3 N;
  float d;
  vec3 p = ptCurl(s, sheet.xy, N, d);
  vLeaf = sheet.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (uPtX[s].w < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const SHEET_ID_FS = /* glsl */ `
precision highp float;
uniform vec3 uId;          // region, object low byte, object high byte
in vec2 vLeaf;
out vec4 outColor;
${PT_UNIFORMS}
${PT_EDGE}
void main() {
  if (ptOut(vLeaf) > 0.0) discard;
  outColor = vec4(uId / 255.0, 1.0);
}`;

// the writing during a turn: the page beneath (sheet 2: a quad on the page) and the turning leaf's front
const INK_VS = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec3 sheet;
out vec4 vPt;
out vec3 vW;
${PT_UNIFORMS}
${PT_CURL}
void main() {
  vec3 p = position;
  float d = 0.0;
  if (sheet.z < 1.5) {
    vec3 N;
    p = ptCurl(0, sheet.xy, N, d);
  }
  vW = p;
  vPt = vec4(sheet, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (sheet.z < 1.5 && uPtX[0].w < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const INK_FS = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform vec3 cameraPosition;
uniform sampler2D uPtInk;
uniform vec4 uPtInkSlots;  // x: the page beneath's slot, y: the turning leaf's (-1: none); z: the ink's opacity (the DOM's)
in vec4 vPt;
in vec3 vW;
out vec4 outColor;
${PT_UNIFORMS}
${PT_EDGE}
${PT_INKUV}
// is a point of the turning leaf at (d, m) (past the fold, along it) paper?
bool ptOn(float d, float m, float d0, float m0, bool self) {
  if (self && abs(d - d0) < 0.004 && abs(m - m0) < 0.004) return false;
  vec2 n = uPtC[0].xy, t = vec2(-n.y, n.x);
  vec2 q = (uPtC[0].z + d) * n + m * t;
  return ptOut(q) < 0.0;
}
// does the turning leaf lie between Q and the eye? (its own neighbourhood of (d0, m0) left out when self)
bool ptHidden(vec3 Q, vec3 E, float d0, float m0, bool self) {
  vec3 Lk = uPtD[0].y * uPtL[0].xyz;
  vec3 r0 = Q - uPtO[0].xyz - Lk, r1 = E - uPtO[0].xyz - Lk;
  vec3 q0 = vec3(dot(r0, uPtX[0].xyz), dot(r0, uPtY[0].xyz), dot(r0, uPtZ[0].xyz));
  vec3 q1 = vec3(dot(r1, uPtX[0].xyz), dot(r1, uPtY[0].xyz), dot(r1, uPtZ[0].xyz));
  vec2 n = uPtC[0].xy, t = vec2(-n.y, n.x);
  float F = uPtC[0].z, R = max(uPtC[0].w, 1e-5), th = uPtD[0].x;
  vec3 f0 = vec3(dot(q0.xy, n) - F, dot(q0.xy, t), q0.z), f1 = vec3(dot(q1.xy, n) - F, dot(q1.xy, t), q1.z);
  vec3 dv = f1 - f0;
  // the flat part (z = 0, before the fold)
  if (abs(dv.z) > 1e-9) {
    float s = -f0.z / dv.z;
    vec3 h = f0 + s * dv;
    if (s > 1e-5 && s < 1.0 && h.x <= 0.0 && ptOn(h.x, h.y, d0, m0, self)) return true;
  }
  // the cylinder (centre (0, R) across and up), from 0 to th
  float A = dv.x * dv.x + dv.z * dv.z, B = 2.0 * (f0.x * dv.x + (f0.z - R) * dv.z);
  float Cc = f0.x * f0.x + (f0.z - R) * (f0.z - R) - R * R, disc = B * B - 4.0 * A * Cc;
  if (A > 1e-12 && disc >= 0.0) {
    float sq = sqrt(disc);
    for (int i = 0; i < 2; i++) {
      float s = (-B + (i == 0 ? -sq : sq)) / (2.0 * A);
      if (s <= 1e-5 || s >= 1.0) continue;
      vec3 h = f0 + s * dv;
      float ang = atan(h.x, R - h.z);
      if (ang >= 0.0 && ang <= th && ptOn(R * ang, h.y, d0, m0, self)) return true;
    }
  }
  // the straight part past it
  vec2 S = vec2(R * sin(th), R * (1.0 - cos(th))), e = vec2(cos(th), sin(th));
  float det = e.x * dv.z - dv.x * e.y;
  if (abs(det) > 1e-12) {
    vec2 rhs = S - f0.xz;
    float s = (e.x * rhs.y - rhs.x * e.y) / det;
    float lam = (dv.x * rhs.y - dv.z * rhs.x) / det;
    vec3 h = f0 + s * dv;
    if (s > 1e-5 && s < 1.0 && lam >= 0.0 && ptOn(R * th + lam, h.y, d0, m0, self)) return true;
  }
  return false;
}
void main() {
  bool beneath = vPt.z > 1.5;
  float slot = beneath ? uPtInkSlots.x : uPtInkSlots.y;
  if (slot < 0.0 || (!beneath && (!gl_FrontFacing || ptOut(vPt.xy) > 0.0))) discard;
  vec2 n = uPtC[0].xy;
  float m = dot(vPt.xy, vec2(-n.y, n.x));
  if (uPtX[0].w > 0.5 && ptHidden(vW, cameraPosition, vPt.w, m, !beneath)) discard;
  // (a little sharper than the mip chain alone: the DOM's text is drawn crisp at the handover)
  vec3 ink = texture(uPtInk, ptInkUV(slot, vPt.xy), -0.5).rgb;
  outColor = vec4(mix(vec3(1.0), ink, uPtInkSlots.z), 1.0);
}`;

const SHEET_ANCHOR = "sfwNotebook(Lb, sunL, lampL, P, Ng);   // interactions B";
/** The sheets' fragment shader from the page's (the room's, with interact.js's and notebook.js's code in it). */
export function sheetFragment(fs) {
  // (two maps paper has no use for, so the sheet's program samples no more textures than the room's)
  fs = fs.replace("vec3 em = uEmissive * texture(uEmissiveMap, vUv).rgb;", "vec3 em = uEmissive;");
  fs = fs.replace("texture(uCoatRoughMap, uCoatRoughUV1 > 0.5 ? vUv1 : vUv).g", "1.0");
  const i0 = fs.lastIndexOf("void main()");
  fs = fs.slice(0, i0) + SHEET_FS + fs.slice(i0);
  return fs.replace(SHEET_ANCHOR, `${SHEET_ANCHOR}\n    sfwSheet(Lb, sunL, lampL, P, Ng, albedo);   // the page turn`);
}
/** The GLSL as written (node checks: scripts/live/pageturn_glsl.mjs). */
export const TURN_GLSL = { SHEET_VS, SHEET_FS, SHEET_ID_VS, SHEET_ID_FS, INK_VS, INK_FS };

/** The uniforms the room's materials share with the sheets (notebook.js adds them to every room material). */
export function turnUniforms(THREE) {
  const v4 = () => [new THREE.Vector4(), new THREE.Vector4()];
  return {
    uPtO: { value: v4() }, uPtX: { value: v4() }, uPtY: { value: v4() }, uPtZ: { value: v4() },
    uPtC: { value: v4() }, uPtD: { value: v4() }, uPtL: { value: v4() },
    uPtRect: { value: new THREE.Vector4(LEAF.x0, LEAF.x1, LEAF.h, 5) },
    uPtMisc: { value: new THREE.Vector4(0, SHOW, -1, -1) },
    uPtAtlas: { value: new THREE.Vector4(1, 1, 1, 0) },
    uPtSide: { value: new THREE.Vector4(0, 1, 0, Math.PI) },
  };
}

// ------------------------------------------------------------------ the page's own triangles (for the sheets' attributes)
/**
 * The first page's top in the desk's mesh: its triangles in the leaf's coordinates (u, v from the hinge), with their
 * uv, uv1, uv2, and the room material, region and object they carry. A sheet's vertex takes the page's attributes at
 * the same point, so a sheet lying on the page is drawn exactly as the page is.
 */
export function pageTriangles(engine, { pivot, axis, skip = [] }) {
  const { THREE } = engine;
  const P = new THREE.Vector3(...pivot), Y = new THREE.Vector3(...axis).normalize();
  const X = new THREE.Vector3().crossVectors(Y, new THREE.Vector3(0, 1, 0)).normalize();
  const id = engine.ids ? +Object.entries(engine.ids.objects).find(([, nm]) => nm === "notebook")?.[0] : 5;
  const out = { tris: [], material: null, region: 0, object: id, height: null };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nf = new THREE.Vector3(), e = new THREE.Vector3();
  const found = [];
  for (const m of engine.room.meshes) {
    if (skip.some((o) => o && o.getObjectById(m.id))) continue;
    const g = m.geometry, col = g.attributes.color, pos = g.attributes.position;
    if (!col || !g.attributes.uv1) continue;
    m.updateWorldMatrix(true, false);
    const idx = g.index, nT = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < nT; t++) {
      const I = [0, 1, 2].map((k) => (idx ? idx.getX(3 * t + k) : 3 * t + k));
      if (Math.round(col.getX(I[0]) * 255) + 256 * Math.round(col.getY(I[0]) * 255) !== id) continue;
      a.fromBufferAttribute(pos, I[0]).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, I[1]).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, I[2]).applyMatrix4(m.matrixWorld);
      nf.subVectors(b, a).cross(e.subVectors(c, a));
      if (nf.length() < 1e-9 || nf.normalize().y < 0.99) continue;
      const h = [a, b, c].map((p) => { const d = p.clone().sub(P); return [d.dot(X), d.dot(Y), p.y - P.y]; });
      if (h.some((q) => q[0] < LEAF.x0 - 0.002 || q[0] > LEAF.x1 + 0.002 || Math.abs(q[1]) > LEAF.h + 0.002 || Math.abs(q[2]) > 0.002)) continue;
      found.push({ m, I, h });
    }
  }
  if (!found.length) return out;
  // the page's top: the highest of these levels (the page block's underside and the desk lie lower)
  const top = Math.max(...found.map((f) => f.h[0][2]));
  let most = 0;
  for (const f of found) {
    if (Math.abs(f.h[0][2] - top) > 0.0002) continue;
    const g = f.m.geometry, at = (name) => (g.attributes[name] ? f.I.map((i) => [g.attributes[name].getX(i), g.attributes[name].getY(i)]) : f.I.map(() => [0, 0]));
    const tri = { h: f.h.map((q) => [q[0], q[1]]), uv: at("uv"), uv1: at("uv1"), uv2: at("uv2") };
    out.tris.push(tri);
    // the paper's own colour: the largest triangle's (the page is one colour; a sliver at the fore edge is another)
    const area = Math.abs((tri.h[1][0] - tri.h[0][0]) * (tri.h[2][1] - tri.h[0][1]) - (tri.h[2][0] - tri.h[0][0]) * (tri.h[1][1] - tri.h[0][1])) / 2;
    if (area > most) { most = area; out.uv = tri.uv[0].slice(); }
    if (!out.material) {
      out.material = f.m.userData.roomMaterial || f.m.material;
      out.region = Math.round(g.attributes.color.getZ(f.I[0]) * 255);
    }
  }
  out.height = top;
  return out;
}

/** A point's attributes from the page's triangles (barycentric; the nearest triangle, clamped, off the page). */
function attributesAt(tris, u, v) {
  let best = null, bestErr = Infinity;
  for (const t of tris) {
    const [[x0, y0], [x1, y1], [x2, y2]] = t.h;
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(det) < 1e-14) continue;
    let l0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / det, l1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / det;
    let l2 = 1 - l0 - l1;
    const err = Math.max(0, -l0, -l1, -l2);
    if (err < bestErr) {
      bestErr = err;
      if (err > 0) { l0 = Math.max(0, l0); l1 = Math.max(0, l1); l2 = Math.max(0, l2); const s = l0 + l1 + l2; l0 /= s; l1 /= s; l2 /= s; }
      const mix2 = (k) => [l0 * t[k][0][0] + l1 * t[k][1][0] + l2 * t[k][2][0], l0 * t[k][0][1] + l1 * t[k][1][1] + l2 * t[k][2][1]];
      best = { uv: mix2("uv"), uv1: mix2("uv1"), uv2: mix2("uv2") };
      if (err === 0) break;
    }
  }
  return best || { uv: [0, 0], uv1: [0, 0], uv2: [0, 0] };
}

// ------------------------------------------------------------------ the ink: the DOM's own words, where the DOM puts them
/**
 * Every leaf's words with the font, colour, letter spacing and baseline the DOM gives them, in the leaf box's own
 * pixels (the layout box, before its transform onto the page). Read synchronously with the transform taken off, so
 * nothing is painted in between; hidden leaves are shown for the measure and hidden again.
 */
export function measureLeaves(root, leaves) {
  const keep = root.style.transform;
  root.style.transform = "none";
  const base = root.getBoundingClientRect();
  const out = { w: Math.round(root.offsetWidth), h: Math.round(root.offsetHeight), leaves: [] };
  try {
    for (const leaf of leaves) {
      const was = leaf.hidden;
      leaf.hidden = false;
      const words = [];
      for (const el of leaf.querySelectorAll(".nb-tt, .nb-d")) {
        const cs = getComputedStyle(el);
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const ls = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
        const list = [];
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          const re = /\S+/g;
          let mm;
          while ((mm = re.exec(t.data))) {
            const r = document.createRange();
            r.setStart(t, mm.index);
            r.setEnd(t, mm.index + mm[0].length);
            const rr = r.getClientRects()[0];
            if (rr && rr.width > 0) list.push({ text: mm[0], x: rr.left - base.left, top: rr.top - base.top });
          }
        }
        if (!list.length) continue;
        // the baseline: a zero-size inline box sits on it (the first line's), against the first word's box
        const probe = document.createElement("i");
        probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
        el.prepend(probe);
        const off = probe.getBoundingClientRect().bottom - base.top - list[0].top;
        probe.remove();
        for (const w of list) words.push({ text: w.text, x: w.x, y: w.top + off, font, color: cs.color, ls });
      }
      leaf.hidden = was;
      out.leaves.push(words);
    }
  } finally {
    root.style.transform = keep;
  }
  return out;
}

/** Draw measured leaves into a canvas atlas (white paper, the DOM's ink): one slot per leaf, row by row. */
export function drawAtlas(canvas, measured, maxSize = 4096) {
  const n = Math.max(1, measured.leaves.length), w = Math.max(1, measured.w), h = Math.max(1, measured.h);
  const cols = Math.max(1, Math.min(n, Math.floor(maxSize / w))), rows = Math.ceil(n / cols);
  const k = Math.min(1, maxSize / (rows * h));   // (a box too tall for the atlas is drawn smaller)
  canvas.width = Math.ceil(cols * w * k);
  canvas.height = Math.ceil(rows * h * k);
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(k, k);
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  // (as the DOM's text-rendering: optimizeLegibility: kerning on)
  if ("fontKerning" in g) g.fontKerning = "normal";
  if ("textRendering" in g) g.textRendering = "optimizeLegibility";
  measured.leaves.forEach((words, i) => {
    const ox = (i % cols) * w, oy = Math.floor(i / cols) * h;
    for (const wd of words) {
      g.font = wd.font;
      if ("letterSpacing" in g) g.letterSpacing = wd.ls;
      g.fillStyle = wd.color;
      g.fillText(wd.text, ox + wd.x, oy + wd.y);
    }
  });
  return { cols, rows, slotW: (w * k) / canvas.width, slotH: (h * k) / canvas.height };
}

// ------------------------------------------------------------------ the GPU side
/**
 * The two sheets, their shadow and the writing's overlay. `uniforms` are turnUniforms(), already added to every room
 * material (notebook.js); `openRad` the open cover's angle (notebook.js OPEN_DEG; setCover() follows it as it moves);
 * `skip` the cover and the elastic (not the page). Returns null when the page cannot be found in the model (the DOM's
 * own turn is used then).
 */
export function createPageTurn(engine, { pivot, axis, uniforms: U, openRad, skip = [] }) {
  const { THREE } = engine;
  const page = pageTriangles(engine, { pivot, axis, skip });
  const mat0 = page.material;
  if (!page.tris.length || !mat0 || !mat0.fragmentShader?.includes(SHEET_ANCHOR) || !mat0.fragmentShader.includes("void main()")) {
    console.warn("[pageturn] the page was not found in the model: the DOM turn is used");
    return null;
  }
  const pageDy = page.height ?? 0;
  U.uPtRect.value.w = page.object;
  // (the engine's ?nonce= define, first in every room shader: gl/context.js SHADER_NONCE; no import, so the maths
  // above also loads in node)
  const SHADER_NONCE = mat0.fragmentShader.startsWith("#define SFW_NONCE") ? mat0.fragmentShader.slice(0, mat0.fragmentShader.indexOf("\n") + 1) : "";

  // ---- the mesh: two sheets, the page's attributes at every point
  const per = (NU + 1) * (NV + 1);
  const pos = new Float32Array(per * 2 * 3), sh = new Float32Array(per * 2 * 3);
  const uv = new Float32Array(per * 2 * 2), uv1 = new Float32Array(per * 2 * 2), uv2 = new Float32Array(per * 2 * 2);
  const F0 = turnFrames({ pivot, axis, pageDy, cover: openRad });
  const index = [];
  for (let s = 0; s < 2; s++) {
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
      const k = s * per + j * (NU + 1) + i;
      const u = LEAF.x0 + ((LEAF.x1 - LEAF.x0) * i) / NU, v = -LEAF.h + (2 * LEAF.h * j) / NV;
      const p = add(add(F0.right.O, mul(F0.right.X, u)), mul(F0.right.Y, v));
      pos.set(p, 3 * k);
      sh.set([u, v, s], 3 * k);
      const at = attributesAt(page.tris, u, v);
      uv.set(page.uv || at.uv, 2 * k); uv1.set(at.uv1, 2 * k); uv2.set(at.uv2, 2 * k);
    }
    // counter-clockwise seen from the writing's side (X x Y faces the lift side of the page's plane)
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = s * per + j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("sheet", new THREE.BufferAttribute(sh, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  geo.setAttribute("uv2", new THREE.BufferAttribute(uv2, 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();

  // ---- the ink atlas (one texture: every leaf's writing; the sheets' backs and the overlay read it)
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 4;
  let ink = new THREE.CanvasTexture(canvas);
  const setupInk = (t) => {
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.premultiplyAlpha = false;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = Math.max(1, engine.anisotropy || 1);
    t.name = "pageturn:ink";
  };
  setupInk(ink);
  const uInk = { value: ink };

  // ---- the sheets' room material: the page's own program, the curl for its vertices, the sheet's light
  const fs = sheetFragment(mat0.fragmentShader);
  const sheetMat = new THREE.RawShaderMaterial({
    name: "room:pageturn",
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + SHEET_VS,
    fragmentShader: fs,
    uniforms: { ...mat0.uniforms, ...U, uPtInk: uInk },
    defines: { ...mat0.defines },
    side: THREE.DoubleSide,
  });
  sheetMat.userData.sfwInteract = sheetMat.userData.sfwNotebook = true;   // (already in the code it was made from)
  const idMat = new THREE.RawShaderMaterial({
    name: "room:id:pageturn",
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + SHEET_ID_VS,
    fragmentShader: SHADER_NONCE + SHEET_ID_FS,
    uniforms: { ...U, uId: { value: new THREE.Vector3(page.region, page.object & 255, page.object >> 8) } },
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, sheetMat);
  mesh.name = "pageturn";
  mesh.frustumCulled = false;
  mesh.userData.roomMaterial = sheetMat;
  mesh.userData.idMaterial = idMat;
  mesh.userData.tag = { region: "desk_objects", object: "notebook", atlas: "desk", vertexIds: true, regionId: page.region, objectId: page.object };
  engine.room.scene.add(mesh);
  engine.room.meshes.push(mesh);
  engine.room.materials.push(sheetMat);
  engine.room.idMaterials?.push(idMat);
  // (the room's draw mode, live, pre-pass or added: setMode sets it on every room material)
  const mode = engine.room.mode;
  engine.room.mode = null;
  engine.room.setMode(mode || "live");

  // ---- the writing's overlay: the page beneath (a quad on the page) and the turning leaf's front
  const quad = new THREE.BufferGeometry();
  {
    const P = [];
    for (const [u, v] of [[LEAF.x0, LEAF.h], [LEAF.x1, LEAF.h], [LEAF.x1, -LEAF.h], [LEAF.x0, -LEAF.h]]) {
      P.push(...add(add(add(pivot, [0, pageDy, 0]), mul(F0.right.X, u)), mul(F0.right.Y, v)));
    }
    quad.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
    quad.setAttribute("sheet", new THREE.BufferAttribute(new Float32Array([LEAF.x0, LEAF.h, 2, LEAF.x1, LEAF.h, 2, LEAF.x1, -LEAF.h, 2, LEAF.x0, -LEAF.h, 2]), 3));
    quad.setIndex([0, 3, 2, 0, 2, 1]);
  }
  const inkSlots = { value: new THREE.Vector4(-1, -1, 1, 0) };
  const inkMat = new THREE.RawShaderMaterial({
    name: "pageturn:ink",
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + INK_VS,
    fragmentShader: SHADER_NONCE + INK_FS,
    uniforms: { ...U, uPtInk: uInk, uPtInkSlots: inkSlots },
    side: THREE.DoubleSide,
    transparent: true, depthTest: false, depthWrite: false,
    // display x ink, the DOM's multiply; the display's alpha kept
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const sheetInkGeo = new THREE.BufferGeometry();
  sheetInkGeo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, per * 3), 3));
  sheetInkGeo.setAttribute("sheet", new THREE.BufferAttribute(sh.subarray(0, per * 3), 3));
  sheetInkGeo.setIndex(index.slice(0, NU * NV * 6));
  const inkScene = new THREE.Scene();
  const beneathMesh = new THREE.Mesh(quad, inkMat), leafMesh = new THREE.Mesh(sheetInkGeo, inkMat);
  beneathMesh.frustumCulled = leafMesh.frustumCulled = false;
  beneathMesh.renderOrder = 0; leafMesh.renderOrder = 1;
  inkScene.add(beneathMesh, leafMesh);
  const inkCam = new THREE.PerspectiveCamera();
  inkCam.matrixAutoUpdate = false;
  inkCam.matrixWorldAutoUpdate = false;

  // ---- the state
  const listeners = new Set();
  const st = {
    leaf: 0, reduced: false, cover: openRad, inkLevel: 1, atlas: null, inkSize: "4x4",
    turn: null,          // { dir, from, to, A, B, land, curl, T (the corner in A's plane), mode: "drag" | "go", ... }
    pending: [],         // DOM events for the next frame
    warm: true,          // both sheets drawn (flat) until the warm-up is done, so their programs compile there
    hold: false,         // QA: a turn's last frame kept
    freeze: null,        // QA: a turn by itself held at this point of its way (0-1; the walk's still frames)
    last: null,          // the last turn's numbers (QA)
  };
  const frames = () => turnFrames({ pivot, axis, pageDy, cover: st.cover });

  const setSheet = (s, fr, c, shown) => {
    U.uPtO.value[s].set(fr.O[0], fr.O[1], fr.O[2], fr.front);
    U.uPtX.value[s].set(fr.X[0], fr.X[1], fr.X[2], shown ? 1 : 0);
    U.uPtY.value[s].set(fr.Y[0], fr.Y[1], fr.Y[2], 0);
    U.uPtZ.value[s].set(fr.Z[0], fr.Z[1], fr.Z[2], 0);
    U.uPtC.value[s].set(c.n[0], c.n[1], c.F, c.R);
    U.uPtD.value[s].set(c.th, c.k, 0, 0);
    U.uPtL.value[s].set(c.L[0], c.L[1], c.L[2], 0);
  };
  const stackCount = () => (st.reduced ? 0 : st.turn ? st.turn.under : st.leaf);
  const write = () => {
    const f = frames(), t = st.turn, open = Math.abs(st.cover) > (10 * Math.PI) / 180;
    if (t) setSheet(0, t.A, t.curl, true);
    else setSheet(0, f.right, flatCurl(), st.warm);
    const n = stackCount();
    // (while a leaf turns the stack lies a hair lower, so the leaf landing on it never fights it for the same depth)
    const L = t ? { ...f.left, O: add(f.left.O, mul(f.left.Z, -LIFT)) } : f.left;
    setSheet(1, st.warm ? f.right : L, flatCurl(), st.warm || (n > 0 && open));
    // (the shadow goes as the leaf lands: nothing changes on the page in the frame the DOM's ink comes back)
    U.uPtMisc.value.set(t ? 1 - clamp(t.curl.k, 0, 1) : 0, SHOW, t ? t.moving : -1, n > 0 ? n - 1 : -1);
    U.uPtSide.value.set(f.left.Z[0], f.left.Z[1], f.left.Z[2], Math.abs(st.cover));
    inkSlots.value.set(t ? t.beneath : -1, t ? t.moving : -1, st.inkLevel, 0);
    mesh.visible = U.uPtX.value[0].w > 0.5 || U.uPtX.value[1].w > 0.5;
  };

  // ---- a turn
  const corner = [LEAF.x1, -LEAF.h];
  const finish = (complete, now) => {
    const t = st.turn;
    if (!t) return;
    st.leaf = complete ? t.to : t.from;
    st.last = { dir: t.dir, from: t.from, to: t.to, complete, mode: t.started, ms: Math.round(now - t.t0), frames: t.frames, longest: +t.longest.toFixed(1) };
    st.turn = null;
    st.pending.push({ type: "end", leaf: st.leaf, complete, dir: t.dir });
    write();
    engine.invalidate("page turn landed");
  };
  // the leaf goes on by itself from where its corner is: over and down (complete), or back to lie flat
  const FULL = 2 * LEAF.x1;
  const go = (complete, now, ms, easing) => {
    const t = st.turn;
    t.mode = "go";
    t.go = { T0: t.T.slice(), complete, t0: now, ms, ease: easing };
    t.decided = complete ? t.to : t.from;
  };

  const api = {
    get ready() { return !!st.atlas; },
    get busy() { return !!st.turn; },
    get coverOpen() { return Math.abs(st.cover) >= Math.abs(openRad) - (0.5 * Math.PI) / 180; },
    get leaf() { return st.leaf; },
    /** At rest: the leaves before `leaf` lie turned on the cover's inside (none with reduced motion: its turns are fades). */
    setLeaf(leaf, { reduced = st.reduced } = {}) {
      if (st.turn) return;
      st.leaf = leaf; st.reduced = !!reduced;
      write();
      engine.invalidate("page turn leaf");
    },
    setCover(rad) { st.cover = rad; if (!st.warm) { write(); } },
    setInk(level) { st.inkLevel = clamp(+level || 0, 0, 1); inkSlots.value.z = st.inkLevel; },
    /** The writing of every leaf (measureLeaves), drawn into the atlas; the texture is uploaded now, not at the first turn. */
    setAtlas(measured) {
      const a = drawAtlas(canvas, measured);
      const size = [canvas.width, canvas.height].join("x");
      if (st.inkSize !== size) {
        // a new size: a new texture (three keeps a texture's storage at the size of its first upload, the 4 x 4
        // placeholder's included: the warm-up drew with it)
        ink.dispose();
        ink = new THREE.CanvasTexture(canvas);
        setupInk(ink);
        uInk.value = ink;
      }
      ink.needsUpdate = true;
      st.inkSize = size;
      st.atlas = { ...a, size, leaves: measured.leaves.length, words: measured.leaves.map((l) => l.length) };
      U.uPtAtlas.value.set(a.cols, a.slotW, a.slotH, 1);
      try { engine.renderer.initTexture(ink); } catch { /* uploaded at its first use */ }
      return st.atlas;
    },
    /**
     * A turn begins: dir 1 the next leaf (from the page's corner), -1 back (from the cover's side). With `drag` the
     * corner then follows dragTo(); without, it goes by itself (auto()).
     */
    start(dir, { leaf, leaves, drag = false }) {
      if (st.turn || !st.atlas) return false;
      const to = leaf + dir;
      if (to < 0 || to >= leaves) return false;
      const f = frames(), A = dir > 0 ? f.right : f.left, B = dir > 0 ? f.left : f.right;
      const now = performance.now();
      st.reduced = false;   // (a 3D turn: the turned leaves lie on the cover's inside again)
      st.turn = {
        dir, from: leaf, to, A, B, land: landedCurl(A, B), curl: flatCurl([0.88, -0.47]), mode: "drag",
        moving: dir > 0 ? leaf : leaf - 1, beneath: dir > 0 ? leaf + 1 : leaf, under: dir > 0 ? leaf : leaf - 1,
        T: corner.slice(), target: null, z: 0, samples: [[now, corner[0]]], t0: now, started: drag ? "drag" : "auto",
        frames: 0, longest: 0, lastT: null, decided: null,
      };
      st.pending.push({ type: "start", dir, from: leaf, to });
      if (!drag) api.auto();
      write();
      engine.invalidate("page turn");
      return true;
    },
    /**
     * The pointer's ray (room metres): the corner goes under it (on the plane at the corner's own height), eased over
     * a few frames, as far as the paper lets it.
     */
    dragTo(ray) {
      const t = st.turn;
      if (!t || t.mode !== "drag") return;
      const q = onPlane(t.A, ray, t.z);
      if (!q) return;
      t.target = q;
      engine.invalidate("page turn drag");
    },
    /**
     * Let go: past the middle of the page (the corner's way to the spine), or a quick flick toward the spine,
     * completes; otherwise it falls back. A tap (no drag) lets it turn by itself.
     */
    release({ tap = false, back = false } = {}) {
      const t = st.turn;
      if (!t || t.mode !== "drag") return null;
      const now = performance.now();
      if (tap && !back) { api.auto(); return true; }
      const s0 = t.samples[0], s1 = t.samples[t.samples.length - 1];
      const vel = s1[0] - s0[0] > 8 ? (s1[1] - s0[1]) / ((s1[0] - s0[0]) / 1000) : 0;   // m/s, toward the spine is negative
      const at = t.target || t.T;
      const prog = (corner[0] - at[0]) / (corner[0] - LEAF.x0);
      const complete = !back && (vel < -FLICK || (prog > 0.5 && vel < FLICK));
      // the rest of the way at about the pace it had (0.24-0.62 s over, 0.18-0.45 s back)
      const rest = complete ? Math.hypot(-LEAF.x1 - t.T[0], -LEAF.h - t.T[1]) / FULL : Math.hypot(corner[0] - t.T[0], corner[1] - t.T[1]) / FULL;
      go(complete, now, complete ? clamp(220 + 520 * rest, 240, 620) : clamp(160 + 520 * rest, 180, 450), OUT);
      t.release = { prog: +prog.toFixed(3), vel: +vel.toFixed(3), complete };
      engine.invalidate("page turn release");
      return complete;
    },
    /** The turn goes on by itself from where the corner is (a tap or a click: from rest, the whole way in AUTO_MS). */
    auto() {
      const t = st.turn;
      if (!t) return;
      const now = performance.now();
      const fromRest = Math.hypot(t.T[0] - corner[0], t.T[1] - corner[1]) < 0.01;
      const rest = Math.hypot(-LEAF.x1 - t.T[0], -LEAF.h - t.T[1]) / FULL;
      go(true, now, AUTO_MS * clamp(rest, 0.35, 1), fromRest ? SOFT : OUT);
      engine.requestFrame();
    },
    /** Leaving mid-turn: it lands (or falls back) at once. */
    finishNow() {
      const t = st.turn;
      if (!t) return;
      finish(t.mode === "go" && t.go.complete, performance.now());
      api.flush();
    },
    /** The DOM handover events (also delivered by the frame; QA can flush them). */
    flush() {
      const ev = st.pending.splice(0);
      for (const e of ev) for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } }
    },
    onDom(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * The turn's moments, for a sound (v3/sound wires its page-turn function here at merge time; nothing is wired on
     * this branch): fn({ type: "lift" }) when a leaf starts to turn (a tap, a key, a press on a corner), then
     * fn({ type: "land", leaf }) when it lands on the other side, or fn({ type: "fall", leaf }) when it falls back;
     * each with { dir } (1 over, -1 back). Called inside the engine's frame, as the DOM's handover.
     */
    onTurn(fn) {
      return api.onDom((e) => fn(e.type === "start" ? { type: "lift", dir: e.dir } : { type: e.complete ? "land" : "fall", dir: e.dir, leaf: e.leaf }));
    },
    /** QA (the frames walk): a turn going by itself holds at this point of its way (0-1); null lets it go on. */
    get freeze() { return st.freeze; },
    set freeze(v) { st.freeze = v === null || v === undefined ? null : +v; if (st.freeze === null && st.turn?.go) st.turn.go.t0 = performance.now() - st.turn.go.ms * 0.999; engine.requestFrame(); },
    /** QA: true keeps a turn's last frame (landed or fallen back, the 3D's ink on) until set false again. */
    get hold() { return st.hold; },
    set hold(v) { st.hold = !!v; engine.requestFrame(); },
    /** The leaf's point (u, v) where the turning sheet has it now (room metres; QA: the corner under the pointer). */
    pointNow(u = corner[0], v = corner[1]) {
      const t = st.turn;
      return t ? curlAt(t.A, t.curl, u, v).p : null;
    },
    get state() {
      const t = st.turn;
      return {
        leaf: st.leaf, stack: stackCount(), reduced: st.reduced, sheet0: U.uPtX.value[0].w > 0.5, sheet1: U.uPtX.value[1].w > 0.5,
        turning: !!t, mode: t ? t.mode : null, dir: t ? t.dir : null, from: t ? t.from : null, to: t ? t.to : null, decided: t ? t.decided : null,
        curl: t ? { n: t.curl.n.map((x) => +x.toFixed(4)), F: +t.curl.F.toFixed(4), R: +t.curl.R.toFixed(4), th: +t.curl.th.toFixed(4), k: +t.curl.k.toFixed(3) } : null,
        ink: { beneath: inkSlots.value.x, moving: inkSlots.value.y, level: st.inkLevel }, release: t?.release || null, held: !!t?.held,
        atlas: st.atlas ? { size: st.atlas.size, cols: st.atlas.cols, leaves: st.atlas.leaves, words: st.atlas.words } : null,
        last: st.last, cover: +st.cover.toFixed(4),
      };
    },
    mesh, frames,
    dispose() { prep.remove(); over.remove(); engine.room.scene.remove(mesh); geo.dispose(); sheetMat.dispose(); idMat.dispose(); inkMat.dispose(); quad.dispose(); sheetInkGeo.dispose(); ink.dispose(); },
  };

  // ---- the engine: the state each frame (before the room is drawn), the writing over the display picture
  const prep = engine.addPass({
    name: "pageturn", stage: "prepare", order: -8,
    update(frame) {
      const t = st.turn, now = frame.time ?? performance.now();
      if (t && t.held && !st.hold) { t.held = false; finish(t.go.complete, now); }
      else if (t && !t.held) {
        if (t.lastT !== null) t.longest = Math.max(t.longest, now - t.lastT);
        t.lastT = now;
        t.frames++;
        if (t.mode === "drag" && t.target) {
          // the corner eases to the pointer (35 ms): picked up, never snapped
          const dt = Math.min(64, Math.max(0, now - (t.dragT ?? now)));
          t.dragT = now;
          const k = 1 - Math.exp(-dt / 35);
          t.T = [t.T[0] + (t.target[0] - t.T[0]) * k, t.T[1] + (t.target[1] - t.T[1]) * k];
          const D = Math.hypot(corner[0] - t.T[0], corner[1] - t.T[1]);
          t.curl = D < 1e-5 ? flatCurl(t.curl.n) : dragCurl(t.T, { R: radiusFor(D) });
          t.z = curlAt(t.A, t.curl, corner[0], corner[1]).z;
          t.samples.push([now, t.T[0]]);
          while (t.samples.length > 2 && now - t.samples[0][0] > 120) t.samples.shift();
        } else if (t.mode === "go") {
          const g = t.go, p = st.freeze !== null ? clamp(st.freeze, 0, 1) : clamp((now - g.t0) / g.ms, 0, 1);
          const r = goCurl(g.ease(p), { T0: g.T0, complete: g.complete, land: t.land, n0: t.curl.n });
          t.curl = r.curl;
          t.T = r.T;
          // (QA: `hold` keeps the last frame of a turn, the 3D's ink still on, until it is cleared)
          if (p >= 1) { if (st.hold) t.held = true; else finish(g.complete, now); }
        }
        // (redrawn when the leaf moved: a leaf held still lets the room refine; a turn just held is drawn as it lies)
        if (st.turn) {
          const c = st.turn.curl, key = [c.n[0], c.n[1], c.F, c.R, c.th, c.k].map((x) => x.toFixed(6)).join();
          write();
          if (key !== st.turn.key) { st.turn.key = key; engine.invalidate("page turn"); }
        }
      }
      if (st.pending.length) api.flush();
    },
    animating: () => (!!st.turn && !st.turn.held) || st.pending.length > 0,
    render() {}, needsRender: () => false,
  });
  const over = engine.addPass({
    name: "pageturn-ink", stage: "overlay", order: 50,
    needsRender: () => !!st.turn && !!st.atlas,
    render(ctx, frame) {
      const c = frame.camera;
      inkCam.position.fromArray(c.position);
      inkCam.quaternion.fromArray(c.quaternion);
      inkCam.matrixWorld.compose(inkCam.position, inkCam.quaternion, new THREE.Vector3(1, 1, 1));
      inkCam.matrixWorldInverse.copy(inkCam.matrixWorld).invert();
      inkCam.projectionMatrix.copy(c.projectionNoJitter);
      inkCam.projectionMatrixInverse.copy(inkCam.projectionMatrix).invert();
      engine.renderer.render(inkScene, inkCam);
    },
  });

  // the warm-up has drawn both sheets (their programs compiled and drawn once in every mode): now they rest hidden;
  // the overlay's program compiles now and draws once into a small target, not in a turn's first frame
  const offReady = engine.on("ready", () => {
    offReady();
    st.warm = false;
    write();
    engine.renderer.compileAsync(inkScene, inkCam).then(() => {
      const rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
      const r = engine.renderer, prev = r.getRenderTarget();
      inkSlots.value.set(0, 0, 1, 0);
      U.uPtX.value[0].w = 1;
      const eye = new THREE.Vector3(pivot[0], pivot[1] + 0.5, pivot[2] + 0.2);
      inkCam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, new THREE.Vector3(...pivot), new THREE.Vector3(0, 1, 0)));
      inkCam.position.copy(eye);
      inkCam.matrixWorld.compose(eye, inkCam.quaternion, new THREE.Vector3(1, 1, 1));
      inkCam.matrixWorldInverse.copy(inkCam.matrixWorld).invert();
      inkCam.projectionMatrix.makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 10);
      inkCam.projectionMatrixInverse.copy(inkCam.projectionMatrix).invert();
      r.setRenderTarget(rt);
      r.render(inkScene, inkCam);
      r.setRenderTarget(prev);
      rt.dispose();
      write();
    }).catch(() => {});
  });
  write();
  return api;
}

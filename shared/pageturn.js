// The notebook's page turn (docs/v3/briefs/page-turn.md; Akshay, 18 Oct: "can we not add true page turning animation
// like Apple Books has"): the leaf is a sheet of paper in the 3D room. It lifts, curls over, shows its back and lands on
// the left, lit by the room's light like the rest of the desk; the writing is printed on it and bends with it; the mouse
// or a finger drags it and the fold follows, a tap or a click lets it turn by itself.
// Round 2 (docs/v3/briefs/page-turn2.md; Akshay, 20 Oct: "Think how books work"): the notebook is a two-page spread. A
// leaf carries a page of the list on each face (its front on the right, its back on the left once turned), so the list
// flows across the spread like a book's; a drag takes the leaf by its outer edge at the finger's height, from anywhere on
// the outer part of the page (Apple Books), and the edge comes under the finger; back turns lift the left leaf.
//
//   (notebook.js makes it, before the engine's warm-up: createNotebook(engine, room).pages; NotebookIndex drives it)
//   pages.setLeaf(s)                        // at rest at spread s: s leaves lie turned on the cover's inside (s = 0: none)
//   pages.start(dir, { leaf, sides, drag, grab })  // a turn begins: forward (dir 1) the right leaf, back (-1) the left
//                                           // one; `sides` the pages of writing; `grab` the leaf point (u, v) pressed
//   pages.dragTo(ray) / pages.release()     // the pointer's ray (room metres): the edge follows it; past the middle, or
//                                           // flicked, it completes on release, otherwise it falls back
//   pages.auto()                            // the turn goes on by itself (a tap, a click, the arrow keys): about 0.7 s
//   pages.pick(ray)                         // which page a pointer is on, and where (the leaf's u, v)
//   pages.onDom(fn)                         // fn({ type: "start" | "end", ... }), inside the engine's frame: the DOM text's
//                                           // handover happens in the very frame the 3D ink starts or stops
//   pages.setAtlas(measured)                // the writing of every page (measureLeaves), drawn into the ink atlas
//   pages.atlasSteps(measured)              // (DYS-149) the same a page a step (a generator: measureLeafSteps' answer)
//
// The sheet. The standard page curl: a fold line crosses the leaf; past it the paper wraps round a cylinder of radius R
// up to the angle th and then goes on straight. That surface is developable: the paper bends and never stretches.
// While the leaf is dragged, the fold is placed so the point of the outer edge taken lies under the pointer (on the plane
// at its own height), and the spine's two corners never pass the fold (the leaf is bound). A turn ends with the fold at
// the spine and the paper folded to the cover's angle, nudged onto the turned leaves' place over the cover's inside. Two
// sheets share one mesh: the leaf turning (0) and the stack of turned leaves on the cover's inside (1), both drawn with
// the page's own material (its albedo, roughness and light-map coordinates), so a flat sheet looks exactly like the
// page it lies on. A turn back runs the same curl from the left, in the cover's plane.
//
// The light. A sheet's light is the page's at the same point of the leaf (notebook.js nbLight: the closed cover's own
// light, as the first page and the cover's inside are lit), turned with the paper: the room above and the page below
// (a hemisphere: up the page's light, down the paper under it, half in the curl's shade), the sun and the lamp by their
// directions; the inside of the curl a little in its own shade. The turning leaf shades the page under it, the cover's
// inside and the stack (soft, from the curl's nearest point, by distance and facing).
//
// The writing. The DOM text (NotebookIndex's pages, multiplied over the canvas) cannot bend. During a turn it hides, and
// the same words, drawn into an ink atlas at the DOM's own positions (measureLeaves), are multiplied over the display
// picture by an overlay pass: display x ink, which is the DOM's mix-blend-mode multiply exactly. Four layers: the right
// page and the left page beneath (what each shows under and after the leaf), the turning leaf's front and its back (the
// back drawn the way the left page reads); every ink fragment is tested against the curled sheet between it and the eye
// (the curl is a few planes and a cylinder: an exact ray test). The DOM's words and the 3D's ink hand over in a short
// cross-fade (INK_FADE_MS) as a turn begins and as it lands (or falls back): the DOM's opacity is set in the engine's own
// frame ("fade" events), and where an ink layer shows what the DOM shows there, the ink is divided by the DOM's share, so
// the two together go from one to the other with nothing stepping in a frame.

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
const SHOW = 0.06;               // right-hand pages only: how much of a leaf's front shows through its blank back (the faintest)
export const GRAB_ZONE = 0.4;    // a drag (or a press) turns a page from the outer 60 % of its width (Apple Books: anywhere near the edge)
export const TAP_ZONE = 0.65;    // a tap on the paper (not on a title) in the outer 35 % turns it by itself
const CATCH = [0.6, 0.02, 0.06]; // the grabbed edge comes under the finger over this much of its travel: 0.6 x the gap, 2-6 cm
// the hand-overs between the DOM's words and the 3D's ink cross-fade over this long (page-turn2, 21 Oct: the two are drawn
// a little differently, the DOM's antialiased edges lighter; switched in one frame, the titles darkened ~25 % as a turn
// began and lightened as it landed). About 7 frames at 60 fps.
export const INK_FADE_MS = 120;

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
/**
 * A release's ease (page-turn2, 21 Oct: one motion, no jump): it starts at slope s0 (the leaf's own speed when let go,
 * in units of the remaining way per the release's duration) and comes to rest softly, its speed and its change of speed
 * both 0 at the end (1 - (1 - x)^3 (1 + (3 - s0) x)): near a flat page a last millimetre is a big change of the curl, so
 * the end must be gentle. Monotone for s0 in 0..3.
 */
export const settle = (s0) => { const a = 3 - clamp(s0, 0, 3); return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - (1 - x) ** 3 * (1 + a * x)); };

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
 * The curl that puts the leaf's point C (its bottom outer corner, or any point of its outer edge: where a finger took it)
 * over the point T of its plane (base x, y), the paper wrapping a cylinder of radius R up to th: the fold is C's mirror
 * line, moved so the paper's arc is paid for, and held where the spine would come off.
 */
export function dragCurl(T, { R = R_MID, th = TH_SWEEP, C = [LEAF.x1, -LEAF.h] } = {}) {
  const ta = Math.min(T[0], C[0] - 1e-4), tb = clamp(T[1], Math.min(C[1], -LEAF.h) - 0.06, Math.max(C[1] + 0.02, LEAF.h + 0.02));
  const dx = C[0] - ta, dy = C[1] - tb, D = Math.hypot(dx, dy);
  return curlAlong([dx / D, dy / D], D, { R, th, C });
}

/** The curl that takes the leaf's point C a way D along the fold's normal n (unit, toward the spine): dragCurl's core. */
export function curlAlong(n, D, { R = R_MID, th = TH_SWEEP, C = [LEAF.x1, -LEAF.h] } = {}) {
  const x = foldWay(D, R, th);
  const F = Math.max(C[0] * n[0] + C[1] * n[1] - x, foldMin(n));
  return { n, F, R, th, k: 0, L: [0, 0, 0] };
}

/** The taken point's way past the fold, x, for a way D: on the cylinder (x - R sin(x/R) = D) or past it. */
function foldWay(D, R, th = TH_SWEEP) {
  if (D <= R * th - R * Math.sin(th)) {
    let lo = 0, hi = R * th;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (mid - R * Math.sin(mid / R) < D) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  return (D + R * Math.sin(th) - R * th * Math.cos(th)) / (1 - Math.cos(th));
}

/** The radius for a corner taken D metres: a small curl at the corner, rounder as the leaf comes over. */
export const radiusFor = (D) => R_LIFT + (R_MID - R_LIFT) * smooth(0, 0.12, D);

/**
 * The curl with the leaf's point C taken to T (dragCurl, its radius by radiusFor). Over the first SOFT_D of the way
 * (page-turn2, 21 Oct: one motion that rises and falls once) the point is taken less far (the way x smoothstep(way /
 * SOFT_D)), since the curl's lift grows as the cube root of the way (the edge popped up in a drag's first frame), and the
 * fold's direction is steadied toward n0, the last frame's (with a way of a few tenths of a millimetre the finger's
 * jitter swung it); past SOFT_D it is exactly dragCurl to T (the edge under the finger).
 */
const SOFT_D = 0.015;
export function curlFor(T, C, n0 = [1, 0]) {
  const D = Math.hypot(C[0] - T[0], C[1] - T[1]);
  if (D >= SOFT_D) return dragCurl(T, { R: radiusFor(D), C });
  if (D < 1e-7) return flatCurl(n0);
  const k = smooth(0, SOFT_D, D);
  let n = [((C[0] - T[0]) / D) * k + n0[0] * (1 - k), ((C[1] - T[1]) / D) * k + n0[1] * (1 - k)];
  const l = Math.hypot(n[0], n[1]);
  n = l > 1e-6 && n[0] / l > 0.05 ? [n[0] / l, n[1] / l] : [1, 0];
  return curlAlong(n, D * k, { R: radiusFor(D), C });
}

/** How much of the leaf is lifted for a way D (the fold's distance from the taken point, curlFor's soft start in). */
export const liftOf = (D) => (D <= 0 ? 0 : foldWay(D * (D >= SOFT_D ? 1 : smooth(0, SOFT_D, D)), radiusFor(D)));
/** The way D whose lift is X (liftOf's inverse, within 0..Dmax). */
export function wayFor(X, Dmax) {
  let lo = 0, hi = Dmax;
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (liftOf(mid) < X) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Between two curls (the fold's direction by its angle); the spine held down (as far as the two ends hold it). */
export function mixCurl(a, b, t) {
  const fa = Math.atan2(a.n[1], a.n[0]), fb = Math.atan2(b.n[1], b.n[0]);
  const f = fa + (fb - fa) * t, n = [Math.cos(f), Math.sin(f)];
  const lerp = (x, y) => x + (y - x) * t;
  const F = Math.max(lerp(Math.min(a.F, 1), Math.min(b.F, 1)), Math.min(foldMin(n), a.F, b.F));
  return { n, F, R: lerp(a.R, b.R), th: lerp(a.th, b.th), k: lerp(a.k, b.k), L: [0, 1, 2].map((i) => lerp(a.L[i], b.L[i])) };
}

/**
 * The leaf going on by itself at p (0-1), its point C (the corner, or where a drag took the edge) from T0 (where it is
 * now) to the other side with a lift toward the head on the way, then landed (complete); or back to its own place,
 * where it lies flat again (not complete). The landing (the fold to the spine, the paper down onto the other page)
 * blends in from `landFrom` of the way: 0.72 for a whole turn; a turn going on from part-way starts it earlier
 * (landFor), so the travel and the settling are one motion.
 */
export function goCurl(p, { T0 = [LEAF.x1, -LEAF.h], complete = true, land = null, n0 = [0.88, -0.47], C = [LEAF.x1, -LEAF.h], landFrom = 0.72 } = {}) {
  const E = complete ? [-C[0], C[1]] : C;
  // (from rest the whole lift; going on from a drag, which chose its own line, a little of it)
  const fromRest = Math.hypot(T0[0] - C[0], T0[1] - C[1]) < 0.01;
  const lift = complete ? BULGE * Math.sin(Math.PI * p) * (fromRest ? 1 : 0.3) : 0;
  // (falling back, the ease runs on the lifted part's size, not on the way: near a flat page the last millimetres of
  // the way are a big change of the curl, so an ease in the way ended in a snap)
  const q = complete ? p : (() => { const D0 = Math.hypot(T0[0] - C[0], T0[1] - C[1]); return D0 > 1e-7 ? 1 - wayFor(liftOf(D0) * (1 - p), D0) / D0 : 1; })();
  const T = [T0[0] + (E[0] - T0[0]) * q, T0[1] + (E[1] - T0[1]) * q + lift];
  const c = curlFor(T, C, n0);
  const w = complete && land ? smooth(landFrom, 1, p) : 0;
  return { curl: w > 0 ? mixCurl(c, land, w) : c, T };
}

/**
 * Where on a turn going on from T0 the landing starts to blend in: the point of the whole turn (C to its mirror) T0 is
 * at, mapped so the landing still starts at 72 % of the whole way, or at once (and over the rest) past it.
 */
export function landFor(T0, C) {
  const g0 = clamp(Math.hypot(T0[0] - C[0], T0[1] - C[1]) / Math.max(2 * Math.abs(C[0]), 1e-4), 0, 0.999);
  return clamp((0.72 - g0) / (1 - g0), 0, 0.72);
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
uniform vec4 uPtMisc;     // x: the turning leaf's shadow (0-1: gone as it lands); y: a blank back's show-through; z, w: the ink slot of sheet 0, 1 shown through (-1: none)
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
// a point of the leaf (metres from the spine and along it) in its slot of the ink atlas (the canvas's top row first); a
// leaf's back (mirror) reads from its outer edge to the spine, as the left page does
vec2 ptInkUV(float slot, vec2 uv, bool mirror) {
  float col = mod(slot, uPtAtlas.x), row = floor(slot / uPtAtlas.x);
  float x = (uv.x - uPtRect.x) / (uPtRect.y - uPtRect.x);
  vec2 s = vec2(mirror ? 1.0 - x : x, (uPtRect.z - uv.y) / (2.0 * uPtRect.z));
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
out float vSfwDim;          // (interact.js's shelf dim, DYS-29: never on a page)
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
  vSfwDim = 0.0;
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
  // a blank back (right-hand pages only): the writing of its front shows through, the faintest (the same at rest on the
  // turned stack and on a turning leaf: nothing changes at the hand-overs; off when both faces are printed)
  float slot = s == 0 ? uPtMisc.z : uPtMisc.w;
  if (!gl_FrontFacing && slot >= 0.0 && uPtAtlas.w > 0.5 && uPtMisc.y > 0.0) {
    vec3 ink = textureLod(uPtInk, ptInkUV(slot, h, false), 2.5).rgb;
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

// the writing during a turn: the right page beneath (sheet 2: a quad on the page), the left page beneath (sheet 3: a
// quad on the turned stack, in its plane as the cover lies) and the turning leaf's two faces (sheet 0)
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
  } else if (sheet.z > 2.5) {
    p = uPtO[1].xyz + sheet.x * uPtX[1].xyz + sheet.y * uPtY[1].xyz;
  }
  vW = p;
  vPt = vec4(sheet, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if ((sheet.z < 1.5 && uPtX[0].w < 0.5) || (sheet.z > 2.5 && uPtX[1].w < 0.5)) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const INK_FS = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform vec3 cameraPosition;
uniform sampler2D uPtInk;
uniform vec4 uPtInkSlots;  // the ink atlas's slots (-1: none): x the right page beneath, y the left page beneath, z the turning leaf's front, w its back
uniform float uPtInkLevel; // the ink's opacity (the DOM's)
uniform vec4 uPtFadeOn;    // the hand-over's cross-fade: which layers show what the DOM shows there (right, left beneath, the leaf's front, back)
uniform float uPtFadeO;    // the DOM's words' own opacity now (0: the 3D's ink alone)
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
  // the layer: the right page, the left page (a leaf's back, as the left page reads), the leaf's front or its back
  float slot = vPt.z > 2.5 ? uPtInkSlots.y : beneath ? uPtInkSlots.x : gl_FrontFacing ? uPtInkSlots.z : uPtInkSlots.w;
  bool mirror = vPt.z > 2.5 || (!beneath && !gl_FrontFacing);
  if (slot < 0.0 || (!beneath && ptOut(vPt.xy) > 0.0)) discard;
  vec2 n = uPtC[0].xy;
  float m = dot(vPt.xy, vec2(-n.y, n.x));
  if (uPtX[0].w > 0.5 && ptHidden(vW, cameraPosition, vPt.w, m, !beneath)) discard;
  // (a little sharper than the mip chain alone: the DOM's text is drawn crisp at the handover)
  vec3 ink = texture(uPtInk, ptInkUV(slot, vPt.xy, mirror), -0.5).rgb;
  vec3 k = mix(vec3(1.0), ink, uPtInkLevel);
  // (the cross-fade: the DOM's words lie over this at opacity uPtFadeO where this layer shows what they show, on a page
  // lying flat: divided by their share, the two together go from the 3D's ink to the DOM's)
  float on = vPt.z > 2.5 ? uPtFadeOn.y : beneath ? uPtFadeOn.x : gl_FrontFacing ? uPtFadeOn.z : uPtFadeOn.w;
  if (on > 0.5 && uPtFadeO > 0.0 && (beneath || vPt.w <= 0.0)) k /= max(mix(vec3(1.0), ink, uPtInkLevel * uPtFadeO), vec3(0.02));
  outColor = vec4(k, 1.0);
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
    uPtMisc: { value: new THREE.Vector4(0, 0, -1, -1) },
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
      // (DYS-149: the first corner's object first, the corners' list only for the notebook's triangles: the same
      // triangles, without an array made for each of the room's)
      const i0 = idx ? idx.getX(3 * t) : 3 * t;
      if (Math.round(col.getX(i0) * 255) + 256 * Math.round(col.getY(i0) * 255) !== id) continue;
      const I = [i0, idx ? idx.getX(3 * t + 1) : 3 * t + 1, idx ? idx.getX(3 * t + 2) : 3 * t + 2];
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

/**
 * The page's triangles for attributesAt (DYS-149): each one's corners and determinant as numbers, and its bounds in u, v
 * widened far past the rounding of its barycentric coordinates (a point outside them is never inside the triangle).
 */
function triangleTable(tris) {
  const out = [];
  for (const t of tris) {
    const [[x0, y0], [x1, y1], [x2, y2]] = t.h;
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(det) < 1e-14) continue;
    const m = 1e-6 + 1e-10 / Math.abs(det);
    out.push({ t, x0, y0, x1, y1, x2, y2, det, u0: Math.min(x0, x1, x2) - m, u1: Math.max(x0, x1, x2) + m, v0: Math.min(y0, y1, y2) - m, v1: Math.max(y0, y1, y2) + m });
  }
  return out;
}

/**
 * A point's attributes from the page's triangles (barycentric; the nearest triangle, clamped, off the page), written into
 * `uv1`, `uv2` (and `uv` when given) at `o`. (DYS-149: the same triangle and the same sums as before, without the
 * arrays: the first triangle in order with the point inside it, its bounds asked first; inside none, the nearest of all)
 */
function attributesAt(table, u, v, o, uv1, uv2, uv = null) {
  let best = null, l0 = 0, l1 = 0, l2 = 0;
  for (const T of table) {
    if (u < T.u0 || u > T.u1 || v < T.v0 || v > T.v1) continue;
    const { x0, y0, x1, y1, x2, y2, det } = T;
    const a0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / det, a1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / det;
    const a2 = 1 - a0 - a1;
    if (Math.max(0, -a0, -a1, -a2) === 0) { best = T; l0 = a0; l1 = a1; l2 = a2; break; }
  }
  if (!best) {
    let bestErr = Infinity;
    for (const T of table) {
      const { x0, y0, x1, y1, x2, y2, det } = T;
      let a0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / det, a1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / det;
      let a2 = 1 - a0 - a1;
      const err = Math.max(0, -a0, -a1, -a2);
      if (err < bestErr) {
        bestErr = err;
        if (err > 0) { a0 = Math.max(0, a0); a1 = Math.max(0, a1); a2 = Math.max(0, a2); const s = a0 + a1 + a2; a0 /= s; a1 /= s; a2 /= s; }
        best = T; l0 = a0; l1 = a1; l2 = a2;
        if (err === 0) break;
      }
    }
  }
  const mix2 = (q, out) => {
    if (!best) { out[o] = 0; out[o + 1] = 0; return; }
    const w = best.t[q];
    out[o] = l0 * w[0][0] + l1 * w[1][0] + l2 * w[2][0];
    out[o + 1] = l0 * w[0][1] + l1 * w[1][1] + l2 * w[2][1];
  };
  mix2("uv1", uv1); mix2("uv2", uv2);
  if (uv) mix2("uv", uv);
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

/**
 * (DYS-149) One leaf's words, as measureLeaves reads them (the root's transform already off, `base` its box), with half
 * the forced layouts: every element's words first, all in the one layout showing the leaf makes, then each element's
 * baseline probe alone. measureLeaves read element k's words after element k-1's probe was put in and taken out again
 * (the same DOM, so the same layout) and each probe with only itself in: the same two states, the same numbers, one
 * layout an element, not two (the slow laptop's notebook ink: 48 forced layouts in one 64-100 ms task).
 */
function leafWords(leaf, base) {
  const was = leaf.hidden;
  leaf.hidden = false;
  const words = [], els = [];
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
    if (list.length) els.push({ el, cs, font, ls, list });
  }
  for (const { el, cs, font, ls, list } of els) {
    // the baseline: a zero-size inline box sits on it (the first line's), against the first word's box
    const probe = document.createElement("i");
    probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
    el.prepend(probe);
    const off = probe.getBoundingClientRect().bottom - base.top - list[0].top;
    probe.remove();
    for (const w of list) words.push({ text: w.text, x: w.x, y: w.top + off, font, color: cs.color, ls });
  }
  leaf.hidden = was;
  return words;
}

/**
 * (DYS-149) measureLeaves a leaf a step: a generator, one leaf each time it goes on (yielding after each), returning the
 * same { w, h, leaves }. Each step takes the root's transform off, reads its box, measures its leaf (leafWords) and
 * puts the transform back, all in that step, so nothing is painted in between, as before. A step whose root box is not
 * the first step's throws "moved" (the layout changed between two tasks: the caller measures again from the start).
 */
export function* measureLeafSteps(root, leaves) {
  let out = null;
  for (let i = 0; i < Math.max(1, leaves.length); i++) {
    const keep = root.style.transform;
    root.style.transform = "none";
    try {
      const base = root.getBoundingClientRect(), w = Math.round(root.offsetWidth), h = Math.round(root.offsetHeight);
      const box = [base.left, base.top, base.width, base.height, w, h].join(" ");
      if (!out) out = { w, h, leaves: [], box };
      else if (out.box !== box) throw new Error("moved");
      if (i < leaves.length) out.leaves.push(leafWords(leaves[i], base));
    } finally {
      root.style.transform = keep;
    }
    yield;
  }
  return { w: out.w, h: out.h, leaves: out.leaves };
}

/**
 * (DYS-149) drawAtlas a leaf a step: the same canvas calls in the same order, yielding after each leaf's words (the
 * caller hands the canvas's recording to the GPU process there, a leaf at a time); returns drawAtlas's answer.
 */
export function* drawAtlasSteps(canvas, measured, maxSize = 4096) {
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
  for (let i = 0; i < measured.leaves.length; i++) {
    const ox = (i % cols) * w, oy = Math.floor(i / cols) * h;
    for (const wd of measured.leaves[i]) {
      g.font = wd.font;
      if ("letterSpacing" in g) g.letterSpacing = wd.ls;
      g.fillStyle = wd.color;
      g.fillText(wd.text, ox + wd.x, oy + wd.y);
    }
    yield i;
  }
  return { cols, rows, slotW: (w * k) / canvas.width, slotH: (h * k) / canvas.height };
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
export function createPageTurn(engine, { pivot, axis, uniforms: U, openRad, skip = [], page: found = null }) {
  const { THREE } = engine;
  // (DYS-149: `page`, pageTriangles' answer for these same arguments made a task earlier (notebook.js addPages), so the
  // boot's page turn is two tasks, not one of 60 ms on a slow laptop; without it, as before)
  const page = found || pageTriangles(engine, { pivot, axis, skip });
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
  // (DYS-149: the boot's longest task was this: both sheets start on the same grid in the same plane, so the second
  // sheet's points and the page's attributes are the first's, copied; the attributes come from a table of the page's
  // triangles, the index is typed (as setIndex made it, Uint16). The same numbers, a fraction of the main thread's time)
  const tab = triangleTable(page.tris), O = F0.right.O, FX = F0.right.X, FY = F0.right.Y;
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
    const k = j * (NU + 1) + i;
    const u = LEAF.x0 + ((LEAF.x1 - LEAF.x0) * i) / NU, v = -LEAF.h + (2 * LEAF.h * j) / NV;
    pos[3 * k] = O[0] + FX[0] * u + FY[0] * v;
    pos[3 * k + 1] = O[1] + FX[1] * u + FY[1] * v;
    pos[3 * k + 2] = O[2] + FX[2] * u + FY[2] * v;
    sh[3 * k] = sh[3 * (per + k)] = u;
    sh[3 * k + 1] = sh[3 * (per + k) + 1] = v;
    sh[3 * (per + k) + 2] = 1;
    attributesAt(tab, u, v, 2 * k, uv1, uv2, page.uv ? null : uv);
    if (page.uv) { uv[2 * k] = page.uv[0]; uv[2 * k + 1] = page.uv[1]; }
  }
  pos.copyWithin(per * 3, 0, per * 3);
  for (const a of [uv, uv1, uv2]) a.copyWithin(per * 2, 0, per * 2);
  // counter-clockwise seen from the writing's side (X x Y faces the lift side of the page's plane)
  const index = new Uint16Array(2 * NU * NV * 6);
  for (let s = 0, n = 0; s < 2; s++) {
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = s * per + j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      index[n++] = a; index[n++] = b; index[n++] = d; index[n++] = a; index[n++] = d; index[n++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("sheet", new THREE.BufferAttribute(sh, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  geo.setAttribute("uv2", new THREE.BufferAttribute(uv2, 2));
  geo.setIndex(new THREE.Uint16BufferAttribute(index, 1));
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
    // (DYS-151: the room's program has no sampler to spare for the sheet's own: no sunbeam air in front of a turning
    // page, material.js SFW_NO_BEAM_AIR)
    defines: { ...mat0.defines, SFW_NO_BEAM_AIR: "" },
    side: THREE.DoubleSide,
  });
  sheetMat.userData.sfwInteract = sheetMat.userData.sfwNotebook = true;   // (already in the code it was made from)
  // (DYS-149: the room material's compile hook too (material.js smoothIds), so the sheet's object id (vObj) is a smooth
  // varying in both its shaders, as in every room program, not a flat one: ANGLE's Metal backend (every iPhone)
  // rewrites the indices of every draw of a program with a flat varying, here every frame a page turns (FV1: the one
  // flat program left). GLSL ES 3.00 links only matching qualifiers; the hook takes "flat" out of both sides, this vertex
  // shader's (flat out float vObj) and the room's fragment shader's. The sheet's vObj is a uniform's (uPtRect.w), the
  // same at every corner, and the room's fragment shader rounds it where it reads it. ?flatvary=1: the room's materials
  // have no hook, so neither has the sheet: flat on both sides, as before)
  sheetMat.onBeforeCompile = mat0.onBeforeCompile;
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

  // ---- the writing's overlay: the right page beneath (a quad on the page), the left page beneath (a quad on the turned
  // stack: its corners from the stack's plane in the shader) and the turning leaf's two faces
  const quad = new THREE.BufferGeometry();
  {
    const P = [], S = [];
    for (const [u, v] of [[LEAF.x0, LEAF.h], [LEAF.x1, LEAF.h], [LEAF.x1, -LEAF.h], [LEAF.x0, -LEAF.h]]) {
      P.push(...add(add(add(pivot, [0, pageDy, 0]), mul(F0.right.X, u)), mul(F0.right.Y, v)));
      S.push(u, v, 2);
    }
    for (const [u, v] of [[LEAF.x0, LEAF.h], [LEAF.x1, LEAF.h], [LEAF.x1, -LEAF.h], [LEAF.x0, -LEAF.h]]) { P.push(...pivot); S.push(u, v, 3); }
    quad.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
    quad.setAttribute("sheet", new THREE.BufferAttribute(new Float32Array(S), 3));
    quad.setIndex([0, 3, 2, 0, 2, 1, 4, 7, 6, 4, 6, 5]);
  }
  const inkSlots = { value: new THREE.Vector4(-1, -1, -1, -1) }, inkLevel = { value: 1 };
  const fadeOn = { value: new THREE.Vector4(0, 0, 0, 0) }, fadeO = { value: 0 };
  const inkMat = new THREE.RawShaderMaterial({
    name: "pageturn:ink",
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + INK_VS,
    fragmentShader: SHADER_NONCE + INK_FS,
    uniforms: { ...U, uPtInk: uInk, uPtInkSlots: inkSlots, uPtInkLevel: inkLevel, uPtFadeOn: fadeOn, uPtFadeO: fadeO },
    side: THREE.DoubleSide,
    transparent: true, depthTest: false, depthWrite: false,
    // display x ink, the DOM's multiply; the display's alpha kept
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const sheetInkGeo = new THREE.BufferGeometry();
  sheetInkGeo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, per * 3), 3));
  sheetInkGeo.setAttribute("sheet", new THREE.BufferAttribute(sh.subarray(0, per * 3), 3));
  sheetInkGeo.setIndex(new THREE.Uint16BufferAttribute(index.subarray(0, NU * NV * 6), 1));
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
    recto: false,        // the writing on the right-hand pages only (a leaf's front; its back blank): Akshay, 20 Oct
    turn: null,          // { dir, from, to, A, B, land, curl, C (the leaf's point taken), T (where it is, in A's plane), mode: "drag" | "go", ... }
    pending: [],         // DOM events for the next frame
    warm: true,          // both sheets drawn (flat) until the warm-up is done, so their programs compile there
    hold: false,         // QA: a turn's last frame kept
    freeze: null,        // QA: a turn by itself held at this point of its way (0-1; the walk's still frames)
    last: null,          // the last turn's numbers (QA)
    fade: null,          // the DOM / 3D hand-over's cross-fade: { kind: "start" | "end", t0, ms, o0, on: [r, l, f, b], slots (end) }
    domO: 1,             // the DOM's words' opacity as last set (1 at rest)
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
  // (the turned leaves lie on the cover's inside with reduced motion too: the left page's writing is on paper)
  const stackCount = () => (st.turn ? st.turn.under : st.leaf);
  const write = () => {
    const f = frames(), t = st.turn, open = Math.abs(st.cover) > (10 * Math.PI) / 180;
    if (t) setSheet(0, t.A, t.curl, true);
    else setSheet(0, f.right, flatCurl(), st.warm);
    const n = stackCount();
    // (while a leaf turns the stack lies a hair lower, so the leaf landing on it never fights it for the same depth)
    const L = t ? { ...f.left, O: add(f.left.O, mul(f.left.Z, -LIFT)) } : f.left;
    setSheet(1, st.warm ? f.right : L, flatCurl(), st.warm || (n > 0 && open));
    // (the shadow goes as the leaf lands: nothing changes on the page in the frame the DOM's ink comes back)
    // (right-hand pages only: a leaf's back is blank, its front's writing shows through it, the faintest)
    U.uPtMisc.value.set(t ? 1 - clamp(t.curl.k, 0, 1) : 0, st.recto ? SHOW : 0, st.recto && t ? t.moving : -1, st.recto && n > 0 ? n - 1 : -1);
    U.uPtSide.value.set(f.left.Z[0], f.left.Z[1], f.left.Z[2], Math.abs(st.cover));
    const fd = st.fade, k = t ? t.slots : fd && fd.kind === "end" ? fd.slots : null;
    inkSlots.value.set(k ? k.right : -1, k && n > 0 ? k.left : -1, k && t ? k.front : -1, k && t ? k.back : -1);
    inkLevel.value = st.inkLevel;
    if (fd) fadeOn.value.set(...fd.on); else fadeOn.value.set(0, 0, 0, 0);
    fadeO.value = fd ? st.domO : 0;
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
    // (the DOM's next spread fades in over the 3D's ink of the same pages: the right page and the left page as they lie)
    const s2 = st.leaf, ok = (i) => (i >= 0 && i < t.sides ? i : -1);
    st.domO = 0;
    st.fade = { kind: "end", t0: now, ms: INK_FADE_MS, o0: 0, on: [1, 1, 0, 0], slots: st.recto ? { right: ok(s2), left: -1 } : { right: ok(2 * s2), left: ok(2 * s2 - 1) } };
    st.pending.push({ type: "end", leaf: st.leaf, complete, dir: t.dir, fade: true });
    write();
    engine.invalidate("page turn landed");
  };
  // the hand-over's cross-fade, a frame of it: the DOM's opacity (a "fade" event, in this frame) and the ink's share
  const fadeStep = (now) => {
    const fd = st.fade;
    if (!fd) return;
    const p = clamp((now - fd.t0) / fd.ms, 0, 1), e = p * p * (3 - 2 * p);
    st.domO = fd.kind === "start" ? fd.o0 * (1 - e) : fd.o0 + (1 - fd.o0) * e;
    st.pending.push({ type: "fade", o: +st.domO.toFixed(4), kind: fd.kind });
    if (p >= 1) st.fade = null;
    write();
  };
  // the leaf goes on by itself from where its corner is: over and down (complete), or back to lie flat. From a drag
  // (easing null) it goes on at the speed the leaf had (its edge's speed toward where it goes, over the last frames)
  // and the landing blends in over the rest of the way: one motion that rises and falls once (21 Oct)
  const FULL = 2 * LEAF.x1;
  const go = (complete, now, ms, easing = null) => {
    const t = st.turn;
    const T0 = t.T.slice(), E = complete ? [-t.C[0], t.C[1]] : t.C;
    const way = [E[0] - T0[0], E[1] - T0[1]], L2 = way[0] * way[0] + way[1] * way[1];
    const v = t.vT || [0, 0];   // m/ms
    let s0 = L2 > 1e-8 ? Math.max(0, (v[0] * way[0] + v[1] * way[1]) * ms / L2) : 0;
    // (a fall-back eases its lift: the leaf's speed in those units, d lift / d way at the start x way / lift)
    if (!complete && L2 > 1e-8) { const D0 = Math.sqrt(L2), X0 = liftOf(D0); if (X0 > 1e-7) s0 *= ((X0 - liftOf(D0 * 0.98)) / (0.02 * D0)) * (D0 / X0); }
    // (its clock from the last frame drawn, where T0 is: the finger lifts between two frames, and counted from the lift
    // the first frame after it went on by only part of a frame's way, a one-frame hitch)
    const t0 = t.mode === "drag" && t.lastT != null && t.lastT <= now && now - t.lastT < 50 ? t.lastT : now;
    t.mode = "go";
    t.go = { T0, complete, t0, ms, ease: easing || settle(s0), s0: +s0.toFixed(3), landFrom: easing === SOFT ? 0.72 : landFor(T0, t.C) };
    t.decided = complete ? t.to : t.from;
  };

  // (DYS-149) The canvas's words so far to the GPU process, now: a one-texel copy of the canvas into a texture of its own
  // makes Chrome play the canvas's recording (RasterCHROMIUM), so the atlas's own upload later finds little left to
  // play. The canvas's pixels are only read. It leaves the 2D binding as it found it (three.js keeps its own record of
  // it) and the unpack rows and pixels at 0 (three.js's uploads assume it: gl/context.js texRows). Only in Blink (Chrome,
  // Edge, Android): WebKit converts the whole canvas on every upload from it (outside.js), so there the steps only draw.
  let flushTex = null;
  // (review since 13:45, 2: a texture of a lost context is forgotten when it goes, not only when an ink step runs while
  // it is gone: after a restore the old one was refused by bindTexture and the step wrote into whatever was bound)
  const offLost = engine.on("contextlost", () => { flushTex = null; });
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  const blink = /Chrome\/|Chromium\//.test(ua) && !/iP(hone|ad|od)/.test(ua) && !(/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const flushInk = () => {
    if (!blink) return;
    const gl = engine.renderer.getContext();
    if (gl.isContextLost()) { flushTex = null; return; }
    const was = gl.getParameter(gl.TEXTURE_BINDING_2D);
    try {
      if (!flushTex) {
        flushTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, flushTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
      } else gl.bindTexture(gl.TEXTURE_2D, flushTex);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    } catch { /* (the atlas's own upload plays it all) */ } finally {
      gl.bindTexture(gl.TEXTURE_2D, was);
    }
  };
  // setAtlas's upload, the atlas drawn (a: drawAtlas's answer)
  const atlasDone = (a, measured) => {
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
  };

  const api = {
    autoMs: null,   // (v3/essay-lift, a prototype: a turn by itself this quick, for the riffle to an essay's page)
    get ready() { return !!st.atlas; },
    get busy() { return !!st.turn; },
    get coverOpen() { return Math.abs(st.cover) >= Math.abs(openRad) - (0.5 * Math.PI) / 180; },
    get leaf() { return st.leaf; },
    /** The writing on the right-hand pages only (each leaf's front; its back blank, the front showing through faintly). */
    get recto() { return st.recto; },
    set recto(v) { st.recto = !!v; if (!st.turn) write(); },
    /** At rest at spread `leaf`: that many leaves lie turned on the cover's inside (with reduced motion too). */
    setLeaf(leaf, { reduced = st.reduced } = {}) {
      if (st.turn) return;
      st.leaf = leaf; st.reduced = !!reduced;
      write();
      engine.invalidate("page turn leaf");
    },
    setCover(rad) { st.cover = rad; if (!st.warm) { write(); } },
    setInk(level) { st.inkLevel = clamp(+level || 0, 0, 1); inkLevel.value = st.inkLevel; },
    /** The writing of every leaf (measureLeaves), drawn into the atlas; the texture is uploaded now, not at the first turn. */
    setAtlas(measured) { return atlasDone(drawAtlas(canvas, measured), measured); },
    /**
     * (DYS-149) setAtlas a step at a time: a generator, one leaf's words drawn and handed to the GPU process each time it
     * goes on, then setAtlas's upload in the step after the last; returns setAtlas's answer. The same canvas calls in the
     * same order onto the same canvas, so the same atlas: only when Chrome plays the canvas's recording changes (on the
     * slow laptop 26-33 ms of it inside the ink's upload, every page's words at once).
     */
    *atlasSteps(measured) {
      const it = drawAtlasSteps(canvas, measured);
      for (let r = it.next(); ; r = it.next()) {
        if (r.done) return atlasDone(r.value, measured);
        flushInk();
        yield;
      }
    },
    /** (DYS-149: the ink's canvas, as the last setAtlas / atlasSteps left it: the notebook's ?inksplit=check) */
    get inkCanvas() { return canvas; },
    /** (DYS-149: whether atlasSteps hands each page's words to the GPU process as it goes: Blink only) */
    get inkFlush() { return blink; },
    /**
     * A turn begins at spread `leaf` (that many leaves turned): dir 1 the right leaf over to the left (when there is a
     * page to read on its back: `sides` pages of writing in all), -1 the left leaf back. `grab`: the leaf point (u, v)
     * pressed (pick()): the outer edge at that height is what the drag takes; without, the bottom outer corner; `ray`
     * the press's own ray (the finger's way is measured from it at the edge's height). With `drag` it then follows
     * dragTo(); without, it goes by itself (auto()).
     */
    start(dir, { leaf, sides = st.atlas?.leaves ?? 0, drag = false, grab = null, ray = null, t0 = null }) {
      if (st.turn || !st.atlas) return false;
      const s = leaf, to = s + dir, R = st.recto;
      // (forward when there is a page to read next: on the leaf's back, or with right-hand pages only on the next leaf)
      if (dir > 0 ? (R ? s + 1 >= sides : 2 * s + 1 >= sides) : s < 1) return false;
      const f = frames(), A = dir > 0 ? f.right : f.left, B = dir > 0 ? f.left : f.right;
      const now = performance.now(), m = dir > 0 ? s : s - 1;
      const ok = (i) => (i >= 0 && i < sides ? i : -1);
      const C = grab ? [LEAF.x1, clamp(grab[1], -LEAF.h + 0.004, LEAF.h - 0.004)] : corner.slice();
      st.reduced = false;
      st.turn = {
        dir, from: s, to, A, B, land: landedCurl(A, B), curl: flatCurl(grab ? [1, 0] : [0.88, -0.47]), mode: "drag",
        // the pages each layer of ink shows: the right page and the left page beneath, the leaf's two faces
        // (right-hand pages only: leaf j carries page j on its front, nothing on its back)
        slots: R ? { right: ok(dir > 0 ? s + 1 : s), left: -1, front: ok(m), back: -1 }
          : { right: ok(dir > 0 ? 2 * s + 2 : 2 * s), left: ok(dir > 0 ? 2 * s - 1 : 2 * s - 3), front: ok(2 * m), back: ok(2 * m + 1) },
        moving: m, under: m, C, g0: grab ? [grab[0], grab[1]] : null, ray0: ray,
        // (the finger's way, for a flick's speed, from the press itself: a quick flick may be only a few events long)
        T: C.slice(), target: null, z: 0, samples: grab ? [[t0 ?? now, grab[0]]] : [], lastQ: null, t0: now, started: drag ? "drag" : "auto",
        frames: 0, longest: 0, lastT: null, decided: null, sides,
      };
      // (the DOM's words fade out over the 3D's ink of the same pages, where those lie flat: going forward the leaf's front
      // is the right page, with both sides printed the left page beneath is the left one; going back the right page
      // beneath is the right one and the leaf's back the left one)
      st.fade = { kind: "start", t0: now, ms: INK_FADE_MS, o0: st.domO, on: dir > 0 ? [0, R ? 0 : 1, 1, 0] : [1, 0, 0, R ? 0 : 1] };
      st.pending.push({ type: "start", dir, from: s, to });
      if (!drag) api.auto();
      write();
      engine.invalidate("page turn");
      return true;
    },
    /**
     * The pointer's ray (room metres), met on the leaf's plane at the taken edge's own height. The edge eases onto the
     * finger over its first few centimetres of travel (it was taken where the finger pressed, further in), then stays
     * under it; eased over a few frames, as far as the paper lets it.
     */
    dragTo(ray) {
      const t = st.turn;
      if (!t || t.mode !== "drag") return;
      const q = onPlane(t.A, ray, t.z);
      if (!q) return;
      if (!t.g0) t.g0 = q.slice();
      // the finger's way since the press, both met at the edge's height (a level drag stays level as the edge rises)
      const q0 = (t.ray0 && onPlane(t.A, t.ray0, t.z)) || t.g0;
      const d = [q[0] - q0[0], q[1] - q0[1]], gap = [t.g0[0] - t.C[0], t.g0[1] - t.C[1]];
      const k = smooth(0, clamp(CATCH[0] * Math.hypot(gap[0], gap[1]), CATCH[1], CATCH[2]), Math.hypot(d[0], d[1]));
      // first the edge goes the finger's way; over the catch the edge comes under the finger
      t.target = [0, 1].map((i) => (1 - k) * (t.C[i] + d[i]) + k * q[i]);
      const now = performance.now();
      t.lastQ = q;
      t.samples.push([now, q[0]]);
      while (t.samples.length > 2 && now - t.samples[0][0] > 300) t.samples.shift();
      engine.invalidate("page turn drag");
    },
    /**
     * Let go: past the middle of the page (the taken edge's way to the spine), or a quick flick toward the spine (the
     * finger's own speed over its last 120 ms), completes; otherwise it falls back. A tap (no drag) lets it turn by
     * itself.
     */
    release({ tap = false, back = false } = {}) {
      const t = st.turn;
      if (!t || t.mode !== "drag") return null;
      const now = performance.now();
      if (tap && !back) { api.auto(); return true; }
      if (t.lastQ) t.samples.push([now, t.lastQ[0]]);
      // the speed over the last 120 ms (over up to 250 ms when the events came closer together than that)
      let rec = t.samples.filter((x) => now - x[0] <= 120);
      if (rec.length < 2 || rec[rec.length - 1][0] - rec[0][0] < 40) rec = t.samples.filter((x) => now - x[0] <= 250);
      const s0 = rec[0], s1 = rec[rec.length - 1];
      const vel = rec.length >= 2 && s1[0] - s0[0] > 8 ? (s1[1] - s0[1]) / ((s1[0] - s0[0]) / 1000) : 0;   // m/s, toward the spine is negative
      const at = t.target || t.T;
      const prog = (t.C[0] - at[0]) / (t.C[0] - LEAF.x0);
      const complete = !back && (vel < -FLICK || (prog > 0.5 && vel < FLICK));
      // the rest of the way at about the pace it had (0.24-0.62 s over, 0.18-0.45 s back)
      const rest = complete ? Math.hypot(-t.C[0] - t.T[0], t.C[1] - t.T[1]) / FULL : Math.hypot(t.C[0] - t.T[0], t.C[1] - t.T[1]) / FULL;
      go(complete, now, complete ? clamp(220 + 520 * rest, 240, 620) : clamp(160 + 520 * rest, 180, 450));
      t.release = { prog: +prog.toFixed(3), vel: +vel.toFixed(3), complete, s0: t.go.s0, landFrom: +t.go.landFrom.toFixed(3), ms: Math.round(t.go.ms) };
      engine.invalidate("page turn release");
      return complete;
    },
    /** The turn goes on by itself from where the corner is (a tap or a click: from rest, the whole way in AUTO_MS). */
    auto() {
      const t = st.turn;
      if (!t) return;
      const now = performance.now();
      const fromRest = Math.hypot(t.T[0] - t.C[0], t.T[1] - t.C[1]) < 0.01;
      const rest = Math.hypot(-t.C[0] - t.T[0], t.C[1] - t.T[1]) / FULL;
      go(true, now, (api.autoMs || AUTO_MS) * clamp(rest, 0.35, 1), fromRest ? SOFT : null);
      engine.requestFrame();
    },
    /** Leaving mid-turn: it lands (or falls back) at once. */
    finishNow() {
      const t = st.turn;
      if (!t) return;
      finish(t.mode === "go" && t.go.complete, performance.now());
      // (leaving: the DOM's words at once, no cross-fade)
      st.fade = null; st.domO = 1;
      st.pending.push({ type: "fade", o: 1, kind: "end" });
      write();
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
    /** The leaf's point (u, v) where the turning sheet has it now (room metres; QA: the taken edge under the pointer). */
    pointNow(u, v) {
      const t = st.turn;
      return t ? curlAt(t.A, t.curl, u ?? t.C[0], v ?? t.C[1]).p : null;
    },
    /**
     * Which page a pointer's ray meets, and where: { side: 1 the right page, -1 the left (the turned stack's place on the
     * cover's inside), u, v (the leaf's metres), frac: 0 at the spine, 1 at the outer edge }, or null.
     */
    pick(ray) {
      const f = frames();
      for (const [side, fr] of [[1, f.right], [-1, f.left]]) {
        const q = onPlane(fr, ray, 0);
        if (q && q[0] >= LEAF.x0 - 0.003 && q[0] <= LEAF.x1 + 0.006 && Math.abs(q[1]) <= LEAF.h + 0.006) {
          return { side, u: q[0], v: q[1], frac: clamp((q[0] - LEAF.x0) / (LEAF.x1 - LEAF.x0), 0, 1) };
        }
      }
      return null;
    },
    get state() {
      const t = st.turn;
      return {
        leaf: st.leaf, stack: stackCount(), reduced: st.reduced, sheet0: U.uPtX.value[0].w > 0.5, sheet1: U.uPtX.value[1].w > 0.5,
        turning: !!t, mode: t ? t.mode : null, dir: t ? t.dir : null, from: t ? t.from : null, to: t ? t.to : null, decided: t ? t.decided : null,
        curl: t ? { n: t.curl.n.map((x) => +x.toFixed(4)), F: +t.curl.F.toFixed(4), R: +t.curl.R.toFixed(4), th: +t.curl.th.toFixed(4), k: +t.curl.k.toFixed(3) } : null,
        ink: { right: inkSlots.value.x, left: inkSlots.value.y, front: inkSlots.value.z, back: inkSlots.value.w, level: st.inkLevel }, release: t?.release || null, held: !!t?.held,
        grab: t ? { C: t.C.map((x) => +x.toFixed(4)), T: t.T.map((x) => +x.toFixed(4)) } : null,
        atlas: st.atlas ? { size: st.atlas.size, cols: st.atlas.cols, leaves: st.atlas.leaves, words: st.atlas.words } : null,
        last: st.last, cover: +st.cover.toFixed(4),
        fade: st.fade ? { kind: st.fade.kind, on: st.fade.on.slice() } : null, domO: +st.domO.toFixed(4),
      };
    },
    mesh, frames,
    dispose() { prep.remove(); over.remove(); engine.room.scene.remove(mesh); geo.dispose(); sheetMat.dispose(); idMat.dispose(); inkMat.dispose(); quad.dispose(); sheetInkGeo.dispose(); ink.dispose();
      if (flushTex) { engine.renderer.getContext().deleteTexture(flushTex); flushTex = null; } offLost(); },
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
          const T1 = [t.T[0] + (t.target[0] - t.T[0]) * k, t.T[1] + (t.target[1] - t.T[1]) * k];
          // (its speed, m/ms, over the last frames: a release goes on at it)
          if (dt > 0) { const iv = [(T1[0] - t.T[0]) / dt, (T1[1] - t.T[1]) / dt]; t.vT = t.vT ? [0.5 * t.vT[0] + 0.5 * iv[0], 0.5 * t.vT[1] + 0.5 * iv[1]] : iv; }
          t.T = T1;
          t.curl = curlFor(t.T, t.C, t.curl.n);
          t.z = curlAt(t.A, t.curl, t.C[0], t.C[1]).z;
        } else if (t.mode === "go") {
          const g = t.go, p = st.freeze !== null ? clamp(st.freeze, 0, 1) : clamp((now - g.t0) / g.ms, 0, 1);
          const r = goCurl(g.ease(p), { T0: g.T0, complete: g.complete, land: t.land, n0: t.curl.n, C: t.C, landFrom: g.landFrom });
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
      if (st.fade && !(st.turn && st.turn.held)) fadeStep(now);
      if (st.pending.length) api.flush();
    },
    animating: () => (!!st.turn && !st.turn.held) || st.pending.length > 0 || !!st.fade,
    render() {}, needsRender: () => false,
  });
  const over = engine.addPass({
    name: "pageturn-ink", stage: "overlay", order: 50,
    needsRender: (frame) => (!!st.turn || !!st.fade) && !!st.atlas && (frame?.roomW ?? 1) >= 1,   // (v3/zoom-r3: not while the room fades)
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
      inkSlots.value.set(0, 0, 0, 0);
      inkLevel.value = 1;
      U.uPtX.value[0].w = 1;
      U.uPtX.value[1].w = 1;
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

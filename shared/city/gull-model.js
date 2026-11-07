// DYS-227 (G's helper gullreal, 3 Nov): the western gull (Larus occidentalis) the window's gulls are drawn as, a 3D
// model the outside lights for the moment (shared/gl/gulls.js), not a picture: at 4x a near gull is 300-400 device px
// across and is seen side-on, from a little below or above, at any heading across the view, so a mesh is sharp at
// every size and every pose of the wing beat is its own (no cells to pop between).
// No browser globals: node tests import it (scripts/live/gull_real_test.mjs).
//
// The bird, from the field marks and reference photographs (notes: gullreal-notes.md): wingspan 1.30 m (the clock's
// span), 0.60 m bill to tail; a heavy body, the neck drawn in, a round head, a deep yellow bill with a red spot on
// the lower mandible's angle (the gonys); the wings long and narrow, the arm broad, the hand swept back to a pointed
// tip; a short square white tail; pink feet tucked under it. Its colours are drawn by the shader from the coordinates
// each vertex carries (shared/gl/gulls.js GULL_FS): white head, body and tail; dark slate grey back and upper wings with
// a broad white trailing edge; black wingtips with white tips and a white mirror; below, white coverts and grey flight
// feathers, the black tips showing through.
//
// Model frame: metres; x to the right wing, y forward (the bill), z up; the origin about the body's middle.
// Bones (joints) the vertices follow: 0 the body, 1 the right arm (shoulder to wrist), 2 the right hand (wrist to tip),
// 3 and 4 the left arm and hand (the right ones mirrored).

export const GULL_SPAN = 1.3, GULL_LEN = 0.6;
export const SHOULDER = [0.044, 0.046, 0.026];   // the right shoulder joint
export const SEMI = 0.606;                        // shoulder to wingtip along the span (the tip at x 0.65: half the span)
export const WRIST = 0.22;                        // shoulder to wrist (the hand beyond it, ~0.39 m: a gull's long hand)

// the wing's outline, flat: [r: m from the shoulder along the span, its leading edge, its trailing edge (m, + forward of
// the shoulder)]. Long and narrow (round 2, the coordinator's tell 3: semispan / chord ~5, the arm's chord 0.16-0.17 m,
// as the reference photographs measure): the arm's leading edge a little forward (the patagium) to the wrist's point,
// the hand swept back from it and narrowing to a pointed tip 0.39 m out (a western gull's wing length)
const PLAN = [
  [0.000, 0.000, -0.140], [0.050, 0.008, -0.140], [0.110, 0.013, -0.136], [0.170, 0.017, -0.130], [0.220, 0.019, -0.124],
  [0.255, 0.013, -0.121], [0.300, 0.001, -0.118], [0.360, -0.019, -0.116], [0.420, -0.043, -0.116], [0.480, -0.071, -0.119],
  [0.530, -0.096, -0.125], [0.570, -0.117, -0.133], [0.595, -0.132, -0.140], [0.606, -0.142, -0.142]];
// the body as rings along y: [y, half width, half height, centre z]: rump, the deep chest, the thick neck drawn in, the
// big round head, the heavy bill (the gonys, the lower mandible's angle, at 0.277)
const BODY = [
  [-0.200, 0.006, 0.005, 0.014], [-0.185, 0.016, 0.012, 0.012], [-0.160, 0.027, 0.022, 0.009], [-0.130, 0.038, 0.034, 0.004],
  [-0.090, 0.048, 0.048, -0.002], [-0.040, 0.055, 0.057, -0.006], [0.015, 0.057, 0.059, -0.007], [0.060, 0.055, 0.056, -0.005],
  [0.100, 0.048, 0.050, 0.002], [0.135, 0.041, 0.043, 0.010], [0.160, 0.037, 0.039, 0.016], [0.182, 0.035, 0.037, 0.020],
  [0.204, 0.034, 0.036, 0.022], [0.224, 0.029, 0.031, 0.020], [0.239, 0.020, 0.023, 0.016], [0.248, 0.0112, 0.0140, 0.0115],
  [0.262, 0.0096, 0.0124, 0.0098], [0.277, 0.0084, 0.0128, 0.0082], [0.290, 0.0066, 0.0105, 0.0080], [0.299, 0.0037, 0.0062, 0.0072],
  [0.3045, 0.0006, 0.0010, 0.0060]];
// the tail: [y, half width, half thickness, centre z]: a wedge from under the rump (its coverts) to its square end
const TAIL = [[-0.140, 0.026, 0.014, 0.008], [-0.170, 0.036, 0.011, 0.011], [-0.205, 0.046, 0.0085, 0.012], [-0.240, 0.054, 0.0065, 0.013],
  [-0.272, 0.059, 0.0048, 0.013], [-0.293, 0.060, 0.0034, 0.013], [-0.2995, 0.056, 0.0005, 0.013]];
// a foot tucked under the tail, toes back: [y, half width, half height, centre z] (at x +-FOOT_X)
const FOOT = [[-0.115, 0.002, 0.002, -0.026], [-0.125, 0.0065, 0.005, -0.025], [-0.155, 0.007, 0.004, -0.019], [-0.180, 0.0055, 0.0026, -0.014], [-0.190, 0.002, 0.001, -0.013]];
const FOOT_X = 0.016;
export const PART = { body: 0, wing: 1, tail: 2, foot: 3 };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// a smooth curve through table rows (Catmull-Rom on the row's first column), column k at x
function curve(rows, k, x) {
  const n = rows.length;
  if (x <= rows[0][0]) return rows[0][k];
  if (x >= rows[n - 1][0]) return rows[n - 1][k];
  let i = 0;
  while (i < n - 2 && x > rows[i + 1][0]) i++;
  const x0 = rows[i][0], x1 = rows[i + 1][0], t = (x - x0) / (x1 - x0);
  const p0 = rows[Math.max(0, i - 1)], p1 = rows[i], p2 = rows[i + 1], p3 = rows[Math.min(n - 1, i + 2)];
  const m1 = ((p2[k] - p0[k]) / (p2[0] - p0[0])) * (x1 - x0), m2 = ((p3[k] - p1[k]) / (p3[0] - p1[0])) * (x1 - x0);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[k] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[k] + (t3 - t2) * m2;
}
export const leadingEdge = (r) => curve(PLAN, 1, r);
export const trailingEdge = (r) => curve(PLAN, 2, r);
// the wing's thickness (m, its thickest, at ~a quarter of the chord) and camber (of the chord) along the span: the arm
// 2.4-3 cm deep (the patagium and the coverts over it), the hand thin, the tip a few mm
const thick = (r) => (r <= WRIST ? 0.027 - 0.006 * (r / WRIST) : 0.019 * (1 - smooth(WRIST, SEMI, r)) ** 0.8 + 0.0025);
const camber = (r) => (r <= WRIST ? 0.065 : 0.065 - 0.035 * smooth(WRIST, 0.45, r));

/**
 * The gull's mesh (model frame), built once: positions, normals (from the faces), the shader's coordinates (uv, 4 a
 * vertex: on a wing, the span 0..1 from the shoulder, the chord 0..1 from the leading edge, the side (+1 the upper
 * surface, -1 the lower) and the chord's length there (m); on the lofts, the ring's x and z (-1..1)), info (bone a, bone b, b's weight, part) and the triangles (Uint16).
 */
export function buildGullMesh() {
  const P = [], UV = [], INF = [], IDX = [];
  const vert = (p, uv, inf) => { P.push(p[0], p[1], p[2]); UV.push(uv[0], uv[1], uv[2], uv[3] ?? 0); INF.push(inf[0], inf[1], inf[2], inf[3]); return P.length / 3 - 1; };
  const quad = (a, b, c, d, flip) => { if (flip) IDX.push(a, c, b, b, c, d); else IDX.push(a, b, c, b, d, c); };
  // a loft of elliptical rings (rows: [y, hw, hh, cz]) at x0: n around (0 the top, then toward +x)
  function loft(rows, n, part, x0 = 0, flat = 0) {
    const first = P.length / 3, back = rows[1][0] < rows[0][0];   // (rows running tailward wind the other way)
    for (const [y, hw, hh, cz] of rows) {
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
        const hz = c > 0 ? hh * (1 - flat * c * c * 0.25) : hh;   // (the back a little flatter than the belly)
        vert([x0 + hw * s, y, cz + hz * c], [s, c, 0], [0, 0, 0, part]);
      }
    }
    for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < n; j++) {
      const a = first + i * n + j, b = first + i * n + ((j + 1) % n), c = a + n, d = b + n;
      quad(a, b, c, d, back);
    }
    // the ends closed with a fan to their centre
    for (const [ri, flip] of [[0, !back], [rows.length - 1, back]]) {
      const [y, , , cz] = rows[ri], cI = vert([x0, y, cz], [0, 0, 0], [0, 0, 0, part]);
      for (let j = 0; j < n; j++) {
        const a = first + ri * n + j, b = first + ri * n + ((j + 1) % n);
        if (flip) IDX.push(cI, a, b); else IDX.push(cI, b, a);
      }
    }
  }
  loft(BODY, 22, PART.body, 0, 1);
  loft(TAIL, 14, PART.tail);
  loft(FOOT, 8, PART.foot, FOOT_X);
  loft(FOOT, 8, PART.foot, -FOOT_X);
  // the wings: stations along the span, each a loop round the airfoil (the upper surface trailing edge to leading
  // edge, the lower back; the trailing edge's two vertices apart so it stays sharp)
  const RS = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.125, 0.15, 0.17, 0.185, 0.2, 0.215, 0.23, 0.245, 0.26, 0.275, 0.295, 0.32, 0.345,
    0.37, 0.395, 0.42, 0.445, 0.47, 0.495, 0.515, 0.535, 0.552, 0.567, 0.58, 0.59, 0.598, 0.603, 0.6055];
  // (round 2, tell 2: denser toward the leading edge, where the airfoil turns fastest: its normals no longer step)
  const FS = [1, 0.95, 0.89, 0.81, 0.72, 0.62, 0.52, 0.42, 0.33, 0.25, 0.18, 0.125, 0.082, 0.05, 0.028, 0.014, 0.005, 0];
  const loop = [...FS.map((f) => [f, 1]), ...FS.slice(0, -1).reverse().map((f) => [f, -1])];   // ([chord, side])
  const L = loop.length;
  const wingBones = (r, side) => {
    const arm = side > 0 ? 1 : 3, hand = side > 0 ? 2 : 4;
    // (round 2, tell 2: the joints' bends spread, the shoulder's over 10 cm and the wrist's over +-6 cm, so a wing curves
    // there as a real one does and shows no crease)
    if (r < 0.1) return [0, arm, smooth(0, 0.1, r)];
    if (r < WRIST - 0.06) return [arm, arm, 0];
    if (r < WRIST + 0.06) return [arm, hand, smooth(WRIST - 0.06, WRIST + 0.06, r)];
    return [hand, hand, 0];
  };
  for (const sx of [1, -1]) {
    const first = P.length / 3;
    for (const r of RS) {
      const le = leadingEdge(r), te = trailingEdge(r), ch = le - te, t = thick(r), cam = camber(r) * ch;
      const [ba, bb, w] = wingBones(r, sx);
      for (let k = 0; k < L; k++) {
        const [f, side] = loop[k];
        const ht = f >= 1 ? 0.0004 : t * 1.5 * Math.sqrt(f) * (1 - f) ** 1.4 + 0.0004 * (1 - f);
        const zm = cam * 4 * f * (1 - f);
        const z = SHOULDER[2] + zm + (f <= 0 ? 0 : side * ht);
        vert([sx * (SHOULDER[0] + r), SHOULDER[1] + le - f * ch, z], [r / SEMI, f, f <= 0 ? 0 : side, ch], [ba, bb, w, PART.wing]);
      }
    }
    for (let i = 0; i + 1 < RS.length; i++) for (let k = 0; k + 1 < L; k++) {
      const a = first + i * L + k, b = a + 1, c = a + L, d = c + 1;
      quad(a, b, c, d, sx > 0);
    }
  }
  const pos = new Float32Array(P), n = P.length / 3;
  // normals from the faces (area-weighted), so every surface's shading follows its real shape
  const N = new Float64Array(n * 3);
  for (let i = 0; i < IDX.length; i += 3) {
    const a = IDX[i] * 3, b = IDX[i + 1] * 3, c = IDX[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
  }
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    nrm[i * 3] = N[i * 3] / l; nrm[i * 3 + 1] = N[i * 3 + 1] / l; nrm[i * 3 + 2] = N[i * 3 + 2] / l;
  }
  return { pos, nrm, uv: new Float32Array(UV), info: new Float32Array(INF), index: new Uint16Array(IDX), count: n };
}

// ---------------------------------------------------------------- the wing beat
// Joint angles (degrees): ts the arm's elevation at the shoulder (+ up: the dihedral), ps its sweep (+ forward), as its
// twist (+ leading edge up); tw, pw, aw the hand's, at the wrist, relative to the arm.
// The glide: wings held out flat (the shoulder 4 degrees up, the hand 10 down: the tips level with the shoulders or a
// little below, never above, round 3) and the hands swept back from the wrist
export const GLIDE = { ts: 4, ps: 3, as: 3, tw: -10, pw: -10, aw: -3 };
// One beat, phase 0..1 from the wings at their highest: the downstroke (the first half) on spread wings, the hand
// lagging a little behind the arm, its leading edge pitched down; then the upstroke: the wrist leading, the hand folded
// back and down behind it early in it, and spread again by the top (round 2: as the reference photographs show a late
// upstroke, both wings long and high). Every angle a smooth curve of the phase (its speed never jumps). The body rises
// on the downstroke and sinks on the upstroke (bob, m)
export function beatPose(ph) {
  const p = ph - Math.floor(ph);
  const c = Math.cos(2 * Math.PI * p), s = Math.sin(2 * Math.PI * p);
  const dn = p < 0.5 ? s * s : 0;
  const u = (p - 0.43) / 0.57, up = u > 0 && u < 1 ? Math.sin(Math.PI * u) ** 2 : 0;
  return { ts: 6 + 36 * c, ps: 2 + 4 * s - 10 * up, as: 2 - 3 * s + 5 * up, tw: -6 + 12 * dn - 16 * up, pw: -8 - 18 * up,
    aw: -9 * dn + 12 * up, bob: -0.011 * c };
}
/**
 * The pose at the gull's own time t (s): beating at amplitude amp (0 the glide .. 1 a full beat) at phase ph, with the
 * small slow trims of a gliding gull (its own, by seed 0..1). Returns the joint angles, the body's bob (m) and its roll
 * and pitch (degrees).
 */
export function gullPose(ph, amp, t, seed = 0) {
  const b = beatPose(ph), A = clamp(amp, 0, 1), G = GLIDE, q = 1 - A, k = 2 * Math.PI;
  return {
    ts: G.ts + A * (b.ts - G.ts) + q * 1.0 * Math.sin((k * t) / 2.9 + k * seed),
    ps: G.ps + A * (b.ps - G.ps), as: G.as + A * (b.as - G.as),
    tw: G.tw + A * (b.tw - G.tw) + q * 1.0 * Math.sin((k * t) / 3.7 + 11 * seed),
    pw: G.pw + A * (b.pw - G.pw) + q * 2.0 * Math.sin((k * t) / 4.3 + 5 * seed), aw: G.aw + A * (b.aw - G.aw),
    bob: A * b.bob, roll: (1 - 0.7 * A) * 2.6 * Math.sin((k * t) / 3.3 + 7 * seed), pitch: 1.2 * Math.sin((k * t) / 4.1 + 3 * seed),
  };
}

// 4x4 column-major helpers
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const T4 = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const RX = (d) => { const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const RY = (d) => { const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const RZ = (d) => { const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const MX = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const WRIST_PIVOT = [SHOULDER[0] + WRIST, SHOULDER[1] + curve(PLAN, 1, WRIST) - 0.012, SHOULDER[2]];
// a joint's turn about its pivot: elevation (about the forward axis: + lifts the right wing), sweep, twist
const joint = (pv, el, sw, tw) => mul4(T4(pv[0], pv[1], pv[2]), mul4(RY(-el), mul4(RZ(sw), mul4(RX(tw), T4(-pv[0], -pv[1], -pv[2])))));
/**
 * The five bones' matrices (model frame, column-major, 16 floats each, into out: Float32Array(80)) for a pose
 * (gullPose): the body (identity), the right arm and hand, the left arm and hand (mirror images).
 */
export function gullBones(pose, out = new Float32Array(80)) {
  const arm = joint(SHOULDER, pose.ts, pose.ps, pose.as);
  const hand = mul4(arm, joint(WRIST_PIVOT, pose.tw, pose.pw, pose.aw));
  const mir = (m) => mul4(MX, mul4(m, MX));
  [I4(), arm, hand, mir(arm), mir(hand)].forEach((m, i) => out.set(m, i * 16));
  return out;
}
// the right eye on the head's surface (model m): on the side of the head, high and forward (the shader draws its pale
// iris, black pupil and orange-red ring round this point; the left one mirrored)
export const EYE = (() => {
  const y = 0.207, hw = curve(BODY, 1, y), hh = curve(BODY, 2, y), cz = curve(BODY, 3, y), s = 0.8, c = 0.6;
  return [hw * s, y, cz + hh * (1 - 0.25 * c * c) * c];
})();
/**
 * The gull's model matrix (model m -> world, column-major): at pos (world), its forward along fwd (a unit vector,
 * level, world y up), at scale (its span / GULL_SPAN), rolled, pitched and bobbed by the pose
 */
export function placeMatrix(pos, fwd, scale, pose) {
  const F = fwd, R = [-F[2], 0, F[0]];
  const B = [R[0] * scale, R[1] * scale, R[2] * scale, 0, F[0] * scale, F[1] * scale, F[2] * scale, 0, 0, scale, 0, 0, pos[0], pos[1], pos[2], 1];
  return mul4(B, mul4(RY(pose.roll || 0), mul4(RX(pose.pitch || 0), T4(0, 0, pose.bob || 0))));
}
// the bird's outline points for a pose (model frame, after its joints): bill, tail, each wing's root, wrist, hand and tip
// edges: the posed bird lies within their hull (shared/gl/gulls.js: its layer's box on the screen, tight round it)
const EXT_BODY = [[0, 0.305, 0.006], [0, -0.3, 0.013], [0.062, -0.3, 0.013], [-0.062, -0.3, 0.013], [0, 0.0, 0.065], [0, 0.0, -0.077]];
const EXT_WING = [0, 0.11, WRIST, 0.33, 0.45, 0.55, SEMI].flatMap((r) => [[r, true], [r, false]]);
export function extentPoints(pose, out = []) {
  const b = gullBones(pose);
  let n = 0;
  const put = (m, x, y, z) => { out[n] = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; n++; };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const p of EXT_BODY) put(I, p[0], p[1], p[2]);
  for (const sx of [1, -1]) for (const [r, le] of EXT_WING) {
    const m = b.subarray((sx > 0 ? (r <= WRIST ? 1 : 2) : (r <= WRIST ? 3 : 4)) * 16).subarray(0, 16);
    put(m, sx * (SHOULDER[0] + r), SHOULDER[1] + (le ? curve(PLAN, 1, r) : curve(PLAN, 2, r)), SHOULDER[2]);
  }
  out.length = n;
  return out;
}
/** Where the right wingtip is for a pose (model frame): the beat's path, for the tests */
export function wingtip(pose) {
  const b = gullBones(pose), x = SHOULDER[0] + SEMI, y = SHOULDER[1] + curve(PLAN, 1, SEMI), z = SHOULDER[2];
  const m = b.subarray(32, 48);
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

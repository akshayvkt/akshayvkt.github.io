// HTML on a surface of the live room (interactions B: the notebook's page, the phone's screen), placed the way the
// laptop's screen is (shared/laptop.js): real DOM over the canvas, mapped onto a quad of the room every frame with the
// same projection as the 3D, drawn 1:1 at whole pixels when it is seen square on and at rest, and cut where something
// stands between the eye and the surface.
//
//   import { fitPose, Surface } from "/shared/surface.js";
//   fitPose({ points, forward, tanV, w, h, top, bottom, fill })   // a rest pose looking along `forward` that holds the
//                                                                 // points within `fill` of the width and of the free
//                                                                 // height (between `top` and `bottom` px), centred there
//   const s = new Surface(el, () => quad, { oversample: 2 });     // quad: room points top-left, top-right, bottom-right,
//   s.layout(pose, w, h)                                          // bottom-left; the layout box: the quad's size on
//   s.place(pose, w, h, { still, cut: [[...points], ...] })       // screen at `pose` (x oversample); then every frame
import { project, sub, add, mul, dot, basis, yawPitchOf } from "./rig.js";
import { quadToQuad, cssMatrix } from "./overlays.js";

export function fitPose({ points, forward, tanV, w, h, top = 56, bottom = 104, fill = 0.86, fillH = 0.94 }) {
  const { yaw, pitch } = yawPitchOf(forward);
  const B = basis(yaw, pitch), a = w / h, free = Math.max(120, h - top - bottom);
  const C = mul(points.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / points.length);
  const ext = (d) => {
    const eye = sub(C, mul(B.f, d));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const q = sub(p, eye), z = dot(q, B.f);
      if (z < 0.01) return null;
      const tx = dot(q, B.r) / z, ty = dot(q, B.u) / z;
      x0 = Math.min(x0, tx); x1 = Math.max(x1, tx); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty);
    }
    return { eye, x0, x1, y0, y1 };
  };
  const fits = (d) => { const e = ext(d); return !!e && e.x1 - e.x0 <= 2 * tanV * a * fill && e.y1 - e.y0 <= 2 * tanV * (free / h) * fillH; };
  let lo = 0.03, hi = 4;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  const e = ext(hi);
  const yc = top + free / 2;
  return {
    eye: e.eye, yaw, pitch, tanV,
    shiftTan: [(e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2 + ((yc - h / 2) / (h / 2)) * tanV],
    focus: hi, fstop: null,
  };
}

// The 2D convex hull of points (Andrew's monotone chain).
export function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// A ray from the eye against a box: does it enter it before tMax?
function rayBox(o, d, [a, b], tMax) {
  let t0 = 0, t1 = tMax;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < a[i] || o[i] > b[i]) return false; continue; }
    let ta = (a[i] - o[i]) / d[i], tb = (b[i] - o[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return t1 > 0 && t0 < tMax;
}
const boxCorners = ([a, b]) => { const out = []; for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) out.push([x, y, z]); return out; };

export class Surface {
  constructor(el, quad, { oversample = 1, occluders = [] } = {}) {
    this.el = el;
    this.quad = typeof quad === "function" ? quad : () => quad;
    this.k = oversample;
    this.occluders = occluders;     // furniture boxes ({ box }) that may stand between the eye and the surface
    this.box = [0, 0];
    this.el.style.transformOrigin = "0 0";
  }

  corners(pose, w, h) {
    const q = this.quad();
    if (!q || !pose) return null;
    const P = q.map((p) => project(pose, p, w, h));
    return P.some((p) => !p) ? null : P.map((p) => [p[0], p[1]]);
  }

  // The layout box: the quad's size on screen at `pose` (the spot's rest pose), times the oversample.
  layout(pose, w, h) {
    const P = this.corners(pose, w, h);
    if (!P) return this.box;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const bw = Math.round(((d(P[0], P[1]) + d(P[3], P[2])) / 2) * this.k), bh = Math.round(((d(P[0], P[3]) + d(P[1], P[2])) / 2) * this.k);
    if (bw !== this.box[0] || bh !== this.box[1]) {
      this.box = [bw, bh];
      this.el.style.width = `${bw}px`;
      this.el.style.height = `${bh}px`;
    }
    return this.box;
  }

  // The quad's bounding rectangle on screen (CSS px, the canvas's own coordinates), or null.
  rect(pose, w, h) {
    const P = this.corners(pose, w, h);
    if (!P) return null;
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  // Every frame: the layer onto the quad as `pose` sees it; `cut`: lists of room points whose hull on screen is cut out
  // (something in front of the surface: the notebook's cover as it swings over the page).
  place(pose, w, h, { still = false, cut = [] } = {}) {
    const [bw, bh] = this.box;
    if (!bw || !bh) return false;
    const S = this.corners(pose, w, h);
    if (!S) { this.el.style.visibility = "hidden"; this.offscreen = true; return false; }
    this.offscreen = false;
    const axis = Math.abs(S[0][1] - S[1][1]) < 0.35 && Math.abs(S[3][1] - S[2][1]) < 0.35 && Math.abs(S[0][0] - S[3][0]) < 0.35 && Math.abs(S[1][0] - S[2][0]) < 0.35;
    if (still && this.k === 1 && axis && Math.abs(S[1][0] - S[0][0] - bw) < 0.75 && Math.abs(S[3][1] - S[0][1] - bh) < 0.75) {
      this.el.style.transform = `translate(${Math.round(S[0][0])}px, ${Math.round(S[0][1])}px)`;
      this.sharp = true;
    } else {
      const H = quadToQuad([[0, 0], [bw, 0], [bw, bh], [0, bh]], S);
      if (H) this.el.style.transform = cssMatrix(H);
      this.sharp = false;
    }
    this.clip(pose, w, h, S, cut);
    return true;
  }

  clip(pose, w, h, S, cut) {
    const polys = cut.slice();
    if (this.occluders.length) {
      const q = this.quad(), e = pose.eye;
      for (const o of this.occluders) {
        let hit = false;
        for (let j = 0; j <= 2 && !hit; j++) for (let i = 0; i <= 2 && !hit; i++) {
          const top = add(q[0], mul(sub(q[1], q[0]), i / 2)), bot = add(q[3], mul(sub(q[2], q[3]), i / 2));
          const p = add(top, mul(sub(bot, top), j / 2)), dv = sub(p, e), L = Math.hypot(...dv);
          if (rayBox(e, mul(dv, 1 / L), o.box, L - 0.01)) hit = true;
        }
        if (hit) polys.push(boxCorners(o.box));
      }
    }
    if (!polys.length) { if (this.clipped) { this.el.style.clipPath = ""; this.clipped = false; } return; }
    const [bw, bh] = this.box;
    const Hi = quadToQuad(S, [[0, 0], [bw, 0], [bw, bh], [0, bh]]);
    if (!Hi) return;
    const toLocal = (x, y) => { const k = Hi[6] * x + Hi[7] * y + Hi[8]; return Math.abs(k) < 1e-9 ? null : [(Hi[0] * x + Hi[1] * y + Hi[2]) / k, (Hi[3] * x + Hi[4] * y + Hi[5]) / k]; };
    let path = `M0 0H${bw}V${bh}H0Z`, any = false;
    for (const pts of polys) {
      const P = pts.map((p) => project(pose, p, w, h)).filter(Boolean).map((p) => toLocal(p[0], p[1])).filter(Boolean);
      const hl = hull(P);
      if (hl.length > 2) { path += `M${hl.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`; any = true; }
    }
    if (!any) { if (this.clipped) { this.el.style.clipPath = ""; this.clipped = false; } return; }
    this.el.style.clipPath = `path(evenodd, "${path}")`;
    this.clipped = true;
  }
}

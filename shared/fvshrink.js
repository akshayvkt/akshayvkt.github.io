// DYS-230 (G; renders/coordinator/FIRST-VISIT-LOCK-SPEC.md steps 4-5). The first visit's full-viewport lock screen
// shrinks and tilts onto the laptop's screen in the picture: its four corners go from the viewport's to the screen box's
// (app.js placeFvScreen's .fv-screen, mapped onto the photograph's screen quad), exactly, and its own box goes from the
// viewport's size to the screen box's (lock.resize each frame, so a portrait phone's layout is never squashed). At the
// end it IS the box's picture, so app.js moves its lock into the box with no pop. Plain HTML/CSS: one matrix3d and one
// resize a frame, no canvas, no filter.
//
//   const q = boxQuad(box);   // the box's corners on screen now (client px: top-left, top-right, bottom-right, bottom-left)
//   const landed = await shrink(layer, { quad: () => boxQuad(box), to: () => [W0, H0], lay: fit(vw, vh), resize: (w, h) => lock.resize(w, h, true),
//     camera: (z, F) => ... });   // (round 2: the room picture zoomed z about F with it, one camera)

export const SHRINK_MS = 900;
// (DYS-230 round 2c, Akshay: "one continuous camera pull-back" from the full lock to the room, ~2.5-3 s, a gentle start
// and landing) the whole move's length and its one curve, across the 2D zoom here and the room's 3D pull back
export const MOVE_MS = 2700;
export const MOVE_EASE = cubicBezier(0.45, 0, 0.2, 1);
// One move from the tap to the room: the camera's log-scale shared between the 2D zoom (z0 -> 1: the room picture
// magnified about the laptop's screen, back to the close opening's framing) and the 3D pull back (kc -> 1: the close
// opening's framing out to the room's, kc its zoom), so one speed curve E runs through both with no change of speed
// where they meet (both move ln-scale at L x E'/T). m: the 2D share; ts: when the 2D part ends (E(ts / T) = m);
// ease2d(u): the 2D part's k over its own ts; ease3d(t): the 3D part's k at t ms since the move's start.
export function oneMove(z0, kc, T = MOVE_MS, E = MOVE_EASE) {
  const a = Math.log(Math.max(1, z0)), b = Math.log(Math.max(1, kc)), m = a + b > 0 ? a / (a + b) : 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (E(mid) < m) lo = mid; else hi = mid; }
  const ts = m >= 1 ? T : hi * T;
  return {
    m, ts, T,
    ease2d: (u) => (m > 0 ? Math.min(1, E(Math.min(1, (u * ts) / T)) / m) : 1),
    ease3d: (t) => (m < 1 ? Math.max(0, Math.min(1, (E(Math.min(1, Math.max(0, t / T))) - m) / (1 - m))) : 1),
  };
}
// an Apple-like ease-out (the spec's cubic-bezier(0.32, 0.72, 0, 1))
export const EASE = cubicBezier(0.32, 0.72, 0, 1);

// CSS's cubic-bezier(x1, y1, x2, y2) as a function of u in [0, 1] (Newton, then bisection where the slope is flat)
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  return (u) => {
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    let t = u;
    for (let i = 0; i < 8; i++) {
      const e = X(t) - u, d = dX(t);
      if (Math.abs(e) < 1e-7) return Y(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = u;
    for (let i = 0; i < 40; i++) {
      const x = X(t);
      if (Math.abs(x - u) < 1e-7) break;
      if (x < u) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

// The homography taking the box (0, 0)-(w, h) to the quad C (TL, TR, BR, BL), row-major h00..h22 (closed form, the
// square to a quad: Heckbert), or null for a degenerate quad
export function rectToQuad(w, h, C) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = C;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a, b, c = x0, d, e, f = y0, g = 0, k = 0;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = x1 - x0; b = x3 - x0; d = y1 - y0; e = y3 - y0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) return null;
    g = (sx * dy2 - dx2 * sy) / det; k = (dx1 * sy - sx * dy1) / det;
    a = x1 - x0 + g * x1; b = x3 - x0 + k * x3; d = y1 - y0 + g * y1; e = y3 - y0 + k * y3;
  }
  return [a / w, b / h, c, d / w, e / h, f, g / w, k / h, 1];
}
// a homography on a point
export const apply = (H, [x, y]) => {
  const z = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
};
// CSS matrix3d for a homography on an element with transform-origin 0 0 (no exponents: CSS parses plain numbers)
export function cssMatrix(H) {
  const n = (v) => { const s = (+v.toFixed(12)).toString(); return s.includes("e") ? v.toFixed(12) : s; };
  return `matrix3d(${n(H[0])},${n(H[3])},0,${n(H[6])},${n(H[1])},${n(H[4])},0,${n(H[7])},0,0,1,0,${n(H[2])},${n(H[5])},0,${n(H[8])})`;
}

// The box's corners where the browser draws them now: four zero-size markers at its corners (made once, kept in it),
// each one's client rect is its point through every transform above it (the box's homography, the phone's level turn,
// the hero's offset), so nothing here re-derives app.js's chain. null when the box isn't drawn (display none, gone)
export function boxQuad(box) {
  if (!box?.isConnected) return null;
  let m = box.querySelectorAll(":scope > .fv-q");
  if (m.length !== 4) {
    for (const x of m) x.remove();
    const doc = box.ownerDocument;
    m = [["0", "0"], ["100%", "0"], ["100%", "100%"], ["0", "100%"]].map(([l, t]) => {
      const s = doc.createElement("i");
      s.className = "fv-q";
      s.setAttribute("aria-hidden", "true");
      s.style.cssText = `position:absolute;left:${l};top:${t};width:0;height:0;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none`;
      box.appendChild(s);
      return s;
    });
  }
  const Q = [...m].map((s) => { const r = s.getBoundingClientRect(); return [r.left, r.top]; });
  const span = Math.max(...Q.map((p) => p[0])) - Math.min(...Q.map((p) => p[0]));
  return span > 1 && Q.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])) ? Q : null;
}

// (DYS-230 round 2, Akshay: 'a real camera zoom-out, not a shrink onto a still') The camera: the room picture magnified
// z0 about F (client px) so the laptop's screen quad Q fills the viewport V (contained: its bounding box fits one side
// exactly, centred), or null when it already does. Zooming out, z goes z0 -> 1 as z0^(1 - k) (a camera's even pull back).
// fit 'height' (round 2b): the quad's height onto V's (V the screen-shaped frame the full lock fills, its width follows)
export function cameraFor(Q, V, fit = "contain") {
  const xs = Q.map((p) => p[0]), ys = Q.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  const vw = V[1][0] - V[0][0], vh = V[3][1] - V[0][1];
  if (!(bw > 0 && bh > 0)) return null;
  const z0 = fit === "height" ? vh / bh : Math.min(vw / bw, vh / bh), q = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
  const v = [V[0][0] + vw / 2, V[0][1] + vh / 2];
  if (!(z0 > 1.001)) return null;
  return { z0, F: [(v[0] - z0 * q[0]) / (1 - z0), (v[1] - z0 * q[1]) / (1 - z0)] };
}
// (round 2b, Akshay: 'like a camera starting from the full screen's recording of the lock screen') The full lock is the
// laptop's screen seen from up close: a frame of the screen's shape (aspect A) filling the viewport, its height the
// viewport's (a portrait phone: wider than it, the sides cut; a laptop: the same), unless that would cut its top and
// bottom by more than 6 % (a wide window, a phone on its side: then thin bands at its sides). Client px, TL TR BR BL.
export function fullFrame(vw, vh, A = 1.6) {
  const h = Math.min(Math.max(vh, vw / A), vh * 1.06), w = h * A, x = (vw - w) / 2, y = (vh - h) / 2;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}
// a point zoomed z about F
export const zoomAt = (p, z, F) => [F[0] + z * (p[0] - F[0]), F[1] + z * (p[1] - F[1])];

// The box a layout of shape w x h is laid out in: the largest of that shape inside vw x vh (the viewport at the tap), so
// a shape going from the viewport's to the laptop screen's changes the layout's shape, never its scale (the matrix3d
// does the shrinking): on a laptop (the same shape) nothing in it moves
export const fit = (vw, vh) => (w, h) => { const s = Math.min(vw / w, vh / h); return [w * s, h * s]; };

// The shrink. el: the full-viewport layer (fixed at the viewport's corner). Each frame, read first (quad(), to()), then
// written: the box's shape w x h from el's own now to to()'s (the screen box's W0 x H0), el laid out at lay(w, h) (by
// default w x h itself) and resize(...) (its lock laid out at that size), and the matrix3d taking that onto the corners
// eased from el's own to quad()'s. The quad is read
// every frame, so a rotation or a resize mid-way lands on the new one; the first frame is el as it is (no pop at the
// tap), the last is exactly the box's place. Resolves true when it lands, false when there is no quad to land on (the box
// hidden: a failed boot mid-way), el left where it was. hold (a fraction, for I's proof takes: ?shrinkhold=): it stops on
// that frame (el.dataset.shrinkHeld) until globalThis.__sfwShrinkGo(), then goes on from there.
// camera(z, F) (round 2): the room picture is one scene with el under one camera. The quad is read once at the start (the
// room at its framing), the room zoomed z0 about F at once (cameraFor: the screen fills the viewport, el over it), and
// each frame z = z0^(1 - k) with el's corners on the zoomed screen quad, the viewport's offset from it at k 0 fading to
// none at k 1 (z 1: the room at its framing, el on the box). A quad that moves otherwise (a rotation) lands at once.
export function shrink(el, { quad, to, resize, lay = (w, h) => [w, h], ms = SHRINK_MS, ease = EASE, raf = (f) => requestAnimationFrame(f), onFrame, hold = null, camera = null, camFit = "contain", from = null, cam0 = null } = {}) {
  // (cam0, round 2c: { Q0, z0, F }: the camera's first frame already applied before the tap, the room at z0 about F, Q0
  // the box's quad at its framing: the first frame changes nothing)
  // (from, round 2b: el's corners now when its box isn't the viewport, fullFrame's; its untransformed origin the viewport's)
  const r = from ? null : el.getBoundingClientRect();
  const x0 = r ? r.left : 0, y0 = r ? r.top : 0, w0 = r ? r.width : from[1][0] - from[0][0], h0 = r ? r.height : from[3][1] - from[0][1];
  const V = from || [[x0, y0], [x0 + w0, y0], [x0 + w0, y0 + h0], [x0, y0 + h0]];
  el.style.transformOrigin = "0 0";
  const Q0 = camera ? (cam0 ? cam0.Q0.map((p) => [...p]) : quad()) : null;
  const cam = !Q0 ? null : cam0 ? { z0: cam0.z0, F: cam0.F } : cameraFor(Q0, V, camFit);
  let zPrev = cam0 && cam ? cam0.z0 : 1;
  return new Promise((res) => {
    let t0 = null, base = 0, held = !(hold > 0 && hold < 1);
    const step = (t) => {
      const Q = quad(), S = to();
      if (!Q || !(S?.[0] > 0 && S?.[1] > 0)) { res(false); return; }
      if (t0 === null) t0 = t;
      let u = Math.min(1, Math.max(0, base + (t - t0) / ms));
      if (cam) {   // (where the box would be with the room at its framing: moved by more than the zoom, land on it now)
        const back = Q.map((p) => zoomAt(p, 1 / zPrev, cam.F));
        if (Math.max(...back.map((p, i) => Math.hypot(p[0] - Q0[i][0], p[1] - Q0[i][1]))) > 1) { Q0.splice(0, 4, ...back); u = 1; }
      }
      const stop = !held && u >= hold;
      if (stop) { u = hold; held = true; }
      const k = u >= 1 ? 1 : ease(u);
      const w = w0 + (S[0] - w0) * k, h = h0 + (S[1] - h0) * k;
      const [lw, lh] = lay(w, h);
      let C, z = 1;
      if (cam) {
        z = k >= 1 ? 1 : cam.z0 ** (1 - k);
        C = Q0.map((p, i) => { const a = zoomAt(p, z, cam.F), b = zoomAt(p, cam.z0, cam.F); return [a[0] + (1 - k) * (V[i][0] - b[0]) - x0, a[1] + (1 - k) * (V[i][1] - b[1]) - y0]; });
      } else C = V.map((p, i) => [p[0] + (Q[i][0] - p[0]) * k - x0, p[1] + (Q[i][1] - p[1]) * k - y0]);
      const H = rectToQuad(lw, lh, C);
      if (!H) { res(false); return; }
      el.style.width = `${lw.toFixed(3)}px`;
      el.style.height = `${lh.toFixed(3)}px`;
      resize?.(lw, lh);
      el.style.transform = cssMatrix(H);
      if (cam) { camera(z, cam.F); zPrev = z; }
      onFrame?.({ u, k, w, h, lw, lh, z, C: C.map((p) => [p[0] + x0, p[1] + y0]), Q });
      if (stop) {
        el.dataset.shrinkHeld = String(hold);
        globalThis.__sfwShrinkGo = () => { delete el.dataset.shrinkHeld; globalThis.__sfwShrinkGo = null; base = hold; t0 = null; raf(step); };
      } else if (u < 1) raf(step); else res(true);
    };
    raf(step);
  });
}

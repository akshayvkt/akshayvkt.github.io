// Framing: the rest pose of a spot for this screen's shape, so its must-see objects are always in sight.
//
//   import { frameSpot, cropPose, mustSeeReport } from "/shared/framing.js";
//   frameSpot(room, "shelf", { w, h, reserve: { bottom: 110, left: 420 } })   // -> pose (shared/rig.js)
//   cropPose(camera, [W, H], geo, box)      // the pose that shows exactly what a cover-cropped photograph shows
//   mustSeeReport(room, "shelf", pose, vp)  // which must-see objects are inside the free part of the screen
//   underReserve(room, "shelf", pose, vp)   // how much of them lies under a card (orbit limits)
//
// The rules (plan v2 4.4 and 3.4):
//   - every spot starts from its own lens at its photograph's shape; on wider screens the vertical field is kept
//     and the horizontal grows (the room is 3D, so nothing is cropped away); ultrawide desks ease the turn;
//   - narrower screens keep the must-see objects: first the eye steps back (up to 0.6 m, or the orbit's distance
//     range, within the room's rules), then the vertical field widens (to 45 degrees at the desk);
//   - 0.75-1.0 blends the landscape and portrait framings; under 0.75 the desk uses its portrait lens (home_p);
//   - cards and the masthead move objects with a lens shift, never by moving the camera: the shift is the
//     smallest that brings every must-see object into the free part of the screen.
import { basis, sub, add, mul, dot, project, clamp, keepInRoom } from "./rig.js";

const DEG = Math.PI / 180;
const SENSOR = 36;                     // mm, Blender's default sensor width (render_frames.py, build.py)
const PORTRAIT_BELOW = 0.75, LANDSCAPE_FROM = 1.0;
const MAX_STEP = 0.6;                  // m, how far the eye may step back for a narrow screen
const MAX_V = { desk: 45, default: 62, portrait: 78 };   // degrees of vertical field, at most
const MARGIN = 0.035;                  // of the free region's smaller side, kept clear around must-see objects

const tanHalf = (deg) => Math.tan((deg * DEG) / 2);

// The spot's lens as a pose (no framing yet): its eye and look, and its photograph's vertical field.
export function lensPose(spot, variant) {
  const v = variant || spot;
  const tanH = SENSOR / 2 / v.lens;
  const aspect = v.aspect || spot.aspect || 16 / 9;
  const tanV = v.fit === "vertical" ? tanH : tanH / aspect;
  return {
    eye: spot.eye.slice(),
    yaw: v.yaw ?? spot.yaw,
    pitch: v.pitch ?? spot.pitch,
    tanV,
    shiftTan: (v.shiftTan || spot.shiftTan || [0, 0]).slice(),
    focus: spot.focus ?? null,
    fstop: spot.fstop ?? null,
    aspect,
  };
}

// The free part of the screen: the whole box minus the masthead (bottom), a card (left or right) and margins.
export function freeRegion(vp) {
  const r = vp.reserve || {};
  const L = r.left || 0, R = vp.w - (r.right || 0), T = r.top || 0, B = vp.h - (r.bottom || 0);
  const m = MARGIN * Math.min(R - L, B - T);
  return { L: L + m, R: R - m, T: T + m, B: B - m };
}

// Tangent coordinates (right, up) of points as seen from a pose's eye; null if any is behind it.
function tangents(pose, pts) {
  const Bs = basis(pose.yaw, pose.pitch);
  const out = [];
  for (const p of pts) {
    const d = sub(p, pose.eye), z = dot(d, Bs.f);
    if (z < 0.02) return null;
    out.push([dot(d, Bs.r) / z, dot(d, Bs.u) / z]);
  }
  return out;
}

// For a pose, the vertical field it needs and the smallest lens shift that puts every point in the free region.
function fit(pose, pts, vp) {
  const T = tangents(pose, pts);
  if (!T) return null;
  const a = vp.w / vp.h, F = freeRegion(vp);
  const fw = (F.R - F.L) / vp.w, fh = (F.B - F.T) / vp.h;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of T) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const needV = Math.max((x1 - x0) / (2 * a * fw), (y1 - y0) / (2 * fh));
  return { needV, x0, x1, y0, y1, F, a };
}

// The shift (tangent units) that keeps the points inside the free region at tanV, as close as possible to `prefer`.
function shiftFor(f, tanV, vp, prefer) {
  const { F, a } = f;
  // x on screen = w/2 + (t - tx) / (tanV a) * w/2  ->  inside [L, R]  <=>  t - tx in [eL, eR]
  const eL = ((F.L - vp.w / 2) / (vp.w / 2)) * tanV * a, eR = ((F.R - vp.w / 2) / (vp.w / 2)) * tanV * a;
  const eB = (-(F.B - vp.h / 2) / (vp.h / 2)) * tanV, eT = (-(F.T - vp.h / 2) / (vp.h / 2)) * tanV;
  const tx = between(f.x1 - eR, f.x0 - eL, prefer[0]);
  const ty = between(f.y1 - eT, f.y0 - eB, prefer[1]);
  return [tx, ty];
}
const between = (lo, hi, v) => (lo <= hi ? clamp(v, lo, hi) : (lo + hi) / 2);

// One orientation's framing: from the lens pose, step back, then widen, then shift.
function frameOne(room, name, vp, variant, mustNames, maxV) {
  const spot = room.spots[name];
  const base = lensPose(spot, variant);
  const a = vp.w / vp.h;
  // wider than the photograph: keep the vertical field (the horizontal grows); narrower: keep it too, and let
  // the must-see fit below widen it only as much as the objects need
  let pose = { ...base };
  const wide = variant ? null : spot.wideYaw;
  if (wide && a > wide[0][0]) {
    const t = clamp((a - wide[0][0]) / (wide[1][0] - wide[0][0]), 0, 1);
    pose.yaw = base.yaw + wide[0][1] + (wide[1][1] - wide[0][1]) * t;
  }
  const pts = mustNames.flatMap((n) => room.points(n) || []);
  const vis = (variant ? [] : room.visible(name)).flatMap((n) => room.points(n) || []);
  if (!pts.length) return pose;
  const maxTan = tanHalf(maxV);
  const o = spot.orbit || {};
  const maxStep = o.distance ? Math.max(0, o.distance[1] - pivotDistance(pose, o.pivot)) : Math.min(MAX_STEP, o.stepBack ?? 0);
  let f = fit(pose, pts, vp);
  let step = 0;
  const f0 = basis(pose.yaw, pose.pitch).f;
  while (f && f.needV > pose.tanV * 1.0001 && step < maxStep - 1e-9) {
    step = Math.min(maxStep, step + 0.04);
    const moved = keepInRoom(room, { ...pose, eye: add(base.eye, mul(f0, -step)) });
    if (Math.abs(dot(sub(moved.eye, base.eye), f0) + step) > 0.02) break;   // the room stops the step back
    pose = { ...pose, eye: moved.eye };
    f = fit(pose, pts, vp);
  }
  if (f && f.needV > pose.tanV) pose.tanV = Math.min(maxTan, Math.max(pose.tanV, f.needV));
  if (f) pose.shiftTan = shiftFor(f, pose.tanV, vp, base.shiftTan);
  // objects that only have to be on screen (under the masthead is fine): widen a little if one is not
  if (vis.length) {
    const whole = { w: vp.w, h: vp.h, reserve: {} };
    const g = fit(pose, pts.concat(vis), whole);
    if (g && g.needV > pose.tanV) pose.tanV = Math.min(maxTan, g.needV);
    if (g) {
      const s2 = shiftFor(g, pose.tanV, whole, pose.shiftTan);
      const f2 = fit(pose, pts, vp);
      pose.shiftTan = f2 ? shiftFor(f2, pose.tanV, vp, s2) : s2;
    }
  }
  return pose;
}
function pivotDistance(pose, pivot) { return Math.hypot(...sub(pose.eye, pivot)); }

function blend(a, b, t) {
  const l = (x, y) => x + (y - x) * t;
  return {
    ...b,
    eye: [l(a.eye[0], b.eye[0]), l(a.eye[1], b.eye[1]), l(a.eye[2], b.eye[2])],
    yaw: l(a.yaw, b.yaw), pitch: l(a.pitch, b.pitch),
    tanV: Math.exp(l(Math.log(a.tanV), Math.log(b.tanV))),
    shiftTan: [l(a.shiftTan[0], b.shiftTan[0]), l(a.shiftTan[1], b.shiftTan[1])],
  };
}

// The spot's rest pose for a screen { w, h, reserve }.
export function frameSpot(room, name, vp) {
  const spot = room.spots[name];
  if (!spot) throw new Error(`no spot ${name}`);
  const a = vp.w / vp.h;
  const land = (v) => frameOne(room, name, v, null, room.mustSee(name, false), name === "desk" ? MAX_V.desk : MAX_V.default);
  const port = (v) => frameOne(room, name, v, spot.portrait || null, room.mustSee(name, true), MAX_V.portrait);
  if (a >= LANDSCAPE_FROM) return land(vp);
  if (a < PORTRAIT_BELOW) return port(vp);
  // 0.75-1.0: blend the landscape framing (as at 1.0) and the portrait one (as at 0.75), at this screen's size
  const t = (a - PORTRAIT_BELOW) / (LANDSCAPE_FROM - PORTRAIT_BELOW);
  const L = land({ ...vp, w: vp.h * LANDSCAPE_FROM }), P = port({ ...vp, w: vp.h * PORTRAIT_BELOW });
  const out = blend(P, L, t);
  // the blend's ends were fitted at other widths: re-fit the shift (and widen if needed) for this one
  const pts = (t >= 0.5 ? room.mustSee(name, false) : room.mustSee(name, true)).flatMap((n) => room.points(n) || []);
  const f = pts.length ? fit(out, pts, vp) : null;
  if (f) {
    if (f.needV > out.tanV) out.tanV = Math.min(tanHalf(MAX_V.portrait), f.needV);
    out.shiftTan = shiftFor(f, out.tanV, vp, out.shiftTan);
  }
  return out;
}

// The pose that reproduces a cover-cropped photograph exactly (plan 3.4): `camera` is the photograph's camera
// (spots.json cameras), size its render size, geo the layout that placed it in the box (app.js layout() or
// room.js layoutView(): the photograph's full frame is w x h CSS px with its top-left at left, top).
export function cropPose(camera, size, geo, box) {
  const [W, H] = size;
  const fit = camera.fit === "AUTO" ? (W >= H ? "HORIZONTAL" : "VERTICAL") : String(camera.fit).toUpperCase();
  const half = SENSOR / 2 / camera.lens;
  const tanH = fit === "HORIZONTAL" ? half : half * (W / H);
  const tanV = tanH / (W / H);
  const st = camera.shiftTan || [0, 0];
  const cx = -geo.left + box.w / 2, cy = -geo.top + box.h / 2;
  return {
    eye: camera.eye.slice(),
    yaw: camera.yaw, pitch: camera.pitch,
    tanV: tanV * (box.h / geo.h),
    shiftTan: [st[0] + ((cx - geo.w / 2) / (geo.w / 2)) * tanH, st[1] - ((cy - geo.h / 2) / (geo.h / 2)) * tanV],
    focus: camera.focus ?? null, fstop: camera.fstop ?? null,
  };
}

// How much of the spot's must-see objects lies under the reserved strips of the screen (a card: reserve.left,
// .right or .bottom), as the largest fraction of any one object's box on screen. Leaving the screen's edges does
// not count: that is looking around, not hiding something under a card.
export function underReserve(room, name, pose, vp, portrait = vp.w / vp.h < PORTRAIT_BELOW) {
  const r = vp.reserve || {};
  const strips = [];
  if (r.left) strips.push([0, 0, r.left, vp.h]);
  if (r.right) strips.push([vp.w - r.right, 0, vp.w, vp.h]);
  if (r.bottom) strips.push([0, vp.h - r.bottom, vp.w, vp.h]);
  let worst = 0;
  for (const n of room.mustSee(name, portrait)) {
    const P = (room.points(n) || []).map((p) => project(pose, p, vp.w, vp.h));
    if (!P.length || P.some((p) => !p)) continue;
    const x0 = Math.min(...P.map((p) => p[0])), x1 = Math.max(...P.map((p) => p[0]));
    const y0 = Math.min(...P.map((p) => p[1])), y1 = Math.max(...P.map((p) => p[1]));
    const area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
    let under = 0;   // the strips may overlap (a corner): take the largest, a fair lower bound of their union
    for (const [a0, b0, a1, b1] of strips) under = Math.max(under, Math.max(0, Math.min(x1, a1) - Math.max(x0, a0)) * Math.max(0, Math.min(y1, b1) - Math.max(y0, b0)));
    worst = Math.max(worst, under / area);
  }
  return worst;
}

// Which must-see objects a pose keeps inside the free part of the screen, and how much of each is cut.
export function mustSeeReport(room, name, pose, vp, portrait = vp.w / vp.h < PORTRAIT_BELOW) {
  const F = freeRegion({ ...vp, reserve: vp.reserve });
  const tol = 1.5;   // px
  const objects = room.mustSee(name, portrait).map((n) => {
    const P = (room.points(n) || []).map((p) => project(pose, p, vp.w, vp.h));
    if (!P.length || P.some((p) => !p)) return { name: n, inside: false, cut: 1 };
    const x0 = Math.min(...P.map((p) => p[0])), x1 = Math.max(...P.map((p) => p[0]));
    const y0 = Math.min(...P.map((p) => p[1])), y1 = Math.max(...P.map((p) => p[1]));
    const fl = vp.reserve?.left || 0, fr = vp.w - (vp.reserve?.right || 0), ft = vp.reserve?.top || 0, fb = vp.h - (vp.reserve?.bottom || 0);
    const iw = Math.max(0, Math.min(x1, fr) - Math.max(x0, fl)), ih = Math.max(0, Math.min(y1, fb) - Math.max(y0, ft));
    const area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
    return {
      name: n,
      inside: x0 >= fl - tol && x1 <= fr + tol && y0 >= ft - tol && y1 <= fb + tol,
      cut: 1 - (iw * ih) / area,
      box: [x0, y0, x1, y1].map((v) => Math.round(v)),
    };
  });
  for (const n of portrait ? [] : room.visible(name)) {
    const P = (room.points(n) || []).map((p) => project(pose, p, vp.w, vp.h));
    const ok = P.length && P.every((p) => p && p[0] >= -tol && p[0] <= vp.w + tol && p[1] >= -tol && p[1] <= vp.h + tol);
    objects.push({ name: n, inside: !!ok, cut: ok ? 0 : 1, onlyOnScreen: true });
  }
  return { ok: objects.every((o) => o.inside), cut: Math.max(0, ...objects.map((o) => o.cut)), objects, free: F };
}

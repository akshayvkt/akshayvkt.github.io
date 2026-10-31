// The camera rig: where the eye is, where it looks, and how it moves between the room's spots.
//
//   import { Rig, project, toEngineCamera } from "/shared/rig.js";
//   const rig = new Rig(room, { frame: (spot) => framedRestPose, onPose: (pose) => … });
//   rig.jumpTo("desk");                  // no motion (deep links, reduced motion, rotation under reduced motion)
//   await rig.glideTo("shelf");          // a glide; a second call during it re-aims from the current pose and speed
//   rig.drag(dx, dy); rig.release();     // orbit within the spot's limits (pixels of pointer travel)
//   rig.zoomBy(metres)                   // dolly along the look, eased, within the spot's orbit.zoom and clear of the room;
//                                        // where magCap(spot) > 1 (the desk, the window: v3/zoom-r3) zooming in magnifies
//                                        // the outside alone (rig.view, the outside's own pose; the room stays at 1x and
//                                        // the router fades it out), the point under `at` kept still
//   rig.tick(now)                        // advance; called once per drawn frame (engine pass update) or per rAF
//
// A pose is { eye: [x, y, z], yaw, pitch, tanV, shiftTan: [tx, ty], focus, fstop }, in the engine's room-local
// metres (x right, y up, -z toward the window) and degrees (yaw to the left of the window axis, pitch up).
// tanV is the tangent of half the vertical field of view for the screen the pose was framed for; shiftTan is
// where the screen's centre sits off the optical axis, in the same tangent units (a lens shift that holds for
// any screen shape). The orbit limits, pivots and obstacles all come from the spot data (shared/spots.js).
//
// Plan v2 section 4: orbit models (pivot, head), limits that stretch about 6 degrees and ease back, glides of
// 0.9 + 0.35 s/m + 0.012 s/deg (0.9 to 2.4 s) where the head leads (look over 0-80 %, position over 10-100 %), sine
// easing, focal length blended on a log scale, paths that go through the desk eye with a small lift when the
// straight line clips the furniture or passes within 0.25 m of the lamp, re-aiming that keeps the current speed.

const DEG = Math.PI / 180;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
export const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));   // sine
const h10 = (t) => t * (1 - t) * (1 - t);                                     // Hermite: unit slope at 0, flat at 1

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vlerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// The direction for a yaw (left of the window axis) and a pitch (up), and the camera's right and up.
export function dirOf(yaw, pitch) {
  const y = yaw * DEG, p = pitch * DEG;
  return [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}
// Live room 2 (16 Oct): no pose may look past straight down or up. Beyond +-90 degrees the look's horizontal part
// reverses and the camera's lookAt (world up) turns the picture upside down (Akshay's flip at the phone, which rests
// at -88.8 with a +-6 degree orbit and its stretch); PITCH_MAX keeps every orbit, stretch, ease and glide short of it.
export const PITCH_MAX = 89.5;
export const TOP_DOWN = 80;      // a spot that looks down this steeply (the phone) does not spin with a sideways drag
export function basis(yaw, pitch) {
  const f = dirOf(yaw, clamp(pitch, -PITCH_MAX, PITCH_MAX));
  const r = normalize(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return { f, r, u };
}
export function yawPitchOf(d) {
  const n = normalize(d);
  return { yaw: Math.atan2(-n[0], -n[2]) / DEG, pitch: Math.asin(clamp(n[1], -1, 1)) / DEG };
}
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;

// A room-local point on screen: CSS px (x right, y down) plus its depth; null when behind the eye.
export function project(pose, p, w, h, B = basis(pose.yaw, pose.pitch)) {
  const d = sub(p, pose.eye);
  const z = dot(d, B.f);
  if (z < 1e-4) return null;
  const a = w / h;
  const tx = dot(d, B.r) / z, ty = dot(d, B.u) / z;
  return [w / 2 + ((tx - pose.shiftTan[0]) / (pose.tanV * a)) * (w / 2), h / 2 - ((ty - pose.shiftTan[1]) / pose.tanV) * (h / 2), z];
}
// The ray through a screen point (for picking against the room's boxes).
export function ray(pose, x, y, w, h) {
  const B = basis(pose.yaw, pose.pitch), a = w / h;
  const tx = ((x - w / 2) / (w / 2)) * pose.tanV * a + pose.shiftTan[0];
  const ty = (-(y - h / 2) / (h / 2)) * pose.tanV + pose.shiftTan[1];
  return { o: pose.eye, d: normalize(add(B.f, add(mul(B.r, tx), mul(B.u, ty)))) };
}

// What E1's engine.camera.set() takes (docs/v3/engine-api.md section 3).
export function toEngineCamera(pose, aspect) {
  const B = basis(pose.yaw, pose.pitch);
  return {
    position: pose.eye.slice(),
    target: add(pose.eye, B.f),
    up: [0, 1, 0],
    fovY: (2 * Math.atan(pose.tanV)) / DEG,
    shift: [pose.shiftTan[0] / (2 * pose.tanV * aspect), pose.shiftTan[1] / (2 * pose.tanV)],
    focus: pose.focus && pose.fstop ? { distance: pose.focus, fStop: pose.fstop } : null,
  };
}

export function clonePose(p) {
  return { eye: p.eye.slice(), yaw: p.yaw, pitch: p.pitch, tanV: p.tanV, shiftTan: p.shiftTan.slice(), focus: p.focus ?? null, fstop: p.fstop ?? null };
}

// ---------- the room's rules ----------
// Signed distance from a point to a box (negative inside), and the direction out of it. Inside, `lim` ([lo, hi], where
// the eye may be: keepInRoom's) takes the nearest face whose far side is within it, if any (bug 26 Oct, BUG-3: never out
// of the desk through its bottom, under the floor).
function boxDistance(p, [a, b], lim = null) {
  const q = [0, 1, 2].map((i) => Math.max(a[i] - p[i], 0, p[i] - b[i]));
  const out = len(q);
  if (out > 0) return { d: out, n: normalize([0, 1, 2].map((i) => (p[i] < a[i] ? -q[i] : p[i] > b[i] ? q[i] : 0))) };
  // inside: the nearest face
  let best = Infinity, n = [0, 1, 0];
  for (const only of lim ? [true, false] : [false]) {
    for (let i = 0; i < 3; i++) {
      for (const [v, s, at] of [[p[i] - a[i], -1, a[i]], [b[i] - p[i], 1, b[i]]]) {
        if (only && (at < lim[0][i] || at > lim[1][i])) continue;
        if (v < best) { best = v; n = [0, 0, 0]; n[i] = s; }
      }
    }
    if (best < Infinity) break;
  }
  return { d: -best, n };
}
function capsuleDistance(p, [a, b], r) {
  const ab = sub(b, a), t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0, 1);
  const c = add(a, mul(ab, t)), v = sub(p, c);
  return { d: len(v) - r, n: normalize(v) };
}
function obstacleDistance(p, o, inflate = 0, lim = null) {
  if (o.box) return boxDistance(p, inflate ? [sub(o.box[0], [inflate, inflate, inflate]), add(o.box[1], [inflate, inflate, inflate])] : o.box, lim);
  if (o.capsule) return capsuleDistance(p, o.capsule, (o.radius || 0.1) + inflate);
  return { d: Infinity, n: [0, 1, 0] };
}

// The drawn camera stays inside the room: it slides along its line of sight until it is (felix-style), and
// furniture pushes it out on a gentle ramp, so a drag glides over the desk instead of snapping.
// (bug 26 Oct, BUG-3: a walk in toward the floor, then a drag, took the eye under the desk, out through the floor, inside
// furniture.) Then the room's hard limits, which only a pose that breaks them meets, so every other pose is as it was to
// the last bit: never below the eye floor (the desk's top + 1 cm, shared/spots.js), lifted straight up before the push so
// the push sees where the eye is; out of a box only through a face that leads back into the room (not the desk's bottom);
// the things standing on the desk pushed from as the furniture is (room.onDesk); the box and the floor once more; and if
// something is still nearer than NEAR_CLEAR (two pieces close together push the eye into each other, the lamp and the
// plant overlap), the nearest place clear of everything (clearOf).
const NEAR_CLEAR = 0.04;   // m: nearer than this to a box, the camera's near plane (3 cm) could cut into it
// The nearest place to `eye` within `lim` that every box clears by `c`: out of a box too near it along one of the room's
// axes, then (if another is too near there) out of that one along another; with none, straight up above them all.
function clearOf(eye, stuff, lim, c) {
  const inLim = (q) => q.every((v, i) => v >= lim[0][i] && v <= lim[1][i]);
  const near = (q) => stuff.filter((o) => o.box && obstacleDistance(q, o).d < c - 1e-9);
  const moves = (q) => {
    const out = [];
    for (const o of near(q)) for (let i = 0; i < 3; i++) for (const s of [-1, 1]) {
      const r = q.slice(); r[i] = s < 0 ? o.box[0][i] - c : o.box[1][i] + c;
      if (inLim(r)) out.push(r);
    }
    return out;
  };
  let best = null, bd = Infinity;
  for (const q1 of moves(eye)) for (const q of near(q1).length ? moves(q1) : [q1]) {
    const d = len(sub(q, eye));
    if (d < bd && !near(q).length) { bd = d; best = q; }
  }
  if (best) return best;
  const up = eye.slice();
  up[1] = Math.min(lim[1][1], Math.max(eye[1], ...near(eye).map((o) => o.box[1][1] + c)));
  return up;
}
export function keepInRoom(room, pose) {
  const m = room.margin, [a, b] = room.inner, fl = belowEye(room);
  let eye = pose.eye.slice();
  const f = basis(pose.yaw, pose.pitch).f;
  for (let i = 0; i < 3; i++) {
    const lo = a[i] + m, hi = b[i] - m;
    if (eye[i] < lo && f[i] > 1e-3) eye = add(eye, mul(f, (lo - eye[i]) / f[i]));
    else if (eye[i] > hi && f[i] < -1e-3) eye = add(eye, mul(f, (hi - eye[i]) / f[i]));
    eye[i] = clamp(eye[i], lo, hi);
  }
  if (eye[1] < fl) eye[1] = fl;
  const ramp = 0.12, stuff = furniture(room);
  const lim = [[a[0] + m, Math.max(a[1] + m, fl), a[2] + m], [b[0] - m, b[1] - m, b[2] - m]];
  for (const o of stuff) {
    const { d, n } = obstacleDistance(eye, o, 0, lim);
    if (d < ramp) {
      const want = d > 0 ? ramp / 2 + (d * d) / (2 * ramp) : ramp / 2;   // smooth max(d, ramp/2)
      eye = add(eye, mul(n, want - d));
    }
  }
  for (let i = 0; i < 3; i++) eye[i] = clamp(eye[i], lim[0][i], lim[1][i]);
  if (stuff.some((o) => obstacleDistance(eye, o).d < NEAR_CLEAR)) eye = clearOf(eye, stuff, lim, ramp / 2);
  return eye === pose.eye ? pose : { ...pose, eye };
}
// The lowest the eye may go: the room's eye floor (shared/spots.js: the desk's top + 1 cm), else nothing below the box.
const belowEye = (room) => room.eyeFloor ?? -Infinity;
// What the eye keeps clear of: the furniture, and the things standing on the desk (shared/spots.js room.onDesk).
const furniture = (room) => (room.onDesk?.length ? [...room.obstacles, ...room.onDesk] : room.obstacles);

// Whether an orbited pose keeps the spot's own rules (desk: above the desk, inside x, not past the desk edge,
// never more than 50 degrees off the room's axis).
function spotRules(room, spot, pose, { walk = false } = {}) {
  const o = spot.orbit || {};
  if (o.maxOffAxis != null && Math.abs(pose.yaw) > o.maxOffAxis + 1e-6) return false;
  const e = pose.eye;
  if (o.eyeX && (e[0] < o.eyeX[0] - 1e-6 || e[0] > o.eyeX[1] + 1e-6)) return false;
  // (v3/zoom-r4: a walk in, walkRange, is held back by its own stop short of the surface it walks to instead of these
  // two, which keep the chair's eye back from the window and above the desk)
  if (walk) return true;
  if (o.eyeZMin != null && e[2] < o.eyeZMin - 1e-6) return false;
  if (o.eyeAboveDesk != null) {
    const desk = room.objects.desk?.box;
    if (desk && e[0] > desk[0][0] && e[0] < desk[1][0] && e[2] > desk[0][2] && e[2] < desk[1][2] && e[1] < desk[1][1] + o.eyeAboveDesk) return false;
  }
  return true;
}

// ---------- orbits ----------
// The pose at an orbit offset { yaw, pitch } (degrees) from a framed rest pose.
//   pivot: the whole rig turns about the spot's pivot (the composition is kept, the eye travels round it)
//   head:  the look turns about the eye, which leans sideways into the turn
export function orbitPose(spot, rest, off) {
  const o = spot.orbit || {};
  const yaw = rest.yaw + off.yaw, pitch = clamp(rest.pitch + off.pitch, -PITCH_MAX, PITCH_MAX);
  if (o.model === "pivot" && o.pivot) {
    const B0 = basis(rest.yaw, rest.pitch), B1 = basis(yaw, pitch);
    const rel = sub(rest.eye, o.pivot);
    const c = [dot(rel, B0.r), dot(rel, B0.u), dot(rel, B0.f)];
    const eye = add(o.pivot, add(add(mul(B1.r, c[0]), mul(B1.u, c[1])), mul(B1.f, c[2])));
    return { ...rest, eye, yaw, pitch };
  }
  const span = Math.max(Math.abs(o.yaw?.[0] ?? 15), Math.abs(o.yaw?.[1] ?? 15)) || 1;
  const right = normalize([Math.cos(rest.yaw * DEG), 0, -Math.sin(rest.yaw * DEG)]);
  const lean = (o.lean || 0) * clamp(off.yaw / span, -1, 1);
  return { ...rest, eye: add(rest.eye, mul(right, -lean)), yaw, pitch };
}

const softClamp = (v, lo, hi, s) => (v > hi ? hi + s * Math.tanh((v - hi) / s) : v < lo ? lo - s * Math.tanh((lo - v) / s) : v);

// The largest part of an offset the spot's rules allow (searching back toward the rest pose). `extra(pose)` is
// a rule that depends on the screen (the router's: an orbit never slides a must-see object under a card).
function allowed(room, spot, rest, off, extra = null) {
  const ok = (s) => { const p = orbitPose(spot, rest, { yaw: off.yaw * s, pitch: off.pitch * s }); return spotRules(room, spot, p) && (!extra || extra(p)); };
  if (ok(1)) return off;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return { yaw: off.yaw * lo, pitch: off.pitch * lo };
}

// ---------- zoom (a dolly along the look) ----------
// The direction a zoom moves the eye: the ray through the screen's centre (the look, bent by the lens shift), so
// what sits in the middle of the screen is what you move toward.
export function dollyDir(pose) {
  const B = basis(pose.yaw, pose.pitch), s = pose.shiftTan || [0, 0];
  return normalize(add(B.f, add(mul(B.r, s[0]), mul(B.u, s[1]))));
}
export function dollied(pose, d) {
  if (!d) return pose;
  const dir = dollyDir(pose), f = basis(pose.yaw, pose.pitch).f;
  const out = { ...pose, eye: add(pose.eye, mul(dir, d)) };
  if (pose.focus) out.focus = Math.max(0.05, pose.focus - d * dot(dir, f));   // the focus stays on what it was on
  return out;
}

const ZOOM_CLEAR = 0.1;     // m: a zoom stops this far from any obstacle (or where it started, if already closer)
const ZOOM_STEP = 0.01;     // m: the march along the look (well under ZOOM_CLEAR, so nothing is passed through)

// ---------- v3/zoom-r4: the walk in (a room spot's zoom) ----------
// At a room spot (every spot but the window, whose zoom is the binoculars) a zoom in walks the eye toward what is under
// the pointer, along the pointer's own ray: moving along that ray with the look unchanged, the thing aimed at stays
// exactly under the pointer while everything else grows around it. It stops WALK_STOP short of the surface the ray
// meets (WALK_GLASS_STOP short of the window glass), inside the room's box and clear of the furniture as a zoom is.
const WALK_STOP = 0.35;        // m short of a piece of furniture, a wall, the floor or the ceiling
const WALK_GLASS_STOP = 0.3;   // m short of the window glass
const WALK_CLEAR = 0.12;       // m: furniture clearance on a walk: keepInRoom's ramp, so it never nudges a walked eye (a nudge
                               // moves the point aimed at off the pointer: 3.75 px on a phone at the bottle, zoom-r4 take R1c)
const GLASS_Z = -1.4;          // the glass's plane (room3d.json objects.window_centre); the opening's x and y from opening()
// the opening the outside is drawn through when bake.json names none (gl/room.js DEFAULT_WINDOW)
export const DEFAULT_OPENING = [[-1.1, 0.82, -1.2], [1.1, 0.82, -1.2], [1.1, 2.55, -1.2], [-1.1, 2.55, -1.2]];

// The first surface a ray meets in the room's own geometry: { d (m), what, glass }. Every object's and obstacle's box
// (not the room's own, nor one the eye is inside), the floor, the ceiling and the walls; through the window opening
// (opening: its corners) the ray goes on to the glass.
export function surfaceHit(room, eye, dir, opening = DEFAULT_OPENING) {
  let best = { d: Infinity, what: "nothing", glass: false };
  const boxes = [];
  for (const o of room.obstacles || []) if (o.box) boxes.push([o.name, o.box]);
  for (const [k, v] of Object.entries(room.objects || {})) if (v && v.box && k !== "room") boxes.push([k, v.box]);
  for (const [name, [lo, hi]] of boxes) {
    let t0 = -Infinity, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dir[i]) < 1e-12) { if (eye[i] < lo[i] || eye[i] > hi[i]) { t0 = Infinity; break; } continue; }
      let a = (lo[i] - eye[i]) / dir[i], b = (hi[i] - eye[i]) / dir[i];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    if (t0 <= t1 && t0 > 1e-6 && t0 < best.d) best = { d: t0, what: name, glass: false };
  }
  const [A, B] = room.inner;
  const xs = opening.map((c) => c[0]), ys = opening.map((c) => c[1]);
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-12) continue;
    for (const [w, side] of [[A[i], -1], [B[i], 1]]) {
      const t = (w - eye[i]) / dir[i];
      if (!(t > 1e-6) || t >= best.d) continue;
      const p = add(eye, mul(dir, t));
      if (![0, 1, 2].every((j) => j === i || (p[j] >= A[j] - 1e-6 && p[j] <= B[j] + 1e-6))) continue;
      if (i === 2 && side === -1 && p[0] > Math.min(...xs) && p[0] < Math.max(...xs) && p[1] > Math.min(...ys) && p[1] < Math.max(...ys) && dir[2] < 0) {
        best = { d: (GLASS_Z - eye[2]) / dir[2], what: "the window glass", glass: true };   // (through the opening, to the glass)
      } else best = { d: t, what: i === 1 ? (side < 0 ? "the floor" : "the ceiling") : "a wall", glass: false };
    }
  }
  return best;
}

// DYS-33 (Akshay 28 Oct, (a): the laptop's page is read the way a real laptop's would be, by going closer): at the laptop
// a zoom toward its screen walks up to SCREEN_STOP from the screen's own plane (its lid and base are not in the way:
// the eye moves in the space the screen faces), only while the ray meets the screen; from 0.6 m that is ~5x the page.
const SCREEN_STOP = 0.12;
export const isLaptopSpot = (room, spot) => !!spot && !!room.spots?.laptop && spot.url === room.spots.laptop.url;
function screenPlane(room) {
  const q = room.objects?.screen?.quad;
  if (!q) return null;
  const n = normalize(cross(sub(q[1], q[0]), sub(q[3], q[0])));
  return { q, n };
}
// where a ray from `eye` along `dir` meets the screen: { t (m), u, v (0..1 across, down) } or null (not on the screen)
export function screenHit(room, eye, dir) {
  const S = screenPlane(room);
  if (!S) return null;
  const { q, n } = S, den = dot(dir, n);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot(sub(q[0], eye), n) / den;
  if (!(t > 0)) return null;
  const p = sub(add(eye, mul(dir, t)), q[0]), ex = sub(q[1], q[0]), ey = sub(q[3], q[0]);
  const u = dot(p, ex) / dot(ex, ex), v = dot(p, ey) / dot(ey, ey);
  return u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6 ? { t, u, v, cos: Math.abs(den) } : null;
}
// (DYS-179) an eye's distance from the screen's plane (m), or null
function screenDist(room, eye) {
  const S = screenPlane(room);
  return S ? Math.abs(dot(sub(eye, S.q[0]), S.n)) : null;
}

// How far a walk from `pose` along `dir` (unit) may go: to WALK_STOP (WALK_GLASS_STOP) short of the surface it meets,
// inside the room's box, clear of the furniture (WALK_CLEAR, or where it started if already closer), and
// within the spot's rules but the two that keep the chair's eye back (spotRules walk). { max (m), hit, stopped }
// (screenStop: at the laptop, how close to the screen's plane the walk may come; DYS-179's phone cap passes its own)
export function walkRange(room, spot, pose, dir, opening = DEFAULT_OPENING, { screenStop = SCREEN_STOP } = {}) {
  if (isLaptopSpot(room, spot)) {
    const s = screenHit(room, pose.eye, dir);
    if (s) return { max: Math.max(0, s.t - screenStop / s.cos), hit: { d: s.t, what: "the laptop's screen", glass: false }, stopped: "its stop short of the screen" };
  }
  const hit = surfaceHit(room, pose.eye, dir, opening);
  const want = Math.max(0, (Number.isFinite(hit.d) ? hit.d : 0) - (hit.glass ? WALK_GLASS_STOP : WALK_STOP));
  const [a, b] = room.inner, m = room.margin, stuff = furniture(room);
  const d0 = stuff.map((o) => obstacleDistance(pose.eye, o).d);
  const floor0 = Math.min(belowEye(room), pose.eye[1]);   // (the eye floor, or where it started if already lower)
  const why = (t) => {
    const e = add(pose.eye, mul(dir, t));
    for (let i = 0; i < 3; i++) if (e[i] < a[i] + m - 1e-6 || e[i] > b[i] - m + 1e-6) return "the room's box";
    if (e[1] < floor0 - 1e-6) return "the eye floor";
    for (let k = 0; k < stuff.length; k++) if (obstacleDistance(e, stuff[k]).d < Math.min(WALK_CLEAR, d0[k]) - 1e-6) return `clear of ${stuff[k].name}`;
    return spotRules(room, spot, { ...pose, eye: e }, { walk: true }) ? null : "the spot's rules";
  };
  let last = 0, stopped = "its stop short of the surface";
  for (let t = ZOOM_STEP; t <= want + 1e-9; t += ZOOM_STEP) { const r = why(Math.min(t, want)); if (r) { stopped = r; break; } last = Math.min(t, want); }
  return { max: last, hit, stopped };
}
const walked = (pose, w) => (w && (w[0] || w[1] || w[2]) ? { ...pose, eye: add(pose.eye, w) } : pose);
// The magnifier (v3/zoom, the window's binoculars): zoom input past the dolly's end narrows the field of view. Input is
// in the dolly's metres; MAG_M_PER_LN of them make one e-fold of magnification (a wheel notch, 0.16 m, about x1.25;
// gestures pass their own so a pinch tracks the fingers).
export const MAG_M_PER_LN = 0.72;
// v3/zoom-r3, the outside alone when zoomed (Akshay, 21 Oct: "i thought the zoom is just for the entire field of view
// outside?"). At a spot that magnifies, zooming in never moves the eye into the room and never narrows the room's lens:
// the room fades out (the router, over 0.25 s) and the outside alone fills the screen, magnified, through its own pose
// (rig.view). Magnified, a drag looks anywhere the outside has pictures (picture(): the panorama's yaw and elevation),
// stopping softly at their edge (no stretch, nothing springs back); the magnification changes only with zoom input; the
// ceiling (magCeil: as sharp as the pictures are there) only stops a zoom in. Zoomed out to 1x, the view is the spot's
// orbit pose nearest the look: over the last part of a zoom out (from MAG_BLEND down to 1x) the look and the eye are
// carried back to it, and the room fades in there, at exactly that pose.
export const MAG_BLEND = 1.25;
export const ROOM_FADE_MS = 250;   // the room's fade out and in (the router's; reduced motion 150 ms)
const ANCHOR_MS = 350;       // zoom events this close together are one gesture: one anchor, one latch at 1x
const SPAN_PTS = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];

// How far a pose may dolly: the spot's orbit.zoom [back, in] (metres; negative steps back), cut short where the
// eye would leave the room's inner box (less its margin), come within ZOOM_CLEAR of furniture, or break the
// spot's own rules (the desk's: above the desk, inside x, not past the desk's edge).
export function zoomRange(room, spot, pose) {
  const lim = spot.orbit?.zoom || [0, 0];
  const [a, b] = room.inner, m = room.margin;
  const dir = dollyDir(pose), stuff = furniture(room);
  const d0 = stuff.map((o) => obstacleDistance(pose.eye, o).d);
  const floor0 = Math.min(belowEye(room), pose.eye[1]);   // (the eye floor, or where it started if already lower)
  const ok = (t) => {
    const e = add(pose.eye, mul(dir, t));
    for (let i = 0; i < 3; i++) if (e[i] < a[i] + m - 1e-6 || e[i] > b[i] - m + 1e-6) return false;
    if (e[1] < floor0 - 1e-6) return false;
    for (let k = 0; k < stuff.length; k++) {
      const d = obstacleDistance(e, stuff[k]).d;
      if (d < Math.min(ZOOM_CLEAR, d0[k]) - 1e-6) return false;
    }
    return spotRules(room, spot, { ...pose, eye: e });
  };
  const march = (end) => {
    const sgn = Math.sign(end), n = Math.ceil(Math.abs(end) / ZOOM_STEP);
    let last = 0;
    for (let i = 1; i <= n; i++) { const t = sgn * Math.min(Math.abs(end), i * ZOOM_STEP); if (!ok(t)) break; last = t; }
    return last;
  };
  return [lim[0] < 0 ? march(lim[0]) : 0, lim[1] > 0 ? march(lim[1]) : 0];
}

// ---------- glides ----------
export function glideDuration(a, b) {
  const dist = len(sub(b.eye, a.eye));
  const turn = Math.acos(clamp(dot(dirOf(a.yaw, a.pitch), dirOf(b.yaw, b.pitch)), -1, 1)) / DEG;
  return clamp(0.9 + 0.35 * dist + 0.012 * turn, 0.9, 2.4);
}

// Straight when clear; otherwise through the hub's eye (the desk chair) with a small lift.
export function planPath(room, a, b, hubEye) {
  const clear = (p, q) => {
    for (let i = 1; i < 24; i++) {
      const s = vlerp(p, q, i / 24);
      for (const o of room.obstacles) if (obstacleDistance(s, o, o.capsule ? 0 : 0.08).d < 0) return false;
    }
    return true;
  };
  if (clear(a, b) || !hubEye) return { via: null };
  return { via: hubEye.slice(), lift: 0.08 };
}

// keepFocus: a glide within one spot's depth of field (the Projects page's photograph easing into the lean-in) keeps it
// all the way, eased from one focus to the other, instead of ramping it out and in.
// aim (a room point the rest pose looks through: interactions B's notebook and phone, looked down on from close by):
// the look tips down toward that point as seen from wherever the eye is, so a lean-in that ends looking steeply down
// never looks past the object (the floor in front of the desk) on the way; it ends on the rest pose's pitch.
export function makeGlide(room, from, to, { hubEye, velocity, duration, keepFocus = false, aim = null } = {}) {
  const T = duration ?? glideDuration(from, to);
  const path = planPath(room, from.eye, to.eye, hubEye);
  const dyaw = angleDiff(from.yaw, to.yaw), dpitch = to.pitch - from.pitch;
  const l0 = Math.log(from.tanV), l1 = Math.log(to.tanV);
  const v = velocity || null;
  const fs0 = from.fstop ? from.fstop : null;
  return {
    duration: T,
    path,
    at(u) {
      u = clamp(u, 0, 1);
      const eL = ease(u / 0.8), uP = clamp((u - 0.1) / 0.9, 0, 1), eP = ease(uP);
      const carry = v ? h10(u) * T : 0;
      let eye;
      if (!path.via) eye = vlerp(from.eye, to.eye, eP);
      else {
        const w = path.via;
        eye = add(add(from.eye, mul(sub(w, from.eye), ease(uP / 0.58))), mul(sub(to.eye, w), ease((uP - 0.42) / 0.58)));
        eye[1] += path.lift * Math.sin(Math.PI * uP);
      }
      if (v) eye = add(eye, mul(v.eye, carry));
      // (the aim steers the pitch only: looking almost straight down, a heading taken from the aim would swing as the
      // eye comes over it; the heading turns as in any glide)
      let aimPitch = null;
      if (aim) {
        const d = sub(aim, eye), w = ease(u / 0.8);
        const pA = Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG;
        aimPitch = u >= 1 ? to.pitch : from.pitch + (pA - from.pitch) * w;
      }
      const pose = {
        eye,
        yaw: from.yaw + dyaw * eL + (v ? v.yaw * carry : 0),
        pitch: aimPitch !== null ? aimPitch : from.pitch + dpitch * eL + (v ? v.pitch * carry : 0),
        tanV: Math.exp(lerp(l0, l1, eP) + (v ? v.logTanV * carry : 0)),
        shiftTan: [lerp(from.shiftTan[0], to.shiftTan[0], eP), lerp(from.shiftTan[1], to.shiftTan[1], eP)],
        focus: to.focus || from.focus || null,
        fstop: null,
      };
      // depth of field ramps in over the last 30 % into a spot that has it, and out over the first 30 % of leaving
      // (from one focused spot to another: out, then in, never cut)
      if (keepFocus && fs0 && to.fstop) {
        pose.fstop = Math.exp(lerp(Math.log(fs0), Math.log(to.fstop), eP));
        pose.focus = lerp(from.focus || to.focus, to.focus || from.focus, eP);
      } else if (to.fstop) {
        pose.fstop = to.fstop / Math.max(1e-3, ease((u - 0.7) / 0.3));
        if (fs0 && u < 0.3) { pose.fstop = fs0 / Math.max(1e-3, ease(1 - u / 0.3)); pose.focus = from.focus; }
      } else if (fs0) pose.fstop = fs0 / Math.max(1e-3, ease(1 - u / 0.3));
      if (pose.fstop && pose.fstop > 500) pose.fstop = null;
      if (!to.fstop) pose.focus = fs0 ? from.focus : null;
      return pose;
    },
  };
}

// ---------- the rig ----------
const now0 = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Rig {
  // frame(spotName) -> the spot's rest pose framed for the current screen (shared/framing.js)
  // onWake: an animation starts (a glide, an ease); the engine's loop may be idle and must draw again
  // limit(spotName, pose, rest) -> false where an orbit must stop for this screen (cards), on top of the room rules
  // magCap(spotName) -> the most this spot magnifies (1: no magnifier; the router gives the desk and the window their cap)
  // (v3/zoom-r3) magCeil(view, m) -> the most the view may be magnified and still look sharp (only a zoom in stops there);
  // picture() -> the outside's extent, { yaw: [a, b], el: [c, d] } in the rig's degrees (yaw left of the axis), or null;
  // size() -> the canvas's CSS size [w, h]
  // (v3/phone-frame) orbitFor(spotName) -> orbit keys for this screen that win over the spot's own (spotOf)
  constructor(room, { frame, onPose = () => {}, onState = () => {}, onWake = () => {}, limit = null, reducedMotion = () => false, now = now0, degPerPx = 0.12, magCap = () => 1,
    magCeil = null, picture = () => null, size = () => [16, 9], orbitFor = () => null, opening = null } = {}) {
    this.orbitFor = orbitFor;
    this.onWake = onWake;
    this.opening = opening;   // (v3/zoom-r4) () -> the window opening's corners (the router: the engine's), else DEFAULT_OPENING
    this.magCap = magCap;
    this.magCeil = magCeil;
    this.picture = picture;
    this.size = size;
    this.limit = limit;
    this.room = room;
    this.frame = frame;
    this.onPose = onPose;
    this.onState = onState;
    this.reducedMotion = reducedMotion;
    this.now = now;
    this.degPerPx = degPerPx;
    this.spot = null;              // the spot the rig is at, or gliding to
    this.from = null;              // the spot it left (during a glide)
    this.pose = null;
    this.rest = null;              // framed rest pose of this.spot
    this.off = { yaw: 0, pitch: 0 };
    this.raw = { yaw: 0, pitch: 0 };
    this.glide = null;             // { g, t0, resolve, to }
    this.ease = null;              // { from, to, t0, ms } short eases (spring back, re-framing, focus ease)
    this.dragging = false;
    this.state = "rest";           // rest | orbit | glide
    this.hist = [];                // recent poses for the speed a re-aim keeps
    this.dolly = 0;                // m along the look from the orbited pose (zoom); this.dollyT is where it eases to
    this.walk = [0, 0, 0];         // (v3/zoom-r4) the eye's walk in at a room spot (m, room axes); this.walkT is where it eases to
    this.walkT = [0, 0, 0];
    this.walkSeg = null;           // { x, y, dir, base, t, max, hit, stopped }: the walk of the current gesture
    // (DYS-179, the router's, from shared/laptop.js: on a phone, the most a pinch may grow the laptop's page over its
    // lean-in size, and a pinch there grows it as the fingers spread; 0: no cap, the walk as before, to SCREEN_STOP)
    this.screenScaleMax = 0;
    this.dollyT = 0;
    this.zooming = null;           // { t } while the dolly eases toward its target
    this.mag = 1;                  // the magnifier: the field of view narrowed by this (1 = none); this.magT is its target
    this.magT = 1;
    // v3/zoom-r3: zoomed (magnified at the desk or the window), the outside's own pose; the room's (this.pose) stays as
    // it was when the zoom began, at 1x, while it fades
    this.look = null;              // { yaw, pitch }: where the zoomed view looks (degrees, as a pose's), null at 1x
    this.view = null;              // the outside's pose while zoomed (its tanV narrowed by mag), null at 1x
    this.zStart = null;            // { off, pose }: the orbit offset and the room's pose when the zoom began
    this.anchor = null;            // { x, y, w, h, want, L0, t, touch }: a zoom gesture's point and the direction kept under it
    this.zoomOut = false;          // the last zoom step was out (F2: only a zoom out lets go of the anchor near 1x)
    this.atEdge = false;           // the zoomed view is in a soft stop (at the edge of the outside's pictures)
    this.latch = 0;                // until this time (ms) a zoom out that reached 1x holds there (a gesture's momentum)
    this.zoomEase = null;          // { t0, ms, mag0, L0, L1 }: a reset easing a zoomed view back to 1x (double click)
  }

  // zoomed: the room faded out, the outside alone (from the first zoom in until the zoom is back at 1x)
  get zoomed() { return !!this.look; }

  get magnified() { return this.mag > 1.0005 || this.magT > 1.0005; }

  get moving() { return !!(this.glide || this.ease || this.dragging || this.zooming || this.zoomEase || this.zStart?.start); }

  setState(s) { if (s !== this.state) { const from = this.state; this.state = s; this.onState({ from, to: s, spot: this.spot }); } }

  // A spot's data with this screen's orbit: orbitFor(name) may give keys that win over the spot's own orbit (v3/phone-frame:
  // the desk's phone camera turns about the eye, spots.json desk.phone.orbit); with none it is the spot's own object
  spotOf(name) {
    const s = this.room.spots[name], extra = s && this.orbitFor(name);
    return extra ? { ...s, orbit: { ...(s.orbit || {}), ...extra } } : s;
  }

  restPose(name = this.spot) {
    const p = this.frame(name);
    if (p && Math.abs(p.pitch) > PITCH_MAX) p.pitch = clamp(p.pitch, -PITCH_MAX, PITCH_MAX);   // (a framing that looks straight down)
    return keepInRoom(this.room, p);
  }

  emit() {
    this.hist.push({ t: this.now(), pose: clonePose(this.pose) });
    if (this.hist.length > 4) this.hist.shift();
    this.onPose(this.pose);
  }

  // Where the rig is heading: the spot's rest pose (glide) or the orbit offset (at rest).
  jumpTo(name, { keepOrbit = false } = {}) {
    this.cancelGlide("jump");
    this.ease = null;
    this.from = null;
    this.spot = name;
    this.rest = this.restPose(name);
    if (!keepOrbit) this.off = { yaw: 0, pitch: 0 }, this.raw = { ...this.off }, this.zoomReset();
    this.pose = this.composed();
    this.setState(this.off.yaw || this.off.pitch ? "orbit" : "rest");
    this.emit();
  }

  composed(off = this.off) {
    const s = this.spotOf(this.spot);
    const p = walked(orbitPose(s, this.rest, off), this.walk);   // (v3/zoom-r4: the walk in moves the eye; the look is the orbit's)
    let q;
    if (!this.dolly && !this.dollyT) q = keepInRoom(this.room, p);
    else {
      // the zoom is kept inside what this orbited pose allows (an orbit can bring furniture closer)
      const [lo, hi] = zoomRange(this.room, s, p);
      this.dolly = clamp(this.dolly, lo, hi);
      this.dollyT = clamp(this.dollyT, lo, hi);
      q = keepInRoom(this.room, dollied(p, this.dolly));
    }
    // (v3/zoom-r3: the room's lens never narrows; a zoomed view is the outside's own pose, this.view)
    return q;
  }

  zoomReset() {
    this.dolly = 0; this.dollyT = 0; this.zooming = null; this.mag = 1; this.magT = 1;
    this.walk = [0, 0, 0]; this.walkT = [0, 0, 0]; this.walkSeg = null;
    this.look = null; this.view = null; this.zStart = null; this.anchor = null; this.atEdge = false; this.zoomEase = null;
  }

  // ---------- v3/zoom-r3: zoomed, the outside alone ----------
  // Whether a spot magnifies (the router's cap: the desk and the window in the live room).
  magSpot(name = this.spot) { return !!name && (this.magCap(name) || 1) > 1; }

  // The 1x orbit offset nearest a look: its turn and tilt from the rest pose, inside the spot's own limits and rules.
  oneX(L) {
    const s = this.spotOf(this.spot), o = s.orbit || {};
    const yl = o.yaw || [0, 0], pl = o.pitch || [0, 0];
    const off = { yaw: clamp(angleDiff(this.rest.yaw, L.yaw), yl[0], yl[1]), pitch: clamp(L.pitch - this.rest.pitch, pl[0], pl[1]) };
    const k = `${this.spot}|${off.yaw}|${off.pitch}|${this.dolly}`;
    if (this._oneX?.k !== k) this._oneX = { k, off: allowed(this.room, s, this.rest, off, this.screenRule()) };
    return { ...this._oneX.off };
  }

  // The screen's extent from a pose: the least and most yaw (relative to its look) and elevation over its edge.
  screenSpan(v) {
    const [w, h] = this.size();
    let y0 = Infinity, y1 = -Infinity, e0 = Infinity, e1 = -Infinity;
    for (const [fx, fy] of SPAN_PTS) {
      const d = ray(v, fx * w, fy * h, w, h).d, yp = yawPitchOf(d), dy = angleDiff(v.yaw, yp.yaw);
      y0 = Math.min(y0, dy); y1 = Math.max(y1, dy); e0 = Math.min(e0, yp.pitch); e1 = Math.max(e1, yp.pitch);
    }
    return { yaw: [y0, y1], el: [e0, e1] };
  }

  // The pictures' edge for a look at magnification m: the look's limits there (the screen inside them, less a margin: the
  // mouse's sway turns the outside up to 0.7 deg across and 0.35 deg up, as much less as it is magnified), the look
  // held inside them (a plain clamp: a look already inside never moves), and the stop's easing zone s (the last eighth
  // of the screen's half height: a drag slows down to the edge over it, drag()). edge: within the zone.
  fitLook(L, m, P = this.picture()) {
    const r = this.rest, tanV = r.tanV / Math.max(1, m), s = Math.max(0.15, 0.12 * Math.atan(tanV) / DEG);
    if (!P) return { look: { ...L }, edge: false, s, yaw: [-Infinity, Infinity], pitch: [-PITCH_MAX, PITCH_MAX] };
    const v = { ...r, yaw: L.yaw, pitch: clamp(L.pitch, -PITCH_MAX, PITCH_MAX), tanV };
    const mY = 0.5 + 0.7 / m, mE = 0.5 + 0.35 / m;
    const se = this.screenSpan(v);
    const pb = [v.pitch + (P.el[0] + mE - se.el[0]), v.pitch + (P.el[1] - mE - se.el[1])];
    const pitch = pb[1] >= pb[0] ? clamp(v.pitch, pb[0], pb[1]) : (pb[0] + pb[1]) / 2;
    const sy = this.screenSpan({ ...v, pitch });
    const yb = [P.yaw[0] + mY - sy.yaw[0], P.yaw[1] - mY - sy.yaw[1]];   // (the span: relative to the look)
    const yaw = yb[1] >= yb[0] ? clamp(v.yaw, yb[0], yb[1]) : (yb[0] + yb[1]) / 2;
    const edge = yaw - yb[0] < s || yb[1] - yaw < s || pitch - pb[0] < s || pb[1] - pitch < s;
    return { look: { yaw, pitch }, edge, s, yaw: yb, pitch: pb };
  }

  // A zoom begun where the 1x view sees past the pictures (an orbit far to a side; a phone's window spot, whose screen
  // reaches below the near layer): the view starts exactly there and eases over the room's fade to the nearest one
  // inside them (1 while the room is still all there, 0 once it has faded out).
  startW() {
    const S = this.zStart?.start;
    if (!S) return 0;
    const u = (this.now() - S.t0) / (this.reducedMotion() ? 150 : ROOM_FADE_MS);
    if (u >= 1) { this.zStart.start = null; return 0; }
    return 1 - ease(u);
  }

  // The outside's pose for a look at magnification m. Its look is kept inside the pictures (the soft stop); toward 1x
  // (from MAG_BLEND down) it is carried to the 1x orbit pose nearest the look that stays inside them at 1x, and the eye
  // from the one held since the zoom began to that pose's; at 1x it is that pose, which the room takes when it fades in.
  // fit false: the look as it is (no stop), for solving an anchor. Returns { pose, look (the look the stop keeps), edge }.
  viewAt(L, m, fit = true) {
    const P = fit ? this.picture() : null;
    const c = ease(Math.log(Math.max(1, m)) / Math.log(MAG_BLEND));
    const F = P ? this.fitLook(L, m, P) : { look: { ...L }, edge: false };
    const B = P ? this.fitLook(L, 1, P).look : L;
    const off1 = this.oneX(B), p1 = this.composed(off1);
    const held = this.zStart ? this.composed(this.zStart.off).eye : p1.eye;
    let yaw = p1.yaw + angleDiff(p1.yaw, F.look.yaw) * c, pitch = p1.pitch + (F.look.pitch - p1.pitch) * c, eye = vlerp(p1.eye, held, c);
    const S = this.zStart?.start, w = S ? this.startW() : 0;
    if (w > 0) { yaw += S.yaw * w; pitch += S.pitch * w; eye = add(eye, mul(S.eye, w)); }
    const v = { ...p1, eye, yaw, pitch, tanV: p1.tanV / Math.max(1, m), focus: null, fstop: null };
    return { pose: v, look: c >= 0.999 ? F.look : { ...L }, edge: c >= 0.999 && F.edge, c };
  }

  // The look that keeps a zoom gesture's direction under its point at magnification m (from the look it began with).
  solveLook(A, m) {
    let L = { ...A.L0 };
    for (let i = 0; i < 6; i++) {
      const v = this.viewAt(L, m, false).pose, at = yawPitchOf(ray(v, A.x, A.y, A.w, A.h).d);
      // (beyond the spot's own 1x limits the blend moves the view only c as much as the look: the step is that much larger)
      const o1 = this.oneX(L), c = Math.max(0.2, ease(Math.log(Math.max(1, m)) / Math.log(MAG_BLEND)));
      const ky = Math.abs(angleDiff(this.rest.yaw + o1.yaw, L.yaw)) > 1e-6 ? 1 / c : 1, kp = Math.abs(this.rest.pitch + o1.pitch - L.pitch) > 1e-6 ? 1 / c : 1;
      const dy = angleDiff(at.yaw, A.want.yaw), dp = A.want.pitch - at.pitch;
      L = { yaw: L.yaw + dy * ky, pitch: clamp(L.pitch + dp * kp, -PITCH_MAX, PITCH_MAX) };
      if (Math.abs(dy) < 1e-7 && Math.abs(dp) < 1e-7) break;
    }
    return L;
  }

  // The zoomed view for the magnification now: the gesture's anchor (if any) or the look, inside the pictures.
  placeView() {
    // (F2, deploy1: a zoom out inside the blend toward 1x (under MAG_BLEND) lets go of the gesture's anchor: there the view
    // is carried to the 1x pose, which may not reach the anchored direction (a portrait window's orbit), and solving for
    // it anyway first tilted the view far up, then flipped it ~9 degrees in one frame on iPad portrait. The look stays
    // where the anchor last put it, so letting go moves nothing; a zoom in keeps its anchor all the way, also where the
    // magnification is already at its target (reduced motion's instant steps: a wheel notch, x1.249, is under MAG_BLEND))
    if (this.anchor && this.zoomOut && this.mag < MAG_BLEND && this.magT <= this.mag) this.anchor = null;
    const A = this.anchor;
    let L = A ? this.solveLook(A, this.mag) : this.look;
    if (A?.keep) {
      if (A.keep.yaw && angleDiff(A.L0.yaw, L.yaw) * A.keep.yaw > 0) L = { ...L, yaw: A.L0.yaw };
      if (A.keep.pitch && (L.pitch - A.L0.pitch) * A.keep.pitch > 0) L = { ...L, pitch: A.L0.pitch };
    }
    const r = this.viewAt(L, this.mag);
    this.look = r.look;
    this.view = r.pose;
    this.atEdge = r.edge;
  }

  beginZoom() {
    if (this.ease) { this.pose = this.ease.to; this.ease = null; }   // a spring back or re-framing ends where it was going
    this.zStart = { off: { ...this.off }, pose: clonePose(this.pose), start: null };
    // (where the 1x view sees past the pictures, the look is taken in to the nearest one inside them, so the view never
    // has to come back out as the zoom goes on; the difference from the view at the start, and any drag's stretch still
    // held, eases out over the room's fade)
    this.look = this.fitLook({ yaw: this.pose.yaw, pitch: this.pose.pitch }, 1).look;
    const v1 = this.viewAt(this.look, 1).pose;
    const d = { yaw: angleDiff(v1.yaw, this.pose.yaw), pitch: this.pose.pitch - v1.pitch, eye: sub(this.pose.eye, v1.eye) };
    if (Math.abs(d.yaw) > 1e-9 || Math.abs(d.pitch) > 1e-9 || len(d.eye) > 1e-9) this.zStart.start = { ...d, t0: this.now() };
    this.view = this.viewAt(this.look, this.mag).pose;
  }

  // Back at 1x: the orbit offset nearest the look inside the pictures, the room's pose there (the room fades in at it).
  endZoom() {
    const off = this.oneX(this.fitLook(this.look, 1).look);
    this.off = off; this.raw = { ...off };
    this.look = null; this.view = null; this.zStart = null; this.anchor = null; this.atEdge = false; this.zoomEase = null;
    this.mag = 1; this.magT = 1;
    this.pose = this.composed();
  }

  // The highest the zoom may go in toward `want` from the view it would lead to (the ceiling; never below where it is).
  ceilingFor(want) {
    if (!this.magCeil) return want;
    const at = (m) => this.viewAt(this.anchor ? this.solveLook(this.anchor, m) : this.look, m).pose;
    const c1 = this.magCeil(at(want), want);
    if (want <= c1) return want;
    const m2 = Math.max(this.magT, Math.min(want, c1));
    const c2 = this.magCeil(at(m2), m2);
    return Math.max(this.magT, Math.min(want, c1, c2));
  }

  // The spot's zoom range for the current orbit: [back, in] in metres, as zoomRange.
  zoomLimits() {
    if (!this.spot || !this.rest) return [0, 0];
    const s = this.spotOf(this.spot);
    return zoomRange(this.room, s, orbitPose(s, this.rest, this.off));
  }

  // Zoom: move the eye `metres` along the look (positive: closer), eased (about 0.1 s behind the input), within the
  // spot's limits. Reduced motion (or instant): the new view at once. Returns how far the target actually moved.
  // Where the spot magnifies (magCap > 1: the desk and the window, v3/zoom-r3) zooming in never dollies past the rest
  // distance: it magnifies the outside alone (perLn metres an e-fold, up to the cap, and in only as far as the ceiling
  // there), and zooming out takes the magnification back to 1x first (a gesture that reaches 1x holds there; the next one
  // steps back). `at` ({ x, y, w, h }, CSS px in the canvas; touch: a pinch's middle) is the point whose direction stays
  // under it through one gesture (a pinch's moves with the fingers).
  zoomBy(metres, { instant = false, at = null, perLn = MAG_M_PER_LN, touch = false } = {}) {
    if (!this.spot || this.glide || !metres) return 0;
    const cap = Math.max(1, this.magCap(this.spot) || 1);
    const [lo, hi0] = this.zoomLimits();
    const t = this.now();
    const magnifies = cap > 1 || this.magT > 1 || !!this.look;
    // (no dolly into the room along the screen's centre anywhere: the window magnifies, a room spot walks in, below)
    const hi = Math.min(hi0, 0);
    const before = this.dollyT, mag0 = this.magT, A0 = this.anchor && { x: this.anchor.x, y: this.anchor.y };
    const walk0 = this.walkT.slice();
    let m = metres;
    const gesture = t - (this.lastZoomAt ?? -1e9) < ANCHOR_MS;
    this.lastZoomAt = t;
    // v3/zoom-r4: at a room spot a zoom walks toward what is under the pointer (the window spot magnifies, below)
    if (!magnifies) m = this.walkBy(m, at, touch, gesture, perLn);
    if (magnifies) {
      if (m < 0 && (this.magT > 1 || this.look)) {               // out: the magnification, down to 1x, no further
        if (at && this.look) this.anchorAt(at, touch, gesture, t);
        this.zoomOut = true;
        this.magT = Math.max(1, this.magT * Math.exp(m / perLn));
        if (this.magT < 1 + 1e-4) { this.magT = 1; this.latch = t + ANCHOR_MS; }
        m = 0;
      } else if (m < 0 && t < this.latch) { this.latch = t + ANCHOR_MS; return 0; }   // the gesture that came back to 1x
      else if (m > 0) {                                           // in: back to the rest distance, then the magnification
        const d = Math.min(m, Math.max(0, hi - this.dollyT));
        if (m - d > 1e-9 && this.dollyT + d >= -1e-9) {
          const start = !this.look;
          if (start) this.beginZoom();
          if (at) this.anchorAt(at, touch, gesture && !start, t);
          this.zoomOut = false;
          const want = Math.min(cap, this.magT * Math.exp((m - d) / perLn));
          this.magT = Math.max(this.magT, this.ceilingFor(want));
          if (start && this.magT <= 1 + 1e-4) { this.magT = 1; this.look = null; this.view = null; this.zStart = null; this.anchor = null; }
        }
        m = d;
      }
    }
    this.dollyT = clamp(this.dollyT + m, lo, hi);
    const dMag = this.magT !== mag0;
    const dWalk = len(sub(this.walkT, walk0)) > 1e-9;
    if (this.dollyT === before && !dMag && !dWalk) {
      // (a pinch held at the ceiling or at 1x whose fingers move: the view follows them all the same)
      const A = this.anchor;
      if (this.look && A && A0 && A === this.anchor && (A.x !== A0.x || A.y !== A0.y)) { if (!this.zooming) { this.zooming = { t }; this.onWake(); } }
      return 0;
    }
    if (dMag && !at) this.anchor = null;
    if (this.ease) { this.pose = this.ease.to; this.ease = null; }   // a spring back or re-framing ends where it was going
    if (instant || this.reducedMotion()) {
      this.dolly = this.dollyT;
      this.walk = this.walkT.slice();
      this.mag = this.magT;
      this.zooming = null;
      if (this.look) { if (this.mag === 1) this.endZoom(); else this.placeView(); }
      if (!this.look) this.pose = this.composed();
      this.setState(this.dolly || this.isWalked() || this.look || this.off.yaw || this.off.pitch ? "orbit" : "rest");
      this.emit();
    } else {
      if (!this.zooming) { this.zooming = { t: this.now() }; this.onWake(); }
    }
    return (this.dollyT - before) + (dMag ? perLn * Math.log(this.magT / mag0) : 0) + (dWalk ? len(this.walkT) - len(walk0) || Math.sign(metres) * 1e-6 : 0);
  }

  // v3/zoom-r4: whether the eye is walked in (or walking) at a room spot
  isWalked() { return len(this.walk) > 1e-6 || len(this.walkT) > 1e-6; }

  // The walk in at a room spot, for a zoom of `m` metres (positive: in). In: back to the rest distance first (a step
  // back taken before), then along the ray through the pointer (the fingers' middle; the screen's centre for the keys),
  // one ray per gesture (a pinch keeps it as the fingers move; the mouse moved more than 2 px begins a new one), up to
  // walkRange's stop. Out: straight back toward the rest eye. Returns what is left of m for the dolly (the step back).
  walkBy(m, at, touch, gesture, perLn = 0) {
    const s = this.spotOf(this.spot);   // (the stage: phone-frame's rule, every current-spot read through spotOf)
    // DYS-179: the laptop's page on a phone, capped (screenScaleMax) and, for a finger's pinch, as the fingers spread
    const cap = this.screenCap(s), along = !!cap && touch && perLn > 0;
    if (m > 0) {
      const d = Math.min(m, Math.max(0, -this.dollyT));
      this.dollyT += d; m -= d;
      if (m <= 1e-9) return 0;
      const [w, h] = at ? [at.w, at.h] : this.size();
      const px = at ? at.x : w / 2, py = at ? at.y : h / 2;
      const S = this.walkSeg;
      if (!(S && gesture && (touch || Math.hypot(px - S.x, py - S.y) < 2))) {
        const from = walked(orbitPose(s, this.rest, this.off), this.walkT);   // (from where the walk is heading)
        const dir = ray(from, px, py, w, h).d;
        const r = walkRange(this.room, s, from, dir, this.opening?.() || DEFAULT_OPENING, cap ? { screenStop: cap.stop } : undefined);
        this.walkSeg = { x: px, y: py, dir, base: this.walkT.slice(), t: 0, max: r.max, hit: r.hit, stopped: r.stopped };
      } else if (touch) { S.x = px; S.y = py; }
      const W = this.walkSeg;
      // (DYS-179: on the screen, this step's share of the way left to it is the fingers' spread for the step, e^(m/perLn):
      // the page grows on screen by exactly that ratio, so a slight pinch is a slight zoom, up to the cap)
      if (along && W.hit && W.hit.what === "the laptop's screen") W.t = Math.min(W.max, W.t + Math.max(0, W.hit.d - W.t) * (1 - Math.exp(-m / perLn)));
      else W.t = Math.min(W.max, W.t + m);
      this.walkT = add(W.base, mul(W.dir, W.t));
      return 0;
    }
    const L = len(this.walkT);
    // (DYS-33: at the laptop a pinch out ends at the lean-in, where the page is the screen; no step back past it)
    const stay = isLaptopSpot(this.room, s);
    if (m < 0 && L > 1e-9) {
      let back = Math.min(-m, L);
      // (DYS-179: a pinch out there shrinks the page as the fingers close: the eye's distance from the screen grows by
      // their ratio, the walk taken back along itself, to the lean-in at most)
      if (along) {
        const dNow = screenDist(this.room, add(orbitPose(s, this.rest, this.off).eye, this.walkT)), wp = cap.d0 - dNow;
        back = wp > 1e-6 ? L * Math.min(1, (Math.min(cap.d0, dNow * Math.exp(-m / perLn)) - dNow) / wp) : L;
      }
      this.walkT = back >= L - 1e-9 ? [0, 0, 0] : mul(this.walkT, (L - back) / L);
      this.walkSeg = null;
      return stay ? 0 : m + back;   // (what is left: the step back, as before)
    }
    return stay && m < 0 ? 0 : m;
  }

  // DYS-179: at the laptop, with a cap (screenScaleMax > 1, a phone's page), the lean-in's distance from the screen's
  // plane (d0) and the closest the walk may come (stop): the page grows on screen as d0 over the eye's distance, so it
  // stops at d0 / screenScaleMax (never closer than SCREEN_STOP). null elsewhere, or without a cap.
  screenCap(s) {
    if (!(this.screenScaleMax > 1) || !this.rest || !isLaptopSpot(this.room, s)) return null;
    const d0 = screenDist(this.room, orbitPose(s, this.rest, this.off).eye);
    return d0 > SCREEN_STOP ? { d0, stop: Math.max(SCREEN_STOP, d0 / this.screenScaleMax) } : null;
  }

  // DYS-33 (a): walked in toward the laptop's screen, two fingers moving together slide the eye along the screen (what is
  // under them stays under them: dx, dy in CSS px of the canvas), never so far that the view's middle leaves the screen.
  // Returns whether it moved.
  panWalk(dx, dy) {
    if (this.glide || len(this.walkT) < 1e-3 || !isLaptopSpot(this.room, this.spotOf(this.spot))) return false;
    const P = this.pose, B = basis(P.yaw, P.pitch), [, h] = this.size();
    const c = screenHit(this.room, P.eye, B.f);
    if (!c || !(h > 0)) return false;
    const mpp = (c.t * P.tanV) / (h / 2);                     // metres of the screen per CSS px, where it is seen
    let move = add(mul(B.r, -dx * mpp), mul(B.u, dy * mpp));
    const eyeT = add(P.eye, sub(this.walkT, this.walk));      // (where the eye is going: the walk still easing in)
    for (let k = 0; k < 6 && !screenHit(this.room, add(eyeT, move), B.f); k++) move = mul(move, 0.5);
    if (len(move) < 1e-5 || !screenHit(this.room, add(eyeT, move), B.f)) return false;
    this.walkT = add(this.walkT, move);
    this.walkSeg = null;                                       // (the next pinch walks from here, along its own ray)
    if (!this.zooming) { this.zooming = { t: this.now() }; this.onWake(); }
    return true;
  }

  // A zoom gesture's point: within one gesture its direction is kept (a pinch's point moves with the fingers; the
  // mouse's or a trackpad's moving point begins a new one), else the direction under the point now.
  anchorAt(at, touch, gesture, t) {
    const A = this.anchor;
    if (A && gesture && (touch || Math.hypot(at.x - A.x, at.y - A.y) < 2) && A.w === at.w && A.h === at.h) {
      A.t = t;
      if (touch) { A.x = at.x; A.y = at.y; }
      return;
    }
    const v = this.view || this.pose;
    this.anchor = { x: at.x, y: at.y, w: at.w, h: at.h, want: yawPitchOf(ray(v, at.x, at.y, at.w, at.h).d), L0: { ...this.look }, t, touch };
    // (while a zoom begun past the pictures eases inside them, this anchor never pulls the look back the way it came)
    const S = this.zStart?.start;
    if (S) this.anchor.keep = { yaw: Math.abs(S.yaw) > 0.02 ? Math.sign(S.yaw) : 0, pitch: Math.abs(S.pitch) > 0.02 ? Math.sign(S.pitch) : 0 };
  }

  velocity() {
    const h = this.hist;
    if (h.length < 2) return null;
    const a = h[h.length - 2], b = h[h.length - 1], dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 0.1) return null;
    return {
      eye: mul(sub(b.pose.eye, a.pose.eye), 1 / dt),
      yaw: angleDiff(a.pose.yaw, b.pose.yaw) / dt,
      pitch: (b.pose.pitch - a.pose.pitch) / dt,
      logTanV: (Math.log(b.pose.tanV) - Math.log(a.pose.tanV)) / dt,
    };
  }

  cancelGlide(why) {
    if (!this.glide) return;
    const g = this.glide;
    this.glide = null;
    g.resolve({ landed: false, why, spot: g.to });
  }

  // Glide to a spot from wherever the camera is now (an orbited pose, or mid-glide: re-aim keeps the speed).
  glideTo(name, { duration, keepFocus = false, aim = null } = {}) {
    if (!this.pose) { this.jumpTo(name); return Promise.resolve({ landed: true, spot: name, cut: true }); }
    // (v3/zoom-r3: zoomed, the view first comes back to 1x over 0.3 s, as a zoom out does, then glides from the room's
    // pose there: the outside never cuts from its magnified view; a second call meanwhile re-aims the glide that follows)
    if ((this.look || this.zoomEase?.then) && !this.reducedMotion()) {
      const go = () => this.glideTo(name, { duration, keepFocus, aim });
      if (this.zoomEase?.then) { this.zoomEase.resolve({ landed: false, why: "re-aim", spot: this.zoomEase.to }); this.zoomEase.then = go; this.zoomEase.to = name; }
      else {
        this.dragging = false; this.anchor = null; this.zooming = null; this.ease = null;
        this.zoomEase = { t0: this.now(), ms: 300, mag0: this.mag, L0: { ...this.look }, L1: { ...this.look }, then: go, to: name };
        this.magT = 1;
        this.onWake();
      }
      return new Promise((resolve) => { this.zoomEase.resolve = resolve; });
    }
    const vel = this.glide ? this.velocity() : null;
    this.cancelGlide("re-aim");
    this.dragging = false;
    this.ease = null;
    this.zoomReset();   // the glide starts from the zoomed pose and lands on the new spot's rest
    const hub = this.room.spots[this.room.hub];
    const hubEye = hub ? this.restPose(this.room.hub).eye : null;
    this.from = this.spot;
    this.spot = name;
    const to = this.restPose(name);
    const g = makeGlide(this.room, clonePose(this.pose), to, { hubEye, velocity: vel, duration, keepFocus, aim });
    return new Promise((resolve) => {
      this.glide = { g, t0: this.now(), resolve, to: name, rest: to };
      this.setState("glide");
      this.onWake();
      this.tick(this.now());
    });
  }

  // A short ease of the whole pose (spring back after a release, a new screen shape, focus easing back).
  easeTo(target, ms) {
    if (this.reducedMotion() || ms <= 0) { this.pose = target; this.ease = null; this.emit(); return; }
    this.ease = { from: clonePose(this.pose), to: target, t0: this.now(), ms };
    this.onWake();
  }

  // The screen changed shape (resize, rotation): end any drag, re-frame, ease there over 0.6 s.
  reframe() {
    if (!this.spot) return;
    if (this.glide) { this.glide.rest = this.restPose(this.glide.to); return; }   // lands on the new framing
    this.dragging = false;
    this.rest = this.restPose(this.spot);
    this.off = { yaw: 0, pitch: 0 }; this.raw = { ...this.off };
    this.zoomReset();
    this.easeTo(this.composed(), 600);
    this.setState("rest");
  }

  // Back to the spot's resting pose (Escape, or keyboard focus on an object that drifted off screen).
  // (v3/zoom-r3: zoomed, the view eases back to 1x and to the rest pose's look together, then the room fades in there)
  resetOrbit(ms = 600) {
    if (!this.spot || this.glide) return;
    if (this.look && ms > 0 && !this.reducedMotion()) {
      this.dragging = false; this.anchor = null; this.zooming = null;
      this.zoomEase = { t0: this.now(), ms, mag0: this.mag, L0: { ...this.look }, L1: { yaw: this.rest.yaw, pitch: this.rest.pitch } };
      this.magT = 1;
      this.onWake();
      return;
    }
    if (this.look) { this.look = { yaw: this.rest.yaw, pitch: this.rest.pitch }; this.endZoom(); }
    this.off = { yaw: 0, pitch: 0 }; this.raw = { ...this.off };
    this.zoomReset();
    this.easeTo(this.composed(), ms);
    this.setState("rest");
  }

  screenRule() {
    if (!this.limit) return null;
    const name = this.spot, rest = this.rest;
    return (pose) => this.limit(name, pose, rest);
  }

  // Pointer travel in CSS px; dragging right turns the view left (you pull the room with you).
  drag(dx, dy) {
    if (!this.spot || this.glide) return;
    if (this.look) {
      // (v3/zoom-r3: zoomed, the look turns as much less as the view is magnified, anywhere the outside has pictures; the
      // magnification stays as it is)
      if (this.zoomEase) return;
      this.dragging = true;
      this.anchor = null;
      const k = this.degPerPx / this.mag;
      // (the plain soft stop: toward an edge, over its last zone the drag turns the look as much less as it is closer,
      // so it comes to rest at the edge; away from it at once; nothing springs back)
      const f = this.fitLook(this.look, this.mag), slow = (d, x, b) => {
        // (within a thousandth of a degree of the edge it is at the edge: a held drag then rests, exactly still)
        if (d > 0 && b[1] - x < f.s) { const g = d * Math.max(0, b[1] - x) / f.s; return b[1] - (x + g) < 1e-3 ? Math.max(0, b[1] - x) : g; }
        if (d < 0 && x - b[0] < f.s) { const g = d * Math.max(0, x - b[0]) / f.s; return x + g - b[0] < 1e-3 ? -Math.max(0, x - b[0]) : g; }
        return d;
      };
      const dyaw = slow(dx * k, this.look.yaw, f.yaw), dpitch = slow(dy * k, this.look.pitch, f.pitch);
      this.look = { yaw: this.look.yaw + dyaw, pitch: clamp(this.look.pitch + dpitch, -PITCH_MAX, PITCH_MAX) };
      this.placeView();
      this.setState("orbit");
      this.emit();
      return;
    }
    const s = this.spotOf(this.spot), o = s.orbit || {};
    this.dragging = true;
    this.ease = null;
    // (the pitch never passes straight down or up, stretch included: the raw offset is held inside that, and the
    // soft clamp only ever pulls it back toward the spot's own range; looking straight down, a sideways drag would
    // spin the picture about the look, so there it does not turn)
    const topDown = Math.abs(this.rest.pitch) >= TOP_DOWN;
    // (magnified, a pixel of travel turns the view as much less as the lens is narrower: the view follows the pointer)
    const k = this.mag > 1 ? this.degPerPx / this.mag : this.degPerPx;
    this.raw = {
      yaw: topDown ? 0 : this.raw.yaw + dx * k,
      pitch: clamp(this.raw.pitch + dy * k, -PITCH_MAX - this.rest.pitch, PITCH_MAX - this.rest.pitch),
    };
    const st = o.stretch ?? 6;
    const yl = o.yaw || [0, 0], pl = o.pitch || [0, 0];
    const want = { yaw: topDown ? 0 : softClamp(this.raw.yaw, yl[0], yl[1], st), pitch: softClamp(this.raw.pitch, pl[0], pl[1], st) };
    this.off = allowed(this.room, s, this.rest, want, this.screenRule());
    this.pose = this.composed();
    this.setState("orbit");
    this.emit();
  }

  // Let go: past a limit, ease back inside it; the view stays where it is left otherwise (plan 4.1).
  release() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.look) return;     // (v3/zoom-r3: zoomed, the view stays where it is left: nothing springs back)
    const s = this.spotOf(this.spot), o = s.orbit || {};
    const yl = o.yaw || [0, 0], pl = o.pitch || [0, 0];
    const inside = allowed(this.room, s, this.rest, { yaw: clamp(this.off.yaw, yl[0], yl[1]), pitch: clamp(this.off.pitch, pl[0], pl[1]) }, this.screenRule());
    this.raw = { ...inside };
    if (inside.yaw !== this.off.yaw || inside.pitch !== this.off.pitch) {
      this.off = inside;
      this.easeTo(this.composed(), 320);
    }
    this.setState(this.off.yaw || this.off.pitch || this.dolly || this.isWalked() || this.mag > 1 ? "orbit" : "rest");
  }

  tick(t = this.now()) {
    if (this.glide) {
      const G = this.glide, u = (t - G.t0) / (G.g.duration * 1000);
      if (u >= 1) {
        this.glide = null;
        this.rest = G.rest;
        this.off = { yaw: 0, pitch: 0 }; this.raw = { ...this.off };
        this.pose = this.composed();
        this.from = null;
        this.setState("rest");
        this.emit();
        G.resolve({ landed: true, spot: G.to });
        return this.pose;
      }
      this.pose = keepInRoom(this.room, G.g.at(u));
      this.emit();
      return this.pose;
    }
    if (this.ease) {
      const E = this.ease, u = clamp((t - E.t0) / E.ms, 0, 1), k = ease(u);
      const l0 = Math.log(E.from.tanV), l1 = Math.log(E.to.tanV);
      this.pose = {
        ...E.to,
        eye: vlerp(E.from.eye, E.to.eye, k),
        yaw: E.from.yaw + angleDiff(E.from.yaw, E.to.yaw) * k,
        pitch: lerp(E.from.pitch, E.to.pitch, k),
        tanV: Math.exp(lerp(l0, l1, k)),
        shiftTan: [lerp(E.from.shiftTan[0], E.to.shiftTan[0], k), lerp(E.from.shiftTan[1], E.to.shiftTan[1], k)],
      };
      if (u >= 1) this.ease = null;
      this.emit();
      return this.pose;
    }
    if (this.zoomEase) {
      // (v3/zoom-r3: a reset from a zoomed view: the magnification on a log scale and the look, eased together)
      const Z = this.zoomEase, u = clamp((t - Z.t0) / Z.ms, 0, 1), k = ease(u);
      this.mag = Math.exp(Math.log(Z.mag0) * (1 - k));
      this.look = { yaw: Z.L0.yaw + angleDiff(Z.L0.yaw, Z.L1.yaw) * k, pitch: lerp(Z.L0.pitch, Z.L1.pitch, k) };
      if (u >= 1) {
        this.look = { ...Z.L1 };
        this.endZoom();
        this.setState(this.dolly || this.isWalked() || this.off.yaw || this.off.pitch ? "orbit" : "rest");
        this.emit();
        if (Z.then) Z.resolve(Z.then());      // (a glide waited for the zoom to come back to 1x)
        return this.pose;
      }
      this.placeView();
      this.emit();
      return this.pose;
    }
    if (this.zStart?.start && !this.zooming && this.look) {
      // (a zoom begun past the pictures: its view eases inside them with the room's fade)
      this.placeView();
      this.emit();
      return this.pose;
    }
    if (this.zooming) {
      // exponential approach (felix-style): each frame closes the gap by 1 - e^(-dt/90 ms)
      const dt = clamp(t - this.zooming.t, 0, 50);
      this.zooming.t = t;
      const k = 1 - Math.exp(-dt / 90);
      this.dolly += (this.dollyT - this.dolly) * k;
      this.walk = add(this.walk, mul(sub(this.walkT, this.walk), k));
      const walkDone = len(sub(this.walkT, this.walk)) < 4e-4;
      if (walkDone) this.walk = this.walkT.slice();
      // (the magnification on a log scale, so every step of it feels the same)
      if (this.mag !== this.magT) {
        this.mag = Math.exp(Math.log(this.mag) + (Math.log(this.magT) - Math.log(this.mag)) * k);
        if (Math.abs(Math.log(this.magT / this.mag)) < 1e-3) this.mag = this.magT;
      }
      if (Math.abs(this.dollyT - this.dolly) < 4e-4 && this.mag === this.magT && walkDone) { this.dolly = this.dollyT; this.zooming = null; }
      // (v3/zoom-r3: zoomed, the outside's view follows the magnification; back at 1x the room's pose takes over, at the
      // orbit pose nearest the look; the room's own pose stays as it was while zoomed)
      if (this.look) { if (this.mag === 1 && this.magT === 1) this.endZoom(); else this.placeView(); }
      if (!this.look) this.pose = this.composed();
      if (!this.dragging) this.setState(this.dolly || this.isWalked() || this.look || this.off.yaw || this.off.pitch ? "orbit" : "rest");
      this.emit();
    }
    return this.pose;
  }
}

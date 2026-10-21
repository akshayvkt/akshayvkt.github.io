// The camera rig: where the eye is, where it looks, and how it moves between the room's spots.
//
//   import { Rig, project, toEngineCamera } from "/shared/rig.js";
//   const rig = new Rig(room, { frame: (spot) => framedRestPose, onPose: (pose) => … });
//   rig.jumpTo("desk");                  // no motion (deep links, reduced motion, rotation under reduced motion)
//   await rig.glideTo("shelf");          // a glide; a second call during it re-aims from the current pose and speed
//   rig.drag(dx, dy); rig.release();     // orbit within the spot's limits (pixels of pointer travel)
//   rig.zoomBy(metres)                   // dolly along the look, eased, within the spot's orbit.zoom and clear of the room;
//                                        // where magCap(spot) > 1 (the window), past the dolly's end it magnifies
//                                        // (narrows the field of view, up to the cap), the point under `at` kept still
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
// Signed distance from a point to a box (negative inside), and the direction out of it.
function boxDistance(p, [a, b]) {
  const q = [0, 1, 2].map((i) => Math.max(a[i] - p[i], 0, p[i] - b[i]));
  const out = len(q);
  if (out > 0) return { d: out, n: normalize([0, 1, 2].map((i) => (p[i] < a[i] ? -q[i] : p[i] > b[i] ? q[i] : 0))) };
  // inside: the nearest face
  let best = Infinity, n = [0, 1, 0];
  for (let i = 0; i < 3; i++) {
    for (const [v, s] of [[p[i] - a[i], -1], [b[i] - p[i], 1]]) if (v < best) { best = v; n = [0, 0, 0]; n[i] = s; }
  }
  return { d: -best, n };
}
function capsuleDistance(p, [a, b], r) {
  const ab = sub(b, a), t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0, 1);
  const c = add(a, mul(ab, t)), v = sub(p, c);
  return { d: len(v) - r, n: normalize(v) };
}
function obstacleDistance(p, o, inflate = 0) {
  if (o.box) return boxDistance(p, [sub(o.box[0], [inflate, inflate, inflate]), add(o.box[1], [inflate, inflate, inflate])]);
  if (o.capsule) return capsuleDistance(p, o.capsule, (o.radius || 0.1) + inflate);
  return { d: Infinity, n: [0, 1, 0] };
}

// The drawn camera stays inside the room: it slides along its line of sight until it is (felix-style), and
// furniture pushes it out on a gentle ramp, so a drag glides over the desk instead of snapping.
export function keepInRoom(room, pose) {
  const m = room.margin, [a, b] = room.inner;
  let eye = pose.eye.slice();
  const f = basis(pose.yaw, pose.pitch).f;
  for (let i = 0; i < 3; i++) {
    const lo = a[i] + m, hi = b[i] - m;
    if (eye[i] < lo && f[i] > 1e-3) eye = add(eye, mul(f, (lo - eye[i]) / f[i]));
    else if (eye[i] > hi && f[i] < -1e-3) eye = add(eye, mul(f, (hi - eye[i]) / f[i]));
    eye[i] = clamp(eye[i], lo, hi);
  }
  const ramp = 0.12;
  for (const o of room.obstacles) {
    const { d, n } = obstacleDistance(eye, o);
    if (d < ramp) {
      const want = d > 0 ? ramp / 2 + (d * d) / (2 * ramp) : ramp / 2;   // smooth max(d, ramp/2)
      eye = add(eye, mul(n, want - d));
    }
  }
  return eye === pose.eye ? pose : { ...pose, eye };
}

// Whether an orbited pose keeps the spot's own rules (desk: above the desk, inside x, not past the desk edge,
// never more than 50 degrees off the room's axis).
function spotRules(room, spot, pose) {
  const o = spot.orbit || {};
  if (o.maxOffAxis != null && Math.abs(pose.yaw) > o.maxOffAxis + 1e-6) return false;
  const e = pose.eye;
  if (o.eyeX && (e[0] < o.eyeX[0] - 1e-6 || e[0] > o.eyeX[1] + 1e-6)) return false;
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
// The magnifier (v3/zoom, the window's binoculars): zoom input past the dolly's end narrows the field of view. Input is
// in the dolly's metres; MAG_M_PER_LN of them make one e-fold of magnification (a wheel notch, 0.16 m, about x1.25;
// gestures pass their own so a pinch tracks the fingers).
export const MAG_M_PER_LN = 0.72;

// How far a pose may dolly: the spot's orbit.zoom [back, in] (metres; negative steps back), cut short where the
// eye would leave the room's inner box (less its margin), come within ZOOM_CLEAR of furniture, or break the
// spot's own rules (the desk's: above the desk, inside x, not past the desk's edge).
export function zoomRange(room, spot, pose) {
  const lim = spot.orbit?.zoom || [0, 0];
  const [a, b] = room.inner, m = room.margin;
  const dir = dollyDir(pose);
  const d0 = room.obstacles.map((o) => obstacleDistance(pose.eye, o).d);
  const ok = (t) => {
    const e = add(pose.eye, mul(dir, t));
    for (let i = 0; i < 3; i++) if (e[i] < a[i] + m - 1e-6 || e[i] > b[i] - m + 1e-6) return false;
    for (let k = 0; k < room.obstacles.length; k++) {
      const d = obstacleDistance(e, room.obstacles[k]).d;
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
  // magCap(spotName) -> the most this spot magnifies (1: no magnifier; the router gives the window its cap)
  constructor(room, { frame, onPose = () => {}, onState = () => {}, onWake = () => {}, limit = null, reducedMotion = () => false, now = now0, degPerPx = 0.12, magCap = () => 1 } = {}) {
    this.onWake = onWake;
    this.magCap = magCap;
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
    this.dollyT = 0;
    this.zooming = null;           // { t } while the dolly eases toward its target
    this.mag = 1;                  // the magnifier: the field of view narrowed by this (1 = none); this.magT is its target
    this.magT = 1;
    this.magAnchor = null;         // { x, y, w, h, dir }: the screen point (CSS px) a magnification keeps on the same direction
  }

  get magnified() { return this.mag > 1.0005 || this.magT > 1.0005; }

  get moving() { return !!(this.glide || this.ease || this.dragging || this.zooming); }

  setState(s) { if (s !== this.state) { const from = this.state; this.state = s; this.onState({ from, to: s, spot: this.spot }); } }

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
    const s = this.room.spots[this.spot];
    const p = orbitPose(s, this.rest, off);
    let q;
    if (!this.dolly && !this.dollyT) q = keepInRoom(this.room, p);
    else {
      // the zoom is kept inside what this orbited pose allows (an orbit can bring furniture closer)
      const [lo, hi] = zoomRange(this.room, s, p);
      this.dolly = clamp(this.dolly, lo, hi);
      this.dollyT = clamp(this.dollyT, lo, hi);
      q = keepInRoom(this.room, dollied(p, this.dolly));
    }
    // the magnifier: the same eye, a narrower lens (the lens shift, in tangent units, keeps the screen's centre)
    return this.mag > 1 ? { ...q, tanV: q.tanV / this.mag } : q;
  }

  zoomReset() { this.dolly = 0; this.dollyT = 0; this.zooming = null; this.mag = 1; this.magT = 1; this.magAnchor = null; }

  // The magnifier keeps its anchor (the direction that was under the pointer or the fingers) under the same screen
  // point: the orbit offset that does so, within the spot's own limits and rules (no stretch).
  anchorOrbit() {
    const A = this.magAnchor;
    if (!A || !this.spot) return;
    const s = this.room.spots[this.spot], o = s.orbit || {};
    const want = yawPitchOf(A.dir);
    let off = { ...this.off };
    for (let i = 0; i < 4; i++) {
      const r = ray(this.composed(off), A.x, A.y, A.w, A.h).d, at = yawPitchOf(r);
      off = { yaw: off.yaw + angleDiff(at.yaw, want.yaw), pitch: off.pitch + (want.pitch - at.pitch) };
    }
    const yl = o.yaw || [0, 0], pl = o.pitch || [0, 0];
    off = { yaw: clamp(off.yaw, yl[0], yl[1]), pitch: clamp(off.pitch, pl[0], pl[1]) };
    this.off = allowed(this.room, s, this.rest, off, this.screenRule());
    this.raw = { ...this.off };
  }

  // The spot's zoom range for the current orbit: [back, in] in metres, as zoomRange.
  zoomLimits() {
    if (!this.spot || !this.rest) return [0, 0];
    const s = this.room.spots[this.spot];
    return zoomRange(this.room, s, orbitPose(s, this.rest, this.off));
  }

  // Zoom: move the eye `metres` along the look (positive: closer), eased (about 0.1 s behind the input), within the
  // spot's limits. Reduced motion (or instant): the new view at once. Returns how far the target actually moved.
  // Where the spot magnifies (magCap > 1: the window), what is left past the dolly's end narrows the field of view
  // (perLn metres an e-fold, up to the cap), and zooming out takes the magnification back first; `at` ({ x, y, w, h },
  // CSS px in the canvas) is the point that stays on the same direction while it does (the pointer, the fingers).
  zoomBy(metres, { instant = false, at = null, perLn = MAG_M_PER_LN } = {}) {
    if (!this.spot || this.glide || !metres) return 0;
    const cap = Math.max(1, this.magCap(this.spot) || 1);
    const [lo, hi] = this.zoomLimits();
    const before = this.dollyT, mag0 = this.magT;
    let m = metres;
    if (cap > 1 || this.magT > 1) {
      if (m < 0 && this.magT > 1) {                          // out: the magnification first, then the dolly
        const k = Math.max(1, this.magT * Math.exp(m / perLn));
        m -= perLn * Math.log(k / this.magT);
        this.magT = k;
      } else if (m > 0) {                                     // in: the dolly first, then the magnification
        const room = Math.max(0, hi - this.dollyT), d = Math.min(m, room);
        if (m - d > 1e-9) this.magT = Math.min(cap, Math.max(this.magT, this.magT * Math.exp((m - d) / perLn)));
        m = d;
      }
      if (this.magT < 1 + 1e-4) this.magT = 1;
    }
    this.dollyT = clamp(this.dollyT + m, lo, hi);
    const dMag = this.magT !== mag0;
    if (this.dollyT === before && !dMag) return 0;
    if (dMag) this.magAnchor = at && this.pose ? { ...at, dir: ray(this.pose, at.x, at.y, at.w, at.h).d } : null;
    if (this.ease) { this.pose = this.ease.to; this.ease = null; }   // a spring back or re-framing ends where it was going
    if (instant || this.reducedMotion()) {
      this.dolly = this.dollyT;
      this.mag = this.magT;
      this.zooming = null;
      this.anchorOrbit();
      this.pose = this.composed();
      this.setState(this.dolly || this.mag > 1 || this.off.yaw || this.off.pitch ? "orbit" : "rest");
      this.emit();
    } else {
      if (!this.zooming) { this.zooming = { t: this.now() }; this.onWake(); }
    }
    return (this.dollyT - before) + (dMag ? perLn * Math.log(this.magT / mag0) : 0);
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
  resetOrbit(ms = 600) {
    if (!this.spot || this.glide) return;
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
    const s = this.room.spots[this.spot], o = s.orbit || {};
    this.dragging = true;
    this.ease = null;
    // (the pitch never passes straight down or up, stretch included: the raw offset is held inside that, and the
    // soft clamp only ever pulls it back toward the spot's own range; looking straight down, a sideways drag would
    // spin the picture about the look, so there it does not turn)
    const topDown = Math.abs(this.rest.pitch) >= TOP_DOWN;
    // (magnified, a pixel of travel turns the view as much less as the lens is narrower: the view follows the pointer)
    const k = this.mag > 1 ? this.degPerPx / this.mag : this.degPerPx;
    this.magAnchor = null;
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
    const s = this.room.spots[this.spot], o = s.orbit || {};
    const yl = o.yaw || [0, 0], pl = o.pitch || [0, 0];
    const inside = allowed(this.room, s, this.rest, { yaw: clamp(this.off.yaw, yl[0], yl[1]), pitch: clamp(this.off.pitch, pl[0], pl[1]) }, this.screenRule());
    this.raw = { ...inside };
    if (inside.yaw !== this.off.yaw || inside.pitch !== this.off.pitch) {
      this.off = inside;
      this.easeTo(this.composed(), 320);
    }
    this.setState(this.off.yaw || this.off.pitch || this.dolly || this.mag > 1 ? "orbit" : "rest");
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
    if (this.zooming) {
      // exponential approach (felix-style): each frame closes the gap by 1 - e^(-dt/90 ms)
      const dt = clamp(t - this.zooming.t, 0, 50);
      this.zooming.t = t;
      const k = 1 - Math.exp(-dt / 90);
      this.dolly += (this.dollyT - this.dolly) * k;
      // (the magnification on a log scale, so every step of it feels the same)
      if (this.mag !== this.magT) {
        this.mag = Math.exp(Math.log(this.mag) + (Math.log(this.magT) - Math.log(this.mag)) * k);
        if (Math.abs(Math.log(this.magT / this.mag)) < 1e-3) this.mag = this.magT;
        this.anchorOrbit();
      }
      if (Math.abs(this.dollyT - this.dolly) < 4e-4 && this.mag === this.magT) { this.dolly = this.dollyT; this.zooming = null; }
      this.pose = this.composed();
      if (!this.dragging) this.setState(this.dolly || this.mag > 1 || this.off.yaw || this.off.pitch ? "orbit" : "rest");
      this.emit();
    }
    return this.pose;
  }
}

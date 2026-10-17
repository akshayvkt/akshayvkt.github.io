// HTML laid on a room quad (the desk's print) is drawn over the canvas, so the room's furniture can't hide it: seen
// past something that stands in front of it, the parts behind are cut out of the element (clip-path), as the laptop's
// page does (shared/laptop.js clip()). The room's furniture boxes are coarse, so the cut is a box's outline.
//
//   import { occluders, occlusionClip } from "/shared/occlude.js";
//   const boxes = occluders(room, ["print", "desk"]);            // the room's furniture boxes but these
//   el.style.clipPath = occlusionClip(pose, quad, boxes, vw, vh, toLocal, [w, h]);   // "" when nothing is in front
import { project, sub, add, mul, len } from "./rig.js";

// The room's furniture boxes (room.obstacles), without the named ones (the object itself, what it stands on).
export function occluders(room, skip = []) {
  return (room?.obstacles || []).filter((o) => o.box && !skip.includes(o.name)).map((o) => o.box);
}

// Does the ray o + t d (d unit) enter the box [a, b] for some 0 < t < tMax?
export function rayBox(o, d, [a, b], tMax) {
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

// The convex hull of 2D points (monotone chain).
export function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// The clip-path that cuts out of an element (its own box w x h) every furniture box between the eye and its quad,
// or "" when none is. `quad` is the room quad (4 corners, any order around it), `toLocal(x, y)` takes a screen point
// (CSS px of the vw x vh view) into the element's own coordinates (null if it can't).
export function occlusionClip(pose, quad, boxes, vw, vh, toLocal, [w, h]) {
  if (!pose || !quad || !boxes?.length || !toLocal) return "";
  const e = pose.eye;
  const blockers = new Set();
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
    const u = i / 4, v = j / 4;
    const top = add(quad[0], mul(sub(quad[1], quad[0]), u)), bot = add(quad[3], mul(sub(quad[2], quad[3]), u));
    const p = add(top, mul(sub(bot, top), v));
    const dv = sub(p, e), L = len(dv), dn = mul(dv, 1 / L);
    for (const b of boxes) if (!blockers.has(b) && rayBox(e, dn, b, L - 0.01)) blockers.add(b);
  }
  if (!blockers.size) return "";
  let path = `M0 0H${w}V${h}H0Z`;
  for (const [a, b] of blockers) {
    const corners = [];
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) corners.push([x, y, z]);
    const S = corners.map((c) => project(pose, c, vw, vh)).filter(Boolean).map((p) => toLocal(p[0], p[1])).filter(Boolean);
    const hl = hull(S);
    if (hl.length > 2) path += `M${hl.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;
  }
  return `path(evenodd, "${path}")`;
}

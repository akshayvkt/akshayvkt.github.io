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

// What stands on the desk is hidden by it only from below its top (bug 26 Oct, BUG-2: from under the desk the laptop's
// page and the phone's lock screen were drawn through it): the desk's top board (room.py DeskTop, 35 mm) as a box, for the
// layers that leave the desk's own box out. A ray from above to anything on the desk never enters it. Null without a desk.
export const DESK_TOP_M = 0.035;
export function deskTop(room) {
  const b = room?.objects?.desk?.box || room?.obstacles?.find((o) => o.name === "desk")?.box;
  return b ? { name: "desk_top", box: [[b[0][0], b[1][1] - DESK_TOP_M, b[0][2]], [b[1][0], b[1][1] - 1e-4, b[1][2]]] } : null;
}
// ... and with it the things standing on the desk that are no furniture obstacle (shared/spots.js room.onDesk: seen low
// across the desk, Poor Charlie's Almanack stood in front of the phone's lock screen, which was drawn through it), but
// the named ones (the layer's own device): [{ name, box }], for the layers' occluder lists.
export function deskOccluders(room, skip = []) {
  return [deskTop(room), ...(room?.onDesk || []).filter((o) => !skip.includes(o.name))].filter(Boolean);
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

// The cut-outs of a clip-path made disjoint (bug 26 Oct, BUG-2: an evenodd path shows again where two of its holes
// overlap, so seen past the laptop and the bottle at once the print's text showed through the bottle): convex polygons
// that overlap are merged into the hull of both, a little more cut away there (the 3D's own picture of the surface shows).
export function disjointHulls(polys) {
  const P = polys.filter((p) => p.length > 2);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < P.length && !merged; i++) for (let j = i + 1; j < P.length && !merged; j++) {
      if (overlap(P[i], P[j])) { P[i] = hull([...P[i], ...P[j]]); P.splice(j, 1); merged = true; }
    }
  }
  return P;
}
// Do two convex polygons overlap (touching counts)? No axis among their edges' normals separates them.
function overlap(A, B) {
  for (const Q of [A, B]) for (let i = 0; i < Q.length; i++) {
    const [x1, y1] = Q[i], [x2, y2] = Q[(i + 1) % Q.length], nx = y2 - y1, ny = x1 - x2;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of A) { const d = nx * x + ny * y; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const [x, y] of B) { const d = nx * x + ny * y; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
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
  const hulls = [];
  for (const [a, b] of blockers) {
    const corners = [];
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) corners.push([x, y, z]);
    const S = corners.map((c) => project(pose, c, vw, vh)).filter(Boolean).map((p) => toLocal(p[0], p[1])).filter(Boolean);
    hulls.push(hull(S));
  }
  for (const hl of disjointHulls(hulls)) path += `M${hl.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;
  return `path(evenodd, "${path}")`;
}

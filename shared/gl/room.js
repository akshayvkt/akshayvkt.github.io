// The room model on the GPU: one room material per (glTF material, atlas), the light-map atlases and their layers,
// the region and object IDs (docs/v3/engine-api.md section 8), and the three ways the room is drawn: live,
// depth pre-pass, and added into the refining sum.
import * as THREE from "three";
import { alphaCut, atlasUniforms, DEFAULT_TEXTURES, idMaterial, roomMaterial } from "./material.js";
import { dataTexture, fetchBitmap, noteSource, releaseAfterUpload, within } from "./loader.js";
import { nextMessage } from "./context.js";

export const REGIONS = ["none", "desk_top", "desk_body", "desk_objects", "books", "shelves", "window", "walls", "floor", "ceiling", "lamp", "furniture"];
export const OBJECTS = { none: 0, desk: 1, lamp: 2, laptop: 3, screen: 4, notebook: 5, shelf: 6, window: 7, print: 8, cup: 9, plant: 10, vase: 11, pen: 12, room: 13,
  chair: 14, floor_lamp: 15, side_table: 16, credenza: 17, painting: 18, floor_plant: 19, rug: 20 };

/** Region and object names from room3d.json (R1's export), when the asset set has one; the built-in lists otherwise. */
export function useIdTables(room3d) {
  if (!room3d) return;
  if (room3d.regions) for (const [name, id] of Object.entries(room3d.regions)) REGIONS[id] = name;
  if (room3d.ids) for (const [name, id] of Object.entries(room3d.ids)) OBJECTS[name] = id;
}

/**
 * The laptop screen as a lit rectangle (world space), for the reflections of glossy things right next to it that the
 * probes can't see (the aluminium deck, plan 2.4's "screen glow"): centre, unit axes with half-extents, front normal,
 * and the emitted radiance (the material's emission x the page's mean colour in screen_base.jpg, 0.97).
 */
function screenRect({ mesh, emissive }, towards = null) {
  const pos = mesh.geometry.attributes.position, nrm = mesh.geometry.attributes.normal;
  if (!pos || !nrm) return null;
  mesh.updateWorldMatrix(true, false);
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const c = new THREE.Vector3(), n = new THREE.Vector3(), v = new THREE.Vector3(), pts = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
    c.add(pts[i]);
    n.add(v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize());
  }
  c.divideScalar(pos.count);
  n.normalize();
  if (towards && n.dot(v.subVectors(towards, c)) < 0) n.negate();
  const u = new THREE.Vector3(0, 1, 0).cross(n).normalize();
  const w = new THREE.Vector3().crossVectors(n, u).normalize();
  let hu = 0, hw = 0;
  for (const p of pts) { v.subVectors(p, c); hu = Math.max(hu, Math.abs(v.dot(u))); hw = Math.max(hw, Math.abs(v.dot(w))); }
  return { centre: c.toArray(), u: [...u.toArray(), hu], v: [...w.toArray(), hw], normal: n.toArray(),
    radiance: [emissive.r * 0.97, emissive.g * 0.97, emissive.b * 0.97] };
}

/**
 * The laptop's lid around the screen (e1-v1.11), in the screen rectangle's own frame: [x0, x1, y0, y1] along its u and v
 * axes from its centre, from the laptop's vertices whose normal faces the way the screen does and that lie on the screen's
 * plane (within 15 mm): the bezel, the chin down to the hinge. A glossy surface's ray that meets the lid's front there
 * hits the lid, not what the probes see behind it (the window): the deck and the keys at a grazing view. Null without
 * enough of them (an older model, no laptop). `verts`: position and normal, six numbers a vertex (Room.laptopVerts).
 */
function lidRect(sr, verts) {
  if (!sr || !verts || !verts.length) return null;
  // (DYS-149: Vector3's dot and subVectors written out, the same sums in its order: one loop over the laptop's vertices
  // with no calls, on a cold page)
  const [cx, cy, cz] = sr.centre, [nx, ny, nz] = sr.normal, [ux, uy, uz] = sr.u, [wx, wy, wz] = sr.v;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, k = 0;
  for (let i = 0; i < verts.length; i += 6) {
    if (verts[i + 3] * nx + verts[i + 4] * ny + verts[i + 5] * nz < 0.9) continue;   // (the normal q: q.dot(n))
    const dx = verts[i] - cx, dy = verts[i + 1] - cy, dz = verts[i + 2] - cz;    // (d = p - c)
    if (Math.abs(dx * nx + dy * ny + dz * nz) > 0.015) continue;
    const x = dx * ux + dy * uy + dz * uz, y = dx * wx + dy * wy + dz * wz;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); k++;
  }
  // the lid holds the screen: anything smaller is not the lid
  if (k < 20 || x0 > -sr.u[3] || x1 < sr.u[3] || y0 > -sr.v[3] || y1 < sr.v[3]) return null;
  return [x0, x1, y0, y1].map((t) => +t.toFixed(5));
}

export function objectId(name) {
  if (!name) return 0;
  const m = /^book:(\d+)$/.exec(name);
  if (m) return 256 + Math.min(255, +m[1]);
  return OBJECTS[name] ?? 0;
}
export function objectName(id) {
  if (id >= 256) return `book:${id - 256}`;
  return Object.keys(OBJECTS).find((k) => OBJECTS[k] === id) || null;
}

// name patterns for models without extras.sfw (the spike); the same table as scripts/engine/placeholder_uv.py
const TAGS = [
  [/^DeskTop/, "desk_top", "desk"], [/^Desk(Apron|Leg)/, "desk_body", "desk"],
  [/^ScreenPanel/, "desk_objects", "screen"],
  [/^(LaptopBase|Lid|Hinge|Keycaps|KeyWell|Trackpad|BezelPlate)/, "desk_objects", "laptop"],
  [/^Notebook/, "desk_objects", "notebook"], [/^Pen/, "desk_objects", "pen"],
  [/^tea_set/, "desk_objects", "cup"], [/^potted_plant/, "desk_objects", "plant"], [/^ceramic_vase/, "desk_objects", "vase"],
  [/^(FrameBot|FrameL\.001|FrameR\.001|FrameTop|Mat|Print)$/, "desk_objects", "print"],
  [/^geo_/, "lamp", "lamp"], [/^Book(\d+)$/, "books", "book:$1"], [/^ShelfBoard/, "shelves", "shelf"],
  [/^(Frame[BLRT]|Mullion|Transom|SillBoard|WallSill|WallHead|WallL|WallR)/, "window", "window"],
  [/^(Back|SideL|SideR|Baseboard)/, "walls", "room"], [/^Floor/, "floor", "room"], [/^Ceiling/, "ceiling", "room"],
];

function tagOf(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.userData && o.userData.sfw) {
      // R1's joined meshes: ids ride per vertex in COLOR_0 (object = R + 256 G, region = B, 8-bit exact)
      const vertexIds = !!obj.geometry?.attributes?.color;
      return { region: "walls", object: "room", atlas: "room", ...o.userData.sfw, vertexIds };
    }
  }
  for (let o = obj; o; o = o.parent) {
    const name = o.name || "";
    for (const [re, region, object] of TAGS) {
      const m = re.exec(name);
      if (m) return { region, object: object.replace("$1", m[1] || ""), atlas: "room" };
    }
  }
  return { region: "walls", object: "room", atlas: "room" };
}

const DEFAULT_WINDOW = [[-1.1, 0.82, -1.2], [1.1, 0.82, -1.2], [1.1, 2.55, -1.2], [-1.1, 2.55, -1.2]];

// DYS-11 (walls read tan, not the warm white picked): the light maps hold light only, so the warm white limewash (R-021,
// #e8e1d7, 76 % reflectance) went onto the walls as a material change (walls-report.md), but the light they hold was
// baked on 17 Oct around the old taupe plaster (#a5998e, 33 %): every wall still gets a dark room's bounce light. The
// shelf wall is on the window wall, so no sky reaches it, only bounce: it read as a mid warm grey (L* 46 at midday).
// A radiosity estimate of the room, old paint against new, with the bake's lights (scripts/walls/bounce_estimate.py:
// the window's sky, the hidden DayBounce fill, the lamp and its ceiling card) puts the limewash walls' bounced light
// at about 1.9x: k is that gain - 1 per channel, r the bounced light's level against the window's own (the share a
// wall keeps as baked is windowFF / (windowFF + r), material.js). On for a bake of this model made before the repaint
// (every report before 20 Oct) and a plaster no longer the tint it was baked with: a re-bake for the new paint turns
// it off by itself.
const WALL_BOUNCE = {
  a38ca2f07fbd5d79: { before: "2026-10-20", bakedTint: [0.9216, 0.8632, 0.7682], k: [0.88, 0.9, 0.85], r: [0.045, 0.032, 0.025] },
};
function wallBounce(bake) {
  const w = WALL_BOUNCE[bake?.model_hash];
  const when = Object.values(bake?.bake_reports || {}).flatMap((r) => Object.keys(r || {}));
  return w && when.length && when.every((t) => t < w.before) ? w : null;
}
// DYS-11 (Akshay, approved 30 Oct: "they just cannot look worn"): the wall and ceiling paints' albedo scans (the
// plaster's streaks, mottling and dark specks) eased fully toward their mean: an even paint; the normal map's fine relief
// and the light stay. 1 by default; ?wallclean=<0..1> overrides (0: the scan as it was). The ceiling and baseboard
// (trim) are a flat colour with no scan: nothing to ease there
const WALL_CLEAN = (() => {
  const v = typeof location !== "undefined" ? parseFloat(new URLSearchParams(location.search).get("wallclean")) : NaN;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
})();
const PAINTED = new Set(["plaster", "trim"]);
const repainted = (c, t) => !!c && Math.max(Math.abs(c.r - t[0]), Math.abs(c.g - t[1]), Math.abs(c.b - t[2])) > 0.05;

// Bug 26 Oct (BUG-1, the wood flicker): R1's model has the window wall's top under the sill (room.py WallSill, plaster, up
// to SILL) in the plane of the oak sill board's top (SillBoard, also up to SILL), both facing up. Two surfaces in one plane
// z-fight: the plaster's cream broke through the wood in stripes and blocks that changed every frame as the view moved
// (and in the desk's reflection of the sill). At load, a face of the room's shell (plaster) that lies in another part's
// plane (within PLANE_EPS), faces the same way and overlaps it is set back SHELL_YIELD behind that plane, so the part
// always wins: under the sill it stays hidden (the board is 30 mm thick, its nose past the wall). Being geometry, it holds
// in every pass that draws the room (live, refining, ids, the desk mirror, the night glass, the probes, the beams).
// The same for a part of its own over the joined desk mesh (the room-wide sweep, 26 Oct): the phone's screen and the
// notebook's cover are parts (they light, open or move on their own), and the joined mesh's faces of the same object lie
// under them in their planes (the phone's body at the screen glass's two heights, its pixels flipping between the two
// from frame to frame; the notebook's spine strip 0.1 mm under the closed cover). A joined face of a part's object, in the
// part's plane, facing the same way and overlapped by it, is set back PART_YIELD: thin things, and 0.3 mm is still many
// depth steps 5 m away. (room.py could leave both out at the next export: the body's top under the glass, the spine strip.)
// And an inlay of one object (the room-wide sweep, 27 Oct): the laptop's keyboard well and its two speaker grilles sit in
// the deck's top in room.py (0.05 mm under it, 0.02 mm over it), and the export's position grid (0.33 mm steps there)
// puts all three in one plane: stripes between the keys and across the grilles as the view moved. A face lying wholly
// inside a bigger face of its own object, in the same plane (within INLAY_EPS), is set back PART_YIELD behind that
// face's front (either facing: the grid made the 0.14 mm grilles flat boxes, whose double-sided bottoms fought too).
// Which of the two Blender had on top the export lost, but the bake kept it: the hidden one baked dark (on this model the
// well 0 against the deck's 81, the grilles 140-148 against its 0-1, latemorning). So an inlay that mostly faces the way
// the face does is checked once its atlas's first ambient light map arrives (Room.settleInlays): one clearly brighter
// than the face around it comes forward, one step in front of it. The export's positions are integers
// (KHR_mesh_quantization): every move is whole steps, at least one, so none rounds away to nothing. (room.py could sink
// the well 0.4 mm and raise the grilles 0.4 mm at the next export; then nothing here finds them.)
const SHELL_CLASSES = new Set(["plaster"]);
const PLANE_EPS = 5e-4, SHELL_YIELD = 0.002, PART_YIELD = 3e-4, INLAY_EPS = 1e-5;

/**
 * How to read an attribute's numbers straight from its array, as its getX / getY / getZ return them: vertex i's k-th at
 * a[i * s + o + k], divided by d when normalized (d 0: as it is; Uint8 and Uint16, three's divisors). Null for any other
 * kind (signed normalized, getters of its own), read through its getters. (DYS-149: the getters, a call or two a number,
 * were most of the room build's sweep on a cold page: each loop runs once, mostly before the JIT has compiled it.)
 */
function rawReader(attr) {
  if (!attr) return null;
  const inter = !!attr.isInterleavedBufferAttribute, base = inter ? THREE.InterleavedBufferAttribute.prototype : THREE.BufferAttribute.prototype;
  if (attr.getX !== base.getX || attr.getY !== base.getY || attr.getZ !== base.getZ) return null;
  const a = inter ? attr.data.array : attr.array;
  const d = !attr.normalized ? 0 : a.constructor === Uint8Array ? 255 : a.constructor === Uint16Array ? 65535 : -1;
  return d < 0 ? null : { a, s: inter ? attr.data.stride : attr.itemSize, o: inter ? attr.offset : 0, d };
}

// (DYS-149: the room's build in pieces) Room.build was the slow laptop's longest task behind the still photo (181-195 ms
// on barely-sufficient: yieldCoplanar ~100 of it, inlays ~56, the ids ~35). It is written as steps: generators that
// `yield` where a piece may end, every STEP triangles, vertices or faces, each plane with inlays and each mesh. runAll
// runs them in one go (build, yieldCoplanar and moveFaces, as they were); runPieces in pieces of about `budget` ms, a new
// task by a message between them (Room.buildSplit, the engine's). The same steps in the same order either way, and the
// room in nobody else's hands until the last: the same positions, bounds, materials, ids, screen and lid, inlay checks
// and settled inlays, bit for bit (on the real model in node, main's build against both ways).
const STEP = 2048;
export const PIECE_MS = 16;   // (a piece ends at the first step past it: a step is ~1-2 ms in node cold, under ~10 on the slow laptop)
function runAll(steps) {
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}
/** Run `steps` in pieces of about `budget` ms, awaiting `next` between them; `stats` gets the pieces, the longest and their sum (ms). */
async function runPieces(steps, budget, next, stats) {
  let t = performance.now();
  for (;;) {
    const r = steps.next(), now = performance.now();
    if (r.done || now - t >= budget) { stats.pieces++; stats.longest = Math.max(stats.longest, now - t); stats.work += now - t; }
    if (r.done) return r.value;
    if (now - t >= budget) { await next(); t = performance.now(); }
  }
}
/** run(k0, k1) over 0..n in STEP-long runs, a step each (n may be fractional: the last run ends at n, as a k < n loop). */
function* inSteps(n, run) {
  for (let k0 = 0; k0 < n; k0 += STEP) { run(k0, Math.min(n, k0 + STEP)); yield; }
}

/** A mesh's world positions (x, y, z per vertex), as Vector3.applyMatrix4 makes them (the same sums, in its order). */
function* worldPositions(mesh) {
  const pos = mesh.geometry.attributes.position, n = pos.count, P = new Float64Array(n * 3), R = rawReader(pos);
  mesh.updateWorldMatrix(true, false);
  yield* inSteps(n, (i0, i1) => worldRun(pos, R, mesh.matrixWorld, P, i0, i1));
  return P;
}
/** Vertices i0..i1 of worldPositions. */
function worldRun(pos, R, mw, P, i0, i1) {
  if (!R) {
    const v = new THREE.Vector3();
    for (let i = i0; i < i1; i++) v.fromBufferAttribute(pos, i).applyMatrix4(mw).toArray(P, i * 3);
    return;
  }
  const [e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12, e13, e14, e15] = mw.elements, { a, s, o, d } = R;
  for (let i = i0, j = o + i0 * s; i < i1; i++, j += s) {
    const x = d ? a[j] / d : a[j], y = d ? a[j + 1] / d : a[j + 1], z = d ? a[j + 2] / d : a[j + 2];
    const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
    P[3 * i] = (e0 * x + e4 * y + e8 * z + e12) * w; P[3 * i + 1] = (e1 * x + e5 * y + e9 * z + e13) * w; P[3 * i + 2] = (e2 * x + e6 * y + e10 * z + e14) * w;
  }
}

/** Each vertex's object from COLOR_0 (R + 256 G, 8-bit): Math.round(col.getX(i) * 255) + 256 * Math.round(col.getY(i) * 255). */
function* vertexObjects(col) {
  const n = col.count, out = new Float64Array(n), R = rawReader(col);
  yield* inSteps(n, (i0, i1) => objectRun(col, R, out, i0, i1));
  return out;
}
/** Vertices i0..i1 of vertexObjects. */
function objectRun(col, R, out, i0, i1) {
  if (!R) {
    for (let i = i0; i < i1; i++) out[i] = Math.round(col.getX(i) * 255) + 256 * Math.round(col.getY(i) * 255);
    return;
  }
  const { a, s, o, d } = R;
  for (let i = i0, j = o + i0 * s; i < i1; i++, j += s) out[i] = Math.round((d ? a[j] / d : a[j]) * 255) + 256 * Math.round((d ? a[j + 1] / d : a[j + 1]) * 255);
}

/**
 * Each of a mesh's triangles that faces along a room axis (world space), as a list: for its k-th, the vertex indices
 * (tri[3k..3k+2]), the axis and its sign (ax[k], s[k]), the plane's coordinate (c[k]), its extent over the two other axes
 * (r[4k..4k+3]: u0, u1, v0, v1) and its object (obj[k]: the per-vertex id of its first vertex, -1 without); n of them,
 * with the mesh `o` and its world positions `P`. `known`: { P, obj } (its world positions and vertices' objects) if
 * already read (Room._indexVertexIds).
 * (DYS-149: a list made once per mesh, not a callback with a new array per face on every call: yieldCoplanar walked a
 * part's faces three times, reading its world positions each time; the values are the same as the callback's were.)
 */
function* axisFaces(mesh, known = null) {
  const g = mesh.geometry, pos = g.attributes.position, idx = g.index, col = g.attributes.color;
  const P = known?.P ?? (yield* worldPositions(mesh)), objs = col ? known?.obj ?? (yield* vertexObjects(col)) : null;
  const R = idx && rawReader(idx), I = R && !R.d && R.s === 1 && R.o === 0 ? R.a : null;   // (an index: its array, as getX reads it)
  const n = idx ? idx.count / 3 : pos.count / 3, m = Math.ceil(n);
  const F = { o: mesh, P, n: 0, tri: new Int32Array(3 * m), ax: new Int8Array(m), s: new Int8Array(m), c: new Float64Array(m), r: new Float64Array(4 * m), obj: new Float64Array(m) };
  yield* inSteps(n, (t0, t1) => faceRun(F, P, objs, idx, I, t0, t1));   // (DYS-149: STEP triangles a step)
  return F;
}
/** Triangles t0..t1 of axisFaces, onto F. */
function faceRun(F, P, objs, idx, I, t0, t1) {
  for (let t = t0; t < t1; t++) {
    const ia = I ? I[3 * t] : idx ? idx.getX(3 * t) : 3 * t, ib = I ? I[3 * t + 1] : idx ? idx.getX(3 * t + 1) : 3 * t + 1, ic = I ? I[3 * t + 2] : idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    const a = 3 * ia, b = 3 * ib, c = 3 * ic;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, L = Math.hypot(nx, ny, nz) * 0.9999;
    const ax = Math.abs(nx) > L ? 0 : Math.abs(ny) > L ? 1 : Math.abs(nz) > L ? 2 : -1;
    if (ax < 0 || L < 1e-9) continue;
    const i0 = ax === 0 ? 1 : 0, i1 = ax === 2 ? 1 : 2, k = F.n++;
    F.tri[3 * k] = ia; F.tri[3 * k + 1] = ib; F.tri[3 * k + 2] = ic;
    F.ax[k] = ax; F.s[k] = Math.sign(ax === 0 ? nx : ax === 1 ? ny : nz); F.c[k] = (P[a + ax] + P[b + ax] + P[c + ax]) / 3;
    F.r[4 * k] = Math.min(P[a + i0], P[b + i0], P[c + i0]); F.r[4 * k + 1] = Math.max(P[a + i0], P[b + i0], P[c + i0]);
    F.r[4 * k + 2] = Math.min(P[a + i1], P[b + i1], P[c + i1]); F.r[4 * k + 3] = Math.max(P[a + i1], P[b + i1], P[c + i1]);
    F.obj[k] = objs ? objs[ia] : -1;
  }
}

// (2D, for the inlays: the part of polygon q left of the directed edge a -> b, and a polygon's area)
function clipLeft(q, ax, ay, bx, by) {
  const out = [];
  for (let i = 0; i < q.length; i++) {
    const [px, py] = q[i], [qx, qy] = q[(i + 1) % q.length];
    const sp = (bx - ax) * (py - ay) - (by - ay) * (px - ax), sq = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    if (sp >= 0) out.push(q[i]);
    if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([px + (qx - px) * t, py + (qy - py) * t]); }
  }
  return out;
}
function polyArea(q) { let s = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
function ccw2(t) { const [a, b, c] = t; return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0 ? t : [a, c, b]; }

/**
 * A vertex's key for inlays(): the first vertex (by index) at its position rounded to 1e-6 m, so two vertices share a key
 * when the strings `${x},${y},${z}` of their rounded coordinates were equal. Asked once per vertex, from an open-addressing
 * table of the rounded positions (DYS-149: numbers, not three strings per triangle, the most of inlays()'s cost and garbage).
 */
function vertexKeys(W) {
  const count = W.length / 3, id = new Int32Array(count).fill(-1);
  let cap = 1;
  while (cap < 2 * count) cap *= 2;
  const table = new Int32Array(cap).fill(-1), mask = cap - 1;
  const key = (i) => {
    if (id[i] >= 0) return id[i];
    const x = Math.round(W[3 * i] * 1e6), y = Math.round(W[3 * i + 1] * 1e6), z = Math.round(W[3 * i + 2] * 1e6);
    for (let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & mask; ; h = (h + 1) & mask) {
      const j = table[h];
      if (j < 0) { table[h] = i; return (id[i] = i); }
      if (Math.round(W[3 * j] * 1e6) === x && Math.round(W[3 * j + 1] * 1e6) === y && Math.round(W[3 * j + 2] * 1e6) === z) return (id[i] = j);
    }
  };
  // (seen/at: per plane, a key's first face, without a new Map per plane: `seen` holds the plane's number)
  return { key, seen: new Int32Array(count), at: new Int32Array(count), plane: 0 };
}

/**
 * A mesh's inlays (above), from its axis faces F (axisFaces) by object and axis (`planes`: key -> the faces' numbers in
 * F, in F's order): their faces as yieldCoplanar's list entries, set to yield behind the face they lie in, onto `out`.
 * (DYS-149: a plane's work in functions of its own (inlayPlane, joinCorners, coverOf), each compiled once: V8 compiled
 * this one's inner loops on their own, on the stack, and threw that away at every loop's end, ~300 times a sweep.)
 * (DYS-149: a step a plane that goes further than its sort)
 */
function* inlays(F, planes, checks, out) {
  const C = F.c;
  let vk = null;
  for (const list of planes.values()) {
    if (list.length < 3) continue;
    list.sort((a, b) => C[a] - C[b]);
    for (let g0 = 0; g0 < list.length;) {
      const g1 = planeEnd(C, list, g0);
      if (g1 - g0 >= 3) { inlayPlane(F, list, g0, g1, (vk ??= vertexKeys(F.P)), checks, out); yield; }
      g0 = g1;
    }
  }
}

/** Where the plane that starts at list[g0] ends: each face after it within INLAY_EPS of the one before. */
function planeEnd(C, list, g0) {
  let g1 = g0 + 1;
  while (g1 < list.length && C[list[g1]] - C[list[g1 - 1]] <= INLAY_EPS) g1++;
  return g1;
}

function findRoot(up, i) { while (up[i] !== i) i = up[i] = up[up[i]]; return i; }

/**
 * A plane's faces (F's list[g0..g1)) joined where they share a corner (by the vertices' number keys, vertexKeys):
 * each face's parent (`up`, union-find, as faces 0..g1 - g0).
 */
function joinCorners(F, list, g0, g1, vk) {
  const nf = g1 - g0, up = new Int32Array(nf), plane = ++vk.plane, tri = F.tri, seen = vk.seen, at = vk.at;
  for (let i = 0; i < nf; i++) up[i] = i;
  for (let c = 0; c < 3 * nf; c++) {   // (face i = c / 3's corners in turn: one loop, not one in another)
    const i = (c / 3) | 0, k = vk.key(tri[3 * list[g0 + i] + (c % 3)]);
    if (seen[k] === plane) up[findRoot(up, i)] = findRoot(up, at[k]); else { seen[k] = plane; at[k] = i; }
  }
  return up;
}

/**
 * How much of piece sm the triangles of piece bg cover (clipped area), summed as far as `need`: the sum only grows, so
 * once it reaches `need` the rest can't take it back under (DYS-149: as sure a yes as the whole sum); each triangle's
 * corners put counter-clockwise once, not for every pair.
 */
function coverOf(sm, bg, need) {
  const A = sm.tris, B = bg.tris, nb = B.length, n = A.length * nb;
  let cover = 0;
  for (let p = 0; p < n; p++) {   // (each of sm's triangles f against each of bg's b in turn: one loop, not one in another)
    const f = A[(p / nb) | 0], b = B[p % nb];
    if (b.r[0] > f.r[1] || b.r[1] < f.r[0] || b.r[2] > f.r[3] || b.r[3] < f.r[2]) continue;
    if ((cover += clipArea(f, b)) >= need) return cover;
  }
  return cover;
}

/** The area of triangle f inside triangle b (0 when under three corners are left): f clipped by b's three edges in turn. */
function clipArea(f, b) {
  let q = (f.ccw ??= ccw2(f.uv));
  const t = (b.ccw ??= ccw2(b.uv));
  if (q.length) q = clipLeft(q, t[0][0], t[0][1], t[1][0], t[1][1]);
  if (q.length) q = clipLeft(q, t[1][0], t[1][1], t[2][0], t[2][1]);
  if (q.length) q = clipLeft(q, t[2][0], t[2][1], t[0][0], t[0][1]);
  return q.length > 2 ? polyArea(q) : 0;
}

/** One plane's inlays (F's faces list[g0..g1)), into out (and their checks). */
function inlayPlane(F, list, g0, g1, vk, checks, out) {
  const o = F.o, W = F.P, nf = g1 - g0, uv1 = o.geometry.attributes.uv1;
  // the plane's faces: its triangles joined where they share a corner (DYS-149: a plane in one piece, most of them, goes no further)
  const up = joinCorners(F, list, g0, g1, vk);
  let pieces = 0;
  for (let i = 0; i < nf; i++) if (up[i] === i) pieces++;
  if (pieces < 2) return;
  const ax = F.ax[list[g0]], i0 = ax === 0 ? 1 : 0, i1 = ax === 2 ? 1 : 2, fs = [];
  for (let i = 0; i < nf; i++) {
    const k = list[g0 + i], tri = [F.tri[3 * k], F.tri[3 * k + 1], F.tri[3 * k + 2]];
    fs.push({ tri, ax, s: F.s[k], c: F.c[k], r: [F.r[4 * k], F.r[4 * k + 1], F.r[4 * k + 2], F.r[4 * k + 3]], uv: tri.map((j) => [W[3 * j + i0], W[3 * j + i1]]), ccw: null });
  }
  const comps = new Map();
  fs.forEach((f, i) => { const r = findRoot(up, i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(f); });
  const cs = [...comps.values()].map((tris) => {
    const ext = [Infinity, -Infinity, Infinity, -Infinity];
    for (const f of tris) { ext[0] = Math.min(ext[0], f.r[0]); ext[1] = Math.max(ext[1], f.r[1]); ext[2] = Math.min(ext[2], f.r[2]); ext[3] = Math.max(ext[3], f.r[3]); }
    let area = 0, front = 0;
    for (const f of tris) { const a = polyArea(f.uv); area += a; front += f.s * a; }
    return { tris, ext, area, s: front >= 0 ? 1 : -1 };   // (s: the way most of it faces)
  }).sort((a, b) => b.area - a.area);
  for (let j = 1; j < cs.length; j++) {
    const sm = cs[j];
    if (sm.area < 1e-6) continue;
    for (let i = 0; i < j; i++) {
      const bg = cs[i], e = 1e-6;
      if (bg.area <= sm.area || sm.ext[0] < bg.ext[0] - e || sm.ext[1] > bg.ext[1] + e || sm.ext[2] < bg.ext[2] - e || sm.ext[3] > bg.ext[3] + e) continue;
      const need = 0.98 * sm.area;
      if (coverOf(sm, bg, need) < need) continue;
      // (behind the bigger face's front, whichever way the inlay's own faces look: a box the grid made flat goes as one)
      const faces = sm.tris.map((f) => ({ o, tri: f.tri, ax: f.ax, s: bg.s, own: f.s, c: f.c, r: f.r, by: null, d: PART_YIELD, hit: true }));
      out.push(...faces);
      // (one that mostly looks the way the face does is checked against the bake: the light map at its biggest such
      // triangle's middle, and the face's there)
      const same = sm.tris.filter((f) => f.s === bg.s);
      if (checks && uv1 && same.reduce((a, f) => a + polyArea(f.uv), 0) >= 0.25 * sm.area) {
        const f = same.reduce((x, y) => (polyArea(y.uv) > polyArea(x.uv) ? y : x)), m = [0, 1].map((k) => (f.uv[0][k] + f.uv[1][k] + f.uv[2][k]) / 3);
        const bary = (t) => { const [a, b, c] = t, d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          const w0 = ((b[1] - c[1]) * (m[0] - c[0]) + (c[0] - b[0]) * (m[1] - c[1])) / d, w1 = ((c[1] - a[1]) * (m[0] - c[0]) + (a[0] - c[0]) * (m[1] - c[1])) / d;
          return [w0, w1, 1 - w0 - w1]; };
        const lightUv = (tri, w) => [0, 1].map((k) => tri.reduce((a, vi, j) => a + w[j] * uv1.getComponent(vi, k), 0));
        const b = bg.tris.find((t) => bary(t.uv).every((x) => x > -1e-6));
        if (b) checks.push({ faces, atlas: o.userData.tag?.atlas, inlay: lightUv(f.tri, [1 / 3, 1 / 3, 1 / 3]), face: lightUv(b.tri, bary(b.uv)) });
      }
      break;
    }
  }
}

// (DYS-149) The faces that may yield, by plane: the axis, the facing and c in bins of 2 PLANE_EPS, so a face is tested
// against those in its own bin and the two beside it (every face within PLANE_EPS of it is in one of them), not against
// every face of the list (that scan, test(), was 19 ms of the 244 ms freeze on a mid phone). The tests are its tests,
// so the same faces are hit, and the hit ones go to moveFaces in the list's order (the shell's, then the parts', as they came).
const BIN = 2 * PLANE_EPS;
const binKey = (ax, s, b) => 6 * b + 2 * ax + (s > 0 ? 1 : 0);
function yieldList(d) { return { d, F: [], k: [], by: [], hit: [], bins: new Map() }; }
function addYield(L, F, k, by) {
  const i = L.F.length, key = binKey(F.ax[k], F.s[k], Math.floor(F.c[k] / BIN)), bin = L.bins.get(key);
  L.F.push(F); L.k.push(k); L.by.push(by); L.hit.push(false);
  if (bin) bin.push(i); else L.bins.set(key, [i]);
}
/** Hit each face of L in the plane of F's k-th face (within PLANE_EPS), facing its way, of its object when it asks for one, and overlapping it. */
function testYield(L, F, k) {
  const ax = F.ax[k], s = F.s[k], c = F.c[k], obj = F.obj[k], b = Math.floor(c / BIN);
  const u0 = F.r[4 * k], u1 = F.r[4 * k + 1], v0 = F.r[4 * k + 2], v1 = F.r[4 * k + 3];
  for (let db = -1; db <= 1; db++) {
    const bin = L.bins.get(binKey(ax, s, b + db));
    if (!bin) continue;
    for (const i of bin) {
      const p = L.F[i], j = L.k[i], r = p.r;
      if (L.hit[i] || p.ax[j] !== ax || p.s[j] !== s || Math.abs(p.c[j] - c) > PLANE_EPS || (L.by[i] !== null && L.by[i] !== obj)) continue;
      if (Math.min(r[4 * j + 1], u1) - Math.max(r[4 * j], u0) > 1e-3 && Math.min(r[4 * j + 3], v1) - Math.max(r[4 * j + 2], v0) > 1e-3) L.hit[i] = true;
    }
  }
}
// (DYS-149: a mesh's faces in functions of their own, so the loop over the meshes holds no loop of its own; see inlays;
// and its faces k0..k1, a step's)
function addObjects(set, F, k0, k1) { for (let k = k0; k < k1; k++) set.add(F.obj[k]); }
function addFaces(L, F, k0, k1) { for (let k = k0; k < k1; k++) addYield(L, F, k, null); }
function testFaces(L, F, k0, k1) { for (let k = k0; k < k1; k++) testYield(L, F, k); }
/**
 * A mesh's faces (k0..k1) against the shell (it yields to them), into `under` when of a part's object (partObjects,
 * given for a joined mesh) and into `planes` (if given) by object and axis: 3 obj + ax, in the order they come, as the
 * keys `${obj}|${ax}` were.
 */
function sweepFaces(F, shell, under, partObjects, planes, k0, k1) {
  const nrm = F.o.geometry.attributes.normal, tri = F.tri;
  for (let k = k0; k < k1; k++) {
    if (shell.F.length) testYield(shell, F, k);
    const obj = F.obj[k], ax = F.ax[k], t = 3 * k;
    // (not a triangle wound against its own vertices' normals: a fold of the surface round it, whose corners it shares;
    // the notebook's first page has one at its spine, and moving it lifted the page, which notebook.js measures)
    if (partObjects && partObjects.has(obj) && (!nrm || (nrm.getComponent(tri[t], ax) + nrm.getComponent(tri[t + 1], ax) + nrm.getComponent(tri[t + 2], ax)) * F.s[k] > 0)) addYield(under, F, k, obj);
    if (planes) { const key = 3 * obj + ax, list = planes.get(key); if (list) list.push(k); else planes.set(key, [k]); }
  }
}
/** L's hit faces as moveFaces' entries, in L's order. */
function yieldHits(L, out) {
  for (let i = 0; i < L.F.length; i++) {
    if (!L.hit[i]) continue;
    const F = L.F[i], k = L.k[i];
    out.push({ o: F.o, tri: [F.tri[3 * k], F.tri[3 * k + 1], F.tri[3 * k + 2]], ax: F.ax[k], s: F.s[k], c: F.c[k],
      r: [F.r[4 * k], F.r[4 * k + 1], F.r[4 * k + 2], F.r[4 * k + 3]], by: L.by[i], d: L.d, hit: true });
  }
}

/**
 * Set back the faces that lie under another surface in its plane (BUG-1, the parts and the inlays, above). Returns how
 * many moved; `checks`, if given, gets the inlays to check against the bake (Room.settleInlays). `world`, if given: mesh
 * -> { P, obj }, its world positions and vertices' objects, already read (Room._indexVertexIds).
 */
export function yieldCoplanar(meshes, checks = null, world = null) { return runAll(coplanarSteps(meshes, checks, world)); }
/** yieldCoplanar as steps (DYS-149: STEP faces a step, a plane's inlays a step, see runAll). */
function* coplanarSteps(meshes, checks, world) {
  const isShell = (o) => SHELL_CLASSES.has(o.userData.tag?.cls), isPart = (o) => !!o.userData.tag?.part;
  // (DYS-149: each mesh's axis faces once)
  const faces = new Map();
  function* facesOf(o) { let F = faces.get(o); if (!F) { F = yield* axisFaces(o, world?.get(o)); faces.set(o, F); } return F; }
  const parts = meshes.filter(isPart), partObjects = new Set();
  for (const o of parts) { const F = yield* facesOf(o); yield* inSteps(F.n, (k0, k1) => addObjects(partObjects, F, k0, k1)); }
  // the faces that may yield: by (a part's object, or null: anything), d; the shell's first
  const shell = yieldList(SHELL_YIELD), under = yieldList(PART_YIELD), inlaid = [];
  for (const o of meshes) if (isShell(o)) { const F = yield* facesOf(o); yield* inSteps(F.n, (k0, k1) => addFaces(shell, F, k0, k1)); }
  // (one pass over every other mesh: the shell yields to it, and a joined mesh's faces of a part's object are kept)
  for (const o of meshes) {
    if (isShell(o)) continue;
    const planes = isPart(o) ? null : new Map(), F = yield* facesOf(o), po = !isPart(o) && partObjects.size > 0 ? partObjects : null;
    yield* inSteps(F.n, (k0, k1) => sweepFaces(F, shell, under, po, planes, k0, k1));
    // (and an object's inlays go under the face they lie in)
    if (planes) yield* inlays(F, planes, checks, inlaid);
  }
  // (then a joined face yields to the part of its own object)
  for (const o of parts) if (under.F.length) { const F = yield* facesOf(o); yield* inSteps(F.n, (k0, k1) => testFaces(under, F, k0, k1)); }
  const hit = [];
  yieldHits(shell, hit); yieldHits(under, hit);
  return yield* moveSteps([...hit, ...inlaid]);
}

/** Move each hit face's vertices (each once) by `d` against its facing `s` along its axis, in world space. Returns how many. */
export function moveFaces(faces) { return runAll(moveSteps(faces)); }
/** moveFaces as steps (DYS-149: STEP / 8 faces a step, then each mesh's bounds in steps of STEP positions). */
function* moveSteps(faces) {
  let moved = 0;
  // mesh -> its vertices moved (each once), its world matrix's inverse and whether it is on the grid (DYS-149: once a mesh, not a face)
  const done = new Map(), v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let f0 = 0; f0 < faces.length; f0 += STEP / 8) { moved += moveRun(faces, f0, Math.min(faces.length, f0 + STEP / 8), done, v, w); yield; }
  for (const o of done.keys()) { o.geometry.attributes.position.needsUpdate = true; yield* rebound(o.geometry); }
  return moved;
}
/** Faces f0..f1 of moveFaces; returns how many of them moved. */
function moveRun(faces, f0, f1, done, v, w) {
  let moved = 0;
  for (let f = f0; f < f1; f++) {
    const p = faces[f];
    if (!p.hit) continue;
    const pos = p.o.geometry.attributes.position;
    let m = done.get(p.o);
    if (!m) done.set(p.o, (m = { seen: new Set(), inv: p.o.matrixWorld.clone().invert(), grid: !pos.normalized && !(pos.array instanceof Float32Array || pos.array instanceof Float64Array) }));
    for (const i of p.tri) {
      if (m.seen.has(i)) continue;
      m.seen.add(i);
      v.fromBufferAttribute(pos, i).applyMatrix4(p.o.matrixWorld);
      v.setComponent(p.ax, v.getComponent(p.ax) - p.s * p.d).applyMatrix4(m.inv);
      if (m.grid) {   // (positions on the export's integer grid: whole steps, at least one, away from where it was)
        w.fromBufferAttribute(pos, i);
        for (let k = 0; k < 3; k++) { const dk = v.getComponent(k) - w.getComponent(k);
          v.setComponent(k, Math.abs(dk) < 1e-6 ? w.getComponent(k) : w.getComponent(k) + Math.sign(dk) * Math.max(1, Math.round(Math.abs(dk)))); }
      }
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    moved++;
  }
  return moved;
}

/**
 * A geometry's bounding box and sphere, as computeBoundingBox() and computeBoundingSphere() make them (the same least and
 * greatest corner, centre and radius) in two passes over its positions, not three (DYS-149: each of the two read every
 * position, the sphere for its own box first). three's own for morph targets, a GL attribute, positions rawReader can't
 * read or a NaN position. (DYS-149: as steps, STEP positions each, the box and the reach carried from one to the next:
 * the same Math.min and Math.max in the same order; the geometry's box and sphere set at the end, the centre as
 * Box3.getCenter gives it, 0 for an empty box.)
 */
function* rebound(g) {
  const pos = g.attributes.position;
  const R = pos && !pos.isGLBufferAttribute && !g.morphAttributes.position && rawReader(pos);
  if (!R) { g.computeBoundingBox(); g.computeBoundingSphere(); return; }
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  yield* inSteps(pos.count, (i0, i1) => rawBox(R, i0, i1, b));
  const [x0, y0, z0, x1, y1, z1] = b;
  if (isNaN(x0) || isNaN(y0) || isNaN(z0)) { g.computeBoundingBox(); g.computeBoundingSphere(); return; }
  const empty = x1 < x0 || y1 < y0 || z1 < z0, cx = empty ? 0 : (x0 + x1) * 0.5, cy = empty ? 0 : (y0 + y1) * 0.5, cz = empty ? 0 : (z0 + z1) * 0.5;
  let r2 = 0;
  yield* inSteps(pos.count, (i0, i1) => { r2 = rawReach(R, i0, i1, cx, cy, cz, r2); });
  if (g.boundingBox === null) g.boundingBox = new THREE.Box3();
  if (g.boundingSphere === null) g.boundingSphere = new THREE.Sphere();
  g.boundingBox.min.set(x0, y0, z0); g.boundingBox.max.set(x1, y1, z1);
  g.boundingSphere.center.set(cx, cy, cz);
  g.boundingSphere.radius = Math.sqrt(r2);
}
/** The least and greatest x, y, z of points i0..i1 read with rawReader's R (as Box3.setFromBufferAttribute: Math.min, Math.max), widening b. */
function rawBox({ a, s, o, d }, i0, i1, b) {
  let [x0, y0, z0, x1, y1, z1] = b;
  for (let i = i0, j = o + i0 * s; i < i1; i++, j += s) {
    const x = d ? a[j] / d : a[j], y = d ? a[j + 1] / d : a[j + 1], z = d ? a[j + 2] / d : a[j + 2];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
  }
  b[0] = x0; b[1] = y0; b[2] = z0; b[3] = x1; b[4] = y1; b[5] = z1;
}
/** The greatest squared distance of points i0..i1 (rawReader's R) from (cx, cy, cz), as Vector3.distanceToSquared sums it, from r2 on. */
function rawReach({ a, s, o, d }, i0, i1, cx, cy, cz, r2) {
  for (let i = i0, j = o + i0 * s; i < i1; i++, j += s) {
    const dx = cx - (d ? a[j] / d : a[j]), dy = cy - (d ? a[j + 1] / d : a[j + 1]), dz = cz - (d ? a[j + 2] / d : a[j + 2]);
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return r2;
}

/** Where the run of vertices with the object of vertex i0 ends (objs: each vertex's object; n of them). */
function runEnd(objs, i0, n) {
  let i = i0 + 1;
  while (i < n && objs[i] === objs[i0]) i++;
  return i;
}
/**
 * The least and greatest x, y, z of vertices i0..i1 of P (world positions), into m: a box widened by them is the same as
 * one widened (expandByPoint) by each of them in turn, Math.min and Math.max being what it takes.
 */
function runBox(P, i0, i1, m) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let j = 3 * i0; j < 3 * i1; j += 3) {
    const x = P[j], y = P[j + 1], z = P[j + 2];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
  }
  m[0] = x0; m[1] = y0; m[2] = z0; m[3] = x1; m[4] = y1; m[5] = z1;
}
/**
 * The laptop's vertices i0..i1: each one's world position (P) and normal (nm the normal matrix), six numbers onto out.
 * (DYS-149: the normal read from its array as getX reads it (Int8 / Int16 normalized: Math.max(v / 127 or 32767, -1)),
 * and Vector3's applyMatrix3 and normalize written out, the same sums in their order; three's own for any other kind)
 */
function laptopRun(nrm, nm, q, P, i0, i1, out) {
  const N = rawNormals(nrm);
  if (!N) {
    for (let i = i0; i < i1; i++) {
      q.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
      out.push(P[3 * i], P[3 * i + 1], P[3 * i + 2], q.x, q.y, q.z);
    }
    return;
  }
  const [e0, e1, e2, e3, e4, e5, e6, e7, e8] = nm.elements, { a, s, o, d } = N;
  for (let i = i0, j = o + i0 * s; i < i1; i++, j += s) {
    const x = d ? Math.max(a[j] / d, -1) : a[j], y = d ? Math.max(a[j + 1] / d, -1) : a[j + 1], z = d ? Math.max(a[j + 2] / d, -1) : a[j + 2];
    const nx = e0 * x + e3 * y + e6 * z, ny = e1 * x + e4 * y + e7 * z, nz = e2 * x + e5 * y + e8 * z;
    const k = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    out.push(P[3 * i], P[3 * i + 1], P[3 * i + 2], nx * k, ny * k, nz * k);
  }
}
/** rawReader for a normal: its array read as getX would, signed normalized (Int8, Int16: d 127, 32767) or as stored (d 0). */
function rawNormals(attr) {
  if (!attr) return null;
  const inter = !!attr.isInterleavedBufferAttribute, base = inter ? THREE.InterleavedBufferAttribute.prototype : THREE.BufferAttribute.prototype;
  if (attr.getX !== base.getX || attr.getY !== base.getY || attr.getZ !== base.getZ) return null;
  const a = inter ? attr.data.array : attr.array;
  const d = !attr.normalized ? 0 : a.constructor === Int8Array ? 127 : a.constructor === Int16Array ? 32767 : -1;
  return d < 0 ? null : { a, s: inter ? attr.data.stride : attr.itemSize, o: inter ? attr.offset : 0, d };
}

export class Room {
  constructor(renderer, shared) {
    this.renderer = renderer;
    this.shared = shared;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.materials = [];
    this.meshes = [];
    this.atlases = new Map();          // name -> uniforms
    this.layerCache = new Map();       // url -> Promise<texture>
    this.window = { corners: DEFAULT_WINDOW.map((p) => new THREE.Vector3(...p)) };
    this.mode = null;
    this.idScene = null;
    this.boundsById = new Map();       // object id -> Box3 (room-local), from per-vertex ids
    this.laptopVerts = [];             // the laptop's positions and normals (world; x, y, z, nx, ny, nz a vertex), for its lid (lidRect)
    this.regionOf = new Map();         // object id -> region id
  }

  /**
   * Per-object bounds and regions from a joined mesh's COLOR_0 ids. `world`, if given, keeps the mesh's world positions
   * and vertices' objects for yieldCoplanar (DYS-149: read once for both).
   */
  _indexVertexIds(mesh, world = null) { runAll(this._indexSteps(mesh, world)); }
  /** _indexVertexIds as steps (DYS-149: STEP vertices a step, see runAll). */
  *_indexSteps(mesh, world) {
    const g = mesh.geometry, col = g.attributes.color, nrm = g.attributes.normal;
    const P = yield* worldPositions(mesh), objs = yield* vertexObjects(col), n = col.count;
    if (world) world.set(mesh, { P, obj: objs });
    // (DYS-149: a run of one object's vertices finds its box once and widens it once, by the run's least and greatest
    // x, y, z: the same box as widening it by each vertex; then the laptop's runs give their vertices, as numbers)
    const laptop = [], m = new Float64Array(6);
    for (let i0 = 0; i0 < n; i0 = Math.min(n, i0 + STEP)) { this._boundRuns(col, objs, P, nrm, laptop, m, i0, Math.min(n, i0 + STEP)); yield; }
    if (laptop.length) {
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld), q = new THREE.Vector3();
      for (let r = 0; r < laptop.length; r += 2) yield* inSteps(laptop[r + 1] - laptop[r], (j0, j1) => laptopRun(nrm, nm, q, P, laptop[r] + j0, laptop[r] + j1, this.laptopVerts));
    }
  }
  /**
   * The runs of one object's vertices in i0..i1 of a step: each widens its object's box. (A run that goes on past i1 ends
   * there, and the next step's first widens the same box: the same box, Math.min and Math.max being what it takes; and
   * the laptop's two ranges give the same vertices in the same order.)
   */
  _boundRuns(col, objs, P, nrm, laptop, m, i0, upto) {
    while (i0 < upto) {
      const obj = objs[i0], i1 = runEnd(objs, i0, upto);
      let b = this.boundsById.get(obj);
      if (!b) { b = new THREE.Box3(); this.boundsById.set(obj, b); this.regionOf.set(obj, Math.round(col.getZ(i0) * 255)); }
      runBox(P, i0, i1, m);
      b.min.set(Math.min(b.min.x, m[0]), Math.min(b.min.y, m[1]), Math.min(b.min.z, m[2]));
      b.max.set(Math.max(b.max.x, m[3]), Math.max(b.max.y, m[4]), Math.max(b.max.z, m[5]));
      if (obj === OBJECTS.laptop && nrm) laptop.push(i0, i1);
      i0 = i1;
    }
  }

  atlas(name) {
    if (!this.atlases.has(name)) this.atlases.set(name, atlasUniforms());
    return this.atlases.get(name);
  }

  /** Build the room from a parsed glTF. `bake` is bake.json; `cubeUV` the probe defines. */
  build(gltf, bake, cubeUV) { return runAll(this._build(gltf, bake, cubeUV)); }
  /**
   * (DYS-149) build in pieces of about `budget` ms (PIECE_MS), a task each: `next` resolves in the next task (context.js
   * nextMessage). The same room as build's; this.pieces: { pieces, longest, work } (ms). Resolves to the room.
   */
  buildSplit(gltf, bake, cubeUV, { budget = PIECE_MS, next = nextMessage } = {}) {
    this.pieces = { pieces: 0, longest: 0, work: 0 };
    return runPieces(this._build(gltf, bake, cubeUV), budget, next, this.pieces);
  }
  /** build as steps (DYS-149: a mesh a step, its ids and the sweep in steps of their own; see runAll). */
  *_build(gltf, bake, cubeUV) {
    const root = gltf.scene;
    if (bake.model_space === "spike-world" && bake.model_root) {
      // the spike was exported in world space: undo the room root's transform
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(new THREE.Matrix4().fromArray(bake.model_root).invert());
      holder.add(root);
      this.scene.add(holder);
    } else this.scene.add(root);
    if (bake.window) this.window.corners = bake.window.map((p) => new THREE.Vector3(...p));
    this.info = bake.info || null;      // { heading_deg, eye: [lat, lon, alt_m] } from room3d.json, for X1
    this.scene.updateMatrixWorld(true);

    const cache = new Map();
    const ids = new Map();
    const bounce = wallBounce(bake);     // (DYS-11)
    this.wallBounced = 0;
    const world = new Map();   // (DYS-149) mesh -> { P, obj }: its world positions and vertices' objects, read once for the ids and yieldCoplanar
    // (DYS-149: the meshes in traverse's order, then each in a step: the loop changes no parent or child)
    const list = [];
    root.traverse((o) => { if (o.isMesh) list.push(o); });
    for (const o of list) {
      const tag = tagOf(o);
      const regionId = Math.max(0, REGIONS.indexOf(tag.region));
      const objId = objectId(tag.object);
      const lightmapped = !!o.geometry.attributes.uv1;
      const cls = o.material?.userData?.sfw?.class;
      const screen = tag.object === "screen" || cls === "screen";
      const src = o.material;
      const key = `${src.uuid}|${tag.atlas}|${lightmapped}|${screen}`;
      let m = cache.get(key);
      if (!m) {
        m = roomMaterial(src, this.shared, this.atlas(tag.atlas), { lightmapped, screen, cubeUV });
        if (bounce && lightmapped && cls === "plaster" && repainted(src.color, bounce.bakedTint)) {
          m.uniforms.uBounce.value.fromArray(bounce.k);
          m.uniforms.uBounceR.value.fromArray(bounce.r);
          this.wallBounced++;
        }
        if (PAINTED.has(cls)) m.uniforms.uClean.value = WALL_CLEAN;   // (DYS-11)
        cache.set(key, m);
        this.materials.push(m);
      }
      const cut = alphaCut(src) > 0;
      const idKey = (tag.vertexIds ? "v|" : `${regionId}|${objId}|`) + (cut ? src.uuid : "");
      let im = ids.get(idKey);
      if (!im) { im = idMaterial(regionId, objId, cut ? src : null, { vertexIds: tag.vertexIds }); ids.set(idKey, im); }
      if (tag.vertexIds) yield* this._indexSteps(o, world);
      o.material = m;
      o.userData.roomMaterial = m;
      o.userData.idMaterial = im;
      o.userData.tag = { ...tag, regionId, objectId: objId, cls };
      o.castShadow = o.receiveShadow = false;
      if (screen && src.emissive && !this.screenMesh) this.screenMesh = { mesh: o, emissive: src.emissive.clone().multiplyScalar(src.emissiveIntensity ?? 1) };
      this.meshes.push(o);
      if (src.dispose) src.dispose();
      yield;
    }
    this.idMaterials = [...ids.values()];
    this.inlayChecks = [];
    this.shellYielded = yield* coplanarSteps(this.meshes, this.inlayChecks, world);   // (BUG-1: the plaster under the oak sill's top; the parts' undersides; the inlays)
    // the front faces the laptop's keyboard (the mesh's own normals may face the lid)
    const deck = this.boundsById.get(OBJECTS.laptop);
    this.screenRect = this.screenMesh ? screenRect(this.screenMesh, deck ? deck.getCenter(new THREE.Vector3()) : null) : null;
    if (this.screenRect) this.screenRect.lid = lidRect(this.screenRect, this.laptopVerts);
    this.laptopVerts = [];
    this.setMode("live");
    return this;
  }

  /** Load and bind one light layer for every atlas it covers: { atlasName: { file, scale } }. */
  async bindLayer(bakeUrl, which, spec) {
    const key = { ambient: ["uAmbient", "uAmbientScale"], sun: ["uSun", "uSunScale"], lamp: ["uLamp", "uLampScale"], screen: ["uScreen", "uScreenScale"] }[which];
    const jobs = [];
    for (const [name, u] of this.atlases) {
      const e = spec ? spec[name] : null;
      if (!e) {
        u[key[0]].value = DEFAULT_TEXTURES.black;
        u[key[1]].value.set(0, 0, 0);
        continue;
      }
      jobs.push(this.layerTexture(within(bakeUrl, e.file)).then((t) => {
        u[key[0]].value = t;
        u[key[1]].value.fromArray(e.scale);
      }));
    }
    await Promise.all(jobs);
    if (which === "ambient" && this.inlayChecks?.length) this.settleInlays();
  }

  /**
   * The inlays the bake shows were on top in Blender (yieldCoplanar, above): once, from the first ambient light maps, an
   * inlay clearly brighter than the face around it (the hidden one baked dark) moves from a step behind that face to a
   * step in front of it: the faces of it that look the way that face does. Returns how many came forward.
   */
  settleInlays() {
    const checks = this.inlayChecks;
    this.inlayChecks = null;
    let px = null;
    try {
      const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(3, 3) : Object.assign(document.createElement("canvas"), { width: 3, height: 3 });
      const g = c.getContext("2d", { willReadFrequently: true });
      px = (img, uv) => {   // the light map's mean luma over 3 x 3 texels at a light uv (glTF: v down the image)
        // (DYS-151: a light map halved for phones (loader.js fitBitmap) is read over the same area as the full one, its
        // 3 x 3 full-size texels resampled: 3 of its own texels covered twice the area and brought 9 inlays forward, not 4)
        const k = img.fullWidth ? img.width / img.fullWidth : 1, W = img.width / k, H = img.height / k;
        const x = Math.min(W - 3, Math.max(0, Math.floor(uv[0] * W) - 1)), y = Math.min(H - 3, Math.max(0, Math.floor(uv[1] * H) - 1));
        g.clearRect(0, 0, 3, 3); g.drawImage(img, x * k, y * k, 3 * k, 3 * k, 0, 0, 3, 3);
        const d = g.getImageData(0, 0, 3, 3).data; let s = 0;
        for (let i = 0; i < 36; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return s / 9;
      };
    } catch { return 0; }
    const up = [];
    for (const k of checks) {
      const img = this.atlases.get(k.atlas)?.uAmbient?.value?.image;
      if (!img || !img.width) continue;
      const a = px(img, k.inlay), b = px(img, k.face);
      k.light = [Math.round(a), Math.round(b)];
      // (its faces that look the way the face does; a flat box's other side stays behind, or the two would fight)
      if (a > 2 * b + 8) up.push(...k.faces.filter((f) => f.own === f.s).map((f) => ({ ...f, d: -2 * PART_YIELD })));
    }
    this.inlaysForward = up.length ? moveFaces(up) : 0;
    this.inlaysChecked = checks;
    return this.inlaysForward;
  }

  layerTexture(url) {
    if (!this.layerCache.has(url)) {
      // (DYS-161 memory: its file and decode options kept on it, so a phone can let it go while zoomed: engine.js dropRoom)
      this.layerCache.set(url, fetchBitmap(url, { fit: true }).then((b) => noteSource(releaseAfterUpload(dataTexture(b, { name: url.split("/").slice(-2).join("/") })),
        { url, opts: { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none" } })));
    }
    return this.layerCache.get(url);
  }

  /** live | prepass | add — the render state every room material is drawn with. */
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const m of this.materials) {
      if (mode === "live") {
        m.colorWrite = true; m.depthWrite = true; m.depthTest = true; m.depthFunc = THREE.LessEqualDepth;
        m.blending = THREE.NoBlending;
      } else if (mode === "prepass") {
        m.colorWrite = false; m.depthWrite = true; m.depthTest = true; m.depthFunc = THREE.LessEqualDepth;
        m.blending = THREE.NoBlending;
      } else {
        m.colorWrite = true; m.depthWrite = false; m.depthTest = true; m.depthFunc = THREE.EqualDepth;
        m.blending = THREE.CustomBlending;
        m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
        m.blendSrc = m.blendDst = m.blendSrcAlpha = m.blendDstAlpha = THREE.OneFactor;
      }
    }
  }

  /** Draw the room into `target` (bound by the caller) with `camera`, in the current mode. */
  draw(camera) {
    this.renderer.render(this.scene, camera);
  }

  /** Draw region and object IDs (RGBA8: R region, G object low byte, B object high byte, A 1 on room surfaces). */
  drawIds(camera) {
    for (const o of this.meshes) o.material = o.userData.idMaterial;
    this.renderer.render(this.scene, camera);
    for (const o of this.meshes) o.material = o.userData.roomMaterial;
  }

  objectBounds(name) {
    const box = new THREE.Box3();
    if (this.boundsById.size) {
      const id = objectId(name);
      for (const [oid, b] of this.boundsById) {
        if (oid === id || (name === "books" && oid >= 256) || (name === "laptop" && oid === OBJECTS.screen)) box.union(b);
      }
    }
    for (const o of this.meshes) if (!o.userData.tag.vertexIds && (o.userData.tag.object === name || (name === "books" && o.userData.tag.region === "books"))) box.expandByObject(o);
    if (box.isEmpty()) return null;
    return { min: box.min.toArray(), max: box.max.toArray(), center: box.getCenter(new THREE.Vector3()).toArray() };
  }

  /** The window opening's bounding box on screen, in device pixels with a GL (bottom-left) origin. */
  windowRect(camera, width, height) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = new THREE.Vector3();
    const pts = [];
    for (const c of this.window.corners) { pts.push(c); pts.push(new THREE.Vector3(c.x, c.y, -1.45)); }
    for (const p of pts) {
      v.copy(p).applyMatrix4(camera.matrixWorldInverse);
      if (v.z > -camera.near) return [0, 0, width, height];    // a corner behind the eye: just use the whole frame
      v.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const px = (t) => Math.floor((t * 0.5 + 0.5) * width), py = (t) => Math.floor((t * 0.5 + 0.5) * height);
    const ax = Math.max(0, px(x0) - 2), ay = Math.max(0, py(y0) - 2);
    const bx = Math.min(width, px(x1) + 3), by = Math.min(height, py(y1) + 3);
    return bx <= ax || by <= ay ? [0, 0, 0, 0] : [ax, ay, bx - ax, by - ay];
  }

  stats() {
    let tris = 0, draws = 0;
    for (const o of this.meshes) {
      draws++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    return { meshes: this.meshes.length, materials: this.materials.length, triangles: tris, drawCalls: draws };
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    for (const m of this.idMaterials || []) m.dispose();
    for (const o of this.meshes) o.geometry.dispose();
    for (const p of this.layerCache.values()) p.then((t) => t.dispose());
  }
}

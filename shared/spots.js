// The room's six spots, its obstacles and the anchors the pages put HTML on, read from one data file.
//
//   import { loadSpots, spotForURL } from "/shared/spots.js";
//   const room = await loadSpots();            // { spots, objects, obstacles, cameras, room, hub }
//   room.spots.shelf                            // { url, label, eye, yaw, pitch, lens, fit, aspect, shiftTan, orbit, mustSee, … }
//   room.points("print")                        // the room-local points of an object (quad corners or box corners)
//
// The numbers live only in the data file: web/room3d/spots.json today (provisional, written by
// scripts/nav/spots_provisional.py from scripts/room.py), room3d.json once R1 exports it. Positions are the
// engine's room-local metres (docs/v3/engine-api.md section 2): x right, y up, -z toward the window. Angles are
// degrees: yaw to the left of the window axis, pitch up.

const SOURCES = ["/room3d/room3d.json", "/room3d/spots.json"];
// m: the eye floor over the desk's top (room.eyeFloor), below every spot's framing, orbit and step back on every screen
// shape (their lowest: 0.769 m, the desk's orbit tipped up and stepped back on a portrait tablet)
const EYE_OVER_DESK = 0.01;
let loading = null;

// ?room3d=/room3d/<set>/room3d.json reads another export first (testing an asset set before it is published)
function sources() {
  const o = typeof location !== "undefined" ? new URLSearchParams(location.search).get("room3d") : null;
  return o && /^\/room3d\/[\w./-]+\.json$/.test(o) && !o.includes("..") ? [o, ...SOURCES] : SOURCES;
}

// The browser's normal caching (never "force-cache": a cached 404 or an old copy of room3d.json would hide a new
// asset set, or name one that has been replaced, until the cache happened to drop it).
export function loadSpots(fetcher = (u) => fetch(u)) {
  return (loading ??= (async () => {
    for (const src of sources()) {
      try {
        const res = await fetcher(src);
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.spots) return makeRoom(data, src);
      } catch { /* the next source */ }
    }
    throw new Error("no spot data");
  })());
}

// Exposed for tests (node): build the room from parsed data.
export function makeRoom(data, src = "inline") {
  normalize(data, src);
  deskB(data);
  const objects = data.objects || {};
  const desk = objects.desk?.box || (data.obstacles || []).find((o) => o.name === "desk")?.box;
  const room = {
    src,
    data,
    spots: data.spots,
    objects,
    obstacles: data.obstacles || [],
    cameras: data.cameras || {},
    inner: data.room?.inner || [[-2, 0, -1.2], [2, 2.9, 4]],
    margin: data.room?.margin ?? 0.18,
    // the lowest the eye may go anywhere (shared/rig.js keepInRoom, zoomRange, walkRange): never below the desk's top
    // (bug 26 Oct, BUG-3: a walk in toward the floor took it under the desk), null without a desk
    eyeFloor: data.room?.eyeFloor ?? (desk ? desk[1][1] + EYE_OVER_DESK : null),
    // the things standing on the desk that are no furniture obstacle (the headphones, the book, the notebook, the
    // breadboard, the parts box, the pen, the phone): the camera keeps clear of them as of furniture (rig.js keepInRoom,
    // walkRange, zoomRange), and they stand in front of the screens' layers (occlude.js onDesk)
    onDesk: desk ? onDesk(objects, data.obstacles || [], desk) : [],
    hub: data.hub || "desk",
    // every point of an object: a quad's corners, or a box's eight corners, or a capsule's ends
    points(name) {
      const o = objects[name];
      if (!o) return null;
      if (o.quad) return o.quad;
      if (o.box) return boxCorners(o.box);
      if (o.capsule) return o.capsule;
      return null;
    },
    centre(name) {
      const p = this.points(name);
      if (!p) return null;
      const c = [0, 0, 0];
      for (const q of p) { c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; }
      return c.map((v) => v / p.length);
    },
    // the object names a spot must keep in sight on this screen shape
    mustSee(spot, portrait) {
      const m = room.spots[spot]?.mustSee || {};
      return (portrait ? m.portrait : m.landscape) || m.landscape || [];
    },
    // objects that must be on screen but may sit under the masthead (the desk's notebook, its window)
    visible(spot) {
      return room.spots[spot]?.mustSee?.visible || [];
    },
    // the photograph camera that rendered a scene.json view of this size (null if none matches)
    photoCamera(view, size) {
      const list = room.cameras[view] || [];
      if (!size) return list[0] || null;
      return list.find((c) => Math.abs(c.size[0] / c.size[1] - size[0] / size[1]) < 0.01) || null;
    },
  };
  return room;
}

// R1's export and the provisional file say some things differently; the code reads one shape (docs/v3/nav.md):
//   - a camera or a spot given by eye + target (+ shift, sensor_mm) gets forward, up, yaw, pitch and shiftTan;
//   - bake, model and pano (the outside's panorama, docs/v3/outside.md) relative to room3d.json are resolved against it;
//   - shelf_front (the spines' plane) falls back to the shelf box's front face, and the desk's link to the shelf
//     outlines shelf_low, else shelf_right, else the shelf.
const DEG = Math.PI / 180;
function aim(o) {
  if (!o || !o.eye) return;
  if (!o.forward && o.target) {
    const d = [0, 1, 2].map((i) => o.target[i] - o.eye[i]), l = Math.hypot(...d) || 1;
    o.forward = d.map((v) => v / l);
  }
  const f = o.forward;
  if (f && !o.up) {
    // no roll: right = forward x world up, up = right x forward
    const r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0], rl = Math.hypot(...r) || 1;
    const rn = r.map((v) => v / rl);
    o.up = [rn[1] * f[2] - rn[2] * f[1], rn[2] * f[0] - rn[0] * f[2], rn[0] * f[1] - rn[1] * f[0]];
  }
  if (f && (o.yaw == null || o.pitch == null)) {
    o.yaw = Math.atan2(-f[0], -f[2]) / DEG;
    o.pitch = Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG;
  }
  if (!o.shiftTan && o.shift && o.lens) o.shiftTan = o.shift.map((v) => (v * (o.sensor_mm || 36)) / o.lens);
}
function normalize(data, src) {
  for (const list of Object.values(data.cameras || {})) for (const c of list) aim(c);
  for (const s of Object.values(data.spots || {})) aim(s);
  if (typeof location !== "undefined" && src !== "inline") {
    const base = new URL(src, location.href);
    for (const k of ["bake", "model", "pano", "tex"]) if (typeof data[k] === "string") data[k] = new URL(data[k], base).pathname;
  }
  const o = data.objects || (data.objects = {});
  if (!o.shelf_front && o.shelf?.box) {
    const [a, b] = o.shelf.box, z = b[2] - 0.012;
    o.shelf_front = { quad: [[a[0], b[1], z], [b[0], b[1], z], [b[0], a[1], z], [a[0], a[1], z]] };
  }
  data.links = data.links || {};
  if (!data.links.shelf) data.links.shelf = o.shelf_low ? "shelf_low" : o.shelf_right ? "shelf_right" : "shelf";
}

// Interactions B (spec v2, 16 Oct): the new desk's notebook, phone, headphones and breadboard, ahead of the export
// (room_export.py can write the same numbers later; any key the export has wins):
//   - the notebook is his writing: its spot's address is /writing/ and its accessible name "Writing" (his site has no
//     heading for the essays), never painted; its page (the first leaf, under the cover: notebook_page) and the open
//     spread (notebook_spread) from the cover's hinge (room.py build_closed_notebook: A4 215 x 290 mm, the page block
//     inset 3 mm at the head, tail and fore edge, the cover 213 mm wide); the orbit turns about the page;
//   - a "phone" spot: the router frames it square on to the phone's screen (shared/phone.js); this entry is the
//     framing data (lens, orbit, must-see) and a rest pose until the 3D's screen is known; no address of its own (a
//     history entry, like the window);
//   - the breadboard's link outlines the board itself (its box runs down the back of the desk with the USB cable), and
//     its dev board's LED (room.py build_breadboard_set: the holder at (-0.70, 0.80) turned 8 deg, the LED on the
//     ESP32 board; the live model leaves that 1.6 mm part out) is a point.
const UP = [0, 1, 0];
function deskB(data) {
  const S = data.spots || {}, O = data.objects || (data.objects = {});
  const L = data.links || (data.links = {}), K = data.pick || (data.pick = {});
  const nb = S.notebook, cv = O.notebook_cover;
  if (nb && nb.url === "/#about") { nb.url = "/writing/"; nb.label = "Writing"; }
  if (cv?.pivot && cv.axis) {
    const P = cv.pivot, Y = norm3(cv.axis), X = norm3(cross3(Y, UP));
    const at = (x, y, dy = 0) => [P[0] + X[0] * x + Y[0] * y, P[1] + dy, P[2] + X[2] * x + Y[2] * y];
    if (!O.notebook_page) O.notebook_page = { quad: [at(0.0015, 0.142, 0.0001), at(0.21, 0.142, 0.0001), at(0.21, -0.142, 0.0001), at(0.0015, -0.142, 0.0001)] };
    if (!O.notebook_spread) O.notebook_spread = { quad: [at(-0.2131, 0.145), at(0.21, 0.145), at(0.21, -0.145), at(-0.2131, -0.145)] };
    if (nb?.orbit) nb.orbit.pivot = at(0.106, 0, 0.0001);
    if (nb) nb.mustSee = { landscape: ["notebook_spread"], portrait: ["notebook_page"] };
  }
  if (O.phone?.box && !S.phone) {
    const [a, b] = O.phone.box, c = [(a[0] + b[0]) / 2, b[1], (a[2] + b[2]) / 2];
    S.phone = {
      url: null, label: "Phone", eye: [c[0] + 0.006, c[1] + 0.31, c[2] + 0.02], yaw: 13.8, pitch: -88.8, lens: 35, sensor_mm: 36,
      fit: "horizontal", aspect: 1.6, shiftTan: [0, 0], fstop: null, focus: null,
      orbit: { model: "pivot", pivot: c, yaw: [-10, 10], pitch: [-6, 6], stretch: 6, zoom: [-0.06, 0.08] },
      mustSee: { landscape: ["phone"], portrait: ["phone"] },
    };
    if (!K.phone) K.phone = "phone";
  }
  // masthead-r2 (Akshay, 20 Oct): Poor Charlie's Almanack on the desk is the way to the bookshelf (Books left the menu):
  // a click or a tap on it glides to the shelf, as one on the shelf does
  if (O.desk_book && !K.desk_book) K.desk_book = "shelf";
  if (O.breadboard && !O.breadboard_board) O.breadboard_board = { box: [[-0.792, 0.75, -0.848], [-0.612, 0.79, -0.752]] };
  if (O.breadboard_board && !L.breadboard) L.breadboard = "breadboard_board";
  if (O.breadboard && !O.breadboard_led) O.breadboard_led = { point: [-0.72496, 0.7733, -0.79942] };
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// The objects whose box stands on the desk's top (from at most 2 cm above it, taller than 5 mm, under half a metre, over
// its footprint), less the obstacles and the room's own parts: [{ name, box }].
function onDesk(objects, obstacles, desk) {
  const top = desk[1][1], skip = new Set(["room", "window", "desk", "screen", ...obstacles.map((o) => o.name)]);
  return Object.entries(objects).filter(([k, o]) => {
    const b = o?.box;
    return b && !skip.has(k) && !k.startsWith("book:") && b[0][1] <= top + 0.02 && b[1][1] > top + 0.005 && b[1][1] < top + 0.5 &&
      b[0][0] < desk[1][0] && b[1][0] > desk[0][0] && b[0][2] < desk[1][2] && b[1][2] > desk[0][2];
  }).map(([name, o]) => ({ name, box: o.box }));
}

export function boxCorners([a, b]) {
  const out = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) out.push([x, y, z]);
  return out;
}

const norm = (p) => p.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/";

// Which spot an address is. The window spot has no address of its own (a history entry on the same URL).
export function spotForURL(room, href, state) {
  if (state && state.sfw && state.spot && room.spots[state.spot]) return state.spot;
  const u = new URL(href, "http://x/");
  const path = norm(u.pathname);
  // (the bio lives on the name now: /#about is the desk with the name's card; the notebook is his writing, and every
  // essay's address, /writing/<slug>, is the notebook with the essay lifted out of it)
  if (path === "/" && u.hash === "#about") return "desk";
  if (path === "/writing" || path.startsWith("/writing/")) return room.spots.notebook ? "notebook" : null;
  for (const [name, s] of Object.entries(room.spots)) {
    if (!s.url) continue;
    const su = new URL(s.url, "http://x/");
    if (norm(su.pathname) === path && !su.hash) return name;
  }
  return path === "/" ? "desk" : null;
}

export function urlForSpot(room, name) {
  return room.spots[name]?.url || null;
}

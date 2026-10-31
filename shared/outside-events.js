// The city's events, drawn outside the window (stream X1): X2's city clock (web/shared/city) gives every event as a
// pure function of time, in metres around the desk eye; this file projects them through whatever camera is live and
// fills the three renderers' buffers (plan v1 2.3):
//   points     traffic, beacons and lighthouses, bridge lamps, aircraft and vessel lights, cabin windows
//   sky dots   aircraft by day, gulls (a flapping V)
//   hulls      ships, tour boats, sailboats and ferries from the motion track's lit 24-heading atlas, with wakes
// Sprites take the rendered moment's light (state.moment, each item's look.moment), fade toward the panorama behind
// them by their haze, and are hidden by the panorama's sharp depth and by the room (outside.glsl.js).
import { CLASSES, hullSprite, carSprite, deskPx, PHONE_MIN_PX, SPINNAKERS, TRIMS } from "./city/sprites.js";
import { CAR_PAINT, STREET_SHOW } from "./city/tables.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const POINT_FLOATS = 15;     // pos4 colour4 shape4 dir3
export const HULL_FLOATS = 35;      // pos4 cell0 4 cell1 4 more4 look4 sun4 dir3 warp4 livery4
export const MAX_WAKES = 16;
// v3/street-traffic rebuild: a street vehicle drawn as a 3D mesh (outside.js drawCars3d): its place on the road (room
// frame, m from the panorama's eye), its axes (right, forward, up; room frame), distance, opacity, haze, lamps on,
// brake lamps, model number, view (0..7), paint (linear rgb), the eye's direction to it, length, beam, height
// a 3D car's floats in cars3d (fill(), below): 0-2 position, 3-5 right, 6-8 forward, 9-11 up, 12 distance, 13 alpha x mesh
// weight, 14 haze, 15 lights, 16 brake, 17 mesh, 18 detail level, 19-21 linear paint, 22-24 direction from the eye,
// 25 length, 26 beam, 27 height; 28-29 two fixed numbers of the vehicle's own, 0..1 (DYS-157 round 2: its clearcoat
// and its roof's shape, outside.js drawCarGroup)
export const CAR3D_FLOATS = 30;
// (a vehicle's own fixed number 0..1 from its id and a salt: FNV-1a, the same every frame and on every visit, so what
// varies per car never flickers or swaps between cars)
const idU = (id, salt) => {
  const s = `${salt}:${id ?? ""}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
const DECK_D = 5300;                // m from the window to the bridge's deck (env.stats.deck's contrast is read there)
export const MESH_MIN_PX = 3;
const MESH_ZOOM = 1.05;             // magnified past this, the 3D vehicles; below, the specks and lamps (today's 1x)       // device px long: smaller, a speck (and its lamps) as before

const RGB = { white: [1.0, 0.93, 0.82], red: [1.0, 0.12, 0.07], green: [0.35, 1.0, 0.55], amber: [1.0, 0.68, 0.32], warm: [1.0, 0.78, 0.5] };
const FLOOD = { sodium: [1.0, 0.62, 0.28], led: [0.93, 0.96, 1.0] };
// navigation lights on a ship's sprite model (boats.json nav, metres: x starboard, y forward, z up): which rig point
// each of the clock's lights (ships.js lights()) sits on, and how bright it reads (the masthead a little brighter:
// the brightest light a ship shows, seen first)
const NAV = { mast1: ["mast_fwd", 1, 1.3], mast2: ["mast_aft", 1, 1.3], green: ["side", 1, 1.0], red: ["side", -1, 1.0], stern: ["stern", 1, 0.9] };

/**
 * roomFrame(axisDeg, eye, shift): the room frame of the panorama. ENU metres around the city's eye -> engine world
 * coordinates. shift: the city's eye minus the panorama's eye (east, north metres; routes.json's eye_scene against
 * pano.json's eye.world_m), so the events are seen from the eye the panorama was rendered from.
 */
export function roomFrame(axisDeg, eye, shift = [0, 0]) {
  const s = Math.sin(axisDeg * DEG), c = Math.cos(axisDeg * DEG);
  const [sx, sy] = shift;
  return {
    // east, north, up (m from the city's eye) -> room frame (x right, y up, z back), around the panorama's eye
    rel(x, y, z) { x += sx; y += sy; return [x * c - y * s, z, -(x * s + y * c)]; },
    world(x, y, z) { const r = this.rel(x, y, z); return [eye[0] + r[0], eye[1] + r[1], eye[2] + r[2]]; },
    // compass heading -> (right, forward) unit vector in the room frame
    heading(h) { return [Math.sin((h - axisDeg) * DEG), Math.cos((h - axisDeg) * DEG)]; },
  };
}

// eyeH: the panorama's eye above the water (pano.json eye.asl_m), for the lights' reflections
// carAtlas: the street vehicles' (web/live/sprites/cars.json; v3/street-traffic), drawn with the hull program from
// their own textures (outside.js drawSprites, a second pass); without it the street cars stay points
// The street vehicles' 3D meshes (web/live/meshes/cars-lod.json) come later, lazily (setCarMeshes; their `ready` set once
// the GPU has them): drawn so only while magnified (cam.zoom > MESH_ZOOM, so the switch happens as the magnifier starts,
// never at rest) wherever a vehicle is MESH_MIN_PX or more long, faded in over the specks by env.meshW
export function createEvents({ axisDeg, eye, atlas, carAtlas = null, eyeH = 113.81, shift = [0, 0] }) {
  const F = roomFrame(axisDeg, eye, shift);
  let carMeshes = null, meshNames = [];
  // the mesh a street vehicle is drawn with: its own model, else the fleet's (v2) one for its type (the street tables
  // name the earlier file's models: the Model 3 is drawn as the Camry; the box truck and the motorbike have their own)
  const MESH_FOR = { type: { boxtruck: "boxtruck", motorbike: "moto_mt07" }, model: { model3: "camry" } };
  const meshOf = (v) => {
    const t = MESH_FOR.type[v.type];
    if (t && meshNames.includes(t)) return t;
    return meshNames.includes(v.model) ? v.model : MESH_FOR.model[v.model] ?? v.model;
  };
  let cars3d = new Float32Array(CAR3D_FLOATS * 64), n3 = 0;
  const order3 = [];
  // an east-north-up vector in the room frame (rotation only)
  const sA = Math.sin(axisDeg * DEG), cA = Math.cos(axisDeg * DEG);
  const toRoom = (x, y, z) => [x * cA - y * sA, z, -(x * sA + y * cA)];
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  let pts = new Float32Array(POINT_FLOATS * 1024);
  let hulls = new Float32Array(HULL_FLOATS * 128);
  let cars = new Float32Array(HULL_FLOATS * 256);
  let nc = 0;
  const wakeP = new Float32Array(MAX_WAKES * 4), wakeQ = new Float32Array(MAX_WAKES * 4), wakeR = new Float32Array(MAX_WAKES * 4);
  let np = 0, nh = 0, nw = 0, nsp = 0, inStreet = false;   // (nsp: the street vehicles' points, for the blink log)

  // camera: { vp: Float64Array(16) column-major view-projection (no jitter, sway included), width, height, pxPerRad,
  //           css: device px per CSS px, phone: bool }
  let cam = null;
  function project(x, y, z) {
    const w = F.world(x, y, z), m = cam.vp;
    const cx = m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12];
    const cy = m[1] * w[0] + m[5] * w[1] + m[9] * w[2] + m[13];
    const cw = m[3] * w[0] + m[7] * w[1] + m[11] * w[2] + m[15];
    if (cw <= 1e-6) return null;
    const px = (cx / cw * 0.5 + 0.5) * cam.width, py = (cy / cw * 0.5 + 0.5) * cam.height;
    if (px < -200 || px > cam.width + 200 || py < -200 || py > cam.height + 200) return null;
    return [px, py];
  }
  const distOf = (x, y, z) => Math.hypot(x, y, z);

  function grow() {
    if ((np + 1) * POINT_FLOATS > pts.length) { const n = new Float32Array(pts.length * 2); n.set(pts); pts = n; }
  }
  // one point. shape 0 light (added), 1 water streak (added; lenCss its length), 2 speck / sky dot (over),
  // 3 gull (over; lenCss its wingspan, wing the wing angle -1..1). aShape = (sigma px | wing, shape, length px, size px)
  function point(x, y, z, rgb, a, sigCss, shape, lenCss = 0, wing = 0) {
    const p = project(x, y, z);
    if (!p || a <= 0.002) return;
    grow();
    const d = distOf(x, y, z), r = F.rel(x, y, z);
    const sig = sigCss * cam.css, len = lenCss * cam.css;
    const size = shape === 3 ? Math.ceil(len * 1.2 + 4) : shape === 1 ? Math.ceil(Math.max(sig * 6, len * 2) + 2) : Math.max(3, Math.ceil(sig * 7));
    pts.set([p[0], p[1], size, d, rgb[0], rgb[1], rgb[2], a, shape === 3 ? wing : sig, shape, len, size,
      r[0] / d, r[1] / d, r[2] / d], np * POINT_FLOATS);
    np++;
    if (inStreet) nsp++;
  }

  // (27 Oct, B2's look meter against real night streets (Market St from Twin Peaks the closest): real lamps are a
  // near-white core of 6-7 px in a 25-45 px glow at 4x; ours were 2-3 px, saturated red and dark. So each lamp is a glow
  // ~1.8x the earlier one with a small hot core in it, white for heads, pink for tails)
  // a street vehicle's head and tail lamps as pairs where a real car has them (its front corners ~0.7 m up, its rear
  // corners ~0.85 m up, 0.25 m in from the sides), each end as bright as it faces the window: coming toward us a
  // warm-white pair, going away a red one (brighter braking), side-on both ends faint: a line of tails going away
  // reads as the vivid red ribbon of a real night street (4x, 26 Oct: at 0.45 they were lost beside the street lamps). A lamp is small (a fifth of a
  // metre): its size grows only a little with the magnifier (its glare), the halo pass adds the bloom the panorama's
  // own lights get.
  // (27 Oct round 3, look judge at dusk / night, 4/4 inspectors: the lamps were hard clipped dots, crisper than the
  // windows at the same distance, the far tails as vivid as the near, the heads a cool-white block in the amber street.
  // So the core is wider and lower and warm, and the air between dims a lamp and mutes it toward a warm white, as the
  // bodies are hazed; the glow keeps B2's size)
  // (look15's sheet, 21:2x: the far lamps softened, the near ones (little air) still hard saturated red pairs and the heads
  // cool white; so for every lamp the tails' red a little less pure, their glow and core lower, the heads' glow warm)
  // (the A/B ab26, 23:0x: one inspector found the tails 'pinkish': red muted toward white is pink. So the tails' core is
  // less pink and the air takes them toward a dim red-orange, the heads toward warm white)
  const LAMP_CORE = { head: [1, 0.95, 0.84], tail: [1, 0.55, 0.42] };
  const LAMP_GLOW = { head: [1, 0.88, 0.7], tail: [1, 0.22, 0.14] };
  const LAMP_AIR = { head: [1.0, 0.84, 0.68], tail: [1.0, 0.38, 0.22] };
  const toAir = (rgb, air, t) => rgb.map((x, i) => x + (air[i] - x) * t);
  // (QUEUE 13, occlusion alone, the coordinator 14:2x 28 Oct; round 3 motion: both dusk / night inspectors scored
  // Greenwich 1-3 for 'a frozen, overlapping stack of headlight / tail-light pairs at the top of the street': a queue
  // facing the window lines up along the line of sight, and every car's lamps were drawn through the cars in front of
  // it.) Each street car's body as a box on the screen with its distance, made once a frame in fill(); a lamp inside a
  // nearer car's box is hidden, fading over the box's outer 15 % so its edges don't flicker.
  const occ = [];
  let occN = 0;
  function carBox(v) {
    const heavy = v.kind === "heavy", h = v.heading * DEG, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const hl = (v.len || 4.6) / 2, hw = heavy ? 1.15 : 0.92, ht = heavy ? 2.6 : 1.5, z0 = v.zRoad ?? v.z - 0.9;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [0, 1]) {
      const p = project(v.x + fx * hl * a + rx * hw * b, v.y + fy * hl * a + ry * hw * b, z0 + ht * c);
      if (!p) return null;
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    return { x0, y0, x1, y1, d: distOf(v.x, v.y, z0 + ht / 2), v };
  }
  function lampSeen(x, y, z, self) {
    if (!occN) return 1;
    const p = project(x, y, z);
    if (!p) return 0;
    const d = distOf(x, y, z);
    let seen = 1;
    for (let i = 0; i < occN; i++) {
      const b = occ[i];
      if (b.v === self || b.d >= d - 0.5 || p[0] <= b.x0 || p[0] >= b.x1 || p[1] <= b.y0 || p[1] >= b.y1) continue;
      const u = Math.min(p[0] - b.x0, b.x1 - p[0]) / Math.max(0.15 * (b.x1 - b.x0), 0.5);
      const w = Math.min(p[1] - b.y0, b.y1 - p[1]) / Math.max(0.15 * (b.y1 - b.y0), 0.5);
      seen *= 1 - clamp(Math.min(u, w), 0, 1);
      if (seen < 0.02) return 0;
    }
    return seen;
  }
  function streetLamps(v, k0, heavy, zm) {
    const hz = clamp(v.haze ?? 0, 0, 1), k = k0 * (1 - 0.7 * hz), mute = 0.6 * hz;
    const headGlow = toAir(LAMP_GLOW.head, LAMP_AIR.head, mute), headCore = toAir(LAMP_CORE.head, LAMP_AIR.head, mute);
    const tailGlow = toAir(LAMP_GLOW.tail, LAMP_AIR.tail, mute), tailCore = toAir(LAMP_CORE.tail, LAMP_AIR.tail, mute);
    const h = v.heading * DEG, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const dh = Math.hypot(v.x, v.y) || 1, ex = -v.x / dh, ey = -v.y / dh;
    const face = fx * ex + fy * ey;                              // +1: its front toward the window
    // (a headlight is seen well off its axis: crossing the view side-on, a car still shows its pair at half strength)
    const front = smooth(-0.55, 0.35, face), rear = smooth(-0.25, 0.6, -face);
    const len = v.len || 4.6, half = len / 2 - 0.15, side = (heavy ? 1.1 : 0.78) - 0.25;
    const z0 = v.zRoad ?? v.z - 0.9, sz = zm > 1 ? zm ** 0.4 : 1;
    const tint = 0.85 + 0.15 * (v.tint ?? 1);
    for (const sgn of [-1, 1]) {
      if (front > 0.01) {
        const x = v.x + fx * half + rx * side * sgn, y = v.y + fy * half + ry * side * sgn, z = z0 + (heavy ? 0.9 : 0.7);
        const seen = lampSeen(x, y, z, v);
        if (seen > 0) {
          point(x, y, z, headGlow, k * front * 1.4 * tint * seen, (heavy ? 0.95 : 0.8) * sz, 0);
          point(x, y, z, headCore, k * front * 0.6 * tint * seen, (heavy ? 0.47 : 0.39) * sz, 0);
        }
      }
      if (rear > 0.01) {
        const x = v.x - fx * half + rx * side * sgn, y = v.y - fy * half + ry * side * sgn, z = z0 + (heavy ? 1.0 : 0.85);
        const seen = lampSeen(x, y, z, v);
        if (seen > 0) {
          point(x, y, z, tailGlow, k * rear * (v.brake ? 1.4 : 0.85) * tint * seen, (heavy ? 0.85 : 0.7) * sz, 0);
          point(x, y, z, tailCore, k * rear * (v.brake ? 0.4 : 0.25) * tint * seen, (heavy ? 0.42 : 0.35) * sz, 0);
        }
      }
    }
  }

  function fill(s, env) {
    cam = env.cam;
    np = 0; nh = 0; nw = 0; nc = 0; n3 = 0; nsp = 0; order3.length = 0;
    const M = s.moment, L = s.lighting;
    const night = L.night, lightsOn = L.lights;
    // the ships' floodlights: switched on with the navigation lights, and seen more as the scene darkens
    const floodK = lightsOn * (0.35 + 0.65 * (M ? M.mode.lights : night));
    const css = cam.css;
    const keep = (it) => !cam.phone || deskPx(it) >= PHONE_MIN_PX;
    // v3/zoom: magnified at the window (cam.zoom > 1), things with a size (cars, aircraft) are drawn that much larger
    const zm = cam.zoom > 1 ? cam.zoom : 1;
    // DYS-110: a street car on a phone is kept by its size at this magnification (deskPx x zm), as the desktop's mesh
    // test counts it (cam.pxPerRad is the magnified camera's: deskPx x dpr x zoom, so a dpr-2 desktop's 3 device px is
    // deskPx x zoom >= 1.5). keep() alone left every car past ~4.1 km a speck at any magnification: at 2.5x a phone's
    // window could hold one far 3D car, and none for ~1 s when it drove behind cover (DYS-5). At 1x the same as keep()
    const keepCar = (it) => !cam.phone || deskPx(it) * zm >= PHONE_MIN_PX;
    const air = env.stats?.high || [0.6, 0.7, 0.8];

    // (QUEUE T: the street traffic shows only while judged good, city/tables.js STREET_SHOW: by the sun's height)
    const showW = smooth(STREET_SHOW.sunLo, STREET_SHOW.sunHi, L.sunAlt ?? 90);
    occN = 0;
    if (L.lights > 0.01 && showW > 0.01 && s.cars) for (const v of s.cars) {
      if (v.street == null || v.heading == null || v.kind === "bike" || (v.alpha ?? 1) <= 0.01) continue;
      const b = carBox(v);
      if (b) occ[occN++] = b;
    }
    // ---- bridge and street traffic: specks by day, dark dots against a low sun, head and tail lights at night
    const V = M ? M.vehicles : { speck: 0.35 * L.day, dark: 0, lights: 1 - L.day };
    for (const v of s.cars ? s.vehicles.concat(s.cars) : s.vehicles) {
      inStreet = v.street != null;
      // (a street car fades in with its module, env.streetsW: city.js imports it the first time it is needed; QA
      // __carHide: none at all, the panorama's own street for the screen-space overlap check)
      const a = (v.alpha ?? 1) * (v.street != null ? (globalThis.__carHide ? 0 : (env.streetsW ?? 1) * showW) : 1);
      if (a <= 0.01) continue;
      // a street vehicle with a sprite in the cars atlas: a hull instance (no reflection, no window light), lit for
      // the moment by HULL_FS like the ships; at night its lamps are still the points below, by day no speck
      let sprited = false;
      const meshW = env.meshW ?? 1;
      let meshed = false;
      const mi = v.street != null && carMeshes?.ready && zm > MESH_ZOOM && meshW > 0.01 ? meshNames.indexOf(meshOf(v)) : -1;
      if (mi >= 0 && keepCar(v) && (cam.pxPerRad * (v.len || 4.6)) / (v.view?.dist || distOf(v.x, v.y, v.z)) >= MESH_MIN_PX && project(v.x, v.y, v.z)) {
        // a 3D vehicle: on the road (zRoad), along its heading, pitched to the slope
        const h = v.heading * DEG, pt = (v.pitch || 0) * DEG;
        const fwd = toRoom(Math.sin(h) * Math.cos(pt), Math.cos(h) * Math.cos(pt), Math.sin(pt));
        const right = toRoom(Math.cos(h), -Math.sin(h), 0);
        const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
        const t = F.rel(v.x, v.y, v.zRoad ?? v.z - 0.9), d = Math.hypot(t[0], t[1], t[2]);
        // the view it is seen from: the eye's bearing from its front toward its right, in 45 degree steps
        const ex = -t[0] / d, ey = -t[1] / d, ez = -t[2] / d;
        const ang = Math.atan2(ex * right[0] + ey * right[1] + ez * right[2], ex * fwd[0] + ey * fwd[1] + ez * fwd[2]) / DEG;
        const k = ((Math.round(ang / 45) % 8) + 8) % 8;
        // (its haze: the moment's along the line of sight, and no less than the panorama's own air shows: the bridge's deck,
        // 5.3 km out, keeps env.stats.deck / 0.9 of its contrast (about 0.9 with no air in front); a car at d keeps that
        // to the power d / 5.3 km, so a far car into a low sun is no clearer than the deck)
        const lm = v.look?.moment;
        const keepC = env.stats?.deck != null ? Math.pow(clamp(env.stats.deck / 0.9, 0.02, 1), d / DECK_D) : 1;
        const haze = 1 - (1 - Math.max(lm?.hazeMix ?? 0, v.haze ?? 0)) * keepC;
        // (each paint 45 % toward its own grey: the street tables' blue, red and green read as toys beside the
        // photographed parked cars, mostly white and silver (the coordinator's eye check, 18:5x); the neutrals don't move)
        const paint0 = CAR_PAINT[v.paint ?? 0]?.[1] || [0.5, 0.5, 0.5];
        const pg = 0.2126 * paint0[0] + 0.7152 * paint0[1] + 0.0722 * paint0[2], paint = paint0.map((x) => x + (pg - x) * 0.45);
        const mm = carMeshes.models[meshNames[mi]];
        // (drawn no longer than the sim's vehicle: a mesh longer than its sim length ate into the standstill gap, the
        // Camry 0.2 m, the bus 0.26 m; round 1's "cars touching in the packed mass")
        const kl = Math.min(1, Math.max(0.85, (v.len || mm.length) / mm.length));
        for (let q = 0; q < 3; q++) fwd[q] *= kl;
        if ((n3 + 1) * CAR3D_FLOATS > cars3d.length) { const nn = new Float32Array(cars3d.length * 2); nn.set(cars3d); cars3d = nn; }
        cars3d.set([t[0], t[1], t[2], ...right, ...fwd, ...up, d, a * meshW, haze, L.lights * (0.35 + 0.65 * Math.max(V.lights, L.night)), v.brake ? 1 : 0,
          mi, k, lin(paint[0]), lin(paint[1]), lin(paint[2]), t[0] / d, t[1] / d, t[2] / d, mm.length * kl, mm.beam, mm.height,
          idU(v.id, "coat"), idU(v.id, "roof")], n3 * CAR3D_FLOATS);
        order3.push(n3);
        n3++;
        meshed = true;
        sprited = meshW >= 0.999;   // (fading in: the speck under it fades out)
      }
      if (!sprited && carAtlas && v.street != null && keepCar(v)) {
        const sp = carSprite(v, carAtlas, cam.pxPerRad, CAR_PAINT);
        const p0 = sp && project(v.x, v.y, v.z);
        if (p0) {
          const vv = v.view, lm = v.look?.moment || { sunOnFace: L.day, silhouette: 0, rim: 0, hazeMix: 0 };
          const sunAz = M ? M.sunAz : L.sunAz, sunAlt = M ? M.sunAlt : L.sunAlt;
          const db = (sunAz - vv.bearing) * DEG, ca = Math.cos(Math.max(-5, sunAlt) * DEG);
          const sun = [Math.sin(db) * ca, Math.sin(Math.max(-5, sunAlt) * DEG), -Math.cos(db) * ca, M ? M.mode.lights : 1 - L.day];
          const r = F.rel(v.x, v.y, v.z), d = vv.dist;
          if ((nc + 1) * HULL_FLOATS > cars.length) { const n = new Float32Array(cars.length * 2); n.set(cars); cars = n; }
          cars.set([p0[0], p0[1], sp.scale, d,
            sp.cell0[0], sp.cell0[1], sp.size[0], sp.size[1], sp.cell1[0], sp.cell1[1], sp.size[0], sp.size[1],
            sp.blend, sp.anchor, a, sp.mirror ? 2 : 0,
            lm.sunOnFace ?? 0, lm.silhouette ?? 0, lm.rim ?? 0, lm.hazeMix ?? 0,
            sun[0], sun[1], sun[2], sun[3], r[0] / d, r[1] / d, r[2] / d,
            sp.warp[0], sp.warp[1], 1, 0, sp.livery[0], sp.livery[1], sp.livery[2], 0.5], nc * HULL_FLOATS);
          nc++;
          sprited = true;
        }
      }
      const heavy = v.kind === "heavy", bike = v.kind === "bike";
      // its lamps: on from the city clock's own switch-on (a soft ramp through sunset, L.lights), as bright against the
      // scene as the moment is dark
      // (a street car's lamps fully on from the city's switch-on, sun 2 degrees up to 3 down: drivers have their
      // headlights on at dusk; round 1, B2: no headlights on the oncoming cars at 18:57)
      const lampK = v.street != null ? L.lights * (0.6 + 0.4 * Math.max(V.lights, night)) : V.lights;
      if (lampK > 0.01) {
        const c = v.light === "tail" ? RGB.red : RGB.white;
        // (a bike: one small lamp, front or back, much fainter than a car's pair)
        if (bike) point(v.x, v.y, v.z, c, a * lampK * 0.25, 0.25, 0);
        else if (v.street != null && v.heading != null) streetLamps(v, a * lampK, heavy, zm);
        // (a street car slowing for or waiting at a red: its brake lights, brighter than tail lights)
        else point(v.x, v.y, v.z, c, a * V.lights * (v.light === "tail" ? (v.brake ? 0.85 : 0.55) : 0.8) * (0.7 + 0.3 * (v.tint ?? 1)), heavy ? 0.6 : 0.42, 0);
      }
      const day = V.speck + V.dark;
      if (day > 0.01 && !sprited) {
        // a car 5-6 km out is about one CSS px: a faint speck, never a solid dot (a dark one against a low sun)
        const px = (1335 * zm * (v.len || 4.5)) / Math.hypot(v.x, v.y, v.z);
        const cover = clamp(px / 2, 0.25, 1);
        const g = 0.3 + 0.45 * (v.tint ?? 0.5);
        const dark = V.dark / Math.max(day, 1e-3);
        const col = [g * (1 - dark) + 0.07 * dark, g * (1 - dark) + 0.06 * dark, g * 0.98 * (1 - dark) + 0.06 * dark];
        // the air between: a car 5-6 km out shows only as much as the haze lets through (city.js v.haze); backlit, no
        // plainer than the deck it drives on (the panorama's own deck: env.stats.deck, its silhouette's darkness against
        // what lies just above it; about 0.9 with no air in front)
        const hz = 1 - (v.haze ?? 0);
        const dk = env.stats?.deck != null && v.street == null ? Math.min(hz, clamp(env.stats.deck / 0.9, 0, 1)) : hz;   // (a street car: no deck)
        const k = (V.speck * hz + V.dark * dk) / Math.max(day, 1e-3);
        point(v.x, v.y, v.z, col, a * (meshed ? 1 - meshW : 1) * Math.min(1, day) * cover * (heavy ? 0.8 : bike ? 0.35 : 0.5) * k, (heavy ? 0.5 : bike ? 0.24 : 0.36) * (zm > 1 ? zm ** 0.75 : 1), 2);
      }
    }
    inStreet = false;
    // ---- beacons, lighthouses, harbour lights, cable and deck lights
    for (const l of s.lights) {
      const a = (l.level ?? 1) * (l.intensity ?? 1);
      if (a <= 0.01) continue;
      const big = l.kind === "lighthouse" || l.kind === "beacon";
      point(l.x, l.y, l.z, l.rgb || RGB[l.colour] || RGB.white, a, big ? 0.7 : 0.45, 0);
      if (night > 0.3 && big) point(l.x, l.y, l.z - 2 * (l.z + eyeH), l.rgb || RGB.white, a * 0.18 * night, 0.5, 1, 6);
    }
    for (const l of s.lamps.deck || []) point(l.x, l.y, l.z, RGB.amber, (l.level ?? 1) * 0.45, 0.4, 0);

    // ---- aircraft: a grey dot with a glint by day; navigation lights, strobe and landing lights at night
    for (const p of s.planes) {
      if (!keep(p) && !lightsOn) continue;
      const a = p.alpha ?? 1;
      const hz = p.look?.moment?.hazeMix ?? 0;
      const sizeCss = Math.max(0.6, (1335 * zm * Math.max(p.span || 30, p.len || 30)) / (p.view?.dist || distOf(p.x, p.y, p.z)) * 0.35);
      if (L.day > 0.05) {
        const g = p.glint ? 0.85 : 0.32;
        const c = [g * (1 - hz) + air[0] * hz, g * (1 - hz) + air[1] * hz, g * (1 - hz) + air[2] * hz];
        point(p.x, p.y, p.z, c, a * L.day * (0.85 - 0.5 * hz), Math.max(0.45, sizeCss * 0.5), 2);
      }
      if (lightsOn > 0.02 && p.lights) {
        const hv = F.heading(p.heading || 0);
        const half = (p.span || 30) / 2;
        // wingtips: across the heading, in east / north
        const hx = Math.sin((p.heading || 0) * DEG), hy = Math.cos((p.heading || 0) * DEG);
        const R = [hy * half, -hx * half];
        const k = a * lightsOn;
        if (p.lights.red) point(p.x - R[0], p.y - R[1], p.z, RGB.red, k * 0.8, 0.45, 0);
        if (p.lights.green) point(p.x + R[0], p.y + R[1], p.z, RGB.green, k * 0.8, 0.45, 0);
        if (p.lights.tail) point(p.x, p.y, p.z, RGB.white, k * 0.6, 0.4, 0);
        if (p.lights.beacon) point(p.x, p.y, p.z - 3, RGB.red, k * p.lights.beacon * 0.9, 0.5, 0);
        if (p.lights.strobe) point(p.x, p.y, p.z, RGB.white, k * p.lights.strobe * 1.4, 0.6, 0);
        if (p.lights.landing) point(p.x + hx * (p.len || 30) * 0.4, p.y + hy * (p.len || 30) * 0.4, p.z, [1, 0.97, 0.9], k * p.lights.landing * 2.2, 0.9, 0);
        void hv;
      }
    }

    // ---- gulls: a flapping V, lit by the moment's sun or dark against it
    for (const g of s.gulls) {
      const a = g.alpha ?? 1;
      const d = g.view?.dist || distOf(g.x, g.y, g.z);
      const span = ((g.span || 1.3) * cam.pxPerRad) / d;            // device px
      if (span < 0.8) continue;
      const lm = g.look?.moment || {};
      const lit = 0.75 * (1 - (lm.silhouette ?? 0)) + 0.08;
      const wing = Math.sin((g.wing ?? 0) * 2 * Math.PI);
      point(g.x, g.y, g.z, [lit, lit, lit * 0.97], a * L.day, 0, 3, span / css, wing);
    }

    // ---- vessels: hull sprites, their wakes, and their lights at night
    const vessels = [...s.ships, ...s.tours, ...s.sails, ...s.ferries];
    const wl = [];
    for (const b of vessels) {
      const a = b.alpha ?? 1;
      if (a <= 0.01 || !keep(b)) continue;
      const v = b.view;
      const p0 = project(b.x, b.y, b.z);
      if (!p0) continue;
      let sp = null;
      if (atlas) {
        sp = hullSprite(b, atlas, cam.pxPerRad);
        if (sp) {
          const lm = b.look?.moment || { sunOnFace: L.day, silhouette: 0, rim: 0, hazeMix: 0 };
          const sunAz = M ? M.sunAz : L.sunAz, sunAlt = M ? M.sunAlt : L.sunAlt;
          const db = (sunAz - v.bearing) * DEG, ca = Math.cos(Math.max(-5, sunAlt) * DEG);
          const sun = [Math.sin(db) * ca, Math.sin(Math.max(-5, sunAlt) * DEG), -Math.cos(db) * ca, M ? M.mode.lights : 1 - L.day];
          const r = F.rel(b.x, b.y, b.z), d = v.dist;
          // the ship's paint (its livery faces) and its floodlights' colour temperature (0 sodium .. 1 LED)
          const lv = b.livery || [0.7, 0.7, 0.7];
          for (const refl of [true, false]) {
            if ((nh + 1) * HULL_FLOATS > hulls.length) { const n = new Float32Array(hulls.length * 2); n.set(hulls); hulls = n; }
            hulls.set([p0[0], p0[1], sp.scale, d,
              sp.cell0[0], sp.cell0[1], sp.size[0], sp.size[1], sp.cell1[0], sp.cell1[1], sp.size[0], sp.size[1],
              sp.blend, sp.anchor, a, (refl ? 1 : 0) + (sp.mirror ? 2 : 0),
              lm.sunOnFace ?? 0, lm.silhouette ?? 0, lm.rim ?? 0, lm.hazeMix ?? 0,
              sun[0], sun[1], sun[2], sun[3], r[0] / d, r[1] / d, r[2] / d,
              sp.warp[0], sp.warp[1], sp.t.mirror ? 1 : 0, sp.t.win_gain ?? 1, lv[0], lv[1], lv[2], b.led ?? 0.5], nh * HULL_FLOATS);
            nh++;
          }
        }
      }
      // wakes (in the backdrop's water shader): right / forward of the desk eye. A big ship's scale with its speed and
      // size: the white bow wave (stronger as the square of the speed), the churned track and the Kelvin arms behind it
      // (as long as the water it has crossed in about four and a half minutes), and a soft darkening of the water
      // along its sides (the hull's shade and the calm in its lee)
      if ((b.speed ?? 0) > 0.5 && !b.docked) {
        const r = F.rel(b.x, b.y, b.z), h = F.heading(b.heading);
        const cls = CLASSES[b.kind]?.atlas;
        const big = b.cls === "ship";
        const sv = clamp((b.speed ?? 0) / 6.2, 0, 1.6), size = clamp((b.len || 200) / 250, 0.4, 1.6);
        const wake = big ? clamp(b.speed * 270, 300, 2200) : cls === "sail" ? 70 : 520;
        const foam = big ? 0.6 * Math.pow(sv, 1.3) * Math.pow(size, 0.3) : cls === "sail" ? 0.35 : 1.0;
        const bow = big ? 1.0 * sv * sv * Math.pow(size, 0.2) : foam * 0.5;
        const len = cls === "sail" ? (b.len || 10) : b.len;
        const dim = a * (1 - 0.85 * night);
        wl.push({ P: [r[0], -r[2], h[0], h[1]], Q: [len, b.beam || len * 0.15, wake, foam * dim], R: [bow * dim, big ? 0.22 * a : 0.1 * a, 0, 0], k: foam * len / v.dist });
      }
      // lights: masthead, sides, stern (already filtered by their arcs) and cabin windows
      if (lightsOn > 0.02) {
        const rig = sp?.t?.nav, sc = sp ? sp.lenScale : 1;
        const near = clamp(3000 / v.dist, 0.5, 1.2);
        for (const l of b.lights || []) {
          const c = RGB[l.colour] || RGB.white;
          let { x, y, z } = l, lev = l.level ?? 1;
          const nv = rig && NAV[l.kind];
          if (nv && rig[nv[0]]) {
            // on the model's own rig: [x starboard, y forward, z up] metres at its length, scaled to this ship
            const q = rig[nv[0]], hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
            const along = q[1] * sc, right = q[0] * nv[1] * sc;
            x = b.x + along * hx + right * hy; y = b.y + along * hy - right * hx; z = b.z + q[2] * sc;
            lev *= nv[2];
          }
          const k = lev * lightsOn * a * near;
          point(x, y, z, c, k, 0.5, 0);
          // a small glow round it (the air and the lens), and its column of light broken on the swell below
          if (rig) point(x, y, z, c, k * 0.16, 1.9, 0);
          const hpx = cam.pxPerRad * Math.max(2, z - b.z) / v.dist;
          point(x, y, b.z - (z - b.z) * 0.85, c, k * (rig ? 0.42 : 0.22), 0.5, 1, Math.max(3, (hpx * (rig ? 1.1 : 0.8)) / css));
        }
        // the floodlights' lamps themselves: brightest seen from in front of their beams
        if (rig && sp.t.floods) {
          const fc = (b.led ?? 0.5) > 0.5 ? FLOOD.led : FLOOD.sodium;
          const hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
          const ex = -b.x, ey = -b.y, en = Math.hypot(ex, ey) || 1;
          const mx = sp.mirror ? -1 : 1;     // (a mirrored sprite shows the port side: its lamps where the picture has them)
          for (const f of sp.t.floods) {
            const along = f[1] * sc, right = f[0] * sc * mx;
            const x = b.x + along * hx + right * hy, y = b.y + along * hy - right * hx, z = b.z + f[2] * sc;
            // the beam's direction in east / north / up, against the direction to the eye
            const dx = f[4] * hx + f[3] * mx * hy, dy = f[4] * hy - f[3] * mx * hx, dz = f[5], dn = Math.hypot(dx, dy, dz) || 1;
            const facing = (dx * ex + dy * ey) / (dn * en);
            const k = floodK * a * near * (0.28 + 0.5 * smooth(-0.2, 0.6, facing));
            point(x, y, z, fc, k, 0.45, 0);
          }
        }
        const cab = rig ? null : b.cabin;     // (a ship model's own lit windows carry its cabins)
        if (cab && (cab.level ?? 1) > 0) {
          const hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
          const n = Math.max(3, Math.min(9, Math.round(((b.len * cam.pxPerRad) / v.dist) / 3)));
          for (let row = 0; row < (cab.rows || 1); row++) {
            const hgt = (b.height || 10) * (cab.h0 + (cab.h1 - cab.h0) * (row + 0.5) / (cab.rows || 1));
            for (let i = 0; i < n; i++) {
              const f = cab.from + (cab.to - cab.from) * (i + 0.5) / n;
              const flick = 0.75 + 0.25 * (((cab.seed || 1) * 7919 + i * 104729 + row * 31) % 97) / 97;
              point(b.x + hx * f * b.len, b.y + hy * f * b.len, b.z + hgt, RGB.warm, 0.35 * (cab.level ?? 1) * lightsOn * a * flick, 0.42, 0);
            }
          }
        }
      }
    }
    wl.sort((p, q) => q.k - p.k).slice(0, MAX_WAKES).forEach((w, i) => { wakeP.set(w.P, i * 4); wakeQ.set(w.Q, i * 4); wakeR.set(w.R, i * 4); nw = i + 1; });
    // the 3D vehicles far to near (each covers what lies behind it)
    order3.sort((p, q) => cars3d[q * CAR3D_FLOATS + 12] - cars3d[p * CAR3D_FLOATS + 12]);
    return { points: np, hulls: nh, wakes: nw, cars: nc, cars3d: n3, streetPts: nsp };
  }

  return {
    fill,
    get points() { return pts.subarray(0, np * POINT_FLOATS); },
    get hulls() { return hulls.subarray(0, nh * HULL_FLOATS); },
    get cars() { return cars.subarray(0, nc * HULL_FLOATS); },
    get counts() { return { points: np, hulls: nh, wakes: nw, cars: nc, cars3d: n3, streetPts: nsp }; },
    /** the 3D meshes' index (cars-lod.json), once the outside has fetched it (lazily) */
    setCarMeshes(m) { carMeshes = m; meshNames = m ? Object.keys(m.models) : []; },
    /** the 3D vehicles (CAR3D_FLOATS each) and their drawing order, far to near */
    get cars3d() { return cars3d; },
    get order3() { return order3; },
    wakeP, wakeQ, wakeR,
    frame: F,
    spinnakers: SPINNAKERS, trims: TRIMS,
  };
}

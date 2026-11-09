// The city's events, drawn outside the window (stream X1): X2's city clock (web/shared/city) gives every event as a
// pure function of time, in metres around the desk eye; this file projects them through whatever camera is live and
// fills the three renderers' buffers (plan v1 2.3):
//   points     traffic, beacons and lighthouses, bridge lamps, aircraft and vessel lights, cabin windows
//   sky dots   aircraft by day, gulls (a flapping V)
//   hulls      ships, tour boats, sailboats and ferries from the motion track's lit 24-heading atlas, with wakes
// Sprites take the rendered moment's light (state.moment, each item's look.moment), fade toward the panorama behind
// them by their haze, and are hidden by the panorama's sharp depth and by the room (outside.glsl.js).
import { CLASSES, hullSprite, carSprite, deskPx, PHONE_MIN_PX, SPINNAKERS, TRIMS } from "./city/sprites.js";
import { detailWeight, DETAIL_FADE } from "./city/ship-detail.js";
import { CAR_PAINT, STREET_SHOW, STREET_SIGNALS } from "./city/tables.js";
import { u01, SEED } from "./city/hash.js";
import { PIVOT } from "./city/events/ferries.js";
import { SHIP_WAKE, shipWake } from "./city/events/ships.js";
// (DYS-232, D: Akshay's How it's made part 10 frame, a dark flat ship) a big ship's haze fitted to the panorama: lighting.js
// hazes a sprite by build.py's atmosphere, never fitted to the renders (its own note); at 16:20 that gives a container
// ship 5.7 km off 28 %, where the panorama's south tower beside it is about half way to the air. A big ship's optical
// depth x SHIP_HAZE_K (mix 1 - (1 - mix)^K); the boats' haze as before. ?shiphaze=0 as before; ?shiphazek=<k> to compare
const SHIP_HAZE_K = (() => {
  const q = typeof location === "undefined" ? null : new URLSearchParams(location.search || "");
  if (q?.get("shiphaze") === "0") return 1;
  const k = +(q?.get("shiphazek") || 0);
  return k > 0 ? k : 2.2;
})();

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- DYS-204: the traffic signals at night
// The real signal heads the window sees (web/shared/city/signals.json, scripts/city_clock/street_signals.py), each lit
// in the colour the street simulation's own signal shows at T (streets.js light(): the very phase its cars stop and go
// by), drawn as a lit lens (a core and a glow, as the headlights), as bright as its beam reaches the eye, faded in with
// the night-light moments only.
// The look is the calibration of real SF signals at night from a hill (stage-qa-d/dys204/calib: calib.json, NOTES.md;
// 25 heads measured in the footage the DYS-134 lamps were tuned on, Twin Peaks over Market St, at the page's 4x scale
// of 124.4 CSS px a degree): their size and light against the street lamps in the same frames, their colour as a night
// camera records it, how their light falls off above and beside the beam, 2-3 heads an approach.
// QA (side by side): ?siglook=a (the calibration) | b (a little brighter) | c (a little smaller); over it ?sigk=
// (brightness x), ?sigsize= (size x), ?sigpoles=0 (the mast arm's head alone), ?sigalong= (m), ?sigh= (m); and
// events.setSignalLook(search) at run time. ?signals=0: none (outside.js).
export const SIGNAL_LOOK = {
  // ---- where: past the junction's farthest signal node along the approach (the far side: US practice), over the
  // approach lanes' middle, the mast arm's head h up; with poles, a head on each far corner's pole too (poleH up,
  // poleOut m past the lanes' edge; a two-way street's left one across the other half of the road): all in one state
  along: 11, lat: 0, h: 5.5, poles: 1, poleH: 3.6, poleOut: 2.5,
  lens: 0.3,         // m: a 12-inch LED lens (no head drawn smaller than its own angle)
  // ---- size, CSS px at 4x: the site's own street-lamp orb at the head's distance (the shipped look B, DYS-134 r6
  // measures.json at effMag 4: half-max / glow 4.1 / 10.0 at Greenwich ~0.6 km, 2.3 / 5.7 at Lombard ~1.6 km; between,
  // by log distance; held past the ends) x per state (green, amber, red: the calibration's vs_lamps_same_frames);
  // scaled with the magnification; at least halfMin / glowMin CSS px at any zoom (the calibration's min_size)
  lampAt: [[600, 4.1, 10.0], [1600, 2.3, 5.7]], lampPeak: 0.78,   // (look B's peak over its ground, luma 0..1)
  half: [1.34, 1.2, 0.85], glow: [1.3, 1.2, 0.74],
  halfMin: 1.5, glowMin: 3.0,
  // ---- light against the lamps (linear summed light, the calibration: green 1.68, amber 0.69, red 0.32 (0.3-0.5)):
  // at the footage's reference (seen refUp deg above, on the axis) a head's peak is light x lampPeak / half^2
  light: [1.7, 0.7, 0.4],
  // ---- colour, as a night camera records it (sRGB, the calibration's colour_srgb): glow, the rim's hue (glow ring
  // over the ground); core, below coreWhite[0] CSS px half-max that hue at rimSat or more saturation (never white: a pale
  // 1-2 px point is the 'white dots' look), whitening to the core's own hue (core_mean over the ground) by coreWhite[1]
  rim: [[0.106, 0.937, 1.0], [1.0, 0.616, 0.27], [1.0, 0.314, 0.38]],
  hot: [[0.46, 1.0, 0.97], [1.0, 0.79, 0.48], [1.0, 0.48, 0.5]],
  rimSat: 0.85, coreWhite: [2.5, 3.0],
  air: [[0.62, 0.92, 0.82], [1.0, 0.8, 0.6], [1.0, 0.42, 0.3]],   // what the haze mutes each toward (as LAMP_AIR)
  // ---- the beam toward the eye (static per head: the eye never moves far): above it, max(e^(-up / upTau),
  // upFloor) x the visor; beside it, TC E-14's 300 mm LED table (0 side-on and behind); relative to the footage's
  // reference refUp deg above (the ratios above were measured there), at most dirMax. Heads seen nearly level show;
  // near heads seen steeply from above stay faint (real: not boosted)
  upTau: 3, upFloor: 0.025, refUp: 3.1, dirMax: 2,
  visor: [[0, 1], [5, 0.97], [10, 0.915], [15, 0.845], [20, 0.761], [25, 0.665], [30, 0.555], [90, 0.3]],
  offAxis: [[0, 1], [5, 0.9375], [10, 0.625], [15, 0.375], [20, 0.1875], [25, 0.1], [30, 0.0375], [45, 0.01], [60, 0.003], [90, 0]],
  k: 1, size: 1,     // QA multipliers (?sigk, ?sigsize)
  lampExtrap: 0,     // 1: the lamps' orb keeps shrinking past lampAt's far end (by its log slope), not held (preset d, e)
  vary: 0,           // per-head spread (preset d): light x (1 - vary .. 1), size x (1 +- 0.18 vary), fixed per head
};
const SIGNAL_PRESETS = {
  a: {},
  b: { k: 1.5 },     // a little brighter
  c: { size: 0.8 },  // a little smaller
  // d (1 Nov 00:0x, D, the first blind round on Deploy 12b: the inspectors named a/b/c's heads 'identical saturated
  // cyan discs, much bigger than the tail lights near them, even round halos' and the reds 'pink dots'): the footage's
  // sizes carry its video blur, so in the page's crisp picture: cores x0.8, glows ~0.55 (close to the core, as the
  // page's tails), the light x0.75 (the smaller core's peak no higher), the red toward the tails' red (LAMP_GLOW.tail),
  // the core less saturated (rimSat 0.7), and every head a little different (vary 0.35)
  d: { half: [1.07, 0.96, 0.68], glow: [0.72, 0.66, 0.41], light: [1.3, 0.55, 0.3], rimSat: 0.7, vary: 0.35,
       rim: [[0.106, 0.937, 1.0], [1.0, 0.616, 0.27], [1.0, 0.2, 0.16]], hot: [[0.46, 1.0, 0.97], [1.0, 0.79, 0.48], [1.0, 0.45, 0.36]],
       lampExtrap: 1 },   // (and 'the same size near and far': past 1.6 km the size keeps falling as the lamps' does)
};
SIGNAL_PRESETS.e = { ...SIGNAL_PRESETS.d, k: 0.6, size: 0.85 };   // e: d, quieter (light x0.6, size x0.85)
// the look the page shows without ?siglook= (Akshay's pick, 1 Nov ~11:1x MST: d, after asking why signals would be
// fainter than tail lamps: d matches the tail lamps the way a real hill photo does; blind round 2: Lombard 2.67 vs 3.0 off)
export const SIGNAL_DEFAULT = "d";
const lumaOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const tableAt = (T, x) => {
  if (x <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) if (x <= T[i][0]) { const [a, fa] = T[i - 1], [b, fb] = T[i]; return fa + ((fb - fa) * (x - a)) / (b - a); }
  return T[T.length - 1][1];
};
// the look with the page's QA overrides (search: a location.search string), and what follows from it
export function signalLook(search = typeof location === "undefined" ? "" : location.search || "") {
  const q = new URLSearchParams(search), num = (k) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : null);
  const L = { ...SIGNAL_LOOK, ...(SIGNAL_PRESETS[q.get("siglook") || SIGNAL_DEFAULT] || {}) };
  const k = num("sigk"), sz = num("sigsize"), po = num("sigpoles"), al = num("sigalong"), h = num("sigh");
  if (k !== null) L.k *= k;
  if (sz !== null) L.size *= sz;
  if (po !== null) L.poles = po;
  if (al !== null) L.along = al;
  if (h !== null) L.h = h;
  // (the core's coloured hue: the rim's at rimSat saturation or more)
  L.rimCore = L.rim.map((c) => { const mx = Math.max(...c), mn = Math.min(...c), sat = 1 - mn / mx, f = sat >= L.rimSat ? 1 : L.rimSat / sat; return c.map((x) => mx - (mx - x) * f); });
  // (each state's peak luma at the reference, and the beam there)
  L.peak = L.light.map((x, i) => (x * L.lampPeak) / (L.half[i] * L.half[i]));
  L.fRef = Math.max(Math.exp(-L.refUp / L.upTau), L.upFloor) * tableAt(L.visor, L.refUp);
  return L;
}
/**
 * signalHeads(data, streets, frame, opts): the heads to draw, from signals.json and the street simulation (city.js
 * city.streets: createStreets()). Each approach's signal is the simulation's own array [stop line, green from, green
 * length] (streets-lib.js buildStreets): one on a simulated approach takes that street's very array; one on an approach
 * it doesn't drive the same street's (same 1) or the rest of its cycle (0); a junction it doesn't drive, its own rule
 * for a node (streets-lib.js: a hash of the node, the main road first). Its 1-3 heads (the mast arm's, the corner
 * poles') share it. Where each hangs, its beam toward the eye (at the city's origin) and the street lamps' orb at its
 * distance are worked out here, once.
 * opts: { look (signalLook()), lift (routes.json streets.lift_m: a lane's path is this over its road) }
 */
export function signalHeads(data, streets, frame, { look = signalLook(), lift = 0.9 } = {}) {
  const SG = STREET_SIGNALS, C = SG.cycle, LW = 3.3, byId = new Map();
  for (const S of streets.streets) if (!S.bike && !byId.has(S.r.id)) byId.set(S.r.id, S);
  const sigOf = (id, g) => byId.get(id)?.sig.find((G) => G[0] === g && G[2] > 0) || null;
  const [[d0, h0, g0], [d1, h1, g1]] = look.lampAt;
  const out = [];
  for (const d of data.heads || []) {
    let x, y, hr, hdg, G, grade = 0, w, ow;
    if (d.s != null) {
      const S = byId.get(d.s);
      G = sigOf(d.s, d.g);
      if (!S || !G) continue;
      // (over the simulated lanes, where its cars stop: the street's lane centres' middle at its stop line)
      const q = S.line.at(d.g, 8), mid = S.lat.reduce((a, b) => a + b, 0) / S.lat.length;
      hdg = q.heading;
      x = q.x + mid * Math.cos(hdg * DEG); y = q.y - mid * Math.sin(hdg * DEG);
      hr = q.h - lift;
      w = S.lat.length; ow = !!S.r.oneway;
      const s1 = d.g + d.jd + look.along;
      if (s1 >= 0 && s1 <= S.L) grade = (S.line.at(s1).h - q.h) / (d.jd + look.along || 1);
    } else {
      [x, y, hr, hdg, grade] = d.p;
      w = d.w ?? 1; ow = !!d.o;
      if (d.r) {
        const R = sigOf(d.r[0], d.r[1]);
        if (!R) continue;
        G = d.r[2] ? R : [R[0], R[1] + R[2], C - R[2]];
      } else {
        const phi = u01(SEED.street, d.n % 2147483647, 0, 9) * C;
        G = [0, d.m ? phi : phi + SG.main * C, (d.m ? SG.main : 1 - SG.main) * C];
      }
    }
    const fx = Math.sin(hdg * DEG), fy = Math.cos(hdg * DEG), rx = fy, ry = -fx, a = d.jd + look.along, half = (w * LW) / 2;
    // the mast arm's head over the lanes; the far corners' poles past the lanes' edges (a two-way street's left one
    // across the other half of the road)
    const spots = [[look.lat, look.h]];
    if (look.poles) spots.push([half + look.poleOut, look.poleH], [-(half + (ow ? 0 : 2 * half) + look.poleOut), look.poleH]);
    const key = (d.n != null ? d.n : Math.round((+d.s || 0) + (d.g || 0) * 10)) % 2147483647;
    for (const [si, [lat, up]] of spots.entries()) {
      const hx = x + fx * a + rx * lat, hy = y + fy * a + ry * lat;
      const h = hr + grade * a + up, z = frame.z(hx, hy, h), gd = Math.hypot(hx, hy), dist = Math.hypot(gd, z);
      // its beam toward the eye: beside it, the angle across the ground between its facing (back along the approach)
      // and the eye; above it, the eye's height over its level
      const ch = Math.max(-1, Math.min(1, (fx * hx + fy * hy) / (gd || 1))), off = Math.acos(ch) / DEG, upDeg = Math.atan2(-z, gd) / DEG;
      const fUp = Math.max(Math.exp(-Math.max(0, upDeg) / look.upTau), look.upFloor) * tableAt(look.visor, Math.abs(upDeg));
      const dir = Math.min(look.dirMax, (tableAt(look.offAxis, off) * fUp) / look.fRef);
      if (dir * look.k < 0.003) continue;
      // the street lamps' orb at its distance (CSS px at 4x)
      const tl = Math.log(dist / d0) / Math.log(d1 / d0), t = Math.max(0, look.lampExtrap ? tl : Math.min(1, tl));
      out.push({ x: hx, y: hy, z, h, dist, dir, off, up: upDeg, lampHalf: h0 + (h1 - h0) * t, lampGlow: g0 + (g1 - g0) * t, G, src: d,
        vk: 1 - look.vary * u01(SEED.street, key, si, 7), vs: 1 + look.vary * 0.36 * (u01(SEED.street, key, si, 8) - 0.5) });
    }
  }
  return out;
}
// (DYS-149 gc-diet: a frame's points, the street cars' boxes and lamps and the 3D cars' records written straight into
// their buffers, through a few arrays kept for it, not a new array or object each (project, point, carBox, lampSeen,
// streetLamps, fill): ~0.3-0.6 MB of garbage a frame. The same numbers. ?gcdiet=0 on the page: as before)
const GC_DIET = typeof location === "undefined" || new URLSearchParams(location.search || "").get("gcdiet") !== "0";
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// (DYS-232 WATER) ?boatsfx=0: the boats' wakes and lights filled as on main (gl/outside.glsl.js BOATS_FX: the shaders too)
const BOATS_FX = typeof location === "undefined" || new URLSearchParams(location.search || "").get("boatsfx") !== "0";
// (DYS-240 traffic-real lights) ?trafficreal=0: the cars' lamps as before (streetLamps, fill: far lamps' size, heads'
// LED share, the bridge's lamps at 1x and their switch-on); as city/events/bridge.js TRAFFIC_REAL
const TRAFFIC_REAL = typeof location === "undefined" || new URLSearchParams(location.search || "").get("trafficreal") !== "0";
export const POINT_FLOATS = 15;    // pos4 colour4 shape4 dir3
export const HULL_FLOATS = 39;      // pos4 cell0 4 cell1 4 more4 look4 sun4 dir3 warp4 livery4 motion4
// (DYS-232 MOTION) motion4, HULL_VS aMotion: the two cells' roll on the screen, the tilt's vertical scale - 1, heave
// (sprites.js hullSprite motion); 0 0 0 0 for the ships and the street cars (their pixels as before). more4's flags:
// 1 reflection, 2 mirrored, 4 cell1 the other side's picture (a sail's tack), 8 cut at the waterline
export const MAX_WAKES = 16;
const ZERO4 = [0, 0, 0, 0];
const NO_MOTION = [0, 0, 0, 0];
// v3/street-traffic rebuild: a street vehicle drawn as a 3D mesh (outside.js drawCars3d): its place on the road (room
// frame, m from the panorama's eye), its axes (right, forward, up; room frame), distance, opacity, haze, lamps on,
// brake lamps, model number, view (0..7), paint (linear rgb), the eye's direction to it, length, beam, height
// a 3D car's floats in cars3d (fill(), below): 0-2 position, 3-5 right, 6-8 forward, 9-11 up, 12 distance, 13 alpha x mesh
// weight, 14 haze, 15 lights, 16 brake, 17 mesh, 18 detail level, 19-21 linear paint, 22-24 direction from the eye,
// 25 length, 26 beam, 27 height; 28-29 two fixed numbers of the vehicle's own, 0..1 (DYS-157 round 2: its clearcoat
// and its roof's shape, outside.js drawCarGroup)
export const CAR3D_FLOATS = 30;
// (DYS-240 traffic-real) the Golden Gate Bridge's east railing, between the window and the deck's lanes: its top over the
// road (m: the open steel rail ~1.1 m on a ~0.2 m kerb, est.) and how much of what is behind it shows through its posts
// (est.). A bridge vehicle's record carries the height it hides, minus, in the brake slot (a bridge car never brakes):
// CAR3D_FS takes the deck's whole air for it and draws below that height that much of it; its road shadows not at all
// (G, DYS-240 round 3: see 0.45 -> 0.7: the deck's outer railing is open steel balusters and the sidewalk's barrier
// two rails on posts (traffic-real refs bridge-03), most of what is behind both shows; at 0.45 a white car below the
// railing's top read darker than the photograph's pale blips (refs bridge-02). Its lamps take the same; CAR3D_FS's
// bridge edits read it too (gl/outside.glsl.js BRIDGE_SEE, kept equal))
export const BRIDGE_RAIL = { h: 1.3, see: 0.7 };
// (G, DYS-240 bridge cars round 5) a bridge vehicle by day: its air's floor, how far that air's colour goes from the
// picture behind toward the horizon's haze (1: round 4c's), its glass's sky mirror (0.6: round 3's); round 6 (the
// coordinator's 04:3x, Akshay's spec against refs bridge-02: pale cars small bright specks, dark ones vanishing, ~1/5 of
// the truss): a pale paint's (white, silver, light grey) flat speck, this far from the picture behind toward the
// horizon's haze; a dark paint's this far into the picture behind; and its drawn height, x (0: none, QA's no-car
// baseline). ?bridgecar=0: as before (the vehicles' shader without BRIDGECAR, full height); ?bridgecar=<the six> (QA)
// (06:3x, the coordinator's pick of the closer to bridge-02 at the same truss height: pale 0.85, height 0.5 over
// round 6's 0.6 / 0.65 and 'paler' 0.85 / 0.65. At 12:30 4x its bright specks p90 0.35 of the truss ('paler' 0.41),
// peak p50 +24 p90 +47 levels over the deck ('paler' +27 / +54; bridge-02 +14 / +19, max +54); 15:30 p90 +18 (+19))
export const BRIDGE_CAR = [0, 0.4, 0.25, 0.85, 0.85, 0.5];
export const BRIDGE_CAR_Q = (() => {
  const v = typeof location === "undefined" ? null : new URLSearchParams(location.search || "").get("bridgecar");
  if (v === "0") return null;
  const n = (v || "").split(",").map(Number);
  return n.length === 6 && n.every(Number.isFinite) ? n.map((x) => Math.max(0, Math.min(1, x))) : BRIDGE_CAR;
})();
// (G, DYS-240 bridge lamps, Akshay 6 Nov 16:1x on release 25's car lights: 'revert this, I can't see the cars now. I
// didn't want the lights shown at day; the lights can be shown and should be shown at night.' The city clock's lamps are
// on in fog at any sun height (city.js lighting: lights), so at golden hour in the pink fog release 24's deck showed a
// row of white headlight beads. So a bridge vehicle's lamps and their light on its body (CAR3D_FS uCar.w) x (1 - brDay):
// with the sun down release 24's to the bit, none from BRIDGE_LAMP_UP deg up; by day its body is the speck
// CAR3D_BRIDGE_EDITS draws from the same height (gl/outside.glsl.js BRIDGE_DAY_GL). ?bridgelamp=0: release 24's)
export const BRIDGE_LAMP_UP = 0.5;
export const BRIDGE_LAMP_Q = TRAFFIC_REAL && (typeof location === "undefined" || new URLSearchParams(location.search || "").get("bridgelamp") !== "0");
// (only with CAR3D_FS's bridge edits: ?trafficreal on and ?boatsfx on, gl/outside.glsl.js TRAFFIC_REAL_GL)
const BRIDGE_GL = (typeof location === "undefined" || new URLSearchParams(location.search || "").get("boatsfx") !== "0")
  && (typeof location === "undefined" || new URLSearchParams(location.search || "").get("trafficreal") !== "0");
// (DYS-240 cars, E's helper: the speck's paint takes TRAFFIC_REAL above, as bridge.js's; ?trafficreal=0: every speck the grey of before)
// (G, DYS-240 round 3: a van or a box truck mostly fleet white: 65 % of them by their own fixed number, the rest the
// cars' table (E's helper: real ones in SF are well over half white; ours were blue and red Transits, a khaki truck))
const paintOf = (v) => (TRAFFIC_REAL && (v.type === "van" || v.type === "boxtruck") && idUq(v.id, "fleet") < 0.65 ? 0 : v.paint ?? 0);
// (a vehicle's own fixed number 0..1 from its id and a salt: FNV-1a, the same every frame and on every visit, so what
// varies per car never flickers or swaps between cars)
const idU = (id, salt) => {
  const s = `${salt}:${id ?? ""}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
// (traffic-real lights: idU's very number with no new string (the salt's characters, ':', the id's in turn): streetLamps
// asks it of every lit car every frame)
const idUq = (id, salt) => {
  const s = typeof id === "string" ? id : String(id ?? "");
  let h = 2166136261;
  for (let i = 0; i < salt.length; i++) { h ^= salt.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= 58; h = Math.imul(h, 16777619);
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
    // (DYS-149 gc-diet: rel and world into o)
    relTo(o, x, y, z) { x += sx; y += sy; o[0] = x * c - y * s; o[1] = z; o[2] = -(x * s + y * c); return o; },
    worldTo(o, x, y, z) { this.relTo(o, x, y, z); o[0] = eye[0] + o[0]; o[1] = eye[1] + o[1]; o[2] = eye[2] + o[2]; return o; },
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
  // (DYS-232) the big ships' sharp pictures (city/ship-detail.js, setShipDetail): their instances, drawn from the pool
  // before the 1x atlas's (outside.js drawSprites), each ship's share of them eased per ship (DETAIL_FADE)
  let detail = null, hullsHi = new Float32Array(HULL_FLOATS * 16), nhh = 0, hiAt = null, hiDt = 0, hiNo = 0;
  const hiShare = new Map();   // ship id -> { k, seen }
  let hiSp = null, hiC0 = null, hiC1 = null;
  // a big ship's sharp pictures this frame: its share of them (0..1), and when > 0 hiSp (its sprite from the sharp set)
  // and hiC0, hiC1 (the pool's slots of its two cells). Only once every cell it shows is in does the share grow; a cell
  // let go or not yet in (a turn faster than the pool), it eases back to the 1x pictures, its one cell in standing for both
  function sharpShare(b, sp) {
    const want = detailWeight(sp.scale * (cam.phone ? 2 : 1));
    let st = hiShare.get(b.id);
    if (!st) { if (!(want > 0)) return 0; st = { k: 0, seen: 0 }; hiShare.set(b.id, st); }
    st.seen = hiNo;
    hiSp = want > 0 || st.k > 0 ? hullSprite(b, detail.meta, cam.pxPerRad) : null;
    hiC0 = hiC1 = null;
    let ready = false;
    if (hiSp) {
      const bl = hiSp.blend, i0 = hiSp.ix[0], i1 = hiSp.ix[1];
      if (bl < 0.999) hiC0 = detail.cell(hiSp.type, i0);
      if (bl > 0.001 && i1 !== i0) hiC1 = detail.cell(hiSp.type, i1);
      else if (bl > 0.001) hiC1 = hiC0 || detail.cell(hiSp.type, i1);
      ready = (bl >= 0.999 || !!hiC0) && (bl <= 0.001 || !!hiC1);
      // the next heading it may turn to, asked for ahead (one picture held: the other side of its step)
      if (bl <= 0.001 && i1 !== i0) detail.cell(hiSp.type, i1, true);
      else if (bl >= 0.999) detail.cell(hiSp.type, i0, true);
      if (!hiC0) hiC0 = hiC1;
      if (!hiC1) hiC1 = hiC0;
    }
    const target = ready ? want : 0, dk = hiDt / DETAIL_FADE;
    st.k = target > st.k ? Math.min(target, st.k + dk) : Math.max(target, st.k - dk);
    if (!hiC0) st.k = 0;
    return st.k;
  }
  // (DYS-232) a big ship's reflection glued to its hull as it heaves and pitches: the reflection program mirrors the
  // moved hull about the still waterline (HULL_VS: off.y = -pu.y x uReflStretch), which would open a gap under a rising
  // bow; the reflection's instance instead takes the motion that lands its waterline on the hull's (roll asin(sin r / k),
  // heave -h / k, k the stretch outside.js gives uReflStretch: 0.7 + 0.9 x the lights-only weight)
  const glued = [0, 0, 0, 0];
  function glue(mo, k) {
    glued[0] = -Math.asin(Math.max(-1, Math.min(1, Math.sin(mo[0]) / k)));
    glued[1] = -Math.asin(Math.max(-1, Math.min(1, Math.sin(mo[1]) / k)));
    glued[2] = mo[2]; glued[3] = -mo[3] / k;
    return glued;
  }
  let cars = new Float32Array(HULL_FLOATS * 256);
  let nc = 0;
  const wakeP = new Float32Array(MAX_WAKES * 4), wakeQ = new Float32Array(MAX_WAKES * 4), wakeR = new Float32Array(MAX_WAKES * 4);
  // (DYS-232 WATER) a boat's wake also takes the path it came by and its odometer (water() boatWake: uBoatS, uBoatT)
  const wakeS = new Float32Array(MAX_WAKES * 4), wakeT = new Float32Array(MAX_WAKES * 4);
  let np = 0, nh = 0, nw = 0, nsp = 0, inStreet = false;   // (nsp: the street vehicles' points, for the blink log)

  // ---- (DYS-232 WATER, D's review) the boats' wakes follow their own past path
  // Where each boat's centre was: a vessel event's own `trail` ([[x, y, age s], ...] newest first, ENU m: MOTION's,
  // from the clock, right on a page's first frame) when it has one; else kept here, a point every quarter length of
  // travel (PAST_N of them, per boat id), started again after a jump of the clock (the dial, a hidden tab), straight
  // back along the heading beyond what is kept. Its odometer (m) carries the foam's grain, fixed in the water.
  const PAST_N = 64, TRAIL_D = [1.5, 4, 12];   // the three points' distances back from the centre (boat lengths)
  const past = new Map();
  let fillNo = 0;
  function pastOf(b, len, T) {
    let q = past.get(b.id);
    if (!q) { q = { x: new Float64Array(PAST_N), y: new Float64Array(PAST_N), n: 0, i: 0, odo: 0, lx: b.x, ly: b.y, T, seen: 0 }; past.set(b.id, q); }
    const m = Math.hypot(b.x - q.lx, b.y - q.ly), dT = T - q.T;
    if (dT < 0 || dT > 5 || m > (b.speed || 0) * 3 * dT + 8) q.n = 0;
    else q.odo += m;
    q.lx = b.x; q.ly = b.y; q.T = T; q.seen = fillNo;
    const k = (q.i + PAST_N - 1) % PAST_N;
    if (!q.n || Math.hypot(b.x - q.x[k], b.y - q.y[k]) >= Math.max(2, len / 4)) {
      q.x[q.i] = b.x; q.y[q.i] = b.y; q.i = (q.i + 1) % PAST_N; q.n = Math.min(PAST_N, q.n + 1);
    }
    return q;
  }
  // the point `dist` m back along the kept path from the boat's centre (ENU) into out[o], out[o + 1]
  function backAlong(q, b, dist, out, o) {
    let px = b.x, py = b.y, left = dist;
    for (let j = 0; j < q.n; j++) {
      const k = (q.i - 1 - j + 2 * PAST_N) % PAST_N, s = Math.hypot(q.x[k] - px, q.y[k] - py);
      if (s >= left && s > 1e-6) { out[o] = px + ((q.x[k] - px) * left) / s; out[o + 1] = py + ((q.y[k] - py) * left) / s; return; }
      left -= s; px = q.x[k]; py = q.y[k];
    }
    // past the oldest point: on along the kept path's last direction, else straight back from the heading
    let ux = -Math.sin(b.heading * DEG), uy = -Math.cos(b.heading * DEG);
    if (q.n >= 2) {
      const a = (q.i - q.n + 2 * PAST_N) % PAST_N, c = (a + 1) % PAST_N, dx = q.x[a] - q.x[c], dy = q.y[a] - q.y[c], dn = Math.hypot(dx, dy);
      if (dn > 1e-6) { ux = dx / dn; uy = dy / dn; }
    }
    out[o] = px + ux * left; out[o + 1] = py + uy * left;
  }
  const trailEnu = new Float64Array(6);
  // (DYS-232 WATER) a boat's light from its clock (ferries.js, tours.js: colour and place, no kind), named for the
  // model's rig (boats.json nav: MODELS'): the green and red side lights, a white one forward the masthead, aft the stern
  function navKind(b, l) {
    if (l.colour === "green" || l.colour === "red") return l.colour;
    if (l.colour !== "white") return undefined;
    return (l.x - b.x) * Math.sin(b.heading * DEG) + (l.y - b.y) * Math.cos(b.heading * DEG) > 0 ? "mast1" : "stern";
  }
  // a boat's wake, in the water shader's terms (outside.glsl.js boatWake): P centre and heading (right, forward of the
  // desk eye), Q length, beam, the wake's length, its fade; R the bow's white water, the contact shade, its height (its
  // shadow), its speed (> 0: this path); S, T where its centre was, a catamaran's half hull spacing, its odometer
  // the propellers' wash (water() boatWake: + thrust ahead from rest, - astern): a vessel event's own `wash`, else the
  // Golden Gate Ferry's at its berth from its clock (ferries.js: backing off for PIVOT[0] s, pivoting to PIVOT[1] s, then
  // ahead from rest; stopped by its props astern over its last ~35 s, the water still boiling ~25 s after)
  function washOf(b, T) {
    if (b.wash !== undefined) return b.wash;
    if (b.kind !== "ferry") return 0;
    if (b.docked) return b.since != null && T - b.since < 25 ? -0.6 * (1 - (T - b.since) / 25) : 0;
    const tau = T - (b.tDep ?? -1e9), toArr = (b.tArr ?? 1e9) - T;
    if (tau < PIVOT[0]) return -0.9;
    if (tau < PIVOT[1] + 30) return 0.9 * (1 - smooth(PIVOT[1] - 15, PIVOT[1] + 30, tau));
    if (toArr < 35) return -0.8 * smooth(35, 8, toArr);
    return 0;
  }
  function boatWake(b, r, h, a, sp, night, T) {
    const sail = CLASSES[b.kind]?.atlas === "sail";
    const len = sail ? (b.len || 10) : (b.len || 30), beam = b.beam || len * (sail ? 0.32 : 0.2), v = b.speed;
    const str = clamp((v - 2) / 5.5, 0.15, 1);
    // the lane's reach (CHECKS' photos from a height: a fast boat's runs 30-50 of its lengths); none at rest. A sailboat's
    // 4-6 of its lengths (DYS-232 sails, Akshay's "still wrong": its thin lane ran ~30 lengths; from a height a sailboat
    // leaves hardly a trace, refs fromabove-01; BOAT_WAKE_GLSL makes what is left faint)
    const dMax = Math.max(2 * len, Math.min(2000, len * (sail ? 4 + 6 * str : 8 + 50 * str)) * smooth(0.4, 2.5, v));
    // the bow's white water as the square of the speed (the ferry at 7.4 m/s ~1, a sailboat at 3 m/s ~0.15)
    const bow = clamp((v / 7.5) ** 2, 0.05, 1.2) * Math.pow(clamp(len / 40, 0.3, 1.5), 0.2);
    const dim = a * (1 - 0.85 * night);
    const H = sail ? (b.mast || len * 1.25) : (b.height || len * 0.25);
    // (DYS-232, E: the trail by age, newest first: MOTION's tours / ferry append a fixed 25 s point after points 1.5 lengths
    // of their own time apart, and for a slow boat (a tour at 5 m/s: 12, 23, 35, 47 s) that one isn't the oldest: picked
    // as 'the last', the path's last segment ran forward from 35 s to 25 s back and, extended past it, drew the lane on
    // ahead of the bow (CHECKS' final round))
    const tr = b.trail && b.trail.length > 1 ? [...b.trail].sort((p, q) => (p[2] ?? 0) - (q[2] ?? 0)) : b.trail;
    let odo;
    if (tr && tr.length) {
      const pick = [0, Math.min(2, tr.length - 1), tr.length - 1];
      for (let j = 0; j < 3; j++) { trailEnu[2 * j] = tr[pick[j]][0]; trailEnu[2 * j + 1] = tr[pick[j]][1]; }
      odo = b.odo ?? pastOf(b, len, T).odo;
    } else {
      const q = pastOf(b, len, T);
      for (let j = 0; j < 3; j++) backAlong(q, b, TRAIL_D[j] * len, trailEnu, 2 * j);
      odo = b.odo ?? q.odo;
    }
    const w = (j) => { const p = F.rel(trailEnu[2 * j], trailEnu[2 * j + 1], b.z); return [p[0], -p[2]]; };
    const [x1, z1] = w(0), [x2, z2] = w(1), [x3, z3] = w(2);
    const cat = sp?.t?.cat_half ? sp.t.cat_half * sp.lenScale : 0;
    return { P: [r[0], -r[2], h[0], h[1]], Q: [len, beam, dMax, dim], R: [bow * dim, washOf(b, T), H, Math.max(v, 0.01)],
      S: [x1, z1, x2, z2], T: [x3, z3, cat, ((odo % 4096) + 4096) % 4096] };
  }
  // (DYS-232, ?shipwake=1: ships/ships.js SHIP_WAKE) a big ship's wake in the same model: its own numbers (shipWake: the
  // white water by its Froude number, the bow's, the lane's reach), its past path (the clock's it.trail: 1.5, 4 and 12
  // lengths back) and odometer; T.z its white water as a negative number (a ship, not a catamaran: the shader's side,
  // scratch/D/ships/ship-wakes.patch, reads it so; today's shader takes it as no second hull)
  const shipW = {};
  function shipWakeRow(b, r, h, a, night, T) {
    const len = b.len, beam = b.beam || len * 0.15, v = b.speed;
    shipWake(len, v, shipW);
    const dim = a * (1 - 0.85 * night);
    const tr = b.trail;
    let odo;
    if (tr && tr.length >= 5) {
      for (let j = 0; j < 3; j++) { trailEnu[2 * j] = tr[2 * j][0]; trailEnu[2 * j + 1] = tr[2 * j][1]; }
      odo = b.odo ?? pastOf(b, len, T).odo;
    } else {
      const q = pastOf(b, len, T);
      for (let j = 0; j < 3; j++) backAlong(q, b, TRAIL_D[j] * len, trailEnu, 2 * j);
      odo = b.odo ?? q.odo;
    }
    const w = (j) => { const p = F.rel(trailEnu[2 * j], trailEnu[2 * j + 1], b.z); return [p[0], -p[2]]; };
    const [x1, z1] = w(0), [x2, z2] = w(1), [x3, z3] = w(2);
    return { P: [r[0], -r[2], h[0], h[1]], Q: [len, beam, shipW.dMax, dim], R: [shipW.bow * dim, 0, b.height || len * 0.15, Math.max(v, 0.01)],
      S: [x1, z1, x2, z2], T: [x3, z3, -shipW.white, ((odo % 4096) + 4096) % 4096] };
  }

  // camera: { vp: Float64Array(16) column-major view-projection (no jitter, sway included), width, height, pxPerRad,
  //           pxPerRadRest (DYS-183: the full-size frame's, for the decisions only), css: device px per CSS px, phone: bool }
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
  // (DYS-149 gc-diet: project into o (null where project is), its caller reading it before the next)
  const W3 = [0, 0, 0], R3 = [0, 0, 0], P2 = [0, 0];
  function projectTo(o, x, y, z) {
    const w = F.worldTo(W3, x, y, z), m = cam.vp;
    const cx = m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12];
    const cy = m[1] * w[0] + m[5] * w[1] + m[9] * w[2] + m[13];
    const cw = m[3] * w[0] + m[7] * w[1] + m[11] * w[2] + m[15];
    if (cw <= 1e-6) return null;
    const px = (cx / cw * 0.5 + 0.5) * cam.width, py = (cy / cw * 0.5 + 0.5) * cam.height;
    if (px < -200 || px > cam.width + 200 || py < -200 || py > cam.height + 200) return null;
    o[0] = px; o[1] = py;
    return o;
  }
  const distOf = (x, y, z) => Math.hypot(x, y, z);

  function grow() {
    if ((np + 1) * POINT_FLOATS > pts.length) { const n = new Float32Array(pts.length * 2); n.set(pts); pts = n; }
  }
  // one point. shape 0 light (added), 1 water streak (added; lenCss its length), 2 speck / sky dot (over),
  // 3 gull (over; lenCss its wingspan, wing the wing angle -1..1). aShape = (sigma px | wing, shape, length px, size px)
  function point(x, y, z, rgb, a, sigCss, shape, lenCss = 0, wing = 0) {
    if (GC_DIET) return point2(x, y, z, rgb, a, sigCss, shape, lenCss, wing);
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
  function point2(x, y, z, rgb, a, sigCss, shape, lenCss, wing) {
    const p = projectTo(P2, x, y, z);
    if (!p || a <= 0.002) return;
    grow();
    const d = distOf(x, y, z), r = F.relTo(R3, x, y, z);
    const sig = sigCss * cam.css, len = lenCss * cam.css;
    const size = shape === 3 ? Math.ceil(len * 1.2 + 4) : shape === 1 ? Math.ceil(Math.max(sig * 6, len * 2) + 2) : Math.max(3, Math.ceil(sig * 7));
    const P = pts, o = np * POINT_FLOATS;
    P[o] = p[0]; P[o + 1] = p[1]; P[o + 2] = size; P[o + 3] = d; P[o + 4] = rgb[0]; P[o + 5] = rgb[1]; P[o + 6] = rgb[2]; P[o + 7] = a;
    P[o + 8] = shape === 3 ? wing : sig; P[o + 9] = shape; P[o + 10] = len; P[o + 11] = size;
    P[o + 12] = r[0] / d; P[o + 13] = r[1] / d; P[o + 14] = r[2] / d;
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
  // (DYS-134, Akshay 30 Oct, his own crop of the live site at night, Lombard at ~2.3x: the oncoming heads big hazy white
  // blobs beside crisp tails. A head was a glow of 1.4 at 0.8 CSS px under a core of 0.6, both x zm^0.4: white, so all
  // three channels clipped over a disc ~2x a real lamp's and its skirt read as haze (his view re-shot, 2.264x, 2x screen
  // px: 6.1 px across at half its light, a tenth of it out to 5.1 px, 34 px^2 of white; the real SF freeway's far cars
  // (f-005) scaled to our pair spacing: 3.4-3.7, 2.6-2.9, 10-12 px^2, white at the centre), the pair 1.06 m apart (the
  // meshes' lenses sit 1.2-1.5 m apart) merged into one blob, and the whole grew with the magnifier as no lamp does. The
  // tails' glow is red alone, a fifth of white's luma, so theirs never read as haze. So a head is its core: near white,
  // clipping at its centre, as wide as the screen's own blur (HEAD_SIG, CSS px) or the lamp's own angle (HEAD_LENS_M
  // across at the car's distance), whichever is more: it grows only as the lamp does; and a faint warm haze round it,
  // fixed on the screen; the pair where the lenses are. (HEAD_CORE 2: at 1.2 the narrow core, softened as the canvas is
  // enlarged to the screen, peaked at ~215 of 255)
  const HEAD_SIG = 0.5, HEAD_LENS_M = 0.2, HEAD_CORE = 2.0, HEAD_HAZE = 0.08, HEAD_HAZE_SIG = 1.8, HEAD_SIDE = 0.66;
  // (DYS-240 traffic-real lights, LIGHTS for E, against the refs (traffic-real/refs: street-01, -09, bridge-05, -06):
  // - heads: real night streams mix the bluish white of LED headlamps with the yellower white of halogen ones; ours were
  //   all one warm white. About 4 in 10 cars on the road in 2026 have LED heads (new cars since ~2018 mostly do; the
  //   fleet's mean age ~12.6 years; est.): HEAD_LED of them, by the car's own fixed number, cool white, the rest as
  //   before. The core still clips to white at its centre; the hue is in its skirt and glow, and the air takes both
  //   toward the same warm white (LAMP_AIR.head)
  // - far lamps (FAR_M: from 2.5 km, all of it by 4.5 km: the Presidio's roads, the bridge) are points far under the
  //   screen's pixel even at 4x (a tail lamp 0.3 m across, 5.6 km out, at 4x: 0.3 CSS px): their size is the screen's
  //   blur, not grown with the magnifier as a near lamp's glare is (zm^0.4). At 4x the bridge's tails were red discs
  //   2.4x the heads' width (sigma 1.22 vs 0.5 CSS px), so the going-away lanes read brighter than the oncoming, the
  //   opposite of every photo (close-08, bridge-05: the white streams glare, the red are thinner and dimmer). Far tails
  //   also a quarter narrower (FAR_TAIL), as wide as a head's core
  // - every tail at least 0.75 canvas px across, as the heads (the core of 0.35 CSS px on a dpr-1 screen twinkled
  //   between pixels as the car drifted)
  const HEAD_LED = 0.4, LAMP_LED = { core: [0.93, 0.97, 1.0], glow: [0.86, 0.92, 1.0] }, FAR_M = [2500, 4500], FAR_TAIL = 0.25;
  // (DYS-240 street lamps, G: the near tails too. On Lombard at 19:30 4x (1-2.5 km) the tails were red discs 5.6 screen
  // px across beside heads of 3.0 (both pairs ~12 px apart): grown x zm^0.4 as DYS-134 stopped the heads growing, so
  // the going-away lanes read bigger than the oncoming ones. So a tail's glow and core are their own sigma or the
  // lamp's own angle (TAIL_LENS_M across at the car's distance, a quarter of it), whichever is more, as a head's, and
  // never wider than before (1x unchanged); their light and colour as before. ?trafficreal=0: x zm^0.4 as before)
  const TAIL_LENS_M = 0.3;
  // (DYS-240 tails, G, Akshay 4 Nov: 'how would tail lamps realistically show up from the window?'. A street car's
  // running tails deep red, as LED tail lamps are (~620-630 nm: sRGB about (1, 0.05-0.1, 0)); ours were orange-salmon
  // (glow g/r 0.22, core 0.55). The core keeps a little of white where it is brightest (g/r 0.25), the glow is red alone,
  // and the air takes the far ones toward a deeper red than before. And dimmer than the heads: they face us and are far
  // stronger, the tails' light x run (glow and core) for a running car; braking as before, so a queue at a red reads
  // brighter. The bridge's vehicles keep theirs (rounds 3-4, 5 km of haze). ?trafficreal=0: as before)
  const TAIL_DEEP = { glow: [1, 0.08, 0.05], core: [1, 0.25, 0.16], air: [1.0, 0.3, 0.16], run: 0.7 };
  // (a tail's sigma, CSS px, from its base b: b x the magnifier's growth sz (and far's tk) before; with traffic-real no
  // more than its own lamp's angle tl (a quarter of it) would give. One function, not a closure a car a frame)
  const tailSig = (b, sz, tk, tl, tMin) => Math.max(TRAFFIC_REAL ? Math.min(b * sz * tk, Math.hypot(b * tk, tl)) : b * sz * tk, tMin);
  // - the bridge's lamps are all seen ~59 deg off their axis (the lanes run 174 / 354 deg, the window is ~115 deg from
  //   the deck): a headlamp's beam is narrow, a tail lamp's wide (made to be seen to 45 deg and more), so off-axis the
  //   heads lose more (est.: heads x0.6, tails x0.85). With the pair as one point at 1x (above) the stream otherwise read
  //   as bright as the deck's own lamps (stills 19:30 1x, LIGHTS 3 Nov); the roadway lamps (~1000 cd toward the window,
  //   est.) outshine an off-axis headlamp (tens of cd) many times. Heads still ~6x a tail's luma at 1x
  const BRIDGE_OFF = { head: 0.6, tail: 0.85 };
  const toAir = (rgb, air, t) => rgb.map((x, i) => x + (air[i] - x) * t);
  const toAirTo = (o, rgb, air, t) => { for (let i = 0; i < 3; i++) o[i] = rgb[i] + (air[i] - rgb[i]) * t; return o; };   // (gc-diet)
  const HG = [0, 0, 0], HC = [0, 0, 0], TG = [0, 0, 0], TC = [0, 0, 0], SGN = [-1, 1];
  // (QUEUE 13, occlusion alone, the coordinator 14:2x 28 Oct; round 3 motion: both dusk / night inspectors scored
  // Greenwich 1-3 for 'a frozen, overlapping stack of headlight / tail-light pairs at the top of the street': a queue
  // facing the window lines up along the line of sight, and every car's lamps were drawn through the cars in front of
  // it.) Each street car's body as a box on the screen with its distance, made once a frame in fill(); a lamp inside a
  // nearer car's box is hidden, fading over the box's outer 15 % so its edges don't flicker.
  const occ = [];
  let occN = 0;
  // (DYS-240 tails, G, Akshay 4 Nov: 'why is a car's tail lamp piercing through a truck?'. The box was 1.5 m tall for a
  // car and 2.6 m for a heavy one; the box truck's mesh is 3.6 m (the bus 3.4, SUVs and pickups 1.6-1.9), so the lamps
  // of the cars behind a truck showed through its top metre. With traffic-real a box is the vehicle's drawn mesh: its
  // length as drawn (x kl, below), its beam less the mirrors (x 0.92), its height. ?trafficreal=0 or no meshes: as before)
  const BOXD = [0, 0, 0];
  function boxDims(v, heavy) {
    const mm = TRAFFIC_REAL && carMeshes ? carMeshes.models[meshOf(v)] : null;
    if (mm) {
      BOXD[0] = (mm.length * Math.min(1, Math.max(0.85, (v.len || mm.length) / mm.length))) / 2; BOXD[1] = mm.beam * 0.46; BOXD[2] = mm.height;
    } else { BOXD[0] = (v.len || 4.6) / 2; BOXD[1] = heavy ? 1.15 : 0.92; BOXD[2] = heavy ? 2.6 : 1.5; }
    return BOXD;
  }
  function carBox(v) {
    if (GC_DIET) return carBoxTo(occ[occN] || (occ[occN] = { x0: 0, y0: 0, x1: 0, y1: 0, d: 0, v: null }), v);
    const heavy = v.kind === "heavy", h = v.heading * DEG, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const B = boxDims(v, heavy), hl = B[0], hw = B[1], ht = B[2], z0 = v.zRoad ?? v.z - 0.9;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [0, 1]) {
      const p = project(v.x + fx * hl * a + rx * hw * b, v.y + fy * hl * a + ry * hw * b, z0 + ht * c);
      if (!p) return null;
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    return { x0, y0, x1, y1, d: distOf(v.x, v.y, z0 + ht / 2), v };
  }
  // (gc-diet: into occ's next box, kept from frame to frame; null as carBox)
  function carBoxTo(o, v) {
    const heavy = v.kind === "heavy", h = v.heading * DEG, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const B = boxDims(v, heavy), hl = B[0], hw = B[1], ht = B[2], z0 = v.zRoad ?? v.z - 0.9;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let a = -1; a <= 1; a += 2) for (let b = -1; b <= 1; b += 2) for (let c = 0; c <= 1; c++) {
      const p = projectTo(P2, v.x + fx * hl * a + rx * hw * b, v.y + fy * hl * a + ry * hw * b, z0 + ht * c);
      if (!p) return null;
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    o.x0 = x0; o.y0 = y0; o.x1 = x1; o.y1 = y1; o.d = distOf(v.x, v.y, z0 + ht / 2); o.v = v;
    return o;
  }
  function lampSeen(x, y, z, self) {
    if (!occN) return 1;
    const p = GC_DIET ? projectTo(P2, x, y, z) : project(x, y, z);
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
  // (traffic-real lights: one = an unmagnified bridge vehicle, 5-6 km out: its pair ~0.3 CSS px apart, so one lamp at
  // each end with the pair's light, at the car's middle (the lit end is under a canvas px off it), not hidden by street
  // cars' boxes (the deck is on the horizon); its colours, air, railing and sizes the magnified pair's, so nothing jumps
  // at the magnifier's switch to 3D (before: one point of its own, white 0.8 / red 0.55 at 0.42 CSS px, with no air)
  const ONE = [0];
  // (bridge lamps, BRIDGE_LAMP_Q: this frame's daylight share, 0 with the sun down, 1 from BRIDGE_LAMP_UP deg up; fill sets it)
  let brDay = 0;
  function streetLamps(v, k0, heavy, zm, one = false) {
    // (bridge lamps: BRIDGE_LAMP_Q above, none by day)
    const off = v.railW != null && BRIDGE_LAMP_Q ? 1 - brDay : 1;
    const hz = clamp(v.haze ?? 0, 0, 1), k = k0 * (1 - 0.7 * hz) * (one ? 2 : 1) * off, mute = 0.6 * hz;
    const kh = v.railW != null ? k * BRIDGE_OFF.head : k, kt = v.railW != null ? k * BRIDGE_OFF.tail : k;
    const led = TRAFFIC_REAL && idUq(v.id, "led") < HEAD_LED;
    const hg0 = led ? LAMP_LED.glow : LAMP_GLOW.head, hc0 = led ? LAMP_LED.core : LAMP_CORE.head;
    const headGlow = GC_DIET ? toAirTo(HG, hg0, LAMP_AIR.head, mute) : toAir(hg0, LAMP_AIR.head, mute);
    const headCore = GC_DIET ? toAirTo(HC, hc0, LAMP_AIR.head, mute) : toAir(hc0, LAMP_AIR.head, mute);
    const deep = TRAFFIC_REAL && v.street != null, tg0 = deep ? TAIL_DEEP.glow : LAMP_GLOW.tail, tc0 = deep ? TAIL_DEEP.core : LAMP_CORE.tail;
    const ta = deep ? TAIL_DEEP.air : LAMP_AIR.tail, run = deep ? TAIL_DEEP.run : 1;
    const tailGlow = GC_DIET ? toAirTo(TG, tg0, ta, mute) : toAir(tg0, ta, mute);
    const tailCore = GC_DIET ? toAirTo(TC, tc0, ta, mute) : toAir(tc0, ta, mute);
    const h = v.heading * DEG, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const dh = Math.hypot(v.x, v.y) || 1, ex = -v.x / dh, ey = -v.y / dh;
    const face = fx * ex + fy * ey;                              // +1: its front toward the window
    // (a headlight is seen well off its axis: crossing the view side-on, a car still shows its pair at half strength)
    const front = smooth(-0.55, 0.35, face), rear = smooth(-0.25, 0.6, -face);
    const len = v.len || 4.6, half = one ? 0 : len / 2 - 0.15, side = (heavy ? 1.1 : 0.78) - 0.25, hside = heavy ? side : HEAD_SIDE;
    const z0 = v.zRoad ?? v.z - 0.9, dC = Math.max(1, distOf(v.x, v.y, z0));
    // (traffic-real lights: a far lamp's size the screen's blur, not grown with the magnifier; far tails narrower; and every
    // tail at least 0.75 canvas px, as the heads below)
    const far = TRAFFIC_REAL ? smooth(FAR_M[0], FAR_M[1], dC) : 0, tk = 1 - FAR_TAIL * far;
    const sz = zm > 1 ? zm ** 0.4 * (1 - far) + far : 1, tMin = TRAFFIC_REAL ? 0.75 / cam.css : 0;
    const tint = 0.85 + 0.15 * (v.tint ?? 1);
    // (a head's core, CSS px: the screen's blur, or a disc of the lamp's own size (sigma a quarter of it), the more)
    const hk = heavy ? 1.15 : 1, lensPx = (HEAD_LENS_M * cam.pxPerRad) / dC / cam.css;
    // (at least 0.75 canvas px: POINTS_FS takes the Gaussian at pixel centres, and at 1 canvas px per CSS px or less a
    // core of 0.5 flickered between a clipped dot and a dim 2x2 block as the car drifted; dpr 1.5 and up: as before)
    const headSig = Math.max(hk * Math.hypot(HEAD_SIG, lensPx / 4), 0.75 / cam.css);
    const tLens = (TAIL_LENS_M * cam.pxPerRad) / dC / cam.css / 4;     // (a tail lamp's own angle / 4, CSS px: tailSig)
    for (const sgn of one ? ONE : GC_DIET ? SGN : [-1, 1]) {
      if (front > 0.01) {
        const x = v.x + fx * half + rx * hside * sgn, y = v.y + fy * half + ry * hside * sgn, z = z0 + (heavy ? 0.9 : 0.7);
        const seen = one ? 1 : lampSeen(x, y, z, v);
        if (seen > 0) {
          point(x, y, z, headCore, kh * front * HEAD_CORE * tint * seen, headSig, 0);
          point(x, y, z, headGlow, kh * front * HEAD_HAZE * tint * seen, hk * HEAD_HAZE_SIG, 0);
        }
      }
      if (rear > 0.01) {
        const x = v.x - fx * half + rx * side * sgn, y = v.y - fy * half + ry * side * sgn, z = z0 + (heavy ? 1.0 : 0.85);
        const seen = one ? 1 : lampSeen(x, y, z, v);
        if (seen > 0) {
          point(x, y, z, tailGlow, kt * rear * (v.brake ? 1.4 : 0.85 * run) * tint * seen, tailSig(heavy ? 0.85 : 0.7, sz, tk, tLens, tMin), 0);
          point(x, y, z, tailCore, kt * rear * (v.brake ? 0.4 : 0.25 * run) * tint * seen, tailSig(heavy ? 0.42 : 0.35, sz, tk, tLens, tMin), 0);
        }
      }
    }
    // (traffic-real lights: braking, a car's third brake light (US law since 1986: centred, high, at the rear window's top
    // edge; est. 1.2 m up on a sedan, 1.65 on an SUV, van or pickup), as bright as one of its brake lamps and smaller (a
    // strip of LEDs): a queue at a red shows each car's red triangle, as street-03's Hyde St does. None on a heavy one
    // (trucks over 10,000 lb need none; a bus's is a row of its own) nor the far bridge's (none brake))
    if (TRAFFIC_REAL && v.brake && !heavy && !one && rear > 0.01 && v.type !== "motorbike") {
      // (the rear window's top: ~0.6 m forward of the tail lamps on a sedan's sloped glass, ~0.15 on an upright tailgate)
      const tall = v.type === "suv" || v.type === "van" || v.type === "pickup", b = half - (tall ? 0.15 : 0.6);
      const x = v.x - fx * b, y = v.y - fy * b, z = z0 + (tall ? 1.65 : 1.2);
      const seen = lampSeen(x, y, z, v);
      if (seen > 0) {
        point(x, y, z, tailGlow, k * rear * 0.9 * tint * seen, tailSig(0.5, sz, tk, tLens, tMin), 0);
        point(x, y, z, tailCore, k * rear * 0.3 * tint * seen, tailSig(0.3, sz, tk, tLens, tMin), 0);
      }
    }
  }

  // ---- DYS-204: the traffic signals (setSignals below; none until the page has them, and never by day)
  let sigHeads = null, sigLight = null, sigHaze = null, sigArgs = null, nsig = 0, sigLook = signalLook();
  const SC = [0, 0, 0], SGL = [0, 0, 0], sigLit = [0, 0, 0];
  const SIG_REF_PPD = 124.4, GLOW_LUMA = 24 / 255, E2 = Math.exp(-2);
  // each head lit in its signal's colour at T (the simulation's light(): 0 green, 1 amber, 2 red), as bright as its beam
  // reaches the eye, x w (the night-light moments' fade); a nearer car's body hides it (lampSeen), the air mutes it as
  // it does the headlights, the panorama hides it per pixel (POINTS_FS, as every point). Its core's half-max and its
  // glow's edge (where it is 24 of 255 over its ground, the calibration's measure) at the sizes SIGNAL_LOOK gives
  function signalPoints(T, w, M) {
    const lk = sigLook, n0 = np, ppd = (cam.pxPerRad * DEG) / cam.css, sc = (ppd / SIG_REF_PPD) * lk.size;
    sigLit[0] = sigLit[1] = sigLit[2] = 0;
    for (let i = 0; i < sigHeads.length; i++) {
      const hd = sigHeads[i], st = sigLight(hd.G, T);
      const hz = M && sigHaze ? clamp(1 - sigHaze(M, hd.dist, hd.h), 0, 1) : 0;
      const k = w * hd.dir * lk.k * hd.vk * (1 - 0.7 * hz);
      if (k * lk.peak[st] < 0.008) continue;   // (under 2 of 255 at its peak: not seen; no point)
      const seen = lampSeen(hd.x, hd.y, hd.z, null);
      if (seen <= 0) continue;
      // (CSS px: the lamps' orb here x the state's, as magnified; never under the lens's own angle nor the floors)
      const lensPx = (lk.lens / hd.dist / DEG) * ppd;
      const half = Math.max(lk.halfMin, hd.lampHalf * lk.half[st] * sc * hd.vs, lensPx);
      const glow = Math.max(lk.glowMin, half + 2, hd.lampGlow * lk.glow[st] * sc);
      // (the core: the rim's hue, saturated, whitening to its own hue only once it is big)
      const wh = smooth(lk.coreWhite[0], lk.coreWhite[1], half), rc = lk.rimCore[st], hc = lk.hot[st];
      for (let c = 0; c < 3; c++) SC[c] = rc[c] + (hc[c] - rc[c]) * wh;
      const Lc = lumaOf(SC), sigC = half / 2.355, rg = glow / 2, A = lk.peak[st] / Lc;
      // (the glow: what the core lacks at the glow's edge, a Gaussian 2 sigma out there; both x the head's light)
      const core = A * Lc * (Math.exp(-(rg * rg) / (2 * sigC * sigC)) + 0.09 * Math.exp(-rg / (2.2 * sigC)));
      const Ag = Math.max(0, (GLOW_LUMA - core) / (lumaOf(lk.rim[st]) * E2)), ks = k * seen;
      point(hd.x, hd.y, hd.z, toAirTo(SC, SC, lk.air[st], 0.6 * hz), A * ks, sigC, 0);
      if (Ag > 0) point(hd.x, hd.y, hd.z, toAirTo(SGL, lk.rim[st], lk.air[st], 0.6 * hz), Ag * ks, rg / 2, 0);
      sigLit[st]++;
    }
    nsig = np - n0;
  }

  // (DYS-149 gc-diet) fill()'s 3D vehicle, its record written straight into cars3d through arrays kept for it: the
  // same numbers in the same order as the array fill() otherwise builds (up from fwd before its trim, as there)
  const FW = [0, 0, 0], RT = [0, 0, 0], UP = [0, 0, 0], T3 = [0, 0, 0], PT = [0, 0, 0], COL = [0, 0, 0];
  const toRoomTo = (o, x, y, z) => { o[0] = x * cA - y * sA; o[1] = z; o[2] = -(x * sA + y * cA); return o; };
  // (traffic-real: a bridge vehicle's railing, as above: the height it hides of it, seen from the window down over the
  // deck's width to its lane, t its road point from the eye (room frame, y up); else its brake lamps, 0 / 1)
  const brakeSlot = (v, t) => (v.railW == null || !BRIDGE_GL ? (v.brake ? 1 : 0)
    : -(0.01 + Math.max(0, BRIDGE_RAIL.h - v.railW * (-t[1] / Math.max(Math.hypot(t[0], t[2]), 1)))));
  function car3d(v, a, meshW, mi, L, V, env) {
    const h = v.heading * DEG, pt = (v.pitch || 0) * DEG;
    const fwd = toRoomTo(FW, Math.sin(h) * Math.cos(pt), Math.cos(h) * Math.cos(pt), Math.sin(pt));
    const right = toRoomTo(RT, Math.cos(h), -Math.sin(h), 0), up = UP;
    up[0] = right[1] * fwd[2] - right[2] * fwd[1]; up[1] = right[2] * fwd[0] - right[0] * fwd[2]; up[2] = right[0] * fwd[1] - right[1] * fwd[0];
    const t = F.relTo(T3, v.x, v.y, v.zRoad ?? v.z - 0.9), d = Math.hypot(t[0], t[1], t[2]);
    const ex = -t[0] / d, ey = -t[1] / d, ez = -t[2] / d;
    const ang = Math.atan2(ex * right[0] + ey * right[1] + ez * right[2], ex * fwd[0] + ey * fwd[1] + ez * fwd[2]) / DEG;
    const k = ((Math.round(ang / 45) % 8) + 8) % 8;
    const lm = v.look?.moment;
    const keepC = env.stats?.deck != null ? Math.pow(clamp(env.stats.deck / 0.9, 0.02, 1), d / DECK_D) : 1;
    const haze = 1 - (1 - Math.max(lm?.hazeMix ?? 0, v.haze ?? 0)) * keepC;
    const paint0 = CAR_PAINT[paintOf(v)]?.[1] || [0.5, 0.5, 0.5];
    const pg = 0.2126 * paint0[0] + 0.7152 * paint0[1] + 0.0722 * paint0[2], paint = PT;
    for (let q = 0; q < 3; q++) paint[q] = paint0[q] + (pg - paint0[q]) * 0.45;
    const mm = carMeshes.models[meshNames[mi]];
    const kl = Math.min(1, Math.max(0.85, (v.len || mm.length) / mm.length));
    for (let q = 0; q < 3; q++) fwd[q] *= kl;
    // (G, DYS-240 round 6: a bridge vehicle drawn BRIDGE_CAR_Q[5] of its height; the railing's hidden height, read
    // against the model's own height in CAR3D_FS, over the same)
    const kh = v.railW != null && BRIDGE_GL && BRIDGE_CAR_Q ? Math.max(BRIDGE_CAR_Q[5], 1e-3) : 1;
    for (let q = 0; q < 3; q++) up[q] *= kh;
    if ((n3 + 1) * CAR3D_FLOATS > cars3d.length) { const nn = new Float32Array(cars3d.length * 2); nn.set(cars3d); cars3d = nn; }
    const D = cars3d, o = n3 * CAR3D_FLOATS;
    D[o] = t[0]; D[o + 1] = t[1]; D[o + 2] = t[2]; D[o + 3] = right[0]; D[o + 4] = right[1]; D[o + 5] = right[2];
    D[o + 6] = fwd[0]; D[o + 7] = fwd[1]; D[o + 8] = fwd[2]; D[o + 9] = up[0]; D[o + 10] = up[1]; D[o + 11] = up[2];
    D[o + 12] = d; D[o + 13] = a * meshW; D[o + 14] = haze; D[o + 15] = L.lights * (0.35 + 0.65 * Math.max(V.lights, L.night)) * (v.railW != null && BRIDGE_LAMP_Q ? 1 - brDay : 1); D[o + 16] = brakeSlot(v, t) / kh;
    D[o + 17] = mi; D[o + 18] = k; D[o + 19] = lin(paint[0]); D[o + 20] = lin(paint[1]); D[o + 21] = lin(paint[2]);
    D[o + 22] = t[0] / d; D[o + 23] = t[1] / d; D[o + 24] = t[2] / d; D[o + 25] = mm.length * kl; D[o + 26] = mm.beam; D[o + 27] = mm.height;
    // (G, DYS-240 timing take: idUq, idU's very number with no new string; with traffic-real every bridge vehicle comes
    // through here magnified, and idU's two strings a car a frame (and paintOf's "fleet") are garbage: a suspect for the
    // timing take's phone midday at the window, GC 35 -> 280 ms in 5 s at rest against main)
    D[o + 28] = idUq(v.id, "coat"); D[o + 29] = idUq(v.id, "roof");
    order3.push(n3);
    n3++;
  }

  // DYS-227 (gullreal): a gull for the 3D model (shared/gl/gulls.js GULL3D_FLOATS): its place (world), its heading in
  // the room frame, its scale, distance and opacity, its wing beat (city/events/gulls.js), its own number (its id), its
  // look, the eye's direction to it, whether it beats, its beats a second
  const GULL3D_FLOATS = 21;
  let gull3 = new Float32Array(GULL3D_FLOATS * 4), ng = 0;
  function gullRecord(g, d, alpha, lm) {
    if ((ng + 1) * GULL3D_FLOATS > gull3.length) { const n = new Float32Array(gull3.length * 2); n.set(gull3); gull3 = n; }
    const w = F.worldTo(W3, g.x, g.y, g.z), r = F.relTo(R3, g.x, g.y, g.z), hd = F.heading(g.heading ?? 0), o = ng * GULL3D_FLOATS;
    const D = gull3;
    D[o] = w[0]; D[o + 1] = w[1]; D[o + 2] = w[2]; D[o + 3] = hd[0]; D[o + 4] = hd[1]; D[o + 5] = (g.span || 1.3) / 1.3;
    D[o + 6] = d; D[o + 7] = alpha; D[o + 8] = g.wing ?? 0.28; D[o + 9] = g.wingAmp ?? 0; D[o + 10] = g.wingT ?? 0; D[o + 11] = idU(g.id, "gull");
    D[o + 12] = lm.sunOnFace ?? 0; D[o + 13] = lm.silhouette ?? 0; D[o + 14] = lm.rim ?? 0; D[o + 15] = lm.hazeMix ?? 0;
    const rd = Math.hypot(r[0], r[1], r[2]) || 1;
    D[o + 16] = r[0] / rd; D[o + 17] = r[1] / rd; D[o + 18] = r[2] / rd; D[o + 19] = g.flap ? 1 : 0; D[o + 20] = g.wingHz ?? 2.7;
    ng++;
  }

  function fill(s, env) {
    cam = env.cam;
    np = 0; nh = 0; nw = 0; nc = 0; n3 = 0; nsp = 0; order3.length = 0; nhh = 0;
    // (DYS-232: the sharp ship set's clock: its ships' shares ease by real time, not the city's, which a visitor can hold)
    if (detail) { const t = detail.now(); hiDt = hiAt === null ? 0 : Math.min(0.1, Math.max(0, (t - hiAt) / 1000)); hiAt = t; hiNo++; }
    const M = s.moment, L = s.lighting;
    const night = L.night, lightsOn = L.lights;
    brDay = BRIDGE_LAMP_Q && L.sunAlt != null ? smooth(0, BRIDGE_LAMP_UP, L.sunAlt) : 0;
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
      // (DYS-240 traffic-real: the bridge's vehicles too, once bridge.js gives them a model (?trafficreal=0: none, specks))
      const mi = (v.street != null || v.model != null) && carMeshes?.ready && zm > MESH_ZOOM && meshW > 0.01 ? meshNames.indexOf(meshOf(v)) : -1;
      // (DYS-183 mv-outside: 3D or a speck by the full-size frame's density, so a moving frame drawn smaller doesn't turn
      // vehicles into specks mid-gesture and back at rest)
      if (mi >= 0 && keepCar(v) && ((cam.pxPerRadRest ?? cam.pxPerRad) * (v.len || 4.6)) / (v.view?.dist || distOf(v.x, v.y, v.z)) >= MESH_MIN_PX && (GC_DIET ? projectTo(P2, v.x, v.y, v.z) : project(v.x, v.y, v.z))) {
        // a 3D vehicle: on the road (zRoad), along its heading, pitched to the slope
        // (DYS-149 gc-diet: car3d below, its record written straight into cars3d; else as before)
        if (GC_DIET) car3d(v, a, meshW, mi, L, V, env);
        else {
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
        const paint0 = CAR_PAINT[paintOf(v)]?.[1] || [0.5, 0.5, 0.5];
        const pg = 0.2126 * paint0[0] + 0.7152 * paint0[1] + 0.0722 * paint0[2], paint = paint0.map((x) => x + (pg - x) * 0.45);
        const mm = carMeshes.models[meshNames[mi]];
        // (drawn no longer than the sim's vehicle: a mesh longer than its sim length ate into the standstill gap, the
        // Camry 0.2 m, the bus 0.26 m; round 1's "cars touching in the packed mass")
        const kl = Math.min(1, Math.max(0.85, (v.len || mm.length) / mm.length));
        for (let q = 0; q < 3; q++) fwd[q] *= kl;
        if ((n3 + 1) * CAR3D_FLOATS > cars3d.length) { const nn = new Float32Array(cars3d.length * 2); nn.set(cars3d); cars3d = nn; }
        cars3d.set([t[0], t[1], t[2], ...right, ...fwd, ...up, d, a * meshW, haze, L.lights * (0.35 + 0.65 * Math.max(V.lights, L.night)) * (v.railW != null && BRIDGE_LAMP_Q ? 1 - brDay : 1), brakeSlot(v, t),
          mi, k, lin(paint[0]), lin(paint[1]), lin(paint[2]), t[0] / d, t[1] / d, t[2] / d, mm.length * kl, mm.beam, mm.height,
          idU(v.id, "coat"), idU(v.id, "roof")], n3 * CAR3D_FLOATS);
        order3.push(n3);
        n3++;
        }
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
      // (DYS-240 traffic-real lights: a bridge vehicle's too (v.railW: bridge.js gives it under traffic-real). Its lamps
      // followed the moments' blend alone (V.lights: dusk's moment, sun -3.6), so from sunset to ~17:20 on 3 Nov the
      // bridge's cars were at a quarter to half of the street cars' lamps a few hundred metres nearer, and dark specks
      // against the sky; real drivers' lamps (most switch on by themselves) are on as the streets' are)
      const lampK = v.street != null || v.railW != null ? L.lights * (0.6 + 0.4 * Math.max(V.lights, night)) : V.lights;
      if (lampK > 0.01) {
        const c = v.light === "tail" ? RGB.red : RGB.white;
        // (a bike: one small lamp, front or back, much fainter than a car's pair)
        if (bike) point(v.x, v.y, v.z, c, a * lampK * 0.25, 0.25, 0);
        // (DYS-240 traffic-real: a bridge vehicle drawn 3D, its pair of lamps as the streets'; unmagnified, its point as before)
        // (traffic-real lights: unmagnified, the pair in one point each end, streetLamps one; as the 3D one's, through the
        // railing (with CAR3D_FS's bridge edits, BRIDGE_GL, as E's) and the air)
        else if ((v.street != null || v.railW != null || meshed) && v.heading != null) streetLamps(v, a * lampK * (v.railW != null && BRIDGE_GL ? BRIDGE_RAIL.see : 1), heavy, zm, v.railW != null && !meshed);
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
        const col = GC_DIET ? COL : [g * (1 - dark) + 0.07 * dark, g * (1 - dark) + 0.06 * dark, g * 0.98 * (1 - dark) + 0.06 * dark];
        // (DYS-149 gc-diet: into COL, which point() reads at once)
        if (GC_DIET) { col[0] = g * (1 - dark) + 0.07 * dark; col[1] = g * (1 - dark) + 0.06 * dark; col[2] = g * 0.98 * (1 - dark) + 0.06 * dark; }
        // (DYS-240 cars: lit, its own paint, not one grey for every car: CAR_PAINT pulled 45 % toward its grey as car3d
        // pulls it, off black by the sky a dark body mirrors (0.1 + 0.8 x: white 0.84, black 0.16, the fleet's mean luma
        // ~0.47 against the grey's 0.52), so at 1x the real mix shows, mostly white, silver, grey and black, as the
        // photographs from above have it (refs bridge-03, close-01); a bridge vehicle has a paint only with traffic-real)
        if (TRAFFIC_REAL && v.paint != null) {
          const p0 = CAR_PAINT[paintOf(v)]?.[1] || [0.5, 0.5, 0.5], pg = 0.2126 * p0[0] + 0.7152 * p0[1] + 0.0722 * p0[2];
          for (let q = 0; q < 3; q++) col[q] = (0.1 + 0.8 * (p0[q] + (pg - p0[q]) * 0.45)) * (1 - dark) + (q ? 0.06 : 0.07) * dark;
        }
        // the air between: a car 5-6 km out shows only as much as the haze lets through (city.js v.haze); backlit, no
        // plainer than the deck it drives on (the panorama's own deck: env.stats.deck, its silhouette's darkness against
        // what lies just above it; about 0.9 with no air in front)
        const hz = 1 - (v.haze ?? 0);
        const dk = env.stats?.deck != null && v.street == null ? Math.min(hz, clamp(env.stats.deck / 0.9, 0, 1)) : hz;   // (a street car: no deck)
        // (G, DYS-240 round 4: a bridge vehicle's air is the air in front of it, not the hill behind. Thinned by hz, its
        // speck went toward the picture behind it, the Marin hills 8+ km out, darker than the horizon's air: at 12:30 4x
        // 89 % of the cars' pixels came out darker than the scene (-14 levels), grey-blue specks. As in a photograph, the
        // haze is in its colour, paint x hz + the air's colour (env.stats.air, the panorama's sky 0-4 deg up) x (1 - hz),
        // over its own footprint at full cover: a white car reads pale and a dark one about as the haze, refs bridge-02's
        // pale specks. The specks against a low sun (V.dark) as before)
        let hzK = hz;
        if (TRAFFIC_REAL && v.street == null && env.stats?.air) {
          const air = env.stats.air, w = (1 - hz) * (1 - dark);
          for (let q = 0; q < 3; q++) col[q] += (air[q] - col[q]) * w;
          hzK = 1;
        }
        const k = (V.speck * hzK + V.dark * dk) / Math.max(day, 1e-3);
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

    // ---- gulls: the 3D western gull (DYS-227: env.gull3d, once outside.js has its programs; shared/gl/gulls.js draws
    // the records), else a flapping V, lit by the moment's sun or dark against it
    ng = 0;
    for (const g of s.gulls) {
      const a = g.alpha ?? 1;
      const d = g.view?.dist || distOf(g.x, g.y, g.z);
      const span = ((g.span || 1.3) * cam.pxPerRad) / d;            // device px
      if (span < 0.8) continue;
      const lm = g.look?.moment || {};
      if (env.gull3d) { gullRecord(g, d, a * L.day, lm); continue; }
      const lit = 0.75 * (1 - (lm.silhouette ?? 0)) + 0.08;
      const wing = (g.wingAmp ?? 1) * Math.sin((g.wing ?? 0) * 2 * Math.PI);
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
          // (DYS-232, E: a boat's lights by day: fog turns the lights on in daylight, where a real boat's windows look dark
          // and its navigation lights hardly show: boats only, with boatsfx; the big ships as before)
          const dayDim = BOATS_FX && b.cls !== "ship" ? 1 - 0.92 * L.day : 1;
          const sun = [Math.sin(db) * ca, Math.sin(Math.max(-5, sunAlt) * DEG), -Math.cos(db) * ca, (M ? M.mode.lights : 1 - L.day) * dayDim];
          const r = F.rel(b.x, b.y, b.z), d = v.dist;
          // the ship's paint (its livery faces) and its floodlights' colour temperature (0 sodium .. 1 LED)
          const lv = sp.livery || b.livery || [0.7, 0.7, 0.7];
          // a hull instance of sprite q, its cells at (x0, y0), (x1, y1) of its atlas, at opacity al
          const row = (q, x0, y0, x1, y1, al, refl, mo) => {
            const s1 = q.size1 || q.size;
            return [p0[0], p0[1], q.scale, d,
              x0, y0, q.size[0], q.size[1], x1, y1, s1[0], s1[1],
              // flags: 1 reflection, 2 mirrored, 4 swap (MOTION), 8 a boat (WATER, with boatsfx), 16 cut at the waterline (MOTION),
              // 32 a big ship (its day reflection: E's release review)
              // (a ship takes the boats' reflection with their wake: ?shipwake=1)
              q.blend, q.anchor, al, (refl ? 1 : 0) + (q.mirror ? 2 : 0) + (q.swap ? 4 : 0) + (BOATS_FX && (b.cls !== "ship" || SHIP_WAKE) ? 8 : 0) + (q.clip ? 16 : 0) + (b.cls === "ship" ? 32 : 0),
              lm.sunOnFace ?? 0, lm.silhouette ?? 0, lm.rim ?? 0, b.cls === "ship" ? 1 - (1 - (lm.hazeMix ?? 0)) ** SHIP_HAZE_K : lm.hazeMix ?? 0,
              sun[0], sun[1], sun[2], sun[3], r[0] / d, r[1] / d, r[2] / d,
              q.warp[0], q.warp[1], q.t.mirror ? 1 : BOATS_FX && q.t.a_paint ? 0.5 : 0, q.t.win_gain ?? 1, lv[0], lv[1], lv[2], b.led ?? 0.5,
              mo[0], mo[1], mo[2], mo[3]];
          };
          // (DYS-232) a big ship: its reflection glued to its moving hull (glue, the stretch outside.js gives
          // uReflStretch), and, magnified, its sharp pictures' share hk (sharpShare): those drawn first from the pool at
          // a x hk, the 1x atlas's over them at a x (1 - hk), so a fully opaque pixel is the two mixed and the hull never
          // thins; at hk 1 only the sharp
          const big = b.cls === "ship";
          const reflK = 0.7 + 0.9 * (M ? M.mode.lights : env.stats?.night ?? night);
          // (DYS-232, D: Akshay's part 10 frame, no contact with the water) a big ship's reflection by day twice the boats':
          // seen at a degree or so from the window, the water mirrors its dark hull as a solid band under the waterline;
          // at night as before (its lights' columns). ?shiphaze=0 as before
          const reflA = big && SHIP_HAZE_K !== 1 ? 1 + 0.3 * (L.day ?? 0) : 1;   // (E's release review: capped at 1.3, from 2)
          const hk = big && detail?.meta ? sharpShare(b, sp) : 0;
          for (const refl of [true, false]) {
            if (hk > 0) {
              if ((nhh + 1) * HULL_FLOATS > hullsHi.length) { const n = new Float32Array(hullsHi.length * 2); n.set(hullsHi); hullsHi = n; }
              const hm = hiSp.motion || NO_MOTION;
              hullsHi.set(row(hiSp, hiC0.x, hiC0.y, hiC1.x, hiC1.y, a * hk * (refl ? reflA : 1), refl, refl && hiSp.motion ? glue(hm, reflK) : hm), nhh * HULL_FLOATS);
              nhh++;
            }
            if (hk >= 0.998) continue;
            if ((nh + 1) * HULL_FLOATS > hulls.length) { const n = new Float32Array(hulls.length * 2); n.set(hulls); hulls = n; }
            const mo = sp.motion || NO_MOTION;
            hulls.set(row(sp, sp.cell0[0], sp.cell0[1], sp.cell1[0], sp.cell1[1], a * (1 - hk) * (refl ? reflA : 1), refl, refl && big && sp.motion ? glue(mo, reflK) : mo), nh * HULL_FLOATS);
            nh++;
          }
        }
      }
      // wakes (in the backdrop's water shader): right / forward of the desk eye. A big ship's scale with its speed and
      // size: the white bow wave (stronger as the square of the speed), the churned track and the Kelvin arms behind it
      // (as long as the water it has crossed in about four and a half minutes), and a soft darkening of the water
      // along its sides (the hull's shade and the calm in its lee)
      if (((b.speed ?? 0) > 0.5 && !b.docked) || (BOATS_FX && b.cls !== "ship" && Math.abs(washOf(b, s.T)) > 0.05)) {
        const r = F.rel(b.x, b.y, b.z), h = F.heading(b.heading);
        const cls = CLASSES[b.kind]?.atlas;
        const big = b.cls === "ship";
        const sv = clamp((b.speed ?? 0) / 6.2, 0, 1.6), size = clamp((b.len || 200) / 250, 0.4, 1.6);
        const wake = big ? clamp(b.speed * 270, 300, 2200) : cls === "sail" ? 70 : 520;
        const foam = big ? 0.6 * Math.pow(sv, 1.3) * Math.pow(size, 0.3) : cls === "sail" ? 0.35 : 1.0;
        const bow = big ? 1.0 * sv * sv * Math.pow(size, 0.2) : foam * 0.5;
        const len = cls === "sail" ? (b.len || 10) : b.len;
        const dim = a * (1 - 0.85 * night);
        // (DYS-232 WATER: a boat's own, D's review; the big ships' as before)
        if (BOATS_FX && !big) wl.push({ ...boatWake(b, r, h, a, sp, night, s.T), k: foam * len / v.dist });
        else if (BOATS_FX && SHIP_WAKE) wl.push({ ...shipWakeRow(b, r, h, a, night, s.T), k: foam * len / v.dist });
        else wl.push({ P: [r[0], -r[2], h[0], h[1]], Q: [len, b.beam || len * 0.15, wake, foam * dim], R: [bow * dim, big ? 0.22 * a : 0.1 * a, 0, 0], k: foam * len / v.dist });
      }
      // lights: masthead, sides, stern (already filtered by their arcs) and cabin windows
      const boatDay = BOATS_FX && b.cls !== "ship" ? 1 - 0.92 * L.day : 1;   // (DYS-232, E: as dayDim above)
      if (lightsOn * boatDay > 0.02) {
        const rig = sp?.t?.nav, sc = sp ? sp.lenScale : 1;
        const near = clamp(3000 / v.dist, 0.5, 1.2);
        for (const l of b.lights || []) {
          const c = RGB[l.colour] || RGB.white;
          let { x, y, z } = l, lev = l.level ?? 1;
          const nv = rig && NAV[l.kind ?? (BOATS_FX && b.cls !== "ship" ? navKind(b, l) : undefined)];
          if (nv && rig[nv[0]]) {
            // on the model's own rig: [x starboard, y forward, z up] metres at its length, scaled to this ship
            const q = rig[nv[0]], hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
            const along = q[1] * sc, right = q[0] * nv[1] * sc;
            x = b.x + along * hx + right * hy; y = b.y + along * hy - right * hx; z = b.z + q[2] * sc;
            lev *= nv[2];
          }
          const k = lev * lightsOn * boatDay * a * near;
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
          // (DYS-183 mv-outside: the count by the full-size frame's density: not a different count on a smaller moving frame)
          const n = Math.max(3, Math.min(9, Math.round(((b.len * (cam.pxPerRadRest ?? cam.pxPerRad)) / v.dist) / 3)));
          for (let row = 0; row < (cab.rows || 1); row++) {
            const hgt = (b.height || 10) * (cab.h0 + (cab.h1 - cab.h0) * (row + 0.5) / (cab.rows || 1));
            for (let i = 0; i < n; i++) {
              const f = cab.from + (cab.to - cab.from) * (i + 0.5) / n;
              const flick = 0.75 + 0.25 * (((cab.seed || 1) * 7919 + i * 104729 + row * 31) % 97) / 97;
              point(b.x + hx * f * b.len, b.y + hy * f * b.len, b.z + hgt, RGB.warm, 0.35 * (cab.level ?? 1) * lightsOn * boatDay * a * flick, 0.42, 0);
            }
          }
        }
      }
    }
    wl.sort((p, q) => q.k - p.k).slice(0, MAX_WAKES).forEach((w, i) => {
      wakeP.set(w.P, i * 4); wakeQ.set(w.Q, i * 4); wakeR.set(w.R, i * 4); nw = i + 1;
      if (BOATS_FX) { wakeS.set(w.S || ZERO4, i * 4); wakeT.set(w.T || ZERO4, i * 4); }
    });
    // (DYS-232: the sharp pictures' shares of ships gone a while let go)
    if (detail && hiNo % 600 === 0) for (const [id, st] of hiShare) if (hiNo - st.seen > 300) hiShare.delete(id);
    // (DYS-232: the paths of boats gone a while let go)
    if (BOATS_FX && ++fillNo % 600 === 0) for (const [id, q] of past) if (fillNo - q.seen > 300) past.delete(id);
    // ---- DYS-204: the traffic signals, after every other point (theirs keep their places), at the night-light moments
    // only: the rendered moments' lights weight (0 by day and in the backlit moments: nothing is added), the city's
    // lights switch, and the street cars' and the signals' own fade-ins. Off (?signals=0) or by day: not one point.
    nsig = 0;
    const sigW = sigHeads ? L.lights * (M ? M.mode.lights : night) * (env.streetsW ?? 1) * (env.signalsW ?? 1) : 0;
    if (sigW > 0.002) signalPoints(s.T, sigW, M);
    // the 3D vehicles far to near (each covers what lies behind it)
    order3.sort((p, q) => cars3d[q * CAR3D_FLOATS + 12] - cars3d[p * CAR3D_FLOATS + 12]);
    if (!(sigW > 0.002)) sigLit[0] = sigLit[1] = sigLit[2] = 0;
    // (hullsHi only with the sharp ship set's books: without them the counts are what they were)
    return detail ? { points: np, hulls: nh, hullsHi: nhh, wakes: nw, cars: nc, cars3d: n3, streetPts: nsp, signalPts: nsig, signalLit: sigLit }
      : { points: np, hulls: nh, wakes: nw, cars: nc, cars3d: n3, streetPts: nsp, signalPts: nsig, signalLit: sigLit };
  }

  return {
    fill,
    /** DYS-227: the gulls for the 3D model this frame (GULL3D_FLOATS each, shared/gl/gulls.js), with env.gull3d */
    get gulls3d() { return gull3.subarray(0, ng * GULL3D_FLOATS); },
    get gullCount() { return ng; },
    get points() { return pts.subarray(0, np * POINT_FLOATS); },
    get hulls() { return hulls.subarray(0, nh * HULL_FLOATS); },
    /** (DYS-232) the big ships' sharp instances (HULL_FLOATS each, cells in the pool's px: ship-detail.js), drawn before hulls */
    get hullsHi() { return hullsHi.subarray(0, nhh * HULL_FLOATS); },
    /** (DYS-232) the sharp ship set's books (city/ship-detail.js createShipDetail), once the outside has one */
    setShipDetail(d) { detail = d; },
    get cars() { return cars.subarray(0, nc * HULL_FLOATS); },
    get counts() { return detail ? { points: np, hulls: nh, hullsHi: nhh, wakes: nw, cars: nc, cars3d: n3, streetPts: nsp, signalPts: nsig } : { points: np, hulls: nh, wakes: nw, cars: nc, cars3d: n3, streetPts: nsp, signalPts: nsig }; },
    /**
     * DYS-204: the traffic signal heads (signals.json, the city's streets once loaded, its frame); opts.lift the lanes'
     * lift over their road (routes.json streets.lift_m), opts.haze the moments' haze (city.lighting.haze). null: none.
     * Returns how many heads can be seen
     */
    setSignals(data, streets, frame, { lift = 0.9, haze = null } = {}) {
      sigArgs = data && streets ? [data, streets, frame, lift] : null;
      sigHeads = sigArgs ? signalHeads(data, streets, frame, { look: sigLook, lift }) : null;
      sigLight = streets?.light || null; sigHaze = haze;
      if (!sigLight) sigHeads = null;
      return sigHeads?.length ?? 0;
    },
    /** DYS-204 QA: another look at run time (a search string as the page's: ?siglook=b&sigk=1.2 ...); its heads again */
    setSignalLook(search = "") {
      sigLook = signalLook(search);
      if (sigArgs && sigLight) sigHeads = signalHeads(sigArgs[0], sigArgs[1], sigArgs[2], { look: sigLook, lift: sigArgs[3] });
      return sigHeads?.length ?? 0;
    },
    get signalLook() { return sigLook; },
    get signals() { return sigHeads; },
    /** the 3D meshes' index (cars-lod.json), once the outside has fetched it (lazily) */
    setCarMeshes(m) { carMeshes = m; meshNames = m ? Object.keys(m.models) : []; },
    /** the 3D vehicles (CAR3D_FLOATS each) and their drawing order, far to near */
    get cars3d() { return cars3d; },
    get order3() { return order3; },
    wakeP, wakeQ, wakeR, wakeS, wakeT,
    frame: F,
    spinnakers: SPINNAKERS, trims: TRIMS,
  };
}

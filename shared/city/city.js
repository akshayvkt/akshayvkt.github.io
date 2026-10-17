// The city living its day: one call gives everything outside the window at absolute time T (UTC seconds).
//
//   import { createCity } from "/shared/city/city.js";
//   const city = createCity(await (await fetch("/shared/city/routes.json")).json());
//   const s = city.state(T, { fog, sessionStart });   // fog: the shown moment's fog (clock.fogFromFrames)
//
// Positions are metres around the desk eye (x east, y north, z up, Earth's drop applied). Every event is a pure
// function of T plus integer hashes (hash.js), so two browsers agree at the same second and a tab hidden for an
// hour resumes exactly where the city is. The only per-visitor extras are the welcome gull and one front-loaded plane,
// which depend on env.sessionStart (the T at which this visitor's living layer started).
//
// env.fog: the shown moment's fog over the deck; left out, it comes from routes.json's moments (the same
// frames.json values, blended by pickFrames t). state.moment holds the per-moment sprite lighting (lighting.js), and
// each sprite's look.moment its own hints.
import { clockAt } from "./clock.js";
import { createLighting } from "./lighting.js";
import { makeFrame, smooth, view, wrap180 } from "./geo.js";
import { createBridge } from "./events/bridge.js";
import { createBeacons } from "./events/beacons.js";
import { createAircraft } from "./events/aircraft.js";
import { createShips } from "./events/ships.js";
import { createTours } from "./events/tours.js";
import { createSails } from "./events/sails.js";
import { createGulls } from "./events/gulls.js";
import { createFerries } from "./events/ferries.js";
import { createWindows } from "./events/windows.js";
import { createSound } from "./events/sound.js";
import * as phase2 from "./events/phase2.js";

// the desktop window (home_l at 1440x900): bearings from the catalogue; the sill is 6.9 deg below the horizon
export const DESK = { b0: 269.2, b1: 314.9, top: 17.6, sill: -6.9 };
export function inDesk(x, y, z, minElev = DESK.sill) {
  const v = view(x, y, z);
  return v.bearing >= DESK.b0 && v.bearing <= DESK.b1 && v.elev >= minElev && v.elev <= DESK.top;
}
// what the window spot can see through the opening (routes.json views.window_spot: proposal A's coverage.py, the
// room axis 291.997 +- 40.2 deg); the ferries are only ever in here
export const WINDOW_SPOT = { b0: 251.76, b1: 332.23, low: -20.3, top: 43.9 };
export function inWindowSpot(x, y, z, minElev = WINDOW_SPOT.low) {
  const v = view(x, y, z);
  return v.bearing >= WINDOW_SPOT.b0 && v.bearing <= WINDOW_SPOT.b1 && v.elev >= minElev && v.elev <= WINDOW_SPOT.top;
}

// Real-time lighting for one instant: how much daylight there is, whether navigation and cabin lights are on, how
// golden the light is, and the sun's colour. These switch lights by the real sun; how a sprite is drawn follows the
// rendered moment behind it (state.moment, lighting.js).
export function lighting(c) {
  const alt = c.sun.alt;
  const warm = 1 - smooth(2, 25, alt);
  return {
    sunAlt: alt, sunAz: c.sun.az, fog: c.fog,
    day: smooth(-4, 2, alt),
    lights: Math.max(1 - smooth(-3, 2, alt), smooth(0.3, 0.4, c.fog)),
    night: 1 - smooth(-8, -2, alt),
    golden: (1 - smooth(6, 16, alt)) * smooth(-2, 1, alt),
    sunRGB: [1, 0.97 - 0.25 * warm, 0.92 - 0.45 * warm],
  };
}
// an item's look: real-time light switching (lights on below sun -3 deg or in fog), and, when the moments are known,
// the hull mode and the moment's lighting hints (the sprite must match the rendered moment behind it)
function look(it, L, M, lighting) {
  const b = it.view ? it.view.bearing : view(it.x, it.y, it.z).bearing;
  const facing = Math.max(0, Math.cos((wrap180(L.sunAz - b) * Math.PI) / 180));
  const backlit = L.day * (1 - smooth(4, 18, L.sunAlt)) * facing ** 3;
  it.look = { day: L.day, backlit, lights: L.lights, hull: L.day < 0.5 ? "lights" : backlit > 0.5 ? "backlit" : "day" };
  if (M) { it.look.hull = M.hull; it.look.moment = lighting.item(it, M); }
  return it;
}

// routes.json was generated for the v2 room axis (city_routes.py ax_v2: home_p_v2 looks straight down it) and the v2
// desk eye; the catalogue's window bearings above are for that axis
export const ROUTES_AXIS = 291.9968;

// createCity(routes, { eyeAsl, axisDeg }): the panorama names the frame the city is drawn in (pano.json eye.asl_m and
// axis_bearing_deg); left out, routes.json's own (the v2 room). The eye height sets every z (and the haze), the axis
// turns the window's bearings (what the desk and the window spot can see) and the gulls' line of flight with the room.
export function createCity(routes, opts = {}) {
  const axisShift = opts.axisDeg != null ? wrap180(opts.axisDeg - (routes.cameras?.home_p_v2?.heading ?? ROUTES_AXIS)) : 0;
  if (opts.eyeAsl != null || axisShift) {
    const cams = {};
    for (const [k, c] of Object.entries(routes.cameras || {})) cams[k] = /_v2$/.test(k) ? { ...c, heading: c.heading + axisShift } : c;
    routes = { ...routes, frame: { ...routes.frame, eye_asl: opts.eyeAsl ?? routes.frame.eye_asl }, cameras: cams };
  }
  const desk = { ...DESK, b0: DESK.b0 + axisShift, b1: DESK.b1 + axisShift };
  const inDeskHere = (x, y, z, minElev = desk.sill) => {
    const v = view(x, y, z);
    return v.bearing >= desk.b0 && v.bearing <= desk.b1 && v.elev >= minElev && v.elev <= desk.top;
  };
  const frame = makeFrame(routes.frame);
  const bridge = createBridge(routes, frame);
  const beacons = createBeacons(routes, frame, bridge);
  const aircraft = createAircraft(routes, frame, inDeskHere);
  const ships = createShips(routes, frame);
  const tours = createTours(routes, frame);
  const sails = createSails(routes, frame);
  const gulls = createGulls(routes, frame);
  const windows = createWindows(routes, frame, bridge);
  const sound = createSound(routes, frame);
  const ferries = createFerries(routes, frame);
  const momentLight = routes.moments ? createLighting(routes.moments, frame) : null;

  function state(T, env = {}) {
    const c = clockAt(T, 0);
    const M = momentLight ? momentLight.at(c.sun) : null;
    c.fog = env.fog !== undefined && env.fog !== null ? env.fog : M ? M.fog : 0;
    const L = lighting(c);
    const lk = (it) => look(it, L, M, momentLight);
    const sh = [...ships.cargo(T, c), ...ships.cruise(T, c)].map(lk);
    const tb = tours.at(T, c).map(lk);
    const sb = sails.at(T, c).map(lk);
    const fe = ferries.at(T, c).map(lk);
    const pl = aircraft.at(T, c, env).map(lk);
    const gl = gulls.at(T, c, env).map(lk);
    const w = windows.at(T, c);
    // bridge traffic fades toward the view behind it by the scene's haze along the line of sight, as every other
    // sprite does (lighting.js): a car is no plainer than the deck it drives on
    const vehicles = bridge.at(T);
    if (M) for (const v of vehicles) v.haze = 1 - momentLight.haze(M, Math.hypot(v.x, v.y, v.z), frame.h(v.x, v.y, v.z));
    return {
      T,
      clock: { day: c.day, date: c.key, sec: c.sec, hour: c.hour, weekday: c.wd, dayType: c.dayType, holiday: c.holiday,
        sun: c.sun, wind: c.wind, fog: c.fog },
      lighting: L,
      moment: M,
      vehicles,
      lights: beacons.at(T, c),
      planes: pl,
      ships: sh,
      tours: tb,
      sails: sb,
      ferries: fe,
      gulls: gl,
      windows: w.windows,
      lamps: w.lamps,
      sound: sound.at(T, c, [...sh, ...tb], pl),
      phase2: { smallCraft: phase2.smallCraft(T, c), pelicans: phase2.pelicans(T, c), moon: phase2.moon(T, c),
        fleetWeek: phase2.fleetWeek(T, c) },
    };
  }

  return { state, frame, bridge, beacons, aircraft, ships, tours, sails, ferries, gulls, windows, sound, lighting: momentLight, routes,
    axisShift, desk, windowSpot: { ...WINDOW_SPOT, b0: WINDOW_SPOT.b0 + axisShift, b1: WINDOW_SPOT.b1 + axisShift } };
}

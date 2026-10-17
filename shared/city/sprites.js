// What each event looks like to a renderer: its renderer (points, sky dots, hull sprites, gulls), its size on screen,
// and, for hulls, which cells of the motion track's Blender-lit 24-heading atlas (web/live/sprites) to blend.
import { view, wrap360 } from "./geo.js";

export const DESK_PX_PER_RAD = 1335;     // CSS px per radian in the 1440x900 desktop window (23.3 px/deg)
export const PHONE_SCALE = 0.5;          // phones show the view at about half that
export const PHONE_MIN_PX = 1.5;         // events under 1.5 desktop px are dropped on phones (plan 2.3)

// renderer and atlas type per event kind. len: the dimension that sets the on-screen size.
export const CLASSES = {
  car: { renderer: "points" }, heavy: { renderer: "points" },
  beacon: { renderer: "points" }, lighthouse: { renderer: "points" }, aid: { renderer: "points" },
  bridge_light: { renderer: "points" }, cable_light: { renderer: "points" }, lamp: { renderer: "points" },
  airliner: { renderer: "sky" }, light: { renderer: "sky" }, high: { renderer: "sky" },
  container: { renderer: "hull", atlas: "ship" }, tanker: { renderer: "hull", atlas: "ship" },
  carcarrier: { renderer: "hull", atlas: "ship" }, bulk: { renderer: "hull", atlas: "ship" },
  tugbarge: { renderer: "hull", atlas: "ship" }, cruise: { renderer: "hull", atlas: "ship" },
  tour: { renderer: "hull", atlas: "ferry" }, ferry: { renderer: "hull", atlas: "ferry" }, sail: { renderer: "hull", atlas: "sail" },
  gull: { renderer: "gull" },
};
export const SPINNAKERS = [[0.86, 0.16, 0.14], [0.12, 0.3, 0.72], [0.95, 0.75, 0.15], [0.1, 0.55, 0.35], [0.95, 0.95, 0.95], [0.55, 0.15, 0.55]];
export const TRIMS = { red: [0.78, 0.12, 0.1], blue: [0.1, 0.22, 0.55] };

// size on a desktop screen in CSS px (the larger of length and height)
export function deskPx(it) {
  const d = it.view ? it.view.dist : view(it.x, it.y, it.z).dist;
  const m = Math.max(it.len || 0, it.span || 0, it.mast || 0, it.height || 0);
  return (DESK_PX_PER_RAD * m) / d;
}
export const keepOnPhone = (it) => deskPx(it) >= PHONE_MIN_PX;

// The atlas cells for a hull (motion track's sprites.json: yaws in degrees, 0 = sailing away, 90 = moving right),
// the blend between the two nearest headings, and the scale from the atlas model to this vessel at this distance
// for a canvas `canvasPx` px per radian.
export function hullSprite(it, atlas, canvasPx) {
  const cls = CLASSES[it.kind];
  if (!cls || cls.renderer !== "hull" || !atlas) return null;
  const t = atlas.types[cls.atlas], yaws = atlas.yaws, step = 360 / yaws.length;
  const v = it.view || view(it.x, it.y, it.z);
  let yaw = wrap360(it.heading - v.bearing);
  let mirror = false;
  if (cls.atlas === "sail" && it.side < 0) { mirror = true; yaw = wrap360(-yaw); }   // the sail sits to leeward
  const i0 = Math.floor(yaw / step) % yaws.length, i1 = (i0 + 1) % yaws.length, w = yaw / step - Math.floor(yaw / step);
  const model = atlas.models[cls.atlas];
  const lenM = cls.atlas === "sail" ? it.mast : it.len;
  const scale = ((canvasPx / v.dist) * (lenM / model)) / t.px_per_m;   // screen px per atlas px (as boats.js)
  return { type: cls.atlas, cell0: t.cells[i0], cell1: t.cells[i1], size: t.cell, blend: w, anchor: t.anchor, scale, mirror };
}

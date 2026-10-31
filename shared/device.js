// What "a phone" is, in one place (DYS-171, the 30 Oct review of main, finding 8). Its readers: the router's phone
// switches (router.js phoneSwitch: DYS-151 (a), (c), (d)), the engine's tier (gl/engine.js: T1 on a phone, T2 else),
// the beacon's device class (beacon.js deviceClass: scr "phone") and the photographs' phone rule (app.js PHONE,
// tod-mobile). They used to say it three ways: the router "short side at most 640 px", the others "under 600 px".
//
// A phone: a coarse primary pointer (a finger) and a screen whose short side is under 600 CSS px. The short side, so a
// phone is one either way up (Android swaps screen.width and screen.height when turned; iOS keeps them portrait).
// 600 is the usual line between a phone and a tablet (Android's sw600dp, Material's compact width): every phone's
// short side is well under it (iPhones 320-440, Android phones about 360-480, a folded foldable or a Surface Duo's one
// screen up to 540), every iPad's well over it (744 and up). Only coarse screens whose short side is 600-640 px (7-inch
// Android tablets: Nexus 7, Fire 7, Galaxy Tab A 7) changed: the router counted them as phones; the engine (T2) and
// the beacon ("tablet") did not, and still don't. And the beacon's "phone" asks for the coarse pointer now, as the
// others did: a small screen without one (e.g. a 1440 x 900 screen at 175 % browser zoom) is
// "desktop" there. No browser globals at import: node tests import this file (scripts/live/phone_class_test.mjs).
export const PHONE_SHORT_UNDER = 600;   // CSS px

/** A phone: a coarse pointer and a screen (CSS px, either way up) whose short side is under PHONE_SHORT_UNDER. */
export function isPhone(sw, sh, coarse) {
  return !!coarse && Math.min(sw, sh) < PHONE_SHORT_UNDER;
}

/** isPhone for this browser now: its screen and its primary pointer. */
export function phoneNow() {
  return isPhone(screen.width, screen.height, matchMedia("(pointer: coarse)").matches);
}

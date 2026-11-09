// The visitor's own input (DYS-231, Akshay 2 Nov: a room sound plays only on the visitor's own action, a click, tap or
// key on that object; never on a hover, a camera move, an automatic change, the time of day or an animation). It
// remembers when the last real press, release, click, key or touch happened: events the browser marks isTrusted (a
// script's dispatchEvent or el.click() is not one), heard on the window in the capture phase before anything can stop
// them. Pointer moves are not input here: a hover is not an action.
//
//   const g = createGesture();         // shared by sound.js and sound/world.js
//   g.recent(1500)                     // true when the visitor pressed, clicked, tapped or typed in the last 1.5 s
//   g.at()                             // performance.now() of that input, or null before any
//   g.dispose()
//
// Safe in node: nothing touches a DOM at import; without a window (or one without addEventListener) recent() is false.
export const GESTURE_EVENTS = ["pointerdown", "pointerup", "click", "keydown", "touchstart", "touchend"];

export function createGesture({ target = globalThis.window, now = () => performance.now(), events = GESTURE_EVENTS } = {}) {
  let last = null;
  const on = (e) => { if (e && e.isTrusted === true) last = now(); };
  const opts = { capture: true, passive: true };
  const ok = !!target && typeof target.addEventListener === "function";
  if (ok) for (const t of events) target.addEventListener(t, on, opts);
  return {
    recent(ms = 1500) { return last !== null && now() - last <= ms; },
    at() { return last; },
    dispose() {
      if (ok && typeof target.removeEventListener === "function") for (const t of events) target.removeEventListener(t, on, opts);
    },
  };
}

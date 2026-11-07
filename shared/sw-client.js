// The page's side of the return-visit cache (DYS-203; the worker is /sw.js, its plan at its top).
//
// shared/router.js (loadSW) imports this once the boot is over (the room live, or given up) and the hand-off with it,
// SW_AFTER and an idle moment later: nothing here runs while the first view loads, and a first visit's own downloads
// are never shared with it. start():
//   - registers /sw.js (scope /; its update checks never from the HTTP cache). A first visit's page stays the
//     network's: the worker takes no page over (no claim); it serves from the next visit on;
//   - hands the worker the files this visit has loaded (Resource Timing: this device's own first view, its tier, its
//     moment; router.js raised the 250-entry default so none is dropped; and the same-origin frames' own, the laptop's
//     screen's: /projects/page/, its bundle, its thumbnails). The worker copies them out of the HTTP cache,
//     each checked against its deploy's list, a few ms apart, and drops what no recent first view needs. On a return
//     visit most are stored already and it only fills the gaps (a new moment, a new deploy's changed files);
//   - ?sw=0 (off: true): unregisters every worker of this site and deletes their caches (the load itself already came
//     from the network: the worker passes a ?sw=0 address through, and removes itself as well).
// window.__sfwSW tells what happened ({ on, why, state, copied, already, bad, bytes, ms, ... }): the timing takes read
// it (scripts/live/take-return-cache.sh), as anyone may; and, on a page this worker served (a return), what it served
// from storage: controlled, hit (files), net (requests it sent to the network: not stored, not listed, before the page's
// deploy was known), page (1: the HTML too). shared/beacon.js sends state and hit with the visit's analytics event.

const sw = () => navigator.serviceWorker;

export async function start({ off = false } = {}) {
  const s = window.__sfwSW || (window.__sfwSW = {});
  await served(s);
  if (off) {
    s.state = "removing";
    try {
      for (const r of await sw().getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) if (k.startsWith("sfw-")) await caches.delete(k);
      s.state = "removed";
    } catch (e) { s.state = "error"; s.error = String(e?.message || e); }
    return s;
  }
  const t0 = performance.now();
  s.state = "registering";
  try {
    // (updateViaCache "none": each visit's check for a new /sw.js asks the host, never the HTTP cache, in every engine,
    // so a fix or the off switch, scripts/live/sw-off.js published as /sw.js, reaches a visitor at their next visit)
    const reg = await sw().register("/sw.js", { scope: "/", updateViaCache: "none" });
    const w = await activeOf(reg, 15000);
    if (!w) { s.state = "not active"; return s; }
    s.state = "copying";
    const urls = ownFiles(performance);
    // (and the same-origin frames' own: the laptop's screen, /projects/page/ in a frame, loads its bundle and
    // thumbnails in its own Resource Timing, not this page's; the worker files them under this page's deploy)
    try { for (const f of framesIn(document)) { try { urls.push(...ownFiles(f.contentWindow.performance, true)); } catch { /* another origin's */ } } } catch { /* none */ }
    // doc: the address this page was loaded from (router.js may have rewritten location since: the worker finds the
    // page's HTML, and so its deploy, by the loaded one)
    const doc = performance.getEntriesByType("navigation")[0]?.name || location.href;
    const r = await ask(w, { type: "copy", page: location.pathname, urls, doc }, "sfw-copied", 180000);
    Object.assign(s, r, { type: undefined, state: r.error ? "error" : "done", ms: Math.round(performance.now() - t0) });
  } catch (e) { s.state = "error"; s.error = String(e?.message || e); }
  return s;
}

/** This site's files a Resource Timing lists (a frame's: its own address too). */
function ownFiles(perf, nav = false) {
  const es = nav ? [...perf.getEntriesByType("navigation"), ...perf.getEntriesByType("resource")] : perf.getEntriesByType("resource");
  return es.map((e) => e.name).filter((u) => u.startsWith(location.origin + "/"));
}

/** The page's frames, also those in open shadow roots (the laptop's screen is one: projects/screen.js). */
function framesIn(root, out = []) {
  for (const el of root.querySelectorAll("*")) {
    if (el.localName === "iframe") out.push(el);
    if (el.shadowRoot) framesIn(el.shadowRoot, out);
  }
  return out;
}

/** What the worker in charge of this page served it (its own counters, "mine"), into s; nothing without one. */
async function served(s) {
  s.controlled = !!sw()?.controller;
  if (!s.controlled) return;
  const m = await stats(2000).catch(() => null);
  const c = m?.mine;
  if (c) Object.assign(s, { hit: c.hit, net: c.miss + c.pass + c.early, page: c.page });
}

/** The worker's counters for this visit (hits, misses, passed on, ...), or null without one in charge of this page. */
export function stats(ms = 3000) {
  const w = sw()?.controller;
  return w ? ask(w, { type: "stats" }, "sfw-stats", ms) : Promise.resolve(null);
}

function activeOf(reg, ms) {
  return new Promise((res) => {
    const w = reg.installing || reg.waiting;
    if (!w) return res(reg.active);
    const t = setTimeout(() => res(reg.active), ms);
    w.addEventListener("statechange", () => {
      if (w.state === "activated") { clearTimeout(t); res(w); }
      else if (w.state === "redundant") { clearTimeout(t); res(reg.active); }
    });
  });
}

function ask(w, msg, type, ms) {
  return new Promise((res) => {
    const c = sw();
    const on = (e) => { if (e.data?.type === type) { clearTimeout(t); c.removeEventListener("message", on); res(e.data); } };
    const t = setTimeout(() => { c.removeEventListener("message", on); res({ error: "no answer" }); }, ms);
    c.addEventListener("message", on);
    c.startMessages?.();
    w.postMessage(msg);
  });
}

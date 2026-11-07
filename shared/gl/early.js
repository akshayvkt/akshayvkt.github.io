// (DYS-203 start sooner) The live room's first files, asked for as soon as their names are known, not each one after
// the step before it. Until now the boot fetched them in a chain: room3d.json (shared/spots.js), then the engine's
// modules (engine.js, three, the loader, ...: three round trips deep), then bake.json, then light-tex.json, then the
// model, then its textures (once the model was parsed), then the static light maps (lamp, screen, detail: once the room
// was built), then the moment's light maps and probes (once all that was done). Here the router (bootLive) asks for
// all of them at once the moment room3d.json is in, while the engine's modules still load; each file is read whole
// here and handed, bytes untouched, to the one place in the engine that asks for it (takeEarly: loader.js fetchBytes,
// fitWhileLoading, fetchBitmap, lightTextures; engine.js bake.json and room3d.json), which decodes it exactly as it
// decodes a file it fetched itself. So the same files, the same requests (one each: nothing downloads twice), the same
// pixels; only sooner. A file this does not have, or that failed here, is fetched by its reader as before.
// One import, device.js (the router's own already: nothing more to download); three and the engine are not pulled in.
// ?earlyroom=0: none of it (the engine fetches everything itself, one step after another, as before).
// (DYS-203 phone bytes, ?phonetex=1 on the phone tier: the maps the phone would halve asked for as their 1024 copies
// (room3d/r1t1, scripts/live/phone_tex.py) in place of the originals, by the same rule the engine then uses
// (phoneCopies below, loader.js phoneTextures), so each map comes once, the copy or the original, never both)
import { phoneNow } from "../device.js";
const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
export const EARLY_ROOM = params.get("earlyroom") !== "0";
// (DYS-216 lane D, ?jslean=1, OFF by default: a file no reader follows as it comes in is read whole by the browser
// (Response.blob), not chunk by chunk here: TB1 (Chrome as a phone at CPU 6x, first visit) had this loop at 55-69 ms of
// the main thread before the room was shown, nearly all of it the ~190 maps and lists. The model alone keeps the loop, for
// the first visit's line (fetchBytes's progress). The same requests and the same bytes either way)
const JS_LEAN = params.get("jslean") === "1";

// url (absolute) -> { done: Promise<{ ok, status, blob } | null>, got, total, listeners: Set }
const files = new Map();
let closed = false;

/** Ask for a file now (read whole, its progress kept for a reader that wants it). Absolute or page-relative URL.
 *  progress: a reader will follow it as it comes in (the model); with ?jslean=1 only such a file is read in chunks here. */
export function earlyFetch(url, { priority, progress = false } = {}) {
  if (closed || typeof fetch === "undefined") return null;
  const href = new URL(url, location.href).href;
  if (files.has(href)) return files.get(href);
  // (DYS-203 review: a signal of its own, so earlyDone can stop it if no reader took it: a room refused after these were
  // asked for (engineSupport: no WebGL2, a software GPU, no float buffers) would otherwise download them all, ~5.6 MB,
  // for a visitor who keeps the photographs)
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const f = { got: 0, total: 0, listeners: new Set(), done: null, ctl };
  // (the same request as the readers': fetch's defaults, same-origin credentials, the browser's normal caching)
  const init = {};
  if (priority) init.priority = priority;
  if (ctl) init.signal = ctl.signal;
  f.done = fetch(href, Object.keys(init).length ? init : undefined).then(async (r) => {
    if (!r.ok) return { ok: false, status: r.status, blob: null };
    f.total = +r.headers.get("content-length") || 0;
    if (!r.body || !r.body.getReader) return { ok: true, status: r.status, blob: await r.blob() };
    if (JS_LEAN && !progress) {
      const blob = await r.blob();
      f.got = blob.size;
      for (const fn of f.listeners) { try { fn(f.got, f.total || f.got); } catch { /* a reader's own problem */ } }
      return { ok: true, status: r.status, blob };
    }
    const reader = r.body.getReader(), chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      f.got += value.length;
      for (const fn of f.listeners) { try { fn(f.got, f.total); } catch { /* a reader's own problem */ } }
    }
    return { ok: true, status: r.status, blob: new Blob(chunks, { type: r.headers.get("content-type") || "" }) };
  }).catch(() => null);
  files.set(href, f);
  return f;
}

/**
 * The file's bytes as a Blob if it was asked for here and came in whole (it is then let go: one reader each), else
 * null (the reader fetches it itself, as before). onProgress(got, total), when given, hears what has come in so far at
 * once and the rest as it comes (fetchBytes's own progress for the first visit's line).
 */
export async function takeEarly(url, onProgress = null) {
  const href = new URL(url, location.href).href;
  const f = files.get(href);
  if (!f) return null;
  files.delete(href);
  if (onProgress) { if (f.got) onProgress(f.got, f.total); f.listeners.add(onProgress); }
  const r = await f.done;
  f.listeners.clear();
  return r && r.ok && r.blob ? r.blob : null;
}

/** The boot is over (live or not): whatever no reader took is let go (and stopped if still coming in: DYS-203 review),
 *  and nothing more is asked for here. A file a reader took is its own: never stopped here. */
export function earlyDone() {
  closed = true;
  for (const f of files.values()) { try { f.ctl?.abort(); } catch { /* nothing to stop */ } }
  files.clear();
}

/** (QA, the static check) what is still waiting for its reader. */
export function earlyPending() { return [...files.keys()]; }

// a 1x1 AVIF through the same path textures take (createImageBitmap), once (loader.js lightTextures asks the same
// question: one answer for both, so the early textures are the copies the loader will use)
let avifP = null;
export function decodesAvif() {
  if (!avifP) {
    const b64 = "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAFAAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAHG1kYXQSAAoFGAAGBCAyCRgACiiihAAFSA==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    avifP = typeof createImageBitmap === "undefined" ? Promise.resolve(false)
      : createImageBitmap(new Blob([bytes], { type: "image/avif" })).then((b) => { const ok = b.width > 0; b.close?.(); return ok; }, () => false);
  }
  return avifP;
}

// ---- (DYS-203 phone bytes) on by default (?phonetex=0: off; rough): the phone's own copies of the maps it halves
// The size the phone tier keeps its maps at (engine.js phoneMemory.maxSize on T1; a copy is made for one size)
export const PHONE_MAX = 1024;
/** ?phonetex's arm: "1" (the default since Akshay's yes to (b), 1 Nov), "rough" (rough.json's q60 roughness maps too: a
 *  look change, parked) or null (?phonetex=0: the originals, as before). */
export function phoneTexMode() {
  const v = params.get("phonetex");
  return v === "0" ? null : v === "rough" ? v : "1";
}
/** The engine's phone tier with its maps halved (engine.js: tier T1, by ?tier= or phoneNow; phoneMemory on unless
 *  ?phonemem=0, kept for the visit in sessionStorage), read here before the engine exists. */
export function phoneHalves() {
  const tier = params.get("tier") || (phoneNow() ? "T1" : "T2");
  let pm = params.get("phonemem");
  if (pm === null) { try { pm = sessionStorage.getItem("sfw-phonemem"); } catch { /* storage blocked */ } }
  return tier === "T1" && pm !== "0";
}
/** The copies' manifests, beside the set (r1/bake.json -> room3d/r1t1/t1.json): t1.json; src, the served maps' own
 *  SHA-256s (assemble.py writes room3d/r1t1-src.json from the files the site serves); more, rough.json for "rough".
 *  Same-origin by construction (no URL parameter names another; the review's MEDIUM 3). */
export function phoneTexUrls(bakeUrl, rough = false) {
  const t1 = new URL("../r1t1/t1.json", bakeUrl).href;
  return { t1, src: new URL("../r1t1-src.json", bakeUrl).href, more: rough ? [new URL("rough.json", t1).href] : [] };
}
/**
 * The phone's copies as a map from each original's URL (the set's URI against bake.json's) to { url, full } (full: the
 * original's size, room.js settleInlays), or null: a manifest for another model or size, no copies, or no hash list.
 * A copy is used only when its source's SHA-256 (t1.json src_sha256, phone_tex.py) is the one the site serves at that
 * URI (r1t1-src.json): a map re-baked since the copies were made keeps its original (the review's MEDIUM 4).
 */
export function phoneCopies(bakeUrl, t1Url, man, extras, src, modelHash, maxSize) {
  if (!man || man.model_hash !== modelHash || man.max !== maxSize || !man.files) return null;
  if (!src || src.model_hash !== modelHash || !src.files) return null;
  const map = new Map();
  for (const m of [man, ...(extras || []).filter((x) => x && x.model_hash === modelHash && x.files)]) {
    for (const [uri, f] of Object.entries(m.files)) {
      if (!f || !f.file || !f.src_sha256 || src.files[uri] !== f.src_sha256) continue;
      map.set(new URL(uri, bakeUrl).href, { url: new URL(f.file, t1Url).href, full: f.full });
    }
  }
  return map.size ? map : null;
}

// Whether the loader reads the model's textures through takeEarly: its picture path (loader.js fitWhileLoading) runs
// where three's glTF loader decodes them as ImageBitmaps (GLTFLoader: createImageBitmap, not Safari before 17 nor Firefox
// before 98) and the decode workers are on (loader.js BMP_PAGE: not ?bmpworker=0, OffscreenCanvas there). Elsewhere the
// textures are not asked for here (an <img> path would ask again).
function texturesReadHere() {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined" || params.get("bmpworker") === "0") return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const safari = /^((?!chrome|android).)*safari/i.test(ua), sv = safari ? parseInt((ua.match(/Version\/(\d+)/) || [])[1], 10) : -1;
  const firefox = ua.indexOf("Firefox") > -1, fv = firefox ? parseInt((ua.match(/Firefox\/([0-9]+)\./) || [])[1], 10) : -1;
  return !(safari && !(sv >= 17)) && !(firefox && !(fv >= 98));
}

/**
 * The room's boot files, asked for in the engine's own order of need, all at once (router.js bootLive, once room3d.json
 * is in and the room will be tried): bake.json and light-tex.json; then, when they are in, the model, its textures (the
 * light copies the loader will map them to, only where the loader's picture path reads them from here: texturesReadHere),
 * the static light maps (lamp, screen, detail) and the boot moment's light maps and probes (moment(ids): its id, the
 * router's pickMoment). The same URLs the engine builds (engine.js _loadRoom, loader.js lightTextures, within()).
 * Returns the list of what it asked for (QA).
 */
export function earlyRoom(o = {}) {
  const dones = [];
  const p = askRoom(o, dones);
  // (DYS-203 fewer steps: app.js's call at the reveal, earlyBoot, then the router's own, which finds those asked for and
  // adds the moment's maps: in once every call's files are; one call, as before)
  const mine = p.catch(() => {}).then(() => Promise.allSettled(dones)).then(() => {});
  roomIn = roomIn ? Promise.all([roomIn, mine]).then(() => {}) : mine;
  return p;
}
// (DYS-203 HT1, handoff-tiles: the room's boot files all in) resolves once every file earlyRoom asked for has come in or
// failed; at once before earlyRoom is called, or when it asked for nothing (?earlyroom=0). The router starts the view
// outside's own files after it (router.js OUT_NET), so they no longer share the line with the room's
let roomIn = null;
export function earlyIn() { return roomIn || Promise.resolve(); }
async function askRoom({ bake, tex = null, room3d = "room3d.json", moment = null } = {}, dones = []) {
  if (!EARLY_ROOM || closed || !bake) return [];
  const asked = [];
  const ask = (u, o) => { const f = earlyFetch(u, o); if (f) { asked.push(new URL(u, location.href).href); dones.push(f.done); } };
  const bakeUrl = new URL(bake, location.href).href;
  const texUrl = tex ? new URL(tex, location.href).href : null;
  // (engine.js _loadRoom: the set's own room3d.json beside bake.json, r1/room3d.json: not the router's /room3d/room3d.json)
  if (room3d) ask(new URL(room3d, bakeUrl).href);
  const bkF = earlyFetch(bakeUrl);
  const texF = texUrl ? earlyFetch(texUrl) : null;
  for (const f of [bkF, texF]) if (f) dones.push(f.done);
  asked.push(bakeUrl);
  if (texUrl) asked.push(texUrl);
  // (DYS-203 phone bytes: on the phone tier unless ?phonetex=0, the copies' manifests too, beside bake.json's, the engine
  // takes them itself (loader.js phoneTextures))
  const ptMode = phoneTexMode() && phoneHalves() ? phoneTexMode() : null;
  const ptU = ptMode ? phoneTexUrls(bakeUrl, ptMode === "rough") : null;
  const ptF = ptU ? [ptU.t1, ptU.src, ...ptU.more].map((u) => { const f = earlyFetch(u); if (f) { asked.push(u); dones.push(f.done); } return f; }) : [];
  // read without taking: the engine takes these itself
  const json = async (f) => { const r = f && (await f.done); try { return r && r.ok ? JSON.parse(await r.blob.text()) : null; } catch { return null; } };
  const bk = await json(bkF);
  if (!bk || !bk.model) return asked;
  const within = (rel) => new URL(rel, bakeUrl).href;
  const modelUrl = within(bk.model);
  ask(modelUrl, { progress: true });   // (fetchBytes follows it for the first visit's line)
  // (DYS-203 phone bytes) a map the phone has a copy of: the copy's URL in place of the original's (or of its light-tex
  // copy), the URL the engine will ask for (loader.js loadModel's URL modifier, room.js layerTexture)
  let copyOf = (u) => u;
  if (ptU) {
    const [[man, src, ...extra], avif] = await Promise.all([Promise.all(ptF.map(json)), decodesAvif()]);
    const map = avif ? phoneCopies(bakeUrl, ptU.t1, man, extra, src, bk.model_hash, PHONE_MAX) : null;
    if (map) copyOf = (u) => map.get(u)?.url || u;
  }
  if (texturesReadHere() && texUrl) {
    const [man, avif] = await Promise.all([json(texF), decodesAvif()]);
    // (loader.js lightTextures' own test: this model's manifest, and a browser that decodes AVIF)
    if (man && man.model_hash === bk.model_hash && man.textures && avif) {
      const base = new URL(".", modelUrl).href;
      for (const [uri, t] of Object.entries(man.textures)) {
        const o = new URL(uri, base).href, c = copyOf(o);
        ask(c !== o ? c : new URL(t.file, texUrl).href);
      }
      // (the textures the manifest leaves out are read from the model's own files: tex/screen_base.jpg)
      for (const uri of Object.keys(man.left_out || {})) ask(copyOf(new URL(uri, base).href));
    }
  }
  const low = { priority: "low" };   // (the light maps after the model and its textures where the line honours it)
  const L = bk.layers || {};
  for (const set of [L.lamp, L.screen]) for (const e of Object.values(set || {})) if (e?.file) ask(copyOf(within(e.file)), low);
  if (L.detail?.file) ask(copyOf(within(L.detail.file)), low);
  const id = moment ? await Promise.resolve(moment(Object.keys(bk.moments || {}))).catch(() => null) : null;
  const m = id && bk.moments?.[id];
  if (m) {
    for (const spec of [m.ambient, m.sun]) for (const e of Object.values(spec || {})) if (e?.file) ask(copyOf(within(e.file)), low);
    for (const p of (m.probes || []).slice(0, 2)) { if (p.file) ask(within(p.file), low); if (p.lamp?.file) ask(within(p.lamp.file), low); }
  }
  return asked;
}

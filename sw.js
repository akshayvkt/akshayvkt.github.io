// The site's service worker: return visits without a round trip per file (DYS-203).
//
// Why: GitHub Pages sends every file with `cache-control: max-age=600`, and we cannot change that. Ten minutes after a
// visit the browser asks the host again about every file the next visit needs (one conditional request each, a round
// trip for each wave of files the boot discovers: the HTML, its scripts, their imports, room3d.json, the model and its
// textures, the window's tiles), although between two deploys almost none of them changed (8 to 46 of the first view's
// ~260 files, Deploys 3-11). This worker keeps the files of a visit's first view in Cache Storage, each filed under its
// content's hash, and hands them to the next visit with no request at all while the deploy being visited still has those
// exact bytes.
//
// How it knows, with no file renamed and nothing in the pages changed:
//   - every deploy publishes /sw-files.json (scripts/live/sw_files.py): each file a visit may load, with the first 10 hex
//     of its sha256 (the same 10 as build_dist.py's ?v= stamps);
//   - a page's address (a navigation) goes the browser's own way first, as without this worker (navigation preload:
//     asked for while this worker starts; within the host's 10 minutes from the HTTP cache, after them one conditional
//     request), and /sw-files.json the same way beside it (the two share the 10 minutes, so the list is never older
//     than the HTML; within them neither costs a request, after them the list costs one round trip beside the HTML's).
//     The page's HTML is hashed and looked up: the deploy whose list holds this exact HTML is the page's deploy, and the
//     page (its client id) is served from that one list, so a page never gets another deploy's file (no mixed versions,
//     also for modules whose own imports carry no stamp). The host's list is tried first, so a deploy that changed only
//     data or pictures under the same HTML is picked up as soon as the HTML would be;
//   - no request waits for that list: a page's requests that come before its deploy is known (the list still on its
//     way: after the 10 minutes a round trip, after a deploy its download, or a stalled one up to LIST_WAIT) go to the
//     network at once, exactly as without this worker; only the ones after it are served from the cache. The list's own
//     request is never cut off at LIST_WAIT (only the wait for it ends there): a cancelled revalidation costs the HTTP
//     cache its copy, and every later list was then a full download (RC-I: 44 KB 200s after a stalled list, not 304s);
//   - a same-origin frame (the laptop's screen: /projects/page/ in a frame of the room's page, its own document and
//     client) is its page's deploy, never one of its own: its navigation carries the embedding page's address (its
//     referrer), and the window clients at that address name the deploy (all the same one; else none). The frame's HTML
//     from the cache when that deploy lists it and it is stored (no wait for the host), else the network's, and then
//     the frame is that deploy only if those are the listed bytes; its files as the page's. Its page's deploy not known
//     yet (the list on its way): the frame and its requests the network's until it is, then the same rule; a list late
//     or stalled: nothing from storage for the frame either. The frame's first view is stored with its page's (the page
//     hands over the frame's Resource Timing too); its HTML, which Chrome keeps apart in its HTTP cache (a frame's
//     document), from the bytes this worker saw at the frame's navigation;
//   - a file the page's deploy lists, under a hash the cache holds: from the cache. Anything else (not listed, a ?v=
//     stamp other than the listed hash, not stored yet, a Range request, video, the zoom's 4x squares, the making-of
//     page, another origin, a request that asked for no cache, a page this worker could not place): the network, as if
//     there were no worker;
//   - nothing is stored while a page loads. Once its room is live and the hand-off over, the page (shared/sw-client.js)
//     sends the files it loaded; this worker copies them out of the browser's HTTP cache (cache "only-if-cached": never
//     a download; a file the cache no longer holds is skipped, stats.notCached), checks each against its listed hash
//     and files it. Kept: the files of each page's last two first views under the
//     last two deploys' lists; the rest is deleted then.
// Off switches: ?sw=0 on any address (that load comes from the network; this worker unregisters and deletes its caches);
// a deploy whose /sw-files.json says "off": true (every visitor's worker does the same at their next visit);
// scripts/live/sw-off.js published as /sw.js (a worker that only removes itself); shared/router.js SW_DEFAULT / SW_HOSTS
// (no new registrations: opt-in with ?sw=1 until SW_DEFAULT is true). The worker never asks a page to reload.
//
// Tests without a browser: scripts/live/sw_test.mjs (a stand-in Cache Storage, network and clients).

const LAYOUT = 1;                          // the caches' layout: another one gets new names and the old are deleted
const FILES = `sfw-files-${LAYOUT}`;       // one entry per (path, hash): /__sfw/f/<hash><path>
const META = `sfw-meta-${LAYOUT}`;         // the deploys' lists, the pages' deploys, the first views' file lists
const LIST_URL = "/sw-files.json";
const NAV_WAIT = 4000;     // ms: a page's HTML from the network, else that page as stored, if its deploy is the one published
const LIST_WAIT = 3000;    // ms: the network's list; when it is later than that, the page is served from the network
                           // as before (never a deploy older than the one published). No page request waits for it
const LIST_DROP = 30000;   // ms: a list request still unanswered is cancelled then (not at LIST_WAIT: see the top)
const BIND_WAIT = 50;      // ms: a page's deploy read back from this worker's notes (a worker restarted mid-visit); a
                           // request that would wait longer goes to the network
const KEEP_LISTS = 2;      // deploys whose files are kept
const KEEP_VISITS = 2;     // first views kept per page
const MAX_FILES = 800;     // files taken from one first view
const ROOM_BYTES = 64e6;   // bytes that must stay free in the site's quota before anything is copied
const GAP_MS = 12;         // ms between two copied files: the copy trickles behind the live room
const NEVER = /^\/(?:room3d\/zoom-l3|how-its-made|__sfw)\//;   // never through this worker (none of it in the list)
const VIDEO = /\.(?:mp4|webm|mov|m4v)$/i;

// (bound: a page's deploy, a promise; done: the same once settled, so a request can tell at once whether it is known;
// listWait: the pages whose deploy waits for the network's list; seen: frames' HTML as the network gave it, its hash
// its page's deploy's, for the next copy to file)
const mem = { lists: new Map(), net: null, bound: new Map(), done: new Map(), listWait: new Set(), none: new Set(),
  kept: new Set(), lastNav: null, seen: new Map() };
const NAV_MATCH_MS = 10000;   // ms: a browser without resultingClientId: a new page's first requests find its navigation by address
// (notCached: files a copy skipped because the HTTP cache no longer held them, or the engine refused only-if-cached;
// copyBad: the cache held other bytes than the listed ones. quotaMB / usageMB: navigator.storage.estimate() at the last
// copy. No API says whether the storage is in memory (Safari's private windows): a small quota is the only hint)
// (early: a page's requests sent to the network because its deploy was not known yet: its list still on the way.
// frames: same-origin frames' navigations; frameStored: of them, the HTML from the cache (also counted in hit);
// frameNone: frames left to the network, no page or no single deploy found for them)
const stats = { layout: LAYOUT, navs: 0, navStored: 0, hit: 0, miss: 0, pass: 0, early: 0, err: 0, bound: 0, unbound: 0, copied: 0,
  copyBad: 0, notCached: 0, pruned: 0, off: "", quotaMB: null, usageMB: null, frames: 0, frameStored: 0, frameNone: 0 };
// each page's own counters (its client id; the stats message answers a page with its own as "mine": the analytics
// beacon's served-from-storage count, shared/beacon.js sw_hit): page 1 = its HTML from storage
const counts = new Map();
function count(cid, k) {
  if (!cid) return;
  let c = counts.get(cid);
  if (!c) {
    counts.set(cid, (c = { hit: 0, miss: 0, pass: 0, early: 0, page: 0 }));
    if (counts.size > 300) counts.delete(counts.keys().next().value);
  }
  c[k]++;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const own = (u) => new URL(u, self.location.origin).href;
const listKey = (build) => own(`/__sfw/list/${build}`);
const clientKey = (id) => own(`/__sfw/client/${encodeURIComponent(id)}`);
const VISITS = "/__sfw/visits";
const keyOf = (path, h) => own(`/__sfw/f/${h}${path}`);
const fileOf = (pathname) => {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch { /* as written */ }
  return p.endsWith("/") ? `${p}index.html` : p;
};
// a ?v= stamp (build_dist.py: the first 10 hex of the file's sha256) must name the listed bytes
const stampFits = (url, h) => { const v = url.searchParams.get("v"); return !v || !/^[0-9a-f]{10}$/.test(v) || v === h; };
const cacheable = (url) => !NEVER.test(url.pathname) && !VIDEO.test(url.pathname) && url.pathname !== LIST_URL && url.pathname !== "/sw.js";

async function sha10(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let s = "";
  for (let i = 0; i < 5; i++) s += d[i].toString(16).padStart(2, "0");
  return s;
}

/** A deploy's list as published ({ v, build, dirs: { "/shared/": { "router.js": hash } } }), flattened by path. */
function expand(raw, text) {
  if (!raw || raw.v !== 1 || typeof raw.build !== "string" || !/^[\w-]{4,64}$/.test(raw.build) || !raw.dirs || typeof raw.dirs !== "object") return null;
  const files = Object.create(null);
  for (const [d, names] of Object.entries(raw.dirs)) for (const [n, h] of Object.entries(names)) files[d + n] = h;
  return { build: raw.build, files, text };
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("sfw-") && k !== FILES && k !== META) await caches.delete(k);
  try { await self.registration.navigationPreload?.enable(); } catch { /* not supported: the HTML waits for this worker */ }
})()));

self.addEventListener("fetch", (event) => {
  if (stats.off) return;
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // (a page's address: whatever goes wrong in here, the page from the network as without this worker)
  if (req.mode === "navigate") { event.respondWith(navigate(event, url).catch(() => fetch(req))); return; }
  if (!cacheable(url) || req.headers.get("range")) return;
  if (req.cache === "no-store" || req.cache === "no-cache" || req.cache === "reload") return;   // the page asked the network
  const cid = event.clientId;
  if (!cid || mem.none.has(cid)) return;   // a page this worker could not place: the browser's own way, untouched
  // (the page's deploy waiting for the network's list: this request the browser's own way, now; never a wait)
  if (mem.listWait.has(cid) && !mem.done.has(cid)) { stats.early++; count(cid, "early"); return; }
  event.respondWith(serve(event, url, cid));
});

/** The page's deploy: known (settled), or read back from this worker's notes within BIND_WAIT; undefined: not yet. */
function boundNow(cid) {
  if (mem.done.has(cid)) return mem.done.get(cid);
  return Promise.race([boundTo(cid), wait(BIND_WAIT).then(() => undefined)]);
}

async function serve(event, url, cid) {
  try {
    const build = await boundNow(cid);
    if (build === undefined) { stats.early++; count(cid, "early"); return fetch(event.request); }
    const list = build && (await listOf(build));
    const path = fileOf(url.pathname), h = list && list.files[path];
    if (build) bindWorker(event, build);
    if (h && stampFits(url, h)) {
      const hit = await (await caches.open(FILES)).match(keyOf(path, h), { ignoreVary: true });
      if (hit) { stats.hit++; count(cid, "hit"); return hit; }
      stats.miss++; count(cid, "miss");
    } else { stats.pass++; count(cid, "pass"); }
  } catch { stats.err++; }
  return fetch(event.request);
}

// a worker the page starts (its script asked for by the page) belongs to the page's deploy too
function bindWorker(event, build) {
  const d = event.request.destination;
  if ((d === "worker" || d === "sharedworker") && event.resultingClientId) setBound(event.resultingClientId, build);
}

async function navigate(event, url) {
  stats.navs++;
  const cid = event.resultingClientId || "";
  // (the network's answer: navigation preload's, else a fetch; asked for only when used, so a frame served from the
  // cache sends nothing more than the preload the browser sent already)
  let netP = null;
  const net = () => netP || (netP = Promise.resolve(event.preloadResponse).then((r) => r || fetch(event.request)));
  if (url.searchParams.get("sw") === "0") {
    if (cid) setBound(cid, null);
    net().catch(() => {});
    event.waitUntil(turnOff("?sw=0"));
    return net();
  }
  const path = fileOf(url.pathname);
  const dest = event.request.destination;
  if (dest === "iframe" || dest === "frame") return frameNav(event, path, cid, net);
  const htmlP = net();
  const listP = netList();
  const first = await Promise.race([htmlP.then((r) => ({ r }), (e) => ({ e })), wait(NAV_WAIT).then(() => ({ late: true }))]);
  if (first.r) {
    const bind = bindPage(first.r.clone(), path, listP).catch(() => null);
    if (cid) { setBound(cid, bind, true); event.waitUntil(bind.then((b) => keepBound(cid, b)).catch(() => {})); }
    else {
      const n = { url: noHash(event.request.url), at: Date.now(), bind, done: false };
      bind.then(() => { n.done = true; });
      mem.lastNav = n;
      event.waitUntil(bind);
    }
    return first.r;
  }
  // no answer in NAV_WAIT (or none at all): the page from storage, but only as a deploy the host still publishes. The
  // network's list (asked for beside the HTML; settled by now, LIST_WAIT < NAV_WAIT) names that deploy: its HTML for
  // this page, when stored. Only when the list cannot be reached either (offline) the newest stored deploy's page. A
  // list naming a deploy whose page is not stored, a late list, no list: the network's page, as without this worker
  // (a slow line never brings back an older deploy, whose files not stored would then come from the newer one)
  const stored = await storedPage(path, await listP).catch(() => null);
  if (stored) {
    stats.navStored++;
    count(cid, "page");
    if (cid) { setBound(cid, stored.build); event.waitUntil(keepBound(cid, stored.build).catch(() => {})); }
    else mem.lastNav = { url: noHash(event.request.url), at: Date.now(), bind: Promise.resolve(stored.build), done: true };
    net().catch(() => {});
    return stored.res;
  }
  if (cid) setBound(cid, null);
  return net();   // the network after all: it may still answer, or fail as it would without this worker
}

/** A same-origin frame's navigation (the laptop's screen): the frame is the deploy of the page that embeds it. That
 *  deploy known (the usual case: the page's list came long before its laptop's screen): the frame's HTML as that
 *  deploy lists it, from the cache, no wait for the host; not stored, the network's, and the frame that deploy only if
 *  these are its listed bytes (else none: the frame the network's, as without this worker). Not known yet (its list on
 *  the way): the network's HTML, the frame's requests the network's until the page's deploy is known, then the same
 *  check. No page found, or pages of more than one deploy at its address: the network, the frame none. */
async function frameNav(event, path, cid, net) {
  stats.frames++;
  if (!cid) { stats.frameNone++; return net(); }   // (a browser without resultingClientId: its requests find no deploy)
  const parent = parentBuild(event.request, cid);
  const now = await Promise.race([parent, wait(BIND_WAIT).then(() => undefined)]);
  if (now === null) { stats.frameNone++; setBound(cid, null); return net(); }
  if (now) {
    const list = await listOf(now), h = list && list.files[path];
    const stored = h && (await (await caches.open(FILES)).match(keyOf(path, h), { ignoreVary: true }));
    if (stored) {
      stats.hit++; stats.frameStored++;
      count(cid, "page");
      setBound(cid, now);
      // (the browser's own preload of this address, sent already: let it end, unused)
      event.waitUntil(Promise.all([keepBound(cid, now), Promise.resolve(event.preloadResponse)]).catch(() => {}));
      return stored;
    }
  }
  const res = await net();
  const bind = frameBind(res.clone(), path, now ? Promise.resolve(now) : parent).catch(() => null);
  setBound(cid, bind, true);
  event.waitUntil(bind.then((b) => { if (!b) stats.frameNone++; return keepBound(cid, b); }).catch(() => {}));
  return res;
}

/** The deploy of the page a frame's navigation comes from: the window clients (controlled or not) at its referrer's
 *  address, the embedding page's (a same-origin frame's navigation carries its full address). One deploy when every
 *  page there has that same one; null: no referrer, no page there, pages of different deploys or one not placed. */
async function parentBuild(req, cid) {
  const ref = sameOrigin(req.referrer || "");
  if (!ref) return null;
  const at = noHash(ref);
  const pages = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((c) => c.id !== cid && c.url && noHash(c.url) === at);
  if (!pages.length) return null;
  const bs = await Promise.all(pages.map((c) => boundTo(c.id)));
  return bs.every((b) => b && b === bs[0]) ? bs[0] : null;
}

/** A frame's HTML from the network: its page's deploy when these are the bytes that deploy lists for it (kept for the
 *  next copy to file: Chrome keeps a frame's document apart in its HTTP cache, out of only-if-cached's reach), else null. */
async function frameBind(res, path, parentP) {
  if (res.status !== 200 || res.type !== "basic" || res.redirected) return null;
  const buf = await res.arrayBuffer();
  const h = await sha10(buf);
  const b = await parentP;
  const list = b && (await listOf(b));
  if (!list || list.files[path] !== h) return null;
  mem.seen.set(keyOf(path, h), { path, h, buf, type: res.headers.get("content-type") || "text/html" });
  if (mem.seen.size > 8) mem.seen.delete(mem.seen.keys().next().value);
  return b;
}

/** The deploy of a page's HTML: the list that holds its exact hash (the network's first), or null. */
async function bindPage(res, path, listP) {
  if (res.status !== 200 || res.type !== "basic" || res.redirected) return null;
  const h = await sha10(await res.arrayBuffer());
  const got = await listP;
  return deployOf(path, h, got);
}

async function deployOf(path, h, got) {
  if (got.off) { await turnOff("the deploy's list"); return null; }
  if (got.list && got.list.files[path] === h) { await keepList(got.list); return got.list.build; }
  // the network's list could not be read: the stored lists only when the line is down (offline), never when it is
  // slow or the deploy has no list (that could be a deploy the stored lists do not know)
  if (!got.list && !got.offline) return null;
  // (the HTML can be a deploy older than the network's list: a copy the HTTP cache still holds; its own list then)
  for (const l of await storedLists()) if (l.files[path] === h) return l.build;
  return null;
}

/** The network's list, or { late } after LIST_WAIT. The request itself goes on (until LIST_DROP): cancelled at
 *  LIST_WAIT, a revalidation cost the HTTP cache its copy of the list, so each later visit downloaded it whole (RC-I's
 *  stalled-list visits: 44 KB 200s, where a 304 does); answered late, it refreshes that copy and this worker's. */
function netList() {
  return Promise.race([readNetList(), wait(LIST_WAIT).then(() => ({ late: true }))]);
}

async function readNetList() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LIST_DROP);
  try {
    // (the HTTP cache's way, as the HTML's: "no-cache" would cost a round trip on every return within the 10 minutes,
    // which today ask the host nothing)
    const r = await fetch(LIST_URL, { signal: ctl.signal });
    if (!r.ok) return { none: r.status };
    // (the list in memory reused only for the same bytes, its text compared: never on headers, which a host may not
    // send, and never on a length, which a data-only deploy's list keeps: C's review, LOW 5)
    const text = await r.text();
    if (mem.net && text === mem.net.text) return { list: mem.net };
    const raw = JSON.parse(text);
    if (raw && raw.off === true) return { off: true };
    const list = expand(raw, text);
    if (!list) return { none: "unreadable" };
    mem.net = list; mem.lists.set(list.build, list);
    return { list };
  } catch (e) {
    return ctl.signal.aborted ? { late: true } : e instanceof SyntaxError ? { none: "unreadable" } : { offline: true };
  } finally { clearTimeout(t); }
}

async function keepList(list) {
  if (mem.kept.has(list.build) || stats.off) return;
  const meta = await caches.open(META);
  if (!(await meta.match(listKey(list.build)))) {
    await meta.put(listKey(list.build), new Response(list.text, { headers: { "content-type": "application/json", "x-seen": String(Date.now()) } }));
  }
  mem.kept.add(list.build);
}

/** The stored deploys' lists, the most recently first seen first. One read at a time: the burst of requests that
 *  follows a worker's restart (Chrome stops an idle worker after 30 s, Safari sooner) shares it, so each list is read
 *  and parsed once, not once per request. */
let storedRead = null;
function storedLists() {
  if (!storedRead) storedRead = readStoredLists().finally(() => { storedRead = null; });
  return storedRead;
}

async function readStoredLists() {
  const meta = await caches.open(META);
  const out = [];
  for (const req of await meta.keys()) {
    const m = /\/__sfw\/list\/([\w-]+)$/.exec(req.url);
    if (!m) continue;
    const r = await meta.match(req);
    if (!r) continue;
    let l = mem.lists.get(m[1]);
    if (!l) {
      const text = await r.text();
      try { l = expand(JSON.parse(text), text); } catch { l = null; }
      if (!l) continue;
      mem.lists.set(l.build, l);
    }
    out.push({ l, seen: +(r.headers.get("x-seen") || 0) });
  }
  return out.sort((a, b) => b.seen - a.seen).map((x) => x.l);
}

async function listOf(build) {
  return mem.lists.get(build) || (await storedLists()).find((l) => l.build === build) || null;
}

/** A page's stored HTML: the network's list's deploy, or (that list unreachable: offline) the newest stored one's. */
async function storedPage(path, got) {
  if (got.off) { await turnOff("the deploy's list"); return null; }
  const files = await caches.open(FILES);
  const lists = got.list ? [got.list] : got.offline ? await storedLists() : [];
  for (const l of lists) {
    const h = l.files[path];
    const res = h && (await files.match(keyOf(path, h), { ignoreVary: true }));
    if (res) { if (got.list) await keepList(l); return { res, build: l.build }; }
  }
  return null;
}

// list: p waits for the network's list (a navigation's bind): until it settles the page's requests go to the network
function setBound(cid, p, list = false) {
  p = Promise.resolve(p);
  mem.bound.set(cid, p);
  mem.done.delete(cid);
  if (list) mem.listWait.add(cid); else mem.listWait.delete(cid);
  const settle = (b) => { if (mem.bound.get(cid) === p) { mem.done.set(cid, b || null); mem.listWait.delete(cid); } };
  p.then((b) => { settle(b); if (b) { mem.none.delete(cid); stats.bound++; } else { mem.none.add(cid); stats.unbound++; } },
    () => { settle(null); mem.none.add(cid); });
  if (mem.bound.size > 300) { const k = mem.bound.keys().next().value; mem.bound.delete(k); mem.done.delete(k); mem.listWait.delete(k); mem.none.delete(k); }
  return p;
}

function boundTo(cid) {
  return mem.bound.get(cid) || setBound(cid, readBound(cid));
}

async function readBound(cid) {
  const r = await (await caches.open(META)).match(clientKey(cid));
  if (r) return (await r.text()) || null;
  // (a navigation without resultingClientId, a browser that does not give one: the page whose address it was, asking
  // within NAV_MATCH_MS of it, is that navigation's page)
  const n = mem.lastNav;
  if (!n || Date.now() - n.at > NAV_MATCH_MS) return null;
  const c = await self.clients.get(cid).catch(() => null);
  if (!c || noHash(c.url) !== n.url) return null;
  if (!n.done && mem.bound.has(cid)) mem.listWait.add(cid);   // (its navigation still waits for the list: as above)
  const b = await n.bind;
  if (b) await keepBound(cid, b);
  return b;
}
const noHash = (u) => u.split("#")[0];
const sameOrigin = (u) => { try { const x = new URL(u); return x.origin === self.location.origin ? x.href : ""; } catch { return ""; } };

async function keepBound(cid, build) {
  if (build && !stats.off) await (await caches.open(META)).put(clientKey(cid), new Response(build));
}

async function turnOff(why) {
  if (stats.off) return;
  stats.off = why;
  mem.bound.clear(); mem.done.clear(); mem.listWait.clear(); mem.lists.clear(); mem.net = null; mem.kept.clear(); mem.seen.clear();
  for (const k of await caches.keys()) if (k.startsWith("sfw-")) await caches.delete(k);
  try { await self.registration.unregister(); } catch { /* already */ }
}

self.addEventListener("message", (event) => {
  const d = event.data || {}, src = event.source;
  const reply = (m) => { try { src?.postMessage(m); } catch { /* the page went */ } };
  if (d.type === "stats") reply({ type: "sfw-stats", ...stats, lists: [...mem.lists.keys()], mine: (src && counts.get(src.id)) || null });
  else if (d.type === "off") event.waitUntil(turnOff("the page").then(() => reply({ type: "sfw-off" })));
  else if (d.type === "copy" && src && !stats.off) {
    event.waitUntil(copy(src, d).then((r) => reply({ type: "sfw-copied", ...r }),
      (e) => reply({ type: "sfw-copied", error: String(e?.message || e) })));
  }
});

/** A page's first view, copied from the HTTP cache: its files that its deploy lists, each checked against its hash. */
async function copy(client, d) {
  const t0 = Date.now();
  // the address the page was loaded from (sw-client: its navigation entry). Not the tab's address now: router.js
  // rewrites that at the boot (an essay's /?writing=<slug> -> /writing/<slug>, /?page=books -> /books/), and the
  // rewritten one names another HTML or none, so a first visit landing there stored nothing
  const doc = sameOrigin(d.doc) || client.url;
  let build = await boundTo(client.id);
  if (!build) {
    // (a first visit: the page is not this worker's; its HTML from the HTTP cache tells its deploy)
    const found = await deployOfUrl(doc);
    if (!found.build) return { build: null, why: found.why };
    build = found.build;
    setBound(client.id, build);
    await keepBound(client.id, build);
  }
  const list = await listOf(build);
  if (!list) return { build, why: "the deploy's list is gone" };
  // (the off switch may come while a copy runs, ?sw=0 or a deploy's list in another tab: from then on the copy writes
  // nothing, so no cache is made again under a removed worker: C's review, LOW 6. Checked before each write below)
  const offNow = () => (stats.off ? { build, copied: 0, why: `off: ${stats.off}` } : null);
  if (offNow()) return offNow();
  const want = new Map();
  for (const u of [doc, ...(Array.isArray(d.urls) ? d.urls : [])]) {
    let url;
    try { url = new URL(u, self.location.origin); } catch { continue; }
    if (url.origin !== self.location.origin || !cacheable(url)) continue;
    const path = fileOf(url.pathname), h = list.files[path];
    if (!h || !stampFits(url, h) || want.has(path)) continue;
    url.hash = "";
    want.set(path, { url: url.href, h });
    if (want.size >= MAX_FILES) break;
  }
  // (a frame's HTML this worker saw, under this deploy's hash: part of this page's first view; see frameBind)
  for (const s of mem.seen.values()) if (list.files[s.path] === s.h && !want.has(s.path) && want.size < MAX_FILES) want.set(s.path, { url: own(s.path), h: s.h });
  await rememberVisit(typeof d.page === "string" ? d.page : new URL(client.url).pathname, [...want.keys()]);
  try {
    const est = await self.navigator.storage?.estimate?.();
    if (est?.quota) { stats.quotaMB = Math.round(est.quota / 1e6); stats.usageMB = Math.round((est.usage || 0) / 1e6); }
    if (est?.quota && est.quota - (est.usage || 0) < ROOM_BYTES) return { build, listed: want.size, copied: 0, why: "no room" };
  } catch { /* unknown: go on; a full quota stops the copy below */ }
  const files = await caches.open(FILES);
  const have = new Set((await files.keys()).map((r) => r.url));
  let copied = 0, already = 0, bad = 0, notCached = 0, bytes = 0, why;
  for (const [path, { url, h }] of want) {
    const key = keyOf(path, h);
    if (have.has(key)) { already++; mem.seen.delete(key); continue; }
    let got = await take(url, h);
    const saw = got === null && mem.seen.get(key);   // (a frame's HTML: not in reach of only-if-cached; its bytes as seen)
    if (saw) got = { buf: saw.buf.slice(0), type: saw.type };
    if (got === null) { notCached++; continue; }       // (not in the HTTP cache: not stored; never fetched)
    if (!got) { bad++; continue; }                     // (the cache's bytes are not the listed ones: not stored)
    if (stats.off) { why = `off: ${stats.off}`; break; }
    try {
      // (its type: a module script needs its JS type; its length: shared/gl/loader.js fills the loading line's
      // progress from content-length)
      await files.put(key, new Response(got.buf, { headers: { "content-type": got.type, "content-length": String(got.buf.byteLength) } }));
    } catch (e) { why = `stopped: ${e?.name || e}`; break; }
    copied++; bytes += got.buf.byteLength;
    if (saw) mem.seen.delete(key);
    await wait(GAP_MS);
  }
  stats.copied += copied; stats.copyBad += bad; stats.notCached += notCached;
  if (!why && !copied && notCached && notCached === want.size - already) {
    why = "only-if-cached gave no file (the HTTP cache dropped them all, or this engine refuses it)";
  }
  if (stats.off && !why) why = `off: ${stats.off}`;
  const pruned = stats.off ? 0 : await prune().catch(() => 0);
  return { build, listed: want.size, copied, already, bad, notCached, bytes, pruned, ms: Date.now() - t0,
    quotaMB: stats.quotaMB, usageMB: stats.usageMB, ...(why ? { why } : {}) };
}

// A file from the browser's HTTP cache only, never the network (the copy must never cost a visitor's data): cache
// "only-if-cached", which requires mode "same-origin". null: the cache does not hold it, or this engine refuses
// only-if-cached (a TypeError, or a 504-style answer); false: the cache holds bytes other than the listed ones.
async function cached(url) {
  let r;
  try { r = await fetch(url, { cache: "only-if-cached", mode: "same-origin" }); } catch { return null; }
  if (r.status !== 200 || r.redirected) { if (r.body) r.body.cancel().catch(() => {}); return null; }
  return r;
}

async function take(url, h) {
  const r = await cached(url);
  if (!r) return null;
  try {
    const buf = await r.arrayBuffer();
    return (await sha10(buf)) === h ? { buf, type: r.headers.get("content-type") || "application/octet-stream" } : false;
  } catch { return null; }
}

/** A first visit's deploy: its HTML from the HTTP cache only (as take()), looked up in the deploy's list (the one
 *  request a copy may make: the list, ~40 KB gzipped once per deploy, without which nothing can be checked). */
async function deployOfUrl(href) {
  const u = new URL(href);
  u.hash = "";
  const r = await cached(u.href);
  if (!r) { stats.notCached++; return { why: "the page's HTML is not in the HTTP cache (or this engine refuses only-if-cached)" }; }
  const h = await sha10(await r.arrayBuffer());
  const build = await deployOf(fileOf(u.pathname), h, await netList());
  return build ? { build } : { why: "no deploy's list holds this page" };
}

async function readVisits() {
  const r = await (await caches.open(META)).match(own(VISITS));
  try { return r ? await r.json() : {}; } catch { return {}; }
}

async function rememberVisit(page, paths) {
  if (stats.off) return;
  const v = await readVisits();
  const runs = [paths, ...(v[page] || [])].slice(0, KEEP_VISITS);
  // (the page visited now goes last, so the cap below drops the least recently visited, not the first ever: "/" was
  // dropped first however recent: C's review, LOW 7)
  delete v[page];
  v[page] = runs;
  const pages = Object.keys(v);
  if (pages.length > 12) for (const p of pages.slice(0, pages.length - 12)) delete v[p];
  await (await caches.open(META)).put(own(VISITS), new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } }));
}

/** Keeps the last KEEP_LISTS deploys' lists, the files of the remembered first views under them, live pages' deploys. */
async function prune() {
  const meta = await caches.open(META), files = await caches.open(FILES);
  const lists = await storedLists();
  for (const l of lists.slice(KEEP_LISTS)) { await meta.delete(listKey(l.build)); mem.lists.delete(l.build); mem.kept.delete(l.build); }
  const visits = await readVisits();
  const keep = new Set();
  for (const l of lists.slice(0, KEEP_LISTS)) {
    for (const runs of Object.values(visits)) for (const run of runs) for (const p of run) if (l.files[p]) keep.add(keyOf(p, l.files[p]));
  }
  let n = 0;
  for (const req of await files.keys()) if (!keep.has(req.url)) { await files.delete(req); n++; }
  const live = new Set((await self.clients.matchAll({ includeUncontrolled: true, type: "all" })).map((c) => c.id));
  for (const req of await meta.keys()) {
    const m = /\/__sfw\/client\/([^/?#]+)$/.exec(req.url);
    if (m && !live.has(decodeURIComponent(m[1]))) await meta.delete(req);
  }
  stats.pruned += n;
  return n;
}

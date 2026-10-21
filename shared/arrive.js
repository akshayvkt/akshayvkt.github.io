// Runs in <head> on every page (classic and blocking: <script src="/shared/arrive.js"></script>), before the
// first paint. It sets up how one page hands over to the next:
//   - opts the page into cross-document view transitions (here rather than in a stylesheet, so a cold cache
//     can't leave the rule unloaded when the transition starts);
//   - after the homepage's zoom into an object (shared/transition.js zoomTo), shows that page's photograph
//     from the very first paint exactly where the zoom left it, so the arrival is one continuous picture;
//   - header links between the rooms turn the head: the next room slides in from the side it is on (the shelf
//     is left of the laptop, the laptop left of the window, the print right of it), with no double exposure.
// Reduced motion: no transitions at all.
(function () {
  var root = document.documentElement;
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var norm = function (p) { return p.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/"; };
  var css =
    "@view-transition{navigation:auto}" +
    "@media (prefers-reduced-motion:reduce){@view-transition{navigation:none}}" +
    "::view-transition-group(masthead){animation-duration:.42s}" +
    // the zoom: both sides show the same photograph in the same place; only the page around it appears
    "html:active-view-transition-type(zoom)::view-transition-old(root){animation:none}" +
    "html:active-view-transition-type(zoom)::view-transition-new(root){animation:sky-vt-in .22s ease .09s both}" +
    // turning the head: the old room slides out one way while the next slides in from the other, edge to edge
    "html:active-view-transition-type(turn-left)::view-transition-old(root),html:active-view-transition-type(turn-right)::view-transition-old(root)," +
    "html:active-view-transition-type(turn-left)::view-transition-new(root),html:active-view-transition-type(turn-right)::view-transition-new(root)" +
    "{mix-blend-mode:normal;animation-duration:.46s;animation-timing-function:cubic-bezier(.62,0,.32,1);animation-fill-mode:both}" +
    "html:active-view-transition-type(turn-left)::view-transition-old(root){animation-name:sky-vt-out-r}" +
    "html:active-view-transition-type(turn-left)::view-transition-new(root){animation-name:sky-vt-in-l}" +
    "html:active-view-transition-type(turn-right)::view-transition-old(root){animation-name:sky-vt-out-l}" +
    "html:active-view-transition-type(turn-right)::view-transition-new(root){animation-name:sky-vt-in-r}" +
    "@keyframes sky-vt-in{from{opacity:0}}" +
    "@keyframes sky-vt-out-r{to{transform:translateX(100%);filter:blur(12px)}}" +
    "@keyframes sky-vt-out-l{to{transform:translateX(-100%);filter:blur(12px)}}" +
    "@keyframes sky-vt-in-l{from{transform:translateX(-100%);filter:blur(12px)}}" +
    "@keyframes sky-vt-in-r{from{transform:translateX(100%);filter:blur(12px)}}" +
    // arriving through the zoom: the photograph the zoom ended on, until the page's own room is up
    "html.has-arrive .room{background:none}html.has-arrive .room-stage>img.lqip{visibility:hidden}" +
    "html.zoom-in.has-arrive body::before{content:'';position:absolute;left:0;top:0;width:100%;height:var(--arrive-hh);z-index:0;pointer-events:none;" +
    "background:var(--arrive-src) no-repeat var(--arrive-x) var(--arrive-y)/var(--arrive-w) var(--arrive-h)}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var rec = null;
  try { rec = JSON.parse(sessionStorage.getItem("sky-zoom") || "null"); } catch (e) { /* storage blocked */ }
  var here = norm(location.pathname);
  var zoomIn = !!(rec && !rec.arrived && Date.now() - rec.t < 5000 && norm(rec.to) === here && !reduced);
  if (zoomIn) {
    root.classList.add("zoom-in");
    var g = rec.geo;
    if (g && rec.src && rec.box && Math.abs(rec.box.w - root.clientWidth) < 2) {
      root.classList.add("has-arrive");
      var set = function (k, v) { root.style.setProperty(k, v); };
      set("--arrive-src", 'url("' + rec.src + '")');
      set("--arrive-x", g.ix + "px"); set("--arrive-y", g.top + "px");
      set("--arrive-w", g.iw + "px"); set("--arrive-h", g.h + "px");
      set("--arrive-hh", rec.box.h + "px");
    }
    // never hold a page back for long, whatever happens to the scripts
    setTimeout(function () { root.classList.remove("zoom-in", "has-arrive"); }, 4000);
  }

  // How it's made (/how-its-made/) is a plain page, outside the dissolve: leaving for it, the transition is skipped here,
  // so none is handed to a page that would only abort it; the skip's own rejections are caught
  addEventListener("pageswap", function (e) {
    var vt = e.viewTransition, to = e.activation && e.activation.entry && e.activation.entry.url, quiet = function () {};
    if (!vt || !to || !/^\/how-its-made(\/|$)/.test(new URL(to).pathname)) return;
    if (vt.ready && vt.ready.catch) vt.ready.catch(quiet);
    if (vt.finished && vt.finished.catch) vt.finished.catch(quiet);
    if (vt.updateCallbackDone && vt.updateCallbackDone.catch) vt.updateCallbackDone.catch(quiet);
    vt.skipTransition();
  });

  // Where each room is, left to right, seen from the desk chair.
  var BEARING = { "/books": -2, "/projects": -1, "/": 0, "/quotes.html": 1 };
  addEventListener("pagereveal", function (e) {
    var vt = e.viewTransition;
    if (!vt) return;
    if (reduced || !vt.types) { vt.skipTransition(); return; }
    if (zoomIn) { vt.types.add("zoom"); return; }
    var from = null;
    try { from = navigation.activation.from ? norm(new URL(navigation.activation.from.url).pathname) : null; } catch (err) { /* no Navigation API */ }
    // back on the page we zoomed from: it plays the zoom in reverse itself (transition.js arrive)
    if (rec && from && norm(rec.to) === from && norm(rec.from) === here) { vt.types.add("zoom"); return; }
    var a = from === null ? undefined : BEARING[from], b = BEARING[here];
    if (a === undefined || b === undefined || a === b) { vt.skipTransition(); return; }
    vt.types.add(b < a ? "turn-left" : "turn-right");
  });
})();

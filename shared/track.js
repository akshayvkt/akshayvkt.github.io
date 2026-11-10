// Mixpanel's page view (release 27b-mp, D 10 Nov; Akshay: "use mixpanel", live now; coordinator: step 1 of the
// analytics, the behaviour events follow as their own release): the official snippet and one page view on load
// (track_pageview: Mixpanel's $mp_web_page_view, with the address and the referrer) to the project
// "akshaychintalapati.com" (4082519). Nothing else: no events of ours, no hooks. Google Analytics stays as it is.
// Every page the GA tag is on loads this file (scripts/deploy/build_dist.py --track), a module (deferred: never
// blocking the page). Mixpanel's library (self-hosted: web/vendor/mixpanel-browser-2.84.0) after the page's load event,
// at idle (LOAD_LATEST at the latest), only on the site's own host and never in a test browser (navigator.webdriver):
// a stage, a smoke test or a dev page sends Mixpanel nothing. Every setting but the page view is Mixpanel's default
// (no autocapture, no session replay, IP geolocation). ?debug: the state in window.__sfwTrack.
export const MP_TOKEN = "180ee2d7577d74e8fbaa48abce62ceac";   // the project's public token (client-side by design)
export const MP_LIB = "/vendor/mixpanel-browser-2.84.0/mixpanel.min.js";
export const MP_HOSTS = ["akshaychintalapati.com", "www.akshaychintalapati.com"];
export const LOAD_LATEST = 6000;     // ms: the library is asked for by then even if the page's load event is late

// the official snippet (mixpanel-browser 2.84.0's dist/mixpanel-jslib-snippet.min.js, unchanged): the stub that queues
// calls until the library (MIXPANEL_CUSTOM_LIB_URL: our copy) has loaded
function snippet() {
  (function(e,c){if(!c.__SV){var l,h;window.mixpanel=c;c._i=[];c.init=function(q,r,f){function t(d,a){var g=a.split(".");2==g.length&&(d=d[g[0]],a=g[1]);d[a]=function(){d.push([a].concat(Array.prototype.slice.call(arguments,0)))}}var b=c;"undefined"!==typeof f?b=c[f]=[]:f="mixpanel";b.people=b.people||[];b.toString=function(d){var a="mixpanel";"mixpanel"!==f&&(a+="."+f);d||(a+=" (stub)");return a};b.people.toString=function(){return b.toString(1)+".people (stub)"};l="disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_out_tracking start_batch_senders start_session_recording stop_session_recording people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove".split(" ");
  for(h=0;h<l.length;h++)t(b,l[h]);var n="set set_once union unset remove delete".split(" ");b.get_group=function(){function d(p){a[p]=function(){b.push([g,[p].concat(Array.prototype.slice.call(arguments,0))])}}for(var a={},g=["get_group"].concat(Array.prototype.slice.call(arguments,0)),m=0;m<n.length;m++)d(n[m]);return a};c._i.push([q,r,f])};c.__SV=1.2;var k=e.createElement("script");k.type="text/javascript";k.async=!0;k.src="undefined"!==typeof MIXPANEL_CUSTOM_LIB_URL?MIXPANEL_CUSTOM_LIB_URL:"file:"===
  e.location.protocol&&"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js".match(/^\/\//)?"https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js":"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";e=e.getElementsByTagName("script")[0];e.parentNode.insertBefore(k,e)}})(document,window.mixpanel||[]);
}

let st = null;

/** Start (once per document): nothing off the site's host or in a test browser. */
export function install({ debug = /[?&]debug(=|&|$)/.test(location.search) } = {}) {
  if (st) return st;
  const on = MP_HOSTS.includes(location.hostname) && !navigator.webdriver;
  st = { mp: on ? "waiting" : "off" };
  if (debug) window.__sfwTrack = st;
  if (!on) return st;
  let asked = false;
  const start = () => {
    if (asked) return;
    asked = true;
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 300)))(() => {
      try {
        window.MIXPANEL_CUSTOM_LIB_URL = MP_LIB;
        snippet();
        window.mixpanel.init(MP_TOKEN, { track_pageview: true });
        st.mp = "on";
      } catch (err) { st.mp = "error"; st.error = String(err?.message || err); }
    }, { timeout: 2000 });
  };
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
  setTimeout(start, LOAD_LATEST);
  return st;
}

/** (tests) forget this document's install. */
export function _reset() { st = null; }

if (typeof window !== "undefined" && typeof document !== "undefined" && !globalThis.__sfwTrackManual) install();

// Two small delights on the desk (docs/v3/EXPERIENCE-SPEC.md v2; interactions B):
//
//   the headphones, the easter egg: the laptop's screen crossfades from the Projects page to the official "Never Gonna
//   Give You Up" video, embedded from youtube-nocookie (the visitor's click is the user gesture for its sound); leaving
//   stops it and the Projects page comes back. egg-fast (28 Oct; Akshay: 7-8 s of a black screen before it played, on
//   egg-play's black-until-ready): the click puts the video's own thumbnail (kept in the site, no wait on YouTube) on the
//   screen at once, as the camera starts to lean in, with a quiet ring on it while the player loads; the player is
//   asked to play the moment it is ready and comes over the poster once its picture moves (the video, or an ad's clock).
//   The player is loaded hidden and paused on intent (the pointer over the headphones, or focus on their link: warm()),
//   so the click mostly only asks it to play. An embed that reports an error gives way to the thumbnail as a link to
//   the official video in a new tab, for the rest of the visit; one that is silent for 15 s gives way to it this time
//   only; one asked twice that still does not play shows itself as it is (its own play button). Phones open the
//   official video in a tab.
//     import { Egg, WATCH } from "/shared/toys.js";
//     const egg = new Egg(laptopScreen); egg.warm(); egg.start(); egg.stop(); egg.on; egg.state; egg.blocked; egg.marks
//
//   the breadboard, a builder's hands: the dev board's small LED blinks three times (a point of light at its place in
//   the room), and with Sound on the buzzer chirps a short three-note phrase (a quiet square wave, WebAudio, no files).
//     import { Board, soundOn } from "/shared/toys.js";
//     const board = new Board({ parent, point }); await board.blink({ visible }); board.place(pose, w, h)
//
// Sound: off by default, behind the approved "Sound" toggle (spec v2; shared/sound.js); its contract here is the class
// "sfw-sound" on <html>. While the soundscape plays, the chirp shares its AudioContext and goes through its master (the
// fades and the limiter), at the room's own place in the mix. No navigation for the breadboard.
import { project } from "./rig.js";
import { soundOut } from "./sound.js";

const YT = "https://www.youtube-nocookie.com";
export const EMBED = `${YT}/embed/dQw4w9WgXcQ`;
export const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
// the video's own thumbnail (YouTube's maxresdefault, 1280 x 720, 16:9 like the player's picture), kept in the site by
// scripts/content/egg_poster.py (28 KB): on the screen at once, and the link card when the embed cannot play
export const POSTER = new URL("./toys/never-gonna-give-you-up.webp", import.meta.url).href;
export const THUMB = POSTER;
// the poster comes onto the screen over FADE ms (it waits up to POSTER_WAIT ms to be decoded, so it comes in whole) and
// the player over it in REVEAL ms; reduced motion: 150 ms each
const FADE = 350, REVEAL = 450, POSTER_WAIT = 250;
const SPIN_AFTER = 600;   // ms after the click, the video not playing yet: a quiet ring turns on the poster
// asked to play (the IFrame API's playVideo) and still unstarted (-1) or cued (5), its clock at 0, this long after: asked
// again, once. A preroll ad also reports -1 for the video, but its clock runs (measured 27 Oct: one or two ads before the
// video for a fresh visitor); playVideo during an ad left it playing
const NUDGE = 1500;
// asked to play and still not playing this long after: the player shows itself as it is (a browser that will not let it
// play with sound, its own play button), so the visitor can act on it. A player that says so (the IFrame API's
// onAutoplayBlocked) shows itself at once; a buffering one keeps the poster (up to `wait`)
const STALL = 4000;
const KNOCK = 150;        // ms between "listening" messages until the player answers
const BLOCKED_KEY = "sfw-egg-blocked";   // sessionStorage: the embed reported an error in this visit
// the embed with the player's messages on (the coordinator's 04:05 review): the frame tells this page when it is ready or
// cannot play, so a refused embed never stays on the screen. No autoplay: a player loaded on intent (warm) must not
// play by itself; it is asked to (playVideo) once the visitor has clicked, which is the gesture its sound needs (the
// frame's allow="autoplay" passes this page's click on to it)
export const embedURL = (origin = location.origin) => `${EMBED}?enablejsapi=1&origin=${encodeURIComponent(origin)}`;
const CSS = `
.egg { position: absolute; inset: -2px; z-index: 50; background: #000; opacity: 0; }
.egg-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.egg-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #000; opacity: 0; pointer-events: none; }
.egg-ring { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; box-sizing: border-box;
  border-radius: 50%; border: 4px solid rgba(255, 255, 255, 0.26); border-top-color: rgba(255, 255, 255, 0.9);
  filter: drop-shadow(0 0 10px rgba(0, 0, 0, 0.5)); opacity: 0; transition: opacity 300ms ease; pointer-events: none;
  animation: egg-turn 0.9s linear infinite; }
@keyframes egg-turn { to { transform: rotate(360deg); } }
`;
const PLAY = '<svg viewBox="0 0 68 48" aria-hidden="true"><path d="M66.5 7.7c-.8-2.9-3-5.2-6-6C55.3.3 34 .3 34 .3S12.7.3 7.5 1.7c-3 .8-5.2 3.1-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3c.8 2.9 3 5.2 6 6C12.7 47.7 34 47.7 34 47.7s21.3 0 26.5-1.4c3-.8 5.2-3.1 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z" fill="rgba(18,18,18,0.72)"/><path d="M27 34.3 45 24 27 13.7z" fill="#fff"/></svg>';

export const soundOn = () => document.documentElement.classList.contains("sfw-sound");

export class Egg {
  constructor(laptop, { wait = 15000, reduced = () => false } = {}) {
    this.laptop = laptop;              // shared/laptop.js LaptopScreen (its page lives in a shadow root)
    // ms for the player's onReady, from the click, before the thumbnail link takes the poster's place. 15 s: onReady
    // came 0.3-1.2 s after the frame on an idle Mac, 2.3 and 5.2 s on a busy one (the player's script, ~480 KB, is
    // parsed in the frame), and not within 5 s with the frame's CPU slowed 4x (egg-play, 27 Oct)
    this.wait = wait;
    this.reduced = reduced;
    this.wrap = null;                  // the layer over the Projects page: the poster, the player's frame over it
    this.frame = null;
    this.state = "off";                // off | warm | loading | playing | thumb
    this.want = false;                 // the visitor clicked: the video is wanted on the screen
    this.marks = {};                   // performance.now() of: click, frame, ready, poster, asked, shown, thumb
    try { this.blocked = sessionStorage.getItem(BLOCKED_KEY) === "1"; } catch { this.blocked = false; }
  }
  get on() { return this.want; }
  get loaded() { return this.state === "playing" || this.state === "thumb"; }
  ms(t) { return this.reduced() ? 150 : t; }

  // Intent (the pointer over the headphones, or focus on their link): the layer is built on the laptop's screen,
  // hidden (inert, the pointer passes through to the page), the poster fetched and the player loaded, paused, so a
  // click only shows it and asks it to play. Nothing shows or plays. Once, until stop().
  warm() {
    if (this.want || this.wrap) return !!this.wrap;
    const wrap = this.layer();
    if (!wrap) return false;
    if (!this.blocked) { this.embed(); this.state = "warm"; }
    return true;
  }

  // The click: the poster onto the screen at once, and the player (warm, or loading from now) asked to play the moment
  // it is ready; it comes over the poster once its picture moves.
  start() {
    if (this.want) return true;
    const wrap = this.layer();
    if (!wrap) return false;
    this.want = true;
    this.marks = { click: performance.now(), frame: this.marks.frame, ready: this.marks.ready };
    // (a warm player that reported an error: its thumbnail, now shown; an embed that did, earlier in this visit: at once)
    if (this.state === "thumb") { this.reveal(); this.thumbIn(); return true; }
    if (this.blocked) { this.thumb("blocked before"); return true; }
    const warm = !!this.frame;
    if (!warm) this.embed();
    this.state = "loading";
    this.why = null;                   // (a silent player's "no onReady" is not this time's)
    this.reveal();
    this.spinT = setTimeout(() => this.spin(), SPIN_AFTER);
    if (this.readyAt) { this.play(); this.moved(); return true; }
    // a warm frame that has not said a word in all this time never will (a blocked request, an extension): the
    // thumbnail now, this time only
    if (warm && !this.heard && performance.now() - this.marks.frame >= this.wait) { this.thumb("no onReady", false); return true; }
    this.knockOn();
    // silence is not a refusal (a slow network or a busy computer): the thumbnail this time, the embed again next time
    this.timer = setTimeout(() => { if (this.want && this.state === "loading") this.thumb("no onReady", false); }, this.wait);
    return true;
  }

  // The layer over the Projects page, in the laptop's shadow root (2 px past the screen's box: the page's edge pixels,
  // white, would show as a hairline round the video): hidden until reveal().
  layer() {
    const root = this.laptop?.host?.shadowRoot;
    if (!root) return null;
    if (this.wrap && this.wrap.getRootNode() === root) return this.wrap;
    if (this.wrap) this.stop();        // (another screen: the old layer goes)
    const wrap = (this.wrap = document.createElement("div"));
    wrap.className = "egg";
    wrap.inert = true;
    wrap.style.pointerEvents = "none";
    const css = (this.css = document.createElement("style"));
    css.textContent = CSS;
    const img = (this.poster = document.createElement("img"));
    img.className = "egg-poster";
    img.alt = "";
    img.decoding = "async";
    img.src = POSTER;
    wrap.append(css, img);
    root.appendChild(wrap);
    return wrap;
  }

  // The layer onto the screen: the poster, decoded first (POSTER_WAIT at most) so it comes in whole.
  reveal() {
    const wrap = this.wrap, img = this.poster;
    if (!wrap) return;
    wrap.inert = false;
    wrap.style.pointerEvents = "";
    wrap.style.transition = `opacity ${this.ms(FADE)}ms cubic-bezier(0.45,0,0.25,1)`;
    let done = false;
    const go = () => {
      if (done || this.wrap !== wrap || !this.want) return;
      done = true;
      this.marks.poster ??= performance.now();
      void wrap.offsetWidth;           // (its opacity 0 committed first, or the fade would not run)
      wrap.style.opacity = "1";
    };
    if (!img || (img.complete && img.naturalWidth)) go();
    else { img.decode().then(go, go); setTimeout(go, POSTER_WAIT); }
  }

  // The player's frame, over the poster, hidden until its picture moves. Its messages: the IFrame API's own protocol,
  // without its script: "listening" until it answers, then onReady, its state and clock, or onError.
  embed() {
    const f = (this.frame = document.createElement("iframe"));
    f.className = "egg-frame";
    f.src = embedURL();
    f.title = "Never Gonna Give You Up";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.setAttribute("allowfullscreen", "");
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.style.transition = `opacity ${this.ms(REVEAL)}ms cubic-bezier(0.45,0,0.25,1)`;
    this.wrap.appendChild(f);
    this.marks.frame = performance.now();
    this.events = [];
    this.readyAt = 0;
    this.heard = false;
    this.asked = 0;
    this.nudged = false;
    this.noAutoplay = false;
    this.frameShown = false;
    this.ps = undefined;               // the player's last state (-1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued)
    this.clock = 0;                    // its currentTime (an ad's while one plays)
    const send = (this.send = (msg) => { try { f.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: "widget" }), YT); } catch { /* not yet */ } });
    if (this.onMsg) removeEventListener("message", this.onMsg);
    this.onMsg = (e) => {
      if (e.origin !== YT || e.source !== f.contentWindow || this.frame !== f) return;
      let d;
      try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!d || !d.event) return;
      if (d.event !== "infoDelivery") this.events.push(d.event);
      if (!this.heard) {
        this.heard = true;
        clearInterval(this.knock);
        for (const ev of ["onError", "onStateChange", "onAutoplayBlocked"]) send({ event: "command", func: "addEventListener", args: [ev] });
      }
      // (its state and clock also come in its info deliveries, only the fields that changed)
      if ((d.event === "infoDelivery" || d.event === "initialDelivery") && d.info) {
        if (typeof d.info.playerState === "number") this.ps = d.info.playerState;
        if (typeof d.info.currentTime === "number") this.clock = d.info.currentTime;
      }
      if (d.event === "onStateChange") this.ps = d.info;
      // the browser will not let it play (with sound) without a click of its own: shown at once, its own play button
      if (d.event === "onAutoplayBlocked") { this.noAutoplay = true; if (this.want && this.asked) this.show(); }
      // it cannot play here: the thumbnail (shown now if clicked, else at the click), for the rest of the visit
      if (d.event === "onError") { this.thumb(`onError ${d.info}`); return; }
      if (d.event === "onReady" && !this.readyAt) {
        this.readyAt = this.marks.ready = performance.now();
        clearTimeout(this.timer);
        if (this.want) this.play();
      }
      this.moved();
    };
    addEventListener("message", this.onMsg);
    f.addEventListener("load", () => { if (this.frame === f) { send({ event: "listening" }); this.knockOn(); } });
    this.knockOn();
  }

  // "listening" every KNOCK ms until the player answers (its script sets up its listener some time after the frame
  // loads); a warm frame not clicked stops after `wait` (its load, or a click, knocks again)
  knockOn() {
    clearInterval(this.knock);
    const f = this.frame;
    if (!f || this.heard) return;
    const t0 = performance.now();
    this.knock = setInterval(() => {
      if (this.frame !== f || this.heard || (!this.want && performance.now() - t0 > this.wait)) { clearInterval(this.knock); return; }
      this.send({ event: "listening" });
    }, KNOCK);
  }

  // Asked to play (once ready and clicked); once more if it stays unstarted; shown as it is if it never plays.
  play() {
    const f = this.frame;
    if (this.asked || !f) return;
    this.asked = this.marks.asked = performance.now();
    const go = () => this.send({ event: "command", func: "playVideo", args: [] });
    go();
    this.nudgeT = setTimeout(() => {
      if (this.frame !== f || this.frameShown || this.clock > 0 || !(this.ps === undefined || this.ps === -1 || this.ps === 5)) return;
      this.nudged = true;
      go();
    }, NUDGE);
    // (a player still buffering is on its way: the poster and its ring stay, up to `wait` after the click)
    const stall = () => {
      if (this.frame !== f) return;
      if (this.ps === 3 && performance.now() - this.marks.click < this.wait) { this.stallT = setTimeout(stall, 1000); return; }
      this.show();
    };
    this.stallT = setTimeout(stall, STALL);
  }

  // Its picture moves (the video playing, or an ad's clock running): clicked, it comes over the poster; warm (not
  // clicked), a player that started by itself is paused, never seen or heard.
  moved() {
    if (this.ps !== 1 && !(this.clock > 0)) return;
    if (this.want) this.show();
    else if (this.ps === 1) this.send({ event: "command", func: "pauseVideo", args: [] });
  }

  show() {
    const f = this.frame;
    if (!this.want || this.state !== "loading" || !f) return;
    this.state = "playing";
    this.frameShown = true;
    this.marks.shown = performance.now();
    clearTimeout(this.stallT); clearTimeout(this.timer); clearTimeout(this.spinT);
    f.style.pointerEvents = "auto";
    if (this.ring) this.ring.style.opacity = "0";
    requestAnimationFrame(() => { if (this.frame === f) f.style.opacity = "1"; });
  }

  // A quiet ring on the poster while the player loads (none with reduced motion: the poster alone).
  spin() {
    if (this.state !== "loading" || this.ring || !this.wrap || this.reduced()) return;
    const r = (this.ring = document.createElement("div"));
    r.className = "egg-ring";
    r.setAttribute("aria-hidden", "true");
    this.wrap.appendChild(r);
    void r.offsetWidth;                // (its opacity 0 committed first, or the fade would not run)
    r.style.opacity = "1";
  }

  // The embed cannot play here: the poster (no words) as a link to the official video, in a new tab. remember: for the
  // rest of the visit too (an error the player reported; not a silent player). Warm (not clicked yet), it waits hidden.
  thumb(why, remember = true) {
    const wrap = this.wrap;
    if (!wrap) return;
    this.why = why;
    this.state = "thumb";
    this.marks.thumb = performance.now();
    if (remember) {
      this.blocked = true;
      try { sessionStorage.setItem(BLOCKED_KEY, "1"); } catch { /* storage blocked */ }
    }
    this.quiet();
    this.frame?.remove();
    this.frame = null;
    this.ring = null;
    const a = document.createElement("a");
    a.className = "egg-thumb";
    a.href = WATCH;
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("aria-label", "Never Gonna Give You Up");
    a.style.cssText = "position:absolute;inset:0;display:block;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;";
    // (the poster already on the screen moves into the link, so nothing reloads or blinks; the play mark fades in)
    const play = (this.mark = document.createElement("span"));
    play.innerHTML = PLAY;
    play.style.cssText = `position:absolute;left:50%;top:50%;width:13%;transform:translate(-50%,-50%);display:block;line-height:0;opacity:0;transition:opacity ${this.ms(FADE)}ms ease;`;
    play.firstChild.style.cssText = "width:100%;height:auto;display:block;";
    a.append(...[this.poster, play].filter(Boolean));
    wrap.replaceChildren(this.css, a);
    if (this.want) { this.reveal(); this.thumbIn(); }
  }

  thumbIn() {
    const m = this.mark;
    if (!m) return;
    void m.offsetWidth;
    m.style.opacity = "1";
  }

  // timers, the knock and the player's messages
  quiet() {
    clearTimeout(this.timer); clearTimeout(this.nudgeT); clearTimeout(this.stallT); clearTimeout(this.spinT); clearInterval(this.knock);
    if (this.onMsg) { removeEventListener("message", this.onMsg); this.onMsg = null; }
  }

  // Stops the video (the frame goes, and its sound with it) once the Projects page is back on the screen; a warm
  // player goes too (the next intent loads it again).
  stop() {
    const wrap = this.wrap;
    this.want = false;
    this.state = "off";
    this.quiet();
    this.wrap = this.frame = this.poster = this.ring = this.mark = this.css = null;
    this.last = this.marks;            // (the visit's last marks, for a test to read)
    this.marks = {};
    this.readyAt = 0;
    this.heard = false;
    if (!wrap) return;
    const ms = this.reduced() ? 150 : 320;
    wrap.inert = true;
    wrap.style.transition = `opacity ${ms}ms ease`;
    wrap.style.opacity = "0";
    setTimeout(() => wrap.remove(), ms + 20);
  }
}

// ------------------------------------------------------------------ the breadboard
const LED_CSS = `
.sfw-led { position: absolute; left: 0; top: 0; z-index: 1; width: 0; height: 0; pointer-events: none; mix-blend-mode: screen; opacity: 0; transition: opacity 45ms linear; }
.sfw-led i { position: absolute; border-radius: 50%; transform: translate(-50%, -50%); }
.sfw-led .halo { background: radial-gradient(closest-side, rgba(255, 64, 40, 0.9), rgba(255, 48, 28, 0.42) 28%, rgba(255, 40, 20, 0.12) 60%, rgba(255, 40, 20, 0) 100%); }
.sfw-led .core { background: radial-gradient(closest-side, #fffaf6, #ffd2c4 35%, #ff5a3c 70%, rgba(255, 60, 30, 0) 100%); }
`;
const NOTES = [2093, 2637, 3136];        // C7, E7, G7: a buzzer's rising three-note chirp
const NOTE_S = 0.14, GAP_S = 0.1;

export class Board {
  constructor({ parent, point }) {
    this.point = point;
    if (!document.querySelector("style[data-sfw-led]")) {
      const s = document.createElement("style");
      s.setAttribute("data-sfw-led", "");
      s.textContent = LED_CSS;
      document.head.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.className = "sfw-led";
    this.el.setAttribute("aria-hidden", "true");
    this.halo = document.createElement("i"); this.halo.className = "halo";
    this.core = document.createElement("i"); this.core.className = "core";
    this.el.append(this.halo, this.core);
    parent.appendChild(this.el);
    this.log = [];
    this.blinking = false;
  }

  // Where the LED is on screen and how big a few millimetres look from here.
  place(pose, w, h) {
    const s = project(pose, this.point, w, h);
    if (!s) { this.el.style.visibility = "hidden"; return null; }
    this.el.style.visibility = "";
    const pxPerM = (h / 2) / pose.tanV / s[2];
    // (a lit 1.6 mm SMD LED reads as a hot point with a red bloom about 2.5 cm across)
    const halo = Math.max(16, 0.04 * pxPerM), core = Math.max(4, 0.006 * pxPerM);
    this.el.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px)`;
    this.halo.style.width = this.halo.style.height = `${halo.toFixed(1)}px`;
    this.core.style.width = this.core.style.height = `${core.toFixed(1)}px`;
    return s;
  }

  // Three blinks (with the chirp's notes when Sound is on). visible: the LED is in view from here (else no light).
  async blink({ visible = true } = {}) {
    if (this.blinking) return false;
    this.blinking = true;
    const t0 = performance.now();
    this.log = [];
    const sound = soundOn();
    if (sound) chirp();
    for (let i = 0; i < NOTES.length; i++) {
      if (visible) this.el.style.opacity = "1";
      this.log.push({ on: Math.round(performance.now() - t0) });
      await new Promise((r) => setTimeout(r, NOTE_S * 1000));
      this.el.style.opacity = "0";
      this.log[i].off = Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, GAP_S * 1000));
    }
    this.blinking = false;
    this.last = { blinks: this.log.length, log: this.log, visible, sound };
    return true;
  }
}

// The buzzer: three short square-wave notes, quiet, through a soft low-pass (a piezo is not harsh), no audio files.
let ctx = null;
export function chirp() {
  try {
    const shared = soundOut();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!shared && !AC) return false;
    if (!shared) { ctx = ctx || new AC(); if (ctx.state === "suspended") ctx.resume(); }
    const c = shared ? shared.ctx : ctx;
    const t = c.currentTime + 0.02;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 4200; lp.Q.value = 0.5;
    const out = c.createGain();
    out.gain.value = 0.035;
    lp.connect(out).connect(shared ? shared.dest : c.destination);
    NOTES.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), s = t + i * (NOTE_S + GAP_S);
      o.type = "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(1, s + 0.006);
      g.gain.setValueAtTime(1, s + NOTE_S - 0.015);
      g.gain.linearRampToValueAtTime(0, s + NOTE_S);
      o.connect(g).connect(lp);
      o.start(s);
      o.stop(s + NOTE_S + 0.02);
    });
    return true;
  } catch { return false; }
}

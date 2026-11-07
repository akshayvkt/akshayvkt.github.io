// DYS-221 (Akshay's pick: variant a). The laptop's macOS lock screen on a first visit while the room loads, drawn in
// the photo's screen box (C's .fv-screen). Black until wake(); the backlight comes up; banners slide in top right;
// the Touch ID ring fills with the real boot; 'Touch to unlock'; unlock() as a Mac's Touch ID unlock (DYS-230 round
// 2b): the clock, name and prompt fade out, then the screen dissolves into what's under it (the About page). Laid out in macOS points
// measured off his own lock screen (renders/stage-qa-d/dys221/lockscreen/NOTES.md), on a virtual 1440-wide display.
// Cheap on purpose: no backdrop-filter, no SVG filters, CSS transitions on opacity/transform only, nothing per frame.
// The glass is the wallpaper itself: a tiny blurred copy (one small canvas read at wake, so it lands under the black)
// seen through the clock's figures and under the cards; until then the plain wallpaper, the cards' copy CSS-blurred.
//
//   const lock = mountLock(box, { wall, name, initials, avatar });
//   lock.resize(W0, H0); lock.setWall(url); await lock.wake(); lock.setProgress(f); lock.ready(); await lock.unlock(); lock.dispose();
// DYS-230: mountLock(layer, { mode: "full", touch }): the whole viewport, no banners, no black (round 2: it comes up
// on the blurred wallpaper, its words fading in); unlock() = press().
// lock.setSoft(url): a first wallpaper under it (round 2b: the head's inline golden view), its tones until that lands.

// The notifications, oldest first (the newest lands on top). Akshay may change them.
export const NOTES = [
  { icon: "r", title: "The Selfish Gene", time: "18m ago", body: "Richard Dawkins · Currently reading. Pick up where you left off." },
  { icon: "p", title: "SF in Motion", time: "6m ago", body: "New project · See how SF moves on Lyft Bike." },
  { icon: "w", title: "Verifying ≠ Understanding", time: "now", body: "New post · Heading into a world where progress outruns our understanding." },
];
// ms. Apple publishes none of these (NOTES.md): the wake is a backlight ramp, the banners land as if queued in sleep.
export const TL = { black: 300, wake: 500, noteFirst: 400, noteGap: 700, noteDur: 500, readyDur: 420, unlock: 520, press: 150 };
// Full mode (2 Nov mockups). phone: CSS px at 390 x 844, times min(W/390, H/720, 1.4); mac: the Mac's points,
// scaled like the box. at: line tops, fractions of the height. Text >= 12 CSS px. portraitX: the bridge side.
export const FULL = {
  phone: { at: { date: .126, clock: .152, stack: .705 }, date: 18, clock: 100, fox: 48, foxGap: 20, name: 20, barGap: 16, bar: 150, barH: 5, loadGap: 14, label: 13, fp: 48 },
  mac: { at: { stack: .792 }, fox: 47, foxGap: 14.6, name: 19.6, barGap: 12, bar: 160, barH: 5, loadGap: 10, label: 13, fp: 38 },
  portraitX: "58%",
};

const RING = 120.01;   // the ring's circumference (r 19.1 in its 40 box)
const ICON = {
  w: '<svg viewBox="0 0 32 32" fill="none" stroke-linecap="round"><path d="M9 11.5H23M9 16H23M9 20.5H16.5" stroke="#3b362f" stroke-width="1.7" stroke-opacity=".78"/><path d="M19.6 23.8L24.2 19.2" stroke="#e2662a" stroke-width="2.4"/></svg>',
  r: '<svg viewBox="0 0 32 32"><path d="M11 7.5H21Q22.5 7.5 22.5 9V25L16 20.6L9.5 25V9Q9.5 7.5 11 7.5Z" fill="#fff"/></svg>',
  p: '<svg viewBox="0 0 32 32" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="19.5" r="4.3"/><circle cx="22.5" cy="19.5" r="4.3"/><path d="M9.5 19.5L13.8 12.4H19.4L22.5 19.5M13.8 12.4L16.4 19.5L19.4 12.4M12.4 10H15.4M18.6 9.6L19.4 12.4"/></svg>',
};
const MENU = '<span>U.S.</span><svg viewBox="0 0 15 10" style="width:14.7px;height:9.6px;margin:0 16px 0 6.6px"><rect x=".55" y=".55" width="13.9" height="8.9" rx="1.8" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M2.4 2.4h1.3v1.1H2.4zm2.1 0h1.3v1.1H4.5zm2.1 0h1.3v1.1H6.6zm2.1 0H10v1.1H8.7zm2.1 0h1.3v1.1h-1.3zM3.4 4.4h1.3v1.1H3.4zm2.1 0h1.3v1.1H5.5zm2.1 0h1.3v1.1H7.6zm2.1 0H11v1.1H9.7zM4.4 6.5h6.2v1.1H4.4z" fill="#fff"/></svg>'
  + '<svg viewBox="0 0 25 12" style="width:24.3px;height:11.8px;margin-right:19px"><rect x=".5" y=".5" width="21.6" height="11" rx="3.4" fill="none" stroke="#ffffff80"/><rect x="2" y="2" width="16.9" height="8" rx="2" fill="#fff"/><rect x="23" y="4.1" width="1.6" height="3.8" rx=".8" fill="#ffffff80"/></svg>'
  + '<svg viewBox="0 0 13 9.5" style="width:12.5px;height:9px"><path d="M1.55 3.45A7 7 0 0 1 11.45 3.45M3.25 5.15A4.6 4.6 0 0 1 9.75 5.15" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="6.5" cy="7.95" r="1.25" fill="#fff"/></svg>';
// an original fingerprint (an arch print in broken strokes), not Apple's glyph
const PRINT = '<svg class="lk-fp" viewBox="0 0 24 24"><path d="M4.12 10.61A8 8 0 0 1 16.59 5.45M18.55 7.41A8 8 0 0 1 19.73 14.07M4.48 14.74A8 8 0 0 0 6.34 17.66M6.8 17.2V12A5.2 5.2 0 0 1 17.2 12V15.4M9.6 19.9C9.45 18.6 9.4 17.2 9.4 15.8V12A2.6 2.6 0 0 1 14.6 12V14.6C14.6 16.5 14.2 18.2 13.5 19.7M12 12.4V16.2C12 17.6 11.8 18.9 11.4 20M17.2 18.1C16.95 19.05 16.6 19.9 16.15 20.7"/></svg>';

// Every length inside .lk-s is a macOS point (his screenshot: 2000 x 1299 px = a 1470 x 954.8 pt screen).
const CSS = `
.sfw-lock{position:absolute;inset:0;overflow:hidden;background:#000;pointer-events:none;color:#fff;--lk-wall:none;--lk-lift:.38;
 font-family:-apple-system,BlinkMacSystemFont,"Geist",system-ui,sans-serif;font-synthesis:none;-webkit-font-smoothing:antialiased}
.sfw-lock *{box-sizing:border-box;margin:0}
.lk-s{position:absolute;left:0;top:0;transform-origin:0 0;background:#1b1d22 var(--lk-soft,none) center/cover no-repeat}
.lk-s>*,.lk-top>*{position:absolute}
.lk-w,.lk-dim,.lk-top,.lk-top>*,.lk-off{inset:0}
.lk-w{background:var(--lk-wall) center/cover no-repeat}
.lk-wf{animation:lkF .6s ease-out}
@keyframes lkF{from{opacity:0}}
.lk-dim{background:linear-gradient(#00000024,#00000015 22%,#0000 46%);opacity:0;transition:opacity .4s}
.sfw-lock[data-tc=l]{--lk-lift:.5}
[data-tc=l] .lk-dim{opacity:1}
.lk-top{transform-origin:50% 20%}
.lk-d{padding-top:88.2px;text-align:center;font-size:26.8px;line-height:1;font-weight:600;color:#ffffffa8}
[data-tc=l] .lk-d{color:#fffffff0;text-shadow:0 .5px 3px #0000004d}
.lk-k{padding-top:108.9px;text-align:center;font-size:135.5px;line-height:1;font-weight:700;letter-spacing:-.012em;font-feature-settings:"case";white-space:nowrap}
.lk-na .lk-k .c{vertical-align:.1em;line-height:0}
.lk-h{color:transparent;text-shadow:0 1.5px 8px #0000002e}
[data-tc=l] .lk-h{text-shadow:0 0 4px #0000004d,0 0 12px #0000004d,0 1.5px 8px #0003}
.lk-t{color:#ffffffd9;transform:translateY(-2px)}
.lk-b{color:#fffffff2;opacity:.32;transform:translateY(1.5px)}
.lk-y{color:transparent;background:linear-gradient(rgba(255,255,255,var(--lk-lift)) 0 0),var(--lk-frost,var(--lk-wall));background-color:#2a2d33;
 background-size:100% 100%,var(--lk-fs,cover);background-position:center;-webkit-background-clip:text;background-clip:text}
.lk-r{color:transparent;-webkit-text-stroke:.75px #ffffff52}
[data-tc=l] .lk-r{-webkit-text-stroke-color:#fff6}
.lk-m{top:0;right:25.7px;height:28.6px;display:flex;align-items:center;font-size:13px;font-weight:500}
[data-tm=l] .lk-m{text-shadow:0 .5px 2px #0000004d}
.lk-ns{top:36px;right:12px;width:344px;--lk-nf:#ffffff1f}
[data-tn=l] .lk-ns{--lk-nf:#1a1a1e4d}
.lk-n{position:absolute;left:0;top:0;width:344px;border-radius:20px;overflow:hidden;box-shadow:0 4px 18px #00000024;
 transform:translate(var(--lk-x,380px),var(--lk-y,0px));transition:transform .5s cubic-bezier(.22,1,.36,1)}
.lk-g{position:absolute;left:calc(356px - var(--lk-sw) - var(--lk-m,40px));top:calc(-36px - var(--lk-y,0px) - var(--lk-m,40px));
 width:calc(var(--lk-sw) + 2*var(--lk-m,40px));height:calc(var(--lk-sh) + 2*var(--lk-m,40px));
 background:linear-gradient(var(--lk-nf) 0 0),var(--lk-frost,none);background-color:#3a3d44;background-size:100% 100%,var(--lk-fs,cover);
 background-position:center}
.lk-n::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:.75px;
 background:linear-gradient(155deg,#ffffff8c,#ffffff1f 30%,#ffffff0a 60%,#ffffff38);
 -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
 mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}
.lk-c{position:relative;display:flex;align-items:center;gap:10px;padding:12px 14px 12px 12px;font-size:13px;line-height:16px}
.lk-i{flex:none;position:relative;width:32px;height:32px;border-radius:23%;overflow:hidden;box-shadow:inset 0 0 0 .5px #00000024}
.lk-i svg{display:block;width:100%;height:100%}
.lk-iw{background:linear-gradient(#fffdf8,#ebe4d4)}.lk-ir{background:linear-gradient(#4d73ab,#253d69)}.lk-ip{background:linear-gradient(#f3a958,#d9822b)}
.lk-x{flex:1;min-width:0;color:#ffffffdb}
.lk-x p:first-child{display:flex;align-items:baseline;gap:8px}
.lk-x b{flex:1;min-width:0;font-weight:600;color:#fffffff5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lk-x i{font-style:normal;font-size:12px;color:#ffffff8c}
.lk-x p+p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lk-bt{left:0;right:0;bottom:33.9px;display:flex;flex-direction:column;align-items:center}
.lk-av{width:47px;height:47px;margin-bottom:14.6px;border-radius:50%;display:flex;align-items:center;justify-content:center;
 background:linear-gradient(#a7adb9,#858a96) center/cover;font:600 19px ui-rounded,-apple-system,BlinkMacSystemFont,"Geist",sans-serif;letter-spacing:.02em}
.lk-nm{margin-bottom:10px;font-size:14px;line-height:17px;font-weight:600;white-space:nowrap}
.lk-tid{position:relative;width:38px;height:38px;margin-bottom:8.5px;border-radius:50%;background:#ffffff1a;box-shadow:inset 0 .75px 0 #ffffff38,inset 0 0 0 .5px #ffffff1f}
.lk-tid::before{content:"";position:absolute;inset:0;border-radius:50%;background:#fff;opacity:0;transition:opacity .3s}
.is-ready .lk-tid::before{opacity:.16}
.lk-tid svg{position:absolute;overflow:visible}
.lk-ring{inset:0;width:100%;height:100%}
.lk-ring circle{fill:none;stroke-width:3}
.lk-ta{stroke:#fff;stroke-linecap:round;stroke-dasharray:${RING};stroke-dashoffset:${RING};opacity:0;transition:stroke-dashoffset .35s ease-out,opacity .2s}
.lk-tr{stroke:#ffffff4d;transition:opacity .4s}
.lk-fp{left:21%;top:21%;width:58%;height:58%;fill:none;stroke:#fff;stroke-width:1.5;stroke-linecap:round;opacity:.72;transition:opacity .3s}
.lk-hn{position:relative;width:240px;height:29.4px;font-size:12px;line-height:14.7px;font-weight:500;text-align:center}
.lk-hn>span{position:absolute;left:0;right:0;top:0;transition:opacity .22s ease-in,transform .22s ease-in}
.lk-hl{color:#ffffff99}
.lk-hr{opacity:0;transform:translateY(3px);font-weight:600;color:#ffffffc7}
[data-tb=l] .lk-nm,[data-tb=l] .lk-hn,[data-tb=l] .lk-fs{text-shadow:0 0 3px #00000038,0 .5px 1.5px #00000040}
.lk-sh{position:absolute;left:0;top:0;width:48px;height:100%;overflow:hidden;font-style:normal;
 -webkit-mask:linear-gradient(90deg,#0000,#000,#0000);mask:linear-gradient(90deg,#0000,#000,#0000);transform:translateX(-48px)}
.lk-sh span{position:absolute;left:0;top:0;width:240px;color:#fff;transform:translateX(48px)}
.is-ready .lk-hl{opacity:0;transform:translateY(-3px)}
.is-ready .lk-hr{opacity:1;transform:none;transition:opacity .3s ease-out .12s,transform .3s ease-out .12s}
.is-ready .lk-fp{opacity:1}.is-ready .lk-tr{opacity:0}
.is-ready .lk-sh{animation:lkW 2.6s ease-in-out .92s infinite both}
.is-ready .lk-sh span{animation:lkT 2.6s ease-in-out .92s infinite both}
@keyframes lkW{from{transform:translateX(-48px)}to{transform:translateX(240px)}}
@keyframes lkT{from{transform:translateX(48px)}to{transform:translateX(-240px)}}
.lk-off{position:absolute;background:#000;transition:opacity ${TL.wake}ms cubic-bezier(.33,1,.68,1) ${TL.black}ms}
.is-awake .lk-off{opacity:0}
.is-unlock{background:none}
.is-unlock .lk-top,.is-unlock .lk-bt,.is-unlock .lk-fs,.is-unlock .lk-ns,.is-unlock .lk-m,.is-unlock .lk-dim{opacity:0;transition:opacity .2s ease-out .06s}
.is-unlock .lk-s{opacity:0;transition:opacity .35s ease .16s}
.is-unlock .lk-tid{animation:lkP .3s ease-out}
.is-unlock .lk-sh,.is-unlock .lk-sh span{animation:none}
@keyframes lkP{35%{transform:scale(.9)}}
.lk-rm .lk-n{transform:translateY(var(--lk-y,0px));opacity:0;transition:opacity .4s}
.lk-rm .lk-n.on{opacity:1}
.lk-rm.is-unlock .lk-top,.lk-rm.is-unlock .lk-bt,.lk-rm.is-unlock .lk-ns{transform:none}
.lk-rm .lk-sh,.lk-rm .lk-sh span{display:none}
.lk-rm .lk-fb::after,.lk-rm .lk-tid,.lk-rm .lk-t,.lk-rm .lk-b{animation:none!important}
.lk-rm .lk-hn>span{transform:none!important}
.lk-ph .lk-d{padding-top:var(--lk-at-date);font-size:var(--lk-date)}
.lk-ph .lk-k{padding-top:var(--lk-at-clock);font-size:var(--lk-clock)}
.lk-mx .lk-m,.lk-fl .lk-b,.lk-fl .lk-y,.lk-fl .lk-r{display:none}
.lk-fl{background:none}.lk-fl .lk-off{display:none}.lk-fl .lk-wf{animation-duration:.3s}
.lk-fl .lk-t{color:#ffffffe0;transform:none}
.lk-fs,.lk-ld,.lk-rd{display:flex;flex-direction:column;align-items:center}
.lk-fs{left:0;right:0;top:var(--lk-at-stack);line-height:1.2;white-space:nowrap}
.lk-fx{font-size:var(--lk-fox);line-height:1;margin-bottom:var(--lk-foxGap)}
.lk-fn{font-size:var(--lk-name);font-weight:600;margin-bottom:var(--lk-barGap)}
.lk-sl{position:relative;align-self:stretch}
.lk-ld,.lk-rd{transition:opacity .25s}
.lk-rd{position:absolute;left:0;right:0;top:0;opacity:0}
.lk-pb{width:var(--lk-bar);height:var(--lk-barH);border-radius:9px;overflow:hidden;background:#ffffff40}
.lk-pb i{display:block;height:100%;background:#fff;transform:scaleX(0);transform-origin:0 0;transition:transform .35s ease-out}
.lk-fs p{font-size:var(--lk-label);font-weight:500;color:#ffffffb3}
.lk-ld p{margin-top:var(--lk-loadGap)}
.lk-fs .lk-tid{width:var(--lk-fp);height:var(--lk-fp);background:#0003;border:1.6px solid #fff}
.lk-fb::after{content:"";position:absolute;inset:-35%;border-radius:50%;background:radial-gradient(closest-side,#fff0 58%,#ffffff47 72%,#fff0);opacity:0}
.is-ready .lk-ld{opacity:0}.is-ready .lk-rd{opacity:1}
.is-ready .lk-fb::after{animation:lkQ 2s ease-in-out .3s infinite}
@keyframes lkQ{50%{opacity:1;transform:scale(1.06)}}
.is-press .lk-tid::before{opacity:1;transition:opacity .12s}.is-press .lk-fp{stroke:#000}
`;

let styled = false;
const SF = typeof Intl !== "undefined" && new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23",
  weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "numeric" });
const SFL = SF && new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });

// The time and date in San Francisco, as the lock screen shows them: { time: '4:58', date: 'Sun Nov 1' }; long: 'Sunday, November 1'.
export function sfClock(d = new Date(), long = false) {
  const p = {};
  for (const x of SF.formatToParts(d)) p[x.type] = x.value;
  const h = +p.hour % 24;
  return { time: `${h % 12 || 12}:${p.minute}`, date: long ? SFL.format(d) : `${p.weekday} ${p.month} ${p.day}` };
}

export function mountLock(box, { wall = null, name = "Akshay Chintalapati", initials = "AC", avatar = null, mode = "box", touch = false } = {}) {
  const doc = box.ownerDocument, win = doc.defaultView, full = mode === "full";
  if (!styled || !doc.getElementById("sfw-lock-css")) {
    const st = doc.createElement("style");
    st.id = "sfw-lock-css"; st.textContent = CSS; doc.head.appendChild(st); styled = true;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const layer = (c) => `<div class="lk-k ${c}"></div>`;
  // (DYS-230 round 2b) full: index.html's first frame is this markup already (scripts/live/lock_first_frame.py), laid
  // out and its clock filled: taken over as it is
  const pre = full && box.querySelector(":scope > .sfw-lock.lk-fl");
  const el = pre || doc.createElement("div");
  if (!pre) el.className = full ? "sfw-lock lk-fl" : "sfw-lock";
  el.setAttribute("aria-hidden", "true");
  if (!pre) el.innerHTML = `<div class="lk-s"><div class="lk-w"></div><div class="lk-dim"></div>`
    + `<div class="lk-top"><div class="lk-d"></div>${layer("lk-h")}${layer("lk-t")}${layer("lk-b")}${layer("lk-y")}${layer("lk-r")}</div>`
    + `<div class="lk-m">${MENU}</div>`
    + (full ? `<div class="lk-fs"><div class="lk-fx">🦊</div><div class="lk-fn">${esc(name)}</div><div class="lk-sl">`
      + `<div class="lk-ld"><div class="lk-pb"><i></i></div><p>Loading…</p></div><div class="lk-rd"><div class="lk-tid lk-fb">${PRINT}</div>`
      + `<p>${touch ? "Tap" : "Click"} to enter</p></div></div></div>`
    : `<div class="lk-ns">`
    + NOTES.map((n) => `<div class="lk-n"><i class="lk-g"></i><div class="lk-c"><b class="lk-i lk-i${n.icon}">${ICON[n.icon]}</b>`
      + `<div class="lk-x"><p><b>${esc(n.title)}</b><i>${esc(n.time)}</i></p><p>${esc(n.body)}</p></div></div></div>`).join("")
    + `</div><div class="lk-bt"><div class="lk-av">${avatar ? "" : esc(initials)}</div><div class="lk-nm">${esc(name)}</div>`
    + `<div class="lk-tid"><svg class="lk-ring" viewBox="0 0 40 40"><g transform="rotate(-90 20 20)"><circle class="lk-tr" cx="20" cy="20" r="19.1"/>`
    + `<circle class="lk-ta" cx="20" cy="20" r="19.1"/></g></svg>${PRINT}</div>`
    + `<div class="lk-hn"><span class="lk-hl">Preparing Touch ID…</span><span class="lk-hr">Touch to unlock<i class="lk-sh"><span>Touch to unlock</span></i></span></div></div>`)
    + `</div><div class="lk-off"></div>`;
  const $ = (s) => el.querySelector(s);
  const stage = $(".lk-s"), arc = $(".lk-ta"), bar = $(".lk-pb i"), wl = $(".lk-w"), cards = [...el.querySelectorAll(".lk-n")];
  if (avatar && !full) $(".lk-av").style.backgroundImage = `url(${JSON.stringify(avatar)})`;
  if (!/Mac|iPhone|iPad|iPod/.test(win.navigator.platform || "")) el.classList.add("lk-na");   // Geist: no centred colon
  const reduced = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (reduced) el.classList.add("lk-rm");
  if (!pre) box.appendChild(el);

  let timers = [], minute = 0, progress = 0, wallUrl = null, probed = null, sw = 1470, sh = 954.8, awake = false, gone = false, hs = null, ph = false, soft = null;
  const later = (fn, ms) => { const t = win.setTimeout(fn, ms); timers.push(t); return t; };

  function tick() {
    const c = sfClock(undefined, full);
    $(".lk-d").textContent = c.date;
    const t = c.time.replace(":", '<span class="c">:</span>');
    for (const k of el.querySelectorAll(".lk-k")) k.innerHTML = t;
  }
  function onMinute() {   // one timer to the next minute, not one a second
    tick();
    win.clearTimeout(minute);
    minute = win.setTimeout(onMinute, 60000 - (Date.now() % 60000) + 50);
  }

  // The tones and the frosted copy: one small read of the wallpaper (dark if it can't be read), at wake so they land
  // under the black. decode() first: the 1600 px picture is not decoded on the main thread.
  // (DYS-230) the preview's tones and glass until the wallpaper lands
  function probe() {
    const url = wallUrl || soft;
    if (!url || gone || probed === url) return;
    probed = url;
    const img = new win.Image();
    img.src = url;
    Promise.resolve().then(() => img.decode()).then(() => {
      if (gone || url !== (wallUrl || soft)) return;
      try {
        const cw = 96, ch = Math.max(8, Math.round(96 * sh / sw)), c = doc.createElement("canvas");
        c.width = cw; c.height = ch;
        const x = c.getContext("2d"), k = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
        x.drawImage(img, (cw - img.naturalWidth * k) / 2, (ch - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
        const d = x.getImageData(0, 0, cw, ch).data, s = cw / sw;
        const luma = (x0, y0, x1, y1) => {
          let a = 0, n = 0;
          for (let y = Math.max(0, y0 * s | 0); y < Math.min(ch, Math.ceil(y1 * s)); y++)
            for (let xx = Math.max(0, x0 * s | 0); xx < Math.min(cw, Math.ceil(x1 * s)); xx++, n++) {
              const i = (y * cw + xx) * 4;
              a += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            }
          return n ? a / n / 255 : 0;
        };
        const tone = (v) => (v > 0.56 ? "l" : "d");
        el.dataset.tc = tone(full ? luma(sw * .3, sh * .08, sw * .7, sh * .27) : luma(sw / 2 - 190, 80, sw / 2 + 190, 240));
        if (!full) el.dataset.tn = tone(luma(sw - 368, 30, sw - 10, 300));
        el.dataset.tb = tone(full ? luma(sw * .35, sh * .75, sw * .65, sh * .95) : luma(sw / 2 - 130, sh - 215, sw / 2 + 130, sh - 30));
        el.dataset.tm = tone(luma(sw - 170, 0, sw, 30));
        // (W1, B's rig: a live CSS blur on the cards' screen-sized glass cost ~2.4 s on WebKit while the room loaded) the
        // frost's blur and saturation made once here, in the small copy; the cards draw it as it is, no filter
        if ("filter" in x) { x.filter = "blur(1.2px) saturate(1.8)"; x.drawImage(img, (cw - img.naturalWidth * k) / 2, (ch - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k); x.filter = "none"; }
        const st = el.style;
        st.setProperty("--lk-frost", `url(${c.toDataURL("image/jpeg", 0.8)})`);
        st.setProperty("--lk-fs", "100% 100%"); st.setProperty("--lk-m", "0px");
      } catch (e) { /* another origin, or no canvas: the dark tone and the plain wallpaper */ }
    }, () => {});
  }

  function place(k) {   // banner k lands on top; the older ones move down under it
    if (!hs) hs = cards.map((c) => c.offsetHeight || 64);
    let y = 0;
    for (let i = k; i >= 0; i--) {
      cards[i].style.setProperty("--lk-y", `${y}px`);
      y += hs[i] + 8;
    }
    cards[k].style.setProperty("--lk-x", "0px");
    cards[k].classList.add("on");
  }

  const lock = {
    el,
    resize(W0, H0, p) {
      if (!(W0 > 0 && H0 > 0)) return;
      if (!p) ph = full && (W0 < 700 || H0 > W0 || H0 < 500);   // full, a phone: in CSS px
      let sc = 1;
      if (ph) { sw = W0; sh = H0; } else {
        const hv = 1440 * H0 / W0, pt = Math.min(1440 / 1470, hv / 954.8);
        sw = 1440 / pt; sh = hv / pt; sc = (W0 / 1440) * pt;
      }
      Object.assign(stage.style, { width: `${sw}px`, height: `${sh}px`, transform: `scale(${sc})` });
      stage.style.setProperty("--lk-sw", `${sw}px`); stage.style.setProperty("--lk-sh", `${sh}px`);
      if (!full) return;
      const T = FULL[ph ? "phone" : "mac"], q = ph ? Math.min(W0 / 390, H0 / 720, 1.4) : 1;
      el.classList.toggle("lk-ph", ph);
      el.classList.toggle("lk-mx", ph || 13 * sc < 12);   // 12 px text or no menu
      if (!p) stage.style.backgroundPosition = wl.style.backgroundPosition = H0 > W0 ? `${FULL.portraitX} 50%` : "";
      for (const k in T) if (k !== "at") el.style.setProperty(`--lk-${k}`, `${Math.max(T[k] * q, /^(date|name|label)$/.test(k) ? 12 / sc : 0)}px`);
      for (const k in T.at) el.style.setProperty(`--lk-at-${k}`, `${T.at[k] * sh}px`);
    },
    setWall(url) {
      wallUrl = url || null; probed = null;
      el.style.setProperty("--lk-wall", wallUrl ? `url(${JSON.stringify(wallUrl)})` : "none");
      for (const p of ["--lk-frost", "--lk-fs", "--lk-m"]) el.style.removeProperty(p);
      delete el.dataset.tc; delete el.dataset.tn; delete el.dataset.tb; delete el.dataset.tm;
      if (awake && wallUrl) {   // late (a slow line): it fades in over the preview, or the dark grey
        wl.classList.remove("lk-wf"); void wl.offsetWidth; wl.classList.add("lk-wf");
        probe();
      }
    },
    setSoft(src) {
      soft = src || null;
      el.style.setProperty("--lk-soft", soft ? `url(${JSON.stringify(soft)})` : "none");
      if (awake) probe();
    },
    wake() {
      if (!awake && !gone) {
        awake = true;
        void el.offsetWidth;   // the black is painted before it starts to clear
        el.classList.add("is-awake");
        onMinute();
        probe();
        const lit = TL.black + TL.wake;
        cards.forEach((c, k) => later(() => place(k), lit + TL.noteFirst + k * TL.noteGap));
      }
      return new Promise((r) => later(r, TL.black + TL.wake));
    },
    setProgress(f) {
      f = Math.max(progress, Math.min(1, Number(f) || 0));   // never back
      progress = f;
      if (bar) { bar.style.transform = `scaleX(${f.toFixed(3)})`; return; }
      arc.style.strokeDashoffset = (RING * (1 - f)).toFixed(2);
      arc.style.opacity = f > 0 ? "1" : "0";
    },
    ready() { lock.setProgress(1); el.classList.add("is-ready"); },
    press() {   // the tap's feedback
      el.classList.add("is-press");
      return new Promise((r) => later(r, TL.press));
    },
    unlock() {
      if (full) return lock.press();   // the flow then moves the layer
      el.classList.add("is-unlock");
      return new Promise((r) => later(r, TL.unlock));
    },
    dispose() {
      gone = true;
      timers.forEach((t) => win.clearTimeout(t)); timers = [];
      win.clearTimeout(minute);
      el.remove();
    },
  };
  tick();
  if (wall || !pre) lock.setWall(wall);   // (the first frame's tones stay until the probe's)
  const r = box.getBoundingClientRect && box.offsetWidth ? [box.offsetWidth, box.offsetHeight] : null;
  if (r) lock.resize(r[0], r[1]);
  else lock.resize(1440, 900);
  return lock;
}

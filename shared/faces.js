// (DYS-149: the hand-over restyle) The web fonts a document already declares, and a style sheet's text without the
// @font-face rules it would only repeat.
//
// The homepage declares its three faces (Geist, Cormorant Garamond roman and italic: the same three files everywhere)
// in style.css, print.js and notebook.js, and the sheets put in while it runs declared them again: reader.css at the
// boot, world.css when the router fetches the page spots' files (prefetchPages, 1-1.6 s after the room is shown) or a
// glide brings a page in. A repeated rule is a second FontFace for the same file: the browser makes it the face in use
// (the last declared wins), loads the file again, and as each load ends it restyles and lays out the whole document
// again ("the fonts changed"). On the slow laptop (barely-sufficient, 30 Oct traces pb1 / md2 / bc2) that was a
// 10-19 ms restyle of every element and three layouts of 5-45 ms in the next frames, 54-148 ms frames after the
// hand-over; the boot's reader.css and the notebook's rule cost ~80 ms of layout more before the room was shown.
// Dropping only a rule that is the same, descriptor for descriptor, as one the document has already leaves the same
// file as the face in use: nothing on screen changes.
//
// Browser modules: on import only the address is read, in a try (node tests import router.js and notebook.js).

// (DYS-149 pre-merge review) the one switch, read here for router.js (putSheet) and notebook.js (its own CSS) alike:
// ?restyle=0 puts the sheets in as <link>s and keeps every @font-face rule, as before
export const RESTYLE = (() => { try { return new URLSearchParams(location.search).get("restyle") !== "0"; } catch { return true; } })();

// whether a sheet's text names a file relative to its own address, which a <style> would read from the page's address
// instead (router.js puts such a sheet in as a <link>): any @import (its URL, and its own sheet's), a relative url(),
// a relative string in image-set() (-webkit- too; its url() and type() left to the rules above). Not relative: a
// scheme (data:, https:), a path from the root ("/fonts/..."), a fragment. (RS1, 31 Oct: the url() rule read the quote
// and spaces first, or every url("/fonts/...") counted as relative by skipping the quote)
const RELATIVE_URL = /url\(\s*['"]?\s*(?![a-z][a-z0-9+.-]*:|\/|#|['"\s])/i;
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
export function ownURLs(css) {
  if (/@import/i.test(css) || RELATIVE_URL.test(css)) return true;
  const set = /(?:-webkit-)?image-set\(/gi;
  for (let m = set.exec(css); m; m = set.exec(css)) {
    let i = set.lastIndex, depth = 1;
    const from = i;
    while (i < css.length && depth) { const c = css[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
    const body = css.slice(from, i - 1).replace(/(?:url|type)\([^)]*\)/gi, "");
    for (const s of body.matchAll(/(['"])(.*?)\1/g)) if (!ABSOLUTE.test(s[2].trim())) return true;
  }
  return false;
}

const DESCRIPTORS = ["font-family", "src", "font-style", "font-weight", "font-stretch", "font-display", "unicode-range",
  "font-feature-settings", "font-variation-settings", "ascent-override", "descent-override", "line-gap-override", "size-adjust"];

// a face's whole declaration (its descriptors as the browser reads them; its text where those cannot be read)
function key(rule) {
  const s = rule.style;
  const v = s ? DESCRIPTORS.map((p) => s.getPropertyValue(p).trim()) : [];
  return v[0] && v[1] ? v.join("|") : `text:${rule.cssText}`;
}

// every @font-face rule at the top level of the document's style sheets that apply and stay: a sheet it cannot read, a
// disabled one, one for other media, and a hosted page's own <style> (router.js data-sfw-page: taken out again when the
// page goes) are skipped
export function declaredFaces(doc = document) {
  const out = new Set();
  for (const sheet of doc.styleSheets) {
    if (sheet.disabled || sheet.ownerNode?.hasAttribute?.("data-sfw-page")) continue;
    const media = sheet.media?.mediaText;
    if (media && media !== "all" && !matchMedia(media).matches) continue;
    let rules = null;
    try { rules = sheet.cssRules; } catch { /* (another origin's sheet) */ }
    for (const r of rules || []) if (r instanceof CSSFontFaceRule) out.add(key(r));
  }
  return out;
}

// css without the @font-face rules the document already declares, identically. Each rule is read by the browser's own
// parser (a constructed sheet, never applied); where that cannot be done (no constructable sheets) the text is
// returned as it was.
export function withoutRepeatedFaces(css, doc = document) {
  if (typeof CSSStyleSheet !== "function" || typeof CSSStyleSheet.prototype.replaceSync !== "function" || !/@font-face/i.test(css)) return css;
  let have;
  try { have = declaredFaces(doc); } catch { return css; }
  if (!have.size) return css;
  return css.replace(/@font-face\s*\{[^{}]*\}/gi, (block) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(block);
      const r = sheet.cssRules[0];
      return r instanceof CSSFontFaceRule && have.has(key(r)) ? "" : block;
    } catch {
      return block;
    }
  });
}

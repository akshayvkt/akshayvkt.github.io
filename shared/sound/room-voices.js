// DYS-231: the room's touches in other voices, for Akshay to choose between (engine.js plays one when the page is
// opened with ?roomsnd=lamp:a,book:b,page:c; without it, today's voices in engine.js's CUES). Shape:
//   { lamp: { a: fn, b: fn, c: fn }, book: {...}, "book-home": {...}, page: {...}, elastic: {...}, "cover-open": {...},
//     "cover-close": {...} }
// Each fn is (t, p, o, k) => void, like engine.js's CUES entries (t the start, p the pan, o the cue's options), plus
// k = { eng, MIX, out, send }: the engine's instrument context, its mix levels, the room bus and the room's reverb send
// (the same output path today's voices use). All live synthesis (shared/sound/instruments.js, dsp.js): no recordings.
//   room-shelf.js     the lamp, the book pulled out, the book pushed home (DYS-231 H2)
//   room-notebook.js  the page, the elastic, the cover (DYS-231 H5)
import { SHELF_VOICES } from "./room-shelf.js";
import { NOTEBOOK_VOICES } from "./room-notebook.js";

export const ROOM_VOICES = { ...SHELF_VOICES, ...NOTEBOOK_VOICES };

// The voices that play by default: Akshay's picks (2 Nov 15:09, DYS-231). ?roomsnd=<cue>:<option> still picks another
// per cue (e.g. ?roomsnd=lamp:a), and <cue>:today plays the cue's old voice (engine.js CUES).
export const ROOM_DEFAULTS = { lamp: "c", book: "c", "book-home": "a", page: "c", elastic: "c", "cover-open": "a", "cover-close": "b" };

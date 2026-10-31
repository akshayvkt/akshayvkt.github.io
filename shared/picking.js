// Pointer picking in the live room: what is under the pointer, and which spot it leads to.
//
//   import { Picker } from "/shared/picking.js";
//   const picker = new Picker({ engine, room, onHover: (hit) => …, onPick: (hit) => … });
//   picker.at(x, y)   // -> Promise<{ object, spot } | null>   (client px)
//   picker.hover(x, y)
//
// The engine's own ID buffer answers (E1: engine.pick, an async one-pixel read, cheap enough for every pointer
// move). Its object names map to spots through spots.json's "pick" table: the shelf and every book lead to the
// shelf, the laptop and its screen to the laptop, and so on. The lamp is its own object (the switch, stream I)
// and leads nowhere. Without the engine (photo mode) the photograph's hotspots in app.js do this job.

export class Picker {
  constructor({ engine, room, onHover = () => {}, onPick = () => {} }) {
    this.engine = engine;
    this.room = room;
    this.onHover = onHover;
    this.onPick = onPick;
    this.pending = false;
    this.next = null;
    this.last = null;
  }

  spotOf(object) {
    if (!object) return null;
    const table = this.room.data.pick || {};
    const key = object.startsWith("book:") ? "book" : object;
    return table[key] || null;
  }

  async at(x, y) {
    if (!this.engine?.pick) return null;
    try {
      const hit = await this.engine.pick(x, y);
      if (!hit) return null;
      return { object: hit.object, spot: this.spotOf(hit.object) };
    } catch { return null; }
  }

  // One read in flight at a time; the latest position wins.
  hover(x, y) {
    this.next = [x, y];
    if (this.pending) return;
    this.pending = true;
    const run = async () => {
      const [px, py] = this.next;
      this.next = null;
      const hit = await this.at(px, py);
      const key = hit ? hit.object : null;
      if (key !== this.last) { this.last = key; this.onHover(hit); }
      if (this.next) run(); else this.pending = false;
    };
    run();
  }

  async click(x, y) {
    const hit = await this.at(x, y);
    if (hit) this.onPick(hit);
    return hit;
  }
}

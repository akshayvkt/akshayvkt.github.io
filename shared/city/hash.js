// Integer hashes for the city clock. Every decision the city makes (is there a ship in this 20-minute cycle, is this
// window lit tonight) is a hash of small integers: no sin(), no floating-point noise, so two browsers agree bit for
// bit. 32-bit integer maths only (Math.imul and >>> are exact everywhere); GLSL below gives the same numbers on a GPU.

// lowbias32 (Chris Wellons): a strong 32-bit mixer
function mix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// hash of up to four integers (each reduced to 32 bits) -> uint32
export function hash(a, b = 0, c = 0, d = 0) {
  let h = mix((a | 0) ^ 0x9e3779b9);
  h = mix((h + (b | 0)) ^ 0x85ebca6b);
  h = mix((h + (c | 0)) ^ 0xc2b2ae35);
  h = mix((h + (d | 0)) ^ 0x27d4eb2f);
  return h;
}

// uniform in [0, 1)
export const u01 = (a, b, c, d) => hash(a, b, c, d) / 4294967296;

// uniform in [lo, hi)
export const range = (lo, hi, a, b, c, d) => lo + (hi - lo) * u01(a, b, c, d);

// Seeds: one per event family, so no two families ever share a draw.
export const SEED = {
  bridge: 101, beacon: 102, plane: 103, ship: 104, cruise: 105, tour: 106, sail: 107, gull: 108,
  window: 109, lamp: 110, horn: 111, cable: 112, visitor: 113, ferry: 114, street: 115,
};

// The same hash in GLSL ES 3.00 (WebGL2), for per-cell decisions in a shader (windows, lamps).
export const GLSL_HASH = `
uint cityMix(uint h) { h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u; return h; }
uint cityHash(uint a, uint b, uint c, uint d) {
  uint h = cityMix(a ^ 0x9e3779b9u);
  h = cityMix((h + b) ^ 0x85ebca6bu);
  h = cityMix((h + c) ^ 0xc2b2ae35u);
  h = cityMix((h + d) ^ 0x27d4eb2fu);
  return h;
}
float cityU01(uint a, uint b, uint c, uint d) { return float(cityHash(a, b, c, d) >> 8u) / 16777216.0; }
`;
// Note: the GLSL float drops the low 8 bits (float32 holds 24); compare thresholds with the same >> 8 on the CPU
// (u24 below) when a decision must match the shader exactly.
export const u24 = (a, b, c, d) => (hash(a, b, c, d) >>> 8) / 16777216;

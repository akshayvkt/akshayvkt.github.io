// (DYS-232 WATER) a boat's wake in GLSL, shared by the engine's outside (gl/outside.glsl.js water()) and the 2D living
// layer (js/shaders.js water()): both read uBoatP / uBoatQ / uBoatR / uBoatS / uBoatT[16] (outside-events.js boatWake,
// js/boats.js wakes()), uSun, uMoment, uTime and COMMON's noise(), with P metres on the bay (right, forward of the eye)
// and foot the metres a pixel spans (right, forward).
export const BOAT_WAKE_GLSL = `// (DYS-232 WATER, after D's review and CHECKS' photos from a height) a boat's wake (uBoatR.w, its speed, > 0; the big
// ships keep theirs, below) follows the boat's own past path: bow -> centre -> three points where the centre was
// (uBoatS.xy, .zw, uBoatT.xy, newest first; straight on past the last), measured from the bow along it (d) and across it
// (lat) at the nearest segment, so on a tack or a bend the V curves the way the boat came instead of swinging with the
// hull. White water: the churn behind the stern for 1-3 lengths (two tracks behind a catamaran), then, for a fast boat,
// a long narrow lane of foam streaks (30-50 lengths, fading slowly: from 1-3 deg up that lane is what one sees first; a
// sloop's is short and faint), broken by grain that stays put in the water (on the boat's odometer, uBoatT.w), bubbly at
// the stern, in lines along the track behind; two curls hugging the bow's first third and flaring into the arms; foam
// on the arms only near a fast hull; the propellers' wash at the stern (uBoatR.y: a ferry backing off or reaching its
// berth). Under the lane a smooth slick that damps the ripples (cat's paws, streaks, glitter) and mirrors the bright
// sky near the horizon (water(): its glare). The V's arms (their crests running out at 35.26 deg, spaced 2/3 x 2 pi v^2
// / g) and the transverse crests between them (2 pi v^2 / g) as a change of light and of glitter, never white, over
// half the lane's length. Round the hull the water a little darker; on the side away from the sun the boat's shadow
// takes the sun's glitter off. Every narrow feature is widened to the pixel it falls in and dimmed to keep its amount;
// grain and crests fade to their mean where a pixel spans them (no shimmer far out).
// (DYS-232 ships, D) A big ship takes the same wake (uBoatT.z < 0: -z its white water, 0.05..1, by its Froude number
// v / sqrt(g L), outside-events.js shipWakeRow / js/boats.js: a 350 m container ship at 12 kn ~0.2, the tug and barge
// ~0.55, where a fast ferry's speed gives it 1). At a hull's scale of 130-350 m moving slowly for its size: a white crest
// at the stem and the bow's two curls (uBoatR.x), the propellers' churn for a length or so, then mostly the slick, a few
// beams wide however far back (a boat's widens 12 m a km, a ship's 1.5) with a thin white core, the arms as light with
// hardly any foam, their crests spaced by its real speed.
// (DYS-232 ships, W1) A big ship's white water goes into its own sum (foamS), lit as flat foam is (wkShipFoamC): water()
// colours it as the boats' (uFoam, the white walls) where those walls are in the sun, as the sky lights it where not.
const float KELVIN_T = 0.35355339;                          // tan 19.47 deg
const float KELVIN_C = 0.81649658, KELVIN_S = 0.57735027;   // cos, sin 35.26 deg (the arms' crests' direction of travel)
// value noise faded to its mean where a pixel covers a grain, axis by axis (fp: grains per px across, along): seen
// edge-on (a lane across the view, its width a fraction of a pixel) the grain along it stays
float wkGrain(vec2 p, vec2 fp) {
  float n = mix(noise(p), 0.5 + 0.8 * (noise(vec2(17.3, p.y)) - 0.5), smoothstep(0.35, 1.0, fp.x));
  return mix(n, 0.5, smoothstep(0.35, 1.0, fp.y));
}
float wkG(float x, float w) { return exp(-(x * x) / (w * w)); }
// the fraction of a pixel's span [x - s, x + s] inside [-hs, hs]
float wkBox(float x, float hs, float s) { return clamp((min(hs, x + s) - max(-hs, x - s)) / (2.0 * s), 0.0, 1.0); }
// the nearest point of segment A-B (acc m along the path at A): its distance^2, d, signed lat and the path's direction
void wkSeg(vec2 P, vec2 A, vec2 B, float acc, float lo, float hi, inout float best, inout vec3 dl, inout vec2 tg) {
  vec2 AB = B - A;
  float L2 = dot(AB, AB);
  if (L2 < 1e-4) return;
  float Ls = sqrt(L2);
  float t = clamp(dot(P - A, AB) / L2, lo, hi);
  vec2 dP = P - (A + AB * t), u = AB / Ls;
  float q = dot(dP, dP);
  if (q < best) { best = q; tg = u; dl = vec3(acc + t * Ls, (dP.x * u.y - dP.y * u.x < 0.0 ? -1.0 : 1.0) * sqrt(q), Ls); }
}
// (DYS-232 ships, W1) the colour of a big ship's white water. Foam lies flat on the water, so the whole sky lights it
// from above: a flat white under the sky is about as bright as the sky (x its albedo), wherever the sun is (uFoamSky,
// outside.js / live.js: the photo's sky 8-24 deg up x 0.9, an albedo of 0.8 in linear light; the sun on it only adds).
// uFoam, the photo's white walls, face us: with a low sun ahead (backlit, 16:06) they are in shade, as dark as the
// water. The brighter of the two by luminance, eased over +-0.05 (no jump as the moments change): in the sun (14:50)
// the walls', as before; backlit the sky's, a cooler, brighter white.
vec3 wkShipFoamC() { return mix(uFoam, uFoamSky, smoothstep(-0.05, 0.05, dot(uFoamSky - uFoam, vec3(0.2126, 0.7152, 0.0722)))); }
void boatWake(int i, vec2 P, vec2 foot, inout float foam, inout float foamS, inout float slick, inout float wave, inout float shade, inout float sunCut) {
  vec4 bp = uBoatP[i], bq = uBoatQ[i], br = uBoatR[i], bs = uBoatS[i], bt = uBoatT[i];
  float len = bq.x, hb = 0.5 * bq.y, dMax = bq.z, dim = bq.w, v = br.w, cat = max(bt.z, 0.0), wash = br.y;
  float ship = max(-bt.z, 0.0), big = step(1e-4, ship);   // (DYS-232 ships: a big ship, its white water)
  // (DYS-232 sails, E) a sailboat: its rig (br.z) over ~0.7 of its length, a mast, not a cabin (outside-events.js boatWake,
  // js/boats.js: a sail's 1.25 of its length and more, a powered boat's ~0.25). No propeller: from a height its wake
  // hardly shows (refs fromabove-01, Akshay's "still wrong": the lane ~30 lengths), so its white lane a fifth and its
  // churn 0.4 of a powered boat's at its speed; its slick, its V and its shadow as before
  float sailK = smoothstep(0.6, 0.9, br.z / max(len, 1.0));
  vec2 c = bp.xy, h = bp.zw, hp = vec2(h.y, -h.x);
  vec2 r = P - c;
  float reach = dMax + len;
  if (dot(r, r) > reach * reach) return;
  float alongH = dot(r, h), acrossH = dot(r, hp);
  float mxh = sqrt(pow(foot.x * hp.x, 2.0) + pow(foot.y * hp.y, 2.0));
  // its shadow on the water: the hull and its rig (br.z m high) swept away from the sun, a sail's narrowing to its top
  // (from a height it shows mostly as the sun's glitter taken off: water() darkens it only a little)
  if (br.z > 0.0 && uSun.z > 0.02 && uMoment.w > 0.0) {
    float sl = length(uSun.xy);
    float Ls = min(br.z * sl / uSun.z, 10.0 * br.z);
    if (dot(r, r) < pow(Ls + len, 2.0)) {
      vec2 sd = -uSun.xy / max(sl, 1e-4);
      float u = clamp(dot(r, sd), 0.0, Ls);
      float k = mix(1.0, br.z > len ? 0.15 : 0.8, u / max(Ls, 1e-3));
      vec2 q = r - sd * u;
      float sx = 0.5 * sqrt(pow(foot.x * h.x, 2.0) + pow(foot.y * h.y, 2.0)) + 0.1 * hb;
      float sy = 0.5 * mxh + 0.1 * hb;
      sunCut = max(sunCut, dim * wkBox(dot(q, h), 0.5 * len * k, sx) * wkBox(dot(q, hp), hb * k, sy));
    }
  }
  // round the hull the water a little darker (its shade and the calm along its sides), as the ships'
  float alphaA = dim / max(1.0 - 0.85 * uMoment.x, 0.15);
  vec2 dOut = max(vec2(abs(alongH) - 0.5 * len, abs(acrossH) - hb), 0.0);
  shade = max(shade, 0.1 * alphaA * exp(-pow(length(dOut) / (hb * 0.9 + mxh), 2.0)));
  // the propellers' wash (br.y: + going ahead from rest, - backing off or stopping): boiling white water at the stern,
  // thrown aft, or forward along the hull's sides when backing (a ferry leaving or reaching its berth), in its own frame
  if (abs(wash) > 0.01) {
    float sgn = wash > 0.0 ? 1.0 : -1.0;
    float ca = -0.5 * len - 0.45 * len * sgn;                       // aft of the stern ahead, along the hull astern
    float myh = sqrt(pow(foot.x * h.x, 2.0) + pow(foot.y * h.y, 2.0));
    float la0 = 0.55 * len, wa0 = hb * (1.5 + 0.8 * max(-sgn, 0.0));
    float la = sqrt(la0 * la0 + 0.5 * myh * myh), wa2 = sqrt(wa0 * wa0 + 0.5 * mxh * mxh);
    float blob = exp(-pow((alongH - ca) / la, 2.0) - pow(acrossH / wa2, 2.0)) * (la0 / la) * (wa0 / wa2);
    if (blob > 0.003) {
      float gW = wkGrain(vec2(acrossH / 1.1 - uTime * 0.2, alongH / 1.3 + uTime * 0.35), vec2(mxh / 1.1, myh / 1.3));
      foam += abs(wash) * dim * blob * (0.5 + 1.4 * smoothstep(0.3, 0.75, gW));
      slick = max(slick, 0.6 * abs(wash) * dim * blob);
    }
  }
  // the rest only under way (a boat at rest leaves no V and no lane)
  float go = smoothstep(0.4, 2.5, v);
  if (go <= 0.0) return;
  // where on the path the bow came by
  float best = 1e20;
  vec3 dl = vec3(0.0);
  vec2 tg = -h;
  vec2 V0 = c + h * (0.5 * len);
  wkSeg(P, V0, c, 0.0, -1e9, 1.0, best, dl, tg);
  float acc = 0.5 * len;
  wkSeg(P, c, bs.xy, acc, 0.0, 1.0, best, dl, tg);
  acc += length(bs.xy - c);
  wkSeg(P, bs.xy, bs.zw, acc, 0.0, 1.0, best, dl, tg);
  acc += length(bs.zw - bs.xy);
  wkSeg(P, bs.zw, bt.xy, acc, 0.0, 1e9, best, dl, tg);
  float d = dl.x, lat = dl.y, al = abs(lat);
  // the V's arms reach about half the lane's length; past them only the lane, a few beams wide
  float dArm = 0.5 * dMax;
  float W = 0.5 * hb + KELVIN_T * max(d, 0.0);
  float edgeW = d < dArm ? W + 2.0 * hb + 0.04 * max(d, 0.0) : mix(3.0 * hb + 0.012 * d, 2.6 * hb * (1.3 + 0.0015 * max(d - len, 0.0)), big);
  if (d > dMax || d < -0.3 * len || al > edgeW + 2.0 * mxh) return;
  vec2 n = vec2(tg.y, -tg.x);
  float mx = sqrt(pow(foot.x * n.x, 2.0) + pow(foot.y * n.y, 2.0));    // m per px across the path
  float my = sqrt(pow(foot.x * tg.x, 2.0) + pow(foot.y * tg.y, 2.0));  // and along it
  float str = big > 0.5 ? ship : clamp((v - 2.0) / 5.5, 0.15, 1.0);
  float ds = max(d - len, 0.0);
  float tail = 1.0 - smoothstep(0.7 * dMax, dMax, d);
  float s = bt.w - d;                                                  // m along the track, fixed in the water
  // white water: the churn behind the stern, the bow's curls, the arms' first part (by speed; bq.w the boat's fade)
  float wc = (cat > 0.0 ? 0.4 : 1.0) * hb * mix(0.8 + 0.04 * ds, 0.9 + 0.0015 * ds, big);   // (a ship's wash about a beam wide)
  float wcE = sqrt(wc * wc + 0.5 * mx * mx);
  float churn = mix((1.0 - 0.6 * sailK) * (0.15 + 0.85 * str * str), 1.0 + 0.3 * str, big) * wkG(al - cat, wcE) * (wc / wcE) * exp(-ds / (len * mix(0.6 + 1.2 * str, 1.0 + 0.5 * str, big)))
              * smoothstep(0.8 * len, len, d);
  float hw = (cat > 0.0 ? cat + 0.4 * hb : hb) * clamp(d / (0.35 * len), 0.15, 1.0) + KELVIN_T * 0.7 * max(0.0, d - 0.3 * len);
  float cw = 0.22 * hb + 0.02 * max(d, 0.0);
  float cwE = sqrt(cw * cw + 0.5 * mx * mx);
  float curl = wkG(al - hw, cwE) * (cw / cwE) * smoothstep(-mix(0.08, 0.01, big) * len, 0.0, d) * (1.0 - smoothstep(0.3 * len, 0.7 * len, d));
  float wf = 0.2 * hb + 0.02 * max(d, 0.0);
  float wfE = sqrt(wf * wf + 0.5 * mx * mx);
  float armF = wkG(al - W, wfE) * (wf / wfE) * exp(-ds / (len * (0.2 + 1.3 * str))) * smoothstep(0.4 * len, 0.8 * len, d);
  // the lane (CHECKS' photos from a height: a fast boat drags a long, narrow, bright white lane, 30-50 of its lengths,
  // fading slowly; a sloop's is short and faint): streaks of foam along the track behind the churn, a beam or two wide
  float wl = hb * mix(0.9 + 0.006 * ds, 0.7 + 0.001 * ds, big);
  float wlE = sqrt(wl * wl + 0.5 * mx * mx);
  float laneK = mix(0.75 * smoothstep(0.1, 0.6, str) * (1.0 - 0.8 * sailK), 0.35 + 0.5 * str, big);
  float lane = laneK * wkG(lat, wlE) * (wl / wlE) * exp(-ds / (len * mix(3.0 + 22.0 * str, 2.5 + 5.0 * str, big))) * smoothstep(0.5 * len, 1.5 * len, d);
  // (a ship's stem: the white crest its bow pushes just ahead of it, a beam wide)
  float st0 = 0.02 * len, stE = sqrt(st0 * st0 + 0.5 * my * my), stW = hb * 0.9;
  float stem = big * wkG(d + 0.012 * len, stE) * (st0 / stE) * wkG(lat, sqrt(stW * stW + 0.5 * mx * mx)) * (stW / sqrt(stW * stW + 0.5 * mx * mx));
  float white = dim * (churn + lane) + br.x * (curl + 0.8 * armF * (1.0 - 0.7 * big) + 2.4 * stem);
  if (white > 0.002) {
    // broken: bubbly at the stern, streaky along the track further back (lines of foam with gaps), slowly changing
    vec2 fpB = vec2(mx / 0.7, my / 0.9), fpS = vec2(mx / 1.4, my / 22.0);
    float gB = wkGrain(vec2(lat / 0.7 + uTime * 0.05, s / 0.9 - uTime * 0.04), fpB);
    float gS = wkGrain(vec2(lat / 1.4, s / 22.0 + uTime * 0.01), fpS);
    float gC = wkGrain(vec2(lat / 2.6 - uTime * 0.03, s / 3.1), vec2(mx / 2.6, my / 3.1));
    float g = mix(gB, gS, smoothstep(0.0, 2.0 * len, ds)) * 0.65 + gC * 0.45;
    white *= 0.25 + 1.3 * smoothstep(0.3, 0.75, g);
    if (big > 0.5) foamS += white * tail * go; else foam += white * tail * go;   // (a ship's: wkShipFoamC)
  }
  // the slick: past the churn, a smooth lane a few beams wide, a long way back (water() lights it with the sky's glare)
  float wsl = hb * mix(1.4 + 0.012 * ds, 1.3 + 0.0015 * ds, big);
  float wslE = sqrt(wsl * wsl + 0.5 * mx * mx);
  slick = max(slick, go * dim * mix(0.55 + 0.45 * str, 0.85, big) * wkG(lat, wslE) * (wsl / wslE) * smoothstep(0.0, 0.8 * len, ds)
                     * exp(-ds / (0.6 * dMax)) * tail);
  // the V's arms and the transverse crests between them: waves, a change of light
  if (d < dArm) {
    float Aw = go * dim * mix(0.35 + 0.65 * str, 0.45 + 0.4 * str, big) * pow(len / (len + max(d, 0.0)), 0.33) * exp(-d / (0.5 * dArm)) * (1.0 - smoothstep(0.7 * dArm, dArm, d));
    float wa = mix(0.3 * hb + 0.025 * max(d, 0.0), 0.15 * hb + 0.012 * max(d, 0.0), big);
    float waE = sqrt(wa * wa + 0.5 * mx * mx);
    float band = wkG(al - W, waE) * (wa / waE) * smoothstep(0.2 * len, 0.8 * len, d);
    float lam = max(4.18879 * v * v / 9.81, 0.3);
    float fpa = sqrt(pow(my * KELVIN_C, 2.0) + pow(mx * KELVIN_S, 2.0)) / lam;
    float crest = cos(6.2831853 * (al * KELVIN_S - d * KELVIN_C) / lam) * (1.0 - smoothstep(0.25, 0.5, fpa));
    float lamT = 1.5 * lam;
    float inV = 1.0 - smoothstep(0.55 * W, 0.95 * W, al);
    float crestT = cos(6.2831853 * d / lamT) * (1.0 - smoothstep(0.25, 0.5, my / lamT));
    wave += Aw * (band * (0.45 + 0.8 * crest) + 0.5 * inV * crestT * smoothstep(0.5 * len, 1.5 * len, d));
  }
}
`;

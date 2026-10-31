// Data tables for the city clock. Sources are in docs/v3/city.md; "est." marks an estimate, not a measurement.

// ---------------------------------------------------------------- Golden Gate Bridge traffic
// Vehicles per hour [southbound, northbound] by local hour, PeMS May 2012 read off AECOM 2013 fig. 8 (+-10%).
export const BRIDGE_HOURLY = {
  weekday: [[250, 500], [200, 280], [180, 170], [200, 130], [550, 150], [1500, 350], [3000, 750], [4700, 2000],
    [5200, 3200], [4400, 2600], [3300, 2000], [3250, 2450], [2800, 2400], [2950, 2800], [3200, 4000], [3050, 4100],
    [3500, 4300], [4400, 5200], [3500, 5200], [2400, 3300], [1900, 2600], [1000, 2100], [520, 1100], [350, 950]],
  saturday: [[600, 1500], [450, 700], [400, 450], [300, 200], [400, 150], [550, 250], [1200, 500], [1450, 1000],
    [2400, 1800], [3400, 3300], [4000, 3900], [4400, 4250], [4000, 4200], [3300, 3300], [3800, 3700], [4400, 3800],
    [4500, 4400], [3300, 3600], [3500, 2800], [2800, 2600], [2500, 2200], [2200, 2100], [2000, 2000], [1100, 1150]],
  sunday: [[600, 700], [500, 550], [400, 400], [380, 250], [450, 180], [650, 250], [1300, 450], [1300, 900],
    [1700, 1200], [2200, 1600], [3200, 2900], [3700, 3300], [3600, 3900], [3300, 3000], [3200, 2600], [3700, 3200],
    [4300, 3700], [4200, 3700], [3500, 2700], [2900, 2100], [2600, 1800], [2000, 1600], [1300, 1100], [700, 600]],
};
// 2025 vs pre-pandemic (GGBHTD monthly report, Oct 2025): x0.87 overall; weekday 07-09 southbound x0.75 and
// 15-19 northbound x0.93 instead (plan 2.3 #1).
export const BRIDGE_SCALE = { total: 0.87, sbAm: 0.75, sbAmHours: [7, 8], nbPm: 0.93, nbPmHours: [15, 16, 17, 18] };
// Moveable median, weekdays: 4 southbound / 2 northbound 05:00-10:00, else 3/3 (plan; GGBHTD "~05:30 and ~10:30").
// The swing lane closes for 8 minutes while the barrier moves (est.).
export const BRIDGE_LANES = { swingSb: [5 * 3600, 10 * 3600], closure: 480 };
export const BRIDGE_TRAFFIC = {
  cell: 30,            // m: at most one vehicle per 30 m cell of a lane
  heavy: 0.05,         // share of buses and trucks
  v0: 20.5,            // m/s, mean speed (45 mph limit); peaks slow by up to 8% (est.), integrated in closed form
  slow: 0.08,
  capacity: 1800,      // vehicles per hour per lane (est.)
  knot: 900,           // s between speed knots (UTC quarter hours)
};

// ---------------------------------------------------------------- street traffic (the streets seen from the desk)
// Share of the day's traffic by local hour (%), Texas A&M Transportation Institute, 2011 Congested Corridors Report,
// Appendix B (713 continuous count stations): non-freeway, weekday at severe congestion (Exhibit B-4) in the AM-peak and
// PM-peak directions, and weekend (Exhibit B-5); read from the charts' vector paths (renders/st/tti_hourly_profiles.json)
export const STREET_PROFILE = {
  am: [0.83, 0.5, 0.4, 0.31, 0.64, 2.08, 5.14, 7.16, 6.2, 5.2, 5.23, 5.65, 6.05, 6.11, 6.41, 6.81, 6.97, 6.81, 5.65, 4.57,
    3.66, 3.13, 2.47, 1.64],
  pm: [1.01, 0.6, 0.45, 0.34, 0.53, 1.37, 3.47, 5.57, 5.61, 5.0, 5.13, 5.78, 6.23, 6.24, 6.67, 7.55, 7.82, 7.75, 6.28, 5.07,
    4.21, 3.63, 2.6, 1.93],
  weekend: [2.0, 1.37, 0.91, 0.53, 0.5, 0.76, 1.53, 2.42, 3.4, 4.71, 5.89, 6.83, 7.67, 7.59, 7.64, 7.62, 7.42, 6.86, 6.02,
    5.09, 4.24, 3.64, 2.95, 2.24],
};
// Vehicles a day in one direction, per street direction of routes.json streets (scripts/city_clock/streets.json ids;
// "r" is the reverse direction of a two-way street). Counts: SFMTA Traffic Count Data 1993-2015 (24-hour counts);
// peak: the TTI profile the count's own AM/PM peak hours point to. { bridge, dir }: a share of the Golden Gate Bridge's
// hourly flow in that direction (0 south, 1 north), for the bridge's approaches. Weekend: the weekend count where SFMTA
// has one, else weekday x STREET_TRAFFIC.weekendShare. lanes: the lanes drawn, where OSM's tag on the piece is wrong.
export const STREET_FLOW = {
  // (Lombard, v3/traffic-motion M6: SFMTA's counts x 0.924, to Caltrans's 2024 AADT at Broderick St (US-101 PM 7.786,
  // 42,500 back / 45,000 ahead: 43,750 both ways, all days; the counts gave 47,359), keeping their weekday / weekend and
  // direction splits. Caltrans Traffic Volumes AADT 2024, https://caltrans-gis.dot.ca.gov/arcgis/rest/services/
  // CHhighway/Traffic_AADT/MapServer/0, fetched 26 Oct 2026)
  "23876482": { weekday: 23859, weekend: 22319, peak: "pm" },   // Lombard St (US-101) westbound: E of Pierce, Wed 4 May 2011 (25,827); E of Broderick, Sat 7 Nov 2015 (24,160)
  "31780017": { weekday: 21513, weekend: 17379, peak: "am", lanes: 3 },   // Lombard St (US-101) eastbound: E of Pierce 2011 (23,287); E of Broderick, Sun 8 Nov 2015 (18,812) (three lanes, as westbound; OSM tags this piece 1)
  "31780013": { weekday: 3963, peak: "pm" },                    // Lombard St westbound, W of Baker, Mon 6 Jun 2005
  "31780013r": { weekday: 3289, peak: "pm" },                   // Lombard St eastbound, W of Baker, 2005
  // the bridge plaza's links (to US-101 north and the Welcome Center's lot), fed from Lincoln Blvd (routes.json streets[].link):
  // STREET_TURN.branch of Lincoln's class estimate (est.)
  "427283891": { weekday: 600, peak: "pm" }, "397086250": { weekday: 600, peak: "pm" }, "26965387": { weekday: 600, peak: "pm" },
  "26965499": { weekday: 600, peak: "pm" }, "791435101": { weekday: 600, peak: "pm" },
  "8916287": { weekday: 9652, peak: "am" },                     // Marina Blvd westbound, W of Buchanan, Wed 13 Feb 2008
  "8916287r": { weekday: 12668, peak: "am" },                   // Marina Blvd eastbound, W of Lyon, Mon 25 Sep 2000
  "91187852": { weekday: 2617, peak: "am" },                    // Divisadero St southbound, N of Chestnut, Tue 30 Mar 1999
  "91187852r": { weekday: 4730, peak: "pm" },                   // Divisadero St northbound, S of Chestnut, 1999
  "88142686": { weekday: 5000, peak: "pm" },                    // Bay St westbound (est.: SFMTA E of Buchanan/Fillmore 2012, 4,600-5,500)
  "88142686r": { weekday: 5000, peak: "am" },                   // Bay St eastbound (est., as above)
  "417104573": { bridge: 0.7, dir: 1 },                         // Presidio Pkwy (US-101) to the bridge (est.: Lombard + Marina westbound ~ 0.7 of it)
  "1564594100": { bridge: 0.25, dir: 0 },                       // Presidio Pkwy from the bridge, one-lane carriageway (est.)
  "59763339": { bridge: 0.3, dir: 1 },                          // Veterans Blvd to the bridge, from Park Presidio (CA-1) (est.)
  "161493573": { bridge: 0.3, dir: 0 },                         // CA-1 from the bridge to Park Presidio (est.)
};
// Streets without a count of their own (the Presidio's roads, short glimpses): by road class (est.)
export const STREET_DEFAULT = {
  motorway: { bridge: 0.05, dir: 1 }, trunk: { weekday: 8000, peak: "pm" }, primary: { weekday: 5000, peak: "pm" },
  secondary: { weekday: 3000, peak: "pm" }, tertiary: { weekday: 2000, peak: "pm" },
  // residential streets the window sees down their length (Greenwich, Filbert: not in SFMTA's counts here; est., a
  // Cow Hollow collector, below Chestnut's own counts one block north, 2,700-5,500 a direction)
  residential: { weekday: 2500, peak: "pm" }, unclassified: { weekday: 800, peak: "pm" },
};
export const STREET_TRAFFIC = {
  cell: 22,            // m: at most one vehicle per 22 m cell of a lane (2 s apart at 11 m/s)
  laneW: 3.3,          // m between lanes
  maxLanes: 3,         // lanes drawn per direction
  heavy: 0.03,         // share of buses and trucks on the streets (est.); motorways: BRIDGE_TRAFFIC.heavy
  speed: { motorway: 20, trunk: 11, primary: 10, secondary: 10, tertiary: 9 },   // m/s, mean moving speed (est.)
  weekendShare: 0.875, // weekend / weekday, from Lombard's own counts (2015 weekend vs 2011 weekday, both ways)
};
// Bikes, in the bike lanes of the streets that have them (routes.json streets[].bike, OSM cycleway tags), per direction a
// day. Golden Gate Bridge: 68,286 bike crossings in October 2025 (GGBHTD, Golden Gate Bridge Monthly Bike & Pedestrian
// Sidewalk Volume) with weekends ~3.4x weekdays (SF Board of Supervisors resolution 41-02: 1,400 a weekday, 4,800 a
// weekend day) gives ~1,350 a weekday and ~4,600 a weekend day, both ways. Lincoln Blvd, the Presidio's bike route to
// the bridge, carries half of them (est.); the other lanes a class estimate. Hours: the weekend profile (leisure riding,
// est.) every day.
export const BIKE_FLOW = {
  "529868660": { weekday: 340, weekend: 1150 }, "529868660r": { weekday: 340, weekend: 1150 },   // Lincoln Blvd (est.)
  "91190524": { weekday: 340, weekend: 1150 }, "91190524r": { weekday: 340, weekend: 1150 },     // Lincoln Blvd (est.)
};
export const BIKE_DEFAULT = { weekday: 120, weekend: 300 };   // (est.)
export const BIKE = {
  speed: 5,            // m/s (18 km/h; est.)
  cell: 12,            // m
  outside: 1.6,        // m beyond the outer car lane
  parkClear: 1.25,     // m inside a baked parked row (its half width, 0.95, and the bike's own)
  len: 1.8,            // m
};
// Street cars' paint: the share of cars on US roads by colour (est., after the paint makers' popularity surveys: white,
// black, grey and silver about three in four, then blue and red), as sRGB 0..1 (the hull shader tints the atlas's
// grey paint, livery_base, toward it). The Muni bus and the Lyft bike keep their own colours.
export const CAR_PAINT = [
  [0.26, [0.92, 0.92, 0.90]], [0.22, [0.07, 0.07, 0.08]], [0.19, [0.42, 0.43, 0.44]], [0.11, [0.70, 0.71, 0.72]],
  [0.10, [0.12, 0.20, 0.38]], [0.08, [0.55, 0.06, 0.07]], [0.02, [0.62, 0.55, 0.44]], [0.015, [0.20, 0.30, 0.22]],
  [0.005, [0.85, 0.75, 0.25]],
];
// v3/street-traffic rebuild: the vehicles' own driving, the Intelligent Driver Model (Treiber, Hennecke & Helbing 2000)
// in its IDM+ form (Schakel, Knoop & van Arem 2010): a = a_max min(1 - (v / v0)^4, 1 - (s* / s)^2),
// s* = s0 + v T + v dv / (2 sqrt(a_max b)); each vehicle's values drawn in these ranges by a hash of its arrival.
// Calibrated so a queue leaves a green at the measured saturation flow (HCM: ~1,800 an hour a lane, 2.0 s apart):
// these give 2.13 s (scripts/city_clock/simulate.mjs); the plain IDM with a 1-2, T 1.2-1.6 gave 2.57 s
export const STREET_IDM = {
  dt: 0.25,            // s, the step
  speedSpread: 0.18,   // each vehicle's desired speed: the road's x (1 +- this)
  drift: [0.05, 30, 90],   // and it wanders +- 5 % over a period of its own, 30-90 s (a driver easing off, closing up;
                           // M1: was 8 % over 20-60 s, when it was the only spread)
  aMax: [1.5, 2.5],    // m/s^2, comfortable acceleration
  bComf: [2.0, 3.0],   // m/s^2, comfortable braking
  s0: [1.5, 3.5],      // m, the gap kept standing (per driver, skewed)
  T: [0.8, 2.0],       // s, the time headway kept moving (per driver, skewed: most near the short end)
  skew: 2.5,           // a driver's place in those ranges: u^skew of an even u (most close, a few cautious; streets.js:
                       // u u sqrt(u), exact everywhere; M1: the ranges are STREET_FLEET's per type, aMax..T here unused)
  amber: 3.5,          // s, the amber at the end of each green: a vehicle that can't stop at bComf goes on
  warmup: 1320,         // s: every visitor's simulation starts from an empty street at least this long before the clock,
                       // (after-3, B 28 Oct: 1020 -> 1320: after-3's per-driver variety makes two simulations agree later;
                       // at 1020 the hand-over left 2 abrupt pops on Wed, at 1320 none; a visitor's start-up +23 %)
  period: 600,         // at an anchor every `period` s (so 900-1500 s before), the next one taking over at its warmup
  blend: 360,          // s, across the last `blend` of each period (C2, B 27 Oct: 240 -> 360 and the warm-up 900 -> 1020,
                       // so the next simulation still warms 660 s first: c24's one phase a node held Lombard's
                       // queues in view through 240 s; M4: was 20; M6: 120 -> 240: queues in view at
                       // Lombard's signals had kept the two apart through 120 s on some days; none in 6 days now). A
                       // vehicle within 4 m in both slides
                       // across; any other is swapped only out of sight: the old one's goes when it is first hidden
                       // (behind something or past a seen run), the new one's comes once it has been hidden after that
                       // (each simulation notes, as it steps through a hand-over, when each vehicle is first and last
                       // hidden: a function of T alone). None fades; one never hidden in the window still swaps at its end
  catchUp: 30,         // s the next simulation may step ahead of real time each frame, catching up to the clock (M4: was 40)
  quickWarm: 300,      // s (DYS-39, Akshay 28 Oct: 'it takes traffic a couple seconds after a time is loaded'): on the page, a
                       // jump's street comes first from a simulation started this long before the clock (~1/5 of the
                       // full one's steps; 77-85 % of its drawn cars, the same ids: arrivals are hashed on the clock),
  quickBlend: 240,     // s  then the full simulation, once caught up, takes over across this long as a hand-over does
                       // (within 4 m it slides; any other swaps only out of sight). Node tools and gates never use it
  slot: 0.5,           // s, arrival slots (a Poisson stream: each slot a vehicle with chance q * slot / 3600)
  // Lombard (US-101, Broderick to Van Ness): the city operates its signals as one corridor (SFMTA, Lombard Street Vision
  // Zero Project, Dec 2024: retimed Oct 2024; 25 mph limit); no timing plan is published. A node has one phase for
  // both directions, so only one can ride a wave: westbound (out of the city, the PM peak) at the 25 mph limit, each
  // node off it by up to +-waveErr s (est.); eastbound meets the lights as they fall (C, 27 Oct: both directions had
  // their own perfect wave over the same nodes, so platoons never stopped or spread)
  greenWave: { "8916287": 11.2, "23876482": 11.2 },   // (Marina Blvd westbound too: est.)
  waveErr: 4,          // s
};
// Lanes that change with the hour: Lombard's curb lanes are commute-hour tow-away lanes (SFMTA: typically 7-9 AM and
// 3-7 PM on weekdays, the posted signs governing; Lombard's own hours est.): 3 lanes each way then, else 2 (parked cars)
// When the street traffic shows (QUEUE T, the coordinator 28 Oct: on only while judged good; default sun up, off from
// dusk): fully shown with the sun above sunHi degrees, gone below sunLo, faded between (~10 min at sunset and sunrise,
// so no car pops). The simulation runs regardless (determinism, hand-overs); only the drawing follows this.
// (Deploy 4, DYS-61, the coordinator 29 Oct: street cars at every hour, as Akshay tested on 4620; daylight only, if he
// says so, is { sunLo: -2, sunHi: 1 })
export const STREET_SHOW = { sunLo: -90, sunHi: -89 };
export const STREET_LANES_HOURLY = {
  "23876482": { peak: 3, off: 2, hours: [[7, 9], [15, 19]] }, "31780017": { peak: 3, off: 2, hours: [[7, 9], [15, 19]] },
};
// the vehicle mix on the streets (est., after the US light-vehicle fleet: about half cars, two in five SUVs/crossovers,
// the rest pickups and vans): [share, model]
export const VEHICLE_MIX = [[0.24, "prius"], [0.22, "model3"], [0.2, "modely"], [0.2, "crv"], [0.08, "tacoma"], [0.06, "transit"]];
// v3/traffic-motion M1 (streets.js uses this, not VEHICLE_MIX): the vehicle types on the streets and how each drives.
// Per type: kind, the renderer's class (lamps, specks); models, the meshes drawn for it ([share, model]; cars-lod.json
// has no box truck or motorbike: the nearest, the Transit van and the Lyft bike); len, m for the following (the mesh
// keeps its own, lenOf); v0, its desired speed x the street's mean; a, b, s0, T: its drivers' IDM+ ranges (each drawn
// by a hash of its arrival, s0 and T skewed toward the short end, u^2.5). Drivers: a 1-2, b 1.5-2.5 m/s^2, time gaps
// T 0.6-1.8 s (est., about the IDM's usual city values, Treiber & Kesting, Traffic Flow Dynamics, 2013; T from 0.6, not
// 0.8, so 15-30 % of headways at a busy lane's station are under 1.5 s: on Lombard at its peak 0.8 gives 9-11 %,
// 0.7 14-17 %, 0.6 19-23 %); trucks and buses slower, longer and gentler.
export const STREET_FLEET = {
  types: {
    sedan: { kind: "car", models: [[0.52, "prius"], [0.48, "model3"]], v0: 1, a: [1, 2], b: [1.5, 2.5], s0: [1, 3], T: [0.8, 3.5], Tk: 6 },
    suv: { kind: "car", models: [[0.5, "modely"], [0.5, "crv"]], v0: 1, a: [1, 2], b: [1.5, 2.5], s0: [1, 3], T: [0.8, 3.5], Tk: 6 },
    pickup: { kind: "car", models: [[1, "tacoma"]], v0: 1, a: [1, 1.8], b: [1.5, 2.5], s0: [1, 3], T: [0.8, 3.5], Tk: 6 },
    van: { kind: "heavy", models: [[1, "transit"]], v0: 0.96, a: [0.9, 1.6], b: [1.5, 2.3], s0: [1.5, 3], T: [1, 1.8] },
    boxtruck: { kind: "heavy", models: [[1, "transit"]], len: 7.5, v0: 0.9, a: [0.6, 1.1], b: [1.5, 2], s0: [2, 4], T: [1.3, 2] },
    motorbike: { kind: "bike", models: [[1, "lyft_classic"]], len: 2.2, v0: 1.08, a: [1.8, 3], b: [2, 3], s0: [1, 2], T: [0.6, 1.4] },
    bus: { kind: "heavy", len: 12.5, v0: 0.85, a: [0.7, 1.1], b: [1.5, 2], s0: [2, 4], T: [1.3, 2] },
    bike: { kind: "bike", models: [[1, "lyft_classic"]], v0: 1, a: [0.8, 1.5], b: [1.5, 2.5], s0: [1, 2], T: [1, 2] },
  },
  lenOf: { prius: 4.6, model3: 4.7, modely: 4.75, crv: 4.6, tacoma: 5.4, transit: 6.0, muni: 12.5, lyft_classic: 1.8 },
  // the light vehicles' types (VEHICLE_MIX's own shares: cars 0.46, SUVs 0.4, pickups 0.08, vans 0.06)
  mix: [[0.46, "sedan"], [0.4, "suv"], [0.08, "pickup"], [0.06, "van"]],
  // box trucks' share by hour on a weekday (est.: deliveries' midday peak, 6-8 % through the working day, 2 % at night,
  // about FHWA VM-1 2022's 3.9 % of urban miles over the day), x truckWeekend on weekends, x truckBy[road]
  truck: [0.02, 0.02, 0.02, 0.02, 0.025, 0.035, 0.045, 0.055, 0.065, 0.075, 0.08, 0.08, 0.08, 0.075, 0.07, 0.06, 0.05,
    0.045, 0.04, 0.035, 0.03, 0.025, 0.02, 0.02],
  truckWeekend: 0.5, truckBy: { residential: 0.5, unclassified: 0.5 },
  motorbike: 0.01,     // share (FHWA VM-1 2022, urban: 0.8 %)
  // desired speeds: the street's limit x speedBy[road] (Lombard 25 mph x 1.02), each driver's x (1 + speedCv z), z
  // about normal (three hashes' sum, within +-3), at least speedMin
  speedBy: { trunk: 1.02, primary: 1.02, secondary: 1, tertiary: 0.96, residential: 0.9, unclassified: 0.9 },
  speedCv: 0.12, speedMin: 0.6,
};
// v3/traffic-motion M2: lane changes, MOBIL (Kesting, Treiber & Helbing 2007): a driver moves to the lane beside when
// its own acceleration there, plus politeness x its old and new followers' gains, beats `thr`, and neither it nor its
// new follower must brake harder than bSafe. Values est. (MOBIL's own: p 0-0.5, thr 0.1-0.3, bSafe 4).
export const STREET_LC = {
  every: 1,            // s: a driver weighs a change once a second (on whole seconds), with chance `consider`
  consider: 0.25,
  p: [0.2, 0.5],       // politeness, per driver
  thr: 0.8,            // m/s^2, the gain a change needs (city streets: higher than a motorway's 0.1-0.3; M4b: 0.5 -> 0.8, Lombard's
                       // rate back under 0.6 a veh-km once buses and turns had added to it)
  bSafe: 3,            // m/s^2
  right: 0.05,         // m/s^2: keep right (a move right gains this, a move left loses it)
  // the kerb lane (the rightmost open one, beside parking, bus stops and right turns; not on a motorway): a through
  // vehicle there loses kerb[0], a heavy one or a slow driver (desired speed under `slow` x the street's mean) gains kerb[1]
  kerb: [0.4, 0.15], slow: 0.9,
  kerbShare: 0.7,      // its arrivals x this (the other lanes' up to match)
  inner: 1.2,          // the inner lane's arrivals x this (it carries a little more, est.)
  // (after-3, de-grid: in each 30 s a driver of a car or motorbike may want the next lane left or right for no reason
  // the road gives, `wander` m/s^2 of gain, so platoons don't ride three abreast; est.)
  wander: 1.5, wanderShare: 0.15, wanderT: 30,
  dur: [3, 4],         // s a change takes (a smooth sideways move), per driver
  cool: 8,             // s after one before it weighs another
  endClear: 30,        // m before a street's end: no change (C, 27 Oct: one changing there met one already on the next street)
  noSig: [15, 5],      // m before / after a signal's stop line: no change (C, 27 Oct: was [30, 10], 27 % of Lombard; none seen in view)
  vMin: 2,             // m/s: none slower (in a queue)
  clear: 30,           // m: none into a lane where one is still changing out within this (no crossing paths)
  closed: 1.5,         // m/s^2 gained leaving a lane that has closed (Lombard's tow-away lanes at 9:00 and 19:00)
};
// v3/traffic-motion M3: turns. Vehicles turn off and on at the junctions the panorama hides (routes.json streets[].junc,
// scripts/city_clock/street_junctions.py from OSM): at each, a passing vehicle turns off with chance out[road] (x big
// where the cross street is tertiary or above), split over the sides it may turn to; as many turn on (split over the
// sides they may come from; none where either is missing), so the flow along the street stays its count (est.: arterials lose a few % of their traffic at each minor cross street, a residential
// collector more). One turning off moves to its turn's lane within `look` m (one going on along a street: from its start; lane change
// gain `gain` a lane), slows to
// `v` for it; one turning on waits for a gap (its new follower braking under bIn) and, at a signal, the main road's
// red. Where a kept street starts on another (streets[].link: the Presidio's Lombard from Lombard, the bridge plaza's
// links from Lincoln), its vehicles come from that one: a branch takes at most `branch` of its flow.
export const STREET_TURN = {
  out: { motorway: 0, trunk: 0.03, primary: 0.04, secondary: 0.05, tertiary: 0.06, residential: 0.1, unclassified: 0.1 },
  big: 1.6, look: 200, gain: 1.5, v: 4.5, bIn: 1.5, ahead: 6, branch: 0.3,
};
// v3/traffic-motion M4: Muni's buses on their real runs, stops and trips by hour (SFMTA Muni GTFS, Jul 2026,
// scripts/city_clock/street_buses.py): routes.json streets[].bus [route:direction, s in, s out, [stop s]] (a run that
// starts or ends on seen road is stretched to the nearest hidden turn or the path's end) and bus_hours {route:direction:
// [weekday, Saturday, Sunday]} (trips an hour, base 36, hours 0-29: 24-29 after midnight, the day before's service;
// Sunday as Saturday where left out). A run from its street's start enters at the start, any other turns on at its s in
// (as a turning car: a gap, the main road's red); it turns off at its s out, or goes on along its route at a link. Each
// hour's trips are evenly spaced, from a hashed phase. At each stop the bus pulls in (from `pull` m before it) where there
// is room beside its lane (a closed lane: Lombard's kerb lane outside its tow-away hours; or, on a street with one lane a
// direction, routes.json streets[].bay: no photographed parked car at any of its stops), else stops in its lane (Lombard's kerb lane at the peak); it dwells `dwell` s (est.: Muni's usual 10-40 s)
// and pulls out when its follower can let it in (its new follower braking under STREET_LC.bSafe, as SF's yield-to-bus law
// asks). Pulled in, it is passed in its lane (it leads only another pulled in). A street's count includes its buses: its
// other arrivals are the count less that hour's bus trips.
export const STREET_BUS = { dwell: [12, 40], pull: 15 };
// v3/traffic-motion M5: short stops at the kerb (a pick-up or drop-off, a delivery), a few an hour where a street has
// spaces (routes.json streets[].park [kerb lateral, [space s]], scripts/city_clock/street_parking.py: on seen road, clear
// of the photographed parked cars, signals, junctions and bus stops; Lombard's kerb lane only outside its tow-away
// hours). A car picks one on its way with chance rate[hour] / its street's flow; it slows in its lane (the lane behind
// slows too), pulls in from `pull` m before it, stops `dwell` s and pulls out as a bus does; with no room (not in the
// kerb lane, the space taken within `clear` m) it drives on. est.: SF's curbs see a pick-up or delivery every few minutes
// a block by day; these are a sparing few, where the panorama shows the kerb.
// Stop signs (OSM highway=stop on the street, routes.json streets[].stops: Cow Hollow's corners): each vehicle comes to a
// halt at the line and waits `wait` s (est.: a full stop and a look both ways; SF's rolling stops are the short end).
// (C2: a full halt for 0.8-2.5 s by only some drivers; the rest roll over the line at 1.5-3 m/s. Full stops observed:
// 20.2 % in SHRP2's naturalistic data, 13 % at a Brooklyn corner, 48-61 % in a weekday / weekend count: 0.35 est.)
export const STREET_STOPS = { wait: [0.8, 2.5], full: 0.35, roll: [1.5, 3] };
export const STREET_PARK = { rate: [0.5, 0.5, 0.3, 0.3, 0.3, 0.5, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1.5, 1], dwell: [20, 90], pull: 8, clear: 12 };
// Traffic signals on the streets (OSM traffic_signals nodes, routes.json streets[].signals): each runs a fixed cycle,
// its start set by a hash of its node id; the main road has the first `main` share of it, the cross street the rest.
export const STREET_SIGNALS = {
  react: [0.8, 2],     // s, a queue's first driver's start-up at the green, per driver per light (est.: HCM's start-up lost time ~2 s)
  go: [0, 0.9], goH: [1, 2.2],   // s, a stopped driver's own delay after the one ahead moves off (light vehicles / heavies; est.)
  cycle: 70,           // s (est.: SFMTA fixed-time cycles are mostly 60-90 s downtown and on arterials)
  main: 0.55,          // share of the cycle green for the main road (est.)
  mainBy: { "23876482": 0.68, "31780017": 0.68,     // Lombard (US-101, ~40,000 vehicles a day) against minor cross streets (est.);
    "8916287": 0.68, "8916287r": 0.68 },             // Marina Blvd: one lane a direction between its photographed parked rows (est.)
  headway: 2.0,        // s between cars leaving a queue at green (saturation flow ~1,800 an hour a lane, HCM), and at
                       // most 0.9 of the time between cells, so a queue always shrinks at green and clears in its cycle
  gap: 7,              // m from one queued car to the next
  stopBack: 2,         // m before the stop line where the first car waits
  brake: 3,            // m/s^2, slowing for a red and pulling away at green (a normal city stop)
  hard: 4.5,           // m/s^2 (C2): at red, one that can't stop by its line at this goes on (it went on the amber; was:
                       // a halt at any cost, to the 9 m/s^2 floor, in > 5 % of the stops at a signal)
};

// ---------------------------------------------------------------- windows and street lamps
// RESNET/NREL residential lighting, share of the evening peak by hour (catalogue window_curve_norm)
export const WINDOW_HOURLY = [0.11, 0.09, 0.09, 0.09, 0.1, 0.16, 0.27, 0.35, 0.37, 0.37, 0.35, 0.34, 0.33, 0.32, 0.34,
  0.37, 0.45, 0.59, 0.78, 0.96, 1.0, 0.72, 0.36, 0.16];
export const WINDOW_MONTHLY = [1.19, 1.11, 1.02, 0.93, 0.84, 0.8, 0.82, 0.88, 0.98, 1.07, 1.16, 1.2];
export const WINDOWS = {
  peak: 0.40,          // share of windows lit at the evening peak (est.)
  dark: [-4, 6],       // darkness factor: 1 below sun -4 deg, 0 above +6 deg
  fade: 0.35,          // s, a window's on/off fade
  tv: { share: 0.05, from: 19, to: 23 },   // TV-blue flicker (est.)
  weekendShift: 1,     // h, the evening curve runs an hour later on Friday and Saturday nights (est.)
  cells: 5000,         // resolvable lit-window cells in the desktop window (catalogue: ~5,000)
};
export const LAMPS = { alt: -4.5, spread: 300, fogEarly: 600, fog: 0.35, fade: 2 };   // s; photocells (est.)
// windows_extra (Akshay 17:41 18 Oct): the night's second window group, extra lit flats over the base windows (P2, the
// locked look), rendered so that dial 1 is about today's liveliness (v3/city-detail 0130ec5; docs/v3/briefs
// detail-int-notes.md 17:52). The outside adds it x this dial, per moment and per SF local hour: a moment's entry is
// one number (that dial at every hour) or 24 numbers (hours 0..23, eased between by the minute). A moment not listed,
// or at 0, has none of it: its tiles (lightsx-*, nearx-*) are not even fetched. Only blue, dusk, night, predawn and
// dawn carry the group. E.g. night: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3,
// 0.3, 0.3, 1, 1, 1, 1, 1, 0.6] (full in the evening, fewer after midnight). ?wx=<dial> overrides it (QA).
export const WINDOWS_EXTRA = { blue: 0, dusk: 0, night: 0, predawn: 0, dawn: 0 };
// Its gain per moment, so that dial 1 is the target look (base + extra about the live site's liveliness) at every moment:
// worker B's render helper measured it on the Mac previews (detail-int-notes.md 18:26: dusk 1.25, "up to 1.5 to match
// live"; the rest 1.0). The outside multiplies the dial by it (the panorama's, the near layer's and L3's extra alike).
export const WINDOWS_EXTRA_GAIN = { blue: 1.0, dusk: 1.25, night: 1.0, predawn: 1.0, dawn: 1.0 };
/** The windows_extra dial of a moment at an SF local hour (fractional, 0..24). */
export function windowsExtraDial(moment, hour, table = WINDOWS_EXTRA) {
  const e = table[moment];
  if (typeof e === "number") return Math.max(0, e);
  if (!Array.isArray(e) || e.length !== 24) return 0;
  const h = ((hour % 24) + 24) % 24, i = Math.floor(h), f = h - i;
  return Math.max(0, (+e[i] || 0) * (1 - f) + (+e[(i + 1) % 24] || 0) * f);
}

// ---------------------------------------------------------------- wind (NOAA NDBC FTPC1, Fort Point, 2024, kt)
export const WIND_FORT_POINT = {
  // [centre day of year, hourly means 00..23]
  blocks: [
    [0, [5.0, 5.0, 4.9, 5.0, 5.1, 5.2, 5.6, 5.9, 6.3, 6.3, 6.3, 5.9, 6.2, 6.5, 6.6, 6.5, 6.5, 5.8, 5.4, 4.9, 4.7, 4.6, 4.7, 4.8]],          // Nov-Feb
    [105, [5.0, 4.8, 4.7, 4.9, 4.8, 4.4, 4.6, 4.4, 5.1, 6.2, 6.7, 7.5, 8.6, 9.3, 10.1, 10.3, 10.2, 10.0, 9.3, 8.9, 7.8, 6.9, 5.8, 5.4]],  // Mar-May
    [197, [5.7, 5.5, 5.4, 5.2, 5.0, 4.9, 4.7, 5.0, 5.5, 6.0, 6.8, 7.4, 8.6, 9.7, 10.7, 11.3, 11.4, 11.5, 10.7, 9.8, 8.8, 7.4, 6.8, 6.3]], // Jun-Aug
    [273, [4.4, 4.2, 4.1, 4.0, 3.8, 3.8, 3.7, 3.9, 4.2, 4.6, 5.3, 5.6, 6.0, 7.5, 8.6, 9.7, 9.9, 10.0, 9.4, 7.7, 5.8, 5.3, 4.9, 4.5]],     // Sep-Oct
  ],
  open: 1.5,           // open-water factor: FTPC1 sits sheltered under the south tower (est.)
  from: 255,           // deg, the afternoon sea breeze blows from the west-southwest (est.)
};

// ---------------------------------------------------------------- aircraft
// hour factor on the measured daytime rate (plan; SFO/FAA figures): 1.0 07-23, 0.5 23-01, 0.1 01-06, 0.6 06-07; except
// 22-23, measured: the 21:55-22:25 sample of Wed 14 Oct 2026 saw 2.97 new aircraft per 10 min, all airliners, which is
// 0.71 of the 13:07 sample's airliner rate (one 30-min sample, so +-1/3; scripts/city_clock/data/adsb_2200.json). The
// 17:15-17:42 sample (6.84 per 10 min) confirms 1.0 at 17h.
export const AIRCRAFT_HOUR = [0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.7, 0.5];
export const AIRCRAFT = { slot: 60, lightWeekend: 1.5, lightSun: 0, landingBelowFt: 10000, strobe: 1.2, beacon: 1.0 };

// ---------------------------------------------------------------- ships
export const SHIPS = {
  cycle: 1200,         // s; one possible ship per 20-minute cycle (UTC-aligned)
  p: 0.21,             // 15.1 bar crossings a day (Bar Pilots 2024: 5,529)
  window: 840,         // s; a ship passes midspan in the first 14 min of its cycle, so ships one cycle apart keep
                       // at least 6 min (2.2 km) between them
  knots: 12,
  types: [             // [type, cumulative share, length m (min, max), beam, height of the highest light]
    // (beams and heights: the sprite models of scripts/ships/ship_sprites.py, at their own length)
    ["container", 0.36, 300, 400, 48, 55],
    ["tanker", 0.68, 230, 270, 44, 41],
    ["carcarrier", 0.80, 190, 200, 32, 45],
    ["bulk", 0.92, 190, 230, 32, 39],
    ["tugbarge", 1.0, 120, 150, 22, 24],
  ],
  // hull paint (sRGB) the sprite's livery faces take, with weights: real liveries by colour, not by company. The
  // floodlights: LED white on about half (newer ships), high-pressure sodium on the rest
  livery: {
    container: [["#1c1d1f", 4], ["#1f2b40", 4], ["#22406b", 3], ["#5e1f1c", 3], ["#7b2620", 2], ["#1f3d2c", 2], ["#4f5357", 3], ["#8e9294", 2], ["#c9c9c4", 1], ["#1d4a50", 1]],
    tanker: [["#1c1d1f", 5], ["#5a1d1a", 3], ["#1e2f4d", 3], ["#3b3e41", 2], ["#22382a", 2], ["#6b2a1f", 2]],
    carcarrier: [["#1f2d4a", 4], ["#1c1d1f", 3], ["#3d4145", 2], ["#7a2420", 1], ["#1e4048", 2]],
    bulk: [["#1c1d1f", 4], ["#1e2f4d", 3], ["#4a4f53", 2], ["#6b2a1f", 2], ["#2a4a33", 2], ["#2a4c7a", 2]],
    tugbarge: [["#1c1d1f", 3], ["#8a2a20", 3], ["#22402c", 2], ["#1f2b40", 2], ["#4a4f53", 2]],
  },
  ledShare: 0.55,
  hornEvery: 120, hornLen: [4, 6],   // COLREGS rule 35: one prolonged blast at least every 2 min in fog
};

// SF Port 2026 cruise calendar (updated 6/18/2026), all 89 calls: [vessel, "MMDD HH:MM" arrival, departure, berth].
// (The catalogue's cruise_2026.json had 87: it missed Luminosa on Sep 20 and Nieuw Amsterdam on Sep 30, both printed
// "7:00AM" without a space in the port's PDF.)
export const CRUISE_YEAR = 2026;
export const CRUISE_2026 = [
  ["RubyPrincess", "0102 07:00", "0102 16:00", "27"], ["RoyalPrincess", "0112 08:00", "0112 22:00", "27"],
  ["RubyPrincess", "0118 07:00", "0118 16:00", "27"], ["RoyalPrincess", "0121 08:00", "0121 22:00", "27"],
  ["RubyPrincess", "0129 07:00", "0129 16:00", "27"], ["QueenMary2", "0205 06:00", "0206 18:00", "27"],
  ["Amadea", "0205 09:00", "0207 17:00", "35S"], ["RubyPrincess", "0214 07:00", "0214 16:00", "27"],
  ["RubyPrincess", "0219 07:00", "0219 16:00", "27"], ["RubyPrincess", "0307 07:00", "0307 16:00", "27"],
  ["RubyPrincess", "0318 07:00", "0318 16:00", "27"], ["Arcadia", "0320 07:00", "0321 16:00", "27"],
  ["RubyPrincess", "0403 07:00", "0403 16:00", "27"], ["RoyalPrincess", "0406 07:00", "0406 18:00", "27"],
  ["NieuwAmsterdam", "0406 13:00", "0407 18:00", "35S"], ["NorwegianJade", "0413 00:00", "0414 17:00", "27"],
  ["RubyPrincess", "0419 07:00", "0419 16:00", "27"], ["Luminosa", "0423 07:00", "0423 16:00", "27"],
  ["RubyPrincess", "0426 07:00", "0426 16:00", "27"], ["Luminosa", "0427 07:00", "0427 16:00", "27"],
  ["NorwegianEncore", "0428 08:00", "0429 16:00", "27"], ["Koningsdam", "0429 08:00", "0429 16:00", "35S"],
  ["CelebritySummit", "0503 08:00", "0504 11:59", "35S"], ["RubyPrincess", "0503 07:00", "0503 15:00", "27"],
  ["EmeraldPrincess", "0505 08:00", "0505 22:00", "27"], ["BrilliantLady", "0506 08:00", "0506 20:00", "27"],
  ["Luminosa", "0507 07:00", "0507 16:00", "27"], ["IslandPrincess", "0509 08:00", "0509 22:00", "27"],
  ["Luminosa", "0511 07:00", "0511 16:00", "27"], ["RubyPrincess", "0513 07:00", "0513 16:00", "27"],
  ["AsukaII", "0517 07:30", "0518 20:00", "27"], ["Luminosa", "0521 07:00", "0521 16:00", "27"],
  ["RubyPrincess", "0523 07:00", "0523 16:00", "27"], ["Luminosa", "0525 07:00", "0525 16:00", "27"],
  ["RubyPrincess", "0602 07:00", "0602 16:00", "27"], ["Luminosa", "0604 07:00", "0604 16:00", "27"],
  ["TheWorld", "0605 09:00", "0607 18:00", "27"], ["Luminosa", "0608 07:00", "0608 16:00", "27"],
  ["RubyPrincess", "0612 07:00", "0612 16:00", "27"], ["Luminosa", "0618 07:00", "0618 16:00", "27"],
  ["Luminosa", "0622 07:00", "0622 16:00", "27"], ["Luminosa", "0702 07:00", "0702 16:00", "35S"],
  ["RubyPrincess", "0702 07:00", "0702 16:00", "27"], ["Luminosa", "0706 07:00", "0706 16:00", "27"],
  ["RubyPrincess", "0712 07:00", "0712 16:00", "27"], ["Luminosa", "0716 07:00", "0716 16:00", "27"],
  ["Luminosa", "0720 07:00", "0720 16:00", "27"], ["RubyPrincess", "0722 07:00", "0722 16:00", "27"],
  ["Luminosa", "0730 07:00", "0730 16:00", "27"], ["RubyPrincess", "0801 07:00", "0801 16:00", "27"],
  ["Luminosa", "0803 07:00", "0803 16:00", "27"], ["RubyPrincess", "0811 07:00", "0811 16:00", "27"],
  ["Luminosa", "0813 07:00", "0813 16:00", "27"], ["Luminosa", "0817 07:00", "0817 16:00", "27"],
  ["RubyPrincess", "0821 07:00", "0821 16:00", "27"], ["CrystalSymphony", "0822 08:00", "0822 16:00", "27"],
  ["Luminosa", "0827 07:00", "0827 16:00", "27"], ["Luminosa", "0831 07:00", "0831 16:00", "27"],
  ["RubyPrincess", "0831 07:00", "0831 15:00", "35S"], ["Luminosa", "0910 07:00", "0910 16:00", "27"],
  ["RubyPrincess", "0910 07:00", "0910 16:00", "35S"], ["EmeraldPrincess", "0912 07:00", "0912 21:00", "27"],
  ["BrilliantLady", "0914 08:00", "0914 23:59", "27"], ["CelebritySummit", "0915 08:00", "0916 17:00", "27"],
  ["RubyPrincess", "0917 07:00", "0917 16:00", "27"], ["IslandPrincess", "0919 08:00", "0919 18:00", "27"],
  ["Luminosa", "0920 07:00", "0920 16:00", "27"],
  ["CelebritySummit", "0920 07:00", "0921 17:00", "35S"], ["GrandPrincess", "0922 08:00", "0922 22:00", "27"],
  ["CoralPrincess", "0926 08:00", "0926 18:00", "27"], ["QueenElizabeth", "0927 07:00", "0927 16:00", "27"],
  ["CelebritySummit", "0928 12:00", "0929 18:00", "35S"], ["DiscoveryPrincess", "0929 08:00", "0929 18:00", "27"],
  ["NieuwAmsterdam", "0930 07:00", "0930 21:00", "27"],
  ["SerenadeoftheSeas", "0930 08:00", "0930 20:00", "35S"], ["StarPrincess", "1001 08:00", "1002 18:00", "27"],
  ["RubyPrincess", "1003 08:00", "1003 16:00", "27"], ["NorwegianJoy", "1005 10:00", "1005 20:00", "27"],
  ["RubyPrincess", "1013 08:00", "1013 16:00", "27"], ["NorwegianEncore", "1015 08:00", "1016 18:00", "27"],
  ["RubyPrincess", "1016 07:00", "1016 16:00", "35S"], ["RubyPrincess", "1023 07:00", "1023 15:00", "27"],
  ["EmeraldPrincess", "1106 08:00", "1106 22:00", "27"], ["RubyPrincess", "1108 07:00", "1108 15:00", "27"],
  ["Koningsdam", "1117 07:00", "1118 20:00", "27"], ["RubyPrincess", "1124 07:00", "1124 15:00", "27"],
  ["RubyPrincess", "1129 07:00", "1129 15:00", "27"], ["RubyPrincess", "1215 07:00", "1215 15:00", "27"],
  ["RubyPrincess", "1226 07:00", "1226 15:00", "27"],
];
// lengths overall, m (published ship particulars, rounded)
export const CRUISE_LENGTH = {
  RubyPrincess: 290, RoyalPrincess: 330, QueenMary2: 345, Amadea: 193, Arcadia: 285, NieuwAmsterdam: 285,
  NorwegianJade: 294, Luminosa: 294, NorwegianEncore: 333, Koningsdam: 297, CelebritySummit: 294, EmeraldPrincess: 290,
  BrilliantLady: 278, IslandPrincess: 294, AsukaII: 241, TheWorld: 196, CrystalSymphony: 238, GrandPrincess: 290,
  CoralPrincess: 294, QueenElizabeth: 294, DiscoveryPrincess: 330, SerenadeoftheSeas: 293, StarPrincess: 345,
  NorwegianJoy: 334,
};
export const CRUISE = { arriveBefore: [45, 60], departAfter: 40, knotsOutside: 12, knotsInside: 10 };   // minutes
// cruise hulls by line: white unless the line paints its hulls dark (navy or near-black)
export const CRUISE_HULL = { NieuwAmsterdam: "#1c2742", Koningsdam: "#1c2742", QueenMary2: "#18191d", QueenElizabeth: "#18191d", Arcadia: "#1e2a44" };
export const CRUISE_WHITE = "#e3e3df";

// ---------------------------------------------------------------- tour boats
// Red & White Golden Gate Bay Cruise, Pier 43 1/2 (October 2026 reseller listings; summer est.)
export const RED_WHITE = {
  monWed: ["11:00", "13:00", "14:15", "15:30", "16:45"],
  thuFri: ["11:00", "13:00", "14:15", "15:30"],
  satSun: ["11:00", "13:00", "13:45", "14:15", "15:00", "16:45"],
  summer: ["10:00", "10:45", "11:30", "12:15", "13:00", "13:45", "14:30", "15:15", "16:00", "16:45"],   // est. (8-12 a day)
  summerDates: ["0525", "0907"],        // Memorial Day to Labor Day (est.)
  sunset: { from: "0320", to: "1107" }, // California Sunset Cruise, 2 h, under the bridge at sunset (est. daily)
  twilight: { from: "1108", to: "0319", after: 15 },   // winter Twilight Cruise, leaves 15 min after sunset (est.)
  jitter: 180,                          // s, hashed departure shift (plan: +-3 min)
  len: 42, height: 11,
};
// Blue & Gold Fleet, Pier 39/41, published timetable "June 1, 2026 - February 28, 2027 REVISED3".
// R = Escape from the Rock (90 min), S = Sunset Cruise (90 min), else the 60-minute Bay Cruise.
export const BLUE_GOLD = {
  periods: [
    { from: "0601", to: "0816", days: { all: ["11:00", "12:00R", "12:20", "13:50", "14:20", "15:40", "16:00", "17:00", "17:45", "18:45", "19:30S"] } },
    { from: "0817", to: "0913", days: { monThu: ["11:00", "12:15", "13:00", "14:15", "15:45", "17:00", "18:30"],
      friSun: ["11:00", "12:15R", "13:00", "14:45", "16:00", "17:15", "18:30", "19:00S"] } },
    { from: "0914", to: "1101", days: { monThu: ["11:00", "12:15", "13:00", "14:15", "15:45", "17:00", "18:00"],
      friSun: ["11:00", "12:15R", "13:00", "14:45", "16:00", "17:15", "18:15S"] } },
    { from: "1102", to: "0228", days: { monFri: ["11:00", "12:15", "12:45", "14:15", "15:30", "16:45"],
      satSun: ["11:00", "12:15R", "12:45", "14:15", "15:30", "16:45"] } },
  ],
  // March-May is outside the published timetable: the November-February pattern is used (est.)
  exceptions: { "0704": { noSunset: true }, "1101": { noSunset: true }, "1030": { sunsetAt: "18:30" }, "1031": { sunsetAt: "18:30" } },
  jitter: 180, len: 38, height: 10,   // jitter: departures leave 0-3 min after the published time (est.)
};

// ---------------------------------------------------------------- sailboats
export const SAIL = {
  pool: 100, weekday: 8, weekend: 30, windLo: 4, windSpan: 7,
  friday: { add: 20, from: 17.5, to: 20, months: [4, 9] },    // beer-can races, April-September
  // regattas: [first day, last day, boats, from h, to h]; 2027 is the usual mid-September pattern (est.)
  regattas: [
    ["2026-07-30", "2026-08-02", 40, 11, 17],   // US wingfoil championship (Summer Wingding)
    ["2026-09-16", "2026-09-20", 100, 11, 17],  // Rolex Big Boat Series
    ["2026-09-30", "2026-10-04", 25, 11, 17],   // Women's Match Racing Worlds (few boats plus spectators)
    ["2027-09-15", "2027-09-19", 100, 11, 17],  // Rolex Big Boat Series 2027 (est. dates, not yet published)
  ],
  knots: { beat: 5, reach: 6.5, run: 6 }, mast: [11, 17], raceMast: [15, 25],
};

// ---------------------------------------------------------------- gulls
export const GULLS = { perHour: 4, slot: 60, dist: [30, 150], speed: [9, 13], welcome: [20, 45] };

// ---------------------------------------------------------------- sound (data for the sound stream)
// USCG Light List vol. VI (2025) nos. 4220, 4250, 4260, 4265; GGBHTD foghorn page. Pattern = [on, off, on, off...] s
export const FOGHORNS = [
  { id: "ggb_south", name: "Golden Gate Bridge south pier (2 horns together)", llnr: 4260, pattern: [2, 18], phase: 0,
    lat: 37.814333, lon: -122.477739, fog: true },
  { id: "ggb_mid", name: "Golden Gate Bridge mid-channel diaphone", llnr: 4265, pattern: [1, 2, 1, 36], phase: 9,
    lat: 37.816667, lon: -122.478575, fog: true },
  { id: "diablo", name: "Point Diablo horn", llnr: 4250, pattern: [2, 13], phase: 4, lat: 37.820122, lon: -122.49946,
    fog: false },   // "operates continuously" (Light List)
  { id: "bonita", name: "Point Bonita horn", llnr: 4220, pattern: [2, 2, 2, 24], phase: 7, lat: 37.815592,
    lon: -122.529534, fog: true },   // keyed by mariners on VHF 81A: in practice, in fog
];
export const FOG_ON = 0.35;   // the shown moment's fog over the deck above which the horns sound (plan)
export const SOUND_SPEED = 343;

// Powell-Hyde cable car: Hyde & Beach times (minutes after midnight), SFMTA schedule page as served on Wed
// 2026-10-14 (the weekend tables could not be retrieved separately: used for every day, unconfirmed). Outbound cars
// pass the window about 4 min before Hyde & Beach, inbound cars about 3 min after leaving it.
export const CABLE_CAR = {
  outboundAtBeach: [407, 432, 438, 458, 478, 498, 518, 533, 548, 563, 578, 593, 599, 608, 625, 637, 649, 661, 673, 678,
    685, 695, 705, 710, 717, 722, 727, 737, 747, 750, 756, 765, 772, 779, 786, 793, 800, 807, 814, 821, 828, 835, 842,
    849, 856, 863, 870, 877, 884, 891, 898, 905, 912, 919, 926, 933, 940, 947, 954, 961, 968, 975, 983, 990, 997, 1004,
    1011, 1018, 1025, 1032, 1039, 1046, 1053, 1060, 1067, 1074, 1081, 1088, 1095, 1101, 1108, 1115, 1122, 1129, 1136,
    1143, 1150, 1157, 1171, 1178, 1185, 1192, 1199, 1206, 1213, 1222, 1232, 1242, 1254, 1261, 1273, 1286, 1301, 1318,
    1338, 1358, 1378, 1398],
  inboundFromBeach: [430, 445, 460, 475, 490, 510, 530, 545, 560, 575, 590, 605, 617, 629, 641, 653, 665, 675, 685, 695,
    705, 715, 722, 729, 736, 743, 750, 757, 764, 771, 778, 785, 792, 799, 806, 813, 820, 827, 834, 841, 848, 855, 862,
    869, 876, 883, 890, 897, 904, 911, 918, 925, 932, 939, 946, 953, 960, 967, 974, 981, 988, 995, 1002, 1009, 1016,
    1023, 1030, 1037, 1044, 1051, 1058, 1065, 1072, 1079, 1086, 1093, 1100, 1107, 1114, 1121, 1128, 1135, 1142, 1149,
    1156, 1163, 1170, 1177, 1184, 1191, 1200, 1210, 1225, 1226, 1232, 1245, 1265, 1267, 1270, 1285, 1300, 1302, 1320,
    1340, 1360, 1385, 1396, 1416],
  outboundLead: -4, inboundLag: 3, jitter: 90,   // min, min, s (hashed lateness)
  passSeconds: 40,                               // a car is heard passing (cable slot, grip, bells) for about 40 s
};

// ---------------------------------------------------------------- ferries (seen only from the window spot)
// Golden Gate Ferry Sausalito, effective April 13, 2026 (2026 ferry card): [depart, arrive]. The first weekend boat
// from San Francisco takes an hour. Holidays (ferry card and goldengate.org holiday calendar): the weekend table on
// Presidents' Day, Memorial Day, Independence Day (observed), Labor Day and the Friday after Thanksgiving; no service
// on New Year's Day, Thanksgiving and Christmas Day; every other holiday (MLK, Cesar Chavez, Juneteenth, Indigenous
// Peoples', Veterans Day, Christmas Eve, New Year's Eve) runs the weekday table.
export const GG_FERRY_SAUSALITO = {
  weekday: {
    fromSausalito: [["07:05", "07:35"], ["08:15", "08:45"], ["10:55", "11:25"], ["13:35", "14:05"], ["15:35", "16:05"],
      ["17:05", "17:35"], ["18:30", "19:00"]],
    fromSF: [["07:40", "08:10"], ["10:15", "10:45"], ["12:10", "12:40"], ["14:45", "15:15"], ["16:20", "16:50"],
      ["17:45", "18:15"], ["19:15", "19:45"]],
  },
  weekend: {
    fromSausalito: [["11:30", "12:00"], ["13:25", "13:55"], ["15:10", "15:40"], ["17:00", "17:30"], ["18:55", "19:25"]],
    fromSF: [["10:15", "11:15"], ["12:35", "13:05"], ["14:15", "14:45"], ["16:00", "16:30"], ["17:50", "18:20"]],
  },
  weekendHolidays: ["presidents", "memorial", "independence", "labor", "thanksgivingFriday"],
  noService: ["newYear", "thanksgiving", "christmas"],
  // one vessel shuttles (the tables alternate terminals, and each departure follows the last arrival); est.:
  underway: 28,        // min under way for a 30-minute crossing (the rest is docking); a longer timetabled trip
                       // (the hour-long first weekend run) spends its extra time out of view at the city end
  late: 90,            // s, hashed lateness of each departure (0-90 s)
  accel: 120, decel: 180,   // s to reach and to leave cruising speed
  deadhead: 12,        // min: when a day starts at the other terminal, the boat arrives this long before the first departure
  len: [43, 50], beam: 11, height: 12,   // m, Golden Gate Ferry's Spaulding-class and catamaran ferries (est.)
};

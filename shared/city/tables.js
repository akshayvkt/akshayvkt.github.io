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
    ["container", 0.36, 300, 400, 48, 52],
    ["tanker", 0.68, 230, 270, 44, 40],
    ["carcarrier", 0.80, 190, 200, 32, 48],
    ["bulk", 0.92, 190, 230, 32, 38],
    ["tugbarge", 1.0, 120, 150, 30, 14],
  ],
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

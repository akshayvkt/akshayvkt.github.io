// Phase-2 events (plan 2.3): stubs that return nothing yet, so the renderer's contract is already in place.
// (#7, the ferries, moved to phase 1 with the window spot: events/ferries.js.)

// #8 Small craft. TODO(phase 2): a pilot boat tied to each inbound ship's cycle (out from the pilot station ~30 min
// ahead of the ship, back with the outbound pilot); fishing boats out at dawn and back mid-afternoon in the salmon
// season (Sep 1 - Oct 31); Coast Guard 47-footers from Horseshoe Bay (305 deg, 6.1 km). Mostly white wakes, 2-15 px.
export function smallCraft(/* T, c */) { return []; }

// #9b Pelicans. TODO(phase 2): lines of 5-15 dots skimming the water off Crissy Field, late summer to early winter.
export function pelicans(/* T, c */) { return []; }

// #12 Moon and evening planets. TODO(phase 2): a small ephemeris (moon position and phase, Venus, Jupiter); the moon
// sets inside the window in about half of moonsets and is hidden by hills through the depth map.
export function moon(/* T, c */) { return null; }

// #13 Fleet Week. TODO(phase 3): 2027 dates (early October, to check); navy ships on the channel as ships.js; jets
// 5-12 px trailing smoke over the show box between the bridge and Alcatraz.
export function fleetWeek(/* T, c */) { return []; }

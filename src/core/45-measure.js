// SPDX-License-Identifier: AGPL-3.0-only
// Measuring: units (metric or imperial), lengths and areas on the ground, travel times, and a report's rate of march. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Measuring ---

// What moves, for its units and its rate: 'vehicle' (ground distances in
// km | mi, speeds in km/h | mph), 'dismount' (m | yd, km/h | mph) or
// 'aircraft' (km | nm, km/h | knots). Measuring on the map is 'vehicle'.
const MOVEMENT_CLASSES = ['vehicle', 'dismount', 'aircraft'];
const M_PER_YD = 0.9144, M_PER_MI = 1609.344, M_PER_NM = 1852;
const M2_PER_YD2 = M_PER_YD * M_PER_YD, M2_PER_MI2 = M_PER_MI * M_PER_MI;

// A number in en-US digits with `dp` decimals (grouped: 1,250.5), or up to
// `dp` with `trim` (4, not 4.0).
const fixed = (v, dp, trim = false) => v.toLocaleString('en-US', { minimumFractionDigits: trim ? 0 : dp, maximumFractionDigits: dp });

// A distance in the units and for the class given: 850 m, 2.45 km, 12.3 km;
// 930 yd, 1.52 mi; a dismount's 1,250 m or yd up to ten thousand; an
// aircraft's km or nautical miles.
const formatDistance = (meters, units = 'metric', kind = 'vehicle') => {
    const m = Math.max(0, Number(meters) || 0), imperial = units === 'imperial';
    const long = (v, unit) => `${fixed(v, v < 10 ? 2 : 1)} ${unit}`;
    if (kind === 'aircraft') return imperial ? long(m / M_PER_NM, 'nm') : long(m / 1000, 'km');
    const short = imperial ? m / M_PER_YD : m, shortUnit = imperial ? 'yd' : 'm';
    if (short < (kind === 'dismount' ? 10000 : 1000)) return `${fixed(Math.round(short), 0)} ${shortUnit}`;
    return imperial ? long(m / M_PER_MI, 'mi') : long(m / 1000, 'km');
};
// km/h, mph, or knots for an aircraft in imperial; and how many km/h one is.
const speedUnit = (units = 'metric', kind = 'vehicle') => (units !== 'imperial' ? 'km/h' : kind === 'aircraft' ? 'knots' : 'mph');
const kmhPerSpeedUnit = (units = 'metric', kind = 'vehicle') => (units !== 'imperial' ? 1 : kind === 'aircraft' ? M_PER_NM / 1000 : M_PER_MI / 1000);
// 4 km/h, 3.6 km/h, 25 mph, 120 knots: a decimal only under ten.
const formatSpeed = (kmh, units = 'metric', kind = 'vehicle') => {
    const v = Math.max(0, Number(kmh) || 0) / kmhPerSpeedUnit(units, kind);
    return `${fixed(v, v < 10 ? 1 : 0, true)} ${speedUnit(units, kind)}`;
};
// An area: m² or yd² when it is under a tenth of a km² or mi², else km² or mi².
const formatArea = (m2, units = 'metric') => {
    const a = Math.max(0, Number(m2) || 0), imperial = units === 'imperial';
    const big = a / (imperial ? M2_PER_MI2 : 1e6), bigUnit = imperial ? 'mi²' : 'km²';
    if (big < 0.1) return `${fixed(Math.round(imperial ? a / M2_PER_YD2 : a), 0)} ${imperial ? 'yd²' : 'm²'}`;
    return `${fixed(big, big < 10 ? 2 : 1)} ${bigUnit}`;
};
// A time in hours as 25 min, 1 h 20 min, or 3 h; under a minute says so.
const formatDuration = (hours) => {
    const min = Math.round(Math.max(0, Number(hours) || 0) * 60);
    if (min < 1) return 'under a minute';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};
// A bearing as 047° NE.
const formatBearing = (deg) => `${String(Math.round(deg) % 360).padStart(3, '0')}° ${compass16(deg)}`;

// Along a path of points ({ lon, lat }), in meters.
const pathMeters = (pts) => (pts || []).reduce((s, p, i, a) => (i ? s + metersBetween(a[i - 1], p) : 0), 0);
// The area inside a ring of points (closed or not), in m², on the same
// sphere as metersBetween (the spherical excess, as GIS tools reckon it).
const areaMeters = (pts) => {
    const ring = (pts || []).slice();
    if (ring.length > 1 && ring[0].lon === ring[ring.length - 1].lon && ring[0].lat === ring[ring.length - 1].lat) ring.pop();
    if (ring.length < 3) return 0;
    const R = 6371008.8, rad = Math.PI / 180;
    let s = 0;
    ring.forEach((p, i) => {
        const q = ring[(i + 1) % ring.length];
        s += (q.lon - p.lon) * rad * (2 + Math.sin(p.lat * rad) + Math.sin(q.lat * rad));
    });
    return Math.abs(s * R * R / 2);
};
// A ring `meters` round a center, as `n` points ({ lon, lat }) on the same
// sphere, for drawing a range ring true at any size and latitude.
const ringPoints = (c, meters, n = 72) => {
    const R = 6371008.8, rad = Math.PI / 180, d = Math.max(0, Number(meters) || 0) / R;
    const f1 = c.lat * rad, l1 = c.lon * rad;
    return Array.from({ length: n }, (_, i) => {
        const t = (i / n) * 2 * Math.PI;
        const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
        const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
        return { lon: l2 / rad, lat: f2 / rad };
    });
};
// The standard rates the time-distance tool offers, in km/h: a road march,
// troops on foot by road and across country (FM 3-21.18's day rates), and a
// helicopter at 120 knots.
const STANDARD_RATES = [
    { id: 'road', kind: 'vehicle', label: 'Vehicles, road march', kmh: 40 },
    { id: 'foot', kind: 'dismount', label: 'Dismounts, on a road', kmh: 4 },
    { id: 'cross', kind: 'dismount', label: 'Dismounts, cross-country', kmh: 2 },
    { id: 'air', kind: 'aircraft', label: 'Aircraft, helicopter', kmh: 120 * M_PER_NM / 1000 },
];

// What a report's Size moves as, from the catalogue's roles (and the team's
// entries, `team`): 'aircraft' when it is aviation (with any troops aboard),
// 'dismount' when it is people on foot (with what they carry, an RPG say),
// else 'vehicle', which is also what equipment the catalogue doesn't know is.
const movementClass = (size, team = null) => {
    const roles = sizeElements(size, team).map(e => (lookupEquipment(e.type, team) || {}).role || null);
    if (roles.includes('air') && roles.every(r => r === 'air' || r === 'infantry')) return 'aircraft';
    if (roles.includes('infantry') && roles.every(r => r === 'infantry' || r === 'atgm')) return 'dismount';
    return 'vehicle';
};

// Faster than this, a leg is a typo or a late report, not a rate of march:
// the page says nothing rather than a silly number.
const MARCH_MAX_KMH = { vehicle: 120, dismount: 20, aircraft: 1000 };
// A report's rate of march, from its versions in the order reported (as
// reportTracks takes them): each leg from the last version at one grid to
// the first at the next, and overall, from leaving the first grid to
// reaching the last (halts on the way included). A version without a grid
// is passed over; a leg with less than a minute between its ends, or a time
// that can't be read, or one past MARCH_MAX_KMH for `kind`, is left out, and
// so is the overall rate when it would be.
//   legs     [{ from, to, meters, hours, kmh }]: from and to the versions
//            themselves (a history entry, or the report for its latest)
//   overall  { meters, hours, kmh } or null
const marchRates = (r, kind = 'vehicle') => {
    const none = { legs: [], overall: null };
    if (!r) return none;
    const versions = [...(r.history || [])].sort((a, b) => (new Date(a.time) - new Date(b.time)) || (a.lastModified - b.lastModified));
    const runs = [];
    [...versions, r].forEach(v => {
        const g = findGrids(v.location)[0];
        if (!g) return;
        const last = runs[runs.length - 1];
        if (last && last.mgrs === g.mgrs) { last.last = v; return; }
        runs.push({ mgrs: g.mgrs, lon: g.lon, lat: g.lat, first: v, last: v });
    });
    if (runs.length < 2) return none;
    const max = MARCH_MAX_KMH[kind] || MARCH_MAX_KMH.vehicle;
    const rate = (meters, from, to) => {
        const ms = new Date(to.time).getTime() - new Date(from.time).getTime();
        if (!isFinite(ms) || ms < 60000) return null;
        const hours = ms / 3600000, kmh = meters / 1000 / hours;
        return kmh <= max ? { meters, hours, kmh } : null;
    };
    const legs = [];
    let meters = 0;
    runs.slice(1).forEach((b, i) => {
        const a = runs[i], m = metersBetween(a, b);
        meters += m;
        const got = rate(m, a.last, b.first);
        if (got) legs.push({ from: a.last, to: b.first, ...got });
    });
    return { legs, overall: legs.length ? rate(meters, runs[0].last, runs[runs.length - 1].first) : null };
};

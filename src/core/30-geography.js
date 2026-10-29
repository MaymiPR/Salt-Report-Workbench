// SPDX-License-Identifier: AGPL-3.0-only
// Geography: MGRS, overlays, and what a Location box says. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Geography: MGRS, overlays, and what a Location box says ---

// UTM to latitude/longitude on WGS84, by Krüger's series (Karney 2011), which
// stays sub-millimeter well beyond a zone's edge (Norway's and Svalbard's wide
// zones included).
const WGS84_A = 6378137, WGS84_F = 1 / 298.257223563, UTM_K0 = 0.9996;
const KRUGER = (() => {
    const n = WGS84_F / (2 - WGS84_F), n2 = n*n, n3 = n2*n, n4 = n3*n, n5 = n4*n, n6 = n5*n;
    return {
        A: WGS84_A / (1 + n) * (1 + n2/4 + n4/64 + n6/256),
        beta: [
            n/2 - 2*n2/3 + 37*n3/96 - n4/360 - 81*n5/512 + 96199*n6/604800,
            n2/48 + n3/15 - 437*n4/1440 + 46*n5/105 - 1118711*n6/3870720,
            17*n3/480 - 37*n4/840 - 209*n5/4480 + 5569*n6/90720,
            4397*n4/161280 - 11*n5/504 - 830251*n6/7257600,
            4583*n5/161280 - 108847*n6/3991680,
            20648693*n6/638668800,
        ],
    };
})();
const utmToLatLon = (zone, south, easting, northing) => {
    const e = Math.sqrt(WGS84_F * (2 - WGS84_F));
    const xi  = (south ? northing - 10000000 : northing) / (UTM_K0 * KRUGER.A);
    const eta = (easting - 500000) / (UTM_K0 * KRUGER.A);
    let xi1 = xi, eta1 = eta;
    KRUGER.beta.forEach((b, i) => {
        const j = 2 * (i + 1);
        xi1  -= b * Math.sin(j*xi) * Math.cosh(j*eta);
        eta1 -= b * Math.cos(j*xi) * Math.sinh(j*eta);
    });
    const tau1 = Math.sin(xi1) / Math.sqrt(Math.sinh(eta1)**2 + Math.cos(xi1)**2);
    let tau = tau1;
    for (let k = 0; k < 10; k++) {  // Newton on the conformal latitude; converges in 2-3
        const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau*tau)));
        const taui  = tau * Math.sqrt(1 + sigma*sigma) - sigma * Math.sqrt(1 + tau*tau);
        const d = (tau1 - taui) / Math.sqrt(1 + taui*taui)
            * (1 + (1 - e*e) * tau*tau) / ((1 - e*e) * Math.sqrt(1 + tau*tau));
        tau += d;
        if (Math.abs(d) < 1e-12) break;
    }
    const lon0 = (zone - 1) * 6 - 177;
    return {
        lat: Math.atan(tau) * 180 / Math.PI,
        lon: lon0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) * 180 / Math.PI,
    };
};

// Latitude/longitude to UTM on WGS84, Krüger's series forward (Karney 2011).
const KRUGER_ALPHA = (() => {
    const n = WGS84_F / (2 - WGS84_F), n2 = n*n, n3 = n2*n, n4 = n3*n, n5 = n4*n, n6 = n5*n;
    return [
        n/2 - 2*n2/3 + 5*n3/16 + 41*n4/180 - 127*n5/288 + 7891*n6/37800,
        13*n2/48 - 3*n3/5 + 557*n4/1440 + 281*n5/630 - 1983433*n6/1935360,
        61*n3/240 - 103*n4/140 + 15061*n5/26880 + 167603*n6/181440,
        49561*n4/161280 - 179*n5/168 + 6601661*n6/7257600,
        34729*n5/80640 - 3418889*n6/1995840,
        212378941*n6/319334400,
    ];
})();
const latLonToUtm = (lat, lon, zone) => {
    const e = Math.sqrt(WGS84_F * (2 - WGS84_F)), rad = Math.PI / 180;
    const phi = lat * rad, dl = (lon - ((zone - 1) * 6 - 177)) * rad;
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
    const xi1 = Math.atan2(t, Math.cos(dl)), eta1 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t*t));
    let xi = xi1, eta = eta1;
    KRUGER_ALPHA.forEach((a, i) => {
        const j = 2 * (i + 1);
        xi  += a * Math.sin(j*xi1) * Math.cosh(j*eta1);
        eta += a * Math.cos(j*xi1) * Math.sinh(j*eta1);
    });
    return { easting: 500000 + UTM_K0 * KRUGER.A * eta, northing: UTM_K0 * KRUGER.A * xi + (lat < 0 ? 10000000 : 0) };
};

const MGRS_BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const MGRS_COLS  = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const MGRS_ROWS  = 'ABCDEFGHJKLMNPQRSTUV';

// One MGRS grid (zone, band, 100 km square, digits) as the center of the
// square it names: "38SMB4488" is a 1 km square, and the point is its middle.
// The 100 km row letters repeat every 2,000 km, so of the northings they
// allow, the one that lands inside the latitude band is the grid's. Null when
// the letters can't belong together (a typo).
const gridToLatLon = (zone, band, col, row, digits) => {
    band = band.toUpperCase(); col = col.toUpperCase(); row = row.toUpperCase();
    const bandIdx = MGRS_BANDS.indexOf(band);
    if (zone < 1 || zone > 60 || bandIdx < 0 || digits.length % 2 || digits.length < 2 || digits.length > 10) return null;
    const set    = zone % 6 || 6;
    const colIdx = MGRS_COLS[(set - 1) % 3].indexOf(col);
    const rowIdx = MGRS_ROWS.indexOf(row);
    if (colIdx < 0 || rowIdx < 0) return null;
    const p    = digits.length / 2;
    const cell = 10 ** (5 - p);
    const easting = (colIdx + 1) * 100000 + Number(digits.slice(0, p)) * cell + cell / 2;
    const north   = ((rowIdx - (set % 2 ? 0 : 5) + 20) % 20) * 100000 + Number(digits.slice(p)) * cell + cell / 2;
    const south   = bandIdx < MGRS_BANDS.indexOf('N');
    const minLat  = -80 + 8 * bandIdx, maxLat = band === 'X' ? 84 : minLat + 8;
    let best = null;
    for (let n = north; n < 10000000; n += 2000000) {
        const ll  = utmToLatLon(zone, south, easting, n);
        const off = ll.lat < minLat ? minLat - ll.lat : ll.lat > maxLat ? ll.lat - maxLat : 0;
        if (off < 0.6 && (!best || off < best.off)) best = { ...ll, off };
    }
    if (!best) return null;
    const e = digits.slice(0, p), n = digits.slice(p);
    return { lat: best.lat, lon: best.lon, precision: cell, mgrs: `${zone}${band} ${col}${row} ${e} ${n}` };
};

// A point as an MGRS grid, "11S NV 39697 06762" (`digits` per half, 1-5),
// or null outside MGRS (beyond 80°S and 84°N, where UPS applies). The zone
// follows the standard's exceptions: 32V is widened over Norway, and around
// Svalbard only zones 31, 33, 35 and 37 are used.
const latLonToMgrs = (lat, lon, digits = 5) => {
    if (!(lat >= -80 && lat <= 84) || !Number.isFinite(lon)) return null;
    digits = Number.isFinite(Number(digits)) ? Math.max(1, Math.min(5, Math.round(Number(digits)))) : 5;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    let zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
    if (lat >= 72) {
        if (lon >= 0 && lon < 9) zone = 31;
        else if (lon >= 9 && lon < 21) zone = 33;
        else if (lon >= 21 && lon < 33) zone = 35;
        else if (lon >= 33 && lon < 42) zone = 37;
    }
    const band = MGRS_BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
    const { easting, northing } = latLonToUtm(lat, lon, zone);
    const set = zone % 6 || 6;
    const col = MGRS_COLS[(set - 1) % 3][Math.floor(easting / 100000) - 1];
    const row = MGRS_ROWS[(Math.floor(northing / 100000) + (set % 2 ? 0 : 5)) % 20];
    if (!col || !row) return null;
    const half = (v) => String(Math.floor(v % 100000)).padStart(5, '0').slice(0, digits);
    return `${zone}${band} ${col}${row} ${half(easting)} ${half(northing)}`;
};

// Every MGRS grid in a piece of text, with where it sits in the text. Takes
// "38S MB 12345 67890", "38SMB1234567890" and "38smb 1234 5678"; a grid's two
// halves typed apart must be the same length. I and O are never grid letters,
// so "NAI 1" and "OBJ 2" can't be mistaken for one.
const GRID_RE = /(^|[^0-9A-Za-z])(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d{1,10})(?:\s+(\d{1,5}))?(?![0-9A-Za-z])/gi;
const findGrids = (text) => {
    const s = String(text || ''), out = [];
    const re = new RegExp(GRID_RE.source, 'gid');
    let m;
    while ((m = re.exec(s))) {
        let digits = m[6], end = m.indices[0][1];
        if (m[7] !== undefined) {
            // Halves of different lengths: the second number isn't part of
            // this grid, and may start the next thing.
            if (m[6].length === m[7].length) digits = m[6] + m[7];
            else re.lastIndex = end = m.indices[6][1];
        }
        const ll = gridToLatLon(Number(m[2]), m[3], m[4], m[5], digits);
        if (ll) out.push({ ...ll, start: m.indices[2][0], end });
    }
    return out;
};

// Named places as operators type them: "NAI 1", "nai01", "OBJ GOLD",
// "Objective Gold", "PL BLUE", "Phase Line Blue". Numbers lose leading zeros,
// so NAI 01 and NAI 1 are one place. A bare "PL" glued to letters ("PLATOON")
// is not a phase line; "PL3" is. The long forms are words of their own too
// ("our objective", "the phase line"), so after them a name is a number or
// starts with a capital ("Objective Silver"); and the common words below are
// never a name, whatever comes before them ("vic objective area", "obj is
// clear"). A single letter stays a name: OBJ A is a real objective.
const REF_TYPES = { NAI: 'NAI', OBJ: 'OBJ', OBJECTIVE: 'OBJ', PL: 'PL', 'PHASE LINE': 'PL' };
const REF_RE = /(^|[^A-Za-z0-9])(NAI|OBJECTIVE|OBJ|PHASE\s+LINE|PL)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/gi;
const REF_STOP = new Set(['AREA', 'AREAS', 'OF', 'IS', 'WAS', 'ARE', 'THE', 'AN', 'AND', 'OR', 'TO', 'IN', 'ON', 'AT', 'BY', 'FOR',
    'FROM', 'WITH', 'NEAR', 'INTO', 'ALONG', 'VIC', 'NOT', 'NO', 'CLEAR', 'CLEARED', 'SECURE', 'SECURED', 'TAKEN', 'SEIZED', 'REACHED']);
const refName = (name) => { const n = String(name).toUpperCase(); return /^\d+$/.test(n) ? String(Number(n)) : n; };
// The place a prefix as typed and the word after it name, or null when the
// word isn't a name.
const refOf = (prefix, word) => {
    const type = REF_TYPES[prefix.toUpperCase().replace(/\s+/g, ' ')];
    if (!type || !word || REF_STOP.has(word.toUpperCase())) return null;
    if (prefix.length > 3 && !/^[0-9A-Z]/.test(word)) return null;   // OBJECTIVE, PHASE LINE
    const name = refName(word);
    return { type, name, key: `${type} ${name}` };
};
// "PC-12344", "PC 12344", "pc12344": an NAI by its number alone, named
// PC-12344 (with or without "NAI" before it). PC is also a 100 km square, so
// not after a grid zone ("38S PC 12345 67890") or before a second number.
const PC_RE = /(^|[^A-Za-z0-9])(?:NAI\s*[-#:.]?\s*)?(PC)\s*-?\s*(\d+)(?![A-Za-z0-9]|\s+\d)/gi;
const pcRef = (digits) => { const name = `PC-${digits}`; return { type: 'NAI', name, key: `NAI ${name}` }; };
const afterZone = (before) => /\d{1,2}\s*[C-HJ-NP-X]\s*$/i.test(before);
// Every place named in some text, in order, with where its prefix starts and
// its name ends.
const refMatches = (text) => {
    const s = String(text || ''), out = [];
    const pcs = [];
    const pc = new RegExp(PC_RE.source, 'gid');
    let m;
    while ((m = pc.exec(s))) {
        if (!afterZone(s.slice(0, m.index + m[1].length))) pcs.push({ ...pcRef(m[3]), start: m.indices[0][0] + m[1].length, end: m.indices[3][1] });
    }
    const re = new RegExp(REF_RE.source, 'gid');
    while ((m = re.exec(s))) {
        const ref = refOf(m[2], m[3]);
        if (!ref) continue;
        // "NAI PC-12344" is the PC's NAI, not one named PC.
        if (pcs.some(p => m.indices[2][0] >= p.start && m.indices[2][0] < p.end)) continue;
        // "38S PL 12345": the 100 km square of a grid that didn't read as one
        // (a typo), not a phase line.
        if (ref.type === 'PL' && /\d{1,2}\s*[C-HJ-NP-X]\s*$/i.test(s.slice(0, m.index + m[1].length))) continue;
        out.push({ ...ref, start: m.indices[2][0], end: m.indices[3][1] });
    }
    return [...out, ...pcs].sort((x, y) => x.start - y.start);
};
const findRefs = (text) => {
    const out = [], seen = new Set();
    refMatches(text).forEach(({ type, name, key }) => { if (!seen.has(key)) { seen.add(key); out.push({ type, name, key }); } });
    return out;
};

// An overlay's name ("NAI 3", "OBJ Gold (bridge)", "Gold") as a place
// reference. The name is its first word after the prefix, as when typed (and
// by the same rules). Without a prefix, `fallbackType` decides, with the
// first word that isn't a common one; null when neither does. An axis of
// advance is named so in a file too ("AXIS GOLD", "AOA 2", "Axis of advance
// North"), though only as a graphic's name: a Location box never names one.
const AXIS_NAME = /^(AXIS\s+OF\s+ADVANCE|AXIS|AOA)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/i;
const AXIS_WORDS = new Set(['AXIS', 'AOA', 'ADVANCE']);
const overlayRef = (rawName, fallbackType) => {
    const s = String(rawName || '').trim();
    const pc = new RegExp(`^${PC_RE.source.slice('(^|[^A-Za-z0-9])'.length)}`, 'i').exec(s);
    if (pc) return pcRef(pc[2]);
    const m = /^(NAI|OBJECTIVE|OBJ|PHASE\s+LINE|PL)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/i.exec(s);
    const own = m && refOf(m[1], m[2]);
    if (own) return own;
    const axis = AXIS_NAME.exec(s);
    if (axis && !REF_STOP.has(axis[2].toUpperCase())) { const name = refName(axis[2]); return { type: 'AXIS', name, key: `AXIS ${name}` }; }
    const word = (s.match(/[A-Za-z0-9]+/g) || []).find(w => !REF_STOP.has(w.toUpperCase()) && !(fallbackType === 'AXIS' && AXIS_WORDS.has(w.toUpperCase())));
    if (!fallbackType || !word) return null;
    const name = refName(word);
    return { type: fallbackType, name, key: `${fallbackType} ${name}` };
};

// Ray casting in longitude/latitude: exact enough for areas a few tens of
// kilometers across. Holes (inner rings) exclude.
const inRing = (lon, lat, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};
const inPolygon = (lon, lat, rings) => rings.length > 0 && inRing(lon, lat, rings[0]) && !rings.slice(1).some(h => inRing(lon, lat, h));
const geometryContains = (g, lon, lat) =>
    g.type === 'Polygon' ? inPolygon(lon, lat, g.coordinates)
  : g.type === 'MultiPolygon' ? g.coordinates.some(p => inPolygon(lon, lat, p))
  : false;

// Meters from a point to a line, on a flat projection centered on the point:
// within a fraction of a percent over the tens of kilometers that matter here.
const metersToLine = (lon, lat, line) => {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const ax = (line[i-1][0] - lon) * kx, ay = (line[i-1][1] - lat) * ky;
        const bx = (line[i][0]   - lon) * kx, by = (line[i][1]   - lat) * ky;
        const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
        const t  = len2 ? Math.max(0, Math.min(1, -(ax*dx + ay*dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + t*dx, ay + t*dy));
    }
    return best;
};
// The segment of a line nearest a point, on the same flat projection:
// { meters, bearingDeg }, its bearing from the segment's start to its end
// (the way the line was drawn), or null for a line of no length.
const nearestSegment = (lon, lat, line) => {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
    let best = null;
    for (let i = 1; i < line.length; i++) {
        const ax = (line[i-1][0] - lon) * kx, ay = (line[i-1][1] - lat) * ky;
        const bx = (line[i][0]   - lon) * kx, by = (line[i][1]   - lat) * ky;
        const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
        if (!len2) continue;
        const t = Math.max(0, Math.min(1, -(ax*dx + ay*dy) / len2));
        const meters = Math.hypot(ax + t*dx, ay + t*dy);
        if (!best || meters < best.meters) {
            best = { meters, bearingDeg: bearingBetween({ lon: line[i-1][0], lat: line[i-1][1] }, { lon: line[i][0], lat: line[i][1] }) };
        }
    }
    return best;
};
const metersToGeometry = (g, lon, lat) =>
    g.type === 'LineString' ? metersToLine(lon, lat, g.coordinates)
  : g.type === 'MultiLineString' ? Math.min(...g.coordinates.map(l => metersToLine(lon, lat, l)))
  : Infinity;

// A grid this close to a phase line counts as a report at that line.
const PL_NEAR_METERS = 1000;

// An NAI or OBJ drawn as a path (Google Earth's Add Path, or a ring on its
// own) is still an area: each path is closed back to its start. A path of
// fewer than three points (or none) stays a line.
const asArea = (g) => {
    const ring = (line) => {
        if (!Array.isArray(line) || line.length < 3 || !line.every(Array.isArray)) return null;
        const r = line.slice(), a = r[0], b = r[r.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
        return r.length >= 4 ? [r] : null;
    };
    if (!g) return g;
    if (g.type === 'LineString') { const p = ring(g.coordinates); return p ? { type: 'Polygon', coordinates: p } : g; }
    if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
        const ps = g.coordinates.map(ring).filter(Boolean);
        return ps.length ? { type: 'MultiPolygon', coordinates: ps } : g;
    }
    return g;
};

// A graphic with one of the team's own tags (its type the tag's id): an area
// of one places the reports inside it, as an NAI does, by the graphic's name
// as it is ("Route Gold"); and that name typed in a Location counts too.
const isTeamTagged = (o) => TAG_ID.test(o.type);
// Whether some text names a graphic: its name as whole words, in any case.
// A name of one character, or with no letter or digit, is never read as typed.
const graphicNameRe = new Map();
const namesGraphic = (text, name) => {
    if (name.length < 2 || !/[A-Za-z0-9]/.test(name)) return false;
    if (!graphicNameRe.has(name)) {
        const words = name.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        graphicNameRe.set(name, new RegExp(`(^|[^A-Za-z0-9])${words.join('\\s+')}(?![A-Za-z0-9])`, 'i'));
    }
    return graphicNameRe.get(name).test(text);
};

// What a Location box says, read against the workspace's overlays:
//   points  the grids, as lat/lon (a report can name several)
//   nai/obj the places it's in: as typed, or (when none was typed) the
//           overlays its grids fall inside, marked 'grid'
//   pl      phase lines typed, and the nearest PL overlay with its distance
//   pls     the phase lines it is at: typed, or the nearest within
//           PL_NEAR_METERS of a grid
//   checks  where a typed NAI or OBJ disagrees with the grid. The typed name
//           still counts; the check is for a person to look at.
//   custom  graphics with the team's own tags it names ({ key: the name,
//           type, from: 'typed' }) or whose areas its grids are in ('grid').
//           Only the Location naming and the map use these; the statistics
//           and the narrative keep to NAI, OBJ and PL.
const analyzeLocation = (text, overlays) => {
    const points = findGrids(text);
    let rest = String(text || '');
    points.forEach(p => { rest = rest.slice(0, p.start) + ' '.repeat(p.end - p.start) + rest.slice(p.end); });
    const refs = findRefs(rest);
    const typed = t => refs.filter(r => r.type === t).map(r => r.key);
    // An overlay the server wouldn't take is left out, so one bad shape
    // can't stop every report being read.
    const ovs = (overlays || []).filter(overlayOk);
    const keyOf = overlayKey;
    const contains = (o) => points.some(p => geometryContains(o.geometry, p.lon, p.lat));
    const checks = [];
    const place = (t) => {
        const keys  = typed(t);
        const areas = ovs.filter(o => o.type === t).map(o => ({ ...o, geometry: asArea(o.geometry) }))
            .filter(o => /Polygon/.test(o.geometry.type));
        const inside = [...new Set(areas.filter(contains).map(keyOf))];
        if (!keys.length) return { keys: inside, from: inside.length ? 'grid' : '' };
        if (points.length) {
            keys.forEach(k => {
                const own = areas.filter(o => keyOf(o) === k);
                if (own.length && !own.some(contains)) {
                    const other = inside.filter(i => !keys.includes(i));
                    checks.push(other.length ? `${k} typed; grid is in ${other.join(', ')}` : `${k} typed; grid is outside it`);
                }
            });
        }
        return { keys, from: 'typed' };
    };
    const nai = place('NAI'), obj = place('OBJ');
    let nearestPl = null;
    ovs.filter(o => o.type === 'PL').forEach(o => points.forEach(p => {
        const d = metersToGeometry(o.geometry, p.lon, p.lat);
        if (isFinite(d) && (!nearestPl || d < nearestPl.meters)) nearestPl = { key: keyOf(o), meters: d };
    }));
    const custom = [], seen = new Set();
    ovs.filter(isTeamTagged).forEach(o => {
        const key = o.name.trim(), k = key.toUpperCase();
        if (seen.has(k)) return;
        const named = namesGraphic(rest, key);
        if (!named && !(/Polygon/.test(o.geometry.type) && contains(o))) return;
        seen.add(k);
        custom.push({ key, type: o.type, from: named ? 'typed' : 'grid' });
    });
    return {
        points: points.map(({ start, end, ...p }) => p),
        nai, obj, pl: typed('PL'), nearestPl, checks, custom,
        pls: [...new Set([...typed('PL'), ...(nearestPl && nearestPl.meters <= PL_NEAR_METERS ? [nearestPl.key] : [])])],
    };
};

// What Log or Update should do to a Location box, read against the overlays:
//   add        places its grids are in (or, for a phase line, within
//              PL_NEAR_METERS of) that the box doesn't name yet; added only
//              for a type nothing was typed for. Then each area of the
//              team's own tags a grid is in, by name, unless it is named.
//              Every place added for a grid is added here, nowhere else.
//   conflicts  typed NAIs, OBJs and PLs the grids disagree with, each with
//              what the grids say instead (`found`, may be empty), for the
//              operator to settle
// Nothing to do without a grid, or for a typed name with no overlay to check.
const locationPlan = (text, overlays) => {
    const a = analyzeLocation(text, overlays);
    const plan = { add: [], conflicts: [] };
    if (!a.points.length) return plan;
    const ovs = (overlays || []).filter(overlayOk);
    const keyOf = overlayKey;
    ['NAI', 'OBJ'].forEach(t => {
        const p = t === 'NAI' ? a.nai : a.obj;
        if (p.from === 'grid') { plan.add.push(...p.keys); return; }
        const areas = ovs.filter(o => o.type === t).map(o => ({ ...o, geometry: asArea(o.geometry) }))
            .filter(o => /Polygon/.test(o.geometry.type));
        const inside = o => a.points.some(pt => geometryContains(o.geometry, pt.lon, pt.lat));
        const found = [...new Set(areas.filter(inside).map(keyOf))].filter(k => !p.keys.includes(k));
        p.keys.forEach(k => {
            const own = areas.filter(o => keyOf(o) === k);
            if (own.length && !own.some(inside)) plan.conflicts.push({ type: t, typed: k, found,
                message: found.length ? `${k} typed; grid is in ${found.join(', ')}` : `${k} typed; grid is outside it` });
        });
    });
    // The team's tags: each area a grid is in, by its name, unless named already.
    a.custom.forEach(c => { if (c.from === 'grid') plan.add.push(c.key); });
    const near = a.nearestPl && a.nearestPl.meters <= PL_NEAR_METERS ? a.nearestPl : null;
    if (!a.pl.length) { if (near) plan.add.push(near.key); return plan; }
    a.pl.forEach(k => {
        const own = ovs.filter(o => o.type === 'PL' && keyOf(o) === k);
        if (!own.length) return;
        const d = Math.min(...own.flatMap(o => a.points.map(pt => metersToGeometry(o.geometry, pt.lon, pt.lat))));
        if (d <= PL_NEAR_METERS) return;
        const found = near && !a.pl.includes(near.key) ? [near.key] : [];
        const km = (d / 1000).toFixed(1);
        plan.conflicts.push({ type: 'PL', typed: k, found,
            message: found.length ? `${k} typed; grid is ${km} km from it, ${Math.round(near.meters)} m from ${near.key}` : `${k} typed; grid is ${km} km from it` });
    });
    return plan;
};

// A Location box with typed places swapped (`replace`: key -> what to write
// in its place, '' to take it out) and those in `add` appended (", NAI 1")
// unless already named. Grids and everything else are left as they were.
const editLocation = (text, { replace = {}, add = [] } = {}) => {
    let s = String(text || '');
    const blank = (str) => {
        let out = str;
        findGrids(str).forEach(p => { out = out.slice(0, p.start) + ' '.repeat(p.end - p.start) + out.slice(p.end); });
        return out;
    };
    if (Object.keys(replace).length) {
        const spans = refMatches(blank(s)).filter(r => r.key in replace).map(r => [r.start, r.end, replace[r.key]]);
        if (spans.length) {
            spans.reverse().forEach(([x, y, to]) => { s = s.slice(0, x) + to + s.slice(y); });
            s = s.replace(/\s*,(\s*,)+\s*/g, ', ').replace(/[ \t]{2,}/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '');
        }
    }
    const have = new Set(findRefs(blank(s)).map(r => r.key));
    const extra = [...new Set(add)].filter(k => !have.has(k));
    const head = s.replace(/[\s,;]+$/, '');
    if (extra.length) s = (head ? head + ', ' : '') + extra.join(', ');
    return s;
};

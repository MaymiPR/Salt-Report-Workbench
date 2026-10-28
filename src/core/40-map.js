// SPDX-License-Identifier: AGPL-3.0-only
// Shapefiles read, tracks, heat, the map, and activity tags. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Shapefiles ---

// Web Mercator (ArcGIS's default for web layers) to longitude / latitude.
const webMercatorToLonLat = ([x, y]) => [x / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI];

// What a .prj (WKT, as ArcGIS writes it) says the coordinates are, as
// { name, toLonLat }: geographic (WGS 84, NAD 83), Web Mercator, or a UTM zone
// on WGS 84 or NAD 83 (a metre or so apart, well inside a grid square). Any
// other system is refused by name. Null without a .prj.
const shapefileProjection = (wkt) => {
    const s = String(wkt || '').trim();
    if (!s) return null;
    const name = ((/^(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\s*\[\s*"([^"]*)"/i.exec(s) || [])[1] || 'an unknown coordinate system').replace(/_/g, ' ');
    if (/^GEOG(CS|CRS)\b/i.test(s)) return { name, toLonLat: c => c };
    if (/Mercator_Auxiliary_Sphere|Pseudo[-_ ]Mercator|Popular_Visuali[sz]ation|\b(3857|102100|102113|900913)\b/i.test(s)) {
        return { name, toLonLat: webMercatorToLonLat };
    }
    const param = (k) => { const m = new RegExp(`PARAMETER\\s*\\[\\s*"${k}"\\s*,\\s*(-?[\\d.]+)`, 'i').exec(s); return m ? Number(m[1]) : null; };
    const datum = /WGS[ _]?(19)?84|NAD[ _]?(19)?83|North[ _]American[ _]1983/i.test(s);
    if (datum && /Transverse[ _]Mercator/i.test(s) && param('scale_factor') === 0.9996 && param('false_easting') === 500000) {
        const fn = param('false_northing') || 0;
        const zone = (param('central_meridian') + 183) / 6;
        if (Number.isInteger(zone) && zone >= 1 && zone <= 60 && (fn === 0 || fn === 10000000)) {
            const south = fn === 10000000;
            return { name, toLonLat: ([x, y]) => { const ll = utmToLatLon(zone, south, x, y); return [ll.lon, ll.lat]; } };
        }
    }
    throw new Error(`its coordinates are in ${name}. Export it again in WGS 1984 (or as KML)`);
};

// The rows of a .dbf (dBASE) attribute table, one object per record, in the
// order of the shapes. Text is UTF-8 when the .cpg says so or it reads as
// UTF-8, else Windows-1252 (what ArcGIS writes for older layers).
const readDbf = (buf, cpg) => {
    const dv = new DataView(buf), bytes = new Uint8Array(buf);
    if (buf.byteLength < 32) return [];
    const n = dv.getUint32(4, true), headLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
    const fields = [];
    for (let o = 32; o + 32 <= headLen && bytes[o] !== 0x0d; o += 32) {
        let name = '';
        for (let k = 0; k < 11 && bytes[o + k]; k++) name += String.fromCharCode(bytes[o + k]);
        fields.push({ name, type: String.fromCharCode(bytes[o + 11]).toUpperCase(), len: bytes[o + 16] });
    }
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const latin = new TextDecoder('windows-1252');
    const wantUtf8 = /utf-?8|65001/i.test(cpg || '');
    const text = (b) => {
        if (wantUtf8 || !cpg) { try { return utf8.decode(b); } catch (e) { if (wantUtf8) return new TextDecoder('utf-8').decode(b); } }
        return latin.decode(b);
    };
    const rows = [];
    for (let r = 0; r < n; r++) {
        const at = headLen + r * recLen;
        if (at + recLen > buf.byteLength) break;
        const row = {};
        let o = at + 1;  // after the deletion flag
        fields.forEach(f => {
            const v = text(bytes.subarray(o, o + f.len)).trim();
            o += f.len;
            row[f.name] = (f.type === 'N' || f.type === 'F') && v !== '' && isFinite(Number(v)) ? Number(v) : v;
        });
        rows.push(row);
    }
    return rows;
};

// Twice a ring's signed area: negative when it runs clockwise, which in a
// shapefile marks an outer ring (holes run the other way).
const ringArea2 = (r) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
const inRingXY = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};

// A shapefile as a GeoJSON FeatureCollection in longitude / latitude, with
// each shape's attributes as its properties: points, lines (PolyLine), and
// areas (Polygon, holes kept), with or without Z and M. Throws a message for
// the user when it can't be read: a fragment ("it is not a shapefile") that
// the caller puts after the file's name.
const SHP_DAMAGED = 'it is damaged (a shape runs past its end). Export it again';
const parseShapefile = (shp, dbf, prj, cpg) => {
    try {
        return readShapefile(shp, dbf, prj, cpg);
    } catch (e) {
        // A count or offset that points outside the file, read anyway.
        if (e instanceof RangeError) throw new Error(SHP_DAMAGED);
        throw e;
    }
};
const readShapefile = (shp, dbf, prj, cpg) => {
    const dv = new DataView(shp);
    if (shp.byteLength < 100 || dv.getInt32(0) !== 9994) throw new Error('it is not a shapefile (.shp)');
    const proj = shapefileProjection(prj);
    const rows = dbf ? readDbf(dbf, cpg) : [];
    const features = [];
    for (let p = 100, i = 0; p + 12 <= shp.byteLength; i++) {
        // The content length is in 16-bit words, at least the shape type's two.
        const words = dv.getInt32(p + 4), start = p + 8, end = start + words * 2;
        if (words < 2 || end <= p) break;
        p = end;
        if (end > shp.byteLength) break;
        // Each count is checked against the record before anything is read.
        const fits = (bytes, ...counts) => { if (counts.some(n => n < 0) || start + bytes > end) throw new Error(SHP_DAMAGED); };
        const type = dv.getInt32(start, true);
        const kind = type === 31 ? 0 : type % 10;  // 1 point, 3 line, 5 area, 8 multipoint (Z, M alike); 31 multipatch
        const xy = (at) => [dv.getFloat64(at, true), dv.getFloat64(at + 8, true)];
        let geometry = null;
        if (kind === 1) { fits(20); geometry = { type: 'Point', coordinates: xy(start + 4) }; }
        else if (kind === 8) {
            fits(40);
            const n = dv.getInt32(start + 36, true);
            fits(40 + 16 * n, n);
            geometry = { type: 'MultiPoint', coordinates: Array.from({ length: n }, (_, k) => xy(start + 40 + 16 * k)) };
        } else if (kind === 3 || kind === 5) {
            fits(44);
            const nParts = dv.getInt32(start + 36, true), nPts = dv.getInt32(start + 40, true);
            fits(44 + 4 * nParts + 16 * nPts, nParts, nPts);
            const parts = Array.from({ length: nParts }, (_, k) => dv.getInt32(start + 44 + 4 * k, true));
            if (parts.some((s, k) => s < 0 || s > nPts || (k && s < parts[k - 1]))) throw new Error(SHP_DAMAGED);
            const at0 = start + 44 + 4 * nParts;
            const paths = parts.map((s, k) => Array.from({ length: (k + 1 < nParts ? parts[k + 1] : nPts) - s }, (_, m) => xy(at0 + 16 * (s + m))))
                .filter(path => path.length >= 2);
            if (kind === 3) {
                if (paths.length) geometry = paths.length === 1 ? { type: 'LineString', coordinates: paths[0] } : { type: 'MultiLineString', coordinates: paths };
            } else {
                // Each hole goes with the outer ring around it.
                const polys = paths.filter(r => ringArea2(r) < 0).map(r => [r]);
                paths.filter(r => ringArea2(r) >= 0).forEach(h => {
                    const host = polys.find(poly => inRingXY(h[0][0], h[0][1], poly[0])) || null;
                    if (host) host.push(h); else polys.push([h]);  // no outer around it: an area of its own
                });
                if (polys.length) geometry = polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
            }
        }
        features.push({ type: 'Feature', geometry, properties: rows[i] || {} });
    }
    const project = (v) => typeof v[0] === 'number' ? proj.toLonLat(v) : v.map(project);
    if (proj) features.forEach(f => { if (f.geometry) f.geometry.coordinates = project(f.geometry.coordinates); });
    const flat = (v) => typeof v[0] === 'number' ? [v] : v.flatMap(flat);
    const all = features.flatMap(f => f.geometry ? flat(f.geometry.coordinates) : []);
    if (all.some(c => !isFinite(c[0]) || !isFinite(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
        throw new Error(proj ? 'some of its coordinates are out of range' : 'it has no .prj file, and its coordinates are not longitude/latitude. Include the .prj (or zip the shapefile)');
    }
    return { type: 'FeatureCollection', features };
};

// --- Tracks, heat, and the map ---

// Where each report has been: the first grid of each version's Location, in
// the order the versions were reported (their Time), the current one last.
// A grid repeated in a row counts once. `moved` when it has two or more.
//   points     [{ lon, lat, mgrs, time }]
//   lengthM    along the track; bearingDeg from its start to its end
const reportTracks = (reps) => (reps || []).filter(r => !r.deleted).map(r => {
    const versions = [...(r.history || [])].sort((a, b) => (new Date(a.time) - new Date(b.time)) || (a.lastModified - b.lastModified));
    const points = [];
    [...versions, r].forEach(v => {
        const g = findGrids(v.location)[0];
        if (!g) return;
        const last = points[points.length - 1];
        if (last && last.mgrs === g.mgrs) { last.time = v.time; return; }
        points.push({ lon: g.lon, lat: g.lat, mgrs: g.mgrs, time: v.time });
    });
    let lengthM = 0;
    for (let i = 1; i < points.length; i++) lengthM += metresBetween(points[i - 1], points[i]);
    const bearingDeg = points.length >= 2 ? bearingBetween(points[0], points[points.length - 1]) : null;
    return { report: r, points, moved: points.length >= 2, lengthM, bearingDeg };
}).filter(t => t.points.length);

// Metres between two points, and the bearing from the first to the second
// (degrees clockwise from north), on a sphere: plenty for tracks of a few km.
const metresBetween = (a, b) => {
    const R = 6371008.8, f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180;
    const df = f2 - f1, dl = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const bearingBetween = (a, b) => {
    const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};
const compass16 = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

// Where reports were, for the map: each report at the grids of its latest
// Location; or (`all`) every saved version of it, its updates included,
// oldest first, at each version's grids. A weight per point splits each
// version evenly between the grids it names, so each version counts once.
const reportPositions = (reps, all = false) => (reps || []).filter(r => !r.deleted).flatMap(r => {
    const versions = all
        ? [...(r.history || [])].sort((a, b) => (new Date(a.time) - new Date(b.time)) || (a.lastModified - b.lastModified)).concat(r)
        : [r];
    return versions.flatMap(v => {
        const grids = findGrids(v.location);
        return grids.map(g => ({ report: r, lon: g.lon, lat: g.lat, mgrs: g.mgrs, time: v.time, latest: v === r, w: 1 / grids.length }));
    });
});
// The heat map's points: by default each unique report once, at its latest
// Location, however many times it was updated; with `all`, every version.
const heatPoints = (reps, all = false) => reportPositions(reps, all).map(p => ({ lon: p.lon, lat: p.lat, w: p.w }));

// Whether an Activity line has any of these tags (the empty set takes every
// line). 'Untagged' takes a line with none.
const activityMatches = (text, tags) => {
    if (!tags || !tags.size) return true;
    const got = classifyActivity(text).tags;
    return got.length ? got.some(t => tags.has(t)) : tags.has('Untagged');
};

// ArcGIS tracks: one line per report that moved, from its first grid to its
// latest in the order reported, for an arrow symbol at the line's end.
const arcgisTrackRows = (reps, { local, idOf }) => reportTracks(reps).filter(t => t.moved).map(t => {
    const r = t.report, first = t.points[0], last = t.points[t.points.length - 1];
    const act = classifyActivity(r.activity);
    const iso = d => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : '');
    return {
        report_id: idOf(r), ato: r.ato || '', title: r.title || '',
        size: r.size || '', activity: r.activity || '', act_tags: act.tags.join('; '),
        start_utc: iso(first.time), end_utc: iso(last.time),
        start_disp: first.time ? toTimeString(first.time, local) : '', end_disp: last.time ? toTimeString(last.time, local) : '',
        positions: t.points.length, length_m: Math.round(t.lengthM),
        bearing_deg: Math.round(t.bearingDeg), direction: compass16(t.bearingDeg),
        start_mgrs: first.mgrs, end_mgrs: last.mgrs,
        reporter: (r.user && r.user.initials) || '',
        path: t.points.map(p => [Math.round(p.lon * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7]),
    };
});
const attrsOf = (row) => { const { path, ...rest } = row; return rest; };
const arcgisTracksGeoJson = (rows) => JSON.stringify({
    type: 'FeatureCollection',
    features: rows.map(row => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: row.path }, properties: attrsOf(row) })),
});
const arcgisTracksEsriJson = (rows) => esriJson(rows.map(attrsOf), 'esriGeometryPolyline', (row, i) => ({ paths: [rows[i].path] }));

// Web Mercator (the tile services' projection), metres, and back.
const MERC_R = 6378137;
const lonLatToMerc = (lon, lat) => [lon * Math.PI / 180 * MERC_R, Math.log(Math.tan(Math.PI / 4 + Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 360)) * MERC_R];
const MERC_WORLD = 2 * Math.PI * MERC_R;

// The tiles (z/x/y, Google / OSM numbering, as WMTS GoogleMapsCompatible
// and ArcGIS tile services use) covering a Web Mercator box, each with its
// own box. At most `max` tiles; null when that's more.
const tilesFor = ([x0, y0, x1, y1], z, max = 256) => {
    const n = 2 ** z, size = MERC_WORLD / n;
    const col = x => Math.floor((x + MERC_WORLD / 2) / size), row = y => Math.floor((MERC_WORLD / 2 - y) / size);
    const c0 = Math.max(0, col(x0)), c1 = Math.min(n - 1, col(x1)), r0 = Math.max(0, row(y1)), r1 = Math.min(n - 1, row(y0));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > max) return null;
    const out = [];
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) {
        const bx0 = x * size - MERC_WORLD / 2, by1 = MERC_WORLD / 2 - y * size;
        out.push({ z, x, y, box: [bx0, by1 - size, bx0 + size, by1] });
    }
    return out;
};
// The zoom whose tiles show `metresPerPixel` (256-pixel tiles), rounded up for sharpness.
const tileZoom = (metresPerPixel) => Math.max(0, Math.min(20, Math.ceil(Math.log2(MERC_WORLD / 256 / metresPerPixel))));

// A tile's address from a template: {z} {x} {y} (or WMTS's {TileMatrix}
// {TileCol} {TileRow}; {-y} counts rows from the south, as TMS does).
const tileUrl = (template, { z, x, y }) => String(template)
    .replace(/\{(z|TileMatrix)\}/gi, z).replace(/\{(x|TileCol)\}/gi, x)
    .replace(/\{-y\}/gi, 2 ** z - 1 - y).replace(/\{(y|TileRow)\}/gi, y);

// Web Mercator metres back to longitude and latitude.
const mercToLonLat = (x, y) => [x / MERC_R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180 / Math.PI];

// The projections a WMS can draw our map in, best first: Web Mercator under
// its several names (same metres), then longitude / latitude, which the map
// stretches to fit (true to well under a pixel over an area the size of a
// training area).
const WMS_MERC_CRS = ['EPSG:3857', 'EPSG:900913', 'EPSG:102100', 'EPSG:102113', 'EPSG:3785'];
const WMS_CRS_ORDER = [...WMS_MERC_CRS, 'EPSG:4326', 'CRS:84'];
// The projection every chosen layer offers (each a list of codes), or null.
const pickWmsCrs = (lists) => {
    const sets = (lists || []).map(l => new Set((l || []).map(c => String(c).trim().toUpperCase())));
    return WMS_CRS_ORDER.find(c => sets.length && sets.every(s => s.has(c))) || null;
};
// The image format to ask for: PNG if offered, then JPEG, then the first.
const pickWmsFormat = (formats) => {
    const f = (formats || []).map(String);
    return f.find(x => /^image\/png$/i.test(x)) || f.find(x => /^image\/png/i.test(x)) || f.find(x => /jpe?g/i.test(x)) || f[0] || 'image/png';
};

// A service address's parameters, split off: [path, [[key, value], ...]].
// Only the first "?" starts them; a later one is part of a value.
const splitQuery = (url) => {
    const s = String(url).trim(), q = s.indexOf('?');
    const [path, query] = q < 0 ? [s, ''] : [s.slice(0, q), s.slice(q + 1)];
    return [path, query.split('&').filter(Boolean).map(kv => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; })];
};
const WMS_KEYS = new Set(['SERVICE', 'VERSION', 'REQUEST', 'LAYERS', 'STYLES', 'CRS', 'SRS', 'BBOX', 'WIDTH', 'HEIGHT', 'FORMAT', 'TRANSPARENT']);

// The GetCapabilities address for a link to a WMS, whatever request the link
// was for: its own parameters (a map=, a token) are kept.
const wmsCapabilitiesUrl = (link) => {
    const [path, params] = splitQuery(link);
    const keep = params.filter(([k]) => !WMS_KEYS.has(k.toUpperCase())).map(([k, v]) => `${k}=${v}`);
    return `${path}?${[...keep, 'SERVICE=WMS', 'REQUEST=GetCapabilities'].join('&')}`;
};

// A WMS GetMap address for a Web Mercator box: the service's address (its
// own parameters kept, ours replacing any of the same name). The version,
// projection and format are the service's (from its capabilities); without
// them, 1.3.0, EPSG:3857 and PNG. In longitude / latitude, 1.3.0's EPSG:4326
// lists latitude first.
const wmsUrl = (base, layers, [x0, y0, x1, y1], width, height, { version = '1.3.0', crs = 'EPSG:3857', format = 'image/png' } = {}) => {
    const [path, params] = splitQuery(base);
    const code = String(crs).toUpperCase();
    let bbox;
    if (WMS_MERC_CRS.includes(code)) bbox = [x0, y0, x1, y1].map(v => v.toFixed(2));
    else {
        const [lon0, lat0] = mercToLonLat(x0, y0), [lon1, lat1] = mercToLonLat(x1, y1);
        bbox = (version === '1.3.0' && code === 'EPSG:4326' ? [lat0, lon0, lat1, lon1] : [lon0, lat0, lon1, lat1]).map(v => v.toFixed(7));
    }
    const ours = {
        SERVICE: 'WMS', VERSION: version, REQUEST: 'GetMap', LAYERS: layers || '', STYLES: '',
        [version === '1.3.0' ? 'CRS' : 'SRS']: crs, BBOX: bbox.join(','),
        WIDTH: Math.round(width), HEIGHT: Math.round(height), FORMAT: format, TRANSPARENT: 'FALSE',
    };
    const keep = params.filter(([k]) => !WMS_KEYS.has(k.toUpperCase())).map(([k, v]) => `${k}=${v}`);
    if (!layers) {
        const had = params.find(([k]) => k.toUpperCase() === 'LAYERS');
        if (had) ours.LAYERS = decodeURIComponent(had[1]);
    }
    const enc = v => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
    return `${path}?${[...keep, ...Object.entries(ours).map(([k, v]) => `${k}=${enc(v)}`)].join('&')}`;
};

// --- Activity ---

// Tags for what an Activity line describes, in a fixed order, and the
// heading when one is given ("moving N", "heading 270", "NB", "westbound").
// A report can carry several tags ("dismounted, moving N"); a heading implies
// Moving. Plain keyword rules, so the same words always give the same tags.
const ACTIVITY_TAGS = [
    ['Moving',      /\b(mov(e|es|ed|ing)|mvg|mvmt|movement|travel{1,2}(s|ed|ing)?|driv(e|es|ing)|advanc(e|es|ed|ing)|withdraw(s|n|ing)?|retreat(s|ed|ing)?|convoy|en ?route|head(s|ed|ing)|transit(s|ing)?|maneuver(s|ing)?|proceed(s|ing)?|cross(es|ed|ing)|fly(ing)?|flight|[nsew]b|(north|south|east|west)bound)\b/i],
    ['Stationary',  /\b(stationary|static|parked|halt(s|ed)?|stopped|idl(e|ing)|sitting|occupy(ing)?|occupied|holding|loiter(s|ing)?|in position|dug in)\b/i],
    ['Dismounted',  /\b(dismount(s|ed|ing)?|on foot|foot patrol|walking)\b/i],
    ['Emplacing',   /\b(dig(s|ging)?|dug in|emplac(e|es|ed|ing)|entrench(es|ed|ing)?|construct(s|ed|ing)?|build(s|ing)?|fortif(y|ies|ied|ying)|laying (mines?|wire)|obstacles?)\b/i],
    ['Firing',      /\b(fir(e|es|ed|ing)|engag(e|es|ed|ing)|shoot(s|ing)?|launch(es|ed|ing)?|shelling)\b/i],
    ['Observing',   /\b(observ(e|es|ed|ing)|recon(naissance)?|surveil(s|ling|lance)?|scouting)\b/i],
    ['Resupplying', /\b(resuppl(y|ies|ying)|refuel(s|ing|ling)?|rearm(s|ing)?|loading|unloading)\b/i],
];
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const DIR_WORDS = {
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};
// Firing words that aren't contact: fire support, a firing position, a
// cease-fire, a launch site. They don't make a line Firing.
const NOT_CONTACT = /\b(fire support|fir(e|ing) positions?|cease[- ]?fire|fire teams?|launch (sites?|points?|positions?))\b/gi;
// Where a line says it is headed. A bearing counts only with a heading word
// or a unit ("heading 270", "brg 045", "moving 090°"), so "moving 120 trucks"
// has none; 000 to 360, 360 being north. A direction after a movement word
// is a whole compass point or word ("moving NE", "to the southeast"), so
// "moving to new position" has none.
const HEADING_BEARING = /\b(?:head(?:s|ed|ing)?|hdg|bearing|brg|az(?:imuth)?)(?:\s+of)?\s*:?\s*(\d{3})(?![\d.])(?:\s*(?:°|deg(?:rees)?\b))?/i;
const MOVE_WORDS_BEFORE = '(?:mov(?:e|es|ed|ing)|mvg|head(?:s|ed|ing)?|travel{1,2}(?:s|ed|ing)?|driv(?:e|es|ing)|advanc(?:e|es|ed|ing)|withdraw(?:s|n|ing)?|retreat(?:s|ed|ing)?|toward(?:s)?|to the|en ?route|transit(?:s|ing)?|proceed(?:s|ing)?|fly(?:ing)?|bearing|brg|az)\\s+(?:[a-z]+\\s+){0,2}?';
const MOVE_BEARING = new RegExp(`\\b${MOVE_WORDS_BEFORE}(\\d{3})\\s*(?:°|deg(?:rees)?\\b)`, 'i');
const MOVE_DIR = new RegExp(`\\b${MOVE_WORDS_BEFORE}(north[- ]?(?:east|west)?|south[- ]?(?:east|west)?|east|west|${COMPASS.join('|')})\\b`, 'i');
const BOUND = /\b(?:([NSEW])B|(north|south|east|west)bound)\b/i;
// The heading a match gives: { at, heading, headingDeg }, or null.
const headingFrom = (m, re) => {
    if (!m) return null;
    if (re === BOUND) {
        const heading = m[1] ? m[1].toUpperCase() : DIR_WORDS[m[2].toUpperCase()];
        return { at: m.index, heading, headingDeg: COMPASS.indexOf(heading) * 22.5 };
    }
    const d = m[1].toUpperCase().replace(/[- ]/g, '');
    if (/^\d{3}$/.test(d)) {
        if (+d > 360) return null;
        const deg = +d % 360;
        return { at: m.index, heading: COMPASS[Math.round(deg / 22.5) % 16], headingDeg: deg };
    }
    const heading = DIR_WORDS[d] || (COMPASS.includes(d) ? d : null);
    return heading ? { at: m.index, heading, headingDeg: COMPASS.indexOf(heading) * 22.5 } : null;
};
const classifyActivity = (text) => {
    const s = String(text || '');
    const notContact = s.replace(NOT_CONTACT, ' ');
    const tags = ACTIVITY_TAGS.filter(([t, re]) => re.test(t === 'Firing' ? notContact : s)).map(([t]) => t);
    // The first heading said after a movement or heading word; failing
    // that, a "-bound" ("NB", "westbound").
    const said = [HEADING_BEARING, MOVE_BEARING, MOVE_DIR].map(re => headingFrom(re.exec(s), re)).filter(Boolean)
        .sort((x, y) => x.at - y.at)[0] || headingFrom(BOUND.exec(s), BOUND);
    const heading = said ? said.heading : null, headingDeg = said ? said.headingDeg : null;
    if (heading && !tags.includes('Moving')) tags.unshift('Moving');
    return { tags, heading, headingDeg };
};

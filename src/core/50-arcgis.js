// SPDX-License-Identifier: AGPL-3.0-only
// The ArcGIS export and the shapefile export. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- ArcGIS export ---

// One row per grid of each live report: a report naming three grids becomes
// three points. Reports with no readable grid are counted, not exported.
// With `all`, every saved version of a report, oldest first (as
// reportPositions orders them), each at its own grids and with its own
// words, numbered in `version` ("2/3", of every version) with `latest` yes
// or no; a report is counted as left out only when none of them has a grid.
// Field names avoid SQL reserved words (TIME, CHECK), which some geodatabases
// refuse or rename. `size` is what is left after BDA (sizeAfterBda; `team`:
// the team's equipment) for the report as it is now, an earlier version's
// own Size for that version; `size_logged` the Size as it was logged.
const arcgisRows = (reps, overlays, { local, customLabels = [], idOf, team = null, all = false }) => {
    const rows = []; let skipped = 0;
    const field = l => 'c_' + String(l).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    // A time that can't be read is none ('').
    const iso = d => { const x = timeOf(d); return x ? x.toISOString().replace(/\.\d{3}Z$/, 'Z') : ''; };
    for (const r of reps) {
        if (r.deleted) continue;
        const versions = all
            ? versionsByTime(r).concat(r)
            : [r];
        const placed = versions.map((v, n) => ({ v, n, a: analyzeLocation(v.location, overlays) })).filter(x => x.a.points.length);
        if (!placed.length) { skipped++; continue; }
        const bda = (r.bda || []).map(b => `${b.effect || 'Unknown'} - ${b.target || ''}`).join('; ');
        placed.forEach(({ v, n, a }) => {
            const act = classifyActivity(v.activity);
            a.points.forEach((p, i) => {
                const row = {
                    report_id: idOf(r), ato: r.ato || '', title: r.title || '',
                    ...(all ? { version: `${n + 1}/${versions.length}`, latest: v === r ? 'yes' : 'no' } : {}),
                    time_utc: iso(v.time),
                    time_disp: v.time ? toTimeString(v.time, local) : '',
                    size: v === r ? effectiveSize(r, team) : v.size || '', size_logged: v.size || '', activity: v.activity || '',
                    act_tags: act.tags.join('; '), heading: act.heading || '', heading_deg: act.headingDeg,
                    location: v.location || '', mgrs: p.mgrs, grid_n: `${i + 1}/${a.points.length}`,
                    precision_m: p.precision,
                    nai: a.nai.keys.join('; '), nai_from: a.nai.from, obj: a.obj.keys.join('; '), obj_from: a.obj.from,
                    pl: a.pl.join('; '), pl_near: a.nearestPl ? a.nearestPl.key : '',
                    pl_dist_m: a.nearestPl ? Math.round(a.nearestPl.meters) : null,
                    loc_check: a.checks.join('; '), analysis: v.yourAnalysis || '',
                    reporter: (v.user && v.user.initials) || '', bda, updated: r.updated ? 'yes' : 'no',
                };
                customLabels.forEach(l => { row[field(l)] = (v.custom || {})[l] || ''; });
                row.lat = Math.round(p.lat * 1e7) / 1e7;
                row.lon = Math.round(p.lon * 1e7) / 1e7;
                rows.push(row);
            });
        });
    }
    return { rows, skipped };
};

// MTI: the ArcGIS rows (points or tracks) that count tracked vehicles, and
// those that count wheeled ones, read from each row's Size as the MTI CSV
// reads it (mtiCount). In each, the Size is that count ("4 tracked") and
// `vehicles` its number; a row counting both is in both.
const arcgisMti = (rows) => {
    const of = (kind) => rows.flatMap(row => {
        const m = mtiCount(row.size, kind);
        return m ? [Object.fromEntries(Object.entries(row).flatMap(([k, v]) => (k === 'size' ? [['size', m.text], ['vehicles', m.n]] : [[k, v]])))] : [];
    });
    return { tracked: of('tracked'), wheeled: of('wheeled') };
};

// The numeric fields of the ArcGIS exports (points and tracks), each with
// its one type: the same layer exported twice has the same fields, whatever
// the rows hold (a heading or a phase-line distance no row has is still a
// number). Every other field is text.
const ARCGIS_NUMBERS = {
    heading_deg: 'double', precision_m: 'integer', pl_dist_m: 'integer', lat: 'double', lon: 'double',
    positions: 'integer', length_m: 'integer', bearing_deg: 'integer', vehicles: 'integer',
};
// A field's kind: 'integer', 'double' or 'text', from ARCGIS_NUMBERS; a
// field it doesn't name is a number when every value given is one.
const fieldKind = (name, rows) => {
    if (Object.prototype.hasOwnProperty.call(ARCGIS_NUMBERS, name)) return ARCGIS_NUMBERS[name];
    const vals = rows.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
    if (!vals.length || !vals.every(v => typeof v === 'number' && isFinite(v))) return 'text';
    return vals.every(Number.isInteger) ? 'integer' : 'double';
};

const arcgisCsv = (rows) => {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const cell = v => (v === null || v === undefined) ? '' : typeof v === 'number' ? String(v) : csvField(v);
    return cols.join(',') + '\r\n' + rows.map(r => cols.map(c => cell(r[c])).join(',')).join('\r\n') + '\r\n';
};

// --- Shapefile export ---

// A zip of files stored as they are (no compression): what a shapefile's
// parts travel in. `files`: [{ name, data: Uint8Array }].
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
const crc32 = (bytes) => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const zipStore = (files, now = new Date()) => {
    const enc = new TextEncoder();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [], centrals = [];
    let offset = 0;
    files.forEach(({ name, data }) => {
        const nm = enc.encode(name), crc = crc32(data);
        const head = (sig, central) => {
            const b = new Uint8Array((central ? 46 : 30) + nm.length), v = new DataView(b.buffer);
            let o = 0;
            const u32 = x => { v.setUint32(o, x, true); o += 4; }, u16 = x => { v.setUint16(o, x, true); o += 2; };
            u32(sig);
            if (central) u16(20);           // made by
            u16(20); u16(0x0800); u16(0);   // version needed; UTF-8 names; stored
            u16(time); u16(date); u32(crc); u32(data.length); u32(data.length); u16(nm.length); u16(0);
            if (central) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
            b.set(nm, o);
            return b;
        };
        const local = head(0x04034b50, false);
        centrals.push(head(0x02014b50, true));
        locals.push(local, data);
        offset += local.length + data.length;
    });
    const cdSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let o = 0;
    [...locals, ...centrals, end].forEach(b => { out.set(b, o); o += b.length; });
    return out;
};

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
// Field names a shapefile can hold (10 characters at most), for the ArcGIS
// rows' longer names; the rest are cut to 10 and kept apart with a number.
const SHP_FIELD_NAMES = { heading_deg: 'head_deg', precision_m: 'prec_m', bearing_deg: 'bearing', size_logged: 'size_log' };
const shpFieldNames = (cols) => {
    const used = new Set();
    return cols.map(c => {
        const base = (SHP_FIELD_NAMES[c] || c).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 10) || 'field';
        let name = base;
        for (let i = 2; used.has(name.toLowerCase()); i++) name = base.slice(0, 10 - String(i).length - 1) + '_' + i;
        used.add(name.toLowerCase());
        return name;
    });
};

// The text of a value cut to `max` bytes of UTF-8 without splitting a character.
const utf8Cut = (enc, s, max) => {
    let b = enc.encode(s);
    if (b.length <= max) return b;
    let cut = max;
    while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
    return b.subarray(0, cut);
};

// A shapefile in WGS 1984: points or lines (PolyLine), with a .dbf of the
// rows' attributes (UTF-8, said so in the .cpg). Numbers are numeric fields;
// text is cut to the format's 254 characters. `shapes` are [lon, lat] for
// points, or lists of them for lines, one per row.
const shapefileParts = (rows, shapes, kind) => {
    const enc = new TextEncoder();
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const names = shpFieldNames(cols);
    const fields = cols.map((c, i) => {
        const kind = fieldKind(c, rows);
        if (kind !== 'text') {
            const dec = kind === 'integer' ? 0 : 7;
            return { col: c, name: names[i], type: 'N', len: dec ? 19 : 18, dec };
        }
        const vals = rows.map(r => r[c]).filter(v => v !== null && v !== undefined && v !== '');
        const len = Math.min(254, Math.max(1, ...vals.map(v => enc.encode(String(v)).length)));
        return { col: c, name: names[i], type: 'C', len, dec: 0 };
    });
    // .dbf
    const recLen = 1 + fields.reduce((s, f) => s + f.len, 0), headLen = 32 + 32 * fields.length + 1;
    const dbf = new Uint8Array(headLen + recLen * rows.length + 1), dv = new DataView(dbf.buffer);
    const now = new Date();
    dbf[0] = 0x03; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
    dv.setUint32(4, rows.length, true); dv.setUint16(8, headLen, true); dv.setUint16(10, recLen, true);
    fields.forEach((f, i) => {
        const o = 32 + 32 * i;
        dbf.set(enc.encode(f.name), o);
        dbf[o + 11] = f.type.charCodeAt(0); dbf[o + 16] = f.len; dbf[o + 17] = f.dec;
    });
    dbf[headLen - 1] = 0x0d;
    rows.forEach((r, k) => {
        let o = headLen + k * recLen;
        dbf.fill(0x20, o, o + recLen);
        o++;
        fields.forEach(f => {
            const v = r[f.col];
            if (f.type === 'N') {
                // A number too wide for the field gives up decimals, never
                // its whole part; one that still doesn't fit is left empty.
                if (typeof v === 'number' && Math.abs(v) < 1e21) {   // larger ones print as "1e+21"
                    let s = v.toFixed(f.dec);
                    if (s.length > f.len) s = v.toFixed(Math.max(0, f.dec - (s.length - f.len)));
                    if (s.length <= f.len) dbf.set(enc.encode(s), o + f.len - s.length);
                }
            } else if (v !== null && v !== undefined) {
                dbf.set(utf8Cut(enc, String(v), f.len), o);
            }
            o += f.len;
        });
    });
    dbf[dbf.length - 1] = 0x1a;
    // .shp and .shx
    const paths = shapes.map(s => (kind === 'point' ? [s] : s));
    const sizes = paths.map(p => (kind === 'point' ? 20 : 44 + 4 + 16 * p.length));
    const shpLen = 100 + sizes.reduce((s, n) => s + 8 + n, 0), shxLen = 100 + 8 * rows.length;
    const shp = new Uint8Array(shpLen), shx = new Uint8Array(shxLen);
    const sv = new DataView(shp.buffer), xv = new DataView(shx.buffer);
    const all = paths.flat();
    const box = all.length ? [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))] : [0, 0, 0, 0];
    [[sv, shpLen], [xv, shxLen]].forEach(([v, len]) => {
        v.setInt32(0, 9994); v.setInt32(24, len / 2); v.setInt32(28, 1000, true); v.setInt32(32, kind === 'point' ? 1 : 3, true);
        box.forEach((n, i) => v.setFloat64(36 + 8 * i, n, true));
    });
    let o = 100;
    paths.forEach((p, i) => {
        xv.setInt32(100 + 8 * i, o / 2); xv.setInt32(104 + 8 * i, sizes[i] / 2);
        sv.setInt32(o, i + 1); sv.setInt32(o + 4, sizes[i] / 2);
        const c = o + 8;
        if (kind === 'point') {
            sv.setInt32(c, 1, true); sv.setFloat64(c + 4, p[0][0], true); sv.setFloat64(c + 12, p[0][1], true);
        } else {
            const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
            sv.setInt32(c, 3, true);
            [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((n, j) => sv.setFloat64(c + 4 + 8 * j, n, true));
            sv.setInt32(c + 36, 1, true); sv.setInt32(c + 40, p.length, true); sv.setInt32(c + 44, 0, true);
            p.forEach((q, j) => { sv.setFloat64(c + 48 + 16 * j, q[0], true); sv.setFloat64(c + 56 + 16 * j, q[1], true); });
        }
        o += 8 + sizes[i];
    });
    return { shp, shx, dbf, prj: enc.encode(WGS84_PRJ), cpg: enc.encode('UTF-8') };
};

// The ArcGIS points (one per grid) or tracks (one line per report that moved)
// as a zipped shapefile named `name`: ArcGIS Pro adds the .shp once it is
// unzipped, and ArcGIS Online takes the zip as it is.
const shapefileZip = (name, parts, now) => zipStore(['shp', 'shx', 'dbf', 'prj', 'cpg'].map(ext => ({ name: `${name}.${ext}`, data: parts[ext] })), now);
const arcgisShapefileZip = (rows, name, now) => shapefileZip(name, shapefileParts(rows, rows.map(r => [r.lon, r.lat]), 'point'), now);
const arcgisTracksShapefileZip = (rows, name, now) => shapefileZip(name, shapefileParts(rows.map(attrsOf), rows.map(r => r.path), 'line'), now);

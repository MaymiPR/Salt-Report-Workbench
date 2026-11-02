// SPDX-License-Identifier: AGPL-3.0-only

// Overlays: NAI / OBJ / PL features imported from KML, KMZ, GeoJSON or a
// shapefile (as ArcGIS exports them), reviewed, then saved as one set shared by every
// workspace, and synced. Each graphic has one tag: NAI, OBJ, PL, one of the
// team's own (made, renamed and recolored here, shared too) or none.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- Reading files ---

// The files in a zip, read with the browser's own inflater, so no library
// is needed: [{ name, method, size, offset }], and one file's bytes.
const zipEntries = (buf) => {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('it is not a zip (or KMZ) file');
    const entries = [];
    let p = dv.getUint32(eocd + 16, true);
    for (let k = dv.getUint16(eocd + 10, true); k > 0 && dv.getUint32(p, true) === 0x02014b50; k--) {
        const nameLen = dv.getUint16(p + 28, true);
        entries.push({
            name:   new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen)),
            method: dv.getUint16(p + 10, true),
            size:   dv.getUint32(p + 20, true),
            offset: dv.getUint32(p + 42, true),
        });
        p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return entries;
};
const zipData = async (buf, entry) => {
    const dv = new DataView(buf);
    const start = entry.offset + 30 + dv.getUint16(entry.offset + 26, true) + dv.getUint16(entry.offset + 28, true);
    const data  = new Uint8Array(buf, start, entry.size);
    if (entry.method === 0) return data.slice().buffer;
    if (entry.method !== 8) throw new Error('it uses a compression this browser cannot read');
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
};

// The KML inside a KMZ: doc.kml, or else the first .kml.
const kmlFromKmz = async (buf) => {
    const entries = zipEntries(buf);
    const kml = entries.find(e => /(^|\/)doc\.kml$/i.test(e.name)) || entries.find(e => /\.kml$/i.test(e.name));
    if (!kml) throw new Error('the KMZ holds no .kml file');
    return new TextDecoder().decode(await zipData(buf, kml));
};

// Coordinates rounded to six decimals (about 10 cm), repeats dropped.
const roundPos  = c => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];
const cleanPath = path => path.map(roundPos).filter((c, i, a) => i === 0 || c[0] !== a[i-1][0] || c[1] !== a[i-1][1]);

// Polygons, lines and points gathered from one feature, as one geometry:
// areas win over lines, lines over points (a KML placemark can mix them).
const combineGeometry = ({ polygons, lines, points }) => {
    polygons = polygons.map(rings => rings.map(cleanPath).filter(r => r.length >= 4)).filter(rings => rings.length);
    lines    = lines.map(cleanPath).filter(l => l.length >= 2);
    if (polygons.length) return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
    if (lines.length)    return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
    if (points.length)   return { type: 'Point', coordinates: roundPos(points[0]) };
    return null;
};

// NAI / OBJ / PL from a folder, layer, or file name ("NAIs", "Phase Lines"),
// the first of `texts` that says one; for a line, AXIS too, from "Axes of
// advance", "Axis" or "AOA".
// A folder named as one of the team's tags ("Routes" for the tag Routes, or
// "Route" for Routes) is that tag.
const typeHint = (texts, line) => {
    // A file's name without its extension ("Routes.kml").
    const norm = (x) => String(x || '').trim().replace(/\.[a-z0-9]{2,7}$/i, '').toLowerCase();
    for (const t of texts) {
        const s = String(t || '');
        const tag = (sharedTags || []).find(g => [norm(g.name), `${norm(g.name)}s`].includes(norm(s)) || norm(g.name) === `${norm(s)}s`);
        if (tag) return tag.id;
        if (/\bNAIs?\b/i.test(s)) return 'NAI';
        if (/\bOBJ(ECTIVE)?S?\b/i.test(s)) return 'OBJ';
        if (/\bPLs?\b|phase\s*lines?/i.test(s)) return 'PL';
        if (line && /\b(ax[ie]s|AOAs?)\b/i.test(s)) return 'AXIS';
    }
    return null;
};

const kmlFeatures = (text, fileName) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('it is not valid KML');
    const all   = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));
    const child = (node, tag) => Array.from(node.children).find(c => c.localName === tag);
    const coords = node => (node ? node.textContent.trim().split(/\s+/) : [])
        .map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && isFinite(c[0]) && isFinite(c[1]));
    return all(doc, 'Placemark').map(pm => {
        let folder = '';
        for (let n = pm.parentElement; n && !folder; n = n.parentElement) {
            if (n.localName === 'Folder' || n.localName === 'Document') folder = (child(n, 'name') || {}).textContent || '';
        }
        const geometry = combineGeometry({
            polygons: [
                ...all(pm, 'Polygon').map(poly => [
                    ...all(poly, 'outerBoundaryIs').map(b => coords(all(b, 'coordinates')[0])),
                    ...all(poly, 'innerBoundaryIs').map(b => coords(all(b, 'coordinates')[0])),
                ]),
                // A ring on its own, outside any Polygon, is an area too.
                ...all(pm, 'LinearRing').filter(r => !/BoundaryIs$/.test(r.parentElement.localName))
                    .map(r => [coords(child(r, 'coordinates'))]),
            ],
            lines:  all(pm, 'LineString').map(l => coords(child(l, 'coordinates'))),
            points: all(pm, 'Point').map(pt => coords(child(pt, 'coordinates'))[0]).filter(Boolean),
        });
        return { label: ((child(pm, 'name') || {}).textContent || '').trim(), hints: [folder, fileName], geometry };
    });
};

// GeoJSON must be longitude/latitude. ArcGIS writes Web Mercator unless told
// to project to WGS 1984; that one is converted, any other projection refused.
const geojsonFeatures = (obj, fileName) => {
    const crs = String((((obj || {}).crs || {}).properties || {}).name || '');
    const mercator = /3857|900913|102100|102113/.test(crs);
    if (crs && !mercator && !/4326|CRS84/i.test(crs)) {
        throw new Error(`its coordinates are in ${crs}. Export it again with "Project to WGS 1984" (or as KML)`);
    }
    const feats = obj.type === 'FeatureCollection' ? (obj.features || [])
                : obj.type === 'Feature' ? [obj]
                : obj.type ? [{ type: 'Feature', geometry: obj, properties: {} }] : [];
    const parts = { polygons: [], lines: [], points: [] };
    const walk = (g, into) => {
        if (!g) return;
        const c = g.coordinates;
        switch (g.type) {
            case 'Polygon':            into.polygons.push(c); break;
            case 'MultiPolygon':       c.forEach(p => into.polygons.push(p)); break;
            case 'LineString':         into.lines.push(c); break;
            case 'MultiLineString':    c.forEach(l => into.lines.push(l)); break;
            case 'Point':              into.points.push(c); break;
            case 'MultiPoint':         c.forEach(p => into.points.push(p)); break;
            case 'GeometryCollection': (g.geometries || []).forEach(x => walk(x, into)); break;
        }
    };
    const project = (v) => typeof v[0] === 'number' ? (mercator ? SaltCore.webMercatorToLonLat(v) : v) : v.map(project);
    const out = feats.map(f => {
        const into = { polygons: [], lines: [], points: [] };
        walk(f.geometry, into);
        Object.keys(into).forEach(k => { into[k] = into[k].map(project); parts[k].push(...into[k]); });
        const props = f.properties || {};
        const label = ['name', 'Name', 'NAME', 'title', 'Title', 'label', 'Label'].map(k => props[k]).find(v => v != null && String(v).trim());
        const kind  = ['type', 'Type', 'TYPE', 'category', 'Category', 'layer', 'Layer'].map(k => props[k]).find(v => v != null);
        return { label: String(label || '').trim(), hints: [kind, fileName], geometry: combineGeometry(into) };
    });
    const flat = [...parts.polygons.flat(2), ...parts.lines.flat(1), ...parts.points];
    if (flat.some(c => Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
        throw new Error('its coordinates are not longitude/latitude. Export it again with "Project to WGS 1984" (or as KML)');
    }
    return out;
};

// A shapefile is several files: the shapes (.shp), their attributes (.dbf),
// the coordinate system (.prj) and the text encoding (.cpg). ArcGIS zips them,
// or they can be picked together.
const SHP_PART = /\.(shp|shx|dbf|prj|cpg|sbn|sbx|xml)$/i;
const stemOf = n => n.replace(/\.[^./\\]+$/, '').toLowerCase();
const shapefileFeatures = (parts, name) =>
    geojsonFeatures(SaltCore.parseShapefile(parts.shp, parts.dbf || null, parts.prj || null, parts.cpg || null), name);

// Every shapefile in a zip (a KML in it, if there is no shapefile).
const readOverlayZip = async (buf, name) => {
    const entries = zipEntries(buf);
    const shps = entries.filter(e => /\.shp$/i.test(e.name));
    if (!shps.length) {
        const kml = entries.find(e => /\.kml$/i.test(e.name));
        if (kml) return kmlFeatures(new TextDecoder().decode(await zipData(buf, kml)), name);
        throw new Error('the zip holds no shapefile (.shp) or KML');
    }
    const out = [];
    for (const shp of shps) {
        const stem = stemOf(shp.name);
        const part = async ext => {
            const e = entries.find(x => stemOf(x.name) === stem && x.name.toLowerCase().endsWith(`.${ext}`));
            return e ? zipData(buf, e) : null;
        };
        const text = b => (b ? new TextDecoder().decode(b) : null);
        try {
            out.push(...shapefileFeatures({ shp: await zipData(buf, shp), dbf: await part('dbf'), prj: text(await part('prj')), cpg: text(await part('cpg')) },
                shp.name.split('/').pop()));
        } catch (e) { throw new Error(`${shp.name.split('/').pop()}: ${e.message}`); }
    }
    return out;
};

const readOverlayFile = async (file) => {
    const name = file.name || '';
    if (/\.kmz$/i.test(name)) return kmlFeatures(await kmlFromKmz(await file.arrayBuffer()), name);
    if (/\.zip$/i.test(name)) return readOverlayZip(await file.arrayBuffer(), name);
    const text = await file.text();
    if (/\.kml$/i.test(name) || /^\s*</.test(text)) return kmlFeatures(text, name);
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('it is not KML, KMZ, GeoJSON, or a shapefile'); }
    return geojsonFeatures(obj, name);
};

// --- Tags ---

// A graphic's tag is its overlay's type. NAI, OBJ and PL are built in; the
// team's own are shared (sharedTags: { id, name, color }, saved with
// /api/save_tags), and a graphic of one has the tag's id as its type, so a
// rename changes no graphic. A type no tag has any more (its tag was
// deleted), or '', is no tag: the graphic is Unknown, kept in the list's
// Unknown group to be sorted, not drawn on the map, and names nothing.
// `shape` is how a tag's graphics are read: 'area' (a path is closed
// into one: NAI, OBJ), 'line' (as drawn: PL) or 'any' (as drawn; an area
// names the reports inside it, a line or a point doesn't). A later built-in
// tag is one more entry here, with its color in MAP_COLORS and its id in the
// server's _OVERLAY_TYPES. An axis of advance (`axis`) is a line drawn with an
// arrowhead at its end, from where the enemy comes from to where it heads:
// the narrative's way of march near it. It names no place, so the map
// doesn't pick it, and its key shows only while the map has one.
const BUILTIN_TAGS = [
    { id: 'NAI', name: 'NAI', title: 'NAIs', many: 'NAIs', shape: 'area' },
    { id: 'OBJ', name: 'OBJ', title: 'Objectives', many: 'OBJs', shape: 'area' },
    { id: 'PL', name: 'PL', title: 'Phase lines', many: 'PLs', shape: 'line' },
    { id: 'AXIS', name: 'Axis of advance', title: 'Axes of advance', many: 'axes of advance', shape: 'line', axis: true },
];
const OVERLAY_TYPES = BUILTIN_TAGS.map(t => t.id);
// A type's tag, with its color: built in, the team's, or none, Unknown (its
// key 'none').
const tagOf = (type) => {
    const b = BUILTIN_TAGS.find(t => t.id === type);
    if (b) return { ...b, key: b.id, color: MAP_COLORS[b.id], builtIn: true };
    const t = sharedTags.find(x => x.id === type);
    if (t) return { ...t, key: t.id, title: t.name, many: t.name, shape: 'any', builtIn: false };
    return { id: '', key: 'none', name: 'Unknown', title: 'Unknown', many: 'unknown graphics', shape: 'any', color: MAP_COLORS.none, builtIn: false, none: true };
};
// Every tag a graphic can have, the built-in ones first.
const everyTag = () => [...BUILTIN_TAGS, ...sharedTags].map(t => tagOf(t.id));
// A tag's color as a dot, to go before a name.
const tagDot = (type) => `<i class="tag-dot" style="background:${SaltCore.safeColor(tagOf(type).color)}" aria-hidden="true"></i>`;
// A graphic by name, as reports name it: "NAI 1"; one of the team's tags (or
// of none) by its own name, "Route Gold".
const graphicName = (o) => (tagOf(o.type).builtIn ? overlayKey(o) : o.name);

// A new tag's color: one no tag has yet, if there is one.
const TAG_COLORS = ['#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68', '#5e5ce6', '#30b0c7', '#ff6482', '#a2845e'];
const nextTagColor = () => TAG_COLORS.find(c => !sharedTags.some(t => t.color === c)) || TAG_COLORS[sharedTags.length % TAG_COLORS.length];
// What is wrong with a name for a tag (`id`: the tag being renamed), or ''.
// The server takes the same: 30 characters, names unique, none built in.
const tagNameProblem = (name, id = null) => {
    if (!name) return 'Type a name for the tag first.';
    if (name.length > 30) return 'A tag\'s name is 30 characters at most.';
    if (OVERLAY_TYPES.includes(name.toUpperCase())) return `${name.toUpperCase()} is built in already.`;
    const named = BUILTIN_TAGS.find(t => t.name.toUpperCase() === name.toUpperCase());
    if (named) return `${named.name} is built in already.`;
    if (sharedTags.some(t => t.id !== id && t.name.toUpperCase() === name.toUpperCase())) return `There is a tag named ${name} already.`;
    return '';
};
// Resolves true when the server took them; refused, they're put back.
const saveTags = (list, said = '', undo = null) => {
    const before = sharedTags;
    const shown = () => { storeTags(); renderOverlays(); renderLog(); renderLocationHints(); renderMapView(); };
    sharedTags = list;
    shown();
    return saveShared('/api/save_tags', { tags: list }, { said, undo, older: 'Not saved: this server is from before tags. Update it to use them.', putBack: () => {
        if (sharedTags === list) { sharedTags = before; shown(); }
    } });
};
// What is being typed in the tags' boxes, kept over a redraw (a sync draws
// the tab again): the new tag's name and color, and each rename not yet made.
const tagDraft = { name: '', color: '' };
const tagRenames = new Map();
// The tags' manager is one row however many there are: the tag picked in
// its list (by id), shown with its name, color, count and ×; or, while
// + New tag is open (`tagAdding`), the new tag's boxes.
let tagPicked = null;
let tagAdding = false;
const addTag = async () => {
    const name = tagDraft.name.trim();
    const problem = tagNameProblem(name);
    if (problem) { showToast(problem, true); return; }
    if (sharedTags.length >= 30) { showToast('There are 30 tags already, the most there can be.', true); return; }
    const color = /^#[0-9a-f]{6}$/i.test(tagDraft.color) ? tagDraft.color.toLowerCase() : nextTagColor();
    const tag = { id: `tag-${generateUUID().replace(/-/g, '').slice(0, 12).toLowerCase()}`, name, color };
    tagDraft.name = ''; tagDraft.color = '';
    tagAdding = false; tagPicked = tag.id;
    if (!(await saveTags([...sharedTags, tag], `Tag ${name} added.`))) { tagDraft.name = name; tagAdding = true; renderOverlays(); }
};
// + New tag opens the new tag's boxes, its name box focused; Cancel (or
// Escape) closes them and lets what was typed go.
const openNewTag = (open) => {
    tagAdding = open;
    if (!open) { tagDraft.name = ''; tagDraft.color = ''; }
    renderOverlays();
    const to = document.getElementById(open ? 'overlayTagNewName' : 'overlayTagNewBtn');
    if (to) to.focus({ preventScroll: true });
};
const renameTag = (id, text) => {
    const t = sharedTags.find(x => x.id === id);
    tagRenames.delete(id);
    const name = String(text || '').trim();
    if (!t || name === t.name) { renderOverlays(); return; }
    const problem = tagNameProblem(name, id);
    if (problem) { showToast(problem, true); renderOverlays(); return; }
    saveTags(sharedTags.map(x => (x.id === id ? { ...x, name } : x)), `Tag ${t.name} renamed ${name}.`);
};
const recolorTag = (id, color) => {
    const t = sharedTags.find(x => x.id === id);
    if (!t || !/^#[0-9a-f]{6}$/i.test(color) || color.toLowerCase() === t.color) return;
    saveTags(sharedTags.map(x => (x.id === id ? { ...x, color: color.toLowerCase() } : x)), `Tag ${t.name} recolored.`);
};
// A tag's × pressed once asks "Delete for everyone?" in its name, as an
// overlay's does; a second press deletes it. Its graphics stay, with no tag,
// and Undo gives it back with them.
const putTagBack = async (t) => {
    if (sharedTags.some(x => x.id === t.id)) { showToast('Nothing left to put back.', true); return; }
    const problem = tagNameProblem(t.name, t.id);
    if (problem) { showToast(problem, true); return; }
    if (await saveTags([...sharedTags, t])) showToast(`Tag ${t.name} put back.`);
};
const deleteTag = (id) => {
    const t = sharedTags.find(x => x.id === id);
    if (!t || !askFirst(`tag|${id}`, renderOverlays)) return;
    const n = currentOverlays().filter(o => o.type === id).length;
    const left = n ? `; ${n === 1 ? 'its graphic has' : `its ${n} graphics have`} no tag now` : '';
    saveTags(sharedTags.filter(x => x.id !== id), `Tag ${t.name} deleted${left}.`, () => putTagBack(t));
};

// --- Review, then save ---

const SHAPE_LABEL = { Polygon: 'Area', MultiPolygon: 'Area', LineString: 'Line', MultiLineString: 'Line', Point: 'Point', MultiPoint: 'Point' };
// A review row's type is the tag it is to have ('' for Unknown) or SKIP,
// left out of the import.
const SKIP = 'skip';
let overlayReview = null;  // { rows: [{ label, geometry, type }], files: [names] }
// The review's rows checked, by index, and the last one clicked; the
// "Use as" picked in the bar over them. Let go with the review.
const reviewPicks = new Set();
let reviewPickFrom = null;
let reviewBulkTag = null;

// The overlay a review row becomes with the tag picked for it. A built-in
// tag's graphics are named as typed names are ("NAI 3"); the team's, and
// Unknown ones, keep their name in the file ("Route Gold"). One whose tag
// was deleted meanwhile is Unknown.
const reviewOverlay = (row) => {
    if (row.type === SKIP) return null;
    const tag = tagOf(row.type);
    const label = row.label ? { label: cutText(row.label, 100) } : {};
    if (!tag.builtIn) return { type: tag.id, name: cutText((row.label || '').trim(), 40) || 'UNNAMED', ...label, geometry: row.geometry };
    const ref = SaltCore.overlayRef(row.label, row.type);
    const name = cutText(ref ? ref.name : 'UNNAMED', 40);
    const geometry = tag.shape === 'area' ? SaltCore.asArea(row.geometry) : row.geometry;
    return { type: row.type, name, ...label, geometry };
};

// Manage > Map shows its graphics or its basemaps: the graphics when
// opened, and for an import; the basemaps from the map's basemap button.
const showMapSub = (sub) => {
    const pick = sub === 'basemaps' ? 'basemaps' : 'graphics';
    document.querySelectorAll('[data-map-sub]').forEach(b => setOn(b, b.dataset.mapSub === pick, 'aria-pressed'));
    document.querySelectorAll('[data-map-sub-panel]').forEach(p => { p.hidden = p.dataset.mapSubPanel !== pick; });
};
// Picked: the other part slides in from its side.
document.addEventListener('click', e => {
    const b = e.target.closest('[data-map-sub]');
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    showMapSub(b.dataset.mapSub);
    animateTabIn(document.querySelector(`[data-map-sub-panel="${b.dataset.mapSub}"]`), b.dataset.mapSub === 'basemaps' ? 1 : -1);
});
showMapSub('graphics');

const startOverlayImport = async (files) => {
    showMapSub('graphics');
    const rows = [], names = [], failed = [];
    // A shapefile picked as its parts (.shp with its .dbf, .prj ...) is one source.
    const sources = [], parts = new Map();
    files.forEach(f => {
        if (!SHP_PART.test(f.name)) { sources.push({ name: f.name, read: () => readOverlayFile(f) }); return; }
        const k = stemOf(f.name);
        if (!parts.has(k)) parts.set(k, {});
        parts.get(k)[f.name.split('.').pop().toLowerCase()] = f;
    });
    parts.forEach(g => {
        if (!g.shp) { failed.push(`${Object.values(g)[0].name}: its .shp file wasn't picked with it`); return; }
        sources.push({ name: g.shp.name, read: async () => shapefileFeatures({
            shp: await g.shp.arrayBuffer(), dbf: g.dbf ? await g.dbf.arrayBuffer() : null,
            prj: g.prj ? await g.prj.text() : null, cpg: g.cpg ? await g.cpg.text() : null,
        }, g.shp.name) });
    });
    for (const f of sources) {
        try {
            (await f.read()).forEach(ft => {
                if (!ft.geometry) return;
                // A prefix in the name ("NAI 3") wins; then the folder or file
                // name; lines with neither are phase lines; areas and points
                // with neither are Unknown ('').
                // An axis of advance ("AXIS GOLD", "AOA 2") is a line.
                const line = /Line/.test(ft.geometry.type);
                const own = SaltCore.overlayRef(ft.label, null);
                const type = own && (own.type !== 'AXIS' || line) ? own.type : typeHint(ft.hints, line) || (line ? 'PL' : '');
                rows.push({ label: ft.label, geometry: ft.geometry, type });
            });
            names.push(f.name);
        } catch (e) { failed.push(`${f.name}: ${e.message}`); }
    }
    if (failed.length) showToast(`Couldn't read ${failed.join('; ')}.`, true, { ms: 8000 });
    if (!rows.length) { if (!failed.length) showToast('No shapes found in that file.', true); return; }
    overlayReview = { rows, files: names };
    reviewPicks.clear(); reviewPickFrom = null;
    renderOverlays();
};
const endOverlayReview = () => { overlayReview = null; reviewPicks.clear(); reviewPickFrom = null; };

// `incoming` replaces any overlay of the same type and name in `list`.
const overlayKey = o => SaltCore.overlayKey(o);
const mergeOverlays = (list, incoming) => {
    const keys = new Set(incoming.map(overlayKey));
    return [...list.filter(o => !keys.has(overlayKey(o))), ...incoming];
};

// Resolves true when the server took them; refused, they're put back. Every
// graphic is sent, whatever its tag (`tagged`): a server keeps the ones a
// page from before tags never saw when that page saves.
const saveOverlays = (list, said = '', undo = null) => {
    const before = sharedOverlays;
    const shown = () => { storeOverlays(); renderOverlays(); renderLog(); renderLocationHints(); renderMapView(); };
    sharedOverlays = list;
    shown();
    return saveShared('/api/save_overlays', { overlays: list, tagged: true }, { said, undo, putBack: () => {
        if (sharedOverlays === list) { sharedOverlays = before; shown(); }
    } });
};

const finishOverlayImport = async () => {
    if (!overlayReview) return;
    const added = overlayReview.rows.map(reviewOverlay).filter(Boolean);
    if (!added.length) { showToast('Pick a type for at least one shape, or Cancel.', true); return; }
    // Shapes with no name are numbered (UNNAMED, UNNAMED 2...) past those already
    // there, so each is one of its own: checked, removed and kept apart.
    const taken = new Set(currentOverlays().map(overlayKey));
    added.forEach(o => {
        if (o.name !== 'UNNAMED') return;
        let n = 1;
        while (taken.has(overlayKey(o))) o.name = `UNNAMED ${++n}`;
        taken.add(overlayKey(o));
    });
    // Same type and name replaces: re-importing an updated NAI file updates it.
    const have = new Set(currentOverlays().map(overlayKey));
    const replaced = added.filter(o => have.has(overlayKey(o))).length;
    endOverlayReview();
    if (await saveOverlays(mergeOverlays(currentOverlays(), added))) {
        const n = t => added.filter(o => o.type === t).length;
        const own = added.filter(o => o.type && !OVERLAY_TYPES.includes(o.type)).length;
        // Unknown ones are in their group, open, to be sorted.
        if (n('')) overlayGroupsOpen.add('none');
        showToast(`Imported ${plural(added.length, 'overlay')}: ${n('NAI')} NAI, ${n('OBJ')} OBJ, ${n('PL')} PL`
            + (n('AXIS') ? `, ${n('AXIS')} AXIS` : '')
            + (own ? `, ${own} with your own tags` : '')
            + (n('') ? `, ${n('')} Unknown, not on the map until tagged` : '')
            + (replaced ? ` (${replaced} replaced an older one).` : '.'), false, n('') ? { ms: 6000 } : undefined);
    }
};

// --- The Map tab: the ops graphics ---

// The groups opened, by their tag's key: Unknown to start with, since its
// graphics are waiting to be sorted.
const overlayGroupsOpen = new Set(['none']);
// The graphics checked in the list (by overlayKey), and the last one
// clicked, where a Shift-click's range starts. Kept over a redraw.
const overlayPicks = new Set();
let overlayPickFrom = null;
let overlayBulkTag = null;   // the tag picked in the bar over the list, by id
// An overlay's × pressed once: its name asks "Remove for everyone?" in
// place, as a basemap's does, and a second press removes it. Unload All
// and each list's Unload ask on their own faces (askFirst, app/10-state.js).
// Undo puts back what went, by type and name, beside whatever came since.
const putOverlaysBack = async (gone, said) => {
    const have = new Set(currentOverlays().map(overlayKey));
    const back = gone.filter(o => !have.has(overlayKey(o)));
    if (!back.length) { showToast('Nothing left to put back.', true); return; }
    if (await saveOverlays([...currentOverlays(), ...back])) showToast(said);
};
const removeOverlays = async (gone, said) => {
    if (!gone.length) return;
    const keys = new Set(gone.map(overlayKey));
    if (await saveOverlays(currentOverlays().filter(o => !keys.has(overlayKey(o))))) {
        undoToast(said, () => putOverlaysBack(gone, `${gone.length === 1 ? graphicName(gone[0]) : `${gone.length} overlays`} put back.`));
    }
};

// A graphic given another tag (or none, ''): what it then is. A built-in
// tag's graphics are named by one word, read from the name in the file as
// an import does ("NAI 3" as an OBJ is OBJ 3); the team's by a name in full.
// The shape stays as drawn: the map and the Location read it by its tag.
const retagged = (o, type) => {
    if (o.type === type) return o;
    const name = tagOf(type).builtIn ? ((SaltCore.overlayRef(o.label || o.name, type) || {}).name || 'UNNAMED')
        : tagOf(o.type).builtIn ? (o.label || overlayKey(o)).trim() : o.name;
    return { ...o, type, name: cutText(name, 40) || 'UNNAMED' };
};
// Give graphics a tag, or none (''). One that would then have the name of
// another graphic with that tag is left as it is, and that is said. Undo
// gives them back the tags they had.
const retagGraphics = async (picked, type) => {
    const to = tagOf(type);
    const moves = picked.map(o => [o, retagged(o, type)]).filter(([o, n]) => n !== o);
    if (!moves.length) {
        showToast(to.none ? 'They have no tag already.' : `${picked.length === 1 ? 'It is' : 'They are'} in ${to.title} already.`);
        return false;
    }
    const list = currentOverlays();
    const moving = new Set(moves.map(([o]) => overlayKey(o)));
    const taken = new Set(list.filter(o => !moving.has(overlayKey(o))).map(overlayKey));
    const into = new Map();   // old key -> the graphic as it now is
    let clash = 0;
    moves.forEach(([o, n]) => {
        const k = overlayKey(n);
        if (taken.has(k)) { clash++; return; }
        taken.add(k);
        into.set(overlayKey(o), n);
    });
    const same = `${plural(clash, 'graphic')} would have the name of one in ${to.title} already`;
    if (!into.size) { showToast(`Not changed: ${same}.`, true); return false; }
    const was = new Map(list.map(o => [overlayKey(o), o]));
    let said;
    if (into.size === 1) {
        const [[k, n]] = [...into];
        const before = graphicName(was.get(k)), now = graphicName(n);
        said = to.none ? `${before} has no tag now`
            : to.builtIn ? `${before} is ${now} now`
            : `${before} is in ${to.name} now${now !== before ? `, as ${now}` : ''}`;
    } else said = to.none ? `${plural(into.size, 'graphic')} taken out of their tags` : `${plural(into.size, 'graphic')} tagged ${to.name}`;
    if (clash) said += `; ${same}, so ${clash === 1 ? 'it is' : 'they are'} as ${clash === 1 ? 'it was' : 'they were'}`;
    // Undo: each one still as it was made, and whose old name is free, goes back.
    const undo = async () => {
        const now = currentOverlays(), keys = new Set(now.map(overlayKey));
        const back = new Map();
        into.forEach((n, k) => {
            const nk = overlayKey(n);
            if (keys.has(nk) && (k === nk || !keys.has(k))) back.set(nk, was.get(k));
        });
        if (!back.size) { showToast('Nothing left to put back.', true); return; }
        if (await saveOverlays(now.map(o => back.get(overlayKey(o)) || o))) {
            showToast(back.size === 1 ? `${graphicName([...back.values()][0])} has its tag back.` : `${plural(back.size, 'graphic')} have their tags back.`);
        }
    };
    moving.forEach(k => overlayPicks.delete(k));
    return saveOverlays(list.map(o => into.get(overlayKey(o)) || o), `${said}.`, undo);
};

// Checking a box in a list (`selector`); with Shift, every one shown from
// the last one clicked (`from`) to this one goes the same way. `picks` holds
// the checked ones by their data-pick; returns where the next run starts.
const pickRun = (box, range, selector, picks, from) => {
    const boxes = [...document.querySelectorAll(selector)].filter(b => b.getClientRects().length);
    const start = range && from !== null ? boxes.findIndex(b => b.dataset.pick === from) : -1;
    const at = boxes.indexOf(box);
    const span = start >= 0 && at >= 0 ? boxes.slice(Math.min(start, at), Math.max(start, at) + 1) : [box];
    span.forEach(b => {
        b.checked = box.checked;
        if (box.checked) picks.add(b.dataset.pick); else picks.delete(b.dataset.pick);
    });
    return box.dataset.pick;
};
// A graphic in the list, or a shape in an import's review.
const pickOverlay = (box, range) => {
    overlayPickFrom = pickRun(box, range, '#overlaysBody .overlay-pick', overlayPicks, overlayPickFrom);
    renderOverlayBulk();
};
const pickReviewRow = (box, range) => {
    reviewPickFrom = pickRun(box, range, '#overlaysBody .overlay-review-pick', reviewPicks, reviewPickFrom);
    renderReviewBulk();
};
// What an import's shapes can be used as: Skip, each tag, then Unknown.
const reviewChoices = () => [{ id: SKIP, name: 'Skip' }, ...everyTag(), tagOf('')];
const reviewOptions = (sel) => reviewChoices().map(t => `<option value="${escapeHtml(t.id)}"${t.id === sel ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
// The bar over an import's review while shapes are checked: use them all as
// one tag (or Unknown, or Skip them).
const renderReviewBulk = () => {
    const bar = document.getElementById('overlayReviewBulk');
    if (!bar) return;
    const n = reviewPicks.size;
    bar.hidden = !n;
    if (!n) { bar.innerHTML = ''; return; }
    if (!reviewChoices().some(t => t.id === reviewBulkTag)) reviewBulkTag = (sharedTags[0] || BUILTIN_TAGS[0]).id;
    bar.innerHTML = `<span class="overlay-bulk-count">${n} selected</span>
        <label class="overlay-bulk-label" for="overlayReviewBulkTag">Use as</label>
        <select id="overlayReviewBulkTag">${reviewOptions(reviewBulkTag)}</select>
        <button type="button" id="overlayReviewBulkBtn" class="set-btn">Apply</button>
        <button type="button" id="overlayReviewBulkClearBtn" class="text-btn">Clear</button>`;
};
// The checked shapes all used as the tag picked in the bar. They stay
// checked, so another pick can follow.
const useCheckedAs = (type) => {
    if (!overlayReview) return;
    const rows = [...reviewPicks].map(i => overlayReview.rows[+i]).filter(Boolean);
    rows.forEach(r => { r.type = type; });
    renderOverlays();
    const as = reviewChoices().find(t => t.id === type);
    showToast(type === SKIP ? `${plural(rows.length, 'shape')} skipped.` : `${plural(rows.length, 'shape')} to be added as ${as ? as.name : 'Unknown'}.`);
};
// The bar over the list while graphics are checked: add them to a tag, or
// take them out of theirs.
const renderOverlayBulk = () => {
    const bar = document.getElementById('overlayBulk');
    if (!bar) return;
    const n = overlayPicks.size;
    bar.hidden = !n;
    if (!n) { bar.innerHTML = ''; return; }
    const tags = everyTag();
    if (!tags.some(t => t.id === overlayBulkTag)) overlayBulkTag = (sharedTags[0] || BUILTIN_TAGS[0]).id;
    bar.innerHTML = `<span class="overlay-bulk-count">${n} selected</span>
        <select id="overlayBulkTag" aria-label="The tag to add them to">${tags.map(t => `<option value="${escapeHtml(t.id)}"${t.id === overlayBulkTag ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
        <button type="button" id="overlayBulkAddBtn" class="set-btn">Add to Tag</button>
        <button type="button" id="overlayBulkRemoveBtn" class="cancel-btn">Remove from Tag</button>
        <button type="button" id="overlayBulkClearBtn" class="text-btn">Clear</button>`;
};

// The tags: one row however many there are. A list of the team's own (it
// says how many), and beside it the one picked, with its color, name, count
// and ×, and + New tag; or, while that is open, the new tag's boxes.
const tagsBlock = (list) => {
    const tags = [...sharedTags].sort((a, b) => a.name.localeCompare(b.name));
    if (!tags.some(t => t.id === tagPicked)) tagPicked = tags.length ? tags[0].id : null;
    let row;
    if (tagAdding) {
        row = `<div class="overlay-tag-row overlay-tag-new" role="group" aria-label="New tag">
            <input type="color" id="overlayTagNewColor" class="overlay-tag-color" value="${escapeHtml(tagDraft.color || nextTagColor())}" title="Color" aria-label="The new tag's color">
            <input type="text" id="overlayTagNewName" class="overlay-tag-name" value="${escapeHtml(tagDraft.name)}" maxlength="30" spellcheck="false" placeholder="New tag, such as Routes" aria-label="The new tag's name">
            <button type="button" id="overlayTagAddBtn" class="set-btn">Add Tag</button>
            <button type="button" id="overlayTagCancelBtn" class="text-btn">Cancel</button>
        </div>`;
    } else {
        const t = tags.find(x => x.id === tagPicked);
        const newBtn = `<button type="button" id="overlayTagNewBtn" class="text-btn overlay-tag-new-btn" aria-expanded="false">+ New tag</button>`;
        if (!t) row = `<div class="overlay-tag-row"><span class="overlay-tags-count">No tags of your own yet.</span>${newBtn}</div>`;
        else {
            const id = escapeHtml(t.id), n = list.filter(o => o.type === t.id).length;
            const ask = isAsking(`tag|${t.id}`);
            const name = ask
                ? `<span class="map-base-ask overlay-ask overlay-tag-ask" role="status" title="${escapeHtml(t.name)}">Delete for everyone?</span>`
                : `<input type="text" class="overlay-tag-name" data-tag-name="${id}" value="${escapeHtml(tagRenames.has(t.id) ? tagRenames.get(t.id) : t.name)}" maxlength="30" spellcheck="false" aria-label="Name of tag ${escapeHtml(t.name)}">`;
            row = `<div class="overlay-tag-row" data-tag-row="${id}">
                <label class="overlay-tags-count" for="overlayTagPick">${plural(tags.length, 'tag')}</label>
                <select id="overlayTagPick" class="overlay-tag-pick">${tags.map(x => `<option value="${escapeHtml(x.id)}"${x.id === t.id ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select>
                <input type="color" class="overlay-tag-color" data-tag-color="${id}" value="${escapeHtml(t.color)}" title="Color" aria-label="Color of tag ${escapeHtml(t.name)}">
                ${name}<span class="overlay-group-count" title="Graphics with this tag">${n}</span>
                <button type="button" class="overlay-remove" data-remove-tag="${id}"${ask ? ' data-asking' : ''} title="Delete tag ${escapeHtml(t.name)}" aria-label="Delete tag ${escapeHtml(t.name)}">&times;</button>
                ${newBtn}
            </div>`;
        }
    }
    return `<div class="overlay-tags editor-only" role="group" aria-label="Tags">
        <div class="overlay-tags-head">Tags</div>
        <div class="overlays-note">NAI, OBJ, PL and Axis of advance are built in. An axis of advance is a line from where the enemy comes from to where it heads; the narrative reads its way of march from it. Add your own tags for the other graphics: each draws in its color, and a report inside an area with one gets that area's name in its Location, as with an NAI.</div>
        ${row}
    </div>`;
};

const drawOverlays = (box) => {
    const note = document.getElementById('overlaysScopeNote');
    if (note) note.textContent = 'shared by every workspace';

    if (overlayReview) {
        const rows = overlayReview.rows;
        const count = rows.filter(r => reviewOverlay(r)).length;
        box.innerHTML = `
            <div class="overlays-note">From ${escapeHtml(overlayReview.files.join(', '))}. Check what each shape is. Areas place reports in NAIs and OBJs by grid, lines are phase lines (or axes of advance, when named AXIS or AOA), points are kept as labels. A shape whose name or folder doesn't say what it is goes in as Unknown: kept, but not on the map until you give it a tag. Check several (Shift-click for a run of them) to use them all as one tag; your own tags are in the list too.</div>
            <div id="overlayReviewBulk" class="overlay-bulk" role="group" aria-label="Checked shapes" hidden></div>
            <table class="overlays-table overlays-review">
                <thead><tr><th><span class="visually-hidden">Select</span></th><th>Name in file</th><th>Shape</th><th>Use as</th><th>Becomes</th></tr></thead>
                <tbody>${rows.map((r, i) => {
                    const o = reviewOverlay(r);
                    const tag = o && tagOf(o.type);
                    const becomes = !o ? '<span class="overlays-muted">skipped</span>'
                        : tag.builtIn ? escapeHtml(`${o.type} ${o.name}`)
                        : tag.none ? `<span class="overlays-muted">Unknown</span> ${escapeHtml(o.name)}`
                        : `${tagDot(o.type)}${escapeHtml(o.name)}`;
                    const name = r.label || '(no name)';
                    return `<tr><td class="overlay-pick-cell"><input type="checkbox" class="overlay-review-pick" data-pick="${i}"${reviewPicks.has(String(i)) ? ' checked' : ''} aria-label="Select ${escapeHtml(name)}"></td>
                        <td>${escapeHtml(name)}</td><td>${SHAPE_LABEL[(o || r).geometry.type]}</td>
                        <td><select class="overlay-type-select" data-review-idx="${i}" aria-label="Use ${escapeHtml(name)} as">${reviewOptions(r.type === SKIP ? SKIP : tagOf(r.type).id)}</select></td>
                        <td>${becomes}</td></tr>`;
                }).join('')}</tbody>
            </table>
            <div class="overlays-actions">
                <button type="button" id="overlaysReviewAddBtn" class="set-btn"${count ? '' : ' disabled'}>Add ${plural(count, 'overlay')}</button>
                <button type="button" id="overlaysReviewCancelBtn" class="cancel-btn">Cancel</button>
            </div>`;
        renderReviewBulk();
        return;
    }

    const list = currentOverlays();
    // The one asking was removed meanwhile (here or by someone else): let go.
    const asked = askingAbout('overlay|');
    if (asked && !list.some(o => `overlay|${overlayKey(o)}` === asked)) forgetAsk();
    const askedTag = askingAbout('tag|');
    if (askedTag && !sharedTags.some(t => `tag|${t.id}` === askedTag)) forgetAsk();
    // Checked ones that went meanwhile are let go too.
    const keys = new Set(list.map(overlayKey));
    overlayPicks.forEach(k => { if (!keys.has(k)) overlayPicks.delete(k); });
    const allAsk = isAsking('overlays|all');
    // The map of them is the Map view (app/85-mapview.js).
    const header = `<div class="overlays-head">
        <div class="overlays-actions editor-only">
            <button type="button" id="overlaysImportBtn" class="set-btn">Import KML / KMZ / GeoJSON / SHP</button>
            ${list.length ? `<button type="button" id="overlaysClearBtn" class="cancel-btn"${allAsk ? ' data-asking' : ''}>${allAsk ? 'Unload all for everyone?' : 'Unload All'}</button>` : ''}
        </div>
        ${list.length ? `<div class="overlay-fold" role="group" aria-label="Lists">
            <button type="button" class="overlay-fold-btn" data-overlay-fold="open" title="Expand all" aria-label="Expand all"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5 8 2l3.5 3.5M4.5 10.5 8 14l3.5-3.5"/></svg></button>
            <button type="button" class="overlay-fold-btn" data-overlay-fold="close" title="Collapse all" aria-label="Collapse all"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 8 6l3.5-3.5M4.5 13.5 8 10l3.5 3.5"/></svg></button>
        </div>` : ''}
    </div>`;
    // How many of the shown workspace's live reports each place appears in,
    // typed or by grid (a phase line: typed, or a grid near it).
    const uses = {};
    localReports.filter(r => !r.deleted).forEach(r => {
        const a = locationInfo(r.location);
        new Set([...a.nai.keys, ...a.obj.keys, ...a.pls, ...a.custom.map(c => c.key)]).forEach(k => { uses[k] = (uses[k] || 0) + 1; });
    });
    const tags = everyTag();
    const byName = (x, y) => x.o.name.localeCompare(y.o.name, undefined, { numeric: true });
    const row = ({ o, i }) => {
        const key = overlayKey(o), tag = tagOf(o.type), name = graphicName(o);
        // The name in the file, when it says more than the overlay's own name.
        const said  = String(o.label || '').toUpperCase().replace(/\s+/g, ' ').trim();
        const extra = said && said !== name.toUpperCase() && said !== o.name.toUpperCase() ? ` <span class="overlays-muted">${escapeHtml(o.label)}</span>` : '';
        const ask = isAsking(`overlay|${key}`);
        const shown = ask
            ? `<span class="map-base-ask overlay-ask" role="status" title="${escapeHtml(name)}">Remove for everyone?</span>`
            : `${escapeHtml(o.name)}${extra}`;
        // A built-in tag names a class; the team's (or none) is a dot of its color.
        const badge = tag.builtIn ? `<span class="overlay-type overlay-${tag.id.toLowerCase()}">${tag.id}</span>`
            : `<span class="overlay-type overlay-team" title="${escapeHtml(tag.title)}">${tagDot(o.type)}</span>`;
        const options = [...tags, tagOf('')].map(t => `<option value="${escapeHtml(t.id)}"${t.key === tag.key ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
        return `<tr><td class="overlay-pick-cell"><input type="checkbox" class="overlay-pick" data-pick="${escapeHtml(key)}"${overlayPicks.has(key) ? ' checked' : ''} aria-label="Select ${escapeHtml(name)}"></td>
            <td>${badge} ${shown}</td>
            <td>${SHAPE_LABEL[o.geometry.type] || ''}</td><td>${uses[name] || 0}</td>
            <td><select class="overlay-retag" data-retag="${i}" aria-label="Tag of ${escapeHtml(name)}">${options}</select></td>
            <td><button type="button" class="overlay-remove editor-only" data-remove-overlay="${i}"${ask ? ' data-asking' : ''} title="Remove ${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">&times;</button></td></tr>`;
    };
    // A list for each tag with graphics: Unknown first (the graphics with
    // none, waiting to be sorted), then the built-in ones, then the team's by
    // name.
    const groupTags = [tagOf(''), ...tags.filter(t => t.builtIn), ...tags.filter(t => !t.builtIn).sort((a, b) => a.name.localeCompare(b.name))];
    const groups = groupTags.map(tag => {
        const members = list.map((o, i) => ({ o, i })).filter(x => tagOf(x.o.type).key === tag.key).sort(byName);
        if (!members.length) return '';
        const groupAsk = isAsking(`overlays|${tag.key}`);
        const title = tag.builtIn ? `<span class="overlay-type overlay-${tag.id.toLowerCase()}">${tag.id}</span> ${tag.title}`
            : tag.none ? `${tagDot('')} Unknown <span class="overlays-muted">not on the map until tagged</span>`
            : `${tagDot(tag.id)} ${escapeHtml(tag.title)}`;
        return `<details class="overlay-group" data-overlay-group="${escapeHtml(tag.key)}"${overlayGroupsOpen.has(tag.key) ? ' open' : ''}>
            <summary class="overlay-group-head">
                <span class="overlay-group-chevron" aria-hidden="true"></span>
                <span class="overlay-group-title">${title}</span>
                <span class="overlay-group-count">${members.length}</span>
                <button type="button" class="overlay-group-unload editor-only" data-unload-group="${escapeHtml(tag.key)}"${groupAsk ? ' data-asking' : ''}>${escapeHtml(groupAsk ? `Unload ${tag.many} for everyone?` : `Unload ${tag.many}`)}</button>
            </summary>
            <table class="overlays-table">
                <thead><tr><th><span class="visually-hidden">Select</span></th><th>Name</th><th>Shape</th><th>Reports${shownAto() ? ` in ${escapeHtml(shownAto())}` : ''}</th><th>Tag</th><th></th></tr></thead>
                <tbody>${members.map(row).join('')}</tbody>
            </table>
        </details>`;
    }).join('');
    box.innerHTML = `${header}
        ${tagsBlock(list)}
        ${list.length ? `
        <div class="overlays-note">One set for every workspace. Importing a shape with the same type and name replaces the old one, so an updated NAI file just updates its NAIs. Check graphics (Shift-click for a run of them) to add them to a tag or take them out of theirs, or pick one's tag beside it. Unknown graphics, with no tag, aren't on the map until they have one.</div>
        <div id="overlayBulk" class="overlay-bulk editor-only" role="group" aria-label="Checked graphics" hidden></div>
        ${groups}` : `<div class="overlays-note">No overlays yet. Export your NAIs, OBJs and phase lines from ArcGIS as KML, KMZ, GeoJSON or a shapefile (zipped, or its .shp, .dbf and .prj picked together) and import them here. They apply to every workspace. Reports are then placed in NAIs and OBJs by their grid, and checked against what was typed.</div>`}`;
    renderOverlayBulk();
};
// Drawn again on every change (a sync too): a tag's box being typed in
// keeps its place and its caret, and a control with an id (the tag picked,
// a bar's button) keeps the focus.
const renderOverlays = () => {
    const box = document.getElementById('overlaysBody');
    if (!box) return;
    const had = document.activeElement;
    const inside = had && box.contains(had);
    const text = inside && had.matches('input[type="text"]');
    const typing = inside && (text || had.id)
        ? { id: had.id, tag: text ? had.dataset.tagName || '' : '', from: text ? had.selectionStart : 0, to: text ? had.selectionEnd : 0 } : null;
    drawOverlays(box);
    if (!typing) return;
    const again = typing.id ? document.getElementById(typing.id) : box.querySelector(`[data-tag-name="${CSS.escape(typing.tag)}"]`);
    if (!again || again === had || again.hidden) return;
    again.focus({ preventScroll: true });
    if (!text) return;
    try { again.setSelectionRange(typing.from, typing.to); } catch (e) { /* not a text box any more */ }
};

// Delegated: the tab's contents are re-rendered on every change.
const overlaysBody = document.getElementById('overlaysBody');
const overlaysFileInput = document.getElementById('overlaysFileInput');
if (overlaysBody && overlaysFileInput) {
    overlaysBody.addEventListener('click', e => {
        const rm = e.target.closest('[data-remove-overlay]');
        if (rm) {
            const list = currentOverlays();
            const victim = list[+rm.dataset.removeOverlay];
            if (!victim) return;
            // The first press asks; the second (on the same one) removes it.
            if (!askFirst(`overlay|${overlayKey(victim)}`, renderOverlays)) return;
            removeOverlays([victim], `${graphicName(victim)} removed.`);
            return;
        }
        const rmTag = e.target.closest('[data-remove-tag]');
        if (rmTag) { deleteTag(rmTag.dataset.removeTag); return; }
        if (e.target.closest('#overlayTagAddBtn')) { addTag(); return; }
        if (e.target.closest('#overlayTagNewBtn')) { openNewTag(true); return; }
        if (e.target.closest('#overlayTagCancelBtn')) { openNewTag(false); return; }
        const pick = e.target.closest('.overlay-pick');
        if (pick) { pickOverlay(pick, e.shiftKey); return; }
        const reviewPick = e.target.closest('.overlay-review-pick');
        if (reviewPick) { pickReviewRow(reviewPick, e.shiftKey); return; }
        if (e.target.closest('#overlayReviewBulkBtn')) { useCheckedAs(reviewBulkTag); return; }
        if (e.target.closest('#overlayReviewBulkClearBtn')) { reviewPicks.clear(); reviewPickFrom = null; renderOverlays(); return; }
        const checked = () => currentOverlays().filter(o => overlayPicks.has(overlayKey(o)));
        if (e.target.closest('#overlayBulkAddBtn')) { retagGraphics(checked(), overlayBulkTag); return; }
        if (e.target.closest('#overlayBulkRemoveBtn')) { retagGraphics(checked(), ''); return; }
        if (e.target.closest('#overlayBulkClearBtn')) { overlayPicks.clear(); overlayPickFrom = null; renderOverlays(); return; }
        if (e.target.closest('#overlaysImportBtn')) { overlaysFileInput.click(); return; }
        // Every list opened, or every list closed.
        const fold = e.target.closest('[data-overlay-fold]');
        if (fold) {
            const open = fold.dataset.overlayFold === 'open';
            overlaysBody.querySelectorAll('[data-overlay-group]').forEach(g => { g.open = open; });
            return;
        }
        if (e.target.closest('#overlaysReviewAddBtn')) { finishOverlayImport(); return; }
        if (e.target.closest('#overlaysReviewCancelBtn')) { endOverlayReview(); renderOverlays(); return; }
        // Every overlay, or a list's: reports are not changed.
        if (e.target.closest('#overlaysClearBtn')) {
            if (askFirst('overlays|all', renderOverlays)) removeOverlays(currentOverlays(), 'Every overlay unloaded.');
            return;
        }
        const group = e.target.closest('[data-unload-group]');
        if (group) {
            e.preventDefault();   // in the group's header: unload, without folding it
            const key = group.dataset.unloadGroup;
            if (!askFirst(`overlays|${key}`, renderOverlays)) return;
            const gone = currentOverlays().filter(o => tagOf(o.type).key === key);
            const tag = gone.length ? tagOf(gone[0].type) : null;
            if (!tag) return;
            removeOverlays(gone, tag.builtIn ? `${plural(gone.length, `${key} overlay`)} unloaded.`
                : tag.none ? `${plural(gone.length, 'unknown graphic')} unloaded.` : `${plural(gone.length, 'graphic')} tagged ${tag.name} unloaded.`);
            return;
        }
    });
    // A Shift-click on a checkbox selects a run of them, not the text between.
    overlaysBody.addEventListener('mousedown', e => { if (e.shiftKey && e.target.closest('.overlay-pick, .overlay-review-pick')) e.preventDefault(); });
    // Opened or closed: remembered, so a redraw keeps it.
    overlaysBody.addEventListener('toggle', e => {
        const g = e.target.closest('[data-overlay-group]');
        if (g) g.open ? overlayGroupsOpen.add(g.dataset.overlayGroup) : overlayGroupsOpen.delete(g.dataset.overlayGroup);
    }, true);
    overlaysBody.addEventListener('change', e => {
        const sel = e.target.closest('[data-review-idx]');
        if (sel && overlayReview) { overlayReview.rows[+sel.dataset.reviewIdx].type = sel.value; renderOverlays(); return; }
        const retag = e.target.closest('[data-retag]');
        if (retag) {
            const o = currentOverlays()[+retag.dataset.retag];
            if (o) retagGraphics([o], retag.value).then(ok => { if (!ok) renderOverlays(); });
            return;
        }
        if (e.target.id === 'overlayBulkTag') { overlayBulkTag = e.target.value; return; }
        if (e.target.id === 'overlayReviewBulkTag') { reviewBulkTag = e.target.value; return; }
        if (e.target.id === 'overlayTagPick') { tagPicked = e.target.value; forgetAsk(); tagRenames.clear(); renderOverlays(); return; }
        if (e.target.dataset.tagColor) { recolorTag(e.target.dataset.tagColor, e.target.value); return; }
        if (e.target.dataset.tagName) renameTag(e.target.dataset.tagName, e.target.value);
    });
    // What is typed is kept over a redraw until it is used.
    overlaysBody.addEventListener('input', e => {
        if (e.target.id === 'overlayTagNewName') tagDraft.name = e.target.value;
        else if (e.target.id === 'overlayTagNewColor') tagDraft.color = e.target.value;
        else if (e.target.dataset.tagName) tagRenames.set(e.target.dataset.tagName, e.target.value);
    });
    // Enter adds or renames; Escape puts a name back as it was, or closes
    // the new tag's boxes.
    overlaysBody.addEventListener('keydown', e => {
        if (e.target.id === 'overlayTagNewName' && e.key === 'Enter') { e.preventDefault(); addTag(); return; }
        if (tagAdding && e.key === 'Escape' && e.target.closest('.overlay-tag-new')) { e.preventDefault(); e.stopPropagation(); openNewTag(false); return; }
        const id = e.target.dataset && e.target.dataset.tagName;
        if (!id) return;
        if (e.key === 'Enter') { e.preventDefault(); renameTag(id, e.target.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tagRenames.delete(id); renderOverlays(); }
    });
    overlaysFileInput.addEventListener('change', () => {
        const files = Array.from(overlaysFileInput.files || []);
        overlaysFileInput.value = '';
        if (isReadOnly) { showToast('View-only mode. Importing overlays is disabled here.', true); return; }
        if (files.length) startOverlayImport(files);
    });
}

// --- ArcGIS export ---

// One point per grid, with what the Location box and Activity say, as a
// zipped shapefile (ArcGIS Pro: drag in the .shp) or CSV (XY Table To Point);
// or one line per report that moved (`kind` tracks-shp). The options: MTI
// Export, a file of the tracked and one of the wheeled (SaltCore.arcgisMti),
// and for points Every version, each saved version at its grids.
const exportForArcgis = (kind) => {
    const reps = getExportFilteredReports();
    if (!reps.length) { showToast('No reports to export.', true); return; }
    const customLabels = [...new Set([
        ...currentFormat().lines.filter(l => l.type === 'custom').map(l => l.label),
        ...reps.flatMap(r => Object.keys(r.custom || {})),
    ])];
    const base = `${exportFilename(shownAto() || 'ATO', localConfig.title || 'SALT')}_arcgis`;
    // Inside the zip: a name ArcGIS takes as a layer name as it is.
    const layerName = (s) => (/^[A-Za-z]/.test(s) ? s : `L_${s}`).replace(/[^A-Za-z0-9_]/g, '_');
    const zipType = 'application/zip';
    const mti = el.manage.mtiToggle.checked;
    // The files: one, or with MTI Export the tracked and the wheeled (each
    // only when it has rows), the second a moment after the first, as the
    // MTI CSV's are. Null when MTI finds neither.
    const save = (name, rows, write) => {
        const parts = mti ? Object.entries(SaltCore.arcgisMti(rows)).filter(([, r]) => r.length) : [['', rows]];
        if (!parts.length) { showToast('No tracked/wheeled reports found.', true); return null; }
        parts.forEach(([k, r], i) => {
            const go = () => write(k ? `${name}_${k}` : name, r);
            if (i) setTimeout(go, 400); else go();
        });
        return parts;
    };
    // "2 tracked and 1 wheeled"
    const mtiSaid = (parts) => parts.map(([k, r]) => `${r.length} ${k}`).join(' and ');
    if (kind.startsWith('tracks')) {
        // One line per report that moved, first grid to latest.
        const tracks = SaltCore.arcgisTrackRows(reps, { local: timeDisplayMode === 'local', idOf: formatFullId, team: narrTeam() });
        if (!tracks.length) { showToast('No report has moved: each needs updates at two or more grids.', true); return; }
        const parts = save(`${base}_tracks`, tracks, (name, r) => triggerDownload(`${name}.zip`, SaltCore.arcgisTracksShapefileZip(r, layerName(name)), zipType));
        if (!parts) return;
        showToast(mti ? `Exported MTI tracks, ${mtiSaid(parts)}.` : `Exported ${plural(tracks.length, 'track')}.`);
        clearExportFilter();
        return;
    }
    const all = document.getElementById('exportEveryVersionToggle').checked;
    const { rows, skipped } = SaltCore.arcgisRows(reps, currentOverlays(), {
        local: timeDisplayMode === 'local', customLabels, idOf: formatFullId, team: narrTeam(), all,
    });
    if (!rows.length) { showToast(`None of the ${plural(skipped, 'report')} has a readable MGRS grid.`, true); return; }
    const name = all ? `${base}_versions` : base;
    const parts = save(name, rows, kind === 'shp'
        ? (n, r) => triggerDownload(`${n}.zip`, SaltCore.arcgisShapefileZip(r, layerName(n)), zipType)
        : (n, r) => triggerDownload(`${n}.csv`, SaltCore.arcgisCsv(r), 'text/csv;charset=utf-8;'));
    if (!parts) return;
    const reportsOut = reps.length - skipped;
    showToast(`Exported ${mti ? `MTI points, ${mtiSaid(parts)},` : plural(rows.length, 'point')} from ${plural(reportsOut, 'report')}`
        + (all ? ', every version' : '') + (skipped ? `; ${skipped} without a readable grid left out.` : '.'), false, { ms: 6000 });
    clearExportFilter();
};

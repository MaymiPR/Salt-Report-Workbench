// SPDX-License-Identifier: AGPL-3.0-only

// Overlays: NAI / OBJ / PL features imported from KML, KMZ or GeoJSON (as
// ArcGIS exports them), reviewed, then saved as one set shared by every
// workspace, and synced.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- Reading files ---

// The KML inside a KMZ (a zip): doc.kml, or else the first .kml. Read with
// the browser's own inflater, so no library is needed.
const kmlFromKmz = async (buf) => {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('it is not a KMZ (zip) file');
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
    const kml = entries.find(e => /(^|\/)doc\.kml$/i.test(e.name)) || entries.find(e => /\.kml$/i.test(e.name));
    if (!kml) throw new Error('the KMZ holds no .kml file');
    const start = kml.offset + 30 + dv.getUint16(kml.offset + 26, true) + dv.getUint16(kml.offset + 28, true);
    const data  = new Uint8Array(buf, start, kml.size);
    if (kml.method === 0) return new TextDecoder().decode(data);
    if (kml.method !== 8) throw new Error('the KMZ uses a compression this browser cannot read');
    const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(out);
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

// NAI / OBJ / PL from a folder, layer, or file name ("NAIs", "Phase Lines").
const typeHint = (...texts) => {
    for (const t of texts) {
        const s = String(t || '');
        if (/\bNAIs?\b/i.test(s)) return 'NAI';
        if (/\bOBJ(ECTIVE)?S?\b/i.test(s)) return 'OBJ';
        if (/\bPLs?\b|phase\s*lines?/i.test(s)) return 'PL';
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
        return { label: ((child(pm, 'name') || {}).textContent || '').trim(), hint: typeHint(folder, fileName), geometry };
    });
};

// GeoJSON must be longitude/latitude. ArcGIS writes Web Mercator unless told
// to project to WGS 1984; that one is converted, any other projection refused.
const fromWebMercator = ([x, y]) => [x / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI];
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
    const project = (v) => typeof v[0] === 'number' ? (mercator ? fromWebMercator(v) : v) : v.map(project);
    const out = feats.map(f => {
        const into = { polygons: [], lines: [], points: [] };
        walk(f.geometry, into);
        Object.keys(into).forEach(k => { into[k] = into[k].map(project); parts[k].push(...into[k]); });
        const props = f.properties || {};
        const label = ['name', 'Name', 'NAME', 'title', 'Title', 'label', 'Label'].map(k => props[k]).find(v => v != null && String(v).trim());
        const kind  = ['type', 'Type', 'TYPE', 'category', 'Category', 'layer', 'Layer'].map(k => props[k]).find(v => v != null);
        return { label: String(label || '').trim(), hint: typeHint(kind, fileName), geometry: combineGeometry(into) };
    });
    const flat = [...parts.polygons.flat(2), ...parts.lines.flat(1), ...parts.points];
    if (flat.some(c => Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
        throw new Error('its coordinates are not longitude/latitude. Export it again with "Project to WGS 1984" (or as KML)');
    }
    return out;
};

const readOverlayFile = async (file) => {
    const name = file.name || '';
    if (/\.kmz$/i.test(name)) return kmlFeatures(await kmlFromKmz(await file.arrayBuffer()), name);
    const text = await file.text();
    if (/\.kml$/i.test(name) || /^\s*</.test(text)) return kmlFeatures(text, name);
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('it is not KML, KMZ, or GeoJSON'); }
    return geojsonFeatures(obj, name);
};

// --- Review, then save ---

const SHAPE_LABEL = { Polygon: 'Area', MultiPolygon: 'Area', LineString: 'Line', MultiLineString: 'Line', Point: 'Point' };
let overlayReview = null;  // { rows: [{ label, geometry, type }], files: [names] }

// The overlay a review row becomes with the type picked for it.
const reviewOverlay = (row) => {
    if (!row.type) return null;
    const ref = SaltCore.overlayRef(row.label, row.type);
    const name = (ref ? ref.name : 'UNNAMED').slice(0, 40);
    const geometry = row.type === 'PL' ? row.geometry : SaltCore.asArea(row.geometry);
    return { type: row.type, name, ...(row.label ? { label: row.label.slice(0, 100) } : {}), geometry };
};

const startOverlayImport = async (files) => {
    const rows = [], names = [], failed = [];
    for (const f of files) {
        try {
            (await readOverlayFile(f)).forEach(ft => {
                if (!ft.geometry) return;
                // A prefix in the name ("NAI 3") wins; then the folder or file
                // name; lines with neither are phase lines; areas need a choice.
                const own = SaltCore.overlayRef(ft.label, null);
                const type = own ? own.type : ft.hint || (/Line/.test(ft.geometry.type) ? 'PL' : '');
                rows.push({ label: ft.label, geometry: ft.geometry, type });
            });
            names.push(f.name);
        } catch (e) { failed.push(`${f.name}: ${e.message}`); }
    }
    if (failed.length) showToast(`Couldn't read ${failed.join('; ')}.`, true, { ms: 8000 });
    if (!rows.length) { if (!failed.length) showToast('No shapes found in that file.', true); return; }
    overlayReview = { rows, files: names };
    renderOverlays();
};

// `incoming` replaces any overlay of the same type and name in `list`.
const overlayKey = o => `${o.type} ${o.name}`;
const mergeOverlays = (list, incoming) => {
    const keys = new Set(incoming.map(overlayKey));
    return [...list.filter(o => !keys.has(overlayKey(o))), ...incoming];
};

const saveOverlays = async (list) => {
    sharedOverlays = list;
    storeOverlays();
    renderOverlays();
    renderLog();
    renderLocationHints();
    if (isLocalFile) return true;
    try {
        const res = await postJson('/api/save_overlays', { overlays: list });
        if (res.status === 401) { handleUnauthorized(); return false; }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(`The server refused the overlays: ${body.message || res.status}`, true, { ms: 8000 });
            return false;
        }
        return true;
    } catch (e) {
        showToast('Saved in this browser only: the server could not be reached. Import again once it is back.', true, { ms: 8000 });
        return false;
    }
};

const finishOverlayImport = async () => {
    if (!overlayReview) return;
    const added = overlayReview.rows.map(reviewOverlay).filter(Boolean);
    if (!added.length) { showToast('Pick a type for at least one shape, or Cancel.', true); return; }
    // Same type and name replaces: re-importing an updated NAI file updates it.
    const have = new Set(currentOverlays().map(overlayKey));
    const replaced = added.filter(o => have.has(overlayKey(o))).length;
    overlayReview = null;
    if (await saveOverlays(mergeOverlays(currentOverlays(), added))) {
        const n = t => added.filter(o => o.type === t).length;
        showToast(`Imported ${added.length} overlay${added.length === 1 ? '' : 's'}: ${n('NAI')} NAI, ${n('OBJ')} OBJ, ${n('PL')} PL`
            + (replaced ? ` (${replaced} replaced an older one).` : '.'));
    }
};

// --- The Overlays tab ---

const renderOverlays = () => {
    const box = document.getElementById('overlaysBody');
    if (!box) return;
    const note = document.getElementById('overlaysScopeNote');
    if (note) note.textContent = 'shared by every workspace';

    if (overlayReview) {
        const rows = overlayReview.rows;
        const opts = (sel) => ['', 'NAI', 'OBJ', 'PL'].map(t => `<option value="${t}"${t === sel ? ' selected' : ''}>${t || 'Skip'}</option>`).join('');
        const count = rows.filter(r => r.type).length;
        box.innerHTML = `
            <div class="overlays-note">From ${escapeHtml(overlayReview.files.join(', '))}. Pick what each shape is. Areas place reports in NAIs and OBJs by grid, lines are phase lines, points are kept as labels.</div>
            <table class="overlays-table">
                <thead><tr><th>Name in file</th><th>Shape</th><th>Use as</th><th>Becomes</th></tr></thead>
                <tbody>${rows.map((r, i) => {
                    const o = reviewOverlay(r);
                    return `<tr><td>${escapeHtml(r.label || '(no name)')}</td><td>${SHAPE_LABEL[(o || r).geometry.type]}</td>
                        <td><select class="overlay-type-select" data-review-idx="${i}" aria-label="Use as">${opts(r.type)}</select></td>
                        <td>${o ? escapeHtml(`${o.type} ${o.name}`) : '<span class="overlays-muted">skipped</span>'}</td></tr>`;
                }).join('')}</tbody>
            </table>
            <div class="overlays-actions">
                <button type="button" id="overlaysReviewAddBtn" class="set-btn"${count ? '' : ' disabled'}>Add ${count} overlay${count === 1 ? '' : 's'}</button>
                <button type="button" id="overlaysReviewCancelBtn" class="cancel-btn">Cancel</button>
            </div>`;
        return;
    }

    const list = currentOverlays();
    // How many of the shown workspace's live reports each place appears in,
    // typed or by grid (a phase line: typed, or a grid near it).
    const uses = {};
    localReports.filter(r => !r.deleted).forEach(r => {
        const a = locationInfo(r.location);
        new Set([...a.nai.keys, ...a.obj.keys, ...a.pls]).forEach(k => { uses[k] = (uses[k] || 0) + 1; });
    });
    const GROUPS = [['NAI', 'NAIs'], ['OBJ', 'Objectives'], ['PL', 'Phase lines']];
    const byName = (x, y) => x.o.name.localeCompare(y.o.name, undefined, { numeric: true });
    const row = ({ o, i }) => {
        const key = overlayKey(o);
        // The name in the file, when it says more than the overlay's own name.
        const said  = String(o.label || '').toUpperCase().replace(/\s+/g, ' ').trim();
        const extra = said && said !== key && said !== o.name ? ` <span class="overlays-muted">${escapeHtml(o.label)}</span>` : '';
        return `<tr><td><span class="overlay-type overlay-${o.type.toLowerCase()}">${o.type}</span> ${escapeHtml(o.name)}${extra}</td>
            <td>${SHAPE_LABEL[o.geometry.type] || ''}</td><td>${uses[key] || 0}</td>
            <td><button type="button" class="overlay-remove editor-only" data-remove-overlay="${i}" title="Unload ${escapeHtml(key)}" aria-label="Unload ${escapeHtml(key)}">&times;</button></td></tr>`;
    };
    const groups = GROUPS.map(([type, title]) => {
        const members = list.map((o, i) => ({ o, i })).filter(x => x.o.type === type).sort(byName);
        if (!members.length) return '';
        return `<section class="overlay-group" data-overlay-group="${type}">
            <div class="overlay-group-head">
                <span class="overlay-group-title"><span class="overlay-type overlay-${type.toLowerCase()}">${type}</span> ${title}</span>
                <span class="overlay-group-count">${members.length}</span>
                <button type="button" class="overlay-group-unload editor-only" data-unload-group="${type}">Unload ${type === 'OBJ' ? 'OBJs' : type === 'PL' ? 'PLs' : 'NAIs'}</button>
            </div>
            <table class="overlays-table">
                <thead><tr><th>Name</th><th>Shape</th><th>Reports${shownAto() ? ` in ${escapeHtml(shownAto())}` : ''}</th><th></th></tr></thead>
                <tbody>${members.map(row).join('')}</tbody>
            </table>
        </section>`;
    }).join('');
    box.innerHTML = `
        <div class="overlays-actions editor-only">
            <button type="button" id="overlaysImportBtn" class="set-btn">Import KML / KMZ / GeoJSON</button>
            ${list.length ? '<button type="button" id="overlaysClearBtn" class="cancel-btn">Unload All</button>' : ''}
        </div>
        ${list.length ? `
        <div class="overlays-note">One set for every workspace. Importing a shape with the same type and name replaces the old one, so an updated NAI file just updates its NAIs.</div>
        ${groups}` : `<div class="overlays-note">No overlays yet. Export your NAIs, OBJs and phase lines from ArcGIS as KML, KMZ or GeoJSON and import them here. They apply to every workspace. Reports are then placed in NAIs and OBJs by their grid, and checked against what was typed.</div>`}`;
};

// Delegated: the tab's contents are re-rendered on every change.
const overlaysBody = document.getElementById('overlaysBody');
const overlaysFileInput = document.getElementById('overlaysFileInput');
if (overlaysBody && overlaysFileInput) {
    overlaysBody.addEventListener('click', e => {
        if (e.target.closest('#overlaysImportBtn')) { overlaysFileInput.click(); return; }
        if (e.target.closest('#overlaysReviewAddBtn')) { finishOverlayImport(); return; }
        if (e.target.closest('#overlaysReviewCancelBtn')) { overlayReview = null; renderOverlays(); return; }
        if (e.target.closest('#overlaysClearBtn')) {
            showConfirmation('Unload every overlay, from every workspace? Reports are not changed.', () => saveOverlays([]));
            return;
        }
        const group = e.target.closest('[data-unload-group]');
        if (group) {
            const type = group.dataset.unloadGroup;
            const n = currentOverlays().filter(o => o.type === type).length;
            showConfirmation(`Unload all ${n} ${type} overlay${n === 1 ? '' : 's'}? Reports are not changed.`,
                () => saveOverlays(currentOverlays().filter(o => o.type !== type)));
            return;
        }
        const rm = e.target.closest('[data-remove-overlay]');
        if (rm) {
            const list = currentOverlays();
            const victim = list[+rm.dataset.removeOverlay];
            if (victim) saveOverlays(list.filter(o => o !== victim));
        }
    });
    overlaysBody.addEventListener('change', e => {
        const sel = e.target.closest('[data-review-idx]');
        if (sel && overlayReview) { overlayReview.rows[+sel.dataset.reviewIdx].type = sel.value; renderOverlays(); }
    });
    overlaysFileInput.addEventListener('change', () => {
        const files = Array.from(overlaysFileInput.files || []);
        overlaysFileInput.value = '';
        if (isReadOnly) { showToast('View-only mode. Importing overlays is disabled here.', true); return; }
        if (files.length) startOverlayImport(files);
    });
}

// --- ArcGIS export ---

// One point per grid, with what the Location box and Activity say, as Esri
// JSON or GeoJSON (ArcGIS Pro: JSON To Features) or CSV (XY Table To Point).
const exportForArcgis = (kind) => {
    const reps = getExportFilteredReports();
    if (!reps.length) { showToast('No reports to export.', true); return; }
    const customLabels = [...new Set([
        ...currentFormat().lines.filter(l => l.type === 'custom').map(l => l.label),
        ...reps.flatMap(r => Object.keys(r.custom || {})),
    ])];
    const { rows, skipped } = SaltCore.arcgisRows(reps, currentOverlays(), {
        local: timeDisplayMode === 'local', customLabels, idOf: formatFullId,
    });
    if (!rows.length) { showToast(`None of the ${skipped} report${skipped === 1 ? '' : 's'} has a readable MGRS grid.`, true); return; }
    const base = `${getCsvFilename(shownAto() || 'ATO', localConfig.title || 'SALT')}_arcgis`;
    if (kind === 'csv') triggerDownload(`${base}.csv`, SaltCore.arcgisCsv(rows), 'text/csv;charset=utf-8;');
    else if (kind === 'esri') triggerDownload(`${base}.json`, SaltCore.arcgisEsriJson(rows), 'application/json');
    else triggerDownload(`${base}.geojson`, SaltCore.arcgisGeoJson(rows), 'application/geo+json');
    const reportsOut = reps.length - skipped;
    showToast(`Exported ${rows.length} point${rows.length === 1 ? '' : 's'} from ${reportsOut} report${reportsOut === 1 ? '' : 's'}`
        + (skipped ? `; ${skipped} without a readable grid left out.` : '.'), false, { ms: 6000 });
    clearExportFilter();
};

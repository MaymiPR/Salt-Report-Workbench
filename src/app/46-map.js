// SPDX-License-Identifier: AGPL-3.0-only

// The overlay map (Overlays tab, Map): the shared NAIs, OBJs and phase lines
// in Web Mercator, over an optional WMS or tile basemap fetched only for the
// area the graphics cover, with a heat map or a track map of the shown
// workspace's reports. Plain SVG drawn in screen pixels; no map library.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

const MAP_COLORS = { NAI: '#32d74b', OBJ: '#0a84ff', PL: '#000000', track: '#ff9f0a' };
let mapMode = localStorage.getItem('salt_map_mode') === 'tracks' ? 'tracks' : 'heat';
let mapHours = 0;              // the window, in hours back from now; 0 for all
let mapView = null;            // { cx, cy, mpp }: centre (Web Mercator metres) and metres per pixel
// The basemap this browser shows, by name: 'off' for none, '' for the first.
let mapBaseChoice = localStorage.getItem('salt_map_base') || '';
const activeBasemap = () => (mapBaseChoice === 'off' ? null
    : sharedBasemaps.find(b => b.name === mapBaseChoice) || sharedBasemaps[0] || null);
let mapBaseFailed = false;
let mapWmsTimer = null;
let mapFrame = 0;
let mapItems = [];             // what the pointer can hover: [{ kind, ...}] by index

const mapEls = () => ({
    box: document.getElementById('mapBox'), svg: document.getElementById('mapSvg'),
    base: document.getElementById('mapBase'), tip: document.getElementById('mapTip'),
    note: document.getElementById('mapNote'), legend: document.getElementById('mapLegend'),
});

// The reports the map shows: the shown workspace's, in the window.
const mapReports = () => {
    let reps = localReports.filter(r => !r.deleted);
    if (mapHours) {
        const from = Date.now() - mapHours * 3600000;
        reps = reps.filter(r => r.time && new Date(r.time).getTime() >= from);
    }
    return reps;
};

// The area the map covers: the overlays and the reports' grids, padded a
// little. The basemap is asked for this area only. Null when there is
// nothing to show.
const mapExtent = (tracks) => {
    const pts = [];
    const walk = v => (typeof v[0] === 'number' ? pts.push(SaltCore.lonLatToMerc(v[0], v[1])) : v.forEach(walk));
    currentOverlays().forEach(o => o.geometry && walk(o.geometry.coordinates));
    tracks.forEach(t => t.points.forEach(p => pts.push(SaltCore.lonLatToMerc(p.lon, p.lat))));
    if (!pts.length) return null;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const pad = Math.max(500, (x1 - x0) * 0.08, (y1 - y0) * 0.08);
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
};

// Keep the view inside the extent: no zooming out past it, no panning off it.
const clampMapView = (ext, w, h) => {
    const fit = Math.max((ext[2] - ext[0]) / w, (ext[3] - ext[1]) / h);
    const v = mapView;
    v.mpp = Math.min(fit, Math.max(0.25, v.mpp));
    const hw = w * v.mpp / 2, hh = h * v.mpp / 2;
    v.cx = hw * 2 >= ext[2] - ext[0] ? (ext[0] + ext[2]) / 2 : Math.min(ext[2] - hw, Math.max(ext[0] + hw, v.cx));
    v.cy = hh * 2 >= ext[3] - ext[1] ? (ext[1] + ext[3]) / 2 : Math.min(ext[3] - hh, Math.max(ext[1] + hh, v.cy));
};

const svgEsc = escapeHtml;

// --- Drawing ---

const drawMap = () => {
    const m = mapEls();
    if (!m.svg || !m.box) return;
    const w = m.box.clientWidth, h = m.box.clientHeight;
    if (!w || !h) return;
    const reps = mapReports();
    const tracks = SaltCore.reportTracks(reps);
    const ext = mapExtent(tracks);
    if (!ext) {
        m.svg.innerHTML = '';
        m.base.innerHTML = '';
        m.note.textContent = 'Import overlays, or log reports with grids, to see the map.';
        m.note.hidden = false;
        m.legend.innerHTML = '';
        return;
    }
    // A new report or overlay keeps the view where it is (inside the new area).
    if (!mapView) mapView = { cx: (ext[0] + ext[2]) / 2, cy: (ext[1] + ext[3]) / 2, mpp: Infinity };
    clampMapView(ext, w, h);
    const { cx, cy, mpp } = mapView;
    const px = (lon, lat) => { const [x, y] = SaltCore.lonLatToMerc(lon, lat); return [(x - cx) / mpp + w / 2, (cy - y) / mpp + h / 2]; };
    const view = [cx - w * mpp / 2, cy - h * mpp / 2, cx + w * mpp / 2, cy + h * mpp / 2];
    drawBasemap(m, ext, view, w, h);

    const out = [];
    mapItems = [];
    if (mapMode === 'heat') out.push(heatLayer(reps, px, w, h));
    out.push(overlayLayer(px));
    if (mapMode === 'tracks') out.push(trackLayer(tracks, px));
    m.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    m.svg.innerHTML = out.join('');
    m.note.hidden = !mapBaseFailed;
    if (mapBaseFailed) m.note.textContent = "The basemap service didn't answer. It may not be reachable from this computer.";
    m.legend.innerHTML = mapLegend(reps, tracks);
};
const redrawMap = () => { cancelAnimationFrame(mapFrame); mapFrame = requestAnimationFrame(drawMap); };

const pathOf = (coords, px, close) => coords.map((c, i) => { const [x, y] = px(c[0], c[1]); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + (close ? 'Z' : '');

const overlayLayer = (px) => {
    const fill = [], lines = [], labels = [];
    const label = (x, y, text) => labels.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="map-label" text-anchor="middle">${svgEsc(text)}</text>`);
    currentOverlays().forEach(o => {
        const g = o.type === 'PL' ? o.geometry : SaltCore.asArea(o.geometry);
        const color = MAP_COLORS[o.type];
        const key = `${o.type} ${o.name}`;
        if (/Polygon/.test(g.type)) {
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
            const d = polys.map(rings => rings.map(r => pathOf(r, px, true)).join('')).join('');
            fill.push(`<path d="${d}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="2" fill-rule="evenodd"/>`);
            const pts = polys[0][0].map(c => px(c[0], c[1]));
            const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
            label((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, key);
        } else if (/LineString/.test(g.type)) {
            const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
            const d = parts.map(l => pathOf(l, px, false)).join('');
            // Black, on a white edge, so it shows on dark imagery and on the plain background.
            lines.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`
                + `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
            const [x, y] = px(...parts[0][parts[0].length - 1]);
            label(x, y - 8, key);
        } else if (g.type === 'Point') {
            const [x, y] = px(...g.coordinates);
            fill.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
            label(x, y - 8, key);
        }
    });
    return `<g class="map-overlays">${fill.join('')}${lines.join('')}</g><g class="map-labels">${labels.join('')}</g>`;
};

// Each report once, at its latest grid: a density surface drawn on a canvas,
// coloured with one hue from clear to bright, and laid under the graphics.
const HEAT_RADIUS = 28;
// Warm and sequential: clear, then orange, yellow, and near white at the
// densest, more opaque as it rises, so the busiest places read at a glance
// over imagery or the plain background.
const HEAT_STOPS = [[0, [255, 159, 10, 0]], [0.12, [255, 159, 10, 70]], [0.45, [255, 159, 10, 170]], [0.75, [255, 214, 10, 215]], [1, [255, 248, 220, 235]]];
const heatColor = (t) => {
    if (t < 0.03) return [0, 0, 0, 0];
    const k = HEAT_STOPS.findIndex(([s]) => s >= t);
    const [s1, c1] = HEAT_STOPS[Math.max(1, k)], [s0, c0] = HEAT_STOPS[Math.max(0, k - 1)];
    const f = s1 === s0 ? 1 : (t - s0) / (s1 - s0);
    return c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
};
const heatLayer = (reps, px, w, h) => {
    const pts = SaltCore.heatPoints(reps).map(p => ({ xy: px(p.lon, p.lat), w: p.w }))
        .filter(p => p.xy[0] > -HEAT_RADIUS && p.xy[0] < w + HEAT_RADIUS && p.xy[1] > -HEAT_RADIUS && p.xy[1] < h + HEAT_RADIUS);
    if (!pts.length) return '';
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.globalCompositeOperation = 'lighter';
    pts.forEach(({ xy: [x, y], w: wt }) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, HEAT_RADIUS);
        g.addColorStop(0, `rgba(0,0,0,${0.35 * wt})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - HEAT_RADIUS, y - HEAT_RADIUS, HEAT_RADIUS * 2, HEAT_RADIUS * 2);
    });
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    let max = 0;
    for (let i = 3; i < d.length; i += 4) max = Math.max(max, d[i]);
    if (!max) return '';
    for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = heatColor(d[i + 3] / max);
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.putImageData(img, 0, 0);
    return `<image href="${c.toDataURL('image/png')}" x="0" y="0" width="${w}" height="${h}" class="map-heat"/>`;
};

// Each report's path, first position to latest, with an arrow at the end;
// a report that never moved is a dot (with a short arrow when its Activity
// gives a heading).
const trackLayer = (tracks, px) => {
    const color = MAP_COLORS.track, out = [];
    const arrow = (x, y, deg, size) => {
        const a = deg * Math.PI / 180, s = size;
        const tip = [x + Math.sin(a) * s * 0.6, y - Math.cos(a) * s * 0.6];
        const l = [x + Math.sin(a - 2.5) * s * 0.6, y - Math.cos(a - 2.5) * s * 0.6];
        const r = [x + Math.sin(a + 2.5) * s * 0.6, y - Math.cos(a + 2.5) * s * 0.6];
        return `<path d="M${tip.map(v => v.toFixed(1))}L${l.map(v => v.toFixed(1))}L${r.map(v => v.toFixed(1))}Z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>`;
    };
    // Names on the tracks that moved, while they stay readable; hover tells the rest.
    const labelled = tracks.filter(t => t.moved).length <= 25;
    tracks.forEach(t => {
        const i = mapItems.push({ kind: 'track', t }) - 1;
        const pts = t.points.map(p => px(p.lon, p.lat));
        const [ex, ey] = pts[pts.length - 1];
        if (t.moved) {
            const d = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
            const [ax, ay] = pts[pts.length - 2];
            const deg = Math.atan2(ex - ax, ay - ey) * 180 / Math.PI;
            out.push(`<g class="map-track" data-map-item="${i}">`
                + `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`
                + `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`
                + `<circle cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="3.5" fill="#1c1c1e" stroke="${color}" stroke-width="2"/>`
                + pts.slice(1, -1).map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${color}"/>`).join('')
                + arrow(ex, ey, deg, 16)
                + `<path d="${d}" fill="none" stroke="transparent" stroke-width="14" class="map-hit"/></g>`);
        } else {
            const act = SaltCore.classifyActivity(t.report.activity);
            out.push(`<g class="map-track" data-map-item="${i}">`
                + (act.headingDeg !== null ? arrow(ex + Math.sin(act.headingDeg * Math.PI / 180) * 9, ey - Math.cos(act.headingDeg * Math.PI / 180) * 9, act.headingDeg, 11) : '')
                + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4.5" fill="${color}" stroke="#fff" stroke-width="1.5"/>`
                + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="10" fill="transparent" class="map-hit"/></g>`);
        }
        if (labelled && t.moved) out.push(`<text x="${(ex + 9).toFixed(1)}" y="${(ey + 4).toFixed(1)}" class="map-label map-label-track">${svgEsc(t.report.displayId || '')}</text>`);
    });
    return `<g class="map-tracks">${out.join('')}</g>`;
};

// The key: what each colour is, and what the heat or the tracks count.
const mapLegend = (reps, tracks) => {
    const swatch = (color, line) => `<svg width="18" height="10" aria-hidden="true">${line
        ? `<line x1="1" y1="5" x2="17" y2="5" stroke="#fff" stroke-width="4"/><line x1="1" y1="5" x2="17" y2="5" stroke="${color}" stroke-width="2"/>`
        : `<rect x="1" y="1" width="16" height="8" rx="2" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1.5"/>`}</svg>`;
    const key = (inner, text) => `<span class="map-key">${inner}${text}</span>`;
    const what = mapMode === 'heat'
        ? key('<span class="map-ramp"></span>', `Fewer to more reports (${Math.round(SaltCore.heatPoints(reps).reduce((s, p) => s + p.w, 0))}, each once, at its latest grid)`)
        : key(swatch(MAP_COLORS.track, true), `Track, first to latest (${tracks.filter(t => t.moved).length} moved, ${tracks.filter(t => !t.moved).length} at one grid)`);
    return key(swatch(MAP_COLORS.NAI), 'NAI') + key(swatch(MAP_COLORS.OBJ), 'OBJ') + key(swatch(MAP_COLORS.PL, true), 'PL') + what;
};

// --- Basemap ---

// Images are kept by address and only moved as the view changes, so panning
// doesn't fetch again. Only the part of the view inside the extent is asked for.
const drawBasemap = (m, ext, view, w, h) => {
    const b = activeBasemap();
    if (!b) { m.base.innerHTML = ''; return; }
    const { cx, cy, mpp } = mapView;
    const place = (img, box) => {
        img.setAttribute('x', ((box[0] - cx) / mpp + w / 2).toFixed(1));
        img.setAttribute('y', ((cy - box[3]) / mpp + h / 2).toFixed(1));
        img.setAttribute('width', ((box[2] - box[0]) / mpp + 0.6).toFixed(1));
        img.setAttribute('height', ((box[3] - box[1]) / mpp + 0.6).toFixed(1));
    };
    const want = [Math.max(ext[0], view[0]), Math.max(ext[1], view[1]), Math.min(ext[2], view[2]), Math.min(ext[3], view[3])];
    if (want[0] >= want[2] || want[1] >= want[3]) { m.base.innerHTML = ''; return; }
    const have = new Map([...m.base.children].map(el => [el.dataset.url, el]));
    const add = (url, box) => {
        let img = have.get(url);
        if (!img) {
            img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            img.dataset.url = url;
            img.dataset.box = box.join(',');
            img.setAttribute('preserveAspectRatio', 'none');
            img.addEventListener('error', () => { if (!mapBaseFailed) { mapBaseFailed = true; redrawMap(); } });
            img.addEventListener('load', () => { if (mapBaseFailed) { mapBaseFailed = false; redrawMap(); } });
            img.setAttribute('href', url);
            m.base.appendChild(img);
        }
        have.delete(url);
        place(img, box);
        return img;
    };
    if (b.kind === 'tiles') {
        const tiles = SaltCore.tilesFor(want, SaltCore.tileZoom(mpp), 400) || [];
        tiles.forEach(t => add(SaltCore.tileUrl(b.url, t), t.box));
        have.forEach(el => el.remove());
        return;
    }
    // WMS: one image for what's in view, asked for once the view settles; the
    // one on screen stays (moved with the view) until the new one arrives.
    have.forEach(el => place(el, el.dataset.box.split(',').map(Number)));
    clearTimeout(mapWmsTimer);
    mapWmsTimer = setTimeout(() => {
        const pw = Math.min(2048, Math.round((want[2] - want[0]) / mpp)), ph = Math.min(2048, Math.round((want[3] - want[1]) / mpp));
        if (pw < 8 || ph < 8) return;
        const url = SaltCore.wmsUrl(b.url, b.layers, want, pw, ph);
        if (m.base.querySelector(`[data-url="${CSS.escape(url)}"]`)) return;
        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.dataset.url = url;
        img.dataset.box = want.join(',');
        img.setAttribute('preserveAspectRatio', 'none');
        img.addEventListener('load', () => {
            [...m.base.children].forEach(el => { if (el !== img) el.remove(); });
            if (mapBaseFailed) { mapBaseFailed = false; redrawMap(); }
        });
        img.addEventListener('error', () => { img.remove(); if (!mapBaseFailed) { mapBaseFailed = true; redrawMap(); } });
        img.setAttribute('href', url);
        place(img, want);
        m.base.appendChild(img);
    }, 300);
};

// Editors keep the list of services: each row can be removed; the last row adds one.
const basemapForm = () => `<div class="map-basemap-form editor-only" id="mapBasemapForm" hidden>
        <div class="map-base-list">${sharedBasemaps.map((b, i) => `
            <div class="map-base-row">
                <span class="map-base-name">${escapeHtml(b.name)}</span>
                <span class="map-base-kind">${b.kind === 'wms' ? 'WMS' : 'Tiles'}</span>
                <span class="map-base-url" title="${escapeHtml(b.url)}">${escapeHtml(b.url)}${b.layers ? ` &middot; ${escapeHtml(b.layers)}` : ''}</span>
                <button type="button" class="overlay-remove" data-base-remove="${i}" title="Remove ${escapeHtml(b.name)}" aria-label="Remove ${escapeHtml(b.name)}">&times;</button>
            </div>`).join('') || '<div class="overlays-muted">No services yet.</div>'}</div>
        <div class="map-form-row">
            <input type="text" id="mapBaseName" placeholder="Name, e.g. Imagery" maxlength="60" spellcheck="false">
            <select id="mapBaseKind" aria-label="Kind of service">
                <option value="wms">WMS</option>
                <option value="tiles">Tiles (WMTS, ArcGIS, XYZ)</option>
            </select>
            <input type="text" id="mapBaseUrl" placeholder="Service address" maxlength="2000" spellcheck="false">
            <input type="text" id="mapBaseLayers" placeholder="Layers (WMS)" maxlength="300" spellcheck="false">
            <button type="button" id="mapBaseAdd" class="set-btn">Add</button>
        </div>
        <div class="overlays-note">WMS: the service's address and its layer names; it is asked for EPSG:3857 images. Tiles: an address with {z}, {x} and {y}
            (or WMTS's {TileMatrix}, {TileRow} and {TileCol}) in Web Mercator (GoogleMapsCompatible), such as an ArcGIS tile service's
            <code>.../MapServer/tile/{z}/{y}/{x}</code>. Only the area of your graphics is requested. The list is shared with everyone;
            each person picks which one to show.</div>
    </div>`;

const saveBasemaps = async (list, said) => {
    sharedBasemaps = list;
    mapBaseFailed = false;
    storeBasemaps();
    renderOverlays();
    if (isLocalFile) return;
    try {
        const res = await postJson('/api/save_basemaps', { basemaps: list });
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(`The server refused the basemaps: ${body.message || res.status}`, true, { ms: 8000 });
        } else if (said) showToast(said);
    } catch (e) { showToast('Saved in this browser only: the server could not be reached.', true); }
};

// The picker above the map: none, or one of the services.
const basemapOptions = () => {
    const on = activeBasemap();
    return `<option value="off"${on ? '' : ' selected'}>No basemap</option>`
        + sharedBasemaps.map(b => `<option value="${escapeHtml(b.name)}"${on && on.name === b.name ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
};

// --- The map view in the Overlays tab ---

// Built once; later renders only redraw, so the basemap isn't fetched again.
const renderOverlayMap = (box, header) => {
    if (!box.querySelector('#mapSvg')) {
        const hours = [[0, 'All'], [24, '24h'], [12, '12h'], [6, '6h']];
        box.innerHTML = `${header}
            <div class="map-tools">
                <div class="io-modes" role="group" aria-label="Map">
                    <button type="button" class="io-mode" data-map-mode="heat">Heat map</button>
                    <button type="button" class="io-mode" data-map-mode="tracks">Track map</button>
                </div>
                <div class="filter-presets" aria-label="Time window">
                    <span class="filter-presets-label">Window</span>
                    ${hours.map(([v, t]) => `<button type="button" class="filter-preset-btn" data-map-hours="${v}">${t}</button>`).join('')}
                </div>
                <select id="mapBaseSelect" class="map-base-select" aria-label="Basemap"></select>
                <button type="button" id="mapBaseEdit" class="cancel-btn editor-only">Basemaps&hellip;</button>
            </div>
            <div id="mapBaseFormSlot"></div>
            <div class="map-box" id="mapBox">
                <svg class="map-base" aria-hidden="true"><g id="mapBase"></g></svg>
                <svg id="mapSvg" class="map-svg" role="img" aria-label="Map of the overlays and reports"></svg>
                <div class="map-zoom">
                    <button type="button" data-map-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
                    <button type="button" data-map-zoom="out" title="Zoom out" aria-label="Zoom out">&minus;</button>
                    <button type="button" data-map-zoom="fit" title="Show all" aria-label="Show all">&#10530;</button>
                </div>
                <div id="mapNote" class="map-note" hidden></div>
                <div id="mapTip" class="map-tip" role="status" hidden></div>
            </div>
            <div id="mapLegend" class="map-legend"></div>`;
        wireMapBox();
    } else {
        const head = box.querySelector('.overlays-head');
        if (head) head.outerHTML = header;
    }
    box.querySelectorAll('[data-map-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapMode === mapMode)));
    box.querySelectorAll('[data-map-hours]').forEach(b => b.classList.toggle('active', +b.dataset.mapHours === mapHours));
    const pick = document.getElementById('mapBaseSelect');
    pick.innerHTML = basemapOptions();
    pick.hidden = !sharedBasemaps.length;
    // The form is rebuilt from the list, keeping whether it was open and what was being typed.
    const slot = document.getElementById('mapBaseFormSlot'), old = document.getElementById('mapBasemapForm');
    const keep = old ? { open: !old.hidden, ...Object.fromEntries(['mapBaseName', 'mapBaseKind', 'mapBaseUrl', 'mapBaseLayers'].map(id => [id, document.getElementById(id).value])) } : null;
    slot.innerHTML = basemapForm();
    if (keep) {
        document.getElementById('mapBasemapForm').hidden = !keep.open;
        ['mapBaseName', 'mapBaseKind', 'mapBaseUrl', 'mapBaseLayers'].forEach(id => { document.getElementById(id).value = keep[id]; });
    }
    redrawMap();
};

const trackTip = (t) => {
    const r = t.report, local = timeDisplayMode === 'local';
    const first = t.points[0], last = t.points[t.points.length - 1];
    const lines = [`<strong>${escapeHtml(formatFullId(r))}</strong>`, escapeHtml([r.size, r.activity].filter(Boolean).join(' · '))];
    if (t.moved) {
        lines.push(`${t.points.length} positions, ${(t.lengthM / 1000).toFixed(1)} km toward ${SaltCore.compass16(t.bearingDeg)}`);
        lines.push(`${escapeHtml(SaltCore.toTimeString(first.time, local))} to ${escapeHtml(SaltCore.toTimeString(last.time, local))}`);
    } else lines.push(`At ${escapeHtml(last.mgrs)}, ${escapeHtml(SaltCore.toTimeString(last.time, local))}`);
    return lines.join('<br>');
};

// The tab's controls, delegated from the Overlays body (wired once).
const mapBody = document.getElementById('overlaysBody');
if (mapBody) {
    mapBody.addEventListener('click', e => {
        const mode = e.target.closest('[data-map-mode]');
        if (mode) {
            mapMode = mode.dataset.mapMode;
            try { localStorage.setItem('salt_map_mode', mapMode); } catch (err) { /* this session only */ }
            renderOverlays();
            return;
        }
        const hrs = e.target.closest('[data-map-hours]');
        if (hrs) { mapHours = +hrs.dataset.mapHours; renderOverlays(); return; }
        const zoom = e.target.closest('[data-map-zoom]');
        if (zoom && mapView) {
            if (zoom.dataset.mapZoom === 'fit') mapView.mpp = Infinity;
            else mapView.mpp *= zoom.dataset.mapZoom === 'in' ? 0.5 : 2;
            redrawMap();
            return;
        }
        if (e.target.closest('#mapBaseEdit')) {
            const f = document.getElementById('mapBasemapForm');
            f.hidden = !f.hidden;
            return;
        }
        const rm = e.target.closest('[data-base-remove]');
        if (rm) {
            const gone = sharedBasemaps[+rm.dataset.baseRemove];
            if (gone) saveBasemaps(sharedBasemaps.filter(b => b !== gone), `${gone.name} removed.`);
            return;
        }
        if (e.target.closest('#mapBaseAdd')) {
            const name = document.getElementById('mapBaseName').value.trim();
            const kind = document.getElementById('mapBaseKind').value;
            const url = document.getElementById('mapBaseUrl').value.trim();
            const layers = document.getElementById('mapBaseLayers').value.trim();
            if (!name) { showToast('Give the service a name.', true); return; }
            if (sharedBasemaps.some(b => b.name.toLowerCase() === name.toLowerCase())) { showToast(`There is already a service called ${name}.`, true); return; }
            if (!/^https?:\/\//i.test(url)) { showToast('The address must start with http:// or https://.', true); return; }
            if (kind === 'tiles' && !/\{(z|TileMatrix)\}/i.test(url)) { showToast('A tile address needs {z}, {x} and {y} (or {TileMatrix}, {TileCol}, {TileRow}).', true); return; }
            ['mapBaseName', 'mapBaseUrl', 'mapBaseLayers'].forEach(id => { document.getElementById(id).value = ''; });
            // The new one is shown here at once.
            mapBaseChoice = name;
            try { localStorage.setItem('salt_map_base', name); } catch (err) { /* this session only */ }
            saveBasemaps([...sharedBasemaps, { name, kind, url, ...(layers && kind === 'wms' ? { layers } : {}) }], `${name} added for everyone.`);
        }
    });
    mapBody.addEventListener('change', e => {
        if (e.target.id === 'mapBaseSelect') {
            mapBaseChoice = e.target.value;
            mapBaseFailed = false;
            try { localStorage.setItem('salt_map_base', mapBaseChoice); } catch (err) { /* this session only */ }
            redrawMap();
        }
    });
}

// The map itself (made afresh with the view): wheel zooms around the
// pointer, dragging pans, double-click zooms in; hovering a track tells it.
const wireMapBox = () => {
    const m = mapEls();
    const at = (e) => { const r = m.box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const zoomAt = (e, factor) => {
        if (!mapView) return;
        const [x, y] = at(e), w = m.box.clientWidth, h = m.box.clientHeight;
        const mx = mapView.cx + (x - w / 2) * mapView.mpp, my = mapView.cy - (y - h / 2) * mapView.mpp;
        mapView.mpp *= factor;
        mapView.cx = mx - (x - w / 2) * mapView.mpp;
        mapView.cy = my + (y - h / 2) * mapView.mpp;
        redrawMap();
    };
    m.box.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e, e.deltaY < 0 ? 0.8 : 1.25); }, { passive: false });
    m.box.addEventListener('dblclick', e => { if (!e.target.closest('.map-zoom')) zoomAt(e, 0.5); });
    let drag = null;
    m.box.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('.map-zoom') || !mapView) return;
        drag = { x: e.clientX, y: e.clientY, cx: mapView.cx, cy: mapView.cy };
        m.box.setPointerCapture(e.pointerId);
        m.box.classList.add('dragging');
    });
    m.box.addEventListener('pointermove', e => {
        if (drag) {
            mapView.cx = drag.cx - (e.clientX - drag.x) * mapView.mpp;
            mapView.cy = drag.cy + (e.clientY - drag.y) * mapView.mpp;
            m.tip.hidden = true;
            redrawMap();
            return;
        }
        const g = e.target.closest('[data-map-item]');
        const item = g && mapItems[+g.dataset.mapItem];
        if (!item) { m.tip.hidden = true; return; }
        m.tip.innerHTML = trackTip(item.t);
        const [x, y] = at(e);
        m.tip.hidden = false;
        m.tip.style.left = `${Math.min(x + 14, m.box.clientWidth - m.tip.offsetWidth - 6)}px`;
        m.tip.style.top = `${Math.max(6, y - m.tip.offsetHeight - 10)}px`;
    });
    const end = () => { drag = null; m.box.classList.remove('dragging'); };
    m.box.addEventListener('pointerup', end);
    m.box.addEventListener('pointercancel', end);
    m.box.addEventListener('pointerleave', () => { if (!drag) m.tip.hidden = true; });
    new ResizeObserver(() => redrawMap()).observe(m.box);
};

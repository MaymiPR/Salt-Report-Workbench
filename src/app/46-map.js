// SPDX-License-Identifier: AGPL-3.0-only

// The map drawn in the Map view (app/49-mapview.js): the shared NAIs, OBJs
// and phase lines in Web Mercator, over an optional WMS or tile basemap fetched
// only for the area the graphics cover, with the shown workspace's reports as
// dots, a heat map, or tracks. Plain SVG drawn in screen pixels; no map library.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

const MAP_COLORS = { NAI: '#32d74b', OBJ: '#0a84ff', PL: '#000000', track: '#ff9f0a' };
const MAP_MODES = ['reports', 'heat', 'tracks'];
let mapMode = MAP_MODES.includes(localStorage.getItem('salt_map_mode')) ? localStorage.getItem('salt_map_mode') : 'reports';
let mapHours = 0;              // the window, in hours back from its end; 0 for all
let mapEnd = null;             // the window's end (ms), set by the time slider; null for now
let mapSelected = '';          // the report picked on the map or in its table, by id
let mapPlace = '';             // the NAI / OBJ / PL picked on the map ('NAI 1'), or ''
let mapLastDraw = null;        // what the last drawing showed: { view, tracks, reps }
let mapFlashUntil = 0;         // the picked report's ring pulses until then (ms)
let mapFitMpp = Infinity;      // metres per pixel with the whole area in view
// Set by the Map view: told after each drawing, and of a click on the map.
let mapDrawnHook = () => {};
let mapClickHook = () => {};
let mapView = null;            // { cx, cy, mpp }: centre (Web Mercator metres) and metres per pixel
// The basemap this browser shows, by name: 'off' for none, '' for the first.
let mapBaseChoice = localStorage.getItem('salt_map_base') || '';
const activeBasemap = () => (mapBaseChoice === 'off' ? null
    : sharedBasemaps.find(b => b.name === mapBaseChoice) || sharedBasemaps[0] || null);
let mapBaseFailed = false;
let mapWmsTimer = null;
let mapFrame = 0;
let mapItems = [];             // what the pointer can hover: [{ kind, ...}] by index
let mapLastWant = null;        // the Web Mercator box the basemap was last asked for

const mapEls = () => ({
    box: document.getElementById('mapBox'), svg: document.getElementById('mapSvg'),
    base: document.getElementById('mapBase'), tip: document.getElementById('mapTip'),
    note: document.getElementById('mapNote'), legend: document.getElementById('mapLegend'),
    card: document.getElementById('mapCard'),
});

// The reports the map shows: the shown workspace's, in the window (the last
// `mapHours` before its end, or all up to its end).
const mapReports = () => {
    let reps = localReports.filter(r => !r.deleted);
    const end = mapEnd;
    if (end !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() <= end);
    if (mapHours) {
        const from = (end === null ? Date.now() : end) - mapHours * 3600000;
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
    mapFitMpp = fit;
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
        mapLastDraw = { view: null, tracks, reps };
        mapDrawnHook();
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
    out.push(overlayLayer(px, w, h));
    if (mapMode === 'tracks') out.push(trackLayer(tracks, px));
    if (mapMode === 'reports') out.push(reportLayer(tracks, px));
    out.push(selectionLayer(tracks, px));
    m.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    m.svg.innerHTML = out.join('');
    m.note.hidden = !mapBaseFailed;
    if (mapBaseFailed) m.note.textContent = `The basemap service didn't answer. It may not be reachable from this computer.${isReadOnly ? '' : ' Basemaps... then Check says why.'}`;
    m.legend.innerHTML = mapLegend(reps, tracks);
    mapLastDraw = { view, tracks, reps };
    mapDrawnHook();
};
const redrawMap = () => { cancelAnimationFrame(mapFrame); mapFrame = requestAnimationFrame(drawMap); };

const pathOf = (coords, px, close) => coords.map((c, i) => { const [x, y] = px(c[0], c[1]); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + (close ? 'Z' : '');

// Where a name goes so it stays on screen as the map zooms in: a shape's
// middle, or the middle of the part of it in view; a line's end, or the middle
// of its longest stretch in view. Null when none of it is in view.
const LABEL_MARGIN = 28;
const areaLabelAt = (pts, w, h) => {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const m = LABEL_MARGIN;
    if (mid[0] >= m && mid[0] <= w - m && mid[1] >= m && mid[1] <= h - m) return mid;
    const v = [Math.max(box[0], m), Math.max(box[1], m), Math.min(box[2], w - m), Math.min(box[3], h - m)];
    return v[0] <= v[2] && v[1] <= v[3] ? [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2] : null;
};
const clipSegment = ([x0, y0], [x1, y1], [l, t, r, b]) => {
    let u0 = 0, u1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    for (const [p, q] of [[-dx, x0 - l], [dx, r - x0], [-dy, y0 - t], [dy, b - y0]]) {
        if (p === 0) { if (q < 0) return null; continue; }
        const u = q / p;
        if (p < 0) u0 = Math.max(u0, u); else u1 = Math.min(u1, u);
        if (u0 > u1) return null;
    }
    return [[x0 + u0 * dx, y0 + u0 * dy], [x0 + u1 * dx, y0 + u1 * dy]];
};
const lineLabelAt = (parts, w, h) => {
    const m = LABEL_MARGIN, view = [m, m, w - m, h - m];
    const last = parts[0][parts[0].length - 1];
    if (last[0] >= m && last[0] <= w - m && last[1] - 8 >= m && last[1] <= h - m) return [last[0], last[1] - 8];
    let best = null, len = 0;
    parts.forEach(pts => pts.slice(1).forEach((p, i) => {
        const c = clipSegment(pts[i], p, view);
        const l = c && Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
        if (c && l > len) { len = l; best = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2 - 8]; }
    }));
    return best;
};

const overlayLayer = (px, w, h) => {
    const fill = [], lines = [], labels = [];
    const label = (at, text) => at && labels.push(`<text x="${at[0].toFixed(1)}" y="${at[1].toFixed(1)}" class="map-label" text-anchor="middle">${svgEsc(text)}</text>`);
    currentOverlays().forEach(o => {
        const g = o.type === 'PL' ? o.geometry : SaltCore.asArea(o.geometry);
        const color = MAP_COLORS[o.type];
        const key = `${o.type} ${o.name}`;
        const picked = key === mapPlace;
        if (/Polygon/.test(g.type)) {
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
            const d = polys.map(rings => rings.map(r => pathOf(r, px, true)).join('')).join('');
            fill.push(`<path d="${d}" fill="${color}" fill-opacity="${picked ? 0.3 : 0.14}" stroke="${color}" stroke-width="${picked ? 4 : 2}" fill-rule="evenodd"/>`);
            label(areaLabelAt(polys[0][0].map(c => px(c[0], c[1])), w, h), key);
        } else if (/LineString/.test(g.type)) {
            const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
            const d = parts.map(l => pathOf(l, px, false)).join('');
            // Black, on a white edge, so it shows on dark imagery and on the plain background.
            lines.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`
                + `<path d="${d}" fill="none" stroke="${picked ? MAP_COLORS.track : color}" stroke-width="${picked ? 4 : 3}" stroke-linejoin="round" stroke-linecap="round"/>`);
            label(lineLabelAt(parts.map(l => l.map(c => px(c[0], c[1]))), w, h), key);
        } else if (g.type === 'Point') {
            const [x, y] = px(...g.coordinates);
            fill.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
            label([x, y - 8], key);
        }
    });
    return `<g class="map-overlays">${fill.join('')}${lines.join('')}</g><g class="map-labels">${labels.join('')}</g>`;
};

// Each report once, at its latest grid: a density surface drawn on a canvas,
// coloured with one hue from clear to bright, and laid under the graphics.
const HEAT_RADIUS = 28;
// Blue, green, yellow, red, from fewest to most. The blue end fades in from
// clear, so a lone report doesn't read as an OBJ, and it grows more opaque as
// it rises, so the busiest places stand out over imagery or the plain background.
const HEAT_STOPS = [[0, [10, 132, 255, 0]], [0.15, [10, 132, 255, 90]], [0.4, [48, 209, 88, 165]], [0.65, [255, 214, 10, 205]], [1, [255, 59, 48, 235]]];
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
        // The picked track: when it was at each position.
        if (t.moved && t.report.id === mapSelected) {
            const local = timeDisplayMode === 'local';
            pts.forEach((p, k) => {
                const d = new Date(t.points[k].time);
                if (!isNaN(d.getTime())) out.push(`<text x="${(p[0] - 7).toFixed(1)}" y="${(p[1] - 8).toFixed(1)}" class="map-label map-label-time" text-anchor="end">${svgEsc(SaltCore.clockValue(d, local).replace(':', '') + (local ? 'L' : 'Z'))}</text>`);
            });
        }
    });
    return `<g class="map-tracks">${out.join('')}</g>`;
};

// Each report as a dot at its latest grid, to click.
const reportLayer = (tracks, px) => `<g class="map-reports">${tracks.map(t => {
    const i = mapItems.push({ kind: 'report', t }) - 1;
    const p = t.points[t.points.length - 1], [x, y] = px(p.lon, p.lat);
    return `<g class="map-report" data-map-item="${i}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${MAP_COLORS.track}" stroke="#fff" stroke-width="1.5"/>`
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="transparent" class="map-hit"/></g>`;
}).join('')}</g>`;

// A ring round the picked report, in every mode.
const selectionLayer = (tracks, px) => {
    const t = mapSelected && tracks.find(x => x.report.id === mapSelected);
    if (!t) return '';
    const p = t.points[t.points.length - 1], [x, y] = px(p.lon, p.lat);
    return `<g class="map-selected${Date.now() < mapFlashUntil ? ' flash' : ''}" pointer-events="none"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="#fff" stroke-width="4"/>`
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="${MAP_COLORS.OBJ}" stroke-width="2.5"/></g>`;
};

// The key: what each colour is, and what the heat or the tracks count.
const mapLegend = (reps, tracks) => {
    const swatch = (color, line) => `<svg width="18" height="10" aria-hidden="true">${line
        ? `<line x1="1" y1="5" x2="17" y2="5" stroke="#fff" stroke-width="4"/><line x1="1" y1="5" x2="17" y2="5" stroke="${color}" stroke-width="2"/>`
        : `<rect x="1" y="1" width="16" height="8" rx="2" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1.5"/>`}</svg>`;
    const key = (inner, text) => `<span class="map-key">${inner}${text}</span>`;
    const dot = `<svg width="18" height="10" aria-hidden="true"><circle cx="9" cy="5" r="4" fill="${MAP_COLORS.track}" stroke="#fff" stroke-width="1.2"/></svg>`;
    const what = mapMode === 'heat'
        ? key('<span class="map-ramp"></span>', `Fewer to more reports (${Math.round(SaltCore.heatPoints(reps).reduce((s, p) => s + p.w, 0))}, each once, at its latest grid)`)
        : mapMode === 'reports' ? key(dot, `Report, at its latest grid (${tracks.length})`)
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
    mapLastWant = want;
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
        const url = SaltCore.wmsUrl(b.url, b.layers, want, pw, ph, b);
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

// --- Adding services ---

// Which kind the form adds; and a WMS being looked up: the link, then what its
// capabilities offer and which layers are ticked.
let baseAddKind = 'wms';
let wmsFind = null;   // { link, busy, error, title, version, getMap, formats, layers: [{ name, title, crs }], picked: Set, via }
let baseCheck = null; // { name, ok, text }: what Check found for a service

// Read a service address as text. The page asks first; a service that sends
// no CORS headers refuses that, and then the sync server asks for it.
const fetchServiceText = async (url) => {
    try {
        const res = await fetch(url, { credentials: 'omit' });
        return { http: res.status, type: res.headers.get('Content-Type') || '', text: await res.text(), via: 'this browser' };
    } catch (e) { /* refused (no CORS headers) or unreachable from here; the server tries */ }
    if (isLocalFile) throw new Error("The service won't let this page read it, and a page opened as a file has no server to ask.");
    const res = await postJson('/api/wms_fetch', { url });
    if (res.status === 401) { handleUnauthorized(); throw new Error('The access code is needed again.'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `The server answered ${res.status}.`);
    if (body.error) throw new Error(`Neither this browser nor the server could reach it (${body.error}).`);
    return { ...body, via: 'the server' };
};

// What a service's error page or exception says, as one short line.
const serviceSays = (text) => String(text || '').replace(/<\?xml[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

// A WMS's capabilities: its name, version, GetMap address, image formats, and
// every named layer with the projections it offers (its own and inherited).
const parseWmsCapabilities = (xml) => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    const notCaps = "That link didn't return WMS capabilities. Paste the service's address (for ArcGIS, the one ending in WMSServer).";
    if (!root || doc.getElementsByTagName('parsererror').length) throw new Error(notCaps);
    const exc = doc.getElementsByTagNameNS('*', 'ServiceException')[0];
    if (exc) throw new Error(`The service said: ${serviceSays(exc.textContent)}`);
    if (!/Capabilities$/.test(root.localName)) throw new Error(notCaps);
    const kids = (n, name) => (n ? [...n.children].filter(c => c.localName === name) : []);
    const text = (n, name) => ((kids(n, name)[0] || {}).textContent || '').trim();
    const cap = kids(root, 'Capability')[0];
    if (!cap) throw new Error(notCaps);
    const getMap = kids(kids(cap, 'Request')[0], 'GetMap')[0];
    const online = getMap && getMap.getElementsByTagNameNS('*', 'OnlineResource')[0];
    const href = online && (online.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || online.getAttribute('xlink:href') || '');
    const layers = [];
    const walk = (node, inherited) => {
        const crs = [...inherited, ...[...kids(node, 'CRS'), ...kids(node, 'SRS')].flatMap(e => e.textContent.trim().split(/\s+/)).filter(Boolean)];
        const name = text(node, 'Name');
        if (name && layers.length < 1000) layers.push({ name, title: text(node, 'Title') || name, crs: [...new Set(crs)] });
        kids(node, 'Layer').forEach(l => walk(l, crs));
    };
    kids(cap, 'Layer').forEach(l => walk(l, []));
    if (!layers.length) throw new Error('The service lists no layers it can draw.');
    return {
        version: /^1\.3/.test(root.getAttribute('version') || '1.3.0') ? '1.3.0' : '1.1.1',
        title: text(kids(root, 'Service')[0], 'Title'),
        getMap: /^https?:\/\//i.test(href || '') ? href : '',
        formats: kids(getMap, 'Format').map(f => f.textContent.trim()),
        layers,
    };
};

const findWmsLayers = async (link) => {
    wmsFind = { link, busy: true };
    renderMapView();
    try {
        const got = await fetchServiceText(SaltCore.wmsCapabilitiesUrl(link));
        if (got.http >= 400) throw new Error(`The service answered ${got.http}${serviceSays(got.text) ? `: ${serviceSays(got.text)}` : '.'}`);
        const caps = parseWmsCapabilities(got.text);
        // One layer is ticked to start with when there is only one.
        wmsFind = { link, ...caps, via: got.via, picked: new Set(caps.layers.length === 1 ? [caps.layers[0].name] : []) };
    } catch (e) {
        wmsFind = { link, error: e.message || String(e) };
    }
    renderMapView();
};

// A name not used yet: the service's own, then "(2)", "(3)"...
const freeBasemapName = (want) => {
    const base = (want || 'Basemap').trim().slice(0, 54) || 'Basemap';
    const taken = n => sharedBasemaps.some(b => b.name.toLowerCase() === n.toLowerCase());
    let name = base;
    for (let i = 2; taken(name); i++) name = `${base} (${i})`;
    return name;
};

const addBasemap = (entry) => {
    if (sharedBasemaps.some(b => b.name.toLowerCase() === entry.name.toLowerCase())) { showToast(`There is already a service called ${entry.name}.`, true); return false; }
    // The new one is shown here at once.
    mapBaseChoice = entry.name;
    try { localStorage.setItem('salt_map_base', entry.name); } catch (err) { /* this session only */ }
    saveBasemaps([...sharedBasemaps, entry], `${entry.name} added for everyone.`);
    return true;
};

// The ticked layers, as one service, in the projection they all offer.
const addFoundLayers = () => {
    const f = wmsFind;
    const picked = f.layers.filter(l => f.picked.has(l.name));
    if (!picked.length) { showToast('Tick the layers to add.', true); return; }
    const crs = SaltCore.pickWmsCrs(picked.map(l => l.crs));
    if (!crs) { showToast("Those layers aren't offered in Web Mercator or in latitude / longitude, so the map can't show them together.", true, { ms: 8000 }); return; }
    const layers = picked.map(l => l.name).join(',');
    if (layers.length > 2000) { showToast('Too many layers for one service; tick fewer.', true); return; }
    const typed = (document.getElementById('mapWmsName') || {}).value;
    const name = (typed || '').trim() || freeBasemapName(f.title || (picked.length === 1 ? picked[0].title : new URL(f.link).hostname));
    if (addBasemap({ name, kind: 'wms', url: f.getMap || f.link.trim(), layers, version: f.version, crs, format: SaltCore.pickWmsFormat(f.formats) })) wmsFind = null;
};

// Check: ask the service for a little of the map, the way the map does, and
// say what came back: an image, or the service's own error.
const checkBasemap = async (b) => {
    const tracks = SaltCore.reportTracks(mapReports());
    const ext = mapLastWant || mapExtent(tracks) || [...SaltCore.lonLatToMerc(-0.01, -0.01), ...SaltCore.lonLatToMerc(0.01, 0.01)];
    const url = b.kind === 'tiles'
        ? SaltCore.tileUrl(b.url, (SaltCore.tilesFor(ext, Math.min(18, SaltCore.tileZoom((ext[2] - ext[0]) / 512)), 64) || [{ z: 0, x: 0, y: 0 }])[0])
        : SaltCore.wmsUrl(b.url, b.layers, ext, 256, 256, b);
    baseCheck = { name: b.name, text: 'Asking the service...' };
    renderMapView();
    try {
        const got = await fetchServiceText(url);
        const kb = Math.max(1, Math.round((got.size || (got.text || '').length) / 1024));
        if (got.http >= 400) baseCheck = { name: b.name, text: `The service answered ${got.http}${serviceSays(got.text) ? `: ${serviceSays(got.text)}` : '.'}` };
        else if (/^image\//i.test(got.type)) {
            baseCheck = { name: b.name, ok: true, text: got.via === 'this browser'
                ? `It works: the service sent a map image (${got.type}, ${kb} KB).`
                : `The service sent the server a map image (${got.type}, ${kb} KB), so the address and layers are right. If the map stays blank, this browser can't reach the service itself (a proxy or a certificate).` };
        } else baseCheck = { name: b.name, text: `The service answered with ${got.type || 'something'} instead of an image: ${serviceSays(got.text) || '(empty)'}` };
    } catch (e) {
        baseCheck = { name: b.name, text: e.message || String(e) };
    }
    renderMapView();
};

const wmsFindHtml = () => {
    const f = wmsFind;
    if (!f) return '';
    if (f.busy) return '<div class="overlays-muted map-find-msg">Asking the service for its layers...</div>';
    if (f.error) return `<div class="map-find-msg map-find-error">${escapeHtml(f.error)}</div>
        <div class="map-form-row">
            <input type="text" id="mapWmsManualLayers" placeholder="Layer names, comma-separated, to try anyway" maxlength="2000" spellcheck="false">
            <input type="text" id="mapWmsManualName" placeholder="Name" maxlength="60" spellcheck="false">
            <button type="button" id="mapWmsManualAdd" class="cancel-btn">Add anyway</button>
        </div>`;
    const n = f.picked.size;
    return `<div class="map-find-head">
            <input type="text" id="mapWmsName" value="${escapeHtml(freeBasemapName(f.title || new URL(f.link).hostname))}" maxlength="60" spellcheck="false" aria-label="Name">
            <span class="overlays-muted">${f.layers.length} layer${f.layers.length === 1 ? '' : 's'} &middot; WMS ${f.version} &middot; read by ${escapeHtml(f.via)}</span>
        </div>
        ${f.layers.length > 10 ? '<input type="text" id="mapWmsFilter" class="map-layer-filter" placeholder="Filter layers" spellcheck="false">' : ''}
        <div class="map-layer-list">${f.layers.map((l, i) => `
            <label class="map-layer-row" data-layer-text="${escapeHtml(`${l.title} ${l.name}`.toLowerCase())}">
                <input type="checkbox" data-layer-pick="${i}"${f.picked.has(l.name) ? ' checked' : ''}>
                <span class="map-layer-title">${escapeHtml(l.title)}</span>
                <code class="map-layer-name">${escapeHtml(l.name)}</code>
                ${SaltCore.pickWmsCrs([l.crs]) ? '' : '<span class="map-layer-warn" title="Not offered in Web Mercator or latitude / longitude">can\'t show</span>'}
            </label>`).join('')}</div>
        <div class="map-form-row map-find-foot">
            <button type="button" id="mapWmsAdd" class="set-btn"${n ? '' : ' disabled'}>${n > 1 ? `Add ${n} layers as one` : n ? 'Add 1 layer' : 'Tick layers to add'}</button>
            <button type="button" id="mapWmsCancel" class="cancel-btn">Cancel</button>
        </div>`;
};

// Editors keep the list of services: each can be checked or removed. Below,
// a WMS is added from its link (its layers looked up), or a tile service by hand.
const basemapForm = () => `<div class="map-basemap-form editor-only" id="mapBasemapForm" hidden>
        <div class="map-base-list">${sharedBasemaps.map((b, i) => `
            <div class="map-base-row">
                <span class="map-base-name">${escapeHtml(b.name)}</span>
                <span class="map-base-kind">${b.kind === 'wms' ? 'WMS' : 'Tiles'}</span>
                <span class="map-base-url" title="${escapeHtml(b.url)}${b.layers ? `\n${escapeHtml(b.layers)}` : ''}">${escapeHtml(b.url)}${b.layers ? ` &middot; ${escapeHtml(b.layers)}` : ''}</span>
                <button type="button" class="cancel-btn map-base-check-btn" data-base-check="${i}">Check</button>
                <button type="button" class="overlay-remove" data-base-remove="${i}" title="Remove ${escapeHtml(b.name)}" aria-label="Remove ${escapeHtml(b.name)}">&times;</button>
            </div>${baseCheck && baseCheck.name === b.name ? `<div class="map-base-check${baseCheck.ok ? ' ok' : ''}" role="status">${escapeHtml(baseCheck.text)}</div>` : ''}`).join('') || '<div class="overlays-muted">No services yet.</div>'}</div>
        <div class="io-modes map-add-kinds" role="group" aria-label="Add">
            <button type="button" class="io-mode" data-base-add-kind="wms" aria-pressed="${baseAddKind === 'wms'}">Add WMS</button>
            <button type="button" class="io-mode" data-base-add-kind="tiles" aria-pressed="${baseAddKind === 'tiles'}">Add tiles</button>
        </div>
        ${baseAddKind === 'wms' ? `
        <div class="map-form-row">
            <input type="text" id="mapWmsLink" placeholder="The service's link, as in your other map tools" maxlength="4000" spellcheck="false" value="${escapeHtml(wmsFind ? wmsFind.link : '')}">
            <button type="button" id="mapWmsFind" class="set-btn"${wmsFind && wmsFind.busy ? ' disabled' : ''}>Find layers</button>
        </div>
        ${wmsFindHtml()}
        <div class="overlays-note">Paste the link you use in other tools (for ArcGIS, the address ending in <code>WMSServer</code>). Its layers are listed; tick the ones
            you want and they are added as one basemap, named after the service. It is drawn in Web Mercator when the service offers it,
            otherwise in latitude / longitude.</div>` : `
        <div class="map-form-row">
            <input type="text" id="mapBaseName" placeholder="Name, e.g. Imagery" maxlength="60" spellcheck="false">
            <input type="text" id="mapBaseUrl" placeholder="Tile address with {z}, {x} and {y}" maxlength="2000" spellcheck="false">
            <button type="button" id="mapBaseAdd" class="set-btn">Add</button>
        </div>
        <div class="overlays-note">An address with {z}, {x} and {y} (or WMTS's {TileMatrix}, {TileRow} and {TileCol}) in Web Mercator (GoogleMapsCompatible),
            such as an ArcGIS tile service's <code>.../MapServer/tile/{z}/{y}/{x}</code>.</div>`}
        <div class="overlays-note">Only the area of your graphics is requested. The list is shared with everyone; each person picks which one to show.</div>
    </div>`;

const saveBasemaps = async (list, said) => {
    sharedBasemaps = list;
    mapBaseFailed = false;
    storeBasemaps();
    renderMapView();
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

// --- The map's own controls ---

const FULL_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
const EXIT_FULL_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';
// Full screen: the map with its controls and key fill the screen; Esc leaves.
const toggleMapFullscreen = () => {
    const pane = document.getElementById('mapPane');
    if (!pane) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (pane.requestFullscreen) pane.requestFullscreen().catch(() => showToast('This browser would not show the map full screen.', true));
};
document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('mapFullBtn');
    if (!btn) return;
    const on = document.fullscreenElement === document.getElementById('mapPane');
    btn.innerHTML = on ? EXIT_FULL_ICON : FULL_ICON;
    btn.title = on ? 'Leave full screen (Esc)' : 'Full screen';
    btn.setAttribute('aria-label', btn.title);
    redrawMap();
});

// Built once; later renders only redraw, so the basemap isn't fetched again.
const renderOverlayMap = (box) => {
    if (!box.querySelector('#mapSvg')) {
        const hours = [[0, 'All'], [24, '24h'], [12, '12h'], [6, '6h']];
        box.innerHTML = `
            <div class="map-pane" id="mapPane">
            <div class="map-tools">
                <div class="io-modes" role="group" aria-label="Show reports as">
                    <button type="button" class="io-mode" data-map-mode="reports">Reports</button>
                    <button type="button" class="io-mode" data-map-mode="heat">Heat map</button>
                    <button type="button" class="io-mode" data-map-mode="tracks">Tracks</button>
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
                    <button type="button" data-map-zoom="full" id="mapFullBtn" title="Full screen" aria-label="Full screen">${FULL_ICON}</button>
                </div>
                <div id="mapNote" class="map-note" hidden></div>
                <div id="mapTip" class="map-tip" role="status" hidden></div>
                <div id="mapCard" class="map-card" hidden></div>
            </div>
            <div class="map-time">
                <label for="mapEndRange">Up to</label>
                <input type="range" id="mapEndRange" min="0" max="1000" step="1" value="1000" aria-label="Show reports up to this time">
                <span id="mapEndLabel" class="map-time-label"></span>
                <button type="button" id="mapEndNow" class="text-btn" hidden>Now</button>
            </div>
            <div id="mapLegend" class="map-legend"></div>
            </div>`;
        wireMapBox();
    }
    box.querySelectorAll('[data-map-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapMode === mapMode)));
    box.querySelectorAll('[data-map-hours]').forEach(b => b.classList.toggle('active', +b.dataset.mapHours === mapHours));
    const pick = document.getElementById('mapBaseSelect');
    pick.innerHTML = basemapOptions();
    pick.hidden = !sharedBasemaps.length;
    // The form is rebuilt from the list, keeping whether it was open and what was being typed.
    const slot = document.getElementById('mapBaseFormSlot'), old = document.getElementById('mapBasemapForm');
    const typed = old ? [...old.querySelectorAll('input[type="text"][id]')].map(i => [i.id, i.value]) : [];
    slot.innerHTML = basemapForm();
    if (old) {
        document.getElementById('mapBasemapForm').hidden = old.hidden;
        typed.forEach(([id, v]) => { const i = document.getElementById(id); if (i && !(id === 'mapWmsName' && !v)) i.value = v; });
        filterWmsLayers();
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

// The map's controls, delegated from the Map view (wired once).
const mapBody = document.getElementById('mapHost');
if (mapBody) {
    mapBody.addEventListener('click', e => {
        const mode = e.target.closest('[data-map-mode]');
        if (mode) {
            mapMode = mode.dataset.mapMode;
            try { localStorage.setItem('salt_map_mode', mapMode); } catch (err) { /* this session only */ }
            renderMapView();
            return;
        }
        const hrs = e.target.closest('[data-map-hours]');
        if (hrs) { mapHours = +hrs.dataset.mapHours; renderMapView(); return; }
        const zoom = e.target.closest('[data-map-zoom]');
        if (zoom && zoom.dataset.mapZoom === 'full') { toggleMapFullscreen(); return; }
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
        const check = e.target.closest('[data-base-check]');
        if (check) { const b = sharedBasemaps[+check.dataset.baseCheck]; if (b) checkBasemap(b); return; }
        const kind = e.target.closest('[data-base-add-kind]');
        if (kind) { baseAddKind = kind.dataset.baseAddKind; renderMapView(); return; }
        if (e.target.closest('#mapWmsFind')) {
            const link = document.getElementById('mapWmsLink').value.trim();
            if (!/^https?:\/\//i.test(link)) { showToast('The link must start with http:// or https://.', true); return; }
            findWmsLayers(link);
            return;
        }
        if (e.target.closest('#mapWmsAdd')) { addFoundLayers(); return; }
        if (e.target.closest('#mapWmsCancel')) { wmsFind = null; renderMapView(); return; }
        if (e.target.closest('#mapWmsManualAdd')) {
            const layers = document.getElementById('mapWmsManualLayers').value.trim();
            if (!layers) { showToast('Type the layer names to try.', true); return; }
            const name = document.getElementById('mapWmsManualName').value.trim() || freeBasemapName(new URL(wmsFind.link).hostname);
            if (addBasemap({ name, kind: 'wms', url: wmsFind.link, layers })) wmsFind = null;
            return;
        }
        if (e.target.closest('#mapBaseAdd')) {
            const name = document.getElementById('mapBaseName').value.trim();
            const url = document.getElementById('mapBaseUrl').value.trim();
            if (!name) { showToast('Give the service a name.', true); return; }
            if (!/^https?:\/\//i.test(url)) { showToast('The address must start with http:// or https://.', true); return; }
            if (!/\{(z|TileMatrix)\}/i.test(url)) { showToast('A tile address needs {z}, {x} and {y} (or {TileMatrix}, {TileCol}, {TileRow}).', true); return; }
            if (addBasemap({ name, kind: 'tiles', url })) ['mapBaseName', 'mapBaseUrl'].forEach(id => { document.getElementById(id).value = ''; });
        }
    });
    mapBody.addEventListener('input', e => { if (e.target.id === 'mapWmsFilter') filterWmsLayers(); });
    mapBody.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.id === 'mapWmsLink') { e.preventDefault(); document.getElementById('mapWmsFind').click(); }
    });
    mapBody.addEventListener('change', e => {
        const pick = e.target.closest('[data-layer-pick]');
        if (pick && wmsFind && wmsFind.layers) {
            const l = wmsFind.layers[+pick.dataset.layerPick];
            pick.checked ? wmsFind.picked.add(l.name) : wmsFind.picked.delete(l.name);
            const n = wmsFind.picked.size, btn = document.getElementById('mapWmsAdd');
            btn.disabled = !n;
            btn.textContent = n > 1 ? `Add ${n} layers as one` : n ? 'Add 1 layer' : 'Tick layers to add';
            return;
        }
        if (e.target.id === 'mapBaseSelect') {
            mapBaseChoice = e.target.value;
            mapBaseFailed = false;
            try { localStorage.setItem('salt_map_base', mapBaseChoice); } catch (err) { /* this session only */ }
            redrawMap();
        }
    });
}

// Only the layers matching what's typed in the filter.
const filterWmsLayers = () => {
    const q = ((document.getElementById('mapWmsFilter') || {}).value || '').trim().toLowerCase();
    document.querySelectorAll('.map-layer-row').forEach(r => { r.hidden = !!q && !r.dataset.layerText.includes(q); });
};

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
        if (e.button !== 0 || e.target.closest('.map-zoom, .map-card') || !mapView) return;
        drag = { x: e.clientX, y: e.clientY, cx: mapView.cx, cy: mapView.cy, item: e.target.closest('[data-map-item]') };
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
        if (!item || !m.card.hidden) { m.tip.hidden = true; return; }
        m.tip.innerHTML = trackTip(item.t);
        const [x, y] = at(e);
        m.tip.hidden = false;
        m.tip.style.left = `${Math.min(x + 14, m.box.clientWidth - m.tip.offsetWidth - 6)}px`;
        m.tip.style.top = `${Math.max(6, y - m.tip.offsetHeight - 10)}px`;
    });
    const end = () => { drag = null; m.box.classList.remove('dragging'); };
    m.box.addEventListener('pointerup', e => {
        const d = drag;
        end();
        // A press that didn't move is a click: on a report, a place, or nothing.
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
        const item = d.item && mapItems[+d.item.dataset.mapItem];
        const [x, y] = at(e), w = m.box.clientWidth, h = m.box.clientHeight;
        const merc = [mapView.cx + (x - w / 2) * mapView.mpp, mapView.cy - (y - h / 2) * mapView.mpp];
        m.tip.hidden = true;
        mapClickHook({ item, at: [x, y], lonLat: SaltCore.mercToLonLat(merc[0], merc[1]), mpp: mapView.mpp });
    });
    m.box.addEventListener('pointercancel', end);
    m.box.addEventListener('pointerleave', () => { if (!drag) m.tip.hidden = true; });
    new ResizeObserver(() => redrawMap()).observe(m.box);
};

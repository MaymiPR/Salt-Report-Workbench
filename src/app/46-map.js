// SPDX-License-Identifier: AGPL-3.0-only

// The map drawn in the Map view (app/49-mapview.js): the shared NAIs, OBJs
// and phase lines in Web Mercator, over an optional WMS or tile basemap fetched
// only for the area the graphics cover, with the shown workspace's reports in
// layers turned on and off together: a heat map, tracks, and dots. Plain SVG
// drawn in screen pixels; no map library.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

const MAP_COLORS = { NAI: '#32d74b', OBJ: '#0a84ff', PL: '#000000', track: '#ff3b30', edge: '#000000' };
// The layers on, in any mix (per browser); the heat map alone to start with.
const MAP_LAYERS = [['heat', 'Heat map'], ['tracks', 'Tracks'], ['reports', 'Reports']];
const mapLayers = (() => {
    try {
        const v = JSON.parse(localStorage.getItem('salt_map_layers') || 'null');
        if (v && typeof v === 'object') return { heat: !!v.heat, tracks: !!v.tracks, reports: !!v.reports };
    } catch (e) { /* unreadable: the default */ }
    return { heat: true, tracks: false, reports: false };
})();
// The heat map and the dots: each report at its latest grids, or every saved
// report (its updates too) at its grids. Per browser.
let mapAllGrids = localStorage.getItem('salt_map_grids') === 'all';
let mapActivity = new Set();   // the activity tags picked; none for every report
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
    card: document.getElementById('mapCard'), hint: document.getElementById('mapHint'),
});

// The shown workspace's reports in the window (the last `mapHours` before its
// end, or all up to its end).
const mapWindowReports = () => {
    let reps = localReports.filter(r => !r.deleted);
    const end = mapEnd;
    if (end !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() <= end);
    if (mapHours) {
        const from = (end === null ? Date.now() : end) - mapHours * 3600000;
        reps = reps.filter(r => r.time && new Date(r.time).getTime() >= from);
    }
    return reps;
};
// The reports the map shows: those, with a picked activity, that the
// Report Log's search finds.
const mapReports = () => {
    const q = el.log.search.value.toLowerCase();
    return mapWindowReports().filter(r => SaltCore.activityMatches(r.activity, mapActivity) && matchesSearch(r, q));
};

// The area the map covers: the overlays and the reports' grids, padded so
// that, zoomed all the way out, they clear the controls along the top and the
// key and slider along the foot (more room above and below than at the
// sides). The basemap is asked for this area only. Null when there is
// nothing to show.
const mapExtent = (tracks) => {
    const pts = [];
    const walk = v => (typeof v[0] === 'number' ? pts.push(SaltCore.lonLatToMerc(v[0], v[1])) : v.forEach(walk));
    currentOverlays().forEach(o => o.geometry && walk(o.geometry.coordinates));
    tracks.forEach(t => t.points.forEach(p => pts.push(SaltCore.lonLatToMerc(p.lon, p.lat))));
    // A drone with room round it, so Zoom can put it in the middle.
    shownDrones().forEach(({ p: d }) => { const [x, y] = SaltCore.lonLatToMerc(d.lon, d.lat); pts.push([x - 3000, y - 3000], [x + 3000, y + 3000]); });
    if (!pts.length) return null;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const span = Math.max(x1 - x0, y1 - y0, 1000);
    const padX = span * 0.15, padY = span * 0.28;
    return [x0 - padX, y0 - padY, x1 + padX, y1 + padY];
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

// --- Drones ---

// Where each drone was last put (shared; editors move it). Whether they show,
// and whether their view does, is each browser's own choice.
let droneShow = localStorage.getItem('salt_drone_show') !== 'off';
let droneView = localStorage.getItem('salt_drone_view') !== 'off';
const DRONE_COLOR = '#ff9f0a';
const dronePoint = (d) => { const g = SaltCore.findGrids(d.grid)[0]; return g ? { lon: g.lon, lat: g.lat } : null; };
const shownDrones = () => (droneShow ? sharedDrones.map(d => ({ d, p: dronePoint(d) })).filter(x => x.p) : []);
// A grid as the drones keep it ("11S NV 39697 06762"), from what was typed:
// digits alone take MGRS Lock's zone and square. Null when it isn't one.
const droneGrid = (text) => { const g = SaltCore.findGrids(lockedLocation(String(text || '').trim()))[0]; return g ? g.mgrs : null; };
// Where a drone is looking, when it's been given a grid to look at; without
// one, its view follows the newest report.
const lookPoint = (d) => { const g = d.look ? SaltCore.findGrids(d.look)[0] : null; return g ? { lon: g.lon, lat: g.lat } : null; };
const DRONE_OUT = '#ff453a';   // a view past the drone's range
const droneTip = (d) => {
    const local = timeDisplayMode === 'local';
    return `<strong>${escapeHtml(d.name)}</strong><br>${escapeHtml(d.grid)}<br>Put there ${escapeHtml(SaltCore.toTimeString(new Date(d.at).toISOString(), local))}`
        + (d.look ? `<br>Looking at ${escapeHtml(d.look)}` : '') + (d.range ? `<br>Range ${d.range} km` : '');
};

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
    if (mapLayers.heat) out.push(heatLayer(reps, px, w, h));
    const drones = droneLayer(tracks, px);
    out.push(drones.view);
    out.push(overlayLayer(px, w, h));
    if (mapLayers.tracks) out.push(trackLayer(tracks, px));
    if (mapLayers.reports) out.push(reportLayer(reps, tracks, px));
    out.push(selectionLayer(tracks, px));
    out.push(drones.marks);
    m.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    m.svg.innerHTML = out.join('');
    m.note.hidden = !mapBaseFailed;
    if (mapBaseFailed) m.note.textContent = `The basemap service didn't answer. It may not be reachable from this computer.${isReadOnly ? '' : ' Check, in Manage > Map, says why.'}`;
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
    const pts = SaltCore.heatPoints(reps, mapAllGrids).map(p => ({ xy: px(p.lon, p.lat), w: p.w }))
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
// gives a heading), unless the Reports layer already shows it.
const trackLayer = (tracks, px) => {
    const color = MAP_COLORS.track, out = [];
    const arrow = (x, y, deg, size) => {
        const a = deg * Math.PI / 180, s = size;
        const tip = [x + Math.sin(a) * s * 0.6, y - Math.cos(a) * s * 0.6];
        const l = [x + Math.sin(a - 2.5) * s * 0.6, y - Math.cos(a - 2.5) * s * 0.6];
        const r = [x + Math.sin(a + 2.5) * s * 0.6, y - Math.cos(a + 2.5) * s * 0.6];
        return `<path d="M${tip.map(v => v.toFixed(1))}L${l.map(v => v.toFixed(1))}L${r.map(v => v.toFixed(1))}Z" fill="${color}" stroke="${MAP_COLORS.edge}" stroke-width="1.2" stroke-linejoin="round"/>`;
    };
    // Names on the tracks that moved, while they stay readable; hover tells the rest.
    const labelled = tracks.filter(t => t.moved).length <= 25;
    tracks.forEach(t => {
        if (!t.moved && mapLayers.reports) return;
        const i = mapItems.push({ kind: 'track', t }) - 1;
        const pts = t.points.map(p => px(p.lon, p.lat));
        const [ex, ey] = pts[pts.length - 1];
        if (t.moved) {
            const d = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
            const [ax, ay] = pts[pts.length - 2];
            const deg = Math.atan2(ex - ax, ay - ey) * 180 / Math.PI;
            out.push(`<g class="map-track" data-map-item="${i}">`
                + `<path d="${d}" fill="none" stroke="${MAP_COLORS.edge}" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/>`
                + `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`
                + `<circle cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="3.5" fill="${MAP_COLORS.edge}" stroke="${color}" stroke-width="2"/>`
                + pts.slice(1, -1).map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${color}"/>`).join('')
                + arrow(ex, ey, deg, 16)
                + `<path d="${d}" fill="none" stroke="transparent" stroke-width="14" class="map-hit"/></g>`);
        } else {
            const act = SaltCore.classifyActivity(t.report.activity);
            out.push(`<g class="map-track" data-map-item="${i}">`
                + (act.headingDeg !== null ? arrow(ex + Math.sin(act.headingDeg * Math.PI / 180) * 9, ey - Math.cos(act.headingDeg * Math.PI / 180) * 9, act.headingDeg, 11) : '')
                + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4.5" fill="${color}" stroke="${MAP_COLORS.edge}" stroke-width="1.5"/>`
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

// Each report as a dot at its latest grids, to click; with every saved report,
// its earlier positions too, smaller and fainter, under the latest.
const reportLayer = (reps, tracks, px) => {
    const byId = new Map(tracks.map(t => [t.report.id, t]));
    const pts = SaltCore.reportPositions(reps, mapAllGrids).filter(p => byId.has(p.report.id))
        .sort((a, b) => a.latest - b.latest);
    return `<g class="map-reports">${pts.map(p => {
        const i = mapItems.push({ kind: 'report', t: byId.get(p.report.id) }) - 1;
        const [x, y] = px(p.lon, p.lat);
        return `<g class="map-report${p.latest ? '' : ' map-report-old'}" data-map-item="${i}">`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.latest ? 5 : 3.5}" fill="${MAP_COLORS.track}" stroke="${MAP_COLORS.edge}" stroke-width="${p.latest ? 1.5 : 1}"${p.latest ? '' : ' opacity="0.6"'}/>`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.latest ? 11 : 7}" fill="transparent" class="map-hit"/></g>`;
    }).join('')}</g>`;
};

// Each drone, pointing where it's looking: with its view on, a cone from the
// drone to the grid it was given to look at, else to the newest report on the
// map, narrow at the drone and widening to a round end (where it's looking,
// not the camera's footprint, which we don't know), with the sightline down
// its middle, a box round the target, and the distance and direction. With a
// range, a faint ring shows it, and a target past it turns the view red.
const droneLayer = (tracks, px) => {
    const list = shownDrones();
    if (!list.length) return { view: '', marks: '' };
    const last = t => t.points[t.points.length - 1];
    const when = t => new Date(last(t).time).getTime() || 0;
    const newest = droneView && tracks.length ? tracks.reduce((a, b) => (when(b) > when(a) ? b : a)) : null;
    const defs = [], cones = [], marks = [];
    list.forEach(({ d, p }, i) => {
        const [x, y] = px(p.lon, p.lat);
        let angle = 0;
        // Its range, as a ring: metres on the ground to pixels at its latitude.
        if (droneView && d.range && mapView) {
            const r = d.range * 1000 / (mapView.mpp * Math.cos(p.lat * Math.PI / 180));
            cones.push(`<circle class="map-drone-range" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${DRONE_COLOR}" fill-opacity="0.025" stroke="${DRONE_COLOR}" stroke-opacity="0.6" stroke-width="1.3" stroke-dasharray="3 4"/>`);
            if (r > 36) marks.push(`<text x="${x.toFixed(1)}" y="${(y - r - 5).toFixed(1)}" text-anchor="middle" class="map-label map-label-drone">${d.range} km</text>`);
        }
        const q = droneView ? lookPoint(d) || (newest && last(newest)) : null;
        if (q) {
            const [tx, ty] = px(q.lon, q.lat);
            const dx = tx - x, dy = ty - y, len = Math.hypot(dx, dy);
            if (len > 16) {
                angle = Math.atan2(dx, -dy) * 180 / Math.PI;
                // The end: a circle round the report, wide enough for its box.
                const hw = Math.min(28, Math.max(13, len * 0.09));
                const nx = -dy / len * hw, ny = dx / len * hw;
                const f = v => v.toFixed(1);
                // The sides run from the drone to just touch that circle, so they
                // flow into its far side with no corner (a teardrop). They touch it
                // at an angle t from the drone's side of the circle: cos t = r / d.
                const t = Math.acos(Math.min(1, hw / len)), wx = -dx / len, wy = -dy / len;
                const touch = s => [tx + hw * (wx * Math.cos(s * t) - wy * Math.sin(s * t)), ty + hw * (wx * Math.sin(s * t) + wy * Math.cos(s * t))];
                const [p1, p2] = [touch(1), touch(-1)];
                // The distance beside the cone, half way, clear of its edge.
                const ox = nx / hw, oy = ny / hw, gap = hw * 0.5 + 9;
                const lx = (x + tx) / 2 + ox * gap, ly = (y + ty) / 2 + oy * gap + 4;
                const anchor = ox < -0.3 ? 'end' : ox > 0.3 ? 'start' : 'middle';
                const metres = SaltCore.metresBetween(p, q);
                const km = (metres / 1000).toFixed(1);
                const dir = SaltCore.compass16(SaltCore.bearingBetween(p, q));
                const out = d.range ? metres - d.range * 1000 : 0;   // past its range, in metres
                const color = out > 0 ? DRONE_OUT : DRONE_COLOR;
                defs.push(`<linearGradient id="droneCone${i}" gradientUnits="userSpaceOnUse" x1="${f(x)}" y1="${f(y)}" x2="${f(tx)}" y2="${f(ty)}">`
                    + `<stop offset="0" stop-color="${color}" stop-opacity="0.16"/><stop offset="1" stop-color="${color}" stop-opacity="0.42"/></linearGradient>`);
                // Edged in its colour, and the dashed sightline over a dark one, so
                // they hold on a light basemap or a busy heat map.
                // From one touching point the long way round the far side to the
                // other (clockwise on screen, more than half the circle).
                cones.push(`<path class="map-drone-cone${out > 0 ? ' out' : ''}" d="M${f(x)},${f(y)} L${f(p1[0])},${f(p1[1])} A${f(hw)},${f(hw)} 0 1 1 ${f(p2[0])},${f(p2[1])} Z" fill="url(#droneCone${i})" stroke="${color}" stroke-opacity="0.85" stroke-width="1.2" stroke-linejoin="round"/>`
                    + `<line x1="${f(x)}" y1="${f(y)}" x2="${f(tx)}" y2="${f(ty)}" stroke="#000" stroke-width="4" stroke-opacity="0.7" stroke-dasharray="8 5"/>`
                    + `<line x1="${f(x)}" y1="${f(y)}" x2="${f(tx)}" y2="${f(ty)}" stroke="${color}" stroke-width="2.2" stroke-dasharray="8 5"/>`
                    + `<rect x="${f(tx - 9)}" y="${f(ty - 9)}" width="18" height="18" rx="2" fill="none" stroke="${color}" stroke-width="2.4"/>`);
                // On top, with the drones, so no graphic hides it.
                // Past its range: how far, on a second line, so the label stays short.
                const said = out > 0 ? `${km} km ${dir}<tspan x="${f(lx)}" dy="13">${(out / 1000).toFixed(1)} km out of range</tspan>` : `${km} km ${dir}`;
                marks.push(`<text x="${f(lx)}" y="${f(ly)}" text-anchor="${anchor}" class="map-label map-label-drone${out > 0 ? ' map-label-out' : ''}">${said}</text>`);
            }
        }
        const k = mapItems.push({ kind: 'drone', d }) - 1;
        marks.push(`<g class="map-drone" data-map-item="${k}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">`
            + `<g transform="rotate(${angle.toFixed(0)})"><path d="M0,-10 L2.2,-3 L10,0.5 L10,2.6 L2.2,1.4 L1.6,6.5 L4.4,8.6 L4.4,10 L0,8.8 L-4.4,10 L-4.4,8.6 L-1.6,6.5 L-2.2,1.4 L-10,2.6 L-10,0.5 L-2.2,-3 Z" fill="${DRONE_COLOR}" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></g>`
            + `<circle r="14" fill="transparent" class="map-hit"/>`
            + `<text x="14" y="-10" class="map-label map-label-drone">${svgEsc(d.name)}</text></g>`);
    });
    // The view goes under the graphics and reports (their names stay readable);
    // the drones themselves go on top.
    return {
        view: `<g class="map-drones map-drone-view" pointer-events="none"><defs>${defs.join('')}</defs>${cones.join('')}</g>`,
        marks: `<g class="map-drones">${marks.join('')}</g>`,
    };
};

// A ring round the picked report, in every mode.
const selectionLayer = (tracks, px) => {
    const t = mapSelected && tracks.find(x => x.report.id === mapSelected);
    if (!t) return '';
    const p = t.points[t.points.length - 1], [x, y] = px(p.lon, p.lat);
    return `<g class="map-selected${Date.now() < mapFlashUntil ? ' flash' : ''}" pointer-events="none"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="#fff" stroke-width="4"/>`
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="${MAP_COLORS.OBJ}" stroke-width="2.5"/></g>`;
};

// The key: what each colour is, and what each layer that's on counts.
const mapLegend = (reps, tracks) => {
    const swatch = (color, line) => `<svg width="18" height="10" aria-hidden="true">${line
        ? `<line x1="1" y1="5" x2="17" y2="5" stroke="#fff" stroke-width="4"/><line x1="1" y1="5" x2="17" y2="5" stroke="${color}" stroke-width="2"/>`
        : `<rect x="1" y="1" width="16" height="8" rx="2" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1.5"/>`}</svg>`;
    const key = (inner, text) => `<span class="map-key">${inner}${text}</span>`;
    const dot = `<svg width="18" height="10" aria-hidden="true"><circle cx="9" cy="5" r="4" fill="${MAP_COLORS.track}" stroke="${MAP_COLORS.edge}" stroke-width="1.2"/></svg>`;
    const trackLine = `<svg width="18" height="10" aria-hidden="true"><line x1="1" y1="5" x2="17" y2="5" stroke="${MAP_COLORS.edge}" stroke-width="4.5"/><line x1="1" y1="5" x2="17" y2="5" stroke="${MAP_COLORS.track}" stroke-width="2.2"/></svg>`;
    const heat = Math.round(SaltCore.heatPoints(reps, mapAllGrids).reduce((s, p) => s + p.w, 0));
    const what = [
        mapLayers.heat && key('<span class="map-ramp"></span>', mapAllGrids
            ? `Fewer to more reports (${heat}, every saved report, updates included)`
            : `Fewer to more reports (${heat}, each once, at its latest grid)`),
        mapLayers.tracks && key(trackLine, `Track, first to latest (${tracks.filter(t => t.moved).length} moved${mapLayers.reports ? '' : `, ${tracks.filter(t => !t.moved).length} at one grid`})`),
        shownDrones().length && key('<svg width="18" height="10" aria-hidden="true"><path d="M9,0.5 L10.2,3.6 L14.5,5.3 L14.5,6.4 L10.2,5.8 L9.9,8.4 L11.3,9.5 L6.7,9.5 L8.1,8.4 L7.8,5.8 L3.5,6.4 L3.5,5.3 L7.8,3.6 Z" fill="#ff9f0a" stroke="#000" stroke-width="0.8"/></svg>',
            droneView ? 'Drone, and its view' : 'Drone'),
        mapLayers.reports && key(dot, mapAllGrids
            ? `Report, every saved one (${SaltCore.reportPositions(reps, true).length} positions; earlier ones smaller)`
            : `Report, at its latest grid (${tracks.length})`),
    ].filter(Boolean);
    return key(swatch(MAP_COLORS.NAI), 'NAI') + key(swatch(MAP_COLORS.OBJ), 'OBJ') + key(swatch(MAP_COLORS.PL, true), 'PL')
        + (what.length ? what.join('') : '<span class="map-key">Turn on a layer above to see the reports.</span>');
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
    // An HTTPS page can't load images from an http:// basemap, so those come
    // through the sync server, which fetches them from that saved host.
    const src = (url) => (location.protocol === 'https:' && /^http:\/\//i.test(url) ? '/api/basemap?u=' + encodeURIComponent(url) : url);
    const have = new Map([...m.base.children].map(el => [el.dataset.url, el]));
    // The note that the service didn't answer: only when nothing in view came
    // back. A service often has no tile for part of an area (or drops one), and
    // those few gaps aren't the service failing.
    const settle = (img, ok) => {
        img.dataset.state = ok ? 'ok' : 'error';
        const imgs = [...m.base.children];
        const failed = !!imgs.length && imgs.every(i => i.dataset.state === 'error');
        if (failed !== mapBaseFailed && (failed || imgs.some(i => i.dataset.state === 'ok'))) { mapBaseFailed = failed; redrawMap(); }
    };
    const add = (url, box) => {
        let img = have.get(url);
        if (!img) {
            img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            img.dataset.url = url;
            img.dataset.box = box.join(',');
            img.setAttribute('preserveAspectRatio', 'none');
            img.addEventListener('error', () => settle(img, false));
            img.addEventListener('load', () => settle(img, true));
            img.setAttribute('href', src(url));
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
            settle(img, true);
        });
        // A view that didn't come back leaves the last one on screen: a failure
        // only when there's nothing else to show.
        img.addEventListener('error', () => {
            if ([...m.base.children].some(el => el !== img && el.dataset.state === 'ok')) img.remove();
            else settle(img, false);
        });
        img.setAttribute('href', src(url));
        place(img, want);
        m.base.appendChild(img);
    }, 300);
};

// --- Adding services ---

// A WMS being looked up: the link (and a name typed for it), then what its
// capabilities offer and which layers are ticked. `edit` names the saved
// service whose layers these are (null when adding one).
let wmsFind = null;   // { link, edit, busy, error, title, version, getMap, formats, layers: [{ name, title, crs, missing }], picked: Set, via }
let baseCheck = null; // { name, ok, text }: what Check found for a service
let baseOpen = null;  // the saved service whose details are open, by name
let baseRemoving = false; // its Remove has asked "for everyone?"

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

const findWmsLayers = async (link, name = '', edit = null) => {
    const asked = wmsFind = { link, name, edit, busy: true };
    basemapsChanged();
    let found;
    try {
        const got = await fetchServiceText(SaltCore.wmsCapabilitiesUrl(link));
        if (got.http >= 400) throw new Error(`The service answered ${got.http}${serviceSays(got.text) ? `: ${serviceSays(got.text)}` : '.'}`);
        const caps = parseWmsCapabilities(got.text);
        // One layer is ticked to start with when there is only one; a saved
        // service's own layers when changing it, those the service no longer
        // lists included (first, so none is dropped unseen).
        const saved = edit ? (sharedBasemaps.find(b => b.name === edit) || {}) : null;
        const keep = saved ? String(saved.layers || '').split(',').map(s => s.trim()).filter(Boolean) : [];
        const gone = keep.filter(n => !caps.layers.some(l => l.name === n)).map(n => ({ name: n, title: n, crs: [saved.crs || 'EPSG:3857'], missing: true }));
        found = { link, name, edit, ...caps, layers: [...gone, ...caps.layers], via: got.via,
            picked: new Set(saved ? keep : caps.layers.length === 1 ? [caps.layers[0].name] : []) };
    } catch (e) {
        found = { link, name, edit, error: e.message || String(e) };
    }
    // Cancelled, or another lookup started, while this one was out.
    if (wmsFind !== asked) return;
    wmsFind = found;
    basemapsChanged();
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

// A saved service changed (its layers, name or address), in its place in the list.
const replaceBasemap = (oldName, entry) => {
    if (sharedBasemaps.some(b => b.name !== oldName && b.name.toLowerCase() === entry.name.toLowerCase())) { showToast(`There is already a service called ${entry.name}.`, true); return false; }
    // Renamed: still the one shown here.
    if (mapBaseChoice === oldName && entry.name !== oldName) {
        mapBaseChoice = entry.name;
        try { localStorage.setItem('salt_map_base', entry.name); } catch (err) { /* this session only */ }
    }
    if (baseCheck && baseCheck.name === oldName) baseCheck = null;
    wmsFind = null; baseOpen = null; baseRemoving = false;
    saveBasemaps(sharedBasemaps.map(b => (b.name === oldName ? entry : b)), `${entry.name} saved for everyone.`);
    return true;
};

// The service whose details are open: removed for everyone, on the second press.
const removeOpenBasemap = () => {
    const gone = sharedBasemaps.find(b => b.name === baseOpen);
    if (!gone) return;
    if (!baseRemoving) { baseRemoving = true; basemapsChanged(); return; }
    if (baseCheck && baseCheck.name === gone.name) baseCheck = null;
    wmsFind = null; baseOpen = null; baseRemoving = false;
    saveBasemaps(sharedBasemaps.filter(b => b !== gone), `${gone.name} removed.`);
};

// The ticked layers, as one service, in the projection they all offer: added,
// or saved over the service they were opened from.
const addFoundLayers = () => {
    const f = wmsFind;
    const picked = f.layers.filter(l => f.picked.has(l.name));
    if (!picked.length) { showToast(f.edit ? 'Tick the layers to keep, or Remove the service.' : 'Tick the layers to add.', true); return; }
    const crs = SaltCore.pickWmsCrs(picked.map(l => l.crs));
    if (!crs) { showToast("Those layers aren't offered in Web Mercator or in latitude / longitude, so the map can't show them together.", true, { ms: 8000 }); return; }
    const layers = picked.map(l => l.name).join(',');
    if (layers.length > 2000) { showToast('Too many layers for one service; tick fewer.', true); return; }
    // Named for itself: the service's title (else the one layer's, or its host); a saved one keeps its name.
    const name = f.edit || freeBasemapName(f.title || (picked.length === 1 ? picked[0].title : new URL(f.link).hostname));
    const entry = { name, kind: 'wms', url: f.getMap || f.link.trim(), layers, version: f.version, crs, format: SaltCore.pickWmsFormat(f.formats) };
    if (!(f.edit ? replaceBasemap(f.edit, entry) : addBasemap(entry))) return false;
    wmsFind = null;
    return true;
};
// Empty the add box once a service is in (the form was redrawn with what was typed).
const clearBaseInputs = () => { const i = document.getElementById('mapBaseInput'); if (i) i.value = ''; };

// Check: ask the service for a little of the map, the way the map does, and
// say what came back: an image, or the service's own error.
const checkBasemap = async (b) => {
    const tracks = SaltCore.reportTracks(mapReports());
    const ext = mapLastWant || mapExtent(tracks) || [...SaltCore.lonLatToMerc(-0.01, -0.01), ...SaltCore.lonLatToMerc(0.01, 0.01)];
    const url = b.kind === 'tiles'
        ? SaltCore.tileUrl(b.url, (SaltCore.tilesFor(ext, Math.min(18, SaltCore.tileZoom((ext[2] - ext[0]) / 512)), 64) || [{ z: 0, x: 0, y: 0 }])[0])
        : SaltCore.wmsUrl(b.url, b.layers, ext, 256, 256, b);
    baseCheck = { name: b.name, text: 'Asking the service...' };
    basemapsChanged();
    try {
        const got = await fetchServiceText(url);
        const kb = Math.max(1, Math.round((got.size || (got.text || '').length) / 1024));
        if (got.http >= 400) baseCheck = { name: b.name, text: `The service answered ${got.http}${serviceSays(got.text) ? `: ${serviceSays(got.text)}` : '.'}` };
        else if (/^image\//i.test(got.type)) {
            baseCheck = { name: b.name, ok: true, text: got.via === 'this browser' || (location.protocol === 'https:' && /^http:\/\//i.test(b.url))
                ? `It works: the service sent a map image (${got.type}, ${kb} KB).`
                : `The service sent the server a map image (${got.type}, ${kb} KB), so the address and layers are right. If the map stays blank, this browser can't reach the service itself (a proxy or a certificate).` };
        } else baseCheck = { name: b.name, text: `The service answered with ${got.type || 'something'} instead of an image: ${serviceSays(got.text) || '(empty)'}` };
    } catch (e) {
        baseCheck = { name: b.name, text: e.message || String(e) };
    }
    basemapsChanged();
    if (baseCheck.ok) {
        const done = baseCheck;
        setTimeout(() => { if (baseCheck === done) fadeBaseCheck(); }, BASE_CHECK_MS);
    }
};
const BASE_CHECK_MS = 4000;
// The Check message folds away (and is forgotten, so a redraw doesn't bring it back).
const fadeBaseCheck = () => {
    baseCheck = null;
    document.querySelectorAll('.map-base-check').forEach(m => {
        m.style.height = `${m.offsetHeight}px`;
        void m.offsetHeight;
        m.classList.add('fading');
        setTimeout(() => m.remove(), 350);
    });
};

const wmsFindHtml = () => {
    const f = wmsFind;
    if (!f) return '';
    if (f.busy) return '<div class="overlays-muted map-find-msg">Asking the service for its layers...</div>';
    const saved = f.edit ? sharedBasemaps.find(b => b.name === f.edit) : null;
    if (f.error) return `<div class="map-find-msg map-find-error">${escapeHtml(f.error)}</div>
        <div class="map-form-row">
            <input type="text" id="mapWmsManualLayers" placeholder="Layer names, comma-separated, to try anyway" maxlength="2000" spellcheck="false" value="${escapeHtml(saved ? saved.layers || '' : '')}">
            <button type="button" id="mapWmsManualAdd" class="${saved ? 'set-btn' : 'cancel-btn'}">${saved ? 'Save' : 'Add anyway'}</button>
        </div>${saved ? baseEditFoot('') : ''}`;
    const n = f.picked.size;
    return `<div class="map-find-head">
            <strong class="map-find-name">${escapeHtml(f.edit || freeBasemapName(f.title || new URL(f.link).hostname))}</strong>
            <span class="overlays-muted">${f.layers.length} layer${f.layers.length === 1 ? '' : 's'} &middot; WMS ${f.version} &middot; read by ${escapeHtml(f.via)}</span>
        </div>
        ${f.layers.length > 10 ? '<input type="text" id="mapWmsFilter" class="map-layer-filter" placeholder="Filter layers" spellcheck="false">' : ''}
        <div class="map-layer-list">${f.layers.map((l, i) => `
            <label class="map-layer-row" data-layer-text="${escapeHtml(`${l.title} ${l.name}`.toLowerCase())}">
                <input type="checkbox" data-layer-pick="${i}"${f.picked.has(l.name) ? ' checked' : ''}>
                <span class="map-layer-title">${escapeHtml(l.title)}</span>
                <code class="map-layer-name">${escapeHtml(l.name)}</code>
                ${l.missing ? '<span class="map-layer-warn" title="The service no longer lists this layer">not listed</span>'
                    : SaltCore.pickWmsCrs([l.crs]) ? '' : '<span class="map-layer-warn" title="Not offered in Web Mercator or latitude / longitude">can\'t show</span>'}
            </label>`).join('')}</div>
        ${saved ? baseEditFoot(`<button type="button" id="mapWmsAdd" class="set-btn"${n ? '' : ' disabled'}>${wmsPickLabel(n, true)}</button>`)
            : `<div class="map-form-row map-find-foot">
            <button type="button" id="mapWmsAdd" class="set-btn"${n ? '' : ' disabled'}>${wmsPickLabel(n, false)}</button>
            <button type="button" id="mapWmsCancel" class="cancel-btn">Cancel</button>
        </div>`}`;
};
const wmsPickLabel = (n, edit) => (edit ? (n ? 'Save' : 'Tick layers to keep')
    : n > 1 ? `Add ${n} layers as one` : n ? 'Add 1 layer' : 'Tick layers to add');

// Under a saved service: Save, Cancel and, on the far side, Remove (which asks first).
const baseEditFoot = (save) => `<div class="map-form-row map-find-foot">
            ${save}
            <button type="button" class="cancel-btn" data-base-close>Cancel</button>
            <button type="button" id="mapBaseRemove" class="text-btn map-base-remove${baseRemoving ? ' sure' : ''}">${baseRemoving ? 'Remove for everyone?' : 'Remove'}</button>
        </div>`;

// A saved service's details: a WMS's layers (looked up again), or a tile
// service's address.
const baseDetailHtml = (b) => {
    if (b.kind === 'wms') return wmsFind && wmsFind.edit === b.name ? `<div class="map-base-detail">${wmsFindHtml()}</div>` : '';
    return `<div class="map-base-detail">
            <div class="map-form-row">
                <input type="text" id="mapTileUrl" value="${escapeHtml(b.url)}" maxlength="4000" spellcheck="false" aria-label="Tile address">
            </div>
            ${baseEditFoot('<button type="button" id="mapTileSave" class="set-btn">Save</button>')}
        </div>`;
};

// Editors keep the list of services (each can be checked, or opened to change
// its layers or address, or remove it), and add one by pasting its address: a
// WMS link, whose layers are then looked up, or a tile address with {z}, {x}
// and {y}. Each is named for itself: a WMS by its title, tiles by their host.
// It lives in Manage > Map; the map's own basemap button only switches.
const basemapForm = () => {
    // Removed (here or by someone else) while open: closed.
    if (baseOpen && !sharedBasemaps.some(b => b.name === baseOpen)) {
        baseOpen = null; baseRemoving = false;
        if (wmsFind && wmsFind.edit) wmsFind = null;
    }
    const adding = wmsFind && !wmsFind.edit ? wmsFind : null;
    return `<div class="map-basemap-form editor-only" id="mapBasemapForm" data-open="${escapeHtml(baseOpen || '')}">
        ${sharedBasemaps.length ? `<div class="map-base-list">${sharedBasemaps.map((b, i) => `
            <div class="map-base-row${baseOpen === b.name ? ' open' : ''}">
                <span class="map-base-name" title="${escapeHtml(b.url)}${b.layers ? `\n${escapeHtml(b.layers)}` : ''}">${escapeHtml(b.name)}</span>
                <span class="map-base-kind">${b.kind === 'wms' ? 'WMS' : 'Tiles'}</span>
                <button type="button" class="text-btn" data-base-check="${i}">Check</button>
                <button type="button" class="text-btn" data-base-open="${i}" aria-expanded="${baseOpen === b.name}">${b.kind === 'wms' ? 'Layers' : 'Edit'}</button>
            </div>${baseCheck && baseCheck.name === b.name ? `<div class="map-base-check${baseCheck.ok ? ' ok' : ''}" role="status">${escapeHtml(baseCheck.text)}</div>` : ''}${baseOpen === b.name ? baseDetailHtml(b) : ''}`).join('')}</div>` : ''}
        <div class="map-form-row map-base-add">
            <input type="text" id="mapBaseInput" placeholder="WMS link or tile address" maxlength="4000" spellcheck="false" value="${escapeHtml(adding ? adding.link : '')}" aria-label="WMS link or tile address">
            <button type="button" id="mapBaseAddBtn" class="set-btn"${adding && adding.busy ? ' disabled' : ''}>Add</button>
        </div>
        ${adding ? wmsFindHtml() : ''}
        <div class="map-base-hint">Shared with everyone. A tile address has {z}, {x} and {y}.</div>
    </div>`;
};

// The form, rebuilt from the list, keeping what was being typed.
const renderBasemapManager = () => {
    const slot = document.getElementById('mapBaseFormSlot');
    if (!slot) return;
    const old = document.getElementById('mapBasemapForm');
    const same = old && old.dataset.open === (baseOpen || '');
    const typed = old ? [...old.querySelectorAll('input[type="text"][id]')].filter(i => same || i.closest('.map-base-add')).map(i => [i.id, i.value]) : [];
    slot.innerHTML = basemapForm();
    typed.forEach(([id, v]) => { const i = document.getElementById(id); if (i) i.value = v; });
    filterWmsLayers();
};
const basemapsChanged = () => { renderBasemapManager(); renderMapView(); };

const saveBasemaps = async (list, said) => {
    sharedBasemaps = list;
    mapBaseFailed = false;
    storeBasemaps();
    basemapsChanged();
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
            <div class="map-box" id="mapBox">
                <svg class="map-base" aria-hidden="true"><g id="mapBase"></g></svg>
                <svg id="mapSvg" class="map-svg" role="img" aria-label="Map of the overlays and reports"></svg>
                <!-- Pinned to the corner, open or closed, for an easy click either way. -->
                <button type="button" id="mapSideBtn" class="map-side-btn" title="Hide the sidebar" aria-label="Sidebar" aria-pressed="true"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg></button>
                <div class="map-tools" aria-label="Map controls">
                    <div class="map-layers" role="group" aria-label="Layers">
                        ${MAP_LAYERS.map(([k, t]) => `<button type="button" class="map-layer-btn" data-map-layer="${k}" aria-pressed="false"><span class="map-layer-check" aria-hidden="true"></span>${t}</button>`).join('')}
                    </div>
                    <div class="filter-presets" aria-label="Time window">
                        <span class="filter-presets-label">Window</span>
                        ${hours.map(([v, t]) => `<button type="button" class="filter-preset-btn" data-map-hours="${v}">${t}</button>`).join('')}
                    </div>
                    <div class="io-modes map-grids" role="group" aria-label="Which reports the heat map and dots show">
                        <button type="button" class="io-mode" data-map-grids="latest" title="Each report once, at its latest grid">Latest grids</button>
                        <button type="button" class="io-mode" data-map-grids="all" title="Every saved report, its updates included, at its grids">All reports</button>
                    </div>
                    <!-- On its own line under the controls, however many rows they wrap to. -->
                    <span class="map-tools-break" aria-hidden="true"></span>
                    <div id="mapNote" class="map-note" hidden></div>
                </div>
                <div class="map-zoom">
                    <button type="button" data-map-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
                    <button type="button" data-map-zoom="out" title="Zoom out" aria-label="Zoom out">&minus;</button>
                    <button type="button" data-map-zoom="fit" title="Show all" aria-label="Show all">&#10530;</button>
                    <button type="button" data-map-zoom="full" id="mapFullBtn" title="Full screen" aria-label="Full screen">${FULL_ICON}</button>
                    <button type="button" id="mapBaseBtn" title="Basemap" aria-label="Basemap" aria-expanded="false"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2 1.8 5.2 8 8.4l6.2-3.2z"/><path d="m1.8 8 6.2 3.2L14.2 8"/><path d="m1.8 10.8 6.2 3.2 6.2-3.2"/></svg></button>
                    <button type="button" id="mapDroneBtn" title="Drones" aria-label="Drones" aria-expanded="false"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.5 9.3 5.6 14.5 7.6v1.6L9.3 8.4 9 11.8l1.9 1.4v1.1L8 13.6l-2.9.7v-1.1L7 11.8l-.3-3.4-5.2.8V7.6l5.2-2z"/></svg></button>
                </div>
                <!-- The basemap: which one to show. Editors add and change them in Manage > Map. -->
                <div id="mapBasePop" class="map-base-pop" hidden>
                    <div class="map-base-pop-head">Basemap</div>
                    <select id="mapBaseSelect" class="map-base-select" aria-label="Basemap"></select>
                    <div id="mapBaseNone" class="map-base-none">No basemaps yet.</div>
                    <button type="button" id="mapBaseManage" class="text-btn editor-only">Add or change basemaps in Manage&hellip;</button>
                </div>
                <!-- Drones: where each is, shown or not, its view, and (editors) moving them. -->
                <div id="mapDronePop" class="map-base-pop map-drone-pop" hidden></div>
                <div id="mapGridReadout" class="map-grid-readout" hidden></div>
                <div id="mapTip" class="map-tip" role="status" hidden></div>
                <div id="mapHint" class="map-hint" hidden>${/Mac/i.test(navigator.platform) ? '&#8984;' : 'Ctrl'} + scroll to zoom the map</div>
                <div id="mapCard" class="map-card" hidden></div>
                <div class="map-bottom">
                    <div id="mapLegend" class="map-legend"></div>
                    <div class="map-time">
                        <label for="mapEndRange">Up to</label>
                        <input type="range" id="mapEndRange" min="0" max="1000" step="1" value="1000" aria-label="Show reports up to this time">
                        <span id="mapEndLabel" class="map-time-label"></span>
                        <button type="button" id="mapEndNow" class="text-btn" hidden>Now</button>
                    </div>
                </div>
            </div>
            </div>`;
        wireMapBox();
    }
    box.querySelectorAll('[data-map-layer]').forEach(b => b.setAttribute('aria-pressed', String(mapLayers[b.dataset.mapLayer])));
    box.querySelectorAll('[data-map-grids]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.mapGrids === 'all') === mapAllGrids)));
    // Greyed out, not hidden, when neither layer it changes is on: the tools don't move.
    box.querySelectorAll('[data-map-grids]').forEach(b => { b.disabled = !mapLayers.heat && !mapLayers.reports; });
    box.querySelectorAll('[data-map-hours]').forEach(b => b.classList.toggle('active', +b.dataset.mapHours === mapHours));
    const pick = document.getElementById('mapBaseSelect');
    pick.innerHTML = basemapOptions();
    pick.hidden = !sharedBasemaps.length;
    document.getElementById('mapBaseNone').hidden = !!sharedBasemaps.length;
    // Viewers can only pick: with nothing to pick, no button.
    document.getElementById('mapBaseBtn').hidden = isReadOnly && !sharedBasemaps.length;
    document.getElementById('mapDroneBtn').hidden = isReadOnly && !sharedDrones.length;
    renderDronePop();
    renderBasemapManager();
    redrawMap();
};

// The drone menu: two switches for this browser (show the drones, show their
// view), each drone with Zoom, and for editors its grid to move it, a remove,
// and a row to add one. Rebuilt from the list, keeping what was being typed.
const renderDronePop = () => {
    const pop = document.getElementById('mapDronePop');
    if (!pop) return;
    const typed = [...pop.querySelectorAll('input[type="text"][id]')].map(i => [i.id, i.value, document.activeElement === i]);
    const toggle = (id, on, label) => `<label class="map-drone-switch"><span>${label}</span><input type="checkbox" class="narr-switch" id="${id}"${on ? ' checked' : ''}></label>`;
    pop.innerHTML = `<div class="map-base-pop-head">Drones</div>
        ${toggle('mapDroneShow', droneShow, 'Show on the map')}
        ${toggle('mapDroneView', droneView, 'Show its view')}
        ${sharedDrones.length ? `<div class="map-drone-list">${sharedDrones.map((d, i) => `
            <div class="map-drone-row">
                <span class="map-drone-name">${escapeHtml(d.name)}</span>
                ${isReadOnly ? `<span class="map-drone-grid">${escapeHtml(d.grid)}</span>`
                    : `<input type="text" id="mapDroneGrid${i}" class="map-drone-grid-in" data-drone-grid="${i}" value="${escapeHtml(d.grid)}" maxlength="40" spellcheck="false" aria-label="${escapeHtml(d.name)}'s grid">`}
                <button type="button" class="text-btn" data-drone-zoom="${i}">Zoom</button>
                <button type="button" class="overlay-remove editor-only" data-drone-remove="${i}" title="Remove ${escapeHtml(d.name)}" aria-label="Remove ${escapeHtml(d.name)}">&times;</button>
            </div>
            <div class="map-drone-sub">
                <span class="map-drone-sub-label">Looking at</span>
                ${isReadOnly ? `<span class="map-drone-grid">${escapeHtml(d.look || 'the newest report')}</span>`
                    : `<input type="text" id="mapDroneLook${i}" class="map-drone-grid-in" data-drone-look="${i}" value="${escapeHtml(d.look || '')}" placeholder="Newest report" maxlength="40" spellcheck="false" aria-label="Where ${escapeHtml(d.name)} is looking">`}
                <span class="map-drone-sub-label">Range</span>
                ${isReadOnly ? `<span class="map-drone-grid">${d.range ? `${d.range} km` : 'none'}</span>`
                    : `<input type="text" id="mapDroneRange${i}" class="map-drone-range-in" data-drone-range="${i}" value="${d.range || ''}" placeholder="km" maxlength="6" inputmode="decimal" aria-label="${escapeHtml(d.name)}'s range in km">`}
            </div>`).join('')}</div>` : '<div class="map-base-none">No drones yet.</div>'}
        <div class="map-form-row map-drone-add editor-only">
            <input type="text" id="mapDroneName" placeholder="Name" maxlength="40" spellcheck="false" aria-label="Drone name (e.g. GE 1)">
            <input type="text" id="mapDroneGridNew" placeholder="Grid" maxlength="40" spellcheck="false" aria-label="Drone grid">
            <button type="button" id="mapDroneAdd" class="set-btn">Add</button>
        </div>
        <div class="map-base-hint editor-only">Shared with everyone. Type a grid or range and press Enter: a new grid moves the drone, <em>Looking at</em> points its view (empty: the newest report), and its range rings it.</div>`;
    // The add row keeps what was typed; a drone's grid only while it's being changed.
    typed.forEach(([id, v, focused]) => {
        const i = document.getElementById(id);
        if (!i || !(focused || id === 'mapDroneName' || id === 'mapDroneGridNew')) return;
        i.value = v;
        if (focused) i.focus();
    });
};

const saveDrones = async (list, said) => {
    sharedDrones = list;
    storeDrones();
    renderMapView();
    if (isLocalFile) { if (said) showToast(said); return; }
    try {
        const res = await postJson('/api/save_drones', { drones: list });
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(`The server refused the drones: ${body.message || res.status}`, true, { ms: 8000 });
        } else if (said) showToast(said);
    } catch (e) { showToast('Saved in this browser only: the server could not be reached.', true); }
};

// Zoom in on a drone (its view turned on, if the drones were hidden).
const zoomToDrone = (d) => {
    const p = dronePoint(d);
    if (!p || !mapView) return;
    if (!droneShow) { droneShow = true; try { localStorage.setItem('salt_drone_show', 'on'); } catch (err) { /* this session only */ } }
    const [x, y] = SaltCore.lonLatToMerc(p.lon, p.lat);
    mapView.cx = x; mapView.cy = y;
    mapView.mpp = Math.min(mapView.mpp, 4);
    renderMapView();
};

// --- Grab a grid ---

// Shift + click copies the grid under the pointer, ten digits. While Shift is
// held over the map, that grid shows beside the pointer and the cursor is a
// crosshair; a Shift + click opens no card.
const gridAtPointer = (e, box) => {
    if (!mapView) return null;
    const r = box.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const [lon, lat] = SaltCore.mercToLonLat(mapView.cx + (x - box.clientWidth / 2) * mapView.mpp, mapView.cy - (y - box.clientHeight / 2) * mapView.mpp);
    return { x, y, mgrs: SaltCore.latLonToMgrs(lat, lon) };
};
const MAP_CONTROLS = '.map-zoom, .map-card, .map-bottom, .map-base-pop, .map-tools, .map-side, .map-side-btn';
let mapPointer = null;   // where the pointer last was over the map: { clientX, clientY, target }
const showGridReadout = (e, shift) => {
    const box = document.getElementById('mapBox'), readout = document.getElementById('mapGridReadout');
    if (!box || !readout) return;
    const on = shift && !!e && !(e.target && e.target.closest && e.target.closest(MAP_CONTROLS));
    const g = on ? gridAtPointer(e, box) : null;
    box.classList.toggle('grabbing', !!(g && g.mgrs));
    readout.hidden = !(g && g.mgrs);
    if (!g || !g.mgrs) return;
    readout.textContent = g.mgrs;
    readout.style.left = `${Math.min(g.x + 16, box.clientWidth - readout.offsetWidth - 6)}px`;
    readout.style.top = `${Math.min(g.y + 16, box.clientHeight - readout.offsetHeight - 6)}px`;
};
// Shift pressed or let go with the pointer still: the readout follows the key.
['keydown', 'keyup'].forEach(type => document.addEventListener(type, e => {
    if (e.key === 'Shift' && mapPointer) showGridReadout(mapPointer, type === 'keydown');
}));
window.addEventListener('blur', () => showGridReadout(null, false));

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
        const layer = e.target.closest('[data-map-layer]');
        if (layer) {
            mapLayers[layer.dataset.mapLayer] = !mapLayers[layer.dataset.mapLayer];
            try { localStorage.setItem('salt_map_layers', JSON.stringify(mapLayers)); } catch (err) { /* this session only */ }
            renderMapView();
            return;
        }
        const grids = e.target.closest('[data-map-grids]');
        if (grids) {
            mapAllGrids = grids.dataset.mapGrids === 'all';
            try { localStorage.setItem('salt_map_grids', mapAllGrids ? 'all' : 'latest'); } catch (err) { /* this session only */ }
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
        if (e.target.closest('#mapBaseBtn')) { toggleBasePop(); return; }
        if (e.target.closest('#mapBaseManage')) { toggleBasePop(false); openExportView(); switchWorkspacesTab('overlays'); return; }
        if (e.target.closest('#mapDroneBtn')) { toggleDronePop(); return; }
        const zoomTo = e.target.closest('[data-drone-zoom]');
        if (zoomTo) { const d = sharedDrones[+zoomTo.dataset.droneZoom]; if (d) zoomToDrone(d); return; }
        const gone = e.target.closest('[data-drone-remove]');
        if (gone) {
            const d = sharedDrones[+gone.dataset.droneRemove];
            if (d) showConfirmation(`Remove ${d.name} from the map, for everyone?`, () => saveDrones(sharedDrones.filter(x => x !== d), `${d.name} removed.`));
            return;
        }
        if (e.target.closest('#mapDroneAdd')) {
            const name = document.getElementById('mapDroneName').value.trim();
            const grid = droneGrid(document.getElementById('mapDroneGridNew').value);
            if (!name) { showToast('Name the drone (e.g. GE 1).', true); return; }
            if (sharedDrones.some(d => d.name.toLowerCase() === name.toLowerCase())) { showToast(`There is already a drone called ${name}.`, true); return; }
            if (!grid) { showToast('Type its grid, e.g. 11S NV 39697 06762.', true); return; }
            if (sharedDrones.length >= 10) { showToast('Ten drones at most.', true); return; }
            document.getElementById('mapDroneName').value = '';
            document.getElementById('mapDroneGridNew').value = '';
            saveDrones([...sharedDrones, { name, grid, at: Date.now() }], `${name} added at ${grid}.`);
            return;
        }
    });
    mapBody.addEventListener('keydown', e => {
        // A drone's new grid, or the add row.
        const moved = e.target.closest('[data-drone-grid]');
        if (e.key === 'Enter' && moved) {
            e.preventDefault();
            const d = sharedDrones[+moved.dataset.droneGrid], grid = droneGrid(moved.value);
            if (!d) return;
            if (!grid) { showToast('Type its grid, e.g. 11S NV 39697 06762.', true); return; }
            moved.blur();
            saveDrones(sharedDrones.map(x => (x === d ? { ...d, grid, at: Date.now() } : x)), `${d.name} moved to ${grid}.`);
        }
        // Where it's looking (empty: back to the newest report), and its range (empty: none).
        const look = e.target.closest('[data-drone-look]');
        if (e.key === 'Enter' && look) {
            e.preventDefault();
            const d = sharedDrones[+look.dataset.droneLook], text = look.value.trim(), grid = text ? droneGrid(text) : null;
            if (!d) return;
            if (text && !grid) { showToast('Type the grid it\'s looking at, e.g. 11S NV 44000 07000, or leave it empty for the newest report.', true); return; }
            look.blur();
            const { look: _, ...rest } = d;
            saveDrones(sharedDrones.map(x => (x === d ? (grid ? { ...d, look: grid } : rest) : x)),
                grid ? `${d.name} is looking at ${grid}.` : `${d.name}'s view follows the newest report.`);
        }
        const ranged = e.target.closest('[data-drone-range]');
        if (e.key === 'Enter' && ranged) {
            e.preventDefault();
            const d = sharedDrones[+ranged.dataset.droneRange], text = ranged.value.trim().replace(/\s*km$/i, ''), km = Number(text);
            if (!d) return;
            if (text && !(km > 0 && km <= 1000)) { showToast('Type its range in km (up to 1,000), or leave it empty for none.', true); return; }
            ranged.blur();
            const { range: _, ...rest } = d;
            saveDrones(sharedDrones.map(x => (x === d ? (text ? { ...d, range: km } : rest) : x)),
                text ? `${d.name}'s range is ${km} km.` : `${d.name} has no range set.`);
        }
        if (e.key === 'Enter' && (e.target.id === 'mapDroneName' || e.target.id === 'mapDroneGridNew')) { e.preventDefault(); document.getElementById('mapDroneAdd').click(); }
    });
    mapBody.addEventListener('change', e => {
        if (e.target.id === 'mapDroneShow' || e.target.id === 'mapDroneView') {
            const on = e.target.checked;
            if (e.target.id === 'mapDroneShow') droneShow = on; else droneView = on;
            try { localStorage.setItem(e.target.id === 'mapDroneShow' ? 'salt_drone_show' : 'salt_drone_view', on ? 'on' : 'off'); } catch (err) { /* this session only */ }
            redrawMap();
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

// The basemap form in Manage > Map (wired once; its contents are redrawn).
const baseHost = document.getElementById('mapBaseFormSlot');
if (baseHost) {
    baseHost.addEventListener('click', e => {
        // A saved service's details: opened (a WMS's layers looked up again), or closed.
        const open = e.target.closest('[data-base-open]');
        if (open) {
            const b = sharedBasemaps[+open.dataset.baseOpen];
            if (!b) return;
            baseRemoving = false;
            wmsFind = null;
            if (baseOpen === b.name) { baseOpen = null; basemapsChanged(); return; }
            baseOpen = b.name;
            if (b.kind === 'wms') findWmsLayers(b.url, b.name, b.name);
            else basemapsChanged();
            return;
        }
        if (e.target.closest('[data-base-close]')) { wmsFind = null; baseOpen = null; baseRemoving = false; basemapsChanged(); return; }
        if (e.target.closest('#mapBaseRemove')) { removeOpenBasemap(); return; }
        if (e.target.closest('#mapTileSave')) {
            const b = sharedBasemaps.find(s => s.name === baseOpen);
            const url = document.getElementById('mapTileUrl').value.trim();
            if (!b) return;
            if (!/^https?:\/\//i.test(url) || !/\{(z|TileMatrix)\}/i.test(url)) { showToast('A tile address starts with http:// or https:// and has {z}, {x} and {y}.', true); return; }
            replaceBasemap(b.name, { ...b, url });
            return;
        }
        const check = e.target.closest('[data-base-check]');
        if (check) { const b = sharedBasemaps[+check.dataset.baseCheck]; if (b) checkBasemap(b); return; }
        // One box for both: a tile address has {z} (or WMTS's {TileMatrix}); anything
        // else is taken as a WMS, and its layers are looked up.
        if (e.target.closest('#mapBaseAddBtn')) {
            if (baseOpen) { baseOpen = null; baseRemoving = false; if (wmsFind && wmsFind.edit) wmsFind = null; }
            const text = document.getElementById('mapBaseInput').value.trim();
            if (!/^https?:\/\//i.test(text)) { showToast('Paste an address that starts with http:// or https://.', true); return; }
            if (/\{(z|TileMatrix)\}/i.test(text)) {
                const host = new URL(text.replace(/[{}]/g, '')).hostname;
                if (addBasemap({ name: freeBasemapName(host), kind: 'tiles', url: text })) clearBaseInputs();
                else basemapsChanged();
            } else findWmsLayers(text);
            return;
        }
        if (e.target.closest('#mapWmsAdd')) { if (addFoundLayers()) clearBaseInputs(); return; }
        if (e.target.closest('#mapWmsCancel')) { wmsFind = null; basemapsChanged(); return; }
        if (e.target.closest('#mapWmsManualAdd')) {
            const layers = document.getElementById('mapWmsManualLayers').value.trim();
            if (!layers) { showToast('Type the layer names to try.', true); return; }
            const saved = wmsFind.edit && sharedBasemaps.find(b => b.name === wmsFind.edit);
            const name = saved ? saved.name : freeBasemapName(new URL(wmsFind.link).hostname);
            if (saved) replaceBasemap(saved.name, { ...saved, name, layers });
            else if (addBasemap({ name, kind: 'wms', url: wmsFind.link, layers })) { wmsFind = null; clearBaseInputs(); }
            return;
        }
    });
    baseHost.addEventListener('input', e => { if (e.target.id === 'mapWmsFilter') filterWmsLayers(); });
    baseHost.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.id === 'mapBaseInput') { e.preventDefault(); document.getElementById('mapBaseAddBtn').click(); }
        if (e.key === 'Enter' && e.target.id === 'mapTileUrl') { e.preventDefault(); document.getElementById('mapTileSave').click(); }
    });
    baseHost.addEventListener('change', e => {
        const pick = e.target.closest('[data-layer-pick]');
        if (pick && wmsFind && wmsFind.layers) {
            const l = wmsFind.layers[+pick.dataset.layerPick];
            pick.checked ? wmsFind.picked.add(l.name) : wmsFind.picked.delete(l.name);
            const n = wmsFind.picked.size, btn = document.getElementById('mapWmsAdd');
            btn.disabled = !n;
            btn.textContent = wmsPickLabel(n, !!wmsFind.edit);
        }
    });
}

// The basemap and drone menus on the map, each opened from its button; a
// click elsewhere closes them.
const togglePop = (popId, btnId) => (open) => {
    const pop = document.getElementById(popId), btn = document.getElementById(btnId);
    if (!pop) return;
    pop.hidden = open === undefined ? !pop.hidden : !open;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
    btn.classList.toggle('active', !pop.hidden);
};
const toggleBasePop = togglePop('mapBasePop', 'mapBaseBtn');
const toggleDronePop = togglePop('mapDronePop', 'mapDroneBtn');
document.addEventListener('click', e => {
    const path = e.composedPath();
    if (!path.some(n => n.id === 'mapBasePop' || n.id === 'mapBaseBtn')) toggleBasePop(false);
    // A confirmation opened from the menu (Remove) doesn't close it.
    if (!path.some(n => n.id === 'mapDronePop' || n.id === 'mapDroneBtn' || n.id === 'confirmation-toast')) toggleDronePop(false);
});

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
    // A plain wheel scrolls the page on, past the map to its table; Ctrl (or
    // Cmd) with the wheel zooms, as does a trackpad pinch (sent as Ctrl). Full
    // screen has no page to scroll, so there the wheel zooms.
    let hintTimer = 0;
    m.box.addEventListener('wheel', e => {
        if (e.target.closest('.map-card, .map-bottom, .map-base-pop, .map-tools')) return;
        const full = document.fullscreenElement && document.fullscreenElement.contains(m.box);
        if (!full && !e.ctrlKey && !e.metaKey) {
            m.hint.hidden = false;
            clearTimeout(hintTimer);
            hintTimer = setTimeout(() => { m.hint.hidden = true; }, 1200);
            return;
        }
        e.preventDefault();
        m.hint.hidden = true;
        zoomAt(e, e.deltaY < 0 ? 0.8 : 1.25);
    }, { passive: false });
    m.box.addEventListener('dblclick', e => { if (!e.target.closest('.map-zoom, .map-card, .map-bottom, .map-base-pop, .map-tools, .map-side-btn')) zoomAt(e, 0.5); });
    let drag = null;
    m.box.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('.map-zoom, .map-card, .map-bottom, .map-base-pop, .map-tools, .map-side-btn') || !mapView) return;
        drag = { x: e.clientX, y: e.clientY, cx: mapView.cx, cy: mapView.cy, item: e.target.closest('[data-map-item]') };
        m.box.setPointerCapture(e.pointerId);
        m.box.classList.add('dragging');
    });
    m.box.addEventListener('pointermove', e => {
        mapPointer = { clientX: e.clientX, clientY: e.clientY, target: e.target };
        showGridReadout(e, e.shiftKey && !drag);
        if (drag) {
            mapView.cx = drag.cx - (e.clientX - drag.x) * mapView.mpp;
            mapView.cy = drag.cy + (e.clientY - drag.y) * mapView.mpp;
            m.tip.hidden = true;
            redrawMap();
            return;
        }
        const g = e.target.closest('[data-map-item]');
        const item = g && mapItems[+g.dataset.mapItem];
        if (!item || !m.card.hidden || e.shiftKey) { m.tip.hidden = true; return; }
        m.tip.innerHTML = item.kind === 'drone' ? droneTip(item.d) : trackTip(item.t);
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
        if (e.shiftKey) {
            const g = gridAtPointer(e, m.box);
            if (g && g.mgrs) { copyToClipboard(g.mgrs); showToast(`Copied ${g.mgrs}`); }
            return;
        }
        const item = d.item && mapItems[+d.item.dataset.mapItem];
        if (item && item.kind === 'drone') return;
        const [x, y] = at(e), w = m.box.clientWidth, h = m.box.clientHeight;
        const merc = [mapView.cx + (x - w / 2) * mapView.mpp, mapView.cy - (y - h / 2) * mapView.mpp];
        m.tip.hidden = true;
        mapClickHook({ item, at: [x, y], lonLat: SaltCore.mercToLonLat(merc[0], merc[1]), mpp: mapView.mpp });
    });
    m.box.addEventListener('pointercancel', end);
    m.box.addEventListener('pointerleave', () => {
        if (!drag) m.tip.hidden = true;
        mapPointer = null;
        showGridReadout(null, false);
    });
    new ResizeObserver(() => redrawMap()).observe(m.box);
};

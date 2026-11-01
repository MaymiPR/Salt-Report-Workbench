// SPDX-License-Identifier: AGPL-3.0-only

// Drawing the map (app/60-map.js): the overlays and their labels, the heat
// map, tracks, report dots, the picked report's ring and the legend.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.
// --- Drawing ---

const drawMap = () => {
    if (mapState.dragging) return;   // drawn when the drag ends
    const m = mapEls();
    if (!m.svg || !m.box) return;
    const w = m.box.clientWidth, h = m.box.clientHeight;
    if (!w || !h) return;
    const reps = mapReports();
    const tracks = SaltCore.reportTracks(reps);
    const ext = mapExtent(tracks);
    if (!ext) {
        m.svg.innerHTML = '';
        clearBasemap(m);
        m.note.textContent = 'Import overlays, or log reports with grids, to see the map.';
        m.note.hidden = false;
        m.legend.innerHTML = '';
        mapState.labelBoxes = [];
        mapState.lastDraw = { view: null, tracks, reps };
        mapState.drawnHook();
        return;
    }
    // A new report or overlay keeps the view where it is (inside the new area).
    if (!mapState.view) mapState.view = { cx: (ext[0] + ext[2]) / 2, cy: (ext[1] + ext[3]) / 2, mpp: Infinity };
    clampMapView(ext, w, h);
    const { cx, cy, mpp } = mapState.view;
    const px = (lon, lat) => { const [x, y] = SaltCore.lonLatToMerc(lon, lat); return [(x - cx) / mpp + w / 2, (cy - y) / mpp + h / 2]; };
    const view = [cx - w * mpp / 2, cy - h * mpp / 2, cx + w * mpp / 2, cy + h * mpp / 2];
    drawBasemap(m, ext, view, w, h);

    const out = [];
    mapState.items = [];
    const labels = mapLabels(w, h);
    // Worked out once a drawing, for the layer and its count in the key.
    const heat = mapState.layers.heat ? SaltCore.heatPoints(reps, mapState.allGrids) : [];
    const positions = mapState.layers.reports ? SaltCore.reportPositions(reps, mapState.allGrids) : [];
    if (mapState.layers.heat) out.push(heatLayer(heat, px, w, h));
    const drones = droneLayer(tracks, px, labels);
    out.push(drones.view);
    out.push(overlayLayer(px, w, h, view, labels, placeCounts(reps)));
    if (mapState.layers.tracks) out.push(trackLayer(tracks, px, labels));
    if (mapState.layers.reports) out.push(reportLayer(positions, tracks, px));
    out.push(selectionLayer(tracks, px));
    out.push(sightLayer(reps, px, labels));
    out.push(drones.marks);
    out.push(gotoLayer(px, labels));
    out.push(measureLayer(px, labels));
    m.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    m.svg.innerHTML = labels.fill(out.join(''));
    mapState.labelBoxes = labels.placed;
    m.note.hidden = !mapState.baseFailed;
    if (mapState.baseFailed) m.note.textContent = `The basemap service didn't answer. It may not be reachable from this computer.${isReadOnly ? '' : ' Check, in Manage > Map, says why.'}`;
    m.legend.innerHTML = mapLegend(heat, positions, tracks);
    mapState.lastDraw = { view, tracks, reps };
    mapState.drawnHook();
};
const redrawMap = () => { cancelAnimationFrame(mapState.frame); mapState.frame = requestAnimationFrame(drawMap); };

// --- Names that don't overlap ---

// Every name on the map (a graphic's, a track's, a drone's, a measure's) is
// offered with a priority and the box its text takes, worked out from its
// length and font. Once every layer is drawn they are placed in priority
// order, and a name whose box would overlap one already placed is left off.
// Each layer keeps its place in the drawing: a name goes in as a token, and
// the token becomes the name, or nothing, at the end. Placed names are kept
// in a grid of cells, so each looks only at its neighbours, however many.
// Lowest first: the measures and the item picked, then the axes and phase
// lines, then the graphics with reports, then those without, then the rest.
const LABEL_PRIORITY = { measure: 0, picked: 1, line: 2, busy: 3, area: 4, other: 5 };
// The stylesheet's font for the names (.map-label), to measure them by.
const MAP_LABEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const labelMeasure = (() => { try { return document.createElement('canvas').getContext('2d'); } catch (e) { return null; } })();
const labelWidths = new Map();
// How wide a name is drawn, in pixels: measured in the names' font once and
// kept; without a canvas, reckoned from its length and size.
const labelWidth = (text, size, weight) => {
    const key = `${weight}|${size}|${text}`;
    let w = labelWidths.get(key);
    if (w !== undefined) return w;
    if (labelWidths.size > 20000) labelWidths.clear();
    if (labelMeasure) { labelMeasure.font = `${weight} ${size}px ${MAP_LABEL_FONT}`; w = labelMeasure.measureText(text).width; }
    if (!(w > 0)) w = text.length * size * 0.62;
    labelWidths.set(key, w);
    return w;
};
// The box a name takes on screen, its halo included: [x0, y0, x1, y1] from
// where it is anchored (`y` its baseline), `lines` lines of it 13 px apart.
const LABEL_LINE = 13;
const labelBox = (x, y, text, size, weight, anchor, lines = 1) => {
    const tw = labelWidth(text, size, weight), pad = 2;
    const x0 = anchor === 'middle' ? x - tw / 2 : anchor === 'end' ? x - tw : x;
    return [x0 - pad, y - size * 0.8 - pad, x0 + tw + pad, y + size * 0.22 + pad + (lines - 1) * LABEL_LINE];
};
// The names of one drawing, `w` by `h`: offered, then placed (`fill`).
const LABEL_CELL = 64;
const mapLabels = (w, h) => {
    const all = [];
    const self = {
        placed: [],
        // A name: its markup and box, its priority (LABEL_PRIORITY), and its
        // rank within that (lower first). Its token goes where it is drawn.
        add: (markup, box, prio, rank = 0) => {
            all.push({ markup, box, prio: LABEL_PRIORITY[prio], rank, i: all.length });
            return `\u0001${all.length - 1}\u0001`;
        },
        fill: (svg) => {
            const keep = new Uint8Array(all.length), cells = new Map();
            const order = [...all].sort((a, b) => a.prio - b.prio || a.rank - b.rank || a.i - b.i);
            for (const l of order) {
                const [x0, y0, x1, y1] = l.box;
                if (x1 < 0 || y1 < 0 || x0 > w || y0 > h) continue;   // wholly off screen
                const c0 = Math.floor(x0 / LABEL_CELL), c1 = Math.floor(x1 / LABEL_CELL);
                const r0 = Math.floor(y0 / LABEL_CELL), r1 = Math.floor(y1 / LABEL_CELL);
                let free = true;
                for (let c = c0; c <= c1 && free; c++) {
                    for (let r = r0; r <= r1 && free; r++) {
                        const near = cells.get(c * 100003 + r);
                        if (near) free = !near.some(b => b[0] < x1 && x0 < b[2] && b[1] < y1 && y0 < b[3]);
                    }
                }
                if (!free) continue;
                keep[l.i] = 1;
                self.placed.push(l.box);
                for (let c = c0; c <= c1; c++) {
                    for (let r = r0; r <= r1; r++) {
                        const k = c * 100003 + r;
                        if (cells.has(k)) cells.get(k).push(l.box); else cells.set(k, [l.box]);
                    }
                }
            }
            return svg.replace(/\u0001(\d+)\u0001/g, (_, k) => (keep[k] ? all[k].markup : ''));
        },
    };
    return self;
};
// A name on the map, offered to `labels`: its <text> at [x, y] (in the group
// it is drawn in, which `shift` moves to the map's own pixels), in the font
// of its class (`size`, `weight`), anchored at its start, middle or end.
// `inner` is markup to draw instead of the text (a second line, say). A name
// can't hold the tokens' own character.
const mapLabel = (labels, [x, y], text, { cls = '', anchor = 'middle', size = 11, weight = 600, prio = 'other', rank = 0, shift = [0, 0], inner = null, lines = 1 } = {}) => {
    const markup = `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="map-label${cls}">${(inner === null ? svgEsc(text) : inner).replace(/\u0001/g, '')}</text>`;
    return labels.add(markup, labelBox(x + shift[0], y + shift[1], text, size, weight, anchor, lines), prio, rank);
};
// How many of the map's reports are at each place, by its name ('NAI 1').
const placeCounts = (reps) => {
    const n = new Map();
    reps.forEach(r => placesOfReport(r).forEach(k => n.set(k, (n.get(k) || 0) + 1)));
    return n;
};

const pathOf = (coords, px, close) => coords.map((c, i) => { const [x, y] = px(c[0], c[1]); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + (close ? 'Z' : '');

// Where a name goes so it stays on screen as the map zooms in: a shape's
// middle, or the middle of the part of it in view; a line's end, or the middle
// of its longest stretch in view. Null when none of it is in view.
const LABEL_MARGIN = 28;
const areaLabelAt = (pts, w, h) => {
    // A loop, not Math.min(...), which runs out of stack on a shape with very many points.
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
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

// An axis of advance's arrowhead, at the end of a line (in pixels) where the
// enemy heads, pointing the way its last leg runs.
const axisHead = (pts, color) => {
    const [ex, ey] = pts[pts.length - 1];
    let k = pts.length - 2;
    while (k > 0 && Math.hypot(ex - pts[k][0], ey - pts[k][1]) < 1) k--;
    const dx = ex - pts[k][0], dy = ey - pts[k][1], len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, s = 16, half = 9;
    const bx = ex - ux * s, by = ey - uy * s;
    const p = [[ex + ux * 4, ey + uy * 4], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
    return `<path d="M${p.map(q => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('L')}Z" fill="${color}" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" class="map-axis-head"/>`;
};

// Each graphic in its tag's color (app/50-overlays.js), unless its tag is
// switched off in the key: areas filled and outlined; a phase line black on a
// white edge; an axis of advance in its color on a white edge, wider, with an
// arrowhead at its end; a line of the team's tags in its color on a black
// edge; a point a dot (NAI, OBJ, PL) or a diamond (the team's). Unknown
// graphics, with no tag, aren't drawn until they have one, nor is a graphic
// wholly off screen. A name shows only where its graphic is big enough on
// screen to hold it (an area as wide and tall as the name, a line as long),
// unless it is picked; then the names take turns (mapLabels): the picked
// one's first, then the lines', then those of the graphics with reports
// (the most first), then the rest (the biggest first).
const overlayLayer = (px, w, h, view, labels, counts) => {
    const fill = [], lines = [], names = [];
    const mpp = mapState.view.mpp, margin = 60 * mpp;
    const label = (at, text, prio, rank) => { if (at) names.push(mapLabel(labels, at, text, { prio, rank })); };
    currentOverlays().forEach(o => {
        const tag = tagOf(o.type);
        if (tag.none || mapState.tagsOff.has(tag.key)) return;
        const b = overlayBox(o);
        if (b[2] < view[0] - margin || b[0] > view[2] + margin || b[3] < view[1] - margin || b[1] > view[3] + margin) return;
        const g = tag.shape === 'area' ? SaltCore.asArea(o.geometry) : o.geometry;
        const color = SaltCore.safeColor(tag.color);
        const key = graphicName(o);
        const picked = key === mapState.place || (tag.axis && key === mapState.axis);
        // Its size on screen, against its name's.
        const bw = (b[2] - b[0]) / mpp, bh = (b[3] - b[1]) / mpp, nw = labelWidth(key, 11, 600) + 4;
        const n = counts.get(key) || 0;
        const prio = picked ? 'picked' : n ? 'busy' : 'area', rank = n ? -n : -bw * bh;
        if (/Polygon/.test(g.type)) {
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
            const d = polys.map(rings => rings.map(r => pathOf(r, px, true)).join('')).join('');
            fill.push(`<path d="${d}" fill="${color}" fill-opacity="${picked ? 0.3 : 0.14}" stroke="${color}" stroke-width="${picked ? 4 : 2}" fill-rule="evenodd"/>`);
            if (picked || (bw >= nw && bh >= 13)) label(areaLabelAt(polys[0][0].map(c => px(c[0], c[1])), w, h), key, prio, rank);
        } else if (/LineString/.test(g.type)) {
            const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
            const d = parts.map(l => pathOf(l, px, false)).join('');
            const named = picked || Math.hypot(bw, bh) >= nw;
            if (tag.axis) {
                const heads = parts.map(l => l.map(c => px(c[0], c[1]))).filter(l => l.length >= 2).map(l => axisHead(l, color));
                lines.push(`<g class="map-axis${picked ? ' picked' : ''}"><path d="${d}" fill="none" stroke="#ffffff" stroke-width="${picked ? 11 : 8}" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`
                    + `<path d="${d}" fill="none" stroke="${color}" stroke-width="${picked ? 6 : 4.5}" stroke-linejoin="round" stroke-linecap="round"/>${heads.join('')}</g>`);
                if (named) label(lineLabelAt(parts.map(l => l.map(c => px(c[0], c[1]))), w, h), key, picked ? 'picked' : 'line');
                return;
            }
            // A phase line: black, on a white edge, so it shows on dark imagery
            // and on the plain background. The team's: its color, on a black edge.
            const edge = tag.builtIn ? '#ffffff' : MAP_COLORS.edge;
            const top = picked && tag.builtIn ? MAP_COLORS.track : color;
            lines.push(`<path d="${d}" fill="none" stroke="${edge}" stroke-width="${picked && !tag.builtIn ? 8 : 6}" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`
                + `<path d="${d}" fill="none" stroke="${top}" stroke-width="${picked ? 4 : 3}" stroke-linejoin="round" stroke-linecap="round"/>`);
            if (named) label(lineLabelAt(parts.map(l => l.map(c => px(c[0], c[1]))), w, h), key, picked ? 'picked' : 'line');
        } else if (g.type === 'Point') {
            const [x, y] = px(...g.coordinates);
            const [cx, cy] = [x.toFixed(1), y.toFixed(1)];
            fill.push(tag.builtIn ? `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`
                : `<path d="M${cx},${(y - 6).toFixed(1)}L${(x + 6).toFixed(1)},${cy}L${cx},${(y + 6).toFixed(1)}L${(x - 6).toFixed(1)},${cy}Z" fill="${color}" stroke="${MAP_COLORS.edge}" stroke-width="1.5" stroke-linejoin="round"/>`);
            label([x, y - 10], key, prio, n ? -n : 0);
        }
    });
    return `<g class="map-overlays">${fill.join('')}${lines.join('')}</g><g class="map-labels">${names.join('')}</g>`;
};

// Each report once, at its latest grid: a density surface drawn on a canvas,
// colored with one hue from clear to bright, and laid under the graphics.
const HEAT_RADIUS = 28;
// Blue, green, yellow, red, from fewest to most. The blue end fades in from
// clear, so a lone report doesn't read as an OBJ, and it grows more opaque as
// it rises, so the busiest places stand out over imagery or the plain background.
const HEAT_STOPS = [[0, [10, 132, 255, 0]], [0.15, [10, 132, 255, 90]], [0.4, [48, 209, 88, 165]], [0.65, [255, 214, 10, 205]], [1, [255, 59, 48, 235]]];
// The ramp, worked out once: 256 colors (RGBA) from fewest to most.
const HEAT_LUT = (() => {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        if (t < 0.03) continue;
        const k = HEAT_STOPS.findIndex(([s]) => s >= t);
        const [s1, c1] = HEAT_STOPS[Math.max(1, k)], [s0, c0] = HEAT_STOPS[Math.max(0, k - 1)];
        const f = s1 === s0 ? 1 : (t - s0) / (s1 - s0);
        for (let j = 0; j < 4; j++) lut[i * 4 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
    }
    return lut;
})();
// How many reports are near each pixel: each adds a cone, its weight at its
// grid falling to nothing at the radius, summed without limit (an 8-bit
// canvas stopped counting at about three in one place), then scaled so the
// busiest place is the top of the ramp. Kept between drawings (mapState.heatGrid).
const heatLayer = (points, px, w, h) => {
    const R = HEAT_RADIUS;
    const pts = points.map(p => ({ xy: px(p.lon, p.lat), w: p.w }))
        .filter(p => p.xy[0] > -R && p.xy[0] < w + R && p.xy[1] > -R && p.xy[1] < h + R);
    if (!pts.length) return '';
    if (mapState.heatGrid.length < w * h) mapState.heatGrid = new Float32Array(w * h);
    const grid = mapState.heatGrid;
    // Only the part the reports touch is filled, colored and cleared.
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
    pts.forEach(({ xy: [x, y], w: wt }) => {
        const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(w - 1, Math.ceil(x + R));
        const y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(h - 1, Math.ceil(y + R));
        if (x0 > x1 || y0 > y1) return;
        bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0); bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1);
        for (let j = y0; j <= y1; j++) {
            const dy = j + 0.5 - y, row = j * w;
            for (let i = x0; i <= x1; i++) {
                const dx = i + 0.5 - x, d = Math.sqrt(dx * dx + dy * dy);
                if (d < R) grid[row + i] += wt * (1 - d / R);
            }
        }
    });
    if (bx0 > bx1) return '';
    let max = 0;
    for (let j = by0; j <= by1; j++) for (let i = bx0, k = j * w + bx0; i <= bx1; i++, k++) if (grid[k] > max) max = grid[k];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h), d = img.data;
    for (let j = by0; j <= by1; j++) {
        for (let i = bx0, k = j * w + bx0; i <= bx1; i++, k++) {
            const v = grid[k];
            if (!v) continue;
            grid[k] = 0;
            const at = Math.min(255, Math.round(v / max * 255)) * 4, o = k * 4;
            d[o] = HEAT_LUT[at]; d[o + 1] = HEAT_LUT[at + 1]; d[o + 2] = HEAT_LUT[at + 2]; d[o + 3] = HEAT_LUT[at + 3];
        }
    }
    if (!max) return '';
    ctx.putImageData(img, 0, 0);
    return `<image href="${c.toDataURL('image/png')}" x="0" y="0" width="${w}" height="${h}" class="map-heat"/>`;
};

// Each report's path, first position to latest, with an arrow at the end;
// a report that never moved is a dot (with a short arrow when its Activity
// gives a heading), unless the Reports layer already shows it.
const trackLayer = (tracks, px, labels) => {
    const color = MAP_COLORS.track, out = [];
    const arrow = (x, y, deg, size) => {
        const a = deg * Math.PI / 180, s = size;
        const tip = [x + Math.sin(a) * s * 0.6, y - Math.cos(a) * s * 0.6];
        const l = [x + Math.sin(a - 2.5) * s * 0.6, y - Math.cos(a - 2.5) * s * 0.6];
        const r = [x + Math.sin(a + 2.5) * s * 0.6, y - Math.cos(a + 2.5) * s * 0.6];
        return `<path d="M${tip.map(v => v.toFixed(1))}L${l.map(v => v.toFixed(1))}L${r.map(v => v.toFixed(1))}Z" fill="${color}" stroke="${MAP_COLORS.edge}" stroke-width="1.2" stroke-linejoin="round"/>`;
    };
    // Names on the tracks that moved, while they stay readable; hover tells the rest.
    const labeled = tracks.filter(t => t.moved).length <= 25;
    tracks.forEach(t => {
        if (!t.moved && mapState.layers.reports) return;
        const i = mapState.items.push({ kind: 'track', t }) - 1;
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
        const picked = t.report.id === mapState.selected;
        const small = { size: 10, weight: 500, prio: picked ? 'picked' : 'other' };
        if (labeled && t.moved) out.push(mapLabel(labels, [ex + 9, ey + 4], t.report.displayId || '', { ...small, cls: ' map-label-track', anchor: 'start' }));
        // The picked track: when it was at each position, the latest first
        // should they crowd.
        if (t.moved && picked) {
            const local = timeDisplayMode === 'local';
            pts.forEach((p, k) => {
                const d = new Date(t.points[k].time);
                if (!isNaN(d.getTime())) out.push(mapLabel(labels, [p[0] - 7, p[1] - 8], SaltCore.clockValue(d, local).replace(':', '') + zoneMark(local), { ...small, cls: ' map-label-time', anchor: 'end', rank: -k }));
            });
        }
    });
    return `<g class="map-tracks">${out.join('')}</g>`;
};

// Each report as a dot at its latest grids, to click; with every saved report,
// its earlier positions too, smaller and fainter, under the latest.
const reportLayer = (positions, tracks, px) => {
    const byId = new Map(tracks.map(t => [t.report.id, t]));
    const pts = positions.filter(p => byId.has(p.report.id))
        .sort((a, b) => a.latest - b.latest);
    return `<g class="map-reports">${pts.map(p => {
        const i = mapState.items.push({ kind: 'report', t: byId.get(p.report.id) }) - 1;
        const [x, y] = px(p.lon, p.lat);
        return `<g class="map-report${p.latest ? '' : ' map-report-old'}" data-map-item="${i}">`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.latest ? 5 : 3.5}" fill="${MAP_COLORS.track}" stroke="${MAP_COLORS.edge}" stroke-width="${p.latest ? 1.5 : 1}"${p.latest ? '' : ' opacity="0.6"'}/>`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.latest ? 2 : 1.4}" fill="${MAP_COLORS.core}" class="map-report-core"${p.latest ? '' : ' opacity="0.6"'}/>`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.latest ? 11 : 7}" fill="transparent" class="map-hit"/></g>`;
    }).join('')}</g>`;
};

// "2.4 km, 047° NE" from the first point measured to the second, in this
// browser's units (Settings > Units).
const measureText = ([a, b]) => `${SaltCore.formatDistance(SaltCore.metersBetween(a, b), unitSystem)}, ${SaltCore.formatBearing(SaltCore.bearingBetween(a, b))}`;
// The measure tools on the map, and the range rings kept: the line, path or
// shape clicked, its ends, and its distances beside it; while a point is
// still to be placed, a fainter line to the pointer. Always one group, so
// the pointer's line can be redrawn alone (refreshMeasure).
// Their names come before every other on the map, and don't overlap each
// other either: the total (or the area, or the distance) first, then each leg
// in order, then the kept rings'.
const MEASURE_LEG_LABELS = 12;
const measureLayer = (px, labels) => {
    mapState.measurePx = px;
    const xy = (p) => px(p.lon, p.lat);
    const d = (pts, close) => pts.map((p, i) => { const [x, y] = xy(p); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + (close ? 'Z' : '');
    const stroke = (dd, extra = '') => `<path d="${dd}" class="map-measure-halo" fill="none"/><path d="${dd}" class="map-measure-line${extra}" fill="none"/>`;
    const label = (at, text, cls = '', rank = 0) => mapLabel(labels, at, text, { cls: ` map-measure-label${cls}`, weight: 700, size: cls === ' map-measure-total' ? 12 : 11, prio: 'measure', rank });
    const mid = (a, b) => { const [x1, y1] = xy(a), [x2, y2] = xy(b); return [(x1 + x2) / 2, (y1 + y2) / 2 - 8]; };
    const ring = (c, r, cls, rank = 0) => {
        const round = SaltCore.ringPoints(c, r);
        const [x, y] = xy(round[0]);
        return `<path d="${d(round, true)}" class="map-measure-halo" fill="none"/><path d="${d(round, true)}" class="map-measure-line ${cls}" fill="none"/>`
            + `<circle cx="${xy(c)[0].toFixed(1)}" cy="${xy(c)[1].toFixed(1)}" r="3" class="map-measure-end"/>`
            + label([x, y - 6], SaltCore.formatDistance(r, unitSystem), ` ${cls}-label`, rank);
    };
    const out = mapState.rings.map((g, i) => ring(g, g.r, 'map-ring-kept', 100 + i));
    const pts = mapState.measuring ? mapState.measure : [];
    const tool = mapState.measureTool, hover = mapState.measureHover;
    const ends = pts.map(p => { const [x, y] = xy(p); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="map-measure-end"/>`; }).join('');
    if (pts.length && tool === 'ring') {
        const r = mapState.ringR || (hover ? SaltCore.metersBetween(pts[0], hover) : 0);
        if (r > 0) out.push(ring(pts[0], r, mapState.ringR ? 'map-ring-now' : 'map-measure-preview'));
        out.push(ends);
    } else if (pts.length) {
        const open = !mapState.measureDone && hover && (tool !== 'distance' || pts.length === 1);
        if (open) out.push(`<path d="${d(tool === 'area' && pts.length > 1 ? [pts[pts.length - 1], hover, pts[0]] : [pts[pts.length - 1], hover])}" class="map-measure-line map-measure-preview" fill="none"/>`);
        if (tool === 'area' && pts.length > 2) out.push(`<path d="${d(pts, true)}" class="map-measure-area"/>`);
        if (tool === 'sight' && pts.length > 1) out.push(sightStroke(pts[0], pts[1], SaltCore.losBetween(pts[0], pts[1], terrainInput()), px));
        else if (pts.length > 1) out.push(stroke(d(pts, tool === 'area' && pts.length > 2)));
        out.push(ends);
        if ((tool === 'distance' || tool === 'sight') && pts.length > 1) out.push(label(mid(pts[0], pts[1]), measureText(pts)));
        else if (tool === 'area' && pts.length > 2) {
            const c = pts.map(xy).reduce((s, [x, y]) => [s[0] + x / pts.length, s[1] + y / pts.length], [0, 0]);
            out.push(label(c, SaltCore.formatArea(SaltCore.areaMeters(pts), unitSystem)));
        } else if (tool !== 'area' && pts.length > 1) {
            if (pts.length - 1 <= MEASURE_LEG_LABELS) pts.slice(1).forEach((p, i) => out.push(label(mid(pts[i], p), measureText([pts[i], p]), ' map-measure-leg', 1 + i)));
            const [x, y] = xy(pts[pts.length - 1]);
            out.push(label([x, y + 18], measureTotal(pts), ' map-measure-total'));
        }
    }
    return `<g class="map-measure" pointer-events="none">${out.join('')}</g>`;
};
// A path's total for its label: its length, and for Time-distance how long it takes.
const measureTotal = (pts) => {
    const m = SaltCore.pathMeters(pts);
    if (mapState.measureTool !== 'time') return SaltCore.formatDistance(m, unitSystem);
    const kmh = measureKmh();
    return `${SaltCore.formatDistance(m, unitSystem, measureKind())}${kmh > 0 ? `, ${SaltCore.formatDuration(m / 1000 / kmh)}` : ''}`;
};
// The pointer's line alone, without drawing the rest of the map again (its
// names placed among themselves; the others are placed at the next drawing).
const refreshMeasure = () => {
    const g = document.querySelector('#mapSvg .map-measure'), box = document.getElementById('mapBox');
    if (!g || !box || !mapState.measurePx || mapState.dragging) { redrawMap(); return; }
    const labels = mapLabels(box.clientWidth, box.clientHeight);
    g.insertAdjacentHTML('afterend', labels.fill(measureLayer(mapState.measurePx, labels)));
    g.remove();
};

// The grid gone to (Go to a grid, app/64-map-controls.js): an X on a dark
// edge, with its grid beside it, named before anything but the measures.
const gotoLayer = (px, labels) => {
    const g = mapState.goto;
    if (!g) return '';
    const [x, y] = px(g.lon, g.lat), s = 8, f = v => v.toFixed(1);
    const d = `M${f(x - s)},${f(y - s)}L${f(x + s)},${f(y + s)}M${f(x + s)},${f(y - s)}L${f(x - s)},${f(y + s)}`;
    return `<g class="map-goto" pointer-events="none"><path d="${d}" fill="none" stroke="${MAP_COLORS.edge}" stroke-width="6.5" stroke-linecap="round"/>`
        + `<path d="${d}" fill="none" stroke="${MAP_COLORS.goto}" stroke-width="3.2" stroke-linecap="round"/>`
        + `${mapLabel(labels, [x + 13, y - 9], g.mgrs, { anchor: 'start', prio: 'picked', rank: -1 })}</g>`;
};

// A ring round the picked report, in every mode.
const selectionLayer = (tracks, px) => {
    const t = mapState.selected && tracks.find(x => x.report.id === mapState.selected);
    if (!t) return '';
    const p = t.points[t.points.length - 1], [x, y] = px(p.lon, p.lat);
    return `<g class="map-selected${Date.now() < mapState.flashUntil ? ' flash' : ''}" pointer-events="none"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="#fff" stroke-width="4"/>`
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="${MAP_COLORS.OBJ}" stroke-width="2.5"/></g>`;
};

// A line of sight drawn from a to b ({ state, block }, SaltCore.losCheck's):
// green where it sees; where ground hides it, green to the ground that does,
// an X there, red past it; gray and dashed while not known (heights still
// to come, or none from the source at an end: the card and the tool say which).
const sightStroke = (a, b, c, px) => {
    const f = v => v.toFixed(1), [x1, y1] = px(a.lon, a.lat), [x2, y2] = px(b.lon, b.lat);
    const seg = (p, q, color, dash = '') => `<path d="M${f(p[0])},${f(p[1])}L${f(q[0])},${f(q[1])}" fill="none" stroke="${MAP_COLORS.core}" stroke-width="5" stroke-linecap="round" stroke-opacity="0.85"/>`
        + `<path d="M${f(p[0])},${f(p[1])}L${f(q[0])},${f(q[1])}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
    if (c.state === 'seen') return seg([x1, y1], [x2, y2], MAP_COLORS.seen);
    if (c.state !== 'hidden' || !c.block) return seg([x1, y1], [x2, y2], MAP_COLORS.waiting, '5 4');
    const [bx, by] = px(c.block.lon, c.block.lat), s = 5;
    return seg([x1, y1], [bx, by], MAP_COLORS.seen) + seg([bx, by], [x2, y2], MAP_COLORS.hidden, '6 4')
        + `<path d="M${f(bx - s)},${f(by - s)}L${f(bx + s)},${f(by + s)}M${f(bx + s)},${f(by - s)}L${f(bx - s)},${f(by + s)}" fill="none" stroke="${MAP_COLORS.hidden}" stroke-width="2.5" stroke-linecap="round"/>`;
};
// The picked report's lines of sight to the NAIs and OBJs near it, and the
// rings of its weapons' reach, each named (SaltCore.sightPicture). The
// heights they read are asked for here, once a report is picked.
const sightLayer = (reps, px, labels) => {
    const r = mapState.selected && reps.find(x => x.id === mapState.selected);
    const pic = r && SaltCore.sightPicture(r, currentOverlays(), sharedNarrative, terrainInput());
    if (!pic) return '';
    askTerrainFor(pic.points, 'pick');
    const xy = (p) => px(p.lon, p.lat), f = v => v.toFixed(1);
    const rings = pic.rings.map((g, i) => {
        const round = SaltCore.ringPoints(pic.at, g.m), d = round.map((p, j) => { const [x, y] = xy(p); return `${j ? 'L' : 'M'}${f(x)},${f(y)}`; }).join('') + 'Z';
        const [x, y] = xy(round[0]);
        return `<path d="${d}" fill="none" stroke="${MAP_COLORS.core}" stroke-width="4" stroke-opacity="0.7"/><path d="${d}" fill="none" stroke="${MAP_COLORS[g.kind]}" stroke-width="2" stroke-dasharray="8 5"/>`
            + mapLabel(labels, [x, y - 6], `${g.by} ${SaltCore.formatDistance(g.m, unitSystem)}`, { prio: 'picked', rank: 10 + i });
    }).join('');
    return `<g class="map-sight" pointer-events="none">${rings}${pic.lines.map(l => sightStroke(l.from, l.to, l, px)).join('')}</g>`;
};

// The key's switches for the graphics: one for each tag, built in or the
// team's with graphics (Unknown ones aren't drawn, so have none). Each turns
// its graphics off and on in this browser; one off is dimmed, and left out
// of a saved or printed map's key.
const tagKeys = () => {
    const ovs = currentOverlays();
    const swatch = (color, kind) => `<svg width="18" height="10" aria-hidden="true">${kind === 'pl'
        ? `<line x1="1" y1="5" x2="17" y2="5" stroke="#fff" stroke-width="4"/><line x1="1" y1="5" x2="17" y2="5" stroke="${color}" stroke-width="2"/>`
        : kind === 'axis' ? `<line x1="1" y1="5" x2="12" y2="5" stroke="#fff" stroke-width="5"/><line x1="1" y1="5" x2="12" y2="5" stroke="${color}" stroke-width="2.6"/>`
            + `<path d="M17.5,5L10.5,0.8L10.5,9.2Z" fill="${color}" stroke="#fff" stroke-width="1"/>`
        : kind === 'line' ? `<line x1="1" y1="5" x2="17" y2="5" stroke="${MAP_COLORS.edge}" stroke-width="4.5"/><line x1="1" y1="5" x2="17" y2="5" stroke="${color}" stroke-width="2.2"/>`
        : kind === 'point' ? `<path d="M9,0.5L13.5,5L9,9.5L4.5,5Z" fill="${color}" stroke="${MAP_COLORS.edge}" stroke-width="1"/>`
        : `<rect x="1" y="1" width="16" height="8" rx="2" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1.5"/>`}</svg>`;
    // One of the team's tags looks like what it holds: areas, else lines, else points.
    const kindOf = (list) => (list.some(o => /Polygon/.test(o.geometry.type)) ? 'area'
        : list.some(o => /LineString/.test(o.geometry.type)) ? 'line' : 'point');
    return everyTag().map(tag => {
        // NAI, OBJ and PL always; an axis of advance, as the team's, when there is one.
        const held = tag.builtIn && !tag.axis ? null : ovs.filter(o => tagOf(o.type).key === tag.key);
        if (held && !held.length) return '';
        const off = mapState.tagsOff.has(tag.key);
        const kind = tag.axis ? 'axis' : tag.builtIn ? (tag.shape === 'line' ? 'pl' : 'area') : kindOf(held);
        const what = tag.builtIn ? tag.title : `the ${tag.name} graphics`;
        return `<button type="button" class="map-key map-key-tag${off ? ' off' : ''}" data-map-tag="${escapeHtml(tag.key)}" aria-pressed="${!off}" title="${off ? 'Show' : 'Hide'} ${escapeHtml(what)} on the map">`
            + `${swatch(SaltCore.safeColor(tag.color), kind)}${escapeHtml(tag.name)}</button>`;
    }).join('');
};

// The key: what each color is, and what each layer that's on counts.
const mapLegend = (heatPts, positions, tracks) => {
    const key = (inner, text) => `<span class="map-key">${inner}${text}</span>`;
    const dot = `<svg width="18" height="10" aria-hidden="true"><circle cx="9" cy="5" r="4" fill="${MAP_COLORS.track}" stroke="${MAP_COLORS.edge}" stroke-width="1.2"/><circle cx="9" cy="5" r="1.6" fill="${MAP_COLORS.core}"/></svg>`;
    const trackLine = `<svg width="18" height="10" aria-hidden="true"><line x1="1" y1="5" x2="17" y2="5" stroke="${MAP_COLORS.edge}" stroke-width="4.5"/><line x1="1" y1="5" x2="17" y2="5" stroke="${MAP_COLORS.track}" stroke-width="2.2"/></svg>`;
    const heat = Math.round(heatPts.reduce((s, p) => s + p.w, 0));
    const what = [
        mapState.layers.heat && key('<span class="map-ramp"></span>', mapState.allGrids
            ? `Fewer to more reports (${heat}, every saved report, updates included)`
            : `Fewer to more reports (${heat}, each once, at its latest grid)`),
        mapState.layers.tracks && key(trackLine, `Track, first to latest (${tracks.filter(t => t.moved).length} moved${mapState.layers.reports ? '' : `, ${tracks.filter(t => !t.moved).length} at one grid`})`),
        shownDrones().length && key('<svg width="18" height="10" aria-hidden="true"><path d="M9,0.5 L10.2,3.6 L14.5,5.3 L14.5,6.4 L10.2,5.8 L9.9,8.4 L11.3,9.5 L6.7,9.5 L8.1,8.4 L7.8,5.8 L3.5,6.4 L3.5,5.3 L7.8,3.6 Z" fill="#ff9f0a" stroke="#000" stroke-width="0.8"/></svg>',
            mapState.droneView ? 'Drone, and its view' : 'Drone'),
        mapState.layers.reports && key(dot, mapState.allGrids
            ? `Report, every saved one (${positions.length} positions; earlier ones smaller)`
            : `Report, at its latest grid (${tracks.length})`),
    ].filter(Boolean);
    return tagKeys()
        + (what.length ? what.join('') : '<span class="map-key">Turn on a layer above to see the reports.</span>');
};

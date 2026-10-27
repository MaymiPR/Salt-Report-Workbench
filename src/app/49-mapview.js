// SPDX-License-Identifier: AGPL-3.0-only

// The Map view: the map (app/46-map.js), beside it what's on the map, and
// under it a table of those reports, all linked: clicking a report on the map
// opens its card and picks its row; clicking a row puts the map on it;
// clicking an NAI, OBJ, or phase line narrows the table to it.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let isMapViewActive = false;
// The table holds only the reports in the part of the map on screen. Per browser.
let mapOnlyInView = readStored('salt_map_only_in_view', 'on') !== 'off';
let mapListTimer = 0;

const mapViewEls = () => ({
    panel: document.getElementById('mapPanel'), host: document.getElementById('mapHost'),
    side: document.getElementById('mapSide'), body: document.getElementById('mapTableBody'),
    title: document.getElementById('mapTableTitle'), chip: document.getElementById('mapPlaceChip'),
    only: document.getElementById('mapOnlyInView'), timeHead: document.getElementById('mapTimeHead'),
    subtitle: document.getElementById('map-panel-subtitle'),
});

// --- What's on the map ---

// A report's latest grid in Web Mercator, or null when it has none.
const latestMerc = (t) => { const p = t.points[t.points.length - 1]; return SaltCore.lonLatToMerc(p.lon, p.lat); };
const mapTimeFmt = (t) => (timeDisplayMode === 'local' ? toLocalTimeString : toZuluTimeString)(t);
const placesOfReport = (r) => { const a = locationInfo(r.location); return [...a.nai.keys, ...a.obj.keys, ...a.pls]; };

// The reports the table and the numbers are about: those the map shows, cut
// to the picked place and (when asked) to the part of the map on screen.
const mapListReports = () => {
    const d = mapLastDraw;
    if (!d) return [];
    const track = new Map(d.tracks.map(t => [t.report.id, t]));
    let reps = d.reps;
    if (mapPlace) reps = reps.filter(r => placesOfReport(r).includes(mapPlace));
    if (mapOnlyInView && d.view) {
        const [x0, y0, x1, y1] = d.view;
        reps = reps.filter(r => {
            const t = track.get(r.id);
            if (!t) return false;
            const [x, y] = latestMerc(t);
            return x >= x0 && x <= x1 && y >= y0 && y <= y1;
        });
    }
    return [...reps].sort((a, b) => new Date(b.time) - new Date(a.time));
};

const renderMapSide = (reps) => {
    const s = mapViewEls();
    const tally = new Map(), tags = new Map();
    let inPlace = 0;
    reps.forEach(r => {
        const keys = placesOfReport(r);
        if (keys.some(k => !k.startsWith('PL '))) inPlace++;
        keys.forEach(k => tally.set(k, (tally.get(k) || 0) + 1));
        SaltCore.classifyActivity(r.activity).tags.forEach(t => tags.set(t, (tags.get(t) || 0) + 1));
    });
    const top = (m, n) => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], undefined, { numeric: true })).slice(0, n);
    const roll = SaltCore.bdaRollup(reps);
    const tile = (label, value) => `<div class="map-side-tile"><div class="map-side-label">${label}</div><div class="map-side-value">${value}</div></div>`;
    const places = top(tally, 5);
    s.side.innerHTML = `
        <div class="map-side-tiles">
            ${tile(mapOnlyInView ? 'On the map' : 'Reports', reps.length)}
            ${tile('In an NAI or OBJ', inPlace)}
            ${roll.total ? tile('BDA assessed', `${roll.done} / ${roll.total}`) : ''}
        </div>
        <div class="map-side-block">
            <div class="map-side-head">Activity</div>
            ${tags.size ? top(tags, 4).map(([t, n]) => `<div class="map-side-row"><span>${escapeHtml(t)}</span><strong>${n}</strong></div>`).join('') : '<div class="map-side-empty">None tagged</div>'}
        </div>
        <div class="map-side-block">
            <div class="map-side-head">Busiest places</div>
            ${places.length ? places.map(([k, n]) => `<button type="button" class="map-side-row map-side-place${k === mapPlace ? ' active' : ''}" data-map-place="${escapeHtml(k)}"><span>${escapeHtml(k)}</span><strong>${n}</strong></button>`).join('') : '<div class="map-side-empty">None named or found by grid</div>'}
        </div>`;
};

const renderMapTable = (reps) => {
    const s = mapViewEls(), local = timeDisplayMode === 'local';
    s.timeHead.textContent = local ? 'Time (L)' : 'Time (Z)';
    s.title.textContent = `${reps.length} report${reps.length === 1 ? '' : 's'}`;
    s.only.checked = mapOnlyInView;
    s.chip.innerHTML = mapPlace
        ? `<button type="button" class="map-place-chip" data-map-place="${escapeHtml(mapPlace)}" title="Show every place again">${escapeHtml(mapPlace)} <span aria-hidden="true">&times;</span></button>` : '';
    s.body.innerHTML = reps.length ? reps.map(r => `
        <tr data-map-row="${escapeHtml(r.id)}"${r.id === mapSelected ? ' class="selected-row"' : ''}>
            <td>${escapeHtml(formatFullId(r))}</td><td>${escapeHtml(r.size || '')}</td><td>${escapeHtml(r.activity || '')}</td>
            <td>${escapeHtml(r.location || '')}</td><td>${escapeHtml(mapTimeFmt(r.time))}</td>
        </tr>`).join('')
        : `<tr class="map-table-empty"><td colspan="5">${mapOnlyInView ? 'No reports on this part of the map. Zoom out, or untick “Only what’s on the map”.' : 'No reports in this window.'}</td></tr>`;
};

// After each drawing (panning redraws often), once it settles.
mapDrawnHook = () => {
    if (!isMapViewActive) return;
    clearTimeout(mapListTimer);
    mapListTimer = setTimeout(() => {
        const reps = mapListReports();
        renderMapSide(reps);
        renderMapTable(reps);
        positionMapCard();
    }, 80);
};

// --- The report card ---

let mapCardAt = null;   // [x, y] in the map box, where it was opened

const renderMapCard = () => {
    const card = document.getElementById('mapCard');
    if (!card) return;
    const r = mapSelected && localReports.find(x => x.id === mapSelected && !x.deleted);
    if (!r || !mapCardAt) { card.hidden = true; return; }
    const local = timeDisplayMode === 'local';
    const row = (label, value) => (value ? `<div class="map-card-row"><span>${label}</span><div>${escapeHtml(value)}</div></div>` : '');
    const b = SaltCore.bdaSummary(r);
    card.innerHTML = `
        <div class="map-card-head"><strong>${escapeHtml(formatFullId(r))}</strong>
            <button type="button" class="map-card-close" data-card-act="close" title="Close" aria-label="Close">&times;</button></div>
        ${row('Size', r.size)}${row('Activity', r.activity)}${row('Location', r.location)}
        ${row(local ? 'Time (L)' : 'Time (Z)', mapTimeFmt(r.time))}${row('Analysis', r.yourAnalysis)}
        ${b.total && (r.bda || []).length ? row('BDA', `${b.done} of ${b.total} assessed`) : ''}
        ${(r.history || []).length ? row('Updates', String(r.history.length)) : ''}
        <div class="map-card-actions">
            <button type="button" class="text-btn" data-card-act="table">Show in table</button>
            <button type="button" class="text-btn editor-only" data-card-act="edit">Edit</button>
        </div>`;
    card.hidden = false;
    positionMapCard();
};
// Beside the report, kept inside the map.
const positionMapCard = () => {
    const card = document.getElementById('mapCard'), box = document.getElementById('mapBox');
    if (!card || card.hidden || !box || !mapCardAt) return;
    const [x, y] = mapCardAt, w = box.clientWidth, h = box.clientHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    card.style.left = `${Math.max(8, Math.min(x + 16 + cw > w - 8 ? x - 16 - cw : x + 16, w - cw - 8))}px`;
    card.style.top = `${Math.max(8, Math.min(y - ch / 2, h - ch - 8))}px`;
};

const selectMapReport = (id, at) => {
    mapSelected = id;
    mapCardAt = at || null;
    renderMapCard();
    redrawMap();
};

// Put the map on a report and pulse its ring. Zoomed all the way out, it
// zooms in on it first (the whole area can't move to centre one report).
const centreMapOn = (id) => {
    const t = mapLastDraw && mapLastDraw.tracks.find(x => x.report.id === id);
    if (!t || !mapView) return false;
    if (mapView.mpp >= mapFitMpp * 0.99) mapView.mpp = mapFitMpp / 4;
    [mapView.cx, mapView.cy] = latestMerc(t);
    mapFlashUntil = Date.now() + 1600;
    return true;
};

// A click on the map: a report opens its card; an NAI, OBJ, or phase line
// narrows the table to it (again to widen it); anywhere else closes the card.
mapClickHook = ({ item, at, lonLat: [lon, lat], mpp }) => {
    if (item && item.t) { selectMapReport(item.t.report.id, at); return; }
    const near = mpp * Math.cos(lat * Math.PI / 180) * 10;   // ten pixels, on the ground
    const lines = currentOverlays().filter(o => o.type === 'PL' && SaltCore.metresToGeometry(o.geometry, lon, lat) <= near);
    const areas = currentOverlays().filter(o => o.type !== 'PL' && /Polygon|LineString/.test((o.geometry || {}).type || '')
        && SaltCore.geometryContains(SaltCore.asArea(o.geometry), lon, lat));
    const hit = lines[0] || areas[0];
    if (hit) { mapPlace = overlayKey(hit) === mapPlace ? '' : overlayKey(hit); redrawMap(); return; }
    if (mapSelected) selectMapReport('', null);
};

// --- The view ---

// The time slider: from the first report to now; at its right end, "now".
const renderMapTime = () => {
    const range = document.getElementById('mapEndRange'), label = document.getElementById('mapEndLabel'), now = document.getElementById('mapEndNow');
    if (!range) return;
    const times = localReports.filter(r => !r.deleted).map(r => new Date(r.time).getTime()).filter(t => !isNaN(t));
    const first = times.length ? Math.min(...times) : Date.now();
    range.dataset.first = String(first);
    range.disabled = !times.length;
    const span = Math.max(1, Date.now() - first);
    range.value = String(mapEnd === null ? 1000 : Math.round((mapEnd - first) / span * 1000));
    const local = timeDisplayMode === 'local';
    label.textContent = mapEnd === null ? 'Now' : SaltCore.dtg(mapEnd, local);
    now.hidden = mapEnd === null;
};

const renderMapView = () => {
    const s = mapViewEls();
    if (!s.panel || !isMapViewActive) return;
    renderOverlayMap(s.host);
    renderMapTime();
    const reps = mapReports();
    const win = mapHours ? `last ${mapHours} h` : 'all reports';
    s.subtitle.textContent = `${shownAto() || 'No workspace'} · ${win}${mapEnd === null ? '' : ` up to ${SaltCore.dtg(mapEnd, timeDisplayMode === 'local')}`} · ${reps.length} report${reps.length === 1 ? '' : 's'}`;
    renderMapCard();
};

const openMapView = () => {
    if (isExportViewActive) closeExportView();
    closeStatsView();
    closeSummaryView();
    isMapViewActive = true;
    setViewIcon('mapViewToggleBtn', true);
    el.log.view.style.display = 'none';
    mapViewEls().panel.style.display = 'flex';
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'map');
    renderMapView();
};
const closeMapView = () => {
    if (!isMapViewActive) return;
    isMapViewActive = false;
    setViewIcon('mapViewToggleBtn', false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    mapViewEls().panel.style.display = 'none';
    el.log.view.style.display = 'flex';
    writeStored('salt_view', 'log');
};

// --- Wiring ---

(() => {
    const s = mapViewEls();
    if (!s.panel) return;
    document.getElementById('mapViewToggleBtn').addEventListener('click', () => (isMapViewActive ? closeMapView() : openMapView()));
    s.panel.addEventListener('click', e => {
        const place = e.target.closest('[data-map-place]');
        if (place) { mapPlace = place.dataset.mapPlace === mapPlace ? '' : place.dataset.mapPlace; redrawMap(); return; }
        const act = e.target.closest('[data-card-act]');
        if (act) {
            const id = mapSelected;
            if (act.dataset.cardAct === 'close') selectMapReport('', null);
            else if (act.dataset.cardAct === 'edit') loadReportForEditing(id);
            else {
                // The table may hide it (another place, or off this part of the map).
                const row = () => s.body.querySelector(`[data-map-row="${CSS.escape(id)}"]`);
                if (!row()) { mapPlace = ''; mapOnlyInView = false; writeStored('salt_map_only_in_view', 'off'); renderMapTable(mapListReports()); }
                const tr = row();
                if (tr) {
                    // Scroll the view only (scrollIntoView would move the page too).
                    const view = tr.closest('.map-view'), vr = view.getBoundingClientRect(), r = tr.getBoundingClientRect();
                    view.scrollBy({ top: r.top - vr.top - (view.clientHeight - r.height) / 2, behavior: 'smooth' });
                    tr.classList.add('flash');
                    setTimeout(() => tr.classList.remove('flash'), 1500);
                }
            }
            return;
        }
        if (e.target.id === 'mapEndNow') { mapEnd = null; renderMapView(); return; }
        const tr = e.target.closest('[data-map-row]');
        if (tr) {
            const id = tr.dataset.mapRow;
            const centred = centreMapOn(id);
            mapSelected = id;
            // Drawn now, so the card can open beside where the report landed
            // (at the middle, unless the edge of the area held the map back).
            drawMap();
            const box = document.getElementById('mapBox'), ring = document.querySelector('#mapSvg .map-selected circle');
            mapCardAt = centred && box && ring ? [+ring.getAttribute('cx'), +ring.getAttribute('cy')] : null;
            renderMapCard();
        }
    });
    s.panel.addEventListener('change', e => {
        if (e.target === s.only) {
            mapOnlyInView = s.only.checked;
            writeStored('salt_map_only_in_view', mapOnlyInView ? 'on' : 'off');
            renderMapTable(mapListReports());
        }
    });
    s.panel.addEventListener('input', e => {
        if (e.target.id !== 'mapEndRange') return;
        const v = +e.target.value, first = +e.target.dataset.first;
        mapEnd = v >= 1000 ? null : Math.round(first + (Date.now() - first) * v / 1000);
        renderMapView();
    });
})();

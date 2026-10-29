// SPDX-License-Identifier: AGPL-3.0-only

// The map's own controls (app/60-map.js): full screen, the panel above the
// map, its menus, grabbing a grid, and the pointer and keyboard on the map.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.
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
const renderMapPanel = (box) => {
    if (!box.querySelector('#mapSvg')) {
        const hours = [[0, 'All'], [24, '24h'], [12, '12h'], [6, '6h']];
        box.innerHTML = `
            <div class="map-pane" id="mapPane">
            <div class="map-box" id="mapBox" tabindex="0" role="region" aria-label="Map" aria-describedby="mapKeys">
                <span id="mapKeys" class="visually-hidden">Arrow keys move the map, plus and minus zoom, 0 shows all, and Escape closes a report's card. While measuring, Space adds a point at the middle of the map, Enter finishes, and Escape ends it.</span>
                <svg class="map-base" aria-hidden="true"><g id="mapBase"></g></svg>
                <svg id="mapSvg" class="map-svg" role="img" aria-label="Map of the overlays and reports"></svg>
                <!-- Pinned to the corner, open or closed, for an easy click either way. -->
                <button type="button" id="mapSideBtn" class="map-side-btn" title="Hide the sidebar" aria-label="Sidebar" aria-pressed="true"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg></button>
                <div class="map-tools" role="group" aria-label="Map controls">
                    <div class="map-layers" role="group" aria-label="Layers">
                        ${MAP_LAYERS.map(([k, t]) => `<button type="button" class="map-layer-btn" data-map-layer="${k}" aria-pressed="false"><span class="map-layer-check" aria-hidden="true"></span>${t}</button>`).join('')}
                    </div>
                    <div class="filter-presets" role="group" aria-label="Time window">
                        <span class="filter-presets-label">Window</span>
                        ${hours.map(([v, t]) => `<button type="button" class="filter-preset-btn" data-map-hours="${v}">${t}</button>`).join('')}
                    </div>
                    <div class="io-modes map-grids" role="group" aria-label="Which reports the heat map and dots show">
                        <button type="button" class="io-mode" data-map-grids="latest" title="Each report once, at its latest grid">Latest Grids</button>
                        <button type="button" class="io-mode" data-map-grids="all" title="Every saved report, its updates included, at its grids">All Reports</button>
                    </div>
                    <!-- On its own line under the controls, however many rows they wrap to. -->
                    <span class="map-tools-break" aria-hidden="true"></span>
                    <div id="mapNote" class="map-note" hidden></div>
                    <div id="mapMeasureOut" class="map-note map-measure-out" role="status" hidden></div>
                </div>
                <div class="map-zoom">
                    <button type="button" data-map-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
                    <button type="button" data-map-zoom="out" title="Zoom out" aria-label="Zoom out">&minus;</button>
                    <button type="button" data-map-zoom="fit" title="Show all" aria-label="Show all">&#10530;</button>
                    <button type="button" data-map-zoom="full" id="mapFullBtn" title="Full screen" aria-label="Full screen">${FULL_ICON}</button>
                    <button type="button" id="mapBaseBtn" title="Basemap" aria-label="Basemap" aria-expanded="false"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2 1.8 5.2 8 8.4l6.2-3.2z"/><path d="m1.8 8 6.2 3.2L14.2 8"/><path d="m1.8 10.8 6.2 3.2 6.2-3.2"/></svg></button>
                    <button type="button" id="mapExportBtn" title="Save or print the map" aria-label="Save or print the map" aria-expanded="false"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11.5v2h11v-2"/></svg></button>
                    <!-- The measure tools slide out of the ruler, to its left; their options below them. -->
                    <div class="map-measure-wrap">
                        <button type="button" id="mapMeasureBtn" title="Measure" aria-label="Measure" aria-pressed="false" aria-controls="mapMeasureTools"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 11.5 11.5 2 14 4.5 4.5 14Z"/><path d="M5 9.5l1.2 1.2M7 7.5l1.2 1.2M9 5.5l1.2 1.2"/></svg></button>
                        <div id="mapMeasureTools" class="map-measure-tools" role="toolbar" aria-label="Measure tools" inert>
                            ${MEASURE_TOOLS.map(([k, t, tip]) => `<button type="button" class="map-measure-tool" data-measure-tool="${k}" title="${tip}" aria-pressed="false">${t}</button>`).join('')}
                        </div>
                        <div id="mapMeasurePanel" class="map-measure-panel" hidden></div>
                    </div>
                    <button type="button" id="mapDroneBtn" title="Drones" aria-label="Drones" aria-expanded="false"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.5 9.3 5.6 14.5 7.6v1.6L9.3 8.4 9 11.8l1.9 1.4v1.1L8 13.6l-2.9.7v-1.1L7 11.8l-.3-3.4-5.2.8V7.6l5.2-2z"/></svg></button>
                </div>
                <!-- The basemap: which one to show. Editors add and change them in Manage > Map. -->
                <div id="mapBasePop" class="map-base-pop" hidden>
                    <div class="map-base-pop-head">Basemap</div>
                    <select id="mapBaseSelect" class="map-base-select" aria-label="Basemap"></select>
                    <div id="mapBaseNone" class="map-base-none">No basemaps yet.</div>
                    <button type="button" id="mapBaseManage" class="text-btn editor-only">Add or change basemaps in Manage&hellip;</button>
                </div>
                <!-- Saving or printing what the map shows (app/65-map-export.js). -->
                <div id="mapExportPop" class="map-base-pop map-export-pop" hidden>
                    <div class="map-base-pop-head">Save or print the map</div>
                    <button type="button" id="mapSavePng" class="text-btn">Save as PNG</button>
                    <button type="button" id="mapPrint" class="text-btn">Print (or save as PDF)</button>
                </div>
                <!-- Drones: where each is, shown or not, its view, and (editors) moving them. -->
                <div id="mapDronePop" class="map-base-pop map-drone-pop" hidden></div>
                <div id="mapGridReadout" class="map-grid-readout" hidden></div>
                <div id="mapTip" class="map-tip" hidden></div>
                <div id="mapHint" class="map-hint" hidden>${/Mac/i.test(navigator.platform) ? '&#8984;' : 'Ctrl'} + scroll to zoom the map</div>
                <div id="mapCard" class="map-card" hidden></div>
                <div class="map-bottom">
                    <div id="mapLegend" class="map-legend"></div>
                    <div class="map-time">
                        <button type="button" id="mapEndPlay" class="text-btn" aria-pressed="false" title="Play the reports from the first to now">Play</button>
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
    box.querySelectorAll('[data-map-layer]').forEach(b => setOn(b, mapState.layers[b.dataset.mapLayer], 'aria-pressed', null));
    box.querySelectorAll('[data-map-grids]').forEach(b => setOn(b, (b.dataset.mapGrids === 'all') === mapState.allGrids, 'aria-pressed', null));
    // Grayed out, not hidden, when neither layer it changes is on: the tools don't move.
    box.querySelectorAll('[data-map-grids]').forEach(b => { b.disabled = !mapState.layers.heat && !mapState.layers.reports; });
    box.querySelectorAll('[data-map-hours]').forEach(b => setOn(b, +b.dataset.mapHours === mapState.hours));
    renderMeasureTools();
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

// --- Grab a grid ---

// Shift + click copies the grid under the pointer, ten digits. While Shift is
// held over the map, that grid shows beside the pointer and the cursor is a
// crosshair; a Shift + click opens no card.
const gridAtPointer = (e, box) => {
    if (!mapState.view) return null;
    const r = box.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const [lon, lat] = SaltCore.mercToLonLat(mapState.view.cx + (x - box.clientWidth / 2) * mapState.view.mpp, mapState.view.cy - (y - box.clientHeight / 2) * mapState.view.mpp);
    return { x, y, mgrs: SaltCore.latLonToMgrs(lat, lon) };
};
const MAP_CONTROLS = '.map-zoom, .map-card, .map-bottom, .map-base-pop, .map-tools, .map-side, .map-side-btn';
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
    if (e.key === 'Shift' && mapState.pointer) showGridReadout(mapState.pointer, type === 'keydown');
}));
window.addEventListener('blur', () => showGridReadout(null, false));

const trackTip = (t) => {
    const r = t.report, local = timeDisplayMode === 'local';
    const first = t.points[0], last = t.points[t.points.length - 1];
    const lines = [`<strong>${escapeHtml(formatFullId(r))}</strong>`, escapeHtml([r.size, r.activity].filter(Boolean).join(' · '))];
    if (t.moved) {
        lines.push(`${t.points.length} positions, ${escapeHtml(SaltCore.formatDistance(t.lengthM, unitSystem))} toward ${SaltCore.compass16(t.bearingDeg)}`);
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
            mapState.layers[layer.dataset.mapLayer] = !mapState.layers[layer.dataset.mapLayer];
            writeStored('salt_map_layers', JSON.stringify(mapState.layers));
            renderMapView();
            return;
        }
        // A tag's switch in the key: its graphics off or on, in this browser.
        const tagKey = e.target.closest('[data-map-tag]');
        if (tagKey) {
            const k = tagKey.dataset.mapTag;
            if (mapState.tagsOff.has(k)) mapState.tagsOff.delete(k); else mapState.tagsOff.add(k);
            writeStored('salt_map_tags_off', JSON.stringify([...mapState.tagsOff]));
            cancelAnimationFrame(mapState.frame);
            drawMap();
            const again = document.querySelector(`#mapLegend [data-map-tag="${CSS.escape(k)}"]`);
            if (again) again.focus({ preventScroll: true });
            return;
        }
        const grids = e.target.closest('[data-map-grids]');
        if (grids) {
            mapState.allGrids = grids.dataset.mapGrids === 'all';
            writeStored('salt_map_grids', mapState.allGrids ? 'all' : 'latest');
            renderMapView();
            return;
        }
        const hrs = e.target.closest('[data-map-hours]');
        if (hrs) { mapState.hours = +hrs.dataset.mapHours; renderMapView(); return; }
        if (e.target.closest('#mapMeasureBtn')) { setMapMeasuring(!mapState.measuring); return; }
        if (e.target.closest('#mapExportBtn')) { toggleExportPop(); return; }
        if (e.target.closest('#mapSavePng')) { toggleExportPop(false); saveMapPng(); return; }
        if (e.target.closest('#mapPrint')) { toggleExportPop(false); printMap(); return; }
        const zoom = e.target.closest('[data-map-zoom]');
        if (zoom && zoom.dataset.mapZoom === 'full') { toggleMapFullscreen(); return; }
        if (zoom && mapState.view) {
            if (zoom.dataset.mapZoom === 'fit') mapState.view.mpp = Infinity;
            else mapState.view.mpp *= zoom.dataset.mapZoom === 'in' ? 0.5 : 2;
            redrawMap();
            return;
        }
        if (e.target.closest('#mapBaseBtn')) { toggleBasePop(); return; }
        if (e.target.closest('#mapBaseManage')) { toggleBasePop(false); openManageView(); switchManageTab('overlays'); return; }
        if (e.target.closest('#mapDroneBtn')) { toggleDronePop(); return; }
        const zoomTo = e.target.closest('[data-drone-zoom]');
        if (zoomTo) { const d = sharedDrones[+zoomTo.dataset.droneZoom]; if (d) zoomToDrone(d); return; }
        const gone = e.target.closest('[data-drone-remove]');
        if (gone) {
            // The first press asks, in its row; the second removes it. By its
            // name: a sync may have changed the list meanwhile. Undo puts it
            // back where it was, unless one of that name has been added since.
            const name = gone.dataset.droneName;
            if (!askFirst(`drone|${name}`, renderDronePop)) return;
            const at = sharedDrones.findIndex(x => x.name === name);
            if (at < 0) { showToast(`${name} is no longer on the map.`, true); return; }
            const was = sharedDrones[at];
            saveDrones(sharedDrones.filter(x => x !== was), `${name} removed.`, () => {
                if (sharedDrones.some(x => x.name.toLowerCase() === was.name.toLowerCase())) { showToast(`There is already a drone called ${was.name}.`, true); return; }
                saveDrones([...sharedDrones.slice(0, at), was, ...sharedDrones.slice(at)], `${was.name} put back.`);
            });
            return;
        }
        if (e.target.closest('#mapDroneAdd')) {
            const name = document.getElementById('mapDroneName').value.trim();
            const grid = droneGrid(document.getElementById('mapDroneGridNew').value);
            if (!name) { showToast('Name the drone (e.g. GE 1).', true); return; }
            if (sharedDrones.some(d => d.name.toLowerCase() === name.toLowerCase())) { showToast(`There is already a drone called ${name}.`, true); return; }
            if (!grid) { showToast('Type its grid, e.g. 11S NV 39697 06762.', true); return; }
            if (sharedDrones.length >= MAX_DRONES) { showToast(`${MAX_DRONES} drones at most.`, true); return; }
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
            if (text && !(km > 0 && km <= MAX_DRONE_RANGE_KM)) { showToast(`Type its range in km (up to ${MAX_DRONE_RANGE_KM.toLocaleString('en-US')}), or leave it empty for none.`, true); return; }
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
            if (e.target.id === 'mapDroneShow') mapState.droneShow = on; else mapState.droneView = on;
            writeStored(e.target.id === 'mapDroneShow' ? 'salt_drone_show' : 'salt_drone_view', on ? 'on' : 'off');
            redrawMap();
            return;
        }
        if (e.target.id === 'mapBaseSelect') {
            mapState.baseChoice = e.target.value;
            mapState.baseFailed = false;
            writeStored('salt_map_base', mapState.baseChoice);
            redrawMap();
        }
    });
}

// The basemap and drone menus on the map, each opened from its button; a
// click elsewhere closes them.
const togglePop = (popId, btnId) => (open) => {
    const pop = document.getElementById(popId), btn = document.getElementById(btnId);
    if (!pop) return;
    pop.hidden = open === undefined ? !pop.hidden : !open;
    setOn(btn, !pop.hidden, 'aria-expanded');
};
// --- Measure ---

// The tools that slide out of the ruler: [key, name, what it does].
const MEASURE_TOOLS = [
    ['distance', 'Distance', 'Two points: the distance and bearing between them'],
    ['path', 'Path', 'Click along a way: its length, and each leg\'s distance and bearing'],
    ['area', 'Area', 'Click round a shape: its area and perimeter'],
    ['ring', 'Range ring', 'Click a center, then the radius (or drag it out)'],
    ['time', 'Time-distance', 'Click along a route: how long it takes at a speed'],
];
const MAX_RINGS = 20;
// The time-distance tool's rate: a standard one, or the speed typed with its class.
const measureRate = () => SaltCore.STANDARD_RATES.find(r => r.id === mapState.measureRate) || SaltCore.STANDARD_RATES[0];
// On, the ruler says so, its tools slide out and the cursor is a crosshair;
// off, they slide back and what was measured goes (kept rings stay).
const setMapMeasuring = (on) => {
    mapState.measuring = on;
    resetMeasure();
    const btn = document.getElementById('mapMeasureBtn'), box = document.getElementById('mapBox');
    // Focus in the tools as they go goes back to the ruler.
    if (!on && btn && btn !== document.activeElement && btn.parentNode.contains(document.activeElement)) btn.focus();
    setOn(btn, on, 'aria-pressed', 'active');
    if (box) box.classList.toggle('measuring', on);
    renderMeasureTools();
    showMeasure();
    redrawMap();
};
const resetMeasure = () => {
    mapState.measure = [];
    mapState.measureDone = false;
    mapState.ringR = 0;
    mapState.measureHover = null;
};
const pickMeasureTool = (tool) => {
    mapState.measureTool = tool;
    resetMeasure();
    renderMeasureTools();
    showMeasure();
    redrawMap();
};
// The toolbar (open while measuring, the tool in use pressed), and under
// it the time-distance tool's speed or the range rings kept.
const renderMeasureTools = () => {
    const tools = document.getElementById('mapMeasureTools'), panel = document.getElementById('mapMeasurePanel');
    if (!tools || !panel) return;
    tools.classList.toggle('open', mapState.measuring);
    tools.inert = !mapState.measuring;
    tools.querySelectorAll('[data-measure-tool]').forEach(b => setOn(b, b.dataset.measureTool === mapState.measureTool));
    const tool = mapState.measuring ? mapState.measureTool : '';
    if (tool === 'time') {
        const rate = measureRate(), per = SaltCore.kmhPerSpeedUnit(unitSystem, rate.kind);
        const typed = Math.round(mapState.measureKmh / per * 10) / 10;
        panel.innerHTML = `<label for="mapMeasureRate">Speed</label>
            <select id="mapMeasureRate">${SaltCore.STANDARD_RATES.map(r => `<option value="${r.id}"${r.id === rate.id ? ' selected' : ''}>${escapeHtml(r.label)} (${escapeHtml(SaltCore.formatSpeed(r.kmh, unitSystem, r.kind))})</option>`).join('')}</select>
            <span class="map-measure-speed"><input type="number" id="mapMeasureSpeed" min="0" step="any" inputmode="decimal" value="${typed}" aria-label="Speed in ${SaltCore.speedUnit(unitSystem, rate.kind)}">
            <span aria-hidden="true">${SaltCore.speedUnit(unitSystem, rate.kind)}</span></span>`;
    } else if (tool === 'ring') {
        const done = mapState.measure.length && mapState.ringR > 0;
        panel.innerHTML = `<button type="button" id="mapRingKeep" class="text-btn"${done ? '' : ' disabled'}>Keep ring on the map</button>
            ${mapState.rings.length ? `<div class="map-base-pop-head">Kept rings</div>
            <ul class="map-ring-list">${mapState.rings.map((g, i) => `<li><span>${escapeHtml(SaltCore.formatDistance(g.r, unitSystem))} round ${escapeHtml(SaltCore.latLonToMgrs(g.lat, g.lon) || '')}</span>
                <button type="button" class="map-ring-remove" data-ring-remove="${i}" title="Remove this ring" aria-label="Remove the ${escapeHtml(SaltCore.formatDistance(g.r, unitSystem))} ring">&times;</button></li>`).join('')}</ul>
            <button type="button" id="mapRingClear" class="text-btn">Clear all</button>` : ''}`;
    } else panel.innerHTML = '';
    panel.hidden = !panel.innerHTML;
};
// A point clicked (or Space with the map focused) for the tool in use.
const addMeasurePoint = ([lon, lat]) => {
    const p = { lon, lat }, pts = mapState.measure;
    if (mapState.measureTool === 'distance') mapState.measure = pts.length >= 2 ? [p] : [...pts, p];
    else if (mapState.measureTool === 'ring') {
        if (!pts.length || mapState.ringR) { mapState.measure = [p]; mapState.ringR = 0; }
        else mapState.ringR = SaltCore.metersBetween(pts[0], p);
        renderMeasureTools();
    } else if (mapState.measureDone) { mapState.measure = [p]; mapState.measureDone = false; }
    else mapState.measure = [...pts, p];
    showMeasure();
    redrawMap();
};
// Double-click or Enter: a path, area or route is finished (a click then
// starts another). The second click of a double-click added a point where
// the first did; it goes.
const finishMeasure = (dbl) => {
    const tool = mapState.measureTool, pts = mapState.measure, px = mapState.measurePx;
    if (!mapState.measuring || tool === 'distance' || tool === 'ring' || mapState.measureDone) return;
    if (dbl && pts.length > 1 && px) {
        const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]].map(p => px(p.lon, p.lat));
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 6) pts.pop();
    }
    if (pts.length < (tool === 'area' ? 3 : 2)) return;
    mapState.measureDone = true;
    mapState.measureHover = null;
    showMeasure();
    redrawMap();
};
// What is measured, with its grids, for reading and copying; a screen
// reader hears it (role=status).
const showMeasure = () => {
    const out = document.getElementById('mapMeasureOut');
    if (!out) return;
    const pts = mapState.measure, grid = p => SaltCore.latLonToMgrs(p.lat, p.lon);
    const dist = (m, kind) => SaltCore.formatDistance(m, unitSystem, kind);
    const finish = mapState.measureDone ? ' Click to start another.' : ' Double-click or press Enter to finish.';
    const legs = () => {
        const each = pts.slice(1).map((p, i) => `${dist(SaltCore.metersBetween(pts[i], p))} ${SaltCore.formatBearing(SaltCore.bearingBetween(pts[i], p))}`);
        return each.length > 10 ? `${each.slice(0, 10).join('; ')}; and ${each.length - 10} more` : each.join('; ');
    };
    out.hidden = !mapState.measuring;
    const tool = mapState.measureTool;
    if (tool === 'distance') {
        out.textContent = !pts.length ? 'Measure: click a point on the map, then another.'
            : pts.length === 1 ? `From ${grid(pts[0])}: click the second point.`
            : `${measureText(pts)}, from ${grid(pts[0])} to ${grid(pts[1])}.`;
    } else if (tool === 'ring') {
        out.textContent = !pts.length ? 'Range ring: click the center, then click the radius (or drag it out from the center).'
            : !mapState.ringR ? `Center ${grid(pts[0])}: click the radius.`
            : `Range ring: radius ${dist(mapState.ringR)} round ${grid(pts[0])}. Click for a new center.`;
    } else if (tool === 'area') {
        out.textContent = pts.length < 3 ? `Area: click round the shape, three points or more.${pts.length ? ` ${plural(pts.length, 'point')} so far.` : ''}`
            : `Area: ${SaltCore.formatArea(SaltCore.areaMeters(pts), unitSystem)}, perimeter ${dist(SaltCore.pathMeters([...pts, pts[0]]))} (${plural(pts.length, 'point')}).${finish}`;
    } else if (tool === 'path') {
        out.textContent = !pts.length ? 'Path: click points along the way.'
            : pts.length === 1 ? `From ${grid(pts[0])}: click the next point.`
            : `Path: ${dist(SaltCore.pathMeters(pts))} in ${plural(pts.length - 1, 'leg')} (${legs()}), from ${grid(pts[0])} to ${grid(pts[pts.length - 1])}.${finish}`;
    } else {
        const rate = measureRate(), m = SaltCore.pathMeters(pts), kmh = mapState.measureKmh;
        out.textContent = pts.length < 2 ? `Time-distance: pick or type a speed, then click points along the route.${pts.length ? ` From ${grid(pts[0])}: click the next point.` : ''}`
            : !(kmh > 0) ? `Time-distance: ${dist(m, rate.kind)}. Type a speed above 0.`
            : `Time-distance: ${dist(m, rate.kind)} at ${SaltCore.formatSpeed(kmh, unitSystem, rate.kind)} takes ${SaltCore.formatDuration(m / 1000 / kmh)}, from ${grid(pts[0])} to ${grid(pts[pts.length - 1])}.${finish}`;
    }
};
// Range rings kept on the map, in this browser only.
const saveRings = (rings, said) => {
    mapState.rings = rings;
    writeStored('salt_range_rings', JSON.stringify(rings));
    renderMeasureTools();
    redrawMap();
    if (said) showToast(said);
};
// The pointer over the map while a point is still to be placed: the line
// (or ring) to it follows, drawn alone, once a frame.
let measureHoverFrame = 0;
const hoverMeasure = (lonLat) => {
    const pts = mapState.measure, tool = mapState.measureTool;
    const wants = mapState.measuring && pts.length && !mapState.measureDone
        && (tool === 'ring' ? !mapState.ringR : tool !== 'distance' || pts.length === 1);
    if (!wants && !mapState.measureHover) return;
    mapState.measureHover = wants && lonLat ? { lon: lonLat[0], lat: lonLat[1] } : null;
    cancelAnimationFrame(measureHoverFrame);
    measureHoverFrame = requestAnimationFrame(refreshMeasure);
};
if (mapBody) {
    mapBody.addEventListener('click', e => {
        const tool = e.target.closest('[data-measure-tool]');
        if (tool) { pickMeasureTool(tool.dataset.measureTool); return; }
        if (e.target.closest('#mapRingKeep')) {
            const c = mapState.measure[0];
            if (!c || !mapState.ringR) return;
            if (mapState.rings.length >= MAX_RINGS) { showToast(`${MAX_RINGS} kept rings at most. Remove one first.`, true); return; }
            const r = Math.round(mapState.ringR);
            resetMeasure();
            showMeasure();
            saveRings([...mapState.rings, { lon: c.lon, lat: c.lat, r }], `Ring of ${SaltCore.formatDistance(r, unitSystem)} kept on the map, in this browser.`);
            return;
        }
        const gone = e.target.closest('[data-ring-remove]');
        if (gone) {
            const at = +gone.dataset.ringRemove;
            saveRings(mapState.rings.filter((_, i) => i !== at), 'Ring removed.');
            const next = document.querySelector('[data-ring-remove]') || document.getElementById('mapRingKeep');
            if (next) next.focus();
            return;
        }
        if (e.target.closest('#mapRingClear')) {
            saveRings([], 'Kept rings cleared.');
            const keep = document.getElementById('mapRingKeep');
            if (keep) keep.focus();
        }
    });
    // The time-distance tool's speed: a standard rate fills the box, in its
    // class's unit; a speed typed there is used as it is.
    mapBody.addEventListener('change', e => {
        if (e.target.id !== 'mapMeasureRate') return;
        mapState.measureRate = e.target.value;
        mapState.measureKmh = measureRate().kmh;
        renderMeasureTools();
        showMeasure();
        refreshMeasure();
        document.getElementById('mapMeasureRate').focus();
    });
    mapBody.addEventListener('input', e => {
        if (e.target.id !== 'mapMeasureSpeed') return;
        const v = Number(e.target.value);
        mapState.measureKmh = v > 0 ? v * SaltCore.kmhPerSpeedUnit(unitSystem, measureRate().kind) : 0;
        showMeasure();
        refreshMeasure();
    });
}
// Enter finishes a path, area or route, from the map or from nowhere in
// particular (not from a button or box, where Enter is theirs).
document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !mapState.measuring) return;
    const at = document.activeElement;
    if (at && at !== document.body && at.id !== 'mapBox') return;
    if (mapState.measureTool === 'distance' || mapState.measureTool === 'ring') return;
    e.preventDefault();
    finishMeasure(false);
});

// --- Units ---

// Settings > Units: metric or imperial, for this browser. The button says
// which is on, like MGRS Lock.
const unitsBtn = document.getElementById('toggleUnitsBtn');
const updateUnitsBtnText = () => { if (unitsBtn) unitsBtn.textContent = unitSystem === 'imperial' ? 'Units: Imperial' : 'Units: Metric'; };
updateUnitsBtnText();
if (unitsBtn) {
    unitsBtn.addEventListener('click', () => {
        unitSystem = unitSystem === 'imperial' ? 'metric' : 'imperial';
        writeStored('salt_units', unitSystem);
        updateUnitsBtnText();
        el.menu.panel.style.display = 'none';
        showToast(unitSystem === 'imperial' ? 'Units: imperial (mi and yd, mph, knots for aircraft).' : 'Units: metric (km and m, km/h).');
        renderLog();
        renderMapCard();
        renderMeasureTools();
        showMeasure();
        redrawMap();
    });
}
const toggleBasePop = togglePop('mapBasePop', 'mapBaseBtn');
const toggleDronePop = togglePop('mapDronePop', 'mapDroneBtn');
const toggleExportPop = togglePop('mapExportPop', 'mapExportBtn');
// Escape closes an open menu, back to its button, and goes no further (the
// page's own Escape would cancel an edit in the form). Only from the map, or
// from nowhere in particular.
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const pane0 = document.getElementById('mapPane'), at0 = document.activeElement;
    if (mapState.measuring && (!at0 || at0 === document.body || (pane0 && pane0.contains(at0)))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMapMeasuring(false);
        return;
    }
    const open = [['mapBasePop', 'mapBaseBtn', toggleBasePop], ['mapDronePop', 'mapDroneBtn', toggleDronePop], ['mapExportPop', 'mapExportBtn', toggleExportPop]]
        .find(([popId]) => { const pop = document.getElementById(popId); return pop && !pop.hidden; });
    const pane = document.getElementById('mapPane'), at = document.activeElement;
    if (!open || (at && at !== document.body && !(pane && pane.contains(at)))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    open[2](false);
    document.getElementById(open[1]).focus();
});
document.addEventListener('click', e => {
    const path = e.composedPath();
    if (!path.some(n => n.id === 'mapBasePop' || n.id === 'mapBaseBtn')) toggleBasePop(false);
    if (!path.some(n => n.id === 'mapDronePop' || n.id === 'mapDroneBtn')) toggleDronePop(false);
    if (!path.some(n => n.id === 'mapExportPop' || n.id === 'mapExportBtn')) toggleExportPop(false);
});

// The map itself (made afresh with the view): wheel zooms around the
// pointer, dragging pans, double-click zooms in; hovering a track tells it.
const wireMapBox = () => {
    const m = mapEls();
    const at = (e) => { const r = m.box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    // The longitude and latitude under the pointer.
    const lonLatAt = (e) => {
        const [x, y] = at(e), w = m.box.clientWidth, h = m.box.clientHeight;
        return SaltCore.mercToLonLat(mapState.view.cx + (x - w / 2) * mapState.view.mpp, mapState.view.cy - (y - h / 2) * mapState.view.mpp);
    };
    const zoomAt = (e, factor) => {
        if (!mapState.view) return;
        const [x, y] = at(e), w = m.box.clientWidth, h = m.box.clientHeight;
        const mx = mapState.view.cx + (x - w / 2) * mapState.view.mpp, my = mapState.view.cy - (y - h / 2) * mapState.view.mpp;
        mapState.view.mpp *= factor;
        mapState.view.cx = mx - (x - w / 2) * mapState.view.mpp;
        mapState.view.cy = my + (y - h / 2) * mapState.view.mpp;
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
    // With the map itself focused: arrow keys pan, + and - zoom, 0 shows all.
    m.box.addEventListener('keydown', e => {
        if (e.target !== m.box || !mapState.view || e.ctrlKey || e.metaKey || e.altKey) return;
        const step = 80 * mapState.view.mpp;
        const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
        if (pan) { mapState.view.cx += pan[0]; mapState.view.cy += pan[1]; }
        else if (e.key === '+' || e.key === '=') mapState.view.mpp *= 0.5;
        else if (e.key === '-' || e.key === '_') mapState.view.mpp *= 2;
        else if (e.key === '0') mapState.view.mpp = Infinity;
        // Measuring: Space puts a point at the middle of the map (its crosshair).
        else if (e.key === ' ' && mapState.measuring) { e.preventDefault(); addMeasurePoint(SaltCore.mercToLonLat(mapState.view.cx, mapState.view.cy)); return; }
        else return;
        e.preventDefault();
        redrawMap();
    });
    // Measuring, a double-click finishes a path, area or route instead.
    m.box.addEventListener('dblclick', e => {
        if (e.target.closest('.map-zoom, .map-card, .map-bottom, .map-base-pop, .map-tools, .map-side-btn')) return;
        if (mapState.measuring) finishMeasure(true); else zoomAt(e, 0.5);
    });
    let drag = null;
    m.box.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('.map-zoom, .map-card, .map-bottom, .map-base-pop, .map-tools, .map-side-btn') || !mapState.view) return;
        // A range ring is dragged out from its center rather than the map moved.
        const ring = mapState.measuring && mapState.measureTool === 'ring' && !e.shiftKey && (!mapState.measure.length || mapState.ringR > 0);
        drag = { x: e.clientX, y: e.clientY, cx: mapState.view.cx, cy: mapState.view.cy, item: e.target.closest('[data-map-item]'), ring };
        m.box.setPointerCapture(e.pointerId);
        if (ring) addMeasurePoint(lonLatAt(e));
        else m.box.classList.add('dragging');
    });
    m.box.addEventListener('pointermove', e => {
        mapState.pointer = { clientX: e.clientX, clientY: e.clientY, target: e.target };
        showGridReadout(e, e.shiftKey && !drag);
        if (drag && drag.ring) { hoverMeasure(lonLatAt(e)); return; }
        if (!drag && mapState.measuring && mapState.view) hoverMeasure(lonLatAt(e));
        if (drag) {
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            mapState.view.cx = drag.cx - dx * mapState.view.mpp;
            mapState.view.cy = drag.cy + dy * mapState.view.mpp;
            m.tip.hidden = true;
            // The picture slides; it is drawn afresh once, when the drag ends.
            mapState.dragging = true;
            m.svg.style.transform = m.base.style.transform = `translate(${dx}px, ${dy}px)`;
            return;
        }
        const g = e.target.closest('[data-map-item]');
        const item = g && mapState.items[+g.dataset.mapItem];
        if (!item || !m.card.hidden || e.shiftKey || mapState.measuring) { m.tip.hidden = true; return; }
        m.tip.innerHTML = item.kind === 'drone' ? droneTip(item.d) : trackTip(item.t);
        const [x, y] = at(e);
        m.tip.hidden = false;
        m.tip.style.left = `${Math.min(x + 14, m.box.clientWidth - m.tip.offsetWidth - 6)}px`;
        m.tip.style.top = `${Math.max(6, y - m.tip.offsetHeight - 10)}px`;
    });
    const end = () => {
        drag = null;
        m.box.classList.remove('dragging');
        if (!mapState.dragging) return;
        mapState.dragging = false;
        // Drawn at the new view and the slide undone in one go, so the
        // picture doesn't jump back for a frame.
        cancelAnimationFrame(mapState.frame);
        drawMap();
        m.svg.style.transform = m.base.style.transform = '';
    };
    m.box.addEventListener('pointerup', e => {
        const d = drag;
        end();
        // A ring dragged out: its radius is where the pointer was let go.
        if (d && d.ring) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) addMeasurePoint(lonLatAt(e)); return; }
        // A press that didn't move is a click: on a report, a place, or nothing.
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
        if (e.shiftKey) {
            const g = gridAtPointer(e, m.box);
            if (g && g.mgrs) {
                copyToClipboard(g.mgrs).then(ok => showToast(ok
                    ? `Copied ${g.mgrs}.`
                    : `Couldn't copy ${g.mgrs}: the browser blocked the clipboard.`, !ok));
            }
            return;
        }
        const [x, y] = at(e), w = m.box.clientWidth, h = m.box.clientHeight;
        const merc = [mapState.view.cx + (x - w / 2) * mapState.view.mpp, mapState.view.cy - (y - h / 2) * mapState.view.mpp];
        if (mapState.measuring) { addMeasurePoint(SaltCore.mercToLonLat(merc[0], merc[1])); return; }
        const item = d.item && mapState.items[+d.item.dataset.mapItem];
        if (item && item.kind === 'drone') return;
        m.tip.hidden = true;
        mapState.clickHook({ item, at: [x, y], lonLat: SaltCore.mercToLonLat(merc[0], merc[1]), mpp: mapState.view.mpp });
    });
    m.box.addEventListener('pointercancel', end);
    m.box.addEventListener('pointerleave', () => {
        if (!drag) m.tip.hidden = true;
        mapState.pointer = null;
        if (!drag) hoverMeasure(null);
        showGridReadout(null, false);
    });
    new ResizeObserver(() => redrawMap()).observe(m.box);
};

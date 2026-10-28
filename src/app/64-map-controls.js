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
const renderOverlayMap = (box) => {
    if (!box.querySelector('#mapSvg')) {
        const hours = [[0, 'All'], [24, '24h'], [12, '12h'], [6, '6h']];
        box.innerHTML = `
            <div class="map-pane" id="mapPane">
            <div class="map-box" id="mapBox" tabindex="0" role="region" aria-label="Map" aria-describedby="mapKeys">
                <span id="mapKeys" class="visually-hidden">Arrow keys move the map, plus and minus zoom, 0 shows all, and Escape closes a report's card.</span>
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
                <div id="mapTip" class="map-tip" hidden></div>
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
    box.querySelectorAll('[data-map-layer]').forEach(b => setOn(b, mapLayers[b.dataset.mapLayer], 'aria-pressed', null));
    box.querySelectorAll('[data-map-grids]').forEach(b => setOn(b, (b.dataset.mapGrids === 'all') === mapAllGrids, 'aria-pressed', null));
    // Greyed out, not hidden, when neither layer it changes is on: the tools don't move.
    box.querySelectorAll('[data-map-grids]').forEach(b => { b.disabled = !mapLayers.heat && !mapLayers.reports; });
    box.querySelectorAll('[data-map-hours]').forEach(b => setOn(b, +b.dataset.mapHours === mapHours));
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
            writeStored('salt_map_layers', JSON.stringify(mapLayers));
            renderMapView();
            return;
        }
        const grids = e.target.closest('[data-map-grids]');
        if (grids) {
            mapAllGrids = grids.dataset.mapGrids === 'all';
            writeStored('salt_map_grids', mapAllGrids ? 'all' : 'latest');
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
            if (e.target.id === 'mapDroneShow') droneShow = on; else droneView = on;
            writeStored(e.target.id === 'mapDroneShow' ? 'salt_drone_show' : 'salt_drone_view', on ? 'on' : 'off');
            redrawMap();
            return;
        }
        if (e.target.id === 'mapBaseSelect') {
            mapBaseChoice = e.target.value;
            mapBaseFailed = false;
            writeStored('salt_map_base', mapBaseChoice);
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
const toggleBasePop = togglePop('mapBasePop', 'mapBaseBtn');
const toggleDronePop = togglePop('mapDronePop', 'mapDroneBtn');
// Escape closes an open menu, back to its button, and goes no further (the
// page's own Escape would cancel an edit in the form). Only from the map, or
// from nowhere in particular.
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = [['mapBasePop', 'mapBaseBtn', toggleBasePop], ['mapDronePop', 'mapDroneBtn', toggleDronePop]]
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
});

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
    // With the map itself focused: arrow keys pan, + and - zoom, 0 shows all.
    m.box.addEventListener('keydown', e => {
        if (e.target !== m.box || !mapView || e.ctrlKey || e.metaKey || e.altKey) return;
        const step = 80 * mapView.mpp;
        const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
        if (pan) { mapView.cx += pan[0]; mapView.cy += pan[1]; }
        else if (e.key === '+' || e.key === '=') mapView.mpp *= 0.5;
        else if (e.key === '-' || e.key === '_') mapView.mpp *= 2;
        else if (e.key === '0') mapView.mpp = Infinity;
        else return;
        e.preventDefault();
        redrawMap();
    });
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
            if (g && g.mgrs) {
                copyToClipboard(g.mgrs).then(ok => showToast(ok
                    ? `Copied ${g.mgrs}.`
                    : `Couldn't copy ${g.mgrs}: the browser blocked the clipboard.`, !ok));
            }
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

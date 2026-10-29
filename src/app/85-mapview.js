// SPDX-License-Identifier: AGPL-3.0-only

// The map, under the Report Log's table (the button in its bar slides between
// them; the bar, search included, serves both): the map (app/60-map.js), beside it what's on the map,
// and under it a table of those reports, all linked: clicking a report on the map
// opens its card and picks its row; clicking a row puts the map on it;
// clicking an NAI, OBJ, or phase line narrows the table to it.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let isMapViewActive = false;
// Which of the two is on screen: the Report Log ('list') or the map under it. Per browser.
let logViewMode = storedText('salt_log_view') === 'map' ? 'map' : 'list';
// The table holds only the reports in the part of the map on screen. Per browser.
let mapOnlyInView = storedText('salt_map_only_in_view') !== 'off';
// The sidebar left of the map (activities, busiest places), or hidden. Per browser.
let mapSideShown = storedText('salt_map_side') !== 'hidden';
const applyMapSide = () => {
    document.querySelector('.map-main').classList.toggle('side-hidden', !mapSideShown);
    const btn = document.getElementById('mapSideBtn');
    if (!btn) return;
    setOn(btn, mapSideShown, 'aria-pressed', null);
    btn.title = mapSideShown ? 'Hide the sidebar' : 'Show the sidebar (activities, busiest places)';
};
let mapListTimer = 0;

const mapViewEls = () => ({
    panel: document.getElementById('mapPanel'), host: document.getElementById('mapHost'),
    side: document.getElementById('mapSide'), tiles: document.getElementById('mapTiles'), body: document.getElementById('mapTableBody'),
    title: document.getElementById('mapTableTitle'), chip: document.getElementById('mapPlaceChip'),
    only: document.getElementById('mapOnlyInView'), timeHead: document.getElementById('mapTimeHead'),
});

// --- What's on the map ---

// A report's latest grid in Web Mercator, or null when it has none.
const latestMerc = (t) => { const p = t.points[t.points.length - 1]; return SaltCore.lonLatToMerc(p.lon, p.lat); };
const mapTimeFmt = (t) => (timeDisplayMode === 'local' ? toLocalTimeString : toZuluTimeString)(t);
const placesOfReport = (r) => { const a = locationInfo(r.location); return [...a.nai.keys, ...a.obj.keys, ...a.pls]; };

// The reports the table and the numbers are about: those the map shows, cut
// to the picked place and (when asked) to the part of the map on screen.
// `everyActivity`: before the activity filter, to count what it can pick.
const mapListReports = (everyActivity = false) => {
    const d = mapState.lastDraw;
    if (!d) return [];
    let reps = everyActivity ? mapWindowReports() : d.reps;
    const track = new Map((everyActivity ? SaltCore.reportTracks(reps) : d.tracks).map(t => [t.report.id, t]));
    if (mapState.place) reps = reps.filter(r => placesOfReport(r).includes(mapState.place));
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
    });
    // Every activity there, counted before the activity filter, so more can be picked.
    mapListReports(true).forEach(r => {
        const got = SaltCore.classifyActivity(r.activity).tags;
        (got.length ? got : ['Untagged']).forEach(t => tags.set(t, (tags.get(t) || 0) + 1));
    });
    mapState.activity.forEach(t => { if (!tags.has(t)) tags.set(t, 0); });
    const order = [...SaltCore.ACTIVITY_TAGS.map(([t]) => t), 'Untagged'];
    const top = (m, n) => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], undefined, { numeric: true })).slice(0, n);
    const roll = SaltCore.bdaRollup(reps);
    const tile = (label, value) => `<div class="map-tile"><div class="map-tile-label">${label}</div><div class="map-tile-value">${value}</div></div>`;
    // Always three, so the row never changes shape.
    s.tiles.innerHTML = tile(mapOnlyInView ? 'On the map' : 'Reports', reps.length) + tile('In an NAI or OBJ', inPlace)
        + tile('BDA assessed', roll.total ? `${roll.done} / ${roll.total}` : '&mdash;');
    const places = top(tally, 12);
    const chip = (attr, key, label, n, on) => `<button type="button" class="map-chip map-side-place${on ? ' active' : ''}" ${attr}="${escapeHtml(key)}" aria-pressed="${on}"><span>${escapeHtml(label)}</span><strong>${n}</strong></button>`;
    s.side.innerHTML = `
        <div class="map-side-block">
            <div class="map-side-head">Activity${mapState.activity.size ? ' <button type="button" class="text-btn map-side-clear" data-map-activity="">Show All</button>' : ''}</div>
            <div class="map-chips">${tags.size ? [...tags].sort((x, y) => y[1] - x[1] || order.indexOf(x[0]) - order.indexOf(y[0])).map(([t, n]) => chip('data-map-activity', t, t, n, mapState.activity.has(t))).join('') : '<div class="map-side-empty">No reports</div>'}</div>
        </div>
        <div class="map-side-block">
            <div class="map-side-head">Busiest places</div>
            <div class="map-chips">${places.length ? places.map(([k, n]) => chip('data-map-place', k, k, n, k === mapState.place)).join('') : '<div class="map-side-empty">None named or found by grid</div>'}</div>
        </div>`;
};

const renderMapTable = (reps) => {
    const s = mapViewEls(), local = timeDisplayMode === 'local';
    s.timeHead.textContent = local ? 'Time (L)' : 'Time (Z)';
    s.title.textContent = plural(reps.length, 'report');
    s.only.checked = mapOnlyInView;
    s.chip.innerHTML = mapState.place
        ? `<button type="button" class="map-place-chip" data-map-place="${escapeHtml(mapState.place)}" title="Show every place again">${escapeHtml(mapState.place)} <span aria-hidden="true">&times;</span></button>` : '';
    // Rebuilt after every drawing: a row with the keyboard's focus keeps it.
    const focused = s.body.contains(document.activeElement) ? document.activeElement.dataset.mapRow : null;
    s.body.innerHTML = reps.length ? reps.map(r => `
        <tr data-map-row="${escapeHtml(r.id)}" tabindex="0"${r.id === mapState.selected ? ' class="selected-row"' : ''}>
            <td>${escapeHtml(formatFullId(r))}</td><td>${escapeHtml(r.size || '')}</td><td>${escapeHtml(r.activity || '')}</td>
            <td>${escapeHtml(r.location || '')}</td><td>${escapeHtml(mapTimeFmt(r.time))}</td>
        </tr>`).join('')
        : `<tr class="map-table-empty"><td colspan="5">${mapOnlyInView ? 'No reports on this part of the map. Zoom out, or untick “Only what’s on the map”.' : 'No reports in this window.'}</td></tr>`;
    const again = focused && s.body.querySelector(`[data-map-row="${CSS.escape(focused)}"]`);
    if (again) again.focus({ preventScroll: true });
};

// After each drawing (panning redraws often), once it settles.
mapState.drawnHook = () => {
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
let mapCardFrom = null; // the table row it was opened from (by id), for Escape to go back to; null: the map

const renderMapCard = () => {
    const card = document.getElementById('mapCard');
    if (!card) return;
    const r = mapState.selected && localReports.find(x => x.id === mapState.selected && !x.deleted);
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
            <button type="button" class="text-btn" data-card-act="table">Show in Table</button>
            <button type="button" class="text-btn editor-only" data-card-act="edit">Edit</button>
        </div>`;
    card.hidden = false;
    positionMapCard();
};
// Beside the report, kept inside the map (and clear of the sidebar, when
// it's there: full screen leaves it behind).
const positionMapCard = () => {
    const card = document.getElementById('mapCard'), box = document.getElementById('mapBox');
    if (!card || card.hidden || !box || !mapCardAt) return;
    const [x, y] = mapCardAt, w = box.clientWidth, h = box.clientHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const room = parseFloat(getComputedStyle(box).getPropertyValue('--side-room')) || 0;
    const left = room > 10 ? room : 8;
    card.style.left = `${Math.max(left, Math.min(x + 16 + cw > w - 8 ? x - 16 - cw : x + 16, w - cw - 8))}px`;
    card.style.top = `${Math.max(8, Math.min(y - ch / 2, h - ch - 8))}px`;
};

const selectMapReport = (id, at) => {
    mapState.selected = id;
    mapCardAt = at || null;
    renderMapCard();
    redrawMap();
};

// Put the map on a report and pulse its ring. Zoomed all the way out, it
// zooms in on it first (the whole area can't move to center one report).
const centerMapOn = (id) => {
    const t = mapState.lastDraw && mapState.lastDraw.tracks.find(x => x.report.id === id);
    if (!t || !mapState.view) return false;
    if (mapState.view.mpp >= mapState.fitMpp * 0.99) mapState.view.mpp = mapState.fitMpp / 4;
    [mapState.view.cx, mapState.view.cy] = latestMerc(t);
    mapState.flashUntil = Date.now() + 1600;
    return true;
};

// A click on the map: a report opens its card; an NAI, OBJ, or phase line
// narrows the table to it (again to widen it); anywhere else closes the card.
mapState.clickHook = ({ item, at, lonLat: [lon, lat], mpp }) => {
    if (item && item.t) { mapCardFrom = null; selectMapReport(item.t.report.id, at); return; }
    const near = mpp * Math.cos(lat * Math.PI / 180) * 10;   // ten pixels, on the ground
    const lines = currentOverlays().filter(o => o.type === 'PL' && SaltCore.metersToGeometry(o.geometry, lon, lat) <= near);
    const areas = currentOverlays().filter(o => o.type !== 'PL' && /Polygon|LineString/.test((o.geometry || {}).type || '')
        && SaltCore.geometryContains(SaltCore.asArea(o.geometry), lon, lat));
    const hit = lines[0] || areas[0];
    if (hit) { mapState.place = overlayKey(hit) === mapState.place ? '' : overlayKey(hit); redrawMap(); return; }
    if (mapState.selected) selectMapReport('', null);
};

// --- The view ---

// Play: the time slider's end walks from the first report to now in about
// ten seconds, so movement can be watched; Pause stops it where it is.
const MAP_PLAY_MS = 10000, MAP_PLAY_STEPS = 100;
let mapPlayTimer = 0;
const stopMapPlay = () => { clearInterval(mapPlayTimer); mapPlayTimer = 0; };
const toggleMapPlay = () => {
    if (mapPlayTimer) { stopMapPlay(); renderMapTime(); return; }
    const range = document.getElementById('mapEndRange');
    if (!range || range.disabled) return;
    const first = +range.dataset.first;
    // From where it stands, or from the start when it stands at now.
    let at = mapState.end === null ? 0 : Math.round((mapState.end - first) / Math.max(1, Date.now() - first) * MAP_PLAY_STEPS);
    if (at >= MAP_PLAY_STEPS) at = 0;
    const step = () => {
        at++;
        if (at >= MAP_PLAY_STEPS) { mapState.end = null; stopMapPlay(); }
        else mapState.end = Math.round(first + (Date.now() - first) * at / MAP_PLAY_STEPS);
        renderMapView();
    };
    mapPlayTimer = setInterval(step, MAP_PLAY_MS / MAP_PLAY_STEPS);
    step();
};

// The time slider: from the first report to now; at its right end, "now".
const renderMapTime = () => {
    const range = document.getElementById('mapEndRange'), label = document.getElementById('mapEndLabel'), now = document.getElementById('mapEndNow');
    if (!range) return;
    // The earliest, by a loop (Math.min(...) runs out of stack on very many reports).
    let first = Infinity;
    localReports.forEach(r => {
        const t = r.deleted ? NaN : new Date(r.time).getTime();
        if (t < first) first = t;
    });
    const any = first !== Infinity;
    if (!any) first = Date.now();
    range.dataset.first = String(first);
    range.disabled = !any;
    const play = document.getElementById('mapEndPlay');
    if (play) {
        play.disabled = !any;
        play.textContent = mapPlayTimer ? 'Pause' : 'Play';
        play.setAttribute('aria-pressed', String(!!mapPlayTimer));
    }
    const span = Math.max(1, Date.now() - first);
    range.value = String(mapState.end === null ? 1000 : Math.round((mapState.end - first) / span * 1000));
    const local = timeDisplayMode === 'local';
    label.textContent = mapState.end === null ? 'Now' : SaltCore.dtg(mapState.end, local);
    // Read out as the time it shows, not a number out of 1000.
    range.setAttribute('aria-valuetext', label.textContent);
    now.hidden = mapState.end === null;
};

const renderMapView = () => {
    const s = mapViewEls();
    if (!s.panel || !isMapViewActive) return;
    renderMapPanel(s.host);
    applyMapSide();
    renderMapTime();
    renderMapCard();
};

// The Report Log, or the map under it, on screen: where closing another view
// comes back to. `slide`: animate from one to the other (otherwise it's
// simply there, as when coming back from another view).
const MAP_BTN_ICONS = { map: null, list: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>' };
const showHomeView = (slide = false) => {
    const pager = document.getElementById('homePager');
    const map = logViewMode === 'map';
    isMapViewActive = map;
    if (!map && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (!slide) pager.classList.add('instant');
    document.getElementById('homeView').style.display = '';
    // The bar's button: to the map from the table, back to the table from the map.
    const btn = document.querySelector('[data-home-go]');
    if (MAP_BTN_ICONS.map === null) MAP_BTN_ICONS.map = btn.innerHTML;
    btn.dataset.homeGo = map ? 'list' : 'map';
    btn.innerHTML = MAP_BTN_ICONS[map ? 'list' : 'map'];
    btn.title = map ? 'Back to the Report Log' : 'Show the map';
    btn.setAttribute('aria-label', btn.title);
    // The bar says which is on screen.
    setTopBar('home', map ? 'Map' : 'Report Log');
    // Drawn before it slides in, so it arrives whole.
    if (map) renderMapView();
    pager.classList.toggle('on-map', map);
    el.log.view.inert = map;
    mapViewEls().panel.inert = !map;
    if (!slide) {
        requestAnimationFrame(() => requestAnimationFrame(() => pager.classList.remove('instant')));
        animateIn(document.getElementById('homeView'));
    }
    writeStored('salt_view', 'log');
};
const slideHome = (mode) => {
    if (mode === logViewMode) return;
    logViewMode = mode;
    writeStored('salt_log_view', logViewMode);
    showHomeView(true);
};
// Another view takes the panel: the Report Log and its map step aside.
const hideHomeViews = () => {
    isMapViewActive = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.getElementById('homeView').style.display = 'none';
};

// --- Wiring ---

(() => {
    const s = mapViewEls();
    if (!s.panel) return;
    // The button by each heading: the map from the Report Log, the Report Log from the map.
    document.addEventListener('click', e => {
        const b = e.target.closest('[data-home-go]');
        if (b) slideHome(b.dataset.homeGo);
    });
    s.panel.addEventListener('click', e => {
        const place = e.target.closest('[data-map-place]');
        if (place) { mapState.place = place.dataset.mapPlace === mapState.place ? '' : place.dataset.mapPlace; redrawMap(); return; }
        // Activities beside the map: several can be picked; Show all clears them.
        const pick = e.target.closest('[data-map-activity]');
        if (pick) {
            const t = pick.dataset.mapActivity;
            if (!t) mapState.activity.clear();
            else if (mapState.activity.has(t)) mapState.activity.delete(t);
            else mapState.activity.add(t);
            renderMapView();
            return;
        }
        const act = e.target.closest('[data-card-act]');
        if (act) {
            const id = mapState.selected;
            if (act.dataset.cardAct === 'close') selectMapReport('', null);
            else if (act.dataset.cardAct === 'edit') loadReportForEditing(id);
            else {
                // The table may hide it (another place, or off this part of the map).
                const row = () => s.body.querySelector(`[data-map-row="${CSS.escape(id)}"]`);
                if (!row()) { mapState.place = ''; mapOnlyInView = false; writeStored('salt_map_only_in_view', 'off'); renderMapTable(mapListReports()); }
                const tr = row();
                if (tr) showRow(tr, tr.closest('.map-view'));
            }
            return;
        }
        if (e.target.id === 'mapEndNow') { stopMapPlay(); mapState.end = null; renderMapView(); return; }
        if (e.target.id === 'mapEndPlay') { toggleMapPlay(); return; }
        if (e.target.closest('#mapSideBtn')) {
            mapSideShown = !mapSideShown;
            writeStored('salt_map_side', mapSideShown ? 'shown' : 'hidden');
            applyMapSide();
            return;
        }
        const tr = e.target.closest('[data-map-row]');
        if (tr) {
            const id = tr.dataset.mapRow;
            const centered = centerMapOn(id);
            mapState.selected = id;
            mapCardFrom = id;
            // Drawn now, so the card can open beside where the report landed
            // (at the middle, unless the edge of the area held the map back).
            drawMap();
            const box = document.getElementById('mapBox'), ring = document.querySelector('#mapSvg .map-selected circle');
            mapCardAt = centered && box && ring ? [+ring.getAttribute('cx'), +ring.getAttribute('cy')] : null;
            renderMapCard();
        }
    });
    // A row with the keyboard's focus: Enter or Space does what a click does.
    s.body.addEventListener('keydown', e => {
        const tr = (e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-map-row]');
        if (!tr || e.target !== tr) return;
        e.preventDefault();
        tr.click();
    });
    // Escape closes the report's card, back to the row (or the map) it was
    // opened from, and goes no further (the page's own Escape would cancel an
    // edit in the form). Only from the map view, or from nowhere in particular.
    document.addEventListener('keydown', e => {
        const card = document.getElementById('mapCard'), at = document.activeElement;
        if (e.key !== 'Escape' || !isMapViewActive || !card || card.hidden) return;
        if (at && at !== document.body && !s.panel.contains(at)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const from = mapCardFrom;
        selectMapReport('', null);
        const back = (from && s.body.querySelector(`[data-map-row="${CSS.escape(from)}"]`)) || document.getElementById('mapBox');
        if (back) back.focus({ preventScroll: true });
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
        stopMapPlay();   // the slider taken in hand stops Play
        const v = +e.target.value, first = +e.target.dataset.first;
        mapState.end = v >= 1000 ? null : Math.round(first + (Date.now() - first) * v / 1000);
        renderMapView();
    });
})();

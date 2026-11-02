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
let logViewMode = readRaw('salt_log_view') === 'map' ? 'map' : 'list';
// The table holds only the reports in the part of the map on screen. Per browser.
let mapOnlyInView = readRaw('salt_map_only_in_view') !== 'off';
// The sidebar left of the map (activities, busiest places), or hidden. Per browser.
let mapSideShown = readRaw('salt_map_side') !== 'hidden';
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
// The places a report is at: NAIs, OBJs, phase lines, and the graphics of
// the team's tags it names or is inside (by name, as graphicName gives it).
const placesOfReport = (r) => { const a = locationInfo(r.location); return [...a.nai.keys, ...a.obj.keys, ...a.pls, ...a.custom.map(c => c.key)]; };

// The reports the table and the numbers are about: those the map shows, cut
// to the picked place and (when asked) to the part of the map on screen.
// `everyActivity`: before the activity filter, to count what it can pick.
// A report's track hangs on that report alone, so the drawing's are used, and
// only those of the reports it left out (another activity, the search) are
// worked out here.
const mapListReports = (everyActivity = false) => {
    const d = mapState.lastDraw;
    if (!d) return [];
    let reps = everyActivity ? mapWindowReports() : d.reps;
    const track = new Map(d.tracks.map(t => [t.report, t]));
    if (everyActivity) {
        const drawn = new Set(d.reps);
        SaltCore.reportTracks(reps.filter(r => !drawn.has(r))).forEach(t => track.set(t.report, t));
    }
    if (mapState.place) reps = reps.filter(r => placesOfReport(r).includes(mapState.place));
    if (mapOnlyInView && d.view) {
        const [x0, y0, x1, y1] = d.view;
        reps = reps.filter(r => {
            const t = track.get(r);
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
        const a = locationInfo(r.location);
        if (a.nai.keys.length || a.obj.keys.length) inPlace++;
        placesOfReport(r).forEach(k => tally.set(k, (tally.get(k) || 0) + 1));
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
        + tile('BDA assessed', roll.total ? `${roll.done} / ${roll.total}` : 'None');
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

let mapTableBuilt = null;   // the rows last put in the table, as markup
const renderMapTable = (reps) => {
    const s = mapViewEls(), local = timeDisplayMode === 'local';
    s.timeHead.textContent = local ? 'Time (L)' : 'Time (Z)';
    s.title.textContent = plural(reps.length, 'report');
    s.only.checked = mapOnlyInView;
    s.chip.innerHTML = mapState.place
        ? `<button type="button" class="map-place-chip" data-map-place="${escapeHtml(mapState.place)}" title="Show every place again">${escapeHtml(mapState.place)} <span aria-hidden="true">&times;</span></button>` : '';
    const team = narrTeam();
    const rows = reps.length ? reps.map(r => `
        <tr data-map-row="${escapeHtml(r.id)}" tabindex="0"${r.id === mapState.selected ? ' class="selected-row"' : ''}>
            <td>${escapeHtml(formatFullId(r))}</td><td>${escapeHtml(SaltCore.sizeAfterBda(r, team).shown)}</td><td>${escapeHtml(r.activity || '')}</td>
            <td>${escapeHtml(r.location || '')}</td><td>${escapeHtml(mapTimeFmt(r.time))}</td>
        </tr>`).join('')
        : `<tr class="map-table-empty"><td colspan="5">${mapOnlyInView ? 'No reports on this part of the map. Zoom out, or untick “Only what’s on the map”.' : 'No reports in this window.'}</td></tr>`;
    // The rows' markup is the fingerprint of all they show (which reports, in
    // what order; each one's ID, Size after BDA, Activity, Location and time in
    // the time mode; the picked row; the empty table's words): the same as the
    // last built, the table is left as it is, the keyboard's place and all
    // (most settles, a pan that keeps the same reports in view, say). Only the
    // picked row's mark is put back, which the form takes off every row when it
    // is cleared.
    if (rows === mapTableBuilt && s.body.isConnected && s.body.childElementCount) {
        const picked = mapState.selected && s.body.querySelector(`[data-map-row="${CSS.escape(mapState.selected)}"]`);
        if (picked) picked.classList.add('selected-row');
        return;
    }
    mapTableBuilt = rows;
    // Rebuilt: a row with the keyboard's focus keeps it.
    const focused = s.body.contains(document.activeElement) ? document.activeElement.dataset.mapRow : null;
    s.body.innerHTML = rows;
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
    if (mapState.axis) { renderAxisCard(card); return; }
    const r = mapState.selected && localReports.find(x => x.id === mapState.selected && !x.deleted);
    if (!r || !mapCardAt) { card.hidden = true; return; }
    const local = timeDisplayMode === 'local';
    const row = (label, value) => (value ? `<div class="map-card-row"><span>${label}</span><div>${escapeHtml(value)}</div></div>` : '');
    const b = SaltCore.bdaSummary(r);
    // Its Size after BDA, what came off under it (SaltCore.sizeAfterBda).
    const size = SaltCore.sizeAfterBda(r, narrTeam());
    const sizeRow = size.note
        ? `<div class="map-card-row"><span>Size</span><div>${escapeHtml(size.shown)}<span class="size-bda-note" title="Logged as ${escapeHtml(size.logged)}">${escapeHtml(size.note)}</span></div></div>`
        : row('Size', size.size);
    // Its rate of march when its track has times to go by: overall (or its
    // one leg), then each leg's, in this browser's units for what it is.
    const march = (r.history || []).length ? marchOf(r) : { legs: [] };
    const all = march.overall, as = ` (as ${MARCH_CLASS_WORDS[march.kind]})`, legs = march.legs.map(l => marchSpeed(l, march.kind)).join(', ');
    const marchRows = !march.legs.length ? ''
        : !all ? row('Rate of march', `${legs}${as}`)
        : row('Rate of march', `${marchSpeed(all, march.kind)}${march.legs.length > 1 ? ' overall' : ''}, ${SaltCore.formatDistance(all.meters, unitSystem, march.kind)} in ${SaltCore.formatDuration(all.hours)}${as}`)
            + (march.legs.length > 1 ? row('Each leg', legs) : '');
    card.innerHTML = `
        <div class="map-card-head"><strong>${escapeHtml(formatFullId(r))}</strong>
            <button type="button" class="map-card-close" data-card-act="close" title="Close" aria-label="Close">&times;</button></div>
        ${sizeRow}${row('Activity', r.activity)}${row('Location', r.location)}
        ${row(local ? 'Time (L)' : 'Time (Z)', mapTimeFmt(r.time))}${row('Observer', r.observer)}${row('Analysis', r.yourAnalysis)}
        ${b.total && (r.bda || []).length ? row('BDA', `${b.done} of ${b.total} assessed`) : ''}
        ${(r.history || []).length ? row('Updates', String(r.history.length)) : ''}${marchRows}${sightRows(r)}
        <div class="map-card-actions">
            <button type="button" class="text-btn" data-card-act="table">Show in Table</button>
            <button type="button" class="text-btn editor-only" data-card-act="edit">Edit</button>
        </div>`;
    card.hidden = false;
    positionMapCard();
};
// What the report can see and its weapons reach (SaltCore.sightPicture),
// as the narrative says them; with no elevation source, its reach only.
// Lines still waiting for heights that aren't coming say why.
const sightRows = (r) => {
    const pic = SaltCore.sightPicture(r, currentOverlays(), sharedNarrative, terrainInput());
    const row = (label, value) => (value ? `<div class="map-card-row"><span>${label}</span><div>${escapeHtml(value)}</div></div>` : '');
    if (!pic) return '';
    return row('Sight', pic.sight && `${pic.sight[0].toUpperCase()}${pic.sight.slice(1)}.`) + row('Reach', pic.reach && `${pic.reach[0].toUpperCase()}${pic.reach.slice(1)}.`)
        + row('Terrain', pic.lines.some(l => l.state === 'waiting') && terrainUnavailable());
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
    mapState.axis = '';
    mapCardAt = at || null;
    renderMapCard();
    redrawMap();
};

// --- An axis of advance's card ---

// An axis clicked on the map: its card, with its name and length, and for
// editors Remove, which asks in place first, then removes it for everyone
// (as Manage does, with Undo). The axis is drawn wider while its card is open.
const axisOnMap = (key) => currentOverlays().find(o => tagOf(o.type).axis && graphicName(o) === key) || null;
const selectMapAxis = (key, at) => {
    mapState.selected = '';
    mapState.axis = key;
    mapCardAt = at || null;
    renderMapCard();
    redrawMap();
};
const renderAxisCard = (card) => {
    const o = axisOnMap(mapState.axis);
    // Gone (a sync removed it, say): the card goes too.
    if (!o || !mapCardAt) { mapState.axis = ''; card.hidden = true; return; }
    const key = graphicName(o), ask = isAsking(`axis|${key}`);
    const parts = o.geometry.type === 'MultiLineString' ? o.geometry.coordinates : [o.geometry.coordinates];
    const meters = parts.reduce((s, l) => s + SaltCore.pathMeters(l.map(([lon, lat]) => ({ lon, lat }))), 0);
    card.innerHTML = `
        <div class="map-card-head"><strong>${escapeHtml(key)}</strong>
            <button type="button" class="map-card-close" data-card-act="close" title="Close" aria-label="Close">&times;</button></div>
        <div class="map-card-row"><span>Graphic</span><div>Axis of advance</div></div>
        <div class="map-card-row"><span>Length</span><div>${escapeHtml(SaltCore.formatDistance(meters, unitSystem))}</div></div>
        ${isReadOnly ? '' : `<div class="map-card-actions editor-only">
            <button type="button" class="text-btn map-card-remove" data-card-act="remove-axis"${ask ? ' data-asking' : ''} aria-label="${ask ? `Remove ${escapeHtml(key)} for everyone?` : `Remove ${escapeHtml(key)}`}">${ask ? 'Remove for everyone?' : 'Remove'}</button>
        </div>`}`;
    card.hidden = false;
    positionMapCard();
};
// The first press asks; the second removes it for everyone, the card with it.
const removeMapAxis = () => {
    const key = mapState.axis, o = axisOnMap(key);
    if (!o || isReadOnly) { selectMapReport('', null); return; }
    if (!askFirst(`axis|${key}`, renderMapCard)) return;
    selectMapReport('', null);
    const box = document.getElementById('mapBox');
    if (box) box.focus({ preventScroll: true });
    removeOverlays([o], `${key} removed.`);
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

// A click on the map: a report opens its card; an axis of advance within ten
// pixels, its card (it names no place); an NAI, OBJ, phase line or graphic of
// the team's tags narrows the table to it (again to widen it); anywhere else
// closes the card. Lines first, within ten pixels; then areas. Graphics with
// no tag, or whose tag is switched off in the key, aren't picked.
mapState.clickHook = ({ item, at, lonLat: [lon, lat], mpp }) => {
    if (item && item.t) { mapCardFrom = null; selectMapReport(item.t.report.id, at); return; }
    const near = mpp * Math.cos(lat * Math.PI / 180) * 10;   // ten pixels, on the ground
    const drawn = currentOverlays().map(o => [o, tagOf(o.type)]).filter(([o, t]) => !t.none && !mapState.tagsOff.has(t.key) && o.geometry);
    const axis = drawn.find(([o, t]) => t.axis && SaltCore.metersToGeometry(o.geometry, lon, lat) <= near);
    if (axis) { mapCardFrom = null; selectMapAxis(graphicName(axis[0]), at); return; }
    const shown = drawn.filter(([, t]) => !t.axis).map(([o, t]) => [o, t.shape === 'area' ? SaltCore.asArea(o.geometry) : o.geometry]);
    const lines = shown.filter(([, g]) => /LineString/.test(g.type) && SaltCore.metersToGeometry(g, lon, lat) <= near);
    const areas = shown.filter(([, g]) => /Polygon/.test(g.type) && SaltCore.geometryContains(g, lon, lat));
    const hit = (lines[0] || areas[0] || [])[0];
    if (hit) { const k = graphicName(hit); mapState.place = k === mapState.place ? '' : k; redrawMap(); return; }
    if (mapState.selected || mapState.axis) selectMapReport('', null);
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
            else if (act.dataset.cardAct === 'remove-axis') removeMapAxis();
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

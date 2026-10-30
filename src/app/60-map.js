// SPDX-License-Identifier: AGPL-3.0-only

// The map drawn in the Map view (app/49-mapview.js): the shared NAIs, OBJs
// and phase lines in Web Mercator, over an optional WMS or tile basemap fetched
// only for the area the graphics cover, with the shown workspace's reports in
// layers turned on and off together: a heat map, tracks, and dots. Plain SVG
// drawn in screen pixels; no map library.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// A setting this browser keeps as plain text (not JSON, so not readStored's),
// or null when there is none or storage is blocked. Used by the map, its
// view and Statistics; writes go through writeStored.
const storedText = (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } };

// core: the white center of a report dot, so a dot shows on the red of a busy heat map.
// none: an Unknown graphic, with no tag (app/50-overlays.js): gray, its dot in the list.
// AXIS: an axis of advance, the enemy's dark red, wider than a track and on a white edge.
// goto: the X on a grid gone to, yellow on a black edge, unlike anything else drawn.
const MAP_COLORS = { NAI: '#32d74b', OBJ: '#0a84ff', PL: '#000000', AXIS: '#b0001e', track: '#ff3b30', edge: '#000000', core: '#ffffff', none: '#8e8e93', goto: '#ffd60a' };
// The layers on, in any mix (per browser); the heat map alone to start with.
const MAP_LAYERS = [['heat', 'Heat map'], ['tracks', 'Tracks'], ['reports', 'Reports']];
// Everything the map keeps between drawings, in one place: what this browser
// shows, what is picked, the view, and the work in flight. The map's five
// scripts (app/60-map.js to app/64-map-controls.js) read and write it here.
const mapState = {
    layers: (() => {
        const v = readStored('salt_map_layers', null);
        if (v && typeof v === 'object') return { heat: !!v.heat, tracks: !!v.tracks, reports: !!v.reports };
        return { heat: true, tracks: false, reports: false };
    })(),
    // The heat map and the dots: each report at its latest grids, or every saved
    // report (its updates too) at its grids. Per browser.
    allGrids: storedText('salt_map_grids') === 'all',
    activity: new Set(),   // the activity tags picked; none for every report
    // The graphics' tags switched off in the key, by id ('none': no tag). Per browser.
    tagsOff: new Set((v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []))(readStored('salt_map_tags_off', []))),
    hours: 0,              // the window, in hours back from its end; 0 for all
    end: null,             // the window's end (ms), set by the time slider; null for now
    selected: '',          // the report picked on the map or in its table, by id
    place: '',             // the NAI / OBJ / PL picked on the map ('NAI 1'), or ''
    axis: '',              // the axis of advance clicked, its card open ('AXIS GOLD'), or ''
    // Go to a grid (app/64-map-controls.js): the grid typed, marked with an X
    // while its box is open: { lon, lat, mgrs }, or null. This browser's, not kept.
    goto: null,
    labelBoxes: [],        // the names the last drawing placed: [x0, y0, x1, y1] each, on screen
    lastDraw: null,        // what the last drawing showed: { view, tracks, reps }
    flashUntil: 0,         // the picked report's ring pulses until then (ms)
    fitMpp: Infinity,      // meters per pixel with the whole area in view
    // Set by the Map view: told after each drawing, and of a click on the map.
    drawnHook: () => {},
    clickHook: () => {},
    view: null,            // { cx, cy, mpp }: center (Web Mercator meters) and meters per pixel
    // The basemap this browser shows, by name: 'off' for none, '' for the first.
    baseChoice: storedText('salt_map_base') || '',
    baseFailed: false,
    wmsTimer: null,
    wmsGen: 0,             // the WMS request whose image may still go on screen
    frame: 0,
    items: [],             // what the pointer can hover: [{ kind, ...}] by index
    lastWant: null,        // the Web Mercator box the basemap was last asked for
    // The heat map's grid (app/61-map-draw.js), kept between drawings.
    heatGrid: new Float32Array(0),
    // A WMS being looked up (app/62-map-basemaps.js): the link (and a name typed
    // for it), then what its capabilities offer and which layers are ticked.
    // `edit` names the saved service whose layers these are (null when adding one).
    wmsFind: null,         // { link, edit, busy, error, title, version, getMap, formats, layers: [{ name, title, crs, missing }], picked: Set, via }
    baseCheck: null,       // { name, ok, text }: what Check found for a service
    baseOpen: null,        // the saved service whose details are open, by name
    // Whether the drones (app/63-map-drones.js) show, and whether their view
    // does, is each browser's own choice.
    droneShow: storedText('salt_drone_show') !== 'off',
    droneView: storedText('salt_drone_view') !== 'off',
    pointer: null,         // where the pointer last was over the map: { clientX, clientY, target }
    // While the map is dragged, the picture already drawn slides with the
    // pointer and nothing redraws (app/64-map-controls.js); it is drawn once,
    // at the new view, when the drag ends.
    dragging: false,
    // The measure tools (app/64-map-controls.js): on, which one, and the
    // points clicked ([{ lon, lat }]). Distance takes two (a third click
    // starts again from it); Path, Area and Time-distance take any number
    // until finished (`measureDone`); Range ring takes its center, then its
    // radius (`ringR`, meters). `measureHover` is where the pointer is, for
    // the line or ring still to be placed.
    measuring: false,
    measureTool: 'distance',
    measure: [],
    measureDone: false,
    ringR: 0,
    measureHover: null,
    measurePx: null,       // the last drawing's lon/lat to screen, for refreshMeasure (app/61-map-draw.js)
    // The time-distance tool's speed: a standard rate by id, and km/h.
    // Time-distance: the speed as typed (empty until one is, then kept in
    // this browser) and its unit's id (SPEED_UNITS in app/64-map-controls.js).
    measureSpeed: '',
    measureUnit: '',
    // Range rings kept on the map, this browser's own: [{ lon, lat, r }], r in meters.
    rings: (() => {
        const v = readStored('salt_range_rings', []);
        return Array.isArray(v) ? v.filter(g => g && isFinite(g.lon) && isFinite(g.lat) && g.r > 0).slice(0, 20) : [];
    })(),
};
// Metric or imperial, this browser's own (Settings > Units): the map's
// measures and a report's rate of march follow it (SaltCore.formatDistance).
let unitSystem = storedText('salt_units') === 'imperial' ? 'imperial' : 'metric';
// A report's rate of march (SaltCore.marchRates) for what it moves as, from
// the catalogue and the team's equipment: { kind, legs, overall }. Its map
// card and its history rows in the Report Log show it.
const marchOf = (r) => {
    const kind = SaltCore.movementClass(r.size, narrTeam());
    return { kind, ...SaltCore.marchRates(r, kind) };
};
const marchSpeed = (rate, kind) => SaltCore.formatSpeed(rate.kmh, unitSystem, kind);
// "vehicles", "dismounts", "aircraft": what the rate is reckoned for.
const MARCH_CLASS_WORDS = { vehicle: 'vehicles', dismount: 'dismounts', aircraft: 'aircraft' };
const activeBasemap = () => (mapState.baseChoice === 'off' ? null
    : sharedBasemaps.find(b => b.name === mapState.baseChoice) || sharedBasemaps[0] || null);

const mapEls = () => ({
    box: document.getElementById('mapBox'), svg: document.getElementById('mapSvg'),
    base: document.getElementById('mapBase'), tip: document.getElementById('mapTip'),
    note: document.getElementById('mapNote'), legend: document.getElementById('mapLegend'),
    card: document.getElementById('mapCard'), hint: document.getElementById('mapHint'),
});

// The shown workspace's reports in the window (the last `mapState.hours` before its
// end, or all up to its end).
const mapWindowReports = () => {
    let reps = localReports.filter(r => !r.deleted);
    const end = mapState.end;
    if (end !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() <= end);
    if (mapState.hours) {
        const from = (end === null ? Date.now() : end) - mapState.hours * 3600000;
        reps = reps.filter(r => r.time && new Date(r.time).getTime() >= from);
    }
    return reps;
};
// The reports the map shows: those, with a picked activity, that the
// Report Log's search finds.
const mapReports = () => {
    const q = el.log.search.value.toLowerCase();
    return mapWindowReports().filter(r => SaltCore.activityMatches(r.activity, mapState.activity) && matchesSearch(r, q));
};

// A graphic's box in Web Mercator, [x0, y0, x1, y1], worked out once for each
// (a sync brings new objects, and the old ones' boxes go with them): for the
// area the map covers, and to leave the graphics wholly off screen out of a
// drawing, which keeps the map quick with thousands of them.
const overlayBoxes = new WeakMap();
const overlayBox = (o) => {
    let b = overlayBoxes.get(o);
    if (b) return b;
    b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = v => {
        if (typeof v[0] !== 'number') { v.forEach(walk); return; }
        const [x, y] = SaltCore.lonLatToMerc(v[0], v[1]);
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
    };
    if (o.geometry && Array.isArray(o.geometry.coordinates)) walk(o.geometry.coordinates);
    overlayBoxes.set(o, b);
    return b;
};

// The area the map covers: the overlays drawn (not Unknown ones), the drones,
// the grid gone to and the reports' grids, padded so that, zoomed all the way
// out, they clear the controls along the top and the key and slider along the
// foot (more room above and below than at the sides). The basemap is asked
// for this area only. Null when there is nothing to show.
const mapExtent = (tracks) => {
    const pts = [];
    currentOverlays().forEach(o => {
        if (!o.geometry || tagOf(o.type).none) return;
        const b = overlayBox(o);
        if (b[0] <= b[2]) pts.push([b[0], b[1]], [b[2], b[3]]);
    });
    tracks.forEach(t => t.points.forEach(p => pts.push(SaltCore.lonLatToMerc(p.lon, p.lat))));
    // A drone, or the grid gone to, with room round it, so Zoom can put it in the middle.
    const room = ({ lon, lat }) => { const [x, y] = SaltCore.lonLatToMerc(lon, lat); pts.push([x - 3000, y - 3000], [x + 3000, y + 3000]); };
    shownDrones().forEach(({ p }) => room(p));
    if (mapState.goto) room(mapState.goto);
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
    mapState.fitMpp = fit;
    const v = mapState.view;
    v.mpp = Math.min(fit, Math.max(0.25, v.mpp));
    const hw = w * v.mpp / 2, hh = h * v.mpp / 2;
    v.cx = hw * 2 >= ext[2] - ext[0] ? (ext[0] + ext[2]) / 2 : Math.min(ext[2] - hw, Math.max(ext[0] + hw, v.cx));
    v.cy = hh * 2 >= ext[3] - ext[1] ? (ext[1] + ext[3]) / 2 : Math.min(ext[3] - hh, Math.max(ext[1] + hh, v.cy));
};

const svgEsc = escapeHtml;

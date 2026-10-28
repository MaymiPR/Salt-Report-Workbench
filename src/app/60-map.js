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

const MAP_COLORS = { NAI: '#32d74b', OBJ: '#0a84ff', PL: '#000000', track: '#ff3b30', edge: '#000000' };
// The layers on, in any mix (per browser); the heat map alone to start with.
const MAP_LAYERS = [['heat', 'Heat map'], ['tracks', 'Tracks'], ['reports', 'Reports']];
const mapLayers = (() => {
    const v = readStored('salt_map_layers', null);
    if (v && typeof v === 'object') return { heat: !!v.heat, tracks: !!v.tracks, reports: !!v.reports };
    return { heat: true, tracks: false, reports: false };
})();
// The heat map and the dots: each report at its latest grids, or every saved
// report (its updates too) at its grids. Per browser.
let mapAllGrids = storedText('salt_map_grids') === 'all';
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
let mapBaseChoice = storedText('salt_map_base') || '';
const activeBasemap = () => (mapBaseChoice === 'off' ? null
    : sharedBasemaps.find(b => b.name === mapBaseChoice) || sharedBasemaps[0] || null);
let mapBaseFailed = false;
let mapWmsTimer = null;
let mapWmsGen = 0;             // the WMS request whose image may still go on screen
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

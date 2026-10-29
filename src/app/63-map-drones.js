// SPDX-License-Identifier: AGPL-3.0-only

// The drones on the map (app/60-map.js): where each is, its view and range,
// drawing them, their menu, and saving them for everyone. Their clicks are
// handled with the map's others (app/64-map-controls.js).
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.
// --- Drones ---

// Where each drone was last put (shared; editors move it). Whether they show,
// and whether their view does, is each browser's own choice (mapState).
const DRONE_COLOR = '#ff9f0a';
// The sync server's limits (MAX_DRONES, MAX_DRONE_RANGE_KM in server/salt_sync_server.py).
const MAX_DRONES = 10, MAX_DRONE_RANGE_KM = 1000;
const dronePoint = (d) => { const g = SaltCore.findGrids(d.grid)[0]; return g ? { lon: g.lon, lat: g.lat } : null; };
const shownDrones = () => (mapState.droneShow ? sharedDrones.map(d => ({ d, p: dronePoint(d) })).filter(x => x.p) : []);
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
    const newest = mapState.droneView && tracks.length ? tracks.reduce((a, b) => (when(b) > when(a) ? b : a)) : null;
    const defs = [], cones = [], marks = [];
    list.forEach(({ d, p }, i) => {
        const [x, y] = px(p.lon, p.lat);
        let angle = 0;
        // Its range, as a ring: metres on the ground to pixels at its latitude.
        if (mapState.droneView && d.range && mapState.view) {
            const r = d.range * 1000 / (mapState.view.mpp * Math.cos(p.lat * Math.PI / 180));
            cones.push(`<circle class="map-drone-range" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${DRONE_COLOR}" fill-opacity="0.025" stroke="${DRONE_COLOR}" stroke-opacity="0.6" stroke-width="1.3" stroke-dasharray="3 4"/>`);
            if (r > 36) marks.push(`<text x="${x.toFixed(1)}" y="${(y - r - 5).toFixed(1)}" text-anchor="middle" class="map-label map-label-drone">${d.range} km</text>`);
        }
        const q = mapState.droneView ? lookPoint(d) || (newest && last(newest)) : null;
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
        const k = mapState.items.push({ kind: 'drone', d }) - 1;
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

// The drone menu: two switches for this browser (show the drones, show their
// view), each drone with Zoom, and for editors its grid to move it, a remove,
// and a row to add one. Rebuilt from the list, keeping what was being typed.
const renderDronePop = () => {
    const pop = document.getElementById('mapDronePop');
    if (!pop) return;
    const typed = [...pop.querySelectorAll('input[type="text"][id]')].map(i => [i.id, i.value, document.activeElement === i]);
    const toggle = (id, on, label) => `<label class="map-drone-switch"><span>${label}</span><input type="checkbox" role="switch" class="narr-switch" id="${id}"${on ? ' checked' : ''}></label>`;
    pop.innerHTML = `<div class="map-base-pop-head">Drones</div>
        ${toggle('mapDroneShow', mapState.droneShow, 'Show on the map')}
        ${toggle('mapDroneView', mapState.droneView, 'Show its view')}
        ${sharedDrones.length ? `<div class="map-drone-list">${sharedDrones.map((d, i) => { const ask = isAsking(`drone|${d.name}`); return `
            <div class="map-drone-row">
                <span class="map-drone-name">${escapeHtml(d.name)}</span>
                ${ask ? `<span class="map-drone-ask"><input type="text" class="map-drone-grid-in" value="${escapeHtml(d.grid)}" tabindex="-1" aria-hidden="true"><span class="map-base-ask" role="status">Remove for everyone?</span></span>`
                    : isReadOnly ? `<span class="map-drone-grid">${escapeHtml(d.grid)}</span>`
                    : `<input type="text" id="mapDroneGrid${i}" class="map-drone-grid-in" data-drone-grid="${i}" value="${escapeHtml(d.grid)}" maxlength="40" spellcheck="false" aria-label="${escapeHtml(d.name)}'s grid">`}
                <button type="button" class="text-btn" data-drone-zoom="${i}">Zoom</button>
                <button type="button" class="overlay-remove editor-only" data-drone-remove="${i}" data-drone-name="${escapeHtml(d.name)}"${ask ? ' data-asking' : ''} title="Remove ${escapeHtml(d.name)}" aria-label="Remove ${escapeHtml(d.name)}">&times;</button>
            </div>
            <div class="map-drone-sub">
                <span class="map-drone-sub-label">Looking at</span>
                ${isReadOnly ? `<span class="map-drone-grid">${escapeHtml(d.look || 'the newest report')}</span>`
                    : `<input type="text" id="mapDroneLook${i}" class="map-drone-grid-in" data-drone-look="${i}" value="${escapeHtml(d.look || '')}" placeholder="Newest report" maxlength="40" spellcheck="false" aria-label="Where ${escapeHtml(d.name)} is looking">`}
                <span class="map-drone-sub-label">Range</span>
                ${isReadOnly ? `<span class="map-drone-grid">${d.range ? `${d.range} km` : 'none'}</span>`
                    : `<input type="text" id="mapDroneRange${i}" class="map-drone-range-in" data-drone-range="${i}" value="${d.range || ''}" placeholder="km" maxlength="6" inputmode="decimal" aria-label="${escapeHtml(d.name)}'s range in km">`}
            </div>`; }).join('')}</div>` : '<div class="map-base-none">No drones yet.</div>'}
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

// As the basemaps: refused, the list goes back to what it was.
const saveDrones = (list, said, undo = null) => {
    const before = sharedDrones;
    sharedDrones = list;
    storeDrones();
    renderMapView();
    return saveShared('/api/save_drones', { drones: list }, { said, undo, putBack: () => {
        if (sharedDrones === list) { sharedDrones = before; storeDrones(); renderMapView(); }
    } });
};

// Zoom in on a drone (its view turned on, if the drones were hidden).
const zoomToDrone = (d) => {
    const p = dronePoint(d);
    if (!p || !mapState.view) return;
    if (!mapState.droneShow) { mapState.droneShow = true; writeStored('salt_drone_show', 'on'); }
    const [x, y] = SaltCore.lonLatToMerc(p.lon, p.lat);
    mapState.view.cx = x; mapState.view.cy = y;
    mapState.view.mpp = Math.min(mapState.view.mpp, 4);
    renderMapView();
};

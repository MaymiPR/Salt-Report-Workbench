// SPDX-License-Identifier: AGPL-3.0-only

// The map's basemaps (app/60-map.js): drawing a WMS or tile service under
// the graphics, and finding, adding, checking and removing services in
// Manage > Map.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.
// --- Basemap ---

// Nothing of a basemap on screen, and no WMS request still to come or to land.
const clearBasemap = (m) => {
    clearTimeout(mapState.wmsTimer);
    mapState.wmsGen++;
    m.base.innerHTML = '';
};

// Images are kept by address and only moved as the view changes, so panning
// doesn't fetch again. Only the part of the view inside the extent is asked for.
const drawBasemap = (m, ext, view, w, h) => {
    const b = activeBasemap();
    if (!b) { clearBasemap(m); return; }
    // Another service (or the same one changed): what the last one drew goes.
    const key = [b.kind, b.url, b.layers || ''].join(' ');
    [...m.base.children].forEach(el => { if (el.dataset.base !== key) el.remove(); });
    const { cx, cy, mpp } = mapState.view;
    const place = (img, box) => {
        img.setAttribute('x', ((box[0] - cx) / mpp + w / 2).toFixed(1));
        img.setAttribute('y', ((cy - box[3]) / mpp + h / 2).toFixed(1));
        img.setAttribute('width', ((box[2] - box[0]) / mpp + 0.6).toFixed(1));
        img.setAttribute('height', ((box[3] - box[1]) / mpp + 0.6).toFixed(1));
    };
    const want = [Math.max(ext[0], view[0]), Math.max(ext[1], view[1]), Math.min(ext[2], view[2]), Math.min(ext[3], view[3])];
    if (want[0] >= want[2] || want[1] >= want[3]) { clearBasemap(m); return; }
    mapState.lastWant = want;
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
        if (failed !== mapState.baseFailed && (failed || imgs.some(i => i.dataset.state === 'ok'))) { mapState.baseFailed = failed; redrawMap(); }
    };
    const add = (url, box) => {
        let img = have.get(url);
        if (!img) {
            img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            img.dataset.url = url;
            img.dataset.box = box.join(',');
            img.dataset.base = key;
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
        clearTimeout(mapState.wmsTimer);
        mapState.wmsGen++;
        const tiles = SaltCore.tilesFor(want, SaltCore.tileZoom(mpp), 400) || [];
        tiles.forEach(t => add(SaltCore.tileUrl(b.url, t), t.box));
        have.forEach(el => el.remove());
        return;
    }
    // WMS: one image for what's in view, asked for once the view settles; the
    // one on screen stays (moved with the view) until the new one arrives.
    // Each request is numbered: one that lands after a newer one was asked
    // for, or after the basemap changed, is dropped.
    have.forEach(el => place(el, el.dataset.box.split(',').map(Number)));
    clearTimeout(mapState.wmsTimer);
    mapState.wmsTimer = setTimeout(() => {
        const pw = Math.min(2048, Math.round((want[2] - want[0]) / mpp)), ph = Math.min(2048, Math.round((want[3] - want[1]) / mpp));
        if (pw < 8 || ph < 8) return;
        const url = SaltCore.wmsUrl(b.url, b.layers, want, pw, ph, b);
        if (m.base.querySelector(`[data-url="${CSS.escape(url)}"]`)) return;
        const gen = ++mapState.wmsGen;
        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.dataset.url = url;
        img.dataset.box = want.join(',');
        img.dataset.base = key;
        img.setAttribute('preserveAspectRatio', 'none');
        img.addEventListener('load', () => {
            if (gen !== mapState.wmsGen || img.parentNode !== m.base) { img.remove(); return; }
            // The view it replaces goes; nothing else does.
            [...m.base.children].forEach(el => { if (el !== img && el.dataset.base === key) el.remove(); });
            settle(img, true);
        });
        // A view that didn't come back leaves the last one on screen: a failure
        // only when there's nothing else to show.
        img.addEventListener('error', () => {
            if (gen !== mapState.wmsGen || img.parentNode !== m.base) { img.remove(); return; }
            if ([...m.base.children].some(el => el !== img && el.dataset.state === 'ok')) img.remove();
            else settle(img, false);
        });
        img.setAttribute('href', src(url));
        place(img, want);
        m.base.appendChild(img);
    }, 300);
};

// --- Adding services ---

// A WMS being looked up, what Check found, and which saved service is open:
// mapState.wmsFind, .baseCheck and .baseOpen (app/60-map.js).

// Read a service address as text. The page asks first; a service that sends
// no CORS headers refuses that, and then the sync server asks for it.
const fetchServiceText = async (url) => {
    try {
        const res = await fetch(url, { credentials: 'omit' });
        return { http: res.status, type: res.headers.get('Content-Type') || '', text: await res.text(), via: 'this browser' };
    } catch (e) { /* refused (no CORS headers) or unreachable from here; the server tries */ }
    if (isLocalFile) throw new Error("The service won't let this page read it, and a page opened as a file has no server to ask.");
    const res = await apiPost('/api/wms_fetch', { url });
    if (res.status === 401) throw new Error('The access code is needed again.');
    if (!res.ok) throw new Error(res.message);
    if (res.body.error) throw new Error(`Neither this browser nor the server could reach it (${res.body.error}).`);
    return { ...res.body, via: 'the server' };
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
    const asked = mapState.wmsFind = { link, name, edit, busy: true };
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
    // Canceled, or another lookup started, while this one was out.
    if (mapState.wmsFind !== asked) return;
    mapState.wmsFind = found;
    basemapsChanged();
};

// An address's host, or null when it isn't an address at all.
const hostOf = (url) => { try { return new URL(url).hostname || null; } catch (e) { return null; } };
const BAD_ADDRESS = "That address isn't valid.";

// A name not used yet: the service's own, then "(2)", "(3)"...
const freeBasemapName = (want) => {
    const base = cutText((want || 'Basemap').trim(), 54) || 'Basemap';
    const taken = n => sharedBasemaps.some(b => b.name.toLowerCase() === n.toLowerCase());
    let name = base;
    for (let i = 2; taken(name); i++) name = `${base} (${i})`;
    return name;
};

// The sync server's limits on the basemaps (MAX_BASEMAPS, MAX_BASEMAP_URL in
// server/salt_sync_server.py), checked here first so the reason is said at once.
const MAX_BASEMAPS = 20, MAX_BASEMAP_URL = 2000;
const basemapTooLong = (entry) => {
    if (String(entry.url || '').length <= MAX_BASEMAP_URL) return false;
    showToast(`That address is too long: ${MAX_BASEMAP_URL.toLocaleString('en-US')} characters at most.`, true);
    return true;
};

const addBasemap = (entry) => {
    if (sharedBasemaps.some(b => b.name.toLowerCase() === entry.name.toLowerCase())) { showToast(`There is already a service called ${entry.name}.`, true); return false; }
    if (sharedBasemaps.length >= MAX_BASEMAPS) { showToast(`${MAX_BASEMAPS} basemaps at most. Remove one to add another.`, true); return false; }
    if (basemapTooLong(entry)) return false;
    // The new one is shown here at once.
    mapState.baseChoice = entry.name;
    writeStored('salt_map_base', entry.name);
    saveBasemaps([...sharedBasemaps, entry], `${entry.name} added for everyone.`);
    return true;
};

// A saved service changed (its layers, name or address), in its place in the list.
const replaceBasemap = (oldName, entry) => {
    if (sharedBasemaps.some(b => b.name !== oldName && b.name.toLowerCase() === entry.name.toLowerCase())) { showToast(`There is already a service called ${entry.name}.`, true); return false; }
    if (basemapTooLong(entry)) return false;
    // Renamed: still the one shown here.
    if (mapState.baseChoice === oldName && entry.name !== oldName) {
        mapState.baseChoice = entry.name;
        writeStored('salt_map_base', entry.name);
    }
    if (mapState.baseCheck && mapState.baseCheck.name === oldName) mapState.baseCheck = null;
    mapState.wmsFind = null; mapState.baseOpen = null;
    saveBasemaps(sharedBasemaps.map(b => (b.name === oldName ? entry : b)), `${entry.name} saved for everyone.`);
    return true;
};

// A saved service, from its row: removed for everyone, on the second press
// (the first asks, in its name's place). Undo puts it back where it was,
// unless one of that name has been added since.
const removeBasemap = (name) => {
    const at = sharedBasemaps.findIndex(b => b.name === name);
    if (at < 0) return;
    if (!askFirst(`base|${name}`, renderBasemapManager)) return;
    const gone = sharedBasemaps[at];
    if (mapState.baseCheck && mapState.baseCheck.name === gone.name) mapState.baseCheck = null;
    if (mapState.baseOpen === name) { mapState.wmsFind = null; mapState.baseOpen = null; }
    saveBasemaps(sharedBasemaps.filter(b => b !== gone), `${gone.name} removed.`, () => {
        if (sharedBasemaps.some(b => b.name.toLowerCase() === gone.name.toLowerCase())) { showToast(`There is already a service called ${gone.name}.`, true); return; }
        saveBasemaps([...sharedBasemaps.slice(0, at), gone, ...sharedBasemaps.slice(at)], `${gone.name} put back.`);
    });
};

// Where to ask for the map: the address the service's capabilities give, but
// over https when it was linked over https and names the same host there
// (many list an http:// address and send it on to https://), so the browser
// asks the service itself.
const wmsGetMapUrl = (f) => {
    const link = f.link.trim();
    if (!f.getMap) return link;
    try {
        if (/^http:\/\//i.test(f.getMap) && /^https:\/\//i.test(link) && new URL(f.getMap).host === new URL(link).host) return `https://${f.getMap.slice(7)}`;
    } catch (e) { /* not an address: as given */ }
    return f.getMap;
};

// The ticked layers, as one service, in the projection they all offer: added,
// or saved over the service they were opened from.
const addFoundLayers = () => {
    const f = mapState.wmsFind;
    const picked = f.layers.filter(l => f.picked.has(l.name));
    if (!picked.length) { showToast(f.edit ? 'Tick the layers to keep, or Remove the service.' : 'Tick the layers to add.', true); return; }
    const crs = SaltCore.pickWmsCrs(picked.map(l => l.crs));
    if (!crs) { showToast("Those layers aren't offered in Web Mercator or in latitude / longitude, so the map can't show them together.", true, { ms: 8000 }); return; }
    const layers = picked.map(l => l.name).join(',');
    if (layers.length > 2000) { showToast('Too many layers for one service; tick fewer.', true); return; }
    // Named for itself: the service's title (else the one layer's, or its host); a saved one keeps its name.
    const name = f.edit || freeBasemapName(f.title || (picked.length === 1 ? picked[0].title : hostOf(f.link)));
    const entry = { name, kind: 'wms', url: wmsGetMapUrl(f), layers, version: f.version, crs, format: SaltCore.pickWmsFormat(f.formats) };
    if (!(f.edit ? replaceBasemap(f.edit, entry) : addBasemap(entry))) return false;
    mapState.wmsFind = null;
    return true;
};
// Empty the add box once a service is in (the form was redrawn with what was typed).
const clearBaseInputs = () => { const i = document.getElementById('mapBaseInput'); if (i) i.value = ''; };

// Check: ask the service for a little of the map, the way the map does, and
// say what came back: an image, or the service's own error.
const checkBasemap = async (b) => {
    const tracks = SaltCore.reportTracks(mapReports());
    const ext = mapState.lastWant || mapExtent(tracks) || [...SaltCore.lonLatToMerc(-0.01, -0.01), ...SaltCore.lonLatToMerc(0.01, 0.01)];
    const url = b.kind === 'tiles'
        ? SaltCore.tileUrl(b.url, (SaltCore.tilesFor(ext, Math.min(18, SaltCore.tileZoom((ext[2] - ext[0]) / 512)), 64) || [{ z: 0, x: 0, y: 0 }])[0])
        : SaltCore.wmsUrl(b.url, b.layers, ext, 256, 256, b);
    mapState.baseCheck = { name: b.name, text: 'Asking the service...' };
    basemapsChanged();
    try {
        const got = await fetchServiceText(url);
        const kb = Math.max(1, Math.round((got.size || (got.text || '').length) / 1024));
        if (got.http >= 400) mapState.baseCheck = { name: b.name, text: `The service answered ${got.http}${serviceSays(got.text) ? `: ${serviceSays(got.text)}` : '.'}` };
        else if (/^image\//i.test(got.type)) {
            mapState.baseCheck = { name: b.name, ok: true, text: got.via === 'this browser' || (location.protocol === 'https:' && /^http:\/\//i.test(b.url))
                ? `It works: the service sent a map image (${got.type}, ${kb} KB).`
                : `The service sent the server a map image (${got.type}, ${kb} KB), so the address and layers are right. If the map stays blank, this browser can't reach the service itself (a proxy or a certificate).` };
        } else mapState.baseCheck = { name: b.name, text: `The service answered with ${got.type || 'something'} instead of an image: ${serviceSays(got.text) || '(empty)'}` };
    } catch (e) {
        mapState.baseCheck = { name: b.name, text: e.message || String(e) };
    }
    basemapsChanged();
    if (mapState.baseCheck.ok) {
        const done = mapState.baseCheck;
        setTimeout(() => { if (mapState.baseCheck === done) fadeBaseCheck(); }, BASE_CHECK_MS);
    }
};
const BASE_CHECK_MS = 4000;
// The Check message folds away (and is forgotten, so a redraw doesn't bring it back).
const fadeBaseCheck = () => {
    mapState.baseCheck = null;
    document.querySelectorAll('.map-base-check').forEach(m => {
        m.style.height = `${m.offsetHeight}px`;
        void m.offsetHeight;
        m.classList.add('fading');
        setTimeout(() => m.remove(), 350);
    });
};

const wmsFindHtml = () => {
    const f = mapState.wmsFind;
    if (!f) return '';
    if (f.busy) return '<div class="overlays-muted map-find-msg">Asking the service for its layers...</div>';
    const saved = f.edit ? sharedBasemaps.find(b => b.name === f.edit) : null;
    if (f.error) return `<div class="map-find-msg map-find-error">${escapeHtml(f.error)}</div>
        <div class="map-form-row">
            <input type="text" id="mapWmsManualLayers" placeholder="Layer names, comma-separated, to try anyway" maxlength="2000" spellcheck="false" value="${escapeHtml(saved ? saved.layers || '' : '')}">
            <button type="button" id="mapWmsManualAdd" class="${saved ? 'set-btn' : 'cancel-btn'}">${saved ? 'Save' : 'Add Anyway'}</button>
        </div>${saved ? baseEditFoot('') : ''}`;
    const n = f.picked.size;
    return `<div class="map-find-head">
            <strong class="map-find-name">${escapeHtml(f.edit || freeBasemapName(f.title || hostOf(f.link)))}</strong>
            <span class="overlays-muted">${plural(f.layers.length, 'layer')} &middot; WMS ${f.version} &middot; read by ${escapeHtml(f.via)}</span>
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
const wmsPickLabel = (n, edit) => (edit ? (n ? 'Save' : 'Tick Layers to Keep')
    : n > 1 ? `Add ${n} Layers as One` : n ? 'Add 1 Layer' : 'Tick Layers to Add');

// Under a saved service: Save and Cancel (Remove is on its row).
const baseEditFoot = (save) => `<div class="map-form-row map-find-foot">
            ${save}
            <button type="button" class="cancel-btn" data-base-close>Cancel</button>
        </div>`;

// A saved service's details: a WMS's layers (looked up again), or a tile
// service's address.
const baseDetailHtml = (b) => {
    if (b.kind === 'wms') return mapState.wmsFind && mapState.wmsFind.edit === b.name ? `<div class="map-base-detail">${wmsFindHtml()}</div>` : '';
    return `<div class="map-base-detail">
            <div class="map-form-row">
                <input type="text" id="mapTileUrl" value="${escapeHtml(b.url)}" maxlength="4000" spellcheck="false" aria-label="Tile address">
            </div>
            ${baseEditFoot('<button type="button" id="mapTileSave" class="set-btn">Save</button>')}
        </div>`;
};

// Editors keep the list of services (each can be checked, opened to change its
// layers or address, or removed: its name asks "for everyone?" in place, so
// nothing on the row moves, and Remove again does it), and add one by pasting
// its address: a WMS link, whose layers are then looked up, or a tile address
// with {z}, {x} and {y}. Each is named for itself: a WMS by its title, tiles by their host.
// It lives in Manage > Map; the map's own basemap button only switches.
const basemapForm = () => {
    // Removed (here or by someone else) while open: closed.
    if (mapState.baseOpen && !sharedBasemaps.some(b => b.name === mapState.baseOpen)) {
        mapState.baseOpen = null;
        if (mapState.wmsFind && mapState.wmsFind.edit) mapState.wmsFind = null;
    }
    const asked = askingAbout('base|');
    if (asked && !sharedBasemaps.some(b => `base|${b.name}` === asked)) forgetAsk();
    const adding = mapState.wmsFind && !mapState.wmsFind.edit ? mapState.wmsFind : null;
    return `<div class="map-basemap-form editor-only" id="mapBasemapForm" data-open="${escapeHtml(mapState.baseOpen || '')}">
        ${sharedBasemaps.length ? `<div class="map-base-list">${sharedBasemaps.map((b, i) => `
            <div class="map-base-row${mapState.baseOpen === b.name ? ' open' : ''}">
                ${isAsking(`base|${b.name}`)
                    ?`<span class="map-base-name map-base-ask" role="status" title="${escapeHtml(b.name)}">Remove for everyone?</span>`
                    : `<span class="map-base-name" title="${escapeHtml(b.url)}${b.layers ? `\n${escapeHtml(b.layers)}` : ''}">${escapeHtml(b.name)}</span>`}
                <span class="map-base-kind">${b.kind === 'wms' ? 'WMS' : 'Tiles'}</span>
                <button type="button" class="text-btn" data-base-check="${i}">Check</button>
                <button type="button" class="text-btn" data-base-open="${i}" aria-expanded="${mapState.baseOpen === b.name}">${b.kind === 'wms' ? 'Layers' : 'Edit'}</button>
                <button type="button" class="text-btn map-base-del" data-base-remove="${i}"${isAsking(`base|${b.name}`) ? ' data-asking' : ''} aria-label="Remove ${escapeHtml(b.name)}">Remove</button>
            </div>${mapState.baseCheck && mapState.baseCheck.name === b.name ? `<div class="map-base-check${mapState.baseCheck.ok ? ' ok' : ''}" role="status">${escapeHtml(mapState.baseCheck.text)}</div>` : ''}${mapState.baseOpen === b.name ? baseDetailHtml(b) : ''}`).join('')}</div>` : ''}
        <div class="map-form-row map-base-add">
            <input type="text" id="mapBaseInput" placeholder="WMS link or tile address" maxlength="4000" spellcheck="false" value="${escapeHtml(adding ? adding.link : '')}" aria-label="WMS link or tile address">
            <button type="button" id="mapBaseAddBtn" class="set-btn"${adding && adding.busy ? ' disabled' : ''}>Add</button>
        </div>
        ${adding ? wmsFindHtml() : ''}
        <div class="map-base-hint">Shared with everyone. A tile address has {z}, {x} and {y}.</div>
    </div>`;
};

// The form, rebuilt from the list, keeping what was being typed and the
// keyboard's place (a row's Check, Layers or Edit, found again in the new rows).
const renderBasemapManager = () => {
    const slot = document.getElementById('mapBaseFormSlot');
    if (!slot) return;
    const old = document.getElementById('mapBasemapForm');
    const same = old && old.dataset.open === (mapState.baseOpen || '');
    const typed = old ? [...old.querySelectorAll('input[type="text"][id]')].filter(i => same || i.closest('.map-base-add')).map(i => [i.id, i.value]) : [];
    refocusAfter(() => {
        slot.innerHTML = basemapForm();
        typed.forEach(([id, v]) => { const i = document.getElementById(id); if (i) i.value = v; });
    });
    filterWmsLayers();
};
const basemapsChanged = () => { renderBasemapManager(); renderMapView(); };

// Shown here at once; refused by the server, the list goes back to what it
// was (unless a sync has replaced it since). A server that can't be reached
// leaves the change in this browser. `undo`, for a removal: the toast offers it.
const saveBasemaps = (list, said, undo = null) => {
    const before = sharedBasemaps;
    sharedBasemaps = list;
    mapState.baseFailed = false;
    storeBasemaps();
    basemapsChanged();
    return saveShared('/api/save_basemaps', { basemaps: list }, { said, undo, putBack: () => {
        if (sharedBasemaps === list) { sharedBasemaps = before; storeBasemaps(); basemapsChanged(); }
    } });
};

// The picker above the map: none, or one of the services.
const basemapOptions = () => {
    const on = activeBasemap();
    return `<option value="off"${on ? '' : ' selected'}>No basemap</option>`
        + sharedBasemaps.map(b => `<option value="${escapeHtml(b.name)}"${on && on.name === b.name ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
};

// The basemap form in Manage > Map (wired once; its contents are redrawn).
const baseHost = document.getElementById('mapBaseFormSlot');
if (baseHost) {
    baseHost.addEventListener('click', e => {
        const remove = e.target.closest('[data-base-remove]');
        if (remove) { const b = sharedBasemaps[+remove.dataset.baseRemove]; if (b) removeBasemap(b.name); return; }
        // A saved service's details: opened (a WMS's layers looked up again), or closed.
        const open = e.target.closest('[data-base-open]');
        if (open) {
            const b = sharedBasemaps[+open.dataset.baseOpen];
            if (!b) return;
            mapState.wmsFind = null;
            if (mapState.baseOpen === b.name) { mapState.baseOpen = null; basemapsChanged(); return; }
            mapState.baseOpen = b.name;
            if (b.kind === 'wms') findWmsLayers(b.url, b.name, b.name);
            else basemapsChanged();
            return;
        }
        if (e.target.closest('[data-base-close]')) { mapState.wmsFind = null; mapState.baseOpen = null; basemapsChanged(); return; }
        if (e.target.closest('#mapTileSave')) {
            const b = sharedBasemaps.find(s => s.name === mapState.baseOpen);
            const url = document.getElementById('mapTileUrl').value.trim();
            if (!b) return;
            if (!/^https?:\/\//i.test(url) || !/\{(z|TileMatrix)\}/i.test(url)) { showToast('A tile address starts with http:// or https:// and has {z}, {x} and {y}.', true); return; }
            if (!hostOf(url.replace(/[{}]/g, ''))) { showToast(BAD_ADDRESS, true); return; }
            replaceBasemap(b.name, { ...b, url });
            return;
        }
        const check = e.target.closest('[data-base-check]');
        if (check) { const b = sharedBasemaps[+check.dataset.baseCheck]; if (b) checkBasemap(b); return; }
        // One box for both: a tile address has {z} (or WMTS's {TileMatrix}); anything
        // else is taken as a WMS, and its layers are looked up.
        if (e.target.closest('#mapBaseAddBtn')) {
            if (mapState.baseOpen) { mapState.baseOpen = null; if (mapState.wmsFind && mapState.wmsFind.edit) mapState.wmsFind = null; }
            const text = document.getElementById('mapBaseInput').value.trim();
            if (!/^https?:\/\//i.test(text)) { showToast('Paste an address that starts with http:// or https://.', true); return; }
            const host = hostOf(text.replace(/[{}]/g, ''));
            if (!host) { showToast(BAD_ADDRESS, true); return; }
            if (/\{(z|TileMatrix)\}/i.test(text)) {
                if (addBasemap({ name: freeBasemapName(host), kind: 'tiles', url: text })) clearBaseInputs();
                else basemapsChanged();
            } else findWmsLayers(text);
            return;
        }
        if (e.target.closest('#mapWmsAdd')) { if (addFoundLayers()) clearBaseInputs(); return; }
        if (e.target.closest('#mapWmsCancel')) { mapState.wmsFind = null; basemapsChanged(); return; }
        if (e.target.closest('#mapWmsManualAdd')) {
            const layers = document.getElementById('mapWmsManualLayers').value.trim();
            if (!layers) { showToast('Type the layer names to try.', true); return; }
            const saved = mapState.wmsFind.edit && sharedBasemaps.find(b => b.name === mapState.wmsFind.edit);
            const name = saved ? saved.name : freeBasemapName(hostOf(mapState.wmsFind.link));
            if (saved) replaceBasemap(saved.name, { ...saved, name, layers });
            else if (addBasemap({ name, kind: 'wms', url: mapState.wmsFind.link, layers })) { mapState.wmsFind = null; clearBaseInputs(); }
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
        if (pick && mapState.wmsFind && mapState.wmsFind.layers) {
            const l = mapState.wmsFind.layers[+pick.dataset.layerPick];
            pick.checked ? mapState.wmsFind.picked.add(l.name) : mapState.wmsFind.picked.delete(l.name);
            const n = mapState.wmsFind.picked.size, btn = document.getElementById('mapWmsAdd');
            btn.disabled = !n;
            btn.textContent = wmsPickLabel(n, !!mapState.wmsFind.edit);
        }
    });
}

// Only the layers matching what's typed in the filter.
const filterWmsLayers = () => {
    const q = ((document.getElementById('mapWmsFilter') || {}).value || '').trim().toLowerCase();
    document.querySelectorAll('.map-layer-row').forEach(r => { r.hidden = !!q && !r.dataset.layerText.includes(q); });
};

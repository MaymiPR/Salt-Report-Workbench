// SPDX-License-Identifier: AGPL-3.0-only

// Saving and printing the map (app/60-map.js): the view as it is on screen,
// its key, a title block, a north arrow and a scale bar. A PNG, or a page in
// the browser's print dialog (which can also save a PDF).
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// What each map element's look comes from: the stylesheet, copied onto the
// element, since an SVG drawn as an image (or printed alone) has no stylesheet.
const MAP_EXPORT_STYLES = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
    'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'paint-order',
    'text-anchor', 'dominant-baseline', 'filter', 'visibility', 'display'];

// A copy of an on-screen SVG with each element's computed look written on it.
const mapStyledCopy = (svg) => {
    const copy = svg.cloneNode(true);
    const from = [svg, ...svg.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')];
    from.forEach((el, i) => {
        const cs = getComputedStyle(el);
        to[i].setAttribute('style', MAP_EXPORT_STYLES.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    });
    copy.querySelectorAll('.map-hit').forEach(n => n.remove());   // pointer targets only
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return copy;
};

// The view's title, its window, and when it was made.
const mapExportTitle = () => {
    const local = timeDisplayMode === 'local';
    const ato = viewerShowingAto || activeAto || '';
    const title = (localReports.find(r => r.title && !r.deleted) || {}).title || localConfig.title || '';
    const upTo = mapState.end === null ? 'now' : SaltCore.dtg(mapState.end, local);
    const span = mapState.hours ? `the ${mapState.hours} hours up to ${upTo}` : `every report up to ${upTo}`;
    return {
        head: [title, ato].filter(Boolean).join(' ') || 'Map',
        sub: `Map of ${span}. Made ${SaltCore.dtg(Date.now(), local)}.`,
    };
};

// A scale bar a round length long (1, 2 or 5 times a power of ten), at most
// `most` pixels: meters on the ground per pixel at the middle of the view. In
// this browser's units (Settings > Units), as every other measure: meters and
// km, or yards and miles.
const mapScaleBar = (most = 130) => {
    const v = mapState.view, box = document.getElementById('mapBox');
    if (!v || !isFinite(v.mpp) || !box) return null;
    const [, lat] = SaltCore.mercToLonLat(v.cx, v.cy);
    const ground = v.mpp * Math.cos(lat * Math.PI / 180);
    // [meters, as written], shortest first.
    const lengths = [];
    const round = (powers, unit, per, text) => powers.forEach(p => [1, 2, 5].forEach(k => lengths.push([k * p * per, text(k * p, unit)])));
    if (unitSystem === 'imperial') {
        round([1, 10, 100], 'yd', 0.9144, (n, u) => `${n} ${u}`);
        round([1, 10, 100, 1000, 10000], 'mi', M_PER_MI, (n, u) => `${n.toLocaleString('en-US')} ${u}`);
    } else round([1, 10, 100, 1000, 10000, 100000], 'm', 1, (n) => (n >= 1000 ? `${n / 1000} km` : `${n} m`));
    let len = lengths[0];
    lengths.forEach(l => { if (l[0] / ground <= most) len = l; });
    return { px: len[0] / ground, text: len[1] };
};

// The north arrow and scale bar, as SVG to lay over the map (Web Mercator:
// north is straight up).
const mapMarksSvg = (w, h) => {
    const s = mapScaleBar();
    const north = `<g transform="translate(${w - 28},34)"><path d="M0,-18 L8,6 L0,1 L-8,6 Z" fill="${MAP_COLORS.core}" stroke="${MAP_COLORS.edge}" stroke-width="1.2"/>`
        + `<text y="20" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="${MAP_COLORS.core}" stroke="${MAP_COLORS.edge}" stroke-width="3" paint-order="stroke">N</text></g>`;
    const bar = s ? `<g transform="translate(14,${h - 18})"><rect x="0" y="-5" width="${s.px.toFixed(1)}" height="6" fill="${MAP_COLORS.core}" stroke="${MAP_COLORS.edge}" stroke-width="1.2"/>`
        + `<rect x="0" y="-5" width="${(s.px / 2).toFixed(1)}" height="6" fill="${MAP_COLORS.edge}"/>`
        + `<text x="${(s.px + 6).toFixed(1)}" y="1" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="${MAP_COLORS.core}" stroke="${MAP_COLORS.edge}" stroke-width="3" paint-order="stroke">${escapeHtml(s.text)}</text></g>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${north}${bar}</svg>`;
};

// The map's own background, behind the basemap (a token in the stylesheet).
const mapBackground = () => getComputedStyle(document.documentElement).getPropertyValue('--map-bg').trim() || '#2a2b2e';

const loadImage = (src, cors) => new Promise(resolve => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
});
// A basemap image for the PNG, all of them asked at once: the image, null when
// the service refused it, or MAP_TILE_LATE when it hadn't come in
// MAP_EXPORT_TILE_MS, so a slow tile host can't hold the save up for ever.
const MAP_EXPORT_TILE_MS = 8000, MAP_TILE_LATE = 'late';
const loadTile = (src) => Promise.race([loadImage(src, true), new Promise(r => setTimeout(r, MAP_EXPORT_TILE_MS, MAP_TILE_LATE))]);
const svgImage = (markup) => loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup), false);

// The key as drawn on the canvas: the map's own key, each swatch and its words
// (a tag switched off in it is left out, as its graphics are).
const drawMapKey = async (ctx, keys, x0, y0, width) => {
    let x = x0, y = y0;
    for (const k of keys) {
        const text = k.textContent.trim(), wText = ctx.measureText(text).width;
        if (x > x0 && x + 26 + wText > x0 + width) { x = x0; y += 22; }
        const ramp = k.querySelector('.map-ramp'), sw = k.querySelector('svg');
        if (ramp) {
            const g = ctx.createLinearGradient(x, 0, x + 40, 0);
            HEAT_KEY_STOPS.forEach(([at, c]) => g.addColorStop(at, c));
            ctx.fillStyle = g;
            ctx.fillRect(x, y - 5, 40, 9);
            x += 46;
        } else if (sw) {
            const img = await svgImage(new XMLSerializer().serializeToString(mapStyledCopy(sw)));
            if (img) ctx.drawImage(img, x, y - 7, 18, 10);
            x += 24;
        }
        ctx.fillStyle = MAP_COLORS.ink;
        ctx.fillText(text, x, y + 3);
        x += wText + 18;
    }
    return y + 14;
};

// The map drawn on a canvas: title block, the view (its basemap too, with
// `withBase`, where the service lets the page copy its images), north arrow,
// scale bar and key. Resolves { canvas, baseLeftOut, late } (late: how many
// of its images didn't come in time and are left out), or null.
const drawMapCanvas = async (withBase) => {
    const m = mapEls();
    const w = m.box.clientWidth, h = m.box.clientHeight, scale = 2;
    const keys = [...m.legend.querySelectorAll('.map-key:not(.off)')];
    const t = mapExportTitle();
    // The key's rows, measured first, so the image is as tall as it needs.
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    let rows = 1, x = 0;
    keys.forEach(k => { const need = 50 + probe.measureText(k.textContent.trim()).width; if (x && x + need > w - 28) { rows++; x = 0; } x += need; });
    const head = 58, foot = rows * 22 + 34;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale; canvas.height = (head + h + foot) * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = MAP_COLORS.paper;
    ctx.fillRect(0, 0, w, head + h + foot);
    ctx.fillStyle = MAP_COLORS.ink;
    ctx.font = '700 18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(t.head, 14, 26);
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = MAP_COLORS.inkSoft;
    ctx.fillText(t.sub, 14, 46);
    // The map: its background, the basemap, then the graphics and marks.
    ctx.save();
    ctx.translate(0, head);
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.fillStyle = mapBackground();
    ctx.fillRect(0, 0, w, h);
    const tiles = [...m.base.querySelectorAll('image')];
    let baseLeftOut = !withBase && tiles.length > 0, late = 0;
    // Asked for together, drawn in their order.
    const got = await Promise.all((withBase ? tiles : []).map(el => loadTile(new URL(el.getAttribute('href'), location.href).href)));
    got.forEach((img, i) => {
        if (img === MAP_TILE_LATE) { late++; return; }
        if (!img) { baseLeftOut = true; return; }
        const el = tiles[i];
        ctx.drawImage(img, +el.getAttribute('x'), +el.getAttribute('y'), +el.getAttribute('width'), +el.getAttribute('height'));
    });
    const over = await svgImage(new XMLSerializer().serializeToString(mapStyledCopy(m.svg)));
    if (!over) { ctx.restore(); return null; }
    ctx.drawImage(over, 0, 0, w, h);
    const marks = await svgImage(mapMarksSvg(w, h));
    if (marks) ctx.drawImage(marks, 0, 0, w, h);
    ctx.restore();
    // The key under it, and what was left out, if anything.
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const y = await drawMapKey(ctx, keys, 14, head + h + 20, w - 28);
    if (baseLeftOut || late) {
        ctx.fillStyle = MAP_COLORS.inkWarn;
        ctx.fillText(baseLeftOut ? "The basemap is left out: its service doesn't let the page copy its images. Print shows it."
            : `${plural(late, 'basemap image')} didn't come in time and ${late === 1 ? 'is' : 'are'} left out.`, 14, y + 10);
    }
    return { canvas, baseLeftOut, late };
};

// The map as a PNG. Should the browser have let in a basemap image it then
// won't let the page read back, it is drawn again without the basemap. It
// can take a second or more with many graphics: meanwhile a toast says it is
// being saved, and Save as PNG says so and can't be pressed again.
const saveMapPng = async () => {
    const m = mapEls();
    if (!m.box || !mapState.view || !mapState.lastDraw || !mapState.lastDraw.view) { showToast('Nothing on the map to save yet.', true); return; }
    const btn = document.getElementById('mapSavePng');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    showToast('Saving the map as a PNG...');
    const toPng = (canvas) => new Promise((resolve, reject) => {
        try { canvas.toBlob(b => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'); } catch (e) { reject(e); }
    });
    try {
        // The toast drawn before the work starts (a timer too, should the tab be in the background).
        await new Promise(r => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });
        let drawn = await drawMapCanvas(true), blob = null;
        try {
            blob = drawn && await toPng(drawn.canvas);
        } catch (e) {
            drawn = await drawMapCanvas(false);
            blob = drawn && await toPng(drawn.canvas).catch(() => null);
        }
        if (!blob) { showToast("The map couldn't be saved as an image.", true); return; }
        const name = `${SaltCore.backupFilename(viewerShowingAto || activeAto || 'ATO', localConfig.title || 'SALT')}_map_${fileStamp(new Date(), timeDisplayMode === 'local')}.png`;
        triggerDownload(name, blob, 'image/png');
        const late = drawn.late ? `, without ${plural(drawn.late, 'basemap image')} that didn't come in time` : '';
        showToast(drawn.baseLeftOut ? `Saved ${name}, without the basemap (its service doesn't allow it; Print shows it).` : `Saved ${name}${late}.`, drawn.baseLeftOut || !!drawn.late);
    } catch (e) {
        showToast("The map couldn't be saved as an image.", true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save as PNG';
    }
};

// The map in the print dialog: the same title block, view, marks and key, as
// a page. Printing isn't held back by where the basemap's images come from.
const printMap = () => {
    const m = mapEls();
    if (!m.box || !mapState.view || !mapState.lastDraw || !mapState.lastDraw.view) { showToast('Nothing on the map to print yet.', true); return; }
    const w = m.box.clientWidth, h = m.box.clientHeight, t = mapExportTitle();
    const base = m.base.closest('svg').cloneNode(true);
    base.querySelectorAll('image').forEach(img => img.setAttribute('href', new URL(img.getAttribute('href'), location.href).href));
    base.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    base.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const over = mapStyledCopy(m.svg);
    const key = [...m.legend.querySelectorAll('.map-key:not(.off)')].map(k => {
        const ramp = k.querySelector('.map-ramp'), sw = k.querySelector('svg');
        const mark = ramp ? `<span class="ramp" style="background:${getComputedStyle(ramp).backgroundImage}"></span>`
            : sw ? new XMLSerializer().serializeToString(mapStyledCopy(sw)) : '';
        return `<span class="key">${mark}${escapeHtml(k.textContent.trim())}</span>`;
    }).join('');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t.head)}</title><style>
        @page { size: landscape; margin: 10mm; }
        body { margin: 0; color: ${MAP_COLORS.ink}; background: ${MAP_COLORS.paper}; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        h1 { font-size: 16pt; margin: 0 0 2mm; } p { font-size: 9pt; color: ${MAP_COLORS.inkSoft}; margin: 0 0 4mm; }
        .map { position: relative; width: 100%; aspect-ratio: ${w} / ${h}; background: ${mapBackground()}; overflow: hidden; break-inside: avoid; }
        .map svg { position: absolute; inset: 0; width: 100%; height: 100%; }
        .keys { display: flex; flex-wrap: wrap; gap: 3mm 6mm; margin-top: 4mm; font-size: 9pt; }
        .key { display: inline-flex; align-items: center; gap: 2mm; } .key svg { width: 18px; height: 10px; }
        .ramp { display: inline-block; width: 40px; height: 9px; border-radius: 2px; }
    </style></head><body><h1>${escapeHtml(t.head)}</h1><p>${escapeHtml(t.sub)}</p>
    <div class="map">${new XMLSerializer().serializeToString(base)}${new XMLSerializer().serializeToString(over)}${mapMarksSvg(w, h)}</div>
    <div class="keys">${key}</div></body></html>`);
    doc.close();
    // Printed once the basemap's images are in (or after a few seconds).
    const imgs = [...doc.querySelectorAll('image')].map(img => new Promise(r => {
        const probe = new Image(); probe.onload = probe.onerror = r; probe.src = img.getAttribute('href');
    }));
    Promise.race([Promise.all(imgs), new Promise(r => setTimeout(r, 4000))]).then(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(() => frame.remove(), 1000);
    });
};

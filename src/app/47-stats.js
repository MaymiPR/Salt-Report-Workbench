// SPDX-License-Identifier: AGPL-3.0-only

// Statistics panel: headline numbers and one-question charts over the shown
// workspace, each exportable as PNG, SVG, or CSV (or all at once, zipped).
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- Chart drawing ---

// Each chart is one series, so one color. On screen the app's dark surface;
// exports use a light one, for slides and print. Both validated (contrast,
// lightness band) against their surface.
const CHART_THEMES = {
    dark:  { surface: '#1c1c1e', ink: '#f5f5f7', ink2: '#8e8e93', grid: '#2c2c2e', base: '#48484a', mark: '#0a84ff' },
    light: { surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', grid: '#e1e0d9', base: '#c3c2b7', mark: '#2a78d6' },
};
const CHART_FONT = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif';
const CHART_W = 560;

// A bar with a 4px rounded data end and a square base.
const barPath = (x, y, w, h) => {
    const r = Math.min(4, w, h / 2);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
};
const columnPath = (x, y, w, h) => {
    const r = Math.min(4, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Clean tick step (1, 2, or 5 x 10^k) giving at most four intervals. Counts
// are whole, so never below 1.
const niceStep = (max) => {
    const raw = Math.max(1, max) / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    return Math.max(1, [1, 2, 5, 10].map(m => m * p).find(s => s >= raw));
};

// The SVG for a chart. `header` adds the title and context lines inside the
// image, for exports that stand on their own.
const chartSvg = (chart, themeName, header) => {
    const t = CHART_THEMES[themeName];
    // Room above the tallest column for its value.
    const top = header ? 56 : chart.kind === 'column' ? 20 : 8;
    const items = chart.shown;
    const head = header
        ? `<text x="0" y="20" font-size="15" font-weight="600" fill="${t.ink}">${escapeHtml(chart.title)}</text>`
          + `<text x="0" y="40" font-size="12" fill="${t.ink2}">${escapeHtml(chart.context)}</text>`
        : '';
    let body, height;
    if (chart.kind === 'bar') {
        const rowH = 28, barH = 14;
        const labelW = Math.min(190, Math.max(60, Math.max(...items.map(i => shorten(i.label, 26).length)) * 7 + 8));
        const x0 = labelW + 10, maxW = CHART_W - x0 - 48;
        const max = Math.max(...items.map(i => i.value), 1);
        body = items.map((it, i) => {
            const y = top + i * rowH, w = it.value / max * maxW;
            return `<g class="stats-row" data-i="${i}">`
                + (w > 0 ? `<path class="stats-mark" d="${barPath(x0, y + (rowH - barH) / 2, w, barH)}" fill="${t.mark}"/>` : '')
                + `<text x="${labelW}" y="${y + rowH / 2}" dy=".35em" text-anchor="end" font-size="12" fill="${t.ink2}">${escapeHtml(shorten(it.label, 26))}</text>`
                + `<text x="${x0 + w + 6}" y="${y + rowH / 2}" dy=".35em" font-size="12" font-weight="600" fill="${t.ink}">${it.value}</text>`
                + `<rect class="stats-hit" x="0" y="${y}" width="${CHART_W}" height="${rowH}" fill="transparent"/></g>`;
        }).join('')
            + `<line x1="${x0}" x2="${x0}" y1="${top}" y2="${top + items.length * rowH}" stroke="${t.base}" stroke-width="1"/>`;
        height = top + items.length * rowH + 8;
    } else {
        const plotH = 150, left = 34, right = 6, bottom = 24;
        const band = (CHART_W - left - right) / items.length;
        const colW = Math.min(24, band * 0.7);
        const step = niceStep(Math.max(...items.map(i => i.value)));
        const max = Math.max(step, Math.ceil(Math.max(...items.map(i => i.value)) / step) * step);
        const y0 = top + plotH, yOf = v => y0 - v / max * plotH;
        let ticks = '';
        for (let v = 0; v <= max; v += step) {
            ticks += (v ? `<line x1="${left}" x2="${CHART_W - right}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${t.grid}" stroke-width="1"/>` : '')
                + `<text x="${left - 6}" y="${yOf(v)}" dy=".35em" text-anchor="end" font-size="11" fill="${t.ink2}" style="font-variant-numeric: tabular-nums">${v}</text>`;
        }
        const peak = items.reduce((b, it, i) => (it.value > items[b].value ? i : b), 0);
        body = ticks + items.map((it, i) => {
            const cx = left + band * i + band / 2, h = y0 - yOf(it.value);
            const label = i % chart.labelEvery === 0
                ? `<text x="${cx}" y="${y0 + 16}" text-anchor="middle" font-size="11" fill="${t.ink2}">${escapeHtml(chart.fmtX(it.label))}</text>` : '';
            const peakLabel = i === peak && it.value > 0
                ? `<text x="${cx}" y="${yOf(it.value) - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${t.ink}">${it.value}</text>` : '';
            return `<g class="stats-row" data-i="${i}">`
                + (h > 0 ? `<path class="stats-mark" d="${columnPath(cx - colW / 2, yOf(it.value), colW, h)}" fill="${t.mark}"/>` : '')
                + label + peakLabel
                + `<rect class="stats-hit" x="${left + band * i}" y="${top}" width="${band}" height="${plotH}" fill="transparent"/></g>`;
        }).join('')
            + `<line x1="${left}" x2="${CHART_W - right}" y1="${y0}" y2="${y0}" stroke="${t.base}" stroke-width="1"/>`;
        height = y0 + bottom;
    }
    // Exports get a margin and their own background; on screen the card is both.
    const pad = header ? 16 : 0, w = CHART_W + 2 * pad, h = height + 2 * pad;
    const bg = header ? `<rect x="${-pad}" y="${-pad}" width="${w}" height="${h}" fill="${t.surface}"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${w} ${h}" width="${w}" height="${h}" font-family="${CHART_FONT}" role="img" aria-label="${escapeHtml(chart.title)}">`
        + bg + head + body + '</svg>';
};

// --- The panel ---

let isStatsViewActive = false;
// The workspace on screen, or every loaded one ('all'). Per browser.
let statsScope = localStorage.getItem('salt_stats_scope') === 'all' ? 'all' : 'ato';
let statsCharts = [];       // what is on screen, for hover and export
let statsKpis = [];         // the headline numbers on screen, for the workbook
let statsBuilt = null;      // what the panel was last drawn from, so a sync that changes nothing leaves it be

const FOLD_AT = 10;  // longer lists show their top ten and an "Other" bar
const fold = (items) => (items.length <= FOLD_AT + 1 ? items : [
    ...items.slice(0, FOLD_AT),
    { label: `Other (${items.length - FOLD_AT})`, value: items.slice(FOLD_AT).reduce((s, i) => s + i.value, 0) },
]);
const DAY_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso) => `${+iso.slice(8, 10)} ${DAY_NAMES[+iso.slice(5, 7) - 1]}`;

const statsEls = () => ({
    panel: document.getElementById('statsPanel'),
    body:  document.getElementById('statsBody'),
    subtitle: document.getElementById('stats-panel-subtitle'),
    fromDate: document.getElementById('stats-from-date'), fromTime: document.getElementById('stats-from-time'),
    toDate:   document.getElementById('stats-to-date'),   toTime:   document.getElementById('stats-to-time'),
});

// Set a window's From / To pickers to the last `hours` hours, or clear them
// for all reports. Same as the export presets: relative to now, in the
// active time mode. `w` holds the four inputs.
const fillWindow = (w, hours) => {
    if (!hours) { w.fromDate.value = w.fromTime.value = w.toDate.value = w.toTime.value = ''; return; }
    const local = timeDisplayMode === 'local', now = new Date();
    const parts = (d) => { const f = dateFields(d, local); return [`${f.y}-${f.mo}-${f.day}`, `${f.h}:${f.mi}`]; };
    [w.fromDate.value, w.fromTime.value] = parts(new Date(now.getTime() - hours * 3600000));
    [w.toDate.value, w.toTime.value] = parts(now);
};
// A window's bounds in ms (null for an open end).
const windowBounds = (w) => ({
    from: parseFilterTime(w.fromDate.value, w.fromTime.value, false),
    to:   parseFilterTime(w.toDate.value, w.toTime.value, true),
});

// The reports in the chosen window, and a phrase saying what it is.
const statsWindow = () => {
    const s = statsEls();
    const { from: fromMs, to: toMs } = windowBounds(s);
    // Each report with the workspace it is in, for the per-ATO chart.
    const atoOf = new Map();
    const lists = statsScope === 'all' ? Object.entries(reportsByAto) : [[shownAto(), localReports]];
    let reps = lists.flatMap(([ato, list]) => (list || []).filter(r => !r.deleted).map(r => { atoOf.set(r, ato); return r; }));
    if (fromMs !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() >= fromMs);
    if (toMs !== null)   reps = reps.filter(r => r.time && new Date(r.time).getTime() <= toMs);
    const local = timeDisplayMode === 'local';
    const when = ms => { const f = dateFields(new Date(ms), local); return `${+f.day} ${DAY_NAMES[+f.mo - 1]} ${f.h}${f.mi}${local ? 'L' : 'Z'}`; };
    const phrase = fromMs === null && toMs === null ? 'all reports'
        : fromMs !== null && toMs !== null ? `${when(fromMs)} to ${when(toMs)}`
        : fromMs !== null ? `from ${when(fromMs)}` : `up to ${when(toMs)}`;
    return { reps, phrase, atoOf, atos: lists.length };
};

const renderStats = () => {
    const s = statsEls();
    if (!s.body || !isStatsViewActive) return;
    const ato = shownAto();
    const { reps, phrase, atoOf, atos } = statsWindow();
    const local = timeDisplayMode === 'local';
    const d = SaltCore.statsData(reps, currentOverlays(), { local });
    const scope = statsScope === 'all' ? `All ATOs (${atos})` : (ato || 'No workspace');
    const context = `${scope} · ${phrase} · ${reps.length} report${reps.length === 1 ? '' : 's'}`;
    s.subtitle.textContent = context;
    s.panel.querySelectorAll('.range-mode').forEach(n => { n.textContent = local ? '(Local)' : '(Zulu)'; });
    document.querySelectorAll('[data-stats-scope]').forEach(b => b.classList.toggle('active', b.dataset.statsScope === statsScope));
    // Reports per ATO, largest first: only across every workspace.
    const perAto = new Map();
    reps.forEach(r => perAto.set(atoOf.get(r), (perAto.get(atoOf.get(r)) || 0) + 1));
    const atoItems = [...perAto].map(([label, value]) => ({ label: label || 'ATO', value }))
        .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label, undefined, { numeric: true }));
    const ident = x => x;
    statsCharts = [
        ...(statsScope === 'all' ? [{ id: 'ato', title: 'Reports per ATO', kind: 'bar', items: atoItems, empty: 'No reports.' }] : []),
        { id: 'nai', title: 'Reports per NAI', kind: 'bar', items: d.nai, empty: 'No NAI typed or found by grid.' },
        { id: 'obj', title: 'Reports per OBJ', kind: 'bar', items: d.obj, empty: 'No OBJ typed or found by grid.' },
        { id: 'pl', title: 'Reports at each phase line', kind: 'bar', items: d.pl, empty: 'No phase line typed or near a grid.',
          note: `Typed, or a grid within ${SaltCore.PL_NEAR_METRES / 1000} km of the line` },
        { id: 'hours', title: `Reports by hour of day (${local ? 'local' : 'Zulu'})`, kind: 'column', items: d.hours, labelEvery: 3, fmtX: ident,
          tipX: h => `${h}:00–${h}:59${local ? 'L' : 'Z'}`, axis: `Hour (${local ? 'L' : 'Z'})` },
        { id: 'days', title: 'Reports by day', kind: 'column', items: d.days, labelEvery: Math.max(1, Math.ceil(d.days.length / 8)), fmtX: dayLabel, axis: 'Day' },
        { id: 'tags', title: 'Activity', kind: 'bar', items: d.tags, note: 'A report can carry several tags', axis: 'Activity' },
        { id: 'headings', title: 'Heading of moving reports', kind: 'column', items: d.headings, labelEvery: 1, fmtX: ident, axis: 'Heading' },
        { id: 'equipment', title: 'Reported by type, from Size', kind: 'bar', items: d.equipment, empty: 'No sizes to count.', unit: 'Count',
          note: 'Summed across reports, so the same vehicles reported twice count twice' },
        ...(d.bda.length ? [{ id: 'bda', title: 'BDA outcomes', kind: 'bar', items: d.bda, unit: 'Elements',
                              note: 'Elements assessed, and those still to assess' }] : []),
    ].map(c => ({ unit: 'Reports', ...c, tipX: c.tipX || c.fmtX || ident, context,
                  shown: c.kind === 'bar' ? fold(c.items) : c.items, hasData: c.items.some(i => i.value > 0) }));

    const k = d.kpis;
    statsKpis = [
        { label: 'Reports', value: k.reports }, { label: 'With a grid', value: k.withGrid },
        { label: 'In an NAI or OBJ', value: k.inPlace }, { label: 'Checks to look at', value: k.checks },
        ...(k.bdaDone ? [{ label: 'BDA assessed', value: `${k.bdaDone} of ${k.bdaTotal}` }] : []),
    ];
    const tile =(label, value) => `<div class="stats-tile"><div class="stats-tile-label">${label}</div><div class="stats-tile-value">${value}</div></div>`;
    const card = (c) => `
        <section class="stats-card" data-chart="${c.id}">
            <div class="stats-card-head">
                <div><h4>${escapeHtml(c.title)}</h4>${c.note ? `<div class="stats-note">${escapeHtml(c.note)}</div>` : ''}</div>
                <div class="stats-card-actions">
                    <button type="button" data-stats-act="table" aria-pressed="false" aria-controls="stats-table-${c.id}" aria-label="Table of ${escapeHtml(c.title)}"${c.hasData ? '' : ' disabled'}>Table</button>
                    <button type="button" data-stats-act="png" aria-label="Save ${escapeHtml(c.title)} as PNG"${c.hasData ? '' : ' disabled'}>PNG</button>
                    <button type="button" data-stats-act="svg" aria-label="Save ${escapeHtml(c.title)} as SVG"${c.hasData ? '' : ' disabled'}>SVG</button>
                    <button type="button" data-stats-act="csv" aria-label="Save ${escapeHtml(c.title)} as CSV"${c.hasData ? '' : ' disabled'}>CSV</button>
                </div>
            </div>
            <div class="stats-chart">${c.hasData ? chartSvg(c, 'dark', false) : `<div class="stats-empty">${escapeHtml(c.empty || 'Nothing yet.')}</div>`}
                <div class="stats-tip" hidden></div></div>
            <div class="stats-table" id="stats-table-${c.id}" hidden><table><thead><tr><th>${c.kind === 'bar' ? 'Item' : 'When'}</th><th>${escapeHtml(c.unit)}</th></tr></thead>
                <tbody>${c.items.map(i => `<tr><td>${escapeHtml(c.tipX(i.label))}</td><td>${i.value}</td></tr>`).join('')}</tbody></table></div>
        </section>`;
    // A sync redraws the panel only when what it shows has changed, so an
    // open table, the focus and the readout stay; when it does, the open
    // tables and the focus come back.
    const key = JSON.stringify([context, local, statsKpis, statsCharts.map(c => [c.id, c.items])]);
    if (key === statsBuilt && s.body.childElementCount) return;
    statsBuilt = key;
    const open = new Set([...s.body.querySelectorAll('.stats-card')].filter(c => !c.querySelector('.stats-table').hidden).map(c => c.dataset.chart));
    const had = s.body.contains(document.activeElement) ? document.activeElement : null;
    const focusAt = had && had.closest('.stats-card') && had.dataset.statsAct ? [had.closest('.stats-card').dataset.chart, had.dataset.statsAct] : null;
    s.body.innerHTML = !reps.length ? '<div class="stats-empty">No reports in this window.</div>' : `
        <div class="stats-tiles">
            ${tile('Reports', k.reports)}${tile('With a grid', k.withGrid)}${tile('In an NAI or OBJ', k.inPlace)}${tile('Checks to look at', k.checks)}
            ${k.bdaDone ? tile('BDA assessed', `${k.bdaDone} / ${k.bdaTotal}`) : ''}
        </div>
        <div class="stats-grid">${statsCharts.map(card).join('')}</div>`;
    open.forEach(id => {
        const c = s.body.querySelector(`.stats-card[data-chart="${CSS.escape(id)}"]`), btn = c && c.querySelector('[data-stats-act="table"]');
        if (btn && !btn.disabled) setStatsTable(c, true);
    });
    const back = focusAt && s.body.querySelector(`.stats-card[data-chart="${CSS.escape(focusAt[0])}"] [data-stats-act="${focusAt[1]}"]`);
    if (back) back.focus({ preventScroll: true });
};
// A chart's table shown or hidden, and its button saying so.
const setStatsTable = (cardEl, on) => {
    const tbl = cardEl.querySelector('.stats-table'), btn = cardEl.querySelector('[data-stats-act="table"]');
    tbl.hidden = !on;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('active', on);
};

const openStatsView = () => {
    if (isExportViewActive) closeExportView();
    closeSummaryView();
    hideHomeViews();
    isStatsViewActive = true;
    setViewIcon('statsViewToggleBtn', true);
    setTopBar('stats', 'Statistics');
    animateIn(statsEls().panel);
    statsEls().panel.style.display = 'flex';
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'stats');
    renderStats();
};
const closeStatsView = () => {
    if (!isStatsViewActive) return;
    isStatsViewActive = false;
    setViewIcon('statsViewToggleBtn', false);
    statsEls().panel.style.display = 'none';
    showHomeView();
};

// --- Export ---

const statsFileBase = () => `${statsScope === 'all' ? 'All_ATOs' : SaltCore.backupFilename(shownAto() || 'ATO', localConfig.title || 'SALT')}_stats_${fileStamp(new Date(), timeDisplayMode === 'local')}`;
const csvSection = (c) => ({ title: `${c.title} (${c.context})`, items: c.items.map(i => ({ label: c.tipX(i.label), value: i.value })) });
const chartCsv = (c) => SaltCore.statsCsv([csvSection(c)]);

// The light-surface SVG drawn at twice its size into a PNG.
const chartPng = (c) => new Promise((resolve, reject) => {
    const svg = chartSvg(c, 'light', true);
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width * 2; canvas.height = img.height * 2;
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the browser could not draw the image'))), 'image/png');
    };
    img.onerror = () => reject(new Error('the browser could not draw the image'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
});

// A zip of files, stored without compression (no library needed).
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const zipStored = (files) => {
    const enc = new TextEncoder(), parts = [], central = [];
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length;
        const lh = new DataView(new ArrayBuffer(30));
        [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, size, 4], [22, size, 4], [26, name.length, 2]]
            .forEach(([at, v, n]) => (n === 4 ? lh.setUint32(at, v, true) : lh.setUint16(at, v, true)));
        const ch = new DataView(new ArrayBuffer(46));
        [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [42, offset, 4]]
            .forEach(([at, v, n]) => (n === 4 ? ch.setUint32(at, v, true) : ch.setUint16(at, v, true)));
        parts.push(lh, name, f.bytes);
        central.push(ch, name);
        offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
};

const exportChart = async (c, kind) => {
    const base = `${statsFileBase()}_${c.id}`;
    if (kind === 'svg') triggerDownload(`${base}.svg`, chartSvg(c, 'light', true), 'image/svg+xml');
    else if (kind === 'csv') triggerDownload(`${base}.csv`, chartCsv(c), 'text/csv;charset=utf-8;');
    else triggerDownload(`${base}.png`, await chartPng(c), 'image/png');
};

const exportAllStats = async () => {
    const charts = statsCharts.filter(c => c.hasData);
    if (!charts.length) { showToast('Nothing to export in this window.', true); return; }
    const base = statsFileBase(), enc = new TextEncoder(), files = [];
    for (const c of charts) {
        files.push({ name: `${c.id}.png`, bytes: new Uint8Array(await (await chartPng(c)).arrayBuffer()) });
        files.push({ name: `${c.id}.svg`, bytes: enc.encode(chartSvg(c, 'light', true)) });
    }
    const csv = SaltCore.statsCsv(charts.map(csvSection));
    files.push({ name: 'statistics.csv', bytes: enc.encode(csv) });
    triggerDownload(`${base}.zip`, zipStored(files), 'application/zip');
    showToast(`Exported ${charts.length} charts as PNG and SVG, with their numbers in one CSV.`);
};

// One Excel workbook: the headline numbers and every chart (drawn by Excel
// from its table, so it stays editable), and the reports in the window.
const exportStatsXlsx = () => {
    const { reps } = statsWindow();
    if (!reps.length) { showToast('Nothing to export in this window.', true); return; }
    const local = timeDisplayMode === 'local';
    const customLabels = [...new Set([
        ...currentFormat().lines.filter(l => l.type === 'custom').map(l => l.label),
        ...reps.flatMap(r => Object.keys(r.custom || {})),
    ])];
    const charts = statsCharts.filter(c => c.hasData).map(c => ({
        title: c.title, note: c.note || '', unit: c.unit, kind: c.kind, axis: c.axis,
        items: c.items.map(i => ({ label: (c.kind === 'column' ? c.fmtX : c.tipX)(i.label), value: i.value })),
    }));
    const bytes = SaltCore.statsXlsx({
        title: 'Statistics', context: statsCharts.length ? statsCharts[0].context : '',
        kpis: statsKpis, charts,
        reports: SaltCore.workbookReportRows(reps, currentOverlays(), { local, idOf: formatFullId, customLabels }),
    });
    triggerDownload(`${statsFileBase()}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    showToast(`Exported ${charts.length} charts and ${reps.length} report${reps.length === 1 ? '' : 's'} to Excel.`);
};

// --- Wiring ---

(() => {
    const s = statsEls();
    if (!s.panel) return;
    document.getElementById('statsViewToggleBtn').addEventListener('click', () => (isStatsViewActive ? closeStatsView() : openStatsView()));
    document.getElementById('statsExportAllBtn').addEventListener('click', () => {
        exportAllStats().catch(e => showToast('Export error: ' + e.message, true));
    });
    document.getElementById('statsExcelBtn').addEventListener('click', () => {
        try { exportStatsXlsx(); } catch (e) { showToast('Export error: ' + e.message, true); }
    });
    [s.fromDate, s.toDate, s.fromTime, s.toTime].forEach(n => { n.addEventListener('change', renderStats); n.addEventListener('input', renderStats); });
    [s.fromTime, s.toTime].forEach(n => n.addEventListener('blur', e => { if (autoColonTime(e.target)) renderStats(); }));
    s.panel.addEventListener('click', e => {
        const preset = e.target.closest('[data-stats-hours]');
        if (preset) { fillWindow(s, +preset.dataset.statsHours); renderStats(); return; }
        const scope = e.target.closest('[data-stats-scope]');
        if (scope) {
            statsScope = scope.dataset.statsScope;
            try { localStorage.setItem('salt_stats_scope', statsScope); } catch (err) { /* storage blocked: this session only */ }
            renderStats();
            return;
        }
        const act = e.target.closest('[data-stats-act]');
        if (act) {
            const cardEl = act.closest('.stats-card');
            const c = statsCharts.find(x => x.id === cardEl.dataset.chart);
            if (act.dataset.statsAct === 'table') {
                setStatsTable(cardEl, cardEl.querySelector('.stats-table').hidden);
            } else if (c) {
                exportChart(c, act.dataset.statsAct).catch(err => showToast('Export error: ' + err.message, true));
            }
        }
    });
    // Hover: one readout per chart, value first. (The keyboard reads the
    // values in the chart's table.)
    const showTip = (e) => {
        const row = e.target.closest && e.target.closest('.stats-row');
        const box = row && row.closest('.stats-chart');
        if (!box) return;
        const c = statsCharts.find(x => x.id === box.closest('.stats-card').dataset.chart);
        const it = c && c.shown[+row.dataset.i];
        if (!it) return;
        const tip = box.querySelector('.stats-tip');
        tip.replaceChildren();
        const v = document.createElement('strong'); v.textContent = String(it.value);
        const l = document.createElement('span'); l.textContent = `${c.unit.toLowerCase()} · ${c.tipX(it.label)}`;
        tip.append(v, l);
        tip.hidden = false;
        const rb = row.querySelector('.stats-hit').getBoundingClientRect(), bb = box.getBoundingClientRect();
        tip.style.left = `${Math.min(bb.width - tip.offsetWidth, Math.max(0, (e.clientX || rb.left + rb.width / 2) - bb.left + 12))}px`;
        tip.style.top  = `${Math.max(0, rb.top - bb.top - tip.offsetHeight - 4)}px`;
    };
    const hideTip = (e) => {
        const box = e.target.closest && e.target.closest('.stats-chart');
        if (box && !box.contains(e.relatedTarget)) box.querySelector('.stats-tip').hidden = true;
    };
    s.body.addEventListener('pointermove', showTip);
    s.body.addEventListener('pointerout', hideTip);
})();

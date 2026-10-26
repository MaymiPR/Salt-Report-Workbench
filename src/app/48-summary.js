// SPDX-License-Identifier: AGPL-3.0-only

// Summary Reports panel: a written report from a preset (Rollup, Most
// Trafficked, Place Activity, Shift Brief) over a time window, to copy, save
// as .txt, or print with its charts. The text comes from SaltCore's fixed
// templates, so the same reports always give the same words.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let isSummaryViewActive = false;
let summaryKind = readStored('salt_summary_kind', 'rollup');
let summaryPlace = '';
let summaryText = '';

const summaryEls = () => ({
    panel: document.getElementById('summaryPanel'),
    text:  document.getElementById('summaryText'),
    place: document.getElementById('summaryPlace'),
    placeRow: document.getElementById('summaryPlaceRow'),
    subtitle: document.getElementById('summary-panel-subtitle'),
    fromDate: document.getElementById('summary-from-date'), fromTime: document.getElementById('summary-from-time'),
    toDate:   document.getElementById('summary-to-date'),   toTime:   document.getElementById('summary-to-time'),
});

const renderSummary = () => {
    const s = summaryEls();
    if (!s.panel || !isSummaryViewActive) return;
    const ato = shownAto();
    const live = localReports.filter(r => !r.deleted);
    // The place picker lists every overlay and every place reports name.
    const places = SaltCore.summaryPlaces(live, currentOverlays());
    if (!places.includes(summaryPlace)) summaryPlace = places[0] || '';
    s.place.replaceChildren(...places.map(p => { const o = new Option(p, p); o.selected = p === summaryPlace; return o; }));
    s.placeRow.hidden = summaryKind !== 'place';
    document.querySelectorAll('[data-summary-kind]').forEach(b => b.classList.toggle('active', b.dataset.summaryKind === summaryKind));
    const { from, to } = windowBounds(s);
    summaryText = SaltCore.summaryReport(summaryKind, live, currentOverlays(), {
        local: timeDisplayMode === 'local', from, to, now: new Date(),
        ato: ato || 'NO WORKSPACE', title: (live.find(r => r.title) || {}).title || localConfig.title || '',
        by: (userProfile && userProfile.initials) || '', place: summaryPlace,
    });
    s.text.textContent = summaryText;
    s.subtitle.textContent = `${ato || 'No workspace'} · ${plural(live.length, 'report')} in the workspace`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const openSummaryView = () => {
    if (isExportViewActive) closeExportView();
    closeStatsView();
    isSummaryViewActive = true;
    el.log.view.style.display = 'none';
    const s = summaryEls();
    s.panel.style.display = 'flex';
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'summary');
    // A shift is the usual question; start with the last twelve hours.
    if (!s.fromDate.value && !s.toDate.value) fillWindow(s, 12);
    renderSummary();
};
const closeSummaryView = () => {
    if (!isSummaryViewActive) return;
    isSummaryViewActive = false;
    summaryEls().panel.style.display = 'none';
    el.log.view.style.display = 'flex';
    writeStored('salt_view', 'log');
};

// The charts that go with each kind when printed: the same drawing as the
// Statistics panel, on the light surface.
const summaryCharts = () => {
    const s = summaryEls();
    const { from, to } = windowBounds(s);
    let reps = localReports.filter(r => !r.deleted && r.time);
    if (from !== null) reps = reps.filter(r => new Date(r.time).getTime() >= from);
    if (to !== null)   reps = reps.filter(r => new Date(r.time).getTime() <= to);
    const local = timeDisplayMode === 'local';
    if (summaryKind === 'place') {
        reps = reps.filter(r => {
            const a = SaltCore.analyzeLocation(r.location, currentOverlays());
            return [...a.nai.keys, ...a.obj.keys, ...a.pls].includes(summaryPlace);
        });
    }
    const d = SaltCore.statsData(reps, currentOverlays(), { local, squareDigits: 2 });
    const ident = x => x;
    const all = {
        nai:     { title: 'Reports per NAI', kind: 'bar', items: d.nai },
        obj:     { title: 'Reports per OBJ', kind: 'bar', items: d.obj },
        squares: { title: 'Busiest 1 km grid squares', kind: 'bar', items: d.squares },
        hours:   { title: `Reports by hour of day (${local ? 'local' : 'Zulu'})`, kind: 'column', items: d.hours, labelEvery: 3, fmtX: ident },
        tags:    { title: 'Activity', kind: 'bar', items: d.tags },
    };
    const pick = { rollup: ['nai', 'obj', 'hours', 'tags'], trafficked: ['nai', 'obj', 'squares', 'hours'], place: ['hours', 'tags'], brief: [] }[summaryKind];
    const context = summaryText.split('\n')[1].replace(/^\S+:\s+/, '');
    return pick.map(id => ({ ...all[id], id, context, shown: all[id].kind === 'bar' ? fold(all[id].items) : all[id].items }))
        .filter(c => c.items.some(i => i.value > 0));
};

// Print through a hidden frame: the text, then its charts, one page flow.
const printSummary = () => {
    const charts = summaryCharts();
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(summaryText.split('\n')[0])}</title><style>
        body { margin: 16mm; color: #0b0b0b; background: #fff; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        pre { font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: 10pt; white-space: pre-wrap; margin: 0 0 8mm; }
        svg { display: block; width: 100%; max-width: 170mm; height: auto; margin: 0 0 6mm; break-inside: avoid; }
    </style></head><body><pre>${escapeHtml(summaryText)}</pre>${charts.map(c => chartSvg(c, 'light', true)).join('')}</body></html>`);
    doc.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
};

const summaryFileName = () =>
    `${SaltCore.backupFilename(shownAto() || 'ATO', localConfig.title || 'SALT')}_${summaryKind}${summaryKind === 'place' && summaryPlace ? '_' + SaltCore.safeFilename(summaryPlace) : ''}_${fileStamp(new Date(), timeDisplayMode === 'local')}.txt`;

(() => {
    const s = summaryEls();
    if (!s.panel) return;
    document.getElementById('summaryViewToggleBtn').addEventListener('click', () => (isSummaryViewActive ? closeSummaryView() : openSummaryView()));
    document.getElementById('closeSummaryViewBtn').addEventListener('click', closeSummaryView);
    [s.fromDate, s.toDate, s.fromTime, s.toTime].forEach(n => { n.addEventListener('change', renderSummary); n.addEventListener('input', renderSummary); });
    [s.fromTime, s.toTime].forEach(n => n.addEventListener('blur', e => { if (autoColonTime(e.target)) renderSummary(); }));
    s.place.addEventListener('change', () => { summaryPlace = s.place.value; renderSummary(); });
    s.panel.addEventListener('click', e => {
        const kind = e.target.closest('[data-summary-kind]');
        if (kind) { summaryKind = kind.dataset.summaryKind; writeStored('salt_summary_kind', JSON.stringify(summaryKind)); renderSummary(); return; }
        const preset = e.target.closest('[data-summary-hours]');
        if (preset) { fillWindow(s, +preset.dataset.summaryHours); renderSummary(); return; }
        if (e.target.closest('#summaryCopyBtn')) { copyToClipboard(summaryText); showToast('Report copied.'); return; }
        if (e.target.closest('#summarySaveBtn')) { triggerDownload(summaryFileName(), summaryText.replace(/\n/g, '\r\n')); return; }
        if (e.target.closest('#summaryPrintBtn')) printSummary();
    });
})();

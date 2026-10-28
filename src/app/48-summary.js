// SPDX-License-Identifier: AGPL-3.0-only

// Summary Reports panel: a written report from a preset (Rollup, Most
// Trafficked, Place Activity, Shift Brief, Narrative) over a time window, to copy, save
// as .txt, or print with its charts. The text comes from SaltCore's fixed
// templates, so the same reports always give the same words.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let isSummaryViewActive = false;
// The charts printed with each kind of report, by their ids in summaryCharts.
const SUMMARY_CHARTS = { rollup: ['nai', 'obj', 'hours', 'tags'], trafficked: ['nai', 'obj', 'squares', 'hours'], place: ['hours', 'tags'], brief: [], narrative: ['nai', 'obj', 'tags'] };
let summaryKind = readStored('salt_summary_kind', 'rollup');
// A kind stored by another version, and not known here: the Rollup.
if (typeof summaryKind !== 'string' || !Object.prototype.hasOwnProperty.call(SUMMARY_CHARTS, summaryKind)) summaryKind = 'rollup';
let summaryPlace = '';
let summaryText = '';
// Your own wording, per workspace and kind, kept in this browser until
// Revert: the generated text stops following new reports while it's edited.
const summaryEdits = (s => (s && typeof s === 'object' ? s : {}))(readStored('salt_summary_edits', {}));
let summaryEditing = false;
let summaryEditingKey = null;
const editKey = () => `${shownAto() || ''}|${summaryKind}`;
const shownSummary = () => summaryEdits[editKey()] ?? summaryText;
const setEdit = (text) => {
    // Back to the generated text Edit started from: no edit.
    if (text === null || text === summaryText || (summaryEditSeed !== null && text === summaryEditSeed)) delete summaryEdits[editKey()];
    else summaryEdits[editKey()] = text;
    writeStored('salt_summary_edits', JSON.stringify(summaryEdits));
};

const summaryEls = () => ({
    panel: document.getElementById('summaryPanel'),
    text:  document.getElementById('summaryText'),
    place: document.getElementById('summaryPlace'),
    placeRow: document.getElementById('summaryPlaceRow'),
    subtitle: document.getElementById('summary-panel-subtitle'),
    fromDate: document.getElementById('summary-from-date'), fromTime: document.getElementById('summary-from-time'),
    toDate:   document.getElementById('summary-to-date'),   toTime:   document.getElementById('summary-to-time'),
    editor: document.getElementById('summaryEditor'),
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
    // The narrative's settings: always there beside it, the full height of the view.
    showNarrSettings(summaryKind === 'narrative');
    document.querySelectorAll('[data-summary-kind]').forEach(b => b.classList.toggle('active', b.dataset.summaryKind === summaryKind));
    const opts = summaryOpts(live);
    summaryText = SaltCore.summaryReport(summaryKind, live, currentOverlays(), opts);
    // On screen the narrative is wrapped to the width it has, so no line breaks
    // twice; Copy, Save and Print keep the 100 columns.
    const fit = summaryKind === 'narrative' ? summaryFit() : 100;
    const onScreen = fit < 100 ? SaltCore.summaryReport(summaryKind, live, currentOverlays(), { ...opts, width: fit }) : summaryText;
    // Edited text is shown as edited; while editing, the box is left alone.
    // Another workspace (or kind) while editing: the box closes, the edit kept.
    if (summaryEditing && summaryEditingKey !== editKey()) summaryEditing = false;
    s.text.textContent = editKey() in summaryEdits ? shownSummary() : onScreen;
    s.text.hidden = summaryEditing;
    s.editor.hidden = !summaryEditing;
    document.getElementById('summaryEditBtn').textContent = summaryEditing ? 'Done' : 'Edit text';
    document.getElementById('summaryEdited').hidden = !(editKey() in summaryEdits);
    s.subtitle.textContent = `${ato || 'No workspace'} · ${plural(live.length, 'report')} in the workspace`;
    s.panel.querySelectorAll('.range-mode').forEach(n => { n.textContent = timeDisplayMode === 'local' ? '(Local)' : '(Zulu)'; });
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// What the report is written from: the window, the place, the workspace.
const summaryOpts = (live) => {
    const { from, to } = windowBounds(summaryEls());
    return {
        local: timeDisplayMode === 'local', from, to, now: new Date(),
        ato: shownAto() || 'NO WORKSPACE', title: (live.find(r => r.title) || {}).title || localConfig.title || '',
        by: (userProfile && userProfile.initials) || '', place: summaryPlace, narrative: sharedNarrative,
    };
};
// The text Edit starts from. The narrative's paragraphs come unwrapped: the
// box wraps them to its width, as the screen does, so no line breaks twice.
let summaryEditSeed = null;   // that text when it was generated (not your own), else null
const summaryToEdit = () => {
    if (editKey() in summaryEdits || summaryKind !== 'narrative') return shownSummary();
    const live = localReports.filter(r => !r.deleted);
    return SaltCore.summaryReport(summaryKind, live, currentOverlays(), { ...summaryOpts(live), width: Infinity });
};

// How many monospaced columns fit in the report's box.
let summaryCanvas = null;
const summaryFit = () => {
    const pre = summaryEls().text, cs = getComputedStyle(pre);
    const ctx = (summaryCanvas = summaryCanvas || document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const col = ctx.measureText('0'.repeat(20)).width / 20;
    const room = pre.parentElement.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4;
    return Math.max(40, Math.min(100, Math.floor(room / col)));
};

const openSummaryView = () => {
    if (isExportViewActive) closeExportView();
    closeStatsView(true);
    hideHomeViews();
    isSummaryViewActive = true;
    setViewIcon('summaryViewToggleBtn', true);
    setTopBar('summary', 'Summary Reports');
    animateIn(summaryEls().panel);
    const s = summaryEls();
    s.panel.style.display = 'flex';
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'summary');
    // A shift is the usual question; start with the last twelve hours.
    if (!s.fromDate.value && !s.toDate.value) fillWindow(s, 12);
    renderSummary();
};
// Leave the edit box; what was typed stays as the report's text.
const finishEditing = () => { summaryEditing = false; };
// `next`: another view opens straight after (see closeStatsView).
const closeSummaryView = (next = false) => {
    if (!isSummaryViewActive) return;
    isSummaryViewActive = false;
    setViewIcon('summaryViewToggleBtn', false);
    summaryEls().panel.style.display = 'none';
    if (!next) showHomeView();
};

// The charts that go with each kind when printed: the same drawing as the
// Statistics panel, on the light surface.
const summaryCharts = () => {
    const s = summaryEls();
    const { from, to } = windowBounds(s);
    // As Statistics: a report with no time is left out only by a bound.
    let reps = localReports.filter(r => !r.deleted);
    if (from !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() >= from);
    if (to !== null)   reps = reps.filter(r => r.time && new Date(r.time).getTime() <= to);
    const local = timeDisplayMode === 'local';
    if (summaryKind === 'place') {
        reps = reps.filter(r => {
            const a = SaltCore.analyzeLocation(r.location, currentOverlays());
            return [...a.nai.keys, ...a.obj.keys, ...a.pls].includes(summaryPlace);
        });
    }
    const d = SaltCore.statsData(reps, currentOverlays(), { local, squareDigits: 2, team: narrTeam() });
    const ident = x => x;
    const all = {
        nai:     { title: 'Reports per NAI', kind: 'bar', items: d.nai },
        obj:     { title: 'Reports per OBJ', kind: 'bar', items: d.obj },
        squares: { title: 'Busiest 1 km grid squares', kind: 'bar', items: d.squares },
        hours:   { title: `Reports by hour of day (${local ? 'local' : 'Zulu'})`, kind: 'column', items: d.hours, labelEvery: 3, fmtX: ident },
        tags:    { title: 'Activity', kind: 'bar', items: d.tags },
    };
    const pick = SUMMARY_CHARTS[summaryKind] || [];
    const context = (summaryText.split('\n')[1] || '').replace(/^\S+:\s+/, '');
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
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(shownSummary().split('\n')[0])}</title><style>
        body { margin: 16mm; color: #0b0b0b; background: #fff; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        pre { font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: 10pt; white-space: pre-wrap; margin: 0 0 8mm; }
        svg { display: block; width: 100%; max-width: 170mm; height: auto; margin: 0 0 6mm; break-inside: avoid; }
    </style></head><body><pre>${escapeHtml(shownSummary())}</pre>${charts.map(c => chartSvg(c, 'light', true)).join('')}</body></html>`);
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
    [s.fromDate, s.toDate, s.fromTime, s.toTime].forEach(n => { n.addEventListener('change', renderSummary); n.addEventListener('input', renderSummary); });
    [s.fromTime, s.toTime].forEach(n => n.addEventListener('blur', e => { if (autoColonTime(e.target)) renderSummary(); }));
    s.place.addEventListener('change', () => { summaryPlace = s.place.value; renderSummary(); });
    // A narrower or wider window: the narrative re-wraps to fit.
    window.addEventListener('resize', debounce(() => { if (isSummaryViewActive && summaryKind === 'narrative') renderSummary(); }, 150));
    // Kept as typed, so Copy and Save have it even before Done.
    s.editor.addEventListener('input', () => {
        setEdit(s.editor.value);
        document.getElementById('summaryEdited').hidden = !(editKey() in summaryEdits);
    });
    s.panel.addEventListener('click', e => {
        const kind = e.target.closest('[data-summary-kind]');
        if (kind) { finishEditing(); summaryKind = kind.dataset.summaryKind; writeStored('salt_summary_kind', JSON.stringify(summaryKind)); renderSummary(); return; }
        const preset = e.target.closest('[data-summary-hours]');
        if (preset) { fillWindow(s, +preset.dataset.summaryHours); renderSummary(); return; }
        if (e.target.closest('#summaryCopyBtn')) { copyToClipboard(shownSummary()); showToast('Report copied.'); return; }
        if (e.target.closest('#summarySaveBtn')) { triggerDownload(summaryFileName(), shownSummary().replace(/\n/g, '\r\n')); return; }
        // Edit: the text in a box to change as you like; Done keeps it, Revert drops it.
        if (e.target.closest('#summaryEditBtn')) {
            if (summaryEditing) finishEditing();
            else {
                const own = editKey() in summaryEdits;
                summaryEditing = true; summaryEditingKey = editKey();
                s.editor.value = summaryToEdit();
                summaryEditSeed = own ? null : s.editor.value;
            }
            renderSummary();
            if (summaryEditing) { s.editor.focus(); s.editor.setSelectionRange(0, 0); s.editor.scrollTop = 0; }
            return;
        }
        if (e.target.closest('#summaryRevertBtn')) { summaryEditing = false; setEdit(null); renderSummary(); return; }
        if (e.target.closest('#summaryPrintBtn')) printSummary();
    });
})();

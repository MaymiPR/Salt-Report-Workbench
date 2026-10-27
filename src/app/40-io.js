// SPDX-License-Identifier: AGPL-3.0-only

// Workspaces panel, builder, export, backup and CSV import.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 7. Export / Import (file generation, downloads, CSV parsing) ---

// Identifier as displayed everywhere (table, copy text, toasts); follows the
// Title Separator toggle. Stored data is untouched.
const formatFullId = (r) => SaltCore.formatFullId(r, atoTitleSep);

// Copy text in the active workspace's format.
const generateReportText = (report) => SaltCore.reportText(report, currentFormat(), atoTitleSep);

// CSV filename: ATO_Title_YYYYMMDD_HHMM{Z|L}; the suffix matches the time mode.
const getCsvFilename = (ato, title) => `${SaltCore.backupFilename(ato, title)}_${fileStamp(new Date(), timeDisplayMode === 'local')}`;

const generateBackupText = (ato, reps, title, profiles) =>
    SaltCore.backupText(ato, reps, title, profiles, formatsFor([ato]), new Date(), sharedOverlays);
const generateAllAtosBackupText = (workspaces, activeAto, title, profiles) =>
    SaltCore.allWorkspacesBackupText(workspaces, activeAto, title, profiles, formatsFor(Object.keys(workspaces)), new Date(), sharedOverlays);

const triggerDownload = (filename, content, type = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.setAttribute('download', filename);
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
};

// Filter bounds in the active time mode.
const parseFilterTime = (dateStr, timeStr, isEnd) =>
    SaltCore.parseFilterTime(dateStr, timeStr, isEnd, timeDisplayMode === 'local');

const getExportFilteredReports = () => {
    const fromMs = parseFilterTime(el.exp.fromDate.value, el.exp.fromTime.value, false);
    const toMs   = parseFilterTime(el.exp.toDate.value,   el.exp.toTime.value,   true);
    let reps = localReports.filter(r => !r.deleted);
    if (fromMs !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() >= fromMs);
    if (toMs   !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() <= toMs);
    return reps;
};

const renderExportPreview = () => {
    const reps    = getExportFilteredReports();
    const allLive = localReports.filter(r => !r.deleted);
    const total   = allLive.length;
    const modeLb  = timeDisplayMode === 'local' ? '(Local)' : '(Zulu)';
    el.exp.subtitle.textContent = `ATO: ${activeAto||'—'} · ${total} report${total !== 1 ? 's' : ''}`;
    el.exp.fromMode.textContent = modeLb;
    el.exp.toMode.textContent   = modeLb;
    const hasFilter = !!(el.exp.fromDate.value || el.exp.toDate.value || el.exp.fromTime.value || el.exp.toTime.value);
    // Stacked counts matching the report-log header style.
    const totalAllHistory  = allLive.reduce((s, r) => s + 1 + ((r.history && r.history.length) || 0), 0);
    const totalWithHistory = reps.reduce((s, r) => s + 1 + ((r.history && r.history.length) || 0), 0);
    if (total === 0) {
        el.exp.filterCount.innerHTML = `<span class="filter-count-main">No reports</span>`;
    } else {
        el.exp.filterCount.innerHTML =
            `<span class="filter-count-main">${reps.length} of ${total} unique reports</span>` +
            `<span class="filter-count-detail">${totalWithHistory} of ${totalAllHistory} total reports</span>`;
    }
    el.exp.filterCount.classList.toggle('active', hasFilter);
};

// Loaded Workspaces list — rendered into both the panel tab and the
// viewer-mode sidebar. Active workspace highlighted blue.
const renderWorkspacesList = () => {
    if (!el.workspaces.list && !el.workspaces.sidebarList) return;
    const atos = Object.keys(reportsByAto).filter(a => (reportsByAto[a]||[]).some(r => !r.deleted));
    atos.sort();
    let html;
    if (atos.length === 0) {
        html = `<div class="workspaces-empty">No workspaces loaded.</div>`;
    } else {
        html = atos.map(ato => {
            const reps      = reportsByAto[ato] || [];
            const live      = reps.filter(r => !r.deleted);
            const histTotal = reps.reduce((s, r) => s + ((r.history && r.history.length) || 0), 0);
            // First non-empty title wins (matches the server's logic).
            let title = '';
            for (const r of reps) { if (r.title) { title = r.title; break; } }
            const source     = workspaceSources[ato] || '';
            // Editor mode: one tag ("Active") on the row the editor's logging into.
            // Viewer mode: two distinct concepts — "Active" follows the editor's
            // server-side choice; "Showing" follows the viewer's local click.
            const isActive   = ato === activeAto;
            const isShowing  = isReadOnly && ato === viewerShowingAto;
            // ACTIVE (A) lives inline next to the title — it's a property of the
            // workspace itself ("this is the one the editor is logging into").
            // SHOWING (S) lives in the right-side tag slot — it's a transient
            // marker for the viewer's local selection.
            //
            // The ACTIVE slot is ALWAYS rendered (visible or invisible) so the
            // SHOWING dot lands at the same horizontal coordinate on every
            // row — no shifting when a row has only S vs. both A+S.
            const activeTag  = isActive
                ? `<span class="workspace-active-tag" title="Active — the workspace the editor is logging into">A</span>`
                : `<span class="workspace-active-tag placeholder" aria-hidden="true">A</span>`;
            const showingTag = isShowing ? `<span class="workspace-showing-tag" title="Showing — the workspace you are currently viewing">S</span>` : '';
            // The blue row highlight follows where the user's attention is —
            // the editor's chosen workspace for editors, the viewer's clicked
            // row for viewers.
            const highlight  = isReadOnly ? isShowing : isActive;
            // Separator between ATO and title is user-configurable: a subdued
            // dash (default) or plain space. The title itself is a lighter-weight
            // sublabel so it reads distinct from the bold ATO either way.
            const sepHtml    = atoTitleSep === 'dash' ? `<span class="workspace-row-sep">-</span>` : '';
            const titlePart  = title ? `${sepHtml}<span class="workspace-row-title">${escapeHtml(title)}</span>` : '';
            const sourceHtml = source
                ? `<span class="workspace-source">${escapeHtml(source)}</span>`
                : `<span class="workspace-source empty">source unknown</span>`;
            // `data-switch-ato` is used by viewer mode (whole row clickable).
            // ACTIVE dot is a flex sibling of the ATO text so it stays pinned
            // beside the title even when long titles ellipsize. SHOWING dot
            // sits in the right-side slot as a viewer-status marker.
            return `<div class="workspace-row${highlight ? ' active' : ''}" data-switch-ato="${escapeHtml(ato)}">
                <div class="workspace-row-id">
                    <div class="workspace-row-ato-line">
                        <div class="workspace-row-ato">${escapeHtml(ato)}${titlePart}</div>
                        ${activeTag}
                        ${showingTag ? `<div class="workspace-row-tags">${showingTag}</div>` : ''}
                    </div>
                    <div class="workspace-row-meta">${sourceHtml}</div>
                </div>
                <div class="workspace-row-counts"><strong>${live.length}</strong> unique reports<br>${live.length + histTotal} total reports</div>
                <button type="button" class="workspace-row-unload" data-unload-ato="${escapeHtml(ato)}">Unload</button>
            </div>`;
        }).join('');
    }
    // Mirror into both containers (panel tab + viewer sidebar).
    if (el.workspaces.list)        el.workspaces.list.innerHTML        = html;
    if (el.workspaces.sidebarList) el.workspaces.sidebarList.innerHTML = html;
};

// Unload a workspace: server POST + local state clear. Active-workspace
// unload clears `activeAto` and the local config too.
async function unloadWorkspace(ato) {
    if (isReadOnly) { showToast('View-only mode. Unload is disabled here.', true); return; }
    if (!ato || !reportsByAto[ato]) return;
    const wasActive = (ato === activeAto);
    showConfirmation(`Unload workspace "${ato}" from view? (Backup file on disk is preserved.)`, async () => {
        try { await postJson('/api/unload_ato', { ato }); } catch(e){}
        delete reportsByAto[ato];
        delete workspaceSources[ato];
        saveReportsByAtoToLocal();
        if (wasActive) {
            activeAto    = '';
            localReports = [];
            localConfig  = { ato:'', title:'' };
            writeStored('salt_offline_config', JSON.stringify(localConfig));
            localStorage.removeItem('salt_last_active_ato');
            offlinePendingPush = false;
            writeStored('salt_offline_push', 'false');
            loadConfig();
            resetForm();
        }
        renderLog();
        populateAtoHistory();
        renderWorkspacesList();
        showToast(`Workspace "${ato}" unloaded.`);
    });
}

// Reset the filter pickers (Clear button + post-export).
const clearExportFilter = () => {
    el.exp.fromDate.value = '';
    el.exp.fromTime.value = '';
    el.exp.toDate.value   = '';
    el.exp.toTime.value   = '';
    renderExportPreview();
};

// Workspaces panel tabs: 'export' (default) | 'workspaces' | 'builder' | 'overlays' | 'identity'.
// Persisted in localStorage. Viewers get 'export' and 'overlays' only: the
// workspaces list lives in their sidebar, and the other tabs change things.
const VALID_TABS = ['export', 'workspaces', 'identity', 'builder', 'overlays'];
const switchWorkspacesTab = (tabName) => {
    if (!VALID_TABS.includes(tabName)) tabName = 'export';
    if (isReadOnly && tabName !== 'overlays') tabName = 'export';
    el.workspaces.tabs.forEach(btn => {
        const isActive = btn.dataset.tab === tabName;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    el.workspaces.tabPanels.forEach(panel => {
        panel.style.display = (panel.dataset.tabPanel === tabName) ? '' : 'none';
    });
    writeStored('salt_workspaces_tab', tabName);
    // Refresh derived state on switch so filter counts / list aren't stale.
    if (tabName === 'export')          renderExportPreview();
    else if (tabName === 'workspaces') renderWorkspacesList();
    else if (tabName === 'builder')    renderBuilder();
    else if (tabName === 'overlays')   renderOverlays();
};

// ─── Report Builder ──────────────────────────────────────────────────────
const BUILTIN_LABELS = { id:'Identifier', size:'Size', activity:'Activity', location:'Location', time:'Time', analysis:'Analysis' };

const renderBuilder = () => {
    const box = document.getElementById('builderLines');
    if (!box) return;
    const fmt  = currentFormat();
    const note = document.getElementById('builderScopeNote');
    if (note) note.textContent = activeAto ? `for ${activeAto} (synced to everyone)` : '(set a workspace first)';
    box.innerHTML = fmt.lines.map((l, i) => {
        const name = l.type === 'custom' ? (l.name || l.label) : BUILTIN_LABELS[l.type] || l.type;
        const sub  = l.type === 'id'     ? (i === 0 ? 'header line' : 'U: line')
                   : l.type === 'custom' ? `copies as ${escapeHtml(l.label)}:` : '';
        return `<div class="builder-line" draggable="true" data-idx="${i}">
            <span class="builder-grip" title="Drag to reorder">&#10495;</span>
            <span class="builder-line-name">${escapeHtml(name)}${sub ? ` <span class="builder-line-sub">${sub}</span>` : ''}</span>
            <span class="builder-line-btns">
                <button type="button" class="builder-mv" data-mv="-1" data-idx="${i}" title="Move up">&#9650;</button>
                <button type="button" class="builder-mv" data-mv="1" data-idx="${i}" title="Move down">&#9660;</button>
                <button type="button" class="builder-del" data-idx="${i}" title="Remove line">&#10005;</button>
            </span>
        </div>`;
    }).join('');
    // Add-back palette: any built-in not currently in the format (this is
    // where the hidden-by-default Analysis gets re-enabled).
    const present = new Set(fmt.lines.map(l => l.type));
    const missing = Object.keys(BUILTIN_LABELS).filter(t => !present.has(t));
    const pal     = document.getElementById('builderPalette');
    if (pal) {
        pal.style.display = missing.length ? '' : 'none';
        pal.innerHTML = missing.length
            ? `<span class="startup-chips-label">Add back</span>` + missing.map(t =>
                `<button type="button" class="filter-preset-btn" data-fmt-addback="${t}">${BUILTIN_LABELS[t]}</button>`).join('')
            : '';
    }
    renderBuilderPreview();
};

const renderBuilderPreview = () => {
    const pre = document.getElementById('builderPreview');
    if (!pre) return;
    const fmt    = currentFormat();
    const latest = localReports.filter(r => !r.deleted).slice(-1)[0];
    const sample = latest || {
        title: (localConfig && localConfig.title) || 'Report #',
        displayId: `${(activeAto || 'ATO')}001`,
        size: '2x BTR', activity: 'Moving north', location: '18SUJ2337106519',
        time: new Date().toISOString(), yourAnalysis: 'Likely screening element.', custom: {},
    };
    // Show custom lines even when the sample has no value yet.
    const s = { ...sample, custom: { ...(sample.custom || {}) } };
    fmt.lines.forEach(l => { if (l.type === 'custom' && !s.custom[l.label]) s.custom[l.label] = '…'; });
    pre.textContent = generateReportText(s);
};

// All format mutations funnel through here: guard, clone, apply, save, re-render.
const mutateFormat = (fn) => {
    if (!activeAto) { showToast('Set a workspace first.', true); return; }
    const copy = { preset: 'custom', lines: currentFormat().lines.map(l => ({ ...l })) };
    fn(copy);
    saveWorkspaceFormat(copy);
    renderBuilder();
};

const moveFormatLine = (from, to) => {
    mutateFormat(f => {
        if (to < 0 || to >= f.lines.length || from === to) return;
        const [line] = f.lines.splice(from, 1);
        f.lines.splice(to, 0, line);
    });
};

const initBuilderHandlers = () => {
    const panel = document.querySelector('[data-tab-panel="builder"]');
    if (!panel) return;
    let dragIdx = null;
    panel.addEventListener('click', e => {
        const preset = e.target.closest('[data-fmt-preset]');
        if (preset) {
            if (!activeAto) { showToast('Set a workspace first.', true); return; }
            const p = preset.dataset.fmtPreset;
            // Custom fields survive a preset switch — appended after the preset lines.
            const customs = currentFormat().lines.filter(l => l.type === 'custom');
            saveWorkspaceFormat({ preset: p, lines: [...FORMAT_PRESETS[p].map(l => ({ ...l })), ...customs] });
            renderBuilder();
            showToast(`Format preset: ${p.toUpperCase()}.`);
            return;
        }
        const mv = e.target.closest('.builder-mv');
        if (mv) { const i = +mv.dataset.idx; moveFormatLine(i, i + (+mv.dataset.mv)); return; }
        const del = e.target.closest('.builder-del');
        if (del) {
            if (currentFormat().lines.length <= 1) { showToast('A format needs at least one line.', true); return; }
            mutateFormat(f => f.lines.splice(+del.dataset.idx, 1));
            return;
        }
        const addBack = e.target.closest('[data-fmt-addback]');
        if (addBack) { mutateFormat(f => f.lines.push({ type: addBack.dataset.fmtAddback })); return; }
        if (e.target.id === 'builderAddBtn') {
            const letterInp = document.getElementById('builderNewLetter');
            const nameInp   = document.getElementById('builderNewLabel');
            const letter    = letterInp.value.trim().toUpperCase();
            const name      = nameInp.value.trim();
            if (!letter) { showToast('Enter the letter the field copies as (e.g. W).', true); return; }
            // Letters used by the built-in lines are reserved.
            if (['S','A','L','T','Y','U'].includes(letter)) { showToast(`"${letter}" is reserved by a built-in line.`, true); return; }
            const taken = currentFormat().lines.some(l => l.type === 'custom' && l.label.toLowerCase() === letter.toLowerCase());
            if (taken) { showToast(`"${letter}" already exists in the format.`, true); return; }
            mutateFormat(f => f.lines.push({ type: 'custom', label: letter, name: name || letter }));
            letterInp.value = '';
            nameInp.value = '';
        }
    });
    panel.addEventListener('dragstart', e => {
        const row = e.target.closest('.builder-line');
        if (row) { dragIdx = +row.dataset.idx; e.dataTransfer.effectAllowed = 'move'; }
    });
    panel.addEventListener('dragover', e => { if (dragIdx !== null) e.preventDefault(); });
    panel.addEventListener('drop', e => {
        const row = e.target.closest('.builder-line');
        if (row && dragIdx !== null) { e.preventDefault(); moveFormatLine(dragIdx, +row.dataset.idx); }
        dragIdx = null;
    });
};
initBuilderHandlers();

// --- Export picker ---
// Each entry presses one of the (hidden) action buttons, or runs an export
// itself. `needs` names the option it shows. Imports are the drop area below.
const IO_FORMATS = {
    export: [
        { id: 'backup', label: 'Backup (.txt)', btn: 'exportPanelBackupBtn', needs: 'backup',
          desc: 'Every report with its updates, BDA, report format and the overlays. Opens in Notepad; Import it on any workbench.' },
        { id: 'csv', label: 'Reports for Excel (.csv)', btn: 'exportPanelCsvBtn', needs: 'csv',
          desc: 'One row per report, and one per saved update (or, with Latest version only, just the report), with the time filter below.' },
        { id: 'arcgis-shp', label: 'ArcGIS points (Shapefile .zip)', run: () => exportForArcgis('shp'),
          desc: 'One point per grid of each report as it is now (its updates are not extra points), for heat maps. Unzip it, then drag the .shp into ArcGIS Pro or browse to it from a folder connection. ArcGIS Online takes the zip as it is. Text longer than 254 characters is cut.' },
        { id: 'arcgis-esri', label: 'ArcGIS points (.json, Esri JSON)', btn: 'exportArcgisEsriBtn',
          desc: 'The same points with every character of text. ArcGIS Pro does not drag these in: run JSON To Features on the file.' },
        { id: 'arcgis-geojson', label: 'ArcGIS points (.geojson)', btn: 'exportArcgisGeojsonBtn',
          desc: 'The same points as GeoJSON, for other GIS, or JSON To Features in ArcGIS Pro. Text longer than 254 characters is cut.' },
        { id: 'arcgis-csv', label: 'ArcGIS points (.csv)', btn: 'exportArcgisCsvBtn',
          desc: 'The same points as a table: XY Table To Point, with lon as X and lat as Y (WGS 1984).' },
        { id: 'tracks-shp', label: 'ArcGIS tracks (Shapefile .zip)', run: () => exportForArcgis('tracks-shp'),
          desc: 'One line per report that moved, from its first grid through its updates to the latest, for an arrow at the end (Symbology: a line with an end arrow). Unzip it, then drag the .shp into ArcGIS Pro.' },
        { id: 'tracks-esri', label: 'ArcGIS tracks (.json, Esri JSON)', run: () => exportForArcgis('tracks-esri'),
          desc: 'The same tracks as Esri JSON, for JSON To Features.' },
        { id: 'tracks-geojson', label: 'ArcGIS tracks (.geojson)', run: () => exportForArcgis('tracks-geojson'),
          desc: 'The same tracks as GeoJSON lines, drawn first to latest.' },
    ],
};
const ioFormat = () => IO_FORMATS.export.find(f => f.id === el.ioPicker.select.value) || IO_FORMATS.export[0];
const renderIoPicker = () => {
    const p = el.ioPicker;
    if (!p.select) return;
    const remembered = localStorage.getItem('salt_io_export');
    p.select.innerHTML = IO_FORMATS.export.map(f => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join('');
    if (IO_FORMATS.export.some(f => f.id === remembered)) p.select.value = remembered;
    const f = ioFormat();
    p.desc.textContent = f.desc;
    // Each option shows with the format it changes.
    document.querySelectorAll('#exportPanel [data-io-for]').forEach(n => { n.hidden = n.dataset.ioFor !== f.needs; });
    document.querySelectorAll('#exportPanel .io-options').forEach(n => { n.hidden = !f.needs; });
};
const runIoPicker = () => {
    const f = ioFormat();
    if (f.run) f.run();
    else document.getElementById(f.btn).click();
};

// A dropped (or chosen) file imported as what it is: a backup, another
// tool's CSV, or overlays (several overlay files go in together, as a
// shapefile's parts do). A file with another name is read as a backup when
// it is one.
const OVERLAY_FILE = /\.(kml|kmz|geojson|json|zip|shp|shx|dbf|prj|cpg)$/i;
const importFiles = (fileList) => {
    if (isReadOnly) { showToast('View-only mode. Importing is disabled here.', true); return; }
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const read = (f, then) => { const r = new FileReader(); r.onload = ev => then(String(ev.target.result)); r.readAsText(f); };
    const shapes = files.filter(f => OVERLAY_FILE.test(f.name));
    if (shapes.length === files.length) { switchWorkspacesTab('overlays'); startOverlayImport(shapes); return; }
    if (files.length > 1) { showToast('Drop one backup or CSV at a time. Several files together must all be overlays.', true); return; }
    const f = files[0];
    if (/\.csv$/i.test(f.name)) { read(f, text => processExternalCsv(text, f.name)); return; }
    read(f, text => {
        if (/\.txt$/i.test(f.name) || text.includes('SALT_BACKUP')) processJsonImport(text);
        else showToast(`Can't tell what ${f.name} is. Import takes a backup (.txt), a CSV, or overlay files.`, true);
    });
};
(() => {
    const tab = document.querySelector('#exportPanel [data-tab-panel="export"]');
    const drop = document.getElementById('ioDrop');
    if (!tab || !drop) return;
    const chooser = Object.assign(document.createElement('input'), { type: 'file', id: 'ioDropInput', multiple: true, hidden: true });
    chooser.addEventListener('change', () => { const files = chooser.files; importFiles(files); chooser.value = ''; });
    tab.appendChild(chooser);
    drop.addEventListener('click', () => chooser.click());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooser.click(); } });
    const hasFiles = e => !isReadOnly && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    tab.addEventListener('dragover', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        tab.classList.add('io-dropping');
    });
    tab.addEventListener('dragleave', e => { if (!tab.contains(e.relatedTarget)) tab.classList.remove('io-dropping'); });
    tab.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        tab.classList.remove('io-dropping');
        importFiles(e.dataTransfer.files);
    });
})();

const openExportView = () => {
    closeStatsView();
    closeSummaryView();
    isExportViewActive = true;
    el.log.view.style.display  = 'none';
    el.exp.panel.style.display = 'flex';
    setViewIcon('exportViewToggleBtn', true);
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'export');
    renderIoPicker();
    // Restore last-used tab; default 'export' for fresh sessions.
    switchWorkspacesTab(localStorage.getItem('salt_workspaces_tab') || 'export');
    renderExportPreview();
    renderWorkspacesList();
};

const closeExportView = () => {
    isExportViewActive = false;
    el.log.view.style.display  = 'flex';
    el.exp.panel.style.display = 'none';
    setViewIcon('exportViewToggleBtn', false);
    writeStored('salt_view', 'log');
};

function processJsonImport(rawText) {
    // Validate up-front so the user sees a precise error before the confirm prompt.
    const parsed = SaltCore.parseBackup(rawText);
    if (parsed.error) { showToast(parsed.error, true); return; }
    const imp = parsed.data;

    showConfirmation('Merge central log with data from backup file?', async () => {
        try {
            let all = { ...reportsByAto };
            if (imp.workspaces && typeof imp.workspaces === 'object') {
                for (const [ato, reps] of Object.entries(imp.workspaces)) all[ato] = reps;
            } else if (imp.reports && Array.isArray(imp.reports)) {
                if (activeAto) all[activeAto] = imp.reports;
            }
            if (imp.config && imp.config.ato && imp.config.title) {
                activeAto   = imp.config.ato;
                localConfig = { ato: imp.config.ato, title: imp.config.title };
                writeStored('salt_offline_config', JSON.stringify(localConfig));
                writeStored('salt_last_active_ato', activeAto);
                setAtoState(true);
            }
            // The file's report format is taken only while this one is still
            // the stock one: an operator's own format changes only in the Builder.
            if (imp.formats && typeof imp.formats === 'object' && isStockFormat()) {
                const own = Object.values(imp.formats).filter(isFormat);
                const fFmt = (imp.config && isFormat(imp.formats[imp.config.ato]) && imp.formats[imp.config.ato]) || own[0];
                if (fFmt) saveWorkspaceFormat(fFmt);
            }
            // And the overlays (NAI / OBJ / PL): the file's replace any of the
            // same type and name; the rest are kept.
            const impOverlays = SaltCore.foldOverlays(imp.overlays);
            if (impOverlays.length) await saveOverlays(mergeOverlays(sharedOverlays, impOverlays));
            await saveLocalAndSync(all, 'backup');
            // That pushed the active workspace only. Push the rest of the
            // file too: the sync below replaces local state with the server's,
            // so anything not pushed would be lost.
            let unsent = 0;
            for (const ato of isLocalFile ? [] : Object.keys(imp.workspaces || {})) {
                if (ato === activeAto || !(all[ato] || []).length) continue;
                if (await pushWorkspace(ato, all[ato], 'backup') === 'queued') unsent++;
            }
            closeExportView();
            loadConfig();
            if (imp.profiles) { for (const key in imp.profiles) { try { await postJson('/api/save_profile', { profile: imp.profiles[key] }); } catch(e){} } }
            if (imp.config && imp.config.ato) { try { await postJson('/api/save_config', { config: imp.config }); } catch(e){} }
            if (unsent) {
                // Don't sync: it would drop the workspaces the server never got.
                showToast(`${unsent} workspace(s) couldn't reach the server. Import the file again once it's back.`, true);
                return;
            }
            showToast('Import successful. Syncing...');
            syncWithServer();
        } catch (err) { showToast('Import failed: ' + (err && err.message ? err.message : 'invalid file'), true); }
    });
}

function processExternalCsv(csvText, filename) {
    const arr = SaltCore.parseCsv(csvText);
    if (arr.length < 2) { showToast('CSV is empty or invalid.', true); return; }
    const headers = (arr[0]||[]).map(h => (h||'').trim());
    if (!headers.some(h => h)) { showToast('CSV has no header row.', true); return; }
    const rows = arr.slice(1).filter(r => r && !r.every(c => !(c||'').trim()));
    if (!rows.length) { showToast('CSV has no data rows.', true); return; }
    pendingCsv = { headers, rows, filename: filename || 'CSV file' };
    openCsvImportView();
}

const openCsvImportView = () => {
    if (!pendingCsv) return;
    // The CSV mapping view replaces the export view — keep the menu button's "active"
    // state in sync so the next click opens the panel on the first try.
    isExportViewActive = false;
    setViewIcon('exportViewToggleBtn', false);
    el.log.view.style.display   = 'none';
    el.exp.panel.style.display  = 'none';
    el.csv.panel.style.display  = 'flex';
    el.menu.panel.style.display = 'none';

    el.csv.subtitle.textContent =
        `${pendingCsv.filename} · ${pendingCsv.headers.length} columns · ${pendingCsv.rows.length} rows`;

    // Column reference badges
    el.csv.colList.innerHTML = pendingCsv.headers
        .map((h, i) => h
            ? `<span class="csv-col-badge">${escapeHtml(h)}</span>`
            : `<span class="csv-col-badge empty">Column ${i+1}</span>`)
        .join('');

    // Build a select with "(None)" + every CSV column; auto-select `selected`
    const buildOptions = (selected) => {
        let html = '<option value="">&mdash; None &mdash;</option>';
        pendingCsv.headers.forEach((h, i) => {
            const sel  = i === selected ? ' selected' : '';
            const text = h ? escapeHtml(h) : `Column ${i+1}`;
            html += `<option value="${i}"${sel}>${text}</option>`;
        });
        return html;
    };
    const lower = pendingCsv.headers.map(h => (h||'').toLowerCase());
    const guess = (kws) => lower.findIndex(h => h && kws.some(k => h.includes(k)));
    el.csv.mapTitle.innerHTML    = buildOptions(guess(['name','identifier','id','track','callsign']));
    el.csv.mapSize.innerHTML     = buildOptions(guess(['size','count','qty']));
    el.csv.mapActivity.innerHTML = buildOptions(guess(['activity','description','desc','anchor']));
    el.csv.mapLocation.innerHTML = buildOptions(guess(['mgrs','location','loc','coord','grid']));
    el.csv.mapTime.innerHTML     = buildOptions(guess(['time','timestamp','date']));

    // Destination — active ATO (if set) first, then IMPORT, then the rest
    const others = Object.keys(reportsByAto).filter(k => k && k !== 'IMPORT' && k !== activeAto);
    let destHtml = '';
    if (activeAto && activeAto !== 'IMPORT') {
        destHtml += `<option value="${escapeHtml(activeAto)}">Active: ${escapeHtml(activeAto)}</option>`;
    }
    destHtml += '<option value="IMPORT">IMPORT workspace</option>';
    others.forEach(a => { destHtml += `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`; });
    el.csv.destSelect.innerHTML = destHtml;
};

const closeCsvImportView = () => {
    el.csv.panel.style.display = 'none';
    el.log.view.style.display  = 'flex';
    writeStored('salt_view', 'log');
    pendingCsv = null;
};

const confirmCsvImport = async () => {
    try {
    if (!pendingCsv) { closeCsvImportView(); return; }
    const parseIdx = (v) => v === '' ? -1 : parseInt(v, 10);
    const idx = {
        title:    parseIdx(el.csv.mapTitle.value),
        size:     parseIdx(el.csv.mapSize.value),
        activity: parseIdx(el.csv.mapActivity.value),
        location: parseIdx(el.csv.mapLocation.value),
        time:     parseIdx(el.csv.mapTime.value),
    };
    if (idx.title === -1 && idx.size === -1 && idx.activity === -1 && idx.location === -1 && idx.time === -1) {
        showToast('Map at least one CSV column before importing.', true);
        return;
    }

    // Imported rows should be attributed to whoever is doing the import.
    // Fall back to the values typed into the profile menu when nothing has been saved yet.
    let importer = userProfile;
    if (!importer || !importer.initials) {
        const ini = (el.profile.initials.value || '').trim().toUpperCase();
        const col = el.profile.color.value || '#0a84ff';
        if (!ini) {
            showToast('Set your initials before importing.', true);
            // Surface the identity form: open the panel on the Identity tab.
            if (!isExportViewActive) openExportView();
            switchWorkspacesTab('identity');
            return;
        }
        importer = { initials: ini, color: col };
    }

    const dest     = el.csv.destSelect.value || 'IMPORT';
    const existing = reportsByAto[dest] || [];
    const lastNum  = existing.reduce((m, r) => Math.max(m, reportNum(r)), 0);
    const prefix   = dest === 'IMPORT' ? 'IMP' : SaltCore.atoPrefix(dest);
    const destTitle = dest === 'IMPORT' ? 'IMPORT' : ((existing.find(r => r.title) || {}).title || dest);

    let imported = 0, skipped = 0, unreadTimes = 0;
    const newReps = [];
    const importedAt = new Date().toISOString();
    pendingCsv.rows.forEach(r => {
        const activity = idx.activity !== -1 ? (r[idx.activity]||'').trim() : '';
        const size     = idx.size     !== -1 ? (r[idx.size]    ||'').trim() : '';
        const loc      = idx.location !== -1 ? (r[idx.location]||'').trim() : '';
        const t        = idx.time     !== -1 ? (r[idx.time]    ||'').trim() : '';
        const csvTitle = idx.title    !== -1 ? (r[idx.title]   ||'').trim() : '';
        // Skip rows where every mapped column is blank — otherwise the imported
        // table fills up with empty entries from trailing CSV newlines.
        if (!activity && !size && !loc && !t && !csvTitle) { skipped++; return; }
        const did  = `${prefix}${String(lastNum + newReps.length + 1).padStart(3,'0')}`;
        const full = csvTitle || (dest === 'IMPORT' ? did : `${destTitle}${did}`);
        // The server only takes ISO 8601; a time it can't read would refuse the
        // whole row, so unreadable ones get the import time and are counted.
        const when = t ? SaltCore.parseCsvTime(t, timeDisplayMode === 'local') : null;
        if (t && !when) unreadTimes++;
        newReps.push({
            id: generateUUID(),
            displayId: did,
            fullId:    full,
            ato:       SaltCore.atoPrefix(dest),
            title:     destTitle,
            size:      size || '-',
            activity,
            location:  loc,
            time:      when || importedAt,
            yourAnalysis: '',
            history: [],
            updated: false,
            lastModified: Date.now(),
            user: importer,
        });
        imported++;
    });

    if (imported === 0) { showToast(`Nothing imported. ${skipped} row(s) skipped.`, true); return; }

    reportsByAto[dest] = [...existing, ...newReps];
    if (activeAto !== dest) {
        activeAto = dest;
        writeStored('salt_last_active_ato', dest);
        if (dest !== 'IMPORT') {
            localConfig = { ato: dest, title: destTitle };
            writeStored('salt_offline_config', JSON.stringify(localConfig));
            setAtoState(true);
            loadConfig();
        }
    }
    // Commit the new state locally and render immediately for instant feedback.
    localReports = reportsByAto[activeAto] || [];
    saveReportsByAtoToLocal();
    renderLog();
    closeCsvImportView();
    let msg = `Imported ${imported} report(s) to ${dest}.`;
    if (skipped > 0) msg += ` ${skipped} row(s) skipped.`;
    if (unreadTimes > 0) msg += ` ${unreadTimes} time(s) couldn't be read and got the import time.`;
    showToast(msg, unreadTimes > 0);
    // Now push to the server and wait for the response. By awaiting here, any
    // SSE-triggered sync that fires afterwards is guaranteed to see our reports
    // already in the server's state — eliminating the race where a stale sync
    // could overwrite the freshly-imported data.
    const intendedAto = activeAto;
    await pushToServer('csv');
    // If a concurrent sync arrived during the await and demoted activeAto, restore it
    // and re-anchor localReports to the destination we imported into.
    if (activeAto !== intendedAto) {
        activeAto = intendedAto;
        writeStored('salt_last_active_ato', intendedAto);
    }
    localReports = reportsByAto[activeAto] || [];
    renderLog();
    } catch (err) {
        showToast('Import error: ' + (err && err.message ? err.message : String(err)), true);
        console.error('CSV import failed:', err);
    }
};

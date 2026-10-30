// SPDX-License-Identifier: AGPL-3.0-only

// Manage panel, builder, export, backup and CSV import.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 7. Export / Import (file generation, downloads, CSV parsing) ---

// Identifier as displayed everywhere (table, copy text, toasts); follows the
// Title Separator toggle. Stored data is untouched.
const formatFullId = (r) => SaltCore.formatFullId(r, atoTitleSep);

// Copy text in the active workspace's format, its Size after BDA.
const generateReportText = (report) => SaltCore.reportText(report, currentFormat(), atoTitleSep, narrTeam());

// CSV filename: ATO_Title_YYYYMMDD_HHMM{Z|L}; the suffix matches the time mode.
const exportFilename = (ato, title) => `${SaltCore.backupFilename(ato, title)}_${fileStamp(new Date(), timeDisplayMode === 'local')}`;

const generateBackupText = (ato, reps, title, profiles) =>
    SaltCore.backupText(ato, reps, title, profiles, formatsFor([ato]), new Date(), sharedOverlays, sharedNarrative, sharedTags);
const generateAllAtosBackupText = (workspaces, activeAto, title, profiles) =>
    SaltCore.allWorkspacesBackupText(workspaces, activeAto, title, profiles, formatsFor(Object.keys(workspaces)), new Date(), sharedOverlays, sharedNarrative, sharedTags);

const triggerDownload = (filename, content, type = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.setAttribute('download', filename);
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
};

// Filter bounds in the active time mode.
const parseFilterTime = (dateStr, timeStr, isEnd) =>
    SaltCore.parseFilterTime(dateStr, timeStr, isEnd, timeDisplayMode === 'local');

const getExportFilteredReports = () => {
    const fromMs = parseFilterTime(el.manage.fromDate.value, el.manage.fromTime.value, false);
    const toMs   = parseFilterTime(el.manage.toDate.value,   el.manage.toTime.value,   true);
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
    el.manage.subtitle.textContent = `ATO: ${activeAto||'-'} · ${plural(total, 'report')}`;
    el.manage.fromMode.textContent = modeLb;
    el.manage.toMode.textContent   = modeLb;
    const hasFilter = !!(el.manage.fromDate.value || el.manage.toDate.value || el.manage.fromTime.value || el.manage.toTime.value);
    // Stacked counts matching the report-log header style.
    const totalAllHistory  = allLive.reduce((s, r) => s + 1 + ((r.history && r.history.length) || 0), 0);
    const totalWithHistory = reps.reduce((s, r) => s + 1 + ((r.history && r.history.length) || 0), 0);
    if (total === 0) {
        el.manage.filterCount.innerHTML = `<span class="filter-count-main">No reports</span>`;
    } else {
        el.manage.filterCount.innerHTML =
            `<span class="filter-count-main">${reps.length} of ${total} unique reports</span>` +
            `<span class="filter-count-detail">${totalWithHistory} of ${totalAllHistory} total reports</span>`;
    }
    el.manage.filterCount.classList.toggle('active', hasFilter);
};

// Loaded Workspaces list — rendered into both the panel tab and the
// viewer-mode sidebar. Active workspace highlighted blue.
// What each workspaces list was last drawn with.
const workspacesDrawn = new WeakMap();
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
                ? `<span class="workspace-active-tag" title="Active: the workspace you are logging into">A</span>`
                : `<span class="workspace-active-tag placeholder" aria-hidden="true">A</span>`;
            const showingTag = isShowing ? `<span class="workspace-showing-tag" title="Showing: the workspace you are viewing">S</span>` : '';
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
            // The editors working in it (each editor has their own workspace).
            const here = Object.keys(connectedWhere).filter(ini => connectedWhere[ini] === ato).sort();
            const hereHtml = here.length
                ? `<span class="workspace-here" title="Editors in this workspace">${here.map(escapeHtml).join(', ')}</span>`
                : '';
            // Its Unload pressed once: the line under its name asks in its place.
            const ask = isAsking(`unload|${ato}`);
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
                    <div class="workspace-row-meta">${ask ? '<span class="map-base-ask" role="status">Unload for everyone?</span>' : sourceHtml + hereHtml}</div>
                </div>
                <div class="workspace-row-counts"><strong>${live.length}</strong> unique reports<br>${live.length + histTotal} total reports</div>
                <button type="button" class="workspace-row-unload" data-unload-ato="${escapeHtml(ato)}"${ask ? ' data-asking' : ''}>Unload</button>
            </div>`;
        }).join('');
    }
    // Mirror into both containers (panel tab + viewer sidebar). Unchanged,
    // it's left as it is: every sync draws it, and a row replaced under the
    // pointer loses the click being made on it.
    [el.workspaces.list, el.workspaces.sidebarList].forEach(box => {
        if (box && workspacesDrawn.get(box) !== html) { box.innerHTML = html; workspacesDrawn.set(box, html); }
    });
};

// What editors changed since the server started, newest first: "CD logged
// ALPHA012 · 2 min ago", from /api/sync's `activity`. In the Workspaces tab,
// and for viewers in their sidebar. A change in another workspace than the
// one on screen says which, unless its words name it already.
const renderActivity = () => {
    if (!el.workspaces.activity && !el.workspaces.sidebarActivity) return;
    const shown = isReadOnly ? viewerShowingAto : activeAto;
    const rows = peerActivity.filter(e => e && typeof e.what === 'string').slice(-50).reverse().map(e => {
        const where = e.ato && e.ato !== shown && !e.what.endsWith(e.ato) ? ` in ${e.ato}` : '';
        return `<li class="peer-activity-row"><span class="peer-activity-what">${escapeHtml(`${e.who || 'Someone'} ${e.what}${where}`)}</span>`
            + `<span class="peer-activity-when"> · ${timeAgo(Number(e.at) || 0)}</span></li>`;
    });
    const html = rows.length ? `<ul class="peer-activity-rows">${rows.join('')}</ul>`
        : `<div class="workspaces-empty">Nothing yet since the server started.</div>`;
    // Unchanged, left as it is, like the workspaces list.
    [el.workspaces.activity, el.workspaces.sidebarActivity].forEach(box => {
        if (box && workspacesDrawn.get(box) !== html) { box.innerHTML = html; workspacesDrawn.set(box, html); }
    });
};
// "2 min ago" moves on without a sync: the list and the form's line are
// drawn again each half minute.
setInterval(() => { renderActivity(); renderPeerChange(); }, 30000);

// This editor is in no workspace now (theirs was unloaded): they set one
// to log again.
function leaveWorkspace() {
    if (activeAto) markPending(activeAto, false);
    activeAto    = '';
    localReports = [];
    localConfig  = { ato:'', title:'' };
    writeStored('salt_offline_config', JSON.stringify(localConfig));
    removeStored('salt_last_active_ato');
    offlinePendingPush = false;
    writeStored('salt_offline_push', 'false');
    loadConfig();
    resetForm();
}

// Who is in which workspace, on the connected-operators chips: "AB in ALPHA".
function renderWhoIsWhere() {
    const where = Object.entries(connectedWhere).sort(([a], [b]) => a.localeCompare(b));
    const label = where.length ? where.map(([ini, ato]) => `${ini} in ${ato}`).join(', ') : 'Users connected';
    document.querySelectorAll('.connected-users-chip').forEach(chip => { chip.title = label; });
}

// Unload a workspace (its caller has asked first): server POST + local
// state clear. Active-workspace unload clears `activeAto` and the local
// config too. Only once the server has unloaded it: a pull would bring back
// one it still holds. Its backup file on disk is kept either way.
async function unloadWorkspace(ato) {
    if (isReadOnly) { showToast('View-only mode. Unload is disabled here.', true); return; }
    if (!ato || !reportsByAto[ato]) return;
    // What Undo sends back: its reports as they are now, and this editor's
    // place in it.
    const kept = JSON.parse(JSON.stringify(ato === activeAto ? localReports : reportsByAto[ato]));
    const mine = ato === activeAto ? { ...localConfig } : null;
    const res = isLocalFile ? { ok: true } : await apiPost('/api/unload_ato', { ato });
    if (!res.ok) {
        if (res.status !== 401) showToast(`Not unloaded: ${res.message}`, true);
        return;
    }
    markPending(ato, false);
    delete reportsByAto[ato];
    delete workspaceSources[ato];
    saveReportsByAtoToLocal();
    if (ato === activeAto) leaveWorkspace();
    renderLog();
    populateAtoHistory();
    renderWorkspacesList();
    undoToast(`Workspace "${ato}" unloaded.`, () => undoUnload(ato, kept, mine));
}

// Undo an unload: its reports go back to the server, all of them (it holds
// none now), beside any that came back meanwhile. They go as a backup's do,
// so each keeps its author (a plain save would make the one pressing Undo
// the author of every report). An editor who was in it is in it again,
// unless they have set another since.
async function undoUnload(ato, kept, mine) {
    const have = reportsByAto[ato] || [];
    const list = [...have, ...kept.filter(r => !have.some(x => x.id === r.id))];
    if (!list.length) return;   // an empty push would unload it again
    delete serverVersions[ato];
    const queued = await pushWorkspace(ato, list, 'backup') === 'queued';
    markPending(ato, queued);
    // A pull while it was sent may have replaced the lists.
    reportsByAto[ato] = reportsByAto[ato] || list;
    if (mine && !activeAto) {
        configChanging = false;
        activeAto    = ato;
        localConfig  = mine;
        localReports = reportsByAto[ato];
        writeStored('salt_last_active_ato', activeAto);
        writeStored('salt_offline_config', JSON.stringify(localConfig));
        loadConfig();
        apiPost('/api/save_config', { config: mine });
    }
    saveReportsByAtoToLocal();
    renderLog();
    populateAtoHistory();
    renderWorkspacesList();
    undoneToast(`Workspace "${ato}" is back.`, !queued);
}

// Reset the filter pickers (Clear button + post-export).
const clearExportFilter = () => {
    el.manage.fromDate.value = '';
    el.manage.fromTime.value = '';
    el.manage.toDate.value   = '';
    el.manage.toTime.value   = '';
    renderExportPreview();
};

// Manage panel tabs: 'export' (default) | 'workspaces' | 'builder' | 'overlays' | 'identity'.
// Persisted in localStorage. Viewers get 'export' only: the workspaces list
// lives in their sidebar, the map is the Map view, and the rest change things.
const VALID_TABS = ['export', 'workspaces', 'identity', 'builder', 'overlays'];
const switchManageTab = (tabName) => {
    if (!VALID_TABS.includes(tabName)) tabName = 'export';
    hideIdentityAccessCode();
    if (isReadOnly) tabName = 'export';
    el.workspaces.tabs.forEach(btn => setOn(btn, btn.dataset.tab === tabName, 'aria-selected'));
    el.workspaces.tabPanels.forEach(panel => {
        panel.style.display = (panel.dataset.tabPanel === tabName) ? '' : 'none';
    });
    writeStored('salt_workspaces_tab', tabName);
    // Refresh derived state on switch so filter counts / list aren't stale.
    if (tabName === 'export')          renderExportPreview();
    else if (tabName === 'workspaces') { renderWorkspacesList(); renderActivity(); }
    else if (tabName === 'builder')    renderBuilder();
    else if (tabName === 'overlays')   { showMapSub('graphics'); renderOverlays(); renderBasemapManager(); }
};

// ─── Report Builder ──────────────────────────────────────────────────────
const BUILTIN_LABELS = { id:'Identifier', size:'Size', activity:'Activity', location:'Location', time:'Time', analysis:'Analysis' };

const renderBuilder = () => {
    const box = document.getElementById('builderLines');
    if (!box) return;
    const fmt  = currentFormat();
    const note = document.getElementById('builderScopeNote');
    // One format for every workspace (and everyone), as the Map tab's note says of the overlays.
    if (note) note.textContent = activeAto ? 'shared by every workspace' : '(set a workspace first)';
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
    saveFormat(copy);
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
            saveFormat({ preset: p, lines: [...FORMAT_PRESETS[p].map(l => ({ ...l })), ...customs] });
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
        { id: 'backup', group: 'Reports', short: 'Backup (.txt)', label: 'Backup (.txt)', btn: 'exportPanelBackupBtn', needs: 'backup',
          desc: 'Every report with its updates, BDA, report format and the overlays. Opens in Notepad; Import it on any workbench.' },
        { id: 'csv', group: 'Reports', short: 'For Excel (.csv)', label: 'Reports for Excel (.csv)', btn: 'exportPanelCsvBtn', needs: 'csv',
          desc: 'One row per report, and one per saved update (or, with Latest version only, just the report), with the time filter below.' },
        { id: 'arcgis-shp', group: 'ArcGIS points', short: 'Shapefile (.zip)', label: 'ArcGIS points (Shapefile .zip)', run: () => exportForArcgis('shp'),
          desc: 'One point per grid of each report as it is now (its updates are not extra points), for heat maps. Unzip it, then drag the .shp into ArcGIS Pro or browse to it from a folder connection. ArcGIS Online takes the zip as it is. Text longer than 254 characters is cut.' },
        { id: 'arcgis-esri', group: 'ArcGIS points', short: 'Esri JSON (.json)', label: 'ArcGIS points (.json, Esri JSON)', btn: 'exportArcgisEsriBtn',
          desc: 'The same points with every character of text. ArcGIS Pro does not drag these in: run JSON To Features on the file.' },
        { id: 'arcgis-geojson', group: 'ArcGIS points', short: 'GeoJSON (.geojson)', label: 'ArcGIS points (.geojson)', btn: 'exportArcgisGeojsonBtn',
          desc: 'The same points as GeoJSON, for other GIS, or JSON To Features in ArcGIS Pro. Text longer than 254 characters is cut.' },
        { id: 'arcgis-csv', group: 'ArcGIS points', short: 'Table (.csv)', label: 'ArcGIS points (.csv)', btn: 'exportArcgisCsvBtn',
          desc: 'The same points as a table: XY Table To Point, with lon as X and lat as Y (WGS 1984).' },
        { id: 'tracks-shp', group: 'ArcGIS tracks', short: 'Shapefile (.zip)', label: 'ArcGIS tracks (Shapefile .zip)', run: () => exportForArcgis('tracks-shp'),
          desc: 'One line per report that moved, from its first grid through its updates to the latest, for an arrow at the end (Symbology: a line with an end arrow). Unzip it, then drag the .shp into ArcGIS Pro.' },
        { id: 'tracks-esri', group: 'ArcGIS tracks', short: 'Esri JSON (.json)', label: 'ArcGIS tracks (.json, Esri JSON)', run: () => exportForArcgis('tracks-esri'),
          desc: 'The same tracks as Esri JSON, for JSON To Features.' },
        { id: 'tracks-geojson', group: 'ArcGIS tracks', short: 'GeoJSON (.geojson)', label: 'ArcGIS tracks (.geojson)', run: () => exportForArcgis('tracks-geojson'),
          desc: 'The same tracks as GeoJSON lines, drawn first to latest.' },
    ],
};
const ioFormat = () => IO_FORMATS.export.find(f => f.id === el.ioPicker.select.value) || IO_FORMATS.export[0];
const renderIoPicker = () => {
    const p = el.ioPicker;
    if (!p.select) return;
    const remembered = readRaw('salt_io_export');
    p.select.innerHTML = IO_FORMATS.export.map(f => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join('');
    if (IO_FORMATS.export.some(f => f.id === remembered)) p.select.value = remembered;
    const f = ioFormat();
    p.desc.textContent = f.desc;
    renderIoMenu(f);
    // Each option shows with the format it changes.
    document.querySelectorAll('#exportPanel [data-io-for]').forEach(n => { n.hidden = n.dataset.ioFor !== f.needs; });
    document.querySelectorAll('#exportPanel .io-options').forEach(n => { n.hidden = !f.needs; });
};
// The pop-up button and its menu: the formats under their group's heading,
// the picked one checked. Picking one sets the select, which does the rest.
const IO_CHECK = '<svg class="io-check" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const renderIoMenu = (f) => {
    const menu = document.getElementById('ioFormatMenu'), label = document.getElementById('ioFormatLabel');
    if (!menu || !label) return;
    label.textContent = f.label;
    const groups = [...new Set(IO_FORMATS.export.map(x => x.group))];
    menu.innerHTML = groups.map(g => `<div class="io-menu-group" role="group" aria-label="${escapeHtml(g)}"><div class="io-menu-head" aria-hidden="true">${escapeHtml(g)}</div>`
        + IO_FORMATS.export.filter(x => x.group === g).map(x => `<div class="io-menu-item" role="option" id="ioOpt-${x.id}" data-io-pick="${x.id}" tabindex="-1" aria-selected="${x.id === f.id}">`
            + `${IO_CHECK}<span>${escapeHtml(x.short)}</span></div>`).join('') + '</div>').join('<div class="io-menu-sep" role="separator"></div>');
};
const ioMenuItems = () => [...document.querySelectorAll('#ioFormatMenu [data-io-pick]')];
const openIoMenu = (focusLast = false) => {
    const menu = document.getElementById('ioFormatMenu'), btn = document.getElementById('ioFormatBtn');
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const items = ioMenuItems();
    const at = items.find(i => i.getAttribute('aria-selected') === 'true') || items[focusLast ? items.length - 1 : 0];
    if (at) at.focus();
};
const closeIoMenu = (refocus = true) => {
    const menu = document.getElementById('ioFormatMenu'), btn = document.getElementById('ioFormatBtn');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
};
const pickIoFormat = (id) => {
    el.ioPicker.select.value = id;
    el.ioPicker.select.dispatchEvent(new Event('change'));
    closeIoMenu();
};
(() => {
    const btn = document.getElementById('ioFormatBtn'), menu = document.getElementById('ioFormatMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', () => (menu.hidden ? openIoMenu() : closeIoMenu()));
    btn.addEventListener('keydown', e => {
        if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openIoMenu(e.key === 'ArrowUp'); }
    });
    menu.addEventListener('click', e => { const item = e.target.closest('[data-io-pick]'); if (item) pickIoFormat(item.dataset.ioPick); });
    menu.addEventListener('keydown', e => {
        const items = ioMenuItems(), i = items.indexOf(document.activeElement);
        const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(items.length - 1);
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (items[i]) pickIoFormat(items[i].dataset.ioPick); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeIoMenu(); }
        else if (e.key === 'Tab') closeIoMenu(false);
        else if (e.key.length === 1) {
            // A letter goes to the next format starting with it.
            const k = e.key.toLowerCase(), next = [...items.slice(i + 1), ...items.slice(0, i + 1)].find(x => x.textContent.trim().toLowerCase().startsWith(k));
            if (next) next.focus();
        }
    });
    document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('.io-popup')) closeIoMenu(false); });
})();
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
    if (shapes.length === files.length) { switchManageTab('overlays'); startOverlayImport(shapes); return; }
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

const openManageView = () => {
    // Manage opens straight after: the Report Log isn't drawn in between.
    closeStatsView(true);
    closeSummaryView(true);
    hideHomeViews();
    isManageViewActive = true;
    el.manage.panel.style.display = 'flex';
    setViewIcon('exportViewToggleBtn', true);
    setTopBar('export', 'Manage');
    animateIn(el.manage.panel);
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'export');
    renderIoPicker();
    // Restore last-used tab; default 'export' for fresh sessions.
    switchManageTab(readRaw('salt_workspaces_tab', 'export'));
    renderExportPreview();
    renderWorkspacesList();
};

const closeManageView = () => {
    isManageViewActive = false;
    hideIdentityAccessCode();
    el.manage.panel.style.display = 'none';
    setViewIcon('exportViewToggleBtn', false);
    showHomeView();
};

// A backup's narrative settings: taken when this browser has none; when it
// has its own, and they differ, you choose.
const narrativeIsEmpty = (n) => !String(n.enemy || '').trim() && ['units', 'equipment', 'off', 'custom'].every(k => !(n[k] || []).length);
const importNarrative = async (n) => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || narrativeIsEmpty(n)) return;
    if (JSON.stringify(n) === JSON.stringify(sharedNarrative)) return;
    if (!narrativeIsEmpty(sharedNarrative)) {
        const count = (k) => (n[k] || []).length;
        const pick = await askChoice("Use this file's narrative settings?",
            `It has ${plural(count('units'), 'unit')}, ${plural(count('equipment'), 'equipment entry')} and ${plural(count('custom'), 'rule')} of its own; yours would be replaced for everyone.`,
            [{ label: "Use the file's", value: 'file', primary: true }, { label: 'Keep mine', value: 'keep' }]);
        if (pick !== 'file') return;
    }
    await saveNarrative(n, 'Narrative settings taken from the file.');
};

// A backup's reports merged into a workspace's the way the server merges a
// push (_merge_reports): matched by id (or displayId for rows from before
// ids), the higher lastModified wins whole, its history and deleted flag
// with it, and a tie goes to the file. Rows with neither key are dropped.
const mergeReports = (existing, incoming) => {
    const byKey = new Map();
    (existing || []).forEach(r => { const k = SaltCore.reportKey(r); if (k) byKey.set(k, r); });
    (incoming || []).forEach(r => {
        const k = SaltCore.reportKey(r);
        if (!k) return;
        const have = byKey.get(k);
        if (!have || (r.lastModified || 0) >= (have.lastModified || 0)) byKey.set(k, r);
    });
    return [...byKey.values()];
};

// What a backup's tags do here: `same`, its tag id -> the id of the tag here
// with the same name (or id); `add`, the rest, as many as there is room for.
const importTagPlan = (tags) => {
    const same = new Map(), add = [];
    SaltCore.cleanTags(tags).forEach(t => {
        const here = sharedTags.find(x => x.id === t.id || x.name.toUpperCase() === t.name.toUpperCase());
        if (here) { if (here.id !== t.id) same.set(t.id, here.id); return; }
        if (sharedTags.length + add.length < 30) add.push(t);
    });
    return { same, add };
};

function processJsonImport(rawText) {
    // Validate up-front so the user sees a precise error before the confirm prompt.
    const parsed = SaltCore.parseBackup(rawText);
    if (parsed.error) { showToast(parsed.error, true); return; }
    const imp = parsed.data;

    // The prompt says everything the import changes besides the reports.
    const switchTo  = imp.config && imp.config.ato && imp.config.title ? imp.config : null;
    // Everyone's identity in it but this operator's own, which stays as set here.
    const ownInitials = (userProfile && userProfile.initials) || '';
    const profiles  = Object.values(imp.profiles || {}).filter(p => p && p.initials && String(p.initials).trim() !== ownInitials);
    const operators = profiles.map(p => String(p.initials).trim());
    // The file's own tags: a tag of a name already here is that one (its
    // graphics are moved to it); the others are added.
    const tagPlan = importTagPlan(imp.tags);
    const impOverlays = SaltCore.foldOverlays(imp.overlays).map(o => (tagPlan.same.has(o.type) ? { ...o, type: tagPlan.same.get(o.type) } : o));
    const takesFormat = !!(imp.formats && typeof imp.formats === 'object' && isStockFormat() && Object.values(imp.formats).some(isFormat));
    const effects = ['Merge the backup file into the log? A report in both keeps whichever version is newer.'];
    if (switchTo && (switchTo.ato !== activeAto || switchTo.title !== localConfig.title)) effects.push(`It switches you to ${switchTo.ato}; nobody else moves.`);
    if (operators.length) effects.push(`The tag colors of ${operators.slice(0, 5).join(', ')}${operators.length > 5 ? ` and ${operators.length - 5} more` : ''} are set from it for everyone.`);
    if (impOverlays.length) effects.push(impOverlays.length === 1 ? 'Its overlay replaces any with the same type and name.' : `Its ${impOverlays.length} overlays replace any with the same type and name.`);
    if (tagPlan.add.length) effects.push(tagPlan.add.length === 1 ? `Its tag ${tagPlan.add[0].name} is added for everyone.` : `Its ${tagPlan.add.length} tags are added for everyone.`);
    if (takesFormat) effects.push('Its report format replaces the stock one.');

    showConfirmation(effects.join(' '), async () => {
        try {
            let all = { ...reportsByAto };
            if (imp.workspaces && typeof imp.workspaces === 'object') {
                for (const [ato, reps] of Object.entries(imp.workspaces)) all[ato] = mergeReports(all[ato], reps);
            } else if (imp.reports && Array.isArray(imp.reports)) {
                if (activeAto) all[activeAto] = mergeReports(all[activeAto], imp.reports);
            }
            if (switchTo) {
                activeAto   = imp.config.ato;
                localConfig = { ato: imp.config.ato, title: imp.config.title };
                writeStored('salt_offline_config', JSON.stringify(localConfig));
                writeStored('salt_last_active_ato', activeAto);
                setAtoState(true);
            }
            // The file's report format is taken only while this one is still
            // the stock one: an operator's own format changes only in the Builder.
            if (takesFormat && isStockFormat()) {
                const own = Object.values(imp.formats).filter(isFormat);
                const fFmt = (imp.config && isFormat(imp.formats[imp.config.ato]) && imp.formats[imp.config.ato]) || own[0];
                if (fFmt) saveFormat(fFmt);
            }
            // And the overlays (NAI / OBJ / PL): the file's replace any of the
            // same type and name; the rest are kept.
            // Their tags first, so the graphics have them when they come.
            if (tagPlan.add.length) await saveTags([...sharedTags, ...tagPlan.add]);
            if (impOverlays.length) await saveOverlays(mergeOverlays(sharedOverlays, impOverlays));
            await importNarrative(imp.narrative);
            await saveLocalAndSync(all, 'backup');
            // That pushed the active workspace only. Push the rest of the
            // file too: the sync below replaces local state with the server's,
            // so anything not pushed would be lost.
            let unsent = 0;
            for (const ato of isLocalFile ? [] : Object.keys(imp.workspaces || {})) {
                if (ato === activeAto || !(all[ato] || []).length) continue;
                const queued = await pushWorkspace(ato, all[ato], 'backup') === 'queued';
                markPending(ato, queued);
                if (queued) unsent++;
            }
            closeManageView();
            loadConfig();
            // The rest goes to the server as it is; what it refuses is said.
            const refusals = [];
            const send = async (path, body) => {
                if (isLocalFile) return;
                const r = await apiPost(path, body);
                if (!r.ok && r.status !== 0 && r.status !== 401) refusals.push(r.message);
            };
            if (profiles.length) {
                for (const p of profiles) await send('/api/save_profile', { profile: p });
                // The server takes the last profile sent as this connection's
                // operator, for attribution: make that this operator again.
                if (ownInitials) await send('/api/save_profile', { profile: userProfile });
            }
            if (switchTo) await send('/api/save_config', { config: switchTo });
            if (unsent) {
                // Don't sync: it would drop the workspaces the server never got.
                // They're kept here and sent before the next pull.
                showToast(`${unsent} workspace(s) saved here; they're sent once the server can be reached.`, true);
                return;
            }
            if (refusals.length) showToast(`Imported, but not all of it was saved: ${refusals[0]}`, true);
            else showToast('Import successful. Syncing...');
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
    isManageViewActive = false;
    setViewIcon('exportViewToggleBtn', false);
    hideHomeViews();
    el.manage.panel.style.display  = 'none';
    el.csv.panel.style.display  = 'flex';
    setTopBar('csv', 'Import CSV');
    animateIn(el.csv.panel);
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
    // Focus goes in (on Cancel, the safe button) and back where it was after.
    // Not held inside: the panel is a view, and the view switcher stays usable.
    dialogOpeners.delete(el.csv.panel);   // left another way last time
    enterDialog(el.csv.panel, el.csv.cancelBtn);
};

const closeCsvImportView = () => {
    el.csv.panel.style.display = 'none';
    showHomeView();
    pendingCsv = null;
    leaveDialog(el.csv.panel);
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
            if (!isManageViewActive) openManageView();
            switchManageTab('identity');
            return;
        }
        importer = { initials: ini, color: col };
    }

    const dest     = el.csv.destSelect.value || 'IMPORT';
    const existing = reportsByAto[dest] || [];
    const firstNum = SaltCore.nextNum(existing, { withDeleted: true });
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
        const did  = SaltCore.displayId(prefix, firstNum + newReps.length);
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
    // could overwrite the freshly-imported data. The import moves only this
    // editor: a sync leaves each editor in their own workspace.
    await pushToServer('csv');
    } catch (err) {
        showToast('Import error: ' + (err && err.message ? err.message : String(err)), true);
        console.error('CSV import failed:', err);
    }
};

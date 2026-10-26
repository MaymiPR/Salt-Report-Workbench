// SPDX-License-Identifier: AGPL-3.0-only

// Push, pull, SSE, offline queue, applying server state.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 9. Sync (push, pull, SSE, offline flag) ---
function setConnectionStatus(isOnline) {
    const cls   = 'status-dot ' + (isOnline ? 'online' : 'offline');
    const title = isOnline ? (offlinePendingPush ? 'Syncing...' : 'Online & Synced') : 'Offline (Saving Locally)';
    el.status.dot.className    = cls;
    el.status.dot.title        = title;
    el.status.dotExp.className = cls;
    el.status.dotExp.title     = title;
}

// Wrong, missing, or rotated access code: forget it and re-prompt. The viewer
// port never answers 401, but stay defensive.
const handleUnauthorized = () => {
    clearAccessCode();
    setConnectionStatus(false);
    if (!isReadOnly && !document.body.classList.contains('read-only')) openStartupModal();
};

// Record the outcome of a push for each report in `batch`.
const markSaved = (ato, batch) => {
    const versions = serverVersions[ato] = serverVersions[ato] || {};
    let cleared = false;
    batch.forEach(r => {
        const k = SaltCore.reportKey(r);
        versions[k] = r.lastModified || 0;
        if (unsaved[ato] && unsaved[ato][k]) { delete unsaved[ato][k]; cleared = true; }
    });
    if (cleared) saveUnsaved();
};
const markRefused = (ato, report, reason) => {
    (unsaved[ato] = unsaved[ato] || {})[SaltCore.reportKey(report)] = { report: JSON.parse(JSON.stringify(report)), reason };
    saveUnsaved();
};

// POST a batch of reports. When the server refuses it, split the batch to
// find exactly which reports it refuses, so one bad report can't hold back
// the rest. Returns { queued, refused: [reasons] }.
async function sendBatch(ato, batch, source) {
    let res;
    try {
        res = await postJson('/api/save_reports', source ? { ato, reports: batch, source } : { ato, reports: batch });
    } catch (err) {
        return { queued: true, refused: [] };
    }
    if (res.ok) { markSaved(ato, batch); return { queued: false, refused: [] }; }
    if (res.status === 401) { handleUnauthorized(); return { queued: true, refused: [] }; }
    if (res.status === 429 || res.status >= 500) return { queued: true, refused: [] };
    if (batch.length === 1) {
        const message = await res.json().then(j => j.message).catch(() => '') || `HTTP ${res.status}`;
        // The batch index ("reports[0].size ...") means nothing to an operator.
        const reason = message.replace(/^Validation failed: reports\[\d+\]\./, 'Validation failed: ').replace(/\.?$/, '.');
        markRefused(ato, batch[0], reason);
        return { queued: false, refused: [reason] };
    }
    const mid = Math.ceil(batch.length / 2);
    const a = await sendBatch(ato, batch.slice(0, mid), source);
    const b = await sendBatch(ato, batch.slice(mid), source);
    return { queued: a.queued || b.queued, refused: [...a.refused, ...b.refused] };
}

// Push one workspace: the reports the server doesn't have in their current
// version (an empty workspace is unloaded instead). A refused version is not
// re-sent until someone changes it. Returns 'ok', 'queued' when the push
// should be retried (server unreachable, code rejected, rate limited, server
// error), or 'rejected' when the server refused some reports; those are kept
// as "Not saved" and the user is told why.
async function pushWorkspace(ato, reports, source) {
    if (!reports.length) {
        try {
            const res = await postJson('/api/unload_ato', { ato });
            if (res.status === 401) { handleUnauthorized(); return 'queued'; }
            return res.status === 429 || res.status >= 500 ? 'queued' : 'ok';
        } catch (err) {
            return 'queued';
        }
    }
    const batch = SaltCore.changedReports(reports, serverVersions[ato]).filter(r => {
        const u = unsavedEntry(ato, r);
        return !u || u.report.lastModified !== r.lastModified;
    });
    if (!batch.length) return 'ok';
    const { queued, refused } = await sendBatch(ato, batch, source);
    if (refused.length) {
        showToast(`The server did not save ${refused.length === 1 ? 'a report' : refused.length + ' reports'} in ${ato}: ${refused[0]} Kept as "Not saved" until you fix or discard it.`, true);
        if (ato === activeAto) renderLog();
    }
    return queued ? 'queued' : refused.length ? 'rejected' : 'ok';
}

// Push the active workspace. `source` is an optional hint ('backup' | 'csv')
// for server-side logging. Resolves false when the change is still queued.
// Pulls wait for pushes. A pull that landed while a push was in flight
// replaced the table with the server's copy from before the push, so a
// just-logged report blinked out until the push's own broadcast brought it
// back. The deferred pull runs when the last push settles.
let pushesInFlight = 0;
let pullDeferred   = false;
async function pushToServer(source) {
    if (!activeAto) return true;
    pushesInFlight++;
    try {
        const result = await pushWorkspace(activeAto, localReports || [], source);
        offlinePendingPush = result === 'queued';
        writeStored('salt_offline_push', String(offlinePendingPush));
        setConnectionStatus(!offlinePendingPush);
        return !offlinePendingPush;
    } finally {
        if (--pushesInFlight === 0 && pullDeferred) { pullDeferred = false; syncWithServer(); }
    }
}

async function syncWithServer() {
    if (pushesInFlight > 0) { pullDeferred = true; return; }
    try {
        // Never pull over local changes the server hasn't accepted yet: the
        // pull replaces local state, so they would be lost.
        if (offlinePendingPush && activeAto && !(await pushToServer())) return;
        const res = await fetch('/api/sync');
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) throw new Error('Server unreachable');
        const state = await res.json();
        applyServerUpdate(state.workspaces, state.config, state.profiles, state.connected_users, state.sources, state.connected_initials, state.read_only, state.formats, state.overlays, state.basemaps);
        setConnectionStatus(true);
    } catch (err) {
        setConnectionStatus(false);
    }
}

function applyServerUpdate(workspaces, config, profiles, connectedUsers, sources, connInitials, readOnly, formats, overlays, basemaps) {
    // Per-workspace report formats — server keys win, locally-known formats
    // for workspaces the server hasn't seen survive.
    if (formats && typeof formats === 'object') {
        workspaceFormats = { ...workspaceFormats, ...formats };
        writeStored('salt_ws_formats', JSON.stringify(workspaceFormats));
    }
    // The shared overlays: the server's set wins. An unchanged set keeps its
    // identity, so the location cache survives.
    if (Array.isArray(overlays) && JSON.stringify(overlays) !== JSON.stringify(sharedOverlays)) {
        sharedOverlays = overlays;
        if (!readOnly) storeOverlays();
        renderLocationHints();
    }
    if (Array.isArray(basemaps) && JSON.stringify(basemaps) !== JSON.stringify(sharedBasemaps)) {
        sharedBasemaps = basemaps;
        if (!readOnly) storeBasemaps();
    }
    if (connectedUsers != null) {
        el.status.userCount.textContent    = connectedUsers;
        el.status.userCountExp.textContent = connectedUsers;
    }
    localProfiles     = profiles      || {};
    // Cache profiles so the startup modal can offer them even before the
    // first sync of a future session (or offline).
    if (profiles && Object.keys(profiles).length) {
        writeStored(_PROFILES_CACHE_KEY, JSON.stringify(profiles));
    }
    workspaceSources  = sources       || {};
    connectedInitials = Array.isArray(connInitials) ? connInitials : [];
    // Viewer mode flag — CSS hides mutation UI; JS guards also check it.
    isReadOnly = !!readOnly;
    document.body.classList.toggle('read-only', isReadOnly);
    reportsByAto = workspaces || {};
    serverVersions = {};
    Object.entries(reportsByAto).forEach(([ato, reps]) => { serverVersions[ato] = SaltCore.knownVersions(reps); });
    // Refused changes stay on top of the server's copy until fixed or
    // discarded, unless someone has since saved a newer version.
    let droppedUnsaved = false;
    Object.entries(unsaved).forEach(([ato, entries]) => {
        const list = Object.values(entries).map(e => e.report);
        if (!list.length) return;
        const { reports, superseded } = SaltCore.withUnsaved(reportsByAto[ato], list);
        reportsByAto[ato] = reports;
        superseded.forEach(k => { delete entries[k]; droppedUnsaved = true; });
    });
    if (droppedUnsaved) saveUnsaved();
    saveReportsByAtoToLocal();

    // ATO/Title sync. Editors: server config is authoritative.
    // Viewers: `activeAto` mirrors the editor's choice (server config);
    // `viewerShowingAto` is the viewer's local override. Reports come from showing.
    if (isReadOnly) {
        const prevActive = activeAto;
        // Track the editor's active workspace from server config.
        activeAto = (config && config.ato && reportsByAto[config.ato]) ? config.ato : null;
        // If the viewer was following the editor (showing == old active),
        // auto-follow when the editor switches. If they'd clicked somewhere
        // independent, leave their selection alone.
        const wasFollowing = !viewerShowingAto || viewerShowingAto === prevActive;
        const showingValid = viewerShowingAto && reportsByAto[viewerShowingAto];
        if (wasFollowing || !showingValid) {
            viewerShowingAto = activeAto
                || Object.keys(reportsByAto).find(k => (reportsByAto[k] || []).some(r => !r.deleted))
                || null;
        }
        localReports = viewerShowingAto ? (reportsByAto[viewerShowingAto] || []) : [];
    } else if (config && config.ato && config.title) {
        activeAto = config.ato;
        localConfig = { ato: config.ato, title: config.title };
        writeStored('salt_offline_config', JSON.stringify(localConfig));
        writeStored('salt_last_active_ato', activeAto);
        localReports = reportsByAto[activeAto] || [];
    } else {
        // Server config empty (e.g., another client just unloaded the active ATO).
        activeAto = null;
        localReports = [];
        localConfig = { ato: '', title: '' };
        writeStored('salt_offline_config', JSON.stringify(localConfig));
        localStorage.removeItem('salt_last_active_ato');
    }

    loadConfig();
    renderLog(el.log.search.value.toLowerCase());
    populateAtoHistory();
    // Render the workspaces list AFTER activeAto/viewerShowingAto are settled
    // so an editor's live workspace switch updates the ACTIVE / SHOWING tags
    // in real time on every viewer's sidebar.
    renderWorkspacesList();
    // If the startup modal is open, refresh its chips with the fresh
    // profiles + workspaces that just synced in.
    if (el.startup.overlay.classList.contains('show')) renderStartupPresets();
    // If the Builder tab is on screen, reflect format changes from peers.
    const builderPanel = document.querySelector('[data-tab-panel="builder"]');
    if (builderPanel && builderPanel.style.display !== 'none') renderBuilder();
    // Same for the Overlays tab (a review in progress is kept).
    const overlaysPanel = document.querySelector('[data-tab-panel="overlays"]');
    if (overlaysPanel && overlaysPanel.style.display !== 'none') renderOverlays();
    // And the Statistics and Summary Reports panels, so they follow the log.
    renderStats();
    renderSummary();
}

// Viewer-only: switch which workspace the viewer is LOOKING AT, locally.
// Does NOT touch `activeAto` (which mirrors the editor's choice on the server)
// — only changes `viewerShowingAto` so the "SHOWING" tag and the report log
// follow the viewer's selection while "ACTIVE" stays on the editor's pick.
function switchWorkspaceLocal(ato) {
    if (!isReadOnly) return;
    if (!ato || !reportsByAto[ato]) return;
    viewerShowingAto = ato;
    localReports     = reportsByAto[ato] || [];
    renderLog(el.log.search.value.toLowerCase());
    renderWorkspacesList();
}

// Returns the push promise; callers `await` when they need server confirmation
// before continuing (form submit, CSV import).
function saveLocalAndSync(newReportsByAto, source) {
    reportsByAto = newReportsByAto;
    if (activeAto) localReports = reportsByAto[activeAto] || [];
    saveReportsByAtoToLocal();
    renderLog();
    return pushToServer(source);
}

// SSE with explicit reconnection backoff (1s → 30s capped, reset on success).
// EventSource's built-in retry is unreliable on hard server-side drops.
function initSSE() {
    let backoff = 1000;
    const MAX_BACKOFF = 30000;
    const connect = () => {
        const evtSource = new EventSource('/api/events');
        evtSource.onmessage = () => { backoff = 1000; syncWithServer(); };
        evtSource.onopen    = () => { backoff = 1000; setConnectionStatus(true); };
        // The server announces a Ctrl+C before it closes, so the dot turns
        // red now instead of at the next failed heartbeat.
        evtSource.addEventListener('shutdown', () => { setConnectionStatus(false); showToast('The server is stopping.', true); });
        evtSource.onerror   = () => {
            setConnectionStatus(false);
            try { evtSource.close(); } catch (e) {}
            setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF);
        };
    };
    connect();
}

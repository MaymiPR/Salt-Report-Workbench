// SPDX-License-Identifier: AGPL-3.0-only

// Push, pull, SSE, offline queue, applying server state.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 9. Sync (push, pull, SSE, offline flag) ---
function setConnectionStatus(isOnline) {
    const cls   = 'status-dot ' + (isOnline ? 'online' : 'offline');
    const title = isOnline ? (offlinePendingPush || pendingAtos.size ? 'Syncing...' : 'Online & Synced') : 'Offline (Saving Locally)';
    el.status.dot.className    = cls;
    el.status.dot.title        = title;
    el.status.dot.setAttribute('aria-label', title);
    el.status.dotExp.className = cls;
    el.status.dotExp.title     = title;
    renderStatusBars();
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
    const res = await apiPost('/api/save_reports', source ? { ato, reports: batch, source } : { ato, reports: batch });
    if (res.ok) { markSaved(ato, batch); return { queued: false, refused: [] }; }
    // Unreachable, code rejected (apiPost re-prompts), rate limited, or a
    // server error: sent again later.
    if (res.status === 0 || res.status === 401 || res.status === 429 || res.status >= 500) return { queued: true, refused: [] };
    if (batch.length === 1) {
        // The batch index ("reports[0].size ...") means nothing to an operator.
        const reason = res.message.replace(/^Validation failed: reports\[\d+\]\./, 'Validation failed: ');
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
        const res = await apiPost('/api/unload_ato', { ato });
        if (res.ok) return 'ok';
        if (res.status === 0 || res.status === 401 || res.status === 429 || res.status >= 500) return 'queued';
        showToast(`Not unloaded: ${res.message}`, true);
        return 'rejected';
    }
    const batch = SaltCore.changedReports(reports, serverVersions[ato]).filter(r => {
        const u = unsavedEntry(ato, r);
        return !u || u.report.lastModified !== r.lastModified;
    });
    if (!batch.length) return 'ok';
    const { queued, refused } = await sendBatch(ato, batch, source);
    if (refused.length) {
        showToast(`Not saved: ${refused[0]} ${refused.length === 1 ? 'That report' : `Those ${refused.length} reports`} in ${ato} ${refused.length === 1 ? 'stays' : 'stay'} marked "Not saved" until you fix or discard ${refused.length === 1 ? 'it' : 'them'}.`, true);
        if (ato === activeAto) renderLog();
    }
    return queued ? 'queued' : refused.length ? 'rejected' : 'ok';
}

// Push the active workspace. `source` is an optional hint ('backup' | 'csv')
// for server-side logging. Resolves false when the change is still queued.
// Pulls wait for pushes (reports, and the shared lists: saveShared). A pull
// that landed while a push was in flight replaced the table with the
// server's copy from before the push, so a just-logged report blinked out
// until the push's own broadcast brought it back; a shared list went back to
// what it was, and a change made from it then lost the one being saved. The
// deferred pull runs when the last push settles.
let pushesInFlight = 0;
let pullDeferred   = false;
// The end of a push: the pull it held back, if any, now.
const pushSettled = () => { if (--pushesInFlight === 0 && pullDeferred) { pullDeferred = false; syncWithServer(); } };
async function pushToServer(source) {
    if (!activeAto) return true;
    pushesInFlight++;
    try {
        const ato = activeAto;
        const result = await pushWorkspace(ato, localReports || [], source);
        offlinePendingPush = result === 'queued';
        writeStored('salt_offline_push', String(offlinePendingPush));
        markPending(ato, offlinePendingPush);
        setConnectionStatus(!offlinePendingPush);
        return !offlinePendingPush;
    } finally {
        pushSettled();
    }
}

// Send again every workspace the server hasn't taken. False while any is
// still waiting.
async function pushPending() {
    for (const ato of [...pendingAtos]) {
        const reps = ato === activeAto ? localReports : reportsByAto[ato];
        // Unloaded since (an empty list would unload it on the server): nothing to send.
        if (!reps || !reps.length) { markPending(ato, false); continue; }
        if (await pushWorkspace(ato, reps) === 'queued') return false;
        markPending(ato, false);
    }
    return true;
}

// Pulls can overlap, and their answers arrive in any order: one asked for
// before another that has already been applied is older, and is dropped.
let pullsAsked = 0, pullApplied = 0;
// `again`: this pull follows one whose answer was older than a change this
// page knew of. An answer older still is taken all the same (the server was
// restarted with its clock set back, say), rather than asking for ever.
async function syncWithServer(again = false) {
    if (pushesInFlight > 0) { pullDeferred = true; return; }
    try {
        // Never pull over local changes the server hasn't accepted yet: the
        // pull replaces local state, so they would be lost.
        if (offlinePendingPush && activeAto && !(await pushToServer())) return;
        if (!(await pushPending())) { setConnectionStatus(false); return; }
        const pull = ++pullsAsked;
        const res = await fetch('/api/sync');
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) throw new Error('Server unreachable');
        const state = await res.json();
        if (pull < pullApplied) return;
        // Asked for before a push that is still on its way: from before it.
        if (pushesInFlight > 0) { pullDeferred = true; return; }
        const v = typeof state.version === 'number' ? state.version : null;
        // Older than a change this page has made or been told of (asked for
        // before it, answered after): it would undo that change on screen.
        if (v !== null && v < seenVersion && !again) { setConnectionStatus(true); syncWithServer(true); return; }
        pullApplied = pull;
        if (v !== null) { syncedVersion = v; seenVersion = Math.max(v, again ? v : seenVersion); }
        applyServerUpdate(state);
        setConnectionStatus(true);
    } catch (err) {
        setConnectionStatus(false);
    }
}

// `state` is the server's /api/sync answer.
function applyServerUpdate(state) {
    const { workspaces, config, profiles, sources, format, overlays, basemaps, narrative, drones, tags } = state;
    const readOnly = state.read_only, connectedUsers = state.connected_users;
    // The report format: the server's wins. A server that has none yet (a new
    // one, or one upgraded from per-workspace formats) is given this browser's.
    if (format && typeof format === 'object') {
        if (isFormat(format)) {
            if (JSON.stringify(format) !== JSON.stringify(sharedFormat)) adoptFormat(format);
        } else if (sharedFormat && !readOnly && !isStockFormat()) {
            apiPost('/api/save_format', { format: sharedFormat });
        }
    }
    // The shared overlays: the server's set wins, less any that are broken.
    // An unchanged set keeps its identity, so the location cache survives.
    const foldedOverlays = Array.isArray(overlays) ? SaltCore.foldOverlays(overlays) : null;
    if (foldedOverlays && JSON.stringify(foldedOverlays) !== JSON.stringify(sharedOverlays)) {
        sharedOverlays = foldedOverlays;
        if (!readOnly) storeOverlays();
        renderLocationHints();
    }
    // The team's tags: the server's. A server from before them sends none,
    // and they stay as they are.
    const keptTags = Array.isArray(tags) ? SaltCore.cleanTags(tags) : null;
    if (keptTags && JSON.stringify(keptTags) !== JSON.stringify(sharedTags)) {
        sharedTags = keptTags;
        if (!readOnly) storeTags();
        renderLocationHints();
    }
    if (Array.isArray(basemaps) && JSON.stringify(basemaps) !== JSON.stringify(sharedBasemaps)) {
        sharedBasemaps = basemaps;
        if (!readOnly) storeBasemaps();
        renderBasemapManager();
    }
    if (Array.isArray(drones) && JSON.stringify(drones) !== JSON.stringify(sharedDrones)) {
        sharedDrones = drones;
        if (!readOnly) storeDrones();
    }
    // The narrative's settings: the server's win. A server that has none yet
    // is given this browser's, like the format.
    if (narrative && typeof narrative === 'object' && !Array.isArray(narrative)) {
        if (!Object.keys(narrative).length && Object.keys(sharedNarrative).length && !readOnly) {
            apiPost('/api/save_narrative', { narrative: sharedNarrative });
        } else if (JSON.stringify(narrative) !== JSON.stringify(sharedNarrative)) {
            sharedNarrative = narrative;
            if (!readOnly) storeNarrative();
        }
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
    connectedWhere    = state.connected_where && typeof state.connected_where === 'object' ? state.connected_where : {};
    renderWhoIsWhere();
    // A server from before the Activity list sends none: it stays empty.
    peerActivity      = Array.isArray(state.activity) ? state.activity : [];
    // A page from another release than the server's: it may send what the
    // server no longer takes, or miss what it now sends.
    serverRelease = typeof state.server_version === 'string' ? state.server_version : null;
    renderStatusBars();
    // Viewer mode flag — CSS hides mutation UI; JS guards also check it.
    isReadOnly = !!readOnly;
    document.body.classList.toggle('read-only', isReadOnly);
    // This editor's workspace, unloaded by someone: it's left. One the
    // server didn't have at the last pull wasn't (it has no reports yet, or
    // was switched to while it was listed).
    const unloadedMine = !readOnly && activeAto && reportsByAto[activeAto] && !(workspaces || {})[activeAto]
        && Array.isArray(state.unloaded) && state.unloaded.includes(activeAto);
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

    // ATO/Title sync. Editors: each keeps their own; the server's is only what
    // the startup modal offers. Viewers: `activeAto` mirrors the workspace
    // viewers are shown (server config); `viewerShowingAto` is the viewer's
    // local override. Reports come from showing.
    serverConfig = config && config.ato && config.title ? { ato: config.ato, title: config.title } : { ato: '', title: '' };
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
    } else if (unloadedMine) {
        const gone = activeAto;
        leaveWorkspace();
        showToast(`Workspace "${gone}" was unloaded by another operator. Set a workspace to keep logging.`, true);
    } else {
        localReports = activeAto ? (reportsByAto[activeAto] || []) : [];
    }

    loadConfig({ fromSync: true });
    renderLog(el.log.search.value.toLowerCase());
    // The dropdown of other workspaces stays unlocked while Change is open.
    const historyOpen = !el.config.history.disabled && !el.config.ato.readOnly;
    populateAtoHistory();
    if (historyOpen && el.config.history.options.length > 1) el.config.history.disabled = false;
    // Render the workspaces list AFTER activeAto/viewerShowingAto are settled
    // so an editor's live workspace switch updates the ACTIVE / SHOWING tags
    // in real time on every viewer's sidebar.
    renderWorkspacesList();
    renderActivity();
    // The report in the form, if someone else has just saved it.
    renderPeerChange();
    // If the startup modal is open, refresh its chips with the fresh
    // profiles + workspaces that just synced in, and the workspace fields
    // not yet typed in with the server's: they opened with this browser's.
    if (el.startup.overlay.classList.contains('show')) { renderStartupPresets(); refreshStartupWorkspace(); }
    // If the Builder tab is on screen, reflect format changes from peers.
    const builderPanel = document.querySelector('[data-tab-panel="builder"]');
    if (builderPanel && builderPanel.style.display !== 'none') renderBuilder();
    // Same for the Map tab (a review in progress is kept).
    const overlaysPanel = document.querySelector('[data-tab-panel="overlays"]');
    if (overlaysPanel && overlaysPanel.style.display !== 'none') renderOverlays();
    // And the Statistics and Summary Reports panels, so they follow the log.
    renderStats();
    renderSummary();
    renderMapView();
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
    renderActivity();
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

// --- Bars for what needs attention: not saving, another release ---
// Unsent changes this long and the page says so, plainly.
const NOT_SAVING_MS = 30000;
let waitingSince = null;   // when changes first waited for the server, or null
let serverRelease = null;  // the server's release, from the last sync
const changesWaiting = () => !isReadOnly && !isLocalFile && (offlinePendingPush || pendingAtos.size > 0);
function renderStatusBars() {
    if (!changesWaiting()) waitingSince = null;
    else if (waitingSince === null) waitingSince = Date.now();
    const notSaving = waitingSince !== null && Date.now() - waitingSince > NOT_SAVING_MS;
    el.bars.notSaving.hidden = !notSaving;
    const other = !!serverRelease && serverRelease !== APP_VERSION;
    if (other) el.bars.versionText.textContent = `This page is version ${APP_VERSION} and the server is ${serverRelease}. Reload to update the page.`;
    el.bars.version.hidden = !other;
}
setInterval(renderStatusBars, 5000);
el.bars.reloadBtn.addEventListener('click', () => location.reload());

// SSE with explicit reconnection backoff (1s → 30s capped, reset on success).
// EventSource's built-in retry is unreliable on hard server-side drops.
function initSSE() {
    let backoff = 1000;
    const MAX_BACKOFF = 30000;
    const connect = () => {
        const evtSource = new EventSource('/api/events');
        // A notice says the newest change's number (an older server just
        // "update"): one this page already has needs no pull.
        evtSource.onmessage = (e) => {
            backoff = 1000;
            let v = null;
            try { v = JSON.parse(e.data).v; } catch (err) { /* an older server's "update" */ }
            if (typeof v === 'number') { noteChange(v); if (v <= syncedVersion) return; }
            syncWithServer();
        };
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

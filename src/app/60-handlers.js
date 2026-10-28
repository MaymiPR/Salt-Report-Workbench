// SPDX-License-Identifier: AGPL-3.0-only

// Event wiring for every control and keyboard shortcut.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 10. Event handlers ---

// Someone saved the report in the form after it was loaded. Resolves 'mine'
// (write over theirs), 'theirs' (theirs is loaded into the form instead), or
// null for Cancel.
const askEditConflict = async (theirs) => {
    const who = (theirs.user && theirs.user.initials) || 'Someone';
    const now = [theirs.size, theirs.activity, theirs.location].filter(Boolean).join(' · ');
    const pick = await askChoice(`${who} changed this report since you opened it`,
        `${formatFullId(theirs)} now reads ${now}.`,
        [{ label: 'Keep theirs', value: 'theirs', primary: true }, { label: 'Overwrite theirs', value: 'mine' }]);
    if (pick === 'theirs') loadReportForEditing(theirs.id);
    return pick;
};

// The form's values put back over a report loaded for editing.
const refillForm = (data) => {
    el.form.size.value     = data.size;
    el.form.activity.value = data.activity;
    el.form.location.value = data.location;
    el.form.analysis.value = data.yourAnalysis || '';
    el.form.time.value     = clockValue(new Date(data.time), timeDisplayMode === 'local');
    document.querySelectorAll('#salt-fields [data-custom-label]').forEach(i => { i.value = (data.custom || {})[i.dataset.customLabel] || ''; });
    renderLocationHints();
};

// Form submit. `mode`: 'new' (log new), 'edit' (overwrite, no history),
// 'update' (snapshot old values to history[]).
async function handleFormSubmit(mode) {
    try {
    if (isReadOnly) { showToast('View-only mode. Logging is disabled here.', true); return; }
    if (!userProfile) {
        showToast('Set your Report ID (Initials) before logging.', true);
        // Open the panel on the Identity tab so the form is visible.
        if (!isExportViewActive) openExportView();
        switchWorkspacesTab('identity');
        return;
    }
    if (!activeAto)   { showToast('An ATO must be set before logging reports.', true); return; }

    // Required-field check via toast (HTML5 :required tooltips were easy to miss).
    const missing = [];
    if (!el.form.size.value.trim())     missing.push('Size');
    if (!el.form.activity.value.trim()) missing.push('Activity');
    if (!el.form.location.value.trim()) missing.push('Location');
    if (missing.length) {
        showToast('Please fill in: ' + missing.join(', '), true);
        return;
    }
    // With MGRS Lock on, grids typed as digits get the locked zone and square.
    const locked = lockedLocation(el.form.location.value);
    if (locked !== el.form.location.value) el.form.location.value = locked;
    // Toasts from here on (settling the Location, a refused upload) say more
    // than "logged", which then stays out of their way.
    const toastsBefore = toastsShown;
    // Name the NAI / OBJ / PL the grid is in, and settle any that disagree.
    const settled = await settleLocation(el.form.location.value);
    if (settled === null) { el.form.location.focus(); return; }
    if (settled !== el.form.location.value) { el.form.location.value = settled; renderLocationHints(); }

    const idToUpdate = el.form.reportId.value;
    // Changed by someone else since it was loaded: ask before writing over it.
    if (idToUpdate && (mode === 'edit' || mode === 'update') && editingVersion && editingVersion.id === idToUpdate) {
        const cur = localReports.find(r => r.id === idToUpdate);
        if (cur && !cur.deleted && editedFields(cur) !== editingVersion.fields) {
            if (await askEditConflict(cur) !== 'mine') return;
            editingVersion = { id: cur.id, fields: editedFields(cur) };
        }
    }

    let reports = [...localReports];
    const timeValue  = el.form.time.value.trim();
    // An edited report whose time box was left alone keeps its timestamp;
    // a typed time gets today's date, or yesterday's when it is more than an
    // hour ahead.
    const editing   = idToUpdate ? reports.find(r => r.id === idToUpdate) : null;
    const finalTime = SaltCore.submittedTime(timeValue, timeDisplayMode === 'local', editing ? editing.time : null);
    if (!finalTime) { showToast('Invalid time. Use HH:MM (24-hour).', true); return; }

    // Past the version being replaced, whatever this browser's clock says.
    const now  = nextStamp(editing);
    const data = { size:el.form.size.value, activity:el.form.activity.value, location:normalizeLocation(el.form.location.value), time:finalTime, yourAnalysis:el.form.analysis.value, custom:collectCustomValues() };
    let finalReport;
    // Track whether this iteration is an Edit so we can route to the dedicated
    // server endpoint AFTER the local mutation succeeds.
    let editTargetId = null;

    if (idToUpdate && (mode === 'edit' || mode === 'update')) {
        const idx = reports.findIndex(r => r.id === idToUpdate);
        if (idx === -1 || reports[idx].deleted) {
            showToast('That report no longer exists. Another operator may have deleted it.', true);
            resetForm();
            return;
        }
        const orig = reports[idx];
        const tAto = SaltCore.atoPrefix(el.config.ato.value);
        const tNum = String(el.form.startNum.value).padStart(3,'0');
        const tDid = `${tAto}${tNum}`;
        if (tDid !== orig.displayId) {
            // Renumber/rename branch — applies to both Edit and Update. The
            // identity of the report changed, so prior history doesn't carry
            // forward in either case (matches pre-split behavior).
            const newTitle = el.config.title.value.trim() || 'Report #';
            finalReport = { ...orig, ...data, displayId:tDid, ato:tAto, title:newTitle, fullId:`${newTitle}${tDid}`, updated:false, lastModified:now, user:userProfile };
        } else if (mode === 'edit' || unsavedEntry(activeAto, orig)) {
            // EDIT: overwrite fields in place. No history snapshot. `updated`
            // and `history` are preserved exactly as-is, so the audit trail
            // is untouched — the user is simply correcting the current text.
            // Fixing a change the server refused works the same way even via
            // Update: the refused version never reached the server, so it
            // doesn't belong in history.
            finalReport = { ...orig, ...data, lastModified:now, user:userProfile };
            editTargetId = idToUpdate;
        } else {
            // UPDATE: snapshot the old values into history if anything changed.
            const changed = orig.size!==data.size||orig.activity!==data.activity||orig.location!==data.location||(orig.yourAnalysis||'')!==(data.yourAnalysis||'')||new Date(orig.time).getTime()!==new Date(finalTime).getTime()||JSON.stringify(orig.custom||{})!==JSON.stringify(data.custom||{});
            let hist = orig.history||[];
            if (changed) hist = [...hist, { size:orig.size||'', activity:orig.activity||'', location:orig.location||'', time:orig.time, yourAnalysis:orig.yourAnalysis||'', custom:orig.custom||{}, user:orig.user, lastModified:orig.lastModified }];
            finalReport = { ...orig, ...data, history:hist, updated:changed, lastModified:now, user:userProfile };
        }
        reports[idx] = finalReport;
    } else {
        // NEW REPORT path
        const atoPrefix   = SaltCore.atoPrefix(el.config.ato.value);
        const titlePrefix = el.config.title.value.trim() || 'Report #';
        const relevant    = reports.filter(r => !r.deleted && r.ato === atoPrefix);
        const lastNum     = relevant.reduce((m,r) => Math.max(m, reportNum(r)), 0);
        const reqNum      = parseInt(el.form.startNum.value, 10);
        const newNum      = !isNaN(reqNum)&&reqNum>0 ? reqNum : lastNum+1;
        const newDid      = `${atoPrefix}${String(newNum).padStart(3,'0')}`;
        if (reports.some(r => !r.deleted && r.displayId === newDid)) { showToast(`${newDid} already exists.`, true); return; }
        finalReport = { ...data, id:generateUUID(), displayId:newDid, ato:atoPrefix, title:titlePrefix, fullId:`${titlePrefix}${newDid}`, history:[], updated:false, lastModified:now, user:userProfile };
        reports.push(finalReport);
    }

    localReports = reports;
    reportsByAto[activeAto] = localReports;
    // Copy and clear now, while the click is fresh (clipboard access needs
    // it) and before the upload: an operator who starts the next report while
    // this one is still being sent must not have the fields wiped under them.
    const copying = copyToClipboard(generateReportText(finalReport));
    resetForm();
    // Not awaited: the upload doesn't wait on the clipboard. Nor does it
    // cover a toast the upload has shown by then (a refusal says more).
    const verb = !idToUpdate || mode === 'new' ? 'logged' : mode === 'edit' ? 'edited' : 'saved';
    const shownId = formatFullId(finalReport);
    copying.then(ok => {
        if (toastsShown === toastsBefore) showToast(ok ? `${shownId} ${verb} and copied.` : `${shownId} ${verb}. It couldn't be copied: use Copy on its row.`);
    });

    // Edit mode also hits the dedicated server route so the server can apply a
    // surgical overwrite (no history mutation) and broadcast SSE to peers. The
    // subsequent saveLocalAndSync push still runs as a safety net via merge.
    // Unreachable or refused, the save_reports push below reconciles or says
    // why. A 409 is the server holding a newer version than the one edited:
    // fetch it and ask, as when the change is seen before submitting.
    if (editTargetId && finalReport) {
        const res = await apiPost('/api/edit_report', {
            ato:      activeAto,
            reportId: editTargetId,
            fields: {
                size:         finalReport.size,
                activity:     finalReport.activity,
                location:     finalReport.location,
                time:         finalReport.time,
                yourAnalysis: finalReport.yourAnalysis,
                displayId:    finalReport.displayId,
                fullId:       finalReport.fullId,
                ato:          finalReport.ato,
                title:        finalReport.title,
                updated:      finalReport.updated,
                custom:       finalReport.custom || {},
                user:         userProfile,
                lastModified: now
            }
        });
        if (res.status === 409) {
            await syncWithServer();
            const theirs = localReports.find(r => r.id === editTargetId && !r.deleted);
            if (!theirs) { showToast('That report no longer exists. Another operator may have deleted it.', true); return; }
            const pick = await askEditConflict(theirs);
            if (pick === 'theirs') return;
            // Mine, or Cancel: this edit goes back in the form over theirs;
            // mine is then saved again, past their version.
            loadReportForEditing(theirs.id);
            refillForm(data);
            if (pick === 'mine') await handleFormSubmit(mode);
            return;
        }
    }

    // Await the push so a stale broadcast from another client can't clobber the
    // just-logged report between the local mutation and the server confirming it.
    await saveLocalAndSync(reportsByAto);
    } catch (err) {
        // Surface ANY error so it's never silent.
        showToast('Log error: ' + (err && err.message ? err.message : String(err)), true);
        console.error('Form submit failed:', err);
    }
}

el.form.root.addEventListener('submit', (e) => { e.preventDefault(); handleFormSubmit('new'); });
el.form.editBtn.addEventListener('click',   () => handleFormSubmit('edit'));
el.form.updateBtn.addEventListener('click', () => handleFormSubmit('update'));

el.form.cancelBtn.addEventListener('click', resetForm);

el.form.nowBtn.addEventListener('click', () => { el.form.time.value = clockValue(new Date(), timeDisplayMode === 'local'); });

el.form.time.addEventListener('blur', e => autoColonTime(e.target));

el.form.location.addEventListener('input', renderLocationHints);
document.getElementById('locationHints').addEventListener('click', e => {
    const chip = e.target.closest('[data-loc-add]');
    if (!chip) return;
    el.form.location.value = SaltCore.editLocation(el.form.location.value, { add: [chip.dataset.locAdd] });
    renderLocationHints();
    el.form.location.focus();
});

// Log body — unified event delegation (history toggle, copy, restore, row click)
el.log.body.addEventListener('click', e => {
    const fixLoc = e.target.closest('[data-fix-loc]');
    if (fixLoc) {
        e.stopPropagation();
        fixReportLocation(fixLoc.dataset.fixLoc);
        return;
    }
    const histBtn = e.target.closest('[data-history-id]');
    if (histBtn) {
        const id = histBtn.dataset.historyId;
        openHistoryRows.has(id) ? openHistoryRows.delete(id) : openHistoryRows.add(id);
        renderLog(el.log.search.value.toLowerCase());
        return;
    }
    const discardBtn = e.target.closest('[data-discard-id]');
    if (discardBtn) {
        e.stopPropagation();
        discardUnsaved([discardBtn.dataset.discardId]);
        return;
    }
    const restoreBtn = e.target.closest('[data-restore-id]');
    if (restoreBtn) {
        e.stopPropagation();
        restoreHistoryVersion(restoreBtn.dataset.restoreId, Number(restoreBtn.dataset.lm));
        return;
    }
    if (e.target.classList.contains('copy-btn')) {
        const report = localReports.find(r => r.id === e.target.dataset.id);
        if (report) copyToClipboard(generateReportText(report)).then(ok => showToast(ok
            ? `Copied ${formatFullId(report)} to the clipboard.`
            : `Couldn't copy ${formatFullId(report)}: the browser blocked the clipboard.`, !ok));
        return;
    }
    // BDA controls — toggle sub-row, target chip fill, add, delete.
    const bdaToggle = e.target.closest('[data-bda-id]');
    if (bdaToggle) {
        const id = bdaToggle.dataset.bdaId;
        openBdaRows.has(id) ? openBdaRows.delete(id) : openBdaRows.add(id);
        renderLog(el.log.search.value.toLowerCase());
        return;
    }
    // Clicking a logged assessment's effect badge swaps it for the effect
    // buttons, in place, with the current value marked.
    const editOpen = e.target.closest('[data-bda-editopen]');
    if (editOpen) {
        if (isReadOnly) return;
        const entry = editOpen.closest('.bda-entry');
        const lm    = entry.dataset.entryLm;
        const cur   = editOpen.textContent.trim();
        const grp   = document.createElement('span');
        grp.className = 'bda-eff-group bda-eff-editing';
        grp.innerHTML = BDA_EFFECTS.map(x =>
            `<button type="button" class="bda-eff-btn bda-eff-${x.cls}${x.name === cur ? ' picked' : ''}" data-bda-editlm="${escapeHtml(lm)}" data-bda-editid="${escapeHtml(editOpen.dataset.bdaEditopen)}" data-bda-eff="${x.name}" title="${x.name}">${x.key}</button>`).join('');
        editOpen.replaceWith(grp);
        return;
    }
    // Choosing a value in that inline editor commits immediately.
    const editBtn = e.target.closest('[data-bda-editlm]');
    if (editBtn) {
        updateBdaEffect(editBtn.dataset.bdaEditid, Number(editBtn.dataset.bdaEditlm), editBtn.dataset.bdaEff);
        return;
    }
    // Checklist: clicking an effect stages it for that row (click again to
    // clear). Nothing is written until Log Assessments.
    const effBtn = e.target.closest('.bda-eff-btn');
    if (effBtn) {
        const row  = effBtn.closest('.bda-check-row');
        const was  = effBtn.classList.contains('picked');
        row.querySelectorAll('.bda-eff-btn').forEach(b => b.classList.remove('picked'));
        if (!was) effBtn.classList.add('picked');
        row.classList.toggle('staged', !was);
        refreshBdaCommit(effBtn.closest('.bda-wrap'));
        return;
    }
    const bdaCommit = e.target.closest('[data-bda-commit]');
    if (bdaCommit) { commitBdaEntries(bdaCommit.dataset.bdaCommit, bdaCommit.closest('.bda-wrap')); return; }
    const bdaDel = e.target.closest('[data-bda-del]');
    if (bdaDel) { deleteBdaEntry(bdaDel.dataset.bdaDel, Number(bdaDel.dataset.lm)); return; }
    // Expand/collapse an overflowing Size/Location cell without entering
    // edit mode. Must be checked BEFORE the row-edit branch below — both
    // live in this handler because stopPropagation can't separate two
    // listeners on the same element.
    const clamp = e.target.closest('.cell-clamp');
    if (clamp && (clamp.classList.contains('clampable') || clamp.classList.contains('expanded'))) {
        const open = clamp.classList.toggle('expanded');
        if (open) expandedCells.add(clamp.dataset.cell); else expandedCells.delete(clamp.dataset.cell);
        return;
    }
    const tr = e.target.closest('tr');
    const td = e.target.closest('td');
    if (td && td.cellIndex > 0 && tr && !tr.classList.contains('history-sub-row')) {
        loadReportForEditing(tr.dataset.id);
    }
});

if (el.log.bdaRollup) el.log.bdaRollup.addEventListener('click', e => {
    const chip = e.target.closest('[data-bda-filter]');
    if (!chip) return;
    bdaFilter = bdaFilter === chip.dataset.bdaFilter ? null : chip.dataset.bdaFilter;
    renderLog();
});

// A checkbox's state lives in selectedRows / selectedHistory, so a redraw keeps it.
const keepChecked = (cb) => {
    if (cb.classList.contains('row-selector')) cb.checked ? selectedRows.add(cb.dataset.id) : selectedRows.delete(cb.dataset.id);
    else if (cb.classList.contains('history-selector')) {
        const k = `${cb.dataset.id}|${cb.dataset.lm}`;
        cb.checked ? selectedHistory.add(k) : selectedHistory.delete(k);
    }
};
const clearChecked = () => { selectedRows.clear(); selectedHistory.clear(); };
el.log.body.addEventListener('change', e => {
    if (!e.target.classList.contains('row-selector') && !e.target.classList.contains('history-selector')) return;
    keepChecked(e.target);
    updateSelectionUI();
});

el.log.deleteBtn.addEventListener('click', () => {
    // Single pass over the checked boxes — partition into main vs history
    // deletions instead of running two separate `querySelectorAll`s.
    const mainIds = [];
    const histSel = [];
    document.querySelectorAll('.row-selector:checked, .history-selector:checked').forEach(cb => {
        if (cb.classList.contains('row-selector')) {
            mainIds.push(cb.dataset.id);
        } else {
            histSel.push({ reportId: cb.dataset.id, lastModified: Number(cb.dataset.lm) });
        }
    });
    const total = mainIds.length + histSel.length;
    if (!total) return;
    showConfirmation(`Delete ${total} item(s)?`, async () => {
        // A change the server refused can't be deleted on the server (the
        // deleted version would be refused too), so deleting it discards it.
        const refusedIds = mainIds.filter(id => { const r = localReports.find(x => x.id === id); return r && unsavedEntry(activeAto, r); });
        if (refusedIds.length) {
            discardUnsaved(refusedIds, { confirm: false });
            refusedIds.forEach(id => mainIds.splice(mainIds.indexOf(id), 1));
        }
        // What Undo has to put back. A discarded refused change is gone for good.
        const ato = activeAto;
        const undone = { ids: [], history: {} };
        // ── Main report deletions (soft-delete via the deleted flag) ─────────
        if (mainIds.length) {
            const deletedSet = new Set(mainIds);
            localReports.forEach(r => { if (deletedSet.has(r.id)) { r.deleted = true; r.lastModified = nextStamp(r); undone.ids.push(r.id); } });
            reportsByAto[activeAto] = localReports;
            // Prune the history-open Set so deleted report IDs don't linger in
            // memory across long sessions (no functional impact, just hygiene).
            mainIds.forEach(id => openHistoryRows.delete(id));
        }
        // ── History deletions (filter the history[] arrays in place) ────────
        if (histSel.length) {
            const byReport = {};
            histSel.forEach(s => { (byReport[s.reportId] = byReport[s.reportId] || new Set()).add(s.lastModified); });
            localReports.forEach(r => {
                const lms = byReport[r.id];
                if (lms && r.history && r.history.length) {
                    const removed = r.history.filter(h => lms.has(h.lastModified));
                    if (removed.length) undone.history[r.id] = removed;
                    r.history = r.history.filter(h => !lms.has(h.lastModified));
                    r.lastModified = nextStamp(r); // bump so server merge prefers our copy
                }
            });
            reportsByAto[activeAto] = localReports;
            // Tell the server to remove the same entries server-side and broadcast
            // SSE. Unreachable or refused, the push below carries the same change.
            await apiPost('/api/delete_history', { ato: activeAto, deletions: histSel });
        }
        // Persist locally + push (save_reports merges by lastModified, which we bumped above).
        clearChecked();
        const saved = await saveLocalAndSync(reportsByAto);
        resetForm();
        updateSelectionUI();
        const canUndo = undone.ids.length || Object.keys(undone.history).length;
        showToast(saved || isLocalFile ? `${total} item(s) deleted.` : `${total} item(s) deleted here; the server can't be reached.`,
            false, canUndo ? { ms: UNDO_MS, undo: () => undoDeletion(ato, undone) } : {});
    });
});

el.log.selectAll.addEventListener('click',   () => { document.querySelectorAll('.row-selector, .history-selector').forEach(cb => { cb.checked=true; keepChecked(cb); });  updateSelectionUI(); el.menu.panel.style.display='none'; });
el.log.deselectAll.addEventListener('click', () => { clearChecked(); document.querySelectorAll('.row-selector, .history-selector').forEach(cb => cb.checked=false); updateSelectionUI(); el.menu.panel.style.display='none'; });

el.log.sendBtn.addEventListener('click', async () => {
    const target = el.log.sendSelect.value;
    if (!target) { showToast('Select a destination ATO first.', true); return; }
    const ids = [...document.querySelectorAll('.row-selector:checked')].map(cb => cb.dataset.id);
    if (!ids.length) return;
    const existing = reportsByAto[target] || [];
    const lastNum = existing.reduce((m,r) => Math.max(m, reportNum(r)), 0);
    const title = (existing.find(r => r.title && !r.deleted) || {}).title || target;
    // The copies for the destination, numbered on from its last report.
    const moving = [];
    ids.forEach(id => {
        const src = (reportsByAto['IMPORT'] || []).find(r => r.id === id && !r.deleted);
        if (!src) return;
        const did = `${SaltCore.atoPrefix(target)}${String(lastNum + moving.length + 1).padStart(3,'0')}`;
        moving.push({ ...src, ato: SaltCore.atoPrefix(target), title, displayId: did, fullId: `${title}${did}`, lastModified: nextStamp(src) });
    });
    if (!moving.length) return;
    // The destination first, and only what it took leaves IMPORT: a send
    // that didn't arrive keeps every report where it was.
    const result = isLocalFile ? 'ok' : await pushWorkspace(target, [...existing, ...moving]);
    if (result === 'queued') { showToast(`Not moved: the server can't be reached. The reports are still in IMPORT.`, true); return; }
    const refusedNote = {};
    const taken = moving.filter(r => {
        const u = unsavedEntry(target, r);
        if (!u) return true;
        // Refused: it stays in IMPORT instead of showing in the destination as "Not saved".
        refusedNote.reason = refusedNote.reason || u.reason;
        delete unsaved[target][SaltCore.reportKey(r)];
        return false;
    });
    if (refusedNote.reason) saveUnsaved();
    const left = moving.length - taken.length;
    if (!taken.length) { showToast(`Not moved: ${refusedNote.reason}`, true); return; }
    // A sync during the send may already have brought them in.
    const takenIds = new Set(taken.map(r => r.id));
    reportsByAto[target] = [...(reportsByAto[target] || existing).filter(r => !takenIds.has(r.id)), ...taken];
    // Bump the IMPORT copies too, or the deletion would never be sent.
    reportsByAto['IMPORT'] = (reportsByAto['IMPORT'] || []).map(r => (takenIds.has(r.id) ? { ...r, deleted: true, lastModified: nextStamp(r) } : r));
    populateAtoHistory();
    await saveLocalAndSync(reportsByAto);
    showToast(left ? `Moved ${taken.length} report(s) to ${target}. ${left} stayed in IMPORT: ${refusedNote.reason}` : `Moved ${taken.length} report(s) to ${target}.`, !!left);
});

el.log.search.addEventListener('input', debounce(e => { renderLog(e.target.value.toLowerCase()); renderMapView(); }, 100));
// `<input type="search">` natively clears its value on Escape but doesn't
// reliably fire an `input` event afterwards — so the rendered filter
// stayed applied after the text disappeared. Clear and re-render
// explicitly so the table snaps back to the full view.
el.log.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (el.log.search.value !== '') {
            el.log.search.value = '';
            renderLog('');
            renderMapView();   // the search narrows the map too
        }
        el.log.search.blur();
    }
});

// A click on a sortable header steps through that column's modes; a column
// that isn't the current sort starts at its first.
el.log.sortHeaders.forEach(th => th.addEventListener('click', () => {
    const modes = SORT_MODES[th.dataset.sort];
    currentSortMode = modes[(modes.indexOf(currentSortMode) + 1) % modes.length];
    writeStored('salt_sort_mode', currentSortMode); updateSortIcons(); renderLog(el.log.search.value.toLowerCase());
}));

// Config / ATO — shared logic for Set button and history dropdown. `post`
// false keeps it here only (it is already the server's).
async function applyAtoConfig({ post = true } = {}) {
    const newAto   = el.config.ato.value.trim().toUpperCase();
    const newTitle = el.config.title.value.trim();
    if (!newAto || !newTitle) { showToast('Enter both an ATO Designator and a Report Title.', true); return; }
    const newConfig = { ato: newAto, title: newTitle };
    // Commit local state immediately so the rest of the UI is consistent.
    activeAto    = newAto;
    localConfig  = newConfig;
    localReports = reportsByAto[activeAto] || [];
    writeStored('salt_last_active_ato', activeAto);
    writeStored('salt_offline_config', JSON.stringify(localConfig));
    setAtoState(true); renderLog();
    if (post) saveToast(await apiPost('/api/save_config', { config: newConfig }), isLocalFile ? 'Configuration saved.' : 'Configuration synced.');
    // If a sync ran during the await and clobbered anything, restore the intended state.
    activeAto    = newAto;
    localConfig  = newConfig;
    writeStored('salt_last_active_ato', activeAto);
    writeStored('salt_offline_config', JSON.stringify(localConfig));
}

el.config.setBtn.addEventListener('click', () => {
    if (el.config.ato.readOnly) {
        // The button is in its "Change" state. Drop into editable mode, then
        // unlock the history dropdown so the user can pick a different ATO
        // (or just type a new one in the inputs above).
        setAtoState(false); activeAto=null; localReports=[]; renderLog(); el.form.startNum.value=''; resetForm();
        if (el.config.history.options.length > 1) {
            el.config.history.disabled = false;
        }
    } else {
        applyAtoConfig();
    }
});

// Enter in either workspace field is the same as pressing Set. Ignored while
// the fields are locked (button reads "Change") so Enter can't re-submit.
[el.config.ato, el.config.title].forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!el.config.ato.readOnly) applyAtoConfig();
}));

el.config.history.addEventListener('change', () => {
    const sel = el.config.history.selectedOptions[0];
    if (sel && sel.value) { el.config.ato.value=sel.value; el.config.title.value=sel.dataset.title||'Report #'; applyAtoConfig(); }
});

el.menu.clearBtn.addEventListener('click', () => {
    if (!activeAto) { showToast('No active ATO board to clear.', true); return; }
    if (localReports.filter(r=>!r.deleted).length===0) { showToast('This board is already empty.', true); return; }
    unloadWorkspace(activeAto);
});

// Profile
el.profile.setBtn.addEventListener('click', async () => {
    const initials = el.profile.initials.value.trim().toUpperCase();
    const color    = el.profile.color.value;
    if (!initials) { showToast('Enter your initials.', true); return; }
    userProfile = { initials, color };
    writeStored('salt_user_profile_local', JSON.stringify(userProfile));
    saveToast(await apiPost('/api/save_profile', { profile:userProfile }), 'Profile saved.');
    updateProfilePreview(); syncWithServer();
});
// Scope this to the profile menu's swatches so the startup-modal swatches
// (same class, different container) don't trigger the profile-side update.
el.profile.menu.querySelectorAll('.color-swatch').forEach(sw => sw.addEventListener('click', e => { e.stopPropagation(); const c=sw.dataset.color; el.profile.color.value=c; el.profile.avatar.style.backgroundColor=c; el.profile.menu.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected')); sw.classList.add('selected'); }));
el.profile.initials.addEventListener('input', () => { el.profile.avatar.textContent = el.profile.initials.value.trim().toUpperCase()||'?'; });

// Copy the access code to clipboard for quick sharing. Disabled when no
// code is set (e.g., --no-access-code server, or after a 401 cleared it).
if (el.profile.accessCopy) {
    el.profile.accessCopy.addEventListener('click', () => {
        if (!accessCode) return;
        copyToClipboard(accessCode).then(ok => showToast(ok
            ? 'Access code copied to the clipboard.'
            : 'Couldn\'t copy the access code: the browser blocked the clipboard. Press Show to read it.', !ok));
    });
}

if (el.profile.accessShow) {
    el.profile.accessShow.addEventListener('click', () => {
        identityCodeShown = !identityCodeShown;
        renderIdentityAccessCode();
    });
}
if (el.startup.accessShow) {
    el.startup.accessShow.addEventListener('click', () => {
        setStartupCodeShown(el.startup.accessCode.classList.contains('access-masked'));
        el.startup.accessCode.focus();
    });
}

// ─── First-run setup modal handlers ──────────────────────────────────────

// Known profiles = server-synced (live) merged over the last session's cache,
// so returning users can pick their profile even before the first sync lands.
const knownProfiles = () => ({ ...readStored(_PROFILES_CACHE_KEY, {}), ...localProfiles });

// Quick Start: one section offering everything the modal asks for as a
// preset — operator identity, ATO designator, and report title — each an
// independent row so you can mix a known operator with a new workspace.
const renderStartupPresets = () => {
    const sec = el.startup.presets;
    if (!sec) return;
    const fill = (id, html) => {
        const row = sec.querySelector('#' + id);
        row.style.display = html ? '' : 'none';
        row.querySelector('.startup-chip-list').innerHTML = html;
    };
    // Capped so the section stays a compact shortcut rather than a wall of
    // chips once a deployment has been running for a while.
    const CAP   = 5;
    const profs = Object.values(knownProfiles()).filter(p => p && p.initials).slice(0, CAP);
    const atos  = Object.keys(reportsByAto).filter(a => (reportsByAto[a] || []).some(r => !r.deleted)).sort().slice(0, CAP);
    // Titles seen anywhere, plus whatever the active config carries.
    const titles = [...new Set([
        ...Object.values(reportsByAto).flat().filter(r => r && r.title && !r.deleted).map(r => r.title),
        ...((localConfig && localConfig.title) ? [localConfig.title] : []),
    ])].sort().slice(0, CAP);

    fill('startup-preset-profiles', profs.map(p => {
        // A synced color goes into a style: only a plain color, never more CSS.
        const c = safeColor(p.color) === p.color ? p.color : '#0a84ff';
        return `<button type="button" class="startup-profile-chip" data-preset="profile" data-initials="${escapeHtml(p.initials)}" data-color="${escapeHtml(c)}"><span class="chip-dot" style="background:${c}"></span>${escapeHtml(p.initials)}</button>`;
    }).join(''));
    fill('startup-preset-atos', atos.map(a =>
        `<button type="button" class="startup-profile-chip" data-preset="ato" data-ato="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join(''));
    fill('startup-preset-titles', titles.map(t =>
        `<button type="button" class="startup-profile-chip" data-preset="title" data-title="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join(''));

    // Whole section (and its divider) hide on a first-ever run with nothing known.
    const any = profs.length || atos.length || titles.length;
    sec.style.display = any ? '' : 'none';
    const div = document.getElementById('startup-presets-divider');
    if (div) div.style.display = any ? '' : 'none';
};

if (el.startup.presets) el.startup.presets.addEventListener('click', e => {
    const chip = e.target.closest('[data-preset]');
    if (!chip) return;
    if (chip.dataset.preset === 'profile') {
        const ini = chip.dataset.initials, c = chip.dataset.color;
        el.startup.initials.value = ini;
        el.startup.color.value = c;
        el.startup.avatar.textContent = ini;
        el.startup.avatar.style.backgroundColor = c;
        el.startup.swatches.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === c));
    } else if (chip.dataset.preset === 'ato') {
        el.startup.ato.value = chip.dataset.ato;
        el.startup.ato.dataset.touched = '1';
        // Offer that workspace's known title unless the user typed one already.
        if (!el.startup.title.value) {
            const rep = (reportsByAto[chip.dataset.ato] || []).find(r => r.title && !r.deleted);
            if (rep) el.startup.title.value = rep.title;
        }
    } else if (chip.dataset.preset === 'title') {
        el.startup.title.value = chip.dataset.title;
        el.startup.title.dataset.touched = '1';
    }
    // Mark the active choice in each row.
    const row = chip.closest('.startup-preset-row');
    row.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('selected', b === chip));
});

const openStartupModal = () => {
    // Idempotent — if the modal is already shown, don't re-paint the fields
    // (would clobber whatever the user has been typing).
    if (el.startup.overlay.classList.contains('show')) return;
    // Pre-fill anything we already know so the user only types what's missing.
    if (userProfile && userProfile.initials) {
        el.startup.initials.value = userProfile.initials;
        const c = userProfile.color || '#0a84ff';
        el.startup.color.value = c;
        el.startup.avatar.textContent = userProfile.initials;
        el.startup.avatar.style.backgroundColor = c;
        el.startup.swatches.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === c));
    } else {
        el.startup.initials.value = '';
        el.startup.color.value = '#0a84ff';
        el.startup.avatar.textContent = '?';
        el.startup.avatar.style.backgroundColor = '#0a84ff';
        el.startup.swatches.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === '#0a84ff'));
    }
    renderStartupPresets();
    el.startup.ato.value   = activeAto || (localConfig && localConfig.ato) || '';
    el.startup.title.value = (localConfig && localConfig.title) || '';
    delete el.startup.ato.dataset.touched;
    delete el.startup.title.dataset.touched;
    refreshStartupWorkspace();
    // Access code: pre-fill from whatever's already known (host auto-fill
    // via the server-injected <meta>, or a previously-typed value cached
    // in localStorage). Empty for fresh non-host editors — they type it.
    if (el.startup.accessCode) el.startup.accessCode.value = accessCode || '';
    setStartupCodeShown(false);
    if (el.startup.accessError) {
        el.startup.accessError.classList.remove('show');
        el.startup.accessError.textContent = '';
    }

    el.startup.overlay.classList.add('show');
    el.startup.overlay.setAttribute('aria-hidden', 'false');

    // Focus the first empty field for a smooth flow.
    setTimeout(() => {
        if      (!el.startup.initials.value) el.startup.initials.focus();
        else if (!el.startup.ato.value)      el.startup.ato.focus();
        else                                  el.startup.title.focus();
    }, 50);
};

const closeStartupModal = () => {
    // The user has reviewed and confirmed this server-session's access code.
    // Remember that so we don't keep re-forcing the modal on every refresh
    // of the same session.
    if (accessCode) {
        writeStored(_ACCESS_CONFIRMED_KEY, accessCode);
    }
    forceStartupModal = false;
    el.startup.overlay.classList.remove('show');
    el.startup.overlay.setAttribute('aria-hidden', 'true');
    // Lift the pre-paint gate now that the user has confirmed setup — the
    // app body becomes visible behind the closing modal.
    document.documentElement.classList.remove('salt-ready-gate');
};

// The modal opens before the first sync, with this browser's last workspace.
// When the server says which is active, the fields not typed in follow it,
// so Get Started doesn't switch everyone back to an old one.
const refreshStartupWorkspace = () => {
    if (!serverConfig || !serverConfig.ato) return;
    if (!el.startup.ato.dataset.touched)   el.startup.ato.value   = serverConfig.ato;
    if (!el.startup.title.dataset.touched) el.startup.title.value = serverConfig.title;
};
[el.startup.ato, el.startup.title].forEach(box => box.addEventListener('input', () => { box.dataset.touched = '1'; }));

// Live preview: avatar tracks the initials as the user types.
el.startup.initials.addEventListener('input', () => {
    el.startup.avatar.textContent = el.startup.initials.value.trim().toUpperCase() || '?';
});

// Color swatch picker (mirrors the profile menu, scoped to the startup modal).
el.startup.swatches.querySelectorAll('.color-swatch').forEach(sw => sw.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const c = sw.dataset.color;
    el.startup.color.value = c;
    el.startup.avatar.style.backgroundColor = c;
    el.startup.swatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
    sw.classList.add('selected');
}));

// Enter in any field advances to the next or submits.
[el.startup.initials, el.startup.ato, el.startup.title].forEach((node, i, arr) => {
    node.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const next = arr[i + 1];
            if (next && !next.value.trim()) next.focus();
            else el.startup.continueBtn.click();
        }
    });
});

// Continue: validate code (editor port only), then identity + workspace, save all, close.
el.startup.continueBtn.addEventListener('click', async () => {
    const initials = el.startup.initials.value.trim().toUpperCase();
    const ato      = el.startup.ato.value.trim().toUpperCase();
    const title    = el.startup.title.value.trim();
    const code     = (el.startup.accessCode ? el.startup.accessCode.value : '').trim().toUpperCase();

    const missing = [];
    // Access code is required only on the editor port when a server is in
    // play. Viewers (body.read-only) and local file:// sessions skip it.
    if (!isReadOnly && !isLocalFile && !code) missing.push('Access Code');
    if (!initials) missing.push('Initials');
    if (!ato)      missing.push('ATO Designator');
    if (!title)    missing.push('Report Title');
    if (missing.length) {
        showToast('Please fill in: ' + missing.join(', '), true);
        return;
    }

    // Validate the access code by attempting a sync. The server returns
    // 401 if the cookie's code doesn't match; on success we save the
    // code and proceed to save identity + workspace.
    // The same answer says which workspace the server has active.
    let current = serverConfig;
    if (!isReadOnly && !isLocalFile) {
        setAccessCode(code);
        try {
            const probe = await fetch('/api/sync');
            if (probe.status === 401) {
                clearAccessCode();
                if (el.startup.accessError) {
                    el.startup.accessError.textContent = 'Access denied — check the code with the host.';
                    el.startup.accessError.classList.add('show');
                }
                return;
            }
            const state = probe.ok ? await probe.json().catch(() => null) : null;
            if (state) current = state.config || {};
        } catch (e) {
            // Network error — let the user proceed; the offline path will
            // catch up when the server is reachable.
        }
        if (el.startup.accessError) el.startup.accessError.classList.remove('show');
    }

    el.startup.continueBtn.disabled = true;
    try {
        // 1. Save the user's identity locally + to the server.
        userProfile = { initials, color: el.startup.color.value || '#0a84ff' };
        writeStored('salt_user_profile_local', JSON.stringify(userProfile));
        const saved = isLocalFile ? { ok: true } : await apiPost('/api/save_profile', { profile: userProfile });
        // Sync the profile preview in the header.
        el.profile.initials.value = initials;
        el.profile.color.value    = userProfile.color;
        selectSwatch(userProfile.color);
        updateProfilePreview();

        // 2. Save the workspace config via the same path the Set button uses,
        //    so all clients adopt the new ATO/Title on their next sync. Only
        //    when it differs from the server's: the same one needn't be sent.
        el.config.ato.value   = ato;
        el.config.title.value = title;
        const unchanged = !!current && String(current.ato || '').toUpperCase() === ato && (current.title || '') === title;
        await applyAtoConfig({ post: !unchanged });
        // Said last, so the workspace's toast doesn't cover it.
        if (!saved.ok && saved.status !== 0 && saved.status !== 401) showToast(`Identity not saved: ${saved.message}`, true);
    } finally {
        el.startup.continueBtn.disabled = false;
    }
    closeStartupModal();
});

// Decide whether the first-run prompt should appear. Called after the initial
// sync so the server's existing config (if any) has already populated localConfig.
const needsStartupSetup = () => {
    // Viewer mode skips the modal entirely — no identity, no ATO setup needed.
    if (isReadOnly || document.body.classList.contains('read-only')) return false;
    const hasCode     = !!accessCode;
    const hasProfile  = !!(userProfile && userProfile.initials);
    const hasAto      = !!activeAto;
    const hasTitle    = !!(localConfig && localConfig.title);
    if (!hasCode && !isLocalFile) return true;
    // Fresh-server-session override: host has an auto-injected code that
    // differs from what they last confirmed. Show the modal so they can
    // review identity/ATO/title before silently inheriting server state.
    if (forceStartupModal)      return true;
    return !hasProfile || !hasAto || !hasTitle;
};
const maybeShowStartupModal = () => { if (needsStartupSetup()) openStartupModal(); };

// Import

// CSV import — column mapping view
el.csv.closeBtn  .addEventListener('click', closeCsvImportView);
el.csv.cancelBtn .addEventListener('click', closeCsvImportView);
el.csv.confirmBtn.addEventListener('click', confirmCsvImport);

// Export
document.getElementById('exportPanelBackupBtn').addEventListener('click', () => {
    try {
        if (el.exp.allAtosToggle.checked) {
            // ── Export all ATOs ───────────────────────────────────────────
            const fromMs = parseFilterTime(el.exp.fromDate.value, el.exp.fromTime.value, false);
            const toMs   = parseFilterTime(el.exp.toDate.value,   el.exp.toTime.value,   true);
            const filtered = {};
            Object.keys(reportsByAto).forEach(ato => {
                let reps = (reportsByAto[ato]||[]).filter(r => !r.deleted);
                if (fromMs !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() >= fromMs);
                if (toMs   !== null) reps = reps.filter(r => r.time && new Date(r.time).getTime() <= toMs);
                if (reps.length) filtered[ato] = reportsByAto[ato]; // keep full array (deleted flags intact) for machine data
            });
            if (!Object.keys(filtered).length) { showToast('No reports to export.', true); return; }
            const fname = `ALL_ATOS_${fileStamp(new Date(), false)}.txt`;
            triggerDownload(fname, generateAllAtosBackupText(filtered, activeAto||'', localConfig.title||'SALT', localProfiles));
            showToast(`All ATOs backup exported!`);
            clearExportFilter();
        } else {
            // ── Export active ATO only (default) ─────────────────────────
            const reps = getExportFilteredReports();
            if (!reps.length) { showToast('No reports to export.', true); return; }
            const title = localConfig.title || 'SALT';
            triggerDownload(`${SaltCore.backupFilename(activeAto||'ATO', title)}.txt`, generateBackupText(activeAto||'ATO', reps, title, localProfiles));
            showToast('Backup exported!');
            clearExportFilter();
        }
    } catch(e) { showToast('Export error: ' + e.message, true); }
});
document.getElementById('exportPanelCsvBtn').addEventListener('click', () => {
    try {
        const reps = getExportFilteredReports();
        if (!reps.length) { showToast('No reports to export.', true); return; }
        const local = timeDisplayMode === 'local';
        // The identifier as the table shows it ("Patrol - ALPHA001").
        const idOf  = formatFullId;
        const base  = getCsvFilename(activeAto||'ATO', localConfig.title||'SALT');
        if (el.exp.mtiToggle.checked) {
            const mti = SaltCore.mtiCsvs(reps, { local, idOf });
            if (mti.trackedRows) triggerDownload(`${base}_tracked.csv`, mti.tracked, 'text/csv;charset=utf-8;');
            if (mti.wheeledRows) setTimeout(() => triggerDownload(`${base}_wheeled.csv`, mti.wheeled, 'text/csv;charset=utf-8;'), 400);
            if (!mti.trackedRows && !mti.wheeledRows) showToast('No tracked/wheeled reports found.', true);
            else { showToast('MTI CSV exported!'); clearExportFilter(); }
        } else {
            // Custom columns: the format's custom lines plus any keys on the
            // data, in case the format changed since those reports were logged.
            const customLabels = [...new Set([
                ...currentFormat().lines.filter(l => l.type === 'custom').map(l => l.label),
                ...reps.flatMap(r => Object.keys(r.custom || {})),
            ])];
            const latestOnly = document.getElementById('exportLatestOnlyToggle').checked;
            triggerDownload(`${base}${latestOnly ? '_latest' : ''}.csv`, SaltCore.reportsCsv(reps, { local, customLabels, idOf, latestOnly }), 'text/csv;charset=utf-8;');
            showToast(latestOnly ? 'CSV exported: one row per report.' : 'CSV exported!');
            clearExportFilter();
        }
    } catch(e) { showToast('Export error: '+e.message,true); }
});

document.getElementById('exportArcgisEsriBtn').addEventListener('click', () => {
    try { exportForArcgis('esri'); } catch(e) { showToast('Export error: ' + e.message, true); }
});
document.getElementById('exportArcgisGeojsonBtn').addEventListener('click', () => {
    try { exportForArcgis('geojson'); } catch(e) { showToast('Export error: ' + e.message, true); }
});
document.getElementById('exportArcgisCsvBtn').addEventListener('click', () => {
    try { exportForArcgis('csv'); } catch(e) { showToast('Export error: ' + e.message, true); }
});

el.menu.exportBtn.addEventListener('click', () => isExportViewActive ? closeExportView() : openExportView());

el.ioPicker.select.addEventListener('change', () => {
    writeStored('salt_io_export', el.ioPicker.select.value);
    renderIoPicker();
});
el.ioPicker.run.addEventListener('click', runIoPicker);
renderIoPicker();

// Workspaces list: Unload buttons (editor only) AND viewer-mode whole-row
// clicks are delegated through the list container so we don't have to
// rebind on every renderWorkspacesList(). Same handler attaches to both
// the panel list (editor mode) and the sidebar list (viewer mode).
const _wireWorkspaceList = (container) => {
    if (!container) return;
    container.addEventListener('click', e => {
        const unloadBtn = e.target.closest('[data-unload-ato]');
        if (unloadBtn) { unloadWorkspace(unloadBtn.getAttribute('data-unload-ato')); return; }
        // In viewer mode, clicking anywhere on a row switches the local view.
        if (isReadOnly) {
            const row = e.target.closest('[data-switch-ato]');
            if (row) switchWorkspaceLocal(row.getAttribute('data-switch-ato'));
        }
    });
};
_wireWorkspaceList(el.workspaces.list);
_wireWorkspaceList(el.workspaces.sidebarList);
// Tab strip clicks — segmented-control style switch.
el.workspaces.tabs.forEach(btn => {
    btn.addEventListener('click', () => switchWorkspacesTab(btn.dataset.tab));
});

// Filter — live update as the user picks dates / types times (24-hour HH:MM)
[el.exp.fromDate, el.exp.toDate, el.exp.fromTime, el.exp.toTime].forEach(node => {
    node.addEventListener('input',  renderExportPreview);
    node.addEventListener('change', renderExportPreview);
});
// Same "1430" -> "14:30" help as the report form's time field.
const formatTimeOnBlur = (e) => { if (autoColonTime(e.target)) renderExportPreview(); };
el.exp.fromTime.addEventListener('blur', formatTimeOnBlur);
el.exp.toTime  .addEventListener('blur', formatTimeOnBlur);
el.exp.clearBtn.addEventListener('click', clearExportFilter);

// Quick-range presets (Last 12h / 6h / 1h).
// Writes both the From and To pairs from a single click, honoring the current
// Zulu/Local time mode so the values line up with what the user sees elsewhere.
const writeFilterPair = (dateField, timeField, d) => {
    const local = timeDisplayMode === 'local';
    const f = dateFields(d, local);
    dateField.value = `${f.y}-${f.mo}-${f.day}`;
    timeField.value = clockValue(d, local);
};
document.querySelectorAll('.filter-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const hours = parseInt(btn.dataset.presetHours, 10);
        if (!hours || isNaN(hours)) return;
        const now  = new Date();
        const from = new Date(now.getTime() - hours * 3600 * 1000);
        writeFilterPair(el.exp.fromDate, el.exp.fromTime, from);
        writeFilterPair(el.exp.toDate,   el.exp.toTime,   now);
        renderExportPreview();
    });
});

// Layout / Time format
el.menu.layoutBtn.addEventListener('click', () => { el.layout.grid.classList.toggle('horizontal-layout'); writeStored('salt_layout', el.layout.grid.classList.contains('horizontal-layout')?'horizontal':'vertical'); applyLayoutMode(); });
el.menu.timeBtn.addEventListener('click', () => { timeDisplayMode=timeDisplayMode==='zulu'?'local':'zulu'; writeStored('salt_time_mode',timeDisplayMode); showToast(`Time format: ${timeDisplayMode}.`); updateTimeBtnText(); if(el.form.reportId.value) loadReportForEditing(el.form.reportId.value); renderLog(); if (isExportViewActive) renderExportPreview(); });
el.menu.sepBtn.addEventListener('click', () => {
    atoTitleSep = atoTitleSep==='dash'?'space':'dash';
    writeStored('salt_ato_title_sep', atoTitleSep);
    updateSepBtnText();
    // The separator shows in the workspace lists, the Identifier column, the
    // edit-form title, and copied report text — refresh everything visible.
    renderWorkspacesList();
    renderLog();
    if (el.form.reportId.value) loadReportForEditing(el.form.reportId.value);
    const bp = document.querySelector('[data-tab-panel="builder"]');
    if (bp && bp.style.display !== 'none') renderBuilderPreview();
    showToast(`ATO/Title separator: ${atoTitleSep}.`);
});
el.menu.mgrsLockBtn.addEventListener('click', () => {
    mgrsLock = !mgrsLock;
    writeStored('salt_mgrs_lock', mgrsLock ? 'on' : 'off');
    updateMgrsLockUi();
    renderLocationHints();
    el.menu.panel.style.display = 'none';
    if (mgrsLock && !mgrsLockPrefix) { document.getElementById('mgrsPrefix').focus(); showToast('MGRS Lock on. Set the grid zone and square (e.g. 11S NV) beside Location.'); }
    else showToast(mgrsLock ? `MGRS Lock on: grids typed as digits get ${mgrsLockPrefix}.` : 'MGRS Lock off.');
});
// The locked prefix: kept as typed while typing, tidied ("11S NV") on leaving.
const mgrsPrefixBox = document.getElementById('mgrsPrefix');
mgrsPrefixBox.addEventListener('input', () => {
    const p = SaltCore.mgrsPrefix(mgrsPrefixBox.value);
    mgrsPrefixBox.classList.toggle('invalid', !!mgrsPrefixBox.value.trim() && !p);
    if (p || !mgrsPrefixBox.value.trim()) {
        mgrsLockPrefix = p || '';
        writeStored('salt_mgrs_prefix', mgrsLockPrefix);
        updateMgrsLockUi();
        renderLocationHints();
    }
});
// Enter in the box sets the zone and square and goes on to Location: it's in
// the report form, but it doesn't log a report (nor say what's missing).
mgrsPrefixBox.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    el.form.location.focus();
});
mgrsPrefixBox.addEventListener('blur', () => {
    if (mgrsPrefixBox.value.trim() && !SaltCore.mgrsPrefix(mgrsPrefixBox.value)) showToast('Use the grid zone and 100 km square, e.g. 11S NV.', true);
    else mgrsPrefixBox.value = mgrsLockPrefix;
    mgrsPrefixBox.classList.remove('invalid');
});
el.menu.bdaBtn.addEventListener('click', () => { bdaMode = !bdaMode; bdaFilter = null; writeStored('salt_bda_mode', bdaMode ? 'on' : 'off'); document.body.classList.toggle('bda-mode', bdaMode); updateBdaBtnText(); renderLog(); el.menu.panel.style.display='none'; showToast(bdaMode ? 'BDA tracking shown.' : 'BDA tracking hidden.'); });

// Menus
setupMenuToggle(el.menu.btn, el.menu.panel);
el.menu.panel.addEventListener('click', e => { if(e.target.tagName==='BUTTON') el.menu.panel.style.display='none'; });
document.addEventListener('click', e => { if(!el.menu.btn.contains(e.target)&&!el.menu.panel.contains(e.target)) el.menu.panel.style.display='none'; });
// (The person icon used to live in the report-log header and toggle a popup;
// it's now the Identity tab itself, wired through the normal tab handler.)

// User Manual modal
const openManual  = () => { el.manual.modal.classList.add('show');    el.manual.modal.setAttribute('aria-hidden', 'false'); el.manual.modal.querySelector('.manual-body').scrollTop = 0; };
const closeManual = () => { el.manual.modal.classList.remove('show'); el.manual.modal.setAttribute('aria-hidden', 'true');  };
el.manual.openBtn .addEventListener('click', openManual);
el.manual.closeBtn.addEventListener('click', closeManual);
// Click outside the modal card closes it.
el.manual.modal.addEventListener('click', e => { if (e.target === el.manual.modal) closeManual(); });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); el.log.search.focus(); el.log.search.select(); return; }
    if (e.key==='Escape' && pendingChoice) { e.preventDefault(); pendingChoice(null); return; }
    if (e.key==='Escape' && el.toast.confirm.classList.contains('show')) { e.preventDefault(); hideConfirmation(); return; }
    if (e.key==='Escape' && el.menu.panel.style.display === 'block') { e.preventDefault(); el.menu.panel.style.display = 'none'; el.menu.btn.focus(); return; }
    if (e.key==='Escape' && el.manual.modal.classList.contains('show')) { e.preventDefault(); closeManual(); return; }
    if (e.key==='Escape' && el.form.cancelBtn.style.visibility==='visible') { e.preventDefault(); resetForm(); showToast('Editing cancelled.'); return; }
    // Escape clears any selected table rows (before the form-clear fallback).
    if (e.key==='Escape') {
        const sel = document.querySelectorAll('.row-selector:checked, .history-selector:checked');
        if (sel.length) { e.preventDefault(); clearChecked(); sel.forEach(cb => cb.checked = false); updateSelectionUI(); return; }
    }
    // New-report mode: Escape clears the form fields if focus is inside the form
    // AND any of the SALT fields has content. Doesn't clear when the form is
    // already empty (so Escape outside an active task doesn't do anything noisy).
    if (e.key==='Escape' && el.form.root.contains(e.target) && !el.form.reportId.value) {
        const customInputs = [...document.querySelectorAll('#salt-fields [data-custom-label]')];
        const hasContent = el.form.size.value.trim() || el.form.activity.value.trim() ||
                           el.form.location.value.trim() || el.form.time.value.trim() ||
                           el.form.analysis.value.trim() || customInputs.some(i => i.value.trim());
        if (hasContent) {
            e.preventDefault();
            el.form.size.value = el.form.activity.value = el.form.location.value = '';
            el.form.time.value = el.form.analysis.value = '';
            customInputs.forEach(i => { i.value = ''; });
            if (e.target.blur) e.target.blur();
            showToast('Fields cleared.');
            return;
        }
    }
    // A box that takes Enter itself (MGRS Lock's) has already said so.
    if (e.key==='Enter' && !e.defaultPrevented) {
        // Pick which button this keypress should fire:
        //   Editing + Ctrl/Meta+Enter → Edit (overwrite, no history)
        //   Editing + plain Enter     → Update (append to history)
        //   New report                → Log New Report
        const isEditing = !!el.form.reportId.value;
        const targetBtn = isEditing
            ? ((e.ctrlKey || e.metaKey) ? el.form.editBtn : el.form.updateBtn)
            : el.form.logBtn;
        if (e.target.tagName==='TEXTAREA') {
            // In a textarea, plain Enter inserts a newline — only fire on Ctrl/Meta+Enter.
            // While editing, that combo means Edit; while new, it means Log.
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault(); e.target.blur();
                (isEditing ? el.form.editBtn : el.form.logBtn).click();
            }
            return;
        }
        if (e.target.tagName==='BUTTON') return;
        if (el.form.root.contains(e.target)) { e.preventDefault(); e.target.blur(); targetBtn.click(); }
    }
});

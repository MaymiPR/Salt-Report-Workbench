// SPDX-License-Identifier: AGPL-3.0-only

// Entry form, editing, restore and undo, identity.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 6. Form (entry, editing, profile) ---

// Reorder the form's input groups to match the active format and (re)build
// inputs for custom fields. `id` and `analysis` lines don't move form
// elements: the identifier isn't an input and Analysis keeps its own area.
// In-flight custom values survive the re-render.
const applyFormFieldOrder = () => {
    const fields = document.getElementById('salt-fields');
    if (!fields) return;
    const groupFor = {
        size:     el.form.size.closest('.input-group'),
        activity: el.form.activity.closest('.input-group'),
        location: el.form.location.closest('.input-group'),
        time:     el.form.time.closest('.input-group'),
    };
    const fmt = currentFormat();
    // Every sync lands here. Moving or re-creating the box someone is typing
    // in takes their cursor out of it mid-word, so the boxes are only touched
    // when the layout actually changed, and focus is put back when they are.
    const layout = JSON.stringify(fmt.lines.filter(l => groupFor[l.type] || l.type === 'custom')
        .map(l => l.type === 'custom' ? [l.label, l.name || ''] : l.type));
    if (fields.dataset.layout !== layout) {
        fields.dataset.layout = layout;
        rebuildFormFields(fields, groupFor, fmt);
    }
    // Analysis is format-controlled: hidden unless its line is in the format.
    const hasAnalysis = fmt.lines.some(l => l.type === 'analysis');
    const analysisBox = document.getElementById('analysis-field');
    if (analysisBox) analysisBox.style.display = hasAnalysis ? '' : 'none';
    const logTable = document.getElementById('reportLogTable');
    if (logTable) logTable.classList.toggle('hide-analysis', !hasAnalysis);
};

const rebuildFormFields = (fields, groupFor, fmt) => {
    const active = document.activeElement;
    const focusKey = active && fields.contains(active) ? (active.id || `custom:${active.dataset.customLabel}`) : null;
    const caret = focusKey ? [active.selectionStart, active.selectionEnd] : null;
    const prevVals = {};
    fields.querySelectorAll('[data-custom-label]').forEach(i => { prevVals[i.dataset.customLabel] = i.value; });
    fields.querySelectorAll('.custom-input-group').forEach(n => n.remove());
    fmt.lines.forEach(line => {
        if (groupFor[line.type]) {
            fields.appendChild(groupFor[line.type]);
        } else if (line.type === 'custom') {
            const g = document.createElement('div');
            g.className = 'input-group custom-input-group';
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.maxLength = 500;  // the server's per-value limit
            // Form shows the descriptive name; the copy text uses the letter.
            inp.placeholder = line.name || line.label;
            inp.dataset.customLabel = line.label;
            inp.value = prevVals[line.label] || '';
            g.appendChild(inp);
            fields.appendChild(g);
        }
    });
    if (focusKey) {
        const again = focusKey.startsWith('custom:')
            ? [...fields.querySelectorAll('[data-custom-label]')].find(i => `custom:${i.dataset.customLabel}` === focusKey)
            : document.getElementById(focusKey);
        if (again) {
            again.focus();
            try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text box */ }
        }
    }
};

// Non-empty custom-field values keyed by label.
const collectCustomValues = () => {
    const out = {};
    document.querySelectorAll('#salt-fields [data-custom-label]').forEach(i => {
        const v = i.value.trim();
        if (v) out[i.dataset.customLabel] = v;
    });
    return out;
};

// Keep a format here without telling the server (it came from the server, or
// is about to be sent): the form and the log follow it.
const adoptFormat = (format) => {
    sharedFormat = isFormat(format) ? format : null;
    if (!viewerAtLoad) writeStored('salt_format', JSON.stringify(currentFormat()));
    applyFormFieldOrder();
    renderLog();
};

// Persist a format change (every workspace): local cache + server.
const saveWorkspaceFormat = (format) => {
    sharedFormat = format;
    writeStored('salt_format', JSON.stringify(format));
    applyFormFieldOrder();
    // Custom fields own table columns now, so the log has to repaint too.
    renderLog();
    postJson('/api/save_format', { format }).catch(() => {});
};

// --- Location against the overlays ---

// Under the Location box: what Log / Update will add (click one to add it
// now) and what disagrees with the grid.
const renderLocationHints = () => {
    const box = document.getElementById('locationHints');
    if (!box) return;
    const text = lockedLocation(el.form.location.value);
    const ovs = currentOverlays();
    const plan = ovs.length && text.trim() ? SaltCore.locationPlan(text, ovs) : { add: [], conflicts: [] };
    const near = plan.add.some(k => k.startsWith('PL ')) ? locationInfo(text).nearestPl : null;
    const chips = [
        ...plan.add.map(k => `<button type="button" class="loc-hint" data-loc-add="${escapeHtml(k)}" title="Added when you log. Click to add it now.">+ ${escapeHtml(k)}${near && near.key === k ? ` <span class="loc-hint-sub">${Math.round(near.metres)} m</span>` : ''}</button>`),
        ...plan.conflicts.map(c => `<span class="loc-hint warn" title="When you log, you pick which to keep.">${escapeHtml(c.message)}</span>`),
    ];
    box.innerHTML = chips.join('');
    box.hidden = !ovs.length;
};

// The Location box with the places its grid is in added, and each typed
// place the grid disagrees with settled by the operator. Null when they
// cancel. Unchanged without overlays.
const settleLocation = async (text) => {
    const ovs = currentOverlays();
    if (!ovs.length) return text;
    const plan = SaltCore.locationPlan(text, ovs);
    const replace = {}, add = [...plan.add];
    for (const c of plan.conflicts) {
        const opts = c.found.length
            ? [{ label: `Use ${c.found.join(', ')}`, value: 'grid', primary: true }, { label: `Keep ${c.typed}`, value: 'typed' }, { label: 'Keep both', value: 'both' }]
            : [{ label: `Keep ${c.typed}`, value: 'typed', primary: true }, { label: `Take out ${c.typed}`, value: 'grid' }];
        const pick = await askChoice(`The grid and ${c.typed} disagree`, c.message + '.', opts);
        if (pick === null) return null;
        if (pick === 'grid') replace[c.typed] = c.found.join(', ');
        if (pick === 'both') add.push(...c.found);
    }
    const out = SaltCore.editLocation(text, { replace, add });
    return out.length <= 500 ? out : text;  // the server's per-field limit
};

// The orange Check tag on a logged report: settle it the same way, saved as
// an Update (the old Location goes to its history).
const fixReportLocation = async (id) => {
    if (isReadOnly) return;
    const r = localReports.find(x => x.id === id && !x.deleted);
    if (!r) return;
    const loc = await settleLocation(r.location);
    if (loc === null || loc === r.location) return;
    const now = nextStamp(r);
    const hist = [...(r.history || []), { size: r.size || '', activity: r.activity || '', location: r.location || '', time: r.time,
        yourAnalysis: r.yourAnalysis || '', custom: r.custom || {}, user: r.user, lastModified: r.lastModified }];
    const next = { ...r, location: loc, history: hist, updated: true, lastModified: now, user: userProfile };
    localReports = localReports.map(x => x === r ? next : x);
    reportsByAto[activeAto] = localReports;
    showToast(`${formatFullId(next)} updated: ${loc}`);
    await saveLocalAndSync(reportsByAto);
};

const resetForm = () => {
    el.form.root.reset();
    el.form.reportId.value = '';
    el.form.title.textContent = 'New Report';
    el.form.editingNote.hidden = true;
    el.form.logBtn.textContent = 'Log New Report';
    el.form.logBtn.style.display  = '';
    el.form.editPair.style.display = 'none';
    // Cancel slot is reserved via visibility (not display) so the form
    // doesn't reflow when entering/exiting edit mode.
    el.form.cancelBtn.style.visibility = 'hidden';
    el.form.nowBtn.disabled = true;
    el.form.startNum.value = '';
    // The reset empties every box in the form, MGRS Lock's zone and square too.
    const lockBox = document.getElementById('mgrsPrefix');
    if (lockBox) lockBox.value = mgrsLockPrefix;
    document.querySelectorAll('.selected-row').forEach(r => r.classList.remove('selected-row'));
    renderLocationHints();
};

const loadReportForEditing = (reportId) => {
    if (isReadOnly) return;
    const report = localReports.find(r => r.id === reportId);
    if (!report) return;
    document.querySelectorAll('.selected-row').forEach(r => r.classList.remove('selected-row'));
    const rowEl = [...el.log.body.rows].find(tr => tr.dataset.id === report.id);
    if (rowEl) rowEl.classList.add('selected-row');
    // The short ID always fits; the full identifier and what the report says go
    // on the line below, cut to fit, whole on hover.
    el.form.title.textContent = `Updating ${report.displayId || formatFullId(report)}`;
    const note = [formatFullId(report), report.size, report.activity].filter(Boolean).join(' · ');
    el.form.editingNote.textContent = note;
    el.form.editingNote.title = note;
    el.form.editingNote.hidden = false;
    el.form.reportId.value    = report.id;
    el.form.startNum.value = reportNum(report) || 1;
    el.form.size.value     = report.size;
    el.form.activity.value = report.activity;
    el.form.location.value = report.location;
    renderLocationHints();
    el.form.analysis.value = report.yourAnalysis || '';
    document.querySelectorAll('#salt-fields [data-custom-label]').forEach(i => { i.value = (report.custom || {})[i.dataset.customLabel] || ''; });
    el.form.time.value = clockValue(new Date(report.time), timeDisplayMode === 'local');
    // Swap the single "Log New Report" submit for the Edit / Update pair.
    el.form.logBtn.style.display   = 'none';
    el.form.editPair.style.display = 'flex';
    // Make the always-reserved Cancel button slot actually visible now.
    el.form.cancelBtn.style.visibility = 'visible';
    el.form.nowBtn.disabled        = false;
};

// Drop refused changes for the given report ids in the active workspace.
// The server's copy, if it ever had one, comes back with the next sync.
const discardUnsaved = (ids, { confirm = true } = {}) => {
    const entries = unsaved[activeAto] || {};
    const reps = ids.map(id => localReports.find(r => r.id === id)).filter(r => r && unsavedEntry(activeAto, r));
    if (!reps.length) return;
    const run = () => {
        reps.forEach(r => {
            const k = SaltCore.reportKey(r);
            delete entries[k];
            // Never saved: there's no server copy to come back, so remove it here.
            if (!(serverVersions[activeAto] || {})[k]) localReports = localReports.filter(x => x !== r);
        });
        saveUnsaved();
        reportsByAto[activeAto] = localReports;
        saveReportsByAtoToLocal();
        renderLog();
        showToast(reps.length === 1 ? `Unsaved change to ${formatFullId(reps[0])} discarded.` : `${reps.length} unsaved changes discarded.`);
        syncWithServer();
    };
    if (!confirm) { run(); return; }
    showConfirmation(reps.length === 1
        ? `Discard your unsaved change to ${formatFullId(reps[0])}? The server's copy, if there is one, comes back.`
        : `Discard ${reps.length} unsaved changes?`, run);
};

// --- Undo ---
// Delete and Restore offer an Undo button for a few seconds. Undo works on
// the workspace it came from by report id, because a sync in the meantime
// may have replaced the report objects (the server keeps soft-deleted
// reports, so they are still there to find), and pushes with a new
// lastModified so the server takes the restored copy.
const pushUndone = async (ato, list) => {
    if (ato === activeAto) { localReports = list; await saveLocalAndSync(reportsByAto); }
    else { saveReportsByAtoToLocal(); renderLog(); await pushWorkspace(ato, list); }
};

// `undone` is what a Delete removed: soft-deleted ids, and history entries by report id.
async function undoDeletion(ato, undone) {
    const list = reportsByAto[ato];
    if (!list) { showToast('That workspace is no longer loaded.', true); return; }
    let restored = 0;
    list.forEach(r => {
        let touched = false;
        if (undone.ids.includes(r.id) && r.deleted) { delete r.deleted; touched = true; }
        const entries = undone.history[r.id];
        if (entries) {
            const have = new Set((r.history || []).map(h => h.lastModified));
            const back = entries.filter(h => !have.has(h.lastModified));
            if (back.length) {
                r.history = [...(r.history || []), ...back].sort((a, b) => a.lastModified - b.lastModified);
                r.updated = true;
                touched = true;
            }
        }
        if (touched) { r.lastModified = nextStamp(r); restored++; }
    });
    if (!restored) { showToast('Nothing left to put back.', true); return; }
    await pushUndone(ato, list);
    showToast(`${restored} item(s) put back.`);
}

// `before` is the report as it was before a Restore.
async function undoRestore(ato, before) {
    const list = reportsByAto[ato];
    const r = list && list.find(x => x.id === before.id);
    if (!r) { showToast('That report is no longer here.', true); return; }
    const stamp = nextStamp(r);
    Object.keys(r).forEach(k => { if (!(k in before)) delete r[k]; });
    Object.assign(r, before, { lastModified: stamp });
    await pushUndone(ato, list);
    showToast(`${formatFullId(r)} is back as it was.`);
}

// DESTRUCTIVE rollback: chosen history version becomes current; current
// state and everything newer-than-chosen are discarded. Older history stays.
const restoreHistoryVersion = (reportId, lastModified) => {
    if (isReadOnly) { showToast('View-only mode. Restore is disabled here.', true); return; }
    const report = localReports.find(r => r.id === reportId);
    if (!report || !report.history) return;
    const snapshot = report.history.find(h => h.lastModified === lastModified);
    if (!snapshot) return;
    // Count what we're about to drop so the confirmation prompt is honest.
    const newerCount = report.history.filter(h => h.lastModified > snapshot.lastModified).length;
    const dropMsg    = newerCount > 0
        ? ` This will discard the current version and ${newerCount} newer update${newerCount === 1 ? '' : 's'}.`
        : ' This will discard the current version.';
    showConfirmation(`Restore this version as current for ${formatFullId(report)}?${dropMsg}`, async () => {
        const ato = activeAto;
        const before = JSON.parse(JSON.stringify(report));
        const now = nextStamp(report);
        // Drop the chosen snapshot and everything newer; keep strictly older.
        report.history = (report.history || []).filter(h => h.lastModified < snapshot.lastModified);
        report.size         = snapshot.size;
        report.activity     = snapshot.activity;
        report.location     = snapshot.location;
        report.time         = snapshot.time;
        report.yourAnalysis = snapshot.yourAnalysis;
        // Snapshots taken before custom fields existed have no `custom`; keep
        // the current values rather than wiping them.
        if ('custom' in snapshot) report.custom = { ...snapshot.custom };
        report.updated      = report.history.length > 0;
        report.lastModified = now;
        // Attribute the restore to the operator who performed it.
        if (userProfile) report.user = userProfile;
        reportsByAto[activeAto] = localReports;
        await saveLocalAndSync(reportsByAto);
        showToast(`${formatFullId(report)} restored.`, false, { ms: UNDO_MS, undo: () => undoRestore(ato, before) });
    });
};

const setAtoState = (isSet) => {
    el.config.ato.readOnly   = isSet;
    el.config.title.readOnly = isSet;
    el.config.setBtn.textContent = isSet ? 'Change' : 'Set';
    el.config.setBtn.classList.toggle('change-btn', isSet);
    el.config.setBtn.classList.toggle('set-btn', !isSet);
    if (!isSet) populateAtoHistory(); else el.config.history.disabled = true;
};

const setProfileFromLocalStorage = () => {
    const saved = readStored('salt_user_profile_local', null);
    if (saved) { userProfile = saved; el.profile.initials.value = userProfile.initials; el.profile.color.value = userProfile.color; selectSwatch(userProfile.color); updateProfilePreview(); }
};

const selectSwatch = (color) => document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));

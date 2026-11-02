// SPDX-License-Identifier: AGPL-3.0-only

// Missions: Done with Mission, a page finding the team has finished its
// mission, the finished ones (Previous Missions) with Recall Settings and
// Load, and Refresh (backups dropped in the server's folder). The server moves a finished mission into Mission Archives and
// starts the next with nothing but the basemaps; each browser starts again
// too (the start of app/10-state.js), its preferences put by for Recall.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// Reloading for a new mission: nothing is left to ask about on the way out.
let missionReloading = false;
// Start this browser on the mission `id`: the page is loaded again, and its
// first step begins the mission (see the start of app/10-state.js). `note`
// is said once it has. With storage too full to keep that, the reports' copy
// goes (the server has them, what it doesn't was offered as a file, and the
// new mission clears the copy anyway) and it is tried again. Failing still,
// the page stays as it is and says why: loaded again, it would still be on
// the finished mission, find it finished, and load again, for ever. True
// when the page is loading again.
const startNewMission = (id, note = '') => {
    const next = JSON.stringify({ id, note });
    let kept = writeStored('salt_mission_next', next);
    if (!kept) {
        removeStored('salt_reports_by_ato');
        lastSavedReportsJson = '';
        kept = writeStored('salt_mission_next', next);
    }
    if (!kept) {
        // Nothing more from the finished mission until the page is loaded again.
        missionLeaving = true;
        // After the storage warning writeStored may have put off till now.
        setTimeout(() => showToast("This browser can't start the new mission: its storage is full or blocked. Free some space for this site in the browser's settings (or allow it storage), then reload the page.", true, { ms: 20000 }), 0);
        return false;
    }
    missionReloading = true;
    location.reload();
    return true;
};

// The reports this browser has that the server doesn't: changed since the
// last pull and not yet sent, or refused. Null when that can't be told
// (right after a reload, before the first pull: SaltCore.unsentTally). After
// a pull, a workspace the server didn't have has none of its reports there.
const unsentCount = () => {
    const atos = [...new Set([...pendingAtos, ...(offlinePendingPush && activeAto ? [activeAto] : [])])];
    const waiting = Object.fromEntries(atos.map(ato => [ato, (ato === activeAto ? localReports : reportsByAto[ato]) || []]));
    const known = Object.fromEntries(atos.map(ato => [ato, serverVersions[ato] || (serverVersionsPulled ? {} : null)]));
    const refused = Object.fromEntries(Object.entries(unsaved).map(([ato, entries]) => [ato, Object.keys(entries || {})]));
    return SaltCore.unsentTally(waiting, known, refused);
};

// Every workspace this browser holds, as one backup file Import reads,
// named `what`_Title_time.txt. False when there is nothing to save.
const downloadEverything = (what) => {
    const all = { ...reportsByAto };
    if (activeAto) all[activeAto] = localReports;
    Object.entries(unsaved).forEach(([ato, entries]) => {
        const list = Object.values(entries).map(e => e.report);
        if (list.length) all[ato] = SaltCore.withUnsaved(all[ato] || [], list).reports;
    });
    const atos = Object.keys(all).filter(a => (all[a] || []).length);
    if (!atos.length) return false;
    const title = localConfig.title || serverConfig?.title || 'SALT';
    triggerDownload(`${what}_${SaltCore.safeFilename(title)}_${fileStamp(new Date(), false)}.txt`,
        generateAllAtosBackupText(Object.fromEntries(atos.map(a => [a, all[a]])), activeAto || '', title, localProfiles));
    return true;
};

// The team has finished the mission this browser was on (a sync or a
// refused write said so). What it never got to send is offered as a file
// first: the server is on the next mission now, and won't take it.
let missionLeaving = false;
async function leaveFinishedMission(id) {
    if (missionLeaving) return;
    missionLeaving = true;
    const waiting = isReadOnly ? 0 : unsentCount();
    let saved = false;
    // How many isn't known (no pull yet since a reload): asked all the same.
    if (waiting !== 0) {
        const pick = await askChoice('The team has finished the mission.',
            `This browser has ${waiting === null ? 'reports' : plural(waiting, 'report')} the server ${waiting === null ? 'may never have got' : 'never got'}. Save them to a file before the new mission starts? Import can read it.`,
            [{ label: 'Save to a file', value: 'save', primary: true }, { label: "Don't save them", value: 'drop' }]);
        // Cancel keeps them too: they go nowhere else.
        if (pick !== 'drop') saved = downloadEverything('Unsent');
    }
    startNewMission(id, `The team finished the mission, so this browser has started the new one${saved ? ' (your unsent reports were saved to a file)' : ''}.`
        + `${isReadOnly ? '' : ' Previous Missions, in Manage > Workspaces, brings back settings and workspaces.'}`);
}

// --- Done with Mission ---
const finishMission = async () => {
    if (isReadOnly) { showToast('View-only mode. Done with Mission is disabled here.', true); return; }
    const body = document.createElement('div');
    body.innerHTML = `<ul class="mission-effects">
        <li>A backup of every workspace is saved to this computer.</li>
        ${isLocalFile ? '' : '<li>The server moves everything it saved into <strong>Mission Archives</strong>: nothing is deleted.</li>'}
        <li>Every workspace, overlay, tag and drone, the narrative settings, the report format, FMV mode and the operators' initials are cleared${isLocalFile ? '' : ' for everyone'}. The basemaps stay.</li>
        <li>${isLocalFile ? 'This browser starts' : 'Every browser starts'} again, its preferences put by. <strong>Previous Missions</strong> brings back settings and workspaces.</li>
    </ul>
    <label class="mission-type"><span>Type <strong>DONE</strong> to go ahead</span> <input type="text" autocomplete="off" spellcheck="false" maxlength="10"></label>`;
    const input = body.querySelector('input');
    const answer = askChoice('Done with Mission?', '', [{ label: 'Back up and start a new mission', value: 'go', primary: true, disabled: true }], body);
    const go = document.querySelector('#choiceButtons .choice-primary');
    input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== 'DONE'; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); } });
    if (await answer !== 'go') return;
    const saved = downloadEverything('Mission');
    if (isLocalFile) {
        startNewMission(`local-${Date.now()}`, `Mission finished${saved ? '; its backup was saved to this computer' : ''}. Set the new mission's workspace to begin.`);
        return;
    }
    const res = await apiPost('/api/finish_mission', { confirm: 'DONE' });
    if (!res.ok) {
        if (res.status !== 401) showToast(`Not finished: ${res.message}${saved ? ' The backup saved to this computer is complete.' : ''}`, true);
        return;
    }
    startNewMission(res.body.mission, `Mission finished. Everything is in Mission Archives\\${res.body.archive} on the server${saved ? ', and a backup was saved to this computer' : ''}.`);
};

// --- Previous Missions ---
let missionsKnown = [];
// The finished missions, from the server, newest first; drawn when they come.
async function loadMissions() {
    if (isReadOnly || isLocalFile) { renderMissions(); return; }
    try {
        const res = await fetch('/api/missions');
        if (res.status === 401) { handleUnauthorized(); return; }
        // A server from before missions answers 404: none.
        const json = res.ok ? await res.json() : null;
        missionsKnown = json && Array.isArray(json.missions) ? json.missions.filter(m => m && typeof m.name === 'string') : [];
    } catch (e) { /* unreachable: the list stays as it was */ }
    renderMissions();
}

const RECALL_LABELS = {
    overlays: (n) => `Overlays (${n})`, tags: (n) => `Tags (${n})`, drones: (n) => `Drones (${n})`,
    profiles: (n) => `Operators' initials and colors (${n})`, format: () => 'Report format (Builder)',
    narrative: () => 'Narrative settings', fmv: () => 'FMV mode',
};
const missionWhen = (m) => {
    const t = Date.parse(m.finished);
    return Number.isFinite(t) ? SaltCore.dtg(t, timeDisplayMode === 'local') : '';
};
const renderMissions = () => {
    const block = document.getElementById('missionsBlock'), list = document.getElementById('missionsList');
    if (!block || !list) return;
    const mine = readStored('salt_prefs_before', null);
    const rows = missionsKnown.map(m => {
        const ws = Object.entries(m.workspaces || {});
        const reports = ws.reduce((n, [, c]) => n + (Number(c) || 0), 0);
        const sub = [ws.length ? ws.map(([a]) => a).join(', ') : 'no workspaces', plural(reports, 'report'),
            missionWhen(m) && `finished ${missionWhen(m)}`, m.by && `by ${m.by}`].filter(Boolean).join(' · ');
        return `<div class="mission-row">
            <div class="mission-row-id"><span class="mission-row-name">${escapeHtml(m.name)}</span><span class="mission-row-sub">${escapeHtml(sub)}</span></div>
            <button type="button" class="mission-btn" data-mission-recall="${escapeHtml(m.name)}">Recall Settings</button>
            <button type="button" class="mission-btn" data-mission-load="${escapeHtml(m.name)}"${ws.length ? '' : ' disabled'}>Load</button>
        </div>`;
    });
    // Without a server (or before any mission has finished on it), only this
    // browser's own preferences can come back.
    if (!rows.length && mine) {
        rows.push(`<div class="mission-row"><div class="mission-row-id"><span class="mission-row-name">Your preferences from before the last mission</span>`
            + `<span class="mission-row-sub">Display settings and your initials, in this browser</span></div>`
            + `<button type="button" class="mission-btn" data-mission-prefs>Recall</button></div>`);
    }
    block.hidden = !rows.length;
    const html = rows.join('');
    if (workspacesDrawn.get(list) !== html) { list.innerHTML = html; workspacesDrawn.set(list, html); }
};

const tickBox = (attrs, label, on = true, enabled = true) =>
    `<label class="mission-tick${enabled ? '' : ' off'}"><input type="checkbox" ${attrs}${on && enabled ? ' checked' : ''}${enabled ? '' : ' disabled'}> ${escapeHtml(label)}</label>`;

// This browser's preferences and initials as they were before the last
// mission began; the page loads again with them.
const recallPrefs = () => {
    const mine = readStored('salt_prefs_before', null);
    if (!mine || typeof mine !== 'object') return;
    Object.entries(mine).forEach(([k, v]) => { if (k.startsWith('salt_') && typeof v === 'string') writeStored(k, v); });
    writeStored('salt_mission_note', 'Your preferences from before the mission are back.');
    missionReloading = true;
    location.reload();
};

const recallFrom = async (m) => {
    const s = m.settings || {};
    const mine = readStored('salt_prefs_before', null);
    const body = document.createElement('div');
    body.className = 'mission-ticks';
    body.innerHTML = Object.entries(RECALL_LABELS).map(([part, label]) => {
        const n = Number(s[part]) || 0;
        return tickBox(`data-part="${part}"`, n ? label(n) : `${label(0).replace(/ \(0\)$/, '')} (none)`, true, n > 0);
    }).join('') + (mine ? tickBox('data-prefs', 'My display preferences and initials (this browser only)', false) : '');
    const answer = await askChoice(`Recall settings from ${m.name}?`,
        'Overlays, tags, drones and initials are added to what there is now (one of the same name is replaced). The report format, narrative settings and FMV mode replace what there is.',
        [{ label: 'Recall', value: 'go', primary: true }], body);
    if (answer !== 'go') return;
    const parts = [...body.querySelectorAll('input[data-part]:checked')].map(i => i.dataset.part);
    const prefs = !!body.querySelector('input[data-prefs]:checked');
    if (parts.length) {
        const res = await apiPost('/api/recall_settings', { mission: m.name, parts });
        if (!res.ok) { if (res.status !== 401) showToast(`Not recalled: ${res.message}`, true); return; }
        const taken = Array.isArray(res.body.taken) ? res.body.taken : [];
        const words = { overlays: 'overlays', tags: 'tags', drones: 'drones', profiles: 'initials', format: 'report format', narrative: 'narrative settings', fmv: 'FMV mode' };
        if (!prefs) showToast(taken.length ? `Recalled the ${wordsAnd(taken.map(p => words[p]))} from ${m.name}.` : 'Nothing changed: those settings are already as they were.');
    }
    if (prefs) recallPrefs();
};

const loadFrom = async (m) => {
    const ws = Object.entries(m.workspaces || {});
    if (!ws.length) return;
    const body = document.createElement('div');
    body.className = 'mission-ticks';
    body.innerHTML = ws.map(([ato, n]) => tickBox(`data-ato="${escapeHtml(ato)}"`, `${ato} (${plural(Number(n) || 0, 'report')})`)).join('');
    const answer = await askChoice(`Load workspaces from ${m.name}?`,
        'They join this mission for everyone and are saved with it. A report in both keeps its newer version.',
        [{ label: 'Load', value: 'go', primary: true }], body);
    if (answer !== 'go') return;
    const atos = [...body.querySelectorAll('input[data-ato]:checked')].map(i => i.dataset.ato);
    if (!atos.length) return;
    const res = await apiPost('/api/load_mission', { mission: m.name, atos });
    if (!res.ok) { if (res.status !== 401) showToast(`Not loaded: ${res.message}`, true); return; }
    showToast(`Loaded ${wordsAnd(Object.keys(res.body.loaded || {}))} from ${m.name}.`);
};

// --- Refresh ---
// The server reads the backups put in its folder since it started (or
// changed by hand since it last read or wrote them), and the finished
// missions are listed again.
const refreshBackups = async () => {
    if (isReadOnly || isLocalFile) return;
    const res = await apiPost('/api/refresh', {});
    loadMissions();
    if (!res.ok) { if (res.status !== 401) showToast(`Not refreshed: ${res.message}`, true); return; }
    const found = res.body.workspaces && typeof res.body.workspaces === 'object' ? res.body.workspaces : {};
    const files = Array.isArray(res.body.files) ? res.body.files.length : 0, skipped = Number(res.body.skipped) || 0;
    const said = Object.keys(found).sort().map(ato => (found[ato].added ? `${ato} added` : `${ato} ${plural(Number(found[ato].changes) || 0, 'report')} new or changed`));
    const bad = skipped ? `; ${plural(skipped, 'file')} couldn't be read (the server's window names ${skipped === 1 ? 'it' : 'them'})` : '';
    showToast(said.length ? `Refresh: ${plural(files, 'file')} read; ${wordsAnd(said)}${bad}.` : `Refresh: nothing new in the backup folder${bad}.`, skipped > 0);
};

// "A, B and C".
const wordsAnd = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

document.getElementById('finishMissionBtn').addEventListener('click', finishMission);
document.getElementById('refreshBackupsBtn').addEventListener('click', refreshBackups);
document.getElementById('missionsList').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-mission-prefs')) { recallPrefs(); return; }
    const m = missionsKnown.find(x => x.name === (b.dataset.missionRecall ?? b.dataset.missionLoad));
    if (!m) return;
    if (b.dataset.missionRecall !== undefined) recallFrom(m);
    else loadFrom(m);
});

// Said once, after the page loaded again for a new mission (or recalled
// preferences).
const missionNote = readRaw('salt_mission_note', '');
if (missionNote) {
    removeStored('salt_mission_note');
    setTimeout(() => showToast(missionNote, false, { ms: 10000 }), 800);
}

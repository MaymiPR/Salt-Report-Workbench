// SPDX-License-Identifier: AGPL-3.0-only

document.addEventListener('DOMContentLoaded', () => {

// --- 1. Elements (cached at startup; namespaced by panel) ---
const el = {
    form: {
        root:      document.getElementById('saltForm'),
        reportId:  document.getElementById('reportId'),
        title:     document.getElementById('form-title'),
        logBtn:    document.getElementById('logButton'),
        editBtn:   document.getElementById('editButton'),
        updateBtn: document.getElementById('updateButton'),
        editPair:  document.getElementById('editUpdatePair'),
        cancelBtn: document.getElementById('cancelButton'),
        size:      document.getElementById('size'),
        activity:  document.getElementById('activity'),
        location:  document.getElementById('location'),
        time:      document.getElementById('time'),
        analysis:  document.getElementById('yourAnalysis'),
        nowBtn:    document.getElementById('updateTimeBtn'),
        startNum:  document.getElementById('reportStartNum'),
    },
    config: {
        ato:     document.getElementById('atoDesignator'),
        title:   document.getElementById('reportTitlePrefix'),
        setBtn:  document.getElementById('setAtoBtn'),
        history: document.getElementById('atoHistorySelect'),
    },
    log: {
        body:        document.getElementById('reportLogBody'),
        count:       document.getElementById('report-count'),
        totalCount:  document.getElementById('report-total-count'),
        search:      document.getElementById('searchBar'),
        timeHeader:  document.getElementById('time-header'),
        deleteBtn:   document.getElementById('deleteSelectedBtn'),
        sendSelect:  document.getElementById('sendToAtoSelect'),
        sendBtn:     document.getElementById('sendToAtoBtn'),
        selectAll:   document.getElementById('selectAllBtn'),
        deselectAll: document.getElementById('deselectAllBtn'),
        view:        document.getElementById('logView'),
        sortIdTh:    document.getElementById('sort-id-th'),
        sortTimeTh:  document.getElementById('sort-time-th'),
        sortIdIcon:  document.getElementById('sort-id-icon'),
        sortTimeIcon:document.getElementById('sort-time-icon'),
    },
    status: {
        dot:          document.getElementById('status-dot'),
        dotExp:       document.getElementById('status-dot-export'),
        userCount:    document.getElementById('connected-users-count'),
        userCountExp: document.getElementById('connected-users-count-export'),
    },
    // Identity form, plus the display-only access-code row with Copy button.
    profile: {
        menu:        document.getElementById('userProfileMenu'),
        initials:    document.getElementById('user-initials-input'),
        color:       document.getElementById('user-color-input'),
        setBtn:      document.getElementById('set-profile-btn'),
        avatar:      document.getElementById('profile-preview-avatar'),
        name:        document.getElementById('profile-preview-name'),
        accessCode:  document.getElementById('identityAccessCode'),
        accessCopy:  document.getElementById('identityAccessCopyBtn'),
    },
    manual: {
        modal:    document.getElementById('manualModal'),
        openBtn:  document.getElementById('userManualBtn'),
        closeBtn: document.getElementById('manualCloseBtn'),
    },
    menu: {
        btn:       document.getElementById('dataMgmtBtn'),
        panel:     document.getElementById('dataMgmtMenu'),
        layoutBtn: document.getElementById('toggleLayoutBtn'),
        timeBtn:   document.getElementById('toggleTimeFormatBtn'),
        sepBtn:    document.getElementById('toggleSepBtn'),
        bdaBtn:    document.getElementById('toggleBdaBtn'),
        exportBtn: document.getElementById('exportViewToggleBtn'),
        clearBtn:  document.getElementById('clearAllBtn'),
    },
    layout: { grid: document.getElementById('mainGrid') },
    toast: {
        regular:    document.getElementById('toast-notification'),
        confirm:    document.getElementById('confirmation-toast'),
        confirmBtn: document.getElementById('confirmActionBtn'),
        cancelBtn:  document.getElementById('cancelActionBtn'),
        message:    document.getElementById('confirmation-message'),
    },
    imp: {
        backupBtn:   document.getElementById('importBackupBtnTrigger'),
        backupInput: document.getElementById('importBackupFileInput'),
        csvBtn:      document.getElementById('importCsvBtnTrigger'),
        csvInput:    document.getElementById('importCsvFileInput'),
    },
    exp: {
        panel:       document.getElementById('exportPanel'),
        fromDate:    document.getElementById('export-from-date'),
        fromTime:    document.getElementById('export-from-time'),
        toDate:      document.getElementById('export-to-date'),
        toTime:      document.getElementById('export-to-time'),
        fromMode:    document.getElementById('export-from-mode'),
        toMode:      document.getElementById('export-to-mode'),
        clearBtn:    document.getElementById('exportClearFilterBtn'),
        subtitle:    document.getElementById('export-panel-subtitle'),
        filterCount: document.getElementById('export-filter-count'),
        mtiToggle:      document.getElementById('exportMtiToggle'),
        allAtosToggle:  document.getElementById('exportAllAtosToggle'),
    },
    // Workspaces panel: tab strip + Loaded-Workspaces list (in two
    // containers — the panel's tab and the viewer-mode sidebar).
    workspaces: {
        list:        document.getElementById('workspacesList'),
        sidebarList: document.getElementById('workspacesSidebarList'),
        tabs:        document.querySelectorAll('#exportPanel .ws-tab'),
        tabPanels:   document.querySelectorAll('#exportPanel .ws-tab-panel'),
    },
    csv: {
        panel:       document.getElementById('csvImportPanel'),
        subtitle:    document.getElementById('csvImportSubtitle'),
        colList:     document.getElementById('csvColList'),
        mapTitle:    document.getElementById('csvMapTitle'),
        mapSize:     document.getElementById('csvMapSize'),
        mapActivity: document.getElementById('csvMapActivity'),
        mapLocation: document.getElementById('csvMapLocation'),
        mapTime:     document.getElementById('csvMapTime'),
        destSelect:  document.getElementById('csvDestSelect'),
        cancelBtn:   document.getElementById('csvCancelBtn'),
        confirmBtn:  document.getElementById('csvConfirmBtn'),
        closeBtn:    document.getElementById('closeCsvImportBtn'),
    },
    startup: {
        overlay:     document.getElementById('startupModal'),
        avatar:      document.getElementById('startup-preview-avatar'),
        initials:    document.getElementById('startup-initials'),
        color:       document.getElementById('startup-color'),
        swatches:    document.getElementById('startup-color-swatches'),
        ato:         document.getElementById('startup-ato'),
        title:       document.getElementById('startup-title'),
        accessCode:  document.getElementById('startup-access-code'),
        accessError: document.getElementById('startup-access-error'),
        continueBtn: document.getElementById('startupContinueBtn'),
        presets:     document.getElementById('startup-presets'),
    },
};

// --- 2. State ---
// Parse a JSON value from localStorage. A missing or corrupt entry yields the
// fallback rather than stopping the app at startup.
const readStored = (key, fallback) => {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) ?? fallback);
    } catch (e) {
        return fallback;
    }
};
// Write to localStorage. Storage can be full (a long operation's reports and
// history, cached in every browser) or blocked. The app works from memory
// either way, so a failure is reported once instead of thrown into whatever
// was running; before this, a full store silently took the client offline.
let storageWarned = false;
const writeStored = (key, value) => {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        if (!storageWarned) {
            storageWarned = true;
            // Deferred: the first writes run before the toast exists.
            setTimeout(() => showToast('Browser storage is full. This tab keeps working, but it can\'t save its offline copy or settings until space is freed.', true), 0);
        }
        return false;
    }
};
// Viewers keep no copy of the reports. The page comes from the server, so a
// cached copy is useless without it, and it would leave every report at rest
// on a machine that only watches. Whatever an earlier version left is cleared.
const viewerAtLoad = document.body.classList.contains('read-only');
if (viewerAtLoad) ['salt_reports_by_ato', 'salt_unsaved'].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
let reportsByAto  = viewerAtLoad ? {} : readStored('salt_reports_by_ato', {});
let activeAto     = null;
// Viewer-only: the workspace the viewer has clicked to look at locally.
// `activeAto` always tracks the server's config.ato (the editor's choice);
// `viewerShowingAto` overrides which workspace's reports populate the log.
// When null or equal to activeAto, the viewer is following the editor.
let viewerShowingAto = null;
let localReports  = [];
// Mirror of the server's profile dict; embedded in backup exports so
// re-importing into a fresh deployment restores everyone's initials/color.
let localProfiles = {};
// Last synced profiles, so the startup modal can offer them before the first
// sync of a later session (or offline).
const _PROFILES_CACHE_KEY = 'salt_profiles_cache';
let localConfig   = readStored('salt_offline_config', { ato: '', title: '' });
let userProfile   = null;
// ato → source descriptor ("alpha01.txt" | "Uploaded backup" | "In-session").
let workspaceSources = {};
// Deduped initials list for the Workspaces panel (no IPs).
let connectedInitials = [];
// Editor-port access code: cached in localStorage + carried via cookie so
// fetch + EventSource include it automatically. Cleared on 401 → re-prompts.
let accessCode = '';
const _ACCESS_CODE_KEY      = 'salt_access_code';
const _ACCESS_COOKIE        = 'salt_access';
// Last code the user clicked Continue on. Used to force the modal on a fresh
// server session (meta code differs from confirmed → host re-reviews setup).
const _ACCESS_CONFIRMED_KEY = 'salt_access_confirmed';
let forceStartupModal = false;

const setAccessCookie = (code) => {
    document.cookie = `${_ACCESS_COOKIE}=${encodeURIComponent(code)}; path=/; samesite=strict`;
};
const clearAccessCookie = () => {
    document.cookie = `${_ACCESS_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
};
// Sync the read-only access-code row in the Identity tab.
const renderIdentityAccessCode = () => {
    el.profile.accessCode.textContent = accessCode || '—';
    el.profile.accessCopy.disabled = !accessCode;
};
const setAccessCode = (code) => {
    accessCode = (code || '').trim().toUpperCase();
    if (accessCode) {
        writeStored(_ACCESS_CODE_KEY, accessCode);
        setAccessCookie(accessCode);
    }
    renderIdentityAccessCode();
};
const clearAccessCode = () => {
    accessCode = '';
    localStorage.removeItem(_ACCESS_CODE_KEY);
    clearAccessCookie();
    renderIdentityAccessCode();
};

// Host auto-fill: server injects the code into a <meta> tag for localhost
// requests. Read it before any fetch so the cookie is set in time. If the
// meta code differs from what we last confirmed (fresh server session), force
// the startup modal so the host re-reviews identity/ATO/title.
(() => {
    const metaCode = (document.querySelector('meta[name="salt-access-code"]') || {}).content || '';
    if (metaCode) {
        setAccessCode(metaCode);
        if ((localStorage.getItem(_ACCESS_CONFIRMED_KEY) || '') !== metaCode) forceStartupModal = true;
    } else {
        const cached = localStorage.getItem(_ACCESS_CODE_KEY);
        if (cached) setAccessCode(cached);
    }
})();

// True for viewer port. Server stamps body.read-only on the HTML before any
// JS runs, so this is correct from first paint.
let isReadOnly = document.body.classList.contains('read-only');
// Local mode — page opened straight from disk (file://), no sync server.
// Access-code auth is meaningless here: the field is hidden and not required.
const isLocalFile = location.protocol === 'file:';
if (isLocalFile) document.body.classList.add('local-mode');
let currentSortMode  = localStorage.getItem('salt_sort_mode') || 'recent';
let timeDisplayMode  = localStorage.getItem('salt_time_mode')  || 'zulu';
// Separator between the ATO designator and the workspace title: 'dash' | 'space'.
let atoTitleSep      = localStorage.getItem('salt_ato_title_sep') || 'dash';

// --- Report format (builder) ---
// A format is an ordered list of lines, stored per-workspace and synced via
// the server so the whole team composes reports the same way.
// Built-in line types: id, size, activity, location, time, analysis.
// The `id` line renders as the header when first, or as a `U:` line when
// placed lower (SALT-U). Custom lines carry a label; their values live on
// each report under `custom: {label: value}`.
// Analysis is NOT in the presets — it's hidden by default and re-enabled
// per workspace from the Builder's add-back palette.
const FORMAT_PRESETS = {
    'salt':   [{type:'id'},{type:'size'},{type:'activity'},{type:'location'},{type:'time'}],
    'salt-u': [{type:'size'},{type:'activity'},{type:'location'},{type:'time'},{type:'id'}],
};
let workspaceFormats = readStored('salt_ws_formats', {});
// The last format this operator actually worked with. A workspace that has no
// format of its own adopts this, so Builder changes survive an ATO switch.
const _LAST_FORMAT_KEY = 'salt_last_format';
const defaultFormat  = () => ({ preset: 'salt', lines: FORMAT_PRESETS['salt'].map(l => ({...l})) });
const currentFormat  = () => {
    const f = activeAto && workspaceFormats[activeAto];
    return (f && Array.isArray(f.lines) && f.lines.length) ? f : defaultFormat();
};

// --- BDA mode ---
// Hidden until enabled from the ellipsis menu. Assessments live on each
// report under `bda: []` and sync like everything else.
let bdaMode = localStorage.getItem('salt_bda_mode') === 'on';
document.body.classList.toggle('bda-mode', bdaMode);
const openBdaRows = new Set();
const openHistoryRows = new Set();
let isExportViewActive = false;
let pendingCsv         = null; // { headers, rows, filename }
let offlinePendingPush = localStorage.getItem('salt_offline_push') === 'true';
// What the server holds, per workspace (report key -> lastModified), so a
// push sends only what changed. Refreshed on every pull; a workspace with no
// record yet (say, right after a reload) is pushed in full.
let serverVersions = {};
// Changes the server refused, per workspace (report key -> { report, reason }).
// Kept so nothing is lost: shown as "Not saved" until fixed or discarded.
let unsaved = readStored('salt_unsaved', {});
const saveUnsaved = () => { writeStored('salt_unsaved', JSON.stringify(unsaved)); };
const unsavedEntry = (ato, report) => ((unsaved[ato] || {})[SaltCore.reportKey(report)]) || null;

// Dedupe localStorage writes — skip if the JSON hasn't actually changed.
let lastSavedReportsJson = localStorage.getItem('salt_reports_by_ato') || '';
const saveReportsByAtoToLocal = () => {
    if (isReadOnly) return;
    const json = JSON.stringify(reportsByAto);
    // A write that fails is tried again on the next change, not forgotten.
    if (json !== lastSavedReportsJson && writeStored('salt_reports_by_ato', json)) {
        lastSavedReportsJson = json;
    }
};

// --- 3. Utilities (pure, no side-effects) ---

// Polyfill: crypto.randomUUID requires a secure context, which LAN HTTP isn't.
// Falls back to getRandomValues, then Math.random.
const generateUUID = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        try { return crypto.randomUUID(); } catch (e) {}
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; // RFC 4122 v4
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
};
// Pure helpers live in core.js (window.SaltCore) so the tests can reach them.
const { dateFields, clockValue, fileStamp, escapeHtml, safeColor,
        reportNum, normalizeLocation, BDA_EFFECTS, bdaElements, bdaSummary } = SaltCore;
const debounce    = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const toZuluTimeString  = (d) => SaltCore.toTimeString(d, false);
const toLocalTimeString = (d) => SaltCore.toTimeString(d, true);
// Format a typed "1430" in a time box as "14:30". Returns whether it changed.
const autoColonTime = (input) => {
    const v = SaltCore.autoColon(input.value);
    if (v === null) return false;
    input.value = v;
    return true;
};
const copyToClipboard = (text) => {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => {}); return; }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'; document.body.appendChild(ta); ta.focus(); ta.select(); try { document.execCommand('copy'); } catch(e){} ta.remove();
};
// POST a JSON body to the sync server. Resolves to the Response whatever its
// status; rejects only when the server can't be reached.
const postJson = (path, body) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const setupMenuToggle = (btn, menu) => btn.addEventListener('click', e => { e.stopPropagation(); menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; });

// --- 4. Notifications (toasts + confirmation dialog) ---
let toastTimer = null;
// `ms` is how long the toast stays; `undo` adds an Undo button that runs it.
const showToast = (msg, isErr = false, { ms = 4000, undo = null } = {}) => {
    el.toast.regular.textContent = msg;
    if (undo) {
        const btn = document.createElement('button');
        btn.className = 'toast-undo';
        btn.textContent = 'Undo';
        btn.addEventListener('click', () => { clearTimeout(toastTimer); el.toast.regular.classList.remove('show'); undo(); });
        el.toast.regular.appendChild(btn);
    }
    el.toast.regular.style.backgroundColor = isErr ? 'rgba(255,69,58,0.9)' : 'rgba(28,28,30,0.85)';
    el.toast.regular.classList.add('show');
    // Restart the clock, so an earlier toast's timer can't hide this one early.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.regular.classList.remove('show'), ms);
};
const UNDO_MS = 10000;
// One prompt at a time: a new prompt replaces an unanswered one and drops its
// action, so Confirm only ever runs what the dialog is showing.
let pendingConfirm = null;
const hideConfirmation = () => { el.toast.confirm.classList.remove('show'); pendingConfirm = null; };
const showConfirmation = (msg, onConfirm) => {
    el.toast.message.textContent = msg;
    pendingConfirm = onConfirm;
    el.toast.confirm.classList.add('show');
};
el.toast.confirmBtn.addEventListener('click', () => { const run = pendingConfirm; hideConfirmation(); if (run) run(); });
el.toast.cancelBtn .addEventListener('click', hideConfirmation);

// --- 5. Rendering ---

// Custom builder fields get their own table columns, appended after Analysis
// (same order the CSV export uses). Only the custom <th>s are added/removed —
// the fixed columns keep their identity and their sort-click bindings.
const customColumns = () => currentFormat().lines.filter(l => l.type === 'custom');

const syncCustomColumns = () => {
    const headRow = document.querySelector('#reportLogTable thead tr');
    if (!headRow) return;
    headRow.querySelectorAll('th.col-custom').forEach(th => th.remove());
    customColumns().forEach(l => {
        const th = document.createElement('th');
        th.className = 'col-custom';
        th.dataset.custom = l.label;
        // Header reads the descriptive name; the copy text uses the letter.
        th.textContent = l.name || l.label;
        th.title = `${l.name || l.label} — copies as ${l.label}:`;
        headRow.appendChild(th);
    });
};

// ─── BDA (Battle Damage Assessment) ──────────────────────────────────────
// Sub-row under a report (same pattern as history) listing assessments and
// an inline add-form. Target quick-picks are parsed from the report's own
// Size elements and Location grids.

const buildBdaRow = (report) => {
    const tr = document.createElement('tr');
    tr.className = 'bda-sub-row';
    const td = document.createElement('td');
    // Span whatever columns are actually showing — the count moves with custom
    // fields being added and Analysis being toggled off.
    td.colSpan = [...document.querySelectorAll('#reportLogTable thead th')]
                   .filter(th => getComputedStyle(th).display !== 'none').length || 8;
    const entries = (report.bda || []).map(b => {
        const eff = BDA_EFFECTS.find(e => e.name === b.effect) || BDA_EFFECTS[5];
        return `<div class="bda-entry" data-entry-lm="${escapeHtml(b.lastModified)}">
            <span class="bda-effect bda-eff-${eff.cls}" data-bda-editopen="${escapeHtml(report.id)}" title="Click to change the assessment">${escapeHtml(b.effect || 'Unknown')}</span>
            <span class="bda-target">${escapeHtml(b.target || '')}</span>
            ${b.coords ? `<span class="bda-coords">${escapeHtml(b.coords)}</span>` : ''}
            ${b.note ? `<span class="bda-note">${escapeHtml(b.note)}</span>` : ''}
            <span class="bda-meta">${escapeHtml(toZuluTimeString(b.time))}${b.user && b.user.initials ? ' · ' + escapeHtml(b.user.initials) : ''}</span>
            <button type="button" class="bda-del" data-bda-del="${escapeHtml(report.id)}" data-lm="${escapeHtml(b.lastModified)}" title="Delete assessment">&#10005;</button>
        </div>`;
    }).join('');
    // Checklist: one row per element from the report, already paired with its
    // grid. Elements that already have an assessment are dropped so the list
    // only ever shows what's still outstanding.
    const assessed = new Set((report.bda || []).map(b => (b.target || '').toLowerCase()));
    const pending  = bdaElements(report).filter(e => !assessed.has(e.target.toLowerCase()));
    const effBtns  = (i) => BDA_EFFECTS.map(e =>
        `<button type="button" class="bda-eff-btn bda-eff-${e.cls}" data-bda-eff="${e.name}" data-row="${i}" title="${e.name}">${e.key}</button>`).join('');
    const rows = pending.map((e, i) => `<div class="bda-check-row" data-row="${i}">
        <input type="text" class="bda-ck-target" value="${escapeHtml(e.target)}" maxlength="200" aria-label="Target">
        <input type="text" class="bda-ck-coords" value="${escapeHtml(e.coords)}" placeholder="Coords" maxlength="200" aria-label="Coords">
        <span class="bda-eff-group">${effBtns(i)}</span>
    </div>`).join('');
    td.innerHTML = `<div class="bda-wrap">
        ${entries ? `<div class="bda-list">${entries}</div>` : ''}
        <div class="bda-add">
            ${rows || `<div class="bda-empty">Every element in this report is assessed.</div>`}
            <div class="bda-add-foot">
                <button type="button" class="set-btn bda-commit-btn" data-bda-commit="${escapeHtml(report.id)}" disabled>Log Assessments</button>
            </div>
        </div>
    </div>`;
    tr.appendChild(td);
    return tr;
};

// Reflect staged picks in the commit button ("Log 3 Assessments" / disabled).
const refreshBdaCommit = (wrap) => {
    const n   = wrap.querySelectorAll('.bda-eff-btn.picked').length;
    const btn = wrap.querySelector('.bda-commit-btn');
    if (!btn) return;
    btn.disabled    = n === 0;
    btn.textContent = n ? `Log ${n} Assessment${n === 1 ? '' : 's'}` : 'Log Assessments';
};

// Commit every staged row in one mutation → a single sync push.
const commitBdaEntries = (reportId, wrap) => {
    if (isReadOnly) { showToast('View-only mode. BDA entry is disabled here.', true); return; }
    const report = localReports.find(r => r.id === reportId);
    if (!report) return;
    const now  = Date.now();
    const iso  = new Date().toISOString();
    const adds = [];
    wrap.querySelectorAll('.bda-check-row').forEach(row => {
        const picked = row.querySelector('.bda-eff-btn.picked');
        if (!picked) return;
        const target = row.querySelector('.bda-ck-target').value.trim();
        if (!target) return;
        adds.push({
            target,
            coords: row.querySelector('.bda-ck-coords').value.trim(),
            effect: picked.dataset.bdaEff,
            time: iso, user: userProfile || null,
            // Unique per entry so deletes target the right one.
            lastModified: now + adds.length,
        });
    });
    if (!adds.length) { showToast('Pick an effect for at least one element.', true); return; }
    report.bda = [...(report.bda || []), ...adds];
    report.lastModified = now;
    reportsByAto[activeAto] = localReports;
    saveLocalAndSync(reportsByAto);
    showToast(`${adds.length} assessment${adds.length === 1 ? '' : 's'} logged for ${formatFullId(report)}.`);
};

// Revise an existing assessment's effect (Damaged -> Destroyed, etc.).
// The entry's `lastModified` stays put as its identity; the assessment time
// and operator are re-stamped because the call itself is what changed.
const updateBdaEffect = (reportId, lm, effect) => {
    if (isReadOnly) { showToast('View-only mode. BDA entry is disabled here.', true); return; }
    const report = localReports.find(r => r.id === reportId);
    const entry  = (report && report.bda || []).find(b => b.lastModified === lm);
    if (!entry) return;
    if (entry.effect === effect) { renderLog(); return; }   // no-op, just close the editor
    const prev = entry.effect || 'Unknown';
    entry.effect = effect;
    entry.time   = new Date().toISOString();
    entry.user   = userProfile || null;
    report.lastModified = Date.now();
    reportsByAto[activeAto] = localReports;
    saveLocalAndSync(reportsByAto);
    showToast(`${entry.target || 'Assessment'}: ${prev} → ${effect}.`);
};

const deleteBdaEntry = (reportId, lm) => {
    if (isReadOnly) { showToast('View-only mode. BDA delete is disabled here.', true); return; }
    const report = localReports.find(r => r.id === reportId);
    if (!report || !report.bda) return;
    showConfirmation('Delete this BDA assessment?', () => {
        report.bda = report.bda.filter(b => b.lastModified !== lm);
        report.lastModified = Date.now();
        reportsByAto[activeAto] = localReports;
        saveLocalAndSync(reportsByAto);
        showToast('BDA assessment deleted.');
    });
};

// `filterText` defaults to the current search-bar value so every repaint
// preserves the active filter without the caller having to pass it.
const renderLog = (filterText = el.log.search.value.toLowerCase()) => {
    let rows = localReports.filter(r => !r.deleted);
    el.log.count.textContent = `${rows.length} unique reports`;
    // Total = each live report + its history entries. Deleted excluded.
    const totalReports = rows.reduce((sum, r) => sum + 1 + ((r.history && r.history.length) || 0), 0);
    el.log.totalCount.textContent = `${totalReports} total reports`;

    if (filterText) {
        const isDir = /^(n|ne|nw|s|se|sw|e|w)$/i.test(filterText.trim());
        if (isDir) {
            const rx = new RegExp(`\\b${filterText.trim()}\\b`, 'i');
            rows = rows.filter(r => rx.test(r.activity));
        } else {
            rows = rows.filter(r => {
                const ts  = (timeDisplayMode === 'local' ? toLocalTimeString : toZuluTimeString)(r.time);
                // Custom builder fields and BDA assessments are searchable too,
                // so "destroyed" or a weather note finds its report.
                const cus = Object.values(r.custom || {}).join(' ');
                const bda = (r.bda || []).map(b => `${b.effect||''} ${b.target||''} ${b.coords||''} ${b.note||''}`).join(' ');
                return `${r.fullId} ${r.displayId} ${r.size} ${r.activity} ${r.location} ${r.yourAnalysis||''} ${r.user?.initials||''} ${ts} ${cus} ${bda}`.toLowerCase().includes(filterText);
            });
        }
    }

    rows.sort((a, b) => {
        // ISO 8601 strings sort lexicographically the same as chronologically,
        // so we compare the raw `.time` strings instead of building a Date
        // object on every comparison (was 2 × Date() per sort step).
        if (currentSortMode === 'timeAsc')  return (a.time || '').localeCompare(b.time || '');
        if (currentSortMode === 'timeDesc') return (b.time || '').localeCompare(a.time || '');
        if (currentSortMode === 'recent')   return (b.lastModified||0) - (a.lastModified||0);
        const na = reportNum(a);
        const nb = reportNum(b);
        return currentSortMode === 'numAsc' ? na - nb : nb - na;
    });

    const timeFmt = timeDisplayMode === 'local' ? toLocalTimeString : toZuluTimeString;
    el.log.timeHeader.textContent = `Time ${timeDisplayMode === 'local' ? '(L)' : '(Z)'}`;

    // Dense free-text content (several MGRS grids, a long analysis) can wrap
    // into a very tall cell. Clamp to 2 lines; cells that actually overflow
    // get a click-to-expand affordance (marked post-render, see below).
    const clampCell = (text) => `<span class="cell-clamp" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;

    // Keep the header's custom columns in step with the format, then emit a
    // matching cell per row (works for history rows too, which carry their
    // own `custom` snapshot).
    syncCustomColumns();
    const cusCols  = customColumns();
    const cusCells = (obj) => cusCols.map(l =>
        `<td class="col-custom">${clampCell((obj || {})[l.label] || '')}</td>`).join('');

    // Build into a fragment — one reflow on attach instead of N.
    const frag = document.createDocumentFragment();

    rows.forEach(report => {
        const isOpen = openHistoryRows.has(report.id);
        const row    = document.createElement('tr');
        row.dataset.id = report.id;
        const histBtn = (report.history && report.history.length > 0)
            ? `<button class="history-btn ${isOpen ? 'open' : ''}" data-history-id="${escapeHtml(report.id)}" title="View past versions">&#8250;</button>`
            : `<button class="history-btn" style="visibility:hidden;" disabled>&#8250;</button>`;
        const refused     = isReadOnly ? null : unsavedEntry(activeAto, report);
        const statusText  = (report.updated || refused)
            ? `<span class="id-cell-wrap">${escapeHtml(formatFullId(report))}${report.updated ? '<span class="id-updated-badge">(Updated)</span>' : ''}${refused ? `<span class="unsaved-badge" title="${escapeHtml(refused.reason)}">Not saved</span>` : ''}</span>`
            : escapeHtml(formatFullId(report));
        const discardBtn  = refused ? `<button class="discard-btn" data-discard-id="${escapeHtml(report.id)}" title="Drop this unsaved change">Discard</button>` : '';
        // Use the user recorded on the report itself (avoids color collisions
        // when two operators share initials).
        const reporter    = report.user || null;
        const reporterHTML = reporter
            ? `<span class="reporter-text" style="color:${safeColor(reporter.color)};" title="Reported by ${escapeHtml(reporter.initials)}">${escapeHtml(reporter.initials)}</span>`
            : `<span class="reporter-text" style="color:var(--system-gray);" title="Unknown Reporter">?</span>`;
        // BDA controls exist only while BDA mode is on (ellipsis menu toggle).
        // The pill carries status: hollow when unassessed, `n/total` while
        // partial, solid and colored by worst outcome once complete.
        let bdaBtn = '';
        if (bdaMode) {
            const { done, total, worstCls } = bdaSummary(report);
            const state = done === 0            ? 'bda-none'
                        : (total && done < total) ? 'bda-partial'
                        : 'bda-full';
            const label = done === 0 ? 'BDA'
                        : (total && done < total) ? `BDA ${done}/${total}`
                        : `BDA ${done}`;
            const tip   = done === 0 ? 'No assessments yet'
                        : (total && done < total) ? `${done} of ${total} elements assessed`
                        : `All ${done} assessed`;
            bdaBtn = `<button class="bda-btn ${state}${worstCls ? ' bda-worst-' + worstCls : ''}${openBdaRows.has(report.id) ? ' open' : ''}" data-bda-id="${escapeHtml(report.id)}" title="${tip}">${label}</button>`;
        }
        row.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="row-selector" data-id="${escapeHtml(report.id)}" title="Select"> ${histBtn} <button class="copy-btn" data-id="${escapeHtml(report.id)}">Copy</button>${discardBtn}${bdaBtn}</div></td><td class="col-by reporter-col">${reporterHTML}</td><td class="col-id">${statusText}</td><td class="col-size">${clampCell(report.size)}</td><td class="col-activity">${clampCell(report.activity)}</td><td class="col-location">${clampCell(report.location)}</td><td class="col-time">${escapeHtml(timeFmt(report.time))}</td><td class="col-analysis">${clampCell(report.yourAnalysis)}</td>${cusCells(report.custom)}`;
        frag.appendChild(row);

        if (bdaMode && openBdaRows.has(report.id)) frag.appendChild(buildBdaRow(report));

        if (isOpen && report.history && report.history.length > 0) {
            [...report.history].sort((a,b) => b.lastModified - a.lastModified).forEach((h, i, arr) => {
                const hRow = document.createElement('tr');
                hRow.className = 'history-sub-row';
                const hRep  = h.user || null;
                const hHTML = hRep ? `<span style="color:${safeColor(hRep.color)};">${escapeHtml(hRep.initials)}</span>` : '?';
                hRow.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="history-selector" data-id="${escapeHtml(report.id)}" data-lm="${escapeHtml(h.lastModified)}" title="Select history entry"> <span class="hist-arrow">&#8618;</span> <button class="restore-btn" data-restore-id="${escapeHtml(report.id)}" data-lm="${escapeHtml(h.lastModified)}" title="Restore this version as current">Restore</button></div></td><td class="col-by reporter-col">${hHTML}</td><td class="col-id"><span class="id-cell-wrap">${escapeHtml(formatFullId(report))}<span class="id-updated-badge">(Update #${arr.length - i})</span></span></td><td class="col-size">${clampCell(h.size)}</td><td class="col-activity">${clampCell(h.activity)}</td><td class="col-location">${clampCell(h.location)}</td><td class="col-time">${escapeHtml(timeFmt(h.time))}</td><td class="col-analysis">${clampCell(h.yourAnalysis)}</td>${cusCells(h.custom)}`;
                frag.appendChild(hRow);
            });
        }
    });

    el.log.body.replaceChildren(frag);

    // Mark only the cells that actually overflow their 2-line clamp as
    // clickable (pointer + expand). One rAF pass, after layout settles.
    requestAnimationFrame(() => {
        el.log.body.querySelectorAll('.cell-clamp').forEach(c => {
            if (!c.classList.contains('expanded'))
                c.classList.toggle('clampable', c.scrollHeight > c.clientHeight + 1);
        });
    });
};

const loadConfig = () => {
    el.config.ato.value   = localConfig.ato   || '';
    el.config.title.value = localConfig.title || '';
    setAtoState(!!(localConfig.ato && localConfig.title));
    // A brand-new workspace inherits the format you were just using.
    ensureWorkspaceFormat();
    // Form field order follows the active workspace's format.
    applyFormFieldOrder();
};

const populateAtoHistory = () => {
    const others = Object.keys(reportsByAto).filter(k => k !== activeAto && (reportsByAto[k]||[]).some(r => !r.deleted));
    el.config.history.innerHTML = '<option value=""></option>';
    others.forEach(ato => {
        const rep = (reportsByAto[ato]||[]).find(r => r.title && !r.deleted);
        const opt = document.createElement('option');
        opt.value = ato; opt.textContent = ato; opt.dataset.title = rep ? rep.title : '';
        el.config.history.appendChild(opt);
    });
    // Locked until the Set button toggles into Change state.
    el.config.history.disabled = true;
};

const updateProfilePreview = () => {
    if (userProfile) { el.profile.avatar.textContent = userProfile.initials; el.profile.avatar.style.backgroundColor = userProfile.color; el.profile.name.textContent = userProfile.initials; }
    else { el.profile.avatar.textContent = '?'; el.profile.avatar.style.backgroundColor = ''; el.profile.name.textContent = 'Not Set'; }
};

const updateSortIcons = () => {
    el.log.sortIdIcon.textContent   = currentSortMode==='numAsc' ? '▲' : currentSortMode==='numDesc' ? '▼' : '⊙';
    el.log.sortTimeIcon.textContent = currentSortMode==='timeAsc' ? '▲' : currentSortMode==='timeDesc' ? '▼' : '⇅';
    el.log.sortIdIcon.classList.toggle('active',   ['numAsc','numDesc','recent'].includes(currentSortMode));
    el.log.sortTimeIcon.classList.toggle('active', ['timeAsc','timeDesc'].includes(currentSortMode));
};

const updateSelectionUI = () => {
    // Single DOM query for both checkbox kinds; partition by class.
    const checked = document.querySelectorAll('.row-selector:checked, .history-selector:checked');
    let nMain = 0;
    for (const cb of checked) {
        if (cb.classList.contains('row-selector')) nMain++;
    }
    const n = checked.length;
    el.log.deleteBtn.style.display = n > 0 ? 'inline-block' : 'none';
    if (activeAto === 'IMPORT' && nMain > 0) {
        const targets = Object.keys(reportsByAto).filter(k => k !== 'IMPORT' && (reportsByAto[k]||[]).some(r => !r.deleted));
        el.log.sendSelect.innerHTML = targets.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
        el.log.sendSelect.style.display = targets.length > 0 ? 'inline-block' : 'none';
        el.log.sendBtn.style.display    = targets.length > 0 ? 'inline-block' : 'none';
    } else {
        el.log.sendSelect.style.display = 'none';
        el.log.sendBtn.style.display    = 'none';
    }
};

const updateLayoutBtnText = () => { el.menu.layoutBtn.textContent = el.layout.grid.classList.contains('horizontal-layout') ? 'Vertical Layout' : 'Horizontal Layout'; };
const updateTimeBtnText   = () => { el.menu.timeBtn.textContent   = timeDisplayMode === 'zulu' ? 'Local Time' : 'Zulu Time'; };
// Label shows the option you switch TO (same convention as the time/layout buttons).
const updateSepBtnText    = () => { el.menu.sepBtn.textContent    = atoTitleSep === 'dash' ? 'Title Separator: Space' : 'Title Separator: Dash'; };
const updateBdaBtnText    = () => { el.menu.bdaBtn.textContent    = bdaMode ? 'Hide BDA' : 'Show BDA'; };
const applyLayoutMode     = () => { document.body.classList.toggle('scrollable-layout', el.layout.grid.classList.contains('horizontal-layout')); updateLayoutBtnText(); };

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
    const prevVals = {};
    fields.querySelectorAll('[data-custom-label]').forEach(i => { prevVals[i.dataset.customLabel] = i.value; });
    fields.querySelectorAll('.custom-input-group').forEach(n => n.remove());
    const fmt = currentFormat();
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
    // Analysis is format-controlled: hidden unless its line is in the format.
    const hasAnalysis = fmt.lines.some(l => l.type === 'analysis');
    const analysisBox = document.getElementById('analysis-field');
    if (analysisBox) analysisBox.style.display = hasAnalysis ? '' : 'none';
    const logTable = document.getElementById('reportLogTable');
    if (logTable) logTable.classList.toggle('hide-analysis', !hasAnalysis);
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

// A workspace with no format of its own adopts the operator's current one, so
// a Builder change isn't lost the moment you switch to a new ATO. The adopted
// format is persisted for that workspace too, so every client converges on the
// same shape instead of each falling back to its own local preference.
const ensureWorkspaceFormat = () => {
    if (!activeAto || isReadOnly) return;
    const own = workspaceFormats[activeAto];
    if (own) {
        // Remember the shape we're actually working in, so the next new
        // workspace inherits this rather than the last one we happened to edit.
        writeStored(_LAST_FORMAT_KEY, JSON.stringify(own));
        return;
    }
    const carry = readStored(_LAST_FORMAT_KEY, null);
    if (!carry || !Array.isArray(carry.lines) || !carry.lines.length) return;
    // Nothing worth carrying if it's just the stock preset.
    if (JSON.stringify(carry.lines) === JSON.stringify(FORMAT_PRESETS['salt'])) return;
    saveWorkspaceFormat(carry);
};

// Persist a format change for the active workspace: local cache + server.
const saveWorkspaceFormat = (format) => {
    if (!activeAto) return;
    workspaceFormats[activeAto] = format;
    writeStored('salt_ws_formats', JSON.stringify(workspaceFormats));
    writeStored(_LAST_FORMAT_KEY, JSON.stringify(format));
    applyFormFieldOrder();
    // Custom fields own table columns now, so the log has to repaint too.
    renderLog();
    postJson('/api/save_format', { ato: activeAto, format }).catch(() => {});
};

const resetForm = () => {
    el.form.root.reset();
    el.form.reportId.value = '';
    el.form.title.textContent = 'New Report';
    el.form.logBtn.textContent = 'Log New Report';
    el.form.logBtn.style.display  = '';
    el.form.editPair.style.display = 'none';
    // Cancel slot is reserved via visibility (not display) so the form
    // doesn't reflow when entering/exiting edit mode.
    el.form.cancelBtn.style.visibility = 'hidden';
    el.form.nowBtn.disabled = true;
    el.form.startNum.value = '';
    document.querySelectorAll('.selected-row').forEach(r => r.classList.remove('selected-row'));
};

const loadReportForEditing = (reportId) => {
    if (isReadOnly) return;
    const report = localReports.find(r => r.id === reportId);
    if (!report) return;
    document.querySelectorAll('.selected-row').forEach(r => r.classList.remove('selected-row'));
    const rowEl = [...el.log.body.rows].find(tr => tr.dataset.id === report.id);
    if (rowEl) rowEl.classList.add('selected-row');
    el.form.title.textContent = `Updating ${formatFullId(report)}`;
    el.form.reportId.value    = report.id;
    el.form.startNum.value = reportNum(report) || 1;
    el.form.size.value     = report.size;
    el.form.activity.value = report.activity;
    el.form.location.value = report.location;
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
    const now = Date.now();
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
        if (touched) { r.lastModified = now; restored++; }
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
    Object.keys(r).forEach(k => { if (!(k in before)) delete r[k]; });
    Object.assign(r, before, { lastModified: Date.now() });
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
        const now = Date.now();
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

// --- 7. Export / Import (file generation, downloads, CSV parsing) ---

// Identifier as displayed everywhere (table, copy text, toasts); follows the
// Title Separator toggle. Stored data is untouched.
const formatFullId = (r) => SaltCore.formatFullId(r, atoTitleSep);

// Copy text in the active workspace's format.
const generateReportText = (report) => SaltCore.reportText(report, currentFormat(), atoTitleSep);

// CSV filename: ATO_Title_YYYYMMDD_HHMM{Z|L}; the suffix matches the time mode.
const getCsvFilename = (ato, title) => `${SaltCore.backupFilename(ato, title)}_${fileStamp(new Date(), timeDisplayMode === 'local')}`;

const generateBackupText = (ato, reps, title, profiles) =>
    SaltCore.backupText(ato, reps, title, profiles, workspaceFormats);
const generateAllAtosBackupText = (workspaces, activeAto, title, profiles) =>
    SaltCore.allWorkspacesBackupText(workspaces, activeAto, title, profiles, workspaceFormats);

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

// Workspaces panel tabs: 'export' (default) | 'workspaces' | 'identity'.
// Persisted in localStorage. Viewer mode forces 'export' since the
// workspaces list lives in the sidebar and the identity tab is hidden.
const VALID_TABS = ['export', 'workspaces', 'identity', 'builder'];
const switchWorkspacesTab = (tabName) => {
    if (!VALID_TABS.includes(tabName)) tabName = 'export';
    if (isReadOnly) tabName = 'export';
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

const openExportView = () => {
    isExportViewActive = true;
    el.log.view.style.display  = 'none';
    el.exp.panel.style.display = 'flex';
    el.menu.exportBtn.classList.add('active');
    el.menu.panel.style.display = 'none';
    writeStored('salt_view', 'export');
    // Restore last-used tab; default 'export' for fresh sessions.
    switchWorkspacesTab(localStorage.getItem('salt_workspaces_tab') || 'export');
    renderExportPreview();
    renderWorkspacesList();
};

const closeExportView = () => {
    isExportViewActive = false;
    el.log.view.style.display  = 'flex';
    el.exp.panel.style.display = 'none';
    el.menu.exportBtn.classList.remove('active');
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
            // Restore per-workspace report formats bundled in the backup.
            if (imp.formats && typeof imp.formats === 'object') {
                workspaceFormats = { ...workspaceFormats, ...imp.formats };
                writeStored('salt_ws_formats', JSON.stringify(workspaceFormats));
                for (const [fAto, fFmt] of Object.entries(imp.formats)) {
                    try { await postJson('/api/save_format', { ato: fAto, format: fFmt }); } catch(e){}
                }
            }
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
    el.menu.exportBtn.classList.remove('active');
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
async function pushToServer(source) {
    if (!activeAto) return true;
    const result = await pushWorkspace(activeAto, localReports || [], source);
    offlinePendingPush = result === 'queued';
    writeStored('salt_offline_push', String(offlinePendingPush));
    setConnectionStatus(!offlinePendingPush);
    return !offlinePendingPush;
}

async function syncWithServer() {
    try {
        // Never pull over local changes the server hasn't accepted yet: the
        // pull replaces local state, so they would be lost.
        if (offlinePendingPush && activeAto && !(await pushToServer())) return;
        const res = await fetch('/api/sync');
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) throw new Error('Server unreachable');
        const state = await res.json();
        applyServerUpdate(state.workspaces, state.config, state.profiles, state.connected_users, state.sources, state.connected_initials, state.read_only, state.formats);
        setConnectionStatus(true);
    } catch (err) {
        setConnectionStatus(false);
    }
}

function applyServerUpdate(workspaces, config, profiles, connectedUsers, sources, connInitials, readOnly, formats) {
    // Per-workspace report formats — server keys win, locally-known formats
    // for workspaces the server hasn't seen survive.
    if (formats && typeof formats === 'object') {
        workspaceFormats = { ...workspaceFormats, ...formats };
        writeStored('salt_ws_formats', JSON.stringify(workspaceFormats));
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

// --- 10. Event handlers ---

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

    let reports = [...localReports];
    const idToUpdate = el.form.reportId.value;
    const timeValue  = el.form.time.value.trim();
    let finalTime;

    if (timeValue) {
        // Today's date, or yesterday's when the time is more than an hour ahead.
        finalTime = SaltCore.typedTime(timeValue, timeDisplayMode === 'local');
        if (!finalTime) { showToast('Invalid time. Use HH:MM (24-hour).', true); return; }
    } else {
        finalTime = new Date().toISOString();
    }

    const now  = Date.now();
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
        const verb = mode === 'edit' ? 'edited' : 'saved';
        showToast(`${formatFullId(finalReport)} ${verb} & copied!`);
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
        showToast(`${formatFullId(finalReport)} logged & copied!`);
    }

    localReports = reports;
    reportsByAto[activeAto] = localReports;

    // Edit mode also hits the dedicated server route so the server can apply a
    // surgical overwrite (no history mutation) and broadcast SSE to peers. The
    // subsequent saveLocalAndSync push still runs as a safety net via merge.
    if (editTargetId && finalReport) {
        try {
            await postJson('/api/edit_report', {
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
        } catch (err) { /* offline — save_reports below will reconcile on next push */ }
    }

    // Await the push so a stale broadcast from another client can't clobber the
    // just-logged report between the local mutation and the server confirming it.
    await saveLocalAndSync(reportsByAto);
    copyToClipboard(generateReportText(finalReport));
    resetForm();
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

// Log body — unified event delegation (history toggle, copy, restore, row click)
el.log.body.addEventListener('click', e => {
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
        if (report) { copyToClipboard(generateReportText(report)); showToast(`Copied ${formatFullId(report)} to clipboard`); }
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
        clamp.classList.toggle('expanded');
        return;
    }
    const tr = e.target.closest('tr');
    const td = e.target.closest('td');
    if (td && td.cellIndex > 0 && tr && !tr.classList.contains('history-sub-row')) {
        loadReportForEditing(tr.dataset.id);
    }
});

el.log.body.addEventListener('change', e => { if (e.target.classList.contains('row-selector') || e.target.classList.contains('history-selector')) updateSelectionUI(); });

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
            localReports.forEach(r => { if (deletedSet.has(r.id)) { r.deleted = true; r.lastModified = Date.now(); undone.ids.push(r.id); } });
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
                    r.lastModified = Date.now(); // bump so server merge prefers our copy
                }
            });
            reportsByAto[activeAto] = localReports;
            // Tell the server to remove the same entries server-side and broadcast SSE.
            try {
                await postJson('/api/delete_history', { ato: activeAto, deletions: histSel });
            } catch (err) { /* offline — local change persists, server reconciles on next push */ }
        }
        // Persist locally + push (save_reports merges by lastModified, which we bumped above).
        await saveLocalAndSync(reportsByAto);
        resetForm();
        el.log.deleteBtn.style.display = 'none';
        const canUndo = undone.ids.length || Object.keys(undone.history).length;
        showToast(`${total} item(s) deleted.`, false, canUndo ? { ms: UNDO_MS, undo: () => undoDeletion(ato, undone) } : {});
    });
});

el.log.selectAll.addEventListener('click',   () => { document.querySelectorAll('.row-selector, .history-selector').forEach(cb => cb.checked=true);  updateSelectionUI(); el.menu.panel.style.display='none'; });
el.log.deselectAll.addEventListener('click', () => { document.querySelectorAll('.row-selector, .history-selector').forEach(cb => cb.checked=false); updateSelectionUI(); el.menu.panel.style.display='none'; });

el.log.sendBtn.addEventListener('click', async () => {
    const target = el.log.sendSelect.value;
    if (!target) { showToast('Select a destination ATO first.', true); return; }
    const ids = [...document.querySelectorAll('.row-selector:checked')].map(cb => cb.dataset.id);
    if (!ids.length) return;
    const targetReps = reportsByAto[target]||[];
    const lastNum = targetReps.reduce((m,r) => Math.max(m, reportNum(r)), 0);
    let moved = 0;
    ids.forEach((id, i) => {
        const idx = (reportsByAto['IMPORT']||[]).findIndex(r => r.id===id); if(idx===-1) return;
        const rep = { ...reportsByAto['IMPORT'][idx] };
        const did = `${SaltCore.atoPrefix(target)}${String(lastNum+moved+1).padStart(3,'0')}`;
        rep.ato=SaltCore.atoPrefix(target); rep.title=(reportsByAto[target].find(r=>r.title&&!r.deleted)||{}).title||target; rep.displayId=did; rep.fullId=`${rep.title}${did}`; rep.lastModified=Date.now();
        targetReps.push(rep);
        // Bump the IMPORT copy too, or the deletion would never be sent.
        reportsByAto['IMPORT'][idx] = { ...reportsByAto['IMPORT'][idx], deleted: true, lastModified: Date.now() };
        moved++;
    });
    reportsByAto[target] = targetReps;
    showToast(`Moved ${moved} report(s) to ${target}.`);
    updateSelectionUI(); populateAtoHistory();
    // The destination isn't the active workspace, so push it explicitly;
    // otherwise the next sync would drop the moved reports.
    await saveLocalAndSync(reportsByAto);
    await pushWorkspace(target, reportsByAto[target]);
});

el.log.search.addEventListener('input', debounce(e => renderLog(e.target.value.toLowerCase()), 100));
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
        }
        el.log.search.blur();
    }
});

el.log.sortIdTh.addEventListener('click', () => {
    currentSortMode = currentSortMode==='recent' ? 'numAsc' : currentSortMode==='numAsc' ? 'numDesc' : 'recent';
    writeStored('salt_sort_mode', currentSortMode); updateSortIcons(); renderLog(el.log.search.value.toLowerCase());
});
el.log.sortTimeTh.addEventListener('click', () => {
    currentSortMode = currentSortMode==='timeAsc' ? 'timeDesc' : 'timeAsc';
    writeStored('salt_sort_mode', currentSortMode); updateSortIcons(); renderLog(el.log.search.value.toLowerCase());
});

// Config / ATO — shared logic for Set button and history dropdown
async function applyAtoConfig() {
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
    try { await postJson('/api/save_config', { config: newConfig }); showToast('Configuration Synced.'); }
    catch(e) { showToast('Configuration Saved Locally.'); }
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
    try { await postJson('/api/save_profile', { profile:userProfile }); } catch(e){}
    showToast('Profile saved!'); updateProfilePreview(); syncWithServer();
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
        copyToClipboard(accessCode);
        showToast('Access code copied to clipboard');
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
        const c = p.color || '#0a84ff';
        return `<button type="button" class="startup-profile-chip" data-preset="profile" data-initials="${escapeHtml(p.initials)}" data-color="${escapeHtml(c)}"><span class="chip-dot" style="background:${escapeHtml(c)}"></span>${escapeHtml(p.initials)}</button>`;
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
        // Offer that workspace's known title unless the user typed one already.
        if (!el.startup.title.value) {
            const rep = (reportsByAto[chip.dataset.ato] || []).find(r => r.title && !r.deleted);
            if (rep) el.startup.title.value = rep.title;
        }
    } else if (chip.dataset.preset === 'title') {
        el.startup.title.value = chip.dataset.title;
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
    // Access code: pre-fill from whatever's already known (host auto-fill
    // via the server-injected <meta>, or a previously-typed value cached
    // in localStorage). Empty for fresh non-host editors — they type it.
    if (el.startup.accessCode) el.startup.accessCode.value = accessCode || '';
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
        try { await postJson('/api/save_profile', { profile: userProfile }); } catch(e){}
        // Sync the profile preview in the header.
        el.profile.initials.value = initials;
        el.profile.color.value    = userProfile.color;
        selectSwatch(userProfile.color);
        updateProfilePreview();

        // 2. Save the workspace config via the same path the Set button uses,
        //    so all clients adopt the new ATO/Title on their next sync.
        el.config.ato.value   = ato;
        el.config.title.value = title;
        await applyAtoConfig();
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
el.imp.backupBtn.addEventListener('click', () => el.imp.backupInput.click());
el.imp.backupInput.addEventListener('change', e => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>{processJsonImport(ev.target.result); el.imp.backupInput.value=''; }; r.readAsText(f); });
el.imp.csvBtn.addEventListener('click', () => el.imp.csvInput.click());
el.imp.csvInput.addEventListener('change', e => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>{processExternalCsv(ev.target.result, f.name); el.imp.csvInput.value=''; }; r.readAsText(f); });

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
            triggerDownload(`${base}.csv`, SaltCore.reportsCsv(reps, { local, customLabels, idOf }), 'text/csv;charset=utf-8;');
            showToast('CSV exported!');
            clearExportFilter();
        }
    } catch(e) { showToast('Export error: '+e.message,true); }
});

el.menu.exportBtn.addEventListener('click', () => isExportViewActive ? closeExportView() : openExportView());
document.getElementById('closeExportViewBtn').addEventListener('click', closeExportView);

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
el.menu.bdaBtn.addEventListener('click', () => { bdaMode = !bdaMode; writeStored('salt_bda_mode', bdaMode ? 'on' : 'off'); document.body.classList.toggle('bda-mode', bdaMode); updateBdaBtnText(); renderLog(); el.menu.panel.style.display='none'; showToast(bdaMode ? 'BDA tracking shown.' : 'BDA tracking hidden.'); });

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
    if (e.key==='Escape' && el.manual.modal.classList.contains('show')) { e.preventDefault(); closeManual(); return; }
    if (e.key==='Escape' && el.form.cancelBtn.style.visibility==='visible') { e.preventDefault(); resetForm(); showToast('Editing cancelled.'); return; }
    // Escape clears any selected table rows (before the form-clear fallback).
    if (e.key==='Escape') {
        const sel = document.querySelectorAll('.row-selector:checked, .history-selector:checked');
        if (sel.length) { e.preventDefault(); sel.forEach(cb => cb.checked = false); updateSelectionUI(); return; }
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
    if (e.key==='Enter') {
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

// ═══════════════════════════════════════════════════════════════
// 11. STARTUP
// Restores saved session state then connects to the server.
// ═══════════════════════════════════════════════════════════════
setProfileFromLocalStorage();
updateTimeBtnText();
updateSepBtnText();
updateBdaBtnText();
updateSortIcons();
if (localStorage.getItem('salt_layout')==='horizontal') el.layout.grid.classList.add('horizontal-layout');
applyLayoutMode();

const lastAto    = localStorage.getItem('salt_last_active_ato');
const lastConfig = readStored('salt_offline_config', null);
if (lastAto && lastConfig && lastConfig.ato === lastAto) {
    activeAto = lastAto; localConfig = lastConfig;
    localReports = reportsByAto[activeAto]||[];
    el.config.ato.value   = localConfig.ato;
    el.config.title.value = localConfig.title;
    setAtoState(true);
} else {
    setAtoState(false); localReports=[];
}

// Open the startup modal FIRST — before we paint the board or fire the
// initial sync. The check is purely local-state (cached profile/ATO,
// access-code from the meta tag or localStorage) so it doesn't need the
// network.
maybeShowStartupModal();
// If the local-state check decided NOT to open the modal, lift the
// pre-paint gate right now so the board becomes visible. (If the modal
// IS open, the gate stays on; closeStartupModal lifts it when the user
// confirms.) This is what makes a returning user with all settings
// cached see the board pop in with no flash, and the host see the modal
// land on a clean background with no underlying panel flicker.
if (!el.startup.overlay.classList.contains('show')) {
    document.documentElement.classList.remove('salt-ready-gate');
}

renderLog();
if (localStorage.getItem('salt_view')==='export') openExportView();

syncWithServer().then(() => {
    initSSE();
    // Re-check after sync — server state may have revealed missing pieces.
    // No-op when the modal is already open.
    maybeShowStartupModal();
    // Belt-and-suspenders: ensure the gate is lifted after sync, in case
    // some unusual code path left it set.
    if (!el.startup.overlay.classList.contains('show')) {
        document.documentElement.classList.remove('salt-ready-gate');
    }
});

});

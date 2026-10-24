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
let reportsByAto  = JSON.parse(localStorage.getItem('salt_reports_by_ato') || '{}');
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
let localConfig   = JSON.parse(localStorage.getItem('salt_offline_config') || '{"ato":"","title":""}');
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
        localStorage.setItem(_ACCESS_CODE_KEY, accessCode);
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
let workspaceFormats = JSON.parse(localStorage.getItem('salt_ws_formats') || '{}');
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

// Dedupe localStorage writes — skip if the JSON hasn't actually changed.
let lastSavedReportsJson = localStorage.getItem('salt_reports_by_ato') || '';
const saveReportsByAtoToLocal = () => {
    const json = JSON.stringify(reportsByAto);
    if (json !== lastSavedReportsJson) {
        localStorage.setItem('salt_reports_by_ato', json);
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
const escapeHtml  = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const safeColor   = (c) => /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(String(c)) ? c : 'var(--system-gray)';
const debounce    = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const toZuluTimeString = (d) => {
    const x = (d instanceof Date) ? d : new Date(d);
    if (!x || isNaN(x.getTime())) return String(d);
    return `${String(x.getUTCHours()).padStart(2,'0')}${String(x.getUTCMinutes()).padStart(2,'0')}Z`;
};
// Shift UTC ms by the browser's tz offset, then read the result as UTC to
// produce the local wall-clock HHMM. Invalid-Date guard prevents leaks.
const toLocalTimeString = (d) => {
    const x = (d instanceof Date) ? d : new Date(d);
    if (!x || isNaN(x.getTime())) return String(d);
    const shifted = new Date(x.getTime() - x.getTimezoneOffset() * 60 * 1000);
    const h = String(shifted.getUTCHours()).padStart(2, '0');
    const m = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${h}${m}L`;
};
const copyToClipboard = (text) => {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => {}); return; }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'; document.body.appendChild(ta); ta.focus(); ta.select(); try { document.execCommand('copy'); } catch(e){} ta.remove();
};
const setupMenuToggle = (btn, menu) => btn.addEventListener('click', e => { e.stopPropagation(); menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; });

// --- 4. Notifications (toasts + confirmation dialog) ---
const showToast = (msg, isErr = false) => {
    el.toast.regular.textContent = msg;
    el.toast.regular.style.backgroundColor = isErr ? 'rgba(255,69,58,0.9)' : 'rgba(28,28,30,0.85)';
    el.toast.regular.classList.add('show');
    setTimeout(() => el.toast.regular.classList.remove('show'), 4000);
};
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

// ─── BDA (Battle Damage Assessment) ──────────────────────────────────────
// Sub-row under a report (same pattern as history) listing assessments and
// an inline add-form. Target quick-picks are parsed from the report's own
// Size elements and Location grids.
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

// Effects, worst-first. `key` is the compact checklist label, `cls` drives
// the color, and index order defines severity for the pill roll-up.
const BDA_EFFECTS = [
    { name: 'Destroyed',     key: 'DEST', cls: 'destroyed' },
    { name: 'Damaged',       key: 'DMG',  cls: 'damaged' },
    { name: 'Mobility Kill', key: 'MOB',  cls: 'mobilitykill' },
    { name: 'Suppressed',    key: 'SUPP', cls: 'suppressed' },
    { name: 'No Effect',     key: 'NONE', cls: 'noeffect' },
    { name: 'Unknown',       key: '?',    cls: 'unknown' },
];

// Split a report's Size into elements and Location into grids, then pair
// them: equal counts pair positionally; a single grid is shared by every
// element; anything else leaves the grid blank for the user to fill.
const bdaElements = (report) => {
    const els   = String(report.size || '').split(/[,;+]/).map(s => s.trim()).filter(t => t.length >= 2);
    const raw   = String(report.location || '');
    const grids = (raw.includes(',') ? raw.split(/[,;]/) : raw.split(/\s+/))
                    .map(s => s.trim()).filter(t => t.length >= 4);
    return els.slice(0, 20).map((el, i) => ({
        target: el,
        coords: (grids.length === els.length) ? grids[i]
              : (grids.length === 1)          ? grids[0]
              : '',
    }));
};

// Roll-up used by the pill: how many elements are assessed and the worst
// outcome recorded so far.
const bdaSummary = (report) => {
    const done  = (report.bda || []).length;
    const total = Math.max(bdaElements(report).length, done);
    let worst = -1;
    (report.bda || []).forEach(b => {
        const i = BDA_EFFECTS.findIndex(e => e.name === b.effect);
        if (i > -1 && (worst === -1 || i < worst)) worst = i;
    });
    return { done, total, worstCls: worst > -1 ? BDA_EFFECTS[worst].cls : '' };
};

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
        return `<div class="bda-entry" data-entry-lm="${b.lastModified}">
            <span class="bda-effect bda-eff-${eff.cls}" data-bda-editopen="${report.id}" title="Click to change the assessment">${escapeHtml(b.effect || 'Unknown')}</span>
            <span class="bda-target">${escapeHtml(b.target || '')}</span>
            ${b.coords ? `<span class="bda-coords">${escapeHtml(b.coords)}</span>` : ''}
            ${b.note ? `<span class="bda-note">${escapeHtml(b.note)}</span>` : ''}
            <span class="bda-meta">${escapeHtml(toZuluTimeString(b.time))}${b.user && b.user.initials ? ' · ' + escapeHtml(b.user.initials) : ''}</span>
            <button type="button" class="bda-del" data-bda-del="${report.id}" data-lm="${b.lastModified}" title="Delete assessment">&#10005;</button>
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
                <button type="button" class="set-btn bda-commit-btn" data-bda-commit="${report.id}" disabled>Log Assessments</button>
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
    renderLog();
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
    renderLog();
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
        renderLog();
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
            ? `<button class="history-btn ${isOpen ? 'open' : ''}" data-history-id="${report.id}" title="View past versions">&#8250;</button>`
            : `<button class="history-btn" style="visibility:hidden;" disabled>&#8250;</button>`;
        const statusText  = report.updated
            ? `<span class="id-cell-wrap">${escapeHtml(formatFullId(report))}<span class="id-updated-badge">(Updated)</span></span>`
            : escapeHtml(formatFullId(report));
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
            bdaBtn = `<button class="bda-btn ${state}${worstCls ? ' bda-worst-' + worstCls : ''}${openBdaRows.has(report.id) ? ' open' : ''}" data-bda-id="${report.id}" title="${tip}">${label}</button>`;
        }
        row.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="row-selector" data-id="${report.id}" title="Select"> ${histBtn} <button class="copy-btn" data-id="${report.id}">Copy</button>${bdaBtn}</div></td><td class="col-by reporter-col">${reporterHTML}</td><td class="col-id">${statusText}</td><td class="col-size">${clampCell(report.size)}</td><td class="col-activity">${clampCell(report.activity)}</td><td class="col-location">${clampCell(report.location)}</td><td class="col-time">${escapeHtml(timeFmt(report.time))}</td><td class="col-analysis">${clampCell(report.yourAnalysis)}</td>${cusCells(report.custom)}`;
        frag.appendChild(row);

        if (bdaMode && openBdaRows.has(report.id)) frag.appendChild(buildBdaRow(report));

        if (isOpen && report.history && report.history.length > 0) {
            [...report.history].sort((a,b) => b.lastModified - a.lastModified).forEach((h, i, arr) => {
                const hRow = document.createElement('tr');
                hRow.className = 'history-sub-row';
                const hRep  = h.user || null;
                const hHTML = hRep ? `<span style="color:${safeColor(hRep.color)};">${escapeHtml(hRep.initials)}</span>` : '?';
                hRow.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="history-selector" data-id="${report.id}" data-lm="${h.lastModified}" title="Select history entry"> <span class="hist-arrow">&#8618;</span> <button class="restore-btn" data-restore-id="${report.id}" data-lm="${h.lastModified}" title="Restore this version as current">Restore</button></div></td><td class="col-by reporter-col">${hHTML}</td><td class="col-id"><span class="id-cell-wrap">${escapeHtml(formatFullId(report))}<span class="id-updated-badge">(Update #${arr.length - i})</span></span></td><td class="col-size">${clampCell(h.size)}</td><td class="col-activity">${clampCell(h.activity)}</td><td class="col-location">${clampCell(h.location)}</td><td class="col-time">${escapeHtml(timeFmt(h.time))}</td><td class="col-analysis">${clampCell(h.yourAnalysis)}</td>${cusCells(h.custom)}`;
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
        try { localStorage.setItem(_LAST_FORMAT_KEY, JSON.stringify(own)); } catch (e) {}
        return;
    }
    let carry = null;
    try { carry = JSON.parse(localStorage.getItem(_LAST_FORMAT_KEY) || 'null'); } catch (e) {}
    if (!carry || !Array.isArray(carry.lines) || !carry.lines.length) return;
    // Nothing worth carrying if it's just the stock preset.
    if (JSON.stringify(carry.lines) === JSON.stringify(FORMAT_PRESETS['salt'])) return;
    saveWorkspaceFormat(carry);
};

// Persist a format change for the active workspace: local cache + server.
const saveWorkspaceFormat = (format) => {
    if (!activeAto) return;
    workspaceFormats[activeAto] = format;
    localStorage.setItem('salt_ws_formats', JSON.stringify(workspaceFormats));
    try { localStorage.setItem(_LAST_FORMAT_KEY, JSON.stringify(format)); } catch (e) {}
    applyFormFieldOrder();
    // Custom fields own table columns now, so the log has to repaint too.
    renderLog();
    try { fetch('/api/save_format', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ato: activeAto, format }) }); } catch (e) {}
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
    const rowEl = el.log.body.querySelector(`tr[data-id='${report.id}']`);
    if (rowEl) rowEl.classList.add('selected-row');
    el.form.title.textContent = `Updating ${formatFullId(report)}`;
    el.form.reportId.value    = report.id;
    el.form.startNum.value = reportNum(report) || 1;
    el.form.size.value     = report.size;
    el.form.activity.value = report.activity;
    el.form.location.value = report.location;
    el.form.analysis.value = report.yourAnalysis || '';
    document.querySelectorAll('#salt-fields [data-custom-label]').forEach(i => { i.value = (report.custom || {})[i.dataset.customLabel] || ''; });
    const d = new Date(report.time);
    if (timeDisplayMode === 'local') {
        el.form.time.value = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    } else {
        el.form.time.value = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    }
    // Swap the single "Log New Report" submit for the Edit / Update pair.
    el.form.logBtn.style.display   = 'none';
    el.form.editPair.style.display = 'flex';
    // Make the always-reserved Cancel button slot actually visible now.
    el.form.cancelBtn.style.visibility = 'visible';
    el.form.nowBtn.disabled        = false;
};

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
    showConfirmation(`Restore this version as current for ${report.fullId}?${dropMsg}`, async () => {
        const now = Date.now();
        // Drop the chosen snapshot and everything newer; keep strictly older.
        report.history = (report.history || []).filter(h => h.lastModified < snapshot.lastModified);
        report.size         = snapshot.size;
        report.activity     = snapshot.activity;
        report.location     = snapshot.location;
        report.time         = snapshot.time;
        report.yourAnalysis = snapshot.yourAnalysis;
        report.updated      = report.history.length > 0;
        report.lastModified = now;
        // Attribute the restore to the operator who performed it.
        if (userProfile) report.user = userProfile;
        reportsByAto[activeAto] = localReports;
        await saveLocalAndSync(reportsByAto);
        showToast(`${formatFullId(report)} restored.`);
    });
};

const setAtoState = (isSet) => {
    el.config.ato.readOnly   = isSet;
    el.config.title.readOnly = isSet;
    el.config.ato.classList.remove('requires-set');
    el.config.title.classList.remove('requires-set');
    el.config.setBtn.textContent = isSet ? 'Change' : 'Set';
    el.config.setBtn.classList.toggle('change-btn', isSet);
    el.config.setBtn.classList.toggle('set-btn', !isSet);
    if (!isSet) populateAtoHistory(); else el.config.history.disabled = true;
};

const setProfileFromLocalStorage = () => {
    const saved = JSON.parse(localStorage.getItem('salt_user_profile_local'));
    if (saved) { userProfile = saved; el.profile.initials.value = userProfile.initials; el.profile.color.value = userProfile.color; selectSwatch(userProfile.color); updateProfilePreview(); }
};

const selectSwatch = (color) => document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));

// --- 7. Export / Import (file generation, downloads, CSV parsing) ---

// Display form of a report's identifier: Title <separator> ATO### — follows
// the Title Separator toggle everywhere (table, copy text, toasts). Stored
// data is untouched; legacy reports without title/displayId fall back to the
// concatenated fullId.
const formatFullId = (r) => {
    if (!r) return '';
    if (r.title && r.displayId) return `${r.title}${atoTitleSep === 'dash' ? ' - ' : ' '}${r.displayId}`;
    return r.fullId || '';
};

// Sequence number of a report. `displayId` is `${ato}${paddedNumber}`, so a
// naive trailing-digit match swallows the ATO's own digits when it ends in
// one (TEST01001 -> 1001 instead of 1, making the next report TEST011002).
// Strip the known ATO prefix first; legacy rows without `ato` fall back.
const reportNum = (r) => {
    if (!r) return 0;
    const did  = String(r.displayId || r.id || '');
    const ato  = String(r.ato || '');
    const tail = (ato && did.startsWith(ato)) ? did.slice(ato.length) : did;
    const m    = tail.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
};

// Copy text follows the workspace's configured format. The identifier line
// is the header when first, or a `U:` line when placed lower (SALT-U).
// Optional lines (analysis, custom fields, BDA) are skipped when empty.
const generateReportText = (report) => {
    if (!report) return '';
    const fmt    = currentFormat();
    const idText = report.updated ? `${formatFullId(report)} (Updated)` : formatFullId(report);
    const lines  = [];
    fmt.lines.forEach((line, i) => {
        switch (line.type) {
            case 'id':       lines.push(i === 0 ? idText : `U: ${idText}`); break;
            case 'size':     lines.push(`S: ${report.size}`); break;
            case 'activity': lines.push(`A: ${report.activity}`); break;
            case 'location': lines.push(`L: ${report.location}`); break;
            case 'time':     lines.push(`T: ${toZuluTimeString(report.time)}`); break;
            case 'analysis': if (report.yourAnalysis) lines.push(`Y: ${report.yourAnalysis}`); break;
            case 'custom': { const v = (report.custom || {})[line.label]; if (v) lines.push(`${line.label}: ${v}`); break; }
        }
    });
    (report.bda || []).forEach((b, i) => {
        lines.push(`BDA ${i + 1}: ${b.effect || 'Unknown'} - ${b.target || 'unspecified'}${b.coords ? ' @ ' + b.coords : ''}${b.note ? ' - ' + b.note : ''}`);
    });
    return lines.join('\n');
};

// Insert commas between multiple MGRS coordinates typed without them:
// "12ABC123456 21CBA321654" and "12 ABC 123 456 21CBA321654" both become
// "12ABC123456, 21CBA321654"-style lists. Strings that already contain a
// comma, or any free text mixed in, pass through untouched.
// Digit chunks must (a) end cleanly (not run into letters) and (b) not be
// the 1-2 digit zone number of the NEXT coordinate ("...456 12 ABD..." must
// break before the 12, not absorb it).
const MGRS_RE = /\d{1,2}\s*[A-Za-z]{3}(?:\s*\d+(?![0-9A-Za-z])(?!\s+[A-Za-z]{3}))+/g;
const normalizeLocation = (loc) => {
    const s = String(loc || '').trim();
    if (!s || s.includes(',')) return s;
    const matches = s.match(MGRS_RE) || [];
    if (matches.length < 2) return s;
    // Only rewrite when the string is nothing but coordinates — free text
    // like "vic hill 205" must never be mangled.
    if (matches.join('').replace(/\s+/g, '') !== s.replace(/\s+/g, '')) return s;
    return matches.map(m => m.trim()).join(', ');
};

// Mirrors the server's _safe() helper — interchangeable filenames.
const safeFilename = (s) => String(s||'').split('').map(c => /[A-Za-z0-9_-]/.test(c) ? c : '_').join('').replace(/^_+|_+$/g, '') || 'X';

// Backup filename: ATO_Title (matches server output).
const getBackupFilename = (ato, title) => `${safeFilename(ato)}_${safeFilename(title)}`;

// CSV filename: ATO_Title_YYYYMMDD_HHMM{Z|L} — suffix matches active time mode.
const getCsvExportStamp = () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    if (timeDisplayMode === 'local') {
        return `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}L`;
    }
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}Z`;
};

const getCsvFilename = (ato, title) => `${safeFilename(ato)}_${safeFilename(title)}_${getCsvExportStamp()}`;

const generateBackupText = (ato, reps, title, profiles) => {
    const pad = n => String(n).padStart(2,'0');
    // Literal em-dash (NOT the HTML entity) — this is a plain .txt file.
    const fmt = iso => { if (!iso) return '—'; const d = new Date(iso); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
    const active  = reps.filter(r => !r.deleted);
    const div = '='.repeat(72), sub = '─'.repeat(72);
    const now = new Date();
    const ts  = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} · ${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}Z`;
    let out = `${div}\n S.A.L.T. REPORT WORKBENCH — ATO BACKUP\n ATO Designator : ${ato}\n Report Title   : ${title}\n Total Reports  : ${active.length}\n Exported       : ${ts}\n${div}\n\n`;
    [...active].sort((a,b) => reportNum(a) - reportNum(b)).forEach(r => {
        out += `${sub}\n REPORT ${r.displayId}${r.updated ? '  [UPDATED]' : ''}\n${sub}\n`;
        out += ` Size     : ${r.size||'—'}\n Activity : ${r.activity||'—'}\n Location : ${r.location||'—'}\n Time     : ${fmt(r.time)}\n`;
        if (r.yourAnalysis) out += ` Analysis : ${r.yourAnalysis}\n`;
        Object.entries(r.custom || {}).forEach(([ck, cv]) => { out += ` ${ck} : ${cv}\n`; });
        if (r.user?.initials) out += ` By       : ${r.user.initials}\n`;
        (r.bda || []).forEach((b, bi) => { out += `   BDA ${bi+1}  : ${b.effect || 'Unknown'} - ${b.target || ''}${b.coords ? ' @ ' + b.coords : ''}${b.note ? ' - ' + b.note : ''}\n`; });
        if (r.history?.length) {
            [...r.history].sort((a,b) => a.lastModified - b.lastModified).forEach((h, i) => {
                out += `\n   ↳ Previous Entry ${i+1}\n      Size     : ${h.size||'—'}\n      Activity : ${h.activity||'—'}\n      Location : ${h.location||'—'}\n      Time     : ${fmt(h.time)}\n`;
                if (h.yourAnalysis) out += `      Analysis : ${h.yourAnalysis}\n`;
            });
        }
        out += '\n';
    });
    const machine = JSON.stringify({ workspaces: { [ato]: reps }, config: { ato, title }, profiles: profiles||{}, formats: workspaceFormats[ato] ? { [ato]: workspaceFormats[ato] } : {} });
    out += `\n${div}\n MACHINE DATA — DO NOT EDIT BELOW THIS LINE\n${div}\n`;
    out += `##SALT_BACKUP##\n${machine}\n##SALT_BACKUP_END##\n`;
    return out;
};

const generateAllAtosBackupText = (workspaces, activeAto, title, profiles) => {
    const pad = n => String(n).padStart(2,'0');
    const fmt = iso => { if (!iso) return '—'; const d = new Date(iso); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
    const div = '='.repeat(72), sub = '─'.repeat(72);
    const now = new Date();
    const ts  = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} · ${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}Z`;
    const atoKeys    = Object.keys(workspaces);
    const totalReps  = atoKeys.reduce((n, k) => n + (workspaces[k]||[]).filter(r => !r.deleted).length, 0);
    let out = `${div}\n S.A.L.T. REPORT WORKBENCH — FULL BACKUP (ALL ATOs)\n ATOs Included  : ${atoKeys.join(', ')}\n Total Reports  : ${totalReps}\n Exported       : ${ts}\n${div}\n\n`;
    atoKeys.forEach(ato => {
        const active   = (workspaces[ato]||[]).filter(r => !r.deleted);
        const atoTitle = (active.find(r => r.title)||{}).title || ato;
        out += `${div}\n ATO: ${ato}  —  ${atoTitle}  (${active.length} report${active.length !== 1 ? 's' : ''})\n${div}\n\n`;
        [...active].sort((a,b) => reportNum(a) - reportNum(b)).forEach(r => {
            out += `${sub}\n REPORT ${r.displayId}${r.updated ? '  [UPDATED]' : ''}\n${sub}\n`;
            out += ` Size     : ${r.size||'—'}\n Activity : ${r.activity||'—'}\n Location : ${r.location||'—'}\n Time     : ${fmt(r.time)}\n`;
            if (r.yourAnalysis) out += ` Analysis : ${r.yourAnalysis}\n`;
            Object.entries(r.custom || {}).forEach(([ck, cv]) => { out += ` ${ck} : ${cv}\n`; });
            if (r.user?.initials) out += ` By       : ${r.user.initials}\n`;
            (r.bda || []).forEach((b, bi) => { out += `   BDA ${bi+1}  : ${b.effect || 'Unknown'} - ${b.target || ''}${b.coords ? ' @ ' + b.coords : ''}${b.note ? ' - ' + b.note : ''}\n`; });
            if (r.history?.length) {
                [...r.history].sort((a,b) => a.lastModified - b.lastModified).forEach((h, i) => {
                    out += `\n   ↳ Previous Entry ${i+1}\n      Size     : ${h.size||'—'}\n      Activity : ${h.activity||'—'}\n      Location : ${h.location||'—'}\n      Time     : ${fmt(h.time)}\n`;
                    if (h.yourAnalysis) out += `      Analysis : ${h.yourAnalysis}\n`;
                });
            }
            out += '\n';
        });
    });
    const machine = JSON.stringify({ workspaces, config: { ato: activeAto, title }, profiles: profiles||{}, formats: workspaceFormats });
    out += `\n${div}\n MACHINE DATA — DO NOT EDIT BELOW THIS LINE\n${div}\n`;
    out += `##SALT_BACKUP##\n${machine}\n##SALT_BACKUP_END##\n`;
    return out;
};

const triggerDownload = (filename, content, type = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.setAttribute('download', filename);
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
};

// Combine "YYYY-MM-DD" + "HH:MM" into ms epoch, interpreted in the active
// time mode. Missing time → 00:00 (start) or 23:59 (end).
const parseFilterTime = (dateStr, timeStr, isEnd) => {
    if (!dateStr) return null;
    const t   = (timeStr || '').trim();
    const tOk = /^\d{1,2}:\d{2}$/.test(t);
    let safe;
    if (tOk) {
        const [h, m] = t.split(':').map(Number);
        if (h > 23 || m > 59) safe = isEnd ? '23:59' : '00:00';
        else safe = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    } else {
        safe = isEnd ? '23:59' : '00:00';
    }
    const iso  = timeDisplayMode === 'local'
        ? `${dateStr}T${safe}:${isEnd ? '59' : '00'}`
        : `${dateStr}T${safe}:${isEnd ? '59' : '00'}Z`;
    const ms   = new Date(iso).getTime();
    return isNaN(ms) ? null : ms;
};

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
        try { await fetch('/api/unload_ato', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ato }) }); } catch(e){}
        delete reportsByAto[ato];
        delete workspaceSources[ato];
        saveReportsByAtoToLocal();
        if (wasActive) {
            activeAto    = '';
            localReports = [];
            localConfig  = { ato:'', title:'' };
            localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
            localStorage.removeItem('salt_last_active_ato');
            offlinePendingPush = false;
            localStorage.setItem('salt_offline_push', 'false');
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
    localStorage.setItem('salt_workspaces_tab', tabName);
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
    localStorage.setItem('salt_view', 'export');
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
    localStorage.setItem('salt_view', 'log');
};

function processJsonImport(rawText) {
    // Strip UTF-8 BOM if present (Notepad and some editors add it).
    if (rawText && rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);

    // Locate the machine-data block. The filename doesn't matter — only the markers do.
    const s = rawText.indexOf('##SALT_BACKUP##');
    const e = rawText.indexOf('##SALT_BACKUP_END##');
    let jsonText;
    if (s !== -1 && e !== -1 && e > s) {
        jsonText = rawText.slice(s + '##SALT_BACKUP##'.length, e).trim();
    } else {
        // No markers — try the whole file as raw JSON (older backups / hand-edited files).
        jsonText = rawText.trim();
    }
    if (!jsonText) { showToast('Import failed: file is empty.', true); return; }

    // Validate JSON up-front so the user sees a precise error before the confirm prompt.
    let imp;
    try { imp = JSON.parse(jsonText); }
    catch (err) {
        showToast(
            (s === -1 || e === -1)
                ? 'Import failed: no ##SALT_BACKUP## block found and the file is not raw JSON.'
                : 'Import failed: machine-data block is corrupt (' + (err.message || 'parse error') + ').',
            true
        );
        return;
    }
    if (!imp || typeof imp !== 'object' || (!imp.workspaces && !imp.reports)) {
        showToast('Import failed: file does not contain a recognisable backup payload.', true);
        return;
    }

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
                localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
                localStorage.setItem('salt_last_active_ato', activeAto);
                setAtoState(true);
            }
            // Restore per-workspace report formats bundled in the backup.
            if (imp.formats && typeof imp.formats === 'object') {
                workspaceFormats = { ...workspaceFormats, ...imp.formats };
                localStorage.setItem('salt_ws_formats', JSON.stringify(workspaceFormats));
                for (const [fAto, fFmt] of Object.entries(imp.formats)) {
                    try { await fetch('/api/save_format', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ato: fAto, format: fFmt }) }); } catch(e){}
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
            if (imp.profiles) { for (const key in imp.profiles) { try { await fetch('/api/save_profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ profile: imp.profiles[key] }) }); } catch(e){} } }
            if (imp.config && imp.config.ato) { try { await fetch('/api/save_config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ config: imp.config }) }); } catch(e){} }
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
    // Parse the CSV into a 2D array (RFC 4180-ish, quote-aware)
    const arr = []; let q = false, row = 0, col = 0;
    for (let i = 0; i < csvText.length; i++) {
        const c = csvText[i], n = csvText[i+1];
        arr[row] = arr[row]||[]; arr[row][col] = arr[row][col]||'';
        if (c==='"' && q && n==='"') { arr[row][col]+=c; i++; continue; }
        if (c==='"') { q=!q; continue; }
        if (c===',' && !q) { col++; continue; }
        if (c==='\r' && n==='\n' && !q) { row++; col=0; i++; continue; }
        if ((c==='\n'||c==='\r') && !q) { row++; col=0; continue; }
        arr[row][col]+=c;
    }
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
    localStorage.setItem('salt_view', 'log');
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
    const prefix   = dest === 'IMPORT' ? 'IMP' : dest;
    const destTitle = dest === 'IMPORT' ? 'IMPORT' : ((existing.find(r => r.title) || {}).title || dest);

    let imported = 0, skipped = 0;
    const newReps = [];
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
        newReps.push({
            id: generateUUID(),
            displayId: did,
            fullId:    full,
            ato:       dest,
            title:     destTitle,
            size:      size || '-',
            activity,
            location:  loc,
            time:      t || new Date().toISOString(),
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
        localStorage.setItem('salt_last_active_ato', dest);
        if (dest !== 'IMPORT') {
            localConfig = { ato: dest, title: destTitle };
            localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
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
    showToast(msg);
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
        localStorage.setItem('salt_last_active_ato', intendedAto);
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

// POST a JSON body to the sync server. Resolves to the Response whatever its
// status; rejects only when the server can't be reached.
const postJson = (path, body) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Wrong, missing, or rotated access code: forget it and re-prompt. The viewer
// port never answers 401, but stay defensive.
const handleUnauthorized = () => {
    clearAccessCode();
    setConnectionStatus(false);
    if (!isReadOnly && !document.body.classList.contains('read-only')) openStartupModal();
};

// Push one workspace's reports (an empty list unloads it). Returns 'ok',
// 'queued' when the change should be retried later (server unreachable, code
// rejected, rate limited, or a server error), or 'rejected' when the server
// refused the data itself; retrying identical data would only be refused
// again, so that case is reported to the user instead.
async function pushWorkspace(ato, reports, source) {
    let res;
    try {
        res = reports.length
            ? await postJson('/api/save_reports', source ? { ato, reports, source } : { ato, reports })
            : await postJson('/api/unload_ato', { ato });
    } catch (err) {
        return 'queued';
    }
    if (res.ok) return 'ok';
    if (res.status === 401) { handleUnauthorized(); return 'queued'; }
    if (res.status === 429 || res.status >= 500) return 'queued';
    const reason = await res.json().then(j => j.message).catch(() => '') || `HTTP ${res.status}`;
    showToast(`The server did not save ${ato}: ${reason}`, true);
    return 'rejected';
}

// Push the active workspace. `source` is an optional hint ('backup' | 'csv')
// for server-side logging. Resolves false when the change is still queued.
async function pushToServer(source) {
    if (!activeAto) return true;
    const result = await pushWorkspace(activeAto, localReports || [], source);
    offlinePendingPush = result === 'queued';
    localStorage.setItem('salt_offline_push', String(offlinePendingPush));
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
        try { localStorage.setItem('salt_ws_formats', JSON.stringify(workspaceFormats)); } catch (e) {}
    }
    if (connectedUsers != null) {
        el.status.userCount.textContent    = connectedUsers;
        el.status.userCountExp.textContent = connectedUsers;
    }
    localProfiles     = profiles      || {};
    // Cache profiles so the startup modal can offer them even before the
    // first sync of a future session (or offline).
    if (profiles && Object.keys(profiles).length) {
        try { localStorage.setItem(_PROFILES_CACHE_KEY, JSON.stringify(profiles)); } catch (e) {}
    }
    workspaceSources  = sources       || {};
    connectedInitials = Array.isArray(connInitials) ? connInitials : [];
    // Viewer mode flag — CSS hides mutation UI; JS guards also check it.
    isReadOnly = !!readOnly;
    document.body.classList.toggle('read-only', isReadOnly);
    reportsByAto = workspaces || {};
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
        localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
        localStorage.setItem('salt_last_active_ato', activeAto);
        localReports = reportsByAto[activeAto] || [];
    } else {
        // Server config empty (e.g., another client just unloaded the active ATO).
        activeAto = null;
        localReports = [];
        localConfig = { ato: '', title: '' };
        localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
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
        if (!/^\d{1,2}:\d{2}$/.test(timeValue)) { showToast('Invalid time format. Use HH:MM.', true); return; }
        let [h, m] = timeValue.split(':').map(Number);
        if (isNaN(h)||isNaN(m)||h>23||m>59) { showToast('Invalid time value.', true); return; }
        const d = new Date();
        if (timeDisplayMode === 'local') d.setHours(h,m,0,0);
        else                             d.setUTCHours(h,m,0,0);
        finalTime = d.toISOString();
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
        if (idx > -1) {
            const orig = reports[idx];
            const tAto = el.config.ato.value.trim().toUpperCase().replace(/-/g,'');
            const tNum = String(el.form.startNum.value).padStart(3,'0');
            const tDid = `${tAto}${tNum}`;
            if (tDid !== orig.displayId) {
                // Renumber/rename branch — applies to both Edit and Update. The
                // identity of the report changed, so prior history doesn't carry
                // forward in either case (matches pre-split behavior).
                const newTitle = el.config.title.value.trim() || 'Report #';
                finalReport = { ...orig, ...data, displayId:tDid, ato:tAto, title:newTitle, fullId:`${newTitle}${tDid}`, updated:false, lastModified:now, user:userProfile };
            } else if (mode === 'edit') {
                // EDIT: overwrite fields in place. No history snapshot. `updated`
                // and `history` are preserved exactly as-is, so the audit trail
                // is untouched — the user is simply correcting the current text.
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
        }
    } else {
        // NEW REPORT path
        const atoPrefix   = el.config.ato.value.trim().toUpperCase().replace(/-/g,'');
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
            await fetch('/api/edit_report', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
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
                })
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

el.form.nowBtn.addEventListener('click', () => {
    const now = new Date();
    if (timeDisplayMode === 'local') { el.form.time.value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`; }
    else { el.form.time.value = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`; }
});

el.form.time.addEventListener('blur', e => {
    let v = e.target.value.trim(); if (v.includes(':')) return;
    let d = v.replace(/\D/g,''); if (d.length===3) d='0'+d;
    if (d.length===4) { const h=d.slice(0,2), m=d.slice(2,4); if(parseInt(h)<=23&&parseInt(m)<=59) e.target.value=`${h}:${m}`; }
});

// Log body — unified event delegation (history toggle, copy, restore, row click)
el.log.body.addEventListener('click', e => {
    const histBtn = e.target.closest('[data-history-id]');
    if (histBtn) {
        const id = histBtn.dataset.historyId;
        openHistoryRows.has(id) ? openHistoryRows.delete(id) : openHistoryRows.add(id);
        renderLog(el.log.search.value.toLowerCase());
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
            `<button type="button" class="bda-eff-btn bda-eff-${x.cls}${x.name === cur ? ' picked' : ''}" data-bda-editlm="${lm}" data-bda-editid="${editOpen.dataset.bdaEditopen}" data-bda-eff="${x.name}" title="${x.name}">${x.key}</button>`).join('');
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
        // ── Main report deletions (soft-delete via the deleted flag) ─────────
        if (mainIds.length) {
            const deletedSet = new Set(mainIds);
            localReports.forEach(r => { if (deletedSet.has(r.id)) { r.deleted = true; r.lastModified = Date.now(); } });
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
                    r.history = r.history.filter(h => !lms.has(h.lastModified));
                    r.lastModified = Date.now(); // bump so server merge prefers our copy
                }
            });
            reportsByAto[activeAto] = localReports;
            // Tell the server to remove the same entries server-side and broadcast SSE.
            try {
                await fetch('/api/delete_history', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ ato: activeAto, deletions: histSel })
                });
            } catch (err) { /* offline — local change persists, server reconciles on next push */ }
        }
        // Persist locally + push (save_reports merges by lastModified, which we bumped above).
        await saveLocalAndSync(reportsByAto);
        resetForm();
        showToast(`${total} item(s) deleted.`);
        el.log.deleteBtn.style.display = 'none';
    });
});

el.log.selectAll.addEventListener('click',   () => { document.querySelectorAll('.row-selector, .history-selector').forEach(cb => cb.checked=true);  updateSelectionUI(); el.menu.panel.style.display='none'; });
el.log.deselectAll.addEventListener('click', () => { document.querySelectorAll('.row-selector, .history-selector').forEach(cb => cb.checked=false); updateSelectionUI(); el.menu.panel.style.display='none'; });

el.log.sendBtn.addEventListener('click', () => {
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
        const did = `${target}${String(lastNum+moved+1).padStart(3,'0')}`;
        rep.ato=target; rep.title=(reportsByAto[target].find(r=>r.title&&!r.deleted)||{}).title||target; rep.displayId=did; rep.fullId=did; rep.lastModified=Date.now();
        targetReps.push(rep); reportsByAto['IMPORT'][idx].deleted=true; moved++;
    });
    reportsByAto[target] = targetReps;
    saveLocalAndSync(reportsByAto);
    showToast(`Moved ${moved} report(s) to ${target}.`);
    if (activeAto==='IMPORT') renderLog();
    updateSelectionUI(); populateAtoHistory();
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
    localStorage.setItem('salt_sort_mode', currentSortMode); updateSortIcons(); renderLog(el.log.search.value.toLowerCase());
});
el.log.sortTimeTh.addEventListener('click', () => {
    currentSortMode = currentSortMode==='timeAsc' ? 'timeDesc' : 'timeAsc';
    localStorage.setItem('salt_sort_mode', currentSortMode); updateSortIcons(); renderLog(el.log.search.value.toLowerCase());
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
    localStorage.setItem('salt_last_active_ato', activeAto);
    localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
    setAtoState(true); renderLog();
    try { await fetch('/api/save_config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ config: newConfig }) }); showToast('Configuration Synced.'); }
    catch(e) { showToast('Configuration Saved Locally.'); }
    // If a sync ran during the await and clobbered anything, restore the intended state.
    activeAto    = newAto;
    localConfig  = newConfig;
    localStorage.setItem('salt_last_active_ato', activeAto);
    localStorage.setItem('salt_offline_config', JSON.stringify(localConfig));
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
    showConfirmation(`Clear the "${activeAto}" workspace from view? (Backup file will not be deleted)`, async () => {
        try { await fetch('/api/unload_ato', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ato:activeAto }) }); } catch(e){}
        delete reportsByAto[activeAto];
        saveReportsByAtoToLocal();
        const cleared = activeAto;
        activeAto=''; localReports=[]; localConfig.ato='';
        localStorage.removeItem('salt_last_active_ato');
        offlinePendingPush = false; localStorage.setItem('salt_offline_push', 'false');
        loadConfig(); renderLog(); populateAtoHistory();
        showToast(`Workspace "${cleared}" cleared from view.`);
    });
});

// Profile
el.profile.setBtn.addEventListener('click', async () => {
    const initials = el.profile.initials.value.trim().toUpperCase();
    const color    = el.profile.color.value;
    if (!initials) { showToast('Enter your initials.', true); return; }
    userProfile = { initials, color };
    localStorage.setItem('salt_user_profile_local', JSON.stringify(userProfile));
    try { await fetch('/api/save_profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ profile:userProfile }) }); } catch(e){}
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
const _PROFILES_CACHE_KEY = 'salt_profiles_cache';
const knownProfiles = () => {
    let cached = {};
    try { cached = JSON.parse(localStorage.getItem(_PROFILES_CACHE_KEY) || '{}'); } catch (e) {}
    return { ...cached, ...localProfiles };
};

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
        try { localStorage.setItem(_ACCESS_CONFIRMED_KEY, accessCode); } catch (e) {}
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
        localStorage.setItem('salt_user_profile_local', JSON.stringify(userProfile));
        try { await fetch('/api/save_profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ profile: userProfile }) }); } catch(e){}
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
            const now = new Date(), pad = n => String(n).padStart(2,'0');
            const fname = `ALL_ATOS_${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}Z.txt`;
            triggerDownload(fname, generateAllAtosBackupText(filtered, activeAto||'', localConfig.title||'SALT', localProfiles));
            showToast(`All ATOs backup exported!`);
            clearExportFilter();
        } else {
            // ── Export active ATO only (default) ─────────────────────────
            const reps = getExportFilteredReports();
            if (!reps.length) { showToast('No reports to export.', true); return; }
            const title = localConfig.title || 'SALT';
            triggerDownload(`${getBackupFilename(activeAto||'ATO', title)}.txt`, generateBackupText(activeAto||'ATO', reps, title, localProfiles));
            showToast('Backup exported!');
            clearExportFilter();
        }
    } catch(e) { showToast('Export error: ' + e.message, true); }
});
document.getElementById('exportPanelCsvBtn').addEventListener('click', () => {
    try {
        const reps = getExportFilteredReports();
        if (!reps.length) { showToast('No reports to export.', true); return; }
        const isMti = el.exp.mtiToggle.checked;
        const timeFmt = timeDisplayMode==='local' ? toLocalTimeString : toZuluTimeString;
        const tLabel  = `Time (${timeDisplayMode==='local'?'Local':'Z'})`;
        const f = v => `"${String(v||'').replace(/"/g,'""')}"`;
        const hdr = `Identifier,UpdateStatus,Size,Activity,MGRS,${tLabel},Analysis\r\n`;
        const title = localConfig.title||'SALT';
        const base  = getCsvFilename(activeAto||'ATO', title);
        if (isMti) {
            let tCsv=hdr, wCsv=hdr, tc=0, wc=0;
            const processMtiRow = (id, upd, size, activity, location, time, analysis) => {
                const sl = (size||'').toLowerCase();
                const tm = sl.match(/(\d+\s*tracked)/); if(tm){tCsv+=[f(id),f(upd),f(tm[1].trim()),f(activity),f(location),f(timeFmt(time)),f(analysis)].join(',')+'\r\n';tc++;}
                const wm = sl.match(/(\d+\s*wheeled)/); if(wm){wCsv+=[f(id),f(upd),f(wm[1].trim()),f(activity),f(location),f(timeFmt(time)),f(analysis)].join(',')+'\r\n';wc++;}
            };
            for (const r of reps) {
                // Current record
                processMtiRow(r.fullId, r.updated?'Current Update':'Original', r.size, r.activity, r.location, r.time, r.yourAnalysis);
                // History entries (mirrors standard CSV export — previously missing from MTI)
                if (r.history?.length) {
                    const h = [...r.history].sort((a,b) => b.lastModified - a.lastModified);
                    h.forEach((hh,i) => processMtiRow(r.fullId, `Update #${h.length-i} (Old)`, hh.size, hh.activity, hh.location, hh.time, hh.yourAnalysis));
                }
            }
            if(tc>0) triggerDownload(`${base}_tracked.csv`,tCsv,'text/csv;charset=utf-8;');
            if(wc>0) setTimeout(()=>triggerDownload(`${base}_wheeled.csv`,wCsv,'text/csv;charset=utf-8;'),400);
            if(!tc&&!wc) showToast('No tracked/wheeled reports found.',true); else { showToast('MTI CSV exported!'); clearExportFilter(); }
        } else {
            // Custom builder fields become extra columns, appended after
            // Analysis so the first seven stay index-stable for existing
            // consumers. Union of the format's custom lines and any keys
            // present on the data (in case the format changed since logging).
            const cusCols = [...new Set([
                ...currentFormat().lines.filter(l => l.type === 'custom').map(l => l.label),
                ...reps.flatMap(r => Object.keys(r.custom || {})),
            ])];
            const cusCells = (o) => cusCols.map(c => f((o || {})[c] || ''));
            let csv = `Identifier,UpdateStatus,Size,Activity,MGRS,${tLabel},Analysis${cusCols.map(c => ',' + c).join('')}\r\n`;
            for (const r of reps) {
                csv+=[f(r.fullId),f(r.updated?'Current Update':'Original'),f(r.size),f(r.activity),f(r.location),f(timeFmt(r.time)),f(r.yourAnalysis),...cusCells(r.custom)].join(',')+'\r\n';
                if(r.history?.length) { const h=[...r.history].sort((a,b)=>b.lastModified-a.lastModified); h.forEach((hh,i)=>{csv+=[f(r.fullId),f(`Update #${h.length-i} (Old)`),f(hh.size),f(hh.activity),f(hh.location),f(timeFmt(hh.time)),f(hh.yourAnalysis),...cusCells(hh.custom)].join(',')+'\r\n';}); }
                // BDA assessments ride the existing columns: target in Size,
                // effect in Activity, coords in MGRS, note in Analysis.
                (r.bda||[]).forEach((b,i)=>{csv+=[f(r.fullId),f(`BDA #${i+1}`),f(b.target),f(b.effect),f(b.coords),f(timeFmt(b.time)),f(b.note),...cusCols.map(()=>f(''))].join(',')+'\r\n';});
            }
            triggerDownload(`${base}.csv`,csv,'text/csv;charset=utf-8;'); showToast('CSV exported!'); clearExportFilter();
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
// Auto-format the typed time on blur, same UX as the report form's time field
// (e.g. "1430" → "14:30"). Invalid input is left alone for the user to see/fix.
const formatTimeOnBlur = (e) => {
    const v = e.target.value.trim();
    if (!v || v.includes(':')) return;
    const digits = v.replace(/\D/g,'');
    const padded = digits.length === 3 ? '0' + digits : digits;
    if (padded.length === 4) {
        const h = padded.slice(0,2), m = padded.slice(2,4);
        if (parseInt(h,10) <= 23 && parseInt(m,10) <= 59) {
            e.target.value = `${h}:${m}`;
            renderExportPreview();
        }
    }
};
el.exp.fromTime.addEventListener('blur', formatTimeOnBlur);
el.exp.toTime  .addEventListener('blur', formatTimeOnBlur);
el.exp.clearBtn.addEventListener('click', clearExportFilter);

// Quick-range presets (Last 12h / 6h / 1h).
// Writes both the From and To pairs from a single click, honoring the current
// Zulu/Local time mode so the values line up with what the user sees elsewhere.
const writeFilterPair = (dateField, timeField, d) => {
    const pad = n => String(n).padStart(2, '0');
    if (timeDisplayMode === 'local') {
        dateField.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        timeField.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
        dateField.value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
        timeField.value = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
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
el.menu.layoutBtn.addEventListener('click', () => { el.layout.grid.classList.toggle('horizontal-layout'); localStorage.setItem('salt_layout', el.layout.grid.classList.contains('horizontal-layout')?'horizontal':'vertical'); applyLayoutMode(); });
el.menu.timeBtn.addEventListener('click', () => { timeDisplayMode=timeDisplayMode==='zulu'?'local':'zulu'; localStorage.setItem('salt_time_mode',timeDisplayMode); showToast(`Time format: ${timeDisplayMode}.`); updateTimeBtnText(); if(el.form.reportId.value) loadReportForEditing(el.form.reportId.value); renderLog(); if (isExportViewActive) renderExportPreview(); });
el.menu.sepBtn.addEventListener('click', () => {
    atoTitleSep = atoTitleSep==='dash'?'space':'dash';
    localStorage.setItem('salt_ato_title_sep', atoTitleSep);
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
el.menu.bdaBtn.addEventListener('click', () => { bdaMode = !bdaMode; localStorage.setItem('salt_bda_mode', bdaMode ? 'on' : 'off'); document.body.classList.toggle('bda-mode', bdaMode); updateBdaBtnText(); renderLog(); el.menu.panel.style.display='none'; showToast(bdaMode ? 'BDA tracking shown.' : 'BDA tracking hidden.'); });

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
        const hasContent = el.form.size.value.trim() || el.form.activity.value.trim() ||
                           el.form.location.value.trim() || el.form.time.value.trim() ||
                           el.form.analysis.value.trim();
        if (hasContent) {
            e.preventDefault();
            el.form.size.value = el.form.activity.value = el.form.location.value = '';
            el.form.time.value = el.form.analysis.value = '';
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
const lastConfig = JSON.parse(localStorage.getItem('salt_offline_config')||'null');
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

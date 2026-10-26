// SPDX-License-Identifier: AGPL-3.0-only

// Elements, state, helpers, toasts and the confirm dialog.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

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
        bdaRollup:   document.getElementById('bdaRollup'),
        sortHeaders: document.querySelectorAll('#reportLogTable thead .sortable-th[data-sort]'),
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
    ioPicker: {
        select: document.getElementById('ioFormatSelect'),
        run:    document.getElementById('ioRunBtn'),
        desc:   document.getElementById('ioFormatDesc'),
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
        tabs:        document.querySelectorAll('#exportPanel .ws-tabs .ws-tab'),
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
// Each sortable column's modes, in the order a click steps through them. The
// Identifier header also offers "recent" (last modified first), the default.
const SORT_MODES = {
    id:       ['numAsc', 'numDesc', 'recent'],
    time:     ['timeAsc', 'timeDesc'],
    size:     ['sizeAsc', 'sizeDesc'],
    activity: ['activityAsc', 'activityDesc'],
    location: ['locationAsc', 'locationDesc'],
};
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

// --- Overlays ---
// NAI / OBJ / PL features, one set shared by every workspace: imported in the
// Overlays tab and synced. Viewers keep none locally. Browsers from before
// they were shared kept them per workspace ('salt_ws_overlays'); those are
// folded into one set once.
if (viewerAtLoad) { try { localStorage.removeItem('salt_ws_overlays'); localStorage.removeItem('salt_overlays'); } catch (e) {} }
let sharedOverlays = viewerAtLoad ? [] : SaltCore.foldOverlays(readStored('salt_overlays', null) || readStored('salt_ws_overlays', []));
const storeOverlays = () => {
    if (isReadOnly || viewerAtLoad) return;
    writeStored('salt_overlays', JSON.stringify(sharedOverlays));
    try { localStorage.removeItem('salt_ws_overlays'); } catch (e) {}
};
// The workspace on screen: the editor's active one, or the viewer's pick.
const shownAto        = () => (isReadOnly ? viewerShowingAto : activeAto) || '';
const currentOverlays = () => sharedOverlays;
// The map's basemap service ({} for none), shared like the overlays.
let sharedBasemap = viewerAtLoad ? {} : (readStored('salt_basemap', {}) || {});
const storeBasemap = () => { if (!isReadOnly && !viewerAtLoad) writeStored('salt_basemap', JSON.stringify(sharedBasemap)); };
// What each Location box says against the overlays (grids, NAI/OBJ, nearest
// PL, checks). Cached by text; cleared whenever the overlays change.
const locationCache = new Map();
let locationCacheFor = null;
const locationInfo = (text) => {
    const ovs = currentOverlays();
    if (locationCacheFor !== ovs) { locationCache.clear(); locationCacheFor = ovs; }
    const key = String(text || '');
    if (!locationCache.has(key)) locationCache.set(key, SaltCore.analyzeLocation(key, ovs));
    return locationCache.get(key);
};

// --- BDA mode ---
// Hidden until enabled from the ellipsis menu. Assessments live on each
// report under `bda: []` and sync like everything else.
let bdaMode = localStorage.getItem('salt_bda_mode') === 'on';
document.body.classList.toggle('bda-mode', bdaMode);
// Chip picked in the roll-up strip: an effect name, 'unassessed', or null.
let bdaFilter = null;
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
// A dropdown never runs past the bottom of the window or of the panel that
// holds it (which clips it): it gets the room below its button, and scrolls
// inside that if it needs more.
const setupMenuToggle = (btn, menu) => btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.style.display !== 'block';
    menu.style.display = open ? 'block' : 'none';
    if (open) {
        menu.style.maxHeight = '';
        const panel = btn.closest('.report-section, .form-section');
        const bottom = Math.min(window.innerHeight, panel ? panel.getBoundingClientRect().bottom : Infinity);
        const room = bottom - menu.getBoundingClientRect().top - 12;
        if (menu.scrollHeight > room) menu.style.maxHeight = `${Math.max(160, room)}px`;
    }
});

// The view switcher's icons: the open view's is highlighted.
const setViewIcon = (id, on) => {
    const b = document.getElementById(id);
    if (b) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
};

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

// A question with several answers: `options` are { label, value, primary? };
// resolves to the value picked, or null for Cancel (or Escape). A new
// question answers an open one with null.
let pendingChoice = null;
const askChoice = (message, detail, options) => {
    if (pendingChoice) pendingChoice(null);
    const box = document.getElementById('choice-toast');
    document.getElementById('choice-message').textContent = message;
    document.getElementById('choice-detail').textContent = detail || '';
    const buttons = document.getElementById('choiceButtons');
    buttons.innerHTML = '';
    return new Promise(resolve => {
        const done = (value) => { pendingChoice = null; box.classList.remove('show'); resolve(value); };
        [...options, { label: 'Cancel', value: null, cancel: true }].forEach(o => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = o.cancel ? 'choice-cancel' : o.primary ? 'choice-primary' : 'choice-option';
            b.textContent = o.label;
            b.addEventListener('click', () => done(o.value));
            buttons.appendChild(b);
        });
        pendingChoice = done;
        box.classList.add('show');
        (buttons.querySelector('.choice-primary') || buttons.firstChild).focus();
    });
};
const showConfirmation = (msg, onConfirm) => {
    el.toast.message.textContent = msg;
    pendingConfirm = onConfirm;
    el.toast.confirm.classList.add('show');
};
el.toast.confirmBtn.addEventListener('click', () => { const run = pendingConfirm; hideConfirmation(); if (run) run(); });
el.toast.cancelBtn .addEventListener('click', hideConfirmation);

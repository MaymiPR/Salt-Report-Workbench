// SPDX-License-Identifier: AGPL-3.0-only

// Elements, state, helpers, toasts and the confirm dialog.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// --- 1. Elements (cached at startup; namespaced by panel) ---
const el = {
    form: {
        root:      document.getElementById('saltForm'),
        reportId:  document.getElementById('reportId'),
        title:     document.getElementById('formTitle'),
        peerNote:  document.getElementById('formPeerNote'),
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
        observer:  document.getElementById('observer'),
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
        count:       document.getElementById('reportCount'),
        totalCount:  document.getElementById('reportTotalCount'),
        search:      document.getElementById('searchBar'),
        timeHeader:  document.getElementById('timeHeader'),
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
        dot:          document.getElementById('statusDot'),
        dotExp:       document.getElementById('statusDotExport'),
        userCount:    document.getElementById('connectedUsersCount'),
        version:      document.getElementById('appVersion'),
        userCountExp: document.getElementById('connectedUsersCountExport'),
    },
    // Bars for what needs attention (renderStatusBars in app/90-sync.js).
    bars: {
        notSaving:   document.getElementById('notSavingBar'),
        version:     document.getElementById('versionBar'),
        versionText: document.getElementById('versionBarText'),
        reloadBtn:   document.getElementById('versionReloadBtn'),
    },
    // Identity form, plus the display-only access-code row with Copy button.
    profile: {
        menu:        document.getElementById('userProfileMenu'),
        initials:    document.getElementById('userInitialsInput'),
        color:       document.getElementById('userColorInput'),
        setBtn:      document.getElementById('setProfileBtn'),
        avatar:      document.getElementById('profilePreviewAvatar'),
        name:        document.getElementById('profilePreviewName'),
        accessCode:  document.getElementById('identityAccessCode'),
        accessCopy:  document.getElementById('identityAccessCopyBtn'),
        accessShow:  document.getElementById('identityAccessShowBtn'),
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
        mgrsLockBtn: document.getElementById('toggleMgrsLockBtn'),
        nearbyBtn: document.getElementById('toggleNearbyBtn'),
        fmvBtn:    document.getElementById('toggleFmvBtn'),
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
        regular:    document.getElementById('toastNotification'),
        confirm:    document.getElementById('confirmationToast'),
        confirmBtn: document.getElementById('confirmActionBtn'),
        cancelBtn:  document.getElementById('cancelActionBtn'),
        message:    document.getElementById('confirmationMessage'),
    },
    manage: {
        panel:       document.getElementById('exportPanel'),
        fromDate:    document.getElementById('exportFromDate'),
        fromTime:    document.getElementById('exportFromTime'),
        toDate:      document.getElementById('exportToDate'),
        toTime:      document.getElementById('exportToTime'),
        fromMode:    document.getElementById('exportFromMode'),
        toMode:      document.getElementById('exportToMode'),
        clearBtn:    document.getElementById('exportClearFilterBtn'),
        subtitle:    document.getElementById('exportPanelSubtitle'),
        filterCount: document.getElementById('exportFilterCount'),
        mtiToggle:      document.getElementById('exportMtiToggle'),
        allAtosToggle:  document.getElementById('exportAllAtosToggle'),
    },
    // Manage panel: tab strip + Loaded-Workspaces list (in two
    // containers — the panel's tab and the viewer-mode sidebar).
    workspaces: {
        list:        document.getElementById('workspacesList'),
        sidebarList: document.getElementById('workspacesSidebarList'),
        activity:    document.getElementById('activityList'),
        sidebarActivity: document.getElementById('activitySidebarList'),
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
        avatar:      document.getElementById('startupPreviewAvatar'),
        initials:    document.getElementById('startupInitials'),
        color:       document.getElementById('startupColor'),
        swatches:    document.getElementById('startupColorSwatches'),
        ato:         document.getElementById('startupAto'),
        title:       document.getElementById('startupTitle'),
        accessCode:  document.getElementById('startupAccessCode'),
        accessShow:  document.getElementById('startupAccessShowBtn'),
        accessError: document.getElementById('startupAccessError'),
        continueBtn: document.getElementById('startupContinueBtn'),
        presets:     document.getElementById('startupPresets'),
    },
};

// The top bar, the same for every view: the view's name (fading over when it
// changes) and which of its parts show ('home' for the Report Log and its map).
const setTopBar = (view, title) => {
    const bar = document.getElementById('topBar'), t = document.getElementById('homeTitle');
    if (!bar || !t) return;
    bar.dataset.view = view;
    if (t.textContent !== title) {
        t.textContent = title;
        t.classList.remove('swap'); void t.offsetWidth; t.classList.add('swap');
    }
};
// Play a view's coming-in animation (again, if it's already been shown).
const animateIn = (node) => {
    if (!node) return;
    node.classList.remove('view-in'); void node.offsetWidth; node.classList.add('view-in');
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
// A plain string from localStorage, or the fallback when there is none or the
// browser blocks storage (where even reading it throws).
const readRaw = (key, fallback = null) => {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : raw;
    } catch (e) {
        return fallback;
    }
};
const removeStored = (key) => { try { localStorage.removeItem(key); } catch (e) { /* blocked: nothing kept to remove */ } };
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
            setTimeout(() => showToast('Browser storage is full or blocked. This tab keeps working, but it can\'t save its offline copy or settings until that changes.', true), 0);
        }
        return false;
    }
};
// Viewers keep no copy of the reports. The page comes from the server, so a
// cached copy is useless without it, and it would leave every report at rest
// on a machine that only watches. Whatever an earlier version left is cleared.
const viewerAtLoad = document.body.classList.contains('read-only');
if (viewerAtLoad) ['salt_reports_by_ato', 'salt_unsaved'].forEach(removeStored);
let reportsByAto  = viewerAtLoad ? {} : readStored('salt_reports_by_ato', {});
let activeAto     = null;
// Viewer-only: the workspace the viewer has clicked to look at locally.
// A viewer's `activeAto` tracks the server's config.ato (the workspace
// viewers are shown: the last one an editor switched to); `viewerShowingAto`
// overrides which workspace's reports populate the log. When null or equal
// to activeAto, the viewer is following the editors.
let viewerShowingAto = null;
let localReports  = [];
// Mirror of the server's profile dict; embedded in backup exports so
// re-importing into a fresh deployment restores everyone's initials/color.
let localProfiles = {};
// Last synced profiles, so the startup modal can offer them before the first
// sync of a later session (or offline).
const _PROFILES_CACHE_KEY = 'salt_profiles_cache';
let localConfig   = readStored('salt_offline_config', { ato: '', title: '' });
// The workspace viewers are shown, as the server last said ({ ato, title },
// empty when it has none), or null before the first sync. Each editor has
// their own workspace: this one is only what the startup modal offers.
let serverConfig  = null;
let userProfile   = null;
// ato → source descriptor ("alpha01.txt" | "Uploaded backup" | "In-session").
let workspaceSources = {};
// Initials -> workspace of each connected editor who is in one (no IPs).
let connectedWhere = {};
// The server's last changes, oldest first: [{at, who, what, ato}] (no IPs).
let peerActivity = [];
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
    // Over HTTPS the cookie is marked secure, so it never goes out over plain HTTP.
    const secure = location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${_ACCESS_COOKIE}=${encodeURIComponent(code)}; path=/; samesite=strict${secure}`;
};
const clearAccessCookie = () => {
    document.cookie = `${_ACCESS_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
};
// The access code stays hidden as dots wherever the page shows it, so it
// can't be read over a shoulder; Show reveals it until that screen is left.
let identityCodeShown = false;
const setShowBtn = (btn, shown) => {
    btn.textContent = shown ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    btn.title = shown ? 'Hide the access code' : 'Show the access code';
};
// Sync the read-only access-code row in the Identity tab.
const renderIdentityAccessCode = () => {
    const shown = identityCodeShown && !!accessCode;
    el.profile.accessCode.textContent = !accessCode ? '-' : shown ? accessCode : '•'.repeat(accessCode.length);
    el.profile.accessCode.classList.toggle('masked', !!accessCode && !shown);
    el.profile.accessCopy.disabled = !accessCode;
    el.profile.accessShow.disabled = !accessCode;
    setShowBtn(el.profile.accessShow, shown);
};
const hideIdentityAccessCode = () => { identityCodeShown = false; renderIdentityAccessCode(); };
// The startup field: masked with text-security where the browser has it (not
// a password field, so the browser doesn't offer to save the code as a
// password); a password field elsewhere.
const _TEXT_SECURITY = !!(window.CSS && CSS.supports && CSS.supports('-webkit-text-security', 'disc'));
const setStartupCodeShown = (shown) => {
    const input = el.startup.accessCode;
    if (!input || !el.startup.accessShow) return;
    input.classList.toggle('access-masked', !shown);
    if (!_TEXT_SECURITY) input.type = shown ? 'text' : 'password';
    setShowBtn(el.startup.accessShow, shown);
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
    removeStored(_ACCESS_CODE_KEY);
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
        if (readRaw(_ACCESS_CONFIRMED_KEY, '') !== metaCode) forceStartupModal = true;
    } else {
        const cached = readRaw(_ACCESS_CODE_KEY);
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
let currentSortMode  = readRaw('salt_sort_mode', 'recent');
// Each sortable column's modes, in the order a click steps through them. The
// Identifier header also offers "recent" (last modified first), the default.
const SORT_MODES = {
    id:       ['numAsc', 'numDesc', 'recent'],
    time:     ['timeAsc', 'timeDesc'],
    size:     ['sizeAsc', 'sizeDesc'],
    activity: ['activityAsc', 'activityDesc'],
    location: ['locationAsc', 'locationDesc'],
};
let timeDisplayMode  = readRaw('salt_time_mode', 'zulu');
// Separator between the ATO designator and the workspace title: 'dash' | 'space'.
let atoTitleSep      = readRaw('salt_ato_title_sep', 'dash');

// --- Report format (builder) ---
// A format is an ordered list of lines: one for every workspace, synced via
// the server so the whole team composes reports the same way. It changes only
// when an operator edits it in the Builder, never by switching workspaces.
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
const isFormat = f => !!(f && Array.isArray(f.lines) && f.lines.length);
// Browsers from before it was shared kept one per workspace and the last one
// worked with; that last one carries over.
let sharedFormat = readStored('salt_format', null);
if (!isFormat(sharedFormat)) sharedFormat = readStored('salt_last_format', null);
if (!isFormat(sharedFormat)) sharedFormat = null;
removeStored('salt_ws_formats'); removeStored('salt_last_format');
const defaultFormat  = () => ({ preset: 'salt', lines: FORMAT_PRESETS['salt'].map(l => ({...l})) });
const currentFormat  = () => sharedFormat || defaultFormat();
const isStockFormat  = () => !sharedFormat || JSON.stringify(sharedFormat.lines) === JSON.stringify(FORMAT_PRESETS['salt']);
// Backup files keep the format under each workspace's name, as older versions read it.
const formatsFor = (atos) => Object.fromEntries(atos.map(a => [a, currentFormat()]));

// --- Overlays ---
// NAI / OBJ / PL features, one set shared by every workspace: imported in the
// Map tab and synced. Viewers keep none locally. Browsers from before
// they were shared kept them per workspace ('salt_ws_overlays'); those are
// folded into one set once.
if (viewerAtLoad) { removeStored('salt_ws_overlays'); removeStored('salt_overlays'); removeStored('salt_tags'); }
let sharedOverlays = viewerAtLoad ? [] : SaltCore.foldOverlays(readStored('salt_overlays', null) || readStored('salt_ws_overlays', []));
const storeOverlays = () => {
    if (isReadOnly || viewerAtLoad) return;
    writeStored('salt_overlays', JSON.stringify(sharedOverlays));
    removeStored('salt_ws_overlays');
};
// The workspace on screen: the editor's active one, or the viewer's pick.
const shownAto        = () => (isReadOnly ? viewerShowingAto : activeAto) || '';
const currentOverlays = () => sharedOverlays;
// The map's basemap services ([{ name, kind, url, layers? }]), shared like the
// overlays; each browser picks which one it shows.
let sharedBasemaps = viewerAtLoad ? [] : (Array.isArray(readStored('salt_basemaps', [])) ? readStored('salt_basemaps', []) : []);
const storeBasemaps = () => { if (!isReadOnly && !viewerAtLoad) writeStored('salt_basemaps', JSON.stringify(sharedBasemaps)); };
// Drones on the map ([{ name, grid, at, look?, range?, offStation? }]):
// shared like the basemaps.
let sharedDrones = viewerAtLoad ? [] : (Array.isArray(readStored('salt_drones', [])) ? readStored('salt_drones', []) : []);
const storeDrones = () => { if (!isReadOnly && !viewerAtLoad) writeStored('salt_drones', JSON.stringify(sharedDrones)); };
// FMV mode (Settings), for the whole team: { on: true | false }, or {} when
// no one has saved it yet. Then it is on when there are drones (a team
// already using them sees no change), else off. On, the map has its drones
// and the report form its Observer (app/63-map-drones.js).
const asFmv = (v) => (v && typeof v === 'object' && typeof v.on === 'boolean' ? { on: v.on } : {});
let sharedFmv = viewerAtLoad ? {} : asFmv(readStored('salt_fmv', {}));
const storeFmv = () => { if (!isReadOnly && !viewerAtLoad) writeStored('salt_fmv', JSON.stringify(sharedFmv)); };
const fmvSaved = () => typeof sharedFmv.on === 'boolean';
const fmvOn = () => (fmvSaved() ? sharedFmv.on : sharedDrones.length > 0);
// The drones on station: on the map, and in the Observer list.
const onStation = (d) => !d.offStation;
// The narrative's settings (app/81-narrative.js), shared the same way.
const asNarrative = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
let sharedNarrative = viewerAtLoad ? {} : asNarrative(readStored('salt_narrative', {}));
const storeNarrative = () => { if (!isReadOnly && !viewerAtLoad) writeStored('salt_narrative', JSON.stringify(sharedNarrative)); };
// The team's own tags for graphics ([{ id, name, color }], app/50-overlays.js),
// shared like the overlays; NAI, OBJ and PL are built in.
let sharedTags = viewerAtLoad ? [] : SaltCore.cleanTags(readStored('salt_tags', []));
const storeTags = () => { if (!isReadOnly && !viewerAtLoad) writeStored('salt_tags', JSON.stringify(sharedTags)); };
// The overlays a Location is read against: those with a built-in tag or one
// that still exists (a deleted tag's graphics have none until given one).
// The same list, by identity, until the overlays or the tags change.
let placeOverlaysOf = { ovs: null, tags: null, list: [] };
const placeOverlays = () => {
    if (placeOverlaysOf.ovs !== sharedOverlays || placeOverlaysOf.tags !== sharedTags) {
        const ids = new Set(sharedTags.map(t => t.id));
        const list = sharedOverlays.filter(o => o.type && (!SaltCore.TAG_ID.test(o.type) || ids.has(o.type)));
        placeOverlaysOf = { ovs: sharedOverlays, tags: sharedTags, list };
    }
    return placeOverlaysOf.list;
};
// What each Location box says against the overlays (grids, NAI/OBJ, nearest
// PL, checks, the team's tags). Cached by text; cleared whenever the overlays
// or the tags change.
const locationCache = new Map();
let locationCacheFor = null;
const locationInfo = (text) => {
    const ovs = placeOverlays();
    if (locationCacheFor !== ovs) { locationCache.clear(); locationCacheFor = ovs; }
    const key = String(text || '');
    if (!locationCache.has(key)) locationCache.set(key, SaltCore.analyzeLocation(key, ovs));
    return locationCache.get(key);
};

// --- BDA mode ---
// Hidden until enabled from the ellipsis menu. Assessments live on each
// report under `bda: []` and sync like everything else.
let bdaMode = readRaw('salt_bda_mode') === 'on';
// MGRS Lock (per browser): a grid zone and 100 km square ("11S NV") put in
// front of grids typed as digits alone, so operators type "39697 06762".
let mgrsLock = readRaw('salt_mgrs_lock') === 'on';
// Whether Log and Update add the NAIs, OBJs and PLs a grid is in or near to
// its Location (this browser's choice; on unless turned off). Off, they are
// only offered under the box, to add with a click.
let addNearby = readRaw('salt_add_nearby') !== 'off';
let mgrsLockPrefix = SaltCore.mgrsPrefix(readRaw('salt_mgrs_prefix', '')) || '';
document.body.classList.toggle('mgrs-lock', mgrsLock);
// The Location as it will be logged: with the locked prefix, when it is on.
const lockedLocation = (text) => (mgrsLock && mgrsLockPrefix ? SaltCore.applyMgrsPrefix(text, mgrsLockPrefix) : text);
document.body.classList.toggle('bda-mode', bdaMode);
// Chip picked in the roll-up strip: an effect name, 'unassessed', or null.
let bdaFilter = null;
const openBdaRows = new Set();
const openHistoryRows = new Set();
// What else survives a redraw of the table (a sync from another operator):
// the rows checked (report ids), the history rows checked ("id|lastModified")
// and the cells expanded ("id|column", "id|lastModified|column" on history).
const selectedRows = new Set();
const selectedHistory = new Set();
const expandedCells = new Set();
let isManageViewActive = false;
let pendingCsv         = null; // { headers, rows, filename }
let offlinePendingPush = readRaw('salt_offline_push') === 'true';
// Every workspace with changes the server hasn't taken yet (the active one,
// or another changed by Undo, Send or a backup import while it couldn't be
// reached), so each is sent again when it is back, not only the active one.
const pendingAtos = new Set((v => (Array.isArray(v) ? v : []))(readStored('salt_offline_push_atos', [])));
const markPending = (ato, pending) => {
    if (!ato || pendingAtos.has(ato) === pending) return;
    if (pending) pendingAtos.add(ato); else pendingAtos.delete(ato);
    writeStored('salt_offline_push_atos', JSON.stringify([...pendingAtos]));
};
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
let lastSavedReportsJson = readRaw('salt_reports_by_ato', '');
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
        reportNum, normalizeLocation, BDA_EFFECTS, bdaElements, bdaSummary, plural, zoneMark, timeAgo } = SaltCore;
// The lastModified for a report's next version: now, but always past the
// version it replaces. The server keeps the higher stamp, so a browser whose
// clock runs behind a peer's would otherwise have its change thrown away.
const nextStamp = (prev) => Math.max(Date.now(), ((prev && prev.lastModified) || 0) + 1);
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
// Resolves whether the text reached the clipboard, so a toast can say so.
// The Clipboard API needs a secure context; elsewhere (or if it refuses) the
// old copy command is tried, and focus goes back where it was.
const copyToClipboard = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* try the copy command */ }
    }
    const back = document.activeElement;
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'; document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') back.focus();
    return ok;
};
// POST a JSON body to the sync server. Resolves to the Response whatever its
// status; rejects only when the server can't be reached.
// This release. The server says its own in every sync; when they differ,
// a bar asks for a reload (the server's tests/test_docs.py checks they agree).
const APP_VERSION = '2.31.0';
// The server numbers every change (see broadcast_update in the server):
// `syncedVersion` is the change the data on screen is as of, `seenVersion`
// the newest heard of, from update notices and this page's own saves. A
// pull answer older than one seen is out of date before it lands.
let syncedVersion = 0, seenVersion = 0;
const noteChange = (v) => { if (typeof v === 'number' && v > seenVersion) seenVersion = v; };
const postJson = (path, body) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(res => { noteChange(Number(res.headers.get('X-Salt-Change')) || 0); return res; });
// POST and say how it went: { ok, status, message, body }, where message is
// the server's reason when it gives one and body its whole answer ({} when it
// sent none). Never throws: a server that can't be reached is status 0. A
// rejected access code (401) re-prompts for it.
const apiPost = async (path, body) => {
    let res;
    try {
        res = await postJson(path, body);
    } catch (e) {
        return { ok: false, status: 0, message: 'The server can\'t be reached.' };
    }
    const json = await res.json().catch(() => null);
    const said = json && typeof json.message === 'string' ? json.message.trim() : '';
    let message = said || (res.ok ? '' : `The server answered ${res.status}`);
    if (message && !/[.!?]$/.test(message)) message += '.';
    if (res.status === 401) handleUnauthorized();
    return { ok: res.ok, status: res.status, message, body: json && typeof json === 'object' ? json : {} };
};
// Save one of the shared lists (overlays, basemaps, drones, the narrative's
// settings) that the caller has already put on screen. Taken: `said` is shown,
// with Undo when `undo` is given. Not taken (refused, or the server can't be
// reached), `putBack` puts the list back as it was, and the reason is said:
// these aren't kept to send later, as reports are, so the screen shows what
// everyone has. `older`: what to say when the server is too old to know the
// list (it answers 404). Resolves true when the server took it.
const saveShared = async (path, body, { said = '', undo = null, putBack = () => {}, older = '' } = {}) => {
    const tell = () => { if (said) showToast(said, false, undo ? { ms: UNDO_MS, undo } : {}); };
    if (isLocalFile) { tell(); return true; }
    // A push, as far as pulls go: one landing meanwhile would put the list back.
    pushesInFlight++;
    let res;
    try { res = await apiPost(path, body); } finally { pushSettled(); }
    if (res.ok) { tell(); return true; }
    putBack();
    if (res.status === 401) return false;   // apiPost asked for the code again
    if (res.status === 404 && older) showToast(older, true, { ms: 10000 });
    else showToast(res.status === 0 ? "Not saved: the server can't be reached. Try again once it's back." : `Not saved: ${res.message}`, true, { ms: 8000 });
    return false;
};
// The toast for a save: `okText` when the server took it (or there is no
// server, opened from a file), else why not. Unreachable is not an error: the
// change is kept here.
// A control's "on" state, set in one place: what a screen reader is told
// (`attr`: aria-pressed for a toggle, aria-selected for a tab, aria-expanded
// for what opens something) and the class it is drawn with (`cls`, or none
// when the CSS reads the attribute), so the two can't disagree.
const setOn = (node, on, attr = 'aria-pressed', cls = 'active') => {
    if (!node) return;
    node.setAttribute(attr, String(!!on));
    if (cls) node.classList.toggle(cls, !!on);
};
// Said when reports are kept here to send later: the same words everywhere.
const SENT_LATER = "Saved here; it's sent once the server can be reached.";
const saveToast = (r, okText) => {
    if (r.ok || isLocalFile) showToast(okText);
    else if (r.status === 0) showToast('Saved here; the server can\'t be reached.');
    else showToast(`Not saved: ${r.message}`, true);
};
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
        if (menu.scrollHeight > room) menu.style.maxHeight = `${Math.max(80, room)}px`;
    }
});

// The view switcher's icons: the open view's is highlighted.
const setViewIcon = (id, on) => {
    const b = document.getElementById(id);
    setOn(b, on);
};

// A table row brought to the middle of `view`, the box that scrolls it, and
// flashed (scrollIntoView would move the page too).
const showRow = (tr, view) => {
    const vr = view.getBoundingClientRect(), r = tr.getBoundingClientRect();
    const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    view.scrollBy({ top: r.top - vr.top - (view.clientHeight - r.height) / 2, behavior: still ? 'auto' : 'smooth' });
    tr.classList.add('flash');
    setTimeout(() => tr.classList.remove('flash'), 1500);
};

// --- 4. Notifications (toasts + confirmation dialog) ---
let toastTimer = null;
let toastsShown = 0;   // so a late toast can tell whether another came first
// The toast's clock: when it hides, and, while held (an Undo toast under the
// pointer or holding focus), how long it has left.
let toastUntil = 0, toastLeft = 0, toastHeld = false, toastHasUndo = false;
const hideToastIn = (ms) => {
    clearTimeout(toastTimer);
    toastUntil = Date.now() + ms;
    toastTimer = setTimeout(() => el.toast.regular.classList.remove('show'), ms);
};
const toastInUse = () => el.toast.regular.matches(':hover') || el.toast.regular.contains(document.activeElement);
// `ms` is how long the toast stays; `undo` adds an Undo button that runs it.
// Screen readers hear it as a status, an error at once (an alert).
const showToast = (msg, isErr = false, { ms = 4000, undo = null } = {}) => {
    toastsShown++;
    const t = el.toast.regular;
    t.textContent = msg;
    if (undo) {
        const btn = document.createElement('button');
        btn.className = 'toast-undo';
        btn.textContent = 'Undo';
        btn.addEventListener('click', () => { clearTimeout(toastTimer); toastHeld = false; t.classList.remove('show'); undo(); });
        t.appendChild(btn);
    }
    // The error red is a class: dark enough for its white text to be read.
    t.style.backgroundColor = isErr ? '' : 'rgba(28,28,30,0.85)';
    t.classList.toggle('toast-error', isErr);
    t.setAttribute('role', isErr ? 'alert' : 'status');
    t.setAttribute('aria-live', isErr ? 'assertive' : 'polite');
    t.classList.add('show');
    // Restart the clock, so an earlier toast's timer can't hide this one early.
    toastHasUndo = !!undo;
    if (undo && toastInUse()) { clearTimeout(toastTimer); toastHeld = true; toastLeft = ms; }
    else { toastHeld = false; hideToastIn(ms); }
};
// An Undo toast waits while the pointer is on it or focus is in it, and
// then has the rest of its time.
const holdToast = () => {
    if (!toastHasUndo || toastHeld || !el.toast.regular.classList.contains('show')) return;
    toastHeld = true;
    clearTimeout(toastTimer);
    toastLeft = Math.max(2000, toastUntil - Date.now());
};
const releaseToast = () => {
    if (!toastHeld || toastInUse()) return;
    toastHeld = false;
    if (el.toast.regular.classList.contains('show')) hideToastIn(toastLeft);
};
el.toast.regular.addEventListener('mouseenter', holdToast);
el.toast.regular.addEventListener('focusin', holdToast);
el.toast.regular.addEventListener('mouseleave', releaseToast);
el.toast.regular.addEventListener('focusout', () => setTimeout(releaseToast, 0));
const UNDO_MS = 10000;

// --- Dialogs ---
// Each takes focus when it opens (its safe or main button), keeps Tab inside
// it while open, and gives focus back to whatever had it when it closes.
const dialogOpeners = new Map();   // dialog -> what had focus before it opened
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const focusablesIn = (box) => [...box.querySelectorAll(FOCUSABLE)]
    .filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
const enterDialog = (box, target) => {
    // From the Settings menu, which closes behind it: back to the menu's button.
    const from = el.menu.panel.contains(document.activeElement) ? el.menu.btn : document.activeElement;
    if (!dialogOpeners.has(box)) dialogOpeners.set(box, from);
    const to = target || focusablesIn(box)[0];
    if (to) to.focus();
};
const leaveDialog = (box) => {
    const back = dialogOpeners.get(box);
    dialogOpeners.delete(box);
    // Unless what was picked put focus somewhere else on purpose.
    const now = document.activeElement;
    const lost = !now || now === document.body || box.contains(now);
    if (lost && back && back !== document.body && back.isConnected && typeof back.focus === 'function') back.focus();
};
// The modal dialogs, topmost first; Tab stays in the first one open.
const modalDialogs = () => [document.getElementById('choiceToast'), el.toast.confirm, el.startup.overlay, el.manual.modal];
document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const box = modalDialogs().find(b => b && b.classList.contains('show'));
    if (!box) return;
    const items = focusablesIn(box);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// One prompt at a time: a new prompt replaces an unanswered one and drops its
// action, so Confirm only ever runs what the dialog is showing.
let pendingConfirm = null;
const hideConfirmation = () => { el.toast.confirm.classList.remove('show'); pendingConfirm = null; leaveDialog(el.toast.confirm); };

// A question with several answers: `options` are { label, value, primary? };
// resolves to the value picked, or null for Cancel (or Escape). A new
// question answers an open one with null.
let pendingChoice = null;
const askChoice = (message, detail, options) => {
    if (pendingChoice) pendingChoice(null);
    const box = document.getElementById('choiceToast');
    document.getElementById('choiceMessage').textContent = message;
    document.getElementById('choiceDetail').textContent = detail || '';
    const buttons = document.getElementById('choiceButtons');
    buttons.innerHTML = '';
    return new Promise(resolve => {
        const done = (value) => { pendingChoice = null; box.classList.remove('show'); leaveDialog(box); resolve(value); };
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
        enterDialog(box, buttons.querySelector('.choice-primary') || buttons.firstChild);
    });
};
// Focus starts on Cancel: what Confirm runs usually can't be taken back.
const showConfirmation = (msg, onConfirm) => {
    el.toast.message.textContent = msg;
    pendingConfirm = onConfirm;
    el.toast.confirm.classList.add('show');
    enterDialog(el.toast.confirm, el.toast.cancelBtn);
};
el.toast.confirmBtn.addEventListener('click', () => { const run = pendingConfirm; hideConfirmation(); if (run) run(); });
el.toast.cancelBtn .addEventListener('click', hideConfirmation);

// --- Removing: asked in place, then Undo ---
// Every remove asks first, on the control itself: the first press turns it
// (or the name beside it) into "… for everyone?" where it is, so nothing
// else moves; a second press removes, and the toast then offers Undo. Any
// other button pressed lets the question go. One control asks at a time:
// `key` names it, and `redraw` draws its owner with or without the
// question. The asking control carries data-asking, and keeps focus over
// the redraw, so the second press can come from the keyboard.
let askNow = null;   // { key, redraw }
const isAsking = (key) => !!askNow && askNow.key === key;
const askingAbout = (prefix) => (askNow && askNow.key.startsWith(prefix) ? askNow.key : null);
const forgetAsk = () => { askNow = null; };
// Said to screen readers: a control that is its own question says it here
// (a row's question is said by its own role="status").
const askSaid = document.createElement('div');
askSaid.className = 'visually-hidden';
askSaid.setAttribute('role', 'status');
document.body.appendChild(askSaid);
// Draw, and give focus back to the control that had it, found again by its
// id and data attributes when the drawing replaced it.
const refocusAfter = (draw) => {
    const had = document.activeElement;
    draw();
    const now = document.activeElement;
    if (!had || had === document.body || had.isConnected || (now && now !== document.body)) return;
    const named = [...had.attributes].filter(a => (a.name === 'id' || a.name.startsWith('data-')) && a.name !== 'data-asking')
        .map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
    const again = named && [...document.querySelectorAll(had.tagName.toLowerCase() + named)].find(n => n.getClientRects().length);
    if (again) again.focus({ preventScroll: true });
};
// True on the second press (go ahead); the first press asks, and is false.
const askFirst = (key, redraw) => {
    if (isAsking(key)) { askNow = null; askSaid.textContent = ''; refocusAfter(redraw); return true; }
    if (askNow) { const was = askNow.redraw; askNow = null; refocusAfter(was); }
    askNow = { key, redraw };
    refocusAfter(redraw);
    const q = document.querySelector('[data-asking]');
    const text = q ? q.textContent.trim() : '';
    askSaid.textContent = text.endsWith('?') ? text : '';
    return false;
};
const letGo = () => {
    if (!askNow) return;
    const { redraw } = askNow;
    askNow = null;
    askSaid.textContent = '';
    refocusAfter(redraw);
};
// Any other button pressed: let go before its own handler runs.
document.addEventListener('click', e => {
    const b = askNow && e.target.closest && e.target.closest('button');
    if (b && !b.hasAttribute('data-asking')) letGo();
}, true);
// The toast that offers Undo after a removal.
const undoToast = (msg, undo) => showToast(msg, false, { ms: UNDO_MS, undo });

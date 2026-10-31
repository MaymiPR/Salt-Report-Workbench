// SPDX-License-Identifier: AGPL-3.0-only

// Restore saved state, then connect.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// ═══════════════════════════════════════════════════════════════
// 11. STARTUP
// Restores saved session state then connects to the server.
// ═══════════════════════════════════════════════════════════════
// Anything that goes wrong unexpectedly is said, not left silent (at most
// one a few seconds, should one fault repeat).
let lastErrorSaid = 0;
const sayUnexpected = (what) => {
    if (Date.now() - lastErrorSaid < 5000) return;
    lastErrorSaid = Date.now();
    showToast(`Something went wrong: ${what || 'unknown error'}. Your reports are kept; reload the page if it misbehaves.`, true, { ms: 8000 });
};
window.addEventListener('error', e => {
    // The browser's own layout notice, harmless.
    if (/ResizeObserver loop/.test(e.message || '')) return;
    sayUnexpected(e.message || (e.error && e.error.message));
});
window.addEventListener('unhandledrejection', e => sayUnexpected(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
// Closing the tab with changes the server hasn't taken: the browser asks
// first. They are kept here and sent when it's opened again, but only on
// this machine, so the others don't see them till then.
window.addEventListener('beforeunload', e => {
    // Starting a new mission: what waited was offered as a file first.
    if (missionReloading) return;
    const refused = Object.values(unsaved).some(entries => Object.keys(entries).length);
    if (!changesWaiting() && !(refused && !isReadOnly)) return;
    e.preventDefault();
    e.returnValue = '';
});
el.status.version.textContent = `v${APP_VERSION}`;

setProfileFromLocalStorage();
updateTimeBtnText();
updateSepBtnText();
updateBdaBtnText();
updateMgrsLockUI();
updateNearbyBtnText();
applyFmvMode();
updateSortIcons();
if (readRaw('salt_layout')==='horizontal') el.layout.grid.classList.add('horizontal-layout');
applyLayoutMode();

const lastAto    = readRaw('salt_last_active_ato');
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
const lastView = readRaw('salt_view');
if (lastView==='export') openManageView();
else if (lastView==='stats') openStatsView();
else if (lastView==='summary') openSummaryView();
else showHomeView();

syncWithServer().then(() => {
    // Opened from a file there is no server to hear from: no reconnect loop.
    if (!isLocalFile) initSSE();
    // Re-check after sync — server state may have revealed missing pieces.
    // No-op when the modal is already open.
    maybeShowStartupModal();
    // Belt-and-suspenders: ensure the gate is lifted after sync, in case
    // some unusual code path left it set.
    if (!el.startup.overlay.classList.contains('show')) {
        document.documentElement.classList.remove('salt-ready-gate');
    }
});

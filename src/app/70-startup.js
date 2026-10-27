// SPDX-License-Identifier: AGPL-3.0-only

// Restore saved state, then connect.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

// ═══════════════════════════════════════════════════════════════
// 11. STARTUP
// Restores saved session state then connects to the server.
// ═══════════════════════════════════════════════════════════════
setProfileFromLocalStorage();
updateTimeBtnText();
updateSepBtnText();
updateBdaBtnText();
updateMgrsLockUi();
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
else if (localStorage.getItem('salt_view')==='stats') openStatsView();
else if (localStorage.getItem('salt_view')==='summary') openSummaryView();
else if (localStorage.getItem('salt_view')==='map') openMapView();

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

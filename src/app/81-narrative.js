// SPDX-License-Identifier: AGPL-3.0-only

// The narrative's settings, in a column beside the Narrative: what the enemy
// is called, which way they move in the AO (its way of march, which an axis
// of advance overrides near it), the units and where they operate, equipment the team adds to
// the catalogue (or puts right), the built-in rules switched on or off, the
// team's own rules, and the elevation source the ground is read from. Shared
// with everyone like the basemaps; editors change them, viewers see them.
// The narrative itself is SaltCore's; the heights it reads come from the
// sync server (askTerrain).
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let narrTab = 'units';
let narrOpen = null;        // the item open in the panel: { id (null: a new one), entry (as opened), fill? }
let narrBuilt = null;       // what the panel was last built from, so a sync doesn't rebuild it under the cursor
let narrTerrain = null;     // the Terrain form as it is being filled in, else null (the saved source)
let narrTerrainSays = '';   // what Test as elevation last said

const narrList = (k) => (Array.isArray(sharedNarrative[k]) ? sharedNarrative[k] : []);
// The team's own equipment, ready for SaltCore: Statistics, Summary and BDA
// fold its plurals the same way the narrative does.
const narrTeam = () => SaltCore.teamEquipment(narrList('equipment'));
// What an entry is known by however the list changes round it: a unit's
// name, a type of equipment, a rule's judgment and words.
const narrId = (k, x) => (k === 'units' ? String(x.name || '').trim().toLowerCase()
    : k === 'equipment' ? String(x.type || '').trim().toUpperCase()
    : `${String(x.what || '').trim()}|${String(x.words || '').trim()}`.toLowerCase());
const ROLE_NAMES = Object.fromEntries(SaltCore.EQUIPMENT_ROLES);
// The AO's way of march: the compass points the server takes (_MARCH_DIRECTIONS), or none.
const NARR_TOWARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const narrToward = () => (NARR_TOWARD.includes(sharedNarrative.toward) ? sharedNarrative.toward : '');
const ORIGIN_NAMES = { '': 'Any army', RU: 'Russian', CN: 'Chinese' };
// How a type moves (SaltCore.RUNNING_GEARS), as the form and lists say it.
const GEAR_NAMES = { '': 'Not said', tracked: 'Tracked', wheeled: 'Wheeled', towed: 'Towed', portable: 'Carried', foot: 'On foot', air: 'Flies', static: 'Fixed' };
const CHEVRON = '<svg class="narr-chevron" viewBox="0 0 8 14" width="7" height="12" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Shown here at once; refused by the server, the settings go back to what
// they were (unless a sync has replaced them since). A server that can't be
// reached, or is too old to share them, leaves the change in this browser.
// `undo`, for a removal: the toast offers it.
const saveNarrative = (changes, said, undo = null) => {
    const before = sharedNarrative;
    const mine = sharedNarrative = { enemy: '', units: [], equipment: [], off: [], custom: [], ...sharedNarrative, ...changes };
    storeNarrative();
    narrOpen = null;
    narrBuilt = null;
    renderSummary();
    return saveShared('/api/save_narrative', { narrative: mine }, { said, undo,
        // A server from before these settings: says so, rather than "Not Found".
        older: "This server is an older version and can't share these settings: restart it with this version.",
        putBack: () => {
            if (sharedNarrative === mine) { sharedNarrative = before; storeNarrative(); narrBuilt = null; renderSummary(); }
        } });
};

// The NAIs and OBJs a unit can be placed in: every overlay, and whatever reports name.
const narrPlaces = () => SaltCore.summaryPlaces(localReports.filter(r => !r.deleted), currentOverlays()).filter(p => !/^PL /.test(p));
// Types in the reports the catalogue doesn't know (the team's entries included).
const narrUnknown = () => {
    const team = narrTeam();
    return [...new Set(localReports.filter(r => !r.deleted).flatMap(r => SaltCore.sizeElements(r.size, team).map(e => e.type)))]
        .filter(t => !SaltCore.lookupEquipment(t, team)).sort().slice(0, 30);
};

// --- Heights ---

// The heights the narrative reads (SaltCore.terrainPoints), from the sync
// server's /api/elevation, which asks the elevation source once for everyone
// and keeps the answers. Kept here by SaltCore.terrainKey (null: no data
// there). A source changed starts afresh. Points the server is still asking
// come with the next ask, a moment later; those its source failed on, a
// minute later. Not on a page opened as a file: it has no server.
const terrainHeights = new Map();
let terrainFor = '';        // the source the heights are for (sharedNarrative.terrain, as JSON)
let terrainAsking = false;
let terrainRetry = null;
let terrainNote = '';       // why the source last failed, or ''
let terrainEmpty = 0;       // answers in a row that said the server has no source
const TERRAIN_BATCH = 500, TERRAIN_SOON_MS = 2000, TERRAIN_LATER_MS = 60000;
const terrainSet = () => !!(sharedNarrative.terrain && sharedNarrative.terrain.basemap);
// The points to ask, worked out again only when the reports, overlays or
// settings have changed: an observer's lines of sight are many points.
let terrainPointsFor = '', terrainPointsWere = [];
// And the map's (askTerrainFor), by what wants them: the picked report's
// lines ('pick'), the line of sight tool's ('tool').
const terrainExtra = { pick: [], tool: [] };
const terrainPointsNow = () => {
    const live = localReports.filter(r => !r.deleted), overlays = currentOverlays();
    const key = JSON.stringify([live.length, live.reduce((n, r) => Math.max(n, r.lastModified || 0), 0), overlays.length, sharedNarrative]);
    if (key !== terrainPointsFor) { terrainPointsFor = key; terrainPointsWere = SaltCore.terrainPoints(live, overlays, sharedNarrative); }
    return terrainPointsWere;
};
const askTerrain = async () => {
    const source = JSON.stringify(sharedNarrative.terrain || null);
    if (source !== terrainFor) { terrainHeights.clear(); terrainFor = source; terrainNote = ''; clearTimeout(terrainRetry); terrainRetry = null; }
    if (isLocalFile || terrainAsking || terrainRetry || !terrainSet()) return;
    const want = [...terrainPointsNow(), ...terrainExtra.pick, ...terrainExtra.tool].filter(([lon, lat]) => !terrainHeights.has(SaltCore.terrainKey(lon, lat)));
    if (!want.length) return;
    const pts = want.slice(0, TERRAIN_BATCH);
    terrainAsking = true;
    const res = await apiPost('/api/elevation', { points: pts });
    terrainAsking = false;
    if (source !== JSON.stringify(sharedNarrative.terrain || null)) { askTerrain(); return; }
    // What shows the heights is drawn again when some came, or when why
    // they aren't coming changed (the map then says so).
    const noteWas = terrainNote;
    const shown = (got) => {
        if (!got && terrainNote === noteWas) return;
        if (isSummaryViewActive && summaryKind === 'narrative') renderSummary();
        if (isMapViewActive) { redrawMap(); renderMapCard(); showMeasure(); }
    };
    if (!res.ok) { terrainNote = res.message; shown(0); return; }
    const { source: on = '', heights = [], pending = [], unknown = [], error = '' } = res.body;
    // The server knows no source yet (this page saved one a moment ago):
    // nothing to keep, so ask again soon, then now and then.
    if (!on) {
        terrainEmpty++;
        terrainRetry = setTimeout(() => { terrainRetry = null; askTerrain(); }, terrainEmpty <= 3 ? TERRAIN_SOON_MS : TERRAIN_LATER_MS);
        return;
    }
    terrainEmpty = 0;
    const open = new Set([...pending, ...unknown]);
    let got = 0;
    pts.forEach(([lon, lat], i) => { if (!open.has(i)) { terrainHeights.set(SaltCore.terrainKey(lon, lat), heights[i] ?? null); got++; } });
    terrainNote = error;
    if (pending.length || want.length > pts.length || unknown.length) {
        terrainRetry = setTimeout(() => { terrainRetry = null; askTerrain(); }, pending.length || want.length > pts.length ? TERRAIN_SOON_MS : TERRAIN_LATER_MS);
    }
    shown(got);
};
// Heights the map wants as well (`what`: 'pick' or 'tool'), asked for once
// each; nothing new, nothing asked.
const askTerrainFor = (points, what) => {
    if (!terrainSet() || points.every(([lon, lat]) => terrainHeights.has(SaltCore.terrainKey(lon, lat)))) return;
    if (JSON.stringify(points) === JSON.stringify(terrainExtra[what])) return;
    terrainExtra[what] = points;
    askTerrain();
};
// What the narrative is given of the ground: whether there is a source, the
// heights known, and why the source last failed (on a page opened as a
// file, that none can be asked).
const TERRAIN_FILE_NOTE = 'a page opened as a file has no server to ask for them';
const terrainInput = () => ({ on: terrainSet(), heights: terrainHeights, note: isLocalFile ? TERRAIN_FILE_NOTE : terrainNote });
// For the map, while heights it wants aren't in: why they aren't coming,
// when that is known, or ''.
const terrainUnavailable = () => {
    const why = terrainInput().note.replace(/[.]$/, '');
    return why ? `Heights not available: ${/^[A-Z][a-z]/.test(why) ? why[0].toLowerCase() + why.slice(1) : why}.` : '';
};

// --- The parts ---

// One choice of several, as radio buttons: the arrow keys move between them,
// and only the one picked (else the first) is a tab stop. `items` are [value, label].
const radios = (attr, label, items, picked) => {
    const at = Math.max(0, items.findIndex(([v]) => v === picked));
    return `<div class="narr-chips" data-narr-single role="radiogroup" aria-label="${escapeHtml(label)}">${items.map(([v, l], i) =>
        `<button type="button" class="narr-chip" role="radio" ${attr}="${escapeHtml(v)}" aria-checked="${v === picked}" tabindex="${i === at ? 0 : -1}">${escapeHtml(l)}</button>`).join('')}</div>`;
};
// A list row: the whole row opens it (editors); a chevron says so. `id` is
// the entry's, as narrId gives it.
const row = (i, name, meta, id) => (isReadOnly
    ? `<div class="narr-row"><span class="narr-name">${escapeHtml(name)}</span><span class="narr-meta">${escapeHtml(meta)}</span></div>`
    : `<button type="button" class="narr-row" data-narr-edit="${i}" data-narr-id="${escapeHtml(id)}"><span class="narr-name">${escapeHtml(name)}</span><span class="narr-meta">${escapeHtml(meta)}</span>${CHEVRON}</button>`);
const addRow = (label) => `<button type="button" class="narr-add editor-only" data-narr-add>+ ${label}</button>`;
// The form's foot: Save and, for one already saved, Remove, which asks
// first on its own face. The question is drawn in place, so what is being
// filled in above it stays as it is.
const narrAskKey = () => `narr|${narrTab}|${narrOpen && narrOpen.id}`;
const removeLabel = (ask) => (ask ? 'Remove for everyone?' : 'Remove');
const formFoot = (saved) => {
    const ask = saved && isAsking(narrAskKey());
    return `<div class="narr-foot">
        <button type="button" class="set-btn" data-narr-save>Save</button>
        ${saved ? `<button type="button" class="text-btn map-base-remove${ask ? ' sure' : ''}" data-narr-remove${ask ? ' data-asking' : ''}>${removeLabel(ask)}</button>` : ''}
    </div>`;
};
const drawNarrRemove = () => {
    const b = document.querySelector('#narrSettings [data-narr-remove]');
    if (!b) return;
    const ask = isAsking(narrAskKey());
    b.textContent = removeLabel(ask);
    b.classList.toggle('sure', ask);
    b.toggleAttribute('data-asking', ask);
};
// An open item: back to its list, its title, then its form.
const drill = (back, title, body) => `<button type="button" class="narr-back" data-narr-back>
        <svg viewBox="0 0 8 14" width="7" height="12" aria-hidden="true"><path d="M7 1L1 7l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${back}</button>
    <div class="narr-drill-title">${escapeHtml(title)}</div>${body}`;

// --- Units ---

// A dropdown that picks several: its button says what's picked (or `none`),
// its menu ticks each option (a group of toggle buttons); it stays open while
// you pick, and closes on a click elsewhere or Escape. `label` is what it
// asks, shown above it; `options` are [value, label, on].
const ddLabel = (dd) => {
    const on = [...dd.querySelectorAll('.narr-dd-opt[aria-pressed="true"]')].map(o => o.dataset.label);
    dd.querySelector('.narr-dd-value').textContent = on.join(', ') || dd.dataset.none;
};
const dropdown = (name, attr, label, none, options) => {
    const on = options.filter(([, , o]) => o).map(([, l]) => l);
    return `<div class="narr-label" id="narrDdLabel-${name}">${escapeHtml(label)}</div>
    <div class="narr-dd" data-narr-dd="${name}" data-none="${escapeHtml(none)}">
        <button type="button" class="narr-dd-btn" aria-expanded="false" aria-controls="narrDdMenu-${name}" aria-labelledby="narrDdLabel-${name} narrDdValue-${name}">
            <span class="narr-dd-value" id="narrDdValue-${name}">${escapeHtml(on.join(', ') || none)}</span>
            <svg viewBox="0 0 12 8" width="10" height="7" aria-hidden="true"><path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="narr-dd-menu" id="narrDdMenu-${name}" role="group" aria-labelledby="narrDdLabel-${name}" hidden>${options.map(([v, l, o]) =>
            `<button type="button" class="narr-dd-opt" ${attr}="${escapeHtml(v)}" data-label="${escapeHtml(l)}" aria-pressed="${!!o}">${escapeHtml(l)}</button>`).join('')}</div>
    </div>`;
};
// A radio picked: the only one checked in its group, and its tab stop.
const pickRadio = (r) => {
    r.parentElement.querySelectorAll('[role="radio"]').forEach(o => { o.setAttribute('aria-checked', String(o === r)); o.tabIndex = o === r ? 0 : -1; });
};
const closeDropdowns = (except = null) => document.querySelectorAll('.narr-dd').forEach(dd => {
    if (dd === except) return;
    dd.querySelector('.narr-dd-menu').hidden = true;
    dd.querySelector('.narr-dd-btn').setAttribute('aria-expanded', 'false');
});

const unitForm = (u) => {
    const known = narrPlaces();
    const on = new Set((u.places || []).map(p => p.toUpperCase()));
    const other = (u.places || []).filter(p => !known.some(k => k.toUpperCase() === p.toUpperCase()));
    const kinds = new Set(u.kinds || []);
    // Other: places not in the list (a 10 km square, say), typed in the box it brings up.
    return `<div class="narr-form">
        <input type="text" id="narrUnitName" value="${escapeHtml(u.name || '')}" placeholder="Unit, e.g. 1-60 GMRB" maxlength="60" spellcheck="false" aria-label="Unit">
        ${dropdown('place', 'data-narr-place', 'Where it operates', 'Anywhere', [...known.map(p => [p, p, on.has(p.toUpperCase())]), ['', 'Other', other.length > 0]])}
        <input type="text" id="narrUnitOther" value="${escapeHtml(other.join(', '))}" placeholder="Other places, e.g. 11S NV 31" maxlength="400" spellcheck="false" aria-label="Other places, comma-separated"${other.length ? '' : ' hidden'}>
        ${dropdown('kind', 'data-narr-kind', 'What it has', 'Any equipment', SaltCore.EQUIPMENT_ROLES.map(([r, t]) => [r, t, kinds.has(r)]))}
        ${formFoot(narrOpen.id !== null)}
    </div>`;
};
const unitsTab = () => {
    if (narrOpen) {
        const u = narrOpen.id !== null ? narrOpen.entry : {};
        return drill('Units', u.name || 'New unit', unitForm(u));
    }
    const units = narrList('units');
    return `<div class="narr-list">${units.map((u, i) => row(i, u.name,
            [(u.places || []).join(', ') || 'Anywhere', (u.kinds || []).map(k => ROLE_NAMES[k]).join(', ')].filter(Boolean).join(' · '), narrId('units', u))).join('')
            || '<div class="narr-empty">No units yet. Add the units you track, and where they operate, to have judgments name them.</div>'}</div>
        ${addRow('Add a unit')}`;
};

// --- Equipment ---

// A reach (SaltCore's { m, by }) as the form and lists say it: 5.5 km.
const reachKm = (r) => `${+(r.m / 1000).toFixed(1)} km`;
// What the catalogue makes of a name now: the team's entry, the built-in one, or nothing.
const lookupSays = (type) => {
    if (!type.trim()) return '';
    const said = k => `${ROLE_NAMES[k.role]} (${k.name}${k.origin ? `, ${ORIGIN_NAMES[k.origin]}` : ''})${k.gear ? `, ${GEAR_NAMES[k.gear].toLowerCase()}` : ''}`
        + `${k.reach && k.reach.m ? `, reaches ${reachKm(k.reach)}${k.reach.by !== k.name ? ` (${k.reach.by})` : ''}` : ''}`;
    const own = SaltCore.lookupEquipment(type, SaltCore.teamEquipment(narrList('equipment')));
    const built = SaltCore.lookupEquipment(type);
    const reachOf = (k) => (k.reach ? k.reach.m : -1);
    if (own && (!built || own.role !== built.role || own.name !== built.name || own.gear !== built.gear || reachOf(own) !== reachOf(built))) return `Yours: ${said(own)}.`;
    return built ? `Built in: ${said(built)}.` : 'Not in the catalogue.';
};
const equipmentForm = (e) => `<div class="narr-form">
        <input type="text" id="narrEqType" value="${escapeHtml(e.type || '')}" placeholder="Type, e.g. BTR-4" maxlength="40" spellcheck="false" aria-label="Type">
        <div class="narr-says" id="narrEqSays">${escapeHtml(lookupSays(e.type || ''))}</div>
        <div class="narr-label">What it is</div>
        ${radios('data-narr-role', 'What it is', SaltCore.EQUIPMENT_ROLES, e.role)}
        <div class="narr-label">Army</div>
        ${radios('data-narr-origin', 'Army', Object.entries(ORIGIN_NAMES), e.origin || '')}
        <div class="narr-label">Moves on</div>
        ${radios('data-narr-gear', 'Moves on', Object.entries(GEAR_NAMES), e.gear || '')}
        <div class="narr-label">Reach</div>
        <div class="narr-sentence">
            <input type="number" id="narrEqReach" value="${escapeHtml(e.reach ? String(e.reach) : '')}" min="0.1" max="${SaltCore.REACH_MAX_KM}" step="any" inputmode="decimal" placeholder="km" aria-label="Reach in km"><span>km</span></div>
        <div class="narr-hint">How far its main weapon reaches, for armor, mechanized infantry, antitank weapons, artillery and air defense. Empty keeps the catalogue's, if it has one.</div>
        ${formFoot(narrOpen.id !== null)}
    </div>`;
const equipmentTab = () => {
    if (narrOpen) {
        const e = narrOpen.id !== null ? narrOpen.entry : { type: narrOpen.fill || '', role: '' };
        return drill('Equipment', e.type || 'New entry', equipmentForm(e));
    }
    const unknown = narrUnknown();
    // The built-in catalogue, by kind: Russian and Chinese types with their
    // variants, then the plain words.
    const CAPS = /^(MBT|IFV|APC|BMP|BMD|BTR|MRAP|BRDM|UAV|UAS|SPG|MLRS|MRL|ADA|SAM|AAA|MANPADS|ATGM|RPG|AVLB|POL|CP|HQ|C2|EW|PAX|ATV|UTV|SUV)$/;
    const builtIn = SaltCore.EQUIPMENT_ROLES.map(([r, t]) => {
        const of = (o) => SaltCore.EQUIPMENT_CATALOGUE.filter(e => e[0] === r && e[1] === o)
            .map(([, , name, ...more]) => { const v = more.filter(m => m !== name); return v.length ? `${name} (${v.join(', ')})` : name; });
        const armies = [['RU', 'Russian'], ['CN', 'Chinese']].map(([o, n]) => (of(o).length ? `<div><em>${n}:</em> ${escapeHtml(of(o).join('; '))}</div>` : '')).join('');
        const plain = [...new Set(SaltCore.EQUIPMENT_CATALOGUE.filter(e => e[0] === r && !e[1]).flatMap(([, , , ...more]) => more.map(m => (CAPS.test(m) ? m : m.toLowerCase()))))];
        return `<div class="narr-cat"><strong>${escapeHtml(t)}</strong>${armies}${plain.length ? `<div><em>Plain words:</em> ${escapeHtml(plain.join(', '))}</div>` : ''}</div>`;
    }).join('');
    return `${unknown.length && !isReadOnly ? `<div class="narr-label">In your reports, not in the catalogue</div>
            <div class="narr-chips">${unknown.map(t => `<button type="button" class="narr-chip narr-new" data-narr-fill="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        <div class="narr-find">
            <input type="text" id="narrEqFind" placeholder="Look up a type, e.g. T-72B3" maxlength="40" spellcheck="false" aria-label="Look up a type">
            <div class="narr-says" id="narrEqFindSays"></div>
        </div>
        <div class="narr-label">Yours</div>
        <div class="narr-list">${narrList('equipment').map((e, i) => row(i, e.type, `${ROLE_NAMES[e.role] || e.role} · ${ORIGIN_NAMES[e.origin || '']}${e.gear ? ` · ${GEAR_NAMES[e.gear] || e.gear}` : ''}${e.reach ? ` · ${e.reach} km` : ''}`, narrId('equipment', e))).join('')
            || '<div class="narr-empty">None yet: the built-in catalogue only.</div>'}</div>
        ${addRow('Add a type')}
        <details class="narr-builtin"><summary>Built-in catalogue</summary>${builtIn}</details>`;
};

// --- Rules ---

const ruleForm = (c) => `<div class="narr-form">
        <div class="narr-sentence"><span>${escapeHtml(String(sharedNarrative.enemy || '').trim() || 'Enemy forces')}</span>
            <input type="text" id="narrRuleWhat" value="${escapeHtml(c.what || '')}" placeholder="are preparing a river crossing" maxlength="120" spellcheck="false" aria-label="Judgment">
            <span>in the place,</span></div>
        <div class="narr-sentence"><span>when reports say</span>
            <input type="text" id="narrRuleWords" value="${escapeHtml(c.words || '')}" placeholder="bridge, ferry, PMP" maxlength="300" spellcheck="false" aria-label="Words, comma-separated"></div>
        <div class="narr-sentence">
            <input type="number" id="narrRuleMin" value="${c.min || 2}" min="1" max="20" aria-label="Reports"><span>times or more within</span>
            <input type="number" id="narrRuleHours" value="${c.hours || 12}" min="1" max="168" aria-label="Hours"><span>hrs.</span></div>
        <div class="narr-hint">Starts at roughly even chance; one more report makes it likely, three more very likely.</div>
        ${formFoot(narrOpen.id !== null)}
    </div>`;
const rulesTab = () => {
    if (narrOpen) {
        const c = narrOpen.id !== null ? narrOpen.entry : {};
        return drill('Rules', c.what || 'New rule', ruleForm(c));
    }
    const off = new Set(narrList('off'));
    const groups = [...new Set(SaltCore.NARRATIVE_RULES.map(r => r[3]))];
    // The team's own first, with the button to add one at the right of their
    // heading; then the built-in rules by kind.
    return `<div class="narr-label narr-label-row"><span>Your own</span><button type="button" class="narr-add narr-add-top editor-only" data-narr-add>+ Add a rule</button></div>
        <div class="narr-list">${narrList('custom').map((c, i) => row(i, c.what, `${c.words} · ${c.min} in ${c.hours} hrs`, narrId('custom', c))).join('')
            || '<div class="narr-empty">None yet: a judgment, the words that point to it, and how often.</div>'}</div>
        <div class="narr-hint">Each judgment uses Russian or PLA doctrine, by the design of the equipment in its reports.</div>
        ${groups.map(g => `<div class="narr-label">${escapeHtml(g)}</div>
        <div class="narr-list">${SaltCore.NARRATIVE_RULES.filter(r => r[3] === g).map(([id, name, what]) => `
            <label class="narr-switch-row"><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(what)}</small></span>
                <input type="checkbox" role="switch" class="narr-switch" data-narr-rule="${id}"${off.has(id) ? '' : ' checked'}${isReadOnly ? ' disabled' : ''} aria-label="${escapeHtml(name)}"></label>`).join('')}</div>`).join('')}`;
};

// --- Terrain ---

const TERRAIN_ENCODINGS = [['terrarium', 'Terrarium'], ['terrain-rgb', 'Mapbox Terrain-RGB']];
const TERRAIN_UNITS = [['m', 'Meters'], ['ft', 'Feet']];
// The source as saved, or as being filled in.
const terrainDraft = () => narrTerrain || { basemap: '', layer: '', encoding: '', units: 'm', ...(sharedNarrative.terrain || {}) };
const terrainSaid = (t) => {
    const b = sharedBasemaps.find(x => x.name === t.basemap);
    if (!b) return t.basemap ? `${t.basemap} (no longer a saved basemap)` : 'None: the narrative reads no ground.';
    return `${b.name}, ${b.kind === 'wms' ? `layer ${t.layer || String(b.layers || '').split(',')[0]}` : (TERRAIN_ENCODINGS.find(([e]) => e === t.encoding) || [, 'Terrarium'])[1]}, in ${t.units === 'ft' ? 'feet' : 'meters'}`;
};
const terrainTab = () => {
    const t = terrainDraft();
    const hint = '<div class="narr-hint">The server asks it the height at each report\'s grid and around it, once, for everyone. A picture of the ground (imagery, a scanned map) can\'t give heights: pick a layer that answers with a number, and Test it.</div>';
    if (isReadOnly) return `<div class="narr-label">Heights from</div><div class="narr-says">${escapeHtml(terrainSaid(t))}</div>${hint}`;
    const b = sharedBasemaps.find(x => x.name === t.basemap);
    const layers = b && b.kind === 'wms' ? String(b.layers || '').split(',').map(l => l.trim()).filter(Boolean) : [];
    return `<div class="narr-form">
        <div class="narr-label">Heights from</div>
        ${radios('data-narr-tbase', 'Heights from', [['', 'None'], ...sharedBasemaps.map(x => [x.name, `${x.name} (${x.kind === 'wms' ? 'WMS' : 'tiles'})`])], b ? t.basemap : '')}
        ${!sharedBasemaps.length ? '<div class="narr-empty">No basemaps yet: add the elevation service in Manage > Map > Basemaps first.</div>' : ''}
        ${layers.length > 1 ? `<div class="narr-label">Layer</div>${radios('data-narr-tlayer', 'Layer', layers.map(l => [l, l]), t.layer || layers[0])}` : ''}
        ${b && b.kind !== 'wms' ? `<div class="narr-label">Tiles hold heights as</div>${radios('data-narr-tenc', 'Tiles hold heights as', TERRAIN_ENCODINGS, t.encoding || 'terrarium')}` : ''}
        ${b ? `<div class="narr-label">Heights are in</div>${radios('data-narr-tunits', 'Heights are in', TERRAIN_UNITS, t.units || 'm')}
        <div class="narr-label">Test as elevation</div>
        <div class="narr-sentence"><input type="text" id="narrTerrainGrid" placeholder="A grid, e.g. 38S MB 45000 82000" maxlength="60" spellcheck="false" aria-label="A grid to test">
            <button type="button" class="text-btn" data-narr-ttest>Test</button></div>
        <div class="narr-says" id="narrTerrainSays" aria-live="polite">${escapeHtml(narrTerrainSays)}</div>` : ''}
        <div class="narr-foot"><button type="button" class="set-btn" data-narr-tsave>Save</button></div>
        ${hint}
    </div>`;
};
// The form as it stands, from the picks on screen.
const readTerrain = () => {
    const picked = attr => (document.querySelector(`[${attr}][aria-checked="true"]`) || { getAttribute: () => '' }).getAttribute(attr);
    const basemap = picked('data-narr-tbase') || '';
    const b = sharedBasemaps.find(x => x.name === basemap);
    if (!b) return null;
    return { basemap, layer: b.kind === 'wms' ? picked('data-narr-tlayer') || String(b.layers || '').split(',')[0].trim() : '',
        encoding: b.kind === 'wms' ? '' : picked('data-narr-tenc') || 'terrarium', units: picked('data-narr-tunits') || 'm' };
};
const testTerrain = async () => {
    const t = readTerrain(), grid = SaltCore.findGrids((document.getElementById('narrTerrainGrid') || {}).value || '')[0];
    const say = (text) => { narrTerrainSays = text; const n = document.getElementById('narrTerrainSays'); if (n) n.textContent = text; };
    if (!t) { say('Pick a basemap first.'); return; }
    if (!grid) { say('Type a grid to test, e.g. 38S MB 45000 82000.'); return; }
    if (isLocalFile) { say('A page opened as a file has no server to ask.'); return; }
    say('Asking...');
    const res = await apiPost('/api/elevation_test', { terrain: t, point: [grid.lon, grid.lat] });
    if (!res.ok) { say(res.message); return; }
    const { height, error, reply } = res.body;
    say(height !== null && height !== undefined ? `${Math.round(height)} m at ${grid.mgrs}${t.units === 'ft' ? ` (${Math.round(height / 0.3048)} ft as the service says it)` : ''}.`
        : `No height at ${grid.mgrs}: ${error || 'the reply holds no number'}.${reply ? ` The reply began: ${reply}` : ''}`);
};

// --- The panel ---

const narrCounts = () => ({
    units: narrList('units').length,
    equipment: narrList('equipment').length,
    rules: SaltCore.NARRATIVE_RULES.length - narrList('off').length + narrList('custom').length,
    terrain: terrainSet() ? 1 : 0,
});
// Rebuilt only when what it shows has changed, and never under a form being
// filled in or while you're typing (moving within the panel rebuilds it).
const renderNarrSettings = () => {
    const box = document.getElementById('narrSettings');
    if (!box || box.hidden) return;
    const typing = box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const key = JSON.stringify([sharedNarrative, narrTab, narrOpen, isReadOnly, narrPlaces(), narrUnknown(), narrTerrain, sharedBasemaps]);
    if (key === narrBuilt || ((typing || narrOpen) && narrBuilt)) return;
    narrBuilt = key;
    const counts = narrCounts(), unknown = narrUnknown().length;
    const tabs = [['units', 'Units'], ['equipment', 'Equipment'], ['rules', 'Rules'], ['terrain', 'Terrain']];
    box.innerHTML = `<div class="narr-head">Narrative settings</div>
        <label class="narr-call"><span>Call them</span>
            <input type="text" id="narrEnemy" value="${escapeHtml(sharedNarrative.enemy || '')}" placeholder="enemy forces" maxlength="60" spellcheck="false"${isReadOnly ? ' disabled' : ''}></label>
        <div class="narr-hint narr-call-hint">When no unit fits a judgment.</div>
        <label class="narr-call"><span>Enemy moves toward</span>
            <select id="narrToward"${isReadOnly ? ' disabled' : ''}>${[['', 'None'], ...NARR_TOWARD.map(d => [d, d])].map(([v, l]) =>
                `<option value="${v}"${v === narrToward() ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="narr-hint narr-call-hint">The way of march in the AO, for judging which way reports move. Within 10 km of an axis of advance on the map, the axis's way instead.</div>
        <div class="summary-kinds narr-tabs" role="group" aria-label="Narrative settings">${tabs.map(([t, n]) =>
            `<button type="button" class="ws-tab${t === narrTab ? ' active' : ''}" data-narr-tab="${t}">${n}<span class="narr-count">${counts[t]}</span>${t === 'equipment' && unknown && !isReadOnly ? '<span class="narr-dot" title="Types in your reports that the catalogue doesn\'t know" aria-hidden="true"></span><span class="visually-hidden">, with types in your reports that the catalogue doesn\'t know</span>' : ''}</button>`).join('')}</div>
        <div class="narr-body">${{ units: unitsTab, equipment: equipmentTab, rules: rulesTab, terrain: terrainTab }[narrTab]()}</div>
        <div class="narr-hint narr-shared">Shared with everyone${isReadOnly ? '; editors change them' : ''}.</div>`;
};
// Shown with the Narrative, and only then.
const showNarrSettings = (show) => {
    const box = document.getElementById('narrSettings');
    if (box.hidden === show) { box.hidden = !show; narrBuilt = null; }
    document.getElementById('summaryLayout').classList.toggle('with-side', show);
    renderNarrSettings();
};

// What the open form says, as an entry; null (and a toast) when it won't do.
const readNarrForm = () => {
    const val = id => (document.getElementById(id) || {}).value || '';
    const picked = attr => [...document.querySelectorAll(`[${attr}][aria-pressed="true"], [${attr}][aria-checked="true"]`)].map(b => b.getAttribute(attr));
    if (narrTab === 'units') {
        const name = val('narrUnitName').trim();
        if (!name) { showToast('Give the unit a name.', true); return null; }
        // Other ('' in the list) brings in what's typed in its box.
        const listed = picked('data-narr-place');
        const typed = listed.includes('') ? val('narrUnitOther').split(',').map(p => p.trim()).filter(Boolean) : [];
        const places = [...new Set([...listed.filter(Boolean), ...typed])];
        if (places.some(p => p.length > 40)) { showToast('A place name is at most 40 characters.', true); return null; }
        return { name, places: places.slice(0, 40), kinds: picked('data-narr-kind') };
    }
    if (narrTab === 'equipment') {
        const type = val('narrEqType').trim(), role = picked('data-narr-role')[0];
        if (!type) { showToast('Type the equipment name.', true); return null; }
        if (!role) { showToast(`Pick what ${type} is.`, true); return null; }
        const gear = picked('data-narr-gear')[0] || '', typed = val('narrEqReach').trim(), reach = Number(typed);
        if (typed && !(reach > 0 && reach <= SaltCore.REACH_MAX_KM)) { showToast(`Reach: more than 0, up to ${SaltCore.REACH_MAX_KM} km.`, true); return null; }
        return { type, role, origin: picked('data-narr-origin')[0] || '', ...(gear ? { gear } : {}), ...(typed ? { reach } : {}) };
    }
    const what = val('narrRuleWhat').trim(), words = val('narrRuleWords').trim();
    const min = Math.round(+val('narrRuleMin')), hours = Math.round(+val('narrRuleHours'));
    if (!what || !words) { showToast('Say what it judges and which words point to it.', true); return null; }
    if (!(min >= 1 && min <= 20) || !(hours >= 1 && hours <= 168)) { showToast('Times: 1 to 20; hours: 1 to 168.', true); return null; }
    return { what, words, min, hours };
};
const LIST_OF = { units: 'units', equipment: 'equipment', rules: 'custom' };
// The sync server's limits on each list (MAX_UNITS, MAX_EQUIPMENT and
// MAX_CUSTOM_RULES in server/salt_sync_server.py), checked here first.
const NARR_MOST = { units: [50, 'units'], equipment: [500, 'types'], custom: [30, 'rules'] };
// Where the open entry is in its list now (another editor may have added or
// removed one since it was opened), by its id; -1 when it's new or gone.
const narrIndex = () => {
    if (!narrOpen || narrOpen.id === null) return -1;
    const key = LIST_OF[narrTab];
    return narrList(key).findIndex(x => narrId(key, x) === narrOpen.id);
};
// The open entry was removed by someone else while it was open: said, and closed.
const narrGone = () => {
    const e = narrOpen.entry || {};
    showToast(`Someone else removed ${e.name || e.type || e.what || 'it'} in the meantime.`, true);
    narrOpen = null; narrBuilt = null;
    renderNarrSettings();
};
const saveNarrForm = () => {
    const entry = readNarrForm();
    if (!entry) return;
    const key = LIST_OF[narrTab], index = narrIndex();
    if (narrOpen.id !== null && index < 0) { narrGone(); return; }
    const list = narrList(key);
    if (index < 0 && list.length >= NARR_MOST[key][0]) { showToast(`${NARR_MOST[key][0]} ${NARR_MOST[key][1]} at most. Remove one to add another.`, true); return; }
    const same = (x) => (key === 'equipment' ? x.type.trim().toUpperCase() === entry.type.toUpperCase()
        : key === 'units' ? x.name.trim().toLowerCase() === entry.name.toLowerCase() : false);
    if (list.some((x, i) => i !== index && same(x))) { showToast(`There is already ${key === 'units' ? 'a unit' : 'an entry'} called ${entry.name || entry.type}.`, true); return; }
    saveNarrative({ [key]: index < 0 ? [...list, entry] : list.map((x, i) => (i === index ? entry : x)) },
        key === 'custom' ? 'Rule saved for everyone.' : `${entry.name || entry.type} saved for everyone.`);
};

(() => {
    const box = document.getElementById('narrSettings');
    if (!box) return;
    const rerender = () => { narrBuilt = null; renderNarrSettings(); };
    const go = (open) => { narrOpen = open; rerender(); };
    box.addEventListener('click', e => {
        const tab = e.target.closest('[data-narr-tab]');
        if (tab) {
            const tabs = [...box.querySelectorAll('[data-narr-tab]')].map(b => b.dataset.narrTab), was = narrTab;
            narrTab = tab.dataset.narrTab;
            go(null);
            if (was !== narrTab) animateTabIn(box.querySelector('.narr-body'), tabDir(tabs, was, narrTab));
            return;
        }
        // A saved one opens by its id, so the list can change under it.
        const edit = e.target.closest('[data-narr-edit]');
        if (edit) {
            const key = LIST_OF[narrTab], entry = narrList(key).find(x => narrId(key, x) === edit.dataset.narrId);
            if (entry) go({ id: edit.dataset.narrId, entry }); else rerender();
            return;
        }
        if (e.target.closest('[data-narr-add]')) {
            const typed = narrTab === 'equipment' ? ((document.getElementById('narrEqFind') || {}).value || '').trim() : '';
            go({ id: null, fill: typed });
            return;
        }
        const fill = e.target.closest('[data-narr-fill]');
        if (fill) { go({ id: null, fill: fill.dataset.narrFill }); return; }
        if (e.target.closest('[data-narr-back]')) { go(null); return; }
        // A dropdown: its button opens or closes it; an option is ticked or not.
        const ddBtn = e.target.closest('.narr-dd-btn');
        if (ddBtn) {
            const dd = ddBtn.closest('.narr-dd'), menu = dd.querySelector('.narr-dd-menu');
            closeDropdowns(dd);
            menu.hidden = !menu.hidden;
            ddBtn.setAttribute('aria-expanded', String(!menu.hidden));
            return;
        }
        const opt = e.target.closest('.narr-dd-opt');
        if (opt) {
            opt.setAttribute('aria-pressed', String(opt.getAttribute('aria-pressed') !== 'true'));
            ddLabel(opt.closest('.narr-dd'));
            // Other: the menu makes way for the box to type the places in.
            if (opt.dataset.narrPlace === '') {
                const box = document.getElementById('narrUnitOther');
                box.hidden = opt.getAttribute('aria-pressed') !== 'true';
                if (!box.hidden) { closeDropdowns(); box.focus(); }
            }
            return;
        }
        // One of a one-choice group: picked, and the others not. On the
        // Terrain form, a basemap picked shows what it asks of that kind.
        const c = e.target.closest('.narr-chip[role="radio"]');
        if (c) {
            pickRadio(c);
            if (c.hasAttribute('data-narr-tbase')) { narrTerrain = { ...terrainDraft(), basemap: c.dataset.narrTbase, layer: '', encoding: '' }; narrTerrainSays = ''; rerender(); }
            return;
        }
        if (e.target.closest('[data-narr-ttest]')) { testTerrain(); return; }
        if (e.target.closest('[data-narr-tsave]')) {
            const t = readTerrain();
            narrTerrain = null;
            saveNarrative({ terrain: t }, t ? `Heights from ${t.basemap}, for everyone.` : 'No elevation source: the narrative reads no ground.');
            return;
        }
        if (e.target.closest('[data-narr-save]')) { saveNarrForm(); return; }
        if (e.target.closest('[data-narr-remove]')) {
            if (!askFirst(narrAskKey(), drawNarrRemove)) return;
            const key = LIST_OF[narrTab], index = narrIndex();
            if (index < 0) { narrGone(); return; }
            const gone = narrList(key)[index], name = gone.name || gone.type || gone.what || 'It';
            // Undo: back where it was, unless one like it has been saved since.
            saveNarrative({ [key]: narrList(key).filter((_, i) => i !== index) }, `${name} removed.`, () => {
                const list = narrList(key);
                if (list.some(x => narrId(key, x) === narrId(key, gone))) { showToast('Nothing left to put back.', true); return; }
                saveNarrative({ [key]: [...list.slice(0, index), gone, ...list.slice(index)] }, `${name} put back.`);
            });
        }
    });
    box.addEventListener('change', e => {
        if (e.target.id === 'narrEnemy') {
            const name = e.target.value.trim();
            if (name !== String(sharedNarrative.enemy || '')) saveNarrative({ enemy: name }, `The narrative calls them ${name || 'enemy forces'}.`);
            return;
        }
        if (e.target.id === 'narrToward') {
            const dir = NARR_TOWARD.includes(e.target.value) ? e.target.value : '';
            if (dir !== narrToward()) saveNarrative({ toward: dir }, dir ? `The enemy moves toward ${dir} in the AO, for everyone.` : 'No way of march for the AO, for everyone.');
            return;
        }
        const rule = e.target.closest('[data-narr-rule]');
        if (!rule) return;
        const off = new Set(narrList('off'));
        rule.checked ? off.delete(rule.dataset.narrRule) : off.add(rule.dataset.narrRule);
        const name = (SaltCore.NARRATIVE_RULES.find(([id]) => id === rule.dataset.narrRule) || [])[1];
        saveNarrative({ off: [...off].sort() }, `${name}: ${rule.checked ? 'on' : 'off'} for everyone.`);
    });
    box.addEventListener('input', e => {
        if (e.target.id === 'narrEqType') document.getElementById('narrEqSays').textContent = lookupSays(e.target.value);
        if (e.target.id === 'narrEqFind') document.getElementById('narrEqFindSays').textContent = lookupSays(e.target.value);
    });
    // A click anywhere but in a dropdown closes it.
    document.addEventListener('click', e => { if (!e.target.closest('.narr-dd')) closeDropdowns(); });
    box.addEventListener('keydown', e => {
        // Escape handled here goes no further (the page's would cancel an edit in the form).
        const open = box.querySelector('.narr-dd-menu:not([hidden])');
        if (e.key === 'Escape' && (open || narrOpen)) {
            e.preventDefault();
            e.stopPropagation();
            if (open) { closeDropdowns(); open.closest('.narr-dd').querySelector('.narr-dd-btn').focus(); } else go(null);
            return;
        }
        // In a one-choice group, the arrow keys pick the next or previous one.
        const radio = e.target.closest && e.target.closest('.narr-chip[role="radio"]');
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (radio && step) {
            e.preventDefault();
            const all = [...radio.parentElement.querySelectorAll('[role="radio"]')];
            const next = all[(all.indexOf(radio) + step + all.length) % all.length];
            pickRadio(next);
            next.focus();
            return;
        }
        if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
        e.preventDefault();
        if (e.target.id === 'narrEnemy') e.target.blur();
        else if (e.target.id === 'narrEqFind') box.querySelector('[data-narr-add]').click();
        else if (e.target.id === 'narrTerrainGrid') testTerrain();
        else if (narrOpen) saveNarrForm();
    });
})();

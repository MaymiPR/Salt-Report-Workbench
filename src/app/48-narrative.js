// SPDX-License-Identifier: AGPL-3.0-only

// The narrative's settings, in Summary Reports > Narrative: what the enemy
// is called, the units and where they operate, equipment the team adds to
// the catalogue (or puts right), the built-in rules switched on or off, and
// the team's own rules. Shared with everyone like the basemaps; editors
// change them, viewers see them. The narrative itself is SaltCore's.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let narrTab = 'units';
let narrOpen = null;        // what's being edited: { tab, index } (index -1: a new one)
let narrRemoving = false;   // its Remove has asked "for everyone?"
let narrBuilt = null;       // what the panel was last built from, so a sync doesn't rebuild it under the cursor

const narrList = (k) => (Array.isArray(sharedNarrative[k]) ? sharedNarrative[k] : []);
const ROLE_NAMES = Object.fromEntries(SaltCore.EQUIPMENT_ROLES);
const ORIGIN_NAMES = { RU: 'Russian', CN: 'Chinese', '': 'any army' };

const saveNarrative = async (changes, said) => {
    sharedNarrative = { enemy: '', units: [], equipment: [], off: [], custom: [], ...sharedNarrative, ...changes };
    storeNarrative();
    narrOpen = null; narrRemoving = false;
    renderSummary();
    if (isLocalFile) { if (said) showToast(said); return; }
    try {
        const res = await postJson('/api/save_narrative', { narrative: sharedNarrative });
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(`The server refused the narrative settings: ${body.message || res.status}`, true, { ms: 8000 });
        } else if (said) showToast(said);
    } catch (e) { showToast('Saved in this browser only: the server could not be reached.', true); }
};

// The NAIs and OBJs a unit can be placed in: every overlay, and whatever reports name.
const narrPlaces = () => SaltCore.summaryPlaces(localReports.filter(r => !r.deleted), currentOverlays()).filter(p => !/^PL /.test(p));

// Save, Cancel and, for one already saved, Remove (which asks first).
const narrFoot = (saved) => `<div class="map-form-row map-find-foot">
        <button type="button" class="set-btn" data-narr-save>Save</button>
        <button type="button" class="cancel-btn" data-narr-cancel>Cancel</button>
        ${saved ? `<button type="button" class="text-btn map-base-remove${narrRemoving ? ' sure' : ''}" data-narr-remove>${narrRemoving ? 'Remove for everyone?' : 'Remove'}</button>` : ''}
    </div>`;
const checks = (attr, items, on) => `<div class="narr-checks">${items.map(([v, t]) =>
    `<label><input type="checkbox" ${attr} value="${escapeHtml(v)}"${on.has(v) ? ' checked' : ''}>${escapeHtml(t)}</label>`).join('')}</div>`;
const isOpen = (tab, i) => narrOpen && narrOpen.tab === tab && narrOpen.index === i;

const unitForm = (u) => {
    const known = narrPlaces();
    const upper = new Set((u.places || []).map(p => p.toUpperCase()));
    const other = (u.places || []).filter(p => !known.some(k => k.toUpperCase() === p.toUpperCase()));
    return `<div class="narr-form">
        <input type="text" id="narrUnitName" value="${escapeHtml(u.name || '')}" placeholder="Unit, e.g. 1-60 GMRB" maxlength="60" spellcheck="false" aria-label="Unit">
        <div class="narr-label">Where it operates <span>(none: anywhere)</span></div>
        ${known.length ? checks('data-narr-place', known.map(p => [p, p]), new Set(known.filter(k => upper.has(k.toUpperCase())))) : ''}
        <input type="text" id="narrUnitOther" value="${escapeHtml(other.join(', '))}" placeholder="Other places, comma-separated (e.g. 11S NV 31)" maxlength="400" spellcheck="false" aria-label="Other places">
        <div class="narr-label">What it has <span>(none: any)</span></div>
        ${checks('data-narr-kind', SaltCore.EQUIPMENT_ROLES, new Set(u.kinds || []))}
        ${narrFoot(narrOpen.index >= 0)}
    </div>`;
};
const unitsTab = () => {
    const units = narrList('units');
    return `<div class="narr-list">${units.map((u, i) => `
            <div class="narr-row${isOpen('units', i) ? ' open' : ''}">
                <span class="narr-name">${escapeHtml(u.name)}</span>
                <span class="narr-meta">${escapeHtml([(u.places || []).join(', ') || 'anywhere', (u.kinds || []).map(k => ROLE_NAMES[k]).join(', ')].filter(Boolean).join(' · '))}</span>
                <button type="button" class="text-btn editor-only" data-narr-edit="${i}">Edit</button>
            </div>${isOpen('units', i) ? unitForm(u) : ''}`).join('') || (isOpen('units', -1) ? '' : '<div class="narr-empty">No units yet.</div>')}</div>
        ${isOpen('units', -1) ? unitForm({}) : '<button type="button" class="text-btn editor-only" data-narr-add>Add a unit</button>'}
        <div class="narr-hint">A judgment about a place in a unit's area (and, if you tick kinds, with that kind of equipment in its reports) is said of &ldquo;elements of&rdquo; the unit, in Assessment only.</div>`;
};

const roleOptions = (on) => SaltCore.EQUIPMENT_ROLES.map(([r, t]) => `<option value="${r}"${r === on ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
const originOptions = (on) => Object.entries(ORIGIN_NAMES).map(([o, t]) => `<option value="${o}"${o === (on || '') ? ' selected' : ''}>${t}</option>`).join('');
const equipmentForm = (e, idPrefix) => `<div class="map-form-row narr-eq-row">
        <input type="text" id="${idPrefix}Type" value="${escapeHtml(e.type || '')}" placeholder="Type, e.g. BTR-4" maxlength="40" spellcheck="false" aria-label="Type">
        <select id="${idPrefix}Role" aria-label="Kind">${roleOptions(e.role || 'mech')}</select>
        <select id="${idPrefix}Origin" aria-label="Army">${originOptions(e.origin)}</select>
        ${idPrefix === 'narrEqNew' ? '<button type="button" class="set-btn" id="narrEqAdd">Add</button>' : ''}
    </div>`;
// What the catalogue says of a type now: the team's entry, the built-in one, or nothing.
const lookupSays = (type) => {
    if (!type.trim()) return 'Type a name to see what the catalogue makes of it.';
    const team = SaltCore.teamEquipment(narrList('equipment'));
    const own = SaltCore.lookupEquipment(type, team), built = SaltCore.lookupEquipment(type);
    const said = k => `${ROLE_NAMES[k.role]} (${k.name}${k.origin ? `, ${ORIGIN_NAMES[k.origin]}` : ''})`;
    if (own && own !== built && (!built || own.role !== built.role || own.name !== built.name)) return `Yours: ${said(own)}${built ? `; built in: ${said(built)}` : ''}.`;
    return built ? `Built in: ${said(built)}. Adding it puts that right for your team.` : 'Not in the catalogue yet.';
};
const equipmentTab = () => {
    const list = narrList('equipment');
    const team = SaltCore.teamEquipment(list);
    // Types in the reports the catalogue doesn't know, to add with a click.
    const unknown = [...new Set(localReports.filter(r => !r.deleted).flatMap(r => SaltCore.sizeElements(r.size).map(e => e.type)))]
        .filter(t => !SaltCore.lookupEquipment(t, team)).sort().slice(0, 30);
    const builtIn = SaltCore.EQUIPMENT_ROLES.map(([r, t]) => {
        const names = [...new Set(SaltCore.EQUIPMENT_CATALOGUE.filter(e => e[0] === r && e[1]).map(e => e[2]))];
        return names.length ? `<div><strong>${escapeHtml(t)}</strong>: ${escapeHtml(names.join(', '))}</div>` : '';
    }).join('');
    return `<div class="editor-only">
            ${equipmentForm({}, 'narrEqNew')}
            <div class="narr-hint" id="narrEqSays">${escapeHtml(lookupSays(''))}</div>
            ${unknown.length ? `<div class="narr-unknown"><span>In your reports, not in the catalogue:</span> ${unknown.map(t => `<button type="button" class="filter-preset-btn" data-narr-fill="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        </div>
        <div class="narr-list">${list.map((e, i) => `
            <div class="narr-row${isOpen('equipment', i) ? ' open' : ''}">
                <span class="narr-name">${escapeHtml(e.type)}</span>
                <span class="narr-meta">${escapeHtml(`${ROLE_NAMES[e.role] || e.role} · ${ORIGIN_NAMES[e.origin || '']}`)}</span>
                <button type="button" class="text-btn editor-only" data-narr-edit="${i}">Edit</button>
            </div>${isOpen('equipment', i) ? `<div class="narr-form">${equipmentForm(e, 'narrEq')}${narrFoot(true)}</div>` : ''}`).join('') || '<div class="narr-empty">None added: the built-in catalogue only.</div>'}</div>
        <details class="narr-builtin"><summary>Built-in catalogue</summary>${builtIn}<div>Plain words too: tank, IFV, APC, truck, fuel, PAX, troops, mortar, howitzer, SAM, UAV, helicopter, and more.</div></details>`;
};

const ruleForm = (c) => `<div class="narr-form">
        <div class="narr-sentence"><span>${escapeHtml(String(sharedNarrative.enemy || '').trim() || 'Enemy forces')}</span>
            <input type="text" id="narrRuleWhat" value="${escapeHtml(c.what || '')}" placeholder="are preparing a river crossing" maxlength="120" spellcheck="false" aria-label="Judgment">
            <span>in the place</span></div>
        <div class="narr-sentence"><span>when reports say</span>
            <input type="text" id="narrRuleWords" value="${escapeHtml(c.words || '')}" placeholder="bridge, ferry, PMP" maxlength="300" spellcheck="false" aria-label="Words, comma-separated"></div>
        <div class="narr-sentence">
            <input type="number" id="narrRuleMin" value="${c.min || 2}" min="1" max="20" aria-label="Reports"><span>times or more within</span>
            <input type="number" id="narrRuleHours" value="${c.hours || 12}" min="1" max="168" aria-label="Hours"><span>hrs, in one place</span></div>
        ${narrFoot(narrOpen.index >= 0)}
    </div>`;
const rulesTab = () => {
    const off = new Set(narrList('off'));
    const custom = narrList('custom');
    return `<div class="narr-label">Built in</div>
        <div class="narr-list">${SaltCore.NARRATIVE_RULES.map(([id, name, what]) => `
            <label class="narr-rule"><input type="checkbox" data-narr-rule="${id}"${off.has(id) ? '' : ' checked'}${isReadOnly ? ' disabled' : ''}>
                <span><strong>${escapeHtml(name)}</strong><span>${escapeHtml(what)}</span></span></label>`).join('')}</div>
        <div class="narr-label">Your own</div>
        <div class="narr-list">${custom.map((c, i) => `
            <div class="narr-row${isOpen('custom', i) ? ' open' : ''}">
                <span class="narr-name">${escapeHtml(c.what)}</span>
                <span class="narr-meta">${escapeHtml(`${c.words} · ${c.min} in ${c.hours} hrs`)}</span>
                <button type="button" class="text-btn editor-only" data-narr-edit="${i}">Edit</button>
            </div>${isOpen('custom', i) ? ruleForm(c) : ''}`).join('') || (isOpen('custom', -1) ? '' : '<div class="narr-empty">None yet.</div>')}</div>
        ${isOpen('custom', -1) ? ruleForm({}) : '<button type="button" class="text-btn editor-only" data-narr-add>Add a rule</button>'}
        <div class="narr-hint">Your rules start at roughly even chance when their words come up often enough in one place; one more report makes them likely, three more very likely.</div>`;
};

// The panel, rebuilt only when what it shows has changed.
const renderNarrSettings = () => {
    const box = document.getElementById('narrSettings');
    if (!box || box.hidden) return;
    const key = JSON.stringify([sharedNarrative, narrTab, narrOpen, narrRemoving, isReadOnly, narrPlaces(), narrTab === 'equipment' ? localReports.length : 0]);
    if (key === narrBuilt) return;
    narrBuilt = key;
    const tabs = [['units', 'Units'], ['equipment', 'Equipment'], ['rules', 'Rules']];
    box.innerHTML = `<div class="summary-kinds narr-tabs" role="group" aria-label="Narrative settings">${tabs.map(([t, n]) =>
        `<button type="button" class="ws-tab${t === narrTab ? ' active' : ''}" data-narr-tab="${t}">${n}</button>`).join('')}</div>
        ${{ units: unitsTab, equipment: equipmentTab, rules: rulesTab }[narrTab]()}
        <div class="narr-hint">Shared with everyone${isReadOnly ? '; editors change them' : ''}.</div>`;
};

// What the open form says, as an entry; null (and a toast) when it won't do.
const readNarrForm = () => {
    const val = id => (document.getElementById(id) || {}).value || '';
    if (narrOpen.tab === 'units') {
        const name = val('narrUnitName').trim();
        if (!name) { showToast('Give the unit a name.', true); return null; }
        const ticked = [...document.querySelectorAll('[data-narr-place]:checked')].map(i => i.value);
        const places = [...new Set([...ticked, ...val('narrUnitOther').split(',').map(p => p.trim()).filter(Boolean)])];
        if (places.some(p => p.length > 40)) { showToast('A place name is at most 40 characters.', true); return null; }
        return { name, places: places.slice(0, 40), kinds: [...document.querySelectorAll('[data-narr-kind]:checked')].map(i => i.value) };
    }
    if (narrOpen.tab === 'equipment') {
        const pre = narrOpen.index < 0 ? 'narrEqNew' : 'narrEq';
        const type = val(`${pre}Type`).trim();
        if (!type) { showToast('Type the equipment name.', true); return null; }
        return { type, role: val(`${pre}Role`), origin: val(`${pre}Origin`) };
    }
    const what = val('narrRuleWhat').trim(), words = val('narrRuleWords').trim();
    const min = Math.round(+val('narrRuleMin')), hours = Math.round(+val('narrRuleHours'));
    if (!what || !words) { showToast('Say what it judges and which words to look for.', true); return null; }
    if (!(min >= 1 && min <= 20) || !(hours >= 1 && hours <= 168)) { showToast('Times: 1 to 20; hours: 1 to 168.', true); return null; }
    return { what, words, min, hours };
};
const narrSame = (tab, a, b) => (tab === 'equipment' ? a.type.trim().toUpperCase() === b.type.trim().toUpperCase()
    : tab === 'units' ? a.name.trim().toLowerCase() === b.name.trim().toLowerCase() : false);
const saveNarrForm = () => {
    const entry = readNarrForm();
    if (!entry) return;
    const { tab, index } = narrOpen;
    const list = narrList(tab);
    if (list.some((x, i) => i !== index && narrSame(tab, x, entry))) { showToast(`There is already ${tab === 'units' ? 'a unit' : 'an entry'} called ${entry.name || entry.type}.`, true); return; }
    const next = index < 0 ? [...list, entry] : list.map((x, i) => (i === index ? entry : x));
    saveNarrative({ [tab]: next }, `${entry.name || entry.type || 'Rule'} saved for everyone.`);
};

(() => {
    const box = document.getElementById('narrSettings');
    if (!box) return;
    const rerender = () => { narrBuilt = null; renderNarrSettings(); };
    document.getElementById('narrSettingsBtn').addEventListener('click', e => {
        box.hidden = !box.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
        rerender();
    });
    const enemy = document.getElementById('narrEnemy');
    enemy.addEventListener('change', () => {
        const name = enemy.value.trim();
        if (name === String(sharedNarrative.enemy || '')) return;
        saveNarrative({ enemy: name }, `The narrative calls them ${name || 'enemy forces'}.`);
    });
    enemy.addEventListener('keydown', e => { if (e.key === 'Enter') enemy.blur(); });
    box.addEventListener('click', e => {
        const tab = e.target.closest('[data-narr-tab]');
        if (tab) { narrTab = tab.dataset.narrTab; narrOpen = null; narrRemoving = false; rerender(); return; }
        const edit = e.target.closest('[data-narr-edit]');
        if (edit) {
            const i = +edit.dataset.narrEdit;
            narrOpen = isOpen(narrTab === 'rules' ? 'custom' : narrTab, i) ? null : { tab: narrTab === 'rules' ? 'custom' : narrTab, index: i };
            narrRemoving = false; rerender();
            return;
        }
        if (e.target.closest('[data-narr-add]')) { narrOpen = { tab: narrTab === 'rules' ? 'custom' : narrTab, index: -1 }; narrRemoving = false; rerender(); return; }
        if (e.target.closest('[data-narr-cancel]')) { narrOpen = null; narrRemoving = false; rerender(); return; }
        if (e.target.closest('[data-narr-save]')) { saveNarrForm(); return; }
        if (e.target.closest('[data-narr-remove]')) {
            if (!narrRemoving) { narrRemoving = true; rerender(); return; }
            const { tab, index } = narrOpen, gone = narrList(tab)[index];
            saveNarrative({ [tab]: narrList(tab).filter((_, i) => i !== index) }, `${(gone && (gone.name || gone.type || gone.what)) || 'It'} removed.`);
            return;
        }
        // Adding equipment: from its own row, saved at once.
        if (e.target.closest('#narrEqAdd')) { narrOpen = { tab: 'equipment', index: -1 }; saveNarrForm(); return; }
        const fill = e.target.closest('[data-narr-fill]');
        if (fill) {
            const t = document.getElementById('narrEqNewType');
            t.value = fill.dataset.narrFill;
            document.getElementById('narrEqSays').textContent = lookupSays(t.value);
            t.focus();
        }
    });
    box.addEventListener('change', e => {
        const rule = e.target.closest('[data-narr-rule]');
        if (!rule) return;
        const off = new Set(narrList('off'));
        rule.checked ? off.delete(rule.dataset.narrRule) : off.add(rule.dataset.narrRule);
        const name = (SaltCore.NARRATIVE_RULES.find(([id]) => id === rule.dataset.narrRule) || [])[1];
        saveNarrative({ off: [...off].sort() }, `${name}: ${rule.checked ? 'on' : 'off'} for everyone.`);
    });
    box.addEventListener('input', e => {
        if (e.target.id === 'narrEqNewType') document.getElementById('narrEqSays').textContent = lookupSays(e.target.value);
    });
    box.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
        e.preventDefault();
        if (e.target.id === 'narrEqNewType') document.getElementById('narrEqAdd').click();
        else if (narrOpen) saveNarrForm();
    });
})();

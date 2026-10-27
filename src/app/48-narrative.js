// SPDX-License-Identifier: AGPL-3.0-only

// The narrative's settings, in a panel beside the Narrative: what the enemy
// is called, the units and where they operate, equipment the team adds to
// the catalogue (or puts right), the built-in rules switched on or off, and
// the team's own rules. Shared with everyone like the basemaps; editors
// change them, viewers see them. The narrative itself is SaltCore's.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

let narrTab = 'units';
let narrOpen = null;        // the item open in the panel: { index (-1: a new one), fill? }
let narrRemoving = false;   // its Remove has asked "for everyone?"
let narrMoreKinds = false;  // the unit form shows every kind, not just the usual ones
let narrBuilt = null;       // what the panel was last built from, so a sync doesn't rebuild it under the cursor

const narrList = (k) => (Array.isArray(sharedNarrative[k]) ? sharedNarrative[k] : []);
const ROLE_NAMES = Object.fromEntries(SaltCore.EQUIPMENT_ROLES);
const USUAL_KINDS = ['armor', 'mech', 'recon', 'fires', 'ad', 'engineer', 'logistics'];
const ORIGIN_NAMES = { '': 'Any army', RU: 'Russian', CN: 'Chinese' };
const CHEVRON = '<svg class="narr-chevron" viewBox="0 0 8 14" width="7" height="12" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const saveNarrative = async (changes, said) => {
    sharedNarrative = { enemy: '', units: [], equipment: [], off: [], custom: [], ...sharedNarrative, ...changes };
    storeNarrative();
    narrOpen = null; narrRemoving = false;
    narrBuilt = null;
    renderSummary();
    if (isLocalFile) { if (said) showToast(said); return; }
    try {
        const res = await postJson('/api/save_narrative', { narrative: sharedNarrative });
        if (res.status === 401) { handleUnauthorized(); return; }
        // A server from before these settings: says so, rather than "Not Found".
        if (res.status === 404) showToast("This server is an older version and can't share these settings: restart it with this version. Kept in this browser for now.", true, { ms: 10000 });
        else if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(`The server refused the narrative settings: ${body.message || res.status}`, true, { ms: 8000 });
        } else if (said) showToast(said);
    } catch (e) { showToast('Saved in this browser only: the server could not be reached.', true); }
};

// The NAIs and OBJs a unit can be placed in: every overlay, and whatever reports name.
const narrPlaces = () => SaltCore.summaryPlaces(localReports.filter(r => !r.deleted), currentOverlays()).filter(p => !/^PL /.test(p));
// Types in the reports the catalogue doesn't know (the team's entries included).
const narrUnknown = () => {
    const team = SaltCore.teamEquipment(narrList('equipment'));
    return [...new Set(localReports.filter(r => !r.deleted).flatMap(r => SaltCore.sizeElements(r.size).map(e => e.type)))]
        .filter(t => !SaltCore.lookupEquipment(t, team)).sort().slice(0, 30);
};

// --- The parts ---

const chip = (attr, value, label, on) =>
    `<button type="button" class="narr-chip" ${attr}="${escapeHtml(value)}" aria-pressed="${on}">${escapeHtml(label)}</button>`;
// A list row: the whole row opens it (editors); a chevron says so.
const row = (i, name, meta) => (isReadOnly
    ? `<div class="narr-row"><span class="narr-name">${escapeHtml(name)}</span><span class="narr-meta">${escapeHtml(meta)}</span></div>`
    : `<button type="button" class="narr-row" data-narr-edit="${i}"><span class="narr-name">${escapeHtml(name)}</span><span class="narr-meta">${escapeHtml(meta)}</span>${CHEVRON}</button>`);
const addRow = (label) => `<button type="button" class="narr-add editor-only" data-narr-add>+ ${label}</button>`;
// The form's foot: Save and, for one already saved, Remove (which asks first).
const formFoot = (saved) => `<div class="narr-foot">
        <button type="button" class="set-btn" data-narr-save>Save</button>
        ${saved ? `<button type="button" class="text-btn map-base-remove${narrRemoving ? ' sure' : ''}" data-narr-remove>${narrRemoving ? 'Remove for everyone?' : 'Remove'}</button>` : ''}
    </div>`;
// An open item: back to its list, its title, then its form.
const drill = (back, title, body) => `<button type="button" class="narr-back" data-narr-back>
        <svg viewBox="0 0 8 14" width="7" height="12" aria-hidden="true"><path d="M7 1L1 7l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${back}</button>
    <div class="narr-drill-title">${escapeHtml(title)}</div>${body}`;

// --- Units ---

const unitForm = (u) => {
    const known = narrPlaces();
    const on = new Set((u.places || []).map(p => p.toUpperCase()));
    const other = (u.places || []).filter(p => !known.some(k => k.toUpperCase() === p.toUpperCase()));
    const kinds = new Set(u.kinds || []);
    const shown = narrMoreKinds ? SaltCore.EQUIPMENT_ROLES.map(([r]) => r) : [...new Set([...USUAL_KINDS, ...kinds])];
    return `<div class="narr-form">
        <input type="text" id="narrUnitName" value="${escapeHtml(u.name || '')}" placeholder="Unit, e.g. 1-60 GMRB" maxlength="60" spellcheck="false" aria-label="Unit">
        <div class="narr-label">Where it operates<span>None picked: anywhere</span></div>
        <div class="narr-chips">${known.map(p => chip('data-narr-place', p, p, on.has(p.toUpperCase()))).join('')}</div>
        <input type="text" id="narrUnitOther" value="${escapeHtml(other.join(', '))}" placeholder="Other places, e.g. 11S NV 31" maxlength="400" spellcheck="false" aria-label="Other places, comma-separated">
        <div class="narr-label">What it has<span>None picked: any</span></div>
        <div class="narr-chips">${shown.map(r => chip('data-narr-kind', r, ROLE_NAMES[r], kinds.has(r))).join('')}
            ${narrMoreKinds ? '' : '<button type="button" class="narr-chip narr-more" data-narr-more>More&hellip;</button>'}</div>
        ${formFoot(narrOpen.index >= 0)}
    </div>`;
};
const unitsTab = () => {
    if (narrOpen) {
        const u = narrOpen.index >= 0 ? narrList('units')[narrOpen.index] : {};
        return drill('Units', u.name || 'New unit', unitForm(u));
    }
    const units = narrList('units');
    return `<div class="narr-list">${units.map((u, i) => row(i, u.name,
            [(u.places || []).join(', ') || 'Anywhere', (u.kinds || []).map(k => ROLE_NAMES[k]).join(', ')].filter(Boolean).join(' · '))).join('')
            || '<div class="narr-empty">No units yet. Add the units you track, and where they operate, to have judgments name them.</div>'}</div>
        ${addRow('Add a unit')}`;
};

// --- Equipment ---

// What the catalogue makes of a name now: the team's entry, the built-in one, or nothing.
const lookupSays = (type) => {
    if (!type.trim()) return '';
    const said = k => `${ROLE_NAMES[k.role]} (${k.name}${k.origin ? `, ${ORIGIN_NAMES[k.origin]}` : ''})`;
    const own = SaltCore.lookupEquipment(type, SaltCore.teamEquipment(narrList('equipment')));
    const built = SaltCore.lookupEquipment(type);
    if (own && (!built || own.role !== built.role || own.name !== built.name)) return `Yours: ${said(own)}.`;
    return built ? `Built in: ${said(built)}.` : 'Not in the catalogue.';
};
const equipmentForm = (e) => `<div class="narr-form">
        <input type="text" id="narrEqType" value="${escapeHtml(e.type || '')}" placeholder="Type, e.g. BTR-4" maxlength="40" spellcheck="false" aria-label="Type">
        <div class="narr-says" id="narrEqSays">${escapeHtml(lookupSays(e.type || ''))}</div>
        <div class="narr-label">What it is</div>
        <div class="narr-chips" data-narr-single>${SaltCore.EQUIPMENT_ROLES.map(([r, t]) => chip('data-narr-role', r, t, r === e.role)).join('')}</div>
        <div class="narr-label">Army</div>
        <div class="narr-chips" data-narr-single>${Object.entries(ORIGIN_NAMES).map(([o, t]) => chip('data-narr-origin', o, t, o === (e.origin || ''))).join('')}</div>
        ${formFoot(narrOpen.index >= 0)}
    </div>`;
const equipmentTab = () => {
    if (narrOpen) {
        const e = narrOpen.index >= 0 ? narrList('equipment')[narrOpen.index] : { type: narrOpen.fill || '', role: '' };
        return drill('Equipment', e.type || 'New entry', equipmentForm(e));
    }
    const unknown = narrUnknown();
    const builtIn = SaltCore.EQUIPMENT_ROLES.map(([r, t]) => {
        const names = [...new Set(SaltCore.EQUIPMENT_CATALOGUE.filter(e => e[0] === r && e[1]).map(e => e[2]))];
        return names.length ? `<div><strong>${escapeHtml(t)}</strong>: ${escapeHtml(names.join(', '))}</div>` : '';
    }).join('');
    return `${unknown.length && !isReadOnly ? `<div class="narr-label">In your reports, not in the catalogue</div>
            <div class="narr-chips">${unknown.map(t => `<button type="button" class="narr-chip narr-new" data-narr-fill="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        <div class="narr-find">
            <input type="text" id="narrEqFind" placeholder="Look up a type, e.g. T-72B3" maxlength="40" spellcheck="false" aria-label="Look up a type">
            <div class="narr-says" id="narrEqFindSays"></div>
        </div>
        <div class="narr-label">Yours</div>
        <div class="narr-list">${narrList('equipment').map((e, i) => row(i, e.type, `${ROLE_NAMES[e.role] || e.role} · ${ORIGIN_NAMES[e.origin || '']}`)).join('')
            || '<div class="narr-empty">None yet: the built-in catalogue only.</div>'}</div>
        ${addRow('Add a type')}
        <details class="narr-builtin"><summary>Built-in catalogue</summary>${builtIn}<div>Plain words too: tank, IFV, APC, truck, fuel, PAX, troops, mortar, howitzer, SAM, UAV, helicopter, and more.</div></details>`;
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
        ${formFoot(narrOpen.index >= 0)}
    </div>`;
const rulesTab = () => {
    if (narrOpen) {
        const c = narrOpen.index >= 0 ? narrList('custom')[narrOpen.index] : {};
        return drill('Rules', c.what || 'New rule', ruleForm(c));
    }
    const off = new Set(narrList('off'));
    return `<div class="narr-label">Built in</div>
        <div class="narr-list">${SaltCore.NARRATIVE_RULES.map(([id, name, what]) => `
            <label class="narr-switch-row"><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(what)}</small></span>
                <input type="checkbox" class="narr-switch" data-narr-rule="${id}"${off.has(id) ? '' : ' checked'}${isReadOnly ? ' disabled' : ''} aria-label="${escapeHtml(name)}"></label>`).join('')}</div>
        <div class="narr-label">Your own</div>
        <div class="narr-list">${narrList('custom').map((c, i) => row(i, c.what, `${c.words} · ${c.min} in ${c.hours} hrs`)).join('')
            || '<div class="narr-empty">None yet: a judgment, the words that point to it, and how often.</div>'}</div>
        ${addRow('Add a rule')}`;
};

// --- The panel ---

const narrCounts = () => ({
    units: narrList('units').length,
    equipment: narrList('equipment').length,
    rules: SaltCore.NARRATIVE_RULES.length - narrList('off').length + narrList('custom').length,
});
// Rebuilt only when what it shows has changed, and never under a form being
// filled in or while you're typing (moving within the panel rebuilds it).
const renderNarrSettings = () => {
    const box = document.getElementById('narrSettings');
    if (!box || box.hidden) return;
    const typing = box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const key = JSON.stringify([sharedNarrative, narrTab, narrOpen, narrRemoving, narrMoreKinds, isReadOnly, narrPlaces(), narrUnknown()]);
    if (key === narrBuilt || ((typing || narrOpen) && narrBuilt)) return;
    narrBuilt = key;
    const counts = narrCounts(), unknown = narrUnknown().length;
    const tabs = [['units', 'Units'], ['equipment', 'Equipment'], ['rules', 'Rules']];
    box.innerHTML = `<div class="narr-head">
            <span>Narrative settings</span>
            <button type="button" class="narr-close" data-narr-close title="Close" aria-label="Close">&times;</button>
        </div>
        <label class="narr-call"><span>Call them</span>
            <input type="text" id="narrEnemy" value="${escapeHtml(sharedNarrative.enemy || '')}" placeholder="enemy forces" maxlength="60" spellcheck="false"${isReadOnly ? ' disabled' : ''}></label>
        <div class="narr-hint narr-call-hint">When no unit fits a judgment.</div>
        <div class="summary-kinds narr-tabs" role="group" aria-label="Narrative settings">${tabs.map(([t, n]) =>
            `<button type="button" class="ws-tab${t === narrTab ? ' active' : ''}" data-narr-tab="${t}">${n}<span class="narr-count">${counts[t]}</span>${t === 'equipment' && unknown && !isReadOnly ? '<span class="narr-dot" title="Types in your reports that the catalogue doesn\'t know"></span>' : ''}</button>`).join('')}</div>
        <div class="narr-body">${{ units: unitsTab, equipment: equipmentTab, rules: rulesTab }[narrTab]()}</div>
        <div class="narr-hint narr-shared">Shared with everyone${isReadOnly ? '; editors change them' : ''}.</div>`;
};
const openNarrSettings = (open) => {
    const box = document.getElementById('narrSettings'), btn = document.getElementById('narrSettingsBtn');
    box.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('active', open);
    document.getElementById('summaryBody').classList.toggle('with-side', open);
    narrBuilt = null;
    renderNarrSettings();
};

// What the open form says, as an entry; null (and a toast) when it won't do.
const readNarrForm = () => {
    const val = id => (document.getElementById(id) || {}).value || '';
    const picked = attr => [...document.querySelectorAll(`[${attr}][aria-pressed="true"]`)].map(b => b.getAttribute(attr));
    if (narrTab === 'units') {
        const name = val('narrUnitName').trim();
        if (!name) { showToast('Give the unit a name.', true); return null; }
        const places = [...new Set([...picked('data-narr-place'), ...val('narrUnitOther').split(',').map(p => p.trim()).filter(Boolean)])];
        if (places.some(p => p.length > 40)) { showToast('A place name is at most 40 characters.', true); return null; }
        return { name, places: places.slice(0, 40), kinds: picked('data-narr-kind') };
    }
    if (narrTab === 'equipment') {
        const type = val('narrEqType').trim(), role = picked('data-narr-role')[0];
        if (!type) { showToast('Type the equipment name.', true); return null; }
        if (!role) { showToast(`Pick what ${type} is.`, true); return null; }
        return { type, role, origin: picked('data-narr-origin')[0] || '' };
    }
    const what = val('narrRuleWhat').trim(), words = val('narrRuleWords').trim();
    const min = Math.round(+val('narrRuleMin')), hours = Math.round(+val('narrRuleHours'));
    if (!what || !words) { showToast('Say what it judges and which words point to it.', true); return null; }
    if (!(min >= 1 && min <= 20) || !(hours >= 1 && hours <= 168)) { showToast('Times: 1 to 20; hours: 1 to 168.', true); return null; }
    return { what, words, min, hours };
};
const LIST_OF = { units: 'units', equipment: 'equipment', rules: 'custom' };
const saveNarrForm = () => {
    const entry = readNarrForm();
    if (!entry) return;
    const key = LIST_OF[narrTab], { index } = narrOpen;
    const list = narrList(key);
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
    const go = (open) => { narrOpen = open; narrRemoving = false; narrMoreKinds = false; rerender(); };
    document.getElementById('narrSettingsBtn').addEventListener('click', () => openNarrSettings(box.hidden));
    box.addEventListener('click', e => {
        if (e.target.closest('[data-narr-close]')) { openNarrSettings(false); return; }
        const tab = e.target.closest('[data-narr-tab]');
        if (tab) { narrTab = tab.dataset.narrTab; go(null); return; }
        const edit = e.target.closest('[data-narr-edit]');
        if (edit) { go({ index: +edit.dataset.narrEdit }); return; }
        if (e.target.closest('[data-narr-add]')) {
            const typed = narrTab === 'equipment' ? ((document.getElementById('narrEqFind') || {}).value || '').trim() : '';
            go({ index: -1, fill: typed });
            return;
        }
        const fill = e.target.closest('[data-narr-fill]');
        if (fill) { go({ index: -1, fill: fill.dataset.narrFill }); return; }
        if (e.target.closest('[data-narr-back]')) { go(null); return; }
        if (e.target.closest('[data-narr-more]')) { narrMoreKinds = true; rerender(); return; }
        // A chip: on or off; in a one-choice group, the others go off.
        const c = e.target.closest('.narr-chip[aria-pressed]');
        if (c) {
            const single = c.parentElement.hasAttribute('data-narr-single');
            const on = single || c.getAttribute('aria-pressed') !== 'true';
            if (single) c.parentElement.querySelectorAll('.narr-chip').forEach(o => o.setAttribute('aria-pressed', 'false'));
            c.setAttribute('aria-pressed', String(on));
            return;
        }
        if (e.target.closest('[data-narr-save]')) { saveNarrForm(); return; }
        if (e.target.closest('[data-narr-remove]')) {
            if (!narrRemoving) { narrRemoving = true; rerender(); return; }
            const key = LIST_OF[narrTab], gone = narrList(key)[narrOpen.index];
            saveNarrative({ [key]: narrList(key).filter((_, i) => i !== narrOpen.index) }, `${(gone && (gone.name || gone.type || gone.what)) || 'It'} removed.`);
        }
    });
    box.addEventListener('change', e => {
        if (e.target.id === 'narrEnemy') {
            const name = e.target.value.trim();
            if (name !== String(sharedNarrative.enemy || '')) saveNarrative({ enemy: name }, `The narrative calls them ${name || 'enemy forces'}.`);
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
    box.addEventListener('keydown', e => {
        if (e.key === 'Escape' && narrOpen) { go(null); return; }
        if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
        e.preventDefault();
        if (e.target.id === 'narrEnemy') e.target.blur();
        else if (e.target.id === 'narrEqFind') box.querySelector('[data-narr-add]').click();
        else if (narrOpen) saveNarrForm();
    });
})();

// SPDX-License-Identifier: AGPL-3.0-only

// The report table, BDA panel and roll-up, counters.
// One of the ordered scripts that make up the page (see src/app/); they
// share one top-level scope, so names declared earlier are visible here.

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

// What was typed or picked in open checklists, so a redraw (a sync from
// another operator) doesn't throw it away: "reportId|row key" -> the row's
// values; and the box being typed in, to put the cursor back in it.
let bdaDrafts = new Map();
let bdaFocus = null;   // { id, key, cls, start, end }
const keepBdaDrafts = () => {
    bdaDrafts = new Map();
    bdaFocus = null;
    const f = document.activeElement, frow = f && f.closest && f.closest('.bda-wrap:not([data-logged]) .bda-check-row');
    if (frow) {
        const caret = f.type === 'text' ? [f.selectionStart, f.selectionEnd] : [null, null];
        bdaFocus = { id: frow.closest('.bda-wrap').querySelector('[data-bda-commit]').dataset.bdaCommit,
                     key: frow.dataset.key, cls: f.className, start: caret[0], end: caret[1] };
    }
    el.log.body.querySelectorAll('.bda-wrap:not([data-logged]) .bda-check-row').forEach(row => {
        const id = row.closest('.bda-wrap').querySelector('[data-bda-commit]').dataset.bdaCommit;
        const picked = row.querySelector('.bda-eff-btn.picked');
        bdaDrafts.set(`${id}|${row.dataset.key}`, {
            qty: row.querySelector('.bda-ck-qty').value, target: row.querySelector('.bda-ck-target').value,
            coords: row.querySelector('.bda-ck-coords').value, effect: picked ? picked.dataset.bdaEff : '',
        });
    });
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
    // grid, less what has been assessed of it, so the list only ever shows
    // what's still outstanding. How many to log defaults to all that's left.
    const pending  = SaltCore.bdaPending(report);
    const effBtns  = (i, picked) => BDA_EFFECTS.map(e =>
        `<button type="button" class="bda-eff-btn bda-eff-${e.cls}${e.name === picked ? ' picked' : ''}" data-bda-eff="${e.name}" data-row="${i}" title="${e.name}">${e.key}</button>`).join('');
    const rows = pending.map((e, i) => {
        const key = `${e.type.toLowerCase()}#${i}`;
        const d = bdaDrafts.get(`${report.id}|${key}`) || { qty: e.remaining, target: e.type, coords: e.coords, effect: '' };
        return `<div class="bda-check-row${d.effect ? ' staged' : ''}" data-row="${i}" data-key="${escapeHtml(key)}" data-counted="${e.counted || e.remaining > 1 ? 1 : 0}">
        <input type="number" class="bda-ck-qty" value="${escapeHtml(Math.min(e.remaining, d.qty))}" min="1" max="${e.remaining}" aria-label="How many of ${e.remaining}" title="How many of the ${e.remaining} left">
        <input type="text" class="bda-ck-target" value="${escapeHtml(d.target)}" maxlength="200" aria-label="Target">
        <input type="text" class="bda-ck-coords" value="${escapeHtml(d.coords)}" placeholder="Coords" maxlength="200" aria-label="Coords">
        <span class="bda-eff-group">${effBtns(i, d.effect)}</span>
    </div>`;
    }).join('');
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
    refreshBdaCommit(td.querySelector('.bda-wrap'));
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
    const now  = nextStamp(report);
    const iso  = new Date().toISOString();
    const adds = [];
    wrap.querySelectorAll('.bda-check-row').forEach(row => {
        const picked = row.querySelector('.bda-eff-btn.picked');
        if (!picked) return;
        const type = row.querySelector('.bda-ck-target').value.trim();
        if (!type) return;
        // How many: at least one, at most what was left; the rest stay on the list.
        const qtyBox = row.querySelector('.bda-ck-qty');
        const qty = Math.max(1, Math.min(+qtyBox.max || 1, Math.round(+qtyBox.value) || 1));
        adds.push({
            target: row.dataset.counted === '1' || qty > 1 ? `${qty}x ${type}` : type,
            coords: row.querySelector('.bda-ck-coords').value.trim(),
            effect: picked.dataset.bdaEff,
            time: iso, user: userProfile || null,
            // Unique per entry so deletes target the right one.
            lastModified: now + adds.length,
        });
    });
    if (!adds.length) { showToast('Pick an effect for at least one element.', true); return; }
    wrap.dataset.logged = '1';  // its picks are done with: not kept over the redraw
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
    report.lastModified = nextStamp(report);
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
        report.lastModified = nextStamp(report);
        reportsByAto[activeAto] = localReports;
        saveLocalAndSync(reportsByAto);
        showToast('BDA assessment deleted.');
    });
};

// The BDA roll-up strip: totals for the whole workspace as chips. Clicking a
// chip shows only the reports with that outcome (Unassessed: reports with
// elements still to assess); clicking it again clears the filter.
const renderBdaRollup = (live) => {
    const box = el.log.bdaRollup;
    if (!box) return;
    if (!bdaMode) { box.innerHTML = ''; return; }
    const roll = SaltCore.bdaRollup(live);
    const chip = (key, label, n, cls) =>
        `<button type="button" class="bda-chip bda-eff-${cls}${bdaFilter === key ? ' active' : ''}${n ? '' : ' empty'}" data-bda-filter="${escapeHtml(key)}" title="${bdaFilter === key ? 'Show every report' : 'Show only these reports'}">${escapeHtml(label)} <strong>${n}</strong></button>`;
    box.innerHTML = `<span class="bda-rollup-total" title="Vehicles and items assessed, out of all of them in this workspace's reports">BDA <strong>${roll.done}</strong> / ${roll.total}</span>`
        + BDA_EFFECTS.map(e => chip(e.name, e.name, roll.byEffect[e.name], e.cls)).join('')
        + chip('unassessed', 'Unassessed', roll.unassessed, 'none');
};
const matchesBdaFilter = (r) => {
    if (bdaFilter === 'unassessed') { const s = bdaSummary(r); return s.done < s.total; }
    return (r.bda || []).some(b => (BDA_EFFECTS.some(e => e.name === b.effect) ? b.effect : 'Unknown') === bdaFilter);
};

// Under the Location: the NAI or OBJ a grid falls in when none was typed, and
// a Check where a typed one disagrees with the grid. Only with overlays loaded.
const locationTags = (text, id) => {
    if (!currentOverlays().length) return '';
    const a = locationInfo(text);
    const tags = [];
    [a.nai, a.obj].forEach(p => {
        // The key comes from an overlay's name: only letters, digits and hyphens make the class.
        if (p.from === 'grid') p.keys.forEach(k => tags.push(`<span class="loc-tag loc-${k.split(' ')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}" title="The grid is inside ${escapeHtml(k)}">${escapeHtml(k)}</span>`));
    });
    const near = a.nearestPl;
    if (near && !a.pl.includes(near.key) && a.pls.includes(near.key)) {
        tags.push(`<span class="loc-tag loc-pl" title="The grid is ${Math.round(near.metres)} m from ${escapeHtml(near.key)}">${escapeHtml(near.key)}</span>`);
    }
    // An editor can click a check to settle it (saved as an Update).
    a.checks.forEach(c => tags.push(id && !isReadOnly
        ? `<button type="button" class="loc-tag warn" data-fix-loc="${escapeHtml(id)}" title="${escapeHtml(c)}. Click to settle it.">Check: ${escapeHtml(c)}</button>`
        : `<span class="loc-tag warn" title="${escapeHtml(c)}">Check: ${escapeHtml(c)}</span>`));
    return tags.length ? `<div class="loc-tags">${tags.join('')}</div>` : '';
};

// Whether a report matches what's typed in the search (lower case): a heading
// on its own (N, SW...) matches the Activity's word; anything else, the
// report's text, time, custom fields and BDA. The table and the map both use it.
const matchesSearch = (r, filterText) => {
    const q = String(filterText || '').trim().toLowerCase();
    if (!q) return true;
    if (/^(n|ne|nw|s|se|sw|e|w)$/i.test(q)) return new RegExp(`\\b${q}\\b`, 'i').test(r.activity);
    const ts  = (timeDisplayMode === 'local' ? toLocalTimeString : toZuluTimeString)(r.time);
    // Custom builder fields and BDA assessments are searchable too,
    // so "destroyed" or a weather note finds its report.
    const cus = Object.values(r.custom || {}).join(' ');
    const bda = (r.bda || []).map(b => `${b.effect||''} ${b.target||''} ${b.coords||''} ${b.note||''}`).join(' ');
    return `${r.fullId} ${r.displayId} ${r.size} ${r.activity} ${r.location} ${r.yourAnalysis||''} ${r.user?.initials||''} ${ts} ${cus} ${bda}`.toLowerCase().includes(q);
};

// Forget checked rows and expanded cells whose report (or history entry) is
// gone: deleted, or in another workspace now.
const pruneTableState = (live) => {
    const byId = new Map(live.map(r => [r.id, r]));
    selectedRows.forEach(id => { if (!byId.has(id)) selectedRows.delete(id); });
    selectedHistory.forEach(k => {
        const [id, lm] = k.split('|');
        if (!((byId.get(id) || {}).history || []).some(h => String(h.lastModified) === lm)) selectedHistory.delete(k);
    });
    expandedCells.forEach(k => { if (!byId.has(k.split('|')[0])) expandedCells.delete(k); });
};

// `filterText` defaults to the current search-bar value so every repaint
// preserves the active filter without the caller having to pass it.
const renderLog =(filterText = el.log.search.value.toLowerCase()) => {
    keepBdaDrafts();
    // A row control with keyboard focus gets it back after the redraw (the
    // checklist's boxes are put back by keepBdaDrafts' own record).
    const had = document.activeElement;
    const refocus = had && had !== document.body && el.log.body.contains(had) && !bdaFocus
        ? [had.tagName.toLowerCase(), ...['data-id', 'data-lm', 'data-history-id', 'data-bda-id', 'data-edit-id', 'data-restore-id', 'data-discard-id']
            .filter(a => had.hasAttribute(a)).map(a => `[${a}="${CSS.escape(had.getAttribute(a))}"]`)].join('') + (had.classList[0] ? `.${CSS.escape(had.classList[0])}` : '')
        : null;
    let rows = localReports.filter(r => !r.deleted);
    pruneTableState(rows);
    el.log.count.textContent = `${rows.length} unique reports`;
    // Total = each live report + its history entries. Deleted excluded.
    const totalReports = rows.reduce((sum, r) => sum + 1 + ((r.history && r.history.length) || 0), 0);
    el.log.totalCount.textContent = `${totalReports} total reports`;
    renderBdaRollup(rows);
    if (bdaMode && bdaFilter) rows = rows.filter(matchesBdaFilter);

    if (filterText) rows = rows.filter(r => matchesSearch(r, filterText));

    const dir = currentSortMode.endsWith('Desc') ? -1 : 1;
    const textField = currentSortMode.replace(/Asc$|Desc$/, '');  // size | activity | location
    rows.sort((a, b) => {
        if (currentSortMode === 'recent') return (b.lastModified||0) - (a.lastModified||0);
        // ISO 8601 strings sort lexicographically the same as chronologically,
        // so the raw `.time` strings are compared, not Date objects.
        if (textField === 'time') return dir * (a.time || '').localeCompare(b.time || '');
        if (textField === 'num')  return dir * (reportNum(a) - reportNum(b));
        // Text columns: case-insensitive, with numbers in numeric order so
        // "2x T-72" sorts before "10x T-72".
        return dir * String(a[textField] || '').localeCompare(String(b[textField] || ''), undefined, { numeric: true, sensitivity: 'base' });
    });

    const timeFmt = timeDisplayMode === 'local' ? toLocalTimeString : toZuluTimeString;
    el.log.timeHeader.textContent = `Time ${timeDisplayMode === 'local' ? '(L)' : '(Z)'}`;

    // Dense free-text content (several MGRS grids, a long analysis) can wrap
    // into a very tall cell. Clamp to 2 lines; cells that actually overflow
    // get a click-to-expand affordance (marked post-render, see below). `key`
    // names the cell, so one expanded stays expanded over a redraw.
    const clampCell = (text, key) => `<span class="cell-clamp${expandedCells.has(key) ? ' expanded' : ''}" data-cell="${escapeHtml(key)}" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;

    // Keep the header's custom columns in step with the format, then emit a
    // matching cell per row (works for history rows too, which carry their
    // own `custom` snapshot).
    syncCustomColumns();
    const cusCols  = customColumns();
    const cusCells = (obj, key) => cusCols.map(l =>
        `<td class="col-custom">${clampCell((obj || {})[l.label] || '', `${key}|custom:${l.label}`)}</td>`).join('');
    const editingId = el.form.reportId.value;

    // Build into a fragment — one reflow on attach instead of N.
    const frag = document.createDocumentFragment();

    rows.forEach(report => {
        const isOpen = openHistoryRows.has(report.id);
        const row    = document.createElement('tr');
        row.dataset.id = report.id;
        // The report in the form stays highlighted through a redraw.
        if (report.id === editingId) row.classList.add('selected-row');
        const rid    = report.id;
        const shownId = formatFullId(report);
        const histBtn = (report.history && report.history.length > 0)
            ? `<button class="history-btn ${isOpen ? 'open' : ''}" data-history-id="${escapeHtml(report.id)}" title="View past versions" aria-label="Past versions of ${escapeHtml(shownId)}" aria-expanded="${isOpen}">&#8250;</button>`
            : `<button class="history-btn" style="visibility:hidden;" disabled aria-hidden="true">&#8250;</button>`;
        const refused     = isReadOnly ? null : unsavedEntry(activeAto, report);
        let statusText    = (report.updated || refused)
            ? `<span class="id-cell-wrap">${escapeHtml(shownId)}${report.updated ? '<span class="id-updated-badge">(Updated)</span>' : ''}${refused ? `<span class="unsaved-badge" title="${escapeHtml(refused.reason)}">Not saved</span>` : ''}</span>`
            : escapeHtml(shownId);
        // Editors load a report into the form from its row; the Identifier is
        // a button so the keyboard can too (it looks as the text did).
        if (!isReadOnly) {
            const said = `Edit ${shownId}${report.updated ? ', updated' : ''}${refused ? `, not saved: ${refused.reason}` : ''}`;
            statusText = `<button type="button" class="id-edit-btn" data-edit-id="${escapeHtml(report.id)}" aria-label="${escapeHtml(said)}">${statusText}</button>`;
        }
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
                        : (total && done < total) ? `${done} of ${total} assessed`
                        : `All ${done} assessed`;
            bdaBtn = `<button class="bda-btn ${state}${worstCls ? ' bda-worst-' + worstCls : ''}${openBdaRows.has(report.id) ? ' open' : ''}" data-bda-id="${escapeHtml(report.id)}" title="${tip}" aria-expanded="${openBdaRows.has(report.id)}">${label}</button>`;
        }
        row.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="row-selector" data-id="${escapeHtml(report.id)}" title="Select" aria-label="Select ${escapeHtml(shownId)}"${selectedRows.has(rid) ? ' checked' : ''}> ${histBtn} <button class="copy-btn" data-id="${escapeHtml(report.id)}" aria-label="Copy ${escapeHtml(shownId)}">Copy</button>${discardBtn}${bdaBtn}</div></td><td class="col-by reporter-col">${reporterHTML}</td><td class="col-id">${statusText}</td><td class="col-size">${clampCell(report.size, `${rid}|size`)}</td><td class="col-activity">${clampCell(report.activity, `${rid}|activity`)}</td><td class="col-location">${clampCell(report.location, `${rid}|location`)}${locationTags(report.location, report.id)}</td><td class="col-time">${escapeHtml(timeFmt(report.time))}</td><td class="col-analysis">${clampCell(report.yourAnalysis, `${rid}|analysis`)}</td>${cusCells(report.custom, rid)}`;
        frag.appendChild(row);

        if (bdaMode && openBdaRows.has(report.id)) frag.appendChild(buildBdaRow(report));

        if (isOpen && report.history && report.history.length > 0) {
            [...report.history].sort((a,b) => b.lastModified - a.lastModified).forEach((h, i, arr) => {
                const hRow = document.createElement('tr');
                hRow.className = 'history-sub-row';
                const hRep  = h.user || null;
                const hHTML = hRep ? `<span style="color:${safeColor(hRep.color)};">${escapeHtml(hRep.initials)}</span>` : '?';
                const hk = `${rid}|${h.lastModified}`;
                hRow.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="history-selector" data-id="${escapeHtml(report.id)}" data-lm="${escapeHtml(h.lastModified)}" title="Select history entry" aria-label="Select update ${arr.length - i} of ${escapeHtml(shownId)}"${selectedHistory.has(hk) ? ' checked' : ''}> <span class="hist-arrow">&#8618;</span> <button class="restore-btn" data-restore-id="${escapeHtml(report.id)}" data-lm="${escapeHtml(h.lastModified)}" title="Restore this version as current">Restore</button></div></td><td class="col-by reporter-col">${hHTML}</td><td class="col-id"><span class="id-cell-wrap">${escapeHtml(formatFullId(report))}<span class="id-updated-badge">(Update #${arr.length - i})</span></span></td><td class="col-size">${clampCell(h.size, `${hk}|size`)}</td><td class="col-activity">${clampCell(h.activity, `${hk}|activity`)}</td><td class="col-location">${clampCell(h.location, `${hk}|location`)}</td><td class="col-time">${escapeHtml(timeFmt(h.time))}</td><td class="col-analysis">${clampCell(h.yourAnalysis, `${hk}|analysis`)}</td>${cusCells(h.custom, hk)}`;
                frag.appendChild(hRow);
            });
        }
    });

    el.log.body.replaceChildren(frag);
    // Delete (and Send) follow what is checked now.
    updateSelectionUI();
    if (refocus) { const again = el.log.body.querySelector(refocus); if (again) again.focus({ preventScroll: true }); }
    if (bdaFocus) {
        const wrap = el.log.body.querySelector(`[data-bda-commit="${CSS.escape(bdaFocus.id)}"]`);
        const row = wrap && [...wrap.closest('.bda-wrap').querySelectorAll('.bda-check-row')].find(r => r.dataset.key === bdaFocus.key);
        const box = row && row.querySelector(`.${bdaFocus.cls.split(' ')[0]}`);
        if (box) {
            box.focus();
            if (bdaFocus.start !== null) box.setSelectionRange(bdaFocus.start, bdaFocus.end);
        }
    }

    // Mark only the cells that actually overflow their 2-line clamp as
    // clickable (pointer + expand). One rAF pass, after layout settles.
    requestAnimationFrame(() => {
        el.log.body.querySelectorAll('.cell-clamp').forEach(c => {
            if (!c.classList.contains('expanded'))
                c.classList.toggle('clampable', c.scrollHeight > c.clientHeight + 1);
        });
    });
};

// True from Change (or typing in the workspace fields) until Set applies it.
let configChanging = false;
// `fromSync`: a peer's change arriving. It leaves the workspace fields alone
// while they're being changed or have focus, so it can't overwrite what's
// typed there or lock them again mid-change.
const loadConfig = ({ fromSync = false } = {}) => {
    const cfg = [el.config.ato, el.config.title, el.config.history];
    const busy = fromSync && (configChanging || cfg.includes(document.activeElement));
    if (!busy) {
        el.config.ato.value   = localConfig.ato   || '';
        el.config.title.value = localConfig.title || '';
        setAtoState(!!(localConfig.ato && localConfig.title));
    }
    // Form field order follows the format, shared by every workspace.
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
    el.log.sortHeaders.forEach(th => {
        const active = (SORT_MODES[th.dataset.sort] || []).includes(currentSortMode);
        const icon   = th.querySelector('.sort-icon');
        icon.textContent = !active ? '⇅' : currentSortMode === 'recent' ? '⊙' : currentSortMode.endsWith('Asc') ? '▲' : '▼';
        icon.classList.toggle('active', active);
        // Most recently changed first is neither ascending nor descending.
        th.setAttribute('aria-sort', !active ? 'none' : currentSortMode === 'recent' ? 'other' : currentSortMode.endsWith('Asc') ? 'ascending' : 'descending');
    });
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
        const picked  = el.log.sendSelect.value;   // kept over a redraw
        el.log.sendSelect.innerHTML = targets.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
        if (targets.includes(picked)) el.log.sendSelect.value = picked;
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
const updateMgrsLockUi    = () => {
    el.menu.mgrsLockBtn.textContent = mgrsLock ? `MGRS Lock: On${mgrsLockPrefix ? ` (${mgrsLockPrefix})` : ''}` : 'MGRS Lock: Off';
    document.body.classList.toggle('mgrs-lock', mgrsLock);
    const box = document.getElementById('mgrsPrefix');
    if (box && document.activeElement !== box) box.value = mgrsLockPrefix;
    el.form.location.placeholder = mgrsLock ? 'Location (grid digits, e.g. 39697 06762)' : 'Location';
};
const applyLayoutMode     = () => { document.body.classList.toggle('scrollable-layout', el.layout.grid.classList.contains('horizontal-layout')); updateLayoutBtnText(); };

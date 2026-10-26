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
    box.innerHTML = `<span class="bda-rollup-total" title="Elements assessed, out of every element in this workspace's reports">BDA <strong>${roll.done}</strong> / ${roll.total}</span>`
        + BDA_EFFECTS.map(e => chip(e.name, e.name, roll.byEffect[e.name], e.cls)).join('')
        + chip('unassessed', 'Unassessed', roll.unassessed, 'none');
};
const matchesBdaFilter = (r) => {
    if (bdaFilter === 'unassessed') { const s = bdaSummary(r); return s.done < s.total; }
    return (r.bda || []).some(b => (BDA_EFFECTS.some(e => e.name === b.effect) ? b.effect : 'Unknown') === bdaFilter);
};

// Under the Location: the NAI or OBJ a grid falls in when none was typed, and
// a Check where a typed one disagrees with the grid. Only with overlays loaded.
const locationTags = (text) => {
    if (!currentOverlays().length) return '';
    const a = locationInfo(text);
    const tags = [];
    [a.nai, a.obj].forEach(p => {
        if (p.from === 'grid') p.keys.forEach(k => tags.push(`<span class="loc-tag" title="The grid is inside ${escapeHtml(k)}">${escapeHtml(k)}</span>`));
    });
    a.checks.forEach(c => tags.push(`<span class="loc-tag warn" title="${escapeHtml(c)}">Check: ${escapeHtml(c)}</span>`));
    return tags.length ? `<div class="loc-tags">${tags.join('')}</div>` : '';
};

const renderLog =(filterText = el.log.search.value.toLowerCase()) => {
    let rows = localReports.filter(r => !r.deleted);
    el.log.count.textContent = `${rows.length} unique reports`;
    // Total = each live report + its history entries. Deleted excluded.
    const totalReports = rows.reduce((sum, r) => sum + 1 + ((r.history && r.history.length) || 0), 0);
    el.log.totalCount.textContent = `${totalReports} total reports`;
    renderBdaRollup(rows);
    if (bdaMode && bdaFilter) rows = rows.filter(matchesBdaFilter);

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
        row.innerHTML = `<td class="col-action"><div class="action-cell"><input type="checkbox" class="row-selector" data-id="${escapeHtml(report.id)}" title="Select"> ${histBtn} <button class="copy-btn" data-id="${escapeHtml(report.id)}">Copy</button>${discardBtn}${bdaBtn}</div></td><td class="col-by reporter-col">${reporterHTML}</td><td class="col-id">${statusText}</td><td class="col-size">${clampCell(report.size)}</td><td class="col-activity">${clampCell(report.activity)}</td><td class="col-location">${clampCell(report.location)}${locationTags(report.location)}</td><td class="col-time">${escapeHtml(timeFmt(report.time))}</td><td class="col-analysis">${clampCell(report.yourAnalysis)}</td>${cusCells(report.custom)}`;
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
    el.log.sortHeaders.forEach(th => {
        const active = (SORT_MODES[th.dataset.sort] || []).includes(currentSortMode);
        const icon   = th.querySelector('.sort-icon');
        icon.textContent = !active ? '⇅' : currentSortMode === 'recent' ? '⊙' : currentSortMode.endsWith('Asc') ? '▲' : '▼';
        icon.classList.toggle('active', active);
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

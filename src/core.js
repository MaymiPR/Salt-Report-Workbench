// SPDX-License-Identifier: AGPL-3.0-only

// The workbench's pure logic: formatting, parsing, and export generation.
// Nothing here touches the DOM, storage, or the network, so the same file runs
// in the page (as window.SaltCore) and under Node's test runner (tests/js/).

(function (root) {
'use strict';

// --- Dates and times ---

const pad2 = n => String(n).padStart(2, '0');

// Calendar and clock fields of a Date, zero-padded, in local time or UTC (Zulu).
const dateFields = (d, local) => local
    ? { y: d.getFullYear(),    mo: pad2(d.getMonth() + 1),    day: pad2(d.getDate()),    h: pad2(d.getHours()),    mi: pad2(d.getMinutes()) }
    : { y: d.getUTCFullYear(), mo: pad2(d.getUTCMonth() + 1), day: pad2(d.getUTCDate()), h: pad2(d.getUTCHours()), mi: pad2(d.getUTCMinutes()) };

// "HH:MM", the format of the time inputs.
const clockValue = (d, local) => { const f = dateFields(d, local); return `${f.h}:${f.mi}`; };

// "YYYYMMDD_HHMMZ" (or "...L"), for export filenames.
const fileStamp = (d, local) => { const f = dateFields(d, local); return `${f.y}${f.mo}${f.day}_${f.h}${f.mi}${local ? 'L' : 'Z'}`; };

// Report times as shown in the table and copy text: "1430Z" or "0830L".
// Unparseable input is returned as-is rather than rendered as NaN.
const toTimeString = (d, local) => {
    const x = (d instanceof Date) ? d : new Date(d);
    if (!x || isNaN(x.getTime())) return String(d);
    const f = dateFields(x, local);
    return `${f.h}${f.mi}${local ? 'L' : 'Z'}`;
};

// "1430" (or "930") as typed into a time box -> "14:30". Returns null for
// anything else, which is left alone for the user to see and fix.
const autoColon = (text) => {
    const v = String(text || '').trim();
    if (!v || v.includes(':')) return null;
    const digits = v.replace(/\D/g, '');
    const padded = digits.length === 3 ? '0' + digits : digits;
    if (padded.length !== 4) return null;
    const h = padded.slice(0, 2), m = padded.slice(2, 4);
    if (parseInt(h, 10) > 23 || parseInt(m, 10) > 59) return null;
    return `${h}:${m}`;
};

// Combine "YYYY-MM-DD" + "HH:MM" into ms epoch, in local time or Zulu.
// Missing or invalid time means 00:00 (start) or 23:59 (end); no date, null.
const parseFilterTime = (dateStr, timeStr, isEnd, local) => {
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
    const iso = local
        ? `${dateStr}T${safe}:${isEnd ? '59' : '00'}`
        : `${dateStr}T${safe}:${isEnd ? '59' : '00'}Z`;
    const ms = new Date(iso).getTime();
    return isNaN(ms) ? null : ms;
};

// A typed "HH:MM" as an ISO timestamp on today's date, in local time or Zulu.
// A time more than an hour ahead of now is taken to be yesterday's: the Zulu
// day rolls over during a US evening, so "23:50" typed at 00:30Z means forty
// minutes ago, not twenty-three hours from now. Null for anything that isn't
// a time.
const typedTime = (text, local, now = new Date()) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    const d = new Date(now.getTime());
    if (local) d.setHours(h, mi, 0, 0); else d.setUTCHours(h, mi, 0, 0);
    if (d.getTime() - now.getTime() > 60 * 60 * 1000) {
        if (local) d.setDate(d.getDate() - 1); else d.setUTCDate(d.getUTCDate() - 1);
    }
    return d.toISOString();
};

// The timestamp for a submitted form. Blank means now. Editing a report
// refills its time box with the clock part only, so a typed time that still
// matches the report's own keeps the original timestamp (and its date);
// anything else is placed by typedTime. Null for an invalid time.
const submittedTime = (typed, local, origIso, now = new Date()) => {
    const t = String(typed || '').trim();
    if (!t) return now.toISOString();
    if (origIso) {
        const d = new Date(origIso);
        if (!isNaN(d.getTime()) && clockValue(d, local) === t.padStart(5, '0')) return origIso;
    }
    return typedTime(t, local, now);
};

// A time from a spreadsheet cell as an ISO timestamp, or null when it can't be
// read. Accepts ISO 8601; "YYYY-MM-DD HH:MM[:SS]" in the active mode; "HH:MM",
// "HHMM", with an optional Z or L suffix forcing the mode (today's date, via
// typedTime); and a DTG such as "241430Z", "241430ZOCT26" or "24 1430Z OCT 2026"
// (missing month or year means the current one).
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const parseCsvTime = (text, local, now = new Date()) => {
    const s = String(text || '').trim();
    if (!s) return null;
    const valid = d => (isNaN(d.getTime()) ? null : d.toISOString());
    let m;
    // Date and time, ISO or with a space. Without a zone, the active mode applies.
    if ((m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s))) {
        const zone = m[6] || (local ? '' : 'Z');
        return valid(new Date(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:${m[4] || '00'}${m[5] || ''}${zone}`));
    }
    if ((m = /^(\d{1,2}):?(\d{2})\s*([ZL])?$/i.exec(s))) {
        const mode = m[3] ? m[3].toUpperCase() === 'L' : local;
        return typedTime(`${m[1]}:${m[2]}`, mode, now);
    }
    if ((m = /^(\d{2})\s?(\d{2})(\d{2})\s*Z?\s*([A-Z]{3})?\s*(\d{2}|\d{4})?$/i.exec(s))) {
        const month = m[4] ? MONTHS.indexOf(m[4].toUpperCase()) : now.getUTCMonth();
        if (month < 0) return null;
        let year = m[5] ? +m[5] : now.getUTCFullYear();
        if (year < 100) year += 2000;
        return valid(new Date(Date.UTC(year, month, +m[1], +m[2], +m[3])));
    }
    return null;
};

// --- Text safety ---

const escapeHtml = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const safeColor  = (c) => /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(String(c)) ? c : 'var(--system-gray)';

// Mirrors the server's _safe() helper, so filenames are interchangeable.
const safeFilename = (s) => String(s||'').split('').map(c => /[A-Za-z0-9_-]/.test(c) ? c : '_').join('').replace(/^_+|_+$/g, '') || 'X';

// --- Reports ---

// The ATO as it appears in identifiers: upper case, no dashes ("alpha-01" ->
// "ALPHA01"). Every path that numbers reports uses this, so one workspace
// never ends up with two prefixes.
const atoPrefix = (ato) => String(ato || '').trim().toUpperCase().replace(/-/g, '');

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

// Display form of a report's identifier: Title <separator> ATO###, where the
// separator is 'dash' (" - ") or 'space'. Legacy reports without title or
// displayId fall back to the stored, concatenated fullId.
const formatFullId = (r, sep) => {
    if (!r) return '';
    if (r.title && r.displayId) return `${r.title}${sep === 'dash' ? ' - ' : ' '}${r.displayId}`;
    return r.fullId || '';
};

// Copy text in the shape of `format` (an ordered list of lines). The
// identifier line is the header when first, or a `U:` line when placed lower
// (SALT-U). Optional lines (analysis, custom fields, BDA) are skipped when empty.
const reportText = (report, format, sep) => {
    if (!report) return '';
    const idText = report.updated ? `${formatFullId(report, sep)} (Updated)` : formatFullId(report, sep);
    const lines  = [];
    format.lines.forEach((line, i) => {
        switch (line.type) {
            case 'id':       lines.push(i === 0 ? idText : `U: ${idText}`); break;
            case 'size':     lines.push(`S: ${report.size}`); break;
            case 'activity': lines.push(`A: ${report.activity}`); break;
            case 'location': lines.push(`L: ${report.location}`); break;
            case 'time':     lines.push(`T: ${toTimeString(report.time, false)}`); break;
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
    // Only rewrite when the string is nothing but coordinates; free text like
    // "vic hill 205" must never be mangled.
    if (matches.join('').replace(/\s+/g, '') !== s.replace(/\s+/g, '')) return s;
    return matches.map(m => m.trim()).join(', ');
};

// --- BDA ---

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
    return els.slice(0, 20).map((element, i) => ({
        target: element,
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

// Roll-up for a whole workspace: elements assessed out of every element in
// its live reports, assessments by effect (an effect the app doesn't know
// counts as Unknown), and how many elements have no assessment yet.
const bdaRollup = (reps) => {
    const byEffect = {};
    BDA_EFFECTS.forEach(e => { byEffect[e.name] = 0; });
    let done = 0, total = 0;
    (reps || []).forEach(r => {
        if (r.deleted) return;
        const s = bdaSummary(r);
        done += s.done; total += s.total;
        (r.bda || []).forEach(b => { byEffect[b.effect in byEffect ? b.effect : 'Unknown']++; });
    });
    return { done, total, unassessed: total - done, byEffect };
};

// --- Backups ---

const BACKUP_START = '##SALT_BACKUP##';
const BACKUP_END   = '##SALT_BACKUP_END##';
// Literal em-dashes (not the HTML entity): this is a .txt file.
const BACKUP_DIV = '='.repeat(72), BACKUP_SUB = '─'.repeat(72);

const backupFilename = (ato, title) => `${safeFilename(ato)}_${safeFilename(title)}`;
const backupTime  = iso => { if (!iso) return '—'; const f = dateFields(new Date(iso), false); return `${f.y}-${f.mo}-${f.day} ${f.h}${f.mi}Z`; };
const backupStamp = (now) => { const f = dateFields(now, false); return `${f.y}-${f.mo}-${f.day} · ${f.h}${f.mi}Z`; };

// Readable entries for the given live reports, in report-number order.
const backupReportBlocks = (reps) => [...reps].sort((a,b) => reportNum(a) - reportNum(b)).map(r => {
    let out = `${BACKUP_SUB}\n REPORT ${r.displayId}${r.updated ? '  [UPDATED]' : ''}\n${BACKUP_SUB}\n`;
    out += ` Size     : ${r.size||'—'}\n Activity : ${r.activity||'—'}\n Location : ${r.location||'—'}\n Time     : ${backupTime(r.time)}\n`;
    if (r.yourAnalysis) out += ` Analysis : ${r.yourAnalysis}\n`;
    Object.entries(r.custom || {}).forEach(([ck, cv]) => { out += ` ${ck} : ${cv}\n`; });
    if (r.user?.initials) out += ` By       : ${r.user.initials}\n`;
    (r.bda || []).forEach((b, bi) => { out += `   BDA ${bi+1}  : ${b.effect || 'Unknown'} - ${b.target || ''}${b.coords ? ' @ ' + b.coords : ''}${b.note ? ' - ' + b.note : ''}\n`; });
    if (r.history?.length) {
        [...r.history].sort((a,b) => a.lastModified - b.lastModified).forEach((h, i) => {
            out += `\n   ↳ Previous Entry ${i+1}\n      Size     : ${h.size||'—'}\n      Activity : ${h.activity||'—'}\n      Location : ${h.location||'—'}\n      Time     : ${backupTime(h.time)}\n`;
            if (h.yourAnalysis) out += `      Analysis : ${h.yourAnalysis}\n`;
        });
    }
    return out + '\n';
}).join('');

// The block the server and the importer read back.
const backupMachineData = (payload) =>
    `\n${BACKUP_DIV}\n MACHINE DATA — DO NOT EDIT BELOW THIS LINE\n${BACKUP_DIV}\n${BACKUP_START}\n${JSON.stringify(payload)}\n${BACKUP_END}\n`;

// The shared overlay list from what a backup or the server holds. A list is
// the shared set as it is; a dict is the older per-workspace form (ato ->
// list), folded into one, a later overlay replacing an earlier one of the
// same type and name.
const foldOverlays = (value) => {
    if (Array.isArray(value)) return value.filter(o => o && typeof o === 'object');
    if (!value || typeof value !== 'object') return [];
    const byKey = new Map();
    Object.values(value).forEach(list => (Array.isArray(list) ? list : []).forEach(o => {
        if (o && typeof o === 'object') byKey.set(`${o.type} ${o.name}`, o);
    }));
    return [...byKey.values()];
};

// One workspace's backup file. `reps` is exported as-is in the machine data
// (deleted flags included); only live reports are listed for reading. The
// shared overlays go in every file.
const backupText = (ato, reps, title, profiles, formats, now = new Date(), overlays = []) => {
    const active = reps.filter(r => !r.deleted);
    return `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH — ATO BACKUP\n ATO Designator : ${ato}\n Report Title   : ${title}\n Total Reports  : ${active.length}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`
        + backupReportBlocks(active)
        + backupMachineData({ workspaces: { [ato]: reps }, config: { ato, title }, profiles: profiles||{},
            formats: formats[ato] ? { [ato]: formats[ato] } : {}, overlays: foldOverlays(overlays) });
};

// Every given workspace in one file.
const allWorkspacesBackupText = (workspaces, activeAto, title, profiles, formats, now = new Date(), overlays = []) => {
    const atoKeys   = Object.keys(workspaces);
    const totalReps = atoKeys.reduce((n, k) => n + (workspaces[k]||[]).filter(r => !r.deleted).length, 0);
    let out = `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH — FULL BACKUP (ALL ATOs)\n ATOs Included  : ${atoKeys.join(', ')}\n Total Reports  : ${totalReps}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`;
    atoKeys.forEach(ato => {
        const active   = (workspaces[ato]||[]).filter(r => !r.deleted);
        const atoTitle = (active.find(r => r.title)||{}).title || ato;
        out += `${BACKUP_DIV}\n ATO: ${ato}  —  ${atoTitle}  (${active.length} report${active.length !== 1 ? 's' : ''})\n${BACKUP_DIV}\n\n`;
        out += backupReportBlocks(active);
    });
    return out + backupMachineData({ workspaces, config: { ato: activeAto, title }, profiles: profiles||{}, formats, overlays: foldOverlays(overlays) });
};

// Read a backup file's payload. Returns { data } or { error } with a message
// for the user. Files without markers are tried as raw JSON (older backups,
// hand-edited files); a leading byte-order mark is ignored.
const parseBackup = (rawText) => {
    let text = String(rawText || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const s = text.indexOf(BACKUP_START);
    const e = text.indexOf(BACKUP_END);
    const marked = s !== -1 && e !== -1 && e > s;
    const jsonText = marked ? text.slice(s + BACKUP_START.length, e).trim() : text.trim();
    if (!jsonText) return { error: 'Import failed: file is empty.' };
    let data;
    try { data = JSON.parse(jsonText); }
    catch (err) {
        return { error: (s === -1 || e === -1)
            ? `Import failed: no ${BACKUP_START} block found and the file is not raw JSON.`
            : 'Import failed: machine-data block is corrupt (' + (err.message || 'parse error') + ').' };
    }
    if (!data || typeof data !== 'object' || (!data.workspaces && !data.reports)) {
        return { error: 'Import failed: file does not contain a recognisable backup payload.' };
    }
    return { data };
};

// --- CSV ---

// RFC 4180-style parse into rows of cells: quoted fields, doubled quotes,
// and CRLF, LF, or CR line endings.
const parseCsv = (csvText) => {
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
    return arr;
};

const csvField  = v => `"${String(v||'').replace(/"/g,'""')}"`;
const csvHeader = (local, extra = []) =>
    `Identifier,UpdateStatus,Size,Activity,MGRS,Time (${local ? 'Local' : 'Z'}),Analysis${extra.map(c => ',' + c).join('')}\r\n`;
// History entries newest first, labeled "Update #N (Old)" with N counting up from the oldest.
const historyRows = (r) => {
    const h = [...(r.history || [])].sort((a,b) => b.lastModified - a.lastModified);
    return h.map((hh, i) => [`Update #${h.length-i} (Old)`, hh]);
};

// The CSV export: each report, then its history, then its BDA assessments.
// Custom builder fields become extra columns after Analysis, so the first
// seven stay index-stable for existing consumers.
// `latestOnly`: one row per report (its current version), so a platform that
// plots every row puts each report on the map once.
const reportsCsv = (reps, { local, customLabels, idOf, latestOnly = false }) => {
    const t = d => toTimeString(d, local);
    const cus = (o) => customLabels.map(c => csvField((o || {})[c] || ''));
    let csv = csvHeader(local, customLabels);
    for (const r of reps) {
        const id = idOf(r);
        csv += [csvField(id),csvField(r.updated?'Current Update':'Original'),csvField(r.size),csvField(r.activity),csvField(r.location),csvField(t(r.time)),csvField(r.yourAnalysis),...cus(r.custom)].join(',')+'\r\n';
        if (latestOnly) continue;
        historyRows(r).forEach(([label, hh]) => {
            csv += [csvField(id),csvField(label),csvField(hh.size),csvField(hh.activity),csvField(hh.location),csvField(t(hh.time)),csvField(hh.yourAnalysis),...cus(hh.custom)].join(',')+'\r\n';
        });
        // BDA assessments ride the existing columns: target in Size,
        // effect in Activity, coords in MGRS, note in Analysis.
        (r.bda||[]).forEach((b,i) => {
            csv += [csvField(id),csvField(`BDA #${i+1}`),csvField(b.target),csvField(b.effect),csvField(b.coords),csvField(t(b.time)),csvField(b.note),...customLabels.map(()=>csvField(''))].join(',')+'\r\n';
        });
    }
    return csv;
};

// MTI export: the tracked and wheeled vehicle counts found in each Size
// (current version and history), as two CSVs. Counts are written the way
// operators write them: "4 tracked", "4x tracked", or "4 x tracked".
const mtiCsvs = (reps, { local, idOf }) => {
    const t = d => toTimeString(d, local);
    const out = { tracked: csvHeader(local), wheeled: csvHeader(local), trackedRows: 0, wheeledRows: 0 };
    const row = (id, upd, size, activity, location, time, analysis) => {
        const sl = (size||'').toLowerCase();
        const tm = sl.match(/(\d+\s*x?\s*tracked)/);
        if (tm) { out.tracked += [csvField(id),csvField(upd),csvField(tm[1].trim()),csvField(activity),csvField(location),csvField(t(time)),csvField(analysis)].join(',')+'\r\n'; out.trackedRows++; }
        const wm = sl.match(/(\d+\s*x?\s*wheeled)/);
        if (wm) { out.wheeled += [csvField(id),csvField(upd),csvField(wm[1].trim()),csvField(activity),csvField(location),csvField(t(time)),csvField(analysis)].join(',')+'\r\n'; out.wheeledRows++; }
    };
    for (const r of reps) {
        const id = idOf(r);
        row(id, r.updated?'Current Update':'Original', r.size, r.activity, r.location, r.time, r.yourAnalysis);
        historyRows(r).forEach(([label, hh]) => row(id, label, hh.size, hh.activity, hh.location, hh.time, hh.yourAnalysis));
    }
    return out;
};

// --- Geography: MGRS, overlays, and what a Location box says ---

// UTM to latitude/longitude on WGS84, by Krüger's series (Karney 2011), which
// stays sub-millimetre well beyond a zone's edge (Norway's and Svalbard's wide
// zones included).
const WGS84_A = 6378137, WGS84_F = 1 / 298.257223563, UTM_K0 = 0.9996;
const KRUGER = (() => {
    const n = WGS84_F / (2 - WGS84_F), n2 = n*n, n3 = n2*n, n4 = n3*n, n5 = n4*n, n6 = n5*n;
    return {
        A: WGS84_A / (1 + n) * (1 + n2/4 + n4/64 + n6/256),
        beta: [
            n/2 - 2*n2/3 + 37*n3/96 - n4/360 - 81*n5/512 + 96199*n6/604800,
            n2/48 + n3/15 - 437*n4/1440 + 46*n5/105 - 1118711*n6/3870720,
            17*n3/480 - 37*n4/840 - 209*n5/4480 + 5569*n6/90720,
            4397*n4/161280 - 11*n5/504 - 830251*n6/7257600,
            4583*n5/161280 - 108847*n6/3991680,
            20648693*n6/638668800,
        ],
    };
})();
const utmToLatLon = (zone, south, easting, northing) => {
    const e = Math.sqrt(WGS84_F * (2 - WGS84_F));
    const xi  = (south ? northing - 10000000 : northing) / (UTM_K0 * KRUGER.A);
    const eta = (easting - 500000) / (UTM_K0 * KRUGER.A);
    let xi1 = xi, eta1 = eta;
    KRUGER.beta.forEach((b, i) => {
        const j = 2 * (i + 1);
        xi1  -= b * Math.sin(j*xi) * Math.cosh(j*eta);
        eta1 -= b * Math.cos(j*xi) * Math.sinh(j*eta);
    });
    const tau1 = Math.sin(xi1) / Math.sqrt(Math.sinh(eta1)**2 + Math.cos(xi1)**2);
    let tau = tau1;
    for (let k = 0; k < 10; k++) {  // Newton on the conformal latitude; converges in 2-3
        const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau*tau)));
        const taui  = tau * Math.sqrt(1 + sigma*sigma) - sigma * Math.sqrt(1 + tau*tau);
        const d = (tau1 - taui) / Math.sqrt(1 + taui*taui)
            * (1 + (1 - e*e) * tau*tau) / ((1 - e*e) * Math.sqrt(1 + tau*tau));
        tau += d;
        if (Math.abs(d) < 1e-12) break;
    }
    const lon0 = (zone - 1) * 6 - 177;
    return {
        lat: Math.atan(tau) * 180 / Math.PI,
        lon: lon0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) * 180 / Math.PI,
    };
};

const MGRS_BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const MGRS_COLS  = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const MGRS_ROWS  = 'ABCDEFGHJKLMNPQRSTUV';

// One MGRS grid (zone, band, 100 km square, digits) as the centre of the
// square it names: "38SMB4488" is a 1 km square, and the point is its middle.
// The 100 km row letters repeat every 2,000 km, so of the northings they
// allow, the one that lands inside the latitude band is the grid's. Null when
// the letters can't belong together (a typo).
const gridToLatLon = (zone, band, col, row, digits) => {
    band = band.toUpperCase(); col = col.toUpperCase(); row = row.toUpperCase();
    const bandIdx = MGRS_BANDS.indexOf(band);
    if (zone < 1 || zone > 60 || bandIdx < 0 || digits.length % 2 || digits.length < 2 || digits.length > 10) return null;
    const set    = zone % 6 || 6;
    const colIdx = MGRS_COLS[(set - 1) % 3].indexOf(col);
    const rowIdx = MGRS_ROWS.indexOf(row);
    if (colIdx < 0 || rowIdx < 0) return null;
    const p    = digits.length / 2;
    const cell = 10 ** (5 - p);
    const easting = (colIdx + 1) * 100000 + Number(digits.slice(0, p)) * cell + cell / 2;
    const north   = ((rowIdx - (set % 2 ? 0 : 5) + 20) % 20) * 100000 + Number(digits.slice(p)) * cell + cell / 2;
    const south   = bandIdx < MGRS_BANDS.indexOf('N');
    const minLat  = -80 + 8 * bandIdx, maxLat = band === 'X' ? 84 : minLat + 8;
    let best = null;
    for (let n = north; n < 10000000; n += 2000000) {
        const ll  = utmToLatLon(zone, south, easting, n);
        const off = ll.lat < minLat ? minLat - ll.lat : ll.lat > maxLat ? ll.lat - maxLat : 0;
        if (off < 0.6 && (!best || off < best.off)) best = { ...ll, off };
    }
    if (!best) return null;
    const e = digits.slice(0, p), n = digits.slice(p);
    return { lat: best.lat, lon: best.lon, precision: cell, mgrs: `${zone}${band} ${col}${row} ${e} ${n}` };
};

// Every MGRS grid in a piece of text, with where it sits in the text. Takes
// "38S MB 12345 67890", "38SMB1234567890" and "38smb 1234 5678"; a grid's two
// halves typed apart must be the same length. I and O are never grid letters,
// so "NAI 1" and "OBJ 2" can't be mistaken for one.
const GRID_RE = /(^|[^0-9A-Za-z])(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d{1,10})(?:\s+(\d{1,5}))?(?![0-9A-Za-z])/gi;
const findGrids = (text) => {
    const s = String(text || ''), out = [];
    const re = new RegExp(GRID_RE.source, 'gid');
    let m;
    while ((m = re.exec(s))) {
        let digits = m[6], end = m.indices[0][1];
        if (m[7] !== undefined) {
            // Halves of different lengths: the second number isn't part of
            // this grid, and may start the next thing.
            if (m[6].length === m[7].length) digits = m[6] + m[7];
            else re.lastIndex = end = m.indices[6][1];
        }
        const ll = gridToLatLon(Number(m[2]), m[3], m[4], m[5], digits);
        if (ll) out.push({ ...ll, start: m.indices[2][0], end });
    }
    return out;
};

// Named places as operators type them: "NAI 1", "nai01", "OBJ GOLD",
// "Objective Gold", "PL BLUE", "Phase Line Blue". Numbers lose leading zeros,
// so NAI 01 and NAI 1 are one place. A bare "PL" glued to letters ("PLATOON")
// is not a phase line; "PL3" is.
const REF_TYPES = { NAI: 'NAI', OBJ: 'OBJ', OBJECTIVE: 'OBJ', PL: 'PL', 'PHASE LINE': 'PL' };
const REF_RE = /(^|[^A-Za-z0-9])(NAI|OBJECTIVE|OBJ|PHASE\s+LINE|PL)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/gi;
const refName = (name) => { const n = String(name).toUpperCase(); return /^\d+$/.test(n) ? String(Number(n)) : n; };
const findRefs = (text) => {
    const out = [], seen = new Set();
    const re = new RegExp(REF_RE.source, 'gi');
    let m;
    const s = String(text || '');
    while ((m = re.exec(s))) {
        const type = REF_TYPES[m[2].toUpperCase().replace(/\s+/g, ' ')];
        // "38S PL 12345": the 100 km square of a grid that didn't read as one
        // (a typo), not a phase line.
        if (type === 'PL' && /\d{1,2}\s*[C-HJ-NP-X]\s*$/i.test(s.slice(0, m.index + m[1].length))) continue;
        const name = refName(m[3]);
        const key  = `${type} ${name}`;
        if (!seen.has(key)) { seen.add(key); out.push({ type, name, key }); }
    }
    return out;
};

// An overlay's name ("NAI 3", "OBJ Gold (bridge)", "Gold") as a place
// reference. The name is its first word after the prefix, as when typed.
// Without a prefix, `fallbackType` decides; null when neither does.
const overlayRef = (rawName, fallbackType) => {
    const s = String(rawName || '').trim();
    const m = /^(NAI|OBJECTIVE|OBJ|PHASE\s+LINE|PL)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/i.exec(s);
    const type = m ? REF_TYPES[m[1].toUpperCase().replace(/\s+/g, ' ')] : fallbackType;
    const word = m ? m[2] : (/[A-Za-z0-9]+/.exec(s) || [])[0];
    if (!type || !word) return null;
    const name = refName(word);
    return { type, name, key: `${type} ${name}` };
};

// Ray casting in longitude/latitude: exact enough for areas a few tens of
// kilometres across. Holes (inner rings) exclude.
const inRing = (lon, lat, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};
const inPolygon = (lon, lat, rings) => rings.length > 0 && inRing(lon, lat, rings[0]) && !rings.slice(1).some(h => inRing(lon, lat, h));
const geometryContains = (g, lon, lat) =>
    g.type === 'Polygon' ? inPolygon(lon, lat, g.coordinates)
  : g.type === 'MultiPolygon' ? g.coordinates.some(p => inPolygon(lon, lat, p))
  : false;

// Metres from a point to a line, on a flat projection centred on the point:
// within a fraction of a percent over the tens of kilometres that matter here.
const metresToLine = (lon, lat, line) => {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const ax = (line[i-1][0] - lon) * kx, ay = (line[i-1][1] - lat) * ky;
        const bx = (line[i][0]   - lon) * kx, by = (line[i][1]   - lat) * ky;
        const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
        const t  = len2 ? Math.max(0, Math.min(1, -(ax*dx + ay*dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + t*dx, ay + t*dy));
    }
    return best;
};
const metresToGeometry = (g, lon, lat) =>
    g.type === 'LineString' ? metresToLine(lon, lat, g.coordinates)
  : g.type === 'MultiLineString' ? Math.min(...g.coordinates.map(l => metresToLine(lon, lat, l)))
  : Infinity;

// A grid this close to a phase line counts as a report at that line.
const PL_NEAR_METRES = 1000;

// An NAI or OBJ drawn as a path (Google Earth's Add Path, or a ring on its
// own) is still an area: each path is closed back to its start. A path of
// fewer than three points stays a line.
const asArea = (g) => {
    const ring = (line) => {
        const r = line.slice(), a = r[0], b = r[r.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
        return r.length >= 4 ? [r] : null;
    };
    if (!g) return g;
    if (g.type === 'LineString') { const p = ring(g.coordinates); return p ? { type: 'Polygon', coordinates: p } : g; }
    if (g.type === 'MultiLineString') {
        const ps = g.coordinates.map(ring).filter(Boolean);
        return ps.length ? { type: 'MultiPolygon', coordinates: ps } : g;
    }
    return g;
};

// What a Location box says, read against the workspace's overlays:
//   points  the grids, as lat/lon (a report can name several)
//   nai/obj the places it's in: as typed, or (when none was typed) the
//           overlays its grids fall inside, marked 'grid'
//   pl      phase lines typed, and the nearest PL overlay with its distance
//   pls     the phase lines it is at: typed, or the nearest within
//           PL_NEAR_METRES of a grid
//   checks  where a typed NAI or OBJ disagrees with the grid. The typed name
//           still counts; the check is for a person to look at.
const analyzeLocation = (text, overlays) => {
    const points = findGrids(text);
    let rest = String(text || '');
    points.forEach(p => { rest = rest.slice(0, p.start) + ' '.repeat(p.end - p.start) + rest.slice(p.end); });
    const refs = findRefs(rest);
    const typed = t => refs.filter(r => r.type === t).map(r => r.key);
    const ovs = (overlays || []).filter(o => o && o.geometry);
    const keyOf = o => `${o.type} ${o.name}`;
    const contains = (o) => points.some(p => geometryContains(o.geometry, p.lon, p.lat));
    const checks = [];
    const place = (t) => {
        const keys  = typed(t);
        const areas = ovs.filter(o => o.type === t).map(o => ({ ...o, geometry: asArea(o.geometry) }))
            .filter(o => /Polygon/.test(o.geometry.type));
        const inside = [...new Set(areas.filter(contains).map(keyOf))];
        if (!keys.length) return { keys: inside, from: inside.length ? 'grid' : '' };
        if (points.length) {
            keys.forEach(k => {
                const own = areas.filter(o => keyOf(o) === k);
                if (own.length && !own.some(contains)) {
                    const other = inside.filter(i => !keys.includes(i));
                    checks.push(other.length ? `${k} typed; grid is in ${other.join(', ')}` : `${k} typed; grid is outside it`);
                }
            });
        }
        return { keys, from: 'typed' };
    };
    const nai = place('NAI'), obj = place('OBJ');
    let nearestPl = null;
    ovs.filter(o => o.type === 'PL').forEach(o => points.forEach(p => {
        const d = metresToGeometry(o.geometry, p.lon, p.lat);
        if (isFinite(d) && (!nearestPl || d < nearestPl.metres)) nearestPl = { key: keyOf(o), metres: d };
    }));
    return {
        points: points.map(({ start, end, ...p }) => p),
        nai, obj, pl: typed('PL'), nearestPl, checks,
        pls: [...new Set([...typed('PL'), ...(nearestPl && nearestPl.metres <= PL_NEAR_METRES ? [nearestPl.key] : [])])],
    };
};

// What Log or Update should do to a Location box, read against the overlays:
//   add        places its grids are in (or, for a phase line, within
//              PL_NEAR_METRES of) that the box doesn't name yet; added only
//              for a type nothing was typed for
//   conflicts  typed NAIs, OBJs and PLs the grids disagree with, each with
//              what the grids say instead (`found`, may be empty), for the
//              operator to settle
// Nothing to do without a grid, or for a typed name with no overlay to check.
const locationPlan = (text, overlays) => {
    const a = analyzeLocation(text, overlays);
    const plan = { add: [], conflicts: [] };
    if (!a.points.length) return plan;
    const ovs = (overlays || []).filter(o => o && o.geometry);
    const keyOf = o => `${o.type} ${o.name}`;
    ['NAI', 'OBJ'].forEach(t => {
        const p = t === 'NAI' ? a.nai : a.obj;
        if (p.from === 'grid') { plan.add.push(...p.keys); return; }
        const areas = ovs.filter(o => o.type === t).map(o => ({ ...o, geometry: asArea(o.geometry) }))
            .filter(o => /Polygon/.test(o.geometry.type));
        const inside = o => a.points.some(pt => geometryContains(o.geometry, pt.lon, pt.lat));
        const found = [...new Set(areas.filter(inside).map(keyOf))].filter(k => !p.keys.includes(k));
        p.keys.forEach(k => {
            const own = areas.filter(o => keyOf(o) === k);
            if (own.length && !own.some(inside)) plan.conflicts.push({ type: t, typed: k, found,
                message: found.length ? `${k} typed; grid is in ${found.join(', ')}` : `${k} typed; grid is outside it` });
        });
    });
    const near = a.nearestPl && a.nearestPl.metres <= PL_NEAR_METRES ? a.nearestPl : null;
    if (!a.pl.length) { if (near) plan.add.push(near.key); return plan; }
    a.pl.forEach(k => {
        const own = ovs.filter(o => o.type === 'PL' && keyOf(o) === k);
        if (!own.length) return;
        const d = Math.min(...own.flatMap(o => a.points.map(pt => metresToGeometry(o.geometry, pt.lon, pt.lat))));
        if (d <= PL_NEAR_METRES) return;
        const found = near && !a.pl.includes(near.key) ? [near.key] : [];
        const km = (d / 1000).toFixed(1);
        plan.conflicts.push({ type: 'PL', typed: k, found,
            message: found.length ? `${k} typed; grid is ${km} km from it, ${Math.round(near.metres)} m from ${near.key}` : `${k} typed; grid is ${km} km from it` });
    });
    return plan;
};

// A Location box with typed places swapped (`replace`: key -> what to write
// in its place, '' to take it out) and those in `add` appended (", NAI 1")
// unless already named. Grids and everything else are left as they were.
const editLocation = (text, { replace = {}, add = [] } = {}) => {
    let s = String(text || '');
    const blank = (str) => {
        let out = str;
        findGrids(str).forEach(p => { out = out.slice(0, p.start) + ' '.repeat(p.end - p.start) + out.slice(p.end); });
        return out;
    };
    if (Object.keys(replace).length) {
        const re = new RegExp(REF_RE.source, 'gid'), b = blank(s), spans = [];
        let m;
        while ((m = re.exec(b))) {
            const type = REF_TYPES[m[2].toUpperCase().replace(/\s+/g, ' ')];
            if (type === 'PL' && /\d{1,2}\s*[C-HJ-NP-X]\s*$/i.test(b.slice(0, m.index + m[1].length))) continue;
            const key = `${type} ${refName(m[3])}`;
            if (key in replace) spans.push([m.indices[2][0], m.indices[3][1], replace[key]]);
        }
        if (spans.length) {
            spans.reverse().forEach(([x, y, to]) => { s = s.slice(0, x) + to + s.slice(y); });
            s = s.replace(/\s*,(\s*,)+\s*/g, ', ').replace(/[ \t]{2,}/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '');
        }
    }
    const have = new Set(findRefs(blank(s)).map(r => r.key));
    const extra = [...new Set(add)].filter(k => !have.has(k));
    const head = s.replace(/[\s,;]+$/, '');
    if (extra.length) s = (head ? head + ', ' : '') + extra.join(', ');
    return s;
};

// --- Shapefiles ---

// Web Mercator (ArcGIS's default for web layers) to longitude / latitude.
const webMercatorToLonLat = ([x, y]) => [x / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI];

// What a .prj (WKT, as ArcGIS writes it) says the coordinates are, as
// { name, toLonLat }: geographic (WGS 84, NAD 83), Web Mercator, or a UTM zone
// on WGS 84 or NAD 83 (a metre or so apart, well inside a grid square). Any
// other system is refused by name. Null without a .prj.
const shapefileProjection = (wkt) => {
    const s = String(wkt || '').trim();
    if (!s) return null;
    const name = ((/^(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\s*\[\s*"([^"]*)"/i.exec(s) || [])[1] || 'an unknown coordinate system').replace(/_/g, ' ');
    if (/^GEOG(CS|CRS)\b/i.test(s)) return { name, toLonLat: c => c };
    if (/Mercator_Auxiliary_Sphere|Pseudo[-_ ]Mercator|Popular_Visuali[sz]ation|\b(3857|102100|102113|900913)\b/i.test(s)) {
        return { name, toLonLat: webMercatorToLonLat };
    }
    const param = (k) => { const m = new RegExp(`PARAMETER\\s*\\[\\s*"${k}"\\s*,\\s*(-?[\\d.]+)`, 'i').exec(s); return m ? Number(m[1]) : null; };
    const datum = /WGS[ _]?(19)?84|NAD[ _]?(19)?83|North[ _]American[ _]1983/i.test(s);
    if (datum && /Transverse[ _]Mercator/i.test(s) && param('scale_factor') === 0.9996 && param('false_easting') === 500000) {
        const fn = param('false_northing') || 0;
        const zone = (param('central_meridian') + 183) / 6;
        if (Number.isInteger(zone) && zone >= 1 && zone <= 60 && (fn === 0 || fn === 10000000)) {
            const south = fn === 10000000;
            return { name, toLonLat: ([x, y]) => { const ll = utmToLatLon(zone, south, x, y); return [ll.lon, ll.lat]; } };
        }
    }
    throw new Error(`its coordinates are in ${name}. Export it again in WGS 1984 (or as KML)`);
};

// The rows of a .dbf (dBASE) attribute table, one object per record, in the
// order of the shapes. Text is UTF-8 when the .cpg says so or it reads as
// UTF-8, else Windows-1252 (what ArcGIS writes for older layers).
const readDbf = (buf, cpg) => {
    const dv = new DataView(buf), bytes = new Uint8Array(buf);
    if (buf.byteLength < 32) return [];
    const n = dv.getUint32(4, true), headLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
    const fields = [];
    for (let o = 32; o + 32 <= headLen && bytes[o] !== 0x0d; o += 32) {
        let name = '';
        for (let k = 0; k < 11 && bytes[o + k]; k++) name += String.fromCharCode(bytes[o + k]);
        fields.push({ name, type: String.fromCharCode(bytes[o + 11]).toUpperCase(), len: bytes[o + 16] });
    }
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const latin = new TextDecoder('windows-1252');
    const wantUtf8 = /utf-?8|65001/i.test(cpg || '');
    const text = (b) => {
        if (wantUtf8 || !cpg) { try { return utf8.decode(b); } catch (e) { if (wantUtf8) return new TextDecoder('utf-8').decode(b); } }
        return latin.decode(b);
    };
    const rows = [];
    for (let r = 0; r < n; r++) {
        const at = headLen + r * recLen;
        if (at + recLen > buf.byteLength) break;
        const row = {};
        let o = at + 1;  // after the deletion flag
        fields.forEach(f => {
            const v = text(bytes.subarray(o, o + f.len)).trim();
            o += f.len;
            row[f.name] = (f.type === 'N' || f.type === 'F') && v !== '' && isFinite(Number(v)) ? Number(v) : v;
        });
        rows.push(row);
    }
    return rows;
};

// Twice a ring's signed area: negative when it runs clockwise, which in a
// shapefile marks an outer ring (holes run the other way).
const ringArea2 = (r) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
const inRingXY = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};

// A shapefile as a GeoJSON FeatureCollection in longitude / latitude, with
// each shape's attributes as its properties: points, lines (PolyLine), and
// areas (Polygon, holes kept), with or without Z and M. Throws a message for
// the user when it can't be read.
const parseShapefile = (shp, dbf, prj, cpg) => {
    const dv = new DataView(shp);
    if (shp.byteLength < 100 || dv.getInt32(0) !== 9994) throw new Error('it is not a shapefile (.shp)');
    const proj = shapefileProjection(prj);
    const rows = dbf ? readDbf(dbf, cpg) : [];
    const features = [];
    for (let p = 100, i = 0; p + 12 <= shp.byteLength; i++) {
        const start = p + 8, end = start + dv.getInt32(p + 4) * 2;
        p = end;
        if (end > shp.byteLength) break;
        const type = dv.getInt32(start, true);
        const kind = type === 31 ? 0 : type % 10;  // 1 point, 3 line, 5 area, 8 multipoint (Z, M alike); 31 multipatch
        const xy = (at) => [dv.getFloat64(at, true), dv.getFloat64(at + 8, true)];
        let geometry = null;
        if (kind === 1) geometry = { type: 'Point', coordinates: xy(start + 4) };
        else if (kind === 8) {
            const n = dv.getInt32(start + 36, true);
            geometry = { type: 'MultiPoint', coordinates: Array.from({ length: n }, (_, k) => xy(start + 40 + 16 * k)) };
        } else if (kind === 3 || kind === 5) {
            const nParts = dv.getInt32(start + 36, true), nPts = dv.getInt32(start + 40, true);
            const parts = Array.from({ length: nParts }, (_, k) => dv.getInt32(start + 44 + 4 * k, true));
            const at0 = start + 44 + 4 * nParts;
            const paths = parts.map((s, k) => Array.from({ length: (k + 1 < nParts ? parts[k + 1] : nPts) - s }, (_, m) => xy(at0 + 16 * (s + m))))
                .filter(path => path.length >= 2);
            if (kind === 3) {
                if (paths.length) geometry = paths.length === 1 ? { type: 'LineString', coordinates: paths[0] } : { type: 'MultiLineString', coordinates: paths };
            } else {
                // Each hole goes with the outer ring around it.
                const polys = paths.filter(r => ringArea2(r) < 0).map(r => [r]);
                paths.filter(r => ringArea2(r) >= 0).forEach(h => {
                    const host = polys.find(poly => inRingXY(h[0][0], h[0][1], poly[0])) || null;
                    if (host) host.push(h); else polys.push([h]);  // no outer around it: an area of its own
                });
                if (polys.length) geometry = polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
            }
        }
        features.push({ type: 'Feature', geometry, properties: rows[i] || {} });
    }
    const project = (v) => typeof v[0] === 'number' ? proj.toLonLat(v) : v.map(project);
    if (proj) features.forEach(f => { if (f.geometry) f.geometry.coordinates = project(f.geometry.coordinates); });
    const flat = (v) => typeof v[0] === 'number' ? [v] : v.flatMap(flat);
    const all = features.flatMap(f => f.geometry ? flat(f.geometry.coordinates) : []);
    if (all.some(c => !isFinite(c[0]) || !isFinite(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
        throw new Error(proj ? 'some of its coordinates are out of range' : 'it has no .prj file, and its coordinates are not longitude/latitude. Include the .prj (or zip the shapefile)');
    }
    return { type: 'FeatureCollection', features };
};

// --- Tracks, heat, and the map ---

// Where each report has been: the first grid of each version's Location, in
// the order the versions were reported (their Time), the current one last.
// A grid repeated in a row counts once. `moved` when it has two or more.
//   points     [{ lon, lat, mgrs, time }]
//   lengthM    along the track; bearingDeg from its start to its end
const reportTracks = (reps) => (reps || []).filter(r => !r.deleted).map(r => {
    const versions = [...(r.history || [])].sort((a, b) => (new Date(a.time) - new Date(b.time)) || (a.lastModified - b.lastModified));
    const points = [];
    [...versions, r].forEach(v => {
        const g = findGrids(v.location)[0];
        if (!g) return;
        const last = points[points.length - 1];
        if (last && last.mgrs === g.mgrs) { last.time = v.time; return; }
        points.push({ lon: g.lon, lat: g.lat, mgrs: g.mgrs, time: v.time });
    });
    let lengthM = 0;
    for (let i = 1; i < points.length; i++) lengthM += metresBetween(points[i - 1], points[i]);
    const bearingDeg = points.length >= 2 ? bearingBetween(points[0], points[points.length - 1]) : null;
    return { report: r, points, moved: points.length >= 2, lengthM, bearingDeg };
}).filter(t => t.points.length);

// Metres between two points, and the bearing from the first to the second
// (degrees clockwise from north), on a sphere: plenty for tracks of a few km.
const metresBetween = (a, b) => {
    const R = 6371008.8, f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180;
    const df = f2 - f1, dl = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const bearingBetween = (a, b) => {
    const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};
const compass16 = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

// One weight per unique report, at its latest Location (split evenly when it
// names several grids), so a heat map counts each report once, however many
// times it was updated.
const heatPoints = (reps) => (reps || []).filter(r => !r.deleted).flatMap(r => {
    const grids = findGrids(r.location);
    return grids.map(g => ({ lon: g.lon, lat: g.lat, w: 1 / grids.length }));
});

// ArcGIS tracks: one line per report that moved, from its first grid to its
// latest in the order reported, for an arrow symbol at the line's end.
const arcgisTrackRows = (reps, { local, idOf }) => reportTracks(reps).filter(t => t.moved).map(t => {
    const r = t.report, first = t.points[0], last = t.points[t.points.length - 1];
    const act = classifyActivity(r.activity);
    const iso = d => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : '');
    return {
        report_id: idOf(r), ato: r.ato || '', title: r.title || '',
        size: r.size || '', activity: r.activity || '', act_tags: act.tags.join('; '),
        start_utc: iso(first.time), end_utc: iso(last.time),
        start_disp: first.time ? toTimeString(first.time, local) : '', end_disp: last.time ? toTimeString(last.time, local) : '',
        positions: t.points.length, length_m: Math.round(t.lengthM),
        bearing_deg: Math.round(t.bearingDeg), direction: compass16(t.bearingDeg),
        start_mgrs: first.mgrs, end_mgrs: last.mgrs,
        reporter: (r.user && r.user.initials) || '',
        path: t.points.map(p => [Math.round(p.lon * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7]),
    };
});
const attrsOf = (row) => { const { path, ...rest } = row; return rest; };
const arcgisTracksGeoJson = (rows) => JSON.stringify({
    type: 'FeatureCollection',
    features: rows.map(row => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: row.path }, properties: attrsOf(row) })),
});
const arcgisTracksEsriJson = (rows) => esriJson(rows.map(attrsOf), 'esriGeometryPolyline', (row, i) => ({ paths: [rows[i].path] }));

// Web Mercator (the tile services' projection), metres, and back.
const MERC_R = 6378137;
const lonLatToMerc = (lon, lat) => [lon * Math.PI / 180 * MERC_R, Math.log(Math.tan(Math.PI / 4 + Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 360)) * MERC_R];
const MERC_WORLD = 2 * Math.PI * MERC_R;

// The tiles (z/x/y, Google / OSM numbering, as WMTS GoogleMapsCompatible
// and ArcGIS tile services use) covering a Web Mercator box, each with its
// own box. At most `max` tiles; null when that's more.
const tilesFor = ([x0, y0, x1, y1], z, max = 256) => {
    const n = 2 ** z, size = MERC_WORLD / n;
    const col = x => Math.floor((x + MERC_WORLD / 2) / size), row = y => Math.floor((MERC_WORLD / 2 - y) / size);
    const c0 = Math.max(0, col(x0)), c1 = Math.min(n - 1, col(x1)), r0 = Math.max(0, row(y1)), r1 = Math.min(n - 1, row(y0));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > max) return null;
    const out = [];
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) {
        const bx0 = x * size - MERC_WORLD / 2, by1 = MERC_WORLD / 2 - y * size;
        out.push({ z, x, y, box: [bx0, by1 - size, bx0 + size, by1] });
    }
    return out;
};
// The zoom whose tiles show `metresPerPixel` (256-pixel tiles), rounded up for sharpness.
const tileZoom = (metresPerPixel) => Math.max(0, Math.min(20, Math.ceil(Math.log2(MERC_WORLD / 256 / metresPerPixel))));

// A tile's address from a template: {z} {x} {y} (or WMTS's {TileMatrix}
// {TileCol} {TileRow}; {-y} counts rows from the south, as TMS does).
const tileUrl = (template, { z, x, y }) => String(template)
    .replace(/\{(z|TileMatrix)\}/gi, z).replace(/\{(x|TileCol)\}/gi, x)
    .replace(/\{-y\}/gi, 2 ** z - 1 - y).replace(/\{(y|TileRow)\}/gi, y);

// A WMS GetMap address for a Web Mercator box: the service's address (its
// own parameters kept, ours replacing any of the same name), PNG, EPSG:3857.
const wmsUrl = (base, layers, [x0, y0, x1, y1], width, height) => {
    const [path, query = ''] = String(base).split('?');
    const ours = {
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: layers || '', STYLES: '',
        CRS: 'EPSG:3857', BBOX: [x0, y0, x1, y1].map(v => v.toFixed(2)).join(','),
        WIDTH: Math.round(width), HEIGHT: Math.round(height), FORMAT: 'image/png', TRANSPARENT: 'FALSE',
    };
    const keep = query.split('&').filter(kv => kv && !(kv.split('=')[0].toUpperCase() in ours) && kv.split('=')[0].toUpperCase() !== 'SRS');
    if (!layers) {
        const had = query.split('&').find(kv => kv.split('=')[0].toUpperCase() === 'LAYERS');
        if (had) ours.LAYERS = decodeURIComponent(had.split('=').slice(1).join('='));
    }
    const enc = v => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
    return `${path}?${[...keep, ...Object.entries(ours).map(([k, v]) => `${k}=${enc(v)}`)].join('&')}`;
};

// --- Activity ---

// Tags for what an Activity line describes, in a fixed order, and the
// heading when one is given ("moving N", "heading 270", "NB", "westbound").
// A report can carry several tags ("dismounted, moving N"); a heading implies
// Moving. Plain keyword rules, so the same words always give the same tags.
const ACTIVITY_TAGS = [
    ['Moving',      /\b(mov(e|es|ed|ing)|mvg|mvmt|movement|travel{1,2}(s|ed|ing)?|driv(e|es|ing)|advanc(e|es|ed|ing)|withdraw(s|n|ing)?|retreat(s|ed|ing)?|convoy|en ?route|head(s|ed|ing)|transit(s|ing)?|maneuver(s|ing)?|proceed(s|ing)?|cross(es|ed|ing)|fly(ing)?|flight|[nsew]b|(north|south|east|west)bound)\b/i],
    ['Stationary',  /\b(stationary|static|parked|halt(s|ed)?|stopped|idl(e|ing)|sitting|occupy(ing)?|occupied|holding|loiter(s|ing)?|in position|dug in)\b/i],
    ['Dismounted',  /\b(dismount(s|ed|ing)?|on foot|foot patrol|walking)\b/i],
    ['Emplacing',   /\b(dig(s|ging)?|dug in|emplac(e|es|ed|ing)|entrench(es|ed|ing)?|construct(s|ed|ing)?|build(s|ing)?|fortif(y|ies|ied|ying)|laying (mines?|wire)|obstacles?)\b/i],
    ['Firing',      /\b(fir(e|es|ed|ing)|engag(e|es|ed|ing)|shoot(s|ing)?|launch(es|ed|ing)?|shelling)\b/i],
    ['Observing',   /\b(observ(e|es|ed|ing)|recon(naissance)?|surveil(s|ling|lance)?|scouting)\b/i],
    ['Resupplying', /\b(resuppl(y|ies|ying)|refuel(s|ing|ling)?|rearm(s|ing)?|loading|unloading)\b/i],
];
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const DIR_WORDS = {
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};
const MOVE_BEFORE_DIR = /\b(?:mov(?:e|es|ed|ing)|mvg|head(?:s|ed|ing)?|travel{1,2}(?:s|ed|ing)?|driv(?:e|es|ing)|advanc(?:e|es|ed|ing)|withdraw(?:s|n|ing)?|retreat(?:s|ed|ing)?|toward(?:s)?|to the|en ?route|transit(?:s|ing)?|proceed(?:s|ing)?|fly(?:ing)?|bearing|brg|az)\s+(?:[a-z]+\s+){0,2}?(north[- ]?(?:east|west)?|south[- ]?(?:east|west)?|east|west|[NSEW]{1,3}|\d{3})(?:°|\s*deg(?:rees)?)?\b/i;
const classifyActivity = (text) => {
    const s = String(text || '');
    const tags = ACTIVITY_TAGS.filter(([, re]) => re.test(s)).map(([t]) => t);
    let heading = null, headingDeg = null, m;
    if ((m = MOVE_BEFORE_DIR.exec(s))) {
        const d = m[1].toUpperCase().replace(/[- ]/g, '');
        if (/^\d{3}$/.test(d)) {
            if (+d < 360) { headingDeg = +d; heading = COMPASS[Math.round(headingDeg / 22.5) % 16]; }
        } else if (DIR_WORDS[d] || COMPASS.includes(d)) {
            heading = DIR_WORDS[d] || d; headingDeg = COMPASS.indexOf(heading) * 22.5;
        }
    } else if ((m = /\b(?:([NSEW])B|(north|south|east|west)bound)\b/i.exec(s))) {
        heading = m[1] ? m[1].toUpperCase() : DIR_WORDS[m[2].toUpperCase()];
        headingDeg = COMPASS.indexOf(heading) * 22.5;
    }
    if (heading && !tags.includes('Moving')) tags.unshift('Moving');
    return { tags, heading, headingDeg };
};

// --- ArcGIS export ---

// One row per grid of each live report: a report naming three grids becomes
// three points. Reports with no readable grid are counted, not exported.
// Field names avoid SQL reserved words (TIME, CHECK), which some geodatabases
// refuse or rename.
const arcgisRows = (reps, overlays, { local, customLabels = [], idOf }) => {
    const rows = []; let skipped = 0;
    const field = l => 'c_' + String(l).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    for (const r of reps) {
        if (r.deleted) continue;
        const a = analyzeLocation(r.location, overlays);
        if (!a.points.length) { skipped++; continue; }
        const act = classifyActivity(r.activity);
        const bda = (r.bda || []).map(b => `${b.effect || 'Unknown'} - ${b.target || ''}`).join('; ');
        a.points.forEach((p, i) => {
            const row = {
                report_id: idOf(r), ato: r.ato || '', title: r.title || '',
                time_utc: r.time ? new Date(r.time).toISOString().replace(/\.\d{3}Z$/, 'Z') : '',
                time_disp: r.time ? toTimeString(r.time, local) : '',
                size: r.size || '', activity: r.activity || '',
                act_tags: act.tags.join('; '), heading: act.heading || '', heading_deg: act.headingDeg,
                location: r.location || '', mgrs: p.mgrs, grid_n: `${i + 1}/${a.points.length}`,
                precision_m: p.precision,
                nai: a.nai.keys.join('; '), nai_from: a.nai.from, obj: a.obj.keys.join('; '), obj_from: a.obj.from,
                pl: a.pl.join('; '), pl_near: a.nearestPl ? a.nearestPl.key : '',
                pl_dist_m: a.nearestPl ? Math.round(a.nearestPl.metres) : null,
                loc_check: a.checks.join('; '), analysis: r.yourAnalysis || '',
                reporter: (r.user && r.user.initials) || '', bda, updated: r.updated ? 'yes' : 'no',
            };
            customLabels.forEach(l => { row[field(l)] = (r.custom || {})[l] || ''; });
            row.lat = Math.round(p.lat * 1e7) / 1e7;
            row.lon = Math.round(p.lon * 1e7) / 1e7;
            rows.push(row);
        });
    }
    return { rows, skipped };
};

// ArcGIS Pro guesses GeoJSON field types and gives text fields 255
// characters, so a longer Analysis or Location fails the whole import. Text
// is cut to fit here; the Esri JSON and CSV exports keep all of it.
const GEOJSON_TEXT_MAX = 254;
const arcgisGeoJson = (rows) => JSON.stringify({
    type: 'FeatureCollection',
    features: rows.map(row => {
        const properties = {};
        Object.entries(row).forEach(([k, v]) => {
            properties[k] = typeof v === 'string' && v.length > GEOJSON_TEXT_MAX ? v.slice(0, GEOJSON_TEXT_MAX - 1) + '…' : v;
        });
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [row.lon, row.lat] }, properties };
    }),
});

// Esri JSON: the format JSON To Features was made for. Every field's type
// and length is written out, so ArcGIS Pro has nothing to guess. `rows` are
// the attributes; `geometryOf(row, i)` gives each feature's shape.
const esriJson = (rows, geometryType, geometryOf) => {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const fields = cols.map(name => {
        const vals = rows.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
        if (vals.length && vals.every(v => typeof v === 'number')) {
            const type = vals.every(Number.isInteger) && !['lat', 'lon'].includes(name) ? 'esriFieldTypeInteger' : 'esriFieldTypeDouble';
            return { name, type, alias: name };
        }
        const length = Math.max(1, ...vals.map(v => String(v).length));
        return { name, type: 'esriFieldTypeString', alias: name, length };
    });
    const numeric = new Set(fields.filter(f => f.type !== 'esriFieldTypeString').map(f => f.name));
    return JSON.stringify({
        displayFieldName: 'report_id',
        geometryType,
        spatialReference: { wkid: 4326, latestWkid: 4326 },
        fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID' }, ...fields],
        features: rows.map((row, i) => {
            const attributes = { OBJECTID: i + 1 };
            cols.forEach(c => {
                const v = row[c];
                attributes[c] = numeric.has(c) ? (typeof v === 'number' ? v : null) : (v === null || v === undefined ? '' : String(v));
            });
            return { attributes, geometry: { ...geometryOf(row, i), spatialReference: { wkid: 4326 } } };
        }),
    });
};
const arcgisEsriJson = (rows) => esriJson(rows, 'esriGeometryPoint', row => ({ x: row.lon, y: row.lat }));

const arcgisCsv = (rows) => {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const cell = v => (v === null || v === undefined) ? '' : typeof v === 'number' ? String(v) : csvField(v);
    return cols.join(',') + '\r\n' + rows.map(r => cols.map(c => cell(r[c])).join(',')).join('\r\n') + '\r\n';
};

// --- Statistics ---

// The elements of a Size line with their counts: "2x T-72, 4 BMP-2; truck"
// -> T-72 x2, BMP-2 x4, TRUCK x1. Types are upper-cased, and a plural "s" is
// dropped ("T-72s", "trucks") so the same vehicle is counted as one type.
const sizeElements = (size) => String(size || '').split(/[,;+]/).map(s => s.trim()).filter(Boolean).map(part => {
    const m = /^(\d+)\s*x?\s*(.+)$/i.exec(part);
    let type = (m ? m[2] : part).trim().replace(/\s+/g, ' ');
    if (/[^su]s$/.test(type) && !/ss$/i.test(type)) type = type.slice(0, -1);
    return { count: m ? Number(m[1]) : 1, type: type.toUpperCase() };
}).filter(e => e.type && e.count > 0);

// The MGRS square a grid sits in at `digits` per half (1: 10 km, 2: 1 km),
// or null when the grid was given more coarsely than that.
const gridSquare = (mgrs, digits) => {
    const [zb, sq, e = '', n = ''] = String(mgrs).split(' ');
    if (e.length < digits) return null;
    return `${zb} ${sq} ${e.slice(0, digits)} ${n.slice(0, digits)}`;
};

const HEADINGS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Everything the Statistics panel draws, for the live reports given (already
// cut to the time window). Each report counts once per place, square, tag, or
// type it names; history is not counted. Lists are sorted largest first.
//   squareDigits  1 = 10 km squares, 2 = 1 km squares
const statsData = (reps, overlays, { local, squareDigits = 1 } = {}) => {
    const live = (reps || []).filter(r => !r.deleted);
    const tally = () => new Map();
    const add = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
    const nai = tally(), obj = tally(), pl = tally(), squares = tally(), tags = tally(), equipment = tally();
    const hours = new Array(24).fill(0), headings = new Array(8).fill(0), days = tally();
    let withGrid = 0, inPlace = 0, checks = 0, coarse = 0;
    for (const r of live) {
        const a = analyzeLocation(r.location, overlays);
        if (a.points.length) withGrid++;
        if (a.nai.keys.length || a.obj.keys.length) inPlace++;
        if (a.checks.length) checks++;
        a.nai.keys.forEach(k => add(nai, k));
        a.obj.keys.forEach(k => add(obj, k));
        a.pls.forEach(k => add(pl, k));
        const sq = new Set();
        a.points.forEach(p => { const s = gridSquare(p.mgrs, squareDigits); if (s) sq.add(s); else coarse++; });
        sq.forEach(s => add(squares, s));
        const act = classifyActivity(r.activity);
        (act.tags.length ? act.tags : ['Untagged']).forEach(t => add(tags, t));
        if (act.headingDeg !== null) headings[Math.round(act.headingDeg / 45) % 8]++;
        sizeElements(r.size).forEach(e => add(equipment, e.type, e.count));
        const d = new Date(r.time);
        if (!isNaN(d.getTime())) {
            const f = dateFields(d, local);
            hours[+f.h]++;
            add(days, `${f.y}-${f.mo}-${f.day}`);
        }
    }
    const sorted = map => [...map].map(([label, value]) => ({ label, value }))
        .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label, undefined, { numeric: true }));
    // Every day from the first to the last, so a quiet day shows as zero.
    const dayList = [];
    const keys = [...days.keys()].sort();
    if (keys.length) {
        for (let t = Date.parse(`${keys[0]}T00:00:00Z`), end = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`); t <= end; t += 86400000) {
            const k = new Date(t).toISOString().slice(0, 10);
            dayList.push({ label: k, value: days.get(k) || 0 });
        }
    }
    const order = ACTIVITY_TAGS.map(([t]) => t).concat('Untagged');
    const roll = bdaRollup(live);
    return {
        kpis: { reports: live.length, withGrid, inPlace, checks, bdaDone: roll.done, bdaTotal: roll.total },
        nai: sorted(nai), obj: sorted(obj), pl: sorted(pl),
        squares: sorted(squares), coarse,
        hours: hours.map((value, h) => ({ label: pad2(h), value })),
        days: dayList,
        tags: order.filter(t => tags.has(t)).map(t => ({ label: t, value: tags.get(t) })),
        headings: HEADINGS_8.map((label, i) => ({ label, value: headings[i] })),
        equipment: sorted(equipment),
        bda: roll.done ? [...BDA_EFFECTS.map(e => ({ label: e.name, value: roll.byEffect[e.name] })), { label: 'Unassessed', value: roll.unassessed }] : [],
    };
};

// One CSV holding every table the panel shows, section by section.
const statsCsv = (sections) => sections.map(({ title, items }) =>
    [csvField(title), ...items.map(i => `${csvField(i.label)},${i.value}`)].join('\r\n')).join('\r\n\r\n') + '\r\n';

// --- Summary reports ---

// Written reports built from fixed templates and counting rules, so the same
// reports always give the same text and nothing is made up. Plain text, for
// chat, email, a .txt, or print.

// "251800Z OCT 26" (a DTG), or "251800L OCT 26" in local time.
const dtg = (ms, local) => {
    const f = dateFields(new Date(ms), local);
    return `${f.day}${f.h}${f.mi}${local ? 'L' : 'Z'} ${MONTHS[+f.mo - 1]} ${String(f.y).slice(2)}`;
};
// "251400Z": day and time, so a list crossing midnight still reads in order.
const dayTime = (ms, local) => { const f = dateFields(new Date(ms), local); return `${f.day}${f.h}${f.mi}${local ? 'L' : 'Z'}`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const countList = (items) => items.map(i => `${i.label} ${i.value}`).join(', ');

// What the summaries need about each report, worked out once.
const reportFacts = (r, overlays) => {
    const a = analyzeLocation(r.location, overlays);
    const act = classifyActivity(r.activity);
    return {
        r, a, act, ms: new Date(r.time).getTime(),
        places: [...a.nai.keys, ...a.obj.keys],
        pls: a.pls,
    };
};
const oneLine = (f) => `${f.r.size || '-'}; ${f.r.activity || '-'}; ${f.r.location || '-'}`;
const reportLine = (f, local) => `${dayTime(f.ms, local)}  ${pad(f.r.displayId || f.r.id || '', 9)} ${oneLine(f)}`;
const pad = (s, n) => String(s).padEnd(n);

// The busiest hour among some reports: "0200Z (3)".
const peakHour = (facts, local) => {
    const hours = new Array(24).fill(0);
    facts.forEach(f => { hours[+dateFields(new Date(f.ms), local).h]++; });
    const h = hours.indexOf(Math.max(...hours));
    return facts.length ? `${pad2(h)}00${local ? 'L' : 'Z'} (${hours[h]})` : '-';
};
// "Moving 7 (N 4, E 2), Stationary 3", the tags largest first.
const activityLine = (facts) => {
    const tags = new Map(), heads = new Map();
    facts.forEach(f => {
        f.act.tags.forEach(t => tags.set(t, (tags.get(t) || 0) + 1));
        if (f.act.heading) { const h = HEADINGS_8[Math.round(f.act.headingDeg / 45) % 8]; heads.set(h, (heads.get(h) || 0) + 1); }
    });
    const desc = m => [...m].map(([label, value]) => ({ label, value })).sort((x, y) => y.value - x.value);
    return desc(tags).map(t => t.label === 'Moving' && heads.size
        ? `Moving ${t.value} (heading ${countList(desc(heads))})` : `${t.label} ${t.value}`).join(', ') || 'none tagged';
};

// The most common tag among some reports: "mostly Moving (3)".
const topTag = (facts) => {
    const tags = new Map();
    facts.forEach(f => f.act.tags.forEach(t => tags.set(t, (tags.get(t) || 0) + 1)));
    const best = [...tags].sort((x, y) => y[1] - x[1])[0];
    return best ? `mostly ${best[0]} (${best[1]})` : '';
};

const SUMMARY_KINDS = {
    rollup:     'ROLLUP',
    trafficked: 'MOST TRAFFICKED',
    place:      'ACTIVITY',
    brief:      'SHIFT BRIEF',
};

// The written report of one kind ('rollup', 'trafficked', 'place', 'brief')
// over the live reports between `from` and `to` (ms; null for open ends).
// When both ends are set, the same length of time just before is the
// "previous" period it compares with.
//   opts: { local, from, to, now, ato, title, by, place, squareDigits }
const summaryReport = (kind, reps, overlays, opts) => {
    const { local, from = null, to = null, now = new Date(), ato = '', title = '', by = '', place = '', squareDigits = 2 } = opts;
    const facts = (reps || []).filter(r => !r.deleted).map(r => reportFacts(r, overlays))
        .filter(f => !isNaN(f.ms)).sort((x, y) => x.ms - y.ms);
    const within = (lo, hi) => facts.filter(f => (lo === null || f.ms >= lo) && (hi === null || f.ms <= hi));
    const cur = within(from, to);
    const span = from !== null && to !== null ? to - from : null;
    const prev = span !== null ? within(from - span, from - 1) : null;
    const hrs = span !== null ? Math.round(span / 3600000) : null;
    const prevNote = prev ? `previous ${hrs} hrs: ${prev.length}` : '';
    const d = statsData(cur.map(f => f.r), overlays, { local, squareDigits });
    const name = kind === 'place' ? `${place || 'PLACE'} ${SUMMARY_KINDS.place}` : SUMMARY_KINDS[kind];
    const period = from === null && to === null ? `ALL REPORTS TO ${dtg(now.getTime(), local)}`
        : `${from === null ? 'START' : dtg(from, local)} TO ${to === null ? dtg(now.getTime(), local) : dtg(to, local)}${hrs ? ` (${hrs} HRS)` : ''}`;
    const out = [
        `${name} - ${ato}${title ? ` (${title})` : ''}`,
        `${pad(kind === 'brief' ? 'SHIFT:' : 'PERIOD:', 10)}${period}`,
        `${pad('PREPARED:', 10)}${dtg(now.getTime(), local)}${by ? ` BY ${by}` : ''}`,
        '',
    ];
    const placesTop = [...d.nai, ...d.obj].sort((x, y) => y.value - x.value);
    const outside = cur.filter(f => !f.places.length).length;
    const prevCount = (key) => prev ? prev.filter(f => f.places.includes(key) || f.pls.includes(key)).length : null;
    const atPlace = (key) => cur.filter(f => f.places.includes(key) || f.pls.includes(key));
    const unassessed = d.kpis.bdaTotal - d.kpis.bdaDone;

    if (kind === 'rollup') {
        out.push('1. SUMMARY',
            `   ${plural(cur.length, 'report')}${prev ? ` (${prevNote})` : ''}. ${d.kpis.withGrid} with a grid; ${d.kpis.inPlace} in an NAI or OBJ.`);
        if (placesTop.length) out.push(`   Busiest: ${placesTop.slice(0, 3).map(p => `${p.label} (${p.value})`).join(', ')}. Peak hour ${peakHour(cur, local)}.`);
        out.push('', '2. BY PLACE');
        if (!placesTop.length && !d.pl.length) out.push('   No NAI, OBJ, or phase line named or found by grid.');
        [...placesTop, ...d.pl].forEach(p => {
            const pc = prevCount(p.label);
            out.push(`   ${pad(p.label, 14)}${pad(p.value, 4)}${pc !== null ? pad(`(prev ${pc})`, 11) : ''}${activityLine(atPlace(p.label))}`);
        });
        if (outside) out.push(`   ${pad('Elsewhere', 14)}${outside}`);
        out.push('', '3. ACTIVITY', `   ${activityLine(cur)}`,
            '', '4. REPORTED BY TYPE (from Size)', `   ${countList(d.equipment.slice(0, 12)) || 'none'}`);
        const notable = cur.filter(f => f.act.tags.includes('Firing') || f.act.tags.includes('Emplacing'));
        out.push('', '5. NOTABLE (firing or emplacing)');
        out.push(...(notable.length ? notable.map(f => `   ${reportLine(f, local)}`) : ['   None.']));
        out.push('', '6. BDA', d.kpis.bdaDone
            ? `   ${d.kpis.bdaDone} of ${plural(d.kpis.bdaTotal, 'element')} assessed: ${countList(d.bda.filter(b => b.value && b.label !== 'Unassessed'))}.`
            : '   None assessed.');
        const checks = cur.filter(f => f.a.checks.length);
        out.push('', '7. TO CHECK');
        out.push(...(checks.length ? checks.map(f => `   ${f.r.displayId || f.r.id}: ${f.a.checks.join('; ')}`) : ['   Nothing.']));
    } else if (kind === 'trafficked') {
        const row = (label, list) => `   ${pad(label, 16)}${pad(plural(list.length, 'report'), 12)}peak ${pad(peakHour(list, local), 12)}${topTag(list)}`;
        out.push('1. NAI AND OBJ');
        out.push(...(placesTop.length ? placesTop.slice(0, 10).map(p => row(p.label, atPlace(p.label))) : ['   None named or found by grid.']));
        out.push('', '2. PHASE LINES');
        out.push(...(d.pl.length ? d.pl.slice(0, 10).map(p => row(p.label, atPlace(p.label))) : ['   None named or near a grid.']));
        out.push('', `3. GRID SQUARES (${squareDigits === 1 ? '10 KM' : '1 KM'})`);
        out.push(...(d.squares.length ? d.squares.slice(0, 10).map(s => {
            const list = cur.filter(f => f.a.points.some(pt => gridSquare(pt.mgrs, squareDigits) === s.label));
            const where = [...new Set(list.flatMap(f => f.places))].join(', ');
            return `${row(s.label, list)}${where ? `; in ${where}` : ''}`;
        }) : ['   No readable grids.']));
        const hours = [...d.hours].sort((x, y) => y.value - x.value || x.label.localeCompare(y.label)).filter(h => h.value).slice(0, 3);
        out.push('', '4. BUSIEST HOURS', `   ${hours.map(h => `${h.label}00-${h.label}59${local ? 'L' : 'Z'} (${h.value})`).join(', ') || 'none'}`);
    } else if (kind === 'place') {
        const list = place ? atPlace(place) : [];
        if (!place) out.push('Pick an NAI, OBJ, or phase line.');
        else {
            const pc = prevCount(place);
            out.push(`${plural(list.length, 'report')}${pc !== null ? ` (previous ${hrs} hrs: ${pc})` : ''}. ${activityLine(list)}.`);
            if (list.length) out.push(`Busiest hour ${peakHour(list, local)}.`);
            out.push('', 'DTG      REPORT    SIZE; ACTIVITY; LOCATION');
            out.push(...(list.length ? list.map(f => reportLine(f, local)) : ['None in this period.']));
        }
    } else if (kind === 'brief') {
        const last = cur[cur.length - 1];
        out.push(
            `REPORTS:      ${cur.length}${prev ? ` (previous shift ${prev.length})` : ''}`,
            `MOST ACTIVE:  ${[...placesTop, ...d.pl].sort((x, y) => y.value - x.value).slice(0, 3).map(p => `${p.label} (${p.value})`).join(', ') || 'none named'}`,
            `ACTIVITY:     ${activityLine(cur)}`,
            `LAST REPORT:  ${last ? reportLine(last, local) : 'none'}`,
            `OPEN ITEMS:   ${plural(cur.filter(f => f.a.checks.length).length, 'check')} to look at; ${plural(unassessed, 'BDA element')} unassessed`,
            '', 'LAST 5 REPORTS',
            ...(cur.length ? cur.slice(-5).reverse().map(f => `  ${reportLine(f, local)}`) : ['  None.']),
        );
    }
    return out.join('\n') + '\n';
};

// Every place the summaries can be about: overlays, and whatever is named.
const summaryPlaces = (reps, overlays) => {
    const d = statsData(reps, overlays, {});
    const keys = new Set([...(overlays || []).map(o => `${o.type} ${o.name}`), ...d.nai, ...d.obj, ...d.pl].map(x => x.label || x));
    const order = { NAI: 0, OBJ: 1, PL: 2 };
    return [...keys].sort((a, b) => order[a.split(' ')[0]] - order[b.split(' ')[0]] || a.localeCompare(b, undefined, { numeric: true }));
};

// --- Sync bookkeeping ---

// Reports are matched the way the server merges them: by id, or by
// displayId for rows that predate ids.
const reportKey = r => (r && (r.id || r.displayId)) || '';

// The version of each report a workspace holds: key -> lastModified.
const knownVersions = reps => {
    const out = {};
    (reps || []).forEach(r => { const k = reportKey(r); if (k) out[k] = r.lastModified || 0; });
    return out;
};

// The reports the server doesn't hold in this exact version: new ones and
// changed ones. With no record of the server's copy (`known` undefined),
// everything is sent.
const changedReports = (reps, known) =>
    (reps || []).filter(r => { const k = reportKey(r); return k && (!known || known[k] !== (r.lastModified || 0)); });

// Lay changes the server refused over its copy of a workspace, so they stay
// visible until fixed or discarded. A refused change the server has since
// moved past (someone saved a newer version) is superseded and dropped.
const withUnsaved = (serverReps, unsavedReps) => {
    const reports = [...(serverReps || [])];
    const index = {};
    reports.forEach((r, i) => { index[reportKey(r)] = i; });
    const superseded = [];
    (unsavedReps || []).forEach(u => {
        const k = reportKey(u);
        const i = index[k];
        if (i === undefined) { index[k] = reports.length; reports.push(u); }
        else if ((reports[i].lastModified || 0) > (u.lastModified || 0)) superseded.push(k);
        else reports[i] = u;
    });
    return { reports, superseded };
};

const SaltCore = {
    pad2, dateFields, clockValue, fileStamp, toTimeString, autoColon, parseFilterTime, typedTime, submittedTime, parseCsvTime,
    escapeHtml, safeColor, safeFilename,
    atoPrefix, reportNum, formatFullId, reportText, normalizeLocation,
    BDA_EFFECTS, bdaElements, bdaSummary, bdaRollup,
    backupFilename, foldOverlays, backupText, allWorkspacesBackupText, parseBackup,
    parseCsv, reportsCsv, mtiCsvs,
    utmToLatLon, gridToLatLon, findGrids, findRefs, overlayRef, geometryContains, metresToGeometry,
    webMercatorToLonLat, readDbf, shapefileProjection, parseShapefile,
    reportTracks, heatPoints, arcgisTrackRows, arcgisTracksGeoJson, arcgisTracksEsriJson,
    lonLatToMerc, MERC_WORLD, compass16, tilesFor, tileZoom, tileUrl, wmsUrl, metresBetween, bearingBetween,
    asArea, analyzeLocation, locationPlan, editLocation, classifyActivity, ACTIVITY_TAGS, arcgisRows, arcgisGeoJson, arcgisEsriJson, arcgisCsv,
    sizeElements, gridSquare, statsData, statsCsv, PL_NEAR_METRES,
    dtg, summaryReport, summaryPlaces,
    reportKey, knownVersions, changedReports, withUnsaved,
};

if (typeof module === 'object' && module.exports) module.exports = SaltCore;
else root.SaltCore = SaltCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);

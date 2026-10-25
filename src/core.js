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

// One workspace's backup file. `reps` is exported as-is in the machine data
// (deleted flags included); only live reports are listed for reading.
const backupText = (ato, reps, title, profiles, formats, now = new Date()) => {
    const active = reps.filter(r => !r.deleted);
    return `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH — ATO BACKUP\n ATO Designator : ${ato}\n Report Title   : ${title}\n Total Reports  : ${active.length}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`
        + backupReportBlocks(active)
        + backupMachineData({ workspaces: { [ato]: reps }, config: { ato, title }, profiles: profiles||{}, formats: formats[ato] ? { [ato]: formats[ato] } : {} });
};

// Every given workspace in one file.
const allWorkspacesBackupText = (workspaces, activeAto, title, profiles, formats, now = new Date()) => {
    const atoKeys   = Object.keys(workspaces);
    const totalReps = atoKeys.reduce((n, k) => n + (workspaces[k]||[]).filter(r => !r.deleted).length, 0);
    let out = `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH — FULL BACKUP (ALL ATOs)\n ATOs Included  : ${atoKeys.join(', ')}\n Total Reports  : ${totalReps}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`;
    atoKeys.forEach(ato => {
        const active   = (workspaces[ato]||[]).filter(r => !r.deleted);
        const atoTitle = (active.find(r => r.title)||{}).title || ato;
        out += `${BACKUP_DIV}\n ATO: ${ato}  —  ${atoTitle}  (${active.length} report${active.length !== 1 ? 's' : ''})\n${BACKUP_DIV}\n\n`;
        out += backupReportBlocks(active);
    });
    return out + backupMachineData({ workspaces, config: { ato: activeAto, title }, profiles: profiles||{}, formats });
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
const reportsCsv = (reps, { local, customLabels, idOf }) => {
    const t = d => toTimeString(d, local);
    const cus = (o) => customLabels.map(c => csvField((o || {})[c] || ''));
    let csv = csvHeader(local, customLabels);
    for (const r of reps) {
        const id = idOf(r);
        csv += [csvField(id),csvField(r.updated?'Current Update':'Original'),csvField(r.size),csvField(r.activity),csvField(r.location),csvField(t(r.time)),csvField(r.yourAnalysis),...cus(r.custom)].join(',')+'\r\n';
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
    pad2, dateFields, clockValue, fileStamp, toTimeString, autoColon, parseFilterTime, typedTime, parseCsvTime,
    escapeHtml, safeColor, safeFilename,
    atoPrefix, reportNum, formatFullId, reportText, normalizeLocation,
    BDA_EFFECTS, bdaElements, bdaSummary,
    backupFilename, backupText, allWorkspacesBackupText, parseBackup,
    parseCsv, reportsCsv, mtiCsvs,
    reportKey, knownVersions, changedReports, withUnsaved,
};

if (typeof module === 'object' && module.exports) module.exports = SaltCore;
else root.SaltCore = SaltCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);

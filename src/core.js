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

// What the formatters print for a time that is missing or not a time, as
// the app shows any empty value.
const NO_TIME = '-';
// A time as a Date, or null when there is none (null, '', 0) or it is invalid.
const timeOf = (v) => {
    if (v === null || v === undefined || v === '' || v === 0 || v === false) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
};

// Report times as shown in the table and copy text: "1430Z" or "0830L".
// Unparseable text is returned as-is rather than rendered as NaN, so it can
// be seen and fixed; no time at all (or an invalid Date) is NO_TIME.
const toTimeString = (d, local) => {
    const x = timeOf(d);
    if (!x) return typeof d === 'string' && d.trim() ? d : NO_TIME;
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
// An end takes in the whole of its minute, to the last millisecond.
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
        ? `${dateStr}T${safe}:${isEnd ? '59.999' : '00'}`
        : `${dateStr}T${safe}:${isEnd ? '59.999' : '00'}Z`;
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
// typedTime); and a DTG such as "241430Z", "241430ZOCT26" or "24 1430Z OCT 2026",
// which is Zulu unless it ends in L ("241430L"). A date that doesn't exist (31 NOV,
// 30 FEB) or a clock past 23:59 is null, never rolled into the next month. A
// DTG without its month (or year) is the latest such date not in the future,
// with typedTime's hour of slack: "311430Z" read on 1 Nov is 31 Oct.
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const parseCsvTime = (text, local, now = new Date()) => {
    const s = String(text || '').trim();
    if (!s) return null;
    // A calendar date that exists: day 1 to the month's last.
    const realDate = (y, mo, day) => mo >= 1 && mo <= 12 && day >= 1 && new Date(Date.UTC(y, mo - 1, day)).getUTCDate() === day;
    let m;
    // Date and time, ISO or with a space. Without a zone, the active mode applies.
    if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s))) {
        if (!realDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
        const zone = m[8] || (local ? '' : 'Z');
        const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}${m[7] || ''}${zone}`);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if ((m = /^(\d{1,2}):?(\d{2})\s*([ZL])?$/i.exec(s))) {
        const mode = m[3] ? m[3].toUpperCase() === 'L' : local;
        return typedTime(`${m[1]}:${m[2]}`, mode, now);
    }
    if ((m = /^(\d{2})\s?(\d{2})(\d{2})\s*([ZL])?\s*([A-Z]{3})?\s*(\d{2}|\d{4})?$/i.exec(s))) {
        const day = +m[1], h = +m[2], mi = +m[3];
        if (day < 1 || day > 31 || h > 23 || mi > 59) return null;
        // A DTG is Zulu unless it says L; it doesn't follow the active mode.
        const inLocal = !!m[4] && m[4].toUpperCase() === 'L';
        const month = m[5] ? MONTHS.indexOf(m[5].toUpperCase()) : null;
        if (month === -1) return null;
        let year = m[6] ? +m[6] : null;
        if (year !== null && year < 100) year += 2000;
        // The time on that day of a month (months past 11 or below 0 roll the
        // year), or null when the month has no such day.
        const at = (y, mo) => {
            const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
            const d = inLocal ? new Date(yy, mm, day, h, mi) : new Date(Date.UTC(yy, mm, day, h, mi));
            return (inLocal ? d.getDate() : d.getUTCDate()) === day ? d : null;
        };
        const nowY = inLocal ? now.getFullYear() : now.getUTCFullYear(), nowM = inLocal ? now.getMonth() : now.getUTCMonth();
        const past = d => d && d.getTime() - now.getTime() <= 60 * 60 * 1000;
        let d = null;
        if (month !== null && year !== null) d = at(year, month);
        else if (month !== null) {
            // The month given, in this year or the last that has the day (29 FEB).
            for (let k = 0; k < 8 && !past(d); k++) d = at(nowY - k, month);
        } else if (year !== null) d = at(year, nowM);
        else {
            // This month, or the last one before it that has the day.
            for (let k = 0; k < 12 && !past(d); k++) d = at(nowY, nowM - k);
        }
        if (year === null) d = past(d) ? d : null;
        return d ? d.toISOString() : null;
    }
    return null;
};

// --- Text safety ---

// Only null and undefined are empty: a count of 0 still shows.
const escapeHtml = (s) => (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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

// The report numbers (displayIds) two or more live reports share: logged at
// once on two machines, one of them offline, say.
const duplicateIds = (reports) => {
    const seen = new Set(), twice = new Set();
    (reports || []).forEach(r => {
        if (!r || r.deleted || !r.displayId) return;
        (seen.has(r.displayId) ? twice : seen).add(r.displayId);
    });
    return twice;
};

// The number after the highest a workspace's live reports use (its deleted
// ones too, with `withDeleted`: copies brought in never take a number a
// deleted report could come back with).
const nextNum = (reports, { withDeleted = false } = {}) =>
    (reports || []).filter(r => r && (withDeleted || !r.deleted)).reduce((m, r) => Math.max(m, reportNum(r)), 0) + 1;

// A report's number as it is shown and stored: the ATO, then three digits at least.
const displayId = (ato, n) => `${ato}${String(n).padStart(3, '0')}`;

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
// A locked grid prefix: the grid zone and 100 km square ("11S NV"), from how
// an operator types it ("11snv", "11S NV"). Null when it isn't one.
const mgrsPrefix = (text) => {
    const m = /^\s*(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*$/i.exec(String(text || ''));
    if (!m || +m[1] < 1 || +m[1] > 60) return null;
    return `${+m[1]}${m[2]} ${m[3]}${m[4]}`.toUpperCase();
};
// The Location with the locked prefix put in front of each grid typed as its
// digits alone ("39697 06762" or "3969706762", any even count); full grids,
// place names and odd numbers ("Hill 205", "205") are left as they are.
const applyMgrsPrefix = (text, prefix) => {
    const p = mgrsPrefix(prefix), s = String(text || '');
    if (!p) return s;
    return s.split(',').map(seg => {
        const t = seg.trim(), lead = seg.slice(0, seg.length - seg.trimStart().length);
        let m = /^(\d{1,5})\s+(\d{1,5})$/.exec(t);
        if (m && m[1].length === m[2].length) return `${lead}${p} ${m[1]} ${m[2]}`;
        if (/^\d{2,10}$/.test(t) && t.length % 2 === 0) return `${lead}${p} ${t.slice(0, t.length / 2)} ${t.slice(t.length / 2)}`;
        return seg;
    }).join(',');
};

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

// Split a report's Size into elements and Location into grids (each as an
// MGRS grid, "18S UJ 11 11", however it was typed), then pair them: equal
// counts pair positionally; a single grid is shared by every element;
// anything else leaves the grid blank for the user to fill.
const bdaElements = (report) => {
    const els   = String(report.size || '').split(/[,;+]/).map(s => s.trim()).filter(t => t.length >= 2);
    const grids = findGrids(report.location).map(g => g.mgrs);
    return els.slice(0, 20).map((element, i) => ({
        target: element,
        coords: (grids.length === els.length) ? grids[i]
              : (grids.length === 1)          ? grids[0]
              : '',
    }));
};

// An element or an assessment as a count and a type, read as the Statistics
// read a Size (sizePart): "40x T-72" -> 40 of T-72, "4 BMP-2" -> 4, "T-72 x4"
// -> 4, "truck" -> 1, "0x T-72" -> none. A number run into a name ("2S19") is
// part of the name. The type is as written, for display.
const bdaCount = (text) => {
    const c = sizeCount(String(text || '').trim());
    return { count: c.count, type: c.text, counted: c.counted };
};
// Types match whatever the case or spacing, and a plural as the Statistics
// fold it (singularType): "T-72s", "BUSES" and "lorries" are T-72, BUS, LORRY.
// `team` is the team's equipment (teamEquipment), whose plurals fold too.
const bdaTypeKey = (type, team = null) => singularType(String(type || '').trim().replace(/\s+/g, ' '), team).toUpperCase();

// What is still to assess: each element less what has been assessed of its
// type (taken from the elements in order), so 3x destroyed of "40x T-72"
// leaves "37x T-72". `remaining` of `total`, and the element as it now reads.
const bdaPending = (report, team = null) => {
    const assessed = {};
    (report.bda || []).forEach(b => {
        const c = bdaCount(b.target), k = bdaTypeKey(c.type, team);
        if (k) assessed[k] = (assessed[k] || 0) + c.count;
    });
    return bdaElements(report).map(e => {
        const c = bdaCount(e.target), k = bdaTypeKey(c.type, team);
        const off = Math.min(c.count, assessed[k] || 0);
        if (k) assessed[k] = (assessed[k] || 0) - off;
        const remaining = c.count - off;
        return { ...e, type: c.type, counted: c.counted, total: c.count, remaining, target: off ? `${remaining}x ${c.type}` : e.target };
    }).filter(e => e.remaining > 0);
};

// Roll-up used by the pill: how many are assessed (counting each vehicle or
// item, so 3 of "40x T-72" is 3 of 40) and the worst outcome recorded so far.
const bdaUnits = (report) => bdaElements(report).reduce((s, e) => s + bdaCount(e.target).count, 0);
const bdaSummary = (report) => {
    const done  = (report.bda || []).reduce((s, b) => s + bdaCount(b.target).count, 0);
    const total = Math.max(bdaUnits(report), done);
    let worst = -1;
    (report.bda || []).forEach(b => {
        const i = BDA_EFFECTS.findIndex(e => e.name === b.effect);
        if (i > -1 && (worst === -1 || i < worst)) worst = i;
    });
    return { done, total, worstCls: worst > -1 ? BDA_EFFECTS[worst].cls : '' };
};

// Roll-up for a whole workspace: vehicles and items assessed out of all of
// them in its live reports, how many had each effect (an effect the app
// doesn't know counts as Unknown), and how many have no assessment yet.
const bdaRollup = (reps) => {
    const byEffect = {};
    BDA_EFFECTS.forEach(e => { byEffect[e.name] = 0; });
    let done = 0, total = 0;
    (reps || []).forEach(r => {
        if (r.deleted) return;
        const s = bdaSummary(r);
        done += s.done; total += s.total;
        (r.bda || []).forEach(b => { byEffect[b.effect in byEffect ? b.effect : 'Unknown'] += bdaCount(b.target).count; });
    });
    return { done, total, unassessed: total - done, byEffect };
};

// --- Backups ---

const BACKUP_START = '##SALT_BACKUP##';
const BACKUP_END   = '##SALT_BACKUP_END##';
// Literal em-dashes (not the HTML entity): this is a .txt file.
const BACKUP_DIV = '='.repeat(72), BACKUP_SUB = '─'.repeat(72);

const backupFilename = (ato, title) => `${safeFilename(ato)}_${safeFilename(title)}`;
const backupTime  = iso => { const d = timeOf(iso); if (!d) return NO_TIME; const f = dateFields(d, false); return `${f.y}-${f.mo}-${f.day} ${f.h}${f.mi}Z`; };
const backupStamp = (now) => { const f = dateFields(now, false); return `${f.y}-${f.mo}-${f.day} · ${f.h}${f.mi}Z`; };

// Readable entries for the given live reports, in report-number order.
const backupReportBlocks = (reps) => [...reps].sort((a,b) => reportNum(a) - reportNum(b)).map(r => {
    let out = `${BACKUP_SUB}\n REPORT ${r.displayId}${r.updated ? '  [UPDATED]' : ''}\n${BACKUP_SUB}\n`;
    out += ` Size     : ${r.size||'-'}\n Activity : ${r.activity||'-'}\n Location : ${r.location||'-'}\n Time     : ${backupTime(r.time)}\n`;
    if (r.yourAnalysis) out += ` Analysis : ${r.yourAnalysis}\n`;
    Object.entries(r.custom || {}).forEach(([ck, cv]) => { out += ` ${ck} : ${cv}\n`; });
    if (r.user?.initials) out += ` By       : ${r.user.initials}\n`;
    (r.bda || []).forEach((b, bi) => { out += `   BDA ${bi+1}  : ${b.effect || 'Unknown'} - ${b.target || ''}${b.coords ? ' @ ' + b.coords : ''}${b.note ? ' - ' + b.note : ''}\n`; });
    if (r.history?.length) {
        [...r.history].sort((a,b) => a.lastModified - b.lastModified).forEach((h, i) => {
            out += `\n   ↳ Previous Entry ${i+1}\n      Size     : ${h.size||'-'}\n      Activity : ${h.activity||'-'}\n      Location : ${h.location||'-'}\n      Time     : ${backupTime(h.time)}\n`;
            if (h.yourAnalysis) out += `      Analysis : ${h.yourAnalysis}\n`;
        });
    }
    return out + '\n';
}).join('');

// The block the server and the importer read back.
const backupMachineData = (payload) =>
    `\n${BACKUP_DIV}\n MACHINE DATA: DO NOT EDIT BELOW THIS LINE\n${BACKUP_DIV}\n${BACKUP_START}\n${JSON.stringify(payload)}\n${BACKUP_END}\n`;

// The overlay types, as the server's _OVERLAY_TYPES, and how deep each
// geometry's coordinates nest above the [lon, lat] pairs (its _GEOMETRY_DEPTH).
const OVERLAY_TYPES = new Set(['NAI', 'OBJ', 'PL']);
const GEOMETRY_DEPTH = { Point: 0, LineString: 1, Polygon: 2, MultiLineString: 2, MultiPolygon: 3 };
// Whether an overlay is one the server would take: a known type, a name, and
// coordinates that are all longitude / latitude, no list of them empty.
// Remembered per object, since every report is read against every overlay.
const overlayChecked = new WeakMap();
const overlayOk = (o) => {
    if (!o || typeof o !== 'object') return false;
    if (overlayChecked.has(o)) return overlayChecked.get(o);
    const coordsOk = (c, depth) => (depth === 0
        ? Array.isArray(c) && (c.length === 2 || c.length === 3) && c.every(v => typeof v === 'number' && Number.isFinite(v))
            && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90
        : Array.isArray(c) && c.length > 0 && c.every(p => coordsOk(p, depth - 1)));
    const g = o.geometry;
    const depth = g && typeof g === 'object' ? GEOMETRY_DEPTH[g.type] : undefined;
    const ok = typeof o.type === 'string' && OVERLAY_TYPES.has(o.type) && typeof o.name === 'string' && o.name !== ''
        && (!('label' in o) || typeof o.label === 'string') && depth !== undefined && coordsOk(g.coordinates, depth);
    overlayChecked.set(o, ok);
    return ok;
};
// An overlay's place key ("NAI 1", "OBJ GOLD"), read as a typed one is
// (refName), so overlay "gold" is OBJ GOLD and overlay "01" is NAI 1.
const overlayKey = (o) => `${o.type} ${refName(o.name)}`;

// The shared overlay list from what a backup or the server holds. A list is
// the shared set as it is; a dict is the older per-workspace form (ato ->
// list), folded into one, a later overlay replacing an earlier one of the
// same type and name. Overlays the server wouldn't take are left out.
const foldOverlays = (value) => {
    if (Array.isArray(value)) return value.filter(overlayOk);
    if (!value || typeof value !== 'object') return [];
    const byKey = new Map();
    Object.values(value).forEach(list => (Array.isArray(list) ? list : []).forEach(o => {
        if (overlayOk(o)) byKey.set(overlayKey(o), o);
    }));
    return [...byKey.values()];
};

// The narrative's settings for a backup's machine data: only when there are any.
const narrativeData = (n) => (n && typeof n === 'object' && !Array.isArray(n) && Object.keys(n).length ? { narrative: n } : {});

// One workspace's backup file. `reps` is exported as-is in the machine data
// (deleted flags included); only live reports are listed for reading. The
// shared overlays (and the narrative's settings) go in every file.
const backupText = (ato, reps, title, profiles, formats, now = new Date(), overlays = [], narrative = null) => {
    const active = reps.filter(r => !r.deleted);
    return `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH: ATO BACKUP\n ATO Designator : ${ato}\n Report Title   : ${title}\n Total Reports  : ${active.length}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`
        + backupReportBlocks(active)
        + backupMachineData({ workspaces: { [ato]: reps }, config: { ato, title }, profiles: profiles||{},
            formats: formats[ato] ? { [ato]: formats[ato] } : {}, overlays: foldOverlays(overlays), ...narrativeData(narrative) });
};

// Every given workspace in one file.
const allWorkspacesBackupText = (workspaces, activeAto, title, profiles, formats, now = new Date(), overlays = [], narrative = null) => {
    const atoKeys   = Object.keys(workspaces);
    const totalReps = atoKeys.reduce((n, k) => n + (workspaces[k]||[]).filter(r => !r.deleted).length, 0);
    let out = `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH: FULL BACKUP (ALL ATOs)\n ATOs Included  : ${atoKeys.join(', ')}\n Total Reports  : ${totalReps}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`;
    atoKeys.forEach(ato => {
        const active   = (workspaces[ato]||[]).filter(r => !r.deleted);
        const atoTitle = (active.find(r => r.title)||{}).title || ato;
        out += `${BACKUP_DIV}\n ATO: ${ato}  -  ${atoTitle}  (${active.length} report${active.length !== 1 ? 's' : ''})\n${BACKUP_DIV}\n\n`;
        out += backupReportBlocks(active);
    });
    return out + backupMachineData({ workspaces, config: { ato: activeAto, title }, profiles: profiles||{}, formats, overlays: foldOverlays(overlays), ...narrativeData(narrative) });
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

const csvField  = v => `"${(v == null ? '' : String(v)).replace(/"/g,'""')}"`;
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

// Latitude/longitude to UTM on WGS84, Krüger's series forward (Karney 2011).
const KRUGER_ALPHA = (() => {
    const n = WGS84_F / (2 - WGS84_F), n2 = n*n, n3 = n2*n, n4 = n3*n, n5 = n4*n, n6 = n5*n;
    return [
        n/2 - 2*n2/3 + 5*n3/16 + 41*n4/180 - 127*n5/288 + 7891*n6/37800,
        13*n2/48 - 3*n3/5 + 557*n4/1440 + 281*n5/630 - 1983433*n6/1935360,
        61*n3/240 - 103*n4/140 + 15061*n5/26880 + 167603*n6/181440,
        49561*n4/161280 - 179*n5/168 + 6601661*n6/7257600,
        34729*n5/80640 - 3418889*n6/1995840,
        212378941*n6/319334400,
    ];
})();
const latLonToUtm = (lat, lon, zone) => {
    const e = Math.sqrt(WGS84_F * (2 - WGS84_F)), rad = Math.PI / 180;
    const phi = lat * rad, dl = (lon - ((zone - 1) * 6 - 177)) * rad;
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
    const xi1 = Math.atan2(t, Math.cos(dl)), eta1 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t*t));
    let xi = xi1, eta = eta1;
    KRUGER_ALPHA.forEach((a, i) => {
        const j = 2 * (i + 1);
        xi  += a * Math.sin(j*xi1) * Math.cosh(j*eta1);
        eta += a * Math.cos(j*xi1) * Math.sinh(j*eta1);
    });
    return { easting: 500000 + UTM_K0 * KRUGER.A * eta, northing: UTM_K0 * KRUGER.A * xi + (lat < 0 ? 10000000 : 0) };
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

// A point as an MGRS grid, "11S NV 39697 06762" (`digits` per half, 1-5),
// or null outside MGRS (beyond 80°S and 84°N, where UPS applies). The zone
// follows the standard's exceptions: 32V is widened over Norway, and around
// Svalbard only zones 31, 33, 35 and 37 are used.
const latLonToMgrs = (lat, lon, digits = 5) => {
    if (!(lat >= -80 && lat <= 84) || !Number.isFinite(lon)) return null;
    digits = Number.isFinite(Number(digits)) ? Math.max(1, Math.min(5, Math.round(Number(digits)))) : 5;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    let zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
    if (lat >= 72) {
        if (lon >= 0 && lon < 9) zone = 31;
        else if (lon >= 9 && lon < 21) zone = 33;
        else if (lon >= 21 && lon < 33) zone = 35;
        else if (lon >= 33 && lon < 42) zone = 37;
    }
    const band = MGRS_BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
    const { easting, northing } = latLonToUtm(lat, lon, zone);
    const set = zone % 6 || 6;
    const col = MGRS_COLS[(set - 1) % 3][Math.floor(easting / 100000) - 1];
    const row = MGRS_ROWS[(Math.floor(northing / 100000) + (set % 2 ? 0 : 5)) % 20];
    if (!col || !row) return null;
    const half = (v) => String(Math.floor(v % 100000)).padStart(5, '0').slice(0, digits);
    return `${zone}${band} ${col}${row} ${half(easting)} ${half(northing)}`;
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
// is not a phase line; "PL3" is. The long forms are words of their own too
// ("our objective", "the phase line"), so after them a name is a number or
// starts with a capital ("Objective Silver"); and the common words below are
// never a name, whatever comes before them ("vic objective area", "obj is
// clear"). A single letter stays a name: OBJ A is a real objective.
const REF_TYPES = { NAI: 'NAI', OBJ: 'OBJ', OBJECTIVE: 'OBJ', PL: 'PL', 'PHASE LINE': 'PL' };
const REF_RE = /(^|[^A-Za-z0-9])(NAI|OBJECTIVE|OBJ|PHASE\s+LINE|PL)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/gi;
const REF_STOP = new Set(['AREA', 'AREAS', 'OF', 'IS', 'WAS', 'ARE', 'THE', 'AN', 'AND', 'OR', 'TO', 'IN', 'ON', 'AT', 'BY', 'FOR',
    'FROM', 'WITH', 'NEAR', 'INTO', 'ALONG', 'VIC', 'NOT', 'NO', 'CLEAR', 'CLEARED', 'SECURE', 'SECURED', 'TAKEN', 'SEIZED', 'REACHED']);
const refName = (name) => { const n = String(name).toUpperCase(); return /^\d+$/.test(n) ? String(Number(n)) : n; };
// The place a prefix as typed and the word after it name, or null when the
// word isn't a name.
const refOf = (prefix, word) => {
    const type = REF_TYPES[prefix.toUpperCase().replace(/\s+/g, ' ')];
    if (!type || !word || REF_STOP.has(word.toUpperCase())) return null;
    if (prefix.length > 3 && !/^[0-9A-Z]/.test(word)) return null;   // OBJECTIVE, PHASE LINE
    const name = refName(word);
    return { type, name, key: `${type} ${name}` };
};
// Every place named in some text, in order, with where its prefix starts and
// its name ends.
const refMatches = (text) => {
    const s = String(text || ''), out = [];
    const re = new RegExp(REF_RE.source, 'gid');
    let m;
    while ((m = re.exec(s))) {
        const ref = refOf(m[2], m[3]);
        if (!ref) continue;
        // "38S PL 12345": the 100 km square of a grid that didn't read as one
        // (a typo), not a phase line.
        if (ref.type === 'PL' && /\d{1,2}\s*[C-HJ-NP-X]\s*$/i.test(s.slice(0, m.index + m[1].length))) continue;
        out.push({ ...ref, start: m.indices[2][0], end: m.indices[3][1] });
    }
    return out;
};
const findRefs = (text) => {
    const out = [], seen = new Set();
    refMatches(text).forEach(({ type, name, key }) => { if (!seen.has(key)) { seen.add(key); out.push({ type, name, key }); } });
    return out;
};

// An overlay's name ("NAI 3", "OBJ Gold (bridge)", "Gold") as a place
// reference. The name is its first word after the prefix, as when typed (and
// by the same rules). Without a prefix, `fallbackType` decides, with the
// first word that isn't a common one; null when neither does.
const overlayRef = (rawName, fallbackType) => {
    const s = String(rawName || '').trim();
    const m = /^(NAI|OBJECTIVE|OBJ|PHASE\s+LINE|PL)(?:\s*[-#:.]\s*|\s+|(?=\d))([A-Za-z0-9]+)/i.exec(s);
    const own = m && refOf(m[1], m[2]);
    if (own) return own;
    const word = (s.match(/[A-Za-z0-9]+/g) || []).find(w => !REF_STOP.has(w.toUpperCase()));
    if (!fallbackType || !word) return null;
    const name = refName(word);
    return { type: fallbackType, name, key: `${fallbackType} ${name}` };
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
// fewer than three points (or none) stays a line.
const asArea = (g) => {
    const ring = (line) => {
        if (!Array.isArray(line) || line.length < 3 || !line.every(Array.isArray)) return null;
        const r = line.slice(), a = r[0], b = r[r.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
        return r.length >= 4 ? [r] : null;
    };
    if (!g) return g;
    if (g.type === 'LineString') { const p = ring(g.coordinates); return p ? { type: 'Polygon', coordinates: p } : g; }
    if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
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
    // An overlay the server wouldn't take is left out, so one bad shape
    // can't stop every report being read.
    const ovs = (overlays || []).filter(overlayOk);
    const keyOf = overlayKey;
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
    const ovs = (overlays || []).filter(overlayOk);
    const keyOf = overlayKey;
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
        const spans = refMatches(blank(s)).filter(r => r.key in replace).map(r => [r.start, r.end, replace[r.key]]);
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
// the user when it can't be read: a fragment ("it is not a shapefile") that
// the caller puts after the file's name.
const SHP_DAMAGED = 'it is damaged (a shape runs past its end). Export it again';
const parseShapefile = (shp, dbf, prj, cpg) => {
    try {
        return readShapefile(shp, dbf, prj, cpg);
    } catch (e) {
        // A count or offset that points outside the file, read anyway.
        if (e instanceof RangeError) throw new Error(SHP_DAMAGED);
        throw e;
    }
};
const readShapefile = (shp, dbf, prj, cpg) => {
    const dv = new DataView(shp);
    if (shp.byteLength < 100 || dv.getInt32(0) !== 9994) throw new Error('it is not a shapefile (.shp)');
    const proj = shapefileProjection(prj);
    const rows = dbf ? readDbf(dbf, cpg) : [];
    const features = [];
    for (let p = 100, i = 0; p + 12 <= shp.byteLength; i++) {
        // The content length is in 16-bit words, at least the shape type's two.
        const words = dv.getInt32(p + 4), start = p + 8, end = start + words * 2;
        if (words < 2 || end <= p) break;
        p = end;
        if (end > shp.byteLength) break;
        // Each count is checked against the record before anything is read.
        const fits = (bytes, ...counts) => { if (counts.some(n => n < 0) || start + bytes > end) throw new Error(SHP_DAMAGED); };
        const type = dv.getInt32(start, true);
        const kind = type === 31 ? 0 : type % 10;  // 1 point, 3 line, 5 area, 8 multipoint (Z, M alike); 31 multipatch
        const xy = (at) => [dv.getFloat64(at, true), dv.getFloat64(at + 8, true)];
        let geometry = null;
        if (kind === 1) { fits(20); geometry = { type: 'Point', coordinates: xy(start + 4) }; }
        else if (kind === 8) {
            fits(40);
            const n = dv.getInt32(start + 36, true);
            fits(40 + 16 * n, n);
            geometry = { type: 'MultiPoint', coordinates: Array.from({ length: n }, (_, k) => xy(start + 40 + 16 * k)) };
        } else if (kind === 3 || kind === 5) {
            fits(44);
            const nParts = dv.getInt32(start + 36, true), nPts = dv.getInt32(start + 40, true);
            fits(44 + 4 * nParts + 16 * nPts, nParts, nPts);
            const parts = Array.from({ length: nParts }, (_, k) => dv.getInt32(start + 44 + 4 * k, true));
            if (parts.some((s, k) => s < 0 || s > nPts || (k && s < parts[k - 1]))) throw new Error(SHP_DAMAGED);
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

// Where reports were, for the map: each report at the grids of its latest
// Location; or (`all`) every saved version of it, its updates included,
// oldest first, at each version's grids. A weight per point splits each
// version evenly between the grids it names, so each version counts once.
const reportPositions = (reps, all = false) => (reps || []).filter(r => !r.deleted).flatMap(r => {
    const versions = all
        ? [...(r.history || [])].sort((a, b) => (new Date(a.time) - new Date(b.time)) || (a.lastModified - b.lastModified)).concat(r)
        : [r];
    return versions.flatMap(v => {
        const grids = findGrids(v.location);
        return grids.map(g => ({ report: r, lon: g.lon, lat: g.lat, mgrs: g.mgrs, time: v.time, latest: v === r, w: 1 / grids.length }));
    });
});
// The heat map's points: by default each unique report once, at its latest
// Location, however many times it was updated; with `all`, every version.
const heatPoints = (reps, all = false) => reportPositions(reps, all).map(p => ({ lon: p.lon, lat: p.lat, w: p.w }));

// Whether an Activity line has any of these tags (the empty set takes every
// line). 'Untagged' takes a line with none.
const activityMatches = (text, tags) => {
    if (!tags || !tags.size) return true;
    const got = classifyActivity(text).tags;
    return got.length ? got.some(t => tags.has(t)) : tags.has('Untagged');
};

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

// Web Mercator metres back to longitude and latitude.
const mercToLonLat = (x, y) => [x / MERC_R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180 / Math.PI];

// The projections a WMS can draw our map in, best first: Web Mercator under
// its several names (same metres), then longitude / latitude, which the map
// stretches to fit (true to well under a pixel over an area the size of a
// training area).
const WMS_MERC_CRS = ['EPSG:3857', 'EPSG:900913', 'EPSG:102100', 'EPSG:102113', 'EPSG:3785'];
const WMS_CRS_ORDER = [...WMS_MERC_CRS, 'EPSG:4326', 'CRS:84'];
// The projection every chosen layer offers (each a list of codes), or null.
const pickWmsCrs = (lists) => {
    const sets = (lists || []).map(l => new Set((l || []).map(c => String(c).trim().toUpperCase())));
    return WMS_CRS_ORDER.find(c => sets.length && sets.every(s => s.has(c))) || null;
};
// The image format to ask for: PNG if offered, then JPEG, then the first.
const pickWmsFormat = (formats) => {
    const f = (formats || []).map(String);
    return f.find(x => /^image\/png$/i.test(x)) || f.find(x => /^image\/png/i.test(x)) || f.find(x => /jpe?g/i.test(x)) || f[0] || 'image/png';
};

// A service address's parameters, split off: [path, [[key, value], ...]].
// Only the first "?" starts them; a later one is part of a value.
const splitQuery = (url) => {
    const s = String(url).trim(), q = s.indexOf('?');
    const [path, query] = q < 0 ? [s, ''] : [s.slice(0, q), s.slice(q + 1)];
    return [path, query.split('&').filter(Boolean).map(kv => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; })];
};
const WMS_KEYS = new Set(['SERVICE', 'VERSION', 'REQUEST', 'LAYERS', 'STYLES', 'CRS', 'SRS', 'BBOX', 'WIDTH', 'HEIGHT', 'FORMAT', 'TRANSPARENT']);

// The GetCapabilities address for a link to a WMS, whatever request the link
// was for: its own parameters (a map=, a token) are kept.
const wmsCapabilitiesUrl = (link) => {
    const [path, params] = splitQuery(link);
    const keep = params.filter(([k]) => !WMS_KEYS.has(k.toUpperCase())).map(([k, v]) => `${k}=${v}`);
    return `${path}?${[...keep, 'SERVICE=WMS', 'REQUEST=GetCapabilities'].join('&')}`;
};

// A WMS GetMap address for a Web Mercator box: the service's address (its
// own parameters kept, ours replacing any of the same name). The version,
// projection and format are the service's (from its capabilities); without
// them, 1.3.0, EPSG:3857 and PNG. In longitude / latitude, 1.3.0's EPSG:4326
// lists latitude first.
const wmsUrl = (base, layers, [x0, y0, x1, y1], width, height, { version = '1.3.0', crs = 'EPSG:3857', format = 'image/png' } = {}) => {
    const [path, params] = splitQuery(base);
    const code = String(crs).toUpperCase();
    let bbox;
    if (WMS_MERC_CRS.includes(code)) bbox = [x0, y0, x1, y1].map(v => v.toFixed(2));
    else {
        const [lon0, lat0] = mercToLonLat(x0, y0), [lon1, lat1] = mercToLonLat(x1, y1);
        bbox = (version === '1.3.0' && code === 'EPSG:4326' ? [lat0, lon0, lat1, lon1] : [lon0, lat0, lon1, lat1]).map(v => v.toFixed(7));
    }
    const ours = {
        SERVICE: 'WMS', VERSION: version, REQUEST: 'GetMap', LAYERS: layers || '', STYLES: '',
        [version === '1.3.0' ? 'CRS' : 'SRS']: crs, BBOX: bbox.join(','),
        WIDTH: Math.round(width), HEIGHT: Math.round(height), FORMAT: format, TRANSPARENT: 'FALSE',
    };
    const keep = params.filter(([k]) => !WMS_KEYS.has(k.toUpperCase())).map(([k, v]) => `${k}=${v}`);
    if (!layers) {
        const had = params.find(([k]) => k.toUpperCase() === 'LAYERS');
        if (had) ours.LAYERS = decodeURIComponent(had[1]);
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
// Firing words that aren't contact: fire support, a firing position, a
// cease-fire, a launch site. They don't make a line Firing.
const NOT_CONTACT = /\b(fire support|fir(e|ing) positions?|cease[- ]?fire|fire teams?|launch (sites?|points?|positions?))\b/gi;
// Where a line says it is headed. A bearing counts only with a heading word
// or a unit ("heading 270", "brg 045", "moving 090°"), so "moving 120 trucks"
// has none; 000 to 360, 360 being north. A direction after a movement word
// is a whole compass point or word ("moving NE", "to the southeast"), so
// "moving to new position" has none.
const HEADING_BEARING = /\b(?:head(?:s|ed|ing)?|hdg|bearing|brg|az(?:imuth)?)(?:\s+of)?\s*:?\s*(\d{3})(?![\d.])(?:\s*(?:°|deg(?:rees)?\b))?/i;
const MOVE_WORDS_BEFORE = '(?:mov(?:e|es|ed|ing)|mvg|head(?:s|ed|ing)?|travel{1,2}(?:s|ed|ing)?|driv(?:e|es|ing)|advanc(?:e|es|ed|ing)|withdraw(?:s|n|ing)?|retreat(?:s|ed|ing)?|toward(?:s)?|to the|en ?route|transit(?:s|ing)?|proceed(?:s|ing)?|fly(?:ing)?|bearing|brg|az)\\s+(?:[a-z]+\\s+){0,2}?';
const MOVE_BEARING = new RegExp(`\\b${MOVE_WORDS_BEFORE}(\\d{3})\\s*(?:°|deg(?:rees)?\\b)`, 'i');
const MOVE_DIR = new RegExp(`\\b${MOVE_WORDS_BEFORE}(north[- ]?(?:east|west)?|south[- ]?(?:east|west)?|east|west|${COMPASS.join('|')})\\b`, 'i');
const BOUND = /\b(?:([NSEW])B|(north|south|east|west)bound)\b/i;
// The heading a match gives: { at, heading, headingDeg }, or null.
const headingFrom = (m, re) => {
    if (!m) return null;
    if (re === BOUND) {
        const heading = m[1] ? m[1].toUpperCase() : DIR_WORDS[m[2].toUpperCase()];
        return { at: m.index, heading, headingDeg: COMPASS.indexOf(heading) * 22.5 };
    }
    const d = m[1].toUpperCase().replace(/[- ]/g, '');
    if (/^\d{3}$/.test(d)) {
        if (+d > 360) return null;
        const deg = +d % 360;
        return { at: m.index, heading: COMPASS[Math.round(deg / 22.5) % 16], headingDeg: deg };
    }
    const heading = DIR_WORDS[d] || (COMPASS.includes(d) ? d : null);
    return heading ? { at: m.index, heading, headingDeg: COMPASS.indexOf(heading) * 22.5 } : null;
};
const classifyActivity = (text) => {
    const s = String(text || '');
    const notContact = s.replace(NOT_CONTACT, ' ');
    const tags = ACTIVITY_TAGS.filter(([t, re]) => re.test(t === 'Firing' ? notContact : s)).map(([t]) => t);
    // The first heading said after a movement or heading word; failing
    // that, a "-bound" ("NB", "westbound").
    const said = [HEADING_BEARING, MOVE_BEARING, MOVE_DIR].map(re => headingFrom(re.exec(s), re)).filter(Boolean)
        .sort((x, y) => x.at - y.at)[0] || headingFrom(BOUND.exec(s), BOUND);
    const heading = said ? said.heading : null, headingDeg = said ? said.headingDeg : null;
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

// The numeric fields of the ArcGIS exports (points and tracks), each with
// its one type: the same layer exported twice has the same fields, whatever
// the rows hold (a heading or a phase-line distance no row has is still a
// number). Every other field is text.
const ARCGIS_NUMBERS = {
    heading_deg: 'double', precision_m: 'integer', pl_dist_m: 'integer', lat: 'double', lon: 'double',
    positions: 'integer', length_m: 'integer', bearing_deg: 'integer',
};
// A field's kind: 'integer', 'double' or 'text', from ARCGIS_NUMBERS; a
// field it doesn't name is a number when every value given is one.
const fieldKind = (name, rows) => {
    if (Object.prototype.hasOwnProperty.call(ARCGIS_NUMBERS, name)) return ARCGIS_NUMBERS[name];
    const vals = rows.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
    if (!vals.length || !vals.every(v => typeof v === 'number' && isFinite(v))) return 'text';
    return vals.every(Number.isInteger) ? 'integer' : 'double';
};

// Esri JSON: the format JSON To Features was made for. Every field's type
// and length is written out, so ArcGIS Pro has nothing to guess. `rows` are
// the attributes; `geometryOf(row, i)` gives each feature's shape.
const esriJson = (rows, geometryType, geometryOf) => {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const fields = cols.map(name => {
        const kind = fieldKind(name, rows);
        if (kind !== 'text') return { name, type: kind === 'integer' ? 'esriFieldTypeInteger' : 'esriFieldTypeDouble', alias: name };
        const vals = rows.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
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

// --- Shapefile export ---

// A zip of files stored as they are (no compression): what a shapefile's
// parts travel in. `files`: [{ name, data: Uint8Array }].
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
const crc32 = (bytes) => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const zipStore = (files, now = new Date()) => {
    const enc = new TextEncoder();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [], centrals = [];
    let offset = 0;
    files.forEach(({ name, data }) => {
        const nm = enc.encode(name), crc = crc32(data);
        const head = (sig, central) => {
            const b = new Uint8Array((central ? 46 : 30) + nm.length), v = new DataView(b.buffer);
            let o = 0;
            const u32 = x => { v.setUint32(o, x, true); o += 4; }, u16 = x => { v.setUint16(o, x, true); o += 2; };
            u32(sig);
            if (central) u16(20);           // made by
            u16(20); u16(0x0800); u16(0);   // version needed; UTF-8 names; stored
            u16(time); u16(date); u32(crc); u32(data.length); u32(data.length); u16(nm.length); u16(0);
            if (central) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
            b.set(nm, o);
            return b;
        };
        const local = head(0x04034b50, false);
        centrals.push(head(0x02014b50, true));
        locals.push(local, data);
        offset += local.length + data.length;
    });
    const cdSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let o = 0;
    [...locals, ...centrals, end].forEach(b => { out.set(b, o); o += b.length; });
    return out;
};

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
// Field names a shapefile can hold (10 characters at most), for the ArcGIS
// rows' longer names; the rest are cut to 10 and kept apart with a number.
const SHP_FIELD_NAMES = { heading_deg: 'head_deg', precision_m: 'prec_m', bearing_deg: 'bearing' };
const shpFieldNames = (cols) => {
    const used = new Set();
    return cols.map(c => {
        const base = (SHP_FIELD_NAMES[c] || c).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 10) || 'field';
        let name = base;
        for (let i = 2; used.has(name.toLowerCase()); i++) name = base.slice(0, 10 - String(i).length - 1) + '_' + i;
        used.add(name.toLowerCase());
        return name;
    });
};

// The text of a value cut to `max` bytes of UTF-8 without splitting a character.
const utf8Cut = (enc, s, max) => {
    let b = enc.encode(s);
    if (b.length <= max) return b;
    let cut = max;
    while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
    return b.subarray(0, cut);
};

// A shapefile in WGS 1984: points or lines (PolyLine), with a .dbf of the
// rows' attributes (UTF-8, said so in the .cpg). Numbers are numeric fields;
// text is cut to the format's 254 characters. `shapes` are [lon, lat] for
// points, or lists of them for lines, one per row.
const shapefileParts = (rows, shapes, kind) => {
    const enc = new TextEncoder();
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const names = shpFieldNames(cols);
    const fields = cols.map((c, i) => {
        const kind = fieldKind(c, rows);
        if (kind !== 'text') {
            const dec = kind === 'integer' ? 0 : 7;
            return { col: c, name: names[i], type: 'N', len: dec ? 19 : 18, dec };
        }
        const vals = rows.map(r => r[c]).filter(v => v !== null && v !== undefined && v !== '');
        const len = Math.min(254, Math.max(1, ...vals.map(v => enc.encode(String(v)).length)));
        return { col: c, name: names[i], type: 'C', len, dec: 0 };
    });
    // .dbf
    const recLen = 1 + fields.reduce((s, f) => s + f.len, 0), headLen = 32 + 32 * fields.length + 1;
    const dbf = new Uint8Array(headLen + recLen * rows.length + 1), dv = new DataView(dbf.buffer);
    const now = new Date();
    dbf[0] = 0x03; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
    dv.setUint32(4, rows.length, true); dv.setUint16(8, headLen, true); dv.setUint16(10, recLen, true);
    fields.forEach((f, i) => {
        const o = 32 + 32 * i;
        dbf.set(enc.encode(f.name), o);
        dbf[o + 11] = f.type.charCodeAt(0); dbf[o + 16] = f.len; dbf[o + 17] = f.dec;
    });
    dbf[headLen - 1] = 0x0d;
    rows.forEach((r, k) => {
        let o = headLen + k * recLen;
        dbf.fill(0x20, o, o + recLen);
        o++;
        fields.forEach(f => {
            const v = r[f.col];
            if (f.type === 'N') {
                // A number too wide for the field gives up decimals, never
                // its whole part; one that still doesn't fit is left empty.
                if (typeof v === 'number' && Math.abs(v) < 1e21) {   // larger ones print as "1e+21"
                    let s = v.toFixed(f.dec);
                    if (s.length > f.len) s = v.toFixed(Math.max(0, f.dec - (s.length - f.len)));
                    if (s.length <= f.len) dbf.set(enc.encode(s), o + f.len - s.length);
                }
            } else if (v !== null && v !== undefined) {
                dbf.set(utf8Cut(enc, String(v), f.len), o);
            }
            o += f.len;
        });
    });
    dbf[dbf.length - 1] = 0x1a;
    // .shp and .shx
    const paths = shapes.map(s => (kind === 'point' ? [s] : s));
    const sizes = paths.map(p => (kind === 'point' ? 20 : 44 + 4 + 16 * p.length));
    const shpLen = 100 + sizes.reduce((s, n) => s + 8 + n, 0), shxLen = 100 + 8 * rows.length;
    const shp = new Uint8Array(shpLen), shx = new Uint8Array(shxLen);
    const sv = new DataView(shp.buffer), xv = new DataView(shx.buffer);
    const all = paths.flat();
    const box = all.length ? [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))] : [0, 0, 0, 0];
    [[sv, shpLen], [xv, shxLen]].forEach(([v, len]) => {
        v.setInt32(0, 9994); v.setInt32(24, len / 2); v.setInt32(28, 1000, true); v.setInt32(32, kind === 'point' ? 1 : 3, true);
        box.forEach((n, i) => v.setFloat64(36 + 8 * i, n, true));
    });
    let o = 100;
    paths.forEach((p, i) => {
        xv.setInt32(100 + 8 * i, o / 2); xv.setInt32(104 + 8 * i, sizes[i] / 2);
        sv.setInt32(o, i + 1); sv.setInt32(o + 4, sizes[i] / 2);
        const c = o + 8;
        if (kind === 'point') {
            sv.setInt32(c, 1, true); sv.setFloat64(c + 4, p[0][0], true); sv.setFloat64(c + 12, p[0][1], true);
        } else {
            const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
            sv.setInt32(c, 3, true);
            [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((n, j) => sv.setFloat64(c + 4 + 8 * j, n, true));
            sv.setInt32(c + 36, 1, true); sv.setInt32(c + 40, p.length, true); sv.setInt32(c + 44, 0, true);
            p.forEach((q, j) => { sv.setFloat64(c + 48 + 16 * j, q[0], true); sv.setFloat64(c + 56 + 16 * j, q[1], true); });
        }
        o += 8 + sizes[i];
    });
    return { shp, shx, dbf, prj: enc.encode(WGS84_PRJ), cpg: enc.encode('UTF-8') };
};

// The ArcGIS points (one per grid) or tracks (one line per report that moved)
// as a zipped shapefile named `name`: ArcGIS Pro adds the .shp once it is
// unzipped, and ArcGIS Online takes the zip as it is.
const shapefileZip = (name, parts, now) => zipStore(['shp', 'shx', 'dbf', 'prj', 'cpg'].map(ext => ({ name: `${name}.${ext}`, data: parts[ext] })), now);
const arcgisShapefileZip = (rows, name, now) => shapefileZip(name, shapefileParts(rows, rows.map(r => [r.lon, r.lat]), 'point'), now);
const arcgisTracksShapefileZip = (rows, name, now) => shapefileZip(name, shapefileParts(rows.map(attrsOf), rows.map(r => r.path), 'line'), now);

// --- Statistics ---

// Words that say how many, not what: "total of", "approx", "about".
const SIZE_FILLER = /\b(?:total(?:\s+of)?|approx(?:imately)?|about|around|est(?:imated)?|at\s+least|up\s+to)\b\.?|~/gi;
// One element's count and its type as written: "2x T-72", "4 BMP-2", "vics
// 10x", "vics x10", "trucks (3)", "truck". `counted` says a number was given.
// A number run into a name ("2S19") is part of the name.
const sizeCount = (part) => {
    const text = part.replace(SIZE_FILLER, ' ').replace(/\s+/g, ' ').trim();
    let count = 1, type = text, counted = false, m;
    if ((m = /^(\d+)\s*(?:x\s*|\s+)(\S.*)$/i.exec(text))) { count = Number(m[1]); type = m[2]; counted = true; }
    else if ((m = /^(.+?)\s+(?:(\d+)\s*x|x\s*(\d+))$/i.exec(text) || /^(.+?)\s*\((\d+)\)$/.exec(text))) {
        count = Number(m[2] || m[3]); type = m[1]; counted = true;
    }
    return { count, text: type.replace(/^of\s+/i, '').trim(), counted };
};
// One element as the Statistics count it: its type upper-cased and singular.
const sizePart = (part, team = null) => {
    const { count, text, counted } = sizeCount(part);
    return { count, type: singularType(text, team).toUpperCase(), counted };
};
// A plural made singular, so "TANKS" and "tank" are one type. The last word
// loses its "s" (or "es", or "ies" for "y": buses, lorries) when the
// catalogue (or the team's equipment, `team`) knows the singular and not the
// word as written (MANPADS stays), or knows more of the whole singular than
// of the whole as written (RADIO RELAYS, BRIDGE LAYERS; not TANK GLASS), in
// any case. Otherwise only a lower-case "s" goes: from a designation ("T-72s",
// where "T-72S" is a variant), or from a word of four letters or more that
// doesn't end in "ss", "us", "is" or "as" ("widgets"; not "gas" or "radius").
const singularType = (type, team = null) => {
    const known = (t) => knownType(t, team);
    const m = /^(.*?)\b([A-Za-z]{2,})$/.exec(type);
    if (m && known(m[2])) return type;
    if (m && /s$/i.test(m[2])) {
        const whole = known(type);
        for (const one of [m[2].slice(0, -1), m[2].replace(/es$/i, ''), m[2].replace(/ies$/i, 'y')]) {
            if (one.length > 1 && one !== m[2] && (known(one) || known(m[1] + one) > whole)) return m[1] + one;
        }
    }
    const last = type.split(' ').pop();
    const drop = /\d/.test(last) ? /[^su]s$/.test(last) : last.length >= 4 && /s$/.test(last) && !/(ss|us|is|as)$/i.test(last);
    return drop ? type.slice(0, -1) : type;
};
const sizeListOf = (text, team = null) => text.split(/\s*(?:[,;+&]|\band\b|\bwith\b|\bw\/)\s*/i).filter(Boolean).map(p => sizePart(p, team))
    .filter(e => e.type && e.count > 0);
// The elements of a Size line with their counts: "2x T-72, 4 BMP-2; truck"
// -> T-72 x2, BMP-2 x4, TRUCK x1. Types are upper-cased, and a plural is made
// singular ("T-72s", "trucks", "TANKS", "lorries") so the same vehicle is
// counted as one type.
// "and", "&" and "with" part elements too. A total with its breakdown after
// a colon or in brackets ("Total of vics 10x: 5x tanks and 5x APC") counts
// the breakdown and only what it leaves of the total ("12 vics (5 tanks)":
// 5 tanks and 7 vics), so nothing is counted twice; brackets that aren't a
// breakdown ("3x T-72 (one damaged)") are a note, and left out.
// `team` (optional) is the team's equipment (teamEquipment), so its own
// types fold their plurals too ("3X WIDGETS" and "2x widget").
const sizeElements = (size, team = null) => {
    const text = String(size || '').trim();
    const plain = ({ count, type }) => ({ count, type });
    const sizeList = (t) => sizeListOf(t, team);
    // The breakdown, and what it leaves of the total; null when it isn't one.
    const breakdown = (headText, tailText) => {
        const head = sizeList(headText), parts = sizeList(tailText);
        if (head.length !== 1 || !head[0].counted || !parts.length || !parts.every(e => e.counted)) return null;
        const left = head[0].count - parts.reduce((n, e) => n + e.count, 0);
        return [...parts, ...(left > 0 ? [{ ...head[0], count: left }] : [])].map(plain);
    };
    const m = /^([^:(]+?)\s*(?::\s*(.+)|\((.+)\)\s*)$/.exec(text);
    if (m) {
        const got = breakdown(m[1], m[2] || m[3]);
        if (got) return got;
        // "trucks (3)": a count in brackets after a type without one.
        if (m[3] !== undefined && /^\d+$/.test(m[3].trim()) && !/^\d/.test(m[1])) return sizeList(text).map(plain);
        if (m[3] !== undefined) return sizeList(m[1]).map(plain);
    }
    // "Total 10 vics, 5x tanks, 5x APC": a total named as one, then its parts.
    const t = /^(total\b[^,;+]*?)\s*[,;+]\s*(.+)$/i.exec(text);
    const got = t && breakdown(t[1], t[2]);
    return got || sizeList(text).map(plain);
};

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
//   team          the team's equipment (teamEquipment), optional, so the
//                 types it adds fold their plurals as the narrative does
const statsData = (reps, overlays, { local, squareDigits = 1, team = null } = {}) => {
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
        sizeElements(r.size, team).forEach(e => add(equipment, e.type, e.count));
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

// --- Excel workbook ---

// The report table as rows for a spreadsheet: one row per report as it is
// now, with what the app reads from it (places, activity tags, heading, BDA).
// A time is { date: Excel serial } so Excel sorts and filters it as a date;
// in Local mode it is the browser's local time.
const excelSerial = (ms, local) => {
    const off = local ? new Date(ms).getTimezoneOffset() * 60000 : 0;
    return (ms - off) / 86400000 + 25569;
};
const workbookReportRows = (reps, overlays, { local, idOf, customLabels = [] }) => {
    const header = ['Identifier', 'Status', 'By', 'Size', 'Activity', 'Location', `Time (${local ? 'Local' : 'Z'})`, 'Analysis',
        'NAI / OBJ / PL', 'Activity tags', 'Heading', 'BDA assessed', 'Updates', ...customLabels];
    const rows = (reps || []).filter(r => !r.deleted).sort((a, b) => reportNum(a) - reportNum(b)).map(r => {
        const a = analyzeLocation(r.location, overlays);
        const act = classifyActivity(r.activity);
        const ms = new Date(r.time).getTime();
        const b = bdaSummary(r);
        return [idOf(r), r.updated ? 'Updated' : 'Original', (r.user && r.user.initials) || '', r.size || '', r.activity || '',
            r.location || '', isNaN(ms) ? '' : { date: excelSerial(ms, local) }, r.yourAnalysis || '',
            [...a.nai.keys, ...a.obj.keys, ...a.pls].join(', '), act.tags.join(', '), act.heading || '',
            b.done ? `${b.done} of ${b.total}` : '', (r.history || []).length,
            ...customLabels.map(c => (r.custom || {})[c] || '')];
    });
    return { header, rows };
};

// A workbook (.xlsx) of the Statistics panel: a Statistics sheet with the
// headline numbers and each chart's table beside an Excel chart drawn from
// it (so it can be restyled and updates when a number is changed), and a
// Reports sheet holding the report table as an Excel table with filters.
// Written by hand, as the zip of XML parts an .xlsx is, so nothing needs a
// library. Styled to match the app: system font, one blue, no borders.
//   opts: { title, context, kpis: [{ label, value }],
//           charts: [{ title, note, unit, kind: 'bar' | 'column', axis, items: [{ label, value }] }],
//           reports: { header, rows } }
const XLSX_BLUE = '007AFF', XLSX_INK = '1D1D1F', XLSX_INK2 = '6E6E73', XLSX_GRID = 'E5E5EA', XLSX_AXIS = 'D2D2D7';
const XLSX_FONT = 'Segoe UI';
const XLSX_BAR_MAX = 10;  // a bar chart shows the top ten; its table has them all
// Text as XML holds it: characters XML 1.0 can't (control characters, and a
// lone half of a surrogate pair) are left out; others, emoji included, stay.
const xmlText = (s) => String(s).replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const REL = (t) => `${NS_REL}/${t}`;
const relsXml = (rels) => `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') + '</Relationships>';

// Cell styles (the order of cellXfs below).
const XS = { plain: 0, head: 1, title: 2, muted: 3, date: 4, section: 5, kpi: 6 };
const XLSX_STYLES = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>'
    + '<fonts count="5">'
    + [[false, 10, XLSX_INK], [true, 10, XLSX_INK], [true, 18, XLSX_INK], [false, 10, XLSX_INK2], [true, 12, XLSX_INK]]
        .map(([b, sz, c]) => `<font>${b ? '<b/>' : ''}<sz val="${sz}"/><color rgb="FF${c}"/><name val="${XLSX_FONT}"/><family val="2"/></font>`).join('')
    + '</fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF${XLSX_AXIS}"/></bottom><diagonal/></border></borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="7">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>'
    + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>';

// Text properties for a chart part: size in hundredths of a point.
const chartTx = (sz, color, bold = false) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${bold ? 1 : 0}">`
    + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${XLSX_FONT}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const noLine = '<a:ln><a:noFill/></a:ln>';
const strCache = (vals) => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlText(v)}</c:v></c:pt>`).join('')}</c:strCache>`;

// One chart part. `at` = { sheet, catCol, valCol, headRow, first, last } in
// sheet cells (rows 1-based) for its formulas.
const chartXml = (chart, at) => {
    const ref = (col, r0, r1) => `'${at.sheet}'!$${col}$${r0}${r1 === undefined ? '' : `:$${col}$${r1}`}`;
    const items = chart.items.slice(0, chart.kind === 'bar' ? XLSX_BAR_MAX : undefined);
    const last = at.first + items.length - 1;
    const bar = chart.kind === 'bar';
    const peak = items.reduce((b, it, i) => (it.value > items[b].value ? i : b), 0);
    // Bars carry their values; columns read off the axis, with the peak labelled.
    const labelOpts = (show) => `<c:showLegendKey val="0"/><c:showVal val="${show ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>`;
    const dLbls = bar
        ? `<c:dLbls><c:spPr><a:noFill/>${noLine}</c:spPr>${chartTx(900, XLSX_INK, true)}<c:dLblPos val="outEnd"/>${labelOpts(true)}</c:dLbls>`
        : `<c:dLbls><c:dLbl><c:idx val="${peak}"/><c:spPr><a:noFill/>${noLine}</c:spPr>${chartTx(900, XLSX_INK, true)}<c:dLblPos val="outEnd"/>${labelOpts(true)}</c:dLbl>${labelOpts(false)}</c:dLbls>`;
    const axisLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${XLSX_AXIS}"/></a:solidFill></a:ln></c:spPr>`;
    const ticks = '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>';
    return `${XML_HEAD}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_REL}">`
        + '<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>'
        + `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1">`
        + `<a:solidFill><a:srgbClr val="${XLSX_INK}"/></a:solidFill><a:latin typeface="${XLSX_FONT}"/></a:rPr><a:t>${xmlText(chart.title)}</a:t></a:r></a:p></c:rich></c:tx>`
        + '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>'
        + `<c:barChart><c:barDir val="${bar ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
        + `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${ref(at.valCol, at.headRow)}</c:f>${strCache([chart.unit])}</c:strRef></c:tx>`
        + `<c:spPr><a:solidFill><a:srgbClr val="${XLSX_BLUE}"/></a:solidFill>${noLine}</c:spPr><c:invertIfNegative val="0"/>${dLbls}`
        + `<c:cat><c:strRef><c:f>${ref(at.catCol, at.first, last)}</c:f>${strCache(items.map(i => i.label))}</c:strRef></c:cat>`
        + `<c:val><c:numRef><c:f>${ref(at.valCol, at.first, last)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${items.length}"/>`
        + items.map((it, i) => `<c:pt idx="${i}"><c:v>${Number(it.value) || 0}</c:v></c:pt>`).join('') + '</c:numCache></c:numRef></c:val></c:ser>'
        + `<c:gapWidth val="${bar ? 60 : 50}"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart>`
        // Bars read top down, largest first, as in the app.
        + `<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="${bar ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${bar ? 'l' : 'b'}"/>`
        + `<c:numFmt formatCode="General" sourceLinked="1"/>${ticks}${axisLine}${chartTx(900, XLSX_INK2)}`
        + '<c:crossAx val="1002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
        + `<c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="${bar ? 1 : 0}"/><c:axPos val="${bar ? 'b' : 'l'}"/>`
        + (bar ? '' : `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${XLSX_GRID}"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>`)
        + `<c:numFmt formatCode="0" sourceLinked="0"/>${ticks}<c:spPr>${noLine}</c:spPr>${chartTx(900, XLSX_INK2)}`
        + '<c:crossAx val="1001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>'
        + `<c:spPr><a:noFill/>${noLine}</c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
        + `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>${noLine}</c:spPr>${chartTx(900, XLSX_INK2)}</c:chartSpace>`;
};

const statsXlsx = ({ title = 'Statistics', context = '', kpis = [], charts = [], reports = { header: [], rows: [] } }, now = new Date()) => {
    const strings = [], stringIdx = new Map();
    const sst = (s) => { s = String(s).slice(0, 32767); if (!stringIdx.has(s)) { stringIdx.set(s, strings.length); strings.push(s); } return stringIdx.get(s); };
    // A cell: number, string, { date }, or empty; `s` is its style.
    const cell = (ref, v, s = XS.plain) => {
        if (v === '' || v === null || v === undefined) return '';
        if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        if (typeof v === 'object' && 'date' in v) return `<c r="${ref}" s="${XS.date}"><v>${v.date}</v></c>`;
        return `<c r="${ref}" s="${s}" t="s"><v>${sst(v)}</v></c>`;
    };
    const rowXml = (r, cells, ht) => `<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells.map(([c, v, s]) => cell(`${colName(c)}${r}`, v, s)).join('')}</row>`;
    const colsXml = (widths) => `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
    const sheetHead = (pane) => `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>`
        + '<sheetFormatPr defaultRowHeight="15" customHeight="1"/>';

    // Statistics sheet: title, headline numbers, then one section per chart,
    // its table in A:B and its chart from column D, on the same rows.
    const SHEET = 'Statistics', ROW_PX = 20, CHART_W_PX = 600;
    const rows = [rowXml(1, [[0, title, XS.title]], 30), rowXml(2, [[0, context, XS.muted]])];
    let r = 4;
    if (kpis.length) {
        rows.push(rowXml(r++, [[0, 'Headline numbers', XS.section]], 20));
        kpis.forEach(k => rows.push(rowXml(r++, [[0, k.label, XS.muted], [1, k.value, XS.kpi]], 20)));
        r++;
    }
    const anchors = [], chartParts = [];
    charts.forEach((ch, i) => {
        const start = r;
        rows.push(rowXml(r++, [[0, ch.title, XS.section]], 20));
        const shortened = ch.kind === 'bar' && ch.items.length > XLSX_BAR_MAX;
        const note = [ch.note, shortened ? `The chart shows the top ${XLSX_BAR_MAX}.` : ''].filter(Boolean).join(' ');
        if (note) rows.push(rowXml(r++, [[0, note, XS.muted]]));
        const headRow = r;
        rows.push(rowXml(r++, [[0, ch.axis || (ch.kind === 'bar' ? 'Item' : 'When'), XS.head], [1, ch.unit, XS.head]]));
        const first = r;
        ch.items.forEach(it => rows.push(rowXml(r++, [[0, String(it.label)], [1, Number(it.value) || 0]])));
        const shown = shortened ? XLSX_BAR_MAX : ch.items.length;
        const heightPx = ch.kind === 'bar' ? Math.max(200, 70 + 26 * shown) : 280;
        chartParts.push(chartXml(ch, { sheet: SHEET, catCol: 'A', valCol: 'B', headRow, first }));
        anchors.push({ row: start - 1, cx: CHART_W_PX * 9525, cy: heightPx * 9525, id: i + 1 });
        r = Math.max(r, start + Math.ceil(heightPx / ROW_PX)) + 2;
    });
    const statsSheet = sheetHead('') + colsXml([30, 12, 3]) + `<sheetData>${rows.join('')}</sheetData>`
        + '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        + (anchors.length ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
    const drawing = `${XML_HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${NS_A}">`
        + anchors.map(a => `<xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
            + `<xdr:ext cx="${a.cx}" cy="${a.cy}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${a.id + 1}" name="Chart ${a.id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
            + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
            + `<c:chart xmlns:c="${NS_C}" xmlns:r="${NS_REL}" r:id="rId${a.id}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`).join('')
        + '</xdr:wsDr>';

    // Reports sheet: the table, header frozen, as an Excel table with filters.
    const { header, rows: repRows } = reports;
    // Table column names must be unique and non-empty.
    const seen = new Set();
    // A repeated name is numbered: Identifier, Identifier 2, Identifier 3.
    const heads = header.map((h, i) => {
        const base = String(h).trim() || `Column ${i + 1}`;
        let n = base;
        for (let k = 2; seen.has(n.toLowerCase()); k++) n = `${base} ${k}`;
        seen.add(n.toLowerCase());
        return n;
    });
    const lastCol = colName(Math.max(heads.length, 1) - 1);
    const hasTable = heads.length > 0 && repRows.length > 0;
    const tableRef = `A1:${lastCol}${repRows.length + 1}`;
    const widths = heads.map(h => ({ Identifier: 18, Status: 10, By: 6, Size: 22, Activity: 28, Location: 30, Analysis: 36, 'NAI / OBJ / PL': 18, 'Activity tags': 20, Heading: 9, 'BDA assessed': 13, Updates: 9 }[h] || (/^Time/.test(h) ? 17 : 16)));
    const reportsSheet = sheetHead('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>')
        + (widths.length ? colsXml(widths) : '')
        + `<sheetData>${[rowXml(1, heads.map((h, c) => [c, h, XS.head]), 20), ...repRows.map((row, i) => rowXml(i + 2, row.map((v, c) => [c, v])))].join('')}</sheetData>`
        + '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        + (hasTable ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : '') + '</worksheet>';
    const table = `${XML_HEAD}<table xmlns="${NS_MAIN}" id="1" name="ReportTable" displayName="ReportTable" ref="${tableRef}" totalsRowShown="0">`
        + `<autoFilter ref="${tableRef}"/><tableColumns count="${heads.length}">${heads.map((h, i) => `<tableColumn id="${i + 1}" name="${xmlText(h)}"/>`).join('')}</tableColumns>`
        + '<tableStyleInfo name="TableStyleLight1" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>';

    const shared = `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">`
        + strings.map(s => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join('') + '</sst>';
    const CT = 'application/vnd.openxmlformats-officedocument';
    const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        + `<Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/>`
        + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`
        + `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`
        + `<Override PartName="/xl/styles.xml" ContentType="${CT}.spreadsheetml.styles+xml"/>`
        + `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.spreadsheetml.sharedStrings+xml"/>`
        + (hasTable ? `<Override PartName="/xl/tables/table1.xml" ContentType="${CT}.spreadsheetml.table+xml"/>` : '')
        + (anchors.length ? `<Override PartName="/xl/drawings/drawing1.xml" ContentType="${CT}.drawing+xml"/>` : '')
        + chartParts.map((_, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="${CT}.drawingml.chart+xml"/>`).join('')
        + '</Types>';
    const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView activeTab="0"/></bookViews>`
        + '<sheets><sheet name="Statistics" sheetId="1" r:id="rId1"/><sheet name="Reports" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const enc = new TextEncoder();
    const files = [
        ['[Content_Types].xml', types],
        ['_rels/.rels', relsXml([['rId1', REL('officeDocument'), 'xl/workbook.xml']])],
        ['xl/workbook.xml', workbook],
        ['xl/_rels/workbook.xml.rels', relsXml([['rId1', REL('worksheet'), 'worksheets/sheet1.xml'], ['rId2', REL('worksheet'), 'worksheets/sheet2.xml'],
            ['rId3', REL('styles'), 'styles.xml'], ['rId4', REL('sharedStrings'), 'sharedStrings.xml']])],
        ['xl/styles.xml', XLSX_STYLES],
        ['xl/worksheets/sheet1.xml', statsSheet],
        ['xl/worksheets/sheet2.xml', reportsSheet],
        ...(anchors.length ? [
            ['xl/worksheets/_rels/sheet1.xml.rels', relsXml([['rId1', REL('drawing'), '../drawings/drawing1.xml']])],
            ['xl/drawings/drawing1.xml', drawing],
            ['xl/drawings/_rels/drawing1.xml.rels', relsXml(chartParts.map((_, i) => [`rId${i + 1}`, REL('chart'), `../charts/chart${i + 1}.xml`]))],
            ...chartParts.map((x, i) => [`xl/charts/chart${i + 1}.xml`, x]),
        ] : []),
        ...(hasTable ? [
            ['xl/worksheets/_rels/sheet2.xml.rels', relsXml([['rId1', REL('table'), '../tables/table1.xml']])],
            ['xl/tables/table1.xml', table],
        ] : []),
        // Written last: the strings every sheet above used.
        ['xl/sharedStrings.xml', shared],
    ];
    return zipStore(files.map(([name, text]) => ({ name, data: enc.encode(text) })), now);
};

// --- Summary reports ---

// Written reports built from fixed templates and counting rules, so the same
// reports always give the same text and nothing is made up. Plain text, for
// chat, email, a .txt, or print.

// "251800Z OCT 26" (a DTG), or "251800L OCT 26" in local time; NO_TIME for
// no time or an invalid one.
const dtg = (ms, local) => {
    const d = timeOf(ms);
    if (!d) return NO_TIME;
    const f = dateFields(d, local);
    return `${f.day}${f.h}${f.mi}${local ? 'L' : 'Z'} ${MONTHS[+f.mo - 1]} ${String(f.y).slice(2)}`;
};
// "251400Z": day and time, so a list crossing midnight still reads in order.
const dayTime = (ms, local) => { const d = timeOf(ms); if (!d) return NO_TIME; const f = dateFields(d, local); return `${f.day}${f.h}${f.mi}${local ? 'L' : 'Z'}`; };
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
    narrative:  'NARRATIVE',
};

// The written report of one kind ('rollup', 'trafficked', 'place', 'brief', 'narrative')
// over the live reports between `from` and `to` (ms; null for open ends).
// When both ends are set, the same length of time just before is the
// "previous" period it compares with.
//   opts: { local, from, to, now, ato, title, by, place, squareDigits, narrative }
//   (narrative: the team's narrative settings, for the 'narrative' kind;
//   width: the columns it's wrapped to, 100 unless shown narrower;
//   team: the team's equipment (teamEquipment) for counting types, by
//   default the one in the narrative settings)
// A kind it doesn't know is a rollup.
const summaryReport = (kind, reps, overlays, opts) => {
    const { local, from = null, to = null, now = new Date(), ato = '', title = '', by = '', place = '', squareDigits = 2, narrative = null, width = 100 } = opts;
    if (!Object.prototype.hasOwnProperty.call(SUMMARY_KINDS, kind)) kind = 'rollup';
    const team = opts.team !== undefined ? opts.team : narrative ? narrativeSettings(narrative).team : null;
    const facts = (reps || []).filter(r => !r.deleted).map(r => reportFacts(r, overlays))
        .filter(f => !isNaN(f.ms)).sort((x, y) => x.ms - y.ms);
    const within = (lo, hi) => facts.filter(f => (lo === null || f.ms >= lo) && (hi === null || f.ms <= hi));
    const cur = within(from, to);
    const span = from !== null && to !== null ? to - from : null;
    const prev = span !== null ? within(from - span, from - 1) : null;
    const hrs = span !== null ? Math.round(span / 3600000) : null;
    const prevNote = prev ? `previous ${hrs} hrs: ${prev.length}` : '';
    const d = statsData(cur.map(f => f.r), overlays, { local, squareDigits, team });
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
            ? `   ${d.kpis.bdaDone} of ${plural(d.kpis.bdaTotal, 'item')} assessed: ${countList(d.bda.filter(b => b.value && b.label !== 'Unassessed'))}.`
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
    } else if (kind === 'narrative') {
        out.push(...narrativeLines(cur, prev, { local, hrs, end: to === null ? now.getTime() : to, places: placesTop, settings: narrative, width }));
    } else if (kind === 'brief') {
        const last = cur[cur.length - 1];
        out.push(
            `REPORTS:      ${cur.length}${prev ? ` (previous shift ${prev.length})` : ''}`,
            `MOST ACTIVE:  ${[...placesTop, ...d.pl].sort((x, y) => y.value - x.value).slice(0, 3).map(p => `${p.label} (${p.value})`).join(', ') || 'none named'}`,
            `ACTIVITY:     ${activityLine(cur)}`,
            `LAST REPORT:  ${last ? reportLine(last, local) : 'none'}`,
            `OPEN ITEMS:   ${plural(cur.filter(f => f.a.checks.length).length, 'check')} to look at; ${plural(unassessed, 'BDA item')} unassessed`,
            '', 'LAST 5 REPORTS',
            ...(cur.length ? cur.slice(-5).reverse().map(f => `  ${reportLine(f, local)}`) : ['  None.']),
        );
    }
    return out.join('\n') + '\n';
};

// Every place the summaries can be about: overlays, and whatever is named.
const summaryPlaces = (reps, overlays) => {
    const d = statsData(reps, overlays, {});
    const keys = new Set([...(overlays || []).filter(overlayOk).map(overlayKey), ...d.nai, ...d.obj, ...d.pl].map(x => x.label || x));
    const order = { NAI: 0, OBJ: 1, PL: 2 };
    return [...keys].sort((a, b) => order[a.split(' ')[0]] - order[b.split(' ')[0]] || a.localeCompare(b, undefined, { numeric: true }));
};

// --- Narrative ---

// The narrative summary: what the reports say (OBSERVED), then what they
// suggest (ASSESSMENT), from fixed rules that cite the reports behind each
// judgment. The same reports always give the same words, nothing is put down
// as seen that wasn't reported, and nothing leaves the page (no AI model).

// What a type in the Size field is. Starter set: Russian (and Soviet-era) and
// Chinese systems, then plain words (truck, PAX). Each entry is
// [role, origin, name, ...other names]. A name with a digit matches the start
// of a type (T-72 matches T-72B3 but not T-720, and the longer BMP-1KSh wins
// over BMP-1); one without matches a whole word (GRAD, not GRADER).
const EQUIPMENT_ROLES = [
    ['armor', 'armor'], ['mech', 'mechanized infantry'], ['recon', 'reconnaissance'],
    ['fires', 'artillery and rockets'], ['ad', 'air defense'], ['atgm', 'antitank'],
    ['engineer', 'engineers'], ['logistics', 'logistics and support'], ['c2', 'command and control'],
    ['ew', 'electronic warfare'], ['air', 'aviation'], ['infantry', 'dismounted personnel'],
    ['light', 'light vehicles'], ['vehicle', 'other vehicles'],
];
const eqp = (role, origin, names) => names.map(n => [role, origin, ...[].concat(n)]);
const EQUIPMENT_CATALOGUE = [
    // Russian and Soviet-era. Variants are listed with each type: a type
    // matches its variants anyway (T-72 matches T-72B3M), but listing them
    // says which are meant, and the names (Proryv, Basurmanin) match too.
    // A variant after a hyphen and a digit (9P163-3, 2B14-1) is listed, since
    // the digit stops the match. Names that also mean something else (Rys,
    // Vityaz, Ovod, Redut, Klin) are given only as their designations.
    ...eqp('armor', 'RU', [['T-54', 'T-54A', 'T-54B'], ['T-55', 'T-55A', 'T-55AM', 'T-55AMV'], ['T-62', 'T-62M', 'T-62MV'],
        ['T-64', 'T-64A', 'T-64B', 'T-64BV'], ['T-72', 'T-72A', 'T-72AV', 'T-72B', 'T-72B1', 'T-72B3', 'T-72B3M', 'T-72BA', 'T-72B1K', 'T-72B3A'],
        ['T-80', 'T-80B', 'T-80BV', 'T-80BVM', 'T-80BVK', 'T-80U', 'T-80UD', 'T-80UK', 'T-80UM2', 'T-80UE-1'],
        ['T-90', 'T-90A', 'T-90AK', 'T-90S', 'T-90SM', 'T-90M', 'Proryv'],
        ['T-14', 'T-14 Armata'], ['PT-76', 'PT-76B'], ['2S25', '2S25M', 'Sprut-SD', 'Sprut-SDM1'], ['BMPT', 'BMPT-72', 'Terminator']]),
    ...eqp('mech', 'RU', [['BMP-1', 'BMP-1P', 'BMP-1AM', 'BMP-1U', 'Basurmanin'], ['BMP-2', 'BMP-2M', 'BMP-2D', 'Berezhok'], ['BMP-3', 'BMP-3M'],
        'BMD-1', 'BMD-2', 'BMD-3', ['BMD-4', 'BMD-4M', 'Sadovnitsa'], 'BTR-D', ['BTR-MD', 'Rakushka'], 'BTR-50', ['BTR-60', 'BTR-60PB'],
        ['BTR-70', 'BTR-70M'], ['BTR-80', 'BTR-80A'], ['BTR-82', 'BTR-82A', 'BTR-82AM', 'BTR-82AT'], ['BTR-90', 'Rostok'], 'BTR-MDM', 'BTR-T',
        ['BTR-22', 'Bumerang', 'K-17', 'K-16'], ['Kurganets-25', 'Kurganets', 'B-11'], ['T-15', 'T-15 Armata'],
        ['MT-LB', 'MT-LBV', 'MT-LBVM', 'MT-LBu', 'MT-LBVMK'],
        ['Typhoon', 'K-63968', 'K-4386', 'K-53949', 'KamAZ-63968', 'KamAZ-53949', 'Ural-63095', 'Ural-63099', 'Typhoon-K', 'Typhoon-VDV', 'Taifun', 'Tayfun'],
        ['SBA-60K2', 'Bulat'], ['BPM-97', 'KamAZ-43269', 'Vystrel'], ['Ural-VV', 'Ural-4320VV']]),
    ...eqp('recon', 'RU', [['BRDM-1'], ['BRDM-2', 'BRDM-2M', 'BRDM-2A', 'BRDM-2MS'], ['BRM-1K', 'BRM-1KM'], ['BRM-3K', 'Rys'], 'PRP-3',
        ['PRP-4', 'PRP-4A', 'PRP-4M', 'Nard', 'Deyteriy'],
        ['Orlan-10', 'Orlan-30', 'Orlan'], ['Zala', 'Zala 421-16E', '421-08', '421-16'], ['Eleron-3', 'Eleron'], 'Forpost', ['Granat', 'Granat-4'],
        ['Takhion', 'Tachyon'], 'Supercam', 'Merlin-VR',
        ['1L219', 'Zoopark-1', 'Zoopark-1M', '1L260', 'Zoopark'], ['1L271', 'Aistyonok'], ['1L227', 'Sobolyatnik'],
        ['SNAR-10', '1RL133', 'Big Fred'], ['ARK-1', 'ARK-1M'], ['1B75', 'Penicillin', 'Penitsillin'], 'AZK-7',
        'Uran-9', 'Nerekhta', ['Kurier', 'Kuryer'], 'MRK-65']),
    ...eqp('fires', 'RU', [['2S1', 'Gvozdika', 'M1974'], ['2S3', '2S3M', 'Akatsiya', 'M1973'], ['2S4', 'Tyulpan'], ['2S5', 'Giatsint-S'],
        ['2S7', '2S7M', 'Pion', 'Malka'], ['2S9', 'Nona-S'], ['2S19', '2S19M2', 'Msta-S'], ['2S23', 'Nona-SVK'], ['2S31', 'Vena'],
        ['2S33', 'Msta-SM2'], ['2S34', 'Khosta'], ['2S35', 'Koalitsiya-SV', 'Koalitsiya'], ['2S40', 'Floks'], ['2S43', 'Malva'],
        ['2S41', 'Drok'], ['2S42', 'Lotos'], 'D-20', ['D-30', '2A18'], 'D-1', ['M-30', 'M1938'], 'BS-3', ['M-46'], ['2A36', 'Giatsint-B'],
        ['2A65', 'Msta-B'], ['2B16', 'Nona-K'],
        ['BM-21', '9K51', 'Grad', 'BM-21-1', '9P138', '9P132'], ['2B26', 'Grad-K'], ['BM-27', '9K57', '9P140', 'Uragan'], ['9K512', 'Uragan-1M'],
        ['BM-30', '9K58', '9A52', '9A52-2', 'Smerch'], ['Tornado-G', '9K51M', '9A53-G', '2B17'], ['Tornado-S', '9K515'], ['Tornado', '9A52-4'],
        ['9K59', '9A51'], ['TOS-1', 'TOS-1A', 'Buratino', 'Solntsepyok', 'Solntsepek'], ['TOS-2', 'Tosochka'], ['TOS-3', 'Drakon'], ['BMO-T'],
        ['TZM-T'], '9T452', '9T234-2',
        ['2B9', 'Vasilek'], ['2S12', '2B11', 'Sani'], ['2B14', '2B14-1', 'Podnos'], '2B24', ['BM-37', '82-BM-37'], ['PM-43', '120-PM-43'],
        ['Iskander', '9K720', 'Iskander-M', 'Iskander-K', '9M723', '9M728', '9M729', '9P78', '9P78-1', 'SS-26', 'SSC-7', 'SSC-8'],
        ['Tochka', '9K79', 'Tochka-U', '9P129', '9M79', 'SS-21'], ['Luna-M', '9K52', 'FROG-7'],
        ['K-300P', 'Bastion-P', 'SSC-5', 'P-800', 'Oniks'], ['3K60', 'Bal-E', 'SSC-6'], ['Kalibr', '3M-14', '3M-54', 'SS-N-30A', 'SS-N-27'],
        ['Lancet', 'Zala Lancet', 'Lancet-3'], ['Geran-2', 'Geran', 'Shahed-136', 'Shahed'], ['Kub-BLA'], 'Gerbera', ['Garpiya', 'Garpiya-A1'],
        'Italmas', ['Molniya', 'Molniya-2'], ['KVN', 'Knyaz Vandal Novgorodsky', 'Knyaz Vandal'], 'VT-40', 'Skalpel']),
    ...eqp('ad', 'RU', [['ZSU-23-4', 'ZSU-23-4M4', 'Shilka'], ['ZU-23-2', 'ZU-23'], ['ZPU-4', 'ZPU-2'], 'ZSU-57-2', ['S-60'],
        ['2S6', '2S6M', '2S6M1', '2K22', '2K22M', 'Tunguska', 'SA-19', 'Grison'], ['Pantsir', 'Pantsir-S1', 'Pantsir-SM', '96K6', 'SA-22'],
        ['2S38', 'Derivatsiya-PVO', 'Derivatsiya'], ['BTR-ZD', 'Skrezhet'],
        ['Osa', '9K33', '9A33', '9A33BM3', 'Osa-AKM', 'SA-8'], ['Strela-10', '9K35', '9A35', '9A34', 'SA-13'], ['Strela-1', '9K31', 'SA-9'],
        ['Strela-2', '9K32', 'SA-7'], ['Strela-3', '9K34', 'SA-14'], ['Igla', '9K38', '9K310', 'Igla-1', 'SA-16', 'SA-18'], ['Igla-S', '9K338', 'SA-24'],
        ['Verba', '9K333', 'SA-25'], ['Tor', '9K330', '9K331', '9K332', '9A330', '9A331', 'Tor-M1', 'Tor-M2', 'Tor-M2DT', 'Tor-M2U', 'Tor-M2KM', 'SA-15'],
        ['Buk', '9K37', 'Buk-M1', '9K317', 'Buk-M2', 'Buk-M3', '9A310', '9A316', '9A317', '9A39', '9S470', '9S510', '9S36', 'SA-11', 'SA-17', 'SA-27'],
        ['Kub', '2K12', '2P25', '1S91', 'Straight Flush', 'SA-6'], ['Krug', '2K11', 'SA-4'],
        ['S-125', 'Neva', 'Pechora', 'SA-3'], ['S-75', 'SA-2'],
        ['S-300', 'S-300PS', 'S-300PM', 'S-300V', 'S-300V4', '5P85', '30N6', '76N6', '40V6', '5N63', 'Flap Lid', 'Clam Shell',
            '9A82', '9A83', '9A84', '9A85', '9S15', '9S19', '9S32', '9S457', 'SA-10', 'SA-12', 'SA-20', 'SA-23'],
        ['S-350', 'Vityaz', '50P6', '50N6', '50K6', 'SA-28'], ['S-400', 'Triumf', '92N6', '91N6', '55K6', '5P85TE2', 'Grave Stone', 'SA-21'], 'S-500',
        ['Sosna', 'Sosna-R'], ['Gibka-S', 'Gibka'],
        ['9S18', 'Kupol'], ['96L6'], ['64N6'], ['P-18'], ['P-19'], ['Nebo', 'Nebo-M', 'Nebo-SVU', '55Zh6', '55Zh6U', '55Zh6M', '1L13', '1L119'],
        ['Kasta', 'Kasta-2E', '39N6'], ['1L122', 'Garmon', 'Garmony'], ['48Ya6', 'Podlet', 'Podlet-K1'], ['67N6', 'Gamma-DE'],
        ['59N6', 'Protivnik-GE', 'Protivnik'], ['36D6', 'ST-68U', '19Zh6', 'Tin Shield']]),
    ...eqp('atgm', 'RU', [['Malyutka', '9K11', '9M14', 'AT-3'], ['Fagot', '9K111', '9M111', 'AT-4'], ['Konkurs', '9K113', '9M113', '9P148', 'AT-5'],
        ['Shturm', '9K114', '9M114', '9P149', 'Shturm-S', 'AT-6'], ['Metis', '9K115', '9M115', 'AT-7'], ['Metis-M', '9K115-2', '9M131', 'AT-13'],
        ['Kornet', '9K135', '9M133', '9P162', '9P163', '9P163-3', '9P163M-1', 'Kornet-D', 'Kornet-T', 'Kornet-EM', 'AT-14'],
        ['Khrizantema', '9K123', '9M123', '9P157', '9P157-2', 'Khrizantema-S', 'AT-15'],
        ['Vikhr', '9K121', '9M127', 'AT-16'], ['Kobra', '9K112', '9M112', 'AT-8'], ['Refleks', '9K119', '9M119', 'AT-11'], ['Ataka', '9K120', '9M120', 'AT-9'],
        ['RPG-7', 'RPG-7V'], ['RPG-18', 'Mukha'], 'RPG-22', ['RPG-26', 'Aglen'], ['RPG-27', 'Tavolga'], ['RPG-28', 'Klyukva'], ['RPG-29', 'Vampir'],
        ['RPG-30', 'Kryuk'], ['RPG-32', 'Hashim'], ['RPO-A', 'RPO', 'RPO-M', 'Shmel', 'Shmel-M'], 'MRO-A', 'RShG-1', 'RShG-2',
        ['SPG-9'], ['2A45', 'Sprut-B'], ['MT-12', 'Rapira', 'T-12', '2A19', '2A29'], 'BTR-RD']),
    ...eqp('engineer', 'RU', ['MTU-20', 'MTU-72', 'MTU-90', ['MT-55', 'MT-55A'], ['TMM', 'TMM-3', 'TMM-3M2', 'TMM-6'], ['PMP', 'PMP-2M'],
        'PP-91', 'PP-2005', 'PPS-84', 'PMM-2', 'GSP', 'K-61',
        ['PTS', 'PTS-2', 'PTS-3', 'PTS-4'], ['IMR-2', 'IMR-2M'], ['IMR-3', 'IMR-3M'], 'IRM', 'BAT-2', 'BAT-M', 'MDK-3', 'BTM-3', 'PZM-2', 'PZM-3',
        ['BMR-3', 'BMR-3M', 'BMR-3MA'], 'KMT-7', 'KMT-8', ['UR-77', 'Meteorit', 'Zmey Gorynych'], 'UR-67', 'UR-07', 'GMZ-3', 'PMZ-4', ['UMZ', 'UMZ-G'],
        ['Zemledeliye', 'ISDM'], 'Uran-6', 'Prokhod-1', 'EOV-4421', 'EOV-3521', 'EOV-3523', 'PBU-100', ['KS-3574', 'KS-45719', 'KS-55729', 'KS-45731'],
        'RKhM-4', ['RKhM-6', 'Povozka'], 'RPM-2', ['BRDM-2RKh', 'BRDM-2RKhb'], ['TMS-65', 'TMS-65M'], 'ARS-14', ['UTM-80M', 'UTM-80'],
        'TDA-2K', 'TDA-3', ['MRK-46', 'MRK-RKh']]),
    ...eqp('logistics', 'RU', [['Ural', 'Ural-375', 'Ural-4320'], ['KamAZ', 'KamAZ-4310', 'KamAZ-5350', 'KamAZ-6560'], 'GAZ-66',
        ['GAZ-3308', 'Sadko'], 'GAZ-33097', ['ZIL-131', 'ZIL-157', 'ZIL'], ['KrAZ', 'KrAZ-255', 'KrAZ-260'], ['MAZ-537', 'MAZ-543', 'MAZ-6317'],
        ['MZKT-7930', 'MZKT-7429'], ['BAZ-6403', 'BAZ'], ['ATZ', 'ATMZ'], 'GAZ-3351', ['GAZ-3344', 'Aleut'], ['DT-30', 'DT-30P', 'DT-30PM'],
        ['DT-10', 'DT-10P', 'DT-10PM'],
        ['BREM', 'BREM-1', 'BREM-1M'], ['BREM-L', 'Beglyanka'], 'BREM-K', 'BREM-D', 'BREM-80U', 'REM-KL', 'REM-KS', 'MTO-UB', 'PARM-1AM1',
        'BTS-2', 'BTS-4', ['BMM-80', 'GAZ-59039'], 'Linza']),
    ...eqp('c2', 'RU', [['R-149', 'R-149MA1', 'R-149MA3', 'R-149BMR', 'R-149AKSh'], 'BMP-1KSh', 'BMP-2K', 'BMD-1KSh', 'BMD-2K', 'BTR-80K',
        ['R-145BM', 'R-145'], ['R-142', 'R-142N'], 'R-166', 'R-177M', ['R-439', 'R-439MD2'], ['R-419', 'R-419L1', 'R-419MP'], ['R-416', 'R-416GM'],
        ['R-423', 'R-423AM'], 'R-441', ['P-260', 'Redut-2US'],
        '1V13', '1V119', ['1V12', '1V12M', 'Mashina-M'], '1V14', '1V15', '1V16', '1V152', 'PU-12', ['Barnaul-T', 'Barnaul'],
        ['Andromeda-D', 'Andromeda'], ['Polyana-D4', '9S52'], ['9S737', 'Ranzhir', 'Ranzhir-M'], ['PPRU-1', '9S80', 'Ovod-M-SV']]),
    ...eqp('ew', 'RU', [['Krasukha', 'Krasukha-2', 'Krasukha-4', '1RL257', '1L269'], ['Borisoglebsk-2', 'RB-301B', 'R-330BMV', 'R-378BMV'],
        ['Leer-3', 'RB-341V'], ['Leer-2'], ['Zhitel', 'R-330Zh'], ['Pole-21', 'R-340RP'], ['Moskva-1', '1L267'], 'Palantin', ['Murmansk-BN', 'Murmansk'],
        ['Infauna', 'RB-531B'], ['Rtut-BM', 'Rtut-B', '1L262', 'SPR-2', 'Rtut'], 'Silok', ['Tirada-2', 'Tirada'], ['Bylina', 'RB-109A'],
        ['Shipovnik-Aero', 'Shipovnik'], ['Torn', 'R-381T'], 'Repellent-1', 'Stupor', ['1L222', 'Avtobaza', 'Avtobaza-M'],
        ['RB-636', 'RB-636AM2', 'Svet-KU'], ['R-934B', 'R-934BMV', 'Sinitsa'], ['RP-377', 'RP-377A', 'Lesochek'], ['RP-377LA', 'Lorandit'],
        ['R-330M1P', 'Diabazol'], 'Dzyudoist', 'Altayets', 'ZS-82', 'ZS-88',
        // Radar jammers against airborne radars, strategic and tactical
        // systems, and the drone jammers fitted to vehicles and carried.
        ['SPN-2', '1RL248-2'], 'SPN-3', ['SPN-4', '1RL248-4'], 'SPN-30', ['Tobol', '14Ts227'], 'Divnomorye', 'Samarkand',
        ['Mi-8MTPR-1', 'Rychag-AV'], 'Khibiny', 'Volnorez', ['Saniya', 'Sania'], ['Pishchal', 'Pischal']]),
    ...eqp('air', 'RU', [['Mi-8', 'Mi-8AMTSh', 'Mi-8MTV', 'Hip'], ['Mi-17', 'Mi-171', 'Mi-171E', 'Mi-171Sh'],
        ['Mi-24', 'Mi-24P', 'Mi-24V', 'Hind'], ['Mi-35', 'Mi-35M'],
        ['Mi-28', 'Mi-28N', 'Mi-28NM', 'Havoc'], 'Mi-26', ['Mi-2', 'Hoplite'], ['Ka-50', 'Hokum'], ['Ka-52', 'Alligator'], ['Ka-226', 'Hoodlum'],
        ['Ka-27', 'Helix'], 'Ka-29', ['Ansat', 'Ansat-U'],
        ['Su-24', 'Su-24M', 'Su-24MR', 'Fencer'], ['Su-25', 'Su-25SM3', 'Frogfoot'], ['Su-27', 'Flanker'], ['Su-30', 'Su-30SM', 'Su-30MKK', 'Su-30MK2'],
        ['Su-34', 'Fullback'], 'Su-35', 'Su-57', ['MiG-29', 'Fulcrum'], ['MiG-31', 'MiG-31K', 'MiG-31BM', 'Foxhound'], ['Yak-130', 'Mitten'],
        ['Tu-22M', 'Tu-22M3'], 'Tu-95', 'Tu-160', ['A-50', 'A-50U', 'Mainstay'], 'Il-76', ['Il-20', 'Il-20M', 'Coot-A'], ['Il-22', 'Il-22PP', 'Porubshchik'],
        'Tu-214R', 'An-12', 'An-22', 'An-26',
        ['Orion', 'Inokhodets'], ['Forpost-R'], ['Okhotnik'], ['Altius', 'Altius-U', 'Altius-RU'],
        'UMPK', ['FAB-500', 'FAB-250', 'FAB-1500', 'FAB-3000'], ['KAB-500', 'KAB-1500'],
        ['Kh-31', 'Kh-31P'], 'Kh-58', 'Kh-59', 'Kh-101', 'Kh-22', 'Kh-32', ['Kinzhal', 'Kh-47M2']]),
    ...eqp('infantry', 'RU', [['AGS-17', 'Plamya'], 'AGS-30', 'AGS-40', ['NSV', 'Utyos'], 'Kord', ['DShK', 'DShKM'], ['PKM', 'PKP', 'Pecheneg']]),
    ...eqp('light', 'RU', [['UAZ-469', 'UAZ'], ['UAZ-452', 'Bukhanka'], ['Tigr', 'Tigr-M', 'GAZ-2330', 'GAZ-233014', 'GAZ-233114', 'GAZ-233036'],
        ['Vodnik', 'GAZ-3937', 'GAZ-39371'], ['Iveco LMV', 'LMV', 'Iveco Rys', 'Lince'], ['KamAZ-435029', 'Patrul-A'], ['Z-STS', 'Z-STS Akhmat'],
        ['AMN-590951', 'Spartak'], ['Sarmat-3', 'LSTC-1944'], 'Sarmat-2', ['Chaborz M-3', 'Chaborz'], ['Desertcross 1000-3', 'Desertcross']]),
    // Chinese. "Type NN" is given only where it means one thing (Type 89 is an
    // APC, a howitzer, a rocket launcher and a tank destroyer, so the PLA
    // designations ZSD-89, PLZ-89, PHZ-89 and PTZ-89 are used instead).
    // Brand words that name other things too (Shaanxi aircraft, Dongfeng
    // missiles, Lynx IFVs) are left out for their model numbers.
    ...eqp('armor', 'CN', [['Type 59', 'Type 59-II', 'WZ-120', 'ZTZ-59', 'Type 59D'], ['Type 62', 'ZTQ-62'], ['Type 63A', 'ZTS-63'],
        ['Type 69', 'Type 69-II'], 'Type 79', 'Type 80', ['Type 85', 'Type 85-II'], ['Type 88', 'ZTZ-88'],
        ['Type 96', 'ZTZ-96', 'Type 96A', 'Type 96B'], ['Type 98', 'ZTZ-98'], ['Type 99', 'ZTZ-99', 'Type 99A'],
        ['Type 100', 'ZTZ-100', 'ZTZ-201'], ['Type 15', 'ZTQ-15', 'VT5'], ['VT4', 'MBT-3000'], ['ZTL-11', 'ZLT-11', 'ST-1'],
        ['ZTD-05', 'VN16'], 'ST-3']),
    ...eqp('mech', 'CN', [['ZBD-04', 'Type 04', 'ZBD-04A', 'WZ-502'], ['ZBD-05', 'ZBD-2000', 'VN18'], 'ZBD-03',
        ['ZBD-86', 'Type 86', 'WZ-501', 'ZBD-86A'], ['ZSL-92', 'Type 92', 'WZ-551', 'ZSL-92A', 'ZSL-92B', 'VN2', 'CS/VN9'],
        ['ZBL-08', 'Type 08', 'ZBL-09', 'VN-1', 'VN1C'], 'ZBL-19', 'ZSL-10', 'ZSD-05', ['ZSL-93', 'WZ-523'], 'ZFB-91',
        ['ZFB-05', 'ZFB-05C'], ['ZSD-89', 'YW534', 'ZSD-89A'], ['ZSD-63', 'YW531'], ['YW531H', 'Type 85 APC'],
        'VN11', 'VN12', 'VN22', 'VN23', 'CS/VN4', 'CS/AA5', 'VS27']),
    ...eqp('recon', 'CN', ['ASN-206', ['ASN-207', 'WZ-6'], ['ASN-209', 'Silver Eagle'], ['BZK-005'], ['BZK-006', 'KDV001'],
        'BZK-007', 'BZK-008', 'BZK-009', ['WZ-7'], ['TB-001', 'Twin-Tailed Scorpion'], ['CH-3'], ['ZRY-222', 'ZRY222'],
        'VE36', 'VE32A', ['SLC-2'], ['Type 704']]),
    ...eqp('fires', 'CN', [['PLZ-05', 'PLZ-05A'], ['PLZ-07', 'PLZ-07A', 'PLZ-07B'], ['PLZ-83', 'PLZ-83A', 'PLZ-83B'], ['PLZ-89', 'SH-3'],
        'PLZ-10', 'PLZ-45', 'PCL-09', 'PCL-161', 'PCL-171', ['PCL-181', 'PLC-181', 'SH-15'], 'PLL-05', 'PLL-09',
        ['PCP-001', 'CS/SM1'], 'SH-1', 'SH-2', 'SH-5', 'SH-9', 'SH-11', ['SH-16', 'SH-16A'], 'CS/SH4', 'CS/SM4', 'CS/SM10',
        'CS/SS6', 'AH-2', 'AH-4', 'W90', ['PL-66', 'Type 66'], ['PL-96'], ['Type 59-1', 'PL-59', 'PL-59-1'], 'PL-54', 'PL-54-1',
        ['PL-83', 'Type 83 gun'], ['WZ-302', 'WZ302'],
        'PP-87', 'PP-89', 'PP-89-100', 'PP-93', 'PBP-201', 'PBP-172', 'W86', 'W84', 'QLT-89',
        'PHL-03', ['PHL-16', 'PCH-191', 'PCL-191'], ['PHL-11', 'SR-4'], 'PHZ-11', 'PHZ-89', ['PHL-81', 'Type 81'], 'PHL-90',
        ['PHL-20', 'SR-7'], 'PHL-21', ['PH-63', 'Type 63 MRL'], ['WZ-303', 'WZ303'],
        ['AR-1', 'AR-1A'], 'AR-2', 'AR-3', 'SR-5', 'WS-1', 'WS-2', 'WS-3', 'WS-22', 'WS-32', 'WS-33', 'WS-35', 'WS-600L',
        'SY-300', ['SY-400', 'BP-12A', 'BP-12'], 'A-200', 'A-300', 'WM-40', 'WM-80',
        'DF-11', 'DF-12', 'DF-15', 'DF-16', 'DF-17', 'DF-21', 'DF-26', 'DF-27', ['DF-31', 'DF-31AG'], 'DF-41', 'DF-61',
        'DF-5', 'CJ-10', ['CJ-100', 'DF-100'], 'CJ-1000', 'YJ-62', 'YJ-12',
        ['CH-901', 'FH-901'], ['ASN-301', 'JWS-01', 'Feilong-300A'], 'CM-501XA', 'CM-501GA', 'WS-43']),
    ...eqp('ad', 'CN', [['PGZ-04', 'PGZ-04A'], 'PGZ-07', 'PGZ-09', 'PGZ-88', 'PGZ-95', ['PGL-625', 'PLB-625', 'Type 625'],
        ['PGL-12', 'SWS2', 'SWS-2', 'LD35'], 'SWS3', 'PG-87', 'PG-99', 'PG-74', ['WZ-305', 'WZ305'], 'WZ-554',
        'LD-2000', 'LD-3000', 'FK-3000', 'CS/SA1', 'CS/SA5',
        ['HQ-2', 'HQ-2B', 'HQ-2J'], ['HQ-6', 'HQ-6A', 'HQ-6D'], ['HQ-7', 'HQ-7A', 'HQ-7B', 'FM-90'], ['HQ-9', 'HQ-9A', 'HQ-9B', 'HQ-9C', 'FD-2000'],
        ['HQ-10', 'HQ-10A'], 'HQ-11', ['HQ-12', 'KS-1A'], ['HQ-16', 'HQ-16A', 'HQ-16B', 'HQ-16C', 'LY-80'], ['HQ-17', 'HQ-17A', 'HQ-17AE'],
        'HQ-19', 'HQ-20', ['HQ-22', 'HQ-22A', 'FK-3'], 'HQ-29', 'HQ-61', ['HQ-64', 'LY-60'], ['Yitian', 'TY-90'], ['FB-10', 'FB-10A'],
        'QW-1', 'QW-2', 'QW-3', 'QW-4', 'QW-18', 'FN-6', 'FN-16', 'HN-5', 'HN-6', 'QN-202',
        ['OW5', 'OW5-A10', 'OW5-A50'], 'LY-1', ['Hurricane 3000', 'Hurricane-3000'],
        'JY-8', 'JY-9', 'JY-11', 'JY-14', 'JY-26', 'JY-27', ['JY-29', 'LSS-1'], 'JYL-1', 'JLG-43', 'YLC-2', 'YLC-4', 'YLC-6', 'YLC-8',
        'YLC-12', 'YLC-15', 'YLC-18', 'HT-233', 'H-200', 'SJ-231', 'SJ-202', ['LLQ120', 'Type 120 radar'], 'CLC-1', 'CLC-2', ['TR-47', 'TR47C']]),
    ...eqp('atgm', 'CN', [['HJ-73', 'HJ-73D', 'Red Arrow 73'], ['HJ-8', 'HJ-8E', 'AFT-8', 'Red Arrow 8'], 'HJ-9', ['HJ-10', 'AFT-10', 'Red Arrow 10'],
        ['HJ-11', 'AFT-11'], ['HJ-12', 'Red Arrow 12'], 'HJ-13', 'HJ-16', 'HJ-20', 'AFT-9', 'PF-89', 'PF-98', 'PF-11', 'PF-97', 'DZJ-08',
        'FHJ-01', 'FHJ-84', 'PF-78', 'PF-65', 'PF-56', 'PF-75', 'FPH-01', 'FPH-02', ['PTL-02', 'Type 02'], 'PTZ-89']),
    ...eqp('engineer', 'CN', [['WZ-621', 'WZ621'], 'GQL-110', 'GQL-111', 'GQL-120', 'GQL-321', 'GQL-410', 'GZM-003', 'GQC-003',
        'GCZ-110', 'GCZ-112', ['GPZ-111', 'GPZ-111A'], ['GSL-110', 'GSL-110A', 'GSL-110B'], ['GSL-111', 'WZ762A'], 'GSL-130', 'GSL-131',
        ['GSL-132', 'GBP-127'], 'GSL-133', 'GSL-134', 'GSL-211', ['GSL-411', 'GSL-241'], ['GSL-430', 'GBP-128'], 'GBP-126',
        ['GPJ221', 'GPJ-221'], ['ZRZ-100', 'ZRZ100'], 'GBL-120', 'GBL-130', 'GJW-320', 'GDG-130', 'Type 14']),
    ...eqp('logistics', 'CN', [['Shacman', 'SX2150', 'SX2190', 'SX2110', 'SX2220', 'SX2300', 'SX2306', 'HMV3'], ['Sinotruk', 'HOWO'],
        ['EQ2100', 'EQ2102', 'EQ245'], ['EQ2081', 'EQ240'], 'EQ1108', ['FAW MV3', 'MV3'], ['Taian', 'TA5450', 'TA4410', 'TA4360', 'TA5380'],
        ['Wanshan', 'WS580', 'WS2300', 'WS2400', 'WS2500', 'WS2600'], 'HY472', ['CA-141', 'CA141'], ['CA-30', 'CA30'], ['CA-10', 'CA10'],
        ['NJ-130', 'NJ130'], ['NJ-230', 'NJ230'], 'JY813', ['CWB-221', 'CWB221'], 'CSZ-181',
        'ZJX-93', ['WZ-653', 'WZ653', 'WZ653A'], 'VME-203', 'VME-102-40', 'Type 90-II ARV']),
    ...eqp('ew', 'CN', ['J-16D', 'J-15D', 'Y-8CA', 'Y-8CB', 'Y-8DZ', 'Y-8GX1', 'Y-8GX3', 'Y-8GX7', 'Y-8JB', 'Y-8EW', 'Y-9DZ', 'Y-9LG',
        ['DWL-002', 'DWL002'], 'CTL-181A EW']),
    ...eqp('air', 'CN', [['Z-8', 'Z-8L'], ['Z-9', 'Z-9W', 'Z-9WA', 'Z-9C'], ['Z-10', 'WZ-10', 'Z-10ME'], 'Z-11', 'Z-18', ['Z-19', 'WZ-19'],
        ['Z-20', 'Z-20T'], 'Z-21', ['H120', 'EC120'], 'SA342', 'S-70C2', ['J-10', 'J-10C'], 'J-11', 'J-15', 'J-16', 'J-20',
        ['J-35', 'J-35A'], 'J-7', ['J-8', 'J-8II'], 'Q-5', ['JH-7', 'JH-7A'], ['H-6', 'H-6K', 'H-6N', 'H-6J'], 'Y-5', 'Y-7', ['Y-8', 'Shaanxi Y-8'], ['Y-9', 'Shaanxi Y-9'],
        'Y-20', ['YY-20', 'YY-20A'], 'KJ-200', 'KJ-500', 'KJ-600', 'KJ-2000', 'CH-4', 'CH-5', 'KDV002',
        ['Wing Loong', 'GJ-1', 'GJ-2'], 'GJ-11', 'WZ-8']),
    ...eqp('light', 'CN', [['Mengshi', 'EQ2050', 'CSK-131'], 'CSK-141', 'CSK-181', ['CTL-181A', 'CTL181A'], ['BJ2022', 'Brave Warrior'],
        'BJ2020', 'BJ212', 'BJ80', ['NJ2045', 'NJ2046'], ['Lynx ATV', 'CS/VP16'], 'CS/VP4', 'CS/VP11', 'CS/VP15', 'CS/VP3', 'VP11',
        'VP22', ['VN3', 'CS/VN3'], 'VN4']),
    // Plain words, any army
    ...eqp('armor', '', [['tank', 'TANK', 'MBT']]),
    ...eqp('mech', '', [['IFV', 'IFV', 'APC', 'BMP', 'BMD', 'BTR', 'MRAP', 'ARMORED VEHICLE', 'ARMOURED VEHICLE']]),
    ...eqp('recon', '', [['recon', 'RECON', 'SCOUT', 'BRDM', 'UAV', 'UAS', 'DRONE', 'QUADCOPTER', 'UGV', 'MAVIC', 'DJI', 'MATRICE', 'AUTEL']]),
    ...eqp('fires', '', [['artillery', 'ARTILLERY', 'ARTY', 'HOWITZER', 'SPG', 'SP GUN', 'MORTAR', 'MLRS', 'MRL', 'ROCKET LAUNCHER'],
        ['FPV', 'FPV', 'LOITERING MUNITION', 'KAMIKAZE DRONE']]),
    ...eqp('ad', '', [['air defense', 'AIR DEFENSE', 'AIR DEFENCE', 'ADA', 'SAM', 'AAA', 'MANPADS']]),
    ...eqp('atgm', '', [['ATGM', 'ATGM', 'AT TEAM', 'RPG']]),
    ...eqp('engineer', '', [['engineer', 'ENGINEER', 'ENGINEERING', 'ENGR', 'ENG', 'SAPPER', 'CEV', 'BULLDOZER', 'DOZER', 'EXCAVATOR',
        'BACKHOE', 'BRIDGE', 'BRIDGE LAYER', 'AVLB', 'MINELAYER', 'MINE PLOW'], ['CBRN', 'CBRN', 'DECON', 'SMOKE GENERATOR']]),
    ...eqp('logistics', '', [['truck', 'TRUCK', 'LORRY', 'FUEL', 'FUELER', 'FUELLER', 'REFUELER', 'REFUELLER', 'TANKER', 'POL', 'CARGO',
        'AMMO', 'WATER', 'SUPPLY', 'SUPPORT', 'SPT', 'LOGPAC', 'WRECKER', 'TRAILER', 'RECOVERY VEHICLE'],
        ['ambulance', 'AMBULANCE', 'MEDEVAC']]),
    ...eqp('c2', '', [['command post', 'COMMAND POST', 'CP', 'HQ', 'C2', 'ANTENNA', 'RADIO RELAY', 'SATCOM']]),
    ...eqp('ew', '', [['jammer', 'JAMMER', 'EW', 'REB', 'ANTI-DRONE', 'DRONE GUN']]),
    ...eqp('air', '', [['helicopter', 'HELICOPTER', 'HELO', 'AIRCRAFT', 'JET']]),
    ...eqp('infantry', '', [['PAX', 'PAX', 'PERSONNEL', 'PERSON', 'PEOPLE', 'TROOP', 'SOLDIER', 'INFANTRY', 'DISMOUNT', 'MAN', 'MEN',
        'FIGHTER', 'SQUAD', 'TEAM', 'INDIVIDUAL']]),
    ...eqp('light', '', [['light vehicle', 'LIGHT VEHICLE', 'CAR', 'JEEP', 'PICKUP', 'SUV', 'TECHNICAL', 'MOTORCYCLE', 'MOTORBIKE', 'ATV', 'UTV', 'VAN', 'SEDAN',
        'BUGGY', 'QUAD BIKE', 'BUS']]),
    // A vehicle with no type given, as in MTI reports ("4x tracked"). The
    // longest word wins, so "engineer vic" is engineers and "support vic"
    // logistics; a vic, tracked or wheeled, with nothing more, comes here.
    ...eqp('vehicle', '', [['vehicle', 'VIC', 'VEHICLE', 'VEH'], ['tracked vehicle', 'TRACKED'], ['wheeled vehicle', 'WHEELED']]),
];
const normType = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
// Names to match, longest first so the most specific one wins.
const equipmentKeysOf = (entries) => entries.flatMap(([role, origin, name, ...more]) =>
    [...new Set([name, ...more])].map(k => {
        const words = normType(k), compact = words.replace(/ /g, '');
        const test = /\d/.test(compact)
            ? (w, c) => c.startsWith(compact) && !/\d/.test(c[compact.length] || '')
            : (w) => ` ${w} `.includes(` ${words} `);
        return { role, origin, name, len: compact.length, test };
    // The general vehicle words (vic, tracked, wheeled) come last, whatever
    // their length: "wheeled APC" is an APC, and only a bare vic is just a vehicle.
    })).filter(k => k.len).sort((a, b) => (a.role === 'vehicle') - (b.role === 'vehicle') || b.len - a.len);
let equipmentIndex = null;
const equipmentKeys = () => equipmentIndex || (equipmentIndex = equipmentKeysOf(EQUIPMENT_CATALOGUE));
const equipmentSeen = new Map();
const findKey = (keys, w) => {
    const hit = keys.find(k => k.test(w, w.replace(/ /g, '')));
    return hit ? { role: hit.role, origin: hit.origin, name: hit.name } : null;
};
// How much of a type as written the catalogue (and the team's entries,
// `team`, when given) knows: the length of the name it matches (TANK,
// MANPADS, RADIO RELAY), or 0.
const typesKnown = new Map();
const knownType = (text, team = null) => {
    const w = normType(text);
    if (!typesKnown.has(w)) {
        const hit = equipmentKeys().find(k => k.test(w, w.replace(/ /g, '')));
        typesKnown.set(w, hit ? hit.len : 0);
    }
    const own = team && team.length ? team.find(k => k.test(w, w.replace(/ /g, ''))) : null;
    return Math.max(typesKnown.get(w), own ? own.len : 0);
};
// { role, origin, name } for a type (T-72B3, 2S19 MSTA-S, trucks), or null.
// `team` is the team's own entries (teamEquipment), which win over the
// built-in ones: a type added, or a built-in one put right.
const lookupEquipment = (type, team = null) => {
    const w = normType(type);
    // "TANKS", "VICS": a plural that reaches here as it is (a team's type, a
    // BDA line) is tried as its singular (singularType, as the Statistics
    // fold it) when the whole doesn't match.
    const bareBy = (t) => { const one = normType(singularType(String(type || '').trim(), t)); return one && one !== w ? one : null; };
    const find = (keys, bare) => findKey(keys, w) || (bare ? findKey(keys, bare) : null);
    const own = team && team.length ? find(team, bareBy(team)) : null;
    if (own) return own;
    // The built-in answer doesn't depend on the team, so it is remembered.
    if (!equipmentSeen.has(w)) equipmentSeen.set(w, find(equipmentKeys(), bareBy(null)));
    return equipmentSeen.get(w);
};
// The team's entries ({ type, role, origin }), ready for lookupEquipment.
const teamEquipment = (list) => equipmentKeysOf((list || []).map(e => [e.role, e.origin || '', e.type]));

// Roughly what size of unit a count of one kind of system suggests, in US
// terms as an approximation of Russian and Chinese organization (a tank or
// BMP platoon is 3-4 vehicles, a company 10-14, a battalion 30-45; a gun
// battery 6-8; a squad 7-10). Always "approximately": strengths vary, and
// one report rarely sees a whole unit.
const ECHELONS = {
    maneuver: [[1, 'section'], [3, 'platoon'], [6, 'company (-)'], [10, 'company'], [16, 'company (+)'], [26, 'battalion'], [46, 'battalion (+)']],
    fires:    [[1, 'section'], [2, 'platoon'], [4, 'battery'], [9, 'battery (+)'], [15, 'battalion'], [25, 'battalion (+)']],
    ad:       [[1, 'section'], [2, 'platoon'], [5, 'battery'], [9, 'battalion']],
    infantry: [[1, 'team'], [5, 'squad'], [13, 'platoon'], [41, 'company'], [151, 'battalion']],
};
const ECHELON_KIND = { armor: 'maneuver', mech: 'maneuver', recon: 'maneuver', fires: 'fires', ad: 'ad', infantry: 'infantry' };
const ECHELON_LABEL = { maneuver: 'armor and mechanized', fires: 'artillery', ad: 'air defense', infantry: 'dismounted' };
const echelonOf = (kind, n) => {
    let e = null;
    for (const [min, name] of ECHELONS[kind] || []) if (n >= min) e = name;
    return e;
};

// The likelihood terms of ICD 203 (Analytic Standards), lowest to highest.
// Confidence (high, moderate, low) is said separately, never in the same
// sentence, as the standard asks.
const ICD203 = [
    ['almost no chance', '1-5%'], ['very unlikely', '5-20%'], ['unlikely', '20-45%'], ['roughly even chance', '45-55%'],
    ['likely', '55-80%'], ['very likely', '80-95%'], ['almost certain', '95-99%'],
];
const EVEN = 3, LIKELY = 4, VERY_LIKELY = 5;   // rules never claim more than very likely

// The built-in rules, which the team can switch off: [id, name, what it
// looks for, group]. Patterns from Russian and PLA tactics, as far as SALT
// reports can show them.
const NARRATIVE_RULES = [
    ['offense', 'Preparing an offensive', 'artillery, air defense moving, armor massing, engineers moving, EW, contact', 'Maneuver'],
    ['axes', 'Advance on several axes', 'armor or mechanized forces moving in two or more places within 6 hrs', 'Maneuver'],
    ['fixing', 'Fixing attack, main effort elsewhere', 'contact in one place while armor or mechanized forces move in another within 3 hrs', 'Maneuver'],
    ['forward', 'Forward detachment or advance guard', 'armor moving with artillery, air defense or engineers', 'Maneuver'],
    ['recon', 'Reconnaissance ahead of armor', 'reconnaissance or UAVs, then armor or mechanized forces within 6 hrs in the same place', 'Maneuver'],
    ['reconforce', 'Reconnaissance in force', 'a platoon or more firing, then pulling back within 3 hrs in the same place', 'Maneuver'],
    ['assembly', 'Assembly area', 'armor halted with supply or command vehicles, or resupplying', 'Maneuver'],
    ['reserve', 'Second echelon or reserve', 'armor halted in one place while there is contact in another', 'Maneuver'],
    ['firing', 'Probing or attacking', 'firing twice or more, or by a company or more', 'Maneuver'],
    ['dismount', 'Delivering an assault group', 'armored vehicles dropping infantry, then infantry moving or fighting within 2 hrs', 'Maneuver'],
    ['buildup', 'Infantry building up near the line', 'small dismounted groups halted or hiding in one place, three times or more in 48 hrs', 'Maneuver'],
    ['infiltration', 'Infiltration by small groups', 'small dismounted groups (or light vehicles) moving or observing, twice or more in 12 hrs', 'Maneuver'],
    ['lightassault', 'Assault on light vehicles', 'motorcycles, buggies or light vehicles moving or fighting, twice or more in 12 hrs', 'Maneuver'],
    ['urban', 'Assault groups in built-up areas', 'small dismounted groups fighting among buildings, with tanks, thermobaric weapons or artillery', 'Maneuver'],
    ['exploit', 'Exploiting a breakthrough', 'contact in one place, then armor moving through it and on into new places within 12 hrs', 'Maneuver'],
    ['encircle', 'Envelopment or encirclement', 'forces moving or fighting in three or more 10 km squares around one, or flanking reported', 'Maneuver'],
    ['pursuit', 'Pursuit', 'pursuit reported by armor, light vehicles or infantry', 'Maneuver'],
    ['counterattack', 'Counterattack', 'a counterattack reported, or armor arriving in a place after contact there', 'Maneuver'],
    ['withdrawal', 'Withdrawal', 'reports of withdrawing, retreating or breaking contact', 'Maneuver'],
    ['airassault', 'Air assault or airborne landing', 'transport helicopters, landings, airborne vehicles', 'Maneuver'],
    ['amphibious', 'Amphibious landing or crossing', 'amphibious vehicles or landings, with smoke, ferries or cover', 'Maneuver'],
    ['defense', 'Preparing a defense', 'digging in, obstacles or mines, engineers, antitank weapons, vehicles halted', 'Defense'],
    ['strongpoint', 'A company strongpoint', 'two of armor, infantry and antitank weapons holding in one place for 12 hrs or more', 'Defense'],
    ['fortline', 'A fortified line in depth', 'digging in, obstacles or engineers in three or more places within 48 hrs', 'Defense'],
    ['screen', 'Security zone or screen', 'reconnaissance or small groups halted or observing in two or more places within 6 hrs', 'Defense'],
    ['antitank', 'Antitank positions', 'antitank weapons in position, with obstacles or tanks in hides', 'Defense'],
    ['remotemine', 'Remote mining', 'minelaying systems or scatterable mines, with rockets or artillery', 'Defense'],
    ['deception', 'Camouflage and deception', 'decoys, dummies, camouflage or concealment reported', 'Defense'],
    ['artillery', 'Artillery preparation or fire strike', 'artillery or rocket fire twice or more in 3 hrs, then armor moving', 'Fires'],
    ['reconfire', 'UAVs spotting for artillery', 'UAVs, then artillery, shelling or loitering munitions within an hour in the same place', 'Fires'],
    ['isr', 'Persistent drone surveillance', 'UAVs over one place three times or more in 12 hrs, with no fire yet', 'Fires'],
    ['counterbattery', 'Counter-battery fire', 'counter-battery radar or fire, or drones striking guns, with artillery in the same place', 'Fires'],
    ['shootscoot', 'Shoot and scoot', 'artillery or rockets firing, then moving within the hour', 'Fires'],
    ['tankfire', 'Tanks as fire support', 'tanks firing from halted positions, with no armor advancing there', 'Fires'],
    ['thermobaric', 'Thermobaric fires', 'TOS launchers, Shmel or PF-97 flamethrowers, or thermobaric fire reported', 'Fires'],
    ['deep', 'Long-range strikes', 'long-range rockets or missiles (Iskander, Smerch, Tornado-S, PHL-16, DF-series)', 'Fires'],
    ['c2strike', 'Strikes on command and sensors', 'fires, missiles or drones striking command posts, radars or communications', 'Fires'],
    ['sead', 'Suppressing air defense', 'anti-radiation weapons, or strikes on radars and air defense', 'Fires'],
    ['drones', 'Loitering munitions and drones', 'loitering munitions, FPV or armed drones', 'Fires'],
    ['interdict', 'Drones cutting supply routes', 'drones or FPVs striking vehicles or roads in one place', 'Fires'],
    ['glidebomb', 'Glide bomb strikes', 'glide or guided bombs (KAB, FAB with UMPK, LS-6)', 'Fires'],
    ['aviation', 'Attack aviation', 'attack helicopters, ground-attack aircraft or armed UAVs', 'Fires'],
    ['crossing', 'River or gap crossing', 'bridging or ferries, smoke, air defense cover, armor waiting', 'Support'],
    ['breach', 'Breaching obstacles', 'mine clearing or breaching, smoke, fire support, armor nearby', 'Support'],
    ['cbrn', 'Chemical defense and smoke troops', 'chemical-defense vehicles, decontamination or smoke generators', 'Support'],
    ['cp', 'Command post', 'command vehicles or antennas, with air defense, EW or many vehicles halted', 'Support'],
    ['adsite', 'Air defense over a key site', 'air defense in place with command, artillery or supply vehicles', 'Support'],
    ['ew', 'Electronic warfare', 'EW systems, or jamming reported', 'Support'],
    ['logistics', 'A logistics point', 'supply vehicles halted or resupplying in one place, twice or more in 12 hrs', 'Support'],
    ['logforward', 'Logistics pushing forward', 'supply vehicles moving, twice or more in 12 hrs, while armor masses or with fuel and ammunition', 'Support'],
    ['railhead', 'A railhead or rail move', 'armor, artillery or supply vehicles on trains or at a railhead', 'Support'],
    ['droneresupply', 'Resupply by drone', 'drones dropping or carrying supplies', 'Support'],
    ['farp', 'Helicopter refueling point', 'helicopters on the ground with fuel or supply vehicles, or a FARP reported', 'Support'],
    ['casevac', 'Casualty evacuation', 'ambulances, MEDEVAC or wounded reported', 'Support'],
    ['regroup', 'Regrouping after an attack', 'armor or infantry halted, resupplying or recovering vehicles within 24 hrs after contact', 'Support'],
];
const RULE_ORDER = Object.fromEntries(NARRATIVE_RULES.map(([id], i) => [id, i]));

// What each pattern means in the doctrine of the army whose equipment was
// reported: Russian, or the PLA's. Open-source generalities (US Army ATP
// 7-100.1 and 7-100.3, TRADOC, RUSI, RAND and others, including Russian
// practice in Ukraine since 2022), said once under each judgment so a reader
// knows why it matters.
const DOCTRINE = {
    offense: {
        RU: 'Russian offensives typically open with reconnaissance, EW and an artillery preparation, with air defense moving forward under the main effort.',
        CN: 'PLA offensives open by closing the range: reconnaissance and a firepower strike with EW against command and sensors, then assault groups entangle and annihilate on a weak point.',
    },
    axes: {
        RU: 'Russian attacks pair a main effort with supporting attacks on other axes, to fix the defender and envelop.',
        CN: "PLA attacks follow 'one point, two sides': converging attacks on several axes, with fire to fix, concentrating on one point of penetration.",
    },
    fixing: {
        RU: 'Russian attacks often pair a fixing attack on one axis with the main effort on another, to pin defenders and draw in their reserves.',
        CN: "Under 'one point, two sides', PLA units fix the enemy with fire on supporting axes while massing on a single point of penetration.",
    },
    forward: {
        RU: 'A Russian forward detachment or advance guard moves ahead of the main body to seize key terrain; since 2023 it is often an armored group of a few tanks and BMPs carrying an assault group.',
        CN: 'PLA brigades push a vanguard or thrust maneuver group ahead of the main body to seize key terrain.',
    },
    recon: {
        RU: 'Russian forces lead with reconnaissance (razvedka): UAVs and a combat reconnaissance patrol ahead of the main body.',
        CN: 'PLA reconnaissance battalions (mounted scouts, battlefield surveillance and UAV companies) find targets ahead of the assault and its fires.',
    },
    reconforce: {
        RU: 'Russian forces conduct reconnaissance in force (razvedka boyem), attacking with a reinforced platoon or company to make defenders reveal their positions, then striking them with artillery.',
        CN: 'PLA units use reconnaissance in force and reconnaissance by fire to make defenders open fire and reveal positions for the follow-on firepower strike.',
    },
    assembly: {
        RU: 'Russian assault detachments and battalion groups assemble dispersed, in small groups and often in villages or tree lines, to refuel and rearm before moving to attack positions.',
        CN: 'PLA combined-arms battalions gather in assembly areas to refuel and organize assault groups before attacking.',
    },
    reserve: {
        RU: 'Russian forces fight in echelons: a second echelon or reserve is held back to exploit success or counterattack.',
        CN: 'PLA forces hold a reserve or second echelon to exploit a breakthrough or counterattack.',
    },
    firing: {
        RU: 'Russian forces probe continuously with small assault groups, often expendable infantry, to make defenders reveal their positions, which drones and artillery then strike.',
        CN: 'PLA forces probe with small assault elements to locate positions for fires before the main assault.',
    },
    dismount: {
        RU: 'A Russian armored group (bronegruppa, often a tank and a few BMPs) races assault infantry to a dismount point, then pulls back or supports them by fire.',
        CN: 'PLA infantry fighting vehicles carry assault teams to the dismount point, then support them with cannon and missile fire as they close.',
    },
    buildup: {
        RU: 'Russian assault infantry seep through the grey zone in twos and threes and gather in tree lines or buildings near the line until there are enough to assault.',
        CN: 'PLA light infantry close the range in small three-man teams and concentrate near a weak point before the assault.',
    },
    infiltration: {
        RU: 'Russian sabotage-reconnaissance groups (DRG) infiltrate in small teams to scout, mark targets and raid; since 2024 assault infantry also seep through gaps in twos and threes, often on motorcycles.',
        CN: 'PLA special operations and reconnaissance teams penetrate in small three-man groups to scout and designate targets.',
    },
    lightassault: {
        RU: 'Since 2024 Russian assault groups ride motorcycles, buggies and civilian vehicles in pairs and small groups to dash through the drone-covered grey zone.',
        CN: 'PLA light combined-arms battalions move on Mengshi light vehicles and all-terrain vehicles for fast, dispersed approaches and raids.',
    },
    urban: {
        RU: 'Russian forces take built-up areas building by building with small assault groups, supported by tanks, thermobaric weapons, artillery and drones.',
        CN: 'PLA urban assaults combine small infantry teams with UAVs, unmanned ground vehicles, smoke and breaching vehicles, clearing buildings from the top down.',
    },
    exploit: {
        RU: 'Russian commanders exploit a breach by pushing a fresh forward detachment or second echelon through it to strike rear areas before the defense recovers.',
        CN: 'PLA attacks commit depth-attack and thrust maneuver groups through the gap to envelop the defense and strike its rear.',
    },
    encircle: {
        RU: 'Russian operations favor envelopment and encirclement of strongpoints and towns, cutting supply routes with fire before closing the pocket (kotyol).',
        CN: 'PLA tactics aim to split and encircle the enemy and annihilate it in detail, bypassing strongpoints to isolate them.',
    },
    pursuit: {
        RU: 'Russian doctrine calls for parallel and frontal pursuit to stop a withdrawing enemy from occupying new positions.',
        CN: "PLA tactics stress the 'three ferocities', including fierce pursuit of a retreating enemy before it can reorganize.",
    },
    counterattack: {
        RU: 'Russian defenders counterattack quickly, often within hours and at platoon to company strength, with tanks and artillery, to retake lost positions before the attacker consolidates.',
        CN: 'PLA defenses keep an armor-heavy depth group to counterattack a penetration once it has been fixed in the annihilation zones.',
    },
    withdrawal: {
        RU: 'Russian withdrawals are covered by a rear guard, obstacles and artillery, often at night.',
        CN: 'PLA withdrawals are covered by a rear guard and obstacles while the main body breaks contact.',
    },
    airassault: {
        RU: 'Russian airborne (VDV) and air-assault forces land by helicopter or parachute to seize key terrain ahead of ground forces.',
        CN: "PLA army air-assault brigades land by helicopter (Z-8, Z-20) to seize key terrain or crossings; the Air Force's airborne corps drops by parachute.",
    },
    amphibious: {
        RU: 'Russian naval infantry and amphibious vehicles land, or cross water obstacles, under covering fire.',
        CN: 'PLA amphibious combined-arms brigades (ZBD-05, ZTD-05) land under covering fires, with smoke and EW.',
    },
    defense: {
        RU: 'Russian defenses are echeloned: a security zone, then company strongpoints behind dense, mixed minefields covered by fire sacks, with reserves held back to counterattack.',
        CN: 'PLA positional defenses put a frontier defense group forward and a depth defense group behind, with obstacles covering annihilation zones and an armor-heavy force to counterattack.',
    },
    strongpoint: {
        RU: 'The Russian defense is built from company strongpoints (opornyy punkt) holding all-round, linked by fire and obstacles rather than a continuous trench.',
        CN: 'PLA defenses hold strongpoints that cover each other and anchor the annihilation zones.',
    },
    fortline: {
        RU: 'Russian forces build fortified lines in depth (as on the Surovikin line) with tank ditches, dragon\'s teeth, wire, dense minefields and company strongpoints several kilometers apart.',
        CN: 'PLA positional defense is built in depth, with a frontier defense group forward and a depth defense group behind it in prepared positions.',
    },
    screen: {
        RU: 'Russian defenses push a security zone and forward positions ahead of the main defensive area to warn, delay and draw the attacker into prepared fire sacks.',
        CN: 'PLA defenses post security and disruption elements forward of the main positions to warn of, delay and fix the attacker before the annihilation zones.',
    },
    antitank: {
        RU: 'Russian defenses place ATGMs and tanks in prepared positions covering obstacles and likely armor approaches, forming fire sacks.',
        CN: 'PLA defenses site antitank missiles (HJ-series) in depth, covering obstacles, likely armor approaches and the annihilation zones.',
    },
    remotemine: {
        RU: 'Russian engineers lay minefields remotely (Zemledeliye, UMZ, artillery-scattered mines) to block counterattacks, seal flanks and close routes behind an enemy.',
        CN: 'PLA engineers lay rapid and scatterable minefields to block enemy maneuver and protect the flanks of an attack or defense.',
    },
    deception: {
        RU: 'Russian maskirovka uses inflatable and wooden decoys, thermal camouflage, decoy drones (Gerbera) and false positions to mislead about strength and intent.',
        CN: 'PLA deception combines camouflage, feints and false emissions to mislead about strength and intent.',
    },
    artillery: {
        RU: 'Russian attacks open with an artillery preparation or short, intense fire raids, now often with mortars, drones and glide bombs as well as guns.',
        CN: 'PLA attacks open with a fire preparation and fire assaults by rockets and artillery before the assault groups close.',
    },
    reconfire: {
        RU: 'Russian reconnaissance-fire complexes link UAVs to artillery and drones, putting fire on a target within minutes of finding it (the missile-armed operational version is the reconnaissance-strike complex).',
        CN: 'PLA reconnaissance-strike integration links UAVs and reconnaissance battalions directly to rockets and artillery.',
    },
    isr: {
        RU: 'Persistent Russian drone surveillance of one place usually means a target is being built up for artillery, glide bombs or an assault.',
        CN: 'Persistent PLA UAV surveillance builds the target picture that reconnaissance-strike integration needs before a firepower strike.',
    },
    counterbattery: {
        RU: 'Russian counter-battery fire uses Zoopark radars, UAVs and increasingly loitering munitions to find guns and strike them within minutes.',
        CN: 'PLA artillery battalions use target-acquisition radars (SLC-2) and UAVs to locate enemy guns for counter-battery fire as part of the firepower strike.',
    },
    shootscoot: {
        RU: 'Russian guns and rocket launchers fire from several positions, and on the move, then displace quickly to survive counter-battery fire ("roving" guns).',
        CN: 'PLA self-propelled guns and rocket batteries (PCL-181, PHL-16) fire autonomously and displace before counter-battery fire arrives.',
    },
    tankfire: {
        RU: 'Russian tanks are now used mostly as direct or indirect fire support from behind the line, and in armored groups, rather than to break through.',
        CN: 'PLA assault-gun and tank companies support assault groups by fire, engaging strongpoints from standoff before the infantry close.',
    },
    thermobaric: {
        RU: 'Russian RKhBZ troops fire TOS thermobaric rockets (and infantry fire RPO-A Shmel) against fortified positions and built-up areas, usually just before an assault.',
        CN: 'PLA chemical-defense units field flamethrowers and incendiary or thermobaric rocket launchers to destroy fortified positions during an assault.',
    },
    deep: {
        RU: 'Russian deep strikes (Iskander, long-range rockets) hit command posts, air defense and logistics in depth.',
        CN: "PLA long-range fires (the army's PHL-16 rockets, the Rocket Force's DF-series missiles) strike command, air defense and logistics as part of a joint fire strike.",
    },
    c2strike: {
        RU: 'Russian deep strikes and loitering munitions go after command posts, radars and communications nodes first, to blind and paralyze the defense.',
        CN: "PLA 'system destruction warfare' strikes command, communications and sensor nodes first to paralyze the enemy's operational system.",
    },
    sead: {
        RU: 'Russian forces hunt air defense with anti-radiation missiles, decoys, EW and Lancet strikes, often baiting radars to emit before striking.',
        CN: 'PLA fire strikes go after air-defense radars early, with anti-radiation loitering munitions (ASN-301), rockets and EW, as part of system destruction.',
    },
    drones: {
        RU: 'Russian forces use Lancet and Molniya loitering munitions and FPV drones, including fiber-optic FPVs that jamming cannot stop, against armor, artillery, air defense and supply routes.',
        CN: 'PLA forces field loitering munitions (CH-901, ASN-301), FPV drones and swarms, down to squad level.',
    },
    interdict: {
        RU: 'Russian drone units use fiber-optic and long-range FPVs to cut supply routes 15-20 km behind the line before an assault.',
        CN: 'PLA system destruction warfare targets logistics and the links between units, using reconnaissance-strike UAVs and rockets to isolate the battle area.',
    },
    glidebomb: {
        RU: 'Russian aircraft drop FAB and KAB bombs with UMPK glide kits from 40 to 70 km away to destroy strongpoints and villages just ahead of an assault.',
        CN: 'PLA aircraft carry satellite-guided glide bombs (LS-6) to strike fixed positions from outside short-range air defense.',
    },
    aviation: {
        RU: 'Russian attack helicopters and Su-25s fire rockets from standoff, often in lofted salvoes, while Su-34s drop glide bombs on positions ahead of an attack.',
        CN: 'PLA army aviation (Z-10, Z-19) supports ground attacks and air assaults.',
    },
    crossing: {
        RU: 'Russian river crossings use smoke, air defense cover and PMP or TMM bridging or PTS ferries.',
        CN: 'PLA gap crossings use smoke, air defense cover, bridging and amphibious vehicles.',
    },
    breach: {
        RU: 'Russian breaches use UR-77 line charges and tank mine plows (KMT-7/8) leading the column, smoke, and artillery suppressing the far side.',
        CN: 'PLA breaches use mine-clearing vehicles, line charges and smoke under suppressive fires.',
    },
    cbrn: {
        RU: 'Russian RKhBZ (radiation, chemical and biological protection) troops lay smoke to screen crossings, breaches and assaults, decontaminate, and operate the TOS launchers.',
        CN: 'PLA chemical-defense companies screen attacks, crossings and breaches with smoke (now also laid by UAVs) and decontaminate units.',
    },
    cp: {
        RU: 'Russian tactical command posts show command vehicles (R-149, R-145) and antennas near the line; higher headquarters sit further back in hardened buildings, wired to the civil telecom network.',
        CN: 'PLA command posts show command vehicles, antennas, generators and local air defense.',
    },
    adsite: {
        RU: 'Russian air defense covers command posts, artillery and logistics with short- and medium-range systems in layers.',
        CN: 'PLA air defense covers key sites with layered short- and medium-range systems.',
    },
    ew: {
        RU: 'Russian EW (Borisoglebsk-2, Leer-3, Krasukha) jams communications, GPS and drones, about one major system per 10 km of front, plus small trench and vehicle jammers protecting assault columns.',
        CN: "PLA electronic warfare targets command, communications and sensors early, as part of 'system destruction' warfare.",
    },
    logistics: {
        RU: 'Russian supply runs by rail to railheads, then by truck from materiel-technical support (MTO) units; forward points sit close behind the line, and the last kilometers are often by motorcycle or drone.',
        CN: "PLA combined-arms brigades are supplied by a service-support battalion, backed by the group army's service-support brigade, pushing fuel and ammunition forward.",
    },
    logforward: {
        RU: 'Russian ammunition and fuel moving forward from MTO units usually comes before an attack.',
        CN: 'PLA service-support battalions push fuel and ammunition forward to the combined-arms battalions just before and during an attack.',
    },
    railhead: {
        RU: 'Russian forces move and supply by rail to railheads near the front, then by truck; a railhead unloading armor or ammunition often signals a build-up.',
        CN: 'PLA brigades practice long moves by rail (as in the Stride exercises), so heavy equipment on trains signals a deployment.',
    },
    droneresupply: {
        RU: 'Russian forces resupply small infiltrated groups by drone when vehicles cannot reach them, a sign they mean to hold the ground they have seeped into.',
        CN: 'PLA units, notably the airborne corps, use cargo UAVs to resupply forward elements.',
    },
    farp: {
        RU: 'Russian attack helicopters work from forward refueling and rearming sites close behind the line, to fly repeated short sorties in support of an attack.',
        CN: 'PLA army aviation sets up temporary refueling and rearming points to keep attack helicopters close to the fight.',
    },
    casevac: {
        RU: 'Russian assault groups include evacuation teams; evacuation of wounded after an assault is a sign of heavy fighting, though it is often slow.',
        CN: 'PLA units evacuate wounded with armored ambulances and are trialing unmanned vehicles and heavy-lift drones for it.',
    },
    regroup: {
        RU: 'After a costly assault, Russian units pull back, recover vehicles (BREM), take replacements and attack again, often on the same axis within days.',
        CN: 'PLA units consolidate and reorganize after an assault, committing the reserve while the assault groups regroup.',
    },
};
const ARMIES = { RU: 'Russian', CN: 'Chinese' };

const HOUR = 3600000;
const OBSTACLE = /\b(obstacles?|mines?|minefields?|wire|berms?|ditch(es)?|abatis|tank traps?|dragon'?s teeth|trench(es)?|pyramids|hedgehogs|concrete blocks?)\b/i;
const WITHDRAW = /\b(withdraw(s|n|ing|al)?|retreat(s|ed|ing)?|pull(s|ed|ing)? back|fall(s|ing)? back|fell back|break(s|ing)? contact|disengag(e|es|ed|ing))\b/i;

// How a type reads in the narrative, in the reports' own style: a designation
// as reported (15x T-72, 6x PAX), a plain word in lower case and plural
// (31x trucks).
const TYPE_ACRONYMS = new Set(['PAX', 'IFV', 'APC', 'MBT', 'BMP', 'BTR', 'BRDM', 'SAM', 'ADA', 'AAA', 'MANPADS', 'UAV', 'UAS',
    'ATGM', 'MLRS', 'MRL', 'SPG', 'AVLB', 'POL', 'CP', 'HQ', 'C2', 'EW', 'ATV', 'UTV', 'SUV', 'ATZ']);
const NO_PLURAL = new Set(['personnel', 'people', 'men', 'infantry', 'ammo', 'fuel', 'water', 'cargo', 'artillery', 'arty', 'recon', 'supply']);
const PLURALS = { man: 'men', person: 'people' };
// A bare "tracked" or "wheeled" reads as the vehicle it describes.
const BARE_ADJECTIVE = new Set(['TRACKED', 'WHEELED']);
const typeCount = (type, n, kit) => {
    if (!kit || kit.origin || /\d/.test(type) || TYPE_ACRONYMS.has(type)) return `${n}x ${type}`;
    const words = (BARE_ADJECTIVE.has(type) ? kit.name : type).toLowerCase().split(' '), last = words.pop();
    const many = n === 1 || NO_PLURAL.has(last) ? last
        : PLURALS[last] || (/(s|x|z|ch|sh)$/.test(last) ? `${last}es` : last.replace(/([^aeiou])y$/, '$1ie') + 's');
    return `${n}x ${[...words, many].join(' ')}`;
};

// What the narrative needs about a report, beyond the summaries' facts: its
// equipment, the roles in it, its size by kind, and the areas it counts in
// (its NAIs and OBJs, else its 10 km square, else none).
const narrativeFacts = (f, team) => {
    const els = sizeElements(f.r.size, team).map(e => ({ ...e, kit: lookupEquipment(e.type, team) }));
    const groups = {};
    els.forEach(e => { const k = e.kit && ECHELON_KIND[e.kit.role]; if (k) groups[k] = (groups[k] || 0) + e.count; });
    const sq = f.a.points.length ? gridSquare(f.a.points[0].mgrs, 1) : null;
    return {
        ...f, els, groups,
        roles: new Set(els.filter(e => e.kit).map(e => e.kit.role)),
        areas: f.places.length ? f.places : sq ? [sq.replace(/ (\d) (\d)$/, ' $1$2')] : [],
        id: f.r.displayId || f.r.id || '',
        who: (f.r.user && f.r.user.initials) || '',
    };
};
const isManeuver = (f) => f.roles.has('armor') || f.roles.has('mech');
const byTime = (list) => [...new Set(list)].sort((x, y) => x.ms - y.ms || x.id.localeCompare(y.id));
// The most reports among `list` (in time order) inside any `span` of time.
const densest = (list, span) => {
    let best = [];
    list.forEach((f, i) => { const w = list.slice(i).filter(g => g.ms - f.ms <= span); if (w.length > best.length) best = w; });
    return best;
};

// Lines of at most `width`, the first starting with `first`, the rest with `rest`.
const wrapText = (text, first, rest = first, width = 100) => {
    const lines = [];
    let line = first;
    String(text).split(' ').forEach(w => {
        if (line.trim() && (line + w).length > width) { lines.push(line.trimEnd()); line = rest; }
        line += `${w} `;
    });
    lines.push(line.trimEnd());
    return lines;
};

// A team rule's words ("bridge, ferry, PMP") as one whole-word pattern.
const ruleWords = (words) => new RegExp(`\\b(${String(words).split(',').map(w => w.trim()).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

// What some equipment can do, by catalogue name, and the words in a report
// that say the same ("bridging", "jamming").
const capability = (names, words) => ({ names: new Set(names), words });
const ATTACK_HELOS = ['Mi-24', 'Mi-35', 'Mi-28', 'Ka-50', 'Ka-52', 'Z-10', 'Z-19', 'Z-21'];
const LIFT_HELOS = ['Mi-8', 'Mi-17', 'Mi-26', 'Ka-29', 'Z-8', 'Z-18', 'Z-20', 'S-70C2'];
const CAPABILITIES = {
    uav: capability(['Orlan-10', 'Zala', 'Eleron-3', 'Forpost', 'Granat', 'Takhion', 'Supercam', 'Merlin-VR', 'ASN-206', 'ASN-207', 'ASN-209',
        'BZK-005', 'BZK-006', 'BZK-007', 'BZK-008', 'BZK-009', 'WZ-7', 'TB-001', 'CH-3'],
    /\b(uavs?|uas|drones?|quadcopters?|mavic|dji)\b/i),
    cbRadar: capability(['1L219', '1L271', '1L227', 'ARK-1', '1B75', 'AZK-7', 'SLC-2', 'Type 704'], /\bcounter[- ]?(battery|fire)\b/i),
    mrl: capability(['BM-21', '2B26', 'BM-27', '9K512', 'BM-30', 'Tornado-G', 'Tornado-S', 'Tornado', '9K59', 'TOS-1', 'TOS-2', 'TOS-3',
        'PHL-03', 'PHL-16', 'PHL-11', 'PHZ-11', 'PHZ-89', 'PHL-81', 'PHL-90', 'PHL-20', 'PHL-21', 'PH-63', 'WZ-303', 'AR-1', 'AR-2', 'AR-3',
        'SR-5', 'WS-1', 'WS-2', 'WS-3', 'WS-22', 'WS-32', 'WS-33', 'WS-35', 'SY-300', 'SY-400', 'A-200', 'A-300', 'WM-40', 'WM-80'],
    /\b(mlrs|mrl|rocket launchers?)\b/i),
    deep: capability(['BM-27', '9K512', 'BM-30', 'Tornado-S', 'Iskander', 'Tochka', 'Luna-M', 'K-300P', 'Kalibr', 'Kh-59', 'Kh-101', 'Kh-22',
        'Kh-32', 'Kinzhal', 'PHL-03', 'PHL-16', 'AR-1', 'AR-3', 'WS-2', 'WS-3', 'SY-400', 'WS-600L', 'DF-11', 'DF-12', 'DF-15', 'DF-16',
        'DF-17', 'DF-21', 'DF-26', 'DF-27', 'CJ-10', 'CJ-100', 'CJ-1000'], /\b(ballistic missiles?|cruise missiles?|missile launch\w*|tels?)\b/i),
    thermobaric: capability(['TOS-1', 'TOS-2', 'TOS-3', 'BMO-T', 'RPO-A', 'MRO-A', 'RShG-1', 'RShG-2', 'PF-97', 'FHJ-01', 'FHJ-84', 'FPH-01', 'FPH-02'],
        /\b(thermobaric|flamethrowers?|shmel)\b/i),
    loitering: capability(['Lancet', 'Geran-2', 'Kub-BLA', 'Gerbera', 'Garpiya', 'Italmas', 'Molniya', 'KVN', 'VT-40', 'Skalpel', 'FPV',
        'CH-901', 'ASN-301', 'CM-501XA', 'WS-43'], /\b(loitering|kamikaze|fpvs?|one[- ]way attack|fib(er|re)[- ]?optic)\b/i),
    // Aircraft, rotary-wing apart from fixed-wing: only helicopters fly from
    // a FARP or carry an air assault. Attack aviation is either, and armed UAVs.
    attackHelo: capability(ATTACK_HELOS, /\b(gunships?|attack helicopters?)\b/i),
    liftHelo: capability(LIFT_HELOS, /\b(transport helicopters?|lift helicopters?)\b/i),
    helo: capability([...ATTACK_HELOS, ...LIFT_HELOS, 'Mi-2', 'Ka-226', 'Ka-27', 'Ansat', 'Z-9', 'Z-11', 'H120', 'SA342'],
        /\b(helicopters?|helos?|gunships?)\b/i),
    attackAir: capability([...ATTACK_HELOS, 'Su-24', 'Su-25', 'Su-34', 'Yak-130', 'JH-7',
        'CH-4', 'CH-5', 'KDV002', 'Wing Loong', 'GJ-11', 'Orion', 'Forpost-R', 'Okhotnik', 'Altius'],
    /\b(gunships?|attack helicopters?|close air support|air ?strikes?)\b/i),
    vdv: capability(['BMD-1', 'BMD-2', 'BMD-3', 'BMD-4', 'BTR-D', 'BTR-MD', 'BTR-ZD', 'BTR-RD', '2S9', '2S25', '2S42', 'ZBD-03'], /\b(vdv|paratroop\w*)\b/i),
    airlanding: capability([], /\b(air ?assault|airborne landing|heliborne|landing zone|lz|parachut\w*|air ?drop\w*|landed by helicopter)\b/i),
    amphibious: capability(['ZBD-05', 'ZTD-05', 'ZSD-05', 'Type 63A', 'PT-76', 'K-61'], /\b(amphibious|beach(ed|ing)?|landing craft|naval infantry|marines?|swimming)\b/i),
    bridging: capability(['MTU-20', 'MTU-72', 'MTU-90', 'MT-55', 'TMM', 'PMP', 'PP-91', 'PP-2005', 'PPS-84', 'PMM-2', 'GSP', 'PTS',
        'WZ-621', 'GQL-110', 'GQL-111', 'GQL-120', 'GQL-321', 'GQL-410', 'GZM-003', 'GQC-003'],
    /\b(bridg\w*|ferr(y|ies|ying)|pontoons?|fording|ford)\b/i),
    breaching: capability(['UR-77', 'UR-67', 'UR-07', 'BMR-3', 'KMT-7', 'KMT-8', 'IMR-2', 'IMR-3', 'Uran-6', 'Prokhod-1', 'GCZ-110', 'GCZ-112',
        'GPZ-111', 'GSL-110', 'GSL-111', 'GSL-130', 'GSL-131', 'GSL-132', 'GSL-133', 'GSL-134', 'GSL-211', 'GSL-411', 'GSL-430', 'GBP-126', 'GPJ221'],
    /\b(breach\w*|mine[- ]?clear\w*|clearing (mines|obstacles|a lane)|demining|miclic|line charges?)\b/i),
    minelaying: capability(['GMZ-3', 'PMZ-4', 'UMZ', 'Zemledeliye', 'GBL-120', 'GBL-130'],
        /\b(minelay\w*|laying mines|scatter(able|ed) mines?|remote(ly)?[- ](laid |delivered )?min(es?|ing)|cluster mines?|pfm-1|ptm-\d|pom-\d)\b/i),
    cbrn: capability(['RKhM-4', 'RKhM-6', 'RPM-2', 'BRDM-2RKh', 'TMS-65', 'ARS-14', 'UTM-80M', 'TDA-2K', 'TDA-3', 'MRK-46', 'Type 14', 'CBRN'],
        /\b(rkhbz|chemical (defen[cs]e|troops|recon\w*)|decontaminat\w*|decon|cbrn|nbc|smoke (generators?|screens?|pots?))\b/i),
    sead: capability(['ASN-301', 'Kh-31', 'Kh-58'], /\b(anti-?radiation|sead|(radars?|sams?|air defen[cs]e) (struck|hit|destroyed))\b/i),
    glideBomb: capability(['UMPK', 'FAB-500', 'KAB-500', 'LS-6'], /\b(glide bombs?|guided bombs?|kabs?|fabs?|umpk|aerial bombs?)\b/i),
    recovery: capability(['BREM', 'BREM-L', 'BREM-K', 'BREM-D', 'BREM-80U', 'REM-KL', 'REM-KS', 'BTS-2', 'BTS-4', 'ZJX-93', 'WZ-653', 'VME-203',
        'VME-102-40', 'Type 90-II ARV'], /\b(recover(y|ing|ed)|tow(ed|ing)|arvs?|wrecker)\b/i),
    medevac: capability(['BMM-80', 'Linza', 'CSZ-181', 'ambulance'],
        /\b(casevac|medevac|ambulances?|stretchers?|wounded|casualt(y|ies)|evacuat\w* (the )?(wounded|casualties|injured))\b/i),
    c2: capability([], /\b(command posts?|headquarters|antennas?|radio masts?|generators?)\b/i),
    ew: capability([], /\b(jam(s|med|ming|mers?)?|interference|spoof\w*|gps (denied|jammed|loss|lost)|direction finding)\b/i),
    deception: capability(['Gerbera'], /\b(decoys?|dumm(y|ies)|inflatables?|mock[- ]?ups?|fakes?|camouflag\w*|camo|netting|concealed|maskirovka|thermal (blankets?|capes?|camouflage))\b/i),
    smoke: capability(['TDA-2K', 'TDA-3'], /\bsmoke\b/i),
    atPosition: capability([], /\b(at (ambush|positions?)|atgm (team|positions?)|antitank positions?|ambush\w*)\b/i),
};
const textOf = (f) => `${f.r.size || ''} ${f.r.activity || ''}`;
const can = (f, cap) => f.els.some(e => e.kit && CAPABILITIES[cap].names.has(e.kit.name)) || CAPABILITIES[cap].words.test(textOf(f));
// Firing words that aren't contact are NOT_CONTACT, with the activity tags.
const FIRING_WORDS = ACTIVITY_TAGS.find(([t]) => t === 'Firing')[1];
// Words some rules look for in a report.
const LIGHT_WORDS = /\b(motorcycles?|motorbikes?|dirt ?bikes?|buggies|buggy|atvs?|quads?|quad bikes?|utvs?|scooters?|civilian (cars?|vans?|vehicles?))\b/i;
const URBAN = /\b(towns?|villages?|buildings?|houses?|streets?|urban|basements?|high-?rises?|apartments?|city|cities)\b/i;
const FLANK = /\b(flank\w*|envelop\w*|encircl\w*|surround\w*|pincers?|bypass\w*|cut(ting)? off|kotel|kotyol|cauldron)\b/i;
const RAIL = /\b(rail\w*|trains?|flatcars?|wagons?)\b/i;
const DRONE_DROP = /\b(drones?|uavs?|quadcopters?)\b.{0,30}\b(drop\w*|deliver\w*|resuppl\w*|supplies|carr(y|ies|ying))\b/i;
const FARP = /\b(farps?|forward (arming|refuel\w*)|helipads?|landing sites?)\b/i;
const C2_TARGETS = /\b(command posts?|headquarters|hq|radars?|antennas?|relays?|comms|communications|starlink)\b/i;
const ROUTES = /\b(roads?|routes?|msr|asr|supply|convoys?|vehicles?|trucks?|logistics|bridges?|crossings?)\b/i;
const STRUCK = /\b(struck|strikes?|striking|hit|hits|destroyed)\b/i;
const INDIRECT = /\b(indirect|closed positions?|from (a )?distance|long range|hull[- ]down)\b/i;
const FUEL_AMMO = /\b(fuel|tankers?|pol|ammo|ammunition|atz)\b/i;
const GATHER = /\b(tree ?lines?|gather\w*|accumulat\w*|massing|basements?|hiding|hidden)\b/i;
const PURSUIT = /\b(pursu\w*|chasing)\b/i;
const COUNTER = /\b(counter[- ]?attack\w*|retook|retaking|recaptur\w*)\b/i;
const SCOOT = /\b(displac\w*|relocat\w*|reposition\w*|shoot and scoot|roving)\b/i;
// A 10 km square as the narrative names it (11S NV 31): zone and square, easting and northing digit.
const SQUARE = /^(\d{1,2}[C-X] [A-Z]{2}) (\d)(\d)$/;
const SHELLING = /\b(shelling|shelled|barrage|fire missions?|impacts?|incoming|artillery fire|rocket fire|indirect fire)\b/i;
const has = (f, ...tags) => tags.some(t => f.act.tags.includes(t));
const levelBy = (n, likely, veryLikely) => (n >= veryLikely ? VERY_LIKELY : n >= likely ? LIKELY : EVEN);
const kindsOf = (signs) => signs.filter(([, l]) => l.length).length;
// The place most of some reports are in.
const mostIn = (list) => {
    const n = new Map();
    list.forEach(f => f.areas.forEach(a => n.set(a, (n.get(a) || 0) + 1)));
    return [...n].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] || null;
};

// The judgments the reports support: each with its ICD 203 level, what is
// judged (said of the enemy or a unit: "are preparing a defense in NAI 1";
// some say it in the terms of the army whose equipment it is: { RU, CN, '' }),
// the places it is about, the signs seen (and the reports behind them), and
// the signs that would make it firmer. Every rule looks only at the reports
// given; rules in `off` are skipped, and the team's `custom` rules run too.
const narrativeJudgments = (facts, cite, { off = new Set(), custom = [] } = {}) => {
    const out = [];
    const byArea = new Map();
    facts.forEach(f => f.areas.forEach(a => { if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(f); }));
    const on = (rule) => !off.has(rule);
    const judge = (rule, level, what, signs, places = null) => {
        const seen = signs.filter(([, l]) => l.length);
        const list = byTime(seen.flatMap(([, l]) => l));
        out.push({
            rule, order: RULE_ORDER[rule] ?? NARRATIVE_RULES.length, level: Math.min(level, VERY_LIKELY), what,
            key: typeof what === 'string' ? what : what[''],
            places: places || [...new Set(list.flatMap(f => f.areas))],
            basis: seen.map(([s, l]) => `${s} (${cite(l)})`).join('; '),
            list, watch: signs.filter(([, l]) => !l.length).map(([s]) => s),
        });
    };
    // Contact: firing words that aren't about fire support or a firing position.
    const shot = (f) => has(f, 'Firing') && FIRING_WORDS.test(String(f.r.activity || '').replace(NOT_CONTACT, ' '));
    // Moving, but not away: a withdrawal isn't an advance.
    const advancing = (f) => has(f, 'Moving') && !WITHDRAW.test(f.r.activity || '');
    const after = (list, f, span) => list.some(e => f.ms > e.ms && f.ms - e.ms <= span);
    const firing = (f) => (f.roles.has('fires') && shot(f)) || SHELLING.test(f.r.activity || '');
    const ewOf = (f) => f.roles.has('ew') || can(f, 'ew');
    // A small dismounted group: up to 12 people, on foot or in light vehicles, with antitank weapons at most.
    const smallGroup = (f) => f.roles.size > 0 && [...f.roles].every(r => r === 'infantry' || r === 'atgm' || r === 'light')
        && (f.groups.infantry || 0) > 0 && (f.groups.infantry || 0) <= 12;

    for (const [area, list] of byArea) {
        const at = (test) => list.filter(test);
        const smoke = at(f => can(f, 'smoke'));
        const obst = at(f => OBSTACLE.test(f.r.activity || '') || can(f, 'minelaying'));
        const atgm = at(f => (f.roles.has('atgm') && has(f, 'Stationary', 'Emplacing', 'Observing')) || can(f, 'atPosition'));
        // Preparing a defense: digging in, obstacles, engineers, antitank weapons, vehicles holding.
        const dig = at(f => has(f, 'Emplacing') && !OBSTACLE.test(f.r.activity || ''));
        if (on('defense') && (dig.length || obst.length)) {
            const signs = [
                ['digging in or fortifying', dig], ['obstacles or mines', obst],
                ['engineer equipment', at(f => f.roles.has('engineer'))], ['antitank weapons in position', atgm],
                ['combat vehicles halted in position', at(f => has(f, 'Stationary') && (isManeuver(f) || f.roles.has('fires') || f.roles.has('ad')))],
            ];
            const kinds = kindsOf(signs), n = byTime(signs.flatMap(([, l]) => l)).length;
            judge('defense', kinds >= 3 && n >= 4 ? VERY_LIKELY : kinds >= 2 || n >= 3 ? LIKELY : EVEN,
                `are preparing a defense in ${area}`, signs, [area]);
        }
        // Antitank positions: ATGMs set up, covering obstacles, tanks in hides.
        if (on('antitank') && atgm.length) {
            const tanks = at(f => f.roles.has('armor') && has(f, 'Stationary'));
            judge('antitank', EVEN + (atgm.length >= 2 ? 1 : 0) + (obst.length || tanks.length ? 1 : 0), `have antitank positions in ${area}`,
                [['antitank weapons in position', atgm], ['obstacles or mines they cover', obst], ['tanks in hide positions', tanks]], [area]);
        }
        // Reconnaissance, then armor or mechanized forces within 6 hours.
        const scouts = at(f => f.roles.has('recon') || has(f, 'Observing') || can(f, 'uav'));
        const pairs = scouts.map(s => [s, list.filter(m => m !== s && isManeuver(m) && m.ms > s.ms && m.ms - s.ms <= 6 * HOUR)]).filter(([, l]) => l.length);
        if (on('recon') && pairs.length) {
            const lead = byTime(pairs.map(([s]) => s)), after = byTime(pairs.flatMap(([, l]) => l));
            const support = at(f => f.roles.has('fires') || f.roles.has('ad') || f.roles.has('engineer'));
            judge('recon', EVEN + (lead.length >= 2 || after.length >= 2 ? 1 : 0) + (support.length ? 1 : 0),
                `are scouting a route through ${area} for armor or mechanized forces`,
                [['reconnaissance', lead], ['armor or mechanized forces within 6 hrs after it', after],
                    ['artillery, air defense or engineers in the same area', support]], [area]);
        }
        // UAVs, then artillery within the hour: a reconnaissance-fire (or -strike) link.
        const uavs = at(f => can(f, 'uav'));
        const fireAfter = at(f => (firing(f) || can(f, 'loitering')) && uavs.some(u => u !== f && f.ms >= u.ms && f.ms - u.ms <= HOUR));
        if (on('reconfire') && uavs.length && fireAfter.length) {
            const radar = at(f => can(f, 'cbRadar'));
            judge('reconfire', EVEN + (uavs.length >= 2 ? 1 : 0) + (radar.length || fireAfter.length >= 2 ? 1 : 0), {
                RU: `are spotting for artillery with UAVs over ${area} (a reconnaissance-fire complex)`,
                CN: `are spotting for rockets and artillery with UAVs over ${area} (reconnaissance-strike)`,
                '': `are spotting for artillery with UAVs over ${area}`,
            }, [['UAVs overhead', uavs], ['artillery, shelling or loitering munitions within an hour after', fireAfter], ['counter-battery radar', radar]], [area]);
        }
        // An assembly area: armor halted with supply or command vehicles.
        const still = densest(at(f => isManeuver(f) && has(f, 'Stationary')), 12 * HOUR);
        const backing = at(f => f.roles.has('logistics') || f.roles.has('c2') || has(f, 'Resupplying'));
        if (on('assembly') && still.length >= 2 && backing.length) {
            const signs = [['armor or mechanized forces halted', still], ['supply or command vehicles, or resupply', backing],
                ['artillery or air defense with them', at(f => (f.roles.has('fires') || f.roles.has('ad')) && has(f, 'Stationary'))]];
            judge('assembly', levelBy(kindsOf(signs) + (still.length >= 5 ? 1 : 0), 3, 4), {
                RU: `are in an assembly area in ${area}, preparing to attack (an assault detachment's assembly area)`,
                CN: `are in an assembly area in ${area}, preparing to attack (combined-arms battalions forming assault groups)`,
                '': `are in an assembly area in ${area}, preparing to attack`,
            }, signs, [area]);
        }
        // A combined-arms group on the move: armor with artillery, air defense or engineers within 2 hours.
        const movers = at(f => isManeuver(f) && advancing(f));
        const escorts = at(f => (f.roles.has('fires') || f.roles.has('ad') || f.roles.has('engineer')) && advancing(f)
            && movers.some(m => Math.abs(m.ms - f.ms) <= 2 * HOUR));
        if (on('forward') && escorts.length) {
            const alongside = movers.filter(m => escorts.some(e => Math.abs(m.ms - e.ms) <= 2 * HOUR));
            const big = Math.max(...alongside.map(m => m.groups.maneuver || 0), 0) >= 10 || alongside.length >= 3;
            judge('forward', EVEN + (big ? 1 : 0), {
                RU: `are moving a combined-arms group through ${area}, possibly a forward detachment or advance guard`,
                CN: `are moving a combined-arms group through ${area}, possibly a vanguard ahead of the main body`,
                '': `are moving a combined-arms group through ${area}`,
            }, [['armor or mechanized forces moving', alongside], ['artillery, air defense or engineers moving with them', escorts]], [area]);
        }
        // A water obstacle or gap: bridging or ferries, smoke, cover, armor waiting.
        const bridge = at(f => can(f, 'bridging'));
        if (on('crossing') && bridge.length) {
            const signs = [['bridging or ferry equipment, or a crossing reported', bridge], ['smoke', smoke],
                ['air defense covering it', at(f => f.roles.has('ad'))], ['armor or mechanized forces waiting', at(f => isManeuver(f) && has(f, 'Stationary'))],
                ['amphibious vehicles', at(f => can(f, 'amphibious'))]];
            judge('crossing', levelBy(kindsOf(signs), 2, 3), `are preparing to cross a water obstacle or gap in ${area}`, signs, [area]);
        }
        // A breach: mine clearing, smoke, fire support, armor nearby.
        const breach = at(f => can(f, 'breaching'));
        if (on('breach') && breach.length) {
            const signs = [['mine clearing or breaching equipment, or a breach reported', breach], ['smoke', smoke],
                ['thermobaric weapons or artillery fire', at(f => can(f, 'thermobaric') || firing(f))], ['armor or mechanized forces nearby', at(isManeuver)]];
            judge('breach', levelBy(kindsOf(signs), 2, 3), `are preparing to breach obstacles in ${area}`, signs, [area]);
        }
        // A command post: command vehicles or antennas, with air defense, EW or many vehicles halted.
        const c2 = at(f => f.roles.has('c2') || can(f, 'c2'));
        const adStill = at(f => f.roles.has('ad') && has(f, 'Stationary'));
        if (on('cp') && c2.length) {
            const halted = at(f => has(f, 'Stationary'));
            const signs = [['command vehicles, antennas or a command post reported', c2], ['air defense in place', adStill],
                ['electronic warfare', at(ewOf)], ['three or more vehicles halted there', halted.length >= 3 ? halted : []]];
            judge('cp', levelBy(kindsOf(signs), 2, 3), `have a command post in ${area}`, signs, [area]);
        }
        // Air defense over a key site: in place with command, artillery or supply vehicles.
        const sites = at(f => has(f, 'Stationary') && (f.roles.has('c2') || f.roles.has('fires') || f.roles.has('logistics')));
        if (on('adsite') && adStill.length && sites.length) {
            judge('adsite', EVEN + (adStill.length >= 2 ? 1 : 0) + (sites.length >= 2 ? 1 : 0), `are protecting a key site in ${area} with air defense`,
                [['air defense in place', adStill], ['command, artillery or supply vehicles in place', sites]], [area]);
        }
        // Deception: decoys, dummies, camouflage.
        const dec = at(f => can(f, 'deception'));
        if (on('deception') && dec.length) {
            judge('deception', levelBy(dec.length, 2, 3), {
                RU: `are using camouflage and deception (maskirovka) in ${area}`, CN: `are using camouflage and deception in ${area}`,
                '': `are using camouflage and deception in ${area}`,
            }, [['decoys, dummies, camouflage or concealment reported', dec], ['the force the decoys stand in for, concealed nearby', []]], [area]);
        }
        // Amphibious: amphibious vehicles or landings, with smoke, ferries or cover.
        const amph = at(f => can(f, 'amphibious'));
        if (on('amphibious') && amph.length) {
            const signs = [['amphibious vehicles or a landing reported', amph], ['smoke', smoke], ['bridging or ferries', bridge],
                ['air defense or artillery covering', at(f => f.roles.has('ad') || f.roles.has('fires'))]];
            judge('amphibious', levelBy(kindsOf(signs), 2, 3), `are preparing or conducting an amphibious landing or crossing near ${area}`, signs, [area]);
        }
        // Air assault: transport helicopters or landings, with airborne vehicles or escorts.
        // Transport aircraft (Il-76, Y-20) alone are not one: they fly supplies too.
        const lift = at(f => can(f, 'liftHelo')), landing = at(f => can(f, 'airlanding'));
        if (on('airassault') && (lift.length || landing.length)) {
            const signs = [['transport helicopters', lift], ['an air assault or landing reported', landing],
                ['airborne (VDV) vehicles or paratroopers', at(f => can(f, 'vdv'))], ['attack helicopters escorting', at(f => can(f, 'attackHelo'))]];
            judge('airassault', levelBy(kindsOf(signs), 2, 3), {
                RU: `are conducting or preparing an air assault or airborne landing near ${area} (VDV or air-assault forces)`,
                CN: `are conducting or preparing an air assault near ${area} (an air-assault brigade)`,
                '': `are conducting or preparing an air assault near ${area}`,
            }, signs, [area]);
        }
        // A logistics site: supply vehicles halted or resupplying, again and again.
        const supply = densest(at(f => (f.roles.has('logistics') && has(f, 'Stationary')) || has(f, 'Resupplying')), 12 * HOUR);
        if (on('logistics') && supply.length >= 2) {
            judge('logistics', supply.length >= 5 ? VERY_LIKELY : supply.length >= 3 ? LIKELY : EVEN,
                `have a logistics or resupply point in ${area}`,
                [['supply vehicles halted or resupplying within 12 hrs', supply],
                    ['fuel or ammunition vehicles', supply.filter(f => /\b(fuel|tanker|pol|ammo|ammunition|atz)\b/i.test(textOf(f)))]], [area]);
        }
        // Counter-battery: radar or counter-battery fire, or drones on guns, with artillery here.
        const cb = at(f => can(f, 'cbRadar'));
        const onGuns = at(f => can(f, 'loitering') && /\b(howitzers?|guns?|batter(y|ies)|artillery|mortars?|mlrs|mrl)\b/i.test(f.r.activity || ''));
        const firesHere = at(firing);
        if (on('counterbattery') && (cb.length || onGuns.length) && (firesHere.length || onGuns.length)) {
            const signs = [['counter-battery radar or counter-battery fire', cb], ['artillery or rocket fire here', firesHere],
                ['loitering munitions or drones striking guns', onGuns]];
            judge('counterbattery', levelBy(kindsOf(signs) + (byTime(signs.flatMap(([, l]) => l)).length >= 4 ? 1 : 0), 3, 4),
                `are conducting counter-battery fire around ${area}`, signs, [area]);
        }
        // Shoot and scoot: artillery firing, then the same type moving within the hour (or displacing as it fires).
        const gunsFiring = at(f => f.roles.has('fires') && shot(f));
        const sameGuns = (a, b) => a.els.some(x => x.kit && x.kit.role === 'fires' && b.els.some(y => y.kit && y.kit.name === x.kit.name));
        const displaced = at(f => f.roles.has('fires') && ((has(f, 'Moving') && gunsFiring.some(g => sameGuns(g, f) && f.ms > g.ms && f.ms - g.ms <= HOUR))
            || (shot(f) && SCOOT.test(f.r.activity || ''))));
        if (on('shootscoot') && displaced.length) {
            judge('shootscoot', levelBy(displaced.length, 2, 3), {
                RU: `are firing and quickly displacing artillery around ${area} ("roving" guns)`,
                CN: `are firing and quickly displacing artillery around ${area}`,
                '': `are firing and quickly displacing artillery around ${area} (shoot and scoot)`,
            }, [['artillery or rockets firing', gunsFiring], ['the same moving within the hour after, or displacing', displaced]], [area]);
        }
        // Mines laid remotely or quickly: minelayers or scatterable mines, with rockets or artillery.
        const mines = at(f => can(f, 'minelaying'));
        if (on('remotemine') && mines.length) {
            const signs = [['minelaying systems or remote mining reported', mines], ['rocket or artillery fire here', firesHere],
                ['armor or mechanized forces nearby', at(isManeuver)]];
            judge('remotemine', levelBy(kindsOf(signs) + (mines.length >= 2 ? 1 : 0), 2, 3), `are laying minefields in ${area}`, signs, [area]);
        }
        // Chemical-defense troops: their vehicles, decontamination, smoke generators.
        const chem = at(f => can(f, 'cbrn'));
        if (on('cbrn') && chem.length) {
            const signs = [['chemical-defense vehicles, decontamination or smoke generators', chem], ['smoke', smoke.filter(f => !chem.includes(f))],
                ['thermobaric weapons', at(f => can(f, 'thermobaric'))]];
            judge('cbrn', levelBy(kindsOf(signs) + (chem.length >= 2 ? 1 : 0), 2, 3), {
                RU: `have chemical-defense (RKhBZ) troops in ${area}, screening with smoke or decontaminating`,
                CN: `have chemical-defense troops in ${area}, screening with smoke or decontaminating`,
                '': `have chemical-defense troops in ${area}, screening with smoke or decontaminating`,
            }, signs, [area]);
        }
        // A counterattack: reported as one, or armor arriving after contact here.
        const contactHere = at(shot);
        const firstContact = at(f => shot(f) && !isManeuver(f)).map(f => f.ms);
        const t0 = firstContact.length ? Math.min(...firstContact) : null;
        const arrivals = t0 === null || at(f => isManeuver(f) && f.ms < t0).length ? []
            : at(f => isManeuver(f) && (advancing(f) || shot(f)) && f.ms > t0 && f.ms - t0 <= 6 * HOUR);
        const counter = at(f => COUNTER.test(f.r.activity || ''));
        if (on('counterattack') && (counter.length || arrivals.length)) {
            const signs = [['a counterattack reported', counter], ['armor or mechanized forces arriving within 6 hrs after contact here', arrivals],
                ['artillery fire in support', firesHere]];
            judge('counterattack', levelBy(kindsOf(signs), 2, 3),
                counter.length ? `are counterattacking in ${area}` : `are reinforcing or counterattacking in ${area}`, signs, [area]);
        }
        // Casualty evacuation: ambulances or wounded, after fighting here.
        const cas = at(f => can(f, 'medevac'));
        if (on('casevac') && cas.length) {
            const before = contactHere.filter(c => cas.some(f => f.ms >= c.ms && f.ms - c.ms <= 12 * HOUR));
            judge('casevac', levelBy(cas.length + (before.length ? 1 : 0), 2, 3), `are evacuating casualties from ${area}, a sign of heavy fighting there`,
                [['ambulances, MEDEVAC or wounded reported', cas], ['fighting here within 12 hrs before', before]], [area]);
        }
        // Assault groups in a town: small dismounted groups fighting among buildings, with support.
        const inTown = URBAN.test(area) ? list : at(f => URBAN.test(f.r.activity || ''));
        const stormers = inTown.filter(f => (f.groups.infantry || 0) > 0 && (shot(f) || advancing(f) || has(f, 'Dismounted')));
        if (on('urban') && stormers.length) {
            const signs = [['dismounted groups fighting or moving among buildings', stormers],
                ['tanks, thermobaric weapons or artillery supporting', at(f => f.roles.has('armor') || can(f, 'thermobaric') || firing(f))],
                ['drones overhead', uavs]];
            judge('urban', levelBy(kindsOf(signs) + (stormers.length >= 3 ? 1 : 0), 2, 3), {
                RU: `are assaulting built-up areas in ${area} with small assault groups (shturmovye gruppy)`,
                CN: `are assaulting built-up areas in ${area} with small assault teams`,
                '': `are assaulting built-up areas in ${area} with small assault groups`,
            }, signs, [area]);
        }
        // Reconnaissance in force: a platoon or more firing, then pulling back.
        const probes = at(f => shot(f) && ((f.groups.maneuver || 0) >= 3 || (f.groups.infantry || 0) >= 8));
        const pulled = at(f => WITHDRAW.test(f.r.activity || '') && (probes.includes(f) || after(probes, f, 3 * HOUR)));
        if (on('reconforce') && probes.length && pulled.length) {
            const struck = at(f => firing(f) && after(pulled, f, 6 * HOUR));
            judge('reconforce', EVEN + (struck.length ? 1 : 0) + (probes.length >= 2 ? 1 : 0), {
                RU: `are conducting reconnaissance in force (razvedka boyem) in ${area}, to make friendly positions show themselves`,
                CN: `are conducting reconnaissance in force in ${area}, to make friendly positions show themselves`,
                '': `are conducting reconnaissance in force in ${area}`,
            }, [['a platoon or more firing', probes], ['pulling back within 3 hrs', pulled], ['artillery on the place within 6 hrs after', struck]], [area]);
        }
        // Infantry building up: small groups halted or hidden here, again and again.
        const lurk = densest(at(f => smallGroup(f) && (has(f, 'Stationary', 'Observing', 'Dismounted') || GATHER.test(f.r.activity || '')) && !advancing(f)), 48 * HOUR);
        if (on('buildup') && lurk.length >= 3) {
            judge('buildup', levelBy(lurk.length, 4, 6), {
                RU: `are building up infantry in ${area}, gathering small groups near the line for an assault`,
                CN: `are building up infantry in ${area}, concentrating small teams near a weak point`,
                '': `are building up small infantry groups in ${area}`,
            }, [['small dismounted groups halted or hidden within 48 hrs', lurk],
                ['gathering in tree lines or buildings', lurk.filter(f => GATHER.test(f.r.activity || ''))],
                ['drones resupplying them', at(f => DRONE_DROP.test(textOf(f)))]], [area]);
        }
        // Delivering an assault group: armor dropping infantry, the infantry going on.
        const drops = at(f => isManeuver(f) && has(f, 'Dismounted'));
        const foot = at(f => (f.groups.infantry || 0) > 0 && (advancing(f) || shot(f)) && drops.some(d => f.ms >= d.ms && f.ms - d.ms <= 2 * HOUR));
        if (on('dismount') && drops.length && foot.length) {
            const cover = at(f => isManeuver(f) && shot(f) && after(drops, f, 2 * HOUR));
            judge('dismount', EVEN + (cover.length ? 1 : 0) + (foot.length >= 2 ? 1 : 0), {
                RU: `are delivering assault infantry by armored group (bronegruppa) in ${area}`,
                CN: `are delivering assault teams by infantry fighting vehicle in ${area}`,
                '': `are delivering assault infantry by armored vehicle in ${area}`,
            }, [['armored vehicles dropping infantry', drops], ['infantry moving or fighting within 2 hrs after', foot],
                ['the vehicles staying to support by fire', cover]], [area]);
        }
        // A strongpoint: two of armor, infantry and antitank weapons holding here for 12 hrs or more.
        const holding = at(f => has(f, 'Stationary', 'Emplacing') && !advancing(f));
        const hArmor = holding.filter(isManeuver), hInf = holding.filter(f => (f.groups.infantry || 0) > 0), hAt = holding.filter(f => f.roles.has('atgm'));
        const held = holding.length ? Math.max(...holding.map(f => f.ms)) - Math.min(...holding.map(f => f.ms)) : 0;
        if (on('strongpoint') && [hArmor, hInf, hAt].filter(l => l.length).length >= 2 && held >= 12 * HOUR) {
            const signs = [['armor or mechanized forces holding', hArmor], ['infantry holding', hInf], ['antitank weapons in position', hAt],
                ['obstacles or mines', obst]];
            judge('strongpoint', levelBy(kindsOf(signs), 3, 4), {
                RU: `are holding a company strongpoint (opornyy punkt) in ${area}`, CN: `are holding a strongpoint in ${area}`,
                '': `are holding a strongpoint in ${area}`,
            }, signs, [area]);
        }
        // Tanks as fire support: firing from halted positions, with no armor advancing here.
        const tankFire = at(f => f.roles.has('armor') && shot(f) && (has(f, 'Stationary') || INDIRECT.test(f.r.activity || ''))
            && !list.some(m => m !== f && isManeuver(m) && advancing(m) && Math.abs(m.ms - f.ms) <= 2 * HOUR));
        if (on('tankfire') && tankFire.length) {
            const assault = at(f => (f.groups.infantry || 0) > 0 && (shot(f) || advancing(f)) && after(tankFire, f, 6 * HOUR));
            judge('tankfire', levelBy(tankFire.length + (assault.length ? 1 : 0), 2, 3), {
                RU: `are using tanks as fire support from halted positions in ${area}, rather than to break through`,
                CN: `are supporting assault groups with tank fire from halted positions in ${area}`,
                '': `are using tanks as fire support from halted positions in ${area}`,
            }, [['tanks firing from halted positions', tankFire], ['infantry assaulting within 6 hrs after', assault]], [area]);
        }
        // Drones cutting the routes: strikes on vehicles or roads here.
        const cuts = densest(at(f => (can(f, 'loitering') || can(f, 'uav')) && ROUTES.test(f.r.activity || '')
            && (shot(f) || STRUCK.test(f.r.activity || ''))), 24 * HOUR);
        if (on('interdict') && cuts.length) {
            judge('interdict', levelBy(cuts.length, 2, 4), {
                RU: `are cutting the routes through ${area} with drones and FPVs`, CN: `are striking the routes and vehicles in ${area} with drones to isolate it`,
                '': `are striking vehicles on the routes through ${area} with drones`,
            }, [['drones or FPVs striking vehicles or roads within 24 hrs', cuts]], [area]);
        }
        // Persistent surveillance: UAVs again and again, with no fire yet.
        const watch = densest(uavs, 12 * HOUR);
        const struckAfter = watch.length && at(f => (firing(f) || can(f, 'loitering')) && !watch.includes(f)
            && f.ms >= watch[0].ms && f.ms <= watch[watch.length - 1].ms + HOUR).length;
        if (on('isr') && watch.length >= 3 && !struckAfter) {
            judge('isr', levelBy(watch.length, 4, 6), `are keeping ${area} under drone surveillance, building up a target for fires or an assault`,
                [['UAVs over it within 12 hrs', watch], ['artillery or strikes following', []]], [area]);
        }
        // Resupply by drone.
        const dropped = at(f => DRONE_DROP.test(textOf(f)) || (can(f, 'uav') && has(f, 'Resupplying')));
        if (on('droneresupply') && dropped.length) {
            judge('droneresupply', levelBy(dropped.length, 2, 3), `are resupplying forward groups in ${area} by drone`,
                [['drones dropping or carrying supplies', dropped], ['small groups holding there', at(f => smallGroup(f) && !advancing(f))]], [area]);
        }
        // A railhead: armor, artillery or supplies on trains here.
        const trains = at(f => RAIL.test(f.r.activity || '') && (isManeuver(f) || f.roles.has('fires') || f.roles.has('logistics') || f.roles.has('ad')));
        if (on('railhead') && trains.length) {
            const unloading = trains.filter(f => has(f, 'Resupplying'));
            judge('railhead', levelBy(trains.length + (unloading.length ? 1 : 0), 2, 3), `are moving forces or supplies by rail through ${area}`,
                [['armor, artillery or supplies on trains or at a railhead', trains], ['loading or unloading', unloading]], [area]);
        }
        // A helicopter refueling point: helicopters on the ground with fuel, or a FARP reported.
        // Fixed-wing aircraft refueling (Su-25s at an airfield) are not one.
        const helos = at(f => can(f, 'helo') && (has(f, 'Stationary', 'Resupplying') || /\b(landed|on the ground)\b/i.test(f.r.activity || '')));
        const farpSaid = at(f => FARP.test(f.r.activity || ''));
        const fuel = at(f => (f.roles.has('logistics') && FUEL_AMMO.test(textOf(f))) || has(f, 'Resupplying'));
        if (on('farp') && ((helos.length && fuel.length) || farpSaid.length)) {
            const signs = [['helicopters on the ground', helos], ['fuel or supply vehicles, or rearming', fuel], ['a FARP or landing site reported', farpSaid],
                ['air defense in place', adStill]];
            judge('farp', levelBy(kindsOf(signs), 3, 4), `have a forward arming and refueling point for helicopters in ${area}`, signs, [area]);
        }
        // Regrouping: halted, resupplying or recovering vehicles within 24 hrs after contact here.
        const later = at(f => after(contactHere, f, 24 * HOUR));
        const regroup = [['armor or infantry halted', later.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && has(f, 'Stationary'))],
            ['resupplying', later.filter(f => has(f, 'Resupplying'))], ['vehicles recovered or towed', later.filter(f => can(f, 'recovery'))]];
        if (on('regroup') && kindsOf(regroup) >= 2) {
            judge('regroup', levelBy(kindsOf(regroup) + (byTime(regroup.flatMap(([, l]) => l)).length >= 4 ? 1 : 0), 3, 4),
                `are regrouping in ${area} after the fighting there`, [['contact here', contactHere], ...regroup], [area]);
        }
        // The team's own rules: their words, often enough, in one place.
        custom.forEach(c => {
            const re = ruleWords(c.words);
            const hits = densest(at(f => re.test(textOf(f))), c.hours * HOUR);
            if (hits.length < c.min) return;
            judge('custom', EVEN + (hits.length >= c.min + 1 ? 1 : 0) + (hits.length >= c.min + 3 ? 1 : 0), `${c.what} in ${area}`,
                [[`reports of ${c.words.split(',').map(w => w.trim()).filter(Boolean).join(', ')} within ${c.hours} hrs`, hits]], [area]);
        });
    }

    // Preparing an offensive: artillery, air defense moving, armor massing,
    // engineers moving, EW, contact; at least two of them, one being
    // artillery or the massing.
    let focus = null, mass = [];
    for (const [area, list] of byArea) {
        const m = densest(list.filter(isManeuver), 12 * HOUR);
        if (m.length > mass.length) { mass = m; focus = area; }
    }
    if (mass.length < 3) { mass = []; focus = null; }
    const fires = facts.filter(f => f.roles.has('fires'));
    const ewAll = facts.filter(ewOf);
    const offense = [
        ['artillery or rockets', fires],
        ['air defense moving', facts.filter(f => f.roles.has('ad') && has(f, 'Moving'))],
        [focus ? `armor or mechanized forces massing in ${focus} within 12 hrs` : 'armor or mechanized forces massing', mass],
        ['engineers moving, or breaching and bridging', facts.filter(f => (f.roles.has('engineer') && has(f, 'Moving')) || can(f, 'breaching') || can(f, 'bridging'))],
        ['electronic warfare', ewAll],
        ['contact by armor or mechanized forces', facts.filter(f => isManeuver(f) && shot(f))],
    ];
    const kinds = kindsOf(offense);
    if (on('offense') && kinds >= 2 && (fires.length || mass.length)) {
        judge('offense', kinds >= 4 ? VERY_LIKELY : kinds === 3 ? LIKELY : EVEN,
            `are preparing offensive operations${focus ? `, centered on ${focus}` : ''}`, offense);
    }
    // Several axes: armor or mechanized forces moving in two or more places within 6 hours.
    const moving = facts.filter(f => isManeuver(f) && advancing(f) && f.areas.length);
    let axes = [];
    moving.forEach(f => {
        const w = moving.filter(g => g.ms >= f.ms && g.ms - f.ms <= 6 * HOUR);
        if (new Set(w.flatMap(g => g.areas)).size > new Set(axes.flatMap(g => g.areas)).size) axes = w;
    });
    const axisNames = [...new Set(axes.flatMap(g => g.areas))];
    if (on('axes') && axisNames.length >= 2) {
        const named = axisNames.slice(0, 4).join(', ');
        judge('axes', levelBy(axisNames.length, 3, 4), {
            RU: `are advancing on more than one axis (${named}), likely a main effort and supporting attacks`,
            CN: `are advancing in more than one direction (${named}), likely converging assault groups`,
            '': `are advancing on more than one axis (${named})`,
        }, [['armor or mechanized forces moving in different places within 6 hrs', axes]], axisNames);
    }
    // Small dismounted groups moving or observing, again and again.
    const small = densest(facts.filter(f => smallGroup(f) && has(f, 'Moving', 'Observing', 'Dismounted')), 12 * HOUR);
    if (on('infiltration') && small.length >= 2) {
        const where = mostIn(small);
        judge('infiltration', levelBy(small.length, 3, 5), {
            RU: `are infiltrating small dismounted groups${where ? ` through ${where}` : ''} (assault groups seeping through gaps, or sabotage-reconnaissance groups, DRG)`,
            CN: `are infiltrating small dismounted groups${where ? ` through ${where}` : ''} (special operations or reconnaissance teams)`,
            '': `are infiltrating small dismounted groups${where ? ` through ${where}` : ''}`,
        }, [['small dismounted groups moving or observing within 12 hrs', small]]);
    }
    // A second echelon or reserve: armor halted in one place during contact in another.
    const contact = facts.filter(f => shot(f));
    let reserve = [], reserveAt = null;
    for (const [area, list] of byArea) {
        const held = list.filter(f => isManeuver(f) && has(f, 'Stationary')
            && contact.some(c => !c.areas.includes(area) && Math.abs(c.ms - f.ms) <= 6 * HOUR));
        if (held.length > reserve.length) { reserve = held; reserveAt = area; }
    }
    if (on('reserve') && reserve.length) {
        const fights = contact.filter(c => !c.areas.includes(reserveAt) && reserve.some(f => Math.abs(c.ms - f.ms) <= 6 * HOUR));
        const big = reserve.reduce((n, f) => n + (f.groups.maneuver || 0), 0) >= 10 || reserve.length >= 2;
        judge('reserve', EVEN + (big ? 1 : 0), {
            RU: `are holding a second echelon or reserve in ${reserveAt}`,
            CN: `are holding a reserve in ${reserveAt}, ready to exploit or counterattack`,
            '': `are holding a reserve in ${reserveAt}`,
        }, [['contact elsewhere', fights], ['armor or mechanized forces halted away from it', reserve]], [reserveAt]);
    }
    // Massed fires: artillery or rocket fire twice or more in 3 hours; an
    // assault following makes it a preparation.
    const salvo = densest(facts.filter(firing), 3 * HOUR);
    if (on('artillery') && salvo.length >= 2) {
        const last = salvo[salvo.length - 1].ms;
        const follow = facts.filter(f => isManeuver(f) && has(f, 'Moving') && f.ms >= salvo[0].ms && f.ms - last <= 6 * HOUR);
        const where = mostIn(salvo), centered = where ? `, centered on ${where}` : '';
        judge('artillery', levelBy(salvo.length + (follow.length ? 1 : 0), 3, 4), follow.length ? {
            RU: `are conducting an artillery preparation ahead of an assault${centered}`, CN: `are conducting a fire strike ahead of an assault${centered}`,
            '': `are firing to prepare an assault${centered}`,
        } : {
            RU: `are conducting massed artillery fires${centered}`, CN: `are conducting a fire strike with artillery and rockets${centered}`,
            '': `are conducting massed artillery fires${centered}`,
        }, [['artillery or rocket fire within 3 hrs', salvo], ['rocket launchers among them', salvo.filter(f => can(f, 'mrl'))],
            ['armor or mechanized forces moving after it', follow]]);
    }
    // Long-range strikes, loitering munitions, attack aviation, EW: how often they're reported.
    const deep = facts.filter(f => can(f, 'deep'));
    if (on('deep') && deep.length) {
        judge('deep', levelBy(deep.length, 2, 3), {
            RU: 'are preparing or conducting deep strikes with long-range rockets or missiles',
            CN: 'are preparing or conducting long-range strikes as part of a joint fire strike',
            '': 'are preparing or conducting long-range strikes',
        }, [['long-range rockets or missiles', deep], ['UAVs finding targets in depth', facts.filter(f => can(f, 'uav'))]]);
    }
    const drones = facts.filter(f => can(f, 'loitering'));
    if (on('drones') && drones.length) {
        judge('drones', levelBy(drones.length, 2, 4), 'are striking with loitering munitions or drones',
            [['loitering munitions, FPV or armed drones', drones], ['UAVs finding targets for them', facts.filter(f => can(f, 'uav'))]]);
    }
    const air = facts.filter(f => can(f, 'attackAir'));
    if (on('aviation') && air.length) {
        judge('aviation', levelBy(air.length, 2, 4), 'are supporting ground forces with attack aviation',
            [['attack helicopters, ground-attack aircraft or armed UAVs', air], ['a ground attack at the same time', facts.filter(f => isManeuver(f) && shot(f))]]);
    }
    if (on('ew') && ewAll.length) {
        const where = mostIn(ewAll), near = where ? ` near ${where}` : '';
        judge('ew', levelBy(ewAll.length, 2, 4), {
            RU: `are jamming communications, GPS and drones${near}`,
            CN: `are attacking command, communications and sensors with electronic warfare${near}`,
            '': `are conducting electronic warfare${near}`,
        }, [['EW systems or jamming reported', ewAll],
            ['an attack following it', facts.filter(f => isManeuver(f) && (advancing(f) || shot(f)) && ewAll.some(e => f.ms > e.ms && f.ms - e.ms <= 6 * HOUR))]]);
    }
    // Withdrawal, when reports say so.
    const back = facts.filter(f => WITHDRAW.test(f.r.activity || ''));
    if (on('withdrawal') && back.length) {
        judge('withdrawal', back.length >= 3 ? VERY_LIKELY : back.length === 2 ? LIKELY : EVEN, 'are withdrawing',
            [['withdrawal or breaking contact reported', back], ['covering forces left behind', []], ['obstacles or demolitions behind them', []]]);
    }
    // Firing: probing with small elements, or attacking with a company or more.
    const shots = facts.filter(f => shot(f));
    const bigShots = shots.filter(f => (f.groups.maneuver || 0) >= 10 || (f.groups.infantry || 0) >= 30);
    if (on('firing') && bigShots.length) {
        judge('firing', bigShots.length >= 2 ? VERY_LIKELY : LIKELY, 'are attacking with company-sized or larger elements',
            [['firing by a company or more', bigShots], ['artillery fire in support', []]]);
    } else if (on('firing') && shots.length >= 2) {
        judge('firing', shots.length >= 4 ? VERY_LIKELY : shots.length === 3 ? LIKELY : EVEN,
            'are probing friendly positions with small elements',
            [['firing by elements smaller than a company', shots], ['larger elements following up', []], ['artillery fire in support', []]]);
    }
    // Fixing: contact in one place while armor moves in another within 3 hrs.
    let fixAt = null, fixMovers = [], fixContact = [];
    for (const [area, list] of byArea) {
        const c = list.filter(shot);
        const m = facts.filter(f => isManeuver(f) && advancing(f) && f.areas.length && !f.areas.includes(area)
            && c.some(x => Math.abs(x.ms - f.ms) <= 3 * HOUR));
        if (m.length > fixMovers.length) { fixMovers = m; fixAt = area; fixContact = c.filter(x => m.some(f => Math.abs(x.ms - f.ms) <= 3 * HOUR)); }
    }
    if (on('fixing') && fixMovers.length) {
        const main = mostIn(fixMovers);
        const signs = [[`contact in ${fixAt}`, fixContact], ['armor or mechanized forces moving elsewhere within 3 hrs', fixMovers],
            [`artillery fire on ${fixAt}`, (byArea.get(fixAt) || []).filter(firing)]];
        judge('fixing', levelBy(kindsOf(signs) + (fixMovers.reduce((n, f) => n + (f.groups.maneuver || 0), 0) >= 10 ? 1 : 0), 3, 4), {
            RU: `are fixing friendly forces in ${fixAt}, with armor moving through ${main} at the same time`,
            CN: `are fixing friendly forces in ${fixAt} ('one point, two sides'), with armor moving through ${main} at the same time`,
            '': `are fixing friendly forces in ${fixAt}, with armor moving through ${main} at the same time`,
        }, signs, [fixAt, main]);
    }
    // Exploitation: contact in one place, then armor through it and on into places quiet until then.
    let exp = null;
    for (const [area, list] of byArea) {
        list.filter(shot).forEach(c => {
            const through = list.filter(f => isManeuver(f) && advancing(f) && f.ms > c.ms && f.ms - c.ms <= 12 * HOUR);
            if (!through.length) return;
            const t1 = Math.min(...through.map(f => f.ms));
            const quiet = (a) => a !== area && !(byArea.get(a) || []).some(g => g.ms < c.ms);
            const beyond = facts.filter(f => isManeuver(f) && advancing(f) && f.ms >= t1 && f.ms - t1 <= 12 * HOUR && f.areas.some(quiet));
            const fresh = [...new Set(beyond.flatMap(f => f.areas.filter(quiet)))];
            if (fresh.length && (!exp || fresh.length > exp.fresh.length)) exp = { area, c, through, beyond, fresh };
        });
    }
    if (on('exploit') && exp) {
        const into = exp.fresh.slice(0, 3).join(', ');
        judge('exploit', levelBy(exp.fresh.length, 2, 3), {
            RU: `are exploiting a breakthrough at ${exp.area}, pushing armor on into ${into} (a forward detachment or second echelon)`,
            CN: `are exploiting a breakthrough at ${exp.area}, pushing depth-attack groups on into ${into}`,
            '': `are exploiting a breakthrough at ${exp.area}, pushing armor on into ${into}`,
        }, [[`contact in ${exp.area}`, [exp.c]], [`armor moving through ${exp.area} within 12 hrs`, exp.through],
            ['armor moving on into places with no reports before it', exp.beyond]], [exp.area, ...exp.fresh]);
    }
    // Envelopment: flanking reported, or forces pressing in three or more 10 km squares around one.
    const flanking = facts.filter(f => FLANK.test(f.r.activity || ''));
    const pressing = facts.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && (advancing(f) || shot(f)));
    let ring = null;
    pressing.forEach(f => {
        const cells = new Map();
        pressing.filter(g => g.ms >= f.ms && g.ms - f.ms <= 24 * HOUR).forEach(g => g.areas.forEach(a => {
            const m = SQUARE.exec(a);
            if (!m) return;
            if (!cells.has(a)) cells.set(a, { zone: m[1], e: +m[2], n: +m[3], list: [] });
            cells.get(a).list.push(g);
        }));
        const all = [...cells.values()];
        all.forEach(c0 => {
            for (let e = Math.max(0, c0.e - 1); e <= Math.min(9, c0.e + 1); e++) {
                for (let n = Math.max(0, c0.n - 1); n <= Math.min(9, c0.n + 1); n++) {
                    const around = all.filter(c => c.zone === c0.zone && Math.max(Math.abs(c.e - e), Math.abs(c.n - n)) === 1);
                    const center = `${c0.zone} ${e}${n}`;
                    if (around.length >= 3 && (!ring || around.length > ring.around.length || (around.length === ring.around.length && center < ring.center))) {
                        ring = { center, around };
                    }
                }
            }
        });
    });
    if (on('encircle') && (flanking.length || ring)) {
        const where = ring ? ring.center : mostIn(flanking);
        const around = ring ? byTime(ring.around.flatMap(c => c.list)) : [];
        judge('encircle', EVEN + (ring && ring.around.length >= 4 ? 1 : 0) + (ring && flanking.length ? 1 : 0), {
            RU: `are enveloping or encircling${where ? ` ${where}` : ' friendly positions'}, to cut it off (a pocket, kotyol)`,
            CN: `are splitting and encircling${where ? ` ${where}` : ' friendly positions'}, to isolate it`,
            '': `are enveloping or encircling${where ? ` ${where}` : ' friendly positions'}`,
        }, [['flanking, envelopment or encirclement reported', flanking],
            [ring ? `forces moving or fighting in ${ring.around.length} squares around ${ring.center} within 24 hrs` : 'forces moving or fighting on several sides of one place', around]],
        where ? [where] : null);
    }
    // Pursuit, when reports say so.
    const chase = densest(facts.filter(f => PURSUIT.test(f.r.activity || '') && (isManeuver(f) || f.roles.has('light') || (f.groups.infantry || 0) > 0)), 6 * HOUR);
    if (on('pursuit') && chase.length) {
        const where = mostIn(chase);
        judge('pursuit', levelBy(chase.length, 2, 4), `are pursuing${where ? ` through ${where}` : ''}`, [['pursuit reported within 6 hrs', chase]]);
    }
    // A fortified line: digging in, obstacles or engineers in three or more places within 48 hrs.
    const works = densest(facts.filter(f => has(f, 'Emplacing') || OBSTACLE.test(f.r.activity || '') || (f.roles.has('engineer') && has(f, 'Stationary'))), 48 * HOUR);
    const workAreas = [...new Set(works.flatMap(f => f.areas))];
    if (on('fortline') && workAreas.length >= 3) {
        const line = workAreas.slice(0, 4).join(', ');
        judge('fortline', levelBy(workAreas.length, 4, 5), {
            RU: `are building a fortified line in depth across ${line}`, CN: `are preparing a positional defense in depth across ${line}`,
            '': `are building a fortified line across ${line}`,
        }, [['digging in, obstacles or engineers within 48 hrs', works],
            ["tank ditches, dragon's teeth or trenches", works.filter(f => /\b(ditch(es)?|dragon'?s teeth|trench\w*|pyramids|hedgehogs)\b/i.test(f.r.activity || ''))]],
        workAreas);
    }
    // A screen: reconnaissance or small groups halted or observing in two or more places within 6 hrs.
    const lookouts = facts.filter(f => (f.roles.has('recon') || smallGroup(f)) && !can(f, 'uav') && has(f, 'Stationary', 'Observing') && !advancing(f) && f.areas.length);
    let scr = [];
    lookouts.forEach(f => {
        const w = lookouts.filter(g => g.ms >= f.ms && g.ms - f.ms <= 6 * HOUR);
        if (new Set(w.flatMap(g => g.areas)).size > new Set(scr.flatMap(g => g.areas)).size) scr = w;
    });
    const scrAreas = [...new Set(scr.flatMap(g => g.areas))];
    if (on('screen') && scrAreas.length >= 2) {
        const behind = facts.filter(f => (has(f, 'Emplacing') || OBSTACLE.test(f.r.activity || '')) && f.areas.some(a => !scrAreas.includes(a))
            && f.ms >= scr[0].ms - 12 * HOUR && f.ms <= scr[scr.length - 1].ms + 12 * HOUR);
        const along = scrAreas.slice(0, 4).join(', ');
        judge('screen', levelBy(scrAreas.length + (behind.length ? 1 : 0), 4, 5), {
            RU: `are holding a security zone along ${along}, ahead of their main defense`,
            CN: `are holding a screen of security elements along ${along}, ahead of their main defense`,
            '': `are holding a screen along ${along}`,
        }, [['reconnaissance or small groups halted or observing in different places within 6 hrs', scr], ['a defense being prepared behind them', behind]], scrAreas);
    }
    // Light vehicles: motorcycles, buggies or cars moving or fighting, again and again.
    const riders = densest(facts.filter(f => (f.roles.has('light') || LIGHT_WORDS.test(textOf(f))) && (advancing(f) || shot(f) || has(f, 'Dismounted'))), 12 * HOUR);
    if (on('lightassault') && riders.length >= 2) {
        const where = mostIn(riders), via = where ? ` through ${where}` : '';
        const signs = [['motorcycles, buggies or light vehicles moving or fighting within 12 hrs', riders],
            ['infantry with them', riders.filter(f => (f.groups.infantry || 0) > 0)],
            ['drones overhead', facts.filter(f => can(f, 'uav') && riders.some(r => Math.abs(r.ms - f.ms) <= 2 * HOUR))]];
        judge('lightassault', levelBy(riders.length + (kindsOf(signs) >= 3 ? 1 : 0), 3, 5), {
            RU: `are moving assault groups fast on motorcycles, buggies and light vehicles${via}`,
            CN: `are moving fast and dispersed on light vehicles${via}`,
            '': `are moving fast in small groups on light vehicles${via}`,
        }, signs);
    }
    // Thermobaric fires, and an assault after them.
    const therm = facts.filter(f => can(f, 'thermobaric'));
    if (on('thermobaric') && therm.length) {
        const where = mostIn(therm);
        const assault = facts.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && (advancing(f) || shot(f)) && after(therm, f, 6 * HOUR)
            && (!where || f.areas.includes(where)));
        judge('thermobaric', levelBy(therm.length + (assault.length ? 1 : 0), 2, 3), {
            RU: `are using thermobaric weapons${where ? ` on ${where}` : ''} (TOS or Shmel), usually just before an assault`,
            CN: `are using thermobaric or incendiary weapons${where ? ` on ${where}` : ''} against fortified positions`,
            '': `are using thermobaric weapons${where ? ` on ${where}` : ''}`,
        }, [['thermobaric launchers or flamethrowers', therm], ['an assault there within 6 hrs after', assault]]);
    }
    // Glide bombs, and an assault after them.
    const bombs = densest(facts.filter(f => can(f, 'glideBomb')), 24 * HOUR);
    if (on('glidebomb') && bombs.length) {
        const where = mostIn(bombs);
        const assault = facts.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && (advancing(f) || shot(f)) && after(bombs, f, 12 * HOUR)
            && (!where || f.areas.includes(where)));
        judge('glidebomb', levelBy(bombs.length + (assault.length ? 1 : 0), 2, 4),
            assault.length ? `are striking${where ? ` ${where}` : ''} with glide bombs ahead of an assault` : `are striking${where ? ` ${where}` : ''} with glide bombs`,
            [['glide or guided bombs within 24 hrs', bombs], ['an assault there within 12 hrs after', assault]]);
    }
    // Strikes on command posts, radars and communications.
    const striking = (f) => firing(f) || can(f, 'deep') || can(f, 'loitering') || can(f, 'attackAir') || can(f, 'glideBomb');
    const blinds = densest(facts.filter(f => striking(f) && C2_TARGETS.test(f.r.activity || '')), 24 * HOUR);
    if (on('c2strike') && blinds.length) {
        judge('c2strike', levelBy(blinds.length, 2, 4), {
            RU: 'are striking command posts, radars and communications, to blind the defense',
            CN: 'are striking command, communications and sensors (system destruction warfare)',
            '': 'are striking command posts, radars and communications',
        }, [['strikes on command posts, radars or communications within 24 hrs', blinds],
            ['EW at the same time', ewAll.filter(e => blinds.some(b => Math.abs(b.ms - e.ms) <= 6 * HOUR))]]);
    }
    // Suppressing air defense: anti-radiation weapons, or strikes on radars and SAMs.
    const suppress = facts.filter(f => can(f, 'sead') || (striking(f) && /\b(radars?|sams?|air defen[cs]e)\b/i.test(f.r.activity || '')));
    if (on('sead') && suppress.length) {
        const jam = ewAll.filter(e => suppress.some(s => Math.abs(s.ms - e.ms) <= 6 * HOUR));
        judge('sead', levelBy(suppress.length + (jam.length ? 1 : 0), 2, 3), 'are suppressing friendly air defense',
            [['anti-radiation weapons, or strikes on radars and air defense', suppress], ['EW at the same time', jam],
                ['decoy drones', facts.filter(f => can(f, 'deception') && (can(f, 'uav') || can(f, 'loitering')))]]);
    }
    // Logistics moving forward, with armor massing or with fuel and ammunition.
    const convoys = densest(facts.filter(f => f.roles.has('logistics') && advancing(f)), 12 * HOUR);
    const fuelAmmo = convoys.filter(f => FUEL_AMMO.test(textOf(f)));
    if (on('logforward') && convoys.length >= 2 && (mass.length || fuelAmmo.length)) {
        const signs = [['supply vehicles moving within 12 hrs', convoys], ['fuel or ammunition among them', fuelAmmo],
            [focus ? `armor or mechanized forces massing in ${focus}` : 'armor or mechanized forces massing', mass]];
        judge('logforward', levelBy(kindsOf(signs) + (convoys.length >= 4 ? 1 : 0), 3, 4), {
            RU: `are pushing fuel and ammunition forward${focus ? ` toward ${focus}` : ''}, as before an attack`,
            CN: `are pushing fuel and ammunition forward${focus ? ` toward ${focus}` : ''}, as before an attack`,
            '': `are pushing supplies forward${focus ? ` toward ${focus}` : ''}`,
        }, signs);
    }
    return out.sort((x, y) => y.level - x.level || y.list.length - x.list.length || x.order - y.order || x.key.localeCompare(y.key));
};

// Which army's equipment some reports hold: vehicles of Russian and of
// Chinese design (identified types only), and which there is more of.
const originCounts = (list) => {
    const n = { RU: 0, CN: 0 };
    list.forEach(f => f.els.forEach(e => { if (e.kit && e.kit.origin in n) n[e.kit.origin] += e.count; }));
    return n;
};
const originOf = (n) => (n.RU || n.CN ? (n.RU >= n.CN ? 'RU' : 'CN') : '');

// The units a judgment can be put down to: those whose places include one
// it is about (none listed: anywhere) and, when kinds are listed, that have a
// kind of equipment in its reports. Places match regardless of case.
const unitsFor = (j, units) => {
    const at = new Set(j.places.map(p => p.toUpperCase()));
    return units.filter(u => (!u.places.length || u.places.some(p => at.has(p.toUpperCase())))
        && (!u.kinds.length || u.kinds.some(k => j.list.some(f => f.roles.has(k)))));
};
// "A, B or C" and "A, B and C".
const wordList = (names, word) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`);
const orList = (names) => wordList(names, 'or');
const andList = (names) => wordList(names, 'and');

// The narrative's settings as the rules use them, with what's unset filled
// in. Settings come from a file or the server, so each value is made the
// kind the rules need (a count typed as "2" is 2; words given as a list are
// one comma-separated line), and an entry that still makes no sense is left out.
const narrativeSettings = (s) => {
    s = s && typeof s === 'object' ? s : {};
    const list = (v) => (Array.isArray(v) ? v : []);
    const text = (v) => (Array.isArray(v) ? v.map(String).join(', ') : v == null || typeof v === 'object' ? '' : String(v)).trim();
    return {
        enemy: text(s.enemy) || 'enemy forces',
        units: list(s.units).filter(u => u && text(u.name)).map(u => ({ name: text(u.name), places: list(u.places).map(text).filter(Boolean), kinds: list(u.kinds).map(text).filter(Boolean) })),
        team: teamEquipment(list(s.equipment).filter(e => e && text(e.type) && text(e.role)).map(e => ({ type: text(e.type), role: text(e.role), origin: text(e.origin) }))),
        off: new Set(list(s.off)),
        custom: list(s.custom).filter(c => c && typeof c === 'object')
            .map(c => ({ what: text(c.what), words: text(c.words), min: Number(c.min), hours: Number(c.hours) }))
            .filter(c => c.what && c.words.split(',').some(w => w.trim()) && Number.isFinite(c.min) && c.min > 0 && Number.isFinite(c.hours) && c.hours > 0),
    };
};

// Confidence in a judgment, from how many reports and observers support it
// and whether each has a grid: high, moderate, or low.
const confidenceOf = (list) => {
    const who = new Set(list.map(f => f.who).filter(Boolean)).size;
    const level = list.length >= 4 && who >= 2 && list.every(f => f.a.points.length) ? 'high'
        : list.length >= 3 || (list.length >= 2 && who >= 2) ? 'moderate' : 'low';
    return `${level} (${plural(list.length, 'report')}${who ? ` from ${plural(who, 'observer')}` : ''})`;
};

// The narrative's sections, for the reports in the period (`cur`, in time
// order) and the period before (`prev`, or null). `settings` are the team's
// (what the enemy is called, units, equipment, rules: narrativeSettings).
const narrativeLines = (cur, prev, { local, hrs, end, places, settings, width = 100 }) => {
    const set = narrativeSettings(settings);
    const facts = cur.map(f => narrativeFacts(f, set.team));
    const out = [];
    const say = (text, first = '   ', rest = '   ') => out.push(...wrapText(text, first, rest, width));
    const cite = (list, max = 4) => {
        const l = byTime(list);
        return l.slice(0, max).map(f => `${f.id} ${dayTime(f.ms, local)}`).join(', ') + (l.length > max ? ` and ${l.length - max} more` : '');
    };

    out.push('1. OBSERVED');
    if (!facts.length) {
        say(`No reports in this period${prev ? ` (previous ${hrs} hrs: ${prev.length})` : ''}.`);
        out.push('', '2. ASSESSMENT', '   None: no reports to assess.', '');
        return out;
    }
    const who = new Set(facts.map(f => f.who).filter(Boolean)).size;
    const placed = facts.filter(f => f.places.length).length;
    say(`${plural(facts.length, 'report')}${who ? ` from ${plural(who, 'observer')}` : ''}, ${dayTime(facts[0].ms, local)} to ${dayTime(facts[facts.length - 1].ms, local)}`
        + `${prev ? ` (previous ${hrs} hrs: ${prev.length})` : ''}; ${placed} in an NAI or OBJ`
        + `${places.length ? `, most in ${places.slice(0, 3).map(p => `${p.label} (${p.value})`).join(', ')}` : ''}.`);

    // The equipment, by role, with the types reported and how many.
    const roles = new Map(), unknown = new Map(), kitOf = new Map();
    facts.forEach(f => f.els.forEach(e => {
        if (!e.kit) { unknown.set(e.type, (unknown.get(e.type) || 0) + 1); return; }
        if (!roles.has(e.kit.role)) roles.set(e.kit.role, new Map());
        const types = roles.get(e.kit.role);
        types.set(e.type, (types.get(e.type) || 0) + e.count);
        kitOf.set(e.type, e.kit);
    }));
    const label = Object.fromEntries(EQUIPMENT_ROLES);
    const roleList = EQUIPMENT_ROLES.map(([r]) => r).filter(r => roles.has(r));
    if (roleList.length) {
        say(`Equipment reported: ${roleList.map(r => `${label[r]} (${[...roles.get(r)].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .map(([t, n]) => typeCount(t, n, kitOf.get(t))).join(', ')})`).join('; ')}.`);
    }
    const origins = originCounts(facts), army = originOf(origins);
    if (army) {
        say(origins.RU && origins.CN
            ? `Equipment by design: Russian ${origins.RU}, Chinese ${origins.CN}; each judgment uses the doctrine of the equipment in its reports.`
            : `Identified equipment is of ${ARMIES[army]} design (${origins[army]} ${origins[army] === 1 ? 'vehicle or system' : 'vehicles and systems'}), so the assessment uses ${army === 'RU' ? 'Russian' : 'PLA'} doctrine.`);
    }
    // The largest single sighting of each kind, and the unit size it suggests.
    const largest = Object.keys(ECHELONS).map(kind => {
        const top = facts.filter(f => f.groups[kind]).sort((x, y) => y.groups[kind] - x.groups[kind] || y.ms - x.ms)[0];
        return top && `${ECHELON_LABEL[kind]} approximately ${echelonOf(kind, top.groups[kind])} size (${top.r.size}; ${top.id} ${dayTime(top.ms, local)}${top.places.length ? `, ${top.places.join(', ')}` : ''})`;
    }).filter(Boolean);
    if (largest.length) say(`Largest single sightings: ${largest.join('; ')}.`);
    // Where they headed, and any firing.
    const heads = new Map();
    facts.forEach(f => { if (f.act.heading) { const h = HEADINGS_8[Math.round(f.act.headingDeg / 45) % 8]; heads.set(h, (heads.get(h) || 0) + 1); } });
    if (heads.size) say(`Movement: headed ${[...heads].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([h, n]) => `${h} (${n})`).join(', ')}.`);
    const shots = facts.filter(f => f.act.tags.includes('Firing'));
    if (shots.length) {
        say(`Firing: ${plural(shots.length, 'report')}: ${shots.slice(0, 5).map(f => `${f.id} ${dayTime(f.ms, local)} ${f.r.size || '-'}, ${f.r.activity || '-'}`).join('; ')}`
            + `${shots.length > 5 ? `; and ${shots.length - 5} more` : ''}.`);
    }
    // Each busy place in a sentence: when, what kinds, what they were doing.
    const at = (p) => facts.filter(f => f.places.includes(p));
    if (places.length) {
        out.push('   By place:');
        places.slice(0, 6).forEach(p => {
            const list = at(p.label);
            const kinds = EQUIPMENT_ROLES.map(([r]) => r).filter(r => list.some(f => f.roles.has(r))).map(r => label[r]);
            // Whose area it is, from the unit list (not from the reports).
            const whose = set.units.filter(u => u.places.some(q => q.toUpperCase() === p.label.toUpperCase())).map(u => u.name);
            say(`${p.label}${whose.length ? ` (area of ${andList(whose)})` : ''}: ${plural(list.length, 'report')}, ${dayTime(list[0].ms, local)} to ${dayTime(list[list.length - 1].ms, local)}`
                + `${kinds.length ? `; ${kinds.join(', ')}` : ''}; ${activityLine(list)}.`, '     ', '       ');
        });
    }

    out.push('', '2. ASSESSMENT');
    // The ten strongest; how many more there were is said, not hidden.
    const all = narrativeJudgments(facts, cite, set), judgments = all.slice(0, 10);
    if (!judgments.length) say("No assessment: the reports in this period don't match any of the patterns this tool looks for.");
    judgments.forEach((j, i) => {
        const [term, pct] = ICD203[j.level];
        // Said of a unit when one to three in the unit list fit, else of the enemy.
        const units = unitsFor(j, set.units);
        const who = units.length && units.length <= 3 ? `elements of ${orList(units.map(u => u.name))}` : set.enemy;
        const own = originCounts(j.list), mine = originOf(own), o = mine || army;
        const what = typeof j.what === 'string' ? j.what : j.what[o] || j.what[''];
        say(`${term.toUpperCase()} (${pct}) that ${who} ${what}.`, `   ${String.fromCharCode(97 + i)}. `, '      ');
        say(`Basis: ${j.basis}.`, '      ', '      ');
        const doctrine = DOCTRINE[j.rule] && DOCTRINE[j.rule][o];
        if (doctrine) {
            const from = mine ? `${ARMIES[o]} equipment in these reports${own.RU && own.CN ? `, ${own[o]} of ${own.RU + own.CN}` : ''}` : `${ARMIES[o]} equipment in the period`;
            say(`Doctrine (${from}): ${doctrine}`, '      ', '      ');
        }
        if (who !== set.enemy) {
            say(`Unit: from the unit list, ${units.map(u => `${u.name} (${[u.places.join(', ') || 'anywhere', u.kinds.map(k => label[k]).join(', ')].filter(Boolean).join('; ')})`).join('; ')}.`, '      ', '      ');
        }
        say(`Confidence: ${confidenceOf(j.list)}.`, '      ', '      ');
        if (j.watch.length) say(`Watch for: ${j.watch.join('; ')}.`, '      ', '      ');
    });
    if (all.length > judgments.length) {
        say(`${plural(all.length - judgments.length, 'more judgment')} at ${ICD203[all[judgments.length].level][0]} or less not shown; a shorter window, or rules switched off in the settings, narrows them.`);
    }

    // What the reports leave open.
    out.push('', '3. GAPS');
    const gaps = [];
    const noGrid = facts.filter(f => !f.a.points.length);
    if (noGrid.length) gaps.push(`${plural(noGrid.length, 'report')} without a grid: ${cite(noGrid, 6)}.`);
    if (unknown.size) gaps.push(`Not in the equipment catalogue: ${[...unknown].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([t, n]) => `${t}${n > 1 ? ` (${n})` : ''}`).join(', ')}.`);
    if (hrs >= 12) {
        places.forEach(p => {
            const last = at(p.label).pop();
            if (last && end - last.ms >= 6 * HOUR) gaps.push(`${p.label}: no reports since ${dayTime(last.ms, local)}.`);
        });
    }
    if (!gaps.length) gaps.push('None.');
    gaps.forEach(g => say(g));

    out.push('');
    say(`NOTE: OBSERVED is what the reports say; counts are as reported, and the same vehicles may be in more than one report.`
        + ` ASSESSMENT comes from fixed rules over the cited reports. Likelihood terms follow ICD 203: `
        + `${ICD203.map(([t, p]) => `${t} ${p}`).join(', ')}. Confidence (high, moderate, low) rests on how many reports and observers support a judgment.`
        + ' Doctrine follows the design of the equipment in each judgment\'s reports (Russian or Chinese), else the period\'s.'
        + `${set.units.length ? ' Units are named from the unit list, not from the reports.' : ''}`, '', '');
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
    pad2, dateFields, clockValue, fileStamp, toTimeString, autoColon, parseFilterTime, typedTime, submittedTime, parseCsvTime,
    escapeHtml, safeColor, safeFilename,
    atoPrefix, reportNum, duplicateIds, nextNum, displayId, formatFullId, reportText, normalizeLocation, mgrsPrefix, applyMgrsPrefix,
    BDA_EFFECTS, bdaElements, bdaSummary, bdaRollup, bdaCount, bdaPending,
    backupFilename, foldOverlays, overlayKey, backupText, allWorkspacesBackupText, parseBackup,
    parseCsv, reportsCsv, mtiCsvs,
    utmToLatLon, gridToLatLon, latLonToMgrs, findGrids, findRefs, overlayRef, geometryContains, metresToGeometry,
    webMercatorToLonLat, readDbf, shapefileProjection, parseShapefile,
    reportTracks, reportPositions, heatPoints, activityMatches, arcgisTrackRows, arcgisTracksGeoJson, arcgisTracksEsriJson,
    lonLatToMerc, MERC_WORLD, compass16, zipStore, crc32, shapefileParts, arcgisShapefileZip, arcgisTracksShapefileZip, tilesFor, tileZoom, tileUrl, wmsUrl, wmsCapabilitiesUrl, pickWmsCrs, pickWmsFormat, mercToLonLat, metresBetween, bearingBetween,
    asArea, analyzeLocation, locationPlan, editLocation, classifyActivity, ACTIVITY_TAGS, arcgisRows, arcgisGeoJson, arcgisEsriJson, arcgisCsv,
    sizeElements, gridSquare, statsData, statsCsv, PL_NEAR_METRES, workbookReportRows, statsXlsx, excelSerial, colName,
    dtg, summaryReport, summaryPlaces, EQUIPMENT_CATALOGUE, EQUIPMENT_ROLES, lookupEquipment, teamEquipment, ECHELONS, echelonOf, ICD203, NARRATIVE_RULES, DOCTRINE,
    reportKey, knownVersions, changedReports, withUnsaved,
};

if (typeof module === 'object' && module.exports) module.exports = SaltCore;
else root.SaltCore = SaltCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);

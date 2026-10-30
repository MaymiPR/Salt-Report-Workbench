// SPDX-License-Identifier: AGPL-3.0-only
// Reports, BDA, backups, and CSV. The build joins the src/core/ parts in name order inside one function, so they share one scope.

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
// The Size is what is left after BDA (sizeAfterBda), with what came off:
// "S: 17x tanks (BDA: 3x tanks destroyed)". `team` is the team's equipment.
const reportText = (report, format, sep, team = null) => {
    if (!report) return '';
    const size = sizeAfterBda(report, team);
    const idText = report.updated ? `${formatFullId(report, sep)} (Updated)` : formatFullId(report, sep);
    const lines  = [];
    format.lines.forEach((line, i) => {
        switch (line.type) {
            case 'id':       lines.push(i === 0 ? idText : `U: ${idText}`); break;
            case 'size':     lines.push(`S: ${size.shown}${size.note ? ` (${size.note})` : ''}`); break;
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

// applyMgrsPrefix the other way, for a report put back in the form: each
// grid in the locked zone and square ("38S MB 45000 82000", "38SMB4500082000")
// as its digits ("45000 82000"). Grids in another square, and everything
// else, are left as they are.
const stripMgrsPrefix = (text, prefix) => {
    const p = mgrsPrefix(prefix), s = String(text || '');
    if (!p) return s;
    return s.split(',').map(seg => {
        const t = seg.trim(), lead = seg.slice(0, seg.length - seg.trimStart().length);
        const m = /^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d{1,10})(?:\s+(\d{1,5}))?$/i.exec(t);
        if (!m || mgrsPrefix(`${m[1]}${m[2]} ${m[3]}${m[4]}`) !== p) return seg;
        if (m[6] !== undefined) return m[5].length === m[6].length ? `${lead}${m[5]} ${m[6]}` : seg;
        return m[5].length % 2 === 0 ? `${lead}${m[5].slice(0, m[5].length / 2)} ${m[5].slice(m[5].length / 2)}` : seg;
    }).join(',');
};

// With MGRS Lock on: the parts of a Location (between commas) that look meant
// as a grid but aren't one, each { text, why }, why finishing "39697 0676 ..."
// ("has an odd number of digits"), so the page can say so before they are
// logged as typed. A part is meant as a grid when it is only digits, four or
// more in all ("39697 0676"; "205" is a number), or starts with a zone, band
// and square and goes on in digits ("11S NV 1234 567"). Place names, and
// numbers with words ("Hill 205"), never are. Digits alone are checked with
// the locked zone and square (`prefix`) in front, as Log will put them.
const lockDigitsWhy = (groups) => {
    const n = groups.join('').length;
    if (groups.length > 2) return 'is split into more than two numbers';
    if (n > 10) return 'has more than 10 digits';
    if (groups.length === 2 && groups[0].length !== groups[1].length) return 'has two numbers of different lengths';
    if (n % 2) return 'has an odd number of digits';
    return '';
};
// What is wrong with a grid zone, band and 100 km square, or ''; with
// `digits` (whole), whether that point is in the band.
const lockSquareWhy = (zone, band, col, row, digits = '') => {
    band = band.toUpperCase(); col = col.toUpperCase(); row = row.toUpperCase();
    if (zone < 1 || zone > 60) return `has no zone ${zone} (zones are 1 to 60)`;
    if (!MGRS_BANDS.includes(band)) return `has no latitude band ${band}`;
    const set = zone % 6 || 6;
    if (!MGRS_COLS[(set - 1) % 3].includes(col) || !MGRS_ROWS.includes(row)) return `has no square ${col}${row} in zone ${zone}`;
    if (digits && !gridToLatLon(zone, band, col, row, digits)) return `has square ${col}${row} outside band ${zone}${band}`;
    return '';
};
const mgrsLockChecks = (text, prefix) => {
    const p = mgrsPrefix(prefix);
    return String(text || '').split(',').map(s => s.trim()).filter(Boolean).map(t => {
        let why = '';
        if (/^\d+(?:\s+\d+)*$/.test(t)) {
            const groups = t.split(/\s+/);
            if (groups.join('').length < 4) return null;
            why = lockDigitsWhy(groups);
            const [, z, b, c, r] = p ? /^(\d+)([A-Z]) ([A-Z])([A-Z])$/.exec(p) : [];
            const square = !why && p ? lockSquareWhy(+z, b, c, r, groups.join('')) : '';
            if (square) why = `would be in ${p}, which ${square}`;
        } else {
            const m = /^(\d{1,2})\s*([A-Z])\s*([A-Z])\s*([A-Z])\s*(\d[\d\s]*)$/i.exec(t);
            if (!m) return null;
            const groups = m[5].trim().split(/\s+/);
            why = lockSquareWhy(+m[1], m[2], m[3], m[4]) || lockDigitsWhy(groups) || lockSquareWhy(+m[1], m[2], m[3], m[4], groups.join(''));
        }
        return why ? { text: t, why } : null;
    }).filter(Boolean);
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
// part of the name. How sure the observer was may come before the count, as
// the Statistics read it too: "poss 3x APCs" -> 3 of "poss APCs". The type is
// as written, for display.
const bdaCount = (text) => {
    const s = String(text || '').trim(), h = HEDGE.exec(s);
    const after = h ? sizeCount(s.slice(h[0].length)) : null;
    if (after && after.counted) return { count: after.count, type: `${h[0].trim()} ${after.text}`, counted: true };
    const c = sizeCount(s);
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

// The Size as it now stands: each element less what has been assessed
// Destroyed of its type (paired as bdaPending pairs them, taken from the
// elements in order; Damaged and the other effects still count). The stored
// Size is never changed, so undoing or deleting an assessment brings the
// count back.
//   size    the remaining Size, written as it was ("20x tanks, 2x BMP-2"
//           with 3 destroyed -> "17x tanks, 2x BMP-2"; "T-72 x4" -> "T-72 x1";
//           "2x possible tanks" -> "1x possible tanks"); an element brought
//           to none is dropped, with its separator; never below none
//   logged  the Size as logged
//   taken   what came off, by element type: [{ count, type }]
//   note    "BDA: 3x tanks destroyed", or '' when nothing came off
//   shown   `size` for people to read: 'None left' when everything was
//           destroyed
// Assessments of types the Size doesn't name, and destroyed past an
// element's count, take nothing; text it can't count stays as it is.
const sizeAfterBda = (report, team = null) => {
    const logged = report && report.size != null ? String(report.size) : '';
    const left = {};
    ((report && report.bda) || []).forEach(b => {
        if (!b || b.effect !== 'Destroyed') return;
        const c = bdaCount(b.target), k = bdaTypeKey(c.type, team);
        if (k && c.count > 0) left[k] = (left[k] || 0) + c.count;
    });
    const same = { size: logged, logged, taken: [], note: '', shown: logged };
    if (!Object.keys(left).length) return same;
    // The elements as bdaElements splits them: at least two characters, the first 20.
    const parts = logged.split(/([,;+])/), kept = [], taken = new Map();
    let n = 0;
    for (let i = 0; i < parts.length; i += 2) {
        const raw = parts[i], t = raw.trim();
        let text = raw;
        if (t.length >= 2 && n++ < 20) {
            const c = bdaCount(t), k = bdaTypeKey(c.type, team);
            const off = k ? Math.min(c.count, left[k] || 0) : 0;
            if (off) {
                left[k] -= off;
                const was = taken.get(k);
                taken.set(k, { count: (was ? was.count : 0) + off, type: was ? was.type : c.type });
                text = off === c.count ? null : raw.replace(t, () => withCount(t, c.count - off));
            }
        }
        if (text !== null) kept.push({ sep: i ? parts[i - 1] : '', text });
    }
    if (!taken.size) return same;
    const size = kept.map((p, j) => (j ? p.sep + p.text : p.text)).join('').trim();
    const list = [...taken.values()];
    return { size, logged, taken: list, note: `BDA: ${list.map(e => `${e.count}x ${e.type}`).join(', ')} destroyed`, shown: size || 'None left' };
};
// An element written with another count, the rest as it was: the number
// first ("20x tanks", "possible 20x tanks", "approx 20 tanks") or last
// ("T-72 x4", "vics 10x", "trucks (3)").
const withCount = (text, count) => {
    const h = HEDGE.exec(text), after = h && sizeCount(text.slice(h[0].length)).counted;
    const head = after ? h[0] : '', rest = after ? text.slice(h[0].length) : text;
    const c = sizeCount(rest);
    if (!c.counted) return text;
    return head + (c.lead ? rest.replace(/(^|[^A-Za-z0-9-])\d+/, (m, p) => `${p}${count}`)
        : rest.replace(/\d+(?=\D*$)/, () => String(count)));
};
// The remaining Size alone (sizeAfterBda): what the Statistics, the summaries
// and the exports count.
const effectiveSize = (report, team = null) => sizeAfterBda(report, team).size;

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
    if (r.observer) out += ` Observer : ${r.observer}\n`;
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

// The built-in overlay types, as the server's _OVERLAY_TYPES, and how deep
// each geometry's coordinates nest above the [lon, lat] pairs (its
// _GEOMETRY_DEPTH). An overlay's type can also be one of the team's own tags,
// by its id (TAG_ID, as the server's _TAG_ID_RE), or '' for none. NAI, OBJ
// and PL name places (PLACE_TYPES); an axis of advance (AXIS) names none: it
// gives the enemy's way of march near it (wayOfMarchAt).
const PLACE_TYPES = new Set(['NAI', 'OBJ', 'PL']);
const OVERLAY_TYPES = new Set([...PLACE_TYPES, 'AXIS']);
// The names a tag of the team's can't have: the built-in tags', as the
// server's _BUILT_IN_TAG_NAMES.
const BUILT_IN_TAG_NAMES = new Set([...OVERLAY_TYPES, 'AXIS OF ADVANCE']);
const TAG_ID = /^tag-[a-z0-9]{1,16}$/;
const isOverlayType = (t) => typeof t === 'string' && (OVERLAY_TYPES.has(t) || t === '' || TAG_ID.test(t));
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
    const ok = isOverlayType(o.type) && typeof o.name === 'string' && o.name !== ''
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

// The team's own tags ({ id, name, color }) from what a backup or the server
// holds: each one the server would take (as its read_tags), the rest left out.
const cleanTags = (value) => {
    if (!Array.isArray(value)) return [];
    const ids = new Set(), names = new Set();
    return value.filter(t => {
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !TAG_ID.test(t.id) || ids.has(t.id)) return false;
        const name = typeof t.name === 'string' ? t.name.trim() : '';
        const key = name.toUpperCase();
        if (!name || name.length > 30 || names.has(key) || BUILT_IN_TAG_NAMES.has(key)) return false;
        if (typeof t.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(t.color)) return false;
        ids.add(t.id); names.add(key);
        return true;
    }).slice(0, 30).map(t => ({ id: t.id, name: t.name.trim(), color: t.color.toLowerCase() }));
};
// And for a backup's machine data: only when there are any.
const tagsData = (tags) => { const t = cleanTags(tags); return t.length ? { tags: t } : {}; };

// One workspace's backup file. `reps` is exported as-is in the machine data
// (deleted flags included); only live reports are listed for reading. The
// shared overlays (and the narrative's settings and tags) go in every file.
const backupText = (ato, reps, title, profiles, formats, now = new Date(), overlays = [], narrative = null, tags = []) => {
    const active = reps.filter(r => !r.deleted);
    return `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH: ATO BACKUP\n ATO Designator : ${ato}\n Report Title   : ${title}\n Total Reports  : ${active.length}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`
        + backupReportBlocks(active)
        + backupMachineData({ workspaces: { [ato]: reps }, config: { ato, title }, profiles: profiles||{},
            formats: formats[ato] ? { [ato]: formats[ato] } : {}, overlays: foldOverlays(overlays), ...narrativeData(narrative), ...tagsData(tags) });
};

// Every given workspace in one file.
const allWorkspacesBackupText = (workspaces, activeAto, title, profiles, formats, now = new Date(), overlays = [], narrative = null, tags = []) => {
    const atoKeys   = Object.keys(workspaces);
    const totalReps = atoKeys.reduce((n, k) => n + (workspaces[k]||[]).filter(r => !r.deleted).length, 0);
    let out = `${BACKUP_DIV}\n S.A.L.T. REPORT WORKBENCH: FULL BACKUP (ALL ATOs)\n ATOs Included  : ${atoKeys.join(', ')}\n Total Reports  : ${totalReps}\n Exported       : ${backupStamp(now)}\n${BACKUP_DIV}\n\n`;
    atoKeys.forEach(ato => {
        const active   = (workspaces[ato]||[]).filter(r => !r.deleted);
        const atoTitle = (active.find(r => r.title)||{}).title || ato;
        out += `${BACKUP_DIV}\n ATO: ${ato}  -  ${atoTitle}  (${plural(active.length, 'report')})\n${BACKUP_DIV}\n\n`;
        out += backupReportBlocks(active);
    });
    return out + backupMachineData({ workspaces, config: { ato: activeAto, title }, profiles: profiles||{}, formats, overlays: foldOverlays(overlays), ...narrativeData(narrative), ...tagsData(tags) });
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
        return { error: 'Import failed: file does not contain a recognizable backup payload.' };
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

// Whether any of the reports, or a saved version of one, names its observer.
const anyObserver = (reps) => (reps || []).some(r => r && (r.observer || (r.history || []).some(h => h && h.observer)));

// The CSV export: each report, then its history, then its BDA assessments.
// Custom builder fields become extra columns after Analysis, so the first
// seven stay index-stable for existing consumers; FMV mode's Observer (the
// drone it was seen from) comes last, when `observer` (by default: when any
// report names one).
// A report's Size is what is left after BDA (sizeAfterBda); when BDA has
// taken from any, a last "Size (as logged)" column holds each one as it was
// logged (`team`: the team's equipment). Saved versions are as they were logged.
// `latestOnly`: one row per report (its current version), so a platform that
// plots every row puts each report on the map once.
const reportsCsv = (reps, { local, customLabels, idOf, latestOnly = false, observer = anyObserver(reps), team = null }) => {
    const t = d => toTimeString(d, local);
    const cus = (o) => customLabels.map(c => csvField((o || {})[c] || ''));
    const obs = (v) => (observer ? [csvField(v || '')] : []);
    const sizes = new Map(reps.map(r => [r, sizeAfterBda(r, team)]));
    const logged = [...sizes.values()].some(s => s.note);
    const was = (v) => (logged ? [csvField(v || '')] : []);
    let csv = csvHeader(local, [...customLabels, ...(observer ? ['Observer'] : []), ...(logged ? ['Size (as logged)'] : [])]);
    for (const r of reps) {
        const id = idOf(r);
        csv += [csvField(id),csvField(r.updated?'Current Update':'Original'),csvField(sizes.get(r).size),csvField(r.activity),csvField(r.location),csvField(t(r.time)),csvField(r.yourAnalysis),...cus(r.custom),...obs(r.observer),...was(r.size)].join(',')+'\r\n';
        if (latestOnly) continue;
        historyRows(r).forEach(([label, hh]) => {
            csv += [csvField(id),csvField(label),csvField(hh.size),csvField(hh.activity),csvField(hh.location),csvField(t(hh.time)),csvField(hh.yourAnalysis),...cus(hh.custom),...obs(hh.observer),...was(hh.size)].join(',')+'\r\n';
        });
        // BDA assessments ride the existing columns: target in Size,
        // effect in Activity, coords in MGRS, note in Analysis.
        (r.bda||[]).forEach((b,i) => {
            csv += [csvField(id),csvField(`BDA #${i+1}`),csvField(b.target),csvField(b.effect),csvField(b.coords),csvField(t(b.time)),csvField(b.note),...customLabels.map(()=>csvField('')),...obs(''),...was('')].join(',')+'\r\n';
        });
    }
    return csv;
};

// An MTI count in a Size, written the way operators write them: "4 tracked",
// "4x tracked", or "4 x tracked" (`kind` 'tracked' or 'wheeled'), as
// { text: "4x tracked", n: 4 }; or null.
const mtiCount = (size, kind) => {
    const m = new RegExp(`(\\d+)\\s*x?\\s*${kind}`).exec(String(size || '').toLowerCase());
    return m ? { text: m[0].trim(), n: Number(m[1]) } : null;
};

// MTI export: the tracked and wheeled vehicle counts found in each Size
// (current version and history), as two CSVs. The current version's Size
// is what is left after BDA (sizeAfterBda).
const mtiCsvs = (reps, { local, idOf, team = null }) => {
    const t = d => toTimeString(d, local);
    const out = { tracked: csvHeader(local), wheeled: csvHeader(local), trackedRows: 0, wheeledRows: 0 };
    const row = (id, upd, size, activity, location, time, analysis) => {
        const tm = mtiCount(size, 'tracked');
        if (tm) { out.tracked += [csvField(id),csvField(upd),csvField(tm.text),csvField(activity),csvField(location),csvField(t(time)),csvField(analysis)].join(',')+'\r\n'; out.trackedRows++; }
        const wm = mtiCount(size, 'wheeled');
        if (wm) { out.wheeled += [csvField(id),csvField(upd),csvField(wm.text),csvField(activity),csvField(location),csvField(t(time)),csvField(analysis)].join(',')+'\r\n'; out.wheeledRows++; }
    };
    for (const r of reps) {
        const id = idOf(r);
        row(id, r.updated?'Current Update':'Original', effectiveSize(r, team), r.activity, r.location, r.time, r.yourAnalysis);
        historyRows(r).forEach(([label, hh]) => row(id, label, hh.size, hh.activity, hh.location, hh.time, hh.yourAnalysis));
    }
    return out;
};

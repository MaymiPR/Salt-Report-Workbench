// SPDX-License-Identifier: AGPL-3.0-only
// Dates and times, and text safety. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Dates and times ---

const pad2 = n => String(n).padStart(2, '0');

// Calendar and clock fields of a Date, zero-padded, in local time or UTC (Zulu).
const dateFields = (d, local) => local
    ? { y: d.getFullYear(),    mo: pad2(d.getMonth() + 1),    day: pad2(d.getDate()),    h: pad2(d.getHours()),    mi: pad2(d.getMinutes()) }
    : { y: d.getUTCFullYear(), mo: pad2(d.getUTCMonth() + 1), day: pad2(d.getUTCDate()), h: pad2(d.getUTCHours()), mi: pad2(d.getUTCMinutes()) };

// "HH:MM", the format of the time inputs.
const clockValue = (d, local) => { const f = dateFields(d, local); return `${f.h}:${f.mi}`; };

// The letter after a time: L in local time, else Z (Zulu, UTC).
const zoneMark = (local) => (local ? 'L' : 'Z');
// "3 reports", "1 report": a count and its word, plural unless one.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "just now", "12 min ago", "6h ago", "3 days ago": how long before `now` a time was.
const timeAgo = (ms, now = Date.now()) => {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 48 * 3600) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)} days ago`;
};

// "YYYYMMDD_HHMMZ" (or "...L"), for export filenames.
const fileStamp = (d, local) => { const f = dateFields(d, local); return `${f.y}${f.mo}${f.day}_${f.h}${f.mi}${zoneMark(local)}`; };

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
    return `${f.h}${f.mi}${zoneMark(local)}`;
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

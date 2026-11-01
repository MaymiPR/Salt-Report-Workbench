// SPDX-License-Identifier: AGPL-3.0-only
// Statistics, the Excel workbook, and summary reports. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Statistics ---

// Words that say how many, not what: "total of", "approx", "about".
const SIZE_FILLER = /\b(?:total(?:\s+of)?|approx(?:imately)?|about|around|est(?:imated)?|at\s+least|up\s+to)\b\.?|~/gi;
// One element's count and its type as written: "2x T-72", "4 BMP-2", "vics
// 10x", "vics x10", "trucks (3)", "truck". `counted` says a number was given,
// `lead` that it came first (else last: "vics 10x", "trucks (3)").
// A number run into a name ("2S19") is part of the name.
const sizeCount = (part) => {
    const text = part.replace(SIZE_FILLER, ' ').replace(/\s+/g, ' ').trim();
    let count = 1, type = text, counted = false, lead = false, m;
    if ((m = /^(\d+)\s*(?:x\s*|\s+)(\S.*)$/i.exec(text))) { count = Number(m[1]); type = m[2]; counted = true; lead = true; }
    else if ((m = /^(.+?)\s+(?:(\d+)\s*x|x\s*(\d+))$/i.exec(text) || /^(.+?)\s*\((\d+)\)$/.exec(text))) {
        count = Number(m[2] || m[3]); type = m[1]; counted = true;
    }
    return { count, text: type.replace(/^of\s+/i, '').trim(), counted, lead };
};
// One element as the Statistics count it: its type upper-cased and singular.
// "2x possible tanks", "poss 3x APCs", "1x probable heli", "2x likely a heli":
// how sure the observer was, before the type or the count. The type is read
// without it; the element keeps it as `hedge` ('possible', 'probable' or
// 'likely'), so the narrative can weigh it less.
const HEDGE = /^(poss(?:ible|ibly)?|psbl|suspected|susp|prob(?:able|ably)?|likely)\.?\s+(?:an?\s+)?/i;
const hedgeOf = (word) => (!word ? null : /^l/i.test(word) ? 'likely' : /^prob/i.test(word) ? 'probable' : 'possible');
const sizePart = (part, team = null) => {
    const before = HEDGE.exec(part.trim());
    const { count, text: rest, counted } = sizeCount(before ? part.trim().slice(before[0].length) : part);
    const after = before ? null : HEDGE.exec(rest);
    const text = after ? rest.slice(after[0].length) : rest;
    const hedge = hedgeOf((before || after || [])[1]);
    return { count, type: singularType(text, team).toUpperCase(), counted, ...(hedge && text ? { hedge } : {}) };
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
    const plain = ({ count, type, hedge }) => (hedge ? { count, type, hedge } : { count, type });
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
// Equipment is counted from what is left after BDA (sizeAfterBda).
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
        sizeElements(effectiveSize(r, team), team).forEach(e => add(equipment, e.type, e.count));
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
// in Local mode it is the browser's local time. The Size is what is left
// after BDA (sizeAfterBda); when BDA has taken from any report, a "Size (as
// logged)" column after "BDA assessed" holds each one as it was logged.
const excelSerial = (ms, local) => {
    const off = local ? new Date(ms).getTimezoneOffset() * 60000 : 0;
    return (ms - off) / 86400000 + 25569;
};
const workbookReportRows = (reps, overlays, { local, idOf, customLabels = [], team = null }) => {
    const live = (reps || []).filter(r => !r.deleted).sort((a, b) => reportNum(a) - reportNum(b));
    const sizes = new Map(live.map(r => [r, sizeAfterBda(r, team)]));
    const logged = [...sizes.values()].some(s => s.note);
    const header = ['Identifier', 'Status', 'By', 'Size', 'Activity', 'Location', `Time (${local ? 'Local' : 'Z'})`, 'Analysis',
        'NAI / OBJ / PL', 'Activity tags', 'Heading', 'BDA assessed', ...(logged ? ['Size (as logged)'] : []), 'Updates', ...customLabels];
    const rows = live.map(r => {
        const a = analyzeLocation(r.location, overlays);
        const act = classifyActivity(r.activity);
        const ms = new Date(r.time).getTime();
        const b = bdaSummary(r);
        return [idOf(r), r.updated ? 'Updated' : 'Original', (r.user && r.user.initials) || '', sizes.get(r).size, r.activity || '',
            r.location || '', isNaN(ms) ? '' : { date: excelSerial(ms, local) }, r.yourAnalysis || '',
            [...a.nai.keys, ...a.obj.keys, ...a.pls].join(', '), act.tags.join(', '), act.heading || '',
            b.done ? `${b.done} of ${b.total}` : '', ...(logged ? [r.size || ''] : []), (r.history || []).length,
            ...customLabels.map(c => (r.custom || {})[c] || '')];
    });
    return { header, rows };
};

// A workbook (.xlsx) of the Statistics panel: a Statistics sheet with the
// headline numbers and each chart's table beside an Excel chart drawn from
// it (so it can be restyled and updates when a number is changed), and a
// Reports sheet holding the report table as an Excel table with filters.
// Written by hand, as the zip of XML parts an .xlsx is, so nothing needs a
// library. Styled to match the app: system font, one blue, and thin grey
// outlines on every cell of each table (header included), nowhere else.
//   opts: { title, context, kpis: [{ label, value }],
//           charts: [{ title, note, unit, kind: 'bar' | 'column', axis, items: [{ label, value }] }],
//           reports: { header, rows } }
const XLSX_BLUE = '007AFF', XLSX_INK = '1D1D1F', XLSX_INK2 = '6E6E73', XLSX_GRID = 'E5E5EA', XLSX_AXIS = 'D2D2D7', XLSX_LINE = 'C7C7CC';
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

// Cell styles (the order of cellXfs below). The box styles, and head, are a
// table's cells, outlined; the others have no border.
const XS = { plain: 0, head: 1, title: 2, muted: 3, date: 4, section: 5, kpi: 6, box: 7, boxDate: 8, boxMuted: 9, boxKpi: 10 };
const XS_BOXED = new Set([XS.head, XS.box, XS.boxDate, XS.boxMuted, XS.boxKpi]);
const thinSide = (side) => `<${side} style="thin"><color rgb="FF${XLSX_LINE}"/></${side}>`;
const XLSX_STYLES = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>'
    + '<fonts count="5">'
    + [[false, 10, XLSX_INK], [true, 10, XLSX_INK], [true, 18, XLSX_INK], [false, 10, XLSX_INK2], [true, 12, XLSX_INK]]
        .map(([b, sz, c]) => `<font>${b ? '<b/>' : ''}<sz val="${sz}"/><color rgb="FF${c}"/><name val="${XLSX_FONT}"/><family val="2"/></font>`).join('')
    + '</fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF${XLSX_AXIS}"/></bottom><diagonal/></border>`
    + `<border>${['left', 'right', 'top', 'bottom'].map(thinSide).join('')}<diagonal/></border></borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="11">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>'
    + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf>'
    + '<xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf>'
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
    // Bars carry their values; columns read off the axis, with the peak labeled.
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
    // A cell: number, string, { date }, or empty; `s` is its style. An empty
    // cell in a table is still written, for its outline.
    const cell = (ref, v, s = XS.plain) => {
        const boxed = XS_BOXED.has(s);
        if (v === '' || v === null || v === undefined) return boxed ? `<c r="${ref}" s="${s}"/>` : '';
        if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        if (typeof v === 'object' && 'date' in v) return `<c r="${ref}" s="${boxed ? XS.boxDate : XS.date}"><v>${v.date}</v></c>`;
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
        kpis.forEach(k => rows.push(rowXml(r++, [[0, k.label, XS.boxMuted], [1, k.value, XS.boxKpi]], 20)));
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
        ch.items.forEach(it => rows.push(rowXml(r++, [[0, String(it.label), XS.box], [1, Number(it.value) || 0, XS.box]])));
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
    const widths = heads.map(h => ({ Identifier: 18, Status: 10, By: 6, Size: 22, Activity: 28, Location: 30, Analysis: 36, 'NAI / OBJ / PL': 18, 'Activity tags': 20, Heading: 9, 'BDA assessed': 13, 'Size (as logged)': 22, Updates: 9 }[h] || (/^Time/.test(h) ? 17 : 16)));
    const reportsSheet = sheetHead('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>')
        + (widths.length ? colsXml(widths) : '')
        + `<sheetData>${[rowXml(1, heads.map((h, c) => [c, h, XS.head]), 20), ...repRows.map((row, i) => rowXml(i + 2, (heads.length ? heads : row).map((_, c) => [c, row[c], XS.box])))].join('')}</sheetData>`
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
    return `${f.day}${f.h}${f.mi}${zoneMark(local)} ${MONTHS[+f.mo - 1]} ${String(f.y).slice(2)}`;
};
// "251400Z": day and time, so a list crossing midnight still reads in order.
const dayTime = (ms, local) => { const d = timeOf(ms); if (!d) return NO_TIME; const f = dateFields(d, local); return `${f.day}${f.h}${f.mi}${zoneMark(local)}`; };
const countList = (items) => items.map(i => `${i.label} ${i.value}`).join(', ');

// What the summaries need about each report, worked out once. `size` is its
// Size after BDA (sizeAfterBda; `shown` to print), what they count and quote.
const reportFacts = (r, overlays, team = null) => {
    const a = analyzeLocation(r.location, overlays);
    const act = classifyActivity(r.activity);
    const size = sizeAfterBda(r, team);
    return {
        r, a, act, ms: new Date(r.time).getTime(), size: size.size, shown: size.shown,
        places: [...a.nai.keys, ...a.obj.keys],
        pls: a.pls,
    };
};
const oneLine = (f) => `${f.shown || '-'}; ${f.r.activity || '-'}; ${f.r.location || '-'}`;
const reportLine = (f, local) => `${dayTime(f.ms, local)}  ${pad(f.r.displayId || f.r.id || '', 9)} ${oneLine(f)}`;
const pad = (s, n) => String(s).padEnd(n);

// The busiest hour among some reports: "0200Z (3)".
const peakHour = (facts, local) => {
    const hours = new Array(24).fill(0);
    facts.forEach(f => { hours[+dateFields(new Date(f.ms), local).h]++; });
    const h = hours.indexOf(Math.max(...hours));
    return facts.length ? `${pad2(h)}00${zoneMark(local)} (${hours[h]})` : '-';
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
const summaryReport = (kind, reps, overlays, opts) => summaryDetail(kind, reps, overlays, opts).text;
// The same report with what is behind it: { text, judgments, annex }, `text`
// being summaryReport's, and for the narrative one entry per judgment shown,
// { rule, level, line, detail, sources }: its rule's id ('custom' for the
// team's own), its likelihood (an index into ICD203), the index in the
// text's lines of the last line of its entry in the assessment, the lines of
// its detail in the annex ([from, to), after its first sentence), and the
// reports behind it by id (reportKey), in time order; and the annex's lines
// ([from, to), its heading first), or null. Other kinds have no judgments
// and no annex.
const summaryDetail = (kind, reps, overlays, opts) => {
    const { local, from = null, to = null, now = new Date(), ato = '', title = '', by = '', place = '', squareDigits = 2, narrative = null, width = 100 } = opts;
    if (!Object.prototype.hasOwnProperty.call(SUMMARY_KINDS, kind)) kind = 'rollup';
    const team = opts.team !== undefined ? opts.team : narrative ? narrativeSettings(narrative).team : null;
    const facts = (reps || []).filter(r => !r.deleted).map(r => reportFacts(r, overlays, team))
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
    let judgments = [], annex = null;

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
        out.push('', '4. BUSIEST HOURS', `   ${hours.map(h => `${h.label}00-${h.label}59${zoneMark(local)} (${h.value})`).join(', ') || 'none'}`);
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
        const n = narrativeLines(cur, prev, { local, hrs, end: to === null ? now.getTime() : to, places: placesTop, settings: narrative, overlays, width });
        const at = out.length;
        judgments = n.judgments.map(j => ({ ...j, line: at + j.line, detail: j.detail && j.detail.map(i => at + i) }));
        annex = n.annex && n.annex.map(i => at + i);
        out.push(...n.lines);
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
    return { text: out.join('\n') + '\n', judgments, annex };
};

// Every place the summaries can be about: overlays, and whatever is named.
const summaryPlaces = (reps, overlays) => {
    const d = statsData(reps, overlays, {});
    // NAI, OBJ and PL only: the team's own tags name places in Location, not here.
    const builtIn = (overlays || []).filter(o => overlayOk(o) && PLACE_TYPES.has(o.type));
    const keys = new Set([...builtIn.map(overlayKey), ...d.nai, ...d.obj, ...d.pl].map(x => x.label || x));
    const order = { NAI: 0, OBJ: 1, PL: 2 };
    return [...keys].sort((a, b) => order[a.split(' ')[0]] - order[b.split(' ')[0]] || a.localeCompare(b, undefined, { numeric: true }));
};

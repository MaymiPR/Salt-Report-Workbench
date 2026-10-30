// SPDX-License-Identifier: AGPL-3.0-only

// Tests for src/core/, the page's pure logic. Node's built-in runner, no
// packages:  node --test tests/js/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./load-core.js');

const SALT = { lines: [{ type: 'id' }, { type: 'size' }, { type: 'activity' }, { type: 'location' }, { type: 'time' }] };
const SALT_U = { lines: [{ type: 'size' }, { type: 'activity' }, { type: 'location' }, { type: 'time' }, { type: 'id' }] };
const NOW = new Date('2026-10-24T15:07:00Z');

const report = (extra = {}) => ({
    id: 'r1', displayId: 'ALPHA001', ato: 'ALPHA', title: 'Patrol', fullId: 'PatrolALPHA001',
    size: '2x T-72', activity: 'Moving NE', location: '18SUJ2337106519',
    time: '2026-10-24T04:12:00Z', yourAnalysis: '', updated: false, lastModified: 10, history: [],
    ...extra,
});

// --- Dates and times ---

test('times render in Zulu, or in the browser\'s local time', () => {
    assert.equal(core.toTimeString('2026-10-24T04:12:00Z', false), '0412Z');
    const d = new Date('2026-10-24T04:12:00Z');
    const local = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}L`;
    assert.equal(core.toTimeString(d, true), local);
});

test('unparseable times pass through instead of rendering NaN', () => {
    assert.equal(core.toTimeString('yesterday', false), 'yesterday');
});

test('no time, or an invalid one, prints as a dash in every format', () => {
    [null, undefined, '', 0, new Date(NaN), NaN].forEach(v => assert.equal(core.toTimeString(v, false), '-', String(v)));
    [null, undefined, NaN, 'nonsense'].forEach(v => assert.equal(core.dtg(v, false), '-', String(v)));
    assert.equal(core.dtg(Date.parse('2026-10-25T18:00:00Z'), false), '251800Z OCT 26');
    const text = core.backupText('ALPHA', [report({ time: null }), report({ id: 'r2', displayId: 'ALPHA002', time: 'garbage' })], 'Patrol', {}, {}, NOW);
    assert.equal((text.match(/ Time {5}: -\n/g) || []).length, 2, text);
    assert.ok(!/NaN/.test(text));
});

test('typed times gain their colon', () => {
    assert.equal(core.autoColon('1430'), '14:30');
    assert.equal(core.autoColon(' 930 '), '09:30');
    assert.equal(core.autoColon('14:30'), null, 'already formatted');
    assert.equal(core.autoColon('2460'), null, 'not a time');
    assert.equal(core.autoColon('12345'), null);
    assert.equal(core.autoColon(''), null);
});

test('export filenames carry a stamp in the active time mode', () => {
    assert.equal(core.fileStamp(NOW, false), '20261024_1507Z');
    assert.match(core.fileStamp(NOW, true), /^\d{8}_\d{4}L$/);
});

test('filter bounds default to the whole day and ignore bad times', () => {
    const start = core.parseFilterTime('2026-10-24', '', false, false);
    const end = core.parseFilterTime('2026-10-24', '25:00', true, false);
    assert.equal(new Date(start).toISOString(), '2026-10-24T00:00:00.000Z');
    assert.equal(new Date(end).toISOString(), '2026-10-24T23:59:59.999Z');
    assert.equal(new Date(core.parseFilterTime('2026-10-24', '9:05', false, false)).toISOString(), '2026-10-24T09:05:00.000Z');
    assert.equal(core.parseFilterTime('', '10:00', false, false), null);
});

test('a typed time more than an hour ahead belongs to yesterday', () => {
    const now = new Date('2026-10-25T00:30:00Z');  // a US evening: the Zulu day just rolled over
    assert.equal(core.typedTime('23:50', false, now), '2026-10-24T23:50:00.000Z', 'forty minutes ago');
    assert.equal(core.typedTime('00:10', false, now), '2026-10-25T00:10:00.000Z');
    assert.equal(core.typedTime('1:15', false, now), '2026-10-25T01:15:00.000Z', 'within the hour: still today');
    assert.equal(core.typedTime('02:00', false, now), '2026-10-24T02:00:00.000Z', 'ninety minutes ahead: yesterday');
    assert.equal(core.typedTime('24:00', false, now), null);
    assert.equal(core.typedTime('1430', false, now), null, 'autoColon runs first');
    // Local mode: same rule on the local clock.
    const local = core.typedTime('12:00', true, now);
    const d = new Date(local);
    assert.equal(`${d.getHours()}:${d.getMinutes()}`, '12:0');
    assert.ok(d.getTime() - now.getTime() <= 3600_000);
});

test('an edited report keeps its timestamp unless the time was actually changed', () => {
    const now = new Date('2026-10-25T00:30:00Z');
    const orig = '2026-10-21T14:30:00Z';  // four days old
    assert.equal(core.submittedTime('14:30', false, orig, now), orig, 'untouched time box: same timestamp, same day');
    assert.equal(core.submittedTime('14:31', false, orig, now), '2026-10-24T14:31:00.000Z', 'changed: placed by typedTime (14 h ahead, so yesterday)');
    assert.equal(core.submittedTime('00:45', false, orig, now), '2026-10-25T00:45:00.000Z', 'changed, within the hour: today');
    assert.equal(core.submittedTime('', false, orig, now), now.toISOString(), 'blank means now');
    assert.equal(core.submittedTime('00:45', false, null, now), '2026-10-25T00:45:00.000Z', 'new report: today');
    assert.equal(core.submittedTime('24:00', false, orig, now), null);
});

test('spreadsheet times are read in the common forms', () => {
    const now = new Date('2026-10-24T20:00:00Z');
    const p = s => core.parseCsvTime(s, false, now);
    assert.equal(p('2026-10-24T14:30:00Z'), '2026-10-24T14:30:00.000Z', 'ISO');
    assert.equal(p('2026-10-24T14:30:00.500Z'), '2026-10-24T14:30:00.500Z');
    assert.equal(p('2026-10-24 14:30'), '2026-10-24T14:30:00.000Z', 'date and time in the active mode');
    assert.equal(p('2026-10-24 9:05:30'), '2026-10-24T09:05:30.000Z');
    assert.equal(p('14:30'), '2026-10-24T14:30:00.000Z', 'time only: today');
    assert.equal(p('1430'), '2026-10-24T14:30:00.000Z');
    assert.equal(p('1430Z'), '2026-10-24T14:30:00.000Z');
    assert.equal(p('241430Z'), '2026-10-24T14:30:00.000Z', 'DTG, this month');
    assert.equal(p('241430ZOCT26'), '2026-10-24T14:30:00.000Z');
    assert.equal(p('15 0900Z SEP 2026'), '2026-09-15T09:00:00.000Z');
    assert.equal(p('yesterday'), null);
    assert.equal(p('24/10/2026'), null);
    assert.equal(p(''), null);
    assert.equal(p('2026-13-45 10:00'), null, 'nonsense dates are not guessed');
    const l = core.parseCsvTime('2026-10-24 14:30', true, now);
    assert.equal(new Date(l).getHours(), 14, 'local mode reads the clock as local');
});

test('spreadsheet times that do not exist are refused, never rolled over', () => {
    const now = new Date('2026-10-24T20:00:00Z');
    const p = s => core.parseCsvTime(s, false, now);
    assert.equal(p('311430ZNOV26'), null, '31 NOV');
    assert.equal(p('992599Z'), null, 'day 99, hour 25');
    assert.equal(p('312400Z'), null);
    assert.equal(p('2026-02-30 10:00'), null, '30 FEB');
    assert.equal(p('2026-10-24 24:00'), null);
    assert.equal(p('2028-02-29 10:00'), '2028-02-29T10:00:00.000Z', 'a leap day');
    // A DTG without Z or L is Zulu, even when the page shows local time.
    assert.equal(core.parseCsvTime('241430', true, now), '2026-10-24T14:30:00.000Z');
    // Month or year left out: the latest such date not in the future.
    const on = (iso, s) => core.parseCsvTime(s, false, new Date(iso));
    assert.equal(on('2026-11-01T08:00:00Z', '311430Z'), '2026-10-31T14:30:00.000Z', 'on the 1st, the 31st is last month');
    assert.equal(on('2026-03-02T08:00:00Z', '301200Z'), '2026-01-30T12:00:00.000Z', 'February has no 30th');
    assert.equal(on('2027-01-01T08:00:00Z', '311430ZDEC'), '2026-12-31T14:30:00.000Z', 'December, last year');
    assert.equal(on('2026-10-24T20:00:00Z', '242030Z'), '2026-10-24T20:30:00.000Z', 'within the hour ahead: today');
    assert.equal(on('2026-10-24T20:00:00Z', '252030Z'), '2026-09-25T20:30:00.000Z', 'tomorrow is a month ago');
    // L reads the DTG in local time, as it does a time alone.
    const l = new Date(p('241430L'));
    assert.deepEqual([l.getDate(), l.getHours(), l.getMinutes()], [24, 14, 30]);
    const l2 = new Date(core.parseCsvTime('241430LOCT26', false, now));
    assert.deepEqual([l2.getMonth(), l2.getDate(), l2.getHours()], [9, 24, 14]);
});

// --- Text safety ---

test('HTML, colors, and filenames are made safe', () => {
    assert.equal(core.escapeHtml('<b a="1">\'&'), '&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
    assert.equal(core.safeColor('#0a84ff'), '#0a84ff');
    assert.equal(core.safeColor('red;background:url(x)'), 'var(--system-gray)');
    assert.equal(core.safeFilename('A/B 1'), 'A_B_1');
    assert.equal(core.safeFilename('///'), 'X');
    // Zero is a value, not nothing.
    assert.equal(core.escapeHtml(0), '0');
    assert.equal(core.escapeHtml(null), '');
    assert.equal(core.escapeHtml(undefined), '');
    const csv = core.reportsCsv([report({ size: 0 })], { local: false, customLabels: [], idOf: r => r.id }).split('\r\n')[1];
    assert.ok(csv.startsWith('"r1","Original","0",'), csv);
});

// --- Reports ---

test('the ATO prefix is upper case with no dashes, everywhere', () => {
    assert.equal(core.atoPrefix(' alpha-01 '), 'ALPHA01');
    assert.equal(core.atoPrefix('IMPORT'), 'IMPORT');
    assert.equal(core.atoPrefix(null), '');
});

test('one plural and one zone letter for every count and time', () => {
    assert.equal(core.plural(1, 'report'), '1 report');
    assert.equal(core.plural(0, 'report'), '0 reports');
    assert.equal(core.plural(3, 'NAI overlay'), '3 NAI overlays');
    assert.equal(core.zoneMark(true), 'L');
    assert.equal(core.zoneMark(false), 'Z');
    const now = Date.UTC(2026, 9, 28, 12);
    assert.equal(core.timeAgo(now - 20e3, now), 'just now');
    assert.equal(core.timeAgo(now + 5e3, now), 'just now', 'a clock a little ahead');
    assert.equal(core.timeAgo(now - 12 * 60e3, now), '12 min ago');
    assert.equal(core.timeAgo(now - 6 * 3600e3, now), '6h ago');
    assert.equal(core.timeAgo(now - 47 * 3600e3, now), '47h ago');
    assert.equal(core.timeAgo(now - 3 * 86400e3, now), '3 days ago');
});

test('report numbers ignore digits that belong to the ATO', () => {
    assert.equal(core.reportNum({ displayId: 'TEST01001', ato: 'TEST01' }), 1);
    assert.equal(core.reportNum({ displayId: 'ALPHA012', ato: 'ALPHA' }), 12);
    assert.equal(core.reportNum({ displayId: 'LEGACY7' }), 7);
    assert.equal(core.reportNum(null), 0);
});
test('duplicateIds names the numbers live reports share; nextNum is past the highest', () => {
    const r = (id, displayId, extra = {}) => ({ id, displayId, ato: 'ALPHA', ...extra });
    const reps = [r('a', 'ALPHA001'), r('b', 'ALPHA002'), r('c', 'ALPHA002'), r('d', 'ALPHA003'),
        r('e', 'ALPHA003', { deleted: true }), r('f', 'ALPHA009', { deleted: true })];
    assert.deepEqual([...core.duplicateIds(reps)], ['ALPHA002']);
    assert.equal(core.duplicateIds([]).size, 0);
    assert.equal(core.duplicateIds(null).size, 0);
    // A deleted report's number is free again.
    assert.equal(core.nextNum(reps), 4);
    assert.equal(core.nextNum(reps, { withDeleted: true }), 10);
    assert.equal(core.nextNum([]), 1);
    assert.equal(core.displayId('ALPHA', 4), 'ALPHA004');
    assert.equal(core.displayId('ALPHA', '12'), 'ALPHA012');
    assert.equal(core.displayId('ALPHA', 1234), 'ALPHA1234');
});


test('identifiers follow the title separator; legacy rows keep fullId', () => {
    assert.equal(core.formatFullId(report(), 'dash'), 'Patrol - ALPHA001');
    assert.equal(core.formatFullId(report(), 'space'), 'Patrol ALPHA001');
    assert.equal(core.formatFullId({ fullId: 'OLD001' }, 'dash'), 'OLD001');
});

test('copy text follows the format, header first or as a U: line', () => {
    assert.equal(
        core.reportText(report(), SALT, 'dash'),
        'Patrol - ALPHA001\nS: 2x T-72\nA: Moving NE\nL: 18SUJ2337106519\nT: 0412Z',
    );
    assert.equal(
        core.reportText(report({ updated: true }), SALT_U, 'dash').split('\n').pop(),
        'U: Patrol - ALPHA001 (Updated)',
    );
});

test('optional lines appear only when filled, and BDA lines are appended', () => {
    const fmt = { lines: [...SALT.lines, { type: 'analysis' }, { type: 'custom', label: 'W' }] };
    assert.ok(!core.reportText(report(), fmt, 'dash').includes('Y:'));
    const text = core.reportText(report({
        yourAnalysis: 'Recon', custom: { W: 'Rain' },
        bda: [{ effect: 'Destroyed', target: '2x T-72', coords: '18SUJ1', note: 'UAS' }],
    }), fmt, 'dash');
    assert.ok(text.endsWith('Y: Recon\nW: Rain\nBDA 1: Destroyed - 2x T-72 @ 18SUJ1 - UAS'));
});

test('several MGRS grids typed without commas are separated', () => {
    assert.equal(core.normalizeLocation('12ABC123456 21CBA321654'), '12ABC123456, 21CBA321654');
    assert.equal(core.normalizeLocation('12 ABC 123 456 21CBA321654'), '12 ABC 123 456, 21CBA321654');
    assert.equal(core.normalizeLocation('18SUJ123 456 12 ABD 789 012'), '18SUJ123 456, 12 ABD 789 012', 'a zone number starts the next grid');
});

test('locations that are not just grids are left alone', () => {
    assert.equal(core.normalizeLocation('vic hill 205'), 'vic hill 205');
    assert.equal(core.normalizeLocation('12ABC123456, 21CBA321654'), '12ABC123456, 21CBA321654');
    assert.equal(core.normalizeLocation('18SUJ2337106519'), '18SUJ2337106519');
    assert.equal(core.normalizeLocation('12ABC123456 near 21CBA321654'), '12ABC123456 near 21CBA321654');
});

// --- BDA ---

test('BDA elements pair with grids by position, or share a single grid', () => {
    // Grids are read as grids (findGrids), so each is written as MGRS: "18S UJ 11 11".
    const pairs = core.bdaElements({ size: '4x T-72, 2x BMP-2', location: '18SUJ1111, 18SUJ2222' });
    assert.deepEqual(pairs, [{ target: '4x T-72', coords: '18S UJ 11 11' }, { target: '2x BMP-2', coords: '18S UJ 22 22' }]);
    const shared = core.bdaElements({ size: '4x T-72; 2x BMP-2', location: '18SUJ1111' });
    assert.deepEqual(shared.map(p => p.coords), ['18S UJ 11 11', '18S UJ 11 11']);
    const unclear = core.bdaElements({ size: 'a1, b2, c3', location: '18SUJ1111 18SUJ2222' });
    assert.deepEqual(unclear.map(p => p.coords), ['', '', '']);
    // A grid typed with spaces is one grid, and a place name beside it is not a grid.
    assert.deepEqual(core.bdaElements({ size: '2x T-72', location: '38S MB 12345 67890' }).map(p => p.coords), ['38S MB 12345 67890']);
    assert.deepEqual(core.bdaElements({ size: '2x T-72', location: '38SMB1234567890, NAI 1' }).map(p => p.coords), ['38S MB 12345 67890']);
});

test('the BDA pill counts each vehicle and gives the worst outcome', () => {
    const r = { size: '4x T-72, 2x BMP-2', location: '', bda: [{ target: '4x T-72', effect: 'Damaged' }, { target: '1x BMP-2', effect: 'Destroyed' }] };
    assert.deepEqual(core.bdaSummary(r), { done: 5, total: 6, worstCls: 'destroyed' });
    assert.deepEqual(core.bdaSummary({ size: 'x1', bda: [] }), { done: 0, total: 1, worstCls: '' });
});

test('assessing some of an element leaves the rest to assess', () => {
    assert.deepEqual(core.bdaCount('40x T-72'), { count: 40, type: 'T-72', counted: true });
    assert.deepEqual(core.bdaCount('4 BMP-2'), { count: 4, type: 'BMP-2', counted: true });
    assert.deepEqual(core.bdaCount('2S19'), { count: 1, type: '2S19', counted: false }, 'a number in a name');
    const r = { size: '40x T-72, 3x trucks', location: '18SUJ1111', bda: [{ target: '3x T-72', effect: 'Destroyed' }] };
    assert.deepEqual(core.bdaPending(r).map(e => [e.target, e.remaining, e.total]), [['37x T-72', 37, 40], ['3x trucks', 3, 3]]);
    r.bda.push({ target: '2x t-72s', effect: 'Damaged' }, { target: '3x truck', effect: 'Destroyed' });
    assert.deepEqual(core.bdaPending(r).map(e => e.target), ['35x T-72'], 'any case, plural or not');
    assert.deepEqual(core.bdaSummary(r), { done: 8, total: 43, worstCls: 'destroyed' });
    // Assessments from before counts were split off cover their whole element.
    assert.deepEqual(core.bdaPending({ size: '4x T-72, truck', location: '', bda: [{ target: '4x T-72', effect: 'Destroyed' }, { target: 'truck', effect: 'Damaged' }] }), []);
});

test('BDA reads counts and plurals as the Statistics do', () => {
    assert.deepEqual(core.bdaCount('T-72 x4'), { count: 4, type: 'T-72', counted: true }, 'a count after the type');
    assert.deepEqual(core.bdaCount('trucks (3)'), { count: 3, type: 'trucks', counted: true });
    assert.equal(core.bdaCount('0x T-72').count, 0, 'none is none, not one');
    assert.deepEqual(core.bdaCount('2S19'), { count: 1, type: '2S19', counted: false }, 'a number in a name');
    // The same element counted the same way by both.
    ['2x BUSES', '3x lorries', 'T-72 x4', 'trucks (3)', '2x T-72s', 'approx 4x BMP-2', '2S19'].forEach(s => {
        assert.equal(core.bdaCount(s).count, core.sizeElements(s)[0].count, s);
    });
    // Assessed under the singular, in any case: nothing left to assess.
    const r = { size: '2x BUSES, 3x lorries, T-72 x4', location: '', bda: [
        { target: '2x bus', effect: 'Destroyed' }, { target: '1x lorry', effect: 'Damaged' }, { target: '1x LORRIES', effect: 'Damaged' },
        { target: '4x T-72s', effect: 'Destroyed' }] };
    assert.deepEqual(core.bdaPending(r).map(e => e.target), ['1x lorries']);
    assert.deepEqual(core.bdaSummary(r), { done: 8, total: 9, worstCls: 'destroyed' });
    assert.equal(core.bdaSummary({ size: '0x T-72', bda: [] }).total, 0);
    // A team's own type folds when the team's equipment is given.
    const team = core.teamEquipment([{ type: 'widget', role: 'logistics' }]);
    const w = { size: '3X WIDGETS', location: '', bda: [{ target: '3x widget', effect: 'Destroyed' }] };
    assert.deepEqual(core.bdaPending(w, team), []);
});

// --- The Size after BDA ---

const dest = (target, effect = 'Destroyed') => ({ target, effect });
const after = (size, bda, team = null) => core.sizeAfterBda({ size, location: '', bda }, team);

test('destroyed vehicles come off the Size; the Size as logged is kept', () => {
    const r = { size: '20x tanks', location: '', bda: [dest('3x tanks')] };
    assert.deepEqual(core.sizeAfterBda(r), { size: '17x tanks', logged: '20x tanks', taken: [{ count: 3, type: 'tanks' }], note: 'BDA: 3x tanks destroyed', shown: '17x tanks' });
    assert.equal(core.effectiveSize(r), '17x tanks');
    assert.equal(r.size, '20x tanks', 'the report is not changed');
    // Taking the assessment away brings the count back.
    r.bda = [];
    assert.equal(core.effectiveSize(r), '20x tanks');
    assert.equal(core.sizeAfterBda(r).note, '');
    assert.equal(core.effectiveSize({ size: '20x tanks' }), '20x tanks', 'no BDA at all');
});

test('each type comes off its own element, and the rest of the text stays as written', () => {
    assert.equal(after('20x tanks, 2x BMP-2', [dest('3x tanks')]).size, '17x tanks, 2x BMP-2');
    assert.equal(after('20x tanks; 4 BMP-2 + T-72 x4', [dest('1x BMP-2'), dest('2x T-72s')]).size, '20x tanks; 3 BMP-2 + T-72 x2');
    assert.equal(after('trucks (3), vics 10x', [dest('1x truck'), dest('4x vics')]).size, 'trucks (2), vics 6x');
    assert.equal(after('approx 20 T-72', [dest('5x T-72')]).size, 'approx 15 T-72');
    const two = after('20x tanks, 2x BMP-2', [dest('3x tanks'), dest('1x BMP-2'), dest('2x tanks')]);
    assert.equal(two.size, '15x tanks, 1x BMP-2');
    assert.equal(two.note, 'BDA: 5x tanks, 1x BMP-2 destroyed', 'one entry per type, in the order of the Size');
    // Any case, plural or not, as partial BDA pairs them.
    assert.equal(after('2x BUSES, 3x lorries', [dest('1x bus'), dest('1x LORRY')]).size, '1x BUSES, 2x lorries');
    const team = core.teamEquipment([{ type: 'widget', role: 'logistics' }]);
    assert.equal(after('3X WIDGETS', [dest('1x widget')], team).size, '2X WIDGETS', 'a team type folds with the team given');
});

test('only Destroyed takes from the Size; partial BDA takes only its count', () => {
    for (const effect of ['Damaged', 'Mobility Kill', 'Suppressed', 'No Effect', 'Unknown', '']) {
        assert.equal(after('20x tanks', [dest('3x tanks', effect)]).size, '20x tanks', effect);
    }
    const mixed = after('20x tanks', [dest('2x tanks', 'Damaged'), dest('3x tanks'), dest('1x tanks', 'Mobility Kill')]);
    assert.equal(mixed.size, '17x tanks');
    assert.equal(mixed.note, 'BDA: 3x tanks destroyed');
    // As the BDA panel logs part of an element: "3x T-72" of "40x T-72", then one more.
    assert.equal(after('40x T-72, 3x trucks', [dest('3x T-72'), dest('1x T-72')]).size, '36x T-72, 3x trucks');
});

test('an element destroyed to none is dropped, and never goes below none', () => {
    assert.equal(after('20x tanks, 2x BMP-2', [dest('2x BMP-2')]).size, '20x tanks');
    assert.equal(after('2x BMP-2, 20x tanks', [dest('2x BMP-2')]).size, '20x tanks', 'its separator goes with it');
    assert.equal(after('1x T-72, truck; 2x BMP-2', [dest('truck')]).size, '1x T-72; 2x BMP-2');
    const all = after('20x tanks', [dest('25x tanks')]);
    assert.deepEqual([all.size, all.shown, all.note], ['', 'None left', 'BDA: 20x tanks destroyed'], 'what came off, no more');
    // Too many of one type spill to the next element of that type, never into another type.
    assert.equal(after('2x T-72, 2x BMP-2, 3x T-72', [dest('3x T-72')]).size, '2x BMP-2, 2x T-72');
});

test('types the Size does not name, and text it cannot count, are left as they are', () => {
    const none = after('20x tanks', [dest('3x BMP-2')]);
    assert.deepEqual([none.size, none.note, none.shown], ['20x tanks', '', '20x tanks']);
    assert.equal(after('a lot of vehicles', [dest('3x tanks')]).size, 'a lot of vehicles');
    assert.equal(after('', [dest('3x tanks')]).size, '');
    assert.equal(after('Total of vics 10x: 5x tanks and 5x APC', [dest('2x tanks')]).size, 'Total of vics 10x: 5x tanks and 5x APC', 'one element to BDA, as the panel reads it');
    assert.equal(after('20x tanks', [dest('0x tanks'), dest('')]).size, '20x tanks', 'none destroyed, or nothing named');
    assert.equal(after('20x tanks', [null, { effect: 'Destroyed' }]).size, '20x tanks');
    assert.equal(core.sizeAfterBda({ size: 0, bda: [] }).size, '0', 'zero is a Size, not nothing');
    assert.equal(core.sizeAfterBda(null).size, '');
});

test('how sure the observer was stays in the Size, before the count or after it', () => {
    assert.equal(after('2x possible tanks', [dest('1x possible tanks')]).size, '1x possible tanks');
    assert.equal(after('possible 20x tanks', [dest('3x possible tanks')]).size, 'possible 17x tanks');
    assert.equal(after('poss 3x APCs, 2x T-72', [dest('1x poss APCs')]).size, 'poss 2x APCs, 2x T-72');
    assert.deepEqual(core.bdaCount('poss 3x APCs'), { count: 3, type: 'poss APCs', counted: true }, 'a hedge before the count, as the Statistics read it');
    assert.equal(core.bdaCount('poss 3x BTR-82A').count, core.sizeElements('poss 3x BTR-82A')[0].count);
    // The panel offers the element under its hedge, so it is assessed under it.
    assert.deepEqual(core.bdaPending({ size: 'poss 3x APCs', location: '', bda: [dest('1x poss APCs')] }).map(e => e.target), ['2x poss APCs']);
});

test('the copied text, the Statistics and the summaries read the Size after BDA', () => {
    const r = report({ size: '20x T-72, 2x BMP-2', bda: [dest('3x T-72'), dest('1x BMP-2', 'Damaged')] });
    const text = core.reportText(r, SALT, 'dash').split('\n');
    assert.equal(text[1], 'S: 17x T-72, 2x BMP-2 (BDA: 3x T-72 destroyed)');
    assert.ok(text.includes('BDA 1: Destroyed - 3x T-72'));
    assert.equal(core.reportText(report({ size: '1x T-72', bda: [dest('1x T-72')] }), SALT, 'dash').split('\n')[1], 'S: None left (BDA: 1x T-72 destroyed)');
    assert.equal(core.reportText(report(), SALT, 'dash').split('\n')[1], 'S: 2x T-72', 'no BDA: as it was');
    const eq = core.statsData([r], [], {}).equipment;
    assert.deepEqual(eq, [{ label: 'T-72', value: 17 }, { label: 'BMP-2', value: 2 }]);
    // The workbook: Size after BDA, and as logged when BDA took from any report.
    const wb = core.workbookReportRows([r], [], { local: false, idOf: x => x.displayId });
    const col = (name) => wb.rows[0][wb.header.indexOf(name)];
    assert.deepEqual([col('Size'), col('Size (as logged)')], ['17x T-72, 2x BMP-2', '20x T-72, 2x BMP-2']);
    assert.ok(!core.workbookReportRows([report()], [], { local: false, idOf: x => x.displayId }).header.includes('Size (as logged)'));
    // ArcGIS points and tracks: the field after BDA, and the one as logged.
    const placed = report({ ...r, location: '38SMB4500082000' });
    const pt = core.arcgisRows([placed], [], { local: false, idOf: x => x.id }).rows[0];
    assert.deepEqual([pt.size, pt.size_logged], ['17x T-72, 2x BMP-2', '20x T-72, 2x BMP-2']);
    const moved = { ...placed, history: [{ location: '38SMB4000082000', time: '2026-10-24T03:00:00Z', lastModified: 1 }] };
    const tr = core.arcgisTrackRows([moved], { local: false, idOf: x => x.id })[0];
    assert.deepEqual([tr.size, tr.size_logged], ['17x T-72, 2x BMP-2', '20x T-72, 2x BMP-2']);
    // The summaries quote it.
    const line = core.summaryReport('place', [{ ...placed, location: '38SMB4500082000, NAI 1' }], [], { local: false, place: 'NAI 1', now: NOW }).split('\n');
    assert.ok(line.some(l => l.includes('ALPHA001  17x T-72, 2x BMP-2; Moving NE;')), line.join('\n'));
    // The backup keeps the Size as logged.
    assert.equal(core.parseBackup(core.backupText('ALPHA', [r], 'Patrol', {}, {}, NOW)).data.workspaces.ALPHA[0].size, '20x T-72, 2x BMP-2');
});

test('the MTI export counts what is left of the current version', () => {
    const r = report({ size: '6x tracked', bda: [dest('2x tracked')], history: [{ size: '5x tracked', lastModified: 1, time: '2026-10-24T01:00:00Z' }] });
    const mti = core.mtiCsvs([r], { local: false, idOf: x => x.fullId });
    const rows = core.parseCsv(mti.tracked).filter(row => row.length > 1).slice(1);
    assert.deepEqual(rows.map(row => row[2]), ['4x tracked', '5x tracked'], 'a saved version as it was logged');
});

test('the BDA roll-up totals a workspace\'s elements and outcomes', () => {
    const reps = [
        { size: '4x T-72, 2x BMP-2', location: '', bda: [{ target: '4x T-72', effect: 'Destroyed' }] },  // 4 of 6 assessed
        { size: '1x ZSU', location: '', bda: [{ effect: 'Damaged' }, { effect: 'odd' }] },   // more assessments than elements
        { size: '3x trucks', location: '', bda: [] },                                       // nothing yet
        { size: '1x gone', deleted: true, bda: [{ effect: 'Destroyed' }] },                  // deleted: ignored
    ];
    assert.deepEqual(core.bdaRollup(reps), {
        done: 6, total: 11, unassessed: 5,
        byEffect: { Destroyed: 4, Damaged: 1, 'Mobility Kill': 0, Suppressed: 0, 'No Effect': 0, Unknown: 1 },
    });
    assert.deepEqual(core.bdaRollup([]).byEffect.Destroyed, 0);
});

// --- Backups ---

test('a backup lists live reports and round-trips everything', () => {
    const reps = [
        report({ custom: { W: 'Rain' }, history: [{ size: 'old', activity: 'a', location: 'l', time: '2026-10-24T03:00:00Z', lastModified: 5 }] }),
        report({ id: 'r2', displayId: 'ALPHA002', size: 'gone', deleted: true }),
    ];
    const formats = { ALPHA: SALT, BRAVO: SALT_U };
    const text = core.backupText('ALPHA', reps, 'Patrol', { AB: { initials: 'AB', color: '#0a84ff' } }, formats, NOW);
    assert.match(text, / Exported {7}: 2026-10-24 · 1507Z/);
    assert.match(text, / Total Reports {2}: 1\n/);
    assert.ok(text.includes(' W : Rain\n'));
    assert.ok(text.includes('↳ Previous Entry 1'));
    assert.ok(!text.includes('REPORT ALPHA002'), 'deleted reports are not listed');
    const { data } = core.parseBackup(text);
    assert.deepEqual(data.workspaces.ALPHA, reps, 'the machine data keeps deleted flags');
    assert.deepEqual(data.formats, { ALPHA: SALT }, 'only this workspace\'s format');
    assert.deepEqual(data.config, { ato: 'ALPHA', title: 'Patrol' });
});

test('an all-workspace backup carries every workspace', () => {
    const ws = { ALPHA: [report()], BRAVO: [report({ id: 'b1', displayId: 'BRAVO001', ato: 'BRAVO', title: 'Screen' })] };
    const text = core.allWorkspacesBackupText(ws, 'ALPHA', 'Patrol', {}, { ALPHA: SALT }, NOW);
    assert.ok(text.includes(' ATOs Included  : ALPHA, BRAVO\n'));
    assert.ok(text.includes(' ATO: BRAVO  -  Screen  (1 report)\n'));
    assert.deepEqual(Object.keys(core.parseBackup(text).data.workspaces), ['ALPHA', 'BRAVO']);
});

test('backup parsing explains what is wrong with a file', () => {
    assert.match(core.parseBackup('').error, /empty/);
    assert.match(core.parseBackup('just notes').error, /no ##SALT_BACKUP## block/);
    assert.match(core.parseBackup('##SALT_BACKUP##{oops##SALT_BACKUP_END##').error, /corrupt/);
    assert.match(core.parseBackup('{"other": 1}').error, /recognizable/);
    assert.deepEqual(core.parseBackup('﻿{"reports": []}').data, { reports: [] }, 'BOM and raw JSON');
});

// --- CSV ---

test('CSV parsing handles quotes, doubled quotes, and every line ending', () => {
    assert.deepEqual(core.parseCsv('a,"b,c","say ""hi"""\r\n1,2,3\n4,"line\nbreak",6\r7,8,9'), [
        ['a', 'b,c', 'say "hi"'], ['1', '2', '3'], ['4', 'line\nbreak', '6'], ['7', '8', '9'],
    ]);
});

test('the CSV export lists each report, its history, then its BDA', () => {
    const r = report({
        updated: true, custom: { W: 'Rain' },
        history: [{ size: 'v1', time: '2026-10-24T01:00:00Z', lastModified: 1 }, { size: 'v2', time: '2026-10-24T02:00:00Z', lastModified: 2 }],
        bda: [{ target: '2x T-72', effect: 'Destroyed', coords: '18SUJ1', time: '2026-10-24T05:00:00Z', note: 'he said "done"' }],
    });
    const csv = core.reportsCsv([r], { local: false, customLabels: ['W'], idOf: x => x.fullId });
    const rows = core.parseCsv(csv).filter(row => row.length > 1);
    // Both T-72 destroyed: none left in Size, the Size as logged last.
    assert.deepEqual(rows[0], ['Identifier', 'UpdateStatus', 'Size', 'Activity', 'MGRS', 'Time (Z)', 'Analysis', 'W', 'Size (as logged)']);
    assert.deepEqual(rows.slice(1).map(row => row[1]), ['Current Update', 'Update #2 (Old)', 'Update #1 (Old)', 'BDA #1']);
    assert.deepEqual(rows.slice(1).map(row => [row[2], row[8]]), [['', '2x T-72'], ['v2', 'v2'], ['v1', 'v1'], ['2x T-72', '']]);
    assert.equal(rows[1][7], 'Rain');
    assert.equal(rows[4][6], 'he said "done"');
    assert.ok(csv.endsWith('\r\n'));
});

test('the CSV export says each report\'s observer last, when there is one', () => {
    const seen = report({ observer: 'GE 1', updated: true, custom: { W: 'Rain' },
        history: [{ size: 'v1', observer: 'GE 2', time: '2026-10-24T01:00:00Z', lastModified: 1 }],
        bda: [{ target: 'T-72', effect: 'Destroyed', time: '2026-10-24T05:00:00Z' }] });
    const opts = { local: false, customLabels: ['W'], idOf: x => x.fullId };
    const rows = core.parseCsv(core.reportsCsv([seen, report({ id: 'r2' })], opts)).filter(row => row.length > 1);
    assert.deepEqual(rows[0], ['Identifier', 'UpdateStatus', 'Size', 'Activity', 'MGRS', 'Time (Z)', 'Analysis', 'W', 'Observer', 'Size (as logged)']);
    assert.deepEqual(rows.slice(1).map(row => row[8]), ['GE 1', 'GE 2', '', '']);
    assert.deepEqual(rows.slice(1).map(row => [row[2], row[9]]), [['1x T-72', '2x T-72'], ['v1', 'v1'], ['T-72', ''], ['2x T-72', '2x T-72']]);
    assert.equal(rows[1][7], 'Rain', 'the custom columns stay where they were');
    // None names one: no column, unless the caller asks for it (FMV mode on).
    const none = core.parseCsv(core.reportsCsv([report()], opts));
    assert.equal(none[0].length, 8);
    assert.equal(core.parseCsv(core.reportsCsv([report()], { ...opts, observer: true }))[0][8], 'Observer');
    // The backup says it for a person reading it; the machine data keeps it as it is.
    const text = core.backupText('ALPHA', [seen], 'Patrol', {}, {}, NOW);
    assert.ok(text.includes(' Observer : GE 1\n'));
    assert.equal(core.parseBackup(text).data.workspaces.ALPHA[0].history[0].observer, 'GE 2');
    // Not in the copied SALT line.
    assert.ok(!core.reportText(seen, { lines: [{ type: 'id' }, { type: 'size' }, { type: 'custom', label: 'W' }] }).includes('GE 1'));
});

test('the MTI export splits tracked and wheeled counts', () => {
    const reps = [report({ size: '2 tracked, 3 wheeled' }), report({ id: 'r2', size: '6 dismounts' })];
    const mti = core.mtiCsvs(reps, { local: false, idOf: x => x.fullId });
    assert.equal(mti.trackedRows, 1);
    assert.equal(mti.wheeledRows, 1);
    assert.ok(mti.tracked.includes('"2 tracked"'));
    assert.ok(mti.wheeled.includes('"3 wheeled"'));
});

test('MTI counts written as "4x tracked" are found too', () => {
    // Regression: only "4 tracked" matched, though operators write "4x".
    const reps = [report({ size: '4x Tracked, 2 x wheeled' }), report({ id: 'r2', size: '1X TRACKED' })];
    const mti = core.mtiCsvs(reps, { local: false, idOf: x => core.formatFullId(x, 'dash') });
    assert.equal(mti.trackedRows, 2);
    assert.equal(mti.wheeledRows, 1);
    assert.ok(mti.tracked.includes('"Patrol - ALPHA001","Original","4x tracked"'));
    assert.ok(mti.wheeled.includes('"2 x wheeled"'));
});

test('the CSV identifier is whatever the caller displays', () => {
    const csv = core.reportsCsv([report()], { local: false, customLabels: [], idOf: x => core.formatFullId(x, 'space') });
    assert.equal(core.parseCsv(csv)[1][0], 'Patrol ALPHA001');
});

// --- Sync bookkeeping ---

test('reports are keyed like the server merges them', () => {
    assert.equal(core.reportKey({ id: 'u1', displayId: 'A001' }), 'u1');
    assert.equal(core.reportKey({ displayId: 'A001' }), 'A001');
    assert.equal(core.reportKey({}), '');
});

test('a push carries only reports the server lacks in that version', () => {
    const server = [report({ id: 'a', lastModified: 1 }), report({ id: 'b', lastModified: 2 })];
    const known = core.knownVersions(server);
    const local = [
        report({ id: 'a', lastModified: 1 }),          // unchanged
        report({ id: 'b', lastModified: 5 }),          // edited
        report({ id: 'c', lastModified: 3 }),          // new
        report({ id: 'd', lastModified: 4, deleted: true }), // deleted before the server saw it
        { size: 'no key' },                            // can't be merged, never sent
    ];
    assert.deepEqual(core.changedReports(local, known).map(r => r.id), ['b', 'c', 'd']);
    assert.equal(core.changedReports(local, undefined).length, 4, 'no record: send everything mergeable');
});

test('refused changes stay over the server copy until superseded', () => {
    const server = [report({ id: 'a', size: 'server', lastModified: 5 }), report({ id: 'b', size: 'server', lastModified: 9 })];
    const unsaved = [
        report({ id: 'a', size: 'mine', lastModified: 7 }),  // newer than the server's: shown
        report({ id: 'b', size: 'mine', lastModified: 8 }),  // the server moved past it: dropped
        report({ id: 'n', size: 'mine', lastModified: 1 }),  // never saved: added
    ];
    const { reports, superseded } = core.withUnsaved(server, unsaved);
    assert.deepEqual(reports.map(r => `${r.id}:${r.size}`), ['a:mine', 'b:server', 'n:mine']);
    assert.deepEqual(superseded, ['b']);
    assert.equal(server[0].size, 'server', 'the server copy itself is not modified');
});

// --- Geography ---

// The center of each square, from the NGA's GeoTrans (the `mgrs` Python
// package), across both hemispheres, every precision, band edges, the
// equator, and Norway's and Svalbard's odd zones.
const VECTORS = require('./mgrs-vectors.json');

test('MGRS grids convert to the center of their square, within a meter', () => {
    const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(b.lat * Math.PI / 180));
    for (const v of VECTORS) {
        for (const text of [v.mgrs, v.spaced, v.spaced.toLowerCase()]) {
            const g = core.findGrids(text);
            assert.equal(g.length, 1, text);
            assert.ok(meters(g[0], v) < 1, `${text}: ${meters(g[0], v).toFixed(2)} m off`);
            assert.equal(g[0].precision, 10 ** (5 - v.p), text);
        }
    }
});

test('grids are found in free text, several at once, and typos are refused', () => {
    const g = core.findGrids('2x BMP at 38S MB 45000 82000, 38SMB5500082000 and vic 18SUJ2348706483');
    assert.deepEqual(g.map(x => x.mgrs), ['38S MB 45000 82000', '38S MB 55000 82000', '18S UJ 23487 06483']);
    assert.deepEqual(core.findGrids('NAI 1 and OBJ 2, 10 km N of town'), [], 'I and O are never grid letters');
    assert.deepEqual(core.findGrids('38S PL 12345 67890'), [], 'a 100 km square outside its latitude band');
    assert.deepEqual(core.findGrids('38SMB123'), [], 'an odd number of digits');
    assert.equal(core.findGrids('38S MB 1234 567')[0].mgrs, '38S MB 12 34', 'halves of different lengths');
});

test('NAI, OBJ and PL names read the way operators type them', () => {
    assert.deepEqual(core.findRefs('38SMB4500082000, NAI 01; nai1; obj gold, Objective Silver, Phase Line Red, PL3, PLATOON')
        .map(r => r.key), ['NAI 1', 'OBJ GOLD', 'OBJ SILVER', 'PL RED', 'PL 3']);
    assert.deepEqual(core.overlayRef('NAI 03'), { type: 'NAI', name: '3', key: 'NAI 3' });
    assert.equal(core.overlayRef('OBJ Gold (bridge)').key, 'OBJ GOLD');
    assert.equal(core.overlayRef('Bridge', 'OBJ').key, 'OBJ BRIDGE', 'no prefix: the given type');
    assert.equal(core.overlayRef('Bridge'), null);
});

test('common words after objective or phase line are not names', () => {
    const keys = s => core.findRefs(s).map(r => r.key);
    assert.deepEqual(keys('vic objective area'), []);
    assert.deepEqual(keys('crossed the phase line of the advance'), []);
    assert.deepEqual(keys('our objective is clear'), []);
    assert.deepEqual(keys('OUR OBJECTIVE IS CLEAR, OBJ IS SECURED'), [], 'in capitals too');
    assert.deepEqual(keys('obj is clear; pl to the north'), [], 'and after the short forms');
    assert.deepEqual(keys('Objective 3, objective gold, OBJECTIVE IRON, Phase Line Red, OBJ A, nai 01'),
        ['OBJ 3', 'OBJ IRON', 'PL RED', 'OBJ A', 'NAI 1'], 'a long form needs a number or a capital');
    // editLocation reads them the same way: nothing to replace in "objective area".
    assert.equal(core.editLocation('vic objective area, NAI 1', { replace: { 'OBJ AREA': '', 'NAI 1': 'NAI 2' } }), 'vic objective area, NAI 2');
    assert.equal(core.editLocation('vic objective area', { add: ['OBJ GOLD'] }), 'vic objective area, OBJ GOLD');
    // And an overlay's name.
    assert.equal(core.overlayRef('Objective area', null), null);
    assert.equal(core.overlayRef('The Bridge', 'OBJ').key, 'OBJ BRIDGE', 'the first word that is a name');
    assert.equal(core.overlayRef('Objective Gold').key, 'OBJ GOLD');
});

// NAI 1 and NAI 2 side by side, OBJ BRIDGE north of NAI 1, PL BLUE across both NAIs.
const ll = g => { const x = core.findGrids(g)[0]; return [x.lon, x.lat]; };
const box = (...grids) => ({ type: 'Polygon', coordinates: [[...grids, grids[0]].map(ll)] });
const OVERLAYS = [
    { type: 'NAI', name: '1', geometry: box('38SMB4000080000', '38SMB5000080000', '38SMB5000090000', '38SMB4000090000') },
    { type: 'NAI', name: '2', geometry: box('38SMB5000080000', '38SMB6000080000', '38SMB6000090000', '38SMB5000090000') },
    { type: 'OBJ', name: 'BRIDGE', geometry: box('38SMB4000090000', '38SMB4500090000', '38SMB4500095000', '38SMB4000095000') },
    { type: 'PL', name: 'BLUE', geometry: { type: 'LineString', coordinates: [ll('38SMB4000085000'), ll('38SMB6000085000')] } },
];

test('a grid places a report in the NAI or OBJ it falls inside', () => {
    const a = core.analyzeLocation('38SMB4500082000', OVERLAYS);
    assert.deepEqual(a.nai, { keys: ['NAI 1'], from: 'grid' });
    assert.deepEqual(a.obj, { keys: [], from: '' });
    assert.equal(a.nearestPl.key, 'PL BLUE');
    assert.ok(Math.abs(a.nearestPl.meters - 3000) < 30, `${a.nearestPl.meters} m`);
    assert.deepEqual(core.analyzeLocation('38SMB4200092000', OVERLAYS).obj, { keys: ['OBJ BRIDGE'], from: 'grid' });
});

test('a typed NAI counts, and disagreeing with the grid is flagged', () => {
    const a = core.analyzeLocation('38S MB 55000 82000, NAI 1', OVERLAYS);
    assert.deepEqual(a.nai, { keys: ['NAI 1'], from: 'typed' });
    assert.deepEqual(a.checks, ['NAI 1 typed; grid is in NAI 2']);
    assert.deepEqual(core.analyzeLocation('38S MB 45000 99000 nai1', OVERLAYS).checks, ['NAI 1 typed; grid is outside it']);
    assert.deepEqual(core.analyzeLocation('38S MB 45000 82000, NAI 1', OVERLAYS).checks, [], 'agreeing: no check');
    assert.deepEqual(core.analyzeLocation('NAI 7, no grid', OVERLAYS).checks, [], 'nothing to compare without a grid');
    // No overlays at all: typed names still come through.
    const bare = core.analyzeLocation('38SMB4500082000, OBJ GOLD, vic PL RED', []);
    assert.deepEqual([bare.obj, bare.pl, bare.nearestPl], [{ keys: ['OBJ GOLD'], from: 'typed' }, ['PL RED'], null]);
});

test('a grid within 1 km of a phase line is at that line', () => {
    assert.deepEqual(core.analyzeLocation('38SMB4500085500', OVERLAYS).pls, ['PL BLUE'], '500 m away');
    assert.deepEqual(core.analyzeLocation('38SMB4500082000', OVERLAYS).pls, [], '3 km away');
    assert.deepEqual(core.analyzeLocation('38SMB4500082000, PL BLUE', OVERLAYS).pls, ['PL BLUE'], 'typed');
    assert.deepEqual(core.analyzeLocation('PL RED', OVERLAYS).pls, ['PL RED'], 'typed, no grid');
});

test('Log adds the places a grid is in, and finds typed ones it disagrees with', () => {
    assert.deepEqual(core.locationPlan('38SMB4500085500', OVERLAYS), { add: ['NAI 1', 'PL BLUE'], conflicts: [] });
    assert.deepEqual(core.locationPlan('38SMB4500085500, NAI 1, PL BLUE', OVERLAYS), { add: [], conflicts: [] });
    assert.deepEqual(core.locationPlan('38SMB4200092000', OVERLAYS).add, ['OBJ BRIDGE']);
    const typedWrong = core.locationPlan('38S MB 55000 82000, NAI 1', OVERLAYS);
    assert.deepEqual(typedWrong.add, [], 'nothing added for a type that was typed');
    assert.deepEqual(typedWrong.conflicts, [{ type: 'NAI', typed: 'NAI 1', found: ['NAI 2'], message: 'NAI 1 typed; grid is in NAI 2' }]);
    assert.deepEqual(core.locationPlan('38SMB4500099000, NAI 1', OVERLAYS).conflicts.map(c => [c.typed, c.found, c.message]),
        [['NAI 1', [], 'NAI 1 typed; grid is outside it']]);
    const farPl = core.locationPlan('38SMB4500082000, PL BLUE', OVERLAYS).conflicts;
    assert.deepEqual(farPl.map(c => [c.typed, c.found, c.message]), [['PL BLUE', [], 'PL BLUE typed; grid is 3.0 km from it']]);
    assert.deepEqual(core.locationPlan('38SMB4500082000, NAI 7, PL RED', OVERLAYS).conflicts, [], 'no overlay to check against');
    assert.deepEqual(core.locationPlan('NAI 1 vic the bridge', OVERLAYS), { add: [], conflicts: [] }, 'no grid');
    assert.deepEqual(core.locationPlan('38SMB4500085500', []), { add: [], conflicts: [] }, 'no overlays');
});

test('a Location is edited in place, and only what is named changes', () => {
    const e = core.editLocation;
    assert.equal(e('38SMB4500085500', { add: ['NAI 1', 'PL BLUE'] }), '38SMB4500085500, NAI 1, PL BLUE');
    assert.equal(e('38SMB4500085500, nai1', { add: ['NAI 1'] }), '38SMB4500085500, nai1', 'already named');
    assert.equal(e('38S MB 55000 82000, NAI 1, vic bridge', { replace: { 'NAI 1': 'NAI 2' } }), '38S MB 55000 82000, NAI 2, vic bridge');
    assert.equal(e('NAI 1, 38SMB4500085500, PL RED', { replace: { 'NAI 1': '', 'PL RED': '' } }), '38SMB4500085500');
    assert.equal(e('38S PL 12345 67890, PL RED', { replace: { 'PL RED': '' } }), '38S PL 12345 67890', "the grid's PL square is not a phase line");
    assert.equal(e('', { add: ['NAI 1'] }), 'NAI 1');
    assert.equal(e('vic the bridge;  ', {}), 'vic the bridge;  ', 'untouched when nothing changes');
});

test('an NAI or OBJ drawn as a path is still an area', () => {
    const ring = OVERLAYS[2].geometry.coordinates[0];
    const path = { type: 'LineString', coordinates: ring.slice(0, -1) };  // not closed
    assert.deepEqual(core.asArea(path), { type: 'Polygon', coordinates: [ring] });
    assert.deepEqual(core.asArea({ type: 'LineString', coordinates: ring }), { type: 'Polygon', coordinates: [ring] }, 'closed already');
    const two = { type: 'LineString', coordinates: ring.slice(0, 2) };
    assert.equal(core.asArea(two), two, 'two points stay a line');
    assert.equal(core.asArea({ type: 'MultiLineString', coordinates: [ring, ring] }).type, 'MultiPolygon');
    const ovs = [{ type: 'OBJ', name: 'BRIDGE', geometry: path }];
    assert.deepEqual(core.analyzeLocation('38SMB4200092000', ovs).obj, { keys: ['OBJ BRIDGE'], from: 'grid' });
    assert.deepEqual(core.analyzeLocation('38SMB4200092000', [{ ...ovs[0], type: 'PL' }]).obj.keys, [], 'a PL path is not an area');
});

test('a broken overlay is left out, and stops nothing', () => {
    assert.doesNotThrow(() => core.asArea({ type: 'LineString', coordinates: [] }));
    assert.deepEqual(core.asArea({ type: 'MultiLineString', coordinates: [[]] }), { type: 'MultiLineString', coordinates: [[]] });
    const square = OVERLAYS[0].geometry;
    const bad = [
        { type: 'NAI', name: 'E', geometry: { type: 'Polygon', coordinates: [] } },
        { type: 'NAI', name: 'L', geometry: { type: 'LineString', coordinates: [] } },
        { type: 'OBJ', name: 'M', geometry: { type: 'MultiLineString', coordinates: [[]] } },
        { type: '<img src=x onerror=alert(1)>', name: 'X', geometry: square },
        { type: 'NAI', name: 5, geometry: square },
        { type: 'NAI', name: 'N', geometry: { type: 'Polygon', coordinates: [[[NaN, 1], [2, 2], [3, 3]]] } },
        { type: 'NAI', name: 'G', geometry: null },
        null, 'junk',
    ];
    const twoPoint = { type: 'OBJ', name: 'T', geometry: { type: 'LineString', coordinates: square.coordinates[0].slice(0, 2) } };
    const ovs = [...OVERLAYS, ...bad, twoPoint];
    assert.deepEqual(core.foldOverlays(ovs), [...OVERLAYS, twoPoint], 'only what the server would take');
    assert.deepEqual(core.foldOverlays({ ALPHA: ovs }), [...OVERLAYS, twoPoint]);
    assert.deepEqual(core.analyzeLocation('38SMB4500082000', ovs).nai, { keys: ['NAI 1'], from: 'grid' });
    assert.deepEqual(core.locationPlan('38SMB4500082000', ovs).add, ['NAI 1']);
    assert.doesNotThrow(() => core.statsData([report({ location: '38SMB4500082000' })], ovs, {}));
    assert.doesNotThrow(() => core.summaryReport('rollup', [report({ location: '38SMB4500082000' })], ovs, { local: false, now: NOW }));
    assert.ok(!core.summaryPlaces([], ovs).some(p => /img/.test(p)));
});

test('an area of the team\'s own tag names the reports inside it, as an NAI does', () => {
    const tagged = (type, name, geometry) => ({ type, name, geometry });
    const ovs = [
        ...OVERLAYS,
        tagged('tag-ea', 'EA Dog', OVERLAYS[0].geometry),
        tagged('tag-rt', 'Route Gold', OVERLAYS[3].geometry),
        tagged('', 'Loose', OVERLAYS[0].geometry),
    ];
    const a = core.analyzeLocation('38SMB4500082000', ovs);
    assert.deepEqual(a.nai, { keys: ['NAI 1'], from: 'grid' }, 'the NAI as before');
    assert.deepEqual(a.custom, [{ key: 'EA Dog', type: 'tag-ea', from: 'grid' }], 'an area only, and not an untagged one');
    assert.deepEqual(core.locationPlan('38SMB4500082000', ovs).add, ['NAI 1', 'EA Dog']);
    // Named already, in any case: counted as typed, and not added again.
    const typed = core.analyzeLocation('38SMB4500082000, ea  dog', ovs);
    assert.deepEqual(typed.custom, [{ key: 'EA Dog', type: 'tag-ea', from: 'typed' }]);
    assert.deepEqual(core.locationPlan('38SMB4500082000, ea dog', ovs).add, ['NAI 1']);
    assert.deepEqual(core.analyzeLocation('along route gold', ovs).custom, [{ key: 'Route Gold', type: 'tag-rt', from: 'typed' }], 'a line, typed');
    assert.deepEqual(core.analyzeLocation('golden route', ovs).custom, [], 'whole words only');
    assert.equal(core.editLocation('38SMB4500082000', { add: ['NAI 1', 'EA Dog'] }), '38SMB4500082000, NAI 1, EA Dog');
    // A grid of digits is not a name, and a name of one letter is never read as typed.
    const odd = [tagged('tag-n', '45000', OVERLAYS[1].geometry), tagged('tag-a', 'A', OVERLAYS[1].geometry)];
    assert.deepEqual(core.analyzeLocation('38SMB4500082000, a tank', odd).custom, []);
    // Statistics and summaries keep to NAI, OBJ and PL.
    assert.deepEqual(core.summaryPlaces([report({ location: '38SMB4500082000, EA Dog' })], ovs), ['NAI 1', 'NAI 2', 'OBJ BRIDGE', 'PL BLUE']);
    const d = core.statsData([report({ location: '38SMB4500082000' })], ovs, {});
    assert.ok(!JSON.stringify(d).includes('EA Dog'));
});

test('tags are kept as the server would take them, and ride in a backup', () => {
    const routes = { id: 'tag-a1', name: ' Routes ', color: '#FF9F0A' };
    const held = [routes, { ...routes, name: 'Again' }, { id: 'tag-b2', name: 'routes', color: '#000000' },
        { id: 'tag-c3', name: 'PL', color: '#000000' }, { id: 'NAI', name: 'X', color: '#000000' }, { id: 'tag-d4', name: 'EAs', color: 'red' }, null];
    assert.deepEqual(core.cleanTags(held), [{ id: 'tag-a1', name: 'Routes', color: '#ff9f0a' }]);
    assert.deepEqual(core.cleanTags(undefined), []);
    // Overlays of a tag, or of none, are kept like any other.
    const ovs = [{ ...OVERLAYS[0], type: 'tag-a1' }, { ...OVERLAYS[1], type: '' }, { ...OVERLAYS[2], type: 'tag-A1' }];
    assert.deepEqual(core.foldOverlays(ovs), ovs.slice(0, 2));
    const text = core.backupText('ALPHA', [report()], 'Patrol', {}, {}, NOW, ovs, null, held);
    const data = core.parseBackup(text).data;
    assert.deepEqual(data.tags, [{ id: 'tag-a1', name: 'Routes', color: '#ff9f0a' }]);
    assert.deepEqual(data.overlays, ovs.slice(0, 2));
    assert.ok(!('tags' in core.parseBackup(core.backupText('ALPHA', [report()], 'Patrol', {}, {}, NOW)).data), 'none, none written');
    const all = core.allWorkspacesBackupText({ ALPHA: [report()] }, 'ALPHA', 'Patrol', {}, {}, NOW, [], null, [routes]);
    assert.equal(core.parseBackup(all).data.tags.length, 1);
});

test('an overlay is keyed as a typed name is', () => {
    const sq = OVERLAYS[0].geometry;
    const ovs = [{ type: 'OBJ', name: 'gold', geometry: sq }, { type: 'NAI', name: '01', geometry: OVERLAYS[1].geometry }];
    assert.deepEqual(core.analyzeLocation('38SMB4500082000', ovs).obj.keys, ['OBJ GOLD']);
    assert.deepEqual(core.analyzeLocation('38SMB5500082000, NAI 1', ovs).checks, [], 'overlay "01" is NAI 1');
    assert.deepEqual(core.analyzeLocation('38SMB4500082000, NAI 1', ovs).checks, ['NAI 1 typed; grid is outside it']);
    assert.deepEqual(core.summaryPlaces([report({ location: '38SMB4500082000, OBJ GOLD' })], ovs), ['NAI 1', 'OBJ GOLD'], 'one OBJ GOLD, not two');
    // An older backup with "gold" in one workspace and "GOLD" in another: one overlay.
    assert.equal(core.foldOverlays({ A: [ovs[0]], B: [{ ...ovs[0], name: 'GOLD' }] }).length, 1);
});

test('activity lines are tagged, with a heading when one is given', () => {
    const cases = {
        '2x BMP moving N on MSR':        [['Moving'], 'N', 0],
        'dismounted, heading 270':       [['Moving', 'Dismounted'], 'W', 270],
        'convoy NB':                     [['Moving'], 'N', 0],
        'moving towards the southeast':  [['Moving'], 'SE', 135],
        'crossed PL BLUE westbound':     [['Moving'], 'W', 270],
        'stationary':                    [['Stationary'], null, null],
        'Parked; N of the bridge':       [['Stationary'], null, null],
        'digging in vic treeline':       [['Emplacing'], null, null],
        'engaging friendly OP':          [['Firing'], null, null],
        'refueling at the LRP':          [['Resupplying'], null, null],
        '':                              [[], null, null],
    };
    for (const [text, [tags, heading, deg]] of Object.entries(cases)) {
        assert.deepEqual(core.classifyActivity(text), { tags, heading, headingDeg: deg }, text);
    }
});

test('a heading needs a heading word or a unit, and a whole compass point', () => {
    const cases = {
        'moving 120 trucks':                     [['Moving'], null, null],
        'traveling with 300 pax':               [['Moving'], null, null],
        'heading 360':                           [['Moving'], 'N', 0],
        'heading 400':                           [['Moving'], null, null],
        'moving to new position, northbound':    [['Moving'], 'N', 0],
        'moving 120°':                           [['Moving'], 'ESE', 120],
        'moving at 090 degrees':                 [['Moving'], 'E', 90],
        'brg 045':                               [['Moving'], 'NE', 45],
        'on a heading of 300':                   [['Moving'], 'WNW', 300],
        'convoy moving nne on the MSR':          [['Moving'], 'NNE', 22.5],
        'moving as needed':                      [['Moving'], null, null],
        'withdrawing to the north-east':         [['Moving'], 'NE', 45],
    };
    for (const [text, [tags, heading, deg]] of Object.entries(cases)) {
        assert.deepEqual(core.classifyActivity(text), { tags, heading, headingDeg: deg }, text);
    }
});

test('fire support and launch sites are not firing, anywhere', () => {
    assert.deepEqual(core.classifyActivity('moving to a fire support position').tags, ['Moving']);
    assert.deepEqual(core.classifyActivity('launch site, stationary').tags, ['Stationary']);
    assert.deepEqual(core.classifyActivity('ceasefire holding').tags, ['Stationary']);
    assert.deepEqual(core.classifyActivity('engaging from firing positions').tags, ['Firing'], 'engaging still is');
    const d = core.statsData([report({ activity: 'occupying a fire support position' })], [], {});
    assert.deepEqual(d.tags, [{ label: 'Stationary', value: 1 }]);
    assert.equal(core.activityMatches('launch site', new Set(['Firing'])), false);
});

test('the ArcGIS export has one point per grid, and leaves out reports without one', () => {
    const reps = [
        report({ id: 'a', location: '38SMB4500082000 38SMB5500082000, OBJ GOLD', activity: 'moving N', custom: { 'Unit ID': '1-1' } }),
        report({ id: 'b', location: 'vic the bridge' }),
        report({ id: 'c', location: '38SMB4500082000', deleted: true }),
    ];
    const { rows, skipped } = core.arcgisRows(reps, OVERLAYS, { local: false, customLabels: ['Unit ID'], idOf: r => r.id });
    assert.equal(skipped, 1, 'the deleted report is not counted either');
    assert.deepEqual(rows.map(r => [r.report_id, r.mgrs, r.grid_n, r.nai, r.nai_from, r.obj, r.obj_from]), [
        ['a', '38S MB 45000 82000', '1/2', 'NAI 1; NAI 2', 'grid', 'OBJ GOLD', 'typed'],
        ['a', '38S MB 55000 82000', '2/2', 'NAI 1; NAI 2', 'grid', 'OBJ GOLD', 'typed'],
    ]);
    assert.deepEqual([rows[0].act_tags, rows[0].heading, rows[0].heading_deg, rows[0].c_unit_id, rows[0].time_utc],
        ['Moving', 'N', 0, '1-1', '2026-10-24T04:12:00Z']);
    const fc = JSON.parse(core.arcgisGeoJson(rows));
    assert.deepEqual(fc.features[0].geometry.coordinates, [rows[0].lon, rows[0].lat]);
    const esri = JSON.parse(core.arcgisEsriJson(rows));
    assert.equal(esri.geometryType, 'esriGeometryPoint');
    assert.deepEqual(esri.spatialReference.wkid, 4326);
    const field = n => esri.fields.find(f => f.name === n);
    assert.deepEqual(esri.fields[0], { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID' });
    assert.deepEqual([field('report_id').type, field('report_id').length], ['esriFieldTypeString', 1]);
    // heading_deg is always a double (NNE is 22.5), whatever the rows hold.
    assert.deepEqual([field('precision_m').type, field('heading_deg').type, field('lat').type],
        ['esriFieldTypeInteger', 'esriFieldTypeDouble', 'esriFieldTypeDouble']);
    assert.deepEqual(esri.features[1].attributes.OBJECTID, 2);
    assert.deepEqual(esri.features[0].geometry, { x: rows[0].lon, y: rows[0].lat, spatialReference: { wkid: 4326 } });
    const csv = core.arcgisCsv(rows).split('\r\n');
    assert.ok(csv[0].startsWith('report_id,ato,title,time_utc,'));
    assert.ok(csv[0].endsWith(',c_unit_id,lat,lon'));
    assert.ok(csv[1].endsWith(`,"1-1",${rows[0].lat},${rows[0].lon}`), 'numbers unquoted');
    assert.equal(core.arcgisCsv([]), '');
});

test('the ArcGIS exports keep long text where they can, and every field one type', () => {
    const long = 'x'.repeat(600);
    const reps = [
        report({ id: 'a', location: '38SMB4500082000', activity: 'parked', yourAnalysis: long }),
        report({ id: 'b', location: '38SMB4500082000', activity: 'moving NE' }),
    ];
    const { rows } = core.arcgisRows(reps, OVERLAYS, { local: false, idOf: r => r.id });
    const props = JSON.parse(core.arcgisGeoJson(rows)).features.map(f => f.properties);
    assert.equal(props[0].analysis.length, 254, "GeoJSON text fits ArcGIS's 255");
    assert.ok(props[0].analysis.endsWith('…'));
    assert.equal(rows[0].analysis, long, 'the rows themselves are untouched');
    const esri = JSON.parse(core.arcgisEsriJson(rows));
    assert.equal(esri.fields.find(f => f.name === 'analysis').length, 600);
    assert.equal(esri.features[0].attributes.analysis, long);
    // heading_deg: null on one, 45 on the other: a number field (always a
    // double, as NNE is 22.5), null kept.
    assert.equal(esri.fields.find(f => f.name === 'heading_deg').type, 'esriFieldTypeDouble');
    assert.deepEqual(esri.features.map(f => f.attributes.heading_deg), [null, 45]);
});

test('the ArcGIS exports have the same fields however the rows fill them', () => {
    // No heading and no phase lines in one export, every one in the other.
    const quiet = core.arcgisRows([report({ id: 'a', location: '38SMB4500082000', activity: 'parked' })], [], { local: false, idOf: r => r.id }).rows;
    const busy = core.arcgisRows([report({ id: 'b', location: '38SMB4500082000', activity: 'moving NNE' })], OVERLAYS, { local: false, idOf: r => r.id }).rows;
    const schema = rows => JSON.parse(core.arcgisEsriJson(rows)).fields.filter(f => f.type !== 'esriFieldTypeString').map(f => `${f.name} ${f.type}`);
    assert.deepEqual(schema(quiet), schema(busy));
    assert.deepEqual(schema(quiet).filter(f => /^(heading_deg|pl_dist_m) /.test(f)), ['heading_deg esriFieldTypeDouble', 'pl_dist_m esriFieldTypeInteger']);
    // The shapefile too: numeric (N) fields, the same in both.
    const dbfFields = rows => {
        const dbf = core.shapefileParts(rows, rows.map(r => [r.lon, r.lat]), 'point').dbf;
        const out = [];
        for (let o = 32; dbf[o] !== 0x0d; o += 32) out.push(`${String.fromCharCode(...dbf.subarray(o, o + 11)).replace(/\0+$/, '')} ${String.fromCharCode(dbf[o + 11])}${dbf[o + 16]}.${dbf[o + 17]}`);
        return out.filter(f => / N/.test(f));
    };
    assert.deepEqual(dbfFields(quiet), dbfFields(busy));
    assert.ok(dbfFields(quiet).includes('head_deg N19.7') && dbfFields(quiet).includes('pl_dist_m N18.0'), dbfFields(quiet).join(', '));
    // A number too wide for its field loses decimals, never its whole part, or is left empty.
    const wide = core.shapefileParts([{ big: 123456789012.5, huge: 1e25, lat: 1, lon: 1 }], [[1, 1]], 'point');
    const rows = core.readDbf(wide.dbf.buffer, 'UTF-8');
    assert.equal(rows[0].big, 123456789012.5);
    assert.equal(rows[0].huge, '');
});

test('backups carry the shared overlays', () => {
    const one = core.parseBackup(core.backupText('ALPHA', [report()], 'Patrol', {}, {}, NOW, OVERLAYS)).data;
    assert.deepEqual(one.overlays, OVERLAYS);
    const all = core.parseBackup(core.allWorkspacesBackupText({ ALPHA: [report()] }, 'ALPHA', 'Patrol', {}, {}, NOW, OVERLAYS)).data;
    assert.deepEqual(all.overlays, OVERLAYS);
});

test('per-workspace overlays from older backups fold into one set', () => {
    const nai1b = { ...OVERLAYS[0], label: 'newer' };
    assert.deepEqual(core.foldOverlays({ ALPHA: OVERLAYS, BRAVO: [nai1b], CHARLIE: [] }),
        [nai1b, ...OVERLAYS.slice(1)], 'same type and name: the later one, in the first one\'s place');
    assert.deepEqual(core.foldOverlays(OVERLAYS), OVERLAYS);
    assert.deepEqual(core.foldOverlays(undefined), []);
    assert.deepEqual(core.foldOverlays('junk'), []);
});

// --- Statistics ---

test('Size lines are counted by type, plurals folded together', () => {
    assert.deepEqual(core.sizeElements('2x T-72, 4 BMP-2; truck + 3x T-72s, 2 trucks, 1x bus'), [
        { count: 2, type: 'T-72' }, { count: 4, type: 'BMP-2' }, { count: 1, type: 'TRUCK' },
        { count: 3, type: 'T-72' }, { count: 2, type: 'TRUCK' }, { count: 1, type: 'BUS' },
    ]);
    assert.deepEqual(core.sizeElements(''), []);
});

test('an unknown word keeps a final s unless it is clearly a plural', () => {
    const els = s => core.sizeElements(s).map(e => `${e.count} ${e.type}`);
    assert.deepEqual(els('2x Gas, 2x radius, 2x Atlas, 2x chassis, 3x widgets, 2x M1s, 2x 2S19'),
        ['2 GAS', '2 RADIUS', '2 ATLAS', '2 CHASSIS', '3 WIDGET', '2 M1', '2 2S19']);
});

test("a team's own types fold their plurals in the Statistics too", () => {
    const team = core.teamEquipment([{ type: 'widget', role: 'logistics' }]);
    const els = (s, t) => core.sizeElements(s, t).map(e => `${e.count} ${e.type}`);
    assert.deepEqual(els('3X WIDGETS, 2x widget'), ['3 WIDGETS', '2 WIDGET'], 'without the team: the catalogue alone');
    assert.deepEqual(els('3X WIDGETS, 2x widget', team), ['3 WIDGET', '2 WIDGET']);
    const reps = [report({ size: '3X WIDGETS' }), report({ id: 'r2', displayId: 'ALPHA002', size: '2x widget' })];
    assert.deepEqual(core.statsData(reps, [], { team }).equipment, [{ label: 'WIDGET', value: 5 }]);
    // The summaries take the team from the narrative settings, or as given.
    const rollup = o => core.summaryReport('rollup', reps, [], { local: false, now: NOW, ...o });
    assert.ok(rollup({ narrative: { equipment: [{ type: 'widget', role: 'logistics' }] } }).includes('   WIDGET 5\n'));
    assert.ok(rollup({ team }).includes('   WIDGET 5\n'));
    assert.ok(rollup({}).includes('   WIDGETS 3, WIDGET 2\n'));
});

test('grid squares at 10 km and 1 km, and grids too coarse for them', () => {
    assert.equal(core.gridSquare('38S MB 45000 82000', 1), '38S MB 4 8');
    assert.equal(core.gridSquare('38S MB 45000 82000', 2), '38S MB 45 82');
    assert.equal(core.gridSquare('38S MB 4 8', 2), null);
});

test('statistics count each report once per place, square, tag and type', () => {
    const reps = [
        report({ id: 'a', size: '2x T-72', activity: 'moving N', location: '38SMB4500082000', time: '2026-10-24T02:15:00Z' }),
        report({ id: 'b', size: '1x BMP-2', activity: 'stationary', location: '38S MB 55000 82000, NAI 1', time: '2026-10-24T02:40:00Z' }),
        report({ id: 'c', size: '3x T-72s', activity: 'dismounted, heading 090', location: '38SMB4500082000 38SMB4600082000', time: '2026-10-26T13:00:00Z' }),
        report({ id: 'd', size: 'truck', activity: 'parked', location: 'vic the bridge', time: '2026-10-26T13:30:00Z', deleted: true }),
        report({ id: 'e', size: '1x truck', activity: '', location: '38SMB4100084900, PL BLUE', time: '2026-10-26T14:00:00Z' }),
    ];
    const d = core.statsData(reps, OVERLAYS, { local: false });
    assert.deepEqual(d.kpis, { reports: 4, withGrid: 4, inPlace: 4, checks: 1, bdaDone: 0, bdaTotal: 7 });
    assert.deepEqual(d.nai, [{ label: 'NAI 1', value: 4 }]);
    assert.deepEqual(d.pl, [{ label: 'PL BLUE', value: 1 }], 'typed; grids 3 km off are not near it');
    // Report c names two grids in one 10 km square: counted once there.
    assert.deepEqual(d.squares, [{ label: '38S MB 4 8', value: 3 }, { label: '38S MB 5 8', value: 1 }]);
    assert.equal(d.hours[2].value, 2);
    assert.equal(d.hours[13].value, 1);
    assert.deepEqual(d.days, [
        { label: '2026-10-24', value: 2 }, { label: '2026-10-25', value: 0 }, { label: '2026-10-26', value: 2 },
    ], 'a quiet day is a zero, not a gap');
    assert.deepEqual(d.tags, [
        { label: 'Moving', value: 2 }, { label: 'Stationary', value: 1 }, { label: 'Dismounted', value: 1 }, { label: 'Untagged', value: 1 },
    ]);
    assert.deepEqual(d.headings.filter(h => h.value).map(h => h.label), ['N', 'E']);
    assert.deepEqual(d.equipment, [{ label: 'T-72', value: 5 }, { label: 'BMP-2', value: 1 }, { label: 'TRUCK', value: 1 }]);
    assert.deepEqual(d.bda, [], 'no BDA chart until something is assessed');
    const one = core.statsData(reps, OVERLAYS, { local: false, squareDigits: 2 });
    assert.deepEqual(one.squares.map(s => s.label), ['38S MB 45 82', '38S MB 41 84', '38S MB 46 82', '38S MB 55 82']);
    assert.deepEqual(core.statsData([], OVERLAYS, {}).days, []);
});

test('the statistics CSV has one section per chart', () => {
    assert.equal(core.statsCsv([
        { title: 'Reports per NAI', items: [{ label: 'NAI 1', value: 4 }] },
        { title: 'Activity, "tags"', items: [] },
    ]), '"Reports per NAI"\r\n"NAI 1",4\r\n\r\n"Activity, ""tags"""\r\n');
});

// --- Summary reports ---

const SUMMARY_REPS = [
    report({ id: 'a', displayId: 'ALPHA001', size: '2x T-72', activity: 'moving N', location: '38SMB4500082000', time: '2026-10-25T19:15:00Z' }),
    report({ id: 'b', displayId: 'ALPHA002', size: '1x BTR-82A', activity: 'stationary', location: '38S MB 55000 82000, NAI 1', time: '2026-10-25T21:40:00Z' }),
    report({ id: 'c', displayId: 'ALPHA003', size: '1x BMP-2', activity: 'engaging friendly OP', location: '38SMB5300088000', time: '2026-10-26T03:10:00Z',
             bda: [{ effect: 'Destroyed', target: '1x BMP-2' }] }),
    report({ id: 'd', displayId: 'ALPHA004', size: '2x BMP-2', activity: 'refueling', location: '38SMB4300093000', time: '2026-10-25T09:00:00Z' }),
];
const SUMMARY_OPTS = {
    local: false, now: new Date('2026-10-26T06:00:00Z'), ato: 'ALPHA', title: 'Patrol', by: 'AB',
    from: Date.parse('2026-10-25T18:00:00Z'), to: Date.parse('2026-10-26T06:00:00Z'),
};
const summary = (kind, extra = {}) => core.summaryReport(kind, SUMMARY_REPS, OVERLAYS, { ...SUMMARY_OPTS, ...extra }).split('\n');

test('summaries are headed with the period as DTGs and who prepared them', () => {
    assert.equal(core.dtg(Date.parse('2026-10-25T18:00:00Z'), false), '251800Z OCT 26');
    assert.deepEqual(summary('rollup').slice(0, 3), [
        'ROLLUP - ALPHA (Patrol)',
        'PERIOD:   251800Z OCT 26 TO 260600Z OCT 26 (12 HRS)',
        'PREPARED: 260600Z OCT 26 BY AB',
    ]);
    assert.equal(summary('rollup', { from: null, to: null })[1], 'PERIOD:   ALL REPORTS TO 260600Z OCT 26');
});

test('the rollup counts the period against the one before it', () => {
    const text = summary('rollup');
    assert.ok(text.includes('   3 reports (previous 12 hrs: 1). 3 with a grid; 3 in an NAI or OBJ.'), text.join('\n'));
    assert.ok(text.some(l => /^ {3}NAI 1 {9}2 {3}\(prev 0\) {3}Moving 1 \(heading N 1\), Stationary 1$/.test(l)), 'by place, with activity');
    // Its one BMP-2 is assessed destroyed: none of it is left.
    assert.ok(text.includes('   260310Z  ALPHA003  None left; engaging friendly OP; 38SMB5300088000'), 'firing is notable');
    assert.ok(text.includes('   1 of 4 items assessed: Destroyed 1.'));
    assert.ok(text.includes('   ALPHA002: NAI 1 typed; grid is in NAI 2'));
});

test('most trafficked ranks places with their peak hour and main activity', () => {
    const text = summary('trafficked');
    assert.ok(text.includes('   NAI 1           2 reports   peak 1900Z (1)   mostly Moving (1)'), text.join('\n'));
    assert.ok(text.includes('3. GRID SQUARES (1 KM)'));
    assert.ok(text.some(l => l.startsWith('   38S MB 53 88    1 report') && l.endsWith('; in NAI 2')));
});

test('place activity lists every report there in order, across midnight', () => {
    const text = summary('place', { place: 'NAI 1' });
    assert.equal(text[0], 'NAI 1 ACTIVITY - ALPHA (Patrol)');
    assert.deepEqual(text.slice(text.indexOf('DTG      REPORT    SIZE; ACTIVITY; LOCATION') + 1, -1), [
        '251915Z  ALPHA001  2x T-72; moving N; 38SMB4500082000',
        '252140Z  ALPHA002  1x BTR-82A; stationary; 38S MB 55000 82000, NAI 1',
    ]);
    assert.ok(summary('place', { place: '' }).includes('Pick an NAI, OBJ, or phase line.'));
});

test('the shift brief is the short handover', () => {
    const text = summary('brief');
    assert.equal(text[1], 'SHIFT:    251800Z OCT 26 TO 260600Z OCT 26 (12 HRS)');
    assert.ok(text.includes('REPORTS:      3 (previous shift 1)'));
    assert.ok(text.includes('LAST REPORT:  260310Z  ALPHA003  None left; engaging friendly OP; 38SMB5300088000'));
    assert.ok(text.includes('OPEN ITEMS:   1 check to look at; 3 BDA items unassessed'));
});

test('the same reports always give the same words', () => {
    assert.equal(core.summaryReport('rollup', SUMMARY_REPS, OVERLAYS, SUMMARY_OPTS),
                 core.summaryReport('rollup', [...SUMMARY_REPS].reverse(), OVERLAYS, SUMMARY_OPTS));
});

test('places to summarize: every overlay, then whatever reports name', () => {
    assert.deepEqual(core.summaryPlaces([report({ location: '38SMB4500082000, OBJ GOLD' })], OVERLAYS),
        ['NAI 1', 'NAI 2', 'OBJ BRIDGE', 'OBJ GOLD', 'PL BLUE']);
});

// --- Shapefiles ---

// A minimal shapefile writer for the tests: `shapes` are { type: 1 | 3 | 5,
// parts: [[[x, y], ...], ...] } (a point has one part of one position), and
// `names` fill a one-column .dbf.
const writeShapefile = (shapes, names) => {
    const recs = shapes.map(s => {
        const pts = s.parts.flat();
        const len = s.type === 1 ? 20 : 44 + 4 * s.parts.length + 16 * pts.length;
        const b = new DataView(new ArrayBuffer(8 + len));
        b.setInt32(4, len / 2);
        b.setInt32(8, s.type, true);
        if (s.type === 1) { b.setFloat64(12, pts[0][0], true); b.setFloat64(20, pts[0][1], true); return b.buffer; }
        b.setInt32(8 + 36, s.parts.length, true);
        b.setInt32(8 + 40, pts.length, true);
        let at = 0;
        s.parts.forEach((p, k) => { b.setInt32(8 + 44 + 4 * k, at, true); at += p.length; });
        pts.forEach(([x, y], k) => { const o = 8 + 44 + 4 * s.parts.length + 16 * k; b.setFloat64(o, x, true); b.setFloat64(o + 8, y, true); });
        return b.buffer;
    });
    const total = 100 + recs.reduce((n, r) => n + r.byteLength, 0);
    const shp = new Uint8Array(total), head = new DataView(shp.buffer);
    head.setInt32(0, 9994); head.setInt32(24, total / 2); head.setInt32(28, 1000, true); head.setInt32(32, shapes[0].type, true);
    let o = 100;
    recs.forEach(r => { shp.set(new Uint8Array(r), o); o += r.byteLength; });
    const width = 20, headLen = 32 + 32 + 1, recLen = 1 + width;
    const dbf = new Uint8Array(headLen + recLen * names.length + 1), d = new DataView(dbf.buffer);
    dbf[0] = 3; d.setUint32(4, names.length, true); d.setUint16(8, headLen, true); d.setUint16(10, recLen, true);
    [...'NAME'].forEach((c, k) => { dbf[32 + k] = c.charCodeAt(0); });
    dbf[32 + 11] = 'C'.charCodeAt(0); dbf[32 + 16] = width; dbf[64] = 0x0d;
    names.forEach((n, r) => {
        const at = headLen + r * recLen;
        dbf[at] = 0x20;
        const bytes = new TextEncoder().encode(n.padEnd(width).slice(0, width));
        dbf.set(bytes.subarray(0, width), at + 1);
    });
    dbf[dbf.length - 1] = 0x1a;
    return { shp: shp.buffer, dbf: dbf.buffer };
};
const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const utmPrj = (zone, south) => `PROJCS["WGS_1984_UTM_Zone_${zone}${south ? 'S' : 'N'}",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",${south ? 10000000 : 0}.0],PARAMETER["Central_Meridian",${zone * 6 - 183}.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;

test('a shapefile reads as areas (holes kept), lines and points, with its names', () => {
    // Outer rings clockwise, the hole counter-clockwise, as shapefiles have them.
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    const other = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]];
    const { shp, dbf } = writeShapefile([
        { type: 5, parts: [outer, hole, other] },
        { type: 3, parts: [[[0, 20], [10, 21]]] },
        { type: 1, parts: [[[5, 30]]] },
    ], ['NAI 1', 'PL Blue', 'Label']);
    const fc = core.parseShapefile(shp, dbf, WGS84_PRJ);
    assert.deepEqual(fc.features.map(f => [f.geometry.type, f.properties.NAME]),
        [['MultiPolygon', 'NAI 1'], ['LineString', 'PL Blue'], ['Point', 'Label']]);
    const area = fc.features[0].geometry;
    assert.deepEqual(area.coordinates, [[outer, hole], [other]]);
    assert.equal(core.geometryContains(area, 3, 3), false, 'in the hole');
    assert.equal(core.geometryContains(area, 6, 6), true);
    assert.equal(core.geometryContains(area, 22, 2), true, 'the second part');
});

test('a damaged shapefile ends or is refused in words, never hangs', () => {
    const line = () => writeShapefile([{ type: 3, parts: [[[0, 20], [10, 21]]] }, { type: 1, parts: [[[5, 30]]] }], ['a', 'b']).shp;
    const edit = (f) => { const shp = line(); f(new DataView(shp)); return shp; };
    // A record length of none, or less than none, ends the file there.
    [-4, 0, 1].forEach(words => {
        const fc = core.parseShapefile(edit(v => v.setInt32(104, words)), null, WGS84_PRJ);
        assert.deepEqual(fc.features, [], `${words} words`);
    });
    // Counts past the end of their record, or impossible ones, are refused.
    const damaged = { message: /^it is damaged \(a shape runs past its end\)/ };
    [
        v => v.setInt32(108 + 40, 1e6, true),        // points
        v => v.setInt32(108 + 36, 0x7fffffff, true), // parts
        v => v.setInt32(108 + 40, -1, true),
        v => v.setInt32(108 + 44, 5, true),          // a part starting past the points
    ].forEach((f, i) => assert.throws(() => core.parseShapefile(edit(f), null, WGS84_PRJ), damaged, `case ${i}`));
    // A record shorter than its shape needs is refused; one running past the file ends it.
    assert.throws(() => core.parseShapefile(edit(v => v.setInt32(104, 10)), null, WGS84_PRJ), damaged);
    assert.deepEqual(core.parseShapefile(edit(v => v.setInt32(104, 1000)), null, WGS84_PRJ).features, []);
});

test("a shapefile's coordinates come to longitude / latitude from its .prj", () => {
    const { shp } = writeShapefile([{ type: 1, parts: [[[400000, 3905000]]] }], ['x']);
    const [lon, lat] = core.parseShapefile(shp, null, utmPrj(11, false)).features[0].geometry.coordinates;
    // Reference: the `utm` Python package.
    assert.ok(Math.abs(lon - -118.09964964384866) < 1e-7 && Math.abs(lat - 35.28316447698027) < 1e-7, `${lon} ${lat}`);
    const south = writeShapefile([{ type: 1, parts: [[[500000, 6000000]]] }], ['x']).shp;
    const [lon2, lat2] = core.parseShapefile(south, null, utmPrj(33, true)).features[0].geometry.coordinates;
    assert.ok(Math.abs(lon2 - 15) < 1e-7 && Math.abs(lat2 - -36.14471809833201) < 1e-7, `${lon2} ${lat2}`);
    const merc = writeShapefile([{ type: 1, parts: [[[-12974286.651, 4202000]]] }], ['x']).shp;
    const prj = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]';
    const [lon3] = core.parseShapefile(merc, null, prj).features[0].geometry.coordinates;
    assert.ok(Math.abs(lon3 - -116.55) < 1e-7, `${lon3}`);
    // No .prj: fine when it already reads as longitude / latitude, refused when it doesn't.
    const plain = writeShapefile([{ type: 1, parts: [[[-116.5, 35.2]]] }], ['x']).shp;
    assert.deepEqual(core.parseShapefile(plain, null, null).features[0].geometry.coordinates, [-116.5, 35.2]);
    assert.throws(() => core.parseShapefile(shp, null, null), /no \.prj/);
    assert.throws(() => core.parseShapefile(shp, null, 'PROJCS["NAD_1927_StatePlane_California_V",GEOGCS["GCS_North_American_1927"]]'),
        /NAD 1927 StatePlane California V/);
    assert.throws(() => core.parseShapefile(new ArrayBuffer(120), null, null), /not a shapefile/);
});

// --- Tracks, heat, and the map ---

const moving = () => report({
    id: 't', location: '38SMB4500082000, NAI 1', time: '2026-10-24T06:00:00Z', updated: true,
    history: [
        // Out of order on purpose: tracks follow the reported Time.
        { location: '38SMB4500080000', time: '2026-10-24T05:00:00Z', lastModified: 2, size: '', activity: '' },
        { location: '38SMB4500078000', time: '2026-10-24T04:00:00Z', lastModified: 1, size: '', activity: '' },
        { location: '38SMB4500080000 again', time: '2026-10-24T05:30:00Z', lastModified: 3, size: '', activity: '' },
        { location: 'no grid yet', time: '2026-10-24T03:00:00Z', lastModified: 0, size: '', activity: '' },
    ],
});

test('a track follows a report from its first grid to its latest, in the order reported', () => {
    const [t] = core.reportTracks([moving()]);
    assert.deepEqual(t.points.map(p => p.mgrs), ['38S MB 45000 78000', '38S MB 45000 80000', '38S MB 45000 82000'],
        'a repeated grid counts once; a version without a grid is skipped');
    assert.equal(t.points[1].time, '2026-10-24T05:30:00Z', 'the repeat moves the time on');
    assert.equal(t.moved, true);
    assert.ok(Math.abs(t.lengthM - 4000) < 20, `${t.lengthM}`);
    assert.ok(t.bearingDeg < 1 || t.bearingDeg > 359, `due north: ${t.bearingDeg}`);
    const still = core.reportTracks([report({ location: '38SMB4500082000' }), report({ id: 'x', location: 'vic the bridge' })]);
    assert.deepEqual(still.map(s => [s.moved, s.points.length, s.bearingDeg]), [[false, 1, null]], 'no grid: no track');
});

test('a heat map counts each report once, at its latest Location', () => {
    const pts = core.heatPoints([moving(), report({ id: 'b', location: '38SMB4500082000 38SMB5500082000' }), report({ id: 'c', deleted: true })]);
    assert.deepEqual(pts.map(p => p.w), [1, 0.5, 0.5]);
    assert.equal(pts.reduce((n, p) => n + p.w, 0), 2, 'two reports, however many updates');
});

test('the ArcGIS tracks export is one line per report that moved', () => {
    const rows = core.arcgisTrackRows([moving(), report({ id: 'still', location: '38SMB4500082000' })], { local: false, idOf: r => r.id });
    assert.equal(rows.length, 1, 'a report that never moved is a point, not a line');
    const r = rows[0];
    assert.deepEqual([r.report_id, r.positions, r.direction, r.start_utc, r.end_utc, r.start_mgrs, r.end_mgrs],
        ['t', 3, 'N', '2026-10-24T04:00:00Z', '2026-10-24T06:00:00Z', '38S MB 45000 78000', '38S MB 45000 82000']);
    const gj = JSON.parse(core.arcgisTracksGeoJson(rows)).features[0];
    assert.equal(gj.geometry.type, 'LineString');
    assert.equal(gj.geometry.coordinates.length, 3);
    assert.equal(gj.properties.path, undefined, 'the path is the geometry, not a field');
    const esri = JSON.parse(core.arcgisTracksEsriJson(rows));
    assert.equal(esri.geometryType, 'esriGeometryPolyline');
    assert.deepEqual(esri.features[0].geometry.paths[0], r.path);
    assert.ok(esri.fields.some(f => f.name === 'bearing_deg' && f.type === 'esriFieldTypeInteger'));
    assert.ok(!esri.fields.some(f => f.name === 'path'));
});

test('the CSV can hold just the latest version of each report', () => {
    const opts = { local: false, customLabels: [], idOf: r => r.id };
    const rows = s => s.trim().split('\r\n').length - 1;
    assert.equal(rows(core.reportsCsv([moving()], opts)), 5, 'the report and its four updates');
    assert.equal(rows(core.reportsCsv([moving()], { ...opts, latestOnly: true })), 1);
});

test('map tiles and WMS requests cover the box asked for', () => {
    const [x0, y0] = core.lonLatToMerc(44.35, 33.25), [x1, y1] = core.lonLatToMerc(44.57, 33.39);
    const z = core.tileZoom(20);  // 20 m a pixel
    assert.equal(z, 13);
    const tiles = core.tilesFor([x0, y0, x1, y1], z);
    assert.ok(tiles.length >= 4 && tiles.length <= 30, `${tiles.length}`);
    const covers = tiles.some(t => t.box[0] <= x0 && t.box[2] >= x0 && t.box[1] <= y0 && t.box[3] >= y0);
    assert.ok(covers, 'the south-west corner is in a tile');
    assert.equal(core.tilesFor([x0, y0, x1, y1], 19, 50), null, 'too many to fetch');
    // The south-west corner's tile by the usual OSM formula: x 5105, y 3292 at z13.
    assert.ok(tiles.some(t => t.x === 5105 && t.y === 3292), JSON.stringify(tiles.map(t => [t.x, t.y])));
    assert.equal(core.tileUrl('https://t/{z}/{y}/{x}.png', { z: 3, x: 5, y: 2 }), 'https://t/3/2/5.png');
    assert.equal(core.tileUrl('https://t/wmts?TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}', { z: 3, x: 5, y: 2 }),
        'https://t/wmts?TILEMATRIX=3&TILEROW=2&TILECOL=5');
    assert.equal(core.tileUrl('https://t/{z}/{x}/{-y}.png', { z: 3, x: 5, y: 2 }), 'https://t/3/5/5.png');
    const url = core.wmsUrl('https://maps.example/wms?map=ops&layers=old&srs=EPSG:4326', 'imagery', [1, 2, 3, 4], 800, 600);
    assert.equal(url, 'https://maps.example/wms?map=ops&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=imagery&STYLES=&CRS=EPSG:3857&BBOX=1.00,2.00,3.00,4.00&WIDTH=800&HEIGHT=600&FORMAT=image/png&TRANSPARENT=FALSE');
    assert.ok(core.wmsUrl('https://maps.example/wms?LAYERS=a,b', '', [1, 2, 3, 4], 10, 10).includes('LAYERS=a,b'), 'its own layers, when none given');
});

test('WMS: the service\'s version, projection and format', () => {
    const box = [...core.lonLatToMerc(-116.6, 35.2), ...core.lonLatToMerc(-116.4, 35.4)];
    const v111 = core.wmsUrl('http://s/wms', 'a', box, 100, 100, { version: '1.1.1', crs: 'EPSG:4326', format: 'image/jpeg' });
    assert.ok(v111.includes('VERSION=1.1.1') && v111.includes('SRS=EPSG:4326') && !v111.includes('CRS='), v111);
    assert.ok(v111.includes('FORMAT=image/jpeg'));
    assert.ok(v111.includes('BBOX=-116.6000000,35.2000000,-116.4000000,35.4000000'), 'lon, lat in 1.1.1');
    const v130 = core.wmsUrl('http://s/wms', 'a', box, 100, 100, { version: '1.3.0', crs: 'EPSG:4326' });
    assert.ok(v130.includes('CRS=EPSG:4326') && v130.includes('BBOX=35.2000000,-116.6000000,35.4000000,-116.4000000'), 'lat, lon in 1.3.0');
    const crs84 = core.wmsUrl('http://s/wms', 'a', box, 100, 100, { crs: 'CRS:84' });
    assert.ok(crs84.includes('BBOX=-116.6000000,35.2000000'), 'CRS:84 is lon, lat');
    assert.ok(core.wmsUrl('http://s/wms', 'a', [1, 2, 3, 4], 10, 10, { crs: 'EPSG:102100' }).includes('BBOX=1.00,2.00,3.00,4.00'), 'meters');
    const [lon, lat] = core.mercToLonLat(...core.lonLatToMerc(-116.5, 35.3));
    assert.ok(Math.abs(lon + 116.5) < 1e-9 && Math.abs(lat - 35.3) < 1e-9);
});

test('WMS: capabilities link, projection and format choices', () => {
    assert.equal(core.wmsCapabilitiesUrl(' https://s/arcgis/services/x/MapServer/WMSServer?request=GetMap&LAYERS=0&token=abc&BBOX=1,2,3,4 '),
        'https://s/arcgis/services/x/MapServer/WMSServer?token=abc&SERVICE=WMS&REQUEST=GetCapabilities');
    assert.equal(core.wmsCapabilitiesUrl('http://s/geoserver/wms'), 'http://s/geoserver/wms?SERVICE=WMS&REQUEST=GetCapabilities');
    assert.equal(core.pickWmsCrs([['EPSG:4326', 'epsg:3857'], ['EPSG:3857']]), 'EPSG:3857');
    assert.equal(core.pickWmsCrs([['EPSG:4326', 'EPSG:900913'], ['EPSG:900913', 'EPSG:32611']]), 'EPSG:900913');
    assert.equal(core.pickWmsCrs([['EPSG:4326', 'EPSG:3857'], ['EPSG:4326']]), 'EPSG:4326', 'what every layer has');
    assert.equal(core.pickWmsCrs([['EPSG:32611']]), null);
    assert.equal(core.pickWmsCrs([]), null);
    assert.equal(core.pickWmsFormat(['image/jpeg', 'image/png8', 'image/png']), 'image/png');
    assert.equal(core.pickWmsFormat(['image/gif', 'image/jpeg']), 'image/jpeg');
    assert.equal(core.pickWmsFormat([]), 'image/png');
    // A "?" inside a value is kept: only the first one starts the parameters.
    assert.equal(core.wmsCapabilitiesUrl('http://s/wms?map=/maps/a.map&next=b?c=1'),
        'http://s/wms?map=/maps/a.map&next=b?c=1&SERVICE=WMS&REQUEST=GetCapabilities');
});

test('a zip of stored files reads back, with the right CRCs', () => {
    assert.equal(core.crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
    const zip = core.zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }], new Date(2026, 9, 26, 14, 30));
    const v = new DataView(zip.buffer);
    assert.equal(v.getUint32(0, true), 0x04034b50);
    const end = zip.length - 22;
    assert.equal(v.getUint32(end, true), 0x06054b50);
    assert.equal(v.getUint16(end + 10, true), 2, 'two files');
    const cd = v.getUint32(end + 16, true);
    assert.equal(v.getUint32(cd, true), 0x02014b50);
    assert.equal(new TextDecoder().decode(zip.subarray(30 + 5, 30 + 5 + 5)), 'hello', 'stored as is');
});

test('the ArcGIS points and tracks as shapefiles read back', () => {
    const rows = [
        { report_id: 'NTC001', heading_deg: 90, precision_m: 10, analysis: 'é'.repeat(300), lat: 35.2512345, lon: -116.5512345, none: null },
        { report_id: 'NTC002', heading_deg: null, precision_m: 1, analysis: 'short', lat: 35.26, lon: -116.56, none: null },
    ];
    const p = core.shapefileParts(rows, rows.map(r => [r.lon, r.lat]), 'point');
    const ab = u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
    const fc = core.parseShapefile(ab(p.shp), ab(p.dbf), new TextDecoder().decode(p.prj), 'UTF-8');
    assert.equal(fc.features.length, 2);
    assert.deepEqual(fc.features[0].geometry.coordinates, [-116.5512345, 35.2512345]);
    const a = fc.features[0].properties;
    assert.equal(a.report_id, 'NTC001');
    assert.equal(a.head_deg, 90, 'long names cut to fit');
    assert.equal(a.prec_m, 10);
    assert.equal(a.analysis, 'é'.repeat(127), 'text cut to 254 bytes, whole characters only');
    assert.equal(a.lat, 35.2512345);
    assert.equal(fc.features[1].properties.head_deg, '', 'empty number');
    assert.equal(new DataView(ab(p.shx)).getInt32(100), 50, 'index points at the first record');
    const tracks = [{ report_id: 'NTC003', length_m: 1500, path: [[-116.55, 35.25], [-116.54, 35.26], [-116.53, 35.27]] }];
    const t = core.shapefileParts(tracks.map(({ path, ...r }) => r), tracks.map(r => r.path), 'line');
    const tf = core.parseShapefile(ab(t.shp), ab(t.dbf), null, 'UTF-8');
    assert.deepEqual(tf.features[0].geometry, { type: 'LineString', coordinates: tracks[0].path });
    assert.equal(tf.features[0].properties.length_m, 1500);
    const zip = core.arcgisTracksShapefileZip(tracks, 'NTC_tracks');
    assert.ok(new TextDecoder().decode(zip).includes('NTC_tracks.dbf'));
});

test('a locked grid prefix goes in front of grids typed as digits', () => {
    assert.equal(core.mgrsPrefix('11snv'), '11S NV');
    assert.equal(core.mgrsPrefix(' 4q fj '), '4Q FJ');
    assert.equal(core.mgrsPrefix('11S'), null, 'the 100 km square is part of it');
    assert.equal(core.mgrsPrefix('61S NV'), null);
    assert.equal(core.mgrsPrefix('11S NI'), null, 'no I or O');
    assert.equal(core.applyMgrsPrefix('39697 06762', '11SNV'), '11S NV 39697 06762');
    assert.equal(core.applyMgrsPrefix('3969706762, NAI 2', '11S NV'), '11S NV 39697 06762, NAI 2');
    assert.equal(core.applyMgrsPrefix('397 067, 11S NV 40007 05191', '11S NV'), '11S NV 397 067, 11S NV 40007 05191', 'full grids kept');
    assert.equal(core.applyMgrsPrefix('Hill 205, 205, 39 067', '11S NV'), 'Hill 205, 205, 39 067', 'not grids');
    assert.equal(core.applyMgrsPrefix('39697 06762', ''), '39697 06762', 'no prefix set');
    // And back, for a report put in the form: its digits, the zone and square in the lock's box.
    assert.equal(core.stripMgrsPrefix('11S NV 39697 06762, NAI 2', '11S NV'), '39697 06762, NAI 2');
    assert.equal(core.stripMgrsPrefix('11SNV3969706762', '11SNV'), '39697 06762');
    assert.equal(core.stripMgrsPrefix('11S NV 397 067', '11S NV'), '397 067');
    assert.equal(core.stripMgrsPrefix('38S MB 45000 82000, 11S NV 1 2', '11S NV'), '38S MB 45000 82000, 1 2', 'another square kept');
    assert.equal(core.stripMgrsPrefix('11S NV 397 0670', '11S NV'), '11S NV 397 0670', 'not a grid, kept');
    assert.equal(core.stripMgrsPrefix('vic Hill 205', '11S NV'), 'vic Hill 205');
    assert.equal(core.stripMgrsPrefix('11S NV 39697 06762', ''), '11S NV 39697 06762', 'no prefix set');
    ['11S NV 39697 06762, vic bridge', '11S NV 397 067'].forEach(loc =>
        assert.equal(core.normalizeLocation(core.applyMgrsPrefix(core.stripMgrsPrefix(loc, '11S NV'), '11S NV')), core.normalizeLocation(loc), loc));
});

// The files in a zip of stored entries, by name.
const unzipStored = (zip) => {
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength), out = {};
    for (let o = 0; v.getUint32(o, true) === 0x04034b50;) {
        const size = v.getUint32(o + 18, true), nl = v.getUint16(o + 26, true), xl = v.getUint16(o + 28, true);
        const name = new TextDecoder().decode(zip.subarray(o + 30, o + 30 + nl));
        out[name] = new TextDecoder().decode(zip.subarray(o + 30 + nl + xl, o + 30 + nl + xl + size));
        o += 30 + nl + xl + size;
    }
    return out;
};

test('the report table for a workbook: one row per report, times as Excel dates', () => {
    assert.equal(core.excelSerial(Date.UTC(1970, 0, 1), false), 25569);
    assert.equal(core.excelSerial(Date.UTC(2026, 9, 24, 6, 0), false), 46319.25);
    assert.deepEqual(['A', 'Z', 'AA', 'AZ', 'BA'].map((_, i) => core.colName([0, 25, 26, 51, 52][i])), ['A', 'Z', 'AA', 'AZ', 'BA']);
    const reps = [
        report({ id: 'r2', displayId: 'ALPHA002', location: '18SUJ2337106519, NAI 1', activity: 'moving N', custom: { Weather: 'rain' },
                 history: [{ size: '1x T-72' }], updated: true, user: { initials: 'AB' } }),
        report({ deleted: true, id: 'gone' }),
        report({ time: 'not a time' }),
    ];
    const t = core.workbookReportRows(reps, [], { local: false, idOf: r => r.displayId, customLabels: ['Weather'] });
    assert.deepEqual(t.header.slice(0, 7), ['Identifier', 'Status', 'By', 'Size', 'Activity', 'Location', 'Time (Z)']);
    assert.equal(t.header[t.header.length - 1], 'Weather');
    assert.equal(t.rows.length, 2, 'deleted reports left out');
    const [first, second] = t.rows;
    assert.equal(first[0], 'ALPHA001', 'in report order');
    assert.equal(second[1], 'Updated');
    assert.equal(second[2], 'AB');
    assert.deepEqual(second[6], { date: core.excelSerial(Date.parse('2026-10-24T04:12:00Z'), false) });
    assert.equal(second[8], 'NAI 1');
    assert.equal(second[9], 'Moving');
    assert.equal(second[10], 'N');
    assert.equal(second[12], 1, 'one saved update');
    assert.equal(second[13], 'rain');
    assert.equal(first[6], '', 'no date when the time cannot be read');
});

test('the Statistics workbook: its parts, the tables its charts are drawn from, and the report table', () => {
    const charts = [
        { title: 'Reports per NAI', unit: 'Reports', kind: 'bar', items: Array.from({ length: 12 }, (_, i) => ({ label: `NAI ${i + 1}`, value: 12 - i })) },
        { title: 'Reports by hour <Z> & more', unit: 'Reports', kind: 'column', axis: 'Hour (Z)', items: [{ label: '00', value: 1 }, { label: '01', value: 3 }] },
    ];
    const reports = { header: ['Identifier', 'Time (Z)', 'Identifier'], rows: [['ALPHA001', { date: 46319.25 }, 'x'], ['ALPHA002', '', 'y']] };
    const files = unzipStored(core.statsXlsx({ context: 'ALPHA · all reports', kpis: [{ label: 'Reports', value: 2 }], charts, reports }, NOW));
    assert.equal(Object.keys(files)[0], '[Content_Types].xml', 'content types first');
    for (const part of ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
                        'xl/drawings/drawing1.xml', 'xl/charts/chart1.xml', 'xl/charts/chart2.xml', 'xl/tables/table1.xml']) {
        assert.ok(files[part], part);
        assert.ok(files['[Content_Types].xml'].includes(`PartName="/${part}"`), `${part} has a content type`);
    }
    // The bar chart shows the top ten; its table holds all twelve.
    const bar = files['xl/charts/chart1.xml'];
    assert.match(bar, /<c:barDir val="bar"\/>/);
    assert.match(bar, /'Statistics'!\$A\$\d+:\$A\$\d+/);
    const [, r0, r1] = /'Statistics'!\$B\$(\d+):\$B\$(\d+)/.exec(bar);
    assert.equal(+r1 - +r0 + 1, 10);
    assert.match(files['xl/sharedStrings.xml'], /The chart shows the top 10/);
    assert.match(files['xl/charts/chart2.xml'], /<c:barDir val="col"\/>/);
    assert.match(files['xl/charts/chart2.xml'], /Reports by hour &lt;Z&gt; &amp; more/, 'text escaped');
    assert.match(files['xl/charts/chart2.xml'], /<c:roundedCorners val="0"\/>/);
    // The report table: header row, unique column names, its range, a date cell.
    const table = files['xl/tables/table1.xml'];
    assert.match(table, /ref="A1:C3"/);
    assert.match(table, /name="Identifier 2"/, 'repeated names made unique');
    const thrice = unzipStored(core.statsXlsx({ reports: { header: ['Identifier', 'Identifier', 'identifier'], rows: [['a', 'b', 'c']] } }, NOW));
    assert.match(thrice['xl/tables/table1.xml'], /name="Identifier"\/><tableColumn id="2" name="Identifier 2"\/><tableColumn id="3" name="identifier 3"/);
    assert.match(files['xl/worksheets/sheet2.xml'], /<c r="B2" s="4"><v>46319.25<\/v><\/c>/);
    assert.match(files['xl/worksheets/sheet2.xml'], /state="frozen"/);
    assert.match(files['xl/sharedStrings.xml'], /<t xml:space="preserve">ALPHA · all reports<\/t>/);
    // No reports and no charts: still a workbook, without a table or drawing.
    const empty = unzipStored(core.statsXlsx({ charts: [], reports: { header: ['A'], rows: [] } }, NOW));
    assert.ok(!empty['xl/tables/table1.xml'] && !empty['xl/drawings/drawing1.xml']);
    assert.ok(!empty['[Content_Types].xml'].includes('table1'));
    // Text XML can't hold is left out: control characters and a lone half
    // of a surrogate pair; an emoji (a whole pair) stays.
    const odd = unzipStored(core.statsXlsx({ title: 'a\u0001b\uD800c\uDC00d\u{1F600}e￾f', charts: [], reports: { header: [], rows: [] } }, NOW));
    assert.match(odd['xl/sharedStrings.xml'], /<t xml:space="preserve">abcd\u{1F600}ef<\/t>/u);
});

test('report positions: the latest grids, or every saved version at its grids', () => {
    const r = report({
        location: '38SMB4500082000, 38SMB5500082000', time: '2026-10-24T06:00:00Z', lastModified: 30,
        history: [
            { location: '38SMB4500084000', time: '2026-10-24T05:00:00Z', lastModified: 20 },
            { location: '38SMB4500086000', time: '2026-10-24T04:00:00Z', lastModified: 10 },
        ],
    });
    const latest = core.reportPositions([r, report({ id: 'gone', deleted: true })]);
    assert.deepEqual(latest.map(p => [p.mgrs, p.w, p.latest]), [['38S MB 45000 82000', 0.5, true], ['38S MB 55000 82000', 0.5, true]]);
    const all = core.reportPositions([r], true);
    assert.deepEqual(all.map(p => p.mgrs), ['38S MB 45000 86000', '38S MB 45000 84000', '38S MB 45000 82000', '38S MB 55000 82000'], 'oldest first');
    assert.deepEqual(all.map(p => p.latest), [false, false, true, true]);
    assert.equal(all.reduce((t, p) => t + p.w, 0), 3, 'each version counts once');
    assert.equal(core.heatPoints([r], true).length, 4);
    assert.equal(core.heatPoints([r]).length, 2);
});

test('activity filter: any picked tag, Untagged for none, and nothing picked takes all', () => {
    assert.equal(core.activityMatches('moving N', new Set(['Moving'])), true);
    assert.equal(core.activityMatches('dug in, observing', new Set(['Moving'])), false);
    assert.equal(core.activityMatches('dug in, observing', new Set(['Moving', 'Observing'])), true);
    assert.equal(core.activityMatches('waving', new Set(['Untagged'])), true);
    assert.equal(core.activityMatches('moving N', new Set(['Untagged'])), false);
    assert.equal(core.activityMatches('anything', new Set()), true);
});

// --- Narrative ---

test('the equipment catalogue knows Russian and Chinese systems, and plain words', () => {
    const kit = t => { const k = core.lookupEquipment(t); return k && `${k.role} ${k.origin} ${k.name}`; };
    assert.equal(kit('T-72B3'), 'armor RU T-72');
    assert.equal(kit('t72'), 'armor RU T-72');
    assert.equal(kit('T-720'), null, 'a designator is matched up to its last digit');
    assert.equal(kit('2S19 MSTA-S'), 'fires RU 2S19');
    assert.equal(kit('2S1'), 'fires RU 2S1', 'not 2S19');
    assert.equal(kit('MSTA-B'), 'fires RU 2A65');
    assert.equal(kit('BM-21 GRAD'), 'fires RU BM-21');
    assert.equal(kit('GRADER'), null, 'names match whole words');
    assert.equal(kit('BMP-1KSh'), 'c2 RU BMP-1KSh', 'the longer name wins');
    assert.equal(kit('BTR-82A'), 'mech RU BTR-82');
    assert.equal(kit('ZSU-23-4'), 'ad RU ZSU-23-4');
    assert.equal(kit('TOR-M2'), 'ad RU Tor');
    assert.equal(kit('Tornado-G'), 'fires RU Tornado-G');
    assert.equal(kit('Type 99A'), 'armor CN Type 99');
    assert.equal(kit('ZBD-04A'), 'mech CN ZBD-04');
    assert.equal(kit('PHL-16'), 'fires CN PHL-16');
    assert.equal(kit('HQ-9B'), 'ad CN HQ-9');
    assert.equal(kit('TANK'), 'armor  tank');
    assert.equal(kit('FUEL TANKER'), 'logistics  truck', 'a tanker is not a tank');
    assert.equal(kit('TRUCK'), 'logistics  truck');
    assert.equal(kit('PAX'), 'infantry  PAX');
    // Every entry has a known role, and Russian, Chinese, or any army.
    const roles = new Set(['armor', 'mech', 'recon', 'fires', 'ad', 'atgm', 'engineer', 'logistics', 'c2', 'ew', 'air', 'infantry', 'light', 'vehicle']);
    core.EQUIPMENT_CATALOGUE.forEach(([role, origin, name]) => {
        assert.ok(roles.has(role), `${name}: ${role}`);
        assert.ok(['RU', 'CN', ''].includes(origin), `${name}: ${origin}`);
    });
});

test('a count suggests a unit size, approximately', () => {
    assert.equal(core.echelonOf('maneuver', 2), 'section');
    assert.equal(core.echelonOf('maneuver', 3), 'platoon');
    assert.equal(core.echelonOf('maneuver', 10), 'company');
    assert.equal(core.echelonOf('maneuver', 31), 'battalion');
    assert.equal(core.echelonOf('fires', 6), 'battery');
    assert.equal(core.echelonOf('infantry', 8), 'squad');
    assert.equal(core.echelonOf('infantry', 0), null);
    assert.deepEqual(core.ICD203.map(([t]) => t), ['almost no chance', 'very unlikely', 'unlikely', 'roughly even chance', 'likely', 'very likely', 'almost certain']);
});

const NARRATIVE_REPS = [
    report({ id: 'n1', displayId: 'ALPHA011', size: '2x BRDM-2', activity: 'observing', location: '38SMB4500082000', time: '2026-10-25T20:00:00Z', user: { initials: 'AB' } }),
    report({ id: 'n2', displayId: 'ALPHA012', size: '2x T-72, 3x BMP-2', activity: 'moving N', location: '38SMB4500082000', time: '2026-10-25T22:00:00Z', user: { initials: 'CD' } }),
    report({ id: 'n3', displayId: 'ALPHA013', size: '6x PAX', activity: 'digging in', location: '38SMB4600082000', time: '2026-10-25T23:00:00Z', user: { initials: 'AB' } }),
    report({ id: 'n4', displayId: 'ALPHA014', size: '1x MTU-20', activity: 'emplacing obstacles', location: '38SMB4600083000', time: '2026-10-26T01:00:00Z', user: { initials: 'CD' } }),
    report({ id: 'n5', displayId: 'ALPHA015', size: '1x XYZ-9', activity: 'stationary', location: 'vic hill 220', time: '2026-10-26T02:00:00Z', user: { initials: 'AB' } }),
];
const narrative = (reps = NARRATIVE_REPS, extra = {}) => core.summaryReport('narrative', reps, OVERLAYS, { ...SUMMARY_OPTS, ...extra }).split('\n');

test('the narrative says what was observed, apart from what is assessed', () => {
    const text = narrative();
    assert.equal(text[0], 'NARRATIVE - ALPHA (Patrol)');
    const obs = text.indexOf('1. OBSERVED'), ass = text.indexOf('2. ASSESSMENT'), gaps = text.indexOf('3. GAPS');
    assert.ok(obs > 0 && ass > obs && gaps > ass, text.join('\n'));
    const observed = text.slice(obs, ass).join(' ').replace(/\s+/g, ' ');
    assert.ok(observed.includes('5 reports from 2 observers, 252000Z to 260200Z (previous 12 hrs: 0); 4 in an NAI or OBJ, most in NAI 1 (4).'), observed);
    assert.ok(observed.includes('Equipment reported: armor (2x T-72); mechanized infantry (3x BMP-2); reconnaissance (2x BRDM-2); engineers (1x MTU-20); dismounted personnel (6x PAX).'), observed);
    assert.ok(observed.includes('armor and mechanized approximately platoon size (2x T-72, 3x BMP-2; ALPHA012 252200Z, NAI 1)'), observed);
    assert.ok(observed.includes('dismounted approximately squad size (6x PAX; ALPHA013 252300Z, NAI 1)'), observed);
    assert.ok(!/\b(likely|unlikely|roughly even|almost certain|chance)\b/i.test(observed), 'no judgment in OBSERVED');
    assert.ok(observed.includes('Identified equipment is of Russian design (8 vehicles and systems), so the assessment uses Russian doctrine.'), observed);
});

test('each judgment has an ICD 203 term, the reports behind it, and its confidence apart', () => {
    const text = narrative();
    const lines = text.slice(text.indexOf('2. ASSESSMENT'), text.indexOf('3. GAPS'));
    const assessed = lines.join(' ').replace(/\s+/g, ' ');   // as read, across the wrapped lines
    // Recon then armor in NAI 1, with engineers there too.
    assert.ok(assessed.includes('a. LIKELY (55-80%) that enemy forces are scouting a route through NAI 1 for armor or mechanized forces.'), assessed);
    assert.ok(assessed.includes('reconnaissance (ALPHA011 252000Z); armor or mechanized forces within 6 hrs after it (ALPHA012 252200Z)'), assessed);
    // Digging in, obstacles and an engineer vehicle in NAI 1.
    assert.ok(assessed.includes('LIKELY (55-80%) that enemy forces are preparing a defense in NAI 1.'), assessed);
    assert.ok(assessed.includes('digging in or fortifying (ALPHA013 252300Z); obstacles or mines (ALPHA014 260100Z); engineer equipment (ALPHA014 260100Z)'), assessed);
    assert.ok(assessed.includes('Watch for: antitank weapons in position; combat vehicles halted in position.'), assessed);
    assert.ok(assessed.includes('Doctrine (Russian equipment in these reports): Russian forces lead with reconnaissance (razvedka)'), assessed);
    // Confidence never shares a sentence (or a line) with the likelihood.
    lines.filter(l => /Confidence:/.test(l)).forEach(l => assert.ok(/^ {6}Confidence: (high|moderate|low) \(/.test(l), l));
    assert.ok(assessed.includes('Confidence: moderate (3 reports from 2 observers).'), assessed);
    assert.ok(assessed.includes('Confidence: moderate (2 reports from 2 observers).'), assessed);
});

test('the gaps: reports without a grid, and types not in the catalogue', () => {
    const text = narrative();
    const gaps = text.slice(text.indexOf('3. GAPS')).join('\n');
    assert.ok(gaps.includes('   1 report without a grid: ALPHA015 260200Z.'), gaps);
    assert.ok(gaps.includes('   Not in the equipment catalogue: XYZ-9.'), gaps);
    assert.ok(gaps.replace(/\s+/g, ' ').includes('Likelihood terms follow ICD 203: almost no chance 1-5%'), gaps);
});

test('with no reports, the narrative says so and assesses nothing', () => {
    const text = narrative([]);
    assert.ok(text.includes('   No reports in this period (previous 12 hrs: 0).'), text.join('\n'));
    assert.ok(text.includes('   None: no reports to assess.'));
});

test('the narrative is the same for the same reports, in any order', () => {
    assert.deepEqual(narrative(), narrative([...NARRATIVE_REPS].reverse()));
});

test('the enemy can be called by another name, and units named from where they operate', () => {
    const settings = {
        enemy: 'OPFOR',
        units: [
            { name: '1-60 GMRB', places: ['nai 1'], kinds: ['armor', 'mech', 'infantry'] },
            { name: '60th Engineer Co', places: [], kinds: ['engineer'] },
        ],
    };
    const text = narrative(NARRATIVE_REPS, { narrative: settings }).join(' ').replace(/\s+/g, ' ');
    // Recon then armor in NAI 1: armor fits 1-60 GMRB; the engineers are there too.
    assert.ok(text.includes('LIKELY (55-80%) that elements of 1-60 GMRB or 60th Engineer Co are scouting a route through NAI 1'), text);
    assert.ok(text.includes('Unit: from the unit list, 1-60 GMRB (nai 1; armor, mechanized infantry, dismounted personnel); 60th Engineer Co (anywhere; engineers).'), text);
    assert.ok(text.includes('NAI 1 (area of 1-60 GMRB): 4 reports'), 'whose area, in Observed');
    assert.ok(text.includes('Units are named from the unit list, not from the reports.'));
    // No unit fits: the enemy's name.
    const other = narrative(NARRATIVE_REPS, { narrative: { enemy: 'OPFOR', units: [{ name: 'X', places: ['NAI 9'], kinds: [] }] } }).join(' ');
    assert.ok(other.includes('that OPFOR are preparing a defense in NAI 1.'), other);
    // Units whose names hold " or " are still listed with "and".
    const two = narrative(NARRATIVE_REPS, { narrative: { units: [{ name: 'Task Force Sword or Shield', places: ['NAI 1'], kinds: [] },
        { name: '2-7 IN', places: ['NAI 1'], kinds: [] }] } }).join(' ').replace(/\s+/g, ' ');
    assert.ok(two.includes('NAI 1 (area of Task Force Sword or Shield and 2-7 IN):'), two);
});

test('narrative settings from a file are made the kinds the rules need', () => {
    const reps = [...NARRATIVE_REPS,
        report({ id: 'n6', displayId: 'ALPHA016', size: '1x PMP', activity: 'bridging the river', location: '38SMB4500082000', time: '2026-10-26T03:00:00Z' }),
        report({ id: 'n7', displayId: 'ALPHA017', size: '2x trucks', activity: 'at the ferry site', location: '38SMB4500082000', time: '2026-10-26T04:00:00Z' })];
    const text = narrative(reps, { narrative: {
        units: [{ name: 7, places: [1, 'NAI 1'], kinds: 'armor' }, { name: '' }],
        custom: [
            { what: 'are preparing a river crossing', words: ['bridging', 'ferry'], min: '2', hours: '12' },
            { what: 'junk', words: { a: 1 }, min: 'x', hours: 12 },
            { what: 'nothing', words: ' , ', min: 1, hours: 12 },
        ],
    } }).join(' ').replace(/\s+/g, ' ');
    // min "2" is 2, not "21": two reports are enough, and a third would be "likely".
    assert.ok(text.includes('ROUGHLY EVEN CHANCE (45-55%) that elements of 7 are preparing a river crossing in NAI 1.'), text);
    assert.ok(text.includes('Basis: reports of bridging, ferry within 12 hrs'), text);
    assert.ok(!text.includes('junk') && !text.includes('nothing in'), text);
});

test("the team's own equipment, rules switched off, and rules of their own", () => {
    const team = core.teamEquipment([{ type: 'XYZ-9', role: 'ad', origin: '' }, { type: 'T-72', role: 'mech', origin: 'RU' }]);
    assert.equal(core.lookupEquipment('XYZ-9', team).role, 'ad', 'added');
    assert.equal(core.lookupEquipment('T-72B3', team).role, 'mech', 'put right');
    assert.equal(core.lookupEquipment('T-72B3').role, 'armor', 'the built-in one, without');
    const reps = [...NARRATIVE_REPS,
        report({ id: 'n6', displayId: 'ALPHA016', size: '1x PMP', activity: 'bridging the river', location: '38SMB4500082000', time: '2026-10-26T03:00:00Z' }),
        report({ id: 'n7', displayId: 'ALPHA017', size: '2x trucks', activity: 'at the ferry site', location: '38SMB4500082000', time: '2026-10-26T04:00:00Z' })];
    const text = narrative(reps, { narrative: {
        equipment: [{ type: 'XYZ-9', role: 'ad', origin: '' }],
        off: ['recon'],
        custom: [{ what: 'are preparing a river crossing', words: 'bridging, ferry', min: 2, hours: 12 }],
    } }).join(' ').replace(/\s+/g, ' ');
    assert.ok(!text.includes('Not in the equipment catalogue'), text);
    assert.ok(text.includes('air defense (1x XYZ-9)'), text);
    assert.ok(text.includes('logistics and support (2x trucks)'), 'a plain word: lower case, plural');
    assert.ok(!text.includes('scouting a route'), 'switched off');
    assert.ok(text.includes('ROUGHLY EVEN CHANCE (45-55%) that enemy forces are preparing a river crossing in NAI 1.'), text);
    assert.ok(text.includes('Basis: reports of bridging, ferry within 12 hrs (ALPHA016 260300Z, ALPHA017 260400Z).'), text);
    assert.equal(core.NARRATIVE_RULES.length, 55);
    core.NARRATIVE_RULES.forEach(([id]) => assert.ok(core.DOCTRINE[id] && core.DOCTRINE[id].RU && core.DOCTRINE[id].CN, `${id}: doctrine for both`));
});

test('backups carry the narrative settings, when there are any', () => {
    const n = { enemy: 'OPFOR', units: [{ name: '1-60 GMRB', places: ['NAI 1'], kinds: [] }] };
    assert.deepEqual(core.parseBackup(core.backupText('ALPHA', [report()], 'Patrol', {}, {}, NOW, [], n)).data.narrative, n);
    assert.deepEqual(core.parseBackup(core.allWorkspacesBackupText({ ALPHA: [report()] }, 'ALPHA', 'Patrol', {}, {}, NOW, [], n)).data.narrative, n);
    assert.equal('narrative' in core.parseBackup(core.backupText('ALPHA', [report()], 'Patrol', {}, {}, NOW, [], {})).data, false);
});

test('the narrative wraps to the width asked for, 100 columns unless told', () => {
    const wide = narrative(), narrow = narrative(NARRATIVE_REPS, { width: 60 });
    assert.ok(wide.some(l => l.length > 60) && wide.every(l => l.length <= 100));
    assert.ok(narrow.every(l => l.length <= 60), narrow.find(l => l.length > 60));
    assert.equal(narrow.join(' ').replace(/\s+/g, ' '), wide.join(' ').replace(/\s+/g, ' '), 'the same words');
});

test('the catalogue covers variants, and no name means two things', () => {
    const kit = t => { const k = core.lookupEquipment(t); return k && `${k.role} ${k.origin} ${k.name}`; };
    const cases = {
        'T-90M Proryv': 'armor RU T-90', 'BMP-1AM Basurmanin': 'mech RU BMP-1', 'Msta-SM2': 'fires RU 2S33', 'Pantsir-S1': 'ad RU Pantsir',
        'Kornet-EM': 'atgm RU Kornet', 'Krasukha-4': 'ew RU Krasukha', 'Zala Lancet': 'fires RU Lancet', 'Kub-BLA': 'fires RU Kub-BLA',
        Kub: 'ad RU Kub', 'Strela-10': 'ad RU Strela-10', 'Strela-1': 'ad RU Strela-1', 'Sprut-SD': 'armor RU 2S25', 'Sprut-B': 'atgm RU 2A45',
        'T-15 Armata': 'mech RU T-15', Hind: 'air RU Mi-24', 'BMP-2K': 'c2 RU BMP-2K', 'R-330Zh': 'ew RU Zhitel',
        'Type 96B': 'armor CN Type 96', 'Type 59-1': 'fires CN Type 59-1', 'Type 59-II': 'armor CN Type 59', 'Red Arrow 8': 'atgm CN HJ-8',
        'SH-15': 'fires CN PCL-181', 'HQ-17A': 'ad CN HQ-17', 'Dongfeng Mengshi': 'light CN Mengshi',
    };
    Object.entries(cases).forEach(([t, want]) => assert.equal(kit(t), want, t));
    ['Type 89', 'AR-15', 'HJ-80'].forEach(t => assert.equal(kit(t), null, `${t}: ambiguous or not one of them`));
    const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const seen = new Map();
    core.EQUIPMENT_CATALOGUE.forEach(([r, o, name, ...more]) => [name, ...more].forEach(k => {
        const v = `${r} ${o} ${name}`;
        assert.ok(!seen.has(norm(k)) || seen.get(norm(k)) === v, `${k}: ${seen.get(norm(k))} and ${v}`);
        seen.set(norm(k), v);
    }));
    assert.ok(core.EQUIPMENT_CATALOGUE.length > 350);
});

// A small set of reports for one rule: the same place (NAI 1), an hour apart.
const at1 = (rows) => rows.map(([size, activity], i) => report({ id: `d${i}`, displayId: `D${i}`, size, activity, location: '38SMB4500082000',
    time: new Date(Date.parse('2026-10-25T20:00:00Z') + i * 1800000).toISOString(), user: { initials: i % 2 ? 'AB' : 'CD' } }));
const said = (reps) => core.summaryReport('narrative', reps, OVERLAYS, SUMMARY_OPTS).replace(/\s+/g, ' ');

test('the doctrine follows the design of the equipment reported', () => {
    const chinese = said(at1([['2x ZBL-08', 'observing'], ['3x Type 99A, 4x ZBD-04', 'moving N'], ['1x PCL-181', 'moving N']]));
    assert.ok(chinese.includes('Identified equipment is of Chinese design (10 vehicles and systems), so the assessment uses PLA doctrine.'), chinese);
    assert.ok(chinese.includes('possibly a vanguard ahead of the main body'), 'PLA terms');
    assert.ok(chinese.includes('Doctrine (Chinese equipment in these reports): PLA'), chinese);
    const russian = said(at1([['2x BRDM-2', 'observing'], ['3x T-90M, 4x BMP-3', 'moving N'], ['1x 2S19', 'moving N']]));
    assert.ok(russian.includes('possibly a forward detachment or advance guard'), 'Russian terms');
    const mixed = said(at1([['3x T-72', 'moving N'], ['1x PCL-181', 'moving N'], ['2x Type 99', 'moving N'], ['1x 2S1', 'moving N']]));
    assert.ok(mixed.includes('Equipment by design: Russian 4, Chinese 3; each judgment uses the doctrine of the equipment in its reports.'), mixed);
    const neither = said(at1([['2x trucks', 'halted'], ['3x trucks', 'refueling']]));
    assert.ok(!neither.includes('Doctrine ('), 'no doctrine without Russian or Chinese equipment');
});

test('the doctrine rules: crossings, breaches, UAVs spotting, EW, deep strikes, command posts', () => {
    const t = said(at1([
        ['1x PMP', 'emplacing bridge at the wadi'], ['2x T-72', 'halted, waiting'], ['1x smoke generator truck', 'laying smoke'],
        ['1x UR-77', 'breaching the minefield'], ['1x Orlan-10 UAV', 'overhead'], ['2x 2S19', 'firing, shelling OBJ'],
        ['1x Borisoglebsk-2', 'jamming'], ['1x Iskander', 'moving'], ['1x R-149', 'halted, antennas up'], ['1x Pantsir-S1', 'halted'],
    ]));
    for (const want of [
        'are preparing to cross a water obstacle or gap in NAI 1', 'are preparing to breach obstacles in NAI 1',
        'with UAVs over NAI 1 (a reconnaissance-fire complex)', 'are jamming communications, GPS and drones',
        'deep strikes with long-range rockets or missiles', 'have a command post in NAI 1',
    ]) assert.ok(t.includes(want), `${want}\n${t}`);
});

// Reports in named places: [size, activity, location], half an hour apart.
const atPlaces = (rows) => rows.map(([size, activity, location], i) => report({ id: `p${i}`, displayId: `P${i}`, size, activity, location,
    time: new Date(Date.parse('2026-10-25T20:00:00Z') + i * 1800000).toISOString(), user: { initials: i % 2 ? 'AB' : 'CD' } }));
const NAI1 = '38SMB4500082000', NAI2 = '38SMB5500082000';

test('the catalogue matches the types that used to slip: KamAZ Typhoons, GAZ Tigrs, hyphenated variants, Chinese names', () => {
    const kit = t => { const k = core.lookupEquipment(t); return k && `${k.role} ${k.origin} ${k.name}`; };
    const cases = {
        'KamAZ-63968': 'mech RU Typhoon', 'GAZ-233014': 'light RU Tigr', 'GAZ-39371': 'light RU Vodnik', '9P163-3': 'atgm RU Kornet',
        '2B14-1': 'fires RU 2B14', 'TOS-3 Drakon': 'fires RU TOS-3', 'Mi-171Sh': 'air RU Mi-17', 'RPO-A Shmel': 'atgm RU RPO-A',
        'ZBL-09': 'mech CN ZBL-08', 'VN-1': 'mech CN ZBL-08', 'HQ-29': 'ad CN HQ-29', 'Shaanxi Y-8': 'air CN Y-8', 'CJ-100': 'fires CN CJ-100',
        'KJ-200': 'air CN KJ-200', 'YY-20': 'air CN YY-20', 'PCL-191': 'fires CN PHL-16', 'CH-901': 'fires CN CH-901',
        'GQL-111': 'engineer CN GQL-111', 'FPV': 'fires  FPV', 'Iveco Rys': 'light RU Iveco LMV', 'Rys': 'recon RU BRM-3K',
    };
    Object.entries(cases).forEach(([t, want]) => assert.equal(kit(t), want, t));
    assert.ok(core.EQUIPMENT_CATALOGUE.length > 750, core.EQUIPMENT_CATALOGUE.length);
});

test('the new rules: fires, maneuver, defense and support, each from its own signs', () => {
    const cases = [
        [[['1x TOS-1A', 'firing at the village', NAI1], ['10x PAX', 'moving W into the village', NAI1]], 'are using thermobaric weapons on NAI 1 (TOS or Shmel)'],
        [[['2x KAB-500', 'struck positions', NAI1]], 'are striking NAI 1 with glide bombs'],
        [[['1x 1L219 Zoopark', 'emplaced', NAI1], ['2x 2S19', 'firing', NAI1]], 'are conducting counter-battery fire around NAI 1'],
        [[['4x BMP-2', 'firing on our positions', NAI1], ['4x BMP-2', 'withdrawing to the east', NAI1]], 'reconnaissance in force (razvedka boyem) in NAI 1'],
        [[['2x BMP-3', 'dismounted infantry at the treeline', NAI1], ['10x PAX', 'moving W, firing', NAI1]], 'delivering assault infantry by armored group (bronegruppa) in NAI 1'],
        [[['4x PAX', 'firing at OP', NAI1], ['1x MT-LB', 'evacuating wounded', NAI1]], 'are evacuating casualties from NAI 1'],
        [[['10x T-72', 'unloading from trains', NAI1]], 'are moving forces or supplies by rail through NAI 1'],
        [[['1x Mavic', 'drone dropping supplies', NAI1]], 'are resupplying forward groups in NAI 1 by drone'],
        [[['1x Zemledeliye', 'scatterable mines', NAI1]], 'are laying minefields in NAI 1'],
        [[['1x TDA-2K', 'laying smoke', NAI1]], 'chemical-defense (RKhBZ) troops in NAI 1'],
        [[['4x PAX', 'firing at OP', NAI1], ['10x T-72', 'moving W', NAI2]], 'are fixing friendly forces in NAI 1, with armor moving through NAI 2'],
        [[['3x PAX', 'hiding in the treeline', NAI1], ['2x PAX', 'observing', NAI1], ['3x PAX', 'stationary in a basement', NAI1]], 'are building up small infantry groups in NAI 1'],
        [[['3x motorcycles, 6x PAX', 'moving W', NAI1], ['2x buggy, 4x PAX', 'moving W', NAI1]], 'are moving fast in small groups on light vehicles through NAI 1'],
        // A FARP is for helicopters: this was 2x Su-25 (fixed-wing), which no longer makes one.
        [[['2x Mi-24', 'landed, refueling', NAI1], ['1x ATZ fuel truck', 'stationary', NAI1]], 'a forward arming and refueling point for helicopters in NAI 1'],
        [[['2x Lancet', 'struck trucks on the MSR', NAI1], ['1x FPV', 'hit vehicles on the road', NAI1]], 'are cutting the routes through NAI 1'],
        [[['1x ASN-301', 'launching', NAI1]], 'are suppressing friendly air defense'],
    ];
    cases.forEach(([rows, want]) => {
        const t = said(atPlaces(rows));
        assert.ok(t.includes(want), `${want}\n${t}`);
    });
    // Fire support and a firing position are not contact.
    const t = said(atPlaces([['2x T-72', 'moving to a fire support position', NAI1], ['2x T-72', 'in firing positions', NAI1]]));
    assert.ok(!t.includes('probing friendly positions'), t);
    // Fixed-wing aircraft: attack aviation, but no FARP or air assault from them.
    const jets = said(atPlaces([['2x Su-25', 'landed, refueling', NAI1], ['1x ATZ fuel truck', 'stationary', NAI1], ['2x Il-76', 'landed', NAI1]]));
    assert.ok(!jets.includes('refueling point for helicopters') && !jets.includes('air assault'), jets);
    assert.ok(jets.includes('are supporting ground forces with attack aviation'), jets);
    // Transport helicopters with gunships escorting are an air assault.
    const lift = said(atPlaces([['4x Mi-8', 'landing troops', NAI1], ['2x Ka-52', 'orbiting', NAI1]]));
    assert.ok(lift.includes('air assault'), lift);
});

// --- The rules, one by one ---

// Reports for the table: [size, activity, location, minutes after 250000Z],
// T0, T1, ... in the order given, over three days (some rules need 12 hrs or more).
const T_DAY = Date.parse('2026-10-25T00:00:00Z');
const tableReps = (rows) => rows.map(([size, activity, location, min], i) => report({ id: `t${i}`, displayId: `T${i}`, size, activity, location,
    time: new Date(T_DAY + min * 60000).toISOString(), user: { initials: i % 2 ? 'AB' : 'CD' } }));
const TABLE_OPTS = { ...SUMMARY_OPTS, now: new Date('2026-10-27T00:00:00Z'), from: Date.parse('2026-10-24T00:00:00Z'), to: Date.parse('2026-10-27T00:00:00Z') };
const judgedBy = (rows, opts = {}) => core.summaryDetail('narrative', tableReps(rows), OVERLAYS, { ...TABLE_OPTS, ...opts });
const OBJ1 = '38SMB4200092000', NOWHERE = 'vic hill 220';
const TRUCKS = ['3x trucks', 'moving N', NAI1, 30];   // behind nothing, so never a source
// For every built-in rule: the level it gets from a minimal set of reports
// that makes it fire, which of them are behind it (T0, T1, ...), and a set
// one sign short that doesn't fire it.
const RULE_TABLE = {
    // Maneuver
    offense: ['roughly even chance', [['2x 2S19', 'firing', NAI1, 0], ['1x Pantsir-S1', 'moving N', NAI1, 30], ['6x PAX', 'halted', NAI1, 60]], [0, 1],
        [['1x Pantsir-S1', 'moving N', NAI1, 30], ['1x Krasukha-4', 'jamming', NAI1, 60]]],
    axes: ['roughly even chance', [['2x T-72', 'moving N', NAI1, 0], ['3x BMP-2', 'moving W', NAI2, 60], TRUCKS], [0, 1],
        [['2x T-72', 'moving N', NAI1, 0], ['3x BMP-2', 'moving W', NAI2, 420]]],
    fixing: ['likely', [['4x PAX', 'firing at OP', NAI1, 0], ['10x T-72', 'moving W', NAI2, 60], TRUCKS], [0, 1],
        [['4x PAX', 'firing at OP', NAI1, 0], ['10x T-72', 'moving W', NAI2, 240]]],
    forward: ['roughly even chance', [['2x T-72', 'moving N', NAI1, 0], ['1x 2S19', 'moving N', NAI1, 60], TRUCKS], [0, 1],
        [['2x T-72', 'moving N', NAI1, 0], ['1x 2S19', 'moving N', NAI1, 180]]],
    recon: ['roughly even chance', [['2x BRDM-2', 'observing', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60], ['3x trucks', 'halted', NAI1, 90]], [0, 1],
        [['2x T-72', 'moving N', NAI1, 0], ['2x BRDM-2', 'observing', NAI1, 60]]],
    reconforce: ['roughly even chance', [['4x BMP-2', 'firing on our positions', NAI1, 0], ['4x BMP-2', 'withdrawing to the east', NAI1, 60], TRUCKS], [0, 1],
        [['4x BMP-2', 'firing on our positions', NAI1, 0], ['4x BMP-2', 'withdrawing to the east', NAI1, 240]]],
    assembly: ['roughly even chance', [['2x T-72', 'halted', NAI1, 0], ['3x BMP-2', 'parked', NAI1, 60], ['3x trucks', 'resupplying', NAI1, 90], ['1x 2S19', 'moving N', NAI1, 100]], [0, 1, 2],
        [['2x T-72', 'halted', NAI1, 0], ['3x trucks', 'resupplying', NAI1, 90]]],
    reserve: ['roughly even chance', [['6x PAX', 'firing at OP', NAI2, 0], ['2x T-72', 'halted', NAI1, 60], ['3x trucks', 'moving N', NAI1, 90]], [0, 1],
        [['6x PAX', 'firing at OP', NOWHERE, 0], ['2x T-72', 'halted', NAI1, 60]]],
    firing: ['roughly even chance', [['6x PAX', 'firing at OP', NAI1, 0], ['4x PAX', 'engaging', NAI1, 60], TRUCKS], [0, 1],
        [['6x PAX', 'firing at OP', NAI1, 0], TRUCKS]],
    dismount: ['roughly even chance', [['2x BMP-3', 'dismounted infantry at the treeline', NAI1, 0], ['10x PAX', 'moving W, firing', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x BMP-3', 'dismounted infantry at the treeline', NAI1, 0], ['10x PAX', 'moving W, firing', NAI1, 180]]],
    buildup: ['roughly even chance', [['3x PAX', 'hiding in the treeline', NAI1, 0], ['2x PAX', 'observing', NAI1, 60], ['3x PAX', 'stationary in a basement', NAI1, 120],
        ['3x trucks', 'moving N', NAI1, 90]], [0, 1, 2],
    [['3x PAX', 'hiding in the treeline', NAI1, 0], ['2x PAX', 'observing', NAI1, 60]]],
    infiltration: ['roughly even chance', [['4x PAX', 'moving W', NAI1, 0], ['3x PAX', 'on foot', NAI1, 60], TRUCKS], [0, 1],
        [['4x PAX', 'moving W', NAI1, 0], ['3x PAX', 'on foot', NAI1, 800]]],
    lightassault: ['roughly even chance', [['3x motorcycles, 6x PAX', 'moving W', NAI1, 0], ['2x buggy, 4x PAX', 'moving W', NAI1, 60], TRUCKS], [0, 1],
        [['3x motorcycles, 6x PAX', 'moving W', NAI1, 0], TRUCKS]],
    urban: ['likely', [['6x PAX', 'moving into the village', NAI1, 0], ['2x T-72', 'halted', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['6x PAX', 'moving N', NAI1, 0], ['2x T-72', 'halted', NAI1, 30]]],
    // NAI 2 had a report before the contact: not new ground.
    exploit: ['roughly even chance', [['4x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'moving W', NAI1, 60], ['2x T-72', 'moving W', NAI2, 120], TRUCKS], [0, 1, 2],
        [['3x trucks', 'halted', NAI2, -60], ['4x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'moving W', NAI1, 60], ['2x T-72', 'moving W', NAI2, 120]]],
    // Three 10 km squares around 38S MB 77 (66, 68 and 86), or only two.
    encircle: ['roughly even chance', [['2x T-72', 'moving N', '38SMB6500062000', 0], ['2x T-72', 'moving N', '38SMB6500082000', 60],
        ['2x T-72', 'moving N', '38SMB8500062000', 120], ['3x trucks', 'moving N', '38SMB6500062000', 30]], [0, 1, 2],
    [['2x T-72', 'moving N', '38SMB6500062000', 0], ['2x T-72', 'moving N', '38SMB6500082000', 60]]],
    pursuit: ['roughly even chance', [['2x T-72', 'pursuing our patrol', NAI1, 0], TRUCKS], [0],
        [['3x trucks', 'pursuing our patrol', NAI1, 0]]],
    // The contact (T0) is cited with the armor that arrives after it.
    counterattack: ['roughly even chance', [['6x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60], ['3x trucks', 'moving N', NAI1, 90]], [0, 1],
        [['2x T-72', 'moving N', NAI1, -30], ['6x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60]]],
    withdrawal: ['roughly even chance', [['2x T-72', 'withdrawing to the east', NAI1, 0], TRUCKS], [0],
        [['2x T-72', 'moving E', NAI1, 0]]],
    airassault: ['likely', [['4x Mi-8', 'landing troops', NAI1, 0], ['2x Ka-52', 'orbiting', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x Il-76', 'landed', NAI1, 0], ['2x Ka-52', 'orbiting', NAI1, 30]]],
    amphibious: ['likely', [['2x ZBD-05', 'swimming the river', NAI1, 0], ['1x 2S19', 'halted', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x BMP-2', 'moving N', NAI1, 0], ['1x 2S19', 'halted', NAI1, 30]]],
    // Defense
    defense: ['likely', [['6x PAX', 'digging in', NAI1, 0], ['1x MTU-20', 'emplacing obstacles', NAI1, 60], TRUCKS], [0, 1],
        [['6x PAX', 'stationary', NAI1, 0], TRUCKS]],
    strongpoint: ['roughly even chance', [['2x T-72', 'dug in', NAI1, 0], ['6x PAX', 'holding', NAI1, 780], TRUCKS], [0, 1],
        [['2x T-72', 'dug in', NAI1, 0], ['6x PAX', 'holding', NAI1, 600]]],
    fortline: ['roughly even chance', [['6x PAX', 'digging in', NAI1, 0], ['6x PAX', 'digging in', NAI2, 60], ['6x PAX', 'digging in', OBJ1, 120], TRUCKS], [0, 1, 2],
        [['6x PAX', 'digging in', NAI1, 0], ['6x PAX', 'digging in', NAI2, 60]]],
    screen: ['roughly even chance', [['2x BRDM-2', 'observing', NAI1, 0], ['3x PAX', 'observing', NAI2, 60], TRUCKS], [0, 1],
        [['2x BRDM-2', 'observing', NAI1, 0], ['3x PAX', 'observing', NAI2, 420]]],
    antitank: ['likely', [['2x Kornet', 'in position', NAI1, 0], ['2x T-72', 'halted', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x Kornet', 'moving N', NAI1, 0], ['2x T-72', 'halted', NAI1, 30]]],
    remotemine: ['likely', [['1x Zemledeliye', 'stationary', NAI1, 0], ['1x BM-21', 'firing', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x BM-21', 'firing', NAI1, 30]]],
    deception: ['roughly even chance', [['2x T-72', 'camouflaged in the treeline', NAI1, 0], TRUCKS], [0],
        [['2x T-72', 'moving N', NAI1, 0]]],
    // Fires
    artillery: ['roughly even chance', [['2x 2S19', 'firing', NAI1, 0], ['1x BM-21', 'firing', NAI1, 60], ['6x PAX', 'halted', NAI1, 90]], [0, 1],
        [['2x 2S19', 'firing', NAI1, 0], ['1x BM-21', 'firing', NAI1, 240]]],
    reconfire: ['roughly even chance', [['1x Orlan-10', 'overhead', NAI1, 0], ['2x 2S19', 'firing', NAI1, 30], ['3x trucks', 'halted', NAI1, 40]], [0, 1],
        [['1x Orlan-10', 'overhead', NAI1, 0], ['2x 2S19', 'firing', NAI1, 90]]],
    // Fire following the UAVs makes it spotting, not surveillance.
    isr: ['roughly even chance', [['1x Orlan-10', 'overhead', NAI1, 0], ['1x Orlan-10', 'overhead', NAI1, 60], ['1x Orlan-10', 'overhead', NAI1, 120],
        ['3x trucks', 'moving N', NAI1, 90]], [0, 1, 2],
    [['1x Orlan-10', 'overhead', NAI1, 0], ['1x Orlan-10', 'overhead', NAI1, 60], ['1x Orlan-10', 'overhead', NAI1, 120], ['2x 2S19', 'firing', NAI1, 150]]],
    counterbattery: ['roughly even chance', [['1x 1L219', 'emplaced', NAI1, 0], ['2x 2S19', 'firing', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x 1L219', 'emplaced', NAI1, 0], ['2x 2S19', 'halted', NAI1, 30]]],
    shootscoot: ['roughly even chance', [['2x 2S19', 'firing', NAI1, 0], ['2x 2S19', 'moving N', NAI1, 30], ['3x trucks', 'moving N', NAI1, 40]], [0, 1],
        [['2x 2S19', 'firing', NAI1, 0], ['2x 2S19', 'moving N', NAI1, 90]]],
    tankfire: ['likely', [['2x T-72', 'halted, firing at our positions', NAI1, 0], ['6x PAX', 'moving W', NAI1, 120], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x T-72', 'halted, firing at our positions', NAI1, 0], ['3x BMP-2', 'moving W', NAI1, 30]]],
    thermobaric: ['likely', [['1x TOS-1A', 'firing at the village', NAI1, 0], ['10x PAX', 'moving W into the village', NAI1, 60], TRUCKS], [0, 1],
        [['1x 2S19', 'firing at the village', NAI1, 0], ['10x PAX', 'moving W into the village', NAI1, 60]]],
    deep: ['roughly even chance', [['1x Iskander', 'moving N', NAI1, 0], ['1x Orlan-10', 'overhead', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x 2S19', 'moving N', NAI1, 0], ['1x Orlan-10', 'overhead', NAI1, 30]]],
    c2strike: ['roughly even chance', [['2x 2S19', 'shelling the command post', NAI1, 0], TRUCKS], [0],
        [['2x 2S19', 'shelling the treeline', NAI1, 0]]],
    sead: ['likely', [['1x ASN-301', 'launching', NAI1, 0], ['1x Krasukha-4', 'jamming', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x Lancet', 'struck a bunker', NAI1, 0], ['1x Krasukha-4', 'jamming', NAI1, 30]]],
    drones: ['roughly even chance', [['1x FPV', 'struck a bunker', NAI1, 0], ['1x Orlan-10', 'overhead', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x Orlan-10', 'overhead', NAI1, 30]]],
    interdict: ['roughly even chance', [['2x Lancet', 'struck trucks on the MSR', NAI1, 0], ['3x trucks', 'moving N', NAI1, 60]], [0],
        [['2x Lancet', 'struck a bunker', NAI1, 0]]],
    glidebomb: ['roughly even chance', [['2x KAB-500', 'struck positions', NAI1, 0], TRUCKS], [0],
        [['2x Su-25', 'struck positions', NAI1, 0]]],
    aviation: ['roughly even chance', [['2x Su-25', 'overhead', NAI1, 0], ['2x T-72', 'firing on our positions', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x Mi-8', 'overhead', NAI1, 0], ['2x T-72', 'firing on our positions', NAI1, 30]]],
    // Support
    crossing: ['likely', [['1x PMP', 'emplacing at the river', NAI1, 0], ['1x Pantsir-S1', 'halted', NAI1, 30], ['6x PAX', 'moving N', NAI1, 60]], [0, 1],
        [['1x UR-77', 'moving N', NAI1, 0], ['1x Pantsir-S1', 'halted', NAI1, 30]]],
    breach: ['likely', [['1x UR-77', 'stationary', NAI1, 0], ['2x T-72', 'halted', NAI1, 30], ['3x trucks', 'halted', NAI1, 60]], [0, 1],
        [['1x MTU-20', 'stationary', NAI1, 0], ['2x T-72', 'halted', NAI1, 30]]],
    cbrn: ['likely', [['1x TDA-2K', 'laying smoke', NAI1, 0], ['1x TOS-1A', 'halted', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['2x T-72', 'laying smoke', NAI1, 0], ['1x TOS-1A', 'halted', NAI1, 30]]],
    cp: ['likely', [['1x R-149', 'halted, antennas up', NAI1, 0], ['1x Pantsir-S1', 'halted', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x Pantsir-S1', 'halted', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]]],
    adsite: ['roughly even chance', [['1x Pantsir-S1', 'halted', NAI1, 0], ['3x trucks', 'parked', NAI1, 30], ['2x T-72', 'moving N', NAI1, 60]], [0, 1],
        [['1x Pantsir-S1', 'halted', NAI1, 0], ['3x trucks', 'moving N', NAI1, 30]]],
    ew: ['roughly even chance', [['1x Krasukha-4', 'halted', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60], ['3x trucks', 'halted', NAI1, 30]], [0, 1],
        [['2x T-72', 'moving N', NAI1, 60]]],
    logistics: ['roughly even chance', [['3x trucks', 'parked', NAI1, 0], ['1x ATZ fuel truck', 'refueling', NAI1, 60], ['2x T-72', 'moving N', NAI1, 90]], [0, 1],
        [['3x trucks', 'parked', NAI1, 0], ['3x trucks', 'parked', NAI1, 800]]],
    logforward: ['roughly even chance', [['3x trucks', 'moving N', NAI1, 0], ['1x ATZ fuel truck', 'moving N', NAI1, 60], ['2x T-72', 'halted', NAI1, 30]], [0, 1],
        [['3x trucks', 'moving N', NAI1, 0], ['3x trucks', 'moving N', NAI1, 60]]],
    railhead: ['likely', [['10x T-72', 'unloading from trains', NAI1, 0], TRUCKS], [0],
        [['6x PAX', 'unloading from trains', NAI1, 0]]],
    droneresupply: ['roughly even chance', [['1x Mavic', 'drone dropping supplies', NAI1, 0], ['3x PAX', 'holding', NAI1, 30], ['3x trucks', 'moving N', NAI1, 60]], [0, 1],
        [['1x Mavic', 'overhead', NAI1, 0], ['3x PAX', 'holding', NAI1, 30]]],
    // Helicopters, not fixed-wing aircraft, make a FARP.
    farp: ['roughly even chance', [['2x Mi-24', 'landed, refueling', NAI1, 0], ['1x ATZ fuel truck', 'stationary', NAI1, 30], ['2x T-72', 'moving N', NAI1, 60]], [0, 1],
        [['2x Su-25', 'landed, refueling', NAI1, 0], ['1x ATZ fuel truck', 'stationary', NAI1, 30]]],
    casevac: ['likely', [['4x PAX', 'firing at OP', NAI1, 0], ['1x MT-LB', 'evacuating wounded', NAI1, 60], ['3x trucks', 'moving N', NAI1, 90]], [0, 1],
        [['4x PAX', 'firing at OP', NAI1, 0], ['1x MT-LB', 'moving N', NAI1, 60]]],
    regroup: ['roughly even chance', [['6x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'halted', NAI1, 60], ['3x trucks', 'resupplying', NAI1, 90], ['2x BMP-2', 'moving N', NAI1, 120]], [0, 1, 2],
        [['6x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'halted', NAI1, 60]]],
};

test('the table has a row for every built-in rule, in their order', () => {
    assert.deepEqual(Object.keys(RULE_TABLE), core.NARRATIVE_RULES.map(([id]) => id));
});

Object.entries(RULE_TABLE).forEach(([rule, [level, fires, behind, doesNot]]) => {
    test(`rule ${rule}: fires from its signs, with the reports behind it; one sign short, it doesn't`, () => {
        const yes = judgedBy(fires), j = yes.judgments.find(x => x.rule === rule);
        assert.ok(j, `${rule} fires\n${yes.text}`);
        assert.equal(core.ICD203[j.level][0], level, `${rule}: its level\n${yes.text}`);
        assert.deepEqual(j.sources, behind.map(i => `t${i}`), `${rule}: the reports behind it`);
        // Switched off, it doesn't fire however strong the signs.
        assert.ok(!judgedBy(fires, { narrative: { off: [rule] } }).judgments.some(x => x.rule === rule), `${rule}: off`);
        const no = judgedBy(doesNot);
        assert.ok(!no.judgments.some(x => x.rule === rule), `${rule} doesn't fire\n${no.text}`);
    });
});

// --- The way of march ---

// An axis of advance through NAI 1 and NAI 2 from east to west, then turning
// south-west; one drawn the other way, from west to east.
const AXIS_W = { type: 'AXIS', name: 'GOLD', geometry: { type: 'LineString', coordinates: [ll('38SMB7000082000'), ll('38SMB4000082000'), ll('38SMB3000072000')] } };
const AXIS_E = { type: 'AXIS', name: 'RED', geometry: { type: 'LineString', coordinates: [ll('38SMB4000082000'), ll('38SMB7000082000')] } };
const pt = g => { const [lon, lat] = ll(g); return { lon, lat }; };

test('a direction is along the way of march within 60 degrees, back along it beyond 120, else across it', () => {
    const cases = [[270, 270, 'along'], [300, 270, 'along'], [330, 270, 'along'], [331, 270, 'across'], [0, 270, 'across'],
        [150, 270, 'across'], [149, 270, 'back'], [90, 270, 'back'], [10, 350, 'along'], [350, 10, 'along'], [170, 350, 'back'], [80, 350, 'across']];
    cases.forEach(([deg, way, want]) => assert.equal(core.wayRelation(deg, way), want, `${deg} against ${way}`));
});

test("the way of march: an axis near the report, else the AO's direction, else none", () => {
    const axes = core.axesOf([...OVERLAYS, AXIS_W]);
    assert.deepEqual(axes.map(a => a.key), ['AXIS GOLD'], 'only the axes, by name');
    // None set: none.
    assert.equal(core.wayOfMarchAt(pt(NAI1), [], ''), null);
    assert.equal(core.wayOfMarchAt(null, axes, ''), null, 'no grid: no axis to be near');
    // The AO's direction alone.
    assert.deepEqual(core.wayOfMarchAt(pt(NAI1), [], 'N'), { deg: 0, dir: 'N', axis: '' });
    assert.deepEqual(core.wayOfMarchAt(null, axes, 'SE'), { deg: 135, dir: 'SE', axis: '' }, 'no grid: the AO\'s');
    // On the axis, its direction there overrides the AO's.
    const on = core.wayOfMarchAt(pt(NAI1), axes, 'N');
    assert.equal(on.dir, 'W');
    assert.equal(on.axis, 'AXIS GOLD');
    assert.ok(Math.abs(on.deg - 270) < 1, on.deg);
    // Within 10 km of it still; beyond, the AO's again (or none).
    assert.equal(core.wayOfMarchAt(pt('38SMB5000091000'), axes, 'N').dir, 'W', '9 km off');
    assert.equal(core.wayOfMarchAt(pt('38SMB5000093000'), axes, 'N').dir, 'N', '11 km off');
    assert.equal(core.wayOfMarchAt(pt('38SMB5000093000'), axes, ''), null);
    assert.equal(core.AXIS_NEAR_METERS, 10000);
    // The nearest segment decides: past the turn, south-west.
    assert.equal(core.wayOfMarchAt(pt('38SMB3200075000'), axes, '').dir, 'SW');
    // The way it was drawn decides: from where they come from to where they head.
    assert.equal(core.wayOfMarchAt(pt(NAI1), core.axesOf([AXIS_E]), '').dir, 'E');
    // Of two axes, the nearer.
    const two = core.axesOf([AXIS_W, { ...AXIS_E, geometry: { type: 'LineString', coordinates: [ll('38SMB4000088000'), ll('38SMB7000088000')] } }]);
    assert.equal(core.wayOfMarchAt(pt('38SMB5000083000'), two, '').axis, 'AXIS GOLD');
    assert.equal(core.wayOfMarchAt(pt('38SMB5000087000'), two, '').axis, 'AXIS RED');
    // A line in several parts; an area tagged AXIS gives none.
    const multi = core.axesOf([{ type: 'AXIS', name: 'M', geometry: { type: 'MultiLineString', coordinates: [AXIS_E.geometry.coordinates, [ll('38SMB3000060000'), ll('38SMB3000050000')]] } }]);
    assert.equal(core.wayOfMarchAt(pt('38SMB3100055000'), multi, '').dir, 'S');
    assert.deepEqual(core.axesOf([{ type: 'AXIS', name: 'A', geometry: OVERLAYS[0].geometry }]), []);
    const s = core.nearestSegment(...ll('38SMB5500083000'), AXIS_W.geometry.coordinates);
    assert.ok(Math.abs(s.meters - 1000) < 20 && Math.abs(s.bearingDeg - 270) < 1, JSON.stringify(s));
    assert.equal(core.nearestSegment(0, 0, [[1, 1], [1, 1]]), null, 'a line of no length');
});

test('an axis of advance is named AXIS, AOA or Axis of advance in a file, is a graphic the server takes, and names no place', () => {
    assert.deepEqual(core.overlayRef('AXIS GOLD', null), { type: 'AXIS', name: 'GOLD', key: 'AXIS GOLD' });
    assert.equal(core.overlayRef('AOA 02', null).key, 'AXIS 2');
    assert.equal(core.overlayRef('Axis of advance North', null).key, 'AXIS NORTH');
    assert.equal(core.overlayRef('axis-3', null).key, 'AXIS 3');
    assert.equal(core.overlayRef('Axis of attack', null), null, 'a common word is not a name');
    assert.equal(core.overlayRef('AOAs', null), null);
    // Given the tag: the name is the first word that isn't one of its own.
    assert.equal(core.overlayRef('Route Gold', 'AXIS').key, 'AXIS ROUTE');
    assert.equal(core.overlayRef('Axis', 'AXIS'), null);
    // Not a place: Location boxes don't name one, the summaries don't list one.
    assert.deepEqual(core.findRefs('AXIS GOLD, NAI 1').map(r => r.key), ['NAI 1']);
    const a = core.analyzeLocation('38SMB4500082000', [...OVERLAYS, AXIS_W]);
    assert.deepEqual(a, core.analyzeLocation('38SMB4500082000', OVERLAYS));
    assert.ok(!core.summaryPlaces([], [...OVERLAYS, AXIS_W]).some(p => /AXIS/.test(p)));
    // Kept with the other graphics, and its names kept from the team's tags.
    assert.deepEqual(core.foldOverlays([...OVERLAYS, AXIS_W]).map(o => o.type), ['NAI', 'NAI', 'OBJ', 'PL', 'AXIS']);
    assert.deepEqual(core.cleanTags([{ id: 'tag-a', name: 'Axis', color: '#ff0000' }, { id: 'tag-b', name: 'axis of advance', color: '#ff0000' },
        { id: 'tag-c', name: 'Axes', color: '#ff0000' }]).map(t => t.id), ['tag-c']);
});

// The rules the way of march touches: the reports (as the table's), the
// settings and overlays that set a way of march, the level and reports behind
// the rule with it, and its level without it (null: it doesn't fire).
const TOWARD = (dir) => ({ narrative: { toward: dir } });
const wayJudged = (rows, { narrative = {}, overlays = OVERLAYS } = {}) => core.summaryDetail('narrative', tableReps(rows), overlays, { ...TABLE_OPTS, narrative });
const WAY_TABLE = {
    offense: [[['2x 2S19', 'firing', NAI1, 0], ['2x T-72', 'moving W', NAI1, 30], TRUCKS], TOWARD('W'), 'roughly even chance', [0, 1], null],
    axes: [RULE_TABLE.axes[1], TOWARD('W'), 'likely', [0, 1], 'roughly even chance'],
    forward: [RULE_TABLE.forward[1], TOWARD('N'), 'likely', [0, 1], 'roughly even chance'],
    exploit: [RULE_TABLE.exploit[1], { overlays: [...OVERLAYS, AXIS_W] }, 'likely', [0, 1, 2], 'roughly even chance'],
    // Moving N in squares around one is across the way of march W.
    encircle: [RULE_TABLE.encircle[1], TOWARD('W'), 'likely', [0, 1, 2], 'roughly even chance'],
    pursuit: [[['2x T-72', 'pursuing our patrol, moving W', NAI1, 0], TRUCKS], { overlays: [...OVERLAYS, AXIS_W] }, 'likely', [0], 'roughly even chance'],
    withdrawal: [[['2x T-72', 'moving E', NAI1, 0], TRUCKS], TOWARD('W'), 'roughly even chance', [0], null],
    reconforce: [[['4x BMP-2', 'firing on our positions', NAI1, 0], ['4x BMP-2', 'moving E', NAI1, 60], TRUCKS], { overlays: [...OVERLAYS, AXIS_W] },
        'roughly even chance', [0, 1], null],
    logforward: [[['3x trucks', 'moving W', NAI1, 0], ['3x trucks', 'moving W', NAI1, 60]], TOWARD('W'), 'roughly even chance', [0, 1], null],
};
Object.entries(WAY_TABLE).forEach(([rule, [rows, way, level, behind, without]]) => {
    test(`rule ${rule}: the way of march is a sign, named with its direction; without one it is as it was`, () => {
        const yes = wayJudged(rows, way), j = yes.judgments.find(x => x.rule === rule);
        assert.ok(j, `${rule} fires\n${yes.text}`);
        assert.equal(core.ICD203[j.level][0], level, `${rule}: its level\n${yes.text}`);
        assert.deepEqual(j.sources, behind.map(i => `t${i}`), `${rule}: the reports behind it`);
        assert.ok(/Basis: [^.]*(along|across) the way of march[a-z0-9 ]* \((N|E|S|W)\)/.test(yes.text.replace(/\s+/g, ' ')), `${rule}: the sign, with its direction\n${yes.text}`);
        const no = wayJudged(rows), k = no.judgments.find(x => x.rule === rule);
        if (without === null) assert.ok(!k, `${rule} doesn't fire without it\n${no.text}`);
        else assert.equal(core.ICD203[k.level][0], without, `${rule}: its level without it\n${no.text}`);
        assert.ok(!/way of march/.test(no.text), no.text);
    });
});

test('moving back along the way of march is withdrawing, not advancing; a track says which way a report moved', () => {
    // Armor moving east in two places, the way of march west: withdrawing, not advancing on two axes.
    const rows = [['2x T-72', 'moving E', NAI1, 0], ['3x BMP-2', 'moving E', NAI2, 60]];
    const d = wayJudged(rows, TOWARD('W'));
    assert.deepEqual(d.judgments.map(j => j.rule), ['withdrawal']);
    assert.equal(core.ICD203[d.judgments[0].level][0], 'likely');
    assert.ok(d.text.replace(/\s+/g, ' ').includes('Basis: moving back along the way of march (W) (T0 250000Z, T1 250100Z)'), d.text);
    assert.ok(d.text.includes('Watch for: withdrawal or breaking contact reported; covering forces left behind'), d.text);
    assert.deepEqual(wayJudged(rows).judgments.map(j => j.rule), ['axes'], 'without a way of march, an advance on two axes');
    // A report saying it halted, whose earlier version was 3 km west: it moved east.
    const halted = (from) => report({ id: 'h', displayId: 'H1', size: '2x T-72', activity: 'halted', location: NAI1, time: '2026-10-25T02:00:00Z',
        history: [{ size: '2x T-72', activity: 'moving', location: from, time: '2026-10-25T01:00:00Z', lastModified: 5 }] });
    const run = (r) => core.summaryDetail('narrative', [r], OVERLAYS, { ...TABLE_OPTS, narrative: { toward: 'W' } });
    assert.deepEqual(run(halted('38SMB4200082000')).judgments.map(j => j.rule), ['withdrawal']);
    // Moved west, or only a few meters (a grid typed again): no withdrawal.
    assert.deepEqual(run(halted('38SMB4800082000')).judgments.map(j => j.rule), []);
    assert.deepEqual(run(halted('38SMB4500082050')).judgments.map(j => j.rule), []);
    // A supply truck going back is no withdrawal.
    assert.deepEqual(wayJudged([['3x trucks', 'moving E', NAI1, 0]], TOWARD('W')).judgments.map(j => j.rule), []);
});

test('the way of march is said under OBSERVED, and a sign not yet seen is one to watch for', () => {
    const d = wayJudged([...RULE_TABLE.offense[1], ['2x T-72', 'moving E', NAI2, 90]], { narrative: { toward: 'W' }, overlays: [...OVERLAYS, AXIS_W] });
    const t = d.text.replace(/\s+/g, ' ');
    assert.ok(t.includes('Way of march: toward W in the AO; along AXIS GOLD within 10 km of it. Of 2 reports moving there: 0 along it, 1 back along it, 1 across it.'), t);
    // Offense fired from artillery and air defense: armor moving along it is to watch for.
    assert.ok(/Watch for: [^.]*armor or mechanized forces moving along the way of march[;.]/.test(t), t);
    // An axis far from every report and no AO direction: the judgments are as they were.
    const far = { type: 'AXIS', name: 'FAR', geometry: { type: 'LineString', coordinates: [ll('38SMB4000040000'), ll('38SMB7000040000')] } };
    const rows = [...RULE_TABLE.offense[1], ...RULE_TABLE.withdrawal[1]];
    const was = wayJudged(rows).text, now = wayJudged(rows, { overlays: [...OVERLAYS, far] }).text;
    assert.equal(now.split('\n').filter(l => !/Way of march/.test(l)).join('\n'), was);
    assert.ok(now.includes('Way of march: along AXIS FAR within 10 km of it.'), now);
    // The setting is read as a direction, or none.
    assert.ok(wayJudged(rows, TOWARD('w')).text.includes('toward W in the AO'));
    assert.equal(wayJudged(rows, TOWARD('WEST')).text, was);
    assert.equal(wayJudged(rows, TOWARD('')).text, was);
});

test("each judgment's detail points at its last line, and the text is summaryReport's", () => {
    const reps = tableReps([...RULE_TABLE.defense[1], ...RULE_TABLE.recon[1].map(([s, a, l, m]) => [s, a, l, m + 300])]);
    [100, 60, Infinity].forEach(width => {
        const d = core.summaryDetail('narrative', reps, OVERLAYS, { ...TABLE_OPTS, width });
        assert.equal(d.text, core.summaryReport('narrative', reps, OVERLAYS, { ...TABLE_OPTS, width }));
        const lines = d.text.split('\n');
        assert.ok(d.judgments.length >= 2);
        d.judgments.forEach((j, i) => {
            assert.ok(/^ {6}\S/.test(lines[j.line]), lines[j.line]);
            // The next line opens the next judgment, or ends the section.
            assert.ok(lines[j.line + 1] === '' || lines[j.line + 1].startsWith(`   ${String.fromCharCode(98 + i)}. `), `${j.rule}: ${lines[j.line + 1]}`);
        });
    });
    // Other kinds have none; with no reports, none either.
    assert.deepEqual(core.summaryDetail('rollup', reps, OVERLAYS, TABLE_OPTS).judgments, []);
    assert.deepEqual(core.summaryDetail('narrative', [], OVERLAYS, TABLE_OPTS).judgments, []);
    // A team rule is 'custom'; a report without an id is known by its number.
    const own = core.summaryDetail('narrative', tableReps([['2x trucks', 'carrying water', NAI1, 0]]).map(r => ({ ...r, id: '' })), OVERLAYS,
        { ...TABLE_OPTS, narrative: { custom: [{ what: 'are moving water', words: 'water', min: 1, hours: 12 }] } });
    assert.deepEqual(own.judgments.map(j => [j.rule, j.sources]), [['custom', ['T0']]]);
});

test('a reserve is armor halted while there is contact somewhere else: a named place or another square, never no place at all', () => {
    const reserve = (contactAt) => {
        const d = judgedBy([['6x PAX', 'firing at OP', contactAt, 0], ['2x T-72', 'halted', NAI1, 60]]);
        const j = d.judgments.find(x => x.rule === 'reserve');
        return j ? j.sources : null;
    };
    assert.deepEqual(reserve(NAI2), ['t0', 't1'], 'another NAI');
    assert.deepEqual(reserve(OBJ1), ['t0', 't1'], 'an OBJ');
    assert.deepEqual(reserve('PL RED'), ['t0', 't1'], 'a phase line, typed with no grid');
    assert.deepEqual(reserve('38SMB7500082000'), ['t0', 't1'], 'another 10 km square');
    assert.equal(reserve(NOWHERE), null, 'no place: it could be anywhere');
    assert.equal(reserve(''), null, 'an empty Location');
    assert.equal(reserve(NAI1), null, 'the same place');
    assert.equal(reserve('38SMB4500082000, PL BLUE'), null, 'the same place, near a phase line');
    // Contact with no place beside contact elsewhere: only the placed one is behind it.
    const both = judgedBy([['6x PAX', 'firing at OP', NOWHERE, 0], ['4x PAX', 'engaging', NAI2, 10], ['2x T-72', 'halted', NAI1, 60]]);
    assert.deepEqual(both.judgments.find(x => x.rule === 'reserve').sources, ['t1', 't2']);
    assert.ok(both.text.replace(/\s+/g, ' ').includes('Basis: contact elsewhere (T1 250010Z); armor or mechanized forces halted away from it (T2 250100Z).'), both.text);
});

test('a Size line says how sure the observer was: possible, probable, likely; the type is read without it', () => {
    const els = (s) => core.sizeElements(s).map(e => [e.count, e.type, e.hedge || '']);
    assert.deepEqual(els('2x possible tanks'), [[2, 'TANK', 'possible']]);
    assert.deepEqual(els('3x poss apcs'), [[3, 'APC', 'possible']]);
    assert.deepEqual(els('1x probable Heli'), [[1, 'HELI', 'probable']]);
    assert.deepEqual(els('2x likely a heli'), [[2, 'HELI', 'likely']]);
    assert.deepEqual(els('2x prob. T-72'), [[2, 'T-72', 'probable']]);
    assert.deepEqual(els('poss 3x BTR-82A'), [[3, 'BTR-82A', 'possible']], 'before the count too');
    assert.deepEqual(els('susp 2x Mi-8'), [[2, 'MI-8', 'possible']]);
    assert.deepEqual(els('2x T-72, 1x psbl BMP-2'), [[2, 'T-72', ''], [1, 'BMP-2', 'possible']]);
    // Not a qualifier: a word that only starts like one, or one with no type after it.
    assert.deepEqual(els('probe vehicle'), [[1, 'PROBE VEHICLE', '']]);
    assert.deepEqual(els('2x likely'), [[2, 'LIKELY', '']]);
    // The equipment is known through it, and counted in the Statistics as the type.
    assert.equal(core.lookupEquipment('HELI').role, 'air');
    assert.equal(core.lookupEquipment(core.sizeElements('1x poss BMP-2')[0].type).name, 'BMP-2');
    const stats = core.statsData(tableReps([['2x possible T-72', 'moving N', NAI1, 0], ['1x T-72', 'halted', NAI1, 30]]), OVERLAYS, {});
    assert.deepEqual(stats.equipment.find(e => e.label === 'T-72'), { label: 'T-72', value: 3 });
});

test('an overlay named PC and a number is an NAI, and so is the name typed in a report; a PC grid square is not', () => {
    ['PC-12344', 'PC 12344', 'pc12344', 'NAI PC-12344', 'PC-12344 (bridge)'].forEach(s =>
        assert.deepEqual(core.overlayRef(s, null), { type: 'NAI', name: 'PC-12344', key: 'NAI PC-12344' }, s));
    assert.equal(core.overlayRef('PCS 5', null), null);
    assert.equal(core.overlayRef('EPC-12', null), null);
    assert.deepEqual(core.findRefs('vic PC-12344 and NAI 2').map(r => r.key), ['NAI PC-12344', 'NAI 2']);
    assert.equal(core.overlayKey({ type: 'NAI', name: 'PC-12344' }), 'NAI PC-12344', 'the overlay and the typed name are one place');
    // A grid in the PC square stays a grid.
    ['38S PC 12345 67890', '38SPC1234567890', 'PC 12345 67890', '38S PC12345'].forEach(s => assert.deepEqual(core.findRefs(s), [], s));
    assert.deepEqual(core.findRefs('38S PC 1234 5678, near PC-77').map(r => r.key), ['NAI PC-77']);
});

test('the R-330 family is electronic warfare', () => {
    ['R-330', 'R330', 'R 330', 'R-330T', 'R-330K'].forEach(t => assert.equal((core.lookupEquipment(t) || {}).role, 'ew', t));
    assert.equal(core.lookupEquipment('R-330Zh').name, 'Zhitel');
    assert.equal(core.lookupEquipment('R-330BMV').name, 'Borisoglebsk-2');
    const ew = judgedBy([['1x R-330', 'halted', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60]]);
    assert.ok(ew.judgments.some(j => j.rule === 'ew'), ew.text);
});

test('a sign seen only as possible lets a rule fire, but adds no strength, and its report is cited as possible', () => {
    const level = (rows, rule) => { const d = judgedBy(rows); const j = d.judgments.find(x => x.rule === rule); return [j && core.ICD203[j.level][0], d.text]; };
    const firm = [['6x PAX', 'digging in', NAI1, 0], ['1x MTU-20', 'emplacing obstacles', NAI1, 60]];
    assert.equal(level(firm, 'defense')[0], 'likely');
    const [unsure, text] = level([firm[0], ['1x poss MTU-20', 'emplacing obstacles', NAI1, 60]], 'defense');
    assert.equal(unsure, 'roughly even chance');
    assert.ok(text.replace(/\s+/g, ' ').includes('(possible T1 250100Z)'), text);
    // Another report seeing it for sure: full strength again.
    assert.equal(level([...firm, ['1x poss MTU-20', 'emplacing obstacles', NAI1, 90]], 'defense')[0], 'likely');
    // Only possible reports: it still fires, at roughly even chance.
    assert.equal(level([['6x poss PAX', 'digging in', NAI1, 0], ['1x prob MTU-20', 'emplacing obstacles', NAI1, 60]], 'defense')[0], 'roughly even chance');
});

test('a counterattack cites the contact the armor arrived after, at the same strength; a logistics point knows tankers', () => {
    const counter = judgedBy([['6x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60]]);
    const j = counter.judgments.find(x => x.rule === 'counterattack');
    assert.equal(core.ICD203[j.level][0], 'roughly even chance', 'the contact adds no strength');
    assert.ok(counter.text.replace(/\s+/g, ' ').includes('Basis: contact here (T0 250000Z); armor or mechanized forces arriving within 6 hrs after contact here (T1 250100Z).'), counter.text);
    // Contact after the armor arrived isn't what it arrived after.
    const late = judgedBy([['6x PAX', 'firing at OP', NAI1, 0], ['2x T-72', 'moving N', NAI1, 60], ['4x PAX', 'engaging', NAI1, 120]]);
    assert.deepEqual(late.judgments.find(x => x.rule === 'counterattack').sources, ['t0', 't1']);
    // "tankers", plural, as the shared word list has it.
    const fuel = judgedBy([['3x trucks', 'parked', NAI1, 0], ['2x tankers', 'resupplying', NAI1, 60]]);
    assert.ok(fuel.text.replace(/\s+/g, ' ').includes('fuel or ammunition vehicles (T1 250100Z)'), fuel.text);
});

test('a point becomes the MGRS grid it is in, and back', () => {
    // Round trips across zones, hemispheres and the Norway and Svalbard exceptions.
    ['11S NV 39697 06762', '38S MB 44880 82000', '32V NM 12345 67890', '33X VC 12345 12345', '55H FA 12345 67890', '18S UJ 23487 06483'].forEach(g => {
        const [zb, sq, e, n] = g.split(' ');
        const ll = core.gridToLatLon(Number(zb.slice(0, -1)), zb.slice(-1), sq[0], sq[1], e + n);
        assert.equal(core.latLonToMgrs(ll.lat, ll.lon), g);
    });
    const full = core.latLonToMgrs(35.2934, -116.6).split(' ');
    assert.equal(core.latLonToMgrs(35.2934, -116.6, 3), `${full[0]} ${full[1]} ${full[2].slice(0, 3)} ${full[3].slice(0, 3)}`);
    assert.equal(core.latLonToMgrs(85, 10), null, 'past 84°N is UPS, not MGRS');
    // Digits outside 1-5 are brought into it.
    const [zb, sq, e, n] = full;
    assert.equal(core.latLonToMgrs(35.2934, -116.6, 0), `${zb} ${sq} ${e[0]} ${n[0]}`);
    assert.equal(core.latLonToMgrs(35.2934, -116.6, 9), full.join(' '));
    assert.equal(core.latLonToMgrs(35.2934, -116.6, 'x'), full.join(' '));
});

test('a total with its breakdown is counted once, and counts can follow the type', () => {
    const els = s => core.sizeElements(s).map(e => `${e.count} ${e.type}`);
    assert.deepEqual(els('Total of vics 10x: 5x tanks and 5x apc'), ['5 TANK', '5 APC']);
    assert.deepEqual(els('12x vics (5x tanks)'), ['5 TANK', '7 VIC'], 'what the breakdown leaves');
    assert.deepEqual(els('10x tracked: 4x T-72, 4x BMP-2'), ['4 T-72', '4 BMP-2', '2 TRACKED']);
    assert.deepEqual(els('3x T-72 (one damaged)'), ['3 T-72'], 'brackets that are a note');
    assert.deepEqual(els('Total 10 vics, 5x tanks, 5x APC'), ['5 TANK', '5 APC'], 'a total named as one');
    assert.deepEqual(els('10x vics, 5x tanks'), ['10 VIC', '5 TANK'], 'without "total", ten more vehicles');
    assert.deepEqual(els('vics 10x'), ['10 VIC']);
    assert.deepEqual(els('approx 6x support vics & 2 fuelers'), ['6 SUPPORT VIC', '2 FUELER']);
    assert.deepEqual(els('2x T-72 w/ 1x mine plow'), ['2 T-72', '1 MINE PLOW']);
});

test('plurals in any case are one type with their singular', () => {
    const els = s => core.sizeElements(s).map(e => `${e.count} ${e.type}`);
    assert.deepEqual(els('4x VICS, 3x Cars, 2X TRUCKS, 5x APCs, 6X TANKS'), ['4 VIC', '3 CAR', '2 TRUCK', '5 APC', '6 TANK']);
    assert.deepEqual(els('2x lorries, 2X BUSES, 2X RADIO RELAYS, 2X BRIDGE LAYERS, 2X TRACKED VICS'),
        ['2 LORRY', '2 BUS', '2 RADIO RELAY', '2 BRIDGE LAYER', '2 TRACKED VIC'], '"ies", "es", and two words');
    assert.deepEqual(els('2x MANPADS, 2x manpads, 2x T-72S, 2x T-72s, 2X TANK GLASS'),
        ['2 MANPADS', '2 MANPADS', '2 T-72S', '2 T-72', '2 TANK GLASS'], 'a name ending in S, a variant, and a word the catalogue lacks');
    assert.deepEqual(els('TOTAL 10 VICS: 5X TANKS, 5X APCS'), ['5 TANK', '5 APC']);
    const t = said([{ id: 'p1', displayId: 'ALPHA001', ato: 'ALPHA', title: 'P', size: '4X TANKS, 2x tank, 3X TRUCKS',
        activity: 'moving N', location: '38SMB4500082000', time: '2026-10-26T01:00:00.000Z', history: [], bda: [] }]);
    assert.ok(t.includes('Equipment reported: armor (6x tanks); logistics and support (3x trucks).'), t);
});

test('general words: vic, tracked, wheeled, support, fueler, engineer, and their mixes', () => {
    const kit = t => { const k = core.lookupEquipment(t); return k && `${k.role} ${k.name}`; };
    assert.equal(kit('VIC'), 'vehicle vehicle');
    assert.equal(kit('VICS'), 'vehicle vehicle', 'a plural in capitals');
    assert.equal(kit('TANKS'), 'armor tank');
    assert.equal(kit('TRACKED'), 'vehicle tracked vehicle');
    assert.equal(kit('WHEELED VIC'), 'vehicle wheeled vehicle');
    assert.equal(kit('ENGINEER VIC'), 'engineer engineer', 'the longer word wins');
    assert.equal(kit('ENGINEERING VEHICLE'), 'engineer engineer');
    assert.equal(kit('SUPPORT VIC'), 'logistics truck');
    assert.equal(kit('TRACKED SUPPORT VIC'), 'logistics truck');
    assert.equal(kit('FUELER'), 'logistics truck');
    assert.equal(kit('WHEELED APC'), 'mech IFV');
    // More EW: radar jammers, and the jammers on vehicles.
    assert.equal(kit('SPN-2'), 'ew SPN-2');
    assert.equal(kit('1RL248-4'), 'ew SPN-4');
    assert.equal(kit('SPN-30'), 'ew SPN-30');
    assert.equal(kit('Mi-8MTPR-1'), 'ew Mi-8MTPR-1');
    assert.equal(kit('J-15D'), 'ew J-15D');
    assert.equal(kit('J-15'), 'air J-15');
    const t = said([{ id: 'v1', displayId: 'ALPHA001', ato: 'ALPHA', title: 'P', size: 'Total of vics 10x: 5x tanks and 5x apc',
        activity: 'moving N', location: '38SMB4500082000', time: '2026-10-26T01:00:00.000Z', history: [], bda: [] }]);
    assert.ok(t.includes('Equipment reported: armor (5x tanks); mechanized infantry (5x APC).'), t);
});

test('plain words read as plurals in the narrative: tracked vehicles, buses', () => {
    const t = said([{ id: 'w1', displayId: 'ALPHA001', ato: 'ALPHA', title: 'P', size: '4x tracked, 2x wheeled, 2X BUSES, 1x tracked vic',
        activity: 'moving N', location: '38SMB4500082000', time: '2026-10-26T01:00:00.000Z', history: [], bda: [] }]);
    assert.ok(t.includes('light vehicles (2x buses)'), t);
    assert.ok(t.includes('other vehicles (4x tracked vehicles, 2x wheeled vehicles, 1x tracked vic)'), t);
});

test('a summary of a kind it does not know is a rollup', () => {
    const text = core.summaryReport('weekly', [report()], [], { local: false, now: NOW, ato: 'ALPHA' });
    assert.ok(text.startsWith('ROLLUP - ALPHA\n'), text);
    assert.ok(!text.includes('undefined'));
});

// --- Measuring: units, areas, rates of march ---

test('distances read in the units and for the class given', () => {
    const d = core.formatDistance;
    assert.equal(d(850), '850 m');
    assert.equal(d(2449.6), '2.45 km');
    assert.equal(d(12345), '12.3 km');
    assert.equal(d(850, 'imperial'), '930 yd');
    assert.equal(d(2449.6, 'imperial'), '1.52 mi');
    assert.equal(d(20000, 'imperial'), '12.4 mi');
    // Dismounts in m or yd up to ten thousand; aircraft in km or nautical miles.
    assert.equal(d(1250, 'metric', 'dismount'), '1,250 m');
    assert.equal(d(1250, 'imperial', 'dismount'), '1,367 yd');
    assert.equal(d(12000, 'metric', 'dismount'), '12.0 km');
    assert.equal(d(500, 'metric', 'aircraft'), '0.50 km');
    assert.equal(d(18520, 'imperial', 'aircraft'), '10.0 nm');
    assert.equal(d(-5), '0 m', 'never negative');
});

test('speeds, areas, durations and bearings read plainly', () => {
    const s = core.formatSpeed;
    assert.equal(s(4), '4 km/h');
    assert.equal(s(3.6, 'imperial', 'dismount'), '2.2 mph');
    assert.equal(s(40, 'imperial', 'vehicle'), '25 mph');
    assert.equal(s(222.24, 'imperial', 'aircraft'), '120 knots');
    assert.equal(s(222.24, 'metric', 'aircraft'), '222 km/h');
    assert.equal(core.speedUnit('imperial', 'aircraft'), 'knots');
    assert.equal(core.speedUnit('metric', 'aircraft'), 'km/h');
    assert.equal(core.formatArea(12500), '12,500 m²');
    assert.equal(core.formatArea(2.5e6), '2.50 km²');
    assert.equal(core.formatArea(12500, 'imperial'), '14,950 yd²');
    assert.equal(core.formatArea(2.5e7, 'imperial'), '9.65 mi²');
    assert.equal(core.formatDuration(25 / 60), '25 min');
    assert.equal(core.formatDuration(80 / 60), '1 h 20 min');
    assert.equal(core.formatDuration(3), '3 h');
    assert.equal(core.formatDuration(0.001), 'under a minute');
    assert.equal(core.formatBearing(47.4), '047° NE');
    assert.equal(core.formatBearing(359.8), '000° N');
});

test('a path is its legs added up, and an area is what a ring holds, on the sphere', () => {
    const a = { lon: 44, lat: 33 }, b = { lon: 44.01, lat: 33 }, c = { lon: 44.01, lat: 33.01 };
    assert.equal(core.pathMeters([a, b, c]), core.metersBetween(a, b) + core.metersBetween(b, c));
    assert.equal(core.pathMeters([a]), 0);
    // A degree square at the equator: R² Δλ sin(1°), about 12,364 km².
    const sq = [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0, lat: 1 }];
    const want = 6371008.8 ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180);
    assert.ok(Math.abs(core.areaMeters(sq) - want) < 1, core.areaMeters(sq));
    assert.equal(core.areaMeters([...sq, sq[0]]), core.areaMeters(sq), 'closed or not');
    assert.equal(core.areaMeters([...sq].reverse()), core.areaMeters(sq), 'either way round');
    assert.equal(core.areaMeters(sq.slice(0, 2)), 0);
    // A small square, 1 km a side near 33N: about 1 km².
    const k = 0.009, e = k / Math.cos(33 * Math.PI / 180);
    const ring = [{ lon: 44, lat: 33 }, { lon: 44 + e, lat: 33 }, { lon: 44 + e, lat: 33 + k }, { lon: 44, lat: 33 + k }];
    assert.ok(Math.abs(core.areaMeters(ring) / 1e6 - 1) < 0.01, core.areaMeters(ring));
    // A range ring's points are all its radius from the center, the first due north.
    const center = { lon: 44, lat: 33 }, pts = core.ringPoints(center, 5000, 36);
    assert.equal(pts.length, 36);
    pts.forEach(p => assert.ok(Math.abs(core.metersBetween(center, p) - 5000) < 0.01));
    assert.ok(Math.abs(pts[0].lon - 44) < 1e-9 && pts[0].lat > 33);
    assert.ok(Math.abs(core.bearingBetween(center, pts[9]) - 90) < 0.01, 'a quarter round is east');
});

test('what a report moves as comes from the catalogue', () => {
    const k = core.movementClass;
    assert.equal(k('2x T-72'), 'vehicle');
    assert.equal(k('2x BMP, 6x PAX'), 'vehicle', 'troops with vehicles ride');
    assert.equal(k('6x PAX'), 'dismount');
    assert.equal(k('4x soldiers w/ RPG'), 'dismount', 'with what they carry');
    assert.equal(k('2x Kornet'), 'vehicle', 'a weapon alone is not people');
    assert.equal(k('1x Mi-8'), 'aircraft');
    assert.equal(k('2x Ka-52'), 'aircraft');
    assert.equal(k('1x helicopter w/ 10x PAX'), 'aircraft');
    assert.equal(k('1x Mi-8, 2x T-72'), 'vehicle');
    assert.equal(k('3x widgets'), 'vehicle', 'equipment the catalogue does not know');
    assert.equal(k(''), 'vehicle');
    // The team's own entries count.
    assert.equal(k('2x Gizmo', core.teamEquipment([{ type: 'Gizmo', role: 'air' }])), 'aircraft');
});

test('a track gives its rate of march by leg and overall, and says nothing silly', () => {
    const v = (location, time, lastModified) => ({ location, time, lastModified, size: '2x BMP' });
    const h1 = v('38SMB4500082000', '2026-10-24T08:00:00Z', 1);
    const h2 = v('38SMB4500084000', '2026-10-24T08:30:00Z', 2);   // 2 km north in 30 min
    const h3 = v('38SMB4500084000', '2026-10-24T09:00:00Z', 3);   // a halt there
    const r = { ...v('38SMB4500086000', '2026-10-24T09:15:00Z', 4), id: 'm1', history: [h3, h1, h2] };
    const got = core.marchRates(r, 'vehicle');
    assert.equal(got.legs.length, 2);
    assert.equal(got.legs[0].from, h1);
    assert.equal(got.legs[0].to, h2);
    assert.ok(Math.abs(got.legs[0].kmh - 4) < 0.05, got.legs[0].kmh);
    // Each leg from leaving one grid to reaching the next: the halt isn't in it.
    assert.equal(got.legs[1].from, h3);
    assert.equal(got.legs[1].to, r);
    assert.ok(Math.abs(got.legs[1].kmh - 8) < 0.1, got.legs[1].kmh);
    // Overall from leaving the first grid to reaching the last, halt included.
    assert.ok(Math.abs(got.overall.meters - 4000) < 20, got.overall.meters);
    assert.equal(got.overall.hours, 1.25);
    assert.ok(Math.abs(got.overall.kmh - 3.2) < 0.05, got.overall.kmh);
    // Under a minute between them, a time that can't be read, or no grid: no rate.
    const none = { legs: [], overall: null };
    assert.deepEqual(core.marchRates({ ...v('38SMB4500084000', '2026-10-24T08:00:30Z', 2), history: [h1] }), none);
    assert.deepEqual(core.marchRates({ ...v('38SMB4500084000', 'soon', 2), history: [h1] }), none);
    assert.deepEqual(core.marchRates({ ...v('near the bridge', '2026-10-24T09:00:00Z', 2), history: [h1] }), none);
    assert.deepEqual(core.marchRates({ ...h1, history: [] }), none);
    assert.deepEqual(core.marchRates(null), none);
    // 2 km in two minutes is 60 km/h: a vehicle's rate, not troops on foot.
    const fast = { ...v('38SMB4500084000', '2026-10-24T08:02:00Z', 2), history: [h1] };
    assert.equal(core.marchRates(fast, 'vehicle').legs.length, 1);
    assert.deepEqual(core.marchRates(fast, 'dismount'), none);
});

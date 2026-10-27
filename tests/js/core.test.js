// SPDX-License-Identifier: AGPL-3.0-only

// Tests for src/core.js, the page's pure logic. Node's built-in runner, no
// packages:  node --test tests/js/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../src/core.js');

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

// --- Text safety ---

test('HTML, colors, and filenames are made safe', () => {
    assert.equal(core.escapeHtml('<b a="1">\'&'), '&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
    assert.equal(core.safeColor('#0a84ff'), '#0a84ff');
    assert.equal(core.safeColor('red;background:url(x)'), 'var(--system-gray)');
    assert.equal(core.safeFilename('A/B 1'), 'A_B_1');
    assert.equal(core.safeFilename('///'), 'X');
});

// --- Reports ---

test('the ATO prefix is upper case with no dashes, everywhere', () => {
    assert.equal(core.atoPrefix(' alpha-01 '), 'ALPHA01');
    assert.equal(core.atoPrefix('IMPORT'), 'IMPORT');
    assert.equal(core.atoPrefix(null), '');
});

test('report numbers ignore digits that belong to the ATO', () => {
    assert.equal(core.reportNum({ displayId: 'TEST01001', ato: 'TEST01' }), 1);
    assert.equal(core.reportNum({ displayId: 'ALPHA012', ato: 'ALPHA' }), 12);
    assert.equal(core.reportNum({ displayId: 'LEGACY7' }), 7);
    assert.equal(core.reportNum(null), 0);
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
    const pairs = core.bdaElements({ size: '4x T-72, 2x BMP-2', location: '18SUJ1111, 18SUJ2222' });
    assert.deepEqual(pairs, [{ target: '4x T-72', coords: '18SUJ1111' }, { target: '2x BMP-2', coords: '18SUJ2222' }]);
    const shared = core.bdaElements({ size: '4x T-72; 2x BMP-2', location: '18SUJ1111' });
    assert.deepEqual(shared.map(p => p.coords), ['18SUJ1111', '18SUJ1111']);
    const unclear = core.bdaElements({ size: 'a1, b2, c3', location: '18SUJ1111 18SUJ2222' });
    assert.deepEqual(unclear.map(p => p.coords), ['', '', '']);
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
    assert.ok(text.includes(' ATO: BRAVO  —  Screen  (1 report)\n'));
    assert.deepEqual(Object.keys(core.parseBackup(text).data.workspaces), ['ALPHA', 'BRAVO']);
});

test('backup parsing explains what is wrong with a file', () => {
    assert.match(core.parseBackup('').error, /empty/);
    assert.match(core.parseBackup('just notes').error, /no ##SALT_BACKUP## block/);
    assert.match(core.parseBackup('##SALT_BACKUP##{oops##SALT_BACKUP_END##').error, /corrupt/);
    assert.match(core.parseBackup('{"other": 1}').error, /recognisable/);
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
    assert.deepEqual(rows[0], ['Identifier', 'UpdateStatus', 'Size', 'Activity', 'MGRS', 'Time (Z)', 'Analysis', 'W']);
    assert.deepEqual(rows.slice(1).map(row => row[1]), ['Current Update', 'Update #2 (Old)', 'Update #1 (Old)', 'BDA #1']);
    assert.equal(rows[1][7], 'Rain');
    assert.equal(rows[4][6], 'he said "done"');
    assert.ok(csv.endsWith('\r\n'));
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

// The centre of each square, from the NGA's GeoTrans (the `mgrs` Python
// package), across both hemispheres, every precision, band edges, the
// equator, and Norway's and Svalbard's odd zones.
const VECTORS = require('./mgrs-vectors.json');

test('MGRS grids convert to the centre of their square, within a metre', () => {
    const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(b.lat * Math.PI / 180));
    for (const v of VECTORS) {
        for (const text of [v.mgrs, v.spaced, v.spaced.toLowerCase()]) {
            const g = core.findGrids(text);
            assert.equal(g.length, 1, text);
            assert.ok(metres(g[0], v) < 1, `${text}: ${metres(g[0], v).toFixed(2)} m off`);
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
    assert.ok(Math.abs(a.nearestPl.metres - 3000) < 30, `${a.nearestPl.metres} m`);
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
    assert.deepEqual([field('precision_m').type, field('heading_deg').type, field('lat').type],
        ['esriFieldTypeInteger', 'esriFieldTypeInteger', 'esriFieldTypeDouble']);
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
    // heading_deg: null on one, 45 on the other: a number field, null kept.
    assert.equal(esri.fields.find(f => f.name === 'heading_deg').type, 'esriFieldTypeInteger');
    assert.deepEqual(esri.features.map(f => f.attributes.heading_deg), [null, 45]);
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
    assert.ok(text.includes('   260310Z  ALPHA003  1x BMP-2; engaging friendly OP; 38SMB5300088000'), 'firing is notable');
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
    assert.ok(text.includes('LAST REPORT:  260310Z  ALPHA003  1x BMP-2; engaging friendly OP; 38SMB5300088000'));
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
    assert.ok(core.wmsUrl('http://s/wms', 'a', [1, 2, 3, 4], 10, 10, { crs: 'EPSG:102100' }).includes('BBOX=1.00,2.00,3.00,4.00'), 'metres');
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
    assert.match(files['xl/worksheets/sheet2.xml'], /<c r="B2" s="4"><v>46319.25<\/v><\/c>/);
    assert.match(files['xl/worksheets/sheet2.xml'], /state="frozen"/);
    assert.match(files['xl/sharedStrings.xml'], /<t xml:space="preserve">ALPHA · all reports<\/t>/);
    // No reports and no charts: still a workbook, without a table or drawing.
    const empty = unzipStored(core.statsXlsx({ charts: [], reports: { header: ['A'], rows: [] } }, NOW));
    assert.ok(!empty['xl/tables/table1.xml'] && !empty['xl/drawings/drawing1.xml']);
    assert.ok(!empty['[Content_Types].xml'].includes('table1'));
});

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
    assert.equal(new Date(end).toISOString(), '2026-10-24T23:59:59.000Z');
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

test('the BDA pill reports progress and the worst outcome', () => {
    const r = { size: '4x T-72, 2x BMP-2', location: '', bda: [{ effect: 'Damaged' }, { effect: 'Destroyed' }] };
    assert.deepEqual(core.bdaSummary(r), { done: 2, total: 2, worstCls: 'destroyed' });
    assert.deepEqual(core.bdaSummary({ size: 'x1', bda: [] }), { done: 0, total: 1, worstCls: '' });
});

test('the BDA roll-up totals a workspace\'s elements and outcomes', () => {
    const reps = [
        { size: '4x T-72, 2x BMP-2', location: '', bda: [{ effect: 'Destroyed' }] },        // 1 of 2 assessed
        { size: '1x ZSU', location: '', bda: [{ effect: 'Damaged' }, { effect: 'odd' }] },   // more assessments than elements
        { size: '3x trucks', location: '', bda: [] },                                       // nothing yet
        { size: '1x gone', deleted: true, bda: [{ effect: 'Destroyed' }] },                  // deleted: ignored
    ];
    assert.deepEqual(core.bdaRollup(reps), {
        done: 3, total: 5, unassessed: 2,
        byEffect: { Destroyed: 1, Damaged: 1, 'Mobility Kill': 0, Suppressed: 0, 'No Effect': 0, Unknown: 1 },
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

test("backups carry the workspace's overlays", () => {
    const ovs = { ALPHA: OVERLAYS, BRAVO: [] };
    const one = core.parseBackup(core.backupText('ALPHA', [report()], 'Patrol', {}, {}, NOW, ovs)).data;
    assert.deepEqual(Object.keys(one.overlays), ['ALPHA']);
    assert.equal(one.overlays.ALPHA.length, 4);
    const all = core.parseBackup(core.allWorkspacesBackupText({ ALPHA: [report()] }, 'ALPHA', 'Patrol', {}, {}, NOW, ovs)).data;
    assert.deepEqual(Object.keys(all.overlays), ['ALPHA'], 'only the workspaces in the file');
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
    assert.deepEqual(d.kpis, { reports: 4, withGrid: 4, inPlace: 4, checks: 1, bdaDone: 0, bdaTotal: 4 });
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
    assert.ok(text.includes('   1 of 3 elements assessed: Destroyed 1.'));
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
    assert.ok(text.includes('OPEN ITEMS:   1 check to look at; 2 BDA elements unassessed'));
});

test('the same reports always give the same words', () => {
    assert.equal(core.summaryReport('rollup', SUMMARY_REPS, OVERLAYS, SUMMARY_OPTS),
                 core.summaryReport('rollup', [...SUMMARY_REPS].reverse(), OVERLAYS, SUMMARY_OPTS));
});

test('places to summarize: every overlay, then whatever reports name', () => {
    assert.deepEqual(core.summaryPlaces([report({ location: '38SMB4500082000, OBJ GOLD' })], OVERLAYS),
        ['NAI 1', 'NAI 2', 'OBJ BRIDGE', 'OBJ GOLD', 'PL BLUE']);
});

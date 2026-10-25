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

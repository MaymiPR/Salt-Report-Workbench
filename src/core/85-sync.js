// SPDX-License-Identifier: AGPL-3.0-only
// Sync bookkeeping. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Sync bookkeeping ---

// Reports are matched the way the server merges them: by id, or by
// displayId for rows that predate ids.
const reportKey = r => (r && (r.id || r.displayId)) || '';

// The version of each report a workspace holds: key -> lastModified, as a
// plain object (the page keeps it so). Built through a Map, so an id such as
// "__proto__" (which the server takes) is a key like any other.
const knownVersions = reps => {
    const out = new Map();
    (reps || []).forEach(r => { const k = reportKey(r); if (k) out.set(k, r.lastModified || 0); });
    return Object.fromEntries(out);
};
// A key's version in a knownVersions record: its own, never one an object
// inherits ("constructor", "toString").
const versionIn = (known, k) => (Object.prototype.hasOwnProperty.call(known, k) ? known[k] : undefined);

// The reports the server doesn't hold in this exact version: new ones and
// changed ones. With no record of the server's copy (`known` undefined),
// everything is sent.
const changedReports = (reps, known) =>
    (reps || []).filter(r => { const k = reportKey(r); return k && (!known || versionIn(known, k) !== (r.lastModified || 0)); });

// The workspaces of `byAto` (workspace -> reports) a browser keeps in its own
// copy: those named in `keep` (a Set: the one it is in, those with changes
// waiting), and any holding a report the server doesn't have in that
// version, by `versions` (workspace -> knownVersions; one with no record is
// kept). The others the server has, and a pull brings them back.
const workspacesToCache = (byAto, keep, versions) => Object.fromEntries(Object.entries(byAto || {})
    .filter(([ato, reps]) => keep.has(ato) || changedReports(reps, (versions || {})[ato]).length));

// How many reports a browser has that the server doesn't, each once: in the
// workspaces with changes waiting (`waiting`, workspace -> reports), those
// changed since the last pull (`versions`), and those it refused (`refused`,
// workspace -> report keys). Null when it can't be told: a workspace waiting
// with no record of the server's copy (right after a reload, before the
// first pull), where every report would count.
const unsentTally = (waiting, versions, refused) => {
    const keys = {};
    let known = true;
    Object.entries(waiting || {}).forEach(([ato, reps]) => {
        if (!(versions || {})[ato]) { if ((reps || []).some(reportKey)) known = false; return; }
        keys[ato] = new Set(changedReports(reps, versions[ato]).map(reportKey));
    });
    if (!known) return null;
    Object.entries(refused || {}).forEach(([ato, ks]) => { (ks || []).forEach(k => (keys[ato] = keys[ato] || new Set()).add(k)); });
    return Object.values(keys).reduce((n, s) => n + s.size, 0);
};

// Lay changes the server refused over its copy of a workspace, so they stay
// visible until fixed or discarded. A refused change the server has since
// moved past (someone saved a newer version) is superseded and dropped.
const withUnsaved = (serverReps, unsavedReps) => {
    const reports = [...(serverReps || [])];
    const index = new Map();
    reports.forEach((r, i) => { index.set(reportKey(r), i); });
    const superseded = [];
    (unsavedReps || []).forEach(u => {
        const k = reportKey(u);
        const i = index.get(k);
        if (i === undefined) { index.set(k, reports.length); reports.push(u); }
        else if ((reports[i].lastModified || 0) > (u.lastModified || 0)) superseded.push(k);
        else reports[i] = u;
    });
    return { reports, superseded };
};

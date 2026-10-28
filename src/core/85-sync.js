// SPDX-License-Identifier: AGPL-3.0-only
// Sync bookkeeping. The build joins the src/core/ parts in name order inside one function, so they share one scope.

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

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The connected-operators count no longer counts the host twice. The launcher
  opens the LAN address, so a host that also had a `localhost` tab open showed
  up as two operators. Every address of the host now counts as one machine.

## [2.4.0] - 2026-10-24

### Fixed

- Updating or editing a report without touching its Time box keeps the
  report's original timestamp. The box carries only the clock part, so the
  report used to be re-dated to today, and that counted as a change worth a
  history entry even when nothing else differed.
- A just-logged report no longer blinks out of the table when another
  operator's change arrives while it is still being sent.
- The server re-checks its own addresses every minute, so the host's browser
  keeps its free pass on the LAN URL after a DHCP change instead of being
  asked for the code until a restart.
- Starting the next report while the previous one is still uploading no
  longer wipes the fields: the form is cleared (and the report copied) as
  soon as it is logged, not after the server confirms.
- The first-run dialog scrolls when it is taller than the screen. With Quick
  Start chips filled in, "Get Started" could sit below the edge of a small
  laptop screen with no way to reach it.

### Changed

- Each workspace is saved to its own backup file, `{ATO}_{Title}.txt`, and
  only the workspace that changed is rewritten. One file used to hold every
  loaded workspace, named after the active one, so files duplicated each
  other and a stale copy of a workspace could win on reload. Files from
  earlier versions still load, and the first save after upgrading gives each
  workspace its own file. Unloading a workspace leaves its file in place, as
  before.
- For contributors: the page's code is split from one 2,700-line `app.js`
  into seven ordered scripts under `src/app/` (state, rendering, form,
  import/export, sync, handlers, startup). Same code, same scope; the build
  inlines them in order.
- For contributors: browser tests. `tests/test_browser.py` drives the built
  page in Chromium through Playwright (optional; skipped when it isn't
  installed) and CI runs it: first-run setup, logging, live update on the
  viewer, delete and undo, sorting, the BDA roll-up.

## [2.3.0] - 2026-10-24

### Fixed

- A browser whose storage is full keeps working. Every browser mirrors every
  workspace, with history, into the ~5 MB a browser allows, and when that
  ran out the client went silently offline. It now says so once and carries
  on from memory.
- Starting the server a second time on Windows failed to fail: both copies
  printed the banner and split the traffic between them. The second start now
  stops with "port already in use".
- Report ids are escaped wherever they land in the page, and the server
  accepts only the characters the app generates, so a tampered backup file
  can't carry markup into everyone's browser.
- The client reacts to the server's own shutdown notice, instead of waiting
  for the next failed heartbeat.
- A typed time more than an hour ahead of now is dated yesterday. In Zulu mode
  the day rolls over during a US evening, so `23:50` typed at `00:30Z` used to
  land twenty-three hours in the future.
- CSV import reads a Time column written as ISO 8601, `YYYY-MM-DD HH:MM`,
  `HH:MM`/`HHMM` (today), or a DTG such as `241430Z`. Any other value gets the
  import time and the result says how many. Before, a column in any form but
  ISO 8601 made the server refuse every imported row.
- A workspace whose ATO has a dash (`ALPHA-01`) numbers its reports with one
  prefix. Reports from the form dropped the dash (`ALPHA01001`); CSV imports
  and "Send to ATO" kept it, so the same workspace had two numbering schemes.

### Added

- **Undo** for Delete and Restore: a button on the message, for ten seconds.
- **Sort by Size, Activity, or Location** by clicking the header, with numbers
  in numeric order ("2x T-72" before "10x T-72").
- **BDA roll-up** above the table: elements assessed out of every element in
  the workspace, a count per outcome, and Unassessed; click a chip to show
  only those reports. Viewers see it too.
- An audit log, `Auto Backups/audit.log`: one line per accepted change with
  the time, the operator (initials and address), and what changed, plus
  server starts and stops.
- Dated backup snapshots in `Auto Backups/snapshots/`: one at every start,
  then at most one an hour, the newest 48 kept. The live backup is replaced
  within half a second of every change, so this is the way back from a bad
  import or a wrong delete.

### Changed

- Sync downloads are compressed. Every browser downloads the whole state after
  every change, and a month of reports is megabytes of JSON; it now travels
  five to eight times smaller, and one compression serves every client.
- Viewers (the read-only port) no longer keep a copy of the reports in browser
  storage, and clear any copy an earlier version left. The page comes from the
  server, so the copy was of no use without it.

## [2.2.0] - 2026-10-24

### Fixed

- Confirming a prompt no longer also runs an earlier prompt that was left
  unanswered. One click on Confirm could unload, delete, or restore something
  the dialog wasn't showing.
- Importing a backup that holds several workspaces (such as an "Export All
  ATOs" file) restores all of them. Only the active one used to reach the
  server, and the sync that followed erased the rest.
- A report the server refuses (a field over its length limit, an upload over
  the size cap) is reported with the server's reason. It used to show
  "logged & copied" and "Online & Synced", then vanish on the next sync.
  Changes that can't reach the server stay queued, and a sync no longer
  pulls over them. Form fields now carry the server's length limits.
- Importing someone else's reports no longer makes the server attribute your
  later edits to them.
- Restoring an earlier version restores its custom field values too.
- Updating a report that another operator deleted now says so, instead of
  silently copying an empty report over the clipboard.
- Esc on a new report clears custom fields along with the rest.
- A corrupt value in browser storage no longer stops the app from starting.
- Server: an oversized or refused upload gets its error reply instead of a
  connection reset, a negative `Content-Length` is refused at once, and a
  cookie with non-ASCII characters is denied instead of getting no response.
- Server: `HEAD` requests no longer report the size and date of files beside
  the server.
- Server: `--access-code` refuses a blank value, which used to open the editor
  port to anyone, and characters a browser cookie can't carry.
- The access-code box accepts codes longer than 10 characters, so a custom
  `--access-code` can be typed in.
- "Send to ATO" from the IMPORT workspace never pushed the destination
  workspace, so the moved reports were lost on the next sync.
- The MTI export finds counts written "4x tracked" (and "4 x tracked"), not
  only "4 tracked".

### Changed

- Each change uploads only the reports it touched instead of the whole
  workspace, so syncing no longer grows with the length of the operation.
- A report the server refuses is no longer lost. It stays in the table marked
  *Not saved*, with the server's reason, until it is fixed (then it is sent
  again) or discarded (the server's copy comes back). When several reports are
  sent together, the rest still land.
- The CSV and MTI Identifier column matches the table and copy text
  ("Patrol - ALPHA001", following the Title Separator) instead of the stored
  form without a separator ("PatrolALPHA001").
- The upload cap is 16 MB instead of 1 MB, so the full push a browser makes
  after a reload fits even a long operation.
- The ⋯ menu's "Clear All Data" is now "Clear Workspace", which is what it
  does. It shares Unload's behavior, so it also clears the title and form.
- The server reports unexpected errors on its console instead of swallowing
  them, and lines up its startup banner.

### Removed

- `archive/`, two old snapshots that nothing used. They remain in git history.

## [2.1.1] - 2026-10-24

### Changed

- Licensed under the GNU AGPL v3 only (`AGPL-3.0-only`), matching the author's
  other projects. The LICENSE file now matches the official FSF text exactly.

## [2.1.0] - 2026-10-24

### Added

- `Start SALT Workbench.bat`, a double-click launcher for Windows that needs no
  install or admin rights. It can be pointed at a specific `python.exe` by
  editing one line or setting `SALT_PYTHON`, and otherwise finds Python by
  itself, including a portable copy in a `python\` folder beside it. The build
  copies it into `dist/`.

### Removed

- The ™ marks after the product name and the © line in the server banner and
  the manual footer. They began as a joke; the name isn't a registered
  trademark. The license's copyright notices are unchanged.

## [2.0.0] - 2026-10-24

First tagged release. SALT logging with real-time LAN sync over Server-Sent
Events, offline mode, edit history with restore, workspaces, a read-only viewer
port, a per-launch access code, the report builder (SALT and SALT-U presets,
custom fields with their own table columns), BDA tracking with a pre-paired
checklist, and backup, CSV, and MTI exports. Licensed under the
GNU AGPL v3.

Changes below are relative to the untracked build this release grew out of.

### Fixed

- Backup writes no longer block requests. The whole save used to run while
  holding the data lock, so every sync and POST stalled for the duration of the
  disk write.
- Workspace unloads are written to disk immediately instead of whenever an
  unrelated later change triggered a save.
- The `Auto Backups/` folder is created beside the server, as documented, rather
  than in whatever directory the server was launched from.
- The access-code alphabet no longer includes `5`, which the docs already said
  was excluded to avoid confusion with `S`.
- The boot banner, including the access code, appears immediately when the
  server's output is redirected to a log file or a service wrapper. It used
  to sit in Python's output buffer.
- Server-stamped edit attribution no longer misses when initials arrive with
  surrounding whitespace.

### Changed

- The config and profile endpoints keep only the fields the app uses, instead
  of storing and re-broadcasting whatever the client sent.
- The repository now has a conventional layout: `src/`, `server/`, `scripts/`,
  `tests/`, `docs/`, `assets/`. The build produces a self-contained `dist/`
  folder with the page and the server.
- The server file is renamed `salt_sync_server.py`, and the page is served at
  `/` and `/index.html`. The old `/Salt%20Report%20Workbench.html` path still
  works.
- The build now fails, rather than shipping a broken page, when the stylesheet
  link or script tag it inlines is missing.

### Added

- Brand identity: logo, monochrome variants, avatar, README banners, social
  preview, and an inline favicon.
- A 54-test suite covering merge rules, backup round trips, validation, rate
  limiting, access control, and live HTTP behavior.
- CI: lint, tests on Python 3.10–3.13 and on Windows, and a build smoke test.
- Ruff, pre-commit, EditorConfig, and a Makefile.
- README, architecture notes, and contributing, security, and conduct guides.

[Unreleased]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/MaymiPR/SaltReportWorkbench/releases/tag/v2.0.0

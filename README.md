<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner-light.svg" alt="S.A.L.T. Report Workbench" width="720">
  </picture>
</p>

<p align="center">
  <strong>Field-ready SALT reporting with real-time LAN sync.</strong><br>
  Log, share, and assess Size · Activity · Location · Time reports across a tactical network,
  with nothing to install but Python.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.5.0-0A84FF" alt="Version 2.5.0">
  <a href="https://github.com/MaymiPR/SaltReportWorkbench/actions/workflows/ci.yml"><img src="https://github.com/MaymiPR/SaltReportWorkbench/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/python-3.10%2B-0A84FF" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/dependencies-none-32D74B" alt="No dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-8E8E93" alt="License: AGPL v3"></a>
</p>

---

## Overview

S.A.L.T. Report Workbench is a reporting tool for intelligence and reconnaissance
operators and the TOC staff who consume their reports. Operators log observations
in the doctrinal **SALT** format; every connected browser on the network sees each
report the moment it's logged; and the whole session is continuously backed up to
plain-text files a person can read.

It is built for places where you can't count on the internet, an IT department,
or a package registry:

- **Runs on a stock Python install.** The server uses only the standard library.
  The client is one self-contained HTML file: no CDN, nothing fetched at runtime.
- **Works offline.** Open the HTML file directly and it runs from browser storage.
  Connect to the server and it syncs; lose the server and changes queue locally,
  then replay when it's back.
- **Shares safely.** Editors join with a per-launch access code; observers get a
  separate read-only port that refuses every write.

<p align="center">
  <img src="docs/screenshots/viewer.png" alt="The report log in view-only mode, with a workspaces sidebar and six SALT reports" width="900">
</p>

## How it was made

S.A.L.T. Report Workbench was created entirely with Claude (Anthropic's AI):
every line of code, the brand assets and this documentation. The operators who
use it were the reference: their field testing shaped what it does, as recorded
in [CHANGELOG.md](CHANGELOG.md).

## Features

| Feature | What it does |
| --- | --- |
| **Real-time sync** | Server-Sent Events push every change to every browser within a second. Last-modified-wins merging resolves concurrent edits. |
| **Offline-first** | Full functionality from local storage; queued changes replay automatically on reconnect. Each change uploads only the reports it touched, and a report the server refuses stays visible as *Not saved* until it's fixed or discarded. |
| **Report builder** | Reorder lines, switch between SALT and SALT-U, and add custom fields (e.g. `W: Weather`) that get their own form box, table column, and copy-text line. Saved per workspace and synced to the team. |
| **Overlays and ArcGIS** | Import NAIs, OBJs, and phase lines from KML, KMZ, or GeoJSON. Reports are placed in them by grid, with a check where a typed NAI disagrees. Export one point per grid, with activity tags and heading, for ArcGIS Pro heat maps. |
| **BDA tracking** | Hidden until you need it. A checklist pre-pairs each element of a report with its grid, so a ten-target assessment is ten clicks. A roll-up above the table totals the workspace by outcome, click-to-filter. Revisable, searchable, exported. |
| **Edit history** | *Update* snapshots the prior version; *Edit* corrects in place. Any prior version can be restored, and Delete and Restore both offer a ten-second Undo. |
| **Workspaces** | Separate ATOs with their own reports and formats. Switch live, and the team switches with you. |
| **View-only port** | Observers watch live on a second port that rejects every write, with no code required. |
| **Exports** | Human-readable backups that re-import losslessly, CSV (including history and BDA rows), and MTI tracked/wheeled splits. |
| **Hardened server** | Per-endpoint schema validation, per-IP rate limiting, server-stamped attribution that clients can't forge, atomic writes, and a 16 MB body cap. |

## Quick start

**Prerequisites:** Python 3.10 or newer and any modern browser. That's all.

```bash
git clone https://github.com/MaymiPR/SaltReportWorkbench.git
cd SaltReportWorkbench
python scripts/build.py
python dist/salt_sync_server.py
```

On Windows you can instead double-click **`dist/Start SALT Workbench.bat`**. See
[Windows launcher](#windows-launcher) below.

The server prints its addresses and an access code, then opens your browser:

```text
 [+] Workbench   : http://10.0.0.12:8080
 [+] Access Code : K7M2X9PQR3
 [+] Read Only   : http://10.0.0.12:8081
```

Your own browser fills in the code automatically. Share the **Workbench** URL and
the code with other editors, and the **Read Only** URL with anyone who only needs
to watch.

<p align="center">
  <img src="docs/screenshots/startup.png" alt="The first-run setup dialog with access code, Quick Start presets, identity, and workspace fields" width="520">
</p>

### Distributing to a team

`python scripts/build.py` produces a `dist/` folder containing three files:
`index.html`, `salt_sync_server.py`, and `Start SALT Workbench.bat`. Copy that folder
to any machine with Python and run the server; nothing else is needed. Every CI run
also publishes `dist/` as a downloadable artifact.

### One file, for strict transfer systems

Some file-transfer systems refuse zips and scripts. Each release also carries
**`SALT-Workbench-v<version>.txt`**: the whole release in one plain-text file,
with no compression and no base64. Each file inside is stored line by line as
escaped text, so it can be read in Notepad. Run it with Python on the other end:

```bat
python "SALT-Workbench-v2.4.1.txt"
```

It unpacks into a `SALT Report Workbench` folder beside itself, checks every file
against the checksum recorded inside, and deletes itself. It starts nothing;
double-click the launcher in that folder when you're ready. If anything fails,
it deletes nothing. To upgrade, run a newer one from the same
place: the app files are replaced, `Auto Backups` stays, and a `PYTHON_EXE` path
set in the old launcher is kept. `--keep` keeps the packed file.

It is still a program, whatever its extension. If your network blocks scripts on
purpose, ask your security office before sending it this way.

Build it from a release zip with `python scripts/pack.py SaltReportWorkbench-v<version>.zip`.

### Windows launcher

`Start SALT Workbench.bat` starts the server with a double-click. It needs no
install and no admin rights, and works from a network share. It uses the first
Python 3.10+ it finds, in this order:

1. The path on the `set "PYTHON_EXE="` line near the top of the file. If your
   machine needs a specific `python.exe`, open the launcher in Notepad and put the
   full path between the quotes:
   ```bat
   set "PYTHON_EXE=C:\Tools\Python312\python.exe"
   ```
2. The `SALT_PYTHON` environment variable, which you can set once per user
   without editing the file and without admin rights:
   ```bat
   setx SALT_PYTHON "C:\Tools\Python312\python.exe"
   ```
3. A portable Python in a `python\` folder beside the launcher (for example the
   embeddable package from python.org, unzipped as `python\`).
4. The `py` launcher, then `python` on `PATH`.
5. Standard install folders that were never added to `PATH`.

If you set a path in step 1 or 2 and it doesn't work, the launcher says so and
stops instead of quietly using some other Python. Anything you type after the
launcher's name goes to the server, for example
`"Start SALT Workbench.bat" --port 9090`.

### Without a server

Open `dist/index.html` directly in a browser. It runs in **local mode**: reports
live in that browser's storage, there's no access code, and exports work as usual.

## Usage

The full user manual is built into the app (**⋯ → User Manual**). The essentials:

1. **Set your identity and workspace** in the startup dialog, or pick existing
   ones from *Quick Start*.
2. **Log a report** with Size, Activity, Location, and Time. <kbd>Enter</kbd>
   submits, and the report is copied to your clipboard in SALT format. Several MGRS
   grids typed without commas are separated for you.
3. **Click a row** to edit it. *Update* keeps the old version in history; *Edit*
   overwrites it.
4. **Track BDA** with **⋯ → Show BDA**, then the *BDA* pill on any report.
5. **Shape the report** in **⋯ → Workspaces → Builder**.

| Shortcut | Action |
| --- | --- |
| <kbd>Enter</kbd> | Log or update (in the ATO/Title fields: set the workspace) |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Edit in place, without a history entry |
| <kbd>Esc</kbd> | Cancel the edit, deselect rows, or clear the search |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Jump to search |

## Configuration

All configuration is command-line flags. There are no environment variables or
config files, so there is no `.env` to manage.

| Flag | Default | Description |
| --- | --- | --- |
| `--port PORT` | `8080` | Editor port. |
| `--viewer-port PORT` | `8081` | Read-only port. `0` disables it. |
| `--host HOST` | `0.0.0.0` | Interface to bind. `127.0.0.1` restricts to this machine. |
| `--backup-dir DIR` | `Auto Backups/` beside the server | Where backups are written and loaded from. |
| `--access-code CODE` | random per launch | Use a fixed editor code. |
| `--no-access-code` | off | Disable the editor gate. **Only on a fully trusted network.** |
| `--no-browser` | off | Don't open a browser on launch. |
| `--no-minimize` | off | Don't minimize the console window (Windows). |

### Data and backups

Every change is written, debounced, to the changed workspace's own file,
`{ATO}_{Title}.txt`, in the backup folder: a readable summary of each report
on top, and a machine-readable JSON block below that the server reloads on the
next start. Writes are atomic, so a crash never leaves a half-written file.
Unloading a workspace leaves its file in place, so a restart brings it back.
(Before 2.4 one file held every loaded workspace; such files still load, and
the first save after upgrading gives each workspace its own file.)

Because that file is replaced within half a second of every change, the server
also keeps dated copies in `Auto Backups/snapshots/`: one on every start and
then at most one an hour, the newest 48 kept. To go back to an earlier state,
stop the server, copy the snapshot you want over the live file, and start it
again. The snapshots folder itself is never loaded.

`Auto Backups/audit.log` records every accepted write as one line: when, who
(the operator's initials and address), and what, such as
`save_reports ALPHA: 1 report(s)` or `delete_history ALPHA: 2 entries`, plus
server starts and stops. It answers "who changed this, and when" after the
fact; nothing reads it.

> [!IMPORTANT]
> Backups contain your actual reports. `Auto Backups/` is git-ignored; keep it
> that way, and handle the folder according to your unit's data-handling rules.

## Project structure

```text
.
├── src/                      Frontend sources (edited by hand)
│   ├── index.html            Markup and the built-in user manual
│   ├── styles.css
│   ├── core.js               Pure logic (formatting, parsing, exports); unit-tested
│   └── app/                  DOM, state, and sync: ordered scripts sharing one scope
│       ├── 10-state.js       Elements, state, helpers, toasts
│       ├── 20-render.js      The report table, BDA panel and roll-up
│       ├── 30-form.js        Entry, editing, restore, undo
│       ├── 40-io.js          Workspaces panel, builder, export, import
│       ├── 45-overlays.js    Overlay import (KML, KMZ, GeoJSON), Overlays tab, ArcGIS export
│       ├── 50-sync.js        Push, pull, SSE, offline queue
│       ├── 60-handlers.js    Event wiring
│       └── 70-startup.js     Restore saved state, then connect
├── server/
│   ├── salt_sync_server.py   Standard-library HTTP + SSE sync server
│   └── Start SALT Workbench.bat  Windows double-click launcher
├── scripts/
│   ├── build.py              Bundles src/ into dist/index.html, copies the server and launcher
│   └── pack.py               Packs a release zip into one self-unpacking text file
├── tests/                    Python tests (server, HTTP API, build, pack, launcher); js/ for core.js
├── assets/                   Logo, icon, banners, social preview (see BRAND.md)
├── docs/                     Architecture notes and screenshots
└── dist/                     Build output (git-ignored)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how sync, merging,
persistence, and access control fit together.

## Development

The app has no dependencies, and the dev tools are optional.

```bash
python scripts/build.py                  # bundle src/ into dist/
python server/salt_sync_server.py        # run against the dev build
python -m unittest discover -s tests     # server, build, launcher: standard library only
node --test tests/js/core.test.js        # the page's logic: Node's built-in runner

pip install ruff==0.17.2 pre-commit      # optional tooling
ruff check . && ruff format --check .
pre-commit install                       # lint on every commit

pip install playwright && playwright install chromium   # optional: browser tests
python -m unittest tests.test_browser    # drives the built page in Chromium
```

The browser tests are skipped when Playwright isn't installed, so the plain
test command works anywhere Python does.

On macOS and Linux, `make help` lists shortcuts for the same commands, and
`make check` runs everything CI runs.

CI runs lint, the test suite on Python 3.10–3.15 (Ubuntu) and 3.13 and 3.15 (Windows),
the browser tests in Chromium, and a build that starts the bundled server and
checks the editor page, the viewer port, and that writes to the viewer are
refused.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and conventions.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

S.A.L.T. Report Workbench is free software under the
[GNU Affero General Public License v3](LICENSE). It is built with nothing but
the Python standard library and a single self-contained HTML page, so it has no
third-party code or licenses to ship with a download.

Python is a trademark of the Python Software Foundation and Windows is a
trademark of Microsoft; other names are trademarks of their owners and are used
only to describe compatibility.

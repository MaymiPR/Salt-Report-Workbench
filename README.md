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
  <a href="https://github.com/MaymiPR/SaltReportWorkbench/actions/workflows/ci.yml"><img src="https://github.com/MaymiPR/SaltReportWorkbench/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-2.0.0-0A84FF" alt="Version 2.0.0">
  <img src="https://img.shields.io/badge/python-3.10%2B-0A84FF" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/dependencies-none-32D74B" alt="No dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-8E8E93" alt="License: AGPL-3.0-or-later"></a>
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

S.A.L.T. Report Workbench was created entirely with
[Claude](https://www.anthropic.com/claude), Anthropic's AI: every line of code,
the brand assets, and this documentation. Field testing by the operators who use
it shaped what it does.

## Features

| Feature | What it does |
| --- | --- |
| **Real-time sync** | Server-Sent Events push every change to every browser within a second. Last-modified-wins merging resolves concurrent edits. |
| **Offline-first** | Full functionality from local storage; queued changes replay automatically on reconnect. |
| **Report builder** | Reorder lines, switch between SALT and SALT-U, and add custom fields (e.g. `W: Weather`) that get their own form box, table column, and copy-text line. Saved per workspace and synced to the team. |
| **BDA tracking** | Hidden until you need it. A checklist pre-pairs each element of a report with its grid, so a ten-target assessment is ten clicks. Revisable, searchable, exported. |
| **Edit history** | *Update* snapshots the prior version; *Edit* corrects in place. Any prior version can be restored. |
| **Workspaces** | Separate ATOs with their own reports and formats. Switch live, and the team switches with you. |
| **View-only port** | Observers watch live on a second port that rejects every write, with no code required. |
| **Exports** | Human-readable backups that re-import losslessly, CSV (including history and BDA rows), and MTI tracked/wheeled splits. |
| **Hardened server** | Per-endpoint schema validation, per-IP rate limiting, server-stamped attribution that clients can't forge, atomic writes, and a 1 MB body cap. |

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

Every change is written, debounced, to `{ATO}_{Title}.txt` in the backup folder:
a readable summary of each report on top, and a machine-readable JSON block
below that the server reloads on the next start. Writes are atomic, so a crash
never leaves a half-written file.

> [!IMPORTANT]
> Backups contain your actual reports. `Auto Backups/` is git-ignored; keep it
> that way, and handle the folder according to your unit's data-handling rules.

## Project structure

```text
.
├── src/                      Frontend sources (edited by hand)
│   ├── index.html            Markup and the built-in user manual
│   ├── styles.css
│   └── app.js
├── server/
│   ├── salt_sync_server.py   Standard-library HTTP + SSE sync server
│   └── Start SALT Workbench.bat  Windows double-click launcher
├── scripts/
│   └── build.py              Bundles src/ into dist/index.html, copies the server and launcher
├── tests/                    unittest suite: server logic, HTTP API, build
├── assets/                   Logo, icon, banners, social preview (see BRAND.md)
├── docs/                     Architecture notes and screenshots
├── archive/                  Historical snapshots; not built or run
└── dist/                     Build output (git-ignored)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how sync, merging,
persistence, and access control fit together.

## Development

The app has no dependencies, and the dev tools are optional.

```bash
python scripts/build.py                  # bundle src/ into dist/
python server/salt_sync_server.py        # run against the dev build
python -m unittest discover -s tests     # 59 tests, standard library only

pip install ruff==0.17.2 pre-commit      # optional tooling
ruff check . && ruff format --check .
pre-commit install                       # lint on every commit
```

On macOS and Linux, `make help` lists shortcuts for the same commands, and
`make check` runs everything CI runs.

CI runs lint, the test suite on Python 3.10–3.13 (Ubuntu) and 3.13 (Windows), and
a build that starts the bundled server and checks the editor page, the viewer
port, and that writes to the viewer are refused.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and conventions.

## Roadmap

- **One backup file per workspace.** Today each file holds every workspace, so
  data is duplicated and the newest file wins on reload.
- **BDA roll-up** above the table (assessed, destroyed, unassessed) with
  click-to-filter, for the commander watching the viewer port.
- **Undo** for delete and restore.
- **Sortable Size, Activity, and Location columns.**
- **An audit log** of edits and deletions, kept by the server.
- **Frontend tests**, once the pure functions in `app.js` are split from DOM code.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

S.A.L.T. Report Workbench is free software under the [GNU Affero General Public
License, version 3 or (at your option) any later version](LICENSE). You can use,
study, change, and share it. If you change it and let other people use your
version over a network, you must offer them its source code too.

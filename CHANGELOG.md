# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
checklist, and backup, CSV, and MTI exports. Licensed under
AGPL-3.0-or-later.

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

[Unreleased]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/MaymiPR/SaltReportWorkbench/releases/tag/v2.0.0

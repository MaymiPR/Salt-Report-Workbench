# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Backup writes no longer block requests. The whole save used to run while
  holding the data lock, so every sync and POST stalled for the duration of the
  disk write. ([#1])
- Workspace unloads are written to disk immediately instead of whenever an
  unrelated later change triggered a save. ([#1])
- The `Auto Backups/` folder is created beside the server, as documented, rather
  than in whatever directory the server was launched from. ([#1])
- The access-code alphabet no longer includes `5`, which the docs already said
  was excluded to avoid confusion with `S`. ([#1])
- Server-stamped edit attribution no longer misses when initials arrive with
  surrounding whitespace. ([#1])

### Changed

- The config and profile endpoints keep only the fields the app uses, instead
  of storing and re-broadcasting whatever the client sent. ([#1])
- The repository now has a conventional layout: `src/`, `server/`, `scripts/`,
  `tests/`, `docs/`, `assets/`. The build produces a self-contained `dist/`
  folder with the page and the server. ([#1])
- The server file is renamed `salt_sync_server.py`, and the page is served at
  `/` and `/index.html`. The old `/Salt%20Report%20Workbench.html` path still
  works. ([#1])
- The build now fails, rather than shipping a broken page, when the stylesheet
  link or script tag it inlines is missing. ([#1])

### Added

- Brand identity: logo, monochrome variants, avatar, README banners, social
  preview, and an inline favicon. ([#1])
- A 53-test suite covering merge rules, backup round trips, validation, rate
  limiting, access control, and live HTTP behavior. ([#1])
- CI: lint, tests on Python 3.10–3.13 and on Windows, and a build smoke test. ([#1])
- Ruff, pre-commit, EditorConfig, and a Makefile. ([#1])
- README, architecture notes, and contributing, security, and conduct guides. ([#1])

## [2.0.0] - 2026-10-24

First version under version control: SALT logging with real-time LAN sync over
Server-Sent Events, offline mode, edit history with restore, workspaces, a
read-only viewer port, a per-launch access code, the report builder (SALT and
SALT-U presets, custom fields with their own table columns), BDA tracking with a
pre-paired checklist, and backup, CSV, and MTI exports.

[Unreleased]: https://github.com/MaymiPR/salt-report-workbench/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/MaymiPR/salt-report-workbench/releases/tag/v2.0.0
[#1]: https://github.com/MaymiPR/salt-report-workbench/pull/1

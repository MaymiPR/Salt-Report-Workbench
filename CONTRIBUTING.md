# Contributing

Thanks for helping improve S.A.L.T. Report Workbench. This guide covers how to
get set up and what a change needs before it merges.

## Ground rules

- **No runtime dependencies.** The server must run on a stock Python 3.10+
  install, and the page must work from a single file with no network. If a
  change needs a third-party package or a CDN, open an issue to discuss it
  first. Dev tools such as ruff and pre-commit are fine.
- **Don't break offline use.** Every feature should still work in local mode
  (opening `dist/index.html` directly) or degrade clearly.
- **Never commit report data.** `Auto Backups/` is git-ignored for a reason.

## Setup

```bash
git clone https://github.com/MaymiPR/SaltReportWorkbench.git
cd SaltReportWorkbench
pip install ruff==0.17.2 pre-commit   # optional, but CI runs both
pre-commit install
```

## Workflow

1. Create a branch from `main`, named for the change: `fix/unload-persistence`,
   `feat/bda-rollup`.
2. Edit the sources in `src/` and `server/`. Never edit `dist/`; it's generated.
3. Build and try it:

   ```bash
   python scripts/build.py
   python dist/salt_sync_server.py
   ```

4. Run the checks:

   ```bash
   python -m unittest discover -s tests
   ruff check . && ruff format --check .
   ```

   `make check` does all of this on macOS and Linux.
5. Update the in-app user manual in `src/index.html` if behavior a user can see
   changed, and add an entry under *Unreleased* in [CHANGELOG.md](CHANGELOG.md).
6. Open a pull request. CI must pass before merging.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
fix(server): persist workspace unloads immediately

Unload changed memory only, so the removal reached disk whenever some
unrelated later write happened to trigger a save.
```

Common types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`,
`build`, `ci`, `chore`. Use the body to explain *why*.

## Code style

- **Python:** ruff handles linting and formatting (config in `pyproject.toml`).
  Type-annotate new functions. Comments should explain why something is done,
  not restate what the code does.
- **JavaScript and CSS:** match the surrounding code. Four-space indentation,
  `const` by default, and no frameworks. `.editorconfig` covers whitespace.

## Tests

Tests use the standard library's `unittest`, so they run anywhere Python does.
Add a test for any server behavior you change. For a bug fix, add a test that
fails without your fix first. `tests/test_server.py` shows how to run real HTTP
requests against a live server on an ephemeral port.

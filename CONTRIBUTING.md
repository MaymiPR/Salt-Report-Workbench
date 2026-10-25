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

## License of contributions

The project is licensed under AGPL-3.0-only. By submitting a contribution,
you agree that it is licensed under the same terms.

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
   node --test tests/js/core.test.js
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
  The page's code is `src/core.js` (pure logic) plus the ordered scripts in
  `src/app/`, which are plain top-level scripts sharing one global scope:
  a name declared in `10-state.js` is visible in every later file, and the
  build inlines them in the order `index.html` lists them. Put a new piece of
  logic in `core.js` when it needs no DOM, and in the `app/` file whose name
  matches what it does.

## Tests

Server, build, and launcher tests use the standard library's `unittest`, so
they run anywhere Python does. The page's pure logic lives in `src/core.js`
(no DOM, storage, or network) and is tested with Node's built-in runner in
`tests/js/`; put new logic there when it can be, and test it. Add a test for
any server behavior you change. For a bug fix, add a test that
fails without your fix first. `tests/test_server.py` shows how to run real HTTP
requests against a live server on an ephemeral port.

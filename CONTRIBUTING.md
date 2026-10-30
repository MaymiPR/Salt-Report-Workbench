# Contributing

Thanks for helping improve S.A.L.T. Report Workbench. This guide covers how to
get set up and what a change needs before it merges.

## Ground rules

- **No runtime dependencies.** The server must run on a stock Python 3.10+
  install, and the page must work from a single file with no network. If a
  change needs a third-party package or a CDN, open an issue to discuss it
  first. Dev tools such as ruff and pre-commit are fine.
  (They need Python 3.11 or newer: pre-commit 4.7 dropped 3.10. Python
  3.10 itself reached end of life on 2026-10-01; the 3.10 floor stays for
  operators with a stock install until their machines have a newer Python.)
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
pip install --require-hashes -r requirements-dev.txt       # optional: ruff, pre-commit
pre-commit install
pip install --require-hashes -r requirements-browser.txt   # optional: the browser tests
python -m playwright install chromium
```

`make setup` and `make setup-browser` do the same on macOS and Linux. Without
Playwright the browser tests are skipped; CI runs them, on Linux and Windows.

The development tools are pinned to exact versions and their hashes, in
`requirements-dev.txt` and `requirements-browser.txt`, so everyone (and CI)
runs the same ruff and Playwright, and a changed package fails the install.
To change one, edit its `requirements-*.in` and regenerate with
`pip-compile --generate-hashes --strip-extras --allow-unsafe requirements-dev.in`
(from `pip install pip-tools`, on Python 3.15); Dependabot proposes updates
monthly. The pre-commit hooks are pinned to commits, and CI's Node to
`.node-version`.

## Workflow

1. Create a branch from `main`, named for the change: `fix/unload-persistence`,
   `feat/bda-rollup`.
2. Edit the sources in `src/` and `server/`. Never edit `dist/`; it's generated.
3. Build and try it:

   ```bash
   python scripts/build.py
   python dist/salt_sync_server.py --backup-dir .dev-data
   ```

   `--backup-dir .dev-data` (git-ignored) keeps your test reports, snapshots
   and the TLS key out of `dist/`, so `make clean` or deleting `dist/` never
   takes them. `make run` does the same.

4. Run the checks:

   ```bash
   python -m unittest discover -s tests
   node --test tests/js/core.test.js
   ruff check . && ruff format --check .
   ```

   `make check` does all of this on macOS and Linux: most of what CI runs (not
   the built-server smoke test).
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
  The page's code is the core in `src/core/` (pure logic) plus the ordered
  scripts in `src/app/`, which are plain top-level scripts sharing one global
  scope: a name declared in `10-state.js` is visible in every later file, and
  the build inlines them in the order `index.html` lists them. Their numbers
  rise in that order (a new file takes a free number between its
  neighbours), and no top-level name may be declared in two of them;
  `tests/test_build.py` checks both. The core's parts are one function in
  pieces (`00-head.js` opens it, `90-exports.js`
  lists what `SaltCore` exports and closes it): the build joins them in name
  order, with a newline between parts, where `index.html` has
  `<script src="core.js">`, and `tests/js/load-core.js` joins them the same
  way for the Node tests. A name declared in one part is visible in every
  other, and there is no `src/core.js` (the build stops if one appears). Put
  a new piece of logic in the core part whose name matches it when it needs no
  DOM (and add it to `SaltCore` if the page or tests use it), and in the
  `app/` file whose name matches what it does otherwise.

**Pull request titles** read `type(optional scope): summary`, with the type one
of feat, fix, refactor, docs, test, chore, ci, build, perf, style, a11y or
revert: a squash merge makes the title the commit on `main`, and a check
fails a title that doesn't.

**Releases** start with `python scripts/bump.py X.Y.Z` (or `make release
VERSION=X.Y.Z`), which writes the version everywhere it appears and dates the
CHANGELOG's Unreleased section. Merge that, then push an annotated tag
(`git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`): the Release workflow
builds the downloads from the tag, publishes them with the CHANGELOG section as
the notes, and checks what it published.

**Renames go in a pull request of their own,** with nothing else in it. Once
it is merged, add its commit to `.git-blame-ignore-revs`, so `git blame` skips
it and still shows who last really changed each line. GitHub's blame view
reads that file; on your own machine, run once:
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

## Tests

`python -m unittest discover -s tests` runs the server, build, pack, release,
launcher, docs and browser tests. They use the standard library's `unittest`,
so all but the browser tests run anywhere Python does. The build, release and
browser tests build into temporary folders, so they leave your `dist/` alone.
The page's pure logic lives in `src/core/` (no DOM, storage, or network)
and is tested with Node's built-in runner in `tests/js/`; put new logic there
when it can be, and test it. The DOM layer
in `src/app/` is covered by `tests/test_browser.py`, which drives the built
page in Chromium through Playwright (`pip install playwright && playwright
install chromium`); it is skipped when Playwright isn't installed, and CI
runs it. Add a test for any server behavior you change, and a browser test
for a change in what the page does. For a bug fix, add a test that fails
without your fix first. `tests/test_server.py` shows how to run real HTTP
requests against a live server on an ephemeral port.

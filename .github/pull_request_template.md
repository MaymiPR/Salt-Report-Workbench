<!-- Title: type(optional scope): summary, e.g. "fix: the map keeps its zoom".
     Types: feat, fix, refactor, docs, test, chore, ci, build, perf, style, a11y, revert. -->

## What and why

<!-- What does this change, and what problem does it solve? -->

## How it was tested

<!-- Commands run, scenarios tried (editor, viewer, local mode). -->

## Checklist

- [ ] `python -m unittest discover -s tests` and `node --test tests/js/core.test.js` pass
- [ ] `ruff check .` and `ruff format --check .` pass
- [ ] Built with `python scripts/build.py` and tried it in a browser
- [ ] Updated the in-app user manual if user-visible behavior changed
- [ ] Added an entry under *Unreleased* in `CHANGELOG.md`
- [ ] No runtime dependencies added, and no report data committed

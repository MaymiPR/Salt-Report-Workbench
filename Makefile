# Convenience targets for POSIX shells. On Windows, run the commands directly
# (see README) - everything here is plain `python`.
PY ?= python

.PHONY: help setup setup-browser build run test lint format check clean

help:  ## List targets
	@grep -E '^[a-z][a-z-]*:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

setup:  ## Install dev tools (the app itself needs none)
	$(PY) -m pip install ruff==0.17.2 pre-commit
	pre-commit install

build:  ## Bundle src/ into a runnable dist/
	$(PY) scripts/build.py

# Live data (backups, snapshots, the TLS key) goes to .dev-data/, not
# dist/Auto Backups, so `make clean` never deletes it.
run: build  ## Build, then start the server (data in .dev-data/)
	$(PY) dist/salt_sync_server.py --backup-dir .dev-data

test:  ## Run the test suites (Python, then JavaScript; browser tests if Playwright is installed)
	$(PY) -m unittest discover -s tests
	node --test tests/js/core.test.js

setup-browser:  ## Install Playwright and a Chromium for the browser tests
	$(PY) -m pip install playwright
	$(PY) -m playwright install chromium

lint:  ## Lint Python and syntax-check the JavaScript
	ruff check .
	ruff format --check .
	node -e "require('./tests/js/load-core.js')"
	for f in src/app/*.js; do node --check "$$f" || exit 1; done

format:  ## Auto-format Python
	ruff format .
	ruff check --fix .

check: lint test build  ## Most of what CI runs (not the built-server smoke test)

clean:  ## Remove build output and caches (never .dev-data/)
	rm -rf dist .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

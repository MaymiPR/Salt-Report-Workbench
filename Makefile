# Convenience targets for POSIX shells. On Windows, run the commands directly
# (see README) - everything here is plain `python`.
PY ?= python

.PHONY: help setup build run test lint format check clean

help:  ## List targets
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-8s %s\n", $$1, $$2}'

setup:  ## Install dev tools (the app itself needs none)
	$(PY) -m pip install ruff==0.17.2 pre-commit
	pre-commit install

build:  ## Bundle src/ into a runnable dist/
	$(PY) scripts/build.py

run: build  ## Build, then start the server
	$(PY) dist/salt_sync_server.py

test:  ## Run the test suites (Python, then JavaScript)
	$(PY) -m unittest discover -s tests
	node --test tests/js/core.test.js

lint:  ## Lint Python and syntax-check the JavaScript
	ruff check .
	ruff format --check .
	node --check src/core.js
	node --check src/app.js

format:  ## Auto-format Python
	ruff format .
	ruff check --fix .

check: lint test build  ## Everything CI runs

clean:  ## Remove build output and caches
	rm -rf dist .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

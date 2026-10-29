#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
r"""Set the version everywhere it is written down, for a release.

    python scripts/bump.py 2.24.0 [--date 2026-10-28]

Writes the new version into pyproject.toml, the README badge, the INSTALL.md
.txt example, the manual's footer (major.minor), APP_VERSION in the server and
the page, and dates the CHANGELOG: the Unreleased section becomes the new
version's, with its compare link. tests/test_docs.py checks they all agree.
Refuses a version that isn't newer, or an empty Unreleased section.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "https://github.com/MaymiPR/SaltReportWorkbench"
VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def current_version(root: Path = ROOT) -> str:
    text = (root / "pyproject.toml").read_text(encoding="utf-8")
    return re.search(r'^version = "([^"]+)"$', text, re.MULTILINE)[1]


def _replace(texts: dict, path: Path, pattern: str, repl: str) -> None:
    """Replace ``pattern`` exactly once in ``path``'s text (held in ``texts``
    until every replacement has worked), or fail."""
    if path not in texts:
        texts[path] = path.read_bytes().decode("utf-8")
    texts[path], n = re.subn(pattern, repl, texts[path], flags=re.MULTILINE)
    if n != 1:
        raise ValueError(f"{path.name}: expected one match of {pattern!r}, found {n}")


def bump(new: str, today: str, root: Path = ROOT) -> str:
    """Write version ``new`` everywhere, dated ``today``; return the old one."""
    old = current_version(root)
    if not VERSION.fullmatch(new):
        raise ValueError(f"{new!r} is not a version like 2.24.0")
    if tuple(map(int, new.split("."))) <= tuple(map(int, old.split("."))):
        raise ValueError(f"{new} is not newer than {old}")
    changelog = root / "CHANGELOG.md"
    unreleased = re.search(
        r"^## \[Unreleased\]\n(.*?)^## \[", changelog.read_text(encoding="utf-8"), re.S | re.M
    )
    if not unreleased or not unreleased[1].strip():
        raise ValueError("CHANGELOG.md has nothing under [Unreleased] to release")
    texts: dict = {}
    o, n = re.escape(old), new
    minor_old, minor_new = re.escape(".".join(old.split(".")[:2])), ".".join(new.split(".")[:2])
    _replace(texts, root / "pyproject.toml", rf'^version = "{o}"$', f'version = "{n}"')
    _replace(
        texts,
        root / "README.md",
        rf'version-{o}-0A84FF" alt="Version {o}"',
        f'version-{n}-0A84FF" alt="Version {n}"',
    )
    _replace(
        texts,
        root / "docs" / "INSTALL.md",
        rf"SALT-Workbench-v{o}\.txt",
        f"SALT-Workbench-v{n}.txt",
    )
    _replace(
        texts,
        root / "src" / "index.html",
        rf"Version {minor_old} &middot;",
        f"Version {minor_new} &middot;",
    )
    _replace(
        texts,
        root / "server" / "salt_sync_server.py",
        rf"^APP_VERSION = '{o}'$",
        f"APP_VERSION = '{n}'",
    )
    _replace(
        texts,
        root / "src" / "app" / "10-state.js",
        rf"^const APP_VERSION = '{o}';$",
        f"const APP_VERSION = '{n}';",
    )
    _replace(texts, changelog, r"^## \[Unreleased\]\n", f"## [Unreleased]\n\n## [{n}] - {today}\n")
    _replace(
        texts,
        changelog,
        rf"^\[Unreleased\]: {re.escape(REPO)}/compare/v{o}\.\.\.HEAD$",
        f"[Unreleased]: {REPO}/compare/v{n}...HEAD\n[{n}]: {REPO}/compare/v{old}...v{n}",
    )
    # Written only once every replacement has worked: no half-bumped tree.
    for path, text in texts.items():
        path.write_bytes(text.encode("utf-8"))
    return old


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Set the version everywhere for a release.")
    p.add_argument("version", help="the new version, e.g. 2.24.0")
    p.add_argument("--date", default=date.today().isoformat(), help="the release date (today)")
    args = p.parse_args(argv)
    try:
        old = bump(args.version, args.date)
    except ValueError as exc:
        print(f"bump: {exc}", file=sys.stderr)
        return 1
    print(f"{old} -> {args.version}, dated {args.date}. Next: commit, PR, merge, then tag:")
    print(f"  git tag -a v{args.version} -m v{args.version} && git push origin v{args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

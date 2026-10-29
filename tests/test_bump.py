# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/bump.py: the version, everywhere it is written down."""

from __future__ import annotations

import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import bump  # noqa: E402

FILES = (
    "pyproject.toml",
    "README.md",
    "docs/INSTALL.md",
    "src/index.html",
    "server/salt_sync_server.py",
    "src/app/10-state.js",
    "CHANGELOG.md",
)


class BumpTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="salt-bump-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        for name in FILES:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, self.root / name)
        # Something to release, whatever the real Unreleased section holds now.
        log = self.root / "CHANGELOG.md"
        text = log.read_text(encoding="utf-8")
        log.write_text(
            text.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- Something.\n", 1),
            encoding="utf-8",
            newline="\n",
        )
        self.old = bump.current_version(self.root)
        major, minor, _ = map(int, self.old.split("."))
        self.new = f"{major}.{minor + 1}.0"

    def read(self, name):
        return (self.root / name).read_text(encoding="utf-8")

    def test_every_place_gets_the_new_version(self):
        self.assertEqual(bump.bump(self.new, "2030-01-02", self.root), self.old)
        n, minor = self.new, ".".join(self.new.split(".")[:2])
        self.assertIn(f'version = "{n}"', self.read("pyproject.toml"))
        self.assertIn(f'version-{n}-0A84FF" alt="Version {n}"', self.read("README.md"))
        self.assertIn(f"SALT-Workbench-v{n}.txt", self.read("docs/INSTALL.md"))
        self.assertIn(f"Version {minor} &middot;", self.read("src/index.html"))
        self.assertIn(f"APP_VERSION = '{n}'", self.read("server/salt_sync_server.py"))
        self.assertIn(f"const APP_VERSION = '{n}';", self.read("src/app/10-state.js"))
        log = self.read("CHANGELOG.md")
        self.assertIn(
            f"## [Unreleased]\n\n## [{n}] - 2030-01-02\n\n### Fixed\n\n- Something.\n", log
        )
        self.assertIn(f"[Unreleased]: {bump.REPO}/compare/v{n}...HEAD\n", log)
        self.assertIn(f"[{n}]: {bump.REPO}/compare/v{self.old}...v{n}\n", log)
        # And nothing still says the old version where the new one belongs.
        for name in FILES[:-1]:
            self.assertNotRegex(self.read(name), rf"(?<![\d.]){re.escape(self.old)}(?![\d.])", name)

    def test_refuses_an_older_version_or_nothing_to_release(self):
        with self.assertRaisesRegex(ValueError, "not newer"):
            bump.bump(self.old, "2030-01-02", self.root)
        with self.assertRaisesRegex(ValueError, "not a version"):
            bump.bump("3.0", "2030-01-02", self.root)
        log = self.root / "CHANGELOG.md"
        log.write_text(
            # Nothing between Unreleased and the newest release.
            re.sub(
                r"(?ms)^(## \[Unreleased\]\n).*?(?=^## \[)",
                r"\1\n",
                log.read_text(encoding="utf-8"),
                count=1,
            ),
            encoding="utf-8",
            newline="\n",
        )
        with self.assertRaisesRegex(ValueError, "nothing under"):
            bump.bump(self.new, "2030-01-02", self.root)

    def test_a_place_it_cant_find_changes_nothing(self):
        page = self.root / "src/app/10-state.js"
        page.write_text(
            page.read_text(encoding="utf-8").replace("APP_VERSION", "APP_V"),
            encoding="utf-8",
            newline="\n",
        )
        before = {name: self.read(name) for name in FILES}
        with self.assertRaisesRegex(ValueError, "10-state.js"):
            bump.bump(self.new, "2030-01-02", self.root)
        self.assertEqual({name: self.read(name) for name in FILES}, before)


if __name__ == "__main__":
    unittest.main()

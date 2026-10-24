# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for scripts/build.py, the single-file bundler."""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build  # noqa: E402

PAGE = """<!DOCTYPE html>
<html><head>
    <link rel="stylesheet" href="styles.css">
</head><body>
    <script src="app.js"></script>
</body></html>"""


class BundleTests(unittest.TestCase):
    def test_inlines_stylesheet_and_script(self):
        out = build.bundle(PAGE, "body { color: red; }", "console.info(1);")
        self.assertIn("<style>", out)
        self.assertIn("body { color: red; }", out)
        self.assertIn("console.info(1);", out)
        self.assertNotIn('href="styles.css"', out)
        self.assertNotIn('src="app.js"', out)

    def test_backslashes_and_group_references_survive(self):
        # The payload is passed through a lambda precisely so re.sub does not
        # treat "\1" or "\n" in the source as replacement-template syntax.
        js = r'const rx = /(\d+)$/; s.replace(/a(b)/, "\1"); const nl = "\n";'
        out = build.bundle(PAGE, "", js)
        self.assertIn(js, out)

    def test_other_link_tags_are_left_alone(self):
        page = PAGE.replace("<head>", '<head>\n    <link rel="icon" href="data:image/svg+xml,x">')
        out = build.bundle(page, "", "")
        self.assertIn('rel="icon"', out)

    def test_missing_placeholders_fail_the_build(self):
        with self.assertRaisesRegex(ValueError, "stylesheet"):
            build.bundle("<html><script src='a.js'></script></html>", "", "")
        with self.assertRaisesRegex(ValueError, "script"):
            build.bundle('<html><link rel="stylesheet" href="s.css"></html>', "", "")


class MainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-build-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_produces_a_runnable_dist_folder(self):
        with mock.patch.object(build, "DIST", self.tmp / "dist"), mock.patch("builtins.print"):
            self.assertEqual(build.main(), 0)
        html = (self.tmp / "dist" / "index.html").read_text(encoding="utf-8")
        self.assertIn("<style>", html)
        self.assertNotIn('<script src="app.js">', html)
        self.assertTrue((self.tmp / "dist" / "salt_sync_server.py").is_file())

    def test_missing_source_returns_nonzero(self):
        with mock.patch.object(build, "SRC_JS", self.tmp / "nope.js"), mock.patch("builtins.print"):
            self.assertEqual(build.main(), 1)


if __name__ == "__main__":
    unittest.main()

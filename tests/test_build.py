# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/build.py, the single-file bundler."""

from __future__ import annotations

import shutil
import subprocess
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
        out = build.bundle(PAGE, "body { color: red; }", {"app.js": "console.info(1);"})
        self.assertIn("<style>", out)
        self.assertIn("body { color: red; }", out)
        self.assertIn("console.info(1);", out)
        self.assertNotIn('href="styles.css"', out)
        self.assertNotIn('src="app.js"', out)

    def test_backslashes_and_group_references_survive(self):
        # The payload is passed through a lambda precisely so re.sub does not
        # treat "\1" or "\n" in the source as replacement-template syntax.
        js = r'const rx = /(\d+)$/; s.replace(/a(b)/, "\1"); const nl = "\n";'
        out = build.bundle(PAGE, "", {"app.js": js})
        self.assertIn(js, out)

    def test_other_link_tags_are_left_alone(self):
        page = PAGE.replace("<head>", '<head>\n    <link rel="icon" href="data:image/svg+xml,x">')
        out = build.bundle(page, "", {"app.js": ""})
        self.assertIn('rel="icon"', out)

    def test_every_script_is_inlined_in_page_order(self):
        page = PAGE.replace(
            '<script src="app.js"></script>',
            '<script src="core.js"></script>\n    <script src="app.js"></script>',
        )
        self.assertEqual(build.script_sources(page), ["core.js", "app.js"])
        out = build.bundle(page, "", {"core.js": "var CORE = 1;", "app.js": "use(CORE);"})
        self.assertLess(out.index("var CORE = 1;"), out.index("use(CORE);"))
        self.assertNotIn("<script src", out)

    def test_missing_placeholders_fail_the_build(self):
        with self.assertRaisesRegex(ValueError, "stylesheet"):
            build.bundle("<html><script src='a.js'></script></html>", "", {"a.js": ""})
        with self.assertRaisesRegex(ValueError, "script"):
            build.bundle('<html><link rel="stylesheet" href="s.css"></html>', "", {})
        with self.assertRaisesRegex(ValueError, "b.js"):
            build.bundle(PAGE.replace("app.js", "b.js"), "", {"app.js": ""})


class CoreTests(unittest.TestCase):
    """The page's core is the parts in src/core/, joined in name order."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-core-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_parts_join_in_name_order_with_newlines(self):
        (self.tmp / "20-b.js").write_bytes(b"const b = a;\n")
        (self.tmp / "10-a.js").write_bytes(b"const a = 1;\n")
        (self.tmp / "notes.txt").write_bytes(b"not a part\n")
        (self.tmp / "30-dir.js").mkdir()
        self.assertEqual(build.core_source(self.tmp), "const a = 1;\n\nconst b = a;\n")

    def test_no_parts_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "no parts"):
            build.core_source(self.tmp)
        with self.assertRaisesRegex(ValueError, "no parts"):
            build.core_source(self.tmp / "gone")

    def test_the_core_is_its_parts_concatenated(self):
        parts = sorted(build.CORE_DIR.glob("*.js"), key=lambda p: p.name)
        self.assertGreater(len(parts), 1)
        texts = [p.read_bytes().decode("utf-8") for p in parts]
        self.assertEqual(build.core_source(), "\n".join(texts))
        # One function split in pieces: the first part opens it, the last
        # closes it, and every part says so under its licence line.
        self.assertIn("(function (root) {", texts[0])
        self.assertTrue(
            texts[-1].endswith("})(typeof globalThis !== 'undefined' ? globalThis : this);\n")
        )
        for part, text in zip(parts, texts, strict=True):
            lines = text.split("\n")
            self.assertEqual(lines[0], "// SPDX-License-Identifier: AGPL-3.0-only", part.name)
            self.assertIn("in name order inside one function", lines[1], part.name)
            self.assertRegex(part.name, r"^\d\d-[a-z]+\.js$")

    def test_node_joins_the_parts_the_same_way(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        result = subprocess.run(
            [node, str(ROOT / "tests" / "js" / "load-core.js")],
            capture_output=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(result.stdout.decode("utf-8"), build.core_source())

    def test_the_page_gets_the_joined_core(self):
        with mock.patch.object(build, "DIST", self.tmp / "dist"), mock.patch("builtins.print"):
            self.assertEqual(build.main(), 0)
        html = (self.tmp / "dist" / "index.html").read_text(encoding="utf-8")
        self.assertIn(f"    <script>\n{build._indent(build.core_source())}\n    </script>", html)

    def test_a_stale_core_js_fails_the_build(self):
        stale = self.tmp / "core.js"
        stale.write_text("// old\n", encoding="utf-8")
        with (
            mock.patch.object(build, "STALE_CORE", stale),
            mock.patch.object(build, "DIST", self.tmp / "dist"),
            mock.patch("builtins.print") as out,
        ):
            self.assertEqual(build.main(), 1)
        self.assertIn("stale", " ".join(str(c) for c in out.call_args_list))
        self.assertFalse((self.tmp / "dist").exists())

    def test_a_missing_core_fails_the_build(self):
        with (
            mock.patch.object(build, "CORE_DIR", self.tmp / "empty"),
            mock.patch.object(build, "DIST", self.tmp / "dist"),
            mock.patch("builtins.print"),
        ):
            self.assertEqual(build.main(), 1)
        self.assertFalse((self.tmp / "dist").exists())


class MainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-build-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_produces_a_runnable_dist_folder(self):
        with mock.patch.object(build, "DIST", self.tmp / "dist"), mock.patch("builtins.print"):
            self.assertEqual(build.main(), 0)
        html = (self.tmp / "dist" / "index.html").read_text(encoding="utf-8")
        self.assertIn("<style>", html)
        self.assertNotIn("<script src=", html)
        self.assertIn("SaltCore", html)
        self.assertTrue((self.tmp / "dist" / "salt_sync_server.py").is_file())
        launcher = (self.tmp / "dist" / build.LAUNCHER.name).read_bytes()
        self.assertIn(b"salt_sync_server.py", launcher)
        # cmd.exe needs CRLF; every line must end in one, none in a bare LF.
        self.assertEqual(launcher.count(b"\n"), launcher.count(b"\r\n"))

    def test_builds_into_the_folder_it_is_given(self):
        # The tests and release.py --dist use this, so a developer's own dist/
        # is never overwritten behind their back.
        out = self.tmp / "elsewhere" / "dist"
        with mock.patch.object(build, "DIST", self.tmp / "default"), mock.patch("builtins.print"):
            self.assertEqual(build.main(out), 0)
        self.assertEqual(
            sorted(p.name for p in out.iterdir()),
            sorted(["index.html", "salt_sync_server.py", build.LAUNCHER.name]),
        )
        self.assertFalse((self.tmp / "default").exists(), "the default dist/ is untouched")

    def test_the_command_line_takes_dist(self):
        out = self.tmp / "cli"
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build.py"), "--dist", str(out)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((out / "index.html").is_file())

    def test_missing_source_returns_nonzero(self):
        with (
            mock.patch.object(build, "SRC_CSS", self.tmp / "nope.css"),
            mock.patch("builtins.print"),
        ):
            self.assertEqual(build.main(), 1)

    def test_missing_script_returns_nonzero(self):
        page = self.tmp / "index.html"
        page.write_text(PAGE.replace("app.js", "gone.js"), encoding="utf-8")
        with (
            mock.patch.object(build, "SRC_HTML", page),
            mock.patch.object(build, "DIST", self.tmp / "dist"),
            mock.patch("builtins.print"),
        ):
            self.assertEqual(build.main(), 1)


if __name__ == "__main__":
    unittest.main()

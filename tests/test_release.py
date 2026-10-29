# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/release.py: the zip, the one-file .txt, one checksum file."""

from __future__ import annotations

import contextlib
import hashlib
import io
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import pack  # noqa: E402
import release  # noqa: E402

CHANGELOG = """# Changelog

## [Unreleased]

## [1.1.0] - 2026-01-02

### Added

- **A thing.** It does
  what it says.

### Fixed

- A bug.

## [1.0.0] - 2026-01-01

### Added

- Everything.

[Unreleased]: https://example.test/compare/v1.1.0...HEAD
[1.1.0]: https://example.test/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.test/releases/tag/v1.0.0
"""


def _snapshot(folder: Path) -> dict[str, int]:
    """Every file under ``folder`` and its modification time, to tell it was left alone."""
    if not folder.is_dir():
        return {}
    return {str(p.relative_to(folder)): p.stat().st_mtime_ns for p in folder.rglob("*")}


def fake_git(status: str = "", described: str | None = None, tags: str = ""):
    """A stand-in for ``release._git`` that answers the three questions it is asked."""

    def run(*args: str) -> subprocess.CompletedProcess:
        if args[0] == "status":
            return subprocess.CompletedProcess(args, 0, status, "")
        if args[0] == "describe":
            if described is None:
                return subprocess.CompletedProcess(args, 128, "", "fatal: no tag exactly matches")
            return subprocess.CompletedProcess(args, 0, described + "\n", "")
        if args[0] == "tag":
            return subprocess.CompletedProcess(args, 0, tags, "")
        raise AssertionError(f"unexpected git call: {args}")

    return run


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="salt-release-"))
        cls.addClassCleanup(shutil.rmtree, cls.tmp, ignore_errors=True)
        cls.version = release.project_version()
        cls.name = f"SaltReportWorkbench-v{cls.version}"
        cls.dist = cls.tmp / "dist"
        cls.dev_dist_before = _snapshot(ROOT / "dist")
        for out in ("a", "b"):
            with contextlib.redirect_stdout(io.StringIO()):
                code = release.main(
                    [
                        cls.version,
                        "-o",
                        str(cls.tmp / out),
                        "--dist",
                        str(cls.dist),
                        "--notes",
                        str(cls.tmp / f"notes-{out}.md"),
                        "--allow-dirty",  # the tests run from a working tree, not a tag
                    ]
                )
            if code != 0:
                raise RuntimeError(f"release.main returned {code} building into {out}/")

    def test_one_checksum_file_covers_both_downloads(self):
        out = self.tmp / "a"
        sums = (out / "SHA256SUMS.txt").read_bytes()
        self.assertNotIn(b"\r", sums, "LF only, or sha256sum -c refuses it")
        lines = sums.decode().splitlines()
        self.assertEqual(
            [line.split("  ")[1] for line in lines],
            [f"{self.name}.zip", f"SALT-Workbench-v{self.version}.txt"],
        )
        for line in lines:
            digest, name = line.split("  ")
            self.assertEqual(hashlib.sha256((out / name).read_bytes()).hexdigest(), digest, name)

    def test_the_zip_is_the_same_bytes_on_any_machine(self):
        # Built on Windows, it said so in every entry (and the page had CRLF
        # line ends), so the release workflow's Linux build differed.
        with zipfile.ZipFile(self.tmp / "a" / f"{self.name}.zip") as zf:
            self.assertEqual({i.create_system for i in zf.infolist()}, {3})
            page = zf.read(f"{self.name}/index.html")
        self.assertNotIn(b"\r\n", page)

    def test_the_txt_holds_exactly_the_zips_files(self):
        out = self.tmp / "a"
        with zipfile.ZipFile(out / f"{self.name}.zip") as zf:
            self.assertEqual(
                sorted(zf.namelist()),
                [
                    f"{self.name}/{n}"
                    for n in sorted(release.release_files(self.version, self.dist))
                ],
            )
        packed = (out / f"SALT-Workbench-v{self.version}.txt").read_text("ascii")
        self.assertEqual(
            packed, pack.pack(pack.files_from_zip(out / f"{self.name}.zip"), self.version)
        )

    def test_the_real_txt_unpacks_to_the_zips_files(self):
        # Run the release's own .txt, as an operator would, in a folder of its own.
        here = self.tmp / "unpack"
        here.mkdir()
        txt = here / f"SALT-Workbench-v{self.version}.txt"
        shutil.copy2(self.tmp / "a" / txt.name, txt)
        result = subprocess.run(
            [sys.executable, str(txt), "--keep"],
            cwd=here,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(txt.exists(), "--keep keeps the packed file")
        folder = here / "SALT Report Workbench"
        expected = pack.files_from_zip(self.tmp / "a" / f"{self.name}.zip")
        self.assertEqual(sorted(p.name for p in folder.iterdir()), sorted(expected))
        for name, data in expected.items():
            self.assertEqual((folder / name).read_bytes(), data, name)

    def test_rebuilding_gives_identical_files(self):
        for f in (self.tmp / "a").iterdir():
            self.assertEqual(f.read_bytes(), (self.tmp / "b" / f.name).read_bytes(), f.name)

    def test_the_developers_dist_is_left_alone(self):
        self.assertTrue((self.dist / "index.html").is_file(), "built into --dist")
        self.assertEqual(_snapshot(ROOT / "dist"), self.dev_dist_before)

    def test_the_notes_are_the_changelog_section_and_its_compare_link(self):
        notes = (self.tmp / "notes-a.md").read_bytes()
        self.assertFalse(notes.startswith(b"\xef\xbb\xbf"), "no BOM")
        self.assertNotIn(b"\r", notes, "LF only")
        text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertEqual(notes.decode("utf-8"), release.changelog_notes(self.version, text))
        self.assertTrue(notes.startswith(b"### "), notes[:40])
        self.assertRegex(
            notes.decode("utf-8"),
            r"\n\n\*\*Full changelog:\*\* https://github\.com/\S+\n\Z",
        )

    def test_the_version_must_match_the_project(self):
        with (
            contextlib.redirect_stderr(io.StringIO()) as err,
            self.assertRaises(SystemExit),
        ):
            release.main(["0.0.0-not-this", "-o", str(self.tmp / "c")])
        self.assertIn("pyproject.toml says", err.getvalue())


class ChangelogNotesTests(unittest.TestCase):
    def test_a_section_without_its_heading_then_the_link(self):
        self.assertEqual(
            release.changelog_notes("1.1.0", CHANGELOG),
            "### Added\n\n- **A thing.** It does\n  what it says.\n\n### Fixed\n\n- A bug.\n"
            "\n**Full changelog:** https://example.test/compare/v1.0.0...v1.1.0\n",
        )

    def test_the_last_section_stops_at_the_links(self):
        self.assertEqual(
            release.changelog_notes("1.0.0", CHANGELOG),
            "### Added\n\n- Everything.\n"
            "\n**Full changelog:** https://example.test/releases/tag/v1.0.0\n",
        )

    def test_a_missing_section_or_link_is_an_error(self):
        with self.assertRaisesRegex(ValueError, r"no ## \[1\.2\.0\] section"):
            release.changelog_notes("1.2.0", CHANGELOG)
        no_link = CHANGELOG.replace("[1.1.0]: https://example.test/compare/v1.0.0...v1.1.0\n", "")
        with self.assertRaisesRegex(ValueError, r"no \[1\.1\.0\]: compare link"):
            release.changelog_notes("1.1.0", no_link)
        # A version that only prefixes another's doesn't count: 1.1 is not 1.1.0.
        with self.assertRaises(ValueError):
            release.changelog_notes("1.1", CHANGELOG)


class CheckoutTests(unittest.TestCase):
    """The release must come from a clean checkout of its tag, unless --allow-dirty."""

    def setUp(self):
        self.version = release.project_version()
        self.tag = f"v{self.version}"
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-release-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def main(self, *extra: str) -> tuple[int | None, str]:
        """Run release.main with build.main stubbed out; (exit code, stderr)."""
        with (
            mock.patch.object(release.build, "main", return_value=1) as built,
            contextlib.redirect_stderr(io.StringIO()) as err,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            try:
                code = release.main([self.version, "-o", str(self.tmp), *extra])
            except SystemExit as exc:
                code = exc.code
                self.assertFalse(built.called, "refused before building")
        return code, err.getvalue()

    def test_a_clean_tagged_checkout_passes(self):
        with mock.patch.object(release, "_git", fake_git(described=self.tag)):
            self.assertEqual(release.checkout_problems(self.version), [])
        # describe names one tag; another on the same commit is fine.
        with mock.patch.object(
            release, "_git", fake_git(described="other", tags=f"other\n{self.tag}\n")
        ):
            self.assertEqual(release.checkout_problems(self.version), [])

    def test_a_dirty_tree_is_refused(self):
        with mock.patch.object(release, "_git", fake_git(" M src/core.js\n", self.tag)):
            code, err = self.main()
        self.assertEqual(code, 2)
        self.assertIn("clean checkout of the release tag", err)
        self.assertIn("working tree has changes", err)
        self.assertIn("src/core.js", err)

    def test_an_untagged_head_is_refused(self):
        for described in (None, "v0.0.1"):
            with mock.patch.object(release, "_git", fake_git(described=described)):
                code, err = self.main()
            self.assertEqual(code, 2)
            self.assertIn(f"HEAD is not tagged {self.tag}", err)

    def test_allow_dirty_skips_the_checks(self):
        with mock.patch.object(release, "_git", fake_git(" M x\n")):
            code, _ = self.main("--allow-dirty")
        self.assertEqual(code, 1, "it went on to build (stubbed to fail)")

    def test_the_changelog_must_have_the_version(self):
        log = self.tmp / "CHANGELOG.md"
        for text, message in (
            (CHANGELOG, f"no ## [{self.version}] section"),
            (
                CHANGELOG.replace("[1.1.0] - 2026-01-02", f"[{self.version}] - 2026-01-02"),
                f"no [{self.version}]: compare link",
            ),
        ):
            log.write_text(text, encoding="utf-8")
            with mock.patch.object(release, "CHANGELOG", log):
                code, err = self.main("--allow-dirty")
            self.assertEqual(code, 2)
            self.assertIn(message, err)


if __name__ == "__main__":
    unittest.main()

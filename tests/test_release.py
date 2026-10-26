# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/release.py: the zip, the one-file .txt, one checksum file."""

from __future__ import annotations

import contextlib
import hashlib
import io
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import pack  # noqa: E402
import release  # noqa: E402


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="salt-release-"))
        cls.version = release.project_version()
        cls.name = f"SaltReportWorkbench-v{cls.version}"
        with contextlib.redirect_stdout(io.StringIO()):
            assert release.main([cls.version, "-o", str(cls.tmp / "a")]) == 0
            assert release.main([cls.version, "-o", str(cls.tmp / "b")]) == 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_one_checksum_file_covers_both_downloads(self):
        out = self.tmp / "a"
        sums = (out / f"{self.name}.sha256").read_bytes()
        self.assertNotIn(b"\r", sums, "LF only, or sha256sum -c refuses it")
        lines = sums.decode().splitlines()
        self.assertEqual(
            [line.split("  ")[1] for line in lines],
            [f"{self.name}.zip", f"SALT-Workbench-v{self.version}.txt"],
        )
        for line in lines:
            digest, name = line.split("  ")
            self.assertEqual(hashlib.sha256((out / name).read_bytes()).hexdigest(), digest, name)

    def test_the_txt_holds_exactly_the_zips_files(self):
        out = self.tmp / "a"
        with zipfile.ZipFile(out / f"{self.name}.zip") as zf:
            self.assertEqual(
                sorted(zf.namelist()),
                [f"{self.name}/{n}" for n in sorted(release.release_files(self.version))],
            )
        packed = (out / f"SALT-Workbench-v{self.version}.txt").read_text("ascii")
        self.assertEqual(
            packed, pack.pack(pack.files_from_zip(out / f"{self.name}.zip"), self.version)
        )

    def test_rebuilding_gives_identical_files(self):
        for f in (self.tmp / "a").iterdir():
            self.assertEqual(f.read_bytes(), (self.tmp / "b" / f.name).read_bytes(), f.name)

    def test_the_version_must_match_the_project(self):
        with (
            contextlib.redirect_stderr(io.StringIO()) as err,
            self.assertRaises(SystemExit),
        ):
            release.main(["0.0.0-not-this", "-o", str(self.tmp / "c")])
        self.assertIn("pyproject.toml says", err.getvalue())


if __name__ == "__main__":
    unittest.main()

# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/pack.py, the one-file self-unpacking release."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import pack  # noqa: E402

LAUNCHER = '@echo off\r\nrem launcher\r\nset "PYTHON_EXE="\r\necho start\r\n'
FILES = {
    "index.html": "<p class='x' data-y=\"z\">caf\u00e9 \u2713 \U0001f600 \\d+ ''' \"\"\"</p>\n"
    + "x" * 1000
    + "\n",
    "salt_sync_server.py": "print('server')\n",
    "Start SALT Workbench.bat": LAUNCHER,
    "LICENSE": "",
    "README.txt": "line one\r\nline two\r\n",
}
BLOBS = {name: text.encode("utf-8") for name, text in FILES.items()}
NAME = "SALT-Workbench-v9.9.9.txt"


class PackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-pack-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.source = pack.pack(BLOBS, "9.9.9")

    def place(self, folder: Path, source: str | None = None) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / NAME
        path.write_text(source or self.source, encoding="ascii", newline="\n")
        return path

    def run_packed(self, path: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(path), *args],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def assert_unpacked(self, folder: Path, expected: dict[str, bytes] = BLOBS):
        for name, data in expected.items():
            self.assertEqual((folder / name).read_bytes(), data, name)
        self.assertEqual(sorted(p.name for p in folder.glob("*.part")), [], "no leftovers")

    def test_the_packed_file_is_short_lined_ascii(self):
        self.source.encode("ascii")  # raises if not
        self.assertLessEqual(max(len(line) for line in self.source.splitlines()), 1100)
        self.assertNotIn("base64", self.source)

    def test_it_unpacks_byte_for_byte_and_deletes_itself(self):
        path = self.place(self.tmp)
        result = self.run_packed(path)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_unpacked(self.tmp / "SALT Report Workbench")
        self.assertFalse(path.exists(), "the packed file deletes itself")
        self.assertIn("double-click", result.stdout, "it says how to start, and starts nothing")
        self.assertEqual(
            sorted(p.name for p in (self.tmp / "SALT Report Workbench").iterdir()),
            sorted(BLOBS),
            "nothing ran: no Auto Backups folder",
        )

    def test_line_endings_changed_in_transfer_do_not_matter(self):
        path = self.place(self.tmp)
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        self.assertEqual(self.run_packed(path).returncode, 0)
        self.assert_unpacked(self.tmp / "SALT Report Workbench")

    def test_keep_leaves_the_packed_file(self):
        path = self.place(self.tmp)
        self.assertEqual(self.run_packed(path, "--keep").returncode, 0)
        self.assertTrue(path.exists())

    def test_a_damaged_packed_file_changes_nothing(self):
        damaged = self.source.replace("print('server')", "print('servxr')")
        self.assertNotEqual(damaged, self.source)
        path = self.place(self.tmp, damaged)
        result = self.run_packed(path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("damaged", result.stdout)
        self.assertTrue(path.exists(), "the packed file is kept")
        self.assertFalse((self.tmp / "SALT Report Workbench").exists(), "nothing written")

    def test_a_failed_write_keeps_the_packed_file(self):
        (self.tmp / "SALT Report Workbench").write_text("in the way", encoding="utf-8")
        path = self.place(self.tmp)
        result = self.run_packed(path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Nothing was deleted", result.stdout)
        self.assertTrue(path.exists())

    def test_an_upgrade_keeps_backups_and_the_python_exe_setting(self):
        folder = self.tmp / "SALT Report Workbench"
        (folder / "Auto Backups").mkdir(parents=True)
        (folder / "Auto Backups" / "ALPHA_Day1.txt").write_text("reports", encoding="utf-8")
        (folder / "index.html").write_text("old page", encoding="utf-8")
        old = LAUNCHER.replace('set "PYTHON_EXE="', 'set "PYTHON_EXE=C:\\Tools\\Py\\python.exe"')
        (folder / "Start SALT Workbench.bat").write_bytes(old.encode("utf-8"))
        self.assertEqual(self.run_packed(self.place(self.tmp)).returncode, 0)
        expected = dict(BLOBS)
        expected["Start SALT Workbench.bat"] = old.encode("utf-8")
        self.assert_unpacked(folder, expected)
        self.assertEqual((folder / "Auto Backups" / "ALPHA_Day1.txt").read_text(), "reports")

    def test_run_from_inside_the_folder_it_unpacks_in_place(self):
        folder = self.tmp / "SALT Report Workbench"
        self.assertEqual(self.run_packed(self.place(folder)).returncode, 0)
        self.assert_unpacked(folder)
        self.assertFalse((folder / "SALT Report Workbench").exists(), "no nested folder")

    def test_main_packs_a_release_zip(self):
        zpath = self.tmp / "SaltReportWorkbench-v9.9.9.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            for name, data in BLOBS.items():
                zf.writestr(f"SaltReportWorkbench-v9.9.9/{name}", data)
        out = self.tmp / "out"
        self.assertEqual(pack.main([str(zpath), "-o", str(out)]), 0)
        self.assertEqual((out / NAME).read_text(encoding="ascii"), self.source)
        checksum = (out / f"{NAME}.sha256").read_bytes()
        self.assertTrue(checksum.endswith(f"  {NAME}\n".encode()), checksum)


if __name__ == "__main__":
    unittest.main()

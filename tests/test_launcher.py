# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for the Windows launcher, server/Start SALT Workbench.bat.

They run the real batch file through cmd.exe, so they only run on Windows.
``--help`` makes the server print its usage and exit instead of serving.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "server" / "Start SALT Workbench.bat"


@unittest.skipUnless(os.name == "nt", "the launcher is a Windows batch file")
class LauncherTests(unittest.TestCase):
    def setUp(self):
        # Run a copy, so the test also proves the launcher finds the server
        # beside itself rather than relying on the working directory.
        self.tmp = Path(tempfile.mkdtemp(prefix="salt launcher "))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        shutil.copy2(ROOT / "server" / "salt_sync_server.py", self.tmp)
        self.bat = self.tmp / LAUNCHER.name
        text = LAUNCHER.read_text(encoding="utf-8")
        self.bat.write_text(text, encoding="utf-8", newline="\r\n")

    def run_launcher(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        full_env = {k: v for k, v in os.environ.items() if k.upper() != "SALT_PYTHON"}
        full_env.update(env)
        return subprocess.run(
            ["cmd.exe", "/c", "call", str(self.bat), *args],
            cwd=tempfile.gettempdir(),
            env=full_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_explicit_python_is_used(self):
        result = self.run_launcher("--help", SALT_PYTHON=sys.executable)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Using Python: {sys.executable}", result.stdout)
        self.assertIn("usage: salt_sync_server", result.stdout)

    def test_edited_python_exe_line_wins(self):
        text = self.bat.read_text(encoding="utf-8")
        edited = text.replace('set "PYTHON_EXE="', f'set "PYTHON_EXE={sys.executable}"', 1)
        self.assertNotEqual(text, edited)
        self.bat.write_text(edited, encoding="utf-8", newline="\r\n")
        result = self.run_launcher("--help", SALT_PYTHON=str(self.tmp / "ignored.exe"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Using Python: {sys.executable}", result.stdout)

    def test_wrong_explicit_python_fails_instead_of_falling_back(self):
        result = self.run_launcher("--help", SALT_PYTHON=str(self.tmp / "missing" / "python.exe"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("Could not use", result.stdout)
        self.assertNotIn("usage:", result.stdout)

    def test_finds_python_on_its_own(self):
        # CI's setup-python and a normal install both put python on PATH.
        result = self.run_launcher("--help")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Using Python:", result.stdout)

    def test_older_python_on_path_is_passed_over(self):
        # A real Python that says it is 3.10 (a venv whose sitecustomize says
        # so), first on PATH and named by a stand-in py launcher too, as on a
        # laptop with an old install. The launcher must test-run it, skip it,
        # and take the next Python on PATH.
        old = self.tmp / "old python"
        subprocess.run(
            [sys.executable, "-m", "venv", "--without-pip", str(old)], check=True, timeout=120
        )
        old_exe = old / "Scripts" / "python.exe"
        site = subprocess.run(
            [str(old_exe), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        ).stdout.strip()
        Path(site, "sitecustomize.py").write_text(
            "import sys\nsys.version_info = (3, 10, 11, 'final', 0)\n", encoding="utf-8"
        )
        (old / "Scripts" / "py.bat").write_text(
            f"@echo {old_exe}\n", encoding="utf-8", newline="\r\n"
        )
        check = "import sys; sys.exit(sys.version_info < (3, 11, 8))"
        self.assertEqual(subprocess.run([str(old_exe), "-c", check], timeout=60).returncode, 1)
        path = os.pathsep.join([str(old_exe.parent), str(Path(sys.executable).parent)])
        result = self.run_launcher("--help", PATH=path + os.pathsep + os.environ["PATH"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Using Python: {sys.executable}", result.stdout)
        self.assertNotIn(str(old_exe), result.stdout)

    def test_missing_server_is_reported(self):
        (self.tmp / "salt_sync_server.py").unlink()
        result = self.run_launcher("--help", SALT_PYTHON=sys.executable)
        self.assertEqual(result.returncode, 1)
        self.assertIn("salt_sync_server.py is missing", result.stdout)


if __name__ == "__main__":
    unittest.main()

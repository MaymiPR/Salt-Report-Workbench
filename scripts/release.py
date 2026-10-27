# SPDX-License-Identifier: AGPL-3.0-only

r"""Build a release in one go: the zip, the one-file .txt, and one checksum file.

    python scripts/release.py 2.6.0 [-o OUT_DIR]

Builds ``dist/``, then writes to OUT_DIR (default ``release/``):

    SaltReportWorkbench-v2.6.0.zip      the five files, in a folder
    SALT-Workbench-v2.6.0.txt           the same five, as one self-unpacking text file
    SHA256SUMS.txt                      both checksums: ``sha256sum -c`` checks both

Run it from a clean checkout of the release tag. Zip entries carry the
commit's timestamp, so rebuilding a tag gives byte-identical files.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build  # noqa: E402
import pack  # noqa: E402

QUICKSTART = """S.A.L.T. Report Workbench {version}
Field-ready SALT reporting with real-time LAN sync.
=====================================================================

REQUIREMENTS
  Python 3.10 or newer, and any modern browser. Nothing else to install.

START THE SERVER
  On Windows, double-click "Start SALT Workbench.bat". No admin rights
  needed. Anywhere else, open a terminal in this folder and run:

      python salt_sync_server.py

  If the launcher can't find Python, or your machine needs a specific
  python.exe, open the launcher in Notepad and put the full path on the
  PYTHON_EXE line near the top:

      set "PYTHON_EXE=C:\\Tools\\Python312\\python.exe"

  The console shows three lines, and your browser opens automatically:

      Workbench   : http://<this-machine>:8080   <- give this to editors
      Access Code : XXXXXXXXXX                   <- and this, read it aloud
      Read Only   : http://<this-machine>:8081   <- give this to observers

  Your own browser fills in the access code for you.

WITHOUT A SERVER
  Double-click index.html. It runs in local mode from your browser's
  storage. Nothing is shared, but logging and exports still work.

YOUR DATA
  Reports are saved continuously to the "Auto Backups" folder created next
  to the server. They are plain text. Handle that folder according to your
  data-handling rules.

SECURITY
  The server uses plain HTTP: reports and the access code cross the network
  unencrypted. Run it only on a network you trust, or over a VPN.

OPTIONS
  python salt_sync_server.py --help

The full user manual is inside the app: the gear (Settings) menu, then
User Manual.
Source: https://github.com/MaymiPR/SaltReportWorkbench
License: GNU AGPL v3 (see LICENSE). If you modify it and run it
for others over a network, you must offer them your modified source.
"""


def release_files(version: str) -> dict[str, bytes]:
    """The five files every release carries, from ``dist/`` and the repo."""
    dist = ROOT / "dist"
    readme = QUICKSTART.format(version=version)
    return {
        "index.html": (dist / "index.html").read_bytes(),
        "salt_sync_server.py": (dist / "salt_sync_server.py").read_bytes(),
        "Start SALT Workbench.bat": (dist / "Start SALT Workbench.bat").read_bytes(),
        "LICENSE": (ROOT / "LICENSE").read_bytes(),
        "README.txt": readme.replace("\n", "\r\n").encode("utf-8"),  # Notepad-friendly
    }


def write_zip(path: Path, version: str, files: dict[str, bytes], stamp: tuple) -> None:
    """A zip with every entry under one folder, dated ``stamp``, in name order."""
    folder = f"SaltReportWorkbench-v{version}"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in sorted(files):
            info = zipfile.ZipInfo(f"{folder}/{name}", date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, files[name])


def commit_stamp() -> tuple:
    """The checked-out commit's time, as a zip date (UTC)."""
    ts = int(subprocess.check_output(["git", "-C", str(ROOT), "log", "-1", "--format=%ct"]).strip())
    return time.gmtime(ts)[:6]


def project_version() -> str:
    m = re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text("utf-8"), re.M)
    return m.group(1) if m else ""


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Build the release zip, one-file .txt, and checksums.")
    p.add_argument("version", help="the version being released, e.g. 2.6.0")
    p.add_argument("-o", "--out", type=Path, default=ROOT / "release", help="output folder")
    args = p.parse_args(argv)
    if args.version != project_version():
        p.error(f"pyproject.toml says {project_version()!r}, not {args.version!r}")
    if build.main() != 0:
        return 1
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    files = release_files(args.version)
    zip_path = out / f"SaltReportWorkbench-v{args.version}.zip"
    write_zip(zip_path, args.version, files, commit_stamp())
    txt_path = out / f"SALT-Workbench-v{args.version}.txt"
    txt_path.write_text(
        pack.pack(pack.files_from_zip(zip_path), args.version), encoding="ascii", newline="\n"
    )
    # One file, both sums. LF: `sha256sum -c` on Linux/macOS rejects CRLF.
    sums = "".join(
        f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}\n" for f in (zip_path, txt_path)
    )
    # The conventional name (as in ChanSampler); .txt so Windows opens it in Notepad.
    sums_path = out / "SHA256SUMS.txt"
    sums_path.write_text(sums, encoding="utf-8", newline="\n")
    for f in (zip_path, txt_path):
        print(f"{f.name}  {f.stat().st_size / 1024:.1f} KB")
    print(f"{sums_path.name}:\n{sums}", end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())

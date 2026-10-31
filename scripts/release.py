# SPDX-License-Identifier: AGPL-3.0-only

r"""Build a release in one go: the zip, the one-file .txt, and one checksum file.

    python scripts/release.py <version> [-o OUT_DIR] [--dist DIR] [--notes FILE]
                                        [--allow-dirty]

Builds ``dist/`` (or ``--dist DIR``), then writes to OUT_DIR (default ``release/``):

    SaltReportWorkbench-v<version>.zip  the five files, in a folder
    SALT-Workbench-v<version>.txt       the same five, as one self-unpacking text file
    SHA256SUMS.txt                      both checksums: ``sha256sum -c`` checks both

Run it from a clean checkout of the release tag: it refuses a working tree with
changes and a HEAD that isn't tagged ``v<version>`` (``--allow-dirty`` skips
both checks, for tests and dry runs). Zip entries carry the commit's timestamp,
so rebuilding a tag gives byte-identical files.

CHANGELOG.md must have a ``## [<version>]`` section and its compare link.
``--notes FILE`` writes the release page's text: that section without its
heading, a blank line, then ``**Full changelog:** <compare link>``.
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

CHANGELOG = ROOT / "CHANGELOG.md"

QUICKSTART = """S.A.L.T. Report Workbench {version}
Field-ready SALT reporting with real-time LAN sync.
=====================================================================

REQUIREMENTS
  Python 3.11.8 or newer, and any modern browser. Nothing else to install.

UPGRADING? COPY YOUR "Auto Backups" FOLDER FIRST
  A new release's zip extracts to a NEW folder named for its version,
  and a new folder starts with an empty "Auto Backups": started from
  there, the workbench shows none of your reports. They are still in the
  old folder. Copy the Auto Backups folder from your old folder into the
  new one before starting (or extract the new files over the old ones).
  The server's certificate is in the "tls" folder inside Auto Backups,
  so copying it keeps the same certificate and browsers don't warn again.
  (The one-file .txt download, run from the same place as before,
  upgrades its folder in place and keeps Auto Backups.)

START THE SERVER
  On Windows, double-click "Start SALT Workbench.bat". No admin rights
  needed. Anywhere else, open a terminal in this folder and run:

      python salt_sync_server.py

  If the launcher can't find Python, or your machine needs a specific
  python.exe, open the launcher in Notepad and put the full path on the
  PYTHON_EXE line near the top:

      set "PYTHON_EXE=C:\\Tools\\Python312\\python.exe"

  The console shows these lines, and your browser opens automatically:

      Workbench   : https://<this-machine>:8080  <- give this to editors
      Access Code : XXXXXXXXXX                   <- and this, read it aloud
      Read Only   : https://<this-machine>:8081  <- give this to observers
      Certificate : the server's fingerprint

  Each browser warns once that the connection isn't private, because the
  server made its own certificate: choose Advanced, then Proceed. Your own
  browser fills in the access code for you.

WITHOUT A SERVER
  Double-click index.html. It runs in local mode from your browser's
  storage. Nothing is shared, but logging and exports still work.

YOUR DATA
  Reports are saved continuously to the "Auto Backups" folder created next
  to the server. They are plain text. Handle that folder according to your
  data-handling rules.

TROUBLESHOOTING
  Firewall prompt: allow Python on Private networks (on a managed laptop,
    IT may need to allow python.exe or ports 8080 and 8081).
  "Could not listen on port": close the other copy, or start with
    --port 9090 --viewer-port 9091 (after the launcher's name works too).
  Browser warns again: the certificate is new (a new address, or Auto
    Backups not copied). Check the fingerprint, then Proceed.
  Reports gone: copy your old Auto Backups folder here (see UPGRADING).
  Change log: Auto Backups/audit.log. Dated copies: Auto Backups/snapshots.

SECURITY
  The server encrypts every connection (HTTPS), so the reports and the access
  code can't be read off the network. To be sure you reached the real server,
  compare the certificate's fingerprint in the browser with the console's.

OPTIONS
  python salt_sync_server.py --help

The full user manual is inside the app: the gear (Settings) menu, then
User Manual.
Source: https://github.com/MaymiPR/SaltReportWorkbench
License: GNU AGPL v3 (see LICENSE). If you modify it and run it
for others over a network, you must offer them your modified source.
"""


def release_files(version: str, dist: Path | None = None) -> dict[str, bytes]:
    """The five files every release carries, from ``dist`` (default ``dist/``) and the repo."""
    dist = Path(dist) if dist is not None else ROOT / "dist"
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
            # Made on Unix, whatever made it (zipfile writes the machine's own
            # otherwise), so a release built anywhere is the same bytes.
            info.create_system = 3
            zf.writestr(info, files[name])


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], capture_output=True, text=True, encoding="utf-8"
    )


def commit_stamp() -> tuple:
    """The checked-out commit's time, as a zip date (UTC)."""
    ts = int(subprocess.check_output(["git", "-C", str(ROOT), "log", "-1", "--format=%ct"]).strip())
    return time.gmtime(ts)[:6]


def checkout_problems(version: str) -> list[str]:
    """Why this checkout isn't a clean checkout of tag ``v<version>``; empty if it is."""
    problems = []
    status = _git("status", "--porcelain")
    if status.returncode != 0:
        problems.append(f"git status failed: {status.stderr.strip()}")
    elif status.stdout.strip():
        problems.append("the working tree has changes:\n" + status.stdout.rstrip())
    tag = f"v{version}"
    found = _git("describe", "--exact-match", "--tags", "HEAD")
    # describe names one tag; a commit with several may still carry this one.
    if found.stdout.strip() != tag and tag not in _git("tag", "--points-at", "HEAD").stdout.split():
        problems.append(f"HEAD is not tagged {tag}")
    return problems


def changelog_notes(version: str, text: str) -> str:
    """The release page for ``version``: its CHANGELOG section without the heading,
    a blank line, then the compare link. Raises ``ValueError`` if either is missing."""
    v = re.escape(version)
    section = re.search(
        rf"^## \[{v}\][^\n]*\n(.*?)(?=^## \[|^\[[^\]\n]+\]: |\Z)", text, re.MULTILINE | re.DOTALL
    )
    link = re.search(rf"^\[{v}\]: (\S+)[ \t]*$", text, re.MULTILINE)
    if not section or not section.group(1).strip():
        raise ValueError(f"CHANGELOG.md has no ## [{version}] section")
    if not link:
        raise ValueError(f"CHANGELOG.md has no [{version}]: compare link")
    body = "\n".join(line.rstrip() for line in section.group(1).strip("\n").splitlines())
    return f"{body}\n\n**Full changelog:** {link.group(1)}\n"


def project_version() -> str:
    m = re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text("utf-8"), re.M)
    return m.group(1) if m else ""


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Build the release zip, one-file .txt, and checksums.")
    p.add_argument("version", help="the version being released, e.g. 2.17.2")
    p.add_argument("-o", "--out", type=Path, default=ROOT / "release", help="output folder")
    p.add_argument(
        "--dist", type=Path, default=ROOT / "dist", help="folder to build into (default: dist/)"
    )
    p.add_argument(
        "--notes", type=Path, metavar="FILE", help="also write the release page's text to FILE"
    )
    p.add_argument(
        "--allow-dirty",
        action="store_true",
        help="skip the clean-tree and release-tag checks (tests and dry runs)",
    )
    args = p.parse_args(argv)
    if args.version != project_version():
        p.error(f"pyproject.toml says {project_version()!r}, not {args.version!r}")
    try:
        notes = changelog_notes(args.version, CHANGELOG.read_text(encoding="utf-8"))
    except ValueError as exc:
        p.error(str(exc))
    if not args.allow_dirty:
        problems = checkout_problems(args.version)
        if problems:
            p.error(
                "run it from a clean checkout of the release tag "
                "(--allow-dirty skips this for a dry run):\n  " + "\n  ".join(problems)
            )
    if build.main(args.dist) != 0:
        return 1
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    files = release_files(args.version, args.dist)
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
    # The conventional name; .txt so Windows opens it in Notepad.
    sums_path = out / "SHA256SUMS.txt"
    sums_path.write_text(sums, encoding="utf-8", newline="\n")
    if args.notes:
        # UTF-8 without a BOM, LF: what `gh release create --notes-file` takes as is.
        args.notes.parent.mkdir(parents=True, exist_ok=True)
        args.notes.write_text(notes, encoding="utf-8", newline="\n")
    for f in (zip_path, txt_path):
        print(f"{f.name}  {f.stat().st_size / 1024:.1f} KB")
    print(f"{sums_path.name}:\n{sums}", end="")
    if args.notes:
        print(f"Release notes: {args.notes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# SPDX-License-Identifier: AGPL-3.0-only

r"""Pack a release zip into one plain-text file that unpacks itself.

For transfer systems that refuse archives and scripts: the result is a single
ASCII text file, ``SALT-Workbench-v<version>.txt``, with a short unpacker at
the top that anyone can read in Notepad, each file's SHA-256, and the files
themselves: compressed with LZMA and written as Base85 text in short lines
(about a quarter the size), or with ``--plain`` as escaped string literals that
can be read line by line (four times larger).

On the other end, Python runs it whatever its extension::

    python "SALT-Workbench-v<version>.txt"

It unpacks into a ``SALT Report Workbench`` folder beside itself, checks every
file against the SHA-256 recorded at pack time, and deletes the packed file.
It starts nothing. If anything fails, the packed file stays. See UNPACKER for
the option and the upgrade behavior.

Usage:  python scripts/pack.py SaltReportWorkbench-v<version>.zip [-o OUT_DIR] [--plain]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import lzma
import re
import sys
import zipfile
from pathlib import Path

# Characters per string literal, before escaping. Keeps every line of the
# packed file short, for transfer tools and editors that dislike long lines.
CHUNK = 100

_ZIP_NAME_RE = re.compile(r"SaltReportWorkbench-v(.+)\.zip")

# The code at the top of the packed file. @VERSION@ is filled in; the files
# follow it, and the entry point comes last so that FILES is complete first.
UNPACKER = '''\
# S.A.L.T. Report Workbench @VERSION@, packed into one plain-text file.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Run it with Python 3.10 or newer. The file name and extension don't matter:
#
#     python "SALT-Workbench-v@VERSION@.txt"
#
# It unpacks the workbench into a "SALT Report Workbench" folder beside this
# file, checks every file against the SHA-256 recorded here, and deletes this
# packed file. It starts nothing. If anything fails, nothing is deleted.
#
# To upgrade, run a newer packed file from the same place (or from inside the
# folder). The app files are replaced, "Auto Backups" is left alone, and a
# PYTHON_EXE path set in the old launcher is kept.
#
#     --keep       keep this packed file after unpacking
#
# @STORAGE@
# Source: https://github.com/MaymiPR/SaltReportWorkbench

import hashlib
import os
import re
import sys
from pathlib import Path

VERSION = '@VERSION@'
FOLDER = 'SALT Report Workbench'
LAUNCHER = 'Start SALT Workbench.bat'
FILES = {}  # name -> text
SHA256 = {}  # name -> SHA-256 of the text as UTF-8
PAYLOAD = []  # the files compressed, as Base85 lines (empty when stored as text)


def load():
    """Fill FILES from PAYLOAD when the files are stored compressed."""
    if not PAYLOAD:
        return
    import base64
    import json
    try:
        import lzma
    except ImportError:
        raise RuntimeError('this Python has no lzma module; use the zip download instead.') from None
    try:
        blob = lzma.decompress(base64.b85decode(''.join(PAYLOAD)))
        size = int.from_bytes(blob[:4], 'big')
        data = blob[4 + size:]
        for name, (start, length) in json.loads(blob[4:4 + size]).items():
            FILES[name] = data[start:start + length].decode('utf-8')
    except (ValueError, lzma.LZMAError):
        raise RuntimeError('the packed data is damaged.') from None


def keep_python_exe(text, old_launcher):
    """Carry a PYTHON_EXE path set in an existing launcher into the new one."""
    try:
        old = old_launcher.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return text
    m = re.search(r'^set "PYTHON_EXE=([^"\\r\\n]+)"', old, re.MULTILINE)
    if not m:
        return text
    return text.replace('set "PYTHON_EXE="', 'set "PYTHON_EXE=' + m.group(1) + '"', 1)


def unpack(here):
    """Check every file, then write and re-read each one. Returns the folder."""
    load()
    if set(FILES) != set(SHA256):
        raise RuntimeError('the packed data is damaged.')
    for name, text in FILES.items():
        if hashlib.sha256(text.encode('utf-8')).hexdigest() != SHA256[name]:
            raise RuntimeError(f'{name} is damaged inside the packed file.')
    target = here.parent if here.parent.name == FOLDER else here.parent / FOLDER
    if any(target / name == here for name in FILES):
        raise RuntimeError('the packed file has the name of a file it holds.')
    target.mkdir(exist_ok=True)
    for name, text in FILES.items():
        dest = target / name
        if name == LAUNCHER and dest.exists():
            text = keep_python_exe(text, dest)
        data = text.encode('utf-8')
        part = dest.with_name(dest.name + '.part')
        part.write_bytes(data)
        os.replace(part, dest)
        if dest.read_bytes() != data:
            raise RuntimeError(f'{name} did not read back as written.')
    return target


def main(argv):
    print(f' S.A.L.T. Report Workbench {VERSION}')
    if sys.version_info < (3, 10):
        print('[!] The workbench needs Python 3.10 or newer. Nothing was changed.')
        return 1
    keep = '--keep' in argv
    here = Path(__file__).resolve()
    try:
        target = unpack(here)
    except (OSError, RuntimeError) as exc:
        print(f'[!] Could not unpack: {exc}')
        print(f'[!] Nothing was deleted; {here.name} is still here.')
        return 1
    print(f'[+] Unpacked and checked {len(FILES)} files in "{target}".')
    if not keep:
        try:
            here.unlink()
            print(f'[+] Deleted {here.name}.')
        except OSError as exc:
            print(f'[!] Could not delete {here.name} ({exc}); delete it by hand.')
    print(f'[+] To start the workbench, double-click "{LAUNCHER}" in that folder.')
    return 0

'''

ENTRY = """
if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
"""


def _literal_lines(text: str) -> list[str]:
    """``text`` as a list of ASCII-only Python string literals, one per line."""
    pieces = []
    for line in text.splitlines(keepends=True):
        pieces.extend(line[i : i + CHUNK] for i in range(0, len(line), CHUNK))
    return [ascii(p) for p in pieces] or ["''"]


STORAGE = {
    "lzma": "The files are below, compressed (LZMA) and written as Base85 text, with each\n"
    "# one's SHA-256; unpacking checks every file against it.",
    "plain": "Everything it unpacks is below, as plain text: each line of each file is an\n"
    "# escaped string.",
}


def _payload(files: dict[str, bytes]) -> list[str]:
    """Every file in one LZMA stream (an index, then the bytes), as Base85 lines."""
    index, offset = {}, 0
    for name in sorted(files):
        index[name] = [offset, len(files[name])]
        offset += len(files[name])
    head = json.dumps(index, separators=(",", ":")).encode("ascii")
    blob = len(head).to_bytes(4, "big") + head + b"".join(files[n] for n in sorted(files))
    text = base64.b85encode(lzma.compress(blob, preset=9 | lzma.PRESET_EXTREME)).decode("ascii")
    return [text[i : i + CHUNK] for i in range(0, len(text), CHUNK)]


def pack(files: dict[str, bytes], version: str, plain: bool = False) -> str:
    """The packed file's source for ``files`` (name -> UTF-8 text bytes).

    Compressed unless ``plain``; either way it unpacks to the same bytes.
    Base85 has no quote or backslash, so its lines are literals as they are.
    """
    head = UNPACKER.replace("@VERSION@", version).replace(
        "@STORAGE@", STORAGE["plain" if plain else "lzma"]
    )
    out = [head]
    for name in sorted(files):
        data = files[name]
        data.decode("utf-8")  # every release file is text
        out.append(f"\nSHA256[{name!r}] = {hashlib.sha256(data).hexdigest()!r}\n")
        if plain:
            out.append(f"FILES[{name!r}] = (\n")
            out.extend(f"    {lit}\n" for lit in _literal_lines(data.decode("utf-8")))
            out.append(")\n")
    if not plain:
        out.append("\nPAYLOAD.extend([\n")
        out.extend(f"    '{line}',\n" for line in _payload(files))
        out.append("])\n")
    out.append(ENTRY)
    return "".join(out)


def files_from_zip(path: Path) -> dict[str, bytes]:
    """The zip's files, without the top-level folder they sit in."""
    with zipfile.ZipFile(path) as zf:
        return {
            info.filename.split("/", 1)[-1]: zf.read(info)
            for info in zf.infolist()
            if not info.is_dir()
        }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Pack a release zip into one self-unpacking file.")
    p.add_argument("zip", type=Path, help="the release zip, SaltReportWorkbench-v<version>.zip")
    p.add_argument(
        "-o", "--out", type=Path, default=None, help="output folder (default: beside the zip)"
    )
    p.add_argument(
        "--plain", action="store_true", help="store the files as readable text, uncompressed"
    )
    args = p.parse_args(argv)
    m = _ZIP_NAME_RE.fullmatch(args.zip.name)
    if not m:
        p.error("expected a zip named SaltReportWorkbench-v<version>.zip")
    version = m.group(1)
    out_dir = args.out or args.zip.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"SALT-Workbench-v{version}.txt"
    dest.write_text(
        pack(files_from_zip(args.zip), version, plain=args.plain), encoding="ascii", newline="\n"
    )
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    # LF explicitly: `sha256sum -c` on Linux/macOS rejects a CRLF checksum file.
    (out_dir / f"{dest.name}.sha256").write_text(
        f"{digest}  {dest.name}\n", encoding="utf-8", newline="\n"
    )
    print(f"{dest.name}  {dest.stat().st_size / 1024:.1f} KB")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

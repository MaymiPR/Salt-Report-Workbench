# SPDX-License-Identifier: AGPL-3.0-only

r"""Build a self-contained, ready-to-run distribution of the workbench.

Reads the frontend sources in ``src/`` and inlines the stylesheet and scripts
into a single ``index.html``, then copies the sync server next to it::

    src/index.html  styles.css  core/*.js  app/*.js  server/salt_sync_server.py
                \         |        |        /                  |
                  inline CSS + JS into one HTML                copy
                               \                               /
                                dist/index.html   dist/salt_sync_server.py

The page's ``<script src="core.js">`` has no file of that name: its code is
the parts in ``src/core/``, joined by ``core_source``. The Windows launcher, ``server/Start SALT Workbench.bat``, is copied too. The
resulting ``dist/`` folder is the deliverable: hand it to an operator and
``python salt_sync_server.py`` (or a double-click on the launcher) runs it with
no install and no network access. Opening ``dist/index.html`` directly also
works, in local (offline) mode.

Usage:  python scripts/build.py [--dist DIR]

``--dist`` builds into another folder; the tests use a temporary one, so a
developer's own ``dist/`` is left alone.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SERVER = ROOT / "server" / "salt_sync_server.py"
LAUNCHER = ROOT / "server" / "Start SALT Workbench.bat"
DIST = ROOT / "dist"

SRC_HTML = SRC / "index.html"
SRC_CSS = SRC / "styles.css"

# The page's pure logic (SaltCore) is split into parts in src/core/; the
# page's <script src="core.js"> gets them joined. A src/core.js beside them
# would be a stale copy, so the build refuses to run while one exists.
CORE_SCRIPT = "core.js"
CORE_DIR = SRC / "core"
STALE_CORE = SRC / "core.js"

# <link rel="stylesheet" ...>  and  <script src="..."></script>
_LINK_RE = re.compile(r'[ \t]*<link[^>]+rel=["\']stylesheet["\'][^>]*/?>', re.IGNORECASE)
_SCRIPT_RE = re.compile(
    r'[ \t]*<script[^>]+src=["\']([^"\']*)["\'][^>]*>\s*</script>', re.IGNORECASE | re.DOTALL
)


def _indent(text: str, spaces: int = 8) -> str:
    pad = " " * spaces
    return "\n".join(pad + line if line.strip() else "" for line in text.splitlines())


def _show(path: Path) -> str:
    """Repo-relative path for messages; absolute if it lives elsewhere."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def core_parts(core_dir: Path | None = None) -> list[Path]:
    """The core's parts: every ``*.js`` file in ``core_dir``, in name order."""
    core_dir = Path(core_dir) if core_dir is not None else CORE_DIR
    if not core_dir.is_dir():
        return []
    return sorted(
        (p for p in core_dir.iterdir() if p.name.endswith(".js") and p.is_file()),
        key=lambda p: p.name,
    )


def core_source(core_dir: Path | None = None) -> str:
    """The page's core: its parts' text, in name order, joined with newlines.

    Parts end in a newline (``.editorconfig``), so the joining newline leaves
    one blank line between them. The parts are one function's body split in pieces (the
    first opens the function, the last closes it), so they share one scope.
    tests/js/load-core.js joins them by the same rule for the Node tests;
    change one and change the other. Raises ``ValueError`` if there are none.
    """
    parts = core_parts(core_dir)
    if not parts:
        raise ValueError(f"no parts in {_show(Path(core_dir) if core_dir else CORE_DIR)}")
    return "\n".join(p.read_bytes().decode("utf-8") for p in parts)


def script_sources(html: str) -> list[str]:
    """The ``src`` of every external script in ``html``, in page order."""
    return _SCRIPT_RE.findall(html)


def bundle(html: str, css: str, scripts: dict[str, str]) -> str:
    """Return ``html`` with its stylesheet link and script tags replaced inline.

    ``scripts`` maps each ``<script src>`` value to that file's code. Each tag
    is replaced where it stands, so load order is kept. Raises ``ValueError``
    if a placeholder is missing or a script has no code: silently shipping an
    unstyled or script-less page is worse than failing the build.
    """
    css_block = f"    <style>\n{_indent(css)}\n    </style>"

    def inline_script(m: re.Match) -> str:
        if m.group(1) not in scripts:
            raise ValueError(f'no code for <script src="{m.group(1)}">')
        return f"    <script>\n{_indent(scripts[m.group(1)])}\n    </script>"

    # Functions, not plain strings: the payloads contain backslashes and "\1"
    # sequences that re.sub would otherwise interpret as group references.
    html, n_css = _LINK_RE.subn(lambda _m: css_block, html)
    html, n_js = _SCRIPT_RE.subn(inline_script, html)
    if n_css != 1:
        raise ValueError(f"expected 1 stylesheet <link> in {SRC_HTML.name}, found {n_css}")
    if n_js == 0:
        raise ValueError(f"expected a <script src> in {SRC_HTML.name}, found none")
    return html


def main(dist: Path | None = None) -> int:
    """Build into ``dist`` (default: the repo's ``dist/``). Returns the exit code."""
    dist = Path(dist) if dist is not None else DIST
    print("\n S.A.L.T. Report Workbench -- build")
    print(" " + "-" * 40)

    if STALE_CORE.exists():
        print(
            f"[!] {_show(STALE_CORE)} is a stale copy: the core is the parts in {_show(CORE_DIR)}"
        )
        return 1

    missing = [p for p in (SRC_HTML, SRC_CSS, SERVER, LAUNCHER) if not p.is_file()]
    page = SRC_HTML.read_text(encoding="utf-8") if SRC_HTML.is_file() else ""
    names = script_sources(page)
    script_files = {name: SRC_HTML.parent / name for name in names if name != CORE_SCRIPT}
    missing += [p for p in script_files.values() if not p.is_file()]
    if CORE_SCRIPT in names and not core_parts():
        missing.append(CORE_DIR / "*.js")
    if missing:
        for p in missing:
            print(f"[!] missing: {_show(p)}")
        return 1

    scripts = {name: path.read_text(encoding="utf-8") for name, path in script_files.items()}
    try:
        if CORE_SCRIPT in names:
            scripts[CORE_SCRIPT] = core_source()
        html = bundle(page, SRC_CSS.read_text(encoding="utf-8"), scripts)
    except ValueError as exc:
        print(f"[!] {exc}")
        return 1

    dist.mkdir(parents=True, exist_ok=True)
    out_html = dist / "index.html"
    out_html.write_text(html, encoding="utf-8")
    shutil.copy2(SERVER, dist / SERVER.name)
    # cmd.exe misreads batch files with bare LF endings, so force CRLF however
    # the source was checked out.
    launcher = LAUNCHER.read_text(encoding="utf-8").splitlines()
    out_launcher = dist / LAUNCHER.name
    out_launcher.write_text("\n".join(launcher) + "\n", encoding="utf-8", newline="\r\n")

    print(f"[*] {_show(out_html)}  ({out_html.stat().st_size / 1024:.1f} KB)")
    print(f"[*] {_show(dist / SERVER.name)}")
    print(f"[*] {_show(out_launcher)}")
    print(f"\n [+] Done. Run:  python {_show(dist / SERVER.name)}")
    print(f"     On Windows, double-click {_show(dist / LAUNCHER.name)} instead.\n")
    return 0


if __name__ == "__main__":
    _p = argparse.ArgumentParser(description="Bundle src/ into a runnable folder.")
    _p.add_argument("--dist", type=Path, default=DIST, help="output folder (default: dist/)")
    sys.exit(main(_p.parse_args().dist))

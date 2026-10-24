r"""Build a self-contained, ready-to-run distribution of the workbench.

Reads the frontend sources in ``src/`` and inlines the stylesheet and script
into a single ``index.html``, then copies the sync server next to it::

    src/index.html  src/styles.css  src/app.js   server/salt_sync_server.py
                \         |           /                    |
                 inline CSS + JS into one HTML              copy
                              \                             /
                               dist/index.html   dist/salt_sync_server.py

The resulting ``dist/`` folder is the deliverable: hand it to an operator and
``python salt_sync_server.py`` runs it with no install and no network access.
Opening ``dist/index.html`` directly also works, in local (offline) mode.

Usage:  python scripts/build.py
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SERVER = ROOT / "server" / "salt_sync_server.py"
DIST = ROOT / "dist"

SRC_HTML = SRC / "index.html"
SRC_CSS = SRC / "styles.css"
SRC_JS = SRC / "app.js"

# <link rel="stylesheet" ...>  and  <script src="..."></script>
_LINK_RE = re.compile(r'[ \t]*<link[^>]+rel=["\']stylesheet["\'][^>]*/?>', re.IGNORECASE)
_SCRIPT_RE = re.compile(
    r'[ \t]*<script[^>]+src=["\'][^"\']*["\'][^>]*>\s*</script>', re.IGNORECASE | re.DOTALL
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


def bundle(html: str, css: str, js: str) -> str:
    """Return ``html`` with its stylesheet link and script tag replaced inline.

    Raises ``ValueError`` if either placeholder is missing: silently shipping an
    unstyled or script-less page is worse than failing the build.
    """
    css_block = f"    <style>\n{_indent(css)}\n    </style>"
    js_block = f"    <script>\n{_indent(js)}\n    </script>"
    # Lambdas, not plain strings: the payloads contain backslashes and "\1"
    # sequences that re.sub would otherwise interpret as group references.
    html, n_css = _LINK_RE.subn(lambda _m: css_block, html)
    html, n_js = _SCRIPT_RE.subn(lambda _m: js_block, html)
    if n_css != 1:
        raise ValueError(f"expected 1 stylesheet <link> in {SRC_HTML.name}, found {n_css}")
    if n_js != 1:
        raise ValueError(f"expected 1 <script src> in {SRC_HTML.name}, found {n_js}")
    return html


def main() -> int:
    print("\n S.A.L.T. Report Workbench -- build")
    print(" " + "-" * 40)

    missing = [p for p in (SRC_HTML, SRC_CSS, SRC_JS, SERVER) if not p.is_file()]
    if missing:
        for p in missing:
            print(f" [!] missing: {_show(p)}")
        return 1

    try:
        html = bundle(
            SRC_HTML.read_text(encoding="utf-8"),
            SRC_CSS.read_text(encoding="utf-8"),
            SRC_JS.read_text(encoding="utf-8"),
        )
    except ValueError as exc:
        print(f" [!] {exc}")
        return 1

    DIST.mkdir(exist_ok=True)
    out_html = DIST / "index.html"
    out_html.write_text(html, encoding="utf-8")
    shutil.copy2(SERVER, DIST / SERVER.name)

    print(f" [*] {_show(out_html)}  ({out_html.stat().st_size / 1024:.1f} KB)")
    print(f" [*] {_show(DIST / SERVER.name)}")
    print(f"\n [+] Done. Run:  python dist/{SERVER.name}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

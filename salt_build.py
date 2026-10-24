# -*- coding: utf-8 -*-
"""
salt_build.py

Reads the frontend source files from `Working Files/` and produces a
single self-contained `Salt Report Workbench.html` in the Python 3
server folder:

    Working Files/
        Salt Report Workbench.html   (source)
        Salt Report Workbench.css    (source)
        Salt Report Workbench.js     (source)
            ↓ inline CSS + JS into the HTML, then write into:
    PY 3.11.8 Salt Report Workbench/Salt Report Workbench.html (output)

The PY 2.7 folder is FROZEN as a legacy snapshot — it keeps its last-built
HTML and is intentionally not a build target anymore.

Run:  python salt_build.py
"""
from __future__ import print_function

import io
import os
import re
import sys

# ── Paths ────────────────────────────────────────────────────────────────────
HERE     = os.path.dirname(os.path.abspath(__file__))
BASE     = u'Salt Report Workbench'

SRC_DIR  = os.path.join(HERE, u'Working Files')
SRC_HTML = os.path.join(SRC_DIR, BASE + u'.html')
SRC_CSS  = os.path.join(SRC_DIR, BASE + u'.css')
SRC_JS   = os.path.join(SRC_DIR, BASE + u'.js')

# Destination folders. PY 2.7 is frozen (legacy) — deliberately excluded.
OUT_DIRS = (
    os.path.join(HERE, u'PY 3.11.8 Salt Report Workbench'),
)
OUT_NAME = BASE + u'.html'


# ── Helpers ──────────────────────────────────────────────────────────────────
def read_utf8(path):
    with io.open(path, u'r', encoding=u'utf-8') as fh:
        return fh.read()


def write_utf8(path, text):
    with io.open(path, u'w', encoding=u'utf-8') as fh:
        fh.write(text)


def indent_block(text, spaces=8):
    """Re-indent every non-empty line of a block by `spaces` spaces."""
    pad = u' ' * spaces
    lines = []
    for line in text.splitlines():
        lines.append(pad + line if line.strip() else u'')
    return u'\n'.join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    print(u'')
    print(u' S.A.L.T. Report Workbench -- Distribution Builder')
    print(u' ' + u'-' * 50)

    # Verify source files exist
    missing = [p for p in (SRC_HTML, SRC_CSS, SRC_JS) if not os.path.isfile(p)]
    if missing:
        print(u' [!] Working Files folder is incomplete:')
        for p in missing:
            print(u'      missing: {}'.format(p))
        sys.exit(1)

    print(u' [*] Reading   Working Files/{}'.format(os.path.basename(SRC_HTML)))
    print(u' [*] Reading   Working Files/{}'.format(os.path.basename(SRC_CSS)))
    print(u' [*] Reading   Working Files/{}'.format(os.path.basename(SRC_JS)))

    html = read_utf8(SRC_HTML)
    css  = read_utf8(SRC_CSS)
    js   = read_utf8(SRC_JS)

    # ── Inline CSS ───────────────────────────────────────────────────────────
    # Replaces:  <link rel="stylesheet" href="Salt Report Workbench.css">
    # With:      <style> ... </style>
    css_block = u'    <style>\n{}\n    </style>'.format(indent_block(css, 8))
    _css = css_block   # capture for lambda
    html, n_css = re.subn(
        r'[ \t]*<link[^>]+rel=["\']stylesheet["\'][^>]*/?>',
        lambda m: _css,
        html,
        flags=re.IGNORECASE,
    )
    if n_css == 0:
        print(u' [!] Warning: no <link rel="stylesheet"> found -- CSS not inlined.')

    # ── Inline JS ────────────────────────────────────────────────────────────
    # Replaces:  <script src="Salt Report Workbench.js"></script>
    # With:      <script> ... </script>
    js_block = u'    <script>\n{}\n    </script>'.format(indent_block(js, 8))
    _js = js_block   # capture for lambda
    html, n_js = re.subn(
        r'[ \t]*<script[^>]+src=["\'][^"\']*["\'][^>]*>\s*</script>',
        lambda m: _js,
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if n_js == 0:
        print(u' [!] Warning: no <script src="..."> found -- JS not inlined.')

    # ── Write output to every destination folder ─────────────────────────────
    print(u'')
    written = 0
    for out_dir in OUT_DIRS:
        if not os.path.isdir(out_dir):
            print(u' [!] Missing folder, skipped: {}'.format(out_dir))
            continue
        out_path = os.path.join(out_dir, OUT_NAME)
        write_utf8(out_path, html)
        size_kb = os.path.getsize(out_path) / 1024.0
        rel = os.path.relpath(out_path, HERE)
        print(u' [*] Built     {} ({:.1f} KB)'.format(rel, size_kb))
        written += 1

    print(u'')
    if written == len(OUT_DIRS):
        print(u' [+] Done. Built {} server folder(s).'.format(written))
    elif written > 0:
        print(u' [+] Built {} of {} server folder(s).'.format(written, len(OUT_DIRS)))
    else:
        print(u' [!] No output folders found. Check your folder names.')
        sys.exit(1)
    print(u'')


if __name__ == u'__main__':
    main()

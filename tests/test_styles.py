# SPDX-License-Identifier: AGPL-3.0-only

"""Checks on the stylesheet: every colour comes from one set of tokens in
``:root``, and every ``var(--x)`` names a property that is defined."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

ROOT_BLOCK = re.compile(r":root\s*\{[^}]*\}")
# Comments, and url(...): a data: URI can't use var(), so its colours stay.
IGNORED = re.compile(r"/\*.*?\*/|url\((?:'[^']*'|\"[^\"]*\"|[^)]*)\)", re.DOTALL)
VALUE = re.compile(r":([^;{}]*)[;}]")  # a declaration's value (a selector ends in "{")
COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(")
DEFINED = re.compile(r"(--[\w-]+)\s*:")
USED = re.compile(r"var\(\s*(--[\w-]+)")
SET_FROM_JS = re.compile(r"setProperty\(\s*['\"](--[\w-]+)")  # set on an element at runtime


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


CSS = IGNORED.sub("", read(SRC / "styles.css"))
SCRIPTS = [SRC / "core.js", *sorted((SRC / "app").glob("*.js"))]
PAGE = [read(SRC / "index.html"), *map(read, SCRIPTS)]
USED_ANYWHERE = set(USED.findall(CSS)).union(*(USED.findall(text) for text in PAGE))


class StylesTests(unittest.TestCase):
    def test_colours_are_written_only_in_root(self):
        values = VALUE.findall(ROOT_BLOCK.sub("", CSS))
        colours = [v.strip() for v in values if COLOR.search(v)]
        self.assertEqual(colours, [], "colours outside :root")

    def test_every_var_is_defined(self):
        defined = set(DEFINED.findall(CSS)).union(*(SET_FROM_JS.findall(text) for text in PAGE))
        self.assertEqual(sorted(USED_ANYWHERE - defined), [], "var() of a property defined nowhere")

    def test_every_token_is_used(self):
        tokens = set(DEFINED.findall("".join(ROOT_BLOCK.findall(CSS))))
        self.assertEqual(sorted(tokens - USED_ANYWHERE), [], "tokens in :root that nothing uses")


if __name__ == "__main__":
    unittest.main()

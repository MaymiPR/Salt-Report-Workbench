# SPDX-License-Identifier: AGPL-3.0-only

"""Checks on the stylesheet: every color comes from one set of tokens in
``:root``, and every ``var(--x)`` names a property that is defined."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

ROOT_BLOCK = re.compile(r":root\s*\{[^}]*\}")
# Comments, and url(...): a data: URI can't use var(), so its colors stay.
IGNORED = re.compile(r"/\*.*?\*/|url\((?:'[^']*'|\"[^\"]*\"|[^)]*)\)", re.DOTALL)
VALUE = re.compile(r":([^;{}]*)[;}]")  # a declaration's value (a selector ends in "{")
COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(")
DEFINED = re.compile(r"(--[\w-]+)\s*:")
USED = re.compile(r"var\(\s*(--[\w-]+)")
SET_FROM_JS = re.compile(r"setProperty\(\s*['\"](--[\w-]+)")  # set on an element at runtime


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


CSS = IGNORED.sub("", read(SRC / "styles.css"))
SCRIPTS = [*sorted((SRC / "core").glob("*.js")), *sorted((SRC / "app").glob("*.js"))]
PAGE = [read(SRC / "index.html"), *map(read, SCRIPTS)]
USED_ANYWHERE = set(USED.findall(CSS)).union(*(USED.findall(text) for text in PAGE))


class StylesTests(unittest.TestCase):
    def test_colours_are_written_only_in_root(self):
        values = VALUE.findall(ROOT_BLOCK.sub("", CSS))
        colors = [v.strip() for v in values if COLOR.search(v)]
        self.assertEqual(colors, [], "colors outside :root")

    def test_every_var_is_defined(self):
        defined = set(DEFINED.findall(CSS)).union(*(SET_FROM_JS.findall(text) for text in PAGE))
        self.assertEqual(sorted(USED_ANYWHERE - defined), [], "var() of a property defined nowhere")

    def test_font_sizes_come_only_from_the_type_scale(self):
        # A size is a token from :root (--text-*, or the map's names'
        # --map-label*), or the parent's own (1em, inherit), so sizes can't
        # compound or drift again. The font shorthand's size the same.
        token = r"var\(--(?:text|map-label)[\w-]*\)"
        size_ok = re.compile(rf"^(?:{token}|1em|inherit)(?:\s*!important)?$")
        shorthand_ok = re.compile(rf"^(?:inherit|.*\b{token}\s)")
        body = ROOT_BLOCK.sub("", CSS)
        sizes = re.findall(r"(?<![\w-])font-size\s*:\s*([^;}]+)", body)
        fonts = re.findall(r"(?<![\w-])font\s*:\s*([^;}]+)", body)
        self.assertEqual(
            [v.strip() for v in sizes if not size_ok.match(v.strip())],
            [],
            "font-size off the scale",
        )
        self.assertEqual(
            [v.strip() for v in fonts if not shorthand_ok.match(v.strip())],
            [],
            "font off the scale",
        )

    def test_the_map_draws_only_in_map_colors(self):
        # Every color the map's scripts draw with is a MAP_COLORS entry, so
        # the map, its key and the saved map can't drift apart. A stylesheet
        # token's fallback is the token's own value.
        hexes = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b")
        palette = re.compile(r"const MAP_COLORS = \{.*?\};", re.DOTALL)
        fallback = re.compile(r"getPropertyValue\('--[\w-]+'\)\.trim\(\) \|\| '#[0-9a-fA-F]+'")
        found = {}
        for path in sorted((SRC / "app").glob("6*-map*.js")):
            text = fallback.sub("", palette.sub("", read(path)))
            if hexes.search(text):
                found[path.name] = hexes.findall(text)
        self.assertEqual(found, {}, "map colors outside MAP_COLORS")

    def test_every_token_is_used(self):
        tokens = set(DEFINED.findall("".join(ROOT_BLOCK.findall(CSS))))
        self.assertEqual(sorted(tokens - USED_ANYWHERE), [], "tokens in :root that nothing uses")


if __name__ == "__main__":
    unittest.main()

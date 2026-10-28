# SPDX-License-Identifier: AGPL-3.0-only

"""Checks on the docs that are easy to get wrong by hand: the changelog's
shape, and the version number everywhere it is written down."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Keep a Changelog's order of change types.
ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
VERSION_HEADING = re.compile(r"^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$", re.MULTILINE)


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def changelog_sections(text: str) -> dict[str, str]:
    """Each released version's section text, newest first."""
    starts = list(VERSION_HEADING.finditer(text))
    ends = [m.start() for m in starts[1:]] + [text.index("\n[Unreleased]: ")]
    return {m.group(1): text[m.end() : end] for m, end in zip(starts, ends, strict=True)}


class DocsTests(unittest.TestCase):
    def test_the_readme_has_no_em_dashes(self):
        lines = [n for n, line in enumerate(read("README.md").splitlines(), 1) if "—" in line]
        self.assertEqual(lines, [], "README lines with an em dash")

    def test_changelog_sections_follow_keep_a_changelog_order(self):
        sections = changelog_sections(read("CHANGELOG.md"))
        self.assertGreater(len(sections), 0)
        for version, body in sections.items():
            with self.subTest(version=version):
                headings = re.findall(r"^### (.+)$", body, re.MULTILINE)
                self.assertTrue(set(headings) <= set(ORDER), headings)
                self.assertEqual(headings, sorted(set(headings), key=ORDER.index), headings)

    def test_every_version_has_a_compare_link(self):
        text = read("CHANGELOG.md")
        links = dict(re.findall(r"^\[([^\]]+)\]: (\S+)$", text, re.MULTILINE))
        self.assertIn("Unreleased", links)
        for version in changelog_sections(text):
            with self.subTest(version=version):
                self.assertIn(version, links)
                self.assertRegex(
                    links[version],
                    rf"^https://github\.com/MaymiPR/SaltReportWorkbench/"
                    rf"(compare/v[\d.]+\.\.\.v{re.escape(version)}|releases/tag/v{re.escape(version)})$",
                )

    def test_the_version_agrees_everywhere(self):
        version = re.search(r'^version = "([^"]+)"$', read("pyproject.toml"), re.MULTILINE)[1]
        badge = re.search(r"img\.shields\.io/badge/version-([\d.]+)-", read("README.md"))
        txt = re.search(r'python "SALT-Workbench-v([\d.]+)\.txt"', read("docs/INSTALL.md"))
        newest = VERSION_HEADING.search(read("CHANGELOG.md"))
        self.assertEqual(
            {
                "README badge": badge and badge[1],
                "INSTALL.md .txt example": txt and txt[1],
                "newest CHANGELOG version": newest and newest[1],
            },
            dict.fromkeys(
                ("README badge", "INSTALL.md .txt example", "newest CHANGELOG version"), version
            ),
            f"pyproject.toml says {version}",
        )


if __name__ == "__main__":
    unittest.main()

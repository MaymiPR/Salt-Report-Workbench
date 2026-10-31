# SPDX-License-Identifier: AGPL-3.0-only

"""Checks on the docs that are easy to get wrong by hand: the changelog's
shape, the version number everywhere it is written down, and no em dashes in
anything a user reads."""

from __future__ import annotations

import re
import sys
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
        server = re.search(r"^APP_VERSION = '([^']+)'$", read("server/salt_sync_server.py"), re.M)
        page = re.search(r"^const APP_VERSION = '([^']+)';$", read("src/app/10-state.js"), re.M)
        footer = re.search(r"Version ([\d.]+) &middot;", read("src/index.html"))
        found = {
            "README badge": badge and badge[1],
            "INSTALL.md .txt example": txt and txt[1],
            "newest CHANGELOG version": newest and newest[1],
            "the server's APP_VERSION": server and server[1],
            "the page's APP_VERSION": page and page[1],
            "the manual's footer (major.minor)": footer and footer[1],
        }
        wanted = {**dict.fromkeys(found, version)}
        wanted["the manual's footer (major.minor)"] = ".".join(version.split(".")[:2])
        self.assertEqual(found, wanted, f"pyproject.toml says {version}")


EM_DASH = re.compile("\u2014|&mdash;")


def page_text_lines():
    """(where, line) for the page's text a user can read: the HTML outside
    comments, scripts and styles, and the string literals in its scripts
    (code before any // comment that quotes an em dash)."""
    html = read("src/index.html")
    shown = re.sub(r"<!--.*?-->|<script.*?</script>|<style.*?</style>", "", html, flags=re.S)
    for n, line in enumerate(shown.splitlines(), 1):
        yield f"src/index.html (text line {n})", line
    for path in sorted((ROOT / "src").rglob("*.js")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("//", 1)[0]
            if re.search(r"""['"`][^'"`]*\u2014""", code):
                yield f"{path.relative_to(ROOT).as_posix()}:{n}", code


class NoEmDashTests(unittest.TestCase):
    # The owner's rule (2026-10-28): no em dashes in user-visible text; code
    # comments may keep theirs. The server's own text is checked in test_server.
    DOCS = ("README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "assets/BRAND.md")

    def test_none_in_the_docs(self):
        docs = [*self.DOCS, *(p.relative_to(ROOT).as_posix() for p in (ROOT / "docs").glob("*.md"))]
        for name in docs:
            with self.subTest(name):
                hits = [
                    n for n, line in enumerate(read(name).splitlines(), 1) if EM_DASH.search(line)
                ]
                self.assertEqual(hits, [], f"em dashes on lines {hits}")

    def test_none_in_the_page(self):
        hits = [
            f"{where}: {line.strip()[:80]}"
            for where, line in page_text_lines()
            if EM_DASH.search(line)
        ]
        self.assertEqual(hits, [])

    def test_none_in_the_readme_txt(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import release  # scripts/release.py: the README.txt in every download

        self.assertIsNone(EM_DASH.search(release.QUICKSTART))


class MergeLeftoverTests(unittest.TestCase):
    def test_no_conflict_markers_in_tracked_files(self):
        # A merge committed half-done once (a pushed branch then failed CI's
        # JavaScript check): this says where, before it reaches CI.
        import subprocess

        files = subprocess.run(
            ["git", "ls-files"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        ).stdout.split()
        marker = re.compile(r"^(<{7} |>{7} )", re.MULTILINE)
        hits = []
        for name in files:
            path = ROOT / name
            if path.suffix.lower() in {".png", ".ico", ".zip", ".kmz", ".shp", ".dbf", ".xlsx"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, FileNotFoundError):
                continue
            hits += [
                f"{name}:{text.count(chr(10), 0, m.start()) + 1}" for m in marker.finditer(text)
            ]
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()

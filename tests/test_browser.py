# SPDX-License-Identifier: AGPL-3.0-only

"""End-to-end tests of the page in a real browser, against the built server.

These cover the DOM layer in ``src/app/``, which the Node tests of
``core.js`` can't reach. They need Playwright and a Chromium:

    pip install playwright && playwright install chromium
    python -m unittest tests.test_browser

Without Playwright the whole module is skipped, so the plain
``python -m unittest discover -s tests`` still runs anywhere Python does.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # the optional dev dependency isn't installed
    sync_playwright = None

ROOT = Path(__file__).resolve().parent.parent
CODE = "TESTCODE23"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(sync_playwright, "playwright is not installed")
class BrowserTests(unittest.TestCase):
    """One built server and one browser for the class; a fresh browser context per test."""

    @classmethod
    def setUpClass(cls):
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build.py")], check=True, capture_output=True
        )
        cls.tmp = Path(tempfile.mkdtemp(prefix="salt-browser-"))
        cls.port, cls.viewer_port = free_port(), free_port()
        cls.server = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "dist" / "salt_sync_server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                str(cls.port),
                "--viewer-port",
                str(cls.viewer_port),
                "--access-code",
                CODE,
                "--backup-dir",
                str(cls.tmp / "backups"),
                "--no-browser",
                "--no-minimize",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.editor = f"http://127.0.0.1:{cls.port}"
        cls.viewer = f"http://127.0.0.1:{cls.viewer_port}"
        deadline = time.monotonic() + 15
        while True:
            try:
                urllib.request.urlopen(cls.editor + "/", timeout=1).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError("the server did not come up") from None
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.terminate()
        cls.server.wait(timeout=10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        # A fresh context has empty storage, so every test starts at the first-run modal.
        self.context = self.browser.new_context()
        self.errors: list[str] = []

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "the page threw")

    # -- helpers ------------------------------------------------------------- #
    def open_editor(self, initials="AB", ato=None, title="Patrol"):
        """The editor page past its first-run modal. The server trusts
        127.0.0.1, so the code is auto-filled; identity and workspace are not.
        Each test gets its own workspace, since they share one server."""
        ato = ato or self._testMethodName.replace("test_", "").replace("_", "")[:30].upper()
        self.ato = ato
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.editor + "/")
        page.fill("#startup-initials", initials)
        page.fill("#startup-ato", ato)
        page.fill("#startup-title", title)
        page.click("#startupContinueBtn")
        page.wait_for_selector("#startupModal.show", state="hidden")
        return page

    def open_viewer(self):
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.viewer + "/")
        page.wait_for_selector("body.read-only")
        return page

    @staticmethod
    def log(page, size, activity="Moving N", location="18SUJ1234"):
        page.fill("#size", size)
        page.fill("#activity", activity)
        page.fill("#location", location)
        page.click("#logButton")
        page.wait_for_selector(f"#reportLogBody .col-size:has-text('{size}')")

    @staticmethod
    def sizes(page):
        return page.locator("#reportLogBody tr[data-id] .col-size").all_text_contents()

    # -- tests --------------------------------------------------------------- #
    def test_a_logged_report_reaches_the_server_and_every_viewer(self):
        editor = self.open_editor()
        viewer = self.open_viewer()
        self.log(editor, "2x BTR")
        self.assertEqual(self.sizes(editor), ["2x BTR"])
        # The toast says it was copied, and the status dot is green.
        self.assertIn("logged", editor.locator("#toast-notification").text_content())
        self.assertIn("online", editor.locator("#status-dot").get_attribute("class"))
        # SSE told the viewer; it renders without a reload, and has no form.
        viewer.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        self.assertFalse(viewer.locator("#logButton").is_visible())
        self.assertIsNone(viewer.evaluate("localStorage.getItem('salt_reports_by_ato')"))

    def test_delete_then_undo(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        page.check("#reportLogBody .row-selector")
        page.click("#deleteSelectedBtn")
        page.click("#confirmActionBtn")
        page.wait_for_selector("#reportLogBody tr[data-id]", state="detached")
        page.click("#toast-notification .toast-undo")
        page.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        # And the server agrees: the report is live again.
        page.wait_for_function(
            f"() => fetch('/api/sync').then(r => r.json()).then(s => s.workspaces['{self.ato}'].every(r => !r.deleted))"
        )

    def test_sorting_by_size_is_numeric(self):
        page = self.open_editor()
        self.log(page, "10x T-72")
        self.log(page, "2x BTR")
        page.click("th[data-sort='size']")
        self.assertEqual(self.sizes(page), ["2x BTR", "10x T-72"])
        page.click("th[data-sort='size']")
        self.assertEqual(self.sizes(page), ["10x T-72", "2x BTR"])

    def test_bda_roll_up_counts_and_filters(self):
        page = self.open_editor()
        self.log(page, "4x T-72, 2x BMP-2", location="18SUJ1111, 18SUJ2222")
        self.log(page, "1x truck")
        page.click("#dataMgmtBtn")
        page.click("#toggleBdaBtn")
        self.assertIn("BDA 0 / 3", page.locator("#bdaRollup").text_content())
        # Assess the first element of the first report as destroyed.
        page.click(
            "#reportLogBody tr[data-id]:has(.col-size:has-text('4x T-72, 2x BMP-2')) .bda-btn"
        )
        page.click(".bda-check-row[data-row='0'] .bda-eff-btn[data-bda-eff='Destroyed']")
        page.click(".bda-commit-btn")
        page.wait_for_selector("#bdaRollup:has-text('BDA 1 / 3')")
        page.click("#bdaRollup [data-bda-filter='Destroyed']")
        self.assertEqual(self.sizes(page), ["4x T-72, 2x BMP-2"])
        page.click("#bdaRollup [data-bda-filter='Destroyed']")
        self.assertEqual(len(self.sizes(page)), 2)


if __name__ == "__main__":
    unittest.main()

# SPDX-License-Identifier: AGPL-3.0-only

"""End-to-end tests of the page in a real browser, against the built server.

These cover the DOM layer in ``src/app/``, which the Node tests of
the core (``src/core/``) can't reach. They need Playwright and a Chromium:

    pip install playwright && playwright install chromium
    python -m unittest tests.test_browser

Without Playwright the whole module is skipped, so the plain
``python -m unittest discover -s tests`` still runs anywhere Python does.
"""

from __future__ import annotations

import json
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # the optional dev dependency isn't installed
    sync_playwright = None

ROOT = Path(__file__).resolve().parent.parent
CODE = "TESTCODE23"


def free_ports(n: int = 2) -> list[int]:
    """``n`` distinct ports free right now. Another process can still take one
    before the server binds it, so the server is started with retries."""
    socks = [socket.socket() for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()


def log_tail(path: Path, lines: int = 30) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "(no server log)"
    return "\n".join(text.splitlines()[-lines:]) or "(the server printed nothing)"


@unittest.skipUnless(sync_playwright, "playwright is not installed")
class BrowserTests(unittest.TestCase):
    """One built server and one browser for the class; a fresh browser context per test."""

    START_ATTEMPTS = 3
    START_SECONDS = 15

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="salt-browser-"))
        cls.addClassCleanup(shutil.rmtree, cls.tmp, ignore_errors=True)
        # Built into the temp folder, so a developer's own dist/ is left alone.
        build = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build.py"), "--dist", str(cls.tmp / "dist")],
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            raise RuntimeError(f"the build failed:\n{build.stdout}{build.stderr}")
        cls.start_server()
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = cls.pw.chromium.launch()
        cls.addClassCleanup(cls.browser.close)

    @classmethod
    def start_server(cls):
        """Start the built server on free ports and wait until both answer.
        A port taken in the meantime makes the server exit (or skip its
        viewer), so that is retried on fresh ports. Its output goes to a log
        file, whose tail is in the error if it never comes up."""
        unverified = ssl._create_unverified_context()
        for attempt in range(1, cls.START_ATTEMPTS + 1):
            cls.port, cls.viewer_port = free_ports()
            cls.log_path = cls.tmp / f"server-{attempt}.log"
            with open(cls.log_path, "wb") as log:
                cls.server = subprocess.Popen(
                    [
                        sys.executable,
                        str(cls.tmp / "dist" / "salt_sync_server.py"),
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
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            # HTTPS, as the server starts by default, with its self-signed certificate.
            cls.editor = f"https://127.0.0.1:{cls.port}"
            cls.viewer = f"https://127.0.0.1:{cls.viewer_port}"
            deadline = time.monotonic() + cls.START_SECONDS
            waiting = [cls.editor, cls.viewer]
            while waiting and cls.server.poll() is None and time.monotonic() < deadline:
                try:
                    urllib.request.urlopen(waiting[0] + "/", timeout=1, context=unverified).close()
                    waiting.pop(0)
                except OSError:
                    time.sleep(0.1)
            if not waiting:
                cls.addClassCleanup(cls.stop_server)
                return
            cls.stop_server()
        raise RuntimeError(
            f"the server did not come up in {cls.START_ATTEMPTS} attempts; "
            f"the last one's output ({cls.log_path}):\n{log_tail(cls.log_path)}"
        )

    @classmethod
    def stop_server(cls):
        if cls.server.poll() is None:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls.server.kill()
                cls.server.wait(timeout=10)

    def setUp(self):
        # A fresh context has empty storage, so every test starts at the first-run modal.
        self.context = self.browser.new_context(ignore_https_errors=True)
        self.errors: list[str] = []

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "the page threw")

    # -- helpers ------------------------------------------------------------- #
    def wait_until(self, condition, message, page=None, timeout=5.0):
        """Poll ``condition`` until it is true, or fail with ``message``. With
        ``page``, wait through it, so Playwright keeps running route handlers."""
        deadline = time.monotonic() + timeout
        while not condition():
            if time.monotonic() > deadline:
                self.fail(f"{message} (waited {timeout:g} s)")
            if page is None:
                time.sleep(0.05)
            else:
                page.wait_for_timeout(50)

    @staticmethod
    def next_frames(page, n=2):
        """Wait for ``n`` rendering frames: whatever an event scheduled has run."""
        page.evaluate(
            "n => new Promise(done => { const tick = k => k ? requestAnimationFrame(() => tick(k - 1)) : done(); tick(n); })",
            n,
        )

    @classmethod
    def settle(cls, page, condition="true"):
        """Instead of sleeping through a slide or a fade: wait until every
        finite CSS transition and animation on the page has finished, and
        the JavaScript expression ``condition`` holds."""
        cls.next_frames(page)  # let a transition the last action triggered start
        page.wait_for_function(
            "() => !document.getAnimations().some(a => a.playState === 'running'"
            " && a.effect && a.effect.getComputedTiming().iterations !== Infinity)"
            f" && ({condition})"
        )

    def open_editor(self, initials="AB", ato=None, title="Patrol"):
        """The editor page past its first-run modal. The server trusts
        127.0.0.1, so the code is auto-filled; identity and workspace are not.
        Each test gets its own workspace, since they share one server."""
        ato = ato or self._testMethodName.replace("test_", "").replace("_", "")[:30].upper()
        self.ato = ato
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.editor + "/")
        page.fill("#startupInitials", initials)
        page.fill("#startupAto", ato)
        page.fill("#startupTitle", title)
        page.click("#startupContinueBtn")
        page.wait_for_selector("#startupModal.show", state="hidden")
        self.assert_in_workspace(page, ato)
        return page

    def assert_in_workspace(self, page, ato):
        """The editor is in the workspace typed in: a test that goes on in
        another (the last test's, say) fails here, not later, puzzlingly."""
        self.assertEqual(page.evaluate("[activeAto, el.config.ato.value]"), [ato, ato])

    def open_viewer(self):
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.viewer + "/")
        page.wait_for_selector("body.read-only")
        return page

    @staticmethod
    def log(page, size, activity="Moving N", location="18SUJ1234", choice=None):
        """Log a report. ``choice``: the answer to pick when the Location's
        typed place disagrees with its grid."""
        page.fill("#size", size)
        page.fill("#activity", activity)
        page.fill("#location", location)
        page.click("#logButton")
        if choice:
            page.click(f"#choiceButtons button:text-is('{choice}')")
        try:
            page.wait_for_selector(f"#reportLogBody .col-size:has-text('{size}')", timeout=15000)
        except Exception as exc:
            # Say what the page showed instead, for a failure seen only on CI.
            state = page.evaluate(
                """() => ({ toast: document.querySelector('#toastNotification').textContent,
                           rows: [...document.querySelectorAll('#reportLogBody .col-size')].map(e => e.textContent),
                           form: [size.value, activity.value, location.value] })"""
            )
            raise AssertionError(f"{size!r} never appeared: {state}") from exc

    @staticmethod
    def run_io(page, what):
        """Pick an export in the Import / Export tab and press its button."""
        page.select_option("#ioFormatSelect", what)
        page.click("#ioRunBtn")

    @staticmethod
    def sizes(page):
        return page.locator("#reportLogBody tr[data-id] .col-size").all_text_contents()

    @staticmethod
    def wait_for_server(page, predicate, timeout=15):
        """Wait until ``predicate`` (JS, given the /api/sync state) holds.
        Not wait_for_function: it takes the promise a fetch returns as true."""
        check = f"() => fetch('/api/sync').then(r => r.json()).then({predicate})"
        deadline = time.monotonic() + timeout
        while not page.evaluate(check):
            if time.monotonic() > deadline:
                # What it had instead: each workspace's sizes, and the config.
                had = page.evaluate(
                    "() => fetch('/api/sync').then(r => r.json()).then(s => JSON.stringify({"
                    " config: s.config, workspaces: Object.fromEntries(Object.entries(s.workspaces)"
                    ".map(([k, v]) => [k, v.map(r => r.size + (r.deleted ? ' (deleted)' : ''))])) }))"
                )
                raise AssertionError(f"the server never had {predicate}; it had {had}")
            page.wait_for_timeout(100)

    @staticmethod
    def synced(page):
        """Wait until the page shows the newest change it knows of (its own
        saves included): a test that then fakes someone else's change in the
        page isn't undone by the pull its own save brings, a moment later."""
        page.wait_for_function("syncedVersion >= seenVersion && pushesInFlight === 0")

    def second_editor(self, initials, ato):
        """Another operator on the same server: a browser with storage of its own."""
        context = self.browser.new_context(ignore_https_errors=True)
        self.addCleanup(context.close)
        other = context.new_page()
        other.on("pageerror", lambda exc: self.errors.append(str(exc)))
        other.goto(self.editor + "/")
        other.fill("#startupInitials", initials)
        other.fill("#startupAto", ato)
        other.fill("#startupTitle", "Patrol")
        other.click("#startupContinueBtn")
        other.wait_for_selector("#startupModal.show", state="hidden")
        self.assert_in_workspace(other, ato)
        return other

    @staticmethod
    def refuse(message, status=400):
        """A route handler answering as the server does when it refuses a POST."""

        def handler(route):
            route.fulfill(
                status=status,
                content_type="application/json",
                body=json.dumps({"status": "error", "message": message}),
            )

        return handler

    # -- tests --------------------------------------------------------------- #
    def test_a_logged_report_reaches_the_server_and_every_viewer(self):
        editor = self.open_editor()
        viewer = self.open_viewer()
        self.log(editor, "2x BTR")
        self.assertEqual(self.sizes(editor), ["2x BTR"])
        # The toast says it was copied, and the status dot is green.
        self.assertIn("logged", editor.locator("#toastNotification").text_content())
        self.assertIn("online", editor.locator("#statusDot").get_attribute("class"))
        # SSE told the viewer; it renders without a reload, and has no form.
        viewer.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        self.assertFalse(viewer.locator("#logButton").is_visible())
        self.assertIsNone(viewer.evaluate("localStorage.getItem('salt_reports_by_ato')"))

    def test_delete_then_undo(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        self.log(page, "1x truck")
        page.check("#reportLogBody tr:has(.col-size:has-text('2x BTR')) .row-selector")
        # The first press asks, on the button itself; no pop-up.
        page.click("#deleteSelectedBtn")
        self.assertEqual(page.text_content("#deleteSelectedBtn"), "Delete 1 for everyone?")
        self.assertFalse(page.is_visible("#confirmationToast"))
        self.assertEqual(page.evaluate("document.activeElement.id"), "deleteSelectedBtn")
        self.assertEqual(page.evaluate("askSaid.textContent"), "Delete 1 for everyone?")
        self.assertEqual(len(self.sizes(page)), 2, "not yet")
        # A changed selection lets the question go; so does any other button.
        page.check("#reportLogBody tr:has(.col-size:has-text('1x truck')) .row-selector")
        self.assertEqual(page.text_content("#deleteSelectedBtn"), "Delete")
        page.click("#deleteSelectedBtn")
        self.assertEqual(page.text_content("#deleteSelectedBtn"), "Delete 2 for everyone?")
        page.click("th[data-sort='size'] .sort-btn")
        self.assertEqual(page.text_content("#deleteSelectedBtn"), "Delete")
        page.uncheck("#reportLogBody tr:has(.col-size:has-text('1x truck')) .row-selector")
        # From the keyboard: Enter asks, Enter again deletes.
        page.focus("#deleteSelectedBtn")
        page.keyboard.press("Enter")
        self.assertEqual(page.text_content("#deleteSelectedBtn"), "Delete 1 for everyone?")
        page.keyboard.press("Enter")
        page.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')", state="detached")
        self.assertEqual(self.sizes(page), ["1x truck"])
        self.wait_for_server(
            page, f"s => s.workspaces['{self.ato}'].some(r => r.size === '2x BTR' && r.deleted)"
        )
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        # And the server agrees: the report is live again.
        self.wait_for_server(page, f"s => s.workspaces['{self.ato}'].every(r => !r.deleted)")

    def test_deleting_a_bda_assessment_asks_in_its_row_and_undo_puts_it_back(self):
        page = self.open_editor()
        self.log(page, "2x T-72")
        page.click("#dataMgmtBtn")
        page.click("#toggleBdaBtn")
        page.click("#reportLogBody tr[data-id] .bda-btn")
        page.click(".bda-check-row[data-row='0'] .bda-eff-btn[data-bda-eff='Destroyed']")
        page.click(".bda-commit-btn")
        page.wait_for_selector(".bda-entry")
        assessed = f"s => (s.workspaces['{self.ato}'][0].bda || []).length === 1"
        self.wait_for_server(page, assessed)
        # Let that save settle: this page has pulled it back, and redrawn.
        page.wait_for_function("() => pushesInFlight === 0 && !pullDeferred")
        page.evaluate("() => syncWithServer()")
        self.next_frames(page)
        # The first press asks in the entry's row, where its time was: no
        # pop-up, nothing moves, and the delete keeps focus.
        box = page.locator(".bda-entry .bda-del").bounding_box()
        page.click(".bda-entry .bda-del")
        page.wait_for_selector(".bda-entry .map-base-ask:has-text('Delete for everyone?')")
        self.next_frames(page)
        self.assertFalse(page.is_visible("#confirmationToast"))
        self.assertEqual(page.locator(".bda-entry .bda-del").bounding_box(), box)
        self.assertTrue(page.evaluate("document.activeElement.classList.contains('bda-del')"))
        # Another button lets it go; asked again, the second press deletes.
        page.click("th[data-sort='size'] .sort-btn")
        self.assertEqual(page.locator(".bda-entry .map-base-ask").count(), 0)
        page.click(".bda-entry .bda-del")
        page.click(".bda-entry .bda-del")
        page.wait_for_selector("#toastNotification:has-text('BDA assessment deleted')")
        self.assertEqual(page.locator(".bda-entry").count(), 0)
        self.wait_for_server(page, f"s => !(s.workspaces['{self.ato}'][0].bda || []).length")
        # Undo puts it back, for everyone.
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector(".bda-entry")
        self.wait_for_server(page, assessed)

    def test_the_activity_list_shows_another_editors_change(self):
        page = self.open_editor()
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='workspaces']")
        page.wait_for_selector("#activityList .peer-activity-row")
        other = self.second_editor("CD", self.ato)
        self.log(other, "2x BTR")
        newest = "#activityList .peer-activity-row:first-child"
        page.wait_for_selector(f"{newest}:has-text('CD logged')")
        self.assertRegex(page.text_content(newest), r"^CD logged \S+001 · just now$")
        # Viewers see it too, beside the workspaces.
        viewer = self.open_viewer()
        viewer.wait_for_selector("#activitySidebarList .peer-activity-row:has-text('CD logged')")

    def test_unloading_a_workspace_asks_in_its_row_and_undo_sends_it_back(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        # Another editor in it unloads it, and then thinks better of it.
        other = self.second_editor("CD", self.ato)
        other.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        other.click("#exportViewToggleBtn")
        other.click(".ws-tab[data-tab='workspaces']")
        unload = f"#workspacesList [data-unload-ato='{self.ato}']"
        row = f"#workspacesList .workspace-row:has([data-unload-ato='{self.ato}'])"
        self.synced(other)  # the list redraws with each sync
        other.locator(unload).scroll_into_view_if_needed()
        box = other.locator(unload).bounding_box()
        other.click(unload)
        other.wait_for_selector(f"{row} .map-base-ask:has-text('Unload for everyone?')")
        self.assertEqual(other.locator(unload).bounding_box(), box, "nothing moved")
        self.assertEqual(other.evaluate("document.activeElement.dataset.unloadAto"), self.ato)
        self.assertFalse(other.is_visible("#confirmationToast"))
        other.click(unload)
        other.wait_for_selector("#toastNotification:has-text('unloaded.')")
        self.wait_for_server(other, f"s => !s.workspaces['{self.ato}']")
        self.assertEqual(other.evaluate("activeAto"), "")
        other.click("#toastNotification .toast-undo")
        other.wait_for_selector("#toastNotification:has-text('is back')")
        # Back on the server as it was: each report keeps its author.
        self.wait_for_server(
            other,
            f"s => (s.workspaces['{self.ato}'] || []).some(r => r.size === '2x BTR'"
            " && r.user && r.user.initials === 'AB')",
        )
        # And the editor who was in it is in it again.
        self.assertEqual(other.evaluate("[activeAto, el.config.ato.value]"), [self.ato, self.ato])
        self.assertEqual(self.sizes(other), ["2x BTR"])
        other.evaluate("() => syncWithServer()")
        self.assertEqual(other.evaluate("activeAto"), self.ato)

    def test_a_save_the_server_refuses_says_so(self):
        # Regression: every POST resolved whatever the server answered, so a
        # refused save showed the same toast as one that worked.
        page = self.open_editor()
        self.log(page, "2x BTR")
        page.route("**/api/save_config", self.refuse("Validation failed: config.title is too long"))
        page.click("#setAtoBtn")  # Change
        page.fill("#reportTitlePrefix", "Other")
        page.click("#setAtoBtn")
        page.wait_for_selector(
            "#toastNotification:has-text('Not saved: Validation failed: config.title is too long.')"
        )
        # An error is announced at once, on a red white text can be read on.
        toast = page.locator("#toastNotification")
        self.assertEqual(toast.get_attribute("role"), "alert")
        self.assertEqual(
            toast.evaluate("t => getComputedStyle(t).backgroundColor"), "rgb(192, 38, 28)"
        )
        # An unload the server refuses leaves the workspace here.
        page.route("**/api/unload_ato", self.refuse("Unload refused"))
        page.click("#dataMgmtBtn")
        page.click("#clearAllBtn")
        # The menu item asks, and the menu stays open for the answer.
        self.assertEqual(page.text_content("#clearAllBtn"), f"Unload {self.ato} for everyone?")
        self.assertTrue(page.is_visible("#dataMgmtMenu"))
        page.click("#clearAllBtn")
        page.wait_for_selector("#toastNotification:has-text('Not unloaded: Unload refused.')")
        self.assertEqual(page.text_content("#clearAllBtn"), "Clear Workspace")
        self.assertEqual(self.sizes(page), ["2x BTR"])
        self.assertTrue(
            page.evaluate(f"!!reportsByAto['{self.ato}']"),
            page.evaluate(
                """async () => JSON.stringify({ activeAto, mine: Object.keys(reportsByAto),
                    pending: [...pendingAtos], offlinePendingPush,
                    server: Object.keys((await (await fetch('/api/sync')).json()).workspaces) })"""
            ),
        )

    def test_toasts_are_announced_and_undo_waits_while_pointed_at(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        toast = page.locator("#toastNotification")
        self.assertEqual(
            (toast.get_attribute("role"), toast.get_attribute("aria-live")), ("status", "polite")
        )
        page.check("#reportLogBody .row-selector")
        page.click("#deleteSelectedBtn")
        page.click("#deleteSelectedBtn")
        page.wait_for_selector("#toastNotification .toast-undo")
        page.hover("#toastNotification")
        self.assertTrue(page.evaluate("toastHeld"), "the clock stops under the pointer")
        page.wait_for_timeout(300)
        self.assertIn("show", toast.get_attribute("class"))
        page.mouse.move(5, 5)
        self.assertFalse(page.evaluate("toastHeld"), "and runs again when it leaves")
        page.focus("#toastNotification .toast-undo")
        self.assertTrue(page.evaluate("toastHeld"), "and stops while the Undo button has focus")

    def test_sorting_by_size_is_numeric(self):
        page = self.open_editor()
        self.log(page, "10x T-72")
        self.log(page, "2x BTR")
        page.click("th[data-sort='size']")
        self.assertEqual(self.sizes(page), ["2x BTR", "10x T-72"])
        page.click("th[data-sort='size']")
        self.assertEqual(self.sizes(page), ["10x T-72", "2x BTR"])

    def test_checked_rows_the_edited_row_and_open_cells_survive_a_redraw(self):
        # Regression: every sync redrew the table and dropped all three, and
        # Delete stayed on with nothing checked.
        page = self.open_editor()
        long = "10x T-72, 4x BMP-2, 2x BTR-82A, 3x MT-LB, 6x Ural trucks, 2x 2S19 Msta, 1x BREM-1"
        self.log(page, long)
        self.log(page, "1x truck")

        def row(size):
            return f"#reportLogBody tr[data-id]:has(.col-size:has-text('{size}'))"

        page.check(f"{row('1x truck')} .row-selector")
        page.click(f"{row('1x truck')} .id-edit-btn")  # into the form
        page.click(f"{row(long)} .col-size .cell-clamp.clampable")
        page.evaluate("renderLog()")  # what a sync from another operator does
        self.assertTrue(page.is_checked(f"{row('1x truck')} .row-selector"))
        self.assertIn("selected-row", page.get_attribute(row("1x truck"), "class"))
        self.assertIn("expanded", page.get_attribute(f"{row(long)} .col-size .cell-clamp", "class"))
        self.assertTrue(page.is_visible("#deleteSelectedBtn"))
        # A checked report that goes away (deleted elsewhere) takes Delete with it.
        page.evaluate("localReports.find(r => r.size === '1x truck').deleted = true; renderLog()")
        self.assertFalse(page.is_visible("#deleteSelectedBtn"))
        self.assertEqual(page.evaluate("selectedRows.size"), 0)

    def test_the_log_works_from_the_keyboard(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        ident = page.evaluate("formatFullId(localReports.find(r => !r.deleted))")
        self.assertEqual(
            page.get_attribute("#reportLogBody .copy-btn", "aria-label"), f"Copy {ident}"
        )
        self.assertEqual(
            page.get_attribute("#reportLogBody .row-selector", "aria-label"), f"Select {ident}"
        )
        # The Identifier is a button: Enter loads the report into the form.
        page.focus("#reportLogBody .id-edit-btn")
        page.keyboard.press("Enter")
        self.assertIn("Updating", page.text_content("#formTitle"))
        page.fill("#size", "3x BTR")
        page.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-size:has-text('3x BTR')")
        history = "#reportLogBody .history-btn[data-history-id]"
        self.assertEqual(page.get_attribute(history, "aria-expanded"), "false")
        page.click(history)
        self.assertEqual(page.get_attribute(history, "aria-expanded"), "true")
        # Sorting from the keyboard; the header says how it sorts.
        self.assertEqual(page.get_attribute("th[data-sort='id']", "aria-sort"), "other")
        page.focus("th[data-sort='size'] .sort-btn")
        page.keyboard.press("Enter")
        self.assertEqual(page.get_attribute("th[data-sort='size']", "aria-sort"), "ascending")
        self.assertEqual(page.get_attribute("th[data-sort='id']", "aria-sort"), "none")
        for box in ("#size", "#activity", "#location", "#time", "#reportStartNum", "#searchBar",
                    "#yourAnalysis", "#atoHistorySelect"):  # fmt: skip
            self.assertTrue(page.get_attribute(box, "aria-label"), box)
        self.assertEqual(
            page.get_attribute("#colorSwatches .color-swatch.selected", "aria-pressed"), "true"
        )

    def test_escape_and_tab_in_dialogs_and_the_settings_menu(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        page.click("#reportLogBody .id-edit-btn")
        page.fill("#size", "3x BTR")
        page.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-size:has-text('3x BTR')")
        page.click("#reportLogBody .history-btn[data-history-id]")
        # The confirmation (Restore's) takes focus on Cancel, keeps Tab inside,
        # and Escape cancels it, giving focus back.
        page.click("#reportLogBody .restore-btn")
        page.wait_for_selector("#confirmationToast.show")
        self.assertEqual(page.evaluate("document.activeElement.id"), "cancelActionBtn")
        page.keyboard.press("Tab")
        page.keyboard.press("Tab")
        self.assertTrue(
            page.evaluate("el.toast.confirm.contains(document.activeElement)"), "Tab stays inside"
        )
        page.keyboard.press("Escape")
        page.wait_for_selector("#confirmationToast.show", state="hidden")
        self.assertEqual(page.evaluate("document.activeElement.className"), "restore-btn")
        self.assertEqual(self.sizes(page), ["3x BTR"])
        # The Settings menu: open says so, arrows move, Escape closes it.
        page.click("#dataMgmtBtn")
        self.assertEqual(page.get_attribute("#dataMgmtBtn", "aria-expanded"), "true")
        self.assertEqual(page.evaluate("document.activeElement.id"), "toggleLayoutBtn")
        page.keyboard.press("ArrowDown")
        self.assertEqual(page.evaluate("document.activeElement.id"), "toggleTimeFormatBtn")
        page.keyboard.press("End")
        self.assertEqual(page.evaluate("document.activeElement.id"), "clearAllBtn")
        page.keyboard.press("Escape")
        self.assertFalse(page.is_visible("#dataMgmtMenu"))
        self.assertEqual(page.get_attribute("#dataMgmtBtn", "aria-expanded"), "false")
        self.assertEqual(page.evaluate("document.activeElement.id"), "dataMgmtBtn")
        # The manual from the menu: focus on Close, back to the menu's button.
        page.click("#dataMgmtBtn")
        page.click("#userManualBtn")
        self.assertEqual(page.evaluate("document.activeElement.id"), "manualCloseBtn")
        page.keyboard.press("Tab")
        self.assertTrue(page.evaluate("el.manual.modal.contains(document.activeElement)"))
        page.keyboard.press("Escape")
        self.assertEqual(page.evaluate("document.activeElement.id"), "dataMgmtBtn")
        # A search with spaces round it still finds; Escape clears it.
        page.fill("#searchBar", "  btr ")
        page.wait_for_timeout(300)
        self.assertEqual(self.sizes(page), ["3x BTR"])
        page.fill("#searchBar", "nothing like it")
        page.wait_for_timeout(300)
        self.assertEqual(self.sizes(page), [])
        page.press("#searchBar", "Escape")
        self.assertEqual(self.sizes(page), ["3x BTR"])

    def test_bda_roll_up_counts_and_filters(self):
        page = self.open_editor()
        self.log(page, "4x T-72, 2x BMP-2", location="18SUJ1111, 18SUJ2222")
        self.log(page, "1x truck")
        page.click("#dataMgmtBtn")
        page.click("#toggleBdaBtn")
        self.assertIn("BDA 0 / 7", page.locator("#bdaRollup").text_content())
        # Assess the first element of the first report as destroyed: all four.
        page.click(
            "#reportLogBody tr[data-id]:has(.col-size:has-text('4x T-72, 2x BMP-2')) .bda-btn"
        )
        page.click(".bda-check-row[data-row='0'] .bda-eff-btn[data-bda-eff='Destroyed']")
        # Note when a pull brings the assessment back from the server.
        page.evaluate(
            """() => { const apply = applyServerUpdate; window.bdaPulled = false;
                applyServerUpdate = (...args) => { apply(...args);
                    if (Object.values((args[0] || {}).workspaces || {}).flat().some(r => (r.bda || []).length === 1)) window.bdaPulled = true; }; }"""
        )
        page.click(".bda-commit-btn")
        page.wait_for_selector("#bdaRollup:has-text('BDA 4 / 7')")
        # Let that save settle: the server has it and this page has pulled it back.
        self.wait_for_server(
            page, "s => Object.values(s.workspaces).flat().some(r => (r.bda || []).length === 1)"
        )
        page.wait_for_function("() => window.bdaPulled && pushesInFlight === 0 && !pullDeferred")
        self.next_frames(page)  # and redrawn
        # One of the two BMP-2s damaged: the other stays on the checklist.
        self.assertEqual(page.input_value(".bda-check-row[data-row='0'] .bda-ck-target"), "BMP-2")
        page.fill(".bda-check-row[data-row='0'] .bda-ck-qty", "1")
        page.click(".bda-check-row[data-row='0'] .bda-eff-btn[data-bda-eff='Damaged']")
        # A redraw (another operator's sync) keeps what was typed and picked,
        # and the cursor stays in the box being typed in.
        page.focus(".bda-check-row[data-row='0'] .bda-ck-target")
        page.evaluate("renderLog()")
        self.assertEqual(page.evaluate("document.activeElement.className"), "bda-ck-target")
        self.assertEqual(page.input_value(".bda-check-row[data-row='0'] .bda-ck-qty"), "1")
        self.assertEqual(page.text_content(".bda-commit-btn"), "Log 1 Assessment")
        page.click(".bda-commit-btn")
        page.wait_for_selector("#bdaRollup:has-text('BDA 5 / 7')")
        self.assertEqual(page.input_value(".bda-check-row[data-row='0'] .bda-ck-qty"), "1")
        self.assertIn("1x BMP-2", page.locator(".bda-list").text_content())
        page.click("#bdaRollup [data-bda-filter='Destroyed']")
        self.assertEqual(self.sizes(page), ["4x T-72, 2x BMP-2"])
        page.click("#bdaRollup [data-bda-filter='Destroyed']")
        self.assertEqual(len(self.sizes(page)), 2)

    def test_a_pull_answered_before_a_save_doesnt_undo_it(self):
        # Regression: a pull asked for before a save and answered after it
        # put the old list back on screen, and the next change saved that.
        page = self.open_editor()
        before = page.evaluate("JSON.parse(JSON.stringify(sharedDrones))")
        old = page.evaluate("async () => (await fetch('/api/sync')).text()")
        name = f"T{int(time.time() * 1000) % 100000}"
        page.evaluate(
            "name => saveDrones([...sharedDrones, { name, grid: '38S MB 40000 78000', at: Date.now() }])",
            name,
        )
        # The old answer arrives now.
        page.evaluate(
            """old => { const real = window.fetch;
                window.fetch = (url, opts) => {
                    if (url !== '/api/sync') return real(url, opts);
                    window.fetch = real;
                    return Promise.resolve(new Response(old, { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }; }""",
            old,
        )
        page.evaluate("() => syncWithServer()")
        self.assertIn(name, page.evaluate("sharedDrones.map(d => d.name)"))
        self.wait_for_server(page, f"s => s.drones.some(d => d.name === '{name}')")
        page.evaluate("list => saveDrones(list)", before)  # the other tests' drones as they were

    def test_a_pull_waits_for_a_shared_list_being_saved(self):
        # Regression: a pull answered while a drone change was on its way put
        # the old list back, and a move made from it then lost the change
        # (seen on CI as a moved drone losing its range).
        page = self.open_editor()
        before = page.evaluate("JSON.parse(JSON.stringify(sharedDrones))")
        old = page.evaluate("async () => (await fetch('/api/sync')).text()")
        held = []
        page.route("**/api/save_drones", lambda route: held.append(route))
        name = f"W{int(time.time() * 1000) % 100000}"
        page.evaluate(
            "name => { window.saving = saveDrones([...sharedDrones, { name, grid: '38S MB 40000 78000', at: Date.now() }]); }",
            name,
        )
        self.wait_until(lambda: held, "the save was never sent", page=page)
        # A pull now, answered with the list from before the save.
        page.evaluate(
            """old => { const real = window.fetch;
                window.fetch = (url, opts) => {
                    if (url !== '/api/sync') return real(url, opts);
                    window.fetch = real;
                    return Promise.resolve(new Response(old, { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }; }""",
            old,
        )
        page.evaluate("() => syncWithServer()")
        self.assertIn(
            name, page.evaluate("sharedDrones.map(d => d.name)"), "the save in flight stands"
        )
        held[0].continue_()
        page.unroute("**/api/save_drones")
        self.assertTrue(page.evaluate("async () => await window.saving"))
        self.wait_for_server(page, f"s => s.drones.some(d => d.name === '{name}')")
        page.wait_for_function(f"sharedDrones.some(d => d.name === '{name}')")
        page.evaluate("list => saveDrones(list)", before)  # the other tests' drones as they were

    def test_the_version_shows_and_another_release_asks_for_a_reload(self):
        page = self.open_editor()
        version = page.evaluate("APP_VERSION")
        self.assertEqual(page.text_content("#appVersion"), f"v{version}")
        self.assertTrue(page.locator("#versionBar").is_hidden(), "the same release")

        def other_release(route):
            state = route.fetch().json()
            route.fulfill(json={**state, "server_version": "9.9.9"})

        page.route("**/api/sync", other_release)
        page.evaluate("() => syncWithServer()")
        page.wait_for_selector("#versionBar:has-text('the server is 9.9.9')")
        self.assertIn(f"This page is version {version}", page.text_content("#versionBar"))
        self.assertTrue(page.locator("#versionReloadBtn").is_visible())

    def test_changes_waiting_say_not_saving_and_closing_asks_first(self):
        page = self.open_editor()
        page.route("**/api/save_reports", lambda route: route.abort())
        self.log(page, "2x BTR")
        self.assertTrue(page.evaluate("changesWaiting()"))
        self.assertTrue(page.locator("#notSavingBar").is_hidden(), "not after a moment")
        page.evaluate("waitingSince = Date.now() - 31000; renderStatusBars()")
        page.wait_for_selector("#notSavingBar:has-text('Not saving')")
        # Closing the tab asks first.
        asked = []
        page.on("dialog", lambda d: (asked.append(d.type), d.dismiss()))
        page.close(run_before_unload=True)
        self.wait_until(lambda: asked, "closing never asked", page=page)
        self.assertEqual(asked, ["beforeunload"])
        self.assertFalse(page.is_closed(), "dismissed, it stays")
        # Sent, it says nothing more.
        page.unroute("**/api/save_reports")
        page.evaluate("() => syncWithServer()")
        self.wait_for_server(page, f"s => (s.workspaces['{self.ato}'] || []).length === 1")
        page.evaluate("renderStatusBars()")
        self.assertTrue(page.locator("#notSavingBar").is_hidden())

    def test_an_unexpected_error_is_said(self):
        page = self.open_editor()
        page.evaluate("setTimeout(() => { throw new Error('boom'); })")
        page.wait_for_selector("#toastNotification.toast-error:has-text('Something went wrong: ')")
        self.assertIn("boom", page.text_content("#toastNotification"))
        self.errors.clear()  # thrown on purpose

    def test_controls_that_show_on_say_so_to_screen_readers(self):
        # Regression: these showed which was on by their look alone.
        pressed = "el => el.getAttribute('aria-pressed')"
        # The welcome screen's presets: a chip picked says so.
        first = self.open_editor()
        self.log(first, "2x BTR")
        fresh = self.browser.new_context(ignore_https_errors=True)
        self.addCleanup(fresh.close)
        page = fresh.new_page()
        page.goto(self.editor + "/")
        page.wait_for_selector("#startupModal.show")
        chips = page.locator("#startupPresetAtos [data-ato]")  # the first five
        chips.first.click()
        self.assertEqual(chips.first.evaluate(pressed), "true")
        page = first
        # Manage's tabs are tabs.
        self.import_overlays(page)  # for the map, below
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='workspaces']")
        selected = "el => el.getAttribute('aria-selected')"
        self.assertEqual(page.eval_on_selector(".ws-tab[data-tab='workspaces']", selected), "true")
        self.assertEqual(page.eval_on_selector(".ws-tab[data-tab='export']", selected), "false")
        # Statistics' scope.
        page.click("#statsViewToggleBtn")
        page.click("[data-stats-scope='all']")
        self.assertEqual(page.eval_on_selector("[data-stats-scope='all']", pressed), "true")
        self.assertEqual(page.eval_on_selector("[data-stats-scope='ato']", pressed), "false")
        # Summary Reports' kind.
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='brief']")
        self.assertEqual(page.eval_on_selector("[data-summary-kind='brief']", pressed), "true")
        self.assertEqual(page.eval_on_selector("[data-summary-kind='rollup']", pressed), "false")
        # The map's hours, and the drone menu's button opens something.
        page.evaluate("showHomeView()")
        self.open_map(page)
        hours = page.locator("[data-map-hours]")
        self.assertEqual(
            sorted(set(hours.evaluate_all("bs => bs.map(b => b.getAttribute('aria-pressed'))"))),
            ["false", "true"],
        )
        page.click("#mapDroneBtn")
        expanded = "el => el.getAttribute('aria-expanded')"
        self.assertEqual(page.eval_on_selector("#mapDroneBtn", expanded), "true")

    def test_the_welcome_screen_leaves_the_field_being_typed_in(self):
        # Regression: 50 ms after opening, it moved the cursor to the first
        # empty field. A sync that had filled in the ATO made that the Title,
        # so an ATO being typed went on in the Title box (seen on CI as an
        # editor starting in the last test's workspace).
        page = self.context.new_page()
        page.goto(self.editor + "/")
        page.wait_for_selector("#startupModal.show")
        page.evaluate(
            """() => { el.startup.overlay.classList.remove('show'); openStartupModal();
                el.startup.ato.value = 'SHOWN'; el.startup.ato.focus(); }"""
        )
        page.wait_for_timeout(150)
        self.assertEqual(page.evaluate("document.activeElement.id"), "startupAto")

    def test_typing_survives_a_sync(self):
        # Regression: every sync re-laid the form out, which took the cursor
        # out of the box being typed in; the rest of the word went nowhere.
        page = self.open_editor()
        page.click("#size")
        page.keyboard.type("2x B")
        page.evaluate("() => syncWithServer()")  # resolves once the pull is applied
        self.next_frames(page)  # and the redraw it scheduled has run
        page.keyboard.type("MP")
        self.assertEqual(page.input_value("#size"), "2x BMP")

    def test_a_sync_leaves_the_workspace_being_changed(self):
        # Regression: a peer's sync rewrote the ATO and title boxes and locked
        # them again while a new workspace was being typed.
        page = self.open_editor()
        page.click("#setAtoBtn")  # Change
        page.fill("#atoDesignator", "SOMEWHERE")
        page.evaluate("() => syncWithServer()")
        page.wait_for_timeout(300)
        self.assertEqual(page.input_value("#atoDesignator"), "SOMEWHERE")
        self.assertFalse(page.evaluate("el.config.ato.readOnly"))

    def test_a_sync_during_a_workspace_switch_brings_no_reports_along(self):
        # Regression: a sync landing while save_config was on its way put the
        # old workspace's reports back in the log, and the next report logged
        # copied them all into the new workspace (seen first on CI).
        page = self.open_editor()
        old = self.ato
        self.log(page, "1x BTR")
        held = []
        page.route("**/api/save_config", lambda route: held.append(route))
        page.click("#setAtoBtn")  # Change
        new = old[:24] + "SWITCH"
        page.fill("#atoDesignator", new)
        page.click("#setAtoBtn")  # Set: save_config is held
        self.wait_until(lambda: held, "save_config was never sent", page=page)
        # The server still says the old workspace.
        page.evaluate("() => syncWithServer()")
        self.assertEqual(page.evaluate("activeAto"), new)
        self.assertEqual(self.sizes(page), [])
        held[0].continue_()
        page.wait_for_selector("#toastNotification:has-text('Configuration synced')")
        self.log(page, "2x BMP")
        self.assertEqual(self.sizes(page), ["2x BMP"])
        self.wait_for_server(
            page, f"s => (s.workspaces['{new}'] || []).map(r => r.size).join() === '2x BMP'"
        )
        self.wait_for_server(
            page, f"s => (s.workspaces['{old}'] || []).map(r => r.size).join() === '1x BTR'"
        )

    def test_a_pull_asked_for_before_a_switch_doesnt_switch_back(self):
        # Regression: a pull asked for before a workspace switch, answered
        # after it, put this editor back in the old workspace (seen on CI as
        # one test's reports showing up in the next).
        page = self.open_editor()
        old = self.ato
        self.log(page, "1x BTR")
        self.wait_for_server(
            page, f"s => (s.workspaces['{old}'] || []).map(r => r.size).join() === '1x BTR'"
        )
        # The next pull is answered now (the old workspace) but arrives later.
        page.evaluate(
            """async () => {
                const answer = await (await fetch('/api/sync')).text();
                const realFetch = window.fetch;
                let release;
                const gate = new Promise(r => { release = r; });
                window.fetch = (url, opts) => {
                    if (url !== '/api/sync') return realFetch(url, opts);
                    window.fetch = realFetch;
                    return gate.then(() => new Response(answer, { status: 200, headers: { 'Content-Type': 'application/json' } }));
                };
                window.releasePull = release;
                window.heldPull = syncWithServer();
            }"""
        )
        new = old[:24] + "LATER"
        page.click("#setAtoBtn")  # Change
        page.fill("#atoDesignator", new)
        page.click("#setAtoBtn")  # Set
        page.wait_for_selector("#toastNotification:has-text('Configuration synced')")
        # The old answer arrives only now.
        self.assertEqual(
            page.evaluate("async () => { releasePull(); await heldPull; return activeAto; }"), new
        )
        self.assertEqual(self.sizes(page), [])
        self.log(page, "2x BMP")
        self.wait_for_server(
            page, f"s => (s.workspaces['{new}'] || []).map(r => r.size).join() === '2x BMP'"
        )
        self.wait_for_server(
            page, f"s => (s.workspaces['{old}'] || []).map(r => r.size).join() === '1x BTR'"
        )

    def test_a_switch_moves_only_the_editor_who_switched(self):
        page = self.open_editor()
        old = self.ato
        self.log(page, "1x BTR")
        other = self.second_editor("CD", old)
        other.wait_for_selector("#reportLogBody .col-size:has-text('1x BTR')")
        viewer = self.open_viewer()
        new = old[:24] + "MINE"
        page.click("#setAtoBtn")  # Change
        page.fill("#atoDesignator", new)
        page.click("#setAtoBtn")  # Set
        page.wait_for_selector("#toastNotification:has-text('Configuration synced')")
        self.log(page, "2x BMP")
        # The other editor stays where they were, with their reports.
        other.wait_for_function(f"Object.keys(reportsByAto).includes('{new}')")
        self.assertEqual(other.evaluate("activeAto"), old)
        self.assertEqual(other.input_value("#atoDesignator"), old)
        self.assertEqual(self.sizes(other), ["1x BTR"])
        # Viewers are shown the workspace switched to last.
        viewer.wait_for_function(f"activeAto === '{new}'")
        # And the chip says who is where (every page here is one machine).
        page.wait_for_function(
            f"document.querySelector('#connectedUsers').title.endsWith(' in {new}')"
        )
        # A sync leaves each where they are.
        other.evaluate("() => syncWithServer()")
        page.evaluate("() => syncWithServer()")
        self.assertEqual((page.evaluate("activeAto"), other.evaluate("activeAto")), (new, old))

    def test_a_workspace_unloaded_by_someone_else_is_left(self):
        page = self.open_editor()
        self.log(page, "1x BTR")
        other = self.second_editor("CD", self.ato)
        other.wait_for_selector("#reportLogBody .col-size:has-text('1x BTR')")
        other.click("#dataMgmtBtn")
        other.click("#clearAllBtn")
        other.click("#clearAllBtn")
        page.wait_for_selector("#toastNotification:has-text('was unloaded by another operator')")
        self.assertEqual(page.evaluate("activeAto"), "")
        self.assertEqual(self.sizes(page), [])
        self.assertFalse(page.evaluate("el.config.ato.readOnly"), "the fields are open to set one")
        # Set again, it's back in use, and a sync doesn't move this editor out.
        page.fill("#atoDesignator", self.ato)
        page.fill("#reportTitlePrefix", "Patrol")
        page.click("#setAtoBtn")
        page.wait_for_selector("#toastNotification:has-text('Configuration synced')")
        self.wait_for_server(page, f"s => !s.unloaded.includes('{self.ato}')")
        self.log(page, "2x BMP")
        page.evaluate("() => syncWithServer()")
        self.assertEqual(page.evaluate("activeAto"), self.ato)

    def test_an_edit_is_saved_once(self):
        # Edit sent edit_report and then save_reports with the same change.
        page = self.open_editor()
        self.log(page, "2x BTR")
        self.wait_for_server(page, f"s => (s.workspaces['{self.ato}'] || []).length === 1")
        sent = []
        page.on(
            "request",
            lambda r: sent.append(r.url.rsplit("/", 1)[1]) if r.method == "POST" else None,
        )
        page.click("#reportLogBody .id-edit-btn")
        page.fill("#size", "3x BTR")
        page.click("#editButton")
        self.wait_for_server(
            page, f"s => s.workspaces['{self.ato}'].map(r => r.size).join() === '3x BTR'"
        )
        page.wait_for_timeout(300)
        self.assertEqual(sent, ["edit_report"])
        # Not reachable, it is sent with the rest when the server is back.
        page.route("**/api/edit_report", lambda route: route.abort())
        page.click("#reportLogBody .id-edit-btn")
        page.fill("#size", "4x BTR")
        page.click("#editButton")
        self.wait_for_server(
            page, f"s => s.workspaces['{self.ato}'].map(r => r.size).join() === '4x BTR'"
        )
        self.assertEqual(sent[1:], ["edit_report", "save_reports"])

    def test_reports_sharing_a_number_are_flagged_and_renumbered(self):
        page = self.open_editor()
        self.log(page, "1x BTR")
        # Logged at once on another machine, with the same number.
        twin = page.evaluate(
            """ato => { const r = localReports[0];
                return { ...r, id: 'twin-' + r.id, size: '2x BMP', lastModified: Date.now() }; }""",
            self.ato,
        )
        page.evaluate(
            """([ato, twin]) => fetch('/api/save_reports', { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ato, reports: [twin] }) })""",
            [self.ato, twin],
        )
        page.wait_for_function(
            "document.querySelectorAll('#reportLogBody .dupe-badge').length === 2"
        )
        self.assertEqual(page.locator("#reportLogBody .renumber-btn").count(), 2)
        viewer = self.open_viewer()
        viewer.wait_for_function(
            "document.querySelectorAll('#reportLogBody .dupe-badge').length === 2"
        )
        self.assertEqual(viewer.locator("#reportLogBody .renumber-btn").count(), 0, "editors only")
        page.click("#reportLogBody tr:has(.col-size:has-text('2x BMP')) .renumber-btn")
        page.wait_for_selector("#toastNotification:has-text('is now Patrol')")
        self.wait_for_server(
            page,
            f"s => s.workspaces['{self.ato}'].map(r => r.displayId).sort().join() === "
            f"'{self.ato}001,{self.ato}002'",
        )
        page.wait_for_function("!document.querySelector('#reportLogBody .dupe-badge')")
        # A renumber is an edit: no update entry.
        self.assertEqual(
            page.evaluate("localReports.find(r => r.size === '2x BMP').history.length"), 0
        )

    def test_the_form_says_when_someone_else_updates_the_report_in_it(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        other = self.second_editor("CD", self.ato)
        other.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        page.click("#reportLogBody .id-edit-btn")
        self.assertTrue(page.is_hidden("#formPeerNote"), "nothing to say yet")
        other.click("#reportLogBody .id-edit-btn")
        other.fill("#size", "3x BTR")
        other.click("#updateButton")
        page.wait_for_selector("#formPeerNote:has-text('CD updated this report just now')")
        # What was typed stays; the line only says so.
        self.assertEqual(page.input_value("#size"), "2x BTR")
        # Another report, or none, and it goes.
        page.click("#cancelButton")
        self.assertTrue(page.is_hidden("#formPeerNote"))

    def test_an_update_asks_when_someone_else_changed_the_report(self):
        # Regression: Edit and Update wrote over a peer's newer change, silently.
        page = self.open_editor()
        self.log(page, "2x BTR")
        other = self.second_editor("CD", self.ato)
        other.wait_for_selector("#reportLogBody .col-size:has-text('2x BTR')")
        page.click("#reportLogBody .id-edit-btn")
        # Someone else updates it while it is in this form.
        other.click("#reportLogBody .id-edit-btn")
        other.fill("#size", "3x BTR")
        other.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-size:has-text('3x BTR')")
        page.fill("#activity", "Moving S")
        page.click("#updateButton")
        page.wait_for_selector(
            "#choiceToast.show:has-text('CD changed this report since you opened it')"
        )
        page.click("#choiceButtons button:text-is('Keep theirs')")
        self.assertEqual(
            (page.input_value("#size"), page.input_value("#activity")), ("3x BTR", "Moving N")
        )
        # The server holding a newer version (409) asks the same; Overwrite
        # saves this one over it.
        answered = []

        def newer_on_the_server(route):
            if answered:
                route.continue_()
                return
            answered.append(route.request.url)
            self.refuse("A newer version is saved.", status=409)(route)

        page.route("**/api/edit_report", newer_on_the_server)
        page.fill("#size", "4x BTR")
        page.click("#editButton")
        page.wait_for_selector(
            "#choiceToast.show:has-text('changed this report since you opened it')"
        )
        page.click("#choiceButtons button:text-is('Overwrite theirs')")
        self.wait_for_server(
            page, f"s => s.workspaces['{self.ato}'].some(r => r.size === '4x BTR')"
        )
        self.assertEqual(len(answered), 1)

    # -- overlays and ArcGIS -------------------------------------------------- #
    def overlay_kmz(self) -> Path:
        """A KMZ as ArcGIS's Layer To KML writes one: NAI 1 and NAI 2 side by
        side, an untyped area, and a phase line across both NAIs (near 38S MB)."""
        c = {
            "a": "44.355845,33.257333", "b": "44.463201,33.257843", "c": "44.570559,33.25826",
            "d": "44.355182,33.347527", "e": "44.462648,33.348039", "f": "44.570116,33.348457",
            "g": "44.408914,33.347794", "h": "44.408609,33.392891", "i": "44.354849,33.392623",
            "p1": "44.355514,33.30243", "p2": "44.570338,33.303359",
        }  # fmt: skip

        def area(name, *corners):
            ring = " ".join(c[k] for k in (*corners, corners[0]))
            return (
                f"<Placemark><name>{name}</name><Polygon><outerBoundaryIs><LinearRing>"
                f"<coordinates>{ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"
            )

        kml = (
            '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2">'
            "<Document><name>ops</name><Folder><name>NAIs</name>"
            + area("NAI 1", "a", "b", "e", "d")
            + area("2", "b", "c", "f", "e")
            + "</Folder>"
            + area("Bridge", "d", "g", "h", "i")
            + "<Folder><name>Phase Lines</name><Placemark><name>BLUE</name><LineString>"
            f"<coordinates>{c['p1']} {c['p2']}</coordinates></LineString></Placemark></Folder>"
            "</Document></kml>"
        )
        path = self.tmp / f"{self._testMethodName}.kmz"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("doc.kml", kml)
        return path

    def import_overlays(self, page):
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        page.set_input_files("#overlaysFileInput", str(self.overlay_kmz()))
        page.wait_for_selector("#overlaysBody .overlay-type-select")
        # Typed by name, folder, and folder; the untyped area waits for a choice.
        self.assertEqual(
            page.locator("#overlaysBody tbody td:nth-child(4)").all_text_contents(),
            ["NAI 1", "NAI 2", "skipped", "PL BLUE"],
        )
        page.select_option("[data-review-idx='2']", "OBJ")
        page.click("#overlaysReviewAddBtn")
        page.wait_for_selector("#toastNotification:has-text('Imported 4 overlays')")
        page.click("#exportViewToggleBtn")

    def test_overlays_place_reports_and_reach_viewers(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "1x BTR", location="38SMB4500082000")
        self.log(page, "2x BMP", location="38S MB 55000 82000, NAI 1", choice="Keep NAI 1")
        self.log(page, "3x T-72", location="38SMB4200092000")
        self.log(page, "4x BRDM", location="38SMB4500085200")  # about 250 m from PL BLUE

        def row(size):
            return f"#reportLogBody tr[data-id]:has(.col-size:has-text('{size}'))"

        def place(p, size):
            loc = p.locator(f"{row(size)} .col-location")
            return [
                loc.evaluate("td => td.firstChild.textContent"),
                loc.locator(".loc-tag").all_text_contents(),
            ]

        # Logging names the places the grid is in; the kept disagreement is tagged.
        self.assertEqual(place(page, "1x BTR"), ["38SMB4500082000, NAI 1", []])
        self.assertEqual(
            place(page, "2x BMP"),
            ["38S MB 55000 82000, NAI 1", ["Check: NAI 1 typed; grid is in NAI 2"]],
        )
        self.assertEqual(place(page, "3x T-72"), ["38SMB4200092000, OBJ BRIDGE", []])
        self.assertEqual(place(page, "4x BRDM"), ["38SMB4500085200, NAI 1, PL BLUE", []])
        # Synced: the server holds them, and a viewer tags the same way
        # without keeping a copy (and can't settle a check).
        self.wait_for_server(page, "s => s.overlays.length === 4")
        viewer = self.open_viewer()
        viewer.wait_for_selector("#reportLogBody span.loc-tag.warn")
        self.assertEqual(viewer.locator("#reportLogBody button.loc-tag").count(), 0)
        self.assertIsNone(viewer.evaluate("localStorage.getItem('salt_overlays')"))
        # The editor settles the check from its tag: saved as an Update.
        page.click(f"{row('2x BMP')} button.loc-tag.warn")
        page.click("#choiceButtons button:text-is('Use NAI 2')")
        page.wait_for_selector(f"{row('2x BMP')} .col-location:has-text('NAI 2')")
        self.assertEqual(place(page, "2x BMP"), ["38S MB 55000 82000, NAI 2", []])
        self.assertEqual(page.locator(f"{row('2x BMP')} .loc-tag").count(), 0)
        self.assertIn("(Updated)", page.locator(f"{row('2x BMP')} .col-id").text_content())

    def test_the_location_box_shows_what_logging_adds(self):
        page = self.open_editor()
        self.import_overlays(page)
        page.fill("#location", "38SMB4500085200")
        page.wait_for_selector("#locationHints:not([hidden])")
        hints = [
            " ".join(t.split())
            for t in page.locator("#locationHints .loc-hint").all_text_contents()
        ]
        self.assertEqual(hints[0], "+ NAI 1")
        self.assertRegex(hints[1], r"^\+ PL BLUE \d+ m$")
        page.click("#locationHints [data-loc-add='PL BLUE']")
        self.assertEqual(page.input_value("#location"), "38SMB4500085200, PL BLUE")
        page.fill("#location", "38S MB 55000 82000, NAI 1")
        page.wait_for_selector(
            "#locationHints .loc-hint.warn:has-text('NAI 1 typed; grid is in NAI 2')"
        )
        # Cancel at the prompt: nothing is logged, and the box keeps what was typed.
        page.fill("#size", "9x PAX")
        page.fill("#activity", "dug in")
        page.click("#logButton")
        page.click("#choiceButtons button:text-is('Cancel')")
        self.assertEqual(self.sizes(page), [])
        self.assertEqual(page.input_value("#location"), "38S MB 55000 82000, NAI 1")
        page.click("#logButton")
        page.click("#choiceButtons button:text-is('Keep both')")
        page.wait_for_selector("#reportLogBody .col-size:has-text('9x PAX')")
        self.assertEqual(
            page.locator("#reportLogBody .col-location").first.evaluate(
                "td => td.firstChild.textContent"
            ),
            "38S MB 55000 82000, NAI 1, NAI 2",
        )

    def test_export_for_arcgis(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000 38SMB5500082000")
        self.log(page, "1x truck", activity="parked", location="vic the bridge")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")  # the panel reopens on the last tab used
        with page.expect_download() as dl:
            self.run_io(page, "arcgis-geojson")
        self.assertTrue(dl.value.suggested_filename.endswith("_arcgis.geojson"))
        data = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
        props = [f["properties"] for f in data["features"]]
        # Two grids, two points; the report without a grid is left out.
        self.assertEqual([p["mgrs"] for p in props], ["38S MB 45000 82000", "38S MB 55000 82000"])
        self.assertEqual([p["nai"] for p in props], ["NAI 1; NAI 2"] * 2)
        self.assertEqual(props[0]["nai_from"], "typed", "logging named them")
        self.assertEqual((props[0]["heading"], props[0]["heading_deg"]), ("N", 0))
        self.assertEqual(props[0]["pl_near"], "PL BLUE")
        lon, lat = data["features"][0]["geometry"]["coordinates"]
        self.assertAlmostEqual(lat, 33.2759, places=3)
        self.assertAlmostEqual(lon, 44.4096, places=3)
        self.assertIn(
            "1 without a readable grid", page.locator("#toastNotification").text_content()
        )
        # Esri JSON: the same points, every field's type written out.
        with page.expect_download() as dl:
            self.run_io(page, "arcgis-esri")
        self.assertTrue(dl.value.suggested_filename.endswith("_arcgis.json"))
        esri = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
        self.assertEqual(esri["geometryType"], "esriGeometryPoint")
        self.assertEqual(
            [f["attributes"]["mgrs"] for f in esri["features"]],
            ["38S MB 45000 82000", "38S MB 55000 82000"],
        )
        self.assertAlmostEqual(esri["features"][0]["geometry"]["y"], 33.2759, places=3)
        # Shapefile: a zip of its parts, which ArcGIS Pro drags in once unzipped.
        with page.expect_download() as dl:
            self.run_io(page, "arcgis-shp")
        self.assertTrue(dl.value.suggested_filename.endswith("_arcgis.zip"))
        with zipfile.ZipFile(dl.value.path()) as z:
            names = sorted(z.namelist())
            self.assertEqual(
                [n.rsplit(".", 1)[1] for n in names], ["cpg", "dbf", "prj", "shp", "shx"]
            )
            stem = names[0].rsplit(".", 1)[0]
            self.assertRegex(stem, r"^[A-Za-z][A-Za-z0-9_]*$")
            shp, dbf = z.read(stem + ".shp"), z.read(stem + ".dbf")
        self.assertEqual(struct.unpack(">i", shp[:4])[0], 9994)
        self.assertEqual(struct.unpack("<i", shp[32:36])[0], 1, "points")
        self.assertEqual(struct.unpack("<I", dbf[4:8])[0], 2, "two points")
        self.assertIn(b"38S MB 45000 82000", dbf)

    def test_overlays_are_shared_and_unload_by_group(self):
        page = self.open_editor()
        self.import_overlays(page)
        # Another workspace has the same overlays, with nothing to import.
        second = self.browser.new_context(
            ignore_https_errors=True
        )  # another browser: storage of its own
        self.addCleanup(second.close)
        other = second.new_page()
        other.on("pageerror", lambda exc: self.errors.append(str(exc)))
        other.goto(self.editor + "/")
        other.fill("#startupInitials", "CD")
        other.fill("#startupAto", "SHAREDTWO")
        other.fill("#startupTitle", "Patrol")
        other.click("#startupContinueBtn")
        other.wait_for_selector("#startupModal.show", state="hidden")
        self.log(other, "1x BTR", location="38SMB4500082000")
        other.wait_for_selector("#reportLogBody .col-location:has-text('38SMB4500082000, NAI 1')")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        groups = page.locator(".overlay-group").evaluate_all(
            "gs => gs.map(g => g.dataset.overlayGroup)"
        )
        self.assertEqual(groups, ["NAI", "OBJ", "PL"])
        # Each list is folded to start with; Unload in its header doesn't open it.
        self.assertEqual(page.locator(".overlay-group[open]").count(), 0)
        self.assertFalse(
            page.locator(
                ".overlay-group[data-overlay-group='OBJ'] .overlay-remove"
            ).first.is_visible()
        )
        page.click("[data-unload-group='PL']")
        self.assertEqual(page.text_content("[data-unload-group='PL']"), "Unload PLs for everyone?")
        self.assertEqual(page.locator(".overlay-group[data-overlay-group='PL'][open]").count(), 0)
        page.click("[data-unload-group='PL']")
        page.wait_for_selector(".overlay-group[data-overlay-group='PL']", state="detached")
        self.assertEqual(page.locator(".overlay-group[open]").count(), 0)
        page.wait_for_selector("#toastNotification:has-text('1 PL overlay unloaded.')")
        page.click("[data-overlay-fold='open']")
        self.assertEqual(page.locator(".overlay-group:not([open])").count(), 0, "all open")
        page.click("[data-overlay-fold='close']")
        self.assertEqual(page.locator(".overlay-group[open]").count(), 0, "all closed")
        page.click(".overlay-group[data-overlay-group='OBJ'] summary")
        # The × asks first (see test_an_overlay_is_removed_on_the_second_press).
        page.click(".overlay-group[data-overlay-group='OBJ'] .overlay-remove")
        page.click(".overlay-group[data-overlay-group='OBJ'] .overlay-remove")
        self.wait_for_server(
            page, "s => s.overlays.map(o => o.type + ' ' + o.name).join() === 'NAI 1,NAI 2'"
        )

    def test_an_overlay_is_removed_on_the_second_press(self):
        # Regression: one press of the × removed it for everyone.
        page = self.open_editor()
        self.import_overlays(page)
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        page.click("[data-overlay-fold='open']")
        nai1 = ".overlay-group[data-overlay-group='NAI'] tr:has([aria-label='Unload NAI 1'])"
        box = page.locator(nai1).bounding_box()
        page.click(f"{nai1} .overlay-remove")
        # Its name asks, in red, and nothing on the row moves.
        page.wait_for_selector(f"{nai1} .map-base-ask:has-text('Remove for everyone?')")
        self.assertEqual(page.locator(nai1).bounding_box(), box)
        here = "currentOverlays().some(o => o.type === 'NAI' && o.name === '1')"
        self.assertTrue(page.evaluate(here))
        # Any other button lets it go.
        page.click("[data-overlay-fold='open']")
        self.assertEqual(page.locator("#overlaysBody .map-base-ask").count(), 0)
        page.click(f"{nai1} .overlay-remove")
        page.click(f"{nai1} .overlay-remove")
        self.wait_for_server(page, "s => !s.overlays.some(o => o.type === 'NAI' && o.name === '1')")
        self.assertFalse(page.evaluate(here))
        # Undo puts it back, for everyone.
        page.wait_for_selector("#toastNotification:has-text('NAI 1 removed')")
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector("#toastNotification:has-text('NAI 1 put back')")
        self.wait_for_server(page, "s => s.overlays.some(o => o.type === 'NAI' && o.name === '1')")

    def test_unload_all_overlays_asks_on_the_button_and_undo_puts_them_back(self):
        page = self.open_editor()
        self.import_overlays(page)
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        page.click("#overlaysClearBtn")
        self.assertEqual(page.text_content("#overlaysClearBtn"), "Unload all for everyone?")
        self.assertEqual(page.evaluate("document.activeElement.id"), "overlaysClearBtn")
        self.assertEqual(page.evaluate("askSaid.textContent"), "Unload all for everyone?")
        self.assertFalse(page.is_visible("#confirmationToast"))
        self.assertEqual(page.evaluate("currentOverlays().length"), 4, "not yet")
        page.evaluate("window.kept = currentOverlays().map(o => ({ ...o }))")
        page.click("#overlaysClearBtn")
        page.wait_for_selector("#toastNotification:has-text('Every overlay unloaded')")
        self.wait_for_server(page, "s => s.overlays.length === 0")
        # One imported meanwhile stays, beside the four put back.
        page.evaluate("saveOverlays([{ ...kept[0], name: '9', label: '' }])")
        self.wait_for_server(page, "s => s.overlays.length === 1")
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector("#toastNotification:has-text('4 overlays put back')")
        self.wait_for_server(page, "s => s.overlays.length === 5")
        page.evaluate("saveOverlays(currentOverlays().filter(o => o.name !== '9'))")
        self.wait_for_server(page, "s => s.overlays.length === 4")

    def test_a_narrative_entry_removed_comes_back_with_undo(self):
        page = self.open_editor()
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='narrative']")
        unit = "u => ({ name: u, places: [], kinds: [] })"
        page.evaluate(f"saveNarrative({{ units: ['A-1', 'B-2'].map({unit}) }})")
        page.click("[data-narr-id='a-1']")
        page.fill("#narrUnitName", "A-1 typed")
        # Remove asks on its own face; what was typed in the form stays.
        page.click("[data-narr-remove]")
        self.assertEqual(page.text_content("[data-narr-remove]"), "Remove for everyone?")
        self.assertEqual(page.input_value("#narrUnitName"), "A-1 typed")
        self.assertTrue(page.evaluate("document.activeElement.hasAttribute('data-narr-remove')"))
        page.click("[data-narr-remove]")
        page.wait_for_selector("#toastNotification:has-text('A-1 removed')")
        self.wait_for_server(page, "s => s.narrative.units.map(u => u.name).join() === 'B-2'")
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector("#toastNotification:has-text('A-1 put back')")
        self.wait_for_server(page, "s => s.narrative.units.map(u => u.name).join() === 'A-1,B-2'")
        page.evaluate("saveNarrative({ enemy: '', units: [], equipment: [], off: [], custom: [] })")

    def test_a_synced_color_cant_add_css(self):
        page = self.open_editor()
        page.evaluate(
            """() => {
                localProfiles = { ZZ: { initials: 'ZZ', color: 'red;background:url(https://example.invalid/x.png)' } };
                renderStartupPresets();
            }"""
        )
        chip = "#startupPresetProfiles [data-initials='ZZ']"
        self.assertNotIn("url(", page.get_attribute(f"{chip} .chip-dot", "style"))
        self.assertEqual(page.get_attribute(chip, "data-color"), "#0a84ff")

    def test_statistics_across_every_ato(self):
        page = self.open_editor(ato="SCOPEA")
        self.log(page, "1x BTR")
        self.log(page, "2x BMP")
        page.click("#setAtoBtn")  # Change: unlocks the fields
        page.fill("#atoDesignator", "SCOPEB")
        page.click("#setAtoBtn")
        page.wait_for_function("() => activeAto === 'SCOPEB'")
        self.log(page, "3x T-72")
        page.click("#statsViewToggleBtn")
        page.click("[data-stats-scope='ato']")
        self.assertEqual(page.locator(".stats-card[data-chart='ato']").count(), 0)
        self.assertIn("SCOPEB", page.text_content("#statsPanelSubtitle"))
        page.click("[data-stats-scope='all']")
        page.wait_for_selector(".stats-card[data-chart='ato']")
        self.assertIn("All ATOs", page.text_content("#statsPanelSubtitle"))
        page.click(".stats-card[data-chart='ato'] [data-stats-act='table']")
        rows = page.locator(".stats-card[data-chart='ato'] .stats-table tbody tr").all_inner_texts()
        counts = dict(r.split("	") for r in rows)
        self.assertEqual((counts.get("SCOPEA"), counts.get("SCOPEB")), ("2", "1"))

    def test_export_and_import_share_one_screen(self):
        page = self.open_editor()
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        shown = lambda sel: page.locator(sel).is_visible()  # noqa: E731
        # Export and Import together: no switch between them.
        self.assertEqual(page.locator("[data-io-mode]").count(), 0)
        self.assertTrue(shown("#ioDrop"))
        page.select_option("#ioFormatSelect", "backup")
        self.assertEqual(page.text_content("#ioRunBtn"), "Export")
        self.assertEqual((shown("#exportAllAtosToggle"), shown("#exportMtiToggle")), (True, False))
        page.select_option("#ioFormatSelect", "csv")
        self.assertEqual((shown("#exportAllAtosToggle"), shown("#exportMtiToggle")), (False, True))
        page.select_option("#ioFormatSelect", "arcgis-esri")
        self.assertFalse(shown("#exportMtiToggle"))
        self.assertTrue(shown("#exportFromDate"))
        # Clear sits in the card's header, always there, and empties the range.
        self.assertEqual(page.locator(".io-time .io-card-head #exportClearFilterBtn").count(), 1)
        self.assertTrue(shown("#exportClearFilterBtn"))
        page.click("[data-preset-hours='24']")
        self.assertNotEqual(page.input_value("#exportFromDate"), "")
        self.assertNotEqual(page.input_value("#exportFromDate"), page.input_value("#exportToDate"))
        page.click("#exportClearFilterBtn")
        self.assertEqual(page.input_value("#exportFromDate"), "")
        self.assertTrue(shown("#exportClearFilterBtn"))
        # The list holds exports only; clicking the drop area chooses files to import.
        options = page.locator("#ioFormatSelect option").evaluate_all("os => os.map(o => o.value)")
        self.assertNotIn("overlays", options)
        with page.expect_file_chooser() as fc:
            page.click("#ioDrop")
        self.assertTrue(fc.value.is_multiple())
        # The choice is remembered; viewers only export.
        page.reload()
        page.wait_for_function("() => isManageViewActive")  # the view on screen is restored too
        page.click(".ws-tab[data-tab='export']")
        self.assertEqual(page.input_value("#ioFormatSelect"), "arcgis-esri")
        viewer = self.open_viewer()
        viewer.click("#exportViewToggleBtn")
        self.assertFalse(viewer.locator("#ioDrop").is_visible())
        self.assertEqual(viewer.text_content("#ioRunBtn"), "Export")

    def test_import_by_dropping_a_file(self):
        page = self.open_editor()
        self.log(page, "2x BTR")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        with page.expect_download() as dl:
            self.run_io(page, "backup")
        backup = Path(dl.value.path()).read_text(encoding="utf-8")
        # A file dropped anywhere on the tab is imported as what it is.
        tab = "#exportPanel [data-tab-panel='export']"
        dt = page.evaluate_handle(
            "(text) => { const dt = new DataTransfer(); dt.items.add(new File([text], 'Patrol backup.txt')); return dt; }",
            backup,
        )
        page.dispatch_event(tab, "dragover", {"dataTransfer": dt})
        self.assertIn("io-dropping", page.get_attribute(tab, "class"))
        page.dispatch_event(tab, "drop", {"dataTransfer": dt})
        # The file is read first, then the prompt asks.
        page.wait_for_selector("#confirmationMessage:has-text('backup file')")
        page.click("#confirmActionBtn")
        page.wait_for_selector("#toastNotification:has-text('Import successful')")
        # Chosen from the drop area: a CSV goes to column matching...
        if not page.evaluate("isManageViewActive"):
            page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        csv = self.tmp / "other tool.csv"
        csv.write_text("Name,Count,MGRS\nA1,2x BTR,18SUJ1234\n", encoding="utf-8")
        page.set_input_files("#ioDropInput", str(csv))
        page.wait_for_selector("#csvImportPanel", state="visible")
        self.assertIn("other tool.csv", page.text_content("#csvImportSubtitle"))
        page.click("#closeCsvImportBtn")
        # ...and overlay files to the Overlays tab, to review.
        if not page.evaluate("isManageViewActive"):
            page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        page.set_input_files("#ioDropInput", str(self.overlay_kmz()))
        page.wait_for_selector("#overlaysBody .overlay-type-select")
        # A CSV and an overlay together can't go in as one import.
        page.click(".ws-tab[data-tab='export']")
        page.set_input_files("#ioDropInput", [str(csv), str(self.overlay_kmz())])
        page.wait_for_selector("#toastNotification:has-text('Drop one backup or CSV at a time')")

    def test_backup_import_merges_report_by_report(self):
        # Regression: importing replaced each workspace in the file whole, so
        # whatever was logged or updated since the backup went.
        page = self.open_editor()
        self.log(page, "2x BTR")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        with page.expect_download() as dl:
            self.run_io(page, "backup")
        backup = self.tmp / f"{self._testMethodName}.txt"
        backup.write_text(Path(dl.value.path()).read_text(encoding="utf-8"), encoding="utf-8")
        page.click("#exportViewToggleBtn")
        # Since the backup: one report logged, the other updated.
        self.log(page, "3x T-72")
        page.click("#reportLogBody tr:has(.col-size:has-text('2x BTR')) .id-edit-btn")
        page.fill("#size", "5x BTR")
        page.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-size:has-text('5x BTR')")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        page.set_input_files("#ioDropInput", str(backup))
        page.wait_for_selector(
            "#confirmationMessage:has-text('A report in both keeps whichever version is newer')"
        )
        page.click("#confirmActionBtn")
        page.wait_for_selector("#toastNotification:has-text('Import successful')")
        self.assertEqual(
            page.evaluate(
                f"reportsByAto['{self.ato}'].filter(r => !r.deleted).map(r => r.size).sort()"
            ),
            ["3x T-72", "5x BTR"],
        )
        self.wait_for_server(
            page,
            f"s => s.workspaces['{self.ato}'].filter(r => !r.deleted).map(r => r.size).sort().join() === '3x T-72,5x BTR'",
        )

    def test_send_to_ato_keeps_the_reports_until_the_destination_has_them(self):
        # Regression: Send took the reports out of IMPORT first and never
        # checked that the destination got them.
        page = self.open_editor()
        self.log(page, "1x BTR")
        dest = self.ato
        csv = self.tmp / f"{self._testMethodName}.csv"
        csv.write_text("Name,Count,MGRS\nA1,2x SENT,18SUJ1234\n", encoding="utf-8")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        page.set_input_files("#ioDropInput", str(csv))
        page.wait_for_selector("#csvImportPanel", state="visible")
        page.select_option("#csvDestSelect", "IMPORT")
        page.click("#csvConfirmBtn")
        # Work in IMPORT, as everyone's active workspace (a sync keeps it).
        page.click("#setAtoBtn")
        page.fill("#atoDesignator", "IMPORT")
        page.fill("#reportTitlePrefix", "IMPORT")
        page.click("#setAtoBtn")
        page.wait_for_function("() => activeAto === 'IMPORT'")
        sent = "#reportLogBody tr[data-id]:has(.col-size:has-text('2x SENT'))"
        page.check(f"{sent} .row-selector")
        page.select_option("#sendToAtoSelect", dest)

        def destination_down(route):
            if json.loads(route.request.post_data or "{}").get("ato") == dest:
                self.refuse("Down.", status=500)(route)
            else:
                route.continue_()

        page.route("**/api/save_reports", destination_down)
        page.click("#sendToAtoBtn")
        page.wait_for_selector("#toastNotification:has-text('Not moved')")
        self.assertTrue(page.is_visible(sent), "still in IMPORT")
        self.assertTrue(page.is_checked(f"{sent} .row-selector"), "and still checked")
        page.unroute("**/api/save_reports")
        page.click("#sendToAtoBtn")
        page.wait_for_selector(f"#toastNotification:has-text('Moved 1 report(s) to {dest}')")
        page.wait_for_selector(sent, state="detached")
        self.wait_for_server(
            page,
            f"s => s.workspaces['{dest}'].some(r => r.size === '2x SENT')"
            " && s.workspaces['IMPORT'].every(r => r.size !== '2x SENT' || r.deleted)",
        )

    def test_horizontal_layout_fits_the_window(self):
        page = self.open_editor()
        page.set_viewport_size({"width": 1280, "height": 800})
        page.click("#dataMgmtBtn")
        page.click("#toggleLayoutBtn")
        box = page.evaluate(
            """() => {
                const r = s => document.querySelector(s).getBoundingClientRect();
                return { form: r('.form-section'), report: r('.report-section'), table: r('.table-wrapper'),
                         size: r('#size'), location: r('#location'), log: r('#logButton') };
            }"""
        )
        # The form is one compact band: the fields and Log share a row.
        self.assertLess(box["form"]["height"], 320)
        self.assertAlmostEqual(box["size"]["top"], box["location"]["top"], delta=1)
        self.assertAlmostEqual(box["size"]["top"], box["log"]["top"], delta=1)
        # The log fills the rest of the window, and its table stays inside it.
        self.assertLessEqual(box["report"]["bottom"], 800)
        self.assertLessEqual(box["table"]["bottom"], box["report"]["bottom"])
        self.assertGreater(box["table"]["height"], 250)
        # The views stay one click away, and the Settings menu fits its panel.
        page.click("#statsViewToggleBtn")
        self.assertEqual(page.get_attribute("#statsViewToggleBtn", "aria-pressed"), "true")
        page.click("#statsViewToggleBtn")
        page.click("#dataMgmtBtn")
        menu = page.locator("#dataMgmtMenu").bounding_box()
        report = page.locator(".report-section").bounding_box()
        self.assertLessEqual(menu["y"] + menu["height"], report["y"] + report["height"])
        page.locator("#clearAllBtn").scroll_into_view_if_needed()
        self.assertTrue(page.locator("#clearAllBtn").is_visible())

    def shapefile_parts(self) -> dict[str, bytes]:
        """A small shapefile as ArcGIS writes one, far from the other tests'
        overlays: an area named OBJ IRON with a hole, in WGS 1984."""
        outer = [(10.0, 10.0), (10.0, 10.2), (10.2, 10.2), (10.2, 10.0), (10.0, 10.0)]  # clockwise
        hole = [(10.05, 10.05), (10.1, 10.05), (10.1, 10.1), (10.05, 10.1), (10.05, 10.05)]
        pts = outer + hole
        content = struct.pack("<i4d2i", 5, 10.0, 10.0, 10.2, 10.2, 2, len(pts))
        content += struct.pack("<2i", 0, len(outer)) + b"".join(struct.pack("<2d", *p) for p in pts)
        record = struct.pack(">2i", 1, len(content) // 2) + content
        total = 100 + len(record)
        head = struct.pack(">7i", 9994, 0, 0, 0, 0, 0, total // 2) + struct.pack(
            "<2i4d4d", 1000, 5, 10.0, 10.0, 10.2, 10.2, 0, 0, 0, 0
        )
        name = "OBJ IRON".ljust(20).encode()
        dbf = struct.pack("<B3BIHH20x", 3, 126, 10, 26, 1, 65, 21)
        dbf += b"NAME".ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([20, 0]) + b"\0" * 14 + b"\r"
        dbf += b" " + name + b"\x1a"
        prj = (
            'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
            'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
        )
        return {
            "Objectives.shp": head + record,
            "Objectives.dbf": dbf,
            "Objectives.prj": prj.encode(),
        }

    def test_shapefile_import(self):
        page = self.open_editor()
        before = page.evaluate("() => sharedOverlays")
        parts = self.shapefile_parts()
        zpath = self.tmp / "objectives.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in parts.items():
                zf.writestr(f"export/{name}", data)
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        page.set_input_files("#overlaysFileInput", str(zpath))
        page.wait_for_selector("#overlaysBody .overlay-type-select")
        cells = page.locator("#overlaysBody tbody tr").first.locator("td")
        self.assertEqual(cells.nth(0).text_content(), "OBJ IRON")
        self.assertEqual(cells.nth(1).text_content(), "Area")
        self.assertEqual(cells.nth(3).text_content(), "OBJ IRON")
        page.click("#overlaysReviewCancelBtn")
        # The same files picked together, unzipped.
        loose = []
        for name, data in parts.items():
            path = self.tmp / name
            path.write_bytes(data)
            loose.append(str(path))
        page.set_input_files("#overlaysFileInput", loose)
        page.wait_for_selector("#overlaysReviewAddBtn")
        page.click("#overlaysReviewAddBtn")
        page.wait_for_selector("#toastNotification:has-text('Imported 1 overlay')")
        iron = page.evaluate("() => sharedOverlays.find(o => o.name === 'IRON')")
        self.assertEqual(
            (iron["type"], iron["geometry"]["type"], len(iron["geometry"]["coordinates"])),
            ("OBJ", "Polygon", 2),
        )
        # A .dbf without its .shp is named, not silently dropped.
        page.set_input_files("#overlaysFileInput", [loose[1]])
        page.wait_for_selector(
            "#toastNotification:has-text(\"its .shp file wasn't picked with it\")"
        )
        page.evaluate("list => saveOverlays(list)", before)

    PNG_1PX = bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a3f9b1e40000000049454e44ae426082"
    )

    def open_map(self, page):
        """Slide down to the map, unless this browser already opens on it."""
        if page.locator("[data-home-go='map']").is_visible():
            page.click("[data-home-go='map']")
        page.wait_for_selector("#mapSvg .map-overlays path")

    def export_map(self, page):
        """Save the map as a PNG; its file name, size, and what the page said."""
        page.evaluate("document.getElementById('toastNotification').textContent = ''")
        with page.expect_download() as d:
            page.click("#mapExportBtn")
            page.click("#mapSavePng")
        path = self.tmp_path(d.value.suggested_filename)
        d.value.save_as(path)
        data = path.read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        page.wait_for_selector("#toastNotification:has-text('Saved ')")
        return d.value.suggested_filename, width, height, page.text_content("#toastNotification")

    def tmp_path(self, name):
        folder = Path(tempfile.mkdtemp(prefix="salt-export-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        return folder / name

    def test_the_map_saves_as_a_png_with_its_basemap_when_allowed(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", location="38SMB4500082000")

        def tile(cors):
            """A tile server, sending CORS headers or not."""

            # Under Playwright a fulfilled image passes the browser's copy check
            # either way, so the closed service fails outright: the export takes
            # the same way as for a real one that sends no CORS headers.
            def serve(route):
                if not cors:
                    route.abort()
                    return
                headers = {"Access-Control-Allow-Origin": "*"}
                route.fulfill(
                    status=200, content_type="image/png", body=self.PNG_1PX, headers=headers
                )

            return serve

        self.context.route("https://open.test/**", tile(True))
        self.context.route("https://closed.test/**", tile(False))
        self.open_map(page)
        self.synced(page)
        before = page.evaluate("JSON.parse(JSON.stringify(sharedBasemaps))")
        page.evaluate(
            """saveBasemaps([
                { name: 'Open tiles', kind: 'tiles', url: 'https://open.test/{z}/{x}/{y}.png' },
                { name: 'Closed tiles', kind: 'tiles', url: 'https://closed.test/{z}/{x}/{y}.png' },
            ])"""
        )
        try:
            self.pick_basemap(page, "Open tiles")
            page.wait_for_selector("#mapBase image")
            w, h = page.evaluate("[mapBox.clientWidth, mapBox.clientHeight]")
            name, width, height, said = self.export_map(page)
            self.assertRegex(name, rf"^{self.ato}_Patrol_map_\d{{8}}_\d{{4}}[ZL]\.png$")
            self.assertEqual(width, w * 2, "twice the map's width")
            self.assertGreater(height, h * 2, "the map, a title block and the key")
            self.assertNotIn("without the basemap", said)
            # A service that doesn't let the page copy its images: left out, and said.
            self.pick_basemap(page, "Closed tiles")
            page.wait_for_function(
                "[...document.querySelectorAll('#mapBase image')].some(i => i.dataset.url.includes('closed.test'))"
                " && ![...document.querySelectorAll('#mapBase image')].some(i => i.dataset.url.includes('open.test'))"
            )
            _, _, _, said = self.export_map(page)
            self.assertIn("without the basemap", said)
        finally:
            page.evaluate("list => saveBasemaps(list)", before)

    def test_the_map_prints_with_its_title_marks_and_key(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", location="38SMB4500082000")
        self.open_map(page)
        page.click("#mapExportBtn")
        self.assertEqual(page.get_attribute("#mapExportBtn", "aria-expanded"), "true")
        page.click("#mapPrint")
        # The page printed: a frame with the title, the map (graphics, north
        # arrow and scale bar) and the key, before it goes.
        got = page.wait_for_function(
            r"""() => { const f = [...document.querySelectorAll('iframe')].find(f => f.contentDocument && f.contentDocument.querySelector('.map'));
                if (!f) return null; const d = f.contentDocument;
                return { h1: d.querySelector('h1').textContent, svgs: d.querySelectorAll('.map svg').length,
                         north: d.querySelector('.map').innerHTML.includes('>N</text>'), keys: d.querySelectorAll('.key').length,
                         scale: /\d+ (m|km)</.test(d.querySelector('.map').innerHTML) }; }"""
        ).json_value()
        self.assertEqual(got["h1"], f"Patrol {self.ato}")
        self.assertEqual(got["svgs"], 3, "the basemap, the graphics, and the marks")
        self.assertTrue(got["north"] and got["scale"])
        self.assertGreaterEqual(got["keys"], 4)

    def test_report_dots_have_a_white_core_and_dragging_slides_the_picture(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", location="38SMB4500082000")
        self.open_map(page)
        page.click("[data-map-layer='reports']")
        page.wait_for_selector("#mapSvg .map-report .map-report-core")
        self.assertEqual(
            page.locator("#mapSvg .map-report").count(),
            page.locator("#mapSvg .map-report-core").count(),
        )
        self.assertEqual(
            page.get_attribute("#mapSvg .map-report-core", "fill"), "#ffffff", "white, on red"
        )
        # Zoomed in, so the map has room to move.
        page.click("[data-map-zoom='in']")
        page.click("[data-map-zoom='in']")
        self.next_frames(page)
        box = page.locator("#mapBox").bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        before = page.evaluate("[mapState.view.cx, mapState.view.cy]")
        drawn = page.evaluate("document.getElementById('mapSvg').innerHTML")
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 60, y + 30, steps=6)
        # While dragged: the picture slides, nothing is redrawn.
        self.assertEqual(
            page.evaluate("document.getElementById('mapSvg').style.transform"),
            "translate(60px, 30px)",
        )
        self.assertTrue(page.evaluate("mapState.dragging"))
        self.next_frames(page)
        self.assertEqual(page.evaluate("document.getElementById('mapSvg').innerHTML"), drawn)
        page.mouse.up()
        # Let go: drawn once at the new view, the slide undone.
        self.assertFalse(page.evaluate("mapState.dragging"))
        self.assertEqual(page.evaluate("document.getElementById('mapSvg').style.transform"), "")
        after = page.evaluate("[mapState.view.cx, mapState.view.cy]")
        self.assertLess(after[0], before[0], "dragged right: the view moved west")
        self.assertGreater(after[1], before[1], "dragged down: the view moved north")
        self.assertNotEqual(page.evaluate("document.getElementById('mapSvg').innerHTML"), drawn)

    def test_the_measure_tool_gives_distance_bearing_and_grids(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", location="38SMB4500082000")
        self.open_map(page)
        page.click("#mapMeasureBtn")
        self.assertEqual(page.get_attribute("#mapMeasureBtn", "aria-pressed"), "true")
        page.wait_for_selector("#mapMeasureOut:has-text('click a point')")
        box = page.locator("#mapBox").bounding_box()
        x, y = box["x"] + box["width"] * 0.4, box["y"] + box["height"] * 0.6
        page.mouse.click(x, y)
        page.wait_for_selector("#mapMeasureOut:has-text('click the second point')")
        page.mouse.click(x + 120, y - 120)
        page.wait_for_selector("#mapSvg .map-measure-line")
        said = page.text_content("#mapMeasureOut")
        self.assertRegex(
            said, r"^[\d.]+ (m|km), (04[0-9]|05[0-9])\u00b0 NE, from 38S MB \d{5} \d{5} to 38S MB"
        )
        self.assertEqual(page.text_content("#mapSvg .map-measure-label"), said.split(", from")[0])
        self.assertTrue(page.locator("#mapCard").is_hidden(), "a click measures, it opens no card")
        # Escape ends it, and the line goes.
        page.focus("#mapBox")
        page.keyboard.press("Escape")
        self.assertEqual(page.get_attribute("#mapMeasureBtn", "aria-pressed"), "false")
        page.wait_for_function("!document.querySelector('#mapSvg .map-measure-line')")
        self.assertTrue(page.locator("#mapMeasureOut").is_hidden())

    def test_play_walks_the_time_slider_and_drones_say_their_age(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", location="38SMB4500082000")
        self.open_map(page)
        self.synced(page)
        before = page.evaluate("JSON.parse(JSON.stringify(sharedDrones))")
        page.evaluate(
            "saveDrones([{ name: 'GE 7', grid: '38S MB 40000 78000', at: Date.now() - 6 * 3600e3 - 60e3 }])"
        )
        page.wait_for_function(
            "[...document.querySelectorAll('#mapSvg .map-label-drone')].some(t => t.textContent === 'GE 7 \u00b7 moved 6h ago')"
        )
        page.evaluate("list => saveDrones(list)", before)
        # Play: the window's end walks forward; Pause holds it there.
        self.assertIsNone(page.evaluate("mapState.end"))
        page.click("#mapEndPlay")
        self.assertEqual(page.get_attribute("#mapEndPlay", "aria-pressed"), "true")
        self.assertEqual(page.text_content("#mapEndPlay"), "Pause")
        page.wait_for_function("mapState.end !== null")
        first = page.evaluate("mapState.end")
        page.wait_for_function(f"mapState.end > {first}")
        page.click("#mapEndPlay")
        self.assertEqual(page.text_content("#mapEndPlay"), "Play")
        held = page.evaluate("mapState.end")
        page.wait_for_timeout(300)
        self.assertEqual(page.evaluate("mapState.end"), held, "paused where it was")
        # Now goes back to the present.
        page.click("#mapEndNow")
        self.assertIsNone(page.evaluate("mapState.end"))

    def test_the_overlay_map_heat_and_tracks(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        # An update at a new grid makes a track (Update keeps the old one in history).
        page.click("#reportLogBody tr[data-id] .col-size:has-text('2x BMP')")
        page.fill("#location", "38SMB4500084000")
        page.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-location:has-text('38SMB4500084000')")
        self.log(page, "1x truck", activity="parked", location="38SMB5500082000")
        self.open_map(page)
        # The graphics in their colors: NAI green, OBJ blue, PL black on white.
        strokes = page.locator("#mapSvg .map-overlays path").evaluate_all(
            "ps => ps.map(p => p.getAttribute('stroke'))"
        )
        self.assertIn("#32d74b", strokes)
        self.assertIn("#0a84ff", strokes)
        self.assertIn("#000000", strokes)
        # The heat map is on to start with; Tracks go on top of it.
        page.wait_for_selector("#mapSvg image.map-heat")
        self.assertIn("each once", page.text_content("#mapLegend"))
        page.click("[data-map-layer='tracks']")
        page.wait_for_selector("#mapSvg .map-track")
        page.wait_for_selector("#mapSvg image.map-heat")
        self.assertIn("1 moved, 1 at one grid", page.text_content("#mapLegend"))
        page.hover("#mapSvg .map-track .map-hit >> nth=0")
        page.wait_for_selector("#mapTip:not([hidden])")
        self.assertIn("2 positions", page.text_content("#mapTip"))
        # Zoom in, then Fit: the view can't go out past the graphics.
        before = page.evaluate("mapState.view.mpp")
        page.click("[data-map-zoom='in']")
        page.wait_for_function(f"() => mapState.view.mpp < {before}")
        page.click("[data-map-zoom='out']")
        page.click("[data-map-zoom='out']")
        page.wait_for_function(f"() => Math.abs(mapState.view.mpp - {before}) < 1e-6")
        # The heat drawn on the map has color in it.
        self.assertGreater(
            page.evaluate(
                """async () => {
                    const img = new Image();
                    img.src = document.querySelector('#mapSvg image.map-heat').getAttribute('href');
                    await img.decode();
                    const c = document.createElement('canvas');
                    c.width = img.width; c.height = img.height;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    return ctx.getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 === 3 && v > 0).length;
                }"""
            ),
            100,
        )

    def test_the_heat_map_keeps_counting_past_three_reports_in_one_place(self):
        # Regression: each report added to an 8-bit canvas, which stopped at
        # about three in one place, so 3 and 10 there looked the same and a
        # lone report beside them didn't fade as the busy place grew.
        page = self.open_editor()
        alpha = """async (n) => {
            const pts = [{ lon: 40, lat: 50, w: 1 }, ...Array.from({ length: n }, () => ({ lon: 140, lat: 50, w: 1 }))];
            const svg = heatLayer(pts, (lon, lat) => [lon, lat], 200, 100);
            const img = new Image();
            img.src = svg.match(/href="([^"]+)"/)[1];
            await img.decode();
            const c = document.createElement('canvas');
            c.width = 200; c.height = 100;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            return [ctx.getImageData(40, 50, 1, 1).data[3], ctx.getImageData(140, 50, 1, 1).data[3]];
        }"""
        lone3, busy3 = page.evaluate(alpha, 3)
        lone10, busy10 = page.evaluate(alpha, 10)
        self.assertGreater(busy3, 220)
        self.assertGreater(busy10, 220)
        self.assertGreater(lone3, lone10 + 40, (lone3, lone10))
        # A lone report on its own is the top of the ramp, as before.
        self.assertEqual(page.evaluate(alpha, 0)[0], busy3)

    @staticmethod
    def pick_basemap(page, value):
        """Choose a basemap from the panel behind the map's layers button."""
        if page.locator("#exportPanel").is_visible():
            page.click("#exportViewToggleBtn")  # back from Manage to the map
        if not page.locator("#mapBasePop").is_visible():
            page.click("#mapBaseBtn")
        page.select_option("#mapBaseSelect", value)

    def open_basemaps(self, page):
        """The list of services, in Manage > Map."""
        if not page.locator("#exportPanel").is_visible():
            page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        page.wait_for_selector("#mapBasemapForm")

    def back_to_map(self, page):
        """From Manage back to the map under the Report Log."""
        if page.locator("#exportPanel").is_visible():
            page.click("#exportViewToggleBtn")
        self.open_map(page)

    def add_tiles(self, page, url):
        """One box takes either kind: a tile address is known by its {z}. It's
        named for its host."""
        import urllib.parse

        name = urllib.parse.urlsplit(url.replace("{", "").replace("}", "")).hostname
        self.open_basemaps(page)
        page.fill("#mapBaseInput", url)
        page.click("#mapBaseAddBtn")
        page.wait_for_selector(f"#toastNotification:has-text('{name} added')")
        self.assertEqual(page.input_value("#mapBaseInput"), "", "the box is emptied")
        self.back_to_map(page)

    def add_wms(self, page, link, titles):
        """Look a WMS up from its link, tick the layers with these titles, add them."""
        self.open_basemaps(page)
        page.fill("#mapBaseInput", link)
        page.click("#mapBaseAddBtn")
        page.wait_for_selector(".map-layer-list, .map-find-error")
        self.assertEqual(
            page.locator(".map-find-error").count(),
            0,
            page.evaluate("JSON.stringify(mapState.wmsFind)"),
        )
        for t in titles:
            page.check(f".map-layer-row:has(.map-layer-title:text-is('{t}')) input")
        page.click("#mapWmsAdd")
        page.wait_for_selector("#toastNotification:has-text('added for everyone')")
        self.back_to_map(page)

    @staticmethod
    def capabilities(title, version, get_map, layers):
        """A WMS capabilities document: `layers` are (name, title, [crs...])."""
        tag = "CRS" if version == "1.3.0" else "SRS"
        root = "WMS_Capabilities" if version == "1.3.0" else "WMT_MS_Capabilities"
        body = "".join(
            f"<Layer><Name>{n}</Name><Title>{t}</Title>{''.join(f'<{tag}>{c}</{tag}>' for c in crs)}</Layer>"
            for n, t, crs in layers
        )
        return (
            f'<?xml version="1.0"?><{root} version="{version}" xmlns:xlink="http://www.w3.org/1999/xlink">'
            f"<Service><Name>WMS</Name><Title>{title}</Title></Service><Capability><Request><GetMap>"
            "<Format>image/jpeg</Format><Format>image/png</Format><DCPType><HTTP><Get>"
            f'<OnlineResource xlink:type="simple" xlink:href="{get_map}"/></Get></HTTP></DCPType>'
            f"</GetMap></Request><Layer><Title>Root</Title>{body}</Layer></Capability></{root}>"
        )

    def test_basemaps_are_shared_switchable_and_asked_for_the_graphics_only(self):
        page = self.open_editor()
        self.import_overlays(page)
        asked = []

        caps = self.capabilities(
            "Imagery",
            "1.3.0",
            "https://basemap.test/wms?map=ops&amp;",
            [("imagery", "Imagery 2024", ["EPSG:4326", "EPSG:3857"])],
        )

        def serve(route):
            if "GetCapabilities" in route.request.url:
                # A service that lets the page read it (CORS): no server needed.
                route.fulfill(
                    status=200,
                    content_type="text/xml",
                    body=caps,
                    headers={"Access-Control-Allow-Origin": "*"},
                )
                return
            asked.append(route.request.url)
            route.fulfill(status=200, content_type="image/png", body=self.PNG_1PX)

        self.context.route("https://basemap.test/**", serve)
        self.open_map(page)
        self.add_wms(page, "https://basemap.test/wms", [])  # its one layer comes ticked
        page.wait_for_function("() => document.querySelectorAll('#mapBase image').length === 1")
        # The image is on the page before its request is logged.
        self.wait_until(lambda: asked, "the map asked the WMS for no image", page)
        url = asked[-1]
        for part in ("REQUEST=GetMap", "LAYERS=imagery", "CRS=EPSG:3857", "map=ops"):
            self.assertIn(part, url)
        # The box asked for lies inside the map's area.
        x0, y0, x1, y1 = map(float, url.split("BBOX=")[1].split("&")[0].split(","))
        self.assertLess(x1 - x0, 40000)
        self.assertLess(y1 - y0, 40000)
        # A second service: added, and shown at once; the picker switches between them.
        asked.clear()
        self.add_tiles(page, "https://basemap.test/tiles/{z}/{x}/{y}.png")
        page.wait_for_function(
            "() => [...document.querySelectorAll('#mapBase image')].some(i => i.dataset.url.includes('/tiles/'))"
        )
        self.wait_until(lambda: asked, "the map asked the tile service for no tile", page)
        self.assertTrue(asked and len(asked) < 100, len(asked))
        self.assertTrue(all("/tiles/" in u for u in asked))
        options = page.locator("#mapBaseSelect option").all_text_contents()
        self.assertEqual(options, ["No basemap", "Imagery", "basemap.test"])
        self.pick_basemap(page, "Imagery")
        page.wait_for_function(
            "() => [...document.querySelectorAll('#mapBase image')].some(i => i.dataset.url.includes('/wms'))"
        )
        self.pick_basemap(page, "off")
        page.wait_for_function("() => document.querySelectorAll('#mapBase image').length === 0")
        self.wait_for_server(
            page, "s => s.basemaps.map(b => b.name).join() === 'Imagery,basemap.test'"
        )
        # Viewers get the map too (its layers, window and basemap picker), the
        # same list to pick from, and can't change it; the Overlays tab isn't theirs.
        # The view switcher stays a 2x2 square of four icons.
        self.assertEqual(
            page.locator(
                ".view-switcher > .view-icon, .view-switcher .data-management-menu"
            ).count(),
            4,
        )
        viewer = self.open_viewer()
        viewer.click("#exportViewToggleBtn")
        self.assertFalse(viewer.locator(".ws-tab[data-tab='overlays']").is_visible())
        viewer.click("#exportViewToggleBtn")
        self.open_map(viewer)
        viewer.wait_for_function(
            "() => document.querySelectorAll('#mapBaseSelect option').length === 3"
        )
        viewer.click("#mapBaseBtn")
        self.assertFalse(viewer.locator("#mapBaseManage").is_visible(), "editors only")
        viewer.click("#mapBaseBtn")
        for sel in (
            "[data-map-layer='reports']",
            "[data-map-layer='heat']",
            "[data-map-layer='tracks']",
            "[data-map-hours='6']",
            "[data-map-zoom='full']",
        ):
            self.assertTrue(viewer.locator(sel).is_visible(), sel)
        self.pick_basemap(viewer, "basemap.test")
        viewer.wait_for_function("() => document.querySelectorAll('#mapBase image').length > 0")
        # A tile service's details: its address changed (its name stays, and it's still the one shown).
        self.open_basemaps(page)
        self.pick_basemap(page, "basemap.test")
        self.open_basemaps(page)
        self.assertEqual(
            page.locator("#mapBasemapForm input[placeholder='Name']").count(), 0, "no name boxes"
        )
        page.click("[data-base-open='1']")
        self.assertEqual(
            page.input_value("#mapTileUrl"), "https://basemap.test/tiles/{z}/{x}/{y}.png"
        )
        page.fill("#mapTileUrl", "https://basemap.test/topo/{z}/{x}/{y}.png")
        page.click("#mapTileSave")
        page.wait_for_selector("#toastNotification:has-text('basemap.test saved')")
        self.wait_for_server(page, "s => s.basemaps[1].url.includes('/topo/')")
        self.back_to_map(page)
        self.assertEqual(
            page.locator("#mapBaseSelect option").all_text_contents(),
            ["No basemap", "Imagery", "basemap.test"],
        )
        self.assertEqual(page.input_value("#mapBaseSelect"), "basemap.test")
        # The map's basemap menu only switches; it links to Manage > Map.
        page.click("#mapBaseBtn")
        self.assertEqual(page.locator("#mapBasePop #mapBasemapForm").count(), 0)
        page.click("#mapBaseManage")
        page.wait_for_selector("#mapBasemapForm")
        self.assertTrue(
            page.locator(".ws-tab[data-tab='overlays']").get_attribute("aria-selected") == "true"
        )
        # Remove is on each row and asks first, in the name's place, so nothing moves.
        page.click("[data-base-open='0']")
        page.wait_for_selector(".map-base-detail .map-layer-list")
        self.assertTrue(page.is_checked(".map-layer-row:has-text('Imagery 2024') input"))
        self.assertEqual(page.locator(".map-base-detail button:has-text('Remove')").count(), 0)
        before = page.locator("[data-base-remove='0']").bounding_box()
        page.click("[data-base-remove='0']")
        self.assertEqual(
            page.text_content(".map-base-row >> nth=0 >> .map-base-ask"), "Remove for everyone?"
        )
        self.assertEqual(
            page.locator("[data-base-remove='0']").bounding_box(), before, "nothing moved"
        )
        self.assertEqual(page.locator(".map-base-row").count(), 2, "not yet")
        # Another button lets it go.
        page.click("[data-base-check='1']")
        self.assertEqual(page.locator(".map-base-ask").count(), 0)
        page.click("[data-base-remove='0']")
        page.click("[data-base-remove='0']")
        page.wait_for_selector("#toastNotification:has-text('Imagery removed')")
        self.assertEqual(page.locator(".map-base-detail").count(), 0)
        self.assertEqual(page.locator(".map-base-row").count(), 1)
        self.wait_for_server(page, "s => s.basemaps.map(b => b.name).join() === 'basemap.test'")
        self.back_to_map(page)
        self.assertEqual(
            page.locator("#mapBaseSelect option").all_text_contents(),
            ["No basemap", "basemap.test"],
        )
        # Undo puts it back where it was, for everyone.
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector("#toastNotification:has-text('Imagery put back')")
        self.wait_for_server(
            page, "s => s.basemaps.map(b => b.name).join() === 'Imagery,basemap.test'"
        )
        self.assertEqual(
            page.locator("#mapBaseSelect option").all_text_contents(),
            ["No basemap", "Imagery", "basemap.test"],
        )
        page.evaluate("saveBasemaps([])")

    def test_a_malformed_basemap_address_is_said_to_be_invalid(self):
        # Regression: new URL() threw on it, with nothing said.
        page = self.open_editor()
        self.open_basemaps(page)
        for text in ("https://[bad/{z}/{x}/{y}.png", "https://[bad/wms"):
            page.fill("#mapBaseInput", text)
            page.click("#mapBaseAddBtn")
            page.wait_for_selector("#toastNotification:has-text(\"That address isn't valid.\")")
        page.wait_for_timeout(300)
        self.assertEqual(page.locator(".map-find-head, .map-find-error, .map-find-msg").count(), 0)

    def test_switching_basemaps_leaves_no_stale_wms_image(self):
        # Regression: a WMS asked for just before No basemap (or tiles) was
        # picked still turned up, and one landing late wiped the tiles.
        page = self.open_editor()
        self.import_overlays(page)
        self.context.route(
            "https://race.test/**",
            lambda route: route.fulfill(status=200, content_type="image/png", body=self.PNG_1PX),
        )
        self.open_map(page)
        page.evaluate(
            """saveBasemaps([
                { name: 'Race WMS', kind: 'wms', url: 'https://race.test/wms', layers: 'a', version: '1.3.0', crs: 'EPSG:3857', format: 'image/png' },
                { name: 'Race tiles', kind: 'tiles', url: 'https://race.test/t/{z}/{x}/{y}.png' },
            ])"""
        )
        images = "[...document.querySelectorAll('#mapBase image')].map(i => i.dataset.url)"
        # The WMS is asked for once the view settles (300 ms): picked, then No
        # basemap before that, nothing turns up later.
        self.pick_basemap(page, "Race WMS")
        page.wait_for_timeout(100)
        self.pick_basemap(page, "off")
        page.wait_for_timeout(800)
        self.assertEqual(page.evaluate(images), [])
        # Tiles picked before that: they stay, and no WMS lands on them.
        self.pick_basemap(page, "Race WMS")
        page.wait_for_timeout(100)
        self.pick_basemap(page, "Race tiles")
        page.wait_for_function(
            "() => { const i = [...document.querySelectorAll('#mapBase image')]; return i.length && i.every(e => e.dataset.state === 'ok'); }"
        )
        tiles = len(page.evaluate(images))
        page.wait_for_timeout(800)
        urls = page.evaluate(images)
        self.assertEqual(len(urls), tiles, urls)
        self.assertTrue(all("/t/" in u for u in urls), urls)
        page.evaluate("saveBasemaps([])")

    def test_a_wms_linked_over_https_is_asked_over_https(self):
        # Regression (EOX): the capabilities gave http://, which sends everything on
        # to https://; saved as given, every map image failed on an HTTPS page.
        page = self.open_editor()
        url = "f => wmsGetMapUrl(f)"
        same = {
            "link": "https://tiles.maps.eox.at/wms?service=wms",
            "getMap": "http://tiles.maps.eox.at/?",
        }
        self.assertEqual(page.evaluate(url, same), "https://tiles.maps.eox.at/?")
        other = {**same, "getMap": "http://maps.example.mil/wms?"}
        self.assertEqual(
            page.evaluate(url, other), "http://maps.example.mil/wms?", "another host: as given"
        )
        plain = {**same, "link": "http://tiles.maps.eox.at/wms"}
        self.assertEqual(
            page.evaluate(url, plain), "http://tiles.maps.eox.at/?", "linked over http: as given"
        )
        self.assertEqual(
            page.evaluate(url, {"link": " https://x.test/wms ", "getMap": ""}), "https://x.test/wms"
        )

    def test_a_wms_found_through_the_server_in_latitude_longitude(self):
        import http.server as hs
        import threading

        seen = []
        caps_holder = {}

        class Fake(hs.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                seen.append(self.path)
                if "GetCapabilities" in self.path:
                    body, ctype = caps_holder["caps"].encode(), "text/xml"
                elif "LAYERS=bad" in self.path:
                    body, ctype = (
                        b"<ServiceException>Layer bad is not defined</ServiceException>",
                        "text/xml",
                    )
                else:
                    body, ctype = BrowserTests.PNG_1PX, "image/png"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        fake = hs.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        self.addCleanup(fake.shutdown)
        base = f"http://127.0.0.1:{fake.server_port}/ows"
        caps_holder["caps"] = self.capabilities(
            "Range Maps",
            "1.1.1",
            base + "?",
            [
                ("roads", "Roads", ["EPSG:4326"]),
                ("terrain", "Terrain", ["EPSG:4326", "EPSG:32611"]),
                ("utm", "UTM only", ["EPSG:32611"]),
            ],
        )
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        self.open_basemaps(page)
        page.fill("#mapBaseInput", base + "?service=WMS&request=GetMap&layers=old")
        page.click("#mapBaseAddBtn")
        page.wait_for_selector(".map-layer-list")
        self.assertIn("read by the server", page.text_content(".map-find-head"))
        self.assertEqual(
            page.text_content(".map-find-name"), "Range Maps", "named after the service"
        )
        self.assertIn("can't show", page.text_content(".map-layer-row:has-text('UTM only')"))
        page.check(".map-layer-row:has-text('Roads') input")
        page.check(".map-layer-row:has-text('Terrain') input")
        self.assertEqual(page.text_content("#mapWmsAdd"), "Add 2 Layers as One")
        page.click("#mapWmsAdd")
        page.wait_for_selector("#toastNotification:has-text('Range Maps added')")
        self.back_to_map(page)
        self.wait_for_server(page, "s => s.basemaps.some(b => b.name === 'Range Maps')")
        entry = page.evaluate(
            "fetch('/api/sync').then(r => r.json()).then(s => s.basemaps.find(b => b.name === 'Range Maps'))"
        )
        self.assertEqual(
            {k: entry[k] for k in ("layers", "version", "crs", "format", "url")},
            {
                "layers": "roads,terrain",
                "version": "1.1.1",
                "crs": "EPSG:4326",
                "format": "image/png",
                "url": base + "?",
            },
        )
        # The map asks in the service's terms: SRS, longitude first.
        page.wait_for_function("() => document.querySelectorAll('#mapBase image').length === 1")
        # An http:// service on an HTTPS page: its image comes through the sync server.
        self.assertTrue(
            page.get_attribute("#mapBase image", "href").startswith("/api/basemap?u=http")
        )
        # The image is on the page before the fake service has logged its request.
        self.wait_until(
            lambda: any("GetMap" in p for p in seen), "the fake WMS got no GetMap request"
        )
        get_map = next(p for p in reversed(seen) if "GetMap" in p)
        self.assertIn("SRS=EPSG:4326", get_map)
        self.assertIn("VERSION=1.1.1", get_map)
        x0, y0, x1, y1 = map(float, get_map.split("BBOX=")[1].split("&")[0].split(","))
        self.assertTrue(44 < x0 < x1 < 45 and 33 < y0 < y1 < 34, (x0, y0, x1, y1))
        # Check (in Manage > Map): the service sent an image (to the server),
        # said for a few seconds; a bad layer, its error, which stays to be read.
        self.open_basemaps(page)
        page.click("[data-base-check='0']")
        page.wait_for_selector(".map-base-check.ok")
        self.assertIn("map image", page.text_content(".map-base-check"))
        page.wait_for_selector(".map-base-check", state="detached", timeout=8000)
        # A fake clock (still running) lets the test skip past the moment an
        # OK message would fold away, instead of waiting it out.
        page.clock.install()
        page.evaluate(
            f"checkBasemap({{ name: 'Range Maps', kind: 'wms', url: '{base}', layers: 'bad' }})"
        )
        page.wait_for_selector(".map-base-check:has-text('not defined')")
        page.clock.run_for(page.evaluate("BASE_CHECK_MS") + 600)
        self.assertTrue(page.locator(".map-base-check:has-text('not defined')").is_visible())
        # Back to the same service for its layers: looked up again, those in use
        # ticked; one the service has dropped is still there, marked.
        caps_holder["caps"] = self.capabilities(
            "Range Maps",
            "1.1.1",
            base + "?",
            [("roads", "Roads", ["EPSG:4326"]), ("utm", "UTM only", ["EPSG:32611"])],
        )
        page.click("[data-base-open='0']")
        page.wait_for_selector(".map-base-detail .map-layer-list")
        self.assertEqual(page.locator(".map-base-add + .map-layer-list").count(), 0)
        self.assertTrue(page.is_checked(".map-layer-row:has-text('Roads') input"))
        gone = ".map-layer-row:has(.map-layer-name:text-is('terrain'))"
        self.assertIn("not listed", page.text_content(gone))
        self.assertTrue(page.is_checked(f"{gone} input"))
        self.assertEqual(page.text_content("#mapWmsAdd"), "Save")
        page.uncheck(f"{gone} input")
        page.uncheck(".map-layer-row:has-text('Roads') input")
        self.assertTrue(page.is_disabled("#mapWmsAdd"))
        self.assertEqual(page.text_content("#mapWmsAdd"), "Tick Layers to Keep")
        page.check(".map-layer-row:has-text('Roads') input")
        page.click("#mapWmsAdd")
        page.wait_for_selector("#toastNotification:has-text('Range Maps saved')")
        self.wait_for_server(
            page, "s => s.basemaps.length === 1 && s.basemaps[0].layers === 'roads'"
        )
        self.assertEqual(page.locator(".map-base-detail").count(), 0)
        page.evaluate("saveBasemaps([])")

    def test_the_map_view_links_the_map_and_its_table(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        self.log(page, "1x truck", activity="parked", location="38SMB5500082000")
        self.open_map(page)
        page.click("[data-map-layer='heat']")
        page.click("[data-map-layer='reports']")
        page.wait_for_selector("#mapSvg .map-report")
        self.assertEqual(page.locator("#mapSvg image.map-heat").count(), 0)
        self.assertEqual(page.locator("#mapSvg .map-report").count(), 2)
        page.wait_for_selector("#mapTableBody tr[data-map-row] >> nth=1")

        def rows():
            return page.locator(
                "#mapTableBody tr[data-map-row] td:nth-child(2)"
            ).all_text_contents()

        self.assertEqual(sorted(rows()), ["1x truck", "2x BMP"])
        # A dot opens the report's card and picks its row.
        i = page.evaluate("mapState.items.findIndex(x => x.t.report.size === '2x BMP')")
        page.click(f"#mapSvg [data-map-item='{i}'] .map-hit")
        page.wait_for_selector("#mapCard:not([hidden])")
        self.assertIn("2x BMP", page.text_content("#mapCard"))
        self.assertIn("2x BMP", page.text_content("#mapTableBody tr.selected-row"))
        page.wait_for_selector("#mapSvg .map-selected")
        # Show in table flashes the row; Edit puts the report in the form.
        page.click("[data-card-act='table']")
        page.wait_for_selector("#mapTableBody tr.flash")
        page.click("[data-card-act='edit']")
        self.assertIn("Updating", page.text_content("#formTitle"))
        page.click("#cancelButton")
        page.click("[data-card-act='close']")
        self.assertTrue(page.locator("#mapCard").is_hidden())
        # A row puts the map on its report, zooming in from all the way out.
        page.click("[data-map-zoom='fit']")
        page.wait_for_function("() => mapState.view.mpp >= mapState.fitMpp * 0.99")
        page.click("#mapTableBody tr[data-map-row]:has-text('1x truck')")
        page.wait_for_function("() => mapState.view.mpp < mapState.fitMpp * 0.5")
        self.assertIn("1x truck", page.text_content("#mapCard"))
        ring = page.locator("#mapSvg .map-selected circle").first.bounding_box()
        box = page.locator("#mapBox").bounding_box()
        self.assertTrue(box["x"] < ring["x"] < box["x"] + box["width"], (ring, box))
        self.assertTrue(box["y"] < ring["y"] < box["y"] + box["height"], (ring, box))
        page.click("[data-card-act='close']")
        # Clicking inside NAI 1 narrows the table to it; its chip widens it again.
        page.click("[data-map-zoom='fit']")
        page.evaluate("document.querySelector('.map-view').scrollTop = 0")
        self.settle(
            page,
            "document.querySelector('.map-view').scrollTop === 0 && mapState.view.mpp >= mapState.fitMpp * 0.99",
        )
        xy = page.evaluate("""() => {
            const r = document.getElementById('mapBox').getBoundingClientRect();
            const [x, y] = SaltCore.lonLatToMerc(44.36, 33.34);
            return [r.left + 1 + (x - mapState.view.cx) / mapState.view.mpp + (r.width - 2) / 2, r.top + 1 + (mapState.view.cy - y) / mapState.view.mpp + (r.height - 2) / 2];
        }""")
        page.mouse.click(*xy)
        page.wait_for_selector(".map-place-chip:has-text('NAI 1')")
        self.assertEqual(rows(), ["2x BMP"])
        page.click(".map-place-chip")
        page.wait_for_selector("#mapTableBody tr[data-map-row] >> nth=1")
        # Busiest places in the side list do the same.
        page.click(".map-side-place:has-text('NAI 1')")
        page.wait_for_selector(".map-place-chip:has-text('NAI 1')")
        page.click(".map-side-place:has-text('NAI 1')")
        page.wait_for_selector(".map-place-chip", state="detached")
        # Only what's on the map: zoomed onto one report, the table holds just it.
        page.evaluate("""() => {
            const t = mapState.lastDraw.tracks.find(x => x.report.size === '1x truck'), p = t.points[0];
            [mapState.view.cx, mapState.view.cy] = SaltCore.lonLatToMerc(p.lon, p.lat); mapState.view.mpp = 1; drawMap();
        }""")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapTableBody tr[data-map-row]').length === 1"
        )
        page.uncheck("#mapOnlyInView")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapTableBody tr[data-map-row]').length === 2"
        )
        page.check("#mapOnlyInView")
        page.click("[data-map-zoom='fit']")
        # The time slider: at its left end, only the first report. Its track
        # keeps its length as Now comes and goes.
        track = page.locator("#mapEndRange").bounding_box()["width"]
        page.fill("#mapEndRange", "0")
        page.dispatch_event("#mapEndRange", "input")
        self.assertEqual(page.locator("#mapEndRange").bounding_box()["width"], track)
        self.assertEqual(
            page.evaluate(
                "[getComputedStyle(mapEndRange).cursor, getComputedStyle(mapEndRange).opacity]"
            ),
            ["pointer", "1"],
            "a slider, not a read-only box",
        )
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 1"
        )
        self.assertTrue(page.locator("#mapEndNow").is_visible())
        page.click("#mapEndNow")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 2"
        )
        self.assertEqual(page.text_content("#mapEndLabel"), "Now")
        # A viewer's card has no Edit.
        viewer = self.open_viewer()
        self.open_map(viewer)
        viewer.click("[data-map-layer='reports']")  # a viewer's layers are its own
        viewer.wait_for_selector("#mapSvg .map-report")
        viewer.locator("#mapTableBody tr[data-map-row]").first.click()
        viewer.wait_for_selector("#mapCard:not([hidden])")
        self.assertFalse(viewer.locator("[data-card-act='edit']").is_visible())

    def test_escape_and_the_keyboard_on_the_map(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        self.log(page, "1x truck", activity="parked", location="38SMB5500082000")
        self.open_map(page)
        page.wait_for_selector("#mapTableBody tr[data-map-row] >> nth=1")
        # A row takes the keyboard's focus, and Enter does what a click does.
        row = "#mapTableBody tr[data-map-row]:has-text('1x truck')"
        self.assertEqual(page.get_attribute(row, "tabindex"), "0")
        page.focus(row)
        page.keyboard.press("Enter")
        page.wait_for_selector("#mapCard:not([hidden])")
        self.assertIn("1x truck", page.text_content("#mapCard"))
        # The table is redrawn after the map moves; the row keeps the focus.
        page.wait_for_timeout(300)
        self.assertIn("1x truck", page.evaluate("document.activeElement.textContent"))
        # With a report being edited, Escape closes the card, back to its row,
        # and leaves the edit alone.
        page.click("[data-card-act='edit']")
        self.assertTrue(page.locator("#cancelButton").is_visible())
        page.focus(row)
        page.keyboard.press("Enter")
        page.wait_for_selector("#mapCard:not([hidden])")
        page.keyboard.press("Escape")
        page.wait_for_selector("#mapCard", state="hidden")
        self.assertIn("1x truck", page.evaluate("document.activeElement.textContent"))
        self.assertTrue(page.locator("#cancelButton").is_visible(), "still editing")
        # The basemap and drone menus close on Escape too, back to their buttons.
        for btn, pop in (("#mapBaseBtn", "#mapBasePop"), ("#mapDroneBtn", "#mapDronePop")):
            page.click(btn)
            page.wait_for_selector(pop, state="visible")
            page.keyboard.press("Escape")
            page.wait_for_selector(pop, state="hidden")
            self.assertEqual(page.evaluate("'#' + document.activeElement.id"), btn)
            self.assertEqual(page.get_attribute(btn, "aria-expanded"), "false")
        self.assertTrue(page.locator("#cancelButton").is_visible(), "still editing")
        # With nothing of the map's open, Escape is the page's again.
        page.keyboard.press("Escape")
        page.wait_for_selector("#toastNotification:has-text('Editing canceled')")
        # The map itself: arrow keys pan, + and - zoom, 0 shows all.
        page.focus("#mapBox")
        before = page.evaluate("mapState.view.mpp")
        page.keyboard.press("+")
        page.wait_for_function(f"() => mapState.view.mpp < {before}")
        cx = page.evaluate("mapState.view.cx")
        page.keyboard.press("ArrowRight")
        page.wait_for_function(f"() => mapState.view.cx > {cx}")
        cy = page.evaluate("mapState.view.cy")
        page.keyboard.press("ArrowUp")
        page.wait_for_function(f"() => mapState.view.cy > {cy}")
        page.keyboard.press("0")
        page.wait_for_function("() => mapState.view.mpp >= mapState.fitMpp * 0.99")
        page.keyboard.press("+")
        page.keyboard.press("-")
        page.wait_for_function("() => mapState.view.mpp >= mapState.fitMpp * 0.99")

    def test_map_layers_together_all_reports_and_activity(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        page.click("#reportLogBody tr[data-id] .col-size:has-text('2x BMP')")
        page.fill("#location", "38SMB4500084000")
        page.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-location:has-text('38SMB4500084000')")
        self.log(page, "1x truck", activity="parked", location="38SMB5500082000")
        self.open_map(page)
        count = lambda sel: page.locator(sel).count()  # noqa: E731
        # Heat to start with; Reports on top of it, at the latest grids.
        page.wait_for_selector("#mapSvg image.map-heat")
        self.assertEqual(page.get_attribute("[data-map-layer='heat']", "aria-pressed"), "true")
        page.click("[data-map-layer='reports']")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 2"
        )
        self.assertEqual(count("#mapSvg image.map-heat"), 1)
        # All reports: the update's earlier grid too, smaller.
        page.click("[data-map-grids='all']")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 3"
        )
        self.assertEqual(count("#mapSvg .map-report-old"), 1)
        self.assertIn("every saved report", page.text_content("#mapLegend"))
        # And tracks with them: all three layers at once.
        page.click("[data-map-layer='tracks']")
        page.wait_for_selector("#mapSvg .map-track")
        self.assertEqual(count("#mapSvg image.map-heat"), 1)
        self.assertEqual(count("#mapSvg .map-report"), 3)
        # With no heat map and no dots, the latest / all choice goes away.
        page.click("[data-map-layer='heat']")
        page.click("[data-map-layer='reports']")
        self.assertTrue(page.locator("[data-map-grids='all']").is_disabled())
        page.click("[data-map-layer='tracks']")
        page.wait_for_selector("#mapLegend:has-text('Turn on a layer')")
        page.click("[data-map-layer='reports']")
        # Activity, picked beside the map: Moving keeps the BMPs (both their
        # positions); Show all brings back the rest.
        self.assertIn("Stationary", page.text_content("#mapSide"))
        page.click("#mapSide [data-map-activity='Moving']")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 2"
        )
        page.wait_for_function(
            "() => [...document.querySelectorAll('#mapTableBody tr[data-map-row] td:nth-child(2)')].map(t => t.textContent).join() === '2x BMP'"
        )
        self.assertIn("Stationary", page.text_content("#mapSide"), "the others can still be picked")
        page.click("#mapSide [data-map-activity='']")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 3"
        )
        # The Report Log's bar stays over the map: its search narrows the map too.
        page.fill("#searchBar", "truck")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 1"
        )
        page.fill("#searchBar", "")
        page.wait_for_function(
            "() => document.querySelectorAll('#mapSvg .map-report').length === 3"
        )
        # The sidebar runs down the map's left side, in two halves that each scroll.
        side, mbox = page.locator("#mapSide").bounding_box(), page.locator("#mapBox").bounding_box()
        # It stops just above the Up to slider, which runs the map's whole width.
        slider = page.locator("#mapBox .map-time").bounding_box()
        self.assertAlmostEqual(side["y"] + side["height"], slider["y"] - 6, delta=3)
        self.assertAlmostEqual(slider["width"], mbox["width"] - 20, delta=3)
        halves = page.locator("#mapSide .map-side-block").evaluate_all(
            "bs => bs.map(b => Math.round(b.getBoundingClientRect().height))"
        )
        self.assertLessEqual(abs(halves[0] - halves[1]), 2, halves)
        self.assertEqual(
            page.locator("#mapSide .map-chips").evaluate_all(
                "cs => cs.map(c => getComputedStyle(c).overflowY)"
            ),
            ["auto", "auto"],
        )
        # The sidebar slides away and back; the map keeps its size throughout,
        # and its button stays where it is, for the next click.
        wide = page.locator("#mapBox").bounding_box()["width"]
        at = page.locator("#mapSideBtn").bounding_box()
        page.click("#mapSideBtn")
        page.wait_for_selector("#mapSide", state="hidden")
        self.assertEqual(page.locator("#mapSideBtn").bounding_box(), at)
        self.assertEqual(page.locator("#mapBox").bounding_box()["width"], wide)
        # Its controls slide, keeping their width (so they don't wrap differently).
        tools = page.evaluate("document.querySelector('#mapBox .map-tools').offsetWidth")
        page.click("#mapSideBtn")
        page.wait_for_selector("#mapSide", state="visible")
        self.assertEqual(
            page.evaluate("document.querySelector('#mapBox .map-tools').offsetWidth"), tools
        )
        # The layers and the latest / all choice are kept in this browser.
        page.reload()
        page.wait_for_selector("#mapSvg .map-report")
        self.assertEqual(page.get_attribute("[data-map-layer='heat']", "aria-pressed"), "false")
        self.assertEqual(page.get_attribute("[data-map-grids='all']", "aria-pressed"), "true")

    def test_the_access_code_is_hidden_until_show_is_pressed(self):
        self.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=self.editor)
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.editor + "/")
        page.wait_for_selector("#startupModal.show")
        # The startup field holds the code but draws it as dots.
        field = page.locator("#startupAccessCode")
        self.assertEqual(field.input_value(), CODE)
        self.assertEqual(field.evaluate("e => getComputedStyle(e).webkitTextSecurity"), "disc")
        # Not a password field, which the browser would offer to save.
        self.assertEqual(field.get_attribute("type"), "text")
        page.click("#startupAccessShowBtn")
        self.assertEqual(field.evaluate("e => getComputedStyle(e).webkitTextSecurity"), "none")
        self.assertEqual(page.inner_text("#startupAccessShowBtn"), "Hide")
        page.fill("#startupInitials", "AB")
        page.fill("#startupAto", "CODEMASK")
        page.fill("#startupTitle", "Patrol")
        page.click("#startupContinueBtn")
        page.wait_for_selector("#startupModal.show", state="hidden")

        # The Identity tab: dots, Show, Hide again on leaving the tab; Copy copies the code.
        page.click("#exportViewToggleBtn")
        page.click("#exportPanel .ws-tab[data-tab='identity']")
        code = page.locator("#identityAccessCode")
        self.assertEqual(code.inner_text(), "\u2022" * len(CODE))
        page.click("#identityAccessCopyBtn")
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), CODE)
        self.assertEqual(code.inner_text(), "\u2022" * len(CODE))
        width = code.bounding_box()["width"]
        page.click("#identityAccessShowBtn")
        self.assertEqual(code.inner_text(), CODE)
        self.assertEqual(code.bounding_box()["width"], width)  # nothing moves
        page.click("#exportPanel .ws-tab[data-tab='export']")
        page.click("#exportPanel .ws-tab[data-tab='identity']")
        self.assertEqual(code.inner_text(), "\u2022" * len(CODE))
        page.click("#identityAccessShowBtn")
        page.click("#exportViewToggleBtn")
        page.click("#exportViewToggleBtn")
        page.click("#exportPanel .ws-tab[data-tab='identity']")
        self.assertEqual(code.inner_text(), "\u2022" * len(CODE))

    def test_the_page_starts_when_browser_storage_throws(self):
        # Regression: a browser that blocks storage threw on the first raw
        # localStorage read, and the page never started.
        self.context.add_init_script(
            """(() => {
                const blocked = () => { throw new DOMException('Storage is blocked.', 'SecurityError'); };
                // Every read throws, the map's and statistics' own settings included.
                Storage.prototype.getItem = blocked;
                Storage.prototype.setItem = blocked;
                Storage.prototype.removeItem = blocked;
            })();"""
        )
        page = self.open_editor()
        self.log(page, "2x BTR")
        page.click("#dataMgmtBtn")
        page.click("#toggleTimeFormatBtn")
        self.assertEqual(page.evaluate("timeDisplayMode"), "local")

    def test_mgrs_lock_keeps_its_zone_and_square_after_a_report(self):
        # Regression: logging reset the form, which emptied the box while the lock went on.
        page = self.open_editor()
        page.click("#dataMgmtBtn")
        page.click("#toggleMgrsLockBtn")
        page.fill("#mgrsPrefix", "38S MB")
        # Enter sets it and goes on to Location; it doesn't try to log the report.
        page.press("#mgrsPrefix", "Enter")
        self.assertEqual(page.evaluate("document.activeElement.id"), "location")
        self.settle(page)  # a wrong toast would have shown by now
        self.assertNotIn("Please fill in", page.text_content("#toastNotification") or "")
        self.log(page, "2x BMP", location="45000 82000")
        self.assertEqual(page.input_value("#mgrsPrefix"), "38S MB")
        page.wait_for_selector("#reportLogBody tr[data-id] .col-location:has-text('38S MB')")

    def test_the_sidebar_box_wraps_its_button(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        self.settle(page)  # the slide to the map and the sidebar's own
        side, btn = (
            page.locator("#mapSide").bounding_box(),
            page.locator("#mapSideBtn").bounding_box(),
        )
        self.assertLess(side["y"], btn["y"])
        self.assertLess(side["x"], btn["x"])
        self.assertGreater(side["x"] + side["width"], btn["x"] + btn["width"])
        first = page.locator("#mapSide .map-side-head").first.bounding_box()
        self.assertGreater(
            first["y"], btn["y"] + btn["height"], "its contents start under the button"
        )

    def test_drones_are_shared_drawn_with_their_view_and_zoomed_to(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        self.open_map(page)
        page.click("#mapDroneBtn")
        page.fill("#mapDroneName", "GE 1")
        page.fill("#mapDroneGridNew", "38SMB4000078000")
        page.click("#mapDroneAdd")
        page.wait_for_selector("#toastNotification:has-text('GE 1 added at 38S MB 40000 78000')")
        page.wait_for_selector("#mapSvg .map-drone")
        # Its view: a cone narrowing to the newest report, and the sightline.
        cone = page.locator("#mapSvg .map-drone-cone")
        self.assertEqual(cone.count(), 1)
        shape = cone.get_attribute("d")
        self.assertIn(" A", shape, "its far end is an arc, not cut straight")
        tip = [float(v) for v in shape[1:].split()[0].split(",")]
        at = page.get_attribute("#mapSvg .map-drone", "transform")
        drone = [float(v) for v in at[at.index("(") + 1 : at.index(")")].split()]
        self.assertEqual(tip, drone, "narrow at the drone, widening to the report")
        self.assertEqual(page.locator("#mapSvg .map-drones line").count(), 2)
        self.assertIn(
            " km N", " ".join(page.locator("#mapSvg .map-label-drone").all_text_contents())
        )
        # Moved by typing a grid; Zoom centers on it, closer.
        page.fill("#mapDroneGrid0", "38SMB4100079000")
        page.press("#mapDroneGrid0", "Enter")
        page.wait_for_selector("#toastNotification:has-text('GE 1 moved to 38S MB 41000 79000')")
        before = page.evaluate("mapState.view.mpp")
        page.click("[data-drone-zoom='0']")
        page.wait_for_function(f"() => mapState.view.mpp < {before}")
        # Drawn in the middle of the map, once redrawn.
        page.wait_for_function(
            r"() => { const t = document.querySelector('#mapSvg .map-drone').getAttribute('transform').match(/[\d.]+/g).map(Number);"
            " const b = document.getElementById('mapBox'); return Math.abs(t[0] - b.clientWidth / 2) < 2 && Math.abs(t[1] - b.clientHeight / 2) < 2; }"
        )
        # Each browser's own switches: the view off, then the drones.
        page.uncheck("#mapDroneView")
        page.wait_for_function("() => !document.querySelector('#mapSvg .map-drone-cone')")
        page.uncheck("#mapDroneShow")
        page.wait_for_function("() => !document.querySelector('#mapSvg .map-drone')")
        page.check("#mapDroneShow")
        page.wait_for_selector("#mapSvg .map-drone")
        # Shared: the server has it, and a viewer sees it but can't move it.
        self.wait_for_server(
            page, "s => s.drones.length === 1 && s.drones[0].grid === '38S MB 41000 79000'"
        )
        viewer = self.open_viewer()
        self.open_map(viewer)
        viewer.wait_for_selector("#mapSvg .map-drone")
        viewer.click("#mapDroneBtn")
        self.assertEqual(viewer.locator("#mapDroneGrid0").count(), 0)
        self.assertFalse(viewer.locator("#mapDroneAdd").is_visible())
        page.evaluate("saveDrones([])")

    def test_drone_view_points_where_told_and_flags_out_of_range(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        self.open_map(page)
        page.evaluate("saveDrones([{ name: 'GE 1', grid: '38S MB 40000 78000', at: Date.now() }])")
        page.wait_for_selector("#mapSvg .map-drone-cone")
        page.click("#mapDroneBtn")
        # Told where to look: the cone points there, not at the newest report.
        page.fill("#mapDroneLook0", "38SMB4000090000")
        page.press("#mapDroneLook0", "Enter")
        page.wait_for_selector(
            "#toastNotification:has-text('GE 1 is looking at 38S MB 40000 90000')"
        )
        page.wait_for_function(
            "() => [...document.querySelectorAll('#mapSvg .map-label-drone')].some(t => t.textContent === '12.0 km N')"
        )
        self.assertEqual(page.locator("#mapSvg .map-drone-range").count(), 0, "no range, no ring")
        # A range shorter than that: the ring, a red view, and how far out.
        page.fill("#mapDroneRange0", "10")
        page.press("#mapDroneRange0", "Enter")
        page.wait_for_selector("#toastNotification:has-text(\"GE 1's range is 10 km\")")
        page.wait_for_selector("#mapSvg .map-drone-range")
        page.wait_for_selector("#mapSvg .map-drone-cone.out")
        labels = " ".join(page.locator("#mapSvg .map-label-drone").all_text_contents())
        self.assertIn("2.0 km out of range", labels)
        self.assertIn("10 km", labels)
        # Back to the newest report (in range): no longer red; no range: no ring.
        page.fill("#mapDroneLook0", "")
        page.press("#mapDroneLook0", "Enter")
        page.wait_for_selector(
            "#toastNotification:has-text(\"GE 1's view follows the newest report\")"
        )
        page.wait_for_function("() => document.querySelector('#mapSvg .map-drone-cone:not(.out)')")
        page.fill("#mapDroneRange0", "")
        page.press("#mapDroneRange0", "Enter")
        page.wait_for_function("() => !document.querySelector('#mapSvg .map-drone-range')")
        self.wait_for_server(
            page,
            "s => s.drones.length === 1 && !('look' in s.drones[0]) && !('range' in s.drones[0])",
        )
        # Moving it keeps where it looks and its range.
        page.evaluate("saveDrones([{ ...sharedDrones[0], look: '38S MB 40000 90000', range: 15 }])")
        page.fill("#mapDroneGrid0", "38SMB4100078000")
        page.press("#mapDroneGrid0", "Enter")
        self.wait_for_server(
            page,
            "s => s.drones[0].grid === '38S MB 41000 78000' && s.drones[0].range === 15 && s.drones[0].look === '38S MB 40000 90000'",
        )
        viewer = self.open_viewer()
        self.open_map(viewer)
        viewer.click("#mapDroneBtn")
        self.assertIn("38S MB 40000 90000", viewer.text_content("#mapDronePop"))
        self.assertIn("15 km", viewer.text_content("#mapDronePop"))
        self.assertEqual(viewer.locator("#mapDroneLook0").count(), 0, "viewers can't change it")
        page.evaluate("saveDrones([])")

    def test_a_refused_save_puts_the_shared_lists_back(self):
        # Regression: the basemaps, drones and narrative settings were changed
        # here first, and stayed changed when the server refused them (the
        # overlays too, until they shared one way of saving with the rest).
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        asked = []

        def refuse(route):
            asked.append(route.request.url)
            route.fulfill(status=400, content_type="application/json", body='{"message": "no"}')

        for api in ("save_basemaps", "save_drones", "save_narrative", "save_overlays"):
            page.route(f"**/api/{api}", refuse)
        basemaps = page.evaluate("JSON.stringify(sharedBasemaps)")
        page.evaluate(
            "saveBasemaps([...sharedBasemaps, { name: 'Refused', kind: 'tiles', url: 'https://refused.test/{z}/{x}/{y}.png' }])"
        )
        page.wait_for_selector("#toastNotification:has-text('Not saved: no.')")
        self.assertEqual(page.evaluate("JSON.stringify(sharedBasemaps)"), basemaps)
        self.assertEqual(page.evaluate("localStorage.getItem('salt_basemaps')"), basemaps)
        self.assertNotIn("Refused", page.text_content("#mapBaseSelect"))
        page.click("#mapDroneBtn")
        page.fill("#mapDroneName", "GE 9")
        page.fill("#mapDroneGridNew", "38SMB4000078000")
        page.click("#mapDroneAdd")
        # Shown at once, then put back (the toast still says the last refusal).
        page.wait_for_function("sharedDrones.length === 0")
        self.assertIn("Not saved: no.", page.text_content("#toastNotification"))
        # The map redraws on the next frame.
        page.wait_for_function("() => !document.querySelector('#mapSvg .map-drone')")
        enemy = page.evaluate("sharedNarrative.enemy || ''")
        page.evaluate("saveNarrative({ enemy: 'NOPE' })")
        page.wait_for_selector("#toastNotification:has-text('Not saved: no.')")
        self.assertEqual(page.evaluate("sharedNarrative.enemy || ''"), enemy)
        overlays = page.evaluate("JSON.stringify(sharedOverlays)")
        self.assertFalse(page.evaluate("saveOverlays([])"))
        page.wait_for_selector("#toastNotification:has-text('Not saved: no.')")
        self.assertEqual(page.evaluate("JSON.stringify(sharedOverlays)"), overlays)
        # Unreachable: put back too, since it isn't kept to send later.
        page.unroute("**/api/save_drones")
        page.route("**/api/save_drones", lambda route: route.abort())
        self.assertFalse(
            page.evaluate("saveDrones([{ name: 'GE 8', grid: '38S MB 40000 78000', at: 1 }])")
        )
        page.wait_for_selector("#toastNotification:has-text(\"the server can't be reached\")")
        self.assertEqual(page.evaluate("sharedDrones.length"), 0)
        # Past the server's limits: said at once, without asking it.
        asked.clear()
        page.evaluate("""() => {
            sharedDrones = Array.from({ length: 10 }, (_, i) => ({ name: 'D' + i, grid: '38S MB 40000 78000', at: i }));
            document.getElementById('mapDroneName').value = 'GE 10';
            document.getElementById('mapDroneGridNew').value = '38SMB4000078000';
            document.getElementById('mapDroneAdd').click();
        }""")
        page.wait_for_selector("#toastNotification:has-text('10 drones at most')")
        page.evaluate("""() => {
            sharedBasemaps = Array.from({ length: 20 }, (_, i) => ({ name: 'B' + i, kind: 'tiles', url: 'https://b.test/{z}/{x}/{y}.png' }));
            addBasemap({ name: 'One more', kind: 'tiles', url: 'https://b.test/{z}/{x}/{y}.png' });
        }""")
        page.wait_for_selector("#toastNotification:has-text('20 basemaps at most')")
        self.assertEqual(asked, [])
        page.evaluate("sharedDrones = []; sharedBasemaps = []; renderMapView()")

    def test_removing_a_drone_removes_that_drone_whatever_synced_meanwhile(self):
        # Regression: Remove matched the drone object, so a sync while it
        # asked "for everyone?" left it in place yet said it was removed.
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        page.evaluate(
            "saveDrones([{ name: 'GE 1', grid: '38S MB 40000 78000', at: 1 }, { name: 'GE 2', grid: '38S MB 41000 78000', at: 2 }])"
        )
        self.synced(page)
        page.click("#mapDroneBtn")
        ge1 = "[data-drone-remove][data-drone-name='GE 1']"
        box = page.locator(ge1).bounding_box()
        # The first press asks in its row, in place of its grid: nothing moves.
        page.click(ge1)
        page.wait_for_selector(".map-drone-row:has(.map-drone-name:text-is('GE 1')) .map-base-ask")
        self.assertEqual(page.locator(ge1).bounding_box(), box)
        self.assertEqual(page.evaluate("document.activeElement.dataset.droneName"), "GE 1")
        self.assertEqual(page.evaluate("sharedDrones.length"), 2, "not yet")
        page.evaluate("sharedDrones = sharedDrones.map(d => ({ ...d })).reverse()")
        page.click(ge1)
        page.wait_for_selector("#toastNotification:has-text('GE 1 removed')")
        self.assertEqual(page.evaluate("sharedDrones.map(d => d.name)"), ["GE 2"])
        self.wait_for_server(page, "s => s.drones.map(d => d.name).join() === 'GE 2'")
        # Undo puts it back where it was, for everyone.
        page.click("#toastNotification .toast-undo")
        page.wait_for_selector("#toastNotification:has-text('GE 1 put back')")
        self.wait_for_server(page, "s => s.drones.map(d => d.name).join() === 'GE 2,GE 1'")
        self.synced(page)
        # Gone already: it says so, rather than that it removed it.
        if not page.is_visible("#mapDronePop"):
            page.click("#mapDroneBtn")
        page.click("[data-drone-remove][data-drone-name='GE 2']")
        page.evaluate("sharedDrones = []")
        page.click("[data-drone-remove][data-drone-name='GE 2']")
        page.wait_for_selector("#toastNotification:has-text('GE 2 is no longer on the map')")
        page.evaluate("saveDrones([])")

    def test_shift_click_copies_the_grid_under_it(self):
        self.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=self.editor)
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        page.locator("#mapBox").scroll_into_view_if_needed()
        box = page.locator("#mapBox").bounding_box()
        x, y = box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.55
        page.mouse.move(x, y)
        self.assertTrue(page.locator("#mapGridReadout").is_hidden(), "only while Shift is held")
        page.keyboard.down("Shift")
        page.wait_for_selector("#mapGridReadout:not([hidden])")
        shown = page.text_content("#mapGridReadout")
        self.assertRegex(shown, r"^38S [A-Z]{2} \d{5} \d{5}$")
        page.mouse.click(x, y)
        page.wait_for_selector(f"#toastNotification:has-text('Copied {shown}')")
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), shown)
        self.assertTrue(page.locator("#mapCard").is_hidden(), "a Shift + click opens no card")
        page.keyboard.up("Shift")
        page.wait_for_selector("#mapGridReadout", state="hidden")
        self.assertEqual(page.locator("#mapGrabBtn").count(), 0, "no button to press first")

    def test_the_basemap_notice_only_when_nothing_came_back(self):
        # Regression: one missing tile put the notice up while Check passed.
        page = self.open_editor()
        self.import_overlays(page)
        serving = {"some": True}

        def serve(route):
            x = int(route.request.url.rstrip(".png").split("/")[-2])
            if serving["some"] and x % 2 == 0:
                route.fulfill(status=200, content_type="image/png", body=self.PNG_1PX)
            else:
                route.fulfill(status=404, content_type="text/plain", body="no tile")

        self.context.route("https://gaps.test/**", serve)
        self.open_map(page)
        self.add_tiles(page, "https://gaps.test/t/{z}/{x}/{y}.png")
        settled = "() => { const i = [...document.querySelectorAll('#mapBase image')]; return i.length && i.every(e => e.dataset.state); }"
        page.wait_for_function(settled)
        self.assertGreater(
            page.locator("#mapBase image[data-state='error']").count(), 0, "some tiles missing"
        )
        self.assertTrue(
            page.locator("#mapNote").is_hidden(), "a few gaps aren't the service failing"
        )
        # Nothing comes back for the next view: now it says so.
        serving["some"] = False
        page.click("[data-map-zoom='in']")
        page.wait_for_function(
            "() => { const i = [...document.querySelectorAll('#mapBase image')]; return i.length && i.every(e => e.dataset.state === 'error'); }"
        )
        page.wait_for_selector("#mapNote", state="visible")
        page.evaluate("saveBasemaps([])")

    def test_the_basemap_notice_sits_under_the_controls_however_they_wrap(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        self.open_map(page)
        page.wait_for_selector("#mapSvg image.map-heat")
        # A basemap that didn't answer, on a map narrow enough to wrap its controls.
        for width in (1700, 1100):
            page.set_viewport_size({"width": width, "height": 900})
            page.evaluate("mapState.baseFailed = true; redrawMap()")
            page.wait_for_selector("#mapNote", state="visible")
            self.settle(page)  # the sidebar's slide
            note = page.locator("#mapNote").bounding_box()
            lowest = page.evaluate(
                "Math.max(...[...document.querySelectorAll('#mapBox .map-tools > :not(#mapNote):not(.map-tools-break)')]"
                ".map(e => e.getBoundingClientRect().bottom))"
            )
            self.assertGreaterEqual(note["y"], lowest, width)
        page.evaluate("mapState.baseFailed = false; redrawMap()")
        page.wait_for_selector("#mapNote", state="hidden")

    def test_the_wheel_scrolls_past_the_map_and_ctrl_wheel_zooms(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        page.hover("#mapBox")
        before = page.evaluate("mapState.view.mpp")
        page.mouse.wheel(0, 200)
        page.wait_for_selector("#mapHint", state="visible")
        self.assertEqual(page.evaluate("mapState.view.mpp"), before, "a plain wheel doesn't zoom")
        self.assertGreater(
            page.evaluate("document.querySelector('.map-view').scrollTop"),
            0,
            "it scrolls the page on",
        )
        page.evaluate("document.querySelector('.map-view').scrollTop = 0")
        page.hover("#mapBox")
        page.keyboard.down("Control")
        page.mouse.wheel(0, -200)
        page.keyboard.up("Control")
        page.wait_for_function(f"() => mapState.view.mpp < {before}")

    def test_the_map_doesnt_move_as_its_numbers_arrive(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BTR", location="38SMB4500082000")
        page.reload()
        page.wait_for_selector("#reportLogTable")
        # The tiles are there before the map is drawn, so it opens where it stays
        # (measured within its pane, which is still sliding in).
        self.assertEqual(page.locator("#mapTiles .map-tile").count(), 3)
        page.click("[data-home-go='map']")
        page.wait_for_selector("#mapPanel", state="visible")
        top = page.evaluate(
            "document.getElementById('mapBox').getBoundingClientRect().top - document.getElementById('mapPanel').getBoundingClientRect().top"
        )
        page.wait_for_function(
            "() => document.querySelector('#mapTiles .map-tile-value').textContent.trim() === '1'"
        )
        self.assertAlmostEqual(
            page.evaluate(
                "document.getElementById('mapBox').getBoundingClientRect().top - document.getElementById('mapPanel').getBoundingClientRect().top"
            ),
            top,
            delta=1,
        )

    def test_map_full_screen_and_names_on_screen_when_zoomed(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", location="38SMB4500082000")
        self.open_map(page)
        labels = lambda: page.locator("#mapSvg .map-labels text").all_text_contents()  # noqa: E731
        self.assertIn("NAI 1", labels())
        # Zoomed far into NAI 1's corner, its middle is off screen; the name stays.
        page.evaluate("""() => {
            const o = currentOverlays().find(o => o.name === '1' && o.type === 'NAI');
            const ring = SaltCore.asArea(o.geometry).coordinates[0];
            const [x, y] = SaltCore.lonLatToMerc(ring[0][0], ring[0][1]);
            mapState.view = { cx: x, cy: y, mpp: 2 };
            drawMap();
        }""")
        self.assertIn("NAI 1", labels())
        page.click("[data-map-zoom='full']")
        page.wait_for_function(
            "() => document.fullscreenElement && document.fullscreenElement.id === 'mapPane'"
        )
        # The button changes when the browser says full screen began.
        page.wait_for_selector("#mapFullBtn[title='Leave full screen (Esc)']")
        # The sidebar stays behind, so nothing keeps room for it: the key, the
        # controls and the card go to the left edge, and its button goes.
        room = "getComputedStyle(document.getElementById('mapBox')).getPropertyValue('--side-room').trim()"
        self.assertEqual(page.evaluate(room), "10px")
        self.assertTrue(page.locator("#mapSideBtn").is_hidden())
        page.wait_for_function(
            "() => Math.abs(document.querySelector('#mapBox .map-tools').getBoundingClientRect().left - document.getElementById('mapBox').getBoundingClientRect().left - 10) < 2"
        )
        page.evaluate("selectMapReport(localReports[0].id, [20, 100])")
        page.wait_for_selector("#mapCard:not([hidden])")
        self.assertLess(
            page.evaluate("parseFloat(document.getElementById('mapCard').style.left)"), 60
        )
        page.evaluate("document.exitFullscreen()")
        page.wait_for_function("() => !document.fullscreenElement")
        self.assertEqual(page.evaluate(room), "210px")
        self.assertTrue(page.locator("#mapSideBtn").is_visible())
        page.wait_for_function(
            "() => parseFloat(document.getElementById('mapCard').style.left) >= 210"
        )

    def test_the_format_stays_when_switching_workspaces(self):
        page = self.open_editor(ato="FORMATA")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='builder']")
        page.fill("#builderNewLetter", "W")
        page.fill("#builderNewLabel", "Weather")
        page.click("#builderAddBtn")
        page.wait_for_selector("#saltFields [data-custom-label='W']")
        page.click("#exportViewToggleBtn")
        page.click("#setAtoBtn")
        page.fill("#atoDesignator", "FORMATB")
        page.click("#setAtoBtn")
        page.wait_for_function("() => activeAto === 'FORMATB'")
        self.assertEqual(
            page.locator("#saltFields [data-custom-label='W']").count(),
            1,
            "kept in a new workspace",
        )
        self.wait_for_server(page, "s => (s.format.lines || []).some(l => l.label === 'W')")
        # Another browser, in yet another workspace, has it too.
        second = self.browser.new_context(ignore_https_errors=True)
        self.addCleanup(second.close)
        other = second.new_page()
        other.on("pageerror", lambda exc: self.errors.append(str(exc)))
        other.goto(self.editor + "/")
        other.fill("#startupInitials", "CD")
        other.fill("#startupAto", "FORMATC")
        other.fill("#startupTitle", "Patrol")
        other.click("#startupContinueBtn")
        other.wait_for_selector("#saltFields [data-custom-label='W']")
        page.evaluate("saveFormat(defaultFormat())")
        self.wait_for_server(page, "s => !(s.format.lines || []).some(l => l.label === 'W')")

    def test_updating_shows_which_report_and_the_panel_keeps_its_width(self):
        page = self.open_editor(title="A very long workspace title for this patrol")
        page.set_viewport_size({"width": 1440, "height": 900})
        self.log(page, "2x BMP", activity="moving north along the wadi")
        page.click("#reportLogBody tr[data-id] .col-size:has-text('2x BMP')")
        self.assertEqual(page.text_content("#formTitle"), f"Updating {self.ato}001")
        note = page.text_content("#formEditingNote")
        self.assertIn("2x BMP", note)
        self.assertIn(f"{self.ato}001", note)
        page.click("#cancelButton")
        self.assertTrue(page.locator("#formEditingNote").is_hidden())
        widths, spots, names = [], [], []
        for btn in (
            None,
            "[data-home-go='map']",
            "#exportViewToggleBtn",
            "#statsViewToggleBtn",
            "#summaryViewToggleBtn",
        ):
            if btn:
                page.click(btn)
            widths.append(round(page.locator(".report-section").bounding_box()["width"]))
            # One top bar for every view: the name in the same spot, saying which.
            self.settle(page)  # the title's own fade-in
            box = page.locator("#homeTitle").bounding_box()
            spots.append((round(box["x"]), round(box["y"])))
            names.append(page.text_content("#homeTitle"))
        self.assertEqual(len(set(widths)), 1, widths)
        self.assertEqual(len(set(spots)), 1, spots)
        self.assertEqual(names, ["Report Log", "Map", "Manage", "Statistics", "Summary Reports"])
        # Closing a view goes back to the Report Log as it was: here, the map.
        page.click("#summaryViewToggleBtn")
        page.wait_for_selector("#mapPanel #mapSvg")
        self.assertTrue(page.locator("#mapPanel").is_visible())
        page.click("[data-home-go='list']")
        page.wait_for_selector("#mapPanel", state="hidden")
        self.assertTrue(page.locator("#reportLogTable").is_visible())
        # The button by each heading slides between the two; the heading doesn't scroll.
        page.hover(".report-header h2")
        page.mouse.wheel(0, 120)
        self.settle(page)  # a slide the wheel set off would be over
        self.assertTrue(page.locator("#logView").is_visible())
        self.assertEqual(page.text_content("#homeTitle"), "Report Log")
        page.click("[data-home-go='map']")
        page.wait_for_selector("#logView", state="hidden")
        self.assertEqual(page.text_content("#homeTitle"), "Map")
        page.click("[data-home-go='list']")
        page.wait_for_selector("#logView", state="visible")
        self.assertEqual(page.text_content("#homeTitle"), "Report Log")

    def test_mgrs_lock_fills_in_the_zone_and_square(self):
        page = self.open_editor()
        self.assertFalse(page.locator("#mgrsPrefix").is_visible(), "off until turned on")
        page.click("#dataMgmtBtn")
        page.click("#toggleMgrsLockBtn")
        page.wait_for_function("() => document.activeElement.id === 'mgrsPrefix'")
        page.fill("#mgrsPrefix", "38smb")
        page.click("#size")
        self.assertEqual(page.input_value("#mgrsPrefix"), "38S MB")
        self.assertEqual(page.text_content("#toggleMgrsLockBtn"), "MGRS Lock: On (38S MB)")
        self.log(page, "1x BTR", location="45000 82000, vic the bridge")
        page.wait_for_selector(
            "#reportLogBody .col-location:has-text('38S MB 45000 82000, vic the bridge')"
        )
        # Kept across a reload; off again leaves typed digits alone.
        page.reload()
        self.assertEqual(page.input_value("#mgrsPrefix"), "38S MB")
        page.click("#dataMgmtBtn")
        page.click("#toggleMgrsLockBtn")
        self.assertFalse(page.locator("#mgrsPrefix").is_visible())
        self.assertEqual(page.evaluate("lockedLocation('45000 82000')"), "45000 82000")

    def test_tracks_export_and_latest_only_csv(self):
        page = self.open_editor()
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000")
        page.click("#reportLogBody tr[data-id] .col-size:has-text('2x BMP')")
        page.fill("#location", "38SMB4500084000")
        page.click("#updateButton")
        page.wait_for_selector("#reportLogBody .col-location:has-text('38SMB4500084000')")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        with page.expect_download() as dl:
            self.run_io(page, "tracks-esri")
        self.assertTrue(dl.value.suggested_filename.endswith("_arcgis_tracks.json"))
        esri = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
        self.assertEqual(esri["geometryType"], "esriGeometryPolyline")
        self.assertEqual(len(esri["features"][0]["geometry"]["paths"][0]), 2)
        self.assertEqual(esri["features"][0]["attributes"]["direction"], "N")
        page.select_option("#ioFormatSelect", "csv")
        page.check("#exportLatestOnlyToggle")
        with page.expect_download() as dl:
            page.click("#ioRunBtn")
        lines = Path(dl.value.path()).read_text(encoding="utf-8-sig").strip().splitlines()
        self.assertEqual(len(lines), 2, "a header and the one report, not its update")

    def test_a_long_overlay_list_scrolls(self):
        page = self.open_editor()
        self.import_overlays(page)
        page.set_viewport_size({"width": 1280, "height": 480})
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='overlays']")
        panel = page.locator(".ws-tab-panel[data-tab-panel='overlays']")
        self.assertGreater(
            panel.evaluate("p => p.scrollHeight - p.clientHeight"), 0, "taller than its room"
        )
        last = page.locator("#overlaysBody tbody tr").last
        last.scroll_into_view_if_needed()
        box = last.bounding_box()
        self.assertLessEqual(box["y"] + box["height"], 480, "the last overlay can be reached")

    def test_statistics_panel_charts_and_exports(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x T-72", activity="moving N", location="38SMB4500082000")
        self.log(
            page,
            "1x BMP-2",
            activity="stationary",
            location="38S MB 55000 82000, NAI 1",
            choice="Keep NAI 1",
        )
        page.click("#statsViewToggleBtn")
        page.wait_for_selector(".stats-card[data-chart='nai'] svg")
        tiles = page.locator(".stats-tile").all_inner_texts()
        self.assertEqual([" ".join(t.split()) for t in tiles][:4],
                         ["Reports 2", "With a grid 2", "In an NAI or OBJ 2", "Checks to look at 1"])  # fmt: skip
        # Hover readout: value first, then what it counts.
        page.hover(".stats-card[data-chart='nai'] .stats-row[data-i='0'] .stats-hit")
        self.assertEqual(
            " ".join(page.locator(".stats-card[data-chart='nai'] .stats-tip").inner_text().split()),
            "2 reports · NAI 1",
        )
        page.click(".stats-card[data-chart='equipment'] [data-stats-act='table']")
        self.assertEqual(
            page.locator(".stats-card[data-chart='equipment'] .stats-table td").all_text_contents(),
            ["T-72", "2", "BMP-2", "1"],
        )
        with page.expect_download() as dl:
            page.click(".stats-card[data-chart='nai'] [data-stats-act='png']")
        self.assertTrue(Path(dl.value.path()).read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
        with page.expect_download() as dl:
            page.click("#statsExportAllBtn")
        with zipfile.ZipFile(dl.value.path()) as zf:
            self.assertIsNone(zf.testzip())
            names = zf.namelist()
            csv = zf.read("statistics.csv").decode("utf-8")
        self.assertIn("nai.png", names)
        self.assertIn("hours.svg", names)
        self.assertIn('"NAI 1",2', csv)
        self.assertEqual(
            page.locator(".stats-card[data-chart='squares']").count(), 0, "no grid squares chart"
        )
        # One Excel workbook: a chart per card with data, and the reports.
        with page.expect_download() as dl:
            page.click("#statsExcelBtn")
        self.assertTrue(dl.value.suggested_filename.endswith(".xlsx"))
        with zipfile.ZipFile(dl.value.path()) as zf:
            self.assertIsNone(zf.testzip())
            parts = {n: zf.read(n).decode("utf-8") for n in zf.namelist()}
        for text in parts.values():
            ET.fromstring(text)  # every part is well-formed XML
        charts = [n for n in parts if n.startswith("xl/charts/")]
        self.assertEqual(len(charts), page.locator(".stats-card svg").count())
        self.assertIn("Reports per NAI", parts["xl/charts/chart1.xml"])
        self.assertIn('ref="A1:', parts["xl/tables/table1.xml"])
        self.assertIn("2x T-72", parts["xl/sharedStrings.xml"])
        # Live: a report logged from the form shows up without reopening.
        page.click("#statsViewToggleBtn")
        self.log(page, "1x truck", activity="parked", location="38SMB4500082100")
        page.click("#statsViewToggleBtn")
        page.wait_for_selector(".stats-tile:has-text('Reports') .stats-tile-value:text-is('3')")

    def test_statistics_keep_an_open_table_through_a_sync(self):
        # Regression: every sync rebuilt the panel, closing the tables opened.
        page = self.open_editor()
        self.log(page, "2x T-72", activity="moving N", location="38SMB4500082000")
        page.click("#statsViewToggleBtn")
        card = ".stats-card[data-chart='equipment']"
        table = f"{card} [data-stats-act='table']"
        page.click(table)
        self.assertTrue(page.locator(f"{card} .stats-table").is_visible())
        # A sync that changes nothing leaves the panel as it is.
        page.evaluate("document.querySelector('.stats-grid').dataset.mark = 'same'")
        page.evaluate("renderStats()")
        self.assertEqual(page.get_attribute(".stats-grid", "data-mark"), "same")
        # One that does redraws it, the open table still open.
        page.fill("#size", "1x BMP-2")
        page.fill("#activity", "parked")
        page.fill("#location", "38SMB4500082100")
        page.click("#logButton")
        page.wait_for_selector(".stats-tile:has-text('Reports') .stats-tile-value:text-is('2')")
        self.assertIsNone(page.get_attribute(".stats-grid", "data-mark"))
        self.assertTrue(page.locator(f"{card} .stats-table").is_visible())
        self.assertEqual(page.get_attribute(table, "aria-pressed"), "true")
        self.assertIn("BMP-2", page.text_content(f"{card} .stats-table"))
        # And the focus where it was.
        page.focus(table)
        page.evaluate("statsBuilt = null; renderStats()")
        self.assertEqual(
            page.evaluate(
                "[document.activeElement.dataset.statsAct, document.activeElement.closest('.stats-card').dataset.chart]"
            ),
            ["table", "equipment"],
        )
        # The table is the chart's accessible version: reachable, labeled, and
        # the bars aren't tab stops of their own.
        self.assertEqual(page.locator(".stats-hit[tabindex]").count(), 0)
        self.assertEqual(
            page.get_attribute(table, "aria-label"), "Table of Reported by type, from Size"
        )
        self.assertEqual(page.locator(".stats-tip[role]").count(), 0)

    def test_summary_reports_write_copy_save_and_print(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x T-72", activity="moving N", location="38SMB4500082000")
        self.log(page, "1x BMP-2", activity="engaging", location="38SMB5300088000")
        page.click("#summaryViewToggleBtn")
        # Opens on the last twelve hours, with the Rollup.
        page.wait_for_selector("#summaryText:has-text('ROLLUP - ')")
        text = page.inner_text("#summaryText")
        self.assertIn("(12 HRS)", text)
        self.assertIn("   2 reports (previous 12 hrs: 0)", text)
        self.assertTrue(text.startswith(f"ROLLUP - {self.ato} (Patrol)"))
        page.click("[data-summary-kind='place']")
        self.assertEqual(
            page.get_attribute("[data-summary-kind].active", "data-summary-kind"), "place"
        )
        page.select_option("#summaryPlace", "NAI 2")
        page.wait_for_selector("#summaryText:has-text('NAI 2 ACTIVITY')")
        self.assertIn("1x BMP-2; engaging; 38SMB5300088000", page.inner_text("#summaryText"))
        with page.expect_download() as dl:
            page.click("#summarySaveBtn")
        self.assertIn("_place_NAI_2_", dl.value.suggested_filename)
        saved = Path(dl.value.path()).read_bytes()
        self.assertTrue(saved.startswith(b"NAI 2 ACTIVITY"))
        self.assertIn(b"\r\n", saved, "CRLF, for Notepad")
        # Print goes through a frame holding the text and its charts.
        page.click("[data-summary-kind='rollup']")
        self.assertEqual(page.evaluate("summaryCharts().map(c => c.id)"), ["nai", "hours", "tags"])
        page.click("#summaryPrintBtn")
        page.wait_for_function("() => !document.querySelector('iframe')")
        # The narrative: what was seen, then what it suggests, then the gaps.
        page.click("[data-summary-kind='narrative']")
        page.wait_for_selector("#summaryText:has-text('NARRATIVE - ')")
        text = page.inner_text("#summaryText")
        for part in ("1. OBSERVED", "2. ASSESSMENT", "3. GAPS", "armor (2x T-72)", "ICD 203"):
            self.assertIn(part, text)
        self.assertLess(text.index("1. OBSERVED"), text.index("2. ASSESSMENT"))
        self.assertEqual(page.evaluate("summaryCharts().map(c => c.id)"), ["nai", "tags"])

    def test_each_judgment_lists_its_reports_and_opens_them_in_the_log(self):
        self.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=self.editor)
        page = self.open_editor()
        self.import_overlays(page)
        # Digging in and obstacles in NAI 1: a defense, from those two; the
        # trucks are behind nothing.
        self.log(page, "6x PAX", activity="digging in", location="38SMB4500082000")
        self.log(page, "4x PAX", activity="emplacing obstacles", location="38SMB4600082000")
        self.log(page, "3x trucks", activity="moving N", location="38SMB4500083000")
        by_size = page.evaluate(
            "Object.fromEntries(localReports.map(r => [r.size, [r.id, r.displayId]]))"
        )
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='narrative']")
        page.wait_for_selector("#summaryText:has-text('2. ASSESSMENT')")
        sources = page.locator("#summaryText .summary-sources").first
        self.assertTrue(sources.inner_text().startswith("From "))
        self.assertEqual(
            sources.locator("[data-summary-source]").all_text_contents(),
            [by_size["6x PAX"][1], by_size["4x PAX"][1]],
        )
        # Under the judgment, after its last line: the next judgment or the
        # blank line before GAPS follows it.
        self.assertEqual(
            page.evaluate("""() => {
                const s = document.querySelector('#summaryText .summary-sources');
                return [/^ {6}\\S/.test(s.previousSibling.textContent.split('\\n').pop()),
                        /^(\\n|   [b-j]\\. )/.test(s.nextSibling.textContent)];
            }"""),
            [True, True],
        )
        # Copy has the text alone.
        page.click("#summaryCopyBtn")
        page.wait_for_selector("#toastNotification:has-text('Report copied.')")
        copied = page.evaluate("navigator.clipboard.readText()").replace("\r\n", "\n")
        self.assertEqual(copied, page.evaluate("summaryText"))
        self.assertIn("preparing a defense in NAI 1", " ".join(copied.split()))
        self.assertNotIn("From ", copied)
        # Editing the text: no lists while the box is open, nor under your own wording.
        page.click("#summaryEditBtn")
        self.assertFalse(sources.is_visible())
        page.fill("#summaryEditor", "MY OWN WORDING")
        page.click("#summaryEditBtn")
        self.assertEqual(page.locator("#summaryText .summary-sources").count(), 0)
        page.click("#summaryRevertBtn")
        page.wait_for_selector("#summaryText .summary-sources")
        # More than eight: the rest behind "and N more", which shows them.
        self.assertEqual(
            page.evaluate("""() => {
                const pre = document.getElementById('summaryText');
                const fake = Array.from({ length: 11 }, (_, i) => ({ ...localReports[0], id: `fake${i}`, displayId: `F${i}` }));
                localReports.push(...fake);
                showSummaryText(pre, { text: 'A\\nB\\n', judgments: [{ rule: 'x', level: 3, line: 0, sources: fake.map(r => r.id) }] });
                localReports.splice(-fake.length);
                const shown = () => [...pre.querySelectorAll('[data-summary-source]')].filter(b => !b.hidden).length;
                const before = [shown(), pre.querySelector('[data-summary-more]').textContent];
                pre.querySelector('[data-summary-more]').click();
                return [...before, shown(), !!pre.querySelector('[data-summary-more]'), pre.textContent];
            }"""),
            [8, "and 3 more", 11, False, "AFrom F0, F1, F2, F3, F4, F5, F6, F7, F8, F9, F10B\n"],
        )
        page.evaluate("renderSummary()")
        # A search hiding the report is cleared; the Report Log shows its row, flashing.
        page.click("#summaryViewToggleBtn")
        page.fill("#searchBar", "trucks")
        page.wait_for_function(
            "document.querySelectorAll('#reportLogBody tr[data-id]').length === 1"
        )
        page.click("#summaryViewToggleBtn")
        page.wait_for_selector("#summaryText .summary-sources")
        page.locator("#summaryText [data-summary-source]").nth(1).click()
        page.wait_for_selector("#summaryPanel", state="hidden")
        flashing = page.wait_for_selector("#reportLogBody tr.flash")
        self.assertEqual(flashing.get_attribute("data-id"), by_size["4x PAX"][0])
        self.assertEqual(page.input_value("#searchBar"), "")
        self.assertTrue(flashing.is_visible())

    def test_summary_charts_count_what_statistics_counts(self):
        # Regression: the Summary's charts always left out a report with no
        # time; Statistics only when the window has a bound.
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x T-72", activity="moving N", location="38SMB4500082000")
        page.click("#summaryViewToggleBtn")
        # Both over every report, one of them with no time (in one go, so no
        # sync replaces the reports between).
        counts = page.evaluate("""() => {
            localReports.push({ ...localReports[0], id: 'no-time', time: '' });
            fillWindow(summaryEls(), 0);
            fillWindow(statsEls(), 0);
            const nai = items => items.find(i => i.label === 'NAI 1').value;
            const summary = nai(summaryCharts().find(c => c.id === 'nai').items);
            const stats = nai(SaltCore.statsData(statsWindow().reps, currentOverlays(), {}).nai);
            localReports.pop();
            return [summary, stats];
        }""")
        self.assertEqual(counts, [2, 2])
        # Straight from one view to another: the Report Log isn't drawn and
        # animated in between.
        page.evaluate("document.getElementById('homeView').classList.remove('view-in')")
        page.click("#statsViewToggleBtn")
        page.wait_for_selector("#statsPanel", state="visible")
        page.click("#summaryViewToggleBtn")
        self.assertFalse(
            page.evaluate("document.getElementById('homeView').classList.contains('view-in')")
        )
        # Closed, it's the Report Log again.
        page.click("#summaryViewToggleBtn")
        page.wait_for_selector("#reportLogTable")
        self.assertTrue(
            page.evaluate("document.getElementById('homeView').classList.contains('view-in')")
        )

    def test_summary_edge_cases_and_the_narrative_edited_unwrapped(self):
        page = self.open_editor()
        self.import_overlays(page)
        long = "moving north along the main supply route toward the river crossing site by the old bridge"
        self.log(page, "2x T-72", activity=long, location="38SMB4500082000")
        self.log(page, "3x BMP-2", activity=long, location="38SMB4600082000")
        page.click("#summaryViewToggleBtn")
        # An unknown kind (from another version) or a one-line text: no charts, no error.
        self.assertEqual(
            page.evaluate("""() => {
                const kind = summaryKind, text = summaryText;
                summaryKind = 'bogus'; const a = summaryCharts().length;
                summaryKind = kind; summaryText = 'ONE LINE'; const b = summaryCharts().length >= 0;
                summaryText = text;
                return [a, b];
            }"""),
            [0, True],
        )
        # Edit on the Narrative starts from its paragraphs unwrapped: the box
        # wraps them to its width, so no line breaks twice.
        page.click("[data-summary-kind='narrative']")
        page.wait_for_selector("#summaryText:has-text('2. ASSESSMENT')")
        # The text shown, without the lists of reports under the judgments.
        shown = page.evaluate("""() => {
            const pre = document.getElementById('summaryText').cloneNode(true);
            pre.querySelectorAll('.summary-sources').forEach(n => n.remove());
            return pre.textContent;
        }""")
        page.click("#summaryEditBtn")
        edited = page.input_value("#summaryEditor")
        self.assertEqual(" ".join(edited.split()), " ".join(shown.split()))
        self.assertLess(len(edited.splitlines()), len(shown.splitlines()))
        self.assertGreater(max(len(line) for line in edited.splitlines()), 100)
        # Opened and closed without a change: not an edit.
        page.click("#summaryEditBtn")
        self.assertFalse(page.locator("#summaryEdited").is_visible())

    def test_the_narrative_names_units_takes_your_equipment_and_rules_and_can_be_edited(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "6x PAX", activity="digging in", location="38SMB4500082000")
        self.log(page, "1x XYZ-9", activity="emplacing obstacles", location="38SMB4600082000")
        self.log(page, "1x PMP", activity="bridging the wadi", location="38SMB4600083000")
        self.log(page, "2x trucks", activity="at the ferry site", location="38SMB4500083000")
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='narrative']")
        page.wait_for_selector("#summaryText:has-text('2. ASSESSMENT')")
        flat = lambda: " ".join(page.inner_text("#summaryText").split())  # noqa: E731
        self.assertIn("that enemy forces are preparing a defense in NAI 1.", flat())
        self.assertIn("logistics and support (2x trucks)", flat())
        # The settings: always there on the Narrative, a column beside the
        # report the full height of the view; no other report has them.
        side = page.locator("#narrSettings").bounding_box()
        text = page.locator("#summaryText").bounding_box()
        kinds = page.locator(".summary-col > .summary-kinds").bounding_box()
        self.assertGreaterEqual(side["x"], text["x"] + text["width"], "beside the report")
        self.assertLessEqual(side["y"], kinds["y"], "from the top")
        self.assertAlmostEqual(side["y"] + side["height"], text["y"] + text["height"], delta=2)
        page.click("[data-summary-kind='rollup']")
        self.assertFalse(page.locator("#narrSettings").is_visible())
        page.click("[data-summary-kind='narrative']")
        self.assertTrue(page.locator("#narrSettings").is_visible())
        # What the enemy is called.
        page.fill("#narrEnemy", "OPFOR")
        page.press("#narrEnemy", "Enter")
        page.wait_for_selector("#toastNotification:has-text('calls them OPFOR')")
        self.assertIn("that OPFOR are preparing a defense in NAI 1.", flat())
        # A unit, in NAI 1: where it operates and what it has are dropdowns;
        # Other brings up a box for places not in the list.
        page.click("[data-narr-add]")
        page.fill("#narrUnitName", "1-60 GMRB")
        self.assertEqual(page.text_content("[data-narr-dd='place'] .narr-dd-value"), "Anywhere")
        self.assertFalse(page.locator("#narrUnitOther").is_visible())
        page.click("[data-narr-dd='place'] .narr-dd-btn")
        page.click("[data-narr-place='NAI 1']")
        self.assertTrue(
            page.locator("[data-narr-place='NAI 2']").is_visible(), "stays open while picking"
        )
        page.click("[data-narr-place='']")
        self.assertFalse(
            page.locator("[data-narr-place='NAI 2']").is_visible(), "Other: the menu makes way"
        )
        self.assertTrue(page.locator("#narrUnitOther").is_visible())
        self.assertEqual(page.evaluate("document.activeElement.id"), "narrUnitOther")
        page.keyboard.type("38S MB 49")
        page.click("[data-narr-dd='place'] .narr-dd-btn")
        page.click("[data-narr-place='']")
        self.assertFalse(
            page.locator("#narrUnitOther").is_visible(), "Other off: no box, and not saved"
        )
        self.assertEqual(page.text_content("[data-narr-dd='place'] .narr-dd-value"), "NAI 1")
        page.keyboard.press("Escape")
        self.assertFalse(page.locator("[data-narr-place='NAI 1']").is_visible(), "Escape closes it")
        page.click("[data-narr-dd='kind'] .narr-dd-btn")
        page.click("[data-narr-kind='infantry']")
        page.click("#narrUnitName")
        self.assertFalse(
            page.locator("[data-narr-kind='infantry']").is_visible(), "closed by a click elsewhere"
        )
        self.assertEqual(
            page.text_content("[data-narr-dd='kind'] .narr-dd-value"), "dismounted personnel"
        )
        page.click("[data-narr-save]")
        page.wait_for_selector("#toastNotification:has-text('1-60 GMRB saved')")
        self.assertEqual(page.text_content("[data-narr-tab='units'] .narr-count"), "1")
        self.assertIn("that elements of 1-60 GMRB are preparing a defense in NAI 1.", flat())
        self.assertIn("Unit: from the unit list, 1-60 GMRB (NAI 1; dismounted personnel).", flat())
        # Equipment the catalogue doesn't know: a dot on the tab, offered first.
        self.assertTrue(page.locator("[data-narr-tab='equipment'] .narr-dot").is_visible())
        page.click("[data-narr-tab='equipment']")
        page.fill("#narrEqFind", "T-72B3")
        self.assertEqual(page.text_content("#narrEqFindSays"), "Built in: armor (T-72, Russian).")
        page.click("[data-narr-fill='XYZ-9']")
        self.assertEqual(page.input_value("#narrEqType"), "XYZ-9")
        self.assertEqual(page.text_content("#narrEqSays"), "Not in the catalogue.")
        page.click("[data-narr-save]")
        page.wait_for_selector("#toastNotification:has-text('Pick what XYZ-9 is')")
        page.click("[data-narr-role='engineer']")
        page.click("[data-narr-save]")
        page.wait_for_selector("#toastNotification:has-text('XYZ-9 saved')")
        self.assertIn("engineers (1x PMP, 1x XYZ-9)", flat())
        self.assertNotIn("Not in the equipment catalogue", flat())
        self.assertEqual(page.locator("[data-narr-tab='equipment'] .narr-dot").count(), 0)
        # A rule switched off, and one of the team's own.
        page.click("[data-narr-tab='rules']")
        page.uncheck("[data-narr-rule='defense']")
        page.wait_for_selector("#toastNotification:has-text('Preparing a defense: off')")
        self.assertNotIn("preparing a defense", flat())
        page.click("[data-narr-add]")
        page.fill("#narrRuleWhat", "are preparing a river crossing")
        page.fill("#narrRuleWords", "bridging, ferry")
        page.click("[data-narr-save]")
        page.wait_for_selector("#toastNotification:has-text('Rule saved for everyone')")
        # Its reports (a PMP, trucks) have none of the unit's kind: said of OPFOR.
        self.assertIn("that OPFOR are preparing a river crossing in NAI 1.", flat())
        # A saved one opens from its row; Remove asks first, and Back leaves it.
        page.click("[data-narr-tab='units']")
        page.click("[data-narr-edit='0']")
        self.assertEqual(page.input_value("#narrUnitName"), "1-60 GMRB")
        page.click("[data-narr-remove]")
        self.assertEqual(page.text_content("[data-narr-remove]"), "Remove for everyone?")
        page.click("[data-narr-back]")
        self.assertEqual(page.locator("[data-narr-edit]").count(), 1, "still there")
        # A backup made by hand carries them.
        kept = page.evaluate(
            "SaltCore.parseBackup(generateBackupText(activeAto, localReports, 'Patrol', {})).data.narrative"
        )
        self.assertEqual((kept["enemy"], kept["units"][0]["name"]), ("OPFOR", "1-60 GMRB"))
        # Shared: a viewer's narrative says the same, and the viewer can't change it.
        viewer = self.open_viewer()
        viewer.click("#summaryViewToggleBtn")
        viewer.click("[data-summary-kind='narrative']")
        viewer.wait_for_selector("#summaryText:has-text('river crossing')")
        self.assertTrue(viewer.is_disabled("#narrEnemy"))
        self.assertFalse(viewer.locator("[data-narr-add]").is_visible())
        # Edit text: your own words, kept for Copy and Save, per workspace and
        # through a reload, until Revert.
        page.click("#summaryEditBtn")
        page.fill("#summaryEditor", "MY OWN WORDING")
        page.click("#summaryEditBtn")
        self.assertEqual(page.inner_text("#summaryText"), "MY OWN WORDING")
        self.assertTrue(page.locator("#summaryEdited").is_visible())
        with page.expect_download() as dl:
            page.click("#summarySaveBtn")
        self.assertEqual(Path(dl.value.path()).read_bytes(), b"MY OWN WORDING")
        page.reload()
        page.wait_for_selector("#summaryText:has-text('MY OWN WORDING')")
        page.click("[data-summary-kind='rollup']")
        page.wait_for_selector("#summaryText:has-text('ROLLUP - ')")
        page.click("[data-summary-kind='narrative']")
        self.assertEqual(page.inner_text("#summaryText"), "MY OWN WORDING", "kept per report")
        page.click("#summaryRevertBtn")
        self.assertIn("2. ASSESSMENT", page.inner_text("#summaryText"))
        self.assertFalse(page.locator("#summaryEdited").is_visible())
        page.evaluate("saveNarrative({ enemy: '', units: [], equipment: [], off: [], custom: [] })")

    def test_narrative_settings_save_and_remove_the_entry_opened(self):
        # Regression: an open entry was known by its place in the list, so an
        # entry added or removed by someone else meanwhile made Save overwrite,
        # and Remove delete, the wrong one.
        page = self.open_editor()
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='narrative']")
        unit = "u => ({ name: u, places: [], kinds: [] })"
        page.evaluate(f"saveNarrative({{ units: ['A-1', 'B-2'].map({unit}) }})")
        page.wait_for_selector("[data-narr-id='b-2']")
        self.synced(page)
        page.click("[data-narr-id='b-2']")
        # Someone else removes A-1 (a sync), under the open form.
        page.evaluate(
            f"sharedNarrative = {{ ...sharedNarrative, units: ['B-2'].map({unit}) }}; renderSummary()"
        )
        page.fill("#narrUnitName", "B-3")
        page.click("[data-narr-save]")
        page.wait_for_selector("#toastNotification:has-text('B-3 saved')")
        self.assertEqual(page.evaluate("sharedNarrative.units.map(u => u.name)"), ["B-3"])
        self.synced(page)
        # And removes B-3 while it's open here: Remove says so and changes nothing.
        page.click("[data-narr-id='b-3']")
        page.evaluate(
            f"sharedNarrative = {{ ...sharedNarrative, units: ['C-4'].map({unit}) }}; renderSummary()"
        )
        page.click("[data-narr-remove]")
        page.click("[data-narr-remove]")
        page.wait_for_selector("#toastNotification:has-text('Someone else removed B-3')")
        self.assertEqual(page.evaluate("sharedNarrative.units.map(u => u.name)"), ["C-4"])
        page.wait_for_selector("#narrUnitName", state="detached")
        page.evaluate("saveNarrative({ enemy: '', units: [], equipment: [], off: [], custom: [] })")

    def test_the_narrative_settings_and_map_controls_say_what_they_are(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "1x XYZ-9", location="38SMB4500082000")
        self.open_map(page)
        # Labeled groups, the slider read as the time it shows, switches as switches.
        self.assertEqual(page.get_attribute("#mapBox .map-tools", "role"), "group")
        self.assertEqual(page.get_attribute("#mapBox .filter-presets", "role"), "group")
        self.assertEqual(page.get_attribute("#mapEndRange", "aria-valuetext"), "Now")
        page.fill("#mapEndRange", "0")
        page.dispatch_event("#mapEndRange", "input")
        self.assertEqual(
            page.get_attribute("#mapEndRange", "aria-valuetext"), page.text_content("#mapEndLabel")
        )
        page.click("#mapEndNow")
        page.click("#mapDroneBtn")
        self.assertEqual(page.locator("#mapDronePop input[role='switch']").count(), 2)
        page.click("#mapDroneBtn")
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='narrative']")
        # The dot on Equipment is said, not only shown.
        self.assertIn("catalogue doesn't know", page.text_content("[data-narr-tab='equipment']"))
        # A dropdown's menu is a group of toggle buttons, its button named by its question.
        page.click("[data-narr-add]")
        page.click("[data-narr-dd='kind'] .narr-dd-btn")
        self.assertEqual(page.get_attribute("[data-narr-dd='kind'] .narr-dd-menu", "role"), "group")
        page.click("[data-narr-kind='infantry']")
        self.assertEqual(page.get_attribute("[data-narr-kind='infantry']", "aria-pressed"), "true")
        self.assertEqual(
            page.locator(".narr-panel [role='option'], .narr-panel [role='listbox']").count(), 0
        )
        self.assertEqual(
            page.get_by_role("button", name="What it has dismounted personnel").count(), 1
        )
        page.click("[data-narr-back]")
        # One choice of several: radios, one tab stop, the arrow keys move the choice.
        page.click("[data-narr-tab='equipment']")
        page.click("[data-narr-fill='XYZ-9']")
        radio = "[role='radiogroup'][aria-label='What it is'] [role='radio']"
        self.assertEqual(
            page.locator(radio).evaluate_all("rs => rs.filter(r => r.tabIndex === 0).length"), 1
        )
        page.focus(f"{radio} >> nth=0")
        page.keyboard.press("ArrowRight")
        self.assertEqual(page.get_attribute(f"{radio} >> nth=1", "aria-checked"), "true")
        self.assertEqual(page.get_attribute(f"{radio} >> nth=0", "aria-checked"), "false")
        self.assertEqual(
            page.evaluate("document.activeElement.getAttribute('aria-checked')"), "true"
        )
        page.click("[data-narr-back]")
        page.click("[data-narr-tab='rules']")
        self.assertEqual(
            page.locator("input.narr-switch:not([role='switch'])").count(), 0, "every one a switch"
        )

    def test_escape_in_the_narrative_settings_leaves_an_edit_alone(self):
        # Regression: Escape closed the settings' form and canceled the edit too.
        page = self.open_editor()
        self.log(page, "2x BMP")
        page.click("#reportLogBody tr[data-id] .col-size:has-text('2x BMP')")
        self.assertTrue(page.locator("#cancelButton").is_visible())
        page.click("#summaryViewToggleBtn")
        page.click("[data-summary-kind='narrative']")
        page.click("[data-narr-add]")
        page.click("[data-narr-dd='kind'] .narr-dd-btn")
        page.keyboard.press("Escape")
        self.assertFalse(page.locator("[data-narr-kind='infantry']").is_visible())
        self.assertEqual(
            page.evaluate("document.activeElement.closest('[data-narr-dd]').dataset.narrDd"), "kind"
        )
        page.keyboard.press("Escape")
        page.wait_for_selector("#narrUnitName", state="detached")
        self.assertTrue(page.locator("#cancelButton").is_visible(), "still editing")

    def test_the_welcome_screen_hides_the_page_whichever_view_was_last(self):
        # The map's panes set their own visibility to slide; none may show through.
        self.context.add_init_script("localStorage.setItem('salt_log_view', 'map')")
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.editor + "/")
        page.wait_for_selector("#startupModal.show")
        self.settle(page)  # past the panes' own transitions
        shown = page.evaluate(
            """[...document.querySelectorAll('.app-wrapper *')]
                .filter(e => getComputedStyle(e).visibility === 'visible' && e.getClientRects().length)
                .filter(e => { for (let n = e; n; n = n.parentElement) if (getComputedStyle(n).opacity === '0') return false; return true; })
                .map(e => e.id || e.className)"""
        )
        self.assertEqual(shown, [])

    def test_geojson_from_arcgis_in_web_mercator_is_converted(self):
        page = self.open_editor()
        result = page.evaluate(
            """() => {
                const merc = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:3857' } },
                    features: [{ type: 'Feature', properties: { Name: 'OBJ Gold' },
                                 geometry: { type: 'Point', coordinates: [4937670.08, 3929510.64] } }] };
                const ok = geojsonFeatures(merc, 'objs.geojson')[0];
                let refused = '';
                try { geojsonFeatures({ ...merc, crs: { type: 'name', properties: { name: 'EPSG:32638' } } }, 'x'); }
                catch (e) { refused = e.message; }
                return { label: ok.label, coords: ok.geometry.coordinates, refused };
            }"""
        )
        self.assertEqual(result["label"], "OBJ Gold")
        self.assertAlmostEqual(result["coords"][0], 44.355845, places=5)
        self.assertAlmostEqual(result["coords"][1], 33.257333, places=5)
        self.assertIn("Project to WGS 1984", result["refused"])


if __name__ == "__main__":
    unittest.main()

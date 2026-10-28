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
        # HTTPS, as the server starts by default, with its self-signed certificate.
        cls.editor = f"https://127.0.0.1:{cls.port}"
        cls.viewer = f"https://127.0.0.1:{cls.viewer_port}"
        unverified = ssl._create_unverified_context()
        deadline = time.monotonic() + 15
        while True:
            try:
                urllib.request.urlopen(cls.editor + "/", timeout=1, context=unverified).close()
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
        self.context = self.browser.new_context(ignore_https_errors=True)
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
                """() => ({ toast: document.querySelector('#toast-notification').textContent,
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
        self.assertIn("BDA 0 / 7", page.locator("#bdaRollup").text_content())
        # Assess the first element of the first report as destroyed: all four.
        page.click(
            "#reportLogBody tr[data-id]:has(.col-size:has-text('4x T-72, 2x BMP-2')) .bda-btn"
        )
        page.click(".bda-check-row[data-row='0'] .bda-eff-btn[data-bda-eff='Destroyed']")
        page.click(".bda-commit-btn")
        page.wait_for_selector("#bdaRollup:has-text('BDA 4 / 7')")
        # Let that save settle: the server has it and this page has pulled it back.
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => Object.values(s.workspaces).flat().some(r => (r.bda || []).length === 1))"
        )
        page.wait_for_timeout(500)
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

    def test_typing_survives_a_sync(self):
        # Regression: every sync re-laid the form out, which took the cursor
        # out of the box being typed in; the rest of the word went nowhere.
        page = self.open_editor()
        page.click("#size")
        page.keyboard.type("2x B")
        page.evaluate("() => syncWithServer()")
        page.wait_for_timeout(200)
        page.keyboard.type("MP")
        self.assertEqual(page.input_value("#size"), "2x BMP")

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
        page.wait_for_selector("#toast-notification:has-text('Imported 4 overlays')")
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
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.overlays.length === 4)"
        )
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
            "1 without a readable grid", page.locator("#toast-notification").text_content()
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
        other.fill("#startup-initials", "CD")
        other.fill("#startup-ato", "SHAREDTWO")
        other.fill("#startup-title", "Patrol")
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
        self.assertEqual(page.locator(".overlay-group[data-overlay-group='PL'][open]").count(), 0)
        page.click("#confirmActionBtn")
        page.wait_for_selector(".overlay-group[data-overlay-group='PL']", state="detached")
        page.click("[data-overlay-fold='open']")
        self.assertEqual(page.locator(".overlay-group:not([open])").count(), 0, "all open")
        page.click("[data-overlay-fold='close']")
        self.assertEqual(page.locator(".overlay-group[open]").count(), 0, "all closed")
        page.click(".overlay-group[data-overlay-group='OBJ'] summary")
        page.click(".overlay-group[data-overlay-group='OBJ'] .overlay-remove")
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.overlays.map(o => o.type + ' ' + o.name).join() === 'NAI 1,NAI 2')"
        )

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
        self.assertIn("SCOPEB", page.text_content("#stats-panel-subtitle"))
        page.click("[data-stats-scope='all']")
        page.wait_for_selector(".stats-card[data-chart='ato']")
        self.assertIn("All ATOs", page.text_content("#stats-panel-subtitle"))
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
        self.assertTrue(shown("#export-from-date"))
        # Clear sits in the card's header, always there, and empties the range.
        self.assertEqual(page.locator(".io-time .io-card-head #exportClearFilterBtn").count(), 1)
        self.assertTrue(shown("#exportClearFilterBtn"))
        page.click("[data-preset-hours='24']")
        self.assertNotEqual(page.input_value("#export-from-date"), "")
        self.assertNotEqual(
            page.input_value("#export-from-date"), page.input_value("#export-to-date")
        )
        page.click("#exportClearFilterBtn")
        self.assertEqual(page.input_value("#export-from-date"), "")
        self.assertTrue(shown("#exportClearFilterBtn"))
        # The list holds exports only; clicking the drop area chooses files to import.
        options = page.locator("#ioFormatSelect option").evaluate_all("os => os.map(o => o.value)")
        self.assertNotIn("overlays", options)
        with page.expect_file_chooser() as fc:
            page.click("#ioDrop")
        self.assertTrue(fc.value.is_multiple())
        # The choice is remembered; viewers only export.
        page.reload()
        page.wait_for_function("() => isExportViewActive")  # the view on screen is restored too
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
        page.wait_for_selector("#confirmation-message:has-text('backup file')")
        page.click("#confirmActionBtn")
        page.wait_for_selector("#toast-notification:has-text('Import successful')")
        # Chosen from the drop area: a CSV goes to column matching...
        if not page.evaluate("isExportViewActive"):
            page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        csv = self.tmp / "other tool.csv"
        csv.write_text("Name,Count,MGRS\nA1,2x BTR,18SUJ1234\n", encoding="utf-8")
        page.set_input_files("#ioDropInput", str(csv))
        page.wait_for_selector("#csvImportPanel", state="visible")
        self.assertIn("other tool.csv", page.text_content("#csvImportSubtitle"))
        page.click("#closeCsvImportBtn")
        # ...and overlay files to the Overlays tab, to review.
        if not page.evaluate("isExportViewActive"):
            page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")
        page.set_input_files("#ioDropInput", str(self.overlay_kmz()))
        page.wait_for_selector("#overlaysBody .overlay-type-select")
        # A CSV and an overlay together can't go in as one import.
        page.click(".ws-tab[data-tab='export']")
        page.set_input_files("#ioDropInput", [str(csv), str(self.overlay_kmz())])
        page.wait_for_selector("#toast-notification:has-text('Drop one backup or CSV at a time')")

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
        page.wait_for_selector("#toast-notification:has-text('Imported 1 overlay')")
        iron = page.evaluate("() => sharedOverlays.find(o => o.name === 'IRON')")
        self.assertEqual(
            (iron["type"], iron["geometry"]["type"], len(iron["geometry"]["coordinates"])),
            ("OBJ", "Polygon", 2),
        )
        # A .dbf without its .shp is named, not silently dropped.
        page.set_input_files("#overlaysFileInput", [loose[1]])
        page.wait_for_selector(
            "#toast-notification:has-text(\"its .shp file wasn't picked with it\")"
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
        # The graphics in their colours: NAI green, OBJ blue, PL black on white.
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
        before = page.evaluate("mapView.mpp")
        page.click("[data-map-zoom='in']")
        page.wait_for_function(f"() => mapView.mpp < {before}")
        page.click("[data-map-zoom='out']")
        page.click("[data-map-zoom='out']")
        page.wait_for_function(f"() => Math.abs(mapView.mpp - {before}) < 1e-6")

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
        page.wait_for_selector(f"#toast-notification:has-text('{name} added')")
        self.assertEqual(page.input_value("#mapBaseInput"), "", "the box is emptied")
        self.back_to_map(page)

    def add_wms(self, page, link, titles):
        """Look a WMS up from its link, tick the layers with these titles, add them."""
        self.open_basemaps(page)
        page.fill("#mapBaseInput", link)
        page.click("#mapBaseAddBtn")
        page.wait_for_selector(".map-layer-list, .map-find-error")
        self.assertEqual(
            page.locator(".map-find-error").count(), 0, page.evaluate("JSON.stringify(wmsFind)")
        )
        for t in titles:
            page.check(f".map-layer-row:has(.map-layer-title:text-is('{t}')) input")
        page.click("#mapWmsAdd")
        page.wait_for_selector("#toast-notification:has-text('added for everyone')")
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
        for _ in range(50):  # the image is on the page before its request is logged
            if asked:
                break
            page.wait_for_timeout(100)
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
        for _ in range(50):
            if asked:
                break
            page.wait_for_timeout(100)
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
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.basemaps.map(b => b.name).join() === 'Imagery,basemap.test')"
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
        page.wait_for_selector("#toast-notification:has-text('basemap.test saved')")
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.basemaps[1].url.includes('/topo/'))"
        )
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
        # No x on the rows: a service is removed from its details, and asked first.
        self.assertEqual(page.locator("#mapBasemapForm .overlay-remove").count(), 0)
        page.click("[data-base-open='0']")
        page.wait_for_selector(".map-base-detail .map-layer-list")
        self.assertTrue(page.is_checked(".map-layer-row:has-text('Imagery 2024') input"))
        page.click("#mapBaseRemove")
        self.assertEqual(page.text_content("#mapBaseRemove"), "Remove for everyone?")
        self.assertEqual(page.locator(".map-base-row").count(), 2, "not yet")
        page.click("#mapBaseRemove")
        page.wait_for_selector("#toast-notification:has-text('Imagery removed')")
        self.assertEqual(page.locator(".map-base-detail").count(), 0)
        self.back_to_map(page)
        self.assertEqual(
            page.locator("#mapBaseSelect option").all_text_contents(),
            ["No basemap", "basemap.test"],
        )
        page.evaluate("saveBasemaps([])")

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
        self.assertEqual(page.text_content("#mapWmsAdd"), "Add 2 layers as one")
        page.click("#mapWmsAdd")
        page.wait_for_selector("#toast-notification:has-text('Range Maps added')")
        self.back_to_map(page)
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.basemaps.some(b => b.name === 'Range Maps'))"
        )
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
        for _ in range(50):
            if any("GetMap" in p for p in seen):
                break
            time.sleep(0.1)
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
        page.evaluate(
            f"checkBasemap({{ name: 'Range Maps', kind: 'wms', url: '{base}', layers: 'bad' }})"
        )
        page.wait_for_selector(".map-base-check:has-text('not defined')")
        page.wait_for_timeout(4600)
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
        self.assertEqual(page.text_content("#mapWmsAdd"), "Tick layers to keep")
        page.check(".map-layer-row:has-text('Roads') input")
        page.click("#mapWmsAdd")
        page.wait_for_selector("#toast-notification:has-text('Range Maps saved')")
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.basemaps.length === 1 && s.basemaps[0].layers === 'roads')"
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
        i = page.evaluate("mapItems.findIndex(x => x.t.report.size === '2x BMP')")
        page.click(f"#mapSvg [data-map-item='{i}'] .map-hit")
        page.wait_for_selector("#mapCard:not([hidden])")
        self.assertIn("2x BMP", page.text_content("#mapCard"))
        self.assertIn("2x BMP", page.text_content("#mapTableBody tr.selected-row"))
        page.wait_for_selector("#mapSvg .map-selected")
        # Show in table flashes the row; Edit puts the report in the form.
        page.click("[data-card-act='table']")
        page.wait_for_selector("#mapTableBody tr.flash")
        page.click("[data-card-act='edit']")
        self.assertIn("Updating", page.text_content("#form-title"))
        page.click("#cancelButton")
        page.click("[data-card-act='close']")
        self.assertTrue(page.locator("#mapCard").is_hidden())
        # A row puts the map on its report, zooming in from all the way out.
        page.click("[data-map-zoom='fit']")
        page.wait_for_function("() => mapView.mpp >= mapFitMpp * 0.99")
        page.click("#mapTableBody tr[data-map-row]:has-text('1x truck')")
        page.wait_for_function("() => mapView.mpp < mapFitMpp * 0.5")
        self.assertIn("1x truck", page.text_content("#mapCard"))
        ring = page.locator("#mapSvg .map-selected circle").first.bounding_box()
        box = page.locator("#mapBox").bounding_box()
        self.assertTrue(box["x"] < ring["x"] < box["x"] + box["width"], (ring, box))
        self.assertTrue(box["y"] < ring["y"] < box["y"] + box["height"], (ring, box))
        page.click("[data-card-act='close']")
        # Clicking inside NAI 1 narrows the table to it; its chip widens it again.
        page.click("[data-map-zoom='fit']")
        page.evaluate("document.querySelector('.map-view').scrollTop = 0")
        page.wait_for_timeout(300)
        xy = page.evaluate("""() => {
            const r = document.getElementById('mapBox').getBoundingClientRect();
            const [x, y] = SaltCore.lonLatToMerc(44.36, 33.34);
            return [r.left + 1 + (x - mapView.cx) / mapView.mpp + (r.width - 2) / 2, r.top + 1 + (mapView.cy - y) / mapView.mpp + (r.height - 2) / 2];
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
            const t = mapLastDraw.tracks.find(x => x.report.size === '1x truck'), p = t.points[0];
            [mapView.cx, mapView.cy] = SaltCore.lonLatToMerc(p.lon, p.lat); mapView.mpp = 1; drawMap();
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
        field = page.locator("#startup-access-code")
        self.assertEqual(field.input_value(), CODE)
        self.assertEqual(field.evaluate("e => getComputedStyle(e).webkitTextSecurity"), "disc")
        # Not a password field, which the browser would offer to save.
        self.assertEqual(field.get_attribute("type"), "text")
        page.click("#startupAccessShowBtn")
        self.assertEqual(field.evaluate("e => getComputedStyle(e).webkitTextSecurity"), "none")
        self.assertEqual(page.inner_text("#startupAccessShowBtn"), "Hide")
        page.fill("#startup-initials", "AB")
        page.fill("#startup-ato", "CODEMASK")
        page.fill("#startup-title", "Patrol")
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

    def test_mgrs_lock_keeps_its_zone_and_square_after_a_report(self):
        # Regression: logging reset the form, which emptied the box while the lock went on.
        page = self.open_editor()
        page.click("#dataMgmtBtn")
        page.click("#toggleMgrsLockBtn")
        page.fill("#mgrsPrefix", "38S MB")
        # Enter sets it and goes on to Location; it doesn't try to log the report.
        page.press("#mgrsPrefix", "Enter")
        self.assertEqual(page.evaluate("document.activeElement.id"), "location")
        page.wait_for_timeout(300)
        self.assertNotIn("Please fill in", page.text_content("#toast-notification") or "")
        self.log(page, "2x BMP", location="45000 82000")
        self.assertEqual(page.input_value("#mgrsPrefix"), "38S MB")
        page.wait_for_selector("#reportLogBody tr[data-id] .col-location:has-text('38S MB')")

    def test_the_sidebar_box_wraps_its_button(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        page.wait_for_timeout(500)
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
        page.wait_for_selector("#toast-notification:has-text('GE 1 added at 38S MB 40000 78000')")
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
        self.assertIn(" km N", page.text_content("#mapSvg .map-drones"))
        # Moved by typing a grid; Zoom centres on it, closer.
        page.fill("#mapDroneGrid0", "38SMB4100079000")
        page.press("#mapDroneGrid0", "Enter")
        page.wait_for_selector("#toast-notification:has-text('GE 1 moved to 38S MB 41000 79000')")
        before = page.evaluate("mapView.mpp")
        page.click("[data-drone-zoom='0']")
        page.wait_for_function(f"() => mapView.mpp < {before}")
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
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => s.drones.length === 1 && s.drones[0].grid === '38S MB 41000 79000')"
        )
        viewer = self.open_viewer()
        self.open_map(viewer)
        viewer.wait_for_selector("#mapSvg .map-drone")
        viewer.click("#mapDroneBtn")
        self.assertEqual(viewer.locator("#mapDroneGrid0").count(), 0)
        self.assertFalse(viewer.locator("#mapDroneAdd").is_visible())
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
        page.wait_for_selector(f"#toast-notification:has-text('Copied {shown}')")
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
            page.evaluate("mapBaseFailed = true; redrawMap()")
            page.wait_for_selector("#mapNote", state="visible")
            page.wait_for_timeout(500)  # the sidebar's slide
            note = page.locator("#mapNote").bounding_box()
            lowest = page.evaluate(
                "Math.max(...[...document.querySelectorAll('#mapBox .map-tools > :not(#mapNote):not(.map-tools-break)')]"
                ".map(e => e.getBoundingClientRect().bottom))"
            )
            self.assertGreaterEqual(note["y"], lowest, width)
        page.evaluate("mapBaseFailed = false; redrawMap()")
        page.wait_for_selector("#mapNote", state="hidden")

    def test_the_wheel_scrolls_past_the_map_and_ctrl_wheel_zooms(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.open_map(page)
        page.hover("#mapBox")
        before = page.evaluate("mapView.mpp")
        page.mouse.wheel(0, 200)
        page.wait_for_selector("#mapHint", state="visible")
        self.assertEqual(page.evaluate("mapView.mpp"), before, "a plain wheel doesn't zoom")
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
        page.wait_for_function(f"() => mapView.mpp < {before}")

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
        self.open_map(page)
        labels = lambda: page.locator("#mapSvg .map-labels text").all_text_contents()  # noqa: E731
        self.assertIn("NAI 1", labels())
        # Zoomed far into NAI 1's corner, its middle is off screen; the name stays.
        page.evaluate("""() => {
            const o = currentOverlays().find(o => o.name === '1' && o.type === 'NAI');
            const ring = SaltCore.asArea(o.geometry).coordinates[0];
            const [x, y] = SaltCore.lonLatToMerc(ring[0][0], ring[0][1]);
            mapView = { cx: x, cy: y, mpp: 2 };
            drawMap();
        }""")
        self.assertIn("NAI 1", labels())
        page.click("[data-map-zoom='full']")
        page.wait_for_function(
            "() => document.fullscreenElement && document.fullscreenElement.id === 'mapPane'"
        )
        # The button changes when the browser says full screen began.
        page.wait_for_selector("#mapFullBtn[title='Leave full screen (Esc)']")
        page.evaluate("document.exitFullscreen()")
        page.wait_for_function("() => !document.fullscreenElement")

    def test_the_format_stays_when_switching_workspaces(self):
        page = self.open_editor(ato="FORMATA")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='builder']")
        page.fill("#builderNewLetter", "W")
        page.fill("#builderNewLabel", "Weather")
        page.click("#builderAddBtn")
        page.wait_for_selector("#salt-fields [data-custom-label='W']")
        page.click("#exportViewToggleBtn")
        page.click("#setAtoBtn")
        page.fill("#atoDesignator", "FORMATB")
        page.click("#setAtoBtn")
        page.wait_for_function("() => activeAto === 'FORMATB'")
        self.assertEqual(
            page.locator("#salt-fields [data-custom-label='W']").count(),
            1,
            "kept in a new workspace",
        )
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => (s.format.lines || []).some(l => l.label === 'W'))"
        )
        # Another browser, in yet another workspace, has it too.
        second = self.browser.new_context(ignore_https_errors=True)
        self.addCleanup(second.close)
        other = second.new_page()
        other.on("pageerror", lambda exc: self.errors.append(str(exc)))
        other.goto(self.editor + "/")
        other.fill("#startup-initials", "CD")
        other.fill("#startup-ato", "FORMATC")
        other.fill("#startup-title", "Patrol")
        other.click("#startupContinueBtn")
        other.wait_for_selector("#salt-fields [data-custom-label='W']")
        page.evaluate("saveWorkspaceFormat(defaultFormat())")
        page.wait_for_function(
            "() => fetch('/api/sync').then(r => r.json()).then(s => !(s.format.lines || []).some(l => l.label === 'W'))"
        )

    def test_updating_shows_which_report_and_the_panel_keeps_its_width(self):
        page = self.open_editor(title="A very long workspace title for this patrol")
        page.set_viewport_size({"width": 1440, "height": 900})
        self.log(page, "2x BMP", activity="moving north along the wadi")
        page.click("#reportLogBody tr[data-id] .col-size:has-text('2x BMP')")
        self.assertEqual(page.text_content("#form-title"), f"Updating {self.ato}001")
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
            page.wait_for_timeout(400)
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
        page.wait_for_timeout(700)
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
        self.assertIn("logistics (2x trucks)", flat())
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
        page.wait_for_selector("#toast-notification:has-text('calls them OPFOR')")
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
        page.wait_for_selector("#toast-notification:has-text('1-60 GMRB saved')")
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
        page.wait_for_selector("#toast-notification:has-text('Pick what XYZ-9 is')")
        page.click("[data-narr-role='engineer']")
        page.click("[data-narr-save]")
        page.wait_for_selector("#toast-notification:has-text('XYZ-9 saved')")
        self.assertIn("engineers (1x PMP, 1x XYZ-9)", flat())
        self.assertNotIn("Not in the equipment catalogue", flat())
        self.assertEqual(page.locator("[data-narr-tab='equipment'] .narr-dot").count(), 0)
        # A rule switched off, and one of the team's own.
        page.click("[data-narr-tab='rules']")
        page.uncheck("[data-narr-rule='defense']")
        page.wait_for_selector("#toast-notification:has-text('Preparing a defense: off')")
        self.assertNotIn("preparing a defense", flat())
        page.click("[data-narr-add]")
        page.fill("#narrRuleWhat", "are preparing a river crossing")
        page.fill("#narrRuleWords", "bridging, ferry")
        page.click("[data-narr-save]")
        page.wait_for_selector("#toast-notification:has-text('Rule saved for everyone')")
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

    def test_the_welcome_screen_hides_the_page_whichever_view_was_last(self):
        # The map's panes set their own visibility to slide; none may show through.
        self.context.add_init_script("localStorage.setItem('salt_log_view', 'map')")
        page = self.context.new_page()
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.goto(self.editor + "/")
        page.wait_for_selector("#startupModal.show")
        page.wait_for_timeout(800)  # past the panes' own transitions
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

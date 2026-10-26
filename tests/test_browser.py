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
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
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
        page.click("#dataMgmtBtn")
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
        page.click("#closeExportViewBtn")

    def test_overlays_place_reports_and_reach_viewers(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "1x BTR", location="38SMB4500082000")
        self.log(page, "2x BMP", location="38S MB 55000 82000, NAI 1")
        self.log(page, "3x T-72", location="38SMB4200092000")

        def tags(p, size):
            row = f"#reportLogBody tr[data-id]:has(.col-size:has-text('{size}'))"
            return p.locator(f"{row} .loc-tag").all_text_contents()

        self.assertEqual(tags(page, "1x BTR"), ["NAI 1"])
        self.assertEqual(tags(page, "2x BMP"), ["Check: NAI 1 typed; grid is in NAI 2"])
        self.assertEqual(tags(page, "3x T-72"), ["OBJ BRIDGE"])
        # Synced: the server holds them, and a viewer tags the same way
        # without keeping a copy.
        page.wait_for_function(
            f"() => fetch('/api/sync').then(r => r.json()).then(s => (s.overlays['{self.ato}'] || []).length === 4)"
        )
        viewer = self.open_viewer()
        viewer.wait_for_selector("#reportLogBody .loc-tag:has-text('OBJ BRIDGE')")
        self.assertIsNone(viewer.evaluate("localStorage.getItem('salt_ws_overlays')"))

    def test_export_for_arcgis(self):
        page = self.open_editor()
        self.import_overlays(page)
        self.log(page, "2x BMP", activity="moving N", location="38SMB4500082000 38SMB5500082000")
        self.log(page, "1x truck", activity="parked", location="vic the bridge")
        page.click("#dataMgmtBtn")
        page.click("#exportViewToggleBtn")
        page.click(".ws-tab[data-tab='export']")  # the panel reopens on the last tab used
        with page.expect_download() as dl:
            page.click("#exportArcgisGeojsonBtn")
        self.assertTrue(dl.value.suggested_filename.endswith("_arcgis.geojson"))
        data = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
        props = [f["properties"] for f in data["features"]]
        # Two grids, two points; the report without a grid is left out.
        self.assertEqual([p["mgrs"] for p in props], ["38S MB 45000 82000", "38S MB 55000 82000"])
        self.assertEqual([p["nai"] for p in props], ["NAI 1; NAI 2"] * 2)
        self.assertEqual(props[0]["nai_from"], "grid")
        self.assertEqual((props[0]["heading"], props[0]["heading_deg"]), ("N", 0))
        self.assertEqual(props[0]["pl_near"], "PL BLUE")
        lon, lat = data["features"][0]["geometry"]["coordinates"]
        self.assertAlmostEqual(lat, 33.2759, places=3)
        self.assertAlmostEqual(lon, 44.4096, places=3)
        self.assertIn(
            "1 without a readable grid", page.locator("#toast-notification").text_content()
        )

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

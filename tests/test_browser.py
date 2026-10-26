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
import struct
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
            page.click("#exportArcgisGeojsonBtn")
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
            page.click("#exportArcgisEsriBtn")
        self.assertTrue(dl.value.suggested_filename.endswith("_arcgis.json"))
        esri = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
        self.assertEqual(esri["geometryType"], "esriGeometryPoint")
        self.assertEqual(
            [f["attributes"]["mgrs"] for f in esri["features"]],
            ["38S MB 45000 82000", "38S MB 55000 82000"],
        )
        self.assertAlmostEqual(esri["features"][0]["geometry"]["y"], 33.2759, places=3)

    def test_overlays_are_shared_and_unload_by_group(self):
        page = self.open_editor()
        self.import_overlays(page)
        # Another workspace has the same overlays, with nothing to import.
        second = self.browser.new_context()  # another browser: storage of its own
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
        page.click("[data-unload-group='PL']")
        page.click("#confirmActionBtn")
        page.wait_for_selector(".overlay-group[data-overlay-group='PL']", state="detached")
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

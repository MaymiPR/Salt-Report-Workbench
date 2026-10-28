# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for the sync server: pure logic plus HTTP behaviour against a live instance.

Standard library only, matching the project's zero-dependency rule. Run with
``python -m unittest discover -s tests``.
"""

from __future__ import annotations

import contextlib
import gzip
import http.client
import io
import json
import os
import shutil
import ssl
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import salt_sync_server as srv  # noqa: E402

NAI1 = {
    "type": "NAI",
    "name": "1",
    "label": "NAI 1 (bridge)",
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            [[44.35, 33.25], [44.46, 33.25], [44.46, 33.34], [44.35, 33.34], [44.35, 33.25]]
        ],
    },
}
PL_BLUE = {
    "type": "PL",
    "name": "BLUE",
    "geometry": {"type": "LineString", "coordinates": [[44.35, 33.30], [44.57, 33.30]]},
}


def reset_state() -> None:
    """Return every piece of module-level server state to a fresh boot."""
    srv.DATA_STORE.clear()
    srv.DATA_STORE.update(
        {
            "workspaces": {},
            "config": {"ato": "", "title": ""},
            "profiles": {},
            "format": {},
            "overlays": [],
            "basemaps": [],
            "drones": [],
            "narrative": {},
        }
    )
    srv.workspace_sources.clear()
    srv.client_initials.clear()
    srv._rate_buckets.clear()
    srv.invalidate_sync_cache()
    srv._dirty_atos = None
    srv._save_failures = 0


def cancel_pending_save() -> None:
    with srv._save_timer_lock:
        if srv._save_timer is not None:
            srv._save_timer.cancel()
            srv._save_timer = None


def report(rid="r1", did="ALPHA001", lm=1, **extra):
    base = {
        "id": rid,
        "displayId": did,
        "ato": "ALPHA",
        "title": "Patrol",
        "size": "2x T-72",
        "activity": "Stationary",
        "location": "18SUJ2337106519",
        "time": "2026-01-15T14:30:00Z",
        "lastModified": lm,
    }
    base.update(extra)
    return base


# --------------------------------------------------------------------------- #
# Merge semantics
# --------------------------------------------------------------------------- #
class MergeReportsTests(unittest.TestCase):
    def test_newer_incoming_replaces_existing(self):
        merged = srv._merge_reports([report(lm=1, size="old")], [report(lm=2, size="new")])
        self.assertEqual([r["size"] for r in merged], ["new"])

    def test_older_incoming_is_ignored(self):
        merged = srv._merge_reports([report(lm=5, size="keep")], [report(lm=3, size="stale")])
        self.assertEqual([r["size"] for r in merged], ["keep"])

    def test_equal_timestamp_prefers_incoming(self):
        merged = srv._merge_reports([report(lm=4, size="a")], [report(lm=4, size="b")])
        self.assertEqual(merged[0]["size"], "b")

    def test_display_id_is_the_key_for_legacy_rows_without_an_id(self):
        old = {"displayId": "ALPHA001", "lastModified": 1, "size": "x"}
        new = {"displayId": "ALPHA001", "lastModified": 2, "size": "y"}
        self.assertEqual(srv._merge_reports([old], [new]), [new])

    def test_rows_without_any_key_are_dropped(self):
        self.assertEqual(srv._merge_reports([], [{"size": "orphan"}]), [])

    def test_distinct_reports_are_all_kept(self):
        merged = srv._merge_reports([report("a", "ALPHA001")], [report("b", "ALPHA002")])
        self.assertEqual(sorted(r["id"] for r in merged), ["a", "b"])


# --------------------------------------------------------------------------- #
# Backup rendering and parsing
# --------------------------------------------------------------------------- #
class BackupFormatTests(unittest.TestCase):
    def test_nothing_loaded_renders_nothing(self):
        self.assertIsNone(srv.render_backup({}, {"ato": "ALPHA", "title": "T"}, {}, {}))

    def test_filename_comes_from_config_and_is_sanitized(self):
        name, _ = srv.render_backup(
            {"A/B 1": [report()]}, {"ato": "A/B 1", "title": "Recon: Day"}, {}, {}
        )
        self.assertEqual(name, "A_B_1_Recon__Day.txt")

    def test_filename_falls_back_to_a_real_workspace_when_config_is_empty(self):
        # Unloading the active workspace clears config; the file must still be
        # named after something real rather than a stray "ATO_SALT.txt".
        ws = {"BRAVO": [report(title="Screen Line")], "ALPHA": [report()]}
        name, _ = srv.render_backup(ws, {}, {}, {})
        self.assertEqual(name, "ALPHA_Patrol.txt")

    def test_round_trip_preserves_all_sections(self):
        ws = {
            "ALPHA": [
                report(custom={"W": "Overcast"}, bda=[{"target": "2x T-72", "effect": "Destroyed"}])
            ]
        }
        cfg = {"ato": "ALPHA", "title": "Patrol"}
        profiles = {"AB": {"initials": "AB", "color": "#0a84ff"}}
        formats = {"ALPHA": {"preset": "salt", "lines": [{"type": "id"}]}}
        _, text = srv.render_backup(ws, cfg, profiles, formats)

        parsed = srv._extract_json_from_file(text)
        self.assertEqual(parsed["workspaces"], ws)
        self.assertEqual(parsed["config"], cfg)
        self.assertEqual(parsed["profiles"], profiles)
        self.assertEqual(parsed["formats"], formats)

    def test_human_readable_section_lists_custom_fields_and_bda(self):
        ws = {
            "ALPHA": [
                report(
                    custom={"W": "Overcast"},
                    bda=[{"target": "2x T-72", "coords": "18SUJ1", "effect": "Destroyed"}],
                )
            ]
        }
        _, text = srv.render_backup(ws, {"ato": "ALPHA", "title": "Patrol"}, {}, {})
        self.assertIn("REPORT ALPHA001", text)
        self.assertIn("W : Overcast", text)
        self.assertIn("BDA 1  : Destroyed - 2x T-72 @ 18SUJ1", text)

    def test_legacy_single_workspace_backups_still_load(self):
        legacy = {"config": {"ato": "ALPHA", "title": "Old"}, "reports": [report()]}
        text = f"{srv.BACKUP_START}\n{json.dumps(legacy)}\n{srv.BACKUP_END}"
        parsed = srv._extract_json_from_file(text)
        self.assertEqual(list(parsed["workspaces"]), ["ALPHA"])
        self.assertEqual(parsed["formats"], {})

    def test_odd_values_from_a_hand_edited_backup_still_render(self):
        # A backup edited by hand is loaded without validation; whatever it
        # holds, the next backup can still be written from it.
        odd = [
            report(title=5, displayId=7, history=None, custom=["x"], user="AB", bda=[1]),
            report("r2", "ALPHA002", lm="soon", history=[{"lastModified": "x"}, 3]),
            "not a report",
        ]
        name, text = srv.render_backup({"ALPHA": odd}, {}, {}, {}, label=("ALPHA", 5))
        self.assertEqual(name, "ALPHA_5.txt")
        self.assertIn("REPORT ALPHA002", text)
        self.assertEqual(srv.workspace_title("ALPHA", odd, {}), "5")
        files = srv.render_workspace_backups({"ALPHA": odd}, {}, {}, {})
        self.assertEqual(len(files), 1)
        # The config such a file holds is kept to its two strings.
        text = f'{srv.BACKUP_START}{{"workspaces":{{}},"config":{{"ato":3,"title":"T"}}}}{srv.BACKUP_END}'
        self.assertEqual(srv._extract_json_from_file(text)["config"], {"ato": "", "title": "T"})

    def test_files_without_markers_or_with_corrupt_json_are_rejected(self):
        self.assertIsNone(srv._extract_json_from_file("just some notes"))
        self.assertIsNone(
            srv._extract_json_from_file(f"{srv.BACKUP_START}{{not json{srv.BACKUP_END}")
        )


# --------------------------------------------------------------------------- #
# Request validation
# --------------------------------------------------------------------------- #
class ValidatorTests(unittest.TestCase):
    def assertRejects(self, validator, payload, fragment):
        err = validator(payload)
        self.assertIsNotNone(err, f"expected rejection for {payload!r}")
        self.assertIn(fragment, err)

    def test_valid_report_batch_passes(self):
        self.assertIsNone(srv._v_save_reports({"ato": "ALPHA", "reports": [report()]}))

    def test_report_batch_rejections(self):
        v = srv._v_save_reports
        self.assertRejects(v, {"reports": []}, "ato")
        self.assertRejects(v, {"ato": "ALPHA", "reports": {}}, "must be a list")
        self.assertRejects(v, {"ato": "ALPHA", "reports": [{"size": "x"}]}, "missing id")
        self.assertRejects(v, {"ato": "ALPHA", "reports": [report(time="yesterday")]}, "ISO 8601")
        self.assertRejects(v, {"ato": "ALPHA", "reports": [report(size="x" * 501)]}, "size")
        self.assertRejects(
            v, {"ato": "ALPHA", "reports": [report(history={})]}, "history must be a list"
        )

    def test_report_ids_are_kept_to_markup_safe_characters(self):
        # Ids are written into attributes on every client; a crafted backup
        # could otherwise carry markup into everyone's page.
        v = srv._v_save_reports
        for ok in ("6f1d2c3a-1111-4222-8333-444455556666", "ALPHA001", "legacy.id:7"):
            self.assertIsNone(v({"ato": "A", "reports": [report(rid=ok)]}), ok)
        self.assertRejects(v, {"ato": "A", "reports": [report(rid='x" onclick="1')]}, ".id")
        self.assertRejects(v, {"ato": "A", "reports": [report(rid="a b")]}, ".id")
        # Rows that predate ids are still keyed by displayId alone.
        self.assertIsNone(v({"ato": "A", "reports": [report(rid="")]}))

    def test_report_names_and_flags_are_held_to_their_types(self):
        # Regression: a numeric title or a list displayId was accepted, and every
        # later disk save failed on it without a word.
        v = srv._v_save_reports
        for field, bad in (
            ("title", 5),
            ("title", "T" * 101),
            ("displayId", ["ALPHA001"]),
            ("fullId", {"x": 1}),
            ("ato", 7),
            ("updated", "yes"),
            ("deleted", 1),
        ):
            self.assertRejects(v, {"ato": "A", "reports": [report(**{field: bad})]}, field)
        self.assertIsNone(v({"ato": "A", "reports": [report(updated=True, deleted=False)]}))
        self.assertIsNone(v({"ato": "A", "reports": [report(title=None)]}), "null is tolerated")
        e = srv._v_edit_report
        edit = {"ato": "A", "reportId": "r1"}
        self.assertRejects(e, {**edit, "fields": {"title": 5}}, "fields.title")
        self.assertRejects(e, {**edit, "fields": {"displayId": 1}}, "fields.displayId")
        self.assertRejects(e, {**edit, "fields": {"updated": "no"}}, "fields.updated")
        self.assertIsNone(e({**edit, "fields": {"title": "Patrol", "updated": False}}))

    def test_booleans_are_not_accepted_as_timestamps(self):
        # isinstance(True, int) is True in Python; the validator must not be fooled.
        self.assertRejects(
            srv._v_save_reports, {"ato": "A", "reports": [report(lm=True)]}, "lastModified"
        )

    def test_user_color_must_be_hex(self):
        bad = report(user={"initials": "AB", "color": "red"})
        self.assertRejects(srv._v_save_reports, {"ato": "A", "reports": [bad]}, "hex color")

    def test_custom_fields_must_be_short_strings(self):
        self.assertRejects(
            srv._v_save_reports, {"ato": "A", "reports": [report(custom={"W": 5})]}, "custom"
        )
        self.assertRejects(
            srv._v_save_reports, {"ato": "A", "reports": [report(custom=[])]}, "custom"
        )

    def test_bda_entries_are_validated(self):
        ok = report(
            bda=[
                {"target": "2x T-72", "coords": "18SUJ1", "effect": "Destroyed", "lastModified": 1}
            ]
        )
        self.assertIsNone(srv._v_save_reports({"ato": "A", "reports": [ok]}))
        bad = report(bda=[{"target": "x", "effect": "E" * 31}])
        self.assertRejects(srv._v_save_reports, {"ato": "A", "reports": [bad]}, "effect")

    def test_report_format_validation(self):
        v = srv._v_save_format
        self.assertIsNone(
            v({"ato": "A", "format": {"lines": [{"type": "id"}, {"type": "custom", "label": "W"}]}})
        )
        self.assertRejects(v, {"ato": "A", "format": {"lines": []}}, "non-empty")
        self.assertRejects(v, {"ato": "A", "format": {"lines": [{"type": "nope"}]}}, "type")
        self.assertRejects(v, {"ato": "A", "format": {"lines": [{"type": "custom"}]}}, "label")

    def test_overlay_validation(self):
        v = srv._v_save_overlays
        self.assertIsNone(v({"ato": "A", "overlays": [NAI1, PL_BLUE]}))
        self.assertIsNone(v({"ato": "A", "overlays": []}), "an empty list clears")
        self.assertRejects(v, {"ato": "A", "overlays": {}}, "list")
        self.assertRejects(v, {"ato": "A", "overlays": [{**NAI1, "type": "AO"}]}, "NAI, OBJ or PL")
        self.assertRejects(v, {"ato": "A", "overlays": [{**NAI1, "name": ""}]}, "name")
        self.assertRejects(v, {"ato": "A", "overlays": [{**NAI1, "name": "N" * 41}]}, "name")
        bad_geoms = [
            {"type": "Circle", "coordinates": [44, 33]},
            {"type": "Point", "coordinates": [181, 33]},
            {"type": "Point", "coordinates": [44, True]},
            {"type": "LineString", "coordinates": [44, 33]},
            {"type": "Polygon", "coordinates": []},
        ]
        for g in bad_geoms:
            self.assertRejects(v, {"ato": "A", "overlays": [{**NAI1, "geometry": g}]}, "geometry")
        with mock.patch.object(srv, "MAX_OVERLAY_POINTS", 6):
            self.assertRejects(v, {"ato": "A", "overlays": [NAI1, PL_BLUE]}, "too many points")
        with mock.patch.object(srv, "MAX_OVERLAYS", 1):
            self.assertRejects(v, {"ato": "A", "overlays": [NAI1, PL_BLUE]}, "too many overlays")

    def test_profile_validation(self):
        self.assertIsNone(srv._v_save_profile({"profile": {"initials": "AB", "color": "#32d74b"}}))
        self.assertRejects(srv._v_save_profile, {"profile": {"color": "#32d74b"}}, "initials")
        self.assertRejects(srv._v_save_profile, {"profile": {"initials": "ABCD"}}, "initials")

    def test_basemap_validation(self):
        v = srv._v_save_basemaps
        wms = {
            "name": "Imagery",
            "kind": "wms",
            "url": "https://maps.example.mil/wms",
            "layers": "imagery",
        }
        tiles = {"name": "Topo", "kind": "tiles", "url": "http://10.0.0.5/tiles/{z}/{y}/{x}.png"}
        self.assertIsNone(v({"basemaps": [wms, tiles]}))
        self.assertIsNone(v({"basemaps": []}), "none: a plain background")
        self.assertRejects(v, {"basemaps": wms}, "list")
        self.assertRejects(v, {"basemaps": [wms, {**tiles, "name": " imagery "}]}, "used twice")
        self.assertRejects(v, {"basemaps": [{**wms, "name": ""}]}, "name")
        self.assertRejects(v, {"basemaps": [{**wms, "kind": "wfs"}]}, "wms or tiles")
        self.assertRejects(v, {"basemaps": [{**wms, "url": "file:///c:/x"}]}, "http(s)")
        self.assertRejects(v, {"basemaps": [{**wms, "url": "javascript:alert(1)"}]}, "http(s)")
        self.assertRejects(v, {"basemaps": [{**wms, "url": "https://x/" + "a" * 2000}]}, "http(s)")
        self.assertRejects(v, {"basemaps": [{**wms, "layers": 5}]}, "layers")
        many = [{**tiles, "name": f"T{i}"} for i in range(21)]
        self.assertRejects(v, {"basemaps": many}, "too many")

    # --------------------------------------------------------------------------- #
    # Rate limiting and access control
    # --------------------------------------------------------------------------- #
    def test_drones_are_checked(self):
        v = srv._v_save_drones
        ge = {"name": "GE 1", "grid": "11S NV 39697 06762", "at": 1793018940000}
        self.assertIsNone(v({"drones": []}))
        self.assertIsNone(v({"drones": [ge, {**ge, "name": "GE 2", "grid": "11S NV 39 06"}]}))
        self.assertRejects(v, {"drones": ge}, "list")
        self.assertRejects(v, {"drones": [ge, {**ge, "name": " ge 1 "}]}, "used twice")
        self.assertRejects(v, {"drones": [{**ge, "name": ""}]}, "name")
        self.assertRejects(v, {"drones": [{**ge, "grid": "near the bridge"}]}, "MGRS")
        self.assertRejects(v, {"drones": [{**ge, "grid": "11SNV3969706762"}]}, "MGRS")
        self.assertRejects(v, {"drones": [{**ge, "at": "now"}]}, "milliseconds")
        many = [{**ge, "name": f"GE {i}"} for i in range(11)]
        self.assertRejects(v, {"drones": many}, "too many")
        # Where it's looking and how far it sees: both optional.
        self.assertIsNone(v({"drones": [{**ge, "look": "11S NV 44000 07000", "range": 12.5}]}))
        self.assertRejects(v, {"drones": [{**ge, "look": "the bridge"}]}, "look")
        for bad in (0, -3, 5000, "10", True):
            self.assertRejects(v, {"drones": [{**ge, "range": bad}]}, "range")

    def test_the_server_knows_every_kind_of_equipment_the_page_has(self):
        import re

        core = (ROOT / "src" / "core.js").read_text(encoding="utf-8")
        block = core[core.index("const EQUIPMENT_ROLES = [") : core.index("const eqp = ")]
        self.assertEqual(set(re.findall(r"\['([a-z0-9]+)', '", block)), set(srv._EQUIPMENT_ROLES))

    def test_the_server_knows_every_rule_the_page_has(self):
        import re

        core = (ROOT / "src" / "core.js").read_text(encoding="utf-8")
        block = core[core.index("const NARRATIVE_RULES = [") : core.index("const RULE_ORDER")]
        ids = set(re.findall(r"^\s*\['([a-z0-9]+)', '", block, re.M))
        self.assertEqual(len(ids), 55)
        self.assertEqual(ids, set(srv._NARRATIVE_RULES))
        self.assertIsNone(srv._v_save_narrative({"narrative": {"off": sorted(ids)}}))

    def test_narrative_settings_are_checked(self):
        v = srv._v_save_narrative
        unit = {"name": "1-60 GMRB", "places": ["NAI 1"], "kinds": ["armor"]}
        rule = {"what": "are crossing", "words": "bridge", "min": 2, "hours": 12}
        self.assertIsNone(v({"narrative": {}}))
        self.assertIsNone(
            v(
                {
                    "narrative": {
                        "enemy": "OPFOR",
                        "units": [unit],
                        "custom": [rule],
                        "off": ["recon"],
                    }
                }
            )
        )
        self.assertRejects(v, {"narrative": []}, "object")
        self.assertRejects(v, {"narrative": {"enemy": "x" * 61}}, "enemy")
        self.assertRejects(
            v, {"narrative": {"units": [unit, {**unit, "name": " 1-60 gmrb "}]}}, "used twice"
        )
        self.assertRejects(v, {"narrative": {"units": [{**unit, "kinds": ["tanks"]}]}}, "kinds")
        self.assertRejects(v, {"narrative": {"units": [{**unit, "places": "NAI 1"}]}}, "places")
        self.assertRejects(v, {"narrative": {"equipment": [{"type": "X", "role": "boat"}]}}, "role")
        self.assertRejects(
            v,
            {"narrative": {"equipment": [{"type": "X", "role": "mech", "origin": "US"}]}},
            "origin",
        )
        self.assertRejects(
            v,
            {
                "narrative": {
                    "equipment": [{"type": "x", "role": "mech"}, {"type": "X ", "role": "air"}]
                }
            },
            "used twice",
        )
        self.assertRejects(v, {"narrative": {"off": ["everything"]}}, "built-in")
        self.assertRejects(v, {"narrative": {"custom": [{**rule, "min": 0}]}}, "min")
        self.assertRejects(v, {"narrative": {"custom": [{**rule, "hours": True}]}}, "hours")
        self.assertRejects(v, {"narrative": {"custom": [{**rule, "words": " "}]}}, "words")


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_burst_then_reject_then_refill(self):
        clock = [1000.0]
        with (
            mock.patch.object(srv.time, "monotonic", lambda: clock[0]),
            mock.patch.object(srv, "RATE_BUCKET_CAPACITY", 3),
            mock.patch.object(srv, "RATE_REFILL_PER_SECOND", 1.0),
        ):
            self.assertEqual(
                [srv.rate_limit_check("10.0.0.5") for _ in range(4)], [True, True, True, False]
            )
            clock[0] += 1.0  # one token back
            self.assertTrue(srv.rate_limit_check("10.0.0.5"))
            self.assertFalse(srv.rate_limit_check("10.0.0.5"))

    def test_buckets_are_per_ip(self):
        with (
            mock.patch.object(srv, "RATE_BUCKET_CAPACITY", 1),
            mock.patch.object(srv, "RATE_REFILL_PER_SECOND", 0.0),
        ):
            self.assertTrue(srv.rate_limit_check("10.0.0.1"))
            self.assertFalse(srv.rate_limit_check("10.0.0.1"))
            self.assertTrue(srv.rate_limit_check("10.0.0.2"))


class ConsoleOutputTests(unittest.TestCase):
    def test_output_is_flushed_so_redirected_logs_show_the_access_code(self):
        # Regression: with stdout redirected, the boot banner (and the access
        # code in it) stayed in Python's buffer while the server ran.
        with mock.patch("builtins.print") as fake_print:
            srv.safe_print(" [+] Access Code : K7M2X9PQR3")
        self.assertTrue(fake_print.call_args.kwargs.get("flush"))


class AccessCodeTests(unittest.TestCase):
    def test_generated_codes_avoid_confusable_characters(self):
        for _ in range(200):
            code = srv._generate_access_code()
            self.assertEqual(len(code), srv.ACCESS_CODE_LENGTH)
            self.assertTrue(set(code) <= set(srv.ACCESS_CODE_ALPHABET))
            self.assertFalse(set(code) & set("0O1Il5S"))

    def test_cookie_parsing(self):
        headers = {"Cookie": "theme=dark; salt_access=K7M2X9PQR3; other=1"}
        self.assertEqual(srv._get_cookie(headers, "salt_access"), "K7M2X9PQR3")
        self.assertIsNone(srv._get_cookie(headers, "missing"))
        self.assertIsNone(srv._get_cookie({}, "salt_access"))

    def test_gate_rules(self):
        remote = "203.0.113.9"  # TEST-NET-3: never a local address
        good = {"Cookie": "salt_access=k7m2x9pqr3"}  # case-insensitive
        bad = {"Cookie": "salt_access=WRONGCODE2"}
        with mock.patch.object(srv, "_access_code", "K7M2X9PQR3"):
            self.assertTrue(srv._check_access_code({}, True, remote), "viewer port is never gated")
            self.assertTrue(srv._check_access_code({}, False, "127.0.0.1"), "the host is trusted")
            self.assertTrue(srv._check_access_code(good, False, remote))
            self.assertFalse(srv._check_access_code(bad, False, remote))
            self.assertFalse(srv._check_access_code({}, False, remote))
        with mock.patch.object(srv, "_access_code", None):
            self.assertTrue(
                srv._check_access_code({}, False, remote), "--no-access-code disables the gate"
            )

    def test_the_machines_own_addresses_are_looked_up_again_after_a_while(self):
        # Regression: cached once at boot, so after a DHCP change the host's own
        # browser (on the LAN URL) was asked for the code until a restart.
        addrs = [[(None, None, None, None, ("10.0.0.5", 0))]]
        with (
            mock.patch.object(srv.socket, "getaddrinfo", side_effect=lambda *a: addrs[0]),
            mock.patch.object(srv, "get_local_ip", return_value="127.0.0.1"),
            mock.patch.object(srv, "_local_ips_cache", None),
        ):
            self.assertTrue(srv._is_localhost("10.0.0.5"))
            addrs[0] = [(None, None, None, None, ("10.0.0.77", 0))]
            self.assertFalse(srv._is_localhost("10.0.0.77"), "still cached")
            later = srv.time.monotonic() + srv.LOCAL_IPS_TTL_SECONDS + 1
            with mock.patch.object(srv.time, "monotonic", return_value=later):
                self.assertTrue(srv._is_localhost("10.0.0.77"))
                self.assertFalse(srv._is_localhost("10.0.0.5"), "the old address is gone")

    def test_every_address_of_the_host_is_one_machine(self):
        addrs = [(None, None, None, None, ("10.0.0.5", 0))]
        with (
            mock.patch.object(srv.socket, "getaddrinfo", return_value=addrs),
            mock.patch.object(srv, "get_local_ip", return_value="10.0.0.5"),
            mock.patch.object(srv, "_local_ips_cache", None),
        ):
            self.assertEqual(srv._machine("10.0.0.5"), "127.0.0.1")
            self.assertEqual(srv._machine("127.0.0.1"), "127.0.0.1")
            self.assertEqual(srv._machine("203.0.113.9"), "203.0.113.9")

    def test_blank_or_unsendable_access_code_overrides_are_refused(self):
        # Regression: --access-code " " became an empty code that an empty
        # cookie matched, silently opening the editor port.
        for bad in (" ", "", "with space", "x" * 65, "café"):
            with (
                mock.patch.object(sys, "argv", ["salt_sync_server", "--access-code", bad]),
                mock.patch("sys.stderr", io.StringIO()),
                self.assertRaises(SystemExit, msg=repr(bad)),
            ):
                srv.parse_cli_args()
        with mock.patch.object(sys, "argv", ["salt_sync_server", "--access-code", "Field-Day_7"]):
            self.assertEqual(srv.parse_cli_args().access_code, "Field-Day_7")


class ErrorReportingTests(unittest.TestCase):
    def handle(self, exc):
        httpd = srv.SaltSyncServer(("127.0.0.1", 0), srv.SaltSyncHandler)
        try:
            with mock.patch.object(srv, "safe_print") as printed:
                try:
                    raise exc
                except Exception:
                    httpd.handle_error(None, ("203.0.113.9", 1))
            return printed.call_args_list
        finally:
            httpd.server_close()

    def test_clients_going_away_stay_quiet(self):
        for exc in (
            ConnectionResetError(),
            BrokenPipeError(),
            TimeoutError(),
            ssl.SSLEOFError(),  # a browser dropping an HTTPS connection
        ):
            self.assertEqual(self.handle(exc), [], repr(exc))

    def test_real_errors_are_reported(self):
        # Regression: every handler exception was swallowed, bugs included.
        calls = self.handle(KeyError("boom"))
        self.assertEqual(len(calls), 1)
        self.assertIn("boom", calls[0].args[0])


class ListenerTests(unittest.TestCase):
    def test_a_second_server_on_the_same_port_is_refused(self):
        # Regression (Windows): SO_REUSEADDR let a second launch bind a port
        # that was already listening, and both copies reported success.
        first = srv.SaltSyncServer(("127.0.0.1", 0), srv.SaltSyncHandler)
        try:
            with self.assertRaises(OSError):
                srv.SaltSyncServer(first.server_address, srv.SaltSyncHandler).server_close()
        finally:
            first.server_close()

    def test_a_closed_port_can_be_reused_at_once(self):
        first = srv.SaltSyncServer(("127.0.0.1", 0), srv.SaltSyncHandler)
        addr = first.server_address
        first.server_close()
        srv.SaltSyncServer(addr, srv.SaltSyncHandler).server_close()


class HttpsTests(unittest.TestCase):
    """The server's own certificate, HTTPS serving, and plain HTTP redirected."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="salt-tls-"))
        cert, key = srv.make_self_signed_cert(["localhost"], ["127.0.0.1"])
        cls.cert, cls.key = cls.tmp / "cert.pem", cls.tmp / "key.pem"
        cls.cert.write_bytes(cert)
        cls.key.write_bytes(key)
        cls.httpd = srv.SaltSyncServer(
            ("127.0.0.1", 0), srv.SaltSyncHandler, tls=srv.tls_context(cls.cert, cls.key)
        )
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        reset_state()

    def test_the_certificate_verifies_for_its_names_and_addresses(self):
        # A strict client (its signature, dates, and names all checked) trusts it.
        trusting = ssl.create_default_context(cafile=str(self.cert))
        for host in ("127.0.0.1", "localhost"):
            with urllib.request.urlopen(
                f"https://{host}:{self.port}/api/sync", context=trusting, timeout=5
            ) as resp:
                self.assertEqual(resp.status, 200, host)
                self.assertIn("workspaces", json.loads(resp.read()))

    def test_plain_http_is_sent_to_https(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", "/index.html?v=2")
            resp = conn.getresponse()
            self.assertEqual(resp.status, 307)
            self.assertEqual(
                resp.getheader("Location"), f"https://127.0.0.1:{self.port}/index.html?v=2"
            )
        finally:
            conn.close()

    def test_a_browser_turning_down_the_certificate_leaves_the_server_serving(self):
        with mock.patch.object(srv, "safe_print") as printed:
            with self.assertRaises(urllib.error.URLError):  # not signed by anyone it trusts
                urllib.request.urlopen(
                    f"https://127.0.0.1:{self.port}/api/sync",
                    context=ssl.create_default_context(),
                    timeout=5,
                )
            unverified = ssl._create_unverified_context()
            with urllib.request.urlopen(
                f"https://127.0.0.1:{self.port}/api/sync", context=unverified, timeout=5
            ) as resp:
                self.assertEqual(resp.status, 200)
        self.assertEqual(printed.call_args_list, [], "nothing to report")

    def test_the_fingerprint_is_the_certificates_sha256(self):
        import hashlib

        der = ssl.PEM_cert_to_DER_cert(self.cert.read_text(encoding="ascii"))
        expected = hashlib.sha256(der).hexdigest().upper()
        printed = srv.cert_fingerprint(str(self.cert))
        self.assertEqual(printed.replace(" ", ""), expected)
        self.assertEqual(len(printed), 95, "32 pairs, as browsers show it")


class TlsFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-tlsfiles-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.object(srv, "get_local_ip", return_value="10.0.0.12")
        patcher.start()
        self.addCleanup(patcher.stop)

    def fingerprint(self):
        cert, key = srv.tls_files(str(self.tmp))
        srv.tls_context(cert, key)  # loads: the key matches the certificate
        return srv.cert_fingerprint(cert)

    def test_made_once_then_kept(self):
        first = self.fingerprint()
        self.assertTrue((self.tmp / "tls" / "salt-key.pem").is_file())
        self.assertEqual(
            self.fingerprint(), first, "a restart keeps it, so browsers needn't ask again"
        )

    def test_made_again_near_expiry_or_for_a_new_address(self):
        first = self.fingerprint()
        info = self.tmp / "tls" / "salt-cert.json"
        meta = json.loads(info.read_text(encoding="utf-8"))
        meta["expires"] = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
        info.write_text(json.dumps(meta), encoding="utf-8")
        second = self.fingerprint()
        self.assertNotEqual(second, first, "renewed before it runs out")
        with mock.patch.object(srv, "get_local_ip", return_value="10.0.0.99"):
            self.assertNotEqual(self.fingerprint(), second, "covers the new address")

    def test_a_missing_key_means_a_new_pair(self):
        first = self.fingerprint()
        (self.tmp / "tls" / "salt-key.pem").unlink()
        self.assertNotEqual(self.fingerprint(), first)


class HttpsFlagTests(unittest.TestCase):
    def parse(self, *argv):
        with mock.patch.object(sys, "argv", ["salt_sync_server", *argv]):
            return srv.parse_cli_args()

    def test_https_is_the_default(self):
        args = self.parse()
        self.assertFalse(args.no_https)
        self.assertIsNone(args.cert)

    def test_cert_and_key_go_together_and_not_with_no_https(self):
        for argv in (
            ["--cert", "c.pem"],
            ["--key", "k.pem"],
            ["--no-https", "--cert", "c.pem", "--key", "k.pem"],
        ):
            with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit, msg=argv):
                self.parse(*argv)
        self.assertEqual(self.parse("--cert", "c.pem", "--key", "k.pem").cert, "c.pem")


# --------------------------------------------------------------------------- #
# HTTP behaviour against a live server
# --------------------------------------------------------------------------- #
CODE = "TESTCODE23"


class HttpApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="salt-test-"))
        page = cls.tmp / "index.html"
        page.write_text(
            '<html><head><meta name="salt-access-code" content=""></head>'
            "<body><p>workbench</p></body></html>",
            encoding="utf-8",
        )
        cls.patches = [
            mock.patch.object(srv, "BACKUP_DIR", str(cls.tmp / "backups")),
            mock.patch.object(srv, "WORKBENCH_HTML", str(page)),
            mock.patch.object(srv, "_access_code", CODE),
            # Tests connect from 127.0.0.1, which the gate trusts. Treat it as a
            # remote client so the access-code path is actually exercised.
            mock.patch.object(srv, "_is_localhost", lambda ip: False),
        ]
        for p in cls.patches:
            p.start()
        srv._workbench_html_cache = None

        cls.editor = srv.SaltSyncServer(("127.0.0.1", 0), srv.SaltSyncHandler)
        cls.viewer = srv.SaltSyncServer(("127.0.0.1", 0), srv.SaltSyncHandler, view_only=True)
        for httpd in (cls.editor, cls.viewer):
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.editor.server_address[1]}"
        cls.viewer_base = f"http://127.0.0.1:{cls.viewer.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        for httpd in (cls.editor, cls.viewer):
            httpd.shutdown()
            httpd.server_close()
        cancel_pending_save()
        for p in reversed(cls.patches):
            p.stop()
        srv._workbench_html_cache = None
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        reset_state()
        cancel_pending_save()

    # -- helpers ----------------------------------------------------------- #
    def request(self, path, body=None, *, base=None, code=CODE, raw=None, headers=None):
        hdrs = {"Content-Type": "application/json"}
        if code:
            hdrs["Cookie"] = f"salt_access={code}"
        hdrs.update(headers or {})
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(
            (base or self.base) + path,
            data=data,
            headers=hdrs,
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            with exc:  # an error response is still an open connection
                return exc.code, exc.read()

    def post(self, path, body, **kw):
        status, raw = self.request(path, body, **kw)
        return status, json.loads(raw or b"{}")

    def sync(self):
        status, raw = self.request("/api/sync")
        self.assertEqual(status, 200)
        return json.loads(raw)

    # -- page ---------------------------------------------------------------- #
    def test_page_is_served_without_a_code(self):
        status, body = self.request("/", code=None)
        self.assertEqual(status, 200)
        self.assertIn(b"workbench", body)
        self.assertEqual(self.request("/index.html", code=None)[0], 200)

    def test_viewer_page_is_stamped_read_only_before_any_js_runs(self):
        _, body = self.request("/", base=self.viewer_base, code=None)
        self.assertIn(b'<body class="read-only">', body)

    def test_host_gets_the_access_code_injected(self):
        with mock.patch.object(srv, "_is_localhost", lambda ip: True):
            _, body = self.request("/", code=None)
        self.assertIn(f'content="{CODE}"'.encode(), body)

    def test_remote_editor_does_not_get_the_code(self):
        _, body = self.request("/", code=None)
        self.assertNotIn(CODE.encode(), body)

    # -- access control ------------------------------------------------------ #
    def test_data_endpoints_require_the_code(self):
        self.assertEqual(self.request("/api/sync", code=None)[0], 401)
        self.assertEqual(self.request("/api/sync", code="WRONGCODE2")[0], 401)
        self.assertEqual(self.request("/api/sync")[0], 200)

    def test_viewer_reads_freely_but_cannot_write(self):
        self.assertEqual(self.request("/api/sync", base=self.viewer_base, code=None)[0], 200)
        status, _ = self.post(
            "/api/save_reports", {"ato": "A", "reports": []}, base=self.viewer_base
        )
        self.assertEqual(status, 405)

    def test_sync_reports_mode_per_listener(self):
        self.assertFalse(self.sync()["read_only"])
        _, raw = self.request("/api/sync", base=self.viewer_base, code=None)
        self.assertTrue(json.loads(raw)["read_only"])

    # -- writes -------------------------------------------------------------- #
    def test_saved_reports_appear_in_sync(self):
        status, body = self.post("/api/save_reports", {"ato": "alpha", "reports": [report()]})
        self.assertEqual((status, body["status"]), (200, "success"))
        state = self.sync()
        self.assertEqual(
            list(state["workspaces"]), ["ALPHA"], "ATO keys are normalized to upper case"
        )
        self.assertEqual(state["workspaces"]["ALPHA"][0]["size"], "2x T-72")
        self.assertEqual(state["sources"]["ALPHA"], "In-session")

    def test_malformed_requests_are_rejected_with_specific_errors(self):
        self.assertEqual(self.request("/api/save_reports", raw=b"{not json")[0], 400)
        self.assertEqual(self.post("/api/save_reports", ["a", "list"])[0], 400)
        status, body = self.post("/api/save_reports", {"ato": "", "reports": []})
        self.assertEqual(status, 400)
        self.assertIn("Validation failed", body["message"])
        self.assertEqual(self.post("/api/nope", {})[0], 404)
        # A blank workspace name is a bad request, not a missing route.
        status, body = self.post("/api/save_reports", {"ato": "   ", "reports": [report()]})
        self.assertEqual((status, body["message"]), (400, "Missing ATO."))
        status, body = self.post(
            "/api/edit_report", {"ato": "ALPHA", "reportId": "ghost", "fields": {"size": "x"}}
        )
        self.assertEqual((status, body["message"]), (404, "Report not found."))

    def test_bad_content_length_is_its_own_error(self):
        status, raw = self.request(
            "/api/save_reports", raw=b"{}", headers={"Content-Length": "abc"}
        )
        self.assertEqual(status, 400)
        self.assertIn(b"Content-Length", raw)

    def raw_post(self, path, headers):
        """POST with hand-set headers and no body, which urllib won't send."""
        conn = http.client.HTTPConnection("127.0.0.1", self.editor.server_address[1], timeout=5)
        try:
            conn.putrequest("POST", path)
            for name, value in headers.items():
                conn.putheader(name, value)
            conn.endheaders()
            return conn.getresponse().status
        finally:
            conn.close()

    def test_oversized_bodies_are_refused(self):
        # Regression: the body went unread, and closing a socket with unread
        # data resets it; on Windows the client often lost the 413 in the reset.
        with mock.patch.object(srv, "MAX_BODY_BYTES", 64):
            for _ in range(20):
                status, _ = self.post("/api/save_reports", {"ato": "A", "reports": [report()]})
                self.assertEqual(status, 413)

    def test_negative_content_length_is_refused_at_once(self):
        # Regression: rfile.read(-1) waited for the client to close the connection.
        self.assertEqual(self.raw_post("/api/save_config", {"Content-Length": "-1"}), 400)

    def test_cookie_with_non_ascii_characters_is_simply_denied(self):
        # Regression: compare_digest raised on non-ASCII text and the request
        # got no response at all.
        status = self.raw_post(
            "/api/save_config", {"Content-Length": "0", "Cookie": "salt_access=é"}
        )
        self.assertEqual(status, 401)

    def test_files_beside_the_server_are_not_exposed(self):
        # Regression: the handler inherited SimpleHTTPRequestHandler, whose HEAD
        # reported the size and date of any file in the launch directory.
        req = urllib.request.Request(self.base + "/README.md", method="HEAD")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        ctx.exception.close()
        self.assertEqual(ctx.exception.code, 501)

    def test_posts_are_rate_limited(self):
        with (
            mock.patch.object(srv, "RATE_BUCKET_CAPACITY", 2),
            mock.patch.object(srv, "RATE_REFILL_PER_SECOND", 0.0),
        ):
            codes = [
                self.post("/api/save_config", {"config": {"ato": "A", "title": "T"}})[0]
                for _ in range(3)
            ]
        self.assertEqual(codes, [200, 200, 429])

    def test_config_and_profiles_store_known_fields_only(self):
        self.post(
            "/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol", "junk": "x" * 900}}
        )
        self.post(
            "/api/save_profile", {"profile": {"initials": " AB", "color": "#32d74b", "junk": 1}}
        )
        state = self.sync()
        self.assertEqual(state["config"], {"ato": "ALPHA", "title": "Patrol"})
        self.assertEqual(state["profiles"], {"AB": {"initials": "AB", "color": "#32d74b"}})

    def test_edit_is_attributed_to_the_known_operator_not_the_client_claim(self):
        self.post("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        forged = {"initials": "ZZ", "color": "#ff453a"}
        status, _ = self.post(
            "/api/edit_report",
            {"ato": "ALPHA", "reportId": "r1", "fields": {"size": "3x T-72", "user": forged}},
        )
        self.assertEqual(status, 200)
        edited = self.sync()["workspaces"]["ALPHA"][0]
        self.assertEqual(edited["size"], "3x T-72")
        self.assertEqual(edited["user"]["initials"], "AB")

    def test_importing_reports_does_not_change_who_the_importer_is(self):
        # Regression: a backup of someone else's reports re-labelled the
        # importer's connection, so their later edits were stamped as that person.
        self.post("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}})
        theirs = report(user={"initials": "JR", "color": "#ff9f0a"})
        for source in ("backup", "csv"):
            self.post("/api/save_reports", {"ato": "ALPHA", "reports": [theirs], "source": source})
            self.assertEqual(srv.client_initials["127.0.0.1"], "AB", source)

    def test_history_entries_can_be_deleted_individually(self):
        r = report(history=[{"size": "v1", "lastModified": 10}, {"size": "v2", "lastModified": 20}])
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [r]})
        status, body = self.post(
            "/api/delete_history",
            {"ato": "ALPHA", "deletions": [{"reportId": "r1", "lastModified": 10}]},
        )
        self.assertEqual((status, body["removed"]), (200, 1))
        self.assertEqual(
            [h["size"] for h in self.sync()["workspaces"]["ALPHA"][0]["history"]], ["v2"]
        )

    def test_format_is_shared_and_survives_a_restart(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.post("/api/save_reports", {"ato": "BRAVO", "reports": [report("b1", "BRAVO001")]})
        fmt = {"preset": "salt-u", "lines": [{"type": "size"}, {"type": "id"}]}
        # An older page still names its workspace; the format is one all the same.
        self.assertEqual(self.post("/api/save_format", {"ato": "alpha", "format": fmt})[0], 200)
        self.assertEqual(self.sync()["format"], fmt)
        fmt2 = {"preset": "custom", "lines": [{"type": "id"}, {"type": "custom", "label": "W"}]}
        self.assertEqual(self.post("/api/save_format", {"format": fmt2})[0], 200)
        self.assertEqual(self.sync()["format"], fmt2)
        # Every workspace's file carries it, and it comes back after a restart.
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["format"], fmt2)
        # Unloading a workspace leaves it.
        self.post("/api/unload_ato", {"ato": "ALPHA"})
        self.assertEqual(self.sync()["format"], fmt2)
        status, _ = self.post("/api/save_format", {"format": fmt}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot change it")

    def test_format_from_older_per_workspace_files(self):
        a = {"preset": "salt", "lines": [{"type": "id"}, {"type": "size"}]}
        b = {"preset": "salt-u", "lines": [{"type": "size"}, {"type": "id"}]}
        self.assertEqual(srv.pick_format({"ALPHA": a, "bravo": b}, {"ato": "BRAVO"}), b)
        self.assertEqual(srv.pick_format({"ALPHA": a}, {"ato": "BRAVO"}), a)
        self.assertIsNone(srv.pick_format({}, {}))
        self.assertIsNone(srv.pick_format({"ALPHA": {"lines": []}}, {}))
        self.assertEqual(srv.formats_for({"A": [], "B": []}, a), {"A": a, "B": a})
        self.assertEqual(srv.formats_for({"A": []}, {}), {})

    def test_overlays_sync_and_clear(self):
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        extra = {**PL_BLUE, "colour": "red", "geometry": {**PL_BLUE["geometry"], "x": 1}}
        status, _ = self.post("/api/save_overlays", {"overlays": [NAI1, extra]})
        self.assertEqual(status, 200)
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE], "known fields only")
        # An older page still sends its ATO; the set is shared all the same.
        self.post("/api/save_overlays", {"ato": "ALPHA", "overlays": [NAI1]})
        self.assertEqual(self.sync()["overlays"], [NAI1])
        self.post("/api/save_overlays", {"overlays": []})
        self.assertEqual(self.sync()["overlays"], [])
        status, _ = self.post("/api/save_overlays", {"overlays": [NAI1]}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot change overlays")

    def test_overlays_are_shared_by_every_workspace(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)  # only this test's files
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.post("/api/save_reports", {"ato": "BRAVO", "reports": [report("b1", "BRAVO001")]})
        srv.flush_pending_save()
        self.post("/api/save_overlays", {"overlays": [NAI1, PL_BLUE]})
        srv.flush_pending_save()
        # In every workspace's file, so any one of them restores the set.
        for f in self.backup_files():
            data = srv._extract_json_from_file(f.read_text("utf-8"))
            self.assertEqual(data["overlays"], [NAI1, PL_BLUE], f.name)
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE])
        # Unloading a workspace leaves the shared set alone.
        self.post("/api/unload_ato", {"ato": "ALPHA"})
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE])

    def test_basemap_wms_fields_are_kept(self):
        wms = {
            "name": "Ops",
            "kind": "wms",
            "url": "http://s/wms",
            "layers": "0,1",
            "version": "1.1.1",
            "crs": " EPSG:4326 ",
            "format": "image/jpeg",
            "junk": 1,
        }
        self.assertEqual(self.post("/api/save_basemaps", {"basemaps": [wms]})[0], 200)
        self.assertEqual(
            self.sync()["basemaps"],
            [
                {
                    "name": "Ops",
                    "kind": "wms",
                    "url": "http://s/wms",
                    "layers": "0,1",
                    "version": "1.1.1",
                    "crs": "EPSG:4326",
                    "format": "image/jpeg",
                }
            ],
        )
        self.assertIn("crs", srv._v_save_basemaps({"basemaps": [{**wms, "crs": 3857}]}))
        self.assertIn("version", srv._v_save_basemaps({"basemaps": [{**wms, "version": "x" * 11}]}))
        self.post("/api/save_basemaps", {"basemaps": []})

    def test_wms_fetch_reads_a_service_for_the_page(self):
        import http.server as hs
        import threading

        class Fake(hs.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if "GetCapabilities" in self.path:
                    body, ctype, code = b"<WMS_Capabilities version='1.3.0'/>", "text/xml", 200
                elif "GetMap" in self.path:
                    body, ctype, code = (
                        b"<ServiceException>Layer x not defined</ServiceException>",
                        "application/vnd.ogc.se_xml",
                        200,
                    )
                else:
                    body, ctype, code = b"gone", "text/plain", 404
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        fake = hs.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{fake.server_port}/wms"
            status, body = self.post(
                "/api/wms_fetch", {"url": base + "?SERVICE=WMS&REQUEST=GetCapabilities"}
            )
            self.assertEqual((status, body["http"], body["type"]), (200, 200, "text/xml"))
            self.assertIn("WMS_Capabilities", body["text"])
            _, body = self.post("/api/wms_fetch", {"url": base + "?REQUEST=GetMap"})
            self.assertIn("not defined", body["text"])
            _, body = self.post("/api/wms_fetch", {"url": base + "?other"})
            self.assertEqual(body["http"], 404)
        finally:
            fake.shutdown()
        _, body = self.post("/api/wms_fetch", {"url": "http://127.0.0.1:1/nothing"})
        self.assertIn("error", body)
        self.assertEqual(self.post("/api/wms_fetch", {"url": "file:///c:/windows/win.ini"})[0], 400)
        status, _ = self.post("/api/wms_fetch", {"url": base}, base=self.viewer_base)
        self.assertEqual(status, 405, "not on the viewer port")

    def test_basemap_images_come_through_only_from_saved_hosts(self):
        import http.server as hs

        class Fake(hs.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path.startswith("/tiles/"):
                    body, ctype = b"\x89PNG fake", "image/png"
                elif self.path.startswith(("/moved", "/hop", "/away")):
                    # Off to another port, on to a tile on this host, or to another host.
                    port = self.server.server_address[1]
                    self.send_response(302)
                    self.send_header(
                        "Location",
                        {
                            "/moved": "http://127.0.0.1:1/elsewhere",
                            "/hop": f"http://127.0.0.1:{port}/tiles/9/9/9.png",
                            "/away": "http://example.invalid/tiles/1.png",
                        }[self.path],
                    )
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                else:
                    body, ctype = b"<html>not a map</html>", "text/html"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        fake = hs.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        self.addCleanup(fake.server_close)
        self.addCleanup(fake.shutdown)
        host = f"http://127.0.0.1:{fake.server_port}"
        tile = host + "/tiles/3/4/5.png"
        proxied = "/api/basemap?u=" + urllib.parse.quote(tile, safe="")
        self.assertEqual(self.request(proxied)[0], 403, "no basemap saved there yet")
        status, _ = self.post(
            "/api/save_basemaps",
            {
                "basemaps": [
                    {"name": "Range", "kind": "tiles", "url": host + "/tiles/{z}/{x}/{y}.png"}
                ]
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.request(proxied), (200, b"\x89PNG fake"))
        self.assertEqual(self.request(proxied, base=self.viewer_base, code=None)[0], 200)
        self.assertEqual(self.request(proxied, code=None)[0], 401, "the editor port wants the code")
        for url, why in (
            (host + "/page", "not an image"),
            (host + "/moved", "a redirect to another port isn't followed"),
            (host + "/away", "nor one to another host"),
        ):
            self.assertEqual(
                self.request("/api/basemap?u=" + urllib.parse.quote(url, safe=""))[0], 502, why
            )
        # A redirect on the same host (a service sending http on to https, say) is followed.
        status, body = self.request("/api/basemap?u=" + urllib.parse.quote(host + "/hop", safe=""))
        self.assertEqual((status, body), (200, b"\x89PNG fake"))
        for url in ("http://127.0.0.1:1/tiles/1.png", "file:///c:/windows/win.ini", ""):
            self.assertEqual(
                self.request("/api/basemap?u=" + urllib.parse.quote(url, safe=""))[0], 403, url
            )

    def test_basemaps_sync_and_survive_a_restart(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        wms = {
            "name": " Imagery ",
            "kind": "wms",
            "url": " https://maps.example.mil/wms ",
            "layers": "imagery",
            "x": 1,
        }
        tiles = {"name": "Topo", "kind": "tiles", "url": "http://10.0.0.5/tiles/{z}/{y}/{x}.png"}
        self.assertEqual(self.post("/api/save_basemaps", {"basemaps": [wms, tiles]})[0], 200)
        clean = [
            {
                "name": "Imagery",
                "kind": "wms",
                "url": "https://maps.example.mil/wms",
                "layers": "imagery",
            },
            tiles,
        ]
        self.assertEqual(self.sync()["basemaps"], clean, "trimmed, known fields only")
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["basemaps"], clean)
        self.post("/api/save_basemaps", {"basemaps": []})
        self.assertEqual(self.sync()["basemaps"], [])
        status, _ = self.post("/api/save_basemaps", {"basemaps": clean}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot change them")

    def test_drones_sync_and_survive_a_restart(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        sent = {
            "name": " GE 1 ",
            "grid": "11S NV 39697 06762",
            "at": 1793018940000,
            "x": 1,
            "look": "11S NV 44000 07000",
            "range": 12.5,
        }
        self.assertEqual(self.post("/api/save_drones", {"drones": [sent]})[0], 200)
        clean = [
            {
                "name": "GE 1",
                "grid": "11S NV 39697 06762",
                "at": 1793018940000,
                "look": "11S NV 44000 07000",
                "range": 12.5,
            }
        ]
        self.assertEqual(self.sync()["drones"], clean, "trimmed, known fields only")
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["drones"], clean)
        status, _ = self.post("/api/save_drones", {"drones": []}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot move them")
        self.assertEqual(self.post("/api/save_drones", {"drones": []})[0], 200)
        self.assertEqual(self.sync()["drones"], [])

    def test_narrative_settings_sync_and_survive_a_restart(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        sent = {
            "enemy": " OPFOR ",
            "units": [
                {
                    "name": " 1-60 GMRB ",
                    "places": ["NAI 1", " NAI 2 "],
                    "kinds": ["armor", "mech"],
                    "x": 1,
                }
            ],
            "equipment": [{"type": " BTR-4 ", "role": "mech", "origin": ""}],
            "off": ["logistics", "logistics"],
            "custom": [
                {
                    "what": "are preparing a river crossing",
                    "words": "bridge, ferry",
                    "min": 2,
                    "hours": 12,
                }
            ],
            "y": 2,
        }
        self.assertEqual(self.post("/api/save_narrative", {"narrative": sent})[0], 200)
        clean = {
            "enemy": "OPFOR",
            "units": [
                {"name": "1-60 GMRB", "places": ["NAI 1", "NAI 2"], "kinds": ["armor", "mech"]}
            ],
            "equipment": [{"type": "BTR-4", "role": "mech", "origin": ""}],
            "off": ["logistics"],
            "custom": [
                {
                    "what": "are preparing a river crossing",
                    "words": "bridge, ferry",
                    "min": 2,
                    "hours": 12,
                }
            ],
        }
        self.assertEqual(self.sync()["narrative"], clean, "trimmed, known fields only")
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["narrative"], clean)
        status, _ = self.post("/api/save_narrative", {"narrative": clean}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot change them")

    def test_per_workspace_overlays_from_older_backups_are_pooled(self):
        nai2 = {**NAI1, "name": "2"}
        old = {"ALPHA": [NAI1, PL_BLUE], "BRAVO": [nai2], "CHARLIE": []}
        self.assertEqual(srv.fold_overlays(old), [NAI1, PL_BLUE, nai2])
        self.assertEqual(srv.fold_overlays([NAI1]), [NAI1])
        self.assertEqual(srv.fold_overlays(None), [])
        # On boot: older files are pooled; a file in the shared form wins.
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        os.makedirs(srv.BACKUP_DIR)

        def write(name, overlays, when):
            text = srv.render_backup({name: [report(id=name)]}, {}, {}, {}, label=(name, "T"))[1]
            if overlays is not None:
                data = srv._extract_json_from_file(text)
                data["overlays"] = overlays
                text = srv.BACKUP_START + json.dumps(data) + srv.BACKUP_END
            path = Path(srv.BACKUP_DIR) / f"{name}_T.txt"
            path.write_text(text, encoding="utf-8")
            os.utime(path, (when, when))

        write("ALPHA", {"ALPHA": [NAI1, PL_BLUE]}, 1000)
        write("BRAVO", {"BRAVO": [nai2]}, 2000)
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE, nai2])
        write("CHARLIE", [nai2], 3000)
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["overlays"], [nai2])

    # -- persistence --------------------------------------------------------- #
    def backup_files(self):
        return sorted(Path(srv.BACKUP_DIR).glob("*.txt"))

    def test_writes_are_persisted_to_a_backup_file(self):
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        srv.flush_pending_save()
        files = self.backup_files()
        self.assertIn("ALPHA_Patrol.txt", [f.name for f in files])
        parsed = srv._extract_json_from_file(
            (Path(srv.BACKUP_DIR) / "ALPHA_Patrol.txt").read_text("utf-8")
        )
        self.assertEqual(parsed["workspaces"]["ALPHA"][0]["id"], "r1")

    def test_unload_is_persisted_immediately(self):
        # Regression: unload used to change memory only, so the removal reached
        # disk whenever some unrelated later write happened to trigger a save.
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.post("/api/save_reports", {"ato": "BRAVO", "reports": [report("b1", "BRAVO001")]})
        srv.flush_pending_save()
        with mock.patch.object(srv, "schedule_save", wraps=srv.schedule_save) as spy:
            self.assertEqual(self.post("/api/unload_ato", {"ato": "BRAVO"})[0], 200)
            spy.assert_called_once()
        srv.flush_pending_save()
        text = (Path(srv.BACKUP_DIR) / "ALPHA_Patrol.txt").read_text("utf-8")
        self.assertNotIn("BRAVO", srv._extract_json_from_file(text)["workspaces"])
        # Unload is "from view": the workspace's own file stays for the next start.
        self.assertTrue((Path(srv.BACKUP_DIR) / "BRAVO_Patrol.txt").exists())

    def test_each_workspace_has_its_own_file(self):
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.post(
            "/api/save_reports",
            {"ato": "BRAVO", "reports": [report("b1", "BRAVO001", title="Screen")]},
        )
        srv.flush_pending_save()
        folder = Path(srv.BACKUP_DIR)
        alpha = srv._extract_json_from_file((folder / "ALPHA_Patrol.txt").read_text("utf-8"))
        bravo = srv._extract_json_from_file((folder / "BRAVO_Screen.txt").read_text("utf-8"))
        self.assertEqual(list(alpha["workspaces"]), ["ALPHA"])
        self.assertEqual(list(bravo["workspaces"]), ["BRAVO"])
        # Both carry the shared config, so a restart restores the active workspace.
        self.assertEqual(bravo["config"], {"ato": "ALPHA", "title": "Patrol"})
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(srv.DATA_STORE["config"]["ato"], "ALPHA")
        self.assertEqual(srv.workspace_sources["BRAVO"], "BRAVO_Screen.txt")

    def test_only_changed_workspaces_are_rewritten(self):
        import time

        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.post("/api/save_reports", {"ato": "BRAVO", "reports": [report("b1", "BRAVO001")]})
        srv.flush_pending_save()
        alpha = Path(srv.BACKUP_DIR) / "ALPHA_Patrol.txt"
        before = alpha.stat().st_mtime_ns
        time.sleep(0.05)
        self.post("/api/save_reports", {"ato": "BRAVO", "reports": [report("b2", "BRAVO002")]})
        srv.flush_pending_save()
        self.assertEqual(
            alpha.stat().st_mtime_ns, before, "ALPHA was untouched, so its file is too"
        )
        bravo = srv._extract_json_from_file(
            (Path(srv.BACKUP_DIR) / "BRAVO_Patrol.txt").read_text("utf-8")
        )
        self.assertEqual(len(bravo["workspaces"]["BRAVO"]), 2)

    def test_a_combined_file_from_an_older_version_is_split_on_the_first_save(self):
        # Before 2.4 one file held every workspace, named after the active one.
        combined = {"ALPHA": [report()], "BRAVO": [report("b1", "BRAVO001", title="Screen")]}
        _, text = srv.render_backup(combined, {"ato": "ALPHA", "title": "Patrol"}, {}, {})
        folder = Path(srv.BACKUP_DIR)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "ALPHA_Patrol.txt").write_text(text, encoding="utf-8")
        srv.load_data_from_disk()
        self.assertEqual(sorted(srv.DATA_STORE["workspaces"]), ["ALPHA", "BRAVO"])
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report("r2", "ALPHA002")]})
        srv.flush_pending_save()
        alpha = srv._extract_json_from_file((folder / "ALPHA_Patrol.txt").read_text("utf-8"))
        self.assertEqual(
            list(alpha["workspaces"]), ["ALPHA"], "the combined file became ALPHA's own"
        )
        self.assertTrue((folder / "BRAVO_Screen.txt").exists(), "BRAVO got its own file")
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(sorted(srv.DATA_STORE["workspaces"]), ["ALPHA", "BRAVO"])
        self.assertEqual(len(srv.DATA_STORE["workspaces"]["ALPHA"]), 2)

    def test_every_accepted_write_is_audited_with_its_operator(self):
        log = Path(srv.BACKUP_DIR) / srv.AUDIT_LOG_NAME
        before = len(log.read_text("utf-8").splitlines()) if log.exists() else 0
        self.post("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}})
        self.post(
            "/api/save_reports",
            {"ato": "ALPHA", "reports": [report(), report("r2", "ALPHA002", deleted=True)]},
        )
        self.post("/api/edit_report", {"ato": "ALPHA", "reportId": "r1", "fields": {"size": "x"}})
        # Refused writes leave no trace.
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]}, code="WRONGCODE2")
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(time="bad")]})
        lines = log.read_text("utf-8").splitlines()[before:]
        self.assertEqual(len(lines), 3, lines)
        stamp = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z  "
        self.assertRegex(lines[0], stamp + r"AB@127\.0\.0\.1\s+save_profile AB$")
        self.assertRegex(
            lines[1], stamp + r"AB@127\.0\.0\.1\s+save_reports ALPHA: 2 report\(s\), 1 deleted$"
        )
        self.assertRegex(lines[2], stamp + r"AB@127\.0\.0\.1\s+edit_report ALPHA r1$")

    def test_dated_snapshots_are_kept_hourly_and_pruned(self):
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
        snap_dir = Path(srv.BACKUP_DIR) / srv.SNAPSHOT_DIR_NAME
        shutil.rmtree(snap_dir, ignore_errors=True)  # other tests in this class snapshot too
        with (
            mock.patch.object(srv, "SNAPSHOT_KEEP", 2),
            mock.patch.object(srv, "_last_snapshot_at", None),
        ):

            def save(size):
                self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(size=size)]})
                srv.flush_pending_save()
                return len(list(snap_dir.glob("*.txt")))

            # The first save of a session snapshots; the next one, minutes later, doesn't.
            self.assertEqual(save("v0"), 1)
            self.assertEqual(save("v0 again"), 1)
            for n in (1, 2):
                srv._last_snapshot_at -= srv.SNAPSHOT_INTERVAL_SECONDS  # an hour passes
                save(f"v{n}")
            # Three snapshots were due; only the newest two remain.
            snaps = sorted(snap_dir.glob("*.txt"))
        self.assertEqual(len(snaps), 2)
        for s in (
            snaps
        ):  # UTC stamp first, so a listing is chronological; same-second copies are numbered
            self.assertRegex(s.name, r"^\d{8}_\d{6}Z_ALPHA_Patrol(_\d+)?\.txt$")
        newest = srv._extract_json_from_file(snaps[-1].read_text("utf-8"))
        self.assertEqual(newest["workspaces"]["ALPHA"][0]["size"], "v2")
        # Snapshots live in a subfolder, which the boot loader does not read.
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(srv.workspace_sources["ALPHA"], "ALPHA_Patrol.txt")
        for source in srv.workspace_sources.values():
            self.assertNotRegex(source, r"^\d{8}_\d{6}Z_", "a snapshot was loaded")

    def test_disk_write_does_not_hold_the_data_lock(self):
        # Regression: the whole save used to run under data_lock, freezing every
        # request handler for the duration of the disk I/O.
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        cancel_pending_save()
        lock_held_during_write = []
        real_replace = srv.os.replace

        def spying_replace(src, dst):
            lock_held_during_write.append(srv.data_lock.locked())
            return real_replace(src, dst)

        with mock.patch.object(srv.os, "replace", spying_replace):
            srv.save_data_to_disk()
        self.assertEqual(lock_held_during_write, [False])

    def pending_retry(self):
        """The delay of the save the server has scheduled, or None."""
        with srv._save_timer_lock:
            t = srv._save_timer
        return t.interval if t is not None and t.is_alive() else None

    def test_a_backup_that_cannot_be_prepared_keeps_its_changes_and_is_retried(self):
        # Regression: a failure while rendering happened after the pending
        # changes were cleared, outside any try, and every later save failed silently.
        self.addCleanup(cancel_pending_save)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        srv.flush_pending_save()
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report("r2", "ALPHA002")]})
        cancel_pending_save()
        boom = RuntimeError("bad report")
        with (
            mock.patch.object(srv, "render_workspace_backups", side_effect=boom),
            mock.patch.object(srv, "safe_print") as printed,
        ):
            srv.save_data_to_disk()
        self.assertEqual(srv._dirty_atos, {"ALPHA"}, "the change is still pending")
        self.assertTrue(printed.call_args_list[0].args[0].startswith("[!] Could not prepare"))
        self.assertIn("bad report", printed.call_args_list[0].args[0])
        self.assertEqual(self.pending_retry(), 1.0)
        cancel_pending_save()
        with mock.patch.object(srv, "safe_print"):
            srv.save_data_to_disk()
        text = (Path(srv.BACKUP_DIR) / "ALPHA_Patrol.txt").read_text("utf-8")
        self.assertEqual(len(srv._extract_json_from_file(text)["workspaces"]["ALPHA"]), 2)

    def test_a_locked_backup_is_retried_with_a_growing_wait(self):
        # Windows antivirus or OneDrive holding the file makes os.replace fail;
        # the save must come back by itself, not wait for the next edit.
        self.addCleanup(cancel_pending_save)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        cancel_pending_save()
        calls = []
        real_fsync = srv.os.fsync

        def locked(src, dst):
            calls.append("replace")
            raise PermissionError(13, "The process cannot access the file")

        def fsync(fd):
            calls.append("fsync")
            return real_fsync(fd)

        with (
            mock.patch.object(srv.os, "replace", locked),
            mock.patch.object(srv.os, "fsync", fsync),
            mock.patch.object(srv, "safe_print") as printed,
        ):
            delays = []
            for _ in range(5):
                srv.save_data_to_disk()
                delays.append(self.pending_retry())
                cancel_pending_save()
        self.assertEqual(calls[:2], ["fsync", "replace"], "flushed to disk before replacing")
        self.assertEqual(delays, [1.0, 2.0, 5.0, 30.0, 30.0])
        self.assertEqual(srv._dirty_atos, {"ALPHA"})
        lines = [c.args[0] for c in printed.call_args_list]
        self.assertEqual(len(lines), 2, "said once for the whole run of failures")
        self.assertIn("ALPHA_Patrol.txt", lines[0])
        with mock.patch.object(srv, "safe_print") as printed:
            srv.save_data_to_disk()
        self.assertEqual(printed.call_args_list[0].args[0], "[+] Backups are being saved again.")
        self.assertIsNone(self.pending_retry())
        self.assertEqual(srv._dirty_atos, set())

    def test_a_hand_edited_backup_cannot_stop_saves(self):
        folder = Path(tempfile.mkdtemp(prefix="salt-odd-"))
        self.addCleanup(shutil.rmtree, folder, True)
        odd = {
            "workspaces": {
                "ALPHA": [
                    report(title=5, displayId=7, history=None),
                    report("r2", "ALPHA002", lm="x"),
                    "junk",
                ],
                "BRAVO": "not a list",
            },
            "config": {"ato": ["ALPHA"], "title": 9},
            "profiles": [],
        }
        (folder / "ALPHA_x.txt").write_text(
            f"{srv.BACKUP_START}{json.dumps(odd)}{srv.BACKUP_END}", encoding="utf-8"
        )
        with mock.patch.object(srv, "BACKUP_DIR", str(folder)):
            srv.load_data_from_disk()
            self.assertEqual(len(srv.DATA_STORE["workspaces"]["ALPHA"]), 2)
            with mock.patch.object(srv, "safe_print") as printed:
                srv.flush_pending_save()
            self.assertEqual(printed.call_args_list, [])
            self.assertTrue((folder / "ALPHA_5.txt").exists())

    def test_boot_merges_every_backup_file(self):
        for name, ws in (
            ("ALPHA_Patrol.txt", {"ALPHA": [report()]}),
            ("BRAVO_Screen.txt", {"bravo": [report("b1", "BRAVO001")]}),
        ):
            _, text = srv.render_backup(ws, {"ato": next(iter(ws)), "title": "x"}, {}, {})
            Path(srv.BACKUP_DIR).mkdir(parents=True, exist_ok=True)
            (Path(srv.BACKUP_DIR) / name).write_text(text, encoding="utf-8")
        srv.load_data_from_disk()
        self.assertEqual(
            sorted(srv.DATA_STORE["workspaces"]),
            ["ALPHA", "BRAVO"],
            "keys from disk are normalized like request keys",
        )

    def test_boot_takes_the_newest_file_as_authority_but_merges_every_report(self):
        import os
        import time

        folder = Path(srv.BACKUP_DIR)
        folder.mkdir(parents=True, exist_ok=True)
        older = {"ALPHA": [report(lm=1, size="old"), report("r2", "ALPHA002", lm=1)]}
        newer = {"ALPHA": [report(lm=2, size="new")]}
        for name, ws, title, age in (
            ("ALPHA_Day1.txt", older, "Day1", 100),
            ("ALPHA_Day2.txt", newer, "Day2", 0),
        ):
            _, text = srv.render_backup(ws, {"ato": "ALPHA", "title": title}, {}, {})
            path = folder / name
            path.write_text(text, encoding="utf-8")
            os.utime(path, (time.time() - age, time.time() - age))
        srv.load_data_from_disk()
        by_id = {r["id"]: r for r in srv.DATA_STORE["workspaces"]["ALPHA"]}
        self.assertEqual(by_id["r1"]["size"], "new", "newest lastModified wins across files")
        self.assertIn("r2", by_id, "a report only the older file holds is kept")
        self.assertEqual(srv.DATA_STORE["config"]["title"], "Day2", "config from the newest file")
        self.assertEqual(srv.workspace_sources["ALPHA"], "ALPHA_Day2.txt")

    # -- live updates -------------------------------------------------------- #
    def open_events(self):
        req = urllib.request.Request(
            self.base + "/api/events", headers={"Cookie": f"salt_access={CODE}"}
        )
        return urllib.request.urlopen(req, timeout=5)

    def wait_until(self, predicate, timeout=3.0):
        import time

        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                return False
            time.sleep(0.02)
        return True

    def test_event_stream_opens_with_an_update(self):
        with contextlib.closing(self.open_events()) as resp:
            self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
            self.assertEqual(resp.readline(), b"data: update\n")

    def test_heartbeats_flow_while_the_client_is_quiet(self):
        with (
            mock.patch.object(srv, "SSE_HEARTBEAT_SECONDS", 0.05),
            contextlib.closing(self.open_events()) as resp,
        ):
            resp.readline()  # bootstrap update
            resp.readline()  # blank line ending it
            self.assertEqual(resp.readline(), b": heartbeat\n")

    def test_a_client_that_leaves_is_pruned_with_its_initials(self):
        self.post("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}})
        resp = self.open_events()
        resp.readline()
        self.assertTrue(self.wait_until(lambda: len(srv.sse_clients) == 1))
        self.assertEqual(self.sync()["connected_initials"], ["AB"])
        resp.close()
        self.assertTrue(self.wait_until(lambda: not srv.sse_clients), "client pruned on close")
        self.assertNotIn("127.0.0.1", srv.client_initials, "its IP->initials entry went with it")

    def test_the_host_counts_once_with_a_localhost_and_a_lan_tab(self):
        # Regression: the launcher opens the LAN URL, so a host with a
        # localhost tab too was counted as two operators.
        host = {"127.0.0.1", "10.0.0.5"}
        with mock.patch.object(srv, "_is_localhost", lambda ip: ip in host):
            clients = [
                srv.SSEClient(io.BytesIO(), srv._machine(ip))
                for ip in ("10.0.0.5", "127.0.0.1", "203.0.113.9")
            ]
        with srv.sse_lock:
            srv.sse_clients.extend(clients)
        try:
            self.assertEqual(self.sync()["connected_users"], 2)
        finally:
            with srv.sse_lock:
                for c in clients:
                    srv.sse_clients.remove(c)

    def test_graceful_drain_tells_clients_and_flushes_the_save(self):
        with contextlib.closing(self.open_events()) as resp:
            resp.readline()
            resp.readline()
            self.assertTrue(self.wait_until(lambda: len(srv.sse_clients) == 1))
            with mock.patch.object(srv, "flush_pending_save") as flush:
                srv.graceful_drain()
            flush.assert_called_once()
            self.assertEqual(resp.readline(), b"event: shutdown\n")
            self.assertEqual(resp.readline(), b"data: server-stopping\n")

    def test_sync_is_gzipped_for_clients_that_accept_it(self):
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        plain_status, plain = self.request("/api/sync")
        self.assertEqual(plain_status, 200)
        conn = http.client.HTTPConnection("127.0.0.1", self.editor.server_address[1], timeout=5)
        try:
            conn.request(
                "GET",
                "/api/sync",
                headers={"Cookie": f"salt_access={CODE}", "Accept-Encoding": "gzip"},
            )
            resp = conn.getresponse()
            packed = resp.read()
            self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
            self.assertEqual(resp.getheader("Vary"), "Accept-Encoding")
        finally:
            conn.close()
        self.assertLess(len(packed), len(plain))
        self.assertEqual(json.loads(gzip.decompress(packed)), json.loads(plain))
        # Same state, same compressed bytes: the second request reuses the first's work.
        with mock.patch.object(srv.gzip, "compress", wraps=srv.gzip.compress) as spy:
            conn = http.client.HTTPConnection("127.0.0.1", self.editor.server_address[1], timeout=5)
            try:
                conn.request(
                    "GET",
                    "/api/sync",
                    headers={"Cookie": f"salt_access={CODE}", "Accept-Encoding": "gzip"},
                )
                self.assertEqual(conn.getresponse().read(), packed)
            finally:
                conn.close()
        spy.assert_not_called()


if __name__ == "__main__":
    unittest.main()

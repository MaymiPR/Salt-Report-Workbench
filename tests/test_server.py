# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for the sync server: pure logic plus HTTP behavior against a live instance.

Standard library only, matching the project's zero-dependency rule. Run with
``python -m unittest discover -s tests``.
"""

from __future__ import annotations

import ast
import contextlib
import gzip
import http.client
import inspect
import io
import json
import os
import re
import shutil
import ssl
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "scripts"))

import build  # noqa: E402
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
TOPO = {"name": "Topo", "kind": "wms", "url": "http://10.0.0.5/wms", "layers": "0"}
PL_BLUE = {
    "type": "PL",
    "name": "BLUE",
    "geometry": {"type": "LineString", "coordinates": [[44.35, 33.30], [44.57, 33.30]]},
}


# An update notice: the number of the latest change.
NOTICE = rb'^data: \{"v":\d+\}\n$'


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
            "tags": [],
            "fmv": {},
        }
    )
    srv.workspace_sources.clear()
    srv.client_initials.clear()
    srv.client_workspace.clear()
    srv.unloaded_workspaces.clear()
    srv.mission.update(id="", since=0, finished=[])
    srv.activity_log.clear()
    srv._rate_buckets.clear()
    srv._auth_fail_buckets.clear()
    srv._basemap_buckets.clear()
    srv.invalidate_sync_cache()
    # A notice or console line still to come from the last test goes with it.
    for timer in ("_notice_timer", "_machines_timer"):
        if pending := getattr(srv, timer):
            pending.cancel()
            setattr(srv, timer, None)
    srv._dirty_atos = None
    srv._shared_dirty = True
    srv._save_failures = 0
    srv._file_holds.clear()
    srv._merged_files.clear()


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

    def test_half_of_a_surrogate_pair_is_refused_anywhere_in_a_body(self):
        # Regression: "\ud83d" (an emoji cut in two) is valid JSON, was taken,
        # and then every save of the backups failed on it, for good.
        self.assertFalse(srv._is_str("BRIDGE \ud83d"))
        self.assertTrue(srv._is_str("BRIDGE \U0001f600", 10), "a whole emoji is fine")
        self.assertRejects(
            srv._v_save_reports, {"ato": "A", "reports": [report(size="2x \ud83d")]}, "size"
        )

        def check(body):
            raw = json.dumps(body).encode()  # as JSON.stringify sends it: "\ud83d"
            self.assertIn(b"\\ud83d", raw)
            return srv._check_text(raw, json.loads(raw))

        # A field no validator knows is kept, so the whole body is looked at, names too.
        self.assertEqual(
            check({"ato": "A", "reports": [report(), report("r2", note="x\ud83d")]}),
            "reports[1].note holds a broken character (U+D83D, half of an emoji or other symbol)",
        )
        self.assertIn(
            "a name in reports[0].custom", check({"reports": [{"custom": {"\ud83d": ""}}]})
        )
        self.assertIsNone(check({"ato": "A", "reports": [report(size="\U0001f600")]}))
        plain = json.dumps({"size": "\U0001f600 \\ud83d"}, ensure_ascii=False).encode()
        self.assertIsNone(srv._check_text(plain, json.loads(plain)), "a whole one, sent as is")
        # Sent as bytes that aren't UTF-8, json.loads takes it in as well.
        odd = b'{"size": "\xed\xa0\xbd"}'
        self.assertIn("size holds a broken character", srv._check_text(odd, json.loads(odd)))

    def test_report_times_must_be_real_but_imports_keep_theirs(self):
        # Regression: 2026-13-40T25:00:00Z matched the pattern, and the
        # page's ArcGIS export then failed on it.
        v = srv._v_save_reports
        bad = report(time="2026-13-40T25:00:00Z")
        self.assertRejects(
            v, {"ato": "A", "reports": [report(), bad]}, "reports[1].time must be a real"
        )
        for t in ("2026-02-29T10:00:00Z", "2026-01-15T24:00:00Z", "2026-01-15T14:60:00"):
            self.assertRejects(
                v,
                {"ato": "A", "reports": [report(time=t)]},
                "real date",
            )
        for t in ("2028-02-29T23:59:59Z", "2026-01-15T14:30:00.123456789Z", "2026-01-15T14:30:00"):
            self.assertIsNone(v({"ato": "A", "reports": [report(time=t)]}), t)
        # What a file holds comes in as it is, as at boot: an import, an
        # earlier version, and a report deleted.
        for source in ("backup", "csv"):
            self.assertIsNone(v({"ato": "A", "reports": [bad], "source": source}), source)
        old = report(history=[{**report(), "time": "2026-13-40T25:00:00Z"}])
        self.assertIsNone(v({"ato": "A", "reports": [old]}))
        self.assertIsNone(v({"ato": "A", "reports": [{**bad, "deleted": True}]}))
        e = srv._v_edit_report
        edit = {"ato": "A", "reportId": "r1"}
        self.assertRejects(e, {**edit, "fields": {"time": "2026-04-31T10:00:00Z"}}, "fields.time")
        self.assertIsNone(e({**edit, "fields": {"time": "2026-04-30T10:00:00Z"}}))

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
        self.assertRejects(v, {"ato": "A", "overlays": [{**NAI1, "type": "AO"}]}, "NAI, OBJ, PL")
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

    def test_two_thousand_graphics_are_taken(self):
        # A team loads hundreds of NAIs: up to 2,000 graphics, the 2,001st refused.
        def nai(i):
            lon, lat = 44 + (i % 50) * 0.01, 33 + (i // 50) * 0.01
            ring = [[lon, lat], [lon + 0.005, lat], [lon + 0.005, lat + 0.005], [lon, lat]]
            return {
                "type": "NAI",
                "name": str(i),
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }

        self.assertEqual(srv.MAX_OVERLAYS, 2000)
        many = [nai(i) for i in range(2000)]
        self.assertIsNone(srv._v_save_overlays({"overlays": many, "tagged": True}))
        self.assertRejects(
            srv._v_save_overlays, {"overlays": [*many, nai(2000)]}, "too many overlays (max 2000)"
        )

    def test_checks_that_were_in_the_routes_are_in_the_validators(self):
        # A blank name, or nothing to do: once refused by the route itself.
        self.assertRejects(srv._v_save_reports, {"ato": "  ", "reports": []}, "ato")
        self.assertRejects(srv._check_ato, {"ato": " "}, "ato must be a non-empty string")
        edit = {"ato": "A", "reportId": "r1", "fields": {"size": "x"}}
        self.assertIsNone(srv._v_edit_report(edit))
        self.assertRejects(srv._v_edit_report, {**edit, "ato": "\t"}, "ato")
        self.assertRejects(srv._v_edit_report, {**edit, "reportId": ""}, "reportId")
        self.assertRejects(srv._v_edit_report, {**edit, "fields": {}}, "fields must name")
        self.assertRejects(srv._v_delete_history, {"ato": "A", "deletions": []}, "non-empty list")
        self.assertRejects(srv._v_delete_history, {"ato": "A"}, "deletions")
        self.assertRejects(srv._v_save_profile, {"profile": {"initials": "  "}}, "initials")
        self.assertIsNone(srv._v_save_profile({"profile": {"initials": " AB"}}))

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
    def test_tags_are_checked(self):
        v = srv._v_save_tags
        routes = {"id": "tag-a1", "name": "Routes", "color": "#ff9f0a"}
        self.assertIsNone(v({"tags": []}))
        self.assertIsNone(
            v({"tags": [routes, {"id": "tag-b2", "name": "EAs", "color": "#BF5AF2"}]})
        )
        self.assertRejects(v, {"tags": routes}, "list")
        self.assertRejects(v, {"tags": [routes, {**routes, "name": "Other"}]}, "id is used twice")
        self.assertRejects(
            v, {"tags": [routes, {**routes, "id": "tag-c3", "name": " routes "}]}, "used twice"
        )
        for bad in ("NAI", "a1", "tag-", "tag-ABC", "tag-" + "a" * 17, 5):
            self.assertRejects(v, {"tags": [{**routes, "id": bad}]}, "id")
        self.assertRejects(v, {"tags": [{**routes, "name": " "}]}, "name")
        self.assertRejects(v, {"tags": [{**routes, "name": "R" * 31}]}, "name")
        self.assertRejects(v, {"tags": [{**routes, "name": "obj"}]}, "built in")
        for built_in in ("axis", "Axis of advance"):
            self.assertRejects(v, {"tags": [{**routes, "name": built_in}]}, "built in")
        for bad in ("orange", "#fff", "#ff9f0a; x", None):
            self.assertRejects(v, {"tags": [{**routes, "color": bad}]}, "color")
        many = [{**routes, "id": f"tag-{i}", "name": f"T{i}"} for i in range(31)]
        self.assertRejects(v, {"tags": many}, "too many")
        # A graphic's type: built in, a tag's id, or none.
        ov = srv._v_save_overlays
        self.assertIsNone(ov({"overlays": [{**NAI1, "type": "tag-a1"}, {**PL_BLUE, "type": ""}]}))
        self.assertIsNone(ov({"overlays": [NAI1], "tagged": True}))
        self.assertRejects(ov, {"overlays": [{**NAI1, "type": "tag-A1"}]}, "a tag's id")
        self.assertRejects(ov, {"overlays": [{**NAI1, "type": None}]}, "a tag's id")
        self.assertRejects(ov, {"overlays": [NAI1], "tagged": "yes"}, "tagged")
        # An axis of advance is built in too.
        self.assertIsNone(
            ov({"overlays": [{**PL_BLUE, "type": "AXIS", "name": "GOLD"}], "tagged": True})
        )
        self.assertRejects(ov, {"overlays": [{**PL_BLUE, "type": "axis"}]}, "a tag's id")

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
        # On station or off: true or false, and optional.
        self.assertIsNone(v({"drones": [{**ge, "offStation": True}, {**ge, "name": "GE 2"}]}))
        for bad in ("yes", 1, None):
            self.assertRejects(v, {"drones": [{**ge, "offStation": bad}]}, "offStation")

    def test_fmv_mode_is_checked(self):
        v = srv._v_save_fmv
        self.assertIsNone(v({"fmv": {"on": True}}))
        self.assertIsNone(v({"fmv": {"on": False, "x": 1}}))
        for bad in ({}, {"fmv": {}}, {"fmv": True}, {"fmv": {"on": 1}}, {"fmv": {"on": "on"}}):
            self.assertRejects(v, bad, "fmv")
        # A backup's copy: never saved, or from before it, is none at all.
        self.assertEqual(srv.read_fmv({"on": False, "x": 1}), {"on": False})
        for nothing in ({}, None, [], {"on": "yes"}):
            self.assertIsNone(srv.read_fmv(nothing))

    def test_a_report_says_which_drone_it_was_seen_from(self):
        v = srv._v_save_reports
        ok = report(observer="GE 1", history=[report(observer="")])
        self.assertIsNone(v({"ato": "ALPHA", "reports": [ok]}))
        self.assertIsNone(v({"ato": "ALPHA", "reports": [report(observer=None)]}))
        self.assertRejects(v, {"ato": "ALPHA", "reports": [report(observer=7)]}, "observer")
        long = report(observer="x" * 41)
        self.assertRejects(v, {"ato": "ALPHA", "reports": [long]}, "observer")
        hist = report(history=[report(observer=["GE 1"])])
        self.assertRejects(v, {"ato": "ALPHA", "reports": [hist]}, "history[0].observer")
        edit = {"ato": "ALPHA", "reportId": "r1", "fields": {"observer": 1}}
        self.assertRejects(srv._v_edit_report, edit, "observer")
        self.assertIn("observer", srv._EDITABLE_FIELDS)

    def test_the_server_knows_every_kind_of_equipment_the_page_has(self):
        import re

        core = build.core_source()
        block = core[core.index("const EQUIPMENT_ROLES = [") : core.index("const eqp = ")]
        self.assertEqual(set(re.findall(r"\['([a-z0-9]+)', '", block)), set(srv._EQUIPMENT_ROLES))

    def test_the_server_knows_every_rule_the_page_has(self):
        import re

        core = build.core_source()
        block = core[core.index("const NARRATIVE_RULES = [") : core.index("const RULE_ORDER")]
        ids = set(re.findall(r"^\s*\['([a-z0-9]+)', '", block, re.M))
        self.assertEqual(len(ids), 58)
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
        # The elevation source: a basemap, a layer, an encoding, units.
        terrain = {"basemap": "DEM", "layer": "dem", "encoding": "", "units": "ft"}
        self.assertIsNone(v({"narrative": {"terrain": terrain}}))
        self.assertIsNone(v({"narrative": {"terrain": {}}}), "none")
        self.assertRejects(v, {"narrative": {"terrain": {"layer": "dem"}}}, "basemap")
        self.assertRejects(
            v, {"narrative": {"terrain": {**terrain, "encoding": "png"}}}, "encoding"
        )
        self.assertRejects(v, {"narrative": {"terrain": {**terrain, "units": "yd"}}}, "units")
        e = srv._v_elevation
        self.assertIsNone(e({"points": [[44.0, 33.0]]}))
        self.assertRejects(e, {"points": []}, "points")
        self.assertRejects(e, {"points": [[0, 0]] * (srv.ELEVATION_MAX_POINTS + 1)}, "points")
        self.assertRejects(e, {"points": [[44.0, 95.0]]}, "lon, lat")
        self.assertRejects(e, {"points": [["44", 33]]}, "lon, lat")
        self.assertRejects(srv._v_elevation_test, {"terrain": terrain, "point": [1]}, "point")
        # How it moves: one of the running gears, or not said.
        self.assertRejects(
            v, {"narrative": {"equipment": [{"type": "X", "role": "mech", "gear": "legs"}]}}, "gear"
        )
        for gear in ("tracked", "wheeled", "towed", "portable", "foot", "air", "static", ""):
            self.assertIsNone(
                v({"narrative": {"equipment": [{"type": "X", "role": "mech", "gear": gear}]}}), gear
            )
        # How far it reaches: km above 0 and at most MAX_EQUIPMENT_REACH_KM, when said.
        for reach in (0, -1, srv.MAX_EQUIPMENT_REACH_KM + 1, "5", True, None, float("nan")):
            self.assertRejects(
                v,
                {"narrative": {"equipment": [{"type": "X", "role": "mech", "reach": reach}]}},
                "reach",
            )
        for reach in (0.5, 5, srv.MAX_EQUIPMENT_REACH_KM):
            self.assertIsNone(
                v({"narrative": {"equipment": [{"type": "X", "role": "mech", "reach": reach}]}}),
                reach,
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
        # The AO's way of march: a compass point, or none.
        for toward in ("", "N", "SW", "W"):
            self.assertIsNone(v({"narrative": {"toward": toward}}))
        for bad in ("w", "WEST", "NNW", None, ["W"], 270):
            self.assertRejects(v, {"narrative": {"toward": bad}}, "toward")
        clean = srv.clean_narrative
        self.assertNotIn("toward", clean({}), "none: as settings were before it")
        self.assertNotIn("toward", clean({"toward": ""}))
        self.assertEqual(clean({"toward": "W"})["toward"], "W")


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


def _server_source_calls(*names):
    """(call, text) for each call in the server's source to one of ``names``
    (a function or a method), with each literal string argument's text; an
    f-string's fields read as ``{}``."""

    def text(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            return "".join(text(v) if isinstance(v, ast.Constant) else "{}" for v in node.values)
        return None

    tree = ast.parse(Path(srv.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
        if name in names:
            for arg in [*node.args, *(k.value for k in node.keywords)]:
                if (t := text(arg)) is not None:
                    yield name, t


class ServerTextStyleTests(unittest.TestCase):
    def test_console_lines_follow_the_prefix_rule(self):
        # [!] a problem, [+] something done, [*] information; a line that
        # goes on from the one above is indented four spaces.
        lines = [t for _, t in _server_source_calls("safe_print")]
        self.assertGreater(len(lines), 30)
        for line in lines:
            self.assertRegex(line.lstrip("\n"), r"^(\[[!+*]\] |    )", repr(line))
        # The connected-machines line is built apart from its safe_print.
        with mock.patch.object(srv, "sse_clients", []):
            self.assertTrue(srv.machines_line().startswith("[*] "))

    def test_no_em_dash_in_text_a_user_reads(self):
        # Code comments and docstrings may keep theirs.
        texts = list(
            _server_source_calls(
                "safe_print",
                "add_argument",
                "ArgumentParser",
                "error",
                "_error",
                "_refuse",
                "_bad_request",
                "Limit",  # a route's own rate limit says why it refused
            )
        )
        self.assertGreater(len(texts), 50)
        for name, t in texts:
            self.assertNotIn("—", t, f"{name}: {t!r}")
            self.assertNotIn("[i]", t, f"{name}: {t!r}")
        with mock.patch.object(sys, "argv", ["salt_sync_server", "--help"]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
                srv.parse_cli_args()
        self.assertIn("--no-https", out.getvalue())
        self.assertNotIn("—", out.getvalue())

    def test_the_table_of_contents_matches_the_banners(self):
        source = Path(srv.__file__).read_text(encoding="utf-8")
        banners = re.findall(r"^# =+\n# (.+)\n# =+$", source, re.M)
        contents = source.split("\n# Contents:", 1)[1].split("\n\n", 1)[0]
        listed = [
            re.split(r"\s{2,}", line[1:].strip())[0]
            for line in contents.splitlines()
            if line.startswith("#   ")
        ]
        self.assertGreater(len(banners), 10)
        self.assertEqual(listed, banners)

    def test_every_api_error_message_is_a_sentence(self):
        calls = _server_source_calls("_error", "_refuse", "_bad_request", "Limit")
        messages = [t for name, t in calls if t]
        self.assertIn("Too many map images. Retry shortly.", messages)
        self.assertGreater(len(messages), 10)
        for t in messages:
            self.assertRegex(t, r"^[A-Z].*\.$", repr(t))


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
            self.assertTrue(srv._access_code_ok({}, True, remote), "viewer port is never gated")
            self.assertTrue(srv._access_code_ok({}, False, "127.0.0.1"), "the host is trusted")
            self.assertTrue(srv._access_code_ok(good, False, remote))
            self.assertFalse(srv._access_code_ok(bad, False, remote))
            self.assertFalse(srv._access_code_ok({}, False, remote))
        with mock.patch.object(srv, "_access_code", None):
            self.assertTrue(
                srv._access_code_ok({}, False, remote), "--no-access-code disables the gate"
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
        for bad in (" ", "", "with space", "x" * 65, "café", "abc12", " abc12 "):
            with (
                mock.patch.object(sys, "argv", ["salt_sync_server", "--access-code", bad]),
                mock.patch("sys.stderr", io.StringIO()),
                self.assertRaises(SystemExit, msg=repr(bad)),
            ):
                srv.parse_cli_args()
        with mock.patch.object(sys, "argv", ["salt_sync_server", "--access-code", "Field-Day_7"]):
            self.assertEqual(srv.parse_cli_args().access_code, "Field-Day_7")
        with mock.patch.object(sys, "argv", ["salt_sync_server", "--access-code", "abc123"]):
            self.assertEqual(srv.parse_cli_args().access_code, "abc123", "six is enough")


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

    def raw_exchange(self, data: bytes) -> bytes:
        import socket

        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(data)
            reply = b""
            while chunk := s.recv(4096):
                reply += chunk
        return reply

    def test_the_redirect_location_carries_only_url_characters(self):
        # Regression: a bare LF in the request path went into the Location header.
        reply = self.raw_exchange(
            b"GET /a\nSet-Cookie:x=1/\xff HTTP/1.1\r\nHost: 127.0.0.1:"
            + str(self.port).encode()
            + b"\r\n\r\n"
        )
        head = reply.split(b"\r\n\r\n", 1)[0].split(b"\r\n")
        self.assertEqual(head[0], b"HTTP/1.1 307 Temporary Redirect")
        location = [h for h in head if h.startswith(b"Location:")]
        self.assertEqual(
            location, [f"Location: https://127.0.0.1:{self.port}/a%0ASet-Cookie:x=1/%FF".encode()]
        )
        self.assertFalse([h for h in head if h.lower().startswith(b"set-cookie")])

    def test_a_trickling_plain_request_gets_a_bounded_wait(self):
        # Regression: each read got the full timeout again, so a byte every few
        # seconds held the thread for as long as the client liked.
        import socket
        import time

        got = []
        with (
            mock.patch.object(srv, "TLS_HANDSHAKE_TIMEOUT", 0.5),
            socket.create_connection(("127.0.0.1", self.port), timeout=5) as s,
        ):
            s.sendall(b"GET / HTTP/1.1\r\n")
            reader = threading.Thread(target=lambda: got.append((s.recv(4096), time.monotonic())))
            start = time.monotonic()
            reader.start()
            while reader.is_alive() and time.monotonic() - start < 5:
                with contextlib.suppress(OSError):
                    s.sendall(b"X-Slow: 1\r\n")
                time.sleep(0.1)
            reader.join(5)
        self.assertTrue(got and got[0][0].startswith(b"HTTP/1.1 307"), got)
        self.assertLess(got[0][1] - start, 3)

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


class StartupTests(unittest.TestCase):
    """The server run as a program, in a temporary folder."""

    SERVER = ROOT / "server" / "salt_sync_server.py"

    def run_server(self, *argv, prelude=""):
        tmp = Path(tempfile.mkdtemp(prefix="salt-start-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        script = (
            f"{prelude}\n"
            "import runpy, sys\n"
            f"sys.argv = {['salt_sync_server', '--backup-dir', str(tmp / 'backups'), *argv]!r}\n"
            f"runpy.run_path({str(self.SERVER)!r}, run_name='__main__')\n"
        )
        import subprocess

        return subprocess.run(
            [sys.executable, "-c", script],
            cwd=tmp,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            timeout=60,
        )

    def test_an_older_python_is_told_plainly(self):
        result = self.run_server(
            "--help", prelude="import sys; sys.version_info = (3, 11, 7, 'final', 0)"
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("needs Python 3.11.8 or newer", result.stderr)

    def test_the_file_parses_on_python_3_8(self):
        # So 3.8 and 3.9 reach the version check instead of a SyntaxError.
        import ast
        import re

        source = self.SERVER.read_text(encoding="utf-8")
        ast.parse(source, feature_version=(3, 8))
        self.assertNotRegex(
            source, re.compile(r"\bwith \($", re.M), "a parenthesized with needs 3.9 or later"
        )
        check = source.index("if sys.version_info < (3, 11, 8)")
        first_annotation = re.search(r"^\w+: [\w |\[\],]+ = ", source, re.M).start()
        self.assertLess(check, first_annotation, "checked before any annotation runs")

    def test_without_ssl_it_stops_unless_told_to_serve_plain_http(self):
        # Regression: it fell back to plain HTTP, the code readable on the network.
        import socket

        no_ssl = "import sys; sys.modules['ssl'] = None"
        args = ("--host", "127.0.0.1", "--viewer-port", "0", "--no-browser", "--no-minimize")
        result = self.run_server(*args, prelude=no_ssl)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("no ssl module", result.stdout)
        self.assertIn("--no-https", result.stdout)
        # With --no-https it goes on, as far as the port (taken here, so it stops there).
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = str(taken.getsockname()[1])
            result = self.run_server(*args, "--no-https", "--port", port, prelude=no_ssl)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"Could not listen on port {port}", result.stdout)
        self.assertNotIn("no ssl module", result.stdout)

    def test_a_stop_that_could_not_save_says_so_and_exits_non_zero(self):
        # Regression: it said "flushed to disk" and exited 0 when the save
        # had failed, so the launcher closed its window on the news.
        mine = Path(tempfile.mkdtemp(prefix="salt-stop-"))
        self.addCleanup(shutil.rmtree, mine, True)
        args = ("--host", "127.0.0.1", "--port", "0", "--viewer-port", "0", "--no-https")
        args += ("--no-browser", "--no-minimize", "--backup-dir", str(mine / "Auto Backups"))
        # Ctrl+C as soon as it serves.
        stop = (
            "import socketserver\n"
            "def stop(self, *a, **k):\n"
            "    raise KeyboardInterrupt\n"
            "socketserver.BaseServer.serve_forever = stop\n"
        )
        result = self.run_server(*args, prelude=stop)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("[+] Pending changes flushed to disk.", result.stdout)
        locked = (
            "import os\n"
            "def locked(*a, **k):\n"
            "    raise PermissionError(13, 'The process cannot access the file')\n"
            "os.replace = locked\n"
        )
        result = self.run_server(*args, prelude=stop + locked)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("[!] Changes NOT saved: the backups could not be written", result.stdout)
        self.assertNotIn("flushed to disk", result.stdout)
        # Both runs' console, with the time of each line, in the server log beside the backups.
        log = (mine / srv.LOG_DIR_NAME / srv.LOG_NAME).read_text("utf-8")
        self.assertEqual(log.count("[*] Starting S.A.L.T. Sync Server"), 2)
        self.assertRegex(log, r"\d\d:\d\d:\d\dZ  \[!\] Changes NOT saved")

    def test_the_banner_shows_the_address_listened_on(self):
        # Regression: with --host 127.0.0.1 it showed (and opened) the LAN
        # address, where nothing was listening.
        def banner():
            with mock.patch.object(srv, "safe_print") as printed:
                srv.run_boot_dashboard(viewer_port=8081, fingerprint=None)
            return "\n".join(c.args[0] for c in printed.call_args_list)

        with mock.patch.object(srv, "get_local_ip", return_value="10.0.0.12"):
            for host, shown in (
                ("0.0.0.0", "10.0.0.12"),
                ("", "10.0.0.12"),
                ("127.0.0.1", "127.0.0.1"),
                ("10.0.0.7", "10.0.0.7"),
                ("::1", "[::1]"),
            ):
                with mock.patch.object(srv, "HOST", host):
                    self.assertEqual(srv.display_host(), shown, host)
                    text = banner()
                    self.assertIn(f"http://{shown}:{srv.PORT}", text, host)
                    self.assertIn(f"http://{shown}:8081", text, host)

    def test_console_lines_share_one_prefix_style(self):
        import re

        source = self.SERVER.read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"""f?['"](?:\\n)? \[[+*!]\]""", source), [])
        with (
            mock.patch.object(sys, "argv", ["salt_sync_server", "--help"]),
            mock.patch("sys.stdout", io.StringIO()) as out,
            self.assertRaises(SystemExit),
        ):
            srv.parse_cli_args()
        self.assertIn(
            "Editor port to listen on, HTTPS unless --no-https", " ".join(out.getvalue().split())
        )


# --------------------------------------------------------------------------- #
# HTTP behavior against a live server
# --------------------------------------------------------------------------- #
CODE = "TESTCODE23"


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="salt-restore-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        patch = mock.patch.object(srv, "BACKUP_DIR", str(self.tmp))
        patch.start()
        self.addCleanup(patch.stop)
        snaps = self.tmp / "snapshots"
        snaps.mkdir()
        for stamp, body in (("20261027_090000Z", "old"), ("20261028_090000Z", "newer")):
            (snaps / f"{stamp}_ALPHA_Patrol.txt").write_text(body, encoding="utf-8")
            (snaps / f"{stamp}_Shared settings.json").write_text(body, encoding="utf-8")
        (snaps / "Superseded_X.txt").write_text("moved", encoding="utf-8")
        (self.tmp / "ALPHA_Patrol.txt").write_text("live", encoding="utf-8")
        (self.tmp / "BRAVO_Patrol.txt").write_text("live, made later", encoding="utf-8")
        (self.tmp / "audit.log").write_text("", encoding="utf-8")

    def restore(self, which, running=False):
        out = io.StringIO()
        with (
            mock.patch.object(srv, "_server_answers", return_value=running),
            mock.patch("sys.stdout", out),
        ):
            return srv.restore_snapshot(which), out.getvalue()

    def test_a_round_replaces_the_backups_which_are_kept(self):
        code, out = self.restore("20261027_090000Z")
        self.assertEqual(code, 0, out)
        live = {p.name: p.read_text(encoding="utf-8") for p in self.tmp.glob("*.txt")}
        self.assertEqual(live, {"ALPHA_Patrol.txt": "old"}, "the later workspace goes too")
        self.assertEqual((self.tmp / "Shared settings.json").read_text(encoding="utf-8"), "old")
        kept = next((self.tmp / "snapshots").glob("before-restore-*"))
        self.assertEqual(
            sorted(p.name for p in kept.iterdir()), ["ALPHA_Patrol.txt", "BRAVO_Patrol.txt"]
        )
        self.assertIn(
            "restored snapshot 20261027_090000Z", (self.tmp / "audit.log").read_text("utf-8")
        )
        # Rounds are pruned by name; the kept copies never are.
        self.assertEqual(sorted(srv.snapshot_rounds()), ["20261027_090000Z", "20261028_090000Z"])

    def test_latest_list_unknown_and_a_running_server(self):
        code, _ = self.restore("latest")
        self.assertEqual(code, 0)
        self.assertEqual((self.tmp / "ALPHA_Patrol.txt").read_text(encoding="utf-8"), "newer")
        code, out = self.restore("list")
        self.assertEqual(code, 0)
        self.assertLess(out.index("20261028_090000Z"), out.index("20261027_090000Z"))
        code, out = self.restore("20250101_000000Z")
        self.assertEqual(code, 1)
        self.assertIn("No snapshot round named", out)
        code, out = self.restore("latest", running=True)
        self.assertEqual(code, 1)
        self.assertIn("A server is running", out)

    def test_the_flag_runs_it_and_exits(self):
        with mock.patch.object(sys, "argv", ["salt_sync_server", "--restore", "list"]):
            self.assertEqual(srv.parse_cli_args().restore, "list")


def own_folder(test) -> Path:
    """An empty folder for ``test`` alone, removed after it."""
    folder = Path(tempfile.mkdtemp(prefix="salt-own-"))
    test.addCleanup(shutil.rmtree, folder, True)
    return folder


class SnapshotClockTests(unittest.TestCase):
    STAMP = "%Y%m%d_%H%M%SZ"

    def setUp(self):
        reset_state()
        self.addCleanup(reset_state)
        self.addCleanup(cancel_pending_save)
        self.tmp = own_folder(self)
        for name, value in (
            ("BACKUP_DIR", str(self.tmp)),
            ("_last_snapshot_at", None),
            ("_last_snapshot_stamp", None),
        ):
            patcher = mock.patch.object(srv, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.snaps = self.tmp / srv.SNAPSHOT_DIR_NAME
        self.snaps.mkdir()

    def test_rounds_named_ahead_of_a_clock_set_back_never_crowd_out_new_ones(self):
        # Regression: with 48 rounds named in the future (the clock put right
        # backwards since), each new round sorted first and was pruned as soon
        # as it was written, and --restore latest put back the old state.
        future = datetime(2030, 1, 1, tzinfo=timezone.utc)
        for i in range(srv.SNAPSHOT_KEEP):
            stamp = (future + timedelta(hours=i)).strftime(self.STAMP)
            (self.snaps / f"{stamp}_ALPHA_Patrol.txt").write_text("old", encoding="utf-8")
        srv.DATA_STORE["workspaces"]["ALPHA"] = [report()]
        with mock.patch.object(srv, "safe_print") as printed:
            srv.save_data_to_disk()
        self.assertEqual(printed.call_args_list, [])
        rounds = srv.snapshot_rounds()
        self.assertEqual(len(rounds), srv.SNAPSHOT_KEEP)
        newest = max(rounds)
        last = future + timedelta(hours=srv.SNAPSHOT_KEEP - 1)
        self.assertEqual(newest, (last + timedelta(seconds=1)).strftime(self.STAMP))
        self.assertNotIn(future.strftime(self.STAMP), rounds, "the oldest went")
        self.assertIn('"r1"', (self.snaps / f"{newest}_ALPHA_Patrol.txt").read_text("utf-8"))
        with (
            mock.patch.object(srv, "_server_answers", return_value=False),
            mock.patch.object(srv, "safe_print"),
        ):
            self.assertEqual(srv.restore_snapshot("latest"), 0)
        self.assertIn('"r1"', (self.tmp / "ALPHA_Patrol.txt").read_text("utf-8"))
        # A clock that is right names it by the time, as before.
        now = datetime(2031, 5, 1, 12, 0, 0, 500, tzinfo=timezone.utc)
        self.assertEqual(srv.snapshot_stamp(now), now.replace(microsecond=0))

    def test_the_round_just_written_is_never_pruned(self):
        for i in range(srv.SNAPSHOT_KEEP):
            stamp = (datetime(2030, 1, 1, tzinfo=timezone.utc) + timedelta(hours=i)).strftime(
                self.STAMP
            )
            (self.snaps / f"{stamp}_ALPHA_Patrol.txt").write_text("old", encoding="utf-8")
        path = srv.write_snapshot(
            "ALPHA_Patrol.txt", "new", datetime(2026, 11, 1, tzinfo=timezone.utc)
        )
        self.assertEqual(Path(path).read_text("utf-8"), "new")
        self.assertEqual(len(srv.snapshot_rounds()), srv.SNAPSHOT_KEEP)

    def test_a_snapshot_is_written_whole_or_not_at_all(self):
        # A full disk left a cut-off copy that --restore would have put back.
        def full(fd):
            raise OSError(28, "No space left on device")

        with mock.patch.object(srv.os, "fsync", full), self.assertRaises(OSError):
            srv.write_snapshot(
                "ALPHA_Patrol.txt", "x" * 1000, datetime(2026, 11, 1, tzinfo=timezone.utc)
            )
        self.assertEqual(list(self.snaps.iterdir()), [], "no snapshot, and no temporary file")


class ChangeNumberTests(unittest.TestCase):
    def setUp(self):
        reset_state()
        self.addCleanup(reset_state)
        self.tmp = own_folder(self)
        self.backups = self.tmp / "Auto Backups"
        for name, value in (
            ("BACKUP_DIR", str(self.backups)),
            ("_sync_version", 0),
            ("_change_reserved", None),
        ):
            patcher = mock.patch.object(srv, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def boot(self, now_ms):
        """Start numbering as a server started at ``now_ms`` by its clock does."""
        srv._sync_version = now_ms
        srv.start_change_numbers()
        return srv.current_version()

    def test_a_restart_with_the_clock_set_back_numbers_on_from_the_last_run(self):
        # Regression: numbers started at the boot time, so after a restart with
        # the clock set back every open page skipped the notices until reloaded.
        now = int(time.time() * 1000)
        self.assertEqual(self.boot(now), now, "no file yet: the boot time, as before")
        heard = max(srv.broadcast_update() for _ in range(5))
        day = 86_400_000
        self.assertGreater(self.boot(now - day), heard)
        self.assertGreater(srv.broadcast_update(), heard)
        # A clock that is right, a day on: its own time again.
        self.assertEqual(self.boot(now + day), now + day)
        kept = json.loads((self.backups / srv.CHANGE_NAME).read_text("utf-8"))
        self.assertEqual(kept, {"next": now + day + srv.CHANGE_RESERVE})

    def test_numbers_past_the_reserve_are_reserved_before_they_are_given(self):
        with mock.patch.object(srv, "CHANGE_RESERVE", 3):
            start = self.boot(1_000)
            given = [srv.broadcast_update() for _ in range(7)]
            kept = json.loads((self.backups / srv.CHANGE_NAME).read_text("utf-8"))["next"]
        self.assertEqual(given, list(range(start + 1, start + 8)))
        self.assertGreater(kept, given[-1])

    def test_the_number_is_kept_through_done_with_mission_and_a_restore(self):
        self.boot(5_000)
        srv.DATA_STORE["workspaces"]["ALPHA"] = [report()]
        with mock.patch.object(srv, "safe_print"):
            name, _ = srv.finish_mission("server")
        self.assertTrue((self.backups / srv.CHANGE_NAME).is_file(), "left where it is")
        archived = self.tmp / srv.MISSION_ARCHIVE_NAME / name
        self.assertFalse((archived / srv.CHANGE_NAME).exists())
        self.assertNotIn(
            srv.CHANGE_NAME, [os.path.basename(p) for p in srv.backup_files(str(self.backups))]
        )
        self.assertEqual(srv.mission_archives()[0]["name"], name)


class TerrainWorkerTests(unittest.TestCase):
    def setUp(self):
        self.src = {"sig": "dem1", "kind": "wms", "units": "m"}

        def fresh():
            with srv.terrain_lock:
                for kept in (
                    srv.TERRAIN_CACHE,
                    srv._terrain_inflight,
                    srv._terrain_failed,
                    srv._terrain_error,
                    srv._terrain_down,
                ):
                    kept.clear()

        fresh()
        self.addCleanup(fresh)
        patcher = mock.patch.object(srv, "_terrain_save_soon")  # nothing written to disk
        patcher.start()
        self.addCleanup(patcher.stop)

    def fetch(self, key, answer):
        """Fetch one queued point, the source saying ``answer`` (or raising
        it); how many times the source was asked."""
        with srv.terrain_lock:
            srv._terrain_inflight.add(key)
        asked = (
            mock.Mock(side_effect=answer)
            if isinstance(answer, BaseException)
            else mock.Mock(return_value=answer)
        )
        with mock.patch.object(srv, "elevation_at", asked):
            srv._terrain_fetch(self.src, key, 44.0, 33.0)
        self.assertNotIn(key, srv._terrain_inflight, "it always leaves the ones in flight")
        return asked.call_count

    def test_a_reply_that_cannot_be_read_still_ends_the_point(self):
        # Regression: an error elevation_at doesn't catch (a zlib bomb's
        # MemoryError, a deep reply's RecursionError) left the point pending for good.
        for exc in (MemoryError(), RecursionError("too deep")):
            self.fetch(f"dem1|{type(exc).__name__}", exc)
            self.assertIn(f"dem1|{type(exc).__name__}", srv._terrain_failed)
            self.assertIn(type(exc).__name__, srv._terrain_error["dem1"])
            self.assertEqual(srv.TERRAIN_CACHE, {})
            srv._terrain_down.clear()

    def test_queued_points_fail_at_once_while_the_source_is_down(self):
        # Regression: each point waited out the timeout, so 500 points on an
        # unreachable source took half an hour, and a stop waited for them all.
        down = (None, "the service answered 502")
        self.assertEqual(self.fetch("dem1|a", down), 1)
        self.assertEqual(self.fetch("dem1|b", down), 0, "not asked: failed at once")
        self.assertIn("dem1|b", srv._terrain_failed)
        self.assertEqual(srv._terrain_error["dem1"], "the service answered 502")
        srv._terrain_down["dem1"] -= srv.TERRAIN_DOWN_SECONDS  # a while later
        self.assertEqual(self.fetch("dem1|c", (612.5, "")), 1)
        self.assertEqual(srv.TERRAIN_CACHE["dem1|c"], 612.5)
        self.assertNotIn("dem1", srv._terrain_error)
        # A point the source has no height for says nothing of the others.
        self.assertEqual(self.fetch("dem1|d", (None, srv._NO_HEIGHT)), 1)
        self.assertEqual(self.fetch("dem1|e", (None, srv._NO_HEIGHT)), 1)

    def test_the_oldest_heights_and_failures_make_way(self):
        # Regression: past the cap, new heights were fetched again on every
        # ask, and failures were kept without end.
        with (
            mock.patch.object(srv, "TERRAIN_MAX_ENTRIES", 2),
            mock.patch.object(srv, "TERRAIN_FAILED_KEPT", 2),
        ):
            for k in "abc":
                self.fetch(f"dem1|{k}", (100.0, ""))
            for k in "def":
                self.fetch(f"dem1|{k}", (None, srv._NO_HEIGHT))
        self.assertEqual(list(srv.TERRAIN_CACHE), ["dem1|b", "dem1|c"])
        self.assertEqual(list(srv._terrain_failed), ["dem1|e", "dem1|f"])

    def test_a_stop_drops_the_points_still_queued(self):
        import concurrent.futures

        pool = concurrent.futures.ThreadPoolExecutor(1)
        gate = threading.Event()
        pool.submit(gate.wait, 5)
        queued = pool.submit(lambda: None)
        with mock.patch.object(srv, "_terrain_pool", pool):
            srv.stop_terrain()
            gate.set()
            self.assertTrue(queued.cancelled())
            # An ask that comes in after it is answered, not refused.
            with (
                mock.patch.object(srv, "terrain_source", return_value=self.src),
                mock.patch.object(srv, "_terrain_load"),
            ):
                body = srv.elevations([[44.0, 33.0]])
        self.assertEqual((body["heights"], body["pending"], body["unknown"]), ([None], [], [0]))
        pool.shutdown()

    def test_a_tile_cannot_unpack_past_its_own_size(self):
        import struct

        def chunk(k, d):
            return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d))

        def png(width, height, data):
            return (
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(data))
                + chunk(b"IEND", b"")
            )

        # A 2x1 tile whose data would unpack to 20 MB: only its 9 bytes are.
        bomb = png(2, 1, bytes([0, 1, 2, 3, 255, 0, 0, 0, 0]) + bytes(20_000_000))
        self.assertLess(len(bomb), 100_000)
        width, height, at = srv._png_reader(bomb)
        self.assertEqual((width, height, at(0, 0)), (2, 1, (1, 2, 3, 255)))
        with self.assertRaisesRegex(ValueError, "100000 by 100000 pixels"):
            srv._png_reader(png(100_000, 100_000, b""))

    def test_a_wms_reply_that_is_not_http_says_so(self):
        # http:// to an https:// port: the reply isn't HTTP at all.
        bad = http.client.BadStatusLine("\x15\x03\x01\x00\x02\x02")
        with mock.patch.object(srv.urllib.request, "urlopen", side_effect=bad):
            self.assertEqual(
                srv.wms_fetch("http://10.0.0.5:443/wms"),
                {"error": "the reply was not HTTP (BadStatusLine)"},
            )


class AuditLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = own_folder(self)
        for name, value in (("BACKUP_DIR", str(self.tmp)), ("_audit_failed", False)):
            patcher = mock.patch.object(srv, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_it_never_stops_a_request_and_says_when_it_works_again(self):
        # Regression: anything but an OSError (a character a file can't
        # hold) went up through the request, which was then never answered.
        with (
            mock.patch.object(srv.os, "makedirs", side_effect=ValueError("odd")),
            mock.patch.object(srv, "safe_print") as printed,
        ):
            srv.audit("AB@10.0.0.12", "save_reports ALPHA: 1 report(s)")
            srv.audit("AB@10.0.0.12", "save_reports ALPHA: 1 report(s)")
        self.assertEqual(
            [c.args[0] for c in printed.call_args_list],
            [f"[!] Could not write {srv.AUDIT_LOG_NAME}: odd"],
        )
        with mock.patch.object(srv, "safe_print") as printed:
            srv.audit("AB@10.0.0.12", "save_config ALPHA / Patrol \ud83d")
            srv.audit("AB@10.0.0.12", "save_config ALPHA / Patrol")
        self.assertEqual(
            [c.args[0] for c in printed.call_args_list],
            [f"[+] {srv.AUDIT_LOG_NAME} is being written again."],
        )
        lines = (self.tmp / srv.AUDIT_LOG_NAME).read_text("utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].endswith("save_config ALPHA / Patrol ?"), lines[0])


class ServerLogTests(unittest.TestCase):
    LINE = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ  "

    def setUp(self):
        self.tmp = own_folder(self)
        self.path = self.tmp / srv.LOG_DIR_NAME / srv.LOG_NAME
        self.addCleanup(srv.stop_log)

    def test_every_console_line_goes_to_the_log_with_its_utc_time(self):
        self.assertTrue(srv.start_log(str(self.path)))
        with mock.patch("builtins.print") as console:
            srv.safe_print("[*] Connected (1): AB at this computer")
        console.assert_called_once_with("[*] Connected (1): AB at this computer", flush=True)
        srv.stop_log()
        self.assertRegex(
            self.path.read_text("utf-8"),
            rf"^{self.LINE}\[\*\] Connected \(1\): AB at this computer\n$",
        )

    def test_errors_go_to_the_log_in_full(self):
        hooks = (threading.excepthook, sys.excepthook)
        self.assertTrue(srv.start_log(str(self.path)))
        httpd = srv.SaltSyncServer(("127.0.0.1", 0), srv.SaltSyncHandler)
        try:
            with mock.patch("builtins.print") as console:
                try:
                    raise KeyError("boom")
                except KeyError:
                    httpd.handle_error(None, ("203.0.113.9", 1))
        finally:
            httpd.server_close()
        self.assertEqual(len(console.call_args_list), 1, "the console as before: one line")
        with mock.patch("sys.stderr", io.StringIO()) as stderr:
            worker = threading.Thread(target=lambda: 1 / 0, name="Timer-7")
            worker.start()
            worker.join()
        self.assertIn("ZeroDivisionError", stderr.getvalue(), "the console as before")
        srv.stop_log()
        self.assertEqual((threading.excepthook, sys.excepthook), hooks, "put back")
        text = self.path.read_text("utf-8")
        self.assertRegex(text, rf"{self.LINE}\[!\] Error handling a request from 203\.0\.113\.9")
        self.assertIn("Traceback (most recent call last)", text)
        self.assertIn("KeyError: 'boom'", text)
        self.assertRegex(text, rf"{self.LINE}\[!\] Error in Timer-7:\nTraceback")
        self.assertIn("ZeroDivisionError: division by zero", text)

    def test_a_log_that_cannot_be_opened_leaves_the_console_alone(self):
        (self.tmp / "E").write_text("not a folder", encoding="utf-8")
        hooks = (threading.excepthook, sys.excepthook)
        self.assertFalse(srv.start_log(str(self.tmp / "E" / srv.LOG_DIR_NAME / srv.LOG_NAME)))
        self.assertEqual((threading.excepthook, sys.excepthook), hooks)
        with mock.patch("builtins.print") as console:
            srv.safe_print("[*] Still here.")
        console.assert_called_once_with("[*] Still here.", flush=True)

    def test_the_log_is_beside_the_backups_where_nothing_moves_it(self):
        # Done with Mission moves what is in the backup folder, and Windows
        # can't move a file held open.
        with mock.patch.object(srv, "BACKUP_DIR", str(self.tmp / "Auto Backups")):
            path = Path(srv.server_log_path())
            self.assertEqual(path, self.tmp / srv.LOG_DIR_NAME / srv.LOG_NAME)
            self.assertNotEqual(path.parent, Path(srv.mission_archive_dir()))


# What the server wrote and served for every_setting_saved in 2.21.0, before
# SHARED_SECTIONS and the route table: they must not change by a byte, but
# for the sections added since, at the end: the tags (2.31.0, written empty)
# and FMV mode (2.32.0). Shared
# settings.json is the same values as /api/sync, indented (see the test).
EVERY_SETTING_SAVED = {
    "ALPHA_Patrol.txt": (
        "========================================================================\n"
        " S.A.L.T. REPORT WORKBENCH: AUTO BACKUP (SESSION)\n"
        " ATO Designator : ALPHA\n"
        " Report Title   : Patrol\n"
        " Total Reports  : 1\n"
        " Exported       : -\n"
        "========================================================================\n"
        "\n"
        "------------------------------------------------------------------------\n"
        " REPORT ALPHA001\n"
        "------------------------------------------------------------------------\n"
        " ATO      : ALPHA\n"
        " Size     : 2x T-72\n"
        " Activity : Stationary\n"
        " Location : 18SUJ2337106519\n"
        " Time     : 2026-01-15T14:30:00Z\n"
        " Wx : Rain\n"
        " By       : AB\n"
        "\n"
        "========================================================================\n"
        " MACHINE DATA: DO NOT EDIT BELOW THIS LINE\n"
        "========================================================================\n"
        "##SALT_BACKUP##\n"
        "{\"workspaces\":{\"ALPHA\":[{\"id\":\"r1\",\"displayId\":\"ALPHA001\",\"ato\":\"ALPHA\",\"title\":\"Pat"
        "rol\",\"size\":\"2x T-72\",\"activity\":\"Stationary\",\"location\":\"18SUJ2337106519\",\"time\":\"2"
        "026-01-15T14:30:00Z\",\"lastModified\":1,\"custom\":{\"Wx\":\"Rain\"},\"user\":{\"initials\":\"AB\""
        ",\"color\":\"#32d74b\"}}]},\"config\":{\"ato\":\"ALPHA\",\"title\":\"Patrol\"},\"profiles\":{\"AB\":{\""
        "initials\":\"AB\",\"color\":\"#32d74b\"}},\"formats\":{\"ALPHA\":{\"preset\":\"salt\",\"lines\":[{\"ty"
        "pe\":\"id\"},{\"type\":\"custom\",\"label\":\"Wx\"}]}},\"overlays\":[{\"type\":\"NAI\",\"name\":\"1\",\"la"
        "bel\":\"NAI 1 (bridge)\",\"geometry\":{\"type\":\"Polygon\",\"coordinates\":[[[44.35,33.25],[44"
        ".46,33.25],[44.46,33.34],[44.35,33.34],[44.35,33.25]]]}},{\"type\":\"PL\",\"name\":\"BLUE\","
        "\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[44.35,33.3],[44.57,33.3]]}}],\"basema"
        "ps\":[{\"name\":\"Topo\",\"kind\":\"wms\",\"url\":\"http://10.0.0.5/wms\",\"layers\":\"0,1\",\"version"
        "\":\"1.3.0\",\"crs\":\"EPSG:4326\",\"format\":\"image/png\"},{\"name\":\"OSM\",\"kind\":\"tiles\",\"url\""
        ":\"http://10.0.0.5/t\"}],\"drones\":[{\"name\":\"Raven\",\"grid\":\"11S NV 39697 06762\",\"at\":17"
        "61600000000,\"look\":\"11S NV 40000 07000\",\"range\":5},{\"name\":\"Puma\",\"grid\":\"11S NV 1 2"
        "\",\"at\":1}],\"narrative\":{\"enemy\":\"OPFOR\",\"units\":[{\"name\":\"1st Tank\",\"places\":[\"Hill "
        "1\"],\"kinds\":[\"armor\"]}],\"equipment\":[{\"type\":\"T-90M\",\"role\":\"armor\",\"origin\":\"RU\"}],"
        "\"off\":[\"axes\",\"deep\"],\"custom\":[{\"what\":\"Bridge\",\"words\":\"bridge, crossing\",\"min\":2,"
        "\"hours\":6}]},\"tags\":[],\"fmv\":{\"on\":true}}\n"
        "##SALT_BACKUP_END##\n"
    ),
    "BRAVO_Screen.txt": (
        "========================================================================\n"
        " S.A.L.T. REPORT WORKBENCH: AUTO BACKUP (SESSION)\n"
        " ATO Designator : BRAVO\n"
        " Report Title   : Screen\n"
        " Total Reports  : 1\n"
        " Exported       : -\n"
        "========================================================================\n"
        "\n"
        "------------------------------------------------------------------------\n"
        " REPORT BRAVO001\n"
        "------------------------------------------------------------------------\n"
        " ATO      : BRAVO\n"
        " Size     : 2x T-72\n"
        " Activity : Stationary\n"
        " Location : 18SUJ2337106519\n"
        " Time     : 2026-01-15T14:30:00Z\n"
        " By       : AB\n"
        "\n"
        "========================================================================\n"
        " MACHINE DATA: DO NOT EDIT BELOW THIS LINE\n"
        "========================================================================\n"
        "##SALT_BACKUP##\n"
        "{\"workspaces\":{\"BRAVO\":[{\"id\":\"b1\",\"displayId\":\"BRAVO001\",\"ato\":\"BRAVO\",\"title\":\"Scr"
        "een\",\"size\":\"2x T-72\",\"activity\":\"Stationary\",\"location\":\"18SUJ2337106519\",\"time\":\"2"
        "026-01-15T14:30:00Z\",\"lastModified\":1,\"user\":{\"initials\":\"AB\",\"color\":\"#32d74b\"}}]},"
        "\"config\":{\"ato\":\"ALPHA\",\"title\":\"Patrol\"},\"profiles\":{\"AB\":{\"initials\":\"AB\",\"color\":"
        "\"#32d74b\"}},\"formats\":{\"BRAVO\":{\"preset\":\"salt\",\"lines\":[{\"type\":\"id\"},{\"type\":\"cust"
        "om\",\"label\":\"Wx\"}]}},\"overlays\":[{\"type\":\"NAI\",\"name\":\"1\",\"label\":\"NAI 1 (bridge)\",\""
        "geometry\":{\"type\":\"Polygon\",\"coordinates\":[[[44.35,33.25],[44.46,33.25],[44.46,33.34"
        "],[44.35,33.34],[44.35,33.25]]]}},{\"type\":\"PL\",\"name\":\"BLUE\",\"geometry\":{\"type\":\"Lin"
        "eString\",\"coordinates\":[[44.35,33.3],[44.57,33.3]]}}],\"basemaps\":[{\"name\":\"Topo\",\"ki"
        "nd\":\"wms\",\"url\":\"http://10.0.0.5/wms\",\"layers\":\"0,1\",\"version\":\"1.3.0\",\"crs\":\"EPSG:4"
        "326\",\"format\":\"image/png\"},{\"name\":\"OSM\",\"kind\":\"tiles\",\"url\":\"http://10.0.0.5/t\"}],"
        "\"drones\":[{\"name\":\"Raven\",\"grid\":\"11S NV 39697 06762\",\"at\":1761600000000,\"look\":\"11S"
        " NV 40000 07000\",\"range\":5},{\"name\":\"Puma\",\"grid\":\"11S NV 1 2\",\"at\":1}],\"narrative\":"
        "{\"enemy\":\"OPFOR\",\"units\":[{\"name\":\"1st Tank\",\"places\":[\"Hill 1\"],\"kinds\":[\"armor\"]}]"
        ",\"equipment\":[{\"type\":\"T-90M\",\"role\":\"armor\",\"origin\":\"RU\"}],\"off\":[\"axes\",\"deep\"],\""
        "custom\":[{\"what\":\"Bridge\",\"words\":\"bridge, crossing\",\"min\":2,\"hours\":6}]},\"tags\":[],\"fmv\":{\"on\":true}}\n"
        "##SALT_BACKUP_END##\n"
    ),
    "audit": (
        "save_profile AB\n"
        "save_config ALPHA / Patrol\n"
        "save_reports ALPHA: 1 report(s)\n"
        "save_reports BRAVO: 1 report(s)\n"
        "save_format\n"
        "save_overlays: 2 overlay(s)\n"
        "save_basemaps: 2 service(s)\n"
        "save_drones: 2 drone(s)\n"
        "save_narrative: 1 unit(s), 1 type(s), 1 rule(s)\n"
        "save_fmv: on"
    ),
    "sync": (
        "{\"workspaces\":{\"ALPHA\":[{\"id\":\"r1\",\"displayId\":\"ALPHA001\",\"ato\":\"ALPHA\",\"title\":\"Pat"
        "rol\",\"size\":\"2x T-72\",\"activity\":\"Stationary\",\"location\":\"18SUJ2337106519\",\"time\":\"2"
        "026-01-15T14:30:00Z\",\"lastModified\":1,\"custom\":{\"Wx\":\"Rain\"},\"user\":{\"initials\":\"AB\""
        ",\"color\":\"#32d74b\"}}],\"BRAVO\":[{\"id\":\"b1\",\"displayId\":\"BRAVO001\",\"ato\":\"BRAVO\",\"titl"
        "e\":\"Screen\",\"size\":\"2x T-72\",\"activity\":\"Stationary\",\"location\":\"18SUJ2337106519\",\"t"
        "ime\":\"2026-01-15T14:30:00Z\",\"lastModified\":1,\"user\":{\"initials\":\"AB\",\"color\":\"#32d74"
        "b\"}}]},\"config\":{\"ato\":\"ALPHA\",\"title\":\"Patrol\"},\"profiles\":{\"AB\":{\"initials\":\"AB\",\""
        "color\":\"#32d74b\"}},\"format\":{\"preset\":\"salt\",\"lines\":[{\"type\":\"id\"},{\"type\":\"custom\""
        ",\"label\":\"Wx\"}]},\"overlays\":[{\"type\":\"NAI\",\"name\":\"1\",\"label\":\"NAI 1 (bridge)\",\"geom"
        "etry\":{\"type\":\"Polygon\",\"coordinates\":[[[44.35,33.25],[44.46,33.25],[44.46,33.34],[4"
        "4.35,33.34],[44.35,33.25]]]}},{\"type\":\"PL\",\"name\":\"BLUE\",\"geometry\":{\"type\":\"LineStr"
        "ing\",\"coordinates\":[[44.35,33.3],[44.57,33.3]]}}],\"basemaps\":[{\"name\":\"Topo\",\"kind\":"
        "\"wms\",\"url\":\"http://10.0.0.5/wms\",\"layers\":\"0,1\",\"version\":\"1.3.0\",\"crs\":\"EPSG:4326\""
        ",\"format\":\"image/png\"},{\"name\":\"OSM\",\"kind\":\"tiles\",\"url\":\"http://10.0.0.5/t\"}],\"dro"
        "nes\":[{\"name\":\"Raven\",\"grid\":\"11S NV 39697 06762\",\"at\":1761600000000,\"look\":\"11S NV "
        "40000 07000\",\"range\":5},{\"name\":\"Puma\",\"grid\":\"11S NV 1 2\",\"at\":1}],\"narrative\":{\"en"
        "emy\":\"OPFOR\",\"units\":[{\"name\":\"1st Tank\",\"places\":[\"Hill 1\"],\"kinds\":[\"armor\"]}],\"eq"
        "uipment\":[{\"type\":\"T-90M\",\"role\":\"armor\",\"origin\":\"RU\"}],\"off\":[\"axes\",\"deep\"],\"cust"
        "om\":[{\"what\":\"Bridge\",\"words\":\"bridge, crossing\",\"min\":2,\"hours\":6}]},\"tags\":[],\"fmv\":{\"on\":true},\"sources\":{\"AL"
        "PHA\":\"In-session\",\"BRAVO\":\"In-session\"},\"unloaded\":[],\"mission\":\"\","
        "\"missions_finished\":[]"
    ),
}


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
                self.last_type = resp.headers.get("Content-Type")
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            with exc:  # an error response is still an open connection
                self.last_type = exc.headers.get("Content-Type")
                return exc.code, exc.read()

    def refused(self, expected, path, body=None, **kw):
        """Ask, and check the answer is the one /api refusal: the expected
        status, as JSON, {"status": "error", "message": <a sentence>}."""
        status, raw = self.request(path, body, **kw)
        why = f"{path} {body!r}"
        self.assertEqual(status, expected, why)
        self.assertEqual(self.last_type, "application/json", why)
        reply = json.loads(raw)
        self.assertEqual(set(reply), {"status", "message"}, why)
        self.assertEqual(reply["status"], "error", why)
        self.assertRegex(reply["message"], r"^[A-Z].*\.$", why)
        return reply["message"]

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
        self.assertEqual(
            (status, body["message"]),
            (400, f"Validation failed: ato must be a non-empty string ≤{srv.MAX_ATO_LEN} chars."),
        )
        status, body = self.post(
            "/api/edit_report", {"ato": "ALPHA", "reportId": "ghost", "fields": {"size": "x"}}
        )
        self.assertEqual((status, body["message"]), (404, "Report not found."))

    def test_numbers_json_cannot_carry_are_refused(self):
        # Regression: Python reads NaN and Infinity (and 1e999 as Infinity) in
        # a field no validator checks; stored, they went out in /api/sync as
        # words JSON.parse refuses, so no page could pull again.
        good = json.dumps({"ato": "ALPHA", "reports": [report(extra=1)]})
        for word in ("NaN", "Infinity", "-Infinity", "1e999", "-1E400"):
            raw = good.replace('"extra": 1', f'"extra": {word}').encode()
            self.assertIn(word.encode(), raw)
            message = self.refused(400, "/api/save_reports", raw=raw)
            self.assertEqual(message, "Invalid JSON: a number is NaN, Infinity or too large.")
        status, raw = self.request("/api/sync")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["workspaces"], {}, "nothing got through")
        # Large but finite numbers, and the same body with an ordinary one, are fine.
        raw = good.replace('"extra": 1', '"extra": 1.5e300').encode()
        self.assertEqual(self.request("/api/save_reports", raw=raw)[0], 200)
        self.assertEqual(self.sync()["workspaces"]["ALPHA"][0]["extra"], 1.5e300)

    # -- one refusal shape ---------------------------------------------------- #
    def test_every_refusal_of_a_request_is_the_one_json_shape(self):
        config = {"config": {"ato": "A", "title": "T"}}
        self.refused(400, "/api/save_config", raw=b"{not json")
        self.refused(400, "/api/save_config", ["a", "list"])
        self.refused(400, "/api/save_config", raw=b"{}", headers={"Content-Length": "abc"})
        self.refused(415, "/api/save_config", raw=b"{}", headers={"Content-Type": "text/plain"})
        self.refused(403, "/api/save_config", config, headers={"Sec-Fetch-Site": "cross-site"})
        self.refused(405, "/api/save_config", config, base=self.viewer_base)
        self.assertEqual(self.refused(404, "/api/nope", {}), "Not found.")
        self.assertEqual(self.refused(404, "/api/nope"), "Not found.")
        with mock.patch.object(srv, "MAX_BODY_BYTES", 8):
            self.refused(413, "/api/save_config", config)

    def test_a_page_that_isnt_there_is_still_an_html_404(self):
        status, _ = self.request("/nowhere", code=None)
        self.assertEqual(status, 404)
        self.assertTrue(self.last_type.startswith("text/html"), self.last_type)

    def test_requests_missing_what_a_route_needs_are_refused_by_its_validator(self):
        # Each check used to sit in its route, with its own wording.
        for path, body in (
            ("/api/save_reports", {"ato": "   ", "reports": [report()]}),
            ("/api/save_reports", {"reports": [report()]}),
            ("/api/unload_ato", {"ato": " "}),
            ("/api/edit_report", {"ato": "ALPHA", "reportId": "r1", "fields": {}}),
            ("/api/edit_report", {"ato": "ALPHA", "fields": {"size": "x"}}),
            ("/api/delete_history", {"ato": "ALPHA", "deletions": []}),
            ("/api/delete_history", {"ato": "ALPHA"}),
            ("/api/save_profile", {"profile": {"initials": "  ", "color": "#32d74b"}}),
            # Refresh needs nothing sent: it reads the backup folder.
            *(
                (r.path, {})
                for r in self.post_routes()
                if r.path not in ("/api/save_config", "/api/refresh")
            ),
        ):
            message = self.refused(400, path, body)
            self.assertTrue(message.startswith("Validation failed: "), message)
        self.assertEqual(self.sync()["workspaces"], {}, "nothing got through")

    # -- the route table ----------------------------------------------------- #
    @staticmethod
    def post_routes():
        return [r for r in srv.ROUTES if r.method == "POST"]

    # -- Heights for the narrative ------------------------------------------- #
    @staticmethod
    def fresh_terrain():
        """No heights kept, in memory or on disk, and nothing failed lately."""
        with srv.terrain_lock:
            srv.TERRAIN_CACHE.clear()
            srv._terrain_loaded_from = None
            srv._terrain_failed.clear()
            srv._terrain_error.clear()
            srv._terrain_down.clear()
            srv._terrain_tiles.clear()
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(srv.BACKUP_DIR, srv.TERRAIN_NAME))

    def fake_dem(self, answer):
        """A WMS whose GetFeatureInfo says ``answer(lon, lat)`` for the middle
        of the box asked, as GeoServer's text/plain does; its address, and
        the list of the points it was asked."""
        import http.server as hs

        asked = []

        class Fake(hs.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
                if q.get("REQUEST") != "GetFeatureInfo" or q.get("INFO_FORMAT") != "text/plain":
                    body = b"<ServiceException>unsupported</ServiceException>"
                else:
                    s, w, n, e = (float(v) for v in q["BBOX"].split(","))  # 1.3.0 EPSG:4326
                    lon, lat = round((w + e) / 2, 5), round((s + n) / 2, 5)
                    asked.append((lon, lat))
                    body = f"Results for FeatureType 'dem':\nGRAY_INDEX = {answer(lon, lat)}\n".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        fake = hs.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        self.addCleanup(fake.server_close)
        self.addCleanup(fake.shutdown)
        return f"http://127.0.0.1:{fake.server_port}/wms?map=dem", asked

    def test_heights_come_from_the_narratives_source_once_and_are_kept_for_everyone(self):
        self.fresh_terrain()
        self.addCleanup(self.fresh_terrain)
        url, asked = self.fake_dem(lambda lon, lat: -32768 if lon > 45 else round(lon * 10, 1))
        pts = [[44.0, 33.0], [44.5, 33.1], [46.0, 33.0]]
        # No source: no heights, and nothing asked.
        _, body = self.post("/api/elevation", {"points": pts})
        self.assertEqual((body["source"], body["heights"], body["pending"]), ("", [None] * 3, []))
        dem = {
            "name": "DEM",
            "kind": "wms",
            "url": url,
            "layers": "dem,hillshade",
            "version": "1.3.0",
            "crs": "EPSG:4326",
        }
        self.assertEqual(self.post("/api/save_basemaps", {"basemaps": [dem]})[0], 200)
        terrain = {"basemap": "DEM", "layer": "", "encoding": "", "units": "ft"}
        self.assertEqual(
            self.post("/api/save_narrative", {"narrative": {"terrain": terrain}})[0], 200
        )
        self.assertEqual(self.sync()["narrative"]["terrain"], terrain)
        # In feet, given in meters; past the lowest land, no data (kept as such).
        _, body = self.post("/api/elevation", {"points": pts})
        self.assertEqual(body["heights"], [round(440 * 0.3048, 1), round(445 * 0.3048, 1), None])
        self.assertEqual((body["pending"], body["unknown"], body["error"]), ([], [], ""))
        self.assertEqual(len(asked), 3)
        # Asked once: the next ask, a viewer's too, is answered from what is kept.
        _, again = self.post("/api/elevation", {"points": pts}, base=self.viewer_base, code=None)
        self.assertEqual(again["heights"], body["heights"])
        self.assertEqual(len(asked), 3)
        # Kept on disk, beside the backups, and read back.
        srv.flush_terrain()
        kept = json.loads((Path(srv.BACKUP_DIR) / srv.TERRAIN_NAME).read_text("utf-8"))
        self.assertEqual(sorted(v is None for v in kept.values()), [False, False, True])
        with srv.terrain_lock:
            srv.TERRAIN_CACHE.clear()
            srv._terrain_loaded_from = None
        self.assertEqual(
            self.post("/api/elevation", {"points": pts})[1]["heights"], body["heights"]
        )
        self.assertEqual(len(asked), 3)
        # Another source starts afresh.
        terrain["units"] = "m"
        self.post("/api/save_narrative", {"narrative": {"terrain": terrain}})
        self.assertEqual(self.post("/api/elevation", {"points": pts[:1]})[1]["heights"], [440.0])
        self.assertEqual(len(asked), 4)

    def test_a_source_that_fails_says_why_and_is_not_asked_again_at_once(self):
        self.fresh_terrain()
        self.addCleanup(self.fresh_terrain)
        dem = {"name": "DEM", "kind": "wms", "url": "http://127.0.0.1:1/wms", "layers": "dem"}
        self.post("/api/save_basemaps", {"basemaps": [dem]})
        self.post("/api/save_narrative", {"narrative": {"terrain": {"basemap": "DEM"}}})
        _, body = self.post("/api/elevation", {"points": [[44.0, 33.0]]})
        self.assertEqual((body["heights"], body["pending"], body["unknown"]), ([None], [], [0]))
        self.assertIn("502", body["error"])
        self.assertIn(next(iter(srv._terrain_failed)), srv._terrain_failed)
        self.assertEqual(srv.TERRAIN_CACHE, {}, "a failure isn't kept as no data")

    def test_heights_from_elevation_tiles(self):
        import http.server as hs
        import struct
        import zlib

        # One 2x1 tile: Terrarium 512.5 m, then a transparent pixel (no data).
        r, g, b = divmod(512 + 32768, 256)[0], (512 + 32768) % 256, 128
        raw = bytes([0, r, g, b, 255, 0, 0, 0, 0])

        def chunk(k, d):
            return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d))

        png = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b"")
        )

        class Fake(hs.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(png)))
                self.end_headers()
                self.wfile.write(png)

        fake = hs.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        self.addCleanup(fake.server_close)
        self.addCleanup(fake.shutdown)
        self.fresh_terrain()
        self.addCleanup(self.fresh_terrain)
        tiles = {
            "name": "DEM tiles",
            "kind": "tiles",
            "url": f"http://127.0.0.1:{fake.server_port}/{{z}}/{{x}}/{{y}}.png",
        }
        self.post("/api/save_basemaps", {"basemaps": [tiles]})
        terrain = {"basemap": "DEM tiles", "encoding": "terrarium"}
        self.post("/api/save_narrative", {"narrative": {"terrain": terrain}})
        # Two points in one tile at zoom 14: its left half and its right.
        n = 2**srv.TERRAIN_TILE_ZOOM
        left = [(100 + 0.25) / n * 360 - 180, 0.0001]
        right = [(100 + 0.75) / n * 360 - 180, 0.0001]
        _, body = self.post("/api/elevation", {"points": [left, right]})
        self.assertEqual(body["heights"], [512.5, None])
        self.assertEqual(
            srv.elevation_at({**srv.terrain_source(), "encoding": "terrain-rgb"}, *left)[0],
            None,
            "the same pixel read as Terrain-RGB is far off the ground: no data",
        )

    def test_test_as_elevation_shows_the_height_and_the_reply(self):
        self.fresh_terrain()
        self.addCleanup(self.fresh_terrain)
        url, _ = self.fake_dem(lambda lon, lat: 612.5)
        dem = {
            "name": "DEM",
            "kind": "wms",
            "url": url,
            "layers": "dem",
            "version": "1.3.0",
            "crs": "EPSG:4326",
        }
        self.post("/api/save_basemaps", {"basemaps": [dem]})
        status, body = self.post(
            "/api/elevation_test", {"terrain": {"basemap": "DEM"}, "point": [44.0, 33.0]}
        )
        self.assertEqual((status, body["height"], body["error"]), (200, 612.5, ""))
        self.assertIn("GRAY_INDEX = 612.5", body["reply"])
        self.assertEqual(srv.TERRAIN_CACHE, {}, "a test isn't kept")
        status, body = self.post(
            "/api/elevation_test", {"terrain": {"basemap": "Nope"}, "point": [44.0, 33.0]}
        )
        self.assertEqual(status, 400)
        status, _ = self.post(
            "/api/elevation_test",
            {"terrain": {"basemap": "DEM"}, "point": [44.0, 33.0]},
            base=self.viewer_base,
        )
        self.assertEqual(status, 405, "editors only")

    # -- Done with Mission ---------------------------------------------------- #
    def a_mission(self):
        """A mission under way: ALPHA with two reports, an overlay, a basemap,
        a profile and the certificate folder, all on disk."""
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        shutil.rmtree(srv.mission_archive_dir(), ignore_errors=True)
        srv.mission.update(id="m1", since=1, finished=[])
        tls = Path(srv.BACKUP_DIR) / "tls"
        tls.mkdir(parents=True)
        (tls / "server.pem").write_text("certificate", "utf-8")
        (Path(srv.BACKUP_DIR) / srv.TERRAIN_NAME).write_text("{}", "utf-8")
        reps = [report("a1", "ALPHA001"), report("a2", "ALPHA002")]
        for path, body in (
            ("/api/save_reports", {"ato": "ALPHA", "reports": reps}),
            ("/api/save_overlays", {"overlays": [NAI1], "tagged": True}),
            ("/api/save_basemaps", {"basemaps": [TOPO]}),
            ("/api/save_profile", {"profile": {"initials": "AB", "color": "#ff0000"}}),
        ):
            self.assertEqual(self.post(path, body)[0], 200, path)
        srv.flush_pending_save()

    def finish(self):
        status, body = self.post("/api/finish_mission", {"confirm": "DONE"})
        self.assertEqual(status, 200, body)
        return body["archive"]

    def test_done_with_mission_archives_everything_and_starts_again(self):
        self.a_mission()
        self.assertEqual(self.post("/api/finish_mission", {"confirm": "done"})[0], 400)
        self.assertEqual(
            self.post("/api/finish_mission", {"confirm": "DONE"}, base=self.viewer_base)[0], 405
        )
        name = self.finish()
        self.assertRegex(name, r"^\d{4}-\d\d-\d\d \d{4}Z Patrol$")
        archive = Path(srv.mission_archive_dir()) / name
        self.assertEqual(archive.parent.parent, Path(srv.BACKUP_DIR).parent, "beside the backups")
        # Everything but the certificate was moved, nothing deleted.
        moved = {f.name for f in archive.iterdir()}
        self.assertTrue(
            {"ALPHA_Patrol.txt", srv.SHARED_SETTINGS_NAME, srv.AUDIT_LOG_NAME} <= moved,
            moved,
        )
        self.assertIn("ALPHA002", (archive / "ALPHA_Patrol.txt").read_text("utf-8"))
        info = json.loads((archive / srv.MISSION_INFO_NAME).read_text("utf-8"))
        self.assertEqual(info["workspaces"], {"ALPHA": 2})
        self.assertEqual(info["settings"]["overlays"], 1)
        self.assertEqual(info["settings"]["profiles"], 1)
        self.assertEqual(info["title"], "Patrol")
        self.assertIn("finish_mission", (archive / srv.AUDIT_LOG_NAME).read_text("utf-8"))
        self.assertEqual(
            (Path(srv.BACKUP_DIR) / "tls" / "server.pem").read_text("utf-8"), "certificate"
        )
        self.assertTrue((Path(srv.BACKUP_DIR) / srv.TERRAIN_NAME).is_file(), "the heights stay")
        self.assertFalse(list(Path(srv.BACKUP_DIR).glob("*.txt")))
        # The next mission: nothing but the basemaps, under a new id.
        state = self.sync()
        self.assertEqual(state["workspaces"], {})
        self.assertEqual(state["overlays"], [])
        self.assertEqual(state["profiles"], {})
        self.assertEqual(state["basemaps"], [TOPO])
        self.assertNotIn(state["mission"], ("", "m1"))
        self.assertEqual(state["missions_finished"], ["m1"])
        self.assertEqual([e["what"] for e in state["activity"]], [f"finished the mission ({name})"])
        shared = json.loads((Path(srv.BACKUP_DIR) / srv.SHARED_SETTINGS_NAME).read_text("utf-8"))
        self.assertEqual(shared["mission"]["id"], state["mission"])
        self.assertEqual(shared["basemaps"], [TOPO])
        # A page still on the finished mission is told the new one; its
        # write is refused. One on the new mission, or from before missions, is taken.
        save = {"ato": "BRAVO", "reports": [report("b1", "BRAVO001", ato="BRAVO")]}
        status, body = self.post("/api/save_reports", save, headers={"X-Salt-Mission": "m1"})
        self.assertEqual((status, body["mission"]), (409, state["mission"]))
        self.assertNotIn("BRAVO", self.sync()["workspaces"])
        self.assertEqual(
            self.post("/api/save_reports", save, headers={"X-Salt-Mission": state["mission"]})[0],
            200,
        )
        self.assertEqual(self.post("/api/save_reports", save)[0], 200)
        # The same minute twice: a folder of its own.
        self.assertEqual(self.finish(), f"{name} (2)")

    def test_a_file_that_cannot_be_moved_resets_nothing(self):
        self.a_mission()
        real = os.replace

        def held_open(src, dst):
            if (
                os.path.basename(src) == srv.SHARED_SETTINGS_NAME
                and srv.MISSION_ARCHIVE_NAME in dst
            ):
                raise PermissionError("in use by another process")
            return real(src, dst)

        with mock.patch.object(srv.os, "replace", held_open):
            status, body = self.post("/api/finish_mission", {"confirm": "DONE"})
        self.assertEqual(status, 500)
        self.assertIn("Nothing was reset", body["message"])
        self.assertEqual(len(self.sync()["workspaces"]["ALPHA"]), 2)
        self.assertEqual(self.sync()["mission"], "m1")
        self.assertTrue((Path(srv.BACKUP_DIR) / "ALPHA_Patrol.txt").exists(), "put back")
        self.assertEqual(list(Path(srv.mission_archive_dir()).iterdir()), [], "its folder went")

    def test_previous_missions_are_listed_recalled_and_loaded(self):
        self.a_mission()
        name = self.finish()
        status, raw = self.request("/api/missions")
        listed = json.loads(raw)["missions"]
        self.assertEqual(status, 200)
        self.assertEqual([m["name"] for m in listed], [name])
        self.assertEqual(listed[0]["workspaces"], {"ALPHA": 2})
        self.assertEqual(listed[0]["settings"]["overlays"], 1)
        self.assertEqual(self.request("/api/missions", base=self.viewer_base)[0], 405)
        # Recall: the parts asked for that the mission has; the rest say why not.
        self.post("/api/save_overlays", {"overlays": [PL_BLUE], "tagged": True})
        status, body = self.post(
            "/api/recall_settings", {"mission": name, "parts": ["overlays", "profiles", "format"]}
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(body["taken"], ["overlays", "profiles"])
        self.assertEqual(body["missed"], {"format": "none in that mission"})
        state = self.sync()
        self.assertEqual(
            sorted(o["name"] for o in state["overlays"]), ["1", "BLUE"], "added to what is there"
        )
        self.assertEqual(state["profiles"]["AB"]["color"], "#ff0000")
        self.assertEqual(
            state["activity"][-1]["what"], f"recalled the overlays and profiles from {name}"
        )
        self.assertEqual(
            self.post("/api/recall_settings", {"mission": name, "parts": ["overlays"]})[1]["taken"],
            [],
        )
        for bad in ("../backups", "nothing", ""):
            self.assertIn(
                self.post("/api/recall_settings", {"mission": bad, "parts": ["tags"]})[0],
                (400, 404),
                bad,
            )
        self.assertEqual(
            self.post("/api/recall_settings", {"mission": name, "parts": ["bogus"]})[0], 400
        )
        # Load: its workspaces, merged, from the mission, and saved with this one.
        self.assertEqual(
            self.post("/api/load_mission", {"mission": name, "atos": ["ZULU"]})[0], 404
        )
        status, body = self.post("/api/load_mission", {"mission": name, "atos": ["alpha"]})
        self.assertEqual((status, body["loaded"]), (200, {"ALPHA": 2}))
        state = self.sync()
        self.assertEqual(len(state["workspaces"]["ALPHA"]), 2)
        self.assertEqual(state["sources"]["ALPHA"], f"Mission {name}")
        srv.flush_pending_save()
        self.assertTrue((Path(srv.BACKUP_DIR) / "ALPHA_Patrol.txt").exists())

    def test_a_mission_folder_put_there_by_hand_is_listed(self):
        shutil.rmtree(srv.mission_archive_dir(), ignore_errors=True)
        folder = Path(srv.mission_archive_dir()) / "Old exercise"
        folder.mkdir(parents=True)
        _, text = srv.render_backup({"BRAVO": [report("b1", "BRAVO001", ato="BRAVO")]}, {}, {}, {})
        (folder / "BRAVO_Patrol.txt").write_text(text, "utf-8")
        (Path(srv.mission_archive_dir()) / "empty").mkdir()
        listed = srv.mission_archives()
        self.assertEqual(
            [m["name"] for m in listed], ["Old exercise"], "a folder with no backups isn't"
        )
        self.assertEqual(listed[0]["workspaces"], {"BRAVO": 1})

    def test_a_server_with_no_mission_gets_one_and_keeps_it(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        srv.ensure_mission()
        first = srv.mission["id"]
        self.assertRegex(first, r"^[0-9a-f]{16}$")
        srv.mission.update(id="", since=0, finished=[])
        srv.load_data_from_disk()
        self.assertEqual(srv.mission["id"], first, "read back after a restart")
        srv.ensure_mission()
        self.assertEqual(srv.mission["id"], first)

    def test_refresh_reads_backups_dropped_in_since_the_server_started(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report("a1", "ALPHA001")]})
        srv.flush_pending_save()
        folder = Path(srv.BACKUP_DIR)
        # Its own files, as it wrote them: nothing new.
        status, body = self.post("/api/refresh", {})
        self.assertEqual((status, body["files"], body["workspaces"]), (200, [], {}))
        self.assertEqual(self.post("/api/refresh", {}, base=self.viewer_base)[0], 405)
        # A file dropped in: its workspace, with its file as the source, and
        # none of its shared settings.
        bravo = [report("b1", "BRAVO001", ato="BRAVO"), report("b2", "BRAVO002", ato="BRAVO")]
        _, text = srv.render_backup({"BRAVO": bravo}, {}, {}, {}, overlays=[NAI1])
        (folder / "BRAVO_Screen.txt").write_text(text, "utf-8")
        # ALPHA's own file, changed by hand: a newer version of its report.
        _, text = srv.render_backup(
            {"ALPHA": [report("a1", "ALPHA001", lm=5, size="9x T-72")]}, {}, {}, {}
        )
        (folder / "ALPHA_Patrol.txt").write_text(text, "utf-8")
        (folder / "broken.txt").write_text("not a backup", "utf-8")
        status, body = self.post("/api/refresh", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["files"], ["ALPHA_Patrol.txt", "BRAVO_Screen.txt", "broken.txt"])
        self.assertEqual(body["skipped"], 1)
        self.assertEqual(
            body["workspaces"],
            {"ALPHA": {"added": False, "changes": 1}, "BRAVO": {"added": True, "changes": 2}},
        )
        state = self.sync()
        self.assertEqual(len(state["workspaces"]["BRAVO"]), 2)
        self.assertEqual(state["workspaces"]["ALPHA"][0]["size"], "9x T-72")
        self.assertEqual(state["sources"]["BRAVO"], "BRAVO_Screen.txt")
        self.assertEqual(state["overlays"], [], "a dropped file's settings are left")
        self.assertEqual(
            state["activity"][-1]["what"],
            "refreshed from the backup folder: ALPHA 1 report new or changed, BRAVO added",
        )
        # Read once: the next Refresh, and the save it led to, find nothing new.
        srv.flush_pending_save()
        self.assertEqual(self.post("/api/refresh", {})[1]["workspaces"], {})

    def test_the_routes_leave_validation_to_the_validators(self):
        for route in self.post_routes():
            # A shared setting's route is the one handler, given its section.
            handler = getattr(route.handler, "func", route.handler)
            self.assertNotIn("_bad_request", inspect.getsource(handler), route.path)

    def test_every_post_route_has_a_validator(self):
        self.assertEqual(len(self.post_routes()), 20)
        for route in self.post_routes():
            self.assertTrue(callable(route.validator), route.path)
        # A shared setting's route has its section's validator.
        for s in srv.SHARED_SECTIONS:
            self.assertIs(srv._ROUTE_TABLE["POST", s.route].validator, s.validator, s.key)

    def test_every_write_is_refused_on_the_viewer_port(self):
        self.assertTrue(self.post_routes())
        # Heights change nothing anyone sees: viewers' narratives need them too.
        self.assertEqual([r.path for r in self.post_routes() if r.viewer], ["/api/elevation"])
        for route in self.post_routes():
            if route.path == "/api/elevation":
                continue
            self.assertFalse(route.viewer, route.path)
            message = self.refused(405, route.path, {"config": {"ato": "A"}}, base=self.viewer_base)
            self.assertEqual(message, "This server is read-only.")
        self.assertEqual(self.sync()["config"], {"ato": "", "title": ""}, "nothing got through")

    def test_every_route_in_the_table_is_reachable(self):
        self.assertEqual(len(srv._ROUTE_TABLE), len(srv.ROUTES), "no path is in it twice")
        for route in srv.ROUTES:
            if route.path == "/api/events":
                with contextlib.closing(self.open_events()) as resp:
                    self.assertEqual(resp.status, 200)
            elif route.method == "GET":
                status, body = self.request(route.path)
                # The map image proxy is there; it fetches only from saved basemaps.
                expected = (403, b"Not a saved basemap.") if route.limit else (200, b"")
                self.assertEqual(status, expected[0], route.path)
                self.assertIn(expected[1], body, route.path)
            else:
                # Reached its validator (or, for an empty config, its handler).
                status, body = self.request(route.path, {})
                reply = json.loads(body)
                self.assertTrue(
                    status == 200 or reply["message"].startswith("Validation failed: "),
                    (route.path, status, reply),
                )

    def test_each_route_asks_for_the_code_as_its_entry_says(self):
        public = sorted(r.path for r in srv.ROUTES if not r.code)
        self.assertEqual(
            public, ["/", "/Salt%20Report%20Workbench.html", "/api/health", "/index.html"]
        )
        for route in srv.ROUTES:
            body = {} if route.method == "POST" else None
            status, _ = self.request(route.path, body, code="WRONGCODE2")
            self.assertEqual(status, 401 if route.code else 200, route.path)
            # The viewer port never asks.
            if route.method == "GET" and route.path != "/api/events":
                status, _ = self.request(route.path, code=None, base=self.viewer_base)
                self.assertNotEqual(status, 401, route.path)

    def test_paths_not_in_the_table_are_still_404(self):
        self.assertEqual(self.refused(404, "/api/save_config"), "Not found.")  # a GET
        self.assertEqual(self.refused(404, "/api/sync", {}), "Not found.")  # a POST
        self.assertEqual(self.refused(404, "/api/nope", code=None), "Not found.")
        status, _ = self.request("/nowhere.html", code=None, base=self.viewer_base)
        self.assertEqual(status, 404)
        self.assertTrue(self.last_type.startswith("text/html"), self.last_type)
        # A POST to one is refused like any write first, as it always was.
        self.refused(401, "/api/nope", {}, code="WRONGCODE2")
        self.refused(405, "/api/nope", {}, base=self.viewer_base)

    def test_refusals_that_depend_on_what_the_server_holds_are_the_same_shape(self):
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=50)]})
        edit = {"ato": "ALPHA", "reportId": "r1", "fields": {"size": "x", "lastModified": 40}}
        self.refused(409, "/api/edit_report", edit)
        self.refused(404, "/api/edit_report", {**edit, "reportId": "ghost"})

    def test_access_and_rate_refusals_are_the_same_shape(self):
        config = {"config": {"ato": "A", "title": "T"}}
        with (
            mock.patch.object(srv, "RATE_BUCKET_CAPACITY", 1),
            mock.patch.object(srv, "RATE_REFILL_PER_SECOND", 0.0),
        ):
            self.assertEqual(self.post("/api/save_config", config)[0], 200)
            self.refused(429, "/api/save_config", config)
        with (
            mock.patch.object(srv, "AUTH_FAIL_CAPACITY", 1),
            mock.patch.object(srv, "AUTH_FAIL_REFILL_PER_SECOND", 0.0),
        ):
            self.refused(401, "/api/sync", code="WRONGCODE2")
            self.refused(429, "/api/sync")

    def test_basemap_refusals_are_the_same_shape(self):
        # An <img> never reads them, but a person opening the address does.
        tile = "/api/basemap?u=" + urllib.parse.quote("http://10.0.0.5/1.png", safe="")
        self.refused(403, tile)
        with (
            mock.patch.object(srv, "basemap_proxy_allowed", return_value=True),
            mock.patch.object(srv, "basemap_fetch", return_value=(502, "", b"")),
        ):
            self.refused(502, tile)
        with (
            mock.patch.object(srv, "BASEMAP_BUCKET_CAPACITY", 1),
            mock.patch.object(srv, "BASEMAP_REFILL_PER_SECOND", 0.0),
        ):
            srv._basemap_buckets.clear()
            self.refused(403, tile)
            self.refused(429, tile)

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

    def test_posts_must_be_json(self):
        # A form on another site can POST text/plain without asking first;
        # the page always sends application/json.
        body = json.dumps({"config": {"ato": "A", "title": "T"}}).encode()
        for ctype, expected in (
            ("text/plain", 415),
            ("application/x-www-form-urlencoded", 415),
            ("multipart/form-data; boundary=x", 415),
            ("application/json; charset=utf-8", 200),
            ("Application/JSON", 200),
        ):
            status, reply = self.request(
                "/api/save_config", raw=body, headers={"Content-Type": ctype}
            )
            self.assertEqual(status, expected, ctype)
            if status == 415:
                self.assertIn(b"must be application/json", reply)

    def test_cross_site_posts_are_refused(self):
        port = self.editor.server_address[1]
        body = {"config": {"ato": "A", "title": "T"}}
        for headers, expected in (
            ({"Sec-Fetch-Site": "cross-site"}, 403),
            ({"Origin": "https://evil.example"}, 403),
            ({"Origin": f"http://127.0.0.1:{port + 1}"}, 403),
            ({"Origin": "null"}, 403),
            ({"Origin": f"http://127.0.0.1:{port}"}, 200),
            ({"Origin": f"http://127.0.0.1:{port}", "Sec-Fetch-Site": "same-origin"}, 200),
            ({}, 200),  # no Origin: not a browser's cross-site request
        ):
            status, reply = self.post("/api/save_config", body, headers=headers)
            self.assertEqual(status, expected, headers)
            if expected == 403:
                self.assertEqual(reply["message"], "Cross-site request refused.")
        self.assertTrue(srv._same_origin("https://host", "host:443", True))
        self.assertTrue(srv._same_origin("http://[::1]:8080", "[::1]:8080", False))
        self.assertFalse(srv._same_origin("https://host", "host:8080", True))
        self.assertFalse(srv._same_origin("https://host:x", "host", True))

    def test_every_reply_forbids_framing_and_sniffing(self):
        def headers_of(path, **kw):
            req = urllib.request.Request(
                self.base + path, headers={"Cookie": f"salt_access={CODE}"}, **kw
            )
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.headers
            except urllib.error.HTTPError as exc:
                with exc:
                    return exc.headers

        for path in ("/", "/api/sync", "/nowhere"):
            h = headers_of(path)
            self.assertEqual(h["X-Frame-Options"], "DENY", path)
            self.assertEqual(h["Content-Security-Policy"], "frame-ancestors 'none'", path)
            self.assertEqual(h["X-Content-Type-Options"], "nosniff", path)
        h = headers_of("/api/save_config", data=b"{}", method="POST")
        self.assertEqual(h["X-Frame-Options"], "DENY")

    def test_deeply_nested_json_is_just_invalid(self):
        # Regression: RecursionError got past the handler and the connection dropped.
        status, raw = self.request("/api/save_reports", raw=b"[" * 100_000)
        self.assertEqual((status, json.loads(raw)["message"]), (400, "Invalid JSON."))

    def test_wrong_codes_are_throttled_on_gets_too(self):
        # Regression: only POSTs were rate limited, so the code could be guessed over GET.
        body = {"config": {"ato": "A", "title": "T"}}
        with (
            mock.patch.object(srv, "AUTH_FAIL_CAPACITY", 3),
            mock.patch.object(srv, "AUTH_FAIL_REFILL_PER_SECOND", 0.0),
        ):
            for _ in range(5):
                self.assertEqual(self.request("/api/sync")[0], 200, "a right code costs nothing")
            # Wrong or missing codes, on GET and POST alike, drain the failure bucket.
            self.assertEqual(self.request("/api/sync", code="WRONGCODE2")[0], 401)
            self.assertEqual(self.request("/api/events", code=None)[0], 401)
            self.assertEqual(self.post("/api/save_config", body, code="WRONGCODE2")[0], 401)
            # Empty: refused before the code is looked at, so a right guess gets nowhere.
            status, raw = self.request("/api/sync")
            self.assertEqual(status, 429)
            self.assertIn(b"wrong access codes", raw)
            self.assertEqual(self.request("/api/basemap?u=x")[0], 429)
            self.assertEqual(self.post("/api/save_config", body)[0], 429)
            # The viewer port needs no code, so it isn't held up.
            self.assertEqual(self.request("/api/sync", base=self.viewer_base, code=None)[0], 200)

    def test_a_burst_of_saves_never_blocks_reading(self):
        # An editor's own saves use up the POST bucket; that must never turn
        # their pulls of the data or their event stream into 429s.
        body = {"config": {"ato": "A", "title": "T"}}
        with (
            mock.patch.object(srv, "RATE_BUCKET_CAPACITY", 3),
            mock.patch.object(srv, "RATE_REFILL_PER_SECOND", 0.0),
        ):
            codes = [self.post("/api/save_config", body)[0] for _ in range(5)]
            self.assertEqual(codes, [200, 200, 200, 429, 429])
            for _ in range(5):
                self.assertEqual(self.request("/api/sync")[0], 200)
            with contextlib.closing(self.open_events()) as resp:
                self.assertEqual(resp.status, 200)
                self.assertRegex(resp.readline(), NOTICE)

    def test_map_images_are_rate_limited_on_both_ports(self):
        with (
            mock.patch.object(srv, "BASEMAP_BUCKET_CAPACITY", 2),
            mock.patch.object(srv, "BASEMAP_REFILL_PER_SECOND", 0.0),
        ):
            codes = [
                self.request(
                    "/api/basemap?u=http%3A%2F%2Fx%2F1.png", base=self.viewer_base, code=None
                )[0]
                for _ in range(3)
            ]
        self.assertEqual(codes, [403, 403, 429])
        self.assertGreaterEqual(srv.BASEMAP_BUCKET_CAPACITY, 400, "a whole map view at once")

    def test_one_machine_holds_a_limited_number_of_event_streams(self):
        with mock.patch.object(srv, "MAX_SSE_PER_MACHINE", 2):
            streams = [self.open_events() for _ in range(3)]
            try:
                for s in streams:
                    s.readline()
                self.assertTrue(self.wait_until(lambda: len(srv.sse_clients) == 2))
                streams[0].readline()  # the blank line ending the bootstrap update
                self.assertEqual(streams[0].readline(), b"", "the oldest was closed")
                self.post("/api/save_config", {"config": {"ato": "A", "title": "T"}})
                for s in streams[1:]:
                    s.readline()
                    self.assertRegex(s.readline(), NOTICE, "the newer ones still flow")
            finally:
                for s in streams:
                    s.close()
        self.assertTrue(self.wait_until(lambda: not srv.sse_clients))

    def test_a_stalled_client_is_dropped_but_an_event_stream_stays_open(self):
        import socket
        import time

        with mock.patch.object(srv.SaltSyncHandler, "timeout", 0.3):
            stalled = socket.create_connection(self.editor.server_address, timeout=5)
            try:
                stalled.sendall(b"GET /api/sync HTTP/1.1\r\n")  # and nothing more
                start = time.monotonic()
                self.assertEqual(stalled.recv(1024), b"", "closed by the server")
                self.assertLess(time.monotonic() - start, 3)
            finally:
                stalled.close()
            with contextlib.closing(self.open_events()) as resp:
                resp.readline()
                resp.readline()
                time.sleep(0.6)  # twice the idle timeout
                self.post("/api/save_config", {"config": {"ato": "A", "title": "T"}})
                self.assertRegex(resp.readline(), NOTICE)

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

    def test_a_saved_report_is_attributed_to_whoever_changed_it(self):
        ab = {"initials": "AB", "color": "#32d74b"}
        cd = {"initials": "CD", "color": "#ff453a"}
        self.post("/api/save_profile", {"profile": ab})
        self.post("/api/save_profile", {"profile": cd})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(user=ab)]})
        # CD changes one report and deletes another, from a page that put its
        # own name on both: the one changed is CD's, the one only deleted is
        # still AB's. The profile is the server's, not the page's copy of it.
        changed = report(lm=2, size="3x T-72", user={**cd, "color": "#000000"})
        gone = report(rid="r2", lm=2, user=cd, deleted=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(rid="r2", user=ab)]})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [changed, gone]})
        by_id = {r["id"]: r for r in self.sync()["workspaces"]["ALPHA"]}
        self.assertEqual(by_id["r1"]["user"], cd)
        self.assertTrue(by_id["r2"]["deleted"])
        self.assertEqual(by_id["r2"]["user"], ab)
        # An import keeps its reports' own authors.
        ef = {"initials": "EF", "color": "#0a84ff"}
        imp = {"ato": "BRAVO", "reports": [report(rid="b1", user=ef)], "source": "backup"}
        self.post("/api/save_reports", imp)
        self.assertEqual(self.sync()["workspaces"]["BRAVO"][0]["user"], ef)

    def test_an_unloaded_workspace_is_listed_until_someone_works_in_it(self):
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.assertEqual(self.sync()["unloaded"], [])
        self.post("/api/unload_ato", {"ato": "ALPHA"})
        self.assertEqual(self.sync()["unloaded"], ["ALPHA"])
        # Switched to again, or a report saved in it, it's in use again.
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
        self.assertEqual(self.sync()["unloaded"], [])
        self.post("/api/unload_ato", {"ato": "ALPHA"})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(rid="r2")]})
        self.assertEqual(self.sync()["unloaded"], [])
        # One that was never loaded isn't listed.
        self.post("/api/unload_ato", {"ato": "NEVER"})
        self.assertEqual(self.sync()["unloaded"], [])

    def test_switching_to_an_unloaded_workspace_as_typed_takes_it_off_the_list(self):
        # Regression: the list holds the workspace's name trimmed and in upper
        # case, and save_config looked for it as sent, so " alpha " stayed listed.
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.post("/api/unload_ato", {"ato": "ALPHA"})
        self.assertEqual(self.sync()["unloaded"], ["ALPHA"])
        status, _ = self.post("/api/save_config", {"config": {"ato": " alpha ", "title": "T"}})
        self.assertEqual(status, 200)
        self.assertEqual(self.sync()["unloaded"], [])

    def test_an_edit_to_an_older_copy_is_refused(self):
        # Regression: edit_report overwrote whatever the server held, so an
        # edit made to a stale copy undid a later change by someone else.
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=50, size="v50")]})
        edit = {"ato": "ALPHA", "reportId": "r1"}
        status, body = self.post(
            "/api/edit_report", {**edit, "fields": {"size": "stale", "lastModified": 40}}
        )
        self.assertEqual(status, 409)
        self.assertIn("not edited", body["message"])
        self.assertEqual(self.sync()["workspaces"]["ALPHA"][0]["size"], "v50")
        for lm, size in ((50, "same stamp"), (60, "newer")):
            status, _ = self.post(
                "/api/edit_report", {**edit, "fields": {"size": size, "lastModified": lm}}
            )
            self.assertEqual(status, 200, lm)
            self.assertEqual(self.sync()["workspaces"]["ALPHA"][0]["size"], size)
        # What a page from before 2.19 does: the edit, then save_reports with
        # the same stamp (the page now sends save_reports only when the edit
        # couldn't be sent).
        now = 70
        fields = {"size": "page edit", "lastModified": now}
        self.assertEqual(self.post("/api/edit_report", {**edit, "fields": fields})[0], 200)
        status, _ = self.post(
            "/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=now, size="page edit")]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.sync()["workspaces"]["ALPHA"][0]["lastModified"], now)
        # No stamp sent: the server stamps it now, as before.
        self.assertEqual(self.post("/api/edit_report", {**edit, "fields": {"size": "x"}})[0], 200)
        self.assertGreater(self.sync()["workspaces"]["ALPHA"][0]["lastModified"], now)

    def test_writes_that_change_nothing_are_not_saved_broadcast_or_audited(self):
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        tiles = {"name": "Topo", "kind": "tiles", "url": "http://10.0.0.5/tiles/{z}/{y}/{x}.png"}
        drone = {"name": "GE 1", "grid": "11S NV 39697 06762", "at": 1793018940000}
        fmt = {"preset": "custom", "lines": [{"type": "id"}]}
        writes = (
            ("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}}),
            ("/api/save_format", {"format": fmt}),
            ("/api/save_overlays", {"overlays": [NAI1]}),
            ("/api/save_basemaps", {"basemaps": [tiles]}),
            ("/api/save_drones", {"drones": [drone]}),
            ("/api/save_narrative", {"narrative": {"enemy": "OPFOR"}}),
            ("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}}),
        )
        for path, body in writes:
            self.assertEqual(self.post(path, body)[0], 200, path)
        cancel_pending_save()
        with srv.data_lock:
            srv._dirty_atos, srv._shared_dirty = set(), False  # as if just saved
        repeats = (
            *writes,
            ("/api/save_config", {}),
            (
                "/api/delete_history",
                {"ato": "ALPHA", "deletions": [{"reportId": "r1", "lastModified": 5}]},
            ),
            ("/api/unload_ato", {"ato": "NOT-LOADED"}),
        )
        said = srv.activity()
        with (
            mock.patch.object(srv, "schedule_save") as saved,
            mock.patch.object(srv, "broadcast_update") as broadcast,
            mock.patch.object(srv, "audit") as audited,
        ):
            for path, body in repeats:
                status, reply = self.post(path, body)
                self.assertEqual((status, reply["status"]), (200, "success"), path)
        self.assertEqual(reply["message"], "ATO unloaded.", "the same reply as a real unload")
        saved.assert_not_called()
        broadcast.assert_not_called()
        audited.assert_not_called()
        self.assertEqual((srv._dirty_atos, srv._shared_dirty), (set(), False), "nothing to write")
        self.assertEqual(srv.activity(), said, "nor on the Activity list")

    def test_importing_reports_does_not_change_who_the_importer_is(self):
        # Regression: a backup of someone else's reports re-labeled the
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
        extra = {**PL_BLUE, "color": "red", "geometry": {**PL_BLUE["geometry"], "x": 1}}
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
            fake.server_close()
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

    def test_tags_sync_and_survive_a_restart(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        sent = {"id": "tag-a1", "name": " Routes ", "color": "#FF9F0A", "x": 1}
        self.assertEqual(self.post("/api/save_tags", {"tags": [sent]})[0], 200)
        clean = [{"id": "tag-a1", "name": "Routes", "color": "#ff9f0a"}]
        self.assertEqual(self.sync()["tags"], clean, "trimmed, known fields only")
        route = {**PL_BLUE, "type": "tag-a1", "name": "Route Gold"}
        self.post("/api/save_overlays", {"overlays": [NAI1, route], "tagged": True})
        srv.flush_pending_save()
        for f in self.backup_files():
            data = srv._extract_json_from_file(f.read_text("utf-8"))
            self.assertEqual((data["tags"], data["overlays"]), (clean, [NAI1, route]), f.name)
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual((self.sync()["tags"], self.sync()["overlays"]), (clean, [NAI1, route]))
        status, _ = self.post("/api/save_tags", {"tags": []}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot change them")
        self.assertEqual(self.post("/api/save_tags", {"tags": []})[0], 200)
        self.assertEqual(self.sync()["tags"], [])
        self.assertEqual(self.sync()["overlays"], [NAI1, route], "a tag's graphics stay, untagged")

    def test_the_way_of_march_syncs_and_an_axis_outlives_an_older_page(self):
        self.assertEqual(
            self.post("/api/save_narrative", {"narrative": {"enemy": "OPFOR", "toward": "W"}})[0],
            200,
        )
        self.assertEqual(self.sync()["narrative"]["toward"], "W")
        axis = {**PL_BLUE, "type": "AXIS", "name": "GOLD"}
        self.post("/api/save_overlays", {"overlays": [NAI1, axis], "tagged": True})
        # A page from before tags sends its NAIs, OBJs and PLs: the axis stays.
        self.post("/api/save_overlays", {"overlays": [NAI1, PL_BLUE]})
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE, axis])
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE, axis])
        self.assertEqual(self.sync()["narrative"]["toward"], "W")

    def test_a_page_from_before_tags_leaves_the_tagged_graphics_alone(self):
        route = {**PL_BLUE, "type": "tag-a1", "name": "Route Gold"}
        loose = {**NAI1, "type": "", "name": "Hill"}
        self.post("/api/save_overlays", {"overlays": [NAI1, route, loose], "tagged": True})
        # An older page sees NAI 1 alone; it adds PL BLUE, then unloads everything.
        self.post("/api/save_overlays", {"overlays": [NAI1, PL_BLUE]})
        self.assertEqual(self.sync()["overlays"], [NAI1, PL_BLUE, route, loose])
        self.post("/api/save_overlays", {"ato": "ALPHA", "overlays": []})
        self.assertEqual(self.sync()["overlays"], [route, loose])
        # A page that knows tags sends them all, and what it leaves out goes.
        self.post("/api/save_overlays", {"overlays": [route], "tagged": True})
        self.assertEqual(self.sync()["overlays"], [route])

    def test_a_backup_keeps_only_the_tags_the_server_would_take(self):
        good = {"id": "tag-a1", "name": "Routes", "color": "#ff9f0a"}
        held = [
            good,
            {**good, "name": "Again"},
            {**good, "id": "tag-b2", "name": "PL"},
            "x",
            {"id": "tag-c3"},
        ]
        self.assertEqual(srv.read_tags(held), [good])
        self.assertIsNone(srv.read_tags(None), "a file from before tags decides nothing")
        _, text = srv.render_backup({"ALPHA": [report()]}, {}, {}, {}, tags=held)
        self.assertEqual(srv._extract_json_from_file(text)["tags"], [good])
        _, old = srv.render_backup({"ALPHA": [report()]}, {}, {}, {})
        self.assertEqual(srv._extract_json_from_file(old)["tags"], [], "written empty")

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
        # Off station is kept; on station (false) is the same as saying nothing.
        docked = {**sent, "name": "GE 2", "offStation": True}
        flying = {**sent, "name": "GE 3", "offStation": False}
        drones = {"drones": [sent, docked, flying]}
        self.assertEqual(self.post("/api/save_drones", drones)[0], 200)
        one = {
            "grid": "11S NV 39697 06762",
            "at": 1793018940000,
            "look": "11S NV 44000 07000",
            "range": 12.5,
        }
        clean = [
            {"name": "GE 1", **one},
            {"name": "GE 2", **one, "offStation": True},
            {"name": "GE 3", **one},
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

    def test_fmv_mode_syncs_and_survives_a_restart(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        # Never saved: empty, and the page decides from the drones.
        self.assertEqual(self.sync()["fmv"], {})
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["fmv"], {}, "a file that never had it leaves it unsaved")
        status, _ = self.post("/api/save_fmv", {"fmv": {"on": True}}, base=self.viewer_base)
        self.assertEqual(status, 405, "viewers cannot change it")
        self.assertEqual(self.post("/api/save_fmv", {"fmv": {"on": True, "x": 1}})[0], 200)
        self.assertEqual(self.sync()["fmv"], {"on": True}, "known fields only")
        self.assertEqual(self.post("/api/save_fmv", {"fmv": {"on": False}})[0], 200)
        self.assertEqual(self.post("/api/save_fmv", {"fmv": {"on": "yes"}})[0], 400)
        self.assertEqual(
            [what for _, what, _ in self.said()],
            ["turned FMV mode on", "turned FMV mode off"],
        )
        srv.flush_pending_save()
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["fmv"], {"on": False}, "off is kept too")

    def test_a_reports_observer_is_kept_edited_and_written_out(self):
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        seen = report(observer="GE 1", history=[report(lm=0, observer="GE 2")])
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [seen]})
        held = self.sync()["workspaces"]["ALPHA"][0]
        self.assertEqual((held["observer"], held["history"][0]["observer"]), ("GE 1", "GE 2"))
        # An Edit may change it, and that is a change people see.
        edit = {"ato": "ALPHA", "reportId": "r1", "fields": {"observer": "GE 3", "lastModified": 2}}
        self.assertEqual(self.post("/api/edit_report", edit)[0], 200)
        self.assertEqual(self.sync()["workspaces"]["ALPHA"][0]["observer"], "GE 3")
        again = report(lm=3, observer="", history=held["history"])
        self.assertEqual(
            self.post("/api/save_reports", {"ato": "ALPHA", "reports": [again]})[0], 200
        )
        self.assertEqual(
            [what for _, what, _ in self.said()],
            ["logged ALPHA001", "updated ALPHA001", "updated ALPHA001"],
        )
        # The backup file says it, for a person reading it, when there is one.
        self.post("/api/edit_report", {**edit, "fields": {"observer": "GE 3", "lastModified": 4}})
        srv.flush_pending_save()
        text = next(Path(srv.BACKUP_DIR).glob("ALPHA_*.txt")).read_text("utf-8")
        self.assertIn(" Observer : GE 3\n", text)

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
            "equipment": [
                {"type": " BTR-4 ", "role": "mech", "origin": ""},
                {"type": "BMP-X", "role": "mech", "origin": "RU", "gear": "tracked", "reach": 4},
                {"type": "Y-1", "role": "fires", "origin": "", "gear": ""},
            ],
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
            # The gear and reach only when said: an entry without them is as it was.
            "equipment": [
                {"type": "BTR-4", "role": "mech", "origin": ""},
                {"type": "BMP-X", "role": "mech", "origin": "RU", "gear": "tracked", "reach": 4},
                {"type": "Y-1", "role": "fires", "origin": ""},
            ],
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

    def every_setting_saved(self):
        """Save two workspaces and every shared setting through the API (with
        fields to drop and spaces to trim), then return what came out: each
        backup file's text (its time masked), the audit lines (without their
        time and operator), and /api/sync up to its per-request tail."""
        shutil.rmtree(srv.BACKUP_DIR, ignore_errors=True)
        topo = {
            "name": " Topo ",
            "kind": "wms",
            "url": " http://10.0.0.5/wms ",
            "layers": " 0,1 ",
            "version": "1.3.0",
            "crs": "EPSG:4326",
            "format": "image/png",
            "extra": 1,
        }
        raven = {
            "name": " Raven ",
            "grid": "11S NV 39697 06762",
            "at": 1761600000000,
            "look": "11S NV 40000 07000",
            "range": 5,
            "extra": 1,
        }
        narrative = {
            "enemy": " OPFOR ",
            "units": [{"name": " 1st Tank ", "places": [" Hill 1 ", ""], "kinds": ["armor"] * 2}],
            "equipment": [{"type": " T-90M ", "role": "armor", "origin": "RU", "extra": 1}],
            "off": ["deep", "axes", "deep"],
            "custom": [{"what": " Bridge ", "words": " bridge, crossing ", "min": 2, "hours": 6}],
            "extra": 1,
        }
        fmt = {"preset": "salt", "lines": [{"type": "id"}, {"type": "custom", "label": "Wx"}]}
        for path, body in (
            ("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b", "x": 1}}),
            ("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol", "x": 1}}),
            ("/api/save_reports", {"ato": "ALPHA", "reports": [report(custom={"Wx": "Rain"})]}),
            (
                "/api/save_reports",
                {
                    "ato": "BRAVO",
                    "reports": [report("b1", "BRAVO001", ato="BRAVO", title="Screen")],
                },
            ),
            ("/api/save_format", {"format": fmt}),
            ("/api/save_overlays", {"overlays": [{**NAI1, "extra": 1}, PL_BLUE]}),
            (
                "/api/save_basemaps",
                {"basemaps": [topo, {"name": "OSM", "kind": "tiles", "url": "http://10.0.0.5/t"}]},
            ),
            (
                "/api/save_drones",
                {"drones": [raven, {"name": "Puma", "grid": "11S NV 1 2", "at": 1}]},
            ),
            ("/api/save_narrative", {"narrative": narrative}),
            ("/api/save_fmv", {"fmv": {"on": True, "x": 1}}),
        ):
            self.assertEqual(self.post(path, body)[0], 200, path)
        srv.flush_pending_save()
        folder = Path(srv.BACKUP_DIR)
        out = {
            f.name: re.sub(
                r"(?m)^ Exported       : .*$", " Exported       : -", f.read_text("utf-8")
            )
            for f in sorted(folder.glob("*.txt"))
        }
        out[srv.SHARED_SETTINGS_NAME] = (folder / srv.SHARED_SETTINGS_NAME).read_text("utf-8")
        log = (folder / srv.AUDIT_LOG_NAME).read_text("utf-8")
        out["audit"] = "\n".join(line.split("  ", 2)[2].strip() for line in log.splitlines())
        out["sync"] = self.request("/api/sync")[1].decode("utf-8").split(',"connected_users"')[0]
        return out

    def test_every_shared_setting_is_saved_written_and_served_as_before(self):
        out = self.every_setting_saved()
        shared = out.pop(srv.SHARED_SETTINGS_NAME)
        self.assertEqual(out, EVERY_SETTING_SAVED)
        sync = json.loads(EVERY_SETTING_SAVED["sync"] + "}")
        keys = [s.key for s in srv.SHARED_SECTIONS]
        self.assertEqual(
            keys,
            [
                "config",
                "profiles",
                "format",
                "overlays",
                "basemaps",
                "drones",
                "narrative",
                "tags",
                "fmv",
            ],
        )
        self.assertEqual(
            shared, json.dumps({k: sync[k] for k in keys}, indent=1, ensure_ascii=False) + "\n"
        )
        # And they all come back on a restart, from the files just written.
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual({k: srv.DATA_STORE[k] for k in keys}, {k: sync[k] for k in keys})
        self.assertEqual(srv.DATA_STORE["workspaces"], sync["workspaces"])

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

    def test_snapshots_are_kept_by_round_not_by_file(self):
        # Regression: pruning counted files, so with N workspaces the 48 kept
        # covered 48/N hours instead of the two days promised.
        folder = self.own_backup_dir()
        snap_dir = folder / srv.SNAPSHOT_DIR_NAME
        for ato in ("ALPHA", "BRAVO", "CHARLIE"):
            self.post(
                "/api/save_reports", {"ato": ato, "reports": [report(f"{ato}1", f"{ato}001")]}
            )
        cancel_pending_save()
        (snap_dir).mkdir()
        (snap_dir / "Superseded_20200101_000000Z_OLD_T.txt").write_text("x", encoding="utf-8")
        with (
            mock.patch.object(srv, "SNAPSHOT_KEEP", 2),
            mock.patch.object(srv, "_last_snapshot_at", None),
        ):
            for n in range(3):
                self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=n + 2)]})
                srv.flush_pending_save()
                srv._last_snapshot_at -= srv.SNAPSHOT_INTERVAL_SECONDS  # an hour passes
        rounds = {}
        for f in snap_dir.iterdir():
            if m := srv._SNAPSHOT_NAME_RE.match(f.name):
                rounds.setdefault(m.group(1), set()).add(f.name[len(m.group(0)) :])
        self.assertEqual(len(rounds), 2, "the newest two rounds")
        every = {
            "ALPHA_Patrol.txt",
            "BRAVO_Patrol.txt",
            "CHARLIE_Patrol.txt",
            srv.SHARED_SETTINGS_NAME,
        }
        for files in rounds.values():
            self.assertEqual(files, every, "each round has every workspace and the shared settings")
        self.assertTrue((snap_dir / "Superseded_20200101_000000Z_OLD_T.txt").exists())

    def test_workspaces_whose_file_names_collide_both_survive(self):
        # Regression: "A B" and "A_B" both made A_B_Patrol.txt, so one
        # overwrote the other and was gone after a restart. Windows doesn't
        # tell case apart, so "patrol" and "Patrol" collide too.
        import hashlib

        folder = self.own_backup_dir()
        self.post("/api/save_reports", {"ato": "A_B", "reports": [report("x", "AB001")]})
        self.post(
            "/api/save_reports", {"ato": "A B", "reports": [report("y", "AB001", title="patrol")]}
        )
        srv.flush_pending_save()
        tag = hashlib.sha256(b"A B").hexdigest()[:6]
        self.assertEqual(
            sorted(f.name for f in folder.glob("*.txt")),
            ["A_B_Patrol.txt", f"A_B_{tag}_patrol.txt"],
        )
        # The same names at the next save: nothing is renamed back and forth.
        self.post(
            "/api/save_reports", {"ato": "A B", "reports": [report("y2", "AB002", title="patrol")]}
        )
        srv.flush_pending_save()
        self.assertEqual(len(list(folder.glob("*.txt"))), 2)
        reset_state()
        srv.load_data_from_disk()
        ws = srv.DATA_STORE["workspaces"]
        self.assertEqual(sorted(ws), ["A B", "A_B"])
        self.assertEqual(sorted(r["id"] for r in ws["A B"]), ["y", "y2"])
        self.assertEqual([r["id"] for r in ws["A_B"]], ["x"])

    def test_a_retitled_workspace_leaves_no_old_file_to_merge_back(self):
        # Regression: the file under the old title stayed beside the new one
        # and was merged back in at every start. It is moved, never deleted.
        folder = self.own_backup_dir()
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Old"}})
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        srv.flush_pending_save()
        self.assertTrue((folder / "ALPHA_Old.txt").exists())
        self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "New"}})
        srv.flush_pending_save()
        self.assertEqual([f.name for f in folder.glob("*.txt")], ["ALPHA_New.txt"])
        moved = list((folder / srv.SNAPSHOT_DIR_NAME).glob("Superseded_*_ALPHA_Old.txt"))
        self.assertEqual(len(moved), 1, "kept in snapshots/")
        self.assertIn('"r1"', moved[0].read_text("utf-8"))
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(srv.workspace_sources, {"ALPHA": "ALPHA_New.txt"})

    def test_old_files_found_at_boot_are_moved_once_their_reports_are_rewritten(self):
        import time

        folder = self.own_backup_dir()
        for name, title, ws, age in (
            ("ALPHA_Day1.txt", "Day1", {"ALPHA": [report("r2", "ALPHA002")]}, 100),
            ("ALPHA_Day2.txt", "Day2", {"ALPHA": [report()]}, 50),
            ("BRAVO_Screen.txt", "Screen", {"BRAVO": [report("b1", "BRAVO001")]}, 0),
        ):
            _, text = srv.render_backup(
                ws, {"ato": "ALPHA", "title": "Day2"}, {}, {}, label=(next(iter(ws)), title)
            )
            (folder / name).write_text(text, encoding="utf-8")
            os.utime(folder / name, (time.time() - age, time.time() - age))
        srv.load_data_from_disk()
        self.post("/api/unload_ato", {"ato": "BRAVO"})
        srv.flush_pending_save()
        self.assertEqual(
            sorted(f.name for f in folder.glob("*.txt")),
            ["ALPHA_Day2.txt", "BRAVO_Screen.txt"],
            "Day1's report is in Day2's file now; BRAVO's file is its only copy",
        )
        text = (folder / "ALPHA_Day2.txt").read_text("utf-8")
        self.assertEqual(len(srv._extract_json_from_file(text)["workspaces"]["ALPHA"]), 2)
        # An unloaded workspace's file isn't overwritten by one whose name collides with it.
        self.post(
            "/api/save_reports",
            {"ato": "BRAVO", "reports": [report("b9", "BRAVO009", title="Screen")]},
        )
        srv.flush_pending_save()
        old = srv._extract_json_from_file((folder / "BRAVO_Screen.txt").read_text("utf-8"))
        self.assertEqual([r["id"] for r in old["workspaces"]["BRAVO"]], ["b1"])
        self.assertEqual(len(list(folder.glob("BRAVO_*_Screen.txt"))), 1)

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
        # The workspace's backup and the shared settings.
        self.assertEqual(lock_held_during_write, [False, False])

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
            delays, said = [], []
            for _ in range(5):
                srv.save_data_to_disk()
                delays.append(self.pending_retry())
                said.append(len(printed.call_args_list))
                cancel_pending_save()
        self.assertEqual(calls[:2], ["fsync", "replace"], "flushed to disk before replacing")
        self.assertEqual(delays, [1.0, 2.0, 5.0, 30.0, 30.0])
        self.assertEqual(srv._dirty_atos, {"ALPHA"})
        self.assertEqual(len(set(said)), 1, "said once for the whole run of failures")
        lines = [c.args[0] for c in printed.call_args_list]
        self.assertIn("[!] Error saving ALPHA_Patrol.txt: [Errno 13]", lines[0])
        self.assertIn("retried", lines[-1])
        with mock.patch.object(srv, "safe_print") as printed:
            srv.save_data_to_disk()
        self.assertEqual(printed.call_args_list[0].args[0], "[+] Backups are being saved again.")
        self.assertIsNone(self.pending_retry())
        self.assertEqual(srv._dirty_atos, set())

    def test_a_backup_folder_that_is_gone_keeps_the_changes_and_is_retried(self):
        # Regression: with the folder gone (a pulled USB stick) the pending
        # changes were cleared, the error escaped the save's thread, nothing
        # was said or retried, and /api/health still said ok.
        self.addCleanup(cancel_pending_save)
        folder = self.own_backup_dir()
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        cancel_pending_save()
        (folder / "E").write_text("not a folder", encoding="utf-8")  # no drive E: now
        with (
            mock.patch.object(srv, "BACKUP_DIR", str(folder / "E" / "Auto Backups")),
            mock.patch.object(srv, "safe_print") as printed,
        ):
            srv.save_data_to_disk()
            self.assertEqual(self.pending_retry(), 1.0)
            self.assertEqual(srv.health()["status"], "not saving")
            with srv.data_lock:  # a change made meanwhile
                srv.DATA_STORE["workspaces"]["BRAVO"] = [report("b1", "BRAVO001")]
                srv.mark_dirty("BRAVO")
            cancel_pending_save()
            srv.save_data_to_disk()
        self.assertEqual(srv._save_failures, 2)
        self.assertEqual(srv._dirty_atos, {"ALPHA", "BRAVO"})
        self.assertTrue(srv._shared_dirty)
        lines = [c.args[0] for c in printed.call_args_list]
        self.assertTrue(lines[0].startswith("[!] Error saving to "), lines[0])
        self.assertIn("Auto Backups", lines[0])
        self.assertIn("retried", lines[-1])
        self.assertEqual(len(lines), 2, "said once for the whole run of failures")
        cancel_pending_save()
        with mock.patch.object(srv, "safe_print") as printed:
            srv.save_data_to_disk()
        self.assertEqual(printed.call_args_list[0].args[0], "[+] Backups are being saved again.")
        self.assertIn('"r1"', (folder / "ALPHA_Patrol.txt").read_text("utf-8"))

    def test_a_broken_character_is_refused_and_cannot_stop_saves(self):
        folder = self.own_backup_dir()
        message = self.refused(
            400, "/api/save_reports", {"ato": "ALPHA", "reports": [report(note="x\ud83d")]}
        )
        self.assertEqual(
            message,
            "Validation failed: reports[0].note holds a broken character "
            "(U+D83D, half of an emoji or other symbol).",
        )
        self.assertNotIn("ALPHA", self.sync()["workspaces"])
        # Were one to get in all the same, the backups and the audit log still save.
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        cancel_pending_save()
        with srv.data_lock:
            srv.DATA_STORE["workspaces"]["ALPHA"][0]["size"] = "2x \ud83d"
            srv.DATA_STORE["overlays"] = [{**NAI1, "label": "NAI \ud83d"}]
            srv.mark_dirty()
        with mock.patch.object(srv, "safe_print") as printed:
            srv.save_data_to_disk()
            srv.audit("AB@10.0.0.12", "save_config ALPHA / Patrol \ud83d")
        self.assertEqual(printed.call_args_list, [])
        self.assertEqual(srv._save_failures, 0)
        self.assertIn('"2x ?"', (folder / "ALPHA_Patrol.txt").read_text("utf-8"))
        self.assertIn('"NAI ?"', (folder / srv.SHARED_SETTINGS_NAME).read_text("utf-8"))
        self.assertIn("Patrol ?", (folder / srv.AUDIT_LOG_NAME).read_text("utf-8"))

    def test_shutdown_says_plainly_when_the_changes_were_not_saved(self):
        # Regression: it said "flushed to disk" when the save had failed.
        self.addCleanup(cancel_pending_save)
        folder = self.own_backup_dir()
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        cancel_pending_save()
        (folder / "E").write_text("not a folder", encoding="utf-8")
        with (
            mock.patch.object(srv, "BACKUP_DIR", str(folder / "E" / "Auto Backups")),
            mock.patch.object(srv, "stop_terrain"),
            mock.patch.object(srv, "safe_print") as printed,
        ):
            self.assertFalse(srv.graceful_drain())
        lines = [c.args[0] for c in printed.call_args_list]
        self.assertNotIn("[+] Pending changes flushed to disk.", lines)
        said = lines.index(
            f"[!] Changes NOT saved: the backups could not be written to {folder / 'E' / 'Auto Backups'}."
        )
        self.assertTrue(lines[said + 1].startswith("    Error saving to "), lines[said + 1])
        cancel_pending_save()
        with (
            mock.patch.object(srv, "stop_terrain"),
            mock.patch.object(srv, "safe_print") as printed,
        ):
            self.assertTrue(srv.graceful_drain())
        lines = [c.args[0] for c in printed.call_args_list]
        self.assertIn("[+] Pending changes flushed to disk.", lines)
        self.assertIn(f"[+] {srv.AUDIT_LOG_NAME} is being written again.", lines)

    def own_backup_dir(self):
        """An empty backup folder for this test alone."""
        folder = Path(tempfile.mkdtemp(prefix="salt-own-"))
        self.addCleanup(shutil.rmtree, folder, True)
        patcher = mock.patch.object(srv, "BACKUP_DIR", str(folder))
        patcher.start()
        self.addCleanup(patcher.stop)
        return folder

    def test_shared_settings_survive_a_restart_with_no_workspace(self):
        # Regression: with no workspace loaded nothing was written, and the
        # loader read the shared settings only when some workspace came back.
        folder = self.own_backup_dir()
        tiles = {"name": "Topo", "kind": "tiles", "url": "http://10.0.0.5/tiles/{z}/{y}/{x}.png"}
        drone = {"name": "GE 1", "grid": "11S NV 39697 06762", "at": 1793018940000}
        fmt = {"preset": "custom", "lines": [{"type": "id"}, {"type": "size"}]}
        for path, body in (
            ("/api/save_basemaps", {"basemaps": [tiles]}),
            ("/api/save_drones", {"drones": [drone]}),
            ("/api/save_narrative", {"narrative": {"enemy": "OPFOR"}}),
            ("/api/save_overlays", {"overlays": [NAI1]}),
            ("/api/save_format", {"format": fmt}),
            ("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}}),
            ("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}}),
        ):
            self.assertEqual(self.post(path, body)[0], 200, path)
        before = self.sync()
        srv.flush_pending_save()
        self.assertEqual([f.name for f in folder.glob("*.txt")], [], "no workspace, no backup")
        self.assertTrue((folder / srv.SHARED_SETTINGS_NAME).is_file())
        reset_state()
        self.assertEqual(srv.load_data_from_disk(), 0)
        after = self.sync()
        for key in ("basemaps", "drones", "narrative", "overlays", "format", "profiles", "config"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after["drones"], [drone])
        self.assertEqual(after["workspaces"], {})

    def test_the_newest_file_decides_the_shared_settings(self):
        import time

        folder = self.own_backup_dir()
        old = {"name": "Old", "kind": "tiles", "url": "http://10.0.0.5/old/{z}/{x}/{y}.png"}
        new = {**old, "name": "New"}
        self.post("/api/save_basemaps", {"basemaps": [old]})
        srv.flush_pending_save()
        settings = folder / srv.SHARED_SETTINGS_NAME
        os.utime(settings, (time.time() - 100, time.time() - 100))
        # A workspace backup written later (say by an older version) holds newer ones.
        _, text = srv.render_backup({"ALPHA": [report()]}, {}, {}, {}, basemaps=[new])
        (folder / "ALPHA_Patrol.txt").write_text(text, encoding="utf-8")
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["basemaps"], [new])
        # And the other way about.
        os.utime(settings, (time.time() + 100, time.time() + 100))
        reset_state()
        srv.load_data_from_disk()
        self.assertEqual(self.sync()["basemaps"], [old])
        self.assertEqual(list(self.sync()["workspaces"]), ["ALPHA"])

    def test_backups_that_cannot_be_read_are_named_and_counted(self):
        # Regression: they were skipped without a word, so a session could
        # start without a workspace and nobody would know why.
        folder = self.own_backup_dir()
        (folder / "notes.txt").write_text("nothing to see", encoding="utf-8")
        (folder / "BROKEN_T.txt").write_text(
            f"{srv.BACKUP_START}{{oops{srv.BACKUP_END}", encoding="utf-8"
        )
        (folder / "ALPHA_Patrol.txt").write_text(
            srv.render_backup({"ALPHA": [report()]}, {}, {}, {})[1], encoding="utf-8"
        )
        (folder / srv.SHARED_SETTINGS_NAME).write_text("[1, 2]", encoding="utf-8")
        with mock.patch.object(srv, "safe_print") as printed:
            skipped = srv.load_data_from_disk()
        self.assertEqual(skipped, 3)
        lines = sorted(c.args[0] for c in printed.call_args_list)
        self.assertEqual(len(lines), 3)
        self.assertTrue(
            lines[0].startswith("[!] Skipped BROKEN_T.txt: its backup data is not valid JSON")
        )
        self.assertEqual(lines[1], f"[!] Skipped {srv.SHARED_SETTINGS_NAME}: not a JSON object")
        self.assertEqual(lines[2], "[!] Skipped notes.txt: no backup data block in it")
        self.assertEqual(list(srv.DATA_STORE["workspaces"]), ["ALPHA"], "the good one still loads")
        with mock.patch.object(srv, "safe_print") as printed:
            srv.run_boot_dashboard(skipped=skipped)
        banner = "\n".join(c.args[0] for c in printed.call_args_list)
        self.assertIn("Skipped     : 3 backup file(s)", banner)

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

        # A folder of its own: the shared one can hold a newer file another
        # test (or its save still finishing) left, seen on a slow Windows runner.
        folder = Path(tempfile.mkdtemp(prefix="salt-boot-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        patch = mock.patch.object(srv, "BACKUP_DIR", str(folder))
        patch.start()
        self.addCleanup(patch.stop)
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
            self.assertRegex(resp.readline(), NOTICE)

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
        self.assertNotIn("127.0.0.1", srv.client_workspace, "and where it was")

    def test_sync_says_which_workspace_each_connected_editor_is_in(self):
        self.post("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}})
        resp = self.open_events()
        resp.readline()
        try:
            self.assertTrue(self.wait_until(lambda: len(srv.sse_clients) == 1))
            self.assertEqual(self.sync()["connected_where"], {}, "nowhere yet")
            self.post("/api/save_config", {"config": {"ato": "ALPHA", "title": "Patrol"}})
            self.assertEqual(self.sync()["connected_where"], {"AB": "ALPHA"})
            # A report saved says it too, and the config (what viewers are
            # shown) is left as it was.
            self.post("/api/save_reports", {"ato": "BRAVO", "reports": [report(ato="BRAVO")]})
            state = self.sync()
            self.assertEqual(state["connected_where"], {"AB": "BRAVO"})
            self.assertEqual(state["config"]["ato"], "ALPHA")
            # A backup sends every workspace in it: it doesn't move anyone.
            backup = {"ato": "CHARLIE", "reports": [report(rid="c1")], "source": "backup"}
            self.post("/api/save_reports", backup)
            self.assertEqual(self.sync()["connected_where"], {"AB": "BRAVO"})
            # Unloaded, it's nobody's workspace any more.
            self.post("/api/unload_ato", {"ato": "BRAVO"})
            self.assertEqual(self.sync()["connected_where"], {})
        finally:
            resp.close()

    # -- the Activity list ---------------------------------------------------- #
    def said(self):
        """The Activity list as /api/sync gives it: (who, what, ato), oldest first."""
        return [(e["who"], e["what"], e["ato"]) for e in self.sync()["activity"]]

    def test_the_activity_list_says_each_kind_of_write_in_plain_words(self):
        self.assertEqual(self.sync()["activity"], [], "empty at the start")
        steps = (
            ("/api/save_profile", {"profile": {"initials": "AB", "color": "#32d74b"}}),
            ("/api/save_reports", {"ato": "ALPHA", "reports": [report()]}),
            ("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=2, size="3x T-72")]}),
            (
                "/api/save_reports",
                {"ato": "ALPHA", "reports": [report("r2", "ALPHA002"), report("r3", "ALPHA003")]},
            ),
            ("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=3, deleted=True)]}),
            ("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=4)]}),
            (
                "/api/save_reports",
                {
                    "ato": "ALPHA",
                    "reports": [
                        report("r2", "ALPHA002", lm=2, deleted=True),
                        report("r3", "ALPHA003", lm=2, deleted=True),
                        report("r4", "ALPHA004"),
                    ],
                },
            ),
            (
                "/api/edit_report",
                {
                    "ato": "ALPHA",
                    "reportId": "r1",
                    "fields": {"size": "4x T-72", "lastModified": 5},
                },
            ),
            (
                "/api/save_reports",
                {"ato": "ALPHA", "reports": [report(lm=6, history=[{"lastModified": 1}])]},
            ),
            (
                "/api/delete_history",
                {"ato": "ALPHA", "deletions": [{"reportId": "r1", "lastModified": 1}]},
            ),
            (
                "/api/save_reports",
                {
                    "ato": "BRAVO",
                    "reports": [report(f"b{n}", f"BRAVO00{n}", ato="BRAVO") for n in (1, 2, 3)],
                    "source": "csv",
                },
            ),
            ("/api/unload_ato", {"ato": "BRAVO"}),
            ("/api/save_config", {"config": {"ato": "CHARLIE", "title": "Patrol"}}),
            ("/api/save_config", {"config": {"ato": "CHARLIE", "title": "Screen"}}),
            ("/api/save_format", {"format": {"preset": "custom", "lines": [{"type": "id"}]}}),
            ("/api/save_overlays", {"overlays": [NAI1]}),
            (
                "/api/save_basemaps",
                {
                    "basemaps": [
                        {
                            "name": "Topo",
                            "kind": "tiles",
                            "url": "http://10.0.0.5/t/{z}/{y}/{x}.png",
                        }
                    ]
                },
            ),
            ("/api/save_narrative", {"narrative": {"enemy": "OPFOR"}}),
        )
        for path, body in steps:
            self.assertEqual(self.post(path, body)[0], 200, path)
        self.assertEqual(
            self.said(),
            [
                ("AB", "set their profile", ""),
                ("AB", "logged ALPHA001", "ALPHA"),
                ("AB", "updated ALPHA001", "ALPHA"),
                ("AB", "logged 2 reports", "ALPHA"),
                ("AB", "deleted ALPHA001", "ALPHA"),
                ("AB", "restored ALPHA001", "ALPHA"),
                ("AB", "logged ALPHA004, deleted 2 reports", "ALPHA"),
                ("AB", "updated ALPHA001", "ALPHA"),
                ("AB", "updated ALPHA001", "ALPHA"),
                ("AB", "removed 1 earlier version of ALPHA001", "ALPHA"),
                ("AB", "imported 3 reports", "BRAVO"),
                ("AB", "unloaded BRAVO", "BRAVO"),
                ("AB", "moved to CHARLIE", "CHARLIE"),
                ("AB", "set the title of CHARLIE", "CHARLIE"),
                ("AB", "changed the report format", ""),
                ("AB", "changed the overlays", ""),
                ("AB", "changed the basemaps", ""),
                ("AB", "changed the narrative settings", ""),
            ],
        )
        entry = self.sync()["activity"][-1]
        self.assertEqual(set(entry), {"at", "who", "what", "ato"}, "no addresses")
        self.assertAlmostEqual(entry["at"] / 1000, time.time(), delta=60)

    def test_the_activity_list_leaves_out_writes_that_change_nothing(self):
        self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report(lm=5)]})
        for body in (
            # The same again, an older copy, and only a new stamp.
            {"ato": "ALPHA", "reports": [report(lm=5)]},
            {"ato": "ALPHA", "reports": [report(lm=4, size="stale")]},
            {"ato": "ALPHA", "reports": [report(lm=6)]},
            # Deleted before the server ever had it.
            {"ato": "ALPHA", "reports": [report("r9", "ALPHA009", deleted=True)]},
            # An import of what it already holds.
            {"ato": "ALPHA", "reports": [report(lm=6)], "source": "backup"},
        ):
            self.assertEqual(self.post("/api/save_reports", body)[0], 200)
        edit = {"ato": "ALPHA", "reportId": "r1", "fields": {"size": "2x T-72"}}
        self.assertEqual(self.post("/api/edit_report", edit)[0], 200)
        self.assertEqual([what for _, what, _ in self.said()], ["logged ALPHA001"])

    def test_the_activity_list_names_the_drone(self):
        drone = {"name": "GE 1", "grid": "11S NV 39697 06762", "at": 1793018940000}
        other = {**drone, "name": "GE 2"}
        for drones in (
            [drone],
            [drone, other],
            [drone, {**other, "grid": "11S NV 40000 07000"}],
            [drone, {**other, "grid": "11S NV 40000 07000", "range": 5}],
            [drone, {**other, "grid": "11S NV 40000 07000", "range": 5, "offStation": True}],
            [drone, {**other, "grid": "11S NV 40000 07000", "range": 5}],
            [drone, {**other, "grid": "11S NV 40000 07000", "range": 6, "offStation": True}],
            [drone],
            [{**drone, "name": "GE 3"}, other],
            [],
        ):
            self.assertEqual(self.post("/api/save_drones", {"drones": drones})[0], 200)
        self.assertEqual(
            [what for _, what, _ in self.said()],
            [
                "added drone GE 1",
                "added drone GE 2",
                "moved drone GE 2",
                "changed drone GE 2",
                "took drone GE 2 off station",
                "put drone GE 2 on station",
                "changed drone GE 2",
                "removed drone GE 2",
                "changed the drones",
                "changed the drones",
            ],
        )

    def test_the_activity_list_names_the_tag(self):
        routes = {"id": "tag-a1", "name": "Routes", "color": "#ff9f0a"}
        eas = {"id": "tag-b2", "name": "EAs", "color": "#bf5af2"}
        for tags in (
            [routes],
            [routes, eas],
            [routes, {**eas, "name": "Engagement areas"}],
            [routes, {**eas, "name": "Engagement areas", "color": "#000000"}],
            [routes],
            [],
        ):
            self.assertEqual(self.post("/api/save_tags", {"tags": tags})[0], 200)
        self.assertEqual(
            [what for _, what, _ in self.said()],
            [
                "added tag Routes",
                "added tag EAs",
                "renamed tag EAs to Engagement areas",
                "recolored tag Engagement areas",
                "removed tag Engagement areas",
                "removed tag Routes",
            ],
        )

    def test_the_activity_list_says_who_from_their_initials(self):
        # Not known yet: no one, and the page says "Someone".
        self.post("/api/save_overlays", {"overlays": [NAI1]})
        # Learned from the reports this machine writes, as attribution is.
        self.post(
            "/api/save_reports",
            {"ato": "ALPHA", "reports": [report(user={"initials": "CD", "color": "#ff9f0a"})]},
        )
        # Moved by a switch alone (the config already said so): still said.
        self.post("/api/save_config", {"config": {"ato": "BRAVO", "title": "Patrol"}})
        srv.client_workspace.clear()
        self.post("/api/save_config", {"config": {"ato": "BRAVO", "title": "Patrol"}})
        self.assertEqual(
            self.said(),
            [
                ("", "changed the overlays", ""),
                ("CD", "logged ALPHA001", "ALPHA"),
                ("CD", "moved to BRAVO", "BRAVO"),
                ("CD", "moved to BRAVO", "BRAVO"),
            ],
        )

    def test_the_activity_list_keeps_the_last_fifty(self):
        reports = [report(f"r{n}", f"ALPHA{n:03}") for n in range(55)]
        for r in reports:
            self.post("/api/save_reports", {"ato": "ALPHA", "reports": [r]})
        said = [what for _, what, _ in self.said()]
        self.assertEqual(len(said), srv.ACTIVITY_KEEP)
        self.assertEqual((said[0], said[-1]), ("logged ALPHA005", "logged ALPHA054"), "newest last")

    def test_every_change_is_numbered_in_syncs_replies_and_notices(self):
        first = self.sync()
        self.assertEqual(first["server_version"], srv.APP_VERSION)
        status, reply = self.post("/api/save_reports", {"ato": "ALPHA", "reports": [report()]})
        self.assertEqual(status, 200)
        self.assertGreater(reply["version"], first["version"])
        self.assertGreaterEqual(self.sync()["version"], reply["version"])
        # A write that changes nothing takes no number.
        cfg = {"config": {"ato": "ALPHA", "title": "Patrol"}}
        self.post("/api/save_config", cfg)
        self.assertNotIn("version", self.post("/api/save_config", cfg)[1])
        # The stream opens with the latest number.
        with contextlib.closing(self.open_events()) as resp:
            line = resp.readline()
        self.assertEqual(json.loads(line[len(b"data: ") :])["v"], srv.current_version())

    def test_changes_close_together_go_out_as_one_notice(self):
        sent = io.BytesIO()
        client = srv.SSEClient(sent, "10.0.0.9")
        with mock.patch.object(srv, "BROADCAST_BATCH_SECONDS", 0.2):
            srv.sse_clients.append(client)
            try:
                versions = [srv.broadcast_update() for _ in range(3)]
                self.assertEqual(sent.getvalue(), b"", "not yet")
                self.assertTrue(self.wait_until(lambda: sent.getvalue()))
                time.sleep(0.3)
            finally:
                srv.sse_clients.remove(client)
        self.assertEqual(sent.getvalue(), b'data: {"v":%d}\n\n' % versions[-1], "one, the newest")

    def test_health_needs_no_code_and_says_whether_it_is_saving(self):
        for base in (self.base, self.viewer_base):
            status, raw = self.request("/api/health", base=base, code=None)
            self.assertEqual(status, 200)
            health = json.loads(raw)
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["version"], srv.APP_VERSION)
            self.assertGreaterEqual(health["uptime_seconds"], 0)
            self.assertIn("last_saved", health)
            self.assertNotIn("workspaces", health, "nothing about the reports")
        with mock.patch.object(srv, "_save_failures", 2):
            self.assertEqual(srv.health()["status"], "not saving")
        with mock.patch.object(srv, "_last_saved_at", 1793000000.0):
            self.assertEqual(srv.health()["last_saved"], "2026-10-26T07:33:20Z")

    def test_the_console_lists_the_machines_connected(self):
        clients = [
            srv.SSEClient(io.BytesIO(), ip)
            for ip in ("127.0.0.1", "10.0.0.7", "10.0.0.7", "10.0.0.8")
        ]
        srv.client_initials.update({"127.0.0.1": "AB", "10.0.0.7": "CD"})
        srv.client_workspace.update({"127.0.0.1": "ALPHA"})
        with mock.patch.object(srv, "sse_clients", clients):
            self.assertEqual(
                srv.machines_line(),
                "[*] Connected (3): AB at this computer in ALPHA; CD at 10.0.0.7; no name at 10.0.0.8",
            )
        with mock.patch.object(srv, "sse_clients", []):
            self.assertEqual(srv.machines_line(), "[*] Nobody is connected.")

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
            with (
                mock.patch.object(srv, "flush_pending_save") as flush,
                mock.patch.object(srv, "stop_terrain"),  # the other tests' pool stays
                mock.patch.object(srv, "safe_print"),
            ):
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

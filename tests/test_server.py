"""Tests for the sync server: pure logic plus HTTP behaviour against a live instance.

Standard library only, matching the project's zero-dependency rule. Run with
``python -m unittest discover -s tests``.
"""

from __future__ import annotations

import contextlib
import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import salt_sync_server as srv  # noqa: E402


def reset_state() -> None:
    """Return every piece of module-level server state to a fresh boot."""
    srv.DATA_STORE.clear()
    srv.DATA_STORE.update(
        {"workspaces": {}, "config": {"ato": "", "title": ""}, "profiles": {}, "formats": {}}
    )
    srv.workspace_sources.clear()
    srv.client_initials.clear()
    srv._rate_buckets.clear()
    srv.invalidate_sync_cache()


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

    def test_profile_validation(self):
        self.assertIsNone(srv._v_save_profile({"profile": {"initials": "AB", "color": "#32d74b"}}))
        self.assertRejects(srv._v_save_profile, {"profile": {"color": "#32d74b"}}, "initials")
        self.assertRejects(srv._v_save_profile, {"profile": {"initials": "ABCD"}}, "initials")


# --------------------------------------------------------------------------- #
# Rate limiting and access control
# --------------------------------------------------------------------------- #
class RateLimitTests(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_burst_then_reject_then_refill(self):
        clock = [1000.0]
        with (
            mock.patch.object(srv.time, "time", lambda: clock[0]),
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

    def test_bad_content_length_is_its_own_error(self):
        status, raw = self.request(
            "/api/save_reports", raw=b"{}", headers={"Content-Length": "abc"}
        )
        self.assertEqual(status, 400)
        self.assertIn(b"Content-Length", raw)

    def test_oversized_bodies_are_refused(self):
        with mock.patch.object(srv, "MAX_BODY_BYTES", 64):
            status, _ = self.post("/api/save_reports", {"ato": "A", "reports": [report()]})
        self.assertEqual(status, 413)

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

    def test_formats_round_trip_through_sync(self):
        fmt = {"preset": "salt-u", "lines": [{"type": "size"}, {"type": "id"}]}
        self.assertEqual(self.post("/api/save_format", {"ato": "alpha", "format": fmt})[0], 200)
        self.assertEqual(self.sync()["formats"], {"ALPHA": fmt})

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

    # -- live updates -------------------------------------------------------- #
    def test_event_stream_opens_with_an_update(self):
        req = urllib.request.Request(
            self.base + "/api/events", headers={"Cookie": f"salt_access={CODE}"}
        )
        with contextlib.closing(urllib.request.urlopen(req, timeout=5)) as resp:
            self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
            self.assertEqual(resp.readline(), b"data: update\n")


if __name__ == "__main__":
    unittest.main()

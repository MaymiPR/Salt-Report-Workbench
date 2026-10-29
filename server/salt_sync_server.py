# SPDX-License-Identifier: AGPL-3.0-only

"""S.A.L.T. Report Workbench sync server.

Serves the bundled page and keeps every connected browser in step: clients
push reports with POSTs, the server merges them (newest edit wins), tells
everyone over Server-Sent Events that something changed, and writes a
readable backup file. An optional second port serves the same data read-only.

Standard library only, so it runs on a stock Python 3.10+ install.
See docs/ARCHITECTURE.md for the design.
"""

import argparse
import base64
import contextlib
import ctypes
import functools
import gzip
import hashlib
import http.client
import http.server as server
import ipaddress
import json
import math
import os
import re
import secrets
import select
import shutil
import socket
import socketserver
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

try:
    import ssl
except ImportError:  # a Python built without OpenSSL can only run with --no-https
    ssl = None

# As early as it can be: the imports above work on older Pythons too, and what
# follows (annotations like ``int | None``) needs 3.10. The file is kept free of
# syntax 3.8 and 3.9 can't parse, so they reach this line and say why plainly.
if sys.version_info < (3, 10):  # noqa: UP036
    sys.exit(
        'The S.A.L.T. sync server needs Python 3.10 or newer; this is Python '
        + sys.version.split()[0]
        + '.'
    )

# Contents: each is a banner below, in this order.
#
#   Configuration             ports, folders, file names, timeouts and caps
#   State                     the locks, caches and registries request threads share
#   SSE                       numbered changes, update notices, who is connected
#   Utilities                 printing, saving soon, the audit log, the access code
#   Validation                request limits, and one validator per POST body
#   Shared settings           SHARED_SECTIONS, one per shared setting; DATA_STORE
#   Map services              /api/wms_fetch and the /api/basemap proxy
#   Rate limiting             token buckets per address
#   Backup parsing & merging  a backup file's JSON, and merging reports by id
#   Disk I/O                  loading at boot, the backup files, snapshots, saving
#   HTTP request handler      SaltSyncHandler: replies, refusals, each route's handler
#   Routes                    ROUTES: each path, its handler, validator, who may use it
#   HTTPS                     the server's own certificate, the redirect from http://
#   Server                    SaltSyncServer, the listener
#   Boot                      the banner, the command line, --restore, shutting down


# =============================================================================
# Configuration
# =============================================================================

PORT: int = 8080
HOST: str = '0.0.0.0'
# Viewer port — second listener, POSTs return 405. `--viewer-port 0` disables. Bind failure is non-fatal for editor.
VIEWER_PORT: int | None = 8081
_HERE = os.path.dirname(os.path.abspath(__file__))
# Next to the server (as documented), not the launch directory.
BACKUP_DIR = os.path.join(_HERE, 'Auto Backups')
# Cap on incoming POST bodies. A client with no record of the server's copy
# (right after a reload) pushes a whole workspace, so this has to fit a long
# operation's worth of reports with their history.
MAX_BODY_BYTES: int = 16 * 1024 * 1024
# Refused bodies up to this size are read and dropped so the client gets the
# error reply (see SaltSyncHandler._discard_body); larger ones just close.
MAX_DRAIN_BYTES: int = 2 * MAX_BODY_BYTES
SAVE_DEBOUNCE_SECONDS: float = 0.5  # coalesce rapid mutations into one disk write
# A save that fails (a backup held open by antivirus or a sync client such as
# OneDrive, a full disk) is tried again after these waits, then every last one.
SAVE_RETRY_SECONDS: tuple = (1.0, 2.0, 5.0, 30.0)
# The backup file is rewritten within half a second of every change, so a bad
# import or a wrong delete replaces the only copy at once. A dated copy of
# every backup goes to BACKUP_DIR/snapshots/ at most once an hour (and on every
# start), and the oldest rounds are pruned past SNAPSHOT_KEEP, so two days of
# hourly history is kept however many workspaces there are.
SNAPSHOT_DIR_NAME = 'snapshots'
SNAPSHOT_INTERVAL_SECONDS: float = 3600.0
SNAPSHOT_KEEP: int = 48
# One line per accepted write (when, who, what), beside the backups.
AUDIT_LOG_NAME = 'audit.log'
# How many changes the Activity list (Manage > Workspaces) keeps: the newest.
ACTIVITY_KEEP = 50
# The settings every workspace shares (SHARED_SECTIONS), beside the backups in
# a file of their own, so they last with no workspace loaded. Not a .txt: the
# loader never takes it for a workspace backup. Workspace backups still carry
# them too, for older versions.
SHARED_SETTINGS_NAME = 'Shared settings.json'

# The bundled page sits beside the server in a built `dist/` folder; when run
# straight from `server/` during development, fall back to `../dist/`.
WORKBENCH_CANDIDATES = (
    os.path.join(_HERE, 'index.html'),
    os.path.join(_HERE, os.pardir, 'dist', 'index.html'),
)
WORKBENCH_HTML = next(
    (p for p in WORKBENCH_CANDIDATES if os.path.isfile(p)), WORKBENCH_CANDIDATES[0]
)
BACKUP_START = '##SALT_BACKUP##'
BACKUP_END = '##SALT_BACKUP_END##'
# /api/wms_fetch: the server reads a WMS address for an editor's page when the
# service won't let the page read it itself (no CORS headers).
WMS_FETCH_MAX_URL = 4000
WMS_FETCH_MAX_BYTES = 5 * 1024 * 1024
WMS_FETCH_TIMEOUT = 15
# /api/basemap: an HTTPS page can't load map images from an http:// basemap, so
# the server fetches them, from the hosts of the saved basemaps only.
BASEMAP_PROXY_MAX_BYTES = 16 * 1024 * 1024
# HTTPS: the server's own certificate lives in the backup folder's tls/ and is
# made again this many days before it runs out. A new connection gets
# TLS_HANDSHAKE_TIMEOUT seconds to start its handshake (or its plain request).
TLS_DIR_NAME = 'tls'
TLS_CERT_DAYS = 825
TLS_RENEW_DAYS = 30
TLS_HANDSHAKE_TIMEOUT = 10
# Seconds a connection may sit idle mid-request before it is closed. Not the
# event stream, which stays open; see SaltSyncHandler.timeout.
REQUEST_IDLE_TIMEOUT = 30
# Event streams one machine may hold open at once (a tab each); a new one past
# this closes that machine's oldest, which is most likely a tab long gone.
MAX_SSE_PER_MACHINE = 10
_SECURITY_HEADERS = (
    ('X-Frame-Options', 'DENY'),
    ('Content-Security-Policy', "frame-ancestors 'none'"),
    ('X-Content-Type-Options', 'nosniff'),
)


# =============================================================================
# State
# =============================================================================

# Guards DATA_STORE (the reports and shared settings, made from SHARED_SECTIONS
# under Shared settings below) and everything marked "Protected by data_lock".
data_lock = threading.Lock()

# Cached /api/sync prefix — all but the closing brace and connected_users count. Invalidated on every mutation.
_sync_cache_prefix: bytes | None = None  # protected by data_lock
# The last /api/sync body and its gzip form. Every client pulls the same state
# after a change, so one compression serves them all. Protected by _sync_gz_lock.
_sync_gz_cache: tuple[bytes, bytes] | None = None
_sync_gz_lock = threading.Lock()
# Seconds between SSE heartbeats; each one also detects a client that left without a FIN.
SSE_HEARTBEAT_SECONDS: float = 15.0

# Per-workspace provenance (ato -> source label). Rides on /api/sync. Protected by data_lock.
workspace_sources: dict = {}

# Workspaces unloaded since the server started, until someone works in one
# again. Each editor keeps their own workspace, so an editor in one of these is
# told to leave it by this list, not by the config. Rides on /api/sync.
# Protected by data_lock.
unloaded_workspaces: set = set()

# The last changes, for the Activity list: {at (ms), who (initials, or ''),
# what (plain words), ato (the workspace, or '')}, newest last. In memory only,
# so a restart empties it, and no addresses. Rides on /api/sync. Protected by
# _activity_lock.
activity_log: deque = deque(maxlen=ACTIVITY_KEEP)
_activity_lock = threading.Lock()

# This release. The page carries the same (APP_VERSION in src/app/10-state.js)
# and warns when the two differ; tests/test_docs.py checks they agree.
APP_VERSION = '2.30.0'
# When this server started, for /api/health.
STARTED_AT = time.time()

# --- SSE client registry ---
sse_lock = threading.Lock()
sse_clients: list = []

# Every change anyone can see (the data, or who is connected and where) takes
# the next number. /api/sync says the number its answer is as of, update
# notices say the newest, and a write's reply says its own, so a page skips a
# pull it is already up to date for and drops an answer older than what it
# has seen. Protected by _version_lock.
# Numbers start at the boot time in milliseconds, so a restarted server's
# are still higher than any a page heard from the one before.
_sync_version = int(time.time() * 1000)
_version_lock = threading.Lock()
# Changes this close together go out as one notice: an import or a busy
# minute sends each page one pull, not dozens.
BROADCAST_BATCH_SECONDS: float = 0.15
_notice_timer: threading.Timer | None = None
_notice_lock = threading.Lock()

# Machine (see _machine) -> initials. Powers the deduped /api/sync connected list
# and server-stamped attribution on report saves. Pruned on SSE disconnect. Protected by sse_lock.
client_initials: dict = {}
# Machine -> the workspace its editor is in, from their switches and saves:
# each editor has their own, and /api/sync says who is where. Pruned with
# client_initials. Protected by sse_lock.
client_workspace: dict = {}

# --- Debounced disk-write state ---
_save_timer: threading.Timer | None = None
_save_timer_lock = threading.Lock()

# --- Access code (editor-port gate) ---
# Random per-launch code; host shares it verbally with editors. Viewer port is NOT
# gated. Host's browser auto-fills via meta injection on 127.0.0.1 requests.
# No look-alikes (0/O, 1/I/l, 5/S), so the code can be read aloud over a radio.
ACCESS_CODE_ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ'
ACCESS_CODE_LENGTH = 10
# --access-code overrides: characters a browser cookie carries unchanged, and
# at least six of them, so a chosen code is not guessed in a few tries.
ACCESS_CODE_OVERRIDE_RE = re.compile(r'[A-Za-z0-9_-]{6,64}')
# Set at boot (parse_cli_args). None means access-code auth is disabled.
_access_code: str | None = None


def _generate_access_code() -> str:
    """10-char code from a confusable-free alphabet, cryptographically random."""
    return ''.join(secrets.choice(ACCESS_CODE_ALPHABET) for _ in range(ACCESS_CODE_LENGTH))


# --- Workbench HTML cache: (mtime, bytes) auto-invalidates if HTML is rebuilt while running. ---
_workbench_html_cache: tuple[float, bytes] | None = None
_workbench_html_lock = threading.Lock()


# =============================================================================
# SSE
# =============================================================================


class SSEClient:
    """Thread-safe SSE writer. ``ip`` is the machine key (see _machine), not the
    raw address: every address of the host is one machine. ``sock``, when
    given, lets the stream be closed from another thread."""

    __slots__ = ('_lock', 'ip', 'sock', 'wfile')

    def __init__(self, wfile, ip: str = '', sock=None):
        self.wfile = wfile
        self._lock = threading.Lock()
        self.ip = ip
        self.sock = sock

    def close(self) -> None:
        """End the stream: its thread sees the connection close and cleans up."""
        if self.sock is not None:
            with contextlib.suppress(OSError):
                self.sock.shutdown(socket.SHUT_RDWR)

    def send(self, payload: bytes) -> bool:
        """Write to SSE stream; False on disconnect."""
        with self._lock:
            try:
                self.wfile.write(payload)
                self.wfile.flush()
                return True
            except Exception:
                return False


def current_version() -> int:
    """The number of the latest change."""
    with _version_lock:
        return _sync_version


def update_notice() -> bytes:
    """An SSE message saying the latest change's number."""
    return b'data: {"v":%d}\n\n' % current_version()


def broadcast_update() -> int:
    """Number a change and have every SSE client told within
    BROADCAST_BATCH_SECONDS; returns the change's number. Called after the
    change is in place, so a page told this number finds it in a pull."""
    global _sync_version, _notice_timer
    with _version_lock:
        _sync_version += 1
        version = _sync_version
    with _notice_lock:
        if _notice_timer is None:
            _notice_timer = threading.Timer(BROADCAST_BATCH_SECONDS, _send_notice)
            _notice_timer.daemon = True
            _notice_timer.start()
    return version


# The host sees who is connected: a line on the console when a machine joins
# or leaves, or one changes name or workspace, at most once a second.
MACHINES_SAY_SECONDS: float = 1.0
_machines_timer: threading.Timer | None = None
_machines_said = ''


def note_machines() -> None:
    """Have the console list the connected machines again, shortly."""
    global _machines_timer
    with _notice_lock:
        if _machines_timer is None:
            _machines_timer = threading.Timer(MACHINES_SAY_SECONDS, _say_machines)
            _machines_timer.daemon = True
            _machines_timer.start()


def machines_line() -> str:
    """The connected machines, one each however many tabs: initials (when the
    server knows them), address and workspace."""
    with sse_lock:
        parts = []
        for ip in dict.fromkeys(c.ip for c in sse_clients):
            ini = client_initials.get(ip) or 'no name'
            where = 'this computer' if ip == '127.0.0.1' else ip
            ato = client_workspace.get(ip)
            parts.append(f'{ini} at {where}' + (f' in {ato}' if ato else ''))
    if not parts:
        return '[*] Nobody is connected.'
    return f'[*] Connected ({len(parts)}): ' + '; '.join(parts)


def _say_machines() -> None:
    global _machines_timer, _machines_said
    with _notice_lock:
        _machines_timer = None
    line = machines_line()
    if line != _machines_said:
        _machines_said = line
        safe_print(line)


def _send_notice() -> None:
    """Tell every SSE client the latest change's number; prune dead ones.
    Snapshots under lock, writes lock-free so a stuck peer can't block other ops."""
    global _notice_timer
    with _notice_lock:
        _notice_timer = None
    payload = update_notice()
    with sse_lock:
        snapshot = list(sse_clients)
    dead = [c for c in snapshot if not c.send(payload)]
    if dead:
        # Filter rather than .remove() — entries may have been pruned by their own SSE thread.
        with sse_lock:
            sse_clients[:] = [c for c in sse_clients if c not in dead]


# =============================================================================
# Utilities
# =============================================================================


def safe_print(msg: str) -> None:
    """Print with fallback for legacy Windows codepages that can't render non-ASCII.

    Flushes every line: when stdout is redirected (a log file, a service
    wrapper) Python block-buffers it, and the boot banner, including the
    access code, would otherwise not appear until the buffer happened to fill.
    """
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode('ascii', 'ignore').decode('ascii'), flush=True)


def invalidate_sync_cache() -> None:
    """Drop cached /api/sync prefix. Must be called while holding data_lock."""
    global _sync_cache_prefix
    _sync_cache_prefix = None


# Workspaces changed since the last disk write; None means every workspace
# (at boot, so the first save writes each one its own file). Protected by data_lock.
_dirty_atos: set | None = None
# The shared settings changed since Shared settings.json was last written
# (True at boot, so the first save writes it). Protected by data_lock.
_shared_dirty: bool = True


def mark_dirty(ato: str | None = None) -> None:
    """Note that ``ato`` (or, with None, every workspace and the shared
    settings) needs writing. Caller holds data_lock."""
    global _dirty_atos, _shared_dirty
    if ato is None:
        _dirty_atos = None
        _shared_dirty = True
    elif _dirty_atos is not None:
        _dirty_atos.add(ato)


def schedule_save() -> None:
    """Debounced disk write — coalesces bursts within SAVE_DEBOUNCE_SECONDS."""
    global _save_timer
    with _save_timer_lock:
        if _save_timer is not None:
            _save_timer.cancel()
        _save_timer = threading.Timer(SAVE_DEBOUNCE_SECONDS, save_data_to_disk)
        _save_timer.daemon = True
        _save_timer.start()


def _retry_save_in(delay: float) -> None:
    """Try a failed save again after ``delay`` seconds, unless one is already
    pending (a change since schedules one sooner)."""
    global _save_timer
    with _save_timer_lock:
        pending = _save_timer
        if pending is not None and pending is not threading.current_thread() and pending.is_alive():
            return
        _save_timer = threading.Timer(delay, save_data_to_disk)
        _save_timer.daemon = True
        _save_timer.start()


def flush_pending_save() -> None:
    """Cancel debounce and flush immediately — for graceful shutdown."""
    global _save_timer
    with _save_timer_lock:
        if _save_timer is not None:
            _save_timer.cancel()
            _save_timer = None
    save_data_to_disk()


_audit_lock = threading.Lock()
_audit_failed = False


def audit(actor: str, what: str) -> None:
    """Append one line to ``BACKUP_DIR/audit.log``: when, who, what.

    Answers "who changed this, and when" after the fact. Operators are named
    by the initials the server knows for their address, else the address
    alone. A log that can't be written is reported once and never stops a
    request.
    """
    global _audit_failed
    stamp = f'{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}'
    line = f'{stamp}  {actor:<20}  {" ".join(what.split())}\n'
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        log = os.path.join(BACKUP_DIR, AUDIT_LOG_NAME)
        # One line, unparenthesized: Python 3.8 can't parse a parenthesized
        # `with`, and must get as far as the version check at the top.
        with _audit_lock, open(log, 'a', encoding='utf-8') as f:
            f.write(line)
    except OSError as exc:
        if not _audit_failed:
            _audit_failed = True
            safe_print(f'[!] Could not write {AUDIT_LOG_NAME}: {exc}')


def plural(n: int, word: str) -> str:
    """``3 reports``, ``1 report``: as the page's plural() says it."""
    return f'{n} {word}{"" if n == 1 else "s"}'


def note_activity(who: str, what: str, ato: str = '') -> None:
    """Add a change to the Activity list: who made it (their initials, or ''
    while the server doesn't know them), what it did in plain words, and in
    which workspace. Called before the change is numbered, so the pull that
    number brings has it."""
    entry = {'at': int(time.time() * 1000), 'who': who, 'what': what, 'ato': ato}
    with _activity_lock:
        activity_log.append(entry)


def activity() -> list:
    """The Activity list as it is, oldest first."""
    with _activity_lock:
        return list(activity_log)


def get_local_ip() -> str:
    """Return the machine's outward-facing LAN IP."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
        except OSError:
            return '127.0.0.1'


def _get_cookie(headers, name: str) -> str | None:
    """Tiny cookie extractor — pulls a single named cookie out of the
    request's `Cookie` header. Returns None if missing."""
    raw = headers.get('Cookie', '')
    if not raw:
        return None
    for piece in raw.split(';'):
        piece = piece.strip()
        if piece.startswith(name + '='):
            return piece[len(name) + 1 :]
    return None


# (when looked up, the addresses). Re-looked-up after LOCAL_IPS_TTL_SECONDS: the
# host's address can change mid-operation (a DHCP lease, a new network), and a
# cache fixed at boot made the host's own browser lose its free pass until a restart.
_local_ips_cache: tuple[float, set] | None = None
LOCAL_IPS_TTL_SECONDS: float = 60.0


def _local_ips() -> set:
    """All IPs bound to this machine — loopback + hostname-resolved + LAN. Cached briefly."""
    global _local_ips_cache
    now = time.monotonic()
    if _local_ips_cache is None or now - _local_ips_cache[0] > LOCAL_IPS_TTL_SECONDS:
        ips: set = {'127.0.0.1', '::1'}
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None):
                ips.add(info[4][0])
        except Exception:
            pass
        with contextlib.suppress(Exception):
            ips.add(get_local_ip())
        _local_ips_cache = (now, ips)
    return _local_ips_cache[1]


def _is_localhost(ip: str) -> bool:
    """True for any IP bound to this machine — loopback or LAN."""
    if ip.startswith('127.'):
        return True
    return ip in _local_ips()


def _machine(ip: str) -> str:
    """The key that identifies one machine: every address of this host is 127.0.0.1.
    The launcher opens the LAN URL, so a host with a localhost tab too would
    otherwise count as two operators and hold two initials entries."""
    return '127.0.0.1' if _is_localhost(ip) else ip


def _access_code_ok(headers, view_only: bool, client_ip: str) -> bool:
    """Return True if the request is authorized to hit gated endpoints.
    * Viewer-port requests always pass (the port itself is the gate).
    * If access-code auth is disabled (_access_code is None), pass.
    * Localhost passes (the host running the server gets a free ride).
    * Otherwise require a matching `salt_access` cookie."""
    if view_only or _access_code is None:
        return True
    if _is_localhost(client_ip):
        return True
    submitted = (_get_cookie(headers, 'salt_access') or '').upper()
    # Constant-time compare to avoid timing-leak guesses. Bytes, because
    # compare_digest raises on str with non-ASCII characters.
    return secrets.compare_digest(submitted.encode(), _access_code.encode())


def _gzip_sync_body(body: bytes) -> bytes:
    """gzip a /api/sync body, reusing the last result when the body is unchanged."""
    global _sync_gz_cache
    with _sync_gz_lock:
        if _sync_gz_cache is not None and _sync_gz_cache[0] == body:
            return _sync_gz_cache[1]
    packed = gzip.compress(body, compresslevel=5)
    with _sync_gz_lock:
        _sync_gz_cache = (body, packed)
    return packed


def _get_workbench_html() -> bytes | None:
    """Workbench HTML bytes from mtime-keyed cache; None if missing."""
    global _workbench_html_cache
    try:
        mtime = os.path.getmtime(WORKBENCH_HTML)
    except OSError:
        return None
    with _workbench_html_lock:
        if _workbench_html_cache is not None and _workbench_html_cache[0] == mtime:
            return _workbench_html_cache[1]
        with open(WORKBENCH_HTML, 'rb') as f:
            content = f.read()
        _workbench_html_cache = (mtime, content)
        return content


# =============================================================================
# Validation
# =============================================================================
# Each POST route's validator (see ROUTES) checks the body's shape before the
# route sees it. Limits sized for real reports while rejecting obvious abuse.
MAX_ATO_LEN = 50
MAX_TITLE_LEN = 100
MAX_INITIALS_LEN = 3
MAX_FIELD_LEN = 500  # size / activity / location
MAX_ANALYSIS_LEN = 5_000  # yourAnalysis can be longer prose
MAX_ID_LEN = 100  # UUID or displayId
MAX_HISTORY_LEN = 1_000  # per-report history cap
MAX_REPORTS_BATCH = 10_000  # per-request reports[] cap
MAX_DELETIONS_BATCH = 1_000  # per-request delete_history cap
MAX_SOURCE_LEN = 20
MAX_FORMAT_LINES = 20  # builder: lines per report format
MAX_CUSTOM_LABEL = 30  # builder: custom field name
MAX_CUSTOM_VALUE = 500  # builder: custom field value
MAX_CUSTOM_FIELDS = 15  # builder: custom fields per report
MAX_BDA_ENTRIES = 200  # BDA assessments per report
MAX_BDA_TARGET = 200
MAX_BDA_EFFECT = 30
MAX_BDA_NOTE = 500
MAX_OVERLAYS = 500  # NAI / OBJ / PL features, one set shared by every workspace
MAX_DRONES = 10  # drones on the map
MAX_DRONE_NAME = 40
MAX_DRONE_RANGE_KM = 1000  # how far a drone can see, at most
MAX_OVERLAY_NAME = 40
MAX_OVERLAY_LABEL = 100
MAX_BASEMAPS = 20
MAX_BASEMAP_NAME = 60
MAX_BASEMAP_URL = 2000
MAX_BASEMAP_LAYERS = 2000
# What a WMS's capabilities said to ask for: version, projection, image format.
_BASEMAP_WMS_FIELDS = {'version': 10, 'crs': 40, 'format': 60}
MAX_NARRATIVE_NAME = 60  # the enemy's name, and each unit's
MAX_UNITS = 50
MAX_UNIT_PLACES = 40
MAX_PLACE = 40
MAX_EQUIPMENT = 500  # types added to the catalogue
MAX_EQUIPMENT_TYPE = 40
MAX_CUSTOM_RULES = 30
MAX_RULE_TEXT = 120
MAX_RULE_WORDS = 300
# The kinds of equipment (core.js EQUIPMENT_ROLES) and the built-in rules
# (core.js NARRATIVE_RULES) the narrative knows.
_EQUIPMENT_ROLES = frozenset(
    {
        'armor',
        'mech',
        'recon',
        'fires',
        'ad',
        'atgm',
        'engineer',
        'logistics',
        'c2',
        'ew',
        'air',
        'infantry',
        'light',
        'vehicle',  # added in 2.17: a vehicle of no given type
    }
)
_EQUIPMENT_ORIGINS = frozenset({'RU', 'CN', ''})
_NARRATIVE_RULES = frozenset(
    {
        'offense',
        'axes',
        'forward',
        'recon',
        'assembly',
        'reserve',
        'firing',
        'withdrawal',
        'infiltration',
        'airassault',
        'amphibious',
        'defense',
        'antitank',
        'deception',
        'artillery',
        'reconfire',
        'deep',
        'drones',
        'aviation',
        'crossing',
        'breach',
        'cp',
        'adsite',
        'ew',
        'logistics',
        # Added in 2.15.
        'fixing',
        'reconforce',
        'dismount',
        'buildup',
        'lightassault',
        'urban',
        'exploit',
        'encircle',
        'pursuit',
        'counterattack',
        'strongpoint',
        'fortline',
        'screen',
        'remotemine',
        'isr',
        'counterbattery',
        'shootscoot',
        'tankfire',
        'thermobaric',
        'c2strike',
        'sead',
        'interdict',
        'glidebomb',
        'cbrn',
        'logforward',
        'railhead',
        'droneresupply',
        'farp',
        'casevac',
        'regroup',
    }
)
MAX_OVERLAY_POINTS = 200_000  # coordinate pairs in the shared set, all features together
_FORMAT_LINE_TYPES = {'id', 'size', 'activity', 'location', 'time', 'analysis', 'custom'}
# Report fields /api/edit_report may overwrite. History and BDA change through
# save_reports, where merging applies.
_EDITABLE_FIELDS = (
    'size',
    'activity',
    'location',
    'time',
    'yourAnalysis',
    'displayId',
    'fullId',
    'ato',
    'title',
    'updated',
    'custom',
    'user',
    'lastModified',
)

# ISO 8601 with optional fractional seconds, optional Z (tolerates hand-edited legacy backups).
_ISO_TIME_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$')
# Report ids: UUIDs and displayIds, with room for other sane schemes.
_ID_RE = re.compile(rf'[A-Za-z0-9_.:-]{{1,{MAX_ID_LEN}}}')
# Three- or six-digit hex colors — matches the swatch values the UI emits.
_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$')


def _is_str(v, max_len: int | None = None) -> bool:
    if not isinstance(v, str):
        return False
    return max_len is None or len(v) <= max_len


def _is_int(v) -> bool:
    # Exclude bools — isinstance(True, int) is True in Python.
    return isinstance(v, int) and not isinstance(v, bool)


def _check_ato(data: dict) -> str | None:
    """Every request addressed to one workspace names it the same way."""
    ato = data.get('ato')
    if not _is_str(ato, MAX_ATO_LEN) or not ato.strip():
        return f'ato must be a non-empty string ≤{MAX_ATO_LEN} chars'
    return None


def _check_color(c, field: str) -> str | None:
    if not isinstance(c, str) or not _COLOR_RE.match(c):
        return f'{field} must be a hex color (e.g. #0a84ff)'
    return None


def _check_user(u, prefix: str) -> str | None:
    """Optional user object. None → ok; bad shape → error string."""
    if u is None:
        return None
    if not isinstance(u, dict):
        return f'{prefix} must be an object'
    if 'initials' in u and not _is_str(u['initials'], MAX_INITIALS_LEN):
        return f'{prefix}.initials must be a string ≤{MAX_INITIALS_LEN} chars'
    if 'color' in u:
        return _check_color(u['color'], f'{prefix}.color')
    return None


def _check_report_fields(r: dict, prefix: str) -> str | None:
    """SALT fields — shared between top-level reports and history entries."""
    for k in ('size', 'activity', 'location'):
        if k in r and not _is_str(r[k] or '', MAX_FIELD_LEN):
            return f'{prefix}.{k} must be a string ≤{MAX_FIELD_LEN} chars'
    if 'yourAnalysis' in r and not _is_str(r['yourAnalysis'] or '', MAX_ANALYSIS_LEN):
        return f'{prefix}.yourAnalysis must be a string ≤{MAX_ANALYSIS_LEN} chars'
    t = r.get('time', '')
    if t and not (isinstance(t, str) and _ISO_TIME_RE.match(t)):
        return f'{prefix}.time must be ISO 8601 (e.g. 2024-01-15T14:30:00Z)'
    if 'lastModified' in r and not _is_int(r['lastModified']):
        return f'{prefix}.lastModified must be an integer'
    c = r.get('custom')
    if c is not None:
        if not isinstance(c, dict):
            return f'{prefix}.custom must be an object'
        if len(c) > MAX_CUSTOM_FIELDS:
            return f'{prefix}.custom has too many fields (max {MAX_CUSTOM_FIELDS})'
        for k, v in c.items():
            if not _is_str(k, MAX_CUSTOM_LABEL) or not _is_str(v, MAX_CUSTOM_VALUE):
                return f'{prefix}.custom entries must be strings (label ≤{MAX_CUSTOM_LABEL}, value ≤{MAX_CUSTOM_VALUE})'
    return _check_user(r.get('user'), f'{prefix}.user')


# The fields a report is named, sorted and flagged by. A number or a list in
# one of them stopped every later disk save (the backup file is named after the
# title and sorted by displayId), so they are held to their real types.
_REPORT_TEXT_FIELDS = (
    ('displayId', MAX_ID_LEN),
    ('fullId', MAX_FIELD_LEN),  # a CSV import may use a whole cell for it
    ('ato', MAX_ATO_LEN),
    ('title', MAX_TITLE_LEN),
)
_REPORT_FLAG_FIELDS = ('updated', 'deleted')


def _check_report_identity(r: dict, prefix: str) -> str | None:
    """Name and flag fields, where present: strings and true/false (null tolerated)."""
    for k, most in _REPORT_TEXT_FIELDS:
        if r.get(k) is not None and not _is_str(r[k], most):
            return f'{prefix}.{k} must be a string ≤{most} chars'
    for k in _REPORT_FLAG_FIELDS:
        if r.get(k) is not None and not isinstance(r[k], bool):
            return f'{prefix}.{k} must be true or false'
    return None


def _check_report(r, idx: int) -> str | None:
    if not isinstance(r, dict):
        return f'reports[{idx}] must be an object'
    if err := _check_report_identity(r, f'reports[{idx}]'):
        return err
    # At least one identity field; merge path uses either.
    has_id = _is_str(r.get('id'), MAX_ID_LEN) and r.get('id')
    has_did = _is_str(r.get('displayId'), MAX_ID_LEN) and r.get('displayId')
    if not has_id and not has_did:
        return f'reports[{idx}] missing id or displayId'
    # Ids end up in the page's markup on every client, so they are kept to the
    # characters the app itself generates (UUIDs, "ALPHA001").
    if r.get('id') and not (isinstance(r['id'], str) and _ID_RE.fullmatch(r['id'])):
        return f'reports[{idx}].id may only contain letters, digits, "-", "_", "." and ":"'
    if err := _check_report_fields(r, f'reports[{idx}]'):
        return err
    h = r.get('history')
    if h is not None:
        if not isinstance(h, list):
            return f'reports[{idx}].history must be a list'
        if len(h) > MAX_HISTORY_LEN:
            return f'reports[{idx}].history has too many entries (max {MAX_HISTORY_LEN})'
        for j, entry in enumerate(h):
            if not isinstance(entry, dict):
                return f'reports[{idx}].history[{j}] must be an object'
            if err := _check_report_fields(entry, f'reports[{idx}].history[{j}]'):
                return err
    b = r.get('bda')
    if b is not None:
        if not isinstance(b, list):
            return f'reports[{idx}].bda must be a list'
        if len(b) > MAX_BDA_ENTRIES:
            return f'reports[{idx}].bda has too many entries (max {MAX_BDA_ENTRIES})'
        for j, entry in enumerate(b):
            if not isinstance(entry, dict):
                return f'reports[{idx}].bda[{j}] must be an object'
            if 'target' in entry and not _is_str(entry['target'] or '', MAX_BDA_TARGET):
                return f'reports[{idx}].bda[{j}].target must be a string ≤{MAX_BDA_TARGET} chars'
            if 'coords' in entry and not _is_str(entry['coords'] or '', MAX_BDA_TARGET):
                return f'reports[{idx}].bda[{j}].coords must be a string ≤{MAX_BDA_TARGET} chars'
            if 'effect' in entry and not _is_str(entry['effect'] or '', MAX_BDA_EFFECT):
                return f'reports[{idx}].bda[{j}].effect must be a string ≤{MAX_BDA_EFFECT} chars'
            if 'note' in entry and not _is_str(entry['note'] or '', MAX_BDA_NOTE):
                return f'reports[{idx}].bda[{j}].note must be a string ≤{MAX_BDA_NOTE} chars'
            if 'lastModified' in entry and not _is_int(entry['lastModified']):
                return f'reports[{idx}].bda[{j}].lastModified must be an integer'
            if err := _check_user(entry.get('user'), f'reports[{idx}].bda[{j}].user'):
                return err
    return None


def _v_save_reports(data: dict) -> str | None:
    if err := _check_ato(data):
        return err
    reps = data.get('reports')
    if not isinstance(reps, list):
        return 'reports must be a list'
    if len(reps) > MAX_REPORTS_BATCH:
        return f'reports list has too many entries (max {MAX_REPORTS_BATCH})'
    for i, r in enumerate(reps):
        if err := _check_report(r, i):
            return err
    if (
        'source' in data
        and data['source'] is not None
        and not _is_str(data['source'], MAX_SOURCE_LEN)
    ):
        return f'source must be a string ≤{MAX_SOURCE_LEN} chars'
    return None


def _v_edit_report(data: dict) -> str | None:
    if err := _check_ato(data):
        return err
    rid = data.get('reportId')
    if not _is_str(rid, MAX_ID_LEN) or not rid:
        return 'reportId must be a non-empty string'
    fields = data.get('fields')
    if not isinstance(fields, dict):
        return 'fields must be an object'
    if not fields:
        return 'fields must name at least one field'
    # Edit fields share the report shape (it's the same data model).
    if err := _check_report_identity(fields, 'fields'):
        return err
    return _check_report_fields(fields, 'fields')


def _v_delete_history(data: dict) -> str | None:
    if err := _check_ato(data):
        return err
    deletions = data.get('deletions')
    if not isinstance(deletions, list) or not deletions:
        return 'deletions must be a non-empty list'
    if len(deletions) > MAX_DELETIONS_BATCH:
        return f'deletions list has too many entries (max {MAX_DELETIONS_BATCH})'
    for i, d in enumerate(deletions):
        if not isinstance(d, dict):
            return f'deletions[{i}] must be an object'
        if not _is_str(d.get('reportId'), MAX_ID_LEN) or not d.get('reportId'):
            return f'deletions[{i}].reportId is required'
        if not _is_int(d.get('lastModified')):
            return f'deletions[{i}].lastModified must be an integer'
    return None


def _v_save_config(data: dict) -> str | None:
    cfg = data.get('config')
    if cfg is None:
        return None  # handler tolerates missing config (treats as no-op)
    if not isinstance(cfg, dict):
        return 'config must be an object'
    if 'ato' in cfg and not _is_str(cfg['ato'], MAX_ATO_LEN):
        return f'config.ato must be a string ≤{MAX_ATO_LEN} chars'
    if 'title' in cfg and not _is_str(cfg['title'], MAX_TITLE_LEN):
        return f'config.title must be a string ≤{MAX_TITLE_LEN} chars'
    return None


def _v_save_profile(data: dict) -> str | None:
    p = data.get('profile')
    if not isinstance(p, dict):
        return 'profile must be an object'
    if not _is_str(p.get('initials'), MAX_INITIALS_LEN) or not p['initials'].strip():
        return f'profile.initials must be a non-empty string ≤{MAX_INITIALS_LEN} chars'
    if 'color' in p:
        return _check_color(p['color'], 'profile.color')
    return None


def _v_save_format(data: dict) -> str | None:
    fmt = data.get('format')
    if not isinstance(fmt, dict):
        return 'format must be an object'
    lines = fmt.get('lines')
    if not isinstance(lines, list) or not lines:
        return 'format.lines must be a non-empty list'
    if len(lines) > MAX_FORMAT_LINES:
        return f'format.lines has too many entries (max {MAX_FORMAT_LINES})'
    for i, line in enumerate(lines):
        if not isinstance(line, dict):
            return f'format.lines[{i}] must be an object'
        if line.get('type') not in _FORMAT_LINE_TYPES:
            return f'format.lines[{i}].type is not a recognized line type'
        if line.get('type') == 'custom' and (
            not _is_str(line.get('label'), MAX_CUSTOM_LABEL) or not line.get('label')
        ):
            return f'format.lines[{i}].label must be a non-empty string ≤{MAX_CUSTOM_LABEL} chars'
    return None


_OVERLAY_TYPES = {'NAI', 'OBJ', 'PL'}
# Geometry type -> nesting depth of its coordinate arrays above the [lon, lat] pairs.
_GEOMETRY_DEPTH = {
    'Point': 0,
    'LineString': 1,
    'Polygon': 2,
    'MultiLineString': 2,
    'MultiPolygon': 3,
}


def _count_positions(coords, depth: int) -> int | None:
    """Coordinate pairs in a GeoJSON coordinates array, or None if it is malformed."""
    if depth == 0:
        ok = (
            isinstance(coords, list)
            and len(coords) in (2, 3)
            and all(isinstance(c, (int, float)) and not isinstance(c, bool) for c in coords)
            and -180 <= coords[0] <= 180
            and -90 <= coords[1] <= 90
        )
        return 1 if ok else None
    if not isinstance(coords, list) or not coords:
        return None
    total = 0
    for part in coords:
        n = _count_positions(part, depth - 1)
        if n is None:
            return None
        total += n
    return total


def _v_save_overlays(data: dict) -> str | None:
    # The set is shared, so no ATO is needed; one sent by an older page is ignored.
    ovs = data.get('overlays')
    if not isinstance(ovs, list):
        return 'overlays must be a list'
    if len(ovs) > MAX_OVERLAYS:
        return f'too many overlays (max {MAX_OVERLAYS})'
    points = 0
    for i, o in enumerate(ovs):
        if not isinstance(o, dict):
            return f'overlays[{i}] must be an object'
        if o.get('type') not in _OVERLAY_TYPES:
            return f'overlays[{i}].type must be NAI, OBJ or PL'
        if not _is_str(o.get('name'), MAX_OVERLAY_NAME) or not o.get('name'):
            return f'overlays[{i}].name must be a non-empty string ≤{MAX_OVERLAY_NAME} chars'
        if 'label' in o and not _is_str(o['label'], MAX_OVERLAY_LABEL):
            return f'overlays[{i}].label must be a string ≤{MAX_OVERLAY_LABEL} chars'
        g = o.get('geometry')
        depth = _GEOMETRY_DEPTH.get(g.get('type')) if isinstance(g, dict) else None
        if depth is None:
            return (
                f'overlays[{i}].geometry must be a Point, LineString, Polygon, or Multi- of those'
            )
        n = _count_positions(g.get('coordinates'), depth)
        if n is None:
            return f'overlays[{i}].geometry.coordinates are not valid longitude/latitude pairs'
        points += n
    if points > MAX_OVERLAY_POINTS:
        return f'overlays have too many points ({points}; max {MAX_OVERLAY_POINTS})'
    return None


def _v_save_basemaps(data: dict) -> str | None:
    maps = data.get('basemaps')
    if not isinstance(maps, list):
        return 'basemaps must be a list'
    if len(maps) > MAX_BASEMAPS:
        return f'too many basemaps (max {MAX_BASEMAPS})'
    names = set()
    for i, b in enumerate(maps):
        if not isinstance(b, dict):
            return f'basemaps[{i}] must be an object'
        name = b.get('name')
        if not _is_str(name, MAX_BASEMAP_NAME) or not name.strip():
            return f'basemaps[{i}].name must be a non-empty string ≤{MAX_BASEMAP_NAME} chars'
        if name.strip().lower() in names:
            return f'basemaps[{i}].name is used twice'
        names.add(name.strip().lower())
        if b.get('kind') not in ('wms', 'tiles'):
            return f'basemaps[{i}].kind must be wms or tiles'
        url = b.get('url')
        if not _is_str(url, MAX_BASEMAP_URL) or not url.strip().lower().startswith(
            ('http://', 'https://')
        ):
            return f'basemaps[{i}].url must be an http(s) address ≤{MAX_BASEMAP_URL} chars'
        if 'layers' in b and not _is_str(b['layers'], MAX_BASEMAP_LAYERS):
            return f'basemaps[{i}].layers must be a string ≤{MAX_BASEMAP_LAYERS} chars'
        for field, most in _BASEMAP_WMS_FIELDS.items():
            if field in b and not _is_str(b[field], most):
                return f'basemaps[{i}].{field} must be a string ≤{most} chars'
    return None


# An MGRS grid as the page writes it ("11S NV 39697 06762"); the page checks
# that its letters belong together.
_DRONE_GRID_RE = re.compile(r'\d{1,2}[C-HJ-NP-X] [A-HJ-NP-Z][A-HJ-NP-V] \d{1,5} \d{1,5}')


def _v_save_drones(data: dict) -> str | None:
    drones = data.get('drones')
    if not isinstance(drones, list):
        return 'drones must be a list'
    if len(drones) > MAX_DRONES:
        return f'too many drones (max {MAX_DRONES})'
    names = set()
    for i, d in enumerate(drones):
        if not isinstance(d, dict):
            return f'drones[{i}] must be an object'
        name = d.get('name')
        if not _is_str(name, MAX_DRONE_NAME) or not name.strip():
            return f'drones[{i}].name must be a non-empty string ≤{MAX_DRONE_NAME} chars'
        if name.strip().lower() in names:
            return f'drones[{i}].name is used twice'
        names.add(name.strip().lower())
        grid = d.get('grid')
        if not isinstance(grid, str) or not _DRONE_GRID_RE.fullmatch(grid):
            return f'drones[{i}].grid must be an MGRS grid like "11S NV 39697 06762"'
        if not _is_int(d.get('at')):
            return f'drones[{i}].at must be a time in milliseconds'
        # Optional: where it's looking (a grid), and how far it can see (km).
        look = d.get('look')
        if look is not None and (not isinstance(look, str) or not _DRONE_GRID_RE.fullmatch(look)):
            return f'drones[{i}].look must be an MGRS grid like "11S NV 39697 06762"'
        rng = d.get('range')
        if rng is not None and (
            isinstance(rng, bool)
            or not isinstance(rng, (int, float))
            or not 0 < rng <= MAX_DRONE_RANGE_KM
        ):
            return (
                f'drones[{i}].range must be a number of km, more than 0 and ≤{MAX_DRONE_RANGE_KM}'
            )
    return None


def _v_save_narrative(data: dict) -> str | None:
    n = data.get('narrative')
    if not isinstance(n, dict):
        return 'narrative must be an object'
    if 'enemy' in n and not _is_str(n['enemy'], MAX_NARRATIVE_NAME):
        return f'narrative.enemy must be a string ≤{MAX_NARRATIVE_NAME} chars'
    units = n.get('units', [])
    if not isinstance(units, list) or len(units) > MAX_UNITS:
        return f'narrative.units must be a list of at most {MAX_UNITS}'
    names = set()
    for i, u in enumerate(units):
        if not isinstance(u, dict):
            return f'narrative.units[{i}] must be an object'
        name = u.get('name')
        if not _is_str(name, MAX_NARRATIVE_NAME) or not name.strip():
            return (
                f'narrative.units[{i}].name must be a non-empty string ≤{MAX_NARRATIVE_NAME} chars'
            )
        if name.strip().lower() in names:
            return f'narrative.units[{i}].name is used twice'
        names.add(name.strip().lower())
        places = u.get('places', [])
        if (
            not isinstance(places, list)
            or len(places) > MAX_UNIT_PLACES
            or not all(_is_str(p, MAX_PLACE) for p in places)
        ):
            return f'narrative.units[{i}].places must be at most {MAX_UNIT_PLACES} names ≤{MAX_PLACE} chars'
        kinds = u.get('kinds', [])
        if not isinstance(kinds, list) or not all(k in _EQUIPMENT_ROLES for k in kinds):
            return f'narrative.units[{i}].kinds must be kinds of equipment'
    equipment = n.get('equipment', [])
    if not isinstance(equipment, list) or len(equipment) > MAX_EQUIPMENT:
        return f'narrative.equipment must be a list of at most {MAX_EQUIPMENT}'
    types = set()
    for i, e in enumerate(equipment):
        if not isinstance(e, dict):
            return f'narrative.equipment[{i}] must be an object'
        t = e.get('type')
        if not _is_str(t, MAX_EQUIPMENT_TYPE) or not t.strip():
            return f'narrative.equipment[{i}].type must be a non-empty string ≤{MAX_EQUIPMENT_TYPE} chars'
        if t.strip().upper() in types:
            return f'narrative.equipment[{i}].type is used twice'
        types.add(t.strip().upper())
        if e.get('role') not in _EQUIPMENT_ROLES:
            return f'narrative.equipment[{i}].role must be a kind of equipment'
        if e.get('origin', '') not in _EQUIPMENT_ORIGINS:
            return f'narrative.equipment[{i}].origin must be RU, CN or empty'
    off = n.get('off', [])
    if not isinstance(off, list) or not all(r in _NARRATIVE_RULES for r in off):
        return 'narrative.off must list built-in rules'
    custom = n.get('custom', [])
    if not isinstance(custom, list) or len(custom) > MAX_CUSTOM_RULES:
        return f'narrative.custom must be a list of at most {MAX_CUSTOM_RULES}'
    for i, c in enumerate(custom):
        if not isinstance(c, dict):
            return f'narrative.custom[{i}] must be an object'
        if not _is_str(c.get('what'), MAX_RULE_TEXT) or not c['what'].strip():
            return f'narrative.custom[{i}].what must be a non-empty string ≤{MAX_RULE_TEXT} chars'
        if not _is_str(c.get('words'), MAX_RULE_WORDS) or not c['words'].strip():
            return f'narrative.custom[{i}].words must be a non-empty string ≤{MAX_RULE_WORDS} chars'
        if not _is_int(c.get('min')) or not 1 <= c['min'] <= 20:
            return f'narrative.custom[{i}].min must be 1 to 20'
        if not _is_int(c.get('hours')) or not 1 <= c['hours'] <= 168:
            return f'narrative.custom[{i}].hours must be 1 to 168'
    return None


def _v_wms_fetch(data: dict) -> str | None:
    url = data.get('url')
    if not _is_str(url, WMS_FETCH_MAX_URL) or not url.strip().lower().startswith(
        ('http://', 'https://')
    ):
        return f'url must be an http(s) address ≤{WMS_FETCH_MAX_URL} chars'
    return None


# =============================================================================
# Shared settings
# =============================================================================
# The settings every workspace shares, one SharedSection each in
# SHARED_SECTIONS. From that one list come DATA_STORE's slots, /api/sync's
# fields, Shared settings.json, the copy every workspace backup carries,
# reading them back at boot and each one's save route (see ROUTES), all in its
# order. A new shared list is one entry here, with its validator and cleaner.
#
# Where one of them works its own way, that is spelled out where it happens:
#   config    the workspace viewers are shown. Its route also notes where the
#             editor now is and brings back an unloaded workspace
#             (_post_save_config); unloading the workspace clears it.
#   profiles  saved one operator at a time (_post_save_profile), which also
#             names the machine; at boot every file's are merged.
#   format    backup files keep it under each workspace's name, as 'formats',
#             the shape older versions read (formats_for); at boot it is the
#             newest file's active workspace's (pick_format).
#   overlays  at boot the newest file in the shared form decides; files from
#             before they were shared (per workspace) are pooled (fold_overlays).


class SharedSection(NamedTuple):
    """One setting every workspace shares (see SHARED_SECTIONS)."""

    # Its name in DATA_STORE, /api/sync, Shared settings.json and the backups.
    key: str
    # dict or list: its empty value, and what a file's must be for the boot to take it.
    kind: type
    # The POST route that saves it, and that route's validator.
    route: str
    validator: Callable[[dict], str | None]
    # What is stored from the validated body's value (known fields only), the
    # audit line for it, and the Activity list's words for it (from what it
    # held before, and now). None: its route is a handler of its own (see
    # _OWN_SAVE_ROUTES under Routes).
    clean: Callable[[Any], Any] | None = None
    logged: Callable[[Any], str] | None = None
    said: Callable[[Any, Any], str] | None = None
    # What it holds before anything is loaded; None: empty.
    start: Callable[[], Any] | None = None
    # Tidies what a backup file holds; None: taken as it is (None when absent).
    read: Callable[[Any], Any] | None = None
    # At boot, the newest file that holds one decides it. False: the boot
    # (load_data_from_disk) has a rule of its own for it.
    newest_file: bool = True

    def initial(self):
        """What it holds before anything is loaded."""
        return self.start() if self.start else self.kind()


def _clean_config(c) -> dict:
    """The active workspace and title from a backup, as strings whatever it holds."""
    c = c if isinstance(c, dict) else {}
    return {k: c[k] if isinstance(c.get(k), str) else '' for k in ('ato', 'title')}


def fold_overlays(value) -> list:
    """The shared overlay list from what a backup or request holds.

    A list is the shared set as it is. A dict is the older per-workspace form
    (ato -> list): its lists are folded into one, a later one replacing an
    earlier overlay of the same type and name. Anything else is empty.
    """
    if isinstance(value, list):
        return [o for o in value if isinstance(o, dict)]
    if not isinstance(value, dict):
        return []
    by_key: dict = {}
    for lst in value.values():
        for o in lst if isinstance(lst, list) else []:
            if isinstance(o, dict):
                by_key[(o.get('type'), o.get('name'))] = o
    return list(by_key.values())


def clean_overlays(ovs: list) -> list:
    """Known fields only, from overlays ``_v_save_overlays`` accepted, like the
    config. An empty list is kept (not dropped) so a clear reaches clients,
    which merge what the server sends."""
    return [
        {
            'type': o['type'],
            'name': o['name'],
            **({'label': o['label']} if o.get('label') else {}),
            'geometry': {
                'type': o['geometry']['type'],
                'coordinates': o['geometry']['coordinates'],
            },
        }
        for o in ovs
    ]


def clean_basemaps(maps: list) -> list:
    """Known fields only, trimmed, from basemaps ``_v_save_basemaps`` accepted."""
    return [
        {
            'name': b['name'].strip(),
            'kind': b['kind'],
            'url': b['url'].strip(),
            **({'layers': b['layers'].strip()} if b.get('layers') else {}),
            **{f: b[f].strip() for f in _BASEMAP_WMS_FIELDS if b.get(f)},
        }
        for b in maps
    ]


def clean_drones(drones: list) -> list:
    """Known fields only, from drones ``_v_save_drones`` accepted."""
    return [
        {
            'name': d['name'].strip(),
            'grid': d['grid'],
            'at': d['at'],
            **({'look': d['look']} if d.get('look') else {}),
            **({'range': d['range']} if d.get('range') is not None else {}),
        }
        for d in drones
    ]


def said_of_drones(before, after: list) -> str:
    """A drones save in plain words: the one drone added, removed, moved or
    changed, by name; else 'changed the drones'."""
    old = {d.get('name'): d for d in _dicts(before)}
    new = {d['name']: d for d in after}
    added, gone = [n for n in new if n not in old], [n for n in old if n not in new]
    if len(added) == 1 and not gone:
        return f'added drone {added[0]}'
    if len(gone) == 1 and not added:
        return f'removed drone {gone[0]}'
    changed = [] if added or gone else [n for n in new if new[n] != old[n]]
    if len(changed) == 1:
        moved = new[changed[0]].get('grid') != old[changed[0]].get('grid')
        return f'{"moved" if moved else "changed"} drone {changed[0]}'
    return 'changed the drones'


def clean_narrative(n: dict) -> dict:
    """Known fields only, trimmed, from settings ``_v_save_narrative`` accepted."""
    return {
        'enemy': (n.get('enemy') or '').strip(),
        'units': [
            {
                'name': u['name'].strip(),
                'places': [p.strip() for p in u.get('places', []) if p.strip()],
                'kinds': list(dict.fromkeys(u.get('kinds', []))),
            }
            for u in n.get('units', [])
        ],
        'equipment': [
            {'type': e['type'].strip(), 'role': e['role'], 'origin': e.get('origin', '')}
            for e in n.get('equipment', [])
        ],
        'off': sorted(set(n.get('off', []))),
        'custom': [
            {
                'what': c['what'].strip(),
                'words': c['words'].strip(),
                'min': c['min'],
                'hours': c['hours'],
            }
            for c in n.get('custom', [])
        ],
    }


SHARED_SECTIONS: tuple[SharedSection, ...] = (
    # {ato, title}: the workspace viewers are shown (each editor keeps their own).
    SharedSection(
        'config',
        dict,
        '/api/save_config',
        _v_save_config,
        start=lambda: {'ato': '', 'title': ''},
        read=_clean_config,
    ),
    # Initials -> {initials, color}, one per operator.
    SharedSection(
        'profiles',
        dict,
        '/api/save_profile',
        _v_save_profile,
        read=lambda v: v if isinstance(v, dict) else {},
        newest_file=False,
    ),
    # The report format (Builder), one for every workspace; it changes only
    # when an operator edits it. Stored as sent: its validator checked each line.
    SharedSection(
        'format',
        dict,
        '/api/save_format',
        _v_save_format,
        clean=lambda fmt: fmt,
        logged=lambda _: 'save_format',
        said=lambda *_: 'changed the report format',
        newest_file=False,
    ),
    # NAI / OBJ / PL features, imported from KML, KMZ, GeoJSON or shapefile.
    # One set shared by every workspace (graphics outlast a single ATO).
    SharedSection(
        'overlays',
        list,
        '/api/save_overlays',
        _v_save_overlays,
        clean=clean_overlays,
        logged=lambda ovs: f'save_overlays: {len(ovs)} overlay(s)',
        said=lambda *_: 'changed the overlays',
        newest_file=False,
    ),
    # The map's background services: [{name, kind: 'wms' | 'tiles', url, layers?}].
    # Shared like the overlays; each browser picks one to show and fetches it
    # straight from that service.
    SharedSection(
        'basemaps',
        list,
        '/api/save_basemaps',
        _v_save_basemaps,
        clean=clean_basemaps,
        logged=lambda maps: f'save_basemaps: {len(maps)} service(s)',
        said=lambda *_: 'changed the basemaps',
    ),
    # Drones shown on the map: [{name, grid, at}], where they were last put
    # (an MGRS grid) and when (ms). Shared like the basemaps.
    SharedSection(
        'drones',
        list,
        '/api/save_drones',
        _v_save_drones,
        clean=clean_drones,
        logged=lambda drones: f'save_drones: {len(drones)} drone(s)',
        said=said_of_drones,
    ),
    # The narrative's settings (Summary Reports > Narrative): what the enemy
    # is called, the known units and where they operate, equipment added to
    # the catalogue, rules switched off, and the team's own rules.
    SharedSection(
        'narrative',
        dict,
        '/api/save_narrative',
        _v_save_narrative,
        clean=clean_narrative,
        logged=lambda n: (
            f'save_narrative: {len(n["units"])} unit(s), {len(n["equipment"])} type(s), '
            f'{len(n["custom"])} rule(s)'
        ),
        said=lambda *_: 'changed the narrative settings',
    ),
)

# Every workspace's reports (ATO -> list), then the shared settings. Protected
# by data_lock.
DATA_STORE: dict = {'workspaces': {}, **{s.key: s.initial() for s in SHARED_SECTIONS}}


def shared_settings() -> dict:
    """The shared settings as DATA_STORE holds them, key -> value in
    SHARED_SECTIONS order. Caller holds data_lock."""
    return {s.key: DATA_STORE.get(s.key, s.kind()) for s in SHARED_SECTIONS}


# =============================================================================
# Map services
# =============================================================================


def wms_fetch(url: str) -> dict:
    """GET a WMS address and say what came back: the HTTP status, the content
    type, the size, and the text when it is text (capabilities, or a service
    error). Never raises; a failure to connect comes back as ``error``."""
    req = urllib.request.Request(
        url.strip(), headers={'User-Agent': 'SALT-Report-Workbench', 'Accept': '*/*'}
    )

    def answer(status: int, ctype: str, body: bytes) -> dict:
        textual = not ctype.lower().startswith('image/')
        return {
            'http': status,
            'type': ctype,
            'size': len(body),
            'truncated': len(body) > WMS_FETCH_MAX_BYTES,
            'text': body[:WMS_FETCH_MAX_BYTES].decode('utf-8', 'replace') if textual else '',
        }

    try:
        with urllib.request.urlopen(req, timeout=WMS_FETCH_TIMEOUT) as res:
            return answer(
                res.status, res.headers.get('Content-Type', ''), res.read(WMS_FETCH_MAX_BYTES + 1)
            )
    except urllib.error.HTTPError as e:
        body = e.read(WMS_FETCH_MAX_BYTES + 1) if e.fp else b''
        return answer(e.code, e.headers.get('Content-Type', '') if e.headers else '', body)
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {'error': str(getattr(e, 'reason', e)) or type(e).__name__}


def basemap_proxy_allowed(url: str) -> bool:
    """True when ``url`` is an http:// address on the host of a saved basemap.
    Only those are fetched, so the proxy can't be pointed anywhere else."""
    if not _is_str(url, WMS_FETCH_MAX_URL):
        return False
    try:
        target = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return False
    if target.scheme.lower() != 'http' or not target.netloc:
        return False
    with data_lock:
        saved = [str(b.get('url', '')) for b in _dicts(DATA_STORE.get('basemaps'))]
    for u in saved:
        try:
            base = urllib.parse.urlsplit(u.strip())
        except ValueError:
            continue
        if base.scheme.lower() == 'http' and base.netloc.lower() == target.netloc.lower():
            return True
    return False


class _SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only on the saved host: to another path, or from
    http:// to https:// (as many services now send every http request). One to
    any other host could reach past the saved basemaps, so it isn't followed."""

    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        same = (
            new.scheme in ('http', 'https')
            and (new.hostname or '').lower() == (old.hostname or '').lower()
            and (new.port == old.port or (new.scheme == 'https' and new.port in (None, 443)))
        )
        return super().redirect_request(req, fp, code, msg, headers, newurl) if same else None


_basemap_opener = urllib.request.build_opener(_SameHostRedirects)


def basemap_fetch(url: str) -> tuple[int, str, bytes]:
    """GET a basemap image: (status, content type, body). Never raises; a
    failure comes back as status 502."""
    req = urllib.request.Request(
        url.strip(), headers={'User-Agent': 'SALT-Report-Workbench', 'Accept': 'image/*'}
    )
    try:
        with _basemap_opener.open(req, timeout=WMS_FETCH_TIMEOUT) as res:
            body = res.read(BASEMAP_PROXY_MAX_BYTES + 1)
            if len(body) > BASEMAP_PROXY_MAX_BYTES:
                return 502, '', b''
            return res.status, res.headers.get('Content-Type', ''), body
    except urllib.error.HTTPError as e:  # an error status, or a redirect not followed
        e.close()
        return 502, '', b''
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        return 502, '', b''


# =============================================================================
# Rate limiting
# =============================================================================
# A token bucket per IP: 1 token/POST; GETs unlimited; 429 when empty.
RATE_BUCKET_CAPACITY = 60
RATE_REFILL_PER_SECOND = 5.0
RATE_BUCKET_PRUNE_AFTER = 600.0  # drop buckets inactive longer than this
# Wrong or missing access codes, on any request, drain a bucket of their own;
# an editor's own burst of saves never touches it. Once it is empty the
# address is refused before its code is looked at, so a right guess made while
# throttled gets nowhere. A request with the right code never costs a token.
AUTH_FAIL_CAPACITY = 30
AUTH_FAIL_REFILL_PER_SECOND = 1.0
# /api/basemap has its own, roomier bucket: a map view on a tiled basemap asks
# for up to 400 tiles at once (core.js tilesFor), and panning asks for more.
BASEMAP_BUCKET_CAPACITY = 600
BASEMAP_REFILL_PER_SECOND = 10.0

_rate_buckets: dict = {}  # ip -> (tokens: float, last_seen: float)
_auth_fail_buckets: dict = {}  # the same, for wrong access codes
_basemap_buckets: dict = {}  # the same, for /api/basemap
_rate_lock = threading.Lock()


def _take_token(buckets: dict, ip: str, capacity: float, refill: float, take: bool) -> bool:
    """Token-bucket consume (or with ``take`` False, just look); True allowed,
    False rate-limited. Lazy refill on access."""
    now = time.monotonic()  # immune to wall-clock changes
    with _rate_lock:
        # Lazy prune fires only on first contact for a new IP — keeps dict bounded without a thread.
        if ip not in buckets:
            cutoff = now - RATE_BUCKET_PRUNE_AFTER
            stale = [k for k, (_, t) in buckets.items() if t < cutoff]
            for k in stale:
                del buckets[k]
        tokens, last = buckets.get(ip, (float(capacity), now))
        # Refill based on elapsed; cap at capacity.
        elapsed = max(0.0, now - last)
        tokens = min(float(capacity), tokens + elapsed * refill)
        if tokens < 1.0:
            buckets[ip] = (tokens, now)
            return False
        buckets[ip] = (tokens - (1.0 if take else 0.0), now)
        return True


def rate_limit_check(ip: str) -> bool:
    """The POST bucket: True allowed, False rate-limited."""
    return _take_token(_rate_buckets, ip, RATE_BUCKET_CAPACITY, RATE_REFILL_PER_SECOND, True)


def auth_fail_check(ip: str, take: bool) -> bool:
    """The wrong-access-code bucket: with ``take`` False, whether the address
    may try a code at all; with True, charge it for a wrong one."""
    return _take_token(
        _auth_fail_buckets, ip, AUTH_FAIL_CAPACITY, AUTH_FAIL_REFILL_PER_SECOND, take
    )


def basemap_rate_check(ip: str) -> bool:
    """The /api/basemap bucket: True allowed, False rate-limited."""
    return _take_token(
        _basemap_buckets, ip, BASEMAP_BUCKET_CAPACITY, BASEMAP_REFILL_PER_SECOND, True
    )


# =============================================================================
# Backup parsing & merging
# =============================================================================


def _shared_in_file(d: dict) -> dict:
    """The shared settings a backup's JSON holds, key -> value in
    SHARED_SECTIONS order, each tidied by its ``read``; None for one the file
    doesn't hold (older than it). The format is under ``formats``, one per
    workspace (see pick_format)."""
    out = {}
    for s in SHARED_SECTIONS:
        if s.key == 'format':
            out['formats'] = d.get('formats', {})
        else:
            out[s.key] = s.read(d.get(s.key)) if s.read else d.get(s.key)
    return out


def _parse_backup(raw_text: str) -> dict:
    """DATA_STORE dict from a backup file; handles legacy single-ATO format.

    Raises ValueError saying what is wrong with a file that isn't a backup.
    Reports that aren't objects are dropped, and the config is kept to its two
    strings, so a hand-edited file can't hold anything a save would trip on.
    """
    s = raw_text.find(BACKUP_START)
    e = raw_text.find(BACKUP_END)
    if s == -1 or e == -1:
        raise ValueError('no backup data block in it')
    try:
        d = json.loads(raw_text[s + len(BACKUP_START) : e].strip())
    except (ValueError, RecursionError) as exc:
        raise ValueError(f'its backup data is not valid JSON ({exc})') from None
    if not isinstance(d, dict):
        raise ValueError('its backup data is not a JSON object')
    if 'workspaces' in d:
        if not isinstance(d['workspaces'], dict):
            raise ValueError('its "workspaces" is not an object')
        return {
            'workspaces': {
                ato: _dicts(reps) for ato, reps in d['workspaces'].items() if isinstance(reps, list)
            },
            **_shared_in_file(d),
        }
    # Legacy marker format: single ATO inferred from config. Of the shared
    # settings it held only the config and profiles.
    shared = _shared_in_file({'config': d.get('config'), 'profiles': d.get('profiles')})
    ato = shared['config']['ato']
    reps = _dicts(d.get('reports'))
    return {'workspaces': {ato: reps} if ato and reps else {}, **shared}


def _parse_shared_settings(raw_text: str) -> dict:
    """``Shared settings.json`` in the shape ``_parse_backup`` returns, with no
    workspaces. Raises ValueError when it isn't one."""
    try:
        d = json.loads(raw_text)
    except (ValueError, RecursionError) as exc:
        raise ValueError(f'not valid JSON ({exc})') from None
    if not isinstance(d, dict):
        raise ValueError('not a JSON object')
    shared = _shared_in_file(d)
    # One format here, not one per workspace: under '', it is the one pick_format finds.
    fmt = d.get('format')
    shared['formats'] = {'': fmt} if isinstance(fmt, dict) else {}
    return {'workspaces': {}, **shared}


def _extract_json_from_file(raw_text: str) -> dict | None:
    """DATA_STORE dict from a backup file (see ``_parse_backup``). None on failure."""
    try:
        return _parse_backup(raw_text)
    except ValueError:
        return None


def _sort_num(v) -> float:
    """A number to compare by, whatever a hand-edited backup holds (else 0)."""
    return v if isinstance(v, (int, float)) else 0


def _dicts(v) -> list:
    """The objects in a list, whatever a hand-edited backup holds (else none)."""
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def _report_key(r: dict) -> str | None:
    """The id a report merges by: its id, or the legacy displayId."""
    key = r.get('id') or r.get('displayId')
    return str(key) if key and isinstance(key, (str, int, float)) else None


# What a report says, as against who saved it and when: a change to any of
# these makes the operator who sent it the report's author.
_CONTENT_FIELDS = tuple(f for f in _EDITABLE_FIELDS if f not in ('updated', 'user', 'lastModified'))


def _says_more(old: dict | None, r: dict) -> bool:
    """Whether ``r`` is a new report, or says something else than ``old``."""
    return old is None or any(r.get(f) != old.get(f) for f in _CONTENT_FIELDS)


def _written(existing_list: list, incoming_list: list) -> list:
    """The reports in ``incoming_list`` that are new or changed."""
    have = {k: r for r in existing_list if (k := _report_key(r))}
    return [r for r in incoming_list if _says_more(have.get(_report_key(r)), r)]


# A report's fields that say when and by whom it was saved, not what it says.
_SAVED_BY = ('lastModified', 'user')


def _differs(old: dict, r: dict) -> bool:
    """Whether ``r`` holds anything else than ``old``, its history and BDA
    included, but not when and by whom it was saved."""
    return any(r.get(f) != old.get(f) for f in r.keys() | old.keys() if f not in _SAVED_BY)


def report_changes(existing_list: list, incoming_list: list) -> dict:
    """What merging ``incoming_list`` does to the server's copy, for the
    Activity list: 'logged', 'updated', 'deleted' and 'restored', each the
    displayIds of the reports it did that to. A copy older than the server's
    (the merge keeps the server's), or the same but for when and by whom it
    was saved, does nothing; nor does one never saved that comes deleted."""
    have = {k: r for r in existing_list if (k := _report_key(r))}
    out: dict = {'logged': [], 'updated': [], 'deleted': [], 'restored': []}
    for r in incoming_list:
        if not (key := _report_key(r)):
            continue
        old = have.get(key)
        gone = bool(r.get('deleted'))
        if old is None:
            if gone:
                continue
            kind = 'logged'
        elif _sort_num(r.get('lastModified')) < _sort_num(old.get('lastModified')):
            continue
        elif gone != bool(old.get('deleted')):
            kind = 'deleted' if gone else 'restored'
        elif gone or not _differs(old, r):
            continue
        else:
            kind = 'updated'
        out[kind].append(str(r.get('displayId') or key))
    return out


def said_of_reports(changes: dict) -> str:
    """``report_changes`` in plain words: 'logged ALPHA012', 'deleted 3
    reports', 'logged ALPHA013, updated ALPHA004'; '' when nothing changed."""
    return ', '.join(
        f'{kind} {ids[0]}' if len(ids) == 1 else f'{kind} {plural(len(ids), "report")}'
        for kind, ids in changes.items()
        if ids
    )


def _stamp_operator(existing_list: list, incoming_list: list, operator: dict) -> list:
    """``incoming_list`` with ``user`` set to ``operator`` on every report that
    is new or says something else than the server's copy. A report only
    deleted, put back or assessed (BDA) keeps the author it has."""
    have = {k: r for r in existing_list if (k := _report_key(r))}
    out = []
    for r in incoming_list:
        old = have.get(_report_key(r))
        if _says_more(old, r):
            r = {**r, 'user': operator}
        elif 'user' in old and r.get('user') != old['user']:
            r = {**r, 'user': old['user']}
        out.append(r)
    return out


def _merge_reports(existing_list: list, incoming_list: list) -> list:
    """Merge by id (or legacy displayId); higher lastModified wins."""
    by_id: dict = {}
    for r in existing_list:
        if key := _report_key(r):
            by_id[key] = r
    for r in incoming_list:
        if not (key := _report_key(r)):
            continue
        existing = by_id.get(key)
        if existing is None or _sort_num(r.get('lastModified')) >= _sort_num(
            existing.get('lastModified')
        ):
            by_id[key] = r
    return list(by_id.values())


# =============================================================================
# Disk I/O
# =============================================================================


def load_data_from_disk() -> int:
    """Read the backups in BACKUP_DIR into DATA_STORE + workspace_sources.

    Every ``.txt`` backup adds its workspaces. The shared settings
    (SHARED_SECTIONS) come from the newest file that holds them,
    ``Shared settings.json`` among them, so they return even when no workspace
    does; the profiles, format and overlays have rules of their own, below. A
    file that can't be read is named on the console and skipped; returns how
    many were.
    """
    with data_lock:
        os.makedirs(BACKUP_DIR, exist_ok=True)

        candidates = sorted(
            [
                os.path.join(BACKUP_DIR, f)
                for f in os.listdir(BACKUP_DIR)
                if f.endswith('.txt') or f == SHARED_SETTINGS_NAME
            ],
            key=os.path.getmtime,
        )

        if not candidates:
            return 0

        all_workspaces: dict = {}
        source_by_ato: dict = {}
        # The shared settings, as the files read so far say, oldest first.
        shared = {s.key: s.initial() for s in SHARED_SECTIONS}
        # The newest file in the shared form decides the overlays. Files from
        # before they were shared (per-workspace dicts) are pooled, and used
        # only when no file has the shared form yet.
        shared_overlays: list | None = None
        legacy_overlays: dict = {}
        skipped = 0
        _file_holds.clear()
        _merged_files.clear()

        for filepath in candidates:
            fname = os.path.basename(filepath)
            try:
                with open(filepath, encoding='utf-8') as f:
                    raw = f.read()
                if fname == SHARED_SETTINGS_NAME:
                    result = _parse_shared_settings(raw)
                else:
                    result = _parse_backup(raw)
                for ato_name, reports in result.get('workspaces', {}).items():
                    # Normalize like every handler does — lowercase keys from disk would miss uppercase requests.
                    key = (ato_name or '').strip().upper() or 'ATO'
                    if key in all_workspaces:
                        all_workspaces[key] = _merge_reports(all_workspaces[key], reports)
                    else:
                        all_workspaces[key] = reports
                    # Last file to touch a workspace becomes its recorded
                    # source; mtime-sorted candidates ensure that's the
                    # most recent backup file holding it.
                    source_by_ato[key] = fname
                    _file_holds.setdefault(fname.casefold(), (fname, set()))[1].add(key)
                    _merged_files.setdefault(key, set()).add(fname.casefold())
                for s in SHARED_SECTIONS:
                    # The newest file's. For the config, newest mtime wins:
                    # matches the runtime invariant that the most recent
                    # ATO/Title is active.
                    if s.newest_file and isinstance(result.get(s.key), s.kind):
                        shared[s.key] = result[s.key]
                # The profiles: every file's, merged.
                shared['profiles'].update(result.get('profiles', {}))
                # The format: the newest file's, for its active workspace if it has one.
                if (fmt := pick_format(result.get('formats'), result.get('config'))) is not None:
                    shared['format'] = fmt
                ovs = result.get('overlays')
                if isinstance(ovs, list):
                    shared_overlays = fold_overlays(ovs)
                elif isinstance(ovs, dict):
                    legacy_overlays.update(
                        {(o.get('type'), o.get('name')): o for o in fold_overlays(ovs)}
                    )
            except Exception as exc:
                # Not silently: a backup that doesn't load is data missing from the session.
                skipped += 1
                safe_print(f'[!] Skipped {fname}: {exc}')

        shared['overlays'] = (
            shared_overlays if shared_overlays is not None else list(legacy_overlays.values())
        )
        DATA_STORE['workspaces'] = all_workspaces
        DATA_STORE.update(shared)
        workspace_sources.clear()
        workspace_sources.update(source_by_ato)
        invalidate_sync_cache()
        return skipped


def pick_format(formats, config) -> dict | None:
    """The format a backup file holds: its active workspace's, else any. None when it has none.

    Files from before the format was shared hold one per workspace; files since
    hold the same one for each.
    """
    if not isinstance(formats, dict):
        return None
    good = {
        (k or '').strip().upper(): v
        for k, v in formats.items()
        if isinstance(v, dict) and isinstance(v.get('lines'), list) and v['lines']
    }
    if not good:
        return None
    active = ((config or {}).get('ato') or '').strip().upper()
    return good.get(active) or next(iter(good.values()))


def formats_for(workspaces: dict, fmt: dict | None) -> dict:
    """The shared format under each workspace's name, the shape backup files keep."""
    return {ato: fmt for ato in workspaces} if fmt else {}


def _filename_part(s) -> str:
    """Letters, digits, '-' and '_' kept, anything else made '_'."""
    return ''.join(c if c.isalnum() or c in '-_' else '_' for c in str(s)).strip('_')


def backup_filename(ato, title) -> str:
    """The ``{ATO}_{Title}.txt`` a workspace's backup is named."""
    return f'{_filename_part(ato)}_{_filename_part(title)}.txt'


# The shared settings render_backup takes by name (overlays=[...]): all but
# the three it takes first, as it always has.
_BACKUP_BY_NAME = frozenset(s.key for s in SHARED_SECTIONS) - {'config', 'profiles', 'format'}


def render_backup(
    workspaces: dict,
    config: dict,
    profiles: dict,
    formats: dict,
    label: tuple[str, str] | None = None,
    **shared,
) -> tuple[str, str] | None:
    """Return ``(filename, text)`` for a backup of the given state, or None if empty.

    Pure: no I/O, no global state. The text is a human-readable report summary
    followed by a machine-readable JSON block that ``_extract_json_from_file``
    reads back on the next boot. ``formats`` is the format under each
    workspace's name (formats_for). The other shared settings come by name
    (``overlays=[...]``); one not given is written empty. ``label`` is the
    ``(ato, title)`` the file is named after and headed with; without it, the
    config decides.
    """
    if unknown := set(shared) - _BACKUP_BY_NAME:
        raise TypeError(f'render_backup: not a shared setting: {sorted(unknown)}')
    # Nothing loaded — don't emit an empty placeholder file.
    if not workspaces:
        return None

    if label:
        ato, title = label
    else:
        # Unloading the active workspace clears config; fall back to a real
        # workspace name so we never create a stray "ATO_SALT.txt".
        ato = config.get('ato', '').strip()
        title = config.get('title', '').strip()
        if not ato:
            ato = sorted(workspaces)[0]
            if not title:
                first = next((r for r in _dicts(workspaces.get(ato)) if r.get('title')), None)
                title = first.get('title') if first else 'SALT'
    title = title or 'SALT'

    filename = backup_filename(ato, title)

    div = '=' * 72
    sub = '-' * 72
    now = datetime.now(timezone.utc)
    ts = f'{now:%Y-%m-%d} · {now:%H%MZ}'

    def fmt_time(iso) -> str:
        if not iso:
            return '-'
        try:
            # Strip fractional seconds; ISO stored with literal Z suffix.
            dt = datetime.strptime(iso.split('.')[0], '%Y-%m-%dT%H:%M:%S')
            return f'{dt:%Y-%m-%d %H%MZ}'
        except (ValueError, AttributeError):
            return iso

    lines = [
        div,
        ' S.A.L.T. REPORT WORKBENCH: AUTO BACKUP (SESSION)',
        f' ATO Designator : {ato}',
        f' Report Title   : {title}',
        f' Total Reports  : {sum(len(_dicts(v)) for v in workspaces.values())}',
        f' Exported       : {ts}',
        div,
        '',
    ]

    # The summary copes with any shape a hand-edited backup loaded at boot can
    # hold: a report it can't sort or print must not stop the file being written.
    for ws_ato, reports in workspaces.items():
        for report in sorted(_dicts(reports), key=lambda r: str(r.get('displayId') or '')):
            flag = ' [UPDATED]' if report.get('updated') else ''
            lines += [
                sub,
                f' REPORT {report.get("displayId", "")}{flag}',
                sub,
                f' ATO      : {ws_ato}',
                f' Size     : {report.get("size", "-")}',
                f' Activity : {report.get("activity", "-")}',
                f' Location : {report.get("location", "-")}',
                f' Time     : {fmt_time(report.get("time"))}',
            ]
            if report.get('yourAnalysis'):
                lines.append(f' Analysis : {report["yourAnalysis"]}')
            custom = report.get('custom')
            for ck, cv in custom.items() if isinstance(custom, dict) else ():
                lines.append(f' {ck} : {cv}')
            user = report.get('user')
            if isinstance(user, dict) and user.get('initials'):
                lines.append(f' By       : {user["initials"]}')
            for bi, b in enumerate(_dicts(report.get('bda'))):
                coords = f' @ {b.get("coords")}' if b.get('coords') else ''
                note = f' - {b.get("note")}' if b.get('note') else ''
                lines.append(
                    f'   BDA {bi + 1}  : {b.get("effect", "Unknown")} - {b.get("target", "")}{coords}{note}'
                )

            for i, h in enumerate(
                sorted(
                    _dicts(report.get('history')), key=lambda x: _sort_num(x.get('lastModified'))
                )
            ):
                lines += [
                    '',
                    f'   ↳ Previous Entry {i + 1}',
                    f'      Size     : {h.get("size", "-")}',
                    f'      Activity : {h.get("activity", "-")}',
                    f'      Location : {h.get("location", "-")}',
                    f'      Time     : {fmt_time(h.get("time"))}',
                ]
                if h.get('yourAnalysis'):
                    lines.append(f'      Analysis : {h["yourAnalysis"]}')
            lines.append('')

    machine = {'workspaces': workspaces}
    given = {**shared, 'config': config, 'profiles': profiles}
    for s in SHARED_SECTIONS:
        if s.key == 'format':
            machine['formats'] = formats  # per workspace, as older versions read it
        else:
            machine[s.key] = given.get(s.key) or s.kind()
    machine_json = json.dumps(machine, separators=(',', ':'), ensure_ascii=False)
    lines += [
        div,
        ' MACHINE DATA: DO NOT EDIT BELOW THIS LINE',
        div,
        BACKUP_START,
        machine_json,
        BACKUP_END,
        '',
    ]

    return filename, '\n'.join(lines)


def render_shared_settings(shared: dict) -> str:
    """The text of ``Shared settings.json`` from ``shared`` (key -> value, as
    ``shared_settings`` gives), one not given written empty. Pure, like
    ``render_backup``."""
    out = {s.key: shared.get(s.key) or s.kind() for s in SHARED_SECTIONS}
    return json.dumps(out, indent=1, ensure_ascii=False) + '\n'


def workspace_title(ato: str, reports: list, config: dict) -> str:
    """The title a workspace's file is named after.

    The config's title while the workspace is active (that is what new
    reports carry), else the title of its most recently changed live report,
    else 'SALT'.
    """
    if (config.get('ato') or '').strip().upper() == ato and (config.get('title') or '').strip():
        return config['title'].strip()
    reports = _dicts(reports)
    titled = [r for r in reports if r.get('title') and not r.get('deleted')] or [
        r for r in reports if r.get('title')
    ]
    if titled:
        return str(max(titled, key=lambda r: _sort_num(r.get('lastModified')))['title'])
    return 'SALT'


def workspace_filenames(workspaces: dict, config: dict, held: set | None = None) -> dict:
    """The backup file each workspace is written to, ATO -> name. Pure.

    ``{ATO}_{Title}.txt``, unless that name is taken: by another workspace in
    this save ("A B" and "A_B" both come out ``A_B``, and Windows doesn't tell
    case apart), or by a file on disk holding reports that aren't loaded, an
    unloaded workspace's say, whose only copy it may be (``held``: their
    casefolded names). Then the ATO gets a short hash of itself, so no file is
    overwritten. An ATO already fit for a file name is served first, so a name
    stays the same from one save to the next.
    """
    held = held or set()
    names: dict = {}
    used: set = set()
    for ato in sorted(workspaces, key=lambda a: (_filename_part(a) != a, a)):
        title = workspace_title(ato, workspaces[ato], config)
        name = backup_filename(ato, title)
        if name.casefold() in used or name.casefold() in held:
            tag = hashlib.sha256(ato.encode('utf-8')).hexdigest()[:6]
            name = backup_filename(f'{_filename_part(ato)}_{tag}', title)
        names[ato] = name
        used.add(name.casefold())
    return names


def render_workspace_backups(
    workspaces: dict,
    config: dict,
    profiles: dict,
    formats: dict,
    only: set | None = None,
    names: dict | None = None,
    **shared,
) -> list[tuple[str, str, str]]:
    """One ``(ato, filename, text)`` per workspace, for those in ``only`` (None: all).

    Each file holds a single workspace with its format, plus every other shared
    setting (by name, as ``render_backup`` takes them), so on boot every file
    contributes its workspace and the newest file decides the active one.
    ``names`` is what ``workspace_filenames`` gave (None: worked out here).
    Pure, like ``render_backup``.
    """
    if names is None:
        names = workspace_filenames(workspaces, config)
    out = []
    for ato in sorted(workspaces):
        if only is not None and ato not in only:
            continue
        reports = workspaces[ato]
        rendered = render_backup(
            {ato: reports},
            config,
            profiles,
            {ato: formats[ato]} if ato in formats else {},
            label=(ato, workspace_title(ato, reports, config)),
            **shared,
        )
        if rendered is not None:
            out.append((ato, names[ato], rendered[1]))
    return out


# Serializes writers so a slower, older snapshot can never land on disk after a
# newer one. Separate from data_lock so disk I/O never blocks request handlers.
_disk_lock = threading.Lock()
# When the last dated copy was taken; None means the next save takes one.
_last_snapshot_at: float | None = None
# The UTC time the last round of snapshots is named with. Each round gets a
# later one, so two rounds never share a name. Protected by _disk_lock.
_last_snapshot_stamp: datetime | None = None
# A snapshot's name: the UTC time of its round, then the backup's own name.
_SNAPSHOT_NAME_RE = re.compile(r'(\d{8}_\d{6}Z)_')
# A backup moved out of the way when its workspace's file took a new name.
# Never pruned: it is moved, not deleted, as it may be the copy someone wants.
SUPERSEDED_PREFIX = 'Superseded_'

# Which workspaces each backup file in BACKUP_DIR holds that no newer file
# written by this server does (casefolded name -> (name, set of ATOs)), and for
# each loaded workspace the files its reports were read from or last written
# to (ATO -> casefolded names). A file left holding nothing has been superseded
# (by a new title, say) and is moved to snapshots/, or every restart would merge
# it back in. Protected by data_lock.
_file_holds: dict = {}
_merged_files: dict = {}


def write_snapshot(filename: str, content: str, now: datetime | None = None) -> str:
    """Keep a dated copy of a backup in ``BACKUP_DIR/snapshots/`` and prune old rounds.

    Snapshot names start with the UTC time so a directory listing is
    chronological. Every file of a round (one save) is named with the same
    time, and the newest SNAPSHOT_KEEP rounds are kept however many workspaces
    each holds. Returns the path written. Caller holds ``_disk_lock``.
    """
    snap_dir = os.path.join(BACKUP_DIR, SNAPSHOT_DIR_NAME)
    os.makedirs(snap_dir, exist_ok=True)
    stamp = f'{(now or datetime.now(timezone.utc)):%Y%m%d_%H%M%S}Z'
    base = os.path.join(snap_dir, f'{stamp}_{filename}')
    stem, ext = os.path.splitext(base)
    path, n = base, 1
    while os.path.exists(path):  # several saves in one second
        n += 1
        path = f'{stem}_{n}{ext}'
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    rounds: dict = {}
    for f in os.listdir(snap_dir):
        if m := _SNAPSHOT_NAME_RE.match(f):
            rounds.setdefault(m.group(1), []).append(f)
    for old in sorted(rounds)[: max(0, len(rounds) - SNAPSHOT_KEEP)]:
        for f in rounds[old]:
            with contextlib.suppress(OSError):
                os.unlink(os.path.join(snap_dir, f))
    return path


def _move_superseded(name: str) -> None:
    """Move a backup no workspace is written to any more into snapshots/, where
    the loader doesn't read it. Caller holds ``_disk_lock``."""
    snap_dir = os.path.join(BACKUP_DIR, SNAPSHOT_DIR_NAME)
    os.makedirs(snap_dir, exist_ok=True)
    stamp = f'{datetime.now(timezone.utc):%Y%m%d_%H%M%S}Z'
    os.replace(
        os.path.join(BACKUP_DIR, name),
        os.path.join(snap_dir, f'{SUPERSEDED_PREFIX}{stamp}_{name}'),
    )


def _note_written(written: list) -> list:
    """Record the workspace backups just written, ``[(ato, filename)]``, and
    return the names of the files that now hold nothing. Caller holds data_lock."""
    for ato, filename in written:
        key = filename.casefold()
        # A workspace unloaded since its text was made: the file may now be
        # the only copy of what it held, so nothing else is let go for it.
        if ato in DATA_STORE.get('workspaces', {}):
            for other in _merged_files.get(ato, set()) - {key}:
                if other in _file_holds:
                    _file_holds[other][1].discard(ato)
            _merged_files[ato] = {key}
        _file_holds[key] = (filename, {ato})
    empty = [k for k, (_, atos) in _file_holds.items() if not atos]
    return [_file_holds.pop(k)[0] for k in empty]


def _write_atomically(dest: str, content: str) -> None:
    """Write ``content`` to ``dest`` via a temporary file, so readers never see a partial file."""
    tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(dest), suffix='.tmp')
    try:
        with open(tmp_fd, 'w', encoding='utf-8') as tmp_f:
            tmp_f.write(content)
            # On the disk itself before it takes the old file's place, so a
            # power cut can't leave the new name on a file whose data never landed.
            tmp_f.flush()
            os.fsync(tmp_f.fileno())
        os.replace(tmp_path, dest)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise


# Saves that failed in a row. Protected by _disk_lock.
_save_failures = 0
# When the backups were last written without an error (time.time()), or None.
_last_saved_at: float | None = None


def _note_save_result(errors: list) -> None:
    """After a save: on failure, say why (once per run of failures) and try
    again with a growing wait; on the first success after that, say so."""
    global _save_failures, _last_saved_at
    if not errors:
        if _save_failures:
            safe_print('[+] Backups are being saved again.')
        _save_failures = 0
        _last_saved_at = time.time()
        return
    if not _save_failures:
        for e in errors:
            safe_print(f'[!] {e}')
        safe_print('    Changes are kept in memory and the save is retried until it works.')
    _save_failures += 1
    _retry_save_in(SAVE_RETRY_SECONDS[min(_save_failures, len(SAVE_RETRY_SECONDS)) - 1])


def save_data_to_disk() -> None:
    """Persist each changed workspace atomically to its own ``{ATO}_{Title}.txt``.

    The backup texts are rendered while holding ``data_lock`` (a consistent,
    CPU-only snapshot), then written after releasing it. Holding the lock
    across the write used to stall every sync and POST for the duration of
    the disk I/O, which is noticeable on the USB sticks and network shares
    this often runs from. Only workspaces marked dirty since the last save
    are rewritten, except when a dated snapshot is due, which covers all.
    ``Shared settings.json`` is rewritten when the shared settings changed.
    """
    global _last_snapshot_at, _last_snapshot_stamp, _dirty_atos, _shared_dirty
    with _disk_lock:
        now = time.monotonic()
        snapshot_due = (
            _last_snapshot_at is None or now - _last_snapshot_at >= SNAPSHOT_INTERVAL_SECONDS
        )
        errors = []
        with data_lock:
            pending, shared_pending = _dirty_atos, _shared_dirty
            only = None if (snapshot_due or pending is None) else set(pending)
            _dirty_atos, _shared_dirty = set(), False
            try:
                workspaces = DATA_STORE.get('workspaces', {})
                shared = shared_settings()
                files = render_workspace_backups(
                    workspaces,
                    # The config and profiles by name; the format under each
                    # workspace's name, the shape backup files keep.
                    formats=formats_for(workspaces, shared['format']),
                    only=only,
                    names=workspace_filenames(
                        workspaces,
                        shared['config'],
                        {
                            k
                            for k, (_, atos) in _file_holds.items()
                            if any(k not in _merged_files.get(a, ()) for a in atos)
                        },
                    ),
                    **{k: v for k, v in shared.items() if k != 'format'},
                )
                if shared_pending or snapshot_due:
                    # None for the ATO: the shared settings, not a workspace.
                    files.append((None, SHARED_SETTINGS_NAME, render_shared_settings(shared)))
            except Exception as exc:
                # Nothing was written: keep every change pending, so a report
                # the backup can't be made from never silently stops saving.
                _dirty_atos, _shared_dirty = pending, shared_pending
                files = []
                errors.append(f'Could not prepare the backups: {exc!r}')
        if files:
            os.makedirs(BACKUP_DIR, exist_ok=True)
        written = []
        for ato, filename, content in files:
            try:
                _write_atomically(os.path.join(BACKUP_DIR, filename), content)
                written.append((ato, filename, content))
            except Exception as exc:
                errors.append(f'Error saving {filename}: {exc}')
                with data_lock:  # try again on the next save
                    if ato is None:
                        _shared_dirty = True
                    else:
                        mark_dirty(ato)
        if written:
            with data_lock:
                superseded = _note_written([(a, f) for a, f, _ in written if a is not None])
            for name in superseded:
                try:
                    _move_superseded(name)
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    # It stays, and a restart merges it back in, as before.
                    safe_print(f'[!] Could not move the old {name} to {SNAPSHOT_DIR_NAME}: {exc}')
        _note_save_result(errors)
        if snapshot_due and written:
            # One time for the whole round, later than the last round's.
            stamp = datetime.now(timezone.utc).replace(microsecond=0)
            if _last_snapshot_stamp is not None and stamp <= _last_snapshot_stamp:
                stamp = _last_snapshot_stamp + timedelta(seconds=1)
            try:
                for _, filename, content in written:
                    write_snapshot(filename, content, stamp)
                _last_snapshot_at, _last_snapshot_stamp = now, stamp
            except Exception as exc:
                # The live backups are already safe; a missed snapshot is worth a line, not a crash.
                safe_print(f'[!] Error writing snapshot: {exc}')


# =============================================================================
# HTTP request handler
# =============================================================================


def health() -> dict:
    """What /api/health says: is the server up and saving, and since when."""
    with sse_lock:
        machines = len({c.ip for c in sse_clients})
    saved = _last_saved_at
    return {
        'status': 'not saving' if _save_failures else 'ok',
        'version': APP_VERSION,
        'uptime_seconds': int(time.time() - STARTED_AT),
        'last_saved': None
        if saved is None
        else f'{datetime.fromtimestamp(saved, timezone.utc):%Y-%m-%dT%H:%M:%SZ}',
        'save_failures': _save_failures,
        'connected_machines': machines,
        'change': current_version(),
    }


def _same_origin(origin: str, host: str, tls: bool) -> bool:
    """True when an ``Origin`` header names the host and port the request was
    sent to (its ``Host`` header), default ports filled in."""
    try:
        o = urllib.parse.urlsplit(origin)
        h = urllib.parse.urlsplit('//' + host)
        if o.scheme not in ('http', 'https') or not o.hostname:
            return False
        return o.hostname == h.hostname and (o.port or (443 if o.scheme == 'https' else 80)) == (
            h.port or (443 if tls else 80)
        )
    except ValueError:  # a port that isn't a number
        return False


class SaltSyncHandler(server.BaseHTTPRequestHandler):
    # A connection that sends nothing for this long is closed (StreamRequestHandler
    # applies it in setup()), so a client that stalls can't hold a thread forever.
    # The event stream clears it: it is meant to stay open.
    timeout = REQUEST_IDLE_TIMEOUT

    def log_message(self, format, *args):
        return  # suppress per-request console noise

    def end_headers(self):
        # On every reply, error pages included: no framing by other sites
        # (clickjacking), and no guessing a type the server didn't send. No
        # script or style rules: the page's own are inline.
        for name, value in _SECURITY_HEADERS:
            self.send_header(name, value)
        super().end_headers()

    def _send_body(
        self, body: bytes, content_type: str, status: int = 200, headers: tuple = ()
    ) -> None:
        """Send a complete, uncacheable response."""
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data, status: int = 200) -> None:
        self._send_body(json.dumps(data).encode('utf-8'), 'application/json', status)

    # -------------------------------------------------------------------------
    # GET
    # -------------------------------------------------------------------------

    def do_GET(self):
        # Strip query string so cache-bust params don't 404.
        path = self.path.split('?', 1)[0]
        route = _ROUTE_TABLE.get(('GET', path))
        if route is None:
            if path.startswith('/api/'):
                self._error(404, 'Not found.')
            else:
                self.send_error(404)
            return
        if getattr(self.server, 'view_only', False) and not route.viewer:
            self._error(405, 'This server is read-only.')
            return
        if route.limit is not None and not route.limit.check(self.client_address[0]):
            self._error(429, route.limit.message)
            return
        if route.code and not self._authorized():
            return
        route.handler(self)

    def _handle_health(self) -> None:
        """Is the server up and saving (see ``health``)."""
        self._send_json(health())

    def _handle_basemap(self) -> None:
        """An http:// basemap image for an HTTPS page, from a saved basemap's host."""
        query = urllib.parse.parse_qs(self.path.split('?', 1)[1] if '?' in self.path else '')
        url = (query.get('u') or [''])[0]
        if not basemap_proxy_allowed(url):
            self._error(403, 'Not a saved basemap.')
            return
        status, ctype, body = basemap_fetch(url)
        if status != 200 or not ctype.lower().startswith('image/'):
            self._error(502, 'The basemap service sent no image.')
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'private, max-age=300')  # panning back reuses tiles
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, body_length: int = 0) -> bool:
        """Editor-port code check; sends 401 (or 429) + False if denied. Viewer/localhost always pass.

        Wrong or missing codes, on GET and POST alike, drain the address's
        own failure bucket (see AUTH_FAIL_CAPACITY). While it is empty, every
        gated request from that address is refused before its code is looked
        at, so guessing is slow whatever the method. The right code costs nothing.
        """
        view_only = getattr(self.server, 'view_only', False)
        ip = self.client_address[0]
        gated = not view_only and _access_code is not None and not _is_localhost(ip)
        if gated and not auth_fail_check(ip, take=False):
            self._refuse(429, 'Too many wrong access codes. Retry shortly.', body_length)
            return False
        if _access_code_ok(self.headers, view_only, ip):
            return True
        auth_fail_check(ip, take=True)
        self._refuse(
            401, 'Access denied. Enter the access code from the server console.', body_length
        )
        return False

    def _discard_body(self, length: int) -> None:
        """Read and drop the body of a request that is being refused.

        Closing a socket with unread data in it makes the OS reset the
        connection, and the client can lose the error reply in the reset
        (reliably so on Windows). Bodies too large to be worth reading just get
        the connection closed after the reply.
        """
        self.close_connection = True
        if length > MAX_DRAIN_BYTES:
            return
        self.connection.settimeout(5)  # a client that stops sending must not hold the thread
        with contextlib.suppress(OSError):
            while length > 0 and (chunk := self.rfile.read(min(length, 65536))):
                length -= len(chunk)

    def _drain_available(self) -> None:
        """Drop what a client has already sent of a body whose length is unknown.

        For the same reason as _discard_body: unread data turns the close into
        a reset that can swallow the reply. It waits only briefly for more,
        and never reads past MAX_DRAIN_BYTES.
        """
        self.close_connection = True
        self.connection.settimeout(0.2)
        read = 0
        with contextlib.suppress(OSError):
            while read < MAX_DRAIN_BYTES and (chunk := self.rfile.read1(65536)):
                read += len(chunk)
        self.connection.settimeout(5)

    def _error(self, status: int, message: str) -> None:
        """Every /api error reply: ``{"status": "error", "message": ...}``, the
        message a sentence the page can show as it is."""
        self._send_json({'status': 'error', 'message': message}, status)

    def _refuse(self, status: int, message: str, body_length: int) -> None:
        """Send an error reply to a POST without processing its body."""
        self._discard_body(body_length)
        self._error(status, message)

    def _handle_sync(self) -> None:
        """Full sync payload. Cached prefix + dynamic tail (connected counts).
        Operator IPs tracked server-side for attribution; never sent to peers."""
        global _sync_cache_prefix
        # Read before the data: the answer then holds at least this change,
        # never less, so a page can't take itself to be newer than it is.
        version = current_version()
        with data_lock:
            if _sync_cache_prefix is None:
                data = {
                    'workspaces': DATA_STORE['workspaces'],
                    **shared_settings(),
                    'sources': workspace_sources,
                    'unloaded': sorted(unloaded_workspaces),
                }
                full = json.dumps(data, separators=(',', ':'))
                _sync_cache_prefix = full[:-1].encode('utf-8')
            prefix = _sync_cache_prefix
        # Dynamic tail: connected count + deduped initials (no IPs).
        with sse_lock:
            # Unique machines, not tabs: tabs from one machine share a key (the
            # host's localhost and LAN tabs included) and would otherwise inflate the count.
            connected = len({c.ip for c in sse_clients})
            seen: set = set()
            initials_list: list = []
            where: dict = {}
            for c in sse_clients:
                ini = client_initials.get(c.ip, '')
                if ini and ini not in seen:
                    seen.add(ini)
                    initials_list.append(ini)
                    if ato := client_workspace.get(c.ip):
                        where[ini] = ato
        initials_json = json.dumps(initials_list, ensure_ascii=False).encode('utf-8')
        where_json = json.dumps(where, ensure_ascii=False).encode('utf-8')
        activity_json = json.dumps(activity(), ensure_ascii=False).encode('utf-8')
        # `read_only` is per-listener — lives in the dynamic tail, not the shared prefix.
        ro = b'true' if getattr(self.server, 'view_only', False) else b'false'
        body = (
            prefix
            + b',"connected_users":'
            + str(connected).encode('ascii')
            + b',"connected_initials":'
            + initials_json
            + b',"connected_where":'
            + where_json
            + b',"activity":'
            + activity_json
            + b',"read_only":'
            + ro
            + b',"version":'
            + str(version).encode('ascii')
            + b',"server_version":"'
            + APP_VERSION.encode('ascii')
            + b'"}'
        )
        # A month of reports is megabytes of JSON that every browser downloads
        # after every change; it compresses five to eight times.
        if 'gzip' in self.headers.get('Accept-Encoding', ''):
            self._send_body(
                _gzip_sync_body(body),
                'application/json',
                headers=(('Content-Encoding', 'gzip'), ('Vary', 'Accept-Encoding')),
            )
            return
        self._send_body(body, 'application/json', headers=(('Vary', 'Accept-Encoding'),))

    def _handle_sse(self):
        """SSE stream. `select` wakes on the heartbeat or client disconnect (instant prune on refresh)."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        sock = self.request  # underlying TCP socket
        sock.settimeout(None)  # the stream stays open: no idle timeout

        client = SSEClient(self.wfile, _machine(self.client_address[0]), sock)
        with sse_lock:
            # Past the cap, the machine's oldest streams make way (a tab long
            # gone, most likely), so no one machine can hold threads without end.
            mine = [c for c in sse_clients if c.ip == client.ip]
            oldest = mine[: max(0, len(mine) + 1 - MAX_SSE_PER_MACHINE)]
            sse_clients[:] = [c for c in sse_clients if c not in oldest]
            sse_clients.append(client)
        for c in oldest:
            c.close()
        note_machines()

        client.send(update_notice())  # bootstrap the connecting client

        try:
            while True:
                ready, _, _ = select.select([sock], [], [], SSE_HEARTBEAT_SECONDS)
                if ready:
                    # Socket is readable. For SSE the client never sends data
                    # after the request — so this is a clean close (FIN) or
                    # a reset (RST). Empty recv confirms it.
                    try:
                        chunk = sock.recv(1)
                    except OSError:
                        break
                    if not chunk:
                        break
                    # Unexpected data — ignore.
                else:
                    # Heartbeat doubles as dead-connection probe (catches no-FIN drops).
                    if not client.send(b': heartbeat\n\n'):
                        break
        finally:
            # Prune client and drop IP->initials mapping if no other tabs remain (else dict grows forever).
            with sse_lock:
                with contextlib.suppress(ValueError):
                    sse_clients.remove(client)
                still_here = any(c.ip == client.ip for c in sse_clients)
                if not still_here:
                    client_initials.pop(client.ip, None)
                    client_workspace.pop(client.ip, None)
            note_machines()

    def _serve_workbench(self) -> None:
        content = _get_workbench_html()
        if content is None:
            self.send_error(404, 'index.html not found - run `python scripts/build.py` first')
            return
        # Viewer port: pre-set body class so edit UI is hidden before JS runs (avoids flash).
        view_only = getattr(self.server, 'view_only', False)
        if view_only:
            content = content.replace(b'<body>', b'<body class="read-only">', 1)
        # Host auto-fill: inject the access code into the meta tag for 127.0.0.1 requests.
        if (not view_only) and _access_code and _is_localhost(self.client_address[0]):
            content = content.replace(
                b'<meta name="salt-access-code" content="">',
                ('<meta name="salt-access-code" content="' + _access_code + '">').encode('utf-8'),
                1,
            )
        # Uncacheable, older-browser headers included, so rebuilds propagate
        # without manual cache-clearing.
        self._send_body(
            content, 'text/html; charset=utf-8', headers=(('Pragma', 'no-cache'), ('Expires', '0'))
        )

    # -------------------------------------------------------------------------
    # POST
    # -------------------------------------------------------------------------

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        # None for a path that isn't a route. It gets every check a write gets
        # (no viewer port, a code needed), and its 404 once its body is read.
        route = _ROUTE_TABLE.get(('POST', path))
        # Content-Length first: the refusals below need it to drop the body,
        # and a bad header should report as 400, not "Invalid JSON".
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except (TypeError, ValueError):
            length = -1
        if length < 0:
            # Unknowable body: drop what has already arrived, answer, and close.
            self._drain_available()
            self._bad_request('Invalid Content-Length header.')
            return
        # Viewer port rejects every mutation up front.
        if getattr(self.server, 'view_only', False) and not (route and route.viewer):
            self._refuse(405, 'This server is read-only.', length)
            return
        # Another site's page can make a browser send a POST here (the host's
        # own browser needs no code). Browsers say where a request comes from;
        # anything not from the server's own page is refused.
        origin = self.headers.get('Origin')
        if self.headers.get('Sec-Fetch-Site', '').lower() == 'cross-site' or (
            origin is not None
            and not _same_origin(
                origin, self.headers.get('Host', ''), getattr(self.server, 'tls', None) is not None
            )
        ):
            self._refuse(403, 'Cross-site request refused.', length)
            return
        # Rate-limit before auth/body so wrong-code floods are throttled too.
        if not rate_limit_check(self.client_address[0]):
            self._refuse(429, 'Rate limit exceeded. Retry shortly.', length)
            return
        if (route is None or route.code) and not self._authorized(length):
            return
        # The page always sends JSON. A form on another site can't (only a
        # script, which the browser then asks the server about first).
        ctype = self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
        if path.startswith('/api/') and ctype != 'application/json':
            self._refuse(415, 'Content-Type must be application/json.', length)
            return
        if length > MAX_BODY_BYTES:
            self._refuse(413, 'Payload too large.', length)
            return
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, RecursionError):  # RecursionError: nesting too deep
            self._bad_request('Invalid JSON.')
            return
        if not isinstance(data, dict):
            self._bad_request('Body must be a JSON object.')
            return
        if route is None:
            self._error(404, 'Not found.')
            return
        # Schema check — bad shape never reaches DATA_STORE, and a route can
        # take every field its validator checked as given.
        if route.validator is not None and (err := route.validator(data)):
            self._bad_request(f'Validation failed: {err}.')
            return
        route.handler(self, data)

    def _bad_request(self, message: str) -> None:
        self._error(400, message)

    def _initials(self) -> str:
        """The initials of the operator at this machine, as the server knows
        them (from their profile and their saves), or ''."""
        machine = _machine(self.client_address[0])
        with sse_lock:
            return client_initials.get(machine, '')

    def _actor(self) -> str:
        """Who is behind this connection, for the audit log: ``AB@10.0.0.12`` or the address."""
        ip = self.client_address[0]
        ini = self._initials()
        return f'{ini}@{ip}' if ini else ip

    def _operator(self) -> dict | None:
        """The profile of the operator at this machine, as the server knows it
        (from their profile and their saves), or None while it doesn't."""
        ini = self._initials()
        if not ini:
            return None
        with data_lock:
            return DATA_STORE['profiles'].get(ini)

    def _now_in(self, ato: str) -> bool:
        """Note that this machine's editor is working in ``ato``. True when
        that is news, so the others are told who is where."""
        machine = _machine(self.client_address[0])
        with sse_lock:
            changed = client_workspace.get(machine) != ato
            client_workspace[machine] = ato
        if changed:
            note_machines()
        return changed

    def _commit(self, what: str, *, said: str = '', ato: str = '', **extra) -> None:
        """The end of every successful write: log it, persist, notify clients, confirm.
        ``said``: what it did in plain words, for the Activity list, in ``ato``
        (none for a write that changed nothing anyone would notice)."""
        audit(self._actor(), what)
        if said:
            note_activity(self._initials(), said, ato)
        schedule_save()
        version = broadcast_update()
        # In a header too, so a page reads it before (or without) the body.
        self._send_body(
            json.dumps({'status': 'success', 'version': version, **extra}).encode('utf-8'),
            'application/json',
            headers=(('X-Salt-Change', str(version)),),
        )

    def _unchanged(self, seen: bool = False, *, said: str = '', ato: str = '', **extra) -> None:
        """The end of a write that changed nothing: the same reply, but nothing
        is saved, broadcast to every client, or written to the audit log.
        ``seen``: it changed only what others see of this machine (who is
        connected, and where), which is numbered and broadcast, but not saved;
        ``said`` and ``ato`` then go on the Activity list, as in _commit."""
        if not seen:
            self._send_json({'status': 'success', **extra})
            return
        if said:
            note_activity(self._initials(), said, ato)
        version = broadcast_update()
        self._send_body(
            json.dumps({'status': 'success', 'version': version, **extra}).encode('utf-8'),
            'application/json',
            headers=(('X-Salt-Change', str(version)),),
        )

    def _store_shared(self, key: str, value) -> tuple[bool, Any]:
        """Put a shared setting in place, for every workspace. Says whether it
        was, and what it held before: it wasn't, with nothing stored, when it
        already holds exactly that."""
        with data_lock:
            before = DATA_STORE.get(key)
            if before == value:
                return False, before
            DATA_STORE[key] = value
            invalidate_sync_cache()
            mark_dirty()  # every workspace's backup carries it, and the shared file
        return True, before

    # -------------------------------------------------------------------------
    # POST routes. Each gets the parsed, validated body and sends the reply.
    # -------------------------------------------------------------------------

    def _post_save_reports(self, data: dict) -> None:
        ato = data['ato'].strip().upper()
        incoming = data['reports']
        source = (data.get('source') or '').strip().lower()
        imported = source in ('backup', 'csv')
        if not imported:
            # Learn this connection's operator from the reports it wrote, for
            # IP attribution: the new and changed ones (a report only deleted
            # still names its author). Not from imports: a backup or CSV
            # carries other people's reports, and the importer would take on
            # their identity.
            with data_lock:
                written = _written(DATA_STORE['workspaces'].get(ato, []), incoming)
            for r in written:
                ini = ((r.get('user') or {}).get('initials') or '').strip()
                if ini:
                    machine = _machine(self.client_address[0])
                    with sse_lock:
                        client_initials[machine] = ini
                    break
        # Whoever is here wrote what they send, whatever the reports say. An
        # import keeps its reports' own authors.
        operator = None if imported else self._operator()
        # A backup sends every workspace in it; the importer is in only one.
        if source != 'backup':
            self._now_in(ato)
        with data_lock:
            is_new = ato not in DATA_STORE['workspaces']
            existing = DATA_STORE['workspaces'].get(ato, [])
            changes = report_changes(existing, incoming)
            if operator:
                incoming = _stamp_operator(existing, incoming, operator)
            DATA_STORE['workspaces'][ato] = _merge_reports(existing, incoming)
            unloaded_workspaces.discard(ato)
            # Provenance label; routine edits don't touch source.
            if source == 'backup':
                workspace_sources[ato] = 'Uploaded backup (.txt)'
            elif source == 'csv':
                workspace_sources[ato] = 'Uploaded CSV (.csv)'
            elif is_new:
                workspace_sources[ato] = 'In-session'
            invalidate_sync_cache()
            mark_dirty(ato)
        if imported:
            # Console bulk-import notification (browser shows full state).
            label = 'Backup (.txt)' if source == 'backup' else 'CSV (.csv)'
            safe_print('\n' + '─' * 64)
            safe_print(f"[+] Loaded {label}: {len(incoming)} report(s) merged into ATO '{ato}'.")
            safe_print('─' * 64)
        deleted = sum(1 for r in incoming if r.get('deleted'))
        what = f'save_reports {ato}: {len(incoming)} report(s)'
        if deleted:
            what += f', {deleted} deleted'
        if source in ('backup', 'csv'):
            what += f', from {source}'
        if imported:
            count = sum(len(ids) for ids in changes.values())
            said = f'imported {plural(count, "report")}' if count else ''
        else:
            said = said_of_reports(changes)
        self._commit(what, said=said, ato=ato)

    def _post_unload_ato(self, data: dict) -> None:
        ato = data['ato'].strip().upper()
        with sse_lock:
            for machine in [m for m, a in client_workspace.items() if a == ato]:
                del client_workspace[machine]
        with data_lock:
            changed = DATA_STORE['workspaces'].pop(ato, None) is not None
            if changed:
                unloaded_workspaces.add(ato)
            workspace_sources.pop(ato, None)
            # Its files now hold the only copy of it: none is let go as superseded.
            _merged_files.pop(ato, None)
            cfg = DATA_STORE.get('config') or {}
            if (cfg.get('ato') or '').strip().upper() == ato:
                DATA_STORE['config'] = {}
                changed = True
            if changed:
                invalidate_sync_cache()
                # Every file carries the config, and the unloaded workspace's own
                # file stays on disk (unload is "from view"; a restart reloads it).
                mark_dirty()
        if not changed:
            self._unchanged(message='ATO unloaded.')
            return
        # Saved at once like any write, so the cleared active workspace is on
        # disk; the workspace itself comes back on a restart, from its own file.
        self._commit(f'unload_ato {ato}', said=f'unloaded {ato}', ato=ato, message='ATO unloaded.')

    def _post_edit_report(self, data: dict) -> None:
        ato = data['ato'].strip().upper()
        report_id = data['reportId']
        fields = data['fields']
        # Server-stamped attribution: override client `user` with our IP->initials->profile lookup.
        # Falls back to client claim for brand-new IPs.
        if operator := self._operator():
            fields['user'] = operator
        self._now_in(ato)
        found = stale = changed = False
        display_id = report_id
        with data_lock:
            for r in DATA_STORE['workspaces'].get(ato, []):
                if r.get('id') != report_id:
                    continue
                found = True
                # Newest edit wins, as when reports merge: an edit made to an
                # older copy than the server's would undo someone's later change.
                if 'lastModified' in fields and _sort_num(fields['lastModified']) < _sort_num(
                    r.get('lastModified')
                ):
                    stale = True
                    break
                # Not when and by whom alone: that changes nothing anyone reads.
                changed = any(
                    r.get(k) != fields[k]
                    for k in _EDITABLE_FIELDS
                    if k in fields and k not in _SAVED_BY
                )
                for k in _EDITABLE_FIELDS:
                    if k in fields:
                        r[k] = fields[k]
                display_id = str(r.get('displayId') or report_id)
                if 'lastModified' not in fields:
                    r['lastModified'] = int(time.time() * 1000)
                break
            if found and not stale:
                invalidate_sync_cache()
                mark_dirty(ato)
        if not found:
            self._error(404, 'Report not found.')
            return
        if stale:
            self._error(
                409,
                'This report was changed after the copy being edited. '
                'It was not edited; open it again.',
            )
            return
        said = f'updated {display_id}' if changed else ''
        self._commit(f'edit_report {ato} {report_id}', said=said, ato=ato)

    def _post_delete_history(self, data: dict) -> None:
        ato = data['ato'].strip().upper()
        drop: dict = {}
        for d in data['deletions']:
            drop.setdefault(d['reportId'], set()).add(d['lastModified'])
        removed = 0
        trimmed: list = []  # the displayIds of the reports they were removed from
        now_ms = int(time.time() * 1000)
        with data_lock:
            for r in DATA_STORE['workspaces'].get(ato, []):
                if not (lms := drop.get(r.get('id'))):
                    continue
                hist = r.get('history') or []
                kept = [
                    h for h in hist if not isinstance(h, dict) or h.get('lastModified') not in lms
                ]
                if len(kept) != len(hist):
                    removed += len(hist) - len(kept)
                    trimmed.append(str(r.get('displayId') or r.get('id')))
                    r['history'] = kept
                    r['lastModified'] = now_ms
            if removed > 0:
                invalidate_sync_cache()
                mark_dirty(ato)
        if not removed:
            self._unchanged(removed=0)
            return
        said = f'removed {plural(removed, "earlier version")}'
        if len(trimmed) == 1:
            said += f' of {trimmed[0]}'
        self._commit(
            f'delete_history {ato}: {removed} entries', said=said, ato=ato, removed=removed
        )

    def _post_save_config(self, data: dict) -> None:
        cfg = data.get('config')
        if not cfg:
            self._unchanged()
            return
        # Keep only the fields the app uses: config is re-broadcast to
        # every client on every sync, so arbitrary extra keys would
        # bloat everyone's payload and the backup file.
        clean = {'ato': cfg.get('ato', ''), 'title': cfg.get('title', '')}
        # Each editor has their own workspace: this is the one viewers are
        # shown, and where this editor now is.
        where = (clean['ato'] or '').strip().upper()
        moved = self._now_in(where)
        with data_lock:
            revived = clean['ato'] in unloaded_workspaces
            unloaded_workspaces.discard(clean['ato'])
            if revived:
                invalidate_sync_cache()
        stored, before = self._store_shared('config', clean)  # the config rides in every file
        # For the Activity list: this editor's switch, else what viewers are shown.
        if not where:
            said = ''
        elif moved:
            said = f'moved to {where}'
        elif (before or {}).get('ato') == clean['ato']:
            said = f'set the title of {where}'
        else:
            said = f'showed viewers {where}'
        if not stored:
            self._unchanged(seen=moved or revived, said=said if moved else '', ato=where)
            return
        self._commit(f'save_config {clean["ato"]} / {clean["title"]}', said=said, ato=where)

    def _post_save_shared(self, data: dict, section: SharedSection) -> None:
        """The save route of every shared setting stored as its section cleans
        it: the format, overlays, basemaps, drones and narrative (see
        SHARED_SECTIONS). One for every workspace; an ATO an older page sends
        is ignored."""
        clean = section.clean(data[section.key])
        stored, before = self._store_shared(section.key, clean)
        if not stored:
            self._unchanged()
            return
        self._commit(section.logged(clean), said=section.said(before, clean))

    def _post_wms_fetch(self, data: dict) -> None:
        # Changes nothing here, so no save and no broadcast; logged all the
        # same, as the server reached out on an editor's behalf.
        url = data['url'].strip()
        audit(self._actor(), f'wms_fetch {url.split("?", 1)[0][:200]}')
        self._send_json({'status': 'success', **wms_fetch(url)})

    def _post_save_profile(self, data: dict) -> None:
        profile = data['profile']
        ini = profile['initials'].strip()
        # Known fields only (see save_config), keyed by the same stripped
        # initials the IP map uses, so server-stamped attribution matches.
        clean = {'initials': ini, 'color': profile.get('color', '#0a84ff')}
        with data_lock:
            changed = DATA_STORE['profiles'].get(ini) != clean
            if changed:
                DATA_STORE['profiles'][ini] = clean
                invalidate_sync_cache()
                mark_dirty()  # profiles ride in every file
        # IP -> initials so /api/sync includes them and /api/edit_report can server-stamp.
        machine = _machine(self.client_address[0])
        with sse_lock:
            known = client_initials.get(machine) == ini
            client_initials[machine] = ini
        if not known:
            note_machines()
        if not changed:
            self._unchanged(seen=not known)  # who is connected changed, if nothing else did
            return
        self._commit(f'save_profile {ini}', said='set their profile')


# =============================================================================
# Routes
# =============================================================================
# Every path the server answers, once: its method, the handler, for a POST the
# validator that checks the body first, and who may use it. do_GET and do_POST
# look a request up here and apply the entry's rules. A path not here is a 404
# (JSON under /api, the standard library's HTML page elsewhere); a POST to one
# is refused like any write before it is told so.


class Limit(NamedTuple):
    """A GET route's own rate limit: checked before the code, 429 when it says no."""

    check: Callable[[str], bool]  # the client's address -> allowed
    message: str


class Route(NamedTuple):
    """One path the server answers (see ROUTES)."""

    method: str  # 'GET' or 'POST'
    path: str  # without the query string
    # A SaltSyncHandler method that sends the reply: handler(self) for a GET,
    # handler(self, body) for a POST, the body parsed and validated.
    handler: Callable
    # POST: checks the body's shape; what it says is the 400's message.
    validator: Callable[[dict], str | None] | None = None
    # Needs the access code on the editor port. The viewer port never asks
    # (the port is the gate), and the host's own browser passes.
    code: bool = True
    # May be used on the viewer port; a route that writes may not (405).
    viewer: bool = True
    # GET: a rate limit of its own (POSTs all share one, in do_POST).
    limit: Limit | None = None


_H = SaltSyncHandler  # keeps each route below on one line

# The shared settings whose save route is a handler of its own (their
# SharedSection has no ``clean``): it does more than store what is sent.
_OWN_SAVE_ROUTES = {'config': _H._post_save_config, 'profiles': _H._post_save_profile}


def _save_route(s: SharedSection) -> Route:
    """A shared setting's save route: its own handler, or the one the others share."""
    if s.clean is None:
        handler = _OWN_SAVE_ROUTES[s.key]
    else:
        handler = functools.partial(_H._post_save_shared, section=s)
    return Route('POST', s.route, handler, s.validator, viewer=False)


ROUTES: tuple[Route, ...] = (
    # The page. No code: the data endpoints are gated, and the page asks for
    # the code before it calls them.
    Route('GET', '/', _H._serve_workbench, code=False),
    Route('GET', '/index.html', _H._serve_workbench, code=False),
    # Its old single-file name, so old bookmarks still open it.
    Route('GET', '/Salt%20Report%20Workbench.html', _H._serve_workbench, code=False),
    # No code needed: it says nothing about the reports, and a monitoring
    # script or a browser on any machine can ask.
    Route('GET', '/api/health', _H._handle_health, code=False),
    Route('GET', '/api/sync', _H._handle_sync),
    Route('GET', '/api/events', _H._handle_sse),
    # Each one can make the server fetch and hold up to 16 MB, and the viewer
    # port needs no code, so it is limited on both ports.
    Route(
        'GET',
        '/api/basemap',
        _H._handle_basemap,
        limit=Limit(basemap_rate_check, 'Too many map images. Retry shortly.'),
    ),
    Route('POST', '/api/save_reports', _H._post_save_reports, _v_save_reports, viewer=False),
    Route('POST', '/api/unload_ato', _H._post_unload_ato, _check_ato, viewer=False),
    Route('POST', '/api/edit_report', _H._post_edit_report, _v_edit_report, viewer=False),
    Route('POST', '/api/delete_history', _H._post_delete_history, _v_delete_history, viewer=False),
    # Changes nothing, but the server reaches out on an editor's behalf.
    Route('POST', '/api/wms_fetch', _H._post_wms_fetch, _v_wms_fetch, viewer=False),
    # Each shared setting's, from SHARED_SECTIONS.
    *(_save_route(s) for s in SHARED_SECTIONS),
)
# (method, path) -> its Route.
_ROUTE_TABLE = {(r.method, r.path): r for r in ROUTES}


# =============================================================================
# HTTPS
# =============================================================================
# Python serves TLS but can't make a certificate, so the server makes its own:
# an RSA key and a self-signed X.509 certificate, built from the standard
# library. OpenSSL, through the ssl module, does all the encryption; this code
# only writes the two files it loads.


def _der(tag: int, body: bytes) -> bytes:
    """One DER element: tag, length, body."""
    n = len(body)
    if n < 0x80:
        return bytes((tag, n)) + body
    size = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes((tag, 0x80 | len(size))) + size + body


def _der_seq(*parts: bytes) -> bytes:
    return _der(0x30, b''.join(parts))


def _der_int(v: int) -> bytes:
    return _der(0x02, v.to_bytes(v.bit_length() // 8 + 1, 'big'))


def _der_oid(dotted: str) -> bytes:
    first, second, *arcs = (int(x) for x in dotted.split('.'))
    out = bytearray([40 * first + second])
    for arc in arcs:
        chunk = [arc & 0x7F]
        arc >>= 7
        while arc:
            chunk.append(0x80 | (arc & 0x7F))
            arc >>= 7
        out += bytes(reversed(chunk))
    return _der(0x06, bytes(out))


def _pem(label: str, der: bytes) -> bytes:
    b64 = base64.b64encode(der).decode('ascii')
    lines = [b64[i : i + 64] for i in range(0, len(b64), 64)]
    text = f'-----BEGIN {label}-----\n' + '\n'.join(lines) + f'\n-----END {label}-----\n'
    return text.encode('ascii')


_SMALL_PRIMES = [p for p in range(3, 2000, 2) if all(p % q for q in range(3, math.isqrt(p) + 1, 2))]


def _is_probable_prime(n: int, rounds: int = 40) -> bool:
    """Miller-Rabin with random bases, after trial division by small primes."""
    if any(n % p == 0 for p in _SMALL_PRIMES):
        return n in _SMALL_PRIMES
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        x = pow(secrets.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _random_prime(bits: int) -> int:
    """A random prime with its top two bits set, so two make a full-size modulus."""
    while True:
        n = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if _is_probable_prime(n):
            return n


def make_self_signed_cert(
    names: list, ips: list, days: int = TLS_CERT_DAYS, now: datetime | None = None
) -> tuple[bytes, bytes]:
    """A 2048-bit RSA key and a self-signed certificate for the host ``names``
    and ``ips``, as PEM: (certificate, key)."""
    e = 65537
    while True:
        p, q = _random_prime(1024), _random_prime(1024)
        phi = (p - 1) * (q - 1)
        if p != q and math.gcd(e, phi) == 1:
            break
    n, d = p * q, pow(e, -1, phi)
    now = now or datetime.now(timezone.utc)

    def utc_time(t: datetime) -> bytes:
        return _der(0x17, t.strftime('%y%m%d%H%M%SZ').encode('ascii'))

    def extension(oid: str, value: bytes, critical: bool = False) -> bytes:
        return _der_seq(_der_oid(oid), b'\x01\x01\xff' if critical else b'', _der(0x04, value))

    sha256_rsa = _der_seq(_der_oid('1.2.840.113549.1.1.11'), b'\x05\x00')
    name = _der_seq(_der(0x31, _der_seq(_der_oid('2.5.4.3'), _der(0x0C, b'SALT Report Workbench'))))
    public = _der_seq(_der_int(n), _der_int(e))
    spki = _der_seq(
        _der_seq(_der_oid('1.2.840.113549.1.1.1'), b'\x05\x00'), _der(0x03, b'\x00' + public)
    )
    alt = b''.join(_der(0x82, h.encode('ascii')) for h in names) + b''.join(
        _der(0x87, ipaddress.ip_address(ip).packed) for ip in ips
    )
    extensions = _der_seq(
        extension('2.5.29.19', _der_seq(), critical=True),  # not a CA
        extension('2.5.29.15', _der(0x03, b'\x05\xa0'), critical=True),  # sign, encipher keys
        extension('2.5.29.37', _der_seq(_der_oid('1.3.6.1.5.5.7.3.1'))),  # TLS server
        extension('2.5.29.14', _der(0x04, hashlib.sha1(public, usedforsecurity=False).digest())),
        extension('2.5.29.17', _der_seq(alt)),
    )
    tbs = _der_seq(
        _der(0xA0, _der_int(2)),  # X.509 v3
        _der_int(secrets.randbits(63) | 1),
        sha256_rsa,
        name,
        _der_seq(utc_time(now - timedelta(days=1)), utc_time(now + timedelta(days=days))),
        name,
        spki,
        _der(0xA3, extensions),
    )
    # PKCS #1 v1.5: the SHA-256 DigestInfo, padded to the key's size, signed.
    digest = bytes.fromhex('3031300d060960864801650304020105000420') + hashlib.sha256(tbs).digest()
    padded = b'\x00\x01' + b'\xff' * (256 - len(digest) - 3) + b'\x00' + digest
    signature = pow(int.from_bytes(padded, 'big'), d, n).to_bytes(256, 'big')
    cert = _der_seq(tbs, sha256_rsa, _der(0x03, b'\x00' + signature))
    key = _der_seq(
        *(_der_int(v) for v in (0, n, e, d, p, q, d % (p - 1), d % (q - 1), pow(q, -1, p)))
    )
    return _pem('CERTIFICATE', cert), _pem('RSA PRIVATE KEY', key)


def _plain_ip(a: str) -> str | None:
    """An address without its IPv6 zone, or None when it isn't one."""
    try:
        return str(ipaddress.ip_address(a.split('%', 1)[0]))
    except ValueError:
        return None


def tls_files(folder: str) -> tuple[str, str]:
    """The server's own certificate and key, in ``folder``/tls: made when
    missing, again near expiry, and again when they don't cover this machine's
    address (a browser then warns once more, as it would for the new address)."""
    tls_dir = os.path.join(folder, TLS_DIR_NAME)
    cert, key, info = (
        os.path.join(tls_dir, n) for n in ('salt-cert.pem', 'salt-key.pem', 'salt-cert.json')
    )
    ip = get_local_ip()
    now = datetime.now(timezone.utc)
    try:
        with open(info, encoding='utf-8') as f:
            meta = json.load(f)
        left = datetime.fromisoformat(meta['expires']) - now
        if (
            left > timedelta(days=TLS_RENEW_DAYS)
            and ip in meta['ips']
            and os.path.isfile(cert)
            and os.path.isfile(key)
        ):
            return cert, key
    except (OSError, ValueError, KeyError, TypeError):
        pass
    ips = sorted({'127.0.0.1', ip, *filter(None, map(_plain_ip, _local_ips()))})
    host = socket.gethostname()
    names = ['localhost'] + ([host] if re.fullmatch(r'[A-Za-z0-9.-]{1,253}', host) else [])
    cert_pem, key_pem = make_self_signed_cert(names, ips, now=now)
    os.makedirs(tls_dir, exist_ok=True)
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # owner-only where it counts
    with os.fdopen(fd, 'wb') as f:
        f.write(key_pem)
    with open(cert, 'wb') as f:
        f.write(cert_pem)
    with open(info, 'w', encoding='utf-8') as f:  # written last: it vouches for the other two
        json.dump({'expires': (now + timedelta(days=TLS_CERT_DAYS)).isoformat(), 'ips': ips}, f)
    return cert, key


def cert_fingerprint(certfile: str) -> str:
    """The SHA-256 fingerprint of the first certificate in a PEM file, as
    browsers show it: upper-case hex pairs."""
    with open(certfile, encoding='ascii') as f:
        m = re.search(r'-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----', f.read(), re.S)
    if not m:
        raise ValueError(f'{certfile} holds no PEM certificate')
    digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(m.group(0))).hexdigest().upper()
    return ' '.join(digest[i : i + 2] for i in range(0, len(digest), 2))


def tls_context(certfile: str, keyfile: str):
    """A server-side TLS context: TLS 1.2 or newer, with this certificate."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(certfile, keyfile)
    return ctx


_HOST_HEADER_RE = re.compile(r'[A-Za-z0-9.\-:\[\]]{1,300}')


def _redirect_to_https(sock: socket.socket) -> None:
    """Answer a plain-HTTP request on an HTTPS port (an old bookmark, a typed
    address) with a redirect to the same address over https://."""
    head = b''
    # TLS_HANDSHAKE_TIMEOUT for the whole head, not per read: a client sending
    # a byte at a time must not hold the thread for long.
    deadline = time.monotonic() + TLS_HANDSHAKE_TIMEOUT
    with contextlib.suppress(OSError):
        while b'\r\n\r\n' not in head and len(head) < 16384:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            sock.settimeout(left)
            chunk = sock.recv(4096)
            if not chunk:
                break
            head += chunk
    lines = head.split(b'\r\n')
    parts = lines[0].split(b' ')
    # Percent-encoded byte for byte, so nothing but URL characters (no CR, LF
    # or space) can reach the Location header; an encoded path stays as it is.
    path = (
        urllib.parse.quote_from_bytes(parts[1], safe="/?#[]@!$&'()*+,;=:%~")
        if len(parts) > 1 and parts[1].startswith(b'/')
        else '/'
    )
    host = next(
        (
            line.split(b':', 1)[1].strip().decode('latin-1')
            for line in lines[1:]
            if line.lower().startswith(b'host:')
        ),
        '',
    )
    if not _HOST_HEADER_RE.fullmatch(host):
        with contextlib.suppress(OSError):
            host = f'{get_local_ip()}:{sock.getsockname()[1]}'
    reply = (
        'HTTP/1.1 307 Temporary Redirect\r\n'
        f'Location: https://{host}{path}\r\n'
        'Content-Length: 0\r\nConnection: close\r\n\r\n'
    )
    with contextlib.suppress(OSError):
        sock.sendall(reply.encode('latin-1'))


# =============================================================================
# Server
# =============================================================================


class SaltSyncServer(socketserver.ThreadingTCPServer):
    # SO_REUSEADDR lets a restart rebind a port whose old sockets are still in
    # TIME_WAIT. On Windows it also lets a second copy of the server bind a port
    # that is already listening, so two launches ran side by side with the
    # traffic split between them and both wrote the same backups. There,
    # SO_EXCLUSIVEADDRUSE refuses the second bind instead, and a closed listener
    # can be rebound at once without SO_REUSEADDR.
    allow_reuse_address = os.name != 'nt'
    daemon_threads = True  # SSE threads die with main on Ctrl+C

    def __init__(self, *args, view_only: bool = False, tls=None, **kwargs):
        # Per-listener mode flag; handler checks via self.server.view_only.
        self.view_only = view_only
        # An ssl.SSLContext serves HTTPS; None serves plain HTTP.
        self.tls = tls
        super().__init__(*args, **kwargs)

    def finish_request(self, request, client_address):
        """With HTTPS, a connection that opens with a TLS handshake is wrapped
        and served; one that sends a plain request is redirected to https://.
        Runs on the connection's own thread, so a slow client holds up no one."""
        if self.tls is None:
            super().finish_request(request, client_address)
            return
        try:
            request.settimeout(TLS_HANDSHAKE_TIMEOUT)
            first = request.recv(1, socket.MSG_PEEK)
            if first != b'\x16':  # not a TLS handshake record
                if first:
                    _redirect_to_https(request)
                return
            conn = self.tls.wrap_socket(request, server_side=True)
        except OSError:  # a browser turning the certificate down, or a client gone
            return
        try:
            # The handler sets its idle timeout in setup(); event streams clear it.
            super().finish_request(conn, client_address)
        finally:
            with contextlib.suppress(OSError):
                conn.close()

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        """Stay quiet when a client just goes away (closed tabs, dropped SSE
        streams); report anything else, which is a bug worth seeing."""
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)) or (
            ssl is not None and isinstance(exc, ssl.SSLError)
        ):
            return
        safe_print(f'[!] Error handling a request from {client_address[0]}: {exc!r}')


# =============================================================================
# Boot
# =============================================================================


def display_host() -> str:
    """The address the banner shows and the browser opens: the LAN address when
    listening on every interface, else the one listened on (``--host``)."""
    if HOST in ('', '0.0.0.0', '::'):
        return get_local_ip()
    return f'[{HOST}]' if ':' in HOST else HOST


def run_boot_dashboard(
    viewer_port: int | None = None,
    fingerprint: str | None = None,
    own_cert: bool = False,
    skipped: int = 0,
) -> None:
    """Boot banner — title, network URL, access code, optional viewer URL, with
    HTTPS the certificate's fingerprint (``fingerprint`` None: plain HTTP), and
    how many backup files could not be loaded."""
    ip = display_host()
    scheme = 'http' if fingerprint is None else 'https'
    safe_print('\n' + '═' * 64)
    safe_print(f'                  S.A.L.T. Sync Server {APP_VERSION}')
    safe_print('═' * 64)
    safe_print('[*] Starting S.A.L.T. Sync Server...')
    safe_print(f'[+] Workbench   : {scheme}://{ip}:{PORT}')
    if _access_code is None:
        safe_print('[!] Access Code : UNGATED  (no code, so anyone can edit)')
    else:
        safe_print(f'[+] Access Code : {_access_code}')
    if viewer_port is not None:
        safe_print(f'[+] Read Only   : {scheme}://{ip}:{viewer_port}')
    if fingerprint is None:
        safe_print('[!] Plain HTTP  : the code and reports cross the network unencrypted.')
    else:
        safe_print(f'[+] Certificate : {fingerprint[:47]}')
        safe_print(f'                  {fingerprint[48:]}')
        if not own_cert:
            safe_print('[*] Browsers warn once about this self-signed certificate:')
            safe_print('    choose Advanced, then Proceed. Its fingerprint is shown above.')
    if skipped:
        safe_print(
            f'[!] Skipped     : {skipped} backup file(s) that could not be read (named above)'
        )
    safe_print('[*] Press Ctrl+C to stop.')
    safe_print('═' * 64 + '\n')


def parse_cli_args() -> argparse.Namespace:
    """CLI knobs for ports, bind, backup dir, auto-launch, access code, and
    HTTPS (--no-https, or your own --cert and --key)."""
    p = argparse.ArgumentParser(
        prog='salt_sync_server',
        description='S.A.L.T. Report Workbench sync server.',
    )
    p.add_argument(
        '--port',
        type=int,
        default=PORT,
        help=f'Editor port to listen on, HTTPS unless --no-https (default: {PORT}).',
    )
    p.add_argument(
        '--host',
        default=HOST,
        help=f'Interface to bind (default: {HOST!r}; use 127.0.0.1 to restrict to localhost).',
    )
    p.add_argument(
        '--backup-dir',
        default=BACKUP_DIR,
        help=f'Directory for backup .txt files (default: {BACKUP_DIR!r}).',
    )
    p.add_argument(
        '--no-browser',
        action='store_true',
        help='Do not auto-open the workbench in a browser on launch.',
    )
    p.add_argument(
        '--no-minimize', action='store_true', help='Do not minimize the console window on Windows.'
    )
    p.add_argument(
        '--viewer-port',
        type=int,
        default=VIEWER_PORT,
        metavar='PORT',
        help=f'Read-only sister listener (default: {VIEWER_PORT}). '
        'Clients hitting this port see live data via SSE but '
        'every POST returns 405. Pass 0 to disable.',
    )
    p.add_argument(
        '--access-code',
        default=None,
        metavar='CODE',
        help='Override the auto-generated editor access code with '
        'a specific value (e.g. for testing or a memorable '
        'session code). Default: a fresh random code each launch.',
    )
    p.add_argument(
        '--no-access-code',
        action='store_true',
        help='Disable the editor-port access-code gate entirely. '
        'Everyone on the LAN can edit. Use only on a fully '
        'trusted network.',
    )
    p.add_argument(
        '--no-https',
        action='store_true',
        help='Serve plain HTTP. The access code and every report then cross the '
        'network unencrypted; use only on an encrypted or fully trusted network.',
    )
    p.add_argument(
        '--cert',
        metavar='FILE',
        help='Your own TLS certificate (PEM) instead of the self-signed one. Needs --key.',
    )
    p.add_argument('--key', metavar='FILE', help='The private key (PEM) for --cert.')
    p.add_argument(
        '--restore',
        metavar='SNAPSHOT',
        help='Put a snapshot round back in place of the backups, then exit: its time '
        'as the files in snapshots/ are named (20261028_101500Z), latest, or list to see '
        'them. The backups it replaces are kept in snapshots/before-restore-<time>/. '
        'Run it with the server stopped.',
    )
    args = p.parse_args()
    if bool(args.cert) != bool(args.key):
        p.error('--cert and --key go together')
    if args.no_https and args.cert:
        p.error('--no-https and --cert contradict each other')
    # A blank override would match a missing cookie and silently open the
    # editor port; other characters would not survive the browser's cookie.
    if args.access_code is not None and not ACCESS_CODE_OVERRIDE_RE.fullmatch(
        args.access_code.strip()
    ):
        p.error('--access-code must be 6-64 letters, digits, "-" or "_"')
    return args


def snapshot_rounds() -> dict:
    """The snapshot rounds in ``BACKUP_DIR/snapshots/``: time -> file names."""
    snap_dir = os.path.join(BACKUP_DIR, SNAPSHOT_DIR_NAME)
    rounds: dict = {}
    if os.path.isdir(snap_dir):
        for f in sorted(os.listdir(snap_dir)):
            if (m := _SNAPSHOT_NAME_RE.match(f)) and os.path.isfile(os.path.join(snap_dir, f)):
                rounds.setdefault(m.group(1), []).append(f)
    return rounds


def _server_answers(port: int) -> bool:
    """Whether something already listens on ``port`` here (a server running)."""
    host = '127.0.0.1' if HOST in ('', '0.0.0.0') else HOST
    try:
        socket.create_connection((host, port), timeout=1).close()
        return True
    except OSError:
        return False


def restore_snapshot(which: str) -> int:
    """--restore: put one snapshot round's backups in place of the live ones.

    ``which`` is a round's time as its files are named (``20261028_101500Z``),
    ``latest``, or ``list`` to see them. The live backups are first copied to
    ``snapshots/before-restore-<time>/`` (never pruned), then replaced, so a
    restore can itself be undone the same way by hand. Refuses while a server
    answers on PORT: it would write its own copy back over the restore.
    Returns the exit status.
    """
    rounds = snapshot_rounds()
    if not rounds:
        safe_print(f'[!] No snapshots in {os.path.join(BACKUP_DIR, SNAPSHOT_DIR_NAME)}.')
        return 1
    newest = sorted(rounds, reverse=True)
    if which == 'list':
        safe_print(f'[*] Snapshot rounds in {BACKUP_DIR}, newest first:')
        for r in newest:
            safe_print(f'    {r}  ({len(rounds[r])} file(s))')
        return 0
    stamp = newest[0] if which == 'latest' else which
    if stamp not in rounds:
        safe_print(f'[!] No snapshot round named {which}. The newest:')
        for r in newest[:10]:
            safe_print(f'    {r}')
        safe_print('    (--restore list shows them all.)')
        return 1
    if _server_answers(PORT):
        safe_print(f'[!] A server is running on port {PORT}. Stop it (Ctrl+C in its window),')
        safe_print('    then run --restore again.')
        return 1
    snap_dir = os.path.join(BACKUP_DIR, SNAPSHOT_DIR_NAME)
    keep = os.path.join(snap_dir, f'before-restore-{datetime.now(timezone.utc):%Y%m%d_%H%M%S}Z')
    live = [
        f
        for f in os.listdir(BACKUP_DIR)
        if (f.endswith('.txt') or f == SHARED_SETTINGS_NAME)
        and os.path.isfile(os.path.join(BACKUP_DIR, f))
    ]
    os.makedirs(keep, exist_ok=True)
    for f in live:
        shutil.copy2(os.path.join(BACKUP_DIR, f), os.path.join(keep, f))
    for f in live:
        os.unlink(os.path.join(BACKUP_DIR, f))
    for f in rounds[stamp]:
        shutil.copy2(os.path.join(snap_dir, f), os.path.join(BACKUP_DIR, f[len(stamp) + 1 :]))
    audit('server', f'restored snapshot {stamp}: {len(rounds[stamp])} file(s)')
    safe_print(f'[+] Restored snapshot {stamp}: {len(rounds[stamp])} file(s).')
    safe_print(f'[+] The {len(live)} file(s) it replaced are in {keep}.')
    safe_print('[*] Start the server as usual to load it.')
    return 0


def graceful_drain() -> None:
    """Notify SSE clients of shutdown, then flush pending disk write."""
    try:
        with sse_lock:
            snapshot = list(sse_clients)
        for c in snapshot:
            with contextlib.suppress(Exception):
                c.send(b'event: shutdown\ndata: server-stopping\n\n')
    except Exception:
        pass
    try:
        flush_pending_save()
        safe_print('[+] Pending changes flushed to disk.')
    except Exception as exc:
        safe_print(f'[!] Error flushing on shutdown: {exc}')
    audit('server', 'stopped')


if __name__ == '__main__':
    args = parse_cli_args()
    # CLI values win over module defaults; functions look names up at call time.
    PORT = args.port
    HOST = args.host
    BACKUP_DIR = args.backup_dir
    # Access code: explicit override > --no-access-code > random per-launch. Uppercase to match comparison.
    if args.no_access_code:
        _access_code = None
    elif args.access_code:
        _access_code = args.access_code.strip().upper()
    else:
        _access_code = _generate_access_code()

    if args.restore:
        sys.exit(restore_snapshot(args.restore.strip()))

    # Never fall back to plain HTTP unasked: the code and every report would
    # cross the network readable while the operator believed them encrypted.
    if ssl is None and not args.no_https:
        safe_print('\n[!] This Python has no ssl module, so the server cannot serve HTTPS.')
        safe_print('    Use a Python that has it (the python.org installers do), or start')
        safe_print('    with --no-https to serve plain HTTP on a trusted network.')
        sys.exit(1)

    skipped = load_data_from_disk()

    # HTTPS unless --no-https: a certificate given with --cert, or the server's own.
    tls = None
    fingerprint = None
    if not args.no_https:
        try:
            certfile, keyfile = (args.cert, args.key) if args.cert else tls_files(BACKUP_DIR)
            tls = tls_context(certfile, keyfile)
            fingerprint = cert_fingerprint(certfile)
        except (OSError, ValueError) as exc:
            safe_print(f'\n[!] Could not set up HTTPS: {exc}')
            safe_print('    Fix the certificate files, or start with --no-https.')
            sys.exit(1)
    scheme = 'http' if tls is None else 'https'

    try:
        httpd = SaltSyncServer((HOST, PORT), SaltSyncHandler, tls=tls)
    except OSError as exc:
        safe_print(f'\n[!] Could not listen on port {PORT}: {exc}')
        safe_print('    Is the server already running? Close it, or start this one with --port.')
        sys.exit(1)

    # Optional viewer listener — same DATA_STORE; view_only=True returns 405 on POST. SSE spans both.
    # Created before the boot dashboard so it can report the actually-bound port.
    viewer_httpd: SaltSyncServer | None = None
    viewer_port_bound: int | None = None
    requested_vp = args.viewer_port
    if requested_vp and requested_vp != PORT:
        try:
            viewer_httpd = SaltSyncServer(
                (HOST, requested_vp), SaltSyncHandler, view_only=True, tls=tls
            )
            threading.Thread(target=viewer_httpd.serve_forever, daemon=True).start()
            viewer_port_bound = requested_vp
        except OSError as exc:
            safe_print(f'[!] Could not start viewer on port {requested_vp}: {exc}')
    elif requested_vp == PORT:
        safe_print(f'[!] --viewer-port matches --port ({PORT}); ignored.')

    run_boot_dashboard(
        viewer_port=viewer_port_bound,
        fingerprint=fingerprint,
        own_cert=bool(args.cert),
        skipped=skipped,
    )
    audit(
        'server',
        f'started ({scheme}): editor port {PORT}, viewer port {viewer_port_bound or "off"}',
    )

    _server_ip = display_host()

    def _launch():
        time.sleep(0.3)  # let the server come up
        if not args.no_browser:
            webbrowser.open(f'{scheme}://{_server_ip}:{PORT}')
            time.sleep(0.1)
        # Windows-only console minimize; guarded so non-Windows doesn't AttributeError.
        if os.name == 'nt' and not args.no_minimize:
            try:
                hwnd = ctypes.windll.kernel32.GetConsoleWindow()
                if hwnd:
                    ctypes.windll.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
            except Exception:
                pass

    # Skip the launch thread when it has no work to do.
    if not args.no_browser or (os.name == 'nt' and not args.no_minimize):
        threading.Thread(target=_launch, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        safe_print('\n[*] Shutting down gracefully...')
    finally:
        graceful_drain()
        httpd.server_close()
        if viewer_httpd is not None:
            try:
                viewer_httpd.shutdown()
                viewer_httpd.server_close()
            except Exception:
                pass

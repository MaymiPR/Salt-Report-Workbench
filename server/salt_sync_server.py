# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import contextlib
import ctypes
import http.server as server
import json
import os
import re
import secrets
import select
import socket
import socketserver
import tempfile
import threading
import time
import webbrowser
from datetime import datetime, timezone

# --- Configuration ---
PORT: int = 8080
HOST: str = '0.0.0.0'
# Viewer port — second listener, POSTs return 405. `--viewer-port 0` disables. Bind failure is non-fatal for editor.
VIEWER_PORT: int | None = 8081
_HERE = os.path.dirname(os.path.abspath(__file__))
# Next to the server (as documented), not the launch directory.
BACKUP_DIR = os.path.join(_HERE, 'Auto Backups')
MAX_BODY_BYTES: int = 1024 * 1024  # 1 MB cap on incoming POST bodies
SAVE_DEBOUNCE_SECONDS: float = 0.5  # coalesce rapid mutations into one disk write

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

# --- Thread-safe data store ---
data_lock = threading.Lock()
DATA_STORE: dict = {
    'workspaces': {},
    'config': {'ato': '', 'title': ''},
    'profiles': {},
    'formats': {},  # ato -> report-format dict (builder); synced to all clients
}

# Cached /api/sync prefix — all but the closing brace and connected_users count. Invalidated on every mutation.
_sync_cache_prefix: bytes | None = None  # protected by data_lock

# Per-workspace provenance (ato -> source label). Rides on /api/sync. Protected by data_lock.
workspace_sources: dict = {}

# --- SSE client registry ---
sse_lock = threading.Lock()
sse_clients: list = []

# IP -> initials. Powers the deduped /api/sync connected list and server-stamped
# attribution on /api/edit_report. Pruned on SSE disconnect. Protected by sse_lock.
client_initials: dict = {}

# --- Debounced disk-write state ---
_save_timer: threading.Timer | None = None
_save_timer_lock = threading.Lock()

# --- Access code (editor-port gate) ---
# Random per-launch code; host shares it verbally with editors. Viewer port is NOT
# gated. Host's browser auto-fills via meta injection on 127.0.0.1 requests.
# Alphabet excludes confusables (0/O, 1/l/I, 5/S) for radio-readability.
ACCESS_CODE_ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ'  # no 0/O, 1/I/l, 5/S
ACCESS_CODE_LENGTH = 10
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
    """Thread-safe SSE writer; carries client IP for attribution lookups."""

    __slots__ = ('_lock', 'ip', 'wfile')

    def __init__(self, wfile, ip: str = ''):
        self.wfile = wfile
        self._lock = threading.Lock()
        self.ip = ip

    def send(self, payload: bytes) -> bool:
        """Write to SSE stream; False on disconnect."""
        with self._lock:
            try:
                self.wfile.write(payload)
                self.wfile.flush()
                return True
            except Exception:
                return False


def broadcast_update() -> None:
    """Push data-update to every SSE client; prune dead. Snapshots under lock,
    writes lock-free so a stuck peer can't block other ops."""
    payload = b'data: update\n\n'
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
        fallback = msg.replace('™', '(TM)').replace('©', '(C)')
        print(fallback.encode('ascii', 'ignore').decode('ascii'), flush=True)


def invalidate_sync_cache() -> None:
    """Drop cached /api/sync prefix. Must be called while holding data_lock."""
    global _sync_cache_prefix
    _sync_cache_prefix = None


def schedule_save() -> None:
    """Debounced disk write — coalesces bursts within SAVE_DEBOUNCE_SECONDS."""
    global _save_timer
    with _save_timer_lock:
        if _save_timer is not None:
            _save_timer.cancel()
        _save_timer = threading.Timer(SAVE_DEBOUNCE_SECONDS, save_data_to_disk)
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


def get_local_ip() -> str:
    """Return the machine's outward-facing LAN IP."""
    # Py3 sockets support the context manager protocol — no try/finally needed.
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


_local_ips_cache: set | None = None


def _local_ips() -> set:
    """All IPs bound to this machine — loopback + hostname-resolved + LAN. Cached."""
    global _local_ips_cache
    if _local_ips_cache is None:
        ips: set = {'127.0.0.1', '::1'}
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None):
                ips.add(info[4][0])
        except Exception:
            pass
        with contextlib.suppress(Exception):
            ips.add(get_local_ip())
        _local_ips_cache = ips
    return _local_ips_cache


def _is_localhost(ip: str) -> bool:
    """True for any IP bound to this machine — loopback or LAN."""
    if ip.startswith('127.'):
        return True
    return ip in _local_ips()


def _check_access_code(headers, view_only: bool, client_ip: str) -> bool:
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
    # Constant-time compare to avoid timing-leak guesses.
    return secrets.compare_digest(submitted, _access_code)


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


# --- Schema validation: per-endpoint validators run before handlers. ---
# Limits sized for real reports while rejecting obvious abuse.
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
_FORMAT_LINE_TYPES = {'id', 'size', 'activity', 'location', 'time', 'analysis', 'custom'}

# ISO 8601 with optional fractional seconds, optional Z (tolerates hand-edited legacy backups).
_ISO_TIME_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$')
# Three- or six-digit hex colors — matches the swatch values the UI emits.
_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$')


def _is_str(v, max_len: int | None = None) -> bool:
    if not isinstance(v, str):
        return False
    return max_len is None or len(v) <= max_len


def _is_int(v) -> bool:
    # Exclude bools — isinstance(True, int) is True in Python.
    return isinstance(v, int) and not isinstance(v, bool)


def _validate_user(u, prefix: str) -> str | None:
    """Optional user object. None → ok; bad shape → error string."""
    if u is None:
        return None
    if not isinstance(u, dict):
        return f'{prefix} must be an object'
    if 'initials' in u and not _is_str(u['initials'], MAX_INITIALS_LEN):
        return f'{prefix}.initials must be a string ≤{MAX_INITIALS_LEN} chars'
    if 'color' in u:
        c = u['color']
        if not isinstance(c, str) or not _COLOR_RE.match(c):
            return f'{prefix}.color must be a hex color (e.g. #0a84ff)'
    return None


def _validate_report_fields(r: dict, prefix: str) -> str | None:
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
    return _validate_user(r.get('user'), f'{prefix}.user')


def _validate_report(r, idx: int) -> str | None:
    if not isinstance(r, dict):
        return f'reports[{idx}] must be an object'
    # At least one identity field; merge path uses either.
    has_id = _is_str(r.get('id'), MAX_ID_LEN) and r.get('id')
    has_did = _is_str(r.get('displayId'), MAX_ID_LEN) and r.get('displayId')
    if not has_id and not has_did:
        return f'reports[{idx}] missing id or displayId'
    if err := _validate_report_fields(r, f'reports[{idx}]'):
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
            if err := _validate_report_fields(entry, f'reports[{idx}].history[{j}]'):
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
            if err := _validate_user(entry.get('user'), f'reports[{idx}].bda[{j}].user'):
                return err
    return None


def _v_save_reports(data: dict) -> str | None:
    ato = data.get('ato')
    if not _is_str(ato, MAX_ATO_LEN) or not ato:
        return f'ato must be a non-empty string ≤{MAX_ATO_LEN} chars'
    reps = data.get('reports')
    if not isinstance(reps, list):
        return 'reports must be a list'
    if len(reps) > MAX_REPORTS_BATCH:
        return f'reports list has too many entries (max {MAX_REPORTS_BATCH})'
    for i, r in enumerate(reps):
        if err := _validate_report(r, i):
            return err
    if (
        'source' in data
        and data['source'] is not None
        and not _is_str(data['source'], MAX_SOURCE_LEN)
    ):
        return f'source must be a string ≤{MAX_SOURCE_LEN} chars'
    return None


def _v_unload_ato(data: dict) -> str | None:
    ato = data.get('ato')
    if not _is_str(ato, MAX_ATO_LEN) or not ato:
        return f'ato must be a non-empty string ≤{MAX_ATO_LEN} chars'
    return None


def _v_edit_report(data: dict) -> str | None:
    ato = data.get('ato')
    if not _is_str(ato, MAX_ATO_LEN) or not ato:
        return f'ato must be a non-empty string ≤{MAX_ATO_LEN} chars'
    rid = data.get('reportId')
    if not _is_str(rid, MAX_ID_LEN) or not rid:
        return 'reportId must be a non-empty string'
    fields = data.get('fields')
    if not isinstance(fields, dict):
        return 'fields must be an object'
    # Edit fields share the report shape (it's the same data model).
    return _validate_report_fields(fields, 'fields')


def _v_delete_history(data: dict) -> str | None:
    ato = data.get('ato')
    if not _is_str(ato, MAX_ATO_LEN) or not ato:
        return f'ato must be a non-empty string ≤{MAX_ATO_LEN} chars'
    deletions = data.get('deletions')
    if not isinstance(deletions, list):
        return 'deletions must be a list'
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
    if not _is_str(p.get('initials'), MAX_INITIALS_LEN) or not p.get('initials'):
        return f'profile.initials must be a non-empty string ≤{MAX_INITIALS_LEN} chars'
    if 'color' in p:
        c = p['color']
        if not isinstance(c, str) or not _COLOR_RE.match(c):
            return 'profile.color must be a hex color (e.g. #0a84ff)'
    return None


def _v_save_format(data: dict) -> str | None:
    ato = data.get('ato')
    if not _is_str(ato, MAX_ATO_LEN) or not ato:
        return f'ato must be a non-empty string ≤{MAX_ATO_LEN} chars'
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


# Path -> validator. Add an entry when adding a new POST route.
_VALIDATORS = {
    '/api/save_reports': _v_save_reports,
    '/api/unload_ato': _v_unload_ato,
    '/api/edit_report': _v_edit_report,
    '/api/delete_history': _v_delete_history,
    '/api/save_config': _v_save_config,
    '/api/save_profile': _v_save_profile,
    '/api/save_format': _v_save_format,
}


# --- Rate limiting (token bucket per IP): 1 token/POST; GETs unlimited; 429 when empty. ---
RATE_BUCKET_CAPACITY = 60
RATE_REFILL_PER_SECOND = 5.0
RATE_BUCKET_PRUNE_AFTER = 600.0  # drop buckets inactive longer than this

_rate_buckets: dict = {}  # ip -> (tokens: float, last_seen: float)
_rate_lock = threading.Lock()


def rate_limit_check(ip: str) -> bool:
    """Token-bucket consume; True allowed, False rate-limited. Lazy refill on access."""
    now = time.time()
    with _rate_lock:
        # Lazy prune fires only on first contact for a new IP — keeps dict bounded without a thread.
        if ip not in _rate_buckets:
            cutoff = now - RATE_BUCKET_PRUNE_AFTER
            stale = [k for k, (_, t) in _rate_buckets.items() if t < cutoff]
            for k in stale:
                del _rate_buckets[k]
        tokens, last = _rate_buckets.get(ip, (float(RATE_BUCKET_CAPACITY), now))
        # Refill based on elapsed; cap at capacity.
        elapsed = max(0.0, now - last)
        tokens = min(float(RATE_BUCKET_CAPACITY), tokens + elapsed * RATE_REFILL_PER_SECOND)
        if tokens < 1.0:
            _rate_buckets[ip] = (tokens, now)
            return False
        _rate_buckets[ip] = (tokens - 1.0, now)
        return True


# =============================================================================
# Backup parsing & merging
# =============================================================================


def _extract_json_from_file(raw_text: str) -> dict | None:
    """DATA_STORE dict from a backup file; handles legacy single-ATO format. None on failure."""
    s = raw_text.find(BACKUP_START)
    e = raw_text.find(BACKUP_END)

    if s != -1 and e != -1:
        json_text = raw_text[s + len(BACKUP_START) : e].strip()
        try:
            d = json.loads(json_text)
            if 'workspaces' in d:
                return {
                    'workspaces': d.get('workspaces', {}),
                    'config': d.get('config', {'ato': '', 'title': ''}),
                    'profiles': d.get('profiles', {}),
                    'formats': d.get('formats', {}),
                }
            # Legacy marker format: single ATO inferred from config
            ato = d.get('config', {}).get('ato', '')
            reps = d.get('reports', [])
            return {
                'workspaces': {ato: reps} if ato and reps else {},
                'config': d.get('config', {'ato': '', 'title': ''}),
                'profiles': d.get('profiles', {}),
                'formats': {},
            }
        except (ValueError, KeyError):
            return None

    # No marker block — not a recognised backup.
    return None


def _merge_reports(existing_list: list, incoming_list: list) -> list:
    """Merge by id (or legacy displayId); higher lastModified wins."""
    by_id: dict = {}
    for r in existing_list:
        if key := r.get('id') or r.get('displayId'):
            by_id[key] = r
    for r in incoming_list:
        if not (key := r.get('id') or r.get('displayId')):
            continue
        existing = by_id.get(key)
        if existing is None or r.get('lastModified', 0) >= existing.get('lastModified', 0):
            by_id[key] = r
    return list(by_id.values())


# =============================================================================
# Disk I/O
# =============================================================================


def load_data_from_disk() -> None:
    """Read mtime-sorted .txt backups from BACKUP_DIR into DATA_STORE + workspace_sources."""
    global DATA_STORE

    with data_lock:
        os.makedirs(BACKUP_DIR, exist_ok=True)

        candidates = sorted(
            [os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR) if f.endswith('.txt')],
            key=os.path.getmtime,
        )

        if not candidates:
            return

        all_workspaces: dict = {}
        merged_profiles: dict = {}
        # Newest mtime wins — matches the runtime invariant that the most recent ATO/Title is active.
        latest_config = {'ato': '', 'title': ''}
        source_by_ato: dict = {}
        merged_formats: dict = {}

        for filepath in candidates:
            try:
                with open(filepath, encoding='utf-8') as f:
                    raw = f.read()
                if (result := _extract_json_from_file(raw)) is not None:
                    fname = os.path.basename(filepath)
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
                    merged_profiles.update(result.get('profiles', {}))
                    merged_formats.update(
                        {
                            (k or '').strip().upper(): v
                            for k, v in (result.get('formats') or {}).items()
                        }
                    )
                    latest_config = result.get('config', latest_config)
            except Exception:
                # Skip unreadable / malformed files silently.
                continue

        if all_workspaces:
            DATA_STORE['workspaces'] = all_workspaces
            DATA_STORE['profiles'] = merged_profiles
            DATA_STORE['config'] = latest_config
            DATA_STORE['formats'] = merged_formats
            workspace_sources.clear()
            workspace_sources.update(source_by_ato)
            invalidate_sync_cache()


def render_backup(
    workspaces: dict, config: dict, profiles: dict, formats: dict
) -> tuple[str, str] | None:
    """Return ``(filename, text)`` for a backup of the given state, or None if empty.

    Pure: no I/O, no globals. The text is a human-readable report summary
    followed by a machine-readable JSON block that ``_extract_json_from_file``
    reads back on the next boot.
    """
    # Nothing loaded — don't emit an empty placeholder file.
    if not workspaces:
        return None

    # Unloading the active workspace clears config; fall back to a real
    # workspace name so we never create a stray "ATO_SALT.txt".
    ato = config.get('ato', '').strip()
    title = config.get('title', '').strip()
    if not ato:
        ato = sorted(workspaces)[0]
        if not title:
            first = next((r for r in workspaces.get(ato, []) if r.get('title')), None)
            title = first.get('title') if first else 'SALT'
    title = title or 'SALT'

    def _safe(s: str) -> str:
        return ''.join(c if c.isalnum() or c in '-_' else '_' for c in s).strip('_')

    filename = f'{_safe(ato)}_{_safe(title)}.txt'

    div = '=' * 72
    sub = '-' * 72
    # Timezone-aware UTC (utcnow() deprecated in Py3.12).
    now = datetime.now(timezone.utc)
    ts = f'{now:%Y-%m-%d} · {now:%H%MZ}'

    def fmt_time(iso) -> str:
        if not iso:
            return '—'
        try:
            # Strip fractional seconds; ISO stored with literal Z suffix.
            dt = datetime.strptime(iso.split('.')[0], '%Y-%m-%dT%H:%M:%S')
            return f'{dt:%Y-%m-%d %H%MZ}'
        except (ValueError, AttributeError):
            return iso

    lines = [
        div,
        ' S.A.L.T. REPORT WORKBENCH — AUTO BACKUP (SESSION)',
        f' ATO Designator : {ato}',
        f' Report Title   : {title}',
        f' Total Reports  : {sum(len(v) for v in workspaces.values())}',
        f' Exported       : {ts}',
        div,
        '',
    ]

    for ws_ato, reports in workspaces.items():
        for report in sorted(reports, key=lambda r: r.get('displayId', '')):
            flag = ' [UPDATED]' if report.get('updated') else ''
            lines += [
                sub,
                f' REPORT {report.get("displayId", "")}{flag}',
                sub,
                f' ATO      : {ws_ato}',
                f' Size     : {report.get("size", "—")}',
                f' Activity : {report.get("activity", "—")}',
                f' Location : {report.get("location", "—")}',
                f' Time     : {fmt_time(report.get("time"))}',
            ]
            if report.get('yourAnalysis'):
                lines.append(f' Analysis : {report["yourAnalysis"]}')
            for ck, cv in (report.get('custom') or {}).items():
                lines.append(f' {ck} : {cv}')
            if (report.get('user') or {}).get('initials'):
                lines.append(f' By       : {report["user"]["initials"]}')
            for bi, b in enumerate(report.get('bda') or []):
                coords = f' @ {b.get("coords")}' if b.get('coords') else ''
                note = f' - {b.get("note")}' if b.get('note') else ''
                lines.append(
                    f'   BDA {bi + 1}  : {b.get("effect", "Unknown")} - {b.get("target", "")}{coords}{note}'
                )

            for i, h in enumerate(
                sorted(report.get('history', []), key=lambda x: x.get('lastModified', 0))
            ):
                lines += [
                    '',
                    f'   ↳ Previous Entry {i + 1}',
                    f'      Size     : {h.get("size", "—")}',
                    f'      Activity : {h.get("activity", "—")}',
                    f'      Location : {h.get("location", "—")}',
                    f'      Time     : {fmt_time(h.get("time"))}',
                ]
                if h.get('yourAnalysis'):
                    lines.append(f'      Analysis : {h["yourAnalysis"]}')
            lines.append('')

    machine_json = json.dumps(
        {'workspaces': workspaces, 'config': config, 'profiles': profiles, 'formats': formats},
        separators=(',', ':'),
        ensure_ascii=False,
    )
    lines += [
        div,
        ' MACHINE DATA — DO NOT EDIT BELOW THIS LINE',
        div,
        BACKUP_START,
        machine_json,
        BACKUP_END,
        '',
    ]

    return filename, '\n'.join(lines)


# Serializes writers so a slower, older snapshot can never land on disk after a
# newer one. Separate from data_lock so disk I/O never blocks request handlers.
_disk_lock = threading.Lock()


def save_data_to_disk() -> None:
    """Persist DATA_STORE atomically to ``{ATO}_{Title}.txt``.

    The backup text is rendered while holding ``data_lock`` (a consistent,
    CPU-only snapshot), then written after releasing it. Holding the lock
    across the write used to stall every sync and POST for the duration of
    the disk I/O, which is noticeable on the USB sticks and network shares
    this often runs from.
    """
    with _disk_lock:
        with data_lock:
            rendered = render_backup(
                DATA_STORE.get('workspaces', {}),
                DATA_STORE.get('config', {}),
                DATA_STORE.get('profiles', {}),
                DATA_STORE.get('formats', {}),
            )
        if rendered is None:
            return
        filename, content = rendered
        os.makedirs(BACKUP_DIR, exist_ok=True)
        dest = os.path.join(BACKUP_DIR, filename)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=BACKUP_DIR, suffix='.tmp')
        try:
            with open(tmp_fd, 'w', encoding='utf-8') as tmp_f:
                tmp_f.write(content)
            os.replace(tmp_path, dest)  # atomic: readers never see a partial file
        except Exception as exc:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
            safe_print(f'[!] Error saving to disk: {exc}')


# =============================================================================
# HTTP request handler
# =============================================================================


class SaltSyncHandler(server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        return  # suppress per-request console noise

    def _send_json(self, data, status: int = 200) -> None:
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(body)

    # -------------------------------------------------------------------------
    # GET
    # -------------------------------------------------------------------------

    def do_GET(self):
        # Strip query string so cache-bust params don't 404.
        path = self.path.split('?', 1)[0]
        if path == '/api/sync':
            if self._authorized():
                self._handle_sync()
        elif path == '/api/events':
            if self._authorized():
                self._handle_sse()
        elif path in (
            '/',
            '/index.html',
            '/Salt%20Report%20Workbench.html',
        ):  # last: legacy bookmark
            # HTML serve is unauthenticated; startup modal gates data endpoints.
            self._serve_workbench()
        else:
            self.send_error(404)

    def _authorized(self) -> bool:
        """Editor-port code check; sends 401 + False if denied. Viewer/localhost always pass."""
        view_only = getattr(self.server, 'view_only', False)
        if _check_access_code(self.headers, view_only, self.client_address[0]):
            return True
        self._send_json(
            {
                'status': 'error',
                'message': 'Access denied. Enter the access code from the server console.',
            },
            401,
        )
        return False

    def _handle_sync(self) -> None:
        """Full sync payload. Cached prefix + dynamic tail (connected counts).
        Operator IPs tracked server-side for attribution; never sent to peers."""
        global _sync_cache_prefix
        with data_lock:
            if _sync_cache_prefix is None:
                data = {
                    'workspaces': DATA_STORE['workspaces'],
                    'config': DATA_STORE['config'],
                    'profiles': DATA_STORE['profiles'],
                    'formats': DATA_STORE.get('formats', {}),
                    'sources': workspace_sources,
                }
                full = json.dumps(data, separators=(',', ':'))
                _sync_cache_prefix = full[:-1].encode('utf-8')
            prefix = _sync_cache_prefix
        # Dynamic tail: connected count + deduped initials (no IPs).
        with sse_lock:
            # Unique users, not tabs — multiple tabs from one machine share an IP
            # and would otherwise inflate the count.
            connected = len({c.ip for c in sse_clients})
            seen: set = set()
            initials_list: list = []
            for c in sse_clients:
                ini = client_initials.get(c.ip, '')
                if ini and ini not in seen:
                    seen.add(ini)
                    initials_list.append(ini)
        initials_json = json.dumps(initials_list, ensure_ascii=False).encode('utf-8')
        # `read_only` is per-listener — lives in the dynamic tail, not the shared prefix.
        ro = b'true' if getattr(self.server, 'view_only', False) else b'false'
        body = (
            prefix
            + b',"connected_users":'
            + str(connected).encode('ascii')
            + b',"connected_initials":'
            + initials_json
            + b',"read_only":'
            + ro
            + b'}'
        )
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(body)

    def _handle_sse(self):
        """SSE stream. `select` wakes on 15s heartbeat or client disconnect (instant prune on refresh)."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()

        client = SSEClient(self.wfile, self.client_address[0])
        with sse_lock:
            sse_clients.append(client)

        client.send(b'data: update\n\n')  # bootstrap the connecting client

        sock = self.request  # underlying TCP socket
        try:
            while True:
                ready, _, _ = select.select([sock], [], [], 15)
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
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        # No-cache so rebuilds propagate without manual cache-clearing.
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # -------------------------------------------------------------------------
    # POST
    # -------------------------------------------------------------------------

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        # Viewer port rejects every mutation up front.
        if getattr(self.server, 'view_only', False):
            self._send_json({'status': 'error', 'message': 'This server is read-only.'}, 405)
            return
        # Rate-limit before auth/body so wrong-code floods are throttled too.
        if not rate_limit_check(self.client_address[0]):
            self._send_json(
                {'status': 'error', 'message': 'Rate limit exceeded. Retry shortly.'}, 429
            )
            return
        if not self._authorized():
            return
        # Parse Content-Length first so a bad header reports as 400, not "Invalid JSON".
        raw_len = self.headers.get('Content-Length', '0')
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            self._send_json({'status': 'error', 'message': 'Invalid Content-Length header.'}, 400)
            return
        if length > MAX_BODY_BYTES:
            self._send_json({'status': 'error', 'message': 'Payload too large.'}, 413)
            return
        try:
            # json.loads accepts bytes directly (Py3.6+).
            data = json.loads(self.rfile.read(length))
        except (ValueError, KeyError):
            self._send_json({'status': 'error', 'message': 'Invalid JSON.'}, 400)
            return
        if not isinstance(data, dict):
            self._send_json({'status': 'error', 'message': 'Body must be a JSON object.'}, 400)
            return
        # Schema check — bad shape never reaches DATA_STORE.
        validator = _VALIDATORS.get(path)
        if validator is not None and (err := validator(data)):
            self._send_json({'status': 'error', 'message': f'Validation failed: {err}'}, 400)
            return

        handled = False

        if path == '/api/save_reports':
            ato = (data.get('ato') or '').strip().upper()
            incoming = data.get('reports', [])
            source = (data.get('source') or '').strip().lower()
            if ato:
                with data_lock:
                    is_new = ato not in DATA_STORE['workspaces']
                    existing = DATA_STORE['workspaces'].get(ato, [])
                    DATA_STORE['workspaces'][ato] = _merge_reports(existing, incoming)
                    # Provenance label; routine edits don't touch source.
                    if source == 'backup':
                        workspace_sources[ato] = 'Uploaded backup (.txt)'
                    elif source == 'csv':
                        workspace_sources[ato] = 'Uploaded CSV (.csv)'
                    elif is_new:
                        workspace_sources[ato] = 'In-session'
                    invalidate_sync_cache()
                # Capture initials from any report in the batch for IP attribution.
                client_ip = self.client_address[0]
                for r in incoming:
                    ini = ((r.get('user') or {}).get('initials') or '').strip()
                    if ini:
                        with sse_lock:
                            client_initials[client_ip] = ini
                        break
                # Console bulk-import notification (browser shows full state).
                if source in ('backup', 'csv'):
                    label = 'Backup (.txt)' if source == 'backup' else 'CSV (.csv)'
                    safe_print('\n' + '─' * 64)
                    safe_print(
                        f" [+] Loaded {label}: {len(incoming)} report(s) merged into ATO '{ato}'."
                    )
                    safe_print('─' * 64)
                handled = True

        elif path == '/api/unload_ato':
            ato = (data.get('ato') or '').strip().upper()
            if not ato:
                self._send_json({'status': 'error', 'message': 'Missing ATO.'}, 400)
                return
            with data_lock:
                DATA_STORE['workspaces'].pop(ato, None)
                DATA_STORE.get('formats', {}).pop(ato, None)
                workspace_sources.pop(ato, None)
                cfg = DATA_STORE.get('config') or {}
                if (cfg.get('ato') or '').strip().upper() == ato:
                    DATA_STORE['config'] = {}
                invalidate_sync_cache()
            # Persist the removal — without this the unload lived only in
            # memory and the workspace came back on the next server restart.
            schedule_save()
            broadcast_update()
            self._send_json({'status': 'success', 'message': 'ATO unloaded.'})
            return

        elif path == '/api/edit_report':
            ato = (data.get('ato') or '').strip().upper()
            report_id = data.get('reportId')
            fields = data.get('fields') or {}
            if not ato or not report_id or not fields:
                self._send_json(
                    {'status': 'error', 'message': 'Missing ato, reportId, or fields.'}, 400
                )
                return
            # Server-stamped attribution: override client `user` with our IP->initials->profile lookup.
            # Falls back to client claim for brand-new IPs.
            client_ip = self.client_address[0]
            with sse_lock:
                known_initials = client_initials.get(client_ip, '')
            if known_initials:
                with data_lock:
                    known_profile = DATA_STORE['profiles'].get(known_initials)
                if known_profile:
                    fields['user'] = known_profile
            ALLOWED = (
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
            updated_count = 0
            with data_lock:
                reps = DATA_STORE['workspaces'].get(ato, [])
                for r in reps:
                    if r.get('id') != report_id:
                        continue
                    for k in ALLOWED:
                        if k in fields:
                            r[k] = fields[k]
                    if 'lastModified' not in fields:
                        r['lastModified'] = int(time.time() * 1000)
                    updated_count += 1
                    break
                if updated_count > 0:
                    invalidate_sync_cache()
            if updated_count == 0:
                self._send_json({'status': 'error', 'message': 'Report not found.'}, 404)
                return
            schedule_save()
            broadcast_update()
            self._send_json({'status': 'success'})
            return

        elif path == '/api/delete_history':
            ato = (data.get('ato') or '').strip().upper()
            deletions = data.get('deletions', [])
            if not ato or not deletions:
                self._send_json({'status': 'error', 'message': 'Missing ato or deletions.'}, 400)
                return
            drop: dict = {}
            for d in deletions:
                rid = d.get('reportId')
                lm = d.get('lastModified')
                if rid is None or lm is None:
                    continue
                drop.setdefault(rid, set()).add(lm)
            removed = 0
            now_ms = int(time.time() * 1000)
            with data_lock:
                reps = DATA_STORE['workspaces'].get(ato, [])
                for r in reps:
                    if not (lms := drop.get(r.get('id'))):
                        continue
                    hist = r.get('history') or []
                    kept = [h for h in hist if h.get('lastModified') not in lms]
                    if len(kept) != len(hist):
                        removed += len(hist) - len(kept)
                        r['history'] = kept
                        r['lastModified'] = now_ms
                if removed > 0:
                    invalidate_sync_cache()
            schedule_save()
            broadcast_update()
            self._send_json({'status': 'success', 'removed': removed})
            return

        elif path == '/api/save_config':
            cfg = data.get('config')
            if cfg:
                # Keep only the fields the app uses: config is re-broadcast to
                # every client on every sync, so arbitrary extra keys would
                # bloat everyone's payload and the backup file.
                clean = {'ato': cfg.get('ato', ''), 'title': cfg.get('title', '')}
                with data_lock:
                    DATA_STORE['config'] = clean
                    invalidate_sync_cache()
            handled = True

        elif path == '/api/save_format':
            ato = (data.get('ato') or '').strip().upper()
            fmt = data.get('format')
            if ato and isinstance(fmt, dict):
                with data_lock:
                    DATA_STORE.setdefault('formats', {})[ato] = fmt
                    invalidate_sync_cache()
                handled = True
            else:
                self._send_json({'status': 'error', 'message': 'Missing ato or format.'}, 400)
                return

        elif path == '/api/save_profile':
            profile = data.get('profile')
            ini = ((profile or {}).get('initials') or '').strip()
            if ini:
                # Known fields only (see save_config), keyed by the same stripped
                # initials the IP map uses, so server-stamped attribution matches.
                clean = {'initials': ini, 'color': profile.get('color', '#0a84ff')}
                with data_lock:
                    DATA_STORE['profiles'][ini] = clean
                    invalidate_sync_cache()
                # IP -> initials so /api/sync includes them and /api/edit_report can server-stamp.
                with sse_lock:
                    client_initials[self.client_address[0]] = ini
                handled = True
            else:
                self._send_json({'status': 'error', 'message': 'Invalid profile data.'}, 400)
                return

        if handled:
            schedule_save()
            broadcast_update()
            self._send_json({'status': 'success'})
        else:
            self._send_json({'status': 'error', 'message': 'Not Found'}, 404)


# =============================================================================
# Server
# =============================================================================


class SaltSyncServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True  # SSE threads die with main on Ctrl+C

    def __init__(self, *args, view_only: bool = False, **kwargs):
        # Per-listener mode flag; handler checks via self.server.view_only.
        self.view_only = view_only
        super().__init__(*args, **kwargs)

    def handle_error(self, request, client_address):
        """Suppress SSE socket-teardown tracebacks (normal, not actionable)."""
        return


# =============================================================================
# Boot
# =============================================================================


def run_boot_dashboard(viewer_port: int | None = None) -> None:
    """Boot banner — title, network URL, access code, optional viewer URL."""
    ip = get_local_ip()
    safe_print('\n' + '═' * 64)
    safe_print('                   S.A.L.T. Sync Server ™')
    safe_print('═' * 64)
    safe_print(' [*] Starting S.A.L.T. Sync Server...')
    safe_print(f' [+] Workbench : http://{ip}:{PORT}')
    if _access_code is None:
        safe_print(' [!] Access Code : UNGATED  (no code — anyone can edit)')
    else:
        safe_print(f' [+] Access Code : {_access_code}')
    if viewer_port is not None:
        safe_print(f' [+] Read Only : http://{ip}:{viewer_port}')
    safe_print(' [!] Press Ctrl+C to stop.')
    safe_print('═' * 64 + '\n')


def parse_cli_args() -> argparse.Namespace:
    """CLI knobs for port, bind, backup dir, auto-launch, access code."""
    p = argparse.ArgumentParser(
        prog='salt_sync_server',
        description='S.A.L.T. Report Workbench sync server.',
    )
    p.add_argument(
        '--port', type=int, default=PORT, help=f'HTTP port to listen on (default: {PORT}).'
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
    return p.parse_args()


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
        safe_print(' [+] Pending changes flushed to disk.')
    except Exception as exc:
        safe_print(f' [!] Error flushing on shutdown: {exc}')


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

    load_data_from_disk()

    httpd = SaltSyncServer((HOST, PORT), SaltSyncHandler)

    # Optional viewer listener — same DATA_STORE; view_only=True returns 405 on POST. SSE spans both.
    # Created before the boot dashboard so it can report the actually-bound port.
    viewer_httpd: SaltSyncServer | None = None
    viewer_port_bound: int | None = None
    requested_vp = args.viewer_port
    if requested_vp and requested_vp != PORT:
        try:
            viewer_httpd = SaltSyncServer((HOST, requested_vp), SaltSyncHandler, view_only=True)
            threading.Thread(target=viewer_httpd.serve_forever, daemon=True).start()
            viewer_port_bound = requested_vp
        except OSError as exc:
            safe_print(f' [!] Could not start viewer on port {requested_vp}: {exc}')
    elif requested_vp == PORT:
        safe_print(f' [!] --viewer-port matches --port ({PORT}); ignored.')

    run_boot_dashboard(viewer_port=viewer_port_bound)

    _server_ip = get_local_ip()

    def _launch():
        time.sleep(0.3)  # let the server come up
        if not args.no_browser:
            webbrowser.open(f'http://{_server_ip}:{PORT}')
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
        safe_print('\n [*] Shutting down gracefully...')
    finally:
        graceful_drain()
        httpd.server_close()
        if viewer_httpd is not None:
            try:
                viewer_httpd.shutdown()
                viewer_httpd.server_close()
            except Exception:
                pass

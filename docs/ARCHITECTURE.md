# Architecture

S.A.L.T. Report Workbench is two programs that share a JSON shape: a browser
client that owns the user experience and works on its own, and a small Python
server that makes several clients agree. This document explains how they fit
together and why the design looks the way it does.

## Design constraints

Three constraints drive almost every decision:

1. **No dependencies.** The tool has to run on air-gapped and locked-down
   machines where `pip install` is not an option. The server uses only the
   Python standard library, and the client is plain HTML, CSS, and JavaScript
   with no framework and nothing fetched at runtime.
2. **Offline-first.** A client must remain fully usable when the server is
   unreachable, and reconcile cleanly when it comes back.
3. **One folder to ship.** An operator should be able to copy a folder to a
   laptop and run it.

## Components

```text
            src/index.html + styles.css + app.js
                          │  scripts/build.py (inline CSS + JS)
                          ▼
   dist/index.html ◄──── served by ────► dist/salt_sync_server.py
   (single file)                          │
        ▲  ▲                              ├─ editor port  :8080  (read/write, access code)
        │  │  GET /api/sync, SSE          ├─ viewer port  :8081  (read-only, no code)
        │  └──── POST /api/* ─────────────┤
        │                                 └─ Auto Backups/{ATO}_{Title}.txt
   localStorage (offline cache + queue)
```

### Client (`src/`)

`app.js` holds the whole application state in a handful of module-level
variables, with `reportsByAto` (every workspace's reports) as the core. Every
change is applied locally first and mirrored to `localStorage`, so the UI never
waits on the network. Rendering is one function per surface, such as `renderLog`
and `renderWorkspacesList`, that rebuilds its DOM from state into a
`DocumentFragment` for a single reflow.

When a push fails, the client sets `salt_offline_push` and retries the whole
workspace on the next successful sync. Because merging is idempotent (below),
replaying is always safe.

### Server (`server/salt_sync_server.py`)

A `ThreadingTCPServer` subclass with one `SimpleHTTPRequestHandler`. The same
handler class serves both ports; each listener carries a `view_only` flag that
the handler checks per request.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/`, `/index.html` | GET | The bundled page. On the viewer port it is stamped `read-only` before any script runs; for the host's own browser the access code is injected into a `<meta>` tag. |
| `/api/sync` | GET | Full state: workspaces, config, profiles, formats, sources, connected users. |
| `/api/events` | GET | Server-Sent Events stream. Each message just says "something changed"; clients then call `/api/sync`. |
| `/api/save_reports` | POST | Merge a batch of reports into a workspace. |
| `/api/edit_report` | POST | Overwrite fields of one report in place, without touching its history. |
| `/api/delete_history` | POST | Remove individual history entries. |
| `/api/unload_ato` | POST | Drop a workspace from memory. |
| `/api/save_config` | POST | Set the active ATO and title. |
| `/api/save_profile` | POST | Register an operator's initials and color. |
| `/api/save_format` | POST | Save a workspace's report format (Builder). |

## Sync model

The server is the meeting point, not the authority over content.

- **Notify, then pull.** SSE messages carry no payload. On `data: update`, a
  client fetches `/api/sync`. One message type keeps the protocol trivial, and a
  client that missed events catches up on its next pull.
- **Last-modified wins.** Every report carries `lastModified` (epoch
  milliseconds). `_merge_reports` keys reports by `id` (or `displayId` for rows
  that predate UUIDs) and keeps whichever copy is newer; ties go to the incoming
  copy. Merging the same batch twice is a no-op, which is what makes the
  offline replay safe.
- **Soft deletes.** Deleting marks a report `deleted` rather than removing it,
  so the deletion itself merges and propagates like any other edit.
- **Cached sync payload.** The JSON for workspaces, config, profiles, and
  formats is serialized once and cached as a byte prefix; only the small
  per-request tail (connected users, read-only flag) is appended each time. Any
  mutation clears the cache.

## Persistence

`save_data_to_disk` writes `{ATO}_{Title}.txt` into the backup folder, which
defaults to `Auto Backups/` beside the server. Writes are debounced by 0.5
seconds so a burst of edits becomes one write.

A backup file has two parts: a readable summary of every report for a person
to skim, then a JSON block between `##SALT_BACKUP##` and `##SALT_BACKUP_END##`
that the server parses on boot. On startup, `load_data_from_disk` reads every
`.txt` file in the folder, oldest first, and merges them.

Concurrency is handled in two steps:

1. `render_backup`, a pure function, builds the file text while `data_lock` is
   held, giving a consistent snapshot without any I/O.
2. The text is written to a temporary file and moved into place with
   `os.replace` after the lock is released, so request handlers are never
   blocked on the disk and readers never see a partial file. A separate
   `_disk_lock` keeps writes in order.

> **Known limitation.** Each backup file currently contains every loaded
> workspace, named after whichever one was active. Files duplicate each other,
> and an unloaded workspace reappears on restart from an older file. That
> reload is documented behavior, but the duplication is not ideal; moving to one
> file per workspace is on the roadmap.

## Access control

The editor port is gated by a 10-character code generated at launch from an
alphabet without look-alike characters (no `0/O`, `1/I/l`, `5/S`), so it can be
read aloud over a radio. Clients send it as a cookie; the server compares it in
constant time. Requests from the machine running the server pass automatically,
which is how the host's browser gets in without typing.

The viewer port has no code; its protection is that every POST returns `405`.

Every POST is also rate-limited per IP with a token bucket (60-request burst,
refilling at 5 per second), validated against a hand-written schema for its
endpoint, and capped at 1 MB. Edits are attributed to the operator the server
already associates with that IP, not to whatever identity the client claims.

See [SECURITY.md](../SECURITY.md) for what this model does and does not protect
against.

## Threading

| Lock | Guards |
| --- | --- |
| `data_lock` | `DATA_STORE`, `workspace_sources`, the sync cache |
| `sse_lock` | `sse_clients`, `client_initials` |
| `_disk_lock` | ordering of backup writes |
| `_save_timer_lock` | the debounce timer |
| `_rate_lock` | rate-limit buckets |

Each SSE connection holds a thread that waits in `select()` with a 15-second
timeout: the socket becoming readable means the client left, and a timeout
means it's time to send a heartbeat. Broadcasts copy the client list under
`sse_lock` and write outside it, so one stalled client can't block the others.

## Build

`scripts/build.py` replaces the page's single `<link rel="stylesheet">` and
`<script src>` with inline copies of `styles.css` and `app.js`, writes
`dist/index.html`, and copies the server and the Windows launcher beside it.
The launcher is written with CRLF line endings whatever the checkout used,
because cmd.exe misparses batch files with bare LF endings. The build fails if
either placeholder is missing rather than shipping a broken page. The page's
favicon is an inline data URI for the same reason everything else is inline:
the file has to work with no network at all.

# Running the server

For whoever runs the server during an operation. [INSTALL.md](INSTALL.md)
covers downloading, upgrading and the first start in detail; this page is the
day-to-day: starting, seeing that it's healthy, what the warnings mean, and
getting back an earlier state.

## Start of day

1. Start it: double-click **`Start SALT Workbench.bat`** (Windows), or run
   `python salt_sync_server.py` in its folder.
2. The console shows the version, the address editors open, the **access code**
   (read it out to the editors), the read-only address for viewers, and the
   certificate's fingerprint. Leave the window open: closing it stops the
   server. It minimizes itself.
3. Editors open the address, type the code, their initials and their
   workspace. Viewers open the read-only address; they need nothing.

The access code changes every start unless you start with
`--access-code CODE` (6 to 64 letters, digits, `-` or `_`).

## Is everyone connected

The console lists the connected machines whenever one joins, leaves, changes
initials or changes workspace:

```text
[*] Connected (3): AB at this computer in ALPHA; CD at 10.0.0.12 in BRAVO; no name at 10.0.0.20
```

"no name" is a viewer, or an editor who hasn't finished the welcome screen.
Each editor works in their own workspace; the Workspaces tab in Manage shows
the same thing from the page.

## Is it healthy

Open `/api/health` on either port, from any machine, without the code:
`https://<server>:8080/api/health`. It answers in a line of JSON:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, or `not saving` while the backups can't be written |
| `version` | the server's release |
| `uptime_seconds` | how long it has been running |
| `last_saved` | when the backups were last written (UTC), or `null` before the first change |
| `save_failures` | saves that failed in a row; 0 when all is well |
| `connected_machines` | machines with the page open |

A script or a monitoring tool can poll it; it says nothing about the reports.

## What the warnings mean

**On the server console**

- `[!] Error saving ...` then `Changes are kept in memory and the save is
  retried until it works.`: the backup folder can't be written (a full disk, a
  file held open by antivirus or a sync tool, a pulled USB stick). Nothing is
  lost while the server runs. Fix the cause; `[+] Backups are being saved
  again.` follows. Don't stop the server until it does.
- `[!] Skipped <file>: ...`: a backup file couldn't be read at start. It is
  left as it is, and the rest load.

**In an editor's page**

- A red **Not saving** bar at the top: that page's changes have waited more
  than 30 seconds for the server (it can't be reached, or it refuses them).
  They're kept in that browser and sent when it can reach the server again.
  Check the network, the firewall, and that the server is running.
- **This page is version X and the server is Y**: the page was opened before
  the server was upgraded. Press **Reload**.
- **Not saved** on a report: the server refused that change (it says why on
  hover). Fix it with Edit or Update, or Discard it.
- **Duplicate** on a report: two reports share a number. **Renumber** gives
  one the next free number.

## Backups

Everything lives in `Auto Backups/` beside the server (or `--backup-dir`):

- one `{ATO}_{Title}.txt` per workspace and `Shared settings.json`, rewritten
  within half a second of every change;
- `snapshots/`: dated copies of all of them, on every start and then at most
  once an hour, the newest 48 rounds kept (about two days);
- `audit.log`: every accepted change, who made it and when, in UTC.

Copy the whole `Auto Backups` folder somewhere safe at the end of each day, and
at the end of the operation. It holds your actual reports: handle it according
to your unit's data-handling rules.

## Getting back an earlier state

Each snapshot round is named by its time in UTC, such as `20261028_101500Z`.

1. Stop the server (**Ctrl+C** in its window).
2. See the rounds:

   ```bat
   python salt_sync_server.py --restore list
   ```

3. Put one back (or `--restore latest` for the newest):

   ```bat
   python salt_sync_server.py --restore 20261028_101500Z
   ```

   The backups it replaces are first copied to
   `snapshots/before-restore-<time>/`, which is never pruned, so a restore can
   itself be undone by copying those files back. It refuses while a server is
   running on the port, since the running server would write its own copy back
   over the restore.

4. Start the server as usual. Editors reload their pages.

Workspaces made after that snapshot are gone from the live folder too (they
are in the `before-restore` copy). With the launcher, pass the same flags:
`"Start SALT Workbench.bat" --restore list`.

## Upgrading mid-operation

Stop the server, then follow [Upgrading](INSTALL.md#upgrading): copy
`Auto Backups` into the new folder, or extract the new files over the old ones.
Start it, and have everyone reload: a page still open from before shows the
version bar until they do.

## End of the operation

Stop the server and copy `Auto Backups` to where your unit keeps records. A
backup file can be read in any text editor, and imported into a later
workbench with **Import** in Manage.

See [Troubleshooting](INSTALL.md#troubleshooting) for the firewall prompt, a
port already in use, the certificate warning, and "my reports are gone".

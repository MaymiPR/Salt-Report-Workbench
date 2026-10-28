# Installing and running

The [README](../README.md#quick-start) has the short version. This page covers
the details: the two downloads, checking them, upgrading, the Windows launcher,
and where your data lives.

## The two downloads

Each [release](https://github.com/MaymiPR/SaltReportWorkbench/releases/latest)
offers two downloads holding the same five files: the page, the server, the
Windows launcher, the license, and a short `README.txt`.

- **`SaltReportWorkbench-v<version>.zip`**: extract it. On Windows, double-click
  **`Start SALT Workbench.bat`**; anywhere else, run `python salt_sync_server.py`
  in that folder. Python 3.10+ and a browser are all it needs.
- **`SALT-Workbench-v<version>.txt`**: the same files as one plain-text file, for
  transfer systems that refuse zips or scripts. Run it with Python:

  ```bat
  python "SALT-Workbench-v2.15.0.txt"
  ```

  It unpacks into a `SALT Report Workbench` folder beside itself, checks every
  file against the checksum written inside, and deletes itself (`--keep` keeps
  it). It starts nothing.

### How the one-file download works

The unpacker at the top and each file's SHA-256 can be read in Notepad. The
files follow, compressed with LZMA and written as Base85 text in short lines,
so the `.txt` is about the size of the zip. It is still a program whatever its
extension, and some scanners treat a script carrying an encoded block as
suspicious. If your network blocks scripts on purpose, ask your security office
before sending it this way.

`python scripts/release.py <version>` builds both downloads and their checksum
file into `release/` in one go. `scripts/pack.py` packs an existing zip on its
own, and `scripts/pack.py --plain` writes a larger form where every line of
every file can be read.

## Verify a download

The release also carries `SHA256SUMS.txt`, one file holding the checksums of
both downloads. Builds are reproducible, so the checksums are stable. Put it
beside what you downloaded, then:

- PowerShell:

  ```powershell
  Get-Content SHA256SUMS.txt | ForEach-Object { $h, $f = -split $_; if (-not (Test-Path $f)) { "--   $f (not here)" } elseif ((Get-FileHash $f).Hash -eq $h) { "OK   $f" } else { "BAD  $f" } }
  ```

- macOS or Linux:

  ```bash
  sha256sum -c --ignore-missing SHA256SUMS.txt
  ```

Only the file you downloaded needs to say OK; the other shows as not here.

## Upgrading

Stop the server and drop the new files over the old ones, or run the new `.txt`
from the folder that holds `SALT Report Workbench`. Keep the `Auto Backups`
folder: reports, overlays, and settings load from it as they are. A
`PYTHON_EXE` path set in the launcher survives an upgrade by `.txt`. If you drop
files in by hand, set it again.

Coming from a version that spoke plain HTTP, old `http://` addresses and
bookmarks are sent on to the `https://` address, and each browser warns once
(see below).

## HTTPS and the browser warning

The server encrypts every connection, editor and read-only alike, so nobody
watching the network can read the access code or the reports, or copy the code
to get in. Python can't make a certificate on its own, so on first start the
server makes one, valid for this machine's names and addresses, and keeps it in
`Auto Backups/tls/`. It makes a new one when the old one is about to run out or
the machine's address changes.

**The warning.** No authority vouches for that certificate, so each browser
says the connection isn't private the first time. Choose **Advanced**, then
**Proceed** (Chrome and Edge) or **Accept the Risk and Continue** (Firefox).

**Checking it's really your server.** Someone on the network could put up a
look-alike server, and the browser would show the same warning. To be sure,
click the warning's certificate details (or the padlock afterwards) and compare
the SHA-256 fingerprint with the **Certificate** lines in the server console.

**Your own certificate.** If your unit has a certificate authority, give the
server a certificate it issued for this machine, and browsers that trust that
authority won't warn:

```bash
python salt_sync_server.py --cert server.pem --key server-key.pem
```

**Basemaps on `http://`.** An HTTPS page can't load images from an `http://`
address, so the server fetches those map images for the page. It only fetches
from the hosts of basemaps an editor has added.

**Plain HTTP.** `--no-https` turns encryption off. Use it only where the network
is already encrypted (a VPN, an encrypted radio net) or fully trusted.

## Windows launcher

`Start SALT Workbench.bat` starts the server with a double-click. It needs no
install and no admin rights, and works from a network share. It uses the first
Python 3.10+ it finds, in this order:

1. The path on the `set "PYTHON_EXE="` line near the top of the file. If your
   machine needs a specific `python.exe`, open the launcher in Notepad and put
   the full path between the quotes:

   ```bat
   set "PYTHON_EXE=C:\Tools\Python312\python.exe"
   ```

2. The `SALT_PYTHON` environment variable, which you can set once per user
   without editing the file and without admin rights:

   ```bat
   setx SALT_PYTHON "C:\Tools\Python312\python.exe"
   ```

3. A portable Python in a `python\` folder beside the launcher (for example the
   embeddable package from python.org, unzipped as `python\`).
4. The `py` launcher, then `python` on `PATH`.
5. Standard install folders that were never added to `PATH`.

If you set a path in step 1 or 2 and it doesn't work, the launcher says so and
stops instead of quietly using some other Python. Anything you type after the
launcher's name goes to the server, for example
`"Start SALT Workbench.bat" --port 9090`.

## Building from source

`python scripts/build.py` produces a `dist/` folder containing three files:
`index.html`, `salt_sync_server.py`, and `Start SALT Workbench.bat`. Copy that
folder to any machine with Python and run the server; nothing else is needed.
Every CI run also publishes `dist/` as a downloadable artifact.

## Without a server

Open `index.html` directly in a browser. It runs in **local mode**: reports
live in that browser's storage, there's no access code, and exports work as
usual.

## Data and backups

Every change is written, debounced, to the changed workspace's own file,
`{ATO}_{Title}.txt`, in the backup folder (`Auto Backups/` beside the server,
or `--backup-dir`): a readable summary of each report on top, and a
machine-readable JSON block below that the server reloads on the next start.
Writes are atomic, so a crash never leaves a half-written file. Unloading a
workspace leaves its file in place, so a restart brings it back. (Before 2.4
one file held every loaded workspace; such files still load, and the first save
after upgrading gives each workspace its own file.)

Because that file is replaced within half a second of every change, the server
also keeps dated copies in `Auto Backups/snapshots/`: one on every start and
then at most one an hour, the newest 48 kept. To go back to an earlier state,
stop the server, copy the snapshot you want over the live file, and start it
again. The snapshots folder itself is never loaded.

`Auto Backups/audit.log` records every accepted write as one line: when, who
(the operator's initials and address), and what, such as
`save_reports ALPHA: 1 report(s)` or `delete_history ALPHA: 2 entries`, plus
server starts and stops. It answers "who changed this, and when" after the
fact; nothing reads it.

> [!IMPORTANT]
> Backups contain your actual reports. `Auto Backups/` is git-ignored; keep it
> that way, and handle the folder according to your unit's data-handling rules.

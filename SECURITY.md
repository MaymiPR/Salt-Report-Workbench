# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately with GitHub's
[private vulnerability reporting](https://github.com/MaymiPR/SaltReportWorkbench/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**). Only the
maintainer, [@MaymiPR](https://github.com/MaymiPR), can see the report. Include
what you found, how to reproduce it, and what an attacker could do with it.

You can expect an acknowledgement within a week. Fixes for confirmed issues are
released as soon as practical and credited to you unless you prefer otherwise.

## Supported versions

Only the latest release on `main` receives fixes.

## What the security model covers

This is a LAN tool. Its protections are designed to keep honest mistakes and
casual misuse on a shared network from corrupting a session, not to stand up to
a determined attacker on that network.

**It does protect against:**

- Reading or replaying traffic: both ports speak HTTPS (TLS 1.2 or newer), so
  someone watching the network can't read the reports or the access code, or
  copy the code to get in. Plain HTTP to either port is sent to `https://`.
- Observers editing data: the viewer port refuses every write.
- Casual access to the editor port: a per-launch access code, compared in
  constant time, from an alphabet built to be read aloud.
- Reading the code over a shoulder: the page shows it as dots until you
  press Show, and hides it again when you leave that screen. Copy copies it
  without showing it. The server console still prints it, since the host
  reads it there.
- Spoofed attribution: edits are stamped with the operator the server already
  associates with the connection, not the identity a client claims.
- Malformed or oversized input: per-endpoint schema validation, a 16 MB body
  cap, and per-IP rate limiting.
- Corrupted backups: atomic writes, so a crash never leaves a partial file.

**It does not protect against:**

- **A look-alike server.** The server's own certificate is self-signed, so
  browsers warn about it, and they would warn the same way about an impostor's.
  Someone who can redirect traffic on the network could stand in the middle
  unless users compare the certificate's fingerprint with the server console,
  or the server uses a certificate from an authority the browsers trust
  (`--cert`, `--key`).
- **Anyone who can reach the viewer port.** It needs no code, so anyone on the
  network who can open it can read every report. Turn it off with
  `--viewer-port 0` if that matters.
- **`--no-https`.** It turns encryption off; the code and every report then
  cross the network readable, and the code can be copied from the traffic.
- **Access to the host.** Backups in `Auto Backups/` are plain text, and
  `Auto Backups/tls/` holds the server's private key. Protect the machine and
  the folder according to your data-handling rules.
- **Sensitive data in the browser.** Editors' browsers keep a copy of the
  reports in browser storage for offline use, and any summary text they edited
  (Summary Reports, Edit text). Viewers keep no reports. Clear browser data on
  shared machines.
- **The server reaching other addresses for editors.** `/api/wms_fetch` (editor
  port only) makes the server GET any http or https address an editor's page
  sends and return the text, up to 5 MB, so a WMS that doesn't allow a web page
  to read it can still be added. Anyone with the access code can use it to see
  what the server's machine can reach that their own can't, such as addresses
  on another network the host is connected to. Each use is written to the audit
  log. Run the server on a machine whose network position you're comfortable
  sharing with your editors. `/api/basemap`, which fetches map images for an
  HTTPS page from `http://` basemaps, only fetches from the hosts of basemaps
  an editor has saved, follows no redirects, and returns only images.

`--no-access-code` removes the editor gate entirely and is meant only for a
fully trusted, isolated network.

## Handling data

`Auto Backups/` and other runtime data are git-ignored, and the pre-commit
configuration includes a private-key detector. Never commit real reports, and
treat exported backups and CSVs with the same care as the reports themselves.
The folder also holds `audit.log`, which names operators by initials and LAN
address, and `snapshots/`, dated copies of the backup; both stay with the host.

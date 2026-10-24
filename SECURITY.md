# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately to the maintainer, [@MaymiPR](https://github.com/MaymiPR),
through a [draft security advisory](https://github.com/MaymiPR/SaltReportWorkbench/security/advisories/new)
or a direct message on GitHub. Include what you found, how to reproduce it, and
what an attacker could do with it.

You can expect an acknowledgement within a week. Fixes for confirmed issues are
released as soon as practical and credited to you unless you prefer otherwise.

## Supported versions

Only the latest release on `main` receives fixes.

## What the security model covers

This is a LAN tool. Its protections are designed to keep honest mistakes and
casual misuse on a shared network from corrupting a session, not to stand up to
a determined attacker on that network.

**It does protect against:**

- Observers editing data: the viewer port refuses every write.
- Casual access to the editor port: a per-launch access code, compared in
  constant time, from an alphabet built to be read aloud.
- Spoofed attribution: edits are stamped with the operator the server already
  associates with the connection, not the identity a client claims.
- Malformed or oversized input: per-endpoint schema validation, a 1 MB body
  cap, and per-IP rate limiting.
- Corrupted backups: atomic writes, so a crash never leaves a partial file.

**It does not protect against:**

- **Eavesdropping.** The server speaks plain HTTP. The access code and every
  report cross the network unencrypted. Run it only on a network you trust, or
  behind a VPN or other encrypted transport.
- **A hostile machine on the LAN.** Anyone who can watch the traffic can read
  the access code, and the code is the only credential.
- **Access to the host.** Backups in `Auto Backups/` are plain text. Protect the
  machine and the folder according to your data-handling rules.
- **Sensitive data in the browser.** Clients keep a copy of the reports in
  browser storage for offline use. Clear it on shared machines.

`--no-access-code` removes the editor gate entirely and is meant only for a
fully trusted, isolated network.

## Handling data

`Auto Backups/` and other runtime data are git-ignored, and the pre-commit
configuration includes a private-key detector. Never commit real reports, and
treat exported backups and CSVs with the same care as the reports themselves.

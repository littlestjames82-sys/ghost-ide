# Pair mode: trust model

Pair mode lets two of your devices work on one GhostIDE workspace:
one device runs the server (the host), the other opens the same
server in its IDE (the guest). Presence, guarded saves, and
`.conflict-` files handle the editing side; this document covers
who is allowed to talk to the host at all.

## The rule (v2.11.0+, hardening plan item 12)

- The host generates a fresh 6-digit pairing code at every server
  start. It is shown in the host's pair panel and, on desktop, in
  the server console at boot.
- Every `/api` request from a non-loopback address must carry a
  pair token (`X-Pair-Token` header). A guest gets one by posting
  the code once to `/api/pair/join`; the IDE prompts for the code
  automatically the first time the host asks, and stores the token
  per host on that device.
- The code itself is only ever served to loopback requests
  (`GET /api/pair/code`); a network caller cannot read it, with or
  without a token.
- Loopback (the host's own UI) needs no code or token: same-device
  access is the trust boundary, the same one the local server has
  always used.
- Static IDE files (the web app itself) are served openly on the
  LAN so a guest can load the UI and reach the join prompt. They
  contain no workspace data; every data route is behind the gate.
- Restarting the host rotates the code and invalidates all tokens.
  There is no persistent guest list to manage or leak.
- Tokens expire 12 hours after issue (v2.32). An expired token is
  forgotten by the host; the guest's next request is refused and
  the IDE prompts for the code again, so expiry costs a re-typing,
  not a lockout.
- The host can revoke every guest at once from the pair panel
  ("Revoke all guests", `POST /api/pair/revoke`, loopback-only).
  Revoked guests re-join with the code the same way.
- LAN traffic is encrypted (v2.38). In LAN mode the desktop host
  serves guests over HTTPS with a self-signed certificate, while
  the host's own screen keeps using plain HTTP on loopback (it
  never sees a warning). The certificate is persistent - one per
  host, generated once and kept in `~/.ghostide/tls` - so its
  SHA-256 fingerprint is the host's stable identity. The
  fingerprint is shown in the host's pair panel, in the server
  console at boot, and at `GET /api/pair/certfp` (loopback-only,
  like the code). A guest compares the fingerprint their browser
  shows for the connection with the host screen before typing
  the code: the code is still the secret, the fingerprint is
  the identity.
- The certificate is regenerated only when the host's network
  addresses outgrow it (for example a new network) or its files
  are deleted. When that happens the console says so, and the
  new fingerprint must be verified on the host screen before
  pairing again - treat it like a changed SSH host key.

## What this does not do

- Encryption stops sniffing, not impersonation by itself. A
  browser guest's only warning that a certificate is self-signed
  is the browser's "not private" page, and clicking through it
  is the normal first-join flow. Someone actively impersonating
  the host on the network produces the same warning, so the
  protection against that is the fingerprint check above: a
  guest who skips comparing can still be fooled at first
  pairing. Encryption does defeat passive observers completely
  (files, chat, and tokens cross the LAN unreadable, and a
  sniffed session yields nothing replayable).
- If the host cannot generate a certificate (neither the
  `cryptography` package nor the `openssl` command is
  available), LAN mode still starts, in plain HTTP, with a
  loud warning in the server console. Check the console: in
  that mode anyone who can sniff the network can replay a
  token for up to 12 hours (its lifetime), or until the host
  revokes all guests or restarts. Pair on networks you trust;
  use the GitHub connect, a VPN, or a USB transfer for hostile
  networks.
- The code is 6 digits by design (typed once, on a phone). Join
  attempts are rate limited (v2.12): 5 wrong codes inside 10
  minutes locks the source out for 10 minutes. A rotated source
  address resets that, which is one more reason for the
  trusted-network rule above.
- Guest roles (v2.23): the host sets a policy in the pair panel
  and NEW tokens join as editors or view-only. A view-only token
  can read and send presence heartbeats; every other POST is
  refused with 403 "view-only guest". Roles are assigned by the
  host at join time, never requested by the guest, and the policy
  endpoint is loopback-only. An editor token still has full API
  access to the host workspace, including file writes, so editor
  pairing remains like handing someone your unlocked phone.

## Conflicts

Presence is advisory (heartbeat, 25 s expiry). Saves are guarded:
if the file changed on the host since you opened it, your save is
diverted to `<file>.conflict-<device>` and the pair panel offers
the resolution; a save never silently overwrites the other
device's work.

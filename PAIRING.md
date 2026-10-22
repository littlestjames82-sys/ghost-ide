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

## What this does not do

- Traffic is plain HTTP on the LAN: a token stops casual access
  and scripts, it does not encrypt anything, and anyone who can
  sniff the network can replay a token until the host restarts.
  Pair on networks you trust; use the GitHub connect or a USB
  transfer for hostile networks.
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

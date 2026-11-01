# GhostIDE 20x20 Campaign — Nov 1, 2026

Ryan's directive: "Run 20 improvement rounds, 20 audit rounds, then
repeat it — polish, harden, inspect, harden."

Rules of the campaign (standing GhostIDE gates, unchanged):
- Every round ends verified: fixture proof in the foreground,
  DOM-stub bundle gate, full harness suite, eco gate when the
  bundle changes, APK badging + signer + staged byte-match checks.
- Rounds ship grouped into releases (5 rounds per version); every
  release is pushed to GitHub with read-back diff EMPTY.
- Audit rounds are audit-first: findings get fixed in the same
  release when they are real; thin findings are reported honestly,
  never padded.
- No paid spend, no new network services, no release gates lifted.

## Cycle 1 — Improvements (20)

- [x] I1  E18 Recipes shelf: GhostRecipes library in-IDE (list,
      show, validate, render to a workspace checklist file).
- [x] I2  E19a Leads panel: GhostLeads store list/score/pack
      (drafts only) for the open workspace.
- [x] I3  E19b QuoteShot panel: open a job folder, items + totals,
      render the quote sheet fully offline.
- [x] I4  E16 replay timeline: agent runs record a session file;
      Replay panel lists sessions and scrubs the step timeline.
- [x] I5  GhostMCP 0.2: resources + prompts verbs, panel tabs,
      rebundle (eco generation e9).
- [x] I6  Board: one tap runs the missing reports (verify /
      review / scope) from the board's Attention cards.
- [x] I7  Watch feed: an open, unmodified file that changes on
      disk reloads in place with a banner (dirty files never
      touched).
- [x] I8  Approve queue: pending-count badge on the Tools entry
      plus Approve all / Deny all for the visible queue.
- [x] I9  Terminal pane gains Slice log + Ask Ghost, same as the
      Run pane.
- [x] I10 Board cards open their source report in the editor
      (substituted: chat file attach already exists as the
      @ File mention picker; the gap was board -> report).
- [x] I11 Replay panel: a Re-run button seeds the recorded task
      back into the chat box with Agent mode on (substituted:
      indexed search already opens at the hit line - that
      shipped with E3).
- [x] I12 Git panel shows the latest Scope verdict line when a
      scope pack exists.
- [x] I13 Ecosystem panel shows each wired tool's board state
      (ok / attention / no report) beside its Run button.
- [x] I14 Data pane gains a Pack button (full GhostData pack:
      schema + bounded redacted sample as files in .ghostide).
- [x] I15 Agent CONTEXT action: on-demand repo map (GhostAtlas
      form) the model can request mid-task.
- [x] I16 Agent priming names the workspace's worktrees.
- [x] I17 MCP list caching (built v2.50): tools/resources/
      prompts lists are cached server-side for 5 minutes,
      keyed by the config file's mtime, so panel browsing
      and agent priming stop re-handshaking. Calls, reads
      and prompt gets always execute live (fixture-proven:
      2 list calls = 1 spawn, 1 call = 1 more spawn).
      Full persistent sessions stay a Cycle 2 candidate.
- [x] I18 Settings readout: eco bundle generation, tool count and
      bundle bytes from the manifest.
- [x] I19 VERIFY gaps gain a "Draft fix task" button that seeds
      the agent box with the gap list.
- [x] I20 Build gate: the four version spots + changelog +
      VERSION.json must agree or build.sh refuses.

## Cycle 1 — Audits (20)

- [x] A1  PASS (v2.51): gate on both methods; join exempt +
      rate-limited (5 fails/10 min -> 10 min lock); host-only
      routes recheck loopback; tokens expire 12h; viewers
      read-only on every POST. LAN listener not provable in
      the sandbox (no LAN interface); static shell is public
      by design, every data route is /api/.
- [x] A2  PASS (v2.51): live probes - plain .., %2e%2e, ..%2F,
      absolute /etc/passwd, symlink file + dir escapes and a
      write escape all refused with 'path escapes workspace';
      resolve/canonicalize-then-contain on both servers.
- [x] A3  PASS (v2.51): unwired tools and name tricks refused;
      '--help' as a path is a filename, not a flag (paths go
      absolute through safe_path before argv); REA bridge
      same pattern (allowlist + safe_path + list argv).
- [x] A4  FIXED (v2.51): batch parser probed 14/14 against the
      shipped code (every mutating verb + fences void a
      batch; CONTEXT batches as read-only). FINDING: agent
      MCP calls bypassed the RUN rails - they now honor the
      queue policy (new queue kind 'mcp', executed on
      approval by both servers; desktop fixture-proven) and
      per-call approval under the other policies.
- [x] A5  PASS (v2.51): forged id, double decide and bad
      decision words refused; a tampered store payload was
      refused at decide time (GhostApprove re-derives the
      content hash) and the audit/verify flags the tamper
      by id with both hashes.
- [x] A6  PASS + 1 fix (v2.52): route/key parity verified on
      the newest routes (approve incl. kind mcp, worktrees
      {path, branch, head} both sides, board, slicelog,
      studio, replay, datapack, eco/info, MCP verbs; files
      mtime both - seconds on desktop, ms on phone, only
      ever diffed). FINDING (from I16): the agent worktree
      briefing read w.name, a key the API never sends - it
      would have primed 'undefined' names; now derives the
      name from the path like the Git panel does. Known
      divergences, by design: desktop MCP list cache;
      phone RUN approvals record without executing.
- [x] A7  PASS (v2.52): canary probes - MCP server lists
      expose env NAMES only (never values), including on
      error paths ('could not start server' names the
      command, no env). The canary appeared only in
      same-user reads of the canary file itself (schema/
      pack treat its first line as a CSV header) - no
      cross-boundary leak. Observation logged: GhostData
      sample redaction does not scan header names when a
      KEY=VALUE file is parsed as CSV (the pack sample
      itself stayed clean).
- [x] A8  PASS (v2.52): sink census (~100 innerHTML touches)
      - dynamic HTML routes through renderMarkdown, which
      escapes the whole source first, quote-escapes
      attribute interpolation, and renders non-http(s)
      link schemes inert (the v2.36 hardening); mermaid
      labels are escHtml'd at emission; panels built in
      this campaign use textContent throughout; remaining
      assignments are static strings or clears.
- [x] A9  PASS + 1 alignment (v2.52): cross-checked the
      shipped APK - gate LIBRARY+BUNDLED (29) == eco.zip
      tools == eco-manifest keys == Java ECO_BUNDLED;
      ECO_CATALOG (36) covers the ship set (catalog is the
      full ecosystem by design). Stamp rule held: no bundle
      content changed since e9, stamp untouched. Desktop
      /api/eco/info counted only BUNDLED (28) vs the
      phone's 29 - now counts LIBRARY+BUNDLED like the
      manifest.
- [x] A10 PASS (v2.52): the I20 gate (check_versions.py, run
      first by build.sh) covers exactly this audit's list -
      server.py, VERSION.json, changelog top, manifest
      name+code, IdeServer VERSION - and passes on the
      current tree.
- [x] A11 PASS (v2.53): signer cert SHA-256 identical across
      all six campaign APKs (8ea8684a...); staged app.js +
      changelog byte-match source every release; dex route
      presence checked per release. APK container bytes are
      not bit-reproducible (zip timestamps) - the verified
      invariants are asset identity + signer identity.
- [x] A12 PASS (v2.53): desktop terminal is labeled in the UI
      ('local shell (unsandboxed)') and pairing-gated off-
      loopback; the phone's /api/terminal answers an honest
      400 refusal and no shell exists in the Java server.
- [x] A13 PASS (v2.53): live probes - switch validates the
      target is an existing folder (file/missing refused);
      any real folder is switchable BY DESIGN (an IDE open-
      folder action; guests are pairing-gated, viewers
      cannot POST). Worktree remove: main workspace and
      unknown paths refused on the live server; a real
      sibling worktree added and removed cleanly. Phone
      workspace is fixed by design (no switch route).
- [x] A14 PASS w/ note (v2.53): request bodies capped at
      64MB with strict framing (duplicate Content-Length
      and chunked bodies refused, v2.35); every file write
      snapshots the prior content to history first; an
      interrupted restore is reconciled at boot. Writes
      are direct, not temp+rename - a mid-write crash can
      truncate, but the history snapshot makes it
      recoverable; accepted, logged.
- [x] A15 PASS + 2 fixes (v2.53): desktop probes - malformed
      JSON, wrong types, missing fields and empty bodies
      all answer clean {error}s, no 500s. Fixes: unknown
      /api/* routes answered the static handler's HTML 404
      on desktop and an asset 404 on the phone - both now
      return the JSON {error} 404; and a Java route that
      threw before writing dropped the connection - the
      phone now returns a 400 {error} when nothing was
      written (write-tracking stream wrapper). Desktop
      fix verified live; Java fix compiles into v2.53.
- [x] A16 PASS (v2.54): timeout census - every desktop
      subprocess.run carries an explicit bound (20-180s;
      helpers default eco 120 / mcp 50 / git 30 / term 30);
      the Java runProcess enforces a deadline loop and
      destroys on expiry with capped output buffers. The
      long-lived processes (model server, terminal, REPL)
      are supervised sessions by design, not one-shots.
- [x] A17 PASS (v2.54): live probe - 14 enqueues fired in
      parallel batches all landed as 14 unique pending
      records, zero corrupt files (the approve store is
      file-per-record + append ledger by construction);
      mixed parallel /api/files reads unaffected. Desktop
      terminal and REPL sessions hold dedicated locks.
- [x] A18 PASS (v2.54, incl. A15's fixes): API routes on
      both servers answer {error} JSON with sane statuses
      (400 validation, 404 unknown route, 429 pair lock);
      Java sendText is used only for static assets. The UI
      surfaces errors plainly (postJson throws Error with
      the server's message; panels show it inline).
- [x] A19 PASS + 1 fix (v2.54): campaign panels' buttons
      all carry visible text labels (no icon-only buttons
      in the new code; older icon buttons carry title
      attributes). FINDING: the .ghostbtn class used by
      dozens of panel buttons was never defined - they
      fell back to the generic button rule (~29px tall).
      It now sets a 36px minimum tap target app-wide.
- [x] A20 PASS + 1 fix (v2.54): ROADMAP_ECO statuses match
      the shipped code (E18/E19 BUILT v2.47, E20 lite-
      wired, E21 pending its host gate). FINDING:
      KNOWN_ISSUES still claimed 'LAN mode has NO
      authentication' - stale since pairing shipped;
      rewritten to describe the token/role reality and
      the ungated static shell honestly.

## Found during Cycle 1 (fixed in passing)

- GhostConsole test-suite calendar rot: fixtures pinned to
  2026-10-14 crossed the board’s 7-day stale window on
  Oct 21 and 18 tests failed by Nov 1 (the tool was never
  broken; its own board proof in v2.46 ran on live data).
  Fixture dates shifted as a set (Oct 12/13/14 -> Oct
  29/30/31, relative spacing preserved; the deliberately
  stale Aug 1 fixtures untouched) - 103/103 green. The
  fixtures will rot again ~Nov 7: Cycle 2 carries the
  durable fix (clock-relative fixture dates in conftest).

## Cycle 2 — repeat (20 + 20)

Second wave, defined from Cycle 1's outcomes when Cycle 1 closes:
improvements target whatever the audits surfaced plus the next
roadmap tier; audits re-run A1–A20 against the changed surface
and deepen the two thinnest areas. The cycle closes with a
consolidated posture note in BUILD_NOTES.

## Cycle 2 definition (set Nov 1, 2026, from Cycle 1 outcomes)

Improvements (C2-I1..I20), releases of five:
- Batch 1 (v2.55): C2-I1 persistent MCP sessions (GhostMCP
  0.3.0 serve daemon + IDE daemon client, one-shot CLI
  fallback), C2-I5 MCP sessions readout in the panel,
  C2-I3 GhostConsole clock-relative fixtures (the durable
  fix for the ~Nov 7 rot).
- Batch 2 (v2.56): C2-I2 Java MCP list cache parity,
  C2-I4 GhostData header-name redaction scan, C2-I6 agent
  priming learns the board state, C2-I7 replay export to
  a markdown transcript, C2-I8 approve queue kind filter.
- Batch 3 (v2.57): C2-I9 watch rows jump to the file,
  C2-I10 verify run history (client-persisted), C2-I11
  eco panel search, C2-I12 studio render history,
  C2-I13 data packs list + delete.
- Batch 4 (v2.58): C2-I14 board cards show last commit,
  C2-I15 settings MCP readout + restart sessions,
  C2-I16 palette gains the panel openers, C2-I17 agent
  trail auto-scroll toggle, C2-I18 file-tree external-
  change dots, C2-I19 REPL slice/ask, C2-I20 staged-asset
  self-check inside build.sh.
Audits (v2.59-v2.62): A1-A20 re-run against the changed
surface in the same four groupings, deepening A7
(canary across board/studio outputs) and A17 (parallel
hammer on the session daemon + approve store together).
- [x] C2-I1 DONE (v2.55): ghostmcp serve daemon keeps one
      handshaken session per server; server.py routes all
      MCP verbs through it with the one-shot CLI as
      fallback. Fixture-proven end to end: 3 requests,
      exactly 1 server spawn (was 3).
- [x] C2-I5 DONE (v2.55): /api/mcp/sessions + a "Live
      sessions" line in the MCP panel (desktop daemon;
      the phone answers empty and the line hides).
- [x] C2-I3 DONE (v2.55): conftest fixture_iso() computes
      stamps from today (offsets preserve the original
      spacing); every pinned 2026-10 date in the suite
      converted; GhostConsole 103/103 green. Eco bundle
      generation e10 carries GhostMCP 0.3.0.

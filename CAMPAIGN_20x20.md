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
- [x] C2-I2 DONE (v2.56): Java mcpListBody caches tools/
      resources/prompts for 5 min keyed by config path +
      verb + server, invalidated by config mtime; calls
      never cached - parity with the desktop cache.
- [x] C2-I4 DONE (v2.56): GhostData 0.1.1 display_name()
      masks KEY=VALUE header tails (CANARY=<redacted>) in
      schema, columns and redacted lists; suite 95/95;
      canary verified gone from output. Bundle e11.
- [x] C2-I6 DONE (v2.56): agent priming adds a one-line
      Studio board summary (boardSummaryLine, shared with
      the board panel).
- [x] C2-I7 DONE (v2.56): replay rows gain Export .md -
      a markdown transcript downloaded client-side.
- [x] C2-I8 DONE (v2.56): approve panel gains a kind
      filter bar (All/Run/Delete/MCP/Write/Other) when
      more than one request waits.
- [x] C2-I9 DONE (v2.57): watch feed renders each changed
      file as a jump link that opens it (gone files stay
      plain text; the bar still refreshes the tree).
- [x] C2-I10 DONE (v2.57): verify runs keep a five-entry
      on-device history (localStorage) shown under the
      report.
- [x] C2-I11 DONE (v2.57): ecosystem panel gains a live
      filter box over tool name + blurb.
- [x] C2-I12 DONE (v2.57): studio "renders" verb on both
      servers lists .ghostide/recipe-*.md newest first;
      Recipes shelf gains a Recent renders button.
- [x] C2-I13 DONE (v2.57): /api/eco/datapacks +
      /api/eco/datapack/delete on both servers (names
      pinned to the data-pack- namespace); Data pane
      gains a Packs button (list + delete by exact name).
      Desktop routes fixture-proven live.
- [x] C2-I14 DONE (v2.58): board panel shows the
      project's last commit (hash + subject).
- [x] C2-I15 DONE (v2.58): Settings MCP readout (live
      sessions) + Restart sessions button; /api/mcp/
      restart both servers (desktop stops the daemon,
      phone clears its list cache); phone gains a
      shape-parity /api/mcp/sessions (empty list).
- [x] C2-I16 DONE (v2.58): palette gains the eight panel
      openers (Approve, Board, Eco, MCP, Replay, Recipes,
      Leads, QuoteShot).
- [x] C2-I17 VERIFIED COVERED (v2.58): the auto-scroll
      toggle already exists end to end (settings.
      autoScroll + #setAutoScroll + shouldChatScroll in
      addMsg and the stream path). No code needed.
- [x] C2-I18 DONE (v2.58): watch-changed files carry a
      dot in the tree until opened (watchChanged set fed
      by watchTick; reloaded files clear theirs).
- [x] C2-I19 VERIFIED COVERED + polish (v2.58): the REPL
      shares the terminal pane, so I9's Slice/Ask already
      operate on REPL output; the Ask lead is now
      mode-aware ("REPL output" in repl mode).
- [x] C2-I20 DONE (v2.58): build.sh self-check extracts
      the signed APK's staged www assets and byte-
      compares them with the web sources; a mismatch
      fails the build before BUILD-OK.

## Cycle 2 audits (A1-A20 re-run, deepening A7 + A17)
- [x] C2-A1 PASS (v2.59): pair gate still precedes routing
      in do_GET and do_POST; every Cycle 2 route sits
      behind it by construction.
- [x] C2-A2 PASS (v2.59): datapack/delete name pin probed
      live with six traversal shapes (../, ..%2e, slashes,
      absolute, bare prefix) - all refused; renders verb
      is glob-scoped to .ghostide.
- [x] C2-A3 PASS (v2.59): agent RUN/DELETE/MCP branches
      still check the queue policy first; Cycle 2 touched
      priming text only.
- [x] C2-A4 PASS (v2.59): MCP execution still lives only
      inside approve_decide (post-approval); the C2-I1
      daemon sits below _mcp_cli and cannot be reached
      by the agent without a decide.
- [x] C2-A5 PASS (v2.59): hash binding intact - decide
      still passes the record's hash to GhostApprove;
      the I8 kind filter is display-only DOM code.
- [x] C2-A6 PASS (v2.60): Cycle 2 routes (datapacks,
      datapack/delete, mcp/sessions, mcp/restart) exist
      on both servers; pack mtime is seconds on both.
- [x] C2-A7 PASS, DEEPENED (v2.60): canary hunted through
      the NEW outputs - board JSON, datapack list, MCP
      sessions, eco/info - all clean; GhostData analyze
      of a canary-header CSV through the IDE carried
      zero canary occurrences (the C2-I4 redaction
      holding in the integrated path). Pack contents
      remain same-user-by-design (created by the user's
      own Pack tap on their own file).
- [x] C2-A8 PASS (v2.60): Cycle 2 DOM sinks are
      textContent (board commit line, tree dots, watch
      links, pack list, verify history).
- [x] C2-A9 PASS (v2.60): gate state holds 29 tools at
      the Cycle 2 pins (ghostdata 0.1.1, ghostmcp 0.3.0,
      ghostconsole suite 103); nothing bundled changed
      since the e11 gate.
- [x] C2-A10 PASS (v2.60): version gate ritual (five
      sources agree before the build starts).
- [x] C2-A11 PASS (v2.61): signer lineage continues
      (v2.60 cert prefix 8ea8684a...); staged-match is
      now enforced inside build.sh itself (C2-I20).
- [x] C2-A12 PASS (v2.61): terminal honesty unchanged -
      desktop labeled unsandboxed, phone refuses.
- [x] C2-A13 PASS (v2.61): switch/worktree guards
      untouched by Cycle 2 (switch still raises
      "not a folder").
- [x] C2-A14 PASS (v2.61): snapshot_history still runs
      before every content overwrite; Cycle 2 added no
      new content-writing routes (pack delete removes a
      namespace-pinned directory only).
- [x] C2-A15 PASS (v2.61): new routes' error shapes
      probed live - unknown studio verb, unknown studio
      tool and a malformed JSON body all returned clean
      {error} JSON.
- [x] C2-A16 PASS (v2.62): every Cycle 2 subprocess path
      keeps a bound (daemon calls 50s default with the
      per-request deadline refresh; renders ride the eco
      120s bound; pack routes are filesystem-only).
- [x] C2-A17 PASS, DEEPENED (v2.62): live hammer -
      10 parallel MCP calls through the daemon all
      answered (isError false) with exactly ONE fixture
      spawn (the _McpDaemon lock serializes creation;
      the session is shared); 10 parallel approve-list
      reads all returned valid JSON, store uncorrupted.
- [x] C2-A18 PASS (v2.62): Cycle 2 shapes match across
      servers ({packs:[...]}, {sessions:[...]},
      {ok:true}).
- [x] C2-A19 PASS (v2.62): new labels stay honest -
      verify history is scoped "on this device", the
      phone's sessions line reads "none live" (true:
      one-shot), Restart's title states its scope.
- [x] C2-A20 PASS (v2.62): this file carries every
      Cycle 2 verdict; BUILD_NOTES carries the
      consolidated Cycle 2 posture note in the v2.62
      entry. CYCLE 2 COMPLETE: improvements v2.55-
      v2.58, audits v2.59-v2.62.

# Cycle 3 (v2.63-v2.70) - defined Nov 1, 2026
Ryan's "Continue" after Cycle 2 closed. Same shape: 20
improvements in four batches of five (v2.63-v2.66),
then A1-A20 re-run deepening A4/A5 (the new restart +
pairing routes), A13 (pack view pin) and A17 (hammer
with per-server restarts mixed in) as v2.67-v2.70, plus
the Cycle 3 posture note.

## Cycle 3 improvements
Batch 1 (v2.63): C3-I1 per-server MCP session restart
(drop verb in the daemon; panel rows gain Restart).
C3-I2 paired-devices readout (roles + expiry, never
token values; Settings). C3-I3 agent priming gains git
state (branch + changed count). C3-I4 pack viewer
(namespace-pinned view route; PROMPT.md). C3-I5 studio
renders return JSON; shelf lists renders with Open
buttons.
Batch 2 (v2.64): C3-I6 git-dirty markers in the tree.
C3-I7 REPL "Run current file". C3-I8 eco tool run
history (on-device, in the panel). C3-I9 verify report
Copy summary button. C3-I10 terminal Clear button if
missing (else verified-covered).
Batch 3 (v2.65): C3-I11 atomic writes (temp + rename
under the snapshot) closing the A14 residual, both
servers. C3-I12 build self-check extended to the eco
bundle (tool count + pinned versions inside the APK).
C3-I13 daemon idle-session reaping (30 min). C3-I14
approve rows show request age. C3-I15 sessions readout
gains per-session age + last-call time.
Batch 4 (v2.66): C3-I16 board panel Git-panel jump.
C3-I17 palette action commands (Restart MCP sessions,
View data packs). C3-I18 replay list shows run elapsed
time. C3-I19 Settings About-this-build readout.
C3-I20 one-command harness runner (tools/harness/
run-all) with a summary line.
- [x] C3-I1 DONE (v2.63): daemon "drop" verb (GhostMCP
      0.3.1); /api/mcp/restart takes {server} (desktop
      drops one session, phone clears that server's
      list cache); MCP panel sessions gain per-server
      Restart rows. Live-proven: drop emptied the list,
      next call respawned (spawns +2 across the cycle).
- [x] C3-I2 DONE (v2.63): GET /api/pair/devices both
      servers - role + issued + expires only, tokens
      never leave the server; Settings gains a Paired
      devices line. (Probe caught a _time NameError in
      the first cut; fixed to time.time().)
- [x] C3-I3 DONE (v2.63): agent priming gains a Git
      line (branch + changed count from /api/git/
      status's changes array).
- [x] C3-I4 DONE (v2.63): /api/eco/datapack/view both
      servers, same namespace pin as delete (traversal
      refused live); Data pane gains a View pack button
      showing PROMPT.md.
- [x] C3-I5 DONE (v2.63): studio renders verb returns
      JSON on both servers; Recipes shelf lists renders
      with Open buttons (openFile into .ghostide).
- [x] C3-I6 DONE (v2.64): git-dirty tree markers -
      refreshGit fills gitDirtyPaths from the status
      changes; rows append a diamond (distinct from the
      watch dot; converges one refresh behind).
- [x] C3-I7 DONE (v2.64): REPL Run file button (repl
      mode only) sends the editor's current text (20k
      cap) to /api/repl. Live-proven: a multi-line
      program executed as one block with correct output.
- [x] C3-I8 DONE (v2.64): eco run history - both Run
      paths note outcomes to localStorage (last 8); the
      panel head shows Recent runs with failures marked.
- [x] C3-I9 DONE (v2.64): Run pane Copy summary button
      copies the pane title (Verify's one-line verdict)
      with a copied confirmation state.
- [x] C3-I10 DONE (v2.64): terminal Clear button
      empties the pane output only; the session (cwd,
      REPL globals) keeps running - distinct from the
      existing Session reset.
- [x] C3-I11 DONE (v2.65): atomic writes both servers -
      desktop /api/file saves via same-dir temp +
      os.replace after the snapshot; Java writeFile via
      temp sibling + ATOMIC_MOVE (rename fallback). The
      A14 residual recorded since Cycle 1 is CLOSED.
- [x] C3-I12 DONE (v2.65): build.sh self-check extended
      into the bundle - eco.zip tool count must equal
      the gate state and ghostmcp/ghostdata versions
      must match the pins, else the build fails.
- [x] C3-I13 DONE (v2.65): daemon idle reaping -
      sessions idle over 1800s close lazily on the next
      daemon touch (GhostMCP 0.3.2); suite-tested.
- [x] C3-I14 DONE (v2.65): approve rows show the wait
      (from GhostApprove's ingested_at, m/h text).
- [x] C3-I15 DONE (v2.65): sessions readout gains
      age_s + idle_s; panel shows age + idle, Settings
      shows idle.
- [x] C3-I16 DONE (v2.66): board panel gains an Open
      Git panel button (closes the panel, clicks the
      drawer Git view).
- [x] C3-I17 DONE (v2.66): palette gains Restart MCP
      sessions (restart then reopen the panel) and View
      data packs (new pack-list panel reusing the
      pinned view route).
- [x] C3-I18 DONE (v2.66): replay records elapsed_s
      (both runners pass their T0; bounded 0..86400;
      list shows "took Xm Ys" only when present -
      nothing backfilled). FOUND + FIXED en route: the
      desktop served replay list/get only via GET
      while the panel POSTs, so the desktop Replay
      panel silently showed zero runs since E16; POST
      twins now mirror the phone. Live-proven chain.
- [x] C3-I19 DONE (v2.66): Settings This build line
      from /api/health (version, workspace, model) -
      the health shape already matched on both servers.
- [x] C3-I20 DONE (v2.66): tools/harness/run-all.mjs -
      one command, per-file summary, nonzero exit on
      any failure. It caught two stale pins on its
      first run (campaign1 saveTrail shape, C2-A9
      ghostmcp pin), both updated with reasons.
- NOTE (v2.66 delivery): the APK upload approval was
  DECLINED by Ryan at the prompt (Nov 1 late), so no
  v2.66 link exists and nothing was uploaded. The
  build itself is complete and verified (93/93,
  md5 07fd17f23249ffec56a1659ba9396a55, on disk at
  ~/workspace/ghostide-apk/ghostide-v2.66.0.apk). Do
  not re-upload unless Ryan asks.
- [x] A11-A15 PASS (v2.69), A13 DEEPENED + 2 FIXES:
      signer lineage verified live on the v2.68 APK
      (8ea8684a...); terminal honesty label intact;
      body cap intact; malformed JSON earns clean 400s
      with the server healthy after. A13's pack-view
      deepening caught TWO defects in Cycle 3's own
      pack panel (v2.66, never installed): it called a
      nonexistent list route and read nonexistent view
      fields - both fixed to the real contracts
      (/api/eco/datapacks object entries; view returns
      {ok, output}). All 7 traversal-shaped names are
      refused by the view pin, same as delete.

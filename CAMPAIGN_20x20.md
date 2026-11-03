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

## Cycle 4 (defined Nov 2, 2026, on Ryan's "Continue")
Improvements v2.71-v2.74 (C4-I1-I20), audits v2.75-
v2.78 deepening A6 (new-route parity), A12 (new UI
labels), A17 (hammer incl. restarts), A19 (new label
honesty). Delivery rule this cycle: build + push only
- Ryan declined the v2.66 and v2.70 uploads, so no
upload is attempted unless he asks for a link.
- [x] C4-I1 DONE (v2.71): git ahead/behind - the
      porcelain branch header's [ahead N, behind M] is
      parsed on both servers and shown by the branch
      name (zeros hidden). Live-proven both ways.
- [x] C4-I2 DONE (v2.71): tree folder rows show their
      descendant file count, counted from the list the
      server already sends (no extra fetch).
- [x] C4-I3 DONE (v2.71): status bar gains selection
      word count (lines/chars already existed).
- [x] C4-I4 DONE (v2.71): terminal/REPL history
      persists on-device (localStorage, last 50) - it
      used to die with the page.
- [x] C4-I5 DONE (v2.71): terminal pane Copy button
      (the Run pane's copy pattern, applied to termOut).
- [x] C4-I6 DONE (v2.72): Approve queue Deny all -
      confirm, then a per-id deny loop; executes
      nothing by construction.
- [x] C4-I7 DONE (v2.72): verify history keeps 12
      (was 5) and marks the problem trend vs the
      previous run (fewer / more / same).
- [x] C4-I8 DONE (v2.72): plain find groups matches
      under counted per-file headers (was one flat
      list); the indexed search was already grouped.
- [x] C4-I9 DONE (v2.72): file filter persists
      (localStorage) and restores into the box at boot.
- [x] C4-I10 DONE (v2.72): Settings What's new button
      renders the bundled changelog's top 6 entries
      in-app (route live-proven). NOTE: font size,
      word wrap and Quick Open recents were scouted
      for this batch and found ALREADY covered - the
      picks above replaced them before building.
- [x] C4-I16 DONE (v2.74): agent priming reports
      upstream distance (ahead/behind commit counts)
      alongside the branch line. (Pair revoke-all was
      scouted first: already shipped since v2.32.)
- [x] C4-I17 DONE (v2.74): Run pane Save output -
      downloads the full pane text as a .log (Copy
      summary only ever carried the title line).
- [x] C4-I18 DONE (v2.74): MCP tools Refresh - the
      panel refetches with refresh:true; the phone's
      five-minute list cache skips its read (fresh
      result still stored); the desktop daemon is
      always live and ignores the flag.
- [x] C4-I19 DONE (v2.74): Settings About counts the
      workspace's files next to version/model.
- [x] C4-I20 DONE (v2.74): header health dot polls
      /api/health every 60s while visible; green with
      version/workspace on the title, red with the
      failure explained. CYCLE 4 IMPROVEMENTS COMPLETE
      (v2.71-v2.74).

## Cycle 4 audits (v2.75-v2.78)
- [x] A1-A5 PASS (v2.75): Cycle 4 added no new routes
      (fields and flags on existing ones); pair gate
      still wraps both verbs once each, viewer role
      check intact, deny-all rides the per-id decide
      route, refresh widens only list reads.
- [x] A6-A10 PASS (v2.76), A6 DEEPENED: git status
      parity (desktop live ahead 1 / honest zeros;
      Java same parse, compiled). A7 canary sweep over
      git status, health, eco info and files on the
      live fixture server: zero hits. A8 sink census
      unchanged at 101 - all Cycle 4 UI is textContent.
      A9 pins hold (29 tools, ghostmcp 0.3.2, e13).
      A10 atomic writes intact.
- [x] A11-A15 PASS (v2.77): signer verified live on
      the v2.76 APK (8ea8684a..., unbroken). Route
      census: 136 desktop / 126 Java - Cycle 4 changed
      zero routes; census recorded as the Cycle 5
      baseline. Name pins intact; history delta is
      display-only; malformed JSON probed live: clean
      {error} on tools + decide, server healthy after.
- [x] A16-A20 PASS (v2.78), A17 DEEPENED + 1 fix:
      timeout census unchanged (13 calls, 0 unbounded).
      A17 hammer: 6 enqueues, 6 parallel reads (valid),
      6 parallel denies - all executed:false, ledger
      coherent. A18 shapes plain. A19: labels honest;
      FIX - snapshot deltas under 1 KB claimed a full
      "1 KB"; they now read "about the same size".
      A20: verdicts here + Cycle 4 posture note in
      BUILD_NOTES. CYCLE 4 COMPLETE: improvements
      v2.71-v2.74, audits v2.75-v2.78.
- [x] C5-I6 DONE (v2.80): Settings Copy settings -
      the preferences JSON to the clipboard (the
      object was read first: no keys or tokens live
      in it, so the copy cannot leak a credential).
- [x] C5-I7 DONE (v2.80): file tree order toggle
      (server order / A-Z by path), persisted.
- [x] C5-I8 DONE (v2.80): board panel Ask Ghost
      button (prefill from the summary line).
- [x] C5-I9 DONE (v2.80): approval queue free-text
      filter beside the kind buttons.
- [x] C5-I10 DONE (v2.80): Git panel copy-status
      button (branch, distance, change count from
      the last live payload).
- [x] C5-I11 DONE (v2.81): eco Recent runs gains a
      Clear button where the history is shown.
- [x] C5-I12 DONE (v2.81): Settings Clear on-device
      histories - eco runs, verify runs, terminal
      history (store AND in-memory list, so it cannot
      resurrect), recent files. Settings/chats stay.
- [x] C5-I13 DONE (v2.81): Verify problems render as
      clickable rows (the server's problems were
      verified structured {path, line, message});
      plain runs clear stale rows.
- [x] C5-I14 DONE (v2.81): palette gains Toggle file
      tree order (mirrors C5-I7).
- [x] C5-I15 DONE (v2.81): palette gains Copy
      settings JSON (mirrors C5-I6).
- [x] C5-I16 DONE (v2.82): commit viewer - Recent
      commits are tappable; /api/git/show on both
      servers (hash pinned to hex 7-40) returns stat
      + patch capped at 20000 chars. Live-proven:
      real hash served, flag/garbage refused.
- [x] C5-I17 DONE (v2.82): replay rows gain a Copy
      summary button beside Re-run and Export.
- [x] C5-I18 DONE (v2.82): eco catalog Copy summary
      (id, name, state per tool - the payload carries
      no version field; the copy does not invent one).
- [x] C5-I19 DONE (v2.82): approval rows gain a copy
      button for the action text.
- [x] C5-I20 DONE (v2.82): agent priming names the
      first three changed paths (+N more), not just
      the count. CYCLE 5 IMPROVEMENTS COMPLETE
      (v2.79-v2.82).

## Cycle 5 audits (v2.83-v2.86) - vs the Cycle 4 census baseline
- [x] C5-A1 PASS (v2.83): pair gate wraps do_GET/
      do_POST once each; viewer check intact (pin).
- [x] C5-A2 PASS (v2.83): traversal refused live;
      the NEW show route's hex pin refused
      traversal-shaped and overlong hashes live.
- [x] C5-A3 PASS (v2.83): atomic writes intact
      (os.replace / ATOMIC_MOVE pins).
- [x] C5-A4 PASS (v2.83): canary sweep live on
      current code - 0 hits on git/status, health,
      eco/info, files, git/log.
- [x] C5-A5 PASS (v2.83): eco gate green; generation
      e13, 29 tools, ghostmcp 0.3.2 unchanged.
- [x] C5-A6 PASS (v2.84): timeouts intact (120/50/30
      pins, both runners).
- [x] C5-A7 PASS (v2.84): GitHub push modes and the
      signer remain script constants (lineage by
      construction).
- [x] C5-A8 PASS (v2.84): sink census on the built
      bundle UNCHANGED at 101 across all twenty
      Cycle 5 features - every new surface used
      textContent/createElement.
- [x] C5-A9 PASS (v2.84): eco stamp e13 consistent
      (gate + Java ensureEco + build self-check).
- [x] C5-A10 PASS (v2.84): bundle freshness - the
      built bundle carries this cycle's markers
      (git/show route, palette entries); DOM-stub
      gate passed in the release ritual.
- [x] C5-A10 CORRECTED (v2.84): the freshness check
      FAILED first - the bundle had frozen at the
      16:11 build because two health pollers shared
      the name pollHealth and esbuild refused every
      build since, masked by a piped tail in the
      ritual. v2.79-v2.83 APKs carried a pre-Cycle-5
      frontend (servers current). Fixed by renaming
      the dot poller pollHealthDot, un-piping the
      build step, keeping A10's marker pin permanent,
      and verifying freshness inside the APK asset.
      v2.84 is the first Cycle 5 APK whose interface
      contains all twenty improvements.
- [x] C5-A11 PASS (v2.85): signer verified LIVE on
      the v2.84 APK (SHA-256 8ea8684a..., unbroken).
- [x] C5-A12 PASS (v2.85): census re-derived at
      137 desktop / 127 Java - exactly the Cycle 4
      baseline plus I16's deliberate route pair.
- [x] C5-A13 PASS (v2.85): datapack name pins and
      traversal refusal unchanged.
- [x] C5-A14 PASS (v2.85): history delta wording
      honest both ways (KB figures only at >= 1 KB;
      sub-KB reads "about the same size as now").
- [x] C5-A15 PASS (v2.85): malformed JSON probed
      live on current code - clean {error} answers,
      health 200 after; body cap unchanged.
- [x] C5-A16 PASS (v2.86): leak sweep - zero
      canary/key-shaped strings in shipped sources.
- [x] C5-A17 PASS (v2.86): one decide route per
      server; Deny all and every decision ride it
      (live ledger proof stands from Cycle 4 A17).
- [x] C5-A18 PASS (v2.86): caps re-pinned, incl.
      the new show route's 20000-char cap both
      servers.
- [x] C5-A19 PASS (v2.86): verify problem rows
      render from structured fields via textContent;
      priming names changes without overstating.
- [x] C5-A20 PASS (v2.86): version ritual held
      (2.86.0/191, five sources, gate enforced).
      CYCLE 5 COMPLETE: improvements v2.79-v2.82,
      audits v2.83-v2.86, suite 113/113. Headline:
      A10 caught the frozen bundle - the cycle's
      most valuable audit outcome.

# Cycle 6 - THE AGENTIC CYCLE (Ryan, Nov 2, 2026: "Run the full agentic cycle")
Scope set by Ryan after the gap inventory: self-repair,
batching depth, budgets, sub-runs, agent memory,
background runs. Scouting corrected the inventory
before building: read batching, VERIFY/TEST actions,
per-file staged checks, and a stop flag ALREADY
exist. The real gaps are enforcement and depth:
nothing makes the agent verify before DONE, batches
run sequentially, there is no loop detection, no
sub-run delegation, no agent-written memory, no
pause/queue, and no run accounting. Releases:
improvements v2.87-v2.90, audits v2.91-v2.94.
Same delivery rule: build + push, no uploads.
- [x] C6-I1 DONE (v2.87): DONE gate - with staged
      changes, DONE first runs every staged file's
      automatic check; failures refuse DONE and feed
      back for repair (cap: settings.agentRepairRounds,
      default 3, max 5). Rules text tells the model.
- [x] C6-I2 DONE (v2.87): post-apply verify - the
      review's Apply now runs the full pipeline on
      disk and reports it; problems prefill a fix
      task (never auto-sent).
- [x] C6-I3 DONE (v2.87): VERIFY action returns the
      problem lines (path:line message, up to 10),
      not just counts.
- [x] C6-I4 DONE (v2.87): identical-action loop
      detection - warning injected at 3 repeats, run
      stops as "looping" at 4.
- [x] C6-I5 DONE (v2.87): run accounting - repairs
      ride the trail record; the end-of-run line
      reports steps, repair rounds, and seconds.
- [x] C6-I16 DONE (v2.90): agent status pill - fixed
      chip visible from any view while a run or plan
      is live, showing step and task; tap jumps to
      Chat. (Styling in style.css with a
      :not(.hidden) display rule - an inline flex
      would have defeated the .hidden class.)
- [x] C6-I17 DONE (v2.90): Pause/Resume on the pill -
      the ACT loop holds between steps while paused;
      Stop lands immediately through the same wait.
- [x] C6-I18 DONE (v2.90): task queue - an agent task
      sent while busy queues with a receipt; the run
      drains FIFO into fresh-primed runs.
- [x] C6-I19 DONE (v2.90): sequential batches honor
      Stop between actions, not only between steps.
- [x] C6-I20 DONE (v2.90): run accounting (steps,
      repairs, seconds) now shows on every completion
      line, not only when changes are staged.
      CYCLE 6 IMPROVEMENTS COMPLETE (v2.87-v2.90).

## Cycle 6 audits (v2.91-v2.94) - standard re-run + the new loop rails
- [x] C6-A1 PASS (v2.91): pair gate wraps both
      handlers once each; viewer check intact.
- [x] C6-A2 PASS (v2.91): traversal refused; commit
      hash pin intact both servers (live refusal).
- [x] C6-A3 PASS (v2.91): atomic writes intact.
- [x] C6-A4 PASS (v2.91): canary sweep live on
      v2.90 code - 0 hits on all five routes.
- [x] C6-A5 PASS (v2.91): eco pins unchanged
      (e13 / 29 tools / ghostmcp 0.3.2); full gate
      re-run green this cycle.
- [x] C6-A6 PASS (v2.92): timeouts intact.
- [x] C6-A7 PASS (v2.92): push modes and signer
      remain script constants.
- [x] C6-A8 PASS (v2.92): sink census UNCHANGED at
      101 on the bundle carrying all twenty agentic
      features.
- [x] C6-A9 PASS (v2.92): eco stamp e13 consistent.
- [x] C6-A10 PASS (v2.92): bundle freshness - the
      built bundle carries this cycle's markers
      (runExplore, agentPillShow, doneGate).
- [x] C6-A11 PASS (v2.93): signer verified LIVE on
      the v2.92 APK (8ea8684a..., unbroken).
- [x] C6-A12 PASS (v2.93): census unchanged at
      137/127 - the Agentic Cycle added no routes.
- [x] C6-A13 PASS (v2.93): datapack pins unchanged.
- [x] C6-A14 PASS (v2.93): delta wording honest.
- [x] C6-A15 PASS (v2.93): malformed JSON probed
      live this cycle (clean {error}, health up).
- [x] C6-RAIL PASS (v2.93): DONE-gate exclusivity -
      exactly one outcome="done" assignment exists
      in runAgent and it sits behind doneGate();
      the repair cap is clamped 0..5 and opens at
      the cap by design (bounded refusal).
- [x] C6-A16 PASS (v2.94): leak sweep zero hits.
- [x] C6-A17 PASS (v2.94): one decide route per
      server; all decisions ride it.
- [x] C6-A18 PASS (v2.94): caps re-pinned, incl.
      EXPLORE's 6-step cap and the notes 8 KB cap.
- [x] C6-A19 PASS (v2.94): new surfaces render via
      textContent (census held at 101 in A8).
- [x] C6-A20 PASS (v2.94): version ritual held
      (2.94.0/199). CYCLE 6 COMPLETE: improvements
      v2.87-v2.90, audits v2.91-v2.94, suite 121/121.
      New rails proven: DONE-gate exclusivity,
      EXPLORE whitelist (negative space), NOTE path
      pin, queue single-run guard, stop-beats-pause.
      Residuals: PLAN runs show the pill but do not
      pause (Stop works); the queue drains even
      while a review panel from the prior run is
      open (panels hold their own staged state);
      EXPLORE reads through the run's staged view,
      which is intended.

## Cycle 7 - THE FLOW CYCLE (git completeness, search power, continuity)
Scouted Nov 2, 2026 before building (the Cycle 6
discipline): git is deep (commit/stage/diff/blame/
worktrees/show) but has NO branch list/switch/create
anywhere - /api/git/checkout is per-file revert, not
branch switching - and NO stash anywhere. Workspace
search is substring-only on both servers. The Cycle 6
residual (PLAN runs do not pause) is real and closes
here. Agent GIT is status|diff|log only.
- Batch 1 (v2.95) branches: I1 GET /api/git/branches
  both servers; I2 POST /api/git/branch create/
  delete/switch, name pinned, both servers;
  I3 panel Branches section; I4 branchChip tap opens
  the git drawer; I5 agent GIT += branches (read).
- Batch 2 (v2.96) stash + pause: I6 stash routes
  both servers (index pinned); I7 panel Stash
  section; I8 stash count in git status + panel;
  I9 agent GIT += stash list; I10 PLAN pause honored
  (Cycle 6 residual closed).
- Batch 3 (v2.97) search power: I11 /api/search case
  + regex options both servers (invalid regex is a
  clean error, pattern capped); I12 search UI
  toggles; I13 results grouped by file with counts;
  I14 /api/replace dry-run preview; I15 replace UI
  previews before it writes.
- Batch 4 (v2.98) continuity: grounded at batch-3
  time, recorded honestly like prior cycles.
- Audits (v2.99-v3.02): A1-A20 vs Cycle 6 baselines
  (census moves +4/server by design: 141/131) plus
  new rails: branch-name pin (no leading dash, no
  traversal), stash index pin, dirty-switch surfaces
  git's own refusal, regex error + cap, PLAN pause.
- [x] C7-I1 DONE (v2.95): GET /api/git/branches on
      both servers ({name, current} list).
- [x] C7-I2 DONE (v2.95): POST /api/git/branch
      create/delete/switch both servers; name pinned
      identically (no leading dash, no dot-dot, no
      trailing slash/.lock); current-branch delete
      refused; git's own switch refusal surfaces.
      PROVEN LIVE on the fixture repo: list, create,
      switch, and all three refusals.
- [x] C7-I3 DONE (v2.95): Git panel Branches section
      (current marked, Switch/Delete per branch,
      Create and Create + switch).
- [x] C7-I4 DONE (v2.95): branchChip tap opens the
      Git drawer (was display-only).
- [x] C7-I5 DONE (v2.95): agent GIT += branches,
      read-only - switching stays a human act.
- [x] C7-I6 DONE (v2.96): stash routes both servers
      (GET list; POST push/apply/pop/drop). The index
      is pinned to a small int and the ref rebuilt
      server-side. PROVEN LIVE end to end.
- [x] C7-I6b FOUND+FIXED (v2.96): git stash push
      exits 0 having stashed NOTHING when only
      untracked files differ; both servers now turn
      "No local changes" into an honest error that
      points at the include-untracked option.
- [x] C7-I7 DONE (v2.96): panel Stash section with
      per-entry Apply/Pop/Drop (Pop/Drop confirm-
      gated) and an include-untracked toggle.
- [x] C7-I8 DONE (v2.96): stash depth rides
      /api/git/status on both servers; the panel
      section shows the count.
- [x] C7-I9 DONE (v2.96): agent GIT += stash,
      read-only, in BOTH parser sites (a batch-1
      pin had passed on one site alone; the count
      is pinned now).
- [x] C7-I10 DONE (v2.96): PLAN loop honors pause
      and updates the pill per step - the Cycle 6
      residual is closed.
- [x] C7-I11 DONE (v2.97): /api/search gains
      ignoreCase + regex on both servers; defaults
      keep the historic case-sensitive substring;
      pattern capped at 200; a bad regex is a clean
      error on both. PROVEN LIVE (all five cases).
- [x] C7-I12 DONE (v2.97): find panel Aa / .* 
      toggles, persisted per device.
- [x] C7-I13 REPLACED+ DONE (v2.97): the planned
      "group results by file" already shipped in
      Cycle 4 (I8) - replaced with Prev/Next match
      navigation over the last result set.
- [x] C7-I14 DONE (v2.97): /api/replace dryRun on
      both servers - counts, never writes. PROVEN
      LIVE (file unchanged after a dry run).
- [x] C7-I15 DONE (v2.97): Replace all runs the dry
      run first; the confirm states the exact count
      and file total, and a zero-count run stops
      with a plain message instead of a dialog.
- [x] C7-I16 DONE (v2.98): cursor positions ride
      the session - saveSession records each tab's
      selection head; restore parks them in
      pendingPos and activateTab applies each once,
      clamped to the document as it exists now.
- [x] C7-I17 DONE (v2.98): find query + replacement
      persist across reloads (ghostide.findText).
- [x] C7-I18 DONE (v2.98): the Git copy-status line
      carries the stash depth.
- [x] C7-I19 DONE (v2.98): agent priming names
      stashed work alongside branch/dirty state.
- [x] C7-I20 DONE (v2.98): non-repo refresh clears
      the Stash section and count too, so a
      workspace switch leaves no stale entries.
      CYCLE 7 IMPROVEMENTS COMPLETE (v2.95-v2.98).

## Cycle 7 audits (v2.99-v3.02) - standard re-run + flow rails
- [x] C7-A1 PASS (v2.99): pair gate intact.
- [x] C7-A2 PASS (v2.99): traversal + hash pin.
- [x] C7-A3 PASS (v2.99): atomic writes intact.
- [x] C7-A4 PASS (v2.99): canary sweep live on
      v2.98 code - 0 hits on five routes including
      the new branches and stash routes.
- [x] C7-A5 PASS (v2.99): eco pins unchanged; full
      gate re-run green this cycle.
- [x] C7-A6 PASS (v3.00): timeouts intact.
- [x] C7-A7 PASS (v3.00): lineage constants intact.
- [x] C7-A8 PASS (v3.00): sink census UNCHANGED at
      101 with all Flow features in the bundle.
- [x] C7-A9 PASS (v3.00): eco stamp e13 consistent.
- [x] C7-A10 PASS (v3.00): bundle freshness - the
      built bundle carries renderBranches,
      renderStashes, findJump and pendingPos.
- [x] C7-A11 PASS (v3.01): signer verified LIVE on
      the v3.00 APK (8ea8684a..., unbroken).
- [x] C7-A12 PASS (v3.01): census at the Cycle 7
      level, 141/131 (branches + stash by design).
- [x] C7-A13 PASS (v3.01): datapack pins unchanged.
- [x] C7-A14 PASS (v3.01): delta wording honest.
- [x] C7-A15 PASS (v3.01): malformed JSON probed
      live this cycle (clean {error}, health up).
- [x] C7-RAIL PASS (v3.01): branch pin identical in
      shape on both servers incl. the current-
      branch delete refusal; stash refs rebuilt
      from pinned indexes on both (bool and
      fractional indexes refused).
- [x] C7-A16 PASS (v3.02): leak sweep zero hits.
- [x] C7-A17 PASS (v3.02): one decide route per
      server; all decisions ride it.
- [x] C7-A18 PASS (v3.02): caps re-pinned, incl.
      the search pattern cap on both servers.
- [x] C7-A19 PASS (v3.02): new surfaces render via
      textContent (census held at 101 in A8).
- [x] C7-A20 PASS (v3.02): version ritual held
      (3.02.0/207). CYCLE 7 COMPLETE: improvements
      v2.95-v2.98, audits v2.99-v3.02, suite 129/129.
      New rails proven: branch pin parity + current
      protection, stash ref rebuilding, the honest
      no-op stash refusal, PLAN pause, agent git
      read-only by negative space. Residuals: the
      Java branch/stash routes are compile- and
      pin-proven with desktop parity (device proof
      stacks with Cycles 3-6); CI live proof of the
      Cycle 5 fix is still pending its next run.

## Cycle 8 - THE CRAFT CYCLE (editor craft, git finish)
Scouted Nov 2, 2026: @codemirror/lint is installed
but never imported - the editor has no inline
diagnostics, while /api/check-content already
syntax-checks unsaved content. Fold All / Unfold
All buttons exist and foldAll is imported, but
codeFolding() is in no extension list, so the
buttons are dead - a half-wired feature. Git tags
and amend do not exist. Wrap, sessions, chat
history and tests UI all check out as present.
- Batch 1 (v3.03) editor diagnostics: I1 lint
  gutter via a settings compartment; I2 live syntax
  diagnostics from check-content (debounced, on
  open/save/edit); I3 problems chip that jumps to
  the line; I4 settings toggle that also clears;
  I5 diagnostics never block typing or saving
  (best-effort, failures silent).
- Batch 2 (v3.04) folding completed: I6
  codeFolding() + foldGutter in baseExtensions;
  I7 fold keymap; I8 settings toggle; I9 split
  pane inherits via baseExtensions; I10 the dead
  Fold buttons come alive (proof by construction).
- Batch 3 (v3.05) git finish: I11 tags routes
  both servers (name pinned like branches); I12
  panel Tags section + tag-the-commit in the
  commit viewer; I13 amend route both servers;
  I14 panel Amend with confirm; I15 agent GIT
  += tags (read-only).
- Batch 4 (v3.06) tests craft: grounded at
  batch-3 time from the tests UI as it stands.
- Audits (v3.07-v3.10): A1-A20 vs Cycle 7 baselines
  (census moves +3/server by design: 144/134) plus
  rails: diagnostics are compute-only (no writes),
  tag pin parity, amend surfaces git refusals,
  fold/diag are view-only state.
- [x] C8-I1 DONE (v3.03): lintGutter imported from
      @codemirror/lint and wired through a settings
      compartment (diagComp), same pattern and TDZ
      discipline as wrap/indent/whitespace.
- [x] C8-I2 DONE (v3.03): live syntax diagnostics -
      /api/check-content over the current editor
      text, debounced 1200 ms, first problem mapped
      into the gutter as an error diagnostic.
- [x] C8-I3 DONE (v3.03): status-bar problems chip
      names the line, carries the message as its
      title, and jumps to the line on tap.
- [x] C8-I4 DONE (v3.03): Settings toggle
      reconfigures both panes and clears diagnostics
      + chip when switched off.
- [x] C8-I5 DONE (v3.03): checks fire on edit
      (debounced), on save, and on tab activation;
      all failures are silent by design.

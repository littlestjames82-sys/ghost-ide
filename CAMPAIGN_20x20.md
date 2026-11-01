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

- [ ] A1  Pairing/auth coverage: every route behind the pair gate
      off-loopback; no route leaks by method mismatch.
- [ ] A2  safe_path traversal sweep across all file routes
      (.., absolute paths, symlink escape, dotfile policy).
- [ ] A3  Eco toolrun allowlist: only the wired verbs reachable;
      argument injection via path fields probed.
- [ ] A4  Agent rails: batch blockers complete (RUN/WRITE/EDIT/
      DELETE/MCP never batched), policy packs honored at every
      branch, plan mode cannot write.
- [ ] A5  Approve queue integrity: hash binding, forged-decide
      probes, results log tamper evidence via verify.
- [ ] A6  Java/Python parity on the newest routes (approve,
      worktrees, board, slicelog, files mtime, MCP).
- [ ] A7  Secret leakage: MCP env values, scope/review outputs,
      error strings echoing file contents.
- [ ] A8  XSS sweep: every innerHTML sink fed by workspace or
      tool strings; textContent used where data is untrusted.
- [ ] A9  Eco bundle integrity: gate BUNDLED == eco.zip ==
      manifest == Java ECO_BUNDLED/ECO_CATALOG, stamp rules.
- [ ] A10 Version-source consistency (4 spots + changelog +
      VERSION.json) — feeds I20's build gate.
- [ ] A11 Build reproducibility: staged assets byte-match, signer
      stable, dex contains the new routes each release.
- [ ] A12 Terminal exposure: desktop shell disclosed in UI, phone
      refusals honest, no shell route reachable on phone.
- [ ] A13 Workspace switching: path validation, worktree remove
      refusals, fixed-workspace phone behavior.
- [ ] A14 Write routes: size caps, overwrite rules, draft
      recovery, chat/agent staged-write atomicity.
- [ ] A15 Malformed input: bad JSON bodies, wrong types, missing
      fields → clean 400s on both servers, no 500s/crashes.
- [ ] A16 Timeouts: every eco/agent subprocess bounded; a hung
      tool cannot wedge a server thread forever.
- [ ] A17 Concurrency: terminal session, REPL, approve store and
      watch polling under parallel requests.
- [ ] A18 Error contract: routes answer {error} JSON with the
      right status; the UI surfaces them plainly.
- [ ] A19 New-panel accessibility: titles/labels on icon buttons,
      focus order, tap targets on the phone layout.
- [ ] A20 Docs truth: ROADMAP_ECO, BUILD_NOTES, changelog claims
      re-checked against the code they describe.

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

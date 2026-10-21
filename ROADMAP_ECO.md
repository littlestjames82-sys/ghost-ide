# GhostIDE x Ghost Ecosystem - Integration Roadmap (E1-E21)

Drafted Oct 20, 2026 at Ryan's request: bring the Ghost
ecosystem's tools into GhostIDE, the studio's editor.
Source inventory: ~/workspace/ghostslice-companions/
ECOSYSTEM.md (8 mains, 34 companion tools, all
stdlib-only Python, all with their own test suites).

## How integration works (three routes)

1. **Embed.** The companions are zero-dependency
   Python. The desktop server is Python and the phone
   carries Python 3.14 on-device, so a tool can run
   inside GhostIDE against the workspace and render
   its own report in a panel. No rewrites: the IDE
   runs the tool itself, so the IDE's numbers are the
   tool's numbers.
2. **Bundle (phone).** The phone-safe subset (pure
   stdlib, no network, no host assumptions) ships in
   the APK's Python assets, versioned, and is labelled
   "on-device" in the panel.
3. **Native depth.** Where GhostIDE already has a
   native version of a tool's job (slicing, verify,
   review), the goal deepens the native one to the
   tool's contract instead of bolting on a duplicate.

## Rules that carry over

- Every tool keeps its hard rule inside the IDE:
  GhostShard stays planner-only (no dispatch),
  GhostApprove stays queue-only (never executes on
  its own), GhostEnv shows names, never values,
  GhostExposure gives evidence, no verdicts,
  GhostDeps makes no network calls and no vuln
  verdicts, secrets are redacted wherever the tool
  redacts them.
- Integration is code-level only. No PyPI, no
  releases, no announcements for any tool; those
  stay Ryan-gated per tool, as before.
- Parity is the proof standard: a goal closes when
  the in-IDE output matches the tool's own CLI
  output on a fixture, byte- or verdict-equal.

## Arc 1 - The runner (foundation)

**E1. Ecosystem panel + tool runner.** BUILT
v1.51.0 (desktop proven 13/13 incl. CLI parity;
phone bundled, device proof Ryan's).
A Tools panel listing the ecosystem tools with
their state (bundled / found on desktop / absent),
and /api/eco/run to execute one against the current
workspace, its report rendered in-panel.
Done when: GhostIndex and GhostDeps run from the
panel on desktop and phone and their reports render.

**E2. The phone-safe bundle.** BUILT v1.52.0
(22 packages vendored, 2,469 tests green against
the vendored copies, foreground-verified).
Vendor the qualifying companions into the APK's
Python assets with a size audit, each labelled with
its own verified test count.
Done when: every bundled tool's own test suite
passes against the vendored copy pre-build, and the
panel lists the set as on-device.

## Arc 2 - Context crew

**E3. GhostIndex search.** BUILT v1.53.0
(POST /api/eco/search runs the tool itself;
parity harness 11/11 incl. deep-equal hits vs
the CLI's --json on the same db; index+search
0.67s on the fixture; phone bundled, device
proof Ryan's).
The search panel gains the real offline FTS5 index:
whole-workspace search returning token-budgeted,
sliced excerpts that open at the hit.
Done when: an index builds over a fixture tree in
seconds and query results match the CLI's excerpts.

**E4. GhostPrimer + GhostHandoff.** BUILT v1.54.0
(POST /api/eco/prime + /api/eco/handoff run the
tools themselves; E4 harness 16/16 incl. an
independent CLI check exit 0 on the IDE-built
bundle, CLI-equal handoff pack, and byte-identical
git state around the pack; phone bundled, device
proof Ryan's).
Chat actions: "Prime this project" builds a starter
bundle for a fresh session; "Draft handoff" writes a
propose-only handoff pack from repo facts.
Done when: a primer bundle made in the IDE passes
the real ghostslice check and opens a new chat as
its first context.

**E5. GhostRecall + GhostAtlas.** BUILT v1.55.0
(POST /api/eco/atlas + /api/eco/recall run the
tools themselves; E5 harness 21/21 incl. atlas
JSON deep-equal vs the CLI's scan and recall/scan
deep-equal vs the CLI's --json on a fixture git
project; the bundle gate grows to 25 packages,
2,642 tests green - recall 68, atlas 47, and
handoff 58, whose package the E4 build had left
out of eco.zip; phone bundled, device proof
Ryan's).
Repo map gains the Atlas view; chat context gains
Recall of prior slices and sessions for this
project, token-budgeted like everything else.
Done when: map and recall outputs match the tools'
CLI output on a fixture project.

**E6. GhostConvert export.** BUILT v1.56.0
(POST /api/eco/convert runs the tool itself on a
slice bundle GhostSlice itself exports into
.ghostide/slice; E6 harness ALL PASS - for each
target and for all, the IDE's exported tree is
byte-identical to the CLI's own convert output
incl. LOSSES.md, CLI verify exits 0 against the
IDE output, and the bundle's hashes are untouched
by a convert; bundle unchanged at 25 packages,
2,642 tests; phone bundled, device proof Ryan's).
From the Context lab: export the current slice as
AGENTS.md, Cursor rules, or Copilot instructions,
with conversion losses named per format.
Done when: all formats export from the IDE and
match the tool's output on a fixture slice.

## Arc 3 - Proof and review

**E7. GhostVerify evidence contract.**
The verify pipeline's report adopts Verify's
contract: what was executed, what was only claimed,
gaps named as gaps.
Done when: VERIFY_REPORT.md carries the contract
sections and a planted unexecuted claim reports as
a gap, never a pass. (GhostBench stays an explicit
opt-in run from the same panel.)

**E8. GhostReview in the Git panel.**
The pre-commit review runs Review's verdict layer
(REVIEW verdict + risk rules, secret-shaped lines
flagged with values never shown).
Done when: the panel verdict matches the CLI
verdict on the review fixture.

**E9. GhostScope + GhostExposure.**
Before commit: "what this change touches" (Scope)
and the exposure evidence pack, in the Git panel.
Done when: a fixture diff's scope lists the same
files and symbols as the CLI.

**E10. GhostApprove queue for agent mode.**
Agent actions with consequences (deletes, writes
outside the open file set, pushes) enqueue for
one-tap approve / deny; nothing executes from the
queue on its own.
Done when: an agent delete lands in the queue,
stays unexecuted while queued, and approving runs
exactly the queued action.

## Arc 4 - Ops inside the IDE

**E11. GhostEnv audit.**
Project health shows the .env audit: names only,
missing / extra vs .env.example, values never
rendered anywhere.
Done when: the fixture audit matches the CLI and a
planted secret value appears nowhere in the UI or
any exported report.

**E12. GhostDeps panel.**
Declared vs actually-imported dependencies for the
workspace, evidence only, no network.
Done when: panel output matches the CLI on the
mixed-language fixture.

**E13. GhostLogs in the Run pane.**
"Slice this log": error windows plus deduped
repeats become an incident pack, attachable to a
chat message ("explain this failure").
Done when: a planted 5,000-line log slices to the
same incident pack the CLI produces, redactions on.

**E14. GhostData + GhostSchema openers.**
CSV / TSV / JSON files open with schema + bounded
sample (sensitive columns redacted); OpenAPI files
open as an endpoint outline sliced by $ref
reachability.
Done when: fixture files render with the same
schema, sample, and redactions as the tools.

**E15. GhostWorktree.**
Create, switch, and remove git worktrees from the
Git panel, so the agent can work a second tree
while the main one stays untouched.
Done when: a worktree opens as a workspace, an
agent edit lands only there, and removal is clean.

**E16. GhostWatch + GhostReplay.**
A freshness feed (changes made outside the IDE
appear live) and session replay: a scrubbable
timeline of the session's edits and runs.
Done when: an external edit shows in the feed
within a second and a recorded session replays its
steps in order.

## Arc 5 - The board and the studio

**E17. GhostConsole board.**
A read-only board in the IDE aggregating every
ecosystem tool's latest report for this workspace
in Ryan's kanban form (Verified / Attention /
Stale), with GhostLedger (session token ledger)
and GhostMCP Doctor (read-only diagnostics) as
cards on it.
Done when: the board renders real report files
from a fixture workspace with the same states the
Console CLI reports.

**E18. GhostRecipes as packs.**
Recipes ship as .ghostpack template packs (the
G37 registry): install a recipe, get its scaffold
plus its checks wired as the project's verify
profile.
Done when: a recipe pack installs from the
registry shelf and the produced project passes its
own wired checks.

**E19. GhostLeads + QuoteShot (desktop-first).**
A studio panel in the desktop IDE: offline lead
drafts (drafts only, Ryan sends) and quote sheets
generated from the studio price book.
Done when: a quote sheet generates fully offline
from the price book and exports as a file.

**E20. Seatbelt policy for agent mode (capstone).**
Agent tool calls pass the released Agent Seatbelt
core policy (allow / deny / approve), with the
tamper-evident log viewable in the IDE.
Done when: a policy-denied action is blocked and
the log panel shows the entry. (Seatbelt's own
Phase 3-5 gates stay separate and Ryan's; this
goal uses the released 0.3.2 core only.)

**E21. GhostBus link (added Oct 20, 2026 at Ryan's
direction).**
A Bus panel in the IDE: post a task, watch claims,
read proof trails. Agent mode can hand a subtask
to another GhostIDE (desktop <-> phone) and take
the result back into the session. Local-first: the
bus runs between Ryan's own devices on the LAN or
on one device; the hosted relay is a later upgrade
behind the existing pilot gate (Ryan's Hetzner
signup; the ~$5/mo budget approved Oct 11, 2026
stands, no spend without his go). Bus traffic
obeys the same rules as everything else here:
handoffs with consequences pass the E10 approve
queue and the E20 Seatbelt policy, and GhostShard's
rule stands - planning may ride the bus, nothing
dispatches itself.
Done when: a task posted from one GhostIDE is
claimed by the other, executed, and its proof
trail reads back in the posting IDE, entirely on
local transport.

## Deliberately not in this roadmap

- GhostProxy: a live-traffic proxy breaks the
  offline promise; wrong shape for this app.
- GhostPort: a one-shot migration CLI by nature;
  it stays a CLI.
- GhostDocs: already covered natively (docs mode,
  offline reference docs).
- GhostFixture: folds into E18 (recipes produce
  fixture-faithful projects).
- GhostShard: its planning already informs agent
  mode's design; dispatch stays forbidden by its
  own rule, so there is nothing to integrate.
- GhostDeploy, Ghost Bridge, GhostLang, GhostCut,
  GhostChat, GhostOS: separate products with their
  own surfaces and gates, not IDE features.
  (GhostBus was on this list in the first draft;
  Ryan directed it in as E21 - the IDE's agent is a
  natural bus citizen, local-first.)

# GhostIDE — 20 Long Goals

Set Oct 19, 2026, after v1.10.0. Same shape as the GhostSlice
marathon: twenty substantial goals, worked in order inside an
arc, each closed only when its "done when" is proven — on
Ryan's phone wherever the goal touches the phone.

Standing constraints: stdlib/framework-first builds, no paid
spend without Ryan's approval, the DOM-stub gate on every APK,
and the ~Nov 2, 2026 real-use checkpoint — if GhostIDE is not
earning real work by then, this roadmap gets re-ranked, not
blindly continued.

## Arc A — Intelligence (the IDE understands the code)

**G1. Workspace symbol index.** ✅ CLOSED Oct 19, 2026 (v1.11.0) — two-pass index on both servers, fixture-exact, 500-file cold build 1.18 s. A persistent index of every
definition (functions, classes, methods, constants) across the
workspace, built on open and kept fresh on save. Go to
definition and Find All References answer from the index, not
from text search.
Done when: definition jumps land correctly in a multi-file
test project, references list is complete, index rebuild on a
500-file workspace stays under a couple of seconds.

**G2. Repo map for Ghost.** ✅ CLOSED Oct 19, 2026 (v1.12.0) — ranked map endpoint on both servers, chat attach + settings toggle, map-only Q&A proven on the desktop model. A ranked map of the whole project
(most-referenced symbols and files first, Aider-style) that
chat attaches automatically inside the token budget, so Ghost
knows the project shape without being fed files one by one.
Done when: a cold chat question about an unopened file's role
gets a correct answer using only the map, on the 1.5B.

**G3. Refactoring engine.** ✅ CLOSED Oct 19, 2026 (v1.13.0) — four ops, diff-previewed, behavior-identical round-trips on fixtures. Extract function, extract
variable, inline, and move-file-with-import-fixups for
Python and JavaScript — AST-backed on desktop, conservative
heuristics on the phone, always previewed as a diff before
applying.
Done when: each refactor round-trips a fixture project with
its checks still passing, and a bad refactor can be undone
in one tap (Local History covers the files).

**G4. GhostSlice v2 context.** ✅ CLOSED Oct 19, 2026 (v1.14.0) — dependency-aware smart slices on both builds; benchmark 0/3 (file) vs 3/3 substantive (smart). Slices become dependency-aware:
pick a file and its import graph, call graph neighbors, and
tests come along inside the budget, ranked, with the meter
explaining what was included and what was cut.
Done when: on the agreed benchmark project, v2 answers beat
v1 answers on a fixed question set at the same token budget.

## Arc B — Agent (Ghost does the work, you approve)

**G5. Agent mode.** ✅ CLOSED Oct 19, 2026 (v1.15.0) — staged-write agent loop with per-file review; full live run proven (6 steps, exact math); on-phone run is Ryan's device test. Chat gains a multi-step mode: Ghost
plans, edits several files, runs checks, and queues every
change as a reviewable diff — approve per file or reject
all. Hard stop conditions, step cap, and a visible plan.
Done when: a real three-file feature request completes
end-to-end on the phone with every change reviewable before
it lands, and a mid-run Stop leaves the workspace clean.

**G6. Test runner panel.** ✅ CLOSED Oct 19, 2026 (v1.16.0) — discovery + per-test results on desktop, fixture-exact failures in Python and Node; run-on-save included. Discover pytest/unittest and
node tests, run all or one file, per-test pass/fail list,
tap a failure to jump to it, optional run-on-save.
Done when: the panel runs a fixture suite with known
failures and reports exactly those, on desktop; phone gets
run-on-PC results over LAN.

**G7. Debugger (desktop first).** Breakpoints in the
gutter, step over/into/out, continue, and a variables pane,
driven by a stdlib pdb-based bridge for Python.
Done when: a fixture bug is found by stepping, not by
reading, in a recorded session.

**G8. Self-fixing loop.** ✅ CLOSED Oct 19, 2026 (v1.18.0) — red fixture suite turned green in one agent round with no human edits; revert-on-worse and Undo-all in place. When a run or check fails, Ghost
gets the error, proposes a fix as a diff, applies on
approval, and re-runs — at most three rounds, then it
reports honestly and stops.
Done when: the loop fixes a planted bug unaided and
correctly gives up on an unfixable one.

## Arc C — Phone power (the phone stops being the thin one)

**G9. Run code on the phone.** Python and JavaScript
execute on-device (bundled runtime in the APK), so Run,
inline results, and snippet tests work with no PC nearby.
Done when: the playground projects run on Ryan's phone
offline, with output, errors, and a working Stop.

**G10. Real terminal in the app.** A shell pane with a
native pty, workspace as home, the tools the runtime
allows (ls, grep, the bundled interpreters).
Done when: Ryan can grep the workspace and run a script
from the terminal pane without leaving GhostIDE.

**G11. Full git on the phone.** Init, status, add, commit,
log, diff, and branch in-app with no PC and no external
git — enough of the object model implemented or bundled
to be honest git, interoperable with desktop clones.
Done when: a repo created on the phone clones cleanly on
the desktop and vice versa.

**G12. Model store.** 🔶 BUILT Oct 19, 2026 (v1.22.0), device proof pending — 4-model curated catalog with verified downloads + delete-to-reclaim; closes when a second model downloads and runs on Ryan's phone. More brains in the manager: a
curated GGUF list (sizes for different RAM), verified
downloads like the current two, per-model speed/context
notes measured on device, and a safe auto-pick by free
RAM.
Done when: a third model installs, verifies, loads, and
chats from the manager with no manual steps.

**G13. Voice coding.** 🔶 BUILT Oct 19, 2026 (v1.23.0), device proof pending — recognizer bridge + spoken commands; closes when Ryan dictates a prompt and says "save file" on his phone. On-device speech-to-text (small
whisper-class model): dictate chat prompts and code
comments, plus a handful of voice commands (save, run,
open file).
Done when: a dictated prompt produces a correct edit on
the phone, fully offline.

## Arc D — Platform (other people could use this)

**G14. Project templates.** ✅ CLOSED Oct 19, 2026 (v1.24.0) — six templates created through the real file API on desktop and run/test-verified; phone uses the identical path. New-project wizard: Python
CLI, static web app, API server, tiny game, and a blank
GhostIDE plugin — each scaffolded runnable, with a README
that tells the truth about how to run it.
Done when: every template creates, opens, and runs (or
previews) with zero fixes.

**G15. Plugin system.** 🔶 BUILT Oct 19, 2026 (v1.25.0), device proof pending — sandboxed iframe plugins + ghost API + samples, desktop-verified; closes when both samples install and run on Ryan's phone. Third-party tools as small JS
bundles: a plugin adds Tools-panel actions and panels
through a sandboxed API (read/write files, call Ghost,
show UI), installed from a folder, removable cleanly.
Done when: two sample plugins (word count pro, JSON
toolbox) install and run on the phone.

**G16. Pair mode.** 🔶 BUILT Oct 19, 2026 (v1.26.0), device proof pending — presence + hash-guarded conflict-safe sync, proven by live two-client simulation; closes when Ryan runs one phone+desktop session with no lost work. Two devices, one workspace, over LAN:
presence, shared view of who is editing what, and
conflict-safe sync that merges by file instead of
overwriting silently.
Done when: Ryan edits the same project from phone and
desktop in one session with no lost work.

**G17. Optional encrypted backup.** 🔶 BUILT Oct 19, 2026 (v1.27.0), device proof pending — cross-implementation format proven both directions + byte-identical wipe/restore on desktop; closes when Ryan restores a backup on his phone. Arc D complete pending device proofs. Off by default:
workspaces back up end-to-end-encrypted to storage the
user picks (their Drive, a WebDAV server), restorable on
a new device.
Done when: a workspace wiped on one device restores
byte-identical on another.

## Arc E — Ship (from Ryan's tool to a product)

**G18. Desktop apps.** 🔶 BUILT Oct 19, 2026 (v1.28.0) — Linux package proven end to end from a clean HOME (install, seeded workspace, bundled llama + 7B answered); Windows/Mac scripted + Actions workflow, first builds pending on those OSes. GhostIDE packaged for Windows,
Mac, and Linux with the 7B model as an optional
in-app download, one-command install, and an update
check that never auto-installs.
Done when: a clean machine installs and runs it from
the package alone.

**G19. Store launch.** 🔶 PREPARED Oct 19, 2026 — production key + signed AAB + tester universal APK built and verified, privacy policy and listing drafted; closes when Ryan funds the Play account, hosts the policy, adds real screenshots, and a tester installs from the closed track. Production signing key handled
properly, privacy policy, listing with REAL screenshots
from Ryan's phone, closed testing track first, staged
rollout decision stays Ryan's, as does the $25 fee.
Done when: the closed track build is installable by a
tester who is not Ryan.

**G20. The story.** Studio site page goes live (draft
already written), a 60–90 second real-use film, launch
posts drafted for Ryan's approval, README and docs
brought up to what the app actually does.
Done when: a stranger can find GhostIDE, understand it
in a minute, and install it — and the Nov 2 real-use
verdict is written into the plan either way.

## Order

A (G1–G4) builds the brain, B (G5–G8) spends it, C
(G9–G13) frees the phone, D (G14–G17) opens the platform,
E (G18–G20) ships it. Arcs can interleave when Ryan says
so; goals close in order inside an arc.

---

# The Second Twenty (G21–G40)

Added Oct 19, 2026 at Ryan's "Another 20". Same rules:
a goal closes only when its "done when" is proven.

## Arc F — Toolbox depth

**G21. Language packs.** First-class support beyond
Python/JS: HTML, CSS, JSON, Markdown, SQL, Rust, and Go —
highlighting, checkers where a checker can run, run
configs, and file icons that tell them apart.
Done when: a mixed-language fixture project opens with
every file highlighted, checkable, and runnable where a
runtime exists.

**G22. SQLite studio.** Open a .db/.sqlite file and get
tables, schemas, and a query box with results as a grid —
read-only by default, edits behind an explicit toggle.
Done when: Ryan can inspect a real app database on the
phone and run a SELECT that returns the right rows.

**G23. API client.** A Postman-lite pane: save requests
per project (method, URL, headers, body), send, inspect
status/headers/JSON, keep a history. Localhost-first —
it pairs with the projects GhostIDE builds.
Done when: a local dev server's endpoints can be
exercised end-to-end without leaving the app.

**G24. Docs mode.** Markdown gets a live preview pane,
Mermaid diagrams render, and a folder of docs exports
to a single static HTML site.
Done when: this roadmap previews correctly and exports
to a page that opens standalone.

**G25. Asset tools.** An asset browser for images in the
workspace (thumbnails, dimensions, size), plus an icon
maker: text or simple shapes to a PNG icon set at the
sizes Android and the web want.
Done when: a project gets a full icon set generated
in-app and the asset browser finds a heavy image by size.

## Arc G — Smarter Ghost

**G26. Pre-commit AI review.** Before you commit, Ghost
reviews the diff and leaves anchored comments (bug risk,
dead code, secrets about to leak), each dismissible.
Done when: the reviewer catches a planted secret and a
planted bug in a fixture diff, and stays quiet on a
clean one.

**G27. Context lab.** See what Ghost sees: a token
heatmap over the workspace, per-file cost, and a
what-if comparison of slice settings before you ask.
Done when: the lab's numbers match GhostSlice's own
counts on a benchmark tree.

**G28. Offline reference docs.** Bundled, searchable
slices of the Python and JavaScript references; Ghost
can pull the exact doc page for an API into context
instead of guessing at it.
Done when: an API question gets answered from the bundled
docs with the phone in airplane mode.

**G29. Semantic code search.** "Find the code that
retries failed downloads" — natural-language search
over the workspace using on-device embeddings, ranked
alongside plain text search.
Done when: on a fixture project, the right function is
top-3 for plain-English queries that share no words
with it.

**G30. Error memory.** Every error and the fix that
cleared it are remembered locally; when the same error
recurs, Ghost opens with "last time, this fixed it."
Done when: a repeated error in a new file surfaces the
old fix before any new guessing.

## Arc H — Craft

**G31. Macros and multi-cursor pack.** Record a sequence
of edits and replay it on the next ten files; column
selection and add-cursor shortcuts to match.
Done when: a recorded cleanup macro runs across a
fixture folder and every file checks clean after.

**G32. Verify pipeline.** One tap runs the project's
whole health pass — syntax check-all, tests, slice
report, evidence level — and produces a shareable
report file (GhostConsole, inside the IDE).
Done when: the pipeline's report on a fixture project
matches what the individual tools say, run separately.

**G33. Big-screen mode.** Tablet and desktop-class
layout: three panes, drag-resize, second-screen/DeX
friendly, hardware-keyboard shortcut map on screen
when a keyboard pairs.
Done when: the layout holds up on a tablet emulator
profile and a folded/unfolded phone.

**G34. App-state carry.** Export/import everything that
is yours in the app — settings, snippets, bookmarks,
chat histories, local-history — as one file, so a new
phone becomes your phone in a minute.
Done when: a wiped install restores its snippets and
settings from the export, verified field by field.

**G35. Companion touches.** Long AI jobs ping you when
they finish (notification, not a dead screen), and the
Android share sheet can send text or a link straight
into a workspace file ("capture to project").
Done when: a shared note lands in the workspace from
another app in two taps.

## Arc I — Reach

**G36. Language and access pass.** The UI translated
(Spanish first), full screen-reader pass, larger-text
and one-handed modes as real settings, not afterthoughts.
Done when: the whole IDE is usable with TalkBack on and
the primary flows complete in Spanish.

**G37. Registry.** Templates and plugins (G14/G15) get a
browse-and-install registry with signed packages and
one-tap uninstall; Ghost Developer Studio curates the
first shelf.
Done when: a plugin published from the desktop installs
on the phone from the registry and verifies its
signature.

**G38. Classroom view.** Share a read-only live view of
your session on the LAN — a student or a helper watches
the code and the chat, can annotate, cannot edit.
Done when: a second device follows a live edit session
with under a second of lag on local Wi-Fi.

**G39. First-run that teaches.** A 3-minute interactive
tour inside a sample project that makes the user run,
break, fix-with-Ghost, and restore from history — the
IDE teaches itself by doing.
Done when: a tester who has never seen GhostIDE
completes the tour unaided and can repeat the four
moves an hour later.

**G40. 1.0 hardening.** The boring excellence goal:
crash budget (zero known startup crashers), cold start
under a second to editor, generation thermal guard,
in-app changelog, and an update check that informs
without nagging.
Done when: a week of Ryan's real use logs no crash and
the budgets above hold on his phone.

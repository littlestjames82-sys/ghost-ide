# GhostIDE - Project Plan (v2, expanded)
*Ghost Developer Studio - Oct 19, 2026*

## The product in one line
A code editor with a real AI brain that runs **entirely offline** -
chat, code generation, and autocomplete from a local model, on
desktop and on the phone in your pocket. No cloud, no API key, no
subscription, code never leaves the device.

## Where we stand (built, Oct 19, 2026)
| Piece | State |
|---|---|
| Desktop model: Qwen2.5-Coder-7B-Instruct Q4_K_M | Downloaded, hash-verified vs Hugging Face, load-tested (chat + code + infill) |
| Phone model: Qwen2.5-Coder-1.5B-Instruct Q4_K_M | Downloaded, hash-verified, load-tested on desktop engine (13.3 tok/s, infill stops exactly at suffix) |
| GhostIDE web app (desktop) | v0.1 built + API-verified end to end with the real 7B |
| GhostIDE Android app | v1.0.0 APK built, signed, contents verified (3.18 MB, com.ghostide.app); engine reused from the proven MrGhosty on-device build |
| Aspire/LAN pack for desktop version | Bundle zip + start-lan.bat + RUN-ON-PHONE.md ready |

---

## GATE 0 - Device proof (Ryan's session, ~15-20 min)
Everything else is sized by what this session reports. Do it in
order; note the answers as you go (a voice note or screenshots are
fine - Muse turns them into Phase 1 work items).

### The script
1. **Install.** Open the APK link, install. Note: any Play Protect
   prompt wording (screenshot if it blocks).
2. **Model download.** Open the app, start the 940 MB download on
   WiFi. Time it roughly. Does the progress bar move smoothly? Does
   leaving and returning to the app keep it going?
3. **Model load.** After download, time from "Loading the model"
   to the IDE appearing. Target: under 2 minutes. Over 4 = problem.
4. **First chat.** Ask: "Write a function that sorts a list of
   names." Time to first words appearing (target: under 30 s) and
   total time. Quality: usable / rough / nonsense.
5. **Edit loop.** Open fib.py, change something, save (the ✓ in
   Save state), close and reopen the app - is the change still
   there?
6. **Autocomplete.** In fib.py, delete the `pass` line's text, put
   the cursor there, type `if n <= 1:` slowly and pause. Does a
   grey suggestion appear? How long did it take? Could you accept
   it (Tab key present on your keyboard?) - if not, that's the
   confirmed #1 fix for v1.1.
7. **Heat + battery.** After ~10 min of use: is the phone hot?
   Battery drop roughly how much?
8. **Rotation + keyboard.** Rotate the phone; open/close the
   keyboard a few times. Any layout breakage or lost text?

### Pass / redirect thresholds
- **Pass:** model loads, chat answers readably, edit/save persists,
  no crash in 15 min. -> Proceed to Phase 1 (or 2, per decision 1).
- **Slow but works** (chat >60 s for a short answer): Phase 1 gets
  a performance workstream first (threads, ctx 2048, shorter
  default replies) before any features.
- **Broken** (crash, model won't load, libs error): Muse debugs
  from the exact screen text - do not reinstall repeatedly; the
  error message is the diagnostic.

---

## Phase 1 - Phone v1.1: real-use fixes
*Entry: Gate 0 report. Exit: Ryan completes a real coding session
on the phone with no workarounds. Sizes: S = part of a session,
M = one build session, L = several.*

| # | Item | Size | Acceptance |
|---|---|---|---|
| 1.1 | Tap-to-accept ghost text: tapping the grey suggestion inserts it (widget stops ignoring events; also add an "Accept" chip above the keyboard) | M | Suggestion accepted by tap in the fib.py test |
| 1.2 | Keyboard pass: editor scrolls to cursor when keyboard opens; chat input stays visible; no lost text on rotation | S | Gate 0 steps 7-8 re-run clean |
| 1.3 | Perf tuning from Gate 0 numbers: engine threads = phone core count detection, ctx 4096 -> 3072 if load is slow, infill max tokens 64 -> 48, chat default max tokens visible in settings | M | Chat first-token and infill latency measurably better than Gate 0 baseline |
| 1.4 | Import/export: Android share sheet + document picker in/out of the app workspace (files are app-private today) | M | Import a .py from Downloads, edit, export it back out |
| 1.5 | New-folder + rename + delete in the file panel (create exists; rename/delete don't) | S | Full file lifecycle without leaving the app |
| 1.6 | Settings screen: temperature, context size, model info, "reduce motion/battery" toggle that lowers threads | S | Settings persist across restarts |
| 1.7 | Crash safety: autosave draft of the open file every 10 s, restore offer on relaunch | S | Kill the app mid-edit; relaunch offers the draft |

Explicitly NOT in Phase 1: bigger model (needs Gate 0 RAM/heat
data first), Play Store anything, accounts, sync.

## Phase 2 - Desktop IDE hardening - SHIPPED Oct 19, 2026 (desktop v0.2 + phone v1.2.0)
Status per item: 2.1 DONE (workspace switcher + recents; ghostslice's 418 files browsed live). 2.2 DONE (GhostSlice export as chat context; ghostslice repo 569,792 tok -> 5,939 signatures in 2.5 s; live meter + over-budget hard-stop). 2.3 DONE (run panel .py/.js/.sh, 20 s timeout, unsandboxed note in UI). 2.4 DONE (status/stage/diff/commit; real commit made through the API in tests). 2.5 DONE (tabs + find/replace in Phase 2; split view shipped in Phase 6 / v1.5.0 - split pane is a plain editor, autocomplete stays in the main pane, undo resets when a file changes panes). 2.6 PARTIAL: format-on-save hook DONE (black/ruff/prettier if installed; honest no-formatter reply otherwise); no minimap exists in the app, bracket matching ships with the editor core.
*Entry: none (can run parallel to Phase 1 if desktop-first).
Exit: a real studio task gets done start-to-finish in GhostIDE.*

| # | Item | Size | Notes / acceptance |
|---|---|---|---|
| 2.1 | Open any folder: workspace picker + recent list; playground stops being hard-coded | M | Open ~/workspace/ghostslice and browse it |
| 2.2 | GhostSlice context packer for chat: "Include context" panel - current file, open files, or a Slice bundle (signatures mode) with a live token meter against the model's ctx; hard-stop with an honest warning when over budget | L | Chat about a 30-file project without blowing the 8k ctx; meter matches GhostSlice's own estimator |
| 2.3 | Run panel: Run button for .py/.js using the system interpreter, output pane, timeout + kill; runs are local and unsandboxed (it's your machine, your code - stated plainly in UI) | M | Run todo.js and fib.py from the IDE, see output |
| 2.4 | Git basics: status dots in file tree, diff view for the open file, stage + commit box | M | Make a real commit in a scratch repo from the IDE |
| 2.5 | Tabs + split view; find/replace across files | M | Two files side by side; project-wide rename of a function |
| 2.6 | Editor polish: minimap off by default on small screens, bracket colorization, format-on-save hook (external formatter if present) | S | - |

Design note for 2.2: GhostSlice already emits exactly the bundle
shape chat needs (`.claude_context` export with manifest + token
estimates, signatures mode cuts GhostBus 129,555 -> 45,770 tokens).
GhostIDE calls it as a library/subprocess; the IDE does not grow a
second context engine. This is the ecosystem compounding: Slice
feeds IDE chat the way Bench feeds Console.

## Phase 3 - One product, two sizes - SHIPPED Oct 19, 2026 (phone v1.3.0 + desktop v0.3)
3.1 DONE both apps (3B file hash-verified bit-exact + inference-proven on desktop llama.cpp; phone load of the 3B is Ryan's first-run test). 3.2 DONE (web/src/behavior.js + BEHAVIOR.md). 3.3 DONE (LAN sync both directions, escape-tested). 3.4 DONE (per-workspace chat history).
*Entry: Phases 1+2 stable. Exit: same project, same feel, both
devices, model sized to the hardware.*

Model matrix (all Qwen2.5-Coder-Instruct, Q4_K_M):
| Device class | Model | Download | RAM need | Expected feel |
|---|---|---|---|---|
| Most phones | 1.5B | 0.94 GB | ~1.5 GB | Autocomplete + small functions (current) |
| Strong phones (8 GB+) | 3B | 1.93 GB | ~2.6 GB | Better multi-step answers; Gate 0 phone decides if offered |
| Desktop/laptop | 7B | 4.68 GB | ~5 GB | The reference experience (current) |
| Future desktop (16 GB+ GPU) | 14B/32B | 9-19 GB | varies | Only if the studio hardware gets there |

Work items:
- 3.1 Model manager (both apps): list, download, switch, delete;
  per-model exact-size + SHA256 gates like the current one (M)
- 3.2 Shared behavior pack: same system prompts, same infill
  cut-markers, same defaults - one prompts file both apps ship (S)
- 3.3 LAN sync (optional, off by default): when phone and PC are
  on the same WiFi, one-tap "send workspace to PC / pull from PC"
  over the desktop server's API; no cloud, no accounts (M)
- 3.4 Session continuity: chat history saved per project folder
  on both apps (S)

## Phase 4 - Ship it as a studio product - BUILD SIDE DONE Oct 19, 2026
Repos pushed (ghost-ide b6d3d5d9, ghostide-android 8a175fc9, read-back diffs EMPTY, code push only). KNOWN_ISSUES.md seeded; READMEs updated; site page DRAFT built (~/workspace/your_files/ghostide-site-page-draft.html) and NOT deployed (draft-first). Still Ryan-gated: screenshots from real use (no mockups rule), the 60-90 s demo film (needs his screen capture), distribution decision (Play Store $25 is his call), pricing (default free stands), and deploying the site page.
*Entry: Ryan's explicit go, per product, per channel - nothing
here is pre-approved. Exit: a stranger can discover, install, and
use GhostIDE without Ryan in the loop.*

Sequenced checklist:
1. Repos: `ghost-ide` (web + desktop server) and the Android app
   source -> GitHub under littlestjames82-sys, code push only
   (standing rule). Tags/releases separately gated.
2. README + screenshots from real use (Gate 0 / Phase 1 sessions)
   - no mockups.
3. Studio site: product page; the pitch is the true one -
   "Your code never leaves the device. The AI lives here."
4. Demo film: 60-90 s screen capture, phone + desktop, offline
   mode visibly ON (airplane mode shot is the proof).
5. Distribution decision (Ryan): GitHub releases sideload vs
   Play Store ($25 dev account, review overhead) vs both.
6. Pricing decision (Ryan): default free (studio marketing +
   goodwill) vs paid Pro (model manager + sync as the paid line).
   No decision needed until 1-4 exist.
7. Support surface: issues on GitHub; a known-issues page seeded
   with the honest limits (small model strength, Tab key, WebView
   file-size lag).

## Timeline shape (build sessions, not calendar promises)
- Gate 0: one Ryan session (~20 min) whenever the APK gets tried.
- Phase 1: ~2-3 build sessions after the Gate 0 report.
- Phase 2: ~3-4 build sessions (2.2 is the big one).
- Phase 3: ~2 build sessions.
- Phase 4: mostly Ryan-gated publishing steps; build side ~1-2.
Total to a shippable public product: roughly 8-11 build sessions
plus Ryan's gate taps. Cost so far and projected: $0 (all local,
all open models; only optional spend in the whole plan is the
Play Store dev fee, Phase 4, Ryan's call).

## Phase 5 - Tools pack - SHIPPED Oct 19, 2026 (phone v1.4.0 + desktop)
Added at Ryan's "load up this ide with tools": 🧰 Tools panel (AI quick actions: Explain / Fix / Tests / Docstrings over selection or file), Preview (markdown + images), syntax Check, Duplicate file, Snippets, TODO/FIXME scanner, Project stats, Save-slice-as-file, and a desktop Terminal pane. Native on Android where possible (todos/stats/raw); terminal + syntax check are desktop features and say so on the phone. All desktop endpoints live-tested.

## Phase 6 - Roadmap round - SHIPPED Oct 19, 2026 (phone v1.5.0 + desktop)
Split view (2.5 completed), Quick Open (Ctrl+K), Outline, Go to line, chat Stop + Clear, settings for wrap / text size / short-answers (battery) / autocomplete pause, status bar doc stats, 200 KB big-file warning, file menu Copy path / Download / Open in split. Frontend-only round: no new endpoints.

## Phase 7 - Editor + app round - SHIPPED Oct 19, 2026 (phone v1.6.0 + desktop)
Editor: find-in-file, fold/unfold all, text transforms (sort/dedupe/trim/case), quick-open recents, git log panel, workspace zip download, chat Regenerate + Export-as-file. App: native Share file via a containment-checked read-only ContentProvider. Desktop endpoints (git log, export-zip) live-tested.

## Phase 8 - VS Code / Cursor round - SHIPPED Oct 19, 2026 (phone v1.7.0 + desktop)
Command palette (27 commands), VS Code keymap pack (comment toggle, move/copy/delete line, select next occurrence), autosave + trim-on-save, Cursor-style inline AI edit with review/apply, Problems panel (check returns line+message), TODO status chip, AI commit message from the diff. Preceded by two hotfixes: v1.6.1 (wrapComp TDZ startup death) and v1.6.2 (missing WebChromeClient dialog bridge). DOM-stub evaluation gate now stands before every APK.

## Phase 9 - More VS Code / Cursor - SHIPPED Oct 19, 2026 (phone v1.8.0 + desktop)
Fixed the latent quick-open mapping bug (files objects vs strings - Quick Open/split/palette lists were silently empty since Phase 6). Added: collapsible folder tree, Go to Symbol, chat @file mentions + selection attach, Focus mode, indent/whitespace settings, Bookmarks, Fix-with-AI in Problems, quiet problems chip.

## Phase 10 - Round ten - SHIPPED Oct 19, 2026 (phone v1.9.0 + desktop)
Breadcrumbs, explorer filter, session restore (tabs reopen on launch), reopen closed tab, Rename symbol (new /api/rename-symbol on both servers, live-verified), Go to definition (heuristic), Copy contents, check-on-open, Write-code-from-comment.

## Phase 11 - Round eleven - SHIPPED Oct 19, 2026 (phone v1.10.0 + desktop)
Local History on both servers (snapshot-on-save, self-undoing restore), project-wide Problems check, git blame in breadcrumbs, per-file Revert, status-bar branch chip, tabstop snippets. All desktop endpoints live-verified.

## Phase 12 - Roadmap G1 - SHIPPED Oct 19, 2026 (phone v1.11.0 + desktop)
Workspace symbol index on both servers: definitions + references from a cached two-pass index; Go to Symbol is workspace-wide. Ryan directed: after G1, build the rest.

## Phase 13 - Roadmap G2+G3 - SHIPPED Oct 19, 2026 (v1.12.0, v1.13.0)
G2 repo map + G3 refactoring engine closed per ROADMAP_20. Marathon continues at G4.

## Phase 14 - Roadmap G4 - SHIPPED Oct 19, 2026 (phone v1.14.0 + desktop)
Smart (dependency-aware) context mode on both builds, benchmark-proven. Next: G5 agent mode.

## Phase 15 - Roadmap G5 - SHIPPED Oct 19, 2026 (phone v1.15.0 + desktop)
Agent mode: staged multi-file edits with per-file approval. Next: G6 test runner.

## Phase 16 - Roadmap G6 - SHIPPED Oct 19, 2026 (phone v1.16.0 + desktop)
Test runner panel with per-test results and jump-to-failure. Next: G7 debugger.

## Phase 17 - Roadmap G7 - SHIPPED Oct 19, 2026 (phone v1.17.0 + desktop)
Debugger: gutter breakpoints, pdb bridge sessions, variables pane. Next: G8 self-fixing loop.

## Phase 18 - Roadmap G8 - SHIPPED Oct 19, 2026 (phone v1.18.0 + desktop)
Self-fixing test loop: agent repairs against the suite, 3 rounds, revert-on-worse. Arc B complete. Next: G9 on-device run.

## Phase 19 - Roadmap G9 - BUILT Oct 19, 2026 (phone v1.19.0), device proof pending
On-device Python run + real Python check. Next: G10 terminal.

## Phase 20 - Roadmap G10 - SHIPPED Oct 19, 2026 (phone v1.20.0 + desktop)
Persistent terminal sessions + Python REPL pane. Next: G11 full git on phone.

## Risk register
| Risk | Likelihood | Mitigation |
|---|---|---|
| On-device engine misbehaves on Ryan's specific phone (driver/ROM quirks) | Medium | Gate 0 first; error screens show the native error verbatim for diagnosis; MrGhosty stack already ran this exact bridge design |
| 1.5B too weak to feel useful | Medium | Judge in Gate 0 by real tasks, not vibes; 3B option is Phase 3.1, pull forward if Gate 0 says "works but dumb" |
| Phone heat/throttle in long sessions | Medium | 1.3/1.6 perf + battery settings; shorter default generations |
| WebView editor lags on big files | Low-Med | Cap + warn at ~200 KB files in Phase 1 if observed |
| Scope creep into "full VS Code" | High | This plan's phase exits are the fence; new ideas go to a Later list, not into the current phase |
| Desktop + phone drift apart | Low | 3.2 shared behavior pack; one frontend bundle for both (already true) |

## Kill / pivot criteria (decided now, not mid-build)
- If Gate 0 shows the phone can't hold the model comfortably
  (load fails or chat unusably slow after Phase 1 tuning): phone
  becomes a thin client again (the LAN wrapper already designed)
  and desktop takes priority. No sunk-cost arguing.
- If Ryan doesn't reach for GhostIDE for real work within two
  weeks of Phase 2 (desktop) landing: pause features, write down
  why in one paragraph, and let the studio roadmap re-rank it
  against paying work. Tools that don't get used don't get phases.

## Decision log
| # | Decision | Default if unanswered | Status |
|---|---|---|---|
| 1 | After Gate 0: phone-first or desktop-first? | Phone-first (the phone is the unproven half) | OPEN - options sent Oct 19 |
| 2 | Personal tool first vs public product from the start? | Personal tool; Phase 4 converts later | OPEN |
| 3 | GitHub push now vs after Gate 0? | After Gate 0 (avoid pushing an IDE whose phone half is unproven) | OPEN |

## How we'll know it's working (metrics, honestly small-scale)
- Gate 0 answers exist (the first metric is knowledge, not users)
- Ryan's own usage: sessions per week in GhostIDE vs other editors
- Time-to-first-token and infill latency, phone vs Gate 0 baseline
- Phase 4 only: GitHub stars/downloads are vanity; the metric is
  install -> model download completed -> second-day open

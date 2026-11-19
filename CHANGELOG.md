# Changelog

GhostIDE desktop and Android ship on one version train. The
in-app changelog (Settings, then About) carries the full
191-entry history; this file covers the current run.

## 3.25.0 — Nov 18, 2026 — On-device supervision

- Agent runs on the phone are now supervised: the run
  writes its task record as it goes (created at start,
  updated at step boundaries and approval waits) and
  saves a resumable context beside it on the checkpoint
  rails.
- A run the app loses (closed, or Android stops it) is
  shown in the Tasks panel as Interrupted with its last
  update time, and offers Resume: a new segment briefed
  from the record's summary, never a replay, counting
  against the same per-task step budget. A missing or
  damaged context is refused by name.
- When a run waits for an approval while the app is in
  the background, a notification names the task and the
  waiting approval (no commands, no file contents);
  tapping it opens the app at the pending approval,
  decided by the same in-app buttons as always.
- A foreground service runs while a run is active, and
  the copy says plainly that no run is promised to
  survive the app being killed: resume is the answer.
  Desktop runs are unchanged.

## 3.24.0 — Nov 18, 2026 — Portable task format

- One record format for agent work on both platforms:
  ghostide.task, defined in docs/TASK_FORMAT.md and
  validated strictly and identically by the desktop and
  phone servers. Every agent or plan run now leaves a
  task record beside its run record, written by the same
  code from the same run.
- Records carry the goal, the status, the step budget in
  force, the approvals summary, the step summary and the
  checkpoint link. A record written by a newer format
  version is refused by name, never mangled.
- Export is the record itself, one JSON file. Importing
  on the other platform changes only the id, and keeps
  the mapping in the record's provenance.
- A Tasks panel (Tools, Task records) lists, views,
  exports and imports the workspace's records, and says
  plainly that a record is data: resuming a run from a
  record arrives with supervision (M2).

## 3.23.0 — Nov 18, 2026 — Voice-to-prompt

- The chat composer's mic now dictates into the prompt
  box itself: words appear while you speak, and the
  finished transcript lands as ordinary text you edit
  and send yourself. Voice never sends a message, runs
  the agent, or acts as a command in the composer.
- A status line under the composer says which
  recognition is in use: the on-device recogniser
  (Android 12 and up, where the phone offers one), or
  the system speech service, which may use the network.
  It also names every way a session can end, including
  microphone permission off, with the Settings path to
  grant it.
- Cleanup is light: whitespace tidied, a missing space
  after a full stop restored. Words are never
  rewritten.
- The editor's dictation button keeps the older
  behaviour, spoken commands included.

## 3.22.0 — Nov 18, 2026 — Phone model guards

- The phone's model store now reads the device it is on:
  real RAM and free storage on the store and download
  screens, a fit mark per model, and a recommended model
  that is the largest one fitting this phone's RAM. The
  first-run default follows it (the 1.5B on a 4 GB phone,
  the 3B on 6 GB and up), never the 7B; an install that
  already has a model keeps it.
- The 7B stays in the store with a plain caution: "Large
  for a phone: expect heat and fast battery drain."
- Before a model download starts, and before the 7B
  loads, a hot phone or a low, unplugged battery draws a
  warning with a go-ahead choice. Nothing is blocked.
- Agent runs on the phone default to 25 steps instead
  of 50; a budget picked in Chat options wins on both
  platforms. The web model store panel on the phone now
  points at the native store instead of showing an error.

## 3.21.0 — Nov 18, 2026 — Git phone pack

- GitHub tokens now live in the Android Keystore: encrypted,
  never readable back by the app, never written to a repo
  config, a remote URL, or a log. An older plaintext-stored
  token migrates into the vault on first run.
- Clone is shallow by default (depth 1, single branch) on
  desktop and phone, with a Full clone option.
- Merge conflicts on the phone resolve one card at a time
  (ours, base, theirs, your pick per block). The phone also
  gained the conflict endpoints it was missing entirely.

## 3.20.0 — Nov 17, 2026 — In-app update check

- The Android app checks for its own updates at most once a
  day against a manifest on the downloads host and shows a
  quiet banner when a newer build exists. Download opens in
  the browser; nothing installs itself.

## 3.19.0 — Nov 17, 2026 — Symbol row

- A slim, configurable symbol row at phone widths: brackets,
  quotes, operators, Tab, Undo, and cursor keys, inserting
  exactly the way typing does. Touch targets across the
  phone UI raised to 40px.

## 3.18.0 — Nov 17, 2026 — Phone layout gate

- A viewport-matrix gate now proves the layout at seven
  screen sizes before any build ships, and the phone layout
  was hardened against everything it found (panel overflow,
  stacked panels, clipped rows).

## 3.17.0 — Nov 17, 2026 — Git depth

- Stage individual hunks instead of whole files, with a
  stale-selection guard, and a three-pane merge conflict
  editor (base, ours, theirs, editable result).

## 3.16.0 — Nov 17, 2026 — Model store

- All four Qwen2.5-Coder sizes plus the embedding model as
  cards with machine-fit marks from real RAM, pause and
  resume downloads, and custom GGUF import.

## 3.15.0 — Nov 17, 2026 — Neural code search

- An on-device embeddings index (nomic-embed-text) powers
  semantic search across the workspace, with the lexical
  search kept and labelled as what it is.

## 3.14.0 — Nov 17, 2026 — MCP polish

- Per-tool policy for MCP servers, annotations passed
  through, header auth fixed end to end, and OAuth 2.0 with
  PKCE for remote servers.

## 3.13.0 — Nov 17, 2026 — Agent trust layer

- The agent writes a plan file you can edit before it acts,
  checkpoints every run, and offers a post-run review with
  per-file and per-hunk undo.

## 3.12.0 — Nov 17, 2026 — Language servers

- LSP for Python and TypeScript: diagnostics, hover,
  go-to-definition, and completion inside the editor.

## 3.11.0 — Nov 17, 2026 — Portable mode and auto-update

- Portable mode keeps all app data beside the executable.
  Desktop auto-update checks a signed-off manifest, verifies
  SHA-256 and size, applies on restart, and rolls back on
  an unconfirmed boot. Workspaces gained trust enforcement
  and AGENTS.md support.

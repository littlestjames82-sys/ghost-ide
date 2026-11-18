# Changelog

GhostIDE desktop and Android ship on one version train. The
in-app changelog (Settings, then About) carries the full
188-entry history; this file covers the current run.

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

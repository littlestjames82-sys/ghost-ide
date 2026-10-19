# GhostIDE 👻

A fully offline AI code editor for Ghost Developer Studio. The editor,
the chat, and the autocomplete all run locally - the AI is a
Qwen2.5-Coder model served by llama.cpp on this machine (or running
on-device in the Android app - see `ghostide-android`).
No cloud, no API key, no code leaves the device.

**Your code never leaves the device. The AI lives here.**

## Model matrix (Qwen2.5-Coder-Instruct, Q4_K_M GGUF)
| Device | Model | Download | RAM need |
|---|---|---|---|
| Most phones (Android app) | 1.5B | 0.94 GB | ~1.5 GB |
| Strong phones, 6 GB+ (Android app, menu -> Models) | 3B | 1.93 GB | ~2.6 GB |
| Desktop/laptop (this repo) | 7B | 4.68 GB | ~5 GB |

On the desktop, switch models any time in Settings (paste a GGUF
path) or with `GHOST_IDE_MODEL`. Behavior (prompts, defaults) is one
shared pack for both apps - see `BEHAVIOR.md`.

## Run it
```bash
./start.sh                 # http://127.0.0.1:5173
```
Then click **Start model** in the top bar (first load takes about a
minute). Or start the model first with
`~/workspace/offline-ide-llm/start-server.sh`.

## What's inside
- **Editor** - CodeMirror 6, syntax highlighting for JS/TS, Python,
  HTML, CSS, JSON, Markdown; one-dark theme. **Tabs** keep every open
  file's edits, cursor, and undo history.
- **Files** - real file tree over any folder (📂 picker + recents;
  default `./playground`). Open, edit, save (Ctrl+S), create, rename,
  delete, folders. Writes are confined to the workspace. Autosave
  drafts offer recovery if the app dies mid-edit.
- **Ghost Chat** - streaming chat sidebar with three context modes:
  current file, or a **GhostSlice project slice** (signatures or
  full) with a live token meter and an over-budget hard stop.
  Measured: a 143-file repo packed from 569,792 tokens to 5,939.
  Code blocks get an **Insert at cursor** button. Chat history is
  saved per project folder.
- **Inline autocomplete** - pause while typing and a grey fill-in-
  the-middle suggestion appears (Qwen Coder FIM via llama.cpp
  `/infill`). **Tab** (or a tap, on touch screens) accepts.
- **Run panel** - run .py/.js/.sh with the system interpreter, see
  output + exit code. Local and unsandboxed, stated plainly in the UI.
- **Git panel** - status, stage, diff view, and commit from the IDE.
- **Find / replace** across the whole project; click a match to jump.
- **Format on save** (Settings) via black/ruff/prettier if installed.
- **Tools panel (🧰)** - AI quick actions (explain, fix, tests,
  docstrings), markdown/image preview, syntax check, snippets,
  TODO/FIXME scanner, project stats, and a terminal in the
  workspace (desktop).
- **LAN sync** - with the desktop in LAN mode (`GHOST_IDE_HOST=
  0.0.0.0`), the phone app pulls/pushes the workspace over
  `/api/sync/bundle` + `/api/sync/apply`. Same WiFi, no cloud.

## Layout
- `server.py` - stdlib-only backend: static files, workspace file API,
  streaming proxy to llama.cpp (`/api/chat`, `/api/infill`), model
  health/start (`/api/health`, `/api/model/start`).
- `web/` - frontend (`src/main.js` bundled to `web/app.js` by esbuild;
  rebuild with `npm run build`).
- `playground/` - default workspace with demo files.

## Config (env)
- `GHOST_IDE_PORT` (5173), `GHOST_IDE_WORKSPACE`, `LLAMA_BASE`
  (http://127.0.0.1:8080), `LLAMA_SERVER_BIN`, `GHOST_IDE_MODEL`.

## Verified (Oct 19, 2026)
- Phone (Gate 0): the Android build runs the full loop on a real
  phone - background model download, on-device load, ~14 s chat
  answers, judged usable.
- Desktop endpoints all live-tested: files CRUD + rename/delete with
  escape + root-delete refusals, workspace switching (a 418-file repo
  browsed), GhostSlice context export (above), run panel (Python +
  Node), git status/stage/diff/commit (a real commit made through
  the API), project search/replace, LAN sync bundle/apply (incl. an
  escape attempt refused), model info/switch.
- Chat through the IDE (`/api/chat`, streaming SSE) returned
  `def reverse_string(s): return s[::-1]`; autocomplete (`/api/infill`)
  filled a fibonacci stub with coherent code.
- Screenshots: pending real-use captures (the plan forbids mockups in
  this README; the dev sandbox cannot render a browser).

## Honest notes
- On this 2-core sandbox VM the 7B generates ~4 tok/s: chat is
  usable, autocomplete takes a second or two. On a real machine it
  is much snappier.
- Single-user local tool: binds 127.0.0.1 by default, no auth by
  design. LAN mode is for trusted networks only - the startup log
  says so, and so does `RUN-ON-PHONE.md`.
- Known issues and limits: `KNOWN_ISSUES.md`.

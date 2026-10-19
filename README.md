# GhostIDE 👻

A fully offline AI code editor from Ghost Developer Studio.
The editor, the chat, and the autocomplete all run locally:
the AI is a Qwen2.5-Coder model served by llama.cpp on the
desktop, or running on-device in the Android app (see the
`ghostide-android` repo). No cloud, no API key, no account.
Your code never leaves the device.

**Your code never leaves the device. The AI lives here.**

## The model store (Qwen2.5-Coder-Instruct, Q4_K_M GGUF)

| Model | Download | RAM while running | Notes |
|---|---|---|---|
| 0.5B Sprinter | 380 MB | ~0.7 GB | phone store; fastest, rough edges |
| 1.5B Balanced | 0.94 GB | ~1.5 GB | phone default |
| 3B Smarter | 1.93 GB | ~2.6 GB | phone store; 6 GB+ phones |
| 7B Max | 4.68 GB | ~5.5 GB | desktop default + phone store (8 GB+ phones) |

Every download is exact-size and SHA-256 verified before
use, and resumable. On the desktop, download the 7B in
Settings ("Download 7B model"), switch models any time
with a GGUF path in Settings or `GHOST_IDE_MODEL`, or use
the in-app model switcher. Behavior (prompts, defaults)
is one shared pack for both apps: see `BEHAVIOR.md`.

## Run it

From source (needs Python 3.11+ and a llama.cpp build):

```bash
./start.sh                 # http://127.0.0.1:5173
```

Then click **Start model** in the top bar (first load
takes about a minute).

As a packaged app (Roadmap G18): `packaging/` builds
installable packages for Linux, macOS, and Windows
(PyInstaller + bundled llama.cpp, one-command install,
workspace seeded in ~/GhostIDE). A manual GitHub Actions
workflow (`.github/workflows/build-desktop.yml`) builds
all three. The package contains no model; the 7B is an
optional in-app download.

LAN / pair mode: start with `GHOST_IDE_HOST=0.0.0.0`
(trusted networks only, there is no login) and other
devices can open the same workspace.

## What's inside

- **Editor**: CodeMirror 6 (JS/TS, Python, HTML, CSS,
  JSON, Markdown), tabs with per-file undo, split view,
  multi-cursor, code folding, bracket matching, find and
  replace with regex, command palette, quick open, local
  history with restore, autosave draft recovery.
- **Ghost Chat**: streaming chat with context modes:
  current file, smart slice (the file's dependency web,
  reason-tagged and budget-packed), or project slice
  (signatures or full) with a token meter.
- **Agent mode**: Ghost plans multi-file changes one
  action at a time; writes stage for your review with
  diffs, and nothing lands until you approve it.
- **Verify loop**: a test runner (Python + Node) with a
  results panel, a Python debugger with gutter
  breakpoints, and "Fix my tests", a self-fixing loop
  that repairs failures and re-runs, reverting any round
  that makes things worse.
- **On-device parity on the phone**: the Android build
  runs Python with a bundled interpreter, ships full git
  (bundled binary: status, diff, stage, commit, branch,
  blame), a persistent terminal and REPL, voice coding,
  and the same agent and panels.
- **Platform**: project templates, a sandboxed plugin
  system (`PLUGINS.md`), pair mode (two devices, one
  workspace, conflict-safe sync), and optional encrypted
  backups (`PRIVACY.md` explains the data story, which
  is short: nothing is collected).
- **Updates**: Settings can check for updates against
  `VERSION.json` in this repo. It only ever reports; it
  never downloads or installs by itself.

## Layout

- `server.py` - the desktop backend (Python stdlib only)
- `debug_bridge.py` - the debugger bridge (bdb over stdio)
- `web/` - the frontend (CodeMirror 6, built with esbuild)
- `playground/` - the seed workspace
- `packaging/` - desktop app packaging (G18)
- `PLAN.md`, `ROADMAP_20.md` - the plan and the 40-goal
  roadmap this app is being built against
- `RUN-ON-PHONE.md` - using the desktop build from a phone
  browser on your LAN

MIT licensed. Built by Ghost Developer Studio, Oakdale,
Tennessee.

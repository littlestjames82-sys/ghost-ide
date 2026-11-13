# GhostIDE for desktop

An offline AI code editor. Your code never leaves the
machine; the AI model runs locally through llama.cpp.

## Install

- Linux: unpack, then `./install.sh`
- macOS: unpack, then `./install.sh` (unsigned app:
  right-click, Open, the first time)
- Windows: unzip, then `install.bat`

Then run GhostIDE. It starts a local server and the IDE
opens at http://127.0.0.1:5173 - your browser is the
window. Your first workspace is created in ~/GhostIDE
(Windows: %USERPROFILE%\GhostIDE); open any other folder
from inside the IDE.

## The AI model and llama.cpp

Neither the 7B model nor the llama.cpp runtime is in
this package - that is what keeps it small. Both are
one-time downloads, and the editor works without either
of them; only the AI waits.

The llama.cpp runtime (about 18 MB) is fetched the
first time you press "Start model", or ahead of time in
Settings, "Download llama.cpp". It is a pinned release
(llama.cpp b11429), verified by SHA-256 before it is
used, and it resumes if interrupted. If you already
have a llama-server of your own, point
LLAMA_SERVER_BIN at it and nothing is downloaded.

The 7B model (Qwen2.5-Coder-7B, 4.7 GB): in the IDE,
Settings, "Download 7B model". Verified by SHA-256 and
resumable, the same way. Prefer your own GGUF? Point
Settings, "Model file" at it instead, or set
GHOST_IDE_MODEL.

## Updates

Settings, "Check for updates" compares your version
with the latest release note. It only ever reports -
GhostIDE never downloads or installs an update by
itself.

## Notes

- Features that run your code (Run, tests, debugger,
  REPL) use a Python 3 found on your PATH in the
  packaged app. Everything else - editing, the AI,
  git (system git), terminal, pair mode, backups -
  works from the package alone.
- LAN / pair mode: set GHOST_IDE_HOST=0.0.0.0 before
  launching to let your phone join this workspace
  (trusted networks only - there is no login).

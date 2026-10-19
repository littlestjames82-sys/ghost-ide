# Run GhostIDE and use it from your phone

GhostIDE's heavy parts (the 4.7 GB model + the server) run on your
computer. Your phone is the screen: it opens the IDE in its browser
over your home WiFi. Nothing is exposed to the internet.

## One-time setup on the Aspire (Windows)

1. **Python 3** - if `python --version` in a terminal doesn't work,
   install it from https://www.python.org/downloads/ (tick
   "Add python.exe to PATH").
2. **llama.cpp (Windows)** - download the Windows CPU build
   (`llama-b####-bin-win-cpu-x64.zip`, b11429 or newer) from
   https://github.com/ggml-org/llama.cpp/releases and unzip it,
   e.g. to `C:\llama\`. It contains `llama-server.exe`.
3. **The model** - download this file (4,683,073,536 bytes) and put it
   in the same folder, e.g. `C:\llama\`:
   https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf
   SHA256 should be:
   `509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c`
4. **This bundle** - unzip the GhostIDE bundle anywhere, e.g.
   `C:\ghost-ide\`. Edit `start-lan.bat` so the two paths at the top
   match where you put `llama-server.exe` and the model.

## Every time you use it

1. On the Aspire: double-click `start-lan.bat`.
   (Windows Firewall may ask once - allow it on Private network.)
2. Note the PC's IP: run `ipconfig`, look for "IPv4 Address"
   (looks like 192.168.1.42).
3. On your phone (same WiFi), open in the browser:
   `http://192.168.1.42:5173` (use your PC's actual IP).
4. Tap **Start model** in the IDE header and wait about a minute.
5. Code away. Add it to your home screen (browser menu ->
   "Add to Home screen") and it opens like an app.

## Notes
- The phone layout stacks the panels: files on top, editor in the
  middle, chat at the bottom. It works, but a tablet or the PC screen
  is roomier for long sessions.
- Security: the IDE has no login. Only run `start-lan.bat` on your
  own trusted home WiFi, and close it when you're done. Using plain
  `start.sh` / `python server.py` keeps it on the PC only.
- Fully on-phone (no PC) would need a much smaller model
  (Qwen2.5-Coder 1.5B/3B) running in an Android llama.cpp build -
  doable as a later project, but slower and weaker.

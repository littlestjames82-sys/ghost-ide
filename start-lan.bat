@echo off
REM GhostIDE launcher for Windows - serves the IDE to your whole home
REM network so a phone/tablet on the same WiFi can use it.
REM
REM EDIT THESE TWO PATHS before first run:
set LLAMA_SERVER_BIN=C:\llama\llama-server.exe
set GHOST_IDE_MODEL=C:\llama\qwen2.5-coder-7b-instruct-q4_k_m.gguf
REM
REM The model server itself stays on localhost of this PC; only the
REM IDE web app is exposed on the LAN. No auth - trusted home WiFi only.
set GHOST_IDE_HOST=0.0.0.0
cd /d %~dp0
echo.
echo GhostIDE starting. On your phone, open:  http://THIS-PC-IP:5173
echo (find THIS-PC-IP by running:  ipconfig   - look for IPv4 Address)
echo.
python server.py
pause

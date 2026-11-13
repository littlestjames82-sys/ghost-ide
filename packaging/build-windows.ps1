# Build the GhostIDE Windows package (Roadmap G18).
# Run ON Windows in PowerShell:  .\packaging\build-windows.ps1
# Produces packaging\GhostIDE-windows.zip. Unsigned - SmartScreen
# will ask on first run, as with any unsigned open-source app.
# llama.cpp is NOT bundled: the app fetches a pinned release
# on first use (see LLAMA_CATALOG in server.py).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "packaging\.venv\Scripts\pyinstaller.exe")) {
    python -m venv packaging\.venv
    & packaging\.venv\Scripts\pip.exe install --quiet pyinstaller
}

Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
& packaging\.venv\Scripts\pyinstaller.exe packaging\ghostide.spec

@'
@echo off
rem GhostIDE one-command install (Windows): copies the app
rem to %LOCALAPPDATA%\GhostIDE and adds a Start Menu shortcut.
setlocal
set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\GhostIDE"
mkdir "%DEST%" 2>nul
xcopy /E /Y /Q "%SRC%*" "%DEST%\" >nul
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine($env:APPDATA,'Microsoft\Windows\Start Menu\Programs\GhostIDE.lnk')); $s.TargetPath=Join-Path $env:LOCALAPPDATA 'GhostIDE\GhostIDE.exe'; $s.Save()"
echo GhostIDE installed. Find GhostIDE in the Start Menu.
echo It opens at http://127.0.0.1:5173 with a workspace in %USERPROFILE%\GhostIDE.
pause
'@ | Set-Content dist\GhostIDE\install.bat

Copy-Item packaging\README-DESKTOP.md dist\GhostIDE\README.txt
Compress-Archive -Path dist\GhostIDE -DestinationPath packaging\GhostIDE-windows.zip -Force
Write-Host "Built packaging\GhostIDE-windows.zip"

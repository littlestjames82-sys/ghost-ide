# Build the GhostIDE Windows package (Roadmap G18).
# Run ON Windows in PowerShell:  .\packaging\build-windows.ps1
# Produces packaging\GhostIDE-windows.zip. Unsigned - SmartScreen
# will ask on first run, as with any unsigned open-source app.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$LlamaVer = "b11429"
$LlamaAsset = "llama-$LlamaVer-bin-win-cpu-x64.zip"
$LlamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaVer/$LlamaAsset"

if (-not (Test-Path "packaging\.venv\Scripts\pyinstaller.exe")) {
    python -m venv packaging\.venv
    & packaging\.venv\Scripts\pip.exe install --quiet pyinstaller
}

Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
& packaging\.venv\Scripts\pyinstaller.exe packaging\ghostide.spec

New-Item -ItemType Directory -Force dist\GhostIDE\llama | Out-Null
$cache = "packaging\.cache\$LlamaAsset"
if (-not (Test-Path $cache)) {
    New-Item -ItemType Directory -Force packaging\.cache | Out-Null
    Invoke-WebRequest $LlamaUrl -OutFile $cache
}
Expand-Archive $cache -DestinationPath dist\GhostIDE\llama -Force

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

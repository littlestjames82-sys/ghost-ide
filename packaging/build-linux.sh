#!/usr/bin/env bash
# Build the GhostIDE Linux package (Roadmap G18).
# Run from anywhere:  bash packaging/build-linux.sh
# Produces packaging/GhostIDE-linux.tar.gz containing the
# app, install.sh and a README. llama.cpp is NOT bundled:
# the app fetches a pinned release on first use (see
# LLAMA_CATALOG in server.py).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ ! -x packaging/.venv/bin/pyinstaller ]; then
  python3 -m venv packaging/.venv
  packaging/.venv/bin/pip install --quiet pyinstaller
fi

rm -rf build dist
packaging/.venv/bin/pyinstaller packaging/ghostide.spec

cp packaging/install.sh dist/GhostIDE/install.sh
chmod +x dist/GhostIDE/install.sh
cp packaging/README-DESKTOP.md dist/GhostIDE/README.txt

tar -czf packaging/GhostIDE-linux.tar.gz -C dist GhostIDE
echo "Built packaging/GhostIDE-linux.tar.gz"

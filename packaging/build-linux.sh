#!/usr/bin/env bash
# Build the GhostIDE Linux package (Roadmap G18).
# Run from anywhere:  bash packaging/build-linux.sh
# Produces packaging/dist/GhostIDE-linux.tar.gz containing
# the app, the llama.cpp runtime, install.sh and a README.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LLAMA_VER="b11429"
LLAMA_ASSET="llama-${LLAMA_VER}-bin-ubuntu-x64.tar.gz"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VER}/${LLAMA_ASSET}"

if [ ! -x packaging/.venv/bin/pyinstaller ]; then
  python3 -m venv packaging/.venv
  packaging/.venv/bin/pip install --quiet pyinstaller
fi

rm -rf build dist
packaging/.venv/bin/pyinstaller packaging/ghostide.spec

# llama.cpp runtime beside the executable.
mkdir -p dist/GhostIDE/llama
if [ ! -f "packaging/.cache/${LLAMA_ASSET}" ]; then
  mkdir -p packaging/.cache
  curl -sL "$LLAMA_URL" -o "packaging/.cache/${LLAMA_ASSET}"
fi
tar -xzf "packaging/.cache/${LLAMA_ASSET}" -C dist/GhostIDE/llama --strip-components=1 --no-same-owner

cp packaging/install.sh dist/GhostIDE/install.sh
chmod +x dist/GhostIDE/install.sh
cp packaging/README-DESKTOP.md dist/GhostIDE/README.txt

tar -czf packaging/GhostIDE-linux.tar.gz -C dist GhostIDE
echo "Built packaging/GhostIDE-linux.tar.gz"

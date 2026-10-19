#!/usr/bin/env bash
# Build the GhostIDE macOS package (Roadmap G18).
# Run ON a Mac:  bash packaging/build-macos.sh
# Produces packaging/GhostIDE-macos.tar.gz. Unsigned -
# first launch needs right-click, Open (Gatekeeper), as
# with any unsigned open-source app.
set -euo pipefail
cd "$(dirname "$0")/.."
LLAMA_VER="b11429"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  LLAMA_ASSET="llama-${LLAMA_VER}-bin-macos-arm64.tar.gz"
else
  LLAMA_ASSET="llama-${LLAMA_VER}-bin-macos-x64.tar.gz"
fi
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VER}/${LLAMA_ASSET}"

if [ ! -x packaging/.venv/bin/pyinstaller ]; then
  python3 -m venv packaging/.venv
  packaging/.venv/bin/pip install --quiet pyinstaller
fi

rm -rf build dist
packaging/.venv/bin/pyinstaller packaging/ghostide.spec

mkdir -p dist/GhostIDE/llama
if [ ! -f "packaging/.cache/${LLAMA_ASSET}" ]; then
  mkdir -p packaging/.cache
  curl -sL "$LLAMA_URL" -o "packaging/.cache/${LLAMA_ASSET}"
fi
tar -xzf "packaging/.cache/${LLAMA_ASSET}" -C dist/GhostIDE/llama --strip-components=1 --no-same-owner

cat > dist/GhostIDE/install.sh <<'EOS'
#!/usr/bin/env bash
# GhostIDE one-command install (macOS): copies the app to
# ~/Applications/GhostIDE and a launcher to /usr/local/bin
# when writable, else ~/bin.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Applications/GhostIDE"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
chmod +x "$DEST/GhostIDE"
echo "GhostIDE installed to $DEST"
echo "Run it with:  $DEST/GhostIDE"
echo "It opens at http://127.0.0.1:5173 with a workspace in ~/GhostIDE."
EOS
chmod +x dist/GhostIDE/install.sh
cp packaging/README-DESKTOP.md dist/GhostIDE/README.txt

tar -czf packaging/GhostIDE-macos.tar.gz -C dist GhostIDE
echo "Built packaging/GhostIDE-macos.tar.gz"

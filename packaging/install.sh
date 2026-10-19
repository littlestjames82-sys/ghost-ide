#!/usr/bin/env bash
# GhostIDE one-command install (Linux).
# From the unpacked package folder:  ./install.sh
# Installs to ~/.local/share/ghostide with a launcher at
# ~/.local/bin/ghostide and a desktop entry. No root, no
# auto-updates: the app only ever CHECKS for updates.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/ghostide"

mkdir -p "$DEST" "$HOME/.local/bin" "$HOME/.local/share/applications"
cp -a "$SRC/." "$DEST/"
chmod +x "$DEST/GhostIDE"

cat > "$HOME/.local/bin/ghostide" <<EOF
#!/usr/bin/env bash
exec "$DEST/GhostIDE" "\$@"
EOF
chmod +x "$HOME/.local/bin/ghostide"

cat > "$HOME/.local/share/applications/ghostide.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GhostIDE
Comment=Offline AI code editor - the model lives on your machine
Exec=$DEST/GhostIDE
Terminal=true
Categories=Development;IDE;
EOF

echo "GhostIDE installed."
echo "Run it with:  ghostide   (or find GhostIDE in your app menu)"
echo "It opens at http://127.0.0.1:5173 with a workspace in ~/GhostIDE."
echo "The 7B AI model is an optional in-app download (Settings)."

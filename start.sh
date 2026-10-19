#!/usr/bin/env bash
# Launch GhostIDE (backend + web UI). The model server is started
# from inside the IDE with the "Start model" button, or beforehand via
# ~/workspace/offline-ide-llm/start-server.sh
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f web/app.js ]; then
  echo "Building frontend bundle..."
  npm run build
fi
echo "GhostIDE -> http://127.0.0.1:${GHOST_IDE_PORT:-5173}"
exec python3 server.py

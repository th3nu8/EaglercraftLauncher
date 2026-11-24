#!/usr/bin/env bash
# Sets up Imitator (the Panes emulator app) on the Panes server: copies the app and installs the
# EmulatorJS player and cores (about 300 MB) next to server.js, then restarts the server.
# Run from the repo:  bash server/imitator-setup.sh   (re-run after a git pull to update the app)
# Without this, /imitator still works: the emulator files are downloaded from the EmulatorJS CDN
# the first time someone needs them and kept in the server's data folder.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-/opt/eaglercraft-saves}/imitator"
SERVICE="${SERVICE:-eaglercraft-saves}"
command -v npm >/dev/null || { echo "npm is needed (it comes with Node.js)"; exit 1; }
sudo mkdir -p "$DEST"
sudo cp -r "$HERE/imitator/app" "$HERE/imitator/package.json" "$DEST/"
OWNER="$(stat -c %U "$(dirname "$DEST")")"
sudo chown -R "$OWNER" "$DEST"
echo "Installing emulator cores into $DEST/node_modules (this takes a minute)…"
( cd "$DEST" && sudo -u "$OWNER" npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
du -sh "$DEST/node_modules" 2>/dev/null || true
if systemctl list-units --type=service --all 2>/dev/null | grep -q "$SERVICE"; then sudo systemctl restart "$SERVICE"; echo "Restarted $SERVICE"; fi
echo "Imitator is ready at /imitator/"

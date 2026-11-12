#!/bin/sh
# Installs or updates Overboost on the Mist server: /opt/overboost, systemd service "overboost" on
# 127.0.0.1:3200, and nginx route /overboost/ (HTTPS + WebSocket). Run from the repo: sh server/overboost-setup.sh
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p /opt/overboost/data
cp -r "$REPO/games/overboost/." /opt/overboost/
cd /opt/overboost && npm install --omit=dev --no-audit --no-fund --silent
chown -R www-data:www-data /opt/overboost
NODE=$(command -v node)
cat > /etc/systemd/system/overboost.service <<UNIT
[Unit]
Description=Overboost game server (Mist)
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/overboost
Environment=PORT=3200 HOST=127.0.0.1 DATA_DIR=/opt/overboost/data
ExecStart=$NODE server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/nginx/snippets/overboost.conf <<'NGX'
location = /overboost { return 301 /overboost/; }
location /overboost/ {
  proxy_pass http://127.0.0.1:3200/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 300s;
}
NGX
F=$(grep -Rl "3100" /etc/nginx/sites-enabled/ | head -1)
grep -q "snippets/overboost.conf" "$F" || sed -i --follow-symlinks '0,/location \/ {/s//include snippets\/overboost.conf;\n    location \/ {/' "$F"
systemctl daemon-reload
systemctl enable overboost >/dev/null 2>&1
systemctl restart overboost
nginx -t && systemctl reload nginx
sleep 2
systemctl is-active overboost
curl -s http://127.0.0.1:3200/api/status; echo

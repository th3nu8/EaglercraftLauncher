#!/bin/sh
# Installs or updates the Mist Browser on the Mist server: /opt/mist-browser, systemd service
# "mist-browser" on 127.0.0.1:3300, and the /browse/ route (nginx, plus the Mist server passes /browse/
# on for the tunnel). Also updates the Mist server itself (it hands out the browser tickets).
# Run from the repo: sh server/browser-setup.sh
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/eaglercraft-saves

# 1. Mist server (tickets, admin "browser off", /browse/ pass-through)
cp "$REPO/server/server.js" "$REPO/server/merge-data.js" "$REPO/server/package.json" "$APP/"
chown -R www-data:www-data "$APP"
systemctl restart eaglercraft-saves
sleep 2      # the Mist server writes the shared secret the browser service reads

# 2. the browser service
mkdir -p /opt/mist-browser/data
cp -r "$REPO/server/browser/server.js" "$REPO/server/browser/package.json" "$REPO/server/browser/public" /opt/mist-browser/
[ -f "$REPO/server/browser/package-lock.json" ] && cp "$REPO/server/browser/package-lock.json" /opt/mist-browser/
cd /opt/mist-browser && npm install --omit=dev --no-audit --no-fund --silent
[ -f /opt/mist-browser/data/blocklist.txt ] || cp "$REPO/server/browser/blocklist.example.txt" /opt/mist-browser/data/blocklist.txt
chown -R www-data:www-data /opt/mist-browser
NODE=$(command -v node)
cat > /etc/systemd/system/mist-browser.service <<UNIT
[Unit]
Description=Mist Browser (Ultraviolet + wisp relay for signed-in Mist players)
After=network.target eaglercraft-saves.service

[Service]
User=www-data
WorkingDirectory=/opt/mist-browser
Environment=PORT=3300 HOST=127.0.0.1 DATA_DIR=/opt/mist-browser/data MIST_API=http://127.0.0.1:3100 BROWSER_SECRET_FILE=$APP/data/browser-secret DAILY_MB=2048
ExecStart=$NODE server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# 3. nginx route (for the IP address and any domain nginx serves)
cat > /etc/nginx/snippets/mist-browser.conf <<'NGX'
location = /browse { return 301 /browse/; }
location /browse/ {
  proxy_pass http://127.0.0.1:3300/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;
  proxy_buffering off;
}
NGX
F=$(grep -Rl "3100" /etc/nginx/sites-enabled/ | head -1)
if [ -n "$F" ]; then
  grep -q "snippets/mist-browser.conf" "$F" || sed -i --follow-symlinks '0,/location \/ {/s//include snippets\/mist-browser.conf;\n    location \/ {/' "$F"
  nginx -t && systemctl reload nginx
fi

systemctl daemon-reload
systemctl enable mist-browser >/dev/null 2>&1
systemctl restart mist-browser
sleep 2
systemctl is-active mist-browser
curl -s http://127.0.0.1:3300/api/status; echo
curl -s -o /dev/null -w "through the Mist server: %{http_code}\n" http://127.0.0.1:3100/browse/

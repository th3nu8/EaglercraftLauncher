#!/bin/sh
# Makes Grant Canyon the front page of the Mist server (https://mistserver.space/ through the tunnel,
# and https://195.62.47.222/), with the Mist bookmark page at /getmist. Run from the repo: sh server/grantcanyon-setup.sh
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/eaglercraft-saves

# 1. The Node server (what the tunnel points at) serves / from public/grantcanyon/ and /getmist from public/index.html.
mkdir -p "$APP/public/grantcanyon"
cp "$REPO/server/server.js" "$REPO/server/merge-data.js" "$REPO/server/package.json" "$APP/"
cp "$REPO"/docs/* "$APP/public/"
cp -r "$REPO/sites/grantcanyon/." "$APP/public/grantcanyon/"
chown -R www-data:www-data "$APP"
systemctl restart eaglercraft-saves

# 2. nginx copy, for anyone opening the server by its IP.
mkdir -p /var/www/grantcanyon
cp -r "$REPO/sites/grantcanyon/." /var/www/grantcanyon/
chown -R www-data:www-data /var/www/grantcanyon
cat > /etc/nginx/snippets/grantcanyon.conf <<'NGX'
location = /grantcanyon { return 301 /grantcanyon/; }
location /grantcanyon/ { alias /var/www/grantcanyon/; index index.html; }
# Opening the server by its IP (https://195.62.47.222/) shows Grant Canyon.
if ($host = "195.62.47.222") { rewrite ^/$ /grantcanyon/ last; }
NGX
F=$(grep -Rl "3100" /etc/nginx/sites-enabled/ | head -1)
if [ -n "$F" ]; then
  grep -q "snippets/grantcanyon.conf" "$F" || sed -i --follow-symlinks '0,/location \/ {/s//include snippets\/grantcanyon.conf;\n    location \/ {/' "$F"
  nginx -t && systemctl reload nginx
fi

sleep 1
curl -s -o /dev/null -w "front page (Grant Canyon): %{http_code}\n" http://127.0.0.1:3100/
curl -s -o /dev/null -w "/getmist (Mist bookmark):  %{http_code}\n" http://127.0.0.1:3100/getmist
curl -s -o /dev/null -w "mist health:               %{http_code}\n" http://127.0.0.1:3100/api/health

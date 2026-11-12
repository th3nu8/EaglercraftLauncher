#!/bin/sh
# Serves Grant Canyon from this server at /grantcanyon/ (static page). Run from the repo: sh server/grantcanyon-setup.sh
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p /var/www/grantcanyon
cp -r "$REPO/sites/grantcanyon/." /var/www/grantcanyon/
chown -R www-data:www-data /var/www/grantcanyon
cat > /etc/nginx/snippets/grantcanyon.conf <<'NGX'
location = /grantcanyon { return 301 /grantcanyon/; }
location /grantcanyon/ { alias /var/www/grantcanyon/; index index.html; }
NGX
F=$(grep -Rl "3100" /etc/nginx/sites-enabled/ | head -1)
grep -q "snippets/grantcanyon.conf" "$F" || sed -i --follow-symlinks '0,/location \/ {/s//include snippets\/grantcanyon.conf;\n    location \/ {/' "$F"
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w "grantcanyon: %{http_code}\n" http://127.0.0.1:8080/grantcanyon/ || curl -sk -o /dev/null -w "grantcanyon: %{http_code}\n" https://127.0.0.1/grantcanyon/

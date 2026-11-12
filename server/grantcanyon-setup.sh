#!/bin/sh
# Serves Grant Canyon at /grantcanyon/ and as the front page of https://195.62.47.222/ (static page). Run from the repo: sh server/grantcanyon-setup.sh
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p /var/www/grantcanyon
cp -r "$REPO/sites/grantcanyon/." /var/www/grantcanyon/
chown -R www-data:www-data /var/www/grantcanyon
cat > /etc/nginx/snippets/grantcanyon.conf <<'NGX'
location = /grantcanyon { return 301 /grantcanyon/; }
location /grantcanyon/ { alias /var/www/grantcanyon/; index index.html; }
# Opening the server by its IP (https://195.62.47.222/) shows Grant Canyon; mistserver.space is unchanged.
if ($host = "195.62.47.222") { rewrite ^/$ /grantcanyon/ last; }
NGX
F=$(grep -Rl "3100" /etc/nginx/sites-enabled/ | head -1)
grep -q "snippets/grantcanyon.conf" "$F" || sed -i --follow-symlinks '0,/location \/ {/s//include snippets\/grantcanyon.conf;\n    location \/ {/' "$F"
nginx -t && systemctl reload nginx
curl -sk -o /dev/null -w "ip front page: %{http_code}\n" --resolve 195.62.47.222:443:127.0.0.1 https://195.62.47.222/
curl -sk -o /dev/null -w "mist health: %{http_code}\n" --resolve mistserver.space:443:127.0.0.1 https://mistserver.space/api/health

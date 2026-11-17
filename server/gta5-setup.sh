#!/bin/sh
# Makes GTA 5 open at /gta5 on every domain pointed at this server's IP (and on the IP itself), on both
# http and https, with no port in the address. nginx sends /gta5/ to the Mist server, which finds the game
# (8080 or 8001, http or https) and keeps the port out of the game's links and redirects.
# Run from the repo: sh server/gta5-setup.sh
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/eaglercraft-saves

# 1. Mist server (does the /gta5 forwarding)
cp "$REPO/server/server.js" "$APP/"
chown www-data:www-data "$APP/server.js"
systemctl restart eaglercraft-saves

# 2. nginx: /gta5 in every site, so any domain that reaches this IP gets it
cat > /etc/nginx/snippets/mist-gta5.conf <<'NGX'
# GTA 5 at /gta5 (added by server/gta5-setup.sh)
location = /gta5 { return 301 /gta5/$is_args$args; }
location ^~ /gta5/ {
  proxy_pass http://127.0.0.1:3100;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $http_connection;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_request_buffering off;
  client_max_body_size 0;
  proxy_read_timeout 3600s;
}
# files the game asks for from the site root (/main.js) go to the game too
if ($http_referer ~* "^https?://[^/]+/gta5/") { rewrite ^(.*)$ /__mist_gta5$1 last; }
location ^~ /__mist_gta5/ {
  internal;
  rewrite ^/__mist_gta5(.*)$ $1 break;
  proxy_pass http://127.0.0.1:3100;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $http_connection;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  client_max_body_size 0;
  proxy_read_timeout 3600s;
}
NGX

# include it in every server block of every enabled site (once each); old copies go to /root/nginx-before-gta5
BK=/root/nginx-before-gta5
CHANGED=""
for F in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -f "$F" ] || continue
  grep -Eq "^[[:space:]]*server[[:space:]]*\{" "$F" || continue
  grep -q "snippets/mist-gta5.conf" "$F" && continue
  mkdir -p "$BK$(dirname "$F")" && cp "$F" "$BK$F"
  python3 - "$F" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
n = re.sub(r'^([ \t]*)(server[ \t]*\{[ \t]*\n)', lambda m: m.group(1) + m.group(2) + m.group(1) + "    include snippets/mist-gta5.conf;\n", s, flags=re.M)
if n != s:
    open(p, "w").write(n); print("added /gta5 to", p)
PY
  CHANGED="$CHANGED $F"
done

if nginx -t; then systemctl reload nginx
else
  echo "nginx config test failed; putting the site files back"
  for F in $CHANGED; do cp "$BK$F" "$F"; done
  nginx -t && systemctl reload nginx
  exit 1
fi

sleep 2
curl -s -o /dev/null -w "Mist server /gta5/: %{http_code}\n" http://127.0.0.1:3100/gta5/
curl -sk -o /dev/null -w "nginx /gta5/ (any name): %{http_code}\n" -H "Host: any-domain.example" https://127.0.0.1/gta5/

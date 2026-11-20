#!/bin/sh
# Mist PC Connect (supporter perk): installs the server parts.
#  1. updates the Mist server (pairing, connection messages) and publishes the PC page + helper at /pc/
#  2. installs coturn as a TURN relay, for networks (schools, phones) that block direct connections
# Run from the repo:  sh server/pc-setup.sh          (add --no-turn to skip the relay)
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/eaglercraft-saves

# 1. Mist server + /pc/ files
cp "$REPO/server/server.js" "$APP/"
mkdir -p "$APP/public/pc"
cp "$REPO/pc/host.html" "$REPO/pc/mistpc.py" "$APP/public/pc/"
chown -R www-data:www-data "$APP/server.js" "$APP/public/pc"

if [ "$1" != "--no-turn" ]; then
  # 2. TURN relay (coturn) with time-limited passwords made by the Mist server
  command -v turnserver >/dev/null 2>&1 || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q coturn; }
  IP=$(curl -s -4 --max-time 5 https://api.ipify.org || true)
  [ -n "$IP" ] || IP=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  SECRET_FILE="$APP/data/turn.json"
  if [ -f "$SECRET_FILE" ]; then SECRET=$(python3 -c "import json;print(json.load(open('$SECRET_FILE'))['secret'])"); else SECRET=$(openssl rand -hex 24); fi
  cat > /etc/turnserver.conf <<CONF
# Mist PC Connect relay (written by server/pc-setup.sh)
listening-port=3478
external-ip=$IP
min-port=50000
max-port=50999
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=mist
total-quota=60
user-quota=4
stale-nonce=600
no-multicast-peers
no-cli
no-tls
no-dtls
# never relay to this server or private networks
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=$IP
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
CONF
  [ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  printf '{"urls":["turn:%s:3478?transport=udp","turn:%s:3478?transport=tcp"],"secret":"%s"}\n' "$IP" "$IP" "$SECRET" > "$SECRET_FILE"
  chown www-data:www-data "$SECRET_FILE"; chmod 640 "$SECRET_FILE"
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 50000:50999/udp >/dev/null
  fi
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  echo "TURN relay on $IP:3478: $(systemctl is-active coturn)"
fi

systemctl restart eaglercraft-saves
sleep 2
curl -s -o /dev/null -w "PC page: %{http_code}\n" http://127.0.0.1:3100/pc/host.html
curl -s -o /dev/null -w "pairing API: %{http_code} (401 = working, needs sign-in)\n" http://127.0.0.1:3100/api/pc/devices

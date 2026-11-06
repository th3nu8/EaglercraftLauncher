#!/usr/bin/env bash
# Browser CS 1.6 backend on Sandpile (Debian/Ubuntu, x86_64): a dedicated server plus a WebSocket <-> UDP relay.
#
#   bash /root/EaglercraftLauncher/server/cs16-web/setup.sh
#
# Installs:
#   /opt/cs16/hlds    Valve's official CS 1.6 dedicated server files (SteamCMD, anonymous, app 90)
#   /opt/cs16/srv     Xash3D FWGS dedicated server (i386) + ReGameDLL_CS, using the game files from /opt/cs16/hlds
#   /opt/cs16/relay   WebSocket <-> UDP relay (Node.js, port 7080) so browser players can join
#   systemd units     cs16-server.service, cs16-relay.service
#
# Game files come from Valve's free dedicated-server download on this machine; nothing is downloaded from or
# published to a website. Re-running is safe: it updates binaries and keeps server.cfg and relay/config.json.
#
# Ports: the server listens on 0.0.0.0:$GAME_PORT (default 27015), so it's reachable directly at <ip>:27015.
# Browsers can't send UDP, so they reach the same server through the relay (127.0.0.1:7080), which hands them the
# real address (<ip>:27015). If the HLDS service from ../cs16-server.sh is running it is stopped, since it would use
# the same port.

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cs16}"
HLDS="$INSTALL_DIR/hlds"
SRV="$INSTALL_DIR/srv"
RELAY="$INSTALL_DIR/relay"
SVC_USER="${SVC_USER:-cs16}"
GAME_PORT="${GAME_PORT:-27015}"
PUBLIC_IP="${PUBLIC_IP:-}"
RELAY_PORT="${RELAY_PORT:-7080}"
MAXPLAYERS="${MAXPLAYERS:-16}"
START_MAP="${START_MAP:-de_dust2}"

XASHDS_URL="https://github.com/FWGS/xash3d-fwgs/releases/download/continuous/xashds-linux-i386.tar.gz"
REGAMEDLL_API="https://api.github.com/repos/rehlds/ReGameDLL_CS/releases/latest"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$HERE/relay/server.js" ]] || die "can't find relay/server.js next to this script"
command -v apt-get >/dev/null || die "this script needs Debian or Ubuntu (apt-get)"

# --------------------------------------------------------------------------------
say "Installing packages (32-bit runtime for the i386 server and SteamCMD)"
dpkg --add-architecture i386
apt-get update -qq
apt-get install -y -qq curl unzip rsync ca-certificates jq tar \
    libc6:i386 libstdc++6:i386 lib32stdc++6 >/dev/null
apt-get install -y -qq lib32gcc-s1 >/dev/null 2>&1 || apt-get install -y -qq lib32gcc1 >/dev/null

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then
    die "Node.js 18+ is required for the relay (found: $(node -v 2>/dev/null || echo none)). Install it, then re-run."
fi

id "$SVC_USER" &>/dev/null || useradd --system --create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$INSTALL_DIR/steamcmd" "$SRV" "$RELAY"
chown "$SVC_USER:$SVC_USER" "$INSTALL_DIR" "$INSTALL_DIR/steamcmd"

# --------------------------------------------------------------------------------
say "Getting the CS 1.6 game files from Valve (SteamCMD; about 500 MB the first time)"
if [[ ! -x "$INSTALL_DIR/steamcmd/steamcmd.sh" ]]; then
    curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar xz -C "$INSTALL_DIR/steamcmd"
fi
chown -R "$SVC_USER:$SVC_USER" "$INSTALL_DIR/steamcmd"
ok=0
for i in 1 2 3 4 5 6; do
    runuser -u "$SVC_USER" -- env HOME="$INSTALL_DIR" "$INSTALL_DIR/steamcmd/steamcmd.sh" +force_install_dir "$HLDS" \
        +login anonymous +app_set_config 90 mod cstrike +app_update 90 validate +quit >"$TMP/steamcmd.log" 2>&1 || true
    if [[ -d "$HLDS/valve" && -f "$HLDS/cstrike/liblist.gam" ]]; then ok=1; break; fi
    echo "    attempt $i didn't finish, retrying…"; sleep 3
done
[[ $ok == 1 ]] || { tail -n 15 "$TMP/steamcmd.log"; die "SteamCMD couldn't download the server files"; }

# --------------------------------------------------------------------------------
say "Downloading Xash3D FWGS dedicated server (i386)"
curl -fsSL "$XASHDS_URL" -o "$TMP/xashds.tgz"
tar -xzf "$TMP/xashds.tgz" -C "$TMP"
install -m 755 "$TMP"/xashds-linux-i386/xash "$SRV/xash"
install -m 644 "$TMP"/xashds-linux-i386/filesystem_stdio.so "$SRV/filesystem_stdio.so"

say "Copying game files into the browser server"
rsync -a --delete "$HLDS/valve/" "$SRV/valve/"
rsync -a --exclude 'server.cfg' "$HLDS/cstrike/" "$SRV/cstrike/"

# --------------------------------------------------------------------------------
say "Installing ReGameDLL_CS (server game logic)"
REGAME_URL="$(curl -fsSL "$REGAMEDLL_API" | jq -r '.assets[] | select(.name | test("^regamedll-bin-.*\\.zip$")) | .browser_download_url' | head -n1)"
[[ -n "$REGAME_URL" && "$REGAME_URL" != null ]] || die "couldn't find a regamedll-bin-*.zip in the latest ReGameDLL release"
echo "    $REGAME_URL"
curl -fsSL "$REGAME_URL" -o "$TMP/regamedll.zip"
mkdir -p "$TMP/regamedll"
unzip -q -o "$TMP/regamedll.zip" -d "$TMP/regamedll"
[[ -f "$TMP/regamedll/bin/linux32/cstrike/dlls/cs.so" ]] || die "ReGameDLL zip layout changed (no bin/linux32/cstrike/dlls/cs.so)"
rsync -a --exclude 'server.cfg' "$TMP/regamedll/bin/linux32/cstrike/" "$SRV/cstrike/"

LIBLIST="$SRV/cstrike/liblist.gam"
grep -q '^gamedll_linux' "$LIBLIST" || echo 'gamedll_linux "dlls/cs.so"' >> "$LIBLIST"

if ! grep -q "CS 1.6 browser server" "$SRV/cstrike/server.cfg" 2>/dev/null; then
    RCON_PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20 || true)"
    sed "s/__RCON_PASSWORD__/$RCON_PASS/" "$HERE/server.cfg" > "$SRV/cstrike/server.cfg"
    echo "    rcon_password generated: $RCON_PASS  (saved in $SRV/cstrike/server.cfg)"
fi
# Game mode: infinite team deathmatch with a fixed loadout (deathmatch.cfg, replaced from the repo on every run).
# It's exec'd at the end of both game.cfg and server.cfg so its settings win whichever runs last.
install -m 644 "$HERE/deathmatch.cfg" "$SRV/cstrike/deathmatch.cfg"
for f in game.cfg server.cfg; do
    touch "$SRV/cstrike/$f"
    grep -q '^exec deathmatch.cfg' "$SRV/cstrike/$f" || printf '\nexec deathmatch.cfg\n' >> "$SRV/cstrike/$f"
done
chown -R "$SVC_USER:$SVC_USER" "$SRV"

# --------------------------------------------------------------------------------
say "Installing relay"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || PUBLIC_IP="195.62.47.222"
rsync -a --exclude node_modules --exclude config.json "$HERE/relay/" "$RELAY/"
[[ -f "$RELAY/config.json" ]] || cp "$RELAY/config.example.json" "$RELAY/config.json"
# Point the first server at this machine: browsers see the real address, the relay forwards to the local port.
jq --arg v "$PUBLIC_IP:$GAME_PORT" --arg t "127.0.0.1:$GAME_PORT" --argjson rp "$RELAY_PORT" \
    '.listen.port = $rp | .servers[0].virtual = $v | .servers[0].target = $t' \
    "$RELAY/config.json" > "$TMP/relay.json" && cp "$TMP/relay.json" "$RELAY/config.json"
echo "    browsers join: $PUBLIC_IP:$GAME_PORT"
(cd "$RELAY" && npm install --omit=dev --no-audit --no-fund --silent)
chown -R "$SVC_USER:$SVC_USER" "$RELAY"
# WebRTC (UDP-like) transport: one UDP port for all players. Without node-datachannel it runs WebSocket-only.
RTC_PORT="$(jq -r '.rtc.port // 27100' "$RELAY/config.json")"
if [[ -d "$RELAY/node_modules/node-datachannel" ]]; then
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow "$RTC_PORT/udp" >/dev/null && echo "    opened UDP $RTC_PORT in ufw (WebRTC)"
    fi
else
    echo "    node-datachannel didn't install, so the relay runs WebSocket-only (works, but laggier on bad Wi-Fi)."
fi

# --------------------------------------------------------------------------------
say "Writing systemd units"
cat > /etc/systemd/system/cs16-server.service <<EOF
[Unit]
Description=CS 1.6 dedicated server (Xash3D FWGS + ReGameDLL) for browser players
After=network.target

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$SRV
Environment=HOME=$INSTALL_DIR
# Reachable directly at <ip>:$GAME_PORT; browser players come in through the relay from 127.0.0.1.
ExecStart=$SRV/xash -game cstrike -ip 0.0.0.0 -port $GAME_PORT +maxplayers $MAXPLAYERS +map $START_MAP
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# The relay runs as $SVC_USER with /root and /home hidden, so Node must live somewhere it can reach.
# (nvm installs Node under /root/.nvm; in that case use a copy in $INSTALL_DIR.)
NODE_BIN="$(readlink -f "$(command -v node)")"
if [[ "$NODE_BIN" == /root/* || "$NODE_BIN" == /home/* ]] || ! runuser -u "$SVC_USER" -- test -x "$NODE_BIN"; then
    install -D -m 755 "$NODE_BIN" "$INSTALL_DIR/node/bin/node"
    NODE_BIN="$INSTALL_DIR/node/bin/node"
    echo "    using a copy of Node.js for the relay: $NODE_BIN"
fi
cat > /etc/systemd/system/cs16-relay.service <<EOF
[Unit]
Description=CS 1.6 browser relay (WebSocket <-> UDP)
After=network.target cs16-server.service

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$RELAY
ExecStart=$NODE_BIN $RELAY/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

if systemctl list-unit-files cs16.service >/dev/null 2>&1 && systemctl is-enabled -q cs16.service 2>/dev/null; then
    say "Stopping the separate HLDS server (cs16.service) so this one can use port $GAME_PORT"
    systemctl disable -q --now cs16.service || true
fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$GAME_PORT/udp" >/dev/null; echo "    opened UDP $GAME_PORT in ufw"
fi

# --------------------------------------------------------------------------------
# Browsers on https:// pages may only open wss:// connections, so the relay is published through the nginx that
# already serves Mist over HTTPS on this machine:  wss://<ip>/cs-relay/  ->  http://127.0.0.1:$RELAY_PORT
if command -v nginx >/dev/null; then
    say "Publishing the relay at wss://$PUBLIC_IP/cs-relay/ (nginx)"
    mkdir -p /etc/nginx/snippets
    cat > /etc/nginx/snippets/cs16-relay.conf <<EOF2
location /cs-relay/ {
    proxy_pass http://127.0.0.1:$RELAY_PORT/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
EOF2
    CONF="$(grep -RlE '127\.0\.0\.1:3100|localhost:3100' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -n1 || true)"
    if [[ -z "$CONF" ]]; then
        echo "    Couldn't find the nginx site that serves Mist (proxy to :3100). Add this line inside its HTTPS server { } block:"
        echo "        include /etc/nginx/snippets/cs16-relay.conf;"
    elif grep -q 'snippets/cs16-relay.conf' "$CONF"; then
        echo "    already included in $CONF"
    else
        CONF="$(readlink -f "$CONF")"; cp "$CONF" "$TMP/nginx.bak"
        # put the include right before each "location / {" in that file
        sed -i -E 's#^([[:space:]]*)location[[:space:]]+/[[:space:]]*\{#\1include /etc/nginx/snippets/cs16-relay.conf;\n\1location / {#' "$CONF"
        if ! grep -q 'snippets/cs16-relay.conf' "$CONF"; then
            echo "    No 'location / {' in $CONF. Add this inside its HTTPS server { } block:  include /etc/nginx/snippets/cs16-relay.conf;"
        elif nginx -t >/dev/null 2>&1; then
            systemctl reload nginx && echo "    added to $CONF"
        else
            cp "$TMP/nginx.bak" "$CONF"; echo "    nginx rejected the change, so it was undone:"; nginx -t || true
        fi
    fi
else
    echo "    nginx isn't installed here; browsers need a wss:// address for the relay (port $RELAY_PORT)."
fi

systemctl daemon-reload
systemctl enable -q cs16-server.service cs16-relay.service
systemctl reset-failed cs16-server.service cs16-relay.service 2>/dev/null || true
systemctl restart cs16-server.service cs16-relay.service

sleep 3
say "Status"
echo "cs16-server: $(systemctl is-active cs16-server)    cs16-relay: $(systemctl is-active cs16-relay)"
for svc in cs16-server cs16-relay; do
    systemctl is-active -q "$svc" || { echo "--- $svc isn't running. Last log lines:"; journalctl -u "$svc" -n 12 --no-pager || true; }
done
curl -fsS "http://127.0.0.1:$RELAY_PORT/servers" && echo

cat <<EOF

Done.
  Browser relay:  wss://$PUBLIC_IP/cs-relay/      (check: https://$PUBLIC_IP/cs-relay/servers)
Direct (desktop Xash3D/CS clients):  connect $PUBLIC_IP:$GAME_PORT   (open UDP $GAME_PORT in any provider firewall)
WebRTC for browser players: open UDP $RTC_PORT in any provider firewall too.

Logs:   journalctl -fu cs16-server    journalctl -fu cs16-relay
EOF

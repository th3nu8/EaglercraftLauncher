#!/usr/bin/env bash
# Browser CS 1.6 backend on Sandpile (Debian/Ubuntu, x86_64): a dedicated server plus a WebSocket <-> UDP relay.
#
#   bash /root/EaglercraftLauncher/server/cs16-web/setup.sh
#
# Installs:
#   /opt/cs16/hlds    Valve's official CS 1.6 dedicated server files (SteamCMD, anonymous, app 90)
#   /opt/cs16/srv     Xash3D FWGS dedicated server (i386) + ReGameDLL_CS, using the game files from /opt/cs16/hlds
#   /opt/cs16/relay   WebSocket <-> UDP relay (Node.js) so browser players can join
#   systemd units     cs16-server.service, cs16-relay.service
#
# Game files come from Valve's free dedicated-server download on this machine; nothing is downloaded from or
# published to a website. Re-running is safe: it updates binaries and keeps server.cfg and relay/config.json.
#
# Ports: the server listens on 0.0.0.0:$GAME_PORT (default 27015), so it's reachable directly at <ip>:27015.
# Browsers can't send UDP, so they reach the same server through the relay (127.0.0.1:27080), which hands them the
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
chown -R "$SVC_USER:$SVC_USER" "$SRV"

# --------------------------------------------------------------------------------
say "Installing relay"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || PUBLIC_IP="134.195.88.52"
rsync -a --exclude node_modules --exclude config.json "$HERE/relay/" "$RELAY/"
[[ -f "$RELAY/config.json" ]] || cp "$RELAY/config.example.json" "$RELAY/config.json"
# Point the first server at this machine: browsers see the real address, the relay forwards to the local port.
jq --arg v "$PUBLIC_IP:$GAME_PORT" --arg t "127.0.0.1:$GAME_PORT" '.servers[0].virtual = $v | .servers[0].target = $t' \
    "$RELAY/config.json" > "$TMP/relay.json" && cp "$TMP/relay.json" "$RELAY/config.json"
echo "    browsers join: $PUBLIC_IP:$GAME_PORT"
(cd "$RELAY" && npm install --omit=dev --no-audit --no-fund --silent)
chown -R "$SVC_USER:$SVC_USER" "$RELAY"

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

NODE_BIN="$(command -v node)"
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

systemctl daemon-reload
systemctl enable -q cs16-server.service cs16-relay.service
systemctl restart cs16-server.service cs16-relay.service

sleep 3
say "Status"
echo "cs16-server: $(systemctl is-active cs16-server)    cs16-relay: $(systemctl is-active cs16-relay)"
curl -fsS "http://127.0.0.1:$(jq -r '.listen.port // 27080' "$RELAY/config.json")/servers" && echo

cat <<EOF

Done. Last step: add a public hostname to your Cloudflare Tunnel
  Hostname:  cs-relay.noobscloud.org
  Service:   http://127.0.0.1:27080
Then https://cs-relay.noobscloud.org/servers should show the server list.
Direct (desktop Xash3D/CS clients):  connect $PUBLIC_IP:$GAME_PORT   (open UDP $GAME_PORT in any provider firewall)

Logs:   journalctl -fu cs16-server    journalctl -fu cs16-relay
EOF

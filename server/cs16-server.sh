#!/usr/bin/env bash
# Counter-Strike 1.6 dedicated server (HLDS, downloaded from Valve with SteamCMD) as a systemd service.
#
#   bash /root/EaglercraftLauncher/server/cs16-server.sh
#
# Optional settings (put them before "bash"):  NAME="My Server" MAP=de_dust2 MAXP=16 BOTS=8 PORT=27015
# Re-running is safe: it updates HLDS and keeps your server.cfg (and rcon password).
# Players join from Counter-Strike 1.6 (Steam): open the console and type  connect <server-ip>:27015
set -euo pipefail

PORT="${PORT:-27015}"; NAME="${NAME:-Mist CS 1.6}"; MAP="${MAP:-de_dust2}"; MAXP="${MAXP:-16}"; BOTS="${BOTS:-8}"
DIR=/opt/cs16; U=cs16; HL="$DIR/hlds"

[ "$(id -u)" = 0 ] || { echo "Run this as root."; exit 1; }
command -v apt-get >/dev/null || { echo "This script needs Debian or Ubuntu (apt-get)."; exit 1; }

echo "[1/5] Installing 32-bit libraries…"
dpkg --add-architecture i386
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar lib32stdc++6 >/dev/null
apt-get install -y -qq lib32gcc-s1 >/dev/null 2>&1 || apt-get install -y -qq lib32gcc1 >/dev/null

echo "[2/5] Setting up the cs16 user and SteamCMD…"
id "$U" >/dev/null 2>&1 || useradd -r -m -d "$DIR" -s /usr/sbin/nologin "$U"
mkdir -p "$DIR/steamcmd"
if [ ! -x "$DIR/steamcmd/steamcmd.sh" ]; then
  curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar xz -C "$DIR/steamcmd"
fi
chown -R "$U:$U" "$DIR"

echo "[3/5] Downloading the Counter-Strike 1.6 server from Valve (about 500 MB, can take a few tries)…"
ok=0
for i in 1 2 3 4 5 6; do
  runuser -u "$U" -- "$DIR/steamcmd/steamcmd.sh" +force_install_dir "$HL" +login anonymous \
    +app_set_config 90 mod cstrike +app_update 90 validate +quit >/tmp/cs16-steamcmd.log 2>&1 || true
  if [ -x "$HL/hlds_linux" ] && [ -f "$HL/cstrike/liblist.gam" ]; then ok=1; break; fi
  echo "    attempt $i didn't finish, retrying…"; sleep 3
done
[ "$ok" = 1 ] || { echo "SteamCMD couldn't finish. Last lines:"; tail -n 15 /tmp/cs16-steamcmd.log; exit 1; }
mkdir -p "$DIR/.steam/sdk32"
ln -sf "$DIR/steamcmd/linux32/steamclient.so" "$DIR/.steam/sdk32/steamclient.so"

echo "[4/5] Writing server settings…"
CFG="$HL/cstrike/server.cfg"
if ! grep -q "Mist CS 1.6 server settings" "$CFG" 2>/dev/null; then
  RCON="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true)"
  cat >"$CFG" <<EOF
// Mist CS 1.6 server settings (edit freely; this file is kept on re-runs)
hostname "$NAME"
rcon_password "$RCON"
sv_password ""
sv_lan 0
sv_region 255
mp_timelimit 30
mp_roundtime 2.5
mp_freezetime 3
mp_buytime 0.5
mp_startmoney 800
mp_friendlyfire 0
mp_autoteambalance 1
mp_limitteams 2
sv_alltalk 0
// bots fill the server up to this many players and leave as people join
bot_quota $BOTS
bot_quota_mode fill
bot_difficulty 1
bot_join_after_player 0
bot_chatter minimal
EOF
fi
chown -R "$U:$U" "$DIR"

echo "[5/5] Creating the cs16 service…"
cat >/etc/systemd/system/cs16.service <<EOF
[Unit]
Description=Counter-Strike 1.6 dedicated server
After=network-online.target
Wants=network-online.target

[Service]
User=$U
Group=$U
WorkingDirectory=$HL
Environment=HOME=$DIR
Environment=LD_LIBRARY_PATH=$HL:$HL/cstrike
ExecStart=$HL/hlds_linux -game cstrike -port $PORT +ip 0.0.0.0 +maxplayers $MAXP +map $MAP -pingboost 2 +sv_lan 0
StandardInput=null
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q cs16
systemctl restart cs16
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/udp" >/dev/null; ufw allow "$PORT/tcp" >/dev/null; echo "    Opened port $PORT in ufw."
fi
sleep 4
IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "CS 1.6 server: $(systemctl is-active cs16)"
echo "Join from CS 1.6 console:  connect $IP:$PORT"
echo "RCON password: $(grep -oP 'rcon_password "\K[^"]+' "$CFG")"
echo "Logs: journalctl -u cs16 -n 50   ·   Settings: $CFG"

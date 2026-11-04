# CS 1.6 server + browser relay

```
browser (Xash3D WASM)  --wss-->  Cloudflare Tunnel  -->  relay :27080  --udp-->  server :27015 (also open directly at <ip>:27015)
                                  cs-relay.noobscloud.org    (Node, Sandpile)     Xash3D FWGS + ReGameDLL
```

Install / update on Sandpile: `bash /root/EaglercraftLauncher/server/cs16-web/setup.sh`

- Game files for the server come from Valve's free dedicated-server download (SteamCMD, app 90) into `/opt/cs16/hlds`.
- The server listens on port 27015 on all addresses, so it's reachable directly at `<ip>:27015`. Browsers get that same
  address from the relay. Setup stops the separate HLDS service (`cs16`) if it's running, since it uses the same port.
- The relay only forwards to servers listed in `/opt/cs16/relay/config.json` (`virtual` → `target`) and limits
  connections per IP, packets per second and idle time.
- Then point a Cloudflare Tunnel hostname (`cs-relay.noobscloud.org`) at `http://127.0.0.1:27080`.
- Logs: `journalctl -fu cs16-server`, `journalctl -fu cs16-relay`. Settings: `/opt/cs16/srv/cstrike/server.cfg`.

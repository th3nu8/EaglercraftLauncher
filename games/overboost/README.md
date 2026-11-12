# Overboost

Car football in the browser: drive, jump, flip and boost a ball into the other net. 1v1, 2v2 and 3v3 with
online matchmaking, ratings, private lobbies, bots, free play, and keyboard, gamepad and touch controls.
The name, art, sounds and arena are original; the physics follow the numbers the car-football community has
measured for the genre (see "Physics" below).

## Run it

```
npm install
npm start            # http://localhost:3000
```

Node 18 or newer. One dependency (`ws`). Everything else (Three.js, the font) is vendored in `public/`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `BOT_FILL_SECONDS` | `15` | How long a queue waits for humans before bots take the empty seats |
| `MATCH_SECONDS` | `300` | Length of matchmade games (private lobbies pick their own) |
| `DATA_DIR` | `./data` | Where `players.json` (names, ratings, stats) is kept |

### Putting it online

The server speaks plain HTTP and upgrades `/ws` to a WebSocket on the same port, so a Cloudflare Tunnel pointed
at `http://127.0.0.1:3000` works as is (WebSockets are on by default for tunnels). Behind nginx, proxy the whole
site and pass the upgrade headers:

```
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 300s;
}
```

It can live under a sub-path too (`example.com/overboost/`): the client builds its WebSocket and API URLs relative
to the page. Keep it running with `pm2 start server.js --name overboost` or a systemd unit. One process handles
many matches (a 3v3 costs roughly 10 microseconds per tick, 120 ticks a second), but all matches share that one
process, so it does not scale across cores without a second instance.

The `public/` folder also works on any static host with no server at all: online play switches itself off and
bots and free play still run. A static copy can point at a game server elsewhere with `?server=wss://host/ws`.

## What is in it

- **Online matchmaking** for 1v1, 2v2 and 3v3. Players are matched by rating, the search widens the longer you
  wait, and bots fill empty seats after `BOT_FILL_SECONDS`. Teams are balanced by rating.
- **Ratings and leaderboard.** Elo per playlist, eight ranks from Rookie to Legend. A match changes ratings when
  there are humans on both teams. Leaving a ranked match early counts as a loss.
- **Private lobbies** with a 5-letter code and an invite link (`?join=CODE`), team picking, team size, bot skill
  and match length.
- **Reconnect.** Drop out of a matchmade game and a bot drives your car; reload and you are put back in it.
- **Bots** in three skills (Rookie, Pro, Elite) that rotate between attacking, supporting and defending,
  line up shots, dodge into the ball and recover in the air. The same code backfills online matches and runs
  offline matches in the browser.
- **Free play** with unlimited boost (`R` resets the ball, `Shift+R` lobs it to you).
- **Match rules:** kickoff countdown, 5-minute clock that stops for goals, play continues at 0:00 until the ball
  touches the ground, sudden-death overtime, goals / assists / saves / shots / score, MVP, demolitions and bumps.
- **Controls:** rebindable keys and mouse, gamepad, and on-screen touch controls. Camera settings (field of view,
  distance, height, angle, stiffness) and ball cam.
- **Quick chat** on keys 1 to 8.

There are no accounts: a random id kept in the browser's local storage identifies a player, so clearing site
data starts a new profile. Not included: goal replays, parties that queue together (use a private lobby), text
chat, car customisation.

## How the netcode works

The server is authoritative and steps every match at 120 Hz. Clients send one input per tick (6 bytes each,
batched per frame) and get a binary snapshot of the whole match 60 times a second (about 800 bytes for a 3v3).

The same simulation file runs in the browser, so the client predicts the entire world, not only its own car.
Each snapshot says which input the server has consumed; the client rewinds to the snapshot, replays the inputs
the server has not seen yet and carries on. Your own car responds on the frame you press the key, whatever the
ping. When a replay lands somewhere different from what was on screen (another player changed direction), the
difference is eased out over a few frames instead of snapping. In testing with 150 ms of round-trip lag, nine
snapshots in ten needed no correction to the player's car at all.

The client also nudges its clock by up to 2% so the server's queue of its inputs neither empties nor grows.

## Physics

`public/shared/sim.js` is a self-contained rigid-body simulation with no physics library. Distances are in
"uu" (about a centimetre), the same unit the car-football community uses, which made it possible to check the
build against well-known reference numbers:

| Check | Target | Measured |
| --- | --- | --- |
| Top speed on throttle / with boost | 1410 / 2300 | 1410 / 2300 |
| 0 to 1400 on throttle, 0 to 2300 with boost | 2.2 s / 1.7 s | 2.23 s / 1.69 s |
| Braking | 3500 uu/s² | 3450 |
| Turning curvature at 500, 1000, 1750, 2300 uu/s | 0.0040, 0.0024, 0.0011, 0.00088 | within 10% |
| Held jump apex / double jump apex | about 230 / about 490 | 245 / 490 |
| Forward dodge speed gain | 500 | 525 |
| Ball rebound | 60% of impact speed | 60% |
| Kickoff from the back spot, boost only | about 2.6 s | 2.63 s |

What is modelled: four-wheel suspension with spring and damper, tyres that remove sideways slip per wheel
(with the grip falling off as the slide gets wider, and almost gone while sliding on purpose), sticky force for
wall driving, jump hold and double jump, dodges with flip cancel and the short "stall" that makes them float,
air roll / pitch / yaw with damping, supersonic state, bumps and demolitions, a ball with spin transfer on
bounce and a capped spin rate, and the extra speed-scaled impulse on car-ball hits that makes shots feel punchy.
The arena is a distance field (rounded box with curved ramps and two goal boxes), so walls, ramps, ceiling and
goal posts are exact curved surfaces rather than a triangle mesh.

All the tunables sit at the top of `sim.js`. `STEER_CURVE`, `LAT_GRIP`, `HIT_CURVE`, the `FLIP_*` and `AIR_*`
groups are the ones that change the feel most.

## Tests

```
npm test
```

- `test/physics-test.js` checks the numbers above plus half-flips, wall driving, post hits, snapshot round-trip
  and a four-minute random-input soak (nothing escapes the arena, nothing goes NaN).
- `test/bot-test.js` plays bot matches and checks that they produce real games and that Elite beats Rookie.
- `test/net-test.js` boots the server and drives it with fake clients: matchmaking, a ranked match to a
  result with rating changes, bot backfill, reconnect, private lobbies, chat, leaderboard, persistence.

## Layout

```
server.js                 static hosting, matchmaking, lobbies, rooms, ratings
public/shared/sim.js      physics, match rules, snapshots (server + browser)
public/shared/bot.js      bot AI (server + browser)
public/js/main.js         menus, networking, HUD, frame loop
public/js/session.js      prediction, rollback, correction smoothing
public/js/render.js       Three.js scene, effects, camera
public/js/input.js        keyboard, mouse, gamepad, touch
public/js/audio.js        synthesised sounds
public/css/style.css      interface
public/vendor/            Three.js r170 (MIT)
public/fonts/             Anybody (SIL Open Font License)
```

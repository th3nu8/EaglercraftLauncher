# Eaglercraft Launcher (bookmarklet)

A desktop-launcher-style front end for Eaglercraft that opens in an `about:blank`
window from a single bookmarklet. Everything is served from your GitHub repo.

```
eaglercraft-launcher/
├── loader.js          ← the bookmarklet loads this; set your repo here
├── versions.json      ← the list of versions the launcher shows
├── bookmarklet.txt    ← the one-line bookmark
├── launcher/
│   ├── index.html     ← launcher layout
│   ├── style.css      ← launcher look
│   ├── sync.js        ← cloud saves (world snapshot + sync)
│   └── app.js         ← launcher logic (download, cache, launch, accounts)
├── versions/          ← put your Eaglercraft .html builds here
└── server/            ← cloud save server (runs on your own machine, NOT GitHub)
    ├── server.js
    ├── package.json
    └── eaglercraft-saves.service
```

## Install page

The save server also serves this page at its own address (https://134.195.88.52/). Copy `docs/`
into the server's `public/` folder (see *Run the save server* below). `docs/mist-qr.png` points there;
`docs/mist-qr-github.png` points to the GitHub Pages copy.

`docs/index.html` is a page that installs the bookmarklet (drag-to-bookmarks button plus copy code),
and `docs/mist-qr.png` is a QR code that opens it. Turn on GitHub Pages once
(Settings → Pages → Deploy from a branch → `main` / `/docs`) and it's live at
https://th3nu8.github.io/EaglercraftLauncher/. Pages only publishes `docs/`, so the big game files
in `versions/` don't count toward its size limit.

## Setup

1. **Create a public GitHub repo**, e.g. `eaglercraft-launcher`, and push
   everything in this folder to the `main` branch.
2. **Edit `loader.js`**: set `REPO` to your username / repo / branch.
3. **Add your versions**: put each offline single-file build in `versions/`
   and list it in `versions.json` (see below).
4. **Edit `bookmarklet.txt`**: change `th3nu8/eaglercraft-launcher@main` to your
   `user/repo@branch`.
5. **Make the bookmark**: create a new bookmark, paste the whole line from
   `bookmarklet.txt` as the URL, and name it whatever you like.
6. Go to any normal web page and click the bookmark. The launcher opens in a new
   `about:blank` tab.

## Cloud saves (sign in to keep worlds on any site)

Browsers keep Eaglercraft worlds separately for each website, so a world made
while launching from one site isn't visible from another. Signing in fixes that:
the launcher backs up your worlds to your own save server and restores them on
whichever site you open it from.

### 1. Run the save server (on Sandpile)

It's a single Node 18+ file with no dependencies.

```bash
sudo mkdir -p /opt/eaglercraft-saves
sudo cp server/server.js server/merge-data.js server/package.json /opt/eaglercraft-saves/
sudo mkdir -p /opt/eaglercraft-saves/public && sudo cp docs/* /opt/eaglercraft-saves/public/
sudo mkdir -p /opt/eaglercraft-saves/data && sudo chown -R www-data:www-data /opt/eaglercraft-saves
sudo cp server/eaglercraft-saves.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now eaglercraft-saves
curl http://127.0.0.1:3100/api/health     # → {"ok":true,...}
```

It listens on `127.0.0.1:3100` by default. Settings are environment variables in the
service file:

| Variable        | Default        | Meaning |
|-----------------|----------------|---------|
| `PORT`          | `3100`         | Port to listen on. |
| `HOST`          | `127.0.0.1`    | Keep it local and expose it through the tunnel. |
| `DATA_DIR`      | `./data`       | Where accounts (`db.json`) and saves (`saves/`) live. **Back this folder up.** |
| `MAX_SAVE_MB`   | `256`          | Largest save upload allowed per account. |
| `ALLOW_SIGNUPS` | `true`         | Set `false` once your people have accounts. |
| `SESSION_DAYS`  | `180`          | How long a sign-in lasts. |
| `PUBLIC_DIR`    | `./public`     | Website served at `/` (copy of the repo's `docs/`). |

### 2. Give it an HTTPS address

The launcher runs on HTTPS pages, so the server needs HTTPS too. With Cloudflare
Tunnel, add an ingress rule such as:

```yaml
- hostname: eaglersaves.noobscloud.org
  service: http://127.0.0.1:3100
```

then `cloudflared tunnel route dns <tunnel> eaglersaves.noobscloud.org` and restart
cloudflared.

### 3. Point the launcher at it

Set `"syncServer"` at the top of `versions.json`:

```json
{ "syncServer": "https://eaglersaves.noobscloud.org", "versions": [ ... ] }
```

(Players can also override it in **Settings → Save server**.)

### Friends & chat

Friends use the same server and accounts as cloud saves, so there's nothing extra to set up,
just run the updated `server/server.js`.

- **Add a friend:** Friends & Chat → ＋ → their account name. They get a request with ✓ / ✕.
- **Status:** friends show as *In-game* ("Playing Polytrack"), *Online* (launcher open) or
  *Offline* ("Last online 2 h ago"). Status is only visible to friends.
- **Chat:** click a friend. Messages are friends-only, up to 500 characters, and the last 300
  per conversation are kept. New messages and requests pop up a notification and a red badge.
- **Profiles:** click any name or your own to see member-since, friend count and recently played games.
- Limits: 300 friends, 100 pending requests, 30 messages a minute per person.

### Achievements & stats

The server tracks playtime (from the "Playing X" status Mist sends every minute while a game is
open in "Inside launcher" mode), games played, days active and streaks, friends, chat messages and
cloud saves. 20 achievements unlock from those, like *First Steps* (10 min played), *Explorer*
(5 games), *Squad Up* (5 friends), *Weekly Warrior* (7-day streak) and *Mist Legend* (100 hours).
Unlocks pop up in the top-right, even over a running game. Profiles show stats and badges, your own
profile shows progress bars, and the Users page shows each player's trophy count and playtime.
The list lives in `ACHIEVEMENTS` in `server/server.js`, so adding one is a single line.

### Profiles & game achievements

Click any player name (Users page, friends list, chat, store) or **My profile & achievements**
in the account menu to open a full profile page:
- header with avatar, status (friends only) and Add friend / Message buttons
- stats: playtime, games, achievements, game badges, best streak, days active
- every achievement with unlock date, **rarity** (% of players who have it) and, on your own
  profile, progress bars; filter All / Unlocked / Locked
- **Game achievements**: every game has 10 for time played: 🌱 5 min, 🎈 15 min, 🎯 30 min,
  🪝 1 h, 🎮 2 h, 💪 5 h, 🛡️ 10 h, ⭐ 25 h, 🏆 50 h, 👑 100 h. Click a game on a profile to see all 10
  with dates and rarity. Each game's Store and Library page also lists its 10 with your progress.
- recently played games and friends (visible to you and your friends)

### If accounts go missing

The server now protects against the two ways accounts used to get lost:
- It **won't start** if it can't write its data folder, and prints the `chown` command to fix it.
- Only **one server per data folder**: a second copy refuses to start instead of fighting over the data.
- If saving fails while running, it retries, shows `"storage":"error"` on `/api/health`, and refuses
  sign-ups instead of accepting accounts that would vanish on restart.
- `db.json` is **backed up** to `data/backups/` on every start and every 6 hours (newest 28 kept).
- The log's first line says which data folder is in use and how many accounts it has.

To pull accounts back from another data folder (e.g. one a manually started copy was using):
```bash
sudo systemctl stop eaglercraft-saves
sudo node /opt/eaglercraft-saves/merge-data.js /path/to/other/data /opt/eaglercraft-saves/data
sudo chown -R www-data:www-data /opt/eaglercraft-saves/data
sudo systemctl start eaglercraft-saves
```

### How syncing works

- Click the profile box at the top of the sidebar to **create an account or sign in**.
  You sign in once per site; after that it remembers you there.
- **Pressing Play** syncs first: if the cloud has newer worlds, they're loaded
  before the game starts.
- **While you play** (inside-launcher mode), changes are backed up every 3 minutes
  and when you switch tabs. **Returning to the launcher** backs up immediately.
- If two sites both changed worlds since their last sync (e.g. you played on two
  sites at once), the launcher asks which copy to keep, with an option to export a
  backup file first. Nothing is overwritten without asking.
- **Settings → Backup file** exports or imports a `.eglsave` file, with or without an account.
- In "Replace page" launch mode the launcher isn't running during play, so your
  worlds are backed up the next time you open the launcher on that site.
- The server keeps the previous upload as `saves/<user-id>.bin.prev` as a safety net.

What gets synced: every IndexedDB database on the site whose name contains
"eagler" (worlds, profile, servers list; resource packs are skipped because they're
large), plus `localStorage` keys containing "eagler" (game settings). If a version
uses other database names, list them in that version's `"databases": ["name"]`.

## versions.json

```json
{
  "versions": [
    {
      "id": "1.8.8",
      "name": "Eaglercraft 1.8.8",
      "type": "release",
      "file": "eaglercraft-1.8.8.html",
      "description": "Shown under the title on the Play screen.",
      "notes": ["Bullet points for the Patch Notes tab"],
      "sizeMB": 14,
      "rev": "1"
    }
  ]
}
```

| Field         | Required | What it does |
|---------------|----------|--------------|
| `id`          | yes      | Unique ID (also shown as the version number). |
| `name`        | yes      | Display name. |
| `file`        | yes      | File name inside `versions/`, **or** a full `https://` URL to a file hosted elsewhere (that host must allow CORS). |
| `type`        | no       | `release`, `old_beta`, `old_alpha`, `snapshot` or `modded`. Betas, alphas and snapshots hide when “Show betas” is unticked. |
| `description` | no       | Subtitle on the Play screen and in Installations. |
| `notes`       | no       | List of strings for the Patch Notes tab. |
| `sizeMB`      | no       | Used for the progress bar if the server doesn't send a file size. |
| `rev`         | no       | Change this when you replace a version's file, so players re-download it instead of using their cached copy. |
| `databases`   | no       | Extra IndexedDB names to include in cloud saves (only needed if they don't contain "eagler"). |

## How it works

- **Bookmarklet** opens an `about:blank` tab and loads `loader.js` from jsDelivr
  (jsDelivr serves it with a JavaScript content type; raw GitHub does not).
- **loader.js** fetches the launcher's HTML, CSS, JS and `versions.json` from
  `raw.githubusercontent.com` and writes them into the blank tab. Launcher
  updates show up within a few minutes of a push.
- **Pressing Play** downloads the version's HTML with a progress bar, stores it
  with the browser's Cache API, then runs it in a full-window frame. Later
  launches open instantly from the cache.
- **◀ Launcher** tab at the top of the screen takes you back (press Esc in-game
  first to free the mouse). Settings has a “Replace page” mode that runs the game
  as the whole tab instead.
- **Open local .html** in the sidebar launches a build from your computer
  without uploading it, which is handy for testing.

## Notes and gotchas

- **Use offline single-file builds.** The launcher expects one self-contained
  `.html` per version (the “offline download” builds). Builds split into
  `classes.js` + `assets.epk` won't work as-is.
- **Don't use Git LFS** for the version files; raw GitHub would return the LFS
  pointer instead of the file. Normal commits are fine up to 100 MB per file.
- **Some sites block bookmarklets.** Pages with a strict Content Security Policy
  (GitHub, Google search and similar) stop the bookmark from loading scripts. The
  tab will say so. Click the bookmark on a simpler page instead.
- **Without an account, saves are tied to the site you clicked the bookmark on.**
  The blank tab shares storage with the page that opened it. Sign in (see Cloud
  saves) to carry worlds between sites.
- **The save server must be reachable from the page.** A few sites restrict which
  servers their pages may talk to; on those, the launcher plays with local saves
  and says cloud saves are unavailable.
- **jsDelivr caches `loader.js`** for up to 12 hours (this update changed it, so purge once after pushing). If you change it, purge it at
  `https://purge.jsdelivr.net/gh/<user>/<repo>@main/loader.js`. Changes to
  everything else apply within a few minutes.
- **Bookmarklets can't run on the browser's new-tab page** or on `chrome://` pages.

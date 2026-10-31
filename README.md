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
sudo cp server/server.js server/package.json /opt/eaglercraft-saves/
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

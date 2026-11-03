'use strict';
/*
 * Mist — account, cloud save and friends server
 * Node 18+, no dependencies. Stores accounts in data/db.json and one save
 * snapshot per account in data/saves/. Put it behind HTTPS (e.g. a Cloudflare Tunnel).
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3100;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SAVES_DIR = path.join(DATA_DIR, 'saves');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_SAVE_BYTES = (+process.env.MAX_SAVE_MB || 256) * 1048576;
const ALLOW_SIGNUPS = process.env.ALLOW_SIGNUPS !== 'false';
const SESSION_DAYS = +process.env.SESSION_DAYS || 180;
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
// Website (the Mist install page) served at "/". Copy the repo's docs/ folder here.
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain' };
async function serveStatic(req, res, p) {
  let rel = decodeURIComponent(p);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\]|\.\.)+/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return false;
  let st; try { st = await fsp.stat(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/* ---------------- storage safety ----------------
 * Accounts used to vanish when the server couldn't write its data folder (it kept running with
 * everything only in memory) or when two copies ran with different data folders. Now:
 *  - it refuses to start if the data folder isn't writable,
 *  - only one server may use a data folder at a time (lock file),
 *  - failed saves are retried, reported on /api/health, and block new sign-ups,
 *  - db.json is backed up on start and every 6 hours (newest 28 kept). */
function fatal(msg) { console.error('\n*** ' + msg + '\n'); process.exit(1); }
try {
  fs.mkdirSync(SAVES_DIR, { recursive: true }); fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, '.write-test-' + process.pid);
  fs.writeFileSync(probe, 'ok'); fs.renameSync(probe, probe + '.x'); fs.unlinkSync(probe + '.x');
  if (fs.existsSync(DB_FILE)) fs.accessSync(DB_FILE, fs.constants.R_OK | fs.constants.W_OK);
} catch (e) {
  fatal(`Can't write to the data folder ${DATA_DIR} (${e.code}). Accounts would be lost on restart.\n` +
        `    Fix: sudo chown -R ${process.env.USER || 'www-data'}:${process.env.USER || 'www-data'} ${DATA_DIR}   (use the user the server runs as)`);
}
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
try {
  const other = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
  if (other && other !== process.pid) {
    let alive = false; try { process.kill(other, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) fatal(`Another Mist server (pid ${other}) is already using ${DATA_DIR}. Stop it first, or two servers will overwrite each other's accounts.`);
  }
} catch (e) { /* no lock yet */ }
fs.writeFileSync(LOCK_FILE, String(process.pid));
const releaseLock = () => { try { if (fs.readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch (e) {} };
process.on('exit', releaseLock);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  if (saveSoonTimer) { clearTimeout(saveSoonTimer); saveSoonTimer = null; saveDb(); } // flush pending changes
  writeChain.finally(() => process.exit(0));
}));

/* ---------------- tiny JSON database ---------------- */
let db = { users: {}, sessions: {}, saves: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') fatal(`Could not read ${DB_FILE}: ${e.message}\n    Restore the newest file from ${BACKUP_DIR} to db.json.`);
}
let storageError = null, writeChain = Promise.resolve(), writeQueued = false, saveSoonTimer = null;
function saveDb() {
  if (writeQueued) return writeChain;          // a write is already waiting; it will include these changes
  writeQueued = true;
  writeChain = writeChain.then(async () => {
    writeQueued = false;
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    for (let attempt = 1; ; attempt++) {
      try {
        const fh = await fsp.open(tmp, 'w');
        try { await fh.writeFile(JSON.stringify(db)); await fh.sync(); } finally { await fh.close(); }
        await fsp.rename(tmp, DB_FILE);
        if (storageError) console.error('Saving works again.');
        storageError = null; return;
      } catch (e) {
        storageError = e.code || e.message;
        console.error(`!!! Could not save ${DB_FILE} (attempt ${attempt}): ${e.message}`);
        if (attempt >= 3) return;
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  });
  return writeChain;
}
function saveDbSoon() { if (!saveSoonTimer) saveSoonTimer = setTimeout(() => { saveSoonTimer = null; saveDb(); }, 15000); }
function backupDb() {
  if (!fs.existsSync(DB_FILE)) return;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  fs.copyFile(DB_FILE, path.join(BACKUP_DIR, 'db-' + stamp + '.json'), err => {
    if (err) return console.error('Backup failed:', err.message);
    const old = fs.readdirSync(BACKUP_DIR).filter(f => /^db-.*\.json$/.test(f)).sort().slice(0, -28);
    old.forEach(f => fs.unlink(path.join(BACKUP_DIR, f), () => {}));
  });
}
backupDb();
setInterval(backupDb, 6 * 3600e3).unref();
console.log(`Data folder: ${DATA_DIR} (${Object.keys(db.users).length} accounts)`);

/* per-user lock so two uploads can't interleave */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/* ---------------- auth helpers ---------------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function scrypt(pw, salt) {
  return new Promise((res, rej) =>
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
}
async function newSession(uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha256(token)] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 };
  await saveDb();
  return token;
}
function authUser(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.sessions[sha256(m[1])];
  if (!s || s.exp < Date.now()) return null;
  const user = Object.values(db.users).find(u => u.id === s.uid);
  return user || null;
}
setInterval(() => {
  let n = 0; const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now) { delete db.sessions[k]; n++; }
  if (n) saveDb();
}, 3600e3).unref();

/* brute-force guard: 20 auth attempts per IP per 10 minutes */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t > 600e3) { h = { t: now, n: 0 }; hits.set(ip, h); }
  return ++h.n > 20;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 600e3) hits.delete(k); }, 600e3).unref();

/* ---------------- http helpers ---------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, X-Save-Hash',
  'Access-Control-Expose-Headers': 'X-Save-Rev, X-Save-Hash, X-Save-Updated',
  'Access-Control-Max-Age': '86400'
};
function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS, extra || {}));
  res.end(body);
}
const fail = (res, status, error) => send(res, status, { error });
function clientIp(req) {
  if (TRUST_PROXY) return req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  return req.socket.remoteAddress;
}
function readJson(req, limit = 16384) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { res(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}
const saveFile = uid => path.join(SAVES_DIR, uid + '.bin');
const publicMeta = m => m ? { rev: m.rev, hash: m.hash, size: m.size, updatedAt: m.updatedAt } : null;

/* ---------------- social: friends, presence, chat ---------------- */
db.social = db.social || {};   // uid -> { friends:[uid], incoming:[uid], outgoing:[uid], recent:[{game,at}], lastSeen }
db.messages = db.messages || {}; // "uidA:uidB" (sorted) -> [{ id, from, text, at }]
db.reads = db.reads || {};       // uid -> { otherUid: lastReadMessageId }
db.msgSeq = db.msgSeq || 0;
const ONLINE_MS = 90e3, MAX_MSGS_PER_CHAT = 300, MAX_FRIENDS = 300;
const presence = new Map();      // uid -> { state: 'online'|'ingame', game, at }  (memory only)
const msgHits = new Map();
const soc = uid => db.social[uid] || (db.social[uid] = { friends: [], incoming: [], outgoing: [], recent: [], lastSeen: 0 });
const userByName = name => db.users[String(name || '').trim().toLowerCase()] || null;
function userById(id) { for (const u of Object.values(db.users)) if (u.id === id) return u; return null; }
const pairKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
const pull = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
function presenceOf(uid) {
  const p = presence.get(uid);
  if (p && Date.now() - p.at < ONLINE_MS) return { state: p.state, game: p.game || null, lastSeen: p.at };
  return { state: 'offline', game: null, lastSeen: soc(uid).lastSeen || 0 };
}
function unreadFrom(me, other) {
  const list = db.messages[pairKey(me, other)] || [];
  const read = (db.reads[me] || {})[other] || 0;
  let n = 0; for (let i = list.length - 1; i >= 0 && list[i].id > read; i--) if (list[i].from !== me) n++;
  return n;
}
function friendView(me, uid) {
  const u = userById(uid); if (!u) return null;
  const pr = presenceOf(uid);
  return { name: u.name, state: pr.state, game: pr.game, lastSeen: pr.lastSeen,
    unread: unreadFrom(me, uid), recent: soc(uid).recent.slice(0, 5).map(r => r.game) };
}
/* ---------------- stats & achievements ---------------- */
db.stats = db.stats || {};       // uid -> { play, perGame:{name:sec}, msgs, days, streak, best, lastDay, saves }
db.ach = db.ach || {};           // uid -> { achievementId: unlockedAt }
db.achNew = db.achNew || {};     // uid -> [achievementId] not yet shown to the player
const H = 3600;
const ACHIEVEMENTS = [
  { id: 'welcome',       icon: '👋', name: 'Welcome to Mist',  desc: 'Create a Mist account.',                  stat: s => 1, goal: 1 , rank: 'common' },
  { id: 'play-10m',      icon: '🎮', name: 'First Steps',      desc: 'Play for 10 minutes.',                    stat: s => s.play, goal: 600, fmt: 'time' , rank: 'common' },
  { id: 'play-1h',       icon: '⏱️', name: 'Getting Comfy',    desc: 'Play for 1 hour in total.',               stat: s => s.play, goal: H, fmt: 'time' , rank: 'common' },
  { id: 'play-10h',      icon: '🔥', name: 'Dedicated',        desc: 'Play for 10 hours in total.',             stat: s => s.play, goal: 10 * H, fmt: 'time' , rank: 'rare' },
  { id: 'play-50h',      icon: '💎', name: 'No Life',          desc: 'Play for 50 hours in total.',             stat: s => s.play, goal: 50 * H, fmt: 'time' , rank: 'epic' },
  { id: 'play-100h',     icon: '👑', name: 'Mist Legend',      desc: 'Play for 100 hours in total.',            stat: s => s.play, goal: 100 * H, fmt: 'time' , rank: 'legendary' },
  { id: 'one-game-2h',   icon: '🏃', name: 'Marathon',         desc: 'Spend 2 hours in a single game.',         stat: s => maxGame(s), goal: 2 * H, fmt: 'time' , rank: 'rare' },
  { id: 'one-game-10h',  icon: '🎯', name: 'Obsessed',         desc: 'Spend 10 hours in a single game.',        stat: s => maxGame(s), goal: 10 * H, fmt: 'time' , rank: 'epic' },
  { id: 'games-5',       icon: '🧭', name: 'Explorer',         desc: 'Play 5 different games.',                 stat: s => Object.keys(s.perGame).length, goal: 5 , rank: 'common' },
  { id: 'games-15',      icon: '🗺️', name: 'Game Hopper',      desc: 'Play 15 different games.',                stat: s => Object.keys(s.perGame).length, goal: 15 , rank: 'rare' },
  { id: 'games-40',      icon: '📚', name: 'Connoisseur',      desc: 'Play 40 different games.',                stat: s => Object.keys(s.perGame).length, goal: 40 , rank: 'epic' },
  { id: 'friends-1',     icon: '🤝', name: 'First Friend',     desc: 'Make your first friend.',                 stat: (s, u) => soc(u).friends.length, goal: 1 , rank: 'common' },
  { id: 'friends-5',     icon: '👥', name: 'Squad Up',         desc: 'Have 5 friends.',                         stat: (s, u) => soc(u).friends.length, goal: 5 , rank: 'rare' },
  { id: 'friends-15',    icon: '🌟', name: 'Popular',          desc: 'Have 15 friends.',                        stat: (s, u) => soc(u).friends.length, goal: 15 , rank: 'epic' },
  { id: 'msg-1',         icon: '💬', name: 'Hello!',           desc: 'Send your first chat message.',           stat: s => s.msgs, goal: 1 , rank: 'common' },
  { id: 'msg-100',       icon: '🗣️', name: 'Chatterbox',       desc: 'Send 100 chat messages.',                 stat: s => s.msgs, goal: 100 , rank: 'rare' },
  { id: 'streak-3',      icon: '📅', name: 'Regular',          desc: 'Open Mist 3 days in a row.',              stat: s => s.best, goal: 3 , rank: 'common' },
  { id: 'streak-7',      icon: '🗓️', name: 'Weekly Warrior',   desc: 'Open Mist 7 days in a row.',              stat: s => s.best, goal: 7 , rank: 'rare' },
  { id: 'days-30',       icon: '🏅', name: 'Veteran',          desc: 'Open Mist on 30 different days.',         stat: s => s.days, goal: 30 , rank: 'epic' },
  { id: 'cloud-1',       icon: '☁️', name: 'Cloud Saver',      desc: 'Back up your worlds to the cloud.',       stat: s => s.saves, goal: 1 , rank: 'common' },
];
const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
const maxGame = s => Object.values(s.perGame).reduce((m, v) => Math.max(m, v), 0);
const stats = uid => db.stats[uid] || (db.stats[uid] = { play: 0, perGame: {}, msgs: 0, days: 0, streak: 0, best: 0, lastDay: '', saves: 0 });
const dayKey = t => new Date(t).toISOString().slice(0, 10);
function checkAch(uid) {
  const st = stats(uid), got = db.ach[uid] || (db.ach[uid] = {}), now = Date.now(), fresh = [];
  for (const a of ACHIEVEMENTS) if (!got[a.id] && a.stat(st, uid) >= a.goal) { got[a.id] = now; fresh.push(a.id); }
  if (fresh.length) { (db.achNew[uid] = db.achNew[uid] || []).push(...fresh); saveDb(); }
  return fresh;
}
/* Per-game achievements: ten playtime achievements for every game. */
db.gameAch = db.gameAch || {};   // uid -> { gameName: { tierId: unlockedAt } }
const M = 60;
const GAME_TIERS = [
  { id: 'm5',   icon: '🌱', name: 'First Look',       goal: 5 * M,   label: '5 minutes' , rank: 'common' },
  { id: 'm15',  icon: '🎈', name: 'Warming Up',       goal: 15 * M,  label: '15 minutes' , rank: 'common' },
  { id: 'm30',  icon: '🎯', name: 'Getting the Hang', goal: 30 * M,  label: '30 minutes' , rank: 'common' },
  { id: 'h1',   icon: '🪝', name: 'Hooked',           goal: H,       label: '1 hour' , rank: 'rare' },
  { id: 'h2',   icon: '🎮', name: 'Regular',          goal: 2 * H,   label: '2 hours' , rank: 'rare' },
  { id: 'h5',   icon: '💪', name: 'Dedicated',        goal: 5 * H,   label: '5 hours' , rank: 'epic' },
  { id: 'h10',  icon: '🛡️', name: 'Veteran',          goal: 10 * H,  label: '10 hours' , rank: 'legendary' },
];
// Convert badges from the earlier 4-badge version (bronze/silver/gold/platinum): keep the dates
// where a matching achievement exists, then fill in the rest from playtime.
(function migrateOldBadges() {
  const map = { bronze: ['m5'], silver: ['h1'], gold: ['h5'], platinum: [] };
  let changed = 0;
  for (const games of Object.values(db.gameAch)) for (const tiers of Object.values(games)) {
    for (const [old, news] of Object.entries(map)) if (tiers[old]) {
      for (const n of news) if (!tiers[n]) tiers[n] = tiers[old];
      delete tiers[old]; changed++;
    }
  }
  // The 25h/50h/100h per-game tiers were removed: drop them so counts and XP match what's shown.
  for (const games of Object.values(db.gameAch)) for (const tiers of Object.values(games)) for (const id of ['h25', 'h50', 'h100']) if (tiers[id]) { delete tiers[id]; changed++; }
  if (changed) { console.log(`Updated ${changed} old game badge(s) to the current 7-per-game set.`); saveDbSoon(); }
})();
const TIER_BY_ID = Object.fromEntries(GAME_TIERS.map(t => [t.id, t]));
function checkGameAch(uid, game, notify = true) {
  const sec = stats(uid).perGame[game] || 0, all = db.gameAch[uid] || (db.gameAch[uid] = {}), got = all[game] || (all[game] = {});
  const fresh = [];
  for (const t of GAME_TIERS) if (!got[t.id] && sec >= t.goal) { got[t.id] = Date.now(); fresh.push('g:' + t.id + ':' + game); }
  if (fresh.length) { if (notify) (db.achNew[uid] = db.achNew[uid] || []).push(...fresh); saveDb(); }
  return fresh;
}
function takeNewAch(uid) {
  const ids = db.achNew[uid]; if (!ids || !ids.length) return [];
  delete db.achNew[uid]; saveDbSoon();
  return ids.map(id => {
    if (id.startsWith('x:')) {
      const [, aid, ...rest] = id.split(':'), game = rest.join(':'), a = achDefs(game).find(x => x.id === aid);
      return a && { id, icon: a.icon, name: game + ': ' + a.name, desc: a.desc, game, rank: a.rank, xp: RANK_XP[a.rank] };
    }
    if (id.startsWith('g:')) {
      const [, tier, ...rest] = id.split(':'), game = rest.join(':'), t = TIER_BY_ID[tier];
      return t && { id, icon: t.icon, name: game + ': ' + t.name, desc: 'Play ' + game + ' for ' + t.label + '.', game, rank: t.rank, xp: RANK_XP[t.rank] };
    }
    const a = ACH_BY_ID[id]; return a && { id: a.id, icon: a.icon, name: a.name, desc: a.desc, rank: a.rank, xp: RANK_XP[a.rank] };
  }).filter(Boolean);
}
/* ---------------- game hooks ----------------
 * Mist reads progress from a few games while they run (see launcher/hooks.js) and reports numbers
 * here. Each stat only ever goes up. These achievements sit alongside each game's 10 playtime ones. */
db.gstats = db.gstats || {};     // uid -> { gameName: { statKey: number } }
db.hookAch = db.hookAch || {};   // uid -> { gameName: { achId: unlockedAt } }
const fnafNights = (n, extra) => {
  const list = [];
  for (let i = 1; i <= n; i++) list.push({ id: 'night' + i, icon: i === 5 ? '🌅' : '🌙', name: 'Night ' + i, desc: 'Survive night ' + i + '.', stat: 'night' + i, goal: 1,
    rank: i === n ? 'legendary' : i === n - 1 ? 'epic' : i <= 2 ? 'common' : 'rare' });
  return list.concat(extra || []);
};
const HOOK_RANKS = {   // anything not listed is common
  'Eaglercraft': { diamonds: 'rare', nether: 'rare', blaze: 'rare', enchant: 'rare', ghast: 'epic', brew: 'epic', sniper: 'epic', end: 'epic', dragon: 'legendary' },
  'YoHoHo.io': { sailor: 'rare', win: 'rare', best5: 'rare', win10: 'epic', kills100: 'epic' },
  'Polytrack': { track5: 'rare', builder: 'rare', track10: 'epic' },
  'Bloons TD 5': { medal10: 'rare', xp25k: 'rare', mission: 'rare', challenge: 'rare', medal25: 'epic', xp100k: 'legendary' },
  'Cookie Clicker': { click1000: 'rare', bake1m: 'rare', bld100: 'rare', bake1b: 'epic', bld500: 'epic', cps1m: 'epic', golden50: 'epic', ach50: 'epic', ascend: 'epic', bake1t: 'legendary' },
  'Slope': { s100: 'rare', s200: 'epic', s400: 'legendary' },
};
/* Basic achievements every game gets, tracked by the server from play sessions. */
const GENERIC_ACH = [
  { id: 'days3', icon: '📆', name: 'Coming Back', desc: 'Play this game on 3 different days.', stat: '_days', goal: 3, rank: 'common', basic: true },
  { id: 'days7', icon: '🗓️', name: 'Weekly Habit', desc: 'Play this game on 7 different days.', stat: '_days', goal: 7, rank: 'rare', basic: true },
  { id: 'launch25', icon: '🔁', name: 'Frequent Flyer', desc: 'Launch this game 25 times.', stat: '_launches', goal: 25, rank: 'rare', basic: true },
];
const HOOK_ACH = {
  'Eaglercraft': [
    { id: 'wood', icon: '🪵', name: 'Getting Wood', desc: 'Punch a tree until a block of wood pops out.', stat: 'mineWood', goal: 1 },
    { id: 'mine', icon: '⛏️', name: 'Time to Mine!', desc: 'Make a pickaxe (1.12: mine stone).', stat: 'buildPickaxe', goal: 1 },
    { id: 'upgrade', icon: '🪨', name: 'Getting an Upgrade', desc: 'Make a better pickaxe.', stat: 'buildBetterPickaxe', goal: 1 },
    { id: 'iron', icon: '🔩', name: 'Acquire Hardware', desc: 'Smelt an iron ingot.', stat: 'acquireIron', goal: 1 },
    { id: 'hunter', icon: '🗡️', name: 'Monster Hunter', desc: 'Kill a hostile monster.', stat: 'killEnemy', goal: 1 },
    { id: 'breed', icon: '🐄', name: 'Repopulation', desc: 'Breed two animals.', stat: 'breedCow', goal: 1 },
    { id: 'diamonds', icon: '💎', name: 'DIAMONDS!', desc: 'Find diamonds.', stat: 'diamonds', goal: 1 },
    { id: 'nether', icon: '🔥', name: 'We Need to Go Deeper', desc: 'Enter the Nether.', stat: 'portal', goal: 1 },
    { id: 'ghast', icon: '👻', name: 'Return to Sender', desc: 'Kill a ghast with its own fireball.', stat: 'ghast', goal: 1 },
    { id: 'blaze', icon: '🔥', name: 'Into Fire', desc: 'Get a blaze rod.', stat: 'blazeRod', goal: 1 },
    { id: 'brew', icon: '🧪', name: 'Local Brewery', desc: 'Brew a potion.', stat: 'potion', goal: 1 },
    { id: 'enchant', icon: '📖', name: 'Enchanter', desc: 'Enchant an item.', stat: 'enchantments', goal: 1 },
    { id: 'sniper', icon: '🏹', name: 'Sniper Duel', desc: 'Kill a skeleton with an arrow from far away.', stat: 'snipeSkeleton', goal: 1 },
    { id: 'end', icon: '🌌', name: 'The End?', desc: 'Enter the End.', stat: 'theEnd', goal: 1 },
    { id: 'dragon', icon: '🐉', name: 'The End.', desc: 'Defeat the Ender Dragon.', stat: 'theEnd2', goal: 1 },
  ],
  'YoHoHo.io': [
    { id: 'sail', icon: '⛵', name: 'Set Sail', desc: 'Start your first game.', stat: 'gamesStarted', goal: 1 },
    { id: 'sailor', icon: '🧭', name: 'Seasoned Sailor', desc: 'Start 25 games.', stat: 'gamesStarted', goal: 25 },
    { id: 'win', icon: '🏴‍☠️', name: 'Captain', desc: 'Win a game.', stat: 'totalWins', goal: 1 },
    { id: 'win10', icon: '👑', name: 'Pirate King', desc: 'Win 10 games.', stat: 'totalWins', goal: 10 },
    { id: 'kills10', icon: '⚔️', name: 'Swashbuckler', desc: 'Get 10 kills in total.', stat: 'totalKills', goal: 10 },
    { id: 'kills100', icon: '☠️', name: 'Terror of the Seas', desc: 'Get 100 kills in total.', stat: 'totalKills', goal: 100 },
    { id: 'best5', icon: '💥', name: 'Rampage', desc: 'Get 5 kills in one game.', stat: 'bestKills', goal: 5 },
  ],
  'Polytrack': [
    { id: 'tutorial', icon: '🚦', name: 'Learner’s Permit', desc: 'Finish the tutorial.', stat: 'tutorial', goal: 1 },
    { id: 'track1', icon: '🏁', name: 'Finish Line', desc: 'Set a record on a track.', stat: 'records', goal: 1 },
    { id: 'track5', icon: '🛣️', name: 'Road Trip', desc: 'Set records on 5 tracks.', stat: 'records', goal: 5 },
    { id: 'track10', icon: '🏎️', name: 'Track Star', desc: 'Set records on 10 tracks.', stat: 'records', goal: 10 },
    { id: 'builder', icon: '🏗️', name: 'Track Builder', desc: 'Save a track you built.', stat: 'customTracks', goal: 1 },
  ],
  'Bloons TD 5': [
    { id: 'medal1', icon: '🥇', name: 'First Medal', desc: 'Earn a medal on any track.', stat: 'medals', goal: 1 },
    { id: 'medal10', icon: '🎖️', name: 'Medal Collector', desc: 'Earn medals on 10 tracks.', stat: 'medals', goal: 10 },
    { id: 'medal25', icon: '🏅', name: 'Decorated Monkey', desc: 'Earn medals on 25 tracks.', stat: 'medals', goal: 25 },
    { id: 'xp1k', icon: '📈', name: 'Rising Rank', desc: 'Earn 1,000 XP.', stat: 'xp', goal: 1000 },
    { id: 'xp25k', icon: '🎯', name: 'Seasoned Strategist', desc: 'Earn 25,000 XP.', stat: 'xp', goal: 25000 },
    { id: 'xp100k', icon: '🐵', name: 'Monkey Master', desc: 'Earn 100,000 XP.', stat: 'xp', goal: 100000 },
    { id: 'towers5', icon: '🗼', name: 'Varied Arsenal', desc: 'Use 5 different towers.', stat: 'towers', goal: 5 },
    { id: 'mission', icon: '🕵️', name: 'Special Agent', desc: 'Complete a special mission.', stat: 'missions', goal: 1 },
    { id: 'challenge', icon: '🧩', name: 'Challenger', desc: 'Complete a daily challenge.', stat: 'challenges', goal: 1 },
  ],
  'Cookie Clicker': [
    { id: 'click100', icon: '👆', name: 'Clicktastic', desc: 'Click the big cookie 100 times.', stat: 'clicks', goal: 100 },
    { id: 'click1000', icon: '🖱️', name: 'Clickathon', desc: 'Click the big cookie 1,000 times.', stat: 'clicks', goal: 1000 },
    { id: 'bake1k', icon: '🍪', name: 'Wake and Bake', desc: 'Bake 1,000 cookies in total.', stat: 'baked', goal: 1e3 },
    { id: 'bake1m', icon: '🥠', name: 'Millionaire Baker', desc: 'Bake 1 million cookies in total.', stat: 'baked', goal: 1e6 },
    { id: 'bake1b', icon: '🧁', name: 'Billionaire Baker', desc: 'Bake 1 billion cookies in total.', stat: 'baked', goal: 1e9 },
    { id: 'bake1t', icon: '🎂', name: 'Cookie Tycoon', desc: 'Bake 1 trillion cookies in total.', stat: 'baked', goal: 1e12 },
    { id: 'bld10', icon: '🏠', name: 'Small Business', desc: 'Own 10 buildings.', stat: 'buildings', goal: 10 },
    { id: 'bld100', icon: '🏭', name: 'Cookie Factory', desc: 'Own 100 buildings.', stat: 'buildings', goal: 100 },
    { id: 'bld500', icon: '🌆', name: 'Cookie Empire', desc: 'Own 500 buildings.', stat: 'buildings', goal: 500 },
    { id: 'cps100', icon: '💨', name: 'Steady Stream', desc: 'Make 100 cookies per second.', stat: 'cps', goal: 100 },
    { id: 'cps1m', icon: '🌪️', name: 'Cookie Torrent', desc: 'Make 1 million cookies per second.', stat: 'cps', goal: 1e6 },
    { id: 'golden1', icon: '✨', name: 'Lucky Find', desc: 'Click a golden cookie.', stat: 'golden', goal: 1 },
    { id: 'golden50', icon: '🌟', name: 'Golden Touch', desc: 'Click 50 golden cookies.', stat: 'golden', goal: 50 },
    { id: 'ach50', icon: '🏆', name: 'Overachiever', desc: 'Unlock 50 of Cookie Clicker’s own achievements.', stat: 'achievements', goal: 50 },
    { id: 'ascend', icon: '👼', name: 'Ascended', desc: 'Ascend for the first time.', stat: 'ascensions', goal: 1 },
  ],
  'Slope': [
    { id: 's25', icon: '🟢', name: 'Downhill', desc: 'Reach a best score of 25.', stat: 'best', goal: 25 },
    { id: 's50', icon: '🔵', name: 'Gaining Speed', desc: 'Reach a best score of 50.', stat: 'best', goal: 50 },
    { id: 's100', icon: '🟣', name: 'Centurion', desc: 'Reach a best score of 100.', stat: 'best', goal: 100 },
    { id: 's200', icon: '🔴', name: 'Neon Rider', desc: 'Reach a best score of 200.', stat: 'best', goal: 200 },
    { id: 's400', icon: '⚫', name: 'Slope Master', desc: 'Reach a best score of 400.', stat: 'best', goal: 400 },
  ],
  "Five Nights at Freddy's": fnafNights(6),
  "Five Nights at Freddy's 2": fnafNights(6),
  "Five Nights at Freddy's 3": fnafNights(6),
  "Five Nights at Freddy's 4": fnafNights(6),
  'FNAF: Sister Location': fnafNights(5),
  /* ---- batch 1 ---- */
  '2048': [
    { id: 't256', icon: '🟨', name: 'Getting Started', desc: 'Make a 256 tile.', stat: 'tile', goal: 256, rank: 'common' },
    { id: 't512', icon: '🟧', name: 'Halfway There', desc: 'Make a 512 tile.', stat: 'tile', goal: 512, rank: 'common' },
    { id: 't1024', icon: '🟥', name: 'So Close', desc: 'Make a 1024 tile.', stat: 'tile', goal: 1024, rank: 'rare' },
    { id: 't2048', icon: '🏆', name: '2048!', desc: 'Make the 2048 tile.', stat: 'tile', goal: 2048, rank: 'epic' },
    { id: 't4096', icon: '👑', name: 'Beyond 2048', desc: 'Make a 4096 tile.', stat: 'tile', goal: 4096, rank: 'legendary' },
    { id: 's5k', icon: '📈', name: 'High Scorer', desc: 'Score 5,000 points in one game.', stat: 'best', goal: 5000, rank: 'common' },
    { id: 's20k', icon: '💯', name: 'Number Cruncher', desc: 'Score 20,000 points in one game.', stat: 'best', goal: 20000, rank: 'rare' },
  ],
  'OvO': [
    { id: 'l5', icon: '🟦', name: 'Warming Up', desc: 'Reach level 5.', stat: 'level', goal: 5, rank: 'common' },
    { id: 'l15', icon: '🏃', name: 'Parkour Pro', desc: 'Reach level 15.', stat: 'level', goal: 15, rank: 'common' },
    { id: 'l30', icon: '⚡', name: 'Speedy', desc: 'Reach level 30.', stat: 'level', goal: 30, rank: 'rare' },
    { id: 'l45', icon: '🔥', name: 'Unstoppable', desc: 'Reach level 45.', stat: 'level', goal: 45, rank: 'epic' },
    { id: 'c1', icon: '🪙', name: 'Shiny', desc: 'Collect a hidden coin.', stat: 'coins', goal: 1, rank: 'common' },
    { id: 'c5', icon: '💰', name: 'Coin Hunter', desc: 'Collect 5 hidden coins.', stat: 'coins', goal: 5, rank: 'rare' },
    { id: 'c40', icon: '🤑', name: 'Coin God', desc: 'Collect 40 hidden coins.', stat: 'coins', goal: 40, rank: 'legendary' },
    { id: 'g1', icon: '🥇', name: 'Gold Time', desc: 'Earn a gold medal.', stat: 'gold', goal: 1, rank: 'rare' },
    { id: 'g10', icon: '🏅', name: 'Golden Runner', desc: 'Earn 10 gold medals.', stat: 'gold', goal: 10, rank: 'epic' },
  ],
  'Drift Boss': [
    { id: 's100', icon: '🚗', name: 'Drifter', desc: 'Score 100 points.', stat: 'score', goal: 100, rank: 'common' },
    { id: 's500', icon: '💨', name: 'Smooth Operator', desc: 'Score 500 points.', stat: 'score', goal: 500, rank: 'rare' },
    { id: 's1000', icon: '🔥', name: 'Drift King', desc: 'Score 1,000 points.', stat: 'score', goal: 1000, rank: 'epic' },
    { id: 's2500', icon: '👑', name: 'Drift Boss', desc: 'Score 2,500 points.', stat: 'score', goal: 2500, rank: 'legendary' },
    { id: 'c500', icon: '🪙', name: 'Coin Collector', desc: 'Collect 500 coins.', stat: 'coins', goal: 500, rank: 'common' },
    { id: 'car3', icon: '🏎️', name: 'Garage', desc: 'Own 3 cars.', stat: 'cars', goal: 3, rank: 'rare' },
    { id: 'car8', icon: '🏁', name: 'Car Collector', desc: 'Own 8 cars.', stat: 'cars', goal: 8, rank: 'epic' },
  ],
  'Temple Run 2': [
    { id: 'g10', icon: '🏃', name: 'Runner', desc: 'Play 10 runs.', stat: 'games', goal: 10, rank: 'common' },
    { id: 'g100', icon: '👟', name: 'Marathoner', desc: 'Play 100 runs.', stat: 'games', goal: 100, rank: 'rare' },
    { id: 's100k', icon: '📈', name: 'Treasure Seeker', desc: 'Score 100,000 in one run.', stat: 'score', goal: 1e5, rank: 'common' },
    { id: 's1m', icon: '💎', name: 'Millionaire Explorer', desc: 'Score 1,000,000 in one run.', stat: 'score', goal: 1e6, rank: 'epic' },
    { id: 'r2k', icon: '🛤️', name: 'Long Way', desc: 'Run 2,000 m in one run.', stat: 'run', goal: 2000, rank: 'rare' },
    { id: 'r5k', icon: '🌋', name: 'Escape Artist', desc: 'Run 5,000 m in one run.', stat: 'run', goal: 5000, rank: 'legendary' },
    { id: 'd50k', icon: '🗺️', name: 'World Traveller', desc: 'Run 50,000 m in total.', stat: 'distance', goal: 5e4, rank: 'rare' },
    { id: 'c10k', icon: '🪙', name: 'Gold Hoard', desc: 'Collect 10,000 coins in total.', stat: 'coins', goal: 1e4, rank: 'epic' },
  ],
  'Vex 5': [
    { id: 'l1', icon: '🟢', name: 'First Act', desc: 'Finish your first level.', stat: 'levels', goal: 1, rank: 'common' },
    { id: 'l5', icon: '🧗', name: 'Halfway Vexed', desc: 'Finish 5 levels.', stat: 'levels', goal: 5, rank: 'rare' },
    { id: 'l11', icon: '🏆', name: 'Vex Champion', desc: 'Finish every level.', stat: 'levels', goal: 11, rank: 'epic' },
    { id: 'a5', icon: '⭐', name: 'Achiever', desc: 'Unlock 5 of Vex 5’s own achievements.', stat: 'achievements', goal: 5, rank: 'common' },
    { id: 'a20', icon: '🌟', name: 'Star Collector', desc: 'Unlock 20 of Vex 5’s own achievements.', stat: 'achievements', goal: 20, rank: 'epic' },
    { id: 'a40', icon: '👑', name: 'Perfectionist', desc: 'Unlock all 40 of Vex 5’s own achievements.', stat: 'achievements', goal: 40, rank: 'legendary' },
    { id: 'd100', icon: '💀', name: 'Persistent', desc: 'Die 100 times.', stat: 'deaths', goal: 100, rank: 'common' },
  ],
  'Idle Breakout': [
    { id: 'l10', icon: '🧱', name: 'Brick Breaker', desc: 'Reach level 10.', stat: 'level', goal: 10, rank: 'common' },
    { id: 'l50', icon: '🔨', name: 'Demolition Crew', desc: 'Reach level 50.', stat: 'level', goal: 50, rank: 'rare' },
    { id: 'l100', icon: '🏗️', name: 'Wrecking Ball', desc: 'Reach level 100.', stat: 'level', goal: 100, rank: 'epic' },
    { id: 'p1', icon: '✨', name: 'Prestige', desc: 'Prestige for the first time.', stat: 'prestige', goal: 1, rank: 'rare' },
    { id: 'click1k', icon: '👆', name: 'Hands On', desc: 'Click 1,000 bricks.', stat: 'clicks', goal: 1000, rank: 'common' },
    { id: 'a6', icon: '🏅', name: 'Half the Trophies', desc: 'Unlock 6 of Idle Breakout’s own achievements.', stat: 'achievements', goal: 6, rank: 'rare' },
    { id: 'a12', icon: '👑', name: 'Breakout Legend', desc: 'Unlock all 12 of Idle Breakout’s own achievements.', stat: 'achievements', goal: 12, rank: 'legendary' },
  ],
  'Geometry Dash Lite': [
    { id: 'stereo', icon: '🎵', name: 'Stereo Madness', desc: 'Beat Stereo Madness in normal mode.', stat: 'stereo', goal: 1, rank: 'common' },
    { id: 'lv3', icon: '🔷', name: 'On Track', desc: 'Beat 3 levels in normal mode.', stat: 'levels', goal: 3, rank: 'rare' },
    { id: 'lv7', icon: '🔶', name: 'Time Machine', desc: 'Beat 7 levels in normal mode.', stat: 'levels', goal: 7, rank: 'epic' },
    { id: 'lv15', icon: '👑', name: 'Geometry Master', desc: 'Beat every level in normal mode.', stat: 'levels', goal: 15, rank: 'legendary' },
    { id: 'coin3', icon: '🪙', name: 'Secret Coins', desc: 'Collect 3 secret coins.', stat: 'coins', goal: 3, rank: 'rare' },
    { id: 'att100', icon: '🔁', name: 'Try Again', desc: 'Make 100 attempts.', stat: 'attempts', goal: 100, rank: 'common' },
    { id: 'att1k', icon: '😤', name: 'Never Give Up', desc: 'Make 1,000 attempts.', stat: 'attempts', goal: 1000, rank: 'rare' },
    { id: 'j5k', icon: '⬆️', name: 'Jumper', desc: 'Jump 5,000 times.', stat: 'jumps', goal: 5000, rank: 'common' },
  ],
  'Tunnel Rush': [
    { id: 'd1k', icon: '🌀', name: 'Into the Tunnel', desc: 'Reach a distance of 1,000.', stat: 'distance', goal: 1000, rank: 'common' },
    { id: 'd2500', icon: '💫', name: 'Dizzy', desc: 'Reach a distance of 2,500.', stat: 'distance', goal: 2500, rank: 'rare' },
    { id: 'd5k', icon: '🚀', name: 'Hyperspeed', desc: 'Reach a distance of 5,000.', stat: 'distance', goal: 5000, rank: 'epic' },
    { id: 'd10k', icon: '👑', name: 'Tunnel Master', desc: 'Reach a distance of 10,000.', stat: 'distance', goal: 10000, rank: 'legendary' },
  ],
  'Snow Rider 3D': [
    { id: 'p10', icon: '🛷', name: 'Sledder', desc: 'Go sledding 10 times.', stat: 'plays', goal: 10, rank: 'common' },
    { id: 'p50', icon: '❄️', name: 'Snow Day', desc: 'Go sledding 50 times.', stat: 'plays', goal: 50, rank: 'rare' },
    { id: 'p200', icon: '🏔️', name: 'Winter Legend', desc: 'Go sledding 200 times.', stat: 'plays', goal: 200, rank: 'epic' },
    { id: 'skin', icon: '🎨', name: 'New Ride', desc: 'Switch to a different sled.', stat: 'skin', goal: 1, rank: 'common' },
  ],
};
for (const [g, defs] of Object.entries(HOOK_ACH)) for (const a of defs) if (!a.rank) a.rank = (HOOK_RANKS[g] || {})[a.id] || 'common';
const achDefs = game => GENERIC_ACH.concat(HOOK_ACH[game] || []);
/* Count a launch / play day for a game (called when a play session starts). */
function noteSession(uid, game, now) {
  const all = db.gstats[uid] || (db.gstats[uid] = {}), st = all[game] || (all[game] = {});
  st._launches = (st._launches || 0) + 1;
  const day = dayKey(now); if (st._lastDay !== day) { st._lastDay = day; st._days = (st._days || 0) + 1; }
  saveDbSoon(); checkHookAch(uid, game);
}
function hookList(game, uid) {
  const defs = achDefs(game);
  const got = ((db.hookAch[uid] || {})[game]) || {}, st = ((db.gstats[uid] || {})[game]) || {}, r = rarity();
  return defs.map(a => {
    const o = { id: 'h:' + a.id, icon: a.icon, name: a.name, desc: a.desc, goal: a.goal, special: true, rank: a.rank, basic: !!a.basic,
      unlocked: got[a.id] || null, rarity: pct(((r.hooks[game] || {})[a.id]), r.players) };
    if (!o.unlocked && a.goal > 1) o.progress = Math.min(a.goal, st[a.stat] || 0);
    return o;
  });
}
function checkHookAch(uid, game) {
  const defs = achDefs(game);
  const st = ((db.gstats[uid] || {})[game]) || {}, all = db.hookAch[uid] || (db.hookAch[uid] = {}), got = all[game] || (all[game] = {});
  const fresh = [];
  for (const a of defs) if (!got[a.id] && (st[a.stat] || 0) >= a.goal) { got[a.id] = Date.now(); fresh.push('x:' + a.id + ':' + game); }
  if (fresh.length) { (db.achNew[uid] = db.achNew[uid] || []).push(...fresh); saveDb(); }
  return fresh;
}
const hookCount = uid => Object.values(db.hookAch[uid] || {}).reduce((n, g) => n + Object.keys(g).length, 0);

/* How many players have each achievement (cached for a minute). */
let rarityCache = null, rarityAt = 0;
function rarity() {
  if (rarityCache && Date.now() - rarityAt < 60e3) return rarityCache;
  const players = Math.max(1, Object.keys(db.users).length), general = {}, games = {};
  for (const u of Object.values(db.users)) {
    for (const id of Object.keys(db.ach[u.id] || {})) general[id] = (general[id] || 0) + 1;
    for (const [g, tiers] of Object.entries(db.gameAch[u.id] || {})) {
      const row = games[g] || (games[g] = { players: 0 });
      if (stats(u.id).perGame[g]) row.players++;
      for (const t of Object.keys(tiers)) row[t] = (row[t] || 0) + 1;
    }
  }
  const hooks = {};
  for (const u of Object.values(db.users)) for (const [g, a] of Object.entries(db.hookAch[u.id] || {})) {
    const row = hooks[g] || (hooks[g] = {}); for (const id of Object.keys(a)) row[id] = (row[id] || 0) + 1;
  }
  rarityCache = { players, general, games, hooks }; rarityAt = Date.now();
  return rarityCache;
}
const pct = (n, of) => Math.round(1000 * (n || 0) / Math.max(1, of)) / 10;
function tierList(game, got, sec) {
  const r = rarity();
  return GAME_TIERS.map(t => {
    const o = { id: t.id, icon: t.icon, name: t.name, desc: 'Play ' + game + ' for ' + t.label + '.', label: t.label, goal: t.goal, rank: t.rank,
      unlocked: got[t.id] || null, rarity: pct((r.games[game] || {})[t.id], r.players) };
    if (sec !== null && sec !== undefined && !o.unlocked) o.progress = Math.min(t.goal, Math.round(sec));
    return o;
  });
}
function gameList(uid, withProgress) {
  const st = stats(uid), all = db.gameAch[uid] || {}, r = rarity(), recent = {};
  for (const x of soc(uid).recent) recent[x.game] = x.at;
  const per = Object.assign({}, st.perGame);
  for (const g of Object.keys((db.gstats && db.gstats[uid]) || {})) if (!(g in per) && Object.keys(db.gstats[uid][g]).some(k => k[0] !== '_')) per[g] = 0;   // challenge progress before the first playtime ping
  return Object.entries(per).sort((a, b) => b[1] - a[1]).map(([game, sec]) => {
    const got = all[game] || {}, next = GAME_TIERS.find(t => !got[t.id]);
    return {
      name: game, seconds: Math.round(sec), lastPlayed: recent[game] || null,
      tiers: tierList(game, got, withProgress ? sec : null),
      special: hookList(game, uid),
      next: withProgress && next ? { name: next.name, goal: next.goal, progress: Math.min(next.goal, Math.round(sec)) } : null
    };
  });
}
function markActiveDay(uid, now) {
  const st = stats(uid), today = dayKey(now);
  if (st.lastDay === today) return false;
  st.streak = st.lastDay === dayKey(now - 864e5) ? st.streak + 1 : 1;
  st.best = Math.max(st.best, st.streak); st.days++; st.lastDay = today;
  return true;
}
function achList(uid, withProgress) {
  const st = stats(uid), got = db.ach[uid] || {};
  return ACHIEVEMENTS.map(a => {
    const o = { id: a.id, icon: a.icon, name: a.name, desc: a.desc, rank: a.rank, unlocked: got[a.id] || null, rarity: pct(rarity().general[a.id], rarity().players),
      goal: a.goal, fmt: a.fmt || null };
    if (withProgress && !o.unlocked) o.progress = Math.min(a.goal, a.stat(st, uid));
    return o;
  });
}
/* XP and levels. Each achievement gives XP by rarity. There are 50 levels; they are rescaled automatically so that
 * level 50 means every achievement for every game in versions.json is unlocked. */
const RANK_XP = { common: 100, rare: 250, epic: 500, legendary: 1000 };
const MAX_LEVEL = 50;
let GAME_NAMES = null, LEVELS = null;                    // from versions.json (local copy, else GitHub)
const VERSIONS_URL = process.env.VERSIONS_URL || 'https://raw.githubusercontent.com/th3nu8/EaglercraftLauncher/main/versions.json';
function setGames(json) {
  try { const v = JSON.parse(json); const list = (v.games || v).map(g => g.name).filter(Boolean); if (list.length) { GAME_NAMES = list; LEVELS = null; } } catch (e) {}
}
function loadGames() {
  for (const f of [path.join(PUBLIC_DIR, 'versions.json'), path.join(__dirname, '..', 'versions.json')]) {
    try { setGames(fs.readFileSync(f, 'utf8')); if (GAME_NAMES) return; } catch (e) {}
  }
  if (typeof fetch === 'function') fetch(VERSIONS_URL).then(r => r.ok ? r.text() : '').then(setGames).catch(() => {});
}
loadGames(); setInterval(loadGames, 6 * 3600e3).unref();
const sumXp = list => list.reduce((n, a) => n + RANK_XP[a.rank], 0);
function totalXp() {
  const names = GAME_NAMES || [], perGame = sumXp(GAME_TIERS) + sumXp(GENERIC_ACH);
  let t = sumXp(ACHIEVEMENTS) + Math.max(names.length, 345) * perGame;
  for (const [g, defs] of Object.entries(HOOK_ACH)) t += sumXp(defs);
  return t;
}
/* Level curve: each level costs more than the last (roughly 1 : 60 from level 1 to 50), rounded to 50 XP. */
function levels() {
  if (LEVELS) return LEVELS;
  const total = totalXp(), w = []; for (let i = 1; i <= MAX_LEVEL; i++) w.push(Math.pow(i + 3, 1.6));
  const sw = w.reduce((a, b) => a + b, 0); let acc = 0;
  LEVELS = w.map((x, i) => { if (i === MAX_LEVEL - 1) return total - acc; const v = Math.max(50, Math.round(total * x / sw / 50) * 50); acc += v; return v; });
  return LEVELS;
}
function achCount(uid) {
  return Object.keys(db.ach[uid] || {}).length + Object.values(db.gameAch[uid] || {}).reduce((n, g) => n + Object.keys(g).length, 0) + hookCount(uid);
}
function userXp(uid) {
  let xp = 0;
  for (const id of Object.keys(db.ach[uid] || {})) if (ACH_BY_ID[id]) xp += RANK_XP[ACH_BY_ID[id].rank];
  for (const tiers of Object.values(db.gameAch[uid] || {})) for (const id of Object.keys(tiers)) if (TIER_BY_ID[id]) xp += RANK_XP[TIER_BY_ID[id].rank];
  for (const [g, got] of Object.entries(db.hookAch[uid] || {})) { const defs = achDefs(g); for (const id of Object.keys(got)) { const a = defs.find(x => x.id === id); if (a) xp += RANK_XP[a.rank]; } }
  return xp;
}
function levelInfo(uid) {
  const L = levels(), xp = userXp(uid); let level = 0, left = xp;
  while (level < L.length && left >= L[level]) { left -= L[level]; level++; }
  const maxed = level >= L.length;
  return { xp, level, maxLevel: L.length, into: maxed ? 0 : left, need: maxed ? 0 : L[level] };
}
function statSummary(uid) {
  const st = stats(uid), top = Object.entries(st.perGame).sort((a, b) => b[1] - a[1])[0];
  return { playtime: Math.round(st.play), games: Object.keys(st.perGame).length, topGame: top ? { name: top[0], seconds: Math.round(top[1]) } : null,
    streak: st.lastDay === dayKey(Date.now()) || st.lastDay === dayKey(Date.now() - 864e5) ? st.streak : 0, bestStreak: st.best, daysActive: st.days,
    achievements: Object.keys(db.ach[uid] || {}).length, achievementsTotal: ACHIEVEMENTS.length,
    gameBadges: Object.values(db.gameAch[uid] || {}).reduce((n, g) => n + Object.keys(g).length, 0) + hookCount(uid),
    gameBadgesTotal: Object.keys(st.perGame).length * GAME_TIERS.length, level: levelInfo(uid) };
}
const lastIngame = new Map(); // uid -> { game, at } for playtime counting

function messageRateLimited(uid) {
  const now = Date.now(); let h = msgHits.get(uid);
  if (!h || now - h.t > 60e3) { h = { t: now, n: 0 }; msgHits.set(uid, h); }
  return ++h.n > 30;
}

/* ---------------- routes ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/') && await serveStatic(req, res, p)) return;
  if (p === '/' || p === '/api/health') return send(res, storageError ? 503 : 200, { ok: !storageError, service: 'eaglercraft-saves', version: 6, social: true, signups: ALLOW_SIGNUPS, accounts: Object.keys(db.users).length, storage: storageError ? 'error: ' + storageError : 'ok' });

  if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
    if (rateLimited(clientIp(req))) return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const name = String(body.username || '').trim(), pw = String(body.password || '');
    const key = name.toLowerCase();

    if (p === '/api/register') {
      if (storageError) return fail(res, 503, 'The server can’t save new accounts right now. Ask the owner to check the server.');
      if (!ALLOW_SIGNUPS) return fail(res, 403, 'Sign-ups are closed on this server.');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return fail(res, 400, 'Username must be 3–20 letters, numbers or underscores.');
      if (pw.length < 6 || pw.length > 200) return fail(res, 400, 'Password must be at least 6 characters.');
      if (db.users[key]) return fail(res, 409, 'That username is taken.');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = (await scrypt(pw, salt)).toString('hex');
      if (db.users[key]) return fail(res, 409, 'That username is taken.');
      const user = { id: crypto.randomUUID(), name, salt, hash, created: Date.now() };
      db.users[key] = user;
      const token = await newSession(user.id);
      if (storageError) { // don't hand out an account that won't survive a restart
        delete db.users[key];
        for (const [k, v] of Object.entries(db.sessions)) if (v.uid === user.id) delete db.sessions[k];
        return fail(res, 503, 'The server can’t save new accounts right now. Ask the owner to check the server.');
      }
      checkAch(user.id);
      return send(res, 200, { token, user: { name }, save: null });
    }

    const user = db.users[key];
    const hash = await scrypt(pw, user ? user.salt : 'no-such-user-salt');
    if (!user || !crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) return fail(res, 401, 'Wrong username or password.');
    const token = await newSession(user.id);
    return send(res, 200, { token, user: { name: user.name }, save: publicMeta(db.saves[user.id]) });
  }

  const user = authUser(req);
  if (p.startsWith('/api/') && !user) return fail(res, 401, 'Signed out. Please sign in again.');

  if (req.method === 'POST' && p === '/api/logout') {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    delete db.sessions[sha256(m[1])]; await saveDb();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/me') {
    return send(res, 200, { user: { name: user.name }, save: publicMeta(db.saves[user.id]) });
  }

  if (req.method === 'POST' && p === '/api/password') {
    if (rateLimited(clientIp(req))) return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const cur = await scrypt(String(body.current || ''), user.salt);
    if (!crypto.timingSafeEqual(cur, Buffer.from(user.hash, 'hex'))) return fail(res, 401, 'Current password is wrong.');
    const pw = String(body.password || '');
    if (pw.length < 6 || pw.length > 200) return fail(res, 400, 'Password must be at least 6 characters.');
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = (await scrypt(pw, user.salt)).toString('hex');
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === user.id) delete db.sessions[k];
    const token = await newSession(user.id);
    return send(res, 200, { token });
  }

  if (req.method === 'GET' && p === '/api/save') {
    const meta = db.saves[user.id];
    if (!meta) return fail(res, 404, 'No cloud save yet.');
    let stat; try { stat = await fsp.stat(saveFile(user.id)); } catch (e) { return fail(res, 404, 'No cloud save yet.'); }
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store',
      'X-Save-Rev': String(meta.rev), 'X-Save-Hash': meta.hash, 'X-Save-Updated': String(meta.updatedAt)
    }, CORS));
    return fs.createReadStream(saveFile(user.id)).pipe(res);
  }

  if (req.method === 'PUT' && p === '/api/save') {
    const ifRev = parseInt(req.headers['if-match'], 10);
    const hash = String(req.headers['x-save-hash'] || '');
    if (!Number.isFinite(ifRev)) return fail(res, 428, 'Missing If-Match revision.');
    if (!/^[a-f0-9]{64}$/.test(hash)) return fail(res, 400, 'Missing or bad X-Save-Hash.');
    if (+req.headers['content-length'] > MAX_SAVE_BYTES) return fail(res, 413, 'Save is larger than this server allows.');
    const curRev = () => (db.saves[user.id] ? db.saves[user.id].rev : 0);
    if (curRev() !== ifRev) return send(res, 409, { error: 'Cloud saves changed on another site.', save: publicMeta(db.saves[user.id]) });

    const tmp = saveFile(user.id) + '.' + crypto.randomBytes(6).toString('hex') + '.upload';
    let size = 0, tooBig = false;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        req.on('data', c => {
          size += c.length;
          if (size > MAX_SAVE_BYTES) { tooBig = true; req.unpipe(out); out.destroy(); req.resume(); resolve(); }
        });
        req.pipe(out);
        out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
      });
    } catch (e) { fsp.unlink(tmp).catch(() => {}); return fail(res, 500, 'Upload failed.'); }
    if (tooBig) { fsp.unlink(tmp).catch(() => {}); return fail(res, 413, 'Save is larger than this server allows.'); }
    if (!size) { fsp.unlink(tmp).catch(() => {}); return fail(res, 400, 'Empty upload.'); }

    return withLock(user.id, async () => {
      if (curRev() !== ifRev) { fsp.unlink(tmp).catch(() => {}); return send(res, 409, { error: 'Cloud saves changed on another site.', save: publicMeta(db.saves[user.id]) }); }
      const file = saveFile(user.id);
      await fsp.rename(file, file + '.prev').catch(() => {}); // keep one previous copy as a safety net
      await fsp.rename(tmp, file);
      db.saves[user.id] = { rev: ifRev + 1, hash, size, updatedAt: Date.now() };
      stats(user.id).saves++; checkAch(user.id);
      await saveDb();
      return send(res, 200, { save: publicMeta(db.saves[user.id]) });
    });
  }

  /* ----- social ----- */
  if (req.method === 'GET' && p === '/api/social') {
    const me = soc(user.id);
    const order = { ingame: 0, online: 1, offline: 2 };
    const friends = me.friends.map(id => friendView(user.id, id)).filter(Boolean)
      .sort((a, b) => order[a.state] - order[b.state] || (b.state === 'offline' ? b.lastSeen - a.lastSeen : 0) || a.name.localeCompare(b.name));
    const names = ids => ids.map(userById).filter(Boolean).map(u => u.name);
    return send(res, 200, { me: { name: user.name }, friends, incoming: names(me.incoming), outgoing: names(me.outgoing), newAchievements: takeNewAch(user.id), level: levelInfo(user.id) });
  }

  if (req.method === 'POST' && p === '/api/presence') {
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const state = body.state === 'ingame' ? 'ingame' : body.state === 'offline' ? 'offline' : 'online';
    const game = state === 'ingame' ? String(body.game || '').slice(0, 60) : null;
    const me = soc(user.id), now = Date.now();
    if (state === 'offline') presence.delete(user.id); else presence.set(user.id, { state, game, at: now });
    // playtime: count the time since the previous "playing" ping for the same game (pings come every minute)
    const prev = lastIngame.get(user.id);
    if (state === 'ingame' && game) {
      if (prev && prev.game === game && now - prev.at < 150e3) {
        const sec = (now - prev.at) / 1000, st = stats(user.id);
        st.play += sec; st.perGame[game] = (st.perGame[game] || 0) + sec; saveDbSoon();
        checkGameAch(user.id, game);
      }
      if (!prev || prev.game !== game || now - prev.at >= 150e3) noteSession(user.id, game, now);
      lastIngame.set(user.id, { game, at: now });
    } else lastIngame.delete(user.id);
    if (state !== 'offline' && markActiveDay(user.id, now)) saveDbSoon();
    if (state !== 'offline') checkAch(user.id);
    let dirty = false;
    if (game && (!me.recent[0] || me.recent[0].game !== game)) {
      me.recent = [{ game, at: now }].concat(me.recent.filter(r => r.game !== game)).slice(0, 8); dirty = true;
    }
    if (now - (me.lastSeen || 0) > 5 * 60e3 || state === 'offline') { me.lastSeen = now; dirty = true; }
    if (dirty) saveDb();
    return send(res, 200, { ok: true, newAchievements: takeNewAch(user.id), level: levelInfo(user.id) });
  }

  if (req.method === 'POST' && p.startsWith('/api/friends/')) {
    const action = p.slice('/api/friends/'.length);
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const other = userByName(body.username);
    if (!other) return fail(res, 404, 'No player with that name.');
    if (other.id === user.id) return fail(res, 400, 'That’s you!');
    const me = soc(user.id), them = soc(other.id);
    if (action === 'request') {
      if (me.friends.includes(other.id)) return fail(res, 409, 'You’re already friends.');
      if (me.incoming.includes(other.id)) { // they already asked: accept
        pull(me.incoming, other.id); pull(them.outgoing, user.id);
        me.friends.push(other.id); them.friends.push(user.id); checkAch(user.id); checkAch(other.id); await saveDb();
        return send(res, 200, { ok: true, accepted: true });
      }
      if (me.outgoing.includes(other.id)) return fail(res, 409, 'Request already sent.');
      if (me.friends.length >= MAX_FRIENDS) return fail(res, 400, 'Friend list is full.');
      if (them.incoming.length >= 100) return fail(res, 400, 'They have too many pending requests.');
      me.outgoing.push(other.id); them.incoming.push(user.id); await saveDb();
      return send(res, 200, { ok: true });
    }
    if (action === 'accept') {
      if (!me.incoming.includes(other.id)) return fail(res, 404, 'No request from that player.');
      pull(me.incoming, other.id); pull(them.outgoing, user.id);
      if (!me.friends.includes(other.id)) me.friends.push(other.id);
      if (!them.friends.includes(user.id)) them.friends.push(user.id);
      checkAch(user.id); checkAch(other.id);
      await saveDb(); return send(res, 200, { ok: true });
    }
    if (action === 'decline' || action === 'cancel' || action === 'remove') {
      pull(me.incoming, other.id); pull(them.outgoing, user.id);
      pull(me.outgoing, other.id); pull(them.incoming, user.id);
      if (action === 'remove') { pull(me.friends, other.id); pull(them.friends, user.id); }
      await saveDb(); return send(res, 200, { ok: true });
    }
    return fail(res, 404, 'Not found.');
  }

  if (req.method === 'GET' && p === '/api/users') {
    // Everyone signed in can browse players. Online/playing status is only included for friends (and you).
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40);
    const sort = url.searchParams.get('sort') === 'name' ? 'name' : 'new';
    const page = Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0), per = 48;
    const me = soc(user.id);
    let all = Object.values(db.users);
    const total = all.length;
    if (q) all = all.filter(u => u.name.toLowerCase().includes(q));
    all.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : (a, b) => (b.created || 0) - (a.created || 0));
    const users = all.slice(page * per, page * per + per).map(u => {
      const isMe = u.id === user.id, isFriend = me.friends.includes(u.id);
      const out = { name: u.name, created: u.created, friendCount: soc(u.id).friends.length,
        achievements: achCount(u.id), level: levelInfo(u.id).level,
        playtime: Math.round(stats(u.id).play),
        relation: isMe ? 'me' : isFriend ? 'friend' : me.outgoing.includes(u.id) ? 'requested' : me.incoming.includes(u.id) ? 'requestedYou' : 'none' };
      if (isMe || isFriend) { const pr = presenceOf(u.id); out.state = pr.state; out.game = pr.game; out.lastSeen = pr.lastSeen; }
      return out;
    });
    return send(res, 200, { total, matches: all.length, page, pages: Math.max(1, Math.ceil(all.length / per)), users });
  }

  if (req.method === 'GET' && p === '/api/game-achievements') {
    const game = String(url.searchParams.get('game') || '').slice(0, 60);
    if (!game) return fail(res, 400, 'Missing game.');
    const sec = stats(user.id).perGame[game] || 0, got = (db.gameAch[user.id] || {})[game] || {};
    const tiers = tierList(game, got, sec);
    const r = rarity();
    const special = hookList(game, user.id);
    return send(res, 200, { game, seconds: Math.round(sec), unlocked: tiers.filter(t => t.unlocked).length + special.filter(t => t.unlocked).length,
      total: tiers.length + special.length, players: (r.games[game] || {}).players || 0, tiers, special });
  }

  /* stats reported by a game hook while it runs */
  if (req.method === 'POST' && p === '/api/game-stats') {
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const game = String(body.game || ''), defs = HOOK_ACH[game];
    if (!defs) return fail(res, 404, 'No hooks for that game.');
    const allowed = new Set(defs.map(a => a.stat)), all = db.gstats[user.id] || (db.gstats[user.id] = {}), st = all[game] || (all[game] = {});
    let changed = false;
    for (const [k, v] of Object.entries(body.stats || {})) {
      const n = Number(v);
      if (!allowed.has(k) || !Number.isFinite(n) || n < 0 || n > 1e30) continue;
      if (n > (st[k] || 0)) { st[k] = n; changed = true; }  // stats only go up
    }
    if (changed) { saveDbSoon(); checkHookAch(user.id, game); }
    return send(res, 200, { ok: true, newAchievements: takeNewAch(user.id), level: levelInfo(user.id) });
  }

  if (req.method === 'GET' && p === '/api/hook-defs') {
    const out = {};
    const view = a => ({ id: 'h:' + a.id, icon: a.icon, name: a.name, desc: a.desc, goal: a.goal, rank: a.rank, basic: !!a.basic });
    for (const [g, defs] of Object.entries(HOOK_ACH)) out[g] = defs.map(view);
    return send(res, 200, { games: out, generic: GENERIC_ACH.map(view), rankXp: RANK_XP, levels: levels() });
  }

  if (req.method === 'GET' && p === '/api/profile') {
    const other = userByName(url.searchParams.get('name')) || user;
    const isMe = other.id === user.id, isFriend = soc(user.id).friends.includes(other.id);
    const out = { name: other.name, created: other.created, friendCount: soc(other.id).friends.length, isMe, isFriend,
      requested: soc(user.id).outgoing.includes(other.id), requestedYou: soc(user.id).incoming.includes(other.id) };
    if (isMe || isFriend) Object.assign(out, presenceOf(other.id), { recent: soc(other.id).recent.slice(0, 6) });
    out.stats = statSummary(other.id); out.level = out.stats.level;
    out.achievements = achList(other.id, isMe);
    out.games = gameList(other.id, isMe);
    out.players = Object.keys(db.users).length;
    if (isMe || isFriend) {
      const mine = soc(user.id).friends;
      out.friends = soc(other.id).friends.map(userById).filter(Boolean).map(f => {
        const o = { name: f.name };
        if (f.id === user.id || mine.includes(f.id)) Object.assign(o, presenceOf(f.id));
        return o;
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    return send(res, 200, out);
  }

  if (p === '/api/messages') {
    if (req.method === 'GET') {
      const other = userByName(url.searchParams.get('with'));
      if (!other || !soc(user.id).friends.includes(other.id)) return fail(res, 403, 'You can only chat with friends.');
      const after = +url.searchParams.get('after') || 0;
      const list = (db.messages[pairKey(user.id, other.id)] || []).filter(m => m.id > after).slice(-100);
      const last = list.length ? list[list.length - 1].id : 0;
      if (last) { db.reads[user.id] = db.reads[user.id] || {}; if ((db.reads[user.id][other.id] || 0) < last) { db.reads[user.id][other.id] = last; saveDb(); } }
      return send(res, 200, { messages: list.map(m => ({ id: m.id, from: m.from === user.id ? user.name : other.name, mine: m.from === user.id, text: m.text, at: m.at })) });
    }
    if (req.method === 'POST') {
      if (messageRateLimited(user.id)) return fail(res, 429, 'Slow down a little.');
      let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
      const other = userByName(body.to);
      if (!other || !soc(user.id).friends.includes(other.id)) return fail(res, 403, 'You can only chat with friends.');
      const text = String(body.text || '').replace(/\s+$/, '').slice(0, 500);
      if (!text.trim()) return fail(res, 400, 'Empty message.');
      const key = pairKey(user.id, other.id), list = db.messages[key] || (db.messages[key] = []);
      const msg = { id: ++db.msgSeq, from: user.id, text, at: Date.now() };
      list.push(msg); if (list.length > MAX_MSGS_PER_CHAT) list.splice(0, list.length - MAX_MSGS_PER_CHAT);
      db.reads[user.id] = db.reads[user.id] || {}; db.reads[user.id][other.id] = msg.id;
      stats(user.id).msgs++; checkAch(user.id);
      await saveDb();
      return send(res, 200, { message: { id: msg.id, from: user.name, mine: true, text, at: msg.at } });
    }
  }

  return fail(res, 404, 'Not found.');
}

// Backfill achievements for accounts that existed before achievements were added.
(function backfill() {
  let n = 0;
  for (const u of Object.values(db.users)) {
    const st = stats(u.id);
    if (db.saves[u.id] && !st.saves) st.saves = 1;
    n += checkAch(u.id).length;
    for (const g of Object.keys(st.perGame)) n += checkGameAch(u.id, g, false).length;
  }
  if (n) console.log(`Unlocked ${n} achievement(s) for existing accounts.`);
})();

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error.'); else res.destroy();
  });
}).listen(PORT, HOST, () => {
  console.log(`Eaglercraft save server on http://${HOST}:${PORT}  (data: ${DATA_DIR}, signups: ${ALLOW_SIGNUPS})`);
});

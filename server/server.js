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

/* Game asset packs (e.g. Counter Attack's csattack.zip), downloaded by games running in Mist.
 * Drop the files in ASSETS_DIR; they're served at /assets/<name> with CORS, ETag and Range support. */
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(__dirname, 'assets'));
async function serveAsset(req, res, name) {
  if (!/^[\w.-]+\.(zip|pk3|wad)$/i.test(name)) return false;
  const file = path.join(ASSETS_DIR, name);
  let st; try { st = await fsp.stat(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  const head = Object.assign({}, CORS, {
    'Content-Type': 'application/zip', 'Accept-Ranges': 'bytes', 'ETag': etag,
    'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'no-cache',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, Last-Modified'
  });
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(), true; }
  let start = 0, end = st.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); } else start = Math.max(0, st.size - +m[2]);
    if (start > end) { res.writeHead(416, Object.assign(head, { 'Content-Range': 'bytes */' + st.size })); return res.end(), true; }
    status = 206; head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  }
  head['Content-Length'] = end - start + 1;
  res.writeHead(status, head);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file, { start, end }).pipe(res);
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
    // After a crash or reboot the old pid can belong to an unrelated process: only a running Mist server counts.
    if (alive) { try { const cmd = fs.readFileSync('/proc/' + other + '/cmdline', 'utf8'); if (!/node/.test(cmd) || !/server/.test(cmd)) alive = false; } catch (e) { if (e.code === 'ENOENT') alive = false; } }
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
/* ---------- profile look (icon + colour) and bio ---------- */
db.looks = db.looks || {};       // uid -> { icon, color, bio }
// Pre-made 12x12 pixel-art avatars (drawn in launcher/social.js, PIXEL_PRESETS).
/* ---------- Mist Supporter: $5/month PayPal subscription ----------
 * Perks while active (or until the last paid month runs out): gold outline, the supporter avatars and the
 * Mist Supporter achievement (+2500 XP). PayPal keys go in paypal.json next to server.js:
 *   { "clientId": "...", "secret": "...", "mode": "live" }      (mode "sandbox" for testing)
 * The server creates the product and $5/month plan on first use, then checks subscriptions with PayPal. */
db.support = db.support || {};     // uid -> { sub, status, since, paidThrough, checked, created }
db.meta = db.meta || {};
const SUPPORTER_ACH = { icon: '💛', name: 'Mist Supporter', desc: 'Support Mist with $5/month. Counts while you’re subscribed.' };
const SUPPORT_PRICE = process.env.SUPPORT_PRICE || '5.00', SUPPORT_CURRENCY = process.env.SUPPORT_CURRENCY || 'USD';
function paypalConfig() {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, 'paypal.json'), 'utf8')); } catch (e) {}
  if (!c && process.env.PAYPAL_CLIENT_ID) c = { clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_SECRET, mode: process.env.PAYPAL_MODE };
  if (!c || !c.clientId || !c.secret) return null;
  c.mode = c.mode === 'sandbox' ? 'sandbox' : 'live';
  c.api = process.env.PAYPAL_API || (c.mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com');
  return c;
}
function isSupporter(uid) {
  const s = db.support && db.support[uid];
  return !!s && (s.status === 'ACTIVE' || (s.paidThrough || 0) > Date.now() || (s.manualUntil || 0) > Date.now());
}
function supporterCount() { return Object.keys(db.support || {}).filter(isSupporter).length; }
let ppToken = null;
async function paypal(method, p, body) {
  const c = paypalConfig(); if (!c) throw new Error('PayPal isn’t set up on this server.');
  if (!ppToken || ppToken.exp < Date.now() || ppToken.key !== c.clientId) {
    const r = await fetch(c.api + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(c.clientId + ':' + c.secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('PayPal sign-in failed (' + r.status + '). Check paypal.json.');
    ppToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000, key: c.clientId };
  }
  const r = await fetch(c.api + p, { method, headers: { Authorization: 'Bearer ' + ppToken.token, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('PayPal: ' + (j.message || j.error_description || r.status)); e.status = r.status; throw e; }
  return j;
}
async function supportPlan() {
  const c = paypalConfig(), key = 'paypalPlan:' + c.mode + ':' + c.clientId.slice(0, 12) + ':' + SUPPORT_PRICE + SUPPORT_CURRENCY;
  if (db.meta[key]) return db.meta[key];
  const prod = await paypal('POST', '/v1/catalogs/products', { name: 'Mist Supporter', description: 'Monthly support for the Mist game launcher', type: 'SERVICE', category: 'SOFTWARE' });
  const plan = await paypal('POST', '/v1/billing/plans', { product_id: prod.id, name: 'Mist Supporter (monthly)', status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: SUPPORT_PRICE, currency_code: SUPPORT_CURRENCY } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 } });
  db.meta[key] = plan.id; saveDbSoon();
  console.log('PayPal: created plan', plan.id);
  return plan.id;
}
async function refreshSupport(uid) {
  const s = db.support[uid]; if (!s || !s.sub) return s;
  const was = isSupporter(uid);
  const j = await paypal('GET', '/v1/billing/subscriptions/' + encodeURIComponent(s.sub));
  if (j.custom_id && j.custom_id !== uid) throw new Error('That subscription belongs to another account.');
  s.status = j.status; s.checked = Date.now();
  const last = j.billing_info && j.billing_info.last_payment && Date.parse(j.billing_info.last_payment.time);
  const next = j.billing_info && j.billing_info.next_billing_time && Date.parse(j.billing_info.next_billing_time);
  if (j.status === 'ACTIVE' && next) s.paidThrough = Math.max(s.paidThrough || 0, next + 864e5);   // a day of grace for the renewal
  else if (last) s.paidThrough = Math.max(s.paidThrough || 0, last + 31 * 864e5);
  const now = isSupporter(uid);
  if (now && !s.since) s.since = Date.now();
  if (now && !was) { (db.achNew[uid] = db.achNew[uid] || []).push('supporter'); lbCache = null; }
  if (!now && was) { s.since = null; lbCache = null; }
  saveDbSoon();
  return s;
}
function supportView(uid) {
  const s = db.support[uid] || {}, c = paypalConfig();
  return { enabled: !!c, price: '$' + SUPPORT_PRICE.replace(/\.00$/, '') + '/month', supporter: isSupporter(uid), status: s.status || null,
    paidThrough: s.paidThrough || null, since: s.since || null, pending: s.status === 'APPROVAL_PENDING' || s.status === 'APPROVED', xp: SUPPORTER_XP,
    manage: c && c.mode === 'sandbox' ? 'https://www.sandbox.paypal.com/myaccount/autopay/' : 'https://www.paypal.com/myaccount/autopay/' };
}
// Re-check subscriptions every 3 hours (renewals, cancellations, failed payments).
setInterval(async () => {
  if (!paypalConfig()) return;
  for (const [uid, s] of Object.entries(db.support)) {
    if (!s.sub) continue;
    const pendingFresh = (s.status === 'APPROVAL_PENDING' || s.status === 'APPROVED') && Date.now() - (s.created || 0) < 3 * 864e5;
    if (s.status === 'ACTIVE' || pendingFresh || (s.paidThrough || 0) > Date.now() - 864e5) { try { await refreshSupport(uid); } catch (e) {} }
  }
}, 3 * 3600e3).unref();

const AVATARS = ["Slime", "Ghost", "Skull", "Heart", "Cat", "Mushroom", "Robot", "Alien", "Potion", "Star", "Ninja", "Sword", "Fox", "Frog", "Penguin", "Crown", "Fire", "Bomb", "Diamond", "Shield", "Controller", "Pumpkin", "Cactus"];
const COLORS = ['#c0392b','#e67e22','#f1c40f','#27ae60','#16a085','#2980b9','#3d5afe','#8e44ad','#d81b60','#6d4c41','#455a64','#1b1f24'];
const AVATARS_PLUS = ["Panda", "Bunny", "Duck", "Owl", "Octopus", "Shark", "Bee", "Ladybug", "Planet", "Moon", "Sun", "Lightning", "Snowman", "Tree", "Flower", "Trophy", "Rocket", "Astronaut", "Knight", "Wizard", "Dragon", "Donut", "IceCream"];   // supporter-only avatars
function lookOf(uid) {
  const l = db.looks[uid], sup = isSupporter(uid);
  const ok = l && l.avatar && (AVATARS.includes(l.avatar) || (sup && AVATARS_PLUS.includes(l.avatar)));
  const o = ok ? { k: l.avatar, c: l.color || COLORS[11] } : null;
  return sup ? Object.assign(o || {}, { s: 1 }) : o;
}
// Drop the old emoji icons (replaced by pixel art).
(function dropEmojiIcons() { try { for (const l of Object.values(db.looks)) if (l) { delete l.icon; delete l.px; } } catch (e) {} })();
// Map of name -> look for the users in a response, so every avatar can show the chosen icon.
function looksFor(uids) { const out = {}; for (const id of uids) { const u = userById(id), l = lookOf(id); if (u && l) out[u.name] = l; } return out; }
function cleanBio(t) {
  return String(t || '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 200);
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
  try {
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
  } catch (e) { console.error("Startup cleanup skipped:", e.message); }
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
    if (id === 'supporter') return { id, icon: SUPPORTER_ACH.icon, name: SUPPORTER_ACH.name, desc: SUPPORTER_ACH.desc, rank: 'supporter', xp: SUPPORTER_XP };
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
/* (The visit-based basics - days played / launches - were removed; every game's extra achievements are game-specific.) */
const GENERIC_ACH = [];
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
  'Learn to Fly 3': [
    { id: 'alt1k', icon: '🐧', name: 'Liftoff', desc: 'Reach an altitude of 1,000 m.', stat: 'altitude', goal: 1000, rank: 'common' },
    { id: 'alt10k', icon: '☁️', name: 'Above the Clouds', desc: 'Reach an altitude of 10,000 m.', stat: 'altitude', goal: 10000, rank: 'rare' },
    { id: 'alt100k', icon: '🌙', name: 'Moon Bound', desc: 'Reach an altitude of 100,000 m.', stat: 'altitude', goal: 100000, rank: 'epic' },
    { id: 'days25', icon: '📅', name: 'Persistent Penguin', desc: 'Play 25 days in total.', stat: 'days', goal: 25, rank: 'common' },
    { id: 'medal10', icon: '🏅', name: 'Medal Collector', desc: 'Earn 10 of the game’s medals.', stat: 'medals', goal: 10, rank: 'rare' },
    { id: 'finish', icon: '👑', name: 'Penguins CAN Fly', desc: 'Finish a game.', stat: 'finished', goal: 1, rank: 'legendary' },
  ],
  /* ---- batch 2 (Flash) ---- */
  'Papa\'s Pizzeria': [
    { id: 'rank5', icon: '🍕', name: 'Slice of Life', desc: 'Reach rank 5 in Papa’s Pizzeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Dough Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '👑', name: 'Pizza Legend', desc: 'Reach the top rank (30).', stat: 'rank', goal: 30, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving pizzas.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
  ],
  'Papa\'s Burgeria': [
    { id: 'rank5', icon: '🍔', name: 'Flipping Out', desc: 'Reach rank 5 in Papa’s Burgeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Grill Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Burger Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Burger Baron', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving burgers.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Taco Mia!': [
    { id: 'rank5', icon: '🌮', name: 'Taco Tuesday', desc: 'Reach rank 5 in Papa’s Taco Mia!.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Salsa Supreme', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Taco Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Taco Titan', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving tacos.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Freezeria': [
    { id: 'rank5', icon: '🍨', name: 'Brain Freeze', desc: 'Reach rank 5 in Papa’s Freezeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Blend Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Sundae Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Sundae Supreme', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving sundaes.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Pancakeria': [
    { id: 'rank5', icon: '🥞', name: 'Short Stack', desc: 'Reach rank 5 in Papa’s Pancakeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Flapjack Pro', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Pancake Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Pancake Royalty', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving pancakes.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Wingeria': [
    { id: 'rank5', icon: '🍗', name: 'Winging It', desc: 'Reach rank 5 in Papa’s Wingeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Sauce Boss', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Wing Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Wing Commander', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving wings.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Hot Doggeria': [
    { id: 'rank5', icon: '🌭', name: 'Top Dog Rookie', desc: 'Reach rank 5 in Papa’s Hot Doggeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Ballpark Pro', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Hot Dog Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Top Dog', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving hot dogs.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Cupcakeria': [
    { id: 'rank5', icon: '🧁', name: 'Sprinkle Starter', desc: 'Reach rank 5 in Papa’s Cupcakeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Frosting Pro', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Cupcake Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Cupcake Queen', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving cupcakes.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Pastaria': [
    { id: 'rank5', icon: '🍝', name: 'Al Dente', desc: 'Reach rank 5 in Papa’s Pastaria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Sauce Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Pasta Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Pasta Maestro', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving pasta dishes.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Donuteria': [
    { id: 'rank5', icon: '🍩', name: 'Glazed Over', desc: 'Reach rank 5 in Papa’s Donuteria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Fry Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Donut Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Donut Royalty', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving donuts.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Cheeseria': [
    { id: 'rank5', icon: '🧀', name: 'Melted', desc: 'Reach rank 5 in Papa’s Cheeseria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Cheese Whiz', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Cheese Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Big Cheese', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving grilled cheese.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Bakeria': [
    { id: 'rank5', icon: '🥧', name: 'Easy as Pie', desc: 'Reach rank 5 in Papa’s Bakeria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Crust Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Pie Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Pie Perfection', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving pies.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Sushiria': [
    { id: 'rank5', icon: '🍣', name: 'Rolling Along', desc: 'Reach rank 5 in Papa’s Sushiria.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Rice Master', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Sushi Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Sushi Sensei', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving sushi rolls.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Papa\'s Scooperia': [
    { id: 'rank5', icon: '🍪', name: 'Scoop Starter', desc: 'Reach rank 5 in Papa’s Scooperia.', stat: 'rank', goal: 5, rank: 'common' },
    { id: 'rank15', icon: '⭐', name: 'Scoop Pro', desc: 'Reach rank 15.', stat: 'rank', goal: 15, rank: 'rare' },
    { id: 'rank30', icon: '🏅', name: 'Cookie Expert', desc: 'Reach rank 30.', stat: 'rank', goal: 30, rank: 'epic' },
    { id: 'rank60', icon: '👑', name: 'Scooperia Legend', desc: 'Reach rank 60.', stat: 'rank', goal: 60, rank: 'legendary' },
    { id: 'day10', icon: '📅', name: 'Open for Business', desc: 'Make it to day 10.', stat: 'day', goal: 10, rank: 'common' },
    { id: 'day50', icon: '🗓️', name: 'Regular Customers', desc: 'Make it to day 50 serving cookie sundaes.', stat: 'day', goal: 50, rank: 'rare' },
    { id: 'day100', icon: '🏪', name: 'Local Legend', desc: 'Make it to day 100.', stat: 'day', goal: 100, rank: 'epic' },
    { id: 'badge10', icon: '🎖️', name: 'Badge Collector', desc: 'Earn 10 of the game’s badges.', stat: 'badges', goal: 10, rank: 'rare' },
    { id: 'badge50', icon: '🏆', name: 'Decorated Chef', desc: 'Earn 50 of the game’s badges.', stat: 'badges', goal: 50, rank: 'epic' },
  ],
  'Duck Life': [
    { id: 'lv200', icon: '🐣', name: 'Fledgling', desc: 'Get every skill (run, swim, fly) to level 200.', stat: 'low', goal: 200, rank: 'common' },
    { id: 'lv800', icon: '🦆', name: 'Athletic Duck', desc: 'Get every skill to level 800.', stat: 'low', goal: 800, rank: 'rare' },
    { id: 'lv1500', icon: '🏆', name: 'Champion Duck', desc: 'Get every skill to level 1500.', stat: 'low', goal: 1500, rank: 'epic' },
    { id: 'one1000', icon: '💪', name: 'Specialist', desc: 'Get one skill to level 1000.', stat: 'top', goal: 1000, rank: 'common' },
    { id: 'money500', icon: '🪙', name: 'Seed Money', desc: 'Have 500 coins.', stat: 'money', goal: 500, rank: 'common' },
  ],
  'Duck Life 2': [
    { id: 'race3', icon: '🏁', name: 'Off the Mark', desc: 'Win 3 races.', stat: 'race', goal: 3, rank: 'common' },
    { id: 'race8', icon: '🥈', name: 'Contender', desc: 'Win 8 races.', stat: 'race', goal: 8, rank: 'rare' },
    { id: 'race14', icon: '🏆', name: 'World Champion', desc: 'Win every race.', stat: 'race', goal: 14, rank: 'legendary' },
    { id: 'lv500', icon: '🦆', name: 'Well Trained', desc: 'Get run, swim and fly to level 500.', stat: 'low', goal: 500, rank: 'rare' },
    { id: 'one1000', icon: '💪', name: 'Specialist', desc: 'Get one skill to level 1000.', stat: 'top', goal: 1000, rank: 'common' },
    { id: 'money1k', icon: '🪙', name: 'Nest Egg', desc: 'Have 1,000 coins.', stat: 'money', goal: 1000, rank: 'common' },
  ],
  'Duck Life 3: Evolution': [
    { id: 'race3', icon: '🏁', name: 'First Steps', desc: 'Win 3 races.', stat: 'race', goal: 3, rank: 'common' },
    { id: 'race10', icon: '🧬', name: 'Evolving', desc: 'Win 10 races.', stat: 'race', goal: 10, rank: 'rare' },
    { id: 'race19', icon: '🏆', name: 'Ultimate Duck', desc: 'Win every race.', stat: 'race', goal: 19, rank: 'legendary' },
    { id: 'lv500', icon: '🦆', name: 'All-Rounder', desc: 'Get run, swim, fly and climb to level 500.', stat: 'low', goal: 500, rank: 'rare' },
    { id: 'lv1500', icon: '💎', name: 'Peak Performance', desc: 'Get every skill to level 1500.', stat: 'low', goal: 1500, rank: 'epic' },
    { id: 'money1k', icon: '🪙', name: 'Nest Egg', desc: 'Have 1,000 coins.', stat: 'money', goal: 1000, rank: 'common' },
  ],
  'Duck Life 4': [
    { id: 'r1', icon: '🏁', name: 'Hatched a Win', desc: 'Win your first race.', stat: 'races', goal: 1, rank: 'common' },
    { id: 'r9', icon: '🥈', name: 'Halfway There', desc: 'Win 9 races.', stat: 'races', goal: 9, rank: 'rare' },
    { id: 'r18', icon: '🏆', name: 'Race Master', desc: 'Win all 18 races.', stat: 'races', goal: 18, rank: 'epic' },
    { id: 't1', icon: '🎪', name: 'Tournament Winner', desc: 'Win a tournament.', stat: 'tournaments', goal: 1, rank: 'rare' },
    { id: 't5', icon: '👑', name: 'Grand Champion', desc: 'Win all 5 tournaments.', stat: 'tournaments', goal: 5, rank: 'legendary' },
  ],
  'Duck Life 5: Treasure Hunt': [
    { id: 'c1k', icon: '🪙', name: 'Treasure Finder', desc: 'Have 1,000 coins.', stat: 'coins', goal: 1000, rank: 'common' },
    { id: 'c10k', icon: '💰', name: 'Treasure Hoarder', desc: 'Have 10,000 coins.', stat: 'coins', goal: 10000, rank: 'rare' },
    { id: 'd1k', icon: '🏃', name: 'Long Run', desc: 'Reach a best distance of 1,000.', stat: 'best', goal: 1000, rank: 'common' },
    { id: 'd5k', icon: '🚀', name: 'Marathon Duck', desc: 'Reach a best distance of 5,000.', stat: 'best', goal: 5000, rank: 'epic' },
    { id: 'pet5', icon: '🐾', name: 'Pet Trainer', desc: 'Get your pet to level 5.', stat: 'pet', goal: 5, rank: 'rare' },
    { id: 'story', icon: '🗺️', name: 'Treasure Found', desc: 'Finish the story.', stat: 'story', goal: 1, rank: 'legendary' },
  ],
  'Fireboy and Watergirl: Forest Temple': [
    { id: 'l1', icon: '🔥', name: 'Into the Temple', desc: 'Finish your first level.', stat: 'levels', goal: 1, rank: 'common' },
    { id: 'l10', icon: '💧', name: 'Teamwork', desc: 'Finish 10 levels.', stat: 'levels', goal: 10, rank: 'common' },
    { id: 'l20', icon: '🌿', name: 'Deep in the Forest', desc: 'Finish 20 levels.', stat: 'levels', goal: 20, rank: 'rare' },
    { id: 'l32', icon: '🏛️', name: 'Temple Conquered', desc: 'Finish all 32 levels.', stat: 'levels', goal: 32, rank: 'epic' },
    { id: 'p5', icon: '💎', name: 'Flawless', desc: 'Get the top grade on 5 levels.', stat: 'perfect', goal: 5, rank: 'rare' },
    { id: 'p32', icon: '👑', name: 'Perfect Temple', desc: 'Get the top grade on every level.', stat: 'perfect', goal: 32, rank: 'legendary' },
  ],
  'Bloons TD 2': [
    { id: 'bronze', icon: '🥉', name: 'Bronze Defender', desc: 'Earn the bronze medal.', stat: 'bronze', goal: 1, rank: 'common' },
    { id: 'silver', icon: '🥈', name: 'Silver Defender', desc: 'Earn the silver medal.', stat: 'silver', goal: 1, rank: 'rare' },
    { id: 'gold', icon: '🥇', name: 'Gold Defender', desc: 'Earn the gold medal.', stat: 'gold', goal: 1, rank: 'epic' },
  ],
  /* ---- batch 1 ---- */
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
    { id: 'car6', icon: '🏁', name: 'Car Collector', desc: 'Own 6 cars.', stat: 'cars', goal: 6, rank: 'epic' },
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
    { id: 'a39', icon: '👑', name: 'Perfectionist', desc: 'Unlock all 39 of Vex 5’s own achievements.', stat: 'achievements', goal: 39, rank: 'legendary' },
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
};
/* GENERATED-ACHIEVEMENTS-START */
// Generated by tools/build-achievements.js from tools/game-achievements.json - edit that file instead.
Object.assign(HOOK_ACH, {
  "2048": [
    { id: "t256", icon: "🟨", name: "Getting Started", desc: "Make a 256 tile.", stat: "tile", goal: 256, rank: "common" },
    { id: "t512", icon: "🟧", name: "Halfway There", desc: "Make a 512 tile.", stat: "tile", goal: 512, rank: "common" },
    { id: "t1024", icon: "🟥", name: "So Close", desc: "Make a 1024 tile.", stat: "tile", goal: 1024, rank: "rare" },
    { id: "t2048", icon: "🏆", name: "2048!", desc: "Make the 2048 tile.", stat: "tile", goal: 2048, rank: "epic" },
    { id: "t4096", icon: "👑", name: "Beyond 2048", desc: "Make a 4096 tile.", stat: "tile", goal: 4096, rank: "legendary" },
    { id: "s5k", icon: "📈", name: "High Scorer", desc: "Score 5,000 points in one game.", stat: "best", goal: 5000, rank: "common" },
    { id: "s20k", icon: "💯", name: "Number Cruncher", desc: "Score 20,000 points in one game.", stat: "best", goal: 20000, rank: "rare" },
  ],
  "Learn to Fly Idle": [
    { id: "ob5", icon: "🧱", name: "Wall Breaker", desc: "Smash through obstacle 5.", stat: "obstacle", goal: 5, rank: "common" },
    { id: "ob25", icon: "🏔️", name: "Unstoppable Penguin", desc: "Smash through obstacle 25.", stat: "obstacle", goal: 25, rank: "rare" },
    { id: "ob100", icon: "🌋", name: "Mountain Mover", desc: "Smash through obstacle 100.", stat: "obstacle", goal: 100, rank: "epic" },
    { id: "k100", icon: "💥", name: "Demolition", desc: "Destroy 100 obstacles.", stat: "kills", goal: 100, rank: "common" },
    { id: "l20", icon: "🚀", name: "Power Launch", desc: "Get launch power to level 20.", stat: "launch", goal: 20, rank: "rare" },
    { id: "space", icon: "🌌", name: "To Space!", desc: "Reach space.", stat: "space", goal: 1, rank: "legendary" },
    { id: "a5", icon: "🏅", name: "Achiever", desc: "Unlock 5 of the game’s own achievements.", stat: "ach", goal: 5, rank: "epic" },
  ],
  "Learn to Fly": [
    { id: "d5", icon: "🐧", name: "Flight School", desc: "Reach day 5.", stat: "day", goal: 5, rank: "common" },
    { id: "d20", icon: "🪂", name: "Frequent Flyer", desc: "Reach day 20.", stat: "day", goal: 20, rank: "rare" },
    { id: "d40", icon: "🛩️", name: "Ace Pilot", desc: "Reach day 40.", stat: "day", goal: 40, rank: "epic" },
    { id: "c5k", icon: "💵", name: "Savings", desc: "Have $5,000 at once.", stat: "cash", goal: 5000, rank: "rare" },
    { id: "done", icon: "🏔️", name: "Penguins Can Fly", desc: "Beat the game by smashing the iceberg.", stat: "done", goal: 1, rank: "legendary" },
  ],
  "Bloons TD 3": [
    { id: "b1", icon: "🥉", name: "Pop Goes the Bloon", desc: "Earn a bronze medal on any track.", stat: "bronze", goal: 1, rank: "common" },
    { id: "b4", icon: "🎈", name: "Track Explorer", desc: "Earn bronze medals on all 4 tracks.", stat: "bronze", goal: 4, rank: "rare" },
    { id: "s1", icon: "🥈", name: "Silver Strategy", desc: "Earn a silver medal.", stat: "silver", goal: 1, rank: "rare" },
    { id: "g1", icon: "🥇", name: "Golden Monkey", desc: "Earn a gold medal.", stat: "gold", goal: 1, rank: "epic" },
    { id: "g4", icon: "👑", name: "Bloon Master", desc: "Earn gold medals on all 4 tracks.", stat: "gold", goal: 4, rank: "legendary" },
  ],
  "2048 Cupcakes": [
    { id: "c64", icon: "🧁", name: "Sprinkles", desc: "Bake the 64 cupcake.", stat: "tile", goal: 64, rank: "common" },
    { id: "c256", icon: "🍰", name: "Layer Cake", desc: "Bake the 256 cupcake.", stat: "tile", goal: 256, rank: "common" },
    { id: "c1024", icon: "🎂", name: "Showstopper", desc: "Bake the 1024 cupcake.", stat: "tile", goal: 1024, rank: "rare" },
    { id: "c2048", icon: "👑", name: "Ultimate Cupcake", desc: "Bake the 2048 cupcake.", stat: "tile", goal: 2048, rank: "epic" },
    { id: "s10k", icon: "🍬", name: "Sugar Rush", desc: "Score 10,000 in one game.", stat: "best", goal: 10000, rank: "rare" },
  ],
  "Bad Ice Cream": [
    { id: "l5", icon: "🍦", name: "Brain Freeze", desc: "Unlock 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l20", icon: "🍨", name: "Fruit Collector", desc: "Unlock 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l40", icon: "👑", name: "Ice Cream King", desc: "Unlock all 40 levels.", stat: "levels", goal: 40, rank: "epic" },
    { id: "s50k", icon: "🍓", name: "Sweet Score", desc: "Get 50,000 points across all levels.", stat: "score", goal: 50000, rank: "rare" },
  ],
  "Bob the Robber": [
    { id: "l1", icon: "🕵️", name: "Sneaky", desc: "Complete the first level.", stat: "l1", goal: 2, rank: "common" },
    { id: "l3", icon: "💰", name: "Smooth Criminal", desc: "Complete level 3.", stat: "l3", goal: 2, rank: "rare" },
    { id: "l6", icon: "👑", name: "The Perfect Heist", desc: "Complete all 6 levels.", stat: "l6", goal: 2, rank: "epic" },
  ],
  "Bob the Robber 2": [
    { id: "l5", icon: "🔦", name: "Break-In", desc: "Unlock 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l11", icon: "🏦", name: "Heist Planner", desc: "Unlock all 11 levels.", stat: "levels", goal: 11, rank: "rare" },
    { id: "st20", icon: "⭐", name: "Star Thief", desc: "Collect 20 stars.", stat: "stars", goal: 20, rank: "rare" },
    { id: "m10k", icon: "💵", name: "Big Score", desc: "Steal $10,000 in total.", stat: "money", goal: 10000, rank: "epic" },
  ],
  "Chaos Faction 2": [
    { id: "l1", icon: "⚔️", name: "First Blood", desc: "Complete a level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l10", icon: "💥", name: "Brawler", desc: "Complete 10 levels.", stat: "levels", goal: 10, rank: "rare" },
    { id: "l20", icon: "👑", name: "Chaos Master", desc: "Complete all 20 levels.", stat: "levels", goal: 20, rank: "epic" },
    { id: "w10", icon: "🔫", name: "Armory", desc: "Unlock 10 weapons.", stat: "weapons", goal: 10, rank: "rare" },
    { id: "c5", icon: "🧑‍🤝‍🧑", name: "Fighters Assemble", desc: "Unlock 5 characters.", stat: "chars", goal: 5, rank: "common" },
    { id: "a10", icon: "🏅", name: "Faction Hero", desc: "Unlock 10 of the game’s own achievements.", stat: "ach", goal: 10, rank: "epic" },
  ],
  "Fancy Pants Adventure": [
    { id: "lv2", icon: "👖", name: "Stylish Start", desc: "Unlock level 2.", stat: "level", goal: 2, rank: "common" },
    { id: "lv3", icon: "🌀", name: "Spiral Runner", desc: "Unlock the final level (3).", stat: "level", goal: 3, rank: "rare" },
    { id: "t1", icon: "🏆", name: "Trophy Hunter", desc: "Get a trophy.", stat: "trophies", goal: 1, rank: "rare" },
    { id: "t5", icon: "👑", name: "Fanciest Pants", desc: "Get all 5 trophies.", stat: "trophies", goal: 5, rank: "legendary" },
  ],
  "Flood Runner 2": [
    { id: "s5k", icon: "🌊", name: "Outrun the Wave", desc: "Score 5,000.", stat: "best", goal: 5000, rank: "common" },
    { id: "s20k", icon: "🏃", name: "Flood Dodger", desc: "Score 20,000.", stat: "best", goal: 20000, rank: "rare" },
    { id: "s50k", icon: "🏆", name: "Flood Legend", desc: "Score 50,000.", stat: "best", goal: 50000, rank: "epic" },
  ],
  "Flood Runner 4": [
    { id: "a1", icon: "🌊", name: "First Feat", desc: "Complete one of the game’s achievements.", stat: "ach", goal: 1, rank: "common" },
    { id: "a5", icon: "🐉", name: "Monster Masher", desc: "Complete 5 achievements.", stat: "ach", goal: 5, rank: "rare" },
    { id: "a12", icon: "⚡", name: "Storm Chaser", desc: "Complete 12 achievements.", stat: "ach", goal: 12, rank: "epic" },
    { id: "a20", icon: "👑", name: "Flood Master", desc: "Complete 20 achievements.", stat: "ach", goal: 20, rank: "legendary" },
  ],
  "8 Ball Classic": [
    { id: "g1", icon: "🎱", name: "Break Shot", desc: "Play a game.", stat: "games", goal: 1, rank: "common" },
    { id: "g10", icon: "🟢", name: "Pool Regular", desc: "Play 10 games.", stat: "games", goal: 10, rank: "common" },
    { id: "g50", icon: "🏆", name: "Pool Shark", desc: "Play 50 games.", stat: "games", goal: 50, rank: "rare" },
    { id: "g200", icon: "🏆", name: "Cue Master", desc: "Play 200 games.", stat: "games", goal: 200, rank: "epic" },
  ],
  "Infiltrating the Airship": [
    { id: "m1", icon: "🎖️", name: "Medal of Honor", desc: "Earn a medal.", stat: "medals", goal: 1, rank: "common" },
    { id: "m5", icon: "🏅", name: "Decorated Agent", desc: "Earn 5 medals.", stat: "medals", goal: 5, rank: "rare" },
    { id: "m10", icon: "👑", name: "Airship Legend", desc: "Earn 10 medals.", stat: "medals", goal: 10, rank: "epic" },
    { id: "i15", icon: "🛩️", name: "Covert Operative", desc: "Unlock 15 endings, medals or tools.", stat: "items", goal: 15, rank: "rare" },
    { id: "i40", icon: "🕵️", name: "Infiltration Expert", desc: "Unlock 40 endings, medals or tools.", stat: "items", goal: 40, rank: "legendary" },
  ],
  "Angry Birds Showdown": [
    { id: "m1", icon: "🐦", name: "Showdown!", desc: "Play a match.", stat: "matches", goal: 1, rank: "common" },
    { id: "m10", icon: "🐷", name: "Pig Popper", desc: "Play 10 matches.", stat: "matches", goal: 10, rank: "rare" },
    { id: "m30", icon: "👑", name: "Showdown Champ", desc: "Play 30 matches.", stat: "matches", goal: 30, rank: "epic" },
    { id: "p5", icon: "⚡", name: "Powered Up", desc: "Upgrade a power-up to level 5.", stat: "power", goal: 5, rank: "rare" },
  ],
  "Awesome Tanks": [
    { id: "l3", icon: "🛡️", name: "Rolling Out", desc: "Beat 3 levels.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "💣", name: "Tank Commander", desc: "Beat 8 of the 15 levels.", stat: "levels", goal: 8, rank: "rare" },
    { id: "done", icon: "🏆", name: "Awesome!", desc: "Beat the whole game.", stat: "done", goal: 1, rank: "epic" },
    { id: "t100", icon: "💥", name: "Tank Buster", desc: "Destroy 100 enemy tanks.", stat: "tanks", goal: 100, rank: "rare" },
    { id: "c500", icon: "🪙", name: "Scrap Collector", desc: "Collect 500 coins.", stat: "coins", goal: 500, rank: "common" },
    { id: "a5", icon: "👑", name: "Decorated Tank", desc: "Unlock all 5 of the game’s achievements.", stat: "ach", goal: 5, rank: "legendary" },
  ],
  "Big Tower Tiny Square": [
    { id: "j500", icon: "⬛", name: "Tiny Hops", desc: "Jump 500 times.", stat: "jumps", goal: 500, rank: "common" },
    { id: "j5k", icon: "🧗", name: "Tower Climber", desc: "Jump 5,000 times.", stat: "jumps", goal: 5000, rank: "rare" },
    { id: "d100", icon: "💀", name: "Pixel Perseverance", desc: "Die 100 times.", stat: "deaths", goal: 100, rank: "common" },
    { id: "d1000", icon: "☠️", name: "Not Giving Up", desc: "Die 1,000 times.", stat: "deaths", goal: 1000, rank: "epic" },
  ],
  "Big ICE Tower Tiny Square": [
    { id: "j500", icon: "⬛", name: "Tiny Hops", desc: "Jump 500 times.", stat: "jumps", goal: 500, rank: "common" },
    { id: "j5k", icon: "🧗", name: "Tower Climber", desc: "Jump 5,000 times.", stat: "jumps", goal: 5000, rank: "rare" },
    { id: "d100", icon: "💀", name: "Pixel Perseverance", desc: "Die 100 times.", stat: "deaths", goal: 100, rank: "common" },
    { id: "d1000", icon: "☠️", name: "Not Giving Up", desc: "Die 1,000 times.", stat: "deaths", goal: 1000, rank: "epic" },
  ],
  "Basketball Stars": [
    { id: "dunk10", icon: "🏀", name: "Slam Dunk", desc: "Make 10 dunks.", stat: "dunks", goal: 10, rank: "common" },
    { id: "three25", icon: "🎯", name: "Downtown", desc: "Hit 25 three-pointers.", stat: "threes", goal: 25, rank: "rare" },
    { id: "block25", icon: "✋", name: "Rejected!", desc: "Block 25 shots.", stat: "blocks", goal: 25, rank: "rare" },
    { id: "steal25", icon: "🦊", name: "Pickpocket", desc: "Make 25 steals.", stat: "steals", goal: 25, rank: "rare" },
    { id: "cup1", icon: "🏆", name: "Cup Winner", desc: "Win a cup.", stat: "cups", goal: 1, rank: "epic" },
    { id: "cup3", icon: "👑", name: "Basketball Star", desc: "Win 3 cups.", stat: "cups", goal: 3, rank: "legendary" },
  ],
  "Bank Robbery 3": [
    { id: "l3", icon: "🏦", name: "Inside Job", desc: "Reach level 3.", stat: "level", goal: 3, rank: "common" },
    { id: "l8", icon: "💎", name: "Vault Cracker", desc: "Reach level 8.", stat: "level", goal: 8, rank: "rare" },
    { id: "l10", icon: "👑", name: "Heist Legend", desc: "Reach level 10.", stat: "level", goal: 10, rank: "epic" },
    { id: "m5k", icon: "💰", name: "Loaded", desc: "Have $5,000.", stat: "money", goal: 5000, rank: "rare" },
  ],
  "Bit Planes": [
    { id: "k25", icon: "✈️", name: "Dogfighter", desc: "Shoot down 25 planes.", stat: "killed", goal: 25, rank: "common" },
    { id: "k250", icon: "🎖️", name: "Flying Ace", desc: "Shoot down 250 planes.", stat: "killed", goal: 250, rank: "rare" },
    { id: "m100", icon: "🚀", name: "Missile Command", desc: "Fire 100 missiles.", stat: "missiles", goal: 100, rank: "common" },
    { id: "cow", icon: "🐄", name: "Udderly Ridiculous", desc: "Take out a cow.", stat: "cows", goal: 1, rank: "epic" },
  ],
  "Riddle School 4": [
    { id: "beat", icon: "🎓", name: "Field Trip Over", desc: "Beat Riddle School 4.", stat: "beat", goal: 1, rank: "epic" },
  ],
  "Riddle School 5": [
    { id: "beat", icon: "🎓", name: "Graduated", desc: "Beat Riddle School 5.", stat: "beat", goal: 1, rank: "epic" },
  ],
  "Riddle Transfer": [
    { id: "beat", icon: "🚌", name: "Transferred", desc: "Beat Riddle Transfer.", stat: "beat", goal: 1, rank: "epic" },
  ],
  "Run": [
    { id: "a10", icon: "👽", name: "Space Jogger", desc: "Reach adventure level 10.", stat: "adv", goal: 10, rank: "common" },
    { id: "a30", icon: "🌌", name: "Tunnel Explorer", desc: "Reach adventure level 30.", stat: "adv", goal: 30, rank: "rare" },
    { id: "a50", icon: "👑", name: "Run Legend", desc: "Reach adventure level 50.", stat: "adv", goal: 50, rank: "epic" },
    { id: "i10", icon: "♾️", name: "Infinite Runner", desc: "Complete 10 infinite-mode tunnels.", stat: "inf", goal: 10, rank: "rare" },
  ],
  "Run 2": [
    { id: "l10", icon: "👽", name: "Back in the Tunnel", desc: "Reach level 10.", stat: "level", goal: 10, rank: "common" },
    { id: "l30", icon: "🌌", name: "Deep Space", desc: "Reach level 30.", stat: "level", goal: 30, rank: "rare" },
    { id: "l50", icon: "👑", name: "Tunnel Master", desc: "Reach level 50.", stat: "level", goal: 50, rank: "epic" },
    { id: "b5", icon: "🔋", name: "Bonus Round", desc: "Complete 5 bonus levels.", stat: "bonus", goal: 5, rank: "rare" },
  ],
  "Snail Bob": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🏡", name: "On the Move", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "beat", icon: "👑", name: "Home Sweet Home", desc: "Complete the final level.", stat: "beat", goal: 1, rank: "rare" },
    { id: "s3k", icon: "⭐", name: "High Scorer", desc: "Score 3,000 points across all levels.", stat: "score", goal: 3000, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 20 levels.", stat: "levels", goal: 20, rank: "epic" },
  ],
  "Snail Bob 2": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🏡", name: "On the Move", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "beat", icon: "👑", name: "Grandpa’s Birthday", desc: "Complete the final level.", stat: "beat", goal: 1, rank: "rare" },
    { id: "s3k", icon: "⭐", name: "High Scorer", desc: "Score 3,000 points across all levels.", stat: "score", goal: 3000, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Snail Bob 3": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🏡", name: "On the Move", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "beat", icon: "👑", name: "Egyptian Adventure", desc: "Complete the final level.", stat: "beat", goal: 1, rank: "rare" },
    { id: "s3k", icon: "⭐", name: "High Scorer", desc: "Score 3,000 points across all levels.", stat: "score", goal: 3000, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Snail Bob 4": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🏡", name: "On the Move", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "beat", icon: "👑", name: "Space Explorer", desc: "Complete the final level.", stat: "beat", goal: 1, rank: "rare" },
    { id: "s3k", icon: "⭐", name: "High Scorer", desc: "Score 3,000 points across all levels.", stat: "score", goal: 3000, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Bouncy Motors": [
    { id: "l5", icon: "🚗", name: "Bouncing Along", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l20", icon: "🏁", name: "Road Warrior", desc: "Complete 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l30", icon: "👑", name: "Bouncy Legend", desc: "Complete 30 levels.", stat: "levels", goal: 30, rank: "epic" },
    { id: "k100", icon: "💥", name: "Stickman Smasher", desc: "Knock over 100 stickmen.", stat: "stickmen", goal: 100, rank: "rare" },
    { id: "m5k", icon: "💰", name: "Car Fund", desc: "Have 5,000 money.", stat: "money", goal: 5000, rank: "common" },
  ],
  "Bob the Robber 5": [
    { id: "l3", icon: "🔦", name: "Night Shift", desc: "Clear 3 stages.", stat: "levels", goal: 3, rank: "common" },
    { id: "s15", icon: "⭐", name: "Star Burglar", desc: "Earn 15 stars.", stat: "stars", goal: 15, rank: "rare" },
    { id: "d10", icon: "📁", name: "Secret Files", desc: "Steal 10 documents.", stat: "docs", goal: 10, rank: "rare" },
    { id: "end", icon: "👑", name: "The Last Job", desc: "Reach the ending.", stat: "end", goal: 1, rank: "epic" },
  ],
  "BitLife": [
    { id: "s5", icon: "👶", name: "New Beginnings", desc: "Start 5 lives.", stat: "started", goal: 5, rank: "common" },
    { id: "d1", icon: "⚰️", name: "A Full Life", desc: "Live a life to the end.", stat: "done", goal: 1, rank: "common" },
    { id: "d10", icon: "📖", name: "Many Lives", desc: "Complete 10 lives.", stat: "done", goal: 10, rank: "rare" },
    { id: "d50", icon: "👑", name: "Reincarnated", desc: "Complete 50 lives.", stat: "done", goal: 50, rank: "epic" },
  ],
  "Parking Fury": [
    { id: "l1", icon: "🅿️", name: "First Spot", desc: "Complete your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🚙", name: "Parallel Parker", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l10", icon: "🏁", name: "Parking Pro", desc: "Complete all 10 levels.", stat: "levels", goal: 10, rank: "rare" },
    { id: "p3", icon: "⭐", name: "Clean Park", desc: "Get 3 stars on 3 levels.", stat: "perfect", goal: 3, rank: "rare" },
    { id: "p10", icon: "👑", name: "Perfect Parker", desc: "Get 3 stars on all 10 levels.", stat: "perfect", goal: 10, rank: "epic" },
  ],
  "Parking Fury 2": [
    { id: "l1", icon: "🅿️", name: "First Spot", desc: "Complete your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🚙", name: "Parallel Parker", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l10", icon: "🏁", name: "Parking Pro II", desc: "Complete all 10 levels.", stat: "levels", goal: 10, rank: "rare" },
    { id: "p3", icon: "⭐", name: "Clean Park", desc: "Get 3 stars on 3 levels.", stat: "perfect", goal: 3, rank: "rare" },
    { id: "p10", icon: "👑", name: "Perfect Parker", desc: "Get 3 stars on all 10 levels.", stat: "perfect", goal: 10, rank: "epic" },
  ],
  "Parking Fury 3": [
    { id: "l1", icon: "🅿️", name: "First Spot", desc: "Complete your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🚙", name: "Parallel Parker", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l10", icon: "🏁", name: "Parking Pro III", desc: "Complete all 10 levels.", stat: "levels", goal: 10, rank: "rare" },
    { id: "p3", icon: "⭐", name: "Clean Park", desc: "Get 3 stars on 3 levels.", stat: "perfect", goal: 3, rank: "rare" },
    { id: "p10", icon: "👑", name: "Perfect Parker", desc: "Get 3 stars on all 10 levels.", stat: "perfect", goal: 10, rank: "epic" },
  ],
  "World's Hardest Game 3": [
    { id: "l5", icon: "🟥", name: "Still Hard", desc: "Reach level 5.", stat: "level", goal: 5, rank: "common" },
    { id: "l15", icon: "🟦", name: "Harder Still", desc: "Reach level 15.", stat: "level", goal: 15, rank: "rare" },
    { id: "l20", icon: "👑", name: "The Hardest", desc: "Reach level 20.", stat: "level", goal: 20, rank: "epic" },
    { id: "d500", icon: "💀", name: "Determined", desc: "Die 500 times.", stat: "deaths", goal: 500, rank: "common" },
  ],
  "Hanger 2": [
    { id: "b500", icon: "🪢", name: "Hanging On", desc: "Score 500 in one run.", stat: "best", goal: 500, rank: "common" },
    { id: "b2k", icon: "🕸️", name: "Swing King", desc: "Score 2,000 in one run.", stat: "best", goal: 2000, rank: "rare" },
    { id: "b5k", icon: "👑", name: "Rope Master", desc: "Score 5,000 in one run.", stat: "best", goal: 5000, rank: "epic" },
    { id: "sk5", icon: "🎨", name: "Wardrobe", desc: "Unlock 5 skins.", stat: "skins", goal: 5, rank: "rare" },
    { id: "c1k", icon: "🪙", name: "Coin Swinger", desc: "Collect 1,000 coins.", stat: "coins", goal: 1000, rank: "common" },
  ],
  "Spacebar Clicker": [
    { id: "p1k", icon: "⌨️", name: "Tap Tap Tap", desc: "Earn 1,000 points.", stat: "points", goal: 1000, rank: "common" },
    { id: "p1m", icon: "🚀", name: "Space Program", desc: "Earn 1,000,000 points.", stat: "points", goal: 1000000, rank: "rare" },
    { id: "p1b", icon: "🌌", name: "Galactic Clicker", desc: "Earn 1,000,000,000 points.", stat: "points", goal: 1000000000, rank: "epic" },
    { id: "u50", icon: "🛠️", name: "Upgraded", desc: "Buy 50 upgrade levels.", stat: "upgrades", goal: 50, rank: "rare" },
  ],
  "Google Baseball": [
    { id: "s10", icon: "⚾", name: "Batter Up", desc: "Score 10 runs.", stat: "best", goal: 10, rank: "common" },
    { id: "s50", icon: "🌭", name: "Home Run Derby", desc: "Score 50 runs.", stat: "best", goal: 50, rank: "rare" },
    { id: "s100", icon: "🏆", name: "Slugger", desc: "Score 100 runs.", stat: "best", goal: 100, rank: "epic" },
  ],
  "Capybara Clicker": [
    { id: "c100", icon: "🖱️", name: "Pet the Capybara", desc: "Click 100 times.", stat: "clicks", goal: 100, rank: "common" },
    { id: "c5k", icon: "👆", name: "Capy Clicker", desc: "Click 5,000 times.", stat: "clicks", goal: 5000, rank: "rare" },
    { id: "e1k", icon: "🦫", name: "Capybara Colony", desc: "Earn 1,000 capybaras.", stat: "capys", goal: 1000, rank: "common" },
    { id: "e1m", icon: "🌴", name: "Capybara Paradise", desc: "Earn 1,000,000 capybaras.", stat: "capys", goal: 1000000, rank: "epic" },
    { id: "a5", icon: "🏅", name: "Chill Achiever", desc: "Unlock 5 of the game’s achievements.", stat: "ach", goal: 5, rank: "rare" },
  ],
  "Choppy Orc": [
    { id: "l5", icon: "🪓", name: "Choppy Start", desc: "Reach level 5.", stat: "level", goal: 5, rank: "common" },
    { id: "l15", icon: "👹", name: "Orc Warrior", desc: "Reach level 15.", stat: "level", goal: 15, rank: "rare" },
    { id: "l20", icon: "👑", name: "Orc Chieftain", desc: "Reach level 20.", stat: "level", goal: 20, rank: "epic" },
  ],
  "Cleanup.io": [
    { id: "l5", icon: "🧹", name: "Tidy Up", desc: "Reach level 5.", stat: "level", goal: 5, rank: "common" },
    { id: "l20", icon: "🧽", name: "Neat Freak", desc: "Reach level 20.", stat: "level", goal: 20, rank: "rare" },
    { id: "b1k", icon: "🗑️", name: "Spotless", desc: "Get a best score of 1,000.", stat: "best", goal: 1000, rank: "rare" },
    { id: "b5k", icon: "👑", name: "Cleanup Champion", desc: "Get a best score of 5,000.", stat: "best", goal: 5000, rank: "epic" },
  ],
  "Crazy Cars": [
    { id: "d10k", icon: "🚗", name: "Road Trip", desc: "Drive 10,000 m in total.", stat: "dist", goal: 10000, rank: "common" },
    { id: "d100k", icon: "🛣️", name: "Long Haul", desc: "Drive 100,000 m in total.", stat: "dist", goal: 100000, rank: "rare" },
    { id: "air60", icon: "🛫", name: "Hang Time", desc: "Spend 60 seconds in the air in total.", stat: "air", goal: 60, rank: "rare" },
    { id: "car3", icon: "🏎️", name: "Car Collector", desc: "Own 3 vehicles.", stat: "cars", goal: 3, rank: "epic" },
  ],
  "Crazy Crash Landing": [
    { id: "l1", icon: "✈️", name: "Touchdown", desc: "Complete a level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🛬", name: "Rough Landing", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "rare" },
    { id: "l9", icon: "👑", name: "Crash Expert", desc: "Complete all 9 levels.", stat: "levels", goal: 9, rank: "epic" },
    { id: "e5", icon: "🔧", name: "Tuned Up", desc: "Upgrade the engine 5 times.", stat: "engine", goal: 5, rank: "rare" },
  ],
  "Cut the Rope 2": [
    { id: "l5", icon: "🍬", name: "Om Nom Nom", desc: "Unlock 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l25", icon: "🐸", name: "Candy Hunter", desc: "Unlock 25 levels.", stat: "levels", goal: 25, rank: "rare" },
    { id: "l60", icon: "🌳", name: "Rope Master", desc: "Unlock 60 levels.", stat: "levels", goal: 60, rank: "epic" },
    { id: "l100", icon: "👑", name: "Sweet Tooth", desc: "Unlock 100 levels.", stat: "levels", goal: 100, rank: "legendary" },
  ],
  "Snail Bob 5": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "🏡", name: "On the Move", desc: "Complete 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "beat", icon: "👑", name: "Love Story", desc: "Complete the whole game.", stat: "beat", goal: 1, rank: "rare" },
    { id: "cup", icon: "🏆", name: "Mini Champion", desc: "Win a cup in a mini-game.", stat: "cups", goal: 1, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Snail Bob 6": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "🏡", name: "On the Move", desc: "Complete 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "beat", icon: "👑", name: "Winter Story", desc: "Complete the whole game.", stat: "beat", goal: 1, rank: "rare" },
    { id: "cup", icon: "🏆", name: "Mini Champion", desc: "Win a cup in a mini-game.", stat: "cups", goal: 1, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Snail Bob 7": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "🏡", name: "On the Move", desc: "Complete 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "beat", icon: "👑", name: "Fantasy Story", desc: "Complete the whole game.", stat: "beat", goal: 1, rank: "rare" },
    { id: "cup", icon: "🏆", name: "Mini Champion", desc: "Win a cup in a mini-game.", stat: "cups", goal: 1, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 30 levels.", stat: "levels", goal: 30, rank: "epic" },
  ],
  "Snail Bob 8": [
    { id: "l5", icon: "🐌", name: "Slow and Steady", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "🏡", name: "On the Move", desc: "Complete 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "beat", icon: "👑", name: "Island Story", desc: "Complete the whole game.", stat: "beat", goal: 1, rank: "rare" },
    { id: "cup", icon: "🏆", name: "Mini Champion", desc: "Win a cup in a mini-game.", stat: "cups", goal: 1, rank: "rare" },
    { id: "all", icon: "🏆", name: "Every Level", desc: "Complete all 30 levels.", stat: "levels", goal: 30, rank: "epic" },
  ],
  "Deadly Descent": [
    { id: "c2", icon: "🚙", name: "Second Ride", desc: "Unlock a second car.", stat: "cars", goal: 2, rank: "common" },
    { id: "c5", icon: "🏎️", name: "Garage Full", desc: "Unlock 5 cars.", stat: "cars", goal: 5, rank: "rare" },
    { id: "c6", icon: "👑", name: "Collector", desc: "Unlock 6 cars.", stat: "cars", goal: 6, rank: "epic" },
  ],
  "Death Chase": [
    { id: "c1", icon: "🚗", name: "New Wheels", desc: "Buy a new car.", stat: "cars", goal: 1, rank: "common" },
    { id: "c5", icon: "🔥", name: "Fleet", desc: "Buy 5 cars.", stat: "cars", goal: 5, rank: "rare" },
    { id: "c13", icon: "👑", name: "Death Racer", desc: "Buy every car.", stat: "cars", goal: 13, rank: "epic" },
    { id: "a5", icon: "🛡️", name: "Armored Up", desc: "Buy 5 armor upgrades.", stat: "armor", goal: 5, rank: "rare" },
    { id: "g5", icon: "🔫", name: "Locked and Loaded", desc: "Buy 5 minigun upgrades.", stat: "guns", goal: 5, rank: "rare" },
  ],
  "Death Run 3D": [
    { id: "b1k", icon: "💀", name: "Run for Your Life", desc: "Get a best score of 1,000.", stat: "best", goal: 1000, rank: "common" },
    { id: "b5k", icon: "🌀", name: "Speed Demon", desc: "Get a best score of 5,000.", stat: "best", goal: 5000, rank: "rare" },
    { id: "b20k", icon: "👑", name: "Death Defier", desc: "Get a best score of 20,000.", stat: "best", goal: 20000, rank: "epic" },
  ],
  "Super Mario 63": [
    { id: "s1", icon: "⭐", name: "Here We Go!", desc: "Collect a Shine Sprite.", stat: "stars", goal: 1, rank: "common" },
    { id: "s16", icon: "🌟", name: "Shine Collector", desc: "Collect 16 Shine Sprites.", stat: "stars", goal: 16, rank: "rare" },
    { id: "s40", icon: "✨", name: "Super Star", desc: "Collect 40 Shine Sprites.", stat: "stars", goal: 40, rank: "epic" },
    { id: "s64", icon: "👑", name: "It’s-a Me!", desc: "Collect all 64 Shine Sprites.", stat: "stars", goal: 64, rank: "legendary" },
    { id: "k3", icon: "🔑", name: "Bowser’s Keys", desc: "Collect all 3 Bowser keys.", stat: "keys", goal: 3, rank: "epic" },
    { id: "c10", icon: "🪙", name: "Star Coins", desc: "Collect 10 Star Coins.", stat: "coins", goal: 10, rank: "rare" },
  ],
  "This is the Only Level": [
    { id: "l10", icon: "🐘", name: "Same Level, New Twist", desc: "Reach stage 10.", stat: "level", goal: 10, rank: "common" },
    { id: "l20", icon: "🔁", name: "Deja Vu", desc: "Reach stage 20.", stat: "level", goal: 20, rank: "rare" },
    { id: "l30", icon: "👑", name: "The Only Level, Beaten", desc: "Reach the final stage (30).", stat: "level", goal: 30, rank: "epic" },
    { id: "d100", icon: "💀", name: "Elephant Graveyard", desc: "Die 100 times.", stat: "deaths", goal: 100, rank: "common" },
  ],
  "Draw Climber": [
    { id: "l10", icon: "✏️", name: "Scribbler", desc: "Reach level 10.", stat: "level", goal: 10, rank: "common" },
    { id: "l50", icon: "🧗", name: "Climber", desc: "Reach level 50.", stat: "level", goal: 50, rank: "rare" },
    { id: "l100", icon: "👑", name: "Master Draftsman", desc: "Reach level 100.", stat: "level", goal: 100, rank: "epic" },
    { id: "h5", icon: "🎨", name: "Character Collection", desc: "Unlock 5 characters.", stat: "heroes", goal: 5, rank: "rare" },
  ],
  "Dreadhead Parkour": [
    { id: "l5", icon: "🏃", name: "Parkour Rookie", desc: "Reach level 5.", stat: "level", goal: 5, rank: "common" },
    { id: "l20", icon: "🧱", name: "Free Runner", desc: "Reach level 20.", stat: "level", goal: 20, rank: "rare" },
    { id: "l52", icon: "👑", name: "Dreadhead Legend", desc: "Reach level 52.", stat: "level", goal: 52, rank: "epic" },
    { id: "s50", icon: "⭐", name: "Star Runner", desc: "Earn 50 stars.", stat: "stars", goal: 50, rank: "rare" },
  ],
  "Wheely": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l15", icon: "👑", name: "Wheely Good", desc: "Unlock all 15 levels.", stat: "levels", goal: 15, rank: "epic" },
  ],
  "Wheely 2": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l16", icon: "👑", name: "Wheely Good", desc: "Unlock all 16 levels.", stat: "levels", goal: 16, rank: "epic" },
  ],
  "Wheely 3": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l12", icon: "👑", name: "Wheely Good", desc: "Unlock all 12 levels.", stat: "levels", goal: 12, rank: "epic" },
  ],
  "This is the Only Level Too": [
    { id: "l10", icon: "🐘", name: "Here We Go Again", desc: "Reach stage 10.", stat: "level", goal: 10, rank: "common" },
    { id: "l20", icon: "🔁", name: "Twice the Fun", desc: "Reach stage 20.", stat: "level", goal: 20, rank: "rare" },
    { id: "egg", icon: "🥚", name: "Easter Egg", desc: "Find the hidden egg.", stat: "egg", goal: 1, rank: "epic" },
  ],
  "Eggy Car": [
    { id: "b100", icon: "🥚", name: "Careful Driver", desc: "Drive 100 m without breaking the egg.", stat: "best", goal: 100, rank: "common" },
    { id: "b500", icon: "🚗", name: "Egg-cellent", desc: "Drive 500 m.", stat: "best", goal: 500, rank: "rare" },
    { id: "b1k", icon: "👑", name: "Eggspert", desc: "Drive 1,000 m.", stat: "best", goal: 1000, rank: "epic" },
    { id: "c500", icon: "🪙", name: "Nest Egg", desc: "Collect 500 coins.", stat: "coins", goal: 500, rank: "common" },
  ],
  "Wheely 4: Time Travel": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l16", icon: "👑", name: "Wheely Good", desc: "Unlock all 16 levels.", stat: "levels", goal: 16, rank: "epic" },
  ],
  "Wheely 5: Armageddon": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l16", icon: "👑", name: "Wheely Good", desc: "Unlock all 16 levels.", stat: "levels", goal: 16, rank: "epic" },
  ],
  "Eagle Ride": [
    { id: "j10", icon: "💎", name: "Shiny Things", desc: "Collect 10 jewels.", stat: "jewels", goal: 10, rank: "common" },
    { id: "j100", icon: "🦅", name: "Treasure Flyer", desc: "Collect 100 jewels.", stat: "jewels", goal: 100, rank: "rare" },
    { id: "j500", icon: "👑", name: "King of the Skies", desc: "Collect 500 jewels.", stat: "jewels", goal: 500, rank: "epic" },
  ],
  "Wheely 6: Fairytale": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l14", icon: "👑", name: "Wheely Good", desc: "Unlock all 14 levels.", stat: "levels", goal: 14, rank: "epic" },
  ],
  "Wheely 7: Detective": [
    { id: "l3", icon: "🚗", name: "Rolling", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "🚦", name: "Road Trip", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l15", icon: "👑", name: "Wheely Good", desc: "Unlock all 15 levels.", stat: "levels", goal: 15, rank: "epic" },
  ],
  "Fireboy and Watergirl 2: Light Temple": [
    { id: "l1", icon: "🔥", name: "Into the Light Temple", desc: "Finish your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l10", icon: "💧", name: "Teamwork", desc: "Finish 10 levels.", stat: "levels", goal: 10, rank: "common" },
    { id: "l20", icon: "🗝️", name: "Deep in the Temple", desc: "Finish 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l41", icon: "💎", name: "Every Room", desc: "Finish all 41 levels.", stat: "levels", goal: 41, rank: "epic" },
    { id: "done", icon: "👑", name: "Light Temple Conquered", desc: "Complete the game.", stat: "done", goal: 1, rank: "legendary" },
  ],
  "Fireboy and Watergirl 3: Ice Temple": [
    { id: "l1", icon: "🔥", name: "Into the Ice Temple", desc: "Finish your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l10", icon: "💧", name: "Teamwork", desc: "Finish 10 levels.", stat: "levels", goal: 10, rank: "common" },
    { id: "l20", icon: "🗝️", name: "Deep in the Temple", desc: "Finish 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l37", icon: "💎", name: "Every Room", desc: "Finish all 37 levels.", stat: "levels", goal: 37, rank: "epic" },
    { id: "done", icon: "👑", name: "Ice Temple Conquered", desc: "Complete the game.", stat: "done", goal: 1, rank: "legendary" },
  ],
  "Fireboy and Watergirl 4: Crystal Temple": [
    { id: "l1", icon: "🔥", name: "Into the Crystal Temple", desc: "Finish your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l10", icon: "💧", name: "Teamwork", desc: "Finish 10 levels.", stat: "levels", goal: 10, rank: "common" },
    { id: "l20", icon: "🗝️", name: "Deep in the Temple", desc: "Finish 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l39", icon: "💎", name: "Every Room", desc: "Finish all 39 levels.", stat: "levels", goal: 39, rank: "epic" },
    { id: "done", icon: "👑", name: "Crystal Temple Conquered", desc: "Complete the game.", stat: "done", goal: 1, rank: "legendary" },
  ],
  "Wheely 8: Aliens": [
    { id: "l3", icon: "🛸", name: "Close Encounter", desc: "Unlock level 3.", stat: "levels", goal: 3, rank: "common" },
    { id: "l8", icon: "👽", name: "Abducted", desc: "Unlock level 8.", stat: "levels", goal: 8, rank: "rare" },
    { id: "l12", icon: "👑", name: "Wheely Good", desc: "Unlock all 12 levels.", stat: "levels", goal: 12, rank: "epic" },
  ],
  "Bad Ice Cream 2": [
    { id: "l5", icon: "🍦", name: "Brain Freeze", desc: "Unlock 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l20", icon: "🍨", name: "Fruit Collector", desc: "Unlock 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l40", icon: "👑", name: "Scoop Supreme", desc: "Unlock all 40 levels.", stat: "levels", goal: 40, rank: "epic" },
    { id: "s50k", icon: "🍓", name: "Sweet Score", desc: "Get 50,000 points across all levels.", stat: "score", goal: 50000, rank: "rare" },
  ],
  "Bad Ice Cream 3": [
    { id: "l5", icon: "🍦", name: "Brain Freeze", desc: "Unlock 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l20", icon: "🍨", name: "Fruit Collector", desc: "Unlock 20 levels.", stat: "levels", goal: 20, rank: "rare" },
    { id: "l40", icon: "👑", name: "Ice Cream Royalty", desc: "Unlock all 40 levels.", stat: "levels", goal: 40, rank: "epic" },
    { id: "s50k", icon: "🍓", name: "Sweet Score", desc: "Get 50,000 points across all levels.", stat: "score", goal: 50000, rank: "rare" },
  ],
  "Angry Birds Space": [
    { id: "l1", icon: "🚀", name: "Liftoff", desc: "Clear a level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l10", icon: "🪐", name: "Space Explorer", desc: "Clear 10 levels.", stat: "levels", goal: 10, rank: "common" },
    { id: "l29", icon: "🌌", name: "Galaxy Hopper", desc: "Clear all 29 levels.", stat: "levels", goal: 29, rank: "rare" },
    { id: "s60", icon: "⭐", name: "Star Gazer", desc: "Earn 60 stars.", stat: "stars", goal: 60, rank: "epic" },
    { id: "sc1m", icon: "👑", name: "Space Ace", desc: "Score 1,000,000 points in total.", stat: "score", goal: 1000000, rank: "legendary" },
  ],
  "Getaway Shootout": [
    { id: "c3", icon: "🕴️", name: "New Recruit", desc: "Unlock 3 characters.", stat: "chars", goal: 3, rank: "common" },
    { id: "c10", icon: "🎩", name: "Gang Leader", desc: "Unlock 10 characters.", stat: "chars", goal: 10, rank: "rare" },
    { id: "c15", icon: "👑", name: "Full Crew", desc: "Unlock 15 characters.", stat: "chars", goal: 15, rank: "epic" },
    { id: "m500", icon: "🪙", name: "Getaway Cash", desc: "Have 500 coins.", stat: "coins", goal: 500, rank: "rare" },
  ],
  "Highway Traffic": [
    { id: "c2", icon: "🚗", name: "Second Car", desc: "Own 2 cars.", stat: "cars", goal: 2, rank: "common" },
    { id: "c5", icon: "🚓", name: "Fleet", desc: "Own 5 cars.", stat: "cars", goal: 5, rank: "rare" },
    { id: "c6", icon: "👑", name: "Highway King", desc: "Own 6 cars.", stat: "cars", goal: 6, rank: "epic" },
  ],
  "Helix Jump": [
    { id: "b2", icon: "⚪", name: "New Ball", desc: "Unlock a new ball.", stat: "balls", goal: 2, rank: "common" },
    { id: "b5", icon: "🔴", name: "Ball Collector", desc: "Unlock 5 balls.", stat: "balls", goal: 5, rank: "rare" },
    { id: "b6", icon: "👑", name: "Helix Master", desc: "Unlock 6 balls.", stat: "balls", goal: 6, rank: "epic" },
  ],
  "Ice Dodo": [
    { id: "c1", icon: "🏆", name: "First Cup", desc: "Win a cup.", stat: "cups", goal: 1, rank: "common" },
    { id: "c5", icon: "❄️", name: "Slippery Champion", desc: "Win 5 cups.", stat: "cups", goal: 5, rank: "rare" },
    { id: "c10", icon: "👑", name: "Dodo Legend", desc: "Win 10 cups.", stat: "cups", goal: 10, rank: "epic" },
  ],
  "Idle Dice": [
    { id: "s1m", icon: "🎲", name: "Lucky Roll", desc: "Earn 1 million points.", stat: "score", goal: 1000000, rank: "common" },
    { id: "s1b", icon: "🎰", name: "High Roller", desc: "Earn 1 billion points.", stat: "score", goal: 1000000000, rank: "rare" },
    { id: "s1t", icon: "💎", name: "Dice Tycoon", desc: "Earn 1 trillion points.", stat: "score", goal: 1000000000000, rank: "epic" },
    { id: "s1q", icon: "👑", name: "Infinite Luck", desc: "Earn 1 quadrillion points.", stat: "score", goal: 1000000000000000, rank: "legendary" },
  ],
  "Johnny Trigger": [
    { id: "l10", icon: "🔫", name: "Trigger Happy", desc: "Reach level 10.", stat: "level", goal: 10, rank: "common" },
    { id: "l50", icon: "🕶️", name: "Hitman", desc: "Reach level 50.", stat: "level", goal: 50, rank: "rare" },
    { id: "l100", icon: "👑", name: "Johnny Legend", desc: "Reach level 100.", stat: "level", goal: 100, rank: "epic" },
    { id: "s5", icon: "🎨", name: "Wardrobe", desc: "Unlock 5 characters.", stat: "skins", goal: 5, rank: "rare" },
  ],
  "Moto X3M": [
    { id: "l5", icon: "🏍️", name: "Rev It Up", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🔥", name: "Flip Master", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "l25", icon: "👑", name: "Moto Legend", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Moto X3M 2": [
    { id: "l5", icon: "🏍️", name: "Rev It Up", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🔥", name: "Flip Master", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "l25", icon: "👑", name: "Moto Legend II", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Moto X3M 3": [
    { id: "l5", icon: "🏍️", name: "Rev It Up", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🔥", name: "Flip Master", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "l22", icon: "👑", name: "Moto Legend III", desc: "Complete all 22 levels.", stat: "levels", goal: 22, rank: "epic" },
  ],
  "Moto X3M: Pool Party": [
    { id: "l5", icon: "🏍️", name: "Rev It Up", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🔥", name: "Flip Master", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "l22", icon: "👑", name: "Pool Party Pro", desc: "Complete all 22 levels.", stat: "levels", goal: 22, rank: "epic" },
  ],
  "Moto X3M: Spooky Land": [
    { id: "l5", icon: "🏍️", name: "Rev It Up", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🔥", name: "Flip Master", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "l22", icon: "👑", name: "Spooky Rider", desc: "Complete all 22 levels.", stat: "levels", goal: 22, rank: "epic" },
  ],
  "Moto X3M: Winter": [
    { id: "l5", icon: "🏍️", name: "Rev It Up", desc: "Complete 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l12", icon: "🔥", name: "Flip Master", desc: "Complete 12 levels.", stat: "levels", goal: 12, rank: "rare" },
    { id: "l25", icon: "👑", name: "Winter Rider", desc: "Complete all 25 levels.", stat: "levels", goal: 25, rank: "epic" },
  ],
  "Plonky": [
    { id: "l5", icon: "🟢", name: "Bouncy Start", desc: "Reach level 5.", stat: "level", goal: 5, rank: "common" },
    { id: "l20", icon: "🎈", name: "Plonky Pro", desc: "Reach level 20.", stat: "level", goal: 20, rank: "rare" },
    { id: "l52", icon: "👑", name: "Plonky Legend", desc: "Reach level 52.", stat: "level", goal: 52, rank: "epic" },
    { id: "s50", icon: "⭐", name: "Star Bouncer", desc: "Earn 50 stars.", stat: "stars", goal: 50, rank: "rare" },
  ],
  "Snow Rider 3D": [
    { id: "p10", icon: "🛷", name: "Sledder", desc: "Go sledding 10 times.", stat: "plays", goal: 10, rank: "common" },
    { id: "p50", icon: "❄️", name: "Snow Day", desc: "Go sledding 50 times.", stat: "plays", goal: 50, rank: "rare" },
    { id: "p200", icon: "🏔️", name: "Winter Legend", desc: "Go sledding 200 times.", stat: "plays", goal: 200, rank: "epic" },
    { id: "skin", icon: "🎨", name: "New Ride", desc: "Switch to a different sled.", stat: "skin", goal: 1, rank: "common" },
  ],
  "Snow Road": [
    { id: "p10", icon: "🏂", name: "Downhill", desc: "Ride 10 times.", stat: "plays", goal: 10, rank: "common" },
    { id: "p50", icon: "⛷️", name: "Snow Day", desc: "Ride 50 times.", stat: "plays", goal: 50, rank: "rare" },
    { id: "p200", icon: "🏔️", name: "Mountain Legend", desc: "Ride 200 times.", stat: "plays", goal: 200, rank: "epic" },
    { id: "skin", icon: "🎨", name: "Fresh Look", desc: "Switch to a different skin.", stat: "skin", goal: 1, rank: "common" },
  ],
  "State.io": [
    { id: "w1", icon: "🗺️", name: "First Conquest", desc: "Win a battle.", stat: "wins", goal: 1, rank: "common" },
    { id: "w25", icon: "⚔️", name: "Warlord", desc: "Win 25 battles.", stat: "wins", goal: 25, rank: "rare" },
    { id: "w100", icon: "👑", name: "Emperor", desc: "Win 100 battles.", stat: "wins", goal: 100, rank: "epic" },
    { id: "l50", icon: "🌍", name: "World Domination", desc: "Reach level 50.", stat: "level", goal: 50, rank: "rare" },
  ],
  "Speed Stars": [
    { id: "s1k", icon: "🏃", name: "Off the Blocks", desc: "Reach a total score of 1,000.", stat: "score", goal: 1000, rank: "common" },
    { id: "s10k", icon: "⚡", name: "Sprinter", desc: "Reach a total score of 10,000.", stat: "score", goal: 10000, rank: "rare" },
    { id: "s50k", icon: "🥇", name: "Olympian", desc: "Reach a total score of 50,000.", stat: "score", goal: 50000, rank: "epic" },
    { id: "s200k", icon: "👑", name: "Speed Star", desc: "Reach a total score of 200,000.", stat: "score", goal: 200000, rank: "legendary" },
  ],
  "Stick Fighter": [
    { id: "c2", icon: "🥋", name: "New Fighter", desc: "Unlock a second fighter.", stat: "chars", goal: 2, rank: "common" },
    { id: "c4", icon: "🤺", name: "Dojo", desc: "Unlock 4 fighters.", stat: "chars", goal: 4, rank: "rare" },
    { id: "c6", icon: "👑", name: "Full Roster", desc: "Unlock all 6 fighters.", stat: "chars", goal: 6, rank: "epic" },
    { id: "m500", icon: "🪙", name: "Prize Money", desc: "Have 500 coins.", stat: "coins", goal: 500, rank: "rare" },
  ],
  "Super Liquid Soccer": [
    { id: "w1", icon: "⚽", name: "First Win", desc: "Win a match.", stat: "wins", goal: 1, rank: "common" },
    { id: "w25", icon: "🥅", name: "Winning Streak", desc: "Win 25 matches.", stat: "wins", goal: 25, rank: "rare" },
    { id: "g100", icon: "🎯", name: "Goal Machine", desc: "Score 100 goals.", stat: "goals", goal: 100, rank: "rare" },
    { id: "ac", icon: "🏆", name: "Amateur Champion", desc: "Win the amateur cup.", stat: "cups", goal: 1, rank: "common" },
    { id: "pc", icon: "🥇", name: "Pro Champion", desc: "Win the pro cup.", stat: "cups2", goal: 1, rank: "epic" },
    { id: "gc", icon: "👑", name: "World Champion", desc: "Win the global cup.", stat: "cups3", goal: 1, rank: "legendary" },
  ],
  "Crazy Cattle 3D": [
    { id: "b1", icon: "🐑", name: "Baa-ttle Won", desc: "Beat a level.", stat: "beaten", goal: 1, rank: "common" },
    { id: "b3", icon: "🐄", name: "Stampede", desc: "Beat 3 levels.", stat: "beaten", goal: 3, rank: "epic" },
    { id: "w10", icon: "🏆", name: "Last Sheep Standing", desc: "Win 10 rounds.", stat: "wins", goal: 10, rank: "rare" },
  ],
  "Super Star Car": [
    { id: "r10", icon: "🏎️", name: "Racer", desc: "Finish 10 races.", stat: "races", goal: 10, rank: "common" },
    { id: "r100", icon: "🏁", name: "Veteran Racer", desc: "Finish 100 races.", stat: "races", goal: 100, rank: "rare" },
    { id: "c1", icon: "🥇", name: "Champion", desc: "Win a championship.", stat: "champ", goal: 1, rank: "rare" },
    { id: "c10", icon: "👑", name: "Superstar", desc: "Win 10 championships.", stat: "champ", goal: 10, rank: "epic" },
    { id: "t5", icon: "🏆", name: "Trophy Case", desc: "Earn 5 trophies.", stat: "trophy", goal: 5, rank: "rare" },
  ],
  "Vex 4": [
    { id: "l1", icon: "🟢", name: "First Act", desc: "Finish your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🧗", name: "Halfway Vexed", desc: "Finish 5 levels.", stat: "levels", goal: 5, rank: "rare" },
    { id: "l11", icon: "🏆", name: "Vex Champion", desc: "Finish every level.", stat: "levels", goal: 11, rank: "epic" },
    { id: "a10", icon: "⭐", name: "Achiever", desc: "Unlock 10 of Vex 4’s own achievements.", stat: "ach", goal: 10, rank: "rare" },
    { id: "d100", icon: "💀", name: "Persistent", desc: "Die 100 times.", stat: "deaths", goal: 100, rank: "common" },
  ],
  "Vex 6": [
    { id: "l1", icon: "🟢", name: "First Act", desc: "Finish your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🧗", name: "Getting Vexed", desc: "Finish 5 levels.", stat: "levels", goal: 5, rank: "rare" },
    { id: "l10", icon: "🏆", name: "Vex Six Pack", desc: "Finish every level.", stat: "levels", goal: 10, rank: "epic" },
    { id: "d100", icon: "💀", name: "Persistent", desc: "Die 100 times.", stat: "deaths", goal: 100, rank: "common" },
    { id: "d1000", icon: "☠️", name: "Vexation", desc: "Die 1,000 times.", stat: "deaths", goal: 1000, rank: "rare" },
  ],
  "Vex 7": [
    { id: "l1", icon: "🟢", name: "First Act", desc: "Finish your first level.", stat: "levels", goal: 1, rank: "common" },
    { id: "l5", icon: "🧗", name: "Getting Vexed", desc: "Finish 5 levels.", stat: "levels", goal: 5, rank: "rare" },
    { id: "l10", icon: "🏆", name: "Lucky Seven", desc: "Finish every level.", stat: "levels", goal: 10, rank: "epic" },
    { id: "d100", icon: "💀", name: "Persistent", desc: "Die 100 times.", stat: "deaths", goal: 100, rank: "common" },
    { id: "d1000", icon: "☠️", name: "Vexation", desc: "Die 1,000 times.", stat: "deaths", goal: 1000, rank: "rare" },
  ],
  "Vex X3M": [
    { id: "l5", icon: "🏃", name: "Speedy Stickman", desc: "Finish 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "⚡", name: "X3M Runner", desc: "Finish 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "s45", icon: "⭐", name: "Star Chaser", desc: "Earn 45 stars.", stat: "stars", goal: 45, rank: "epic" },
    { id: "a5", icon: "🏅", name: "X3M Achiever", desc: "Unlock 5 of the game’s own achievements.", stat: "ach", goal: 5, rank: "rare" },
    { id: "all", icon: "🏆", name: "X3M Finisher", desc: "Finish all 16 levels.", stat: "levels", goal: 16, rank: "epic" },
  ],
  "Vex X3M 2": [
    { id: "l5", icon: "🏃", name: "Speedy Stickman", desc: "Finish 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "⚡", name: "X3M Runner", desc: "Finish 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "s45", icon: "⭐", name: "Star Chaser", desc: "Earn 45 stars.", stat: "stars", goal: 45, rank: "epic" },
    { id: "a5", icon: "🏅", name: "X3M Achiever", desc: "Unlock 5 of the game’s own achievements.", stat: "ach", goal: 5, rank: "rare" },
    { id: "all", icon: "🏆", name: "X3M Finisher", desc: "Finish all 24 levels.", stat: "levels", goal: 24, rank: "epic" },
  ],
  "Wheelie Bike": [
    { id: "l5", icon: "🚲", name: "Wheelie Rookie", desc: "Set a record on 5 levels.", stat: "levels", goal: 5, rank: "common" },
    { id: "l15", icon: "🔥", name: "Wheelie Pro", desc: "Set a record on 15 levels.", stat: "levels", goal: 15, rank: "rare" },
    { id: "b3", icon: "🏍️", name: "Bike Collector", desc: "Unlock 3 bikes.", stat: "bikes", goal: 3, rank: "rare" },
    { id: "c500", icon: "🪙", name: "Coin Rider", desc: "Have 500 coins.", stat: "coins", goal: 500, rank: "common" },
  ],
  "Zombie Rush": [
    { id: "w3", icon: "🧟", name: "Zone Clear", desc: "Unlock 3 worlds (including hard modes).", stat: "worlds", goal: 3, rank: "common" },
    { id: "w6", icon: "💀", name: "Horde Breaker", desc: "Unlock 6 worlds.", stat: "worlds", goal: 6, rank: "rare" },
    { id: "w8", icon: "👑", name: "Apocalypse Survivor", desc: "Unlock all 8 worlds.", stat: "worlds", goal: 8, rank: "epic" },
    { id: "s5", icon: "🎭", name: "Survivor Squad", desc: "Unlock 5 heroes.", stat: "skins", goal: 5, rank: "rare" },
    { id: "s14", icon: "🦸", name: "Full Roster", desc: "Unlock all 14 heroes.", stat: "skins", goal: 14, rank: "legendary" },
  ],
  "Earn to Die 2": [
    { id: "lv2", icon: "🚚", name: "Next Stop", desc: "Reach the second level.", stat: "level", goal: 2, rank: "common" },
    { id: "lv4", icon: "🏙️", name: "Almost There", desc: "Reach the fourth level.", stat: "level", goal: 4, rank: "rare" },
    { id: "d20", icon: "📅", name: "Survivor", desc: "Survive 20 days.", stat: "day", goal: 20, rank: "common" },
    { id: "z100", icon: "🧟", name: "Road Kill", desc: "Hit 100 zombies in one run.", stat: "zombies", goal: 100, rank: "rare" },
    { id: "z500", icon: "💀", name: "Zombie Plough", desc: "Hit 500 zombies in one run.", stat: "zombies", goal: 500, rank: "epic" },
    { id: "dist", icon: "🏁", name: "Long Haul", desc: "Drive 10,000 m in one run.", stat: "dist", goal: 10000, rank: "epic" },
  ],
  "Plants vs. Zombies": [
    { id: "l5", icon: "🌻", name: "Sunflower Power", desc: "Reach level 1-5.", stat: "level", goal: 5, rank: "common" },
    { id: "l10", icon: "🌙", name: "Night Shift", desc: "Reach the night levels (2-1).", stat: "level", goal: 11, rank: "common" },
    { id: "l21", icon: "🏊", name: "Pool Party", desc: "Reach the pool levels (3-1).", stat: "level", goal: 21, rank: "rare" },
    { id: "l31", icon: "🌫️", name: "Into the Fog", desc: "Reach the fog levels (4-1).", stat: "level", goal: 31, rank: "rare" },
    { id: "l41", icon: "🏠", name: "Roof Defender", desc: "Reach the roof levels (5-1).", stat: "level", goal: 41, rank: "epic" },
    { id: "l50", icon: "👑", name: "Zombie Boss Slayer", desc: "Reach the final level (5-10).", stat: "level", goal: 50, rank: "legendary" },
  ],
  "Riddle Transfer 2": [
    { id: "cp2", icon: "🚌", name: "On the Way", desc: "Reach checkpoint 2.", stat: "cp", goal: 2, rank: "common" },
    { id: "cp4", icon: "🧩", name: "Puzzle Solver", desc: "Reach checkpoint 4.", stat: "cp", goal: 4, rank: "rare" },
    { id: "cp5", icon: "🎓", name: "Transferred Again", desc: "Reach the last checkpoint (5).", stat: "cp", goal: 5, rank: "epic" },
  ],
});
/* GENERATED-ACHIEVEMENTS-END */
for (const [g, defs] of Object.entries(HOOK_ACH)) for (const a of defs) if (!a.rank) a.rank = (HOOK_RANKS[g] || {})[a.id] || 'common';
const achDefs = game => GENERIC_ACH.concat(HOOK_ACH[game] || []);
// Drop the removed visit-based achievements from existing accounts.
(function dropVisitAch() {
  try {
  let n = 0;
  for (const games of Object.values(db.hookAch)) for (const got of Object.values(games)) for (const id of ['days3', 'days7', 'launch25']) if (got[id]) { delete got[id]; n++; }
  for (const games of Object.values(db.gstats)) for (const st of Object.values(games)) { delete st._launches; delete st._days; delete st._lastDay; }
  if (n) { console.log(`Removed ${n} visit achievement(s).`); saveDbSoon(); }
  } catch (e) { console.error("Startup cleanup skipped:", e.message); }
})();
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
  const list = ACHIEVEMENTS.map(a => {
    const o = { id: a.id, icon: a.icon, name: a.name, desc: a.desc, rank: a.rank, unlocked: got[a.id] || null, rarity: pct(rarity().general[a.id], rarity().players),
      goal: a.goal, fmt: a.fmt || null };
    if (withProgress && !o.unlocked) o.progress = Math.min(a.goal, a.stat(st, uid));
    return o;
  });
  const sup = db.support[uid];
  list.push({ id: 'supporter', icon: SUPPORTER_ACH.icon, name: SUPPORTER_ACH.name, desc: SUPPORTER_ACH.desc, rank: 'supporter', xp: SUPPORTER_XP,
    unlocked: isSupporter(uid) ? (sup.since || Date.now()) : null, goal: 1, fmt: null, rarity: pct(supporterCount(), rarity().players) });
  return list;
}
/* XP and levels. Each achievement gives XP by rarity. There are 50 levels; they are rescaled automatically so that
 * level 50 means every achievement for every game in versions.json is unlocked. */
const RANK_XP = { common: 100, rare: 250, epic: 500, legendary: 1000 };
const SUPPORTER_XP = 2500;
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
  let xp = isSupporter(uid) ? SUPPORTER_XP : 0;
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
let lbCache = null;
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
  if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/assets/')) {
    if (await serveAsset(req, res, decodeURIComponent(p.slice(8)))) return;
    return fail(res, 404, 'No such asset on this server.');
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/') && await serveStatic(req, res, p)) return;
  if (req.method === 'GET' && p === '/support/done') {
    const cancelled = /cancelled=1/.test(req.url || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mist</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#1b2838;color:#dcdedf;font:16px system-ui,sans-serif;text-align:center;padding:0 20px"><div><div style="font-size:48px">' +
      (cancelled ? '👋' : '💛') + '</div><h2>' + (cancelled ? 'No problem' : 'Thank you for supporting Mist!') + '</h2><p>' +
      (cancelled ? 'Nothing was charged. You can close this tab.' : 'You can close this tab and go back to Mist. Your perks turn on in a few seconds.') + '</p></div>');
  }
  if (p === '/' || p === '/api/health') return send(res, storageError ? 503 : 200, { ok: !storageError, service: 'eaglercraft-saves', version: 10, social: true, signups: ALLOW_SIGNUPS, accounts: Object.keys(db.users).length, storage: storageError ? 'error: ' + storageError : 'ok' });

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
    return send(res, 200, { me: { name: user.name }, friends, incoming: names(me.incoming), outgoing: names(me.outgoing), newAchievements: takeNewAch(user.id), level: levelInfo(user.id),
      looks: looksFor([user.id].concat(me.friends, me.incoming, me.outgoing)) });
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
    return send(res, 200, { total, matches: all.length, page, pages: Math.max(1, Math.ceil(all.length / per)), users,
      looks: looksFor(all.slice(page * per, page * per + per).map(u => u.id)) });
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

  if (req.method === 'GET' && p === '/api/leaderboard') {
    // Everyone ranked by XP (level), or by achievements / playtime. Cached briefly; XP is summed per player.
    const by = ['achievements', 'playtime'].includes(url.searchParams.get('by')) ? url.searchParams.get('by') : 'xp';
    if (!lbCache || Date.now() - lbCache.at > 30e3) {
      lbCache = { at: Date.now(), rows: Object.values(db.users).map(u => {
        const li = levelInfo(u.id);
        return { id: u.id, name: u.name, xp: li.xp, level: li.level, into: li.into, need: li.need, achievements: achCount(u.id), playtime: Math.round(stats(u.id).play) };
      }) };
    }
    const key = by === 'xp' ? 'xp' : by;
    const rows = lbCache.rows.slice().sort((a, b) => b[key] - a[key] || b.xp - a.xp || a.name.localeCompare(b.name));
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r[key] !== prev) { rank = i + 1; prev = r[key]; } r.rank = rank; });
    const friends = soc(user.id).friends;
    const view = r => ({ rank: r.rank, name: r.name, level: r.level, xp: r.xp, into: r.into, need: r.need, achievements: r.achievements, playtime: r.playtime,
      isMe: r.id === user.id, isFriend: friends.includes(r.id) });
    const me = rows.find(r => r.id === user.id);
    return send(res, 200, { by, total: rows.length, maxLevel: MAX_LEVEL, players: rows.slice(0, 100).map(view), me: me ? view(me) : null,
      looks: looksFor(rows.slice(0, 100).map(r => r.id).concat(user.id)) });
  }

  if (req.method === 'GET' && p === '/api/support') return send(res, 200, supportView(user.id));
  if (req.method === 'POST' && p === '/api/support/subscribe') {
    if (!paypalConfig()) return fail(res, 503, 'Supporter subscriptions aren’t set up on this server yet.');
    if ((db.support[user.id] || {}).status === 'ACTIVE') return fail(res, 400, 'You’re already a supporter. Thank you!');
    try {
      const plan = await supportPlan();
      const host = req.headers['x-forwarded-host'] || req.headers.host, proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const back = proto + '://' + host + '/support/done';
      const sub = await paypal('POST', '/v1/billing/subscriptions', { plan_id: plan, custom_id: user.id,
        application_context: { brand_name: 'Mist', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: back, cancel_url: back + '?cancelled=1' } });
      const link = (sub.links || []).find(l => l.rel === 'approve');
      if (!link) throw new Error('PayPal didn’t return a checkout link.');
      const cur = db.support[user.id] || (db.support[user.id] = {});
      cur.sub = sub.id; cur.status = sub.status || 'APPROVAL_PENDING'; cur.created = Date.now(); saveDbSoon();
      return send(res, 200, { url: link.href });
    } catch (e) { return fail(res, 502, e.message); }
  }
  if (req.method === 'POST' && p === '/api/support/check') {
    try { if (paypalConfig()) await refreshSupport(user.id); } catch (e) { return fail(res, 502, e.message); }
    return send(res, 200, Object.assign(supportView(user.id), { newAchievements: takeNewAch(user.id), level: levelInfo(user.id) }));
  }
  if (req.method === 'GET' && p === '/api/look-options') return send(res, 200, { colors: COLORS });
  if (req.method === 'POST' && p === '/api/profile/edit') {
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const cur = db.looks[user.id] || (db.looks[user.id] = {});
    if ('avatar' in body) {
      if (body.avatar && AVATARS_PLUS.includes(body.avatar) && !isSupporter(user.id)) return fail(res, 403, 'That avatar is for Mist supporters.');
      if (body.avatar && !AVATARS.includes(body.avatar) && !AVATARS_PLUS.includes(body.avatar)) return fail(res, 400, 'Pick one of the listed avatars.');
      cur.avatar = body.avatar || '';
    }
    if ('color' in body) {
      if (body.color && !COLORS.includes(body.color)) return fail(res, 400, 'Pick one of the listed colours.');
      cur.color = body.color || '';
    }
    if ('bio' in body) cur.bio = cleanBio(body.bio);
    saveDbSoon();
    return send(res, 200, { ok: true, look: lookOf(user.id), bio: cur.bio || '' });
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
    out.bio = (db.looks[other.id] && db.looks[other.id].bio) || '';
    out.supporter = isSupporter(other.id);
    out.looks = looksFor([other.id].concat(soc(other.id).friends));
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

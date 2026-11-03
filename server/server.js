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

fs.mkdirSync(SAVES_DIR, { recursive: true });

/* ---------------- tiny JSON database ---------------- */
let db = { users: {}, sessions: {}, saves: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('Could not read ' + DB_FILE, e); process.exit(1); }
}
let writeChain = Promise.resolve();
function saveDb() {
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db));
    await fsp.rename(tmp, DB_FILE);
  }).catch(e => console.error('db write failed', e));
  return writeChain;
}

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
  if (p === '/' || p === '/api/health') return send(res, 200, { ok: true, service: 'eaglercraft-saves', social: true, signups: ALLOW_SIGNUPS });

  if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
    if (rateLimited(clientIp(req))) return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const name = String(body.username || '').trim(), pw = String(body.password || '');
    const key = name.toLowerCase();

    if (p === '/api/register') {
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
    return send(res, 200, { me: { name: user.name }, friends, incoming: names(me.incoming), outgoing: names(me.outgoing) });
  }

  if (req.method === 'POST' && p === '/api/presence') {
    let body; try { body = await readJson(req); } catch (e) { return fail(res, 400, 'Bad request.'); }
    const state = body.state === 'ingame' ? 'ingame' : body.state === 'offline' ? 'offline' : 'online';
    const game = state === 'ingame' ? String(body.game || '').slice(0, 60) : null;
    const me = soc(user.id), now = Date.now();
    if (state === 'offline') presence.delete(user.id); else presence.set(user.id, { state, game, at: now });
    let dirty = false;
    if (game && (!me.recent[0] || me.recent[0].game !== game)) {
      me.recent = [{ game, at: now }].concat(me.recent.filter(r => r.game !== game)).slice(0, 8); dirty = true;
    }
    if (now - (me.lastSeen || 0) > 5 * 60e3 || state === 'offline') { me.lastSeen = now; dirty = true; }
    if (dirty) saveDb();
    return send(res, 200, { ok: true });
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
        me.friends.push(other.id); them.friends.push(user.id); await saveDb();
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
        relation: isMe ? 'me' : isFriend ? 'friend' : me.outgoing.includes(u.id) ? 'requested' : me.incoming.includes(u.id) ? 'requestedYou' : 'none' };
      if (isMe || isFriend) { const pr = presenceOf(u.id); out.state = pr.state; out.game = pr.game; out.lastSeen = pr.lastSeen; }
      return out;
    });
    return send(res, 200, { total, matches: all.length, page, pages: Math.max(1, Math.ceil(all.length / per)), users });
  }

  if (req.method === 'GET' && p === '/api/profile') {
    const other = userByName(url.searchParams.get('name')) || user;
    const isMe = other.id === user.id, isFriend = soc(user.id).friends.includes(other.id);
    const out = { name: other.name, created: other.created, friendCount: soc(other.id).friends.length, isMe, isFriend,
      requested: soc(user.id).outgoing.includes(other.id), requestedYou: soc(user.id).incoming.includes(other.id) };
    if (isMe || isFriend) Object.assign(out, presenceOf(other.id), { recent: soc(other.id).recent.slice(0, 6) });
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
      await saveDb();
      return send(res, 200, { message: { id: msg.id, from: user.name, mine: true, text, at: msg.at } });
    }
  }

  return fail(res, 404, 'Not found.');
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error.'); else res.destroy();
  });
}).listen(PORT, HOST, () => {
  console.log(`Eaglercraft save server on http://${HOST}:${PORT}  (data: ${DATA_DIR}, signups: ${ALLOW_SIGNUPS})`);
});

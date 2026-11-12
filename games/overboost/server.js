'use strict';
/*
 * Overboost server: static hosting, matchmaking, private lobbies and authoritative match rooms.
 *   PORT (3000)  HOST (0.0.0.0)  BOT_FILL_SECONDS (15)  MATCH_SECONDS (300)  DATA_DIR (./data)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const S = require('./public/shared/sim.js');
const { Bot, NAMES, SKILLS, cleanLook, randomLook } = require('./public/shared/bot.js');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BOT_FILL_SECONDS = process.env.BOT_FILL_SECONDS !== undefined ? +process.env.BOT_FILL_SECONDS : 15;
const MATCH_SECONDS = +process.env.MATCH_SECONDS || 300;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROTOCOL = 1;
const SNAPSHOT_EVERY = 2;            // ticks between snapshots (60 Hz)
const TICK_MS = 1000 / S.TICK_RATE;
const START_MMR = 1000;

// ------------------------------------------------------------------ profiles
const PROFILE_FILE = path.join(DATA_DIR, 'players.json');
let profiles = new Map();
let profilesDirty = false;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(PROFILE_FILE)) profiles = new Map(Object.entries(JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))));
} catch (e) { console.error('could not load profiles:', e.message); }

function saveProfiles() {
  if (!profilesDirty) return;
  profilesDirty = false;
  try {
    const tmp = PROFILE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(profiles)));
    fs.renameSync(tmp, PROFILE_FILE);
  } catch (e) { console.error('could not save profiles:', e.message); }
}
setInterval(saveProfiles, 15000).unref();

function cleanName(n) {
  n = String(n || '').replace(/[^\x20-\x7E -￿]/g, '').replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'Player' + (1000 + Math.floor(Math.random() * 9000));
}
function getProfile(pid, name) {
  let p = profiles.get(pid);
  if (!p) {
    p = { name: cleanName(name), mmr: [START_MMR, START_MMR, START_MMR], games: [0, 0, 0], wins: 0, losses: 0, goals: 0, assists: 0, saves: 0, created: Date.now() };
    profiles.set(pid, p); profilesDirty = true;
  }
  return p;
}
function publicProfile(p) {
  return { name: p.name, mmr: p.mmr, games: p.games, wins: p.wins, losses: p.losses, goals: p.goals, assists: p.assists, saves: p.saves, look: cleanLook(p.look) };
}
function leaderboard(size) {
  const k = size - 1, rows = [];
  for (const p of profiles.values()) if (p.games[k] > 0) rows.push({ name: p.name, mmr: Math.round(p.mmr[k]), games: p.games[k], wins: p.wins, losses: p.losses });
  rows.sort((a, b) => b.mmr - a.mmr);
  return rows.slice(0, 50);
}

// ------------------------------------------------------------------ build stamp
// index.html is sent with every script and stylesheet address prefixed by v/<hash of the game's files>/. A deploy
// changes the hash, so a browser or CDN can never run a fresh page with scripts it cached from the old version
// (which looks like new menus that do nothing). The prefix is stripped again when the file is looked up.
function buildId() {
  const h = crypto.createHash('sha1');
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, name);
      if (fs.statSync(f).isDirectory()) walk(f);
      else { h.update(path.relative(PUBLIC_DIR, f)); h.update(fs.readFileSync(f)); }
    }
  })(PUBLIC_DIR);
  return h.digest('hex').slice(0, 10);
}
let BUILD = 'dev', INDEX_HTML = null;
try {
  BUILD = buildId();
  INDEX_HTML = Buffer.from(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace(/((?:src|href)=")((?:js|css|shared)\/)/g, '$1v/' + BUILD + '/$2'));
} catch (e) { console.error('could not stamp the build:', e.message); }

// ------------------------------------------------------------------ http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const p = url.pathname;
  if (p.endsWith('/api/leaderboard')) {
    const size = clampInt(url.searchParams.get('size'), 1, 3, 2);
    return json(res, { size, rows: leaderboard(size) });
  }
  if (p.endsWith('/api/status')) {
    return json(res, { online: clients.size, queues: [1, 2, 3].map(s => queues[s].length), matches: [...rooms].filter(r => r.state === 'play').length, build: BUILD });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(p); } catch (e) { res.writeHead(400); return res.end(); }
  let stamped = false;
  const vm = /^\/v\/([0-9a-z]{3,40})(\/.*)$/.exec(rel);
  if (vm) { stamped = vm[1] === BUILD; rel = vm[2]; }
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/index.html' && INDEX_HTML) {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': INDEX_HTML.length, 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
      // a stamped address always means the same bytes, so it can be kept for good; anything else is checked every time
      'Cache-Control': stamped ? 'public, max-age=31536000, immutable' : (rel.includes('/vendor/') ? 'public, max-age=604800' : 'no-cache')
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function clampInt(v, lo, hi, def) { v = parseInt(v, 10); return v >= lo && v <= hi ? v : def; }

// ------------------------------------------------------------------ sockets
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (!p.endsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

const clients = new Set();
const rooms = new Set();
const lobbies = new Map();          // code -> room
const rejoin = new Map();           // pid -> { room, slot }
const queues = { 1: [], 2: [], 3: [] };

function send(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws) => {
  const c = { ws, pid: null, profile: null, state: 'new', size: 0, queuedAt: 0, room: null, slot: -1,
    inputQ: [], ack: 0, lastSeq: 0, rtt: 0, alive: true, msgs: 0, bins: 0, lastChat: 0 };
  clients.add(c);
  ws.binaryType = 'nodebuffer';
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) { if (++c.bins <= 400) onInput(c, data); }
      else if (++c.msgs <= 40) onMessage(c, JSON.parse(data.toString()));
    } catch (e) { /* malformed packet: ignore */ }
  });
  ws.on('close', () => { clients.delete(c); dropClient(c, true); });
  ws.on('error', () => {});
});
setInterval(() => {
  for (const c of clients) {
    c.msgs = 0; c.bins = 0;
  }
}, 1000).unref();
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) {}
  }
}, 15000).unref();

function onInput(c, buf) {
  const room = c.room;
  if (!room || room.state !== 'play' || c.slot < 0 || buf.length < 6 || buf[0] !== 1) return;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let seq = dv.getUint32(1, true);
  const n = Math.min(buf[5], Math.floor((buf.length - 6) / S.INPUT_BYTES));
  for (let i = 0; i < n; i++, seq++) {
    if (seq <= c.lastSeq) continue;
    if (c.inputQ.length >= 40) c.inputQ.shift();
    const inp = S.decodeInput(S.makeInput(), dv, 6 + i * S.INPUT_BYTES);
    inp.seq = seq; c.lastSeq = seq;
    c.inputQ.push(inp);
  }
}

function onMessage(c, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') { if (typeof m.rtt === 'number') c.rtt = Math.max(0, Math.min(999, m.rtt | 0)); return send(c, { t: 'pong', c: m.c }); }
  if (m.t === 'hello') {
    if (c.pid) return;
    if (m.v !== PROTOCOL) return send(c, { t: 'err', msg: 'This page is out of date. Refresh to update.', fatal: true });
    const pid = String(m.pid || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(pid)) return send(c, { t: 'err', msg: 'Bad player id', fatal: true });
    for (const o of clients) if (o !== c && o.pid === pid) {
      send(o, { t: 'err', msg: 'Signed in from another tab.', fatal: true });
      dropClient(o, true); o.pid = null; o.state = 'new'; o.ws.close();
    }
    c.pid = pid; c.profile = getProfile(pid, m.name); c.state = 'menu';
    if (m.name && cleanName(m.name) !== c.profile.name) { c.profile.name = cleanName(m.name); profilesDirty = true; }
    if (Array.isArray(m.look)) { c.profile.look = cleanLook(m.look); profilesDirty = true; }
    send(c, { t: 'welcome', you: publicProfile(c.profile), online: clients.size, botFill: BOT_FILL_SECONDS, build: BUILD });
    const rj = rejoin.get(pid);
    if (rj && rj.room.state === 'play' && rooms.has(rj.room)) rj.room.reattach(c, rj.slot);
    return;
  }
  if (!c.pid) return;
  switch (m.t) {
    case 'name':
      c.profile.name = cleanName(m.name); profilesDirty = true;
      send(c, { t: 'profile', you: publicProfile(c.profile) });
      if (c.room && c.room.state === 'lobby') c.room.sendLobby();
      break;
    case 'look':       // car body and trim colour, shown to everyone in your matches
      if (Array.isArray(m.look)) { c.profile.look = cleanLook(m.look); profilesDirty = true; }
      break;
    case 'queue': {
      if (c.state !== 'menu') return;
      const size = clampInt(m.size, 1, 3, 2);
      c.state = 'queue'; c.size = size; c.queuedAt = Date.now();
      queues[size].push(c);
      send(c, { t: 'queue', size, waiting: queues[size].length, elapsed: 0, fillIn: BOT_FILL_SECONDS });
      break;
    }
    case 'cancel':
      if (c.state === 'queue') { leaveQueue(c); c.state = 'menu'; send(c, { t: 'menu' }); }
      break;
    case 'create': {
      if (c.state !== 'menu') return;
      const room = new Room({ size: clampInt(m.size, 1, 4, 2), isPrivate: true, bots: validBots(m.bots) ? m.bots : 'pro', minutes: clampInt(m.minutes, 1, 15, 5) });
      room.addLobbyPlayer(c);
      break;
    }
    case 'join': {
      if (c.state !== 'menu') return;
      const room = lobbies.get(String(m.code || '').toUpperCase().trim());
      if (!room) return send(c, { t: 'err', msg: 'No lobby with that code.' });
      if (room.members.length >= 12) return send(c, { t: 'err', msg: 'That lobby is full.' });
      room.addLobbyPlayer(c);
      break;
    }
    case 'team': if (c.room && c.room.isPrivate) c.room.setTeam(c, m.team === 1 ? 1 : 0); break;
    case 'config': if (c.room && c.room.isPrivate && c.room.host === c && c.room.state === 'lobby') c.room.configure(m); break;
    case 'start': if (c.room && c.room.isPrivate && c.room.host === c && c.room.state === 'lobby') c.room.startPrivate(); break;
    case 'leave': dropClient(c, false); c.state = 'menu'; send(c, { t: 'menu' }); break;
    case 'chat': {
      const now = Date.now();
      if (!c.room || c.room.state !== 'play' || c.slot < 0 || now - c.lastChat < 700) return;
      c.lastChat = now;
      c.room.broadcast({ t: 'chat', slot: c.slot, id: clampInt(m.id, 0, 15, 0) });
      break;
    }
  }
}

function validBots(b) { return b === 'none' || (typeof b === 'string' && Object.prototype.hasOwnProperty.call(SKILLS, b)); }
function leaveQueue(c) {
  const q = queues[c.size];
  if (q) { const i = q.indexOf(c); if (i >= 0) q.splice(i, 1); }
}
function dropClient(c, disconnected) {
  if (c.state === 'queue') leaveQueue(c);
  if (c.room) c.room.removeClient(c, disconnected);
  c.room = null; c.slot = -1; c.inputQ.length = 0;
}

// ------------------------------------------------------------------ rooms
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) { let s = ''; for (let i = 0; i < 5; i++) s += A[crypto.randomInt(A.length)]; if (!lobbies.has(s)) return s; }
}

class Room {
  constructor(o) {
    this.size = o.size; this.isPrivate = !!o.isPrivate; this.ranked = false;
    this.bots = o.bots || 'pro'; this.minutes = o.minutes || Math.round(MATCH_SECONDS / 60);
    this.seconds = o.isPrivate ? this.minutes * 60 : MATCH_SECONDS;
    this.state = 'lobby'; this.slots = []; this.members = [];   // members: private lobby only [{c, team}]
    this.host = null; this.code = null; this.world = null; this.tracker = null;
    this.events = []; this.out = []; this.endTimer = null;
    if (this.isPrivate) { this.code = makeCode(); lobbies.set(this.code, this); }
    rooms.add(this);
  }
  humans() { let n = 0; for (const s of this.slots) if (s.client) n++; return n; }
  broadcast(obj) {
    const str = JSON.stringify(obj);
    if (this.isPrivate) { for (const m of this.members) if (m.c.ws.readyState === 1) m.c.ws.send(str); }
    else for (const s of this.slots) if (s.client && s.client.ws.readyState === 1) s.client.ws.send(str);
  }
  destroy() {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.code) lobbies.delete(this.code);
    for (const s of this.slots) if (s.pid && rejoin.get(s.pid) && rejoin.get(s.pid).room === this) rejoin.delete(s.pid);
    rooms.delete(this); this.state = 'dead';
  }

  abort() {
    const list = this.isPrivate ? this.members.map(m => m.c) : this.slots.map(s => s.client).filter(Boolean);
    for (const c of list) { c.room = null; c.slot = -1; c.state = 'menu'; send(c, { t: 'err', msg: 'The match hit an error and was closed.' }); send(c, { t: 'menu' }); }
    this.members = [];
    this.destroy();
  }

  // ---- private lobby
  addLobbyPlayer(c) {
    const n0 = this.members.filter(m => m.team === 0).length, n1 = this.members.length - n0;
    this.members.push({ c, team: n0 <= n1 ? 0 : 1 });
    if (!this.host) this.host = c;
    c.room = this; c.state = 'room'; c.slot = -1;
    this.sendLobby();
  }
  setTeam(c, team) {
    const m = this.members.find(x => x.c === c);
    if (!m || this.state !== 'lobby') return;
    m.team = team; this.sendLobby();
  }
  configure(m) {
    if (m.size) this.size = clampInt(m.size, 1, 4, this.size);      // 4v4 is private matches only
    if (validBots(m.bots)) this.bots = m.bots;
    if (m.minutes) { this.minutes = clampInt(m.minutes, 1, 15, this.minutes); this.seconds = this.minutes * 60; }
    this.sendLobby();
  }
  sendLobby() {
    for (const m of this.members) {
      send(m.c, { t: 'lobby', code: this.code, size: this.size, bots: this.bots, minutes: this.minutes, playing: this.state === 'play',
        host: this.host === m.c, players: this.members.map(x => ({ name: x.c.profile.name, team: x.team, host: x.c === this.host, you: x.c === m.c })) });
    }
  }
  startPrivate() {
    const teams = [[], []];
    for (const m of this.members) if (teams[m.team].length < this.size) teams[m.team].push(m.c);
    this.buildSlots(teams, this.bots === 'none' ? null : this.bots);
    if (!this.slots.some(s => s.client)) { this.slots = []; return; }
    this.begin();
  }

  // ---- match setup
  buildSlots(teams, botSkill) {
    this.slots = [];
    const used = new Set();
    for (let i = 0; i < this.size; i++) for (let team = 0; team < 2; team++) {
      const c = teams[team][i];
      if (c) this.slots.push({ team, client: c, pid: c.pid, name: c.profile.name, bot: null, isBot: false, mmr: c.profile.mmr[this.size - 1] || START_MMR, left: false, look: cleanLook(c.profile.look) });
      else if (botSkill) {
        let name; do { name = NAMES[crypto.randomInt(NAMES.length)]; } while (used.has(name));
        used.add(name);
        this.slots.push({ team, client: null, pid: null, name, bot: new Bot(botSkill, crypto.randomInt(1 << 20) + 1), isBot: true, mmr: 0, left: false, look: randomLook() });
      }
    }
  }
  begin() {
    const w = this.world = S.createWorld({ mode: 'match', matchSeconds: this.seconds, seed: crypto.randomInt(256) });
    for (const s of this.slots) S.addCar(w, s.team);
    S.startMatch(w);
    this.tracker = new S.MatchTracker(w);
    this.state = 'play';
    this.slots.forEach((s, i) => {
      if (!s.client) return;
      const c = s.client;
      c.room = this; c.slot = i; c.state = 'room'; c.inputQ.length = 0; c.lastSeq = 0; c.ack = 0;
      if (!this.isPrivate) rejoin.set(c.pid, { room: this, slot: i });
      send(c, this.startMsg(i, false));
    });
    if (this.isPrivate) this.sendLobby();
  }
  startMsg(i, rejoined) {
    return { t: 'start', you: i, size: this.size, ranked: this.ranked, seconds: this.seconds, rejoin: rejoined, code: this.code,
      players: this.slots.map(s => ({ name: s.name, team: s.team, bot: s.isBot || !s.client, mmr: s.isBot ? 0 : Math.round(s.mmr), look: s.look })) };
  }
  reattach(c, i) {
    const s = this.slots[i];
    if (!s || s.client || s.pid !== c.pid) return;
    s.client = c; s.bot = null; s.left = false;
    c.room = this; c.slot = i; c.state = 'room'; c.inputQ.length = 0; c.lastSeq = 0; c.ack = 0;
    send(c, this.startMsg(i, true));
    this.broadcast({ t: 'joined', slot: i });
  }
  removeClient(c, disconnected) {
    if (this.state === 'play' && c.slot >= 0 && this.slots[c.slot] && this.slots[c.slot].client === c) {
      const s = this.slots[c.slot];
      s.client = null; s.bot = new Bot('pro', crypto.randomInt(1 << 20) + 1);
      if (disconnected && !this.isPrivate) rejoin.set(c.pid, { room: this, slot: c.slot });
      else {
        rejoin.delete(c.pid);
        if (this.ranked && !s.left) {      // abandoning a ranked match counts as a loss
          s.left = true;
          const p = c.profile, k = this.size - 1;
          p.mmr[k] = Math.max(0, p.mmr[k] - 15); p.losses++; p.games[k]++; profilesDirty = true;
        }
      }
      this.broadcast({ t: 'left', slot: c.slot });
    }
    if (this.isPrivate) {
      const i = this.members.findIndex(m => m.c === c);
      if (i >= 0) this.members.splice(i, 1);
      if (this.host === c) this.host = this.members.length ? this.members[0].c : null;
      if (!this.members.length) return this.destroy();
      this.sendLobby();
    } else if (this.state === 'play' && this.humans() === 0) {
      // nobody left watching: keep it alive briefly for reconnects, then drop it
      if (!this.endTimer) this.endTimer = setTimeout(() => { if (this.humans() === 0) this.destroy(); else this.endTimer = null; }, 20000);
    }
  }

  // ---- simulation
  tick() {
    const w = this.world, slots = this.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i], c = s.client;
      if (c) {
        const q = c.inputQ;
        if (q.length > 12) while (q.length > 3) c.ack = q.shift().seq;      // after a stall, skip ahead instead of lagging
        if (q.length) { const inp = q.shift(); S.copyInput(w.cars[i]['in'], inp); c.ack = inp.seq; }
      } else if (s.bot) s.bot.update(w, i);
      else { const inp = w.cars[i]['in']; inp.throttle = inp.steer = inp.pitch = inp.yaw = inp.roll = 0; inp.jump = inp.boost = inp.handbrake = false; }
    }
    const ev = this.events, out = this.out;
    ev.length = 0; out.length = 0;
    S.step(w, ev);
    this.tracker.update(ev, out);
    for (let i = 0; i < out.length; i++) {
      const e = out[i];
      if (e.t === 'goal' || e.t === 'save' || e.t === 'demo' || e.t === 'kickoff' || e.t === 'overtime' || e.t === 'go') this.broadcast(e);
    }
    if (w.tick % SNAPSHOT_EVERY === 0) this.snapshot();
    if (w.tick % S.TICK_RATE === 0) this.broadcast({ t: 'stats', rows: this.statRows() });
    if (w.phase === S.PH_END) this.finish();
  }
  statRows() {
    return this.tracker.stats.map((st, i) => [st.goals, st.assists, st.saves, st.shots, st.score, st.demos, this.slots[i].client ? this.slots[i].client.rtt : -1]);
  }
  snapshot() {
    const w = this.world, size = S.snapshotSize(w);
    let body = null;
    for (const s of this.slots) {
      const c = s.client;
      if (!c || c.ws.readyState !== 1 || c.ws.bufferedAmount > 65536) continue;
      if (!body) { body = Buffer.allocUnsafe(6 + size); S.encodeWorld(w, new DataView(body.buffer, body.byteOffset, body.byteLength), 6); }
      const buf = Buffer.from(body);
      buf[0] = 1; buf.writeUInt32LE(c.ack >>> 0, 1); buf[5] = Math.min(255, c.inputQ.length);
      c.ws.send(buf, { binary: true });
    }
  }
  finish() {
    const w = this.world, k = this.size - 1;
    const winner = w.score[0] > w.score[1] ? 0 : 1;
    const stats = this.statRows();
    let mvp = -1, best = -1;
    stats.forEach((r, i) => { if (this.slots[i].team === winner && r[4] > best) { best = r[4]; mvp = i; } });
    // rating change
    const avg = [0, 0], cnt = [0, 0];
    for (const s of this.slots) if (!s.isBot) { avg[s.team] += s.mmr; cnt[s.team]++; }
    const all = (avg[0] + avg[1]) / Math.max(1, cnt[0] + cnt[1]);
    for (let t = 0; t < 2; t++) avg[t] = cnt[t] ? avg[t] / cnt[t] : all;
    const hasBots = this.slots.some(s => s.isBot);
    const K = hasBots ? 16 : 28;
    this.slots.forEach((s, i) => {
      const c = s.client;
      let delta = 0, mmr = 0;
      if (!s.isBot && s.pid && !s.left) {
        const p = profiles.get(s.pid);
        if (p) {
          const st = this.tracker.stats[i];
          p.goals += st.goals; p.assists += st.assists; p.saves += st.saves;
          if (!this.isPrivate) {
            if (s.team === winner) p.wins++; else p.losses++;
            if (this.ranked) {
              const exp = 1 / (1 + Math.pow(10, (avg[1 - s.team] - avg[s.team]) / 400));
              delta = Math.round(K * ((s.team === winner ? 1 : 0) - exp));
              if (s.team === winner && delta < 1) delta = 1;
              p.mmr[k] = Math.max(0, p.mmr[k] + delta); p.games[k]++;
            }
          }
          mmr = Math.round(p.mmr[k] || START_MMR); profilesDirty = true;
        }
      }
      if (c) send(c, { t: 'end', score: w.score, winner, overtime: w.overtime, stats, mvp, ranked: this.ranked, delta, mmr, you: publicProfile(c.profile), lobby: this.isPrivate });
    });
    for (const s of this.slots) if (s.pid) rejoin.delete(s.pid);
    if (this.isPrivate) {
      this.state = 'lobby';
      for (const s of this.slots) if (s.client) s.client.slot = -1;
      this.slots = []; this.world = null;
      this.sendLobby();
    } else {
      for (const s of this.slots) if (s.client) { s.client.room = null; s.client.slot = -1; s.client.state = 'menu'; }
      this.destroy();
    }
  }
}

// ------------------------------------------------------------------ matchmaking
function botSkillFor(mmr) { return mmr < 950 ? 'rookie' : (mmr < 1250 ? 'pro' : 'elite'); }

function formMatch(size, players) {
  // balance teams by rating: strongest first, each to the team with the lower total that still has room
  const sorted = players.slice().sort((a, b) => b.profile.mmr[size - 1] - a.profile.mmr[size - 1]);
  const teams = [[], []], sum = [0, 0];
  for (const c of sorted) {
    let t = sum[0] <= sum[1] ? 0 : 1;
    if (teams[t].length >= size) t = 1 - t;
    teams[t].push(c); sum[t] += c.profile.mmr[size - 1];
  }
  const room = new Room({ size });
  const avg = (sum[0] + sum[1]) / players.length;
  room.buildSlots(teams, botSkillFor(avg));
  room.ranked = teams[0].length > 0 && teams[1].length > 0;
  for (const c of players) { leaveQueue(c); }
  room.begin();
}

function matchmake() {
  const now = Date.now();
  for (const size of [1, 2, 3]) {
    const q = queues[size], need = size * 2, k = size - 1;
    for (let guard = 0; guard < 20 && q.length; guard++) {
      const anchor = q[0], waited = (now - anchor.queuedAt) / 1000;
      const window = 150 + 40 * waited;
      const near = q.slice(1).filter(c => Math.abs(c.profile.mmr[k] - anchor.profile.mmr[k]) <= window)
        .sort((a, b) => Math.abs(a.profile.mmr[k] - anchor.profile.mmr[k]) - Math.abs(b.profile.mmr[k] - anchor.profile.mmr[k]));
      if (near.length >= need - 1) { formMatch(size, [anchor].concat(near.slice(0, need - 1))); continue; }
      if (waited >= BOT_FILL_SECONDS) { formMatch(size, [anchor].concat(near.slice(0, need - 1))); continue; }
      break;
    }
    for (const c of q) {
      const el = (now - c.queuedAt) / 1000;
      send(c, { t: 'queue', size, waiting: q.length, elapsed: Math.floor(el), fillIn: Math.max(0, Math.ceil(BOT_FILL_SECONDS - (now - q[0].queuedAt) / 1000)) });
    }
  }
}
setInterval(matchmake, 1000);

// ------------------------------------------------------------------ main loop
let lastT = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - lastT) / 1e6; lastT = now;
  if (acc > 250) acc = 250;
  let n = 0;
  while (acc >= TICK_MS && n < 8) {
    for (const r of rooms) if (r.state === 'play') { try { r.tick(); } catch (e) { console.error('room error', e); r.abort(); } }
    acc -= TICK_MS; n++;
  }
}, 4);

function shutdown() { saveProfiles(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => console.log(`Overboost listening on http://${HOST}:${PORT}  (build ${BUILD}, bot fill after ${BOT_FILL_SECONDS}s, ${MATCH_SECONDS}s matches)`));

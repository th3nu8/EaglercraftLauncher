/*
 * Mist Browser service.
 *
 * Serves the page that runs inside each browser tab in Mist (public/), the Ultraviolet, bare-mux and
 * Epoxy files it needs, and a Wisp relay at /wisp/ that carries every connection the pages make.
 * Behind nginx it lives at /browse/ on the Mist server (see server/browser-setup.sh).
 *
 * Who can use it: only signed-in Mist players. Mist gets a browser ticket from the Mist server
 * (POST /api/browser/ticket) and the tab page hands it to the relay; the relay checks it with the
 * Mist server (GET /api/browser/verify, protected by a secret shared through a file) before opening
 * anything, and again every couple of minutes so a ban or "browser off" takes effect quickly.
 *
 * Safeguards: only ports 80 and 443, no UDP, no private or loopback addresses (so nobody can reach the
 * server's own services), a family-safe DNS resolver by default (Cloudflare 1.1.1.3 blocks malware and
 * adult sites), a domain blocklist (data/blocklist.txt, reloaded when it changes), a daily data limit
 * per player, and a log of which player opened which site (data/logs/YYYY-MM-DD.log, kept 30 days).
 *
 * Environment:
 *   PORT, HOST            where to listen (default 127.0.0.1:3300)
 *   DATA_DIR              logs, usage and the blocklist (default ./data)
 *   MIST_API              the Mist server (default http://127.0.0.1:3100)
 *   BROWSER_SECRET_FILE   the shared secret (default /opt/eaglercraft-saves/data/browser-secret)
 *   DAILY_MB              data limit per player per day, in MB (default 2048; 0 = no limit)
 *   DNS                   "family" (default) or "system"
 *   LOG_DAYS              how many days of logs to keep (default 30)
 *   ALLOW_LOCAL_TEST      "1" lets the relay reach 127.0.0.1 and any port. Only for the test suite.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');

const PORT = +process.env.PORT || 3300;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MIST_API = (process.env.MIST_API || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const SECRET_FILE = process.env.BROWSER_SECRET_FILE || '/opt/eaglercraft-saves/data/browser-secret';
const DAILY_BYTES = (process.env.DAILY_MB == null ? 2048 : +process.env.DAILY_MB) * 1048576;
const LOG_DAYS = +process.env.LOG_DAYS || 30;
const TEST = process.env.ALLOW_LOCAL_TEST === '1';
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BLOCKLIST = path.join(DATA_DIR, 'blocklist.txt');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ------------------------------------------------------------------ relay rules
logging.set_level(process.env.WISP_DEBUG ? logging.DEBUG : logging.WARN);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  port_whitelist: TEST ? null : [80, 443],
  allow_private_ips: TEST,
  allow_loopback_ips: TEST,
  allow_direct_ip: TEST,            // sites must be reached by name, so the blocklist and DNS filter apply
  stream_limit_total: 120,
  stream_limit_per_host: 24,
  parse_real_ip_from: ['127.0.0.1', '::1', '::ffff:127.0.0.1']
});
if ((process.env.DNS || 'family') === 'family' && !TEST) {
  Object.assign(wisp.options, { dns_method: 'resolve', dns_servers: ['1.1.1.3', '1.0.0.3'], dns_result_order: 'ipv4first' });
}

// blocklist: one domain per line; a domain also blocks everything under it. # starts a comment.
if (!fs.existsSync(BLOCKLIST)) fs.writeFileSync(BLOCKLIST, [
  '# Mist Browser blocklist. One domain per line; blocking example.com also blocks www.example.com.',
  '# Saved changes apply within a minute, no restart needed. Lines starting with # are ignored.',
  ''
].join('\n'));
let blocked = new Set(), blockMtime = 0;
function loadBlocklist() {
  try {
    const st = fs.statSync(BLOCKLIST);
    if (st.mtimeMs === blockMtime) return;
    blockMtime = st.mtimeMs;
    blocked = new Set(fs.readFileSync(BLOCKLIST, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')).filter(Boolean));
  } catch (e) { /* keep the last list */ }
}
loadBlocklist();
setInterval(loadBlocklist, 30e3).unref();
function isBlocked(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  for (let h = host; h; h = h.includes('.') ? h.slice(h.indexOf('.') + 1) : '') if (blocked.has(h)) return true;
  return false;
}

// ------------------------------------------------------------------ usage and logs
const day = () => new Date().toISOString().slice(0, 10);
let usageDay = day(), usage = loadUsage(usageDay), usageDirty = false;
function loadUsage(d) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-' + d + '.json'), 'utf8')); } catch (e) { return {}; } }
function rollDay() {
  const d = day();
  if (d === usageDay) return;
  saveUsage(); usageDay = d; usage = loadUsage(d); seen.clear();
  // tidy: old usage files and logs
  for (const f of fs.readdirSync(DATA_DIR)) { const m = /^usage-(\d{4}-\d\d-\d\d)\.json$/.exec(f); if (m && m[1] < d) fs.unlink(path.join(DATA_DIR, f), () => {}); }
  const cut = new Date(Date.now() - LOG_DAYS * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(LOG_DIR)) if (f.slice(0, 10) < cut) fs.unlink(path.join(LOG_DIR, f), () => {});
}
function saveUsage() { if (!usageDirty) return; usageDirty = false; fs.writeFile(path.join(DATA_DIR, 'usage-' + usageDay + '.json'), JSON.stringify(usage), () => {}); }
setInterval(() => { rollDay(); saveUsage(); }, 30e3).unref();
function addBytes(user, n) {
  const u = usage[user.uid] || (usage[user.uid] = { name: user.name, bytes: 0 });
  u.bytes += n; usageDirty = true;
}
const overLimit = user => DAILY_BYTES > 0 && (usage[user.uid] ? usage[user.uid].bytes : 0) >= DAILY_BYTES;
// one line per player per site per 10 minutes is enough to trace who opened what
const seen = new Map();
function logVisit(user, host, port, note) {
  const key = user.uid + ' ' + host, now = Date.now();
  if (!note && seen.has(key) && now - seen.get(key) < 600e3) return;
  seen.set(key, now);
  if (seen.size > 50000) seen.clear();
  fs.appendFile(path.join(LOG_DIR, day() + '.log'), `${new Date().toISOString()}\t${user.name}\t${host}:${port}${note ? '\t' + note : ''}\n`, () => {});
}

// ------------------------------------------------------------------ tickets
let secret = null;
function getSecret() {
  if (!secret) try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* Mist server not set up yet */ }
  return secret;
}
const ticketCache = new Map();          // ticket -> { user|null, at }
async function checkTicket(ticket) {
  if (!ticket || ticket.length > 200) return null;
  const c = ticketCache.get(ticket);
  if (c && Date.now() - c.at < 60e3) return c.user;
  if (!getSecret()) throw new Error('missing shared secret ' + SECRET_FILE);
  const r = await fetch(MIST_API + '/api/browser/verify?k=' + encodeURIComponent(ticket), { headers: { 'X-Browser-Secret': getSecret() } });
  if (r.status === 403) secret = null;  // the secret changed: read it again next time
  const user = r.ok ? await r.json().then(d => d.ok ? { uid: d.uid, name: d.name } : null) : null;
  ticketCache.set(ticket, { user, at: Date.now() });
  if (ticketCache.size > 5000) for (const [k, v] of ticketCache) if (Date.now() - v.at > 60e3) ticketCache.delete(k);
  return user;
}

// each relay connection gets its own socket class, so every site it opens is checked, counted and logged
const Base = new wisp.ServerConnection({}, '/', {}).TCPSocket;
function socketFor(user) {
  return class MistSocket extends Base {
    async connect(ip) {
      if (isBlocked(this.hostname)) { logVisit(user, this.hostname, this.port, 'blocked'); throw new Error('blocked site'); }
      if (overLimit(user)) throw new Error('daily data limit reached');
      logVisit(user, this.hostname, this.port);
      return super.connect(ip);
    }
    async recv() { const d = await super.recv(); if (d) addBytes(user, d.length); return d; }
    async send(d) { addBytes(user, d.length); return super.send(d); }
  };
}

// ------------------------------------------------------------------ why a site didn't load
// When a page fails, the tab asks here so it can say "blocked", "filtered" or "down" instead of showing
// a raw TLS error (a refused relay connection looks like "SSL connect error" to the page).
const dns = require('dns'), net = require('net');
const familyDns = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
if (wisp.options.dns_servers) familyDns.setServers(wisp.options.dns_servers);
const isPrivateIp = ip => /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) || /^(::1?$|f[cd]|fe80)/i.test(ip);
const WHY = {
  blocked: 'This site is blocked on Mist.',
  limit: 'You’ve used today’s Mist Browser data. It resets at midnight UTC.',
  port: 'The Mist Browser only opens normal web addresses (no custom ports).',
  ip: 'Type the site’s name instead of its IP address.',
  nodns: 'That site doesn’t exist, or its address couldn’t be found.',
  filtered: 'This site is filtered (adult or harmful content).',
  private: 'That address points into a private network, so Mist can’t open it.',
  unreachable: 'The Mist server couldn’t reach that site. It may be down; try again in a bit.'
};
async function resolveHost(host) {
  if (wisp.options.dns_method === 'resolve') {
    try { return (await familyDns.resolve4(host))[0]; } catch (e) { if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') throw e; }
    return (await familyDns.resolve6(host))[0];
  }
  return (await dns.promises.lookup(host)).address;
}
function tcpCheck(ip, port) {
  return new Promise(resolve => {
    const s = net.connect({ host: ip, port, timeout: 6000 });
    const done = ok => { s.destroy(); resolve(ok); };
    s.on('connect', () => done(true)); s.on('timeout', () => done(false)); s.on('error', () => done(false));
  });
}
async function whyFailed(user, host, port) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  if (isBlocked(host)) return 'blocked';
  if (overLimit(user)) return 'limit';
  if (!TEST && port !== 80 && port !== 443) return 'port';
  if (net.isIP(host)) return TEST ? null : 'ip';
  let ip;
  try { ip = await resolveHost(host); } catch (e) { return 'nodns'; }
  if (!ip) return 'nodns';
  if (ip === '0.0.0.0' || ip === '::') return 'filtered';          // what the family DNS answers for filtered sites
  if (isPrivateIp(ip) && !TEST) return 'private';
  return (await tcpCheck(ip, port)) ? null : 'unreachable';      // reachable: the problem is the site or its TLS
}
const whyLimit = new Map();     // uid -> [times], a few checks a minute per player

// ------------------------------------------------------------------ http
const dist = name => path.join(__dirname, 'node_modules', name, 'dist') + path.sep;
const VENDOR = { '/uv/': dist('@titaniumnetwork-dev/ultraviolet'), '/baremux/': dist('@mercuryworkshop/bare-mux'), '/epoxy/': dist('@mercuryworkshop/epoxy-transport'), '/libcurl/': dist('@mercuryworkshop/libcurl-transport') };
// How tabs talk to the relay (public/mist-transport.mjs). "auto": libcurl, which handles header-heavy sites
// like YouTube, falling back to epoxy for sites libcurl's TLS can't connect to. TRANSPORT=libcurl or epoxy forces one.
const TRANSPORT = /^(libcurl|epoxy)$/.test(process.env.TRANSPORT || '') ? process.env.TRANSPORT : 'auto';
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const conns = new Set();
const parseUrl = u => { try { return new URL('http://x' + (String(u || '').charAt(0) === '/' ? u : '/' + u)); } catch (e) { return new URL('http://x/'); } };

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' };
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const u = parseUrl(req.url);
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, service: 'mist-browser', transport: TRANSPORT, connections: conns.size, blocked: blocked.size, dailyMB: DAILY_BYTES / 1048576, secret: !!getSecret() }));
  }
  if (p === '/api/why') {
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    checkTicket(u.searchParams.get('k') || '').then(async user => {
      if (!user) return json(401, { error: 'sign in again' });
      const now = Date.now(), t = (whyLimit.get(user.uid) || []).filter(x => now - x < 60e3);
      if (t.length >= 20) return json(429, { error: 'slow down' });
      t.push(now); whyLimit.set(user.uid, t);
      const port = +u.searchParams.get('port') || 443;
      const reason = await whyFailed(user, u.searchParams.get('host'), port);
      json(200, { reason, text: reason ? WHY[reason] : null });
    }).catch(() => json(503, { error: 'try again' }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (p.startsWith('/service/')) {
    // the service worker answers these; reaching the server means it isn't running in this tab yet
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('<!doctype html><body style="font:15px system-ui;background:#1b2838;color:#c7d5e0;display:grid;place-items:center;height:100vh;margin:0"><p>The browser is still starting. Press reload.</p>');
  }
  for (const pre in VENDOR) if (p.startsWith(pre)) {
    const f = path.normalize(path.join(VENDOR[pre], p.slice(pre.length)));
    if (!f.startsWith(VENDOR[pre])) break;
    return serveFile(req, res, f, 'public, max-age=86400');
  }
  const f = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!f.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  serveFile(req, res, f, 'no-cache');
});

server.on('upgrade', (req, socket, head) => {
  const u = parseUrl(req.url);
  const refuse = (code, text) => { try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (e) { socket.destroy(); } };
  // the ticket comes as /wisp/?k=TICKET, or /wisp/TICKET/ for wisp clients that want the path to end in "/"
  const m = /^\/wisp\/(?:([\w-]{16,64})\/)?$/.exec(u.pathname);
  if (!m) return refuse(404, 'Not Found');
  const ticket = m[1] || u.searchParams.get('k') || '';
  checkTicket(ticket).then(user => {
    if (!user) return refuse(401, 'Unauthorized');
    rollDay();
    if (overLimit(user)) return refuse(429, 'Too Many Requests');
    req.url = '/wisp/';                // wisp-js reads the path; the ticket stays out of it
    const c = { socket, user, ticket };
    conns.add(c); socket.on('close', () => conns.delete(c));
    wisp.routeRequest(req, socket, head, { TCPSocket: socketFor(user) });
  }, e => { console.error('ticket check failed: ' + e.message); refuse(503, 'Service Unavailable'); });
});

// bans, "browser off" and the data limit also end connections that are already open
setInterval(() => {
  for (const c of conns) {
    if (overLimit(c.user)) { c.socket.destroy(); continue; }
    checkTicket(c.ticket).then(u => { if (!u) c.socket.destroy(); }, () => {});
  }
}, 120e3).unref();

process.on('SIGTERM', () => { saveUsage(); process.exit(0); });
server.listen(PORT, HOST, () => console.log(`Mist Browser on http://${HOST}:${PORT}  (Mist API ${MIST_API}, daily limit ${DAILY_BYTES ? DAILY_BYTES / 1048576 + ' MB' : 'none'}, DNS ${wisp.options.dns_method === 'resolve' ? 'family' : 'system'}${TEST ? ', LOCAL TEST MODE' : ''})`));

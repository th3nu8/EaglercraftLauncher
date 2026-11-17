/*
 * Mist Browser test: starts a Mist server, two browser relays (one in local-test mode, one with the
 * real rules) and a small website, then checks tickets, the relay, the blocklist, logs, usage and the
 * admin "browser off" switch. Run with `npm test` in server/browser. Needs Node 22 (built-in WebSocket).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIST = path.join(ROOT, '..', 'server.js');
const ADMINS = path.join(ROOT, '..', 'admins.json');
const P = { mist: 39100, relay: 39101, strict: 39102, site: 39103 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mist-browser-test-'));
const procs = [];
let failures = 0, madeAdmins = false;

function check(ok, what) { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function start(file, env, name) {
  const p = spawn(process.execPath, [file], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  p.on('exit', c => { if (c && !p.stopping) console.log(name + ' exited ' + c + '\n' + out); });
  procs.push(p); return p;
}
function req(port, method, p, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'content-type': 'application/json' }, headers) }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, text: d }); });
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function waitFor(port, p) {
  for (let i = 0; i < 50; i++) { try { await req(port, 'GET', p); return; } catch (e) { await sleep(100); } }
  throw new Error('nothing listening on ' + port);
}
function upgradeStatus(port, p) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    r.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); });
    r.on('response', res => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0)); r.end();
  });
}

// fetch a page over a wisp stream the way the browser would, with plain HTTP
async function wispGet(port, ticket, host, hport, p) {
  const { ClientConnection } = (await import('@mercuryworkshop/wisp-js/client')).client;
  return new Promise(resolve => {
    const conn = new ClientConnection(`ws://127.0.0.1:${port}/wisp/${ticket}/`);
    let done = false; const finish = v => { if (done) return; done = true; try { conn.ws.close(); } catch (e) {} resolve(v); };
    conn.onerror = () => finish({ error: 'connection refused' });
    conn.onclose = () => finish({ error: 'connection closed' });
    conn.onopen = () => {
      const s = conn.create_stream(host, hport);
      let data = Buffer.alloc(0);
      s.onmessage = b => { data = Buffer.concat([data, Buffer.from(b)]); };
      s.onclose = reason => finish(data.length ? { text: data.toString() } : { error: 'stream closed, reason ' + reason });
      s.send(new TextEncoder().encode(`GET ${p} HTTP/1.1\r\nHost: ${host}:${hport}\r\nConnection: close\r\n\r\n`));
    };
    setTimeout(() => finish({ error: 'timeout' }), 5000);
  });
}

async function main() {
  if (!fs.existsSync(ADMINS)) { fs.writeFileSync(ADMINS, '["boss"]'); madeAdmins = true; }
  else if (!JSON.parse(fs.readFileSync(ADMINS, 'utf8')).map(s => s.toLowerCase()).includes('boss')) throw new Error('server/admins.json exists without "boss"; move it aside to run this test');
  const mistData = path.join(tmp, 'mist'), relayData = path.join(tmp, 'relay'), strictData = path.join(tmp, 'strict');
  [mistData, relayData, strictData].forEach(d => fs.mkdirSync(d));
  fs.writeFileSync(path.join(relayData, 'blocklist.txt'), '# test\nlocalhost\n');
  const secretFile = path.join(mistData, 'browser-secret');

  http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/plain' }); s.end('hello from the test site ' + q.url); }).listen(P.site, '127.0.0.1');
  start(MIST, { PORT: P.mist, DATA_DIR: mistData, PUBLIC_DIR: path.join(tmp, 'pub') }, 'mist');
  await waitFor(P.mist, '/api/announcement');
  const relayEnv = { BROWSER_SECRET_FILE: secretFile, MIST_API: 'http://127.0.0.1:' + P.mist };
  start(path.join(ROOT, 'server.js'), Object.assign({ PORT: P.relay, DATA_DIR: relayData, ALLOW_LOCAL_TEST: '1', DAILY_MB: '1' }, relayEnv), 'relay');
  start(path.join(ROOT, 'server.js'), Object.assign({ PORT: P.strict, DATA_DIR: strictData, DNS: 'system' }, relayEnv), 'strict relay');
  await waitFor(P.relay, '/api/status'); await waitFor(P.strict, '/api/status');

  console.log('accounts and tickets');
  const alice = (await req(P.mist, 'POST', '/api/register', { body: { username: 'alice', password: 'password1' } })).json;
  const boss = (await req(P.mist, 'POST', '/api/register', { body: { username: 'boss', password: 'password1' } })).json;
  const auth = t => ({ headers: { authorization: 'Bearer ' + t } });
  check((await req(P.mist, 'POST', '/api/browser/ticket')).status === 401, 'no ticket without signing in');
  let tk = await req(P.mist, 'POST', '/api/browser/ticket', auth(alice.token));
  check(tk.status === 200 && tk.json.ticket && tk.json.path === '/browse/' && tk.json.exp > Date.now(), 'signed-in player gets a ticket');
  const ticket = tk.json.ticket;
  check((await req(P.mist, 'GET', '/api/browser/verify?k=' + ticket)).status === 403, 'verify refuses calls without the secret');
  check((await req(P.mist, 'GET', '/api/browser/verify?k=' + ticket, { headers: { 'x-browser-secret': 'nope' } })).status === 403, 'verify refuses a wrong secret');
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const v = await req(P.mist, 'GET', '/api/browser/verify?k=' + ticket, { headers: { 'x-browser-secret': secret } });
  check(v.status === 200 && v.json.name === 'alice', 'verify names the ticket’s player');

  console.log('relay');
  check(await upgradeStatus(P.relay, '/wisp/') === 401, 'relay refuses a connection with no ticket');
  check(await upgradeStatus(P.relay, '/wisp/?k=madeup') === 401, 'relay refuses a made-up ticket');
  check(await upgradeStatus(P.relay, '/wisp/?k=' + ticket) === 101, 'relay accepts a real ticket');
  let r = await wispGet(P.relay, ticket, '127.0.0.1', P.site, '/page');
  check(/200 OK/.test(r.text || '') && /hello from the test site \/page/.test(r.text), 'pages load through the relay');
  r = await wispGet(P.relay, ticket, 'localhost', P.site, '/');
  check(!!r.error, 'blocklisted site is refused (' + r.error + ')');
  r = await wispGet(P.strict, ticket, '127.0.0.1', P.site, '/');
  check(!!r.error, 'real rules: IP addresses are refused');
  r = await wispGet(P.strict, ticket, 'localhost', 80, '/');
  check(!!r.error, 'real rules: the server’s own machine is refused');
  r = await wispGet(P.strict, ticket, 'localhost', 22, '/');
  check(!!r.error, 'real rules: ports other than 80 and 443 are refused');

  await sleep(300);
  const day = new Date().toISOString().slice(0, 10);
  const log = fs.readFileSync(path.join(relayData, 'logs', day + '.log'), 'utf8');
  check(/\talice\t127\.0\.0\.1:39103\n/.test(log), 'visit is logged with the player’s name');
  check(/\talice\tlocalhost:39103\tblocked/.test(log), 'blocked attempt is logged');
  const st = await req(P.relay, 'GET', '/api/status');
  check(st.json && st.json.ok && st.json.secret && st.json.blocked === 1, 'status page works');

  console.log('admin switches');
  let a = await req(P.mist, 'POST', '/api/admin/user', Object.assign({ body: { name: 'alice', action: 'browser-off' } }, auth(boss.token)));
  check(a.status === 200, 'admin turns the browser off for a player');
  check((await req(P.mist, 'GET', '/api/browser/verify?k=' + ticket, { headers: { 'x-browser-secret': secret } })).status === 401, 'their ticket stops working');
  tk = await req(P.mist, 'POST', '/api/browser/ticket', auth(alice.token));
  check(tk.status === 403, 'they can’t get a new ticket');
  const ov = await req(P.mist, 'GET', '/api/admin/overview', auth(boss.token));
  const au = ov.json && ov.json.users && ov.json.users.find(u => u.name === 'alice');
  check(au && au.noBrowser === true, 'admin list shows "browser off"');
  await req(P.mist, 'POST', '/api/admin/user', Object.assign({ body: { name: 'alice', action: 'browser-on' } }, auth(boss.token)));
  tk = await req(P.mist, 'POST', '/api/browser/ticket', auth(alice.token));
  check(tk.status === 200, 'turning it back on works');
  check((await req(P.mist, 'POST', '/api/admin/user', Object.assign({ body: { name: 'boss', action: 'browser-off' } }, auth(alice.token)))).status === 403, 'players can’t use admin switches');
  await req(P.mist, 'POST', '/api/admin/user', Object.assign({ body: { name: 'alice', action: 'ban' } }, auth(boss.token)));
  check((await req(P.mist, 'GET', '/api/browser/verify?k=' + tk.json.ticket, { headers: { 'x-browser-secret': secret } })).status === 401, 'banning ends browser tickets');
}

main().catch(e => { console.error(e); failures++; }).finally(() => {
  for (const p of procs) { p.stopping = true; p.kill(); }
  if (madeAdmins) fs.rmSync(ADMINS, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
});

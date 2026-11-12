// End-to-end protocol test: boots the server, connects fake clients, plays through matchmaking.
// Run: node test/net-test.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const S = require('../public/shared/sim.js');
const { Bot } = require('../public/shared/bot.js');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, BOT_FILL_SECONDS: 2, MATCH_SECONDS: 6, DATA_DIR: DATA }), stdio: ['ignore', 'pipe', 'inherit'] });
let failures = 0;
const check = (name, ok, extra) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Fake {
  constructor(name) {
    this.name = name; this.pid = 'test_' + name + '_' + Math.random().toString(36).slice(2).padEnd(16, 'x');
    this.msgs = []; this.snaps = 0; this.seq = 0; this.ack = 0; this.world = null; this.you = -1; this.timer = null; this.qDepth = [];
  }
  connect() {
    return new Promise((res, rej) => {
      const ws = this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      ws.binaryType = 'arraybuffer';
      ws.on('open', () => { this.send({ t: 'hello', v: 1, pid: this.pid, name: this.name }); });
      ws.on('error', rej);
      ws.on('message', (data, bin) => {
        if (bin) {
          const dv = new DataView(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          this.ack = dv.getUint32(1, true); this.qDepth.push(dv.getUint8(5)); this.snaps++;
          if (this.world) S.decodeWorld(this.world, dv, 6);
          return;
        }
        const m = JSON.parse(data.toString());
        this.msgs.push(m);
        if (m.t === 'welcome') res(this);
        if (m.t === 'start') {
          this.you = m.you; this.start = m;
          this.world = S.createWorld({ mode: 'match', matchSeconds: m.seconds });
          for (const p of m.players) S.addCar(this.world, p.team);
          this.drive();
        }
        if (m.t === 'end') { clearInterval(this.timer); this.end = m; }
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  drive() {
    clearInterval(this.timer);
    const inp = S.makeInput();
    this.timer = setInterval(() => {     // 2 ticks of input every ~16 ms, like a 60 fps client
      // like the real client, ease off when the server already has plenty of our inputs queued
      const n = (this.qDepth.length && this.qDepth[this.qDepth.length - 1] > 3) ? 1 : 2;
      const buf = new ArrayBuffer(6 + n * S.INPUT_BYTES), dv = new DataView(buf);
      dv.setUint8(0, 1); dv.setUint32(1, this.seq + 1, true); dv.setUint8(5, n);
      if (this.bot) { this.bot.update(this.world, this.you); S.copyInput(inp, this.world.cars[this.you].in); }
      else if (!this.idle) { inp.throttle = 1; inp.boost = true; inp.steer = Math.sin(this.seq / 200) * 0.3; }
      for (let i = 0; i < n; i++) S.encodeInput(inp, dv, 6 + i * S.INPUT_BYTES);
      this.seq += n;
      if (this.ws.readyState === 1) this.ws.send(buf);
    }, 1000 / 60);
  }
  last(t) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === t) return this.msgs[i]; return null; }
  close() { clearInterval(this.timer); this.ws.close(); }
}

(async () => {
  await new Promise(r => srv.stdout.once('data', r));
  const get = async p => (await fetch(`http://127.0.0.1:${PORT}${p}`));
  check('serves index.html', (await get('/')).status === 200);
  check('serves shared sim', (await (await get('/shared/sim.js')).text()).includes('OBSim'));
  check('blocks path traversal', (await get('/..%2f..%2fpackage.json')).status !== 200);

  // --- two humans queue for 1v1 and get matched together (ranked)
  const a = await new Fake('Alice').connect(), b = await new Fake('Bob').connect();
  a.bot = new Bot('elite', 5); b.idle = true;      // Alice plays properly, Bob is AFK, so the match has a winner
  check('welcome carries profile', a.last('welcome').you.mmr[0] === 1000);
  a.send({ t: 'queue', size: 1 }); b.send({ t: 'queue', size: 1 });
  await sleep(1500);
  check('both matched', !!a.start && !!b.start);
  check('match is ranked 1v1 without bots', a.start && a.start.ranked && a.start.players.length === 2 && !a.start.players.some(p => p.bot));
  check('opposite teams', a.start && b.start && a.start.players[a.you].team !== b.start.players[b.you].team);
  await sleep(5000);
  check('snapshots arrive at ~60 Hz', a.snaps > 250 && a.snaps < 480, `${a.snaps} in ~6.5s`);
  check('inputs acknowledged', a.ack > a.seq - 40 && a.ack > 300, `ack ${a.ack} of ${a.seq}`);
  const qd = a.qDepth.slice(-200), avgQ = qd.reduce((x, y) => x + y, 0) / qd.length;
  check('input queue stays short', avgQ < 6, `avg depth ${avgQ.toFixed(2)}`);
  const car = a.world.cars[a.you];
  check('own car moved under own input', Math.hypot(car.px - S.KICKOFF[0][0], car.py) > 200 || a.world.score[0] + a.world.score[1] > 0, `speed ${Math.hypot(car.vx, car.vy).toFixed(0)} phase ${a.world.phase}`);
  check('clock is running', a.world.clock < 6 && a.world.tick > 500, `clock ${a.world.clock.toFixed(1)} tick ${a.world.tick}`);
  // wait for the 6-second match to finish (may go to overtime: force by waiting for 'end' up to 40s)
  for (let i = 0; i < 900 && !(a.end && b.end); i++) await sleep(100);
  if (a.end) {
    check('match ended with a result', a.end.winner === a.start.players[a.you].team, `score ${a.end.score}${a.end.overtime ? ' (overtime)' : ''}`);
    check('rating moved in opposite directions', a.end.delta === -b.end.delta && a.end.delta !== 0, `${a.end.delta} / ${b.end.delta}`);
    check('stats table sent', a.end.stats.length === 2 && a.end.stats[0].length === 7);
  } else check('match ended', false, 'no end message within 40s');

  // --- solo queue gets bots after the fill timer
  const c = await new Fake('Cara').connect();
  c.send({ t: 'queue', size: 2 });
  await sleep(900);
  check('queue status updates', c.last('queue') && c.last('queue').waiting === 1);
  await sleep(2800);
  check('solo player gets a bot-filled 2v2', !!c.start && c.start.players.length === 4 && c.start.players.filter(p => p.bot).length === 3 && !c.start.ranked);
  // --- disconnect and rejoin
  const pid = c.pid; c.close(); await sleep(400);
  const c2 = new Fake('Cara'); c2.pid = pid; await c2.connect(); await sleep(300);
  check('reconnect drops you back into the match', !!c2.start && c2.start.rejoin === true && c2.start.you === c.you);
  c2.send({ t: 'leave' }); await sleep(200);
  check('leaving returns to menu', !!c2.last('menu'));

  // --- private lobby
  const h = await new Fake('Host').connect(), g = await new Fake('Guest').connect();
  h.send({ t: 'create', size: 1, bots: 'none', minutes: 1 }); await sleep(200);
  const code = h.last('lobby') && h.last('lobby').code;
  check('lobby created with a code', /^[A-Z2-9]{5}$/.test(code || ''), code);
  g.send({ t: 'join', code: 'ZZZZZ' }); await sleep(150);
  check('bad code rejected', !!g.last('err'));
  g.send({ t: 'join', code: code.toLowerCase() }); await sleep(200);
  check('guest sees both players', g.last('lobby') && g.last('lobby').players.length === 2 && !g.last('lobby').host);
  g.send({ t: 'start' }); await sleep(200);
  check('only the host can start', !g.start);
  h.send({ t: 'config', size: 2, bots: 'elite' }); await sleep(150);
  check('host can change settings', h.last('lobby').size === 2 && g.last('lobby').bots === 'elite');
  h.send({ t: 'start' }); await sleep(400);
  check('private match starts for both, bots fill 2v2', !!h.start && !!g.start && h.start.players.length === 4 && h.start.players.filter(p => p.bot).length === 2 && !h.start.ranked);
  h.send({ t: 'chat', id: 3 }); await sleep(200);
  check('quick chat relayed', g.last('chat') && g.last('chat').id === 3 && g.last('chat').slot === h.you);
  h.close(); await sleep(300);
  check('host leaving promotes the guest', g.last('lobby') && g.last('lobby').host === true);
  g.close(); a.close(); b.close(); c2.close();
  await sleep(300);

  const lb = await (await get('/api/leaderboard?size=1')).json();
  check('leaderboard lists ranked players', lb.rows.length === 2 && lb.rows[0].mmr >= lb.rows[1].mmr, JSON.stringify(lb.rows.map(r => [r.name, r.mmr])));
  const st = await (await get('/api/status')).json();
  check('status endpoint', st.online === 0 && Array.isArray(st.queues));
  srv.kill('SIGTERM');
  await sleep(400);
  check('profiles persisted on shutdown', fs.existsSync(path.join(DATA, 'players.json')) && Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'players.json'), 'utf8'))).length >= 5);
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : '\nall network checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });

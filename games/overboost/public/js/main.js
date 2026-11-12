// App shell: menus, networking, HUD and the frame loop.
import { Renderer, TEAM_NAME, BODIES, TRIMS } from './render.js';
import { Session } from './session.js';
import { Input, ACTIONS, GAMEPAD_HELP, TOUCH_HELP, keyLabel } from './input.js';
import { Sfx } from './audio.js';

const S = window.OBSim, B = window.OBBot, D = window.OBDrill;
const PROTOCOL = 1;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
};
const TEAM_CLASS = ['tide', 'flare'];
const CHATS = ['Nice shot!', 'Great pass!', 'What a save!', 'Thanks!', 'Sorry!', 'I got it!', 'Defending', 'Good game!'];
const RANKS = [[1600, 'Legend'], [1400, 'Elite'], [1250, 'Diamond'], [1150, 'Platinum'], [1050, 'Gold'], [950, 'Silver'], [850, 'Bronze'], [0, 'Rookie']];
const rankOf = mmr => RANKS.find(r => mmr >= r[0])[1];
const fmtClock = s => { s = Math.max(0, Math.ceil(s - 1e-6)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// ------------------------------------------------------------------ persistent bits
let pid = store.get('ob.pid', null);
if (!pid || !/^[A-Za-z0-9_-]{16,64}$/.test(pid)) {
  const a = new Uint8Array(18); (crypto || window.msCrypto).getRandomValues(a);
  pid = Array.from(a, b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
  store.set('ob.pid', pid);
}
let myName = store.get('ob.name', '') || 'Player' + (1000 + Math.floor(Math.random() * 9000));
store.set('ob.name', myName);
const settings = Object.assign({ volume: 60, sfx: 100, crowd: 70, fps: true, quality: 'high', fov: 100, dist: 280, height: 110, angle: -4, stiff: 50, touch: 'auto', ballCam: true }, store.get('ob.settings', {}));
const saveSettings = () => store.set('ob.settings', settings);
let myLook = B.cleanLook(store.get('ob.look', [0, 0]));                 // [body, trim]
const drillRatings = Object.assign({ shooter: D.START, keeper: D.START }, store.get('ob.drills', {}));

// ------------------------------------------------------------------ core objects
const renderer = new Renderer($('view'));
const input = new Input($('view'));
const sfx = new Sfx();
renderer.setQuality(settings.quality);
sfx.setVolume(settings.volume / 100); sfx.setEffects(settings.sfx / 100); sfx.setCrowdVolume(settings.crowd / 100);
input.setTouchMode(settings.touch);

let demo = null;            // bots playing behind the menu
let game = null;            // the match you are in
let paused = false;
let profile = null;         // from the server
let online = false;
let lobby = null;           // last lobby state from the server
let lastQueueSize = 2, lastBots = null;
let endInfo = null;
let view = 'home', settingsFrom = 'home';

// ------------------------------------------------------------------ network
class Net {
  constructor() { this.ws = null; this.open = false; this.rtt = 0; this.tries = 0; this.fatal = false; this.everOpen = false; }
  url() {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q;
    if (!/^https?:$/.test(location.protocol)) return null;
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '') + 'ws';
  }
  connect() {
    const url = this.url();
    if (!url || this.fatal) return setOffline();
    let ws;
    try { ws = this.ws = new WebSocket(url); } catch (e) { return setOffline(); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.open = true; this.everOpen = true; this.tries = 0; this.send({ t: 'hello', v: PROTOCOL, pid, name: myName, look: myLook }); };
    ws.onmessage = e => {
      if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onServer(m); }
      else if (game && game.mode === 'online') game.onSnapshot(new DataView(e.data));
    };
    ws.onclose = () => {
      const was = this.open; this.open = false;
      if (was) onDisconnect();
      else if (!this.everOpen) setOffline();
      if (this.fatal || (!this.everOpen && this.tries >= 3)) return;      // static hosting with no game server: stop knocking
      setTimeout(() => this.connect(), Math.min(15000, 1500 * Math.pow(1.7, this.tries++)));
    };
    ws.onerror = () => {};
  }
  send(o) { if (this.open) this.ws.send(JSON.stringify(o)); }
  sendBinary(b) { if (this.open) this.ws.send(b); }
}
const net = new Net();
setInterval(() => net.send({ t: 'ping', c: performance.now(), rtt: Math.round(net.rtt) }), 2000);

function setOffline() {
  online = false;
  $('netline').textContent = 'No game server reachable, so online play is off. Bots and free play still work.';
  $('btn-online').disabled = true; $('btn-private').disabled = true;
}
function onDisconnect() {
  setOffline();
  $('netline').textContent = 'Lost the connection. Trying again…';
  if (game && game.mode === 'online' && !game.ended) toast('Connection lost. Rejoining when it comes back…');
  if (view === 'queue' || view === 'lobby' || view === 'online' || view === 'private') show('home');
  lobby = null;
}
const offlineOpts = () => ({ name: myName, look: myLook, onEvent: e => onGameEvent(e, true) });

function onServer(m) {
  switch (m.t) {
    case 'pong': net.rtt = net.rtt ? net.rtt * 0.7 + (performance.now() - m.c) * 0.3 : performance.now() - m.c; break;
    case 'welcome': {
      online = true; profile = m.you; onlineCount = m.online; botFill = m.botFill;
      $('btn-online').disabled = false; $('btn-private').disabled = false;
      refreshProfile();
      const code = new URLSearchParams(location.search).get('join');
      if (code && !joinTried) { joinTried = true; net.send({ t: 'join', code }); }
      break;
    }
    case 'profile': profile = m.you; refreshProfile(); break;
    case 'queue': {
      lastQueueSize = m.size;
      if (view !== 'queue') show('queue');
      $('queue-title').textContent = `Looking for a ${m.size}v${m.size}`;
      $('queue-time').textContent = fmtClock(m.elapsed);
      const others = m.waiting - 1;
      $('queue-info').textContent = (others > 0 ? `${others} other ${others === 1 ? 'player is' : 'players are'} searching. ` : 'Nobody else is searching yet. ') +
        (m.fillIn > 0 ? `Bots take the empty seats in ${m.fillIn} s.` : 'Starting…');
      break;
    }
    case 'menu': if (!game || game.ended) { if (view === 'queue' || view === 'lobby') show('home'); } lobby = null; break;
    case 'lobby': lobby = m; renderLobby(); if (!game && view !== 'lobby' && view !== 'settings') show('lobby'); break;
    case 'start': startGame(new Session({ mode: 'online', net, start: m, onEvent: e => onGameEvent(e, true) })); if (m.rejoin) toast('Back in the match.'); break;
    case 'err': toast(m.msg); if (m.fatal) { net.fatal = true; setOffline(); $('netline').textContent = m.msg; } break;
    default: if (game && game.mode === 'online') game.onServer(m);
  }
}
let onlineCount = 0, botFill = 15, joinTried = false;

function refreshProfile() {
  if (!profile) return;
  const m = profile.mmr.map(Math.round);
  $('netline').textContent = `${onlineCount} online now. You are ${profile.name}, ${rankOf(m[1])} in 2v2 with a rating of ${m[1]}.`;
  [1, 2, 3].forEach(s => { $('r' + s).textContent = `${rankOf(m[s - 1])}, rating ${m[s - 1]}`; });
}

// ------------------------------------------------------------------ views
function show(name) {
  view = name;
  document.querySelectorAll('#menu .view').forEach(v => { v.hidden = v.dataset.view !== name; });
  $('menu').hidden = false;
  if (name === 'leaderboard') loadLeaderboard(lbSize);
  if (name === 'controls') renderKeys();
  if (name === 'settings') renderSettings();
  if (name === 'garage') renderGarage();
  if (name === 'training') for (const k of D.KINDS) $('dr-' + k).textContent = `${D.tier(drillRatings[k])}, rating ${Math.round(drillRatings[k])}`;
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 4200);
}

document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.go)));
document.querySelectorAll('[data-queue]').forEach(b => b.addEventListener('click', () => { lastQueueSize = +b.dataset.queue; net.send({ t: 'queue', size: lastQueueSize }); }));
$('queue-cancel').addEventListener('click', () => { net.send({ t: 'cancel' }); show('home'); });
$('btn-freeplay').addEventListener('click', () => startGame(new Session(Object.assign({ mode: 'freeplay' }, offlineOpts()))));
document.querySelectorAll('[data-drill]').forEach(b => b.addEventListener('click', () => {
  const kind = b.dataset.drill;
  startGame(new Session(Object.assign({ mode: 'drill', kind, rating: drillRatings[kind] }, offlineOpts())));
}));
$('bots-start').addEventListener('click', () => {
  lastBots = { size: +$('bots-size').value, skill: $('bots-skill').value, minutes: +$('bots-min').value };
  startBots();
});
function startBots() { startGame(new Session(Object.assign({ mode: 'bots' }, offlineOpts(), lastBots))); }

// garage
let garageTeam = 0;
function renderGarage() {
  $('garage-bodies').innerHTML = BODIES.map((n, i) => `<button type="button" data-body="${i}" class="${i === myLook[0] ? 'on' : ''}" aria-pressed="${i === myLook[0]}">${n}</button>`).join('');
  $('garage-trims').innerHTML = TRIMS.map(([n, hex], i) => `<button type="button" data-trim="${i}" class="${i === myLook[1] ? 'on' : ''}" aria-pressed="${i === myLook[1]}" aria-label="${n}" title="${n}" style="--sw:#${hex.toString(16).padStart(6, '0')}"></button>`).join('');
  document.querySelectorAll('[data-gteam]').forEach(b => b.classList.toggle('on', +b.dataset.gteam === garageTeam));
}
function setLook(body, trim) {
  myLook = B.cleanLook([body, trim]); store.set('ob.look', myLook);
  net.send({ t: 'look', look: myLook });
  renderGarage();
}
$('garage-bodies').addEventListener('click', e => { const b = e.target.closest('[data-body]'); if (b) setLook(+b.dataset.body, myLook[1]); });
$('garage-trims').addEventListener('click', e => { const b = e.target.closest('[data-trim]'); if (b) setLook(myLook[0], +b.dataset.trim); });
$('garage-team').addEventListener('click', e => { const b = e.target.closest('[data-gteam]'); if (b) { garageTeam = +b.dataset.gteam; renderGarage(); } });

// fullscreen
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const p = (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); if (p && p.catch) p.catch(() => toast('This browser would not go fullscreen.')); }
}
$('btn-full').addEventListener('click', toggleFullscreen);
$('pause-full').addEventListener('click', toggleFullscreen);

// private lobby
$('lobby-create').addEventListener('click', () => net.send({ t: 'create', size: 2, bots: 'pro', minutes: 5 }));
$('join-form').addEventListener('submit', e => { e.preventDefault(); const c = $('join-code').value.trim(); if (c.length === 5) net.send({ t: 'join', code: c }); else toast('Lobby codes are 5 characters.'); });
$('lobby-leave').addEventListener('click', () => { net.send({ t: 'leave' }); lobby = null; show('home'); });
$('lobby-start').addEventListener('click', () => net.send({ t: 'start' }));
$('lobby-copy').addEventListener('click', () => {
  const url = location.origin + location.pathname + '?join=' + (lobby ? lobby.code : '');
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Invite link copied.'), () => toast(url));
});
document.querySelectorAll('[data-team]').forEach(b => b.addEventListener('click', () => net.send({ t: 'team', team: +b.dataset.team })));
for (const [id, key] of [['lobby-size', 'size'], ['lobby-bots', 'bots'], ['lobby-min', 'minutes']]) {
  $(id).addEventListener('change', () => net.send({ t: 'config', [key]: key === 'bots' ? $(id).value : +$(id).value }));
}
function renderLobby() {
  if (!lobby) return;
  $('lobby-code').textContent = lobby.code;
  for (const t of [0, 1]) {
    $('lobby-t' + t).innerHTML = lobby.players.filter(p => p.team === t).map(p => `<li class="${p.you ? 'you' : ''}">${esc(p.name)}${p.host ? ' (host)' : ''}</li>`).join('') || '<li>Empty</li>';
  }
  $('lobby-size').value = lobby.size; $('lobby-bots').value = lobby.bots; $('lobby-min').value = [3, 5, 10].includes(lobby.minutes) ? lobby.minutes : 5;
  for (const id of ['lobby-size', 'lobby-bots', 'lobby-min']) $(id).disabled = !lobby.host;
  $('lobby-start').hidden = !lobby.host; $('lobby-start').disabled = lobby.playing;
  $('lobby-note').textContent = lobby.playing ? 'A match is being played. You are in for the next one.' :
    (lobby.host ? 'Share the code. When everyone has picked a side, start the match.' : 'Pick a side. The host starts the match.');
}

// leaderboard
let lbSize = 2;
document.querySelectorAll('[data-lb]').forEach(b => b.addEventListener('click', () => loadLeaderboard(+b.dataset.lb)));
function loadLeaderboard(size) {
  lbSize = size;
  document.querySelectorAll('[data-lb]').forEach(b => b.classList.toggle('on', +b.dataset.lb === size));
  const body = $('lb-table').tBodies[0];
  body.innerHTML = '<tr><td class="msg">Loading…</td></tr>';
  fetch(location.pathname.replace(/[^/]*$/, '') + 'api/leaderboard?size=' + size).then(r => r.json()).then(d => {
    body.innerHTML = d.rows.length ? d.rows.map((r, i) => `<tr><td>${i + 1}. ${esc(r.name)}</td><td>${rankOf(r.mmr)}</td><td>${r.mmr}</td><td>${r.games} played</td></tr>`).join('')
      : '<tr><td class="msg">No ranked matches played yet. Win one and the top spot is yours.</td></tr>';
  }).catch(() => { body.innerHTML = '<tr><td class="msg">The leaderboard needs the game server.</td></tr>'; });
}

// settings
const RANGES = [['set-fov', 'fov', '°'], ['set-dist', 'dist', ''], ['set-height', 'height', ''], ['set-angle', 'angle', '°'], ['set-stiff', 'stiff', '%']];
function renderSettings() {
  $('set-name').value = myName; $('set-volume').value = settings.volume; $('set-quality').value = settings.quality; $('set-touch').value = settings.touch;
  $('set-sfx').value = settings.sfx; $('set-crowd').value = settings.crowd; $('set-fps').value = settings.fps ? 'on' : 'off';
  for (const [id, key, unit] of RANGES) { $(id).value = settings[key]; $(id).nextElementSibling.textContent = settings[key] + unit; }
  renderBinds();
}
for (const [id, key, unit] of RANGES) $(id).addEventListener('input', () => { settings[key] = +$(id).value; $(id).nextElementSibling.textContent = settings[key] + unit; saveSettings(); });
$('set-volume').addEventListener('input', () => { settings.volume = +$('set-volume').value; sfx.setVolume(settings.volume / 100); saveSettings(); });
$('set-sfx').addEventListener('input', () => { settings.sfx = +$('set-sfx').value; sfx.setEffects(settings.sfx / 100); saveSettings(); });
$('set-crowd').addEventListener('input', () => { settings.crowd = +$('set-crowd').value; sfx.setCrowdVolume(settings.crowd / 100); saveSettings(); });
$('set-fps').addEventListener('change', () => { settings.fps = $('set-fps').value === 'on'; saveSettings(); });
$('set-quality').addEventListener('change', () => { settings.quality = $('set-quality').value; renderer.setQuality(settings.quality); autoQuality = false; saveSettings(); });
$('set-touch').addEventListener('change', () => { settings.touch = $('set-touch').value; input.setTouchMode(settings.touch); saveSettings(); });
$('set-name').addEventListener('change', () => {
  const n = $('set-name').value.replace(/[<>&"']/g, '').trim().slice(0, 16);
  if (!n) return; myName = n; store.set('ob.name', n); net.send({ t: 'name', name: n });
});
$('settings-back').addEventListener('click', () => { if (game && !game.ended) { $('menu').hidden = true; setPaused(true); } else show('home'); });
$('binds-reset').addEventListener('click', () => { input.resetBinds(); renderBinds(); });
function renderBinds() {
  const el = $('binds'); el.innerHTML = '';
  for (const [action, label] of ACTIONS) {
    const s = document.createElement('span'); s.textContent = label;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = keyLabel(input.binds[action][0]);
    b.addEventListener('click', () => { b.classList.add('listening'); b.textContent = 'Press a key'; input.listen = { action, done: renderBinds }; });
    el.append(s, b);
  }
}
function renderKeys() {
  const kb = ACTIONS.map(([a, label]) => `<tr><td>${label}</td><td>${input.binds[a].map(k => `<kbd>${esc(keyLabel(k))}</kbd>`).join('')}</td></tr>`).join('');
  const rows = l => l.map(([k, v]) => `<tr><td>${v}</td><td><kbd>${k}</kbd></td></tr>`).join('');
  $('keys-table').tBodies[0].innerHTML = kb + `<tr><td>Quick chat</td><td><kbd>1</kbd> to <kbd>8</kbd></td></tr><tr><td>Pause</td><td><kbd>Esc</kbd></td></tr>` +
    `<tr><th colspan="2">Gamepad</th></tr>` + rows(GAMEPAD_HELP) + `<tr><th colspan="2">Touch</th></tr>` + rows(TOUCH_HELP);
}

// ------------------------------------------------------------------ starting and ending matches
function startGame(session) {
  game = session; paused = false; endInfo = null;
  renderer.setPlayers(game.players);
  $('menu').hidden = true; $('hud').hidden = false; $('pause').hidden = true; $('board').hidden = true; $('banner').hidden = true; $('count').hidden = true; $('ot').hidden = true;
  $('feed').innerHTML = ''; $('chatpick').hidden = true;
  $('pause-reset').hidden = game.mode !== 'freeplay';
  $('pause-note').textContent = game.mode === 'online' ? 'The match keeps running while this is open.' : 'Paused. Nothing moves until you come back.';
  $('pause-leave').textContent = game.mode === 'freeplay' || game.mode === 'drill' ? 'Leave training' : 'Leave match';
  input.active = true; lastCount = -1; hud.score = [-1, -1];
  buildTags();
  setBallCam(settings.ballCam);
  sfx.unlock(); sfx.crowd(game.mode === 'online' || game.mode === 'bots');
  const free = game.mode === 'freeplay', dr = game.drill;
  $('drill').hidden = !dr; $('hud').classList.toggle('drill', !!dr);
  if (dr) drillHud(dr.cur.rating, dr.you, 0);
  hint(input.touchOn ? '' : (free ? 'Free play: R resets the ball, Shift+R lobs it to you. Boost never runs out here.'
    : dr ? (dr.kind === 'keeper' ? 'Keep the ball out of your net until the clock runs down.' : 'Put the ball in the net before the clock runs down.') + ' R serves it again, N moves on. Giving up on a fresh drill counts as a miss.'
    : 'WASD to drive, Space to jump, click or X to boost, Shift to slide, C for ball cam.'), 9000);
  checkRotate();
}
function leaveGame(toView) {
  if (game && game.mode === 'online' && !game.ended) net.send({ t: 'leave' });
  game = null; paused = false; input.active = false; input.down.clear();
  $('hud').hidden = true; sfx.engine(0, 0, false, false); sfx.crowd(false);
  renderer.setPlayers(demo.players);
  show(toView || 'home');
  checkRotate();
}
function setPaused(p) {
  if (!game || game.ended) return;
  paused = p; $('pause').hidden = !p; input.active = !p; if (p) input.down.clear();
}
$('pause-resume').addEventListener('click', () => setPaused(false));
$('pause-reset').addEventListener('click', () => { game.resetBall(false); setPaused(false); });
$('pause-leave').addEventListener('click', () => leaveGame(lobby ? 'lobby' : (game && (game.drill || game.mode === 'freeplay') ? 'training' : 'home')));
$('pause-settings').addEventListener('click', () => { $('pause').hidden = true; settingsFrom = 'pause'; show('settings'); });
document.querySelector('[data-go="settings"]').addEventListener('click', () => { settingsFrom = 'home'; });

function showEnd() {
  const r = endInfo, me = game.me, myTeam = me >= 0 ? game.players[me].team : -1;
  $('hud').hidden = true; input.active = false; sfx.engine(0, 0, false, false); sfx.crowd(false);
  $('end-title').textContent = myTeam < 0 ? `${TEAM_NAME[r.winner]} win` : (myTeam === r.winner ? 'You won' : 'You lost');
  $('end-score').textContent = `${r.score[0]} – ${r.score[1]}`;
  let note;
  if (game.mode === 'bots') note = 'Offline match against bots. Ratings only change online.';
  else if (r.lobby) note = 'Private match. Ratings stay as they were.';
  else if (!r.ranked) note = 'Bots filled in, with no players on the other side, so ratings stay as they were.';
  else note = `Rating ${r.delta >= 0 ? '+' : ''}${r.delta}. You are now ${rankOf(r.mmr)} at ${r.mmr}.`;
  if (r.overtime) note = 'Decided in overtime. ' + note;
  $('end-rating').textContent = note;
  const order = game.players.map((p, i) => i).sort((a, b) => game.players[a].team - game.players[b].team || r.stats[b][4] - r.stats[a][4]);
  $('end-table').tBodies[0].innerHTML = order.map(i => {
    const p = game.players[i], s = r.stats[i];
    return `<tr class="${TEAM_CLASS[p.team]}${i === me ? ' you' : ''}"><td>${esc(p.name)}${i === r.mvp ? ' (MVP)' : ''}</td><td>${s[4]}</td><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td><td>${s[3]}</td></tr>`;
  }).join('');
  $('end-again').textContent = game.mode === 'bots' ? 'Play again' : (r.lobby ? 'Back to lobby' : 'Find another match');
  $('end-again').disabled = game.mode === 'online' && !online;
  if (r.you) { profile = r.you; refreshProfile(); }
  show('end');
}
$('end-again').addEventListener('click', () => {
  const g = game, r = endInfo;
  if (g.mode === 'bots') return startBots();
  leaveGame(r && r.lobby ? 'lobby' : 'home');
  if (!(r && r.lobby)) net.send({ t: 'queue', size: lastQueueSize });
});
$('end-menu').addEventListener('click', () => { const inLobby = endInfo && endInfo.lobby; if (inLobby) { net.send({ t: 'leave' }); lobby = null; } leaveGame('home'); });

// ------------------------------------------------------------------ in-game events
function nameOf(i) { return game && game.players[i] ? game.players[i].name : 'Someone'; }
function feed(html, team) {
  const d = document.createElement('div'); d.innerHTML = html; if (team >= 0) d.className = TEAM_CLASS[team];
  const f = $('feed'); f.appendChild(d); while (f.children.length > 5) f.removeChild(f.firstChild);
  setTimeout(() => d.remove(), 6000);
}
function hint(text, ms) { const h = $('hint'); h.textContent = text; clearTimeout(hint.timer); if (ms) hint.timer = setTimeout(() => { h.textContent = ''; }, ms); }
function banner(title, sub, team, ms) {
  const b = $('banner'); b.className = team >= 0 ? TEAM_CLASS[team] : ''; $('banner-title').textContent = title; $('banner-sub').textContent = sub || '';
  b.hidden = true; void b.offsetWidth; b.hidden = false;
  clearTimeout(banner.timer); banner.timer = setTimeout(() => { b.hidden = true; }, ms || 2800);
}
function count(text) { const c = $('count'); c.textContent = text; c.hidden = false; c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); clearTimeout(count.timer); count.timer = setTimeout(() => { c.hidden = true; }, 950); }

function onGameEvent(e, isGame) {
  const sess = isGame ? game : demo;
  if (!sess || (isGame && !game)) return;
  if (!isGame && camOpts.showroom) return;        // nothing from the backdrop match while the garage is open
  const me = sess.me, w = sess.world;
  switch (e.t) {
    case 'touch': { const k = Math.min(1, e.speed / 3200); renderer.hitSpark(w.ball.px, w.ball.py, w.ball.pz, k); if (isGame) { sfx.hit(k * (e.car === me ? 1 : 0.6)); if (k > 0.55) sfx.cheer(0.15); } break; }
    case 'bounce': if (isGame) sfx.bounce(Math.min(1, e.speed / 2500)); break;
    case 'jump': if (isGame && e.car === me) sfx.jump(); break;
    case 'flip': if (isGame && e.car === me) sfx.flip(); break;
    case 'pad': if (isGame && e.car === me) sfx.pad(e.big); break;
    case 'bump': if (isGame && (e.a === me || e.v === me)) sfx.bump(); break;
    case 'demo':
      renderer.demoBlast(e.x, e.y, e.z);
      if (isGame) { sfx.demo(); feed(`<b>${esc(nameOf(e.a))}</b> demolished <b>${esc(nameOf(e.v))}</b>`, game.players[e.a].team); }
      break;
    case 'goal': {
      renderer.goalBlast(e.x, e.y, e.z, e.team);
      if (!isGame) break;
      sfx.goal(); sfx.cheer(1);
      if (e.drill) break;                       // the drill result says what happened
      const kmh = Math.round(e.speed * 0.036);
      const who = e.scorer >= 0 && !e.own ? `${nameOf(e.scorer)} scored` : `Own goal, ${TEAM_NAME[e.team]} score`;
      banner(who, `${kmh} km/h` + (e.assist >= 0 ? `, assist by ${nameOf(e.assist)}` : ''), e.team, 2900);
      break;
    }
    case 'save': if (isGame) { feed(`<b>${esc(nameOf(e.car))}</b> made a save`, game.players[e.car].team); sfx.cheer(0.5); } break;
    case 'drillstart': if (isGame) { drillHud(e.rating, e.you, 0); $('banner').hidden = true; } break;
    case 'drill': {
      if (!isGame) break;
      drillRatings[e.kind] = e.you; store.set('ob.drills', drillRatings);
      drillHud(e.rating, e.you, e.counted ? e.delta : 0);
      const keeper = e.kind === 'keeper';
      const title = e.why === 'skipped' ? 'Skipped' : (e.ok ? (keeper ? 'Saved' : 'Scored') : (e.why === 'time' ? 'Out of time' : (keeper ? 'It went in' : 'Wrong net')));
      const sub = e.counted ? `Rating ${e.delta >= 0 ? '+' : ''}${e.delta}, now ${Math.round(e.you)}` : (e.ok ? 'Already counted, on to the next one' : 'Already counted, try it again');
      banner(title, sub, e.ok ? 0 : 1, 1300);
      if (e.ok) sfx.end(); else sfx.bump();
      break;
    }
    case 'go': if (isGame) { count('Go'); sfx.beep(true); } break;
    case 'kickoff': if (isGame) $('banner').hidden = true; break;
    case 'overtime': if (isGame) { $('ot').hidden = false; banner('Overtime', 'Next goal wins', -1, 2500); } break;
    case 'chat': if (isGame) feed(`<b>${esc(nameOf(e.slot))}</b> ${esc(CHATS[e.id] || '')}`, game.players[e.slot].team); break;
    case 'left': if (isGame) { feed(`${esc(nameOf(e.slot))} left. A bot is driving their car.`, game.players[e.slot].team); } break;
    case 'joined': if (isGame) feed(`${esc(nameOf(e.slot))} is back`, game.players[e.slot].team); break;
    case 'end': {
      if (!isGame) break;
      if (game.mode === 'online') endInfo = e;
      else {
        const sc = w.score, winner = sc[0] > sc[1] ? 0 : 1, stats = game.tracker.stats.map(s => [s.goals, s.assists, s.saves, s.shots, s.score, s.demos, -1]);
        let mvp = -1, best = -1; stats.forEach((s, i) => { if (game.players[i].team === winner && s[4] > best) { best = s[4]; mvp = i; } });
        endInfo = { score: [sc[0], sc[1]], winner, overtime: w.overtime, stats, mvp, ranked: false, delta: 0, mmr: 0, lobby: false };
      }
      banner(`${TEAM_NAME[endInfo.winner]} win`, `${endInfo.score[0]} – ${endInfo.score[1]}`, endInfo.winner, 2600);
      sfx.end();
      setTimeout(() => { if (game && game.ended && endInfo) showEnd(); }, 2600);
      break;
    }
  }
}

// ------------------------------------------------------------------ HUD
const hud = { score: [-1, -1], clock: '', boost: -1, speed: -1, board: 0, net: 0 };
let lastCount = -1, tags = [], ballCam = true;
const proj = { x: 0, y: 0, ok: false }, aim = { dx: 0, dy: 0 };
let fps = 60, fpsN = 0, fpsT = 0;

function buildTags() {
  const el = $('tags'); el.innerHTML = ''; tags = [];
  game.players.forEach((p, i) => {
    if (i === game.me) { tags.push(null); return; }
    const s = document.createElement('span'); s.className = TEAM_CLASS[p.team]; s.textContent = p.name; s.hidden = true; el.appendChild(s); tags.push(s);
  });
}
function drillHud(rating, you, delta) {
  $('drill-rate').textContent = Math.round(rating); $('drill-you').textContent = Math.round(you);
  const d = $('drill-delta'); d.textContent = delta ? (delta > 0 ? '+' : '') + delta : ''; d.className = delta > 0 ? 'up' : 'down';
}
$('drill-retry').addEventListener('click', () => { if (game && game.drill) game.retryDrill(); });
$('drill-next').addEventListener('click', () => { if (game && game.drill) game.nextDrill(); });
function setBallCam(on) {
  ballCam = on; settings.ballCam = on; saveSettings();
  $('camtag').textContent = on ? 'Ball cam on' : 'Ball cam off';
  $('tb-cam').classList.toggle('on', on);
}
$('camtag').addEventListener('click', () => setBallCam(!ballCam));

function sendChat(i) {
  if (!game) return;
  if (i < 0) { $('chatpick').hidden = !$('chatpick').hidden; return; }
  $('chatpick').hidden = true;
  if (game.mode === 'online') net.send({ t: 'chat', id: i }); else feed(`<b>${esc(nameOf(game.me))}</b> ${esc(CHATS[i])}`, game.players[game.me].team);
}
$('chatpick').innerHTML = CHATS.map((c, i) => `<button type="button" data-chat="${i}">${c}</button>`).join('');
$('chatpick').addEventListener('click', e => { const b = e.target.closest('[data-chat]'); if (b) sendChat(+b.dataset.chat); });

input.on.ballCam = () => { if (game && !paused) setBallCam(!ballCam); };
input.on.pause = () => {
  if (game && !game.ended) { if (!$('menu').hidden) { $('menu').hidden = true; setPaused(true); } else setPaused(!paused); }
  else if (!game && view !== 'home' && view !== 'queue' && view !== 'lobby') show('home');
};
input.on.chat = i => { if (game && !paused && !game.ended) sendChat(i); };
input.on.reset = toss => { if (!game || paused) return; if (game.mode === 'freeplay') game.resetBall(toss); else if (game.drill) game.retryDrill(); };
input.on.next = () => { if (game && game.drill && !paused) game.nextDrill(); };
input.on.any = () => sfx.unlock();

function hudFrame() {
  const w = game.world, me = game.me, c = me >= 0 ? w.cars[me] : null;
  if (w.score[0] !== hud.score[0]) { hud.score[0] = w.score[0]; $('score0').textContent = w.score[0]; }
  if (w.score[1] !== hud.score[1]) { hud.score[1] = w.score[1]; $('score1').textContent = w.score[1]; }
  const free = game.mode === 'freeplay', dr = game.drill;
  const left = dr ? Math.max(0, dr.cur.time - dr.t) : 0;
  const clk = dr ? left.toFixed(1) : (free ? 'Free' : (w.overtime ? '+' + fmtClock(Math.floor(w.clock)) : fmtClock(w.clock)));
  if (clk !== hud.clock) { hud.clock = clk; $('clock').textContent = clk; $('clock').classList.toggle('late', dr ? left <= 2 : (!free && !w.overtime && w.clock <= 30)); }
  if (w.phase === S.PH_COUNTDOWN) {
    const n = Math.ceil(w.phaseT);
    if (n !== lastCount && n > 0 && n <= 3) { lastCount = n; count(String(n)); sfx.beep(false); }
  } else lastCount = -1;
  if (c) {
    const b = Math.round(c.boost);
    if (b !== hud.boost) { hud.boost = b; $('boost-num').textContent = b; $('boost-fill').style.width = b + '%'; }
    const sp = Math.hypot(c.vx, c.vy, c.vz), kmh = Math.round(sp * 0.036);
    if (kmh !== hud.speed) { hud.speed = kmh; $('speed-num').textContent = kmh; }
    $('speed').classList.toggle('super', c.superSonic);
    sfx.engine(sp, c['in'].throttle, c.boosting, c.demoT <= 0 && !paused && w.phase !== S.PH_END);
  }
  // name tags
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]; if (!t) continue;
    const o = game.ents[i].out, car = w.cars[i];
    renderer.project(o[0], o[1], o[2] + 95, proj);
    const vis = proj.ok && car.demoT <= 0;
    if (vis) t.style.transform = `translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px) translate(-50%, -100%)`;
    if (t.hidden === vis) t.hidden = !vis;
  }
  // arrow at the edge of the screen when the ball is out of view
  const bo = game.ballEnt.out, ptr = $('ballptr');
  let lost = false;
  if (w.ballOn && c && c.demoT <= 0) { renderer.project(bo[0], bo[1], bo[2], proj); lost = !proj.ok; }
  if (lost) {
    renderer.pointer(bo[0], bo[1], bo[2], aim);
    const rx = innerWidth / 2 - 54, ry = innerHeight / 2 - 54, k = Math.min(rx / (Math.abs(aim.dx) || 1e-6), ry / (Math.abs(aim.dy) || 1e-6));
    ptr.style.transform = `translate(${(innerWidth / 2 + aim.dx * k).toFixed(1)}px, ${(innerHeight / 2 + aim.dy * k).toFixed(1)}px) translate(-50%, -50%) rotate(${Math.atan2(aim.dy, aim.dx).toFixed(3)}rad)`;
  }
  if (ptr.hidden === lost) ptr.hidden = !lost;
  // scoreboard
  const showBoard = input.scoreboard && !paused;
  if (showBoard !== !$('board').hidden) $('board').hidden = !showBoard;
  const now = performance.now();
  if (showBoard && now - hud.board > 300 && game.rows) {
    hud.board = now;
    const order = game.players.map((p, i) => i).sort((a, b) => game.players[a].team - game.players[b].team || game.rows[b][4] - game.rows[a][4]);
    $('board-rows').innerHTML = order.map(i => { const p = game.players[i], s = game.rows[i] || [0, 0, 0, 0, 0, 0, -1];
      return `<tr class="${TEAM_CLASS[p.team]}${i === me ? ' you' : ''}"><td>${esc(p.name)}</td><td>${s[4]}</td><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td><td>${s[3]}</td><td>${p.bot ? 'bot' : (s[6] >= 0 ? s[6] + ' ms' : '')}</td></tr>`; }).join('');
  }
  if (now - hud.net > 500) {
    hud.net = now;
    const bits = [];
    if (settings.fps) bits.push(fps + ' fps');
    if (game.mode === 'online') bits.push(`${Math.round(net.rtt)} ms${game.ranked ? ', ranked' : ''}${game.code ? ', lobby ' + game.code : ''}`);
    $('netstat').textContent = bits.join(' · ');
  }
}

function checkRotate() { $('rotate').hidden = !(game && !game.ended && input.touchOn && innerHeight > innerWidth * 1.1); }
addEventListener('resize', checkRotate);

// ------------------------------------------------------------------ frame loop
const camOpts = { ballCam: true, cam: settings, showroom: null };
const garage = { team: 0, look: myLook, shift: 0 };
let last = performance.now(), slow = 0, autoQuality = !store.get('ob.settings', null);
function frame(now) {
  requestAnimationFrame(frame);
  const real = Math.max(0.001, (now - last) / 1000), dt = Math.min(0.1, real); last = now;
  const inp = input.sample();
  const sess = game || demo;
  if (!(game && paused && game.mode !== 'online')) sess.update(sess.mode === 'online' ? real : dt, inp);
  camOpts.ballCam = ballCam;
  if (!game && view === 'garage' && !$('menu').hidden) {
    const wide = innerWidth > 640 || innerWidth > innerHeight;       // on a tall phone the menu sits on top instead of beside
    garage.team = garageTeam; garage.look = myLook; garage.shift = wide ? ($('menu').offsetWidth - 70) / 2 : 0;
    camOpts.showroom = garage;
  } else camOpts.showroom = null;
  renderer.frame(sess, dt, camOpts);
  fpsN++; fpsT += real; if (fpsT >= 0.5) { fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
  if (game && !$('hud').hidden) hudFrame();
  // drop to fast graphics once if the device is struggling
  if (autoQuality && settings.quality === 'high') {
    slow = dt > 0.03 ? slow + dt : Math.max(0, slow - dt * 0.5);
    if (slow > 3) { autoQuality = false; settings.quality = 'low'; renderer.setQuality('low'); saveSettings(); toast('Switched to fast graphics to keep things smooth.'); }
  }
}

demo = new Session({ mode: 'demo', onEvent: e => onGameEvent(e, false) });
renderer.setPlayers(demo.players);
show('home');
net.connect();
requestAnimationFrame(frame);

// handy for debugging from the console
window.OB = { get game() { return game; }, get demo() { return demo; }, renderer, input, net, settings };

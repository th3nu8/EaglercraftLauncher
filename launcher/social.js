/* Mist — friends, presence, chat and profiles */
window.MistSocial = function (ctx) {
  'use strict';
  var el = ctx.el, toast = ctx.toast, ago = ctx.ago;
  var $ = function (s) { return document.querySelector(s); };
  var data = null;              // last /api/social response
  var seenIncoming = null;      // names we've already toasted
  var lastUnread = {};          // name -> unread count last poll
  var panelOpen = false;
  var chat = null;              // { name, lastId, msgs, timer }
  var playing = null;           // game name or null
  var pollTimer = null, beatTimer = null;

  function eng() { var e = ctx.getEngine(); return e && e.signedIn() ? e : null; }
  function api(method, path, json) {
    var e = eng(); if (!e) return Promise.reject(new Error('Sign in first.'));
    return e.api(method, path, json ? { json: json } : {}).then(function (r) { if (r && r.looks) mergeLooks(r.looks); return r; });
  }
  /* ---------- pixel-art avatars: 12x12, 144 palette indices (0 = background colour) ---------- */
  var PALETTE = [null, '#000000', '#ffffff', '#9aa4ad', '#5b6670', '#e74c3c', '#f39c12', '#f1c40f', '#2ecc71', '#1e8449', '#3498db', '#1f4e9c', '#9b59b6', '#ff79c6', '#a0522d', '#f5cba7'];
  function pixelSvg(px, bg) {
    var rects = '';
    for (var i = 0; i < 144; i++) { var c = parseInt(px[i], 16); if (c) rects += '<rect x="' + (i % 12) + '" y="' + Math.floor(i / 12) + '" width="1.02" height="1.02" fill="' + PALETTE[c] + '"/>'; }
    return '<svg viewBox="0 0 12 12" shape-rendering="crispEdges"><rect width="12" height="12" fill="' + (bg || '#1b1f24') + '"/>' + rects + '</svg>';
  }
  // Starting points for the editor ('.' = background).
  var PIXEL_PRESETS = {
    Slime: ['............','............','....8888....','..88888888..','.8888888888.','.8821882188.','.8822882288.','.8888888888.','.8888111888.','.9888888889.','..99999999..','............'],
    Ghost: ['............','....2222....','..22222222..','.2222222222.','.2211221122.','.2211221122.','.2222222222.','.22dd22dd22.','.2222222222.','.2222222222.','.22.2222.22.','.2...22...2.'],
    Skull: ['............','...222222...','..22222222..','.2222222222.','.2211221122.','.2211221122.','.2222112222.','..22222222..','...2.22.2...','...222222...','....2..2....','............'],
    Heart: ['............','..55....55..','.5555..5555.','555255555555','552555555555','555555555555','.5555555555.','..55555555..','...555555...','....5555....','.....55.....','............'],
    Cat: ['............','.6........6.','.66......66.','.6666666666.','.6666666666.','.6616666166.','.6666666666.','.6666dd6666.','.6661dd1666.','.6666666666.','..66666666..','............'],
    Mushroom: ['............','....5555....','..55225525..','.5555555555.','.5255555525.','555555225555','.5555555555.','....ffff....','....f1f1....','....ffff....','...ffffff...','............'],
    Robot: ['.....33.....','.....55.....','..33333333..','..34444443..','..34a44a43..','..34444443..','..34111143..','..33333333..','.3333333333.','.3.333333.3.','...33..33...','...44..44...'],
    Alien: ['............','...888888...','..88888888..','.8888888888.','.8111881118.','.8121881218.','.8888888888.','..88811888..','...888888...','....8888....','............','............'],
    Potion: ['.....ee.....','.....ee.....','....3333....','.....33.....','....3333....','...3cccc3...','..3cccccc3..','..3cc2ccc3..','..3cccccc3..','..3cccccc3..','...333333...','............'],
    Star: ['.....77.....','.....77.....','....7777....','777777777777','.7777777777.','..77777777..','..77777777..','.7777..7777.','.777....777.','.77......77.','............','............'],
    Ninja: ['............','...111111...','..11111111..','.1111111111.','.55555555555','.11ff11ff11.','.1111111111.','.1111111111.','..11111111..','...111111...','..1......1..','............'],
    Sword: ['..........33','.........323','........323.','.......323..','......323...','.e...323....','.ee.323.....','..ee23......','...ee.......','..e.ee......','.e...ee.....','e...........'],
    Fox: ['.6........6.','.66......66.','.666....666.','.6666666666.','666666666666','.6616666166.','.6666666666.','.6222662226.','..22211222..','...222222...','....2222....','............'],
    Frog: ['............','.222....222.','.212....212.','.8888888888.','888888888888','888888888888','8dd888888dd8','888111111888','.8888888888.','..88888888..','.88......88.','............'],
    Penguin: ['....1111....','...111111...','..11211211..','..11111111..','..11166111..','.1122222211.','.1222222221.','.1222222221.','.1222222221.','..12222221..','...222222...','..66....66..'],
    Crown: ['............','............','.7...77...7.','.77..77..77.','.777.77.777.','.7777777777.','.7757757757.','.7777777777.','.7a777777a7.','.7777777777.','............','............'],
    Fire: ['.....5......','....55......','....555..5..','...5555.55..','..55565555..','..55666655..','.5566676655.','.5567777655.','.5567777665.','.5566776655.','..55666655..','...555555...'],
    Bomb: ['.........7..','........767.','.......6.7..','......6.....','....1116....','...111111...','..11211111..','..12111111..','..11111111..','..11111111..','...111111...','....1111....'],
    Diamond: ['............','...aaaaaa...','..a2aaaa2a..','.aaaaaaaaaa.','aaaaaaaaaaaa','.baaaaaaaab.','..baaaaaab..','...baaaab...','....baab....','.....bb.....','............','............'],
    Shield: ['.3333333333.','.3aaaaaaaa3.','.3aaa77aaa3.','.3aaa77aaa3.','.3a777777a3.','.3a777777a3.','.3aaa77aaa3.','..3aa77aa3..','..3aaaaaa3..','...3aaaa3...','....3aa3....','.....33.....'],
    Controller: ['............','............','..44444444..','.4444444444.','441444444544','411144448484','441444444a44','444444444444','4444....4444','.44......44.','............','............'],
    Pumpkin: ['.....99.....','.....9......','..66666666..','.6666666666.','.6116666116.','.6116666116.','.6666116666.','.6666666666.','.6111111116.','.6616116166.','..66666666..','............'],
    Cactus: ['.....dd.....','....8888....','....8988....','.88.8888....','.88.8898.88.','.8888888.88.','....8888888.','....8988....','....8888....','..eeeeeeee..','...eeeeee...','...eeeeee...'],
    Panda: ['............','.11......11.','.111....111.','..22222222..','.2222222222.','.2112222112.','.2122222212.','.2222112222.','.2222222222.','..22211222..','...222222...','............'],
    Bunny: ['..22....22..','..2d2..2d2..','..2d2..2d2..','..2d2..2d2..','..22222222..','.2222222222.','.2212222122.','.2222222222.','.2222dd2222.','.2222222222.','..22222222..','............'],
    Duck: ['............','....7777....','...777777...','...771777...','...77777666.','...7777766..','..77777777..','.7777777777.','.7777777777.','.7777777777.','..77777777..','....6..6....'],
    Owl: ['............','.e........e.','.ee......ee.','.eeeeeeeeee.','.e2221e222e.','.e2112e2112.','.e2222e2222.','.eeeee6eeeee','.eefffffeee.','.eefffffeee.','..eeeeeeee..','...6....6...'],
    Octopus: ['............','....cccc....','..cccccccc..','.cccccccccc.','.cc22cc22cc.','.cc21cc21cc.','.cccccccccc.','.cccccccccc.','.c.cc.cc.cc.','.c.c..c..c..','c..c..c..c..','............'],
    Shark: ['............','.....3......','....33......','...3333.....','.33333333..3','3333333333.3','3313333333.3','33333333333.','.2222222233.','..22222233..','...333333...','............'],
    Bee: ['............','..22....22..','.2222..2222.','..22.11.22..','....1111....','...777777...','..11111111..','..77777777..','..11111111..','...777777...','....1111....','.....11.....'],
    Ladybug: ['............','.....11.....','...111111...','..55511555..','.5515515155.','.5555115555.','.5155115515.','.5555115555.','.5515515155.','..55511555..','...555555...','............'],
    Planet: ['............','............','....cccc....','..cccccccc..','.cccdcccccc.','666666666666','.6cccccccc6.','.cccccdcccc.','..cccccccc..','....cccc....','............','............'],
    Moon: ['............','....7777....','..777777....','.77777......','.7777.......','.7777.......','.7777.......','.77777......','..777777....','...7777777..','....777777..','............'],
    Sun: ['.....7......','.7...7...7..','..7.777.7...','...77777....','.777777777..','7777777777.7','.777777777..','...77777....','..7.777.7...','.7...7...7..','.....7......','............'],
    Lightning: ['............','.......777..','......777...','.....777....','....777.....','...77777777.','....77777...','......777...','.....777....','....77......','...77.......','............'],
    Snowman: ['....1111....','...111111...','....2222....','...221122...','...222622...','....2222....','..22222222..','.2221222222.','.2222222222.','.2221222222.','..22222222..','............'],
    Tree: ['.....88.....','....8888....','...888888...','....8888....','...888888...','..88888888..','...888888...','..88888888..','.8888888888.','.....ee.....','.....ee.....','....eeee....'],
    Flower: ['............','....dd......','...dddd.....','..dd77dd....','...dddd.....','....dd......','.....8......','.....8.88...','..88.8888...','...888......','.....8......','.....8......'],
    Trophy: ['............','.7777777777.','77.777777.77','.7.777777.7.','..77777777..','...777777...','....7777....','.....77.....','.....77.....','...777777...','...eeeeee...','...eeeeee...'],
    Rocket: ['.....55.....','....5225....','....2222....','....2aa2....','....2aa2....','....2222....','...522225...','..55222255..','..5.2222.5..','....6..6....','....7667....','.....77.....'],
    Astronaut: ['............','...222222...','..22222222..','.2244444422.','.2244444422.','.2244a44422.','.2224444222.','..22222222..','.2222552222.','.2222222222.','.22.2222.22.','....22.22...'],
    Knight: ['............','....3333....','...333333...','..33333333..','..33333333..','..31111113..','..33333333..','..33311333..','..33333333..','...333333...','..44444444..','............'],
    Wizard: ['.....cc.....','....ccc.....','....cc7c....','...cccccc...','...cc7ccc...','..cccccccc..','.cccccccccc.','...ffffff...','...f1ff1f...','...ffffff...','..22222222..','...222222...'],
    Dragon: ['............','.9........9.','.99......99.','..88888888..','.8888888888.','.8818888188.','.8888888888.','..88888888..','..81888818..','..88888888..','...2.22.2...','............'],
    Donut: ['............','...eeeeee...','..edddddde..','.edd5ddadde.','.dd7dd..ddd.','.ddd....ddd.','.dda....d5d.','.edd....dde.','.eddd5ddade.','..edddddde..','...eeeeee...','............'],
    IceCream: ['............','....dddd....','...dddddd...','..dd2ddddd..','..dddddddd..','..d2dddd2d..','..eeeeeeee..','...e6ee6e...','...eeeeee...','....e66e....','....eeee....','.....ee.....']
  };
  var PLUS_AVATARS = ['Panda', 'Bunny', 'Duck', 'Owl', 'Octopus', 'Shark', 'Bee', 'Ladybug', 'Planet', 'Moon', 'Sun', 'Lightning', 'Snowman', 'Tree', 'Flower', 'Trophy', 'Rocket', 'Astronaut', 'Knight', 'Wizard', 'Dragon', 'Donut', 'IceCream'];   // supporter-only avatars
  function presetPx(rows) { return rows.map(function (r) { return (r + '............').slice(0, 12).replace(/\./g, '0'); }).join(''); }

  /* Chosen profile avatars, by lower-case name: { k: preset name, c: background colour }. Filled from server responses. */
  var looks = {};
  function mergeLooks(m) { var changed = false; for (var n in m) { var k = n.toLowerCase(); if (JSON.stringify(looks[k]) !== JSON.stringify(m[n])) { looks[k] = m[n]; changed = true; } } if (changed && ctx.onLooks) ctx.onLooks(); }
  function lookKey(name) { var l = looks[String(name).toLowerCase()]; return l ? l.k + l.c : ''; }

  /* ---------- avatars: 5x5 mirrored pixel face from the name ---------- */
  function hash(s) { var h = 2166136261; s = String(s).toLowerCase(); for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; }
  function avatar(name, size, state) {
    var a = baseAvatar(name, size, state), lk = looks[String(name).toLowerCase()];
    if (lk && lk.s) { a.classList.add('gold'); a.title = name + ' · Mist Supporter'; }
    return a;
  }
  function baseAvatar(name, size, state) {
    var lk = looks[String(name).toLowerCase()];
    if (lk && lk.k && PIXEL_PRESETS[lk.k]) { var a = el('span', 'av' + (state ? ' st-' + state : '')); a.style.width = a.style.height = size + 'px'; a.innerHTML = pixelSvg(presetPx(PIXEL_PRESETS[lk.k]), lk.c); return a; }
    var h = hash(name), hue = h % 360, bits = h >>> 8, cells = '';
    for (var y = 0; y < 5; y++) for (var x = 0; x < 3; x++) {
      if ((bits >> (y * 3 + x)) & 1) {
        cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
        if (x < 2) cells += '<rect x="' + (4 - x) + '" y="' + y + '" width="1" height="1"/>';
      }
    }
    var d = el('span', 'av' + (state ? ' st-' + state : ''));
    d.style.width = d.style.height = size + 'px';
    d.innerHTML = '<svg viewBox="-1 -1 7 7" shape-rendering="crispEdges"><rect x="-1" y="-1" width="7" height="7" fill="hsl(' + hue + ',35%,22%)"/><g fill="hsl(' + hue + ',70%,62%)">' + cells + '</g></svg>';
    return d;
  }
  function stateText(f) {
    if (f.state === 'ingame') return 'Playing ' + (f.game || 'a game');
    if (f.state === 'online') return 'Online';
    return f.lastSeen ? 'Last online ' + ago(f.lastSeen).toLowerCase() : 'Offline';
  }

  /* ---------- achievements ---------- */
  function fmtTime(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec ? '<1m' : '0m';
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    return h ? h + 'h' + (m && h < 10 ? ' ' + m + 'm' : '') : m + 'm';
  }
  var achQueue = [], achShowing = false;
  function showAchievements(list) {
    if (!list || !list.length) return;
    achQueue = achQueue.concat(list); if (!achShowing) nextAch();
  }
  function nextAch() {
    var a = achQueue.shift(); if (!a) { achShowing = false; return; }
    achShowing = true;
    var host = document.getElementById('achToasts');
    if (!host) { host = el('div'); host.id = 'achToasts'; document.body.appendChild(host); }
    var t = el('div', 'ach-toast' + (a.levelUp ? ' lvl-up' : ''));
    if (a.levelUp) t.appendChild(levelBadge(a.level, 44)); else t.appendChild(el('span', 'ach-ico', a.icon));
    var tx = el('div', 'ach-tx');
    if (a.levelUp) { tx.appendChild(el('small', null, 'Level up!')); tx.appendChild(el('b', null, 'Level ' + a.level)); tx.appendChild(el('span', null, (a.need - a.into).toLocaleString() + ' XP to level ' + (a.level + 1))); }
    else { if (a.rank) t.classList.add('r-' + a.rank); tx.appendChild(el('small', null, 'Achievement unlocked · ' + (a.rank ? a.rank.charAt(0).toUpperCase() + a.rank.slice(1) + ' · ' : '') + '+' + (a.xp || 100) + ' XP')); tx.appendChild(el('b', null, a.name)); tx.appendChild(el('span', null, a.desc)); }
    t.appendChild(tx); host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); nextAch(); }, 350); }, 4500);
  }

  /* ---------- XP and levels: 1k XP/level to 20, 2k to 50, 3k to 100, then 5k (uncapped) ---------- */
  var myLevel = null;   // levels are uncapped
  function levelBadge(n, size) {
    var n0 = n || 0, b = el('span', 'lvl-badge t' + (n0 < 10 ? 0 : n0 < 20 ? 1 : n0 < 35 ? 2 : n0 < 50 ? 3 : n0 < 100 ? 4 : 5), String(n0));
    b.title = 'Level ' + (n || 0);
    if (size) { b.style.width = b.style.height = size + 'px'; b.style.fontSize = Math.round(size * 0.42) + 'px'; }
    return b;
  }
  function levelBar(info) {
    var w = el('div', 'lvl-wrap'); w.appendChild(levelBadge(info.level, 40));
    var tx = el('div', 'lvl-tx');
    tx.appendChild(el('b', null, 'Level ' + info.level));
    var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = (info.need ? Math.round(100 * info.into / info.need) : 100) + '%'; pb.appendChild(pf); tx.appendChild(pb);
    tx.appendChild(el('small', null, info.need ? info.into.toLocaleString() + ' / ' + info.need.toLocaleString() + ' XP to level ' + (info.level + 1) + ' · ' + info.xp.toLocaleString() + ' XP total' : info.xp.toLocaleString() + ' XP total'));
    w.appendChild(tx); return w;
  }
  /* Called with the server's level info after anything that can unlock achievements. */
  function noteLevel(info) {
    if (!info || typeof info.level !== 'number') return;
    if (myLevel && info.level > myLevel.level) achQueue.push({ levelUp: true, level: info.level, into: info.into, need: info.need });
    if (achQueue.length && !achShowing) nextAch();
    myLevel = info;
    var host = document.getElementById('pLevel');
    if (host) { host.textContent = ''; host.appendChild(levelBadge(info.level, 18)); }
  }
  function handleUnlocks(r) { if (!r) return; showAchievements(r.newAchievements); noteLevel(r.level); }

  /* ---------- presence ---------- */
  function beat() {
    if (!eng()) return;
    api('POST', '/api/presence', playing ? { state: 'ingame', game: playing } : { state: 'online' })
      .then(handleUnlocks, function () {});
  }
  function setPlaying(gameName) { playing = gameName || null; beat(); }

  /* ---------- polling ---------- */
  function refresh() {
    if (!eng()) { data = null; render(); return Promise.resolve(); }
    return api('GET', '/api/social').then(function (d) {
      // notifications
      if (seenIncoming) d.incoming.forEach(function (n) { if (seenIncoming.indexOf(n) < 0) toast(n + ' sent you a friend request'); });
      seenIncoming = d.incoming.slice();
      d.friends.forEach(function (f) {
        var was = lastUnread[f.name] || 0;
        if (f.unread > was && !(chat && chat.name === f.name)) toast('New message from ' + f.name);
        lastUnread[f.name] = f.unread;
      });
      handleUnlocks(d);
      data = d; render();
    }).catch(function () {});
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { refresh().then(schedule); }, socialActive() ? 8000 : 20000);
  }
  function start() {
    refresh().then(schedule);
    clearInterval(beatTimer); beat(); beatTimer = setInterval(beat, 60000);
    window.addEventListener('pagehide', function () {
      var e = eng(); if (!e) return;
      try { fetch(e.server + '/api/presence', { method: 'POST', keepalive: true, headers: { Authorization: 'Bearer ' + e.token, 'Content-Type': 'application/json' }, body: '{"state":"offline"}' }); } catch (x) {}
    });
  }
  function onAuthChange() {
    seenIncoming = null; lastUnread = {}; myLevel = null;
    var lv = document.getElementById('pLevel'); if (lv) lv.textContent = '';
    if (socialActive()) setTimeout(function () { renderSocial(socState.tab); }, 0);
    if (!eng()) { closeChat(); data = null; render(); return; }
    beat(); refresh();
  }

  /* ---------- footer button ---------- */
  function renderButton() {
    var b = $('#friendsBtn'); if (!b) return;
    b.textContent = '';
    b.appendChild(el('span', 'fb-ico', '👥'));
    b.appendChild(el('span', null, 'Friends & Chat'));
    if (data) {
      var on = data.friends.filter(function (f) { return f.state !== 'offline'; }).length;
      b.appendChild(el('span', 'fb-count', on + ' online'));
      var badge = data.incoming.length + data.friends.reduce(function (a, f) { return a + (f.unread || 0); }, 0);
      if (badge) b.appendChild(el('span', 'fb-badge', String(badge)));
    }
    b.classList.toggle('on', socialActive());
  }

  /* ---------- friends panel ---------- */
  // Friends now live on the Social page; the old side panel opens that instead.
  function togglePanel() { if (ctx.showSocial) ctx.showSocial('friends'); }
  function render() {
    renderButton();
    if (ovHost) drawOvFriends();
    if (chat) { var cf = friend(chat.name), cst = $('#chatState');
      if (cf && cst) { cst.textContent = stateText(cf); cst.className = 'st-' + cf.state; } }
    var fh = document.getElementById('socFriends');
    if (fh && socState.tab === 'friends' && socialActive()) drawFriends(fh);
  }
  function drawFriends(p) {
    p.textContent = '';
    var head = el('div', 'fp-head');
    if (!eng()) {
      head.appendChild(el('b', null, 'Friends'));
      p.appendChild(head);
      var e = el('div', 'fp-empty');
      e.appendChild(el('p', null, ctx.getEngine() ? 'Sign in to add friends, see what they’re playing and chat.' : 'Friends need a save server. Set one in Settings.'));
      var b = el('button', 'btn green', ctx.getEngine() ? 'Sign in' : 'Open settings');
      b.onclick = function () { ctx.openAccount(); };
      e.appendChild(b); p.appendChild(e); return;
    }
    var me = el('button', 'fp-me');
    me.appendChild(avatar(eng().user, 40, playing ? 'ingame' : 'online'));
    var mt = el('span', 'fp-me-t'); mt.appendChild(el('b', null, eng().user));
    mt.appendChild(el('small', 'st-' + (playing ? 'ingame' : 'online'), playing ? 'Playing ' + playing : 'Online'));
    me.appendChild(mt); me.onclick = function () { openProfile(eng().user); };
    head.appendChild(me);
    var add = el('button', 'fp-add', '＋'); add.title = 'Add a friend'; add.onclick = openAddFriend;
    head.appendChild(add);
    p.appendChild(head);

    var list = el('div', 'fp-list');
    if (!data) { list.appendChild(el('div', 'fp-empty', 'Loading…')); p.appendChild(list); return; }
    if (data.incoming.length) {
      list.appendChild(el('div', 'fp-group', 'Friend requests (' + data.incoming.length + ')'));
      data.incoming.forEach(function (n) {
        var r = el('div', 'fp-row req');
        r.appendChild(avatar(n, 32));
        var t = el('div', 'fp-t'); t.appendChild(el('b', null, n)); t.appendChild(el('small', null, 'wants to be friends')); r.appendChild(t);
        var ok = el('button', 'mini ok', '✓'); ok.title = 'Accept';
        ok.onclick = function () { api('POST', '/api/friends/accept', { username: n }).then(function () { toast('You and ' + n + ' are now friends'); refresh(); }, function (e) { toast(e.message); }); };
        var no = el('button', 'mini', '✕'); no.title = 'Decline';
        no.onclick = function () { api('POST', '/api/friends/decline', { username: n }).then(refresh); };
        r.appendChild(ok); r.appendChild(no); list.appendChild(r);
      });
    }
    var groups = [['ingame', 'In-game'], ['online', 'Online'], ['offline', 'Offline']];
    groups.forEach(function (g) {
      var fs = data.friends.filter(function (f) { return f.state === g[0]; });
      if (!fs.length) return;
      list.appendChild(el('div', 'fp-group', g[1] + ' (' + fs.length + ')'));
      fs.forEach(function (f) {
        var r = el('button', 'fp-row st-' + f.state + (chat && chat.name === f.name ? ' sel' : ''));
        r.appendChild(avatar(f.name, 32, f.state));
        var t = el('div', 'fp-t'); t.appendChild(el('b', null, f.name)); t.appendChild(el('small', null, stateText(f))); r.appendChild(t);
        if (f.unread) r.appendChild(el('span', 'fb-badge', String(f.unread)));
        var more = el('span', 'mini more', '⋯'); more.title = 'More';
        more.onclick = function (e) {
          e.stopPropagation();
          ctx.popMenu(more, [
            ['Send message', function () { openChat(f.name); }],
            ['View profile', function () { openProfile(f.name); }],
            ['Remove friend', function () { removeFriend(f.name); }]
          ]);
        };
        r.appendChild(more);
        r.onclick = function () { openChat(f.name); };
        list.appendChild(r);
      });
    });
    if (!data.friends.length && !data.incoming.length) {
      var em = el('div', 'fp-empty');
      em.appendChild(el('p', null, 'No friends yet. Add someone by their account name.'));
      var ab = el('button', 'btn green', 'Add a friend'); ab.onclick = openAddFriend; em.appendChild(ab);
      list.appendChild(em);
    }
    if (data.outgoing.length) {
      list.appendChild(el('div', 'fp-group', 'Sent requests (' + data.outgoing.length + ')'));
      data.outgoing.forEach(function (n) {
        var r = el('div', 'fp-row st-offline'); r.appendChild(avatar(n, 32));
        var t = el('div', 'fp-t'); t.appendChild(el('b', null, n)); t.appendChild(el('small', null, 'Request pending')); r.appendChild(t);
        var c = el('button', 'mini', '✕'); c.title = 'Cancel request';
        c.onclick = function () { api('POST', '/api/friends/cancel', { username: n }).then(refresh); };
        r.appendChild(c); list.appendChild(r);
      });
    }
    p.appendChild(list);
  }

  function removeFriend(n) {
    if (!confirm('Remove ' + n + ' from your friends?')) return;
    api('POST', '/api/friends/remove', { username: n }).then(function () {
      toast(n + ' removed'); if (chat && chat.name === n) closeChat(); ctx.closeModal(); refresh();
    }, function (e) { toast(e.message); });
  }

  function openAddFriend() {
    ctx.openModal(function (box) {
      box.appendChild(el('h3', null, 'Add a friend'));
      box.appendChild(el('p', null, 'Enter their Mist account name. They’ll see your request next time they open Mist.'));
      var form = el('form');
      form.appendChild(ctx.field('Account name', 'text', 'n', 'off'));
      var err = el('div', 'm-err'); form.appendChild(err);
      var a = el('div', 'm-actions');
      var cancel = ctx.button('ghost', 'Cancel', null, ctx.closeModal); cancel.type = 'button';
      var go = el('button', 'btn green', 'Send request'); go.type = 'submit';
      a.appendChild(cancel); a.appendChild(go); form.appendChild(a);
      form.onsubmit = function (e) {
        e.preventDefault(); var n = form.n.value.trim(); if (!n) return;
        go.disabled = true; err.textContent = '';
        api('POST', '/api/friends/request', { username: n }).then(function (r) {
          ctx.closeModal(); toast(r.accepted ? 'You and ' + n + ' are now friends' : 'Friend request sent to ' + n); refresh();
        }, function (e2) { err.textContent = e2.message; go.disabled = false; });
      };
      box.appendChild(form);
    });
  }

  /* ---------- profiles ---------- */
  function openProfile(name) { ctx.closeModal(); ctx.showProfile(name); }

  function goalText(a) {
    var id = a.id || '';
    if (id.indexOf('one-game') === 0) return fmtTime(a.goal) + ' in one game';
    if (a.fmt === 'time') return fmtTime(a.goal) + ' played';
    var units = [['friends', 'friend', 'friends'], ['msg', 'message sent', 'messages sent'], ['games', 'different game', 'different games'],
      ['streak', 'day in a row', 'days in a row'], ['days', 'day active', 'days active'], ['cloud', 'cloud backup', 'cloud backups']];
    if (id === 'welcome') return 'create an account';
    if (id === 'supporter') return 'an active Mist Supporter subscription';
    if (id === 'caleb-gf') return 'a miracle';
    for (var i = 0; i < units.length; i++) if (id.indexOf(units[i][0]) === 0) return a.goal + ' ' + (a.goal === 1 ? units[i][1] : units[i][2]);
    return String(a.goal);
  }
  function oldServerNote() {
    var n = el('div', 'old-server');
    n.appendChild(el('b', null, 'Your Mist server needs updating.'));
    n.appendChild(el('span', null, ' Game achievements and totals need the newest server.js. On the server: git pull, copy server/server.js to /opt/eaglercraft-saves/, then restart the service.'));
    return n;
  }

  var hookDefs = {}, genericDefs = [];
  function loadHookDefs() { if (!eng()) return Promise.resolve(hookDefs); return api('GET', '/api/hook-defs').then(function (r) { hookDefs = r.games || {}; genericDefs = r.generic || []; return hookDefs; }, function () { return hookDefs; }); }
  function extraCount(n) { return genericDefs.length + (hookDefs[n] ? hookDefs[n].length : 0); }

  /* Rarity: common / rare / epic / legendary, each worth a set amount of XP. */
  var RANK_XP = { common: 100, rare: 250, epic: 500, legendary: 1000, supporter: 2500, impossible: 1000000 };
  function rankEl(rank) {
    rank = RANK_XP[rank] ? rank : 'common';
    return el('span', 'rank r-' + rank, rank.charAt(0).toUpperCase() + rank.slice(1) + ' · ' + RANK_XP[rank].toLocaleString() + ' XP');
  }
  /* One list per game: its own achievements first, then the playtime ones. */
  function gameSections(box, special, tiers, showProgress) {
    (special || []).forEach(function (t) { box.appendChild(specialRow(t)); });
    tiers.forEach(function (t) { box.appendChild(tierRow(t, showProgress)); });
  }

  /* ---------- Edit profile: pick a pixel-art avatar + background colour, write a bio ---------- */
  function openEditProfile(pr) {
    api('GET', '/api/look-options').then(function (opt) {
      var key = pr.name.toLowerCase(), cur = looks[key] || null;
      var pick = { k: cur ? cur.k : '', c: cur ? cur.c : opt.colors[11] }, supporter = !!(cur && cur.s) || !!pr.supporter;
      ctx.openModal(function (box) {
        box.classList.add('edit-prof');
        box.appendChild(el('h3', null, 'Edit profile'));
        var prev = el('div', 'ep-preview');
        function face(k, size) {
          var a = el('span', 'av'); a.style.width = a.style.height = size + 'px';
          if (k) { a.innerHTML = pixelSvg(presetPx(PIXEL_PRESETS[k]), pick.c); return a; }
          var save = looks[key]; delete looks[key]; a = avatar(pr.name, size); if (save) looks[key] = save; return a;
        }
        function draw() {
          prev.textContent = ''; prev.appendChild(face(pick.k, 72)); var t = el('div'); t.appendChild(el('b', null, pr.name));
          t.appendChild(el('small', null, pick.k ? pick.k : 'Default avatar')); prev.appendChild(t);
          grid.textContent = '';
          [''].concat(Object.keys(PIXEL_PRESETS)).forEach(function (k) {
            var plusOnly = PLUS_AVATARS.indexOf(k) >= 0, locked = plusOnly && !supporter;
            if (plusOnly && k === PLUS_AVATARS[0]) grid.appendChild(el('div', 'ep-plus-h', '💛 Supporter avatars' + (supporter ? '' : ' · $5/month')));
            var b = el('button', (pick.k === k ? 'on' : '') + (locked ? ' locked' : '')); b.title = (k || 'Default (from your name)') + (locked ? ' (supporters only)' : '');
            b.appendChild(face(k, 44)); if (locked) b.appendChild(el('i', 'lock', '🔒'));
            b.onclick = function () { if (locked) { ctx.closeModal(); openSupport(); return; } pick.k = k; draw(); }; grid.appendChild(b);
          });
          sw.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.color === pick.c); });
          sw.classList.toggle('off', !pick.k);
        }
        box.appendChild(prev);
        box.appendChild(el('div', 'ep-label', 'Avatar'));
        var grid = el('div', 'ep-avatars'); box.appendChild(grid);
        box.appendChild(el('div', 'ep-label', 'Background colour'));
        var sw = el('div', 'ep-colors');
        opt.colors.forEach(function (c) { var b = el('button'); b.dataset.color = c; b.style.background = c; b.onclick = function () { pick.c = c; draw(); }; sw.appendChild(b); });
        box.appendChild(sw);
        box.appendChild(el('div', 'ep-label', 'Bio'));
        var ta = document.createElement('textarea'); ta.className = 'ep-bio'; ta.maxLength = 200; ta.rows = 3; ta.placeholder = 'Say something about yourself (200 characters)'; ta.value = pr.bio || '';
        var cnt = el('small', 'ep-count'); function upd() { cnt.textContent = ta.value.length + ' / 200'; } ta.oninput = upd; upd();
        box.appendChild(ta); box.appendChild(cnt);
        var err = el('p', 'm-err'); box.appendChild(err);
        var acts = el('div', 'm-actions');
        acts.appendChild(ctx.button('ghost', 'Cancel', null, ctx.closeModal));
        var go = ctx.button('green', 'Save', null, function () {
          go.disabled = true; err.textContent = '';
          api('POST', '/api/profile/edit', { avatar: pick.k, color: pick.c, bio: ta.value }).then(function (r) {
            if (r.look) looks[key] = r.look; else delete looks[key];
            ctx.closeModal(); toast('Profile updated');
            if (ctx.onLooks) ctx.onLooks();
            renderProfile(pr.name);
          }, function (e) { err.textContent = e.message; go.disabled = false; });
        });
        acts.appendChild(go); box.appendChild(acts);
        draw();
      });
    }, function (e) { toast(e.message); });
  }

  /* ---------- Leaderboard ---------- */
  var lbBy = 'xp', lbSeq = 0;
  function renderLeaderboard() {
    var host = $('#lbPage'); if (!host) return;
    host.textContent = '';
    var head = el('div', 'users-head'); head.appendChild(el('h2', null, 'Leaderboard'));
    var tabs = el('div', 'ptabs lb-tabs');
    [['xp', 'Level & XP'], ['achievements', 'Achievements'], ['playtime', 'Playtime']].forEach(function (t) {
      var b = el('button', lbBy === t[0] ? 'on' : null, t[1]);
      b.onclick = function () { lbBy = t[0]; renderLeaderboard(); };
      tabs.appendChild(b);
    });
    head.appendChild(tabs); host.appendChild(head);
    if (!eng()) {
      var e0 = el('div', 'fp-empty'); e0.appendChild(el('p', null, 'Sign in to see the leaderboard.'));
      var b0 = el('button', 'btn green', 'Sign in'); b0.onclick = ctx.openAccount; e0.appendChild(b0); host.appendChild(e0); return;
    }
    var body = el('div'); body.appendChild(el('div', 'fp-empty', 'Loading…')); host.appendChild(body);
    var seq = ++lbSeq;
    api('GET', '/api/leaderboard?by=' + lbBy).then(function (r) {
      if (seq !== lbSeq) return;
      body.textContent = '';
      if (!r.players) { body.appendChild(oldServerNote()); return; }
      var val = function (p) { return lbBy === 'achievements' ? p.achievements.toLocaleString() + ' achievements' : lbBy === 'playtime' ? fmtTime(p.playtime) + ' played' : p.xp.toLocaleString() + ' XP'; };
      if (r.me) {
        var mine = el('div', 'lb-me');
        mine.appendChild(el('span', 'lb-me-rank', '#' + r.me.rank));
        var mt = el('div', 'lb-me-tx'); mt.appendChild(el('b', null, 'Your rank: #' + r.me.rank + ' of ' + r.total));
        mt.appendChild(el('small', null, 'Level ' + r.me.level + ' · ' + val(r.me))); mine.appendChild(mt);
        if (lbBy === 'xp') mine.appendChild(levelBar({ level: r.me.level, xp: r.me.xp, into: r.me.into, need: r.me.need, maxLevel: r.maxLevel }));
        body.appendChild(mine);
      }
      // podium
      var top = r.players.slice(0, 3);
      if (top.length) {
        var pod = el('div', 'lb-podium');
        [1, 0, 2].forEach(function (i) {
          var p = top[i]; if (!p) return;
          var c = el('div', 'lb-pod lb-pod' + (i + 1) + (p.isMe ? ' me' : ''));
          c.appendChild(el('div', 'lb-medal', ['🥇', '🥈', '🥉'][i]));
          var av = avatar(p.name, i === 0 ? 72 : 58); c.appendChild(av);
          var nm = el('b', 'link', p.name); nm.onclick = function () { ctx.showProfile(p.name); }; c.appendChild(nm);
          var lv = el('div', 'lb-pod-lv'); lv.appendChild(levelBadge(p.level, 22)); lv.appendChild(el('span', null, 'Level ' + p.level)); c.appendChild(lv);
          c.appendChild(el('small', null, val(p)));
          pod.appendChild(c);
        });
        body.appendChild(pod);
      }
      var list = el('div', 'lb-list');
      r.players.forEach(function (p) {
        var row = el('div', 'lb-row' + (p.isMe ? ' me' : '') + (p.isFriend ? ' friend' : ''));
        row.appendChild(el('span', 'lb-rank' + (p.rank <= 3 ? ' top' : ''), '#' + p.rank));
        row.appendChild(avatar(p.name, 36));
        var tx = el('div', 'lb-tx');
        var nm = el('b', 'link'); nm.appendChild(levelBadge(p.level, 20)); nm.appendChild(document.createTextNode(p.name));
        if (p.isMe) nm.appendChild(el('span', 'lb-tag', 'You')); else if (p.isFriend) nm.appendChild(el('span', 'lb-tag fr', 'Friend'));
        nm.onclick = function () { ctx.showProfile(p.name); }; tx.appendChild(nm);
        if (lbBy === 'xp') { var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = (p.need ? Math.round(100 * p.into / p.need) : 100) + '%'; pb.appendChild(pf); tx.appendChild(pb); }
        row.appendChild(tx);
        var right = el('div', 'lb-val'); right.appendChild(el('b', null, val(p)));
        right.appendChild(el('small', null, lbBy === 'xp' ? p.achievements.toLocaleString() + ' achievements' : 'Level ' + p.level + ' · ' + p.xp.toLocaleString() + ' XP'));
        row.appendChild(right);
        list.appendChild(row);
      });
      body.appendChild(list);
      if (r.total > r.players.length) body.appendChild(el('p', 'psec-sub', 'Showing the top ' + r.players.length + ' of ' + r.total + ' players.'));
    }, function (e) { if (seq === lbSeq) { body.textContent = ''; body.appendChild(el('div', 'fp-empty', e.message)); } });
  }

  /* ---------- per-game achievements (7 per game) ---------- */
  var GAME_TIERS = [['m5','🌱','First Look','5 minutes',300],['m15','🎈','Warming Up','15 minutes',900],['m30','🎯','Getting the Hang','30 minutes',1800],
    ['h1','🪝','Hooked','1 hour',3600],['h2','🎮','Regular','2 hours',7200],['h5','💪','Dedicated','5 hours',18000],['h10','🛡️','Veteran','10 hours',36000]];
  var TIER_RANK = { m5: 'common', m15: 'common', m30: 'common', h1: 'rare', h2: 'rare', h5: 'epic', h10: 'legendary' };
  function staticTiers(game) {
    return GAME_TIERS.map(function (t) { return { id: t[0], icon: t[1], name: t[2], label: t[3], goal: t[4], rank: TIER_RANK[t[0]], desc: 'Play ' + game + ' for ' + t[3] + '.' }; });
  }
  function tierRow(t, showProgress) {
    var row = el('div', 'pach' + (t.unlocked ? ' got' : ''));
    row.appendChild(el('span', 'ach-ico', t.icon));
    var tx = el('div', 'pach-tx'); tx.appendChild(el('b', null, t.name)); tx.appendChild(el('span', null, t.desc));
    tx.appendChild(el('small', 'goal', 'Goal: ' + t.label + ' played'));
    if (showProgress && !t.unlocked && t.progress !== undefined) {
      var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = Math.round(100 * t.progress / t.goal) + '%'; pb.appendChild(pf); tx.appendChild(pb);
      tx.appendChild(el('small', null, fmtTime(t.progress) + ' / ' + fmtTime(t.goal)));
    }
    row.appendChild(tx);
    var right = el('div', 'pach-r'); right.appendChild(rankEl(t.rank));
    if (t.unlocked !== undefined) right.appendChild(el('small', null, t.unlocked ? 'Unlocked ' + fmtDate(t.unlocked, true) : 'Locked'));
    if (t.rarity !== undefined) right.appendChild(rarityEl(t.rarity));
    row.appendChild(right);
    return row;
  }
  function specialRow(t) {
    var row = el('div', 'pach special' + (t.unlocked ? ' got' : ''));
    row.appendChild(el('span', 'ach-ico', t.icon));
    var tx = el('div', 'pach-tx'); tx.appendChild(el('b', null, t.name)); tx.appendChild(el('span', null, t.desc));
    if (!t.unlocked && t.progress !== undefined && t.goal > 1) {
      var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = Math.round(100 * t.progress / t.goal) + '%'; pb.appendChild(pf); tx.appendChild(pb);
      tx.appendChild(el('small', null, Number(t.progress).toLocaleString() + ' / ' + Number(t.goal).toLocaleString()));
    }
    row.appendChild(tx);
    var right = el('div', 'pach-r'); right.appendChild(rankEl(t.rank));
    if (t.unlocked !== undefined) right.appendChild(el('small', null, t.unlocked ? 'Unlocked ' + fmtDate(t.unlocked, true) : 'Locked'));
    if (t.rarity !== undefined) right.appendChild(rarityEl(t.rarity));
    row.appendChild(right);
    return row;
  }
  /* Achievements panel for one game (store page and library). */
  function renderGameAch(host, game) {
    host.textContent = '';
    var head = el('div', 'gach-h'); head.appendChild(el('h5', null, 'Achievements')); host.appendChild(head);
    var list = el('div', 'plist'); host.appendChild(list);
    function draw(tiers, summary, special) {
      list.textContent = '';
      if (summary) head.appendChild(summary);
      gameSections(list, special, tiers, true);
    }
    if (!eng()) {
      var note = el('span', 'gach-sum', 'Sign in to track achievements');
      draw(staticTiers(game), note); return;
    }
    list.appendChild(el('div', 'fp-empty', 'Loading…'));
    api('GET', '/api/game-achievements?game=' + encodeURIComponent(game)).then(function (r) {
      var sum = el('span', 'gach-sum', r.unlocked + ' / ' + r.total + ' unlocked · ' + fmtTime(r.seconds) + ' played');
      var wrap = el('div', 'pbar big gach-bar'); var f = el('i'); f.style.width = Math.round(100 * r.unlocked / r.total) + '%'; wrap.appendChild(f);
      draw(r.tiers, sum, r.special); host.insertBefore(wrap, list);
    }, function () { draw(staticTiers(game), el('span', 'gach-sum', '7 achievements')); });
  }

  /* ---------- achievements page: everything, with names and goals ---------- */
  var achView = { tab: 'games', q: '', shown: 60, open: {} };
  function renderAchPage() {
    var host = $('#achPage'); if (!host) return;
    host.textContent = '';
    if (!eng()) {
      var e0 = el('div', 'fp-empty'); e0.appendChild(el('p', null, 'Sign in to track achievements.'));
      var b0 = el('button', 'btn green', 'Sign in'); b0.onclick = ctx.openAccount; e0.appendChild(b0); host.appendChild(e0);
      return;
    }
    host.appendChild(el('div', 'fp-empty', 'Loading achievements…'));
    Promise.all([api('GET', '/api/profile?name=' + encodeURIComponent(eng().user)), loadHookDefs()]).then(function (r) { var pr = r[0]; host.textContent = ''; buildAchPage(host, pr); },
      function (e) { host.textContent = ''; host.appendChild(el('div', 'fp-empty', e.message)); });
  }
  function buildAchPage(host, pr) {
    if (!pr.games) host.appendChild(oldServerNote());
    var played = {}; (pr.games || []).forEach(function (g) { played[g.name] = g; });
    var names = ctx.gameNames();
    var general = pr.achievements || [];
    var genGot = general.filter(function (a) { return a.unlocked; }).length;
    var gameGot = 0; Object.keys(played).forEach(function (n) { gameGot += played[n].tiers.filter(function (t) { return t.unlocked; }).length + (played[n].special || []).filter(function (t) { return t.unlocked; }).length; });
    var perGame = function (n) { return GAME_TIERS.length + extraCount(n); };
    var gameTotal = names.reduce(function (a, n) { return a + perGame(n); }, 0);
    var total = general.length + gameTotal, got = genGot + gameGot;

    var top = el('div', 'ach-top');
    var big = el('div', 'ach-big'); big.appendChild(el('b', null, got.toLocaleString() + ' / ' + total.toLocaleString()));
    big.appendChild(el('small', null, 'achievements unlocked · ' + (Math.round(1000 * got / total) / 10) + '%'));
    top.appendChild(big);
    if (pr.level) top.appendChild(levelBar(pr.level));
    var bar = el('div', 'pbar big'); var f = el('i'); f.style.width = Math.max(0.5, 100 * got / total) + '%'; bar.appendChild(f); top.appendChild(bar);
    var split = el('div', 'ach-split');
    split.appendChild(el('span', null, 'General: ' + genGot + ' / ' + general.length));
    split.appendChild(el('span', null, 'Game achievements: ' + gameGot.toLocaleString() + ' / ' + gameTotal.toLocaleString() + ' across ' + names.length + ' games'));
    top.appendChild(split);
    host.appendChild(top);

    var tabs = el('div', 'ptabs ach-tabs');
    [['games', 'Game achievements'], ['general', 'General']].forEach(function (t) {
      var b = el('button', achView.tab === t[0] ? 'on' : '', t[1]);
      b.onclick = function () { achView.tab = t[0]; host.textContent = ''; buildAchPage(host, pr); };
      tabs.appendChild(b);
    });
    host.appendChild(tabs);

    if (achView.tab === 'general') {
      var list = el('div', 'plist');
      general.forEach(function (a) {
        var row = el('div', 'pach' + (a.unlocked ? ' got' : ''));
        row.appendChild(el('span', 'ach-ico', a.icon));
        var tx = el('div', 'pach-tx'); tx.appendChild(el('b', null, a.name)); tx.appendChild(el('span', null, a.desc));
        if (a.goal !== undefined) tx.appendChild(el('small', 'goal', 'Goal: ' + goalText(a)));
        if (!a.unlocked && a.goal && a.progress !== undefined) {
          var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = Math.round(100 * a.progress / a.goal) + '%'; pb.appendChild(pf); tx.appendChild(pb);
          tx.appendChild(el('small', null, a.fmt === 'time' ? fmtTime(a.progress) + ' / ' + fmtTime(a.goal) : a.progress + ' / ' + a.goal));
        }
        row.appendChild(tx);
        var r = el('div', 'pach-r'); r.appendChild(rankEl(a.rank)); r.appendChild(el('small', null, a.unlocked ? 'Unlocked ' + fmtDate(a.unlocked, true) : 'Locked'));
        if (a.rarity !== undefined) r.appendChild(rarityEl(a.rarity)); row.appendChild(r);
        list.appendChild(row);
      });
      host.appendChild(list);
      return;
    }

    var bar2 = el('div', 'ach-tools');
    var q = el('input', 'store-search'); q.placeholder = 'search games'; q.value = achView.q;
    var sortSel = el('select', 'vselect');
    [['progress', 'Most unlocked'], ['name', 'A–Z']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; sortSel.appendChild(op); });
    sortSel.value = achView.sort || 'progress';
    bar2.appendChild(q); bar2.appendChild(sortSel);
    bar2.appendChild(el('small', 'psec-sub', 'Every game: 🌱 5m · 🎈 15m · 🎯 30m · 🪝 1h · 🎮 2h · 💪 5h · 🛡️ 10h'));
    host.appendChild(bar2);
    var listHost = el('div'); host.appendChild(listHost);
    var more = el('div', 'more-wrap'); var mb = el('button', 'btn'); more.appendChild(mb); host.appendChild(more);
    function draw() {
      listHost.textContent = '';
      var term = achView.q.toLowerCase();
      var rows = names.filter(function (n) { return !term || n.toLowerCase().indexOf(term) >= 0; }).map(function (n) {
        var p = played[n];
        var got = p ? p.tiers.filter(function (t) { return t.unlocked; }).length + (p.special || []).filter(function (t) { return t.unlocked; }).length : 0;
        return { name: n, p: p, got: got, total: perGame(n), sec: p ? p.seconds : 0, hooked: !!hookDefs[n] };
      });
      rows.sort(achView.sort === 'name' ? function (a, b) { return a.name.localeCompare(b.name); } : function (a, b) { return b.got - a.got || b.sec - a.sec || a.name.localeCompare(b.name); });
      rows.slice(0, achView.shown).forEach(function (r) {
        var card = el('div', 'pgame expandable');
        var ico = el('div', 'pgame-ico small'); var gg = ctx.gameByName(r.name); if (gg) ctx.artInto(ico, gg, 'capsule', false); card.appendChild(ico);
        var info = el('div', 'pgame-info'); info.appendChild(el('b', null, r.name));
        info.appendChild(el('small', 'pgame-count', r.got + ' / ' + r.total + ' achievements' + (r.sec ? ' · ' + fmtTime(r.sec) + ' played' : ' · not played yet')));
        var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = (100 * r.got / r.total) + '%'; pb.appendChild(pf); info.appendChild(pb);
        card.appendChild(info);
        var tiers = el('div', 'ptiers');
        (r.p ? r.p.tiers : staticTiers(r.name)).forEach(function (t) { var m = el('span', 'ptier' + (t.unlocked ? ' got' : ''), t.icon); m.title = t.name + ': play ' + t.label; tiers.appendChild(m); });
        card.appendChild(tiers);
        var tog = el('span', 'pgame-more', achView.open[r.name] ? '▴' : '▾'); card.appendChild(tog);
        var full = el('div', 'plist pgame-full' + (achView.open[r.name] ? ' open' : ''));
        function fill() {
          if (full.children.length) return;
          var sp = r.p && r.p.special ? r.p.special : (hookDefs[r.name] || []).concat(genericDefs).map(function (a) { return Object.assign({}, a, { unlocked: null, progress: 0 }); });
          var tl = r.p ? r.p.tiers : staticTiers(r.name).map(function (t) { t.unlocked = null; t.progress = 0; return t; });
          gameSections(full, sp, tl, true);
        }
        if (achView.open[r.name]) fill();
        card.onclick = function () { achView.open[r.name] = !achView.open[r.name]; fill(); full.classList.toggle('open', !!achView.open[r.name]); tog.textContent = achView.open[r.name] ? '▴' : '▾'; };
        listHost.appendChild(card); listHost.appendChild(full);
      });
      var left = rows.length - achView.shown;
      more.style.display = left > 0 ? '' : 'none'; mb.textContent = 'Show more (' + left + ' games left)';
    }
    var t;
    q.oninput = function () { clearTimeout(t); t = setTimeout(function () { achView.q = q.value.trim(); achView.shown = 60; draw(); }, 200); };
    sortSel.onchange = function () { achView.sort = sortSel.value; draw(); };
    mb.onclick = function () { achView.shown += 60; draw(); };
    draw();
  }

  /* ---------- full profile page ---------- */
  var profSeq = 0, profFilter = 'all';
  function fmtDate(t, long) { return new Date(t).toLocaleDateString(undefined, long ? { month: 'long', day: 'numeric', year: 'numeric' } : { month: 'short', year: 'numeric' }); }
  function rarityEl(r) {
    if (!r) return el('span', 'rarity', 'No one yet');
    var cls = r <= 5 ? 'ultra' : r <= 20 ? 'rare' : '';
    return el('span', 'rarity ' + cls, (r < 1 ? '<1' : r) + '% of players');
  }
  function renderProfile(name) {
    var host = $('#profilePage'); if (!host) return;
    host.textContent = '';
    if (!eng()) {
      var e0 = el('div', 'fp-empty'); e0.appendChild(el('p', null, 'Sign in to see player profiles.'));
      var b0 = el('button', 'btn green', 'Sign in'); b0.onclick = ctx.openAccount; e0.appendChild(b0); host.appendChild(e0); return;
    }
    host.appendChild(el('div', 'fp-empty', 'Loading profile…'));
    var seq = ++profSeq;
    Promise.all([api('GET', '/api/profile?name=' + encodeURIComponent(name || eng().user)), loadHookDefs()]).then(function (r) {
      var pr = r[0];
      if (seq !== profSeq) return;
      host.textContent = '';
      buildProfile(host, pr);
    }, function (e) { if (seq === profSeq) { host.textContent = ''; host.appendChild(el('div', 'fp-empty', e.message)); } });
  }
  function buildProfile(host, pr) {
    var hue = hash(pr.name) % 360;
    /* header */
    var hero = el('div', 'prof-hero');
    hero.style.background = 'linear-gradient(120deg,hsl(' + hue + ',45%,24%),hsl(' + ((hue + 40) % 360) + ',40%,14%) 60%,#16202d)';
    hero.appendChild(avatar(pr.name, 132, pr.state || null));
    var who = el('div', 'prof-who');
    var h1 = el('h1', null, pr.name); if (pr.supporter) h1.appendChild(el('span', 'sup-badge', '💛 Supporter')); who.appendChild(h1);
    if (pr.bio) who.appendChild(el('p', 'prof-bio', pr.bio));
    else if (pr.isMe) who.appendChild(el('p', 'prof-bio empty', 'No bio yet. Click Edit profile to add one.'));
    if (pr.state) who.appendChild(el('div', 'prof-state st-' + pr.state, stateText(pr)));
    who.appendChild(el('div', 'prof-meta', 'Member since ' + fmtDate(pr.created, true) + ' · ' + pr.friendCount + ' friend' + (pr.friendCount === 1 ? '' : 's')));
    if (pr.level) who.appendChild(levelBar(pr.level));
    hero.appendChild(who);
    var acts = el('div', 'prof-acts');
    if (pr.isMe) {
      acts.appendChild(ctx.button('green', 'Edit profile', null, function () { openEditProfile(pr); }));
      acts.appendChild(ctx.button('', 'Friends & chat', null, function () { togglePanel(true); }));
    } else if (pr.isFriend) {
      acts.appendChild(ctx.button('green', 'Message', null, function () { openChat(pr.name); }));
      acts.appendChild(ctx.button('ghost', 'Remove friend', null, function () { removeFriend(pr.name); setTimeout(function () { renderProfile(pr.name); }, 600); }));
    } else {
      var add = ctx.button('green', pr.requestedYou ? 'Accept friend request' : pr.requested ? 'Request sent' : 'Add friend', null, function () {
        if (pr.requested) return;
        api('POST', pr.requestedYou ? '/api/friends/accept' : '/api/friends/request', { username: pr.name }).then(function () {
          toast(pr.requestedYou ? 'You and ' + pr.name + ' are now friends' : 'Friend request sent'); refresh(); renderProfile(pr.name);
        }, function (e) { toast(e.message); });
      });
      if (pr.requested) add.disabled = true;
      acts.appendChild(add);
    }
    hero.appendChild(acts);
    host.appendChild(hero);

    /* stats strip */
    if (!pr.games) host.appendChild(oldServerNote());
    pr.games = pr.games || [];
    var s = pr.stats || {}, strip = el('div', 'prof-stats');
    var gameTotal = ctx.gameNames().reduce(function (a, n) { return a + GAME_TIERS.length + extraCount(n); }, 0);
    [[fmtTime(s.playtime || 0), 'Played'], [String(s.games || 0), 'Games'], [(s.achievements || 0) + ' / ' + (s.achievementsTotal || pr.achievements.length), 'Achievements'],
     [(s.gameBadges || 0) + ' / ' + gameTotal.toLocaleString(), 'Game achievements'], [String(s.bestStreak || 0), 'Best streak'], [String(s.daysActive || 0), 'Days active']
    ].forEach(function (x) { var c = el('div', 'pst'); c.appendChild(el('b', null, x[0])); c.appendChild(el('small', null, x[1])); strip.appendChild(c); });
    host.appendChild(strip);

    var cols = el('div', 'prof-cols'), main = el('div'), side = el('div');

    /* achievements */
    var sec = el('section', 'psec');
    var head = el('div', 'psec-h');
    var got = pr.achievements.filter(function (a) { return a.unlocked; }).length;
    head.appendChild(el('h2', null, 'Achievements'));
    head.appendChild(el('span', 'psec-count', got + ' of ' + pr.achievements.length));
    var tabs = el('div', 'ptabs');
    [['all', 'All'], ['got', 'Unlocked'], ['locked', 'Locked']].forEach(function (t) {
      var b = el('button', profFilter === t[0] ? 'on' : '', t[1]);
      b.onclick = function () { profFilter = t[0]; host.textContent = ''; buildProfile(host, pr); };
      tabs.appendChild(b);
    });
    head.appendChild(tabs);
    sec.appendChild(head);
    var bar = el('div', 'pbar big'); var fill = el('i'); fill.style.width = Math.round(100 * got / pr.achievements.length) + '%'; bar.appendChild(fill); sec.appendChild(bar);
    var list = el('div', 'plist');
    pr.achievements.filter(function (a) { return profFilter === 'all' || (profFilter === 'got' ? a.unlocked : !a.unlocked); })
      .sort(function (a, b) { return (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0) || (b.unlocked || 0) - (a.unlocked || 0) || a.rarity - b.rarity; })
      .forEach(function (a) {
        var row = el('div', 'pach' + (a.unlocked ? ' got' : ''));
        row.appendChild(el('span', 'ach-ico', a.icon));
        var tx = el('div', 'pach-tx');
        tx.appendChild(el('b', null, a.name));
        tx.appendChild(el('span', null, a.desc));
        if (a.goal !== undefined) tx.appendChild(el('small', 'goal', 'Goal: ' + goalText(a)));
        if (!a.unlocked && a.goal && a.progress !== undefined) {
          var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = Math.round(100 * a.progress / a.goal) + '%'; pb.appendChild(pf); tx.appendChild(pb);
          tx.appendChild(el('small', null, a.fmt === 'time' ? fmtTime(a.progress) + ' / ' + fmtTime(a.goal) : a.progress + ' / ' + a.goal));
        }
        row.appendChild(tx);
        var right = el('div', 'pach-r'); right.appendChild(rankEl(a.rank));
        right.appendChild(el('small', null, a.unlocked ? 'Unlocked ' + fmtDate(a.unlocked, true) : 'Locked'));
        right.appendChild(rarityEl(a.rarity));
        row.appendChild(right);
        list.appendChild(row);
      });
    if (!list.children.length) list.appendChild(el('div', 'fp-empty', profFilter === 'got' ? 'Nothing unlocked yet.' : 'Everything unlocked!'));
    sec.appendChild(list);
    main.appendChild(sec);

    /* per-game achievements */
    var gsec = el('section', 'psec');
    var gh = el('div', 'psec-h'); gh.appendChild(el('h2', null, 'Game achievements'));
    gh.appendChild(el('span', 'psec-count', (s.gameBadges || 0) + ' of ' + gameTotal.toLocaleString() + ' unlocked'));
    if (pr.isMe) { var all = ctx.button('', 'See all achievements', null, function () { ctx.showAchievements(); }); all.classList.add('psec-btn'); gh.appendChild(all); }
    gsec.appendChild(gh);
    gsec.appendChild(el('p', 'psec-sub', 'Every game has 7 achievements for time played, from 5 minutes up to 10 hours. Click a game to see them all.'));
    if (!pr.games.length) gsec.appendChild(el('div', 'fp-empty', (pr.isMe ? 'You haven’t' : pr.name + ' hasn’t') + ' played any games yet.'));
    pr.games.forEach(function (g) {
      var card = el('div', 'pgame');
      var ico = el('div', 'pgame-ico'); var gg = ctx.gameByName(g.name); if (gg) ctx.artInto(ico, gg, 'capsule', false); card.appendChild(ico);
      var info = el('div', 'pgame-info');
      var nm = el('b', null, g.name); if (gg) { nm.classList.add('link'); nm.onclick = function () { ctx.showGame(gg); }; }
      info.appendChild(nm);
      info.appendChild(el('small', null, fmtTime(g.seconds) + ' played' + (g.lastPlayed ? ' · last played ' + fmtDate(g.lastPlayed, true) : '')));
      if (g.next) {
        var nb = el('div', 'pbar'); var nf = el('i'); nf.style.width = Math.round(100 * g.next.progress / g.next.goal) + '%'; nb.appendChild(nf); info.appendChild(nb);
        info.appendChild(el('small', null, 'Next: ' + g.next.name + ' · ' + fmtTime(g.next.progress) + ' / ' + fmtTime(g.next.goal)));
      }
      card.appendChild(info);
      var sp = g.special || [];
      var gotN = g.tiers.filter(function (t) { return t.unlocked; }).length + sp.filter(function (t) { return t.unlocked; }).length;
      info.appendChild(el('small', 'pgame-count', gotN + ' / ' + (g.tiers.length + sp.length) + ' achievements'));
      var tiers = el('div', 'ptiers');
      g.tiers.forEach(function (t) {
        var m = el('span', 'ptier' + (t.unlocked ? ' got' : ''), t.icon);
        m.title = t.name + ': play ' + t.label + '\n' + (t.unlocked ? 'Unlocked ' + fmtDate(t.unlocked, true) : 'Locked') + '\n' + (t.rarity ? t.rarity + '% of players' : 'No one yet');
        tiers.appendChild(m);
      });
      card.appendChild(tiers);
      var toggle = el('span', 'pgame-more', '▾');
      card.appendChild(toggle);
      var full = el('div', 'plist pgame-full');
      gameSections(full, sp, g.tiers, pr.isMe);
      card.onclick = function (e) {
        if (e.target.closest('.link')) return;
        var open = full.classList.toggle('open'); toggle.textContent = open ? '▴' : '▾';
      };
      card.classList.add('expandable');
      gsec.appendChild(card);
      gsec.appendChild(full);
    });
    main.appendChild(gsec);

    /* side: recently played + friends */
    if (pr.recent && pr.recent.length) {
      var rs = el('section', 'psec side'); rs.appendChild(el('h3', null, 'Recently played'));
      pr.recent.forEach(function (r) {
        var row = el('div', 'pside-row'); var gi = el('span', 'pside-ico'); var g2 = ctx.gameByName(r.game); if (g2) ctx.artInto(gi, g2, 'icon', false);
        row.appendChild(gi); var t = el('div', 'fp-t'); t.appendChild(el('b', null, r.game)); t.appendChild(el('small', null, ago(r.at))); row.appendChild(t);
        if (g2) { row.classList.add('link'); row.onclick = function () { ctx.showGame(g2); }; }
        rs.appendChild(row);
      });
      side.appendChild(rs);
    }
    if (pr.friends) {
      var fs = el('section', 'psec side'); fs.appendChild(el('h3', null, 'Friends (' + pr.friends.length + ')'));
      if (!pr.friends.length) fs.appendChild(el('small', 'psec-sub', 'No friends yet.'));
      pr.friends.forEach(function (f) {
        var row = el('button', 'pside-row link'); row.appendChild(avatar(f.name, 30, f.state || null));
        var t = el('div', 'fp-t'); t.appendChild(el('b', null, f.name)); if (f.state) t.appendChild(el('small', 'st-' + f.state, stateText(f))); row.appendChild(t);
        row.onclick = function () { openProfile(f.name); };
        fs.appendChild(row);
      });
      side.appendChild(fs);
    } else if (!pr.isMe) {
      var hint = el('section', 'psec side'); hint.appendChild(el('h3', null, 'Friends'));
      hint.appendChild(el('small', 'psec-sub', 'Become friends with ' + pr.name + ' to see their friends and what they’re playing.'));
      side.appendChild(hint);
    }
    cols.appendChild(main); cols.appendChild(side); host.appendChild(cols);
  }

  /* ---------- chat ---------- */
  function friend(name) { if (!data) return null; for (var i = 0; i < data.friends.length; i++) if (data.friends[i].name === name) return data.friends[i]; return null; }
  function openChat(name) {
    if (chat && chat.name === name) { $('#chatWin input') && $('#chatWin input').focus(); return; }
    closeChat();
    chat = { name: name, lastId: 0, timer: null };
    var w = $('#chatWin'); w.textContent = ''; w.classList.add('open');
    var f = friend(name) || { name: name, state: 'offline' };
    var head = el('div', 'cw-head');
    var who = el('button', 'cw-who'); who.appendChild(avatar(name, 30, f.state));
    var wt = el('span', 'fp-t'); wt.appendChild(el('b', null, name)); var ws = el('small', 'st-' + f.state, stateText(f)); ws.id = 'chatState'; wt.appendChild(ws);
    who.appendChild(wt); who.onclick = function () { openProfile(name); };
    head.appendChild(who);
    var x = el('button', 'fp-x', '✕'); x.onclick = closeChat; head.appendChild(x);
    w.appendChild(head);
    var msgs = el('div', 'cw-msgs'); msgs.id = 'chatMsgs';
    msgs.appendChild(el('div', 'cw-hint', 'This is the start of your chat with ' + name + '.'));
    w.appendChild(msgs);
    var form = el('form', 'cw-form');
    var inp = el('input'); inp.placeholder = 'Message ' + name; inp.maxLength = 500; inp.autocomplete = 'off';
    form.appendChild(inp);
    var send = el('button', 'cw-send', '➤'); send.type = 'submit'; form.appendChild(send);
    form.onsubmit = function (e) {
      e.preventDefault(); var text = inp.value; if (!text.trim()) return;
      inp.value = '';
      api('POST', '/api/messages', { to: name, text: text }).then(function (r) { addMsgs([r.message]); }, function (e2) { toast(e2.message); inp.value = text; });
    };
    w.appendChild(form);
    setTimeout(function () { inp.focus(); }, 30);
    pollChat();
    render();
  }
  function addMsgs(list) {
    var box = $('#chatMsgs'); if (!box || !chat) return;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    list.forEach(function (m) {
      if (m.id <= chat.lastId) return;
      chat.lastId = m.id;
      var prev = box.lastElementChild, grouped = prev && prev.dataset.from === m.from && m.at - (+prev.dataset.at) < 5 * 60e3;
      var row = el('div', 'cw-msg' + (m.mine ? ' mine' : '') + (grouped ? ' grouped' : ''));
      row.dataset.from = m.from; row.dataset.at = m.at;
      if (!grouped) {
        var h = el('div', 'cw-mh'); h.appendChild(el('b', null, m.from));
        h.appendChild(el('small', null, new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
        row.appendChild(h);
      }
      row.appendChild(el('div', 'cw-text', m.text));
      box.appendChild(row);
    });
    if (nearBottom || list.some(function (m) { return m.mine; })) box.scrollTop = box.scrollHeight;
  }
  function pollChat() {
    if (!chat) return;
    var name = chat.name;
    api('GET', '/api/messages?with=' + encodeURIComponent(name) + '&after=' + chat.lastId).then(function (r) {
      if (!chat || chat.name !== name) return;
      addMsgs(r.messages);
      lastUnread[name] = 0;
      var f = friend(name); if (f && f.unread) { f.unread = 0; render(); }
      var st = $('#chatState'); if (st && f) { st.textContent = stateText(f); st.className = 'st-' + f.state; }
    }, function (e) { if (e.status === 403) { toast(e.message); closeChat(); } }).then(function () {
      if (chat && chat.name === name) chat.timer = setTimeout(pollChat, 3000);
    });
  }
  function closeChat() {
    if (chat && chat.timer) clearTimeout(chat.timer);
    chat = null;
    var w = $('#chatWin'); if (w) { w.classList.remove('open'); w.textContent = ''; }
    render();
  }

  /* ---------- users page ---------- */
  var usersState = { q: '', sort: 'new', page: 0, list: [], pages: 1, loading: false, seq: 0 };
  function loadUsers(reset) {
    var grid = $('#usersGrid'); if (!grid) return;
    if (!eng()) {
      grid.textContent = ''; $('#usersMore').style.display = 'none'; $('#usersTitle').textContent = 'Players';
      var e = el('div', 'fp-empty');
      e.appendChild(el('p', null, ctx.getEngine() ? 'Sign in to see everyone on Mist and add friends.' : 'The players list needs a save server. Set one in Settings.'));
      var b = el('button', 'btn green', ctx.getEngine() ? 'Sign in' : 'Open settings'); b.onclick = ctx.openAccount;
      e.appendChild(b); grid.appendChild(e); return;
    }
    if (reset) { usersState.page = 0; usersState.list = []; }
    var seq = ++usersState.seq; usersState.loading = true;
    if (reset) { grid.textContent = ''; grid.appendChild(el('div', 'fp-empty', 'Loading players…')); }
    api('GET', '/api/users?q=' + encodeURIComponent(usersState.q) + '&sort=' + usersState.sort + '&page=' + usersState.page).then(function (r) {
      if (seq !== usersState.seq) return;
      usersState.loading = false; usersState.pages = r.pages;
      usersState.list = usersState.list.concat(r.users);
      $('#usersTitle').textContent = usersState.q ? r.matches + ' of ' + r.total + ' players' : 'Players (' + r.total + ')';
      renderUsers();
    }, function (e) { usersState.loading = false; grid.textContent = ''; grid.appendChild(el('div', 'fp-empty', e.message)); });
  }
  function relationButton(u) {
    if (u.relation === 'me') { var me = el('span', 'u-rel', 'You'); return me; }
    if (u.relation === 'friend') { var m = el('button', 'btn', 'Message'); m.onclick = function (e) { e.stopPropagation(); openChat(u.name); }; return m; }
    if (u.relation === 'requested') return el('span', 'u-rel', 'Request sent');
    var b = el('button', 'btn green', u.relation === 'requestedYou' ? 'Accept' : 'Add friend');
    b.onclick = function (e) {
      e.stopPropagation(); b.disabled = true;
      api('POST', u.relation === 'requestedYou' ? '/api/friends/accept' : '/api/friends/request', { username: u.name }).then(function (r) {
        var nowFriends = u.relation === 'requestedYou' || (r && r.accepted);
        u.relation = nowFriends ? 'friend' : 'requested';
        toast(nowFriends ? 'You and ' + u.name + ' are now friends' : 'Friend request sent to ' + u.name);
        renderUsers(); refresh();
      }, function (e2) { b.disabled = false; toast(e2.message); });
    };
    return b;
  }
  function renderUsers() {
    var grid = $('#usersGrid'); grid.textContent = '';
    if (!usersState.list.length) { grid.appendChild(el('div', 'fp-empty', usersState.q ? 'No players match “' + usersState.q + '”.' : 'No players yet.')); }
    usersState.list.forEach(function (u) {
      var c = el('div', 'ucard' + (u.relation === 'me' ? ' me' : ''));
      c.appendChild(avatar(u.name, 64, u.state || null));
      var t = el('div', 'u-t');
      var un = el('b', null, u.name); if (typeof u.level === 'number') un.insertBefore(levelBadge(u.level, 20), un.firstChild); t.appendChild(un);
      if (u.state) t.appendChild(el('small', 'st-' + u.state, stateText(u)));
      t.appendChild(el('small', null, 'Joined ' + new Date(u.created).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) + ' · ' + u.friendCount + ' friend' + (u.friendCount === 1 ? '' : 's')));
      if (u.achievements !== undefined) t.appendChild(el('small', 'u-ach', '🏆 ' + u.achievements + ' · ' + fmtTime(u.playtime) + ' played'));
      c.appendChild(t);
      c.appendChild(relationButton(u));
      c.onclick = function () { openProfile(u.name); };
      grid.appendChild(c);
    });
    $('#usersMore').style.display = usersState.page + 1 < usersState.pages ? '' : 'none';
  }
  function wireUsers() {
    var t;
    $('#usersSearch').oninput = function () { var v = this.value.trim(); clearTimeout(t); t = setTimeout(function () { usersState.q = v; loadUsers(true); }, 250); };
    $('#usersSort').onchange = function () { usersState.sort = this.value; loadUsers(true); };
    $('#usersMore').onclick = function () { if (usersState.loading) return; usersState.page++; loadUsers(false); };
  }


  /* ---------- Social page: Friends · Activity · Forums · Players ---------- */
  var socState = { tab: 'friends', forum: { view: 'home', cat: null, id: null, page: 0, q: '' } };
  var SOC_TABS = [['friends', '👥 Friends'], ['activity', '📰 Activity'], ['forums', '💬 Forums'], ['clips', '🎬 Clips'], ['players', '🔎 Players']];
  function socialActive() { var pg = document.getElementById('page-social'); return !!pg && pg.classList.contains('active'); }
  function renderSocial(tab) {
    if (tab) socState.tab = tab;
    var tabs = $('#socTabs'); if (!tabs) return;
    tabs.textContent = '';
    SOC_TABS.forEach(function (t) {
      var b = el('button', 'soc-tab' + (socState.tab === t[0] ? ' on' : ''), t[1]);
      if (t[0] === 'friends' && data) {
        var n = data.incoming.length + data.friends.reduce(function (a, f) { return a + (f.unread || 0); }, 0);
        if (n) b.appendChild(el('span', 'fb-badge', String(n)));
      }
      b.onclick = function () { if (t[0] === 'forums' && socState.tab === 'forums') socState.forum = { view: 'home', page: 0, q: '' }; renderSocial(t[0]); };
      tabs.appendChild(b);
    });
    ['friends', 'activity', 'forums', 'clips', 'players'].forEach(function (k) {
      var pane = document.getElementById('soc' + k.charAt(0).toUpperCase() + k.slice(1));
      if (pane) pane.style.display = socState.tab === k ? '' : 'none';
    });
    if (socState.tab === 'friends') { drawFriends($('#socFriends')); refresh(); }
    else if (socState.tab === 'activity') drawActivity($('#socActivity'));
    else if (socState.tab === 'forums') drawForums($('#socForums'));
    else if (socState.tab === 'clips') { if (ctx.renderClips) ctx.renderClips($('#socClips')); }
    else if (socState.tab === 'players') loadUsers(true);
  }
  function needSignIn(host, what) {
    host.textContent = '';
    var e = el('div', 'fp-empty');
    e.appendChild(el('p', null, ctx.getEngine() ? 'Sign in to ' + what + '.' : 'This needs a save server. Set one in Settings.'));
    var b = el('button', 'btn green', ctx.getEngine() ? 'Sign in' : 'Open settings'); b.onclick = ctx.openAccount;
    e.appendChild(b); host.appendChild(e);
  }

  /* activity */
  function drawActivity(host) {
    if (!eng()) return needSignIn(host, 'see what you and your friends have been up to');
    host.textContent = ''; host.appendChild(el('div', 'fp-empty', 'Loading…'));
    api('GET', '/api/activity').then(function (r) {
      host.textContent = '';
      host.appendChild(el('h2', 'soc-h', 'Recent activity'));
      host.appendChild(el('p', 'soc-sub', 'You and your friends over the last 30 days.'));
      if (!r.events.length) { host.appendChild(el('div', 'fp-empty', 'Nothing yet. Play some games or add friends and their activity shows up here.')); return; }
      var list = el('div', 'act-list');
      r.events.forEach(function (e) {
        var row = el('div', 'act-row');
        var av = avatar(e.who, 40); av.style.cursor = 'pointer'; av.onclick = function () { openProfile(e.who); }; row.appendChild(av);
        var t = el('div', 'act-t'), line = el('div');
        var who = el('b', 'act-who', e.who); who.onclick = function () { openProfile(e.who); }; line.appendChild(who);
        if (e.type === 'ach') { line.appendChild(document.createTextNode(' unlocked ')); line.appendChild(el('span', 'act-ach r-' + (e.rank || 'common'), e.icon + ' ' + e.name)); }
        else if (e.type === 'gameach') { line.appendChild(document.createTextNode(' earned ')); line.appendChild(el('span', 'act-ach r-' + (e.rank || 'common'), e.icon + ' ' + e.name)); line.appendChild(document.createTextNode(' in ')); line.appendChild(gameLink(e.game)); }
        else if (e.type === 'play') { line.appendChild(document.createTextNode(' played ')); line.appendChild(gameLink(e.game)); }
        else if (e.type === 'joined') line.appendChild(document.createTextNode(' joined Mist 🎉'));
        else if (e.type === 'thread') {
          line.appendChild(document.createTextNode(' started a thread '));
          var a = el('a', 'act-link', '“' + e.title + '”'); a.onclick = function () { openThread(e.id); }; line.appendChild(a);
        }
        t.appendChild(line); t.appendChild(el('small', null, ago(e.at)));
        row.appendChild(t); list.appendChild(row);
      });
      host.appendChild(list);
    }, function (e) { host.textContent = ''; host.appendChild(el('div', 'fp-empty', e.message)); });
  }
  function gameLink(name) {
    var g = ctx.gameByName && ctx.gameByName(name);
    var a = el(g ? 'a' : 'b', g ? 'act-link' : null, name);
    if (g) a.onclick = function () { ctx.showGame(g); };
    return a;
  }

  /* forums */
  var forumCats = null;
  function openThread(id) { socState.forum = { view: 'thread', id: id, page: 0, q: '' }; renderSocial('forums'); }
  function drawForums(host) {
    if (!eng()) return needSignIn(host, 'read and post in the forums');
    var f = socState.forum;
    host.textContent = ''; host.appendChild(el('div', 'fp-empty', 'Loading…'));
    if (f.view === 'thread') return drawThread(host, f.id);
    if (f.view === 'cat' || f.q) return drawThreadList(host);
    api('GET', '/api/forums').then(function (r) {
      forumCats = r.cats; host.textContent = '';
      var head = el('div', 'fo-head'); head.appendChild(el('h2', 'soc-h', 'Forums'));
      var q = el('input', 'store-search fo-search'); q.placeholder = 'search threads';
      q.onkeydown = function (e) { if (e.key === 'Enter' && q.value.trim()) { socState.forum = { view: 'cat', cat: null, page: 0, q: q.value.trim() }; drawForums(host); } };
      head.appendChild(q);
      head.appendChild(ctx.button('green', '＋ New thread', null, function () { openNewThread(null); }));
      host.appendChild(head);
      var list = el('div', 'fo-cats');
      r.cats.forEach(function (c) {
        var row = el('div', 'fo-cat');
        row.appendChild(el('div', 'fo-ic', c.icon));
        var t = el('div', 'fo-ct'); t.appendChild(el('b', null, c.name)); t.appendChild(el('small', null, c.desc)); row.appendChild(t);
        row.appendChild(el('div', 'fo-n', c.threads + ' thread' + (c.threads === 1 ? '' : 's') + '\n' + c.posts + ' post' + (c.posts === 1 ? '' : 's')));
        var last = el('div', 'fo-last');
        if (c.latest) {
          var a = el('a', 'act-link', c.latest.title); a.onclick = function (e) { e.stopPropagation(); openThread(c.latest.id); };
          last.appendChild(a); last.appendChild(el('small', null, 'by ' + c.latest.lastBy + ' · ' + ago(c.latest.last)));
        } else last.appendChild(el('small', null, 'No threads yet'));
        row.appendChild(last);
        row.onclick = function () { socState.forum = { view: 'cat', cat: c.id, page: 0, q: '' }; drawForums(host); };
        list.appendChild(row);
      });
      host.appendChild(list);
    }, function (e) { host.textContent = ''; host.appendChild(el('div', 'fp-empty', e.message)); });
  }
  function catOf(id) { return (forumCats || []).filter(function (c) { return c.id === id; })[0] || { id: id, name: 'Forums', icon: '💬' }; }
  function backBtn(label, fn) { var b = el('button', 'fo-back', '‹ ' + label); b.onclick = fn; return b; }
  function drawThreadList(host) {
    var f = socState.forum;
    var load = forumCats ? Promise.resolve() : api('GET', '/api/forums').then(function (r) { forumCats = r.cats; });
    load.then(function () {
      return api('GET', '/api/forums/threads?cat=' + encodeURIComponent(f.cat || '') + '&q=' + encodeURIComponent(f.q || '') + '&page=' + f.page);
    }).then(function (r) {
      host.textContent = '';
      host.appendChild(backBtn('All forums', function () { socState.forum = { view: 'home', page: 0, q: '' }; drawForums(host); }));
      var c = f.cat ? catOf(f.cat) : null;
      var head = el('div', 'fo-head'); head.appendChild(el('h2', 'soc-h', c ? c.icon + ' ' + c.name : 'Search: “' + f.q + '”'));
      if (!c || !c.adminOnly || r.admin) head.appendChild(ctx.button('green', '＋ New thread', null, function () { openNewThread(f.cat); }));
      host.appendChild(head);
      if (!r.threads.length) { host.appendChild(el('div', 'fp-empty', f.q ? 'No threads match.' : 'No threads here yet. Start the first one!')); return; }
      var list = el('div', 'fo-threads');
      r.threads.forEach(function (t) {
        var row = el('div', 'fo-thread' + (t.pinned ? ' pinned' : ''));
        row.appendChild(avatar(t.author, 36));
        var tt = el('div', 'fo-tt');
        var title = el('b', null, (t.pinned ? '📌 ' : '') + (t.locked ? '🔒 ' : '') + t.title); tt.appendChild(title);
        tt.appendChild(el('small', null, 'by ' + t.author + ' · ' + ago(t.at) + (c ? '' : ' · ' + catOf(t.cat).name)));
        row.appendChild(tt);
        row.appendChild(el('div', 'fo-n', t.replies + ' repl' + (t.replies === 1 ? 'y' : 'ies')));
        var last = el('div', 'fo-last'); last.appendChild(el('small', null, 'Last: ' + t.lastBy)); last.appendChild(el('small', null, ago(t.last))); row.appendChild(last);
        row.onclick = function () { openThread(t.id); };
        list.appendChild(row);
      });
      host.appendChild(list);
      if (r.pages > 1) {
        var pg = el('div', 'fo-pager');
        if (f.page > 0) pg.appendChild(ctx.button('', '‹ Newer', null, function () { f.page--; drawForums(host); }));
        pg.appendChild(el('span', null, 'Page ' + (f.page + 1) + ' of ' + r.pages));
        if (f.page + 1 < r.pages) pg.appendChild(ctx.button('', 'Older ›', null, function () { f.page++; drawForums(host); }));
        host.appendChild(pg);
      }
    }).catch(function (e) { host.textContent = ''; host.appendChild(el('div', 'fp-empty', e.message)); });
  }
  function drawThread(host, id) {
    api('GET', '/api/forums/thread?id=' + encodeURIComponent(id)).then(function (r) {
      var t = r.thread; host.textContent = '';
      if (!forumCats) api('GET', '/api/forums').then(function (x) { forumCats = x.cats; }, function () {});
      host.appendChild(backBtn(catOf(t.cat).name, function () { socState.forum = { view: 'cat', cat: t.cat, page: 0, q: '' }; drawForums(host); }));
      var head = el('div', 'fo-head');
      head.appendChild(el('h2', 'soc-h', (t.pinned ? '📌 ' : '') + (t.locked ? '🔒 ' : '') + t.title));
      if (r.admin) {
        var mod = el('div', 'fo-mod');
        function m(label, patch) { mod.appendChild(ctx.button('ghost', label, null, function () {
          api('POST', '/api/forums/mod', Object.assign({ thread: t.id }, patch)).then(function () { drawThread(host, id); }, function (e) { toast(e.message); });
        })); }
        m(t.pinned ? 'Unpin' : '📌 Pin', { pinned: !t.pinned });
        m(t.locked ? 'Unlock' : '🔒 Lock', { locked: !t.locked });
        head.appendChild(mod);
      }
      host.appendChild(head);
      var list = el('div', 'fo-posts');
      r.posts.forEach(function (p, i) {
        var post = el('div', 'fo-post' + (i === 0 ? ' op' : ''));
        var side = el('div', 'fo-pside'); var av = avatar(p.author, 48); av.onclick = function () { openProfile(p.author); }; side.appendChild(av);
        var nm = el('b', 'act-who', p.author); nm.onclick = function () { openProfile(p.author); }; side.appendChild(nm);
        post.appendChild(side);
        var main = el('div', 'fo-pmain');
        main.appendChild(el('small', 'fo-pmeta', ago(p.at) + (p.edited ? ' · edited' : '') + (i === 0 ? ' · original post' : '')));
        var txt = el('div', 'fo-text', p.text); main.appendChild(txt);
        var bar = el('div', 'fo-pbar');
        var like = el('button', 'fo-like' + (p.liked ? ' on' : ''), (p.liked ? '♥ ' : '♡ ') + p.likes);
        like.onclick = function () {
          api('POST', '/api/forums/like', { thread: t.id, post: p.id }).then(function (x) { p.liked = x.liked; p.likes = x.likes; like.className = 'fo-like' + (x.liked ? ' on' : ''); like.textContent = (x.liked ? '♥ ' : '♡ ') + x.likes; }, function (e) { toast(e.message); });
        };
        bar.appendChild(like);
        if (!t.locked || r.admin) { var q = el('button', 'fo-act', 'Quote'); q.onclick = function () { var ta = $('#foReply'); if (ta) { ta.value += (ta.value ? '\n' : '') + p.text.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n— ' + p.author + '\n\n'; ta.focus(); } }; bar.appendChild(q); }
        if (p.mine) {
          var ed = el('button', 'fo-act', 'Edit');
          ed.onclick = function () {
            var ta = el('textarea', 'adm-ta fo-ta'); ta.value = p.text; ta.maxLength = 4000;
            main.replaceChild(ta, txt); ed.style.display = 'none';
            var sv = ctx.button('green', 'Save', null, function () {
              api('POST', '/api/forums/edit', { thread: t.id, post: p.id, text: ta.value }).then(function () { drawThread(host, id); }, function (e) { toast(e.message); });
            });
            bar.appendChild(sv); ta.focus();
          };
          bar.appendChild(ed);
        }
        if (p.mine || r.admin) {
          var del = el('button', 'fo-act danger', i === 0 ? 'Delete thread' : 'Delete');
          del.onclick = function () {
            if (!confirm(i === 0 ? 'Delete this whole thread and all its replies?' : 'Delete this post?')) return;
            api('POST', '/api/forums/delete', { thread: t.id, post: p.id }).then(function (x) {
              toast(x.threadDeleted ? 'Thread deleted' : 'Post deleted');
              if (x.threadDeleted) { socState.forum = { view: 'cat', cat: t.cat, page: 0, q: '' }; drawForums(host); } else drawThread(host, id);
            }, function (e) { toast(e.message); });
          };
          bar.appendChild(del);
        }
        main.appendChild(bar); post.appendChild(main); list.appendChild(post);
      });
      host.appendChild(list);
      if (t.locked && !r.admin) { host.appendChild(el('div', 'fp-empty', '🔒 This thread is locked. No new replies.')); return; }
      var rep = el('div', 'fo-reply');
      rep.appendChild(el('h4', null, 'Reply'));
      var ta = el('textarea', 'adm-ta fo-ta'); ta.id = 'foReply'; ta.maxLength = 4000; ta.placeholder = 'Write a reply…'; rep.appendChild(ta);
      var go = ctx.button('green', 'Post reply', null, function () {
        if (!ta.value.trim()) return; go.disabled = true;
        api('POST', '/api/forums/reply', { thread: t.id, text: ta.value }).then(function () { drawThread(host, id); }, function (e) { toast(e.message); go.disabled = false; });
      });
      rep.appendChild(go); host.appendChild(rep);
    }, function (e) {
      host.textContent = ''; host.appendChild(backBtn('All forums', function () { socState.forum = { view: 'home', page: 0, q: '' }; drawForums(host); }));
      host.appendChild(el('div', 'fp-empty', e.message));
    });
  }
  function openNewThread(cat) {
    var load = forumCats ? Promise.resolve() : api('GET', '/api/forums').then(function (r) { forumCats = r.cats; });
    load.then(function () {
      return api('GET', '/api/forums/threads?cat=&page=0').then(function (r) { return r.admin; });
    }).then(function (admin) {
      ctx.openModal(function (box) {
        box.classList.add('adm-box');
        box.appendChild(el('h3', null, 'New thread'));
        var sel = el('select', 'adm-sel fo-sel');
        forumCats.forEach(function (c) { if (c.adminOnly && !admin) return; var o = el('option', null, c.icon + ' ' + c.name); o.value = c.id; if (c.id === cat) o.selected = true; sel.appendChild(o); });
        if (!cat || !Array.prototype.some.call(sel.options, function (o) { return o.selected; })) { var gen = Array.prototype.filter.call(sel.options, function (o) { return o.value === 'general'; })[0]; if (gen) gen.selected = true; }
        box.appendChild(sel);
        var title = el('input', 'adm-q'); title.placeholder = 'Title'; title.maxLength = 80; box.appendChild(title);
        var ta = el('textarea', 'adm-ta fo-ta'); ta.placeholder = 'What do you want to say?'; ta.maxLength = 4000; box.appendChild(ta);
        var err = el('p', 'm-err'); box.appendChild(err);
        var a = el('div', 'm-actions');
        a.appendChild(ctx.button('ghost', 'Cancel', null, ctx.closeModal));
        var go = ctx.button('green', 'Post thread', null, function () {
          go.disabled = true; err.textContent = '';
          api('POST', '/api/forums/thread', { cat: sel.value, title: title.value, text: ta.value }).then(function (r) {
            ctx.closeModal(); toast('Thread posted'); openThread(r.id);
          }, function (e) { err.textContent = e.message; go.disabled = false; });
        });
        a.appendChild(go); box.appendChild(a);
        setTimeout(function () { title.focus(); }, 30);
      });
    }, function (e) { toast(e.message); });
  }

  /* ---------- in-game Mist overlay: you, friends, chat ---------- */
  var ovHost = null, ovGame = null;
  function overlayMe(host) {
    host.textContent = '';
    if (!eng()) {
      host.appendChild(el('p', 'mo-note', ctx.getEngine() ? 'Sign in to see friends, chat and track achievements.' : 'Friends and achievements need a save server (Settings).'));
      var b = el('button', 'btn green', ctx.getEngine() ? 'Sign in' : 'Open settings'); b.onclick = ctx.openAccount; host.appendChild(b);
      return;
    }
    var me = el('div', 'mo-me'); me.appendChild(avatar(eng().user, 48, 'ingame'));
    var t = el('div', 'fp-t'); t.appendChild(el('b', null, eng().user)); t.appendChild(el('small', 'st-ingame', playing ? 'Playing ' + playing : 'Online'));
    me.appendChild(t); host.appendChild(me);
    if (myLevel) host.appendChild(levelBar(myLevel));
    else api('GET', '/api/profile?name=' + encodeURIComponent(eng().user)).then(function (pr) {
      if (pr && pr.level && typeof pr.level.level === 'number') { myLevel = pr.level; if (host.isConnected) host.appendChild(levelBar(myLevel)); }
    }, function () {});
  }
  function overlayFriends(host, game) { ovHost = host; ovGame = game; drawOvFriends(); if (eng()) refresh(); }
  function drawOvFriends() {
    var host = ovHost; if (!host || !host.isConnected) { ovHost = null; return; }
    host.textContent = '';
    var head = el('div', 'mo-h'); head.appendChild(el('h5', null, 'Friends'));
    if (eng()) { var add = el('button', 'mini', '＋'); add.title = 'Add a friend'; add.onclick = openAddFriend; head.appendChild(add); }
    host.appendChild(head);
    if (!eng()) { host.appendChild(el('div', 'fp-empty', 'Sign in to see your friends.')); return; }
    if (!data) { host.appendChild(el('div', 'fp-empty', 'Loading…')); return; }
    var list = el('div', 'mo-list');
    data.incoming.forEach(function (n) {
      var r = el('div', 'fp-row req'); r.appendChild(avatar(n, 32));
      var t = el('div', 'fp-t'); t.appendChild(el('b', null, n)); t.appendChild(el('small', null, 'wants to be friends')); r.appendChild(t);
      var ok = el('button', 'mini ok', '✓'); ok.title = 'Accept';
      ok.onclick = function () { api('POST', '/api/friends/accept', { username: n }).then(function () { toast('You and ' + n + ' are now friends'); refresh(); }, function (e) { toast(e.message); }); };
      var no = el('button', 'mini', '✕'); no.title = 'Decline';
      no.onclick = function () { api('POST', '/api/friends/decline', { username: n }).then(refresh); };
      r.appendChild(ok); r.appendChild(no); list.appendChild(r);
    });
    var order = { ingame: 0, online: 1, offline: 2 };
    var fs = data.friends.slice().sort(function (a, b) {
      var sa = a.state === 'ingame' && a.game === ovGame ? -1 : order[a.state], sb = b.state === 'ingame' && b.game === ovGame ? -1 : order[b.state];
      return sa - sb || a.name.localeCompare(b.name);
    });
    fs.forEach(function (f) {
      var r = el('button', 'fp-row st-' + f.state + (chat && chat.name === f.name ? ' sel' : ''));
      r.appendChild(avatar(f.name, 32, f.state));
      var t = el('div', 'fp-t'); t.appendChild(el('b', null, f.name));
      t.appendChild(el('small', 'st-' + f.state, f.state === 'ingame' && f.game === ovGame ? 'Playing this game too' : stateText(f))); r.appendChild(t);
      if (f.unread) r.appendChild(el('span', 'fb-badge', String(f.unread)));
      r.appendChild(el('span', 'mo-chat', '💬'));
      r.onclick = function () { openChat(f.name); };
      list.appendChild(r);
    });
    if (!fs.length && !data.incoming.length) {
      var em = el('div', 'fp-empty'); em.appendChild(el('p', null, 'No friends yet.'));
      var ab = el('button', 'btn green', 'Add a friend'); ab.onclick = openAddFriend; em.appendChild(ab); list.appendChild(em);
    }
    host.appendChild(list);
  }

  /* ---------- Mist Supporter ($5/month through PayPal) ---------- */
  var supportInfo = null;
  function loadSupport() { if (!eng()) return Promise.resolve(null); return api('GET', '/api/support').then(function (r) { supportInfo = r; return r; }, function () { return null; }); }
  function perksList() {
    var ul = el('ul', 'sup-perks');
    [['🟡', 'Gold outline on your avatar everywhere in Mist'], ['🎨', PLUS_AVATARS.length + ' extra supporter-only avatars (twice as many)'],
     ['💛', 'Mist Supporter achievement: +2,500 XP while you’re subscribed'], ['🚀', 'Helps keep the Mist server running']].forEach(function (p) {
      var li = el('li'); li.appendChild(el('span', null, p[0])); li.appendChild(el('span', null, p[1])); ul.appendChild(li);
    });
    return ul;
  }
  function fmtDay(t) { return new Date(t).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); }
  function openSupport(fromLaunch) {
    ctx.openModal(function (box) {
      box.classList.add('sup-box');
      box.appendChild(el('div', 'sup-heart', '💛'));
      box.appendChild(el('h3', null, 'Support Mist'));
      var body = el('div'); box.appendChild(body);
      function draw(info) {
        body.textContent = '';
        if (info && info.supporter) {
          body.appendChild(el('p', 'sup-lead', 'You’re a Mist Supporter. Thank you!'));
          body.appendChild(perksList());
          if (info.paidThrough) body.appendChild(el('p', 'sup-small', (info.status === 'ACTIVE' ? 'Renews monthly. Paid through ' : 'Cancelled. Perks last until ') + fmtDay(info.paidThrough) + '.'));
          var a = el('div', 'm-actions');
          var man = ctx.button('ghost', 'Manage or cancel in PayPal', null, function () { window.open(info.manage, '_blank'); });
          a.appendChild(man); a.appendChild(ctx.button('green', 'Close', null, ctx.closeModal)); body.appendChild(a);
          return;
        }
        body.appendChild(el('p', 'sup-lead', (fromLaunch ? 'Enjoying Mist? ' : '') + 'Become a supporter for ' + ((info && info.price) || '$5/month') + '.'));
        body.appendChild(perksList());
        var err = el('p', 'm-err'); var acts = el('div', 'm-actions');
        acts.appendChild(ctx.button('ghost', fromLaunch ? 'Not now' : 'Close', null, ctx.closeModal));
        if (!eng()) {
          acts.appendChild(ctx.button('green', 'Sign in first', null, function () { ctx.closeModal(); ctx.openAccount(); }));
        } else if (info && !info.enabled) {
          err.textContent = 'Supporter subscriptions aren’t switched on for this server yet.';
        } else {
          var go = ctx.button('green', 'Subscribe with PayPal', null, function () {
            go.disabled = true; err.textContent = '';
            // open the tab right away (popup blockers), then point it at PayPal
            var w = null; try { w = window.open('', '_blank'); } catch (e) {}
            api('POST', '/api/support/subscribe').then(function (r) {
              if (w) { try { w.location.href = r.url; } catch (e) { w = null; } }
              if (!w) window.open(r.url, '_blank');
              waiting();
            }, function (e) { if (w) try { w.close(); } catch (x) {} err.textContent = e.message; go.disabled = false; });
          });
          acts.appendChild(go);
        }
        body.appendChild(err); body.appendChild(acts);
        body.appendChild(el('p', 'sup-small', 'Paid monthly through PayPal. Cancel any time in PayPal; perks last until the end of the month you paid for.'));
      }
      var poll = null;
      function check(quiet) {
        return api('POST', '/api/support/check').then(function (r) {
          supportInfo = r; handleUnlocks(r);
          if (r.supporter) { clearInterval(poll); window.removeEventListener('focus', onFocus); refresh(); if (ctx.onLooks) ctx.onLooks(); draw(r); toast('Thank you for supporting Mist! 💛'); }
          else if (!quiet) toast('PayPal hasn’t confirmed it yet. Finish in the PayPal tab, then try again.');
        }, function (e) { if (!quiet) toast(e.message); });
      }
      function onFocus() { check(true); }
      function waiting() {
        body.textContent = '';
        body.appendChild(el('p', 'sup-lead', 'Finish subscribing in the PayPal tab.'));
        body.appendChild(el('p', 'sup-small', 'When you’re done, come back here. Your perks turn on automatically.'));
        var a = el('div', 'm-actions');
        a.appendChild(ctx.button('ghost', 'Cancel', null, function () { clearInterval(poll); window.removeEventListener('focus', onFocus); ctx.closeModal(); }));
        a.appendChild(ctx.button('green', 'I’ve subscribed', null, function () { check(false); }));
        body.appendChild(a);
        clearInterval(poll); var n = 0; poll = setInterval(function () { if (++n > 60 || !document.body.contains(body)) { clearInterval(poll); return; } check(true); }, 5000);
        window.addEventListener('focus', onFocus);
      }
      body.appendChild(el('div', 'fp-empty', 'Loading…'));
      loadSupport().then(function (info) { draw(info || { enabled: true, price: '$5/month' }); });
    });
  }
  /* Ask now and then when a game starts (every 5th launch), never for supporters. */
  function maybeAskSupport() {
    var n = (+ctx.storeGet('launches', 0) || 0) + 1; ctx.storeSet('launches', n);
    if (n % 5) return;
    var lk = eng() && looks[eng().user.toLowerCase()];
    if (lk && lk.s) return;
    (eng() ? loadSupport() : Promise.resolve(null)).then(function (info) {
      if (info && (info.supporter || !info.enabled)) return;
      setTimeout(function () { openSupport(true); }, 1200);
    });
  }

  function friendsWhoPlay(gameName) {
    if (!data) return [];
    return data.friends.filter(function (f) { return (f.state === 'ingame' && f.game === gameName) || (f.recent || []).indexOf(gameName) >= 0; });
  }

  return {
    loadUsers: loadUsers, wireUsers: wireUsers, renderProfile: renderProfile, renderGameAch: renderGameAch, renderAchPage: renderAchPage,
    showAchievements: showAchievements, lookKey: lookKey, renderLeaderboard: renderLeaderboard, handleUnlocks: handleUnlocks, levelBadge: levelBadge, hookDefs: function () { return hookDefs; },
    overlayMe: overlayMe, overlayFriends: overlayFriends, closeChat: closeChat,
    openSupport: openSupport, maybeAskSupport: maybeAskSupport, renderSocial: renderSocial, openThread: openThread,
    start: start, refresh: refresh, onAuthChange: onAuthChange, setPlaying: setPlaying, togglePanel: togglePanel,
    openProfile: openProfile, openAddFriend: openAddFriend, friendsWhoPlay: friendsWhoPlay, avatar: avatar, stateText: stateText,
    data: function () { return data; }
  };
};

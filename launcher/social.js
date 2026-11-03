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
  function api(method, path, json) { var e = eng(); return e ? e.api(method, path, json ? { json: json } : {}) : Promise.reject(new Error('Sign in first.')); }

  /* ---------- avatars: 5x5 mirrored pixel face from the name ---------- */
  function hash(s) { var h = 2166136261; s = String(s).toLowerCase(); for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; }
  function avatar(name, size, state) {
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
    var t = el('div', 'ach-toast');
    t.appendChild(el('span', 'ach-ico', a.icon));
    var tx = el('div', 'ach-tx'); tx.appendChild(el('small', null, 'Achievement unlocked')); tx.appendChild(el('b', null, a.name)); tx.appendChild(el('span', null, a.desc));
    t.appendChild(tx); host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); nextAch(); }, 350); }, 4500);
  }

  /* ---------- presence ---------- */
  function beat() {
    if (!eng()) return;
    api('POST', '/api/presence', playing ? { state: 'ingame', game: playing } : { state: 'online' })
      .then(function (r) { showAchievements(r && r.newAchievements); }, function () {});
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
      showAchievements(d.newAchievements);
      data = d; render();
    }).catch(function () {});
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { refresh().then(schedule); }, panelOpen ? 8000 : 20000);
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
    seenIncoming = null; lastUnread = {};
    if (document.getElementById('page-users') && document.getElementById('page-users').classList.contains('active')) setTimeout(function () { loadUsers(true); }, 0);
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
    b.classList.toggle('on', panelOpen);
  }

  /* ---------- friends panel ---------- */
  function togglePanel(force) { panelOpen = force === undefined ? !panelOpen : force; render(); if (panelOpen) refresh(); schedule(); }
  function render() {
    renderButton();
    if (chat) { var cf = friend(chat.name), cst = $('#chatState');
      if (cf && cst) { cst.textContent = stateText(cf); cst.className = 'st-' + cf.state; } }
    var p = $('#friendsPanel'); if (!p) return;
    p.classList.toggle('open', panelOpen);
    if (!panelOpen) return;
    p.textContent = '';
    var head = el('div', 'fp-head');
    if (!eng()) {
      head.appendChild(el('b', null, 'Friends'));
      p.appendChild(head);
      var e = el('div', 'fp-empty');
      e.appendChild(el('p', null, ctx.getEngine() ? 'Sign in to add friends, see what they’re playing and chat.' : 'Friends need a save server. Set one in Settings.'));
      var b = el('button', 'btn green', ctx.getEngine() ? 'Sign in' : 'Open settings');
      b.onclick = function () { togglePanel(false); ctx.openAccount(); };
      e.appendChild(b); p.appendChild(e); return;
    }
    var me = el('button', 'fp-me');
    me.appendChild(avatar(eng().user, 40, playing ? 'ingame' : 'online'));
    var mt = el('span', 'fp-me-t'); mt.appendChild(el('b', null, eng().user));
    mt.appendChild(el('small', 'st-' + (playing ? 'ingame' : 'online'), playing ? 'Playing ' + playing : 'Online'));
    me.appendChild(mt); me.onclick = function () { openProfile(eng().user); };
    head.appendChild(me);
    var add = el('button', 'fp-add', '＋'); add.title = 'Add a friend'; add.onclick = openAddFriend;
    var x = el('button', 'fp-x', '✕'); x.title = 'Close'; x.onclick = function () { togglePanel(false); };
    head.appendChild(add); head.appendChild(x);
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
    for (var i = 0; i < units.length; i++) if (id.indexOf(units[i][0]) === 0) return a.goal + ' ' + (a.goal === 1 ? units[i][1] : units[i][2]);
    return String(a.goal);
  }
  function oldServerNote() {
    var n = el('div', 'old-server');
    n.appendChild(el('b', null, 'Your Mist server needs updating.'));
    n.appendChild(el('span', null, ' Game achievements and totals need the newest server.js. On the server: git pull, copy server/server.js to /opt/eaglercraft-saves/, then restart the service.'));
    return n;
  }

  /* ---------- per-game achievements (10 per game) ---------- */
  var GAME_TIERS = [['m5','🌱','First Look','5 minutes',300],['m15','🎈','Warming Up','15 minutes',900],['m30','🎯','Getting the Hang','30 minutes',1800],
    ['h1','🪝','Hooked','1 hour',3600],['h2','🎮','Regular','2 hours',7200],['h5','💪','Dedicated','5 hours',18000],['h10','🛡️','Veteran','10 hours',36000],
    ['h25','⭐','Expert','25 hours',90000],['h50','🏆','Master','50 hours',180000],['h100','👑','Legend','100 hours',360000]];
  function staticTiers(game) {
    return GAME_TIERS.map(function (t) { return { id: t[0], icon: t[1], name: t[2], label: t[3], goal: t[4], desc: 'Play ' + game + ' for ' + t[3] + '.' }; });
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
    var right = el('div', 'pach-r');
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
    function draw(tiers, summary) {
      list.textContent = '';
      if (summary) head.appendChild(summary);
      tiers.forEach(function (t) { list.appendChild(tierRow(t, true)); });
    }
    if (!eng()) {
      var note = el('span', 'gach-sum', '10 achievements · sign in to track them');
      draw(staticTiers(game), note); return;
    }
    list.appendChild(el('div', 'fp-empty', 'Loading…'));
    api('GET', '/api/game-achievements?game=' + encodeURIComponent(game)).then(function (r) {
      var sum = el('span', 'gach-sum', r.unlocked + ' / ' + r.total + ' unlocked · ' + fmtTime(r.seconds) + ' played');
      var wrap = el('div', 'pbar big gach-bar'); var f = el('i'); f.style.width = Math.round(100 * r.unlocked / r.total) + '%'; wrap.appendChild(f);
      draw(r.tiers, sum); host.insertBefore(wrap, list);
    }, function () { draw(staticTiers(game), el('span', 'gach-sum', '10 achievements')); });
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
    api('GET', '/api/profile?name=' + encodeURIComponent(eng().user)).then(function (pr) { host.textContent = ''; buildAchPage(host, pr); },
      function (e) { host.textContent = ''; host.appendChild(el('div', 'fp-empty', e.message)); });
  }
  function buildAchPage(host, pr) {
    if (!pr.games) host.appendChild(oldServerNote());
    var played = {}; (pr.games || []).forEach(function (g) { played[g.name] = g; });
    var names = ctx.gameNames();
    var general = pr.achievements || [];
    var genGot = general.filter(function (a) { return a.unlocked; }).length;
    var gameGot = 0; Object.keys(played).forEach(function (n) { gameGot += played[n].tiers.filter(function (t) { return t.unlocked; }).length; });
    var total = general.length + names.length * GAME_TIERS.length, got = genGot + gameGot;

    var top = el('div', 'ach-top');
    var big = el('div', 'ach-big'); big.appendChild(el('b', null, got.toLocaleString() + ' / ' + total.toLocaleString()));
    big.appendChild(el('small', null, 'achievements unlocked · ' + (Math.round(1000 * got / total) / 10) + '%'));
    top.appendChild(big);
    var bar = el('div', 'pbar big'); var f = el('i'); f.style.width = Math.max(0.5, 100 * got / total) + '%'; bar.appendChild(f); top.appendChild(bar);
    var split = el('div', 'ach-split');
    split.appendChild(el('span', null, 'General: ' + genGot + ' / ' + general.length));
    split.appendChild(el('span', null, 'Game achievements: ' + gameGot.toLocaleString() + ' / ' + (names.length * GAME_TIERS.length).toLocaleString() + ' across ' + names.length + ' games'));
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
        var r = el('div', 'pach-r'); r.appendChild(el('small', null, a.unlocked ? 'Unlocked ' + fmtDate(a.unlocked, true) : 'Locked'));
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
    bar2.appendChild(el('small', 'psec-sub', 'Every game: 🌱 5m · 🎈 15m · 🎯 30m · 🪝 1h · 🎮 2h · 💪 5h · 🛡️ 10h · ⭐ 25h · 🏆 50h · 👑 100h'));
    host.appendChild(bar2);
    var listHost = el('div'); host.appendChild(listHost);
    var more = el('div', 'more-wrap'); var mb = el('button', 'btn'); more.appendChild(mb); host.appendChild(more);
    function draw() {
      listHost.textContent = '';
      var term = achView.q.toLowerCase();
      var rows = names.filter(function (n) { return !term || n.toLowerCase().indexOf(term) >= 0; }).map(function (n) {
        var p = played[n]; return { name: n, p: p, got: p ? p.tiers.filter(function (t) { return t.unlocked; }).length : 0, sec: p ? p.seconds : 0 };
      });
      rows.sort(achView.sort === 'name' ? function (a, b) { return a.name.localeCompare(b.name); } : function (a, b) { return b.got - a.got || b.sec - a.sec || a.name.localeCompare(b.name); });
      rows.slice(0, achView.shown).forEach(function (r) {
        var card = el('div', 'pgame expandable');
        var ico = el('div', 'pgame-ico small'); var gg = ctx.gameByName(r.name); if (gg) ctx.artInto(ico, gg, 'capsule', false); card.appendChild(ico);
        var info = el('div', 'pgame-info'); info.appendChild(el('b', null, r.name));
        info.appendChild(el('small', 'pgame-count', r.got + ' / ' + GAME_TIERS.length + ' achievements' + (r.sec ? ' · ' + fmtTime(r.sec) + ' played' : ' · not played yet')));
        var pb = el('div', 'pbar'); var pf = el('i'); pf.style.width = (100 * r.got / GAME_TIERS.length) + '%'; pb.appendChild(pf); info.appendChild(pb);
        card.appendChild(info);
        var tiers = el('div', 'ptiers');
        (r.p ? r.p.tiers : staticTiers(r.name)).forEach(function (t) { var m = el('span', 'ptier' + (t.unlocked ? ' got' : ''), t.icon); m.title = t.name + ': play ' + t.label; tiers.appendChild(m); });
        card.appendChild(tiers);
        var tog = el('span', 'pgame-more', achView.open[r.name] ? '▴' : '▾'); card.appendChild(tog);
        var full = el('div', 'plist pgame-full' + (achView.open[r.name] ? ' open' : ''));
        function fill() {
          if (full.children.length) return;
          var tl = r.p ? r.p.tiers : staticTiers(r.name).map(function (t) { t.unlocked = null; t.progress = 0; return t; });
          tl.forEach(function (t) { full.appendChild(tierRow(t, true)); });
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
    api('GET', '/api/profile?name=' + encodeURIComponent(name || eng().user)).then(function (pr) {
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
    who.appendChild(el('h1', null, pr.name));
    if (pr.state) who.appendChild(el('div', 'prof-state st-' + pr.state, stateText(pr)));
    who.appendChild(el('div', 'prof-meta', 'Member since ' + fmtDate(pr.created, true) + ' · ' + pr.friendCount + ' friend' + (pr.friendCount === 1 ? '' : 's')));
    hero.appendChild(who);
    var acts = el('div', 'prof-acts');
    if (pr.isMe) {
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
    var gameTotal = ctx.gameNames().length * GAME_TIERS.length;
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
        var right = el('div', 'pach-r');
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
    gsec.appendChild(el('p', 'psec-sub', 'Every game has 10 achievements for time played, from 5 minutes up to 100 hours. Click a game to see them all.'));
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
      var gotN = g.tiers.filter(function (t) { return t.unlocked; }).length;
      info.appendChild(el('small', 'pgame-count', gotN + ' / ' + g.tiers.length + ' achievements'));
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
      g.tiers.forEach(function (t) { full.appendChild(tierRow(t, pr.isMe)); });
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
      t.appendChild(el('b', null, u.name));
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

  function friendsWhoPlay(gameName) {
    if (!data) return [];
    return data.friends.filter(function (f) { return (f.state === 'ingame' && f.game === gameName) || (f.recent || []).indexOf(gameName) >= 0; });
  }

  return {
    loadUsers: loadUsers, wireUsers: wireUsers, renderProfile: renderProfile, renderGameAch: renderGameAch, renderAchPage: renderAchPage,
    start: start, refresh: refresh, onAuthChange: onAuthChange, setPlaying: setPlaying, togglePanel: togglePanel,
    openProfile: openProfile, openAddFriend: openAddFriend, friendsWhoPlay: friendsWhoPlay, avatar: avatar, stateText: stateText,
    data: function () { return data; }
  };
};

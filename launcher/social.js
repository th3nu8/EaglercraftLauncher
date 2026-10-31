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

  /* ---------- presence ---------- */
  function beat() {
    if (!eng()) return;
    api('POST', '/api/presence', playing ? { state: 'ingame', game: playing } : { state: 'online' }).catch(function () {});
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
  function openProfile(name) {
    api('GET', '/api/profile?name=' + encodeURIComponent(name)).then(function (pr) {
      ctx.openModal(function (box) {
        box.classList.add('profile-box');
        var top = el('div', 'pf-top');
        top.appendChild(avatar(pr.name, 84, pr.state || null));
        var t = el('div', 'pf-t');
        t.appendChild(el('h3', null, pr.name));
        if (pr.state) t.appendChild(el('div', 'pf-state st-' + pr.state, stateText(pr)));
        t.appendChild(el('small', null, 'Member since ' + new Date(pr.created).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + ' · ' + pr.friendCount + ' friend' + (pr.friendCount === 1 ? '' : 's')));
        top.appendChild(t); box.appendChild(top);
        if (pr.recent && pr.recent.length) {
          box.appendChild(el('div', 'pf-h', 'Recently played'));
          var rl = el('div', 'pf-recent');
          pr.recent.forEach(function (r) {
            var row = el('div', 'pf-game');
            var ico = el('span', 'pf-ico'); var g = ctx.gameByName(r.game); if (g) ctx.artInto(ico, g, 'icon', false); row.appendChild(ico);
            row.appendChild(el('b', null, r.game)); row.appendChild(el('small', null, ago(r.at)));
            if (g) { row.classList.add('link'); row.onclick = function () { ctx.closeModal(); ctx.showGame(g); }; }
            rl.appendChild(row);
          });
          box.appendChild(rl);
        } else if (!pr.isMe && !pr.isFriend) {
          box.appendChild(el('p', null, 'Add ' + pr.name + ' as a friend to see what they’re playing.'));
        }
        var a = el('div', 'm-actions');
        a.appendChild(ctx.button('ghost', 'Close', null, ctx.closeModal));
        if (pr.isFriend) {
          a.appendChild(ctx.button('danger', 'Remove friend', null, function () { removeFriend(pr.name); }));
          a.appendChild(ctx.button('green', 'Message', null, function () { ctx.closeModal(); openChat(pr.name); }));
        } else if (!pr.isMe) {
          a.appendChild(ctx.button('green', pr.requestedYou ? 'Accept request' : pr.requested ? 'Request sent' : 'Add friend', null, function () {
            if (pr.requested) return;
            api('POST', pr.requestedYou ? '/api/friends/accept' : '/api/friends/request', { username: pr.name }).then(function () {
              ctx.closeModal(); toast(pr.requestedYou ? 'You and ' + pr.name + ' are now friends' : 'Friend request sent'); refresh();
            }, function (e) { toast(e.message); });
          }));
        }
        box.appendChild(a);
      });
    }, function (e) { toast(e.message); });
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

  function friendsWhoPlay(gameName) {
    if (!data) return [];
    return data.friends.filter(function (f) { return (f.state === 'ingame' && f.game === gameName) || (f.recent || []).indexOf(gameName) >= 0; });
  }

  return {
    start: start, refresh: refresh, onAuthChange: onAuthChange, setPlaying: setPlaying, togglePanel: togglePanel,
    openProfile: openProfile, openAddFriend: openAddFriend, friendsWhoPlay: friendsWhoPlay, avatar: avatar, stateText: stateText,
    data: function () { return data; }
  };
};

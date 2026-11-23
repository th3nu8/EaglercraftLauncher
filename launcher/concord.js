/*!
 * Concord — chat for the Mist desktop. Servers with text channels, your friends and DMs, live updates.
 * Server side: /api/concord/* in server/server.js (DMs reuse /api/messages).
 */
(function () {
  'use strict';
  window.MistConcord = function (o) {
    var el = o.el, toast = o.toast, shell = o.shell, social = function () { return o.social(); };
    var S = { servers: [], cursor: 0, me: null, admin: false };
    var view = { kind: 'home', server: null, channel: null, dm: null, homeTab: 'online', members: true };
    var cache = {};           // channel id or 'dm:name' -> { list:[], loaded, more, loading }
    var typing = {};          // channel -> { name: until }
    var reads = {}, unreadDm = {}, mentions = {};
    var win = null, ui = null, polling = false, pollAbort = null, gen = 0, replyTo = null, editing = null;

    function eng() { var e = o.getEngine(); return e && e.signedIn() ? e : null; }
    function api(m, p, j) { var e = eng(); if (!e) return Promise.reject(new Error('Sign in first.')); return e.api(m, p, j ? { json: j } : {}); }
    function soc() { return social(); }
    function avatar(n, s, st) { return soc() ? soc().avatar(n, s, st) : el('span', 'cc-av0', n.charAt(0)); }
    function looks(m) { if (m && soc() && soc().mergeLooks) soc().mergeLooks(m); }
    function server(id) { for (var i = 0; i < S.servers.length; i++) if (S.servers[i].id === id) return S.servers[i]; return null; }
    function chan(sv, id) { if (!sv) return null; for (var i = 0; i < sv.channels.length; i++) if (sv.channels[i].id === id) return sv.channels[i]; return null; }
    function rkey() { return 'ccReads:' + (S.me || ''); }
    function saveReads() { o.storeSet(rkey(), reads); }
    function friends() { var d = soc() && soc().data(); return d ? d.friends : []; }
    function friend(n) { var f = friends(); for (var i = 0; i < f.length; i++) if (f[i].name.toLowerCase() === String(n).toLowerCase()) return f[i]; return null; }

    /* ================================================================ data + live updates */
    function load() {
      var my = gen;
      return api('GET', '/api/concord/state').then(function (r) {
        if (my !== gen) return;
        S.servers = r.servers; S.cursor = r.cursor; S.me = r.me; S.admin = r.admin;
        reads = o.storeGet(rkey(), {}) || {};
        // first time: everything already there counts as read
        S.servers.forEach(function (sv) { sv.channels.forEach(function (c) { if (reads[c.id] == null) reads[c.id] = c.last; }); });
        saveReads();
        if (view.kind === 'server' && !server(view.server)) { view.kind = 'home'; view.server = null; }
        badge(); draw();
        if (!polling) poll();
      }, function (e) { if (ui && e.status === 404) { ui.main.textContent = ''; ui.main.appendChild(el('div', 'cc-empty', 'The Mist server needs an update for Concord.')); } });
    }
    function poll() {
      if (!eng() || polling) return;
      polling = true;
      var my = gen;
      api('POST', '/api/concord/poll', { cursor: S.cursor }).then(function (r) {
        polling = false;
        if (my !== gen) return;
        if (r.reset) { load(); return; }
        S.cursor = r.cursor;
        (r.events || []).forEach(onEvent);
        setTimeout(poll, 50);
      }, function (e) {
        polling = false;
        if (my !== gen || !eng()) return;
        setTimeout(poll, e && e.status === 404 ? 120000 : 4000);
      });
    }
    var reloadT = null;
    function reloadSoon() { clearTimeout(reloadT); reloadT = setTimeout(load, 300); }
    function onEvent(ev) {
      if (ev.type === 'msg') {
        if (ev.look && ev.lookName) { var lk = {}; lk[ev.lookName] = ev.look; looks(lk); }
        var sv = server(ev.server), c = chan(sv, ev.channel);
        if (c) c.last = ev.message.id;
        var box = cache[ev.channel], seen = box && box.list.some(function (m) { return m.id === ev.message.id; });
        if (seen) return;   // our own send already put it on screen
        if (box && box.loaded) box.list.push(ev.message);
        if (typing[ev.channel]) delete typing[ev.channel][ev.message.from];
        var mine = ev.message.from === S.me, here = viewing(ev.channel);
        if (mine || here) { reads[ev.channel] = ev.message.id; saveReads(); }
        var mention = !mine && mentionsMe(ev.message.text);
        if (mention && !here) mentions[ev.channel] = (mentions[ev.channel] || 0) + 1;
        var shown = !!ui && view.kind === 'server' && view.channel === ev.channel;   // open in the window, even if it's behind another one
        if (shown && box && box.loaded) appendMsg(ev.message);
        drawSide();
        drawRail();
        if (!mine && !here) alert(ev.message.from + (sv ? ' in #' + (c ? c.name : '') + ' · ' + sv.name : ''), ev.message.text, mention, function () { openServer(ev.server, ev.channel); });
        badge();
      } else if (ev.type === 'edit' || ev.type === 'del') {
        var b = cache[ev.channel]; if (!b) return;
        if (ev.type === 'edit') b.list.forEach(function (m, i) { if (m.id === ev.message.id) b.list[i] = ev.message; });
        else b.list = b.list.filter(function (m) { return m.id !== ev.id; });
        if (viewing(ev.channel)) drawMessages(true);
      } else if (ev.type === 'typing') {
        if (ev.name === S.me) return;
        (typing[ev.channel] = typing[ev.channel] || {})[ev.name] = Date.now() + 5000;
        if (viewing(ev.channel)) drawTyping();
      } else if (ev.type === 'server' || ev.type === 'member') {
        reloadSoon();
        if (ev.type === 'member' && view.kind === 'server' && view.server === ev.server && view.members) setTimeout(drawMembers, 400);
      } else if (ev.type === 'gone') {
        S.servers = S.servers.filter(function (x) { return x.id !== ev.server; });
        if (view.server === ev.server) { view.kind = 'home'; view.server = null; }
        if (ev.kicked) toast('You were removed from a Concord server');
        draw();
      } else if (ev.type === 'social') {
        if (soc()) soc().refresh();
      } else if (ev.type === 'dm') {
        var key = 'dm:' + ev.with.toLowerCase(), bx = cache[key];
        if (bx && bx.list.some(function (m) { return m.id === ev.message.id; })) return;
        if (bx && bx.loaded) bx.list.push(ev.message);
        var hereDm = view.kind === 'home' && view.dm && view.dm.toLowerCase() === ev.with.toLowerCase() && front();
        var shownDm = !!ui && view.kind === 'home' && view.dm && view.dm.toLowerCase() === ev.with.toLowerCase();
        if (shownDm && bx && bx.loaded) appendMsg(ev.message);
        if (!hereDm && !ev.message.mine) { unreadDm[ev.with.toLowerCase()] = (unreadDm[ev.with.toLowerCase()] || 0) + 1; alert(ev.with, ev.message.text, true, function () { openDm(ev.with); }); }
        if (hereDm || ev.message.mine) markDmRead(ev.with);
        drawSide(); drawRail(); badge();
      }
    }
    setInterval(function () { var ch = view.kind === 'server' && view.channel; if (ch && typing[ch]) drawTyping(); }, 1500);
    function viewing(cid) { return view.kind === 'server' && view.channel === cid && front(); }
    function front() { return !!(win && !win.hidden && win.state !== 'min' && win.el.classList.contains('win-front') && !shell.isLocked() && document.visibilityState === 'visible'); }
    function mentionsMe(t) { return !!S.me && new RegExp('(^|\\W)@' + S.me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\W|$)', 'i').test(t); }
    function alert(title, text, important, go) {
      var mode = (shell.prefs() || {}).concordNotif || 'mentions';
      if (mode === 'off' || (mode === 'mentions' && !important)) return;
      shell.notify({ app: 'concord', title: title, text: text, onClick: function () { open(); go(); } });
    }
    function unreadCh(c) { return c.last > (reads[c.id] || 0); }
    function badge() {
      var n = dmTotal(); Object.keys(mentions).forEach(function (k) { n += mentions[k]; });
      var d = soc() && soc().data(); if (d) n += d.incoming.length;
      shell.setBadge('concord', n);
    }
    // unread DMs: live events since Concord started, or the server's count (covers messages sent while you were away)
    function dmUnread(name) { var f = friend(name); return Math.max(unreadDm[String(name).toLowerCase()] || 0, f && f.unread || 0); }
    function dmTotal() { var n = 0, seen = {}; friends().forEach(function (f) { seen[f.name.toLowerCase()] = 1; n += dmUnread(f.name); }); Object.keys(unreadDm).forEach(function (k) { if (!seen[k]) n += unreadDm[k]; }); return n; }
    function markDmRead(name) {
      var k = name.toLowerCase(), f = friend(name), had = (unreadDm[k] || 0) + (f && f.unread || 0);
      delete unreadDm[k]; if (f) f.unread = 0; badge();
      if (had) {   // tell the server too, so the count doesn't come back on the next friends refresh
        var bx = cache['dm:' + k], last = bx && bx.list.length ? bx.list[bx.list.length - 1].id : 0;
        api('GET', '/api/messages?with=' + encodeURIComponent(name) + '&after=' + Math.max(0, last - 1)).catch(function () {});
      }
    }

    /* ================================================================ window */
    function open(arg) {
      if (!eng()) return null;
      if (win && document.body.contains(win.el)) { win.show(); if (arg && arg.dm) openDm(arg.dm); else refreshView(); return win; }
      win = shell.openWindow({ app: 'concord', title: 'Concord', width: 1080, height: 700, minW: 420, minH: 360, cls: 'win-concord', keepAlive: true, closeOnSignOut: true,
        onFocus: function () { setTimeout(markViewRead, 50); } });
      ui = {};
      var root = el('div', 'cc');
      ui.rail = el('nav', 'cc-rail'); ui.side = el('aside', 'cc-side'); ui.main = el('section', 'cc-main'); ui.mem = el('aside', 'cc-mem');
      root.appendChild(ui.rail); root.appendChild(ui.side); root.appendChild(ui.main); root.appendChild(ui.mem);
      ui.modal = el('div', 'cc-modal'); root.appendChild(ui.modal);
      win.body.appendChild(root);
      ui.root = root;
      if (!S.me) load(); else draw();
      if (arg && arg.dm) openDm(arg.dm);
      return win;
    }
    function refreshView() { draw(); markViewRead(); }
    function markViewRead() {
      if (!ui || !front()) return;
      if (view.kind === 'server' && view.channel) { var c = chan(server(view.server), view.channel); if (c && unreadCh(c)) { reads[c.id] = c.last; saveReads(); } delete mentions[view.channel]; drawRail(); drawSide(); badge(); }
      if (view.kind === 'home' && view.dm) { markDmRead(view.dm); drawSide(); drawRail(); }
    }
    function draw() { if (!ui) return; drawRail(); drawSide(); drawMain(); drawMembers(); }

    /* ---------------- server rail ---------------- */
    function drawRail() {
      if (!ui) return;
      ui.rail.textContent = '';
      var home = el('button', 'cc-ri cc-home' + (view.kind === 'home' ? ' on' : '')); home.title = 'Friends & DMs';
      home.appendChild(shell.appIcon('concord', 30));
      var dmN = dmTotal();
      var inc = soc() && soc().data() ? soc().data().incoming.length : 0;
      if (dmN + inc) home.appendChild(el('span', 'cc-pip', String(dmN + inc)));
      home.onclick = function () { view.kind = 'home'; view.server = null; draw(); };
      ui.rail.appendChild(home);
      ui.rail.appendChild(el('hr'));
      S.servers.forEach(function (sv) {
        var b = el('button', 'cc-ri' + (view.kind === 'server' && view.server === sv.id ? ' on' : ''));
        b.title = sv.name; b.style.setProperty('--sv', sv.color || '#5865f2');
        b.appendChild(el('span', 'cc-sv', sv.emoji || initials(sv.name)));
        var un = sv.channels.some(unreadCh), mn = sv.channels.reduce(function (a, c) { return a + (mentions[c.id] || 0); }, 0);
        if (un) b.classList.add('unread');
        if (mn) b.appendChild(el('span', 'cc-pip', String(mn)));
        b.onclick = function () { openServer(sv.id); };
        ui.rail.appendChild(b);
      });
      var add = el('button', 'cc-ri cc-add', '+'); add.title = 'Create or join a server'; add.onclick = addServer;
      ui.rail.appendChild(add);
    }
    function initials(n) { return n.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 3).toUpperCase(); }

    /* ---------------- channel / DM column ---------------- */
    function drawSide() {
      if (!ui) return;
      ui.side.textContent = '';
      if (view.kind === 'server') {
        var sv = server(view.server); if (!sv) return;
        var head = el('button', 'cc-shead'); head.appendChild(el('b', null, sv.name)); head.appendChild(el('span', null, '▾'));
        head.onclick = function (e) { e.stopPropagation(); serverMenu(sv, head); };
        ui.side.appendChild(head);
        var list = el('div', 'cc-chans');
        list.appendChild(el('div', 'cc-cat', 'Text channels'));
        sv.channels.forEach(function (c) {
          var b = el('button', 'cc-ch' + (view.channel === c.id ? ' on' : '') + (unreadCh(c) && view.channel !== c.id ? ' unread' : ''));
          b.appendChild(el('span', 'cc-hash', c.readOnly ? '📢' : '#')); b.appendChild(el('span', 'cc-cn', c.name));
          if (mentions[c.id]) b.appendChild(el('span', 'cc-pip in', String(mentions[c.id])));
          b.onclick = function () { openServer(sv.id, c.id); };
          if (sv.manage) b.oncontextmenu = function (e) { e.preventDefault(); channelMenu(sv, c, e); };
          list.appendChild(b);
        });
        if (sv.manage) { var nc = el('button', 'cc-newch', '+ New channel'); nc.onclick = function () { newChannel(sv); }; list.appendChild(nc); }
        ui.side.appendChild(list);
      } else {
        var hd = el('div', 'cc-shead static'); hd.appendChild(el('b', null, 'Direct messages')); ui.side.appendChild(hd);
        var l2 = el('div', 'cc-chans');
        var fb = el('button', 'cc-ch big' + (!view.dm ? ' on' : '')); fb.appendChild(el('span', 'cc-hash', '👥')); fb.appendChild(el('span', 'cc-cn', 'Friends'));
        var inc = soc() && soc().data() ? soc().data().incoming.length : 0; if (inc) fb.appendChild(el('span', 'cc-pip in', String(inc)));
        fb.onclick = function () { view.dm = null; draw(); }; l2.appendChild(fb);
        l2.appendChild(el('div', 'cc-cat', 'Messages'));
        var fs = friends().slice().sort(function (a, b) { return dmUnread(b.name) - dmUnread(a.name) || (a.state === 'offline') - (b.state === 'offline') || a.name.localeCompare(b.name); });
        if (!fs.length) l2.appendChild(el('p', 'cc-muted', 'Add friends to message them.'));
        fs.forEach(function (f) {
          var n = dmUnread(f.name);
          var b = el('button', 'cc-dm' + (view.dm && view.dm.toLowerCase() === f.name.toLowerCase() ? ' on' : '') + (n ? ' unread' : ''));
          b.appendChild(avatar(f.name, 32, f.state));
          var t = el('span', 'cc-dmt'); t.appendChild(el('b', null, f.name)); t.appendChild(el('small', null, soc() ? soc().stateText(f) : f.state)); b.appendChild(t);
          if (n) b.appendChild(el('span', 'cc-pip in', String(n)));
          b.onclick = function () { openDm(f.name); };
          l2.appendChild(b);
        });
        ui.side.appendChild(l2);
      }
      ui.side.appendChild(userPanel());
    }
    function userPanel() {
      var p = el('div', 'cc-me');
      p.appendChild(avatar(S.me || '?', 32, 'online'));
      var t = el('span', 'cc-dmt'); t.appendChild(el('b', null, S.me || '')); t.appendChild(el('small', null, 'Online')); p.appendChild(t);
      var gear = el('button', 'cc-ib', '⚙'); gear.title = 'Notification settings'; gear.onclick = function () { shell.launch('settings', 'notifs'); }; p.appendChild(gear);
      var prof = el('button', 'cc-ib', '👤'); prof.title = 'Your Mist profile'; prof.onclick = function () { if (o.showProfile) o.showProfile(S.me); }; p.appendChild(prof);
      return p;
    }

    /* ---------------- main column ---------------- */
    function openServer(id, cid) {
      var sv = server(id); if (!sv) return;
      view.kind = 'server'; view.server = id; view.dm = null;
      var remembered = o.storeGet('ccLastCh:' + id, null);
      view.channel = cid || (chan(sv, remembered) ? remembered : (sv.channels.filter(function (c) { return c.name === 'general'; })[0] || sv.channels[0]).id);
      o.storeSet('ccLastCh:' + id, view.channel);
      replyTo = null; editing = null;
      if (ui) { ui.root.classList.remove('side-open'); draw(); }
      markViewRead();
    }
    function openDm(name) {
      view.kind = 'home'; view.server = null; view.dm = name; replyTo = null; editing = null;
      if (!win || !document.body.contains(win.el)) { open({ dm: name }); return; }
      win.show(); if (ui) ui.root.classList.remove('side-open');
      draw(); markViewRead();
    }
    function drawMain() {
      if (!ui) return;
      ui.main.textContent = '';
      var head = el('header', 'cc-head');
      var menuB = el('button', 'cc-ib cc-menu', '☰'); menuB.title = 'Channels'; menuB.onclick = function () { ui.root.classList.toggle('side-open'); }; head.appendChild(menuB);
      ui.main.appendChild(head);
      if (view.kind === 'home' && !view.dm) { head.appendChild(el('b', null, '👥 Friends')); drawFriendsHome(); drawActiveNow(); win.setTitle('Concord — Friends'); return; }
      var key, title, topic;
      if (view.kind === 'server') {
        var sv = server(view.server), c = chan(sv, view.channel); if (!c) return;
        key = c.id; title = '# ' + c.name; topic = c.topic;
        head.appendChild(el('b', null, title)); if (topic) head.appendChild(el('span', 'cc-topic', topic));
        var mb = el('button', 'cc-ib' + (view.members ? ' on' : ''), '👥'); mb.title = 'Members'; mb.style.marginLeft = 'auto';
        mb.onclick = function () { view.members = !view.members; ui.root.classList.toggle('no-mem', !view.members); mb.classList.toggle('on', view.members); drawMembers(); };
        head.appendChild(mb);
        ui.root.classList.toggle('no-mem', !view.members);
        win.setTitle('Concord — #' + c.name + ' · ' + sv.name);
      } else {
        key = 'dm:' + view.dm.toLowerCase();
        var f = friend(view.dm) || { name: view.dm, state: 'offline' };
        var who = el('button', 'cc-dmhead'); who.appendChild(avatar(f.name, 26, f.state)); who.appendChild(el('b', null, f.name));
        who.appendChild(el('span', 'cc-topic', soc() ? soc().stateText(f) : '')); who.onclick = function () { if (o.showProfile) o.showProfile(f.name); };
        head.appendChild(who);
        ui.root.classList.add('no-mem');
        win.setTitle('Concord — ' + f.name);
      }
      ui.list = el('div', 'cc-msgs'); ui.main.appendChild(ui.list);
      ui.list.addEventListener('scroll', function () { if (ui.list.scrollTop < 60) older(); });
      ui.typing = el('div', 'cc-typing'); ui.main.appendChild(ui.typing);
      ui.main.appendChild(composer(key));
      var box = cache[key];
      if (!box || !box.loaded) fetchFirst(key); else drawMessages();
      drawTyping();
    }
    function fetchFirst(key) {
      var box = cache[key] = cache[key] || { list: [], loaded: false };
      if (box.loading) return; box.loading = true;
      ui.list.appendChild(el('div', 'cc-empty', 'Loading…'));
      var req = key.indexOf('dm:') === 0 ? api('GET', '/api/messages?with=' + encodeURIComponent(view.dm) + '&after=0').then(function (r) { return { messages: r.messages, more: false }; })
        : api('GET', '/api/concord/messages?channel=' + encodeURIComponent(key));
      req.then(function (r) {
        box.loading = false; looks(r.looks);
        var have = {}; box.list.forEach(function (m) { have[m.id] = 1; });
        box.list = r.messages.filter(function (m) { return !have[m.id]; }).concat(box.list).sort(function (a, b) { return a.id - b.id; });
        box.loaded = true; box.more = !!r.more;
        if (curKey() === key) drawMessages();
        if (key.indexOf('dm:') === 0) { markDmRead(view.dm); drawSide(); drawRail(); }
      }, function (e) { box.loading = false; if (curKey() === key) { ui.list.textContent = ''; ui.list.appendChild(el('div', 'cc-empty', e.message)); } });
    }
    function older() {
      var key = curKey(), box = cache[key];
      if (!box || !box.loaded || !box.more || box.loading || key.indexOf('dm:') === 0 || !box.list.length) return;
      box.loading = true;
      api('GET', '/api/concord/messages?channel=' + encodeURIComponent(key) + '&before=' + box.list[0].id).then(function (r) {
        box.loading = false; looks(r.looks); box.more = !!r.more;
        if (!r.messages.length) return;
        box.list = r.messages.concat(box.list);
        if (curKey() !== key) return;
        var h0 = ui.list.scrollHeight; drawMessages(true); ui.list.scrollTop = ui.list.scrollHeight - h0;
      }, function () { box.loading = false; });
    }
    function curKey() { return view.kind === 'server' ? view.channel : view.dm ? 'dm:' + view.dm.toLowerCase() : null; }
    function drawMessages(keepScroll) {
      if (!ui || !ui.list) return;
      var box = cache[curKey()]; if (!box) return;
      var st = ui.list.scrollTop, atBottom = ui.list.scrollHeight - st - ui.list.clientHeight < 80;
      ui.list.textContent = '';
      if (!box.more) {
        var hello = el('div', 'cc-hello');
        if (view.kind === 'server') { var c = chan(server(view.server), view.channel); hello.appendChild(el('div', 'cc-hello-i', '#')); hello.appendChild(el('h2', null, 'Welcome to #' + (c ? c.name : ''))); hello.appendChild(el('p', null, 'This is the start of the #' + (c ? c.name : '') + ' channel.' + (c && c.topic ? ' ' + c.topic : ''))); }
        else { hello.appendChild(avatar(view.dm, 72)); hello.appendChild(el('h2', null, view.dm)); hello.appendChild(el('p', null, 'This is the start of your messages with ' + view.dm + '.')); }
        ui.list.appendChild(hello);
      }
      box.list.forEach(function (m) { ui.list.appendChild(msgEl(m)); });
      if (!keepScroll || atBottom) ui.list.scrollTop = ui.list.scrollHeight; else ui.list.scrollTop = st;
    }
    function appendMsg(m) {
      if (!ui || !ui.list) return;
      var atBottom = ui.list.scrollHeight - ui.list.scrollTop - ui.list.clientHeight < 100;
      var empty = ui.list.querySelector('.cc-empty'); if (empty) empty.remove();
      ui.list.appendChild(msgEl(m));
      if (atBottom || m.from === S.me || m.mine) ui.list.scrollTop = ui.list.scrollHeight;
    }
    function fmtTime(t) {
      var d = new Date(t), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
      var hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (d.toDateString() === now.toDateString()) return 'Today at ' + hm;
      if (d.toDateString() === y.toDateString()) return 'Yesterday at ' + hm;
      return d.toLocaleDateString() + ' ' + hm;
    }
    function msgEl(m) {
      var prev = ui.list.lastElementChild;
      var grouped = prev && prev.dataset && prev.dataset.from === m.from && m.at - (+prev.dataset.at) < 7 * 60e3 && !m.reply;
      var r = el('div', 'cc-m' + (grouped ? ' grp' : '') + (mentionsMe(m.text) && m.from !== S.me ? ' ment' : ''));
      r.dataset.from = m.from; r.dataset.at = m.at; r.dataset.id = m.id;
      if (m.reply) {
        var rp = el('div', 'cc-rp'); rp.appendChild(el('b', null, '@' + m.reply.from)); rp.appendChild(el('span', null, m.reply.text)); r.appendChild(rp);
      }
      if (!grouped) {
        var av = avatar(m.from, 40); av.classList.add('cc-mav'); av.onclick = function () { if (o.showProfile) o.showProfile(m.from); }; r.appendChild(av);
        var h = el('div', 'cc-mh'); var nm = el('b', null, m.from); nm.onclick = function () { if (o.showProfile) o.showProfile(m.from); }; h.appendChild(nm);
        h.appendChild(el('small', null, fmtTime(m.at))); r.appendChild(h);
      } else r.appendChild(el('small', 'cc-gt', new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      var body = el('div', 'cc-mt'); rich(body, m.text);
      if (m.edited) body.appendChild(el('small', 'cc-ed', ' (edited)'));
      r.appendChild(body);
      // actions
      var acts = el('div', 'cc-acts');
      var dm = curKey() && curKey().indexOf('dm:') === 0;
      if (!dm) { var rb = el('button', null, '↩'); rb.title = 'Reply'; rb.onclick = function () { replyTo = m; drawComposerState(); ui.input.focus(); }; acts.appendChild(rb); }
      var cp = el('button', null, '⧉'); cp.title = 'Copy text'; cp.onclick = function () { copy(m.text); }; acts.appendChild(cp);
      var sv = server(view.server);
      if (!dm && m.from === S.me) { var eb = el('button', null, '✎'); eb.title = 'Edit'; eb.onclick = function () { editing = m; ui.input.value = m.text; drawComposerState(); ui.input.focus(); }; acts.appendChild(eb); }
      if (!dm && (m.from === S.me || (sv && sv.manage))) { var db = el('button', null, '🗑'); db.title = 'Delete'; db.onclick = function () { if (confirm('Delete this message?')) api('POST', '/api/concord/delete', { channel: view.channel, id: m.id }).catch(function (e) { toast(e.message); }); }; acts.appendChild(db); }
      r.appendChild(acts);
      return r;
    }
    function copy(t) { try { navigator.clipboard.writeText(t).then(function () { toast('Copied'); }, function () { toast('Couldn’t copy'); }); } catch (e) { toast('Couldn’t copy'); } }
    // **bold**, *italic*, `code`, ```blocks```, links (open in Gleam), @mentions — built as DOM, never HTML
    function rich(box, text) {
      var parts = String(text).split('```');
      parts.forEach(function (part, i) {
        if (i % 2) { var pre = el('pre', 'cc-code', part.replace(/^\w*\n/, '')); box.appendChild(pre); return; }
        var re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?:\/\/[^\s<>"]+)|(@[A-Za-z0-9_\-.]{2,24})/g, last = 0, mm;
        while ((mm = re.exec(part))) {
          if (mm.index > last) box.appendChild(document.createTextNode(part.slice(last, mm.index)));
          var t = mm[0];
          if (mm[1]) box.appendChild(el('code', null, t.slice(1, -1)));
          else if (mm[2]) box.appendChild(el('b', null, t.slice(2, -2)));
          else if (mm[3]) box.appendChild(el('i', null, t.slice(1, -1)));
          else if (mm[4]) { var a = el('a', null, t); a.href = '#'; a.title = 'Open in Gleam'; a.onclick = (function (u) { return function (e) { e.preventDefault(); shell.launch('gleam', u); }; })(t); box.appendChild(a); }
          else { var me = S.me && t.slice(1).toLowerCase() === S.me.toLowerCase(); box.appendChild(el('span', 'cc-at' + (me ? ' me' : ''), t)); }
          last = re.lastIndex;
        }
        if (last < part.length) box.appendChild(document.createTextNode(part.slice(last)));
      });
    }
    function composer(key) {
      var wrap = el('div', 'cc-comp');
      ui.state = el('div', 'cc-cstate'); wrap.appendChild(ui.state);
      var row = el('div', 'cc-crow');
      var ta = el('textarea', 'cc-in'); ta.rows = 1; ta.maxLength = 2000; ta.spellcheck = true;
      var ro = false;
      if (view.kind === 'server') { var c = chan(server(view.server), view.channel), sv = server(view.server); ta.placeholder = 'Message #' + (c ? c.name : ''); ro = c && c.readOnly && !(sv && sv.manage); }
      else ta.placeholder = 'Message @' + view.dm;
      if (ro) { ta.disabled = true; ta.placeholder = 'Only admins can post in this channel.'; }
      ui.input = ta;
      var lastTyping = 0;
      ta.oninput = function () {
        ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
        if (view.kind === 'server' && ta.value && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); api('POST', '/api/concord/typing', { channel: view.channel }).catch(function () {}); }
      };
      ta.onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); }
        if (e.key === 'Escape') { replyTo = null; editing = null; drawComposerState(); }
        if (e.key === 'ArrowUp' && !ta.value && view.kind === 'server') {
          var box = cache[view.channel], mine = box && box.list.filter(function (m) { return m.from === S.me; }).pop();
          if (mine) { e.preventDefault(); editing = mine; ta.value = mine.text; drawComposerState(); }
        }
      };
      row.appendChild(ta);
      var send = el('button', 'cc-send', '➤'); send.title = 'Send'; send.onclick = sendNow; if (ro) send.disabled = true; row.appendChild(send);
      wrap.appendChild(row);
      drawComposerState();
      setTimeout(function () { if (!ro && front()) ta.focus(); }, 40);
      return wrap;
    }
    function drawComposerState() {
      if (!ui || !ui.state) return;
      ui.state.textContent = '';
      var m = editing || replyTo; if (!m) { ui.state.classList.remove('on'); return; }
      ui.state.classList.add('on');
      ui.state.appendChild(el('span', null, editing ? 'Editing your message' : 'Replying to ' + m.from));
      var x = el('button', null, '✕'); x.onclick = function () { if (editing) ui.input.value = ''; replyTo = null; editing = null; drawComposerState(); }; ui.state.appendChild(x);
    }
    function sendNow() {
      var ta = ui.input, text = ta.value; if (!text.trim() || ta.disabled) return;
      if (editing) {
        var e0 = editing; editing = null; ta.value = ''; drawComposerState();
        api('POST', '/api/concord/edit', { channel: view.channel, id: e0.id, text: text }).catch(function (e) { toast(e.message); });
        return;
      }
      ta.value = ''; ta.style.height = 'auto';
      if (view.kind === 'server') {
        var rp = replyTo; replyTo = null; drawComposerState();
        api('POST', '/api/concord/send', { channel: view.channel, text: text, reply: rp ? rp.id : null }).then(function (r) {
          var box = cache[view.channel]; if (box && !box.list.some(function (m) { return m.id === r.message.id; })) { box.list.push(r.message); appendMsg(r.message); }
        }, function (e) { toast(e.message); ta.value = text; });
      } else {
        var who = view.dm;
        api('POST', '/api/messages', { to: who, text: text }).then(function (r) {
          var box = cache['dm:' + who.toLowerCase()]; if (box && !box.list.some(function (m) { return m.id === r.message.id; })) { box.list.push(r.message); if (view.dm === who) appendMsg(r.message); }
        }, function (e) { toast(e.message); ta.value = text; });
      }
    }
    function drawTyping() {
      if (!ui || !ui.typing) return;
      var t = typing[view.channel] || {}, now = Date.now(), names = Object.keys(t).filter(function (n) { return t[n] > now; });
      ui.typing.textContent = names.length ? (names.length > 3 ? 'Several people are typing…' : names.join(', ') + (names.length > 1 ? ' are' : ' is') + ' typing…') : '';
    }

    /* ---------------- friends home ---------------- */
    function drawFriendsHome() {
      var d = soc() && soc().data();
      var tabs = el('div', 'cc-ftabs');
      [['online', 'Online'], ['all', 'All'], ['pending', 'Pending'], ['add', 'Add friend']].forEach(function (t) {
        var b = el('button', (view.homeTab === t[0] ? 'on' : '') + (t[0] === 'add' ? ' addf' : ''), t[1]);
        if (t[0] === 'pending' && d && d.incoming.length) b.appendChild(el('span', 'cc-pip in', String(d.incoming.length)));
        b.onclick = function () { view.homeTab = t[0]; drawMain(); }; tabs.appendChild(b);
      });
      ui.main.querySelector('.cc-head').appendChild(tabs);
      var body = el('div', 'cc-fbody'); ui.main.appendChild(body);
      if (!d) { body.appendChild(el('div', 'cc-empty', 'Loading friends…')); if (soc()) soc().refresh(); return; }
      if (view.homeTab === 'add') {
        body.appendChild(el('h3', null, 'Add a friend'));
        body.appendChild(el('p', 'cc-muted', 'Type their Mist account name.'));
        var f = el('form', 'cc-addf'); var i = el('input'); i.placeholder = 'Account name'; i.spellcheck = false; i.autocomplete = 'off';
        var b2 = el('button', 'cc-btn acc', 'Send request'); f.appendChild(i); f.appendChild(b2);
        f.onsubmit = function (e) { e.preventDefault(); var n = i.value.trim(); if (!n) return; api('POST', '/api/friends/request', { username: n }).then(function (r) { toast(r && r.friends ? 'You and ' + n + ' are now friends' : 'Friend request sent to ' + n); i.value = ''; soc().refresh(); }, function (er) { toast(er.message); }); };
        body.appendChild(f);
        return;
      }
      var list = view.homeTab === 'pending' ? null : d.friends.filter(function (x) { return view.homeTab === 'all' || x.state !== 'offline'; });
      if (view.homeTab === 'pending') {
        body.appendChild(el('div', 'cc-cat', 'Incoming — ' + d.incoming.length));
        d.incoming.forEach(function (n) {
          var r = frRow(n, 'wants to be friends');
          r.appendChild(act('✓', 'Accept', function () { api('POST', '/api/friends/accept', { username: n }).then(function () { soc().refresh(); }, function (e) { toast(e.message); }); }));
          r.appendChild(act('✕', 'Decline', function () { api('POST', '/api/friends/decline', { username: n }).then(function () { soc().refresh(); }, function (e) { toast(e.message); }); }));
          body.appendChild(r);
        });
        body.appendChild(el('div', 'cc-cat', 'Sent — ' + d.outgoing.length));
        d.outgoing.forEach(function (n) {
          var r = frRow(n, 'request sent');
          r.appendChild(act('✕', 'Cancel', function () { api('POST', '/api/friends/cancel', { username: n }).then(function () { soc().refresh(); }, function (e) { toast(e.message); }); }));
          body.appendChild(r);
        });
        if (!d.incoming.length && !d.outgoing.length) body.appendChild(el('div', 'cc-empty', 'No pending requests.'));
        return;
      }
      body.appendChild(el('div', 'cc-cat', (view.homeTab === 'online' ? 'Online' : 'All friends') + ' — ' + list.length));
      if (!list.length) body.appendChild(el('div', 'cc-empty', view.homeTab === 'online' ? 'None of your friends are online right now.' : 'No friends yet. Add some!'));
      list.forEach(function (f) {
        var r = frRow(f.name, soc().stateText(f), f.state);
        r.appendChild(act('💬', 'Message', function () { openDm(f.name); }));
        r.appendChild(act('👤', 'Profile', function () { if (o.showProfile) o.showProfile(f.name); }));
        r.onclick = function () { openDm(f.name); }; r.style.cursor = 'pointer';
        body.appendChild(r);
      });
    }
    function frRow(n, sub, st) { var r = el('div', 'cc-fr'); r.appendChild(avatar(n, 36, st)); var t = el('span', 'cc-dmt'); t.appendChild(el('b', null, n)); t.appendChild(el('small', null, sub)); r.appendChild(t); return r; }
    function act(t, title, fn) { var b = el('button', 'cc-ib round', t); b.title = title; b.onclick = function (e) { e.stopPropagation(); fn(); }; return b; }

    /* ---------------- member list ---------------- */
    var memSeq = 0;
    // the right-hand column on the friends page: who's online and what they're playing
    var lastSocialSig = '';
    function drawActiveNow() {
      ui.root.classList.remove('no-mem'); ui.mem.textContent = ''; ++memSeq;
      ui.mem.appendChild(el('div', 'cc-cat', 'Active now'));
      var d = soc() && soc().data(), on = d ? d.friends.filter(function (f) { return f.state && f.state !== 'offline'; }) : [];
      if (!on.length) { var q = el('div', 'cc-quiet'); q.appendChild(el('b', null, "It's quiet for now…")); q.appendChild(el('span', null, 'When friends are online or playing something, they show up here.')); ui.mem.appendChild(q); return; }
      on.forEach(function (f) {
        var r = el('button', 'cc-mm'); r.appendChild(avatar(f.name, 32, f.state));
        var t = el('div', 'cc-dmt'); t.appendChild(el('b', null, f.name)); t.appendChild(el('small', null, soc().stateText(f))); r.appendChild(t);
        r.onclick = function () { openDm(f.name); }; ui.mem.appendChild(r);
      });
    }
    function drawMembers() {
      if (!ui) return;
      if (view.kind === 'home' && !view.dm) { drawActiveNow(); return; }
      if (view.kind !== 'server' || !view.members) { ui.mem.textContent = ''; return; }
      var sv = server(view.server), my = ++memSeq; if (!sv) return;
      api('GET', '/api/concord/members?server=' + encodeURIComponent(sv.id)).then(function (r) {
        if (my !== memSeq || !ui) return;
        looks(r.looks);
        ui.mem.textContent = '';
        var on = r.members.filter(function (m) { return m.state !== 'offline'; }), off = r.members.filter(function (m) { return m.state === 'offline'; });
        [['Online — ' + r.online, on], ['Offline — ' + (r.total - r.online), off]].forEach(function (g) {
          if (!g[1].length) return;
          ui.mem.appendChild(el('div', 'cc-cat', g[0]));
          g[1].forEach(function (m) {
            var b = el('button', 'cc-mm' + (m.state === 'offline' ? ' off' : ''));
            b.appendChild(avatar(m.name, 32, m.state));
            var t = el('span', 'cc-dmt'); var nm = el('b', null, m.name); if (m.role !== 'member') nm.appendChild(el('span', 'cc-role ' + m.role, m.role === 'owner' ? '👑' : '🛡'));
            t.appendChild(nm); t.appendChild(el('small', null, m.game ? 'Playing ' + m.game : m.state === 'offline' ? '' : 'Online')); b.appendChild(t);
            b.onclick = function (e) { memberMenu(sv, m, e); };
            ui.mem.appendChild(b);
          });
        });
      }, function () {});
    }
    function memberMenu(sv, m, e) {
      var items = [['Profile', function () { if (o.showProfile) o.showProfile(m.name); }]];
      if (m.name !== S.me && friend(m.name)) items.push(['Message', function () { openDm(m.name); }]);
      else if (m.name !== S.me) items.push(['Add friend', function () { api('POST', '/api/friends/request', { username: m.name }).then(function () { toast('Friend request sent'); soc().refresh(); }, function (er) { toast(er.message); }); }]);
      if (sv.manage && m.name !== S.me && m.role !== 'owner') {
        if (sv.role === 'owner' || S.admin) items.push([m.role === 'admin' ? 'Remove admin' : 'Make admin', function () { post('/api/concord/role', { server: sv.id, name: m.name, role: m.role === 'admin' ? 'member' : 'admin' }, 'Updated'); }]);
        items.push(['Kick from server', function () { if (confirm('Kick ' + m.name + ' from ' + sv.name + '?')) post('/api/concord/kick', { server: sv.id, name: m.name }, m.name + ' was kicked'); }]);
        items.push(['Ban from server', function () { if (confirm('Ban ' + m.name + ' from ' + sv.name + '? They can’t rejoin with an invite.')) post('/api/concord/ban', { server: sv.id, name: m.name }, m.name + ' was banned'); }]);
      }
      popMenu(e.clientX, e.clientY, items);
    }
    function post(p, j, ok) { return api('POST', p, j).then(function (r) { if (ok) toast(ok); reloadSoon(); drawMembers(); return r; }, function (e) { toast(e.message); throw e; }); }
    function popMenu(x, y, items) {
      var m = el('div', 'cc-pop');
      items.forEach(function (it) { var b = el('button', it[2] ? 'danger' : '', it[0]); b.onclick = function () { m.remove(); it[1](); }; m.appendChild(b); });
      ui.root.appendChild(m);
      var R = ui.root.getBoundingClientRect(), r = m.getBoundingClientRect();
      m.style.left = Math.max(4, Math.min(x - R.left, R.width - r.width - 4)) + 'px'; m.style.top = Math.max(4, Math.min(y - R.top, R.height - r.height - 4)) + 'px';
      setTimeout(function () { document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } }, true); }, 0);
    }

    /* ---------------- server menus & dialogs ---------------- */
    function serverMenu(sv, anchor) {
      var r = anchor.getBoundingClientRect(), items = [];
      items.push(['👋 Invite people', function () { invite(sv); }]);
      if (sv.manage) { items.push(['⚙ Server settings', function () { serverSettings(sv); }]); items.push(['＋ Create channel', function () { newChannel(sv); }]); }
      items.push(['✓ Mark all as read', function () { sv.channels.forEach(function (c) { reads[c.id] = c.last; delete mentions[c.id]; }); saveReads(); draw(); badge(); }]);
      if (sv.role !== 'owner') items.push(['🚪 Leave server', function () { if (confirm('Leave ' + sv.name + '?')) post('/api/concord/leave', { server: sv.id }, 'You left ' + sv.name); }, true]);
      else items.push(['🗑 Delete server', function () { if (prompt('Type the server’s name to delete it for everyone:') === sv.name) post('/api/concord/server/delete', { server: sv.id }, sv.name + ' deleted'); }, true]);
      popMenu(r.left, r.bottom + 4, items);
    }
    function channelMenu(sv, c, e) {
      popMenu(e.clientX, e.clientY, [
        ['Edit channel', function () { editChannel(sv, c); }],
        ['Delete channel', function () { if (confirm('Delete #' + c.name + ' and all its messages?')) post('/api/concord/channel/delete', { server: sv.id, channel: c.id }, '#' + c.name + ' deleted'); }, true]
      ]);
    }
    function dialog(title, build) {
      ui.modal.textContent = ''; ui.modal.classList.add('on');
      var box = el('div', 'cc-dlg'); box.appendChild(el('h3', null, title));
      var close = function () { ui.modal.classList.remove('on'); ui.modal.textContent = ''; };
      build(box, close);
      ui.modal.appendChild(box);
      ui.modal.onpointerdown = function (e) { if (e.target === ui.modal) close(); };
      var f = box.querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 30);
    }
    function input(box, label, value, ph) { var l = el('label', 'cc-fl'); l.appendChild(el('span', null, label)); var i = el('input'); i.value = value || ''; i.placeholder = ph || ''; i.spellcheck = false; l.appendChild(i); box.appendChild(l); return i; }
    function btns(box, list) { var r = el('div', 'cc-dbtns'); list.forEach(function (b) { var x = el('button', 'cc-btn' + (b[2] ? ' ' + b[2] : ''), b[0]); x.onclick = b[1]; r.appendChild(x); }); box.appendChild(r); }
    var EMOJI = ['🎮', '🕹️', '⚔️', '🏎️', '⛏️', '🧱', '🚀', '🌙', '🔥', '❄️', '🌊', '🌲', '🐉', '🦊', '🐸', '🐱', '🍕', '🎵', '🎨', '📚', '⚽', '🏀', '💎', '👾'];
    var COLORS = ['#5865f2', '#3d8bfd', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];
    function pickers(box, sv) {
      var pick = { emoji: sv ? sv.emoji : '🎮', color: sv ? sv.color : '#5865f2' };
      box.appendChild(el('span', 'cc-flab', 'Icon'));
      var eg = el('div', 'cc-emojis'); EMOJI.forEach(function (x) { var b = el('button', x === pick.emoji ? 'on' : '', x); b.onclick = function () { pick.emoji = x; Array.prototype.forEach.call(eg.children, function (c) { c.classList.toggle('on', c === b); }); }; eg.appendChild(b); });
      box.appendChild(eg);
      box.appendChild(el('span', 'cc-flab', 'Colour'));
      var cg = el('div', 'cc-colors'); COLORS.forEach(function (c) { var b = el('button', c === pick.color ? 'on' : ''); b.style.background = c; b.onclick = function () { pick.color = c; Array.prototype.forEach.call(cg.children, function (x) { x.classList.toggle('on', x === b); }); }; cg.appendChild(b); });
      box.appendChild(cg);
      return pick;
    }
    function addServer() {
      dialog('Add a server', function (box, close) {
        box.appendChild(el('p', 'cc-muted', 'Make a place for you and your friends, or join one with an invite code.'));
        var name = input(box, 'Server name', (S.me || 'My') + '’s server');
        var pick = pickers(box, null);
        btns(box, [['Cancel', close, 'ghost'], ['Create', function () {
          api('POST', '/api/concord/server/create', { name: name.value, emoji: pick.emoji, color: pick.color }).then(function (r) { close(); S.servers.push(r.server); openServer(r.server.id); }, function (e) { toast(e.message); });
        }, 'acc']]);
        box.appendChild(el('hr'));
        var code = input(box, 'Have an invite?', '', 'Invite code');
        btns(box, [['Join server', function () {
          api('POST', '/api/concord/join', { code: code.value }).then(function (r) { close(); if (!server(r.server.id)) S.servers.push(r.server); openServer(r.server.id); toast('Joined ' + r.server.name); }, function (e) { toast(e.message); });
        }, 'acc']]);
      });
    }
    function invite(sv) {
      api('POST', '/api/concord/invite', { server: sv.id }).then(function (r) {
        dialog('Invite friends to ' + sv.name, function (box, close) {
          if (r.code === 'lounge') { box.appendChild(el('p', null, 'Everyone on Mist is already in the Mist Lounge.')); btns(box, [['OK', close, 'acc']]); return; }
          box.appendChild(el('p', 'cc-muted', 'Send them this code. In Concord they press + and type it under “Have an invite?”. It works for 7 days.'));
          var c = el('div', 'cc-code-big', r.code); box.appendChild(c);
          var fl = friends();
          if (fl.length) {
            box.appendChild(el('span', 'cc-flab', 'Or send it to a friend'));
            var l = el('div', 'cc-invl');
            fl.slice(0, 30).forEach(function (f) {
              var row = el('div', 'cc-fr'); row.appendChild(avatar(f.name, 28, f.state)); row.appendChild(el('span', 'cc-dmt', f.name));
              var b = el('button', 'cc-btn', 'Send'); b.onclick = function () { b.disabled = true; api('POST', '/api/messages', { to: f.name, text: 'Join my Concord server “' + sv.name + '”! Invite code: ' + r.code }).then(function () { b.textContent = 'Sent'; }, function (e) { toast(e.message); b.disabled = false; }); };
              row.appendChild(b); l.appendChild(row);
            });
            box.appendChild(l);
          }
          btns(box, [['Copy code', function () { copy(r.code); }, 'ghost'], ['Done', close, 'acc']]);
        });
      }, function (e) { toast(e.message); });
    }
    function serverSettings(sv) {
      dialog('Server settings', function (box, close) {
        var name = input(box, 'Server name', sv.name); if (sv.official) name.disabled = true;
        var pick = pickers(box, sv);
        btns(box, [['Cancel', close, 'ghost'], ['Save', function () { post('/api/concord/server/edit', { server: sv.id, name: name.value, emoji: pick.emoji, color: pick.color }, 'Saved').then(close); }, 'acc']]);
      });
    }
    function newChannel(sv) {
      dialog('Create a channel', function (box, close) {
        var name = input(box, 'Channel name', '', 'new-channel'), topic = input(box, 'Topic (optional)', '');
        var ro = el('label', 'cc-chk'); var cb = el('input'); cb.type = 'checkbox'; ro.appendChild(cb); ro.appendChild(el('span', null, 'Only admins can post (announcements)')); box.appendChild(ro);
        btns(box, [['Cancel', close, 'ghost'], ['Create', function () { post('/api/concord/channel/create', { server: sv.id, name: name.value, topic: topic.value, readOnly: cb.checked }).then(function (r) { close(); setTimeout(function () { openServer(sv.id, r.channel); }, 400); }); }, 'acc']]);
      });
    }
    function editChannel(sv, c) {
      dialog('Edit #' + c.name, function (box, close) {
        var name = input(box, 'Channel name', c.name), topic = input(box, 'Topic', c.topic);
        var ro = el('label', 'cc-chk'); var cb = el('input'); cb.type = 'checkbox'; cb.checked = c.readOnly; ro.appendChild(cb); ro.appendChild(el('span', null, 'Only admins can post')); box.appendChild(ro);
        btns(box, [['Cancel', close, 'ghost'], ['Save', function () { post('/api/concord/channel/edit', { server: sv.id, channel: c.id, name: name.value, topic: topic.value, readOnly: cb.checked }, 'Saved').then(close); }, 'acc']]);
      });
    }

    function start() {
      gen++; polling = false; S = { servers: [], cursor: 0, me: null, admin: false }; cache = {}; typing = {}; unreadDm = {}; mentions = {};
      view = { kind: 'home', server: null, channel: null, dm: null, homeTab: 'online', members: true };
      if (eng()) load(); else shell.setBadge('concord', 0);
    }
    return {
      open: open, openDm: openDm, start: start,
      onAuthChange: function () { start(); if (!eng() && win) win.close(true); else if (ui) draw(); },
      onSocial: function () {
        var d = soc() && soc().data(), sig = d ? JSON.stringify([d.friends.map(function (f) { return [f.name, f.state, f.game, f.unread, f.last && f.last.at]; }), d.incoming, d.outgoing]) : '';
        if (ui && view.kind === 'home' && sig !== lastSocialSig) { drawSide(); if (!view.dm && view.homeTab !== 'add') drawMain(); drawRail(); }
        lastSocialSig = sig; badge();
      }
    };
  };
})();

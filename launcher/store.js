/* Panes Store: optional apps people can install on their Panes desktop (Mist, Concord, Gleam and Settings are
 * always there). Installs are kept with the person's Panes settings, so they follow their account.
 * Also holds Imitator, the first Store app: an all-in-one emulator served by the Panes server at /imitator/. */
(function () {
  'use strict';

  var CATALOG = [
    {
      id: 'imitator', name: 'Imitator', dev: 'Panes', category: 'Games', color: '#ff5a5a',
      tagline: 'Every classic console in one app. Bring your own games.',
      about: 'Imitator plays games from your own collection, right in Panes. Add ROM or disc files and it works out the console for you, keeps your saves, and supports keyboard and controllers. Your games stay in this browser; nothing is uploaded.',
      features: [
        ['🎮', 'Nintendo', 'NES, SNES, Nintendo 64, Game Boy, Game Boy Color, Game Boy Advance, Nintendo DS, Virtual Boy'],
        ['💿', 'PlayStation', 'PlayStation 1 and PSP'],
        ['🔵', 'Sega', 'Master System, Genesis / Mega Drive, Game Gear, Sega CD, 32X, Saturn'],
        ['🕹️', 'And more', 'Atari 2600 / 5200 / 7800 / Lynx / Jaguar, TurboGrafx-16, Neo Geo Pocket, WonderSwan, 3DO, ColecoVision, arcade (FinalBurn Neo, MAME), Commodore 64, Amiga, MS-DOS'],
        ['🖥️', 'Bigger consoles', 'PS2, PS3, Xbox, Xbox 360, GameCube, Wii and Wii U are too heavy for any browser. Imitator links the right PC emulator and streams it in with Mist PC Connect.']
      ],
      notes: 'Uses EmulatorJS and RetroArch cores (GPL-3.0). Only play games you own.'
    }
  ];

  window.PanesStore = function (o) {
    var el = o.el, shell = o.shell, win = null, current = null;

    function open(arg) {
      if (win) { win.show(); draw(arg && arg.app); return win; }
      win = shell.openWindow({ app: 'store', title: 'Panes Store', cls: 'win-store', width: 980, height: 680, minW: 520, minH: 420,
        onClosed: function () { win = null; } });
      win.body.classList.add('ps');
      draw(arg && arg.app);
      return win;
    }
    function btnFor(app, big) {
      var row = el('div', 'ps-acts');
      if (shell.installed(app.id)) {
        var op = el('button', 'sh-btn acc' + (big ? ' ps-big' : ''), 'Open'); op.onclick = function (e) { e.stopPropagation(); shell.launch(app.id); }; row.appendChild(op);
        if (big) { var un = el('button', 'sh-btn ps-big', 'Uninstall'); un.onclick = function () { uninstall(app); }; row.appendChild(un); }
      } else {
        var ins = el('button', 'sh-btn acc' + (big ? ' ps-big' : ''), 'Install'); ins.onclick = function (e) { e.stopPropagation(); install(app, ins); }; row.appendChild(ins);
      }
      return row;
    }
    function install(app, b) {
      b.disabled = true; b.textContent = 'Installing…';
      setTimeout(function () {
        shell.install(app.id);
        o.toast(app.name + ' is installed. It’s on your taskbar and in Start.');
        if (win) draw(current);
      }, 500);
    }
    function uninstall(app) {
      if (!confirm('Uninstall ' + app.name + '?' + (app.id === 'imitator' ? '\n\nYour games and saves stay in this browser, so they’re still there if you install it again.' : ''))) return;
      shell.uninstall(app.id);
      if (win) draw(current);
    }
    function draw(id) {
      current = id && CATALOG.some(function (a) { return a.id === id; }) ? id : null;
      var b = win.body; b.textContent = '';
      var top = el('div', 'ps-top');
      if (current) { var back = el('button', 'ps-back', '‹'); back.title = 'Back'; back.onclick = function () { draw(null); }; top.appendChild(back); }
      top.appendChild(shell.appIcon('store', 26)); top.appendChild(el('b', null, 'Panes Store'));
      b.appendChild(top);
      var page = el('div', 'ps-page'); b.appendChild(page);
      if (current) return detail(page, CATALOG.filter(function (a) { return a.id === current; })[0]);
      // home
      var feat = CATALOG[0], hero = el('div', 'ps-hero'); hero.style.setProperty('--c', feat.color);
      var ht = el('div', 'ps-htxt'); ht.appendChild(el('small', null, 'NEW IN PANES'));
      ht.appendChild(el('h1', null, feat.name)); ht.appendChild(el('p', null, feat.tagline)); ht.appendChild(btnFor(feat, true));
      hero.appendChild(ht); hero.appendChild(shell.appIcon(feat.id, 150));
      hero.onclick = function (e) { if (!e.target.closest('button')) draw(feat.id); };
      page.appendChild(hero);
      page.appendChild(el('h2', 'ps-h', 'Apps'));
      var grid = el('div', 'ps-grid');
      CATALOG.forEach(function (a) {
        var c = el('div', 'ps-card'); c.onclick = function (e) { if (!e.target.closest('button')) draw(a.id); };
        c.appendChild(shell.appIcon(a.id, 56));
        var t = el('div', 'ps-ct'); t.appendChild(el('b', null, a.name)); t.appendChild(el('small', null, a.category + ' · ' + a.dev)); t.appendChild(el('p', null, a.tagline));
        c.appendChild(t); c.appendChild(btnFor(a, false));
        grid.appendChild(c);
      });
      page.appendChild(grid);
      page.appendChild(el('p', 'ps-more', 'More apps are on the way.'));
    }
    function detail(page, a) {
      var head = el('div', 'ps-dhead'); head.appendChild(shell.appIcon(a.id, 104));
      var t = el('div', 'ps-dt'); t.appendChild(el('h1', null, a.name)); t.appendChild(el('small', null, a.dev + ' · ' + a.category + ' · Free'));
      t.appendChild(el('p', null, a.tagline)); t.appendChild(btnFor(a, true)); head.appendChild(t);
      page.appendChild(head);
      page.appendChild(el('p', 'ps-about', a.about));
      var f = el('div', 'ps-feats');
      a.features.forEach(function (x) { var r = el('div', 'ps-feat'); r.appendChild(el('span', 'ps-fi', x[0])); var d = el('div'); d.appendChild(el('b', null, x[1])); d.appendChild(el('p', null, x[2])); r.appendChild(d); f.appendChild(r); });
      page.appendChild(f);
      if (a.notes) page.appendChild(el('p', 'ps-note', a.notes));
    }
    shell.onPrefs(function (what) { if (what === 'apps' && win) draw(current); });
    return { open: open, reopen: function (w, arg) { draw(arg && arg.app || current); }, catalog: CATALOG };
  };

  /* ---------------------------------------------------------------- Imitator window */
  window.PanesImitator = function (o) {
    var el = o.el, shell = o.shell, wins = [];
    function base() { var s = o.server(); return s ? s.replace(/\/+$/, '') + '/imitator/' : null; }
    function open() {
      var url = base();
      var w = shell.openWindow({ app: 'imitator', title: 'Imitator', cls: 'win-imitator', width: 1120, height: 720, minW: 520, minH: 380,
        onClose: function () { return beforeClose(w); }, onClosed: function () { wins = wins.filter(function (x) { return x !== w; }); } });
      wins.push(w);
      if (!url) { w.body.classList.add('sh-signin'); w.body.appendChild(shell.appIcon('imitator', 64)); w.body.appendChild(el('h2', null, 'Imitator needs a Panes server')); w.body.appendChild(el('p', null, 'Set one up in Settings › Account.')); return w; }
      var f = document.createElement('iframe');
      f.className = 'im-frame'; f.src = url;
      f.setAttribute('allow', 'fullscreen; gamepad; autoplay; clipboard-write; screen-wake-lock; cross-origin-isolated');
      f.setAttribute('allowfullscreen', '');
      w.body.appendChild(f); w.frame = f; w.playing = false;
      return w;
    }
    // give a running game the chance to write its save data before the window goes away
    function beforeClose(w) {
      if (!w.playing || !w.frame || w.closing) return true;
      w.closing = true;
      var done = false;
      function finish() { if (done) return; done = true; w.close(true); }
      w.onSaved = finish;
      try { w.frame.contentWindow.postMessage({ panes: 'save' }, '*'); } catch (e) { return true; }
      setTimeout(finish, 1500);
      return false;
    }
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || typeof d !== 'object' || !d.imitator) return;
      var w = null; wins.forEach(function (x) { if (x.frame && x.frame.contentWindow === e.source) w = x; });
      if (!w) return;
      if (d.title) { w.playing = d.title !== 'Imitator'; if (w.setTitle) w.setTitle(d.title === 'Imitator' ? 'Imitator' : d.title + ' · Imitator'); }
      if (d.started) w.playing = true;
      if (d.saved && w.onSaved) w.onSaved();
      if (typeof d.gleam === 'string' && /^https:\/\//.test(d.gleam)) shell.launch('gleam', d.gleam);
      if (d.open === 'mistpc') shell.launch('mist', { page: 'pc' });
    });
    return { open: open };
  };
})();

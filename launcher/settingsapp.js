/*!
 * Settings — the Mist desktop's settings app: personalisation (theme, accent, wallpaper, lock screen,
 * transparency, size), taskbar, desktop icons, notifications, account, Mist's game & save settings, about.
 * Changes apply immediately and follow the account to any computer (guests keep them on this one).
 */
(function () {
  'use strict';
  window.MistSettings = function (o) {
    var el = o.el, shell = o.shell, toast = o.toast;
    var win = null, nav = null, pane = null, page = 'personal';
    var ACCENTS = ['#3d8bfd', '#0ea5e9', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#94a3b8'];
    var SOLIDS = ['#0f172a', '#1b2838', '#1f2937', '#111827', '#3b0764', '#14532d', '#7c2d12', '#0c4a6e', '#831843', '#374151', '#000000', '#e5e7eb'];
    var PAGES = [['personal', '🎨', 'Personalisation'], ['taskbar', '▭', 'Taskbar & Start'], ['desktop', '🖥', 'Desktop'], ['notifs', '🔔', 'Notifications'],
      ['account', '👤', 'Account'], ['games', '🎮', 'Games & saves'], ['about', 'ℹ', 'About']];

    function P() { return shell.prefs(); }
    function set(k, v) { shell.setPref(k, v); if (win) draw(); }

    function open(which) {
      if (typeof which === 'string') page = which;
      if (win && document.body.contains(win.el)) { win.show(); draw(); return win; }
      win = shell.openWindow({ app: 'settings', title: 'Settings', width: 920, height: 640, minW: 520, minH: 380, cls: 'win-settings',
        onClosed: function () { if (o.onGamesClosed) o.onGamesClosed(); win = null; } });
      var wrap = el('div', 'st'); nav = el('nav', 'st-nav'); pane = el('div', 'st-pane');
      wrap.appendChild(nav); wrap.appendChild(pane); win.body.appendChild(wrap);
      draw();
      return win;
    }
    shell.onPrefs(function () { /* redraw lazily when other places change prefs */ });

    function draw() {
      if (!win) return;
      nav.textContent = '';
      var who = el('div', 'st-who');
      var e = o.getEngine(), signed = e && e.signedIn();
      if (signed && o.avatar) who.appendChild(o.avatar(e.user, 44)); else who.appendChild(el('span', 'st-gav', '👤'));
      var wt = el('div'); wt.appendChild(el('b', null, signed ? e.user : 'Guest')); wt.appendChild(el('small', null, signed ? 'Mist account' : 'Not signed in')); who.appendChild(wt);
      nav.appendChild(who);
      PAGES.forEach(function (p) {
        var b = el('button', 'st-nb' + (p[0] === page ? ' on' : ''));
        b.appendChild(el('span', 'st-ni', p[1])); b.appendChild(el('span', null, p[2]));
        b.onclick = function () { page = p[0]; draw(); pane.scrollTop = 0; };
        nav.appendChild(b);
      });
      if (o.onGamesClosed && page !== 'games') o.onGamesClosed();
      pane.textContent = '';
      ({ personal: personal, taskbar: taskbar, desktop: desktop, notifs: notifs, account: account, games: games, about: about })[page]();
    }

    /* ---------------- building blocks ---------------- */
    function h(t, sub) { pane.appendChild(el('h1', null, t)); if (sub) pane.appendChild(el('p', 'st-sub', sub)); }
    function section(t) { var s = el('section', 'st-sec'); if (t) s.appendChild(el('h3', null, t)); pane.appendChild(s); return s; }
    function row(parent, title, sub, control) {
      var r = el('div', 'st-row'), t = el('div', 'st-rt');
      t.appendChild(el('b', null, title)); if (sub) t.appendChild(el('small', null, sub));
      r.appendChild(t); if (control) r.appendChild(control); parent.appendChild(r); return r;
    }
    function toggle(on, fn) {
      var b = el('button', 'st-tog' + (on ? ' on' : '')); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.appendChild(el('i')); b.appendChild(el('span', null, on ? 'On' : 'Off'));
      b.onclick = function () { fn(!on); };
      return b;
    }
    function seg(options, value, fn) {
      var s = el('div', 'st-seg');
      options.forEach(function (op) { var b = el('button', op[0] === value ? 'on' : '', op[1]); b.onclick = function () { fn(op[0]); }; s.appendChild(b); });
      return s;
    }
    function swatches(list, value, fn, cls) {
      var s = el('div', 'st-sw' + (cls ? ' ' + cls : ''));
      list.forEach(function (c) { var b = el('button', c.toLowerCase() === String(value).toLowerCase() ? 'on' : ''); b.style.background = c; b.title = c; b.onclick = function () { fn(c); }; s.appendChild(b); });
      return s;
    }
    function colorPick(value, fn) {
      var l = el('label', 'st-cp'); var i = el('input'); i.type = 'color'; i.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#3d8bfd';
      i.onchange = function () { fn(i.value); }; l.appendChild(i); l.appendChild(el('span', null, 'Custom…')); return l;
    }

    /* ---------------- Personalisation ---------------- */
    function personal() {
      var p = P();
      h('Personalisation', 'Wallpaper, colours and how the desktop looks. Changes save to your account.');
      var prev = el('div', 'st-prev'); prev.style.background = shell.wallCss(p.wallpaper);
      var mini = el('div', 'st-prev-bar'); mini.style.background = p.theme === 'light' ? 'rgba(243,245,248,.85)' : 'rgba(28,31,37,.8)'; prev.appendChild(mini);
      var mw = el('div', 'st-prev-win'); mw.style.background = p.theme === 'light' ? '#f7f8fa' : '#1d2026'; var mwb = el('i'); mwb.style.background = p.accent; mw.appendChild(mwb); prev.appendChild(mw);
      pane.appendChild(prev);

      var s1 = section('Colours');
      row(s1, 'Mode', 'Dark is easier on the eyes; light suits bright rooms.', seg([['dark', '🌙 Dark'], ['light', '☀️ Light']], p.theme, function (v) { set('theme', v); }));
      var acc = el('div', 'st-col'); acc.appendChild(swatches(ACCENTS, p.accent, function (c) { set('accent', c); }, 'round')); acc.appendChild(colorPick(p.accent, function (c) { set('accent', c); }));
      row(s1, 'Accent colour', 'Used for the Start button, highlights, buttons and the active window.', acc);
      row(s1, 'Transparency effects', 'Frosted-glass taskbar, Start menu and notifications.', toggle(p.transparency, function (v) { set('transparency', v); }));
      row(s1, 'Animations', 'Windows and menus fade and slide.', toggle(p.animations, function (v) { set('animations', v); }));
      row(s1, 'Rounded corners', null, toggle(p.corners !== 'square', function (v) { set('corners', v ? 'round' : 'square'); }));
      var sz = el('div', 'st-range'), rr = el('input'); rr.type = 'range'; rr.min = 80; rr.max = 130; rr.step = 5; rr.value = p.scale || 100;
      var rv = el('span', null, (p.scale || 100) + '%'); rr.oninput = function () { rv.textContent = rr.value + '%'; }; rr.onchange = function () { set('scale', +rr.value); };
      sz.appendChild(rr); sz.appendChild(rv);
      row(s1, 'Text and icon size', 'For the taskbar, Start, windows and these settings.', sz);

      var s2 = section('Wallpaper');
      var kind = p.wallpaper.type || 'preset';
      row(s2, 'Background', null, seg([['preset', 'Picture'], ['color', 'Solid colour'], ['gradient', 'Gradient'], ['image', 'Your photo']], kind, function (v) {
        if (v === 'preset') set('wallpaper', { type: 'preset', id: 'mist' });
        else if (v === 'color') set('wallpaper', { type: 'color', color: '#1b2838' });
        else if (v === 'gradient') set('wallpaper', { type: 'gradient', a: '#1d4ed8', b: '#9333ea', angle: 135 });
        else { var w = p.wallpaper; set('wallpaper', { type: 'image', data: w.type === 'image' ? w.data : '', url: w.type === 'image' ? w.url : '', fit: 'fill' }); }
      }));
      if (kind === 'preset') {
        var g = el('div', 'st-walls');
        Object.keys(shell.walls).forEach(function (id) {
          var b = el('button', 'st-wall' + (p.wallpaper.id === id ? ' on' : '')); var th = el('i'); th.style.background = shell.wallCss({ type: 'preset', id: id }); b.appendChild(th);
          b.appendChild(el('span', null, shell.walls[id].name)); b.onclick = function () { set('wallpaper', { type: 'preset', id: id }); }; g.appendChild(b);
        });
        s2.appendChild(g);
      } else if (kind === 'color') {
        var cc = el('div', 'st-col'); cc.appendChild(swatches(SOLIDS, p.wallpaper.color, function (c) { set('wallpaper', { type: 'color', color: c }); })); cc.appendChild(colorPick(p.wallpaper.color, function (c) { set('wallpaper', { type: 'color', color: c }); }));
        row(s2, 'Colour', null, cc);
      } else if (kind === 'gradient') {
        var w = p.wallpaper;
        row(s2, 'From', null, colorPick(w.a, function (c) { set('wallpaper', Object.assign({}, w, { a: c })); }));
        row(s2, 'To', null, colorPick(w.b, function (c) { set('wallpaper', Object.assign({}, w, { b: c })); }));
        var ang = el('div', 'st-range'), ar = el('input'); ar.type = 'range'; ar.min = 0; ar.max = 360; ar.step = 15; ar.value = w.angle || 135;
        var av = el('span', null, (w.angle || 135) + '°'); ar.oninput = function () { av.textContent = ar.value + '°'; }; ar.onchange = function () { set('wallpaper', Object.assign({}, w, { angle: +ar.value })); };
        ang.appendChild(ar); ang.appendChild(av); row(s2, 'Angle', null, ang);
      } else {
        var wi = p.wallpaper;
        var up = el('button', 'st-btn acc', 'Choose a photo…');
        var file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
        file.onchange = function () { var f = file.files[0]; file.value = ''; if (f) shrink(f).then(function (data) { set('wallpaper', { type: 'image', data: data, fit: wi.fit || 'fill' }); toast('Wallpaper set'); }, function (e) { toast(e.message); }); };
        up.onclick = function () { file.click(); };
        var uc = el('div', 'st-col'); uc.appendChild(up); uc.appendChild(file);
        row(s2, 'Photo from this computer', 'Shrunk to fit your screen so it syncs to your account.', uc);
        var url = el('input', 'st-in'); url.placeholder = 'https://… (link to an image)'; url.value = wi.url || ''; url.spellcheck = false;
        url.onchange = function () { var v = url.value.trim(); if (v && !/^https:\/\//i.test(v)) { toast('Use an https:// link'); return; } set('wallpaper', { type: 'image', url: v, data: '', fit: wi.fit || 'fill' }); };
        row(s2, 'Or a link to an image', null, url);
        var fit = el('select', 'st-sel'); [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch'], ['center', 'Centre'], ['tile', 'Tile']].forEach(function (f) { var op = el('option', null, f[1]); op.value = f[0]; if ((wi.fit || 'fill') === f[0]) op.selected = true; fit.appendChild(op); });
        fit.onchange = function () { set('wallpaper', Object.assign({}, wi, { fit: fit.value })); };
        row(s2, 'Fit', null, fit);
      }

      var s3 = section('Lock screen');
      var lw = p.lockWallpaper === 'same' || !p.lockWallpaper ? 'same' : p.lockWallpaper.id;
      var lsel = el('select', 'st-sel'); var o1 = el('option', null, 'Same as the desktop'); o1.value = 'same'; lsel.appendChild(o1);
      Object.keys(shell.walls).forEach(function (id) { var op = el('option', null, shell.walls[id].name); op.value = id; if (lw === id) op.selected = true; lsel.appendChild(op); });
      lsel.onchange = function () { set('lockWallpaper', lsel.value === 'same' ? 'same' : { type: 'preset', id: lsel.value }); };
      row(s3, 'Lock screen picture', 'Shown when Mist starts and when you lock it.', lsel);
      row(s3, '24-hour clock', null, toggle(p.clock24, function (v) { set('clock24', v); }));
    }
    // Make a photo small enough to store and sync (max 1920×1080, JPEG)
    function shrink(file) {
      return new Promise(function (res, rej) {
        if (!/^image\//.test(file.type)) return rej(new Error('That isn’t a picture.'));
        var img = new Image(), u = URL.createObjectURL(file);
        img.onload = function () {
          var s = Math.min(1, 1920 / img.naturalWidth, 1080 / img.naturalHeight), c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(u);
          var q = 0.85, d = c.toDataURL('image/jpeg', q);
          while (d.length > 900000 && q > 0.4) { q -= 0.1; d = c.toDataURL('image/jpeg', q); }
          res(d);
        };
        img.onerror = function () { URL.revokeObjectURL(u); rej(new Error('Couldn’t open that picture.')); };
        img.src = u;
      });
    }

    /* ---------------- Taskbar ---------------- */
    function taskbar() {
      var p = P();
      h('Taskbar & Start');
      var s = section('Taskbar');
      row(s, 'Position', null, seg([['bottom', 'Bottom'], ['top', 'Top']], p.taskbarPos, function (v) { set('taskbarPos', v); }));
      row(s, 'Alignment', 'Where the Start button and app icons sit.', seg([['center', 'Centre'], ['left', 'Left']], p.taskbarAlign, function (v) { set('taskbarAlign', v); }));
      row(s, 'Hide the taskbar automatically', 'It slides back when you point at the edge of the screen.', toggle(p.autoHide, function (v) { set('autoHide', v); }));
      var s2 = section('Clock');
      row(s2, '24-hour clock', null, toggle(p.clock24, function (v) { set('clock24', v); }));
      row(s2, 'Show seconds', null, toggle(p.clockSeconds, function (v) { set('clockSeconds', v); }));
      row(s2, 'Show the date', null, toggle(p.showDate, function (v) { set('showDate', v); }));
      var s3 = section('Pinned apps');
      ['mist', 'concord', 'gleam', 'settings'].forEach(function (id) {
        var pinned = (p.pinned || []).indexOf(id) >= 0;
        var r = row(s3, ({ mist: 'Mist', concord: 'Concord', gleam: 'Gleam', settings: 'Settings' })[id], null, toggle(pinned, function (v) {
          var list = (p.pinned || []).filter(function (x) { return x !== id; }); if (v) list.push(id); set('pinned', list); shell.refreshDesktop();
        }));
        r.insertBefore(shell.appIcon(id, 28), r.firstChild);
      });
    }

    /* ---------------- Desktop ---------------- */
    function desktop() {
      var p = P();
      h('Desktop');
      var s = section('Icons');
      row(s, 'Icon size', null, seg([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], p.iconSize, function (v) { set('iconSize', v); shell.refreshDesktop(); }));
      row(s, 'Game shortcuts', 'Put every game you’ve installed in Mist on the desktop.', toggle(p.gameIcons, function (v) { set('gameIcons', v); shell.refreshDesktop(); }));
      row(s, 'Show names under icons', null, toggle(p.iconLabels, function (v) { set('iconLabels', v); }));
      row(s, 'Arrange icons', 'Put every icon back in a tidy column.', btn('Arrange', function () { shell.setPref('iconPos', {}, true); shell.refreshDesktop(); toast('Icons arranged'); }));
      var s2 = section('Windows');
      row(s2, 'Open Mist when you sign in', null, toggle(p.openMist !== false, function (v) { set('openMist', v); }));
      row(s2, 'Forget window sizes', 'Apps open at their normal size and place next time.', btn('Reset', function () { shell.setPref('windows', {}, true); toast('Window sizes reset'); }));
      var s3 = section('Tips');
      ['Drag a window by its title bar. Drag it to the top of the screen to maximise it, or to the left or right edge to fill half the screen.',
       'Double-click a title bar to maximise or restore it. The ⛶ button makes a window fill your whole screen (Esc to leave).',
       'Drag desktop icons anywhere; right-click the desktop to tidy them.'].forEach(function (t) { s3.appendChild(el('p', 'st-tip', t)); });
    }
    function btn(t, fn, cls) { var b = el('button', 'st-btn' + (cls ? ' ' + cls : ''), t); b.onclick = fn; return b; }

    /* ---------------- Notifications ---------------- */
    function notifs() {
      var p = P();
      h('Notifications');
      var s = section();
      row(s, 'Do not disturb', 'Notifications still collect in the clock panel, but don’t pop up.', toggle(p.dnd, function (v) { set('dnd', v); }));
      row(s, 'Play a sound', null, toggle(p.notifSound, function (v) { set('notifSound', v); }));
      row(s, 'Concord messages', 'Which Concord messages pop up when Concord isn’t in front.', seg([['all', 'All'], ['mentions', 'DMs & mentions'], ['off', 'None']], p.concordNotif || 'mentions', function (v) { set('concordNotif', v); }));
    }

    /* ---------------- Account ---------------- */
    function account() {
      var e = o.getEngine(), signed = e && e.signedIn();
      h('Account');
      var card = el('div', 'st-acct');
      if (signed && o.avatar) card.appendChild(o.avatar(e.user, 72)); else card.appendChild(el('span', 'st-gav big', '👤'));
      var t = el('div'); t.appendChild(el('b', null, signed ? e.user : 'Guest'));
      t.appendChild(el('small', null, signed ? 'Your games, saves, friends and settings follow this account.' : 'Sign in to sync saves, use Concord and Gleam, and keep these settings everywhere.'));
      card.appendChild(t); pane.appendChild(card);
      var s = section();
      if (!signed) {
        row(s, 'Sign in', null, btn('Sign in', function () { shell.switchUser('login'); }, 'acc'));
        row(s, 'Create a free account', null, btn('Create account', function () { shell.switchUser('register'); }));
        return;
      }
      row(s, 'Profile', 'Avatar, colour, bio and favourite game.', btn('Edit profile', function () { if (o.editProfile) o.editProfile(); }));
      row(s, 'Mist Supporter', '$5/month: Mist PC, gold outline, extra avatars and more.', btn('💛 Support Mist', function () { if (o.openSupport) o.openSupport(); }));
      row(s, 'Password', null, btn('Change password', function () { if (o.changePassword) o.changePassword(); }));
      row(s, 'Cloud saves', 'Back up this computer’s game saves now.', btn('Sync now', function () { if (o.syncNow) o.syncNow(); }));
      var adminRow = row(s, 'Admin dashboard', 'Announcements, players, bans.', btn('Open', function () { if (o.openAdmin) o.openAdmin(); }));
      adminRow.style.display = 'none';
      e.api('GET', '/api/me').then(function (d) { if (d && d.admin) adminRow.style.display = ''; }, function () {});
      var s2 = section();
      row(s2, 'Lock', 'Go back to the sign-in screen without signing out.', btn('Lock', function () { shell.lock(); }));
      row(s2, 'Sign out', 'Games and saves on this computer stay here.', btn('Sign out', function () { shell.signOut(); }, 'danger'));
    }

    /* ---------------- Games & saves (Mist's own settings) ---------------- */
    function games() {
      h('Games & saves', 'How Mist runs games and where your saves go.');
      if (o.gamesPanel) { var host = el('div', 'st-games'); pane.appendChild(host); o.gamesPanel(host); }
    }

    /* ---------------- About ---------------- */
    function about() {
      h('About');
      var card = el('div', 'st-acct'); card.appendChild(shell.appIcon('mist', 64));
      var t = el('div'); t.appendChild(el('b', null, 'Mist')); t.appendChild(el('small', null, 'A desktop for your games, friends and the web. Runs in a browser tab.')); card.appendChild(t);
      pane.appendChild(card);
      var s = section();
      var e = o.getEngine();
      row(s, 'Mist server', e ? e.server : 'Not set', null);
      row(s, 'Version', o.version || '', null);
      row(s, 'Apps', 'Mist (games), Concord (chat), Gleam (web), Settings', null);
      var s2 = section('Reset');
      row(s2, 'Reset personalisation', 'Wallpaper, colours, taskbar and icons go back to normal.', btn('Reset', function () {
        if (!confirm('Reset wallpaper, colours, taskbar and icon settings?')) return;
        var d = shell.defaults; Object.keys(d).forEach(function (k) { shell.setPref(k, JSON.parse(JSON.stringify(d[k])), true); }); shell.setPref('_reset', Date.now()); shell.refreshDesktop(); draw();
      }, 'danger'));
    }

    return { open: open, isOpen: function () { return !!win; }, redraw: function () { if (win) draw(); } };
  };
})();

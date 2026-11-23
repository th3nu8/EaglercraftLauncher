/*!
 * Panes — a Windows-style desktop that runs inside the browser tab (formerly the Mist desktop).
 * Sign-in (lock) screen, desktop with icons, taskbar, Start menu, notifications and a window manager:
 * every window can be dragged, resized, snapped, minimised, maximised, made full screen and closed.
 * Apps register with MistShell; app.js registers Mist, Concord, Gleam and Settings, and game windows.
 */
(function () {
  'use strict';

  window.MistShell = function (ctx) {
    var el = ctx.el;
    var SNAP = 14, TASKBAR_H = 48, MIN_W = 320, MIN_H = 200;
    var apps = {}, appOrder = [], wins = [], zTop = 100, uid = 0, locked = true, guest = false;
    var prefs = null, prefsUser = null, pushTimer = null, notifs = [], badges = {};
    var root = el('div', 'sh'); root.id = 'shell';
    var wall = el('div', 'sh-wall');
    var desk = el('div', 'sh-desk');
    var icons = el('div', 'sh-icons');
    var area = el('div', 'sh-area');           // windows live here (screen minus taskbar)
    var snapPrev = el('div', 'sh-snap');
    var bar = el('div', 'sh-bar');
    var startPanel = el('div', 'sh-start');
    var notifPanel = el('div', 'sh-notifs');
    var popups = el('div', 'sh-pops');
    var lock = el('div', 'sh-lock');
    desk.appendChild(icons); area.appendChild(snapPrev);
    root.appendChild(wall); root.appendChild(desk); root.appendChild(area); root.appendChild(bar);
    root.appendChild(startPanel); root.appendChild(notifPanel); root.appendChild(popups); root.appendChild(lock);
    document.body.appendChild(root);
    document.body.classList.add('sh-on');

    function eng() { var e = ctx.getEngine(); return e && e.signedIn() ? e : null; }
    function me() { var e = eng(); return e ? e.user : null; }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function svgUrl(s) { return 'url("data:image/svg+xml,' + encodeURIComponent(s) + '")'; }

    /* ================================================================ preferences */
    var DEFAULTS = {
      osTheme: 'panes', theme: 'dark', accent: '#5b68f0', wallpaper: { type: 'preset', id: 'mist' }, lockWallpaper: 'same',
      transparency: true, animations: true, corners: 'round', scale: 100,
      taskbarPos: 'bottom', taskbarAlign: 'center', autoHide: false, clock24: false, clockSeconds: false, showDate: true,
      iconSize: 'medium', gameIcons: true, iconLabels: true, iconPos: {}, windows: {}, pinned: ['mist', 'concord', 'gleam', 'settings'],
      notifSound: false, dnd: false
    };
    function prefsKey(u) { return 'shellPrefs:' + (u || 'guest'); }
    function loadPrefs(u) {
      prefsUser = u || null;
      prefs = Object.assign({}, DEFAULTS, ctx.storeGet(prefsKey(u), {}) || {});
      applyPrefs();
      if (!u || !eng()) return Promise.resolve();
      return eng().api('GET', '/api/prefs').then(function (r) {
        if (prefsUser !== u || !r || !r.prefs) return;
        var local = ctx.storeGet(prefsKey(u), {}) || {};
        if (!local._at || (r.prefs._at || 0) > local._at) {
          prefs = Object.assign({}, DEFAULTS, r.prefs);
          ctx.storeSet(prefsKey(u), prefs);
          applyPrefs(); drawIcons(); drawBar();
        }
      }, function () {});
    }
    function setPref(k, v, quiet) {
      prefs[k] = v; prefs._at = Date.now();
      ctx.storeSet(prefsKey(prefsUser), prefs);
      if (!quiet) applyPrefs();
      if (prefsUser && eng()) {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(function () {
          var e = eng(); if (!e || prefsUser !== e.user) return;
          e.api('POST', '/api/prefs', { json: { prefs: prefs } }).catch(function (er) { if (er && er.status === 413) ctx.toast('That wallpaper is too big to sync to your account. It’s kept on this computer.'); });
        }, 1200);
      }
      notify('prefs');
    }
    var prefListeners = [];
    function notify(what) { prefListeners.forEach(function (f) { try { f(what); } catch (e) {} }); }

    function applyPrefs() {
      var p = prefs, b = document.body;
      b.classList.toggle('sh-light', p.theme === 'light' && !themeOf(p).fixed);   // the retro looks have their own colours
      b.classList.toggle('sh-solid', !p.transparency);
      b.classList.toggle('sh-noanim', !p.animations);
      b.classList.toggle('sh-square', p.corners === 'square');
      var T = themeOf(p), own = T.layout !== 'bar';   // themes with their own layout ignore taskbar position / auto-hide
      THEMES.forEach(function (x) { b.classList.remove('os-' + x.id); b.classList.remove('osf-' + x.family); });
      ['osl-bar', 'osl-dock', 'osl-side', 'osl-mbar'].forEach(function (c) { b.classList.remove(c); });
      b.classList.add('os-' + T.id); b.classList.add('osf-' + T.family); b.classList.add('osl-' + T.layout);
      if (T.layout !== 'bar') b.classList.add('osl-mbar');
      b.classList.toggle('sh-top', p.taskbarPos === 'top' && !own);
      b.classList.toggle('sh-left', p.taskbarAlign === 'left');
      b.classList.toggle('sh-autohide', !!p.autoHide && !own);
      b.classList.toggle('sh-nolabels', !p.iconLabels);
      b.dataset.icons = p.iconSize;
      var a = /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : DEFAULTS.accent;
      root.style.setProperty('--acc', a);
      root.style.setProperty('--acc-soft', hexA(a, 0.18));
      root.style.setProperty('--acc-text', contrast(a));
      root.style.setProperty('--ui', (clamp(+p.scale || 100, 80, 130) / 100).toFixed(2));
      setWall(wall, p.wallpaper);
      setWall(lockBg, p.lockWallpaper === 'same' || !p.lockWallpaper ? p.wallpaper : p.lockWallpaper);
      drawClock();
      layoutAll();
    }
    function hexA(h, a) { var n = parseInt(h.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
    function contrast(h) { var n = parseInt(h.slice(1), 16), r = n >> 16, g = n >> 8 & 255, b = n & 255; return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff'; }

    /* ================================================================ wallpapers (drawn, no image files) */
    function rnd(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
    function ridge(r, y, amp, n, W, H) {
      var pts = [], x, yy = y;
      for (x = 0; x <= W; x += W / n) { yy = clamp(yy + (r() - 0.5) * amp, y - amp * 1.4, y + amp * 1.4); pts.push(x.toFixed(0) + ',' + yy.toFixed(0)); }
      return 'M0,' + H + ' L' + pts.join(' L') + ' L' + W + ',' + H + ' Z';
    }
    var WALLS = {
      mist: { name: 'Misty peaks', thumb: '#5c7fa8', css: function () {
        var r = rnd(11), W = 1600, H = 900, s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">' +
          '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a44"/><stop offset=".55" stop-color="#4f6f99"/><stop offset="1" stop-color="#c3d3e6"/></linearGradient>' +
          '<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#e6eef7" stop-opacity=".75"/></linearGradient></defs>' +
          '<rect width="1600" height="900" fill="url(#s)"/><circle cx="1180" cy="250" r="70" fill="#fff6dc" opacity=".55"/>';
        [['#30496d', 430, 90], ['#3d5a82', 520, 70], ['#56739a', 610, 55], ['#7290b3', 700, 45], ['#94aecb', 790, 30]].forEach(function (L, i) {
          s += '<path d="' + ridge(r, L[1], L[2], 40, W, H) + '" fill="' + L[0] + '"/>';
          s += '<rect y="' + (L[1] - 40) + '" width="1600" height="' + (H - L[1] + 40) + '" fill="url(#f)" opacity="' + (0.35 + i * 0.08).toFixed(2) + '"/>';
        });
        return svgUrl(s + '</svg>') + ' center/cover';
      } },
      aurora: { name: 'Aurora', thumb: '#1c8c7a', css: function () {
        var r = rnd(5), s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs>' +
          '<linearGradient id="k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#030712"/><stop offset="1" stop-color="#0b1d33"/></linearGradient>' +
          '<filter id="b"><feGaussianBlur stdDeviation="28"/></filter>' +
          '<linearGradient id="a1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5df2c4" stop-opacity="0"/><stop offset=".5" stop-color="#3ee6a8"/><stop offset="1" stop-color="#1aa6c9" stop-opacity="0"/></linearGradient>' +
          '<linearGradient id="a2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b46cff" stop-opacity="0"/><stop offset=".55" stop-color="#9b5cff"/><stop offset="1" stop-color="#ff6fb5" stop-opacity="0"/></linearGradient></defs>' +
          '<rect width="1600" height="900" fill="url(#k)"/>';
        for (var i = 0; i < 160; i++) s += '<circle cx="' + (r() * 1600).toFixed(0) + '" cy="' + (r() * 650).toFixed(0) + '" r="' + (r() * 1.6 + 0.3).toFixed(1) + '" fill="#fff" opacity="' + (r() * 0.7 + 0.2).toFixed(2) + '"/>';
        s += '<g filter="url(#b)" opacity=".85"><path d="M-100,420 C250,160 520,520 820,260 S1350,120 1700,330 L1700,520 C1350,330 1100,520 820,470 S300,560 -100,600 Z" fill="url(#a1)"/>' +
          '<path d="M-100,300 C300,120 600,380 900,180 S1400,60 1700,200 L1700,330 C1400,180 1150,330 900,320 S300,330 -100,430 Z" fill="url(#a2)" opacity=".6"/></g>' +
          '<path d="' + ridge(r, 780, 40, 50, 1600, 900) + '" fill="#020610"/>';
        return svgUrl(s + '</svg>') + ' center/cover';
      } },
      dusk: { name: 'Dusk', thumb: '#c0607a', css: function () {
        var r = rnd(23), s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs>' +
          '<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#241640"/><stop offset=".45" stop-color="#8b3a73"/><stop offset=".8" stop-color="#f08a5d"/><stop offset="1" stop-color="#ffc988"/></linearGradient></defs>' +
          '<rect width="1600" height="900" fill="url(#s)"/><circle cx="800" cy="640" r="150" fill="#ffd9a0" opacity=".9"/>';
        [['#5b2a5e', 620, 60], ['#3e1d4a', 700, 50], ['#2a1336', 790, 35], ['#180a22', 860, 20]].forEach(function (L) { s += '<path d="' + ridge(r, L[1], L[2], 30, 1600, 900) + '" fill="' + L[0] + '"/>'; });
        return svgUrl(s + '</svg>') + ' center/cover';
      } },
      ocean: { name: 'Deep sea', thumb: '#0f6f86', css: function () {
        var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a3b52"/><stop offset="1" stop-color="#02101b"/></linearGradient></defs><rect width="1600" height="900" fill="url(#s)"/>';
        for (var i = 0; i < 9; i++) {
          var y = 180 + i * 85, a = 40 + i * 6, d = 'M0,' + y;
          for (var x = 0; x <= 1600; x += 100) d += ' Q' + (x + 50) + ',' + (y + (x / 100 % 2 ? a : -a)) + ' ' + (x + 100) + ',' + y;
          s += '<path d="' + d + ' L1600,900 L0,900 Z" fill="#1fb3c9" opacity="' + (0.05 + i * 0.012).toFixed(3) + '"/>';
        }
        return svgUrl(s + '</svg>') + ' center/cover';
      } },
      nebula: { name: 'Nebula', thumb: '#4b2d7f', css: function () {
        var r = rnd(77), s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><filter id="b"><feGaussianBlur stdDeviation="60"/></filter></defs><rect width="1600" height="900" fill="#05040d"/>' +
          '<g filter="url(#b)"><ellipse cx="520" cy="420" rx="420" ry="220" fill="#5b2bb5" opacity=".55"/><ellipse cx="980" cy="520" rx="380" ry="200" fill="#c0367a" opacity=".45"/><ellipse cx="1200" cy="300" rx="260" ry="160" fill="#2a7fd4" opacity=".45"/></g>';
        for (var i = 0; i < 260; i++) s += '<circle cx="' + (r() * 1600).toFixed(0) + '" cy="' + (r() * 900).toFixed(0) + '" r="' + (r() * 1.5 + 0.2).toFixed(1) + '" fill="#fff" opacity="' + (r() * 0.8 + 0.2).toFixed(2) + '"/>';
        return svgUrl(s + '</svg>') + ' center/cover';
      } },
      bloom: { name: 'Bloom', thumb: '#2f6fe0', css: function () {
        var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g" cx="50%" cy="55%" r="65%"><stop offset="0" stop-color="#1d3f8f"/><stop offset="1" stop-color="#070d1f"/></radialGradient><filter id="b"><feGaussianBlur stdDeviation="8"/></filter></defs><rect width="1600" height="900" fill="url(#g)"/><g transform="translate(800 470)" filter="url(#b)">';
        for (var i = 0; i < 7; i++) s += '<ellipse rx="330" ry="120" transform="rotate(' + (i * 26 - 78) + ')" fill="hsl(' + (205 + i * 9) + ',90%,' + (52 + i * 3) + '%)" opacity=".22"/>';
        return svgUrl(s + '</g></svg>') + ' center/cover';
      } },
      grid: { name: 'Neon grid', thumb: '#7a2bb8', css: function () {
        var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12002a"/><stop offset=".55" stop-color="#3a0a5c"/><stop offset=".56" stop-color="#0b0016"/><stop offset="1" stop-color="#05000c"/></linearGradient><linearGradient id="u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd36e"/><stop offset="1" stop-color="#ff3d9a"/></linearGradient></defs><rect width="1600" height="900" fill="url(#s)"/><circle cx="800" cy="420" r="150" fill="url(#u)"/>';
        for (var i = 0; i < 6; i++) s += '<rect x="640" y="' + (420 + i * 22) + '" width="320" height="' + (4 + i * 2) + '" fill="#3a0a5c"/>';
        for (var j = 0; j < 14; j++) { var y = 500 + Math.pow(j / 13, 2) * 400; s += '<line x1="0" x2="1600" y1="' + y.toFixed(0) + '" y2="' + y.toFixed(0) + '" stroke="#ff3dc8" stroke-opacity=".55" stroke-width="2"/>'; }
        for (var k = -12; k <= 12; k++) s += '<line x1="800" y1="500" x2="' + (800 + k * 160) + '" y2="900" stroke="#ff3dc8" stroke-opacity=".45" stroke-width="2"/>';
        return svgUrl(s + '</svg>') + ' center/cover';
      } },
      graphite: { name: 'Graphite', thumb: '#2b2f36', css: function () { return 'radial-gradient(ellipse at 30% 20%,#3a404a 0,#1c1f24 55%,#0f1114 100%)'; } }
    };
    // wallpapers that go with the OS themes (all drawn here, no photos)
    function hills(sky, bands, sun) {
      var r = rnd(bands.length * 7 + 3), s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">' +
        sky.map(function (c, i) { return '<stop offset="' + (i / (sky.length - 1)) + '" stop-color="' + c + '"/>'; }).join('') + '</linearGradient></defs><rect width="1600" height="900" fill="url(#s)"/>' + (sun || '');
      bands.forEach(function (b) { s += '<path d="' + ridge(r, b[1], b[2], b[3] || 8, 1600, 900) + '" fill="' + b[0] + '"/>'; });
      return svgUrl(s + '</svg>') + ' center/cover';
    }
    function glow(base, spots) { return spots.map(function (g) { return 'radial-gradient(' + g + ')'; }).join(',') + ',' + base; }
    Object.assign(WALLS, {
      w1: { name: 'Dither', thumb: '#9a9a9a', theme: 1, css: function () { return 'repeating-conic-gradient(#fff 0 25%,#a8a8a8 0 50%) 0 0/4px 4px'; } },
      w31: { name: 'Program Manager', thumb: '#008080', theme: 1, css: function () { return '#008080'; } },
      teal: { name: 'Teal', thumb: '#008080', theme: 1, css: function () { return '#008080'; } },
      me: { name: 'Millennium', thumb: '#3a7c9a', theme: 1, css: function () { return 'linear-gradient(180deg,#2c6f8e,#3e8aa6)'; } },
      w2k: { name: 'Steel blue', thumb: '#3a6ea5', theme: 1, css: function () { return '#3a6ea5'; } },
      xp: { name: 'Green hill', thumb: '#4f9bdc', theme: 1, css: function () {
        return hills(['#2f6fd0', '#5ea6ea', '#a9d6f7'], [['#4f9a2c', 650, 60, 5], ['#3f8a22', 760, 50, 4]],
          '<ellipse cx="420" cy="230" rx="240" ry="40" fill="#fff" opacity=".75"/><ellipse cx="1150" cy="170" rx="300" ry="46" fill="#fff" opacity=".6"/>'); } },
      vista: { name: 'Swoosh', thumb: '#1f5f4f', theme: 1, css: function () { return glow('linear-gradient(160deg,#04141a,#0c3b36 55%,#15553f)', ['ellipse 70% 18% at 60% 55%,rgba(140,255,200,.35),transparent 70%', 'ellipse 50% 10% at 40% 62%,rgba(120,220,255,.3),transparent 70%']); } },
      seven: { name: 'Sky glow', thumb: '#1f6fb5', theme: 1, css: function () { return glow('linear-gradient(180deg,#0a3d7a,#1a6cb8 60%,#4aa3e0)', ['circle at 50% 45%,rgba(255,255,255,.45),transparent 35%', 'ellipse 80% 30% at 50% 100%,rgba(140,220,90,.35),transparent 70%']); } },
      eight: { name: 'Plum', thumb: '#3a1a5c', theme: 1, css: function () { return glow('#2a1046', ['ellipse 60% 50% at 80% 20%,rgba(160,80,220,.45),transparent 70%', 'ellipse 50% 60% at 10% 90%,rgba(60,30,120,.8),transparent 70%']); } },
      ten: { name: 'Light beam', thumb: '#0b3d91', theme: 1, css: function () { return glow('linear-gradient(180deg,#020b24,#06215a)', ['ellipse 18% 70% at 55% 60%,rgba(80,170,255,.55),transparent 70%', 'ellipse 40% 25% at 55% 75%,rgba(40,120,255,.4),transparent 70%']); } },
      eleven: { name: 'Bloom blue', thumb: '#5b8fd8', theme: 1, css: function () { return glow('linear-gradient(180deg,#a9c7ee,#7fa6dd)', ['ellipse 40% 45% at 50% 55%,rgba(40,90,220,.75),transparent 70%', 'ellipse 22% 28% at 50% 52%,rgba(120,170,255,.9),transparent 70%']); } },
      mac9: { name: 'Periwinkle', thumb: '#6666aa', theme: 1, css: function () { return 'repeating-linear-gradient(45deg,rgba(255,255,255,.05) 0 2px,transparent 2px 6px),linear-gradient(180deg,#5c5ca8,#7a7ac0)'; } },
      aqua: { name: 'Aqua', thumb: '#3b7fd4', theme: 1, css: function () { return glow('linear-gradient(170deg,#0d3c8c,#2f7fd6 55%,#6fb6f2)', ['ellipse 90% 20% at 30% 60%,rgba(255,255,255,.25),transparent 70%', 'ellipse 70% 14% at 70% 72%,rgba(255,255,255,.18),transparent 70%']); } },
      macos: { name: 'Dunes', thumb: '#b56a6a', theme: 1, css: function () { return hills(['#232454', '#7d4b8a', '#e49a7a'], [['#5a3b78', 560, 70, 6], ['#3d2a5e', 660, 60, 5], ['#241a40', 770, 50, 5]]); } },
      ubuntu: { name: 'Warty', thumb: '#77216f', theme: 1, css: function () { return glow('linear-gradient(135deg,#2c001e,#77216f 55%,#e95420)', ['ellipse 50% 40% at 75% 75%,rgba(255,140,60,.45),transparent 70%']); } },
      gnome: { name: 'Adwaita', thumb: '#2a4a7a', theme: 1, css: function () { return glow('linear-gradient(160deg,#1c2b4a,#24457a 60%,#3b6aa8)', ['ellipse 80% 30% at 20% 90%,rgba(255,255,255,.12),transparent 70%', 'ellipse 60% 26% at 80% 80%,rgba(120,170,255,.2),transparent 70%']); } },
      kde: { name: 'Breeze', thumb: '#1d99f3', theme: 1, css: function () {
        var r = rnd(9), s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><rect width="1600" height="900" fill="#1b5e9c"/>';
        for (var y = 0; y < 10; y++) for (var x = 0; x < 17; x++) {
          var X = x * 100, Y = y * 100, c = function () { var l = 30 + r() * 30 + y * 2; return 'hsl(' + (200 + r() * 15).toFixed(0) + ',70%,' + l.toFixed(0) + '%)'; };
          s += '<path d="M' + X + ',' + Y + 'h100v100z" fill="' + c() + '"/><path d="M' + X + ',' + Y + 'v100h100z" fill="' + c() + '"/>';
        }
        return svgUrl(s + '</svg>') + ' center/cover'; } }
    });
    // OS looks. family = which CSS skin; layout: bar (taskbar), dock (top menu bar + dock), side (top bar + dock on the left), mbar (top menu bar + taskbar)
    var THEMES = [
      { id: 'panes', name: 'Panes', group: 'Panes', family: 'panes', wall: 'mist', accent: '#5b68f0', layout: 'bar' },
      { id: 'win1', name: 'Windows 1.0', group: 'Windows', family: 'win1', wall: 'w1', accent: '#000000', layout: 'bar', fixed: 1 },
      { id: 'win31', name: 'Windows 3.1', group: 'Windows', family: 'win31', wall: 'w31', accent: '#000080', layout: 'bar', fixed: 1 },
      { id: 'win95', name: 'Windows 95', group: 'Windows', family: 'classic', wall: 'teal', accent: '#000080', layout: 'bar', fixed: 1 },
      { id: 'win98', name: 'Windows 98', group: 'Windows', family: 'classic', wall: 'teal', accent: '#000080', layout: 'bar', fixed: 1 },
      { id: 'winme', name: 'Windows Me', group: 'Windows', family: 'classic', wall: 'me', accent: '#0a246a', layout: 'bar', fixed: 1 },
      { id: 'win2k', name: 'Windows 2000', group: 'Windows', family: 'classic', wall: 'w2k', accent: '#0a246a', layout: 'bar', fixed: 1 },
      { id: 'winxp', name: 'Windows XP', group: 'Windows', family: 'xp', wall: 'xp', accent: '#0058ee', layout: 'bar', fixed: 1 },
      { id: 'winvista', name: 'Windows Vista', group: 'Windows', family: 'aero', wall: 'vista', accent: '#2f8fd8', layout: 'bar', fixed: 1 },
      { id: 'win7', name: 'Windows 7', group: 'Windows', family: 'aero', wall: 'seven', accent: '#3c7fb1', layout: 'bar', fixed: 1 },
      { id: 'win8', name: 'Windows 8', group: 'Windows', family: 'metro', wall: 'eight', accent: '#8a2be2', layout: 'bar' },
      { id: 'win10', name: 'Windows 10', group: 'Windows', family: 'metro', wall: 'ten', accent: '#0078d7', layout: 'bar' },
      { id: 'win11', name: 'Windows 11', group: 'Windows', family: 'panes', wall: 'eleven', accent: '#0067c0', layout: 'bar' },
      { id: 'mac9', name: 'Mac OS 9', group: 'Mac', family: 'mac9', wall: 'mac9', accent: '#5c5ca8', layout: 'mbar', fixed: 1 },
      { id: 'macaqua', name: 'Mac OS X Aqua', group: 'Mac', family: 'aqua', wall: 'aqua', accent: '#3b82f6', layout: 'dock', fixed: 1 },
      { id: 'macos', name: 'macOS', group: 'Mac', family: 'macos', wall: 'macos', accent: '#0a84ff', layout: 'dock' },
      { id: 'ubuntu', name: 'Ubuntu', group: 'Linux', family: 'ubuntu', wall: 'ubuntu', accent: '#e95420', layout: 'side' },
      { id: 'gnome', name: 'GNOME', group: 'Linux', family: 'gnome', wall: 'gnome', accent: '#3584e4', layout: 'dock' },
      { id: 'kde', name: 'KDE Plasma', group: 'Linux', family: 'kde', wall: 'kde', accent: '#3daee9', layout: 'bar' }
    ];
    function themeOf(p) { var id = (p || prefs || {}).osTheme; for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }
    // pick a look: it brings its own wallpaper and accent colour (both can be changed afterwards)
    function setTheme(id) {
      var t = THEMES.filter(function (x) { return x.id === id; })[0]; if (!t) return;
      prefs.osTheme = t.id; prefs.wallpaper = { type: 'preset', id: t.wall }; prefs.accent = t.accent;
      if (t.id === 'panes') prefs.wallpaper = { type: 'preset', id: 'mist' };
      setPref('osTheme', t.id);
    }
    var wallCache = {};
    function wallCss(w) {
      w = w || DEFAULTS.wallpaper;
      if (w.type === 'color') return /^#[0-9a-f]{6}$/i.test(w.color) ? w.color : '#1b2838';
      if (w.type === 'gradient') return 'linear-gradient(' + (w.angle || 135) + 'deg,' + w.a + ',' + w.b + ')';
      if (w.type === 'image' && (w.data || w.url)) {
        var size = { fill: 'center/cover', fit: 'center/contain', stretch: 'center/100% 100%', center: 'center/auto', tile: 'top left/auto repeat' }[w.fit || 'fill'];
        return 'url("' + String(w.data || w.url).replace(/"/g, '%22') + '") ' + size + (w.fit === 'tile' ? '' : ' no-repeat') + ', #111';
      }
      var p = WALLS[w.id] || WALLS.mist;
      return wallCache[w.id] || (wallCache[w.id] = p.css());
    }
    function setWall(node, w) { node.style.background = wallCss(w); }

    /* ================================================================ app icons */
    var ICONS = {
      mist: '<svg viewBox="0 0 48 48"><defs><linearGradient id="mi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cc8ff"/><stop offset="1" stop-color="#1d4f8f"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="11" fill="url(#mi)"/><ellipse cx="25" cy="18" rx="13" ry="4.6" fill="#fff" opacity=".95"/><ellipse cx="20" cy="26" rx="12" ry="4.2" fill="#fff" opacity=".78"/><ellipse cx="27" cy="33.5" rx="10" ry="3.6" fill="#fff" opacity=".6"/></svg>',
      concord: '<svg viewBox="0 0 48 48"><defs><linearGradient id="ci" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f7bff"/><stop offset="1" stop-color="#4b2fd1"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="11" fill="url(#ci)"/><path d="M13 14h22a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H23l-7 6v-6h-3a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z" fill="#fff"/><circle cx="18" cy="23.5" r="2.3" fill="#5b3fe0"/><circle cx="24" cy="23.5" r="2.3" fill="#5b3fe0"/><circle cx="30" cy="23.5" r="2.3" fill="#5b3fe0"/></svg>',
      gleam: '<svg viewBox="0 0 48 48"><defs><linearGradient id="gi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f2a3d"/><stop offset="1" stop-color="#0c1320"/></linearGradient><linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#45e3ff"/><stop offset=".5" stop-color="#7b8cff"/><stop offset="1" stop-color="#ff7ad9"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="11" fill="url(#gi)"/><circle cx="24" cy="24" r="12.5" fill="none" stroke="url(#gr)" stroke-width="5"/><path d="M33 9l1.6 3.6L38 14l-3.4 1.4L33 19l-1.6-3.6L28 14l3.4-1.4z" fill="#fff"/><circle cx="24" cy="24" r="4.5" fill="#bfe9ff"/></svg>',
      settings: '<svg viewBox="0 0 48 48"><defs><linearGradient id="si" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b7684"/><stop offset="1" stop-color="#2d333c"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="11" fill="url(#si)"/><path fill="#e8edf3" d="M24 13.5l2.4.3.8 3.1 1.9.8 2.8-1.6 1.7 1.7-1.6 2.8.8 1.9 3.1.8.3 2.4-.3 2.4-3.1.8-.8 1.9 1.6 2.8-1.7 1.7-2.8-1.6-1.9.8-.8 3.1-2.4.3-2.4-.3-.8-3.1-1.9-.8-2.8 1.6-1.7-1.7 1.6-2.8-.8-1.9-3.1-.8-.3-2.4.3-2.4 3.1-.8.8-1.9-1.6-2.8 1.7-1.7 2.8 1.6 1.9-.8.8-3.1z"/><circle cx="24" cy="24" r="4.6" fill="#3b424c"/></svg>'
    };
    function appIcon(id, size) {
      var box = el('span', 'sh-ico');
      box.style.width = box.style.height = size + 'px';
      var a = apps[id];
      if (a && a.iconInto) a.iconInto(box);
      else if (window.MIST_ICONS && MIST_ICONS[id]) { var im = el('img'); im.src = MIST_ICONS[id]; im.alt = ''; im.draggable = false; box.appendChild(im); }
      else box.innerHTML = ICONS[id] || ICONS.mist;
      return box;
    }

    /* ================================================================ window manager */
    function areaRect() { return area.getBoundingClientRect(); }
    function Win(o) {
      var w = this;
      w.id = o.id || ('w' + (++uid)); w.app = o.app; w.title = o.title || ''; w.state = 'normal'; w.keep = !!o.keepAlive; w.opts = o;
      w.el = el('div', 'win' + (o.cls ? ' ' + o.cls : '')); w.el.dataset.app = o.app;
      var tb = el('div', 'win-tb');
      w.icon = el('span', 'win-ico'); w.icon.appendChild(o.iconEl ? o.iconEl() : appIcon(o.app, 16));
      w.titleEl = el('span', 'win-title', w.title);
      w.tbExtra = el('div', 'win-tbx');
      var btns = el('div', 'win-btns');
      function wb(cls, label, txt, fn) { var b = el('button', 'wb ' + cls, txt); b.title = label; b.setAttribute('aria-label', label); b.onclick = function (e) { e.stopPropagation(); fn(); }; btns.appendChild(b); return b; }
      w.bFs = wb('wb-fs', 'Full screen', '', function () { w.fullscreen(); });
      wb('wb-min', 'Minimise', '', function () { w.minimize(); });
      w.bMax = wb('wb-max', 'Maximise', '', function () { w.state === 'max' ? w.restore() : w.maximize(); });
      wb('wb-x', 'Close', '', function () { w.close(); });
      tb.appendChild(w.icon); tb.appendChild(w.titleEl); tb.appendChild(w.tbExtra); tb.appendChild(btns);
      w.tb = tb;
      w.body = el('div', 'win-body');
      w.el.appendChild(tb); w.el.appendChild(w.body);
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (d) { var h = el('div', 'wr wr-' + d); h.dataset.dir = d; w.el.appendChild(h); h.addEventListener('pointerdown', function (e) { startResize(w, d, e); }); });
      tb.addEventListener('pointerdown', function (e) { if (e.target.closest('.wb, [data-nodrag], .win-tbx button, .win-tbx input')) return; startMove(w, e); });
      tb.addEventListener('dblclick', function (e) { if (e.target.closest('.wb, [data-nodrag], .win-tbx button, .win-tbx input')) return; w.state === 'max' ? w.restore() : w.maximize(); });
      w.el.addEventListener('pointerdown', function () { w.focus(); }, true);
      // place it
      var A = areaRect(), saved = (prefs.windows || {})[o.app], small = A.width < 760;
      var ww = clamp(saved && saved.w || o.width || 900, o.minW || MIN_W, Math.max(MIN_W, A.width)), hh = clamp(saved && saved.h || o.height || 600, o.minH || MIN_H, Math.max(MIN_H, A.height));
      var n = wins.filter(function (x) { return x.state !== 'min'; }).length;
      var x = saved && saved.x != null ? saved.x : (A.width - ww) / 2 + n * 26 - 40, y = saved && saved.y != null ? saved.y : (A.height - hh) / 2 + n * 26 - 30;
      w.rect = { x: clamp(x, 0, Math.max(0, A.width - ww)), y: clamp(y, 0, Math.max(0, A.height - hh)), w: ww, h: hh };
      area.appendChild(w.el);
      w.place();
      wins.push(w);
      if (small || (saved && saved.max) || o.maximized) w.maximize(true);
      w.focus();
      w.el.classList.add('win-open'); setTimeout(function () { w.el.classList.remove('win-open'); }, 220);
      drawBar();
    }
    Win.prototype.place = function () {
      var s = this.el.style;
      if (this.state === 'max') { s.left = '0px'; s.top = '0px'; s.width = '100%'; s.height = '100%'; return; }
      s.left = this.rect.x + 'px'; s.top = this.rect.y + 'px'; s.width = this.rect.w + 'px'; s.height = this.rect.h + 'px';
    };
    Win.prototype.setTitle = function (t) { this.title = t; this.titleEl.textContent = t; drawBar(); };
    Win.prototype.focus = function () {
      if (this.state === 'min') this.unminimize();
      if (this.el.classList.contains('win-front')) return;
      wins.forEach(function (x) { x.el.classList.remove('win-front'); });
      this.el.style.zIndex = ++zTop; this.el.classList.add('win-front');
      closeStart(); closeNotifs();
      drawBar();
      if (this.opts.onFocus) this.opts.onFocus();
    };
    Win.prototype.minimize = function () {
      if (this.state === 'min') return;
      this.wasMax = this.state === 'max'; this.state = 'min';
      this.el.classList.add('win-min'); this.el.classList.remove('win-front');
      var next = topWin(this); if (next) next.focus();
      drawBar();
    };
    Win.prototype.unminimize = function () {
      this.el.classList.remove('win-min');
      this.state = this.wasMax ? 'max' : 'normal'; this.el.classList.toggle('win-max', this.state === 'max');
      this.place(); this.el.style.zIndex = ++zTop;
    };
    Win.prototype.maximize = function (quiet) {
      if (this.state === 'min') this.unminimize();
      this.state = 'max'; this.el.classList.add('win-max'); this.bMax.title = 'Restore'; this.place(); if (!quiet) this.save(); drawBar();
      if (this.opts.onResize) this.opts.onResize();
    };
    Win.prototype.restore = function () {
      this.state = 'normal'; this.el.classList.remove('win-max'); this.bMax.title = 'Maximise'; this.place(); this.save(); drawBar();
      if (this.opts.onResize) this.opts.onResize();
    };
    Win.prototype.fullscreen = function () {
      var d = document, e = this.el;
      if ((d.fullscreenElement || d.webkitFullscreenElement) === e) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
      var f = e.requestFullscreen || e.webkitRequestFullscreen;
      if (!f) { this.maximize(); return; }
      var r = f.call(e); if (r && r.catch) r.catch(function () {});
      this.focus();
    };
    Win.prototype.save = function () {
      var all = Object.assign({}, prefs.windows || {});
      all[this.app] = { x: Math.round(this.rect.x), y: Math.round(this.rect.y), w: Math.round(this.rect.w), h: Math.round(this.rect.h), max: this.state === 'max' };
      setPref('windows', all, true);
    };
    Win.prototype.close = function (force) {
      if (!force && this.opts.onClose && this.opts.onClose() === false) return;
      var d = document; if ((d.fullscreenElement || d.webkitFullscreenElement) === this.el) try { (d.exitFullscreen || d.webkitExitFullscreen).call(d); } catch (e) {}
      if (this.keep) { this.el.classList.add('win-hidden'); this.hidden = true; this.el.classList.remove('win-front'); }
      else { this.el.remove(); wins = wins.filter(function (x) { return x !== this; }, this); }
      if (this.opts.onClosed) this.opts.onClosed();
      var next = topWin(this); if (next) next.focus();
      drawBar();
    };
    Win.prototype.show = function () { this.hidden = false; this.el.classList.remove('win-hidden'); if (this.state === 'min') this.unminimize(); this.focus(); drawBar(); };
    function visible(w) { return !w.hidden; }
    function topWin(except) {
      var list = wins.filter(function (x) { return x !== except && visible(x) && x.state !== 'min'; });
      list.sort(function (a, b) { return (+b.el.style.zIndex || 0) - (+a.el.style.zIndex || 0); });
      return list[0] || null;
    }
    function activeWin() { var t = topWin(null); return t && t.el.classList.contains('win-front') ? t : null; }
    // A click inside a game or web page (an iframe) doesn't reach us; the window blurs instead.
    window.addEventListener('blur', function () {
      setTimeout(function () {
        var a = document.activeElement; if (!a || a.tagName !== 'IFRAME') return;
        var we = a.closest('.win'); if (!we) return;
        for (var i = 0; i < wins.length; i++) if (wins[i].el === we) { wins[i].focus(); break; }
      }, 0);
    });

    function dragging(on, cursor) { document.body.classList.toggle('sh-drag', on); document.body.style.cursor = on ? cursor || '' : ''; }
    function startMove(w, e) {
      if (e.button !== 0) return;
      e.preventDefault();
      w.focus();
      var A = areaRect(), sx = e.clientX, sy = e.clientY, moved = false, snap = null;
      var r0 = Object.assign({}, w.rect), wasMax = w.state === 'max';
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!moved) { moved = true; dragging(true, 'grabbing'); }
        if (w.state === 'max') {    // pull a maximised window down: restore it under the pointer
          var fx = (sx - A.left) / A.width;
          w.state = 'normal'; w.el.classList.remove('win-max');
          r0 = { x: sx - A.left - r0.w * fx, y: 0, w: r0.w, h: r0.h };
          if (!r0.w || r0.w >= A.width) r0 = { x: sx - A.left - 450, y: 0, w: 900, h: 600 };
        }
        w.rect.x = r0.x + dx; w.rect.y = clamp(r0.y + dy, 0, A.height - 40);
        w.rect.x = clamp(w.rect.x, -w.rect.w + 120, A.width - 120);
        w.place();
        var px = ev.clientX - A.left, py = ev.clientY - A.top;
        snap = py <= SNAP ? 'max' : px <= SNAP ? 'left' : px >= A.width - SNAP ? 'right' : null;
        showSnap(snap);
      }
      function up() {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        dragging(false); showSnap(null);
        if (!moved) { if (wasMax) w.state = 'max'; return; }
        if (snap === 'max') { w.rect = Object.assign({}, r0.w ? { x: clamp(w.rect.x, 0, A.width - r0.w), y: 20, w: r0.w, h: r0.h } : w.rect); w.maximize(); return; }
        if (snap === 'left' || snap === 'right') { w.rect = { x: snap === 'left' ? 0 : A.width / 2, y: 0, w: A.width / 2, h: A.height }; w.state = 'normal'; w.el.classList.remove('win-max'); w.place(); w.save(); if (w.opts.onResize) w.opts.onResize(); return; }
        w.save(); drawBar();
      }
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    }
    function showSnap(s) {
      if (!s) { snapPrev.className = 'sh-snap'; return; }
      snapPrev.className = 'sh-snap on ' + s;
    }
    function startResize(w, d, e) {
      if (e.button !== 0 || w.state === 'max') return;
      e.preventDefault(); e.stopPropagation(); w.focus();
      var A = areaRect(), sx = e.clientX, sy = e.clientY, r0 = Object.assign({}, w.rect), minW = w.opts.minW || MIN_W, minH = w.opts.minH || MIN_H;
      dragging(true, getComputedStyle(e.target).cursor);
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy, r = Object.assign({}, r0);
        if (d.indexOf('e') >= 0) r.w = clamp(r0.w + dx, minW, A.width - r0.x);
        if (d.indexOf('s') >= 0) r.h = clamp(r0.h + dy, minH, A.height - r0.y);
        if (d.indexOf('w') >= 0) { var nw = clamp(r0.w - dx, minW, r0.x + r0.w); r.x = r0.x + r0.w - nw; r.w = nw; }
        if (d.indexOf('n') >= 0) { var nh = clamp(r0.h - dy, minH, r0.y + r0.h); r.y = r0.y + r0.h - nh; r.h = nh; }
        w.rect = r; w.place();
        if (w.opts.onResize) w.opts.onResize();
      }
      function up() { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); dragging(false); w.save(); }
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    }
    function layoutAll() {
      if (!prefs) return;
      var A = areaRect(); if (!A.width) return;
      wins.forEach(function (w) {
        if (w.state === 'max') return;
        w.rect.w = Math.min(w.rect.w, A.width); w.rect.h = Math.min(w.rect.h, A.height);
        w.rect.x = clamp(w.rect.x, -w.rect.w + 120, A.width - 120); w.rect.y = clamp(w.rect.y, 0, Math.max(0, A.height - 40));
        w.place();
      });
      drawIcons();
    }
    window.addEventListener('resize', function () { clearTimeout(layoutAll.t); layoutAll.t = setTimeout(layoutAll, 120); });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        var f = document.fullscreenElement || document.webkitFullscreenElement;
        wins.forEach(function (w) { w.el.classList.toggle('win-fs', w.el === f); if (w.el === f && w.opts.onResize) w.opts.onResize(); });
      });
    });

    function openWindow(o) { return new Win(o); }
    function findWin(app) { for (var i = 0; i < wins.length; i++) if (wins[i].app === app) return wins[i]; return null; }

    /* ================================================================ apps */
    function registerApp(a) { apps[a.id] = a; if (appOrder.indexOf(a.id) < 0) appOrder.push(a.id); drawIcons(); drawBar(); }
    function launch(id, arg) {
      var a = apps[id]; if (!a) return null;
      closeStart();
      if (a.needsAccount && !eng()) { askSignIn(a); return null; }
      var w = findWin(id);
      if (w && !a.multi) { w.show(); if (a.reopen) a.reopen(w, arg); return w; }
      return a.open(arg);
    }
    function askSignIn(a) {
      var w = openWindow({ app: a.id, title: a.name, width: 460, height: 340, minW: 340, minH: 260 });
      w.body.classList.add('sh-signin');
      w.body.appendChild(appIcon(a.id, 64));
      w.body.appendChild(el('h2', null, a.name + ' needs a Panes account'));
      w.body.appendChild(el('p', null, guest ? 'You’re using Panes as a guest. Sign in or create a free account to use ' + a.name + '.' : 'Sign in to use ' + a.name + '.'));
      var b = el('button', 'sh-btn acc', 'Sign in'); b.onclick = function () { w.close(true); switchUser(); };
      w.body.appendChild(b);
    }

    /* ================================================================ desktop icons */
    var selIcon = null;
    function deskItems() {
      var list = appOrder.filter(function (id) { return !apps[id].hidden; }).map(function (id) { return { key: 'app:' + id, name: apps[id].name, icon: function () { return appIcon(id, iconPx()); }, open: function () { launch(id); } }; });
      if (prefs.gameIcons && ctx.games) ctx.games().forEach(function (g) {
        list.push({ key: 'game:' + g.id, name: g.name, game: g, icon: function () { var b = el('span', 'sh-ico sh-gico'); b.style.width = b.style.height = iconPx() + 'px'; g.iconInto(b); return b; }, open: function () { g.play(); } });
      });
      return list;
    }
    function iconPx() { return { small: 32, medium: 44, large: 60 }[prefs.iconSize] || 44; }
    function cell() { var s = iconPx(); return { w: s + 52, h: s + 50 }; }
    function drawIcons() {
      if (!prefs) return;
      icons.textContent = '';
      var C = cell(), D = desk.getBoundingClientRect(), rows = Math.max(1, Math.floor((D.height - 12) / C.h)), cols = Math.max(1, Math.floor((D.width - 12) / C.w));
      var taken = {}, pos = prefs.iconPos || {}, items = deskItems(), placed = [];
      items.forEach(function (it) { var p = pos[it.key]; if (p && p.c < cols && p.r < rows && !taken[p.c + ':' + p.r]) { taken[p.c + ':' + p.r] = 1; placed.push([it, p.c, p.r]); } else placed.push([it, -1, -1]); });
      var nc = 0, nr = 0;
      placed.forEach(function (x) {
        if (x[1] >= 0) return;
        while (taken[nc + ':' + nr]) { nr++; if (nr >= rows) { nr = 0; nc++; } }
        x[1] = nc; x[2] = nr; taken[nc + ':' + nr] = 1;
      });
      placed.forEach(function (x) {
        var it = x[0], d = el('button', 'sh-di'); d.dataset.key = it.key;
        d.style.left = (6 + x[1] * C.w) + 'px'; d.style.top = (6 + x[2] * C.h) + 'px'; d.style.width = C.w + 'px';
        d.appendChild(it.icon()); d.appendChild(el('span', 'sh-dl', it.name));
        d.title = it.name;
        if (selIcon === it.key) d.classList.add('sel');
        d.addEventListener('pointerdown', function (e) { iconDrag(e, d, it, C); });
        d.ondblclick = function () { it.open(); };
        d.onkeydown = function (e) { if (e.key === 'Enter') it.open(); };
        d.oncontextmenu = function (e) {
          e.preventDefault(); e.stopPropagation(); selectIcon(it.key);
          var items2 = [['Open', it.open]];
          if (it.game) { items2.push(['Show in Mist', function () { launch('mist'); it.game.show(); }]); items2.push(['Remove from desktop', function () { setPref('gameIcons', false); ctx.toast('Game shortcuts hidden. Turn them back on in Settings › Desktop.'); }]); }
          menu(e.clientX, e.clientY, items2);
        };
        icons.appendChild(d);
      });
    }
    function selectIcon(k) { selIcon = k; Array.prototype.forEach.call(icons.children, function (c) { c.classList.toggle('sel', c.dataset.key === k); }); }
    function iconDrag(e, d, it, C) {
      if (e.button !== 0) return;
      selectIcon(it.key);
      var sx = e.clientX, sy = e.clientY, l0 = parseFloat(d.style.left), t0 = parseFloat(d.style.top), moved = false, touch = e.pointerType === 'touch';
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return;
        moved = true; d.classList.add('drag'); d.style.left = l0 + dx + 'px'; d.style.top = t0 + dy + 'px';
      }
      function up() {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
        d.classList.remove('drag');
        if (!moved) { if (touch) it.open(); return; }
        var D = desk.getBoundingClientRect(), cols = Math.max(1, Math.floor((D.width - 12) / C.w)), rows = Math.max(1, Math.floor((D.height - 12) / C.h));
        var c = clamp(Math.round((parseFloat(d.style.left) - 6) / C.w), 0, cols - 1), r = clamp(Math.round((parseFloat(d.style.top) - 6) / C.h), 0, rows - 1);
        var pos = Object.assign({}, prefs.iconPos || {});
        Object.keys(pos).forEach(function (k) { if (k !== it.key && pos[k].c === c && pos[k].r === r) delete pos[k]; });
        pos[it.key] = { c: c, r: r };
        setPref('iconPos', pos, true); drawIcons();
      }
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    }
    desk.addEventListener('pointerdown', function (e) { if (e.target === desk || e.target === icons) { selectIcon(null); closeStart(); closeNotifs(); } });
    desk.addEventListener('contextmenu', function (e) {
      if (e.target !== desk && e.target !== icons) return;
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        ['Personalise', function () { launch('settings', 'personal'); }],
        ['Change wallpaper', function () { launch('settings', 'personal'); }],
        ['Sort icons by name', function () { setPref('iconPos', {}, true); drawIcons(); }],
        [prefs.gameIcons ? 'Hide game shortcuts' : 'Show game shortcuts', function () { setPref('gameIcons', !prefs.gameIcons); drawIcons(); }],
        ['Refresh', function () { drawIcons(); }]
      ]);
    });

    /* ---------------- context menus ---------------- */
    var menuEl = el('div', 'sh-menu'); root.appendChild(menuEl);
    function menu(x, y, items) {
      menuEl.textContent = '';
      items.forEach(function (it) {
        if (!it) { menuEl.appendChild(el('hr')); return; }
        var b = el('button', null, it[0]); b.onclick = function () { closeMenu(); it[1](); }; menuEl.appendChild(b);
      });
      menuEl.classList.add('on');
      var r = menuEl.getBoundingClientRect();
      menuEl.style.left = clamp(x, 4, window.innerWidth - r.width - 4) + 'px';
      menuEl.style.top = clamp(y, 4, window.innerHeight - r.height - 4) + 'px';
    }
    function closeMenu() { menuEl.classList.remove('on'); }
    document.addEventListener('pointerdown', function (e) { if (!e.target.closest('.sh-menu')) closeMenu(); }, true);

    /* ================================================================ taskbar */
    var bStart = el('button', 'sh-tb sh-startbtn'); bStart.title = 'Start';
    if (window.MIST_ICONS && MIST_ICONS.panes) { var bsi = el('img', 'sh-panes'); bsi.src = MIST_ICONS.panes; bsi.alt = 'Start'; bsi.draggable = false; bStart.appendChild(bsi); bStart.classList.add('logo'); }
    else bStart.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 4.5l8-1.2v8.1H3zM12.2 3.1L21 1.8v9.6h-8.8zM3 12.6h8v8.1l-8-1.2zM12.2 12.6H21v9.6l-8.8-1.3z" fill="currentColor"/></svg>';
    bStart.appendChild(el('span', 'sh-stxt', 'Start'));
    bStart.onclick = function (e) { e.stopPropagation(); toggleStart(); };
    // top menu bar for the Mac and Linux looks: logo / Activities, the front app's name, clock
    var mbar = el('div', 'sh-mbar'), mbLogo = el('button', 'sh-mb-logo'), mbAct = el('button', 'sh-mb-act', 'Activities'), mbApp = el('b', 'sh-mb-app'), mbClock = el('button', 'sh-mb-clock');
    if (window.MIST_ICONS && MIST_ICONS.panes) { var mbi = el('img'); mbi.src = MIST_ICONS.panes; mbi.alt = ''; mbLogo.appendChild(mbi); } else mbLogo.textContent = '◭';
    mbLogo.title = mbAct.title = 'Start';
    mbLogo.onclick = mbAct.onclick = function (e) { e.stopPropagation(); toggleStart(); };
    mbClock.onclick = function (e) { e.stopPropagation(); toggleNotifs(); };
    mbar.appendChild(mbLogo); mbar.appendChild(mbAct); mbar.appendChild(mbApp);
    ['File', 'Edit', 'View', 'Window', 'Help'].forEach(function (t) { mbar.appendChild(el('span', 'sh-mb-m', t)); });
    var mbSp = el('span', 'sh-mb-sp'); mbar.appendChild(mbSp); mbar.appendChild(mbClock);
    function drawMbar() {
      var f = null; wins.forEach(function (w) { if (w.el.classList.contains('win-front') && w.state !== 'min' && !w.hidden) f = w; });
      mbApp.textContent = f ? (apps[f.app] ? apps[f.app].name : f.title) : 'Panes';
    }
    var mid = el('div', 'sh-tbmid'), tray = el('div', 'sh-tray');
    var clock = el('button', 'sh-clock'); clock.title = 'Notifications'; clock.onclick = function (e) { e.stopPropagation(); toggleNotifs(); };
    var net = el('span', 'sh-net'); net.title = 'Panes server';
    tray.appendChild(net); tray.appendChild(clock);
    root.appendChild(mbar);
    bar.appendChild(mid); bar.appendChild(tray);
    function drawBar() {
      if (!prefs) return;
      mid.textContent = '';
      mid.appendChild(bStart); drawMbar();
      var shown = {};
      (prefs.pinned || DEFAULTS.pinned).concat(appOrder).forEach(function (id) {
        if (shown[id] || !apps[id] || apps[id].hidden) return;
        var pinned = (prefs.pinned || DEFAULTS.pinned).indexOf(id) >= 0, w = findWin(id);
        if (!pinned && (!w || w.hidden)) return;
        shown[id] = 1;
        mid.appendChild(tbButton(id, apps[id].name, function () { return appIcon(id, 24); }, w && !w.hidden ? w : null));
      });
      wins.forEach(function (w) {
        if (shown[w.app] || w.hidden) return;
        mid.appendChild(tbButton(w.app, w.title, w.opts.iconEl ? w.opts.iconEl : function () { return appIcon(w.app, 24); }, w));
      });
    }
    function tbButton(id, name, iconFn, w) {
      var b = el('button', 'sh-tb' + (w ? ' run' : '') + (w && w.el.classList.contains('win-front') && w.state !== 'min' ? ' act' : ''));
      b.title = w ? w.title || name : name; b.dataset.app = id;
      b.appendChild(iconFn());
      b.appendChild(el('span', 'sh-tbl', w ? w.title || name : name));   // label, shown by the older Windows looks
      if (badges[id]) b.appendChild(el('span', 'sh-badge', badges[id] > 99 ? '99+' : String(badges[id])));
      b.onclick = function () {
        if (!w) { launch(id); return; }
        if (w.el.classList.contains('win-front') && w.state !== 'min') w.minimize(); else w.show();
      };
      b.oncontextmenu = function (e) {
        e.preventDefault();
        var items = [[w ? 'Show' : 'Open', function () { w ? w.show() : launch(id); }]];
        if (apps[id]) items.push([(prefs.pinned || []).indexOf(id) >= 0 ? 'Unpin from taskbar' : 'Pin to taskbar', function () {
          var p = (prefs.pinned || DEFAULTS.pinned).slice(), i = p.indexOf(id); if (i >= 0) p.splice(i, 1); else p.push(id); setPref('pinned', p, true); drawBar();
        }]);
        if (w) items.push(['Close window', function () { w.close(); }]);
        var r = b.getBoundingClientRect(); menu(r.left, prefs.taskbarPos === 'top' ? r.bottom + 6 : r.top - 8 - 40 * items.length, items);
      };
      return b;
    }
    function drawClock() {
      if (!prefs) return;
      var d = new Date(), o = { hour: 'numeric', minute: '2-digit', hour12: !prefs.clock24 };
      if (prefs.clockSeconds) o.second = '2-digit';
      clock.textContent = '';
      clock.appendChild(el('b', null, d.toLocaleTimeString([], o)));
      if (prefs.showDate) clock.appendChild(el('small', null, d.toLocaleDateString()));
      var n = notifs.filter(function (x) { return !x.read; }).length;
      if (n) clock.appendChild(el('span', 'sh-badge', String(n)));
      mbClock.textContent = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + '  ' + d.toLocaleTimeString([], o);
      lockClock();
    }
    setInterval(drawClock, 1000);
    function checkNet() {
      var e = ctx.getEngine();
      if (!e) { net.className = 'sh-net off'; net.title = 'No Panes server set'; return; }
      fetch(e.server.replace(/\/+$/, '') + '/api/announcement', { cache: 'no-store' }).then(function (r) { net.className = 'sh-net' + (r.ok ? ' ok' : ' off'); net.title = r.ok ? 'Connected to the Panes server' : 'Panes server error'; },
        function () { net.className = 'sh-net off'; net.title = 'Can’t reach the Panes server'; });
    }
    setInterval(checkNet, 60000);

    /* ================================================================ Start menu */
    function toggleStart() { if (startPanel.classList.contains('on')) closeStart(); else openStart(); }
    function closeStart() { startPanel.classList.remove('on'); bStart.classList.remove('act'); }
    function openStart() {
      closeNotifs();
      startPanel.textContent = '';
      var q = el('input', 'sh-sq'); q.placeholder = 'Search apps and games'; q.spellcheck = false; q.autocomplete = 'off';
      startPanel.appendChild(q);
      var body = el('div', 'sh-sbody'); startPanel.appendChild(body);
      function draw() {
        body.textContent = '';
        var f = q.value.trim().toLowerCase();
        var appList = appOrder.filter(function (id) { return !apps[id].hidden && (!f || apps[id].name.toLowerCase().indexOf(f) >= 0); });
        if (appList.length) {
          body.appendChild(el('div', 'sh-sh', f ? 'Apps' : 'Pinned'));
          var g = el('div', 'sh-sgrid');
          appList.forEach(function (id) {
            var b = el('button', 'sh-sapp'); b.appendChild(appIcon(id, 36)); b.appendChild(el('span', null, apps[id].name));
            if (badges[id]) b.appendChild(el('span', 'sh-badge', String(badges[id])));
            b.onclick = function () { launch(id); }; g.appendChild(b);
          });
          body.appendChild(g);
        }
        var games = (ctx.games ? ctx.games(true) : []).filter(function (x) { return !f || x.name.toLowerCase().indexOf(f) >= 0; });
        body.appendChild(el('div', 'sh-sh', 'Your games' + (games.length ? ' (' + games.length + ')' : '')));
        var gl = el('div', 'sh-sgames');
        if (!games.length) gl.appendChild(el('p', 'sh-muted', f ? 'No games match.' : 'Install games from the Mist store and they show up here.'));
        games.slice(0, 60).forEach(function (x) {
          var b = el('button', 'sh-sgame'), ic = el('span', 'sh-ico sh-gico'); ic.style.width = ic.style.height = '32px'; x.iconInto(ic);
          b.appendChild(ic);
          var t = el('span', 'sh-sgt'); t.appendChild(el('b', null, x.name)); t.appendChild(el('small', null, x.installed ? 'Installed' : 'In library · not installed')); b.appendChild(t);
          b.onclick = function () { closeStart(); x.play(); };
          gl.appendChild(b);
        });
        body.appendChild(gl);
        if (f && !appList.length && !games.length && apps.gleam && eng()) {
          var web = el('button', 'sh-sgame'); web.appendChild(appIcon('gleam', 32));
          var wt = el('span', 'sh-sgt'); wt.appendChild(el('b', null, 'Search the web for “' + q.value.trim() + '”')); wt.appendChild(el('small', null, 'Opens in Gleam')); web.appendChild(wt);
          web.onclick = function () { launch('gleam', q.value.trim()); }; body.appendChild(web);
        }
      }
      q.oninput = draw;
      q.onkeydown = function (e) {
        if (e.key === 'Enter') { var b = body.querySelector('button'); if (b) b.click(); }
        if (e.key === 'Escape') closeStart();
      };
      draw();
      // user + power
      var foot = el('div', 'sh-sfoot');
      var u = el('button', 'sh-suser');
      if (eng() && ctx.avatar) u.appendChild(ctx.avatar(me(), 30)); else u.appendChild(el('span', 'sh-guestav', '👤'));
      u.appendChild(el('span', null, me() || 'Guest'));
      u.onclick = function (e) {
        e.stopPropagation(); var r = u.getBoundingClientRect();
        var items = eng() ? [['Account settings', function () { launch('settings', 'account'); }], ['My profile', function () { launch('mist'); if (ctx.showProfile) ctx.showProfile(me()); }], ['Lock', lockNow], ['Sign out', signOut]]
          : [['Sign in', switchUser], ['Create an account', function () { switchUser('register'); }]];
        menu(r.left, r.top - 8 - 40 * items.length, items);
      };
      foot.appendChild(u);
      var pw = el('button', 'sh-power'); pw.title = 'Power';
      pw.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7.1 6.2a8 8 0 1 0 9.8 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      pw.onclick = function (e) {
        e.stopPropagation(); var r = pw.getBoundingClientRect();
        var items = [['Lock', lockNow]];
        if (eng()) items.push(['Sign out', signOut]); else items.push(['Switch user', switchUser]);
        items.push(['Restart Panes', function () { if (confirm('Restart Panes? Running games and open pages close.')) location.reload(); }]);
        menu(r.right - 180, r.top - 8 - 40 * items.length, items);
      };
      foot.appendChild(pw);
      startPanel.appendChild(foot);
      startPanel.classList.add('on'); bStart.classList.add('act');
      setTimeout(function () { q.focus(); }, 30);
    }
    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('.sh-start, .sh-startbtn, .sh-menu')) closeStart();
      if (!e.target.closest('.sh-notifs, .sh-clock, .sh-menu')) closeNotifs();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeStart(); closeNotifs(); closeMenu(); } });

    /* ================================================================ notifications */
    function pushNotif(n) {
      n = Object.assign({ at: Date.now(), read: false }, n);
      notifs.unshift(n); if (notifs.length > 40) notifs.length = 40;
      drawClock();
      if (locked || prefs.dnd) return;
      var p = el('button', 'sh-pop');
      var ic = el('span', 'sh-pop-ico'); ic.appendChild(n.app ? appIcon(n.app, 28) : el('span', null, n.emoji || '🔔')); p.appendChild(ic);
      var t = el('span', 'sh-pop-t'); t.appendChild(el('b', null, n.title)); if (n.text) t.appendChild(el('span', null, n.text)); p.appendChild(t);
      p.onclick = function () { n.read = true; p.remove(); drawClock(); if (n.onClick) n.onClick(); };
      popups.appendChild(p);
      setTimeout(function () { p.classList.add('out'); setTimeout(function () { p.remove(); }, 300); }, 6000);
      if (prefs.notifSound) beep();
    }
    function beep() {
      try { var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.04; o.connect(g); g.connect(a.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.25); o.stop(a.currentTime + 0.3); } catch (e) {}
    }
    function toggleNotifs() { if (notifPanel.classList.contains('on')) closeNotifs(); else openNotifs(); }
    function closeNotifs() { notifPanel.classList.remove('on'); }
    function openNotifs() {
      closeStart();
      notifPanel.textContent = '';
      var d = new Date();
      var cal = el('div', 'sh-ncal'); cal.appendChild(el('b', null, d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })));
      notifPanel.appendChild(cal);
      var head = el('div', 'sh-nhead'); head.appendChild(el('span', null, 'Notifications'));
      var dnd = el('button', 'sh-dnd' + (prefs.dnd ? ' on' : ''), prefs.dnd ? '🔕 Do not disturb' : '🔔 Alerts on');
      dnd.onclick = function () { setPref('dnd', !prefs.dnd, true); openNotifs(); };
      head.appendChild(dnd);
      if (notifs.length) { var clr = el('button', 'sh-clr', 'Clear all'); clr.onclick = function () { notifs = []; drawClock(); openNotifs(); }; head.appendChild(clr); }
      notifPanel.appendChild(head);
      var list = el('div', 'sh-nlist');
      if (!notifs.length) list.appendChild(el('p', 'sh-muted', 'No new notifications'));
      notifs.forEach(function (n) {
        var r = el('button', 'sh-nrow' + (n.read ? '' : ' new'));
        var ic = el('span', 'sh-pop-ico'); ic.appendChild(n.app ? appIcon(n.app, 24) : el('span', null, n.emoji || '🔔')); r.appendChild(ic);
        var t = el('span', 'sh-pop-t'); t.appendChild(el('b', null, n.title)); if (n.text) t.appendChild(el('span', null, n.text));
        t.appendChild(el('small', null, ctx.ago ? ctx.ago(n.at) : '')); r.appendChild(t);
        r.onclick = function () { n.read = true; closeNotifs(); drawClock(); if (n.onClick) n.onClick(); };
        list.appendChild(r);
      });
      notifPanel.appendChild(list);
      notifs.forEach(function (n) { n.read = true; });
      notifPanel.classList.add('on');
      setTimeout(drawClock, 50);
    }
    function setBadge(app, n) { if ((badges[app] || 0) === (n || 0)) return; badges[app] = n || 0; drawBar(); }

    /* ================================================================ lock / sign-in screen */
    var lockBg = el('div', 'sh-lbg'), lockDim = el('div', 'sh-ldim'), lockTime = el('div', 'sh-ltime'), lockPanel = el('div', 'sh-lpanel');
    lock.appendChild(lockBg); lock.appendChild(lockDim); lock.appendChild(lockTime); lock.appendChild(lockPanel);
    var lockBrand = el('div', 'sh-lbrand');
    if (window.MIST_ICONS && MIST_ICONS.panes) { var lbi = el('img'); lbi.src = MIST_ICONS.panes; lbi.alt = ''; lockBrand.appendChild(lbi); }
    lockBrand.appendChild(el('span', null, 'Panes')); lock.appendChild(lockBrand);
    var lockStage = 'clock';
    function lockClock() {
      if (!prefs) return;
      var d = new Date();
      lockTime.textContent = '';
      lockTime.appendChild(el('b', null, d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !prefs.clock24 })));
      lockTime.appendChild(el('span', null, d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })));
    }
    function showLock(stage, mode) {
      locked = true; closeStart(); closeNotifs(); closeMenu();
      document.body.classList.add('sh-locked');
      lock.classList.add('on');
      lockStage = stage || 'clock';
      lock.classList.toggle('panel', lockStage !== 'clock');
      lockClock();
      if (lockStage !== 'clock') drawLockPanel(mode);
      if (ctx.onLock) ctx.onLock(true);
    }
    lock.addEventListener('pointerdown', function (e) { if (lockStage === 'clock') { e.preventDefault(); toPanel(); } });
    document.addEventListener('keydown', function (e) { if (locked && lockStage === 'clock' && !e.ctrlKey && !e.altKey && !e.metaKey) { toPanel(); } });
    function toPanel() { lockStage = 'panel'; lock.classList.add('panel'); drawLockPanel(); }
    function drawLockPanel(mode) {
      lockPanel.textContent = '';
      var e = ctx.getEngine(), u = eng() ? me() : null;
      var big = el('div', 'sh-lav');
      if (u && ctx.avatar) big.appendChild(ctx.avatar(u, 120)); else big.appendChild(el('span', null, '👤'));
      lockPanel.appendChild(big);
      if (u && mode !== 'login' && mode !== 'register') {     // remembered account: one click back in
        lockPanel.appendChild(el('div', 'sh-lname', u));
        var go = el('button', 'sh-lgo', 'Sign in'); go.onclick = function () { unlock(false); };
        lockPanel.appendChild(go);
        setTimeout(function () { go.focus(); }, 50);
        var other = el('div', 'sh-lother');
        var sw = el('button', null, 'Use another account'); sw.onclick = function () { drawLockPanel('login'); };
        var gs = el('button', null, 'Continue as guest'); gs.onclick = function () { unlock(true); };
        other.appendChild(sw); other.appendChild(gs); lockPanel.appendChild(other);
        return;
      }
      if (!e) {
        lockPanel.appendChild(el('div', 'sh-lname', 'Guest'));
        lockPanel.appendChild(el('p', 'sh-lnote', 'No Panes server is set up, so accounts aren’t available.'));
        var g2 = el('button', 'sh-lgo', 'Continue as guest'); g2.onclick = function () { unlock(true); }; lockPanel.appendChild(g2);
        return;
      }
      var reg = mode === 'register';
      lockPanel.appendChild(el('div', 'sh-lname', reg ? 'Create a Panes account' : 'Sign in to Panes'));
      var f = el('form', 'sh-lform');
      function inp(name, ph, type, auto) { var i = el('input'); i.name = name; i.placeholder = ph; i.type = type; i.autocomplete = auto; i.spellcheck = false; f.appendChild(i); return i; }
      var iu = inp('u', 'Account name', 'text', 'username'), ip = inp('p', 'Password', 'password', reg ? 'new-password' : 'current-password');
      var ip2 = reg ? inp('p2', 'Confirm password', 'password', 'new-password') : null;
      var err = el('div', 'sh-lerr'); f.appendChild(err);
      var sub = el('button', 'sh-lgo', reg ? 'Create account' : 'Sign in'); sub.type = 'submit'; f.appendChild(sub);
      f.onsubmit = function (ev) {
        ev.preventDefault();
        if (reg && ip.value !== ip2.value) { err.textContent = 'Passwords don’t match.'; return; }
        if (!iu.value.trim() || !ip.value) { err.textContent = 'Enter your account name and password.'; return; }
        sub.disabled = true; err.textContent = '';
        ctx.auth(reg ? 'register' : 'login', iu.value.trim(), ip.value).then(function () { unlock(false); }, function (e2) { sub.disabled = false; err.textContent = e2.message || 'Couldn’t sign in.'; });
      };
      lockPanel.appendChild(f);
      var other2 = el('div', 'sh-lother');
      var t = el('button', null, reg ? 'I already have an account' : 'Create an account'); t.onclick = function () { drawLockPanel(reg ? 'login' : 'register'); };
      var gst = el('button', null, 'Continue as guest'); gst.onclick = function () { unlock(true); };
      other2.appendChild(t); other2.appendChild(gst); lockPanel.appendChild(other2);
      setTimeout(function () { iu.focus(); }, 50);
    }
    function unlock(asGuest) {
      guest = !!asGuest || !eng();
      locked = false;
      lock.classList.add('out');
      setTimeout(function () { lock.classList.remove('on', 'out', 'panel'); document.body.classList.remove('sh-locked'); }, 350);
      loadPrefs(guest ? null : me());
      drawIcons(); drawBar(); checkNet();
      if (ctx.onLock) ctx.onLock(false, guest);
      if (!wins.length && ctx.onDesktop) ctx.onDesktop();
    }
    function lockNow() { showLock('clock'); }
    function switchUser(mode) { showLock('panel', mode || 'login'); }
    function signOut() {
      var open = wins.filter(function (w) { return !w.hidden && w.opts.signOutWarn; });
      if (open.length && !confirm('Sign out? ' + open.map(function (w) { return w.title; }).join(', ') + ' will close.')) return;
      wins.slice().forEach(function (w) { if (w.opts.closeOnSignOut) w.close(true); });
      Promise.resolve(ctx.signOut && ctx.signOut()).then(function () { showLock('panel', 'login'); });
    }

    /* ================================================================ start */
    loadPrefs(eng() ? me() : null);
    showLock('clock');
    drawBar(); checkNet();
    applyPrefs();

    return {
      registerApp: registerApp, launch: launch, openWindow: openWindow, findWin: findWin, appIcon: appIcon,
      notify: pushNotif, setBadge: setBadge, refreshDesktop: function () { drawIcons(); drawBar(); },
      prefs: function () { return prefs; }, setPref: setPref, onPrefs: function (f) { prefListeners.push(f); },
      walls: WALLS, wallCss: wallCss, defaults: DEFAULTS, themes: THEMES, theme: function () { return themeOf(); }, setTheme: setTheme,
      lock: lockNow, switchUser: switchUser, signOut: signOut, isGuest: function () { return guest; }, isLocked: function () { return locked; },
      activeWin: activeWin, windows: function () { return wins.slice(); },
      authChanged: function () {
        var u = eng() ? me() : null;
        if (!locked && u && u !== prefsUser) { guest = false; loadPrefs(u); }
        if (!locked && !u && !guest) showLock('panel', 'login');
        drawBar();
      }
    };
  };
})();

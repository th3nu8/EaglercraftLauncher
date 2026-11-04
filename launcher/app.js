/* Mist — UI logic (runs inside the about:blank window) */
(function () {
  'use strict';
  var CFG = window.__EL_CFG || { base: './', versions: {} };
  var RAW = CFG.versions || {};
  var CACHE_NAME = 'eagler-launcher-v1';
  var MIN_GAME_BYTES = 200;
  var TYPE_LABEL = { release: 'Release', snapshot: 'Snapshot', old_beta: 'Beta', old_alpha: 'Alpha', modded: 'Modded' };

  /* ---------- games (versions.json "games", or legacy top-level "versions") ---------- */
  var GAMES = (RAW.games || []).slice();
  var legacyVersions = Array.isArray(RAW) ? RAW : RAW.versions;
  if (!GAMES.length && legacyVersions && legacyVersions.length) {
    GAMES.push({ id: 'eaglercraft', name: 'Eaglercraft', developer: 'lax1dude', art: 'terrain',
      tags: ['Sandbox', 'Survival', 'Multiplayer'], description: 'Minecraft-style building and survival in your browser.',
      versions: legacyVersions });
  }
  GAMES.forEach(function (g, i) {
    g.versions = (g.versions && g.versions.length) ? g.versions : (g.file ? [{ id: 'default', name: g.name, file: g.file, type: 'release' }] : []);
    g.tags = g.tags || [];
    g.seed = 7 + i * 131;
    if (g.cloudSaves === undefined) g.cloudSaves = /eagler/i.test(g.id + ' ' + g.name);
  });
  var LAUNCHER_NAME = RAW.launcherName || 'Mist';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function gameById(id) { for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i]; return null; }
  function verById(g, id) { for (var i = 0; i < g.versions.length; i++) if (g.versions[i].id === id) return g.versions[i]; return null; }
  function typeLabel(v) { return TYPE_LABEL[v.type] || v.type || 'Release'; }
  // "cover.png" -> images/cover.png in the repo; "art/x.png" -> art/x.png; full URLs as-is.
  function resolveUrl(u) {
    if (/^(https?:|data:)/.test(u)) return u;
    u = u.replace(/^\.?\//, '');
    return CFG.base + (u.indexOf('/') < 0 ? 'images/' + u : u);
  }
  function versionUrl(v) { return /^https?:\/\//.test(v.file) ? v.file : CFG.base + 'versions/' + v.file; }
  function fmtMB(b) { if (b < 1048576) return Math.max(1, Math.round(b / 1024)) + ' KB'; return b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB'; }
  function ago(t) {
    if (!t) return 'Never';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'Just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 2) return 'Yesterday';
    return new Date(t).toLocaleDateString();
  }

  /* ---------- storage ---------- */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('eaglerLauncher:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('eaglerLauncher:' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var settings = {
    mode: store.get('mode', 'iframe'),
    title: store.get('title', LAUNCHER_NAME),
    server: store.get('syncServer', '')
  };
  var library = store.get('library', null);
  var sizes = store.get('sizes', {});           // cacheKey -> bytes
  var installed = {};                             // cacheKey -> true
  var view = { page: 'store', game: null, libGame: store.get('libGame', null), feat: 0 };

  function inLibrary(g) { return library.indexOf(g.id) >= 0; }
  function addToLibrary(g) { if (!inLibrary(g)) { library.push(g.id); store.set('library', library); } }
  function removeFromLibrary(g) { library = library.filter(function (id) { return id !== g.id; }); store.set('library', library); }
  function selVersion(g) { return verById(g, store.get('ver:' + g.id, '')) || g.versions[0] || null; }
  function setSelVersion(g, v) { store.set('ver:' + g.id, v.id); }
  function isInstalled(g, v) { return !!installed[cacheKey(g, v)]; }
  function anyInstalled(g) { return g.versions.some(function (v) { return isInstalled(g, v); }); }
  function installedSize(g) { return g.versions.reduce(function (a, v) { return a + (isInstalled(g, v) ? (sizes[cacheKey(g, v)] || 0) : 0); }, 0); }

  /* ---------- cache (Cache API) ---------- */
  function cacheKey(g, v) {
    // Eaglercraft keeps the old key so downloads from the previous launcher still count as installed.
    var id = g.id === 'eaglercraft' ? v.id : g.id + ':' + v.id;
    return 'https://eagler-launcher.invalid/' + encodeURIComponent(id) + '?f=' + encodeURIComponent(String(v.file).split('/').pop()) + '&r=' + encodeURIComponent(v.rev || '');
  }
  function cacheOpen() { return (window.caches && caches.open) ? caches.open(CACHE_NAME) : Promise.reject(new Error('no cache')); }
  function cacheGet(g, v) {
    return cacheOpen().then(function (c) { return c.match(cacheKey(g, v)); })
      .then(function (r) { return r ? r.text() : null; }).catch(function () { return null; });
  }
  function cachePut(g, v, html) {
    var k = cacheKey(g, v);
    return cacheOpen().then(function (c) {
      return c.put(k, new Response(html, { headers: { 'content-type': 'text/html' } }));
    }).then(function () { installed[k] = true; sizes[k] = html.length; store.set('sizes', sizes); }).catch(function () {});
  }
  function uninstall(g, v) {
    var k = cacheKey(g, v);
    return cacheOpen().then(function (c) { return c.delete(k); }).catch(function () {})
      .then(function () { delete installed[k]; delete sizes[k]; store.set('sizes', sizes); });
  }
  function refreshInstalled() {
    return cacheOpen().then(function (c) { return c.keys(); }).then(function (keys) {
      var urls = {}; keys.forEach(function (k) { urls[k.url] = 1; });
      installed = {};
      GAMES.forEach(function (g) { g.versions.forEach(function (v) { if (urls[cacheKey(g, v)]) installed[cacheKey(g, v)] = true; }); });
    }).catch(function () {}).then(function () {
      if (!library) {
        library = GAMES.filter(function (g, i) { return i === 0 || anyInstalled(g); }).map(function (g) { return g.id; });
        store.set('library', library);
      }
      renderAll();
    });
  }

  /* ---------- downloads ---------- */
  var dl = null; // {g, v, got, total, ctrl, promise}
  function fetchGame(g, v, onProgress, ctrl) {
    // Try the copy in this repo first; if it isn't uploaded yet, use the version's "mirror" URL.
    function get(url) { return fetch(url, { cache: 'no-store', signal: ctrl && ctrl.signal }); }
    return get(versionUrl(v)).then(function (r) {
      if (r.status === 404 && v.mirror) return get(v.mirror);
      return r;
    }, function (e) {
      if (v.mirror && !(e && e.name === 'AbortError')) return get(v.mirror);
      throw e;
    }).then(function (r) {
      if (r.status === 404) throw new Error('versions/' + v.file + ' was not found in the repo.');
      if (!r.ok) throw new Error('Download failed (HTTP ' + r.status + ').');
      var total = +r.headers.get('content-length') || (v.sizeMB ? v.sizeMB * 1048576 : 0);
      if (!r.body || !r.body.getReader) return r.text();
      var reader = r.body.getReader(), chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return new Blob(chunks).text();
          chunks.push(res.value); got += res.value.length;
          onProgress(got, total);
          return pump();
        });
      }
      return pump();
    }).then(function (html) {
      if (/^version https:\/\/git-lfs/.test(html)) throw new Error('This file is stored with Git LFS. Commit it as a normal file instead.');
      if (html.length < MIN_GAME_BYTES || html.indexOf('<') < 0) throw new Error(v.file + ' is empty or not a game file (' + html.length + ' bytes). Re-upload the full .html.');
      return html;
    });
  }
  function install(g, v) {
    if (dl) {
      if (dl.g === g && dl.v === v) return dl.promise;
      toast('Wait for ' + dl.v.name + ' to finish downloading'); return Promise.reject(new Error('busy'));
    }
    addToLibrary(g);
    var ctrl = window.AbortController ? new AbortController() : null;
    dl = { g: g, v: v, got: 0, total: 0, ctrl: ctrl };
    renderDownloads(); renderLibrary();
    dl.promise = fetchGame(g, v, function (got, total) {
      dl.got = got; dl.total = total; renderDownloads(); renderBigButton();
    }, ctrl).then(function (html) {
      return cachePut(g, v, html).then(function () { return html; });
    }).then(function (html) {
      dl = null; renderAll(); toast(v.name + ' is ready to play'); return html;
    }, function (e) {
      dl = null; renderAll();
      if (e && e.name === 'AbortError') { toast('Download cancelled'); throw e; }
      showError('Couldn’t install ' + v.name, e.message || String(e)); throw e;
    });
    return dl.promise;
  }
  function renderDownloads() {
    var bar = $('#dlbar');
    if (!dl) { bar.classList.remove('active'); $('#dlText').textContent = 'Downloads: nothing in progress'; $('#dlProg').style.width = '0'; return; }
    bar.classList.add('active');
    var pct = dl.total ? Math.min(99, Math.round(dl.got / dl.total * 100)) : 0;
    $('#dlText').textContent = 'Downloading ' + dl.v.name + ' · ' + fmtMB(dl.got) + (dl.total ? ' / ' + fmtMB(Math.max(dl.got, dl.total)) + ' · ' + pct + '%' : '');
    $('#dlProg').style.width = (dl.total ? pct : 15) + '%';
  }

  /* ---------- launching ---------- */
  var gameFrame = null, gameUrl = null;
  function play(g, v) {
    if (!g || !v) return;
    addToLibrary(g); setSelVersion(g, v);
    store.set('played:' + g.id, Date.now());
    showOverlay('Launching ' + v.name, 'Loading game files…', true);
    cacheGet(g, v).then(function (html) {
      if (html && html.length >= MIN_GAME_BYTES) return html;
      hideOverlay();
      return install(g, v).then(function (h) { showOverlay('Launching ' + v.name, '', true); return h; });
    }).then(function (html) {
      return (g.cloudSaves ? preLaunchSync() : Promise.resolve()).then(function () { return html; });
    }).then(function (html) {
      showOverlay('Launching ' + v.name, '', false); setOverlay(null, null, false, 100);
      setTimeout(function () { hideOverlay(); renderAll(); startGame(html, v.name, g); }, 120);
    }).catch(function (e) {
      if (e && (e.name === 'AbortError' || e.message === 'busy')) { hideOverlay(); return; }
      if (!$('#overlay').classList.contains('open') || ovMode === 'cancel') showError('Couldn’t launch ' + v.name, e.message || String(e));
    });
  }

  var runningGame = null;
  function startGame(html, name, g) {
    if (settings.mode === 'replace') {
      stopAutosave();
      if (social) social.setPlaying(g ? g.name : name);
      document.open(); document.write(html); document.close();
      return;
    }
    closeGame(true);
    runningGame = g || null;
    gameFrame = document.createElement('iframe');
    gameFrame.id = 'game';
    gameFrame.setAttribute('allow', 'fullscreen; pointer-lock; autoplay; gamepad; clipboard-read; clipboard-write; microphone');
    gameFrame.setAttribute('allowfullscreen', '');
    document.body.appendChild(gameFrame);
    // Write the game straight into the frame instead of using a blob: URL. The frame then shares
    // this tab's normal web address, which Ruffle (Flash games) and other loaders need to work out
    // where their files are. A blob: address makes Ruffle crash with an "update Ruffle" screen.
    var gd = gameFrame.contentDocument;
    gd.open(); gd.write(html); gd.close();
    document.body.classList.add('in-game');
    document.title = name + ' · ' + settings.title;
    setTimeout(function () { try { gameFrame.focus(); } catch (e) {} }, 300);
    if (!g || g.cloudSaves) startAutosave();
    if (social) social.setPlaying(g ? g.name : name);
    startHooks(g);
    var b = $('#backBtn'); b.classList.add('peek'); setTimeout(function () { b.classList.remove('peek'); }, 2500);
  }
  function closeGame(silent) {
    if (!gameFrame) return;
    if (!silent && !confirm('Return to the library? Unsaved progress in the running game will be lost.')) return;
    var hadSaves = !runningGame || runningGame.cloudSaves;
    stopHooks();
    gameFrame.remove(); gameFrame = null; runningGame = null;
    if (social) social.setPlaying(null);
    if (gameUrl) { URL.revokeObjectURL(gameUrl); gameUrl = null; }
    document.body.classList.remove('in-game');
    document.title = settings.title;
    stopAutosave();
    if (!silent && hadSaves && engine && engine.signedIn()) setTimeout(backgroundSync, 600);
    renderAll();
  }
  /* Game hooks: read progress from supported games while they run (launcher/hooks.js). */
  var hookWatch = null;
  function startHooks(g) {
    stopHooks();
    if (!g || !window.MistHooks || !MistHooks.has(g.name) || !engine || !engine.signedIn() || !gameFrame) return;
    var gameName = g.name;
    hookWatch = MistHooks.watch(gameName, gameFrame.contentWindow, function (stats) {
      if (!engine || !engine.signedIn()) return;
      engine.api('POST', '/api/game-stats', { json: { game: gameName, stats: stats } }).then(function (r) {
        if (social) social.handleUnlocks(r);
      }, function () {});
    });
  }
  function stopHooks() { if (hookWatch) { hookWatch.stop(); hookWatch = null; } }

  function launchLocalFile(file) {
    var r = new FileReader();
    showOverlay('Opening ' + file.name, 'Reading file…', true);
    r.onload = function () { hideOverlay(); startGame(String(r.result), file.name.replace(/\.html?$/i, ''), null); };
    r.onerror = function () { showError('Couldn’t read file', String(r.error)); };
    r.readAsText(file);
  }

  /* ---------- overlay / toast / menus ---------- */
  var ovMode = 'cancel';
  function showOverlay(title, sub, indet) {
    ovMode = 'cancel'; $('#ovBtn').textContent = 'Cancel'; $('#ovBtn').style.display = 'none';
    $('#overlay').classList.add('open'); setOverlay(title, sub, indet, 0);
  }
  function setOverlay(title, sub, indet, pct) {
    if (title != null) $('#ovTitle').textContent = title;
    if (sub != null) $('#ovSub').textContent = sub;
    $('.bar').classList.toggle('indet', !!indet);
    if (pct != null) $('#ovBar').style.width = pct + '%';
  }
  function hideOverlay() { $('#overlay').classList.remove('open'); }
  function showError(title, msg) {
    $('#overlay').classList.add('open');
    setOverlay(title, msg, false, 0);
    ovMode = 'close'; $('#ovBtn').textContent = 'OK'; $('#ovBtn').style.display = '';
  }
  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function popMenu(anchor, items) {
    var m = $('#menuPop'); m.textContent = '';
    items.forEach(function (it) { var b = el('button', null, it[0]); b.onclick = function () { closeMenu(); it[1](); }; m.appendChild(b); });
    var r = anchor.getBoundingClientRect();
    m.classList.add('open');
    m.style.left = Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth) + 'px';
    m.style.top = (r.bottom + 4) + 'px';
  }
  function closeMenu() { $('#menuPop').classList.remove('open'); }

  /* ---------- art ---------- */
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  var svgUid = 0;
  function terrainSVG(seed, cols, rows) {
    var r = rng(seed), W = cols, H = rows, s = [], gid = 'sky' + (++svgUid);
    s.push('<svg class="art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMax slice" shape-rendering="crispEdges">');
    s.push('<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d9de0"/><stop offset="1" stop-color="#bfe0ff"/></linearGradient></defs>');
    s.push('<rect width="' + W + '" height="' + H + '" fill="url(#' + gid + ')"/>');
    var sx = Math.floor(W * (0.65 + r() * 0.2)); s.push('<rect x="' + sx + '" y="2" width="3" height="3" fill="#fff6c8"/><rect x="' + (sx - 1) + '" y="1" width="5" height="5" fill="#fff6c8" opacity=".35"/>');
    for (var c = 0; c < Math.max(3, W / 12); c++) {
      var cx = Math.floor(W * 0.42 + r() * W * 0.55), cy = 1 + Math.floor(r() * H * 0.25), cw = 4 + Math.floor(r() * 7);
      s.push('<rect x="' + cx + '" y="' + cy + '" width="' + cw + '" height="1" fill="#fff" opacity=".9"/><rect x="' + (cx + 1) + '" y="' + (cy - 1) + '" width="' + Math.max(1, cw - 3) + '" height="1" fill="#fff" opacity=".9"/>');
    }
    var h = H * 0.55, x;
    for (x = 0; x < W; x++) { h += Math.round((r() - 0.5) * 2); h = Math.max(H * 0.35, Math.min(H * 0.7, h)); s.push('<rect x="' + x + '" y="' + Math.round(h) + '" width="1" height="' + H + '" fill="#6f9fb8"/>'); }
    h = H * 0.68; var water = Math.round(H * 0.8);
    for (x = 0; x < W; x++) {
      if (r() < 0.45) h += Math.round((r() - 0.5) * 3);
      h = Math.max(H * 0.55, Math.min(H * 0.9, h));
      var y = Math.round(h);
      if (y > water) {
        s.push('<rect x="' + x + '" y="' + water + '" width="1" height="' + (y - water) + '" fill="#3f76e4" opacity=".85"/><rect x="' + x + '" y="' + y + '" width="1" height="2" fill="#dbcf8e"/>');
      } else {
        s.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + (r() < 0.5 ? '#5fa83b' : '#6db744') + '"/>');
        if (r() < 0.07 && y > 6) s.push('<rect x="' + x + '" y="' + (y - 3) + '" width="1" height="3" fill="#6b4a2b"/><rect x="' + (x - 1) + '" y="' + (y - 6) + '" width="3" height="3" fill="#3f7d2a"/>');
      }
      s.push('<rect x="' + x + '" y="' + (y + (y > water ? 2 : 1)) + '" width="1" height="3" fill="#86603f"/><rect x="' + x + '" y="' + (y + 4) + '" width="1" height="' + H + '" fill="#7c7c7c"/>');
      if (r() < 0.25) s.push('<rect x="' + x + '" y="' + (y + 6 + Math.floor(r() * (H - y))) + '" width="1" height="1" fill="' + (r() < 0.2 ? '#3a3a3a' : '#6a6a6a') + '"/>');
    }
    s.push('</svg>');
    return s.join('');
  }
  function hashHue(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h % 360; }
  function genArt(g, w, h) {
    var hue = hashHue(g.id), r = rng(g.seed), s = [];
    s.push('<svg class="art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">');
    s.push('<rect width="' + w + '" height="' + h + '" fill="hsl(' + hue + ',45%,18%)"/>');
    for (var i = 0; i < 26; i++) {
      var sz = 2 + Math.floor(r() * 6);
      s.push('<rect x="' + Math.floor(r() * w) + '" y="' + Math.floor(r() * h) + '" width="' + sz + '" height="' + sz + '" fill="hsl(' + ((hue + r() * 60) % 360) + ',60%,' + (30 + r() * 30) + '%)" opacity="' + (0.3 + r() * 0.5).toFixed(2) + '"/>');
    }
    s.push('</svg>');
    return s.join('');
  }
  /* kind: 'hero' (wide), 'capsule' (460x215), 'portrait' (2:3), 'icon' */
  /* kind: 'hero' (wide banner), 'capsule' (store tile), 'portrait' (library cover), 'icon'.
   * Specific fields (hero/capsule/portrait/icon) win; "image" is the fallback for all of them. */
  function artUrl(g, kind) {
    if (g[kind]) return { url: g[kind], specific: true };
    var alt = kind === 'icon' ? (g.capsule || g.portrait) : kind === 'portrait' ? g.capsule : kind === 'capsule' ? g.hero : null;
    if (alt) return { url: alt, specific: true };
    if (g.image) return { url: g.image, specific: false };
    return null;
  }
  function artInto(box, g, kind, withTitle) {
    var a = artUrl(g, kind);
    function fallback() {
      if (g.art === 'terrain') {
        var dims = kind === 'portrait' ? [24, 36] : kind === 'icon' ? [12, 12] : kind === 'hero' ? [96, 40] : [64, 30];
        box.insertAdjacentHTML('afterbegin', terrainSVG(g.seed + kind.length, dims[0], dims[1]));
      } else {
        var d2 = kind === 'portrait' ? [40, 60] : kind === 'icon' ? [12, 12] : [92, 43];
        box.insertAdjacentHTML('afterbegin', genArt(g, d2[0], d2[1]));
      }
    }
    if (a) {
      var img = el('img', 'art'); img.alt = ''; img.loading = 'lazy';
      img.onerror = function () { img.remove(); fallback(); if (!title && withTitle) addTitle(); };
      img.src = resolveUrl(a.url);
      box.appendChild(img);
    } else fallback();
    // Titles go on generated art and on the shared "image" (usually a screenshot).
    // Dedicated capsule/hero/portrait art is assumed to have its own logo; set "showTitle": true to force one.
    var title = null;
    function addTitle() { title = el('div', 'art-title' + (kind === 'hero' ? ' big' : kind === 'portrait' ? ' tall' : ''), g.name); box.appendChild(title); }
    if (withTitle && kind !== 'icon' && (!a || !a.specific || g.showTitle === true) && g.showTitle !== false) addTitle();
  }
  function tagsEl(g, n) { var t = el('div', 'tags'); g.tags.slice(0, n || 4).forEach(function (x) { t.appendChild(el('span', 'tag', x)); }); return t; }
  function priceEl(lg) { var p = el('div', 'price' + (lg ? ' lg' : '')); p.appendChild(el('span', null, 'Free')); return p; }

  /* ---------- navigation ---------- */
  function go(page, game) {
    view.page = page;
    if (page === 'game') view.game = game;
    if (page === 'profile') view.profileName = game || null;
    if (page === 'library' && game !== undefined) { view.libGame = game ? game.id : null; store.set('libGame', view.libGame); }
    $$('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + page); });
    $$('.nav').forEach(function (n) { n.classList.toggle('active', n.dataset.page === page || (page === 'game' && n.dataset.page === 'store')); });
    $('#settingsBtn').classList.toggle('on', page === 'settings');
    closeMenu();
    renderPage();
    var p = $('#page-' + page); if (p) p.scrollTop = 0;
    var lm = $('#libMain'); if (page === 'library' && lm) lm.scrollTop = 0;
  }
  function renderPage() {
    if (view.page === 'store') renderStore();
    else if (view.page === 'game') renderGamePage();
    else if (view.page === 'library') renderLibrary();
    else if (view.page === 'settings') renderSettings();
    else if (view.page === 'users') { if (social) social.loadUsers(true); }
    else if (view.page === 'leaderboard') { if (social) social.renderLeaderboard(); }
    else if (view.page === 'profile') { if (social) social.renderProfile(view.profileName); }
    else if (view.page === 'achievements') { if (social) social.renderAchPage(); }
  }
  function renderAll() { renderPage(); renderDownloads(); renderAccount(); }

  /* ---------- STORE ---------- */
  var PAGE = 48;
  var storeState = { tag: null, shown: PAGE };
  function featuredGames() {
    var f = GAMES.filter(function (g) { return g.featured; });
    return f.length ? f : GAMES.slice(0, 8);
  }
  function storeGames() {
    var q = $('#storeSearch').value.trim().toLowerCase();
    return GAMES.filter(function (g) {
      if (storeState.tag && g.tags.indexOf(storeState.tag) < 0) return false;
      return !q || (g.name + ' ' + g.tags.join(' ') + ' ' + (g.developer || '')).toLowerCase().indexOf(q) >= 0;
    });
  }
  var TOP_TAGS = (function () {
    var n = {}; GAMES.forEach(function (g) { g.tags.forEach(function (t) { n[t] = (n[t] || 0) + 1; }); });
    return Object.keys(n).filter(function (t) { return n[t] >= 3; }).sort(function (a, b) { return n[b] - n[a]; }).slice(0, 18);
  })();
  function renderStore() { renderFeatured(); renderTagBar(); renderGrid(); }
  function renderFeatured() {
    var F = featuredGames();
    var f = $('#featured'); f.textContent = '';
    var dots = $('#featDots'); dots.textContent = '';
    if (!F.length) { f.appendChild(el('div', 'empty', 'No games in versions.json yet.')); return; }
    view.feat = view.feat % F.length;
    var g = F[view.feat];
    var art = el('div', 'f-art'); artInto(art, g, 'hero', true);
    var side = el('div', 'f-side');
    side.appendChild(el('h3', null, g.name));
    side.appendChild(el('p', null, g.description || ''));
    side.appendChild(tagsEl(g));
    var av = el('div', 'avail'); av.appendChild(el('div', null, inLibrary(g) ? 'In your library' : 'Now available'));
    av.appendChild(priceEl()); side.appendChild(av);
    f.appendChild(art); f.appendChild(side);
    f.onclick = function () { go('game', g); };
    if (F.length > 1) F.forEach(function (x, i) {
      var d = el('button', i === view.feat ? 'on' : ''); d.onclick = function (e) { e.stopPropagation(); view.feat = i; renderFeatured(); }; dots.appendChild(d);
    });
  }
  function renderTagBar() {
    var bar = $('#tagBar'); if (!bar) return; bar.textContent = '';
    if (TOP_TAGS.length < 2) return;
    [null].concat(TOP_TAGS).forEach(function (t) {
      var b = el('button', 'tagchip' + (storeState.tag === t ? ' on' : ''), t || 'All');
      b.onclick = function () { storeState.tag = t; storeState.shown = PAGE; renderTagBar(); renderGrid(); };
      bar.appendChild(b);
    });
  }
  function renderGrid() {
    var list = storeGames();
    var q = $('#storeSearch').value.trim();
    $('#gridTitle').textContent = (storeState.tag || (q ? 'Results' : 'Free to Play')) + ' (' + list.length + ')';
    var grid = $('#storeGrid'); grid.textContent = '';
    if (!list.length) { grid.appendChild(el('div', 'empty', 'No games match your search.')); $('#moreBtn').style.display = 'none'; return; }
    list.slice(0, storeState.shown).forEach(function (g) {
      var c = el('div', 'cap'), a = el('div', 'c-art'); artInto(a, g, 'capsule', true); c.appendChild(a);
      var b = el('div', 'c-body'); b.appendChild(el('div', 'c-name', g.name)); b.appendChild(tagsEl(g, 3));
      var foot = el('div', 'c-foot');
      foot.appendChild(inLibrary(g) ? el('span', 'in-lib', 'In library') : el('span'));
      foot.appendChild(priceEl()); b.appendChild(foot); c.appendChild(b);
      c.onclick = function () { go('game', g); };
      grid.appendChild(c);
    });
    var more = $('#moreBtn');
    more.style.display = list.length > storeState.shown ? '' : 'none';
    more.textContent = 'Show more (' + (list.length - storeState.shown) + ' left)';
  }

  function renderGamePage() {
    var g = view.game, box = $('#gamePage'); box.textContent = '';
    if (!g) return;
    var crumb = el('div', 'crumb'); var a1 = el('a', null, 'All Games'); a1.onclick = function () { go('store'); };
    crumb.appendChild(a1); crumb.appendChild(document.createTextNode(' > Free to Play > ' + g.name)); box.appendChild(crumb);
    box.appendChild(el('h1', 'gp-title', g.name));
    var top = el('div', 'gp-top');
    var hero = el('div', 'gp-hero'); artInto(hero, g, 'hero', false); top.appendChild(hero);
    var info = el('div', 'gp-info');
    var cap = el('div', 'gp-cap'); artInto(cap, g, 'capsule', true); info.appendChild(cap);
    info.appendChild(el('p', null, g.description || ''));
    var meta = el('div', 'gp-meta');
    [g.developer ? ['Developer', g.developer] : null, g.versions.length > 1 ? ['Versions', String(g.versions.length)] : null, ['Genre', g.tags.slice(0, 2).join(', ') || 'Game'], ['Price', 'Free']].filter(Boolean).forEach(function (m) {
      meta.appendChild(el('b', null, m[0])); meta.appendChild(el('span', null, m[1]));
    });
    info.appendChild(meta);
    info.appendChild(tagsEl(g, 6));
    top.appendChild(info); box.appendChild(top);

    var buy = el('div', 'buybox');
    buy.appendChild(el('h4', null, (inLibrary(g) ? '' : 'Play ') + g.name + (inLibrary(g) ? ' is in your library' : '')));
    buy.appendChild(el('div', 'sub', inLibrary(g) ? 'Go to your Library to install and play it.' : 'Free to Play'));
    var act = el('div', 'buy-action');
    if (inLibrary(g)) {
      var openLib = el('button', 'btn green', anyInstalled(g) ? 'Play Now' : 'Install');
      openLib.onclick = function () {
        go('library', g);
        if (anyInstalled(g)) { var v = selVersion(g); play(g, isInstalled(g, v) ? v : g.versions.filter(function (x) { return isInstalled(g, x); })[0]); }
        else { var v2 = selVersion(g); if (v2) install(g, v2).catch(function () {}); }
      };
      act.appendChild(openLib);
    } else {
      act.appendChild(priceEl(true));
      var add = el('button', 'btn green', 'Add to Library');
      add.onclick = function () { addToLibrary(g); toast(g.name + ' was added to your library'); renderGamePage(); };
      act.appendChild(add);
    }
    buy.appendChild(act); box.appendChild(buy);

    var cols = el('div', 'gp-cols'), left = el('div', 'gp-sec');
    left.appendChild(el('h5', null, 'About this game'));
    left.appendChild(el('p', null, g.about || g.description || ''));
    left.appendChild(el('h5', null, 'Versions'));
    var ul = el('ul');
    g.versions.forEach(function (v) { ul.appendChild(el('li', null, v.name + ' · ' + typeLabel(v) + (v.description ? ' · ' + v.description : ''))); });
    left.appendChild(ul);
    if (social) { var ga = el('div', 'gp-ach'); left.appendChild(ga); social.renderGameAch(ga, g.name); }
    cols.appendChild(left);
    var right = el('div');
    var sb = el('div', 'side-box');
    sb.appendChild(el('div', null, g.cloudSaves ? '☁ Cloud saves supported' : 'Saves stay in this browser'));
    sb.appendChild(el('div', null, '🌐 Runs in your browser'));
    sb.appendChild(el('div', null, '⬇ Downloads once, then plays offline'));
    right.appendChild(sb);
    var fw = friendsBox(g); if (fw) right.appendChild(fw);
    cols.appendChild(right);
    box.appendChild(cols);
  }

  /* ---------- LIBRARY ---------- */
  function libGames() {
    var q = $('#libSearch').value.trim().toLowerCase(), instOnly = $('#libInstalled').checked;
    return GAMES.filter(function (g) {
      return inLibrary(g) && (!instOnly || anyInstalled(g)) && (!q || g.name.toLowerCase().indexOf(q) >= 0);
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function renderLibrary() {
    if (!library) return;
    var list = $('#libList'); list.textContent = '';
    var games = libGames();
    $('#libCount').textContent = '(' + games.length + ')';
    var cur = view.libGame && gameById(view.libGame);
    if (cur && !inLibrary(cur)) cur = null;
    $('#libHome').classList.toggle('on', !cur);
    games.forEach(function (g) {
      var b = el('button', 'lib-item' + (anyInstalled(g) ? ' inst' : '') + (cur === g ? ' sel' : ''));
      var ico = el('span', 'li-ico'); artInto(ico, g, 'icon', false); b.appendChild(ico);
      b.appendChild(el('span', null, g.name));
      if (dl && dl.g === g) b.appendChild(el('span', 'li-state', dl.total ? Math.round(dl.got / dl.total * 100) + '%' : '…'));
      else if (runningGame === g) b.appendChild(el('span', 'li-state', 'Running'));
      b.onclick = function () { go('library', g); };
      list.appendChild(b);
    });
    if (cur) renderLibGame(cur); else renderLibHome();
  }

  function portrait(g) {
    var p = el('div', 'portrait'), a = el('div', 'p-art' + (anyInstalled(g) ? '' : ' dim'));
    artInto(a, g, 'portrait', true); p.appendChild(a);
    p.appendChild(el('div', 'p-name', g.name));
    p.appendChild(el('div', 'p-sub', anyInstalled(g) ? 'Last played: ' + ago(store.get('played:' + g.id, 0)) : 'Not installed'));
    p.onclick = function () { go('library', g); };
    return p;
  }
  function renderLibHome() {
    var m = $('#libMain'); m.textContent = '';
    var pg = el('div', 'lib-homepg');
    var owned = GAMES.filter(inLibrary);
    if (!owned.length) {
      var e = el('div', 'empty'); e.appendChild(el('div', null, 'Your library is empty.'));
      var b = el('button', 'btn green', 'Browse the Store'); b.onclick = function () { go('store'); };
      e.appendChild(b); pg.appendChild(e); m.appendChild(pg); return;
    }
    var recent = owned.filter(function (g) { return store.get('played:' + g.id, 0); })
      .sort(function (a, b) { return store.get('played:' + b.id, 0) - store.get('played:' + a.id, 0); }).slice(0, 6);
    if (recent.length) {
      pg.appendChild(el('h4', null, 'Recent Games'));
      var s1 = el('div', 'shelf'); recent.forEach(function (g) { s1.appendChild(portrait(g)); }); pg.appendChild(s1);
    }
    pg.appendChild(el('h4', null, 'All Games (' + owned.length + ')'));
    var s2 = el('div', 'shelf'); owned.forEach(function (g) { s2.appendChild(portrait(g)); }); pg.appendChild(s2);
    m.appendChild(pg);
  }

  function renderBigButton() {
    var host = $('#bigBtnHost'); if (!host) return;
    var g = gameById(view.libGame); if (!g) return;
    var v = selVersion(g); host.textContent = '';
    var btn;
    if (dl && dl.g === g && dl.v === v) {
      btn = el('button', 'bigbtn busy');
      var pct = dl.total ? Math.min(99, Math.round(dl.got / dl.total * 100)) : 0;
      btn.appendChild(document.createTextNode(dl.total ? 'Downloading ' + pct + '%' : 'Downloading…'));
      var bar = el('i'); bar.style.width = (dl.total ? pct : 10) + '%'; btn.appendChild(bar);
    } else if (runningGame === g) {
      btn = el('button', 'bigbtn busy', 'Running');
    } else if (v && isInstalled(g, v)) {
      btn = el('button', 'bigbtn play'); btn.appendChild(el('span', 'tri')); btn.appendChild(document.createTextNode('PLAY'));
      btn.onclick = function () { play(g, v); };
    } else {
      btn = el('button', 'bigbtn install', '⬇ INSTALL');
      btn.disabled = !v;
      btn.onclick = function () { install(g, v).catch(function () {}); };
    }
    host.appendChild(btn);
  }

  function renderLibGame(g) {
    var m = $('#libMain'); m.textContent = '';
    var hero = el('div', 'lib-hero'); artInto(hero, g, 'hero', true); m.appendChild(hero);
    var v = selVersion(g);
    var ab = el('div', 'actionbar');
    var host = el('div'); host.id = 'bigBtnHost'; ab.appendChild(host);
    if (g.versions.length > 1) {
      var sel = el('select', 'vselect');
      g.versions.forEach(function (x) {
        var o = el('option', null, x.name + (isInstalled(g, x) ? '  ✓' : '')); o.value = x.id; if (v && x.id === v.id) o.selected = true; sel.appendChild(o);
      });
      sel.onchange = function () { setSelVersion(g, verById(g, sel.value)); renderLibGame(g); };
      var vs = el('div', 'ab-stat'); vs.appendChild(document.createTextNode('Version')); vs.appendChild(sel); ab.appendChild(vs);
    }
    function stat(label, val) { var s = el('div', 'ab-stat'); s.appendChild(document.createTextNode(label)); s.appendChild(el('b', null, val)); ab.appendChild(s); }
    stat('Last played', ago(store.get('played:' + g.id, 0)));
    var size = installedSize(g); stat('Size on disk', size ? fmtMB(size) : 'Not installed');
    if (g.cloudSaves) stat('Cloud status', !engine ? 'Not set up' : !engine.signedIn() ? 'Signed out' :
      engine.status.state === 'conflict' ? 'Needs attention' : engine.status.state === 'error' ? 'Sync failed' : 'Up to date');
    var right = el('div', 'ab-right');
    var gear = el('button', 'iconbtn', '⚙'); gear.title = 'Manage';
    gear.onclick = function (e) {
      e.stopPropagation();
      var items = [];
      if (v && isInstalled(g, v)) items.push(['Uninstall ' + v.name, function () {
        if (confirm('Uninstall ' + v.name + '? Your saves are kept.')) uninstall(g, v).then(function () { toast(v.name + ' uninstalled'); renderAll(); });
      }]);
      if (anyInstalled(g) && g.versions.length > 1) items.push(['Uninstall all versions', function () {
        if (confirm('Uninstall every version of ' + g.name + '? Your saves are kept.')) Promise.all(g.versions.map(function (x) { return uninstall(g, x); })).then(function () { toast(g.name + ' uninstalled'); renderAll(); });
      }]);
      items.push(['View store page', function () { go('game', g); }]);
      items.push(['Remove from library', function () {
        if (!confirm('Remove ' + g.name + ' from your library? Installed files are deleted, saves are kept.')) return;
        Promise.all(g.versions.map(function (x) { return uninstall(g, x); })).then(function () { removeFromLibrary(g); go('library', null); toast(g.name + ' removed'); });
      }]);
      popMenu(gear, items);
    };
    right.appendChild(gear); ab.appendChild(right);
    m.appendChild(ab);
    renderBigButton();

    var body = el('div', 'lib-body'), left = el('div');
    var news = el('div', 'lcard'); news.appendChild(el('h5', null, 'What’s new'));
    g.versions.forEach(function (x) {
      var n = el('div', 'note'); n.appendChild(el('b', null, x.name));
      (x.notes && x.notes.length ? x.notes : [x.description || typeLabel(x)]).forEach(function (t) { n.appendChild(el('p', null, t)); });
      news.appendChild(n);
    });
    left.appendChild(news);
    if (social) { var la = el('div', 'lcard'); left.appendChild(la); social.renderGameAch(la, g.name); }
    var side = el('div');
    var about = el('div', 'lcard'); about.appendChild(el('h5', null, 'About'));
    about.appendChild(el('p', null, g.description || ''));
    if (g.developer) { var dv = el('p', null, 'Developer: ' + g.developer); dv.style.marginTop = '8px'; dv.style.color = '#8f98a0'; about.appendChild(dv); }
    side.appendChild(about);
    if (g.cloudSaves) {
      var cloud = el('div', 'lcard'); cloud.appendChild(el('h5', null, 'Cloud saves'));
      cloud.appendChild(el('p', null, !engine ? 'Set a save server in Settings to sync worlds between sites.' :
        engine.signedIn() ? 'Signed in as ' + engine.user + '. Worlds sync when you play.' : 'Sign in (top right) to keep worlds on every site.'));
      side.appendChild(cloud);
    }
    var fw2 = friendsBox(g, 'lcard'); if (fw2) side.appendChild(fw2);
    body.appendChild(left); body.appendChild(side); m.appendChild(body);
  }

  /* ---------- SETTINGS ---------- */
  function renderSettings() {
    $('#setMode').value = settings.mode;
    $('#setTitle').value = settings.title;
    $('#srcInfo').textContent = CFG.base;
    $('#setServer').value = settings.server;
    $('#setServer').placeholder = defaultServer() || 'https://saves.example.com';
    var n = Object.keys(installed).length, total = 0;
    Object.keys(installed).forEach(function (k) { total += sizes[k] || 0; });
    $('#cacheInfo').textContent = n ? n + ' version' + (n > 1 ? 's' : '') + ' installed (' + fmtMB(total) + '). Uninstalling frees space; saves are kept.'
      : 'Nothing installed yet.';
  }

  /* ---------- cloud saves ---------- */
  var KNOWN_DBS = [];
  GAMES.forEach(function (g) { g.versions.forEach(function (v) { (v.databases || []).forEach(function (n) { if (KNOWN_DBS.indexOf(n) < 0) KNOWN_DBS.push(n); }); }); });
  var engine = null, autosaveTimer = null;
  function defaultServer() { return RAW.syncServer || ''; }
  function makeEngine() {
    var srv = settings.server || defaultServer();
    engine = (srv && window.EaglerSync) ? new EaglerSync.Engine({ server: srv, store: store, knownDbs: KNOWN_DBS, onChange: function () { renderAccount(); if (view.page === 'library') renderLibrary(); authChanged(); } }) : null;
    renderAccount();
  }
  function renderAccount() {
    var dot = $('#syncDot'); dot.className = 'sync-dot';
    var av = $('#profileBtn .avatar');
    if (!engine || !engine.signedIn()) { av.innerHTML = ''; av.dataset.user = ''; av.classList.remove('has-id'); }
    if (!engine) { $('#pname').textContent = 'Offline'; $('#psub').textContent = 'Saves stay on this site'; return; }
    if (!engine.signedIn()) { $('#pname').textContent = 'Sign in'; $('#psub').textContent = 'Sync saves across sites'; return; }
    var st = engine.status;
    $('#pname').textContent = engine.user;
    if (social && av.dataset.user !== engine.user + social.lookKey(engine.user)) { av.dataset.user = engine.user + social.lookKey(engine.user); av.textContent = ''; av.appendChild(social.avatar(engine.user, 32)); av.classList.add('has-id'); }
    dot.classList.add(st.state === 'idle' ? 'synced' : st.state);
    $('#psub').textContent = st.state === 'syncing' ? (st.message || 'Syncing…') : st.state === 'conflict' ? 'Saves need attention' :
      st.state === 'error' ? 'Sync failed, will retry' : 'Synced ' + ago(st.lastSync).toLowerCase();
  }
  setInterval(function () { if (engine && engine.signedIn() && engine.status.state === 'synced') renderAccount(); }, 30000);

  function openModal(build) {
    var box = $('#mBox'); box.textContent = ''; box.className = 'm-box';
    build(box);
    $('#modal').classList.add('open');
    var f = box.querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 30);
  }
  function closeModal() { $('#modal').classList.remove('open'); }
  function button(cls, label, sub, onclick) {
    var b = el('button', 'btn ' + cls, label); if (sub) b.appendChild(el('small', null, sub)); b.onclick = onclick; return b;
  }
  function field(label, type, name, auto) {
    var l = el('label', 'field'); l.appendChild(el('span', null, label));
    var i = el('input'); i.type = type; i.name = name; i.autocomplete = auto || 'off'; i.spellcheck = false;
    l.appendChild(i); return l;
  }
  function openAccount() {
    if (!engine) {
      return openModal(function (box) {
        box.appendChild(el('h3', null, 'Cloud saves aren’t set up'));
        box.appendChild(el('p', null, 'Add your save server’s address in Settings (or as "syncServer" in versions.json) to sign in and sync worlds between sites.'));
        var a = el('div', 'm-actions');
        a.appendChild(button('ghost', 'Close', null, closeModal));
        a.appendChild(button('green', 'Open settings', null, function () { closeModal(); go('settings'); }));
        box.appendChild(a);
      });
    }
    if (!engine.signedIn()) return openAuth('login');
    openModal(function (box) {
      var st = engine.status;
      box.appendChild(el('h3', null, engine.user));
      box.appendChild(el('p', null, st.state === 'conflict' ? st.message : st.state === 'error' ? 'Last sync failed: ' + st.message :
        'Last synced ' + ago(st.lastSync).toLowerCase() + '. Worlds sync when you press Play, every few minutes while you play, and when you come back to the library.'));
      var stack = el('div', 'm-stack');
      if (st.state === 'conflict') stack.appendChild(button('green', 'Fix save conflict', null, function () { closeModal(); runSync(true); }));
      stack.appendChild(button('', 'My profile & achievements', null, function () { closeModal(); go('profile', engine.user); }));
      stack.appendChild(button('', 'Friends & chat', null, function () { closeModal(); social.togglePanel(true); }));
      stack.appendChild(button('', 'Sync now', null, function () { if (gameFrame) { toast('Return to the library first'); return; } closeModal(); runSync(true); }));
      stack.appendChild(button('', 'Change password', null, openChangePassword));
      stack.appendChild(button('', 'Sign out', 'Worlds already on this site stay here.', function () { engine.signOut().then(function () { closeModal(); toast('Signed out'); }); }));
      box.appendChild(stack);
      var a = el('div', 'm-actions'); a.appendChild(button('ghost', 'Close', null, closeModal)); box.appendChild(a);
    });
  }
  function openAuth(mode) {
    openModal(function (box) {
      var tabs = el('div', 'm-tabs');
      var tIn = el('button', mode === 'login' ? 'active' : '', 'Sign in'), tUp = el('button', mode === 'register' ? 'active' : '', 'Create account');
      tIn.onclick = function () { openAuth('login'); }; tUp.onclick = function () { openAuth('register'); };
      tabs.appendChild(tIn); tabs.appendChild(tUp); box.appendChild(tabs);
      box.appendChild(el('p', null, mode === 'login' ? 'Sign in to bring your worlds to any site you open the launcher from.' : 'Pick a username and password. Your worlds will sync to this account.'));
      var form = el('form');
      form.appendChild(field('Account name', 'text', 'u', 'username'));
      form.appendChild(field('Password', 'password', 'p', mode === 'login' ? 'current-password' : 'new-password'));
      if (mode === 'register') form.appendChild(field('Confirm password', 'password', 'p2', 'new-password'));
      var err = el('div', 'm-err'); form.appendChild(err);
      var a = el('div', 'm-actions');
      var cancel = button('ghost', 'Cancel', null, closeModal); cancel.type = 'button';
      var goBtn = el('button', 'btn green', mode === 'login' ? 'Sign in' : 'Create account'); goBtn.type = 'submit';
      a.appendChild(cancel); a.appendChild(goBtn); form.appendChild(a);
      form.onsubmit = function (e) {
        e.preventDefault();
        var u = form.u.value.trim(), p = form.p.value;
        if (mode === 'register' && p !== form.p2.value) { err.textContent = 'Passwords don’t match.'; return; }
        goBtn.disabled = true; err.textContent = '';
        engine.auth(mode, u, p).then(function () { closeModal(); toast('Signed in as ' + engine.user); if (!gameFrame) runSync(true); },
          function (e2) { err.textContent = e2.message; goBtn.disabled = false; });
      };
      box.appendChild(form);
    });
  }
  function openChangePassword() {
    openModal(function (box) {
      box.appendChild(el('h3', null, 'Change password'));
      box.appendChild(el('p', null, 'You’ll stay signed in here. Other sites will need the new password.'));
      var form = el('form');
      form.appendChild(field('Current password', 'password', 'c', 'current-password'));
      form.appendChild(field('New password', 'password', 'n', 'new-password'));
      var err = el('div', 'm-err'); form.appendChild(err);
      var a = el('div', 'm-actions');
      var cancel = button('ghost', 'Cancel', null, closeModal); cancel.type = 'button';
      var goBtn = el('button', 'btn green', 'Change password'); goBtn.type = 'submit';
      a.appendChild(cancel); a.appendChild(goBtn); form.appendChild(a);
      form.onsubmit = function (e) {
        e.preventDefault(); goBtn.disabled = true; err.textContent = '';
        engine.changePassword(form.c.value, form.n.value).then(function () { closeModal(); toast('Password changed'); },
          function (e2) { err.textContent = e2.message; goBtn.disabled = false; });
      };
      box.appendChild(form);
    });
  }
  function askConflict(remote) {
    return new Promise(function (done) {
      openModal(function (box) {
        box.appendChild(el('h3', null, 'Your saves don’t match'));
        box.appendChild(el('p', null, 'This site has worlds that aren’t in your cloud saves, and your cloud saves ' +
          (remote && remote.updatedAt ? 'were last updated ' + ago(remote.updatedAt).toLowerCase() + ' on another site.' : 'are different.') +
          ' Pick which copy to keep. The other one gets replaced.'));
        var stack = el('div', 'm-stack');
        function pick(choice) {
          closeModal();
          showOverlay(choice === 'cloud' ? 'Downloading cloud saves' : 'Uploading this site’s saves', 'This can take a moment for big worlds…', true);
          engine.resolve(choice).then(function () { hideOverlay(); toast(choice === 'cloud' ? 'Cloud saves loaded' : 'Cloud saves updated'); done(true); },
            function (e) { hideOverlay(); toast('Sync failed: ' + e.message); done(false); });
        }
        stack.appendChild(button('green', 'Use cloud saves', 'Replace this site’s worlds with the ones from your account.', function () { pick('cloud'); }));
        stack.appendChild(button('', 'Keep this site’s saves', 'Upload this site’s worlds and replace your cloud saves.', function () { pick('local'); }));
        stack.appendChild(button('', 'Export this site’s saves first', 'Download a backup file, then choose.', exportSaves));
        box.appendChild(stack);
        var a = el('div', 'm-actions'); a.appendChild(button('ghost', 'Decide later', null, function () { closeModal(); done(false); })); box.appendChild(a);
      });
    });
  }
  function runSync(interactive) {
    if (!engine || !engine.signedIn() || gameFrame) return Promise.resolve();
    return engine.sync().then(function (r) {
      if (r.action === 'pulled') toast('Got your latest worlds from the cloud');
      else if (r.action === 'pushed' && interactive) toast('Worlds backed up to the cloud');
      else if (r.action === 'in-sync' && interactive) toast('Everything is up to date');
      if (r.action === 'conflict') return askConflict(r.remote);
    }, function (e) { if (interactive) toast('Sync failed: ' + e.message); });
  }
  function backgroundSync() { return runSync(false); }
  function preLaunchSync() {
    if (!engine || !engine.signedIn()) return Promise.resolve();
    setOverlay('Syncing saves', 'Checking your cloud saves…', true);
    return engine.sync().then(function (r) {
      if (r.action === 'pulled') toast('Got your latest worlds from the cloud');
      if (r.action === 'conflict') { hideOverlay(); return askConflict(r.remote); }
    }, function (e) { toast('Cloud saves unavailable (' + e.message + '). Playing with this site’s saves.'); });
  }
  function backupNow() { if (engine && engine.signedIn() && gameFrame) engine.sync({ allowPull: false }).catch(function () {}); }
  function startAutosave() { stopAutosave(); if (engine && engine.signedIn()) autosaveTimer = setInterval(backupNow, 3 * 60 * 1000); }
  function stopAutosave() { if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && (!runningGame || runningGame.cloudSaves)) backupNow(); });

  function exportSaves() {
    EaglerSync.exportFile(KNOWN_DBS).then(function (r) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.bytes], { type: 'application/octet-stream' }));
      a.download = 'eaglercraft-saves-' + new Date().toISOString().slice(0, 10) + '.eglsave';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast(r.records ? 'Exported ' + r.records + ' save records' : 'Exported (no worlds on this site yet)');
    }, function (e) { toast('Export failed: ' + e.message); });
  }
  function importSaves(file) {
    if (gameFrame) { toast('Return to the library first'); return; }
    if (!confirm('Replace this site’s worlds with "' + file.name + '"?')) return;
    showOverlay('Importing saves', file.name, true);
    file.arrayBuffer().then(function (b) { return EaglerSync.restore(new Uint8Array(b), KNOWN_DBS); }).then(function () {
      hideOverlay(); toast('Saves imported'); backgroundSync();
    }, function (e) { showError('Import failed', e.message); });
  }

  /* ---------- wire up ---------- */
  document.title = settings.title;
  $('#brandName').textContent = LAUNCHER_NAME;
  $$('.nav').forEach(function (n) { n.onclick = function () { go(n.dataset.page); }; });
  $('#settingsBtn').onclick = function () { go(view.page === 'settings' ? 'library' : 'settings'); };
  $('#profileBtn').onclick = openAccount;
  $('#libHome').onclick = function () { go('library', null); };
  $('#storeSearch').oninput = function () { storeState.shown = PAGE; renderGrid(); };
  $('#moreBtn').onclick = function () { storeState.shown += PAGE; renderGrid(); };
  $('#libSearch').oninput = renderLibrary;
  $('#libInstalled').onchange = renderLibrary;
  $('#openLocal').onclick = function () { $('#fileIn').click(); };
  $('#fileIn').onchange = function () { var f = this.files[0]; this.value = ''; if (f) launchLocalFile(f); };
  $('#dlCancel').onclick = function () { if (dl && dl.ctrl) dl.ctrl.abort(); };
  $('#ovBtn').onclick = hideOverlay;
  $('#backBtn').onclick = function () { closeGame(false); };
  $('#modal').addEventListener('mousedown', function (e) { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('click', function (e) { if (!e.target.closest('#menuPop')) closeMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); closeModal(); } });
  document.addEventListener('mousemove', function (e) { $('#backBtn').classList.toggle('peek', e.clientY < 8); });
  $('#setMode').onchange = function () { settings.mode = this.value; store.set('mode', settings.mode); toast('Saved'); };
  $('#setTitle').onchange = function () {
    settings.title = this.value.trim() || LAUNCHER_NAME; store.set('title', settings.title);
    if (!gameFrame) document.title = settings.title; toast('Saved');
  };
  $('#clearCache').onclick = function () {
    if (!confirm('Uninstall every game? Your saves are kept.')) return;
    (window.caches ? caches.delete(CACHE_NAME) : Promise.resolve()).then(function () { installed = {}; sizes = {}; store.set('sizes', sizes); renderAll(); toast('All games uninstalled'); });
  };
  $('#setServer').onchange = function () {
    var v = this.value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//.test(v)) { toast('The address must start with https://'); return; }
    if (engine && engine.signedIn()) engine.forget();
    settings.server = v; store.set('syncServer', v); makeEngine(); toast('Saved');
  };
  $('#exportSaves').onclick = exportSaves;
  $('#importSaves').onclick = function () { $('#saveIn').click(); };
  $('#saveIn').onchange = function () { var f = this.files[0]; this.value = ''; if (f) importSaves(f); };
  setInterval(function () { if (view.page === 'store' && featuredGames().length > 1 && !$('#featured').matches(':hover')) { view.feat = (view.feat + 1) % featuredGames().length; renderFeatured(); } }, 8000);

  var social = null, lastUser;
  function authChanged() {
    var u = engine && engine.signedIn() ? engine.user : null;
    if (u !== lastUser) { lastUser = u; if (social) social.onAuthChange(); }
  }
  function friendsBox(g, cls) {
    if (!social) return null;
    var fs = social.friendsWhoPlay(g.name); if (!fs.length) return null;
    var box = el('div', (cls || 'side-box') + ' fw');
    box.appendChild(el(cls ? 'h5' : 'div', cls ? null : 'fw-h', fs.length + ' friend' + (fs.length > 1 ? 's' : '') + ' play' + (fs.length > 1 ? '' : 's') + ' this'));
    fs.slice(0, 6).forEach(function (f) {
      var r = el('button', 'fw-row'); r.appendChild(social.avatar(f.name, 24, f.state));
      var t = el('span', 'fp-t'); t.appendChild(el('b', null, f.name)); t.appendChild(el('small', 'st-' + f.state, social.stateText(f))); r.appendChild(t);
      r.onclick = function () { social.openProfile(f.name); };
      box.appendChild(r);
    });
    return box;
  }
  function gameByName(n) { for (var i = 0; i < GAMES.length; i++) if (GAMES[i].name === n) return GAMES[i]; return null; }

  makeEngine();
  lastUser = engine && engine.signedIn() ? engine.user : null;
  // Pages that block storage: games can't keep progress and nothing can be synced. Say so once.
  if (window.EaglerSync && EaglerSync.storageBlocked && EaglerSync.storageBlocked()) {
    var nsBar = el('div', 'nostore-bar');
    nsBar.appendChild(el('span', null, '⚠️ This page blocks saved data, so game progress and cloud saves won’t work and you’ll be signed out when you close it. Run the Mist bookmarklet from a normal website (for example wikipedia.org) instead of a new tab or search page.'));
    var nsX = el('button', null, '✕'); nsX.onclick = function () { nsBar.remove(); }; nsBar.appendChild(nsX);
    document.body.appendChild(nsBar);
  }
  social = window.MistSocial ? MistSocial({
    getEngine: function () { return engine; }, onLooks: function () { renderAccount(); }, el: el, toast: toast, ago: ago, popMenu: popMenu,
    openModal: openModal, closeModal: closeModal, field: field, button: button, openAccount: openAccount,
    gameByName: gameByName, artInto: artInto, showGame: function (g) { go('game', g); },
    showProfile: function (n) { go('profile', n); },
    showAchievements: function () { go('achievements'); },
    gameNames: function () { return GAMES.map(function (g) { return g.name; }); }
  }) : null;
  renderAccount();
  if (social) {
    $('#friendsBtn').onclick = function () { social.togglePanel(); };
    $('#navFriends').onclick = function () { social.togglePanel(); };
    social.wireUsers();
    social.start();
    var lastFriendsKey = '';
    setInterval(function () { // re-render "friends who play" boxes when friend data changes
      var d = social.data(), k = d ? JSON.stringify(d.friends.map(function (f) { return [f.name, f.state, f.game]; })) : '';
      if (k !== lastFriendsKey) { lastFriendsKey = k; if (view.page === 'game' || view.page === 'library') renderPage(); }
    }, 5000);
  }
  library = library || null;
  refreshInstalled().then(function () {
    // First visit lands on the Store; after that, open straight to the Library.
    if (store.get('visited', false)) go('library'); else { store.set('visited', true); go('store'); }
    backgroundSync();
  });
})();

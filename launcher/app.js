/* Eaglercraft Launcher — UI logic (runs inside the about:blank window) */
(function () {
  'use strict';
  var CFG = window.__EL_CFG || { base: './', versions: { versions: [] } };
  var VERSIONS = (CFG.versions && CFG.versions.versions) || CFG.versions || [];
  var CACHE_NAME = 'eagler-launcher-v1';
  var TYPE_LABEL = { release: 'Release', snapshot: 'Snapshot', old_beta: 'Beta', old_alpha: 'Alpha', modded: 'Modded' };

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* ---------- storage ---------- */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('eaglerLauncher:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('eaglerLauncher:' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var settings = {
    mode: store.get('mode', 'iframe'),
    title: store.get('title', 'Eaglercraft Launcher')
  };
  var selectedId = store.get('selected', VERSIONS[0] && VERSIONS[0].id);
  if (!byId(selectedId) && VERSIONS[0]) selectedId = VERSIONS[0].id;
  var cachedIds = {};

  function byId(id) { for (var i = 0; i < VERSIONS.length; i++) if (VERSIONS[i].id === id) return VERSIONS[i]; return null; }
  function typeLabel(v) { return TYPE_LABEL[v.type] || v.type || 'Release'; }
  function versionUrl(v) { return /^https?:\/\//.test(v.file) ? v.file : CFG.base + 'versions/' + v.file; }
  function cacheKey(v) { return 'https://eagler-launcher.invalid/' + encodeURIComponent(v.id) + '?f=' + encodeURIComponent(v.file) + '&r=' + encodeURIComponent(v.rev || ''); }
  function fmtMB(b) { return (b / 1048576).toFixed(1) + ' MB'; }

  /* ---------- cache (Cache API, falls back to no caching) ---------- */
  function cacheOpen() { return (window.caches && caches.open) ? caches.open(CACHE_NAME) : Promise.reject(new Error('no cache')); }
  function cacheGet(v) {
    return cacheOpen().then(function (c) { return c.match(cacheKey(v)); })
      .then(function (r) { return r ? r.text() : null; }).catch(function () { return null; });
  }
  function cachePut(v, html) {
    return cacheOpen().then(function (c) {
      return c.put(cacheKey(v), new Response(html, { headers: { 'content-type': 'text/html' } }));
    }).then(function () { cachedIds[v.id] = true; }).catch(function () {});
  }
  function cacheDelete(v) {
    return cacheOpen().then(function (c) {
      return c.keys().then(function (keys) {
        var pre = 'https://eagler-launcher.invalid/' + encodeURIComponent(v.id) + '?';
        return Promise.all(keys.filter(function (k) { return k.url.indexOf(pre) === 0; }).map(function (k) { return c.delete(k); }));
      });
    }).then(function () { delete cachedIds[v.id]; }).catch(function () {});
  }
  function refreshCacheState() {
    return cacheOpen().then(function (c) { return c.keys(); }).then(function (keys) {
      var urls = {}; keys.forEach(function (k) { urls[k.url] = 1; });
      cachedIds = {};
      VERSIONS.forEach(function (v) { if (urls[cacheKey(v)]) cachedIds[v.id] = true; });
    }).catch(function () {}).then(renderAll);
  }

  /* ---------- download with progress ---------- */
  var currentAbort = null;
  function download(v, onProgress) {
    var ctrl = window.AbortController ? new AbortController() : null;
    currentAbort = ctrl;
    return fetch(versionUrl(v), { cache: 'no-store', signal: ctrl && ctrl.signal }).then(function (r) {
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
      return html;
    });
  }

  /* ---------- launching ---------- */
  var gameFrame = null, gameUrl = null;
  function launch(v) {
    if (!v) return;
    selectedId = v.id; store.set('selected', v.id); renderPlay();
    showOverlay('Preparing ' + v.name, cachedIds[v.id] ? 'Loading from downloads…' : 'Checking downloads…', true);
    cacheGet(v).then(function (html) {
      if (html) return html;
      setOverlay('Downloading ' + v.name, 'Connecting…', true);
      return download(v, function (got, total) {
        if (total) {
          var pct = Math.min(99, Math.round(got / total * 100));
          setOverlay(null, fmtMB(got) + ' / ' + fmtMB(Math.max(got, total)) + ' · ' + pct + '%', false, pct);
        } else setOverlay(null, fmtMB(got) + ' downloaded', true);
      }).then(function (h) {
        setOverlay('Saving ' + v.name, 'Storing for instant launches next time…', true);
        return cachePut(v, h).then(function () { return h; });
      });
    }).then(function (html) {
      return preLaunchSync().then(function () { return html; });
    }).then(function (html) {
      showOverlay('Starting ' + v.name, '', false);
      setOverlay(null, null, false, 100);
      setTimeout(function () { hideOverlay(); renderAll(); startGame(html, v.name); }, 120);
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { hideOverlay(); return; }
      showError('Could not launch ' + v.name, e.message || String(e));
    });
  }

  function startGame(html, name) {
    if (settings.mode === 'replace') {
      stopAutosave();
      document.open(); document.write(html); document.close();
      return;
    }
    closeGame(true);
    gameUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    gameFrame = document.createElement('iframe');
    gameFrame.id = 'game';
    gameFrame.setAttribute('allow', 'fullscreen; pointer-lock; autoplay; gamepad; clipboard-read; clipboard-write; microphone');
    gameFrame.setAttribute('allowfullscreen', '');
    gameFrame.src = gameUrl;
    document.body.appendChild(gameFrame);
    document.body.classList.add('in-game');
    document.title = name + ' · ' + settings.title;
    setTimeout(function () { try { gameFrame.focus(); } catch (e) {} }, 300);
    startAutosave();
    var b = $('#backBtn'); b.classList.add('peek'); setTimeout(function () { b.classList.remove('peek'); }, 2500);
  }

  function closeGame(silent) {
    if (!gameFrame) return;
    if (!silent && !confirm('Return to the launcher? Unsaved progress in the running game will be lost.')) return;
    gameFrame.remove(); gameFrame = null;
    if (gameUrl) { URL.revokeObjectURL(gameUrl); gameUrl = null; }
    document.body.classList.remove('in-game');
    document.title = settings.title;
    stopAutosave();
    if (!silent && engine && engine.signedIn()) setTimeout(function () { backgroundSync(); }, 600);
  }

  function launchLocalFile(file) {
    var r = new FileReader();
    showOverlay('Opening ' + file.name, 'Reading file…', true);
    r.onload = function () { hideOverlay(); startGame(String(r.result), file.name.replace(/\.html?$/i, '')); };
    r.onerror = function () { showError('Could not read file', String(r.error)); };
    r.readAsText(file);
  }

  /* ---------- overlay / toast ---------- */
  var ovMode = 'cancel';
  function showOverlay(title, sub, indet) {
    ovMode = 'cancel'; $('#ovBtn').textContent = 'Cancel';
    $('#overlay').classList.add('open'); setOverlay(title, sub, indet, 0);
  }
  function setOverlay(title, sub, indet, pct) {
    if (title != null) $('#ovTitle').textContent = title;
    if (sub != null) $('#ovSub').textContent = sub;
    $('.bar').classList.toggle('indet', !!indet);
    if (pct != null) $('#ovBar').style.width = pct + '%';
  }
  function hideOverlay() { $('#overlay').classList.remove('open'); currentAbort = null; }
  function showError(title, msg) {
    $('#overlay').classList.add('open');
    setOverlay(title, msg, false, 0);
    ovMode = 'close'; $('#ovBtn').textContent = 'OK';
  }
  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------- views ---------- */
  function setView(name) {
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === name); });
    $$('.side-link[data-view]').forEach(function (t) { t.classList.toggle('active', t.dataset.view === name); });
    $('.game').classList.toggle('active', name !== 'settings');
    closeMenu();
  }

  function renderPlay() {
    var v = byId(selectedId);
    $('#heroTitle').textContent = v ? v.name : 'No versions yet';
    $('#heroDesc').textContent = v ? (v.description || '') : 'Add versions to versions.json in your repo.';
    $('#vselName').textContent = v ? v.name : 'No versions';
    $('#vselSub').textContent = v ? typeLabel(v) + ' · ' + v.id : '';
    $('#playBtn').disabled = !v;
    var cs = $('#cacheState'); cs.textContent = '';
    if (v) {
      cs.appendChild(el('b', null, cachedIds[v.id] ? 'Ready to play' : 'Download required'));
      cs.appendChild(document.createTextNode(cachedIds[v.id] ? 'Opens instantly' : (v.sizeMB ? '~' + v.sizeMB + ' MB on first launch' : 'Downloads on first launch')));
    }
    var m = $('#vmenu'); m.textContent = '';
    VERSIONS.forEach(function (ver) {
      var b = el('button', 'vitem' + (ver.id === selectedId ? ' sel' : ''));
      b.appendChild(el('span', 'vicon'));
      var t = el('span', 'vtext'); t.appendChild(el('b', null, ver.name)); t.appendChild(el('small', null, typeLabel(ver) + ' · ' + ver.id + (cachedIds[ver.id] ? ' · downloaded' : '')));
      b.appendChild(t);
      b.onclick = function () { selectedId = ver.id; store.set('selected', ver.id); closeMenu(); renderPlay(); };
      m.appendChild(b);
    });
  }

  function renderInstalls() {
    var q = $('#search').value.trim().toLowerCase(), showBeta = $('#showBeta').checked;
    var list = $('#installList'); list.textContent = '';
    var shown = VERSIONS.filter(function (v) {
      if (!showBeta && (v.type === 'old_beta' || v.type === 'old_alpha' || v.type === 'snapshot')) return false;
      return !q || (v.name + ' ' + v.id).toLowerCase().indexOf(q) >= 0;
    });
    if (!shown.length) { list.appendChild(el('div', 'empty', VERSIONS.length ? 'No installations match.' : 'No versions in versions.json yet.')); return; }
    shown.forEach(function (v) {
      var row = el('div', 'irow');
      row.appendChild(el('span', 'vicon'));
      var info = el('div', 'iinfo'), name = el('b', null, v.name);
      name.appendChild(el('span', 'badge', typeLabel(v)));
      if (cachedIds[v.id]) name.appendChild(el('span', 'badge ok', 'Downloaded'));
      info.appendChild(name); info.appendChild(el('small', null, v.description || v.id));
      row.appendChild(info);
      if (cachedIds[v.id]) {
        var del = el('button', 'btn ghost', 'Remove download');
        del.onclick = function () { cacheDelete(v).then(function () { toast('Removed ' + v.name); renderAll(); }); };
        row.appendChild(del);
      }
      var play = el('button', 'btn green', 'Play');
      play.onclick = function () { setView('play'); launch(v); };
      row.appendChild(play);
      list.appendChild(row);
    });
  }

  function renderNotes() {
    var box = $('#notesList'); box.textContent = '';
    if (!VERSIONS.length) { box.appendChild(el('div', 'empty', 'Nothing here yet.')); return; }
    VERSIONS.forEach(function (v, i) {
      var c = el('div', 'ncard'), art = el('div', 'nart');
      art.innerHTML = terrainSVG(900 + i * 77, 48, 18);
      c.appendChild(art);
      var b = el('div', 'nbody');
      b.appendChild(el('h3', null, v.name));
      b.appendChild(el('small', null, typeLabel(v) + ' · ' + v.id));
      var notes = v.notes && v.notes.length ? v.notes : [v.description || 'No notes for this version.'];
      var ul = el('ul'); notes.forEach(function (n) { ul.appendChild(el('li', null, n)); });
      b.appendChild(ul); c.appendChild(b); box.appendChild(c);
    });
  }

  function renderSettings() {
    $('#setMode').value = settings.mode;
    $('#setTitle').value = settings.title;
    $('#srcInfo').textContent = CFG.base;
    $('#setServer').value = settings.server;
    $('#setServer').placeholder = defaultServer() || 'https://saves.example.com';
    var n = Object.keys(cachedIds).length;
    $('#cacheInfo').textContent = n ? n + ' version' + (n > 1 ? 's' : '') + ' downloaded. Clearing frees space; they re-download on next launch.'
      : 'Versions are cached after the first launch so they open instantly.';
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        if (n && e.usage) $('#cacheInfo').textContent += ' (' + fmtMB(e.usage) + ' used)';
      }).catch(function () {});
    }
  }

  function renderAll() { renderPlay(); renderInstalls(); renderNotes(); renderSettings(); }

  /* ---------- menu ---------- */
  function closeMenu() { $('#vmenu').classList.remove('open'); $('#vselBtn').classList.remove('open'); }

  /* ---------- procedural blocky landscape (original art) ---------- */
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  function terrainSVG(seed, cols, rows) {
    var r = rng(seed), W = cols, H = rows, s = [];
    s.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMax slice" shape-rendering="crispEdges" style="width:100%;height:100%;display:block">');
    s.push('<defs><linearGradient id="sky' + seed + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d9de0"/><stop offset="1" stop-color="#bfe0ff"/></linearGradient></defs>');
    s.push('<rect width="' + W + '" height="' + H + '" fill="url(#sky' + seed + ')"/>');
    var sx = Math.floor(W * (0.65 + r() * 0.2)); s.push('<rect x="' + sx + '" y="2" width="3" height="3" fill="#fff6c8"/><rect x="' + (sx - 1) + '" y="1" width="5" height="5" fill="#fff6c8" opacity=".35"/>');
    for (var c = 0; c < Math.max(3, W / 12); c++) {
      var cx = Math.floor(W * 0.42 + r() * W * 0.55), cy = 1 + Math.floor(r() * H * 0.25), cw = 4 + Math.floor(r() * 7);
      s.push('<rect x="' + cx + '" y="' + cy + '" width="' + cw + '" height="1" fill="#fff" opacity=".9"/><rect x="' + (cx + 1) + '" y="' + (cy - 1) + '" width="' + Math.max(1, cw - 3) + '" height="1" fill="#fff" opacity=".9"/>');
    }
    // far hills
    var h = H * 0.55;
    for (var x = 0; x < W; x++) {
      h += Math.round((r() - 0.5) * 2); h = Math.max(H * 0.35, Math.min(H * 0.7, h));
      s.push('<rect x="' + x + '" y="' + Math.round(h) + '" width="1" height="' + H + '" fill="#6f9fb8"/>');
    }
    // near terrain
    h = H * 0.68; var water = Math.round(H * 0.8);
    for (x = 0; x < W; x++) {
      if (r() < 0.45) h += Math.round((r() - 0.5) * 3);
      h = Math.max(H * 0.55, Math.min(H * 0.9, h));
      var y = Math.round(h);
      if (y > water) {
        s.push('<rect x="' + x + '" y="' + water + '" width="1" height="' + (y - water) + '" fill="#3f76e4" opacity=".85"/>');
        s.push('<rect x="' + x + '" y="' + y + '" width="1" height="2" fill="#dbcf8e"/>');
      } else {
        s.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + (r() < 0.5 ? '#5fa83b' : '#6db744') + '"/>');
        if (r() < 0.07 && y > 6) { // tree
          s.push('<rect x="' + x + '" y="' + (y - 3) + '" width="1" height="3" fill="#6b4a2b"/>');
          s.push('<rect x="' + (x - 1) + '" y="' + (y - 6) + '" width="3" height="3" fill="#3f7d2a"/>');
        }
      }
      s.push('<rect x="' + x + '" y="' + (y + (y > water ? 2 : 1)) + '" width="1" height="3" fill="#86603f"/>');
      s.push('<rect x="' + x + '" y="' + (y + 4) + '" width="1" height="' + H + '" fill="#7c7c7c"/>');
      if (r() < 0.25) s.push('<rect x="' + x + '" y="' + (y + 6 + Math.floor(r() * (H - y))) + '" width="1" height="1" fill="' + (r() < 0.2 ? '#3a3a3a' : '#6a6a6a') + '"/>');
    }
    s.push('</svg>');
    return s.join('');
  }

  /* ---------- cloud saves ---------- */
  var KNOWN_DBS = [];
  VERSIONS.forEach(function (v) { (v.databases || []).forEach(function (n) { if (KNOWN_DBS.indexOf(n) < 0) KNOWN_DBS.push(n); }); });
  settings.server = store.get('syncServer', '');
  var engine = null, autosaveTimer = null;

  function defaultServer() { return (CFG.versions && CFG.versions.syncServer) || ''; }
  function makeEngine() {
    var srv = settings.server || defaultServer();
    engine = (srv && window.EaglerSync) ? new EaglerSync.Engine({ server: srv, store: store, knownDbs: KNOWN_DBS, onChange: renderAccount }) : null;
    renderAccount();
  }
  function ago(t) {
    if (!t) return 'never';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString();
  }
  function renderAccount() {
    var dot = $('#syncDot'); dot.className = 'sync-dot';
    if (!engine) { $('#pname').textContent = 'Offline'; $('#psub').textContent = 'Saves stay on this site'; return; }
    if (!engine.signedIn()) { $('#pname').textContent = 'Not signed in'; $('#psub').textContent = 'Sign in to sync worlds'; return; }
    var st = engine.status;
    $('#pname').textContent = engine.user;
    dot.classList.add(st.state === 'idle' ? 'synced' : st.state);
    $('#psub').textContent =
      st.state === 'syncing' ? (st.message || 'Syncing…') :
      st.state === 'conflict' ? 'Saves need attention' :
      st.state === 'error' ? 'Sync failed, will retry' :
      'Synced ' + ago(st.lastSync);
  }
  setInterval(function () { if (engine && engine.signedIn() && engine.status.state === 'synced') renderAccount(); }, 30000);

  /* modal helpers */
  function openModal(build) {
    var box = $('#mBox'); box.textContent = '';
    build(box);
    $('#modal').classList.add('open');
    var f = box.querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 30);
  }
  function closeModal() { $('#modal').classList.remove('open'); }
  function button(cls, label, sub, onclick) {
    var b = el('button', 'btn ' + cls, label);
    if (sub) b.appendChild(el('small', null, sub));
    b.onclick = onclick; return b;
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
        a.appendChild(button('green', 'Open settings', null, function () { closeModal(); setView('settings'); }));
        box.appendChild(a);
      });
    }
    if (!engine.signedIn()) return openAuth('login');
    openModal(function (box) {
      var st = engine.status;
      box.appendChild(el('h3', null, engine.user));
      box.appendChild(el('p', null, st.state === 'conflict' ? st.message :
        st.state === 'error' ? 'Last sync failed: ' + st.message :
        'Last synced ' + ago(st.lastSync) + '. Worlds sync when you press Play, every few minutes while you play, and when you come back to the launcher.'));
      var stack = el('div', 'm-stack');
      if (st.state === 'conflict') stack.appendChild(button('green', 'Fix save conflict', null, function () { closeModal(); runSync(true); }));
      stack.appendChild(button('', 'Sync now', null, function () {
        if (gameFrame) { toast('Return to the launcher first'); return; }
        closeModal(); runSync(true);
      }));
      stack.appendChild(button('', 'Change password', null, openChangePassword));
      stack.appendChild(button('', 'Sign out', 'Worlds already on this site stay here.', function () {
        engine.signOut().then(function () { closeModal(); toast('Signed out'); });
      }));
      box.appendChild(stack);
      var a = el('div', 'm-actions'); a.appendChild(button('ghost', 'Close', null, closeModal)); box.appendChild(a);
    });
  }

  function openAuth(mode) {
    openModal(function (box) {
      var tabs = el('div', 'm-tabs');
      var tIn = el('button', mode === 'login' ? 'active' : '', 'Sign in');
      var tUp = el('button', mode === 'register' ? 'active' : '', 'Create account');
      tIn.onclick = function () { openAuth('login'); }; tUp.onclick = function () { openAuth('register'); };
      tabs.appendChild(tIn); tabs.appendChild(tUp); box.appendChild(tabs);
      box.appendChild(el('p', null, mode === 'login'
        ? 'Sign in to bring your worlds to any site you open the launcher from.'
        : 'Pick a username and password. Your worlds will sync to this account.'));
      var form = el('form');
      form.appendChild(field('Username', 'text', 'u', 'username'));
      form.appendChild(field('Password', 'password', 'p', mode === 'login' ? 'current-password' : 'new-password'));
      if (mode === 'register') form.appendChild(field('Confirm password', 'password', 'p2', 'new-password'));
      var err = el('div', 'm-err'); form.appendChild(err);
      var a = el('div', 'm-actions');
      var cancel = button('ghost', 'Cancel', null, closeModal); cancel.type = 'button';
      var go = el('button', 'btn green', mode === 'login' ? 'Sign in' : 'Create account'); go.type = 'submit';
      a.appendChild(cancel); a.appendChild(go); form.appendChild(a);
      form.onsubmit = function (e) {
        e.preventDefault();
        var u = form.u.value.trim(), p = form.p.value;
        if (mode === 'register' && p !== form.p2.value) { err.textContent = 'Passwords don’t match.'; return; }
        go.disabled = true; err.textContent = '';
        engine.auth(mode, u, p).then(function () {
          closeModal(); toast('Signed in as ' + engine.user);
          if (!gameFrame) runSync(true);
        }, function (e2) { err.textContent = e2.message; go.disabled = false; });
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
      var go = el('button', 'btn green', 'Change password'); go.type = 'submit';
      a.appendChild(cancel); a.appendChild(go); form.appendChild(a);
      form.onsubmit = function (e) {
        e.preventDefault(); go.disabled = true; err.textContent = '';
        engine.changePassword(form.c.value, form.n.value).then(function () { closeModal(); toast('Password changed'); },
          function (e2) { err.textContent = e2.message; go.disabled = false; });
      };
      box.appendChild(form);
    });
  }

  /* Ask which copy wins. Resolves when the user has picked (or chose "later"). */
  function askConflict(remote) {
    return new Promise(function (done) {
      openModal(function (box) {
        box.appendChild(el('h3', null, 'Your saves don’t match'));
        box.appendChild(el('p', null, 'This site has worlds that aren’t in your cloud saves, and your cloud saves ' +
          (remote && remote.updatedAt ? 'were last updated ' + ago(remote.updatedAt) + ' on another site.' : 'are different.') +
          ' Pick which copy to keep. The other one gets replaced.'));
        var stack = el('div', 'm-stack');
        function pick(choice) {
          closeModal();
          showOverlay(choice === 'cloud' ? 'Downloading cloud saves' : 'Uploading this site’s saves', 'This can take a moment for big worlds…', true);
          engine.resolve(choice).then(function () {
            hideOverlay(); toast(choice === 'cloud' ? 'Cloud saves loaded' : 'Cloud saves updated'); done(true);
          }, function (e) { hideOverlay(); toast('Sync failed: ' + e.message); done(false); });
        }
        stack.appendChild(button('green', 'Use cloud saves', 'Replace this site’s worlds with the ones from your account.', function () { pick('cloud'); }));
        stack.appendChild(button('', 'Keep this site’s saves', 'Upload this site’s worlds and replace your cloud saves.', function () { pick('local'); }));
        stack.appendChild(button('', 'Export this site’s saves first', 'Download a backup file, then choose.', function () { exportSaves(); }));
        box.appendChild(stack);
        var a = el('div', 'm-actions');
        a.appendChild(button('ghost', 'Decide later', null, function () { closeModal(); done(false); }));
        box.appendChild(a);
      });
    });
  }

  /* Full two-way sync (launcher only, never while a game is open). */
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
    }, function (e) {
      toast('Cloud saves unavailable (' + e.message + '). Playing with this site’s saves.');
    });
  }

  /* While a game runs: upload changes every few minutes (never download). */
  function backupNow() {
    if (!engine || !engine.signedIn() || !gameFrame) return;
    engine.sync({ allowPull: false }).catch(function () {});
  }
  function startAutosave() {
    stopAutosave();
    if (engine && engine.signedIn()) autosaveTimer = setInterval(backupNow, 3 * 60 * 1000);
  }
  function stopAutosave() { if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') backupNow(); });

  /* Backup files */
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
    if (gameFrame) { toast('Return to the launcher first'); return; }
    if (!confirm('Replace this site’s worlds with "' + file.name + '"?')) return;
    showOverlay('Importing saves', file.name, true);
    file.arrayBuffer().then(function (b) { return EaglerSync.restore(new Uint8Array(b), KNOWN_DBS); }).then(function () {
      hideOverlay(); toast('Saves imported');
      backgroundSync();
    }, function (e) { showError('Import failed', e.message); });
  }

  /* ---------- wire up ---------- */
  document.title = settings.title;
  $('#terrain').outerHTML = terrainSVG(1337, 96, 40).replace('<svg ', '<svg id="terrain" ');

  $$('[data-view]').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
  $('#playBtn').onclick = function () { launch(byId(selectedId)); };
  $('#vselBtn').onclick = function (e) {
    e.stopPropagation();
    var open = !$('#vmenu').classList.contains('open');
    $('#vmenu').classList.toggle('open', open); $('#vselBtn').classList.toggle('open', open);
  };
  document.addEventListener('click', function (e) { if (!e.target.closest('.vsel')) closeMenu(); });
  $('#search').oninput = renderInstalls;
  $('#showBeta').onchange = renderInstalls;
  $('#ovBtn').onclick = function () {
    if (ovMode === 'cancel' && currentAbort) currentAbort.abort();
    hideOverlay();
  };
  $('#openLocal').onclick = function () { $('#fileIn').click(); };
  $('#fileIn').onchange = function () { var f = this.files[0]; this.value = ''; if (f) launchLocalFile(f); };
  $('#backBtn').onclick = function () { closeGame(false); };
  $('#setMode').onchange = function () { settings.mode = this.value; store.set('mode', settings.mode); toast('Saved'); };
  $('#setTitle').onchange = function () {
    settings.title = this.value.trim() || 'Eaglercraft Launcher'; store.set('title', settings.title);
    if (!gameFrame) document.title = settings.title; toast('Saved');
  };
  $('#clearCache').onclick = function () {
    if (!confirm('Delete all downloaded versions? Your worlds and settings are not affected.')) return;
    (window.caches ? caches.delete(CACHE_NAME) : Promise.resolve()).then(function () { cachedIds = {}; renderAll(); toast('Downloads cleared'); });
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMenu(); closeModal(); }
    if (!gameFrame && e.key === 'Enter' && document.activeElement === document.body && !$('#overlay').classList.contains('open') && !$('#modal').classList.contains('open')) launch(byId(selectedId));
  });
  // Peek the "◀ Launcher" tab when the mouse touches the top edge (pointer must be unlocked: press Esc in-game).
  document.addEventListener('mousemove', function (e) { $('#backBtn').classList.toggle('peek', e.clientY < 8); });

  $('#profileBtn').onclick = openAccount;
  $('#modal').addEventListener('mousedown', function (e) { if (e.target.id === 'modal') closeModal(); });
  $('#setServer').onchange = function () {
    var v = this.value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//.test(v)) { toast('The address must start with https://'); return; }
    if (engine && engine.signedIn()) engine.forget();
    settings.server = v; store.set('syncServer', v); makeEngine(); toast('Saved');
  };
  $('#exportSaves').onclick = exportSaves;
  $('#importSaves').onclick = function () { $('#saveIn').click(); };
  $('#saveIn').onchange = function () { var f = this.files[0]; this.value = ''; if (f) importSaves(f); };

  makeEngine();
  renderAll();
  refreshCacheState();
  backgroundSync();
})();

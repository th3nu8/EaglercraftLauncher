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
    debug: store.get('debugGames', 'off'),
    title: store.get('title', 'Panes'),
    server: store.get('syncServer', '')
  };
  // old server address saved in Settings -> fall back to the repo's current one
  if (/134\.195\.88\.52|195\.62\.47\.222|mistserver\.ftp\.sh/.test(settings.server)) { settings.server = ''; store.set('syncServer', ''); }
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
  var gameFrame = null, gameUrl = null, gameWin = null;
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
      return (g.mistLeaderboards ? ptTokenReady() : Promise.resolve()).then(function () { return html; });
    }).then(function (html) {
      showOverlay('Launching ' + v.name, '', false); setOverlay(null, null, false, 100);
      setTimeout(function () { hideOverlay(); renderAll(); startGame(html, v.name, g); }, 120);
    }).catch(function (e) {
      if (e && (e.name === 'AbortError' || e.message === 'busy')) { hideOverlay(); return; }
      if (!$('#overlay').classList.contains('open') || ovMode === 'cancel') showError('Couldn’t launch ' + v.name, e.message || String(e));
    });
  }

  var runningGame = null;
  /* Games run under about:blank, where window.origin (the real site) differs from location.origin ("null").
   * Engines like PixiJS then mark every image "crossOrigin=anonymous", including the in-memory blob:/data:
   * images that packed games unzip into. Chrome allows that, but Safari (every iPad/iPhone browser) refuses
   * those images, so the game sits on its loading spinner. This shim drops crossOrigin for blob:/data: images. */
  var GAME_SHIM = '<script>(function(){try{var P=HTMLImageElement.prototype,co=Object.getOwnPropertyDescriptor(P,"crossOrigin"),sr=Object.getOwnPropertyDescriptor(P,"src");' +
    'var mem=function(u){return /^(blob|data):/i.test(String(u||""))};' +
    'Object.defineProperty(P,"crossOrigin",{configurable:true,enumerable:true,get:function(){return co.get.call(this)},set:function(v){this.__mistCO=v;if(mem(this.getAttribute("src")))return;co.set.call(this,v)}});' +
    'Object.defineProperty(P,"src",{configurable:true,enumerable:true,get:function(){return sr.get.call(this)},set:function(v){if(mem(v)){if(this.hasAttribute("crossorigin"))this.removeAttribute("crossorigin")}else if(this.__mistCO!=null&&!this.hasAttribute("crossorigin"))co.set.call(this,this.__mistCO);sr.set.call(this,v)}});' +
    '}catch(e){}' +
    /* Offline copies strip "get the app" store links, but some games (YoHoHo.io) hide them on mobile without
     * checking they exist and crash during startup. Hand back a detached stand-in for those ids only. */
    'try{var gi=Document.prototype.getElementById;Document.prototype.getElementById=function(id){var el=gi.call(this,id);if(!el&&/^app-link-/i.test(String(id))){el=this.createElement("div");el.id=id}return el}}catch(e){}' +
    '})();<\/script>';
  /* PolyTrack: send its online leaderboard requests (vps.kodub.com/v6/...) to the Panes server, so the in-game
   * leaderboards list Mist players only. MIST_PT is a PolyTrack-only token, not the player's Mist sign-in.
   * Track of the Week and multiplayer still use the official servers. */
  var PT_SHIM = '<script>(function(){var S=window.MIST_SERVER;if(!S)return;S=String(S).replace(/\\/+$/,"");var T=window.MIST_PT||"",B="https://vps.kodub.com/v6/",K=/^(leaderboard|leaderboardUserEntry|recordings|user|verifyRecordings)(\\?|$)/;' +
    'function m(u){u=String(u);if(u.indexOf(B)!==0)return u;var r=u.slice(B.length);if(!K.test(r))return u;return S+"/pt/v6/"+r+(r.indexOf("?")<0?"?":"&")+"mist="+encodeURIComponent(T)}' +
    /* Offline packs (like the one PolyTrack comes from) replace open/fetch later to block kodub.com. Keep our
     * redirect first by trapping later assignments; the busy flag lets their wrapper reach the real function. */
    'function t(O,k,x){var n=O[k],w=function(){if(w.b)return n.apply(this,arguments);var a=[].slice.call(arguments);a[x]=typeof a[x]==="string"?m(a[x]):a[x];w.b=1;try{return w.i.apply(this,a)}finally{w.b=0}};w.i=n;' +
    'try{Object.defineProperty(O,k,{configurable:true,get:function(){return w},set:function(v){w.i=v}})}catch(e){O[k]=w}}' +
    'try{t(XMLHttpRequest.prototype,"open",1)}catch(e){}try{if(window.fetch)t(window,"fetch",0)}catch(e){}})();<\/script>';
  /* Optional on-screen debug log for games (Settings > Debug games). Lists errors and each file the game
   * requests (images, XHR, fetch, scripts) with its state, so a stalled load shows up in a screenshot. */
  var DEBUG_SHIM = '<script>(function(){var box,list=[],pend={},n=0;' +
    'function ui(){if(box||!document.body)return;box=document.createElement("div");box.style.cssText="position:fixed;left:0;right:0;bottom:0;max-height:38%;overflow:auto;z-index:2147483647;background:rgba(0,0,0,.85);color:#9f9;font:11px/1.35 monospace;padding:4px 6px;white-space:pre-wrap;word-break:break-all";document.body.appendChild(box);draw()}' +
    'function draw(){if(!box)return;var p=Object.keys(pend).map(function(k){return "⏳ WAITING "+pend[k]});box.textContent=["[Mist debug] "+navigator.userAgent.slice(0,80)].concat(p,list.slice(-40)).join("\\n")}' +
    'function log(t){list.push(t);ui();draw()}' +
    'function short(u){u=String(u||"");return u.length>90?u.slice(0,60)+"…"+u.slice(-25):u}' +
    'function track(kind,u){var id=++n;pend[id]=kind+" "+short(u);draw();return function(ok,info){delete pend[id];log((ok?"✔ ":"✖ ")+kind+" "+short(u)+(info?" ("+info+")":""))}}' +
    'window.addEventListener("error",function(e){if(e.target&&e.target!==window&&(e.target.src||e.target.href))log("✖ load failed "+e.target.tagName+" "+short(e.target.src||e.target.href));else log("✖ ERROR "+(e.message||e)+" @"+(e.filename||"").split("/").pop()+":"+e.lineno)},true);' +
    'window.addEventListener("unhandledrejection",function(e){log("✖ REJECTED "+(e.reason&&(e.reason.message||e.reason)))});' +
    'var ce=console.error;console.error=function(){try{log("✖ console.error "+[].map.call(arguments,function(a){return a&&a.message||String(a)}).join(" ").slice(0,200))}catch(x){}return ce.apply(console,arguments)};' +
    'var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return XO.apply(this,arguments)};' +
    'XMLHttpRequest.prototype.send=function(){var x=this,done=track("XHR",x.__u);x.addEventListener("loadend",function(){done(x.status>=200&&x.status<400||x.status===0&&!!x.response,"status "+x.status+", type "+x.responseType)});return XS.apply(this,arguments)};' +
    'var F=window.fetch;if(F)window.fetch=function(r){var d=track("fetch",r&&r.url||r);return F.apply(this,arguments).then(function(res){d(res.ok,"status "+res.status);return res},function(e){d(false,e&&e.message);throw e})};' +
    'var P=HTMLImageElement.prototype,sd=Object.getOwnPropertyDescriptor(P,"src");Object.defineProperty(P,"src",{configurable:true,enumerable:true,get:function(){return sd.get.call(this)},set:function(v){var im=this;if(v&&!im.__mt&&!/^data:/i.test(v)){im.__mt=1;var d=track("img",v);im.addEventListener("load",function(){d(true,im.naturalWidth+"x"+im.naturalHeight)});im.addEventListener("error",function(){d(false,"crossOrigin="+im.crossOrigin)})}sd.set.call(this,v)}});' +
    'document.addEventListener("DOMContentLoaded",ui);log("debug on")})();<\/script>';
  /* Fixes for bugs inside particular games, applied as they load: [find, replace] pairs. Packed games that unzip
     themselves and document.write() the real page are patched on the way through as well. */
  var GAME_PATCHES = {
    // Basketball Stars wipes the Hard/Normal choice when a tournament starts (resetAll), so Hard tournaments were
    // played and saved as Normal - and the game's "win on Hard" cups could never be earned.
    'basketball-stars': [['n.prototype.createNewTournament=function(A){this.resetAll(),this.team=A.teams[0]',
      'n.prototype.createNewTournament=function(A){var __pd=this.difficulty;this.resetAll(),this.difficulty=__pd,this.team=A.teams[0]']]
  };
  function patchShim(list) {
    return '<script>(function(P){function fix(s){if(typeof s!=="string"||s.length<2000)return s;P.forEach(function(p){if(s.indexOf(p[0])>=0)s=s.split(p[0]).join(p[1]);});return s;}' +
      'var d=document,w=d.write;d.write=function(){var a=[].slice.call(arguments).map(fix);return w.apply(d,a);};})(' + JSON.stringify(list).replace(/</g, '\\u003c') + ');<\/script>';
  }
  function withShim(html, g) {
    var patches = g && GAME_PATCHES[g.id];
    if (patches) patches.forEach(function (p) { if (html.indexOf(p[0]) >= 0) html = html.split(p[0]).join(p[1]); });
    var m = /<head(\s[^>]*)?>/i.exec(html) || /^\s*<!doctype[^>]*>/i.exec(html);   // keep <!DOCTYPE> first (no quirks mode)
    var srv = settings.server || defaultServer() || '';
    var mist = { MIST_SERVER: srv };
    if (g && g.mistLeaderboards) mist.MIST_PT = ptToken || '';
    // Only Mist's own games (mistApi in versions.json) get the player's sign-in, for online play.
    if (g && g.mistApi && engine && engine.signedIn()) { mist.MIST_TOKEN = engine.token; mist.MIST_USER = engine.user; }
    else if (g && g.mistName && engine && engine.signedIn()) mist.MIST_USER = engine.user;   // just the name, e.g. to label the player's car
    var inject = '<script>' + Object.keys(mist).map(function (k) { return 'window.' + k + '=' + JSON.stringify(mist[k]).replace(/</g, '\\u003c') + ';'; }).join('') + '<\/script>' +
      (settings.debug === 'on' ? DEBUG_SHIM : '') + GAME_SHIM + (patches ? patchShim(patches) : '') + (g && g.mistLeaderboards ? PT_SHIM : '') + (clips ? clips.shim() : '');
    if (m) return html.slice(0, m.index + m[0].length) + inject + html.slice(m.index + m[0].length);
    return inject + html;
  }
  function startGame(html, name, g) {
    html = withShim(html, g);
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
    gameFrame.setAttribute('allow', 'fullscreen; pointer-lock; autoplay; gamepad; clipboard-read; clipboard-write; microphone; cross-origin-isolated');
    gameFrame.setAttribute('allowfullscreen', '');
    // On the Mist desktop every game gets its own window (drag, resize, minimise, full screen, close).
    gameWin = shell ? shell.openWindow({
      app: 'game:' + (g ? g.id : 'local'), title: name, cls: 'win-game', width: 1280, height: 760, minW: 360, minH: 240, signOutWarn: true,
      maximized: !((shell.prefs() || {}).windows || {})['game:' + (g ? g.id : 'local')],   // first launch: as big as the screen allows
      iconEl: function () { var b = el('span', 'sh-ico sh-gico'); b.style.width = b.style.height = '24px'; if (g) artInto(b, g, 'icon'); else b.textContent = '🎮'; return b; },
      onClose: function () { closeGame(false); return false; },
      onFocus: function () { setTimeout(function () { try { gameFrame && gameFrame.focus(); } catch (e) {} }, 0); }
    }) : null;
    (gameWin ? gameWin.body : document.body).appendChild(gameFrame);
    if (gameWin) setupGameWindow(gameWin, g);
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
    afkStart();
    if (social && g) social.maybeAskSupport();
    gameStart = Date.now();
    hookOverlayKeys();
    if (clips) clips.start(gameFrame.contentWindow, g ? g.name : name);
    var b = $('#mistBtn'); b.classList.add('peek'); setTimeout(function () { b.classList.remove('peek'); }, 3000);
  }
  // A game's window: the Mist overlay button, and automatic fitting. Games were made for a whole
  // browser tab, and some (Idle Breakout) are a fixed size, so a smaller window would cut them off.
  // Mist measures what the game actually draws and, only if it doesn't fit, scales the game down
  // just enough to show all of it. Games that resize themselves stay sharp at 1:1.
  function setupGameWindow(w, g) {
    var mb = el('button', 'win-gbtn win-mistbtn'); mb.setAttribute('data-nodrag', ''); mb.title = 'Mist overlay: friends, achievements, screenshots (Shift+Tab)';
    mb.appendChild(el('span', 'brand-ico')); mb.appendChild(el('span', null, 'Mist')); mb.onclick = function (e) { e.stopPropagation(); toggleMistOverlay(); };
    w.tbExtra.appendChild(mb);
    w.body.appendChild($('#mistOv')); w.body.appendChild($('#mistBtn'));   // the overlay covers just this window
    var frame = gameFrame, scale = 1, shrinks = 0, settle = null, ticks = 0, timer = null, pending = null;
    function alive() { return gameFrame === frame && gameWin === w; }
    function apply() {
      var bw = w.body.clientWidth, bh = w.body.clientHeight;
      frame.style.width = Math.round(bw / scale) + 'px'; frame.style.height = Math.round(bh / scale) + 'px';
      frame.style.transform = scale < 0.999 ? 'scale(' + scale + ')' : '';
    }
    // how much room the game needs: anything big it draws (canvas, Flash, video, inner frames), plus
    // the page itself when it's only a little too big. A long page (instructions under the game)
    // just scrolls, as it would in a tab, instead of being shrunk to nothing.
    function need() {
      var d; try { d = frame.contentDocument; } catch (e) { return null; }
      if (!d || !d.documentElement) return null;
      var de = d.documentElement, bd = d.body, cw = frame.contentWindow, vw = cw.innerWidth, vh = cw.innerHeight;   // (clientHeight lies on pages with no doctype)
      var dw = Math.max(de.scrollWidth, bd ? bd.scrollWidth : 0), dh = Math.max(de.scrollHeight, bd ? bd.scrollHeight : 0), ww = 0, hh = 0;
      var els = d.querySelectorAll('canvas,iframe,embed,object,video,ruffle-player,ruffle-embed');
      for (var i = 0; i < els.length && i < 40; i++) {
        var r = els[i].getBoundingClientRect(); if (r.width < 80 || r.height < 80) continue;
        ww = Math.max(ww, r.width <= vw ? r.right + d.defaultView.scrollX : r.width, r.right + Math.max(0, -r.left));   // centred and cut off on both sides counts too
        hh = Math.max(hh, r.height <= vh ? r.bottom + d.defaultView.scrollY : r.height, r.bottom + Math.max(0, -r.top));
      }
      if (Math.min(vw / dw, vh / dh) >= 0.8) { ww = Math.max(ww, dw); hh = Math.max(hh, dh); }
      return { w: ww, h: hh, vw: vw, vh: vh };
    }
    function fit(fresh) {
      if (!alive()) return;
      var bw = w.body.clientWidth, bh = w.body.clientHeight; if (!bw || !bh) return;
      if (fresh) { scale = 1; shrinks = 0; pending = null; }
      apply();
      var n = need(); if (!n || !n.vw) return;
      var slack = 12;                                  // ignore margins and scrollbars
      var over = n.w > n.vw + slack || n.h > n.vh + slack;
      if (pending && (n.vw > pending.vw + 20 || n.vh > pending.vh + 20)) {
        // we gave the game more room last time: if what it needs grew just as much, the page simply
        // follows the window size (e.g. 100vh plus a margin) and scaling can never help, so undo
        var p = pending; pending = null;
        if (over && ((n.w - p.w) > 0.7 * (n.vw - p.vw) && n.vw - p.vw > 20 || (n.h - p.h) > 0.7 * (n.vh - p.vh) && n.vh - p.vh > 20)) { scale = 1; shrinks = 4; apply(); return; }
      }
      if (!over) return;
      if (shrinks >= 4) return;                       // the page grows with the window (e.g. 100vh + margin): stop chasing it
      var ns = Math.max(0.3, Math.min(scale, scale * n.vw / n.w, scale * n.vh / n.h));
      if (ns > scale - 0.004) return;
      pending = n; scale = ns; shrinks++; apply();
    }
    function tick() { if (!alive()) return; fit(false); ticks++; timer = setTimeout(tick, ticks < 15 ? 1000 : 4000); }
    function resized() { if (!alive()) return; apply(); clearTimeout(settle); settle = setTimeout(function () { fit(true); }, 180); }
    if (window.ResizeObserver) { w._ro = new ResizeObserver(resized); w._ro.observe(w.body); }
    window.addEventListener('resize', resized);
    frame.addEventListener('load', function () { fit(true); });
    apply(); timer = setTimeout(tick, 300);
  }

  /* ---------- AFK check ----------
     Playtime (and the achievements that come from it) only counts while someone is there.
     - No keyboard, mouse, touch or controller input in the game for 10 minutes: "Are you still there?",
       and playtime pauses until they touch something.
     - Every 2 hours of play, a "Still playing?" check that needs a click, so auto-clickers and mouse
       jigglers can't run overnight; no click within 5 minutes and playtime pauses.
     - Games whose controls are inside a frame Panes can't see into get the click check every 45 minutes instead. */
  var AFK_IDLE = 10 * 60e3, AFK_EVERY = 2 * 3600e3, AFK_EVERY_BLIND = 45 * 60e3, AFK_GRACE = 5 * 60e3;
  var afk = { last: 0, on: false, why: '', timer: null, checkAt: 0, checkShown: 0, checkEl: null, ovEl: null, pads: '', blind: false };
  function afkInput() { afk.last = Date.now(); if (afk.on && afk.why === 'idle') afkSet(false); }
  function afkHook(w) {
    try {
      if (!w || w.__panesAfk) return; w.__panesAfk = 1;
      ['keydown', 'pointerdown', 'pointermove', 'mousedown', 'mousemove', 'wheel', 'touchstart'].forEach(function (t) { w.addEventListener(t, afkInput, { capture: true, passive: true }); });
    } catch (e) {}
  }
  function afkBlind() {   // is the player's focus in a frame we can't read input from?
    try {
      var a = gameFrame.contentDocument.activeElement;
      while (a && a.tagName === 'IFRAME') { var cd = null; try { cd = a.contentDocument; } catch (e) {} if (!cd) return true; afkHook(a.contentWindow); a = cd.activeElement; }
    } catch (e) {}
    return false;
  }
  function afkPads() {
    try {
      var s = '', ps = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var i = 0; i < ps.length; i++) if (ps[i]) {
        ps[i].buttons.forEach(function (b) { s += b.pressed ? 1 : 0; });
        ps[i].axes.forEach(function (x) { s += Math.round(x * 4); });
      }
      if (s !== afk.pads) { var first = afk.pads === ''; afk.pads = s; if (!first) afkInput(); }
    } catch (e) {}
  }
  function afkHost() { return gameWin ? gameWin.body : document.body; }
  function afkClearUi() { if (afk.checkEl) { afk.checkEl.remove(); afk.checkEl = null; } if (afk.ovEl) { afk.ovEl.remove(); afk.ovEl = null; } }
  function afkSet(on, why) {
    var now = Date.now();
    afk.on = on; afk.why = on ? why : ''; afkClearUi();
    if (social) social.setAfk(on);
    if (on) {
      var ov = el('div', 'afk-ov'), box = el('div', 'afk-box');
      box.appendChild(el('div', 'afk-z', '💤'));
      box.appendChild(el('b', null, 'Are you still there?'));
      box.appendChild(el('p', null, why === 'idle' ? 'No one has touched the game for a while, so playtime and playtime achievements are paused. Move the mouse or press a key to carry on.'
        : 'Playtime and playtime achievements are paused until you confirm you’re still playing.'));
      var b = el('button', 'btn green', 'I’m back'); b.onclick = function () { afk.last = Date.now(); afkSet(false); try { gameFrame && gameFrame.focus(); } catch (e) {} };
      box.appendChild(b); ov.appendChild(box); afkHost().appendChild(ov); afk.ovEl = ov;
      toast('💤 AFK: playtime paused');
    } else {
      afk.last = now; afk.checkAt = now + (afk.blind ? AFK_EVERY_BLIND : AFK_EVERY);
    }
  }
  function afkCheckin() {
    var c = el('div', 'afk-check'), t = el('span'), b = el('button', 'btn green', 'I’m here');
    c.appendChild(el('b', null, 'Still playing?')); c.appendChild(t); c.appendChild(b);
    afk.checkShown = Date.now(); afk.checkEl = c; afkHost().appendChild(c);
    function tick() { if (afk.checkEl !== c) return; var left = Math.max(0, AFK_GRACE - (Date.now() - afk.checkShown)); t.textContent = 'Playtime pauses in ' + Math.floor(left / 60e3) + ':' + ('0' + Math.floor(left / 1000) % 60).slice(-2) + ' unless you click.'; setTimeout(tick, 1000); }
    tick();
    // the button moves to a random spot so it takes a real click
    var room = Math.max(0, afkHost().clientWidth - c.offsetWidth - 24); c.style.left = Math.round(12 + Math.random() * room) + 'px';
    b.onclick = function () { afk.checkEl = null; c.remove(); afk.last = Date.now(); afk.checkAt = Date.now() + (afk.blind ? AFK_EVERY_BLIND : AFK_EVERY); try { gameFrame && gameFrame.focus(); } catch (e) {} };
  }
  function afkTick() {
    if (!gameFrame) return;
    afkHook(window); try { afkHook(gameFrame.contentWindow); } catch (e) {}
    afkPads();
    var now = Date.now(), blind = afkBlind();
    if (blind && !afk.blind) afk.checkAt = Math.min(afk.checkAt, now + AFK_EVERY_BLIND);
    afk.blind = blind;
    if (afk.on) return;
    if (!blind && now - afk.last > AFK_IDLE) afkSet(true, 'idle');
    else if (afk.checkEl && now - afk.checkShown > AFK_GRACE) afkSet(true, 'check');
    else if (!afk.checkEl && now >= afk.checkAt) afkCheckin();
  }
  function afkStart() {
    afkStop();
    afk.last = Date.now(); afk.checkAt = afk.last + AFK_EVERY; afk.pads = ''; afk.blind = false;
    afk.timer = setInterval(afkTick, 5000);
  }
  function afkStop() { clearInterval(afk.timer); afk.timer = null; afkClearUi(); if (afk.on && social) social.setAfk(false); afk.on = false; }

  function closeGame(silent) {
    if (!gameFrame) return;
    if (!silent && !confirm((shell ? 'Close ' + (runningGame ? runningGame.name : 'the game') + '?' : 'Return to the library?') + ' Unsaved progress in the running game will be lost.')) return;
    var hadSaves = !runningGame || runningGame.cloudSaves;
    stopHooks();
    afkStop();
    if (clips) clips.stop();
    closeMistOverlay(true);
    if (gameWin) { document.body.appendChild($('#mistOv')); document.body.appendChild($('#mistBtn')); if (gameWin._ro) gameWin._ro.disconnect(); }
    gameFrame.remove(); gameFrame = null; runningGame = null;
    if (gameWin) { var gw = gameWin; gameWin = null; gw.close(true); }
    if (social) social.setPlaying(null);
    if (gameUrl) { URL.revokeObjectURL(gameUrl); gameUrl = null; }
    document.body.classList.remove('in-game');
    document.title = settings.title;
    stopAutosave();
    if (!silent && hadSaves && engine && engine.signedIn()) setTimeout(backgroundSync, 600);
    renderAll();
  }
  /* ---------- Mist overlay: opened from the Mist tab (or Shift+Tab) while a game runs ---------- */
  var gameStart = 0, ovTimer = null;
  function sessionText() {
    var s = Math.floor((Date.now() - gameStart) / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : (s % 60) + 's';
  }
  function mistOverlayOpen() { return $('#mistOv').classList.contains('open'); }
  function toggleMistOverlay() { if (mistOverlayOpen()) closeMistOverlay(); else openMistOverlay(); }
  function closeMistOverlay(quiet) {
    var ov = $('#mistOv'); if (!ov.classList.contains('open')) return;
    ov.classList.remove('open'); ov.textContent = ''; clearInterval(ovTimer);
    $('#friendsPanel').classList.remove('over-ov'); $('#chatWin').classList.remove('over-ov');
    if (social) social.closeChat();
    if (!quiet) setTimeout(function () { try { gameFrame && gameFrame.focus(); } catch (e) {} }, 30);
  }
  function openMistOverlay() {
    if (!gameFrame) return;
    var g = runningGame, name = g ? g.name : document.title.split(' · ')[0];
    var ov = $('#mistOv'); ov.textContent = ''; ov.classList.add('open');
    $('#chatWin').classList.add('over-ov');
    ov.onmousedown = function (e) { if (e.target === ov) closeMistOverlay(); };
    /* top bar */
    var bar = el('div', 'mo-bar');
    var br = el('div', 'mo-brand'); br.appendChild(el('span', 'brand-ico')); br.appendChild(el('b', null, 'MIST')); bar.appendChild(br);
    var gi = el('div', 'mo-game');
    if (g) { var art = el('div', 'mo-art'); artInto(art, g, 'icon'); gi.appendChild(art); }
    var gt = el('div', 'fp-t'); gt.appendChild(el('b', null, name));
    var sess = el('small', null, 'Playing for ' + sessionText()); gt.appendChild(sess); gi.appendChild(gt); bar.appendChild(gi);
    var clock = el('div', 'mo-clock');
    function tick() { sess.textContent = 'Playing for ' + sessionText(); clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    tick(); clearInterval(ovTimer); ovTimer = setInterval(tick, 1000);
    bar.appendChild(clock);
    var x = el('button', 'mo-x', '✕'); x.title = 'Back to game (Shift+Tab)'; x.onclick = function () { closeMistOverlay(); }; bar.appendChild(x);
    ov.appendChild(bar);
    /* body */
    var body = el('div', 'mo-body');
    var left = el('div', 'mo-col mo-left');
    var meBox = el('div', 'mo-card'); left.appendChild(meBox);
    var acts = el('div', 'mo-card mo-acts');
    acts.appendChild(el('h5', null, 'Game'));
    var resume = el('button', 'btn green', '▶ Resume'); resume.onclick = function () { closeMistOverlay(); }; acts.appendChild(resume);
    var fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    if (fsOk) {
      var fsb = el('button', 'btn', (document.fullscreenElement || document.webkitFullscreenElement) ? '⤢ Exit fullscreen' : '⤢ Fullscreen');
      fsb.onclick = function () {
        var d = document, inFs = d.fullscreenElement || d.webkitFullscreenElement;
        try {
          if (inFs) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
          else if (gameWin) gameWin.fullscreen();   // just the game's window, not the whole desktop
          else { var r = d.documentElement; (r.requestFullscreen || r.webkitRequestFullscreen).call(r); }
        } catch (e) { toast('Fullscreen isn’t available here'); }
        closeMistOverlay();
      };
      acts.appendChild(fsb);
    }
    if (clips && clips.supported()) {
      var cb = el('button', 'btn', clips.enabled() ? '🎬 Save clip (' + clips.key + ')' : '🎬 Clips are off');
      cb.onclick = function () { if (!clips.enabled()) { toast('Turn on Instant replay in Settings, then restart the game.'); return; } closeMistOverlay(); setTimeout(clips.save, 80); };
      acts.appendChild(cb);
    }
    var rl = el('button', 'btn', '↻ Restart game'); rl.onclick = function () {
      if (!confirm('Restart ' + name + '? Unsaved progress since the last save will be lost.')) return;
      closeMistOverlay(true); var gg = runningGame; closeGame(true); if (gg) play(gg, selVersion(gg));
    };
    if (g) acts.appendChild(rl);
    if (g) { var sp = el('button', 'btn', 'ⓘ Store page'); sp.onclick = function () { if (!confirm('Leave ' + name + ' and open its store page?')) return; closeMistOverlay(true); closeGame(true); go('game', g); }; acts.appendChild(sp); }
    var lib = el('button', 'btn ghost', gameWin ? '✕ Close game' : '◀ Quit to library'); lib.onclick = function () { closeMistOverlay(true); closeGame(false); }; acts.appendChild(lib);
    left.appendChild(acts);
    var notes = el('div', 'mo-card');
    notes.appendChild(el('h5', null, 'Notes'));
    var ta = el('textarea', 'mo-notes'); ta.placeholder = 'Codes, seeds, where you left off… (saved on this device)';
    var nkey = 'notes:' + (g ? g.id : name);
    ta.value = store.get(nkey, '');
    ta.oninput = function () { store.set(nkey, ta.value); };
    notes.appendChild(ta); left.appendChild(notes);
    body.appendChild(left);
    var mid = el('div', 'mo-col mo-mid'); var achBox = el('div', 'mo-card gp-ach'); mid.appendChild(achBox); body.appendChild(mid);
    var right = el('div', 'mo-col mo-right'); var frBox = el('div', 'mo-card mo-friends'); right.appendChild(frBox); body.appendChild(right);
    ov.appendChild(body);
    ov.appendChild(el('div', 'mo-foot', 'Shift+Tab or the Mist tab opens and closes this overlay. The game keeps running behind it.'));
    if (social) {
      social.overlayMe(meBox);
      social.overlayFriends(frBox, name);
      if (g) social.renderGameAch(achBox, g.name); else achBox.appendChild(el('div', 'fp-empty', 'Achievements are tracked for games from the store.'));
    } else { meBox.appendChild(el('p', 'mo-note', 'Social features aren’t loaded.')); }
  }
  function hookOverlayKeys() {
    function onKey(e) { if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); toggleMistOverlay(); } }
    try { gameFrame.contentWindow.addEventListener('keydown', onKey, true); } catch (e) {}
    if (!hookOverlayKeys.top) { hookOverlayKeys.top = true; document.addEventListener('keydown', function (e) { if (gameFrame) onKey(e); }, true); }
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
    if (page === 'social' && game) view.socialTab = game;
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
    else if (view.page === 'social') { if (social) social.renderSocial(view.socialTab || 'friends'); }
    else if (view.page === 'leaderboard') { if (social) social.renderLeaderboard(); }
    else if (view.page === 'profile') { if (social) social.renderProfile(view.profileName); }
    else if (view.page === 'achievements') { if (social) social.renderAchPage(); }
    else if (view.page === 'pc') { if (pcConnect) pcConnect.render($('#pcPage')); }
  }
  function renderAll() { renderPage(); renderDownloads(); renderAccount(); if (shell) shell.refreshDesktop(); }

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
    $('#setDebug').value = settings.debug;
    $('#setClips').value = store.get('clips', 'off') === 'on' ? 'on' : 'off';
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
      stack.appendChild(button('', 'Friends, forums & chat', null, function () { closeModal(); go('social', 'friends'); }));
      stack.appendChild(button('', '💛 Support Mist', '$5/month: gold outline, extra avatars, +2,500 XP', function () { closeModal(); social.openSupport(); }));
      stack.appendChild(button('', 'Sync now', null, function () { if (gameFrame) { toast('Return to the library first'); return; } closeModal(); runSync(true); }));
      stack.appendChild(button('', 'Change password', null, openChangePassword));
      stack.appendChild(button('', 'Sign out', 'Worlds already on this site stay here.', function () { engine.signOut().then(function () { closeModal(); toast('Signed out'); }); }));
      box.appendChild(stack);
      engine.api('GET', '/api/me').then(function (d) {
        if (d && d.admin && document.body.contains(stack)) stack.insertBefore(button('', '🛡 Admin dashboard', 'Announcements, bans and sign-outs', function () { openAdmin(); }), stack.firstChild);
        if (d && d.announcement) showAnnouncement(d.announcement);
      }, function () {});
      var a = el('div', 'm-actions'); a.appendChild(button('ghost', 'Close', null, closeModal)); box.appendChild(a);
    });
  }
  function openAuth(mode) {
    if (shell) { closeModal(); shell.switchUser(mode); return; }
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
  $('#settingsBtn').onclick = function () { if (shell) { shell.launch('settings', 'games'); return; } go(view.page === 'settings' ? 'library' : 'settings'); };
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
  if (!$('#mistBtn')) { var mb = el('button', 'mist-btn', 'Mist'); mb.id = 'mistBtn'; document.body.appendChild(mb); }
  if (!$('#mistOv')) { var mo = el('div', 'mist-ov'); mo.id = 'mistOv'; document.body.appendChild(mo); }
  $('#mistBtn').onclick = toggleMistOverlay;
  /* Ctrl+W (crouch + forward in shooters) closes the tab. Browsers don't let pages block it, so: ask before
   * leaving while a game runs, and in fullscreen use Keyboard Lock (Chrome/Edge) so Ctrl+W, Ctrl+T etc. go to
   * the game instead of the browser. Holding Esc leaves fullscreen as usual. */
  window.addEventListener('beforeunload', function (e) { if (gameFrame) { e.preventDefault(); e.returnValue = ''; return ''; } });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var kb = navigator.keyboard; if (!kb || !kb.lock) return;
      try { if (document.fullscreenElement || document.webkitFullscreenElement) { var r = kb.lock(); if (r && r.catch) r.catch(function () {}); } else kb.unlock(); } catch (x) {}
    });
  });
  $('#modal').addEventListener('mousedown', function (e) { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('click', function (e) { if (!e.target.closest('#menuPop')) closeMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); if ($('#modal').classList.contains('open')) closeModal(); else if (gameFrame && mistOverlayOpen()) closeMistOverlay(); } });
  document.addEventListener('mousemove', function (e) { $('#mistBtn').classList.toggle('peek', e.clientY < 30); });
  $('#setClips').onchange = function () { store.set('clips', this.value); if (this.value === 'off' && clips) clips.stop(); toast(this.value === 'on' ? 'Instant replay on for the next game you open' : 'Instant replay off'); };
  $('#setDebug').onchange = function () { settings.debug = this.value; store.set('debugGames', settings.debug); toast(this.value === 'on' ? 'Debug panel on for the next game you open' : 'Debug panel off'); };
  $('#setMode').onchange = function () { settings.mode = this.value; store.set('mode', settings.mode); toast('Saved'); };
  $('#setTitle').onchange = function () {
    settings.title = this.value.trim() || 'Panes'; store.set('title', settings.title);
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


  /* ---------- server-wide announcements (shown to everyone, over games too; once per browser) ---------- */
  function showAnnouncement(a) {
    if (!a || !a.id || store.get('annSeen', '') === a.id) return;
    var old = document.getElementById('mistAnn'); if (old) { if (old.dataset.id === a.id) return; old.remove(); }
    var bar = el('div', 'mist-ann'); bar.id = 'mistAnn'; bar.dataset.id = a.id;
    bar.appendChild(el('div', 'mist-ann-ic', '📢'));
    var body = el('div', 'mist-ann-body');
    body.appendChild(el('div', 'mist-ann-h', 'Announcement'));
    body.appendChild(el('div', 'mist-ann-t', a.text));
    body.appendChild(el('div', 'mist-ann-s', (a.by ? 'From ' + a.by + ' · ' : '') + ago(a.at)));
    bar.appendChild(body);
    var x = el('button', 'mist-ann-x', '✕'); x.title = 'Dismiss';
    x.onclick = function () { store.set('annSeen', a.id); bar.remove(); };
    bar.appendChild(x);
    document.body.appendChild(bar);
  }
  function pollAnnouncement() {
    var srv = settings.server || defaultServer(); if (!srv) return;
    fetch(srv.replace(/\/+$/, '') + '/api/announcement', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) {
        var cur = document.getElementById('mistAnn');
        if (!d.announcement) { if (cur) cur.remove(); return; }
        showAnnouncement(d.announcement);
      }).catch(function () {});
  }

  /* ---------- admin dashboard (only for names in the server's admins.json) ---------- */
  function openAdmin() {
    openModal(function (box) {
      box.classList.add('adm-box');
      box.appendChild(el('h3', null, '🛡 Admin dashboard'));
      var body = el('div'); box.appendChild(body);
      body.appendChild(el('p', null, 'Loading…'));
      var acts = el('div', 'm-actions'); acts.appendChild(button('ghost', 'Close', null, closeModal)); box.appendChild(acts);
      function load() {
        engine.api('GET', '/api/admin/overview').then(draw, function (e) { body.textContent = ''; body.appendChild(el('p', 'm-err', e.message)); });
      }
      function draw(d) {
        body.textContent = '';
        body.appendChild(el('p', 'adm-stats', d.accounts + ' accounts · ' + d.online + ' online now'));

        // announcement
        var sec = el('div', 'adm-sec'); sec.appendChild(el('h4', null, 'Server-wide announcement'));
        if (d.announcement) {
          var cur = el('div', 'adm-cur');
          cur.appendChild(el('div', null, d.announcement.text));
          cur.appendChild(el('small', null, 'Sent by ' + d.announcement.by + ' · ' + ago(d.announcement.at)));
          sec.appendChild(cur);
        } else sec.appendChild(el('p', 'adm-muted', 'No announcement showing right now.'));
        var ta = el('textarea', 'adm-ta'); ta.maxLength = 500; ta.placeholder = 'Type a message everyone will see…'; sec.appendChild(ta);
        var row = el('div', 'adm-row');
        var dur = el('select', 'adm-sel');
        [['0', 'Until cleared'], ['1', 'For 1 hour'], ['24', 'For 1 day'], ['168', 'For 1 week']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; dur.appendChild(op); });
        row.appendChild(dur);
        var send = button('green', 'Send to everyone', null, function () {
          var t = ta.value.trim(); if (!t) { toast('Type a message first'); return; }
          send.disabled = true;
          engine.api('POST', '/api/admin/announce', { json: { text: t, hours: +dur.value } }).then(function (r) {
            toast('Announcement sent'); store.set('annSeen', ''); showAnnouncement(r.announcement); load();
          }, function (e) { toast(e.message); send.disabled = false; });
        });
        row.appendChild(send);
        if (d.announcement) row.appendChild(button('ghost', 'Clear', null, function () {
          engine.api('POST', '/api/admin/announce', { json: { clear: true } }).then(function () {
            toast('Announcement cleared'); var b = document.getElementById('mistAnn'); if (b) b.remove(); load();
          }, function (e) { toast(e.message); });
        }));
        sec.appendChild(row); body.appendChild(sec);

        // users
        var us = el('div', 'adm-sec'); us.appendChild(el('h4', null, 'Players'));
        var q = el('input', 'adm-q'); q.placeholder = 'Search players…'; q.spellcheck = false; us.appendChild(q);
        var list = el('div', 'adm-list'); us.appendChild(list);
        function act(name, action, label) {
          if (action === 'ban' && !confirm('Ban ' + name + '? They get signed out everywhere and can’t sign in again until unbanned.')) return;
          engine.api('POST', '/api/admin/user', { json: { name: name, action: action } }).then(function () { toast(label); load(); }, function (e) { toast(e.message); });
        }
        function giveSupport(name) {
          var a = prompt('Give ' + name + ' Mist Supporter for how many days? Leave it empty for no end date.', '30');
          if (a === null) return;
          a = a.trim(); var days = a ? Math.floor(+a) : 0;
          if (a && !(days >= 1 && days <= 3650)) { toast('Enter a number of days from 1 to 3650, or leave it empty'); return; }
          engine.api('POST', '/api/admin/user', { json: { name: name, action: 'support', days: days } })
            .then(function () { toast(name + ' is a Supporter ' + (days ? 'for ' + days + ' day' + (days === 1 ? '' : 's') : 'with no end date')); load(); }, function (e) { toast(e.message); });
        }
        function drawList() {
          list.textContent = '';
          var f = q.value.trim().toLowerCase();
          d.users.filter(function (u) { return !f || u.name.toLowerCase().indexOf(f) >= 0; }).forEach(function (u) {
            var r = el('div', 'adm-user');
            var nm = el('div', 'adm-name');
            nm.appendChild(el('span', 'adm-dot' + (u.online ? ' on' : '')));
            nm.appendChild(el('span', null, u.name));
            if (u.admin) nm.appendChild(el('span', 'adm-tag', 'admin'));
            if (u.banned) nm.appendChild(el('span', 'adm-tag ban', 'banned'));
            if (u.noBrowser) nm.appendChild(el('span', 'adm-tag ban', 'browser off'));
            if (u.supporter) {
              var tag = el('span', 'adm-tag sup', u.gift ? 'supporter (gift)' : 'supporter');
              if (u.gift) tag.title = 'Given by ' + (u.giftBy || 'an admin') + (u.giftUntil ? ', ends ' + new Date(u.giftUntil).toLocaleDateString() : ', no end date');
              nm.appendChild(tag);
            }
            r.appendChild(nm);
            var b = el('div', 'adm-btns');
            if (u.gift) b.appendChild(button('ghost', 'Remove supporter', null, function () {
              if (confirm('Take Mist Supporter away from ' + u.name + '?')) act(u.name, 'unsupport', u.name + ' is no longer a Supporter');
            }));
            else if (!u.banned) b.appendChild(button('ghost', u.supporter ? 'Add gift' : 'Give supporter', null, function () { giveSupport(u.name); }));
            if (!u.admin) {
              if (u.banned) b.appendChild(button('ghost', 'Unban', null, function () { act(u.name, 'unban', u.name + ' unbanned'); }));
              else {
                b.appendChild(button('ghost', u.noBrowser ? 'Browser on' : 'Browser off', null, function () {
                  if (u.noBrowser) act(u.name, 'browser-on', u.name + ' can use the browser again');
                  else if (confirm('Turn the Mist Browser off for ' + u.name + '? Their open browser tabs stop working.')) act(u.name, 'browser-off', 'Browser turned off for ' + u.name);
                }));
                b.appendChild(button('ghost', 'Sign out', null, function () { act(u.name, 'signout', u.name + ' signed out everywhere'); }));
                b.appendChild(button('ghost adm-danger', 'Ban', null, function () { act(u.name, 'ban', u.name + ' banned'); }));
              }
            }
            r.appendChild(b); list.appendChild(r);
          });
          if (!list.firstChild) list.appendChild(el('p', 'adm-muted', 'No players match.'));
        }
        q.oninput = drawList; drawList();
        body.appendChild(us);
      }
      load();
    });
  }

  var social = null, clips = null, browser = null, pcConnect = null, lastUser;
  var shell = null, concord = null, settingsApp = null, mistWin = null;
  function authChanged() {
    var u = engine && engine.signedIn() ? engine.user : null;
    if (u !== lastUser) { lastUser = u; ptToken = null; ptPromise = null; if (social) social.onAuthChange(); if (browser) browser.onAuthChange(); if (pcConnect) pcConnect.onAuthChange(); if (concord) concord.onAuthChange(); if (shell) shell.authChanged(); if (settingsApp) settingsApp.redraw(); pollAnnouncement(); }
  }
  /* PolyTrack-only token for Mist leaderboards (fetched once per sign-in). */
  var ptToken = null, ptPromise = null;
  function ptTokenReady() {
    if (!engine || !engine.signedIn()) return Promise.resolve(null);
    if (ptToken) return Promise.resolve(ptToken);
    if (!ptPromise) ptPromise = engine.api('POST', '/api/polytrack/token').then(function (r) { ptToken = r && r.token || null; return ptToken; }, function () { ptPromise = null; return null; });
    return ptPromise;
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

  /* ---------- the Mist desktop: sign-in screen, windows, taskbar, and the apps on it ---------- */
  function desktopGames(all) {
    if (!library) return [];
    return GAMES.filter(function (g) { return inLibrary(g) && (all || anyInstalled(g)); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (g) {
        return { id: g.id, name: g.name, installed: anyInstalled(g),
          iconInto: function (b) { artInto(b, g, 'icon'); },
          play: function () {
            var v = selVersion(g), inst = g.versions.filter(function (x) { return isInstalled(g, x); });
            if (gameFrame && runningGame === g && gameWin) { gameWin.show(); return; }
            if (gameFrame && !confirm('Close ' + (runningGame ? runningGame.name : 'the running game') + ' and start ' + g.name + '?')) return;
            play(g, v && isInstalled(g, v) ? v : inst[0] || v);
          },
          show: function () { shell.launch('mist'); go('library', g); } };
      });
  }
  var settingsNode = null;
  function startDesktop() {
    settingsNode = $('#page-settings .settings');
    shell = MistShell({
      el: el, toast: toast, ago: ago, getEngine: function () { return engine; },
      storeGet: function (k, d) { return store.get(k, d); }, storeSet: function (k, v) { store.set(k, v); },
      avatar: function (n, s) { return social ? social.avatar(n, s) : el('span', 'sh-guestav', n.charAt(0).toUpperCase()); },
      auth: function (mode, u, p) {
        if (!engine) return Promise.reject(new Error('No Panes server is set up.'));
        return engine.auth(mode, u, p).then(function () { if (!gameFrame) runSync(false); });
      },
      signOut: function () { return engine && engine.signedIn() ? engine.signOut() : null; },
      games: desktopGames,
      showProfile: function (n) { shell.launch('mist'); go('profile', n); },
      onDesktop: function () { if ((shell.prefs() || {}).openMist !== false) shell.launch('mist'); }
    });
    shell.registerApp({ id: 'mist', name: 'Mist',
      open: function (arg) {
        mistWin = shell.openWindow({ app: 'mist', title: 'Mist', cls: 'win-mist', keepAlive: true, width: 1240, height: 780, minW: 560, minH: 400 });
        mistWin.body.appendChild($('#app'));
        renderAll();
        if (arg && arg.page) go(arg.page, arg.game);
        return mistWin;
      },
      reopen: function (w, arg) { if (arg && arg.page) go(arg.page, arg.game); } });
    concord = window.MistConcord ? MistConcord({ el: el, toast: toast, shell: shell, getEngine: function () { return engine; }, social: function () { return social; },
      storeGet: function (k, d) { return store.get(k, d); }, storeSet: function (k, v) { store.set(k, v); },
      showProfile: function (n) { shell.launch('mist'); go('profile', n); } }) : null;
    if (concord) shell.registerApp({ id: 'concord', name: 'Concord', needsAccount: true,
      open: function (arg) { return concord.open(arg); }, reopen: function (w, arg) { if (arg && arg.dm) concord.openDm(arg.dm); } });
    browser = window.MistGleam ? MistGleam({ el: el, toast: toast, shell: shell, getEngine: function () { return engine; } }) : null;
    if (browser) shell.registerApp({ id: 'gleam', name: 'Gleam', needsAccount: true,
      open: function (url) { return browser.open(url); }, reopen: function (w, url) { if (typeof url === 'string') browser.openUrl(url); } });
    settingsApp = window.MistSettings ? MistSettings({ el: el, toast: toast, shell: shell, getEngine: function () { return engine; },
      avatar: function (n, s) { return social ? social.avatar(n, s) : el('span'); },
      editProfile: function () { if (engine && engine.signedIn()) { shell.launch('mist'); go('profile', engine.user); } },
      openSupport: function () { if (social) social.openSupport(); },
      changePassword: openChangePassword, openAdmin: function () { openAdmin(); },
      syncNow: function () { if (gameFrame) { toast('Close the game first'); return; } runSync(true); },
      version: (CFG.base.match(/\/([0-9a-f]{40})\/$/) || [, 'latest'])[1].slice(0, 7),
      gamesPanel: function (host) { host.appendChild(settingsNode); renderSettings(); },
      onGamesClosed: function () { var pg = $('#page-settings'); if (settingsNode && pg && settingsNode.parentNode !== pg) pg.appendChild(settingsNode); }
    }) : null;
    if (settingsApp) shell.registerApp({ id: 'settings', name: 'Settings',
      open: function (pg) { return settingsApp.open(pg); }, reopen: function (w, pg) { if (pg) settingsApp.open(pg); } });
    // the Panes Store and its apps (installed per account; the four above are always there)
    var appStore = window.PanesStore ? PanesStore({ el: el, toast: toast, shell: shell }) : null;
    if (appStore) shell.registerApp({ id: 'store', name: 'Panes Store', open: function (arg) { return appStore.open(arg); }, reopen: function (w, arg) { appStore.reopen(w, arg); } });
    var imitator = window.PanesImitator ? PanesImitator({ el: el, toast: toast, shell: shell, server: function () { return engine ? engine.server : (settings.server || defaultServer()); } }) : null;
    if (imitator) shell.registerApp({ id: 'imitator', name: 'Imitator', optional: true, multi: false, open: function () { return imitator.open(); } });
    if (concord) concord.start();
  }

  makeEngine();
  lastUser = engine && engine.signedIn() ? engine.user : null;
  // Pages that block storage: games can't keep progress and nothing can be synced. Say so once.
  if (window.EaglerSync && EaglerSync.storageBlocked && EaglerSync.storageBlocked()) {
    var nsBar = el('div', 'nostore-bar');
    nsBar.appendChild(el('span', null, '⚠️ This page blocks saved data, so game progress and cloud saves won’t work and you’ll be signed out when you close it. Run the Mist bookmarklet from a normal website (for example wikipedia.org) instead of a new tab or search page.'));
    var nsX = el('button', null, '✕'); nsX.onclick = function () { nsBar.remove(); }; nsBar.appendChild(nsX);
    document.body.appendChild(nsBar);
  }
  clips = window.MistClips ? MistClips({
    el: el, toast: toast, ago: ago, openModal: openModal, closeModal: closeModal, button: button,
    storeGet: function (k, d) { return store.get(k, d); }, storeSet: function (k, v) { store.set(k, v); }
  }) : null;
  social = window.MistSocial ? MistSocial({
    renderClips: function (host) { if (clips) clips.render(host); else host.textContent = 'Clips aren’t loaded.'; },
    getEngine: function () { return engine; }, onLooks: function () { renderAccount(); }, el: el, toast: toast, ago: ago, popMenu: popMenu,
    openModal: openModal, closeModal: closeModal, field: field, button: button, openAccount: openAccount,
    gameByName: gameByName, artInto: artInto, showGame: function (g) { go('game', g); },
    showProfile: function (n) { go('profile', n); },
    showSocial: function (tab) { go('social', tab || 'friends'); },
    storeGet: function (k, d) { return store.get(k, d); }, storeSet: function (k, v) { store.set(k, v); },
    showAchievements: function () { go('achievements'); },
    gameNames: function () { return GAMES.map(function (g) { return g.name; }); },
    openChat: window.MistShell ? function (name) { if (shell) shell.launch('concord', { dm: name }); } : null,
    onData: function () { if (concord) concord.onSocial(); }
  }) : null;
  if (window.MIST_ICONS) { document.documentElement.style.setProperty('--mist-logo', 'url("' + MIST_ICONS.mist + '")'); document.documentElement.classList.add('mist-logo'); }
  if (window.MistShell) startDesktop();
  // MY PC: stream your own PC into Mist (supporters)
  pcConnect = window.MistPC ? MistPC({
    el: el, toast: toast, ago: ago, getEngine: function () { return engine; }, openAuth: openAuth,
    openModal: openModal, closeModal: closeModal, button: button,
    openSupport: function () { if (social) social.openSupport(); }
  }) : null;
  renderAccount();
  pollAnnouncement(); setInterval(pollAnnouncement, 30000);
  if (social) {
    $('#friendsBtn').onclick = function () { go('social', 'friends'); };
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

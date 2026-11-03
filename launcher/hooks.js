/* Mist — game hooks
 * Read progress from specific games while they run in Mist, so they can earn game-specific
 * achievements. Every reader only *reads*: it never changes the game or its saves.
 * poll(win, state) returns (or resolves to) { statName: number } or null if nothing is readable yet.
 * The server keeps the highest value it has seen for each stat and unlocks achievements from them. */
window.MistHooks = (function () {
  'use strict';
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsKeys() { var out = []; try { for (var i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)); } catch (e) {} return out; }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function openDb(name) {
    return new Promise(function (res) {
      var fresh = false, r = indexedDB.open(name);
      r.onupgradeneeded = function () { fresh = true; r.transaction.abort(); };
      r.onsuccess = function () { var db = r.result; db.onversionchange = function () { db.close(); }; setTimeout(function () { try { db.close(); } catch (e) {} }, 3000); res(db); };
      r.onerror = function (e) { e.preventDefault(); res(null); };
    });
  }
  function dbNames() { return indexedDB.databases ? indexedDB.databases().then(function (l) { return l.map(function (d) { return d.name; }); }).catch(function () { return []; }) : Promise.resolve([]); }
  function bytes(v) {
    if (!v) return null;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === 'string') return new TextEncoder().encode(v);
    return null;
  }
  function text(u8) { return new TextDecoder().decode(u8); }
  function inflate(u8, format) {
    return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream(format || 'deflate'))).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /* ---------- Scratch (TurboWarp / scratch-gui / forkphorus) ---------- */
  function scratchVars(win, state) {
    var vm = (win.scaffolding && win.scaffolding.vm) || (win.Scratch && win.Scratch.vm) || win.vm;
    if (vm && vm.runtime && vm.runtime.targets) {
      var stage = null, t = vm.runtime.targets;
      for (var i = 0; i < t.length; i++) if (t[i].isStage) { stage = t[i]; break; }
      if (!stage) return null;
      var o = {};
      Object.keys(stage.variables).forEach(function (id) { var v = stage.variables[id]; o[String(v.name).toLowerCase()] = v.value; });
      return o;
    }
    // forkphorus keeps its stage in a local variable; wrapping the Stage prototype hands it to us on the next frame.
    var P = win.P;
    if (P && P.core && P.core.Stage) {
      if (!state.forkPatched) {
        state.forkPatched = true;
        var proto = P.core.Stage.prototype;
        Object.getOwnPropertyNames(proto).forEach(function (n) {
          if (n === 'constructor' || typeof proto[n] !== 'function') return;
          var orig = proto[n];
          proto[n] = function () { if (!state.forkStage) state.forkStage = this; return orig.apply(this, arguments); };
        });
      }
      if (state.forkStage && state.forkStage.vars) {
        var o2 = {}, vars = state.forkStage.vars;
        Object.keys(vars).forEach(function (k) { o2[k.toLowerCase()] = vars[k]; });
        return o2;
      }
    }
    return null;
  }
  /* FNAF: a night counts when the clock variable reads 6 (6 AM) during that night.
   * Sister Location has no clock, so a night counts when "Night" goes up by exactly one while playing. */
  function fnaf(cfg) {
    return {
      interval: 2000,
      poll: function (win, state) {
        var v = scratchVars(win, state); if (!v) return null;
        var night = Math.round(num(v[cfg.night])), out = {};
        if (cfg.clock) {
          var t = num(v[cfg.clock]);
          if (night >= 1 && night <= 7 && t === 6) out['night' + night] = 1;
        } else {
          if (cfg.skip && cfg.skip(v)) { state.last = undefined; return out; }
          if (state.last !== undefined && state.last >= 1 && night === state.last + 1) out['night' + state.last] = 1;
          state.last = night;
        }
        return out;
      }
    };
  }

  /* ---------- Unity PlayerPrefs (stored in IndexedDB /idbfs) ---------- */
  /* Unity games keep PlayerPrefs in /idbfs/<hash>/PlayerPrefs. Read every such file and merge them. */
  function readPlayerPrefs() {
    return openDb('/idbfs').then(function (db) {
      if (!db || !db.objectStoreNames.contains('FILE_DATA')) { if (db) db.close(); return null; }
      return req(db.transaction('FILE_DATA', 'readonly').objectStore('FILE_DATA').getAllKeys()).then(function (keys) {
        keys = keys.filter(function (k) { return /\/PlayerPrefs$/.test(k); });
        if (!keys.length) { db.close(); return null; }
        return Promise.all(keys.map(function (k) { return req(db.transaction('FILE_DATA', 'readonly').objectStore('FILE_DATA').get(k)); })).then(function (recs) {
          db.close(); var out = {};
          recs.forEach(function (rec) { var p = parsePrefs(bytes(rec && rec.contents)); for (var k in p) out[k] = p[k]; });
          return out;
        });
      }, function () { db.close(); return null; });
    });
  }
  function prefsHook(fn, interval) {
    return { interval: interval || 6000, poll: function () { return readPlayerPrefs().then(function (p) { return p ? fn(p) : null; }).catch(function () { return null; }); } };
  }
  function lsJson(key) { try { return JSON.parse(ls(key) || 'null'); } catch (e) { return null; } }
  function readLocalforage(key) {
    return openDb('localforage').then(function (db) {
      if (!db || !db.objectStoreNames.contains('keyvaluepairs')) { if (db) db.close(); return null; }
      return req(db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get(key)).then(function (v) { db.close(); return v; }, function () { db.close(); return null; });
    });
  }
  function parsePrefs(u8) {
    var out = {}; if (!u8 || text(u8.subarray(0, 8)) !== 'UnityPrf') return out;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), i = 16;
    function len() { var l = u8[i++]; if (l === 0x80) { l = dv.getInt32(i, true); i += 4; } return l; }
    try {
      while (i < u8.length) {
        var kl = len(), key = text(u8.subarray(i, i + kl)); i += kl;
        var type = u8[i++];
        if (type === 0xFD) { out[key] = dv.getFloat32(i, true); i += 4; }
        else if (type === 0xFE) { out[key] = dv.getInt32(i, true); i += 4; }
        else { i--; var sl = len(); out[key] = text(u8.subarray(i, i + sl)); i += sl; }
      }
    } catch (e) {}
    return out;
  }

  /* ---------- Eaglercraft worlds (IndexedDB "…PlatformFilesystem…" / "filesystem") ---------- */
  var ADV = { 'minecraft:story/root': 'mineWood', 'minecraft:story/mine_stone': 'buildPickaxe', 'minecraft:story/upgrade_tools': 'buildBetterPickaxe',
    'minecraft:story/smelt_iron': 'acquireIron', 'minecraft:adventure/kill_a_mob': 'killEnemy', 'minecraft:husbandry/breed_an_animal': 'breedCow',
    'minecraft:story/mine_diamond': 'diamonds', 'minecraft:story/enter_the_nether': 'portal', 'minecraft:nether/return_to_sender': 'ghast',
    'minecraft:nether/obtain_blaze_rod': 'blazeRod', 'minecraft:nether/brew_potion': 'potion', 'minecraft:story/enchant_item': 'enchantments',
    'minecraft:adventure/sniper_duel': 'snipeSkeleton', 'minecraft:story/enter_the_end': 'theEnd', 'minecraft:end/kill_dragon': 'theEnd2' };
  function eaglercraft() {
    return dbNames().then(function (names) {
      names = names.filter(function (n) { return /PlatformFilesystem|eaglercraft.*worlds/i.test(n); });
      var out = {};
      return names.reduce(function (p, name) {
        return p.then(function () {
          return openDb(name).then(function (db) {
            if (!db) return;
            var stores = Array.prototype.slice.call(db.objectStoreNames);
            if (!stores.length) { db.close(); return; }
            var st = db.transaction(stores[0], 'readonly').objectStore(stores[0]);
            return req(st.getAllKeys()).then(function (keys) {
              var want = keys.filter(function (k) { return typeof k === 'string' && /\/(stats|advancements)\/[^/]+\.json$/.test(k); });
              return Promise.all(want.map(function (k) { return req(db.transaction(stores[0], 'readonly').objectStore(stores[0]).get(k)).then(function (rec) { return [k, rec]; }); }));
            }).then(function (recs) {
              db.close();
              recs.forEach(function (kr) {
                var rec = kr[1], data = null;
                if (rec && typeof rec === 'object') { for (var f in rec) { var b = bytes(rec[f]); if (b && f !== 'path') { data = b; break; } } }
                else data = bytes(rec);
                if (!data) return;
                var j; try { j = JSON.parse(text(data)); } catch (e) { return; }
                if (/\/stats\//.test(kr[0])) Object.keys(j).forEach(function (k) { var m = /^achievement\.(.+)$/.exec(k); if (m && num(j[k]) > 0) out[m[1]] = 1; });
                else Object.keys(j).forEach(function (k) { if (ADV[k] && j[k] && j[k].done) out[ADV[k]] = 1; });
              });
            }, function () { db.close(); });
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  /* ---------- Bloons TD 5 (Ruffle SharedObject → zlib → JSON profile) ---------- */
  function btd5() {
    var key = lsKeys().filter(function (k) { return /BTD5/i.test(k); })[0]; if (!key) return Promise.resolve(null);
    var sol; try { sol = atob(ls(key)); } catch (e) { return Promise.resolve(null); }
    var m = /eNq[A-Za-z0-9+/=]+/.exec(sol); if (!m) return Promise.resolve(null);
    var raw = Uint8Array.from(atob(m[0]), function (c) { return c.charCodeAt(0); });
    return inflate(raw, 'deflate').then(function (u8) {
      var t = text(u8), j = JSON.parse(t.slice(t.indexOf('{')));
      var len = function (o) { return o && o.data ? o.data.length : 0; };
      return { xp: num(j.xp), medals: len(j.trackMedals), towers: len(j.towerXP), missions: len(j.missionsCompleted), challenges: len(j.challengesCompleted_v1) };
    }).catch(function () { return null; });
  }

  var HOOKS = {
    'Cookie Clicker': { interval: 3000, poll: function (win) {
      var G = win.Game; if (!G || !G.Objects) return null;
      return { clicks: num(G.cookieClicks), baked: num(G.cookiesEarned) + num(G.cookiesReset), buildings: num(G.BuildingsOwned), cps: num(G.cookiesPs),
        golden: num(G.goldenClicks), achievements: num(G.AchievementsOwned), ascensions: num(G.resets) };
    } },
    'YoHoHo.io': { interval: 5000, poll: function () {
      if (ls('gamesStarted') === null) return null;
      return { gamesStarted: num(ls('gamesStarted')), totalWins: num(ls('totalWins')), totalKills: num(ls('totalKills')), bestKills: num(ls('bestKills')) };
    } },
    'Polytrack': { interval: 5000, poll: function () {
      var keys = lsKeys(), info = {};
      try { info = JSON.parse(ls('polytrack_v5_prod_startup_info') || '{}') || {}; } catch (e) {}
      return { tutorial: info.isTutorialCompleted ? 1 : 0,
        records: keys.filter(function (k) { return k.indexOf('polytrack_v5_prod_record_') === 0; }).length,
        customTracks: keys.filter(function (k) { return k.indexOf('polytrack_v5_prod_track_') === 0; }).length };
    } },
    'Bloons TD 5': { interval: 8000, poll: btd5 },
    /* ---- batch 1 ---- */
    '2048': { interval: 4000, poll: function () {
      var g = lsJson('gameState'), tile = 0;
      if (g && g.grid && g.grid.cells) g.grid.cells.forEach(function (col) { (col || []).forEach(function (c) { if (c && c.value > tile) tile = c.value; }); });
      var best = Math.max(num(ls('bestScore')), g ? num(g.score) : 0);
      if (!g && !best) return null;
      return { tile: tile, best: best };
    } },
    'OvO': { interval: 6000, poll: function () {
      return readLocalforage('DedraOvO').then(function (v) {
        if (typeof v !== 'string') return null;
        var i = v.indexOf('eyJ'); if (i < 0) return null;
        var b64 = v.slice(i).replace(/[^A-Za-z0-9+/]/g, ''), txt = '';
        try { txt = atob(b64.slice(0, b64.length - b64.length % 4)); } catch (e) { return null; }
        var pick = function (k) { var m = new RegExp('"' + k + '":(-?[0-9.]+)').exec(txt); return m ? num(m[1]) : 0; };
        if (!/"Levels":/.test(txt)) return null;
        return { level: pick('Levels'), coins: pick('CollectedCoins'), gold: pick('Gold') };
      }).catch(function () { return null; });
    } },
    'Drift Boss': { interval: 5000, poll: function () {
      var k = lsKeys().filter(function (x) { return /^mjs-drift-boss-game/.test(x); })[0]; if (!k) return null;
      var d = lsJson(k); if (!d) return null;
      return { score: num(d.score), coins: num(d.collectedCoin), cars: (d.cars || []).length };
    } },
    'Temple Run 2': { interval: 5000, poll: function () {
      var d = lsJson('TR2_GAME_STATE'); if (!d || !d.statsData) return null; var s = d.statsData;
      return { score: num(s.highestScore), run: num(s.longestRun), games: num(s.totalGames), distance: num(s.totalDistance), coins: num(s.totalCoins) };
    } },
    'Vex 5': { interval: 5000, poll: function () {
      var k = lsKeys().filter(function (x) { return /^vex5_v\d+:sg$/.test(x); })[0]; if (!k) return null;
      var d = lsJson(k); if (!d) return null;
      var ach = d.achievements || {};
      return { levels: (d.levels || []).filter(function (l) { return l && num(l.tt) >= 0; }).length,
        achievements: Object.keys(ach).filter(function (a) { return ach[a] === true; }).length,
        deaths: num(d.stats && d.stats.td) };
    } },
    'Idle Breakout': { interval: 8000, poll: function () {
      var k = lsKeys().filter(function (x) { return /^breakout\.\d+\.save\.dat$/.test(x); })[0]; if (!k) return null;
      var ini = ls(k) || '', sec = '', main = {}, ach = 0;
      ini.split(/\r?\n/).forEach(function (line) {
        var m = /^\[(.+)\]$/.exec(line.trim()); if (m) { sec = m[1]; return; }
        var kv = /^([^=]+)="?([^"]*)"?$/.exec(line.trim()); if (!kv) return;
        if (sec === 'main') main[kv[1]] = kv[2]; else if (sec === 'achievements' && num(kv[2]) > 0) ach++;
      });
      return { level: num(main.level), prestige: num(main.prestiged), clicks: num(main.clicks), achievements: ach };
    } },
    'Geometry Dash Lite': prefsHook(function (p) {
      if (!p.PLAYER_DATA) return null;
      var pd, gd; try { pd = JSON.parse(p.PLAYER_DATA); gd = JSON.parse(p.GAME_DATA || '{}'); } catch (e) { return null; }
      var lv = (pd.leveldatas || []).filter(function (l) { return !l.comingSoon; });
      var star = function (id) { var x = (gd.starData || []).filter(function (s) { return s.id === id; })[0]; return x ? num(x.parameter) : 0; };
      return { stereo: lv[0] && num(lv[0].normalMode) >= 100 ? 1 : 0,
        levels: lv.filter(function (l) { return num(l.normalMode) >= 100; }).length,
        coins: lv.reduce(function (a, l) { return a + num(l.coin); }, 0),
        jumps: star(0), attempts: star(1) };
    }),
    'Tunnel Rush': prefsHook(function (p) { return p.RecordDistance === undefined ? null : { distance: Math.floor(num(p.RecordDistance)) }; }),
    'Snow Rider 3D': prefsHook(function (p) { return p.Plays === undefined ? null : { plays: num(p.Plays), skin: num(p.CurrentSkin) > 0 ? 1 : 0 }; }),
    'Slope': { interval: 6000, poll: function () {
      return readPlayerPrefs().then(function (prefs) {
        if (!prefs) return null;
        var best = 0;
        Object.keys(prefs).forEach(function (k) { if (/best|high/i.test(k) && /score/i.test(k)) best = Math.max(best, num(prefs[k])); });
        return { best: Math.floor(best) };
      }).catch(function () { return null; });
    } },
    'Eaglercraft': { interval: 15000, poll: function () { return eaglercraft().catch(function () { return null; }); } },
    "Five Nights at Freddy's": fnaf({ night: 'current night', clock: 'time' }),
    "Five Nights at Freddy's 2": fnaf({ night: 'night', clock: 'time' }),
    "Five Nights at Freddy's 3": fnaf({ night: 'select night', clock: 'time' }),
    "Five Nights at Freddy's 4": fnaf({ night: 'night', clock: '-' }),
    'FNAF: Sister Location': fnaf({ night: 'night', skip: function (v) { return String(v['custom night active?']) === '1'; } }),
  };

  return {
    has: function (name) { return !!HOOKS[name]; },
    names: function () { return Object.keys(HOOKS); },
    /* Start watching a running game. report(stats) is called whenever the numbers change. */
    watch: function (name, win, report) {
      var h = HOOKS[name]; if (!h) return null;
      var state = {}, last = '', stopped = false, timer = null;
      function tick() {
        if (stopped) return;
        var r; try { r = h.poll(win, state); } catch (e) { r = null; }
        Promise.resolve(r).then(function (stats) {
          if (stats && !stopped) {
            var merged = Object.assign(state.sent || {}, stats);   // keep previously seen per-session values (FNAF nights)
            state.sent = merged;
            var key = JSON.stringify(merged);
            if (key !== last && key !== '{}') { last = key; report(merged); }
          }
        }, function () {}).then(function () { if (!stopped) timer = setTimeout(tick, h.interval || 5000); });
      }
      timer = setTimeout(tick, 1500);
      return { stop: function () {
        stopped = true; clearTimeout(timer);
        try { Promise.resolve(h.poll(win, state)).then(function (s) {
          if (!s) return; var m = Object.assign(state.sent || {}, s), k = JSON.stringify(m);
          if (k !== last && k !== '{}') report(m);
        }, function () {}); } catch (e) {}
      } };
    },
    _parsePrefs: parsePrefs
  };
})();

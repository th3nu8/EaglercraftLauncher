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
      r.onsuccess = function () { res(r.result); };
      r.onerror = function (e) { if (fresh) e.preventDefault(); res(null); };
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
  function readPlayerPrefs() {
    return openDb('/idbfs').then(function (db) {
      if (!db || !db.objectStoreNames.contains('FILE_DATA')) { if (db) db.close(); return null; }
      var store = db.transaction('FILE_DATA', 'readonly').objectStore('FILE_DATA');
      return req(store.getAllKeys()).then(function (keys) {
        var key = keys.filter(function (k) { return /\/PlayerPrefs$/.test(k); })[0];
        if (!key) { db.close(); return null; }
        return req(db.transaction('FILE_DATA', 'readonly').objectStore('FILE_DATA').get(key)).then(function (rec) {
          db.close(); return parsePrefs(bytes(rec && rec.contents));
        });
      });
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

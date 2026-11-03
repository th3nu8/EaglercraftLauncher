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

  /* ---------- Flash saves (Ruffle keeps each SharedObject in localStorage as a base64 .sol file) ---------- */
  function parseSol(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), i = 0;
    function u8r() { return u8[i++]; }
    function u16() { var v = dv.getUint16(i); i += 2; return v; }
    function u32() { var v = dv.getUint32(i); i += 4; return v; }
    function dbl() { var v = dv.getFloat64(i); i += 8; return v; }
    function str(n) { var v = text(u8.subarray(i, i + n)); i += n; return v; }
    // AMF0
    var refs0 = [];
    function amf0() {
      var t = u8r(), o, k;
      switch (t) {
        case 0: return dbl();
        case 1: return !!u8r();
        case 2: return str(u16());
        case 3: case 0x10: case 8:
          if (t === 0x10) str(u16());
          if (t === 8) u32();
          o = {}; refs0.push(o);
          while (i < u8.length) { k = str(u16()); if (u8[i] === 9) { i++; break; } o[k] = amf0(); }
          return o;
        case 5: case 6: case 0x0D: return null;
        case 7: return refs0[u16()] || null;
        case 0x0A: { var n = u32(), arr = []; refs0.push(arr); for (var j = 0; j < n; j++) arr.push(amf0()); return arr; }
        case 0x0B: { var d = dbl(); i += 2; return d; }
        case 0x0C: case 0x0F: return str(u32());
        case 0x11: return amf3();
        default: throw new Error('amf0 ' + t);
      }
    }
    // AMF3
    var strs = [], objs = [], traits = [];
    function u29() { var v = 0, b, n = 0; while (n < 3 && ((b = u8r()) & 0x80)) { v = (v << 7) | (b & 0x7f); n++; } if (n < 3) v = (v << 7) | b; else { b = u8r(); v = (v << 8) | b; } return v; }
    function s3() { var r = u29(); if (!(r & 1)) return strs[r >> 1]; var n = r >> 1; if (!n) return ''; var v = str(n); strs.push(v); return v; }
    function amf3() {
      var t = u8r(), r, o, n, j;
      switch (t) {
        case 0: case 1: return null;
        case 2: return false;
        case 3: return true;
        case 4: r = u29(); return r & 0x10000000 ? r - 0x20000000 : r;
        case 5: return dbl();
        case 6: return s3();
        case 7: case 0x0B: r = u29(); if (!(r & 1)) return objs[r >> 1]; o = str(r >> 1); objs.push(o); return o;
        case 8: r = u29(); if (!(r & 1)) return objs[r >> 1]; o = dbl(); objs.push(o); return o;
        case 9:
          r = u29(); if (!(r & 1)) return objs[r >> 1];
          n = r >> 1; o = []; objs.push(o);
          var key; while ((key = s3()) !== '') o[key] = amf3();
          for (j = 0; j < n; j++) o.push(amf3());
          return o;
        case 0x0A: {
          r = u29(); if (!(r & 1)) return objs[r >> 1];
          var tr;
          if (!(r & 2)) tr = traits[r >> 2];
          else { tr = { ext: !!(r & 4), dyn: !!(r & 8), names: [] }; s3(); var cnt = r >> 4; for (j = 0; j < cnt; j++) tr.names.push(s3()); traits.push(tr); }
          o = {}; objs.push(o);
          if (tr.ext) throw new Error('amf3 externalizable');
          tr.names.forEach(function (nm) { o[nm] = amf3(); });
          if (tr.dyn) { var k2; while ((k2 = s3()) !== '') o[k2] = amf3(); }
          return o;
        }
        case 0x0C: r = u29(); if (!(r & 1)) return objs[r >> 1]; i += r >> 1; o = '[bytes]'; objs.push(o); return o;
        case 0x0D: case 0x0E: case 0x0F: case 0x10:
          r = u29(); if (!(r & 1)) return objs[r >> 1]; n = r >> 1; i++; o = []; objs.push(o);
          if (t === 0x10) s3();
          for (j = 0; j < n; j++) o.push(t === 0x0D ? (i += 4, dv.getInt32(i - 4)) : t === 0x0E ? (i += 4, dv.getUint32(i - 4)) : t === 0x0F ? dbl() : amf3());
          return o;
        case 0x11: r = u29(); if (!(r & 1)) return objs[r >> 1]; n = r >> 1; i++; o = {}; objs.push(o); for (j = 0; j < n; j++) { var kk = amf3(); o[String(kk)] = amf3(); } return o;
        default: throw new Error('amf3 ' + t);
      }
    }
    if (u16() !== 0x00BF) return null;
    u32(); if (str(4) !== 'TCSO') return null; i += 6;
    var name = str(u16()), ver = u32(), data = {};
    try {
      while (i < u8.length) {
        var k = ver === 3 ? s3() : str(u16());
        data[k] = ver === 3 ? amf3() : amf0();
        i++;   // trailing 0
      }
    } catch (e) {}
    return { name: name, data: data };
  }
  /* Find Ruffle saves whose SharedObject name matches re; returns [{key, data}]. */
  function flashSaves(re) {
    var out = [];
    lsKeys().forEach(function (k) {
      var name = k.split('/').pop(); if (!re.test(name)) return;
      var v = ls(k); if (!v) return;
      try { var bin = atob(v), u = new Uint8Array(bin.length); for (var j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
        var sol = parseSol(u); if (sol) out.push({ key: name, data: sol.data }); } catch (e) {}
    });
    return out;
  }
  /* A Flash hook: only saves written while this game runs count, so games that share a save name
   * (Duck Life 1-4 all use "mydata", every Papa's game uses similar slot names) can't credit each other. */
  function flashHook(re, fn, interval) {
    return { interval: interval || 5000, poll: function (win, state) {
      var keys = lsKeys().filter(function (k) { return re.test(k.split('/').pop()); });
      if (!state.base) { state.base = {}; keys.forEach(function (k) { state.base[k] = ls(k); }); return null; }
      var changed = keys.filter(function (k) { return ls(k) !== state.base[k]; });
      if (!changed.length) return null;
      var saves = [];
      changed.forEach(function (k) {
        try { var bin = atob(ls(k)), u = new Uint8Array(bin.length); for (var j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
          var sol = parseSol(u); if (sol) saves.push(sol.data); } catch (e) {}
      });
      return saves.length ? fn(saves) : null;
    } };
  }
  function countTrue(a) { var n = 0; if (a && typeof a === 'object') for (var k in a) { var v = a[k]; if (v === true || (typeof v === 'number' && v > 0) || v === 'yes') n++; } return n; }
  function papas() {
    return flashHook(/^(papas[a-z]+_\d+|RoyPizzeriaSlot\d+)$/i, function (saves) {
      return { rank: maxOf(saves, function (d) { return d.rank || (d.savedata && d.savedata.rank); }),
        day: maxOf(saves, function (d) { return d.day || (d.savedata && d.savedata.currentday); }),
        badges: maxOf(saves, function (d) { return countTrue(d.medalsEarned); }) };
    });
  }
  function duckOld(climb) {
    return flashHook(/^mydata$/, function (saves) {
      var d = saves[0], skills = ['runlvl', 'swilvl', 'flylvl'].concat(climb ? ['clilvl'] : []);
      return { race: num(d.race), money: num(d.money), low: Math.min.apply(null, skills.map(function (k) { return num(d[k]); })),
        top: Math.max.apply(null, skills.map(function (k) { return num(d[k]); })) };
    });
  }
  /* ---------- Spec-driven hooks ----------
   * Most games are described by a small spec instead of custom code:
   *   { src: 'ls' | 'flash' | 'prefs' | 'lf', key: RegExp (or exact string), fmt: 'json'|'num'|'ini'|'b64json'|'raw', stats: { name: expr } }
   * expr is a path into the save ('a.b.0.c'), optionally followed by '|op':
   *   |len (array/object size)  |true (count truthy entries)  |ge:N (count entries >= N)  |bool (1 if truthy)
   *   |sum (sum of entries)     |max (largest entry)          |keys:RE (count keys matching RE)
   * Paths may use '*' to step into every entry of an array/object (results are flattened).
   * A stat may also be a function(save) for odd cases. With several matching saves, the highest value wins. */
  function getPath(o, path) {
    if (path === '' || path === '.') return [o];
    var parts = path.split('.'), cur = [o];
    parts.forEach(function (p) {
      var next = [];
      cur.forEach(function (c) {
        if (c === null || c === undefined) return;
        if (typeof c === 'string' && /^[\[{]/.test(c)) { try { c = JSON.parse(c); } catch (e) {} }
        if (p === '*') { if (typeof c === 'object') for (var k in c) next.push(c[k]); }
        else next.push(c[p]);
      });
      cur = next;
    });
    return cur;
  }
  function evalStat(save, expr) {
    if (typeof expr === 'function') { try { return num(expr(save)); } catch (e) { return 0; } }
    var bar = expr.indexOf('|'), path = bar < 0 ? expr : expr.slice(0, bar), op = bar < 0 ? '' : expr.slice(bar + 1);
    var vals = getPath(save, path), out = 0;
    if (op.indexOf('cntge:') === 0) { var th = num(op.slice(6)); return vals.filter(function (v) { return num(v) >= th; }).length; }   // count leaves >= N
    if (op === 'tot') return vals.reduce(function (a, v) { return a + num(v); }, 0);                     // sum of leaves
    if (op === 'cnt') return vals.filter(function (v) { return v === true || num(v) > 0; }).length;   // count leaves that are set
    vals.forEach(function (v) {
      var n;
      if (typeof v === 'string' && /^[\[{]/.test(v)) { try { v = JSON.parse(v); } catch (e) {} }
      if (!op) n = typeof v === 'boolean' ? (v ? 1 : 0) : num(v);
      else if (op === 'len') n = v && typeof v === 'object' ? Object.keys(v).length : 0;
      else if (op === 'true') n = countTrue(v);
      else if (op === 'bool') n = v && v !== '0' && v !== 'false' ? 1 : 0;
      else if (op === 'sum' || op === 'max') { n = 0; if (v && typeof v === 'object') for (var k in v) n = op === 'sum' ? n + num(v[k]) : Math.max(n, num(v[k])); }
      else if (op.indexOf('ge:') === 0) { var t = num(op.slice(3)); n = 0; if (v && typeof v === 'object') for (var k2 in v) if (num(v[k2]) >= t) n++; }
      else if (op.indexOf('truekeys:') === 0) { var re2 = new RegExp(op.slice(9)); n = 0; if (v && typeof v === 'object') for (var k4 in v) if (re2.test(k4) && v[k4] && v[k4] !== '0' && !/^false$/i.test(String(v[k4]))) n++; }
      else if (op.indexOf('keymax:') === 0) { var re3 = new RegExp(op.slice(7)); n = 0; if (v && typeof v === 'object') for (var k5 in v) if (re3.test(k5)) n = Math.max(n, num(v[k5])); }
      else if (op.indexOf('keys:') === 0) { var re = new RegExp(op.slice(5)); n = 0; if (v && typeof v === 'object') for (var k3 in v) if (re.test(k3)) n++; }
      if (n > out) out = n;
    });
    return out;
  }
  function decode(raw, fmt) {
    if (raw === null || raw === undefined) return null;
    if (fmt === 'raw') return raw;
    if (fmt === 'num') return num(raw);
    if (fmt === 'ini') {
      var o = {}, sec = o;
      String(raw).split(/\r?\n/).forEach(function (line) {
        line = line.trim(); var m = /^\[(.+)\]$/.exec(line); if (m) { sec = o[m[1]] = o[m[1]] || {}; return; }
        var kv = /^([^=]+)="?([^"]*)"?$/.exec(line); if (kv) sec[kv[1].trim()] = kv[2];
      });
      return o;
    }
    if (fmt === 'b64json') { var s = String(raw), i = s.indexOf('eyJ'); if (i < 0) i = 0; try { return JSON.parse(atob(s.slice(i).replace(/[^A-Za-z0-9+/=]/g, ''))); } catch (e) { return null; } }
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? num(raw) : raw; }
  }
  function keyMatch(key, spec) { return typeof spec.key === 'string' ? key === spec.key : spec.key.test(key); }
  function specHook(spec) {
    function compute(saves) {
      if (!saves.length) return null;
      var out = {};
      Object.keys(spec.stats).forEach(function (st) { out[st] = 0; saves.forEach(function (sv) { var v = evalStat(sv, spec.stats[st]); if (v > out[st]) out[st] = v; }); });
      return out;
    }
    if (spec.src === 'flash') return flashHook(spec.key instanceof RegExp ? spec.key : new RegExp('^' + spec.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), compute, spec.interval);
    return { interval: spec.interval || 5000, poll: function (win, state) {
      if (spec.src === 'prefs') return readPlayerPrefs().then(function (p) {
        if (!p) return null;
        if (spec.key) { var hit = Object.keys(p).some(function (k) { return keyMatch(k, spec); }); if (!hit) return null; }
        return compute([p]);
      }).catch(function () { return null; });
      if (spec.src === 'lf' && spec.key instanceof RegExp) return openDb(spec.db || 'localforage').then(function (db) {
        if (!db || !db.objectStoreNames.contains('keyvaluepairs')) { if (db) db.close(); return null; }
        var os = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs');
        return Promise.all([req(os.getAllKeys()), req(os.getAll())]).then(function (r) {
          db.close(); var o = {}, any = false;
          r[0].forEach(function (k, i) { if (spec.key.test(String(k))) { o[k] = decode(r[1][i], spec.fmt); any = true; } });
          return any ? compute([o]) : null;
        }, function () { db.close(); return null; });
      }).catch(function () { return null; });
      if (spec.src === 'lf') return readLocalforage(spec.key).then(function (v) { return v === null || v === undefined ? null : compute([decode(v, spec.fmt)]); }).catch(function () { return null; });
      // localStorage (session: only keys whose value changed while this game runs - for games sharing key names)
      var saves = [];
      if (spec.session) {
        var st = state;
        if (!st.base) { st.base = {}; lsKeys().forEach(function (k) { if (keyMatch(k, spec)) st.base[k] = ls(k); }); return null; }
        if (!lsKeys().some(function (k) { return keyMatch(k, spec) && ls(k) !== st.base[k]; })) return null;
      }
      lsKeys().forEach(function (k) { if (keyMatch(k, spec)) { var d = decode(ls(k), spec.fmt); if (d !== null) saves.push(spec.whole ? (function () { var o = {}; o[k] = d; return o; })() : d); } });
      if (spec.all) { var o = {}; lsKeys().forEach(function (k) { if (keyMatch(k, spec)) o[k] = decode(ls(k), spec.fmt); }); return Object.keys(o).length ? compute([o]) : null; }
      return compute(saves);
    } };
  }
  function maxOf(list, fn) { return list.reduce(function (m, x) { var v = num(fn(x)); return v > m ? v : m; }, 0); }

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
    /* ---- batch 2 (Flash) ---- */
    "Papa's Pizzeria": papas(), "Papa's Burgeria": papas(), "Papa's Taco Mia!": papas(), "Papa's Freezeria": papas(),
    "Papa's Pancakeria": papas(), "Papa's Wingeria": papas(), "Papa's Hot Doggeria": papas(), "Papa's Cupcakeria": papas(),
    "Papa's Pastaria": papas(), "Papa's Donuteria": papas(), "Papa's Cheeseria": papas(), "Papa's Bakeria": papas(),
    "Papa's Sushiria": papas(), "Papa's Scooperia": papas(),
    'Duck Life': duckOld(false), 'Duck Life 2': duckOld(false), 'Duck Life 3: Evolution': duckOld(true),
    'Duck Life 4': flashHook(/^mydata$/, function (saves) {
      var d = saves[0], races = 0, tourn = 0;
      for (var i = 1; i <= 18; i++) if (num(d['race' + i]) > 0 || d['race' + i] === true) races++;
      for (var j = 1; j <= 5; j++) if (num(d['tourn' + j]) > 0 || d['tourn' + j] === true) tourn++;
      return { races: races, tournaments: tourn };
    }),
    'Duck Life 5: Treasure Hunt': flashHook(/^dlthv1\.1$/, function (saves) {
      var d = saves[0];
      return { coins: num(d.coins), best: num(d.bestdist), pet: num(d.petlevel), story: d.storydone ? 1 : 0, challenges: countTrue(d.challenges) };
    }),
    'Fireboy and Watergirl: Forest Temple': flashHook(/^FBCookie$/, function (saves) {
      var st = saves[0].stats || [], done = 0, best = 0;
      for (var i = 0; i < st.length; i++) { if (num(st[i]) >= 1) done++; if (num(st[i]) >= 3) best++; }
      return { levels: done, perfect: best };
    }),
    'Bloons TD 2': flashHook(/^bloonstd2$/, function (saves) {
      var d = saves[0]; return { bronze: d.bronze ? 1 : 0, silver: d.silver ? 1 : 0, gold: d.gold ? 1 : 0 };
    }),
    /* ---- batch 1 ---- */
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

  /* Spec-described games (see specHook). */
  var SPECS = window.MIST_SPECS || {};
  Object.keys(SPECS).forEach(function (n) { if (!HOOKS[n]) HOOKS[n] = specHook(SPECS[n]); });
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
    _parsePrefs: parsePrefs, _parseSol: parseSol, _flashSaves: flashSaves
  };
})();

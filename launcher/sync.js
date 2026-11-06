/* Eaglercraft Launcher — cloud saves
 * Snapshots Eaglercraft's IndexedDB databases + localStorage settings into one
 * binary blob, and syncs it with the save server using revision numbers. */
window.EaglerSync = (function () {
  'use strict';

  /* PBKDF2-SHA256(password, "mist-v1:" + lowercase name): what gets sent instead of the typed password.
   * Needs WebCrypto (any https page); resolves null without it, and then the typed password is sent. */
  function prehash(user, pw) {
    var c = window.crypto && window.crypto.subtle;
    if (!c || !window.TextEncoder) return Promise.resolve(null);
    var enc = new TextEncoder();
    return c.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return c.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('mist-v1:' + String(user).trim().toLowerCase()), iterations: 100000 }, k, 256);
    }).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    }).catch(function () { return null; });
  }

  var DB_INCLUDE = /eagler/i;
  var DB_EXCLUDE = /resource.?packs?/i;      // resource packs are big and re-downloadable
  var LS_INCLUDE = /eagler/i;
  var LS_SKIP = /^eaglerLauncher:/;           // the launcher's own settings
  var MAGIC = [69, 71, 76, 83, 65, 86, 69, 49]; // "EGLSAVE1"

  /* ================= value encoding ================= */
  function BlobData(buf, type) { this.buf = buf; this.type = type; }
  function hasBlob(v) {
    if (!v || typeof v !== 'object') return false;
    if (typeof Blob !== 'undefined' && v instanceof Blob) return true;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Date) return false;
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && hasBlob(v[k])) return true;
    return false;
  }
  function resolveBlobs(v) {
    if (!v || typeof v !== 'object') return Promise.resolve(v);
    if (typeof Blob !== 'undefined' && v instanceof Blob) return v.arrayBuffer().then(function (b) { return new BlobData(b, v.type); });
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Date) return Promise.resolve(v);
    if (Array.isArray(v)) return Promise.all(v.map(resolveBlobs));
    var keys = Object.keys(v);
    return Promise.all(keys.map(function (k) { return resolveBlobs(v[k]); })).then(function (vals) {
      var o = {}; keys.forEach(function (k, i) { o[k] = vals[i]; }); return o;
    });
  }
  function enc(v, bins) {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return isFinite(v) ? v : { $n: String(v) };
    if (t === 'undefined') return { $u: 1 };
    if (t === 'bigint') return { $bi: String(v) };
    if (v instanceof Date) return { $d: v.getTime() };
    if (v instanceof BlobData) { bins.push(new Uint8Array(v.buf)); return { $blob: bins.length - 1, type: v.type }; }
    if (v instanceof ArrayBuffer) { bins.push(new Uint8Array(v)); return { $ab: bins.length - 1 }; }
    if (ArrayBuffer.isView(v)) { bins.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return { $ta: v.constructor.name, i: bins.length - 1 }; }
    if (Array.isArray(v)) return v.map(function (x) { return enc(x, bins); });
    if (v instanceof Map) return { $map: Array.from(v).map(function (e) { return [enc(e[0], bins), enc(e[1], bins)]; }) };
    if (v instanceof Set) return { $set: Array.from(v).map(function (x) { return enc(x, bins); }) };
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = enc(v[k], bins);
    return { $o: o };
  }
  function dec(x, bins) {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(function (y) { return dec(y, bins); });
    if ('$o' in x) { var o = {}; for (var k in x.$o) o[k] = dec(x.$o[k], bins); return o; }
    if ('$ab' in x) return bins[x.$ab].slice().buffer;
    if ('$ta' in x) {
      var b = bins[x.i].slice().buffer;
      if (x.$ta === 'DataView') return new DataView(b);
      var C = window[x.$ta]; return typeof C === 'function' ? new C(b) : new Uint8Array(b);
    }
    if ('$blob' in x) return new Blob([bins[x.$blob]], { type: x.type || '' });
    if ('$d' in x) return new Date(x.$d);
    if ('$u' in x) return undefined;
    if ('$n' in x) return Number(x.$n);
    if ('$bi' in x) return BigInt(x.$bi);
    if ('$map' in x) return new Map(x.$map.map(function (e) { return [dec(e[0], bins), dec(e[1], bins)]; }));
    if ('$set' in x) return new Set(x.$set.map(function (y) { return dec(y, bins); }));
    return x;
  }

  /* ================= binary packing ================= */
  function pack(header, bins) {
    var json = new TextEncoder().encode(JSON.stringify(header));
    var total = 12 + json.length;
    bins.forEach(function (b) { total += 4 + b.byteLength; });
    var out = new Uint8Array(total), dv = new DataView(out.buffer), o = 0;
    out.set(MAGIC, 0); o = 8;
    dv.setUint32(o, json.length); o += 4;
    out.set(json, o); o += json.length;
    bins.forEach(function (b) { dv.setUint32(o, b.byteLength); o += 4; out.set(b, o); o += b.byteLength; });
    return out;
  }
  function unpack(u8) {
    for (var i = 0; i < 8; i++) if (u8[i] !== MAGIC[i]) throw new Error('Not an Eaglercraft save file.');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), o = 8;
    var jl = dv.getUint32(o); o += 4;
    var header = JSON.parse(new TextDecoder().decode(u8.subarray(o, o + jl))); o += jl;
    var bins = [];
    while (o < u8.length) { var n = dv.getUint32(o); o += 4; bins.push(u8.subarray(o, o + n)); o += n; }
    return { header: header, bins: bins };
  }
  function streamBytes(u8, ts) {
    return new Response(new Blob([u8]).stream().pipeThrough(ts)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function gzip(u8) { return window.CompressionStream ? streamBytes(u8, new CompressionStream('gzip')) : Promise.resolve(u8); }
  function gunzip(u8) {
    if (u8[0] !== 0x1f || u8[1] !== 0x8b) return Promise.resolve(u8);
    if (!window.DecompressionStream) return Promise.reject(new Error('This browser cannot unpack compressed saves.'));
    return streamBytes(u8, new DecompressionStream('gzip'));
  }
  function sha256Hex(u8) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', u8).then(function (b) {
        return Array.from(new Uint8Array(b)).map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
      });
    }
    // non-secure page fallback: four FNV-1a lanes (change detection only)
    var h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
    for (var i = 0; i < u8.length; i++) { var l = i & 3; h[l] = Math.imul(h[l] ^ u8[i], 16777619) >>> 0; }
    var s = h.map(function (x) { return ('0000000' + x.toString(16)).slice(-8); }).join('');
    return Promise.resolve((s + s).slice(0, 64));
  }

  /* ================= IndexedDB snapshot / restore ================= */
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function listDbNames(known) {
    var p = indexedDB.databases ? indexedDB.databases().then(function (l) { return l.map(function (d) { return d.name; }); }) : Promise.resolve([]);
    return p.catch(function () { return []; }).then(function (names) {
      (known || []).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
      return names.filter(function (n) { return n && DB_INCLUDE.test(n) && !DB_EXCLUDE.test(n); }).sort();
    });
  }
  function openExisting(name) {
    return new Promise(function (res, rej) {
      var fresh = false, r = indexedDB.open(name);
      r.onupgradeneeded = function () { fresh = true; r.transaction.abort(); }; // don't create missing DBs
      r.onsuccess = function () { var db = r.result; db.onversionchange = function () { db.close(); }; res(db); };
      r.onerror = function (e) { if (fresh) { e.preventDefault(); res(null); } else rej(r.error); };
    });
  }
  function normKeyPath(kp) { return kp && typeof kp === 'object' ? Array.from(kp) : kp; }
  function dumpDb(name) {
    return openExisting(name).then(function (db) {
      if (!db) return null;
      var names = Array.from(db.objectStoreNames);
      if (!names.length) { var v0 = db.version; db.close(); return { name: name, version: v0, stores: [] }; }
      var tx = db.transaction(names, 'readonly');
      return Promise.all(names.map(function (sn) {
        var os = tx.objectStore(sn);
        var info = {
          name: sn, keyPath: normKeyPath(os.keyPath), autoIncrement: os.autoIncrement,
          indexes: Array.from(os.indexNames).map(function (iname) {
            var ix = os.index(iname);
            return { name: iname, keyPath: normKeyPath(ix.keyPath), unique: ix.unique, multiEntry: ix.multiEntry };
          })
        };
        return Promise.all([req(os.getAllKeys()), req(os.getAll())]).then(function (r) { info.keys = r[0]; info.values = r[1]; return info; });
      })).then(function (stores) {
        var ver = db.version; db.close();
        return Promise.all(stores.map(function (s) {
          return Promise.all(s.values.map(function (v) { return hasBlob(v) ? resolveBlobs(v) : v; })).then(function (vals) { s.values = vals; return s; });
        })).then(function (stores2) { return { name: name, version: ver, stores: stores2 }; });
      }, function (e) { db.close(); throw e; });
    });
  }
  /* Empty a save database before restoring. Deleting it would be tidier, but the browser refuses or stalls
   * when anything still has it open (a game that hasn't fully unloaded, another tab), and a stalled delete
   * blocks every later open. Clearing its stores works even with other connections open. */
  function deleteDb(name) { return clearDb(name); }
  function clearDb(name) {
    return openExisting(name).then(function (db) {
      if (!db) return;
      var names = Array.prototype.slice.call(db.objectStoreNames);
      if (!names.length) { db.close(); return; }
      return new Promise(function (res, rej) {
        var tx = db.transaction(names, 'readwrite');
        names.forEach(function (n) { tx.objectStore(n).clear(); });
        tx.oncomplete = function () { db.close(); res(); };
        tx.onerror = tx.onabort = function () { db.close(); rej(tx.error); };
      });
    }).catch(function (e) {
      throw new Error('Couldn’t replace the saves in "' + name + '"' + (e && e.message ? ' (' + e.message + ')' : '') + '. Close other tabs using these games, reload, and try again.');
    });
  }
  function openDbAt(name, version, onUpgrade) {
    return new Promise(function (res, rej) {
      var r = version ? indexedDB.open(name, version) : indexedDB.open(name);
      r.onupgradeneeded = function () { if (onUpgrade) onUpgrade(r.result); };
      r.onblocked = function () { /* wait; other connections were asked to close */ };
      r.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); clearTimeout(t); rej(r.error); };
      r.onsuccess = function () { clearTimeout(t); res(r.result); };
      var t = setTimeout(function () { rej(new Error('Saves for "' + name + '" are open in another tab or game. Close it, reload and try again.')); }, 10000);
    });
  }
  function createDb(d, bins) {
    function makeStores(db) {
      d.stores.forEach(function (s) {
        if (db.objectStoreNames.contains(s.name)) return;
        var opts = { autoIncrement: !!s.autoIncrement };
        if (s.keyPath !== null && s.keyPath !== undefined) opts.keyPath = s.keyPath;
        var os = db.createObjectStore(s.name, opts);
        s.indexes.forEach(function (ix) { os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry }); });
      });
    }
    // The database may still exist (if it was cleared instead of deleted): reuse it, adding any missing stores.
    return openExisting(d.name).catch(function () { return null; }).then(function (cur) {
      if (!cur) return openDbAt(d.name, d.version || 1, makeStores);
      var missing = d.stores.some(function (s) { return !cur.objectStoreNames.contains(s.name); });
      if (!missing) return cur;
      var v = Math.max(cur.version + 1, d.version || 1); cur.close();
      return openDbAt(d.name, v, makeStores);
    }).then(function (db) {
      if (!d.stores.length) { db.close(); return; }
      return new Promise(function (res, rej) {
        var tx = db.transaction(d.stores.map(function (s) { return s.name; }), 'readwrite');
        d.stores.forEach(function (s) {
          var os = tx.objectStore(s.name), inline = s.keyPath !== null && s.keyPath !== undefined;
          for (var i = 0; i < s.values.length; i++) {
            var v = dec(s.values[i], bins);
            if (inline) os.put(v); else os.put(v, dec(s.keys[i], bins));
          }
        });
        tx.oncomplete = function () { db.close(); res(); };
        tx.onerror = tx.onabort = function () { db.close(); rej(tx.error || new Error('Restore failed.')); };
      });
    });
  }

  /* Some pages (a browser's new-tab page, sites set to block cookies/site data, private modes) deny
   * IndexedDB/localStorage entirely. Then there's nothing to back up or restore, so syncing is skipped. */
  var storageCheck = null;
  function storageBlocked() {
    if (storageCheck !== null) return storageCheck;
    try { if (!window.indexedDB) throw 0; var r = indexedDB.open('__mist_probe'); r.onsuccess = function () { try { r.result.close(); } catch (e) {} }; r.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); };
      localStorage.getItem('__mist_probe'); storageCheck = false; }
    catch (e) { storageCheck = true; }
    return storageCheck;
  }
  function snapshot(known) {
    return listDbNames(known).then(function (names) {
      return names.reduce(function (p, n) {
        return p.then(function (acc) { return dumpDb(n).then(function (d) { if (d) acc.push(d); return acc; }); });
      }, Promise.resolve([]));
    }).then(function (dbs) {
      var ls = {}, keys = [];
      try { for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) {}
      keys.sort().forEach(function (k) { if (LS_INCLUDE.test(k) && !LS_SKIP.test(k)) ls[k] = localStorage.getItem(k); });
      var bins = [], records = 0;
      var header = {
        format: 1,
        dbs: dbs.map(function (d) {
          return {
            name: d.name, version: d.version,
            stores: d.stores.map(function (s) {
              records += s.keys.length;
              return {
                name: s.name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: s.indexes,
                keys: s.keys.map(function (k) { return enc(k, bins); }),
                values: s.values.map(function (v) { return enc(v, bins); })
              };
            })
          };
        }),
        ls: ls
      };
      var bytes = pack(header, bins);
      return sha256Hex(bytes).then(function (hash) {
        return { bytes: bytes, hash: hash, records: records, empty: records === 0 };
      });
    });
  }

  function restore(bytes, known) {
    return gunzip(bytes).then(function (u8) {
      var p = unpack(u8), header = p.header, bins = p.bins;
      return listDbNames(known).then(function (existing) {
        var all = existing.slice();
        header.dbs.forEach(function (d) { if (all.indexOf(d.name) < 0) all.push(d.name); });
        return all.reduce(function (q, n) { return q.then(function () { return deleteDb(n); }); }, Promise.resolve());
      }).then(function () {
        return header.dbs.reduce(function (q, d) { return q.then(function () { return createDb(d, bins); }); }, Promise.resolve());
      }).then(function () {
        try {
          var rm = [];
          for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (LS_INCLUDE.test(k) && !LS_SKIP.test(k)) rm.push(k); }
          rm.forEach(function (k) { localStorage.removeItem(k); });
          Object.keys(header.ls || {}).forEach(function (k) { localStorage.setItem(k, header.ls[k]); });
        } catch (e) {}
      });
    });
  }

  /* ================= sync engine ================= */
  function Engine(opts) {
    this.server = String(opts.server || '').replace(/\/+$/, '');
    this.store = opts.store;            // {get(k,d), set(k,v)}
    this.known = opts.knownDbs || [];
    this.onChange = opts.onChange || function () {};
    this.token = this.store.get('sync:token', null);
    this.user = this.store.get('sync:user', null);
    this.busy = false;
    this.status = { state: this.token ? 'idle' : 'signed-out', message: '', lastSync: this.store.get('sync:last', 0) };
  }
  Engine.prototype = {
    signedIn: function () { return !!this.token; },
    setStatus: function (state, message) {
      this.status.state = state; this.status.message = message || '';
      if (state === 'synced') { this.status.lastSync = Date.now(); this.store.set('sync:last', this.status.lastSync); }
      this.onChange(this.status);
    },
    baseKey: function () { return 'sync:base:' + (this.user || '').toLowerCase(); },
    getBase: function () { return this.store.get(this.baseKey(), null); },
    setBase: function (rev, hash) { this.store.set(this.baseKey(), { rev: rev, hash: hash }); },

    api: function (method, path, o) {
      o = o || {};
      var self = this, headers = o.headers || {};
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
      var body = o.body;
      if (o.json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
      if (!this.server) return Promise.reject(new Error('No save server is set. Add one in Settings.'));
      return fetch(this.server + path, { method: method, headers: headers, body: body, cache: 'no-store' }).catch(function () {
        throw new Error('Could not reach the save server.');
      }).then(function (r) {
        if (o.raw && r.ok) return r;
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.ok) return data;
          if (r.status === 401 && self.token && path !== '/api/login') self.forget();
          var err = new Error(data.error || ('Server error (' + r.status + ').'));
          err.status = r.status; err.data = data; throw err;
        });
      });
    },
    forget: function () {
      this.token = null; this.store.set('sync:token', null);
      this.setStatus('signed-out', 'Signed out');
    },
    auth: function (kind, username, password) {
      var self = this, path = kind === 'register' ? '/api/register' : '/api/login';
      if (kind === 'register' && (password.length < 6 || password.length > 200)) return Promise.reject(new Error('Password must be at least 6 characters.'));
      return prehash(username, password).then(function (h) {
        // Only the derived key is sent. Old accounts need the typed password once (server answers 428) to upgrade.
        return self.api('POST', path, { json: h ? { username: username, pwh: h } : { username: username, password: password } }).catch(function (e) {
          if (e.status === 428 && h) return self.api('POST', path, { json: { username: username, pwh: h, password: password } });
          throw e;
        });
      }).then(function (d) {
        self.token = d.token; self.user = d.user.name;
        self.store.set('sync:token', d.token); self.store.set('sync:user', d.user.name);
        self.setStatus('idle', '');
        return d;
      });
    },
    signOut: function () {
      var self = this;
      return this.api('POST', '/api/logout').catch(function () {}).then(function () { self.forget(); });
    },
    changePassword: function (current, password) {
      var self = this, u = this.user || '';
      if (password.length < 6 || password.length > 200) return Promise.reject(new Error('Password must be at least 6 characters.'));
      return Promise.all([prehash(u, current), prehash(u, password)]).then(function (h) {
        var j = h[0] && h[1] ? { currentH: h[0], passwordH: h[1] } : { current: current, password: password };
        return self.api('POST', '/api/password', { json: j }).catch(function (e) {
          if (e.status === 428 && h[0] && h[1]) return self.api('POST', '/api/password', { json: { current: current, currentH: h[0], passwordH: h[1] } });
          throw e;
        });
      }).then(function (d) {
        self.token = d.token; self.store.set('sync:token', d.token);
      });
    },

    upload: function (snap, ifRev) {
      var self = this;
      return gzip(snap.bytes).then(function (gz) {
        return self.api('PUT', '/api/save', {
          body: gz, headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(ifRev), 'X-Save-Hash': snap.hash }
        });
      }).then(function (d) { self.setBase(d.save.rev, snap.hash); return d.save; });
    },
    download: function () {
      var self = this;
      return this.api('GET', '/api/save', { raw: true }).then(function (r) {
        var rev = +r.headers.get('X-Save-Rev');
        return r.arrayBuffer().then(function (b) { return { bytes: new Uint8Array(b), rev: rev }; });
      }).then(function (d) {
        return restore(d.bytes, self.known).then(function () { return snapshot(self.known); }).then(function (s) {
          self.setBase(d.rev, s.hash); // hash what's actually on disk now
          return d.rev;
        });
      });
    },

    /* opts.allowPull=false while a game is running (we can't replace open databases).
     * Resolves to {action: 'in-sync'|'pushed'|'pulled'|'remote-newer'|'conflict'|'signed-out', ...} */
    sync: function (opts) {
      opts = opts || {};
      var self = this;
      if (!this.token) return Promise.resolve({ action: 'signed-out' });
      if (storageBlocked()) { this.setStatus('synced', ''); return Promise.resolve({ action: 'no-storage' }); }
      if (this.busy) return Promise.resolve({ action: 'busy' });
      this.busy = true;
      this.setStatus('syncing', opts.allowPull === false ? 'Backing up…' : 'Syncing…');
      var meta, snap;
      return this.api('GET', '/api/me').then(function (d) {
        meta = d.save; return snapshot(self.known);
      }).then(function (s) {
        snap = s;
        var base = self.getBase(), remoteRev = meta ? meta.rev : 0;
        if (meta && meta.hash === snap.hash) { self.setBase(remoteRev, snap.hash); return { action: 'in-sync' }; }
        var localChanged = base ? snap.hash !== base.hash : !snap.empty;
        var remoteChanged = base ? remoteRev !== base.rev : !!meta;
        if (!localChanged && !remoteChanged) return { action: 'in-sync' };
        if (localChanged && !remoteChanged) return self.upload(snap, remoteRev).then(function () { return { action: 'pushed' }; });
        if (!localChanged && remoteChanged) {
          if (opts.allowPull === false) return { action: 'remote-newer' };
          return self.download().then(function () { return { action: 'pulled' }; });
        }
        return { action: 'conflict', remote: meta, localRecords: snap.records };
      }).then(function (r) {
        self.busy = false;
        if (r.action === 'conflict') self.setStatus('conflict', 'Saves differ between this site and the cloud');
        else if (r.action === 'remote-newer') self.setStatus('conflict', 'Newer saves in the cloud. Return to the launcher to get them.');
        else self.setStatus('synced', '');
        return r;
      }, function (e) {
        self.busy = false;
        if (e.status === 409) { self.setStatus('conflict', 'Cloud saves changed on another site'); return { action: 'conflict', remote: e.data && e.data.save }; }
        self.setStatus('error', e.message);
        throw e;
      });
    },

    /* choice: 'cloud' (replace this site's saves) or 'local' (overwrite the cloud) */
    resolve: function (choice) {
      var self = this;
      this.busy = true; this.setStatus('syncing', choice === 'cloud' ? 'Downloading cloud saves…' : 'Uploading…');
      var p = choice === 'cloud'
        ? this.download()
        : Promise.all([this.api('GET', '/api/me'), snapshot(this.known)]).then(function (r) {
            return self.upload(r[1], r[0].save ? r[0].save.rev : 0);
          });
      return p.then(function () { self.busy = false; self.setStatus('synced', ''); }, function (e) {
        self.busy = false; self.setStatus('error', e.message); throw e;
      });
    }
  };

  return {
    Engine: Engine,
    snapshot: snapshot, storageBlocked: storageBlocked,
    restore: restore,
    exportFile: function (known) {
      return snapshot(known).then(function (s) { return gzip(s.bytes).then(function (gz) { return { bytes: gz, records: s.records }; }); });
    }
  };
})();

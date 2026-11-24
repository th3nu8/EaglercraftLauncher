/* Imitator: an all-in-one emulator for Panes. Players bring their own games (and BIOS files).
 * Runs the EmulatorJS (RetroArch in WebAssembly) cores served from ./data/ by the Panes server.
 * Games and BIOS files are kept in this browser (IndexedDB); nothing is uploaded. */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- consoles */
  // id = the EmulatorJS system name. bios: [file name the core looks for, label, required?]
  var SYSTEMS = [
    { id: 'nes', name: 'NES / Famicom', short: 'NES', maker: 'Nintendo', color: '#d32f2f', exts: ['nes', 'fds', 'unf', 'unif'] },
    { id: 'snes', name: 'Super Nintendo', short: 'SNES', maker: 'Nintendo', color: '#7e57c2', exts: ['sfc', 'smc', 'fig', 'swc', 'bs'] },
    { id: 'n64', name: 'Nintendo 64', short: 'N64', maker: 'Nintendo', color: '#2e7d32', exts: ['n64', 'z64', 'v64'] },
    { id: 'gb', name: 'Game Boy / Color', short: 'GB', maker: 'Nintendo', color: '#8bac0f', exts: ['gb', 'gbc', 'dmg', 'cgb', 'sgb'] },
    { id: 'gba', name: 'Game Boy Advance', short: 'GBA', maker: 'Nintendo', color: '#5c6bc0', exts: ['gba', 'agb'], bios: [['gba_bios.bin', 'GBA BIOS', false]] },
    { id: 'nds', name: 'Nintendo DS', short: 'DS', maker: 'Nintendo', color: '#78909c', exts: ['nds', 'dsi'], bios: [['bios7.bin', 'ARM7 BIOS', false], ['bios9.bin', 'ARM9 BIOS', false], ['firmware.bin', 'Firmware', false]] },
    { id: 'vb', name: 'Virtual Boy', short: 'VB', maker: 'Nintendo', color: '#b71c1c', exts: ['vb', 'vboy'] },
    { id: 'psx', name: 'PlayStation', short: 'PS1', maker: 'Sony', color: '#546e7a', exts: ['pbp', 'ccd', 'toc'], disc: true,
      bios: [['scph5501.bin', 'US BIOS (SCPH-5501)', false], ['scph5500.bin', 'Japan BIOS (SCPH-5500)', false], ['scph5502.bin', 'Europe BIOS (SCPH-5502)', false]],
      note: 'Runs without a BIOS, but some games need one. CHD files are smallest; for .bin + .cue, add both files together.' },
    { id: 'psp', name: 'PlayStation Portable', short: 'PSP', maker: 'Sony', color: '#37474f', exts: ['cso'], disc: true, threads: true,
      note: 'Needs its own browser tab (for multi-threading), and a fast computer.' },
    { id: 'segaMS', name: 'Master System', short: 'SMS', maker: 'Sega', color: '#e53935', exts: ['sms'] },
    { id: 'segaMD', name: 'Genesis / Mega Drive', short: 'GEN', maker: 'Sega', color: '#212121', exts: ['md', 'gen', 'smd', 'sg'] },
    { id: 'segaGG', name: 'Game Gear', short: 'GG', maker: 'Sega', color: '#263238', exts: ['gg'] },
    { id: 'segaCD', name: 'Sega CD', short: 'SCD', maker: 'Sega', color: '#424242', exts: [], disc: true,
      bios: [['bios_CD_U.bin', 'US BIOS', true], ['bios_CD_E.bin', 'Europe BIOS', false], ['bios_CD_J.bin', 'Japan BIOS', false]] },
    { id: 'sega32x', name: 'Sega 32X', short: '32X', maker: 'Sega', color: '#c62828', exts: ['32x'] },
    { id: 'segaSaturn', name: 'Sega Saturn', short: 'SAT', maker: 'Sega', color: '#455a64', exts: [], disc: true, bios: [['saturn_bios.bin', 'Saturn BIOS', false]] },
    { id: 'pce', name: 'PC Engine / TurboGrafx-16', short: 'PCE', maker: 'NEC', color: '#f57c00', exts: ['pce', 'sgx'], bios: [['syscard3.pce', 'CD System Card 3 (CD games)', false]] },
    { id: 'pcfx', name: 'PC-FX', short: 'PCFX', maker: 'NEC', color: '#6d4c41', exts: [], disc: true, bios: [['pcfx.rom', 'PC-FX BIOS', true]] },
    { id: 'ngp', name: 'Neo Geo Pocket', short: 'NGP', maker: 'SNK', color: '#0277bd', exts: ['ngp', 'ngc'] },
    { id: 'ws', name: 'WonderSwan', short: 'WS', maker: 'Bandai', color: '#00838f', exts: ['ws', 'wsc'] },
    { id: 'atari2600', name: 'Atari 2600', short: '2600', maker: 'Atari', color: '#8d6e63', exts: ['a26'] },
    { id: 'atari5200', name: 'Atari 5200', short: '5200', maker: 'Atari', color: '#795548', exts: ['a52'], bios: [['5200.rom', 'Atari 5200 BIOS', true]] },
    { id: 'atari7800', name: 'Atari 7800', short: '7800', maker: 'Atari', color: '#a1887f', exts: ['a78'] },
    { id: 'lynx', name: 'Atari Lynx', short: 'LNX', maker: 'Atari', color: '#ff7043', exts: ['lnx', 'lyx', 'o'], bios: [['lynxboot.img', 'Lynx boot ROM', true]] },
    { id: 'jaguar', name: 'Atari Jaguar', short: 'JAG', maker: 'Atari', color: '#bf360c', exts: ['j64', 'jag', 'abs', 'cof'] },
    { id: 'coleco', name: 'ColecoVision', short: 'CV', maker: 'Coleco', color: '#1565c0', exts: ['col', 'cv'], bios: [['colecovision.rom', 'ColecoVision BIOS', true]] },
    { id: '3do', name: '3DO', short: '3DO', maker: 'Panasonic', color: '#6a1b9a', exts: [], disc: true, bios: [['panafz10.bin', 'Panasonic FZ-10 BIOS', true]] },
    { id: 'arcade', name: 'Arcade (FinalBurn Neo)', short: 'ARC', maker: 'Arcade', color: '#f9a825', exts: [], note: 'Add the game’s ROM set .zip with its original name (e.g. sf2.zip).' },
    { id: 'mame', name: 'Arcade (MAME 2003+)', short: 'MAME', maker: 'Arcade', color: '#ef6c00', exts: [], note: 'Add the MAME 0.78 ROM set .zip with its original name.' },
    { id: 'c64', name: 'Commodore 64', short: 'C64', maker: 'Commodore', color: '#5d4037', exts: ['d64', 't64', 'prg', 'crt', 'tap', 'g64', 'x64'] },
    { id: 'amiga', name: 'Amiga', short: 'AMI', maker: 'Commodore', color: '#e64a19', exts: ['adf', 'hdf', 'ipf', 'dms', 'lha'], bios: [['kick34005.A500', 'Kickstart 1.3 (A500)', false]] },
    { id: 'dos', name: 'MS-DOS', short: 'DOS', maker: 'PC', color: '#455a64', exts: ['exe', 'com', 'bat', 'conf'], threads: true, note: 'Add the game as a .zip of its folder. Needs its own browser tab.' }
  ];
  var BY_ID = {}; SYSTEMS.forEach(function (s) { BY_ID[s.id] = s; });
  // extensions several consoles share: Imitator asks which one the game is for
  var SHARED = {
    zip: ['arcade', 'mame', 'dos', 'nes', 'snes', 'gba', 'segaMD', 'psx'], '7z': ['arcade', 'nes', 'snes', 'gba', 'segaMD', 'psx'],
    bin: ['psx', 'segaMD', 'atari2600', 'segaCD', 'segaSaturn', 'pce', '3do'], iso: ['psx', 'psp', 'segaCD', 'segaSaturn', 'pce', 'pcfx', '3do'],
    cue: ['psx', 'segaCD', 'segaSaturn', 'pce', 'pcfx', '3do'], chd: ['psx', 'segaCD', 'segaSaturn', 'pce', 'pcfx', '3do', 'psp'],
    img: ['psx', 'segaCD', 'segaSaturn'], m3u: ['psx', 'segaCD', 'segaSaturn', 'pce'], pbp: ['psx', 'psp'], elf: ['psp'], gdi: []
  };
  // consoles too demanding for a browser tab: play them on your own PC and stream it to Panes
  var PC = [
    { name: 'PlayStation 2', app: 'PCSX2', url: 'https://pcsx2.net', color: '#1e3a8a' },
    { name: 'PlayStation 3', app: 'RPCS3', url: 'https://rpcs3.net', color: '#111827' },
    { name: 'GameCube & Wii', app: 'Dolphin', url: 'https://dolphin-emu.org', color: '#4c1d95' },
    { name: 'Xbox', app: 'xemu', url: 'https://xemu.app', color: '#14532d' },
    { name: 'Xbox 360', app: 'Xenia', url: 'https://xenia.jp', color: '#166534' },
    { name: 'Wii U', app: 'Cemu', url: 'https://cemu.info', color: '#0e7490' },
    { name: 'PlayStation Vita', app: 'Vita3K', url: 'https://vita3k.org', color: '#1d4ed8' }
  ];

  /* ---------------------------------------------------------------- helpers */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function ext(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function stem(name) { return String(name || '').replace(/\.[a-z0-9]+$/i, ''); }
  function nice(name) { return stem(name).replace(/[_]+/g, ' ').replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim() || name; }
  function fmtSize(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function ago(t) { if (!t) return 'Never played'; var s = (Date.now() - t) / 1000; if (s < 60) return 'Played just now'; if (s < 3600) return 'Played ' + Math.round(s / 60) + ' min ago'; if (s < 86400) return 'Played ' + Math.round(s / 3600) + ' h ago'; return 'Played ' + Math.round(s / 86400) + ' days ago'; }
  function toast(t) { var x = el('div', 'im-toast', t); document.body.appendChild(x); setTimeout(function () { x.classList.add('out'); }, 2600); setTimeout(function () { x.remove(); }, 3100); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  var inPanes = window.parent !== window;
  function tellPanes(msg) { if (inPanes) try { window.parent.postMessage(Object.assign({ imitator: 1 }, msg), '*'); } catch (e) {} }

  /* ---------------------------------------------------------------- storage (IndexedDB) */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('imitator', 1);
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('games', { keyPath: 'id' }); d.createObjectStore('files'); d.createObjectStore('bios'); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error('Storage full')); };
      });
    });
  }
  var games = {
    all: function () { return tx('games', 'readonly', function (s) { return s.getAll(); }); },
    get: function (id) { return tx('games', 'readonly', function (s) { return s.get(id); }); },
    put: function (g) { return tx('games', 'readwrite', function (s) { s.put(g); }); },
    del: function (id) { return tx('games', 'readwrite', function (s) { s.delete(id); }).then(function () { return tx('files', 'readwrite', function (s) { s.delete(id); }); }); },
    file: function (id) { return tx('files', 'readonly', function (s) { return s.get(id); }); },
    putFile: function (id, blob) { return tx('files', 'readwrite', function (s) { s.put(blob, id); }); }
  };
  var bios = {
    all: function () { return tx('bios', 'readonly', function (s) { var o = {}, c = s.openCursor(); c.onsuccess = function () { var r = c.result; if (r) { o[r.key] = r.value; r.continue(); } }; return { get result() { return o; } }; }); },
    put: function (key, blob) { return tx('bios', 'readwrite', function (s) { s.put(blob, key); }); },
    del: function (key) { return tx('bios', 'readwrite', function (s) { s.delete(key); }); }
  };
  function askPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} }

  /* ---------------------------------------------------------------- tiny ZIP writer (stored, no compression)
     Used to give BIOS files their exact names, and to keep .cue + .bin (multi-file discs) together. */
  var CRC = (function () { var t = new Int32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  function crc32(blob, onProgress) {
    var crc = -1, pos = 0, CH = 8 << 20;
    function step() {
      if (pos >= blob.size) return Promise.resolve((crc ^ -1) >>> 0);
      return blob.slice(pos, pos + CH).arrayBuffer().then(function (buf) {
        var b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) crc = CRC[(crc ^ b[i]) & 255] ^ (crc >>> 8);
        pos += b.length; if (onProgress) onProgress(pos / blob.size); return step();
      });
    }
    return step();
  }
  function zipStore(files, onProgress) {   // files: [{ name, blob }]
    var parts = [], central = [], offset = 0, done = 0, total = files.reduce(function (n, f) { return n + f.blob.size; }, 0) || 1;
    return files.reduce(function (p, f) {
      return p.then(function () {
        return crc32(f.blob, function (r) { if (onProgress) onProgress((done + r * f.blob.size) / total); }).then(function (crc) {
          done += f.blob.size;
          var name = new TextEncoder().encode(f.name), size = f.blob.size;
          if (size >= 0xffffffff) throw new Error(f.name + ' is too big to pack (over 4 GB).');
          var h = new DataView(new ArrayBuffer(30));
          h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
          h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
          var c = new DataView(new ArrayBuffer(46));
          c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
          c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
          parts.push(h.buffer, name, f.blob); central.push(c.buffer, name);
          offset += 30 + name.length + size;
        });
      });
    }, Promise.resolve()).then(function () {
      var cdSize = central.reduce(function (n, x) { return n + (x.byteLength !== undefined ? x.byteLength : x.length); }, 0);
      var e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
      return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
    });
  }

  /* ---------------------------------------------------------------- adding games */
  function guess(fileName) {
    var x = ext(fileName); if (!x) return [];
    if (SHARED[x]) return SHARED[x].slice();
    var hits = SYSTEMS.filter(function (s) { return s.exts.indexOf(x) >= 0; }).map(function (s) { return s.id; });
    return hits;
  }
  // A selection with a .cue/.m3u/.gdi/.ccd becomes one game (zipped together); everything else is one game per file.
  function groupFiles(list) {
    var files = Array.prototype.slice.call(list), sheets = files.filter(function (f) { return /\.(cue|m3u|gdi|ccd)$/i.test(f.name); }), groups = [];
    var used = {};
    sheets.forEach(function (sheet) {
      var base = stem(sheet.name).toLowerCase().replace(/\s*\((disc|disk|cd) ?\d+\)/, '');
      var mates = files.filter(function (f) { return f !== sheet && !/\.(cue|m3u|gdi|ccd)$/i.test(f.name) && (stem(f.name).toLowerCase().indexOf(base) === 0 || sheets.length === 1); });
      groups.push({ name: sheet.name, files: [sheet].concat(mates) }); used[sheet.name] = 1; mates.forEach(function (m) { used[m.name] = 1; });
    });
    files.forEach(function (f) { if (!used[f.name]) groups.push({ name: f.name, files: [f] }); });
    return groups;
  }
  function addFiles(list) {
    var groups = groupFiles(list); if (!groups.length) return;
    askPersist();
    var queue = groups.slice(), added = 0, sysForAll = null;
    function next() {
      var g = queue.shift();
      if (!g) { if (added) { toast('Added ' + added + ' game' + (added > 1 ? 's' : '')); render(); } return; }
      var cands = guess(g.name);
      if (cands.length === 1 && !(g.files.length > 1 && false)) return save(g, cands[0]);
      if (sysForAll && (!cands.length || cands.indexOf(sysForAll) >= 0)) return save(g, sysForAll);
      pickSystem(g.name, cands, queue.length).then(function (r) { if (!r) return next(); if (r.all) sysForAll = r.id; save(g, r.id); });
    }
    function save(g, sys) {
      var prog = progress('Adding ' + nice(g.name) + '…');
      var make = g.files.length > 1 ? zipStore(g.files.map(function (f) { return { name: f.name, blob: f }; }), prog.set) : Promise.resolve(g.files[0]);
      make.then(function (blob) {
        var id = uid(), fileName = g.files.length > 1 ? stem(g.name) + '.zip' : g.name;
        var rec = { id: id, name: nice(g.name), file: fileName, system: sys, size: blob.size, added: Date.now(), played: 0, plays: 0 };
        return games.putFile(id, blob).then(function () { return games.put(rec); }).then(function () { added++; });
      }).catch(function (e) { toast(/quota|full|space/i.test(String(e && (e.name + e.message))) ? 'Not enough storage space for ' + nice(g.name) : 'Couldn’t add ' + nice(g.name) + ': ' + (e && e.message || e)); })
        .then(function () { prog.done(); next(); });
    }
    next();
  }
  function progress(text) {
    var box = el('div', 'im-prog'), t = el('span', null, text), bar = el('i'); box.appendChild(t); box.appendChild(el('b')).appendChild(bar); document.body.appendChild(box);
    return { set: function (r) { bar.style.width = Math.round(r * 100) + '%'; }, done: function () { box.remove(); } };
  }

  /* ---------------------------------------------------------------- dialogs */
  function modal(build) {
    var bg = el('div', 'im-modal'), box = el('div', 'im-dlg'); bg.appendChild(box); document.body.appendChild(bg);
    function close() { bg.remove(); document.removeEventListener('keydown', key, true); }
    function key(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); if (box.onCancel) box.onCancel(); } }
    document.addEventListener('keydown', key, true);
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) { close(); if (box.onCancel) box.onCancel(); } });
    build(box, close); return close;
  }
  function pickSystem(fileName, cands, more) {
    return new Promise(function (resolve) {
      modal(function (box, close) {
        box.onCancel = function () { resolve(null); };
        box.appendChild(el('h3', null, 'Which console is this for?'));
        box.appendChild(el('p', 'im-muted', fileName));
        var list = el('div', 'im-syspick'), chosen = null, all = null;
        var show = cands.length ? cands.map(function (id) { return BY_ID[id]; }) : SYSTEMS;
        show.forEach(function (s) {
          var b = el('button', 'im-sysbtn'); b.style.setProperty('--c', s.color);
          b.appendChild(el('b', null, s.short)); b.appendChild(el('span', null, s.name));
          b.onclick = function () { chosen = s.id; close(); resolve({ id: chosen, all: all && all.checked }); };
          list.appendChild(b);
        });
        box.appendChild(list);
        if (cands.length) { var other = el('button', 'im-link', 'Another console…'); other.onclick = function () { close(); pickSystem(fileName, [], more).then(resolve); }; box.appendChild(other); }
        if (more) { var lab = el('label', 'im-chk'); all = el('input'); all.type = 'checkbox'; lab.appendChild(all); lab.appendChild(el('span', null, 'Use this for the other ' + more + ' file' + (more > 1 ? 's' : '') + ' too')); box.appendChild(lab); }
        var skip = el('button', 'im-btn ghost', 'Skip this file'); skip.onclick = function () { close(); resolve(null); };
        box.appendChild(skip);
      });
    });
  }
  function confirmBox(title, text, okText) {
    return new Promise(function (resolve) {
      modal(function (box, close) {
        box.onCancel = function () { resolve(false); };
        box.appendChild(el('h3', null, title)); box.appendChild(el('p', 'im-muted', text));
        var row = el('div', 'im-row end'), no = el('button', 'im-btn ghost', 'Cancel'), yes = el('button', 'im-btn danger', okText || 'OK');
        no.onclick = function () { close(); resolve(false); }; yes.onclick = function () { close(); resolve(true); };
        row.appendChild(no); row.appendChild(yes); box.appendChild(row);
      });
    });
  }
  function promptBox(title, value) {
    return new Promise(function (resolve) {
      modal(function (box, close) {
        box.onCancel = function () { resolve(null); };
        box.appendChild(el('h3', null, title));
        var inp = el('input', 'im-in'); inp.value = value || ''; box.appendChild(inp);
        var row = el('div', 'im-row end'), no = el('button', 'im-btn ghost', 'Cancel'), yes = el('button', 'im-btn acc', 'Save');
        no.onclick = function () { close(); resolve(null); }; yes.onclick = function () { close(); resolve(inp.value.trim()); };
        inp.onkeydown = function (e) { if (e.key === 'Enter') yes.onclick(); };
        row.appendChild(no); row.appendChild(yes); box.appendChild(row); setTimeout(function () { inp.focus(); inp.select(); }, 0);
      });
    });
  }

  /* ---------------------------------------------------------------- library */
  var view = { page: 'all', q: '' }, app = document.getElementById('app'), cache = [];
  function pickFiles() {
    var i = el('input'); i.type = 'file'; i.multiple = true; i.style.display = 'none';
    i.onchange = function () { addFiles(i.files); i.remove(); }; document.body.appendChild(i); i.click();
  }
  function render() {
    games.all().then(function (list) { cache = list || []; draw(); }, function () {
      cache = []; draw();
      toast('This browser is blocking storage for Imitator, so games can’t be kept. Allow site data (third-party cookies) for this server, or open Imitator in its own tab.');
    });
  }
  function draw() {
    app.textContent = ''; app.className = 'im';
    var side = el('nav', 'im-side'), main = el('main', 'im-main');
    var brand = el('div', 'im-brand'), logo = el('img'); logo.src = 'logo.png'; logo.alt = ''; brand.appendChild(logo); brand.appendChild(el('b', null, 'Imitator'));
    side.appendChild(brand);
    function nav(id, icon, label, count) {
      var b = el('button', 'im-nav' + (view.page === id ? ' on' : '')); b.appendChild(el('span', 'im-ni', icon)); b.appendChild(el('span', 'im-nl', label));
      if (count) b.appendChild(el('small', null, String(count)));
      b.onclick = function () { view.page = id; draw(); }; side.appendChild(b);
    }
    nav('all', '🎮', 'All games', cache.length);
    nav('recent', '🕘', 'Recently played');
    var used = {}; cache.forEach(function (g) { used[g.system] = (used[g.system] || 0) + 1; });
    var sysIds = SYSTEMS.filter(function (s) { return used[s.id]; });
    if (sysIds.length) { side.appendChild(el('div', 'im-cat', 'Consoles')); sysIds.forEach(function (s) { nav('sys:' + s.id, '', s.name, used[s.id]); side.lastChild.querySelector('.im-ni').appendChild(dot(s)); }); }
    side.appendChild(el('div', 'im-cat', 'More'));
    nav('bios', '🧩', 'BIOS files');
    nav('pc', '🖥️', 'Play on your PC');
    nav('systems', '📋', 'Supported consoles');
    app.appendChild(side); app.appendChild(main);
    if (view.page === 'bios') return drawBios(main);
    if (view.page === 'pc') return drawPc(main);
    if (view.page === 'systems') return drawSystems(main);
    drawGames(main);
  }
  function dot(s) { var d = el('i', 'im-dot'); d.style.background = s.color; return d; }
  function header(main, title, sub) {
    var h = el('header', 'im-head'), t = el('div'); t.appendChild(el('h1', null, title)); if (sub) t.appendChild(el('p', 'im-muted', sub)); h.appendChild(t); main.appendChild(h); return h;
  }
  function drawGames(main) {
    var sys = view.page.indexOf('sys:') === 0 ? BY_ID[view.page.slice(4)] : null;
    var h = header(main, sys ? sys.name : view.page === 'recent' ? 'Recently played' : 'Your games', sys ? sys.maker : 'Games stay in this browser. Nothing is uploaded.');
    var tools = el('div', 'im-tools'), q = el('input', 'im-search'); q.placeholder = 'Search'; q.value = view.q;
    q.oninput = function () { view.q = q.value; fill(); };
    var add = el('button', 'im-btn acc', '+ Add games'); add.onclick = pickFiles;
    tools.appendChild(q); tools.appendChild(add); h.appendChild(tools);
    var grid = el('div', 'im-grid'); main.appendChild(grid);
    function fill() {
      grid.textContent = '';
      var list = cache.filter(function (g) { return (!sys || g.system === sys.id) && (view.page !== 'recent' || g.played) && (!view.q || g.name.toLowerCase().indexOf(view.q.toLowerCase()) >= 0); });
      list.sort(view.page === 'recent' ? function (a, b) { return b.played - a.played; } : function (a, b) { return a.name.localeCompare(b.name); });
      if (!list.length) {
        var empty = el('div', 'im-empty');
        if (!cache.length) {
          var big = el('img'); big.src = 'logo.png'; big.alt = ''; empty.appendChild(big);
          empty.appendChild(el('h2', null, 'Add your games to start playing'));
          empty.appendChild(el('p', null, 'Drop ROM or disc files anywhere here, or pick them. Imitator plays NES, SNES, N64, Game Boy, GBA, DS, PlayStation, PSP, Sega, Atari, arcade and more. Only use games you own.'));
          var b = el('button', 'im-btn acc big', 'Choose game files'); b.onclick = pickFiles; empty.appendChild(b);
        } else empty.appendChild(el('p', null, view.q ? 'No games match “' + view.q + '”.' : 'Nothing here yet.'));
        grid.appendChild(empty); return;
      }
      list.forEach(function (g) { grid.appendChild(card(g)); });
    }
    fill();
  }
  function card(g) {
    var s = BY_ID[g.system] || { short: '?', name: g.system, color: '#555' }, c = el('div', 'im-card');
    var art = el('button', 'im-art'); art.style.setProperty('--c', s.color); art.title = 'Play ' + g.name;
    art.appendChild(el('span', 'im-badge', s.short)); art.appendChild(el('span', 'im-title', g.name)); art.appendChild(el('span', 'im-play', '▶'));
    art.onclick = function () { play(g.id); };
    c.appendChild(art);
    var info = el('div', 'im-info'), t = el('div'); t.appendChild(el('b', null, g.name)); t.appendChild(el('small', null, s.name + ' · ' + fmtSize(g.size) + ' · ' + ago(g.played)));
    info.appendChild(t);
    var more = el('button', 'im-more', '⋯'); more.title = 'More'; more.onclick = function (e) { e.stopPropagation(); menu(more, g); };
    info.appendChild(more); c.appendChild(info);
    return c;
  }
  function menu(anchor, g) {
    document.querySelectorAll('.im-pop').forEach(function (p) { p.remove(); });
    var m = el('div', 'im-pop'), r = anchor.getBoundingClientRect();
    function item(t, fn, cls) { var b = el('button', cls || '', t); b.onclick = function () { m.remove(); fn(); }; m.appendChild(b); }
    item('▶ Play', function () { play(g.id); });
    item('Rename', function () { promptBox('Rename', g.name).then(function (n) { if (n) { g.name = n; games.put(g).then(render); } }); });
    item('Change console', function () { pickSystem(g.file, [], 0).then(function (r) { if (r) { g.system = r.id; games.put(g).then(render); } }); });
    item('Download file', function () { games.file(g.id).then(function (b) { var a = el('a'); a.href = URL.createObjectURL(b); a.download = g.file; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000); }); });
    item('Remove', function () { confirmBox('Remove ' + g.name + '?', 'The game file is deleted from this browser. Its save data is kept.', 'Remove').then(function (ok) { if (ok) games.del(g.id).then(render); }); }, 'danger');
    m.style.top = Math.min(window.innerHeight - 220, r.bottom + 4) + 'px'; m.style.left = Math.max(8, Math.min(window.innerWidth - 200, r.right - 190)) + 'px';
    document.body.appendChild(m);
    setTimeout(function () { document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }); }, 0);
  }

  function drawBios(main) {
    header(main, 'BIOS files', 'Some consoles need the system software from your own console. Files stay in this browser.');
    var list = el('div', 'im-bios'); main.appendChild(list);
    bios.all().then(function (have) {
      SYSTEMS.filter(function (s) { return s.bios; }).forEach(function (s) {
        var box = el('section', 'im-bsys'), h = el('div', 'im-bh'); h.appendChild(dot(s)); h.appendChild(el('b', null, s.name));
        var need = s.bios.some(function (b) { return b[2]; }); h.appendChild(el('small', null, need ? 'Required' : 'Optional')); box.appendChild(h);
        s.bios.forEach(function (b) {
          var key = s.id + '/' + b[0], row = el('div', 'im-brow'), got = have[key];
          var t = el('div'); t.appendChild(el('span', null, b[1])); t.appendChild(el('code', null, b[0])); row.appendChild(t);
          row.appendChild(el('small', got ? 'ok' : (b[2] ? 'miss' : ''), got ? '✓ ' + fmtSize(got.size) : b[2] ? 'Missing' : 'Not added'));
          var btn = el('button', 'im-btn', got ? 'Replace' : 'Add');
          btn.onclick = function () {
            var i = el('input'); i.type = 'file'; i.onchange = function () { var f = i.files[0]; if (f) bios.put(key, f).then(function () { toast(b[0] + ' added'); draw(); }); }; i.click();
          };
          row.appendChild(btn);
          if (got) { var del = el('button', 'im-btn ghost', 'Remove'); del.onclick = function () { bios.del(key).then(draw); }; row.appendChild(del); }
          box.appendChild(row);
        });
        list.appendChild(box);
      });
    });
  }
  function drawPc(main) {
    header(main, 'Play on your PC', 'PlayStation 2 and 3, Xbox, Xbox 360, GameCube, Wii and Wii U need far more power than a browser tab can give, so no web emulator can run them. Run the emulator on your own PC and stream it into Panes instead.');
    var how = el('ol', 'im-how');
    ['Install the emulator for your console on your PC (links below) and set it up with your own games and console files.',
      'In Panes, open Mist › My PC and pair your PC with Mist PC Connect (a supporter perk).',
      'Start your PC from Panes and play, with your keyboard, mouse or controller.'].forEach(function (t) { how.appendChild(el('li', null, t)); });
    main.appendChild(how);
    var go = el('button', 'im-btn acc', '🖥️ Open Mist PC Connect'); go.onclick = function () { if (inPanes) tellPanes({ open: 'mistpc' }); else toast('Open Imitator inside Panes to use Mist PC Connect'); };
    if (inPanes) main.appendChild(go);
    var grid = el('div', 'im-pcgrid'); main.appendChild(grid);
    PC.forEach(function (p) {
      var c = el('div', 'im-pc'); c.style.setProperty('--c', p.color);
      c.appendChild(el('b', null, p.name)); c.appendChild(el('span', null, 'Emulator: ' + p.app));
      var a = el('button', 'im-btn', 'Get ' + p.app); a.onclick = function () { if (inPanes) tellPanes({ gleam: p.url }); else window.open(p.url, '_blank', 'noopener'); };
      c.appendChild(a); grid.appendChild(c);
    });
  }
  function drawSystems(main) {
    header(main, 'Supported consoles', 'Imitator runs these right here in the browser. Add a game and Imitator picks the console from the file type, or asks.');
    var t = el('div', 'im-systable');
    SYSTEMS.forEach(function (s) {
      var r = el('div', 'im-sysrow'); r.appendChild(dot(s));
      var a = el('div'); a.appendChild(el('b', null, s.name));
      var files = s.exts.concat(Object.keys(SHARED).filter(function (x) { return SHARED[x].indexOf(s.id) >= 0; }));
      a.appendChild(el('small', null, (files.length ? '.' + files.join(' .') : '') + (s.bios ? ' · BIOS ' + (s.bios.some(function (b) { return b[2]; }) ? 'required' : 'optional') : '') + (s.note ? ' · ' + s.note : '')));
      r.appendChild(a); t.appendChild(r);
    });
    main.appendChild(t);
  }

  /* ---------------------------------------------------------------- playing */
  function play(id) { location.search = '?play=' + encodeURIComponent(id); }
  function startPlayer(id) {
    app.className = 'im im-playing'; app.textContent = '';
    var bar = el('div', 'im-pbar'), back = el('button', 'im-btn ghost', '← Library'), title = el('b'), sub = el('small');
    back.onclick = function () { leave(); };
    bar.appendChild(back); bar.appendChild(title); bar.appendChild(sub); app.appendChild(bar);
    var stage = el('div', 'im-stage'), host = el('div'); host.id = 'game'; stage.appendChild(host); app.appendChild(stage);
    function fail(t, extra) {
      stage.textContent = ''; var e = el('div', 'im-empty'); e.appendChild(el('h2', null, extra ? 'Opens in its own tab' : 'Can’t start this game')); e.appendChild(el('p', null, t));
      var row = el('div', 'im-row'); if (extra) row.appendChild(extra);
      var b = el('button', 'im-btn' + (extra ? ' ghost' : ' acc'), 'Back to library'); b.onclick = leave; row.appendChild(b); e.appendChild(row); stage.appendChild(e);
    }
    Promise.all([games.get(id), games.file(id), bios.all()]).then(function (r) {
      var g = r[0], blob = r[1], have = r[2];
      if (!g || !blob) return fail('This game isn’t in your library any more.');
      var s = BY_ID[g.system] || { name: g.system };
      title.textContent = g.name; sub.textContent = s.name; document.title = g.name + ' · Imitator'; tellPanes({ title: g.name });
      if (s.threads && !window.crossOriginIsolated) {
        var tab = el('button', 'im-btn acc', 'Open Imitator in a new tab'); tab.onclick = function () { window.open(location.pathname, '_blank'); };
        return fail(s.name + ' games need multi-threading, which browsers only allow in a tab of their own. Open Imitator in a new tab and add the game there (that tab keeps its own library).', inPanes ? tab : null);
      }
      var files = (s.bios || []).filter(function (b) { return have[g.system + '/' + b[0]]; }).map(function (b) { return { name: b[0], blob: have[g.system + '/' + b[0]] }; });
      var missing = (s.bios || []).filter(function (b) { return b[2] && !have[g.system + '/' + b[0]]; });
      if (missing.length && !files.length) return fail(s.name + ' needs a BIOS file from your own console (' + missing.map(function (b) { return b[0]; }).join(', ') + '). Add it under BIOS files.');
      (files.length ? zipStore(files) : Promise.resolve(null)).then(function (biosZip) {
        g.played = Date.now(); g.plays = (g.plays || 0) + 1; games.put(g);
        window.EJS_player = '#game';
        window.EJS_core = g.system;
        window.EJS_gameName = g.file;                 // the core picks the format from the extension
        window.EJS_gameUrl = URL.createObjectURL(blob);
        if (biosZip) window.EJS_biosUrl = URL.createObjectURL(biosZip);
        window.EJS_pathtodata = 'data/';
        window.EJS_startOnLoaded = true;
        window.EJS_color = '#ff5a5a';
        window.EJS_backgroundColor = '#0b0d12';
        window.EJS_CacheLimit = 0;                    // the game is already stored; don't keep a second copy
        window.EJS_threads = !!(s.threads && window.crossOriginIsolated);
        window.EJS_defaultOptions = { 'save-save-interval': '30' };   // in-game saves are written every 30 s too
        window.EJS_gameID = 0;
        window.EJS_onGameStart = function () { tellPanes({ started: 1 }); };
        var sc = document.createElement('script'); sc.src = 'data/loader.js'; sc.onerror = function () { fail('The emulator files didn’t load. The Panes server may need Imitator set up (server/imitator-setup.sh).'); };
        document.body.appendChild(sc);
      }, function (e) { fail('Couldn’t read your BIOS files: ' + e.message); });
    }, function (e) { fail('Couldn’t open your library: ' + (e && e.message || e)); });
  }
  // save the game's own save data before leaving (closing the window doesn't give the emulator a chance)
  function saveNow() {
    return new Promise(function (resolve) {
      try { var E = window.EJS_emulator; if (E && E.started && E.gameManager) { E.gameManager.saveSaveFiles(); setTimeout(resolve, 600); return; } } catch (e) {}
      resolve();
    });
  }
  function leave() { saveNow().then(function () { location.search = ''; }); }
  window.addEventListener('message', function (e) {
    var d = e.data || {}; if (!d || !d.panes) return;
    if (d.panes === 'save') saveNow().then(function () { tellPanes({ saved: 1 }); });
  });
  window.addEventListener('pagehide', function () { try { var E = window.EJS_emulator; if (E && E.started) E.gameManager.saveSaveFiles(); } catch (e) {} });

  /* ---------------------------------------------------------------- drag and drop */
  var dragN = 0;
  document.addEventListener('dragenter', function (e) { if (app.classList.contains('im-playing')) return; if (hasFiles(e)) { dragN++; document.body.classList.add('im-drop'); } });
  document.addEventListener('dragleave', function () { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('im-drop'); } });
  document.addEventListener('dragover', function (e) { if (hasFiles(e) && !app.classList.contains('im-playing')) e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    if (app.classList.contains('im-playing')) return;
    dragN = 0; document.body.classList.remove('im-drop');
    if (hasFiles(e)) { e.preventDefault(); addFiles(e.dataTransfer.files); }
  });
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return t && Array.prototype.indexOf.call(t, 'Files') >= 0; }

  var q = new URLSearchParams(location.search);
  if (q.get('play')) startPlayer(q.get('play')); else { tellPanes({ title: 'Imitator' }); render(); }
})();

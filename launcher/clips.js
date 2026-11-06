/* Mist — instant replay clips.
 * While a game runs, Mist records the game's canvas in the background. Pressing F8 (or "Save clip"
 * in the Mist overlay) saves the last 30–45 seconds to this browser. Nothing is uploaded.
 *
 * How the rolling buffer works: a video file can't just have its start chopped off, so three
 * recorders run staggered 15 s apart and each restarts every 45 s. At any moment one of them has
 * been running for 30–45 s, and saving a clip finishes that one. Memory stays around 50 MB. */
window.MistClips = function (ctx) {
  'use strict';
  var el = ctx.el, toast = ctx.toast;
  var SEG = 15000, N = 3, LIFE = SEG * N, MAX_CLIPS = 40, KEY = 'F8';
  var cur = null;          // { win, canvas, stream, taps, recs: [], tick, scan, game }
  var TYPE = pickType();

  function supported() {
    return typeof MediaRecorder !== 'undefined' && !!TYPE && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  }
  function enabled() { return ctx.storeGet('clips', 'on') !== 'off'; }
  function pickType() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    var list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return null;
  }
  function ext(type) { return /mp4/.test(type) ? 'mp4' : 'webm'; }

  /* Records sound too: added to the game before it loads, it copies anything a game plays through
   * Web Audio (most HTML5 games) to a stream the recorder can use. */
  var AUDIO_SHIM = '<script>(function(){try{if(!window.AudioNode)return;var o=AudioNode.prototype.connect;' +
    'AudioNode.prototype.connect=function(d){var r=o.apply(this,arguments);try{var c=this.context;if(d&&c&&d===c.destination&&c.createMediaStreamDestination){' +
    'if(!c.__mistTap){c.__mistTap=c.createMediaStreamDestination();(window.__mistTaps=window.__mistTaps||[]).push(c.__mistTap)}o.call(this,c.__mistTap)}}catch(e){}return r}}catch(e){}})();<\/script>';
  function shim() { return enabled() && supported() ? AUDIO_SHIM : ''; }

  /* ---------- finding what to record ---------- */
  function canvasesIn(win, out, depth) {
    var d; try { d = win.document; } catch (e) { return; }
    if (!d) return;
    var cs = d.getElementsByTagName('canvas');
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      if (r.width >= 120 && r.height >= 90) out.push({ c: cs[i], area: r.width * r.height, win: win });
    }
    if (depth < 3) { var fs = d.getElementsByTagName('iframe'); for (var j = 0; j < fs.length; j++) { try { canvasesIn(fs[j].contentWindow, out, depth + 1); } catch (e) {} } }
  }
  function bestCanvas(win) {
    var out = []; canvasesIn(win, out, 0);
    out.sort(function (a, b) { return b.area - a.area; });
    return out[0] ? out[0].c : null;
  }
  function tapsOf(win) { try { return (win.__mistTaps || []).slice(); } catch (e) { return []; } }

  /* ---------- recording ---------- */
  function startRec(r) {
    r.chunks = []; r.mr = null;
    try {
      var mr = new MediaRecorder(cur.stream, { mimeType: TYPE, videoBitsPerSecond: 3000000, audioBitsPerSecond: 128000 });
      mr.ondataavailable = function (e) { if (e.data && e.data.size && r.mr === mr) r.chunks.push(e.data); };
      mr.start(1000);
      r.mr = mr; r.start = Date.now();
    } catch (e) { r.mr = null; }
  }
  function dropRec(r) {
    var mr = r.mr; r.mr = null; r.chunks = [];
    if (mr && mr.state !== 'inactive') { mr.ondataavailable = null; try { mr.stop(); } catch (e) {} }
  }
  function stopAll() {
    if (!cur) return;
    cur.recs.forEach(function (r) { if (!r.saving) dropRec(r); });
  }
  function build() {
    stopAll();
    var c = cur.canvas;
    try { cur.stream = c.captureStream(30); } catch (e) { cur.stream = null; return; }
    var t = cur.taps[0];
    if (t && t.stream) t.stream.getAudioTracks().forEach(function (a) { try { cur.stream.addTrack(a); } catch (e) {} });
    var now = Date.now();
    cur.recs = [];
    for (var i = 0; i < N; i++) cur.recs.push({ due: now + i * SEG, mr: null, chunks: [], start: 0 });
  }
  function scan() {
    if (!cur) return;
    var c = bestCanvas(cur.win), taps = tapsOf(cur.win);
    if (!c) return;
    if (c !== cur.canvas || taps.length !== cur.taps.length) { cur.canvas = c; cur.taps = taps; build(); }
  }
  function tick() {
    if (!cur || !cur.stream) return;
    var now = Date.now();
    cur.recs.forEach(function (r) {
      if (r.saving) return;
      if (!r.mr) { if (now >= r.due) startRec(r); return; }
      if (now - r.start >= LIFE) { dropRec(r); startRec(r); }
    });
  }
  function start(win, game) {
    stop();
    if (!enabled() || !supported() || !win) return;
    cur = { win: win, game: game || 'Game', canvas: null, taps: [], stream: null, recs: [] };
    hookKey(win);
    cur.scan = setInterval(scan, 3000); cur.tick = setInterval(tick, 1000);
    setTimeout(scan, 1500);
  }
  function stop() {
    if (!cur) return;
    clearInterval(cur.scan); clearInterval(cur.tick);
    stopAll();
    cur = null;
  }
  function active() { return !!(cur && cur.stream); }

  /* ---------- saving ---------- */
  function save() {
    if (!enabled()) { toast('Instant replay is off. Turn it on in Settings.'); return; }
    if (!supported()) { toast('This browser can’t record clips.'); return; }
    if (!cur) { toast('Clips work while a game is running.'); return; }
    if (!cur.stream) { toast('Nothing to record yet: this game isn’t drawing to a canvas Mist can see.'); return; }
    var now = Date.now(), best = null;
    cur.recs.forEach(function (r) { if (r.mr && !r.saving && (!best || r.start < best.start)) best = r; });
    if (!best || now - best.start < 2000) { toast('Still warming up. Try again in a few seconds.'); return; }
    var r = best, mr = r.mr, dur = now - r.start, game = cur.game;
    r.saving = true;
    mr.onstop = function () {
      var parts = r.chunks.slice(); r.saving = false; r.mr = null;
      if (cur) startRec(r);
      if (!parts.length) { toast('That clip came out empty.'); return; }
      var blob = new Blob(parts, { type: TYPE.split(';')[0] });
      fixDuration(blob, dur).then(function (b) { return put({ game: game, at: Date.now(), dur: dur, type: b.type, size: b.size, blob: b }); })
        .then(function () { toast('🎬 Clip saved (' + Math.round(dur / 1000) + 's). Find it in Social › Clips.'); },
              function (e) { toast('Couldn’t save the clip: ' + (e && e.message || e)); });
    };
    try { mr.requestData(); } catch (e) {}
    try { mr.stop(); } catch (e) { r.saving = false; toast('Couldn’t save the clip.'); }
  }

  /* MediaRecorder's webm files have no length written in them, so players can't show a seek bar.
   * Write a Duration into the file's Info section. */
  function fixDuration(blob, ms) {
    if (!/webm/.test(blob.type)) return Promise.resolve(blob);
    return blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer().then(function (head) {
      var b = new Uint8Array(head);
      function id(p) { var x = b[p], n = 1, m = 0x80; while (n <= 4 && !(x & m)) { m >>= 1; n++; } var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[p + i]; return { n: n, v: v }; }
      function size(p) { var x = b[p], n = 1, m = 0x80; while (n <= 8 && !(x & m)) { m >>= 1; n++; } var v = x & (m - 1), all = v === m - 1; for (var i = 1; i < n; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 255) all = false; } return { n: n, v: v, unknown: all }; }
      var e = id(0), s = size(e.n), p = e.n + s.n + s.v;
      var seg = id(p); if (seg.v !== 0x18538067) return blob;
      var ss = size(p + seg.n), q = p + seg.n + ss.n;
      while (q < b.length - 8) {
        var el2 = id(q), es = size(q + el2.n), body = q + el2.n + es.n;
        if (el2.v === 0x1549A966) {                          // Info
          if (body + es.v > b.length) return blob;
          for (var r = body; r < body + es.v;) { var ie = id(r), is = size(r + ie.n); if (ie.v === 0x4489) return blob; r += ie.n + is.n + is.v; }
          var dur = new Uint8Array(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; new DataView(dur.buffer).setFloat64(3, ms);
          var sz = new Uint8Array(8), t = es.v + 11; sz[0] = 0x01; for (var k = 7; k >= 1; k--) { sz[k] = t & 255; t = Math.floor(t / 256); }
          return new Blob([blob.slice(0, q + el2.n), sz, blob.slice(body, body + es.v), dur, blob.slice(body + es.v)], { type: blob.type });
        }
        if (el2.v === 0x1F43B675 || es.unknown) return blob;  // reached the video data
        q = body + es.v;
      }
      return blob;
    }).catch(function () { return blob; });
  }

  /* ---------- storage (IndexedDB, this browser only) ---------- */
  var dbp = null;
  function db() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open('mist-clips', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('clips', { keyPath: 'id', autoIncrement: true }); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('clips', mode), st = t.objectStore('clips'), out = fn(st);
        t.oncomplete = function () { res(out && 'result' in out ? out.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error || new Error('Storage error')); };
      });
    });
  }
  function list() { return tx('readonly', function (st) { return st.getAll(); }).then(function (a) { return (a || []).sort(function (x, y) { return y.at - x.at; }); }); }
  function del(id) { return tx('readwrite', function (st) { st.delete(id); }); }
  function put(clip) {
    return tx('readwrite', function (st) { st.add(clip); }).then(list).then(function (all) {
      var extra = all.slice(MAX_CLIPS);
      return Promise.all(extra.map(function (c) { return del(c.id); })).then(function () { if (extra.length) toast('Oldest clip removed (max ' + MAX_CLIPS + ').'); });
    });
  }

  /* ---------- hotkey ---------- */
  function onKey(e) {
    if (e.key !== KEY || e.repeat) return;
    e.preventDefault(); e.stopPropagation(); save();
  }
  function hookKey(win) {
    try { win.addEventListener('keydown', onKey, true); } catch (e) {}
    if (!hookKey.top) { hookKey.top = true; document.addEventListener('keydown', function (e) { if (cur) onKey(e); }, true); }
  }

  /* ---------- gallery (Social › Clips) ---------- */
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function fileName(c) {
    var d = new Date(c.at), pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return (c.game || 'clip').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.' + ext(c.type || '');
  }
  function download(c) {
    var u = URL.createObjectURL(c.blob), a = document.createElement('a');
    a.href = u; a.download = fileName(c); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 10000);
  }
  function play(c) {
    ctx.openModal(function (box) {
      box.classList.add('clip-box');
      box.appendChild(el('h3', null, '🎬 ' + c.game));
      var v = el('video', 'clip-full'); v.controls = true; v.autoplay = true; v.playsInline = true;
      var u = URL.createObjectURL(c.blob); v.src = u; box.appendChild(v);
      box.appendChild(el('p', 'adm-muted', new Date(c.at).toLocaleString() + ' · ' + Math.round(c.dur / 1000) + 's · ' + fmtSize(c.size)));
      var a = el('div', 'm-actions');
      a.appendChild(ctx.button('ghost', 'Close', null, function () { v.pause(); URL.revokeObjectURL(u); ctx.closeModal(); }));
      a.appendChild(ctx.button('green', '⬇ Download', null, function () { download(c); }));
      box.appendChild(a);
    });
  }
  function render(host) {
    host.textContent = '';
    var head = el('div', 'fo-head'); head.appendChild(el('h2', 'soc-h', 'Clips'));
    var tog = ctx.button('', enabled() ? 'Instant replay: on' : 'Instant replay: off', null, function () {
      ctx.storeSet('clips', enabled() ? 'off' : 'on');
      toast(enabled() ? 'Instant replay on for the next game you open' : 'Instant replay off');
      if (!enabled()) stop();
      render(host);
    });
    head.appendChild(tog); host.appendChild(head);
    var info = !supported() ? 'This browser can’t record clips.' :
      'While you play, press ' + KEY + ' (or Save clip in the Mist overlay) to save the last 30–45 seconds. Clips stay in this browser until you download or delete them.';
    host.appendChild(el('p', 'soc-sub', info));
    var grid = el('div', 'clip-grid'); host.appendChild(grid);
    grid.appendChild(el('div', 'fp-empty', 'Loading…'));
    list().then(function (all) {
      grid.textContent = '';
      if (!all.length) { grid.appendChild(el('div', 'fp-empty', 'No clips yet. Start a game and press ' + KEY + ' after something cool happens.')); return; }
      var total = all.reduce(function (n, c) { return n + (c.size || 0); }, 0);
      host.insertBefore(el('p', 'adm-muted', all.length + ' clip' + (all.length === 1 ? '' : 's') + ' · ' + fmtSize(total)), grid);
      all.forEach(function (c) {
        var card = el('div', 'clip-card');
        var th = el('video', 'clip-th'); th.muted = true; th.preload = 'metadata'; th.playsInline = true;
        var u = URL.createObjectURL(c.blob); th.src = u + '#t=0.5';
        card.onmouseenter = function () { try { th.play(); } catch (e) {} };
        card.onmouseleave = function () { th.pause(); };
        var wrap = el('div', 'clip-thw'); wrap.appendChild(th); wrap.appendChild(el('span', 'clip-dur', Math.round(c.dur / 1000) + 's'));
        wrap.onclick = function () { play(c); };
        card.appendChild(wrap);
        var t = el('div', 'clip-t'); t.appendChild(el('b', null, c.game)); t.appendChild(el('small', null, ctx.ago(c.at) + ' · ' + fmtSize(c.size))); card.appendChild(t);
        var bs = el('div', 'clip-btns');
        bs.appendChild(ctx.button('ghost', '⬇', null, function () { download(c); }));
        bs.appendChild(ctx.button('ghost adm-danger', '🗑', null, function () {
          if (!confirm('Delete this clip?')) return;
          del(c.id).then(function () { URL.revokeObjectURL(u); render(host); });
        }));
        card.appendChild(bs); grid.appendChild(card);
      });
    }, function (e) { grid.textContent = ''; grid.appendChild(el('div', 'fp-empty', 'Couldn’t open clip storage: ' + (e && e.message || e))); });
  }

  return { shim: shim, start: start, stop: stop, save: save, active: active, render: render, supported: supported, enabled: enabled, key: KEY };
};

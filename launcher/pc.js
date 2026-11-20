/*!
 * Mist — MY PC (Mist PC Connect, a supporter perk)
 * Stream your own PC into Mist: the Mist PC helper on the PC shares its screen over WebRTC, and Mist sends
 * the mouse and keyboard back. The Mist server pairs PCs with accounts (one-time codes) and passes the
 * connection messages; the video goes directly between the two, or through the server's TURN relay.
 */
(function () {
  'use strict';
  var HELPER_EXE = 'https://github.com/th3nu8/EaglercraftLauncher/releases/download/mistpc/MistPC.exe';

  window.MistPC = function (ctx) {
    var el = ctx.el, toast = ctx.toast;
    var seq = 0, listTimer = null, viewer = null, hostEl = null;
    function eng() { var e = ctx.getEngine(); return e && e.signedIn() ? e : null; }
    function api(method, path, json) { var e = eng(); if (!e) return Promise.reject(new Error('Sign in first.')); return e.api(method, path, json ? { json: json } : {}); }
    function serverBase() { var e = eng(); return e ? e.server.replace(/\/+$/, '') : ''; }
    function ago(t) { return ctx.ago ? ctx.ago(t) : new Date(t).toLocaleString(); }

    /* ================================================================ MY PC page */
    function render(host) {
      hostEl = host || hostEl; if (!hostEl) return;
      clearTimeout(listTimer);
      var my = ++seq;
      hostEl.textContent = '';
      var head = el('div', 'users-head'); head.appendChild(el('h2', null, 'My PC'));
      head.appendChild(el('span', 'pc-perk', '💛 Supporter perk'));
      hostEl.appendChild(head);
      var intro = el('p', 'pc-intro', 'Play what’s on your own computer from anywhere Mist runs. Mist PC streams your PC’s screen and sound here, and your mouse and keyboard go back to it — so games that only run on a PC (like Roblox) work on a Chromebook or another computer.');
      hostEl.appendChild(intro);
      if (!eng()) {
        var e0 = el('div', 'fp-empty'); e0.appendChild(el('p', null, 'Sign in to use Mist PC.'));
        var b0 = el('button', 'btn green', 'Sign in'); b0.onclick = function () { ctx.openAuth('login'); }; e0.appendChild(b0); hostEl.appendChild(e0); return;
      }
      var body = el('div', 'pc-body'); body.appendChild(el('div', 'fp-empty', 'Loading…')); hostEl.appendChild(body);
      api('GET', '/api/pc/devices').then(function (r) {
        if (my !== seq) return;
        body.textContent = '';
        if (!r.supporter) return upsell(body, r.devices || []);
        var bar = el('div', 'pc-bar');
        bar.appendChild(ctx.button('green', '+ Add a PC', null, openAdd));
        body.appendChild(bar);
        if (!r.devices.length) {
          var em = el('div', 'pc-empty');
          em.appendChild(el('div', 'pc-empty-ico', '🖥️'));
          em.appendChild(el('b', null, 'No PCs yet'));
          em.appendChild(el('p', null, 'Press “Add a PC”, install Mist PC on the computer you want to play from, and type in the code it shows.'));
          body.appendChild(em);
        }
        var list = el('div', 'pc-list');
        r.devices.forEach(function (d) { list.appendChild(pcCard(d)); });
        body.appendChild(list);
        body.appendChild(howTo(r.turn));
        listTimer = setTimeout(function () { if (my === seq && hostEl.offsetParent) render(); }, 15000);
      }, function (e) {
        if (my !== seq) return;
        body.textContent = '';
        body.appendChild(el('div', 'fp-empty', e.status === 404 ? 'The Mist server needs an update for Mist PC.' : e.message));
      });
    }
    function upsell(body, devices) {
      var box = el('div', 'pc-upsell');
      box.appendChild(el('div', 'pc-up-ico', '🖥️'));
      box.appendChild(el('h3', null, 'Mist PC is for Mist Supporters'));
      box.appendChild(el('p', null, 'Support Mist for $5 a month to stream your own PC into Mist — plus the gold avatar outline, extra avatars and everything else supporters get.'));
      box.appendChild(ctx.button('green', 'Become a supporter', null, function () { if (ctx.openSupport) ctx.openSupport(); }));
      if (devices.length) box.appendChild(el('p', 'pc-note', 'Your ' + devices.length + ' paired PC' + (devices.length === 1 ? ' is' : 's are') + ' still saved and will work again when you support Mist.'));
      body.appendChild(box);
    }
    function pcCard(d) {
      var c = el('div', 'pc-card' + (d.online ? ' on' : ''));
      var ico = el('div', 'pc-ico', '🖥️'); c.appendChild(ico);
      var tx = el('div', 'pc-tx');
      tx.appendChild(el('b', null, d.name));
      tx.appendChild(el('small', 'pc-st', d.inUse ? '● In use' : d.online ? '● Online' : 'Offline' + (d.lastSeen ? ' · seen ' + ago(d.lastSeen).toLowerCase() : '')));
      c.appendChild(tx);
      var acts = el('div', 'pc-acts');
      var go = ctx.button(d.online ? 'green' : '', d.online ? 'Connect' : 'Offline', null, function () { connect(d); });
      if (!d.online) { go.disabled = true; go.title = 'Start Mist PC on ' + d.name + ' first.'; }
      acts.appendChild(go);
      var more = el('button', 'pc-more', '⋯'); more.title = 'More';
      more.onclick = function (ev) {
        ev.stopPropagation();
        var name = prompt('Rename this PC, or type REMOVE to unpair it:', d.name);
        if (name == null) return;
        if (name.trim().toUpperCase() === 'REMOVE') {
          api('POST', '/api/pc/remove', { device: d.id }).then(function () { toast(d.name + ' removed'); render(); }, function (e) { toast(e.message); });
        } else if (name.trim() && name.trim() !== d.name) {
          api('POST', '/api/pc/rename', { device: d.id, name: name.trim() }).then(function () { render(); }, function (e) { toast(e.message); });
        }
      };
      acts.appendChild(more);
      c.appendChild(acts);
      return c;
    }
    function howTo(turn) {
      var s = el('details', 'pc-how');
      s.appendChild(el('summary', null, 'How it works and tips'));
      [['Your PC needs to stay on', 'Mist PC runs on your PC with Chrome or Edge. Leave it running (it can be minimised). Turn off sleep mode if you want to connect while you’re away.'],
       ['Game mode', 'In games that turn the camera with the mouse (Roblox, shooters), press the 🎮 button or click the stream to lock the mouse. Press Esc to let go of it.'],
       ['Only you can connect', 'A PC only accepts connections from the Mist account that paired it. The Mist PC window shows when someone is connected and can block the mouse and keyboard at any time.'],
       ['Laggy or won’t connect?', turn ? 'Mist tries a direct connection first and uses the Mist server as a relay if the network blocks it. A wired connection on the PC helps most.' : 'Some networks block direct connections; ask the server owner to run server/pc-setup.sh so Mist can relay the stream.'],
       ['Things it can’t do', 'It can’t click on the Windows sign-in screen or “allow changes” (UAC) prompts. Unlock your PC and keep it unlocked.']
      ].forEach(function (x) { var r = el('div', 'pc-how-r'); r.appendChild(el('b', null, x[0])); r.appendChild(el('span', null, x[1])); s.appendChild(r); });
      return s;
    }

    /* ---------------- add a PC: download + one-time code ---------------- */
    function openAdd() {
      ctx.openModal(function (box) {
        box.classList.add('pc-add');
        box.appendChild(el('h3', null, 'Add a PC'));
        var steps = el('ol', 'pc-steps');
        var s1 = el('li'); s1.appendChild(el('b', null, 'Get Mist PC on the computer you want to stream. '));
        var dl = el('a', null, 'Download for Windows (MistPC.exe)'); dl.href = HELPER_EXE; dl.target = '_blank'; dl.rel = 'noopener';
        s1.appendChild(dl); s1.appendChild(document.createTextNode(' · '));
        var py = el('a', null, 'Python version (Mac/Linux)'); py.href = serverBase() + '/pc/mistpc.py'; py.target = '_blank'; py.rel = 'noopener';
        s1.appendChild(py);
        s1.appendChild(el('small', null, 'Windows may warn that it’s from an unknown publisher: click “More info” → “Run anyway”. You also need Chrome or Edge on that PC.'));
        steps.appendChild(s1);
        var s2 = el('li'); s2.appendChild(el('b', null, 'Run it. ')); s2.appendChild(document.createTextNode('A small Mist PC window opens.')); steps.appendChild(s2);
        var s3 = el('li'); s3.appendChild(el('b', null, 'Type this code into it:')); steps.appendChild(s3);
        box.appendChild(steps);
        var code = el('div', 'pc-code', '······'); box.appendChild(code);
        var exp = el('p', 'pc-exp', 'Getting a code…'); box.appendChild(exp);
        var server = el('p', 'pc-note', 'Mist server: ' + serverBase()); box.appendChild(server);
        var acts = el('div', 'm-actions');
        acts.appendChild(ctx.button('ghost', 'Done', null, function () { ctx.closeModal(); render(); }));
        box.appendChild(acts);
        var timer = null, before = null;
        function fresh() {
          api('POST', '/api/pc/pair').then(function (r) {
            code.textContent = r.code;
            var tick = function () {
              var s = Math.max(0, Math.round((r.exp - Date.now()) / 1000));
              exp.textContent = s ? 'Works once, for ' + Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2) + ' more.' : 'Expired.';
              if (!s) { clearInterval(timer); exp.textContent = 'That code expired. '; var a = el('a', null, 'Get a new one'); a.href = '#'; a.onclick = function (e) { e.preventDefault(); fresh(); }; exp.appendChild(a); }
            };
            clearInterval(timer); timer = setInterval(tick, 1000); tick();
          }, function (e) { exp.textContent = e.message; });
        }
        // notice when the new PC shows up
        api('GET', '/api/pc/devices').then(function (r) { before = (r.devices || []).map(function (d) { return d.id; }); });
        var watch = setInterval(function () {
          if (!document.body.contains(box)) { clearInterval(watch); clearInterval(timer); return; }
          api('GET', '/api/pc/devices').then(function (r) {
            var added = (r.devices || []).filter(function (d) { return before && before.indexOf(d.id) < 0; })[0];
            if (added) { clearInterval(watch); clearInterval(timer); ctx.closeModal(); toast(added.name + ' is paired'); render(); }
          }, function () {});
        }, 3000);
        fresh();
      });
    }

    /* ================================================================ viewer */
    function connect(d) {
      if (viewer) viewer.close('replaced');
      viewer = new Viewer(d);
    }

    function Viewer(d) {
      var self = this, closed = false, sid = null, pc = null, gameMode = false, muted = false;
      var stats = { fps: 0, kbps: 0, rtt: null, relay: false, lastBytes: 0, lastT: 0, w: 0, h: 0 };
      var keysDown = {}, buttonsDown = {};

      /* ---- overlay ---- */
      var ov = el('div', 'pcv'); ov.tabIndex = -1;
      var video = document.createElement('video'); video.className = 'pcv-video'; video.autoplay = true; video.playsInline = true; video.muted = false;
      ov.appendChild(video);
      var msg = el('div', 'pcv-msg'); var msgT = el('b', null, 'Connecting to ' + d.name + '…'); var msgS = el('small', null, ''); msg.appendChild(el('span', 'pcv-spin')); msg.appendChild(msgT); msg.appendChild(msgS);
      ov.appendChild(msg);
      var bar = el('div', 'pcv-bar');
      var title = el('span', 'pcv-name', '🖥️ ' + d.name); bar.appendChild(title);
      var st = el('span', 'pcv-stats', ''); bar.appendChild(st);
      var bGame = barBtn('🎮', 'Game mode: lock the mouse to the stream (Esc to release)', function () { setGameMode(!gameMode); });
      var bMute = barBtn('🔊', 'Mute', function () { muted = !muted; video.muted = muted; bMute.textContent = muted ? '🔇' : '🔊'; });
      var bFull = barBtn('⛶', 'Full screen', toggleFull);
      var bEnd = barBtn('✕ Disconnect', 'Disconnect', function () { self.close('viewer'); }); bEnd.classList.add('pcv-end');
      ov.appendChild(bar);
      var hint = el('div', 'pcv-hint', ''); ov.appendChild(hint);
      document.body.appendChild(ov);
      document.body.classList.add('pc-on');
      function barBtn(t, tip, fn) { var b = el('button', 'pcv-btn', t); b.title = tip; b.onclick = function (e) { e.stopPropagation(); fn(); ov.focus(); }; bar.appendChild(b); return b; }
      function status(t, s, spin) { msg.style.display = t ? '' : 'none'; msgT.textContent = t || ''; msgS.textContent = s || ''; msg.classList.toggle('nospin', !spin); }
      var hintTimer = null;
      function flash(t) { hint.textContent = t; hint.classList.add('on'); clearTimeout(hintTimer); hintTimer = setTimeout(function () { hint.classList.remove('on'); }, 2600); }
      // show the bar briefly, then only when the mouse is near the top
      var barTimer = null;
      function peek() { bar.classList.add('on'); clearTimeout(barTimer); barTimer = setTimeout(function () { bar.classList.remove('on'); }, 2500); }
      ov.addEventListener('mousemove', function (e) { if (!gameMode && e.clientY < 60) peek(); });
      peek();

      /* ---- signalling over the Mist server ---- */
      function send(m) { if (sid) api('POST', '/api/pc/view/send', { sid: sid, msg: m }).catch(function () {}); }
      function poll() {
        if (closed || !sid) return;
        api('POST', '/api/pc/view/poll', { sid: sid }).then(function (r) {
          (r.msgs || []).forEach(onMsg);
          if (!closed) setTimeout(poll, 0);
        }, function () { if (!closed) setTimeout(poll, 2000); });
      }
      function onMsg(m) {
        if (closed) return;
        if (m.type === 'bye') {
          var why = { host: 'The PC ended the stream.', noscreen: 'Screen sharing is off on the PC. Press “Share my screen” in the Mist PC window.', replaced: 'You connected from somewhere else.', removed: 'That PC was removed.', failed: 'The connection failed. The network may be blocking it.', timeout: 'The connection timed out.', gone: 'The stream ended.' }[m.why] || 'The stream ended.';
          return self.close(m.why, why);
        }
        if (m.sdp && m.sdp.type === 'answer') pc.setRemoteDescription(m.sdp).catch(function (e) { self.close('error', 'Couldn’t connect: ' + e.message); });
        else if (m.cand) pc.addIceCandidate(m.cand).catch(function () {});
        else if (m.info) {
          stats.w = m.info.w; stats.h = m.info.h;
          if (!m.info.input) flash('Mouse and keyboard are blocked on the PC (view only).');
          if (!m.info.audio) flash('No sound: the PC didn’t share audio.');
        }
      }

      /* ---- WebRTC ---- */
      api('POST', '/api/pc/connect', { device: d.id }).then(function (r) {
        if (closed) return;
        sid = r.sid;
        pc = new RTCPeerConnection({ iceServers: r.ice || [], bundlePolicy: 'max-bundle' });
        var tv = pc.addTransceiver('video', { direction: 'recvonly' }), ta = pc.addTransceiver('audio', { direction: 'recvonly' });
        try {   // H.264 first: hardware encode on the PC, hardware decode here
          var caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
          if (caps && tv.setCodecPreferences) {
            var c = caps.codecs.slice().sort(function (a, b) { return (/h264/i.test(b.mimeType) ? 1 : 0) - (/h264/i.test(a.mimeType) ? 1 : 0); });
            tv.setCodecPreferences(c);
          }
        } catch (e) {}
        self.ctl = pc.createDataChannel('ctl', { ordered: true });
        self.mv = pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
        var stream = new MediaStream();
        pc.ontrack = function (e) {
          stream.addTrack(e.track);
          try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; else e.receiver.playoutDelayHint = 0; } catch (x) {}
          video.srcObject = stream;
          video.play().catch(function () { video.muted = true; muted = true; bMute.textContent = '🔇'; video.play().catch(function () {}); flash('Sound is muted: press 🔊 to turn it on.'); });
        };
        pc.onicecandidate = function (e) { if (e.candidate) send({ cand: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = function () {
          if (closed) return;
          if (pc.connectionState === 'connected') { status(''); ov.focus(); flash('Connected. Click the stream to control it · 🎮 for games that use the mouse to look around'); }
          else if (pc.connectionState === 'disconnected') status('Reconnecting…', 'The connection dropped for a moment.', true);
          else if (pc.connectionState === 'failed') self.close('failed', 'Couldn’t connect to ' + d.name + '. The network here may block it.');
        };
        status('Connecting to ' + d.name + '…', 'Starting the stream on your PC.', true);
        poll();
        return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { send({ sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); });
      }).catch(function (e) { self.close('error', e.message); });
      var connectTimer = setTimeout(function () { if (!closed && (!pc || pc.connectionState !== 'connected')) self.close('timeout', 'Couldn’t reach ' + d.name + '. Check that Mist PC is running on it and the screen is shared.'); }, 30000);

      var statsTimer = setInterval(function statsTick() {
        if (closed || !pc) return;
        pc.getStats().then(function (rep) {
          var pair = null, inb = null, cands = {};
          rep.forEach(function (s) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
            if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
            if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands[s.id] = s;
          });
          if (inb) {
            var now = inb.timestamp, b = inb.bytesReceived;
            if (stats.lastT) stats.kbps = Math.round((b - stats.lastBytes) * 8 / (now - stats.lastT));
            stats.lastT = now; stats.lastBytes = b; stats.fps = Math.round(inb.framesPerSecond || 0);
          }
          if (pair) { stats.rtt = pair.currentRoundTripTime; var lc = cands[pair.localCandidateId]; stats.relay = !!(lc && lc.candidateType === 'relay'); }
          st.textContent = (stats.fps ? stats.fps + ' fps · ' : '') + (stats.kbps ? (stats.kbps / 1000).toFixed(1) + ' Mbps · ' : '') +
            (stats.rtt != null ? Math.round(stats.rtt * 1000) + ' ms' : '') + (stats.relay ? ' · relayed' : '');
        }).catch(function () {});
      }, 1000);

      /* ---- input ---- */
      function ctl(m) { if (self.ctl && self.ctl.readyState === 'open') self.ctl.send(JSON.stringify(m)); }
      function contentRect() {   // where the picture is inside the letterboxed <video>
        var r = video.getBoundingClientRect(), vw = video.videoWidth || stats.w || r.width, vh = video.videoHeight || stats.h || r.height;
        var s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
        return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w: w, h: h };
      }
      var pend = { dx: 0, dy: 0, abs: null }, raf = 0;
      function flushMove() {
        raf = 0;
        if (!self.mv || self.mv.readyState !== 'open') return;
        if (pend.dx || pend.dy) { self.mv.send(JSON.stringify({ t: 'mr', dx: Math.round(pend.dx), dy: Math.round(pend.dy) })); pend.dx = pend.dy = 0; }
        if (pend.abs) { self.mv.send(JSON.stringify({ t: 'ma', x: pend.abs[0], y: pend.abs[1] })); pend.abs = null; }
      }
      function onMove(e) {
        if (gameMode && document.pointerLockElement === video) { pend.dx += e.movementX; pend.dy += e.movementY; }
        else if (!gameMode) {
          var c = contentRect(); var x = (e.clientX - c.x) / c.w, y = (e.clientY - c.y) / c.h;
          if (x < 0 || y < 0 || x > 1 || y > 1) return;
          pend.abs = [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
        } else return;
        if (!raf) raf = requestAnimationFrame(flushMove);
      }
      function onDown(e) {
        if (e.target !== video) return;
        e.preventDefault(); ov.focus();
        if (gameMode && document.pointerLockElement !== video) { lockPointer(); return; }
        onMove(e); flushMove();
        buttonsDown[e.button] = 1; ctl({ t: 'mb', b: e.button, d: 1 });
      }
      function onUp(e) { if (!buttonsDown[e.button]) return; delete buttonsDown[e.button]; ctl({ t: 'mb', b: e.button, d: 0 }); }
      function onWheel(e) {
        if (e.target !== video) return;
        e.preventDefault();
        var k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        ctl({ t: 'w', dx: Math.round(e.deltaX * k * 1.2), dy: Math.round(e.deltaY * k * 1.2) });
      }
      function onKey(e) {
        if (closed) return;
        var down = e.type === 'keydown';
        if (e.code === 'Escape' && down && document.pointerLockElement) return;  // the browser uses Esc to release the mouse
        if (!e.code) return;
        e.preventDefault(); e.stopPropagation();
        if (down) { if (keysDown[e.code]) return; keysDown[e.code] = 1; } else { if (!keysDown[e.code]) return; delete keysDown[e.code]; }
        ctl({ t: 'k', code: e.code, d: down ? 1 : 0 });
      }
      function releaseAll() { keysDown = {}; buttonsDown = {}; ctl({ t: 'release' }); }
      function lockPointer() { try { var p = video.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(function () { video.requestPointerLock(); }); } catch (e) { video.requestPointerLock(); } }
      function setGameMode(on) {
        gameMode = on; bGame.classList.toggle('on', on); ov.classList.toggle('game', on);
        if (on) { lockPointer(); flash('Game mode on: the mouse is locked to the stream. Press Esc to release it.'); }
        else if (document.pointerLockElement) document.exitPointerLock();
      }
      function onLockChange() {
        if (document.pointerLockElement !== video && gameMode) flash('Mouse released. Click the stream to lock it again, or press 🎮 to leave game mode.');
      }
      function toggleFull() {
        if (document.fullscreenElement) document.exitFullscreen();
        else ov.requestFullscreen().then(function () { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(function () {}); }, function () {});
      }
      ov.addEventListener('mousemove', onMove);
      ov.addEventListener('mousedown', onDown);
      window.addEventListener('mouseup', onUp);
      ov.addEventListener('wheel', onWheel, { passive: false });
      ov.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      ov.addEventListener('keydown', onKey, true);
      ov.addEventListener('keyup', onKey, true);
      window.addEventListener('blur', releaseAll);
      document.addEventListener('pointerlockchange', onLockChange);

      this.close = function (why, text) {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer); clearInterval(statsTimer);
        try { releaseAll(); } catch (e) {}
        if (why !== 'replaced' && sid && why !== 'gone' && why !== 'host' && why !== 'removed') api('POST', '/api/pc/view/send', { sid: sid, msg: { type: 'bye' } }).catch(function () {});
        try { if (pc) pc.close(); } catch (e) {}
        window.removeEventListener('mouseup', onUp); window.removeEventListener('blur', releaseAll);
        document.removeEventListener('pointerlockchange', onLockChange);
        if (document.pointerLockElement) document.exitPointerLock();
        if (document.fullscreenElement === ov) document.exitFullscreen().catch(function () {});
        if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
        ov.remove(); document.body.classList.remove('pc-on');
        if (viewer === self) viewer = null;
        if (text) toast(text);
        render();
      };
    }

    return {
      render: render,
      onAuthChange: function () { if (viewer) viewer.close('signout'); if (hostEl && hostEl.offsetParent) render(); },
      connected: function () { return !!viewer; }
    };
  };
})();

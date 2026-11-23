/*!
 * Gleam — the web browser on the Mist desktop (Chrome-style tabs).
 * Every tab is an iframe of the Mist Browser page on the Mist server (/browse/), which loads sites through
 * Ultraviolet and the server's relay. Only signed-in players can use it: the server hands out a browser
 * ticket for the account, and the relay refuses anything without one.
 */
(function () {
  'use strict';
  window.MistGleam = function (o) {
    var el = o.el, toast = o.toast, shell = o.shell;
    var SEARCH = 'https://duckduckgo.com/?q=';
    var QUICK = [['DuckDuckGo', 'https://duckduckgo.com/'], ['Wikipedia', 'https://www.wikipedia.org/'], ['YouTube', 'https://www.youtube.com/'], ['GitHub', 'https://github.com/'], ['Khan Academy', 'https://www.khanacademy.org/'], ['Desmos', 'https://www.desmos.com/calculator'], ['Scratch', 'https://scratch.mit.edu/'], ['Infinite Craft', 'https://neal.fun/infinite-craft/']];
    var tabs = [], active = null, seq = 0, ticket = null, ticketP = null, win = null, ui = null;

    /* ---------------------------------------------------------------- window */
    function open(url) {
      if (win && !win.hidden && document.body.contains(win.el)) { win.show(); if (url) newTab(url); else if (!tabs.length) newTab(); return win; }
      win = shell.openWindow({
        app: 'gleam', title: 'Gleam', width: 1100, height: 720, minW: 420, minH: 300, cls: 'win-gleam', closeOnSignOut: true,
        onClose: function () { if (tabs.length > 1 && !confirm('Close Gleam and its ' + tabs.length + ' tabs?')) return false; },
        onClosed: function () { tabs = []; active = null; win = null; ui = null; shell.refreshDesktop(); }
      });
      build();
      newTab(typeof url === 'string' ? url : null);
      return win;
    }
    function build() {
      ui = {};
      var strip = el('div', 'gl-strip');
      ui.list = el('div', 'gl-tabs'); strip.appendChild(ui.list);
      var plus = el('button', 'gl-plus', '+'); plus.title = 'New tab (Ctrl+T)'; plus.onclick = function () { newTab(); };
      strip.appendChild(plus);
      win.tbExtra.appendChild(strip);
      win.titleEl.style.display = 'none';
      var bar = el('div', 'gl-bar');
      ui.back = nav('‹', 'Back', function () { send(cur(), { mb: 'back' }); });
      ui.fwd = nav('›', 'Forward', function () { send(cur(), { mb: 'forward' }); });
      ui.rel = nav('⟳', 'Reload', function () { var t = cur(); if (t && t.url) { t.loading = true; render(); send(t, { mb: 'reload' }); } });
      ui.homeB = nav('⌂', 'New tab page', function () { var t = cur(); if (t) { t.url = ''; t.title = ''; t.home = true; render(); } });
      [ui.back, ui.fwd, ui.rel, ui.homeB].forEach(function (b) { bar.appendChild(b); });
      var omni = el('div', 'gl-omni');
      ui.lockI = el('span', 'gl-lock', '🔒'); ui.lockI.title = 'Loads through the Mist server';
      ui.addr = el('input', 'gl-addr'); ui.addr.placeholder = 'Search DuckDuckGo or type a web address'; ui.addr.spellcheck = false; ui.addr.autocomplete = 'off';
      ui.addr.onkeydown = function (e) {
        if (e.key === 'Enter') { var t = cur(); if (t && ui.addr.value.trim()) navigate(t, ui.addr.value); ui.addr.blur(); }
        if (e.key === 'Escape') { ui.addr.value = (cur() || {}).url || ''; ui.addr.blur(); }
      };
      ui.addr.onfocus = function () { ui.addr.select(); };
      omni.appendChild(ui.lockI); omni.appendChild(ui.addr); bar.appendChild(omni);
      win.body.appendChild(bar);
      ui.frames = el('div', 'gl-frames'); win.body.appendChild(ui.frames);
      ui.home = el('div', 'gl-home'); win.body.appendChild(ui.home); buildHome();
      win.el.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === 't') { e.preventDefault(); newTab(); }
        else if (e.key === 'w') { e.preventDefault(); var t = cur(); if (t) closeTab(t); }
        else if (e.key === 'l') { e.preventDefault(); ui.addr.focus(); }
      });
    }
    function nav(txt, title, fn) { var b = el('button', 'gl-nav', txt); b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; return b; }
    function buildHome() {
      var box = el('div', 'gl-home-box');
      var h = el('div', 'gl-home-h'); h.appendChild(shell.appIcon('gleam', 52)); h.appendChild(el('b', null, 'Gleam')); box.appendChild(h);
      var q = el('input', 'gl-home-q'); q.placeholder = 'Search DuckDuckGo or type a web address'; q.spellcheck = false; q.autocomplete = 'off';
      q.onkeydown = function (e) { if (e.key === 'Enter' && q.value.trim()) { var t = cur(); if (t) navigate(t, q.value); q.value = ''; } };
      box.appendChild(q);
      var g = el('div', 'gl-quick');
      QUICK.forEach(function (s) {
        var a = el('button', 'gl-q'); a.appendChild(el('span', 'gl-q-i', s[0].charAt(0))); a.appendChild(el('span', null, s[0]));
        a.onclick = function () { var t = cur(); if (t) navigate(t, s[1]); };
        g.appendChild(a);
      });
      box.appendChild(g);
      box.appendChild(el('p', 'gl-note', 'Pages load through the Mist server, so sites see the server instead of you. Which sites each account opens is logged, and some sites are blocked. Google sign-in and similar may not work here.'));
      ui.home.appendChild(box);
      ui.homeQ = q;
    }

    /* ---------------------------------------------------------------- tickets */
    function engine() { return o.getEngine(); }
    function getTicket(force) {
      var e = engine();
      if (!e || !e.signedIn()) return Promise.reject(new Error('Sign in to Mist to use Gleam.'));
      if (!force && ticket && ticket.exp - Date.now() > 30 * 60e3) return Promise.resolve(ticket);
      if (ticketP) return ticketP;
      ticketP = e.api('POST', '/api/browser/ticket').then(function (r) {
        var base = new URL(r.path || '/browse/', e.server.replace(/\/*$/, '/')).href;
        ticket = { value: r.ticket, exp: r.exp, base: base, origin: new URL(base).origin };
        ticketP = null; return ticket;
      }, function (er) {
        ticketP = null;
        if (er && er.status === 404) throw new Error('The Mist server hasn’t been updated for Gleam yet.');
        throw er;
      });
      return ticketP;
    }
    setInterval(function () {
      if (!tabs.some(function (t) { return t.frame; }) || !ticket || ticket.exp - Date.now() > 2 * 3600e3) return;
      getTicket(true).then(function (tk) { tabs.forEach(function (t) { if (t.ready) send(t, { mb: 'ticket', ticket: tk.value }); }); }, function () {});
    }, 10 * 60e3);

    /* ---------------------------------------------------------------- tabs */
    function cur() { for (var i = 0; i < tabs.length; i++) if (tabs[i].id === active) return tabs[i]; return null; }
    function byWin(w) { for (var i = 0; i < tabs.length; i++) if (tabs[i].frame && tabs[i].frame.contentWindow === w) return tabs[i]; return null; }
    function newTab(url, background) {
      if (!ui) { open(url); return null; }
      if (tabs.length >= 12) { toast('Gleam can have up to 12 tabs open.'); return null; }
      var t = { id: ++seq, url: '', title: '', loading: false, frame: null, ready: false, home: true };
      t.btn = el('div', 'gl-tab'); t.btn.setAttribute('role', 'tab'); t.btn.tabIndex = 0; t.btn.dataset.nodrag = '1';
      t.ico = el('span', 'gl-ico'); t.lbl = el('span', 'gl-t', 'New tab');
      var x = el('button', 'gl-x', '×'); x.title = 'Close tab'; x.onclick = function (ev) { ev.stopPropagation(); closeTab(t); };
      t.btn.onclick = function () { activate(t.id); };
      t.btn.onauxclick = function (ev) { if (ev.button === 1) closeTab(t); };
      t.btn.appendChild(t.ico); t.btn.appendChild(t.lbl); t.btn.appendChild(x);
      ui.list.appendChild(t.btn);
      tabs.push(t);
      if (!background) activate(t.id);
      if (url) navigate(t, url); else render();
      if (!background && !url) setTimeout(function () { if (ui) ui.homeQ.focus(); }, 40);
      return t;
    }
    function closeTab(t) {
      var i = tabs.indexOf(t); if (i < 0) return;
      if (t.frame) t.frame.remove();
      t.btn.remove(); tabs.splice(i, 1);
      if (!tabs.length) { if (win) win.close(true); return; }
      if (active === t.id) activate(tabs[Math.min(i, tabs.length - 1)].id); else render();
    }
    function activate(id) { active = id; render(); }
    function toUrl(s) {
      s = s.trim();
      if (/^https?:\/\//i.test(s)) return s;
      if (/^[a-z][\w+.-]*:/i.test(s) && !/^[\w.-]+:\d+(\/|$)/.test(s)) return null;
      if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
      if (/^localhost(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
      return SEARCH + encodeURIComponent(s);
    }
    function navigate(t, input) {
      var url = toUrl(String(input || ''));
      if (!url) { toast('Only web addresses (http and https) can be opened.'); return; }
      t.url = url; t.title = ''; t.home = false; t.loading = true;
      render();
      ensureFrame(t).then(function () { send(t, { mb: 'go', url: url }); }, function (er) { t.loading = false; render(); toast(er.message || String(er)); });
    }
    function ensureFrame(t) {
      if (t.frameP) return t.frameP;
      t.frameP = getTicket().then(function (tk) {
        return new Promise(function (resolve, reject) {
          var f = document.createElement('iframe');
          f.className = 'gl-frame';
          f.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture');
          f.setAttribute('allowfullscreen', '');
          f.src = tk.base;
          t.frame = f; t.origin = tk.origin;
          t.onReady = function () { t.ready = true; send(t, { mb: 'init', ticket: tk.value }); resolve(); };
          setTimeout(function () { if (!t.ready) { t.frameP = null; if (t.frame) t.frame.remove(); t.frame = null; reject(new Error('Gleam didn’t load. Check that the Mist server is online.')); } }, 20000);
          if (!ui) return reject(new Error('closed'));
          ui.frames.appendChild(f);
          render();
        });
      });
      t.frameP.catch(function () { t.frameP = null; });
      return t.frameP;
    }
    function send(t, m) { if (t && t.frame && t.ready) t.frame.contentWindow.postMessage(m, t.origin); }

    window.addEventListener('message', function (e) {
      var t = byWin(e.source), m = e.data;
      if (!t || e.origin !== t.origin || !m || typeof m.mb !== 'string') return;
      if (m.mb === 'ready') { if (t.onReady) { var f = t.onReady; t.onReady = null; f(); } }
      else if (m.mb === 'state') {
        if (typeof m.url === 'string' && /^https?:/i.test(m.url)) t.url = m.url;
        t.title = String(m.title || '').slice(0, 200); t.loading = !!m.loading; t.home = false;
        render();
      } else if (m.mb === 'open') {
        if (typeof m.url === 'string' && /^https?:/i.test(m.url)) newTab(m.url, true);
      } else if (m.mb === 'error') { t.loading = false; render(); }
    });

    function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
    function render() {
      if (!ui) return;
      var t = cur();
      tabs.forEach(function (x) {
        var name = x.title || (x.url ? host(x.url) : 'New tab');
        x.lbl.textContent = name; x.btn.title = name + (x.url ? '\n' + x.url : '');
        x.btn.classList.toggle('on', x.id === active);
        x.ico.textContent = x.loading ? '' : (x.url ? host(x.url).charAt(0).toUpperCase() : '✦');
        x.ico.classList.toggle('spin', !!x.loading);
        if (x.frame) x.frame.classList.toggle('on', x.id === active && !x.home);
      });
      if (!t) return;
      ui.home.classList.toggle('on', !!t.home);
      if (document.activeElement !== ui.addr) ui.addr.value = t.home ? '' : t.url;
      ui.rel.textContent = t.loading ? '✕' : '⟳';
      win.setTitle((t.title || (t.url ? host(t.url) : 'New tab')) + ' — Gleam');
    }

    return {
      open: open,
      openUrl: function (u) { open(u); },
      onAuthChange: function () {
        var e = engine(); ticket = null;
        if ((!e || !e.signedIn()) && win) win.close(true);
      }
    };
  };
})();

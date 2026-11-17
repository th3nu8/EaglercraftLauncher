/*!
 * Mist — browser tabs
 * A tab strip across the top of Mist. The first tab is Mist itself and can't be closed; "+" opens
 * browser tabs. Each browser tab is an iframe of the Mist Browser page on the Mist server (/browse/),
 * which loads sites through Ultraviolet and the server's relay. Only signed-in players get tabs: the
 * server hands out a browser ticket for the account, and the relay refuses anything without one.
 */
(function () {
  'use strict';
  window.MistBrowser = function (o) {
    var el = o.el, toast = o.toast;
    var SEARCH = 'https://duckduckgo.com/?q=';
    var QUICK = [['DuckDuckGo', 'https://duckduckgo.com/'], ['Wikipedia', 'https://www.wikipedia.org/'], ['YouTube', 'https://www.youtube.com/'], ['GitHub', 'https://github.com/'], ['Khan Academy', 'https://www.khanacademy.org/'], ['Desmos', 'https://www.desmos.com/calculator']];
    var tabs = [], active = null, seq = 0, ticket = null, ticketP = null;

    // ---------------------------------------------------------------- DOM
    var strip = el('div', 'mb-strip'); strip.id = 'mbStrip';
    var mistTab = el('button', 'mb-tab mb-mist on');
    mistTab.title = 'Mist';
    mistTab.appendChild(el('span', 'brand-ico')); mistTab.appendChild(el('span', 'mb-t', 'Mist'));
    mistTab.onclick = function () { activate(null); };
    var list = el('div', 'mb-tabs');
    var plus = el('button', 'mb-plus', '+'); plus.title = 'New tab'; plus.setAttribute('aria-label', 'New browser tab');
    plus.onclick = function () { newTab(); };
    strip.appendChild(mistTab); strip.appendChild(list); strip.appendChild(plus);

    var view = el('div', 'mb-view'); view.id = 'mbView';
    var bar = el('div', 'mb-bar');
    var bBack = navBtn('‹', 'Back', function () { send(cur(), { mb: 'back' }); });
    var bFwd = navBtn('›', 'Forward', function () { send(cur(), { mb: 'forward' }); });
    var bRel = navBtn('⟳', 'Reload', function () { var t = cur(); if (t && t.url) send(t, { mb: 'reload' }); });
    var addr = el('input', 'mb-addr'); addr.placeholder = 'Search or type a web address'; addr.spellcheck = false; addr.autocomplete = 'off';
    addr.onkeydown = function (e) { if (e.key === 'Enter') { var t = cur(); if (t && addr.value.trim()) navigate(t, addr.value); addr.blur(); } if (e.key === 'Escape') { addr.value = (cur() || {}).url || ''; addr.blur(); } };
    addr.onfocus = function () { addr.select(); };
    var bHome = navBtn('⌂', 'New tab page', function () { var t = cur(); if (t) { t.url = ''; t.title = ''; t.home = true; render(); } });
    [bBack, bFwd, bRel, bHome].forEach(function (b, i) { if (i < 3) bar.appendChild(b); });
    bar.appendChild(addr); bar.appendChild(bHome);
    var frames = el('div', 'mb-frames');
    var home = el('div', 'mb-home'); buildHome();
    view.appendChild(bar); view.appendChild(frames); view.appendChild(home);
    var app = document.getElementById('app');
    document.body.insertBefore(strip, app);
    document.body.appendChild(view);
    document.body.classList.add('mb-strip-on');

    function navBtn(txt, title, fn) { var b = el('button', 'mb-nav', txt); b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; return b; }
    function buildHome() {
      home.textContent = '';
      var box = el('div', 'mb-home-box');
      var h = el('div', 'mb-home-h'); h.appendChild(el('span', 'brand-ico')); h.appendChild(el('b', null, 'Mist Browser')); box.appendChild(h);
      var q = el('input', 'mb-home-q'); q.placeholder = 'Search DuckDuckGo or type a web address'; q.spellcheck = false; q.autocomplete = 'off';
      q.onkeydown = function (e) { if (e.key === 'Enter' && q.value.trim()) { var t = cur(); if (t) navigate(t, q.value); q.value = ''; } };
      box.appendChild(q);
      var g = el('div', 'mb-quick');
      QUICK.forEach(function (s) {
        var a = el('button', 'mb-q');
        var i = el('span', 'mb-q-i', s[0].charAt(0)); a.appendChild(i); a.appendChild(el('span', null, s[0]));
        a.onclick = function () { var t = cur(); if (t) navigate(t, s[1]); };
        g.appendChild(a);
      });
      box.appendChild(g);
      box.appendChild(el('p', 'mb-note', 'Pages load through the Mist server, so sites see the server instead of you. Which sites each account opens is logged, and some sites are blocked. Sign-ins to Google and similar sites may not work here.'));
      home.appendChild(box);
      home._q = q;
    }

    // ---------------------------------------------------------------- tickets
    function engine() { return o.getEngine(); }
    function getTicket(force) {
      var e = engine();
      if (!e || !e.signedIn()) return Promise.reject(new Error('Sign in to Mist to use the browser.'));
      if (!force && ticket && ticket.exp - Date.now() > 30 * 60e3) return Promise.resolve(ticket);
      if (ticketP) return ticketP;
      ticketP = e.api('POST', '/api/browser/ticket').then(function (r) {
        var base = new URL(r.path || '/browse/', e.server.replace(/\/*$/, '/')).href;
        ticket = { value: r.ticket, exp: r.exp, base: base, origin: new URL(base).origin };
        ticketP = null; return ticket;
      }, function (er) {
        ticketP = null;
        if (er && er.status === 404) throw new Error('The Mist server hasn’t been updated for the browser yet.');
        throw er;
      });
      return ticketP;
    }
    // keep every open tab's ticket fresh (they last 12 hours)
    setInterval(function () {
      if (!tabs.some(function (t) { return t.frame; }) || !ticket || ticket.exp - Date.now() > 2 * 3600e3) return;
      getTicket(true).then(function (tk) { tabs.forEach(function (t) { if (t.ready) send(t, { mb: 'ticket', ticket: tk.value }); }); }, function () {});
    }, 10 * 60e3);

    // ---------------------------------------------------------------- tabs
    function cur() { for (var i = 0; i < tabs.length; i++) if (tabs[i].id === active) return tabs[i]; return null; }
    function byWin(w) { for (var i = 0; i < tabs.length; i++) if (tabs[i].frame && tabs[i].frame.contentWindow === w) return tabs[i]; return null; }
    function newTab(url, background) {
      var e = engine();
      if (!e || !e.signedIn()) { toast('Sign in to Mist to use the browser.'); if (o.openAuth) o.openAuth('login'); return null; }
      if (tabs.length >= 12) { toast('You can have up to 12 browser tabs open.'); return null; }
      var t = { id: ++seq, url: '', title: '', loading: false, frame: null, ready: false, queue: [], home: true };
      t.btn = el('div', 'mb-tab'); t.btn.setAttribute('role', 'button'); t.btn.tabIndex = 0;
      t.ico = el('span', 'mb-ico'); t.lbl = el('span', 'mb-t', 'New tab');
      var x = el('button', 'mb-x', '×'); x.title = 'Close tab'; x.setAttribute('aria-label', 'Close tab');
      x.onclick = function (ev) { ev.stopPropagation(); closeTab(t); };
      t.btn.onclick = function () { activate(t.id); };
      t.btn.onauxclick = function (ev) { if (ev.button === 1) closeTab(t); };
      t.btn.onkeydown = function (ev) { if (ev.key === 'Enter') activate(t.id); };
      t.btn.appendChild(t.ico); t.btn.appendChild(t.lbl); t.btn.appendChild(x);
      list.appendChild(t.btn);
      tabs.push(t);
      if (!background) activate(t.id);
      if (url) navigate(t, url); else render();
      if (!background && !url) setTimeout(function () { home._q.focus(); }, 30);
      return t;
    }
    function closeTab(t) {
      var i = tabs.indexOf(t); if (i < 0) return;
      if (t.frame) t.frame.remove();
      t.btn.remove(); tabs.splice(i, 1);
      if (active === t.id) activate(tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null);
      else render();
    }
    function activate(id) {
      active = id;
      document.body.classList.toggle('mb-on', id != null);
      render();
      if (id == null && o.onMist) o.onMist();
    }
    function toUrl(s) {
      s = s.trim();
      if (/^https?:\/\//i.test(s)) return s;
      if (/^[a-z][\w+.-]*:/i.test(s) && !/^[\w.-]+:\d+(\/|$)/.test(s)) return null;       // javascript:, file: and so on
      if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
      if (/^localhost(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
      return SEARCH + encodeURIComponent(s);
    }
    function navigate(t, input) {
      var url = toUrl(String(input || ''));
      if (!url) { toast('Only web addresses (http and https) can be opened.'); return; }
      t.url = url; t.title = ''; t.home = false; t.loading = true; t.error = '';
      render();
      ensureFrame(t).then(function () { send(t, { mb: 'go', url: url }); }, function (er) {
        t.loading = false; t.error = er.message || String(er); render(); toast(t.error);
      });
    }
    function ensureFrame(t) {
      if (t.frameP) return t.frameP;
      t.frameP = getTicket().then(function (tk) {
        return new Promise(function (resolve, reject) {
          var f = document.createElement('iframe');
          f.className = 'mb-frame';
          f.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture');
          f.setAttribute('allowfullscreen', '');
          f.src = tk.base;
          t.frame = f; t.origin = tk.origin;
          t.onReady = function () { t.ready = true; send(t, { mb: 'init', ticket: tk.value }); resolve(); };
          setTimeout(function () { if (!t.ready) { t.frameP = null; if (t.frame) t.frame.remove(); t.frame = null; reject(new Error('The browser didn’t load. Check that the Mist server is online.')); } }, 20000);
          frames.appendChild(f);
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
        t.title = String(m.title || '').slice(0, 200); t.loading = !!m.loading; t.home = false; t.error = '';
        render();
      } else if (m.mb === 'open') {
        if (typeof m.url === 'string' && /^https?:/i.test(m.url)) newTab(m.url, true);
      } else if (m.mb === 'error') { t.error = String(m.text || 'Something went wrong.'); t.loading = false; render(); }
    });

    // ---------------------------------------------------------------- drawing
    function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
    function render() {
      mistTab.classList.toggle('on', active == null);
      var t = cur();
      tabs.forEach(function (x) {
        var name = x.title || (x.url ? host(x.url) : 'New tab');
        x.lbl.textContent = name; x.btn.title = name + (x.url ? '\n' + x.url : '');
        x.btn.classList.toggle('on', x.id === active);
        x.ico.textContent = x.loading ? '' : (x.url ? host(x.url).charAt(0).toUpperCase() : '+');
        x.ico.classList.toggle('spin', !!x.loading);
        if (x.frame) x.frame.classList.toggle('on', x.id === active && !x.home);
      });
      if (!t) return;
      home.classList.toggle('on', !!t.home);
      if (document.activeElement !== addr) addr.value = t.home ? '' : t.url;
      document.title = (t.title || (t.url ? host(t.url) : 'New tab')) + ' · Mist';
    }

    return {
      // signing out closes every browser tab; the relay would refuse them anyway
      onAuthChange: function () {
        var e = engine();
        ticket = null;
        if (!e || !e.signedIn()) tabs.slice().forEach(closeTab);
      },
      newTab: newTab,
      showMist: function () { activate(null); },
      count: function () { return tabs.length; }
    };
  };
})();

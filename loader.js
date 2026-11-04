/*!
 * Mist — loader
 * The bookmarklet loads this file. It fetches the launcher UI + versions.json
 * from your GitHub repo and writes them into an about:blank window.
 *
 * >>> EDIT THIS: point REPO at your own GitHub repository. <<<
 */
(function () {
  var REPO = { user: 'th3nu8', repo: 'EaglercraftLauncher', branch: 'main' };

  // raw.githubusercontent.com sends CORS headers, has no 20 MB file cap
  // (unlike jsDelivr) and refreshes within minutes of a push.
  var BASE = window.EAGLER_LAUNCHER_BASE ||
    'https://raw.githubusercontent.com/' + REPO.user + '/' + REPO.repo + '/' + REPO.branch + '/';

  function splash(doc, msg, isError) {
    doc.open();
    doc.write('<!doctype html><meta charset="utf-8"><title>Mist</title>' +
      '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1b1b1b;' +
      'color:' + (isError ? '#ff8a80' : '#cfcfcf') + ';font:15px system-ui,Segoe UI,sans-serif;text-align:center;padding:0 24px">' +
      '<div id="m"></div></body>');
    doc.close();
    doc.getElementById('m').textContent = msg;
  }

  function pinCommit(win) {
    if (window.EAGLER_LAUNCHER_BASE) return Promise.resolve();
    var done = false;
    return Promise.race([
      win.fetch('https://api.github.com/repos/' + REPO.user + '/' + REPO.repo + '/commits/' + REPO.branch,
        { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (sha) {
          sha = String(sha).trim();
          if (!done && /^[0-9a-f]{40}$/.test(sha)) BASE = 'https://raw.githubusercontent.com/' + REPO.user + '/' + REPO.repo + '/' + sha + '/';
        }, function () {}),
      new Promise(function (res) { setTimeout(res, 4000); })
    ]).then(function () { done = true; });
  }

  function run(win) {
    var doc = win.document;
    splash(doc, 'Loading launcher…');
    var bust = '?t=' + Date.now();
    function get(f) {
      return win.fetch(BASE + f + (/\/[0-9a-f]{40}\/$/.test(BASE) ? '' : bust), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error(f + ' returned HTTP ' + r.status + ' (check REPO in loader.js)');
        return r.text();
      });
    }
    // Pin every file to one commit, so a push that GitHub's cache has only half picked up can't mix
    // old and new launcher files (that shows up as a TypeError on start). Falls back to the branch.
    pinCommit(win).then(function () { return Promise.all([get('launcher/index.html'), get('versions.json')]); }).then(function (t) {
      var html = t[0], versions;
      try { versions = JSON.parse(t[1]); }
      catch (e) { throw new Error('versions.json is not valid JSON: ' + e.message); }
      // index.html pulls in other files with /*EL_FILE:path*/ markers.
      var re = /\/\*EL_FILE:([\w\-.\/]+)\*\//g, paths = [], m;
      while ((m = re.exec(html))) if (paths.indexOf(m[1]) < 0) paths.push(m[1]);
      return Promise.all(paths.map(get)).then(function (files) {
        var cfg = JSON.stringify({ base: BASE, versions: versions }).replace(/</g, '\\u003c');
        html = html
          .replace('/*EL_CONFIG*/', function () { return 'window.__EL_CFG=' + cfg + ';'; })
          .replace(re, function (_, f) { return files[paths.indexOf(f)]; });
        doc.open();
        doc.write(html);
        doc.close();
      });
    }).catch(function (e) {
      splash(doc, 'Launcher failed to load: ' + e.message, true);
    });
  }

  // The bookmarklet's blank tab is marked with #el-blank. (After document.write
  // its location reports the opener's URL, so location.href can't be used.)
  if (location.href === 'about:blank' || document.getElementById('el-blank')) {
    run(window);
  } else {
    var w = window.open('about:blank', '_blank');
    if (!w) { alert('Pop-up blocked. Allow pop-ups for this site and click the bookmarklet again.'); return; }
    run(w);
  }
})();

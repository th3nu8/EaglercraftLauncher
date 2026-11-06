#!/usr/bin/env python3
"""
Run serve_local.py (unchanged) over HTTPS.

    python3 serve_https.py                 # runs ./serve_local.py
    python3 serve_https.py --port 8001     # options are passed to serve_local.py
    python3 serve_https.py other.py args   # runs another script

It reuses the certificate nginx already serves Mist with (found in /etc/nginx),
or set CERT=/path/fullchain.pem KEY=/path/privkey.pem yourself.
Works for servers built on Python's http.server / socketserver (incl. Flask's dev server).
"""
import glob, os, re, runpy, socket, socketserver, ssl, sys


def find_cert():
    cert, key = os.environ.get("CERT"), os.environ.get("KEY")
    if cert and key:
        return cert, key
    for conf in glob.glob("/etc/nginx/sites-enabled/*") + glob.glob("/etc/nginx/conf.d/*.conf"):
        try:
            text = open(conf).read()
        except OSError:
            continue
        c = re.search(r"^\s*ssl_certificate\s+([^;]+);", text, re.M)
        k = re.search(r"^\s*ssl_certificate_key\s+([^;]+);", text, re.M)
        if c and k:
            return c.group(1).strip(), k.group(1).strip()
    sys.exit("No certificate found. Run with CERT=/path/fullchain.pem KEY=/path/privkey.pem")


cert, key = find_cert()
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
print(f"[https] using {cert}", flush=True)

# Wrap each connection in TLS inside its handler thread (so a slow client can't
# stall the server). Plain http:// visits on the same port get a redirect to https://.
_orig_finish_request = socketserver.TCPServer.finish_request


def _redirect_plain_http(sock):
    try:
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 16384:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        lines = data.decode("latin-1").split("\r\n")
        path = lines[0].split(" ")[1] if len(lines[0].split(" ")) > 1 else "/"
        host = next((l.split(":", 1)[1].strip() for l in lines[1:] if l.lower().startswith("host:")), None)
        if not host:
            host = f"{sock.getsockname()[0]}:{sock.getsockname()[1]}"
        body = f"Use https://{host}{path}\n".encode()
        sock.sendall(
            f"HTTP/1.1 301 Moved Permanently\r\nLocation: https://{host}{path}\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body
        )
    except OSError:
        pass


def _tls_finish_request(self, request, client_address):
    request.settimeout(30)
    try:
        first = request.recv(1, socket.MSG_PEEK)
    except OSError:
        return
    if not first:
        return
    if first != b"\x16":                      # not a TLS handshake -> plain HTTP
        _redirect_plain_http(request)
        return
    try:
        tls = ctx.wrap_socket(request, server_side=True)
    except (ssl.SSLError, OSError):
        return                                 # bad/aborted handshake: drop quietly
    tls.settimeout(None)
    try:
        _orig_finish_request(self, tls, client_address)
    finally:
        try:
            tls.close()
        except OSError:
            pass


socketserver.TCPServer.finish_request = _tls_finish_request

# serve_local.py only listens on localhost; listen on every address so the
# server's public IP works too (set HOST=127.0.0.1 to keep it local-only).
BIND = os.environ.get("HOST", "0.0.0.0")
_orig_bind = socketserver.TCPServer.server_bind


def _public_bind(self):
    host, port = self.server_address[:2]
    if host in ("127.0.0.1", "localhost", "::1"):
        self.server_address = (BIND, port)
    _orig_bind(self)
    print(f"[https] listening on https://{self.server_address[0]}:{self.server_address[1]}/", flush=True)


socketserver.TCPServer.server_bind = _public_bind

# ---------------------------------------------------------------------------
# Mist overlay. The game needs the whole tab (COOP/COEP), so it can't run inside
# Mist. Instead, every page opened as the tab's main document gets Mist's top tab
# and a Shift+Tab overlay with "Back to game" / "Back to library".
# MIST_OVERLAY=0 turns it off.
import html as _html, io as _io, json as _json, http.server as _hs

MIST_OVERLAY = os.environ.get("MIST_OVERLAY", "1") != "0"
LIBRARY_URL = os.environ.get("MIST_LIBRARY_URL", "https://th3nu8.github.io/EaglercraftLauncher/play.html")
GAME_NAME = os.environ.get("MIST_GAME_NAME", "GTA 5")

_OVERLAY = """
<div id="mist-ov-root">
<style>
#mist-ov-tab{position:fixed;top:0;left:50%;transform:translate(-50%,-55%);z-index:2147483646;display:flex;align-items:center;gap:6px;
 background:rgba(23,26,33,.92);border:1px solid #3d4450;border-top:0;border-radius:0 0 8px 8px;padding:7px 16px 5px;
 font:700 12px/1 system-ui,Segoe UI,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#dcdedf;opacity:.7;cursor:pointer;
 transition:transform .15s,opacity .15s}
#mist-ov-tab.peek,#mist-ov-tab:hover{transform:translate(-50%,0);opacity:1}
#mist-ov{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;
 background:rgba(10,12,16,.82);backdrop-filter:blur(6px);font:15px system-ui,Segoe UI,sans-serif;color:#dcdedf}
#mist-ov.open{display:flex}
#mist-ov .box{background:#1b2028;border:1px solid #3d4450;border-radius:12px;padding:28px 32px;min-width:300px;text-align:center;box-shadow:0 20px 60px #000a}
#mist-ov h2{margin:0 0 4px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8f98a0}
#mist-ov h1{margin:0 0 22px;font-size:26px}
#mist-ov button{display:block;width:100%;margin:10px 0 0;padding:12px;border:0;border-radius:8px;font:700 15px system-ui,sans-serif;cursor:pointer;color:#fff;background:#3d4450}
#mist-ov button.go{background:#2e9a4a}#mist-ov button:hover{filter:brightness(1.15)}
#mist-ov p{margin:18px 0 0;font-size:12px;color:#8f98a0}
</style>
<div id="mist-ov-tab" title="Mist (Shift+Tab)">Mist</div>
<div id="mist-ov"><div class="box">
 <h2>Mist</h2><h1>__GAME__</h1>
 <button class="go" id="mist-ov-back">Back to game</button>
 <button id="mist-ov-lib">Back to library</button>
 <p>Shift+Tab or the Mist tab opens and closes this overlay.</p>
</div></div>
<script>
(function () {
  var LIB = __LIB__;
  var tab = document.getElementById('mist-ov-tab'), ov = document.getElementById('mist-ov');
  function toggle(open) {
    open = open === undefined ? !ov.classList.contains('open') : open;
    ov.classList.toggle('open', open);
    if (open && document.exitPointerLock) try { document.exitPointerLock(); } catch (e) {}
  }
  tab.onclick = function () { toggle(true); };
  document.getElementById('mist-ov-back').onclick = function () { toggle(false); };
  document.getElementById('mist-ov-lib').onclick = function () {
    if (confirm('Return to the library? Unsaved progress in the running game will be lost.')) location.href = LIB;
  };
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); toggle(); }
    else if (e.key === 'Escape' && ov.classList.contains('open')) { e.stopImmediatePropagation(); toggle(false); }
  }, true);
  document.addEventListener('mousemove', function (e) { tab.classList.toggle('peek', e.clientY < 30); });
  tab.classList.add('peek'); setTimeout(function () { tab.classList.remove('peek'); }, 3000);
})();
</script>
</div>
""".replace("__GAME__", _html.escape(GAME_NAME)).replace("__LIB__", _json.dumps(LIBRARY_URL))

_orig_send_head = _hs.SimpleHTTPRequestHandler.send_head


def _send_head_with_overlay(self):
    # Only the tab's main page (not files the game loads, not iframes).
    if not MIST_OVERLAY or self.headers.get("Sec-Fetch-Dest", "document") != "document":
        return _orig_send_head(self)
    path = self.translate_path(self.path)
    if os.path.isdir(path):
        if not self.path.split("?", 1)[0].endswith("/"):
            return _orig_send_head(self)          # let it do its usual trailing-slash redirect
        path = os.path.join(path, "index.html")
    if not path.lower().endswith((".html", ".htm")) or not os.path.isfile(path):
        return _orig_send_head(self)
    try:
        page = open(path, "rb").read()
    except OSError:
        return _orig_send_head(self)
    snippet = _OVERLAY.encode("utf-8")
    i = page.lower().rfind(b"</body>")
    page = page[:i] + snippet + page[i:] if i >= 0 else page + snippet
    self.send_response(200)
    self.send_header("Content-Type", "text/html; charset=utf-8")
    self.send_header("Content-Length", str(len(page)))
    self.send_header("Cache-Control", "no-cache")
    self.end_headers()                            # serve_local.py's COOP/COEP headers are added here
    return _io.BytesIO(page)


_hs.SimpleHTTPRequestHandler.send_head = _send_head_with_overlay

args = sys.argv[1:]
script = args.pop(0) if args and args[0].endswith(".py") else "serve_local.py"   # anything else (e.g. --port 8001) goes to the script
sys.argv = [script] + args
sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
runpy.run_path(script, run_name="__main__")

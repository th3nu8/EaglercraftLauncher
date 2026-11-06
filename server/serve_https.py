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
# Run inside Mist. The game needs SharedArrayBuffer (cross-origin isolation).
# COOP/COEP only isolate a page that has the whole tab, but Document-Isolation-Policy
# (Chrome/Edge 137+) isolates the game's own frame, so it can run in Mist's iframe.
import http.server as _hs

_orig_end_headers = _hs.SimpleHTTPRequestHandler.end_headers


def _end_headers_with_dip(self):
    if not any(h.lower().startswith(b"document-isolation-policy:") for h in getattr(self, "_headers_buffer", [])):
        self.send_header("Document-Isolation-Policy", "isolate-and-require-corp")
    _orig_end_headers(self)


_hs.SimpleHTTPRequestHandler.end_headers = _end_headers_with_dip


args = sys.argv[1:]
script = args.pop(0) if args and args[0].endswith(".py") else "serve_local.py"   # anything else (e.g. --port 8001) goes to the script
sys.argv = [script] + args
sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
runpy.run_path(script, run_name="__main__")

#!/usr/bin/env python3
"""
Mist PC — stream this PC into Mist on another device (a Mist Supporter perk).

What it does:
  * serves a small page on http://127.0.0.1:47800 and opens it in Chrome or Edge as an app window.
    The page shares the screen and sound over WebRTC (the browser does the video encoding) and talks
    to the Mist server to pair this PC and accept connections from your Mist account.
  * receives the viewer's mouse and keyboard from that page and presses them on this PC.

Run:   python mistpc.py            (or MistPC.exe)
Needs: Python 3.8+ and Chrome or Edge. Windows needs nothing else. On macOS/Linux, controls need
       `pip install pynput` (the screen still streams without it).

Only your own Mist account can connect: pairing uses a one-time code from Mist, and the Mist server
only sends this PC connections from the account that paired it. The page shows when someone is
connected, and has buttons to disconnect them or block the mouse and keyboard.
"""
import argparse, base64, hashlib, json, os, platform, shutil, socket, struct, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

VERSION = '1.0'
DEFAULT_SERVER = 'https://infoforscholars.com'
IS_WIN = sys.platform == 'win32'


def config_dir():
    if IS_WIN:
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
        return os.path.join(base, 'MistPC')
    return os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'mistpc')


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ---------------------------------------------------------------- settings
class Config:
    def __init__(self, path):
        self.path = path
        self.data = {}
        try:
            with open(path, 'r', encoding='utf-8') as f:
                self.data = json.load(f)
        except (OSError, ValueError):
            pass

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, indent=1)
        os.replace(tmp, self.path)
        if not IS_WIN:
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass


# ---------------------------------------------------------------- input: Windows (SendInput, scan codes)
# KeyboardEvent.code -> (scan code, extended key)
SCAN = {
    'Escape': (0x01, 0), 'Digit1': (0x02, 0), 'Digit2': (0x03, 0), 'Digit3': (0x04, 0), 'Digit4': (0x05, 0), 'Digit5': (0x06, 0),
    'Digit6': (0x07, 0), 'Digit7': (0x08, 0), 'Digit8': (0x09, 0), 'Digit9': (0x0A, 0), 'Digit0': (0x0B, 0), 'Minus': (0x0C, 0),
    'Equal': (0x0D, 0), 'Backspace': (0x0E, 0), 'Tab': (0x0F, 0), 'KeyQ': (0x10, 0), 'KeyW': (0x11, 0), 'KeyE': (0x12, 0),
    'KeyR': (0x13, 0), 'KeyT': (0x14, 0), 'KeyY': (0x15, 0), 'KeyU': (0x16, 0), 'KeyI': (0x17, 0), 'KeyO': (0x18, 0), 'KeyP': (0x19, 0),
    'BracketLeft': (0x1A, 0), 'BracketRight': (0x1B, 0), 'Enter': (0x1C, 0), 'ControlLeft': (0x1D, 0), 'KeyA': (0x1E, 0),
    'KeyS': (0x1F, 0), 'KeyD': (0x20, 0), 'KeyF': (0x21, 0), 'KeyG': (0x22, 0), 'KeyH': (0x23, 0), 'KeyJ': (0x24, 0), 'KeyK': (0x25, 0),
    'KeyL': (0x26, 0), 'Semicolon': (0x27, 0), 'Quote': (0x28, 0), 'Backquote': (0x29, 0), 'ShiftLeft': (0x2A, 0), 'Backslash': (0x2B, 0),
    'KeyZ': (0x2C, 0), 'KeyX': (0x2D, 0), 'KeyC': (0x2E, 0), 'KeyV': (0x2F, 0), 'KeyB': (0x30, 0), 'KeyN': (0x31, 0), 'KeyM': (0x32, 0),
    'Comma': (0x33, 0), 'Period': (0x34, 0), 'Slash': (0x35, 0), 'ShiftRight': (0x36, 0), 'NumpadMultiply': (0x37, 0), 'AltLeft': (0x38, 0),
    'Space': (0x39, 0), 'CapsLock': (0x3A, 0), 'F1': (0x3B, 0), 'F2': (0x3C, 0), 'F3': (0x3D, 0), 'F4': (0x3E, 0), 'F5': (0x3F, 0),
    'F6': (0x40, 0), 'F7': (0x41, 0), 'F8': (0x42, 0), 'F9': (0x43, 0), 'F10': (0x44, 0), 'NumLock': (0x45, 0), 'ScrollLock': (0x46, 0),
    'Numpad7': (0x47, 0), 'Numpad8': (0x48, 0), 'Numpad9': (0x49, 0), 'NumpadSubtract': (0x4A, 0), 'Numpad4': (0x4B, 0), 'Numpad5': (0x4C, 0),
    'Numpad6': (0x4D, 0), 'NumpadAdd': (0x4E, 0), 'Numpad1': (0x4F, 0), 'Numpad2': (0x50, 0), 'Numpad3': (0x51, 0), 'Numpad0': (0x52, 0),
    'NumpadDecimal': (0x53, 0), 'IntlBackslash': (0x56, 0), 'F11': (0x57, 0), 'F12': (0x58, 0),
    'NumpadEnter': (0x1C, 1), 'ControlRight': (0x1D, 1), 'NumpadDivide': (0x35, 1), 'PrintScreen': (0x37, 1), 'AltRight': (0x38, 1),
    'Home': (0x47, 1), 'ArrowUp': (0x48, 1), 'PageUp': (0x49, 1), 'ArrowLeft': (0x4B, 1), 'ArrowRight': (0x4D, 1), 'End': (0x4F, 1),
    'ArrowDown': (0x50, 1), 'PageDown': (0x51, 1), 'Insert': (0x52, 1), 'Delete': (0x53, 1), 'MetaLeft': (0x5B, 1), 'MetaRight': (0x5C, 1),
    'ContextMenu': (0x5D, 1),
}


class WinInput:
    name = 'Windows'

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))   # per-monitor v2: real pixels
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass
        ULONG_PTR = ctypes.c_size_t

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD),
                        ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ULONG_PTR)]

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                        ('time', wintypes.DWORD), ('dwExtraInfo', ULONG_PTR)]

        class HARDWAREINPUT(ctypes.Structure):
            _fields_ = [('uMsg', wintypes.DWORD), ('wParamL', wintypes.WORD), ('wParamH', wintypes.WORD)]

        class _U(ctypes.Union):
            _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [('type', wintypes.DWORD), ('u', _U)]

        self.MOUSEINPUT, self.KEYBDINPUT, self.INPUT = MOUSEINPUT, KEYBDINPUT, INPUT
        self.user32 = ctypes.windll.user32
        self.user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)

    def _send(self, *items):
        arr = (self.INPUT * len(items))(*items)
        self.user32.SendInput(len(items), arr, self.ctypes.sizeof(self.INPUT))

    def _mouse(self, flags, dx=0, dy=0, data=0):
        i = self.INPUT(type=0)
        i.u.mi = self.MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)
        self._send(i)

    def move_abs(self, x, y):          # 0..1 across the primary screen
        self._mouse(0x0001 | 0x8000, int(max(0, min(1, x)) * 65535), int(max(0, min(1, y)) * 65535))

    def move_rel(self, dx, dy):
        self._mouse(0x0001, int(dx), int(dy))

    def button(self, b, down):
        flags = {0: (0x0002, 0x0004), 1: (0x0020, 0x0040), 2: (0x0008, 0x0010), 3: (0x0080, 0x0100), 4: (0x0080, 0x0100)}.get(b)
        if not flags:
            return
        self._mouse(flags[0] if down else flags[1], data=(1 if b == 3 else 2) if b >= 3 else 0)

    def wheel(self, dx, dy):
        if dy:
            self._mouse(0x0800, data=int(-dy))
        if dx:
            self._mouse(0x1000, data=int(dx))

    def key(self, code, down):
        sc = SCAN.get(code)
        if not sc:
            return False
        flags = 0x0008 | (0x0001 if sc[1] else 0) | (0 if down else 0x0002)
        i = self.INPUT(type=1)
        i.u.ki = self.KEYBDINPUT(0, sc[0], flags, 0, 0)
        self._send(i)
        return True


# ---------------------------------------------------------------- input: macOS / Linux (pynput)
class PynputInput:
    name = 'pynput'

    def __init__(self):
        from pynput import mouse, keyboard
        self.m, self.kb = mouse.Controller(), keyboard.Controller()
        self.Button, self.Key, self.KeyCode = mouse.Button, keyboard.Key, keyboard.KeyCode
        self.size = None
        try:
            import tkinter
            r = tkinter.Tk(); r.withdraw(); self.size = (r.winfo_screenwidth(), r.winfo_screenheight()); r.destroy()
        except Exception:
            self.size = (1920, 1080)
        K = self.Key
        self.special = {'Escape': K.esc, 'Backspace': K.backspace, 'Tab': K.tab, 'Enter': K.enter, 'NumpadEnter': K.enter, 'Space': K.space,
                        'ShiftLeft': K.shift, 'ShiftRight': K.shift_r, 'ControlLeft': K.ctrl, 'ControlRight': K.ctrl_r, 'AltLeft': K.alt,
                        'AltRight': K.alt_r, 'MetaLeft': K.cmd, 'MetaRight': K.cmd_r, 'CapsLock': K.caps_lock, 'ArrowUp': K.up,
                        'ArrowDown': K.down, 'ArrowLeft': K.left, 'ArrowRight': K.right, 'Home': K.home, 'End': K.end,
                        'PageUp': K.page_up, 'PageDown': K.page_down, 'Delete': K.delete}
        for n in range(1, 13):
            self.special['F%d' % n] = getattr(K, 'f%d' % n)
        self.chars = {'Minus': '-', 'Equal': '=', 'BracketLeft': '[', 'BracketRight': ']', 'Backslash': '\\', 'Semicolon': ';', 'Quote': "'",
                      'Backquote': '`', 'Comma': ',', 'Period': '.', 'Slash': '/'}

    def move_abs(self, x, y):
        self.m.position = (int(x * self.size[0]), int(y * self.size[1]))

    def move_rel(self, dx, dy):
        self.m.move(int(dx), int(dy))

    def button(self, b, down):
        btn = {0: self.Button.left, 1: self.Button.middle, 2: self.Button.right}.get(b)
        if btn:
            (self.m.press if down else self.m.release)(btn)

    def wheel(self, dx, dy):
        self.m.scroll(int(dx / 100), int(-dy / 100) or (-1 if dy > 0 else 1 if dy < 0 else 0))

    def key(self, code, down):
        k = self.special.get(code)
        if k is None:
            if code.startswith('Key') and len(code) == 4:
                k = self.KeyCode.from_char(code[3].lower())
            elif code.startswith('Digit'):
                k = self.KeyCode.from_char(code[5])
            elif code in self.chars:
                k = self.KeyCode.from_char(self.chars[code])
        if k is None:
            return False
        (self.kb.press if down else self.kb.release)(k)
        return True


class LogInput:
    """Prints instead of pressing (--dry-run, or no way to control this computer)."""
    name = 'log only'

    def __init__(self):
        self.events = []

    def _e(self, *a):
        self.events.append(a)
        log('input', *a)

    def move_abs(self, x, y): self._e('abs', round(x, 3), round(y, 3))
    def move_rel(self, dx, dy): self._e('rel', dx, dy)
    def button(self, b, down): self._e('button', b, down)
    def wheel(self, dx, dy): self._e('wheel', dx, dy)
    def key(self, code, down): self._e('key', code, down); return True


class InputRouter:
    """Applies messages from the viewer and remembers what is held so it can let go when a viewer leaves."""

    def __init__(self, backend):
        self.b = backend
        self.keys, self.buttons = set(), set()
        self.lock = threading.Lock()

    def handle(self, m):
        t = m.get('t')
        with self.lock:
            if t == 'ma':
                self.b.move_abs(float(m.get('x', 0)), float(m.get('y', 0)))
            elif t == 'mr':
                dx, dy = int(m.get('dx', 0)), int(m.get('dy', 0))
                if abs(dx) < 5000 and abs(dy) < 5000:
                    self.b.move_rel(dx, dy)
            elif t == 'mb':
                b, d = int(m.get('b', 0)), bool(m.get('d'))
                if d and b in self.buttons:
                    return
                (self.buttons.add if d else self.buttons.discard)(b)
                self.b.button(b, d)
            elif t == 'w':
                self.b.wheel(float(m.get('dx', 0)), float(m.get('dy', 0)))
            elif t == 'k':
                code, d = str(m.get('code', ''))[:32], bool(m.get('d'))
                if not d and code not in self.keys:
                    return
                if self.b.key(code, d):
                    (self.keys.add if d else self.keys.discard)(code)
            elif t == 'release':
                self.release_all()

    def release_all(self):
        for code in list(self.keys):
            try:
                self.b.key(code, False)
            except Exception:
                pass
        for b in list(self.buttons):
            try:
                self.b.button(b, False)
            except Exception:
                pass
        self.keys.clear(); self.buttons.clear()


# ---------------------------------------------------------------- tiny WebSocket (server side, text frames)
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_accept(handler):
    key = handler.headers.get('Sec-WebSocket-Key', '')
    acc = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    handler.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                         'Sec-WebSocket-Accept: %s\r\n\r\n' % acc).encode())
    handler.wfile.flush()


def ws_read(rfile):
    """Next text message, or None when the socket closes."""
    buf = b''
    while True:
        h = rfile.read(2)
        if len(h) < 2:
            return None
        fin, op = h[0] & 0x80, h[0] & 0x0F
        masked, ln = h[1] & 0x80, h[1] & 0x7F
        if ln == 126:
            ln = struct.unpack('>H', rfile.read(2))[0]
        elif ln == 127:
            ln = struct.unpack('>Q', rfile.read(8))[0]
        if ln > 1 << 20:
            return None
        mask = rfile.read(4) if masked else b'\0\0\0\0'
        data = bytearray(rfile.read(ln))
        for i in range(len(data)):
            data[i] ^= mask[i % 4]
        if op == 8:
            return None
        if op in (9, 10):          # ping / pong: ignore (browsers don't ping)
            continue
        buf += bytes(data)
        if fin:
            return buf.decode('utf-8', 'replace')


# ---------------------------------------------------------------- local web server
class App:
    def __init__(self, args):
        self.args = args
        self.cfg = Config(os.path.join(config_dir(), 'config.json'))
        if args.server:
            self.cfg.data['server'] = args.server
        self.cfg.data.setdefault('server', DEFAULT_SERVER)
        self.cfg.data.setdefault('name', socket.gethostname()[:40] or 'My PC')
        self.origin = 'http://127.0.0.1:%d' % args.port
        self.page_cache = None
        if args.dry_run:
            backend = LogInput()
        elif IS_WIN:
            backend = WinInput()
        else:
            try:
                backend = PynputInput()
            except Exception as e:
                log('Mouse and keyboard control needs pynput on this system (pip install pynput):', e)
                backend = LogInput()
        self.input = InputRouter(backend)
        log('Controls:', backend.name)

    def host_page(self):
        """The page comes from the Mist server (so it stays up to date), or the copy shipped with this helper."""
        server = self.cfg.data.get('server') or DEFAULT_SERVER
        if self.page_cache and time.time() - self.page_cache[0] < 600:
            return self.page_cache[1]
        try:
            with urlopen(Request(server.rstrip('/') + '/pc/host.html', headers={'User-Agent': 'MistPC/' + VERSION}), timeout=8) as r:
                html = r.read()
            if b'Mist PC' in html:
                self.page_cache = (time.time(), html)
                return html
        except Exception as e:
            log('Using the built-in page (couldn\'t get it from %s: %s)' % (server, e))
        for base in (getattr(sys, '_MEIPASS', ''), os.path.dirname(os.path.abspath(__file__))):
            p = os.path.join(base, 'host.html')
            if base and os.path.exists(p):
                with open(p, 'rb') as f:
                    return f.read()
        return b'<!doctype html><title>Mist PC</title><p>Couldn\'t load the Mist PC page. Check your internet connection and restart MistPC.'


def make_handler(app):
    class H(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'MistPC/' + VERSION

        def log_message(self, *a):
            pass

        def _local_only(self):
            # refuse other websites (and DNS rebinding): only our own page on 127.0.0.1 may talk to us
            host = self.headers.get('Host', '')
            origin = self.headers.get('Origin')
            if host != '127.0.0.1:%d' % app.args.port or (origin and origin != app.origin):
                self.send_error(403)
                return False
            return True

        def _send(self, code, body, ctype='application/json'):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._local_only():
                return
            path = self.path.split('?')[0]
            if path in ('/', '/index.html'):
                return self._send(200, app.host_page(), 'text/html; charset=utf-8')
            if path == '/config':
                d = dict(app.cfg.data)
                d['hostname'] = socket.gethostname()[:40]
                d['version'] = VERSION
                d['controls'] = app.input.b.name
                return self._send(200, d)
            if path == '/input' and self.headers.get('Upgrade', '').lower() == 'websocket':
                ws_accept(self)
                log('Controls connected')
                try:
                    while True:
                        msg = ws_read(self.rfile)
                        if msg is None:
                            break
                        try:
                            app.input.handle(json.loads(msg))
                        except (ValueError, TypeError, OSError) as e:
                            log('bad input message:', e)
                finally:
                    app.input.release_all()
                    log('Controls disconnected')
                self.close_connection = True
                return
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            if not self._local_only() or self.headers.get('Origin') != app.origin:
                if not self.wfile.closed:
                    try:
                        self.send_error(403)
                    except Exception:
                        pass
                return
            if self.path != '/config':
                return self._send(404, {'error': 'not found'})
            n = int(self.headers.get('Content-Length') or 0)
            try:
                body = json.loads(self.rfile.read(min(n, 65536)) or b'{}')
            except ValueError:
                return self._send(400, {'error': 'bad json'})
            for k in ('server', 'device', 'token', 'name', 'owner'):
                if k in body and isinstance(body[k], str):
                    app.cfg.data[k] = body[k][:200]
            if 'server' in body:
                app.page_cache = None
            app.cfg.save()
            log('Paired as "%s"' % app.cfg.data.get('name') if app.cfg.data.get('token') else 'Unpaired')
            return self._send(200, {'ok': True})

    return H


# ---------------------------------------------------------------- browser
def find_browser():
    names = []
    if IS_WIN:
        pf = [os.environ.get(k) for k in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA') if os.environ.get(k)]
        for base in pf:
            names += [os.path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                      os.path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                      os.path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
    elif sys.platform == 'darwin':
        names += ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    for n in names:
        if os.path.exists(n):
            return n
    for n in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge'):
        p = shutil.which(n)
        if p:
            return p
    return None


def open_window(app):
    b = find_browser()
    url = app.origin + '/'
    if not b:
        log('Chrome or Edge not found. Open %s in Chrome or Edge yourself.' % url)
        return None
    profile = os.path.join(config_dir(), 'browser')
    args = [b, '--app=' + url, '--user-data-dir=' + profile, '--window-size=520,640', '--no-first-run', '--no-default-browser-check',
            # share the whole screen without asking every time, and keep streaming while minimised
            '--auto-select-desktop-capture-source=' + app.args.screen,
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
            '--autoplay-policy=no-user-gesture-required']
    log('Opening the Mist PC window (%s)' % os.path.basename(b))
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser(description='Stream this PC into Mist (Mist Supporter perk).')
    ap.add_argument('--server', help='Mist server address (default: the one you paired with, or %s)' % DEFAULT_SERVER)
    ap.add_argument('--port', type=int, default=47800, help='local port for the Mist PC window (default 47800)')
    ap.add_argument('--screen', default='Entire screen', help='which screen to share; with several monitors use "Screen 1", "Screen 2"...')
    ap.add_argument('--no-window', action='store_true', help='don\'t open the browser window')
    ap.add_argument('--dry-run', action='store_true', help='print mouse and keyboard input instead of using it')
    ap.add_argument('--check', action='store_true', help='test that mouse and keyboard control loads, then exit')
    args = ap.parse_args()

    if args.check:   # used by the build: loads the real input code and sends harmless input
        r = InputRouter(WinInput() if IS_WIN else PynputInput())
        r.handle({'t': 'mr', 'dx': 0, 'dy': 0})
        r.handle({'t': 'k', 'code': 'ShiftLeft', 'd': 1}); r.handle({'t': 'k', 'code': 'ShiftLeft', 'd': 0})
        r.handle({'t': 'release'})
        print('input check ok:', r.b.name)
        return

    app = App(args)
    try:
        srv = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(app))
    except OSError:
        log('Mist PC is already running (port %d is in use). Look for its window.' % args.port)
        if not args.no_window:
            open_window(app)
        return
    srv.daemon_threads = True
    log('Mist PC %s on %s (%s)' % (VERSION, app.origin, platform.system()))
    log('Mist server:', app.cfg.data.get('server'), '| paired:', 'yes (' + app.cfg.data.get('name', '') + ')' if app.cfg.data.get('token') else 'no')
    if not args.no_window:
        threading.Timer(0.4, open_window, (app,)).start()
    log('Leave this running. Close it to stop sharing.')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.input.release_all()


if __name__ == '__main__':
    main()

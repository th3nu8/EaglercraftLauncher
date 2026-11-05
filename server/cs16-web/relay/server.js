// CS 1.6 browser relay: WebSocket <-> UDP.
//
// Browsers can't speak UDP, so each browser player opens one WebSocket here and
// the relay gives them their own UDP socket towards an allowlisted game server.
//
// Frame format (binary, both directions):
//   [0..3]  IPv4 address (virtual, as the engine sees it)
//   [4..5]  port, big-endian
//   [6.. ]  raw UDP payload
//
// The browser only ever sees "virtual" addresses (e.g. 10.27.0.1:27015). The relay
// maps them to real targets from config.json, so it can never be used as an open
// UDP proxy to arbitrary hosts.

'use strict';

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const CONFIG_PATH = process.env.RELAY_CONFIG || path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const LISTEN_HOST = cfg.listen?.host ?? '127.0.0.1';
const LISTEN_PORT = cfg.listen?.port ?? 7080;
const TRUST_PROXY = cfg.trustProxy ?? true;           // read CF-Connecting-IP / X-Forwarded-For
const ALLOWED_ORIGINS = cfg.allowedOrigins ?? [];      // [] = allow any origin
const MAX_CONNS_PER_IP = cfg.maxConnsPerIp ?? 16;   // shared school/office IPs need headroom
const MAX_CONNS_TOTAL = cfg.maxConnsTotal ?? 64;
const MAX_PACKET = cfg.maxPacketBytes ?? 8192;
const MAX_PPS = cfg.maxPacketsPerSecond ?? 1500;       // per connection, browser -> server
const IDLE_MS = cfg.idleTimeoutMs ?? 60_000;

// ---- address helpers ---------------------------------------------------------

function parseAddr(s) {
    const [host, portStr] = String(s).split(':');
    const port = Number(portStr);
    const ip = host.split('.').map(Number);
    if (ip.length !== 4 || ip.some(n => !(n >= 0 && n <= 255)) || !(port > 0 && port < 65536)) {
        throw new Error(`Bad address "${s}" (expected a.b.c.d:port)`);
    }
    return { ip, host, port, key: `${host}:${port}` };
}

const servers = (cfg.servers ?? []).map(s => ({
    name: s.name,
    virtual: parseAddr(s.virtual),
    target: parseAddr(s.target),
}));
if (servers.length === 0) throw new Error('config.servers is empty');

const byVirtual = new Map(servers.map(s => [s.virtual.key, s]));
const byTarget = new Map(servers.map(s => [s.target.key, s]));

const publicList = servers.map(s => ({ name: s.name, address: s.virtual.key }));

// ---- HTTP (health + server list) ---------------------------------------------

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
    }
    if (req.url === '/servers') {
        res.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
        });
        return res.end(JSON.stringify({ servers: publicList }));
    }
    res.writeHead(404);
    res.end();
});

// ---- WebSocket relay ---------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PACKET + 6 });

function clientIp(req) {
    if (TRUST_PROXY) {
        const cf = req.headers['cf-connecting-ip'];
        if (cf) return String(cf);
        const xff = req.headers['x-forwarded-for'];
        if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

// ---- WebRTC (UDP-like transport) ----------------------------------------------
// WebSocket = TCP: one lost packet on the player's Wi-Fi stalls everything behind it
// (rubber-banding, "stuck in rocks"). An unordered, no-retransmit WebRTC data channel
// behaves like UDP — late packets are simply skipped. The WebSocket stays as the
// signalling channel and as an automatic fallback when UDP is blocked.
const RTC_CFG = cfg.rtc ?? {};
let ndc = null;
if (RTC_CFG.enabled !== false) {
    try {
        ndc = require('node-datachannel');
    } catch (e) {
        console.warn('node-datachannel not installed — WebRTC disabled, WebSocket only. (npm install node-datachannel)');
    }
}
const RTC_PORT = RTC_CFG.port ?? 27100;
const RTC_ICE = RTC_CFG.iceServers ?? ['stun:stun.l.google.com:19302'];

function rtcConfig() {
    const c = {
        iceServers: RTC_ICE,
        // One UDP port for every player (only this port needs opening in the firewall).
        enableIceUdpMux: true,
        portRangeBegin: RTC_PORT,
        portRangeEnd: RTC_PORT,
        maxMessageSize: 65536,
    };
    if (RTC_CFG.bindAddress) c.bindAddress = RTC_CFG.bindAddress;
    return c;
}

function closeRtc(s) {
    try { s.dc?.close(); } catch { /* gone */ }
    try { s.pc?.close(); } catch { /* gone */ }
    s.dc = null;
    s.pc = null;
}

function startRtc(s, ws, offerSdp) {
    if (!ndc) return ws.send(JSON.stringify({ type: 'rtc-unavailable' }));
    closeRtc(s);
    let pc;
    try {
        pc = new ndc.PeerConnection(`p${s.id}`, rtcConfig());
    } catch (e) {
        log(`#${s.id} webrtc init failed: ${e.message}`);
        return ws.send(JSON.stringify({ type: 'rtc-unavailable' }));
    }
    s.pc = pc;
    const sendWs = (obj) => { if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(obj)); };

    pc.onLocalDescription((sdp, type) => sendWs({ type: 'rtc-answer', sdp, sdpType: type }));
    pc.onLocalCandidate((candidate, mid) => sendWs({ type: 'rtc-candidate', candidate, mid }));
    pc.onStateChange((state) => {
        if (s.pc !== pc) return;
        if (state === 'failed' || state === 'closed') {
            log(`#${s.id} webrtc ${state} — using WebSocket`);
            closeRtc(s);
        }
    });
    pc.onDataChannel((dc) => {
        if (s.pc !== pc) return dc.close();
        s.dc = dc;
        dc.onOpen?.(() => log(`#${s.id} webrtc open (udp transport)`));
        log(`#${s.id} webrtc data channel up (udp transport)`);
        dc.onMessage((msg) => {
            if (typeof msg === 'string') return handleText(s, msg, (o) => { try { dc.sendMessage(JSON.stringify(o)); } catch { /* closed */ } });
            handleClientFrame(s, msg);
        });
        dc.onClosed(() => {
            if (s.dc === dc) { s.dc = null; log(`#${s.id} webrtc channel closed — using WebSocket`); }
        });
    });
    try {
        pc.setRemoteDescription(offerSdp, 'offer');
    } catch (e) {
        log(`#${s.id} bad offer: ${e.message}`);
        closeRtc(s);
        sendWs({ type: 'rtc-unavailable' });
    }
}

// Shared by WebSocket and data channel: browser -> game server.
function handleClientFrame(s, buf) {
    if (buf.length < 7 || buf.length > MAX_PACKET + 6) return;
    const now = Date.now();
    s.lastActivity = now;
    if (now - s.windowStart >= 1000) { s.windowStart = now; s.windowCount = 0; }
    if (++s.windowCount > MAX_PPS) return;
    const key = `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}:${buf.readUInt16BE(4)}`;
    const srv = byVirtual.get(key);
    if (!srv) return;
    s.udp.send(buf.subarray(6), srv.target.port, srv.target.host);
}

// Shared control messages (latency probe works on either transport).
function handleText(s, text, reply) {
    if (text.length > 20000) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'ping' && typeof msg.t === 'number') return reply({ type: 'pong', t: msg.t, via: msg.via });
    if (msg.type === 'rtc-offer' && typeof msg.sdp === 'string' && s.ws) return startRtc(s, s.ws, msg.sdp);
    if (msg.type === 'rtc-candidate' && typeof msg.candidate === 'string' && s.pc) {
        try { s.pc.addRemoteCandidate(msg.candidate, String(msg.mid ?? '0')); } catch { /* stale */ }
    }
}

// ---- Sessions ----------------------------------------------------------------
// A session owns the UDP socket (and therefore the source port the game server knows
// the player by). If the WebSocket drops, the page reconnects with the same ?sid=
// and gets the SAME UDP socket back, so the server never sees a "new" client.
// Without this, any WebSocket blip leaves the player connected-but-frozen.
const RESUME_MS = cfg.resumeWindowMs ?? 60_000;
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const sessions = new Map();     // sid -> session
const sessionsPerIp = new Map();
let nextId = 1;

// ---- Per-player loopback address ---------------------------------------------
// The game server decides "is this a reconnect of an existing player?" by comparing
// the IP (ignoring port) plus a random client "qport". If every player arrived from
// 127.0.0.1, a qport collision made a new player take over (kick) someone else's slot.
// Linux routes all of 127.0.0.0/8 to loopback, so each session binds its own 127.a.b.c
// and the server sees every player as a distinct IP.
// Only possible when every target is on this machine (a 127.x socket can't reach other hosts).
const UNIQUE_LOOPBACK = (cfg.uniqueLoopback ?? (process.platform === 'linux'))
    && servers.every(sv => sv.target.ip[0] === 127);
const usedLoopback = new Set();
function allocLoopback() {
    if (!UNIQUE_LOOPBACK) return undefined;
    for (let i = 0; i < 1000; i++) {
        const a = `127.${1 + Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
        if (!usedLoopback.has(a)) { usedLoopback.add(a); return a; }
    }
    return undefined;
}

function createSession(sid, ip) {
    const bindAddr = allocLoopback();
    const s = {
        id: nextId++, sid, ip, bindAddr,
        udp: dgram.createSocket('udp4'),
        ws: null, expireTimer: null,
        pc: null, dc: null,
        windowStart: Date.now(), windowCount: 0,
        lastActivity: Date.now(),
    };
    sessions.set(sid, s);
    sessionsPerIp.set(ip, (sessionsPerIp.get(ip) ?? 0) + 1);

    s.udp.bind({ port: 0, address: bindAddr }, () => {
        // Server logs show this address for the player; this line maps it to a real IP.
        const a = s.udp.address();
        log(`#${s.id} session ${ip} -> ${a.address}:${a.port}`);
    });
    s.udp.on('message', (msg, rinfo) => {
        const srv = byTarget.get(`${rinfo.address}:${rinfo.port}`);
        if (!srv) return;
        const frame = Buffer.allocUnsafe(6 + msg.length);
        frame[0] = srv.virtual.ip[0]; frame[1] = srv.virtual.ip[1];
        frame[2] = srv.virtual.ip[2]; frame[3] = srv.virtual.ip[3];
        frame.writeUInt16BE(srv.virtual.port, 4);
        msg.copy(frame, 6);
        // Prefer the UDP-like data channel; fall back to the WebSocket.
        if (s.dc && s.dc.isOpen()) {
            try { if (s.dc.sendMessageBinary(frame)) return; } catch { /* fall through */ }
        }
        if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.send(frame);
        // else: dropped, exactly like real UDP
    });
    s.udp.on('error', (e) => {
        log(`#${s.id} udp error: ${e.message}`);
        destroySession(s);
    });
    return s;
}

function destroySession(s) {
    if (!sessions.has(s.sid)) return;
    sessions.delete(s.sid);
    if (s.bindAddr) usedLoopback.delete(s.bindAddr);
    clearTimeout(s.expireTimer);
    try { s.udp.close(); } catch { /* already closed */ }
    try { s.ws?.terminate(); } catch { /* already closed */ }
    closeRtc(s);
    const n = (sessionsPerIp.get(s.ip) ?? 1) - 1;
    if (n <= 0) sessionsPerIp.delete(s.ip); else sessionsPerIp.set(s.ip, n);
    log(`#${s.id} session ended (${s.ip})`);
}

// End a session RESUME_MS after its WebSocket closed — unless the WebRTC channel is
// still carrying game traffic (it doesn't depend on the WebSocket once it's up).
function scheduleExpire(s) {
    clearTimeout(s.expireTimer);
    s.expireTimer = setTimeout(() => {
        if (s.ws) return; // resumed meanwhile
        if (s.dc && s.dc.isOpen() && Date.now() - s.lastActivity < IDLE_MS) return scheduleExpire(s);
        destroySession(s);
    }, RESUME_MS);
}

wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const origin = req.headers.origin || '';

    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
        log(`reject ${ip}: origin "${origin}" not allowed`);
        return ws.close(1008, 'origin not allowed');
    }

    let sid = null;
    try { sid = new URL(req.url, 'http://x').searchParams.get('sid'); } catch { /* bad url */ }
    if (!sid || !SID_RE.test(sid)) sid = require('crypto').randomBytes(18).toString('base64url');

    // The sid is a 144-bit random secret, so it alone proves ownership. We deliberately
    // don't require the same IP: school/office/mobile networks often rotate between
    // several public IPs, and a reconnect from the "other" one must still resume.
    let s = sessions.get(sid);

    if (s) {
        clearTimeout(s.expireTimer);
        s.expireTimer = null;
        if (s.ws && s.ws !== ws) {
            const old = s.ws;
            s.ws = null;              // detach first so its close handler doesn't expire us
            try { old.terminate(); } catch { /* gone */ }
        }
        log(`#${s.id} resumed ${ip}${ip !== s.ip ? ` (was ${s.ip})` : ''} — same udp port, no rejoin needed`);
    } else {
        if (sessions.size >= MAX_CONNS_TOTAL) {
            log(`reject ${ip}: relay full`);
            return ws.close(1013, 'relay full');
        }
        if ((sessionsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
            log(`reject ${ip}: too many sessions from this IP`);
            return ws.close(1008, 'too many connections');
        }
        s = createSession(sid, ip);
        log(`#${s.id} open ${ip} origin="${origin}"`);
    }

    s.ws = ws;
    s.lastActivity = Date.now();
    ws.send(JSON.stringify({ type: 'servers', servers: publicList, sid, rtc: !!ndc }));

    ws.on('message', (data, isBinary) => {
        if (!isBinary) return handleText(s, data.toString(), (o) => ws.send(JSON.stringify(o)));
        handleClientFrame(s, Buffer.isBuffer(data) ? data : Buffer.concat(data));
    });

    const pinger = setInterval(() => {
        if (s.ws !== ws) return clearInterval(pinger);
        if (Date.now() - s.lastActivity > IDLE_MS) {
            log(`#${s.id} idle timeout`);
            return ws.terminate();
        }
        if (ws.readyState === ws.OPEN) ws.ping();
    }, 15_000);

    ws.on('close', (code, reason) => {
        clearInterval(pinger);
        if (s.ws !== ws) return; // replaced by a newer connection
        s.ws = null;
        log(`#${s.id} websocket closed (code ${code}${reason?.length ? ', ' + reason : ''}) — keeping session ${RESUME_MS / 1000}s for resume`);
        scheduleExpire(s);
    });
    ws.on('error', (e) => log(`#${s.id} websocket error: ${e.message}`));
});

httpServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log(`relay listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
    log(ndc ? `webrtc enabled on udp ${RTC_PORT} (open this port in the firewall)` : 'webrtc disabled — WebSocket only');
    for (const s of servers) log(`  ${s.name}: ${s.virtual.key} -> ${s.target.key}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log('shutting down'); process.exit(0); });
}

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
const MAX_CONNS_PER_IP = cfg.maxConnsPerIp ?? 4;
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
const connsPerIp = new Map();
let totalConns = 0;
let nextId = 1;

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

wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const origin = req.headers.origin || '';
    const id = nextId++;

    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
        log(`#${id} reject ${ip}: origin "${origin}" not allowed`);
        return ws.close(1008, 'origin not allowed');
    }
    if (totalConns >= MAX_CONNS_TOTAL) {
        log(`#${id} reject ${ip}: relay full`);
        return ws.close(1013, 'relay full');
    }
    if ((connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
        log(`#${id} reject ${ip}: too many connections from this IP`);
        return ws.close(1008, 'too many connections');
    }

    totalConns++;
    connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);

    const udp = dgram.createSocket('udp4');
    let closed = false;
    let lastActivity = Date.now();
    let windowStart = Date.now();
    let windowCount = 0;

    udp.bind(0, () => {
        // Log the UDP port so server-side logs (which only see 127.0.0.1:<port>)
        // can be matched back to the real player IP.
        log(`#${id} open ${ip} origin="${origin}" -> udp :${udp.address().port}`);
    });

    // Tell the page which servers it can join.
    ws.send(JSON.stringify({ type: 'servers', servers: publicList }));

    udp.on('message', (msg, rinfo) => {
        // Only forward replies from configured targets; drop anything else.
        const srv = byTarget.get(`${rinfo.address}:${rinfo.port}`);
        if (!srv || ws.readyState !== ws.OPEN) return;
        const frame = Buffer.allocUnsafe(6 + msg.length);
        frame[0] = srv.virtual.ip[0];
        frame[1] = srv.virtual.ip[1];
        frame[2] = srv.virtual.ip[2];
        frame[3] = srv.virtual.ip[3];
        frame.writeUInt16BE(srv.virtual.port, 4);
        msg.copy(frame, 6);
        ws.send(frame);
    });

    udp.on('error', (e) => {
        log(`#${id} udp error: ${e.message}`);
        cleanup();
    });

    ws.on('message', (data, isBinary) => {
        if (!isBinary) return; // text frames are ignored (reserved)
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
        if (buf.length < 7 || buf.length > MAX_PACKET + 6) return;

        const now = Date.now();
        lastActivity = now;
        if (now - windowStart >= 1000) { windowStart = now; windowCount = 0; }
        if (++windowCount > MAX_PPS) return; // drop, don't kill — bursts happen on connect

        const key = `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}:${buf.readUInt16BE(4)}`;
        const srv = byVirtual.get(key);
        if (!srv) return; // not an allowlisted server

        udp.send(buf.subarray(6), srv.target.port, srv.target.host);
    });

    const pinger = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_MS) {
            log(`#${id} idle timeout`);
            return ws.terminate();
        }
        if (ws.readyState === ws.OPEN) ws.ping();
    }, 15_000);

    function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(pinger);
        try { udp.close(); } catch { /* already closed */ }
        try { ws.terminate(); } catch { /* already closed */ }
        totalConns--;
        const n = (connsPerIp.get(ip) ?? 1) - 1;
        if (n <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, n);
        log(`#${id} closed ${ip}`);
    }

    ws.on('close', cleanup);
    ws.on('error', cleanup);
});

httpServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log(`relay listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
    for (const s of servers) log(`  ${s.name}: ${s.virtual.key} -> ${s.target.key}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log('shutting down'); process.exit(0); });
}

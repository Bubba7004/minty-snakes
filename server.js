#!/usr/bin/env node
/*
 * server.js - tiny LAN server for slither.io (local multiplayer edition)
 *
 *   node server.js [port]        (default port 8080, or set PORT)
 *
 * It does two things and has ZERO dependencies:
 *   1. serves the game files from this folder
 *   2. relays room traffic between the room's host browser and its guests
 *      using plain HTTP (Server-Sent Events down, POST up) - no WebSockets.
 *
 * The game simulation itself runs inside the HOST's browser, this server only
 * keeps the list of rooms, hands out short room codes and passes bytes along.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = +(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const HOST_GRACE_MS = 10000;   // how long a room survives without its host connected
const MAX_BODY = 4 * 1024 * 1024;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};
const HIDDEN = new Set(['server.js', 'package.json', 'readme.md', 'start.sh', 'start.bat']);

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();

function newCode() {
    for (;;) {
        let c = '';
        for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        if (!rooms.has(c)) return c;
    }
}
function cleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); }
function lanUrls() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) for (const a of ifs[k] || [])
        if (a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + PORT + '/');
    return out;
}
function sse(res, line) { try { res.write('data: ' + line + '\n\n'); } catch (e) { /* closed */ } }
function toHost(room, line) {
    if (room.hostRes) sse(room.hostRes, line);
    else if (room.hostQueue.length < 2000) room.hostQueue.push(line);
}
function closeRoom(room, why) {
    if (!rooms.has(room.code)) return;
    rooms.delete(room.code);
    for (const res of room.guests.values()) { sse(res, 'c:' + why); try { res.end(); } catch (e) {} }
    room.guests.clear();
    if (room.hostRes) { try { room.hostRes.end(); } catch (e) {} room.hostRes = null; }
}
setInterval(() => {
    const t = Date.now();
    for (const room of [...rooms.values()])
        if (!room.hostRes && t - room.lastHostSeen > HOST_GRACE_MS) closeRoom(room, 'host-left');
}, 2000).unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
    cors(res);
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
}
function readBody(req, cb) {
    const chunks = []; let n = 0, dead = false;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { dead = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!dead) cb(Buffer.concat(chunks)); });
    req.on('error', () => {});
}
function readJson(req, cb) {
    readBody(req, b => { let o = {}; try { o = JSON.parse(b.toString('utf8') || '{}'); } catch (e) {} cb(o || {}); });
}
function sseOpen(req, res) {
    cors(res);
    if (req.socket) { req.socket.setNoDelay(true); req.socket.setTimeout(0); }
    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 600000\n\n');
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 15000);
    res.on('close', () => clearInterval(ka));
}
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max); }

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function api(req, res, u) {
    const p = u.pathname, q = u.searchParams;
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    if (p === '/api/info') return json(res, 200, { v: 1, port: PORT, urls: lanUrls() });

    if (p === '/api/rooms' && req.method === 'GET') {
        const list = [];
        for (const r of rooms.values()) if (r.info.pub && r.hostRes) list.push({
            code: r.code, name: r.info.name, host: r.info.host, players: r.info.players,
            max: r.info.max, bots: r.info.bots, started: r.info.started
        });
        return json(res, 200, list);
    }

    if (p === '/api/rooms' && req.method === 'POST') {
        return readJson(req, o => {
            if (rooms.size >= 200) return json(res, 503, { error: 'too many rooms' });
            const room = {
                code: newCode(), token: crypto.randomBytes(12).toString('hex'),
                info: { name: str(o.name, 32) || 'Room', host: str(o.host, 24) || 'Host',
                    max: Math.max(1, Math.min(32, +o.max || 8)), bots: Math.max(0, Math.min(80, +o.bots || 0)),
                    pub: !!o.pub, players: 1, started: false },
                hostRes: null, hostQueue: [], guests: new Map(), pending: new Map(), nextCid: 1,
                lastHostSeen: Date.now()
            };
            rooms.set(room.code, room);
            json(res, 200, { code: room.code, token: room.token });
        });
    }

    if (p === '/api/join' && req.method === 'POST') {
        return readJson(req, o => {
            const room = rooms.get(cleanCode(o.code));
            if (!room || !room.hostRes) return json(res, 404, { error: 'No room with that code' });
            if (room.info.players >= room.info.max) return json(res, 409, { error: 'Room is full' });
            const cid = room.nextCid++;
            room.pending.set(cid, Date.now());
            json(res, 200, { cid, code: room.code, name: room.info.name });
        });
    }

    // ---- host side ----
    const room = rooms.get(cleanCode(q.get('room')));
    if (p.startsWith('/api/h/')) {
        if (!room || room.token !== q.get('token')) return json(res, 404, { error: 'no such room' });
        if (p === '/api/h/events') {
            sseOpen(req, res);
            if (room.hostRes) { try { room.hostRes.end(); } catch (e) {} }
            room.hostRes = res;
            const queued = room.hostQueue; room.hostQueue = [];
            sse(res, 'ready');
            for (const l of queued) sse(res, l);
            // ids that joined while the host was away must be re-announced
            res.on('close', () => { if (room.hostRes === res) { room.hostRes = null; room.lastHostSeen = Date.now(); } });
            return;
        }
        if (p === '/api/h/info') return readJson(req, o => {
            const i = room.info;
            if (o.name != null) i.name = str(o.name, 32) || i.name;
            if (o.host != null) i.host = str(o.host, 24) || i.host;
            if (o.max != null) i.max = Math.max(1, Math.min(32, +o.max || i.max));
            if (o.bots != null) i.bots = Math.max(0, Math.min(80, +o.bots || 0));
            if (o.players != null) i.players = Math.max(1, +o.players || 1);
            if (o.started != null) i.started = !!o.started;
            if (o.pub != null) i.pub = !!o.pub;
            json(res, 200, { ok: 1 });
        });
        if (p === '/api/h/close') { closeRoom(room, 'host-left'); return json(res, 200, { ok: 1 }); }
        if (p === '/api/h/send') return readBody(req, b => {
            // body = ([u16 cid][u32 len][bytes])*
            let m = 0;
            while (m + 6 <= b.length) {
                const cid = b.readUInt16BE(m), len = b.readUInt32BE(m + 2); m += 6;
                if (m + len > b.length) break;
                const g = room.guests.get(cid);
                if (g) sse(g, 'm:' + b.toString('base64', m, m + len));
                m += len;
            }
            cors(res); res.writeHead(204); res.end();
        });
        return json(res, 404, { error: 'unknown' });
    }

    // ---- guest side ----
    if (p.startsWith('/api/g/')) {
        const cid = +q.get('cid');
        if (!room) return json(res, 404, { error: 'no such room' });
        if (p === '/api/g/events') {
            if (!room.pending.has(cid)) return json(res, 404, { error: 'bad id' });
            room.pending.delete(cid);
            sseOpen(req, res);
            room.guests.set(cid, res);
            sse(res, 'ready');
            toHost(room, 'j:' + cid);
            res.on('close', () => {
                if (room.guests.get(cid) === res) { room.guests.delete(cid); toHost(room, 'l:' + cid); }
            });
            return;
        }
        if (p === '/api/g/send') {
            if (!room.guests.has(cid)) return json(res, 404, { error: 'not joined' });
            return readBody(req, b => {
                toHost(room, 'm:' + cid + ':' + b.toString('base64'));
                cors(res); res.writeHead(204); res.end();
            });
        }
        if (p === '/api/g/leave') { room.guests.get(cid) && room.guests.get(cid).end(); return json(res, 200, { ok: 1 }); }
    }
    return json(res, 404, { error: 'unknown endpoint' });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
function serveStatic(req, res, u) {
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    const base = path.basename(file).toLowerCase();
    if (!file.startsWith(ROOT + path.sep) || base[0] === '.' || HIDDEN.has(base)) { res.writeHead(404); return res.end('Not found'); }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': st.size, 'Cache-Control': 'no-cache'
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    });
}

const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    try {
        if (u.pathname.startsWith('/api/')) return api(req, res, u);
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        serveStatic(req, res, u);
    } catch (e) {
        console.error(e);
        try { res.writeHead(500); res.end('error'); } catch (e2) {}
    }
});
server.keepAliveTimeout = 60000;
server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Try: node server.js ' + (PORT + 1));
    else console.error(e);
    process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Slither LAN is running!\n');
    console.log('  On this computer : http://localhost:' + PORT + '/');
    const l = lanUrls();
    if (l.length) l.forEach(x => console.log('  Friends on Wi-Fi : ' + x));
    else console.log('  (no network interface found - are you connected to Wi-Fi?)');
    console.log('\n  Open the link, press Multiplayer, create a room and share the 4-letter code.');
    console.log('  Press Ctrl+C to stop.\n');
});

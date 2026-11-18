/*
 * net.js - local-network rooms for slither.io (no WebSockets)
 *
 * Roles
 *   solo   : a private world in your own page. Needs no server at all.
 *   host   : you created a room. Your page runs the world (sim.js) and serves
 *            your friends through the LAN server (server.js).
 *   guest  : you joined a room. Your page is just a client of the host's world.
 *
 * Transport (guest <-> host, relayed by server.js)
 *   guest -> host : fetch() POST of batched frames
 *   host -> guest : EventSource (Server-Sent Events) carrying base64 frames
 * Frames are  [u16 length][u8 type][payload].
 *
 * The game itself still thinks it is talking to a WebSocket: game.js asks for
 * `new GameSocket()` which behaves like one and is wired to whichever role is
 * active.
 */
(function () {
    'use strict';

    var LAN = window.LAN = {
        mode: 'none',          // 'none' | 'solo' | 'host' | 'guest'
        world: null,           // the local world (solo / host)
        room: null,            // HostRoom / GuestRoom
        listeners: [],
        on: function (fn) { LAN.listeners.push(fn); },
        emit: function (what) { LAN.listeners.forEach(function (fn) { try { fn(what); } catch (e) { console.error(e); } }); }
    };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    var BASE = (location.protocol === 'http:' || location.protocol === 'https:') ? '' : 'http://localhost:8080';
    var mm = /[?&]server=([^&]+)/.exec(location.search);
    if (mm) BASE = 'http://' + decodeURIComponent(mm[1]);
    LAN.base = BASE;

    var NO_SERVER = 'Can\'t reach the LAN server. Start it with "node server.js" and open the link it prints.';

    function api(path, method, body) {
        var opt = { method: method || 'GET', cache: 'no-store' };
        if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
        return fetch(BASE + path, opt).then(function (r) {
            return r.json().then(function (j) {
                if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
                return j;
            }, function () { throw new Error('Bad reply from server'); });
        }, function () { throw new Error(NO_SERVER); });
    }
    LAN.api = api;

    function b64enc(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        return btoa(s);
    }
    function b64dec(str) {
        var s = atob(str), u = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return u;
    }
    var T = { HELLO: 1, OPEN: 2, DATA: 3, CLOSE: 4, VIEW: 5, STATE: 0x10, SOCKCLOSE: 0x12, KICK: 0x13 };

    function frame(type, payload) {            // -> Uint8Array [type][payload]
        var n = payload ? payload.length : 0, f = new Uint8Array(1 + n);
        f[0] = type;
        if (n) f.set(payload, 1);
        return f;
    }
    function jsonFrame(type, obj) { return frame(type, new TextEncoder().encode(JSON.stringify(obj))); }
    function parseJson(u8) { try { return JSON.parse(new TextDecoder().decode(u8)); } catch (e) { return null; } }
    function packFrames(frames) {              // -> Uint8Array [u16 len][frame]...
        var n = 0, i;
        for (i = 0; i < frames.length; i++) n += 2 + frames[i].length;
        var out = new Uint8Array(n), m = 0;
        for (i = 0; i < frames.length; i++) {
            out[m++] = frames[i].length >> 8; out[m++] = frames[i].length & 255;
            out.set(frames[i], m); m += frames[i].length;
        }
        return out;
    }
    function eachFrame(u8, fn) {
        var m = 0;
        while (m + 2 <= u8.length) {
            var len = (u8[m] << 8) | u8[m + 1]; m += 2;
            if (m + len > u8.length) break;
            fn(u8.subarray(m, m + len));
            m += len;
        }
    }
    function viewNow() {
        return {
            gsc: (window.gsc > 0) ? window.gsc : 0.9,
            ww: window.ww || window.innerWidth, hh: window.hh || window.innerHeight
        };
    }

    // ---- no-server pairing: WebRTC offer/answer packed into a copy-pasteable code ----
    function toB64Url(u8) { return b64enc(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    function fromB64Url(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        return b64dec(str);
    }
    function pipeU8(stream, data) {
        return new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    function encodeSignal(kind, sdp) {                 // kind: 'O' invite (offer) | 'A' reply (answer)
        var raw = new TextEncoder().encode(sdp);
        if (window.CompressionStream) return pipeU8(new CompressionStream('deflate-raw'), raw).then(function (z) { return kind + 'z' + toB64Url(z); });
        return Promise.resolve(kind + 'r' + toB64Url(raw));
    }
    function decodeSignal(kind, str) {
        str = String(str || '').replace(/\s+/g, '');
        if (str.length < 10) return Promise.reject(new Error('Paste the whole code first.'));
        if (str[0] !== kind) return Promise.reject(new Error(kind === 'O' ? 'That is not an invite code (it should start with O).' : 'That is not a reply code (it should start with A).'));
        var body;
        try { body = fromB64Url(str.slice(2)); } catch (e) { return Promise.reject(new Error('The code looks damaged - copy it again.')); }
        var dec = function (u8) { return new TextDecoder().decode(u8); };
        if (str[1] === 'z') {
            if (!window.DecompressionStream) return Promise.reject(new Error('This browser cannot read that code.'));
            return pipeU8(new DecompressionStream('deflate-raw'), body).then(dec, function () { throw new Error('The code looks damaged - copy it again.'); });
        }
        return Promise.resolve(dec(body));
    }
    function gatherDone(pc) {
        return new Promise(function (res) {
            if (pc.iceGatheringState === 'complete') return res();
            var t = setTimeout(done, 3500);
            function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); res(); }
            function chk() { if (pc.iceGatheringState === 'complete') done(); }
            pc.addEventListener('icegatheringstatechange', chk);
        });
    }
    var RTC_CFG = { iceServers: [] };                  // same Wi-Fi only: no STUN/TURN, nothing leaves your network
    function rtcOk() { return typeof RTCPeerConnection !== 'undefined'; }
    LAN.directSupported = rtcOk;

    // ---- Firebase Realtime Database (REST only, no SDK, no WebSockets) used purely as a mailbox
    //      to swap WebRTC connection details. Game traffic never touches it. ----
    var FB_URL = 'https://cheese-clicker-706ec-default-rtdb.firebaseio.com';
    var FB_ROOT = 'slither/rooms';
    var fbm = /[?&]fb=([^&]+)/.exec(location.search);
    if (fbm) FB_URL = decodeURIComponent(fbm[1]);
    var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function randStr(n) {
        var a = new Uint8Array(n), o = '';
        (window.crypto || window.msCrypto).getRandomValues(a);
        for (var i = 0; i < n; i++) o += CODE_CHARS[a[i] % CODE_CHARS.length];
        return o;
    }
    function fbFetch(method, path, body, keep, root) {
        var opt = { method: method, cache: 'no-store' };
        if (body !== undefined) opt.body = JSON.stringify(body);
        if (keep) opt.keepalive = true;
        return fetch(FB_URL + '/' + (root || FB_ROOT) + (path ? '/' + path : '') + '.json', opt).then(function (r) {
            if (!r.ok) throw new Error((r.status === 401 || r.status === 403) ? 'Firebase refused access - publish the database rules from the README.' : 'Firebase error ' + r.status);
            return r.json();
        }, function () { throw new Error('Can\'t reach Firebase - are you online? (Needed only to pair; the game itself stays on your Wi-Fi.)'); });
    }
    LAN.fbUrl = FB_URL;

    // Public "open games" list: hosts publish a small entry to slither/lobby/<code> (refreshed every 20s).
    // Readers drop entries whose timestamp is stale, judged against the Firebase server clock.
    var LOBBY = 'slither/lobby', STALE_MS = 75000, fbClock = null;
    function syncClock() {
        if (fbClock && Date.now() - fbClock.local < 60000) return Promise.resolve();
        return fbFetch('PUT', '_clock', { t: { '.sv': 'timestamp' } }, false, LOBBY)
            .then(function () { return fbFetch('GET', '_clock/t', undefined, false, LOBBY); })
            .then(function (t) { if (typeof t === 'number') fbClock = { server: t, local: Date.now() }; });
    }
    LAN.listFbRooms = function () {
        return syncClock().then(function () { return fbFetch('GET', '', undefined, false, LOBBY); }).then(function (all) {
            var now = fbClock ? fbClock.server + (Date.now() - fbClock.local) : Date.now(), out = [];
            if (all && typeof all === 'object') for (var code in all) {
                var r = all[code];
                if (code === '_clock' || !r || typeof r !== 'object' || typeof r.t !== 'number') continue;
                if (now - r.t > STALE_MS) continue;
                out.push({ code: code, name: r.name, host: r.host, players: r.players, max: r.max, bots: r.bots, started: !!r.started, t: r.t });
            }
            out.sort(function (a, b) { return b.t - a.t; });
            return out;
        });
    };

    // A serial POST queue: one request in flight at a time so frames never reorder.
    function Uplink(url) {
        var self = this;
        this.url = url; this.q = []; this.busy = false; this.dead = false; this.timer = null;
        this.onerror = null;
        this.push = function (f) {
            // consecutive steering packets only matter in their latest value
            var last = self.q[self.q.length - 1];
            if (last && last.length === 2 && f.length === 2 && last[0] === T.DATA && f[0] === T.DATA && last[1] <= 250 && f[1] <= 250) self.q[self.q.length - 1] = f;
            else self.q.push(f);
            if (!self.timer && !self.busy) self.timer = setTimeout(self.flush, 10);
        };
        this.flush = function () {
            self.timer = null;
            if (self.busy || self.dead || !self.q.length) return;
            var body = packFrames(self.q); self.q = []; self.busy = true;
            fetch(self.url, { method: 'POST', body: body, cache: 'no-store', keepalive: body.length < 60000 })
                .then(function () { self.busy = false; if (self.q.length) self.flush(); },
                    function () { self.busy = false; if (self.onerror) self.onerror(); });
        };
    }

    // ------------------------------------------------------------------
    // Host room
    // ------------------------------------------------------------------
    function HostRoom(o) {
        var self = this;
        this.role = 'host';
        this.code = o.code; this.token = o.token; this.p2p = !!o.p2p; this.fb = !!o.fb;
        this.name = o.name; this.hostName = o.hostName; this.max = o.max; this.pub = o.pub;
        this.started = false;
        this.world = SlitherSim.createWorld({ bots: o.bots });
        this.guests = {};
        this.closed = false;
        this.listeners = [];
        var infoTimer = null, sendTimer = null, sending = false;
        var qs = '?room=' + this.code + '&token=' + this.token;

        this.playerList = function () {
            var l = [{ n: self.hostName, h: 1 }];
            for (var k in self.guests) if (self.guests[k].named) l.push({ n: self.guests[k].name, h: 0 });
            return l;
        };
        this.state = function () {
            return { code: self.code, name: self.name, max: self.max, bots: self.world.getBots(), pub: self.pub,
                started: self.started, hostName: self.hostName, players: self.playerList() };
        };
        function guestCount() { var n = 0; for (var k in self.guests) n++; return n; }
        function changed() {
            var st = self.state(), f = jsonFrame(T.STATE, st);
            for (var k in self.guests) enqueue(self.guests[k], f);
            self.listeners.forEach(function (fn) { fn(st); });
            LAN.emit('room');
            if (!infoTimer) infoTimer = setTimeout(pushInfo, 250);
        }
        function pushInfo() {
            infoTimer = null;
            if (self.closed) return;
            if (self.fb) {
                fbFetch('PUT', self.code + '/info', { name: self.name, host: self.hostName, max: self.max, bots: self.world.getBots(),
                    players: 1 + guestCount(), started: self.started, t: { '.sv': 'timestamp' } }).catch(function () {});
                if (self.pub) fbFetch('PUT', self.code, { name: self.name, host: self.hostName, max: self.max, bots: self.world.getBots(),
                    players: 1 + guestCount(), started: self.started, t: { '.sv': 'timestamp' } }, false, LOBBY).catch(function () {});
                return;
            }
            if (self.p2p) return;
            api('/api/h/info' + qs, 'POST', { name: self.name, host: self.hostName, max: self.max, pub: self.pub,
                bots: self.world.getBots(), players: 1 + guestCount(), started: self.started }).catch(function () {});
        }
        this.changed = changed;

        // ---- outbound to guests (batched, strictly ordered) ----
        function enqueue(g, f) { g.out.push(f); if (!sendTimer && !sending) sendTimer = setTimeout(flushOut, 12); }
        function flushOut() {
            sendTimer = null;
            if (sending || self.closed) return;
            if (self.p2p) {                                   // direct data channels: no relay
                var again = false;
                for (var pk in self.guests) {
                    var pg = self.guests[pk];
                    if (!pg.out.length) continue;
                    if (!pg.dc || pg.dc.readyState !== 'open') continue;
                    while (pg.out.length && pg.dc.bufferedAmount < 2000000) {
                        var chunk = [], n = 0;
                        while (pg.out.length && (n + pg.out[0].length + 2 <= 60000 || !chunk.length)) { var fr = pg.out.shift(); chunk.push(fr); n += fr.length + 2; }
                        try { pg.dc.send(packFrames(chunk)); } catch (e) { break; }
                    }
                    if (pg.out.length) again = true;
                }
                if (again && !sendTimer) sendTimer = setTimeout(flushOut, 12);
                return;
            }
            var parts = [], total = 0;
            for (var k in self.guests) {
                var g = self.guests[k];
                if (!g.out.length) continue;
                var batch = packFrames(g.out); g.out = [];
                var head = new Uint8Array(6);
                head[0] = g.cid >> 8; head[1] = g.cid & 255;
                head[2] = (batch.length >>> 24) & 255; head[3] = (batch.length >>> 16) & 255; head[4] = (batch.length >>> 8) & 255; head[5] = batch.length & 255;
                parts.push(head, batch); total += 6 + batch.length;
            }
            if (!parts.length) return;
            var body = new Uint8Array(total), m = 0;
            parts.forEach(function (p) { body.set(p, m); m += p.length; });
            sending = true;
            fetch(BASE + '/api/h/send' + qs, { method: 'POST', body: body, cache: 'no-store' })
                .then(function () { sending = false; flushOutSoon(); }, function () { sending = false; flushOutSoon(); });
        }
        function flushOutSoon() {
            for (var k in self.guests) if (self.guests[k].out.length) { if (!sendTimer) sendTimer = setTimeout(flushOut, 4); return; }
        }

        // ---- guests ----
        function onJoin(cid, dc) {
            var g = { cid: cid, dc: dc || null, name: '', named: false, conn: null, view: { gsc: 0.9, ww: 1280, hh: 720 }, out: [] };
            if (1 + guestCount() >= self.max) {
                enqueue(g, jsonFrame(T.KICK, { reason: 'Room is full' }));
                self.guests[cid] = g;
                setTimeout(function () { delete self.guests[cid]; }, 1500);
                return;
            }
            self.guests[cid] = g;
            enqueue(g, jsonFrame(T.STATE, self.state()));
        }
        function onLeave(cid) {
            var g = self.guests[cid];
            if (!g) return;
            if (g.conn) { g.conn.onClosed = null; g.conn.close(); }
            if (g.dc) { try { g.dc.close(); } catch (e) {} }
            delete self.guests[cid];
            changed();
        }
        function onFrame(g, f) {
            var t = f[0], p = f.subarray(1);
            if (t === T.HELLO) {
                var o = parseJson(p) || {};
                g.name = String(o.name || 'Player').replace(/[^\x20-\x7e]/g, '').slice(0, 24) || 'Player';
                g.named = true;
                changed();
            } else if (t === T.OPEN) {
                if (!self.world.isRunning()) return;
                if (g.conn) { g.conn.onClosed = null; g.conn.close(); }
                g.conn = self.world.connect({
                    minInterval: 30,
                    getView: function () { return g.view; },
                    deliver: function (bufs) { for (var i = 0; i < bufs.length; i++) enqueue(g, frame(T.DATA, new Uint8Array(bufs[i]))); },
                    onClosed: function () { enqueue(g, frame(T.SOCKCLOSE)); }
                });
            } else if (t === T.DATA) {
                if (g.conn) g.conn.send(p);
            } else if (t === T.CLOSE) {
                if (g.conn) { g.conn.onClosed = null; g.conn.close(); g.conn = null; }
            } else if (t === T.VIEW && p.length >= 6) {
                g.view = { ww: (p[0] << 8) | p[1], hh: (p[2] << 8) | p[3], gsc: ((p[4] << 8) | p[5]) / 1000 };
            }
        }

        // ---- event stream from the server ----
        var es = null;
        if (!this.p2p) {
        es = new EventSource(BASE + '/api/h/events' + qs);
        this.es = es;
        es.onmessage = function (e) {
            var d = e.data;
            if (d === 'ready') return;
            var c = d.charAt(0);
            if (c === 'j') onJoin(+d.slice(2));
            else if (c === 'l') onLeave(+d.slice(2));
            else if (c === 'm') {
                var i = d.indexOf(':', 2), cid = +d.slice(2, i), g = self.guests[cid];
                if (!g) return;
                eachFrame(b64dec(d.slice(i + 1)), function (f) { onFrame(g, f); });
            }
        };
        es.onerror = function () { if (!self.closed) { self.close('The LAN server stopped responding.'); } };
        }

        // ---- direct (no server) invites ----
        var peers = [], nextPeer = 0;
        // Returns a promise of { invite, accept(replyCode), cancel }.
        this.addPeer = function () {
            if (!rtcOk()) return Promise.reject(new Error('This browser has no WebRTC.'));
            var pc = new RTCPeerConnection(RTC_CFG), dc = pc.createDataChannel('g', { ordered: true });
            dc.binaryType = 'arraybuffer';
            var cid = ++nextPeer, g = null, peer = { pc: pc, cid: cid, done: false, onconnected: null };
            peers.push(peer);
            dc.onopen = function () {
                onJoin(cid, dc); g = self.guests[cid]; peer.done = true;
                if (peer.onconnected) peer.onconnected();
            };
            dc.onmessage = function (e) { if (g) eachFrame(new Uint8Array(e.data), function (f) { onFrame(g, f); }); };
            dc.onclose = function () { if (g) { onLeave(cid); g = null; } };
            pc.onconnectionstatechange = function () {
                if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && g) { onLeave(cid); g = null; }
            };
            peer.cancel = function () { try { pc.close(); } catch (e) {} var i = peers.indexOf(peer); if (i >= 0) peers.splice(i, 1); };
            return pc.createOffer().then(function (d) { return pc.setLocalDescription(d); })
                .then(function () { return gatherDone(pc); })
                .then(function () { return encodeSignal('O', pc.localDescription.sdp); })
                .then(function (code) {
                    peer.invite = code;
                    peer.accept = function (reply) {
                        return decodeSignal('A', reply).then(function (sdp) { return pc.setRemoteDescription({ type: 'answer', sdp: sdp }); });
                    };
                    return peer;
                }, function (e) { peer.cancel(); throw e; });
        };

        // ---- Firebase mailbox: friends type the code, we answer their join request with an offer ----
        var fbTimer = null, seenJoins = {};
        function fbClean(gid) {
            ['join', 'offer', 'answer'].forEach(function (n) { fbFetch('DELETE', self.code + '/' + n + '/' + gid).catch(function () {}); });
        }
        function fbHandleJoin(gid) {
            self.addPeer().then(function (peer) {
                if (self.closed) { peer.cancel(); return; }
                var tries = 0;
                peer.onconnected = function () { fbClean(gid); };
                fbFetch('PUT', self.code + '/offer/' + gid, peer.invite).catch(function () {});
                (function waitAnswer() {
                    if (self.closed || peer.done) return;
                    if (tries++ > 60) { peer.cancel(); fbClean(gid); return; }
                    fbFetch('GET', self.code + '/answer/' + gid).then(function (a) {
                        if (!a) return setTimeout(waitAnswer, 500);
                        peer.accept(a).catch(function () { peer.cancel(); fbClean(gid); });
                    }, function () { setTimeout(waitAnswer, 900); });
                })();
            }, function () { fbClean(gid); });
        }
        function fbPoll() {
            if (self.closed) return;
            fbFetch('GET', self.code + '/join').then(function (j) {
                if (j && typeof j === 'object') for (var gid in j) { if (!seenJoins[gid]) { seenJoins[gid] = 1; fbHandleJoin(gid); } }
            }).catch(function () {}).then(function () { if (!self.closed) fbTimer = setTimeout(fbPoll, 700); });
        }
        var fbBeat = null;
        if (this.fb) { setTimeout(pushInfo, 0); fbPoll(); fbBeat = setInterval(pushInfo, 20000); }

        // ---- host controls ----
        this.setBots = function (n) { self.world.setBots(n); changed(); };
        this.setMax = function (n) { self.max = Math.max(2, Math.min(32, n | 0)); changed(); };
        this.setName = function (n) { self.name = n; changed(); };
        this.setHostName = function (n) { self.hostName = n; changed(); };
        this.start = function () {
            if (self.started) return;
            self.world.start();
            self.started = true;
            changed();
        };
        this.close = function (why) {
            if (self.closed) return;
            self.closed = true;
            if (es) { try { es.close(); } catch (e) {} }
            try { self.world.stop(); } catch (e) {}
            for (var pi = 0; pi < peers.length; pi++) { try { peers[pi].pc.close(); } catch (e) {} }
            if (self.fb) {
                clearTimeout(fbTimer); clearInterval(fbBeat);
                fbFetch('DELETE', self.code, undefined, true).catch(function () {});
                fbFetch('DELETE', self.code, undefined, true, LOBBY).catch(function () {});
            }
            if (!self.p2p) {
                try { navigator.sendBeacon(BASE + '/api/h/close' + qs, ''); } catch (e) {}
                api('/api/h/close' + qs, 'POST', {}).catch(function () {});
            }
            if (LAN.room === self) { LAN.room = null; LAN.world = null; LAN.mode = 'none'; }
            LAN.emit(why ? { closed: why } : 'room');
        };
    }

    // ------------------------------------------------------------------
    // Guest room
    // ------------------------------------------------------------------
    function GuestRoom(o) {
        var self = this;
        this.role = 'guest';
        this.p2p = !!o.p2p;
        this.code = o.code; this.cid = o.cid;
        this.state = null;
        this.sock = null;
        this.closed = false;
        this.connected = false;
        var qs = '?room=' + this.code + '&cid=' + this.cid;
        var viewTimer = null, dc = null, es = null, up;
        if (this.p2p) {
            up = { dead: false, push: function (f) { if (dc && dc.readyState === 'open') { try { dc.send(packFrames([f])); } catch (e) {} } } };
        } else {
            up = new Uplink(BASE + '/api/g/send' + qs);
            up.onerror = function () { self.leave('Lost connection to the host.'); };
        }

        function sendView() {
            var v = viewNow(), g = Math.round(v.gsc * 1000);
            up.push(frame(T.VIEW, new Uint8Array([v.ww >> 8, v.ww & 255, v.hh >> 8, v.hh & 255, g >> 8, g & 255])));
        }
        this.hello = function (name) { up.push(jsonFrame(T.HELLO, { name: name })); };

        function handleBatch(u8) {
            eachFrame(u8, function (f) {
                var t = f[0], p = f.subarray(1);
                if (t === T.DATA) {
                    var s = self.sock;
                    if (s && s.readyState === 1 && s.onmessage) {
                        var ab = new ArrayBuffer(p.length); new Uint8Array(ab).set(p);
                        try { s.onmessage({ data: ab }); } catch (err) { console.error('[lan] client error', err); }
                    }
                } else if (t === T.STATE) {
                    var st = parseJson(p);
                    if (st) { self.state = st; LAN.emit('room'); }
                } else if (t === T.SOCKCLOSE) {
                    if (self.sock) self.sock._serverClosed();
                } else if (t === T.KICK) {
                    var k = parseJson(p) || {};
                    self.leave(k.reason || 'Removed from the room.');
                }
            });
        }

        if (this.p2p) {
            var pc = this.pc = o.pc;
            pc.ondatachannel = function (ev) {
                dc = ev.channel; dc.binaryType = 'arraybuffer';
                dc.onopen = function () { self.connected = true; if (self.pendingName) self.hello(self.pendingName); LAN.emit('room'); };
                dc.onmessage = function (e) { handleBatch(new Uint8Array(e.data)); };
                dc.onclose = function () { if (!self.closed) self.leave('The host closed the room.'); };
            };
            pc.onconnectionstatechange = function () {
                if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && !self.closed) self.leave('Lost connection to the host.');
            };
        } else {
            es = this.es = new EventSource(BASE + '/api/g/events' + qs);
            es.onmessage = function (e) {
                var d = e.data;
                if (d === 'ready') { if (self.pendingName) self.hello(self.pendingName); return; }
                if (d.charAt(0) === 'c') { self.leave(d.slice(2) === 'host-left' ? 'The host closed the room.' : 'Room closed.'); return; }
                if (d.charAt(0) !== 'm') return;
                handleBatch(b64dec(d.slice(2)));
            };
            es.onerror = function () { if (!self.closed) self.leave('Lost connection to the host.'); };
        }

        this.openSocket = function (sock) {
            if (self.sock && self.sock !== sock) self.sock._serverClosed();
            self.sock = sock;
            up.push(frame(T.OPEN));
            sendView();
            if (!viewTimer) viewTimer = setInterval(sendView, 500);
        };
        this.sendData = function (u8) { up.push(frame(T.DATA, u8)); };
        this.closeSocket = function (sock) {
            if (self.sock !== sock) return;
            self.sock = null;
            up.push(frame(T.CLOSE));
            if (viewTimer) { clearInterval(viewTimer); viewTimer = null; }
        };
        this.leave = function (why) {
            if (self.closed) return;
            self.closed = true;
            if (viewTimer) { clearInterval(viewTimer); viewTimer = null; }
            var s = self.sock; self.sock = null;
            up.dead = true;
            if (es) { try { es.close(); } catch (e) {} try { navigator.sendBeacon(BASE + '/api/g/leave' + qs, ''); } catch (e) {} }
            if (self.p2p) { try { if (dc) dc.close(); } catch (e) {} try { self.pc.close(); } catch (e) {} }
            if (s) s._serverClosed();
            if (LAN.room === self) { LAN.room = null; LAN.mode = 'none'; }
            LAN.emit(why ? { closed: why } : 'room');
        };
    }

    // ------------------------------------------------------------------
    // The fake WebSocket handed to game.js
    // ------------------------------------------------------------------
    function GameSocket() {
        var self = this;
        this.binaryType = 'arraybuffer';
        this.readyState = 0;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this.conn = null;
        var mode = LAN.mode;
        if (mode === 'solo' || mode === 'host') {
            this.conn = LAN.world.connect({
                getView: viewNow,
                deliver: function (bufs) {
                    if (self.readyState !== 1 || !self.onmessage) return;
                    for (var i = 0; i < bufs.length; i++) {
                        try { self.onmessage({ data: bufs[i] }); } catch (e) { console.error('[lan] client error', e); }
                    }
                },
                onClosed: function () { self._serverClosed(); }
            });
        }
        setTimeout(function () {
            if (self.readyState !== 0) return;
            if (mode === 'guest') {
                if (!LAN.room || LAN.room.closed) { self._serverClosed(); return; }
                LAN.room.openSocket(self);
            } else if (!self.conn) { self._serverClosed(); return; }
            self.readyState = 1;
            if (self.onopen) self.onopen({});
        }, 15);
    }
    GameSocket.prototype.send = function (d) {
        if (this.readyState !== 1) return;
        var u8 = (d instanceof ArrayBuffer) ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        if (this.conn) this.conn.send(u8);
        else if (LAN.room && LAN.room.role === 'guest') LAN.room.sendData(new Uint8Array(u8));
    };
    GameSocket.prototype.close = function () {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.conn) { this.conn.onClosed = null; this.conn.close(); this.conn = null; }
        else if (LAN.room && LAN.room.role === 'guest') LAN.room.closeSocket(this);
    };
    GameSocket.prototype._serverClosed = function () {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.conn = null;
        if (this.onclose) { try { this.onclose({}); } catch (e) { console.error(e); } }
    };
    window.GameSocket = GameSocket;

    // ------------------------------------------------------------------
    // Public actions
    // ------------------------------------------------------------------
    function stopCurrent() {
        if (LAN.room) { LAN.room.role === 'host' ? LAN.room.close() : LAN.room.leave(); }
        if (LAN.mode === 'solo' && LAN.world) { LAN.world.stop(); }
        LAN.world = null; LAN.room = null; LAN.mode = 'none';
    }

    LAN.startSolo = function (bots) {
        stopCurrent();
        var m = /[?&]bots=(\d+)/.exec(location.search);
        if (m) bots = +m[1];
        LAN.world = SlitherSim.createWorld({ bots: bots == null ? 28 : bots });
        LAN.world.start();
        LAN.mode = 'solo';
        LAN.emit('mode');
    };
    LAN.leaveSolo = function () {
        if (LAN.mode !== 'solo') return;
        LAN.world.stop(); LAN.world = null; LAN.mode = 'none';
        LAN.emit('mode');
    };
    LAN.createRoom = function (o) {
        stopCurrent();
        return api('/api/rooms', 'POST', { name: o.name, host: o.hostName, max: o.max, bots: o.bots, pub: o.pub }).then(function (r) {
            var room = new HostRoom({ code: r.code, token: r.token, name: o.name, hostName: o.hostName, max: o.max, bots: o.bots, pub: o.pub });
            LAN.room = room; LAN.world = room.world; LAN.mode = 'host';
            LAN.emit('mode');
            return room;
        });
    };
    LAN.joinRoom = function (code, name) {
        stopCurrent();
        return api('/api/join', 'POST', { code: code }).then(function (r) {
            var room = new GuestRoom({ code: r.code, cid: r.cid });
            room.pendingName = name;
            LAN.room = room; LAN.mode = 'guest';
            LAN.emit('mode');
            return room;
        });
    };
    // Firebase-paired rooms (5-character code, same Wi-Fi)
    LAN.createFbRoom = function (o) {
        stopCurrent();
        if (!rtcOk()) return Promise.reject(new Error('This browser has no WebRTC.'));
        function claim(tries) {
            var code = randStr(5);
            return fbFetch('GET', code + '/info').then(function (x) {
                if (x && tries < 8) return claim(tries + 1);
                return fbFetch('PUT', code + '/info', { name: o.name, host: o.hostName, max: o.max, bots: o.bots, players: 1, started: false, t: { '.sv': 'timestamp' } }).then(function () { return code; });
            });
        }
        return claim(0).then(function (code) {
            var room = new HostRoom({ p2p: true, fb: true, code: code, name: o.name, hostName: o.hostName, max: o.max, bots: o.bots, pub: !!o.pub });
            LAN.room = room; LAN.world = room.world; LAN.mode = 'host';
            LAN.emit('mode');
            return room;
        });
    };
    LAN.joinFb = function (code, name) {
        stopCurrent();
        code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!rtcOk()) return Promise.reject(new Error('This browser has no WebRTC.'));
        var gid = randStr(10), pc = null, room = null;
        function fail(e) { if (room) room.leave(); try { fbFetch('DELETE', code + '/join/' + gid).catch(function () {}); } catch (x) {} throw e; }
        return fbFetch('GET', code + '/info').then(function (info) {
            if (!info) throw new Error('No room with that code.');
            if (info.players >= info.max) throw new Error('That room is full.');
            pc = new RTCPeerConnection(RTC_CFG);
            room = new GuestRoom({ p2p: true, pc: pc, code: code, cid: 0 });
            room.pendingName = name;
            LAN.room = room; LAN.mode = 'guest'; LAN.emit('mode');
            return fbFetch('PUT', code + '/join/' + gid, { name: name, t: { '.sv': 'timestamp' } });
        }).then(function () {
            return new Promise(function (res, rej) {                  // wait for the host to post an offer
                var tries = 0;
                (function poll() {
                    if (room.closed) return rej(new Error('Cancelled.'));
                    if (tries++ > 40) return rej(new Error('The host did not answer. Is the game still open?'));
                    fbFetch('GET', code + '/offer/' + gid).then(function (o) { if (o) res(o); else setTimeout(poll, 500); }, function () { setTimeout(poll, 900); });
                })();
            });
        }).then(function (offer) {
            return decodeSignal('O', offer);
        }).then(function (sdp) { return pc.setRemoteDescription({ type: 'offer', sdp: sdp }); })
          .then(function () { return pc.createAnswer(); })
          .then(function (a) { return pc.setLocalDescription(a); })
          .then(function () { return gatherDone(pc); })
          .then(function () { return encodeSignal('A', pc.localDescription.sdp); })
          .then(function (reply) { return fbFetch('PUT', code + '/answer/' + gid, reply); })
          .then(function () {
              setTimeout(function () {
                  if (!room.connected && !room.closed) room.leave('Couldn\'t connect. Are you on the same Wi-Fi as the host?');
              }, 20000);
              return room;
          }).catch(fail);
    };

    // Direct (no-server) rooms
    LAN.createDirectRoom = function (o) {
        stopCurrent();
        var room = new HostRoom({ p2p: true, code: 'DIRECT', name: o.name, hostName: o.hostName, max: o.max, bots: o.bots, pub: false });
        LAN.room = room; LAN.world = room.world; LAN.mode = 'host';
        LAN.emit('mode');
        return room;
    };
    // Resolves with { reply, room }: `reply` is the code to send back to the host.
    LAN.joinDirect = function (inviteCode, name) {
        stopCurrent();
        if (!rtcOk()) return Promise.reject(new Error('This browser has no WebRTC.'));
        var pc = new RTCPeerConnection(RTC_CFG), room = new GuestRoom({ p2p: true, pc: pc, code: 'DIRECT', cid: 0 });
        room.pendingName = name;
        return decodeSignal('O', inviteCode)
            .then(function (sdp) { return pc.setRemoteDescription({ type: 'offer', sdp: sdp }); })
            .then(function () { return pc.createAnswer(); })
            .then(function (a) { return pc.setLocalDescription(a); })
            .then(function () { return gatherDone(pc); })
            .then(function () { return encodeSignal('A', pc.localDescription.sdp); })
            .then(function (reply) {
                LAN.room = room; LAN.mode = 'guest';
                LAN.emit('mode');
                return { reply: reply, room: room };
            }, function (e) { room.closed = true; try { pc.close(); } catch (x) {} throw e; });
    };
    LAN.leave = function () {
        var wasRoom = !!LAN.room;
        stopCurrent();
        LAN.emit(wasRoom ? 'room' : 'mode');
        LAN.emit('mode');
    };
    LAN.listRooms = function () { return api('/api/rooms'); };
    LAN.info = function () { return api('/api/info'); };

    window.addEventListener('pagehide', function () {
        if (LAN.room && LAN.room.role === 'host') LAN.room.close();
        else if (LAN.room) LAN.room.leave();
    });
})();

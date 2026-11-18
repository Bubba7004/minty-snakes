/*
 * sim.js - the local game server for slither.io (runs inside the HOST's page)
 *
 * The original client speaks slither's binary protocol to a server. This file
 * is a tiny server for that protocol that lives in the page. One "world" can
 * serve any number of "connections":
 *
 *   - the host's own game (a connection whose packets are handed straight to
 *     the client), and
 *   - every friend in the room (their packets are shipped over the LAN by
 *     net.js).
 *
 * Usage:
 *   var world = SlitherSim.createWorld({ bots: 20 });
 *   world.start();
 *   var conn = world.connect({ deliver: function (bufs) {...}, getView: fn, minInterval: ms });
 *   conn.send(uint8array);   // client -> server packet
 *   conn.close();
 */
(function () {
    'use strict';

    // World / protocol constants (these are sent to the client in the 'a' packet)
    var R = 7000;                         // arena radius (the visible border)
    var GRD = 7200;                       // arena centre coordinate (x == y == GRD)
    var SEC = 280;                        // sector size
    var NSEC = Math.ceil(2 * GRD / SEC);  // sectors along an edge
    var MSCPS = 411, SPANGDV = 4.8, NSP1 = 4.25, NSP2 = 0.5, NSP3 = 12;
    var MAMU = 0.033, MAMU2 = 0.028, CST = 0.43, MSL = 42, PROTO = 15;

    var PI = Math.PI, PI2 = PI * 2, K64 = PI2 / 65536, K256 = PI2 / 256;
    var TICK = 8; // ms per simulation step (the client also counts time in 8ms units)

    // Length <-> mass tables (identical to the client's setMscps())
    var fm = [], fp = [];
    (function () {
        for (var i = 0; i <= MSCPS; i++) {
            if (i >= MSCPS) fm.push(fm[i - 1]);
            else fm.push(Math.pow(1 - i / MSCPS, 2.25));
            if (i === 0) fp.push(0);
            else fp.push(fp[i - 1] + 1 / fm[i - 1]);
        }
    })();

    var NAMES = ['Slinky', 'Noodle', 'Viper', 'Ziggy', 'Wiggles', 'Basilisk', 'Sir Hiss', 'Cobra Kai',
        'Python', 'Mamba', 'Nagini', 'Danger Noodle', 'Zigzag', 'Fang', 'Sidewinder', 'Rattler', 'Kaa',
        'Jormungandr', 'Slytherin', 'Anaconda', 'Boa', 'Taipan', 'Adder', 'Asp', 'Slimer', 'Coily',
        'Hissy', 'Squiggle', 'Wormy', 'Loopy', 'Twisty', 'Curly', 'Snek', 'Longboi', 'Sssam',
        'Medusa', 'Orochi', 'Apophis', 'Quetzal', 'Naga', 'Ouroboros', 'Spaghetti', 'Ribbon',
        'Shoelace', 'Lasso', 'Vine', 'Tendril', 'Bendy', 'Glider', 'Rascal'];

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    function nrm(a) { a %= PI2; if (a < 0) a += PI2; return a; }
    function sdiff(a, b) { // shortest signed rotation from a to b, in (-PI, PI]
        var d = (b - a) % PI2;
        if (d > PI) d -= PI2; else if (d < -PI) d += PI2;
        return d;
    }
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function ch(s) { return s.charCodeAt(0); }

    function Pkt() { this.b = []; }
    Pkt.prototype.u8 = function (v) { this.b.push(v & 255); return this; };
    Pkt.prototype.u16 = function (v) { this.b.push((v >> 8) & 255, v & 255); return this; };
    Pkt.prototype.u24 = function (v) { this.b.push((v >> 16) & 255, (v >> 8) & 255, v & 255); return this; };
    Pkt.prototype.str = function (s) { for (var i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 255); return this; };
    Pkt.prototype.buf = function () { return new Uint8Array(this.b).buffer; };

    var C = {
        a: ch('a'), s: ch('s'), F: ch('F'), f: ch('f'), b: ch('b'), lt: ch('<'), w: ch('w'), l: ch('l'),
        u: ch('u'), p: ch('p'), v: ch('v'), g: ch('g'), G: ch('G'), n: ch('n'), N: ch('N'), e: ch('e'),
        E: ch('E'), d: ch('d'), seven: ch('7'), three: ch('3'), h: ch('h'), r: ch('r'), six: ch('6')
    };

    // A background-proof timer: browsers throttle setInterval in hidden tabs to
    // ~1Hz, which would freeze a room whose host tabbed away. Messages from a
    // Worker are not throttled that way.
    function makeTicker(cb, ms) {
        var w = null, url = null, iv = null;
        function fallback() { if (!iv) iv = setInterval(cb, ms); }
        try {
            // The worker only sends a new tick once the page has handled the last one,
            // so a slow page can never build up a backlog of ticks.
            var code = 'var ready=true;setInterval(function(){if(ready){ready=false;postMessage(0)}},' + ms + ');' +
                'onmessage=function(){ready=true};';
            url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            w = new Worker(url);
            w.onmessage = function () { try { cb(); } finally { if (w) w.postMessage(0); } };
            w.onerror = function () { try { w.terminate(); } catch (e) {} w = null; fallback(); };
        } catch (e) { w = null; fallback(); }
        return {
            stop: function () {
                if (w) { try { w.terminate(); } catch (e) {} w = null; }
                if (url) { try { URL.revokeObjectURL(url); } catch (e) {} url = null; }
                if (iv) { clearInterval(iv); iv = null; }
            }
        };
    }

    // ------------------------------------------------------------------
    // The world
    // ------------------------------------------------------------------
    function createWorld(opts) {
        opts = opts || {};
        var CFG = {
            bots: opts.bots == null ? 20 : Math.max(0, Math.min(400, opts.bots | 0)),
            botRespawnMs: [2500, 6000],
            pelletsPerSector: 9,
            spawnProtectMs: 2000
        };
        var running = false, ticker = null;
        var conns = [];
        var now = 0, lastReal = 0, acc = 0, tickN = 0;
        var snakes = [];                 // alive snakes
        var nextId = 1;
        var secFood = new Array(NSEC * NSEC);
        var foodRespawns = [];
        var botRespawns = [];
        var lastLb = -1e9, lastMap = -1e9;
        var errored = false, nextConnId = 1;

        // ---- spatial hash of body segments (rebuilt every few ticks) ----
        var CS = 160, GW = Math.ceil(2 * GRD / CS) + 2;
        var SEGCAP = 60000, ENTCAP = 240000;
        var cellHead = new Int32Array(GW * GW).fill(-1);   // -1 = empty (must be set before the first bot thinks)
        var entSeg = new Int32Array(ENTCAP), entNext = new Int32Array(ENTCAP);
        var sx1 = new Float32Array(SEGCAP), sy1 = new Float32Array(SEGCAP);
        var sx2 = new Float32Array(SEGCAP), sy2 = new Float32Array(SEGCAP);
        var segOwner = new Array(SEGCAP);        // snake object (not an index: snakes[] shifts when one dies)
        var segN = 0, entN = 0;

        function addSeg(ax, ay, bx, by, owner) {
            if (segN >= SEGCAP) return;
            var i = segN++;
            sx1[i] = ax; sy1[i] = ay; sx2[i] = bx; sy2[i] = by; segOwner[i] = owner;
            var c0x = Math.floor(Math.min(ax, bx) / CS), c1x = Math.floor(Math.max(ax, bx) / CS);
            var c0y = Math.floor(Math.min(ay, by) / CS), c1y = Math.floor(Math.max(ay, by) / CS);
            for (var cy = c0y; cy <= c1y; cy++) {
                for (var cx = c0x; cx <= c1x; cx++) {
                    if (cx < 0 || cy < 0 || cx >= GW || cy >= GW || entN >= ENTCAP) continue;
                    var c = cy * GW + cx;
                    entSeg[entN] = i; entNext[entN] = cellHead[c]; cellHead[c] = entN; entN++;
                }
            }
        }
        function rebuildHash() {
            cellHead.fill(-1);
            segN = 0; entN = 0;
            for (var si = 0; si < snakes.length; si++) {
                var s = snakes[si], p = s.pts, n = p.length;
                for (var i = 0; i < n - 1; i++) addSeg(p[i].x, p[i].y, p[i + 1].x, p[i + 1].y, s);
                addSeg(p[n - 1].x, p[n - 1].y, s.hx, s.hy, s);
            }
        }
        function ptSegDist2(px, py, i) {
            var ax = sx1[i], ay = sy1[i], dx = sx2[i] - ax, dy = sy2[i] - ay;
            var l2 = dx * dx + dy * dy, t = 0;
            if (l2 > 0) { t = ((px - ax) * dx + (py - ay) * dy) / l2; if (t < 0) t = 0; else if (t > 1) t = 1; }
            var qx = ax + dx * t - px, qy = ay + dy * t - py;
            return qx * qx + qy * qy;
        }
        // Does a circle (px,py,rad) touch any body segment that isn't owned by `self`?
        function bodyHit(px, py, rad, self) {
            var cx = Math.floor(px / CS), cy = Math.floor(py / CS);
            for (var yy = cy - 1; yy <= cy + 1; yy++) {
                for (var xx = cx - 1; xx <= cx + 1; xx++) {
                    if (xx < 0 || yy < 0 || xx >= GW || yy >= GW) continue;
                    for (var e = cellHead[yy * GW + xx]; e !== -1; e = entNext[e]) {
                        var i = entSeg[e];
                        var o = segOwner[i];
                        if (o === self || !o.alive) continue;
                        var lim = rad + 13 * o.sc;
                        if (ptSegDist2(px, py, i) < lim * lim) return o;
                    }
                }
            }
            return null;
        }

        // ---- snake model ----
        function sctFromM(M) {
            var lo = 2, hi = MSCPS - 1;
            while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (fp[mid] <= M) lo = mid; else hi = mid - 1; }
            return lo;
        }
        function refreshScale(s) {
            s.sc = Math.min(6, 1 + (s.sct - 2) / 106);
            s.scang = 0.13 + 0.87 * Math.pow((7 - s.sc) / 6, 2);
        }
        function famOf(s) {
            var f = (s.M - fp[s.sct]) * fm[s.sct];
            if (s.sct < sctFromM(s.M)) return 0.9999;
            return Math.max(0, Math.min(0.9999, f));
        }

        function isClear(x, y, rad) {
            for (var i = 0; i < snakes.length; i++) {
                var p = snakes[i].pts;
                for (var k = p.length - 1; k >= 0; k -= 3) {
                    var dx = p[k].x - x, dy = p[k].y - y;
                    if (dx * dx + dy * dy < rad * rad) return false;
                }
            }
            return true;
        }
        function findSpawn() {
            var x = GRD, y = GRD;
            for (var tries = 0; tries < 40; tries++) {
                var a = rnd(0, PI2), d = Math.sqrt(Math.random()) * R * 0.8;
                x = GRD + Math.cos(a) * d; y = GRD + Math.sin(a) * d;
                if (isClear(x, y, 650 - tries * 10)) break;
            }
            return { x: x, y: y };
        }
        function snakeById(id) {
            for (var i = 0; i < snakes.length; i++) if (snakes[i].id === id) return snakes[i];
            return null;
        }

        // owner: the connection controlling this snake, or null for a bot
        function spawnSnake(name, cv, owner, M0) {
            var pos = findSpawn();
            var s = {
                id: 0, name: name, cv: cv, bot: !owner, owner: owner || null, alive: true,
                M: M0, sct: sctFromM(M0), sc: 1, scang: 1, fam: 0,
                hx: pos.x, hy: pos.y, ang: rnd(0, PI2), wang: 0, dir: 0, sp: 0,
                boost: false, dropAcc: 0, lastFam: 0,
                protUntil: now + CFG.spawnProtectMs, pts: [], ai: null
            };
            s.ang = Math.round(s.ang / K256) * K256; s.wang = s.ang;
            do { s.id = nextId++; if (nextId > 65000) nextId = 1; } while (snakeById(s.id));
            refreshScale(s);
            s.fam = famOf(s);
            s.sp = Math.round((NSP1 + NSP2 * s.sc) * 18) / 18;
            // body trails straight behind the head
            var dx = Math.cos(s.ang) * MSL, dy = Math.sin(s.ang) * MSL;
            for (var i = 0; i < s.sct; i++) {
                var back = s.sct - 1 - i;
                s.pts.push({ x: s.hx - dx * back, y: s.hy - dy * back });
            }
            if (s.bot) {
                var skill = rnd(0.45, 1);
                s.ai = { next: now + rnd(0, 300), skill: skill, aggr: Math.random() < 0.35, hunting: false, huntUntil: 0, calmUntil: now + rnd(3000, 9000),
                    cautious: Math.random() < 0.5, wander: rnd(0, PI2), burst: 0, mode: 'eat', turn: 1 };
            }
            snakes.push(s);
            return s;
        }

        // ---- who sees what -------------------------------------------------
        function sees(c, s) { return s.owner === c || !!c.visible[s.id]; }
        function anySees(s) {
            for (var i = 0; i < conns.length; i++) if (sees(conns[i], s)) return true;
            return false;
        }

        // ---- food ----
        function secIdx(sx, sy) { return sy * NSEC + sx; }
        function addFood(x, y, sz, cv, perm, announce, rapid) {
            var sx = Math.floor(x / SEC), sy = Math.floor(y / SEC);
            if (sx < 0 || sy < 0 || sx >= NSEC || sy >= NSEC) return null;
            var rx = Math.min(255, Math.floor((x - sx * SEC) / SEC * 256));
            var ry = Math.min(255, Math.floor((y - sy * SEC) / SEC * 256));
            var id = (sx << 24) | (sy << 16) | (rx << 8) | ry;
            var idx = secIdx(sx, sy);
            var m = secFood[idx];
            if (!m) m = secFood[idx] = new Map();
            if (m.has(id)) return null;
            var rad = Math.max(1, Math.min(255, Math.round(sz * 5)));
            var f = { id: id, sx: sx, sy: sy, rx: rx, ry: ry, x: sx * SEC + rx * SEC / 256,
                y: sy * SEC + ry * SEC / 256, sz: rad / 5, rad: rad, cv: cv % 9, perm: perm };
            m.set(id, f);
            if (announce) {
                var buf = null;
                for (var i = 0; i < conns.length; i++) if (conns[i].loaded[idx]) {
                    if (!buf) buf = new Pkt().u8(rapid ? C.b : C.f).u8(sx).u8(sy).u8(rx).u8(ry).u8(f.cv).u8(rad).buf();
                    conns[i].out.push(buf);
                }
            }
            return f;
        }
        function randomPellet(sx, sy, perm) {
            for (var t = 0; t < 6; t++) {
                var x = sx * SEC + Math.random() * SEC, y = sy * SEC + Math.random() * SEC;
                var dx = x - GRD, dy = y - GRD;
                if (dx * dx + dy * dy > (R - 70) * (R - 70)) continue;
                var sz = Math.random() < 0.12 ? rnd(7, 10.5) : rnd(3, 6);
                if (addFood(x, y, sz, Math.floor(Math.random() * 9), perm, true, false)) return true;
            }
            return false;
        }
        function fillWorld() {
            for (var sy = 0; sy < NSEC; sy++) {
                for (var sx = 0; sx < NSEC; sx++) {
                    var cx = (sx + 0.5) * SEC - GRD, cy = (sy + 0.5) * SEC - GRD;
                    if (Math.sqrt(cx * cx + cy * cy) > R + SEC) continue;
                    var n = CFG.pelletsPerSector + Math.floor(Math.random() * 5);
                    for (var i = 0; i < n; i++) randomPellet(sx, sy, true);
                }
            }
        }
        function sendSector(c, sx, sy) {
            var p = new Pkt().u8(C.F).u8(sx).u8(sy);
            var m = secFood[secIdx(sx, sy)];
            if (m) m.forEach(function (f) { p.u8(f.cv).u8(f.rx).u8(f.ry).u8(f.rad); });
            c.out.push(p.buf());
        }

        // ---- packets describing a snake ----
        function sPacket(s) {
            var p = new Pkt().u8(C.s).u16(s.id);
            p.u24(Math.round(nrm(s.ang) / PI2 * 16777215));
            p.u8(48 + (s.dir || 0));
            p.u24(Math.round(nrm(s.wang) / PI2 * 16777215));
            p.u16(Math.round(s.sp * 1000));
            p.u24(Math.round(s.fam * 16777215));
            p.u8(s.cv);
            p.u24(Math.round(s.hx * 5)).u24(Math.round(s.hy * 5));
            var nm = s.name.substr(0, 24);
            p.u8(nm.length).str(nm);
            p.u8(0);     // custom skin length (protocol >= 11)
            p.u8(255);   // cosmetic (protocol >= 12): none
            // body, tail first. Deltas are encoded against what the client will
            // have decoded so rounding error never accumulates.
            var pts = s.pts, n = pts.length;
            var rx = Math.round(pts[0].x * 5) / 5, ry = Math.round(pts[0].y * 5) / 5;
            p.u24(Math.round(rx * 5)).u24(Math.round(ry * 5));
            for (var i = 1; i < n - 1; i++) {
                var bx = Math.max(-127, Math.min(128, Math.round((pts[i].x - rx) * 2)));
                var by = Math.max(-127, Math.min(128, Math.round((pts[i].y - ry) * 2)));
                p.u8(bx + 127).u8(by + 127);
                rx += bx / 2; ry += by / 2;
            }
            var iang = Math.round(nrm(Math.atan2(pts[n - 1].y - ry, pts[n - 1].x - rx)) / K64) & 65535;
            p.u16(iang);
            return p.buf();
        }
        // The client's own snake uses shorter packets (no id), everyone else's carry the id.
        function sendTurn(s, qa, q) {
            var spb = Math.round(s.sp * 18), own = null, other = null;
            for (var i = 0; i < conns.length; i++) {
                var c = conns[i];
                if (s.owner === c) {
                    if (!own) own = new Pkt().u8(s.dir === 2 ? C.seven : C.d).u8(qa).u8(q).u8(spb).buf();
                    c.out.push(own);
                } else if (c.visible[s.id]) {
                    if (!other) other = new Pkt().u8(s.dir === 2 ? C.E : C.e).u16(s.id).u8(qa).u8(q).u8(spb).buf();
                    c.out.push(other);
                }
            }
        }
        function sendSpeed(s) {
            var spb = Math.round(s.sp * 18), own = null, other = null;
            for (var i = 0; i < conns.length; i++) {
                var c = conns[i];
                if (s.owner === c) {
                    if (!own) own = new Pkt().u8(C.three).u8(spb).buf();
                    c.out.push(own);
                } else if (c.visible[s.id]) {
                    if (!other) other = new Pkt().u8(C.three).u16(s.id).u8(spb).buf();
                    c.out.push(other);
                }
            }
        }
        function retarget(s, a) {
            var q = Math.round(nrm(a) / K256) & 255;
            var qa = Math.round(nrm(s.ang) / K256) & 255;
            s.ang = qa * K256;
            s.wang = q * K256;
            var d = sdiff(s.ang, s.wang);
            s.dir = d < 0 ? 1 : (d > 0 ? 2 : 0);
            sendTurn(s, qa, q);
        }

        // ---- per-tick snake step ----
        function emitPoint(s, dx, dy) {
            var iang = Math.round(nrm(Math.atan2(dy, dx)) / K64) & 65535;
            var ca = iang * K64;
            var last = s.pts[s.pts.length - 1];
            var np = { x: last.x + Math.cos(ca) * MSL, y: last.y + Math.sin(ca) * MSL };
            s.pts.push(np); s.hx = np.x; s.hy = np.y;
            var grow = sctFromM(s.M) > s.sct;
            if (grow) s.sct++; else s.pts.shift();
            refreshScale(s);
            s.fam = famOf(s);
            var fam24 = Math.round(s.fam * 16777215), own = null, other = null, i, c;
            for (i = 0; i < conns.length; i++) {
                c = conns[i];
                if (s.owner === c) {
                    if (!own) own = grow ? new Pkt().u8(C.N).u16(iang).u24(fam24).buf() : new Pkt().u8(C.G).u16(iang).buf();
                    c.out.push(own);
                } else if (c.visible[s.id]) {
                    if (!other) other = grow ? new Pkt().u8(C.n).u16(s.id).u16(iang).u24(fam24).buf()
                                             : new Pkt().u8(C.g).u16(s.id).u16(iang).buf();
                    c.out.push(other);
                }
            }
            s.lastFam = s.fam;
            if (!grow && s.sct > 2 && sctFromM(s.M) < s.sct) { // shrinking from boosting
                s.pts.shift(); s.sct--; refreshScale(s); s.fam = famOf(s);
                var q = null;
                for (i = 0; i < conns.length; i++) {
                    c = conns[i];
                    if (sees(c, s)) {
                        if (!q) q = new Pkt().u8(C.r).u16(s.id).u24(Math.round(s.fam * 16777215)).buf();
                        c.out.push(q);
                    }
                }
            }
        }

        function eatFood(s) {
            var er = 26 + 9 * s.sc, er2 = er * er;
            var csx = Math.floor(s.hx / SEC), csy = Math.floor(s.hy / SEC);
            var gained = 0;
            for (var yy = csy - 1; yy <= csy + 1; yy++) {
                for (var xx = csx - 1; xx <= csx + 1; xx++) {
                    if (xx < 0 || yy < 0 || xx >= NSEC || yy >= NSEC) continue;
                    var idx = secIdx(xx, yy), m = secFood[idx];
                    if (!m || m.size === 0) continue;
                    var eaten = null;
                    m.forEach(function (f) {
                        var dx = f.x - s.hx, dy = f.y - s.hy;
                        if (dx * dx + dy * dy < er2) { if (!eaten) eaten = []; eaten.push(f); }
                    });
                    if (!eaten) continue;
                    for (var i = 0; i < eaten.length; i++) {
                        var f = eaten[i];
                        m.delete(f.id);
                        gained += f.sz / 3;
                        if (f.perm) foodRespawns.push({ t: now + rnd(4000, 11000), sx: f.sx, sy: f.sy });
                        for (var k = 0; k < conns.length; k++) {
                            var c = conns[k];
                            if (c.loaded[idx])
                                c.out.push(new Pkt().u8(C.lt).u8(f.sx).u8(f.sy).u8(f.rx).u8(f.ry).u16(sees(c, s) ? s.id : 0).buf());
                        }
                    }
                }
            }
            if (gained > 0) s.M = Math.min(fp[MSCPS - 40], s.M + gained / 15);
        }

        function stepSnake(s) {
            // speed
            var want = (s.boost && s.M > 2.45) ? NSP3 : NSP1 + NSP2 * s.sc;
            var q = Math.round(want * 18) / 18;
            if (q !== s.sp) { s.sp = q; sendSpeed(s); }
            // turning (mirrors the client's own prediction exactly)
            var mang = MAMU * s.scang * Math.min(1, s.sp / SPANGDV), v;
            if (s.dir === 1) {
                s.ang = nrm(s.ang - mang);
                v = nrm(s.wang - s.ang); if (v > PI) v -= PI2;
                if (v > 0) { s.ang = s.wang; s.dir = 0; }
            } else if (s.dir === 2) {
                s.ang = nrm(s.ang + mang);
                v = nrm(s.wang - s.ang); if (v > PI) v -= PI2;
                if (v < 0) { s.ang = s.wang; s.dir = 0; }
            } else s.ang = s.wang;
            // move
            var step = s.sp / 4;
            s.hx += Math.cos(s.ang) * step; s.hy += Math.sin(s.ang) * step;
            var last = s.pts[s.pts.length - 1];
            var dx = s.hx - last.x, dy = s.hy - last.y;
            if (dx * dx + dy * dy >= MSL * MSL) emitPoint(s, dx, dy);
            // boosting burns mass and leaves pellets behind
            if (s.boost && s.M > 2.45) {
                var cost = 7 * (TICK / 1000);       // score points per tick
                s.M -= cost / 15;
                s.dropAcc += cost;
                if (s.dropAcc >= 1.5) {
                    var t = s.pts[0], sz = s.dropAcc * 3;
                    addFood(t.x + rnd(-8, 8), t.y + rnd(-8, 8), Math.min(sz, 9), Math.floor(Math.random() * 9), false, true, true);
                    s.dropAcc = 0;
                }
            } else if (s.boost && s.owner) s.boost = false;
            if (tickN % 2 === 0) eatFood(s);
        }

        // ---- deaths ----
        function killSnake(s, killer) {
            if (!s.alive) return;
            s.alive = false;
            var i = snakes.indexOf(s);
            if (i >= 0) snakes.splice(i, 1);
            // turn the body into food
            var P = Math.max(0, (s.M - 2)) * 15 * 0.75 + 4;
            var n = Math.max(3, Math.min(150, Math.ceil(P / 4)));
            var per = P / n, sz = Math.max(3.5, Math.min(13, per * 3));
            var pts = s.pts.concat([{ x: s.hx, y: s.hy }]);
            for (var k = 0; k < n; k++) {
                var t = (k + Math.random()) / n * (pts.length - 1);
                var i0 = Math.floor(t), fr = t - i0, a = pts[i0], b = pts[Math.min(pts.length - 1, i0 + 1)];
                var x = a.x + (b.x - a.x) * fr + rnd(-1, 1) * 13 * s.sc;
                var y = a.y + (b.y - a.y) * fr + rnd(-1, 1) * 13 * s.sc;
                var dx = x - GRD, dy = y - GRD, dd = Math.sqrt(dx * dx + dy * dy);
                if (dd > R - 40) { x = GRD + dx / dd * (R - 40); y = GRD + dy / dd * (R - 40); }
                addFood(x, y, sz * rnd(0.85, 1.15), Math.floor(Math.random() * 9), false, true, false);
            }
            var dead = null;
            for (var j = 0; j < conns.length; j++) {
                var c = conns[j];
                if (sees(c, s)) {
                    if (!dead) dead = new Pkt().u8(C.s).u16(s.id).u8(1).buf();
                    c.out.push(dead);
                }
                delete c.visible[s.id];
            }
            if (s.owner) {
                s.owner.out.push(new Pkt().u8(C.v).u8(0).buf());
                s.owner.deadAt = now;
            } else {
                botRespawns.push(now + rnd(CFG.botRespawnMs[0], CFG.botRespawnMs[1]));
            }
        }

        function collisions() {
            rebuildHash();
            var dead = [];
            for (var si = 0; si < snakes.length; si++) {
                var s = snakes[si];
                if (now < s.protUntil) continue;
                var dx = s.hx - GRD, dy = s.hy - GRD;
                if (dx * dx + dy * dy > (R - 6) * (R - 6)) { dead.push([s, null]); continue; }
                var hit = bodyHit(s.hx, s.hy, 13 * s.sc, s);
                // be a little lenient: head must really overlap the body
                if (hit) {
                    var strict = bodyHitStrict(s);
                    if (strict) dead.push([s, strict]);
                }
            }
            for (var i = 0; i < dead.length; i++) killSnake(dead[i][0], dead[i][1]);
        }
        function bodyHitStrict(s) {
            var cx = Math.floor(s.hx / CS), cy = Math.floor(s.hy / CS);
            for (var yy = cy - 1; yy <= cy + 1; yy++) {
                for (var xx = cx - 1; xx <= cx + 1; xx++) {
                    if (xx < 0 || yy < 0 || xx >= GW || yy >= GW) continue;
                    for (var e = cellHead[yy * GW + xx]; e !== -1; e = entNext[e]) {
                        var i = entSeg[e], o = segOwner[i];
                        if (o === s || !o.alive) continue;
                        var lim = 0.8 * (13 * s.sc + 13 * o.sc);
                        if (ptSegDist2(s.hx, s.hy, i) < lim * lim) return o;
                    }
                }
            }
            return null;
        }

        // ------------------------------------------------------------------
        // Bot AI
        // ------------------------------------------------------------------
        var OFFS = [0, 0.26, -0.26, 0.52, -0.52, 0.87, -0.87, 1.3, -1.3, 1.75, -1.75, 2.3, -2.3, PI];

        function freeDist(b, a, L, obst, myR) {
            var ca = Math.cos(a), sa = Math.sin(a);
            for (var t = 30; t <= L; t += 26) {
                var px = b.hx + ca * t, py = b.hy + sa * t;
                var dx = px - GRD, dy = py - GRD;
                if (dx * dx + dy * dy > (R - 90 - myR) * (R - 90 - myR)) return t;
                for (var i = 0; i < obst.length; i++) {
                    var o = obst[i], ox = px - o.x, oy = py - o.y;
                    if (ox * ox + oy * oy < o.r * o.r) return t;
                }
                if (bodyHit(px, py, myR + 14, b)) return t;
            }
            return L;
        }
        function pickFood(b) {
            var csx = Math.floor(b.hx / SEC), csy = Math.floor(b.hy / SEC), best = null, bs = -1;
            for (var yy = csy - 2; yy <= csy + 2; yy++) {
                for (var xx = csx - 2; xx <= csx + 2; xx++) {
                    if (xx < 0 || yy < 0 || xx >= NSEC || yy >= NSEC) continue;
                    var m = secFood[secIdx(xx, yy)];
                    if (!m) continue;
                    m.forEach(function (f) {
                        var dx = f.x - b.hx, dy = f.y - b.hy, d = Math.sqrt(dx * dx + dy * dy);
                        if (d > 650) return;
                        var da = Math.abs(sdiff(b.ang, Math.atan2(dy, dx)));
                        var s = (f.sz * f.sz) / (d + 60) * (1.15 - da / PI * 0.95);
                        if (s > bs) { bs = s; best = f; }
                    });
                }
            }
            return best;
        }
        function thinkBot(b, si) {
            var ai = b.ai, sc = b.sc, myR = 13 * sc;
            var L = 140 + b.sp * 24 + sc * 16;
            var obst = [], prey = null, preyD = 1e9, threat = false;
            // Hunting is short bursts followed by a cool-down, so bots don't hound you forever.
            if (ai.hunting && now >= ai.huntUntil) { ai.hunting = false; ai.calmUntil = now + rnd(8000, 18000); }
            var canHunt = ai.hunting || (now >= ai.calmUntil && b.M > 3.2);
            for (var i = 0; i < snakes.length; i++) {
                var o = snakes[i];
                if (o === b) continue;
                var dx = o.hx - b.hx, dy = o.hy - b.hy, d2 = dx * dx + dy * dy;
                if (d2 > 700 * 700) continue;
                var d = Math.sqrt(d2), bigger = o.M > b.M * 1.05;
                if (bigger || ai.cautious || !ai.aggr)
                    obst.push({ x: o.hx + Math.cos(o.ang) * (55 + o.sp * 3), y: o.hy + Math.sin(o.ang) * (55 + o.sp * 3),
                        r: 13 * o.sc * 1.3 + 26 + (bigger ? 22 : 0) });
                // only hunt much smaller snakes that are close, and only while this bot is in a hunting mood
                if (!bigger && ai.aggr && canHunt && o.M < b.M * 0.65 && d < 420 && d < preyD) { prey = o; preyD = d; }
                if (bigger && d < 320) threat = true;
            }
            var goal, mode = 'eat';
            if (prey && !ai.hunting) {
                if (Math.random() < 0.3) { ai.hunting = true; ai.huntUntil = now + rnd(1500, 3500); }
                else { ai.calmUntil = now + rnd(2500, 6000); prey = null; }   // changed its mind
            }
            if (prey && b.M > 3.2) {
                var lead = Math.min(preyD * 0.5, 180);
                goal = Math.atan2(prey.hy + Math.sin(prey.ang) * lead - b.hy, prey.hx + Math.cos(prey.ang) * lead - b.hx);
                mode = 'hunt';
            } else {
                var f = pickFood(b);
                if (f) goal = Math.atan2(f.y - b.hy, f.x - b.hx);
                else { ai.wander += rnd(-0.4, 0.4); goal = ai.wander; }
            }
            var cdx = GRD - b.hx, cdy = GRD - b.hy, cd = Math.sqrt(cdx * cdx + cdy * cdy);
            if (cd > R * 0.8) {
                var toC = Math.atan2(cdy, cdx);
                var w = Math.min(1, (cd - R * 0.8) / (R * 0.15));
                goal = goal + sdiff(goal, toC) * w;
            }
            // pick the heading closest to the goal that has a clear path
            var chosen = null, bestA = goal, bestFd = -1, fd0 = L;
            var sgn = ai.turn;
            for (var k = 0; k < OFFS.length; k++) {
                var off = OFFS[k];
                if (k > 0 && sgn < 0) off = -off;
                var a = goal + off, fd = freeDist(b, a, L, obst, myR);
                if (k === 0) fd0 = fd;
                if (fd > bestFd) { bestFd = fd; bestA = a; }
                if (fd >= L - 1) { chosen = a; if (k > 0) ai.turn = off > 0 ? 1 : -1; break; }
            }
            if (chosen === null) chosen = bestA;
            // boost decisions
            var wantBoost = false;
            if (b.M > 3.4) {
                if (mode === 'hunt' && preyD < 380 && Math.abs(sdiff(b.ang, goal)) < 0.5) wantBoost = true;
                else if (threat && fd0 < L * 0.9 && Math.random() < 0.6) wantBoost = true;
                else if (b.M > 12 && Math.random() < 0.003) ai.burst = now + rnd(600, 1500);
            }
            if (ai.burst > now && b.M > 3.5) wantBoost = true;
            b.boost = wantBoost;
            ai.mode = mode;
            if (Math.abs(sdiff(b.wang, chosen)) > 0.05) retarget(b, chosen);
            ai.next = now + 90 + rnd(0, 110) + (1 - ai.skill) * 170;
        }

        // ------------------------------------------------------------------
        // Housekeeping (every ~100ms): what each client can currently see
        // ------------------------------------------------------------------
        function viewOf(c) {
            var v = c.getView ? c.getView() : null;
            var gsc = (v && v.gsc > 0) ? v.gsc : 0.9;
            var ww = (v && v.ww > 0) ? v.ww : 1280, hh = (v && v.hh > 0) ? v.hh : 720;
            return { gsc: gsc, ww: ww, hh: hh };
        }
        function updateLoaded(c) {
            var p = c.player, vm = viewOf(c);
            var vx = Math.max(3, Math.min(12, Math.ceil(vm.ww / 2 / vm.gsc / SEC) + 1));
            var vy = Math.max(3, Math.min(12, Math.ceil(vm.hh / 2 / vm.gsc / SEC) + 1));
            var csx = Math.floor(p.hx / SEC), csy = Math.floor(p.hy / SEC), next = {};
            for (var dy = -vy; dy <= vy; dy++) {
                for (var dx = -vx; dx <= vx; dx++) {
                    var sx = csx + dx, sy = csy + dy;
                    if (sx < 0 || sy < 0 || sx >= NSEC || sy >= NSEC) continue;
                    var cx = (sx + 0.5) * SEC - GRD, cy = (sy + 0.5) * SEC - GRD;
                    if (Math.sqrt(cx * cx + cy * cy) > R + SEC * 1.5) continue;
                    var key = secIdx(sx, sy);
                    next[key] = true;
                    if (!c.loaded[key]) sendSector(c, sx, sy);
                }
            }
            for (var k in c.loaded) {
                if (!next[k]) c.out.push(new Pkt().u8(C.w).u8(k % NSEC).u8(Math.floor(k / NSEC)).buf());
            }
            c.loaded = next;
        }
        function minDist2(s, px, py) {
            var best = 1e18, p = s.pts;
            var dx = s.hx - px, dy = s.hy - py;
            best = dx * dx + dy * dy;
            for (var k = p.length - 1; k >= 0; k -= 3) {
                dx = p[k].x - px; dy = p[k].y - py;
                var d = dx * dx + dy * dy;
                if (d < best) best = d;
            }
            return best;
        }
        function updateVisible(c) {
            var p = c.player, vm = viewOf(c);
            var vd = Math.sqrt(vm.ww * vm.ww + vm.hh * vm.hh) / 2 / vm.gsc + 350;
            for (var i = 0; i < snakes.length; i++) {
                var s = snakes[i];
                if (s === p) continue;
                var d2 = minDist2(s, p.hx, p.hy);
                if (c.visible[s.id]) {
                    if (d2 > (vd + 400) * (vd + 400)) { delete c.visible[s.id]; c.out.push(new Pkt().u8(C.s).u16(s.id).u8(0).buf()); }
                } else if (d2 < vd * vd) {
                    c.visible[s.id] = true;
                    c.out.push(sPacket(s));
                }
            }
        }
        function famUpdates() {
            for (var i = 0; i < snakes.length; i++) {
                var s = snakes[i];
                var f = famOf(s);
                if (Math.abs(f - s.lastFam) > 0.02 && anySees(s)) {
                    s.fam = f; s.lastFam = f;
                    var b = new Pkt().u8(C.h).u16(s.id).u24(Math.round(f * 16777215)).buf();
                    for (var k = 0; k < conns.length; k++) if (sees(conns[k], s)) conns[k].out.push(b);
                }
            }
        }
        function scoreCmp(a, b) { return b.M - a.M; }
        function sendLeaderboard(c, sorted) {
            var player = c.player;
            var rank = sorted.indexOf(player) + 1;
            var list = sorted.slice(0, 10), myPos = 0;
            if (rank > 10) { list[9] = player; myPos = 10; } else myPos = rank;
            var p = new Pkt().u8(C.l).u8(myPos).u16(rank).u16(snakes.length);
            for (var i = 0; i < list.length; i++) {
                var s = list[i];
                p.u16(s.sct).u24(Math.round(famOf(s) * 16777215)).u8(s.cv).u8(Math.min(24, s.name.length)).str(s.name.substr(0, 24));
            }
            c.out.push(p.buf());
        }
        function sendMinimap(c) {
            var N = 80, bits = new Uint8Array(N * N);
            function mark(x, y) {
                var px = Math.floor(((x - GRD) / R * 0.5 + 0.5) * N), py = Math.floor(((y - GRD) / R * 0.5 + 0.5) * N);
                if (px >= 0 && py >= 0 && px < N && py < N) bits[py * N + px] = 1;
            }
            for (var i = 0; i < snakes.length; i++) {
                var s = snakes[i];
                if (s === c.player) continue;
                mark(s.hx, s.hy);
                for (var k = s.pts.length - 1; k >= 0; k -= Math.max(2, Math.floor(s.pts.length / 8))) mark(s.pts[k].x, s.pts[k].y);
            }
            var p = new Pkt().u8(C.u), i2 = 0, total = N * N;
            while (i2 < total) {
                var r = 0;
                while (i2 + r < total && !bits[i2 + r] && r < 127) r++;
                if (r >= 7) { p.u8(128 + r); i2 += r; }
                else {
                    var byte = 0;
                    for (var j = 0; j < 7; j++) if (i2 + j < total && bits[i2 + j]) byte |= (64 >> j);
                    p.u8(byte); i2 += 7;
                }
            }
            c.out.push(p.buf());
        }
        function botCount() {
            var n = 0;
            for (var i = 0; i < snakes.length; i++) if (snakes[i].bot) n++;
            return n;
        }
        function addBot() {
            var nm = NAMES[Math.floor(Math.random() * NAMES.length)];
            var M0 = 2 + Math.pow(Math.random(), 2.2) * 9;
            spawnSnake(nm, Math.floor(Math.random() * 38), null, M0);
        }
        function removeBot() {
            for (var i = snakes.length - 1; i >= 0; i--) if (snakes[i].bot) {
                var s = snakes[i];
                killSnake(s, null);
                botRespawns.pop();     // that death must not schedule a respawn
                return;
            }
        }
        function housekeeping() {
            var i, c, live = [];
            for (i = 0; i < conns.length; i++) {
                c = conns[i];
                if (c.state === 'playing' && c.player && c.player.alive) live.push(c);
            }
            for (i = 0; i < live.length; i++) { updateLoaded(live[i]); updateVisible(live[i]); }
            famUpdates();
            // pellet respawns
            for (i = foodRespawns.length - 1; i >= 0; i--) {
                if (foodRespawns[i].t <= now) { randomPellet(foodRespawns[i].sx, foodRespawns[i].sy, true); foodRespawns.splice(i, 1); }
            }
            // keep the bot population at its target (alive + waiting to respawn)
            for (i = botRespawns.length - 1; i >= 0; i--) {
                if (botRespawns[i] <= now) { botRespawns.splice(i, 1); addBot(); }
            }
            var have = botCount() + botRespawns.length;
            if (have < CFG.bots) addBot();
            else if (have > CFG.bots) { if (botRespawns.length) botRespawns.pop(); else removeBot(); }
            if (now - lastLb > 1000) {
                lastLb = now;
                if (live.length) {
                    var sorted = snakes.slice().sort(scoreCmp);
                    for (i = 0; i < live.length; i++) sendLeaderboard(live[i], sorted);
                }
            }
            if (now - lastMap > 1500) { lastMap = now; for (i = 0; i < live.length; i++) sendMinimap(live[i]); }
        }

        // ------------------------------------------------------------------
        // Main loop
        // ------------------------------------------------------------------
        function step() {
            tickN++; now += TICK;
            for (var i = 0; i < snakes.length; i++) {
                var s = snakes[i];
                if (s.bot && now >= s.ai.next) thinkBot(s, i);
                stepSnake(s);
            }
            if (tickN % 4 === 0) collisions();
            if (tickN % 12 === 0) housekeeping();
        }
        function flushConn(c, force) {
            if (!c.out.length) return;
            var t = performance.now();
            if (!force && c.minInterval && t - c.lastSend < c.minInterval) return;
            c.lastSend = t;
            var q = c.out; c.out = [];
            try { c.deliver(q); } catch (e) { console.error('[sim] deliver error', e); }
        }
        function loop() {
            if (!running) return;
            var t = performance.now();
            if (!lastReal) lastReal = t;
            acc += Math.min(200, t - lastReal); lastReal = t;
            try {
                // time budget: if the machine can't keep up the game slows down instead of freezing the page
                while (acc >= TICK) {
                    step(); acc -= TICK;
                    if (performance.now() - t > 14) { acc = 0; break; }
                }
            } catch (e) {
                if (!errored) { errored = true; console.error('[sim] simulation error', e); }
            }
            for (var i = 0; i < conns.length; i++) flushConn(conns[i], false);
        }

        // ------------------------------------------------------------------
        // Client -> server
        // ------------------------------------------------------------------
        function startPlaying(c, nick, cv) {
            c.state = 'playing';
            c.loaded = {}; c.visible = {};
            var P = new Pkt().u8(C.a).u24(GRD).u16(MSCPS).u16(SEC).u16(NSEC).u8(Math.round(SPANGDV * 10))
                .u16(Math.round(NSP1 * 100)).u16(Math.round(NSP2 * 100)).u16(Math.round(NSP3 * 100))
                .u16(Math.round(MAMU * 1000)).u16(Math.round(MAMU2 * 1000)).u16(Math.round(CST * 1000))
                .u8(PROTO).u8(MSL).u16(0).u24(R).u8(0).u8(0);
            c.out.push(P.buf());
            c.player = spawnSnake(nick || '', cv, c, 2);
            c.out.push(sPacket(c.player));       // the first snake a client hears about is its own
            updateLoaded(c);
            updateVisible(c);
            sendLeaderboard(c, snakes.slice().sort(scoreCmp));
            sendMinimap(c);
            flushConn(c, true);
        }
        function onClient(c, u8) {
            if (!running || c.closed) return;
            if (c.state === 'init') {
                if (u8.length <= 2 && u8[0] === 99) {            // "c": version handshake ([99] or [99,0])
                    c.out.push(new Pkt().u8(C.six).str('abcdefghijklmnopqrstuvwxyzabcdefghij').buf());
                } else if (u8.length >= 28 && u8[0] === 115) {    // 's': login
                    var cv = u8[24] % 42, nl = u8[25], nick = '';
                    for (var i = 0; i < nl && 26 + i < u8.length; i++) nick += String.fromCharCode(u8[26 + i]);
                    startPlaying(c, nick, cv);
                    return;
                }
                setTimeout(function () { flushConn(c, true); }, 0);
                return;
            }
            var player = c.player;
            if (!player || !player.alive) {
                if (u8.length === 1 && u8[0] === 251) { c.out.push(new Pkt().u8(C.p).buf()); setTimeout(function () { flushConn(c, true); }, 0); }
                return;
            }
            if (u8.length === 1) {
                var b = u8[0];
                if (b <= 250) {
                    var a = (b + 0.5) * PI2 / 251;
                    if (Math.abs(sdiff(player.wang, a)) > K256 * 0.6) retarget(player, a);
                } else if (b === 251) { c.out.push(new Pkt().u8(C.p).buf()); setTimeout(function () { flushConn(c, true); }, 0); }
                else if (b === 253) player.boost = true;
                else if (b === 254) player.boost = false;
            } else if (u8.length === 2 && u8[0] === 252) {        // keyboard turning
                var v = u8[1], dd = MAMU * (v & 127) * player.scang * Math.min(1, player.sp / SPANGDV);
                retarget(player, player.wang + (v >= 128 ? dd : -dd));
            }
        }

        // ------------------------------------------------------------------
        // Public API
        // ------------------------------------------------------------------
        var world = {
            start: function () {
                if (running) return;
                running = true;
                fillWorld();
                for (var i = 0; i < CFG.bots; i++) addBot();
                lastReal = performance.now();
                ticker = makeTicker(loop, TICK);
            },
            stop: function () {
                running = false;
                if (ticker) ticker.stop();
                ticker = null;
                var list = conns.slice();
                conns = [];
                for (var i = 0; i < list.length; i++) {
                    list[i].closed = true;
                    if (list[i].onClosed) { try { list[i].onClosed(); } catch (e) {} }
                }
            },
            setBots: function (n) { CFG.bots = Math.max(0, Math.min(80, n | 0)); },
            getBots: function () { return CFG.bots; },
            isRunning: function () { return running; },
            // how many human-controlled snakes are alive right now
            alivePlayers: function () { var n = 0; for (var i = 0; i < snakes.length; i++) if (snakes[i].owner) n++; return n; },
            connect: function (o) {
                var c = {
                    id: nextConnId++, state: 'init', closed: false, player: null, loaded: {}, visible: {},
                    out: [], lastSend: 0, deadAt: -1,
                    deliver: o.deliver, getView: o.getView || null, minInterval: o.minInterval || 0,
                    onClosed: o.onClosed || null,
                    send: function (u8) { onClient(c, u8); },
                    close: function () {
                        if (c.closed) return;
                        c.closed = true;
                        var i = conns.indexOf(c);
                        if (i >= 0) conns.splice(i, 1);
                        if (c.player && c.player.alive) killSnake(c.player, null);
                        c.out.length = 0;
                    }
                };
                conns.push(c);
                return c;
            }
        };
        return world;
    }

    window.SlitherSim = { createWorld: createWorld };
})();

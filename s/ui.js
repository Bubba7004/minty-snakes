/*
 * ui.js - menu, lobby and room UI for the local-network edition
 * (talks to LAN from net.js and hooks the original page's Play button)
 */
(function () {
    'use strict';
    var LAN = window.LAN;
    var NBSP = String.fromCharCode(160);

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------
    var css = [
        '#csrvh{display:none !important}',   // "Choose Server" only made sense for real online servers
        '.lan-btn{display:block;margin:10px auto 0;width:190px;height:58px;border:0;border-radius:40px;cursor:pointer;',
        ' background:linear-gradient(#9a80ff,#5a3fd6);color:#ffc98a;font:bold 19px/58px "Lucida Sans Unicode","Lucida Grande",sans-serif;',
        ' letter-spacing:1px;text-shadow:0 2px 0 #3a2490,0 0 8px rgba(0,0,0,.5);box-shadow:0 4px 18px rgba(0,0,0,.5),inset 0 0 0 2px rgba(255,255,255,.12);',
        ' opacity:.85;outline:none;text-transform:uppercase}',
        '.lan-btn:hover{opacity:1}.lan-btn:active{opacity:.6}',
        '.lan-btn.sm{width:150px;height:38px;font-size:13px;line-height:38px;background:linear-gradient(#5b5a86,#3a3860);color:#d5d3ff;text-shadow:none;margin-top:14px}',
        '.lan-roomtxt{margin-top:12px;color:#a7a0e8;font:13px "Lucida Sans Unicode","Lucida Grande",sans-serif;text-align:center}',
        '.lan-roomtxt b{color:#ffc98a;letter-spacing:3px}',
        '.lan-ov{position:fixed;left:0;top:0;width:100%;height:100%;z-index:1000;display:none;align-items:center;justify-content:center;',
        ' background:rgba(8,10,22,.84);overflow:auto;font-family:"Lucida Sans Unicode","Lucida Grande",sans-serif;color:#e0e0ff}',
        '.lan-card{box-sizing:border-box;width:min(94vw,520px);max-height:96vh;overflow:auto;margin:auto;padding:22px 24px 20px;border-radius:20px;',
        ' background:#241d4a;box-shadow:0 10px 60px rgba(0,0,0,.8),inset 0 0 0 2px #4c447c;text-align:left}',
        '.lan-h{display:flex;align-items:center;justify-content:space-between;font-size:24px;font-weight:bold;color:#fff;margin-bottom:14px}',
        '.lan-x{background:none;border:0;color:#8f89c8;font-size:28px;cursor:pointer;line-height:1;padding:0 4px}.lan-x:hover{color:#fff}',
        '.lan-l{font-size:12px;color:#8f89c8;margin:12px 0 5px;text-transform:uppercase;letter-spacing:1px}',
        '.lan-in{box-sizing:border-box;width:100%;height:38px;border:0;border-radius:10px;background:#4c447c;color:#e0e0ff;font-size:16px;padding:0 12px;outline:none}',
        '.lan-in::placeholder{color:#7070b0}',
        '.lan-row{display:flex;gap:10px;align-items:center}',
        '.lan-code{font-size:26px;letter-spacing:10px;text-align:center;text-transform:uppercase;font-weight:bold;height:46px;color:#ffc98a}',
        '.lan-b{border:0;border-radius:10px;height:46px;padding:0 20px;cursor:pointer;font:bold 15px "Lucida Sans Unicode","Lucida Grande",sans-serif;',
        ' color:#fff;background:linear-gradient(#8b6cff,#5a3fd6);white-space:nowrap}.lan-b:hover{filter:brightness(1.15)}.lan-b:disabled{opacity:.45;cursor:default}',
        '.lan-b.alt{background:#4c447c}.lan-b.go{background:linear-gradient(#45d27a,#1f9a52)}.lan-b.full{width:100%;margin-top:14px}',
        '.lan-b.dim{background:#37316a;font-weight:normal;color:#c9c5ff}',
        '.lan-list{background:#1a1538;border-radius:12px;min-height:56px;max-height:190px;overflow:auto;padding:4px}',
        '.lan-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px}.lan-item:hover{background:#2a2358}',
        '.lan-item .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lan-item .n small{display:block;color:#8f89c8;font-size:12px}',
        '.lan-item .c{color:#ffc98a;font-weight:bold;letter-spacing:3px}',
        '.lan-item button{height:32px;padding:0 14px;font-size:13px}',
        '.lan-empty{padding:16px;text-align:center;color:#8f89c8;font-size:14px}',
        '.lan-msg{min-height:20px;margin-top:10px;font-size:14px;color:#ff8a8a}',
        '.lan-url{margin-top:8px;font-size:12px;color:#8f89c8;word-break:break-all}.lan-url b{color:#bdb6ff}',
        '.lan-big{font-size:72px;letter-spacing:14px;padding-left:14px;text-align:center;font-weight:bold;color:#ffc98a;cursor:pointer;',
        ' text-shadow:0 0 24px rgba(255,201,138,.35);line-height:1.1;user-select:all}',
        '.lan-cap{text-align:center;font-size:12px;color:#8f89c8;margin-top:2px}',
        '.lan-pl{list-style:none;margin:0;padding:0}.lan-pl li{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;background:#2f2860;margin-bottom:5px}',
        '.lan-pl .h{margin-left:auto;font-size:11px;color:#ffc98a;letter-spacing:1px}',
        '.lan-sl{display:flex;align-items:center;gap:12px}.lan-sl input{flex:1;accent-color:#8b6cff}.lan-sl span{width:28px;text-align:right;font-weight:bold}',
        '.lan-chk{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px}',
        '.lan-ta{box-sizing:border-box;width:100%;height:74px;border:0;border-radius:10px;background:#1a1538;color:#cfcaff;font:12px monospace;padding:8px;resize:none;outline:none;word-break:break-all}',
        '.lan-inv{background:#2f2860;border-radius:12px;padding:10px 12px;margin-top:10px}.lan-inv .st{font-size:13px;color:#c7c2ff;margin:6px 0 4px}',
        '.lan-b.sm{height:32px;padding:0 14px;font-size:13px}.lan-ok{color:#7be3a0}.lan-sep{border-top:1px solid #3a3470;margin:16px 0 4px}',
        '.lan-badge{position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:30;display:none;padding:5px 14px;border-radius:14px;',
        ' background:rgba(20,16,50,.65);color:#c7c2ff;font:12px "Lucida Sans Unicode","Lucida Grande",sans-serif;letter-spacing:.5px;white-space:nowrap}',
        '.lan-badge b{color:#ffc98a;letter-spacing:2px}.lan-badge a{color:#ff9d9d;cursor:pointer;margin-left:8px;text-decoration:underline}',
        '.lan-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:1100;padding:12px 22px;border-radius:14px;',
        ' background:#241d4a;color:#fff;box-shadow:0 6px 30px rgba(0,0,0,.7),inset 0 0 0 2px #8b6cff;font:15px "Lucida Sans Unicode","Lucida Grande",sans-serif;display:none}'
    ].join('\n');
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    // ------------------------------------------------------------------
    // Tiny DOM helpers
    // ------------------------------------------------------------------
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
    function btn(label, cls, fn) { var b = el('button', 'lan-b ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; }
    function slider(min, max, val, onchange) {
        var wrap = el('div', 'lan-sl'), r = el('input'), v = el('span', '', val);
        r.type = 'range'; r.min = min; r.max = max; r.value = val;
        r.oninput = function () { v.textContent = r.value; };
        r.onchange = function () { if (onchange) onchange(+r.value); };
        wrap.appendChild(r); wrap.appendChild(v);
        wrap.input = r; wrap.label = v;
        return wrap;
    }
    function setSlider(s, val) { if (+s.input.value !== val && document.activeElement !== s.input) { s.input.value = val; s.label.textContent = val; } }

    function copyText(ta, label) {
        ta.focus(); ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        if (!ok) { try { navigator.clipboard.writeText(ta.value); ok = true; } catch (e) {} }
        toast(ok ? (label || 'Copied') : 'Press Ctrl+C to copy');
    }

    var ov = el('div', 'lan-ov'), card = el('div', 'lan-card');
    ov.appendChild(card);
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu', 'wheel'].forEach(function (ev) {
        ov.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    var badge = el('div', 'lan-badge'), toastEl = el('div', 'lan-toast');
    ['mousedown', 'mouseup', 'touchstart'].forEach(function (ev) { badge.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    document.body.appendChild(ov); document.body.appendChild(badge); document.body.appendChild(toastEl);

    var toastTimer = null;
    function toast(msg) {
        toastEl.textContent = msg; toastEl.style.display = 'block';
        clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 4500);
    }

    // ------------------------------------------------------------------
    // Player name
    // ------------------------------------------------------------------
    function loadName() {
        var n = '';
        try { n = localStorage.lan_name || ''; } catch (e) {}
        var nick = document.getElementById('nick');
        if (nick && nick.value) n = nick.value;
        if (!n) n = 'Snake' + Math.floor(100 + Math.random() * 900);
        return n.replace(/[^\x20-\x7e]/g, '').slice(0, 24);
    }
    var myName = loadName();
    function saveName(n) {
        n = (n || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 24) || myName;
        myName = n;
        try { localStorage.lan_name = n; } catch (e) {}
        var nick = document.getElementById('nick'); if (nick) nick.value = n;
        return n;
    }

    // ------------------------------------------------------------------
    // Screens
    // ------------------------------------------------------------------
    var screen = null, pollTimer = null, lanUrl = '', lobby = null;

    function header(title, closeFn) {
        var h = el('div', 'lan-h'); h.appendChild(el('span', '', title));
        if (closeFn) { var x = el('button', 'lan-x', '×'); x.type = 'button'; x.onclick = closeFn; h.appendChild(x); }
        card.appendChild(h);
    }
    function showOverlay() { ov.style.display = 'flex'; }
    function closeModal() { ov.style.display = 'none'; screen = null; stopPoll(); }
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    function fetchUrl(target) {
        LAN.info().then(function (i) {
            var u = (i.urls && i.urls[0]) || '';
            lanUrl = u;
            if (target && u) { target.innerHTML = ''; target.appendChild(document.createTextNode('Friends on your Wi-Fi open ')); target.appendChild(el('b', '', u)); target.appendChild(document.createTextNode(' then press Multiplayer')); }
        }, function () {});
    }

    // ---- hub ----
    function openHub() {
        if (LAN.mode === 'solo') return;
        if (LAN.room && !(LAN.room.role === 'host' ? LAN.room.started : LAN.room.state && LAN.room.state.started)) { openLobby(); return; }
        screen = 'hub'; clear(card);
        header('Multiplayer', closeModal);
        var msg = el('div', 'lan-msg');

        card.appendChild(el('div', 'lan-l', 'Your name'));
        var name = el('input', 'lan-in'); name.maxLength = 24; name.placeholder = 'Nickname'; name.value = myName;
        name.onchange = function () { saveName(name.value); };
        card.appendChild(name);

        card.appendChild(el('div', 'lan-l', 'Join with a room code (4 = LAN server, 5 = online code)'));
        var row = el('div', 'lan-row'), code = el('input', 'lan-in lan-code'); code.maxLength = 5; code.placeholder = 'CODE'; code.autocomplete = 'off'; code.spellcheck = false;
        code.oninput = function () { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
        var joinB = btn('Join', '', function () { doJoin(code.value); });
        code.onkeydown = function (e) { if (e.key === 'Enter') doJoin(code.value); };
        row.appendChild(code); row.appendChild(joinB); card.appendChild(row);

        function doJoin(c) {
            c = (c || '').trim();
            if (c.length < 4) { msg.textContent = 'Room codes are 4 or 5 letters/numbers.'; return; }
            msg.style.color = ''; msg.textContent = ''; joinB.disabled = true;
            var nm = saveName(name.value);
            if (c.length === 5) {                      // 5 characters = online-paired room (no server)
                msg.style.color = '#c7c2ff'; msg.textContent = 'Looking for room ' + c + '\u2026';
                LAN.joinFb(c, nm).then(function () { msg.textContent = 'Connecting to the host\u2026'; },
                    function (e) { joinB.disabled = false; msg.style.color = ''; msg.textContent = e.message; });
                return;
            }
            LAN.joinRoom(c, nm).then(function () { joinB.disabled = false; openLobby(); },
                function (e) { joinB.disabled = false; msg.textContent = e.message; });
        }

        card.appendChild(btn('Create a room (gives a 5-letter code)', 'full go', function () { saveName(name.value); openCreate(); }));

        card.appendChild(el('div', 'lan-l', 'Open games'));
        var list = el('div', 'lan-list'); list.appendChild(el('div', 'lan-empty', 'Looking for rooms…')); card.appendChild(list);
        card.appendChild(msg);
        var url = el('div', 'lan-url'); card.appendChild(url);
        fetchUrl(url);
        if (LAN.directSupported()) {
            var adv = el('details'); adv.style.marginTop = '14px';
            var sum = el('summary', 'lan-l', 'Advanced: manual copy/paste pairing (no internet)'); sum.style.cursor = 'pointer'; adv.appendChild(sum);
            var drow = el('div', 'lan-row'); drow.style.marginTop = '8px';
            var hb = btn('Host (manual)', 'alt', function () { saveName(name.value); openDirectHost(); }); hb.style.flex = '1';
            var jb = btn('Join (manual)', 'alt', function () { saveName(name.value); openDirectJoin(); }); jb.style.flex = '1';
            drow.appendChild(hb); drow.appendChild(jb); adv.appendChild(drow); card.appendChild(adv);
        }

        function poll() {
            if (screen !== 'hub') return;
            Promise.all([
                LAN.listFbRooms().then(function (r) { return { ok: true, rooms: r }; }, function (e) { return { ok: false, err: e.message, rooms: [] }; }),
                LAN.listRooms().then(function (r) { return r.map(function (x) { x.lan = true; return x; }); }, function () { return []; })
            ]).then(function (res) {
                if (screen !== 'hub') return;
                var fb = res[0], rooms = fb.rooms.concat(res[1]);
                clear(list);
                if (!rooms.length) { list.appendChild(el('div', 'lan-empty', fb.ok ? 'No open games right now \u2013 create one, or type a code above.' : fb.err)); return; }
                rooms.forEach(function (r) {
                    var full = r.players >= r.max;
                    var it = el('div', 'lan-item'), n = el('div', 'n', r.name), s2 = el('small', '', r.host + '  \u00b7  ' + r.players + '/' + r.max + ' players' + (r.bots ? '  \u00b7  ' + r.bots + ' bots' : '') + (r.started ? '  \u00b7  in game' : '') + (r.lan ? '  \u00b7  LAN server' : ''));
                    n.appendChild(s2);
                    it.appendChild(n); it.appendChild(el('div', 'c', r.code));
                    var jb2 = btn(full ? 'Full' : 'Join', '', function () { code.value = r.code; doJoin(r.code); });
                    jb2.disabled = full;
                    it.appendChild(jb2);
                    list.appendChild(it);
                });
            });
        }
        showOverlay(); stopPoll(); poll(); pollTimer = setInterval(poll, 3000);
        setTimeout(function () { code.focus(); }, 30);
    }

    // ---- create ----
    function openCreate() {
        screen = 'create'; stopPoll(); clear(card);
        header('Create a room', closeModal);
        var msg = el('div', 'lan-msg');
        card.appendChild(el('div', 'lan-l', 'Room type'));
        var how = el('select', 'lan-in');
        [['fb', '5-letter code  (no server, needs internet just to pair)'], ['srv', '4-letter code  (needs the LAN server running)']].forEach(function (o) {
            var op = el('option', '', o[1]); op.value = o[0]; how.appendChild(op);
        });
        card.appendChild(how);
        card.appendChild(el('div', 'lan-l', 'Room name'));
        var rn = el('input', 'lan-in'); rn.maxLength = 32; rn.value = myName + '\'s room'; card.appendChild(rn);
        card.appendChild(el('div', 'lan-l', 'Bots to fill the arena'));
        var bots = slider(0, 400, 12); card.appendChild(bots);
        card.appendChild(el('div', 'lan-l', 'Max players'));
        var max = slider(2, 16, 8); card.appendChild(max);
        var chkRow = el('label', 'lan-chk'), chk = el('input'); chk.type = 'checkbox'; chk.checked = true; chkRow.appendChild(chk);
        chkRow.appendChild(document.createTextNode('Show in the Open games list (otherwise join by code only)')); card.appendChild(chkRow);
        card.appendChild(msg);
        var row = el('div', 'lan-row'); row.style.marginTop = '16px';
        row.appendChild(btn('Back', 'alt', openHub));
        var go = btn('Create room', 'go', function () {
            go.disabled = true; msg.textContent = '';
            var o = { name: rn.value.trim() || 'Room', hostName: myName, max: +max.input.value, bots: +bots.input.value, pub: chk.checked };
            (how.value === 'fb' ? LAN.createFbRoom(o) : LAN.createRoom(o))
                .then(function () { openLobby(); }, function (e) { go.disabled = false; msg.textContent = e.message; });
        });
        go.style.flex = '1'; row.appendChild(go); card.appendChild(row);
        showOverlay();
        setTimeout(function () { rn.select(); }, 30);
    }

    // ---- direct (no server) ----
    function openDirectHost() {
        screen = 'dhost'; stopPoll(); clear(card);
        header('Host a direct room', closeModal);
        card.appendChild(el('div', 'lan-cap', 'No server needed. You\'ll swap short codes with each friend.'));
        card.appendChild(el('div', 'lan-l', 'Bots to fill the arena'));
        var bots = slider(0, 400, 12); card.appendChild(bots);
        card.appendChild(el('div', 'lan-l', 'Max players'));
        var max = slider(2, 16, 8); card.appendChild(max);
        var msg = el('div', 'lan-msg'); card.appendChild(msg);
        var row = el('div', 'lan-row'); row.style.marginTop = '16px';
        row.appendChild(btn('Back', 'alt', openHub));
        var go = btn('Create room', 'go', function () {
            try { LAN.createDirectRoom({ name: myName + '\'s room', hostName: myName, max: +max.input.value, bots: +bots.input.value }); openLobby(); }
            catch (e) { msg.textContent = e.message; }
        });
        go.style.flex = '1'; row.appendChild(go); card.appendChild(row);
        showOverlay();
    }
    function openDirectJoin() {
        screen = 'djoin'; stopPoll(); clear(card);
        header('Join a direct room', closeModal);
        var msg = el('div', 'lan-msg');
        card.appendChild(el('div', 'lan-l', '1. Paste the invite code from the host'));
        var inv = el('textarea', 'lan-ta'); inv.placeholder = 'Starts with O…'; inv.spellcheck = false; card.appendChild(inv);
        var mk = btn('Create my reply code', 'full', function () {
            msg.textContent = ''; mk.disabled = true; mk.textContent = 'Working…';
            LAN.joinDirect(inv.value, myName).then(function (r) {
                mk.style.display = 'none'; inv.readOnly = true;
                reply.value = r.reply; step2.style.display = 'block';
                waiting.textContent = 'Waiting for the host to paste it…';
                copyText(reply, 'Reply code copied');
            }, function (e) { mk.disabled = false; mk.textContent = 'Create my reply code'; msg.textContent = e.message; });
        });
        card.appendChild(mk);
        var step2 = el('div'); step2.style.display = 'none';
        step2.appendChild(el('div', 'lan-l', '2. Send this reply code back to the host'));
        var reply = el('textarea', 'lan-ta'); reply.readOnly = true; reply.onclick = function () { reply.select(); };
        step2.appendChild(reply);
        var cp = btn('Copy reply code', 'alt sm', function () { copyText(reply, 'Reply code copied'); }); cp.style.marginTop = '8px';
        step2.appendChild(cp);
        var waiting = el('div', 'lan-cap'); waiting.style.marginTop = '12px'; step2.appendChild(waiting);
        card.appendChild(step2);
        card.appendChild(msg);
        var row = el('div', 'lan-row'); row.style.marginTop = '16px';
        row.appendChild(btn('Back', 'alt', function () { LAN.leave(); openHub(); }));
        card.appendChild(row);
        showOverlay();
        setTimeout(function () { inv.focus(); }, 30);
    }
    function addInviteCard(room, holder) {
        var box = el('div', 'lan-inv');
        box.appendChild(el('div', 'st', 'Invite a friend'));
        var status = el('div', 'st', 'Making invite…'); box.appendChild(status);
        holder.appendChild(box);
        room.addPeer().then(function (peer) {
            status.textContent = '1. Send this invite code to your friend (they open Multiplayer → Join a room)';
            var ta = el('textarea', 'lan-ta'); ta.readOnly = true; ta.value = peer.invite; ta.onclick = function () { ta.select(); };
            box.appendChild(ta);
            var cp = btn('Copy invite code', 'alt sm', function () { copyText(ta, 'Invite code copied'); }); cp.style.marginTop = '6px'; box.appendChild(cp);
            box.appendChild(el('div', 'st', '2. Paste the reply code they send back'));
            var rp = el('textarea', 'lan-ta'); rp.placeholder = 'Starts with A…'; rp.spellcheck = false; box.appendChild(rp);
            var err = el('div', 'lan-msg'); err.style.minHeight = '0';
            var cn = btn('Connect', 'go sm', function () {
                err.textContent = ''; cn.disabled = true;
                peer.accept(rp.value).then(function () { cn.textContent = 'Connecting…'; },
                    function (e) { cn.disabled = false; err.textContent = e.message; });
            });
            cn.style.marginTop = '6px';
            var x = btn('Cancel', 'dim sm', function () { peer.cancel(); box.remove(); }); x.style.margin = '6px 0 0 8px';
            box.appendChild(cn); box.appendChild(x); box.appendChild(err);
            peer.onconnected = function () { box.remove(); toast('A friend connected!'); };
        }, function (e) { status.textContent = e.message; status.style.color = '#ff8a8a'; });
    }

    // ---- lobby ----
    function openLobby() {
        var room = LAN.room;
        if (!room) { openHub(); return; }
        screen = 'lobby'; stopPoll(); clear(card);
        var isHost = room.role === 'host';
        header(isHost ? 'Your room' : 'Room lobby', null);
        lobby = {};
        var direct = room.code === 'DIRECT', viaFb = !!room.p2p && !direct;
        var code = el('div', 'lan-big', direct ? 'DIRECT' : room.code); code.title = direct ? '' : 'Click to copy';
        if (direct) { code.style.fontSize = '40px'; code.style.letterSpacing = '8px'; code.style.cursor = 'default'; }
        else code.onclick = function () { try { navigator.clipboard.writeText(room.code); toast('Room code copied'); } catch (e) {} };
        card.appendChild(code);
        card.appendChild(el('div', 'lan-cap', direct ? 'NO SERVER \u00b7 SAME WI-FI' : 'ROOM CODE'));
        lobby.name = el('div', 'lan-cap'); lobby.name.style.fontSize = '14px'; lobby.name.style.color = '#c7c2ff'; lobby.name.style.marginTop = '8px';
        card.appendChild(lobby.name);

        card.appendChild(el('div', 'lan-l', 'Players'));
        lobby.list = el('ul', 'lan-pl'); card.appendChild(lobby.list);

        if (isHost) {
            card.appendChild(el('div', 'lan-l', 'Bots'));
            lobby.bots = slider(0, 400, room.world.getBots(), function (v) { room.setBots(v); });
            card.appendChild(lobby.bots);
            card.appendChild(el('div', 'lan-l', 'Max players'));
            lobby.max = slider(2, 16, room.max, function (v) { room.setMax(v); });
            card.appendChild(lobby.max);
        } else {
            lobby.wait = el('div', 'lan-empty', 'Waiting for the host to start…'); card.appendChild(lobby.wait);
        }
        lobby.url = el('div', 'lan-url'); card.appendChild(lobby.url);
        if (viaFb) lobby.url.textContent = 'Friends: open the game \u2192 Multiplayer \u2192 type this code (same Wi-Fi).';
        else if (!direct) fetchUrl(lobby.url);
        if (direct && isHost) {
            var holder = el('div'); card.appendChild(holder);
            var ib = btn('+ Invite a friend', 'alt full', function () { addInviteCard(room, holder); });
            card.insertBefore(ib, holder);
            addInviteCard(room, holder);
        }

        var row = el('div', 'lan-row'); row.style.marginTop = '16px';
        row.appendChild(btn(isHost ? 'Close room' : 'Leave', 'alt', function () { LAN.leave(); openHub(); }));
        if (isHost) {
            var go = btn('Start game', 'go', function () { room.start(); closeModal(); beginPlay(); });
            go.style.flex = '1'; row.appendChild(go);
        }
        card.appendChild(row);
        showOverlay();
        updateLobby();
        var s0 = roomState();
        if (!isHost && s0 && s0.started) { closeModal(); beginPlay(); }   // joined a game that's already running
    }
    function updateLobby() {
        var room = LAN.room;
        if (screen !== 'lobby' || !room || !lobby) return;
        var s = room.role === 'host' ? room.state() : room.state;
        if (!s) return;
        lobby.name.textContent = s.name + '  ·  hosted by ' + s.hostName;
        clear(lobby.list);
        s.players.forEach(function (p) {
            var li = el('li'); li.appendChild(el('span', '', p.n)); if (p.h) li.appendChild(el('span', 'h', 'HOST')); lobby.list.appendChild(li);
        });
        if (s.bots) { var b = el('li'); b.style.opacity = '.7'; b.appendChild(el('span', '', s.bots + ' bot' + (s.bots === 1 ? '' : 's'))); b.appendChild(el('span', 'h', 'AI')); lobby.list.appendChild(b); }
        if (lobby.bots) { setSlider(lobby.bots, s.bots); setSlider(lobby.max, s.max); }
    }

    // ------------------------------------------------------------------
    // Starting a game from the lobby / menu
    // ------------------------------------------------------------------
    function beginPlay(tries) {
        tries = tries || 0;
        var busy = typeof play_btn === 'undefined' || !play_btn || play_btn.disabled || (typeof want_play !== 'undefined' && want_play);
        if (busy) { if (tries < 50) setTimeout(function () { beginPlay(tries + 1); }, 100); return; }
        var nick = document.getElementById('nick'); if (nick) nick.value = myName;
        play_btn.elem.onclick();
    }
    function startSolo() {
        if (typeof play_btn === 'undefined' || !play_btn || play_btn.disabled) return;
        if (typeof want_play !== 'undefined' && want_play) return;
        LAN.startSolo();
        beginPlay();
    }
    window.startSolo = startSolo;

    // ------------------------------------------------------------------
    // Reacting to room / mode changes
    // ------------------------------------------------------------------
    var menu = null, soloBtn = null, mpBtn = null, leaveBtn = null, roomTxt = null, lastMode = 'none';
    function roomState() { var r = LAN.room; return r ? (r.role === 'host' ? r.state() : r.state) : null; }

    function refresh() {
        var mode = LAN.mode, s = roomState(), inRoom = mode === 'host' || mode === 'guest';
        if (menu) {
            soloBtn.style.display = mode === 'none' ? 'block' : 'none';
            mpBtn.style.display = mode === 'none' ? 'block' : 'none';
            leaveBtn.style.display = mode === 'none' ? 'none' : 'block';
            leaveBtn.textContent = mode === 'solo' ? 'Main menu' : (mode === 'host' ? 'Close room' : 'Leave room');
            roomTxt.style.display = inRoom ? 'block' : 'none';
            if (inRoom && s) { clear(roomTxt); roomTxt.appendChild(document.createTextNode(s.code === 'DIRECT' ? 'Direct room' : 'Room ')); if (s.code !== 'DIRECT') roomTxt.appendChild(el('b', '', s.code)); roomTxt.appendChild(document.createTextNode('  ·  ' + s.players.length + ' player' + (s.players.length === 1 ? '' : 's'))); }
            if (typeof play_btn !== 'undefined' && play_btn) {
                play_btn.elem.style.display = mode === 'none' ? 'none' : 'inline-block';
                if (mode !== lastMode && lastMode === 'none' && mode !== 'none') { try { play_btn.setText(NBSP + 'Play' + NBSP); } catch (e) {} }
            }
        }
        lastMode = mode;
        if (inRoom && s) {
            clear(badge);
            badge.appendChild(document.createTextNode(s.code === 'DIRECT' ? 'DIRECT ROOM' : 'ROOM ')); if (s.code !== 'DIRECT') badge.appendChild(el('b', '', s.code));
            badge.appendChild(document.createTextNode('  ·  ' + s.players.length + ' player' + (s.players.length === 1 ? '' : 's')));
            var lv = el('a', '', mode === 'host' ? 'close' : 'leave'); lv.onclick = function () { LAN.leave(); };
            badge.appendChild(lv);
            badge.style.display = 'block';
        } else badge.style.display = 'none';
    }

    LAN.on(function (what) {
        if (what && what.closed) {
            toast(what.closed);
            if (screen) openHub();
        } else if (what === 'room') {
            if (screen === 'djoin' || screen === 'hub') {
                if (LAN.room && LAN.room.role === 'guest' && roomState()) openLobby();
            } else if (screen === 'lobby') {
                var r = LAN.room, s = roomState();
                if (r && r.role === 'guest' && s && s.started) { closeModal(); beginPlay(); }
                else updateLobby();
            }
        }
        refresh();
    });

    // ------------------------------------------------------------------
    // Hook into the page
    // ------------------------------------------------------------------
    function init() {
        var playh = document.getElementById('playh');
        var solo = document.getElementById('solo_btn');
        var nick = document.getElementById('nick');
        if (!playh || !solo || typeof play_btn === 'undefined' || !play_btn) return false;

        menu = el('div'); menu.id = 'lan-menu';
        soloBtn = solo.parentNode; soloBtn.style.display = 'block';
        mpBtn = btn('Multiplayer', '', function () { openHub(); });
        mpBtn.className = 'lan-btn'; mpBtn.title = 'Play with friends on your Wi-Fi';
        leaveBtn = btn('Leave', '', function () { if (LAN.mode === 'solo') LAN.leaveSolo(); else LAN.leave(); });
        leaveBtn.className = 'lan-btn sm';
        roomTxt = el('div', 'lan-roomtxt');
        menu.appendChild(soloBtn); menu.appendChild(mpBtn); menu.appendChild(roomTxt); menu.appendChild(leaveBtn);
        playh.appendChild(menu);

        solo.onclick = function (e) { if (e && e.preventDefault) e.preventDefault(); startSolo(); return false; };
        if (nick && nick.value) myName = nick.value; else if (nick) nick.value = myName;

        // The original Play button always dialled a real server. Now it means "play in the current room / world".
        var orig = play_btn.elem.onclick;
        play_btn.elem.onclick = function () {
            if (LAN.mode === 'none') { openHub(); return; }
            var s = roomState();
            if (LAN.mode !== 'solo' && s && !s.started) { openLobby(); return; }
            waiting_for_sos = false;
            forceOnce('lan', 0, null);          // makes connect() skip the (dead) public server list
            return orig.apply(this, arguments);
        };
        refresh();
        return true;
    }
    if (!init()) window.addEventListener('load', init);
})();

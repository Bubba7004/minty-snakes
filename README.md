# slither.io - LAN edition (no WebSockets)

Play with friends on the same Wi-Fi, or against bots. Nothing goes over the internet.

## Ways to play together

### A) 5-letter code (Firebase pairing)  - recommended
Everyone on the same Wi-Fi, just open `index.html` (no install, no server).
1. **Host**: Multiplayer -> *Create a room* (room type "5-letter code") -> share the code.
2. **Friends**: Multiplayer -> type the code -> *Join*. They link up automatically.
3. Host presses **Start game**. People who join later drop straight in.

Firebase is only used as a mailbox to swap connection details (plain HTTPS requests, no WebSockets).
All gameplay goes directly between the devices over your Wi-Fi. Internet is needed only for the few seconds of pairing.

**One-time setup:** in the Firebase console -> Realtime Database -> Rules, add this block *next to your existing rules*
(don't replace them) and publish:
```
"slither": {
  "rooms": { "$code": { ".read": true, ".write": true } },
  "lobby": { ".read": true, "$code": { ".write": true } }
}
```
`rooms/<code>` holds the short-lived pairing messages (it can't be listed, only opened by someone who knows the code).
`lobby` is the public **Open games** list shown in the Multiplayer menu: hosts publish a small entry (name, players, max) there
unless they untick "Show in the Open games list". Entries refresh every 20s and disappear when the host closes the game
(or are ignored after ~75s if the host crashes). The database URL is set at the top of `s/net.js` (`FB_URL`).

### B) 4-letter code with the LAN server
1. Install Node.js (v16+). In this folder run `node server.js` (or `./start.sh`, or double-click `start.bat`).
2. Open the `localhost` link it prints; friends on the Wi-Fi open the `192.168.x.x` link.
3. Multiplayer -> *Create a room* (room type "4-letter code") or *Join* with a code / from the Open rooms list.
Works fully offline.

### C) Manual pairing (no internet, no server)
Multiplayer -> *Host a room* / *Join a room* under "Manual pairing". Swap an invite code and a reply code by copy/paste.

**Play vs A.I.** is solo against bots and needs none of the above.

After you die, "Play" respawns you in the same room. "Leave room" returns to the menu.

## How it works
- `s/net.js` also contains the direct mode: WebRTC data channels, paired by the copy/paste codes (no STUN/TURN, nothing leaves your network).
- `server.js` - (optional) static files + a tiny room/relay server over plain HTTP (Server-Sent Events + POST). No WebSockets.
- `s/sim.js` - the game server, running inside the **host's** browser (one world, any number of players + bots).
- `s/net.js` - rooms, the relay transport, and a fake socket object that the original client code talks to.
- `s/ui.js` - menu, lobby and room-code UI.
- `s/game1107249518.js` - original client; only the two `new WebSocket` calls were replaced.

## Notes
- The host's browser runs the game, so the host should stay on that tab/computer; closing it closes the room.
- Use a different port with `node server.js 9000` (or `PORT=9000`).
- Direct mode needs the browser's WebRTC (any current Chrome/Edge/Firefox/Safari). Browsers sometimes hide local IPs behind `.local` names; this works on most home Wi-Fi, but if direct mode won't connect, use the LAN server (B).
- If friends can't connect: check the firewall allows the port, and that the Wi-Fi doesn't have client isolation turned on.
- Some art (backgrounds, flags) is still fetched from slither.io when you're online; the game plays fine without it.

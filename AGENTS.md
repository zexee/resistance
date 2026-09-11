# AGENTS.md

## What this is

Real-time companion/scoreboard for the physical board game The Resistance. Roles are dealt and votes are entered manually by players, but the server enforces leader rotation, proposal approval, team-only mission votes, mission results (including the mission-4 two-fail rule), and the first-to-3 winner. Single-file server, all state in memory, no database.

## Commands

- Install: `npm install`
- Run: `npm start` (port 7777, override with `PORT`)
- `npm test` runs the socket integration test (spawns its own server on a random port). `npm run test:ui` runs the Chrome/Puppeteer UI test (`CHROME_PATH` overrides the default `/usr/bin/google-chrome`). There is no lint or build tooling.

## Layout

- `server.js` - Express routes, all Socket.IO handlers, and all game state (`rooms` object). Restarting the server drops every room and game.
- `views/index.ntl` - the game client (HTML/CSS/JS), served for `/`. Communicates with the server only through Socket.IO events.
- `chat.js` - server-side per-room chat: stores the last 100 messages in `room.chat` and registers the `chat` handler. `server.js` calls `chat.Setup(socket, io, GetRoom, PlayerId)` on connect and `chat.Send(room, socket)` on join.
- `public/chat.js` / `public/chat.css` - client chat panel injected into the page; `index.ntl` loads them and calls `InitChat(socket)` after creating the socket.
- `public/3rd/` - vendored jquery/bootstrap/font-awesome/Socket.IO browser bundles. Server uses socket.io 4.x; when upgrading, copy `dist/socket.io.min.js` from the matching `socket.io-client` version into `public/3rd/`.
- `test/` - `socket.js` (game flow over real sockets) and `ui.js` (Puppeteer browser flow); both spawn their own server on a random port through `test/helper.js`.

## Non-obvious conventions

- `.ntl` is a custom template engine defined at server.js:8; it only replaces `#name#`, `#room#` and `#pid#`. A new server-rendered value needs a matching replace in the engine and in the `/` route (server.js:34), which turns cookie values into JS literals with `JsLiteral`.
- `param` (server.js:42) maps player count to a 6-element array: indices 0-4 are mission team sizes, index 5 is the spy count.
- Player identity is a persistent `pid` kept in an httpOnly cookie: the server renders it into the page as `#pid#`, the client sends it with `me`, and `/setname` stores it. It survives refreshes and name changes. `?pid=name` and `?name=Display` in the URL force an identity/display name (neither is persisted), which is how you simulate several players in one browser profile since tabs and incognito windows share cookies. The server falls back to the socket id when no pid is given. `room.order` records the order pids first joined so reconnects and restarts never move a player, `room.players` snapshots that order at start, `room.names` maps pid to the URL-encoded name, and mission votes are tracked per pid in `room.voted[round]`. Only pids in `room.players` may vote on proposals, and a game in progress rejects other pids on join (they land in Lobby). Names are clamped to `NAME_MAX` (20) chars on both `/setname` and `me`. `PlayerList` assigns a 1-based `number` per entry: frozen while a game is running (`room.winner == null`), otherwise renumbered from the live join order, and the client renders names as `N. name`.
- Names are URL-encoded with `encodeURIComponent()` on the client and decoded + HTML-escaped (`HtmlEscape`) before rendering. Payload fields `leader`, `mission_team`, `mission_teams` and `data[i].voted` are pids; `players` is `[{pid, name, online}]` and the client maps pids to names for display.
- Chat is per room (Lobby included) and open to every socket in the room. The server trims and clamps text to 200 chars, stores raw `{pid, text, time}` (never the name, since names can change), and emits the whole history over `chatlog` when a socket joins (in `JoinRoom`) plus each new message over `chat`. The client renders the sender as the roster's `N. name` looked up by `pid`, falling back to the last label it saw for that pid, escapes text on render, and caps the log at 100 messages.
- Rooms with an active game are kept for 5 hours after the last player leaves and swept every 30 minutes (server.js:332).
- The current mission is inferred server-side by `CurrentRound` (server.js:219): the first mission without a complete Pass/Fail result. `propose` sends `{team: [pids]}`, which must contain exactly `param[n][round]` distinct room players; anything else is silently dropped. Proposals carry a `round` key that the client uses for display, and `send_votes` includes `current_round`. `vote`/`clearvote` are only accepted for that same round.
- Only the current leader can `propose`. `room.leader` is an index into `room.players` (random first leader) and advances after every proposal outcome. If `room.rejected` reaches the player count, the next proposal auto-passes without a vote (`auto:1` on the archived proposal).
- `room.phase` is `proposal`, `mission`, or `ended`. `FinishProposal` (server.js:180) applies a strict yes majority: approval sets `mission` and records `room.mission_team`/`room.mission_teams`, rejection increments `room.rejected`. `FinishMission` (server.js:199) records `room.results` (mission 4 needs two fails at 7+ players), sets `room.winner` at 3 wins, and returns to `proposal` or `ended`. `propose` is dropped unless the phase is `proposal`, `yes`/`no` unless a proposal is open, and `vote`/`clearvote` unless the voter is in `room.mission_team`.
- Client button states and phase visibility are centralized in `UpdateButtons`/`UpdateVisibility` (views/index.ntl): the proposal box shows only in the proposal phase, and non-leaders get the checkbox list and Propose button hidden entirely (they only see the waiting hint). Mission cards are all visible once the game starts (titles carry the team sizes), but only team members of the current mission see Pass/Fail/Clear during the mission phase. A winner banner replaces the proposal box when `winner` is set. Before the game starts only Start is enabled (needs 5-10 players).
- Commit messages in this repo start with `* ` (e.g. `* page change`).

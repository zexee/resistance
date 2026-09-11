# AGENTS.md

## What this is

Real-time companion/scoreboard for the physical board game The Resistance. Roles are dealt and votes are entered manually by players, but the server enforces leader rotation, proposal approval, team-only mission votes, mission results (including the mission-4 two-fail rule), and the first-to-3 winner. Single-file server, all state in memory, no database.

## Commands

- Install: `npm install`
- Run: `npm start` (port 7777, override with `PORT`)
- `npm test` runs the socket integration test (spawns its own server on a random port). `npm run test:ui` runs the Chrome/Puppeteer UI test (`CHROME_PATH` overrides the default `/usr/bin/google-chrome`). There is no lint or build tooling.

## Layout

- `server.js` - Express routes, all Socket.IO handlers, and all game state (`rooms` object). Restarting the server drops every room and game.
- `views/index.ntl` - the entire client (HTML/CSS/JS), served for `/`. Communicates with the server only through Socket.IO events.
- `public/3rd/` - vendored jquery/bootstrap/font-awesome/Socket.IO browser bundles. Server uses socket.io 4.x; when upgrading, copy `dist/socket.io.min.js` from the matching `socket.io-client` version into `public/3rd/`.
- `test/` - `socket.js` (game flow over real sockets) and `ui.js` (Puppeteer browser flow); both spawn their own server on a random port through `test/helper.js`.

## Non-obvious conventions

- `.ntl` is a custom template engine defined at server.js:8; it only replaces `#name#` and `#room#`. A new server-rendered value needs a matching replace in the engine and in the `/` route (server.js:33), which turns cookie values into JS literals with `JsLiteral`.
- `param` (server.js:52) maps player count to a 6-element array: indices 0-4 are mission team sizes, index 5 is the spy count.
- Player identity is the socket id (per connection); the display name comes from the `name` cookie and is re-sent with `me` on every connect, so a refresh rejoins with the same name and room. A refreshed leader cannot propose (their socket id is not in the start snapshot) and mission votes are tracked per socket.
- Names are URL-encoded with `encodeURIComponent()` on the client before sending and decoded + HTML-escaped (`HtmlEscape`/`DisplayName`) before rendering. `data[i].voted` carries the names that already voted for the current mission.
- Rooms with an active game are kept for 5 hours after the last player leaves and swept every 30 minutes (server.js:290).
- The current mission is inferred server-side by `CurrentRound` (server.js:178): the first mission without a complete Pass/Fail result. `propose` sends `{team: [escaped names]}`, which must contain exactly `param[n][round]` distinct room members; anything else is silently dropped. Proposals carry a `round` key that the client uses for display, and `send_votes` includes `current_round`. `vote`/`clearvote` are only accepted for that same round.
- Only the current leader can `propose`. `room.players` is the join-order snapshot taken at start, `room.leader` is an index into it (random first leader), and it advances after every proposal outcome. If `room.rejected` reaches the player count, the next proposal auto-passes without a vote (`auto:1` on the archived proposal).
- `room.phase` is `proposal`, `mission`, or `ended`. `FinishProposal` (server.js:139) applies a strict yes majority: approval sets `mission` and records `room.mission_team`/`room.mission_teams`, rejection increments `room.rejected`. `FinishMission` (server.js:158) records `room.results` (mission 4 needs two fails at 7+ players), sets `room.winner` at 3 wins, and returns to `proposal` or `ended`. `propose` is dropped unless the phase is `proposal`, `yes`/`no` unless a proposal is open, and `vote`/`clearvote` unless the voter is in `room.mission_team`.
- Client button states and phase visibility are centralized in `UpdateButtons`/`UpdateVisibility` (views/index.ntl): the proposal box shows only in the proposal phase, and non-leaders get the checkbox list and Propose button hidden entirely (they only see the waiting hint). Mission cards are all visible once the game starts (titles carry the team sizes), but only team members of the current mission see Pass/Fail/Clear during the mission phase. A winner banner replaces the proposal box when `winner` is set. Before the game starts only Start is enabled (needs 5-10 players).
- Commit messages in this repo start with `* ` (e.g. `* page change`).

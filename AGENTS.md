# AGENTS.md

## What this is

Real-time companion/scoreboard for the physical board game The Resistance. It does not enforce game rules: roles are dealt and votes/proposals are manually entered by players, and mission success is computed in the browser for display only. Single-file server, all state in memory, no database.

## Commands

- Install: `npm install`
- Run: `npm start` (port 7777 hardcoded at server.js:334, no env override)
- No test, lint, or build tooling exists; `npm test` is a stub that exits 1. Verify changes by running the server and exercising it in a browser at http://localhost:7777. Gameplay needs 5-10 concurrent sockets, so use multiple browser windows/incognito sessions.

## Layout

- `server.js` - Express routes, all Socket.IO handlers, and all game state (`rooms` object). Restarting the server drops every room and game.
- `views/index.ntl` - the entire client (HTML/CSS/JS), served for `/`. Communicates with the server only through Socket.IO events.
- `public/3rd/` - vendored jquery/bootstrap/font-awesome/Socket.IO browser bundles. Server uses socket.io 4.x; when upgrading, copy `dist/socket.io.min.js` from the matching `socket.io-client` version into `public/3rd/`.

## Non-obvious conventions

- `.ntl` is a custom template engine defined at server.js:8; it only replaces `#name#` and `#room#`. A new server-rendered value needs a matching replace in the engine and in the `/` route (server.js:27), which pre-quotes values as JS string literals.
- `param` (server.js:42) maps player count to a 6-element array: indices 0-4 are mission team sizes, index 5 is the spy count.
- Player names are URL-escaped with `escape()` on the client before sending and `unescape()`d for display. Keep this convention when touching name handling.
- Rooms with an active game are kept for 5 hours after the last player leaves and swept every 30 minutes (server.js:191).
- The current mission is inferred server-side by `CurrentRound` (server.js:103): the first mission without a complete Pass/Fail result. `propose` sends `{team: [escaped names]}`, which must contain exactly `param[n][round]` distinct room members; anything else is silently dropped. Proposals carry a `round` key that the client uses for display, and `send_votes` includes `current_round`. `vote`/`clearvote` are only accepted for that same round; the client disables the other missions' buttons and marks the current one with a `Next` badge.
- `room.phase` is `proposal` or `mission`; `FinishProposal` (server.js:89) sets `mission` on a strict yes majority, and a completed mission vote sets it back to `proposal`. The server drops `propose` unless the phase is `proposal` and drops `yes`/`no` unless a proposal is open.
- Client button states and phase visibility are centralized in `UpdateButtons`/`UpdateVisibility` (views/index.ntl): the proposal box shows only in the proposal phase, mission panels are revealed as their proposals are approved (completed ones stay visible without buttons), and before the game starts only Start is enabled (needs 5-10 players). Yes/No need an open proposal, Pass/Fail need the current mission and are disabled after this client's own vote, Clear needs at least one vote.
- Commit messages in this repo start with `* ` (e.g. `* page change`).

const { io } = require('socket.io-client');
const { startServer, stopServer } = require('./helper');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS', msg);
  else { failures++; console.log('FAIL', msg); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const N5 = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
const N7 = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
const pidsOf = names => names.map(n => 'pid-' + n);

function connect(port, name, pid) {
  return new Promise((resolve, reject) => {
    const s = io('http://localhost:' + port, { forceNew: true });
    const state = { s, name, pid, room: null, lastVotes: null, roles: null };
    s.on('connect', () => resolve(state));
    s.on('connect_error', reject);
    s.on('join', d => { if (d.room !== 'Lobby') state.room = d.room; state.lastPlayers = d.players; });
    s.on('votes', d => { state.lastVotes = d; state.lastPlayers = d.players; });
    s.on('role', d => { state.roles = d; });
  });
}

async function join(port, room, name, pid) {
  const c = await connect(port, name, pid);
  c.s.emit('me', { name: encodeURIComponent(name), room, pid });
  await wait(150);
  return c;
}

async function makeGame(port, names, autoStart) {
  const clients = [];
  const a = await join(port, undefined, names[0], 'pid-' + names[0]);
  clients.push(a);
  await wait(150);
  a.s.emit('create');
  await wait(250);
  const room = a.room;
  for (let i = 1; i < names.length; i++) {
    clients.push(await join(port, room, names[i], 'pid-' + names[i]));
  }
  // Wait until the server has registered every pid before starting.
  for (let i = 0; i < 50; i++) {
    if (a.lastPlayers && a.lastPlayers.length === names.length && a.lastPlayers.every(p => p.pid)) break;
    await wait(100);
  }
  if (autoStart !== false) {
    a.s.emit('start');
    for (let i = 0; i < 50; i++) {
      if (a.lastVotes) break;
      await wait(100);
    }
  }
  return clients;
}

const v = clients => clients[0].lastVotes;
const leaderClient = clients => clients.find(c => c.pid === v(clients).leader);
const nextPid = (names, current) => {
  const pids = pidsOf(names);
  return pids[(pids.indexOf(current) + 1) % pids.length];
};

async function propose(clients, teamPids) {
  leaderClient(clients).s.emit('propose', { team: teamPids });
  await wait(200);
}

async function voteProposal(clients, approve) {
  for (const c of clients) c.s.emit(approve ? 'yes' : 'no');
  await wait(350);
}

async function castMission(clients, failPids) {
  const round = v(clients).current_round;
  const team = v(clients).mission_team;
  for (const pid of team) {
    const c = clients.find(x => x.pid === pid);
    c.s.emit('vote', { round, vote: failPids.indexOf(pid) >= 0 ? 0 : 1 });
  }
  await wait(350);
}

(async () => {
  const server = await startServer();
  const port = server.port;

  // ---- game 1: 5 players, identity, auto-pass and resistance win ----
  const P5 = pidsOf(N5);
  let c = await makeGame(port, N5, false);
  const orderBeforeStart = c[0].lastPlayers.map(p => p.pid);
  const preRejoin = c[2];
  preRejoin.s.close();
  await wait(300);
  preRejoin.s = (await join(port, preRejoin.room, preRejoin.name, preRejoin.pid)).s;
  await wait(300);
  check(JSON.stringify(c[0].lastPlayers.map(p => p.pid)) === JSON.stringify(orderBeforeStart), 'player order preserved across a pre-start reconnect');
  c[0].s.emit('start');
  for (let i = 0; i < 50; i++) {
    if (c[0].lastVotes) break;
    await wait(100);
  }
  check(v(c).phase === 'proposal', 'game starts in proposal phase');
  check(c[0].lastPlayers.length === 5, 'players payload has 5 entries');
  check(c[0].lastPlayers.every(p => p.pid && p.name && p.online), 'players carry pid, name and online');
  check(N5.some(n => 'pid-' + n === v(c).leader), 'leader is a persistent pid');
  check(v(c).rejected === 0, 'no rejections at start');

  const observer = c[0];
  const nonLeader = c.find(x => x !== observer && x.pid !== v(c).leader);
  nonLeader.s.emit('propose', { team: [P5[0], P5[1]] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'non-leader propose ignored');

  // disconnect and reconnect with the same persistent id
  const orderAtStart = c[0].lastPlayers.map(p => p.pid);
  nonLeader.s.close();
  await wait(300);
  check(c[0].lastPlayers.find(p => p.pid === nonLeader.pid).online === false, 'disconnected player marked offline');
  nonLeader.s = (await join(port, nonLeader.room, nonLeader.name, nonLeader.pid)).s;
  await wait(300);
  check(c[0].lastPlayers.find(p => p.pid === nonLeader.pid).online === true, 'reconnected player marked online');
  check(c[0].lastPlayers.length === 5, 'roster unchanged after reconnect');
  check(JSON.stringify(c[0].lastPlayers.map(p => p.pid)) === JSON.stringify(orderAtStart), 'player order preserved across a mid-game reconnect');

  // name change keeps identity
  const renamed = c.find(x => x !== observer && x.pid !== v(c).leader && x.pid !== nonLeader.pid);
  renamed.s.emit('me', { name: encodeURIComponent('Renamed'), room: renamed.room, pid: renamed.pid });
  await wait(300);
  check(c[0].lastPlayers.find(p => p.pid === renamed.pid).name === 'Renamed', 'name change updates the roster');
  renamed.s.emit('me', { name: encodeURIComponent(renamed.name), room: renamed.room, pid: renamed.pid });
  await wait(300);
  check(c[0].lastPlayers.find(p => p.pid === renamed.pid).name === renamed.name, 'name change back works');

  const firstLeader = v(c).leader;
  const l1 = leaderClient(c);
  l1.s.emit('propose', { team: [P5[0]] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'leader wrong team size rejected');
  l1.s.emit('propose', { team: [P5[0], 'pid-Mallory'] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'unknown player rejected');
  l1.s.emit('propose', { team: [P5[0], P5[0]] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'duplicate player rejected');

  l1.s.emit('propose', { team: [P5[0], P5[1]] });
  await wait(200);
  check(v(c).proposal.text === 'Alice, Bob', 'leader proposal accepted');
  check(v(c).proposal.team.length === 2, 'proposal carries pid team');
  check(v(c).phase === 'proposal', 'phase proposal while voting');

  await voteProposal(c, true);
  check(v(c).phase === 'mission', 'approved proposal enters mission');
  check(v(c).mission_team.length === 2, 'mission team set on approval');
  check(v(c).leader === nextPid(N5, firstLeader), 'leader rotated after approval');
  check(v(c).rejected === 0, 'rejection count reset on approval');

  const outsider = c.find(x => v(c).mission_team.indexOf(x.pid) < 0);
  outsider.s.emit('vote', { round: 0, vote: 0 });
  c[0].s.emit('vote', { round: 5, vote: 1 });
  await wait(200);
  check(v(c)[0].voten === 0, 'non-team and invalid round votes ignored');

  const teamClient0 = c.find(x => x.pid === v(c).mission_team[0]);
  teamClient0.s.emit('vote', { round: 0, vote: 1 });
  await wait(200);
  check(v(c)[0].voten === 1, 'team vote counted');
  check(v(c)[0].voted.indexOf(teamClient0.pid) >= 0, 'mission waiting list tracks the voter');
  const double = await join(port, teamClient0.room, teamClient0.name, teamClient0.pid);
  double.s.emit('vote', { round: 0, vote: 0 });
  await wait(200);
  check(v(c)[0].voten === 1, 'same pid cannot vote twice');
  double.s.close();
  await wait(200);

  teamClient0.s.emit('clearvote', { round: 0 });
  await wait(200);
  check(v(c)[0].voten === 0, 'team clearvote resets votes');

  await castMission(c, []);
  check(v(c).results[0] === 1, 'mission 1 success');
  check(v(c).phase === 'proposal', 'back to proposal after mission');
  check(v(c).current_round === 1, 'advanced to mission 2');
  check(v(c).mission_team.length === 0, 'mission team cleared');

  // mission 2: every player proposes once and is rejected -> auto-pass
  for (let i = 0; i < 5; i++) {
    const before = v(c).leader;
    await propose(c, [P5[0], P5[1], P5[2]]);
    await voteProposal(c, false);
    check(v(c).rejected === i + 1, 'rejection count ' + (i + 1));
    check(v(c).leader === nextPid(N5, before), 'leader rotated after rejection ' + (i + 1));
  }
  await propose(c, [P5[0], P5[1], P5[2]]);
  await wait(200);
  check(v(c).phase === 'mission', 'proposal auto-passed after everyone rejected');
  check(v(c).proposals[v(c).proposals.length - 1].auto === 1, 'auto-pass flag archived');
  await castMission(c, []);
  check(v(c).results[1] === 1, 'mission 2 success');

  await propose(c, [P5[0], P5[1]]);
  await voteProposal(c, true);
  await castMission(c, [P5[1]]);
  check(v(c).results[2] === 0, 'mission 3 failed');

  await propose(c, [P5[0], P5[1], P5[2]]);
  await voteProposal(c, true);
  await castMission(c, [P5[0]]);
  check(v(c).results[3] === 0, 'mission 4 failed');

  await propose(c, [P5[0], P5[1], P5[2]]);
  await voteProposal(c, true);
  await castMission(c, []);
  check(v(c).results[4] === 1, 'mission 5 success');
  check(v(c).winner === 'resistance', 'resistance wins with 3 successes');
  check(v(c).phase === 'ended', 'phase ended after win');

  const proposalsBefore = v(c).proposals.length;
  leaderClient(c).s.emit('propose', { team: [P5[0], P5[1]] });
  c[0].s.emit('vote', { round: 0, vote: 0 });
  c[0].s.emit('yes');
  await wait(300);
  check(v(c).proposals.length === proposalsBefore, 'propose ignored after game over');
  check(v(c).winner === 'resistance' && v(c).phase === 'ended', 'state unchanged after game over');
  c.forEach(x => x.s.close());
  await wait(200);

  // ---- game 2: 7 players, mission 4 survives a single fail ----
  const P7 = pidsOf(N7);
  c = await makeGame(port, N7);
  await propose(c, [P7[0], P7[1]]);
  await voteProposal(c, true);
  await castMission(c, [P7[0]]);
  check(v(c).results[0] === 0, '7p mission 1 failed');

  await propose(c, [P7[0], P7[1], P7[2]]);
  await voteProposal(c, true);
  await castMission(c, [P7[0]]);
  check(v(c).results[1] === 0, '7p mission 2 failed');

  await propose(c, [P7[0], P7[1], P7[2]]);
  await voteProposal(c, true);
  await castMission(c, []);
  check(v(c).results[2] === 1, '7p mission 3 passed');

  await propose(c, [P7[0], P7[1], P7[2], P7[3]]);
  await voteProposal(c, true);
  await castMission(c, [P7[0]]);
  check(v(c).results[3] === 1, '7p mission 4 survives one fail');

  await propose(c, [P7[0], P7[1], P7[2], P7[3]]);
  await voteProposal(c, true);
  await castMission(c, [P7[0]]);
  check(v(c).results[4] === 0, '7p mission 5 failed');
  check(v(c).winner === 'spies', 'spies win with 3 failed missions');
  c.forEach(x => x.s.close());
  await wait(200);

  // ---- game 3: 7 players, mission 4 fails with two fails ----
  c = await makeGame(port, N7);
  await propose(c, [P7[0], P7[1]]);
  await voteProposal(c, true);
  await castMission(c, []);
  check(v(c).results[0] === 1, '7p game3 mission 1 passed');

  await propose(c, [P7[0], P7[1], P7[2]]);
  await voteProposal(c, true);
  await castMission(c, [P7[0]]);
  check(v(c).results[1] === 0, '7p game3 mission 2 failed');

  await propose(c, [P7[0], P7[1], P7[2]]);
  await voteProposal(c, true);
  await castMission(c, [P7[1]]);
  check(v(c).results[2] === 0, '7p game3 mission 3 failed');

  await propose(c, [P7[0], P7[1], P7[2], P7[3]]);
  await voteProposal(c, true);
  await castMission(c, [P7[0], P7[1]]);
  check(v(c).results[3] === 0, '7p mission 4 fails with two fails');
  check(v(c).winner === 'spies', '7p spies win after mission 4');
  c.forEach(x => x.s.close());
  await wait(200);

  await stopServer(server);
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });

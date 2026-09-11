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

function connect(port, name) {
  return new Promise((resolve, reject) => {
    const s = io('http://localhost:' + port, { forceNew: true });
    const state = { s, name, room: null, lastVotes: null, lastNames: null, roles: null };
    s.on('connect', () => resolve(state));
    s.on('connect_error', reject);
    s.on('join', d => {
      if (d.room !== 'Lobby') state.room = d.room;
      state.lastNames = d.names;
    });
    s.on('votes', d => { state.lastVotes = d; });
    s.on('role', d => { state.roles = d; });
  });
}

async function makeGame(port, names) {
  const clients = [];
  const a = await connect(port, names[0]);
  clients.push(a);
  a.s.emit('me', { name: encodeURIComponent(names[0]), room: undefined });
  await wait(150);
  a.s.emit('create');
  await wait(250);
  const room = a.room;
  for (let i = 1; i < names.length; i++) {
    const c = await connect(port, names[i]);
    clients.push(c);
    c.s.emit('me', { name: encodeURIComponent(names[i]), room });
    await wait(150);
  }
  for (let i = 0; i < 50; i++) {
    if (a.lastNames && a.lastNames.length === names.length) break;
    await wait(100);
  }
  a.s.emit('start');
  for (let i = 0; i < 50; i++) {
    if (a.lastVotes) break;
    await wait(100);
  }
  return clients;
}

const v = clients => clients[0].lastVotes;
const leaderClient = clients => clients.find(c => c.name === v(clients).leader);
const nextInOrder = (names, current) => names[(names.indexOf(current) + 1) % names.length];

async function propose(clients, team) {
  leaderClient(clients).s.emit('propose', { team });
  await wait(200);
}

async function voteProposal(clients, approve) {
  for (const c of clients) c.s.emit(approve ? 'yes' : 'no');
  await wait(350);
}

async function castMission(clients, failNames) {
  const round = v(clients).current_round;
  const team = v(clients).mission_team;
  for (const name of team) {
    const c = clients.find(x => x.name === name);
    c.s.emit('vote', { round, vote: failNames.indexOf(name) >= 0 ? 0 : 1 });
  }
  await wait(350);
}

(async () => {
  const server = await startServer();
  const port = server.port;

  // ---- game 1: 5 players, auto-pass and resistance win ----
  const N = N5;
  let c = await makeGame(port, N);
  check(v(c).phase === 'proposal', 'game starts in proposal phase');
  check(N.indexOf(v(c).leader) >= 0, 'leader is one of the players');
  check(v(c).rejected === 0, 'no rejections at start');

  const nonLeader = c.find(x => x.name !== v(c).leader);
  nonLeader.s.emit('propose', { team: [N[0], N[1]] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'non-leader propose ignored');

  const firstLeader = v(c).leader;
  const l1 = leaderClient(c);
  l1.s.emit('propose', { team: [N[0]] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'leader wrong team size rejected');
  l1.s.emit('propose', { team: [N[0], 'Mallory'] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'unknown player rejected');
  l1.s.emit('propose', { team: [N[0], N[0]] });
  await wait(200);
  check(v(c).proposal.text === undefined, 'duplicate player rejected');

  l1.s.emit('propose', { team: [N[0], N[1]] });
  await wait(200);
  check(v(c).proposal.text === 'Alice, Bob', 'leader proposal accepted');
  check(v(c).phase === 'proposal', 'phase proposal while voting');

  await voteProposal(c, true);
  check(v(c).phase === 'mission', 'approved proposal enters mission');
  check(v(c).mission_team.length === 2, 'mission team set on approval');
  check(v(c).leader === nextInOrder(N, firstLeader), 'leader rotated after approval');
  check(v(c).rejected === 0, 'rejection count reset on approval');

  const outsider = c.find(x => v(c).mission_team.indexOf(x.name) < 0);
  outsider.s.emit('vote', { round: 0, vote: 0 });
  c[0].s.emit('vote', { round: 5, vote: 1 });
  await wait(200);
  check(v(c)[0].voten === 0, 'non-team and invalid round votes ignored');

  const teamClient0 = c.find(x => x.name === v(c).mission_team[0]);
  teamClient0.s.emit('vote', { round: 0, vote: 1 });
  await wait(200);
  check(v(c)[0].voten === 1, 'team vote counted');
  check(v(c)[0].voted.indexOf(teamClient0.name) >= 0, 'mission waiting list tracks the voter');
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
    await propose(c, [N[0], N[1], N[2]]);
    await voteProposal(c, false);
    check(v(c).rejected === i + 1, 'rejection count ' + (i + 1));
    check(v(c).leader === nextInOrder(N, before), 'leader rotated after rejection ' + (i + 1));
  }
  await propose(c, [N[0], N[1], N[2]]);
  await wait(200);
  check(v(c).phase === 'mission', 'proposal auto-passed after everyone rejected');
  check(v(c).proposals[v(c).proposals.length - 1].auto === 1, 'auto-pass flag archived');
  await castMission(c, []);
  check(v(c).results[1] === 1, 'mission 2 success');

  await propose(c, [N[0], N[1]]);
  await voteProposal(c, true);
  await castMission(c, [N[1]]);
  check(v(c).results[2] === 0, 'mission 3 failed');

  await propose(c, [N[0], N[1], N[2]]);
  await voteProposal(c, true);
  await castMission(c, [N[0]]);
  check(v(c).results[3] === 0, 'mission 4 failed');

  await propose(c, [N[0], N[1], N[2]]);
  await voteProposal(c, true);
  await castMission(c, []);
  check(v(c).results[4] === 1, 'mission 5 success');
  check(v(c).winner === 'resistance', 'resistance wins with 3 successes');
  check(v(c).phase === 'ended', 'phase ended after win');

  const proposalsBefore = v(c).proposals.length;
  leaderClient(c).s.emit('propose', { team: [N[0], N[1]] });
  c[0].s.emit('vote', { round: 0, vote: 0 });
  c[0].s.emit('yes');
  await wait(300);
  check(v(c).proposals.length === proposalsBefore, 'propose ignored after game over');
  check(v(c).winner === 'resistance' && v(c).phase === 'ended', 'state unchanged after game over');
  c.forEach(x => x.s.close());
  await wait(200);

  // ---- game 2: 7 players, mission 4 survives a single fail ----
  const P7 = N7;
  c = await makeGame(port, P7);
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
  c = await makeGame(port, P7);
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

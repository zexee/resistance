const { io } = require('socket.io-client');
const { startServer, stopServer } = require('./helper');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS', msg);
  else { failures++; console.log('FAIL', msg); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// Minimal OpenAI-compatible endpoint. In auto mode it answers every AI action
// with a legal move derived from the last instruction, so the game can be
// played without a real model.
function startFakeLlm() {
  const state = { mode: 'auto', requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      state.requests.push(body);
      if (state.mode === 'timeout') return; // leave the request hanging
      if (state.mode === 'garbage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'not json at all' } }] }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) {}
      const messages = parsed.messages || [];
      const last = messages.length ? String(messages[messages.length - 1].content) : '';
      let content = '{"action":"silent"}';
      if (last.indexOf('作为领袖提议') >= 0) {
        const m = last.match(/需要恰好 (\d+)/);
        const size = m ? Number(m[1]) : 2;
        const team = [];
        for (let i = 1; i <= size; i++) team.push(i);
        content = JSON.stringify({ action: 'propose', team: team });
      } else if (last.indexOf('提案投票') >= 0) {
        content = JSON.stringify({ action: 'vote_proposal', vote: 'yes' });
      } else if (last.indexOf('个任务的队员') >= 0) {
        content = JSON.stringify({ action: 'vote_mission', vote: 'pass' });
      } else if (last.indexOf('聊天记录已更新') >= 0) {
        content = JSON.stringify({ action: 'chat', text: 'AI在这里' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: content } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, () => resolve({ server, state, port: server.address().port })));
}

function connect(port, name, pid) {
  return new Promise((resolve, reject) => {
    const s = io('http://localhost:' + port, { forceNew: true });
    const state = {
      s, name, pid, room: null, lastVotes: null, lastPlayers: null,
      chats: [], aiErrors: [], aiThinking: [], aiModels: null
    };
    s.on('connect', () => resolve(state));
    s.on('connect_error', reject);
    s.on('join', d => {
      if (d.room !== 'Lobby') state.room = d.room;
      state.lastPlayers = d.players;
    });
    s.on('votes', d => { state.lastVotes = d; state.lastPlayers = d.players; });
    s.on('chat', d => state.chats.push(d.message));
    s.on('ai_models', d => { state.aiModels = d; });
    s.on('ai_error', d => state.aiErrors.push(d));
    s.on('ai_thinking', d => state.aiThinking.push(d));
  });
}

async function join(port, room, name, pid) {
  const c = await connect(port, name, pid);
  c.s.emit('me', { name: encodeURIComponent(name), room, pid });
  await wait(150);
  return c;
}

// Plays the human part until the game ends: vote yes, pass missions and
// propose the first legal team whenever the human is the leader.
async function drive(human, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const v = human.lastVotes;
    if (v && v.winner != null) return v;
    if (v) {
      if (v.phase === 'proposal') {
        if (v.proposal && v.proposal.text != undefined) {
          if (v.proposal[human.pid] == undefined) human.s.emit('yes');
        } else if (v.leader === human.pid) {
          const size = v.param[v.current_round];
          human.s.emit('propose', { team: v.players.slice(0, size).map(p => p.pid) });
        }
      } else if (v.phase === 'mission') {
        const r = v.current_round;
        if (v.mission_team.indexOf(human.pid) >= 0 && v[r] && v[r].voted.indexOf(human.pid) < 0) {
          human.s.emit('vote', { round: r, vote: 1 });
        }
      }
    }
    await wait(120);
  }
  return null;
}

(async () => {
  const fake = await startFakeLlm();
  const cfgPath = path.join(os.tmpdir(), 'resistance-ai-test-' + process.pid + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    timeout_ms: 1000,
    models: [{
      id: 'fake',
      label: 'Fake',
      base_url: 'http://localhost:' + fake.port + '/v1',
      api_key: 'test-key',
      model: 'fake-model'
    }]
  }));
  const server = await startServer({ AI_CONFIG: cfgPath });
  const port = server.port;

  const human = await join(port, undefined, 'Human', 'pid-human');
  await wait(150);
  human.s.emit('create');
  await wait(250);
  check(human.aiModels != null && human.aiModels.enabled === true, 'ai_models enabled when config exists');
  check(human.aiModels.models.length === 1 && human.aiModels.models[0].label === 'Fake', 'ai_models lists configured models');

  for (let i = 0; i < 4; i++) {
    human.s.emit('ai_add', { model: 'fake' });
    await wait(120);
  }
  await wait(200);
  check(human.lastPlayers.length === 5, 'four AI players added to the room');
  const aiNames = human.lastPlayers.filter(p => p.ai).map(p => decodeURIComponent(p.name));
  check(JSON.stringify(aiNames) === JSON.stringify(['Fake', 'Fake-A', 'Fake-B', 'Fake-C']), 'AI names follow the model name with suffixes');
  check(human.lastPlayers.filter(p => p.ai).every(p => p.online === true), 'AI players are always online');

  human.s.emit('ai_add', { model: 'fake' });
  await wait(200);
  check(human.lastPlayers.length === 6, 'fifth AI added');
  const extra = human.lastPlayers.filter(p => p.ai && decodeURIComponent(p.name) === 'Fake-D')[0];
  check(extra != null, 'fifth AI named Fake-D');
  human.s.emit('ai_remove', { pid: extra.pid });
  await wait(200);
  check(human.lastPlayers.length === 5 && !human.lastPlayers.some(p => p.pid === extra.pid), 'AI removed before the game');

  // pre-game chat must not call the AI at all
  fake.state.mode = 'garbage';
  human.s.emit('chat', { text: '大家好啊' });
  await wait(3000);
  check(human.aiErrors.length === 0, 'pre-game chat does not call the AI');
  check(!human.chats.some(m => m.pid.indexOf('ai-') === 0), 'pre-game chat gets no AI reply');
  fake.state.mode = 'auto';

  // the game runs with AI players
  human.s.emit('start');
  for (let i = 0; i < 50; i++) {
    if (human.lastVotes) break;
    await wait(100);
  }
  check(human.lastVotes != null && human.lastVotes.phase === 'proposal', 'game starts with AI players');
  check(human.lastVotes.players.length === 5, 'roster keeps four AI players at start');

  const aiPid = human.lastVotes.players.filter(p => p.ai)[0].pid;
  human.s.emit('ai_remove', { pid: aiPid });
  await wait(300);
  check(human.lastVotes.players.some(p => p.pid === aiPid), 'AI cannot be removed mid-game');

  // A failed game action waits for a human retry instead of looping.
  const errorsBefore = human.aiErrors.length;
  fake.state.mode = 'garbage';
  for (let i = 0; i < 100 && !human.aiErrors.slice(errorsBefore).some(e => e.error); i++) {
    const v = human.lastVotes;
    if (v && v.phase === 'proposal' && v.proposal.text == undefined && v.leader === human.pid) {
      human.s.emit('propose', { team: v.players.slice(0, v.param[v.current_round]).map(p => p.pid) });
    }
    await wait(100);
  }
  check(human.aiErrors.slice(errorsBefore).some(e => e.error), 'a failed game action surfaces as ai_error');
  await wait(3000);  // let the first round of AI actions finish failing
  const errorCount = human.aiErrors.length;
  await wait(2500);
  check(human.aiErrors.length === errorCount, 'a failed AI action is not retried automatically');
  fake.state.mode = 'auto';
  for (const e of human.aiErrors.slice(errorsBefore).filter(x => x.error)) human.s.emit('ai_retry', { pid: e.pid });

  const final = await drive(human, 30000);
  check(final != null && final.winner === 'resistance', 'AI players play the game to a resistance win');
  check(human.aiThinking.some(t => t.on === true), 'ai_thinking events emitted');

  // timeout surfaces and a human retry works after the game too
  fake.state.mode = 'timeout';
  human.s.emit('chat', { text: '还在吗' });
  for (let i = 0; i < 80 && !human.aiErrors.some(e => e.kind === 'timeout'); i++) await wait(100);
  check(human.aiErrors.some(e => e.kind === 'timeout'), 'LLM timeout surfaces as ai_error');
  fake.state.mode = 'auto';
  const timeoutErr = human.aiErrors.filter(e => e.kind === 'timeout')[0];
  const before = human.chats.filter(m => m.pid === timeoutErr.pid).length;
  human.s.emit('ai_retry', { pid: timeoutErr.pid });
  replied = false;
  for (let i = 0; i < 80; i++) {
    if (human.chats.filter(m => m.pid === timeoutErr.pid).length > before) { replied = true; break; }
    await wait(100);
  }
  check(replied, 'retry after a timeout works');

  human.s.close();
  await wait(200);
  await stopServer(server);
  fake.server.close();
  try { fs.unlinkSync(cfgPath); } catch (e) {}
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });

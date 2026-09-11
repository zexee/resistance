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
const ZODIAC = ['子鼠', '丑牛', '寅虎', '卯兔', '辰龙', '巳蛇', '午马', '未羊', '申猴', '酉鸡', '戌狗', '亥猪'];

// Minimal OpenAI-compatible endpoint. In auto mode it answers every AI action
// with a legal move derived from the last instruction, so the game can be
// played without a real model.
function startFakeLlm() {
  const state = { mode: 'auto', requests: [], flipVotes: false, reproposeTeam: null, reconsiderCalls: 0, leaderSays: false, replyText: null };
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
      if (last.indexOf('修改当前提案') >= 0) {
        content = state.reproposeTeam
          ? JSON.stringify({ action: 'repropose', team: state.reproposeTeam })
          : JSON.stringify({ action: 'keep' });
      } else if (last.indexOf('维持或改变你对当前提案的投票') >= 0) {
        state.reconsiderCalls++;
        content = JSON.stringify({ action: 'reconsider', vote: state.flipVotes ? 'no' : 'keep' });
      } else if (last.indexOf('刚刚提名了') >= 0) {
        content = state.replyText
          ? JSON.stringify({ action: 'chat', text: state.replyText })
          : JSON.stringify({ action: 'silent' });
      } else if (last.indexOf('作为领袖提议') >= 0) {
        const m = last.match(/需要恰好 (\d+)/);
        const size = m ? Number(m[1]) : 2;
        const team = [];
        for (let i = 1; i <= size; i++) team.push(i);
        const proposal = { action: 'propose', team: team };
        if (state.leaderSays) proposal.say = '我提名这个队伍';
        content = JSON.stringify(proposal);
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
      chats: [], aiErrors: [], aiThinking: [], aiModels: null, reconsiderEvents: []
    };
    s.on('connect', () => resolve(state));
    s.on('connect_error', reject);
    s.on('join', d => {
      if (d.room !== 'Lobby') state.room = d.room;
      state.lastPlayers = d.players;
    });
    s.on('votes', d => { state.lastVotes = d; state.lastPlayers = d.players; state.votesCount = (state.votesCount || 0) + 1; });
    s.on('chat', d => state.chats.push(d.message));
    s.on('ai_models', d => { state.aiModels = d; });
    s.on('ai_error', d => state.aiErrors.push(d));
    s.on('ai_thinking', d => state.aiThinking.push(d));
    s.on('proposal_reconsider', d => state.reconsiderEvents.push(d));
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
  check(aiNames.length === 4 && new Set(aiNames).size === 4, 'AI names are distinct');
  check(aiNames.every(n => ZODIAC.indexOf(n) >= 0), 'AI names come from the zodiac');
  check(human.lastPlayers.filter(p => p.ai).every(p => p.model === 'Fake'), 'AI players expose their model for hover');
  check(human.lastPlayers.filter(p => p.ai).every(p => p.online === true), 'AI players are always online');

  const aiPidsBefore = human.lastPlayers.filter(p => p.ai).map(p => p.pid);
  human.s.emit('ai_add', { model: 'fake' });
  await wait(200);
  check(human.lastPlayers.length === 6, 'fifth AI added');
  const extra = human.lastPlayers.filter(p => p.ai && aiPidsBefore.indexOf(p.pid) < 0)[0];
  check(extra != null && ZODIAC.indexOf(decodeURIComponent(extra.name)) >= 0, 'fifth AI gets a free zodiac name');
  check(aiNames.indexOf(decodeURIComponent(extra.name)) < 0, 'fifth AI does not reuse a name');
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

  // chat during proposal voting: leader may revise, then AI voters reconsider
  async function restartUntilLeader(wantHuman, tries) {
    for (let t = 0; t < tries; t++) {
      const before = human.votesCount || 0;
      human.s.emit('start');
      for (let i = 0; i < 60; i++) {
        const v = human.lastVotes;
        if ((human.votesCount || 0) > before && v.winner == null && v.players.length === 5) {
          if ((v.leader === human.pid) === wantHuman) return v;
          break;
        }
        await wait(100);
      }
      await wait(200);
    }
    return null;
  }

  function ProposalVoters(v) {
    const meta = { text: 1, who: 1, by: 1, round: 1, team: 1, auto: 1 };
    return Object.keys(v.proposal || {}).filter(k => !meta[k]);
  }

  async function waitAllAiVotes() {
    for (let i = 0; i < 300; i++) {
      const v = human.lastVotes;
      if (v && v.phase === 'proposal' && v.proposal.text != undefined) {
        const voters = ProposalVoters(v);
        if (voters.length >= 4 && voters.indexOf(human.pid) < 0) return v.current_round;
      } else if (v && v.leader === human.pid && v.phase === 'proposal') {
        human.s.emit('propose', { team: v.players.slice(0, v.param[v.current_round]).map(p => p.pid) });
      }
      await wait(100);
    }
    return -1;
  }

  async function waitArchived(round) {
    for (let i = 0; i < 100; i++) {
      const v = human.lastVotes;
      const last = v && v.proposals.length ? v.proposals[v.proposals.length - 1] : null;
      if (last && last.round === round) return last;
      await wait(100);
    }
    return null;
  }

  // scenario 1: human leader gets the prompt and keeps the proposal
  let v = await restartUntilLeader(true, 30);
  check(v != null, 'started a game with the human as leader');
  let reconRound = await waitAllAiVotes();
  check(reconRound >= 0, 'proposal stays open with all AI votes cast');
  fake.state.flipVotes = true;
  human.s.emit('chat', { text: '大家再想想' });
  for (let i = 0; i < 100 && !human.reconsiderEvents.some(e => e.pid === human.pid); i++) await wait(100);
  check(human.reconsiderEvents.some(e => e.pid === human.pid), 'human leader is asked to reconsider');
  human.s.emit('keep_proposal');
  for (let i = 0; i < 200 && fake.state.reconsiderCalls < 4; i++) await wait(100);
  check(fake.state.reconsiderCalls >= 4, 'AI voters reconsider after the chat round');
  await wait(1000);
  human.s.emit('yes');
  let archived = await waitArchived(reconRound);
  let flipped = 0;
  for (const p of human.lastVotes.players) if (p.ai && archived != null && archived[p.pid] === -1) flipped++;
  check(flipped === 4, 'all AI voters flipped their proposal votes after the chat');

  // scenario 2: AI leader keeps the proposal, then the other AIs reconsider
  fake.state.flipVotes = false;
  const callsBefore = fake.state.reconsiderCalls;
  v = await restartUntilLeader(false, 30);
  check(v != null, 'started a game with an AI as leader');
  reconRound = await waitAllAiVotes();
  check(reconRound >= 0, 'AI leader proposal stays open with all AI votes cast');
  fake.state.flipVotes = true;
  human.s.emit('chat', { text: '再讨论一下' });
  for (let i = 0; i < 200 && fake.state.reconsiderCalls < callsBefore + 3; i++) await wait(100);
  check(fake.state.reconsiderCalls >= callsBefore + 3, 'other AI voters reconsider after the AI leader keeps');
  await wait(1000);
  human.s.emit('yes');
  archived = await waitArchived(reconRound);
  flipped = 0;
  for (const p of human.lastVotes.players) if (p.ai && archived != null && archived[p.pid] === -1) flipped++;
  check(flipped === 3, 'non-leader AI voters flipped their votes');
  fake.state.flipVotes = false;

  // an AI leader may speak when proposing, and the other AIs may respond
  fake.state.leaderSays = true;
  fake.state.replyText = '我觉得可以';
  v = await restartUntilLeader(false, 30);
  check(v != null, 'started a game with an AI leader for the proposal talk');
  const talkLeader = v.leader;
  for (let i = 0; i < 200 && !human.chats.some(m => m.pid === talkLeader && m.text === '我提名这个队伍'); i++) await wait(100);
  check(human.chats.some(m => m.pid === talkLeader && m.text === '我提名这个队伍'), 'AI leader may speak when proposing');
  for (let i = 0; i < 200 && human.chats.filter(m => m.text === '我觉得可以').length < 3; i++) await wait(100);
  check(human.chats.filter(m => m.text === '我觉得可以').length >= 3, 'other AIs may respond to the proposal talk');
  fake.state.leaderSays = false;
  fake.state.replyText = null;

  human.s.close();
  await wait(200);
  await stopServer(server);
  fake.server.close();
  try { fs.unlinkSync(cfgPath); } catch (e) {}
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });

// Manual end-to-end test: plays a whole game with N AI players (default 5)
// plus this script as a scripted human driver. It talks to the real model in
// ai.config.json, so it is not part of `npm test`.
//
// Usage: node test/ai_game.js [model-id] [--ais=5] [--timeout=900000] [--retries=5] [--thinking=on]
// The model id defaults to the first entry of ai.config.json. Thinking is
// disabled for the test copy of the config unless --thinking=on is passed.

const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const hit = argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.split('=')[1] : fallback;
}
const AIS = Number(flag('ais', 5));
const TIMEOUT_MS = Number(flag('timeout', 15 * 60 * 1000));
const MAX_RETRIES = Number(flag('retries', 5));

function ConfigPath() {
  return process.env.AI_CONFIG || path.join(__dirname, '..', 'ai.config.json');
}

function DefaultModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ConfigPath(), 'utf8'));
    return cfg.models[0].id;
  } catch (e) {
    return null;
  }
}

const MODEL = argv.find(a => a.indexOf('--') !== 0) || process.env.AI_GAME_MODEL || DefaultModel();
const KEEP_THINKING = flag('thinking', 'off') === 'on';
const wait = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(new Date().toISOString().slice(11, 19) + ' ' + msg);
}

// The test disables thinking by default so a game finishes quickly; the real
// ai.config.json is never modified.
function TestConfigPath() {
  const cfg = JSON.parse(fs.readFileSync(ConfigPath(), 'utf8'));
  const model = cfg.models.find(m => m.id === MODEL) || cfg.models[0];
  if (!KEEP_THINKING && model != null) {
    model.params = Object.assign({}, model.params, {thinking: {type: 'disabled'}});
  }
  const file = path.join(os.tmpdir(), 'resistance-game-' + process.pid + '.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

(async () => {
  if (MODEL == null) {
    console.error('No model id; pass one or configure ai.config.json');
    process.exit(1);
  }
  console.log('Model: ' + MODEL + ', AI players: ' + AIS + ', timeout: ' + Math.round(TIMEOUT_MS / 1000) +
    's, thinking: ' + (KEEP_THINKING ? 'on' : 'off (test default)'));

  const cfgFile = TestConfigPath();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: '0', AI_CONFIG: cfgFile })
  });
  let out = '';
  proc.stdout.on('data', c => {
    out += c;
    for (const line of String(c).split('\n')) {
      if (/AIFAIL|AIERR|AIHTTP|AI enabled|AI disabled/.test(line)) console.log('  server| ' + line);
    }
  });
  proc.stderr.on('data', c => process.stderr.write(c));

  const stop = code => {
    try { proc.kill(); } catch (e) {}
    try { fs.unlinkSync(cfgFile); } catch (e) {}
    process.exit(code);
  };

  let port = null;
  for (let i = 0; i < 50 && port == null; i++) {
    const m = out.match(/listening at .*:(\d+)/);
    if (m) port = Number(m[1]);
    else await wait(100);
  }
  if (port == null) {
    console.error('Server did not start');
    stop(1);
  }

  const s = io('http://localhost:' + port, { forceNew: true });
  const state = {
    lastVotes: null,
    errors: 0,
    retries: 0,
    retriesByPid: {},
    finished: null,
    missionShown: 0
  };
  s.on('connect', () => log('driver connected'));
  s.on('votes', d => {
    state.lastVotes = d;
    const done = (d.results || []).filter(r => r != null).length;
    if (done > state.missionShown) {
      state.missionShown = done;
      log('mission ' + done + ' result: ' + (d.results[done - 1] == 1 ? 'PASS' : 'FAIL') +
        ' | score R' + (d.results.filter(r => r === 1).length) + '-S' + (d.results.filter(r => r === 0).length));
    }
    if (d.winner != null) state.finished = d.winner;
  });
  s.on('ai_error', d => {
    if (!d.error) return;
    state.errors++;
    log('AI error: ' + d.name + ' ' + d.kind + ' ' + d.message);
    const n = (state.retriesByPid[d.pid] || 0);
    if (n >= MAX_RETRIES) {
      log('Giving up on ' + d.name + ' after ' + n + ' retries');
      return;
    }
    state.retriesByPid[d.pid] = n + 1;
    state.retries++;
    setTimeout(() => {
      log('Retrying ' + d.name);
      s.emit('ai_retry', { pid: d.pid });
    }, 500);
  });

  s.emit('me', { name: 'Driver', room: undefined, pid: 'pid-driver' });
  await wait(300);
  s.emit('create');
  await wait(400);
  for (let i = 0; i < AIS; i++) {
    s.emit('ai_add', { model: MODEL });
    await wait(200);
  }
  await wait(500);
  s.emit('start');
  log('game started with ' + AIS + ' AI players');

  const deadline = Date.now() + TIMEOUT_MS;
  let lastKey = '';
  while (Date.now() < deadline && state.finished == null) {
    const v = state.lastVotes;
    if (v) {
      const key = v.phase + ':' + v.current_round + ':' + (v.proposals || []).length;
      if (key !== lastKey) {
        lastKey = key;
        log('state phase=' + v.phase + ' mission=' + (v.current_round + 1) + ' leader=' +
          (v.players[v.players.map(p => p.pid).indexOf(v.leader)] || {}).name);
      }
      if (v.phase === 'proposal') {
        if (v.proposal && v.proposal.text != undefined) {
          if (v.proposal['pid-driver'] == undefined) s.emit('yes');
        } else if (v.leader === 'pid-driver') {
          const size = v.param[v.current_round];
          s.emit('propose', { team: v.players.slice(0, size).map(p => p.pid) });
        }
      } else if (v.phase === 'mission') {
        const r = v.current_round;
        if (v.mission_team.indexOf('pid-driver') >= 0 && v[r] && v[r].voted.indexOf('pid-driver') < 0) {
          s.emit('vote', { round: r, vote: 1 });
        }
      }
    }
    await wait(300);
  }

  const v = state.lastVotes;
  console.log('---');
  if (state.finished != null) {
    log('GAME FINISHED: ' + state.finished + ' wins');
    log('missions: ' + JSON.stringify(v.results) + ', proposals: ' + v.proposals.length +
      ', ai errors: ' + state.errors + ', retries: ' + state.retries);
    s.close();
    stop(0);
  } else {
    log('TIMEOUT after ' + Math.round(TIMEOUT_MS / 1000) + 's');
    if (v) {
      log('phase=' + v.phase + ' round=' + v.current_round + ' leader=' + v.leader +
        ' mission_team=' + JSON.stringify(v.mission_team));
      log('results=' + JSON.stringify(v.results) + ' proposals=' + v.proposals.length +
        ' current=' + JSON.stringify(v.proposal));
    }
    log('ai errors: ' + state.errors + ', retries: ' + state.retries + ', retries by pid: ' + JSON.stringify(state.retriesByPid));
    s.close();
    stop(1);
  }
})().catch(e => { console.error('ERROR', e); process.exit(1); });

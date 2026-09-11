// AI players backed by OpenAI-compatible chat completions endpoints.
// A room owns at most one state object (room.ai) holding the AI roster and one
// conversation per AI. Conversations are in memory only and are dropped with
// the room, like the rest of the game state.

var fs = require('fs');
var path = require('path');
var chat = require('./chat');

var NAME_MAX = 20;
var MAX_PLAYERS = 10;
// One name per room, never reused while the AI stays; 12 covers the 10-player cap.
var ZODIAC = ['子鼠', '丑牛', '寅虎', '卯兔', '辰龙', '巳蛇', '午马', '未羊', '申猴', '酉鸡', '戌狗', '亥猪'];
var CHAT_DEBOUNCE_MS = 2000;
var TURN_GAP_MS = 250;
var DEFAULT_TIMEOUT_MS = 30000;
var DEFAULT_MAX_TOKENS = 2000;
var DEFAULT_TEMPERATURE = 0.7;

var config = LoadConfig();
var ioRef = null;
var deps = null;

function LoadConfig() {
  var file = process.env.AI_CONFIG || path.join(__dirname, 'ai.config.json');
  var raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.log('AI disabled: cannot read ' + file);
    return null;
  }
  var parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log('AI disabled: invalid JSON in ' + file + ': ' + e.message);
    return null;
  }
  if (parsed == null || !Array.isArray(parsed.models) || parsed.models.length == 0) {
    console.log('AI disabled: ' + file + ' has no models array');
    return null;
  }
  for (var i = 0; i < parsed.models.length; ++i) {
    var m = parsed.models[i];
    if (m == null || m.id == undefined || m.base_url == undefined || m.model == undefined) {
      console.log('AI disabled: model entry ' + i + ' needs id, base_url and model');
      return null;
    }
  }
  var ids = [];
  for (var i = 0; i < parsed.models.length; ++i) ids.push(parsed.models[i].id);
  console.log('AI enabled: ' + ids.join(', '));
  return parsed;
}

function Truncate(s, n) {
  s = String(s == undefined ? '' : s);
  return s.length > n ? s.slice(0, n) + '...(' + s.length + ' chars)' : s;
}

function Enabled() {
  return config != null;
}

function Models() {
  if (!Enabled()) return [];
  var list = [];
  for (var i = 0; i < config.models.length; ++i) {
    var m = config.models[i];
    list.push({id: m.id, label: m.label != undefined ? m.label : m.model});
  }
  return list;
}

function TimeoutMs() {
  return config != null && config.timeout_ms != undefined ? config.timeout_ms : DEFAULT_TIMEOUT_MS;
}

function FindModel(id) {
  if (!Enabled()) return null;
  for (var i = 0; i < config.models.length; ++i) {
    if (config.models[i].id == id) return config.models[i];
  }
  return null;
}

function IsAi(room, pid) {
  return room != null && room.ai != null && pid != undefined && room.ai.byPid[pid] != undefined;
}

function RawName(name) {
  try {
    return decodeURIComponent(name);
  } catch (e) {
    return name;
  }
}

function EncodeName(name) {
  return encodeURIComponent(String(name).slice(0, NAME_MAX));
}

function NumOf(room, pid) {
  if (deps == null) return 0;
  var list = deps.PlayerList(room);
  for (var i = 0; i < list.length; ++i) {
    if (list[i].pid == pid) return i + 1;
  }
  return 0;
}

function TeamNums(room, team) {
  var nums = [];
  for (var i = 0; i < team.length; ++i) nums.push(NumOf(room, team[i]));
  return nums;
}

function NewPid(room) {
  var pid = '';
  do {
    pid = 'ai-' + Math.random().toString(36).slice(2, 10);
  } while (room.ai.byPid[pid] != undefined || room.order.indexOf(pid) >= 0);
  return pid;
}

function NextName(room) {
  var used = {};
  for (var pid in room.ai.byPid) {
    used[RawName(room.ai.byPid[pid].name)] = 1;
  }
  var free = [];
  for (var i = 0; i < ZODIAC.length; ++i) {
    if (used[ZODIAC[i]] == undefined) free.push(ZODIAC[i]);
  }
  if (free.length == 0) return 'AI';
  return free[Math.floor(Math.random() * free.length)];
}

function ModelOf(room, pid) {
  var a = room.ai != null ? room.ai.byPid[pid] : undefined;
  if (a == undefined) return null;
  var model = FindModel(a.model);
  return model != null ? (model.label != undefined ? model.label : model.model) : a.model;
}

function AiState(room) {
  if (room.ai == null) {
    room.ai = {order: [], byPid: {}, queue: [], queued: {}, running: false, chatTimer: null, reconsiderPending: null};
  }
  return room.ai;
}

function PlayerCount(room) {
  if (deps == null) return 0;
  return deps.PlayerList(room).length;
}

function Add(room, modelId) {
  if (!Enabled() || deps == null) return null;
  if (room.id == 'Lobby') return null;
  // Only allowed before a game starts or after it ended.
  if (room.n > 0 && room.winner == null) return null;
  if (PlayerCount(room) >= MAX_PLAYERS) return null;
  var model = FindModel(modelId);
  if (model == null) return null;
  var state = AiState(room);
  var pid = NewPid(room);
  var name = NextName(room);
  state.order.push(pid);
  state.byPid[pid] = {
    pid: pid,
    name: name,
    model: model.id,
    role: null,
    messages: [],
    thinking: false,
    error: null
  };
  room.names[pid] = EncodeName(name);
  if (room.order.indexOf(pid) < 0) room.order.push(pid);
  return pid;
}

function Remove(room, pid) {
  if (!IsAi(room, pid)) return false;
  if (room.n > 0 && room.winner == null) return false;
  var state = room.ai;
  var i = state.order.indexOf(pid);
  if (i >= 0) state.order.splice(i, 1);
  delete state.byPid[pid];
  for (var key in state.queued) {
    if (key.indexOf(pid + ':') == 0) delete state.queued[key];
  }
  var queue = [];
  for (var j = 0; j < state.queue.length; ++j) {
    if (state.queue[j].pid != pid) queue.push(state.queue[j]);
  }
  state.queue = queue;
  var oi = room.order.indexOf(pid);
  if (oi >= 0) room.order.splice(oi, 1);
  delete room.names[pid];
  return true;
}

function Reset(room) {
  if (room.ai == null) return;
  var state = room.ai;
  state.queue = [];
  state.queued = {};
  state.running = false;
  state.reconsiderPending = null;
  if (state.chatTimer != null) {
    clearTimeout(state.chatTimer);
    state.chatTimer = null;
  }
  for (var pid in state.byPid) {
    var a = state.byPid[pid];
    a.messages = [];
    a.role = null;
    a.thinking = false;
    a.error = null;
  }
}

function Emit(room, event, payload) {
  if (ioRef == null) return;
  ioRef.to(room.id).emit(event, payload);
}

function LogEvent(room, event) {
  if (room.ai == null) return;
  var message = {role: 'user', content: JSON.stringify(event)};
  for (var i = 0; i < room.ai.order.length; ++i) {
    var a = room.ai.byPid[room.ai.order[i]];
    if (a != undefined) a.messages.push(message);
  }
}

function SystemPrompt(room, pid) {
  var role = room.roleByPid != null ? room.roleByPid[pid] : null;
  var list = deps.PlayerList(room);
  var num = NumOf(room, pid);
  var roster = [];
  for (var i = 0; i < list.length; ++i) {
    roster.push((i + 1) + '号 ' + RawName(list[i].name));
  }
  var lines = [];
  lines.push('你是桌游《抵抗组织》(The Resistance) 的 AI 玩家，编号 ' + num + '号。你的唯一目标是让自己所在的阵营获胜。');
  lines.push('');
  lines.push('规则：');
  lines.push('- 5-10 名玩家，分为抵抗军和间谍，间谍互相知道同伴身份。');
  lines.push('- 最多进行 5 个任务，先赢 3 个任务的一方获胜。');
  lines.push('- 每个任务由领袖提议一个队伍（人数见任务表），所有玩家投票赞成或反对，严格多数赞成才通过。提案投票是公开的，但只有在所有玩家都投票后，才会公开每个人投的是赞成还是反对。');
  lines.push('- 提案被否决则领袖按编号轮换；若所有玩家都提过一次且都被否决，下一个提案自动通过。');
  lines.push('- 队伍通过后，只有队员投票 通过(pass) 或 破坏(fail)。通常 1 张破坏票任务即失败，但 7 人及以上时第 4 个任务需要 2 张破坏票。任务投票是匿名的，不公开谁投了什么，但会公开成功票和失败票各有多少张。');
  lines.push('- 抵抗军成员不能投破坏票；间谍可以选择投破坏票。');
  lines.push('- 领袖按玩家编号顺序轮换，第一个领袖随机。');
  lines.push('');
  lines.push('任务表（玩家数: 各任务队伍人数 / 间谍数）：');
  for (var n = 5; n <= 10; ++n) {
    lines.push(n + '人: ' + deps.Param[n].slice(0, 5).join(' ') + ' / ' + deps.Param[n][5] + '间谍');
  }
  lines.push('');
  lines.push('玩家名单：' + roster.join('、'));
  lines.push('你是 ' + num + '号，身份是' + (role == 0 ? '间谍' : '抵抗军') + '。');
  if (role == 0) {
    var partners = [];
    for (var i = 0; i < list.length; ++i) {
      if (room.roleByPid[list[i].pid] == 0 && list[i].pid != pid) {
        partners.push((i + 1) + '号');
      }
    }
    lines.push(partners.length ? '你的间谍同伴是：' + partners.join('、') + '。' : '你是唯一的间谍。');
  }
  lines.push('');
  lines.push('所有历史事件都用玩家编号表示，例如 {"event":"proposal","actor":2,"mission":1,"result":[3,5]} 表示 2号玩家提议第 1 个任务的队伍是 3号和 5号。');
  lines.push('你只能用 JSON 回复，不要输出 JSON 以外的任何文字。');
  lines.push('当人类在聊天中发言时，你可以用中文简短回应，也可以选择沉默；不要泄露只有自己知道的信息，也可以为了阵营利益撒谎。');
  return lines.join('\n');
}

function OnStart(room) {
  if (!Enabled() || room.ai == null || room.roleByPid == null) return;
  for (var i = 0; i < room.ai.order.length; ++i) {
    var a = room.ai.byPid[room.ai.order[i]];
    if (a == undefined) continue;
    a.role = room.roleByPid[a.pid];
    a.messages = [{role: 'system', content: SystemPrompt(room, a.pid)}];
    a.error = null;
    a.thinking = false;
  }
  var spies = 0;
  for (var pid in room.roleByPid) {
    if (room.roleByPid[pid] == 0) ++spies;
  }
  LogEvent(room, {event: 'game_start', players: room.players.length, spies: spies});
  MaybeTrigger(room);
}

function OnProposal(room, pid, team, round, auto) {
  // A new proposal replaces any pending revision request.
  if (room.ai != null) room.ai.reconsiderPending = null;
  LogEvent(room, {event: 'proposal', actor: NumOf(room, pid), mission: round + 1, result: TeamNums(room, team)});
  if (auto) {
    LogEvent(room, {event: 'proposal_result', mission: round + 1, approved: true, auto: true, votes: []});
    LogEvent(room, {event: 'mission_start', mission: round + 1, result: TeamNums(room, room.mission_team)});
  }
  MaybeTrigger(room);
}

function OnProposalVote(room, pid, round, finished, approved) {
  if (finished && room.ai != null) room.ai.reconsiderPending = null;
  LogEvent(room, {event: 'proposal_vote', actor: NumOf(room, pid), mission: round + 1});
  if (finished) {
    var p = room.proposals[room.proposals.length - 1];
    var votes = [];
    for (var k in p) {
      if (k == 'text' || k == 'who' || k == 'by' || k == 'round' || k == 'team' || k == 'auto') continue;
      votes.push({actor: NumOf(room, k), vote: p[k] == 1 ? 'yes' : 'no'});
    }
    LogEvent(room, {event: 'proposal_result', mission: round + 1, approved: !!approved, votes: votes});
    if (approved) {
      LogEvent(room, {event: 'mission_start', mission: round + 1, result: TeamNums(room, room.mission_team)});
    }
  }
  MaybeTrigger(room);
}

function OnSurrender(room, pid) {
  if (room.ai == null) return;
  LogEvent(room, {event: 'surrender', actor: NumOf(room, pid), winner: room.winner});
  LogEvent(room, {event: 'game_end', winner: room.winner});
}

function OnMissionVote(room, pid, round, finished) {
  LogEvent(room, {event: 'mission_vote', actor: NumOf(room, pid), mission: round + 1});
  if (finished) {
    var votes = [];
    for (var i = 0; i < room.votes[round].length; ++i) {
      votes.push(room.votes[round][i] == 1 ? 'pass' : 'fail');
    }
    LogEvent(room, {event: 'mission_result', mission: round + 1, success: room.results[round] == 1, result: votes});
    if (room.winner != null) {
      LogEvent(room, {event: 'game_end', winner: room.winner});
    }
  }
  MaybeTrigger(room);
}

function OnChat(room, msg) {
  if (!Enabled() || room.ai == null || msg == undefined) return;
  // Before the game starts there is no conversation to update and nothing to act on.
  if (room.n < 5) return;
  LogEvent(room, {event: 'chat', actor: NumOf(room, msg.pid), text: msg.text});
  // Coalesce a burst of human messages into one reply round.
  if (room.ai.chatTimer != null) clearTimeout(room.ai.chatTimer);
  room.ai.chatTimer = setTimeout(function() {
    room.ai.chatTimer = null;
    for (var i = 0; i < room.ai.order.length; ++i) {
      Enqueue(room, room.ai.order[i], 'chat');
    }
    // Once the replies are done, reconsider the open proposal.
    EnqueueRoom(room, 'reconsider');
  }, CHAT_DEBOUNCE_MS);
}

function HasError(room, pid) {
  return room.ai != null && room.ai.byPid[pid] != undefined && room.ai.byPid[pid].error != null;
}

function ThinkingPids(room) {
  var pids = [];
  if (room.ai == null) return pids;
  for (var i = 0; i < room.ai.order.length; ++i) {
    var a = room.ai.byPid[room.ai.order[i]];
    if (a != undefined && a.thinking) pids.push(a.pid);
  }
  return pids;
}

function MaybeTrigger(room) {
  if (!Enabled() || room.ai == null || deps == null) return;
  if (room.id == 'Lobby' || room.n < 5 || room.n > 10) return;
  if (room.winner != null) return;
  if (room.phase == 'proposal') {
    if (room.current_proposal['text'] == undefined) {
      var leader = room.players[room.leader];
      if (IsAi(room, leader) && !HasError(room, leader)) Enqueue(room, leader, 'propose');
    } else {
      for (var i = 0; i < room.ai.order.length; ++i) {
        var pid = room.ai.order[i];
        if (room.players.indexOf(pid) < 0 || HasError(room, pid)) continue;
        if (room.current_proposal[pid] == undefined) Enqueue(room, pid, 'vote_proposal');
      }
    }
  } else if (room.phase == 'mission') {
    var round = deps.CurrentRound(room);
    if (round < 0) return;
    for (var i = 0; i < room.ai.order.length; ++i) {
      var pid = room.ai.order[i];
      if (room.mission_team.indexOf(pid) < 0 || HasError(room, pid)) continue;
      if (room.voted[round] != undefined && room.voted[round][pid] != undefined) continue;
      Enqueue(room, pid, 'vote_mission');
    }
  }
}

function QueueKey(pid, type) {
  return (pid == null ? '' : pid) + ':' + type;
}

function Enqueue(room, pid, type) {
  if (room.ai == null || room.ai.byPid[pid] == undefined) return;
  var key = QueueKey(pid, type);
  if (room.ai.queued[key]) return;
  room.ai.queued[key] = 1;
  room.ai.queue.push({pid: pid, type: type});
  Pump(room);
}

function EnqueueRoom(room, type) {
  if (room.ai == null) return;
  var key = QueueKey(null, type);
  if (room.ai.queued[key]) return;
  room.ai.queued[key] = 1;
  room.ai.queue.push({pid: null, type: type});
  Pump(room);
}

function Pump(room) {
  if (room.ai == null || room.ai.running) return;
  var item = room.ai.queue.shift();
  if (item == undefined) return;
  room.ai.running = true;
  var finish = function() {
    delete room.ai.queued[QueueKey(item.pid, item.type)];
    room.ai.running = false;
    MaybeTrigger(room);
    if (room.ai.queue.length > 0) {
      setTimeout(function() { Pump(room); }, TURN_GAP_MS);
    }
  };
  if (item.type == 'reconsider') {
    RunReconsider(room, finish);
  } else {
    RunTask(room, item.pid, item.type, finish);
  }
}

// After a chat round, let the leader revise the proposal; if the leader keeps
// it, let the other AI voters reconsider their vote.
function RunReconsider(room, done) {
  if (!Enabled() || room.ai == null) return done();
  if (room.winner != null || room.n < 5 || room.n > 10) return done();
  if (room.phase != 'proposal' || room.current_proposal['text'] == undefined) return done();
  if (room.ai.reconsiderPending != null) return done();
  var leader = room.players[room.leader];
  if (IsAi(room, leader)) {
    if (HasError(room, leader)) return done();
    var before = JSON.stringify(room.current_proposal.team);
    RunTask(room, leader, 'repropose', function(ok) {
      if (!ok) return done();
      if (room.current_proposal['text'] == undefined) return done();
      if (JSON.stringify(room.current_proposal.team) != before) return done();
      EnqueueVoteReconsider(room, leader);
      done();
    });
  } else {
    room.ai.reconsiderPending = leader;
    Emit(room, 'proposal_reconsider', {
      pid: leader,
      mission: room.current_proposal.round + 1,
      text: room.current_proposal.text
    });
    done();
  }
}

function EnqueueVoteReconsider(room, leader) {
  if (room.current_proposal['text'] == undefined) return;
  for (var i = 0; i < room.ai.order.length; ++i) {
    var pid = room.ai.order[i];
    if (pid == leader) continue;
    if (room.players.indexOf(pid) < 0 || HasError(room, pid)) continue;
    if (room.current_proposal[pid] == undefined) continue;
    Enqueue(room, pid, 'reconsider_vote');
  }
}

function EnqueueProposalReplies(room, leader) {
  if (room.current_proposal['text'] == undefined) return;
  for (var i = 0; i < room.ai.order.length; ++i) {
    var pid = room.ai.order[i];
    if (pid == leader) continue;
    if (room.players.indexOf(pid) < 0 || HasError(room, pid)) continue;
    Enqueue(room, pid, 'propose_reply');
  }
}

function ValidateNeed(room, pid, type) {
  if (!IsAi(room, pid)) return false;
  if (type == 'chat') return true;
  if (room.winner != null) return false;
  if (room.n < 5 || room.n > 10) return false;
  if (room.phase == 'proposal') {
    if (type == 'propose') {
      return room.current_proposal['text'] == undefined && room.players[room.leader] == pid;
    }
    if (type == 'vote_proposal') {
      return room.current_proposal['text'] != undefined &&
        room.current_proposal[pid] == undefined &&
        room.players.indexOf(pid) >= 0;
    }
    if (type == 'repropose') {
      return room.current_proposal['text'] != undefined && room.players[room.leader] == pid;
    }
    if (type == 'reconsider_vote') {
      return room.current_proposal['text'] != undefined &&
        room.players.indexOf(pid) >= 0 &&
        room.players[room.leader] != pid &&
        room.current_proposal[pid] != undefined;
    }
    if (type == 'propose_reply') {
      return room.current_proposal['text'] != undefined &&
        room.players.indexOf(pid) >= 0 &&
        room.players[room.leader] != pid;
    }
  }
  if (room.phase == 'mission' && type == 'vote_mission') {
    var round = deps.CurrentRound(room);
    return round >= 0 && room.mission_team.indexOf(pid) >= 0 &&
      (room.voted[round] == undefined || room.voted[round][pid] == undefined);
  }
  return false;
}

function BuildInstruction(room, pid, type) {
  var num = NumOf(room, pid);
  if (type == 'propose') {
    var round = deps.CurrentRound(room);
    var size = deps.Param[room.n][round];
    return '现在轮到你（' + num + '号）作为领袖提议第 ' + (round + 1) + ' 个任务的队伍。' +
      '需要恰好 ' + size + ' 名不同玩家，请从 1 到 ' + room.players.length + ' 号中选择。' +
      '你可以用 say 字段附上一句中文发言（也可以省略 say）。\n' +
      '只输出 JSON，例如：{"action":"propose","team":[1,2],"say":"我认为..."}';
  }
  if (type == 'vote_proposal') {
    var p = room.current_proposal;
    return '现在对第 ' + (p.round + 1) + ' 个任务的提案投票。提案人：' + NumOf(room, p.by) + '号；' +
      '队伍：[' + TeamNums(room, p.team).join(',') + ']。请决定赞成或反对。\n' +
      '只输出 JSON：{"action":"vote_proposal","vote":"yes"} 或 {"action":"vote_proposal","vote":"no"}';
  }
  if (type == 'vote_mission') {
    var round = deps.CurrentRound(room);
    return '你是第 ' + (round + 1) + ' 个任务的队员（任务队伍：[' + TeamNums(room, room.mission_team).join(',') + ']）。' +
      '请决定投 通过(pass) 还是 破坏(fail)。\n' +
      '只输出 JSON：{"action":"vote_mission","vote":"pass"} 或 {"action":"vote_mission","vote":"fail"}';
  }
  if (type == 'chat') {
    return '聊天记录已更新。你可以用中文发言一次（简短、符合你的身份和策略），也可以保持沉默。不要暴露只有自己知道的信息。\n' +
      '只输出 JSON：{"action":"chat","text":"..."} 或 {"action":"silent"}';
  }
  if (type == 'repropose') {
    var p = room.current_proposal;
    return '有人在聊天中发言了。你可以修改当前提案，也可以保持不变。\n' +
      '当前是第 ' + (p.round + 1) + ' 个任务，你（' + num + '号）是领袖，提案队伍：[' + TeamNums(room, p.team).join(',') + ']，' +
      '需要 ' + deps.Param[room.n][p.round] + ' 名不同玩家。\n' +
      '只输出 JSON：{"action":"repropose","team":[编号,...]} 或 {"action":"keep"}';
  }
  if (type == 'reconsider_vote') {
    var p = room.current_proposal;
    var cur = p[pid] == 1 ? 'yes' : 'no';
    return '有人在聊天中发言了。你可以维持或改变你对当前提案的投票。\n' +
      '提案人：' + NumOf(room, p.by) + '号；队伍：[' + TeamNums(room, p.team).join(',') + ']；你当前投的是 ' + cur + '。\n' +
      '只输出 JSON：{"action":"reconsider","vote":"yes"}、{"action":"reconsider","vote":"no"} 或 {"action":"keep"}';
  }
  if (type == 'propose_reply') {
    var p = room.current_proposal;
    return '领袖（' + NumOf(room, p.by) + '号）刚刚提名了第 ' + (p.round + 1) + ' 个任务的队伍：[' + TeamNums(room, p.team).join(',') + ']。' +
      '你可以用中文回应一次（简短、符合你的身份和策略），也可以保持沉默。\n' +
      '只输出 JSON：{"action":"chat","text":"..."} 或 {"action":"silent"}';
  }
  return null;
}

function ExtractJson(text) {
  if (text == undefined) return null;
  var start = text.indexOf('{');
  if (start < 0) return null;
  var depth = 0;
  var inStr = false;
  var esc = false;
  for (var i = start; i < text.length; ++i) {
    var c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '"') inStr = false;
      continue;
    }
    if (c == '"') inStr = true;
    else if (c == '{') ++depth;
    else if (c == '}') {
      --depth;
      if (depth == 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

function ApplyAction(room, pid, type, content) {
  var obj = ExtractJson(content);
  if (obj == null) {
    // Optional actions just keep the current state.
    if (type == 'repropose' || type == 'reconsider_vote' || type == 'propose_reply') return null;
    return {kind: 'parse', message: '无法从模型输出中解析 JSON'};
  }
  if (type == 'propose') {
    if (obj.action != 'propose' || !Array.isArray(obj.team)) {
      return {kind: 'invalid', message: '模型没有给出合法的提案 JSON'};
    }
    var round = deps.CurrentRound(room);
    if (obj.team.length != deps.Param[room.n][round]) {
      return {kind: 'invalid', message: '模型给出的队伍人数不对'};
    }
    var team = [];
    for (var i = 0; i < obj.team.length; ++i) {
      var idx = Number(obj.team[i]);
      if (!isFinite(idx) || Math.floor(idx) != idx || idx < 1 || idx > room.players.length) {
        return {kind: 'invalid', message: '模型选择了不存在的玩家编号'};
      }
      var p = room.players[idx - 1];
      if (team.indexOf(p) >= 0) return {kind: 'invalid', message: '模型重复选择了玩家'};
      team.push(p);
    }
    var say = typeof obj.say == 'string' && obj.say.replace(/\s/g, '') != '';
    if (say) {
      var said = chat.Say(ioRef, room, pid, obj.say);
      if (said != null) LogEvent(room, {event: 'chat', actor: NumOf(room, pid), text: said.text});
    }
    if (!deps.ProposeAction(room, pid, team)) {
      return {kind: 'invalid', message: '模型给出的提案不合法'};
    }
    if (say) EnqueueProposalReplies(room, pid);
    return null;
  }
  if (type == 'vote_proposal') {
    var vote = null;
    if (obj.vote == 'yes' || obj.vote === true || obj.vote == 1) vote = 1;
    else if (obj.vote == 'no' || obj.vote === false || obj.vote == -1) vote = -1;
    if (vote == null) return {kind: 'invalid', message: '模型没有给出合法的赞成/反对票'};
    if (!deps.ProposalVoteAction(room, pid, vote)) {
      return {kind: 'invalid', message: '提案投票被拒绝'};
    }
    return null;
  }
  if (type == 'vote_mission') {
    var missionVote = null;
    if (obj.vote == 'pass') missionVote = 1;
    else if (obj.vote == 'fail') missionVote = 0;
    if (missionVote == null) return {kind: 'invalid', message: '模型没有给出合法的任务票'};
    // Resistance members may not sabotage.
    if (room.roleByPid[pid] != 0 && missionVote == 0) missionVote = 1;
    var round = deps.CurrentRound(room);
    if (!deps.MissionVoteAction(room, pid, round, missionVote)) {
      return {kind: 'invalid', message: '任务投票被拒绝'};
    }
    return null;
  }
  if (type == 'repropose') {
    // Optional revision: anything that is not a valid change means keep.
    if (obj.action != 'repropose' || !Array.isArray(obj.team)) return null;
    var newTeam = [];
    for (var i = 0; i < obj.team.length; ++i) {
      var idx = Number(obj.team[i]);
      if (!isFinite(idx) || Math.floor(idx) != idx || idx < 1 || idx > room.players.length) return null;
      var member = room.players[idx - 1];
      if (newTeam.indexOf(member) >= 0) return null;
      newTeam.push(member);
    }
    var curTeam = room.current_proposal.team;
    if (newTeam.length == curTeam.length) {
      var same = true;
      for (var i = 0; i < newTeam.length; ++i) {
        if (newTeam[i] != curTeam[i]) { same = false; break; }
      }
      if (same) return null;
    }
    if (!deps.ProposeAction(room, pid, newTeam)) return null;
    return null;
  }
  if (type == 'reconsider_vote') {
    if (obj.action == 'reconsider' && (obj.vote == 'yes' || obj.vote == 'no')) {
      var change = obj.vote == 'yes' ? 1 : -1;
      if (room.current_proposal['text'] != undefined && room.current_proposal[pid] != change) {
        deps.ProposalVoteAction(room, pid, change);
      }
    }
    return null;
  }
  if (type == 'chat' || type == 'propose_reply') {
    if (obj.action == 'silent') return null;
    var text = typeof obj.text == 'string' ? obj.text : '';
    if (text.replace(/\s/g, '') == '') return null;
    var msg = chat.Say(ioRef, room, pid, text);
    if (msg != null) {
      LogEvent(room, {event: 'chat', actor: NumOf(room, pid), text: msg.text});
    }
    return null;
  }
  return {kind: 'invalid', message: '未知动作类型'};
}

function SetError(room, pid, type, err) {
  var a = room.ai != null ? room.ai.byPid[pid] : undefined;
  if (a == undefined) return;
  a.error = {kind: err.kind, message: err.message, type: type};
  Emit(room, 'ai_error', {pid: pid, name: a.name, error: 1, kind: err.kind, message: err.message});
}

function ClearError(room, pid) {
  var a = room.ai != null ? room.ai.byPid[pid] : undefined;
  if (a == undefined || a.error == null) return;
  a.error = null;
  Emit(room, 'ai_error', {pid: pid, name: a.name, error: null});
}

function CallModel(room, pid, instruction, cb) {
  var a = room.ai.byPid[pid];
  var model = FindModel(a.model);
  if (model == null) {
    cb({kind: 'config', message: '找不到模型配置 ' + a.model}, null);
    return;
  }
  var body = {};
  // params carries provider-specific options, e.g. {"thinking":{"type":"disabled"}}.
  if (model.params != null && typeof model.params == 'object') {
    for (var k in model.params) body[k] = model.params[k];
  }
  body.model = model.model;
  body.messages = a.messages.concat([{role: 'user', content: instruction}]);
  if (body.temperature == undefined) {
    body.temperature = model.temperature != undefined ? model.temperature : DEFAULT_TEMPERATURE;
  }
  if (body.max_tokens == undefined) {
    body.max_tokens = model.max_tokens != undefined ? model.max_tokens : DEFAULT_MAX_TOKENS;
  }
  var url = String(model.base_url).replace(/\/+$/, '') + '/chat/completions';
  var controller = new AbortController();
  var started = Date.now();
  var timer = setTimeout(function() { controller.abort(); }, TimeoutMs());
  var headers = {'Content-Type': 'application/json'};
  if (model.api_key != undefined) headers['Authorization'] = 'Bearer ' + model.api_key;
  fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: controller.signal
  }).then(function(res) {
    if (!res.ok) {
      return res.text().then(function(text) {
        console.log('AIHTTP ' + room.id + ' ' + a.name + ' ' + res.status + ' ' + Truncate(text, 300));
        throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 200));
      });
    }
    return res.json();
  }).then(function(data) {
    clearTimeout(timer);
    var choice = data != null && data.choices != null ? data.choices[0] : null;
    var content = choice != null && choice.message != null ? choice.message.content : null;
    if (typeof content != 'string' || content == '') {
      var reason = choice != null ? choice.finish_reason : null;
      var detail = reason == 'length' ? '输出被 max_tokens 截断（推理占满额度），请调大 max_tokens' : '模型返回了空内容';
      console.log('AIFAIL ' + room.id + ' ' + a.name + ' ' + detail + ' finish=' + reason +
        ' after ' + (Date.now() - started) + 'ms: ' + Truncate(JSON.stringify(data), 300));
      cb({kind: 'parse', message: detail}, null);
      return;
    }
    cb(null, content);
  }).catch(function(e) {
    clearTimeout(timer);
    var kind = e != null && e.name == 'AbortError' ? 'timeout' : 'error';
    var message = String(e != null && e.message != undefined ? e.message : e);
    console.log('AIERR ' + room.id + ' ' + a.name + ' ' + kind + ' after ' + (Date.now() - started) + 'ms: ' + message);
    cb({kind: kind, message: message}, null);
  });
}

function RunTask(room, pid, type, done) {
  var a = room.ai != null ? room.ai.byPid[pid] : undefined;
  if (a == undefined) return done(false);
  if (!ValidateNeed(room, pid, type)) return done(false);
  var instruction = BuildInstruction(room, pid, type);
  if (instruction == null) return done(false);
  a.thinking = true;
  Emit(room, 'ai_thinking', {pid: pid, on: true});
  CallModel(room, pid, instruction, function(err, content) {
    a.thinking = false;
    Emit(room, 'ai_thinking', {pid: pid, on: false});
    if (err != null) {
      SetError(room, pid, type, err);
      return done(false);
    }
    // The board may have changed while the model was thinking.
    if (!ValidateNeed(room, pid, type)) return done(false);
    var result = ApplyAction(room, pid, type, content);
    if (result != null) {
      console.log('AIFAIL ' + room.id + ' ' + a.name + ' ' + type + ' ' + result.kind + ': ' + result.message + ' raw=' + Truncate(content, 500));
      SetError(room, pid, type, result);
      return done(false);
    }
    a.messages.push({role: 'user', content: instruction});
    a.messages.push({role: 'assistant', content: content});
    ClearError(room, pid);
    if (type != 'chat') deps.SendVotes(room);
    done(true);
  });
}

function Setup(socket, io, dependencies) {
  ioRef = io;
  deps = dependencies;
  socket.emit('ai_models', {enabled: Enabled(), models: Models()});
  socket.on('ai_state', function() {
    var room = deps.GetRoom(socket);
    socket.emit('ai_state', {thinking: ThinkingPids(room)});
  });
  socket.on('ai_add', function(data) {
    if (!Enabled()) return;
    var room = deps.GetRoom(socket);
    var pid = Add(room, data != undefined ? data.model : undefined);
    if (pid == null) {
      console.log('AIADD failed model=' + (data != undefined ? data.model : undefined) + ' room=' + room.id);
      return;
    }
    console.log('AIADD', pid, room.id);
    deps.BroadcastJoin(room);
  });
  socket.on('ai_remove', function(data) {
    if (!Enabled()) return;
    var room = deps.GetRoom(socket);
    if (!Remove(room, data != undefined ? data.pid : undefined)) return;
    console.log('AIREMOVE', data.pid, room.id);
    deps.BroadcastJoin(room);
  });
  socket.on('ai_retry', function(data) {
    if (!Enabled()) return;
    var room = deps.GetRoom(socket);
    var pid = data != undefined ? data.pid : undefined;
    if (!IsAi(room, pid)) return;
    var a = room.ai.byPid[pid];
    if (a.error == null) return;
    var type = a.error.type;
    console.log('AIRETRY', pid, type, room.id);
    a.error = null;
    Emit(room, 'ai_error', {pid: pid, name: a.name, error: null});
    Enqueue(room, pid, type);
  });
  socket.on('keep_proposal', function() {
    if (!Enabled()) return;
    var room = deps.GetRoom(socket);
    if (room.ai == null || room.ai.reconsiderPending == null) return;
    var pid = deps.PlayerId(socket);
    if (room.ai.reconsiderPending != pid) return;
    if (room.phase != 'proposal' || room.current_proposal['text'] == undefined) {
      room.ai.reconsiderPending = null;
      return;
    }
    room.ai.reconsiderPending = null;
    console.log('AIKEEP', pid, room.id);
    EnqueueVoteReconsider(room, pid);
  });
}

module.exports = {
  Setup: Setup,
  IsAi: IsAi,
  ModelOf: ModelOf,
  Add: Add,
  Remove: Remove,
  Reset: Reset,
  OnStart: OnStart,
  OnProposal: OnProposal,
  OnProposalVote: OnProposalVote,
  OnMissionVote: OnMissionVote,
  OnSurrender: OnSurrender,
  OnChat: OnChat
};

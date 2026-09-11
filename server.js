var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser')
var fs = require('fs') // this engine requires the fs module
var chat = require('./chat');
var ai = require('./ai');
function JsLiteral(value) {
  if (value == undefined || value == '') return 'null';
  // Escape '<' so a value cannot close the inline <script> tag.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

var NAME_MAX = 20;
function ClampRawName(name) {
  if (name == undefined) return name;
  return String(name).slice(0, NAME_MAX);
}
function ClampEscapedName(name) {
  if (name == undefined) return name;
  var raw = name;
  try { raw = decodeURIComponent(name); } catch (e) {}
  return encodeURIComponent(String(raw).slice(0, NAME_MAX));
}

app.engine('ntl', function (filePath, options, callback) { // define the template engine
  fs.readFile(filePath, function (err, content) {
    if (err) return callback(err)
    // this is an extremely simple template engine
    var rendered = content.toString()
      .replace('#name#', options.name)
      .replace('#room#', options.room)
      .replace('#pid#', options.pid)
    return callback(null, rendered)
  })
})
app.set('views', './views') // specify the views directory
app.set('view engine', 'ntl') // register the template engine

app.use(cookieParser());
app.use(bodyParser.json());       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));

app.get('/', function (req, res) {
  res.render('index', {
    name: JsLiteral(req.cookies.name),
    room: JsLiteral(req.cookies.room),
    pid: JsLiteral(req.cookies.pid)})
})

app.post('/setname', function (req, res) {
  var name = ClampRawName(req.body.name);
  var room = req.body.room;
  var pid = req.body.pid;
  if (name != undefined) {
    res.cookie('name', name, {maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true});
  }
  if (room != undefined) {
    res.cookie('room', room, {maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true});
  }
  if (pid != undefined && /^[A-Za-z0-9_-]{1,64}$/.test(pid)) {
    res.cookie('pid', pid, {maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true});
  }
  res.json({ok:1});
})
app.use(express.static(__dirname + '/public'));

var param = {
  5: [2, 3, 2, 3, 3, 2],
  6: [2, 3, 4, 3, 4, 2],
  7: [2, 3, 3, 4, 4, 3],
  8: [3, 4, 4, 5, 5, 3],
  9: [3, 4, 4, 5, 5, 3],
  10: [3, 4, 4, 5, 5, 4]
};

var rooms = {
  Lobby: {
    id: 'Lobby',
    sockets: {}
  }
};

function CreateRoom() {
  var ROOM_ID_LEN = 4;
  var ROOM_ID_PICK = "0123456789";
  var room_id = '';
  var i = 0;
  do {
    room_id = '';
    for (var i = 0; i < ROOM_ID_LEN; ++i) {
      room_id += ROOM_ID_PICK[Math.floor(Math.random() * ROOM_ID_PICK.length)];
    }
    ++i;
    if (i > 10) return null;
  } while (rooms[room_id] != undefined);
  rooms[room_id] = {
    id: room_id,
    sockets: {}
  };
  RoomStart(rooms[room_id], 0);
  console.log('NEWROOM', room_id);
  return room_id;
}

function PlayerId(socket) {
  // Persistent id survives reconnects and name changes; fall back to the socket id.
  return socket.pid != undefined ? socket.pid : socket.id;
}

function PlayerPids(room) {
  var pids = [];
  var seen = {};
  // Keep the order in which pids first joined, so reconnects do not move a player.
  var order = room.order != undefined ? room.order : [];
  for (var i = 0; i < order.length; ++i) {
    var pid = order[i];
    if (seen[pid] || !IsOnline(room, pid)) continue;
    seen[pid] = 1;
    pids.push(pid);
  }
  for (var s in room.sockets) {
    var pid = PlayerId(room.sockets[s]);
    if (seen[pid]) continue;
    seen[pid] = 1;
    pids.push(pid);
  }
  return pids;
}

function IsOnline(room, pid) {
  if (ai.IsAi(room, pid)) return true;
  for (var s in room.sockets) {
    if (PlayerId(room.sockets[s]) == pid) return true;
  }
  return false;
}

function PlayerName(room, pid) {
  if (room.names != undefined && room.names[pid] != undefined) return room.names[pid];
  for (var s in room.sockets) {
    if (PlayerId(room.sockets[s]) == pid) return room.sockets[s].name;
  }
  return null;
}

function PlayerList(room) {
  var list = [];
  // Reveal every role once the game is over.
  var reveal = room.winner != null && room.roleByPid != null;
  // While a game is running the roster and numbers are frozen; otherwise they follow join order.
  if (room.players != undefined && room.n > 0 && room.winner == null) {
    for (var i = 0; i < room.players.length; ++i) {
      var pid = room.players[i];
      var isAi = ai.IsAi(room, pid);
      list.push({pid: pid, name: PlayerName(room, pid), online: IsOnline(room, pid), number: i + 1, ai: isAi ? 1 : undefined, model: isAi ? ai.ModelOf(room, pid) : undefined, role: reveal ? room.roleByPid[pid] : undefined});
    }
    return list;
  }
  var seen = {};
  var order = room.order != undefined ? room.order : [];
  for (var i = 0; i < order.length; ++i) {
    var pid = order[i];
    if (seen[pid] || !IsOnline(room, pid)) continue;
    seen[pid] = 1;
    var isAi = ai.IsAi(room, pid);
    list.push({pid: pid, name: PlayerName(room, pid), online: true, number: list.length + 1, ai: isAi ? 1 : undefined, model: isAi ? ai.ModelOf(room, pid) : undefined, role: reveal ? room.roleByPid[pid] : undefined});
  }
  for (var s in room.sockets) {
    var pid = PlayerId(room.sockets[s]);
    if (seen[pid]) continue;
    seen[pid] = 1;
    list.push({pid: pid, name: room.sockets[s].name != undefined ? room.sockets[s].name : 'SOMEONE', online: true, number: list.length + 1});
  }
  return list;
}

function RoomStart(room, n) {
  room.n = n;
  room.votes = [[], [], [], [], []];
  room.voters = [[], [], [], [], []];
  room.voted = {};
  room.proposals = [];
  room.current_proposal = {};
  room.phase = 'proposal';
  room.names = room.names || {};
  room.order = room.order || [];
  room.players = PlayerPids(room);
  room.leader = room.players.length ? Math.floor(Math.random() * room.players.length) : -1;
  room.rejected = 0;
  room.mission_team = [];
  room.mission_teams = [null, null, null, null, null];
  room.results = [null, null, null, null, null];
  room.winner = null;
  ai.Reset(room);
}

function IsProposalMeta(k) {
  return k == 'text' || k == 'who' || k == 'by' || k == 'round' || k == 'team' || k == 'auto';
}

function ProposalVotes(room) {
  var count = 0;
  for (var k in room.current_proposal) {
    if (!IsProposalMeta(k)) ++count;
  }
  return count;
}

function AdvanceLeader(room) {
  if (room.players.length == 0) return;
  room.leader = (room.leader + 1) % room.players.length;
}

function LeaderPid(room) {
  return room.players[room.leader];
}

function ApproveProposal(room) {
  room.proposals.push(room.current_proposal);
  room.mission_team = room.current_proposal.team;
  room.mission_teams[room.current_proposal.round] = room.current_proposal.team;
  room.phase = 'mission';
  room.rejected = 0;
  room.current_proposal = {};
  AdvanceLeader(room);
}

function FinishProposal(room) {
  var yes = 0;
  var all = 0;
  for (var k in room.current_proposal) {
    if (IsProposalMeta(k)) continue;
    ++all;
    if (room.current_proposal[k] == 1) ++yes;
  }
  if (yes > all / 2.0) {
    ApproveProposal(room);
  } else {
    room.proposals.push(room.current_proposal);
    room.current_proposal = {};
    room.rejected++;
    room.phase = 'proposal';
    AdvanceLeader(room);
  }
}

function FinishMission(room, round) {
  var fails = 0;
  for (var v in room.votes[round]) {
    if (room.votes[round][v] == 0) ++fails;
  }
  // Mission 4 needs two fail votes when playing with 7 or more.
  var need = (room.n >= 7 && round == 3) ? 2 : 1;
  room.results[round] = fails < need ? 1 : 0;
  var resistance = 0;
  var spies = 0;
  for (var i = 0; i < 5; ++i) {
    if (room.results[i] == 1) ++resistance;
    else if (room.results[i] == 0) ++spies;
  }
  if (resistance >= 3) room.winner = 'resistance';
  else if (spies >= 3) room.winner = 'spies';
  room.mission_team = [];
  room.phase = room.winner == null ? 'proposal' : 'ended';
}

function CurrentRound(room) {
  // The current mission is the first one without a complete vote result.
  for (var i = 0; i < 5; ++i) {
    if (room.votes[i].length < param[room.n][i]) return i;
  }
  return -1;
}

function Shuffle(a) {
	for (var i = a.length - 1; i > 0; --i) {
    var r = Math.random();
		var j = Math.floor(r * (i + 1));
    var x = a[j];
    a[j] = a[i];
    a[i] = x;
	}
	return a;
}

function ObjLength(obj) {
  var n = 0;
  for (var i in obj) {
    ++n;
  }
  return n;
}

// Shared by the socket handlers and AI players so both follow the same rules.
function ProposeAction(room, pid, team) {
  if (room.id == 'Lobby') return false;
  if (room.n < 5 || room.n > 10) return false;
  if (room.phase != 'proposal') return false;
  if (room.players[room.leader] != pid) return false;
  var round = CurrentRound(room);
  if (round < 0) return false;
  if (!Array.isArray(team) || team.length != param[room.n][round]) return false;
  var picked = {};
  for (var i in team) {
    if (picked[team[i]] != undefined || room.players.indexOf(team[i]) < 0) return false;
    picked[team[i]] = 1;
  }
  // Store numbered labels so archived proposals stay readable after departures.
  var teamNames = [];
  for (var i in team) {
    teamNames.push((room.players.indexOf(team[i]) + 1) + '. ' + PlayerName(room, team[i]));
  }
  room.current_proposal = {'text': teamNames.join(', '), 'who': (room.players.indexOf(pid) + 1) + '. ' + PlayerName(room, pid), 'by': pid, 'round': round, 'team': team};
  var auto = false;
  if (room.rejected >= room.players.length) {
    // Everyone was rejected once, this proposal passes without a vote.
    room.current_proposal['auto'] = 1;
    auto = true;
    ApproveProposal(room);
  }
  ai.OnProposal(room, pid, team, round, auto);
  return true;
}

function ProposalVoteAction(room, pid, vote) {
  if (room.id == 'Lobby') return false;
  if (room.current_proposal['text'] == undefined) return false;
  if (room.players.indexOf(pid) < 0) return false;
  var round = room.current_proposal['round'];
  room.current_proposal[pid] = vote > 0 ? 1 : -1;
  var finished = false;
  var approved = false;
  if (ProposalVotes(room) == room.n) {
    FinishProposal(room);
    finished = true;
    approved = room.phase == 'mission';
  }
  ai.OnProposalVote(room, pid, round, finished, approved);
  return true;
}

function MissionVoteAction(room, pid, round, vote) {
  if (room.id == 'Lobby') return false;
  if (room.n < 5 || room.n > 10) return false;
  if (room.phase != 'mission') return false;
  if (round != CurrentRound(room)) return false;
  if (room.mission_team.indexOf(pid) < 0) return false;
  if (room.voted[round] == undefined) room.voted[round] = {};
  if (room.voted[round][pid] == undefined) {
    room.votes[round].push(vote > 0 ? 1 : 0);
    room.voters[round].push(pid);
    room.voted[round][pid] = vote > 0 ? 1 : 0;
  }
  var finished = false;
  if (room.votes[round].length == param[room.n][round]) {
    room.votes[round] = Shuffle(room.votes[round]);
    room.voters[round] = Shuffle(room.voters[round]);
    FinishMission(room, round);
    finished = true;
  }
  ai.OnMissionVote(room, pid, round, finished);
  return true;
}

function SurrenderAction(room, pid) {
  if (room.id == 'Lobby') return false;
  if (room.n < 5 || room.n > 10) return false;
  if (room.winner != null) return false;
  if (room.players.indexOf(pid) < 0) return false;
  if (room.roleByPid == undefined || room.roleByPid[pid] == undefined) return false;
  // The surrendering side loses, the other side wins.
  room.winner = room.roleByPid[pid] == 0 ? 'resistance' : 'spies';
  room.phase = 'ended';
  ai.OnSurrender(room, pid);
  return true;
}

function send_votes(room, socket) {
  if (room.n < 5 || room.n > 10) return;
  var data = {
    room: room.id,
    n: room.n,
    param: param[room.n],
    proposals: room.proposals,
    current_round: CurrentRound(room),
    phase: room.phase,
    leader: LeaderPid(room),
    rejected: room.rejected,
    mission_team: room.mission_team,
    mission_teams: room.mission_teams,
    results: room.results,
    winner: room.winner,
    fail_need: [1, 1, 1, room.n >= 7 ? 2 : 1, 1],
    players: PlayerList(room)
  };
  for (var i in room.votes) {
    if (room.votes[i].length == param[room.n][i]) {
      data[i] = {'votes': room.votes[i], 'voters': room.voters[i]};
    } else {
      data[i] = {'voten': room.votes[i].length};
    }
    data[i]['n'] = param[room.n][i];
    data[i]['voted'] = Object.keys(room.voted[i] || {});
  }
  var current = {}
  if (room.current_proposal['text'] != undefined) {
    for (var k in room.current_proposal) {
      if (IsProposalMeta(k)) current[k] = room.current_proposal[k];
      else current[k] = '0';
    }
  }
  data.proposal = current;
  if (socket != undefined) {
    socket.emit('votes', data);
  } else {
    for (var s in room.sockets) {
      room.sockets[s].emit('votes', data);
    }
  }
}

function GetRoom(socket) {
  if (socket.myroom != undefined && rooms[socket.myroom] != undefined)
    return rooms[socket.myroom];
  JoinRoom(socket, 'Lobby');
  return rooms['Lobby'];
}

function JoinRoom(socket, room_id) {
  if (room_id == undefined || rooms[room_id] == undefined) {
    return JoinRoom(socket, 'Lobby');
  }
  var room = rooms[room_id];
  if (room.id != 'Lobby' && room.n >= 5 && room.phase != 'ended' &&
      (room.players == undefined || room.players.indexOf(PlayerId(socket)) < 0)) {
    // A game is in progress: only its players may (re)join.
    console.log('DENY', socket.id, room_id);
    return JoinRoom(socket, 'Lobby');
  }
  socket.join(room_id);
  if (socket.pid != undefined) {
    if (room.order == undefined) room.order = [];
    if (room.order.indexOf(socket.pid) < 0) room.order.push(socket.pid);
  }
  room.sockets[socket.id] = socket;
  socket.myroom = room_id;
  console.log('JOIN', socket.id, socket.myroom);
  SendJoin(socket);
  chat.Send(room, socket);
  return room;
}

function LeaveRoom(socket) {
  if (socket.myroom != undefined) {
    var room = GetRoom(socket);
    console.log('LEAVE', socket.id, room.id);
    socket.leave(socket.myroom);
    delete room.sockets[socket.id];
    if (ObjLength(room.sockets) == 0) {
      // Keep the empty room for a grace period so a reconnect can still
      // join it; DeleteEmptyRooms sweeps it away later.
      room.last_time = new Date();
      console.log('EMPTYROOM', room.id, room.last_time);
    }
    SendJoin(socket);
    socket.myroom = null;
  }
}

var EMPTY_ROOM_EXPIRY = 1000 * 60 * 60 * 5;  // 5 hours
var CHECK_INTERVAL = 1000 * 60 * 30;  // 30 minute
function DeleteEmptyRooms() {
  console.log('DLETEEMPTYROOM');
  var room_list = [];
  for (var r in rooms) {
    if (r == 'Lobby') continue;
    room_list.push(r);
  }
  var now = new Date();
  for (var i in room_list) {
    var room = rooms[room_list[i]];
    if (ObjLength(room.sockets) != 0) continue;
    if (now - room.last_time > EMPTY_ROOM_EXPIRY) {
      console.log('DELROOM', room_list[i]);
      delete rooms[room_list[i]];
    }
  }
}

setInterval(DeleteEmptyRooms, CHECK_INTERVAL);

function SendJoinRoom(room) {
  io.to(room.id).emit('join', {'players': PlayerList(room), 'room': room.id});
}

function SendJoin(socket) {
  SendJoinRoom(GetRoom(socket));
}

io.on('connect', function(socket) {
  console.log('New IO connection.', socket.handshake.address);
  chat.Setup(socket, io, GetRoom, PlayerId, ai.OnChat);
  ai.Setup(socket, io, {
    GetRoom: GetRoom,
    PlayerId: PlayerId,
    PlayerList: PlayerList,
    Param: param,
    CurrentRound: CurrentRound,
    ProposeAction: ProposeAction,
    ProposalVoteAction: ProposalVoteAction,
    MissionVoteAction: MissionVoteAction,
    BroadcastJoin: SendJoinRoom,
    SendVotes: send_votes
  });

  socket.on('disconnect', function() {
    LeaveRoom(socket);
  });

  socket.on('me', function(data) {
    socket.name = ClampEscapedName(data.name);
    socket.pid = data.pid;
    var room = JoinRoom(socket, data.room);
    if (room.names == undefined) room.names = {};
    room.names[PlayerId(socket)] = socket.name;
    // Broadcast the updated roster (name changes must reach everyone).
    SendJoin(socket);
    if (room.id != 'Lobby') send_votes(room);
  });
  socket.on('join', function(data) {
    if (data.room == socket.myroom) return;
    LeaveRoom(socket);
    var room = JoinRoom(socket, data.room);
    if (room.id != 'Lobby') send_votes(room, socket);
  });
  socket.on('create', function(data) {
    var room_id = CreateRoom();
    if (room_id == null) return;
    LeaveRoom(socket);
    var room = JoinRoom(socket, room_id);
    if (room.id != 'Lobby') send_votes(room, socket);
  });
  socket.on('leave', function(data) {
    if (socket.myroom == 'Lobby') return;
    LeaveRoom(socket);
    var room = JoinRoom(socket, 'Lobby');
    if (room.id != 'Lobby') send_votes(room, socket);
  });
  socket.on('start', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    var n = PlayerList(room).length;
    if (n < 5 || n > 10) return;
    console.log('start', n);
    RoomStart(room, n);
    send_votes(room);
    var roles = [];
    for (var i = 0; i < param[n][5]; ++i) roles.push(0);
    while (roles.length < n) roles.push(1);
    roles = Shuffle(roles);
    var roleByPid = {};
    var spys = [];
    var list = PlayerList(room);
    for (var i = 0; i < list.length; ++i) {
      roleByPid[list[i].pid] = roles[i];
      if (roles[i] == 0) spys.push({pid: list[i].pid, name: list[i].name, number: i + 1});
    }
    room.roleByPid = roleByPid;
    for (var s in room.sockets) {
      var role = roleByPid[PlayerId(room.sockets[s])];
      room.sockets[s].role = role;
      if (role == 0) {
        room.sockets[s].emit('role', {'role': role, 'spys': spys});
      } else {
        room.sockets[s].emit('role', {'role': role});
      }
    }
    ai.OnStart(room);
  });
  socket.on('vote', function(data) {
    var room = GetRoom(socket);
    if (data == undefined) return;
    if (MissionVoteAction(room, PlayerId(socket), data.round, data.vote)) {
      console.log('vote', data);
      send_votes(room);
    }
  });
  socket.on('clearvote', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    if (room.n < 5 || room.n > 10) return;
    if (room.phase != 'mission') return;
    if (data.round != CurrentRound(room)) return;
    if (room.mission_team.indexOf(PlayerId(socket)) < 0) return;
    console.log('clearvote', data);
    room.votes[data.round] = [];
    room.voters[data.round] = [];
    room.voted[data.round] = {};
    send_votes(room);
  });
  socket.on('propose', function(data) {
    var room = GetRoom(socket);
    if (data == undefined) return;
    if (ProposeAction(room, PlayerId(socket), data.team)) {
      send_votes(room);
    }
  });
  socket.on('yes', function(data) {
    var room = GetRoom(socket);
    if (ProposalVoteAction(room, PlayerId(socket), 1)) {
      send_votes(room);
    }
  });
  socket.on('no', function(data) {
    var room = GetRoom(socket);
    if (ProposalVoteAction(room, PlayerId(socket), -1)) {
      send_votes(room);
    }
  });
  socket.on('surrender', function(data) {
    var room = GetRoom(socket);
    if (SurrenderAction(room, PlayerId(socket))) {
      console.log('surrender', PlayerId(socket), room.winner);
      send_votes(room);
    }
  });
});

var PORT = process.env.PORT || 18181;
server.listen(PORT, function() {
  var host = server.address().address
  var port = server.address().port
  console.log("Example app listening at http://%s:%s", host, port)
})

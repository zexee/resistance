var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser')
var fs = require('fs') // this engine requires the fs module
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
  // While a game is running the roster and numbers are frozen; otherwise they follow join order.
  if (room.players != undefined && room.n > 0 && room.winner == null) {
    for (var i = 0; i < room.players.length; ++i) {
      var pid = room.players[i];
      list.push({pid: pid, name: PlayerName(room, pid), online: IsOnline(room, pid), number: i + 1});
    }
    return list;
  }
  var seen = {};
  var order = room.order != undefined ? room.order : [];
  for (var i = 0; i < order.length; ++i) {
    var pid = order[i];
    if (seen[pid] || !IsOnline(room, pid)) continue;
    seen[pid] = 1;
    list.push({pid: pid, name: PlayerName(room, pid), online: true, number: list.length + 1});
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
}

function IsProposalMeta(k) {
  return k == 'text' || k == 'who' || k == 'round' || k == 'team' || k == 'auto';
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
  return room;
}

function LeaveRoom(socket) {
  if (socket.myroom != undefined) {
    var room = GetRoom(socket);
    console.log('LEAVE', socket.id, room.id);
    socket.leave(socket.myroom);
    delete room.sockets[socket.id];
    if (ObjLength(room.sockets) == 0) {
      if (room.n == 0) {
        // No game and no user, delete the room.
        console.log('DELROOM', socket.myroom);
        delete rooms[socket.myroom];
      } else {
        // There is a game, keep the room for a time.
        room.last_time = new Date();
        console.log('EMPTYROOM', room.last_time);
      }
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

function SendJoin(socket) {
  var room = GetRoom(socket);
  io.to(socket.myroom).emit('join', {'players': PlayerList(room), 'room': room.id});
}

io.on('connect', function(socket) {
  console.log('New IO connection.', socket.handshake.address);

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
      if (roles[i] == 0) spys.push(list[i].name);
    }
    for (var s in room.sockets) {
      var role = roleByPid[PlayerId(room.sockets[s])];
      room.sockets[s].role = role;
      if (role == 0) {
        room.sockets[s].emit('role', {'role': role, 'spys': spys});
      } else {
        room.sockets[s].emit('role', {'role': role});
      }
    }
  });
  socket.on('vote', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    if (room.n < 5 || room.n > 10) return;
    if (room.phase != 'mission') return;
    if (data.round != CurrentRound(room)) return;
    var pid = PlayerId(socket);
    if (room.mission_team.indexOf(pid) < 0) return;
    console.log('vote', data);
    if (room.voted[data.round] == undefined) room.voted[data.round] = {};
    if (room.voted[data.round][pid] == undefined) {
      room.votes[data.round].push(data.vote);
      room.voters[data.round].push(pid);
      room.voted[data.round][pid] = data.vote;
    }
    if (room.votes[data.round].length == param[room.n][data.round]) {
			room.votes[data.round] = Shuffle(room.votes[data.round]);
			room.voters[data.round] = Shuffle(room.voters[data.round]);
      FinishMission(room, data.round);
    }
    send_votes(room);
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
    if (room.id == 'Lobby') return;
    if (room.n < 5 || room.n > 10) return;
    if (room.phase != 'proposal') return;
    if (room.players[room.leader] != PlayerId(socket)) return;
    var round = CurrentRound(room);
    if (round < 0) return;
    var team = data.team;
    if (!Array.isArray(team) || team.length != param[room.n][round]) return;
    var picked = {};
    for (var i in team) {
      if (picked[team[i]] != undefined || room.players.indexOf(team[i]) < 0) return;
      picked[team[i]] = 1;
    }
    var teamNames = [];
    for (var i in team) {
      teamNames.push(PlayerName(room, team[i]));
    }
    room.current_proposal = {'text': teamNames.join(', '), 'who': socket.name, 'round': round, 'team': team};
    if (room.rejected >= room.players.length) {
      // Everyone was rejected once, this proposal passes without a vote.
      room.current_proposal['auto'] = 1;
      ApproveProposal(room);
    }
    send_votes(room);
  });
  socket.on('yes', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    if (room.current_proposal['text'] == undefined) return;
    if (room.players.indexOf(PlayerId(socket)) < 0) return;
    room.current_proposal[PlayerId(socket)] = 1;
    if (ProposalVotes(room) == room.n) {
      FinishProposal(room);
    }
    send_votes(room);
  });
  socket.on('no', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    if (room.current_proposal['text'] == undefined) return;
    if (room.players.indexOf(PlayerId(socket)) < 0) return;
    room.current_proposal[PlayerId(socket)] = -1;
    if (ProposalVotes(room) == room.n) {
      FinishProposal(room);
    }
    send_votes(room);
  });
});

var PORT = process.env.PORT || 7777;
server.listen(PORT, function() {
  var host = server.address().address
  var port = server.address().port
  console.log("Example app listening at http://%s:%s", host, port)
})

var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser')
var fs = require('fs') // this engine requires the fs module
app.engine('ntl', function (filePath, options, callback) { // define the template engine
  fs.readFile(filePath, function (err, content) {
    if (err) return callback(err)
    // this is an extremely simple template engine
    var rendered = content.toString()
      .replace('#name#', options.name)
      .replace('#room#', options.room)
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
    name: req.cookies.name ? '"' + req.cookies.name + '"': null,
    room: req.cookies.room ? '"' + req.cookies.room + '"': null})
})

app.post('/setname', function (req, res) {
  var name = req.body.name;
  var room = req.body.room;
  res.cookie('name', name, {maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true});
  res.cookie('room', room, {maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true});
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
  do {
    room_id = '';
    for (var i = 0; i < ROOM_ID_LEN; ++i) {
      room_id += ROOM_ID_PICK[Math.floor(Math.random() * ROOM_ID_PICK.length)];
    }
  } while (rooms[room_id] != undefined);
  rooms[room_id] = {
    id: room_id,
    sockets: {}
  };
  RoomStart(rooms[room_id], 0);
  return room_id;
}

function RoomStart(room, n) {
  room.n = n;
  room.votes = [[], [], [], [], []];
  room.voters = [[], [], [], [], []];
  room.proposals = [];
  room.current_proposal = {};
}

function shuffle(a) {
	for (var i = a.length - 1; i > 0; --i) {
    var r = Math.random();
		var j = Math.floor(r * (i + 1));
    var x = a[j];
    a[j] = a[i];
    a[i] = x;
	}
	return a;
}

function objlength(obj) {
  var n = 0;
  for (var i in obj) {
    ++n;
  }
  return n;
}

function send_votes(room) {
  if (room.n < 5 || room.n > 10) return;
  var data = {
    room: room.id,
    n: room.n,
    param: param[room.n],
    proposals: room.proposals
  };
  for (var i in room.votes) {
    if (room.votes[i].length == param[room.n][i]) {
      data[i] = {'votes': room.votes[i], 'voters': room.voters[i]};
    } else {
      data[i] = {'voten': room.votes[i].length};
    }
    data[i]['n'] = param[room.n][i];
  }
  var current = {}
  if (room.current_proposal['text'] != undefined) {
    for (var k in room.current_proposal) {
      if (k == 'text' || k == 'who') current[k] = room.current_proposal[k];
      else current[k] = '0';
    }
  }
  data.proposal = current;
  console.log('SEND', data);
  for (var s in room.sockets) {
    room.sockets[s].emit('votes', data);
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
  socket.join(room_id);
  var room = rooms[room_id];
  room.sockets[socket.id] = socket;
  socket.myroom = room_id;
  console.log('JOIN', socket.id, socket.myroom);
  return room;
}

function LeaveRoom(socket) {
  if (socket.myroom != undefined) {
    var room = GetRoom(socket);
    console.log('LEAVE', socket.id, room.id);
    socket.leave(socket.myroom);
    delete room.sockets[socket.id];
  }
}

function send_room(socket) {
  var names = [];
  var room = GetRoom(socket);
  for (var i in room.sockets) {
    if (room.sockets[i].name != undefined)
      names.push(room.sockets[i].name);
    else
      names.push('SOMEONE');
  }
  io.to(socket.myroom).emit('join', {'names': names, 'room': room.id});
}

io.on('connect', function(socket) {
  console.log('New IO connection.', socket.request.connection.remoteAddress);
  socket.voted = {};

  socket.on('disconnect', function() {
    LeaveRoom(socket);
  });

  socket.on('me', function(data) {
    socket.name = data.name;
    JoinRoom(socket, data.room);
    send_room(socket);
  });
  socket.on('join', function(data) {
    LeaveRoom(socket);
    JoinRoom(socket, data.room);
    send_room(socket);
  });
  socket.on('create', function(data) {
    LeaveRoom(socket);
    JoinRoom(socket, CreateRoom());
    send_room(socket);
  });
  socket.on('leave', function(data) {
    LeaveRoom(socket);
    JoinRoom(socket, 'Lobby');
    send_room(socket);
  });
  socket.on('start', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    n = objlength(room.sockets);
    if (n < 5 || n > 10) return;
    console.log('start', n);
    RoomStart(room, n);
    send_votes(room);
    var roles = [];
    for (var i = 0; i < param[n][5]; ++i) roles.push(0);
    while (roles.length < n) roles.push(1);
    roles = shuffle(roles);
    var spys = [];
    var i = 0;
    for (var s in room.sockets) {
      room.sockets[s].voted = {};
      room.sockets[s].role = roles[i];
      if (roles[i] == 0) spys.push(room.sockets[s].name);
      ++i;
    }
    for (var s in room.sockets) {
      if (room.sockets[s].role == 0) {
        room.sockets[s].emit('role', {'role': room.sockets[s].role, 'spys': spys});
      } else {
        room.sockets[s].emit('role', {'role': room.sockets[s].role});
      }
    }
  });
  socket.on('vote', function(data) {
    var room = GetRoom(socket);
    console.log('VOTE', room);
    if (room.id == 'Lobby') return;
    if (room.n < 5 || room.n > 10) return;
    if (room.votes[data.round].length == param[room.n][data.round]) return;
    console.log('vote', data);
    if (socket.voted[data.round] == undefined) {
      room.votes[data.round].push(data.vote);
      room.voters[data.round].push(socket.name);
      socket.voted[data.round] = data.vote;
    }
    if (room.votes[data.round].length == param[n][data.round]) {
			room.votes[data.round] = shuffle(room.votes[data.round]);
			room.voters[data.round] = shuffle(room.voters[data.round]);
    }
    send_votes(room);
  });
  socket.on('clearvote', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    if (room.n < 5 || room.n > 10) return;
    if (room.votes[data.round].length == param[room.n][data.round]) return;
    console.log('clearvote', data);
    room.votes[data.round] = [];
    room.voters[data.round] = [];
    for (var s in room.sockets) {
      delete room.sockets[s].voted[data.round];
    }
    send_votes(room);
  });
  socket.on('propose', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    room.current_proposal = {'text': data.text, 'who': socket.name};
    send_votes(room);
  });
  socket.on('yes', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    room.current_proposal[socket.name] = 1;
    if (objlength(room.current_proposal) == n + 2) {
      room.proposals.push(room.current_proposal);
      room.current_proposal = {};
    }
    send_votes(room);
  });
  socket.on('no', function(data) {
    var room = GetRoom(socket);
    if (room.id == 'Lobby') return;
    room.current_proposal[socket.name] = -1;
    if (objlength(room.current_proposal) == n + 2) {
      room.proposals.push(room.current_proposal);
      room.current_proposal = {};
    }
    send_votes(room);
  });
});

server.listen(7777, function() {
  var host = server.address().address
  var port = server.address().port
  console.log("Example app listening at http://%s:%s", host, port)
})

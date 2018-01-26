const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

app.use(express.static(__dirname + '/public'));

votes = [[], [], [], [], []];
var param = {
  5: [2, 3, 2, 3, 3, 2],
  6: [2, 3, 4, 3, 4, 2],
  7: [2, 3, 3, 4, 4, 3],
  8: [3, 4, 4, 5, 5, 3],
  9: [3, 4, 4, 5, 5, 3],
  10: [3, 4, 4, 5, 5, 4]
};
var n = 0;

function shuffle(a) {
	for (var i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
    var x = a[j];
    a[j] = a[i];
    a[i] = x;
	}
	return a;
}

function send_votes(socket) {
  if (n < 5 || n > 10) return;
  var data = {'n': n, param: param[n]};
  for (var i in votes) {
    if (votes[i].length == param[n][i]) {
      data[i] = {'votes':votes[i]};
    } else {
      data[i] = {'voten':votes[i].length};
    }
    data[i]['n'] = param[n][i];
  }
  socket.emit('votes', data);
}

function objlength(obj) {
  var n = 0;
  for (var i in obj) {
    ++n;
  }
  return n;
}

io.on('connect', function(socket) {
  console.log('New IO connection.', socket.request.connection.remoteAddress);
  socket.voted = {};
  io.sockets.emit('join', {'n': objlength(io.sockets.sockets)});
  send_votes(socket);
  socket.on('start', function(data) {
    n = objlength(io.sockets.sockets);
    if (n < 5 || n > 10) return;
    console.log('start', n);
    votes = [[], [], [], [], []];
    send_votes(io.sockets);
    var roles = [];
    for (var i = 0; i < param[n][5]; ++i) roles.push(0);
    while (roles.length < n) roles.push(1);
    roles = shuffle(roles);
    var i = 0;
    for (var s in io.sockets.sockets) {
      io.sockets.sockets[s].voted = {};
      io.sockets.sockets[s].emit('role', {'role': roles[i]});
      ++i;
    }
  });
  socket.on('vote', function(data) {
    if (n < 5 || n > 10) return;
    console.log('vote', data);
    if (socket.voted[data.round] == undefined) {
      votes[data.round].push(data.vote);
      socket.voted[data.round] = 1;
    }
    if (votes[data.round].length == param[n][data.round]) {
			votes[data.round] = shuffle(votes[data.round]);
    }
    send_votes(io.sockets);
  });
});

server.listen(7777, function() {
  var host = server.address().address
  var port = server.address().port
  console.log("Example app listening at http://%s:%s", host, port)
})

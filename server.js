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
    var rendered = content.toString().replace('#name#', options.name)
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
  res.render('index', { name: req.cookies.name ? '"' + req.cookies.name + '"': null })
})

app.post('/setname', function (req, res) {
  var name = req.body.name;
  res.cookie('name', name);
  res.json({ok:1});
})
app.use(express.static(__dirname + '/public'));

var votes = [[], [], [], [], []];
var voters = [[], [], [], [], []];
var param = {
  5: [2, 3, 2, 3, 3, 2],
  6: [2, 3, 4, 3, 4, 2],
  7: [2, 3, 3, 4, 4, 3],
  8: [3, 4, 4, 5, 5, 3],
  9: [3, 4, 4, 5, 5, 3],
  10: [3, 4, 4, 5, 5, 4]
};
var n = 0;
var proposals = [];
var current_proposal = {};

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

function send_votes(socket) {
  if (n < 5 || n > 10) return;
  var data = {'n': n, param: param[n]};
  for (var i in votes) {
    if (votes[i].length == param[n][i]) {
      data[i] = {'votes': votes[i], 'voters': voters[i]};
    } else {
      data[i] = {'voten': votes[i].length};
    }
    data[i]['n'] = param[n][i];
  }
  data.proposals = proposals;
  var current = {}
  if (current_proposal['text'] != undefined) {
    for (var k in current_proposal) {
      if (k == 'text' || k == 'who') current[k] = current_proposal[k];
      else current[k] = '0';
    }
  }
  data.proposal = current;
  socket.emit('votes', data);
}

io.on('connect', function(socket) {
  console.log('New IO connection.', socket.request.connection.remoteAddress);
  socket.voted = {};
  send_votes(socket);
  socket.on('me', function(data) {
    socket.name = data.name;
    var names = [];
    for (var i in io.sockets.sockets) {
      if (io.sockets.sockets[i]['name'] != undefined)
        names.push(io.sockets.sockets[i]['name']);
      else
        names.push('SOMEONE');
    }
    io.sockets.emit('join', {'names': names});
  });
  socket.on('start', function(data) {
    n = objlength(io.sockets.sockets);
    if (n < 5 || n > 10) return;
    console.log('start', n);
    votes = [[], [], [], [], []];
    voters = [[], [], [], [], []];
    proposals = [];
    current_proposals = {};
    send_votes(io.sockets);
    var roles = [];
    for (var i = 0; i < param[n][5]; ++i) roles.push(0);
    while (roles.length < n) roles.push(1);
    roles = shuffle(roles);
    var spys = [];
    var i = 0;
    for (var s in io.sockets.sockets) {
      io.sockets.sockets[s].voted = {};
      io.sockets.sockets[s].role = roles[i];
      if (roles[i] == 0) spys.push(io.sockets.sockets[s].name);
      ++i;
    }
    for (var s in io.sockets.sockets) {
      if (io.sockets.sockets[s].role == 0) {
        io.sockets.sockets[s].emit('role', {'role': io.sockets.sockets[s].role, 'spys': spys});
      } else {
        io.sockets.sockets[s].emit('role', {'role': io.sockets.sockets[s].role});
      }
    }
  });
  socket.on('vote', function(data) {
    if (n < 5 || n > 10) return;
    if (votes[data.round].length == param[n][data.round]) return;
    console.log('vote', data);
    if (socket.voted[data.round] == undefined) {
      votes[data.round].push(data.vote);
      voters[data.round].push(socket.name);
      socket.voted[data.round] = data.vote;
    }
    if (votes[data.round].length == param[n][data.round]) {
			votes[data.round] = shuffle(votes[data.round]);
			voters[data.round] = shuffle(voters[data.round]);
    }
    send_votes(io.sockets);
  });
  socket.on('propose', function(data) {
    current_proposal = {'text': data.text, 'who': socket.name};
    send_votes(io.sockets);
  });
  socket.on('yes', function(data) {
    current_proposal[socket.name] = 1;
    if (objlength(current_proposal) == n + 2) {
      proposals.push(current_proposal);
      current_proposal = {};
    }
    send_votes(io.sockets);
  });
  socket.on('no', function(data) {
    current_proposal[socket.name] = -1;
    if (objlength(current_proposal) == n + 2) {
      proposals.push(current_proposal);
      current_proposal = {};
    }
    send_votes(io.sockets);
  });
});

server.listen(7777, function() {
  var host = server.address().address
  var port = server.address().port
  console.log("Example app listening at http://%s:%s", host, port)
})

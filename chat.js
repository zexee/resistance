// Per-room group chat. Messages live on the room object so they are dropped
// together with the room (and on server restart), capped at CHAT_KEEP.

var CHAT_KEEP = 100;
var CHAT_TEXT_MAX = 200;

function ClampText(text) {
  if (text == undefined) return '';
  return String(text).slice(0, CHAT_TEXT_MAX);
}

function Trim(text) {
  return text.replace(/^\s+/, '').replace(/\s+$/, '');
}

function Send(room, socket) {
  // Send the history to one socket; used when a socket joins a room.
  if (socket == undefined) return;
  socket.emit('chatlog', {
    room: room.id,
    messages: room.chat != undefined ? room.chat : []
  });
}

function Setup(socket, io, GetRoom, PlayerId) {
  socket.on('chat', function(data) {
    var text = Trim(ClampText(data != undefined ? data.text : ''));
    if (text == '') return;
    var room = GetRoom(socket);
    if (room.chat == undefined) room.chat = [];
    var msg = {
      pid: PlayerId(socket),
      text: text,
      time: Date.now()
    };
    room.chat.push(msg);
    if (room.chat.length > CHAT_KEEP) {
      room.chat.splice(0, room.chat.length - CHAT_KEEP);
    }
    io.to(room.id).emit('chat', {room: room.id, message: msg});
  });
}

module.exports = {Send: Send, Setup: Setup};

// Client-side per-room chat panel. views/index.ntl calls InitChat(socket)
// once the Socket.IO connection is created.

(function() {
  var MAX_LOG = 100;
  var chatSocket = null;
  var chatRoom = null;
  var unread = 0;
  var collapsed = false;
  var knownNames = {};
  var messages = [];

  function EscapeHtml(s) {
    return $('<div/>').text(s == undefined ? '' : s).html();
  }

  function TimeLabel(ms) {
    var d = new Date(ms);
    var m = d.getMinutes();
    return d.getHours() + ':' + (m < 10 ? '0' + m : m);
  }

  function ScrollBottom() {
    var log = document.getElementById('chatlog');
    if (log != null) log.scrollTop = log.scrollHeight;
  }

  function SetUnread(n) {
    unread = n;
    if (unread > 0 && collapsed) $('#chatunread').text(unread).show();
    else $('#chatunread').hide();
  }

  function SetRoom(room) {
    if (room == null) return;
    chatRoom = room;
    $('#chatroom').text('- ' + room);
  }

  function CachePlayers(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; ++i) {
      var player = list[i];
      if (player != null && player.pid != undefined) {
        knownNames[player.pid] = PlayerLabel(player);
      }
    }
  }

  function SenderLabel(msg) {
    if (msg.pid != undefined) {
      // The cache is refreshed from every roster event, so it is never staler
      // than the page roster and still knows players that already left.
      if (knownNames[msg.pid] != undefined) return knownNames[msg.pid];
      if (typeof PlayerById == 'function') {
        var player = PlayerById(msg.pid);
        if (player != null) return PlayerLabel(player);
      }
    }
    return 'SOMEONE';
  }

  function MessageHtml(msg) {
    return '<div class="chatmsg">' +
      '<span class="chatwho">' + EscapeHtml(SenderLabel(msg)) + '</span>' +
      ' <span class="chattext">' + EscapeHtml(msg.text) + '</span>' +
      ' <span class="chattime">' + TimeLabel(msg.time) + '</span>' +
      '</div>';
  }

  function RenderLog() {
    var html = '';
    for (var i = 0; i < messages.length; ++i) {
      html += MessageHtml(messages[i]);
    }
    $('#chatlog').html(html);
    ScrollBottom();
  }

  function Append(msg) {
    messages.push(msg);
    if (messages.length > MAX_LOG) messages.splice(0, messages.length - MAX_LOG);
    RenderLog();
  }

  function Toggle() {
    collapsed = !collapsed;
    $('#chatpanel').toggleClass('collapsed', collapsed);
    $('#chattoggle i').attr('class', collapsed ? 'fa fa-chevron-up' : 'fa fa-chevron-down');
    if (!collapsed) {
      SetUnread(0);
      ScrollBottom();
    }
  }

  function Send() {
    var input = document.getElementById('chatinput');
    if (input == null || chatSocket == null) return;
    var text = input.value;
    if (text.replace(/\s/g, '') == '') return;
    chatSocket.emit('chat', {text: text});
    input.value = '';
    input.focus();
  }

  function Build() {
    if (document.getElementById('chatpanel') != null) return;
    $('body').append(
      '<div id="chatpanel">' +
        '<div id="chatheader">' +
          '<i class="fa fa-comments"></i> Chat <span id="chatroom" class="text-muted"></span> ' +
          '<span id="chatunread" class="label label-danger" style="display:none">0</span>' +
          '<button type="button" id="chattoggle" class="btn btn-xs btn-default pull-right">' +
            '<i class="fa fa-chevron-down"></i>' +
          '</button>' +
        '</div>' +
        '<div id="chatbody">' +
          '<div id="chatlog"></div>' +
          '<div id="chatsendrow" class="input-group input-group-sm">' +
            '<input type="text" id="chatinput" class="form-control" maxlength="200" placeholder="Say something...">' +
            '<span class="input-group-btn">' +
              '<button type="button" id="chatsend" class="btn btn-primary"><i class="fa fa-paper-plane"></i></button>' +
            '</span>' +
          '</div>' +
        '</div>' +
      '</div>');
    $('#chattoggle').on('click', Toggle);
    $('#chatsend').on('click', Send);
    $('#chatinput').on('keydown', function(e) {
      if (e.keyCode == 13) {
        e.preventDefault();
        Send();
      }
    });
    if (window.room != null) SetRoom(window.room);
  }

  window.InitChat = function(sock) {
    chatSocket = sock;
    Build();
    // Keep the last seen roster label per pid so history stays readable after
    // a player leaves; a live roster lookup still wins.
    sock.on('join', function(data) {
      if (data == undefined) return;
      CachePlayers(data.players);
      RenderLog();
    });
    sock.on('votes', function(data) {
      if (data == undefined) return;
      CachePlayers(data.players);
      RenderLog();
    });
    sock.on('chatlog', function(data) {
      if (data == undefined) return;
      SetRoom(data.room);
      messages = Array.isArray(data.messages) ? data.messages.slice(0) : [];
      if (messages.length > MAX_LOG) messages.splice(0, messages.length - MAX_LOG);
      RenderLog();
      SetUnread(0);
    });
    sock.on('chat', function(data) {
      if (data == undefined || data.message == undefined) return;
      if (chatRoom == null) SetRoom(data.room);
      if (chatRoom != data.room) return;
      Append(data.message);
      if (collapsed) SetUnread(unread + 1);
    });
  };
})();

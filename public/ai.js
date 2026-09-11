// Client-side AI player panel. views/index.ntl calls InitAi(socket) once the
// Socket.IO connection is created. The server owns every conversation; this
// file only renders controls and status and never sees an API key.

(function() {
  var aiSocket = null;
  var enabled = false;
  var models = [];
  var aiPlayers = [];
  var thinking = {};
  var errors = {};
  // Room state comes from the socket payloads: this module's handlers run
  // before index.ntl's, so window.room/started/winner can still be stale.
  var aiRoom = null;
  var aiStarted = false;
  var aiWinner = null;

  function EscapeHtml(s) {
    return $('<div/>').text(s == undefined ? '' : s).html();
  }

  function AttrEscape(s) {
    return EscapeHtml(s).replace(/"/g, '&quot;');
  }

  function RawName(name) {
    if (name == undefined) return '某人';
    try {
      return decodeURIComponent(name);
    } catch (e) {
      return name;
    }
  }

  function Label(player) {
    if (player == null) return '某人';
    return (player.number != undefined ? player.number + '. ' : '') + RawName(player.name);
  }

  function InRoom() {
    return typeof aiRoom == 'string' && aiRoom != '' && aiRoom != 'Lobby';
  }

  function CanEdit() {
    if (!InRoom()) return false;
    return !aiStarted || aiWinner != null;
  }

  function Build() {
    if (document.getElementById('aimodal') != null) return;
    var aiButton =
      '<button class="btn navbar-btn btn-info" id="aibtn" type="button" style="display:none">' +
        '<i class="fa fa-microchip"></i> 添加 AI' +
      '</button>';
    var rulesButton = $('.navbar-collapse button[data-target="#rules-modal"]');
    if (rulesButton.length) rulesButton.before(aiButton);
    else $('.navbar-collapse').append(aiButton);
    $('body').append(
      '<div class="modal fade" id="aimodal" tabindex="-1" role="dialog">' +
        '<div class="modal-dialog" role="document">' +
          '<div class="modal-content">' +
            '<div class="modal-header">' +
              '<button type="button" class="close" data-dismiss="modal" aria-label="关闭"><span aria-hidden="true">&times;</span></button>' +
              '<h4 class="modal-title"><i class="fa fa-microchip"></i> AI 玩家</h4>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="form-inline" style="margin-bottom:10px">' +
                '<select id="aimodel" class="form-control input-sm"></select> ' +
                '<button type="button" class="btn btn-primary btn-sm" id="aiaddbtn"><i class="fa fa-plus"></i> 添加 AI</button>' +
              '</div>' +
              '<p id="aihint" class="text-muted"></p>' +
              '<ul class="list-group" id="ailist"></ul>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="btn btn-default" data-dismiss="modal">关闭</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="aialerts" style="margin:10px 15px 0"></div>' +
      '<div id="aithinking" style="display:none"></div>'
    );
    $('#aibtn').on('click', function() {
      $('#aimodal').modal('show');
    });
    $('#aiaddbtn').on('click', function() {
      var id = $('#aimodel').val();
      if (id != null && aiSocket != null) aiSocket.emit('ai_add', {model: id});
    });
    $(document).on('click', '.airemove', function() {
      if (aiSocket != null) aiSocket.emit('ai_remove', {pid: $(this).data('pid')});
    });
    $(document).on('click', '.airetry', function() {
      if (aiSocket != null) aiSocket.emit('ai_retry', {pid: $(this).data('pid')});
    });
    $(document).on('click', '.aierrdismiss', function() {
      var pid = $(this).data('pid');
      delete errors[pid];
      Render();
    });
  }

  function ThinkingPlayer(pid) {
    for (var i = 0; i < aiPlayers.length; ++i) {
      if (aiPlayers[i].pid == pid) return aiPlayers[i];
    }
    return null;
  }

  function RenderThinking() {
    var names = [];
    var models = [];
    for (var pid in thinking) {
      var player = ThinkingPlayer(pid);
      names.push(player != null ? Label(player) : pid);
      if (player != null && player.model != undefined) models.push(player.model);
    }
    if (names.length == 0) {
      $('#aithinking').hide();
      return;
    }
    $('#aithinking')
      .attr('title', models.join(', '))
      .html('<i class="fa fa-spinner fa-spin"></i> AI 思考中：' + EscapeHtml(names.join('、')))
      .show();
  }

  function RenderErrors() {
    var html = '';
    for (var pid in errors) {
      var e = errors[pid];
      var kind = e.kind == 'timeout' ? '超时' : '错误';
      html += '<div class="alert alert-danger" role="alert">' +
        '<strong>' + EscapeHtml(e.name) + '</strong> 调用失败（' + kind + '）：' + EscapeHtml(e.message) +
        ' <button type="button" class="btn btn-xs btn-default airetry" data-pid="' + EscapeHtml(pid) + '">' +
          '<i class="fa fa-refresh"></i> 重试</button>' +
        '<button type="button" class="close aierrdismiss" data-pid="' + EscapeHtml(pid) + '"><span>&times;</span></button>' +
        '</div>';
    }
    $('#aialerts').html(html);
  }

  function Render() {
    if (document.getElementById('aimodal') == null) return;
    if (!enabled) {
      $('#aibtn').hide();
      return;
    }
    $('#aibtn').toggle(InRoom());
    var opts = '';
    for (var i = 0; i < models.length; ++i) {
      opts += '<option value="' + EscapeHtml(models[i].id) + '">' + EscapeHtml(models[i].label) + '</option>';
    }
    if ($('#aimodel').html() != opts) $('#aimodel').html(opts);
    var canEdit = CanEdit();
    $('#aiaddbtn').prop('disabled', !canEdit);
    $('#aimodel').prop('disabled', !canEdit);
    if (!InRoom()) $('#aihint').text('加入房间后才能添加 AI 玩家。');
    else if (!canEdit) $('#aihint').text('AI 玩家只能在游戏开始前添加或移除。');
    else $('#aihint').text('AI 玩家通过已配置的模型进行行动。');
    var html = '';
    for (var i = 0; i < aiPlayers.length; ++i) {
      var p = aiPlayers[i];
      html += '<li class="list-group-item" title="' + AttrEscape(p.model != undefined ? p.model : 'AI') + '">' +
        '<i class="fa fa-microchip text-info"></i> ' + EscapeHtml(Label(p));
      if (thinking[p.pid]) {
        html += ' <i class="fa fa-spinner fa-spin text-muted" title="思考中"></i>';
      }
      if (errors[p.pid]) {
        html += ' <span class="label label-danger">出错</span>';
      }
      if (canEdit) {
        html += ' <button type="button" class="btn btn-xs btn-danger pull-right airemove" data-pid="' + EscapeHtml(p.pid) + '">移除</button>';
      }
      html += '</li>';
    }
    if (aiPlayers.length == 0) {
      html = '<li class="list-group-item text-muted">暂无 AI 玩家。</li>';
    }
    $('#ailist').html(html);
    RenderErrors();
    RenderThinking();
  }

  function UpdatePlayers(list) {
    if (!Array.isArray(list)) return;
    aiPlayers = [];
    for (var i = 0; i < list.length; ++i) {
      if (list[i].ai) aiPlayers.push(list[i]);
    }
    Render();
  }

  window.InitAi = function(sock) {
    aiSocket = sock;
    Build();
    sock.on('ai_models', function(data) {
      if (data == undefined) return;
      enabled = !!data.enabled;
      models = Array.isArray(data.models) ? data.models : [];
      Render();
    });
    sock.on('join', function(data) {
      if (data == undefined) return;
      if (aiRoom != data.room) {
        aiStarted = false;
        aiWinner = null;
        thinking = {};
      }
      aiRoom = data.room;
      UpdatePlayers(data.players);
      sock.emit('ai_state');
    });
    sock.on('ai_state', function(data) {
      if (data == undefined) return;
      thinking = {};
      if (Array.isArray(data.thinking)) {
        for (var i = 0; i < data.thinking.length; ++i) thinking[data.thinking[i]] = 1;
      }
      Render();
    });
    sock.on('votes', function(data) {
      if (data == undefined) return;
      aiRoom = data.room;
      aiStarted = true;
      aiWinner = data.winner;
      UpdatePlayers(data.players);
    });
    sock.on('ai_thinking', function(data) {
      if (data == undefined || data.pid == undefined) return;
      if (data.on) thinking[data.pid] = 1;
      else delete thinking[data.pid];
      Render();
    });
    sock.on('ai_error', function(data) {
      if (data == undefined || data.pid == undefined) return;
      if (data.error) errors[data.pid] = {kind: data.kind, message: data.message, name: data.name};
      else delete errors[data.pid];
      Render();
    });
  };
})();

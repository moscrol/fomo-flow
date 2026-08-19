  // Codex file review. The extension host owns filesystem access; this view only renders state.
  var _codexChangesState = null;
  var _codexChangesRequest = function() { if (_vscode) _vscode.postMessage({ type: 'codexChangesGet' }); };
  function _codexChangesEl(id) { return document.getElementById(id); }
  function _codexChangesPost(type, id) {
    if (_vscode) _vscode.postMessage({ type: type, id: id || '' });
  }
  function _codexChangesPhase(state) {
    if (!state) return '未捕获';
    if (state.indexing) return '正在建立基线';
    if (state.active) return '自动捕获中';
    if (state.phase === 'stopped') return '已暂停 · 可审阅';
    return state.phase === 'idle' ? '未捕获' : state.phase;
  }
  function _codexChangesRender(state, message) {
    state = state || {};
    _codexChangesState = state;
    var phase = _codexChangesEl('codexChangesPhase');
    var summary = _codexChangesEl('codexChangesSummary');
    var roots = _codexChangesEl('codexChangesRoots');
    var notice = _codexChangesEl('codexChangesNotice');
    var list = _codexChangesEl('codexChangesList');
    var start = _codexChangesEl('codexChangesStart');
    var stop = _codexChangesEl('codexChangesStop');
    var reset = _codexChangesEl('codexChangesReset');
    var acceptAll = _codexChangesEl('codexChangesAcceptAll');
    var rejectAll = _codexChangesEl('codexChangesRejectAll');
    if (!phase || !summary || !list) return;
    phase.textContent = _codexChangesPhase(state);
    var totals = state.totals || { files: 0, additions: 0, deletions: 0 };
    summary.textContent = totals.files + ' 个文件  +' + totals.additions + '  -' + totals.deletions;
    roots.textContent = state.roots && state.roots.length
      ? '工作区：' + state.roots.join('  ·  ')
      : '当前没有文件工作区';
    notice.className = 'codex-change-notice';
    if (message && message.error) {
      notice.className += ' error';
      notice.textContent = message.error;
    } else if (state.warning) {
      notice.className += ' warn';
      notice.textContent = state.warning;
    } else if (state.indexing) {
      notice.textContent = '正在异步建立基线，完成后自动记录 Codex、Devin 和其他外部写盘变更。';
    } else if (state.active) {
      notice.textContent = '自动捕获已开启；停止捕获后再执行回退可避免覆盖后续编辑。';
    } else if (state.phase === 'stopped') {
      notice.textContent = '捕获已暂停，当前差异已冻结；接受会保留文件，回退会恢复基线。';
    } else {
      notice.textContent = '工作区打开后会自动建立基线，无需手动开始。';
    }
    start.disabled = !!state.active || !!state.indexing;
    start.textContent = state.active ? '捕获中' : '继续捕获';
    stop.disabled = !state.active && !state.indexing;
    reset.disabled = !!state.indexing;
    acceptAll.disabled = !totals.files;
    rejectAll.disabled = !totals.files || !!state.active || !!state.indexing;
    while (list.firstChild) list.removeChild(list.firstChild);
    var changes = Array.isArray(state.changes) ? state.changes : [];
    if (!changes.length) {
      var empty = document.createElement('div');
      empty.className = 'codex-change-empty';
      empty.textContent = state.indexing ? '正在建立基线…' : '暂无捕获到的文件变更';
      list.appendChild(empty);
      return;
    }
    changes.forEach(function(change) {
      var row = document.createElement('div');
      row.className = 'codex-change-row';
      var code = document.createElement('span');
      code.className = 'codex-change-code ' + ({ A: 'added', M: 'modified', D: 'deleted', '?': 'unknown' }[change.status] || 'modified');
      code.textContent = change.status || 'M';
      var pathButton = document.createElement('button');
      pathButton.className = 'codex-change-path';
      pathButton.type = 'button';
      pathButton.title = change.filePath || change.relativePath || '';
      pathButton.textContent = change.relativePath || change.filePath || '(unknown file)';
      pathButton.addEventListener('click', function() { _codexChangesPost('codexChangesOpen', change.id); });
      var stats = document.createElement('span');
      stats.className = 'codex-change-stats';
      stats.title = '磁盘哈希：' + (change.fingerprint || '未记录')
        + '；来源：' + ((change.sources || ['filesystem']).join(', '));
      var sync = document.createElement('span');
      sync.className = 'codex-change-sync ' + (change.syncStatus === 'disk-verified' ? 'verified' : 'stale');
      sync.textContent = change.syncStatus === 'disk-verified' ? 'SYNC' : 'STALE';
      var added = document.createElement('span');
      added.className = 'codex-change-additions';
      added.textContent = '+' + (change.additions || 0);
      var deleted = document.createElement('span');
      deleted.className = 'codex-change-deletions';
      deleted.textContent = '-' + (change.deletions || 0);
      stats.appendChild(sync); stats.appendChild(added); stats.appendChild(deleted);
      var actions = document.createElement('span');
      actions.className = 'codex-change-actions';
      var accept = document.createElement('button');
      accept.className = 'btn add'; accept.type = 'button'; accept.textContent = '接受';
      accept.addEventListener('click', function() { _codexChangesPost('codexChangesAccept', change.id); });
      var reject = document.createElement('button');
      reject.className = 'btn del'; reject.type = 'button'; reject.textContent = '回退';
      reject.disabled = !!state.active || !!state.indexing || !change.beforeAvailable;
      reject.title = change.beforeAvailable ? '恢复捕获前内容' : '没有可用的捕获前内容';
      reject.addEventListener('click', function() {
        _daoConfirm('回退 ' + (change.relativePath || change.filePath) + '？').then(function(yes) {
          if (yes) _codexChangesPost('codexChangesReject', change.id);
        });
      });
      actions.appendChild(accept); actions.appendChild(reject);
      row.appendChild(code); row.appendChild(pathButton); row.appendChild(stats); row.appendChild(actions);
      list.appendChild(row);
    });
  }
  window.addEventListener('message', function(event) {
    var data = event && event.data;
    if (!data || data.type !== 'codexChangesState') return;
    _codexChangesRender(data.state || {}, data);
  });
  var _ccStart = _codexChangesEl('codexChangesStart');
  var _ccStop = _codexChangesEl('codexChangesStop');
  var _ccReset = _codexChangesEl('codexChangesReset');
  var _ccAcceptAll = _codexChangesEl('codexChangesAcceptAll');
  var _ccRejectAll = _codexChangesEl('codexChangesRejectAll');
  if (_ccStart) _ccStart.addEventListener('click', function() { _codexChangesPost('codexChangesStart'); });
  if (_ccStop) _ccStop.addEventListener('click', function() { _codexChangesPost('codexChangesStop'); });
  if (_ccReset) _ccReset.addEventListener('click', function() {
    _daoConfirm('重建基线会清除当前审阅列表，是否继续？').then(function(yes) {
      if (yes) _codexChangesPost('codexChangesReset');
    });
  });
  if (_ccAcceptAll) _ccAcceptAll.addEventListener('click', function() { _codexChangesPost('codexChangesAcceptAll'); });
  if (_ccRejectAll) _ccRejectAll.addEventListener('click', function() {
    _daoConfirm('回退当前列表中的全部文件变更？').then(function(yes) {
      if (yes) _codexChangesPost('codexChangesRejectAll');
    });
  });
  _codexChangesRequest();

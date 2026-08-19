  var _brgS = null;
  var _brgPoll = null;
  function _brgEl(id) { return document.getElementById(id); }
  function _brgSet(id, t) { var e = _brgEl(id); if (e) e.textContent = t; }
  function _brgApply(d) {
    _brgS = d || {};
    var running = !!d.running, url = d.url || '';
    var state = _brgEl('brgState');
    if (state) {
      if (running && url) { state.textContent = '● 已连通'; state.style.color = '#3fb950'; }
      else if (running) { state.textContent = '◌ 连接中…'; state.style.color = '#d29922'; }
      else { state.textContent = '○ 未连接'; state.style.color = ''; }
    }
    _brgSet('brgMode', running ? (d.shared ? '复用归一🌐板块共享隧道' : (d.named ? '命名隧道·固定域名' : '快速隧道·零账号')) : '');
    // v9.9.348: 退避/宽限状态细化展示
    var statText = running ? (url ? '● 公网已暴露' : '◌ 隧道启动中') : '○ 未启动';
    if (d.backoff > 0) statText = '⏸ 退避中(' + d.backoff + 's·连续失败' + (d.spawnFails||0) + '次)';
    else if (d.graceRemaining > 0) statText = '◌ 注册中(宽限' + d.graceRemaining + 's)';
    _brgSet('brgStat', statText);
    _brgSet('brgUrl', url || '—');
    _brgSet('brgBound', '本地反代端口: ' + (d.boundPort || d.localPort || '—') + (d.bin ? ' · cloudflared: 已就绪' : ' · cloudflared: 未安装(启动时自动拉取)'));
    _brgSet('brgPubBase', d.publicBase || '—');
    _brgSet('brgPubChat', d.publicChat || '—');
    _brgSet('brgPubResponses', d.publicResponses || '—');
    _brgSet('brgPubMsg', d.publicMessages || '—');
    _brgSet('brgPubGemini', d.publicGemini || '—');
    _brgSet('brgPubModels', d.publicModels || '—');
    _brgSet('brgCfState', d.cfLoggedIn ? ('已保存 Cloudflare 凭证' + (d.cfEmail ? ' (' + d.cfEmail + ')' : '') + (d.named ? ' · 命名隧道 Token 就绪' : '')) : '未登录 Cloudflare (默认走零账号快速隧道)');
    // workers.dev 固定中继(持久通道)状态
    var rel = d.relay || {};
    if (rel.bound) {
      _brgSet('brgRelayState', (rel.connected ? '● workers.dev 固定中继 · 已上线(持久通道)' : '◌ workers.dev 固定中继 · 连接中' + (rel.lastErr ? ' (' + rel.lastErr + ')' : '')));
      var rs = _brgEl('brgRelayState'); if (rs) rs.style.color = rel.connected ? '#3fb950' : '#d29922';
      _brgSet('brgRelayUrl', rel.publicUrl ? ('固定公网入口: ' + rel.publicUrl) : '');
    } else {
      _brgSet('brgRelayState', '未绑定 API Token (固定通道未启用)');
      var rs2 = _brgEl('brgRelayState'); if (rs2) rs2.style.color = '';
      _brgSet('brgRelayUrl', '');
    }
    // 公网 apiKey 取自 ④ 反代状态 (仅本机可见)
    if (_rpStatus && _rpStatus.apiKey) _brgSet('brgPubKey', _rpStatus.apiKey);
    else if (_rpStatus && _rpStatus.hasKey) _brgSet('brgPubKey', '(已设置·见④面板复制)');
    else _brgSet('brgPubKey', '(未设置 — 公网访问前请在④面板设 API Key)');
    // 连接中则起轮询等 URL
    if (running && !url) { _brgStartPoll(); } else { _brgStopPoll(); }
  }
  function _brgRefresh() {
    // 顺带取一次反代状态以拿 apiKey
    fJson('/origin/revproxy/status').then(function(rp){ _rpStatus = rp || _rpStatus; }).catch(function(){})
      .then(function(){ return fJson(_BRG_TP); })
      .then(function(d){ _brgApply(d); })
      .catch(function(e){ _brgSet('brgStat', '状态获取失败: ' + e.message); });
  }
  function _brgStartPoll() {
    if (_brgPoll) return;
    _brgPoll = setInterval(function(){
      fJson(_BRG_TP).then(function(d){
        _brgApply(d);
        if (d && d.url) _brgStopPoll();
      }).catch(function(){});
    }, 2500);
  }
  function _brgStopPoll() { if (_brgPoll) { clearInterval(_brgPoll); _brgPoll = null; } }
  function _brgAction(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    _brgSet('brgStat', '执行 ' + action + '…');
    return fPost(_BRG_TP, body).then(function(d){ _brgApply(d); return d; })
      .catch(function(e){ _brgSet('brgStat', action + ' 失败: ' + e.message); throw e; });
  }
  function _brgClip(t) { try { navigator.clipboard.writeText(t); _brgSet('brgStat', '已复制'); } catch (e) {} }
  function _brgTest() {
    var out = _brgEl('brgTestOut');
    var url = _brgS && _brgS.url;
    if (!url) { if (out) { out.style.display = 'block'; out.textContent = '公网隧道未连通 · 请先启动隧道'; } return; }
    var key = (_rpStatus && _rpStatus.apiKey) || '';
    var model = (_rpStatus && _rpStatus.models && _rpStatus.models.length) ? (_rpStatus.models.find(function(m){ return m.exposed !== false; }) || _rpStatus.models[0]) : null;
    model = model ? (model.uid || model.family || 'swe-1-6') : 'swe-1-6';
    var prompt = (_brgEl('brgTestPrompt').value || '你好').trim();
    if (out) { out.style.display = 'block'; out.textContent = '经公网 URL 请求中… (POST ' + url + '/v1/chat/completions · model=' + model + ')'; }
    fetch(url + '/v1/chat/completions', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], stream: false })
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, j: j }; }); })
      .then(function(res){
        if (res.status >= 400) { out.textContent = '✖ HTTP ' + res.status + '\n' + JSON.stringify(res.j, null, 2); return; }
        var c = res.j && res.j.choices && res.j.choices[0] && res.j.choices[0].message ? res.j.choices[0].message.content : '';
        out.textContent = '✔ 公网全链路通 (经隧道直调反带模型)\n\n公网URL: ' + url + '\n模型: ' + (res.j.model || model) + '\n回复:\n' + c;
      }).catch(function(e){ if (out) out.textContent = '✖ 公网请求异常: ' + e.message + '\n(隧道可能仍在建立·或被 CF 拦截·稍候重试)'; });
  }
  function _brgHealth() {
    var out = _brgEl('brgTestOut');
    var url = _brgS && _brgS.url;
    if (!url) { if (out) { out.style.display = 'block'; out.textContent = '公网隧道未连通 · 请先启动隧道'; } return; }
    var key = (_rpStatus && _rpStatus.apiKey) || '';
    if (out) { out.style.display = 'block'; out.textContent = 'GET ' + url + '/v1/models …'; }
    fetch(url + '/v1/models', { cache: 'no-store', headers: { 'Authorization': 'Bearer ' + key } })
      .then(function(r){ return r.json().then(function(j){ return { status: r.status, j: j }; }); })
      .then(function(res){
        var n = res.j && res.j.data ? res.j.data.length : 0;
        out.textContent = (res.status < 400 ? '✔' : '✖') + ' HTTP ' + res.status + ' · 公网可达 · ' + n + ' 模型\n' + JSON.stringify(res.j, null, 2).slice(0, 800);
      }).catch(function(e){ if (out) out.textContent = '✖ 公网不可达: ' + e.message; });
  }
  function _brgCopyInfo() {
    var s = _brgS || {};
    var key = (_rpStatus && _rpStatus.apiKey) || '$REVPROXY_KEY';
    var lines = [
      '# DAO Bridge · 公网接入 (反带模型公网直调)',
      'Base URL: ' + (s.publicBase || '(隧道未连通)'),
      'API Key : ' + key,
      'Header  : Authorization: Bearer ' + key,
      '',
      '# OpenAI 兼容 curl 示例',
      'curl -X POST ' + (s.publicChat || '<公网URL>/v1/chat/completions') + ' \\',
      '  -H "Content-Type: application/json" -H "Authorization: Bearer ' + key + '" \\',
      '  -d \'{"model":"swe-1-6","messages":[{"role":"user","content":"你好"}]}\''
    ];
    _brgClip(lines.join('\n'));
  }
  (function _brgWire() {
    var m = {
      brgStart: function(){ _brgAction('start'); },
      brgRestart: function(){ _brgAction('restart'); },
      brgStop: function(){ _brgAction('stop'); },
      brgRefreshBtn: function(){ _brgRefresh(); },
      brgStartNamed: function(){ _brgAction('startNamed'); },
      brgBindCf: function(){
        var t = (_brgEl('brgCfToken') && _brgEl('brgCfToken').value || '').trim();
        if (!t) { _brgSet('brgRelayState', '请先粘贴 Cloudflare API Token'); return; }
        _brgSet('brgRelayState', '◌ 正在部署 workers.dev 固定中继(约 10-20s)…');
        _brgAction('bindCf', { token: t }).then(function(d){
          if (d && d.message) _brgSet('brgRelayState', (d.ok ? '' : '✖ ') + d.message);
          var it = _brgEl('brgCfToken'); if (it) it.value = '';
        }).catch(function(){});
      },
      brgLogout: function(){ _brgAction('logout').then(function(){ _brgSet('brgRelayState', '已退出/解绑'); }); },
      brgCopyUrl: function(){ _brgClip((_brgS && _brgS.url) || ''); },
      brgCopyInfo: _brgCopyInfo,
      brgTestRun: _brgTest,
      brgHealth: _brgHealth,
      brgCfSave: function(){ _brgAction('cfLogin', { email: (_brgEl('brgCfEmail').value || '').trim(), key: (_brgEl('brgCfKey').value || '').trim() }); },
      brgOpenConsole: function(){ var u = _brgS && _brgS.publicConsole; if (u && _vscode) _vscode.postMessage({ type: 'openExternal', url: u }); else if (u) { try { window.open(u, '_blank'); } catch(e){} } }
    };
    Object.keys(m).forEach(function(id){ var e = _brgEl(id); if (e) e.addEventListener('click', m[id]); });
  })();

  // ═══ ① 本源观照 · IDE 左侧复刻 (道/官/编 + 经文 + 本源体池 · 与左侧同源) ═══
  function _e1El(id) { return document.getElementById(id); }
  var _e1Mode = 'invert';
  var _e1EditOpen = false;
  function _e1SetMode(m) {
    _e1Mode = m;
    var d = _e1El('e1Dao'), o = _e1El('e1Off');
    if (d) d.classList.toggle('add', m === 'invert');
    if (o) o.classList.toggle('add', m !== 'invert');
    var dots = _e1El('e1Dots');
    if (dots) dots.style.background = (m === 'invert') ? '#6bb86b' : '#d9a441';
  }
  function _e1LoadPreview() {
    fJson('/origin/preview').then(function(d) {
      if (!d || !d.ok) return;
      var sp = _e1El('e1Sp');
      var body = d.after || d.before || '';
      if (sp) {
        sp.textContent = body || '（待首次对话或加载 · 发一条消息即捕获真实注入）';
        sp.style.opacity = body ? '1' : '0.55';
      }
      var stat = _e1El('e1Stat');
      if (stat) stat.textContent = '模式 ' + (d.mode || '-') + ' · 本源体 ' + (d.after_chars || 0) + ' 字 · header ' + (d.tao_header_chars || 0) + ' · ' + (d.custom_sp ? ('自定义 ' + d.custom_sp_chars + ' 字') : '默认注入');
      var badge = _e1El('e1Badge');
      if (badge) badge.textContent = d.custom_sp ? '✎ 自定义' : '';
    }).catch(function() {});
  }
  function _e1LoadState() {
    fJson('/origin/mode').then(function(d) { if (d && d.mode) _e1SetMode(d.mode); }).catch(function() {});
    fJson('/origin/canon').then(function(d) { if (d && d.canon) { var s = _e1El('e1Canon'); if (s) s.value = d.canon; } }).catch(function() {});
    _e1LoadPreview();
  }
  // v9.9.299 · 「编」兜底稳态: 无 custom 时永以 /origin/custom_sp 的 default_sp 填 textarea
  //   (随 _activeCanon 动态 · 帛书老子/道藏阴符经 名实相符), 不再回退 /origin/preview
  //   ——preview 依赖实时捕获的 lastInject, 无对话/捕获过期时为空 → 旧版「跳有跳没」根因。
  function _e1FillEdit(tx, st, focus) {
    if (!tx) return;
    fJson('/origin/custom_sp').then(function(cs) {
      if (cs && cs.has_custom && cs.sp) {
        tx.value = cs.sp;
        if (st) st.textContent = '自定义 · ' + (cs.chars || cs.sp.length) + '字';
      } else if (cs && cs.default_sp) {
        tx.value = cs.default_sp;
        if (st) st.textContent = '未设 · ' + (cs.default_source_name || cs.default_source || '默认') + ' ' + (cs.default_chars || cs.default_sp.length) + '字';
      } else if (st) {
        st.textContent = '加载兜底经文失败';
      }
      if (focus) tx.focus();
    }).catch(function() { if (st) st.textContent = '加载经文网络异常'; });
  }
  (function _e1Wire() {
    var d = _e1El('e1Dao'), o = _e1El('e1Off'), e = _e1El('e1Edit'), c = _e1El('e1Canon');
    var tx = _e1El('e1EditText'), st = _e1El('e1EditStatus');
    if (d) d.addEventListener('click', function() { _e1SetMode('invert'); fPost('/origin/mode', { mode: 'invert' }).then(_e1LoadPreview).catch(function() {}); });
    if (o) o.addEventListener('click', function() { _e1SetMode('passthrough'); fPost('/origin/mode', { mode: 'passthrough' }).then(_e1LoadPreview).catch(function() {}); });
    if (c) c.addEventListener('change', function() {
      fPost('/origin/canon', { canon: c.value }).then(function() {
        _e1LoadPreview();
        // 切经藏后 · 若正在编辑且未改自定义 · textarea 随经重填新本源 (名实相符)
        if (_e1EditOpen) _e1FillEdit(tx, st, false);
      }).catch(function() {});
    });
    if (e) e.addEventListener('click', function() {
      _e1EditOpen = !_e1EditOpen;
      var area = _e1El('e1EditArea'); if (area) area.style.display = _e1EditOpen ? 'block' : 'none';
      if (_e1EditOpen) { if (st) st.textContent = '加载中…'; _e1FillEdit(tx, st, true); }
    });
    function _e1Save() {
      if (!tx) return;
      if (!tx.value || !tx.value.trim()) { if (st) st.textContent = '✖ 内容不可为空'; return; }
      fPost('/origin/custom_sp', { sp: tx.value, source: 'webview-e1' }).then(function() { if (st) st.textContent = '已注入 · 下次 chat 生效'; _e1LoadPreview(); }).catch(function(er) { if (st) st.textContent = '失败: ' + er.message; });
    }
    var sv = _e1El('e1Save'), rl = _e1El('e1Reload'), rs = _e1El('e1Reset');
    if (sv) sv.addEventListener('click', _e1Save);
    if (rl) rl.addEventListener('click', function() { fJson('/origin/preview').then(function(p) { if (tx && (p.after || p.before)) tx.value = p.after || p.before; if (st) st.textContent = '已载实收 SP (未保存)'; }).catch(function() {}); });
    if (rs) rs.addEventListener('click', function() { fDel('/origin/custom_sp').then(function() { if (st) st.textContent = '重置中…'; _e1FillEdit(tx, st, true); _e1LoadPreview(); }).catch(function() {}); });
    if (tx) tx.addEventListener('keydown', function(ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); _e1Save(); }
      else if (ev.key === 'Escape') { _e1EditOpen = false; var area = _e1El('e1EditArea'); if (area) area.style.display = 'none'; }
    });
    var op = _e1El('e1Open'); if (op) op.addEventListener('click', function() { postMsg('focusEssence'); });
  })();
  _e1LoadState();
  setInterval(function() { var pe = document.getElementById('paneEssence'); if (pe && pe.classList.contains('active')) _e1LoadPreview(); }, 6000);

  // ═══ ② Agent 交接指挥文档 · 实时生成 · 下载 / 预览 ═══
  function _fetchHandoff() {
    return fetch(_BASE + '/origin/ea/handoff.md', { cache: 'no-store' })
      .then(function(r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); });
  }
  var _ocj = _e1El('btnOpenCfgJson');
  if (_ocj) _ocj.addEventListener('click', function() { postMsg('openConfigJson'); });
  var _ch = _e1El('btnCopyHandoff');
  if (_ch) _ch.addEventListener('click', function() {
    var self = this; var _orig = self.textContent; self.textContent = '取最新…';
    _fetchHandoff().then(function(md) {
      // 优先浏览器剪贴板 API · 不可用(webview 权限/非安全上下文)则交宿主 vscode.env.clipboard
      function _viaHost() { if (_vscode) _vscode.postMessage({ type: 'copyHandoff', content: md }); }
      var done = function() { self.textContent = '✓ 已复制'; setTimeout(function() { self.textContent = _orig; }, 1800); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(md).then(done, function() { _viaHost(); done(); });
        } else { _viaHost(); done(); }
      } catch (_e) { _viaHost(); done(); }
    }).catch(function(e) { self.textContent = _orig; try { _daoToast('复制失败: ' + e.message); } catch (_) {} });
  });
  var _dh = _e1El('btnDownloadHandoff'), _ph = _e1El('btnPreviewHandoff');
  if (_dh) _dh.addEventListener('click', function() {
    _fetchHandoff().then(function(md) {
      if (_vscode) { _vscode.postMessage({ type: 'saveHandoff', content: md }); return; }
      try {
        var blob = new Blob([md], { type: 'text/markdown' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'fomo-flow-handoff.md';
        document.body.appendChild(a); a.click();
        setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 1000);
      } catch (e2) {}
    }).catch(function(e) { try { _daoToast('下载失败: ' + e.message); } catch (_) {} });
  });
  if (_ph) _ph.addEventListener('click', function() {
    var pre = _e1El('handoffPreview');
    _fetchHandoff().then(function(md) { if (pre) { pre.textContent = md; pre.style.display = 'block'; } })
      .catch(function(e) { if (pre) { pre.textContent = '预览失败: ' + e.message; pre.style.display = 'block'; } });
  });

  // ═══ ④ 模型反代专属 Agent 交接文档 · 实时生成 · 复制 / 下载 / 预览 (v9.9.347) ═══
  function _fetchRpHandoff() {
    return fetch(_BASE + '/origin/revproxy/handoff.md', { cache: 'no-store' })
      .then(function(r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); });
  }
  var _rch = _e1El('btnCopyRpHandoff');
  if (_rch) _rch.addEventListener('click', function() {
    var self = this; var _orig = self.textContent; self.textContent = '取最新…';
    _fetchRpHandoff().then(function(md) {
      function _viaHost() { if (_vscode) _vscode.postMessage({ type: 'copyHandoff', content: md }); }
      var done = function() { self.textContent = '✓ 已复制'; setTimeout(function() { self.textContent = _orig; }, 1800); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(md).then(done, function() { _viaHost(); done(); });
        } else { _viaHost(); done(); }
      } catch (_e) { _viaHost(); done(); }
    }).catch(function(e) { self.textContent = _orig; try { _daoToast('复制失败: ' + e.message); } catch (_) {} });
  });
  var _rdh = _e1El('btnDownloadRpHandoff'), _rph = _e1El('btnPreviewRpHandoff');
  if (_rdh) _rdh.addEventListener('click', function() {
    _fetchRpHandoff().then(function(md) {
      if (_vscode) { _vscode.postMessage({ type: 'saveHandoff', content: md, filename: 'fomo-flow-revproxy-handoff.md' }); return; }
      try {
        var blob = new Blob([md], { type: 'text/markdown' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'fomo-flow-revproxy-handoff.md';
        document.body.appendChild(a); a.click();
        setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 1000);
      } catch (e2) {}
    }).catch(function(e) { try { _daoToast('下载失败: ' + e.message); } catch (_) {} });
  });
  if (_rph) _rph.addEventListener('click', function() {
    var pre = _e1El('rpHandoffPreview');
    _fetchRpHandoff().then(function(md) { if (pre) { pre.textContent = md; pre.style.display = 'block'; } })
      .catch(function(e) { if (pre) { pre.textContent = '预览失败: ' + e.message; pre.style.display = 'block'; } });
  });

  // ── 初始加载 ──
  loadConfig();
  // 首次探测健康 (统一走 _autoProbe)
  setTimeout(function() { _autoProbe(); }, 1000);
})();

  function _rpEl(id) { return document.getElementById(id); }
  var _rpStatus = null;
  var _rpModels = [];
  var _rpFilter = 'all';
  var _rpProtocol = 'openai-chat';
  var _RP_REASONING_BUDGETS = {minimal:1024,low:2048,medium:8192,high:16384,xhigh:32768,max:65536,auto:8192};
  function _rpSetText(id, t) { var e = _rpEl(id); if (e) e.textContent = t; }
  var _RP_DOT = { green: '#3fb950', red: '#f85149', amber: '#d29922' };
  function _rpRefresh() {
    fJson('/origin/revproxy/status').then(function(d) {
      _rpStatus = d || {};
      _rpModels = (d && d.models) || [];
      var en = _rpEl('rpEnabled'); if (en) en.checked = !!d.enabled;
      var iv = _rpEl('rpInvert'); if (iv) iv.checked = !!d.applyInvert;
      var iso = _rpEl('rpIsolate'); if (iso) iso.checked = d.isolatePrompt !== false;
      var rd = d.outboundRedact || {};
      var rdBox = _rpEl('rpRedact'); if (rdBox) rdBox.checked = !!rd.enabled;
      var rdMode = _rpEl('rpRedactMode'); if (rdMode) rdMode.value = rd.mode || 'redact';
      var exc = d.exactCache || {};
      var excBox = _rpEl('rpExactCache'); if (excBox) excBox.checked = !!exc.enabled;
      var excStat = exc.stats || null;
      if (excStat) {
        _rpSetText('rpExactStat', '命中率 ' + excStat.hitRate + '% · ' + excStat.hits + '命中/' + excStat.misses + '未中 · ' + excStat.entries + '/' + excStat.maxEntries + '条');
      } else {
        _rpSetText('rpExactStat', exc.enabled ? '已启用 · 暂无请求' : '未启用');
      }
      var sem = d.semanticCache || {};
      var semBox = _rpEl('rpSemCache'); if (semBox) semBox.checked = !!sem.enabled;
      var semTh = _rpEl('rpSemThreshold'); if (semTh && document.activeElement !== semTh) semTh.value = sem.threshold != null ? sem.threshold : 0.95;
      var semStat = sem.stats || null;
      if (semStat) {
        _rpSetText('rpSemStat', '· 命中率 ' + semStat.hitRate + '% · 均分 ' + semStat.avgHitScore + ' · ' + semStat.entries + '/' + semStat.maxEntries + '条');
      } else if (!sem.configured) {
        _rpSetText('rpSemStat', '· 未配 embeddings 端点');
      } else {
        _rpSetText('rpSemStat', sem.enabled ? '· 已启用 · 暂无请求' : '· 未启用');
      }
      var st = d.stats || {};
      _rpSetText('rpStat', (d.enabled ? '● 已启用' : '○ 未启用') + ' · ' + (d.model_count || 0) + ' 模型可反代');
      _rpSetText('rpEndpoint', d.endpoint || ('http://127.0.0.1:' + _PORT + '/v1'));
      _rpSetText('rpKey', d.apiKey || (d.hasKey ? '(已设置·仅本机可见)' : '(未设置·仅 localhost 放行)'));
      _rpSetText('rpModelCount', '(' + (d.model_count || 0) + ')');
      var q = d.premiumQuota === 'ok' ? '付费配额·有' : (d.premiumQuota === 'exhausted' ? '付费配额·耗尽' : '付费配额·未探测');
      var nFam = (d.families || []).length;
      var nMulti = (d.families || []).filter(function(f){ return f.multi; }).length;
      var exq = (st.disabled || 0) > 0 ? (' · 外接 ' + (st.exposed || 0) + '/' + (st.total || 0)) : '';
      _rpSetText('rpLegend', '🟢 ' + (st.green || 0) + ' · 🔴 ' + (st.red || 0) + ' · 🟡 ' + (st.amber || 0) + ' · 免费 ' + (st.free || 0) + ' · ' + nFam + '族(' + nMulti + '族多档可热切) · ' + q + exq);
      _rpRenderList();
      _rpFillSelect();
      _rpUpdateReasoning();
      _rpApplyProtocol();
    }).catch(function(e) { _rpSetText('rpStat', '状态加载失败: ' + e.message); });
  }
  function _rpMatch(m) {
    if (_rpFilter === 'green' && m.color !== 'green') return false;
    if (_rpFilter === 'red' && m.color !== 'red') return false;
    if (_rpFilter === 'free' && !m.free) return false;
    if (_rpFilter === 'channel' && !(m.reverse === 'channel' || m.reverse === 'stub')) return false;
    var kw = (_rpEl('rpFilter') && _rpEl('rpFilter').value || '').trim().toLowerCase();
    if (kw) {
      var hay = (m.id + ' ' + (m.label || '') + ' ' + (m.provider || '') + ' ' + (m.owned_by || '')).toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  }
  // 按家族归组 (一族一项·各档收于 members·活跃档单列) · 朴散则为器
  function _rpGroup() {
    var groups = [];
    var byFam = {};
    for (var i = 0; i < _rpModels.length; i++) {
      var m = _rpModels[i];
      var fu = m.familyUid || ('__solo__' + m.id);
      if (!byFam[fu]) {
        byFam[fu] = { familyUid: fu, familyLabel: m.familyLabel || m.label || m.id, members: [], active: null };
        groups.push(byFam[fu]);
      }
      byFam[fu].members.push(m);
      if (m.activeTier) byFam[fu].active = m;
    }
    for (var g = 0; g < groups.length; g++)
      if (!groups[g].active) groups[g].active = groups[g].members[0];
    return groups;
  }
  function _rpDot(c) { return c === 'green' ? '🟢' : (c === 'red' ? '🔴' : '🟡'); }
  function _rpTierName(m) { return (m.tier && m.tier !== 'base') ? m.tier : m.id; }
  function _rpChannelChain(m) {
    var channels = m && Array.isArray(m.channelPriority) ? m.channelPriority : [];
    if (!channels.length) return '';
    var strategy = m.channelStrategy === 'random' ? '随机首选' : '优先级切换';
    var rows = channels.map(function(channel, index) {
      var level = _REASONING_LABELS[channel.reasoningLevel] || channel.reasoningLevel || '关闭';
      return '<div style="font-size:9px;white-space:nowrap;margin:2px 0"><b>' + (index === 0 ? '首选' : '备用 ' + index) + '</b> · <code>' + _rpEsc(channel.provider || '') + '/' + _rpEsc(channel.model || '') + '</code> · ' + _rpEsc(channel.protocol || '自动协议') + ' · ' + _rpEsc(level) + '</div>';
    }).join('');
    return '<details style="font-size:9px;flex:none"><summary style="cursor:pointer;color:#80c8ef">同步渠道 ' + channels.length + ' · ' + strategy + '</summary><div style="padding:3px 5px;max-width:360px;overflow-x:auto">' + rows + '</div></details>';
  }
  function _rpRenderList() {
    var list = _rpEl('rpModelList');
    if (!list) return;
    if (!_rpModels.length) {
      list.innerHTML = '<div style="opacity:0.55;padding:8px">暂无模型 · 反代未运行或目录未加载。</div>';
      return;
    }
    var groups = _rpGroup();
    var html = '';
    var shownFams = 0;
    var shownModels = 0;
    var rowIdx = 0;
    for (var i = 0; i < groups.length; i++) {
      var f = groups[i];
      var matched = [];
      for (var j = 0; j < f.members.length; j++)
        if (_rpMatch(f.members[j])) matched.push(f.members[j]);
      if (!matched.length) continue;
      shownFams++;
      shownModels += f.members.length;
      var multi = f.members.length > 1;
      var famExposed = f.members.some(function (mb) { return mb.exposed !== false; });
      var famIds = f.members.map(function (mb) { return mb.id; }).join(',');
      var rowAttr = ' class="rp-row" data-idx="' + (rowIdx++) + '" data-ids="' + _rpEsc(famIds) + '"';
      var expBox = '<input type="checkbox" class="rp-exp" data-ids="' + _rpEsc(famIds) + '"' + (famExposed ? ' checked' : '') + ' title="是否外接此模型(取消后端点不列不接·默认全选) · 点按/Shift 范围/按住拖拽批量" style="flex:none;margin:0">';
      var dimSt = famExposed ? '' : 'opacity:0.45;';
      if (multi) {
        var act = f.active;
        var dot = _RP_DOT[act.color] || '#888';
        var via = act.dao_route ? ('→ ' + act.dao_route.provider) : (act.reverse === 'official' ? '官方直通' : (act.owned_by || ''));
        var familyBadges = act.custom ? '<span class="pb-badge">⑦自定义</span>' : '';
        if (act.capabilities && act.capabilities.supportsThinking) familyBadges += '<span class="pb-badge">思考 ' + (act.capabilities.reasoningLevels || []).length + '档</span>';
        var opts = '';
        for (var k = 0; k < f.members.length; k++) {
          var mb = f.members[k];
          opts += '<option value="' + _rpEsc(mb.id) + '"' + (mb === act ? ' selected' : '') + '>'
            + _rpDot(mb.color) + ' ' + _rpEsc(_rpTierName(mb)) + (mb.free ? ' · 免费' : '') + '</option>';
        }
        html += '<div' + rowAttr + ' style="' + dimSt + 'display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px solid rgba(128,128,128,0.12)">'
          + expBox
          + '<span title="' + _rpEsc(act.note || '') + '" style="flex:none;width:8px;height:8px;border-radius:50%;background:' + dot + '"></span>'
          + '<b style="font-size:11px">' + _rpEsc(f.familyLabel) + '</b>' + familyBadges
          + '<span style="opacity:0.45;font-size:9px">' + f.members.length + '档</span>'
          + _rpChannelChain(act)
          + '<select class="rp-tier" data-fam="' + _rpEsc(f.familyUid) + '" title="热切换该家族当前反代档位" style="flex:1;min-width:90px;max-width:200px;font-size:10px;padding:1px 3px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none">' + opts + '</select>'
          + '<span style="opacity:0.45;font-size:9px;margin-left:auto;white-space:nowrap">' + _rpEsc(via) + '</span></div>';
      } else {
        var m = f.members[0];
        var d1 = _RP_DOT[m.color] || '#888';
        var via1 = m.dao_route ? ('→ ' + m.dao_route.provider + ' / ' + (m.dao_route.model || '')) : (m.reverse === 'official' ? '官方直通' : (m.owned_by || ''));
        var tier = m.costTier ? String(m.costTier).replace('MODEL_COST_TIER_', '') : '';
        var badge = m.free ? '<span style="font-size:9px;color:#3fb950;border:1px solid #3fb950;border-radius:3px;padding:0 3px;margin-left:4px">免费</span>' : (tier ? '<span style="font-size:9px;opacity:0.6;margin-left:4px">' + _rpEsc(tier) + '</span>' : '');
        if (m.dao_bridge) badge += '<span class="pb-badge">中转 ' + _rpEsc((m.dao_target_protocols || []).join('+')) + '</span>';
        if (m.custom) badge += '<span class="pb-badge">⑦自定义</span>';
        if (m.capabilities && m.capabilities.supportsThinking) badge += '<span class="pb-badge">思考 ' + (m.capabilities.reasoningLevels || []).length + '档</span>';
        html += '<div' + rowAttr + ' style="' + dimSt + 'display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid rgba(128,128,128,0.12)">'
          + expBox
          + '<span title="' + _rpEsc(m.note || '') + '" style="flex:none;width:8px;height:8px;border-radius:50%;background:' + d1 + '"></span>'
          + '<code style="font-weight:600">' + _rpEsc(m.id) + '</code>' + badge
          + _rpChannelChain(m)
          + '<span style="opacity:0.55;font-size:10px">· ' + _rpEsc(m.provider || m.owned_by || '') + '</span>'
          + '<span style="opacity:0.5;font-size:10px;margin-left:auto;white-space:nowrap">' + _rpEsc(via1) + '</span></div>';
      }
    }
    _rpSetText('rpModelCount', '(' + shownFams + '族/' + shownModels + '档)');
    list.innerHTML = html || '<div style="opacity:0.55;padding:8px">无匹配模型。</div>';
    var sels = list.querySelectorAll('.rp-tier');
    for (var s = 0; s < sels.length; s++) {
      (function (el) {
        el.addEventListener('change', function () { _rpSetTier(el.getAttribute('data-fam'), el.value); });
      })(sels[s]);
    }
    var exps = list.querySelectorAll('.rp-exp');
    for (var x = 0; x < exps.length; x++) {
      (function (el) {
        el.addEventListener('change', function () {
          _rpSetExposed((el.getAttribute('data-ids') || '').split(','), el.checked);
        });
      })(exps[x]);
    }
  }
  // 批量多选 (如切号板块): 点按=单切 · Shift+点=范围 · 按住拖拽=连片 · 松开一次性提交
  var _rpLastSel = -1, _rpDragSel = false, _rpDragVal = true, _rpPend = null;
  function _rpRowAt(idx) {
    var list = _rpEl('rpModelList');
    return list ? list.querySelector('.rp-row[data-idx="' + idx + '"]') : null;
  }
  function _rpMarkRow(row, v) {
    if (!row) return;
    var box = row.querySelector('.rp-exp');
    if (box) box.checked = v;
    row.style.opacity = v ? '1' : '0.45';
    var ids = (row.getAttribute('data-ids') || '').split(',');
    for (var i = 0; i < ids.length; i++) if (ids[i]) _rpPend[ids[i]] = 1;
  }
  function _rpApplyRange(a, b, v) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    for (var i = lo; i <= hi; i++) _rpMarkRow(_rpRowAt(i), v);
  }
  function _rpStartSel(e) {
    if (e.button !== 0) return;
    var row = e.target.closest ? e.target.closest('.rp-row') : null;
    if (!row) return;
    if (e.target.closest('select,button,a')) return;
    var i = parseInt(row.getAttribute('data-idx'), 10);
    var box = row.querySelector('.rp-exp');
    if (!isFinite(i) || !box) return;
    e.preventDefault();
    var v = !box.checked;
    _rpPend = {};
    if (e.shiftKey && _rpLastSel >= 0) _rpApplyRange(_rpLastSel, i, v);
    else { _rpMarkRow(row, v); _rpLastSel = i; }
    _rpDragSel = true; _rpDragVal = v;
    _rpSetText('rpStat', '已选 ' + Object.keys(_rpPend).length + ' 档 · 松开提交「' + (v ? '恢复外接' : '停止外接') + '」');
  }
  function _rpDragOver(e) {
    if (!_rpDragSel) return;
    var row = e.target.closest ? e.target.closest('.rp-row') : null;
    if (!row) return;
    _rpMarkRow(row, _rpDragVal);
    _rpSetText('rpStat', '已选 ' + Object.keys(_rpPend).length + ' 档 · 松开提交「' + (_rpDragVal ? '恢复外接' : '停止外接') + '」');
  }
  function _rpEndSel() {
    if (!_rpDragSel) return;
    _rpDragSel = false;
    var ids = Object.keys(_rpPend || {});
    _rpPend = null;
    if (ids.length) _rpSetExposed(ids, _rpDragVal);
  }
  // 模型外接选择: 热切某(些)模型是否对外反代 (setAll: 'on'|'off' 批量)
  function _rpSetExposed(ids, exposed, setAll) {
    _rpSetText('rpStat', '保存外接选择…');
    var body = setAll ? { setAll: setAll } : { modelUids: ids, exposed: !!exposed };
    fPost('/origin/revproxy/models', body).then(function () { _rpRefresh(); }).catch(function (e) { _rpSetText('rpStat', '外接选择保存失败: ' + e.message); });
  }
  function _rpSetTier(fam, uid) {
    if (!fam || !uid) return;
    _rpSetText('rpStat', '切换档位…');
    fPost('/origin/revproxy/tier', { familyUid: fam, modelUid: uid }).then(function () { _rpRefresh(); }).catch(function (e) { _rpSetText('rpStat', '档位切换失败: ' + e.message); });
  }
  function _rpFillSelect() {
    var sel = _rpEl('rpTestModel');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    var groups = _rpGroup();
    for (var i = 0; i < groups.length; i++) {
      var f = groups[i];
      if (f.members.length > 1) {
        var og = document.createElement('optgroup');
        og.label = f.familyLabel;
        for (var k = 0; k < f.members.length; k++) {
          var m = f.members[k];
          var o = document.createElement('option');
          o.value = m.id;
          o.textContent = _rpDot(m.color) + ' ' + _rpTierName(m) + (m === f.active ? ' ★活跃' : '') + (m.free ? ' (免费)' : '');
          og.appendChild(o);
        }
        sel.appendChild(og);
      } else {
        var m0 = f.members[0];
        var o0 = document.createElement('option');
        o0.value = m0.id;
        o0.textContent = _rpDot(m0.color) + ' ' + m0.id + (m0.free ? ' (免费)' : '');
        sel.appendChild(o0);
      }
    }
    if (prev) sel.value = prev;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    _rpUpdateReasoning();
  }
  function _rpSelectedModel() {
    var id=_rpEl('rpTestModel')&&_rpEl('rpTestModel').value;
    for(var i=0;i<_rpModels.length;i++)if(_rpModels[i].id===id)return _rpModels[i];
    return null;
  }
  function _rpUpdateReasoning() {
    var model=_rpSelectedModel(); var capability=model&&model.capabilities;
    _fillReasoningOptions(_rpEl('rpTestReasoning'),capability,(model&&model.reasoningLevel)||(capability&&capability.defaultReasoningLevel)||'off');
  }
  function _rpApplyTestReasoning(body, protocol, level, capability) {
    level=level||'off'; capability=capability||{};
    var effort=level==='auto'||level==='max'?'high':level;
    var budget=_RP_REASONING_BUDGETS[level]||8192;
    if(protocol==='openai-responses'){body.reasoning={effort:level==='off'?'off':effort};return;}
    if(protocol==='anthropic'){body.thinking=level==='off'?{type:'disabled'}:{type:'enabled',budget_tokens:budget};return;}
    if(protocol==='gemini'){body.generationConfig=body.generationConfig||{};body.generationConfig.thinkingConfig={thinkingBudget:level==='off'?0:budget};return;}
    if(level==='off'){body.thinking={type:'disabled'};return;}
    if(capability.transport==='effort')body.reasoning_effort=effort;
    else body.thinking={type:'enabled',budget_tokens:budget};
  }
  function _rpProtocolMeta() {
    var endpoints = (_rpStatus && _rpStatus.endpoints) || {};
    var base = 'http://127.0.0.1:' + _PORT;
    var all = {
      'openai-chat': { title: 'OpenAI Chat Completions', endpoint: endpoints.openaiChat || (base + '/v1/chat/completions'), hint: 'Authorization: Bearer {API Key}' },
      'openai-responses': { title: 'OpenAI Responses', endpoint: endpoints.openaiResponses || (base + '/v1/responses'), hint: 'Authorization: Bearer {API Key}' },
      'anthropic': { title: 'Anthropic Messages', endpoint: endpoints.anthropic || (base + '/v1/messages'), hint: 'x-api-key 或 Authorization: Bearer {API Key}' },
      'gemini': { title: 'Gemini Generate Content', endpoint: endpoints.gemini || (base + '/v1beta/models/{model}:generateContent'), hint: 'x-goog-api-key 或 Authorization: Bearer {API Key}' }
    };
    return all[_rpProtocol] || all['openai-chat'];
  }
  function _rpApplyProtocol() {
    var meta = _rpProtocolMeta();
    _rpSetText('rpProtocolTitle', meta.title);
    _rpSetText('rpProtocolEndpoint', meta.endpoint);
    _rpSetText('rpProtocolHint', meta.hint);
    var buttons = document.querySelectorAll('.rp-proto');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('add', buttons[i].getAttribute('data-proto') === _rpProtocol);
    var testProtocol = _rpEl('rpTestProtocol'); if (testProtocol) testProtocol.value = _rpProtocol;
  }
  function _rpEsc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function _rpSaveCfg(patch) {
    return fPost('/origin/revproxy/config', patch).then(function() { _rpRefresh(); }).catch(function(e) { _rpSetText('rpStat', '保存失败: ' + e.message); });
  }
  (function _rpWire() {
    var en = _rpEl('rpEnabled'); if (en) en.addEventListener('change', function() { _rpSaveCfg({ enabled: en.checked }); });
    var iv = _rpEl('rpInvert'); if (iv) iv.addEventListener('change', function() { _rpSaveCfg({ applyInvert: iv.checked }); });
    var iso = _rpEl('rpIsolate'); if (iso) iso.addEventListener('change', function() { _rpSaveCfg({ isolatePrompt: iso.checked }); });
    var rd = _rpEl('rpRedact'); if (rd) rd.addEventListener('change', function() { _rpSaveCfg({ outboundRedact: { enabled: rd.checked } }); });
    var rdMode = _rpEl('rpRedactMode'); if (rdMode) rdMode.addEventListener('change', function() { _rpSaveCfg({ outboundRedact: { mode: rdMode.value } }); });
    var exc = _rpEl('rpExactCache'); if (exc) exc.addEventListener('change', function() { _rpSaveCfg({ exactCache: { enabled: exc.checked } }); });
    var semBox = _rpEl('rpSemCache'); if (semBox) semBox.addEventListener('change', function() { _rpSaveCfg({ semanticCache: { enabled: semBox.checked } }); });
    var semTh = _rpEl('rpSemThreshold'); if (semTh) semTh.addEventListener('change', function() { var v = parseFloat(semTh.value); if (isFinite(v)) _rpSaveCfg({ semanticCache: { threshold: v } }); });
    var semSave = _rpEl('rpSemSave'); if (semSave) semSave.addEventListener('click', function() {
      var embed = {
        baseUrl: (_rpEl('rpSemBaseUrl') && _rpEl('rpSemBaseUrl').value || '').trim(),
        model: (_rpEl('rpSemModel') && _rpEl('rpSemModel').value || '').trim(),
        apiKey: (_rpEl('rpSemKey') && _rpEl('rpSemKey').value || '').trim()
      };
      _rpSaveCfg({ semanticCache: { embed: embed } }).then(function(){ _rpSetText('rpStat', '语义缓存配置已保存'); });
    });
    var ea = _rpEl('rpExposeAll'); if (ea) ea.addEventListener('click', function() { _rpSetExposed(null, true, 'on'); });
    var en0 = _rpEl('rpExposeNone'); if (en0) en0.addEventListener('click', function() { _rpSetExposed(null, false, 'off'); });
    var rf = _rpEl('rpRefresh'); if (rf) rf.addEventListener('click', _rpRefresh);
    var rk = _rpEl('rpRegenKey'); if (rk) rk.addEventListener('click', function() { _rpSaveCfg({ regenerateKey: true }); });
    var ce = _rpEl('rpCopyEndpoint'); if (ce) ce.addEventListener('click', function() { _rpClip(_rpEl('rpEndpoint').textContent); });
    var ck = _rpEl('rpCopyKey'); if (ck) ck.addEventListener('click', function() { _rpClip((_rpStatus && _rpStatus.apiKey) || _rpEl('rpKey').textContent); });
    var cp = _rpEl('rpCopyProtocol'); if (cp) cp.addEventListener('click', function() { _rpClip(_rpEl('rpProtocolEndpoint').textContent); });
    var pbs = document.querySelectorAll('.rp-proto');
    for (var pi = 0; pi < pbs.length; pi++) pbs[pi].addEventListener('click', function() { _rpProtocol = this.getAttribute('data-proto') || 'openai-chat'; _rpApplyProtocol(); });
    var tp = _rpEl('rpTestProtocol'); if (tp) tp.addEventListener('change', function() { _rpProtocol = tp.value || 'openai-chat'; _rpApplyProtocol(); });
    var tm = _rpEl('rpTestModel'); if (tm) tm.addEventListener('change', _rpUpdateReasoning);
    var tr = _rpEl('rpTestRun'); if (tr) tr.addEventListener('click', _rpTest);
    var fbtns = document.querySelectorAll('.rp-f');
    for (var i = 0; i < fbtns.length; i++) {
      (function(b) {
        b.addEventListener('click', function() {
          _rpFilter = b.getAttribute('data-f') || 'all';
          var all = document.querySelectorAll('.rp-f');
          for (var j = 0; j < all.length; j++) all[j].classList.toggle('add', all[j] === b);
          _rpRenderList();
        });
      })(fbtns[i]);
    }
    var ff = _rpEl('rpFilter'); if (ff) ff.addEventListener('input', _rpRenderList);
    var lst = _rpEl('rpModelList');
    if (lst) {
      lst.addEventListener('mousedown', _rpStartSel);
      lst.addEventListener('mouseover', _rpDragOver);
      lst.addEventListener('click', function (e) {
        if (e.target.classList && e.target.classList.contains('rp-exp')) e.preventDefault();
      }, true);
      document.addEventListener('mouseup', _rpEndSel);
    }
  })();
  function _rpClip(t) { try { navigator.clipboard.writeText(t); _rpSetText('rpStat', '已复制'); } catch (e) {} }
  function _rpTest() {
    var sel = _rpEl('rpTestModel'); var out = _rpEl('rpTestOut');
    var model = sel && sel.value;
    if (!model) { if (out) { out.style.display = 'block'; out.textContent = '无可测模型 · 请先接通渠道'; } return; }
    if (!_rpStatus || !_rpStatus.enabled) { if (out) { out.style.display = 'block'; out.textContent = '请先勾选「启用模型反代」'; } return; }
    var prompt = (_rpEl('rpTestPrompt').value || '你好').trim();
    var key = (_rpStatus && _rpStatus.apiKey) || '';
    var protocol = (_rpEl('rpTestProtocol') && _rpEl('rpTestProtocol').value) || _rpProtocol;
    var selectedModel = _rpSelectedModel();
    var reasoningLevel = (_rpEl('rpTestReasoning') && _rpEl('rpTestReasoning').value) || 'off';
    var path = '/v1/chat/completions';
    var body = { model: model, messages: [{ role: 'user', content: prompt }], stream: false };
    if (protocol === 'openai-responses') { path = '/v1/responses'; body = { model: model, input: prompt, stream: false }; }
    else if (protocol === 'anthropic') { path = '/v1/messages'; body = { model: model, max_tokens: 256, messages: [{ role: 'user', content: prompt }], stream: false }; }
    else if (protocol === 'gemini') { path = '/v1beta/models/' + encodeURIComponent(model) + ':generateContent'; body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }; }
    _rpApplyTestReasoning(body, protocol, reasoningLevel, selectedModel && selectedModel.capabilities);
    if (out) { out.style.display = 'block'; out.textContent = '请求中… (POST ' + path + ' · model=' + model + ' · reasoning=' + reasoningLevel + ')'; }
    fetch(_BASE + path, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'x-api-key': key, 'x-goog-api-key': key },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json().then(function(j) { return { status: r.status, j: j }; }); })
      .then(function(res) {
        if (res.status >= 400) { out.textContent = '✖ HTTP ' + res.status + '\n' + JSON.stringify(res.j, null, 2); return; }
        var c = '';
        if (protocol === 'openai-chat') c = res.j && res.j.choices && res.j.choices[0] && res.j.choices[0].message ? res.j.choices[0].message.content : '';
        else if (protocol === 'openai-responses') c = res.j && (res.j.output_text || (res.j.output && res.j.output[0] && res.j.output[0].content && res.j.output[0].content[0] && res.j.output[0].content[0].text)) || '';
        else if (protocol === 'anthropic') c = res.j && res.j.content && res.j.content[0] ? res.j.content[0].text || '' : '';
        else c = res.j && res.j.candidates && res.j.candidates[0] && res.j.candidates[0].content && res.j.candidates[0].content.parts && res.j.candidates[0].content.parts[0] ? res.j.candidates[0].content.parts[0].text || '' : '';
        out.textContent = '✔ 四协议中转全链路通 (' + protocol + ')\n\n模型: ' + (res.j.model || res.j.modelVersion || model) + '\n回复:\n' + c + '\n\n— 原始 —\n' + JSON.stringify(res.j, null, 2);
      }).catch(function(e) { if (out) out.textContent = '✖ 网络/解析异常: ' + e.message; });
  }

  // ═══ ⑤ 内网穿透 · DAO Bridge (反者道之动 · 把反代端点直暴公网) ═══

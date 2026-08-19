  // ⑧ Codex hot route. This file shares the enclosing webview scope.
  var _codexState = null;
  function _codexEl(id) { return document.getElementById(id); }
  function _codexModels(providerName) {
    var provider = (_providers && _providers[providerName]) || {};
    return (provider.models || provider._models || []).map(function(item) {
      return typeof item === 'string' ? item : String((item && (item.id || item.name || item.model)) || '');
    }).filter(Boolean);
  }
  function _codexFillProviders(selected) {
    var select = _codexEl('codexProvider');
    if (!select) return;
    var wanted = selected || select.value;
    select.innerHTML = '';
    Object.keys(_providers || {}).forEach(function(name) {
      var provider = _providers[name] || {};
      if (provider._builtin) return;
      var option = document.createElement('option');
      option.value = name;
      option.textContent = provider._label || name;
      select.appendChild(option);
    });
    if (wanted && _providers[wanted]) select.value = wanted;
    _codexFillModels(_codexState && _codexState.model);
  }
  function _codexFillModels(selected) {
    var select = _codexEl('codexModel');
    var provider = _codexEl('codexProvider');
    if (!select || !provider) return;
    var wanted = selected || select.value;
    var models = _codexModels(provider.value);
    select.innerHTML = '';
    models.forEach(function(model) {
      var option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });
    if (wanted && models.indexOf(wanted) >= 0) select.value = wanted;
    if (!models.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '请先在②探测该渠道模型';
      select.appendChild(empty);
    }
  }
  function _codexRender(state, preserveForm) {
    _codexState = state || {};
    if (!preserveForm) {
      _codexFillProviders(_codexState.provider);
      if (_codexEl('codexModel') && _codexState.model) _codexEl('codexModel').value = _codexState.model;
      if (_codexEl('codexProtocol')) _codexEl('codexProtocol').value = _codexState.protocol || '';
      if (_codexEl('codexReasoning')) _codexEl('codexReasoning').value = _codexState.reasoningLevel || 'medium';
    }
    if (_codexEl('codexBaseUrl')) _codexEl('codexBaseUrl').textContent = _codexState.baseUrl || '-';
    if (_codexEl('codexEndpoint')) _codexEl('codexEndpoint').textContent = _codexState.endpoint || '-';
    if (_codexEl('codexLocalModel')) _codexEl('codexLocalModel').textContent = _codexState.localModel || '-';
    var observed = _codexState.codexObserved || {};
    if (_codexEl('codexObservedProvider')) _codexEl('codexObservedProvider').textContent = observed.modelProvider || '-';
    if (_codexEl('codexObservedModel')) _codexEl('codexObservedModel').textContent = observed.model || '-';
    if (_codexEl('codexObservedReasoning')) _codexEl('codexObservedReasoning').textContent = observed.reasoningLevel || '-';
    if (_codexEl('codexObservedEndpoint')) _codexEl('codexObservedEndpoint').textContent = [observed.wireApi || '-', observed.baseUrl || '-'].join(' · ');
    var preservation = _codexState.preservation || {};
    if (_codexEl('codexPreservation')) _codexEl('codexPreservation').textContent =
      preservation.authenticationTouched === false && preservation.historyTouched === false
        ? '账号登录与历史会话：保留（插件未触碰认证缓存或会话存储）'
        : '账号与历史保护状态未知';
    var active = !!(_codexState.codexConfigManaged && _codexState.routeActive);
    var runtime = _codexEl('codexRuntime');
    if (runtime) {
      runtime.className = 'codex-runtime ' + (active ? 'active' : (_codexState.enabled ? 'warn' : ''));
      runtime.textContent = active
        ? '当前实际使用：' + (_codexState.provider || '-') + ' / ' + (_codexState.model || '-') + ' · ' + (_codexState.protocol || '跟随渠道') + ' · 思考 ' + (_codexState.reasoningLevel || 'medium')
        : (_codexState.enabled && observed.exists
          ? 'Codex 当前指向 ' + (observed.modelProvider || '-') + ' / ' + (observed.model || '-') + '，与⑧保存的热路由不同。'
          : (_codexState.enabled ? '路由已保存，但 Codex 尚未完成首次接管。' : '尚未接管 Codex。'));
    }
    var status = _codexEl('codexStatus');
    if (status) status.textContent = active ? '已热连接' : '待接管';
    var hint = _codexEl('codexHint');
    if (hint) hint.textContent = active
      ? '后续切换渠道、模型、协议或思考强度立即生效，无需重启 Codex。'
      : '首次应用会备份并更新 ~/.codex/config.toml，随后只需重启 Codex 一次。';
  }
  function _codexLoad() {
    var status = _codexEl('codexStatus');
    if (status) status.textContent = '加载中...';
    return Promise.all([fJson('/origin/ea/overview'), fJson('/origin/codex-hot-route')]).then(function(results) {
      var overview = results[0] || {};
      _providers = overview.providers || _providers;
      _codexRender(results[1] || {});
    }).catch(function(error) {
      if (status) status.textContent = '加载失败：' + error.message;
    });
  }
  function _codexPoll() {
    var pane = _codexEl('paneCodex');
    if (!pane || !pane.classList.contains('active')) return;
    fJson('/origin/codex-hot-route').then(function(state) {
      _codexRender(state || {}, true);
    }).catch(function() {});
  }
  function _codexApply() {
    var provider = _codexEl('codexProvider');
    var model = _codexEl('codexModel');
    if (!provider || !provider.value || !model || !model.value) {
      var status = _codexEl('codexStatus');
      if (status) status.textContent = '请选择已探测到模型的渠道';
      return;
    }
    var button = _codexEl('codexApply');
    if (button) button.disabled = true;
    fPost('/origin/codex-hot-route', {
      provider: provider.value,
      model: model.value,
      protocol: _codexEl('codexProtocol').value,
      reasoningLevel: _codexEl('codexReasoning').value
    }).then(function(result) {
      return _codexLoad().then(function() {
        var status = _codexEl('codexStatus');
        if (status) status.textContent = result.codex && result.codex.restartRequired
          ? '接管成功，请重启 Codex 一次'
          : '热更新成功，无需重启';
      });
    }).catch(function(error) {
      var status = _codexEl('codexStatus');
      if (status) status.textContent = '应用失败：' + error.message;
    }).then(function() { if (button) button.disabled = false; });
  }
  function _codexApplyProvider(providerName, trigger) {
    var models = _codexModels(providerName);
    var observedModel = _codexState && _codexState.codexObserved && _codexState.codexObserved.model;
    var currentModel = (_codexState && _codexState.model) || observedModel || '';
    var model = models.indexOf(currentModel) >= 0 ? currentModel : (models[0] || '');
    if (!model) {
      _daoToast('渠道 ' + providerName + ' 尚未探测到模型');
      return;
    }
    if (trigger) trigger.textContent = '切换中…';
    fPost('/origin/codex-hot-route', {
      provider: providerName,
      model: model,
      protocol: '',
      reasoningLevel: (_codexState && _codexState.reasoningLevel) || 'high'
    }).then(function(result) {
      _daoToast(result.codex && result.codex.restartRequired
        ? '已设为 Codex 上游；首次接管请重启 Codex 一次'
        : 'Codex 已热切换到 ' + providerName + ' / ' + model);
      return _codexLoad();
    }).catch(function(error) {
      _daoToast('Codex 切换失败: ' + error.message);
    }).then(function() {
      if (trigger) trigger.textContent = '⑧Codex';
    });
  }
  var _codexProviderEl = _codexEl('codexProvider');
  var _codexApplyEl = _codexEl('codexApply');
  var _codexRefreshEl = _codexEl('codexRefresh');
  if (_codexProviderEl) _codexProviderEl.addEventListener('change', function() { _codexFillModels(''); });
  if (_codexApplyEl) _codexApplyEl.addEventListener('click', _codexApply);
  if (_codexRefreshEl) _codexRefreshEl.addEventListener('click', _codexLoad);
  setInterval(_codexPoll, 3000);

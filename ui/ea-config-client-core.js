
(function() {
  'use strict';
  var _PORT = __DAO_PORT__;
  var _BASE = 'http://127.0.0.1:' + _PORT;
  // 归一(dao-one)折入模式: ⑤ 内网穿透复用二合一本源「🌐 内网穿透」板块的同一条共享隧道,
  //   不重复起第二条 cloudflared (道并行而不相悖)。带 ?shared=1 让后端优先回显共享隧道公网 URL。
  var _FOLD = __DAO_FOLD__;
  var _BRG_TP = '/origin/revproxy/tunnel' + (_FOLD ? '?shared=1' : '');

  function fJson(p, opts) {
    opts = opts || {};
    return fetch(_BASE + p, Object.assign({ cache: 'no-store' }, opts))
      .then(function(r) { return r.text().then(function(text){ var data=null; try{data=text?JSON.parse(text):{};}catch(error){} if(!r.ok)throw new Error((data&&data.error)||text||('http '+r.status)); return data||{}; }); });
  }
  function fPost(p, body) {
    return fJson(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  function fDel(p) {
    return fetch(_BASE + p, { method: 'DELETE', cache: 'no-store' })
      .then(function(r) { return r.text().then(function(text){ var data=null; try{data=text?JSON.parse(text):{};}catch(error){} if(!r.ok)throw new Error((data&&data.error)||text||('http '+r.status)); return data||{}; }); });
  }
  function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  // ── 状态 ──
  var _config = null;
  var _providers = {};        // overview.providers (含内置 builtin-stub 测试通道)
  var _routes = {};
  var _routeRuntime = {};
  var _health = {};
  var _selectedLeft = null;
  var _selectedRight = null;
  // ★ 加 Key 即自动全量识别 · 已配/预设渠道首载自动热探一次 (cc-switch 风 · 道法自然)
  var _autoDiscDone = false;   // 本会话仅自动热探一轮 (防回环)
  // ★ v9.9.288 · 面板③ 排序/对齐偏好 (localStorage 持久 · 前端操作)
  var _alignMode = false;       // 1:1 对齐开关
  var _alignRightSeq = [];      // 对齐模式下右侧应跟随的 provider/model 顺序 (renderLeft 产出)
  var _wireRAF = 0;             // 连线重绘 rAF 节流句柄
  var _ordLeftGroups = [];      // 左侧大板块(provider分组)顺序
  var _ordRightProv = [];       // 右侧渠道顺序
  var _ordLeftFam = {};         // 左侧每组内家族顺序 {provLabel:[familyUid...]}
  var _ordRightMod = {};        // 右侧每渠道内模型顺序 {provName:[model...]}
  (function _loadOrderPrefs() {
    try {
      var s = JSON.parse(localStorage.getItem('dao.router.order') || '{}');
      _alignMode = !!s.align;
      _ordLeftGroups = Array.isArray(s.lg) ? s.lg : [];
      _ordRightProv = Array.isArray(s.rp) ? s.rp : [];
      _ordLeftFam = (s.lf && typeof s.lf === 'object') ? s.lf : {};
      _ordRightMod = (s.rm && typeof s.rm === 'object') ? s.rm : {};
    } catch (e) {}
  })();
  function _saveOrderPrefs() {
    try {
      localStorage.setItem('dao.router.order', JSON.stringify({
        align: _alignMode, lg: _ordLeftGroups, rp: _ordRightProv, lf: _ordLeftFam, rm: _ordRightMod
      }));
    } catch (e) {}
  }
  // 按已存顺序排列 keys · 未知项保持原序追加 (新增模型不丢)
  function _applyOrder(keys, saved) {
    if (!saved || !saved.length) return keys.slice();
    var out = [], seen = {};
    saved.forEach(function(k) { if (keys.indexOf(k) >= 0 && !seen[k]) { out.push(k); seen[k] = 1; } });
    keys.forEach(function(k) { if (!seen[k]) { out.push(k); seen[k] = 1; } });
    return out;
  }
  // 把 fromKey 移到 toKey 之前/之后 · 返回新数组
  function _reorder(arr, fromKey, toKey, after) {
    arr = arr.slice();
    var fi = arr.indexOf(fromKey);
    if (fi < 0) return arr;
    arr.splice(fi, 1);
    var ti = arr.indexOf(toKey);
    if (ti < 0) return arr;
    arr.splice(after ? ti + 1 : ti, 0, fromKey);
    return arr;
  }
  function _splitPM(k) { var i = String(k).indexOf('/'); return { prov: k.slice(0, i), model: k.slice(i + 1) }; }
  // ── HTML5 拖拽重排 (长按拖动·click=选路不受影响) ──
  var _dragKey = null, _dragScope = null;
  function _clearDragOver() {
    var els = document.querySelectorAll('.drag-over, .drag-over-after');
    for (var i = 0; i < els.length; i++) { els[i].classList.remove('drag-over'); els[i].classList.remove('drag-over-after'); }
  }
  function _dnd(el, key, scope, onReorder) {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', function(ev) {
      _dragKey = key; _dragScope = scope; el.classList.add('dragging');
      try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(key)); } catch (e) {}
    });
    el.addEventListener('dragend', function() { el.classList.remove('dragging'); _clearDragOver(); _dragKey = null; _dragScope = null; });
    el.addEventListener('dragover', function(ev) {
      if (_dragScope !== scope || _dragKey === key) return;
      ev.preventDefault();
      var r = el.getBoundingClientRect();
      var after = (ev.clientY - r.top) > r.height / 2;
      el.classList.toggle('drag-over', !after);
      el.classList.toggle('drag-over-after', after);
    });
    el.addEventListener('dragleave', function() { el.classList.remove('drag-over'); el.classList.remove('drag-over-after'); });
    el.addEventListener('drop', function(ev) {
      if (_dragScope !== scope || _dragKey === key) { _clearDragOver(); return; }
      ev.preventDefault();
      var r = el.getBoundingClientRect();
      var after = (ev.clientY - r.top) > r.height / 2;
      var fk = _dragKey;
      _clearDragOver();
      if (fk != null) onReorder(fk, key, after);
    });
  }
  function _scheduleWires() {
    if (_wireRAF) return;
    _wireRAF = requestAnimationFrame(function() { _wireRAF = 0; try { renderWires(); } catch (e) {} });
  }
  // ★ v9.9.266 · 三模块面板 ③模型路由 与悬浮面板 eaRender 同源:
  //   统一走 /origin/ea/overview → official_families (49 家族·档位归一) + providers(首项=测试通道)
  //   反者道之动: 左侧不再着相于扁平 catalog 怪名 · 万物并育而不相害
  var _families = [];         // official_families: [{familyUid,label,provider,members:[{modelUid,tier,isDefault}],isNew,isRecommended}]
  var _tierGroups = {};       // primaryUid -> [memberUids]  (一族多档共用一条路由作用域)

  // ── cc-switch 预设库 (与悬浮面板 同源) ──
  //   字段: n=名, t=协议(openai|anthropic), u=Base URL, r=注册/官网(去拿 APIKey)
  //   ★ v9.9.311 · 预设不再内置具体模型: 填 Key 添加后自动 /v1/models 全量识别该渠道所有模型 (无为而无不为)
  //   太上下知有之: 用户只需「选渠道 → 点🌐去注册拿 Key → 填 Key」三步. 国内外主流尽收.
  var _PRESETS = [
    // ── 测试/聚合 ──
    {n:'FreeModel(CC)',t:'anthropic',u:'https://cc.freemodel.dev',r:'https://cc.freemodel.dev'},
    {n:'OpenRouter (聚合)',t:'openai',u:'https://openrouter.ai/api/v1',r:'https://openrouter.ai/keys'},
    {n:'AiHubMix (聚合)',t:'openai',u:'https://aihubmix.com/v1',r:'https://aihubmix.com/token'},
    // ── 国内主流 ──
    {n:'DeepSeek 深度求索',t:'openai',u:'https://api.deepseek.com/v1',r:'https://platform.deepseek.com/api_keys'},
    {n:'小米 MiMo (Xiaomi)',t:'openai',u:'https://api.xiaomimimo.com/v1',r:'https://platform.xiaomimimo.com'},
    {n:'智谱 GLM (Zhipu)',t:'openai',u:'https://open.bigmodel.cn/api/paas/v4',r:'https://open.bigmodel.cn/usercenter/apikeys'},
    {n:'Kimi 月之暗面 (Moonshot)',t:'openai',u:'https://api.moonshot.cn/v1',r:'https://platform.moonshot.cn/console/api-keys'},
    {n:'阿里云百炼 通义千问 (Bailian)',t:'openai',u:'https://dashscope.aliyuncs.com/compatible-mode/v1',r:'https://bailian.console.aliyun.com/?apiKey=1'},
    {n:'字节 豆包 火山方舟 (Doubao/Ark)',t:'openai',u:'https://ark.cn-beijing.volces.com/api/v3',r:'https://console.volcengine.com/ark'},
    {n:'腾讯 混元 (Hunyuan)',t:'openai',u:'https://api.hunyuan.cloud.tencent.com/v1',r:'https://console.cloud.tencent.com/hunyuan/api-key'},
    {n:'百度 文心千帆 (Qianfan)',t:'openai',u:'https://qianfan.baidubce.com/v2',r:'https://console.bce.baidu.com/iam/#/iam/apikey/list'},
    {n:'硅基流动 (SiliconFlow)',t:'openai',u:'https://api.siliconflow.cn/v1',r:'https://cloud.siliconflow.cn/account/ak'},
    {n:'魔搭 ModelScope',t:'openai',u:'https://api-inference.modelscope.cn/v1',r:'https://modelscope.cn/my/myaccesstoken'},
    {n:'MiniMax 稀宇',t:'openai',u:'https://api.minimaxi.com/v1',r:'https://platform.minimaxi.com/user-center/basic-information/interface-key'},
    {n:'讯飞星火 (iFlytek Spark)',t:'openai',u:'https://spark-api-open.xf-yun.com/v1',r:'https://console.xfyun.cn/services/cbm'},
    {n:'阶跃星辰 (StepFun)',t:'openai',u:'https://api.stepfun.com/v1',r:'https://platform.stepfun.com/interface-key'},
    {n:'零一万物 (01.AI Yi)',t:'openai',u:'https://api.lingyiwanwu.com/v1',r:'https://platform.lingyiwanwu.com/apikeys'},
    {n:'百川 (Baichuan)',t:'openai',u:'https://api.baichuan-ai.com/v1',r:'https://platform.baichuan-ai.com/console/apikey'},
    // ── 国际主流 ──
    {n:'OpenAI',t:'openai',u:'https://api.openai.com/v1',r:'https://platform.openai.com/api-keys'},
    {n:'Anthropic Claude',t:'anthropic',u:'https://api.anthropic.com',r:'https://console.anthropic.com/settings/keys'},
    {n:'Google Gemini',t:'openai',u:'https://generativelanguage.googleapis.com/v1beta/openai',r:'https://aistudio.google.com/apikey'},
    {n:'xAI Grok',t:'openai',u:'https://api.x.ai/v1',r:'https://console.x.ai'},
    {n:'Groq (极速)',t:'openai',u:'https://api.groq.com/openai/v1',r:'https://console.groq.com/keys'},
    {n:'Mistral',t:'openai',u:'https://api.mistral.ai/v1',r:'https://console.mistral.ai/api-keys'},
    {n:'Together AI',t:'openai',u:'https://api.together.xyz/v1',r:'https://api.together.xyz/settings/api-keys'},
    {n:'Fireworks AI',t:'openai',u:'https://api.fireworks.ai/inference/v1',r:'https://fireworks.ai/account/api-keys'},
    {n:'Perplexity',t:'openai',u:'https://api.perplexity.ai',r:'https://www.perplexity.ai/settings/api'},
    // ── 本地 ──
    {n:'Ollama (本地)',t:'openai',u:'http://localhost:11434/v1',r:'https://ollama.com/download'},
  ];

  // ── provider 名 → 友好显示 (与 eaRender _provLabel 同) ──
  function _provLabel(p) {
    p = String(p || '').replace(/^MODEL_PROVIDER_/, '');
    var M = {ANTHROPIC:'Claude',OPENAI:'GPT',GOOGLE:'Gemini',WINDSURF:'Windsurf',XAI:'Grok',DEEPSEEK:'DeepSeek',MOONSHOT:'Kimi',MOONSHOT_AI:'Kimi',FIREWORKS:'Fireworks',ZHIPU:'GLM',ZHIPU_AI:'GLM',MINIMAX:'Minimax'};
    return M[p] || (p ? p.charAt(0) + p.slice(1).toLowerCase() : 'Other');
  }

  // ── 加载配置 · v9.9.266 一站式 overview (与悬浮面板同源) ──
  // v9.9.272 · 失败安全 · 后端启动期/端口未就绪自动重试 · 不硬报 404
  //   柔弱胜刚强: 后端不可用时官方模型仍正常 · 面板只提示"启动中"而非"加载失败"
  var _loadTries = 0;
  function loadConfig() {
    return fJson('/origin/ea/overview').then(function(d) {
      if (!d || !d.ok) throw new Error('overview 未就绪');
      _loadTries = 0;
      _config = d;
      _providers = d.providers || {};
      _routes = d.routes || {};
      _routeRuntime = d.route_runtime || {};
      _families = d.official_families || [];
      _refreshSharedModelSuggestions();
      render();
      _autoDiscoverAll();
    }).catch(function(e) {
      _loadTries++;
      var st = document.getElementById('statusText');
      if (_loadTries <= 20) {
        if (st) st.textContent = '后端启动中 · 自动重试(' + _loadTries + ')…';
        setTimeout(loadConfig, 1500);
      } else if (st) {
        st.textContent = '后端未就绪 · 官方模型不受影响 (' + e.message + ')';
      }
    });
  }

  // ── 加 Key 即自动全量识别模型 (已配/预设渠道首载自动热探一轮) ──
  //   道: 无为而无不为 · 用户只填 Key → 系统自动 /v1/models 全量解出该渠道所有模型
  //   背景串行 (节流·不阻 UI)·失败不断流·全部完成后 loadConfig 一次刷新到视图
  //   后端 hotListProviderModels 已持久化解出结果 → 仅本会话探一轮即长效
  function _autoDiscoverAll() {
    if (_autoDiscDone) return;
    _autoDiscDone = true;
    var names = Object.keys(_providers).filter(function(n) {
      var p = _providers[n];
      return p && !p._builtin && p.apiKey; // 有 Key 的外接渠道 (overview 中 apiKey 已脱敏但非空)
    });
    if (!names.length) return;
    var i = 0, changed = false;
    function next() {
      if (i >= names.length) { if (changed) loadConfig(); return; }
      var n = names[i++];
      fJson('/origin/ea/models/' + encodeURIComponent(n) + '?refresh=1').then(function(r) {
        if (r && r.ok && r.models && r.models.length) changed = true;
      }).catch(function() {}).then(function() { setTimeout(next, 150); });
    }
    next();
  }

  // ── 渲染 ──
  function render() {
    renderChannels();
    renderLeft();
    renderRight();
    renderWires();
    renderStatus();
    renderRouteRuntime();
    renderBridgeRouteSync();
  }

  function renderBridgeRouteSync() {
    var box = document.getElementById('bridgeRouteSync');
    if (!box) return;
    var seen = {}, rows = [];
    Object.keys(_routes || {}).forEach(function(uid) {
      var route = _routes[uid] || {};
      if (!route._bridgeManaged || seen[route._bridgeId || uid]) return;
      seen[route._bridgeId || uid] = true;
      rows.push('<span class="pb-badge">' + _rpEsc(uid) + '</span> → ' + _rpEsc(route.provider) + '/' + _rpEsc(route.model) + ' · ' + _rpEsc((route._targetProtocols || []).join(' + ')));
    });
    box.style.display = rows.length ? 'block' : 'none';
    box.innerHTML = rows.length ? ('<b>⑥ 协议中转同步路由</b><br>' + rows.join('<br>')) : '';
  }

  function renderRouteRuntime() {
    var box = document.getElementById('routeRuntimeBanner');
    if (!box) return;
    var rows = Object.keys(_routeRuntime || {}).map(function(uid) {
      var item = _routeRuntime[uid] || {};
      return { uid: uid, item: item, at: Date.parse(item.updatedAt || '') || 0 };
    }).sort(function(a, b) { return b.at - a.at; });
    var latest = rows[0];
    if (!latest) { box.textContent = '当前实际路由 · 尚无请求记录'; return; }
    var item = latest.item;
    if (item.state === 'failed') {
      box.innerHTML = '<b>当前实际路由</b> · <span style="color:#e08080">全部渠道失败</span> · ' + latest.uid;
      return;
    }
    var suffix = item.channelStrategy === 'random'
      ? ' · 随机首选（会话内保持）'
      : (item.fallback ? ' · 备用渠道接管' : ' · 主渠道');
    box.innerHTML = '<b>当前实际路由</b> · ' + latest.uid + ' → <span style="color:#6bb86b">' +
      _routeEsc(item.provider) + '/' + _routeEsc(item.model) + '</span> · ' +
      _routeEsc(item.protocol || 'auto') + ' · 思考 ' + _routeEsc(_REASONING_LABELS[item.reasoningLevel] || item.reasoningLevel || '模型默认') + suffix;
  }

  function _routeEsc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
  }

  function _refreshSharedModelSuggestions() {
    var list = document.getElementById('sharedModelSuggestions');
    if (!list) return;
    var values = [];
    Object.keys(_providers || {}).forEach(function(name) {
      ((_providers[name] && (_providers[name].models || _providers[name]._models)) || []).forEach(function(model) {
        if (values.indexOf(model) < 0) values.push(model);
      });
    });
    Object.keys((_config && _config.custom_models) || {}).forEach(function(id) {
      if (values.indexOf(id) < 0) values.push(id);
    });
    list.innerHTML = values.sort().map(function(value) { return '<option value="' + _routeEsc(value) + '"></option>'; }).join('');
  }

  // ── token 数格式化 (K/M) · 用量行用 ──
  function _fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/.0$/, '') + 'K';
    return String(n);
  }

  // ── 路由命中判定: uid 双形归一 (MODEL_X_Y ↔ x-y 视为同一) ──
  function _norm(uid) { return String(uid || '').replace(/^MODEL_/, '').replace(/_/g, '-').toLowerCase(); }
  function _routeKeyFor(uid) {
    var n = _norm(uid), ks = Object.keys(_routes);
    for (var i = 0; i < ks.length; i++) { if (_norm(ks[i]) === n) return ks[i]; }
    return null;
  }
  function _routeFor(uid) { var k = _routeKeyFor(uid); return k ? _routes[k] : null; }
  function _routeReasoningLevel(route) {
    if (!route) return 'default';
    var level = String(route.reasoningLevel || route.reasoningEffort || '').trim().toLowerCase();
    if (level) return level;
    return route.thinkingEnabled ? 'auto' : 'default';
  }
  function _routeReasoningLabel(route) {
    var level = _routeReasoningLevel(route);
    return (_REASONING_LABELS && _REASONING_LABELS[level]) || (level === 'default' ? '模型默认' : level);
  }

  // ── ② 渠道配置: cc-switch 风已配渠道列表 (内置测试通道置顶·不可删) ──
  function renderChannels() {
    var box = document.getElementById('channelList');
    if (!box) return;
    box.innerHTML = '';
    var names = Object.keys(_providers);
    if (names.length === 0) {
      box.innerHTML = '<div style="opacity:0.4;font-style:italic;padding:6px">暂无渠道 · 选预设或手动添加</div>';
      return;
    }
    names.forEach(function(name) {
      var p = _providers[name] || {};
      var builtin = !!p._builtin;
      var disp = p._label || name;
      var h = _health[name];
      var alive = h && h.alive === true;
      // 绿=探活通; 红=探活失败(key无效/不可达); 灰=尚未探测或结果未知(alive==null)
      var dotColor = builtin ? '#6bb86b'
        : (alive ? '#6bb86b'
          : ((h && h.alive === false) ? '#e08080' : 'rgba(128,128,128,0.4)'));
      var mods = (p.models || p._models || []).join(', ');
      var customCount = Object.keys((_config && _config.custom_models) || {}).filter(function(id){ return _config.custom_models[id] && _config.custom_models[id].provider === name; }).length;
      // ★ v9.9.301 · 用量行 (overview 注入 p.usage) · 最核心信息: 次数 + token + 估算成本
      var usageLine = '';
      var us = p.usage;
      if (us && us.calls) {
        var costStr = (us.cost != null) ? (' · ≈' + (us.currency === 'USD' ? '$' : '') + us.cost + (us.currency && us.currency !== 'USD' ? (' ' + us.currency) : '')) : '';
        usageLine = '<div style="font-size:9px;opacity:0.6">▦ ' + us.calls + ' 次 · ' + _fmtTok(us.total) + ' tok (入' + _fmtTok(us.input) + '/出' + _fmtTok(us.output) + ')' + costStr + '</div>';
        // ★ 缓存命中行: 命中率% + 命中 tok (+ 缓存写入 tok · Anthropic)
        var hr = Number(us.hitRate) || 0;
        var cachedTok = Number(us.cached) || 0;
        var recent = us.recent || {};
        var recentCalls = Number(recent.calls) || 0;
        var recentRate = Number(recent.hitRate) || 0;
        var recentStr = recentCalls > 0 ? (' · 近' + recentCalls + '次 ' + recentRate + '%') : '';
        if (cachedTok > 0 || hr > 0) {
          var hrColor = hr >= 50 ? '#6bb86b' : (hr >= 20 ? '#c9a94f' : '#e08080');
          var cwStr = (Number(us.cacheWrite) || 0) > 0 ? (' · 写' + _fmtTok(us.cacheWrite)) : '';
          usageLine += '<div style="font-size:9px;opacity:0.75">◈ 缓存累计 <span style="color:' + hrColor + ';font-weight:600">' + hr + '%</span>' + recentStr + ' · ' + _fmtTok(cachedTok) + ' tok' + cwStr + '</div>';
        } else {
          usageLine += '<div style="font-size:9px;opacity:0.4">◈ 缓存累计 0%' + recentStr + ' · 无缓存复用</div>';
        }
      }
      var row = document.createElement('div');
      row.className = 'model-item';
      row.style.cssText = 'align-items:flex-start;padding:6px;margin-bottom:4px;border:1px solid rgba(128,128,128,0.18);border-radius:4px;';
      var html = '<span class="dot" style="background:' + dotColor + ';margin-top:4px"></span>' +
        '<span style="flex:1;overflow:hidden">' +
          '<span style="font-weight:600">' + _escHtml(disp) + (builtin ? ' <span style="opacity:0.5;font-weight:400">· 内置</span>' : '') + (p._bridgeManaged ? ' <span class="pb-badge">协议中转</span>' : '') + '</span>' +
          '<div style="font-size:9px;opacity:0.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _escHtml(p.baseUrl || '') + '</div>' +
          (mods ? '<div style="font-size:9px;opacity:0.5">' + _escHtml(mods) + '</div>' : '') +
          (customCount ? '<div style="font-size:9px;color:#6bb86b">⑦ 自定义模型 ' + customCount + ' 个 · 已同步③④⑥</div>' : '') +
          usageLine +
        '</span>';
      if (p._bridgeManaged) {
        html += '<span class="btn" data-openbridge="' + _escHtml(p._bridgeId || '') + '" style="padding:1px 5px;font-size:10px" title="到⑥协议中转站管理">⑥管理</span>';
      } else if (!builtin) {
        html += '<span class="btn" data-codex-provider="' + _escHtml(name) + '" style="padding:1px 5px;font-size:10px;margin-right:3px" title="将该渠道设为 Codex 当前上游">⑧Codex</span>' +
          '<span class="btn" data-customize="' + _escHtml(name) + '" style="padding:1px 5px;font-size:10px;margin-right:3px" title="用该渠道创建或扩展⑦自定义多渠道模型">⑦模型</span>' +
          '<span class="btn" data-edit="' + _escHtml(name) + '" style="padding:1px 5px;font-size:10px;margin-right:3px" title="编辑">✎</span>' +
          '<span class="btn del" data-del="' + _escHtml(name) + '" title="删除">x</span>';
      }
      row.innerHTML = html;
      box.appendChild(row);
    });
    box.querySelectorAll('[data-del]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var n = this.getAttribute('data-del');
        _daoConfirm('删除渠道 ' + n + '? (关联路由也会删除)').then(function(ok2) {
          if (!ok2) return;
          fDel('/origin/ea/provider/' + encodeURIComponent(n)).then(function(r) { if (r.ok) loadConfig(); });
        });
      });
    });
    box.querySelectorAll('[data-edit]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var n = this.getAttribute('data-edit');
        var p = _providers[n] || {};
        document.getElementById('provName').value = n;
        document.getElementById('provUrl').value = (p.baseUrl || '');
        // ★ 修「编辑渠道→Key 看不见/疑似丢失」: 不把脱敏 key 写回输入框(回传会覆盖真实key),
        //   而是用占位提示已配置 · 留空提交=后端保留原 Key (见 hotAddProvider apiKey 保全)
        var _kInput = document.getElementById('provKey');
        _kInput.value = '';
        var _hasKey = !!(p.apiKey && String(p.apiKey).length > 0);
        _kInput.placeholder = _hasKey ? '已配置 Key · 留空=保留原 Key, 或输入新 Key 覆盖' : 'API Key';
        document.getElementById('provModels').value = (p.models || p._models || []).join(', ');
        document.getElementById('provProtocol').value = p.protocol || '';
      });
    });
    box.querySelectorAll('[data-customize]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var name = this.getAttribute('data-customize');
        var provider = _providers[name] || {};
        var tab = document.querySelector('.dao-tab[data-pane="paneCustomModel"]');
        if (tab) tab.click();
        if (typeof _cmStartFromProvider === 'function') _cmStartFromProvider(name, (provider.models || provider._models || [])[0] || '');
      });
    });
    box.querySelectorAll('[data-codex-provider]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var name = this.getAttribute('data-codex-provider');
        if (typeof _codexApplyProvider === 'function') _codexApplyProvider(name, this);
      });
    });
    box.querySelectorAll('[data-openbridge]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tab = document.querySelector('.dao-tab[data-pane="paneProtocolBridge"]');
        if (tab) tab.click();
        _pbLoad(this.getAttribute('data-openbridge'));
      });
    });
  }

  // ── 构建单个官方家族条目 (含点选/双击解路 · 复用于分组与对齐两种布局) ──
  function _buildLeftItem(f) {
    var uids = f.members.map(function(mm){ return mm.modelUid; }).filter(Boolean);
    var defMember = f.members.filter(function(mm){ return mm.isDefault; })[0] || f.members[0];
    var primary = (defMember && defMember.modelUid) || uids[0] || f.familyUid;
    _tierGroups[primary] = uids;
    var wiredUids = uids.filter(function(u){ return !!_routeFor(u); });
    var isWired = wiredUids.length > 0;
    var route = isWired ? _routeFor(wiredUids[0]) : null;
    var routeKeys = [];
    wiredUids.forEach(function(routeUid) { var routeKey = _routeKeyFor(routeUid); if (routeKey && routeKeys.indexOf(routeKey) < 0) routeKeys.push(routeKey); });
    var reasoningLevels = wiredUids.map(function(routeUid) { return _routeReasoningLevel(_routeFor(routeUid)); }).filter(function(level, index, all) { return all.indexOf(level) === index; });
    var target = route ? (route.provider + '/' + route.model) : '';
    var div = document.createElement('div');
    div.className = 'model-item' + (_selectedLeft === primary ? ' selected' : '');
    div.setAttribute('data-uid', primary);
    div.setAttribute('data-uids', uids.join(','));
    div.setAttribute('data-fam', f.familyUid || primary);
    var html = (_alignMode ? '' : '<span class="drag-handle">⋮⋮</span>') +
      '<span class="dot ' + (isWired ? 'routed' : 'unrouted') + '"></span>' +
      '<span class="name" title="' + f.label + (f.members.length > 1 ? ' · ' + f.members.length + '档' : '') + '">' + f.label + '</span>';
    if (f.members.length > 1) {
      html += '<span class="target" title="' + f.members.map(function(mm){ return (mm.tier || 'base') + (_routeFor(mm.modelUid) ? ' ✓' : ''); }).join(' · ') + '">×' + f.members.length + '</span>';
    }
    if (target) {
      html += '<span class="route-reasoning" title="当前路由思考强度">思考 ' + (reasoningLevels.length > 1 ? '混合' : _routeReasoningLabel(route)) + '</span>';
      html += '<span class="target">' + target + '</span>';
      html += '<button type="button" class="route-edit-btn" title="编辑路由、模型与思考强度">编辑</button>';
    }
    div.innerHTML = html;
    var editButton = div.querySelector('.route-edit-btn');
    if (editButton) editButton.addEventListener('click', function(event) {
      event.stopPropagation();
      var routeKey = routeKeys[0];
      if (routeKey) openRouteModal(routeKey, null, null, routeKeys);
    });
    div.addEventListener('click', function() {
      _selectedLeft = this.getAttribute('data-uid');
      render();
      maybeAutoRoute();
    });
    div.addEventListener('dblclick', function() {
      var u = this.getAttribute('data-uid');
      var uds = (this.getAttribute('data-uids') || u).split(',').filter(Boolean);
      var keys = [];
      uds.forEach(function(x){ var k = _routeKeyFor(x); if (k && keys.indexOf(k) < 0) keys.push(k); });
      if (keys.length > 0) {
        _daoConfirm('断开 ' + f.label + ' 全部 ' + keys.length + ' 条路由?').then(function(ok2) {
          if (!ok2) return;
          Promise.all(keys.map(function(k){ return fDel('/origin/ea/route/' + encodeURIComponent(k)); })).then(function(){ loadConfig(); });
        });
      } else {
        openRouteModal(u);
      }
    });
    return { el: div, primary: primary, isWired: isWired, route: route };
  }

  function renderLeft() {
    var container = document.getElementById('officialModels');
    container.innerHTML = '';
    _tierGroups = {};
    _alignRightSeq = [];
    // ★ v9.9.266 · 档位归一: 一族一项 (同 Cascade 顶层) · 按 provider 分组标题
    if (!_families || _families.length === 0) {
      container.innerHTML = '<div style="opacity:0.4;font-style:italic;padding:6px">加载中...</div>';
      return;
    }
    var groups = {}, order = [];
    _families.forEach(function(f) {
      var pl = _provLabel(f.provider);
      if (!groups[pl]) { groups[pl] = []; order.push(pl); }
      groups[pl].push(f);
    });
    order = _applyOrder(order, _ordLeftGroups);

    // ★ v9.9.288 · 1:1 对齐模式: 扁平展开 · 已路由家族在前(决定右侧顺序) · 未路由在后
    if (_alignMode) {
      var routedL = [], unroutedL = [];
      order.forEach(function(pl) {
        var fams = _applyOrder(groups[pl].map(function(f){ return f.familyUid; }), _ordLeftFam[pl]);
        fams.forEach(function(fk) {
          var f = groups[pl].filter(function(x){ return x.familyUid === fk; })[0];
          if (!f) return;
          var item = _buildLeftItem(f);
          if (item.isWired && item.route) routedL.push(item); else unroutedL.push(item);
        });
      });
      routedL.forEach(function(item) { container.appendChild(item.el); _alignRightSeq.push(item.route.provider + '/' + item.route.model); });
      unroutedL.forEach(function(item) { container.appendChild(item.el); });
      return;
    }

    // ── 默认分组模式: 大板块(分组头)+ 小模型(家族)均可拖拽重排 ──
    order.forEach(function(pl) {
      var head = document.createElement('div');
      head.className = 'prov-head';
      head.style.cssText = 'font-size:10px;opacity:0.5;margin:6px 0 2px;font-weight:600;';
      head.innerHTML = '<span class="drag-handle">⋮⋮</span>' + pl + ' (' + groups[pl].length + ')';
      _dnd(head, pl, 'leftGroup', function(fk, tk, after) {
        _ordLeftGroups = _reorder(order, fk, tk, after); _saveOrderPrefs(); render();
      });
      container.appendChild(head);
      var fams = _applyOrder(groups[pl].map(function(f){ return f.familyUid; }), _ordLeftFam[pl]);
      fams.forEach(function(fk) {
        var f = groups[pl].filter(function(x){ return x.familyUid === fk; })[0];
        if (!f) return;
        var item = _buildLeftItem(f);
        (function(plKey, famOrder) {
          _dnd(item.el, f.familyUid, 'leftFam:' + plKey, function(ff, tt, after) {
            _ordLeftFam[plKey] = _reorder(famOrder, ff, tt, after); _saveOrderPrefs(); render();
          });
        })(pl, fams);
        container.appendChild(item.el);
      });
    });
  }

  // ── 构建单个外接模型条目 (含点选/双击编辑路由 · 复用于分组与对齐两种布局) ──
  function _buildRightItem(name, m) {
    var key = name + '/' + m;
    var wired = false;
    var providerCfg = _providers[name] || {};
    var capability = providerCfg.modelCapabilities && providerCfg.modelCapabilities[m];
    var customRecord = null;
    var customMap = (_config && _config.custom_models) || {};
    Object.keys(customMap).some(function(id){ var record=customMap[id]; if(record && record.provider===name && record.upstreamModel===m){customRecord=record;return true;}return false; });
    for (var ru in _routes) { var rt = _routes[ru]; if (rt && rt.provider === name && rt.model === m) { wired = true; break; } }
    var div = document.createElement('div');
    div.className = 'model-item' + (_selectedRight === key ? ' selected' : '');
    div.innerHTML = (_alignMode ? '' : '<span class="drag-handle">⋮⋮</span>') +
      '<span class="dot ' + (wired ? 'routed' : 'unrouted') + '"></span><span class="name">' + m + (customRecord?' <span class="pb-badge">⑦自定义</span>':'') + (capability&&capability.supportsThinking?' <span class="pb-badge">思考 '+capability.reasoningLevels.length+'档</span>':'') + '</span>';
    div.setAttribute('data-prov', name);
    div.setAttribute('data-model', m);
    div.addEventListener('click', function() {
      _selectedRight = this.getAttribute('data-prov') + '/' + this.getAttribute('data-model');
      render();
      maybeAutoRoute();
    });
    div.addEventListener('dblclick', function() {
      openRouteModal(null, this.getAttribute('data-prov'), this.getAttribute('data-model'));
    });
    return div;
  }

  function renderRight() {
    var container = document.getElementById('externalModels');
    container.innerHTML = '';
    // ★ v9.9.266 · 外接首项 = 内置测试通道(builtin-stub) · 其余 = 用户渠道 · 与悬浮面板同
    var provOrder = _applyOrder(Object.keys(_providers), _ordRightProv);

    // ★ v9.9.288 · 1:1 对齐模式: 扁平展开 · 按左侧已路由顺序对齐(同行水平直线) · 其余在后
    if (_alignMode) {
      var all = [];
      provOrder.forEach(function(name) {
        var prov = _providers[name] || {};
        var models = prov.models || prov._models || [];
        _applyOrder(models, _ordRightMod[name]).forEach(function(m) { all.push(name + '/' + m); });
      });
      var used = {};
      _alignRightSeq.forEach(function(k) {
        if (all.indexOf(k) >= 0 && !used[k]) { used[k] = 1; var pm = _splitPM(k); container.appendChild(_buildRightItem(pm.prov, pm.model)); }
      });
      all.forEach(function(k) {
        if (!used[k]) { used[k] = 1; var pm = _splitPM(k); container.appendChild(_buildRightItem(pm.prov, pm.model)); }
      });
      return;
    }

    // ── 默认分组模式: 渠道(分组头)+ 模型均可拖拽重排 ──
    provOrder.forEach(function(name) {
      var prov = _providers[name] || {};
      var builtin = !!prov._builtin;
      var disp = prov._label || name;
      var models = prov.models || prov._models || [];
      // Provider 标题
      var header = document.createElement('div');
      header.className = 'prov-head';
      header.style.cssText = 'font-size:10px;opacity:0.5;margin:4px 0 2px;display:flex;align-items:center;gap:4px;';
      var hDot = builtin ? '#6bb86b' : (_health[name] && _health[name].alive ? '#6bb86b' : (_health[name] ? '#e08080' : 'rgba(128,128,128,0.3)'));
      var hHtml = '<span class="drag-handle">⋮⋮</span>' +
        '<span style="width:6px;height:6px;border-radius:50%;background:' + hDot + ';flex-shrink:0"></span>' +
        '<span style="flex:1">' + disp + (builtin ? ' · 内置' : '') + '</span>';
      if (!builtin) hHtml += '<button class="btn" data-refresh="' + name + '" title="拉取该渠道全部可用模型 (/v1/models 全量自动解)" style="padding:0 5px;font-size:9px">↻全部模型</button>' +
        '<button class="btn del" data-prov="' + name + '" title="删除 ' + name + '">x</button>';
      header.innerHTML = hHtml;
      container.appendChild(header);
      _dnd(header, name, 'rightProv', function(fk, tk, after) {
        _ordRightProv = _reorder(provOrder, fk, tk, after); _saveOrderPrefs(); render();
      });

      if (!builtin) {
        header.querySelector('.btn.del').addEventListener('click', function(e) {
          e.stopPropagation();
          var pName = this.getAttribute('data-prov');
          _daoConfirm('删除 provider ' + pName + '? (关联路由也会删除)').then(function(ok2) {
            if (!ok2) return;
            fDel('/origin/ea/provider/' + encodeURIComponent(pName)).then(function(r) { if (r.ok) loadConfig(); });
          });
        });
        // ★ cc-switch 风 · 拉取该渠道全部可用模型 (refresh=1 强制 /v1/models 全量探测)
        var _rb = header.querySelector('[data-refresh]');
        if (_rb) _rb.addEventListener('click', function(e) {
          e.stopPropagation();
          var pName = this.getAttribute('data-refresh');
          var self = this; self.textContent = '拉取中…';
          fJson('/origin/ea/models/' + encodeURIComponent(pName) + '?refresh=1').then(function(r) {
            if (r && r.ok) {
              _daoToast('渠道 ' + pName + ' 解出 ' + ((r.models && r.models.length) || 0) + ' 个模型 · ' + (r.source || ''));
              loadConfig();
            } else { self.textContent = '↻全部模型'; _daoToast('拉取失败: ' + ((r && (r.error || r.note)) || 'unknown')); }
          }).catch(function(e2) { self.textContent = '↻全部模型'; _daoToast('拉取失败: ' + e2.message); });
        });
      }

      // 模型列表 (可拖拽重排)
      var modOrder = _applyOrder(models, _ordRightMod[name]);
      for (var i = 0; i < modOrder.length; i++) {
        var m = modOrder[i];
        var item = _buildRightItem(name, m);
        (function(pn, arr) {
          _dnd(item, m, 'rightMod:' + pn, function(ff, tt, after) {
            _ordRightMod[pn] = _reorder(arr, ff, tt, after); _saveOrderPrefs(); render();
          });
        })(name, modOrder);
        container.appendChild(item);
      }

      // 如果没有模型列表 · 显示 "探测" 按钮 (内置测试通道无需探测)
      if (models.length === 0 && !builtin) {
        var probeBtn = document.createElement('button');
        probeBtn.className = 'btn probe';
        probeBtn.style.cssText = 'font-size:9px;margin:2px 0 4px;padding:1px 6px;';
        probeBtn.textContent = '探测模型';
        probeBtn.setAttribute('data-prov', name);
        probeBtn.addEventListener('click', function() {
          var pName = this.getAttribute('data-prov');
          this.textContent = '探测中...';
          var self = this;
          fJson('/origin/ea/models/' + encodeURIComponent(pName)).then(function(r) {
            if (r.ok && r.models && r.models.length > 0) {
              loadConfig();
            } else {
              self.textContent = '无模型';
              setTimeout(function() { self.textContent = '探测模型'; }, 2000);
            }
          }).catch(function() {
            self.textContent = '探测失败';
            setTimeout(function() { self.textContent = '探测模型'; }, 2000);
          });
        });
        container.appendChild(probeBtn);
      }
    });
  }

  function renderWires() {
    var svg = document.getElementById('wireSvg');
    svg.innerHTML = '';
    var container = document.getElementById('wireContainer');
    var cRect = container.getBoundingClientRect();
    if (cRect.width === 0) return;
    // 单一滚动层: SVG 覆盖整段滚动内容(高=scrollHeight),作为滚动容器的绝对定位子元素
    // 随内容原生滚动 → 连线与左右列同层移动,无需任何滚动期 JS 重绘(根除"一卡一卡")。
    var sc = container.scrollTop;
    svg.style.width = container.clientWidth + 'px';
    svg.style.height = container.scrollHeight + 'px';

    for (var uid in _routes) {
      var route = _routes[uid];
      if (!route || !route.provider) continue;
      // 找左侧节点: 路由 uid 可能落在家族任一档位成员上 → 匹配 data-uids 含该 uid 的家族项
      var leftEl = document.querySelector('.wire-col.left .model-item[data-uid="' + uid + '"]');
      if (!leftEl) {
        var lis = document.querySelectorAll('.wire-col.left .model-item');
        for (var li = 0; li < lis.length; li++) {
          var uds = (lis[li].getAttribute('data-uids') || '').split(',');
          var hit = false;
          for (var ui = 0; ui < uds.length; ui++) { if (_norm(uds[ui]) === _norm(uid)) { hit = true; break; } }
          if (hit) { leftEl = lis[li]; break; }
        }
      }
      // 找右侧节点 (provider标题或模型)
      var rightEl = document.querySelector('.wire-col.right .model-item[data-prov="' + route.provider + '"][data-model="' + route.model + '"]');
      if (!rightEl) rightEl = document.querySelector('.wire-col.right .model-item[data-prov="' + route.provider + '"]');
      if (!leftEl || !rightEl) continue;

      var lRect = leftEl.getBoundingClientRect();
      var rRect = rightEl.getBoundingClientRect();
      var x1 = lRect.right - cRect.left;
      var y1 = lRect.top - cRect.top + sc + lRect.height / 2;
      var x2 = rRect.left - cRect.left;
      var y2 = rRect.top - cRect.top + sc + rRect.height / 2;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      var isDead = _health[route.provider] && !_health[route.provider].alive;
      path.setAttribute('class', 'wire-line' + (isDead ? ' dead' : ' active'));
      // ★ v9.9.288 · 对齐模式画水平直线 (一目了然) · 否则贝塞尔曲线
      if (_alignMode) {
        path.setAttribute('d', 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2);
      } else {
        var cx = (x1 + x2) / 2;
        path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2);
      }
      svg.appendChild(path);
    }
  }

  function renderStatus() {
    var bar = document.getElementById('statusBar');
    var provCount = Object.keys(_providers).length;
    var routeCount = Object.keys(_routes).length;
    var routedCount = 0;
    for (var uid in _routes) { if (_routes[uid] && _routes[uid].provider) routedCount++; }
    bar.innerHTML =
      '<span class="pill">Provider ' + provCount + '</span>' +
      '<span class="pill">路由 ' + routedCount + '/' + routeCount + '</span>' +
      '<span class="pill">就绪 ' + (_config && (_config.router_ready || _config.ea_running) ? '是' : '否') + '</span>' +
      '<span style="flex:1"></span>' +
      '<span style="font-size:9px;opacity:0.4">双击=编辑 · 左=官方 · 右=外接</span>';
  }

  // ── cc-switch 预设填充 ──
  (function() {
    var sel = document.getElementById('presetSelect');
    if (!sel) return;
    _PRESETS.forEach(function(p, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.n + ' (' + p.u.replace(/^https?:[/][/]/, '') + ')';
      sel.appendChild(opt);
    });
    // 选预设 → 自动用「干净 slug」做渠道名, 不覆盖用户已填名
    //   取名中首个 ASCII 词(含括注内, 如「字节 豆包 火山方舟 (Doubao/Ark)」→ doubao);
    //   无 ASCII 词时再退化为去非 ASCII 拼接 (避免整名为中文时塌成空回退 provider)。
    function _presetSlug(name) {
      var s = String(name || '');
      var toks = s.match(/[A-Za-z][A-Za-z0-9]*/g);
      if (toks && toks.length) return toks[0].toLowerCase();
      var t = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
      return t || 'provider';
    }
    var apply = document.getElementById('btnApplyPreset');
    if (apply) apply.addEventListener('click', function() {
      var v = sel.value;
      if (v === '') return;
      var p = _PRESETS[parseInt(v, 10)];
      if (!p) return;
      document.getElementById('provName').value = _presetSlug(p.n);
      document.getElementById('provUrl').value = p.u;
      document.getElementById('provModels').value = ''; // 预设不带具体模型 · 填 Key 添加后自动识别该渠道全部模型
      document.getElementById('provProtocol').value = p.protocol || '';
      var _pm = document.getElementById('provModels');
      if (_pm) _pm.placeholder = '留空即可 · 添加后自动识别 ' + p.n + ' 全部模型';
      document.getElementById('provKey').focus();
    });
    // ★ 🌐 注册/官网: 打开所选预设渠道的官网/注册页 (去拿 APIKey) · 最小化用户操作
    var reg = document.getElementById('btnRegisterPreset');
    if (reg) reg.addEventListener('click', function() {
      var v = sel.value;
      if (v === '') { _daoToast('先在左侧下拉选择一个预设渠道'); return; }
      var p = _PRESETS[parseInt(v, 10)];
      if (!p) return;
      var url = p.r || p.u;
      if (_vscode) _vscode.postMessage({ type: 'openExternal', url: url });
      else { try { window.open(url, '_blank'); } catch (_e) {} }
      _daoToast('正在打开 ' + p.n + ' 官网…');
    });
  })();

  // ── 添加 Provider ──
  document.getElementById('btnAddProv').addEventListener('click', function() {
    var name = document.getElementById('provName').value.trim();
    var url = document.getElementById('provUrl').value.trim();
    var key = document.getElementById('provKey').value.trim();
    var protocol = document.getElementById('provProtocol').value;
    var modelsRaw = document.getElementById('provModels').value.trim();
    if (!name || !url) { _daoToast('名称和 URL 必填'); return; }
    var cfg = { baseUrl: url };
    cfg.protocol = protocol;
    // ★ Key 留空 → 不下发 apiKey 字段 → 后端保留原 Key (编辑已有渠道时不会清空)
    if (key) cfg.apiKey = key;
    if (modelsRaw) cfg.models = modelsRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var btnAdd = this;
    btnAdd.textContent = '添加中…';
    fPost('/origin/ea/provider', { name: name, cfg: cfg })
      .then(function(r) {
        if (r.ok) {
          document.getElementById('provName').value = '';
          document.getElementById('provUrl').value = '';
          document.getElementById('provKey').value = '';
          document.getElementById('provProtocol').value = '';
          document.getElementById('provModels').value = '';
          // ★ 加 key 即「先全量解模型(cc-switch 风 /v1/models) → 再探活」: 新渠道首次添加即有模型可探, 无需重启窗口
          btnAdd.textContent = '解模型…';
          // refresh=1 强制全量探测; 失败不阻断流程
          fJson('/origin/ea/models/' + encodeURIComponent(name) + '?refresh=1').catch(function(){ return null; })
            .then(function(mr) {
              if (mr && mr.ok && mr.models && mr.models.length) _daoToast('渠道 ' + name + ' 解出 ' + mr.models.length + ' 个模型');
              btnAdd.textContent = '探活中…';
              return _autoProbe();
            }).then(function() {
              return loadConfig();
            }).then(function() {
              btnAdd.textContent = '+ 添加';
              var hh = _health[name];
              if (hh && hh.alive === true) _daoToast('渠道 ' + name + ' 已连通 · 绿');
              else if (hh && hh.alive === false) _daoToast('渠道 ' + name + ' 探活失败 · 检查 apiKey/URL');
            });
        } else {
          btnAdd.textContent = '+ 添加';
          _daoToast('添加失败: ' + (r.error || 'unknown'));
        }
      }).catch(function(e) { btnAdd.textContent = '+ 添加'; _daoToast('请求失败: ' + e.message); });
  });

  // ── 探测健康 (统一入口 · 加渠道/手点/首载共用) ──
  function _autoProbe() {
    return fPost('/origin/ea/probe', {}).then(function(r) {
      if (r.ok && r.providers) { _health = r.providers; render(); }
      return r;
    }).catch(function() { return null; });
  }
  document.getElementById('btnProbe').addEventListener('click', function() {
    var btn = this;
    btn.textContent = '探测中...';
    _autoProbe().then(function() { btn.textContent = '探测'; });
  });

  // ── 路由弹窗 ──
  // ★ v9.9.263 · 自连 · 左右各选一 → 自创路由 (早期设计 · 无为而无不为)
  //   不再需双击开模态 · 选完即路· 选完即现连线
  function maybeAutoRoute() {
    if (!_selectedLeft || !_selectedRight) return;
    var left = _selectedLeft;
    var right = _selectedRight;
    var slash = right.indexOf('/');
    var prov = slash >= 0 ? right.slice(0, slash) : right;
    var model = slash >= 0 ? right.slice(slash + 1) : right;
    // ★ 连一族即覆盖其全部「可见档位」uid (取自 _tierGroups · 与双击解路读 data-uids 全断对称).
    //   注: Cascade 实发的 swe-1-6-slow 等档 catalog 无独立项·不在 _tierGroups 中·
    //   默认其保持官方原生直通(不路由·免费)·仅当用户显式置 familyTierExtend:true 时方随族延伸.
    var uids = (_tierGroups[left] && _tierGroups[left].length) ? _tierGroups[left] : [left];
    var route = { provider: prov, model: model, maxOutputTokens: 16384, reasoningLevel: 'off' };
    var st = document.getElementById('statusText');
    if (st) st.textContent = '路由中: ' + left + (uids.length > 1 ? ' (×' + uids.length + '档)' : '') + ' → ' + right + ' …';
    Promise.all(uids.map(function(uid) {
      return fPost('/origin/ea/route', { modelUid: uid, route: route });
    })).then(function(rs) {
      var ok = rs.every(function(r){ return r && r.ok; });
      if (ok) {
        _selectedLeft = null;
        _selectedRight = null;
        if (st) st.textContent = '✔ 已路由 ' + left + (uids.length > 1 ? ' (全 ' + uids.length + ' 档)' : '') + ' → ' + right;
        loadConfig();
      } else {
        var bad = rs.filter(function(r){ return !(r && r.ok); })[0];
        if (st) st.textContent = '路由失败: ' + ((bad && bad.error) || 'unknown');
      }
    }).catch(function(e) {
      if (st) st.textContent = '路由请求失败: ' + e.message;
    });
  }

  // ── webview 安全替代: VS Code webview 禁用 window.confirm/alert ──
  function _daoToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);background:rgba(40,40,46,0.97);color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:6px;padding:8px 14px;font-size:12px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,0.5);max-width:80%;';
    document.body.appendChild(t);
    setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }
  function _daoConfirm(msg) {
    return new Promise(function(resolve) {
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:99998;display:flex;align-items:center;justify-content:center;';
      var box = document.createElement('div');
      box.style.cssText = 'background:#26262c;color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:8px;padding:16px 18px;max-width:78%;box-shadow:0 8px 28px rgba(0,0,0,0.6);';
      var p = document.createElement('div');
      p.textContent = msg;
      p.style.cssText = 'font-size:13px;margin-bottom:14px;line-height:1.5;';
      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      var cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'padding:5px 14px;font-size:12px;border-radius:4px;border:1px solid rgba(128,128,128,0.4);background:transparent;color:#e6e6e6;cursor:pointer;';
      var ok = document.createElement('button');
      ok.textContent = '确认';
      ok.style.cssText = 'padding:5px 14px;font-size:12px;border-radius:4px;border:1px solid #c0392b;background:#c0392b;color:#fff;cursor:pointer;';
      function close(v){ if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(v); }
      cancel.addEventListener('click', function(){ close(false); });
      ok.addEventListener('click', function(){ close(true); });
      ov.addEventListener('click', function(e){ if (e.target === ov) close(false); });
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(p); box.appendChild(btns);
      ov.appendChild(box);
      document.body.appendChild(ov);
      ok.focus();
    });
  }

  var _routeCapabilitySeq = 0;
  var _routeCapabilityTimer = 0;
  var _routeEditingUids = [];
  var _routeChannels = [];
  var _routeChannelEdit = -1;
  var _routeChannelDrag = -1;
  var _routeSharedModelId = '';

  function _routeSharedRecord(id) {
    return ((_config && _config.custom_models) || {})[id] || null;
  }
  function _routeChannelsFromCustomModel(id) {
    var record = _routeSharedRecord(id);
    if (!record) return [];
    var source = Array.isArray(record.channels) && record.channels.length ? record.channels : [record];
    var result = [];
    var seen = {};
    source.forEach(function(channel) {
      var provider = String(channel && channel.provider || '').trim();
      var model = String(channel && (channel.upstreamModel || channel.model) || '').trim();
      var key = provider + '|' + model;
      if (!provider || !model || seen[key]) return;
      seen[key] = true;
      result.push({
        provider: provider,
        model: model,
        protocol: channel.protocol || '',
        sourceProtocol: channel.sourceProtocol || channel.protocol || '',
        reasoningLevel: channel.reasoningLevel || record.reasoningLevel || 'off',
        reasoningEffort: channel.reasoningEffort,
        thinkingEnabled: channel.thinkingEnabled,
        thinkingBudget: channel.thinkingBudget,
        capabilities: channel.capabilities || record.capabilities || null
      });
    });
    return result;
  }
  function _routeRenderSharedNotice() {
    var notice = document.getElementById('routeSharedModelNotice');
    var text = document.getElementById('routeSharedModelText');
    if (!notice || !text) return;
    if (!_routeSharedModelId) { notice.style.display = 'none'; text.textContent = ''; return; }
    notice.style.display = 'flex';
    text.textContent = '正在编辑⑦共享模型「' + _routeSharedModelId + '」· 此处增删、编辑或排序渠道会同步到⑦，并立即供④反代与⑥协议中转使用。';
  }
  function _routeEnterSharedModel(id) {
    var record = _routeSharedRecord(id);
    var channels = _routeChannelsFromCustomModel(id);
    if (!record || !channels.length) { _daoToast('⑦自定义模型不存在或没有可用渠道: ' + id); return false; }
    _routeSharedModelId = id;
    _routeChannels = channels;
    _routeChannelEdit = 0;
    var strategy = document.getElementById('routeChannelStrategy');
    if (strategy) strategy.value = record.channelStrategy === 'random' ? 'random' : 'priority';
    _routeRenderSharedNotice();
    _routeRenderChannels();
    _routeLoadChannel(0);
    return true;
  }
  function _routeDetachSharedModel() {
    if (!_routeSharedModelId) return;
    _routeSharedModelId = '';
    _routeRenderSharedNotice();
    document.getElementById('routeModalTitle').textContent = '编辑独立路由: ' + (document.getElementById('routeModelUid').value.trim() || '新路由');
    _daoToast('已保留当前渠道副本；保存后不再与⑦同步');
  }

  function _routeFormChannel() {
    var selected = _routeSelectedModel();
    var customRef = selected.indexOf('__custom_route__:') === 0 ? selected.slice('__custom_route__:'.length) : '';
    var customChannels = customRef ? _routeChannelsFromCustomModel(customRef) : [];
    var customChannel = customChannels[0] || null;
    var previous = _routeChannelEdit >= 0 ? _routeChannels[_routeChannelEdit] : null;
    return {
      provider: customChannel && customChannel.provider || document.getElementById('routeProvider').value,
      model: customChannel && customChannel.model || selected,
      protocol: customChannel && customChannel.protocol || previous && previous.protocol || '',
      sourceProtocol: customChannel && customChannel.sourceProtocol || previous && previous.sourceProtocol || '',
      reasoningLevel: document.getElementById('routeReasoning').value || customChannel && customChannel.reasoningLevel || 'off',
      reasoningEffort: customChannel && customChannel.reasoningEffort || previous && previous.reasoningEffort,
      thinkingEnabled: customChannel && customChannel.thinkingEnabled != null ? customChannel.thinkingEnabled : previous && previous.thinkingEnabled,
      thinkingBudget: customChannel && customChannel.thinkingBudget != null ? customChannel.thinkingBudget : previous && previous.thinkingBudget,
      capabilities: customChannel && customChannel.capabilities || previous && previous.capabilities || null
    };
  }
  function _routeFillModelOptions(providerName, selectedModel) {
    var select = document.getElementById('routeExtModel');
    if (!select) return;
    var provider = (_providers && _providers[providerName]) || {};
    var values = (provider.models || provider._models || []).slice();
    var customMap = (_config && _config.custom_models) || {};
    select.innerHTML = '';
    var addOption = function(value, label, group) {
      if (!value) return;
      var option = document.createElement('option');
      option.value = value; option.textContent = label || value;
      if (group) group.appendChild(option); else select.appendChild(option);
    };
    var providerGroup = document.createElement('optgroup'); providerGroup.label = '② ' + (providerName || '渠道') + ' 已探测模型';
    values.forEach(function(model) { addOption(model, model, providerGroup); });
    if (providerGroup.children.length) select.appendChild(providerGroup);
    var customGroup = document.createElement('optgroup'); customGroup.label = '⑦ 自定义多渠道模型';
    Object.keys(customMap).sort().forEach(function(id) {
      var record = customMap[id] || {};
      addOption('__custom_route__:' + id, (record.label || id) + ' · ' + id, customGroup);
    });
    if (customGroup.children.length) select.appendChild(customGroup);
    if (selectedModel && !Array.prototype.some.call(select.options, function(option) { return option.value === selectedModel; })) addOption(selectedModel, selectedModel + ' · 当前配置');
    if (!select.options.length) addOption('', '该渠道尚无模型 · 请先在②探测或添加');
    select.value = selectedModel || (select.options[0] && select.options[0].value) || '';
  }
  function _routeSelectedModel() {
    return (document.getElementById('routeExtModel').value || '').trim();
  }
  function _routeChannelsFromRoute(route) {
    var result = [];
    if (route && Array.isArray(route.channelPriority)) {
      route.channelPriority.forEach(function(channel) {
        if (channel && channel.provider && (channel.model || channel.upstreamModel)) result.push({
          provider: channel.provider,
          model: channel.model || channel.upstreamModel,
          protocol: channel.protocol,
          sourceProtocol: channel.sourceProtocol,
          reasoningLevel: channel.reasoningLevel || channel.reasoningEffort || 'off'
        });
      });
    }
    if (!result.length && route && route.provider && route.model) result.push({
      provider: route.provider,
      model: route.model,
      protocol: route.protocol,
      sourceProtocol: route.sourceProtocol,
      reasoningLevel: route.reasoningLevel || route.reasoningEffort || (route.thinkingEnabled ? 'auto' : 'off')
    });
    return result;
  }
  function _routeRenderChannels() {
    var box = document.getElementById('routeChannelList');
    if (!box) return;
    box.innerHTML = _routeChannels.map(function(channel, index) {
      var label = (channel.provider || '') + '/' + (channel.model || '');
      var strength = _REASONING_LABELS[channel.reasoningLevel] || channel.reasoningLevel || '默认';
      return '<div class="route-channel-item" draggable="true" data-route-channel-index="' + index + '">' +
        '<span class="drag-handle" title="拖动调整优先级">⋮⋮</span>' +
        '<span class="channel-main">' + (index === 0 ? '主' : '备' + index) + '</span>' +
        '<span class="channel-name" title="' + _routeEsc(label) + '">' + _routeEsc(label) + '</span>' +
        '<span class="route-reasoning">' + _routeEsc(strength) + '</span>' +
        '<button type="button" class="route-channel-edit btn" data-route-channel-edit="' + index + '">编辑</button>' +
        '<button type="button" class="route-channel-remove btn del" data-route-channel-remove="' + index + '">删除</button>' +
        '</div>';
    }).join('');
    box.querySelectorAll('[data-route-channel-edit]').forEach(function(button) {
      button.addEventListener('click', function() { _routeLoadChannel(Number(this.getAttribute('data-route-channel-edit'))); });
    });
    box.querySelectorAll('[data-route-channel-remove]').forEach(function(button) {
      button.addEventListener('click', function() {
        var index = Number(this.getAttribute('data-route-channel-remove'));
        _routeChannels.splice(index, 1);
        if (_routeChannelEdit === index) _routeChannelEdit = -1;
        else if (_routeChannelEdit > index) _routeChannelEdit--;
        _routeRenderChannels();
      });
    });
    box.querySelectorAll('[data-route-channel-index]').forEach(function(item) {
      item.addEventListener('dragstart', function() { _routeChannelDrag = Number(this.getAttribute('data-route-channel-index')); this.classList.add('dragging'); });
      item.addEventListener('dragend', function() { this.classList.remove('dragging'); _routeChannelDrag = -1; });
      item.addEventListener('dragover', function(event) { event.preventDefault(); this.classList.add('drag-over'); });
      item.addEventListener('dragleave', function() { this.classList.remove('drag-over'); });
      item.addEventListener('drop', function(event) {
        event.preventDefault(); this.classList.remove('drag-over');
        var target = Number(this.getAttribute('data-route-channel-index'));
        if (_routeChannelDrag < 0 || _routeChannelDrag === target) return;
        var moved = _routeChannels.splice(_routeChannelDrag, 1)[0];
        _routeChannels.splice(target, 0, moved);
        _routeChannelEdit = target;
        _routeRenderChannels();
        _routeLoadChannel(target);
      });
    });
  }
  function _routeLoadChannel(index) {
    var channel = _routeChannels[index];
    if (!channel) return;
    _routeChannelEdit = index;
    var provider = document.getElementById('routeProvider');
    if (provider) provider.value = channel.provider || '';
    _routeFillModelOptions(channel.provider || '', channel._customModelRef ? '__custom_route__:' + channel._customModelRef : (channel.model || ''));
    _routeRefreshReasoning(channel.reasoningLevel || 'off');
    var apply = document.getElementById('routeApplyChannel');
    if (apply) apply.textContent = '更新当前渠道';
  }
  function _routeRefreshReasoning(selected, knownCapability) {
    var provider=document.getElementById('routeProvider').value;
    var selectedModel=_routeSelectedModel();
    var customRef=selectedModel.indexOf('__custom_route__:')===0?selectedModel.slice('__custom_route__:'.length):'';
    var customRoute=customRef&&_routes[customRef];
    var model=customRoute&&customRoute.model||selectedModel;
    if(customRoute)provider=customRoute.provider;
    var status=document.getElementById('routeCapability');
    if(knownCapability){_fillReasoningOptions(document.getElementById('routeReasoning'),knownCapability,selected);if(status)status.textContent=_capabilitySummary(knownCapability);}
    if(!provider||!model){if(status)status.textContent='选择 Provider 与模型后自动探取';return Promise.resolve(null);}
    var seq=++_routeCapabilitySeq;if(status)status.textContent='正在探取模型能力…';
    return fJson('/origin/ea/model-capability?provider='+encodeURIComponent(provider)+'&model='+encodeURIComponent(model)).then(function(result){if(seq!==_routeCapabilitySeq)return null;var capability=result.capability||null;_fillReasoningOptions(document.getElementById('routeReasoning'),capability,selected);if(status)status.textContent=_capabilitySummary(capability);return capability;}).catch(function(error){if(seq===_routeCapabilitySeq&&status)status.textContent='探取失败: '+error.message;return null;});
  }

  function openRouteModal(uid, provName, extModel, routeUids) {
    var modal = document.getElementById('routeModal');
    _routeEditingUids = (routeUids && routeUids.length ? routeUids : (uid ? [uid] : [])).filter(function(value, index, all) { return value && all.indexOf(value) === index; });
    _routeChannels = [];
    _routeChannelEdit = -1;
    _routeSharedModelId = '';
    _routeRenderSharedNotice();
    document.getElementById('routeModelUid').value = uid || '';
    document.getElementById('routeModelUid').readOnly = !!(uid && _routes[uid]);
    document.getElementById('routeMaxTokens').value = '16384';
    document.getElementById('routeTemp').value = '';
    var strategySelect = document.getElementById('routeChannelStrategy');
    if (strategySelect) strategySelect.value = 'priority';
    _fillReasoningOptions(document.getElementById('routeReasoning'), null, 'off');

    // 填充 provider 下拉
    var sel = document.getElementById('routeProvider');
    sel.innerHTML = '';
    for (var name in _providers) {
      var opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === provName) opt.selected = true;
      sel.appendChild(opt);
    }
    _routeFillModelOptions(sel.value || provName || '', extModel || '');

    // 如果编辑已有路由
    if (uid && _routes[uid]) {
      var route = _routes[uid];
      var sharedModelId = route._customModelRef || route._customModelId || '';
      document.getElementById('routeModalTitle').textContent = '编辑路由: ' + uid + (_routeEditingUids.length > 1 ? ' · 同步 ' + _routeEditingUids.length + ' 个家族档位' : '');
      document.getElementById('routeMaxTokens').value = route.maxOutputTokens || 16384;
      document.getElementById('routeTemp').value = (route.temperature != null ? route.temperature : '');
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === route.provider) sel.options[i].selected = true;
      }
      if (sharedModelId && _routeEnterSharedModel(sharedModelId)) {
        document.getElementById('routeModalTitle').textContent = '编辑⑦共享模型: ' + sharedModelId + (uid !== sharedModelId ? ' · 路由 ' + uid : '');
      } else {
        _routeFillModelOptions(route.provider || '', route.model || '');
        _routeChannels = _routeChannelsFromRoute(route);
        if (strategySelect) strategySelect.value = route.channelStrategy === 'random' ? 'random' : 'priority';
        _routeChannelEdit = 0;
        _routeRefreshReasoning(_routeReasoningLevel(route), route.capabilities);
        _routeRenderChannels();
      }
      var deleteButton = document.getElementById('routeDelete');
      deleteButton.style.display = '';
      deleteButton.setAttribute('data-route-uid', uid);
    } else {
      document.getElementById('routeModalTitle').textContent = '添加路由';
      _routeRefreshReasoning('off');
      var addDeleteButton = document.getElementById('routeDelete');
      addDeleteButton.style.display = 'none';
      addDeleteButton.removeAttribute('data-route-uid');
      _routeRenderChannels();
    }

    modal.classList.add('show');
  }

  document.getElementById('routeSave').addEventListener('click', function() {
    var uid = document.getElementById('routeModelUid').value.trim();
    var selectedModel = _routeSelectedModel();
    var selectedCustomRef = selectedModel.indexOf('__custom_route__:') === 0 ? selectedModel.slice('__custom_route__:'.length) : '';
    if (selectedCustomRef && selectedCustomRef !== _routeSharedModelId && !_routeEnterSharedModel(selectedCustomRef)) return;
    var sharedModelId = _routeSharedModelId;
    var maxTokens = parseInt(document.getElementById('routeMaxTokens').value) || 16384;
    var tempRaw = (document.getElementById('routeTemp').value || '').trim();
    var reasoningLevel = document.getElementById('routeReasoning').value || 'off';
    if (!uid) { _daoToast('官方模型 UID 必填'); return; }
    var currentChannel = _routeFormChannel();
    if (_routeChannelEdit >= 0 && _routeChannels[_routeChannelEdit]) _routeChannels[_routeChannelEdit] = currentChannel;
    else if (!_routeChannels.some(function(channel) { return channel.provider === currentChannel.provider && channel.model === currentChannel.model; })) _routeChannels.push(currentChannel);
    if (!_routeChannels.length) { _daoToast('至少添加一个路由渠道'); return; }
    var primary = _routeChannels[0];
    if (!primary.provider || !primary.model) { _daoToast('渠道和模型必填'); return; }
    var saveUids = _routeEditingUids.length ? _routeEditingUids.slice() : [uid];
    var temperature = tempRaw === '' ? null : parseFloat(tempRaw);
    var strategy = document.getElementById('routeChannelStrategy').value === 'random' ? 'random' : 'priority';
    var sharedRecord = sharedModelId ? _routeSharedRecord(sharedModelId) : null;
    var saveShared = Promise.resolve({ ok: true });
    if (sharedModelId) {
      if (!sharedRecord) { _daoToast('⑦共享模型已不存在: ' + sharedModelId); return; }
      var customBody = {
        id: sharedModelId,
        label: sharedRecord.label || sharedModelId,
        channels: _routeChannels.map(function(channel) {
          return {
            provider: channel.provider,
            upstreamModel: channel.model,
            protocol: channel.protocol || channel.sourceProtocol || '',
            reasoningLevel: channel.reasoningLevel || 'off',
            reasoningEffort: channel.reasoningEffort,
            thinkingEnabled: channel.thinkingEnabled,
            thinkingBudget: channel.thinkingBudget
          };
        }),
        channelStrategy: strategy,
        protocol: primary.protocol || primary.sourceProtocol || sharedRecord.protocol || '',
        reasoningLevel: primary.reasoningLevel || sharedRecord.reasoningLevel || 'off',
        contextTokens: sharedRecord.contextTokens,
        maxOutputTokens: sharedRecord.maxOutputTokens || maxTokens,
        supportsImages: sharedRecord.supportsImages === true
      };
      saveShared = fPost('/origin/ea/custom-model', customBody).then(function(result) {
        if (!result || result.ok === false) throw new Error(result && result.error || '⑦共享模型保存失败');
        return result;
      });
    }
    saveShared.then(function() { return Promise.all(saveUids.map(function(saveUid) {
      if (sharedModelId && saveUid === sharedModelId) return Promise.resolve({ ok: true, shared: true });
      var existingRoute = _routes[saveUid] || {};
      var routeCfg = Object.assign({}, existingRoute, {
        provider: primary.provider,
        model: primary.model,
        protocol: primary.protocol || existingRoute.protocol,
        sourceProtocol: primary.sourceProtocol || existingRoute.sourceProtocol,
        maxOutputTokens: maxTokens,
        reasoningLevel: primary.reasoningLevel || reasoningLevel,
        channelStrategy: strategy,
        channelPriority: _routeChannels.map(function(channel) { return Object.assign({}, channel); }),
        autoFallback: _routeChannels.length > 1
      });
      if (sharedModelId) {
        routeCfg = Object.assign({}, existingRoute, {
          provider: primary.provider,
          model: primary.model,
          protocol: primary.protocol || primary.sourceProtocol || sharedRecord.protocol,
          sourceProtocol: primary.sourceProtocol || primary.protocol || sharedRecord.protocol,
          reasoningLevel: primary.reasoningLevel || reasoningLevel,
          _customModelRef: sharedModelId,
          maxOutputTokens: maxTokens,
          _label: (existingRoute._label || saveUid).replace(/ → ⑦ .*$/, '') + ' → ⑦ ' + sharedModelId
        });
        delete routeCfg.channelPriority;
        delete routeCfg.channelStrategy;
        delete routeCfg.autoFallback;
        delete routeCfg.fallback;
      } else delete routeCfg._customModelRef;
      if (temperature != null && !isNaN(temperature)) routeCfg.temperature = temperature;
      else delete routeCfg.temperature;
      if (!sharedModelId) {
        if (_routeChannels.length > 1) routeCfg.fallback = Object.assign({}, _routeChannels[1]);
        else delete routeCfg.fallback;
      }
      return fPost('/origin/ea/route', { modelUid: saveUid, route: routeCfg });
    })); }).then(function(results) {
      var failed = results.filter(function(result) { return !result || result.ok === false; })[0];
      if (!failed) {
        document.getElementById('routeModal').classList.remove('show');
        return loadConfig().then(function() {
          if (typeof _rpRefresh === 'function') _rpRefresh();
          if (typeof _pbLoad === 'function') _pbLoad();
          if (sharedModelId && typeof _cmLoad === 'function') _cmLoad(sharedModelId);
          postMsg('refreshDevinModels');
          _daoToast(sharedModelId ? '已同步更新③⑦及④⑥渠道显示' : '路由已保存');
        });
      } else {
        _daoToast('保存失败: ' + (failed.error || 'unknown'));
      }
    }).catch(function(e) { _daoToast('请求失败: ' + e.message); });
  });

  document.getElementById('routeCancel').addEventListener('click', function() {
    document.getElementById('routeModal').classList.remove('show');
  });
  document.getElementById('routeDelete').addEventListener('click', function() {
    var button = this;
    var uid = button.getAttribute('data-route-uid');
    if (!uid) return;
    var deleteUids = _routeEditingUids.length ? _routeEditingUids.slice() : [uid];
    _daoConfirm('删除 ' + deleteUids.length + ' 条路由？').then(function(yes) {
      if (!yes) return;
      return Promise.all(deleteUids.map(function(deleteUid) { return fDel('/origin/ea/route/' + encodeURIComponent(deleteUid)); })).then(function(results) {
        var failed = results.filter(function(result) { return !result || result.ok === false; })[0];
        if (failed) throw new Error(failed.error || '删除失败');
        document.getElementById('routeModal').classList.remove('show');
        return loadConfig();
      }).catch(function(error) { _daoToast('删除失败: ' + error.message); });
    });
  });
  document.getElementById('routeApplyChannel').addEventListener('click', function() {
    var channel = _routeFormChannel();
    if (!channel.provider || !channel.model) { _daoToast('请先选择渠道和模型'); return; }
    var duplicate = _routeChannels.some(function(item, index) { return index !== _routeChannelEdit && item.provider === channel.provider && item.model === channel.model; });
    if (duplicate) { _daoToast('该渠道模型已在优先队列中'); return; }
    if (_routeChannelEdit >= 0) _routeChannels[_routeChannelEdit] = channel;
    else { _routeChannels.push(channel); _routeChannelEdit = _routeChannels.length - 1; }
    this.textContent = '更新当前渠道';
    _routeRenderChannels();
  });
  document.getElementById('routeNewChannel').addEventListener('click', function() {
    _routeChannelEdit = -1;
    _routeFillModelOptions(document.getElementById('routeProvider').value, '');
    _fillReasoningOptions(document.getElementById('routeReasoning'), null, 'off');
    document.getElementById('routeApplyChannel').textContent = '加入队列';
    document.getElementById('routeCapability').textContent = '选择 Provider 与模型后自动探取';
  });
  document.getElementById('routeDetachShared').addEventListener('click', _routeDetachSharedModel);
  document.getElementById('routeProvider').addEventListener('change', function(){ _routeFillModelOptions(this.value, ''); _routeRefreshReasoning(); });
  document.getElementById('routeExtModel').addEventListener('change', function(){
    var selected = _routeSelectedModel();
    var customRef = selected.indexOf('__custom_route__:') === 0 ? selected.slice('__custom_route__:'.length) : '';
    if (customRef) {
      if (_routeEnterSharedModel(customRef)) document.getElementById('routeModalTitle').textContent = '编辑⑦共享模型: ' + customRef;
      return;
    }
    _routeRefreshReasoning();
  });

  // ── 窗口 resize 时重绘连线 ──
  window.addEventListener('resize', function() { _scheduleWires(); });

  // ★ 单一滚动层: 连线 SVG 作为滚动容器的绝对定位子元素随内容原生滚动,
  //   无需监听 scroll 做主线程重绘 —— 连线稳定·实时·高效,彻底消除"一卡一卡"。

  // ★ v9.9.288 · 1:1 对齐开关 (开↔关·可回退) ──
  (function() {
    var ab = document.getElementById('alignToggle');
    if (!ab) return;
    ab.classList.toggle('on', _alignMode);
    ab.addEventListener('click', function() {
      _alignMode = !_alignMode;
      ab.classList.toggle('on', _alignMode);
      _saveOrderPrefs();
      render();
    });
  })();

  // ── 自动刷新 ──
  setInterval(function() { loadConfig(); }, 5000);

  // ── 三模块 Tab 切换 + 扩展宿主桥 ──
  var _vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  function postMsg(t) { if (_vscode) _vscode.postMessage({ type: t }); }
  var _tabs = document.querySelectorAll('.dao-tab');
  for (var ti = 0; ti < _tabs.length; ti++) {
    _tabs[ti].addEventListener('click', function() {
      var pane = this.getAttribute('data-pane');
      for (var k = 0; k < _tabs.length; k++) { _tabs[k].classList.remove('active'); }
      this.classList.add('active');
      var panes = document.querySelectorAll('.dao-pane');
      for (var j = 0; j < panes.length; j++) {
        if (panes[j].id === pane) { panes[j].classList.add('active'); }
        else { panes[j].classList.remove('active'); }
      }
      if (pane === 'paneRouter') { _scheduleWires(); }
      if (pane === 'paneRevproxy') { _rpRefresh(); }
      if (pane === 'paneBridge') { _brgRefresh(); }
      if (pane === 'paneProtocolBridge') { _pbLoad(); }
      if (pane === 'paneCustomModel') { _cmLoad(); }
      if (pane === 'paneCodex') { _codexLoad(); _codexChangesRequest(); }
      if (pane === 'paneObs') { _obsLoad(); }
    });
  }

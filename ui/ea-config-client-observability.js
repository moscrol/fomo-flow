  // ⑨ 观测台. This file shares the enclosing webview scope.
  //   告警(增量轮询+红点) · 失败模式 · 链路回放 · 动作审计 · 配置历史回滚/打包
  var _obsLastAlertId = 0;
  var _obsUnseen = 0;
  var _obsTraceOpen = {};
  function _obsEl(id) { return document.getElementById(id); }
  function _obsEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function _obsTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function _obsBadge() {
    var b = _obsEl('obsBadge');
    if (!b) return;
    if (_obsUnseen > 0) { b.textContent = _obsUnseen > 99 ? '99+' : String(_obsUnseen); b.style.display = 'inline-block'; }
    else { b.style.display = 'none'; }
  }
  var _OBS_LEVEL_COLOR = { error: '#e51400', warn: '#d19a00', info: '#3794ff' };
  function _obsRenderAlerts(alerts) {
    var el = _obsEl('obsAlerts');
    if (!el) return;
    if (!alerts || !alerts.length) { el.innerHTML = '<div style="opacity:0.5">暂无告警 · 一切平安</div>'; return; }
    var html = '';
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      var c = _OBS_LEVEL_COLOR[a.level] || '#888';
      html += '<div style="padding:3px 2px;border-bottom:1px solid rgba(128,128,128,0.12)">'
        + '<span style="color:' + c + ';font-weight:600">●</span> '
        + '<b>' + _obsEsc(a.title) + '</b>'
        + (a.count > 1 ? ' <span style="opacity:0.6">×' + a.count + '</span>' : '')
        + ' <span style="opacity:0.5;font-size:10px">' + _obsTime(a.at) + '</span>'
        + '<div style="opacity:0.7;font-size:10px">' + _obsEsc(a.detail) + '</div>'
        + '</div>';
    }
    el.innerHTML = html;
  }
  function _obsRenderFailures(stats) {
    var el = _obsEl('obsFailures');
    if (!el) return;
    var names = Object.keys(stats || {});
    if (!names.length) { el.innerHTML = '<div style="opacity:0.5">暂无失败记录</div>'; return; }
    names.sort(function(a, b) { return (stats[b].total || 0) - (stats[a].total || 0); });
    var html = '';
    for (var i = 0; i < names.length; i++) {
      var n = names[i]; var s = stats[n];
      var kinds = Object.keys(s.kinds || {}).map(function(k) {
        return _obsEsc(k) + '×' + s.kinds[k].count;
      }).join(' · ');
      html += '<div style="padding:3px 2px;border-bottom:1px solid rgba(128,128,128,0.12)">'
        + '<b>' + _obsEsc(n) + '</b> <span style="opacity:0.6">共 ' + s.total + ' 次</span>'
        + ' <span style="opacity:0.7;font-size:10px">' + kinds + '</span>'
        + (s.suggestion ? '<div style="color:#d19a00;font-size:10px">💡 ' + _obsEsc(s.suggestion) + '</div>' : '')
        + '</div>';
    }
    el.innerHTML = html;
  }
  var _OBS_STATUS_COLOR = { ok: '#3fb950', failed: '#e51400', pending: '#888' };
  function _obsRenderTraces(traces) {
    var el = _obsEl('obsTraces');
    if (!el) return;
    if (!traces || !traces.length) { el.innerHTML = '<div style="opacity:0.5">暂无请求轨迹</div>'; return; }
    var html = '';
    for (var i = 0; i < traces.length; i++) {
      var t = traces[i];
      var c = _OBS_STATUS_COLOR[t.status] || '#888';
      var open = !!_obsTraceOpen[t.id];
      html += '<div style="padding:3px 2px;border-bottom:1px solid rgba(128,128,128,0.12)">'
        + '<div class="obs-trace-head" data-tid="' + t.id + '" style="cursor:pointer">'
        + '<span style="color:' + c + '">' + (open ? '▼' : '▶') + '</span> '
        + '<b>#' + t.id + '</b> ' + _obsEsc(t.modelUid || '?')
        + ' <span style="color:' + c + '">' + _obsEsc(t.status) + '</span>'
        + (t.durationMs != null ? ' <span style="opacity:0.6">' + t.durationMs + 'ms</span>' : '')
        + ' <span style="opacity:0.5;font-size:10px">' + _obsTime(t.at) + '</span>'
        + (t.summary ? ' <span style="opacity:0.6;font-size:10px">' + _obsEsc(t.summary) + '</span>' : '')
        + '</div>';
      if (open && t.steps && t.steps.length) {
        html += '<div style="padding-left:16px;font-size:10px;opacity:0.8">';
        for (var j = 0; j < t.steps.length; j++) {
          var st = t.steps[j];
          var extra = [];
          for (var k in st) {
            if (k === 'at' || k === 'elapsedMs' || k === 'type') continue;
            extra.push(k + '=' + (typeof st[k] === 'object' ? JSON.stringify(st[k]) : st[k]));
          }
          html += '<div>+' + st.elapsedMs + 'ms <b>' + _obsEsc(st.type) + '</b> ' + _obsEsc(extra.join(' · ')) + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
    var heads = el.querySelectorAll('.obs-trace-head');
    for (var h = 0; h < heads.length; h++) {
      heads[h].addEventListener('click', function() {
        var tid = this.getAttribute('data-tid');
        _obsTraceOpen[tid] = !_obsTraceOpen[tid];
        _obsLoad();
      });
    }
  }
  function _obsRenderAudit(audit) {
    var el = _obsEl('obsAudit');
    if (!el) return;
    if (!audit || !audit.length) { el.innerHTML = '<div style="opacity:0.5">暂无配置变更</div>'; return; }
    var html = '';
    for (var i = 0; i < audit.length; i++) {
      var a = audit[i];
      html += '<div style="padding:3px 2px;border-bottom:1px solid rgba(128,128,128,0.12)">'
        + '<span style="color:' + (a.ok ? '#3fb950' : '#e51400') + '">' + (a.ok ? '✔' : '✖') + '</span> '
        + '<b>' + _obsEsc(a.action) + '</b>'
        + ' <span style="opacity:0.5;font-size:10px">' + _obsTime(a.at) + '</span>'
        + '<div style="opacity:0.6;font-size:10px">' + _obsEsc(JSON.stringify(a.args)) + (a.error ? ' · ' + _obsEsc(a.error) : '') + '</div>'
        + '</div>';
    }
    el.innerHTML = html;
  }
  function _obsRenderBackups(result) {
    var el = _obsEl('obsBackups');
    if (!el) return;
    var backups = (result && result.backups) || [];
    if (!backups.length) { el.innerHTML = '<div style="opacity:0.5">暂无历史备份 (改动配置后自动产生)</div>'; return; }
    var html = '';
    for (var i = 0; i < backups.length; i++) {
      var b = backups[i];
      html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 2px;border-bottom:1px solid rgba(128,128,128,0.12)">'
        + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis">' + _obsEsc(b.name) + '</span>'
        + '<span style="opacity:0.5;font-size:10px">' + _obsTime(b.mtime) + '</span>'
        + '<button class="btn del obs-rollback" data-name="' + _obsEsc(b.name) + '" type="button">回滚</button>'
        + '</div>';
    }
    el.innerHTML = html;
    var btns = el.querySelectorAll('.obs-rollback');
    for (var h = 0; h < btns.length; h++) {
      btns[h].addEventListener('click', function() {
        var name = this.getAttribute('data-name');
        var self = this;
        _daoConfirm('回滚配置到 ' + name + '？当前配置会先自动备份。').then(function(yes) {
          if (!yes) return;
          self.disabled = true;
          fPost('/origin/ea/config-rollback', { backup: name }).then(function(r) {
            _daoToast(r.ok ? '已回滚并热重载' : ('回滚失败: ' + (r.error || '?')));
            _obsLoad();
            loadConfig();
          }).catch(function(e) { _daoToast('回滚失败: ' + e.message); self.disabled = false; });
        });
      });
    }
  }
  function _obsLoad() {
    fJson('/origin/ea/alerts?limit=30').then(function(d) {
      var alerts = d.alerts || [];
      if (alerts.length) _obsLastAlertId = Math.max(_obsLastAlertId, alerts[0].id || 0);
      _obsUnseen = 0; _obsBadge();
      _obsRenderAlerts(alerts);
    }).catch(function() {});
    fJson('/origin/ea/failure-stats').then(function(d) { _obsRenderFailures(d.stats || {}); }).catch(function() {});
    fJson('/origin/ea/traces?limit=30').then(function(d) { _obsRenderTraces(d.traces || []); }).catch(function() {});
    fJson('/origin/ea/audit?limit=30').then(function(d) { _obsRenderAudit(d.audit || []); }).catch(function() {});
    fJson('/origin/ea/config-backups').then(_obsRenderBackups).catch(function() {});
    _obsLoadGlobalOptions();
  }
  function _obsLoadGlobalOptions() {
    fJson('/origin/ea/global-options').then(function(d) {
      var o = (d && d.options) || {};
      var otel = o.otel || {};
      var redact = o.outboundRedact || {};
      var oe = _obsEl('obsOtelEnabled'); if (oe) oe.checked = !!otel.enabled;
      var oep = _obsEl('obsOtelEndpoint'); if (oep && document.activeElement !== oep) oep.value = otel.endpoint || '';
      var osv = _obsEl('obsOtelService'); if (osv && document.activeElement !== osv) osv.value = otel.serviceName || 'dao-flow';
      var st = otel.stats;
      _obsSetText('obsOtelStat', st ? ('已导出 ' + st.exported + ' · 失败 ' + st.failed + ' · 缓冲 ' + st.buffered) : (otel.enabled ? '已启用 · 暂无导出' : '未启用'));
      var re = _obsEl('obsRedactEnabled'); if (re) re.checked = !!redact.enabled;
      var rm = _obsEl('obsRedactMode'); if (rm) rm.value = redact.mode || 'redact';
    }).catch(function() {});
  }
  function _obsSetText(id, t) { var e = _obsEl(id); if (e) e.textContent = t; }
  function _obsSaveGlobalOptions(patch) {
    return fPost('/origin/ea/global-options', patch).then(function(r) {
      if (r && r.ok) { _daoToast('全局设置已保存'); _obsLoadGlobalOptions(); }
      else { _daoToast('保存失败: ' + ((r && r.error) || '?')); }
    }).catch(function(e) { _daoToast('保存失败: ' + e.message); });
  }
  // 后台轮询: 未打开观测台时也增量拉告警 · 有新告警在 Tab 上亮红点
  setInterval(function() {
    var pane = _obsEl('paneObs');
    if (pane && pane.classList.contains('active')) { _obsLoad(); return; }
    fJson('/origin/ea/alerts?since=' + _obsLastAlertId + '&limit=20').then(function(d) {
      var alerts = d.alerts || [];
      if (!alerts.length) return;
      _obsLastAlertId = Math.max(_obsLastAlertId, alerts[alerts.length - 1].id || 0);
      _obsUnseen += alerts.length;
      _obsBadge();
      var top = alerts[alerts.length - 1];
      if (top && top.level === 'error') _daoToast('🚨 ' + top.title + ' · ' + (top.detail || ''));
    }).catch(function() {});
  }, 8000);
  (function() {
    var r = _obsEl('obsRefresh');
    if (r) r.addEventListener('click', _obsLoad);
    var oe = _obsEl('obsOtelEnabled'); if (oe) oe.addEventListener('change', function() { _obsSaveGlobalOptions({ otel: { enabled: oe.checked } }); });
    var osave = _obsEl('obsOtelSave'); if (osave) osave.addEventListener('click', function() {
      _obsSaveGlobalOptions({ otel: {
        endpoint: (_obsEl('obsOtelEndpoint') && _obsEl('obsOtelEndpoint').value || '').trim(),
        serviceName: (_obsEl('obsOtelService') && _obsEl('obsOtelService').value || '').trim() || 'dao-flow'
      } });
    });
    var re = _obsEl('obsRedactEnabled'); if (re) re.addEventListener('change', function() { _obsSaveGlobalOptions({ outboundRedact: { enabled: re.checked } }); });
    var rm = _obsEl('obsRedactMode'); if (rm) rm.addEventListener('change', function() { _obsSaveGlobalOptions({ outboundRedact: { mode: rm.value } }); });
    var ex = _obsEl('obsExportPack');
    if (ex) ex.addEventListener('click', function() {
      fJson('/origin/ea/config-pack').then(function(d) {
        if (!d.ok) { _daoToast('导出失败: ' + (d.error || '?')); return; }
        var box = _obsEl('obsPackBox');
        box.style.display = 'block';
        box.value = JSON.stringify(d.pack || d, null, 2);
        box.select();
        _daoToast('配置包已生成 · 全选复制即可带走');
      }).catch(function(e) { _daoToast('导出失败: ' + e.message); });
    });
    var im = _obsEl('obsImportPack');
    if (im) im.addEventListener('click', function() {
      var box = _obsEl('obsPackBox');
      if (box.style.display === 'none' || !box.value.trim()) {
        box.style.display = 'block';
        box.value = '';
        box.focus();
        _daoToast('粘贴配置包 JSON 后再点一次「导入配置包」');
        return;
      }
      var pack;
      try { pack = JSON.parse(box.value); } catch (e) { _daoToast('JSON 解析失败: ' + e.message); return; }
      _daoConfirm('导入配置包会覆盖当前渠道+路由配置（当前配置先自动备份），继续？').then(function(yes) {
        if (!yes) return;
        fPost('/origin/ea/config-pack', { pack: pack }).then(function(r) {
          _daoToast(r.ok ? '已导入并热重载' : ('导入失败: ' + (r.error || '?')));
          _obsLoad();
          loadConfig();
        }).catch(function(e) { _daoToast('导入失败: ' + e.message); });
      });
    });
  })();

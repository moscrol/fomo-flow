  var _pbProfiles = [];
  var _pbProviders = [];
  var _pbCustomModels = [];
  var _pbEditing = '';
  var _pbDetectSeq = 0;
  var _pbCapabilitySeq = 0;
  var _pbAccess = null;
  var _pbKeyVisible = true;
  var _pbClientConfigText = '';
  var _PB_PROTOCOLS = ['openai-chat','openai-responses','anthropic','gemini'];
  var _PB_PROTOCOL_LABELS = {'openai-chat':'OpenAI Chat','openai-responses':'Responses','anthropic':'Anthropic','gemini':'Gemini'};
  var _PB_NL = String.fromCharCode(10);
  function _pbEl(id) { return document.getElementById(id); }
  function _pbEsc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  var _REASONING_LABELS = {off:'关闭',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最大',auto:'自动'};
  function _fillReasoningOptions(select, capability, selected) {
    if (!select) return;
    var levels = capability && capability.reasoningLevels && capability.reasoningLevels.length ? capability.reasoningLevels : ['off'];
    select.innerHTML = '';
    levels.forEach(function(level) { var option=document.createElement('option'); option.value=level; option.textContent=_REASONING_LABELS[level]||level; select.appendChild(option); });
    var wanted = selected || (capability && capability.defaultReasoningLevel) || levels[0];
    select.value = levels.indexOf(wanted) >= 0 ? wanted : levels[0];
  }
  function _capabilitySummary(capability) {
    if (!capability) return '未探取';
    var levels=(capability.reasoningLevels||['off']).map(function(level){return _REASONING_LABELS[level]||level;}).join(' / ');
    var tools=capability.supportsTools===false?'✖ 工具调用不受支持':'✔ Devin 工具规则兼容';
    return '思考: '+levels+' · '+tools+' · '+(capability.source==='metadata'?'渠道元数据':'模型族推断');
  }
  function _pbSetStatus(text) { var el = _pbEl('pbStatus'); if (el) el.textContent = text || ''; }
  function _pbSetDetectStatus(text) { var el = _pbEl('pbDetectStatus'); if (el) el.textContent = text || ''; }

  // ★ 面板快捷思考开关 · 一键切换任意路由模型的思考强度
  function _eaQuickReasoning(modelUid, level, label) {
    fPost('/origin/ea/reasoning', { modelUid: modelUid, reasoningLevel: level }).then(function(res) {
      if (!res.ok) throw new Error(res.error || '切换失败');
      _pbSetStatus((label || modelUid) + ' 思考 → ' + (_REASONING_LABELS[level] || level));
      return Promise.all([loadConfig(), _cmLoad(), _pbLoad()]);
    }).catch(function(err) { _pbSetStatus('思考切换失败: ' + err.message); });
  }
  function _pbProtocols(values, fallback) {
    var result = [];
    (values || []).concat(fallback || []).forEach(function(value) {
      if (_PB_PROTOCOLS.indexOf(value) >= 0 && result.indexOf(value) < 0) result.push(value);
    });
    return result.length ? result : _PB_PROTOCOLS.slice();
  }

  var _cmModels = [];
  var _cmEditing = '';
  var _cmChannels = [];
  var _cmEditingChannelIndex = -1;
  var _cmChannelDrag = -1;
  var _cmRuntimeRefreshing = false;
  var _cmDetectSeq = 0;
  var _cmDetectTimer = 0;
  function _cmEl(id) { return document.getElementById(id); }
  function _cmSetStatus(text) { var el=_cmEl('cmStatus'); if(el) el.textContent=text||''; }
  function _cmSetModelStatus(text) { var el=_cmEl('cmModelStatus'); if(el) el.textContent=text||''; }
  function _cmRuntimeSource(source) { return source==='auto-fallback'?'自动切换到备用':source==='sticky'?'会话保持':source==='primary'?'首选渠道':'真实请求'; }
  function _cmRenderRuntimeBanner() {
    var banner=_cmEl('cmRuntimeBanner');if(!banner)return;var candidates=_cmModels.filter(function(model){return model&&model.runtime;}).sort(function(a,b){return String(b.runtime.updatedAt||'').localeCompare(String(a.runtime.updatedAt||''));});var selected=_cmEditing&&_cmModels.filter(function(model){return model.id===_cmEditing&&model.runtime;})[0];var model=selected||candidates[0];var runtime=model&&model.runtime;
    banner.classList.remove('active','failed');
    if(!runtime){banner.innerHTML='<span class="cm-runtime-main">当前实际使用：等待首次真实请求</span><span class="cm-hint">发送一次 Devin 对话后将在 2.5 秒内显示</span>';return;}
    if(runtime.state==='failed'){banner.classList.add('failed');banner.innerHTML='<span class="cm-runtime-main">当前实际使用：全部渠道失败</span><span class="cm-hint">模型 '+_pbEsc(model.label||model.id)+' · 请检查渠道状态</span>';return;}
    banner.classList.add('active');banner.innerHTML='<span class="cm-runtime-main">当前实际使用：'+_pbEsc(runtime.provider)+' / '+_pbEsc(runtime.model)+'</span><span class="pb-badge">'+_pbEsc(_cmRuntimeSource(runtime.source))+'</span><span class="cm-hint">自定义模型 '+_pbEsc(model.label||model.id)+' · '+_pbEsc(runtime.updatedAt||'刚刚')+'</span>';
  }
  function _cmRefreshRuntime() {
    if(_cmRuntimeRefreshing)return Promise.resolve();_cmRuntimeRefreshing=true;
    return fJson('/origin/ea/custom-models').then(function(result){var incoming=Array.isArray(result.models)?result.models:[];var byId={};incoming.forEach(function(model){byId[model.id]=model;});_cmModels=_cmModels.map(function(model){return byId[model.id]?Object.assign({},model,{runtime:byId[model.id].runtime||null,channels:byId[model.id].channels||model.channels}):model;});_cmRender();}).catch(function(){}).then(function(){_cmRuntimeRefreshing=false;});
  }
  function _cmSetModelOptions(models, selected, forceCustom) {
    var select=_cmEl('cmUpstream'); var custom=_cmEl('cmUpstreamCustom'); if(!select||!custom)return;
    var values=[]; (models||[]).forEach(function(model){model=String(model||'').trim();if(model&&values.indexOf(model)<0)values.push(model);});
    select.innerHTML='';
    if(!values.length){var empty=document.createElement('option');empty.value='';empty.textContent='未探测到模型';select.appendChild(empty);}
    values.forEach(function(model){var option=document.createElement('option');option.value=model;option.textContent=model;select.appendChild(option);});
    var manual=document.createElement('option');manual.value='__custom__';manual.textContent='手动输入其他模型…';select.appendChild(manual);
    if(forceCustom||(selected&&values.indexOf(selected)<0)){select.value='__custom__';custom.value=selected||'';custom.style.display='block';}
    else{select.value=selected&&values.indexOf(selected)>=0?selected:(values[0]||'__custom__');custom.value='';custom.style.display=select.value==='__custom__'?'block':'none';}
  }
  function _cmUpstreamValue() { var select=_cmEl('cmUpstream');var custom=_cmEl('cmUpstreamCustom');if(!select)return'';return select.value==='__custom__'?(custom&&custom.value||'').trim():select.value; }
  function _cmNormalizeChannels(model) {
    var source=model&&Array.isArray(model.channels)&&model.channels.length?model.channels:[model||{}];var result=[];var seen={};
    source.forEach(function(entry){var provider=String(entry&&entry.provider||'').trim();var upstreamModel=String(entry&&(entry.upstreamModel||entry.model)||'').trim();var key=provider+'|'+upstreamModel;if(provider&&upstreamModel&&!seen[key]){seen[key]=true;result.push({provider:provider,upstreamModel:upstreamModel,protocol:entry.protocol||((model&&model.protocol)||''),reasoningLevel:entry.reasoningLevel||((model&&model.reasoningLevel)||''),reasoningEffort:entry.reasoningEffort,thinkingEnabled:entry.thinkingEnabled,thinkingBudget:entry.thinkingBudget,capabilities:entry.capabilities||((model&&model.capabilities)||null),manualModel:entry.manualModel===true});}});
    return result;
  }
  function _cmRenderChannels() {
    var box=_cmEl('cmChannelList');if(!box)return;
    if(!_cmChannels.length){box.innerHTML='<div class="cm-hint" style="padding:7px;text-align:center;border:1px dashed rgba(128,128,128,.24);border-radius:5px">尚未加入渠道 · 选择渠道与模型后点击“加入优先队列”</div>';return;}
    box.innerHTML=_cmChannels.map(function(channel,index){var settings=(channel.protocol||'跟随渠道')+' · '+(_REASONING_LABELS[channel.reasoningLevel]||channel.reasoningLevel||'关闭');return '<div class="cm-channel-row" draggable="true" data-cm-channel-index="'+index+'"><span class="drag-handle" title="拖动排序">⠿</span><span class="cm-channel-rank">'+(index===0?'#1 首选':'#'+(index+1)+' 备用')+'</span><code class="cm-channel-target">'+_pbEsc(channel.provider)+' / '+_pbEsc(channel.upstreamModel)+'</code><span class="cm-hint">'+_pbEsc(settings)+'</span><button class="btn" data-cm-channel-edit="'+index+'">编辑</button><button class="btn" data-cm-primary="'+index+'"'+(index===0?' disabled':'')+'>置顶</button><button class="btn del" data-cm-channel-del="'+index+'">移除</button></div>';}).join('');
  }
  function _cmSelectPrimary(detect) {
    var first=_cmChannels[0];if(!first)return;
    var provider=_cmEl('cmProvider');if(provider)provider.value=first.provider;
    _cmProviderChanged(detect!==false,first.upstreamModel);
  }
  function _cmMoveChannel(from,to) {
    if(from<0||to<0||from>=_cmChannels.length||to>=_cmChannels.length||from===to)return;
    var moved=_cmChannels.splice(from,1)[0];_cmChannels.splice(to,0,moved);_cmRenderChannels();_cmSelectPrimary(true);_cmSetStatus('优先级已调整 · 保存后生效');
  }
  function _cmAddChannel() {
    var provider=_cmEl('cmProvider')&&_cmEl('cmProvider').value;var upstreamModel=_cmUpstreamValue();if(!provider||!upstreamModel){_cmSetStatus('请先选择渠道和上游模型');return;}
    var duplicate=_cmChannels.some(function(channel){return channel.provider===provider&&channel.upstreamModel===upstreamModel;});if(duplicate){_cmSetStatus('该渠道与模型已在优先队列中');return;}
    _cmChannels.push(_cmChannelFromForm(provider,upstreamModel));_cmEditingChannelIndex=-1;_cmRenderChannels();_cmSelectPrimary(true);_cmSetStatus('已加入第 '+_cmChannels.length+' 优先级 · 保存后生效');
  }
  function _cmChannelFromForm(provider, upstreamModel) {
    var capability=(_providers&&_providers[provider]&&_providers[provider].modelCapabilities&&_providers[provider].modelCapabilities[upstreamModel])||null;
    return {provider:provider,upstreamModel:upstreamModel,protocol:_cmEl('cmProtocol').value||'',reasoningLevel:_cmEl('cmReasoning').value||'off',capabilities:capability};
  }
  function _cmEditChannel(index) {
    var channel=_cmChannels[index]; if(!channel)return;
    _cmEditingChannelIndex=index;
    var provider=_cmEl('cmProvider'); if(provider)provider.value=channel.provider;
    _cmProviderChanged(false,channel.upstreamModel);
    if(_cmEl('cmProtocol'))_cmEl('cmProtocol').value=channel.protocol||'';
    var providerCfg=(_providers&&_providers[channel.provider])||{};
    var capability=channel.capabilities||(providerCfg.modelCapabilities||{})[channel.upstreamModel]||null;
    _fillReasoningOptions(_cmEl('cmReasoning'),capability,channel.reasoningLevel||'off');
    if(_cmEl('cmCapability'))_cmEl('cmCapability').textContent=_capabilitySummary(capability);
    var add=_cmEl('cmAddChannel');if(add)add.textContent='保存当前优先级';var cancel=_cmEl('cmCancelChannelEdit');if(cancel)cancel.style.display='';
    _cmSetStatus('正在编辑第 '+(index+1)+' 优先级，保存后保持原顺序');
  }
  function _cmCancelChannelEdit() { _cmEditingChannelIndex=-1;var add=_cmEl('cmAddChannel');if(add)add.textContent='加入优先队列';var cancel=_cmEl('cmCancelChannelEdit');if(cancel)cancel.style.display='none';_cmSetStatus('已取消渠道编辑'); }
  function _cmSuggestIdentity() { if(_cmEditing)return;var model=_cmUpstreamValue();if(!model)return;var uid=model.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'');if(_cmEl('cmId')&&!_cmEl('cmId').value.trim())_cmEl('cmId').value=uid;if(_cmEl('cmLabel')&&!_cmEl('cmLabel').value.trim())_cmEl('cmLabel').value=model; }
  function _cmModelMode(detect) { var select=_cmEl('cmUpstream');var custom=_cmEl('cmUpstreamCustom');if(select&&custom)custom.style.display=select.value==='__custom__'?'block':'none';_cmSuggestIdentity();if(detect!==false&&_cmUpstreamValue())_cmDetect(); }
  function _cmFillProviders() {
    var select=_cmEl('cmProvider'); if(!select) return;
    var previous=select.value; select.innerHTML='';
    Object.keys(_providers||{}).forEach(function(name){ var provider=_providers[name]||{}; if(provider._builtin) return; var option=document.createElement('option'); option.value=name; option.textContent=provider._label||name; select.appendChild(option); });
    if(previous && _providers[previous]) select.value=previous;
    _cmProviderChanged(false);
  }
  function _cmProviderChanged(detect, selectedModel) {
    var providerName=_cmEl('cmProvider')&&_cmEl('cmProvider').value;
    var provider=(_providers&&_providers[providerName])||{};
    var wanted=selectedModel==null?_cmUpstreamValue():selectedModel; _cmSetModelOptions(provider.models||[],wanted,false);
    _cmSetModelStatus((provider.models||[]).length+' 个渠道模型 · '+(provider.protocol||'自动协议'));
    if(detect!==false && _cmUpstreamValue()) _cmDetect();
  }
  function _cmReloadModels() {
    var providerName=_cmEl('cmProvider')&&_cmEl('cmProvider').value;var wanted=_cmUpstreamValue();if(!providerName)return;
    _cmSetModelStatus('正在重新探测 '+providerName+'…');
    fJson('/origin/ea/models/'+encodeURIComponent(providerName)+'?refresh=1').then(function(result){if(result.ok===false)throw new Error(result.error||'探测失败');var provider=(_providers&&_providers[providerName])||{};provider.models=result.models||[];provider.modelCapabilities=result.capabilities||provider.modelCapabilities||{};_cmSetModelOptions(provider.models,wanted,false);_cmSetModelStatus(provider.models.length+' 个模型 · '+(result.source||'渠道目录'));_cmModelMode(true);}).catch(function(error){_cmSetModelStatus('模型探测失败: '+error.message);});
  }
  function _cmDetect(selected) {
    var provider=_cmEl('cmProvider')&&_cmEl('cmProvider').value;
    var model=_cmUpstreamValue();
    var status=_cmEl('cmCapability');
    if(!provider||!model){ if(status) status.textContent='请选择渠道并填写上游模型'; return Promise.resolve(null); }
    var providerCfg=(_providers&&_providers[provider])||{};var known=providerCfg.modelCapabilities&&providerCfg.modelCapabilities[model];
    if(known&&known.contextTokens){_fillReasoningOptions(_cmEl('cmReasoning'),known,selected);if(!_cmEditing&&_cmEl('cmContext')&&_cmEl('cmContext').value==='131072')_cmEl('cmContext').value=known.contextTokens;if(status)status.textContent=_capabilitySummary(known);return Promise.resolve(known);}
    var seq=++_cmDetectSeq; if(status) status.textContent='正在探取模型能力…';
    return fJson('/origin/ea/model-capability?provider='+encodeURIComponent(provider)+'&model='+encodeURIComponent(model)).then(function(result){
      if(seq!==_cmDetectSeq) return null;
      var capability=result.capability||null; _fillReasoningOptions(_cmEl('cmReasoning'),capability,selected); if(!_cmEditing&&capability&&capability.contextTokens&&_cmEl('cmContext')&&_cmEl('cmContext').value==='131072')_cmEl('cmContext').value=capability.contextTokens; if(status) status.textContent=_capabilitySummary(capability); return capability;
    }).catch(function(error){ if(seq===_cmDetectSeq && status) status.textContent='探取失败: '+error.message; return null; });
  }
  function _cmReset() {
    _cmEditing=''; _cmEditingChannelIndex=-1; _cmChannels=[]; _cmRenderChannels(); var cancel=_cmEl('cmCancelChannelEdit');if(cancel)cancel.style.display='none';var add=_cmEl('cmAddChannel');if(add)add.textContent='加入优先队列'; ['cmId','cmLabel','cmUpstreamCustom'].forEach(function(id){var el=_cmEl(id);if(el)el.value='';});
    if(_cmEl('cmProtocol')) _cmEl('cmProtocol').value=''; if(_cmEl('cmChannelStrategy')) _cmEl('cmChannelStrategy').value='priority'; if(_cmEl('cmContext')) _cmEl('cmContext').value='131072'; if(_cmEl('cmMaxTokens')) _cmEl('cmMaxTokens').value='16384'; if(_cmEl('cmImages')) _cmEl('cmImages').checked=false;
    _fillReasoningOptions(_cmEl('cmReasoning'),null,'off'); if(_cmEl('cmCapability')) _cmEl('cmCapability').textContent='选择渠道与模型后自动探取'; _cmProviderChanged(true,'');
  }
  function _cmEdit(id) {
    var model=_cmModels.filter(function(item){return item.id===id;})[0]; if(!model) return;
    _cmEditing=id; _cmEditingChannelIndex=-1; _cmChannels=_cmNormalizeChannels(model); _cmRenderChannels(); _cmEl('cmId').value=model.id||''; _cmEl('cmLabel').value=model.label||''; _cmEl('cmProvider').value=model.provider||''; _cmProviderChanged(false,model.upstreamModel||''); _cmEl('cmProtocol').value=model.protocol||''; if(_cmEl('cmChannelStrategy'))_cmEl('cmChannelStrategy').value=model.channelStrategy==='random'?'random':'priority'; _cmEl('cmContext').value=model.contextTokens||131072; _cmEl('cmMaxTokens').value=model.maxOutputTokens||16384; _cmEl('cmImages').checked=!!model.supportsImages; _fillReasoningOptions(_cmEl('cmReasoning'),model.capabilities,model.reasoningLevel); _cmEl('cmCapability').textContent=_capabilitySummary(model.capabilities);
  }
  function _cmStartFromProvider(providerName, upstreamModel) {
    _cmReset();
    var provider=_cmEl('cmProvider');if(provider)provider.value=providerName||'';
    _cmProviderChanged(false,upstreamModel||'');
    _cmSuggestIdentity();
    if(upstreamModel)_cmDetect();
    _cmSetStatus('已从②带入渠道 '+providerName+' · 可直接保存或继续加入备用渠道');
  }
  function _cmRender() {
    var box=_cmEl('cmList'); if(!box) return;
    _cmRenderRuntimeBanner();
    if(!_cmModels.length){ box.innerHTML='<div style="padding:14px;text-align:center;opacity:0.5">暂无自定义模型 · 保存后自动同步到②③④⑥和 Devin 模型目录</div>'; return; }
    box.innerHTML=_cmModels.map(function(model){ var caps=model.capabilities||{};var runtime=model.runtime||null;var runtimeBadge=runtime&&runtime.state==='active'?'<span class="pb-badge" style="color:#6bb86b">当前 '+_pbEsc(runtime.provider)+'/'+_pbEsc(runtime.model)+'</span>':runtime&&runtime.state==='failed'?'<span class="pb-badge" style="color:#e08080">全部渠道失败</span>':'<span class="pb-badge">尚无运行记录</span>'; var channels=_cmNormalizeChannels(model);var chain=channels.map(function(channel,index){return '<span class="pb-badge">'+(index===0?'首选 ':'备用 '+index+' ')+_pbEsc(channel.provider)+'/'+_pbEsc(channel.upstreamModel)+'</span>';}).join(' ');var curLvl=model.reasoningLevel||(caps.defaultReasoningLevel)||'off';var lvlOpts=(caps.reasoningLevels&&caps.reasoningLevels.length?caps.reasoningLevels:['off','medium','high']).map(function(l){return '<option value="'+l+'"'+(l===curLvl?' selected':'')+'>'+_pbEsc(_REASONING_LABELS[l]||l)+'</option>';}).join('');var reasoningSelect='<select class="btn" data-cm-reasoning="'+_pbEsc(model.id)+'" style="font-size:10px;padding:1px 4px" title="思考强度">'+lvlOpts+'</select>'; return '<div class="pb-card" data-cm-id="'+_pbEsc(model.id)+'"><div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap"><b>'+_pbEsc(model.label||model.id)+'</b><code>'+_pbEsc(model.id)+'</code><span class="pb-badge">②③④⑥已同步</span>'+runtimeBadge+'<span style="margin-left:auto">思考 '+reasoningSelect+'</span><button class="btn" data-cm-edit="'+_pbEsc(model.id)+'">编辑</button><button class="btn del" data-cm-del="'+_pbEsc(model.id)+'">删除</button></div><div style="font-size:10px;margin-top:5px">'+chain+'</div><div style="font-size:10px;margin-top:4px">'+_pbEsc(model.protocol||'auto')+' · '+(caps.supportsTools===false?'✖ 工具风险':'✔ Devin 工具兼容')+'</div></div>'; }).join('');
  }
  function _cmLoad(focusId) {
    _cmSetStatus('加载中…');
    return Promise.all([fJson('/origin/ea/overview'),fJson('/origin/ea/custom-models')]).then(function(results){var data=results[0]||{};var modelResult=results[1]||{};_config=data||_config;_providers=data.providers||_providers;_cmModels=Array.isArray(modelResult.models)?modelResult.models:Object.keys(data.custom_models||{}).map(function(id){return data.custom_models[id];});_cmFillProviders();_cmRender();_cmSetStatus(_cmModels.length+' 个模型');if(focusId)_cmEdit(focusId);}).catch(function(error){_cmSetStatus('加载失败: '+error.message);});
  }
  function _cmSave() {
    if(!_cmChannels.length){var provider=_cmEl('cmProvider').value;var upstreamModel=_cmUpstreamValue();if(provider&&upstreamModel)_cmChannels=[{provider:provider,upstreamModel:upstreamModel}];_cmRenderChannels();}
    if(_cmEditingChannelIndex>=0){var editedProvider=_cmEl('cmProvider').value;var editedModel=_cmUpstreamValue();var duplicate=_cmChannels.some(function(channel,index){return index!==_cmEditingChannelIndex&&channel.provider===editedProvider&&channel.upstreamModel===editedModel;});if(!editedProvider||!editedModel||duplicate){_cmSetStatus(duplicate?'该渠道与模型已在其他优先级中':'请先选择渠道和上游模型');return;}_cmChannels[_cmEditingChannelIndex]=_cmChannelFromForm(editedProvider,editedModel);_cmEditingChannelIndex=-1;var add=_cmEl('cmAddChannel');if(add)add.textContent='加入优先队列';var cancel=_cmEl('cmCancelChannelEdit');if(cancel)cancel.style.display='none';_cmRenderChannels();_cmSetStatus('当前优先级已更新，保存模型后生效');}
    var primary=_cmChannels[0]||{};var body={id:_cmEl('cmId').value.trim(),label:_cmEl('cmLabel').value.trim(),provider:primary.provider||'',upstreamModel:primary.upstreamModel||'',channels:_cmChannels.slice(),protocol:primary.protocol||_cmEl('cmProtocol').value,channelStrategy:_cmEl('cmChannelStrategy')&&_cmEl('cmChannelStrategy').value==='random'?'random':'priority',reasoningLevel:primary.reasoningLevel||_cmEl('cmReasoning').value,contextTokens:Number(_cmEl('cmContext').value)||131072,maxOutputTokens:Number(_cmEl('cmMaxTokens').value)||16384,supportsImages:_cmEl('cmImages').checked};
    if(!body.id||!body.channels.length){_cmSetStatus('UID 和至少一个渠道必填');return;}
    _cmSetStatus('保存并同步②③④⑥…'); fPost('/origin/ea/custom-model',body).then(function(result){if(!result.ok)throw new Error(result.error||'保存失败');return loadConfig();}).then(function(){_rpRefresh();_pbLoad();return _cmLoad(body.id);}).then(function(){_cmSetStatus('已保存 · 正在刷新 Devin 模型目录…');postMsg('refreshDevinModels');}).catch(function(error){_cmSetStatus('保存失败: '+error.message);});
  }
  function _cmDelete(id) {
    _daoConfirm('删除自定义模型 '+id+'？自动路由会一并清理；存在其他路由或中转引用时将拒绝删除。').then(function(yes){if(!yes)return;fDel('/origin/ea/custom-model/'+encodeURIComponent(id)).then(function(result){if(!result.ok)throw new Error((result.error||'删除失败')+(result.references&&result.references.length?' · 引用: '+result.references.join(', '):''));return loadConfig();}).then(function(){_rpRefresh();_pbLoad();_cmReset();return _cmLoad();}).catch(function(error){_cmSetStatus(error.message);});});
  }
  (function _cmWire(){
    var provider=_cmEl('cmProvider'); if(provider)provider.addEventListener('change',function(){_cmProviderChanged(true,'');});
    var upstream=_cmEl('cmUpstream'); if(upstream)upstream.addEventListener('change',function(){_cmModelMode(true);});
    var upstreamCustom=_cmEl('cmUpstreamCustom'); if(upstreamCustom)upstreamCustom.addEventListener('input',function(){_cmSuggestIdentity();clearTimeout(_cmDetectTimer);_cmDetectTimer=setTimeout(function(){_cmDetect();},450);});
    var reloadModels=_cmEl('cmReloadModels'); if(reloadModels)reloadModels.addEventListener('click',_cmReloadModels);
    var addChannel=_cmEl('cmAddChannel'); if(addChannel)addChannel.addEventListener('click',function(){if(_cmEditingChannelIndex>=0){_cmSave();}else{_cmAddChannel();}});
    var cancelChannelEdit=_cmEl('cmCancelChannelEdit'); if(cancelChannelEdit)cancelChannelEdit.addEventListener('click',_cmCancelChannelEdit);
    var detect=_cmEl('cmDetect'); if(detect)detect.addEventListener('click',function(){_cmDetect();});
    var save=_cmEl('cmSave'); if(save)save.addEventListener('click',_cmSave); var reset=_cmEl('cmReset'); if(reset)reset.addEventListener('click',_cmReset); var refresh=_cmEl('cmRefresh'); if(refresh)refresh.addEventListener('click',_cmLoad);
    var list=_cmEl('cmList'); if(list){list.addEventListener('click',function(event){var edit=event.target.closest&&event.target.closest('[data-cm-edit]');if(edit){_cmEdit(edit.getAttribute('data-cm-edit'));return;}var del=event.target.closest&&event.target.closest('[data-cm-del]');if(del)_cmDelete(del.getAttribute('data-cm-del'));});list.addEventListener('change',function(event){var sel=event.target.closest&&event.target.closest('[data-cm-reasoning]');if(sel){_eaQuickReasoning(sel.getAttribute('data-cm-reasoning'),sel.value,sel.getAttribute('data-cm-reasoning'));}});}
    var channelList=_cmEl('cmChannelList');if(channelList){channelList.addEventListener('click',function(event){var edit=event.target.closest&&event.target.closest('[data-cm-channel-edit]');if(edit){_cmEditChannel(Number(edit.getAttribute('data-cm-channel-edit')));return;}var primary=event.target.closest&&event.target.closest('[data-cm-primary]');if(primary){_cmMoveChannel(Number(primary.getAttribute('data-cm-primary')),0);return;}var remove=event.target.closest&&event.target.closest('[data-cm-channel-del]');if(remove){var index=Number(remove.getAttribute('data-cm-channel-del'));_cmChannels.splice(index,1);if(_cmEditingChannelIndex===index)_cmCancelChannelEdit();else if(_cmEditingChannelIndex>index)_cmEditingChannelIndex--;_cmRenderChannels();if(_cmChannels.length)_cmSelectPrimary(true);_cmSetStatus('渠道已移除 · 保存后生效');}});channelList.addEventListener('dragstart',function(event){var row=event.target.closest&&event.target.closest('[data-cm-channel-index]');if(!row)return;_cmChannelDrag=Number(row.getAttribute('data-cm-channel-index'));row.classList.add('dragging');if(event.dataTransfer)event.dataTransfer.effectAllowed='move';});channelList.addEventListener('dragend',function(){_cmChannelDrag=-1;Array.prototype.forEach.call(channelList.querySelectorAll('.cm-channel-row'),function(row){row.classList.remove('dragging','drag-over','drag-over-after');});});channelList.addEventListener('dragover',function(event){var row=event.target.closest&&event.target.closest('[data-cm-channel-index]');if(!row||_cmChannelDrag<0)return;event.preventDefault();var rect=row.getBoundingClientRect();var after=event.clientY-rect.top>rect.height/2;row.classList.toggle('drag-over',!after);row.classList.toggle('drag-over-after',after);});channelList.addEventListener('drop',function(event){var row=event.target.closest&&event.target.closest('[data-cm-channel-index]');if(!row||_cmChannelDrag<0)return;event.preventDefault();var target=Number(row.getAttribute('data-cm-channel-index'));var rect=row.getBoundingClientRect();if(event.clientY-rect.top>rect.height/2)target++;var from=_cmChannelDrag;if(target>from)target--;target=Math.max(0,Math.min(_cmChannels.length-1,target));_cmChannelDrag=-1;_cmMoveChannel(from,target);});}
    setInterval(function(){var pane=_cmEl('paneCustomModel');if(pane&&pane.classList.contains('active'))_cmRefreshRuntime();},2500);
  })();
  function _pbSetProtocolOptions(protocols, selected) {
    var select = _pbEl('pbSourceProtocol');
    if (!select) return;
    var values = _pbProtocols(protocols, selected ? [selected] : []);
    select.innerHTML = '';
    values.forEach(function(protocol) {
      var option = document.createElement('option');
      option.value = protocol; option.textContent = _PB_PROTOCOL_LABELS[protocol] || protocol;
      select.appendChild(option);
    });
    select.value = values.indexOf(selected) >= 0 ? selected : values[0];
  }
  function _pbSetModelOptions(models, selected, forceCustom) {
    var select = _pbEl('pbSourceModel');
    var custom = _pbEl('pbSourceModelCustom');
    if (!select || !custom) return;
    var values = [];
    (models || []).forEach(function(model) { model = String(model || '').trim(); if (model && values.indexOf(model) < 0) values.push(model); });
    select.innerHTML = '';
    if (!values.length) {
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = '未探测到模型'; select.appendChild(empty);
    } else {
      values.forEach(function(model) { var option=document.createElement('option'); option.value=model; option.textContent=model; select.appendChild(option); });
    }
    if (selected && values.indexOf(selected) < 0 && !forceCustom) {
      var current = document.createElement('option'); current.value=selected; current.textContent=selected + ' · 当前配置'; select.appendChild(current);
    }
    var manual = document.createElement('option'); manual.value='__custom__'; manual.textContent='手动输入其他模型…'; select.appendChild(manual);
    if (forceCustom || (selected && values.indexOf(selected) < 0)) {
      select.value = '__custom__'; custom.value = selected || ''; custom.style.display = 'block';
    } else {
      select.value = selected && values.indexOf(selected) >= 0 ? selected : (values[0] || '__custom__');
      custom.value = ''; custom.style.display = select.value === '__custom__' ? 'block' : 'none';
    }
  }
  function _pbModelMode() {
    var select = _pbEl('pbSourceModel'); var custom = _pbEl('pbSourceModelCustom');
    if (select && custom) custom.style.display = select.value === '__custom__' ? 'block' : 'none';
    _pbUpdateReasoning();
  }
  function _pbSourceModelValue() {
    var select = _pbEl('pbSourceModel'); var custom = _pbEl('pbSourceModelCustom');
    if (!select) return '';
    return select.value === '__custom__' ? (custom && custom.value || '').trim() : select.value;
  }
  function _pbProviderByName(name) { return _pbProviders.filter(function(provider){ return provider.name === name; })[0]; }
  function _pbCurrentCapability() {
    var provider = _pbProviderByName(_pbEl('pbProvider') && _pbEl('pbProvider').value);
    var model = _pbSourceModelValue();
    return provider && provider.modelCapabilities && provider.modelCapabilities[model] || null;
  }
  function _pbUpdateReasoning(selected) {
    var select = _pbEl('pbReasoning'); var status = _pbEl('pbCapability');
    if (!select) return Promise.resolve(null);
    var managed = _pbEl('pbProviderMode') && _pbEl('pbProviderMode').value === 'managed';
    var providerName = managed ? '' : (_pbEl('pbProvider') && _pbEl('pbProvider').value || '');
    var model = _pbSourceModelValue();
    var known = managed ? null : _pbCurrentCapability();
    if (known) { _fillReasoningOptions(select, known, selected); if(status)status.textContent=_capabilitySummary(known); return Promise.resolve(known); }
    if (!providerName || !model) { _fillReasoningOptions(select, null, selected || 'off'); if(status)status.textContent=managed?'保存渠道后自动探取':'请选择渠道与模型'; return Promise.resolve(null); }
    var seq=++_pbCapabilitySeq; if(status)status.textContent='正在探取模型能力…';
    return fJson('/origin/ea/model-capability?provider='+encodeURIComponent(providerName)+'&model='+encodeURIComponent(model)).then(function(result){
      if(seq!==_pbCapabilitySeq)return null; var capability=result.capability||null; var provider=_pbProviderByName(providerName); if(provider){provider.modelCapabilities=provider.modelCapabilities||{};provider.modelCapabilities[model]=capability;}
      _fillReasoningOptions(select,capability,selected);if(status)status.textContent=_capabilitySummary(capability);return capability;
    }).catch(function(error){if(seq===_pbCapabilitySeq){_fillReasoningOptions(select,null,selected||'off');if(status)status.textContent='探取失败: '+error.message;}return null;});
  }
  function _pbApplyProvider(provider, selectedModel, selectedProtocol, forceCustom) {
    if (!provider) { _pbSetProtocolOptions(_PB_PROTOCOLS, selectedProtocol); _pbSetModelOptions([], selectedModel, true); _pbUpdateReasoning(); return; }
    _pbSetProtocolOptions(provider.protocols || [], selectedProtocol || provider.protocol);
    _pbSetModelOptions(provider.models || [], selectedModel, !!forceCustom);
    _pbUpdateReasoning();
  }
  function _pbMode() {
    var managed = _pbEl('pbProviderMode') && _pbEl('pbProviderMode').value === 'managed';
    var custom = _pbEl('pbProviderMode') && _pbEl('pbProviderMode').value === 'custom';
    ['pbManagedNameWrap','pbBaseUrlWrap','pbApiKeyWrap'].forEach(function(id) { var el = _pbEl(id); if (el) el.style.display = managed ? 'block' : 'none'; });
    var existing = _pbEl('pbExistingWrap'); if (existing) existing.style.display = managed || custom ? 'none' : 'block';
    var customWrap = _pbEl('pbCustomWrap'); if (customWrap) customWrap.style.display = custom ? 'block' : 'none';
    if (managed) _pbApplyProvider(null, _pbSourceModelValue(), _pbEl('pbSourceProtocol') && _pbEl('pbSourceProtocol').value, true);
    else if (custom) _pbUseCustomModel();
    else _pbUseProvider(false);
  }
  function _pbFillCustomModels(selected) {
    var select=_pbEl('pbCustomModel');if(!select)return;var previous=selected||select.value;select.innerHTML='';
    _pbCustomModels.forEach(function(model){var option=document.createElement('option');option.value=model.id;option.textContent=(model.label||model.id)+' · '+((model.channels||[]).length||1)+' 渠道';select.appendChild(option);});
    if(previous)select.value=previous;
  }
  function _pbUseCustomModel(selectedReasoning) {
    var id=_pbEl('pbCustomModel')&&_pbEl('pbCustomModel').value;var model=_pbCustomModels.filter(function(item){return item.id===id;})[0];if(!model)return;
    _pbSetProtocolOptions(_PB_PROTOCOLS,model.protocol||'openai-responses');_pbSetModelOptions([id],id,false);_fillReasoningOptions(_pbEl('pbReasoning'),model.capabilities,selectedReasoning||model.reasoningLevel||'off');
    if(_pbEl('pbCapability'))_pbEl('pbCapability').textContent='引用⑦逻辑模型 · '+((model.channels||[]).length||1)+' 条渠道 · 修改后自动同步';
    _pbSetDetectStatus('⑦ '+(model.label||id)+' · 完整多渠道路由');
    if(_pbEl('pbOutputModel')&&!_pbEl('pbOutputModel').value)_pbEl('pbOutputModel').value=id+'-bridge';
  }
  function _pbFillProviders() {
    var sel = _pbEl('pbProvider');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    _pbProviders.filter(function(p){ return p.name !== 'builtin-stub'; }).forEach(function(p) {
      var option = document.createElement('option');
      option.value = p.name;
      option.textContent = p.name + (p.protocol ? ' · ' + p.protocol : '') + (p.managed ? ' · 中转托管' : '');
      sel.appendChild(option);
    });
    if (prev) sel.value = prev;
    _pbUseProvider(false);
  }
  function _pbUseProvider(refresh, selectedModel, selectedProtocol) {
    if (!_pbEl('pbProvider') || _pbEl('pbProviderMode').value !== 'existing') return;
    var name = _pbEl('pbProvider').value;
    var provider = _pbProviderByName(name);
    if (!provider) return;
    var wantedModel = selectedModel == null ? _pbSourceModelValue() : selectedModel;
    var wantedProtocol = selectedProtocol === '' ? provider.protocol : (selectedProtocol || (_pbEl('pbSourceProtocol') && _pbEl('pbSourceProtocol').value) || provider.protocol);
    _pbApplyProvider(provider, wantedModel, wantedProtocol, false);
    if (!refresh && provider.models && provider.models.length) {
      _pbSetDetectStatus((provider.models.length || 0) + ' 模型 · ' + _pbProtocols(provider.protocols, provider.protocol ? [provider.protocol] : []).map(function(protocol){ return _PB_PROTOCOL_LABELS[protocol]; }).join(' / '));
      return;
    }
    var seq = ++_pbDetectSeq;
    _pbSetDetectStatus('正在探测 ' + name + '…');
    fJson('/origin/ea/models/' + encodeURIComponent(name) + '?refresh=1').then(function(result) {
      if (seq !== _pbDetectSeq) return;
      if (!result || result.ok === false) throw new Error(result && result.error || '探测失败');
      provider.models = result.models || [];
      provider.modelCapabilities = result.capabilities || provider.modelCapabilities || {};
      provider.protocols = _pbProtocols(result.protocols, result.protocol ? [result.protocol] : (provider.protocol ? [provider.protocol] : []));
      if (result.protocol) provider.protocol = result.protocol;
      _pbApplyProvider(provider, wantedModel, wantedProtocol || provider.protocol, false);
      _pbSetDetectStatus(provider.models.length + ' 模型 · ' + provider.protocols.map(function(protocol){ return _PB_PROTOCOL_LABELS[protocol]; }).join(' / ') + (result.source ? ' · ' + result.source : ''));
    }).catch(function(error) {
      if (seq !== _pbDetectSeq) return;
      _pbApplyProvider(provider, wantedModel, wantedProtocol, !provider.models || !provider.models.length);
      _pbSetDetectStatus('自动探测失败，可手动输入: ' + error.message);
    });
  }
  function _pbAccessEndpoint(protocol) {
    var endpoints = (_pbAccess && _pbAccess.endpoints) || {};
    var model = (_pbEl('pbOutputModel') && _pbEl('pbOutputModel').value.trim()) || '{对外模型}';
    if (protocol === 'openai-chat') return endpoints.openaiChat || (_BASE + '/v1/chat/completions');
    if (protocol === 'openai-responses') return endpoints.openaiResponses || (_BASE + '/v1/responses');
    if (protocol === 'anthropic') return endpoints.anthropic || (_BASE + '/v1/messages');
    var gemini = endpoints.gemini || (_BASE + '/v1beta/models/{model}:generateContent');
    return gemini.replace('{model}', encodeURIComponent(model));
  }
  function _pbRenderAccess() {
    var status = _pbEl('pbAccessStatus');
    var base = _pbEl('pbAccessBase');
    var key = _pbEl('pbAccessKey');
    var keyButton = _pbEl('pbToggleKey');
    var endpoints = _pbEl('pbAccessEndpoints');
    if (!_pbAccess) { if (status) status.textContent='加载失败'; return; }
    if (status) status.textContent = (_pbAccess.enabled ? '● 已启用' : '○ 未启用') + ' · ' + (_pbAccess.model_count || 0) + ' 模型';
    if (base) base.textContent = _pbAccess.endpoint || (_BASE + '/v1');
    var rawKey = _pbAccess.apiKey || '';
    if (key) key.textContent = rawKey ? (_pbKeyVisible ? rawKey : '••••••••••••••••') : '(仅 localhost 无 Key 放行)';
    if (keyButton) keyButton.textContent = _pbKeyVisible ? '隐藏' : '显示';
    if (endpoints) endpoints.innerHTML = _PB_PROTOCOLS.map(function(protocol) {
      var value = _pbAccessEndpoint(protocol);
      return '<div style="display:flex;align-items:center;gap:5px;margin:3px 0;min-width:0"><span class="pb-badge" style="min-width:72px;text-align:center">' + _pbEsc(_PB_PROTOCOL_LABELS[protocol]) + '</span><code style="overflow-x:auto;white-space:nowrap;flex:1">' + _pbEsc(value) + '</code><button class="btn" data-pb-copy-endpoint="' + _pbEsc(protocol) + '">复制</button></div>';
    }).join('');
  }
  function _pbLoadAccess() {
    var status = _pbEl('pbAccessStatus'); if (status) status.textContent = '加载中…';
    return fJson('/origin/revproxy/status').then(function(data) { _pbAccess = data || {}; _pbRenderAccess(); _pbRenderClientConfig(); }).catch(function(error) { _pbAccess=null; _pbRenderClientConfig(); if(status) status.textContent='加载失败: '+error.message; });
  }
  function _pbProfileById(id) { return _pbProfiles.filter(function(profile){ return profile.id === id; })[0]; }
  function _pbFillProfileSelect(id) {
    var select = _pbEl(id); if (!select) return;
    var previous = select.value; select.innerHTML = '';
    _pbProfiles.forEach(function(profile) { var option=document.createElement('option'); option.value=profile.id; option.textContent=profile.name + ' · ' + profile.outputModel; select.appendChild(option); });
    if (previous && _pbProfileById(previous)) select.value = previous;
  }
  function _pbFillTestProfiles() {
    _pbFillProfileSelect('pbTestProfile');
    _pbFillProfileSelect('pbClientProfile');
    _pbFillTestProtocols();
    _pbRenderClientConfig();
  }
  function _pbFillTestProtocols() {
    var profileSelect=_pbEl('pbTestProfile'); var protocolSelect=_pbEl('pbTestProtocol');
    if (!profileSelect || !protocolSelect) return;
    var profile=_pbProfileById(profileSelect.value); var previous=protocolSelect.value; protocolSelect.innerHTML='';
    ((profile && profile.targetProtocols) || []).forEach(function(protocol){ var option=document.createElement('option'); option.value=protocol; option.textContent=_PB_PROTOCOL_LABELS[protocol] || protocol; protocolSelect.appendChild(option); });
    if (previous && profile && (profile.targetProtocols || []).indexOf(previous) >= 0) protocolSelect.value=previous;
  }
  function _pbProtocolRequest(profile, protocol, prompt) {
    var path='/v1/chat/completions';
    var body={model:profile.outputModel,messages:[{role:'user',content:prompt}],stream:false};
    if (protocol === 'openai-responses') { path='/v1/responses'; body={model:profile.outputModel,input:prompt,stream:false}; }
    else if (protocol === 'anthropic') { path='/v1/messages'; body={model:profile.outputModel,max_tokens:128,messages:[{role:'user',content:prompt}],stream:false}; }
    else if (protocol === 'gemini') { path='/v1beta/models/'+encodeURIComponent(profile.outputModel)+':generateContent'; body={contents:[{role:'user',parts:[{text:prompt}]}]}; }
    var key=(_pbAccess && _pbAccess.apiKey) || '';
    return fetch(_BASE+path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key,'x-api-key':key,'x-goog-api-key':key},body:JSON.stringify(body)}).then(function(response){
      return response.text().then(function(text){
        var data=null; try { data=JSON.parse(text); } catch (error) {}
        var content=''; var shape=false;
        if (protocol === 'openai-chat') { shape=!!(data && Array.isArray(data.choices)); content=shape && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : ''; }
        else if (protocol === 'openai-responses') { shape=!!(data && (data.object === 'response' || Array.isArray(data.output))); content=data && (data.output_text || (data.output && data.output[0] && data.output[0].content && data.output[0].content[0] && data.output[0].content[0].text)) || ''; }
        else if (protocol === 'anthropic') { shape=!!(data && Array.isArray(data.content)); content=shape && data.content[0] ? data.content[0].text || '' : ''; }
        else { shape=!!(data && Array.isArray(data.candidates)); content=shape && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] ? data.candidates[0].content.parts[0].text || '' : ''; }
        return {protocol:protocol,path:path,status:response.status,ok:response.status<400&&shape,shape:shape,content:content,text:text};
      });
    });
  }
  function _pbRunTests(all) {
    var profile=_pbProfileById(_pbEl('pbTestProfile') && _pbEl('pbTestProfile').value);
    var output=_pbEl('pbTestOutput'); var status=_pbEl('pbTestStatus');
    if (!profile) { if(status) status.textContent='请先保存一个中转档案'; return; }
    var protocols=all ? (profile.targetProtocols || []).slice() : [(_pbEl('pbTestProtocol') && _pbEl('pbTestProtocol').value)];
    protocols=protocols.filter(Boolean); if (!protocols.length) { if(status) status.textContent='档案未启用目标协议'; return; }
    var prompt=(_pbEl('pbTestPrompt') && _pbEl('pbTestPrompt').value.trim()) || '只回复 PROXY_OK';
    if (output) { output.style.display='block'; output.textContent=''; }
    if (status) status.textContent='正在真实测试 0/'+protocols.length+'…';
    var results=[]; var chain=Promise.resolve();
    protocols.forEach(function(protocol,index){ chain=chain.then(function(){ if(status) status.textContent='正在测试 '+(index+1)+'/'+protocols.length+' · '+(_PB_PROTOCOL_LABELS[protocol]||protocol); return _pbProtocolRequest(profile,protocol,prompt).then(function(result){ results.push(result); }).catch(function(error){ results.push({protocol:protocol,path:'',status:0,ok:false,shape:false,content:'',text:error.message}); }); }); });
    return chain.then(function(){
      var passed=results.filter(function(result){ return result.ok; }).length;
      if(status) status.textContent=(passed===results.length?'✔ 全部转换成功':'✖ 存在失败')+' · '+passed+'/'+results.length;
      if(output) output.textContent=results.map(function(result){ return (result.ok?'✔ ':'✖ ')+(_PB_PROTOCOL_LABELS[result.protocol]||result.protocol)+' · HTTP '+result.status+' · 响应结构 '+(result.shape?'正确':'异常')+_PB_NL+'接口: '+(result.path||'网络层失败')+_PB_NL+'回复: '+(result.content||'(无文本)')+_PB_NL+'原始: '+String(result.text||'').slice(0,1200); }).join(_PB_NL+_PB_NL);
      return results;
    });
  }
  function _pbClientRequiredProtocol(client) {
    return {'codex':'openai-responses','claude-code':'anthropic','opencode':'openai-chat','mimocode':'openai-chat','openclaw':'openai-responses','hermes':'openai-chat'}[client] || 'openai-chat';
  }
  function _pbBuildClientConfig(client, profile) {
    if (!profile || !_pbAccess) return '';
    var model=profile.outputModel; var key=_pbAccess.apiKey || ''; var baseV1=_pbAccess.endpoint || (_BASE+'/v1');
    var origin=baseV1.slice(-3)==='/v1' ? baseV1.slice(0,-3) : _BASE;
    if (client === 'codex') return ['# ~/.codex/config.toml','model = '+JSON.stringify(model),'model_provider = "dao_proxy"','disable_response_storage = true','','[model_providers.dao_proxy]','name = "FOMO FLOW"','base_url = '+JSON.stringify(baseV1),'wire_api = "responses"','supports_websockets = false','env_key = "DAO_PROXY_API_KEY"','requires_openai_auth = true','','# PowerShell 启动','$env:DAO_PROXY_API_KEY='+JSON.stringify(key),'codex'].join(_PB_NL);
    if (client === 'claude-code') return ['# PowerShell','$env:ANTHROPIC_API_KEY='+JSON.stringify(key),'$env:ANTHROPIC_AUTH_TOKEN='+JSON.stringify(key),'$env:ANTHROPIC_BASE_URL='+JSON.stringify(origin),'$env:ANTHROPIC_MODEL='+JSON.stringify(model),'$env:ANTHROPIC_CUSTOM_MODEL_OPTION='+JSON.stringify(model),'$env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='+JSON.stringify(model),'$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"','claude'].join(_PB_NL);
    if (client === 'opencode') { var ocModels={}; ocModels[model]={name:model}; return '# opencode.json'+_PB_NL+JSON.stringify({'$schema':'https://opencode.ai/config.json',model:'dao-proxy/'+model,provider:{'dao-proxy':{npm:'@ai-sdk/openai-compatible',name:'FOMO FLOW',options:{baseURL:baseV1,apiKey:key,setCacheKey:true},models:ocModels}}},null,2); }
    if (client === 'mimocode') { var mimoModels={}; mimoModels[model]={name:model}; return '# ~/.config/mimocode/mimocode.json'+_PB_NL+JSON.stringify({'$schema':'https://mimo.xiaomi.com/mimocode/config.json',model:'dao-proxy/'+model,provider:{'dao-proxy':{options:{baseURL:baseV1,apiKey:key},models:mimoModels}}},null,2); }
    if (client === 'openclaw') return '# ~/.openclaw/openclaw.json (JSON5)'+_PB_NL+JSON.stringify({agents:{defaults:{model:{primary:'dao-proxy/'+model}}},models:{mode:'merge',providers:{'dao-proxy':{baseUrl:baseV1,apiKey:key,api:'openai-responses',models:[{id:model,name:model,reasoning:true,input:['text'],contextWindow:131072,maxTokens:profile.maxOutputTokens||16384}]}}}},null,2)+_PB_NL+_PB_NL+'# 应用后执行: openclaw gateway restart';
    var envRef='$'+'{DAO_PROXY_API_KEY}';
    return ['# ~/.hermes/.env','DAO_PROXY_API_KEY='+key,'','# ~/.hermes/config.yaml','model:','  default: '+JSON.stringify(model),'  provider: custom','  base_url: '+JSON.stringify(baseV1),'  api_key: '+JSON.stringify(envRef),'custom_providers:','  - name: "FOMO FLOW"','    base_url: '+JSON.stringify(baseV1),'    api_key: '+JSON.stringify(envRef),'    model: '+JSON.stringify(model),'','# 启动: hermes'].join(_PB_NL);
  }
  function _pbRenderClientConfig() {
    var profile=_pbProfileById(_pbEl('pbClientProfile') && _pbEl('pbClientProfile').value); var client=_pbEl('pbClient') && _pbEl('pbClient').value;
    var required=_pbClientRequiredProtocol(client); var enabled=!!(profile && (profile.targetProtocols||[]).indexOf(required)>=0);
    var status=_pbEl('pbClientStatus'); if(status) status.textContent=profile ? ('需要 '+(_PB_PROTOCOL_LABELS[required]||required)+' · '+(enabled?'✔ 档案已启用':'✖ 请先在档案勾选该协议')) : '请先保存中转档案';
    _pbClientConfigText=_pbBuildClientConfig(client,profile); var pre=_pbEl('pbClientConfig'); if(pre) pre.textContent=_pbClientConfigText || '暂无可生成配置';
  }
  function _pbLoad(focusId) {
    _pbSetStatus('加载中…');
    _pbLoadAccess();
    return fJson('/origin/protocol-bridges').then(function(data) {
      _pbProfiles = data.profiles || [];
      _pbProviders = data.providers || [];
      _pbCustomModels = data.customModels || [];
      _pbFillProviders();
      _pbFillCustomModels();
      _pbFillTestProfiles();
      _pbRender();
      _pbSetStatus(_pbProfiles.length + ' 条中转档案');
      if (focusId) _pbEdit(focusId);
    }).catch(function(error) { _pbSetStatus('加载失败: ' + error.message); });
  }
  function _pbRender() {
    var box = _pbEl('pbList');
    if (!box) return;
    if (!_pbProfiles.length) {
      box.innerHTML = '<div style="padding:14px;text-align:center;opacity:0.5">暂无协议中转 · 可把 DeepSeek、MiMo 等 Chat-only 模型转换为 Responses / Anthropic / Gemini。</div>';
      return;
    }
    box.innerHTML = _pbProfiles.map(function(profile) {
      var sync = profile.sync || {};
      var ok = sync.provider && sync.route;
      var protocols = (profile.targetProtocols || []).map(function(p){ return '<span class="pb-badge">' + _pbEsc(p) + '</span>'; }).join('');
      var endpoints = Object.keys(profile.endpoints || {}).map(function(p){ return '<div style="font-size:9px;overflow-x:auto;white-space:nowrap"><b>' + _pbEsc(p) + '</b> · <code>' + _pbEsc(profile.endpoints[p]) + '</code></div>'; }).join('');
      var sourceText=profile.sourceRouteUid?('⑦ '+profile.sourceRouteUid+' · 动态多渠道'):(profile.providerName+'/'+profile.sourceModel);
      var sourceChannels=(profile.sourceChannels||[]).map(function(channel,index){var level=_REASONING_LABELS[channel.reasoningLevel]||channel.reasoningLevel||'关闭';return '<span class="pb-badge" title="'+_pbEsc((channel.protocol||'自动协议')+' · '+level)+'">'+(index===0?'首选 ':'备用 '+index+' ')+_pbEsc(channel.provider)+'/'+_pbEsc(channel.model)+'</span>';}).join(' ');
      var pbReasoningUid=profile.sourceRouteUid||profile.outputModel||'';
      var pbCurLvl=profile.reasoningLevel||'off';
      var pbLvlOpts=['off','low','medium','high','auto'].map(function(l){return '<option value="'+l+'"'+(l===pbCurLvl?' selected':'')+'>'+_pbEsc(_REASONING_LABELS[l]||l)+'</option>';}).join('');
      var pbReasoningSel=pbReasoningUid?'<select class="btn" data-pb-reasoning="'+_pbEsc(pbReasoningUid)+'" style="font-size:10px;padding:1px 4px" title="思考强度">'+pbLvlOpts+'</select>':'<span class="pb-badge">'+_pbEsc(_REASONING_LABELS[pbCurLvl]||pbCurLvl)+'</span>';
      return '<div class="pb-card" data-pb-id="' + _pbEsc(profile.id) + '">' +
        '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap"><b>' + _pbEsc(profile.name) + '</b>' +
        '<span style="font-size:10px;color:' + (ok ? '#3fb950' : '#f85149') + '">' + (ok ? (profile.sourceRouteUid?'● 已引用③④⑦':'● 已同步②③④') : '● 同步缺失') + '</span>' +
        '<span style="margin-left:auto">思考 '+pbReasoningSel+'</span><button class="btn" data-pb-test="' + _pbEsc(profile.id) + '">▶ 测试</button><button class="btn" data-pb-edit="' + _pbEsc(profile.id) + '">编辑</button><button class="btn del" data-pb-del="' + _pbEsc(profile.id) + '">删除</button></div>' +
        '<div style="font-size:10px;margin-top:4px"><code>' + _pbEsc(sourceText) + '</code> (' + _pbEsc(profile.sourceProtocol) + ') → 对外模型 <code>' + _pbEsc(profile.outputModel) + '</code></div>' +
        (sourceChannels?'<div style="font-size:9px;margin-top:4px"><b>同步渠道</b> · '+_pbEsc(profile.channelStrategy==='random'?'随机首选':'优先级切换')+' '+sourceChannels+'</div>':'')+
        '<div style="margin-top:4px">' + protocols + '</div><details style="margin-top:4px"><summary style="font-size:9px;cursor:pointer;opacity:0.65">端点</summary>' + endpoints + '</details>' +
        '<pre class="pb-test-out" style="display:none;max-height:150px;overflow:auto;margin:6px 0 0;padding:6px;font-size:10px;white-space:pre-wrap;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre></div>';
    }).join('');
  }
  function _pbReset() {
    _pbEditing = '';
    ['pbName','pbManagedName','pbBaseUrl','pbApiKey','pbSourceModelCustom','pbOutputModel'].forEach(function(id){ var el=_pbEl(id); if(el) el.value=''; });
    _pbEl('pbProviderMode').value = 'existing';
    _pbEl('pbMaxTokens').value = '16384';
    _fillReasoningOptions(_pbEl('pbReasoning'), null, 'off');
    var targets = document.querySelectorAll('.pb-target');
    for (var i=0;i<targets.length;i++) targets[i].checked = targets[i].value === 'openai-responses';
    _pbMode(); _pbFillProviders(); _pbRenderAccess(); _pbSetStatus('新建档案');
  }
  function _pbEdit(id) {
    var profile = _pbProfiles.filter(function(item){ return item.id === id; })[0];
    if (!profile) return;
    _pbEditing = profile.id;
    _pbEl('pbName').value = profile.name || '';
    _pbEl('pbProviderMode').value = profile.providerMode === 'managed' ? 'managed' : (profile.sourceRouteUid ? 'custom' : 'existing');
    _pbEl('pbProvider').value = profile.providerName || '';
    _pbEl('pbManagedName').value = profile.providerName || '';
    _pbEl('pbBaseUrl').value = profile.sourceBaseUrl || '';
    _pbEl('pbApiKey').value = '';
    _pbEl('pbOutputModel').value = profile.outputModel || '';
    _pbEl('pbMaxTokens').value = profile.maxOutputTokens || 16384;
    var targets = document.querySelectorAll('.pb-target');
    for (var i=0;i<targets.length;i++) targets[i].checked = (profile.targetProtocols || []).indexOf(targets[i].value) >= 0;
    _pbMode();
    if (profile.providerMode === 'managed') { _pbApplyProvider(null, profile.sourceModel || '', profile.sourceProtocol || 'openai-chat', true); _fillReasoningOptions(_pbEl('pbReasoning'), profile.capabilities, profile.reasoningLevel); if(_pbEl('pbCapability'))_pbEl('pbCapability').textContent=_capabilitySummary(profile.capabilities); }
    else if(profile.sourceRouteUid){_pbFillCustomModels(profile.sourceRouteUid);_pbUseCustomModel(profile.reasoningLevel);}
    else { _pbUseProvider(false, profile.sourceModel || '', profile.sourceProtocol || 'openai-chat'); _pbUpdateReasoning(profile.reasoningLevel); }
    _pbRenderAccess(); _pbSetStatus('编辑: ' + profile.name);
  }
  function _pbSave() {
    var targets = Array.prototype.slice.call(document.querySelectorAll('.pb-target')).filter(function(el){ return el.checked; }).map(function(el){ return el.value; });
    var managed = _pbEl('pbProviderMode').value === 'managed';
    var custom = _pbEl('pbProviderMode').value === 'custom';
    var customId = custom && _pbEl('pbCustomModel') ? _pbEl('pbCustomModel').value : '';
    var body = {
      id: _pbEditing || undefined,
      name: _pbEl('pbName').value.trim(),
      providerMode: managed ? 'managed' : (custom ? 'custom' : 'existing'),
      providerName: managed ? _pbEl('pbManagedName').value.trim() : _pbEl('pbProvider').value,
      baseUrl: managed ? _pbEl('pbBaseUrl').value.trim() : '',
      apiKey: managed ? _pbEl('pbApiKey').value.trim() : '',
      sourceProtocol: _pbEl('pbSourceProtocol').value,
      sourceModel: custom ? customId : _pbSourceModelValue(),
      sourceRouteUid: customId || undefined,
      outputModel: _pbEl('pbOutputModel').value.trim(),
      targetProtocols: targets,
      maxOutputTokens: Number(_pbEl('pbMaxTokens').value) || 16384,
      reasoningLevel: _pbEl('pbReasoning').value || 'off'
    };
    _pbSetStatus('保存并同步②③…');
    fPost('/origin/protocol-bridges', body).then(function(result) {
      if (!result.ok) throw new Error(result.error || '保存失败');
      _pbEditing = result.profile && result.profile.id || _pbEditing;
      return loadConfig();
    }).then(function(){ _rpRefresh(); return _pbLoad(_pbEditing); }).catch(function(error){ _pbSetStatus('保存失败: ' + error.message); });
  }
  function _pbDelete(id) {
    _daoConfirm('删除此中转档案？托管渠道和同步路由会一并删除。').then(function(yes) {
      if (!yes) return;
      fDel('/origin/protocol-bridges/' + encodeURIComponent(id)).then(function(result) {
        if (!result.ok) throw new Error(result.error || '删除失败');
        _pbReset(); return loadConfig();
      }).then(function(){ _rpRefresh(); return _pbLoad(); }).catch(function(error){ _pbSetStatus('删除失败: ' + error.message); });
    });
  }
  function _pbTest(id) {
    var select = _pbEl('pbTestProfile');
    if (!select || !_pbProfileById(id)) return;
    select.value = id;
    _pbFillTestProtocols();
    var card = document.querySelector('[data-pb-id="' + id + '"]');
    var out = card && card.querySelector('.pb-test-out');
    if (out) { out.style.display='block'; out.textContent='测试结果已转到下方“协议转换全链路测试”'; }
    _pbRunTests(true);
  }
  (function _pbWire() {
    var mode = _pbEl('pbProviderMode'); if (mode) mode.addEventListener('change', function(){ _pbMode(); if (mode.value === 'existing') _pbUseProvider(true, '', ''); });
    var customModel = _pbEl('pbCustomModel'); if(customModel) customModel.addEventListener('change',function(){_pbUseCustomModel();});
    var provider = _pbEl('pbProvider'); if (provider) provider.addEventListener('change', function(){ _pbUseProvider(true, '', ''); });
    var sourceModel = _pbEl('pbSourceModel'); if (sourceModel) sourceModel.addEventListener('change', _pbModelMode);
    var sourceModelCustom = _pbEl('pbSourceModelCustom'); if (sourceModelCustom) sourceModelCustom.addEventListener('change', function(){ _pbUpdateReasoning(); });
    var detect = _pbEl('pbDetect'); if (detect) detect.addEventListener('click', function(){ if (_pbEl('pbProviderMode').value === 'existing') _pbUseProvider(true); else _pbSetDetectStatus('新建渠道请先保存到②，再切换为已有渠道自动探测'); });
    var save = _pbEl('pbSave'); if (save) save.addEventListener('click', _pbSave);
    var reset = _pbEl('pbReset'); if (reset) reset.addEventListener('click', _pbReset);
    var refresh = _pbEl('pbRefresh'); if (refresh) refresh.addEventListener('click', _pbLoad);
    var accessRefresh = _pbEl('pbAccessRefresh'); if (accessRefresh) accessRefresh.addEventListener('click', _pbLoadAccess);
    var copyBase = _pbEl('pbCopyBase'); if (copyBase) copyBase.addEventListener('click', function(){ _rpClip(_pbEl('pbAccessBase').textContent); });
    var copyKey = _pbEl('pbCopyKey'); if (copyKey) copyKey.addEventListener('click', function(){ _rpClip((_pbAccess && _pbAccess.apiKey) || ''); });
    var toggleKey = _pbEl('pbToggleKey'); if (toggleKey) toggleKey.addEventListener('click', function(){ _pbKeyVisible=!_pbKeyVisible; _pbRenderAccess(); });
    var outputModel = _pbEl('pbOutputModel'); if (outputModel) outputModel.addEventListener('input', _pbRenderAccess);
    var accessEndpoints = _pbEl('pbAccessEndpoints'); if (accessEndpoints) accessEndpoints.addEventListener('click', function(event) { var button=event.target.closest&&event.target.closest('[data-pb-copy-endpoint]'); if(button) _rpClip(_pbAccessEndpoint(button.getAttribute('data-pb-copy-endpoint'))); });
    var testProfile = _pbEl('pbTestProfile'); if (testProfile) testProfile.addEventListener('change', _pbFillTestProtocols);
    var testRun = _pbEl('pbTestRun'); if (testRun) testRun.addEventListener('click', function(){ _pbRunTests(false); });
    var testAll = _pbEl('pbTestAll'); if (testAll) testAll.addEventListener('click', function(){ _pbRunTests(true); });
    var clientProfile = _pbEl('pbClientProfile'); if (clientProfile) clientProfile.addEventListener('change', _pbRenderClientConfig);
    var client = _pbEl('pbClient'); if (client) client.addEventListener('change', _pbRenderClientConfig);
    var copyClient = _pbEl('pbCopyClient'); if (copyClient) copyClient.addEventListener('click', function(){ if (_pbClientConfigText) _rpClip(_pbClientConfigText); });
    var list = _pbEl('pbList'); if (list) {
      list.addEventListener('click', function(event) {
        var edit = event.target.closest && event.target.closest('[data-pb-edit]'); if (edit) { _pbEdit(edit.getAttribute('data-pb-edit')); return; }
        var del = event.target.closest && event.target.closest('[data-pb-del]'); if (del) { _pbDelete(del.getAttribute('data-pb-del')); return; }
        var test = event.target.closest && event.target.closest('[data-pb-test]'); if (test) _pbTest(test.getAttribute('data-pb-test'));
      });
      list.addEventListener('change', function(event) {
        var sel = event.target.closest && event.target.closest('[data-pb-reasoning]'); if (sel) _eaQuickReasoning(sel.getAttribute('data-pb-reasoning'), sel.value, sel.getAttribute('data-pb-reasoning'));
      });
    }
    _pbMode();
  })();

  // ═══ ④ 模型反代 (反者道之动 · 标准本地端点) ═══
